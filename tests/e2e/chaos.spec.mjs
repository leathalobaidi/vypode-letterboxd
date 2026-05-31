// Content-layer chaos tests (v6.0 hardening). Drives the REAL content.js +
// film-state.js in a linkedom+vm sandbox with a controllable, recording fetch.
// Focus: partial/offline sync must fail safely without erasing flags, and the
// deck must never invent a /page/2/ that the page did not link.

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

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function storageArea(initial = {}) {
  const store = clone(initial) || {};
  return {
    store,
    get(keys, cb) {
      const r = {};
      if (Array.isArray(keys)) for (const k of keys) r[k] = clone(store[k]);
      else if (typeof keys === 'string') r[keys] = clone(store[keys]);
      else Object.assign(r, clone(store));
      cb(r);
    },
    set(items, cb) { Object.assign(store, clone(items)); cb?.(); },
    remove(keys, cb) { for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]; cb?.(); }
  };
}

function signedInHeader(u = 'BusyBees1') {
  return `<header>
    <a href="/${u}/">Profile</a><a href="/${u}/films/">Films</a>
    <a href="/${u}/films/diary/">Diary</a><a href="/sign-out/">Sign Out</a>
  </header>`;
}

function singleFilmPage() {
  return `<html><body>${signedInHeader()}
    <h1 class="headline-1">Arrival</h1>
    <p class="releaseyear"><a>2016</a></p>
    <div class="film-poster"><img src="https://img.test/arrival.jpg"></div>
    <a class="action -watch" href="#">Watch</a>
    <a class="action -like" href="#">Like</a>
    <a class="action -watchlist" href="#">Watchlist</a>
  </body></html>`;
}

function poster(slug, title, src) {
  return `<li class="poster-container"><div class="film-poster">
    <a href="/film/${slug}/"><img alt="Poster for ${title}" src="${src}"></a>
  </div></li>`;
}

// A listing page with NO pagination controls at all.
function listingNoPagination() {
  return `<html><body>${signedInHeader()}
    <ul class="poster-list">
      ${poster('fresh-one', 'Fresh One (2020)', 'https://img.test/1.jpg')}
      ${poster('fresh-two', 'Fresh Two (2021)', 'https://img.test/2.jpg')}
    </ul>
  </body></html>`;
}

function registry(slugs) { return { _meta: { version: 2 }, slugs }; }

function makeFetch() {
  const calls = [];
  const seen = new Set();
  let mode = 'ok';
  const okResponse = (url) => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => singleFilmPage(),
    json: async () => ({ csrf: 'csrf-token', lid: 'film-lid', url })
  });
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (mode === 'reject') throw new Error('Failed to fetch (offline)');
    if (mode === 'http500') return { ok: false, status: 500, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    if (mode === 'throttleThenOk') {
      // First hit of each URL is throttled (429 + Retry-After), then it recovers.
      if (!seen.has(u)) {
        seen.add(u);
        return { ok: false, status: 429, headers: { get: h => (h === 'Retry-After' ? '0' : null) }, text: async () => '', json: async () => ({}) };
      }
      return okResponse(u);
    }
    return okResponse(u);
  };
  return { fn, calls, setMode: m => { mode = m; } };
}

function installGlobals(window, url, chrome, fetchObj) {
  Object.defineProperty(window, 'location', { value: new NativeURL(url), configurable: true });
  window.chrome = chrome;
  window.vypodeInjected = false;
  window.console = console;
  window.fetch = fetchObj.fn;
  window.confirm = () => true;
  window.AbortController = globalThis.AbortController;
  window.DOMParser = class { parseFromString(html) { return parseHTML(html).document; } };
  window.Image = class { set src(v) { this._src = v; } get src() { return this._src; } };
  window.Blob = globalThis.Blob;
  window.URL = NativeURL;
  window.URL.createObjectURL = () => 'blob:vypode-test';
  window.URL.revokeObjectURL = () => {};
  window.setTimeout = (f, ms, ...a) => nativeSetTimeout(f, Math.min(ms || 0, 2), ...a);
  window.clearTimeout = nativeClearTimeout;
}

