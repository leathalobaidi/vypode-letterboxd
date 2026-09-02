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
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
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

function listingPage() {
  return `<html><body>${signedInHeader()}
    <ul class="poster-list">
      ${poster('colony-2026', 'Colony (2026)')}
      ${poster('world-war-z', 'World War Z (2013)')}
    </ul>
  </body></html>`;
}

function singleFilmPage(username = 'BusyBees1') {
  return `<html><body>${signedInHeader(username)}
    <h1 class="headline-1">World War Z</h1>
    <p class="releaseyear"><a>2013</a></p>
    <div class="film-poster"><img src="https://img.test/world-war-z.jpg"></div>
    <p class="contributor"><a>Marc Forster</a></p>
    <a class="action -watch" href="#">Watch</a>
    <a class="action -like" href="#">Like</a>
    <a class="action -watchlist" href="#">Watchlist</a>
  </body></html>`;
}

function fetchedFilmPage(username = 'BusyBees1') {
  return `<html><body>${signedInHeader(username)}
    <h1 class="headline-1">Film</h1>
    <p class="releaseyear"><a>2026</a></p>
    <div class="film-poster"><img src="https://img.test/detail.jpg"></div>
    <a href="/film/colony-2026/trailer/">Trailer</a>
  </body></html>`;
}

class FakeSpeechRecognition {
  static instances = [];

  constructor() {
    this.startCalls = 0;
    this.stopCalls = 0;
    this.abortCalls = 0;
    FakeSpeechRecognition.instances.push(this);
  }

  start() { this.startCalls += 1; }
  stop() { this.stopCalls += 1; }
  abort() { this.abortCalls += 1; }

  emitStart() { this.onstart?.({}); }
  emitEnd() { this.onend?.({}); }
  emitError(error) { this.onerror?.({ error }); }
  emitFinal(transcript) {
    const result = [{ transcript }];
    result.isFinal = true;
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

function installGlobals(window, url, chrome, { speechRecognition } = {}) {
  Object.defineProperty(window, 'location', { value: new NativeURL(url), configurable: true });
  window.chrome = chrome;
  window.vypodeInjected = false;
  window.console = console;
  window.confirm = () => true;
  window.DOMParser = class {
    parseFromString(html) { return parseHTML(html).document; }
  };
  window.Image = class {
    set src(value) { this._src = value; }
    get src() { return this._src; }
  };
  window.Blob = globalThis.Blob;
  window.URL = NativeURL;
  window.URL.createObjectURL = () => 'blob:vypode-test';
  window.URL.revokeObjectURL = () => {};
  window.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, ms >= 1000 ? 20 : ms, ...args);
  window.clearTimeout = nativeClearTimeout;
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
  if (speechRecognition) {
    window.SpeechRecognition = speechRecognition;
    window.webkitSpeechRecognition = speechRecognition;
  }
}

async function runContent(html, url, {
  speechRecognition,
  filmDetailHtml = fetchedFilmPage(),
  failFilmFetch = false,
  brave = false,
  platform = '',
  local = {},
  sync = {},
  reviewPostBody = null,
  reviewPostStatus = 200,
  reviewFetch = null,
  contentFetch = null,
  filmJson = {},
  diaryHtml = null,
  runtimeSendMessage = null
} = {}) {
  const { window: domWindow } = parseHTML(html);
  const stableNavigator = {
    ...domWindow.navigator,
    language: domWindow.navigator.language || 'en-GB',
    platform: platform || domWindow.navigator.platform || ''
  };
  if (brave) stableNavigator.brave = { isBrave: async () => true };
  let window;
  window = new Proxy(domWindow, {
    get(target, property, receiver) {
      if (property === 'navigator') return stableNavigator;
      if (property === 'window' || property === 'self' || property === 'globalThis') return window;
      return Reflect.get(target, property, receiver);
    }
  });
  const runtimeMessages = [];
  const fetchCalls = [];
  const localArea = storageArea(local);
  const syncArea = storageArea(sync);
  const backgroundListeners = [];
  const workerFetch = async (requestUrl, options = {}) => {
    const requestHref = String(requestUrl);
    fetchCalls.push({ url: requestHref, options, source: 'worker' });
    if (typeof reviewFetch === 'function') return await reviewFetch(requestHref, options);
    const body = reviewPostBody === null ? filmDetailHtml : reviewPostBody;
    return {
      ok: reviewPostStatus >= 200 && reviewPostStatus < 300,
      status: reviewPostStatus,
      headers: { get: () => null },
      text: async () => typeof body === 'string' ? body : JSON.stringify(body)
    };
  };
  const workerContext = {
    console,
    URL: NativeURL,
    AbortController,
    setTimeout: nativeSetTimeout,
    clearTimeout: nativeClearTimeout,
    fetch: workerFetch,
    chrome: {
      storage: { local: localArea },
      runtime: {
        lastError: null,
        onMessage: { addListener(listener) { backgroundListeners.push(listener); } }
      }
    }
  };
  vm.createContext(workerContext);
  vm.runInContext(backgroundSource, workerContext, { filename: 'background.js' });
  const dispatchBackground = message => new Promise(resolve => {
    let settled = false;
    const sendResponse = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const handled = backgroundListeners.some(listener =>
      listener(message, { frameId: 0, tab: { url } }, sendResponse) === true
    );
    if (!handled && !settled) resolve(undefined);
  });
  const contentMessageListeners = [];
  const chrome = {
    storage: { local: localArea, sync: syncArea },
    runtime: {
      sendMessage(message) {
        runtimeMessages.push(clone(message));
        if (typeof runtimeSendMessage === 'function') {
          const custom = runtimeSendMessage(message);
          if (custom !== undefined) return custom;
        }
        return dispatchBackground(message);
      },
      lastError: null,
      onMessage: { addListener(listener) { contentMessageListeners.push(listener); } }
    }
  };
  window.fetch = async (requestUrl, options = {}) => {
    const requestHref = String(requestUrl);
    fetchCalls.push({ url: requestHref, options });
    if (typeof contentFetch === 'function') {
      const response = await contentFetch(requestHref, options);
      if (response !== undefined) return response;
    }
    if (failFilmFetch && !options.method) throw new Error('offline');
    if (new NativeURL(requestHref, url).pathname.endsWith('/json/')) {
      const body = { csrf: 'csrf-token', lid: 'film-lid', ...filmJson };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
        json: async () => body
      };
    }
    if (diaryHtml !== null && new NativeURL(requestHref, url).pathname === '/BusyBees1/diary/') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => diaryHtml,
        json: async () => ({})
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => filmDetailHtml,
      json: async () => ({ csrf: 'csrf-token', lid: 'film-lid' })
    };
  };
  installGlobals(window, url, chrome, { speechRecognition });
  vm.createContext(window);
  vm.runInContext(filmStateSource, window, { filename: 'film-state.js' });
  vm.runInContext(contentSource, window, { filename: 'content.js' });
  const initDeadline = Date.now() + 1000;
  while (!window.document.querySelector('.vypode-toggle-btn') && Date.now() < initDeadline) {
    await tick(5);
  }
  return { window, chrome, fetchCalls, runtimeMessages };
}

