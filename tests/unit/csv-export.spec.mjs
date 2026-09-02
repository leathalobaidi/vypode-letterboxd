// v6.2.0: exportLetterboxdCsv — watched films in the official import format.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilmStateRuntime } from '../helpers/film-state-runtime.mjs';

function runtimeWith(slugs) {
  return createFilmStateRuntime({
    vypode_state: { _meta: { version: 2 }, slugs }
  });
}

test('csv: header plus one row per watched film, watchlist-only films excluded', async () => {
  const rt = runtimeWith({
    'parasite-2019': {
      title: 'Parasite', year: '2019', director: 'Bong Joon-ho',
      ratingValue: 5, watched: true, watchedAt: '2026-01-15T20:00:00.000Z', watchedDate: '2026-01-15',
      reviewText: 'Masterful.'
    },
    'dune-part-two': { title: 'Dune: Part Two', watchlist: true, watched: false }
  });
  await rt.api.init();
  const csv = rt.api.exportLetterboxdCsv();
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Title,Year,Directors,Rating,WatchedDate,Review');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], 'Parasite,2019,Bong Joon-ho,5,2026-01-15,Masterful.');
});

test('csv: commas, quotes and newlines are escaped per RFC 4180', async () => {
  const rt = runtimeWith({
    'love-actually': {
      title: 'Love, Actually "Director\'s Cut"', year: '2003',
      director: 'Richard Curtis', ratingValue: 3.5,
      watched: true, watchedAt: '2025-12-25T10:00:00.000Z', watchedDate: '2025-12-25',
      reviewText: 'Line one\nLine "two", with comma'
    }
  });
  await rt.api.init();
  const csv = rt.api.exportLetterboxdCsv();
  const body = csv.slice(csv.indexOf('\r\n') + 2);
  assert.equal(
    body,
    '"Love, Actually ""Director\'s Cut""",2003,Richard Curtis,3.5,2025-12-25,' +
      '"Line one\nLine ""two"", with comma"'
  );
});

test('csv: missing fields are blank, title falls back to slug, no fabricated dates', async () => {
  const rt = runtimeWith({
    'mystery-film': { watched: true } // no metadata at all
  });
  await rt.api.init();
  const csv = rt.api.exportLetterboxdCsv();
  const lines = csv.split('\r\n');
  assert.equal(lines[1], 'mystery-film,,,,,');
});

test('csv: empty registry exports just the header', async () => {
  const rt = runtimeWith({});
  await rt.api.init();
  assert.equal(rt.api.exportLetterboxdCsv(), 'Title,Year,Directors,Rating,WatchedDate,Review');
});