async function runContent(html, url, { local = {}, sync = {} } = {}) {
  const { window } = parseHTML(html);
  const chrome = { storage: { local: storageArea(local), sync: storageArea(sync) }, runtime: { sendMessage() {}, lastError: null } };
  const fetchObj = makeFetch();
  installGlobals(window, url, chrome, fetchObj);
  vm.createContext(window);
  vm.runInContext(filmStateSource, window, { filename: 'film-state.js' });
  vm.runInContext(contentSource, window, { filename: 'content.js' });
  await tick(8);
  return { window, chrome, fetchObj };
}

function tick(ms = 5) { return new Promise(r => nativeSetTimeout(r, ms)); }
function click(doc, sel) { const el = doc.querySelector(sel); assert.ok(el, `${sel} should exist`); el.click(); return el; }

// Poll until predicate() is truthy or we time out — removes fixed-delay flakiness
// when waiting on an async sync to reach a terminal state.
async function waitFor(predicate, { timeout = 1000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(step);
  }
  return predicate();
}

// The sync status element reaches a stable terminal string once a sync settles.
function syncSettled(window) {
  const t = window.document.getElementById('vypodeSyncStatus')?.textContent || '';
  return /complete|failed|Last sync/i.test(t);
}

// ── Partial / offline sync must not erase flags ─────────────────────────────

test('offline sync (fetch rejects) fails safely and preserves existing flags', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry({
      // sourced as collectionSync: if a buggy sync wrongly reconciled, THIS would be erased.
      arrival: { title: 'Arrival', watched: true, watchedAt: '2024-01-01T00:00:00.000Z', source: 'collectionSync' }
    }) }
  });

  fetchObj.setMode('reject');               // simulate going offline before sync
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitFor(() => syncSettled(window));

  // Flag survived the failed sync — no reconcile/erase happened.
  assert.equal(window.VypodeFilmState.get('arrival').watched, true);
  // And the sync surfaced a failure to the user rather than silently "succeeding".
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /failed/i);
});

test('HTTP 500 mid-sync is treated as incomplete and preserves flags', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry({
      arrival: { title: 'Arrival', watched: true, watchedAt: '2024-01-01T00:00:00.000Z', source: 'collectionSync' }
    }) }
  });
  fetchObj.setMode('http500');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitFor(() => syncSettled(window));
  assert.equal(window.VypodeFilmState.get('arrival').watched, true);
});

// ── Throttling (429) must be retried, not treated as a fatal failure ────────

test('a 429 throttle is retried (Retry-After honoured) and the sync still completes', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry({ arrival: { title: 'Arrival', watched: true, source: 'collectionSync' } }) }
  });
  fetchObj.setMode('throttleThenOk');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitFor(() => syncSettled(window));

  // Proof of retry: at least one URL was fetched more than once (429 then 200).
  const counts = fetchObj.calls.reduce((m, u) => (m[u] = (m[u] || 0) + 1, m), {});
  const retried = Object.entries(counts).find(([, n]) => n >= 2);
  assert.ok(retried, `expected a retried URL; calls=${JSON.stringify(counts)}`);
  // And the throttle did NOT abort the sync as a failure.
  assert.doesNotMatch(window.document.body.textContent, /Sync failed/i);
});

// ── Pagination must not be invented ─────────────────────────────────────────

test('a listing with no pagination never fetches an invented /page/2/', async () => {
  const { window, fetchObj } = await runContent(listingNoPagination(), 'https://letterboxd.com/films/popular/', {
    local: {}
  });
  click(window.document, '.vypode-toggle-btn');
  await tick(12);

  // Exhaust the two-card deck by skipping.
  for (let i = 0; i < 3; i++) {
    const ev = new window.Event('keydown'); ev.key = 'ArrowDown';
    window.document.dispatchEvent(ev);
    await tick(8);
  }
  const inventedPageFetch = fetchObj.calls.find(u => /\/page\/\d+\//.test(u));
  assert.equal(inventedPageFetch, undefined, `must not fetch a paginated URL; saw ${inventedPageFetch}`);
});