function registry(slugs) {
  return { _meta: { version: 2 }, slugs };
}

function diaryPage(slug) {
  return `<html><body>${signedInHeader()}
    <table><tr class="diary-entry-row">
      <td><div class="react-component" data-item-slug="${slug}" data-item-link="/film/${slug}/">
        <a href="/film/${slug}/">Film</a>
      </div></td>
    </tr></table>
  </body></html>`;
}

function tick(ms = 5) {
  return new Promise(resolve => nativeSetTimeout(resolve, ms));
}

function click(document, selector) {
  const element = document.querySelector(selector);
  assert.ok(element, `${selector} should exist`);
  element.click();
  return element;
}

function setControl(window, selector, value, eventType = 'input') {
  const control = window.document.querySelector(selector);
  assert.ok(control, `${selector} should exist`);
  if (control.type === 'checkbox') control.checked = Boolean(value);
  else if (control.tagName === 'SELECT') {
    const options = Array.from(control.options || []);
    const selectedIndex = options.findIndex(option => option.value === value);
    assert.notEqual(selectedIndex, -1, `${selector} should include option ${value}`);
    control.selectedIndex = selectedIndex;
    options.forEach((option, index) => {
      if (index === selectedIndex) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    });
  } else control.value = value;
  control.dispatchEvent(new window.Event(eventType, { bubbles: true }));
  return control;
}

function keydown(window, key, options = {}) {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    metaKey: { value: Boolean(options.metaKey) },
    ctrlKey: { value: Boolean(options.ctrlKey) },
    altKey: { value: Boolean(options.altKey) },
    shiftKey: { value: Boolean(options.shiftKey) },
    repeat: { value: Boolean(options.repeat) }
  });
  window.document.dispatchEvent(event);
  return event;
}

async function openDeck(window) {
  click(window.document, '.vypode-toggle-btn');
  await tick(20);
  assert.ok(window.document.querySelector('#vypodeCard'));
}

test('T and the visible trailer link activate the current film without advancing or mutating it', async () => {
  const { window } = await runContent(
    listingPage(),
    'https://letterboxd.com/films/popular/'
  );
  await openDeck(window);

  const initialTitle = window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent;
  const initialCounter = window.document.querySelector('.vypode-deck-counter')?.textContent;
  const initialRegistry = JSON.stringify(window.VypodeFilmState.getAll());
  const trailerLink = window.document.querySelector('#vypodeTrailerLink.vypode-trailer-btn');
  assert.ok(trailerLink, 'a visible trailer link should make the shortcut discoverable');
  assert.equal(trailerLink.tagName, 'A');
  assert.equal(trailerLink.href, 'https://letterboxd.com/film/colony-2026/trailer/');
  assert.equal(trailerLink.target, '_blank');
  assert.match(trailerLink.rel, /noopener/);

  let activations = 0;
  trailerLink.addEventListener('click', event => {
    event.preventDefault();
    activations += 1;
  });

  const t = keydown(window, 't');
  assert.equal(t.defaultPrevented, true);
  assert.equal(activations, 1);
  assert.equal(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent, initialTitle);
  assert.equal(window.document.querySelector('.vypode-deck-counter')?.textContent, initialCounter);
  assert.equal(JSON.stringify(window.VypodeFilmState.getAll()), initialRegistry);

  assert.match(trailerLink.textContent, /trailer/i);
  trailerLink.click();
  assert.equal(activations, 2);
});

test('trailer controls follow the current deck card', async () => {
  const deck = await runContent(listingPage(), 'https://letterboxd.com/films/popular/');
  await openDeck(deck.window);
  click(deck.window.document, '#vypodeNext');
  await tick(10);
  const trailerLink = deck.window.document.querySelector('#vypodeTrailerLink');
  assert.equal(trailerLink?.href, 'https://letterboxd.com/film/world-war-z/trailer/');
  let activations = 0;
  trailerLink.addEventListener('click', event => {
    event.preventDefault();
    activations += 1;
  });
  keydown(deck.window, 'T');
  assert.equal(activations, 1);
});

test('a film page with no trailer disables the trailer shortcut', async () => {
  const noTrailerHtml = `<html><body>${signedInHeader()}
    <h1 class="headline-1">Film without trailer</h1>
    <p class="releaseyear"><a>2026</a></p>
  </body></html>`;
  const { window } = await runContent(
    listingPage(),
    'https://letterboxd.com/films/popular/',
    { filmDetailHtml: noTrailerHtml }
  );
  await openDeck(window);
  await tick(20);

  const trailerLink = window.document.querySelector('#vypodeTrailerLink');
  assert.ok(trailerLink);
  assert.equal(
    trailerLink.getAttribute('aria-disabled') === 'true' ||
      trailerLink.classList.contains('disabled') ||
      !trailerLink.getAttribute('href'),
    true,
    'definitively missing trailers should be exposed as disabled'
  );
  assert.equal(trailerLink.getAttribute('tabindex'), '0',
    'the unavailable explanation should remain keyboard reachable');
  let activations = 0;
  trailerLink.addEventListener('click', event => {
    event.preventDefault();
    activations += 1;
  });
  keydown(window, 't');
  assert.equal(activations, 0);
  const feedback = window.document.querySelector('.vypode-toast');
  assert.equal(feedback?.getAttribute('role'), 'alert');
  assert.match(feedback?.textContent || '', /no trailer/i);
});

test('an unavailable metadata request keeps the deterministic trailer route usable', async () => {
  const { window } = await runContent(
    listingPage(),
    'https://letterboxd.com/films/popular/',
    { failFilmFetch: true }
  );
  await openDeck(window);
  await tick(20);

  const trailerLink = window.document.querySelector('#vypodeTrailerLink');
  assert.equal(trailerLink?.href, 'https://letterboxd.com/film/colony-2026/trailer/');
  assert.notEqual(trailerLink?.getAttribute('aria-disabled'), 'true');
  let activations = 0;
  trailerLink.addEventListener('click', event => {
    event.preventDefault();
    activations += 1;
  });
  keydown(window, 't');
  assert.equal(activations, 1);
});

