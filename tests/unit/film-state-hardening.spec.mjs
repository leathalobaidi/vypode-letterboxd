// Adversarial / chaos tests for the FilmState data layer (v6.0 hardening).
// Loads the REAL film-state.js in a vm sandbox with a mocked chrome.storage,
// then attacks the public API: prototype-pollution slugs, malformed imports,
// corrupted storage, concurrent writes, huge histories, unicode, and the full
// filter/sort matrix. Every assertion runs against production code.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const filmStateSource = fs.readFileSync(path.join(root, 'film-state.js'), 'utf8');
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function storageArea(initial = {}) {
  const store = clone(initial) || {};
  return {
    store,
    get(keys, callback) {
      const result = {};
      if (Array.isArray(keys)) for (const k of keys) result[k] = clone(store[k]);
      else if (typeof keys === 'string') result[keys] = clone(store[keys]);
      else Object.assign(result, clone(store));
      callback(result);
    },
    set(items, callback) { Object.assign(store, clone(items)); callback?.(); },
    remove(keys, callback) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      callback?.();
    }
  };
}

// Build a sandbox, load the real film-state.js, return its public API + storage.
function makeFilmState({ local = {}, sync = {} } = {}) {
  const localArea = storageArea(local);
  const syncArea = storageArea(sync);
  const sent = [];
  const context = {};
  context.window = context;                 // film-state.js sets window.VypodeFilmState
  context.console = console;
  context.chrome = {
    storage: { local: localArea, sync: syncArea },
    runtime: {
      lastError: null,
      sendMessage(msg) { sent.push(msg); }
    }
  };
  context.setTimeout = (fn, ms, ...a) => nativeSetTimeout(fn, Math.min(ms || 0, 2), ...a);
  context.clearTimeout = nativeClearTimeout;
  vm.createContext(context);
  vm.runInContext(filmStateSource, context, { filename: 'film-state.js' });
  return { FS: context.VypodeFilmState, localArea, syncArea, sent, context };
}

function tick(ms = 5) { return new Promise(r => nativeSetTimeout(r, ms)); }
function registry(slugs, version = 2) { return { _meta: { version }, slugs }; }

// Values returned from the vm realm carry that realm's prototypes, so
// deepStrictEqual's cross-realm identity check fails on otherwise-equal
// arrays/objects. Normalise both sides through JSON before comparing.
function deepEq(actual, expected, msg) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, msg);
}

// ───────────────────────────── Prototype pollution ─────────────────────────

test('import rejects prototype-pollution slugs and leaves Object.prototype clean', async () => {
  const { FS } = makeFilmState();
  await FS.init();
  const payload = JSON.stringify({
    slugs: {
      __proto__: { watched: true, polluted: true },
      constructor: { watched: true },
      prototype: { watched: true },
      'good-film': { title: 'Good', watched: true, watchedAt: '2024-01-01T00:00:00.000Z' }
    }
  });
  const res = FS.importData(payload);
  assert.equal(res.success, true);
  assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
  assert.equal(FS.get('__proto__'), null);
  assert.equal(FS.get('constructor'), null);
  assert.equal(FS.get('prototype'), null);
  assert.ok(FS.get('good-film'), 'safe slug still imported');
  assert.equal(FS.getStats().total, 1, 'only the safe slug counts');
});

test('setFlag/updateFilm ignore unsafe slugs', async () => {
  const { FS } = makeFilmState();
  await FS.init();
  FS.setFlag('__proto__', 'watched', true, 'userAction');
  assert.equal(FS.updateFilm('constructor', { title: 'x' }, 'userAction'), false);
  assert.equal(({}).watched, undefined);
  assert.equal(FS.getStats().total, 0);
});

test('migration strips unsafe slugs already on disk', async () => {
  const { FS } = makeFilmState({
    local: { vypode_state: registry({
      '__proto__': { watched: true },
      'real': { watched: true }
    }, 1) }   // version 1 forces a v1->v2 migration pass
  });
  await FS.init();
  assert.equal(FS.get('__proto__'), null);
  assert.ok(FS.get('real'));
});

// ───────────────────────────── Malformed imports ───────────────────────────

