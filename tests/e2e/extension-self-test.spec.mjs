import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const filmStateSource = fs.readFileSync(path.join(root, 'film-state.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const popupSource = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const NativeURL = globalThis.URL;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function storageArea(initial = {}) {
  const store = clone(initial) || {};
  return {
    store,
    get(keys, callback) {
      const result = {};
      if (Array.isArray(keys)) {
        for (const key of keys) result[key] = clone(store[key]);
      } else if (typeof keys === 'string') {
        result[keys] = clone(store[keys]);
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
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      callback?.();
    }
  };
}

function signedInHeader(username = 'BusyBees1') {
  return `
    <header>
      <a href="/${username}/">Profile</a>
      <a href="/${username}/films/">Films</a>
      <a href="/${username}/films/diary/">Diary</a>
      <a href="/sign-out/">Sign Out</a>
    </header>
  `;
}

function signedOutHeader() {
  return '<header><a href="/sign-in/">Sign In</a></header>';
}

function singleFilmPage({ signedIn = true } = {}) {
  return `
    <html><body>
      ${signedIn ? signedInHeader() : signedOutHeader()}
      <h1 class="headline-1">Arrival</h1>
      <p class="releaseyear"><a>2016</a></p>
      <div class="film-poster"><img src="https://img.test/arrival.jpg"></div>
      <p class="contributor"><a>Denis Villeneuve</a></p>
      <p class="text-sluglist"><a href="/films/genre/science-fiction/">Science Fiction</a></p>
      <a class="action -watch" href="#">Watch</a>
      <a class="action -like" href="#">Like</a>
      <a class="action -watchlist" href="#">Watchlist</a>
    </body></html>
  `;
}

function listingPage() {
  return `
    <html><body>
      ${signedInHeader()}
      <ul class="poster-list">
        ${poster('watched-film', 'Watched Film (2001)', 'https://img.test/watched.jpg')}
        ${poster('fresh-film', 'Fresh Film (2020)', 'https://img.test/fresh.jpg')}
        ${poster('liked-film', 'Liked Film (1999)', 'https://img.test/liked.jpg')}
      </ul>
    </body></html>
  `;
}

function poster(slug, title, src) {
  return `
    <li class="poster-container">
      <div class="film-poster">
        <a href="/film/${slug}/"><img alt="Poster for ${title}" src="${src}"></a>
      </div>
    </li>
  `;
}

function registry(slugs) {
  return { _meta: { version: 2 }, slugs };
}

function createChrome(localInitial = {}, syncInitial = {}) {
  return {
    storage: {
      local: storageArea(localInitial),
      sync: storageArea(syncInitial)
    },
    runtime: {
      sendMessage() {}
    }
  };
}

function installBrowserGlobals(window, url, chrome) {
  Object.defineProperty(window, 'location', { value: new NativeURL(url), configurable: true });
  window.chrome = chrome;
  window.vypodeInjected = false;
  window.console = console;
  window.fetch = async requestUrl => ({
    ok: true,
    status: 200,
    text: async () => singleFilmPage(),
    json: async () => ({ csrf: 'csrf-token', lid: 'film-lid', url: requestUrl })
  });
  window.confirm = () => true;
  window.Image = class {
    set src(value) { this._src = value; }
    get src() { return this._src; }
  };
  window.Blob = globalThis.Blob;
  window.URL = NativeURL;
  window.URL.createObjectURL = () => 'blob:vypode-test';
  window.URL.revokeObjectURL = () => {};
  window.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, Math.min(ms || 0, 2), ...args);
  window.clearTimeout = nativeClearTimeout;
}

async function runContent(html, url, { local = {}, sync = {} } = {}) {
  const { window } = parseHTML(html);
  const chrome = createChrome(local, sync);
  installBrowserGlobals(window, url, chrome);
  vm.createContext(window);
  vm.runInContext(filmStateSource, window, { filename: 'film-state.js' });
  vm.runInContext(contentSource, window, { filename: 'content.js' });
  await tick(8);
  return { window, chrome };
}

async function runPopup(local = {}) {
  const { window } = parseHTML(popupHtml);
  const chrome = createChrome(local);
  installBrowserGlobals(window, 'chrome-extension://vypode/popup.html', chrome);
  vm.createContext(window);
  vm.runInContext(popupSource, window, { filename: 'popup.js' });
  await tick(2);
  return { window, chrome };
}

function tick(ms = 5) {
  return new Promise(resolve => nativeSetTimeout(resolve, ms));
}

function text(document, selector) {
  return document.querySelector(selector)?.textContent?.trim() || '';
}

function click(document, selector) {
  const el = document.querySelector(selector);
  assert.ok(el, `${selector} should exist`);
  el.click();
  return el;
}

function setSelectValue(window, selector, value) {
  const select = window.document.querySelector(selector);
  assert.ok(select, `${selector} should exist`);
  const options = Array.from(select.options);
  const index = options.findIndex(option => option.value === value);
  assert.notEqual(index, -1, `${selector} should have option ${value}`);
  select.selectedIndex = index;
  for (const [optionIndex, option] of options.entries()) {
    if (optionIndex === index) option.setAttribute('selected', '');
    else option.removeAttribute('selected');
  }
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function setInputValue(window, selector, value) {
  const input = window.document.querySelector(selector);
  assert.ok(input, `${selector} should exist`);
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('popup renders linked account, version, and registry stats from extension storage', async () => {
  const { window } = await runPopup({
    vypode_user: { username: 'BusyBees1', active: true },
    vypode_state: registry({
      arrival: { watched: true, liked: true, ratingValue: 5, reviewText: 'perfect shape' },
      stalker: { watched: true, watchlist: true },
      skipped: { skipped: true }
    })
  });

  assert.equal(text(window.document, '#accountName'), 'BusyBees1');
  assert.equal(text(window.document, '#accountStatus'), 'Linked');
  assert.equal(text(window.document, '.version'), 'v6.3.0-beta.2');
  assert.equal(text(window.document, '#statWatched'), '2');
  assert.equal(text(window.document, '#statLiked'), '1');
  assert.equal(text(window.document, '#statWatchlist'), '1');
  assert.equal(text(window.document, '#statSkipped'), '1');
  assert.equal(text(window.document, '#statRated'), '1');
  assert.equal(text(window.document, '#statReviewed'), '1');
});

test('settings database supports search, status filters, genre, watched-date filters, sorting, and detail view', async () => {
  const now = new Date().toISOString();
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: {
      vypode_state: registry({
        arrival: {
          title: 'Arrival',
          year: '2016',
          director: 'Denis Villeneuve',
          genres: ['Science Fiction', 'Drama'],
          poster: 'https://img.test/arrival.jpg',
          url: 'https://letterboxd.com/film/arrival/',
          watched: true,
          liked: true,
          ratingValue: 5,
          reviewText: 'language and time',
          watchedAt: now,
          updatedAt: now
        },
        'no-rating': {
          title: 'No Rating',
          genres: ['Drama'],
          watched: true,
          watchedAt: null,
          updatedAt: '2025-01-01T00:00:00.000Z'
        },
        'watchlist-only': {
          title: 'Watchlist Only',
          genres: ['Comedy'],
          watchlist: true,
          updatedAt: '2024-01-01T00:00:00.000Z'
        },
        skipped: {
          title: 'Skipped',
          skipped: true,
          updatedAt: '2023-01-01T00:00:00.000Z'
        }
      })
    }
  });

  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  assert.equal(text(window.document, '.vypode-account-name'), 'BusyBees1');
  assert.equal(window.document.querySelector('#vypodeSyncBtn').disabled, false);
  assert.equal(text(window.document, '.vypode-stat-total'), '4');
  assert.equal(text(window.document, '.vypode-stat-watched'), '2');

  setInputValue(window, '#vypodeDbSearch', 'language');
  assert.equal(text(window.document, '#vypodeDbSummary'), 'Showing 1 of 1 films');
  assert.match(text(window.document, '#vypodeDbList'), /Arrival/);

  setInputValue(window, '#vypodeDbSearch', '');
  setSelectValue(window, '#vypodeDbFilter', 'missing-rating');
  assert.match(text(window.document, '#vypodeDbList'), /No Rating/);
  assert.doesNotMatch(text(window.document, '#vypodeDbList'), /Arrival/);

  setSelectValue(window, '#vypodeDbFilter', 'all');
  setSelectValue(window, '#vypodeDbGenreFilter', 'Comedy');
  assert.match(text(window.document, '#vypodeDbList'), /Watchlist Only/);
  assert.doesNotMatch(text(window.document, '#vypodeDbList'), /Arrival/);

  setSelectValue(window, '#vypodeDbGenreFilter', 'all');
  setSelectValue(window, '#vypodeDbDateFilter', 'missing-watched-date');
  assert.match(text(window.document, '#vypodeDbList'), /No Rating/);
  assert.doesNotMatch(text(window.document, '#vypodeDbList'), /Watchlist Only/);

  setSelectValue(window, '#vypodeDbDateFilter', 'all');
  setSelectValue(window, '#vypodeDbSort', 'rating');
  assert.match(text(window.document, '.vypode-db-row strong'), /Arrival/);

  click(window.document, '.vypode-db-row');
  assert.match(text(window.document, '.vypode-db-detail'), /Denis Villeneuve/);
  assert.match(text(window.document, '.vypode-db-detail'), /Science Fiction, Drama/);
  assert.match(text(window.document, '.vypode-db-detail'), /language and time/);
});

test('data controls clear skipped and clear all local registry data', async () => {
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: {
      vypode_state: registry({
        arrival: { title: 'Arrival', watched: true },
        skipped: { title: 'Skipped', skipped: true }
      })
    }
  });

  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  assert.equal(text(window.document, '.vypode-stat-skipped'), '1');
  click(window.document, '#vypodeClearSkipped');
  await tick();
  assert.equal(text(window.document, '.vypode-stat-skipped'), '0');

  click(window.document, '#vypodeClearAll');
  await tick();
  assert.equal(text(window.document, '.vypode-stat-total'), '0');
  assert.equal(Object.keys(window.VypodeFilmState.getAll()).length, 0);
});