test('an invalid film slug cannot create or activate a trailer URL', async () => {
  const malformedPage = `<html><body>${signedInHeader()}
    <ul class="poster-list">${poster('world-war-z%2F..%2Faccount', 'Malformed')}</ul>
  </body></html>`;
  const { window } = await runContent(
    malformedPage,
    'https://letterboxd.com/films/popular/'
  );
  click(window.document, '.vypode-toggle-btn');
  await tick(20);

  const trailerLink = window.document.querySelector('#vypodeTrailerLink');
  assert.equal(window.document.querySelector('#vypodeCard'), null,
    'a malformed listing record must be rejected rather than rendered');
  assert.equal(Boolean(trailerLink?.getAttribute('href')), false);
  let activations = 0;
  trailerLink?.addEventListener('click', event => {
    event.preventDefault();
    activations += 1;
  });
  keydown(window, 't');
  assert.equal(activations, 0);
});

test('T does not hijack browser shortcuts, repeats, or panel input', async () => {
  const { window } = await runContent(
    listingPage(),
    'https://letterboxd.com/films/popular/'
  );
  await openDeck(window);
  const trailerLink = window.document.querySelector('#vypodeTrailerLink');
  let activations = 0;
  trailerLink.addEventListener('click', event => {
    event.preventDefault();
    activations += 1;
  });

  keydown(window, 't', { metaKey: true });
  keydown(window, 't', { ctrlKey: true });
  keydown(window, 't', { altKey: true });
  keydown(window, 't', { repeat: true });
  assert.equal(activations, 0);

  click(window.document, '#vypodeOpenReview');
  await tick(5);
  keydown(window, 't');
  assert.equal(activations, 0, 'typing in the review flow must not open a trailer');
  click(window.document, '#vypodeReviewCancel');
  await tick(5);

  click(window.document, '#vypodeOpenSettings');
  await tick(5);
  keydown(window, 't');
  assert.equal(activations, 0, 'settings shortcuts must stay isolated');
});

test('an unconfirmed HTTP-200 review response keeps the durable draft and does not mutate film state', async () => {
  const { window, chrome } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { diaryHtml: diaryPage('world-war-z') }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  const textarea = window.document.querySelector('#vypodeReviewText');
  textarea.value = 'Keep this draft until success is proven';
  click(window.document, '#vypodeReviewSubmit');
  await tick(50);

  assert.ok(window.document.querySelector('.vypode-review-panel'), 'the review editor should remain mounted');
  assert.equal(window.document.querySelector('#vypodeReviewText')?.value, 'Keep this draft until success is proven');
  assert.notEqual(window.VypodeFilmState.get('world-war-z')?.reviewText, 'Keep this draft until success is proven');
  assert.equal(Boolean(window.VypodeFilmState.get('world-war-z')?.watched), false);
  assert.equal(window.document.querySelector('#vypodeReviewSubmit')?.disabled, false);
  assert.equal(
    chrome.storage.local.store.vypode_review_drafts_v1?.['user:busybees1']?.['world-war-z']?.reviewText,
    'Keep this draft until success is proven'
  );

  const reloaded = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { local: clone(chrome.storage.local.store) }
  );
  click(reloaded.window.document, '.vypode-toggle-btn');
  click(reloaded.window.document, '#vypodeOpenReview');
  await tick(30);
  assert.equal(reloaded.window.document.querySelector('#vypodeReviewText')?.value, 'Keep this draft until success is proven');
});

test('a verified production-log response submits a review and records its local diary date', async () => {
  const today = new Date();
  const watchedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { window, chrome, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      reviewPostBody: {
        logEntry: {
          id: 'entry-123',
          review: { text: 'Verified production-log review' },
          rating: 4,
          diaryDetails: { diaryDate: watchedDate, rewatch: false },
          like: false
        }
      }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  click(window.document, '[data-rating="4"]');
  window.document.querySelector('#vypodeReviewText').value = 'Verified production-log review';
  click(window.document, '#vypodeReviewSubmit');
  await tick(50);

  const state = window.VypodeFilmState.get('world-war-z');
  const post = fetchCalls.find(call => call.options?.method === 'POST');
  assert.equal(post.url, 'https://api.letterboxd.com/api/v0/production-log-entries');
  assert.equal(post.options.credentials, 'include');
  assert.deepEqual(JSON.parse(post.options.body).diaryDetails, { diaryDate: watchedDate, rewatch: false });
  assert.equal(state.reviewText, 'Verified production-log review');
  assert.equal(state.ratingValue, 4);
  assert.equal(state.watched, true);
  assert.equal(state.watchedDate, watchedDate);
  assert.equal(state.watchedAt, null);
  assert.equal(window.document.querySelector('.vypode-review-panel')?.classList.contains('visible'), false);
});

test('a review can be submitted immediately after clearing local film data', async () => {
  const today = new Date();
  const watchedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { window, chrome, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      reviewPostBody: {
        logEntry: {
          id: 'entry-after-clear',
          review: { text: 'Review after clearing local data' },
          rating: 4,
          diaryDetails: { diaryDate: watchedDate, rewatch: false },
          like: false
        }
      }
    }
  );

  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenSettings');
  click(window.document, '#vypodeClearAll');
  await tick(30);
  assert.equal(chrome.storage.local.store.vypode_state._meta.activeAccount, '$legacy');
  assert.equal(window.VypodeFilmState.getAccountId(), '$legacy',
    'the clearing tab must also forget its cached account identity');

  click(window.document, '#vypodeSettingsClose');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  click(window.document, '[data-rating="4"]');
  setControl(window, '#vypodeReviewText', 'Review after clearing local data');
  click(window.document, '#vypodeReviewSubmit');
  await tick(80);

  const post = fetchCalls.find(call => call.options?.method === 'POST');
  assert.ok(post, 'the review should reach Letterboxd without a page refresh');
  assert.equal(chrome.storage.local.store.vypode_state._meta.activeAccount, 'user:busybees1');
  assert.equal(chrome.storage.local.store.vypode_user?.username, 'BusyBees1');
  assert.equal(chrome.storage.local.store.vypode_user?.active, true,
    'fresh session verification should restore the popup login state after Clear All');
  assert.equal(window.VypodeFilmState.get('world-war-z').reviewText, 'Review after clearing local data');

  const { window: popupDomWindow } = parseHTML(popupHtml);
  let popupWindow;
  popupWindow = new Proxy(popupDomWindow, {
    get(target, property, receiver) {
      if (property === 'window' || property === 'self' || property === 'globalThis') return popupWindow;
      return Reflect.get(target, property, receiver);
    }
  });
  chrome.storage.onChanged = { addListener() {} };
  chrome.tabs = {
    query(_query, callback) { callback([{ id: 1, url: 'https://letterboxd.com/film/world-war-z/' }]); },
    sendMessage() {
      return Promise.resolve({
        ok: true,
        supported: true,
        capabilities: { resumeSwipe: true, syncNow: true, openSettings: true }
      });
    }
  };
  popupWindow.chrome = chrome;
  popupWindow.URL = NativeURL;
  popupWindow.setTimeout = nativeSetTimeout;
  popupWindow.clearTimeout = nativeClearTimeout;
  vm.createContext(popupWindow);
  vm.runInContext(popupSource, popupWindow, { filename: 'popup.js' });
  await tick(20);
  assert.equal(popupWindow.document.querySelector('#syncNowBtn').disabled, false,
    'the popup should recognise the freshly verified session without a page reload');
});

