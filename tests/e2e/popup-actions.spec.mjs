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
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const NativeURL = globalThis.URL;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function storageArea(initial = {}, getDelay = 0) {
  const store = clone(initial) || {};
  return {
    store,
    get(keys, callback) {
      const result = {};
      if (Array.isArray(keys)) {
        for (const key of keys) result[key] = clone(store[key]);
      } else if (typeof keys === 'string') {
        result[keys] = clone(store[keys]);
      } else if (keys && typeof keys === 'object') {
        Object.assign(result, clone(keys));
        for (const key of Object.keys(keys)) {
          if (Object.hasOwn(store, key)) result[key] = clone(store[key]);
        }
      } else {
        Object.assign(result, clone(store));
      }
      if (getDelay > 0) nativeSetTimeout(() => callback(result), getDelay);
      else callback(result);
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

function signedInFilmPage() {
  return `<html><body>
    <header>
      <a href="/BusyBees1/">Profile</a>
      <a href="/BusyBees1/films/">Films</a>
      <a href="/sign-out/">Sign Out</a>
    </header>
    <h1 class="headline-1">Arrival</h1>
    <p class="releaseyear"><a>2016</a></p>
    <div class="film-poster"><img src="https://img.test/arrival.jpg"></div>
    <p class="contributor"><a>Denis Villeneuve</a></p>
    <a class="action -watch" href="#">Watch</a>
    <a class="action -like" href="#">Like</a>
    <a class="action -watchlist" href="#">Watchlist</a>
  </body></html>`;
}

function installGlobals(window, url, chrome) {
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
  window.AbortController = globalThis.AbortController;
  window.URL = NativeURL;
  window.URL.createObjectURL = () => 'blob:vypode-popup-test';
  window.URL.revokeObjectURL = () => {};
  window.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, ms >= 1000 ? 30 : ms, ...args);
  window.clearTimeout = nativeClearTimeout;
}

function runContent({
  html = signedInFilmPage(),
  url = 'https://letterboxd.com/film/arrival/',
  storageDelay = 0,
  fetchImpl
} = {}) {
  const { window: domWindow } = parseHTML(html);
  let window;
  window = new Proxy(domWindow, {
    get(target, property, receiver) {
      if (property === 'window' || property === 'self' || property === 'globalThis') return window;
      return Reflect.get(target, property, receiver);
    }
  });
  const messageListeners = [];
  const local = storageArea({}, storageDelay);
  const sync = storageArea({}, storageDelay);
  const chrome = {
    storage: {
      local,
      sync,
      onChanged: { addListener() {} }
    },
    runtime: {
      id: 'test-extension',
      lastError: null,
      sendMessage() {},
      onMessage: {
        addListener(listener) { messageListeners.push(listener); }
      }
    }
  };
  const fetchCalls = [];
  window.fetch = (requestUrl, options = {}) => {
    fetchCalls.push({ url: String(requestUrl), options });
    if (fetchImpl) return fetchImpl(requestUrl, options, fetchCalls.length);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html><body><p class="empty-message">No films</p></body></html>',
      json: async () => ({})
    });
  };
  installGlobals(window, url, chrome);
  vm.createContext(window);
  vm.runInContext(filmStateSource, window, { filename: 'film-state.js' });
  vm.runInContext(contentSource, window, { filename: 'content.js' });
  assert.equal(messageListeners.length, 1, 'content script should install exactly one popup receiver');

  const sendPopup = message => new Promise((resolve, reject) => {
    let responded = false;
    const keepChannelOpen = messageListeners[0](message, { id: chrome.runtime.id }, response => {
      responded = true;
      resolve(response);
    });
    if (!keepChannelOpen && !responded) reject(new Error('message channel closed without a response'));
  });
  return { window, chrome, fetchCalls, sendPopup };
}

function tick(ms = 5) {
  return new Promise(resolve => nativeSetTimeout(resolve, ms));
}

test('popup receiver waits for asynchronous initialization before opening Swipe', async () => {
  const { window, sendPopup } = runContent({ storageDelay: 20 });
  let settled = false;
  const pending = sendPopup({ type: 'vypode-popup', action: 'resumeSwipe' }).then(response => {
    settled = true;
    return response;
  });

  await tick(3);
  assert.equal(settled, false, 'the receiver must not act against partially initialized state');
  assert.equal(window.document.querySelector('.vypode-overlay'), null);

  const response = await pending;
  assert.equal(response.ok, true);
  assert.equal(response.code, 'opened');
  assert.ok(window.document.querySelector('.vypode-overlay'));
});

test('popup receiver strictly rejects unknown actions and extra message fields', async () => {
  const { sendPopup } = runContent();
  for (const message of [
    { type: 'vypode-popup', action: 'closeSwipe' },
    { type: 'vypode-popup', action: 'resumeSwipe', payload: true },
    { type: 'vypode-popup' }
  ]) {
    const response = await sendPopup(message);
    assert.equal(response.ok, false);
    assert.equal(response.code, 'unsupported-action');
    assert.equal(typeof response.message, 'string');
    assert.equal(response.error, response.message);
  }
});