test('signed-out pages keep sync and review submission disabled', async () => {
  const { window } = await runContent(singleFilmPage({ signedIn: false }), 'https://letterboxd.com/film/arrival/');

  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  assert.match(text(window.document, '.vypode-account-row'), /Not logged in/);
  assert.equal(window.document.querySelector('#vypodeSyncBtn').disabled, true);

  click(window.document, '#vypodeSettingsClose');
  await tick();
  click(window.document, '#vypodeOpenReview');
  await tick();
  assert.equal(text(window.document, '#vypodeReviewSubmit'), 'Log in to submit');
  assert.equal(window.document.querySelector('#vypodeReviewSubmit').disabled, true);
});

test('deck mode hides watched and liked films, opens the first fresh card, and persists skipped films', async () => {
  const { window } = await runContent(listingPage(), 'https://letterboxd.com/films/popular/', {
    local: {
      vypode_state: registry({
        'watched-film': { title: 'Watched Film', watched: true },
        'liked-film': { title: 'Liked Film', liked: true }
      })
    }
  });

  click(window.document, '.vypode-toggle-btn');
  await tick(10);

  assert.equal(text(window.document, '#vypodeCard .vypode-card-title'), 'Fresh Film (2020)');
  assert.match(text(window.document, '.vypode-filter-badge'), /2 filtered/);

  const skipEvent = new window.Event('keydown');
  skipEvent.key = 'ArrowDown';
  window.document.dispatchEvent(skipEvent);
  await tick();
  assert.equal(window.VypodeFilmState.get('fresh-film').skipped, true);

  click(window.document, '#vypodeOpenSettings');
  await tick();
  assert.equal(text(window.document, '.vypode-stat-total'), '3');
  assert.equal(text(window.document, '.vypode-stat-skipped'), '1');

  click(window.document, '#vypodeSettingsClose');
  await tick();
  click(window.document, '#vypodeClose');
  await tick();
});