test('a stale tab cannot reclaim cleared state or submit through a different current session', async () => {
  const today = new Date();
  const watchedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { window, chrome, fetchCalls } = await runContent(
    singleFilmPage('BusyBees1'),
    'https://letterboxd.com/film/world-war-z/',
    {
      filmDetailHtml: fetchedFilmPage('DifferentUser'),
      reviewPostBody: {
        logEntry: {
          id: 'must-not-submit',
          review: { text: 'Wrong account' },
          rating: 4,
          diaryDetails: { diaryDate: watchedDate, rewatch: false },
          like: false
        }
      }
    }
  );

  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenSettings');
  click(window.document, '#vypodeClearAll');
  await tick(30);
  click(window.document, '#vypodeSettingsClose');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  click(window.document, '[data-rating="4"]');
  setControl(window, '#vypodeReviewText', 'Wrong account');
  click(window.document, '#vypodeReviewSubmit');
  await tick(100);

  assert.equal(fetchCalls.some(call => call.source === 'worker'), false,
    'the production-log POST must not run when a fresh page belongs to another account');
  assert.equal(chrome.storage.local.store.vypode_state._meta.activeAccount, '$legacy');
  assert.equal(chrome.storage.local.store.vypode_user?.username, 'DifferentUser');
  assert.equal(chrome.storage.local.store.vypode_user?.active, false);
  assert.match(window.document.body.textContent, /account changed|different Letterboxd account|refresh/i);
});

test('an account switch between film data and fresh identity verification blocks the review POST', async () => {
  const today = new Date();
  const watchedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let currentSession = 'BusyBees1';
  const response = body => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body
  });
  const { window, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      contentFetch: async requestUrl => {
        const pathname = new NativeURL(requestUrl).pathname;
        if (pathname.endsWith('/json/')) {
          currentSession = 'DifferentUser';
          return response(JSON.stringify({ csrf: 'different-user-token', lid: 'film-lid' }));
        }
        if (pathname === '/film/world-war-z/') return response(fetchedFilmPage(currentSession));
        return undefined;
      },
      reviewPostBody: {
        logEntry: {
          id: 'must-not-submit-after-switch',
          review: { text: 'Wrong session race' },
          rating: 4,
          diaryDetails: { diaryDate: watchedDate, rewatch: false },
          like: false
        }
      }
    }
  );

  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  click(window.document, '[data-rating="4"]');
  setControl(window, '#vypodeReviewText', 'Wrong session race');
  click(window.document, '#vypodeReviewSubmit');
  await tick(100);

  assert.equal(fetchCalls.some(call => call.source === 'worker'), false);
  assert.match(window.document.body.textContent, /different|account|refresh/i);
});

test('failed fresh identity verification deactivates the popup session and keeps the draft', async () => {
  const { window, chrome, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      filmDetailHtml: fetchedFilmPage('DifferentUser'),
      local: {
        vypode_user: { username: 'BusyBees1', active: true },
        vypode_state: {
          _meta: { version: 3, generation: 0, activeAccount: 'user:busybees1' },
          accounts: {
            'user:busybees1': { _meta: { version: 3 }, slugs: {} }
          }
        }
      }
    }
  );

  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Keep this account-bound draft');
  click(window.document, '#vypodeReviewSubmit');
  await tick(100);

  assert.equal(fetchCalls.some(call => call.source === 'worker'), false);
  assert.equal(chrome.storage.local.store.vypode_user?.active, false);
  assert.equal(
    chrome.storage.local.store.vypode_review_drafts_v1?.['user:busybees1']?.['world-war-z']?.reviewText,
    'Keep this account-bound draft'
  );
});

test('an unavailable fresh identity check after Clear All keeps legacy state and the draft', async () => {
  const jsonResponse = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ csrf: 'session-token', lid: 'film-lid' })
  };
  const { window, chrome, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      contentFetch: async requestUrl => {
        const pathname = new NativeURL(requestUrl).pathname;
        if (pathname.endsWith('/json/')) return jsonResponse;
        if (pathname === '/film/world-war-z/') throw new Error('verification offline');
        return undefined;
      }
    }
  );

  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenSettings');
  click(window.document, '#vypodeClearAll');
  await tick(30);
  click(window.document, '#vypodeSettingsClose');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Keep this offline draft');
  click(window.document, '#vypodeReviewSubmit');
  await tick(100);

  assert.equal(fetchCalls.some(call => call.source === 'worker'), false);
  assert.equal(window.VypodeFilmState.getAccountId(), '$legacy');
  assert.equal(chrome.storage.local.store.vypode_state._meta.activeAccount, '$legacy');
  assert.equal(
    chrome.storage.local.store.vypode_review_drafts_v1?.['user:busybees1']?.['world-war-z']?.reviewText,
    'Keep this offline draft'
  );
  assert.match(window.document.body.textContent, /verification offline|try again/i);
});