test('popup receiver rejects unsupported film subroutes with structured capabilities', async () => {
  const { window, sendPopup } = runContent({
    url: 'https://letterboxd.com/film/arrival/reviews/'
  });
  const response = await sendPopup({ type: 'vypode-popup', action: 'ping' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'unsupported-page');
  assert.equal(response.supported, false);
  assert.deepEqual(Object.values(response.capabilities), [false, false, false]);
  assert.equal(window.document.querySelector('.vypode-overlay'), null);
});

test('resume is idempotent and never toggles an open overlay closed', async () => {
  const { window, sendPopup } = runContent();
  const first = await sendPopup({ type: 'vypode-popup', action: 'resumeSwipe' });
  const overlay = window.document.querySelector('.vypode-overlay');
  const second = await sendPopup({ type: 'vypode-popup', action: 'resumeSwipe' });

  assert.equal(first.ok, true);
  assert.equal(first.code, 'opened');
  assert.equal(second.ok, true);
  assert.equal(second.code, 'already-open');
  assert.equal(window.document.querySelector('.vypode-overlay'), overlay);
  assert.equal(overlay.classList.contains('hiding'), false);
  assert.equal(overlay.isConnected, true);
});

test('settings opens directly when the Swipe overlay is closed', async () => {
  const { window, sendPopup } = runContent();
  assert.equal(window.document.querySelector('.vypode-overlay'), null);
  const response = await sendPopup({ type: 'vypode-popup', action: 'openSettings' });

  assert.equal(response.ok, true);
  assert.equal(response.code, 'opened');
  assert.equal(window.document.querySelector('.vypode-overlay'), null);
  assert.ok(window.document.querySelector('.vypode-settings-panel.visible'));
});

test('settings opened directly from the popup still owns Escape keyboard handling', async () => {
  const { window, sendPopup } = runContent();
  const response = await sendPopup({ type: 'vypode-popup', action: 'openSettings' });
  assert.equal(response.ok, true);
  assert.equal(window.document.querySelector('.vypode-overlay'), null);

  const close = window.document.querySelector('#vypodeSettingsClose');
  const escape = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperties(escape, {
    key: { value: 'Escape' },
    metaKey: { value: false },
    ctrlKey: { value: false },
    altKey: { value: false },
    shiftKey: { value: false },
    repeat: { value: false },
    isComposing: { value: false }
  });
  close.dispatchEvent(escape);

  assert.equal(escape.defaultPrevented, true);
  assert.equal(window.document.querySelector('.vypode-settings-panel')?.classList.contains('visible'), false);
  assert.equal(window.document.querySelector('.vypode-settings-panel')?.getAttribute('aria-hidden'), 'true');
  await tick(320);
  assert.equal(window.document.querySelector('.vypode-settings-panel'), null);
});

test('settings quick action closes Review and preserves its latest draft', async () => {
  const { window, chrome, sendPopup } = runContent();
  const opened = await sendPopup({ type: 'vypode-popup', action: 'resumeSwipe' });
  assert.equal(opened.ok, true);

  window.document.getElementById('vypodeOpenReview').click();
  await tick(15);
  const review = window.document.querySelector('.vypode-review-panel.visible');
  assert.ok(review);
  const textarea = review.querySelector('#vypodeReviewText');
  textarea.value = 'Keep this draft while switching panels.';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

  const response = await sendPopup({ type: 'vypode-popup', action: 'openSettings' });
  await tick(10);

  assert.equal(response.ok, true);
  assert.equal(response.code, 'opened');
  assert.equal(window.document.querySelector('.vypode-review-panel.visible'), null);
  assert.ok(window.document.querySelector('.vypode-settings-panel.visible'));
  assert.equal(
    chrome.storage.local.store.vypode_review_drafts_v1?.['user:busybees1']?.arrival?.reviewText,
    'Keep this draft while switching panels.'
  );
});

test('duplicate popup sync messages do not invoke the existing cancellation path', async () => {
  const pendingFetches = [];
  const { fetchCalls, sendPopup } = runContent({
    fetchImpl(requestUrl, options) {
      return new Promise(resolve => {
        pendingFetches.push({
          signal: options.signal,
          resolve: () => resolve({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => '<html><body><p class="empty-message">No films</p></body></html>',
            json: async () => ({})
          })
        });
      });
    }
  });

  const first = await sendPopup({ type: 'vypode-popup', action: 'syncNow' });
  const duplicate = await sendPopup({ type: 'vypode-popup', action: 'syncNow' });

  assert.equal(first.ok, true);
  assert.equal(first.code, 'sync-started');
  assert.equal(first.started, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.code, 'sync-in-progress');
  assert.equal(duplicate.started, false);
  assert.equal(fetchCalls.length, 4, 'only one four-stage collection sync should start');
  assert.ok(pendingFetches.every(request => request.signal?.aborted === false), 'the duplicate must not abort the active run');

  for (const request of pendingFetches) request.resolve();
  await tick(15);
  assert.ok(pendingFetches.every(request => request.signal?.aborted === false));
});
