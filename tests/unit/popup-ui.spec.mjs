import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

test('popup uses an external script and exposes all registry stats', () => {
  assert.match(popupHtml, /<script src="popup\.js"><\/script>/);
  assert.doesNotMatch(popupHtml, /<script>(?!\s*<\/script>)/);

  for (const id of ['statWatched', 'statLiked', 'statWatchlist', 'statSkipped', 'statRated', 'statReviewed']) {
    assert.match(popupHtml, new RegExp(`id="${id}"`));
    assert.match(popupJs, new RegExp(`getElementById\\('${id}'\\)`));
  }
});

test('settings panel includes complete local database controls and no cloud backup UI', () => {
  for (const id of ['vypodeDbSearch', 'vypodeDbFilter', 'vypodeDbSort', 'vypodeDbSummary', 'vypodeDbList']) {
    assert.match(contentJs, new RegExp(id));
  }

  for (const label of ['watched', 'liked', 'watchlist', 'rated', 'reviewed', 'missing-rating', 'skipped']) {
    assert.match(contentJs, new RegExp(`value="${label}"`));
  }

  assert.doesNotMatch(contentJs, /Cloud Backup|Sign in with Google|Restore from cloud|Back up to cloud/);
});

test('review and local data copy sets the right user expectations', () => {
  assert.match(contentJs, /Submitting creates a Letterboxd diary entry for today/);
  assert.match(contentJs, /local-only database on this device/);
  assert.match(contentJs, /Clear all local data/);
});

test('collection sync preserves true flags when records appear in multiple collections', () => {
  assert.match(contentJs, /function mergeSyncedFilmRecord/);
  assert.match(contentJs, /merged\[flag\] = Boolean\(merged\[flag\] \|\| incoming\[flag\]\)/);
  assert.doesNotMatch(contentJs, /watched:\s*Boolean\(flags\?\.watched\)/);
  assert.doesNotMatch(contentJs, /liked:\s*Boolean\(flags\?\.liked\)/);
  assert.doesNotMatch(contentJs, /watchlist:\s*Boolean\(flags\?\.watchlist\)/);
});

test('passive DOM enrichment never writes false or null collection flags', () => {
  const persistBody = contentJs.match(/function persistFilmRecord\(film, source\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(persistBody, /if \(film\.isWatched \|\| film\.watched\) patch\.watched = true/);
  assert.match(persistBody, /if \(film\.isLiked \|\| film\.liked\) patch\.liked = true/);
  assert.match(persistBody, /if \(film\.inWatchlist \|\| film\.watchlist\) patch\.watchlist = true/);
  assert.doesNotMatch(persistBody, /watched:\s*.*false/);
  assert.doesNotMatch(persistBody, /liked:\s*.*false/);
  assert.doesNotMatch(persistBody, /watchlist:\s*.*false/);
  assert.doesNotMatch(persistBody, /reviewText:\s*.*null/);
});