test('account actions stay blocked in the legacy clear state until review verification relinks it', async () => {
  const { window, runtimeMessages } = await runContent(
    listingPage(),
    'https://letterboxd.com/films/popular/'
  );
  click(window.document, '.vypode-toggle-btn');
  await tick(20);
  click(window.document, '#vypodeOpenSettings');
  click(window.document, '#vypodeClearAll');
  await tick(30);
  click(window.document, '#vypodeSettingsClose');
  const messageCountAfterClear = runtimeMessages.length;

  keydown(window, 'ArrowLeft');
  await tick(40);

  assert.equal(window.VypodeFilmState.getAccountId(), '$legacy');
  assert.notEqual(window.VypodeFilmState.get('colony-2026')?.watched, true);
  assert.equal(runtimeMessages.slice(messageCountAfterClear).some(message =>
    message.action === 'outboxUpsert' ||
    (message.action === 'mergeAccount' && message.data.accountId === 'user:busybees1')
  ), false);
  assert.match(window.document.body.textContent, /log in|refresh/i);
});

test('reviewing a liked film preserves its like in the submitted entry and local state', async () => {
  const today = new Date();
  const watchedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { window, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      local: { vypode_state: registry({ 'world-war-z': { liked: true, source: 'userAction' } }) },
      filmJson: { viewerState: { liked: true } },
      reviewPostBody: {
        logEntry: {
          id: 'entry-liked',
          review: { text: 'Still liked after review' },
          diaryDetails: { diaryDate: watchedDate, rewatch: false },
          like: true
        }
      }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  window.document.querySelector('#vypodeReviewText').value = 'Still liked after review';
  click(window.document, '#vypodeReviewSubmit');
  await tick(50);

  const post = fetchCalls.find(call => call.options?.method === 'POST');
  assert.equal(JSON.parse(post.options.body).like, true);
  assert.equal(window.VypodeFilmState.get('world-war-z').liked, true);
});

test('an explicit remote unlike state wins over a stale locally cached like', async () => {
  const today = new Date();
  const watchedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { window, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      local: { vypode_state: registry({ 'world-war-z': { liked: true, source: 'userAction' } }) },
      filmJson: { viewerState: { liked: false } },
      reviewPostBody: {
        logEntry: {
          id: 'entry-explicit-unlike',
          review: { text: 'Remote false is authoritative' },
          diaryDetails: { diaryDate: watchedDate, rewatch: false },
          like: false
        }
      }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Remote false is authoritative');
  click(window.document, '#vypodeReviewSubmit');
  await tick(70);

  const post = fetchCalls.find(call => call.source === 'worker');
  assert.equal(JSON.parse(post.options.body).like, false);
  assert.equal(window.VypodeFilmState.get('world-war-z').liked, false);
});

test('preserve-like blocks submission when neither Letterboxd nor local provenance proves the state', async () => {
  const { window, fetchCalls } = await runContent(listingPage(), 'https://letterboxd.com/films/popular/');
  await openDeck(window);
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Do not guess my like state');
  click(window.document, '#vypodeReviewSubmit');
  await tick(60);

  assert.equal(fetchCalls.some(call => call.source === 'worker'), false);
  assert.match(window.document.querySelector('#vypodeDraftStatus')?.textContent || '', /choose.*like/i);
  assert.ok(window.document.querySelector('.vypode-review-panel'));
  click(window.document, '#vypodeReviewClose');
  await tick(30);
});

test('known diary entries cannot accidentally create another diary entry', async () => {
  const { window, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { local: { vypode_state: registry({
      'world-war-z': { watched: true, watchedDate: '2026-01-02', source: 'collectionSync' }
    }) } }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'This must not duplicate the old entry');
  click(window.document, '#vypodeReviewSubmit');
  await tick(40);

  assert.equal(fetchCalls.some(call => call.source === 'worker'), false);
  assert.match(window.document.querySelector('#vypodeDraftStatus')?.textContent || '', /another diary entry/i);
  assert.match(window.document.querySelector('#vypodeExistingLogNotice')?.textContent || '', /cannot edit an existing/i);
  click(window.document, '#vypodeReviewClose');
  await tick(30);
});

test('native watched state alone still permits a first diary review', async () => {
  const page = singleFilmPage().replace('class="action -watch"', 'class="action -watch -on"');
  const today = new Date();
  const diaryDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { window, fetchCalls } = await runContent(page, 'https://letterboxd.com/film/world-war-z/', {
    filmJson: { viewerState: { liked: false } },
    reviewPostBody: {
      logEntry: {
        id: 'first-diary-review',
        review: { text: 'Native watched state can predate a diary entry' },
        diaryDetails: { diaryDate, rewatch: false },
        like: false
      }
    }
  });
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Native watched state can predate a diary entry');
  click(window.document, '#vypodeReviewSubmit');
  await tick(70);
  assert.equal(fetchCalls.some(call => call.source === 'worker'), true);
  assert.equal(window.document.querySelector('#vypodeExistingLogNotice'), null);
});

test('review composer sends half stars and every explicit diary option in the production-log payload', async () => {
  const diaryDate = '2026-08-15';
  const reviewPostBody = {
    logEntry: {
      id: 'entry-all-options',
      review: { text: 'All options review', containsSpoilers: true },
      rating: 3.5,
      diaryDetails: { diaryDate, rewatch: true },
      like: false,
      tags: ['cinema', 'family night']
    }
  };
  const { window, chrome, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      local: { vypode_state: registry({ 'world-war-z': { liked: true, source: 'userAction' } }) },
      reviewPostBody
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);

  click(window.document, '[data-rating="3.5"]');
  setControl(window, '#vypodeReviewText', 'All options review');
  setControl(window, '#vypodeDiaryDate', diaryDate, 'change');
  setControl(window, '#vypodeRewatch', true, 'change');
  setControl(window, '#vypodeSpoilers', true, 'change');
  setControl(window, '#vypodeReviewLike', 'unlike', 'change');
  setControl(window, '#vypodeReviewTags', ' cinema, family night, CINEMA ');
  click(window.document, '#vypodeReviewSubmit');
  await tick(80);

  const post = fetchCalls.find(call => call.options?.method === 'POST');
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.options.body), {
    productionId: 'film-lid',
    diaryDetails: { diaryDate, rewatch: true },
    tags: ['cinema', 'family night'],
    like: false,
    review: { text: 'All options review', containsSpoilers: true },
    rating: 3.5
  });
  const state = window.VypodeFilmState.get('world-war-z');
  assert.equal(state.ratingValue, 3.5);
  assert.equal(state.watchedDate, diaryDate);
  assert.equal(state.liked, false);
  assert.deepEqual(chrome.storage.local.store.vypode_review_drafts_v1, {},
    'only a confirmed production-log response may clear the saved draft');
});

