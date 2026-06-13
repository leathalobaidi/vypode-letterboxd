// v6.2.0: the deck must build from Letterboxd's new React LazyPoster markup
// ([data-item-slug] components) — used on member/profile grids — including
// before hydration adds an <img>, and must dedupe against classic markup.
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
      if (Array.isArray(keys)) for (const key of keys) result[key] = clone(store[key]);
      else if (typeof keys === 'string') result[keys] = clone(store[keys]);
      else Object.assign(result, clone(store));
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

function reactPoster(slug, name, { hydrated = false } = {}) {
  return `
    <div class="react-component griditem" data-component-class="LazyPoster"
         data-item-slug="${slug}" data-item-name="${name}"
         data-item-link="/film/${slug}/">
      ${hydrated ? `<div class="poster"><img alt="${name}" src="https://img.test/${slug}.jpg"></div>` : ''}
    </div>
  `;
}

function classicPoster(slug, title, src) {
  return `
    <li class="poster-container">
      <div class="film-poster">
        <a href="/film/${slug}/"><img alt="Poster for ${title}" src="${src}"></a>
      </div>
    </li>
  `;
}

async function runContent(html, url) {
  const { window } = parseHTML(html);
  const chrome = {
    storage: { local: storageArea(), sync: storageArea() },
    runtime: { sendMessage() {} }
  };
  Object.defineProperty(window, 'location', { value: new NativeURL(url), configurable: true });
  window.chrome = chrome;
  window.vypodeInjected = false;
  window.console = console;
  window.fetch = async () => ({ ok: true, status: 200, text: async () => '<html></html>' });
  window.Image = class { set src(v) { this._src = v; } get src() { return this._src; } };
  window.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, Math.min(ms || 0, 2), ...args);
  window.clearTimeout = nativeClearTimeout;
  vm.createContext(window);
  vm.runInContext(filmStateSource, window, { filename: 'film-state.js' });
  vm.runInContext(contentSource, window, { filename: 'content.js' });
  await new Promise((r) => nativeSetTimeout(r, 10));
  return { window };
}

const tick = (ms = 10) => new Promise((r) => nativeSetTimeout(r, ms));

test('deck builds from unhydrated React LazyPoster components', async () => {
  const html = `
    <html><body>
      <header><a href="/sign-in/">Sign In</a></header>
      <div class="grid">
        ${reactPoster('dune-part-two', 'Dune: Part Two (2024)')}
        ${reactPoster('past-lives', 'Past Lives (2023)')}
      </div>
    </body></html>
  `;
  const { window } = await runContent(html, 'https://letterboxd.com/somebody/films/');
  const toggle = window.document.querySelector('.vypode-toggle-btn');
  assert.ok(toggle, 'toggle button injected');
  toggle.click();
  await tick(20);
  const card = window.document.querySelector('#vypodeCard .vypode-card-title');
  assert.ok(card, 'deck card rendered');
  assert.equal(card.textContent.trim(), 'Dune: Part Two (2024)');
  const counter = window.document.querySelector('.vypode-deck-counter');
  assert.equal(counter.textContent.trim(), '1 / 2');
});

test('hydrated React components contribute poster URLs and years', async () => {
  const html = `
    <html><body>
      <header><a href="/sign-in/">Sign In</a></header>
      ${reactPoster('arrival-2016', 'Arrival (2016)', { hydrated: true })}
    </body></html>
  `;
  const { window } = await runContent(html, 'https://letterboxd.com/somebody/films/');
  window.document.querySelector('.vypode-toggle-btn').click();
  await tick(20);
  const img = window.document.querySelector('#vypodeCard .vypode-card-bg');
  assert.match(img.getAttribute('src'), /img\.test\/arrival-2016\.jpg/);
});

test('mixed React + classic markup dedupes by slug', async () => {
  const html = `
    <html><body>
      <header><a href="/sign-in/">Sign In</a></header>
      ${reactPoster('heat-1995', 'Heat (1995)', { hydrated: true })}
      <ul>
        ${classicPoster('heat-1995', 'Heat (1995)', 'https://img.test/heat-dupe.jpg')}
        ${classicPoster('ronin-1998', 'Ronin (1998)', 'https://img.test/ronin.jpg')}
      </ul>
    </body></html>
  `;
  const { window } = await runContent(html, 'https://letterboxd.com/somebody/list/crime/');
  window.document.querySelector('.vypode-toggle-btn').click();
  await tick(20);
  const counter = window.document.querySelector('.vypode-deck-counter');
  assert.equal(counter.textContent.trim(), '1 / 2', 'heat-1995 deduped across markups');
});
