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

function collectionPage() {
  return `<html><body>${signedInHeader()}
    <ul class="poster-list">
      ${poster('arrival', 'Arrival (2016)', 'https://img.test/arrival.jpg')}
    </ul>
  </body></html>`;
}

function explicitEmptyCollectionPage() {
  return `<html><body>${signedInHeader()}<p class="empty-message">No films</p></body></html>`;
}

function diaryPage() {
  return `<html><body>${signedInHeader()}
    <table><tbody><tr class="diary-entry-row">
      <td class="col-daydate"><a class="daydate" href="/BusyBees1/diary/films/for/2023/01/05/">5 Jan 2023</a></td>
      <td><div data-item-slug="arrival" data-item-link="/film/arrival/" data-item-name="Arrival (2016)"></div></td>
      <td class="col-rating"><span class="rating rated-6">★★★</span></td>
      <td class="col-review"><a class="icon-review" href="/film/arrival/reviews/by/busybees1/old/">Review</a></td>
    </tr><tr class="diary-entry-row">
      <td class="col-daydate"><a class="daydate" href="/BusyBees1/diary/films/for/2024/04/03/">3 Apr 2024</a></td>
      <td><div data-item-slug="arrival" data-item-link="/film/arrival/" data-item-name="Arrival (2016)"></div></td>
      <td class="col-rating"><span class="rating rated-8">★★★★</span></td>
      <td class="col-like"><a class="icon-like" href="/film/arrival/">Liked</a></td>
      <td class="col-rewatch"><a class="icon-rewatch" href="/film/arrival/">Rewatched</a></td>
      <td class="col-review"><a class="icon-review" href="/film/arrival/reviews/by/busybees1/">Review</a></td>
    </tr></tbody></table>
  </body></html>`;
}

function diaryPageLatestUnreviewed() {
  return `<html><body>${signedInHeader()}
    <table><tbody><tr class="diary-entry-row">
      <td class="col-daydate"><a class="daydate" href="/BusyBees1/diary/films/for/2024/04/03/">3 Apr 2024</a></td>
      <td><div data-item-slug="arrival" data-item-link="/film/arrival/" data-item-name="Arrival (2016)"></div></td>
      <td class="col-rating"><span class="rating rated-8">★★★★</span></td>
      <td class="col-rewatch"><a class="icon-rewatch" href="/film/arrival/">Rewatched</a></td>
    </tr><tr class="diary-entry-row">
      <td class="col-daydate"><a class="daydate" href="/BusyBees1/diary/films/for/2023/01/05/">5 Jan 2023</a></td>
      <td><div data-item-slug="arrival" data-item-link="/film/arrival/" data-item-name="Arrival (2016)"></div></td>
      <td class="col-rating"><span class="rating rated-6">★★★</span></td>
      <td class="col-review"><a class="icon-review" href="/film/arrival/reviews/by/busybees1/old/">Review</a></td>
    </tr></tbody></table>
  </body></html>`;
}

function registry(slugs) { return { _meta: { version: 2 }, slugs }; }

