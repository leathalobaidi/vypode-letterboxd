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

function largeLibrary(prefix, count = 170) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    return [`${prefix.toLowerCase()}-${number}`, {
      title: `${prefix} Film ${number}`,
      year: String(2000 + (index % 25)),
      watched: true,
      watchedDate: `2025-01-${String((index % 28) + 1).padStart(2, '0')}`,
      updatedAt: new Date(Date.UTC(2025, 0, (index % 28) + 1, 0, 0, index)).toISOString()
    }];
  }));
}

function createChrome(localInitial = {}, syncInitial = {}) {
  const storageListeners = [];
  return {
    storage: {
      local: storageArea(localInitial),
      sync: storageArea(syncInitial),
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    },
    runtime: {
      sendMessage() {}
    },
    emitStorageChange(changes, areaName = 'local') {
      for (const listener of storageListeners) listener(changes, areaName);
    }
  };
}

function installBrowserGlobals(window, url, chrome) {
  Object.defineProperty(window, 'location', { value: new NativeURL(url), configurable: true });
  let focusedElement = window.document.body;
  Object.defineProperty(window.document, 'activeElement', {
    configurable: true,
    get: () => focusedElement
  });
  window.HTMLElement.prototype.focus = function focus() {
    focusedElement = this;
  };
  window.HTMLElement.prototype.blur = function blur() {
    if (focusedElement === this) focusedElement = window.document.body;
  };
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

function keydown(window, key, options = {}) {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    metaKey: { value: Boolean(options.metaKey) },
    ctrlKey: { value: Boolean(options.ctrlKey) },
    altKey: { value: Boolean(options.altKey) },
    shiftKey: { value: Boolean(options.shiftKey) },
    repeat: { value: Boolean(options.repeat) },
    isComposing: { value: Boolean(options.isComposing) }
  });
  (options.target || window.document).dispatchEvent(event);
  return event;
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

function controlValueForTest(document, selector) {
  const select = document.querySelector(selector);
  return Array.from(select?.options || []).find(option => option.selected)?.value || select?.value;
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
  assert.equal(text(window.document, '#accountStatus'), 'Active Letterboxd session detected');
  assert.equal(text(window.document, '.version'), 'v6.3.0-beta.5');
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
          watchedDate: '2024-03-17',
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
  assert.equal(text(window.document, '#vypodeDbSummary'), 'Showing 1 of 1 matching films (4 total)');
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
  assert.match(text(window.document, '.vypode-db-detail'), /Watched date: 2024-03-17/);
});

