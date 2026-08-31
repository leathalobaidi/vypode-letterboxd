import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

import { createFilmStateRuntime } from '../helpers/film-state-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const filmStateSource = fs.readFileSync(path.join(root, 'film-state.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
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
  return `<header>
    <a href="/${username}/">Profile</a>
    <a href="/${username}/films/">Films</a>
    <a href="/${username}/films/diary/">Diary</a>
    <a href="/sign-out/">Sign Out</a>
  </header>`;
}

function poster(slug, title) {
  return `<li class="poster-container"><div class="film-poster">
    <a href="/film/${slug}/"><img alt="Poster for ${title}" src="https://img.test/${slug}.jpg"></a>
  </div></li>`;
}

function listingPage({ films = [], nextHref = null } = {}) {
  const pagination = nextHref === null
    ? ''
    : `<div class="paginate-nextprev"><a class="next" rel="next" href="${nextHref}">Next</a></div>`;
  return `<html><body>${signedInHeader()}
    <ul class="poster-list">${films.map(film => poster(film.slug, film.title)).join('')}</ul>
    ${pagination}
  </body></html>`;
}

function registry(slugs) {
  return { _meta: { version: 2 }, slugs };
}

function filmPage() {
  return `<html><body>${signedInHeader()}
    <h1 class="headline-1">Film</h1>
    <p class="releaseyear"><a>2024</a></p>
    <div class="film-poster"><img src="https://img.test/detail.jpg"></div>
  </body></html>`;
}

function installGlobals(window, url, chrome, fetchImpl, mapTimeout) {
  Object.defineProperty(window, 'location', { value: new NativeURL(url), configurable: true });
  window.chrome = chrome;
  window.vypodeInjected = false;
  window.console = console;
  window.fetch = fetchImpl;
  window.confirm = () => true;
  window.AbortController = globalThis.AbortController;
  window.DOMParser = class {
    parseFromString(html) { return parseHTML(html).document; }
  };
  window.Image = class {
    set src(value) { this._src = value; }
    get src() { return this._src; }
  };
  window.Blob = globalThis.Blob;
  window.URL = NativeURL;
  window.URL.createObjectURL = () => 'blob:swipe-test';
  window.URL.revokeObjectURL = () => {};
  window.setTimeout = (fn, ms, ...args) => nativeSetTimeout(
    fn,
    mapTimeout ? mapTimeout(ms || 0) : Math.min(ms || 0, 2),
    ...args
  );
  window.clearTimeout = nativeClearTimeout;
}

async function runContent(html, url, { local = {}, sync = {}, page2Html = null, mapTimeout = null } = {}) {
  const { window } = parseHTML(html);
  const chrome = {
    storage: { local: storageArea(local), sync: storageArea(sync) },
    runtime: { sendMessage() {}, lastError: null }
  };
  const calls = [];
  const fetchImpl = async requestUrl => {
    const href = String(requestUrl);
    calls.push(href);
    const responseHtml = page2Html && new NativeURL(href, url).pathname === '/films/popular/page/2/'
      ? page2Html
      : filmPage();
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => responseHtml,
      json: async () => ({ csrf: 'csrf-token', lid: 'film-lid' })
    };
  };

  installGlobals(window, url, chrome, fetchImpl, mapTimeout);
  vm.createContext(window);
  vm.runInContext(filmStateSource, window, { filename: 'film-state.js' });
  vm.runInContext(contentSource, window, { filename: 'content.js' });
  await tick(12);
  return { window, chrome, calls };
}

function tick(ms = 5) {
  return new Promise(resolve => nativeSetTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 1000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(step);
  }
  return predicate();
}

function click(document, selector) {
  const element = document.querySelector(selector);
  assert.ok(element, `${selector} should exist`);
  element.click();
  return element;
}

async function openTwoFilmDeck(window) {
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeNext')), true);
}

async function exhaustWithNextButtons(window) {
  click(window.document, '#vypodeNext');
  await tick();
  click(window.document, '#vypodeNext');
  await tick(8);
}

