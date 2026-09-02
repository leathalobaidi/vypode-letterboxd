import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const backgroundJs = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

function shortPopupTimeout(fn, ms, ...args) {
  return nativeSetTimeout(fn, Math.min(ms, 20), ...args);
}

function renderPopup(storageResult) {
  const elements = Object.create(null);
  const element = () => ({
    textContent: '', className: '', dataset: {}, disabled: false, title: '',
    addEventListener() {}, setAttribute() {}
  });
  const context = {
    URL,
    setTimeout: shortPopupTimeout,
    clearTimeout: nativeClearTimeout,
    document: { getElementById(id) { return elements[id] || (elements[id] = element()); } },
    chrome: {
      storage: {
        local: { get(keys, callback) { callback(storageResult); } },
        onChanged: { addListener() {} }
      },
      tabs: { query(query, callback) { callback([{ id: 1, url: 'https://letterboxd.com/films/' }]); } }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(popupJs, context, { filename: 'popup.js' });
  return elements;
}

async function createPopupHarness({
  url = 'https://letterboxd.com/film/arrival/',
  storageResult = { vypode_user: { username: 'Alice', active: true } },
  respond
} = {}) {
  const elements = Object.create(null);
  const messages = [];
  const makeElement = id => {
    const listeners = new Map();
    const attributes = new Map();
    return {
      id,
      textContent: '',
      className: '',
      dataset: {},
      disabled: false,
      title: '',
      addEventListener(type, listener) { listeners.set(type, listener); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      click() {
        if (this.disabled) return;
        listeners.get('click')?.({ currentTarget: this, target: this });
      }
    };
  };
  const context = {
    URL,
    setTimeout: shortPopupTimeout,
    clearTimeout: nativeClearTimeout,
    document: {
      getElementById(id) {
        return elements[id] || (elements[id] = makeElement(id));
      }
    },
    chrome: {
      storage: {
        local: { get(keys, callback) { callback(storageResult); } },
        onChanged: { addListener() {} }
      },
      tabs: {
        query(query, callback) { callback([{ id: 7, url }]); },
        async sendMessage(tabId, message) {
          messages.push({ tabId, message: structuredClone(message) });
          return respond ? respond(message, messages.length) : undefined;
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(popupJs, context, { filename: 'popup.js' });
  await new Promise(resolve => setImmediate(resolve));
  return {
    context,
    elements,
    messages,
    flush: () => new Promise(resolve => setImmediate(resolve))
  };
}

test('popup uses an external script and exposes all registry stats', () => {
  assert.match(popupHtml, /<script src="popup\.js"><\/script>/);
  assert.doesNotMatch(popupHtml, /<script>(?!\s*<\/script>)/);

  for (const id of ['statWatched', 'statLiked', 'statWatchlist', 'statSkipped', 'statRated', 'statReviewed']) {
    assert.match(popupHtml, new RegExp(`id="${id}"`));
    assert.match(popupJs, new RegExp(`'${id}'`));
  }
});

test('settings panel includes complete local database controls and no cloud backup UI', () => {
  for (const id of ['vypodeDbSearch', 'vypodeDbFilter', 'vypodeDbGenreFilter', 'vypodeDbDateFilter', 'vypodeDbSort', 'vypodeDbSummary', 'vypodeDbList']) {
    assert.match(contentJs, new RegExp(id));
  }

  for (const label of ['watched', 'liked', 'watchlist', 'rated', 'reviewed', 'missing-rating', 'skipped']) {
    assert.match(contentJs, new RegExp(`value="${label}"`));
  }
  for (const label of ['watched-with-date', 'watched-last-30', 'watched-this-year', 'missing-watched-date', 'watchedAt']) {
    assert.match(contentJs, new RegExp(`value="${label}"`));
  }

  assert.doesNotMatch(contentJs, /Cloud Backup|Sign in with Google|Restore from cloud|Back up to cloud/);
});

test('review and local data copy sets the right user expectations', () => {
  assert.match(contentJs, /Your draft stays on this device until Letterboxd confirms the entry/);
  for (const id of ['vypodeDiaryDate', 'vypodeRewatch', 'vypodeSpoilers', 'vypodeReviewLike', 'vypodeReviewTags']) {
    assert.match(contentJs, new RegExp(id));
  }
  assert.match(contentJs, /data-rating="\$\{value\}"/);
  assert.match(contentJs, /\[0\.5,1,1\.5,2,2\.5,3,3\.5,4,4\.5,5\]/);
  assert.match(contentJs, /local-only database on this device/);
  assert.match(contentJs, /Clear local film data/);
  assert.match(contentJs, /Chrome-synced interface preferences are kept/);
  assert.match(contentJs, /minimal account\/film safety lock/);
});

test('account-changing actions require an active Letterboxd session', () => {
  assert.match(contentJs, /let isLetterboxdSessionActive = false/);
  assert.match(contentJs, /function requireActiveLetterboxdSession/);
  assert.match(contentJs, /Log in to Letterboxd to/);
  assert.match(contentJs, /ACCOUNT_ACTIONS = new Set\(\['watch', 'like', 'watchlist'\]\)/);
  assert.match(contentJs, /requireActiveLetterboxdSession\(labels\[action\]\)/);
  assert.match(contentJs, /requireActiveLetterboxdSession\(actionLabels\[action\]\)/);
  assert.match(contentJs, /if \(!requireActiveLetterboxdSession\('submit reviews'\)\) return/);
  assert.match(contentJs, /Log in to submit/);
});

test('visible deck actions expose touch-sized responsive controls and keyboard hints', () => {
  for (const [action, shortcut] of [
    ['watch', 'ArrowLeft'], ['like', 'ArrowUp'], ['watchlist', 'ArrowRight'], ['skip', 'ArrowDown']
  ]) {
    assert.match(contentJs, new RegExp(`<button type="button" class="vypode-action-control [^"]+" data-action="${action}" aria-keyshortcuts="${shortcut}"`));
  }
  assert.match(stylesCss, /\.vypode-action-control\s*\{[^}]*min-height:\s*44px/s);
  assert.match(stylesCss, /@media \(max-width:\s*520px\)[\s\S]*?\.vypode-action-controls\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
});

test('cached profile is not presented as an active login', () => {
  assert.match(contentJs, /active: false/);
  assert.match(contentJs, /Not logged in to Letterboxd/);
  assert.doesNotMatch(contentJs, /Last profile:/);
  assert.match(popupJs, /Stored account data; sign in to confirm this session/);
  assert.match(popupJs, /function displayedAccount/);
  assert.match(popupJs, /receiverReady && activeLogin/);
  assert.match(popupJs, /Log in to Letterboxd and refresh/);
});

test('popup uses the persisted displayed account consistently when a detected session differs', () => {
  const elements = renderPopup({
    vypode_user: { username: 'Alice', active: true },
    vypode_state: {
      _meta: { version: 3, activeAccount: 'user:bob' },
      accounts: {
        'user:bob': { slugs: { arrival: { watched: true } } }
      }
    },
    vypode_action_outbox_v1: {
      alice: { account: 'alice' },
      bob: { account: 'bob' }
    }
  });

  assert.equal(elements.accountName.textContent, 'bob');
  assert.equal(elements.accountStatus.textContent, 'Showing bob; detected session is Alice');
  assert.equal(elements.statWatched.textContent, '1');
  assert.equal(elements.popupPendingCount.textContent, '1');
  assert.equal(elements.syncNowBtn.disabled, true);
});

test('popup renders an empty install without a stored state object', () => {
  const elements = renderPopup({});
  assert.equal(elements.accountName.textContent, 'No Letterboxd account detected');
  assert.equal(elements.statWatched.textContent, '0');
  assert.equal(elements.popupPendingCount.textContent, '0');
});

test('popup verifies a live receiver before enabling quick actions', async () => {
  const harness = await createPopupHarness({
    respond(message) {
      assert.equal(message.action, 'ping');
      return {
        ok: true,
        supported: true,
        capabilities: { resumeSwipe: true, syncNow: true, openSettings: true }
      };
    }
  });

  assert.deepEqual(harness.messages.map(call => call.message.action), ['ping']);
  assert.equal(harness.elements.popupHealth.dataset.state, 'ready');
  assert.equal(harness.elements.resumeSwipeBtn.disabled, false);
  assert.equal(harness.elements.syncNowBtn.disabled, false);
  assert.equal(harness.elements.openSettingsBtn.disabled, false);
});

for (const route of ['trailer/', 'reviews/', 'members/', 'details/']) {
  test(`popup rejects unsupported film subroute /film/arrival/${route}`, async () => {
    const harness = await createPopupHarness({
      url: `https://letterboxd.com/film/arrival/${route}`,
      respond() { throw new Error('unsupported routes must not be probed'); }
    });
    assert.equal(harness.messages.length, 0);
    assert.equal(harness.elements.popupHealth.dataset.state, 'warning');
    assert.equal(harness.elements.resumeSwipeBtn.disabled, true);
    assert.equal(harness.elements.openSettingsBtn.disabled, true);
  });
}

test('popup locks only the invoked action until an explicit ok response arrives', async () => {
  let finishAction;
  const harness = await createPopupHarness({
    respond(message) {
      if (message.action === 'ping') {
        return {
          ok: true,
          supported: true,
          capabilities: { resumeSwipe: true, syncNow: true, openSettings: true }
        };
      }
      return new Promise(resolve => { finishAction = resolve; });
    }
  });

  harness.elements.resumeSwipeBtn.click();
  await harness.flush();
  assert.equal(harness.messages.filter(call => call.message.action === 'resumeSwipe').length, 1);
  assert.equal(harness.elements.resumeSwipeBtn.disabled, true);
  assert.equal(harness.elements.resumeSwipeBtn.getAttribute('aria-busy'), 'true');
  assert.equal(harness.elements.openSettingsBtn.disabled, false, 'unrelated controls should remain available');

  harness.elements.resumeSwipeBtn.click();
  assert.equal(harness.messages.filter(call => call.message.action === 'resumeSwipe').length, 1);
  finishAction({ ok: true, message: 'Swipe opened.' });
  await harness.flush();
  assert.equal(harness.elements.resumeSwipeBtn.disabled, false);
  assert.equal(harness.elements.resumeSwipeBtn.getAttribute('aria-busy'), 'false');
  assert.equal(harness.elements.resumeSwipeDetail.textContent, 'Swipe opened.');
});

test('popup treats an absent ok:true confirmation as failure', async () => {
  const harness = await createPopupHarness({
    respond(message) {
      if (message.action === 'ping') {
        return {
          ok: true,
          supported: true,
          capabilities: { resumeSwipe: true, syncNow: true, openSettings: true }
        };
      }
      return undefined;
    }
  });

  harness.elements.openSettingsBtn.click();
  await harness.flush();
  assert.match(harness.elements.openSettingsDetail.textContent, /did not confirm this action/i);
  assert.equal(harness.elements.popupHealth.dataset.state, 'error');
  assert.equal(harness.elements.openSettingsBtn.disabled, true);
});

test('popup times out a non-responsive readiness probe', async () => {
  const harness = await createPopupHarness({
    respond() { return new Promise(() => {}); }
  });

  await new Promise(resolve => nativeSetTimeout(resolve, 30));
  assert.equal(harness.elements.popupHealth.dataset.state, 'error');
  assert.equal(harness.elements.popupHealth.getAttribute('aria-busy'), 'false');
  assert.equal(harness.elements.resumeSwipeBtn.disabled, true);
  assert.equal(harness.elements.openSettingsBtn.disabled, true);
});

test('popup times out an action and releases its busy button', async () => {
  const harness = await createPopupHarness({
    respond(message) {
      if (message.action === 'ping') {
        return {
          ok: true,
          supported: true,
          capabilities: { resumeSwipe: true, syncNow: true, openSettings: true }
        };
      }
      return new Promise(() => {});
    }
  });

  harness.elements.resumeSwipeBtn.click();
  assert.equal(harness.elements.resumeSwipeBtn.getAttribute('aria-busy'), 'true');
  await new Promise(resolve => nativeSetTimeout(resolve, 30));

  assert.equal(harness.elements.resumeSwipeBtn.getAttribute('aria-busy'), 'false');
  assert.equal(harness.elements.resumeSwipeBtn.disabled, true);
  assert.equal(harness.elements.popupHealth.dataset.state, 'error');
  assert.match(harness.elements.resumeSwipeDetail.textContent, /did not respond in time/i);
});

test('account detection recognizes the current signed-in Letterboxd menu', () => {
  assert.match(contentJs, /function usernameFromProfileHref/);
  assert.match(contentJs, /hasSignOutLink/);
  assert.match(contentJs, /text === 'profile'/);
  assert.match(contentJs, /text === username\.toLowerCase\(\)/);
});

test('single film state detection handles current Letterboxd action classes', () => {
  assert.match(contentJs, /watchedState: '.*\.action\.-watch\.-on/);
  assert.match(contentJs, /likedState: '.*\.action\.-like\.-on/);
  assert.match(contentJs, /watchlistState: '.*\.action\.-watchlist\.-on/);
  assert.match(contentJs, /watchlistState: '.*\.remove-from-watchlist/);
  // v6.2.0 consolidated overlay-state detection into one extractor, so the
  // class must appear in BOTH the single-film SELECTORS and the (now single)
  // listing overlay check — two sites, not the old three copy-pasted ones.
  assert.ok((contentJs.match(/\.action\.-watch\.-on/g) || []).length >= 2);
  assert.ok((contentJs.match(/\.action\.-like\.-on/g) || []).length >= 2);
  assert.ok((contentJs.match(/\.action\.-watchlist\.-on/g) || []).length >= 2);
  assert.doesNotMatch(contentJs, /action\.-watched\.-checked/);
  assert.doesNotMatch(contentJs, /\?\.querySelector\([^)\n]+\) !== null/);
});

test('review submission uses the service worker and fixed Letterboxd production-log api', () => {
  assert.match(contentJs, /function readCsrfToken/);
  assert.match(contentJs, /value && value !== 'placeholder'/);
  assert.match(contentJs, /const csrf = readCsrfToken\(document\) \|\| filmData\.csrf/);
  assert.match(contentJs, /const productionId = filmData\.lid/);
  assert.match(contentJs, /type: 'vypode-review', action: 'submit'/);
  assert.doesNotMatch(contentJs, /api\/v0\/production-log-entries/);
  assert.match(backgroundJs, /https:\/\/api\.letterboxd\.com\/api\/v0\/production-log-entries/);
  assert.match(backgroundJs, /'X-CSRF-TOKEN': submission\.csrf/);
  assert.match(backgroundJs, /supportedReviewSender/);
  assert.doesNotMatch(contentJs, /querySelector\('input\\[name="__csrf"\\]'\)\\?\\.value/);
  assert.doesNotMatch(contentJs, /s\/save-diary-entry/);
});

test('collection sync requires the current browser session to be logged in', () => {
  assert.match(contentJs, /if \(!isLetterboxdSessionActive\) \{/);
  assert.match(contentJs, /Log in to Letterboxd to sync your profile/);
  assert.match(contentJs, /id="vypodeSyncBtn" \$\{!isLetterboxdSessionActive \? 'disabled' : ''\}/);
  assert.match(contentJs, /Log in to Letterboxd and refresh to sync your own profile database/);
});

test('collection sync preserves true flags when records appear in multiple collections', () => {
  assert.match(contentJs, /function mergeSyncedFilmRecord/);
  assert.match(contentJs, /merged\[flag\] = Boolean\(merged\[flag\] \|\| incoming\[flag\]\)/);
  assert.match(contentJs, /const incomplete = \[/);
  assert.match(contentJs, /throw new Error\(`Could not complete/);
  assert.match(contentJs, /stopped after \$\{maxPages\} pages/);
  assert.doesNotMatch(contentJs, /watched:\s*Boolean\(flags\?\.watched\)/);
  assert.doesNotMatch(contentJs, /liked:\s*Boolean\(flags\?\.liked\)/);
  assert.doesNotMatch(contentJs, /watchlist:\s*Boolean\(flags\?\.watchlist\)/);
});

test('action queue avoids misleading committed undo and warns before unload', () => {
  assert.match(contentJs, /let activeQueueItem = null/);
  assert.match(contentJs, /queueItem\.committed/);
  assert.match(contentJs, /Already synced to Letterboxd/);
  assert.match(contentJs, /queueItem\.cancelled = true/);
  assert.match(contentJs, /beforeunload/);
  assert.match(contentJs, /Vypode is still syncing actions to Letterboxd/);
});

test('single-film actions do not toggle already-active Letterboxd states off', () => {
  assert.match(contentJs, /Already marked as watched/);
  assert.match(contentJs, /Already liked/);
  assert.match(contentJs, /Already in Watchlist/);
  assert.match(contentJs, /if \(getStates\(\)\.isWatched\)/);
  assert.match(contentJs, /if \(getStates\(\)\.isLiked\)/);
  assert.match(contentJs, /if \(getStates\(\)\.inWatchlist\)/);
});

test('passive DOM enrichment never writes false or null collection flags', () => {
  const persistBody = contentJs.match(/function persistFilmRecord\(film, source\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(persistBody, /if \(film\.isWatched \|\| film\.watched\) patch\.watched = true/);
  assert.match(persistBody, /if \(film\.isLiked \|\| film\.liked\) patch\.liked = true/);
  assert.match(persistBody, /if \(film\.inWatchlist \|\| film\.watchlist\) patch\.watchlist = true/);
  assert.doesNotMatch(persistBody, /watched:\s*.*false/);
  assert.doesNotMatch(persistBody, /liked:\s*.*false/);
  assert.doesNotMatch(persistBody, /watchlist:\s*.*false/);
  assert.doesNotMatch(persistBody, /reviewText:\s*.*null/);
});