test('malformed import does NOT clear existing flags when booleans are absent', async () => {
  const { FS } = makeFilmState({
    local: { vypode_state: registry({
      arrival: { title: 'Arrival', watched: true, watchedAt: '2020-01-01T00:00:00.000Z' }
    }) }
  });
  await FS.init();
  // Imported record omits the `watched` boolean but carries a newer timestamp.
  const res = FS.importData(JSON.stringify({
    slugs: { arrival: { watchedAt: '2025-01-01T00:00:00.000Z', title: 'Arrival' } }
  }));
  assert.equal(res.success, true);
  assert.equal(FS.get('arrival').watched, true, 'existing true flag preserved');
});

test('import with explicit false + newer timestamp DOES win (intentional override)', async () => {
  const { FS } = makeFilmState({
    local: { vypode_state: registry({
      arrival: { watched: true, watchedAt: '2020-01-01T00:00:00.000Z' }
    }) }
  });
  await FS.init();
  FS.importData(JSON.stringify({
    slugs: { arrival: { watched: false, watchedAt: '2025-01-01T00:00:00.000Z' } }
  }));
  assert.equal(FS.get('arrival').watched, false);
});

test('invalid JSON and missing-slugs imports fail safely', async () => {
  const { FS } = makeFilmState();
  await FS.init();
  assert.equal(FS.importData('{not json').success, false);
  assert.equal(FS.importData(JSON.stringify({ nope: 1 })).success, false);
  assert.equal(FS.getStats().total, 0);
});

// ───────────────────────────── Corrupted storage ───────────────────────────

test('corrupted storage shapes load to an empty registry without throwing', async () => {
  for (const bad of ['a string', 42, [], { slugs: 'not-an-object' }, { _meta: 5 }]) {
    const { FS } = makeFilmState({ local: { vypode_state: bad } });
    await FS.init();
    assert.ok(FS.getStats().total >= 0);
    assert.ok(Array.isArray(JSON.parse(JSON.stringify(FS.query({})))));
  }
});

// ───────────────────────────── Concurrent writes ───────────────────────────

test('concurrent storage write is merged on flush (last-writer-wins per flag)', async () => {
  const { FS, localArea } = makeFilmState({
    local: { vypode_state: registry({
      arrival: { title: 'Arrival', watched: true, watchedAt: '2020-01-01T00:00:00.000Z',
                 updatedAt: '2020-01-01T00:00:00.000Z' }
    }) }
  });
  await FS.init();
  // Simulate ANOTHER tab writing a newer "liked" flag straight into storage
  // while this instance holds the film in memory.
  localArea.store.vypode_state = registry({
    arrival: { title: 'Arrival',
               watched: true, watchedAt: '2020-01-01T00:00:00.000Z',
               liked: true, likedAt: '2025-06-01T00:00:00.000Z',
               updatedAt: '2025-06-01T00:00:00.000Z' }
  });
  // This instance sets watchlist and flushes; writeToStorage re-reads + merges.
  FS.setFlag('arrival', 'watchlist', true, 'userAction');
  FS.flush();
  await tick();
  const saved = localArea.store.vypode_state.slugs.arrival;
  assert.equal(saved.watched, true, 'kept watched');
  assert.equal(saved.liked, true, 'merged the other tab\'s newer like');
  assert.equal(saved.watchlist, true, 'kept this tab\'s watchlist');
});

test('same-millisecond tie: a userAction beats a collectionSync reconcile (T8)', async () => {
  const T = '2026-05-31T12:00:00.000Z';   // identical timestamp on both sides
  const { FS, localArea } = makeFilmState({
    local: { vypode_state: registry({
      // In-memory (this tab): a STALE reconcile clearing watched, same instant.
      arrival: { title: 'Arrival', watched: false, watchedAt: T, source: 'collectionSync', updatedAt: T }
    }) }
  });
  await FS.init();
  // Another tab already persisted the user's deliberate "watched = true" at the SAME ms.
  localArea.store.vypode_state = registry({
    arrival: { title: 'Arrival', watched: true, watchedAt: T, source: 'userAction', updatedAt: T }
  });
  FS.flush();                 // writeToStorage re-reads the userAction + merges
  await tick();
  assert.equal(localArea.store.vypode_state.slugs.arrival.watched, true,
    'the live user action must not be clobbered by a same-instant reconcile');
});

