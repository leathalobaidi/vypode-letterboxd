// Robustness coverage for film-state.js — closes gaps found in the May-2026 audit:
// malformed-on-load, unicode, migration, reconcile source-gating, clearSkipped,
// clearAll prototype safety, combined filters, all sort orders, and scale (10k).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilmStateRuntime, plain } from '../helpers/film-state-runtime.mjs';
import {
  smallHistory, hugeHistory, emptyHistory, unicodeHistory,
  malformedHistory, missingFieldsHistory, asStoragePayload, asExportJson
} from '../helpers/mock-letterboxd.mjs';

// ── Malformed data on load ──────────────────────────────────────────────
test('loads malformed/partial stored entries without throwing and backfills shape', async () => {
  const { api } = createFilmStateRuntime(asStoragePayload(malformedHistory()));
  await api.init();

  const all = api.getAll();
  assert.equal(Object.keys(all).length, 5, 'all safe slugs retained');
  // null entry backfilled to a full default record
  assert.equal(api.get('null-entry').title, null);
  assert.equal(Array.isArray(api.get('null-entry').genres), true);
  // non-array genres are tolerated by getGenres() and query() (no throw)
  assert.doesNotThrow(() => api.getGenres());
  assert.doesNotThrow(() => api.query({ genre: 'drama', sort: 'title', search: 'x' }));
  // wrong-typed title still sorts/searches without crashing
  assert.doesNotThrow(() => api.query({ sort: 'title' }));
});

// ── Migration stamps version ────────────────────────────────────────────
test('migrates a legacy v0 blob up to the current data version on load', async () => {
  const { api } = createFilmStateRuntime(asStoragePayload(smallHistory(3), 0));
  await api.init();
  assert.equal(api.getMeta().version, 3);
  assert.equal(api.getStats().total, 3);
});

// ── Unicode search + sort ───────────────────────────────────────────────
test('searches and sorts unicode / CJK / emoji titles', async () => {
  const { api } = createFilmStateRuntime(asStoragePayload(unicodeHistory()));
  await api.init();

  assert.deepEqual(plain(api.query({ search: 'amélie' }).map(r => r.slug)), ['amelie']);
  assert.deepEqual(plain(api.query({ search: 'parasite' }).map(r => r.slug)), ['parasite']);
  assert.deepEqual(plain(api.query({ search: 'société' }).map(r => r.slug)), ['la-haine']);
  // sort must not throw on non-ASCII and must return every record
  const sorted = api.query({ sort: 'title' });
  assert.equal(sorted.length, 5);
});

// ── Missing fields ──────────────────────────────────────────────────────
test('handles films missing ratings, reviews, and watch dates', async () => {
  const { api } = createFilmStateRuntime(asStoragePayload(missingFieldsHistory()));
  await api.init();

  // 'missing-rating' = watched but unrated
  const missingRating = api.query({ filter: 'missing-rating' }).map(r => r.slug).sort();
  assert.deepEqual(plain(missingRating), ['bare-watch', 'no-rating']);
  // v3 only reports an actual diary date when watchedDate is explicitly known;
  // legacy watchedAt timestamps must not be treated as a fabricated date.
  assert.deepEqual(plain(api.query({ dateFilter: 'missing-watched-date' }).map(r => r.slug).sort()),
    ['bare-watch', 'no-rating', 'no-review', 'no-watch-date']);
  // reviewed filter excludes the no-review record
  assert.equal(api.query({ filter: 'reviewed' }).some(r => r.slug === 'no-review'), false);
});

// ── Combined filters + reset ────────────────────────────────────────────
test('combines status + genre + search filters and resets to the full list', async () => {
  const slugs = {
    alpha: { title: 'Alpha', genres: ['Drama'], watched: true, liked: true, ratingValue: 5, reviewText: 'great film' },
    beta:  { title: 'Beta',  genres: ['Drama'], watched: true, ratingValue: 3 },
    gamma: { title: 'Gamma', genres: ['Comedy'], watched: true, liked: true, reviewText: 'great laughs' }
  };
  const { api } = createFilmStateRuntime(asStoragePayload(slugs));
  await api.init();

  // liked AND Drama AND search "great" → alpha only
  assert.deepEqual(plain(api.query({ filter: 'liked', genre: 'Drama', search: 'great' }).map(r => r.slug)), ['alpha']);
  // genre Drama alone → alpha, beta (title-sorted)
  assert.deepEqual(plain(api.query({ genre: 'Drama' }).map(r => r.slug)), ['alpha', 'beta']);
  // zero-result combination
  assert.deepEqual(plain(api.query({ filter: 'watchlist' }).map(r => r.slug)), []);
  // reset (defaults) restores the full set
  assert.equal(api.query({}).length, 3);
});

// ── All sort orders ─────────────────────────────────────────────────────
test('produces correct ordering for every sort key', async () => {
  const { api } = createFilmStateRuntime(asStoragePayload(smallHistory(5)));
  await api.init();

  for (const sort of ['title', 'year', 'rating', 'watchedAt', 'updated']) {
    assert.equal(api.query({ sort }).length, 5, `${sort} returns all rows`);
  }
  // rating desc: ratingValue = 1+(i%5) → film-4(5) first, film-5(1) last
  const byRating = api.query({ sort: 'rating' }).map(r => r.slug);
  assert.equal(byRating[0], 'film-4');
  assert.equal(byRating[byRating.length - 1], 'film-5');
  // year desc (string compare): film-5 (1965) first
  assert.equal(api.query({ sort: 'year' })[0].slug, 'film-5');
  // title asc default
  assert.deepEqual(plain(api.query({ sort: 'title' }).map(r => r.slug)), ['film-1', 'film-2', 'film-3', 'film-4', 'film-5']);
});