test('large profile databases load in deterministic 80-film pages and reset after query or account changes', async () => {
  const firstAccount = largeLibrary('First', 170);
  const secondAccount = largeLibrary('Second', 170);
  firstAccount['first-160'].skipped = true;
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: {
      vypode_state: {
        _meta: { version: 3, generation: 0, activeAccount: 'user:busybees1' },
        accounts: {
          'user:busybees1': { _meta: { version: 3 }, slugs: firstAccount },
          'user:bob': { _meta: { version: 3 }, slugs: secondAccount }
        }
      }
    }
  });

  for (let attempt = 0; attempt < 40 && !window.document.querySelector('.vypode-toggle-btn'); attempt += 1) {
    await tick(5);
  }

  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  assert.equal(window.document.querySelectorAll('.vypode-db-row').length, 80);
  assert.equal(text(window.document, '#vypodeDbSummary'), 'Showing 80 of 170 films');
  assert.equal(text(window.document, '#vypodeDbLoadMore'), 'Load 80 more (90 remaining)');

  click(window.document, '#vypodeDbLoadMore');
  assert.equal(window.document.querySelectorAll('.vypode-db-row').length, 160);
  assert.equal(text(window.document, '#vypodeDbSummary'), 'Showing 160 of 170 films');
  assert.equal(text(window.document, '#vypodeDbLoadMore'), 'Load 10 more (10 remaining)');

  const lateRow = window.document.querySelector('.vypode-db-row[data-slug="first-160"]');
  assert.ok(lateRow, 'newly loaded rows keep their detail binding');
  lateRow.click();
  assert.equal(window.document.querySelector('.vypode-db-detail')?.dataset.slug, 'first-160');
  click(window.document, '.vypode-db-detail-close');
  click(window.document, '.vypode-db-restore[data-slug="first-160"]');
  await tick(20);
  assert.equal(window.VypodeFilmState.get('first-160').skipped, false, 'newly loaded restore controls stay bound');

  click(window.document, '#vypodeDbLoadMore');
  assert.equal(window.document.querySelectorAll('.vypode-db-row').length, 170);
  assert.equal(text(window.document, '#vypodeDbSummary'), 'Showing 170 of 170 films');
  assert.equal(window.document.querySelector('#vypodeDbLoadMore'), null);

  setInputValue(window, '#vypodeDbSearch', 'Film');
  assert.equal(window.document.querySelectorAll('.vypode-db-row').length, 80, 'search resets the visible limit');
  click(window.document, '#vypodeDbLoadMore');
  setSelectValue(window, '#vypodeDbFilter', 'watched');
  assert.equal(window.document.querySelectorAll('.vypode-db-row').length, 80, 'status filters reset the visible limit');
  click(window.document, '#vypodeDbLoadMore');
  setSelectValue(window, '#vypodeDbSort', 'updated');
  assert.equal(window.document.querySelectorAll('.vypode-db-row').length, 80, 'sorting resets the visible limit');
  click(window.document, '#vypodeDbLoadMore');

  await window.VypodeFilmState.switchAccount('Bob');
  await tick();
  assert.equal(window.document.querySelectorAll('.vypode-db-row').length, 80, 'account changes reset the visible limit');
  assert.equal(text(window.document, '#vypodeDbSummary'), 'Showing 80 of 170 matching films (170 total)');
  assert.match(text(window.document, '.vypode-db-row'), /Second Film/);
  assert.doesNotMatch(text(window.document, '#vypodeDbList'), /First Film/);
});

test('review dialog contains keyboard focus and restores it after an unmodified Escape', async () => {
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  const opener = window.document.querySelector('#vypodeOpenReview');
  opener.focus();
  opener.click();
  await tick();

  const panel = window.document.querySelector('.vypode-review-panel');
  const first = panel.querySelector('#vypodeReviewClose');
  const last = panel.querySelector('#vypodeReviewSubmit');
  const textarea = panel.querySelector('#vypodeReviewText');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.equal(window.document.activeElement, textarea);

  last.focus();
  const forward = keydown(window, 'Tab', { target: last });
  assert.equal(forward.defaultPrevented, true);
  assert.equal(window.document.activeElement, first);

  first.focus();
  const backward = keydown(window, 'Tab', { target: first, shiftKey: true });
  assert.equal(backward.defaultPrevented, true);
  assert.equal(window.document.activeElement, last);

  textarea.focus();
  const typing = keydown(window, '1', { target: textarea });
  assert.equal(typing.defaultPrevented, false, 'rating shortcuts do not consume editable-field input');
  assert.equal(panel.querySelector('.vypode-star[aria-checked="true"]'), null);

  let submitClicks = 0;
  last.addEventListener('click', () => { submitClicks += 1; });
  for (const control of [first, panel.querySelector('#vypodeReviewCancel'), panel.querySelector('#vypodeMicBtn'), panel.querySelector('.vypode-star')]) {
    control.focus();
    const enter = keydown(window, 'Enter', { target: control });
    assert.equal(enter.defaultPrevented, false, 'Enter retains the focused control\'s native behavior');
  }
  assert.equal(submitClicks, 0, 'Enter on another review control must not invoke Submit');

  const modifiedEscape = keydown(window, 'Escape', { target: textarea, ctrlKey: true });
  assert.equal(modifiedEscape.defaultPrevented, false);
  assert.ok(window.document.querySelector('.vypode-review-panel'));

  const escape = keydown(window, 'Escape', { target: textarea });
  assert.equal(escape.defaultPrevented, true);
  await tick(10);
  assert.equal(window.document.querySelector('.vypode-review-panel'), null);
  assert.equal(window.document.activeElement, opener);
});