test('account-and-film scoped drafts survive closing and a fresh content-script load', async () => {
  const first = await runContent(singleFilmPage(), 'https://letterboxd.com/film/world-war-z/');
  click(first.window.document, '.vypode-toggle-btn');
  click(first.window.document, '#vypodeOpenReview');
  await tick(15);
  click(first.window.document, '[data-rating="0.5"]');
  setControl(first.window, '#vypodeReviewText', 'A durable half-star draft');
  setControl(first.window, '#vypodeDiaryDate', '2026-07-04', 'change');
  setControl(first.window, '#vypodeRewatch', true, 'change');
  setControl(first.window, '#vypodeSpoilers', true, 'change');
  setControl(first.window, '#vypodeReviewLike', 'like', 'change');
  setControl(first.window, '#vypodeReviewTags', 'summer, cinema');
  click(first.window.document, '#vypodeReviewClose');
  await tick(80);

  const stored = clone(first.chrome.storage.local.store);
  const persisted = stored.vypode_review_drafts_v1?.['user:busybees1']?.['world-war-z'];
  assert.ok(persisted, 'closing the editor should flush its account-scoped draft');
  assert.equal(persisted.rating, 0.5);

  const second = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { local: stored }
  );
  click(second.window.document, '.vypode-toggle-btn');
  click(second.window.document, '#vypodeOpenReview');
  await tick(30);
  assert.equal(second.window.document.querySelector('#vypodeReviewText')?.value, 'A durable half-star draft');
  assert.equal(second.window.document.querySelector('[data-rating="0.5"]')?.getAttribute('aria-checked'), 'true');
  assert.equal(second.window.document.querySelector('#vypodeDiaryDate')?.value, '2026-07-04');
  assert.equal(second.window.document.querySelector('#vypodeRewatch')?.checked, true);
  assert.equal(second.window.document.querySelector('#vypodeSpoilers')?.checked, true);
  assert.equal(second.window.document.querySelector('#vypodeReviewLike')?.value, 'like');
  assert.equal(second.window.document.querySelector('#vypodeReviewTags')?.value, 'summer, cinema');
});

test('edits made while a review POST is in flight remain as a newer draft and keep the panel open', async () => {
  const today = new Date();
  const diaryDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  let resolveResponse;
  const responsePending = new Promise(resolve => { resolveResponse = resolve; });
  const { window, chrome } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      reviewFetch: async () => {
        resolveStarted();
        return await responsePending;
      }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Submitted snapshot');
  click(window.document, '#vypodeReviewSubmit');
  await started;

  setControl(window, '#vypodeReviewText', 'New draft typed while submitting');
  setControl(window, '#vypodeSpoilers', true, 'change');
  await tick(300);
  resolveResponse({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async text() {
      return JSON.stringify({ logEntry: {
        id: 'entry-edit-race',
        review: { text: 'Submitted snapshot', containsSpoilers: false },
        diaryDetails: { diaryDate, rewatch: false },
        like: false,
        tags: []
      } });
    }
  });
  await tick(80);

  assert.ok(window.document.querySelector('.vypode-review-panel'));
  assert.equal(window.document.querySelector('#vypodeReviewText')?.value, 'New draft typed while submitting');
  assert.equal(
    chrome.storage.local.store.vypode_review_drafts_v1?.['user:busybees1']?.['world-war-z']?.reviewText,
    'New draft typed while submitting'
  );
  assert.equal(window.VypodeFilmState.get('world-war-z').reviewText, 'Submitted snapshot');
});