const firstPageUrl = 'https://letterboxd.com/films/popular/';
const firstPage = listingPage({
  films: [
    { slug: 'page-one-a', title: 'Page One A (2020)' },
    { slug: 'page-one-b', title: 'Page One B (2021)' }
  ],
  nextHref: '/films/popular/page/2/'
});
const secondPage = listingPage({
  films: [{ slug: 'page-two-film', title: 'Page Two Film (2024)' }]
});

test('autoNextPage is opt-in and persists through the existing sync preference store', async () => {
  const first = createFilmStateRuntime();
  await first.api.init();
  assert.equal(first.api.getPrefs().autoNextPage, false);

  first.api.setPref('autoNextPage', true);
  assert.equal(first.api.getPrefs().autoNextPage, true);
  assert.equal(first.syncStore.vypode_prefs.autoNextPage, true);

  const restored = createFilmStateRuntime({}, {
    vypode_prefs: clone(first.syncStore.vypode_prefs)
  });
  await restored.api.init();
  assert.equal(restored.api.getPrefs().autoNextPage, true);
});

test('Deck Behaviour toggle writes autoNextPage without changing the default', async () => {
  const { window, chrome } = await runContent(firstPage, firstPageUrl);
  await openTwoFilmDeck(window);
  click(window.document, '#vypodeOpenSettings');
  await tick();

  const toggle = window.document.querySelector('input[data-pref="autoNextPage"]');
  assert.ok(toggle, 'autoNextPage setting should be rendered');
  assert.equal(toggle.hasAttribute('checked'), false, 'navigation should be opt-in');

  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(chrome.storage.sync.store.vypode_prefs.autoNextPage, true);
});

test('enabled autoNextPage follows the real same-origin Next link and resumes the deck', async () => {
  const { window, calls } = await runContent(firstPage, firstPageUrl, {
    sync: { vypode_prefs: { autoNextPage: true } },
    page2Html: secondPage
  });
  await openTwoFilmDeck(window);
  await exhaustWithNextButtons(window);

  assert.equal(window.location.href, 'https://letterboxd.com/films/popular/page/2/#vypode-auto');
  assert.equal(calls.some(url => new NativeURL(url, firstPageUrl).pathname === '/films/popular/page/2/'), false,
    'enabled mode should navigate the tab instead of pre-fetching the next listing page');
});

test('the navigation marker reopens Swipe Deck on the destination page', async () => {
  const { window } = await runContent(
    secondPage,
    'https://letterboxd.com/films/popular/page/2/#vypode-auto=1',
    { sync: { vypode_prefs: { autoNextPage: true } } }
  );

  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);
  assert.equal(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent, 'Page Two Film (2024)');
  assert.equal(window.location.hash, '');
});