test('the Swipe surface is a modal, contains focus, and restores the page toggle on Escape', async () => {
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/');
  const toggle = window.document.querySelector('.vypode-toggle-btn');
  toggle.focus();
  toggle.click();
  await tick();

  const overlay = window.document.querySelector('.vypode-overlay');
  const first = overlay.querySelector('#vypodeOpenReview');
  const last = overlay.querySelector('#vypodeClose');
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.equal(window.document.activeElement, last, 'Close receives focus when Swipe opens');

  last.focus();
  const forward = keydown(window, 'Tab', { target: last });
  assert.equal(forward.defaultPrevented, true);
  assert.equal(window.document.activeElement, first);

  first.focus();
  const backward = keydown(window, 'Tab', { target: first, shiftKey: true });
  assert.equal(backward.defaultPrevented, true);
  assert.equal(window.document.activeElement, last);

  first.focus();
  first.click();
  await tick();
  assert.equal(overlay.getAttribute('aria-modal'), 'false', 'the child Review dialog owns the modal layer');
  keydown(window, 'Escape', { target: window.document.activeElement });
  await tick(10);
  assert.equal(window.document.querySelector('.vypode-review-panel'), null);
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.equal(window.document.activeElement, first, 'closing Review returns focus to its opener');

  const escape = keydown(window, 'Escape', { target: first });
  assert.equal(escape.defaultPrevented, true);
  await tick(10);
  assert.equal(window.document.querySelector('.vypode-overlay'), null);
  assert.equal(window.document.activeElement, toggle);
});

test('a delayed settings focus cannot escape a newly opened detail dialog', async () => {
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: {
      vypode_state: registry({
        arrival: { title: 'Arrival', skipped: true, watched: true }
      })
    }
  });
  click(window.document, '.vypode-toggle-btn');
  await tick();

  click(window.document, '#vypodeOpenSettings');
  const row = window.document.querySelector('.vypode-db-row');
  assert.ok(row, 'database renders synchronously with Settings');
  row.click();
  const detailClose = window.document.querySelector('.vypode-db-detail-close');
  assert.equal(window.document.activeElement, detailClose);

  await tick(10);
  assert.equal(window.document.activeElement, detailClose, 'the parent Settings timer must not focus its inert close button');
});