function makeFetch() {
  const calls = [];
  const seen = new Set();
  let heldAborts = 0;
  let heldBodies = 0;
  let mode = 'ok';
  const holdUntilAborted = (signal) => new Promise((resolve, reject) => {
    const rejectAborted = () => {
      heldAborts++;
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) {
      rejectAborted();
      return;
    }
    signal?.addEventListener?.('abort', rejectAborted, { once: true });
  });
  const okResponse = (url) => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => /\/films\/diary\/page\//.test(url) ? explicitEmptyCollectionPage() : collectionPage(),
    json: async () => ({ csrf: 'csrf-token', lid: 'film-lid', url })
  });
  const fn = async (url, options = {}) => {
    const u = String(url);
    calls.push(u);
    if (mode === 'holdCollections') return holdUntilAborted(options.signal);
    if (mode === 'holdBodies') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => {
          heldBodies++;
          return holdUntilAborted(options.signal);
        },
        json: async () => ({})
      };
    }
    if (mode === 'holdReview') {
      if (/\/reviews\//.test(u)) return holdUntilAborted(options.signal);
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => /\/films\/diary\/page\//.test(u) ? diaryPage() : collectionPage(),
        json: async () => ({ csrf: 'csrf-token', lid: 'film-lid', url: u })
      };
    }
    if (mode === 'throttleLong') {
      return {
        ok: false,
        status: 429,
        headers: { get: header => (header === 'Retry-After' ? '30' : null) },
        text: async () => '',
        json: async () => ({})
      };
    }
    if (mode === 'reject') throw new Error('Failed to fetch (offline)');
    if (mode === 'http500') return { ok: false, status: 500, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    if (mode === 'html200Shell') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '<html><body><div data-src="/csi/profile/films/"></div></body></html>',
        json: async () => ({})
      };
    }
    if (mode === 'explicitEmpty') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => explicitEmptyCollectionPage(),
        json: async () => ({})
      };
    }
    if (mode === 'throttleThenOk') {
      // First hit of each URL is throttled (429 + Retry-After), then it recovers.
      if (!seen.has(u)) {
        seen.add(u);
        return { ok: false, status: 429, headers: { get: h => (h === 'Retry-After' ? '0' : null) }, text: async () => '', json: async () => ({}) };
      }
      return okResponse(u);
    }
    if (mode === 'diaryExact') {
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => /\/films\/diary\/page\//.test(u) ? diaryPage() : collectionPage(),
        json: async () => ({ csrf: 'csrf-token', lid: 'film-lid', url: u })
      };
    }
    if (mode === 'changedReviewFails') {
      if (u === 'https://letterboxd.com/film/arrival/reviews/by/busybees1/') {
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => /\/films\/diary\/page\//.test(u) ? diaryPage() : collectionPage(),
        json: async () => ({ csrf: 'csrf-token', lid: 'film-lid', url: u })
      };
    }
    if (mode === 'latestUnreviewed') {
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => {
          if (/\/films\/diary\/page\//.test(u)) return diaryPageLatestUnreviewed();
          if (u === 'https://letterboxd.com/film/arrival/reviews/by/busybees1/old/') {
            return '<html><body><div class="js-review-body">Older review survives rewatch</div></body></html>';
          }
          return collectionPage();
        },
        json: async () => ({ csrf: 'csrf-token', lid: 'film-lid', url: u })
      };
    }
    if (mode === 'diaryInvalid') {
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => /\/films\/diary\/page\//.test(u)
          ? '<html><body>' + signedInHeader() + '<p>Diary loading…</p></body></html>'
          : collectionPage(),
        json: async () => ({ csrf: 'csrf-token', lid: 'film-lid', url: u })
      };
    }
    return okResponse(u);
  };
  return {
    fn,
    calls,
    get heldAborts() { return heldAborts; },
    get heldBodies() { return heldBodies; },
    setMode: m => { mode = m; }
  };
}

function installGlobals(window, url, chrome, fetchObj, timerCap = 2) {
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
  window.setTimeout = (f, ms, ...a) => nativeSetTimeout(f, Math.min(ms || 0, timerCap), ...a);
  window.clearTimeout = nativeClearTimeout;
}

async function runContent(html, url, { local = {}, sync = {}, timerCap = 2 } = {}) {
  const { window } = parseHTML(html);
  const chrome = { storage: { local: storageArea(local), sync: storageArea(sync) }, runtime: { sendMessage() {}, lastError: null } };
  const fetchObj = makeFetch();
  installGlobals(window, url, chrome, fetchObj, timerCap);
  vm.createContext(window);
  vm.runInContext(filmStateSource, window, { filename: 'film-state.js' });
  vm.runInContext(contentSource, window, { filename: 'content.js' });
  await waitFor(() => window.document.querySelector('.vypode-toggle-btn'), { timeout: 1000 });
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
  const state = window.document.getElementById('vypodeSyncStatus')?.dataset?.state || '';
  return state === 'done' || state === 'error' || state === 'cancelled' || state === 'account-changed';
}

async function waitForSync(window) {
  const settled = await waitFor(() => syncSettled(window));
  assert.equal(settled, true, 'sync should reach a post-click terminal state');
}

// ── Partial / offline sync must not erase flags ─────────────────────────────