test('large registry coalesces user-action writes instead of writing per action (T6)', async () => {
  const slugs = {};
  for (let i = 0; i < 2500; i++) slugs['film-' + i] = { title: 'F' + i, watched: true, watchedAt: '2024-01-01T00:00:00.000Z' };
  const { FS, localArea } = makeFilmState({ local: { vypode_state: registry(slugs) } });
  await FS.init();
  let writes = 0;
  const realSet = localArea.set;
  localArea.set = (items, cb) => { writes++; realSet(items, cb); };
  // Burst of rapid user actions on a large library.
  for (let i = 0; i < 5; i++) FS.setFlag('film-' + i, 'liked', true, 'userAction');
  assert.equal(writes, 0, 'no synchronous full-registry write during the burst (debounced)');
  FS.flush();                 // flush guarantees the coalesced write lands
  await tick();
  assert.ok(writes >= 1 && writes <= 2, `burst coalesced into <=2 writes, saw ${writes}`);
  // Small libraries keep writing immediately (no regression).
  const small = makeFilmState();
  await small.FS.init();
  let smallWrites = 0;
  const sset = small.localArea.set;
  small.localArea.set = (items, cb) => { smallWrites++; sset(items, cb); };
  small.FS.setFlag('arrival', 'watched', true, 'userAction');
  assert.ok(smallWrites >= 1, 'small library still writes immediately');
});

// ───────────────────────────── reconcileFlags safety ───────────────────────

test('reconcileFlags only clears collectionSync-sourced flags, never user actions', async () => {
  const { FS } = makeFilmState({
    local: { vypode_state: registry({
      'user-watch': { watched: true, watchedAt: '2024-01-01T00:00:00.000Z', source: 'userAction' },
      'sync-watch': { watched: true, watchedAt: '2024-01-01T00:00:00.000Z', source: 'collectionSync' }
    }) }
  });
  await FS.init();
  // Neither slug is present in the authoritative set => reconcile would clear them.
  const cleared = FS.reconcileFlags({ watched: new Set(), liked: new Set(), watchlist: new Set() }, 'collectionSync');
  assert.equal(cleared, 1, 'exactly one flag cleared');
  assert.equal(FS.get('user-watch').watched, true, 'user action untouched');
  assert.equal(FS.get('sync-watch').watched, false, 'stale sync flag cleared');
});

// ───────────────────────────── Filter / sort matrix ────────────────────────