test('a persisted uncertain review lock is shown immediately when the composer reopens', async () => {
  const createdAt = new Date().toISOString();
  const { window, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      local: {
        vypode_state: {
          _meta: { version: 3, generation: 0, activeAccount: 'user:busybees1' },
          accounts: { 'user:busybees1': { _meta: { version: 3 }, slugs: {} } }
        },
        vypode_review_uncertain_v1: {
          'user:busybees1': { 'world-war-z': {
            accountId: 'user:busybees1', slug: 'world-war-z', generation: 0,
            requestId: 'uncertain-reopen', createdAt, reason: 'network lost'
          } }
        }
      }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(30);

  assert.ok(window.document.querySelector('#vypodeReviewUncertain'));
  assert.equal(window.document.querySelector('#vypodeReviewSubmit')?.disabled, true);
  assert.equal(fetchCalls.some(call => call.source === 'worker'), false);
});

test('hidden lifecycle hands the latest draft directly to the worker while an earlier client command is pending', async () => {
  let resolvePendingRead;
  let lifecycleDraft = null;
  const { window, runtimeMessages } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      runtimeSendMessage(message) {
        if (message?.action === 'reviewDraftGet') {
          return new Promise(resolve => { resolvePendingRead = resolve; });
        }
        if (message?.action === 'reviewDraftUpsert') {
          lifecycleDraft = clone(message.data.draft);
          return Promise.resolve({ ok: true });
        }
        return undefined;
      }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  assert.equal(typeof resolvePendingRead, 'function', 'the ordinary draft read should still be pending');

  setControl(window, '#vypodeReviewText', 'Latest text immediately before teardown');
  Object.defineProperty(window.document, 'visibilityState', { value: 'hidden', configurable: true });
  window.document.dispatchEvent(new window.Event('visibilitychange'));

  assert.equal(lifecycleDraft?.reviewText, 'Latest text immediately before teardown');
  assert.equal(lifecycleDraft?.revision, 1);
  assert.ok(runtimeMessages.some(message =>
    message.action === 'reviewDraftUpsert' &&
    message.data?.draft?.reviewText === 'Latest text immediately before teardown'
  ));
  resolvePendingRead({ ok: true, draft: null });
});

test('an account switch saves the opening account draft, closes the composer, and blocks stale submission', async () => {
  const { window, chrome, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/'
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Belongs only to BusyBees1');
  const staleSubmitButton = window.document.querySelector('#vypodeReviewSubmit');

  await window.VypodeFilmState.switchAccount('DifferentUser');
  await tick(80);
  assert.equal(window.VypodeFilmState.getAccountId(), 'user:differentuser');
  assert.equal(window.document.querySelector('.vypode-review-panel')?.classList.contains('visible'), false);
  assert.equal(
    chrome.storage.local.store.vypode_review_drafts_v1?.['user:busybees1']?.['world-war-z']?.reviewText,
    'Belongs only to BusyBees1'
  );
  assert.equal(chrome.storage.local.store.vypode_review_drafts_v1?.['user:differentuser']?.['world-war-z'], undefined);

  staleSubmitButton.click();
  await tick(30);
  assert.equal(fetchCalls.some(call => call.options?.method === 'POST'), false);
  assert.equal(Boolean(window.VypodeFilmState.get('world-war-z')?.watched), false);
});

test('review submission remains bound to its opening film when the deck index changes', async () => {
  const today = new Date();
  const diaryDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { window, fetchCalls } = await runContent(
    listingPage(),
    'https://letterboxd.com/films/popular/',
    {
      reviewPostBody: {
        logEntry: {
          id: 'entry-opening-film',
          review: { text: 'Review the first card only', containsSpoilers: false },
          diaryDetails: { diaryDate, rewatch: false },
          like: true,
          tags: []
        }
      }
    }
  );
  await openDeck(window);
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Review the first card only');
  setControl(window, '#vypodeReviewLike', 'like', 'change');

  click(window.document, '#vypodeNext');
  assert.match(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent || '', /world war z/i);
  click(window.document, '#vypodeReviewSubmit');
  await tick(100);

  const post = fetchCalls.find(call => call.options?.method === 'POST');
  assert.ok(post);
  assert.equal(post.options.body.includes('Review the first card only'), true);
  assert.equal(window.VypodeFilmState.get('colony-2026')?.reviewText, 'Review the first card only');
  assert.equal(window.VypodeFilmState.get('colony-2026')?.liked, true);
  assert.equal(Boolean(window.VypodeFilmState.get('world-war-z')?.watched), false);
  assert.match(window.document.querySelector('#vypodeCard .vypode-card-title')?.textContent || '', /world war z/i,
    'confirmation for the first slug must not advance or mutate the currently displayed second card');
});

test('draft restoration never crosses Letterboxd accounts', async () => {
  const baseDraft = {
    rating: 2.5,
    diaryDate: '2026-07-01',
    rewatch: false,
    spoilers: false,
    likeMode: 'preserve',
    tags: [],
    updatedAt: '2026-07-01T12:00:00.000Z'
  };
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      local: {
        vypode_review_drafts_v1: {
          'user:busybees1': { 'world-war-z': { ...baseDraft, reviewText: 'My draft' } },
          'user:someone_else': { 'world-war-z': { ...baseDraft, reviewText: 'Another account draft' } }
        }
      }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(30);
  assert.equal(window.document.querySelector('#vypodeReviewText')?.value, 'My draft');
});

test('invalid or excessive tags block submission before any account mutation', async () => {
  const { window, fetchCalls } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/world-war-z/');
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  setControl(window, '#vypodeReviewText', 'Do not send this');
  setControl(window, '#vypodeReviewTags', Array.from({ length: 21 }, (_, index) => `tag-${index}`).join(','));
  click(window.document, '#vypodeReviewSubmit');
  await tick(50);
  assert.equal(fetchCalls.some(call => call.options?.method === 'POST'), false);
  assert.equal(Boolean(window.VypodeFilmState.get('world-war-z')?.watched), false);
  assert.equal(window.document.querySelector('#vypodeReviewSubmit')?.disabled, false);
  assert.match(window.document.querySelector('#vypodeDraftStatus')?.textContent || '', /20 tags/i);
});

test('an unverified 201 production-log response keeps the review draft open', async () => {
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      reviewPostStatus: 201,
      reviewPostBody: { logEntry: { id: 'entry-201' } }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  window.document.querySelector('#vypodeReviewText').value = 'A 201 response is not confirmation';
  click(window.document, '#vypodeReviewSubmit');
  await tick(50);

  assert.equal(window.document.querySelector('#vypodeReviewText')?.value, 'A 201 response is not confirmation');
  assert.equal(Boolean(window.VypodeFilmState.get('world-war-z')?.watched), false);
  assert.equal(window.document.querySelector('#vypodeReviewSubmit')?.disabled, false);
});

test('an Error message or mismatched returned entry never closes the review editor', async t => {
  for (const [name, reviewPostBody] of [
    ['explicit error message', { messages: [{ type: 'Error', text: 'Review is not allowed' }], logEntry: { id: 'entry-error' } }],
    ['missing log entry id', { logEntry: {} }],
    ['mismatched review text', { logEntry: { id: 'entry-mismatch', review: { text: 'Different review' } } }]
  ]) {
    await t.test(name, async () => {
      const { window } = await runContent(
        singleFilmPage(),
        'https://letterboxd.com/film/world-war-z/',
        { reviewPostBody }
      );
      click(window.document, '.vypode-toggle-btn');
      click(window.document, '#vypodeOpenReview');
      await tick(15);
      window.document.querySelector('#vypodeReviewText').value = 'Keep this draft while response is rejected';
      click(window.document, '#vypodeReviewSubmit');
      await tick(50);

      assert.equal(window.document.querySelector('#vypodeReviewText')?.value, 'Keep this draft while response is rejected');
      assert.equal(Boolean(window.VypodeFilmState.get('world-war-z')?.watched), false);
      assert.equal(window.document.querySelector('#vypodeReviewSubmit')?.disabled, false);
    });
  }
});

test('review editor does not present a cached review as editable and rapid close/reopen leaves one working dialog', async () => {
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    {
      local: {
        vypode_state: registry({
          'world-war-z': { title: 'World War Z', reviewText: 'Cached review draft' }
        })
      }
    }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  assert.equal(window.document.querySelector('#vypodeReviewText')?.value, '');
  assert.match(window.document.querySelector('#vypodeExistingLogNotice')?.textContent || '', /cannot edit an existing/i);

  click(window.document, '#vypodeReviewClose');
  click(window.document, '#vypodeOpenReview');
  assert.equal(window.document.querySelectorAll('.vypode-review-panel').length, 1);
  assert.equal(window.document.querySelectorAll('#vypodeReviewText').length, 1);
  click(window.document, '#vypodeReviewClose');
  await tick(320);
  assert.equal(window.document.querySelectorAll('.vypode-review-panel').length, 0);
});

test('dictation waits for recognition.onstart and appends final speech with correct spacing', async () => {
  FakeSpeechRecognition.instances = [];
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { speechRecognition: FakeSpeechRecognition }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);

  const textarea = window.document.querySelector('#vypodeReviewText');
  const micButton = window.document.querySelector('#vypodeMicBtn');
  textarea.value = 'A strong start.';
  micButton.click();

  const recognition = FakeSpeechRecognition.instances.at(-1);
  assert.ok(recognition);
  assert.equal(recognition.startCalls, 1);
  assert.equal(micButton.dataset.state, 'starting');
  assert.match(window.document.querySelector('#vypodeSpeechStatus')?.textContent || '', /requesting/i);
  assert.equal(micButton.classList.contains('listening'), false,
    'the UI must not claim to be recording before the speech engine starts');

  recognition.emitStart();
  assert.equal(micButton.classList.contains('listening'), true);
  recognition.emitFinal('Very good');
  assert.equal(textarea.value, 'A strong start. Very good');

  micButton.click();
  assert.equal(recognition.stopCalls, 1);
  assert.equal(recognition.abortCalls, 0,
    'abort immediately after stop can throw away the final dictated words');
  assert.equal(micButton.classList.contains('listening'), false);
});

for (const speechError of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network']) {
  test(`dictation stops cleanly and reports ${speechError}`, async () => {
    FakeSpeechRecognition.instances = [];
    const { window } = await runContent(
      singleFilmPage(),
      'https://letterboxd.com/film/world-war-z/',
      { speechRecognition: FakeSpeechRecognition }
    );
    click(window.document, '.vypode-toggle-btn');
    click(window.document, '#vypodeOpenReview');
    await tick(5);
    const micButton = click(window.document, '#vypodeMicBtn');
    const recognition = FakeSpeechRecognition.instances.at(-1);
    recognition.emitStart();
    recognition.emitError(speechError);
    await tick(125);

    assert.equal(micButton.classList.contains('listening'), false);
    assert.equal(recognition.startCalls, 1, 'a fatal error must not enter a restart loop');
    assert.match(window.document.querySelector('#vypodeSpeechStatus')?.textContent || '', /\S/);
  });
}

test('a natural recognition end returns to idle without an automatic restart loop', async () => {
  FakeSpeechRecognition.instances = [];
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { speechRecognition: FakeSpeechRecognition }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  const micButton = click(window.document, '#vypodeMicBtn');
  const recognition = FakeSpeechRecognition.instances.at(-1);
  recognition.emitStart();
  recognition.emitEnd();
  await tick(125);

  assert.equal(recognition.startCalls, 1);
  assert.equal(micButton.classList.contains('listening'), false);
});

test('unsupported speech recognition gives a useful system-dictation fallback', async () => {
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { platform: 'MacIntel' }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  const fallbackButton = window.document.querySelector('#vypodeMicBtn');
  assert.match(fallbackButton.textContent, /system dictation/i);
  const textarea = window.document.querySelector('#vypodeReviewText');
  let focusCalls = 0;
  textarea.focus = () => { focusCalls += 1; };
  fallbackButton.click();
  await tick(5);

  assert.equal(focusCalls, 1);
  assert.match(window.document.querySelector('#vypodeSpeechStatus')?.textContent || '', /Fn/i);
});

test('Brave proactively uses system dictation without constructing SpeechRecognition', async () => {
  FakeSpeechRecognition.instances = [];
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { speechRecognition: FakeSpeechRecognition, brave: true, platform: 'MacIntel' }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(15);
  assert.match(window.document.querySelector('#vypodeMicBtn')?.textContent || '', /system dictation/i);
  assert.match(window.document.querySelector('#vypodeSpeechStatus')?.textContent || '', /Brave/i);
  const textarea = window.document.querySelector('#vypodeReviewText');
  let focusCalls = 0;
  textarea.focus = () => { focusCalls += 1; };
  click(window.document, '#vypodeMicBtn');
  await tick(5);

  assert.equal(FakeSpeechRecognition.instances.length, 0);
  assert.equal(focusCalls, 1);
  assert.equal(window.document.querySelector('#vypodeMicBtn')?.classList.contains('listening'), false);
  assert.match(window.document.querySelector('#vypodeMicBtn')?.textContent || '', /system dictation/i);
  assert.match(window.document.querySelector('#vypodeSpeechStatus')?.textContent || '', /Fn\/Globe/i);
});

test('closing the review panel aborts an active recognition session', async () => {
  FakeSpeechRecognition.instances = [];
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { speechRecognition: FakeSpeechRecognition }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(5);
  click(window.document, '#vypodeMicBtn');
  const recognition = FakeSpeechRecognition.instances.at(-1);
  recognition.emitStart();
  click(window.document, '#vypodeReviewCancel');

  assert.equal(recognition.abortCalls, 1);
});

test('submitting while dictating waits for the final result before sending the review', async () => {
  FakeSpeechRecognition.instances = [];
  const { window, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { speechRecognition: FakeSpeechRecognition }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(5);
  click(window.document, '#vypodeMicBtn');
  const recognition = FakeSpeechRecognition.instances.at(-1);
  recognition.emitStart();

  click(window.document, '#vypodeReviewSubmit');
  assert.equal(recognition.stopCalls, 1);
  assert.equal(fetchCalls.some(call => call.options?.method === 'POST'), false);

  recognition.emitFinal('Captured right at the end');
  recognition.emitEnd();
  await tick(15);
  const post = fetchCalls.find(call => call.options?.method === 'POST');
  assert.ok(post, 'review submission should resume after recognition ends');
  assert.equal(JSON.parse(post.options.body).review.text, 'Captured right at the end');
});

test('a dictation stop timeout keeps the review open and requires a second submit', async () => {
  FakeSpeechRecognition.instances = [];
  const { window, fetchCalls } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { speechRecognition: FakeSpeechRecognition }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(5);
  const textarea = window.document.querySelector('#vypodeReviewText');
  textarea.value = 'Text already confirmed before the timeout';
  click(window.document, '#vypodeMicBtn');
  const recognition = FakeSpeechRecognition.instances.at(-1);
  recognition.emitStart();

  click(window.document, '#vypodeReviewSubmit');
  assert.equal(recognition.stopCalls, 1);
  assert.equal(fetchCalls.some(call => call.options?.method === 'POST'), false);
  await tick(30);

  const submitButton = window.document.querySelector('#vypodeReviewSubmit');
  assert.ok(window.document.querySelector('.vypode-review-panel'), 'timeout must leave the review open');
  assert.equal(fetchCalls.some(call => call.options?.method === 'POST'), false,
    'an uncertain final transcript must not be submitted');
  assert.equal(recognition.abortCalls, 1);
  assert.equal(submitButton?.disabled, false);
  assert.equal(submitButton?.dataset.submitting, 'false');
  assert.match(window.document.querySelector('#vypodeSpeechStatus')?.textContent || '', /press Submit again/i);

  submitButton.click();
  await tick(15);
  const post = fetchCalls.find(call => call.options?.method === 'POST');
  assert.ok(post, 'a deliberate second submit should proceed after the timeout warning');
  assert.equal(JSON.parse(post.options.body).review.text, 'Text already confirmed before the timeout');
});