test('collection sync can cancel held page fetches without writes and restart immediately', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    timerCap: 100
  });
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  const writes = { bulk: 0, reconcile: 0, meta: 0 };
  const originalBulk = window.VypodeFilmState.bulkSetFromSync.bind(window.VypodeFilmState);
  const originalReconcile = window.VypodeFilmState.reconcileFlags.bind(window.VypodeFilmState);
  const originalMeta = window.VypodeFilmState.setSyncMeta.bind(window.VypodeFilmState);
  window.VypodeFilmState.bulkSetFromSync = (...args) => { writes.bulk++; return originalBulk(...args); };
  window.VypodeFilmState.reconcileFlags = (...args) => { writes.reconcile++; return originalReconcile(...args); };
  window.VypodeFilmState.setSyncMeta = (...args) => { writes.meta++; return originalMeta(...args); };

  fetchObj.setMode('holdCollections');
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => fetchObj.calls.length >= 4), true, 'all collection stages should be in flight');
  let syncButton = window.document.getElementById('vypodeSyncBtn');
  assert.equal(syncButton.disabled, false);
  assert.equal(syncButton.textContent, 'Cancel sync');

  // Closing settings must not hide the fact that the background work is still
  // cancellable when the panel is opened again.
  click(window.document, '#vypodeSettingsClose');
  await tick(8);
  click(window.document, '#vypodeOpenSettings');
  await tick(8);
  syncButton = window.document.getElementById('vypodeSyncBtn');
  assert.equal(syncButton.disabled, false);
  assert.equal(syncButton.textContent, 'Cancel sync');

  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => syncSettled(window)), true, 'cancel should settle promptly');
  assert.equal(window.document.getElementById('vypodeSyncStatus').dataset.state, 'cancelled');
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /Sync cancelled/i);
  assert.equal(syncButton.disabled, false);
  assert.equal(syncButton.textContent, 'Sync now');
  assert.deepEqual(writes, { bulk: 0, reconcile: 0, meta: 0 });
  assert.equal(fetchObj.heldAborts, 4, 'every in-flight collection request should be aborted');

  fetchObj.setMode('ok');
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);
  assert.equal(window.document.getElementById('vypodeSyncStatus').dataset.state, 'done');
  assert.equal(writes.bulk, 1);
  assert.equal(writes.reconcile, 1);
  assert.equal(writes.meta, 1);
});

test('cancelling review hydration discards every staged collection result', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    timerCap: 100
  });
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  const before = clone(window.VypodeFilmState.getAll());
  const writes = { bulk: 0, reconcile: 0, meta: 0 };
  for (const [method, key] of [['bulkSetFromSync', 'bulk'], ['reconcileFlags', 'reconcile'], ['setSyncMeta', 'meta']]) {
    const original = window.VypodeFilmState[method].bind(window.VypodeFilmState);
    window.VypodeFilmState[method] = (...args) => { writes[key]++; return original(...args); };
  }

  fetchObj.setMode('holdReview');
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => fetchObj.calls.some(url => /\/reviews\//.test(url))), true, 'review hydration should start');
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /Loading review text/i);
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => syncSettled(window)), true, 'review cancellation should settle promptly');

  assert.equal(window.document.getElementById('vypodeSyncStatus').dataset.state, 'cancelled');
  assert.deepEqual(writes, { bulk: 0, reconcile: 0, meta: 0 });
  assert.deepEqual(clone(window.VypodeFilmState.getAll()), before);
  assert.equal(fetchObj.heldAborts, 1);
});

test('cancel remains active after response headers while collection bodies are hanging', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    timerCap: 100
  });
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  const writes = { bulk: 0, reconcile: 0, meta: 0 };
  for (const [method, key] of [['bulkSetFromSync', 'bulk'], ['reconcileFlags', 'reconcile'], ['setSyncMeta', 'meta']]) {
    const original = window.VypodeFilmState[method].bind(window.VypodeFilmState);
    window.VypodeFilmState[method] = (...args) => { writes[key]++; return original(...args); };
  }

  fetchObj.setMode('holdBodies');
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => fetchObj.heldBodies === 4), true, 'all response headers should resolve and body reads should start');
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => syncSettled(window), { timeout: 250 }), true);

  assert.equal(window.document.getElementById('vypodeSyncStatus').dataset.state, 'cancelled');
  assert.equal(fetchObj.heldAborts, 4, 'the parent cancellation signal must reach every response body');
  assert.deepEqual(writes, { bulk: 0, reconcile: 0, meta: 0 });
});

