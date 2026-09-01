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

function trailerPage({ playerSrc = '//www.youtube.com/embed/TvRCQM2HrXs?rel=0&wmode=transparent', includePlayer = true } = {}) {
  return `<html><body class="film js-play-trailer">
    <header><a href="/sign-in/">Sign In</a></header>
    <h1 class="headline-1">World War Z</h1>
    <p class="trailer-link js-watch-panel-trailer">
      <a class="play track-event js-video-zoom cboxElement"
         href="//www.youtube.com/embed/TvRCQM2HrXs?rel=0&amp;wmode=transparent">Trailer</a>
    </p>
    <iframe id="unrelated-frame" src="https://www.youtube.com/embed/UnrelatedPlayer?rel=0"></iframe>
    ${includePlayer ? `<div id="colorbox" class="-video">
      <div id="cboxLoadedContent">
        <iframe class="cboxIframe" src="${playerSrc.replaceAll('&', '&amp;')}"></iframe>
      </div>
    </div>` : ''}
    <input id="search-input">
    <textarea id="review-input"></textarea>
    <div id="editable" contenteditable="true">Editable</div>
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
  window.URL = NativeURL;
  window.URL.createObjectURL = () => 'blob:vypode-test';
  window.URL.revokeObjectURL = () => {};
  window.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, ms >= 1000 ? 30 : ms, ...args);
  window.clearTimeout = nativeClearTimeout;
}

async function runContent(html, url = 'https://letterboxd.com/film/world-war-z/trailer/') {
  const { window } = parseHTML(html);
  const chrome = {
    storage: { local: storageArea(), sync: storageArea() },
    runtime: { sendMessage() {}, lastError: null }
  };
  window.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '<html></html>',
    json: async () => ({})
  });
  installGlobals(window, url, chrome);
  vm.createContext(window);
  vm.runInContext(filmStateSource, window, { filename: 'film-state.js' });
  vm.runInContext(contentSource, window, { filename: 'content.js' });
  await tick(40);
  return { window, chrome };
}

function tick(ms = 10) {
  return new Promise(resolve => nativeSetTimeout(resolve, ms));
}

function keydown(window, key = 'k', options = {}) {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    code: { value: options.code || (key === ' ' ? 'Space' : '') },
    metaKey: { value: Boolean(options.metaKey) },
    ctrlKey: { value: Boolean(options.ctrlKey) },
    altKey: { value: Boolean(options.altKey) },
    shiftKey: { value: Boolean(options.shiftKey) },
    repeat: { value: Boolean(options.repeat) }
  });
  (options.target || window.document).dispatchEvent(event);
  return event;
}

function assertConfiguredYouTubePlayer(player) {
  const url = new NativeURL(player.getAttribute('src'), 'https://letterboxd.com');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'www.youtube.com');
  assert.match(url.pathname, /^\/embed\/[A-Za-z0-9_-]+$/);
  assert.equal(url.searchParams.get('autoplay'), '1');
  assert.equal(url.searchParams.get('enablejsapi'), '1');
  assert.equal(url.searchParams.get('origin'), 'https://letterboxd.com');
  assert.equal(url.searchParams.get('rel'), '0', 'existing YouTube parameters must survive');
  assert.equal(url.searchParams.get('wmode'), 'transparent', 'existing YouTube parameters must survive');
  assert.match(player.getAttribute('allow') || '', /autoplay/i);
}

test('K cold-starts the exact Letterboxd YouTube trailer without touching other frames', async () => {
  const { window } = await runContent(trailerPage());
  const document = window.document;
  const player = document.querySelector('#cboxLoadedContent iframe.cboxIframe');
  const unrelated = document.querySelector('#unrelated-frame');
  const sourceLink = document.querySelector('.js-watch-panel-trailer a.js-video-zoom');
  const unrelatedBefore = {
    src: unrelated.getAttribute('src'),
    allow: unrelated.getAttribute('allow')
  };
  let sourceClicks = 0;
  sourceLink.addEventListener('click', event => {
    event.preventDefault();
    sourceClicks += 1;
  });
  const playerMessages = [];
  Object.defineProperty(player, 'contentWindow', {
    configurable: true,
    value: {
      postMessage(message, targetOrigin) { playerMessages.push({ message, targetOrigin }); }
    }
  });

  const event = keydown(window);
  player.dispatchEvent(new window.Event('load'));
  await tick(10);

  assert.equal(event.defaultPrevented, true, 'the cold-start K must not leak to Letterboxd');
  assert.equal(sourceClicks, 0, 'an already-created colorbox player must not reopen the overlay');
  assertConfiguredYouTubePlayer(player);
  assert.equal(JSON.parse(playerMessages.at(-1).message).func, 'playVideo');
  assert.equal(playerMessages.at(-1).targetOrigin, 'https://www.youtube.com');
  assert.deepEqual(
    { src: unrelated.getAttribute('src'), allow: unrelated.getAttribute('allow') },
    unrelatedBefore,
    'unrelated iframes must remain byte-for-byte untouched'
  );
});

test('K opens a not-yet-created Letterboxd trailer and waits for its YouTube iframe', async () => {
  const { window } = await runContent(trailerPage({ includePlayer: false }));
  const document = window.document;
  const sourceLink = document.querySelector('.js-watch-panel-trailer a.js-video-zoom');
  let sourceClicks = 0;
  sourceLink.addEventListener('click', event => {
    event.preventDefault();
    sourceClicks += 1;
    window.setTimeout(() => {
      const colorbox = document.createElement('div');
      colorbox.id = 'colorbox';
      colorbox.className = '-video';
      colorbox.innerHTML = `<div id="cboxLoadedContent">
        <iframe class="cboxIframe"
          src="//www.youtube.com/embed/TvRCQM2HrXs?rel=0&amp;wmode=transparent"></iframe>
      </div>`;
      document.body.appendChild(colorbox);
    }, 1);
  });

  const event = keydown(window);
  const pendingPause = keydown(window);
  await tick(20);

  const player = document.querySelector('#cboxLoadedContent iframe.cboxIframe');
  assert.equal(event.defaultPrevented, true);
  assert.equal(pendingPause.defaultPrevented, true);
  assert.equal(sourceClicks, 1, 'rapid K presses must activate the genuine Letterboxd source only once');
  assert.ok(player, 'the asynchronously-created colorbox iframe should be found');
  assertConfiguredYouTubePlayer(player);
  assert.equal(player.dataset.vypodePlaybackRequested, 'paused');
  const playerMessages = [];
  Object.defineProperty(player, 'contentWindow', {
    configurable: true,
    value: {
      postMessage(message, targetOrigin) { playerMessages.push({ message, targetOrigin }); }
    }
  });
  player.dispatchEvent(new window.Event('load'));
  assert.equal(JSON.parse(playerMessages.at(-1).message).func, 'pauseVideo');

  const latePlayer = document.createElement('iframe');
  latePlayer.className = 'cboxIframe';
  latePlayer.setAttribute('src', '//www.youtube.com/embed/LatePlayer?rel=0');
  document.querySelector('#cboxLoadedContent').appendChild(latePlayer);
  await tick(10);
  assert.equal(new NativeURL(latePlayer.getAttribute('src'), 'https://letterboxd.com').searchParams.has('autoplay'), false);
});

test('a timed-out trailer insertion returns to idle so Space scrolls and K can retry', async () => {
  const { window } = await runContent(trailerPage({ includePlayer: false }));
  const sourceLink = window.document.querySelector('.js-watch-panel-trailer a.js-video-zoom');
  let sourceClicks = 0;
  sourceLink.addEventListener('click', event => {
    event.preventDefault();
    sourceClicks += 1;
  });

  const first = keydown(window);
  await tick(40);
  const idleSpace = keydown(window, ' ', { code: 'Space' });
  const retry = keydown(window);

  assert.equal(first.defaultPrevented, true);
  assert.equal(idleSpace.defaultPrevented, false, 'Space must return to normal after the player wait times out');
  assert.equal(retry.defaultPrevented, true);
  assert.equal(sourceClicks, 2, 'K must be able to retry after a timed-out player insertion');
});

test('rapid K then K and Space preserve the latest playback intent without reopening or reloading', async () => {
  const { window } = await runContent(trailerPage());
  const document = window.document;
  const player = document.querySelector('#cboxLoadedContent iframe.cboxIframe');
  const sourceLink = document.querySelector('.js-watch-panel-trailer a.js-video-zoom');
  let sourceClicks = 0;
  sourceLink.addEventListener('click', event => {
    event.preventDefault();
    sourceClicks += 1;
  });
  const playerMessages = [];
  Object.defineProperty(player, 'contentWindow', {
    configurable: true,
    value: {
      postMessage(message, targetOrigin) { playerMessages.push({ message, targetOrigin }); }
    }
  });

  const first = keydown(window);
  const configuredSrc = player.getAttribute('src');
  let laterSrcWrites = 0;
  const nativeSetAttribute = player.setAttribute.bind(player);
  player.setAttribute = (name, value) => {
    if (String(name).toLowerCase() === 'src') laterSrcWrites += 1;
    return nativeSetAttribute(name, value);
  };

  const pause = keydown(window);
  player.dispatchEvent(new window.Event('load'));
  const resume = keydown(window, ' ', { code: 'Space' });
  const searchInput = document.querySelector('#search-input');
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => searchInput
  });
  const typingSpace = keydown(window, ' ', { code: 'Space', target: searchInput });
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => document.body
  });
  const modifiedSpace = keydown(window, ' ', { code: 'Space', ctrlKey: true });
  await tick(10);

  assert.equal(first.defaultPrevented, true, 'the first K must configure the player');
  assert.equal(pause.defaultPrevented, true, 'the page shortcut must handle a follow-up K');
  assert.equal(resume.defaultPrevented, true, 'the page shortcut must handle Space without scrolling');
  assert.equal(typingSpace.defaultPrevented, false, 'Space must remain available while typing');
  assert.equal(modifiedSpace.defaultPrevented, false, 'modified Space must remain a browser shortcut');
  assert.equal(sourceClicks, 0);
  assert.equal(laterSrcWrites, 0, 'an already-configured player must not be reloaded');
  assert.equal(player.getAttribute('src'), configuredSrc);
  assert.deepEqual(
    playerMessages.map(({ message }) => JSON.parse(message).func),
    ['pauseVideo', 'pauseVideo', 'playVideo'],
    'the load callback must honor the rapid second K instead of restoring play'
  );
  assert.ok(playerMessages.every(({ targetOrigin }) => targetOrigin === 'https://www.youtube.com'));
});

test('modified, repeated, and typing K presses are never hijacked', async () => {
  const { window } = await runContent(trailerPage());
  const document = window.document;
  const player = document.querySelector('#cboxLoadedContent iframe.cboxIframe');
  const initialSrc = player.getAttribute('src');
  const initialSpace = keydown(window, ' ', { code: 'Space' });
  assert.equal(initialSpace.defaultPrevented, false, 'Space must scroll normally before K activates trailer controls');
  const cases = [
    { metaKey: true },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { repeat: true },
    { target: document.querySelector('#search-input') },
    { target: document.querySelector('#review-input') },
    { target: document.querySelector('#editable') }
  ];

  for (const options of cases) {
    if (options.target) {
      if (options.target.id === 'editable') {
        Object.defineProperty(options.target, 'isContentEditable', { configurable: true, value: true });
      }
      Object.defineProperty(document, 'activeElement', {
        configurable: true,
        get: () => options.target
      });
    }
    const event = keydown(window, 'k', options);
    assert.equal(event.defaultPrevented, false);
  }
  await tick(10);

  assert.equal(player.getAttribute('src'), initialSrc);
  assert.equal(player.getAttribute('allow'), null);
});

test('K is ignored off the exact trailer route and when no valid Letterboxd player exists', async t => {
  await t.test('regular film route', async () => {
    const { window } = await runContent(trailerPage(), 'https://letterboxd.com/film/world-war-z/');
    const player = window.document.querySelector('iframe.cboxIframe');
    const initialSrc = player.getAttribute('src');
    const event = keydown(window);
    await tick(5);
    assert.equal(event.defaultPrevented, false);
    assert.equal(player.getAttribute('src'), initialSrc);
    assert.equal(player.getAttribute('allow'), null);
  });

  await t.test('missing overlay and source', async () => {
    const emptyPage = trailerPage({ includePlayer: false })
      .replace(/<p class="trailer-link[\s\S]*?<\/p>/, '');
    const { window } = await runContent(emptyPage);
    const event = keydown(window);
    await tick(35);
    assert.equal(event.defaultPrevented, false);
  });

  await t.test('non-YouTube source link', async () => {
    const html = trailerPage({ includePlayer: false })
      .replace(
        '//www.youtube.com/embed/TvRCQM2HrXs?rel=0&amp;wmode=transparent',
        'https://attacker.example/embed/not-youtube'
      );
    const { window } = await runContent(html);
    const source = window.document.querySelector('.js-watch-panel-trailer a.js-video-zoom');
    let sourceClicks = 0;
    source.addEventListener('click', event => {
      event.preventDefault();
      sourceClicks += 1;
    });
    const event = keydown(window);
    await tick(35);
    assert.equal(event.defaultPrevented, false);
    assert.equal(sourceClicks, 0, 'an untrusted trailer source must never be activated');
  });
});

for (const invalidSrc of [
  'https://www.youtube.com.evil.test/embed/TvRCQM2HrXs?rel=0',
  'https://www.youtube.com/watch?v=TvRCQM2HrXs',
  'https://evil.test/embed/TvRCQM2HrXs'
]) {
  test(`K rejects non-YouTube-embed player URL: ${invalidSrc}`, async () => {
    const html = trailerPage({ playerSrc: invalidSrc })
      .replace(/<p class="trailer-link[\s\S]*?<\/p>/, '');
    const { window } = await runContent(html);
    const player = window.document.querySelector('iframe.cboxIframe');
    const event = keydown(window);
    await tick(35);

    assert.equal(event.defaultPrevented, false);
    assert.equal(player.getAttribute('src'), invalidSrc);
    assert.equal(player.getAttribute('allow'), null);
  });
}
