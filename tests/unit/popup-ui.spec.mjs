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

test('account-changing actions require an active Letterboxd session', () => {
  assert.match(contentJs, /let isLetterboxdSessionActive = false/);
  assert.match(contentJs, /function requireActiveLetterboxdSession/);
  assert.match(contentJs, /Log in to Letterboxd to/);
  assert.match(contentJs, /if \(!requireActiveLetterboxdSession\('mark films as watched'\)\) return false/);
  assert.match(contentJs, /if \(!requireActiveLetterboxdSession\('like films'\)\) return false/);
  assert.match(contentJs, /if \(!requireActiveLetterboxdSession\('add films to your watchlist'\)\) return false/);
  assert.match(contentJs, /if \(!requireActiveLetterboxdSession\('submit reviews'\)\) return/);
  assert.match(contentJs, /Log in to submit/);
});

test('cached profile is not presented as an active login', () => {
  assert.match(contentJs, /active: false/);
  assert.match(contentJs, /Not logged in to Letterboxd/);
  assert.doesNotMatch(contentJs, /Last profile:/);
  assert.match(popupJs, /No active Letterboxd login/);
  assert.match(popupJs, /Log in to Letterboxd and refresh/);
});

test('account detection recognizes the current signed-in Letterboxd menu', () => {
  assert.match(contentJs, /function usernameFromProfileHref/);
  assert.match(contentJs, /hasSignOutLink/);
  assert.match(contentJs, /text === 'profile'/);
  assert.match(contentJs, /text === username\.toLowerCase\(\)/);
});

test('single film state detection handles current Letterboxd action classes', () => {
  assert.match(contentJs, /watchedState: '.*\.action\.-watch\.-on/);
  assert.match(contentJs, /likedState: '.*\.action\.-like\.-on/);
  assert.match(contentJs, /watchlistState: '.*\.action\.-watchlist\.-on/);
  assert.match(contentJs, /watchlistState: '.*\.remove-from-watchlist/);
  assert.ok((contentJs.match(/\.action\.-watch\.-on/g) || []).length >= 3);
  assert.ok((contentJs.match(/\.action\.-like\.-on/g) || []).length >= 3);
  assert.ok((contentJs.match(/\.action\.-watchlist\.-on/g) || []).length >= 3);
  assert.doesNotMatch(contentJs, /action\.-watched\.-checked/);
});

test('review submission uses current Letterboxd production-log api', () => {
  assert.match(contentJs, /function readCsrfToken/);
  assert.match(contentJs, /value && value !== 'placeholder'/);
  assert.match(contentJs, /const csrf = readCsrfToken\(document\) \|\| filmData\.csrf/);
  assert.match(contentJs, /const productionId = filmData\.lid/);
  assert.match(contentJs, /api\/v0\/production-log-entries/);
  assert.match(contentJs, /'X-CSRF-TOKEN': csrf/);
  assert.doesNotMatch(contentJs, /querySelector\('input\\[name="__csrf"\\]'\)\\?\\.value/);
  assert.doesNotMatch(contentJs, /s\/save-diary-entry/);
});

test('collection sync requires the current browser session to be logged in', () => {
  assert.match(contentJs, /if \(!isLetterboxdSessionActive\) \{/);
  assert.match(contentJs, /Log in to Letterboxd to sync your profile/);
  assert.match(contentJs, /id="vypodeSyncBtn" \$\{!isLetterboxdSessionActive \? 'disabled' : ''\}/);
  assert.match(contentJs, /Log in to Letterboxd and refresh to sync your own profile database/);
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
