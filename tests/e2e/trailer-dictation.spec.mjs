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

function signedInHeader() {
  return `<header>
    <a href="/BusyBees1/">Profile</a>
    <a href="/BusyBees1/films/">Films</a>
    <a href="/BusyBees1/films/diary/">Diary</a>
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

function singleFilmPage() {
  return `<html><body>${signedInHeader()}
    <h1 class="headline-1">World War Z</h1>
    <p class="releaseyear"><a>2013</a></p>
    <div class="film-poster"><img src="https://img.test/world-war-z.jpg"></div>
    <p class="contributor"><a>Marc Forster</a></p>
    <a class="action -watch" href="#">Watch</a>
    <a class="action -like" href="#">Like</a>
    <a class="action -watchlist" href="#">Watchlist</a>
  </body></html>`;
}

function fetchedFilmPage() {
  return `<html><body>${signedInHeader()}
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
  platform = ''
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
  const chrome = {
    storage: { local: storageArea(), sync: storageArea() },
    runtime: { sendMessage() {}, lastError: null }
  };
  const fetchCalls = [];
  window.fetch = async (requestUrl, options = {}) => {
    fetchCalls.push({ url: String(requestUrl), options });
    if (failFilmFetch && !options.method) throw new Error('offline');
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
  await tick(30);
  return { window, chrome, fetchCalls };
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
  await openDeck(window);

  const trailerLink = window.document.querySelector('#vypodeTrailerLink');
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

test('dictation waits for recognition.onstart and appends final speech with correct spacing', async () => {
  FakeSpeechRecognition.instances = [];
  const { window } = await runContent(
    singleFilmPage(),
    'https://letterboxd.com/film/world-war-z/',
    { speechRecognition: FakeSpeechRecognition }
  );
  click(window.document, '.vypode-toggle-btn');
  click(window.document, '#vypodeOpenReview');
  await tick(5);

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
  await tick(5);
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
  await tick(5);
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
  await tick(5);
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