test('response-body timeout fails safely instead of hanging or appearing cancelled', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    timerCap: 40
  });
  click(window.document, '.vypode-toggle-btn');
  await tick(15);
  click(window.document, '#vypodeOpenSettings');
  await tick(15);

  let syncWrites = 0;
  for (const method of ['bulkSetFromSync', 'reconcileFlags', 'setSyncMeta']) {
    const original = window.VypodeFilmState[method].bind(window.VypodeFilmState);
    window.VypodeFilmState[method] = (...args) => { syncWrites++; return original(...args); };
  }
  fetchObj.setMode('holdBodies');
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => fetchObj.heldBodies === 4), true);
  assert.equal(await waitFor(() => syncSettled(window), { timeout: 250 }), true, 'body timeout should settle the sync');

  assert.equal(window.document.getElementById('vypodeSyncStatus').dataset.state, 'error');
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /failed/i);
  assert.equal(fetchObj.heldAborts, 4);
  assert.equal(syncWrites, 0);
});

test('an active FilmState account change aborts staged sync before any commit', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    timerCap: 100
  });
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  const writes = { bulk: 0, reconcile: 0, meta: 0 };
  for (const [method, key] of [['bulkSetFromSync', 'bulk'], ['reconcileFlags', 'reconcile'], ['setSyncMeta', 'meta']]) {
    const original = window.VypodeFilmState[method].bind(window.VypodeFilmState);
    window.VypodeFilmState[method] = (...args) => { writes[key]++; return original(...args); };
  }

  fetchObj.setMode('holdBodies');
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => fetchObj.heldBodies === 4), true);
  await window.VypodeFilmState.switchAccount('Bob');
  assert.equal(await waitFor(() => syncSettled(window), { timeout: 250 }), true);

  assert.equal(window.VypodeFilmState.getAccountId(), 'user:bob');
  assert.equal(window.document.getElementById('vypodeSyncStatus').dataset.state, 'account-changed');
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /account changed/i);
  assert.deepEqual(writes, { bulk: 0, reconcile: 0, meta: 0 });
  assert.equal(window.VypodeFilmState.getMeta().lastSyncAt, null);
  assert.equal(fetchObj.heldAborts, 4);
});

test('cancelling interrupts Retry-After backoff instead of waiting for another request', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    timerCap: 100
  });
  click(window.document, '.vypode-toggle-btn');
  await tick(15);
  click(window.document, '#vypodeOpenSettings');
  await tick(15);

  fetchObj.setMode('throttleLong');
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => fetchObj.calls.length === 4), true, 'all stages should receive their first throttle response');
  await tick(10); // allow fetchWithRetry to enter its 30-second Retry-After sleep
  assert.equal(fetchObj.calls.length, 4, 'no retry should have fired yet');

  const cancelledAt = Date.now();
  click(window.document, '#vypodeSyncBtn');
  assert.equal(await waitFor(() => syncSettled(window), { timeout: 250 }), true);
  assert.equal(window.document.getElementById('vypodeSyncStatus').dataset.state, 'cancelled');
  assert.ok(Date.now() - cancelledAt < 250, 'cancellation should interrupt backoff promptly');
  assert.equal(fetchObj.calls.length, 4, 'cancellation must prevent retry requests');
});

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
  await waitForSync(window);

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
  await waitForSync(window);
  assert.equal(window.VypodeFilmState.get('arrival').watched, true);
});

test('an HTTP-200 login or dynamic shell is incomplete and cannot erase collection flags', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry({
      arrival: { title: 'Arrival', watched: true, source: 'collectionSync' }
    }) }
  });
  fetchObj.setMode('html200Shell');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);

  assert.equal(window.VypodeFilmState.get('arrival').watched, true);
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /failed/i);
});

test('a suspicious mass drop aborts reconciliation even when empty pages are explicit', async () => {
  const slugs = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `watched-${index}`,
    { title: `Watched ${index}`, watched: true, source: 'collectionSync' }
  ]));
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry(slugs) }
  });
  fetchObj.setMode('explicitEmpty');
  assert.equal(window.VypodeFilmState.get('watched-0').watchedSource, 'collectionSync');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);

  assert.equal(window.VypodeFilmState.get('watched-0').watched, true);
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /failed/i);
});