// ── reconcileFlags source-gating (negative case) ────────────────────────
test('reconcileFlags does NOT clear flags owned by a different source', async () => {
  const { api } = createFilmStateRuntime();
  await api.init();
  // user-set watched flag — not owned by collectionSync
  api.setFlag('user-film', 'watched', true, 'userAction');

  const cleared = api.reconcileFlags({ watched: new Set() }, 'collectionSync');
  assert.equal(cleared, 0, 'nothing reconciled');
  assert.equal(api.get('user-film').watched, true, 'user flag preserved');
});

// ── clearSkipped ────────────────────────────────────────────────────────
test('clearSkipped clears only skipped flags and leaves the rest intact', async () => {
  const slugs = {
    s1: { title: 'S1', skipped: true, skippedAt: '2024-01-01T00:00:00Z' },
    w1: { title: 'W1', watched: true, watchedAt: '2024-01-01T00:00:00Z' }
  };
  const { api } = createFilmStateRuntime(asStoragePayload(slugs));
  await api.init();
  assert.equal(api.getStats().skipped, 1);

  await api.clearSkipped();
  assert.equal(api.getStats().skipped, 0);
  assert.equal(api.get('s1').skipped, false);
  assert.equal(api.get('w1').watched, true, 'non-skipped record untouched');
});

// ── clearAll keeps the registry prototype-safe (regression for the {} bug) ─
test('clearAll restores a null-prototype registry (no inherited keys leak through get)', async () => {
  const { api } = createFilmStateRuntime(asStoragePayload(smallHistory(3)));
  await api.init();
  assert.equal(api.getStats().total, 3);

  await api.clearAll();
  assert.equal(api.getStats().total, 0);
  // With a plain {} registry these would resolve to inherited Object.prototype members.
  assert.equal(api.get('toString'), null);
  assert.equal(api.get('hasOwnProperty'), null);
  // registry still usable after clear
  api.setFlag('fresh', 'watched', true, 'userAction');
  assert.equal(api.getStats().total, 1);
  assert.equal(api.get('fresh').watched, true);
});

// ── Import: empty and bulk ──────────────────────────────────────────────
test('imports an empty history and a bulk history without cloud dependencies', async () => {
  const { api } = createFilmStateRuntime();
  await api.init();

  const emptyResult = await api.importData(asExportJson(emptyHistory()));
  assert.equal(emptyResult.success, true);
  assert.equal(api.getStats().total, 0);

  const bulkResult = await api.importData(asExportJson(smallHistory(50)));
  assert.equal(bulkResult.success, true);
  assert.equal(api.getStats().total, 50);
});

test('a 5,000-film first-party export round-trips through the supported import path', async () => {
  const history = hugeHistory(5000);
  for (let index = 1; index <= 5000; index += 1) {
    history[`film-${index}`].poster = `https://a.ltrbxd.com/resized/film-poster/${index}.jpg`;
  }
  history['film-2500'].reviewText = null;
  history['film-2500'].reviewUrl = null;
  history['film-2500'].rating = null;
  history['film-2500'].ratingValue = null;

  const source = createFilmStateRuntime(asStoragePayload(history));
  await source.api.init();
  const backup = source.api.exportData();
  assert.ok(Buffer.byteLength(backup, 'utf8') > 1_000_000, 'fixture should exercise a genuinely large backup');

  const restored = createFilmStateRuntime();
  await restored.api.init();
  const result = await restored.api.importData(backup);

  assert.equal(result.success, true);
  assert.equal(result.merged > 0, true);
  assert.equal(restored.api.getStats().total, 5000);
  assert.equal(restored.api.get('film-1').title, 'Film 1');
  assert.equal(restored.api.get('film-5000').title, 'Film 5000');
  assert.equal(restored.api.get('film-1').poster, 'https://a.ltrbxd.com/resized/film-poster/1.jpg');
  assert.equal(restored.api.get('film-2500').reviewText, null);
  assert.equal(restored.api.get('film-2500').ratingValue, null);
});

// ── Scale: a 10,000-film history ────────────────────────────────────────
test('handles a 10,000-film history: stats, search, genres, and sort stay correct', async () => {
  const { api } = createFilmStateRuntime(asStoragePayload(hugeHistory(10000)));
  await api.init();

  assert.equal(api.getStats().total, 10000);
  // unique-slug search resolves to exactly one row
  assert.deepEqual(plain(api.query({ search: 'film-9999' }).map(r => r.slug)), ['film-9999']);
  // genres aggregate from the fixed pool, sorted
  const genres = api.getGenres();
  assert.equal(genres.length > 0, true);
  assert.deepEqual(plain(genres), [...genres].sort((a, b) => a.localeCompare(b)));
  // a full sort over 10k rows completes and returns everything
  assert.equal(api.query({ sort: 'rating' }).length, 10000);
});