test('undo on the last card cancels pending automatic page navigation', async () => {
  const oneFilmPage = listingPage({
    films: [{ slug: 'only-film', title: 'Only Film (2024)' }],
    nextHref: '/films/popular/page/2/'
  });
  const { window } = await runContent(oneFilmPage, firstPageUrl, {
    sync: { vypode_prefs: { autoNextPage: true } }
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  const down = new window.Event('keydown', { bubbles: true });
  Object.defineProperty(down, 'key', { value: 'ArrowDown' });
  window.document.dispatchEvent(down);
  click(window.document, '.vypode-undo-btn');
  await tick(12);

  assert.equal(window.location.href, firstPageUrl);
  assert.equal(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent, 'Only Film (2024)');
});

test('Prev after a last-card skip cancels pending automatic page navigation', async () => {
  const { window } = await runContent(firstPage, firstPageUrl, {
    sync: { vypode_prefs: { autoNextPage: true } }
  });
  await openTwoFilmDeck(window);

  // Move to the terminal card, then skip it. The skip schedules navigation
  // after the Undo window, so Prev must invalidate that pending schedule.
  click(window.document, '#vypodeNext');
  const down = new window.Event('keydown', { bubbles: true });
  Object.defineProperty(down, 'key', { value: 'ArrowDown' });
  window.document.dispatchEvent(down);
  click(window.document, '#vypodePrev');
  await tick(12);

  assert.equal(window.location.href, firstPageUrl);
  assert.equal(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent, 'Page One A (2020)');
});

test('an auto-resumed page containing only filtered films follows Next with a bounded hop marker', async () => {
  const filteredPage = listingPage({
    films: [{ slug: 'already-watched', title: 'Already Watched (2022)' }],
    nextHref: '/films/popular/page/3/'
  });
  const { window } = await runContent(
    filteredPage,
    'https://letterboxd.com/films/popular/page/2/#vypode-auto=1',
    {
      local: {
        vypode_state: registry({
          'already-watched': { title: 'Already Watched', watched: true }
        })
      },
      sync: { vypode_prefs: { autoNextPage: true } }
    }
  );

  assert.equal(await waitFor(() => window.location.pathname === '/films/popular/page/3/'), true);
  assert.equal(window.location.hash, '#vypode-auto=2');
});

test('fully filtered auto-resume stops at the ten-page hop cap', async () => {
  const filteredPage = listingPage({
    films: [{ slug: 'cap-watched', title: 'Cap Watched (2022)' }],
    nextHref: '/films/popular/page/3/'
  });
  const { window } = await runContent(
    filteredPage,
    'https://letterboxd.com/films/popular/page/2/#vypode-auto=10',
    {
      local: {
        vypode_state: registry({
          'cap-watched': { title: 'Cap Watched', watched: true }
        })
      },
      sync: { vypode_prefs: { autoNextPage: true } }
    }
  );

  await tick(12);
  assert.equal(window.location.pathname, '/films/popular/page/2/');
  assert.equal(window.location.hash, '');
});

test('a stale cancelled action retry cannot unlock a newer queue owner', async () => {
  const oneFilmPage = listingPage({
    films: [{ slug: 'queue-owner-film', title: 'Queue Owner Film (2024)' }]
  });
  const { window } = await runContent(oneFilmPage, firstPageUrl, {
    sync: {
      vypode_prefs: {
        excludeWatched: false,
        excludeLiked: false,
        excludeWatchlist: false,
        excludeSkipped: false
      }
    },
    // Let retry backoff fire quickly while keeping the newer iframe's own
    // ten-second timeout pending long enough to observe queue ownership.
    mapTimeout: ms => ms === 10000 ? 50 : Math.min(ms, 2)
  });

  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  const firstAction = new window.Event('keydown', { bubbles: true });
  Object.defineProperty(firstAction, 'key', { value: 'ArrowLeft' });
  window.document.dispatchEvent(firstAction);
  const abandonedIframe = window.document.querySelector('iframe');
  assert.ok(abandonedIframe, 'first action should own an iframe');
  abandonedIframe.onerror();

  click(window.document, '#vypodeClose');
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  for (const key of ['ArrowRight', 'ArrowUp']) {
    const action = new window.Event('keydown', { bubbles: true });
    Object.defineProperty(action, 'key', { value: key });
    window.document.dispatchEvent(action);
  }
  await tick(8);

  assert.equal(window.document.querySelectorAll('iframe').length, 1,
    'the abandoned retry must not start a concurrent iframe beside the newer queue owner');
  click(window.document, '#vypodeClose');
});

test('disabled autoNextPage preserves v6.2 in-place next-page loading', async () => {
  const { window, calls } = await runContent(firstPage, firstPageUrl, { page2Html: secondPage });
  await openTwoFilmDeck(window);
  await exhaustWithNextButtons(window);

  assert.equal(await waitFor(() => calls.some(url => new NativeURL(url, firstPageUrl).pathname === '/films/popular/page/2/')), true);
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent === 'Page Two Film (2024)'), true);
  assert.equal(window.location.href, firstPageUrl);
});

test('autoNextPage refuses cross-origin and same-page pagination targets', async () => {
  for (const nextHref of [
    'https://evil.example/films/popular/page/2/',
    '/films/popular/#loop'
  ]) {
    const guardedPage = listingPage({
      films: [
        { slug: 'guard-a', title: 'Guard A (2020)' },
        { slug: 'guard-b', title: 'Guard B (2021)' }
      ],
      nextHref
    });
    const { window, calls } = await runContent(guardedPage, firstPageUrl, {
      sync: { vypode_prefs: { autoNextPage: true } }
    });
    await openTwoFilmDeck(window);
    await exhaustWithNextButtons(window);

    assert.equal(window.location.href, firstPageUrl, `should refuse ${nextHref}`);
    assert.equal(calls.some(url => String(url).startsWith('https://evil.example/')), false);
  }
});