test('settings and database detail expose one active modal layer and Escape closes only the top layer', async () => {
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: {
      vypode_state: registry({
        arrival: { title: 'Arrival', skipped: true, watched: true }
      })
    }
  });
  click(window.document, '.vypode-toggle-btn');
  await tick();
  const opener = window.document.querySelector('#vypodeOpenSettings');
  opener.focus();
  opener.click();
  await tick();

  const settings = window.document.querySelector('.vypode-settings-panel');
  const first = settings.querySelector('#vypodeSettingsClose');
  const last = settings.querySelector('#vypodeClearAll');
  first.focus();
  keydown(window, 'Tab', { target: first, shiftKey: true });
  assert.equal(window.document.activeElement, last);
  keydown(window, 'Tab', { target: last });
  assert.equal(window.document.activeElement, first);

  const search = settings.querySelector('#vypodeDbSearch');
  search.focus();
  const typing = keydown(window, 's', { target: search });
  assert.equal(typing.defaultPrevented, false);
  assert.ok(window.document.querySelector('.vypode-settings-panel'));

  const row = settings.querySelector('.vypode-db-row');
  row.focus();
  row.click();
  const detail = window.document.querySelector('.vypode-db-detail');
  const detailClose = detail.querySelector('.vypode-db-detail-close');
  const detailLast = detail.querySelector('.vypode-db-restore-detail');
  assert.equal(detail.getAttribute('aria-modal'), 'true');
  assert.equal(settings.getAttribute('aria-modal'), 'false');
  assert.equal(settings.getAttribute('aria-hidden'), 'true');
  assert.equal(settings.hasAttribute('inert'), true);
  assert.equal(window.document.activeElement, detailClose);

  keydown(window, 'Tab', { target: detailClose, shiftKey: true });
  assert.equal(window.document.activeElement, detailLast);
  const modifiedEscape = keydown(window, 'Escape', { target: detailLast, metaKey: true });
  assert.equal(modifiedEscape.defaultPrevented, false);
  assert.ok(window.document.querySelector('.vypode-db-detail'));

  const closeDetail = keydown(window, 'Escape', { target: detailLast });
  assert.equal(closeDetail.defaultPrevented, true);
  assert.equal(window.document.querySelector('.vypode-db-detail'), null);
  assert.ok(window.document.querySelector('.vypode-settings-panel'));
  assert.equal(settings.getAttribute('aria-modal'), 'true');
  assert.equal(settings.hasAttribute('aria-hidden'), false);
  assert.equal(settings.hasAttribute('inert'), false);
  assert.equal(window.document.activeElement, row);

  search.focus();
  const closeSettings = keydown(window, 'Escape', { target: search });
  assert.equal(closeSettings.defaultPrevented, true);
  await tick(10);
  assert.equal(window.document.querySelector('.vypode-settings-panel'), null);
  assert.equal(window.document.activeElement, opener);
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

test('skipped manager restores individual films from detail and list views', async () => {
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: {
      vypode_state: registry({
        first: { title: 'First Skip', skipped: true, ratingValue: 4 },
        second: { title: 'Second Skip', skipped: true, reviewText: 'Keep my review' },
        normal: { title: 'Normal Film', watched: true }
      })
    }
  });

  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  assert.equal(text(window.document, '#vypodeManageSkipped'), 'Skipped (2)');
  click(window.document, '#vypodeManageSkipped');
  assert.equal(controlValueForTest(window.document, '#vypodeDbFilter'), 'skipped');
  assert.equal(window.document.querySelectorAll('.vypode-db-restore').length, 2);
  assert.doesNotMatch(text(window.document, '#vypodeDbList'), /Normal Film/);

  click(window.document, '.vypode-db-row');
  assert.equal(window.document.querySelector('.vypode-db-detail')?.getAttribute('role'), 'dialog');
  assert.match(text(window.document, '.vypode-db-restore-detail'), /Restore to Swipe deck/);
  const firstSlug = window.document.querySelector('.vypode-db-detail')?.dataset.slug;
  click(window.document, '.vypode-db-restore-detail');
  await tick(20);

  assert.equal(window.VypodeFilmState.get(firstSlug).skipped, false);
  assert.equal(text(window.document, '.vypode-stat-skipped'), '1');
  assert.equal(window.document.querySelectorAll('.vypode-db-restore').length, 1);
  assert.equal(window.document.querySelector('.vypode-db-detail'), null);

  click(window.document, '.vypode-db-restore');
  await tick(20);
  assert.equal(window.VypodeFilmState.getStats().skipped, 0);
  assert.equal(text(window.document, '.vypode-stat-skipped'), '0');
  assert.equal(window.document.querySelector('#vypodeManageSkipped').disabled, true);
  assert.match(text(window.document, '#vypodeDbSummary'), /No skipped films/);
  assert.equal(window.VypodeFilmState.get('second').reviewText, 'Keep my review');
});