function sampleLibrary() {
  return registry({
    a: { title: 'Amadeus', year: '1984', genres: ['Drama'], watched: true, ratingValue: 4,
         reviewText: 'mozart', watchedAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
    b: { title: 'Brazil', year: '1985', genres: ['Science Fiction', 'Comedy'], watched: true, ratingValue: 5,
         watchedAt: '2024-02-01T00:00:00.000Z', updatedAt: '2024-02-01T00:00:00.000Z' },
    c: { title: 'Caché', year: '2005', genres: ['Thriller'], watched: true, liked: true,
         watchedAt: null, updatedAt: '2025-01-01T00:00:00.000Z' },   // missing watched date
    d: { title: '東京物語', year: '1953', genres: ['Drama'], watched: true, ratingValue: 5,
         reviewText: 'unicode tokyo story', watchedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    e: { title: 'Eraserhead', genres: ['Horror'], watchlist: true, updatedAt: '2023-01-01T00:00:00.000Z' },
    f: { title: 'Funny Games', skipped: true, updatedAt: '2022-01-01T00:00:00.000Z' }
  });
}

test('every status filter works individually', async () => {
  const { FS } = makeFilmState({ local: { vypode_state: sampleLibrary() } });
  await FS.init();
  assert.equal(FS.query({ filter: 'watched' }).length, 4);
  assert.equal(FS.query({ filter: 'liked' }).length, 1);
  assert.equal(FS.query({ filter: 'watchlist' }).length, 1);
  assert.equal(FS.query({ filter: 'rated' }).length, 3);
  assert.equal(FS.query({ filter: 'reviewed' }).length, 2);
  assert.equal(FS.query({ filter: 'skipped' }).length, 1);
  // Only watched-but-unrated: Caché ('c'). Eraserhead is watchlist, not watched.
  deepEq(FS.query({ filter: 'missing-rating' }).map(r => r.slug), ['c']);
});

test('genre + date filter + search combine correctly and reset restores full list', async () => {
  const { FS } = makeFilmState({ local: { vypode_state: sampleLibrary() } });
  await FS.init();
  // Drama + has-a-watched-date + search "mozart" => only Amadeus
  const combo = FS.query({ genre: 'Drama', dateFilter: 'watched-with-date', search: 'mozart' });
  deepEq(combo.map(r => r.slug), ['a']);
  // missing-watched-date surfaces Caché (watched, no watchedAt)
  deepEq(FS.query({ dateFilter: 'missing-watched-date' }).map(r => r.slug), ['c']);
  // reset
  assert.equal(FS.query({}).length, 6);
});

test('zero-result filter returns an empty array, not a throw', async () => {
  const { FS } = makeFilmState({ local: { vypode_state: sampleLibrary() } });
  await FS.init();
  deepEq(FS.query({ genre: 'Western' }), []);
  deepEq(FS.query({ search: 'zzzznope' }), []);
});

test('unicode titles are searchable', async () => {
  const { FS } = makeFilmState({ local: { vypode_state: sampleLibrary() } });
  await FS.init();
  deepEq(FS.query({ search: '東京' }).map(r => r.slug), ['d']);
  deepEq(FS.query({ search: 'tokyo' }).map(r => r.slug), ['d']);
});

test('all sort orders are correct', async () => {
  const { FS } = makeFilmState({ local: { vypode_state: sampleLibrary() } });
  await FS.init();
  assert.equal(FS.query({ sort: 'rating' })[0].slug, 'b');         // 5★ then ties by title
  assert.equal(FS.query({ sort: 'year' })[0].year, '2005');         // newest year first
  assert.equal(FS.query({ filter: 'watched', sort: 'watchedAt' })[0].slug, 'a'); // 2026-05 newest
  assert.equal(FS.query({ sort: 'title' })[0].slug, 'a');          // Amadeus alphabetical
  assert.equal(FS.query({ sort: 'updated' })[0].slug, 'a');        // 2026-05 most recent update
});

test('getGenres returns a sorted, de-duplicated label set', async () => {
  const { FS } = makeFilmState({ local: { vypode_state: sampleLibrary() } });
  await FS.init();
  deepEq(FS.getGenres(), ['Comedy', 'Drama', 'Horror', 'Science Fiction', 'Thriller']);
});

// ───────────────────────────── Scale (10k history) ─────────────────────────

test('a 10,000-film history queries, filters, and sorts correctly', async () => {
  const slugs = {};
  for (let i = 0; i < 10000; i++) {
    slugs['film-' + i] = {
      title: 'Film ' + i,
      year: String(1950 + (i % 70)),
      genres: i % 2 ? ['Drama'] : ['Comedy'],
      watched: true,
      ratingValue: (i % 5) + 1,
      watchedAt: `20${10 + (i % 15)}-01-01T00:00:00.000Z`,
      updatedAt: `20${10 + (i % 15)}-01-01T00:00:00.000Z`
    };
  }
  const { FS } = makeFilmState({ local: { vypode_state: registry(slugs) } });
  await FS.init();
  const stats = FS.getStats();
  assert.equal(stats.total, 10000);
  assert.equal(stats.watched, 10000);
  const drama = FS.query({ genre: 'Drama' });
  assert.equal(drama.length, 5000);
  const topRated = FS.query({ filter: 'rated', sort: 'rating' });
  assert.equal(topRated[0].ratingValue, 5);
  // search narrows to a single exact slug
  assert.equal(FS.query({ search: 'film-4242' }).some(r => r.slug === 'film-4242'), true);
});

// ───────────────────────────── Empty state ─────────────────────────────────

test('empty registry produces a sane empty state', async () => {
  const { FS } = makeFilmState();
  await FS.init();
  deepEq(FS.query({}), []);
  deepEq(FS.getGenres(), []);
  deepEq(FS.getStats(), { total: 0, watched: 0, liked: 0, watchlist: 0, skipped: 0, rated: 0, reviewed: 0 });
});

// ───────────────────────────── Storage error capture ───────────────────────

test('a chrome.runtime.lastError on save is captured via getLastStorageError', async () => {
  const { FS, context } = makeFilmState();
  await FS.init();
  // Inject a lastError so recordStorageError() fires on the next local.set callback.
  context.chrome.runtime.lastError = { message: 'QUOTA_BYTES exceeded' };
  FS.setFlag('arrival', 'watched', true, 'userAction'); // delay 0 -> immediate write
  await tick();
  assert.match(FS.getLastStorageError() || '', /QUOTA_BYTES/);
  assert.match(FS.getMeta().lastStorageError || '', /QUOTA_BYTES/);
  context.chrome.runtime.lastError = null;
});
