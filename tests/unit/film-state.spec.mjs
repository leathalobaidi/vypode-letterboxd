import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const filmStatePath = fileURLToPath(new URL('../../film-state.js', import.meta.url));
const filmStateSource = fs.readFileSync(filmStatePath, 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStorageArea(initial = {}) {
  const store = clone(initial) || {};
  return {
    store,
    get(keys, callback) {
      const result = {};
      if (Array.isArray(keys)) {
        for (const key of keys) result[key] = clone(store[key]);
      } else if (typeof keys === 'string') {
        result[keys] = clone(store[keys]);
      } else if (keys && typeof keys === 'object') {
        for (const [key, defaultValue] of Object.entries(keys)) {
          result[key] = key in store ? clone(store[key]) : clone(defaultValue);
        }
      } else {
        Object.assign(result, clone(store));
      }
      callback(result);
    },
    set(items, callback) {
      Object.assign(store, clone(items));
      callback?.();
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete store[key];
      callback?.();
    }
  };
}

function createFilmStateRuntime(localInitial = {}, syncInitial = {}, sharedAreas = null) {
  const sentMessages = [];
  const localArea = sharedAreas?.local || createStorageArea(localInitial);
  const syncArea = sharedAreas?.sync || createStorageArea(syncInitial);
  const context = {
    console,
    setTimeout,
    clearTimeout,
    window: {},
    chrome: {
      storage: {
        local: localArea,
        sync: syncArea
      },
      runtime: {
        sendMessage(message) {
          sentMessages.push(clone(message));
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(filmStateSource, context, { filename: filmStatePath });
  return {
    api: context.window.VypodeFilmState,
    localStore: localArea.store,
    syncStore: syncArea.store,
    sentMessages
  };
}

function waitForDebounce() {
  return new Promise(resolve => setTimeout(resolve, 350));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('tracks metadata, ratings, reviews, filters, and search', async () => {
  const { api } = createFilmStateRuntime();
  await api.init();

  api.updateFilm('amelie', {
    title: 'Amelie',
    year: '2001',
    director: 'Jean-Pierre Jeunet',
    genres: ['Romance', 'Comedy'],
    poster: 'https://example.test/amelie.jpg',
    ratingValue: 4.5,
    reviewText: 'warm city magic',
    watched: true,
    watchedAt: new Date().toISOString(),
    liked: true
  }, 'collectionSync');
  api.updateFilm('unrated-watch', {
    title: 'Unrated Watch',
    genres: ['Drama'],
    watched: true
  }, 'collectionSync');
  api.updateFilm('recent-drama', {
    title: 'Recent Drama',
    genres: ['Drama'],
    watched: true,
    watchedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  }, 'collectionSync');
  api.setFlag('skipped-film', 'skipped', true, 'userAction');

  const stats = api.getStats();
  assert.equal(stats.total, 4);
  assert.equal(stats.watched, 3);
  assert.equal(stats.liked, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.rated, 1);
  assert.equal(stats.reviewed, 1);

  assert.deepEqual(plain(api.query({ filter: 'rated' }).map(row => row.slug)), ['amelie']);
  assert.deepEqual(plain(api.query({ filter: 'reviewed' }).map(row => row.slug)), ['amelie']);
  assert.deepEqual(plain(api.query({ filter: 'missing-rating' }).map(row => row.slug)), ['recent-drama', 'unrated-watch']);
  assert.deepEqual(plain(api.query({ search: 'city magic' }).map(row => row.slug)), ['amelie']);
  assert.deepEqual(plain(api.query({ search: 'jeunet' }).map(row => row.slug)), ['amelie']);
  assert.deepEqual(plain(api.query({ genre: 'Drama' }).map(row => row.slug)), ['recent-drama', 'unrated-watch']);
  assert.deepEqual(plain(api.query({ dateFilter: 'watched-with-date' }).map(row => row.slug).sort()), ['amelie', 'recent-drama']);
  assert.deepEqual(plain(api.query({ dateFilter: 'watched-last-30' }).map(row => row.slug).sort()), ['amelie', 'recent-drama']);
  assert.deepEqual(plain(api.query({ dateFilter: 'missing-watched-date' }).map(row => row.slug)), ['unrated-watch']);
  assert.deepEqual(plain(api.getGenres()), ['Comedy', 'Drama', 'Romance']);
  assert.equal(api.shouldExclude('amelie'), true);
});

test('bulk sync merges rich Letterboxd records and reconciles stale collection flags', async () => {
  const { api } = createFilmStateRuntime();
  await api.init();

  api.bulkSetFromSync({
    parasite: {
      title: 'Parasite',
      year: '2019',
      ratingValue: 5,
      reviewText: 'perfect stairs',
      watched: true,
      liked: true
    },
    'old-watch': {
      title: 'Old Watch',
      watched: true
    }
  }, 'collectionSync');

  assert.equal(api.get('parasite').ratingValue, 5);
  assert.equal(api.get('parasite').reviewText, 'perfect stairs');
  assert.equal(api.get('old-watch').watched, true);

  const reconciled = api.reconcileFlags({
    watched: new Set(['parasite']),
    liked: new Set(['parasite']),
    watchlist: new Set()
  }, 'collectionSync');

  assert.equal(reconciled, 1);
  assert.equal(api.get('old-watch').watched, false);
});

test('separate content-script registries merge storage writes instead of clobbering', async () => {
  const sharedAreas = { local: createStorageArea(), sync: createStorageArea() };
  const tabA = createFilmStateRuntime({}, {}, sharedAreas);
  const tabB = createFilmStateRuntime({}, {}, sharedAreas);
  await Promise.all([tabA.api.init(), tabB.api.init()]);

  tabA.api.updateFilm('arrival', { title: 'Arrival', watched: true }, 'userAction');
  tabB.api.updateFilm('moonlight', { title: 'Moonlight', liked: true }, 'userAction');
  await waitForDebounce();

  assert.equal(sharedAreas.local.store.vypode_state.slugs.arrival.watched, true);
  assert.equal(sharedAreas.local.store.vypode_state.slugs.moonlight.liked, true);
});

test('imports exported data by timestamp without cloud dependencies', async () => {
  const { api } = createFilmStateRuntime();
  await api.init();

  api.updateFilm('moonlight', {
    title: 'Moonlight',
    watched: true,
    watchedAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  }, 'collectionSync');

  const result = api.importData(JSON.stringify({
    slugs: {
      moonlight: {
        title: 'Moonlight',
        watched: false,
        watchedAt: '2026-01-01T00:00:00.000Z',
        ratingValue: 4,
        reviewText: 'imported note',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    },
    prefs: { excludeLiked: false }
  }));

  assert.equal(result.success, true);
  assert.equal(api.get('moonlight').watched, false);
  assert.equal(api.get('moonlight').ratingValue, 4);
  assert.equal(api.get('moonlight').reviewText, 'imported note');
  assert.equal(api.get('moonlight').source, 'import');
  assert.equal(api.getPrefs().excludeLiked, false);
});

test('rejects unsafe import slugs and does not apply missing flag booleans', async () => {
  const { api } = createFilmStateRuntime();
  await api.init();

  api.updateFilm('moonlight', {
    title: 'Moonlight',
    watched: true,
    watchedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }, 'collectionSync');

  const result = api.importData(`{
    "slugs": {
      "__proto__": { "title": "Prototype", "watched": true },
      "constructor": { "title": "Constructor", "watched": true },
      "moonlight": {
        "title": "Moonlight",
        "watchedAt": "2027-01-01T00:00:00.000Z",
        "updatedAt": "2027-01-01T00:00:00.000Z"
      }
    }
  }`);

  assert.equal(result.success, true);
  assert.equal(api.get('__proto__'), null);
  assert.equal(api.get('constructor'), null);
  assert.equal({}.watched, undefined);
  assert.equal(api.get('moonlight').watched, true);
  assert.equal(api.get('moonlight').watchedAt, '2026-01-01T00:00:00.000Z');
});

test('clearAll removes local registry and synced preferences', async () => {
  const { api, localStore, syncStore } = createFilmStateRuntime();
  await api.init();

  api.updateFilm('arrival', { title: 'Arrival', watched: true }, 'userAction');
  api.setPref('excludeSkipped', false);
  await waitForDebounce();

  assert.ok(localStore.vypode_state);
  assert.ok(syncStore.vypode_prefs);

  await api.clearAll();
  await waitForDebounce();

  assert.equal(localStore.vypode_state, undefined);
  assert.equal(syncStore.vypode_prefs, undefined);
  assert.deepEqual(plain(api.getStats()), {
    total: 0,
    watched: 0,
    liked: 0,
    watchlist: 0,
    skipped: 0,
    rated: 0,
    reviewed: 0
  });
});