test('database detail and its restore action stay bound to the account that rendered them', async () => {
  const sharedSlug = 'same-film';
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: {
      vypode_state: {
        _meta: { version: 3, generation: 0, activeAccount: 'user:busybees1' },
        accounts: {
          'user:busybees1': {
            _meta: { version: 3 },
            slugs: { [sharedSlug]: { title: 'First account film', skipped: true } }
          },
          'user:bob': {
            _meta: { version: 3 },
            slugs: { [sharedSlug]: { title: 'Second account film', skipped: true } }
          }
        }
      }
    }
  });

  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeManageSkipped');
  click(window.document, '.vypode-db-row');
  const staleRestore = window.document.querySelector('.vypode-db-restore-detail');
  assert.equal(window.document.querySelector('.vypode-db-detail')?.dataset.accountId, 'user:busybees1');

  await window.VypodeFilmState.switchAccount('Bob');
  await tick();
  assert.equal(window.document.querySelector('.vypode-db-detail'), null, 'account change closes the old detail');
  assert.match(text(window.document, '#vypodeDbList'), /Second account film/, 'database is rebuilt for the active account');

  staleRestore.click();
  await tick(10);
  assert.equal(window.VypodeFilmState.get(sharedSlug).skipped, true, 'detached old-account control cannot restore the new account film');
  await window.VypodeFilmState.switchAccount('BusyBees1');
  assert.equal(window.VypodeFilmState.get(sharedSlug).skipped, true, 'the old account was not changed either');
});

test('restoring the only eligible skipped film repopulates an empty deck immediately', async () => {
  const { window } = await runContent(listingPage(), 'https://letterboxd.com/films/popular/', {
    local: {
      vypode_state: registry({
        'watched-film': { title: 'Watched Film', watched: true },
        'liked-film': { title: 'Liked Film', liked: true },
        'fresh-film': { title: 'Fresh Film', skipped: true }
      })
    }
  });

  click(window.document, '.vypode-toggle-btn');
  await tick(10);
  assert.match(text(window.document, '#vypodeCard .vypode-card-title'), /hidden by your filters/);

  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeManageSkipped');
  click(window.document, '.vypode-db-restore');
  await tick(20);

  assert.equal(window.VypodeFilmState.shouldExclude('fresh-film'), false);
  assert.equal(text(window.document, '#vypodeCard .vypode-card-title'), 'Fresh Film (2020)');
  assert.equal(window.document.querySelector('#vypodeCard').getAttribute('aria-disabled'), null);
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

test('cross-tab state received during a swipe is refiltered after the animation settles', async () => {
  const { window, chrome } = await runContent(listingPage(), 'https://letterboxd.com/films/popular/');
  click(window.document, '.vypode-toggle-btn');
  await tick(10);
  assert.equal(text(window.document, '#vypodeCard .vypode-card-title'), 'Watched Film (2001)');

  const skipEvent = new window.Event('keydown');
  skipEvent.key = 'ArrowDown';
  window.document.dispatchEvent(skipEvent);

  // Deliver another tab's newer watched flag while the down-swipe animation
  // still owns the card. The UI must queue this refilter instead of dropping it.
  const activeAccount = window.VypodeFilmState.getAccountId();
  const changedAt = new Date(Date.now() + 1000).toISOString();
  const external = {
    _meta: { version: 3, generation: 1, activeAccount },
    accounts: {
      [activeAccount]: {
        _meta: { version: 3 },
        slugs: clone(window.VypodeFilmState.getAll())
      }
    }
  };
  external.accounts[activeAccount].slugs['fresh-film'] = {
    ...external.accounts[activeAccount].slugs['fresh-film'],
    watched: true,
    watchedAt: changedAt,
    watchedChangedAt: changedAt,
    watchedSource: 'userAction',
    updatedAt: changedAt
  };
  const oldValue = clone(chrome.storage.local.store.vypode_state);
  chrome.storage.local.store.vypode_state = clone(external);
  chrome.emitStorageChange({ vypode_state: { oldValue, newValue: external } });

  await tick(30);
  assert.equal(window.VypodeFilmState.get('fresh-film').watched, true);
  assert.equal(text(window.document, '#vypodeCard .vypode-card-title'), 'Liked Film (1999)');
});
