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
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
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

function loadBackgroundRuntime(localArea) {
  const listeners = [];
  const context = {
    console,
    URL: NativeURL,
    chrome: {
      storage: { local: localArea },
      runtime: {
        lastError: null,
        onMessage: { addListener(listener) { listeners.push(listener); } }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  assert.equal(listeners.length, 1);
  return message => new Promise(resolve => {
    const remainsOpen = listeners[0](message, {}, resolve);
    if (remainsOpen !== true) resolve(undefined);
  });
}

function signedInHeader(username = 'BusyBees1') {
  return `<header>
    <a href="/${username}/">Profile</a>
    <a href="/${username}/films/">Films</a>
    <a href="/${username}/films/diary/">Diary</a>
    <a href="/sign-out/">Sign Out</a>
  </header>`;
}

function poster(slug, title, states = {}) {
  const overlay = states.inWatchlist
    ? '<div class="film-poster-overlay"><span class="action -watchlist -on"></span></div>'
    : '';
  return `<li class="poster-container"><div class="film-poster">
    <a href="/film/${slug}/"><img alt="Poster for ${title}" src="https://img.test/${slug}.jpg"></a>
    ${overlay}
  </div></li>`;
}

function listingPage({ films = [], nextHref = null, headHtml = '', paginationHtml = null, signedIn = true } = {}) {
  const pagination = paginationHtml === null
    ? (nextHref === null
        ? ''
        : `<div class="paginate-nextprev"><a class="next" rel="next" href="${nextHref}">Next</a></div>`)
    : paginationHtml;
  return `<html><head>${headHtml}</head><body>${signedIn ? signedInHeader() : '<header><a href="/sign-in/">Sign In</a></header>'}
    <ul class="poster-list">${films.map(film => poster(film.slug, film.title, film)).join('')}</ul>
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

function singleActionPage(username = 'BusyBees1') {
  return `<html><body>${signedInHeader(username)}
    <h1 class="headline-1">Action Film</h1>
    <p class="releaseyear"><a>2024</a></p>
    <div class="film-poster"><img src="https://img.test/action-film.jpg"></div>
    <button class="action -watch">Watch</button>
    <button class="action -like">Like</button>
    <button class="action -watchlist">Watchlist</button>
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

async function runContent(html, url, {
  local = {},
  sync = {},
  page2Html = null,
  pageHtmlByPath = {},
  mapTimeout = null,
  runtimeSendMessage = null,
  sharedLocalArea = null
} = {}) {
  const { window } = parseHTML(html);
  const storageListeners = [];
  const chrome = {
    storage: {
      local: sharedLocalArea || storageArea(local),
      sync: storageArea(sync),
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    },
    runtime: {
      sendMessage(message) { return runtimeSendMessage?.(message); },
      lastError: null
    },
    emitStorageChange(changes, areaName = 'local') {
      for (const listener of storageListeners) listener(changes, areaName);
    }
  };
  const calls = [];
  const fetchImpl = async requestUrl => {
    const href = String(requestUrl);
    calls.push(href);
    const pathname = new NativeURL(href, url).pathname;
    const responseHtml = pageHtmlByPath[pathname] ?? (
      page2Html && pathname === '/films/popular/page/2/' ? page2Html : filmPage()
    );
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

function text(document, selector) {
  return document.querySelector(selector)?.textContent?.trim() || '';
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

function installIframeDocument(iframe, html, username = 'BusyBees1') {
  const iframeDocument = parseHTML(html).document;
  if (username) iframeDocument.body?.insertAdjacentHTML?.('afterbegin', signedInHeader(username));
  Object.defineProperty(iframe, 'contentDocument', { value: iframeDocument, configurable: true });
  return iframeDocument;
}

function replaceSessionHeader(document, username) {
  const header = document.querySelector('header');
  assert.ok(header, 'the Letterboxd session header should exist');
  header.innerHTML = username
    ? `<a href="/${username}/">Profile</a><a href="/${username}/films/">Films</a><a href="/${username}/films/diary/">Diary</a><a href="/sign-out/">Sign Out</a>`
    : '<a href="/sign-in/">Sign In</a>';
}

async function clearAllFromOpenDeck(window) {
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeClearAll');
}

function actionToggle(action, active = false) {
  return `<html><body><button class="action -${action}${active ? ' -on' : ''}">${action}</button></body></html>`;
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
    sync: { vypode_prefs: { autoNextPage: true } },
    mapTimeout: ms => (ms === 5000 || ms === 5200) ? 200 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  const down = new window.Event('keydown', { bubbles: true });
  Object.defineProperty(down, 'key', { value: 'ArrowDown' });
  window.document.dispatchEvent(down);
  assert.equal(await waitFor(() => window.document.querySelector('.vypode-undo-btn')), true);
  click(window.document, '.vypode-undo-btn');
  await tick(12);

  assert.equal(window.location.href, firstPageUrl);
  assert.equal(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent, 'Only Film (2024)');
});

test('an already-active action on the final card still advances to the next page', async () => {
  const alreadyWatchlistedPage = listingPage({
    films: [{ slug: 'already-watchlisted', title: 'Already Watchlisted (2024)', inWatchlist: true }],
    nextHref: '/films/popular/page/2/'
  });
  const { window } = await runContent(alreadyWatchlistedPage, firstPageUrl, {
    sync: {
      vypode_prefs: {
        autoNextPage: true,
        excludeWatchlist: false
      }
    }
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);
  assert.match(window.document.querySelector('#vypodeCard .vypode-card-states')?.textContent || '', /In Watchlist/);

  const addToWatchlist = new window.Event('keydown', { bubbles: true });
  Object.defineProperty(addToWatchlist, 'key', { value: 'ArrowRight' });
  window.document.dispatchEvent(addToWatchlist);

  assert.equal(await waitFor(() => window.location.pathname === '/films/popular/page/2/'), true);
  assert.equal(window.location.hash, '#vypode-auto');
  assert.equal(window.document.querySelectorAll('iframe').length, 0,
    'an already-active action should advance without sending a duplicate Letterboxd action');
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
  assert.equal(await waitFor(() => window.VypodeFilmState.get('page-one-b')?.skipped === true), true);
  click(window.document, '#vypodePrev');
  assert.equal(await waitFor(() =>
    window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent === 'Page One A (2020)'
  ), true);

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

test('two tabs sharing the real worker claim one deduped action and click exactly once', async () => {
  const sharedLocalArea = storageArea();
  const runtimeSendMessage = loadBackgroundRuntime(sharedLocalArea);
  const page = listingPage({ films: [{ slug: 'shared-worker-film', title: 'Shared Worker Film (2024)' }] });
  const options = {
    sharedLocalArea,
    runtimeSendMessage,
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 300 : Math.min(ms, 2)
  };
  const first = await runContent(page, firstPageUrl, options);
  const second = await runContent(page, firstPageUrl, options);
  click(first.window.document, '.vypode-toggle-btn');
  click(second.window.document, '.vypode-toggle-btn');
  keydown(first.window, 'ArrowLeft');
  keydown(second.window, 'ArrowLeft');

  const windows = [first.window, second.window];
  assert.equal(await waitFor(() => windows.reduce(
    (count, current) => count + current.document.querySelectorAll('iframe').length, 0
  ) === 1), true);
  const ownerWindow = windows.find(current => current.document.querySelector('iframe'));
  const iframe = ownerWindow.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(iframe, actionToggle('watch'));
  let remoteClicks = 0;
  iframeDocument.querySelector('.action.-watch').addEventListener('click', event => {
    remoteClicks++;
    event.currentTarget.classList.add('-on');
  });
  iframe.onload();

  assert.equal(await waitFor(() => Object.keys(sharedLocalArea.store.vypode_action_outbox_v1 || {}).length === 0), true);
  await tick(30);
  assert.equal(remoteClicks, 1);
  assert.equal(windows.reduce(
    (count, current) => count + current.document.querySelectorAll('iframe').length, 0
  ), 0);
});

test('closing the deck keeps an in-flight action alive until remote state is verified', async () => {
  const oneFilmPage = listingPage({
    films: [{ slug: 'close-queue-film', title: 'Close Queue Film (2024)' }]
  });
  const { window, chrome } = await runContent(oneFilmPage, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 100 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  assert.ok(iframe, 'the queued action should own a hidden iframe');
  click(window.document, '#vypodeClose');
  assert.equal(window.document.contains(iframe), true, 'deck close must not remove the action iframe');

  const iframeDocument = installIframeDocument(iframe, '<html><body><button class="action -watch">Watch</button></body></html>');
  let remoteClicks = 0;
  iframeDocument.querySelector('.action.-watch').addEventListener('click', event => {
    remoteClicks++;
    event.currentTarget.classList.add('-on');
  });
  iframe.onload();

  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  assert.equal(remoteClicks, 1);
  assert.equal(window.VypodeFilmState.get('close-queue-film')?.watched, true);
  assert.deepEqual(chrome.storage.local.store.vypode_action_outbox_v1 || {}, {});
});

test('a cross-tab deck refilter waits for the remote action queue to settle', async () => {
  const page = listingPage({ films: [
    { slug: 'queue-a', title: 'Queue A (2024)' },
    { slug: 'queue-b', title: 'Queue B (2023)' },
    { slug: 'queue-c', title: 'Queue C (2022)' }
  ] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    mapTimeout: ms => ms === 10000 ? 200 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  assert.equal(await waitFor(() => text(window.document, '#vypodeCard .vypode-card-title') === 'Queue B (2023)'), true);

  const activeAccount = window.VypodeFilmState.getAccountId();
  const oldValue = clone(chrome.storage.local.store.vypode_state);
  const changedAt = new Date(Date.now() + 1000).toISOString();
  const external = {
    _meta: {
      version: 3,
      generation: oldValue?._meta?.generation || 0,
      activeAccount
    },
    accounts: {
      [activeAccount]: {
        _meta: { version: 3 },
        slugs: clone(window.VypodeFilmState.getAll())
      }
    }
  };
  external.accounts[activeAccount].slugs['queue-b'] = {
    ...external.accounts[activeAccount].slugs['queue-b'],
    watched: true,
    watchedAt: changedAt,
    watchedChangedAt: changedAt,
    watchedSource: 'userAction',
    updatedAt: changedAt
  };
  chrome.storage.local.store.vypode_state = clone(external);
  chrome.emitStorageChange({ vypode_state: { oldValue, newValue: external } });
  await tick(10);
  assert.equal(text(window.document, '#vypodeCard .vypode-card-title'), 'Queue B (2023)', 'queue ownership defers the refilter');

  const iframe = window.document.querySelector('iframe');
  installIframeDocument(iframe, '<html><body><button class="action -watch -on">Watched</button></body></html>');
  iframe.onload();
  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  assert.equal(await waitFor(() => text(window.document, '#vypodeCard .vypode-card-title') === 'Queue C (2022)'), true);
});

test('an already-active film page verifies a queued action without toggling it off', async () => {
  const oneFilmPage = listingPage({
    films: [{ slug: 'preactive-film', title: 'Preactive Film (2024)' }]
  });
  const { window } = await runContent(oneFilmPage, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 100 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(
    iframe,
    '<html><body><button class="action -watch -on">Watched</button></body></html>'
  );
  let remoteClicks = 0;
  iframeDocument.querySelector('.action.-watch').addEventListener('click', () => { remoteClicks++; });
  iframe.onload();

  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  assert.equal(remoteClicks, 0, 'an active toggle must never be clicked again');
  assert.equal(window.VypodeFilmState.get('preactive-film')?.watched, true);
  await tick(50);
  assert.equal(window.document.querySelectorAll('iframe').length, 0,
    'a late iframe event must not resurrect a verified action as a retry');
});

test('Undo becomes visibly unavailable as soon as the Letterboxd toggle is sent', async () => {
  const oneFilmPage = listingPage({ films: [{ slug: 'honest-undo', title: 'Honest Undo (2024)' }] });
  const { window } = await runContent(oneFilmPage, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => (ms === 10000 || ms === 5000) ? 200 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);
  keydown(window, 'ArrowLeft');

  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(iframe, '<html><body><button class="action -watch">Watch</button></body></html>');
  iframe.onload();
  assert.equal(await waitFor(() => window.document.querySelector('.vypode-undo-btn')?.disabled === true), true);
  assert.match(window.document.querySelector('.vypode-undo-btn').textContent, /Syncing|Synced/);
  iframeDocument.querySelector('.action.-watch').classList.add('-on');
  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
});

test('a failed action rolls back its optimistic local state after bounded retries', async () => {
  const oneFilmPage = listingPage({ films: [{ slug: 'rollback-film', title: 'Rollback Film (2024)' }] });
  const { window, chrome } = await runContent(oneFilmPage, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 80 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);
  keydown(window, 'ArrowLeft');

  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
    window.document.querySelector('iframe').onerror();
    await tick(4);
  }
  assert.equal(await waitFor(() => window.VypodeFilmState.get('rollback-film')?.watched === false), true);
  assert.deepEqual(chrome.storage.local.store.vypode_action_outbox_v1 || {}, {});
});

test('a retrying action remains the sole queue owner when the deck is closed and reopened', async () => {
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
    // Let retry backoff fire quickly while keeping the iframe's own ten-second
    // timeout pending long enough to observe queue ownership.
    mapTimeout: ms => ms === 10000 ? 50 : Math.min(ms, 2)
  });

  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  const firstAction = new window.Event('keydown', { bubbles: true });
  Object.defineProperty(firstAction, 'key', { value: 'ArrowLeft' });
  window.document.dispatchEvent(firstAction);
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const abandonedIframe = window.document.querySelector('iframe');
  assert.ok(abandonedIframe, 'first action should own an iframe');
  abandonedIframe.onerror();

  click(window.document, '#vypodeClose');
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard')), true);

  await tick(8);

  assert.equal(window.document.querySelectorAll('iframe').length, 1,
    'the retry must replace its failed iframe rather than running concurrently');
  const retryIframe = window.document.querySelector('iframe');
  installIframeDocument(retryIframe, '<html><body><button class="action -watch -on">Watched</button></body></html>');
  retryIframe.onload();
  assert.equal(await waitFor(() => !window.document.contains(retryIframe)), true);
  click(window.document, '#vypodeClose');
});

test('Clear All fences a queued action whose durable outbox write has not returned', async () => {
  let queuedMessage = null;
  let finishUpsert;
  const delayedUpsert = new Promise(resolve => { finishUpsert = resolve; });
  const page = listingPage({ films: [{ slug: 'clear-before-persist', title: 'Clear Before Persist (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    runtimeSendMessage(message) {
      if (message?.type === 'vypode-state' && message.action === 'outboxUpsert') {
        queuedMessage = clone(message);
        return delayedUpsert;
      }
      return undefined;
    }
  });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => queuedMessage !== null), true);
  assert.equal(window.document.querySelector('iframe'), null, 'dispatch waits for durable persistence');

  await clearAllFromOpenDeck(window);
  chrome.storage.local.store.vypode_action_outbox_v1 = {
    [queuedMessage.data.id]: clone(queuedMessage.data.record)
  };
  finishUpsert({
    ok: true,
    id: queuedMessage.data.id,
    record: clone(queuedMessage.data.record)
  });

  assert.equal(await waitFor(() => window.VypodeFilmState.getStats().total === 0), true);
  await tick(30);
  assert.equal(window.document.querySelectorAll('iframe').length, 0);
  assert.deepEqual(chrome.storage.local.store.vypode_action_outbox_v1 || {}, {});
  assert.equal(window.VypodeFilmState.get('clear-before-persist'), null);
});

test('Clear All removes a loading iframe and a late load callback stays inert', async () => {
  const page = listingPage({ films: [{ slug: 'clear-loading', title: 'Clear Loading (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 300 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(iframe, actionToggle('watch'));
  let remoteClicks = 0;
  iframeDocument.querySelector('.action.-watch').addEventListener('click', () => { remoteClicks++; });
  const lateLoad = iframe.onload;

  await clearAllFromOpenDeck(window);
  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  lateLoad.call(iframe);
  await tick(40);

  assert.equal(remoteClicks, 0);
  assert.equal(window.VypodeFilmState.get('clear-loading'), null);
  assert.deepEqual(chrome.storage.local.store.vypode_action_outbox_v1 || {}, {});
});

test('Clear All cancels retry backoff before it can create another iframe', async () => {
  const page = listingPage({ films: [{ slug: 'clear-retry', title: 'Clear Retry (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 1000 ? 100 : ms === 10000 ? 400 : Math.min(ms, 2)
  });
  assert.equal(await waitFor(() => window.document.querySelector('.vypode-toggle-btn')), true);
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  window.document.querySelector('iframe').onerror();

  await clearAllFromOpenDeck(window);
  assert.equal(await waitFor(() => window.VypodeFilmState.getStats().total === 0), true);
  await tick(140);

  assert.equal(window.document.querySelectorAll('iframe').length, 0);
  assert.equal(window.VypodeFilmState.get('clear-retry'), null);
  assert.deepEqual(chrome.storage.local.store.vypode_action_outbox_v1 || {}, {});
});

test('Clear All warns about an already-dispatched action and cancels post-click verification', async () => {
  const page = listingPage({ films: [{ slug: 'clear-after-click', title: 'Clear After Click (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 200 ? 20 : ms === 10000 ? 500 : Math.min(ms, 2)
  });
  let confirmation = '';
  window.confirm = message => { confirmation = message; return true; };
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(iframe, actionToggle('watch'));
  const toggle = iframeDocument.querySelector('.action.-watch');
  let remoteClicks = 0;
  toggle.addEventListener('click', () => { remoteClicks++; });
  iframe.onload();
  assert.equal(await waitFor(() => remoteClicks === 1), true);

  await clearAllFromOpenDeck(window);
  assert.match(confirmation, /already been sent to Letterboxd and cannot be recalled/);
  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  toggle.classList.add('-on');
  await tick(80);

  assert.equal(window.VypodeFilmState.get('clear-after-click'), null);
  const carried = Object.values(chrome.storage.local.store.vypode_action_outbox_v1 || {});
  assert.equal(carried.length, 1, 'the already-clicked action remains available for verification-only recovery');
  assert.equal(carried[0].generation, 1);
  assert.ok(carried[0].dispatchedAt);
  assert.equal(carried[0].leaseOwner, null);
});

test('a cross-tab generation clear invalidates a claimed iframe before its delayed click', async () => {
  const page = listingPage({ films: [{ slug: 'cross-tab-clear', title: 'Cross Tab Clear (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 800 ? 100 : ms === 10000 ? 500 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(iframe, actionToggle('watch'));
  let remoteClicks = 0;
  iframeDocument.querySelector('.action.-watch').addEventListener('click', () => { remoteClicks++; });
  iframe.onload();

  const oldValue = clone(chrome.storage.local.store.vypode_state);
  const accountId = oldValue._meta.activeAccount;
  const newValue = {
    _meta: {
      version: 3,
      generation: oldValue._meta.generation + 1,
      activeAccount: accountId,
      updatedAt: new Date().toISOString()
    },
    accounts: {
      [accountId]: { _meta: { version: 3 }, slugs: {} }
    }
  };
  chrome.storage.local.store.vypode_state = clone(newValue);
  chrome.storage.local.store.vypode_action_outbox_v1 = {};
  chrome.emitStorageChange({ vypode_state: { oldValue, newValue } });

  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  await tick(130);
  assert.equal(remoteClicks, 0);
  assert.equal(window.VypodeFilmState.getMeta().rootGeneration, newValue._meta.generation);
  assert.equal(window.VypodeFilmState.get('cross-tab-clear'), null);
});

test('a queued action reads the hidden iframe account instead of trusting the parent document', async () => {
  const page = listingPage({ films: [{ slug: 'wrong-iframe-account', title: 'Wrong Iframe Account (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 300 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(iframe, actionToggle('watch'), 'Bob');
  let remoteClicks = 0;
  iframeDocument.querySelector('.action.-watch').addEventListener('click', () => { remoteClicks++; });
  const before = clone(window.VypodeFilmState.get('wrong-iframe-account'));
  iframe.onload();

  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  assert.equal(remoteClicks, 0);
  assert.equal(window.VypodeFilmState.get('wrong-iframe-account').watchedMutationToken, before.watchedMutationToken);
  assert.equal(Object.keys(chrome.storage.local.store.vypode_action_outbox_v1 || {}).length, 1,
    'suspended work remains durable for the correct account');
});

test('a parent session change before iframe load suspends the queue without clicking', async () => {
  const page = listingPage({ films: [{ slug: 'account-before-load', title: 'Account Before Load (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 300 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(iframe, actionToggle('watch'));
  let remoteClicks = 0;
  iframeDocument.querySelector('.action.-watch').addEventListener('click', () => { remoteClicks++; });
  const before = clone(window.VypodeFilmState.get('account-before-load'));
  replaceSessionHeader(window.document, 'Bob');
  iframe.onload();

  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  assert.equal(remoteClicks, 0);
  assert.equal(window.VypodeFilmState.get('account-before-load').watchedChangedAt, before.watchedChangedAt);
  assert.equal(Object.keys(chrome.storage.local.store.vypode_action_outbox_v1 || {}).length, 1);
});

test('an account change during retry backoff prevents the next attempt', async () => {
  const page = listingPage({ films: [{ slug: 'account-on-retry', title: 'Account On Retry (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 1000 ? 70 : ms === 10000 ? 400 : Math.min(ms, 2)
  });
  assert.equal(await waitFor(() => window.document.querySelector('.vypode-toggle-btn')), true);
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const before = clone(window.VypodeFilmState.get('account-on-retry'));
  window.document.querySelector('iframe').onerror();
  replaceSessionHeader(window.document, 'Bob');
  await tick(100);

  assert.equal(window.document.querySelectorAll('iframe').length, 0);
  assert.equal(window.VypodeFilmState.get('account-on-retry').watchedMutationToken, before.watchedMutationToken);
  assert.equal(Object.keys(chrome.storage.local.store.vypode_action_outbox_v1 || {}).length, 1);
});

test('an account change caused by the remote click blocks post-click local commit', async () => {
  const page = listingPage({ films: [{ slug: 'account-after-click', title: 'Account After Click (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 400 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  const iframe = window.document.querySelector('iframe');
  const iframeDocument = installIframeDocument(iframe, actionToggle('watch'));
  const before = clone(window.VypodeFilmState.get('account-after-click'));
  let remoteClicks = 0;
  iframeDocument.querySelector('.action.-watch').addEventListener('click', event => {
    remoteClicks++;
    replaceSessionHeader(window.document, 'Bob');
    event.currentTarget.classList.add('-on');
  });
  iframe.onload();

  assert.equal(await waitFor(() => remoteClicks === 1), true);
  assert.equal(await waitFor(() => !window.document.contains(iframe)), true);
  assert.equal(window.VypodeFilmState.get('account-after-click').watchedMutationToken, before.watchedMutationToken,
    'post-click verification must not make a second local mutation for the wrong session');
  assert.equal(Object.keys(chrome.storage.local.store.vypode_action_outbox_v1 || {}).length, 1);
});

test('terminal rollback preserves a newer external mutation of the same flag', async () => {
  const page = listingPage({ films: [{ slug: 'newer-same-flag', title: 'Newer Same Flag (2024)' }] });
  const { window, chrome } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } },
    mapTimeout: ms => ms === 10000 ? 100 : Math.min(ms, 2)
  });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');
  assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
  await tick(5);
  window.VypodeFilmState.setFlag('newer-same-flag', 'watched', true, 'userAction', 'newer-external-token');

  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(await waitFor(() => window.document.querySelector('iframe')), true);
    window.document.querySelector('iframe').onerror();
    await tick(4);
  }

  assert.equal(await waitFor(() => Object.keys(chrome.storage.local.store.vypode_action_outbox_v1 || {}).length === 0), true);
  assert.equal(window.VypodeFilmState.get('newer-same-flag').watched, true);
  assert.equal(window.VypodeFilmState.get('newer-same-flag').watchedMutationToken, 'newer-external-token');
});

test('single-film actions commit only after the Letterboxd DOM reaches the requested state', async () => {
  const { window } = await runContent(singleActionPage(), 'https://letterboxd.com/film/action-film/', {
    mapTimeout: ms => ms === 2000 ? 300 : Math.min(ms, 2)
  });
  const toggle = window.document.querySelector('.action.-watch');
  toggle.addEventListener('click', event => event.currentTarget.classList.add('-on'));
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');

  assert.equal(await waitFor(() => window.VypodeFilmState.get('action-film')?.watched === true), true);
});

test('single-film actions do not commit when Letterboxd never confirms the DOM transition', async () => {
  const { window, chrome } = await runContent(singleActionPage(), 'https://letterboxd.com/film/action-film/', {
    mapTimeout: ms => ms === 2000 ? 300 : Math.min(ms, 2)
  });
  let remoteClicks = 0;
  window.document.querySelector('.action.-watch').addEventListener('click', () => { remoteClicks += 1; });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');

  assert.equal(await waitFor(() => /did not confirm/.test(text(window.document, '.vypode-toast')), { timeout: 500 }), true);
  assert.notEqual(window.VypodeFilmState.get('action-film')?.watched, true);
  assert.equal(remoteClicks, 1);
  const pending = Object.values(chrome.storage.local.store.vypode_action_outbox_v1 || {});
  assert.equal(pending.length, 1);
  assert.ok(pending[0].dispatchedAt, 'the uncertain click remains durable for verification-only recovery');

  keydown(window, 'ArrowLeft');
  await tick(30);
  assert.equal(remoteClicks, 1, 'an unconfirmed toggle must never be clicked a second time');
});

test('single-film post-click account changes prevent local state writes', async () => {
  const { window } = await runContent(singleActionPage(), 'https://letterboxd.com/film/action-film/', {
    mapTimeout: ms => ms === 2000 ? 300 : Math.min(ms, 2)
  });
  window.document.querySelector('.action.-watch').addEventListener('click', event => {
    replaceSessionHeader(window.document, 'Bob');
    event.currentTarget.classList.add('-on');
  });
  click(window.document, '.vypode-toggle-btn');
  keydown(window, 'ArrowLeft');

  assert.equal(await waitFor(() => /account changed/.test(text(window.document, '.vypode-toast')), { timeout: 500 }), true);
  assert.notEqual(window.VypodeFilmState.get('action-film')?.watched, true);
});

test('in-place pagination stops when Letterboxd repeats a previously fetched page', async () => {
  const cyclicPage2 = listingPage({
    films: [{ slug: 'page-one-a', title: 'Page One A (2020)' }],
    nextHref: '/films/popular/page/3/'
  });
  const cyclicPage3 = listingPage({
    films: [{ slug: 'page-one-b', title: 'Page One B (2021)' }],
    nextHref: '/films/popular/page/2/'
  });
  const { window, calls } = await runContent(firstPage, firstPageUrl, {
    pageHtmlByPath: {
      '/films/popular/page/2/': cyclicPage2,
      '/films/popular/page/3/': cyclicPage3
    }
  });
  await openTwoFilmDeck(window);
  await exhaustWithNextButtons(window);
  await tick(20);

  const listingCalls = calls.map(href => new NativeURL(href, firstPageUrl).pathname)
    .filter(pathname => pathname.startsWith('/films/popular/page/'));
  assert.deepEqual(listingCalls, ['/films/popular/page/2/', '/films/popular/page/3/']);
  assert.equal(window.location.href, firstPageUrl);
});

test('visible deck controls share the strict dispatcher and disable during a transition', async () => {
  const { window } = await runContent(firstPage, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false, excludeLiked: false, excludeWatchlist: false } }
  });
  await openTwoFilmDeck(window);
  const controls = Array.from(window.document.querySelectorAll('.vypode-action-control'));
  assert.deepEqual(controls.map(button => button.dataset.action), ['watch', 'like', 'watchlist', 'skip']);
  assert.deepEqual(controls.map(button => button.getAttribute('type')), ['button', 'button', 'button', 'button']);
  assert.deepEqual(controls.map(button => button.getAttribute('aria-keyshortcuts')),
    ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);

  const watch = controls[0];
  watch.dataset.action = 'delete';
  watch.click();
  assert.match(text(window.document, '.vypode-toast'), /Unsupported film action/);
  assert.notEqual(window.VypodeFilmState.get('page-one-a')?.watched, true);
  assert.equal(window.document.querySelectorAll('iframe').length, 0);
  watch.dataset.action = 'watch';

  controls[3].click();
  assert.equal(controls.every(button => button.disabled), true, 'all action controls lock while the card changes');
  assert.equal(window.VypodeFilmState.get('page-one-a')?.skipped, true);
});

test('signed-out decks guard account actions while keeping Skip local and available', async () => {
  const page = listingPage({
    signedIn: false,
    films: [{ slug: 'signed-out-skip', title: 'Signed Out Skip (2024)' }]
  });
  const { window } = await runContent(page, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false, excludeLiked: false, excludeWatchlist: false } }
  });
  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('.vypode-action-control')), true);
  const accountControls = Array.from(window.document.querySelectorAll(
    '.vypode-action-control[data-action="watch"], .vypode-action-control[data-action="like"], .vypode-action-control[data-action="watchlist"]'
  ));
  const skip = window.document.querySelector('.vypode-action-control[data-action="skip"]');
  assert.equal(accountControls.every(button => button.disabled), true);
  assert.equal(skip.disabled, false);

  accountControls[0].click();
  assert.equal(window.document.querySelectorAll('iframe').length, 0);
  skip.click();
  assert.equal(window.VypodeFilmState.get('signed-out-skip')?.skipped, true);
});

test('filtering every film renders a stable empty deck and keyboard actions stay inert', async () => {
  const { window } = await runContent(firstPage, firstPageUrl, {
    sync: { vypode_prefs: { excludeWatched: false } }
  });
  await openTwoFilmDeck(window);
  window.VypodeFilmState.setFlag('page-one-a', 'watched', true, 'userAction');
  window.VypodeFilmState.setFlag('page-one-b', 'watched', true, 'userAction');
  click(window.document, '#vypodeOpenSettings');
  const toggle = window.document.querySelector('input[data-pref="excludeWatched"]');
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.equal(await waitFor(() => window.document.querySelector('.vypode-deck-counter')?.textContent === '0 / 0'), true);
  assert.equal(window.document.querySelector('.vypode-deck-counter')?.textContent, '0 / 0');
  assert.match(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent || '', /No films match/);
  assert.equal(window.document.querySelector('#vypodeOpenReview')?.disabled, true);
  assert.equal(Array.from(window.document.querySelectorAll('.vypode-action-control')).every(button => button.disabled), true);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) keydown(window, key);
  assert.equal(window.document.querySelectorAll('iframe').length, 0);
});

test('a page that starts fully filtered opens a recoverable deck with Settings and Next', async () => {
  const { window } = await runContent(firstPage, firstPageUrl, {
    local: {
      vypode_state: registry({
        'page-one-a': { watched: true },
        'page-one-b': { watched: true }
      })
    },
    sync: { vypode_prefs: { excludeWatched: true } }
  });

  click(window.document, '.vypode-toggle-btn');
  assert.equal(await waitFor(() => window.document.querySelector('.vypode-overlay')), true);
  assert.equal(window.document.querySelector('.vypode-deck-counter')?.textContent, '0 / 0');
  assert.match(
    window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent || '',
    /hidden by your filters/
  );
  assert.equal(window.document.querySelector('#vypodeOpenReview')?.disabled, true);
  assert.equal(window.document.querySelector('#vypodeNext')?.disabled, false);

  click(window.document, '#vypodeOpenSettings');
  assert.ok(window.document.querySelector('.vypode-settings-panel'));
  const watchedToggle = window.document.querySelector('input[data-pref="excludeWatched"]');
  watchedToggle.checked = false;
  watchedToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(await waitFor(() => /Page One A/.test(
    window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent || ''
  )), true);
  assert.match(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent || '', /Page One A/);
  assert.equal(window.document.querySelector('#vypodeOpenReview')?.disabled, false);
  assert.equal(window.document.querySelector('#vypodeNext')?.disabled, false);
  click(window.document, '#vypodeSettingsClose');
  await tick(5);
  click(window.document, '#vypodeOpenReview');
  assert.ok(window.document.querySelector('.vypode-review-panel'));
  assert.equal(window.document.querySelectorAll('iframe').length, 0);
});

test('card metadata clears genres when the next film has none', async () => {
  const { window } = await runContent(firstPage, firstPageUrl);
  await openTwoFilmDeck(window);
  const genres = window.document.querySelector('#vypodeCard .vypode-card-genres');
  genres.innerHTML = '<span>Drama</span>';
  click(window.document, '#vypodeNext');
  assert.equal(genres.textContent, '');
});

test('deck shortcuts ignore browser modifiers, repeat, composition, shifted arrows, and inputs', async () => {
  const { window } = await runContent(firstPage, firstPageUrl);
  await openTwoFilmDeck(window);
  const initialTitle = window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent;
  const events = [
    keydown(window, 'r', { metaKey: true }),
    keydown(window, 's', { ctrlKey: true }),
    keydown(window, 'ArrowLeft', { altKey: true }),
    keydown(window, 'ArrowDown', { repeat: true }),
    keydown(window, 'ArrowUp', { isComposing: true }),
    keydown(window, 'ArrowRight', { shiftKey: true })
  ];
  const input = window.document.createElement('input');
  window.document.body.appendChild(input);
  events.push(keydown(window, 'ArrowDown', { target: input }));

  assert.equal(window.document.querySelector('.vypode-review-panel'), null);
  assert.equal(window.document.querySelector('.vypode-settings-panel'), null);
  assert.equal(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent, initialTitle);
  assert.equal(window.document.querySelectorAll('iframe').length, 0);
  assert.equal(events.every(event => event.defaultPrevented === false), true);
});

test('disabled autoNextPage preserves v6.2 in-place next-page loading', async () => {
  const { window, calls } = await runContent(firstPage, firstPageUrl, { page2Html: secondPage });
  await openTwoFilmDeck(window);
  await exhaustWithNextButtons(window);

  assert.equal(await waitFor(() => calls.some(url => new NativeURL(url, firstPageUrl).pathname === '/films/popular/page/2/')), true);
  assert.equal(await waitFor(() => window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent === 'Page Two Film (2024)'), true);
  assert.equal(window.location.href, firstPageUrl);
});

test('an HTTP-200 dynamic listing shell falls back to real page navigation', async () => {
  const dynamicShell = '<html><body><div data-src="/csi/films/films-browser-list/"></div></body></html>';
  const { window, calls } = await runContent(firstPage, firstPageUrl, { page2Html: dynamicShell });
  await openTwoFilmDeck(window);
  await exhaustWithNextButtons(window);

  assert.equal(calls.some(url => new NativeURL(url, firstPageUrl).pathname === '/films/popular/page/2/'), true);
  assert.equal(await waitFor(() => window.location.pathname === '/films/popular/page/2/'), true);
  assert.equal(window.location.hash, '#vypode-auto');
});

test('autoNextPage recognizes head, nested, and cursor pagination markup', async () => {
  const cases = [
    {
      page: listingPage({
        films: [
          { slug: 'head-a', title: 'Head A (2020)' },
          { slug: 'head-b', title: 'Head B (2021)' }
        ],
        headHtml: '<link rel="next" href="?cursor=head-token">',
        paginationHtml: ''
      }),
      expected: 'https://letterboxd.com/films/popular/?cursor=head-token#vypode-auto'
    },
    {
      page: listingPage({
        films: [
          { slug: 'nested-a', title: 'Nested A (2020)' },
          { slug: 'nested-b', title: 'Nested B (2021)' }
        ],
        paginationHtml: '<div class="paginate-nextprev"><span class="next"><a href="?cursor=nested-token">Next</a></span></div>'
      }),
      expected: 'https://letterboxd.com/films/popular/?cursor=nested-token#vypode-auto'
    },
    {
      page: listingPage({
        films: [
          { slug: 'cursor-a', title: 'Cursor A (2020)' },
          { slug: 'cursor-b', title: 'Cursor B (2021)' }
        ],
        paginationHtml: '<nav aria-label="Pagination"><a href="?cursor=structural-token">Next page</a></nav>'
      }),
      expected: 'https://letterboxd.com/films/popular/?cursor=structural-token#vypode-auto'
    }
  ];

  for (const { page, expected } of cases) {
    const { window } = await runContent(page, firstPageUrl, {
      sync: { vypode_prefs: { autoNextPage: true } }
    });
    await openTwoFilmDeck(window);
    await exhaustWithNextButtons(window);
    assert.equal(window.location.href, expected);
  }
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
