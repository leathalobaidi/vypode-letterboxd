// Deterministic mock Letterboxd history generator for Vypode tests.
// Produces registry-shaped data ({ slug -> entry }) plus storage / export payloads.
// No Math.random / Date.now in the core builders so generated fixtures are stable.

const DATA_VERSION = 2;
const GENRE_POOL = ['Drama', 'Comedy', 'Horror', 'Sci-Fi', 'Romance', 'Thriller', 'Documentary', 'Animation'];
const DIRECTORS = ['Agnès Varda', 'Bong Joon-ho', 'Céline Sciamma', 'Wong Kar-wai', 'Andrei Tarkovsky'];

function iso(daysAgoFromEpochBase) {
  // Stable timestamps derived from a fixed base — never uses the live clock.
  const base = Date.UTC(2024, 0, 1); // 2024-01-01
  return new Date(base - daysAgoFromEpochBase * 86400000).toISOString();
}

function baseEntry(i, overrides = {}) {
  const watchedAt = iso(i);
  return {
    title: `Film ${i}`,
    year: String(1960 + (i % 60)),
    director: DIRECTORS[i % DIRECTORS.length],
    genres: [GENRE_POOL[i % GENRE_POOL.length], GENRE_POOL[(i + 3) % GENRE_POOL.length]],
    poster: `https://image.test/posters/film-${i}.jpg`,
    url: `https://letterboxd.com/film/film-${i}/`,
    rating: '★★★★',
    ratingValue: 1 + (i % 5),
    reviewText: `Review body for film ${i}`,
    reviewUrl: `https://letterboxd.com/u/film-${i}/`,
    watched: true, watchedAt,
    liked: i % 3 === 0, likedAt: i % 3 === 0 ? watchedAt : null,
    watchlist: false, watchlistAt: null,
    skipped: false, skippedAt: null,
    lastAction: 'watched',
    source: 'collectionSync',
    lastSyncedAt: watchedAt,
    updatedAt: watchedAt,
    ...overrides
  };
}

// A small, well-formed history of `n` films.
export function smallHistory(n = 5) {
  const slugs = {};
  for (let i = 1; i <= n; i++) slugs[`film-${i}`] = baseEntry(i);
  return slugs;
}

// A large history — exercises scale / sort / search over many records.
export function hugeHistory(n = 10000) {
  const slugs = {};
  for (let i = 1; i <= n; i++) slugs[`film-${i}`] = baseEntry(i);
  return slugs;
}

// Empty history.
export function emptyHistory() {
  return {};
}

// History with films missing ratings and/or reviews.
export function missingFieldsHistory() {
  return {
    'no-rating': baseEntry(1, { rating: null, ratingValue: null }),
    'no-review': baseEntry(2, { reviewText: null, reviewUrl: null }),
    'bare-watch': baseEntry(3, { rating: null, ratingValue: null, reviewText: null, reviewUrl: null }),
    'no-watch-date': baseEntry(4, { watchedAt: null })
  };
}

// Unicode / diacritic / CJK / emoji titles and directors.
export function unicodeHistory() {
  return {
    amelie: baseEntry(1, { title: 'Amélie', director: 'Jean-Pierre Jeunet' }),
    parasite: baseEntry(2, { title: '기생충 (Parasite)', director: 'Bong Joon-ho' }),
    'la-haine': baseEntry(3, { title: 'La Haine — Société', director: 'Mathieu Kassovitz' }),
    emoji: baseEntry(4, { title: '🎬 The Movie', director: 'Tëst Diréctor' }),
    spaced: baseEntry(5, { title: 'Æon Flux', director: 'Karyn Kusama' })
  };
}

// Malformed entries that a corrupted / legacy storage blob might contain.
// normalizeEntry() must backfill these without throwing.
export function malformedHistory() {
  return {
    'partial-1': { title: 'Only A Title' },           // most fields absent
    'null-entry': null,                                // entry is null
    'wrong-genres': { title: 'Bad Genres', genres: 'Drama' }, // genres not an array
    'numeric-title': { title: 12345, watched: true },  // wrong types
    'extra-keys': { title: 'Extra', bogusKey: 'x', watched: true }
  };
}

// Broken / missing poster URLs.
export function brokenPosterHistory() {
  return {
    'no-poster': baseEntry(1, { poster: null }),
    'empty-poster': baseEntry(2, { poster: '' }),
    'bad-poster': baseEntry(3, { poster: 'not-a-url' }),
    'http-poster': baseEntry(4, { poster: 'http://broken.invalid/x.jpg' })
  };
}

// Wrap a slug map as a chrome.storage.local payload (for seeding load-from-storage).
export function asStoragePayload(slugs, version = DATA_VERSION) {
  return { vypode_state: { _meta: { version }, slugs } };
}

// Wrap a slug map as an export-file JSON string (for importData()).
export function asExportJson(slugs, prefs) {
  return JSON.stringify({
    _meta: { version: DATA_VERSION, exportedAt: iso(0) },
    slugs,
    ...(prefs ? { prefs } : {})
  });
}