test('mass-drop guard uses per-flag provenance after metadata browsing changes entry source', async () => {
  const slugs = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `watched-${index}`,
    {
      title: `Watched ${index}`,
      watched: true,
      source: 'domSync',
      metadataSource: 'domSync',
      watchedSource: 'collectionSync'
    }
  ]));
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry(slugs) }
  });
  fetchObj.setMode('explicitEmpty');
  assert.equal(window.VypodeFilmState.get('watched-0').watchedSource, 'collectionSync');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);

  assert.equal(window.VypodeFilmState.get('watched-0').watched, true);
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /failed/i);
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
  await waitForSync(window);

  // Proof of retry: at least one URL was fetched more than once (429 then 200).
  const counts = fetchObj.calls.reduce((m, u) => (m[u] = (m[u] || 0) + 1, m), {});
  const retried = Object.entries(counts).find(([, n]) => n >= 2);
  assert.ok(retried, `expected a retried URL; calls=${JSON.stringify(counts)}`);
  // And the throttle did NOT abort the sync as a failure.
  assert.doesNotMatch(window.document.body.textContent, /Sync failed/i);
});

test('an explicit empty diary does not remove watched films found by the all-films stage', async () => {
  const { window } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);

  const state = window.VypodeFilmState.get('arrival');
  assert.equal(state.watched, true);
  assert.equal(state.watchedDate, null);
});

test('an invalid diary response aborts before staged collection changes reach local state', async () => {
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry({
      arrival: { title: 'Arrival', watched: true, watchedDate: '2022-02-02', ratingValue: 2, source: 'collectionSync' }
    }) }
  });
  fetchObj.setMode('diaryInvalid');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);

  const state = window.VypodeFilmState.get('arrival');
  assert.equal(state.watchedDate, '2022-02-02');
  assert.equal(state.ratingValue, 2);
  assert.match(window.document.getElementById('vypodeSyncStatus').textContent, /failed/i);
});

test('diary sync stores its exact newest date while cached matching reviews avoid a fetch on resync', async () => {
  const reviewUrl = 'https://letterboxd.com/film/arrival/reviews/by/busybees1/';
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry({
      arrival: {
        title: 'Arrival',
        watched: true,
        reviewUrl,
        reviewText: 'Cached review text',
        source: 'collectionSync'
      }
    }) }
  });
  fetchObj.setMode('diaryExact');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);

  const state = window.VypodeFilmState.get('arrival');
  assert.equal(state.watched, true, 'the all-films watched flag survives diary enrichment');
  assert.equal(state.watchedDate, '2024-04-03');
  assert.equal(state.ratingValue, 4, 'rated-8 is stored as four stars');
  assert.equal(state.reviewText, 'Cached review text');
  assert.equal(fetchObj.calls.some(url => url === reviewUrl), false, `matching cached review must not refetch: ${JSON.stringify(fetchObj.calls)}`);
});

test('a failed changed review URL keeps the old URL/text pair and retries the new URL next sync', async () => {
  const oldUrl = 'https://letterboxd.com/film/arrival/reviews/by/busybees1/old/';
  const newUrl = 'https://letterboxd.com/film/arrival/reviews/by/busybees1/';
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/', {
    local: { vypode_state: registry({ arrival: {
      title: 'Arrival', watched: true, reviewUrl: oldUrl,
      reviewText: 'Known old review', source: 'collectionSync'
    } }) }
  });
  fetchObj.setMode('changedReviewFails');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();

  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);

  const state = window.VypodeFilmState.get('arrival');
  assert.equal(state.reviewUrl, oldUrl);
  assert.equal(state.reviewText, 'Known old review');
  assert.equal(fetchObj.calls.filter(url => url === newUrl).length, 2);
});

test('latest diary row owns date and rating while an older review remains discoverable', async () => {
  const oldUrl = 'https://letterboxd.com/film/arrival/reviews/by/busybees1/old/';
  const { window, fetchObj } = await runContent(singleFilmPage(), 'https://letterboxd.com/film/arrival/');
  fetchObj.setMode('latestUnreviewed');
  click(window.document, '.vypode-toggle-btn');
  await tick();
  click(window.document, '#vypodeOpenSettings');
  await tick();
  click(window.document, '#vypodeSyncBtn');
  await waitForSync(window);

  const state = window.VypodeFilmState.get('arrival');
  assert.equal(state.watchedDate, '2024-04-03');
  assert.equal(state.ratingValue, 4);
  assert.equal(state.reviewUrl, oldUrl);
  assert.equal(state.reviewText, 'Older review survives rewatch');
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
