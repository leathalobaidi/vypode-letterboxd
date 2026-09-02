'use strict';

const POPUP_STORAGE_KEYS = ['vypode_user', 'vypode_state', 'vypode_action_outbox_v1'];
const POPUP_PING_TIMEOUT_MS = 5000;
const POPUP_ACTION_TIMEOUT_MS = 12000;
let popupActiveTab = null;
let popupSnapshot = {};
let popupDisplayedAccount = { id: null, username: null, sessionActive: false, mismatch: false };
let popupReceiverState = 'checking';
let popupReceiverCapabilities = {};
let popupProbeId = 0;
const popupPendingButtons = new Set();

function byId(id) {
  return document.getElementById(id);
}

function normalizeAccountId(user) {
  const value = typeof user === 'string' ? user : user?.username;
  if (typeof value !== 'string') return null;
  let username = value.trim();
  if (username.startsWith('user:')) username = username.slice(5);
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(username)) return null;
  return `user:${username.toLowerCase()}`;
}

function displayedAccount(result) {
  const state = result.vypode_state;
  const user = result.vypode_user;
  const userId = normalizeAccountId(user);
  let id = userId;
  let hasRootAccount = false;
  if (state?._meta?.version >= 3 && state.accounts && typeof state.accounts === 'object') {
    const rootId = normalizeAccountId(state._meta.activeAccount);
    if (rootId && state.accounts[rootId] && typeof state.accounts[rootId] === 'object') {
      id = rootId;
      hasRootAccount = true;
    } else if (userId && state.accounts[userId] && typeof state.accounts[userId] === 'object') {
      // A partially written/corrupt root should not make a valid detected
      // account appear empty.
      hasRootAccount = true;
    }
  }
  const detectedUsername = typeof user === 'string'
    ? user.replace(/^user:/, '')
    : user?.username;
  return {
    id,
    username: id === userId && detectedUsername ? detectedUsername : (id?.slice(5) || null),
    account: hasRootAccount ? state.accounts[id] : (state?.slugs && typeof state.slugs === 'object' ? state : null),
    mismatch: Boolean(userId && id && userId !== id),
    sessionActive: Boolean(user?.active === true && userId && userId === id)
  };
}

function accountState(result, displayed) {
  return displayed?.account || null;
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = String(value);
}

function setStatusRow(id, state, textId, text, detailId, detail, busy = false) {
  const row = byId(id);
  if (row) {
    row.dataset.state = state;
    row.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  setText(textId, text);
  setText(detailId, detail);
}

function isSupportedLetterboxdUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === 'https://letterboxd.com' && (
      /^\/film\/[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname) ||
      /^\/films(?:\/.*)?$/i.test(url.pathname) ||
      /^\/[a-z0-9_]+\/(?:films|watchlist|list)(?:\/.*)?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function pendingCount(result, accountId) {
  const outbox = result.vypode_action_outbox_v1;
  if (!accountId || !outbox || typeof outbox !== 'object' || Array.isArray(outbox)) return 0;
  return Object.values(outbox).filter(item => item && typeof item === 'object' &&
    normalizeAccountId(item.account) === accountId).length;
}

function renderPopup(result) {
  result = result || {};
  popupSnapshot = result;
  const user = result.vypode_user;
  popupDisplayedAccount = displayedAccount(result);
  const state = accountState(result, popupDisplayedAccount);

  const nameEl = byId('accountName');
  const statusEl = byId('accountStatus');
  if (popupDisplayedAccount.id) {
    if (nameEl) nameEl.textContent = popupDisplayedAccount.username;
    if (popupDisplayedAccount.mismatch) {
      if (statusEl) {
        const detectedUsername = typeof user === 'string' ? user : user?.username;
        statusEl.textContent = `Showing ${popupDisplayedAccount.username}; detected session is ${detectedUsername}`;
        statusEl.className = 'status unlinked';
      }
    } else if (popupDisplayedAccount.sessionActive) {
      if (statusEl) {
        statusEl.textContent = 'Active Letterboxd session detected';
        statusEl.className = 'status linked';
      }
    } else {
      if (statusEl) {
        statusEl.textContent = 'Stored account data; sign in to confirm this session';
        statusEl.className = 'status unlinked';
      }
    }
  } else {
    if (nameEl) nameEl.textContent = 'No Letterboxd account detected';
    if (statusEl) {
      statusEl.textContent = 'Log in to Letterboxd and refresh a supported page';
      statusEl.className = 'status unlinked';
    }
  }

  if (state && state.slugs) {
    const slugs = state.slugs;
    let watched = 0;
    let liked = 0;
    let watchlist = 0;
    let skipped = 0;
    let rated = 0;
    let reviewed = 0;
    for (const slug in slugs) {
      const e = slugs[slug];
      if (!e || typeof e !== 'object') continue;
      if (e.watched) watched++;
      if (e.liked) liked++;
      if (e.watchlist) watchlist++;
      if (e.skipped) skipped++;
      if (e.ratingValue || e.rating) rated++;
      if (e.reviewText) reviewed++;
    }
    setText('statWatched', watched);
    setText('statLiked', liked);
    setText('statWatchlist', watchlist);
    setText('statSkipped', skipped);
    setText('statRated', rated);
    setText('statReviewed', reviewed);
  } else {
    for (const id of ['statWatched', 'statLiked', 'statWatchlist', 'statSkipped', 'statRated', 'statReviewed']) setText(id, 0);
  }

  const pending = pendingCount(result, popupDisplayedAccount.id);
  setText('popupPendingCount', pending);
  setStatusRow(
    'popupPending', pending > 0 ? 'warning' : 'ready',
    'popupPendingText', pending > 0 ? `${pending} account action${pending === 1 ? '' : 's'} pending` : 'No account actions pending',
    'popupPendingDetail', pending > 0 ? 'Keep a logged-in Letterboxd tab open while these finish.' : 'Watched, like, and watchlist changes have finished.'
  );
  updateTabControls();
}

function updateTabControls() {
  const supportedUrl = isSupportedLetterboxdUrl(popupActiveTab?.url);
  const receiverReady = supportedUrl && popupReceiverState === 'ready';
  const activeLogin = popupDisplayedAccount.sessionActive;
  if (!supportedUrl) {
    setStatusRow(
      'popupHealth', 'warning',
      'popupHealthText', 'Open a supported Letterboxd page',
      'popupHealthDetail', 'Use an exact film page, films page, watchlist, or list. Film subpages are not supported.'
    );
  } else if (popupReceiverState === 'checking') {
    setStatusRow(
      'popupHealth', 'checking',
      'popupHealthText', 'Checking Swipe on this tab…',
      'popupHealthDetail', 'Waiting for the page controls to finish loading.',
      true
    );
  } else if (receiverReady) {
    setStatusRow(
      'popupHealth', 'ready',
      'popupHealthText', 'Swipe is ready on this tab',
      'popupHealthDetail', 'Quick actions will run in the active Letterboxd tab.'
    );
  } else {
    setStatusRow(
      'popupHealth', 'error',
      'popupHealthText', 'Swipe needs this tab refreshed',
      'popupHealthDetail', 'Refresh the Letterboxd page, then open this popup again.'
    );
  }
  const controls = [
    ['resumeSwipeBtn', receiverReady && popupReceiverCapabilities.resumeSwipe === true, 'Available on a supported Letterboxd tab'],
    ['syncNowBtn', receiverReady && activeLogin && popupReceiverCapabilities.syncNow === true, activeLogin ? 'Available on a supported Letterboxd tab' : 'Log in to Letterboxd to sync'],
    ['openSettingsBtn', receiverReady && popupReceiverCapabilities.openSettings === true, 'Available on a supported Letterboxd tab']
  ];
  for (const [id, enabled, title] of controls) {
    const button = byId(id);
    if (!button) continue;
    button.disabled = !enabled || popupPendingButtons.has(id);
    button.setAttribute('aria-busy', popupPendingButtons.has(id) ? 'true' : 'false');
    button.title = title;
  }
}

function queryActiveTab() {
  return new Promise(resolve => {
    if (!globalThis.chrome?.tabs?.query) return resolve(null);
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs?.[0] || null));
    } catch {
      resolve(null);
    }
  });
}

async function sendTabMessageWithTimeout(tabId, message, timeoutMs) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('The page did not respond in time');
      error.code = 'popup-message-timeout';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(chrome.tabs.sendMessage(tabId, message)),
      timeout
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function sendPopupAction(action, detailId) {
  if (!popupActiveTab?.id || popupReceiverState !== 'ready' || !isSupportedLetterboxdUrl(popupActiveTab.url)) return;
  const detail = byId(detailId);
  const buttonId = {
    resumeSwipe: 'resumeSwipeBtn',
    syncNow: 'syncNowBtn',
    openSettings: 'openSettingsBtn'
  }[action];
  const button = byId(buttonId);
  if (!buttonId || !button || button.disabled || popupPendingButtons.has(buttonId)) return;
  popupPendingButtons.add(buttonId);
  updateTabControls();
  try {
    const response = await sendTabMessageWithTimeout(
      popupActiveTab.id,
      { type: 'vypode-popup', action },
      POPUP_ACTION_TIMEOUT_MS
    );
    if (response?.ok !== true) {
      const error = new Error(response?.message || response?.error || 'The page did not confirm this action');
      error.isStructuredResponse = Boolean(response && typeof response === 'object');
      throw error;
    }
    if (detail) detail.textContent = response?.message || 'Sent to the active Letterboxd tab.';
  } catch (error) {
    if (detail) detail.textContent = `Could not run this action: ${error.message}`;
    if (!error.isStructuredResponse) popupReceiverState = 'error';
  } finally {
    popupPendingButtons.delete(buttonId);
    updateTabControls();
  }
}

function wirePopupActions() {
  byId('resumeSwipeBtn')?.addEventListener('click', () => sendPopupAction('resumeSwipe', 'resumeSwipeDetail'));
  byId('syncNowBtn')?.addEventListener('click', () => sendPopupAction('syncNow', 'syncNowDetail'));
  byId('openSettingsBtn')?.addEventListener('click', () => sendPopupAction('openSettings', 'openSettingsDetail'));
}

async function probeActiveTab(tab) {
  const probeId = ++popupProbeId;
  popupActiveTab = tab;
  popupReceiverCapabilities = {};
  if (!tab?.id || !isSupportedLetterboxdUrl(tab.url)) {
    popupReceiverState = 'unsupported';
    updateTabControls();
    return;
  }

  popupReceiverState = 'checking';
  updateTabControls();
  try {
    const response = await sendTabMessageWithTimeout(
      tab.id,
      { type: 'vypode-popup', action: 'ping' },
      POPUP_PING_TIMEOUT_MS
    );
    if (probeId !== popupProbeId) return;
    if (response?.ok !== true || response?.supported !== true || !response.capabilities || typeof response.capabilities !== 'object') {
      throw new Error('The page did not confirm Swipe readiness');
    }
    popupReceiverCapabilities = {
      resumeSwipe: response.capabilities.resumeSwipe === true,
      syncNow: response.capabilities.syncNow === true,
      openSettings: response.capabilities.openSettings === true
    };
    popupReceiverState = 'ready';
  } catch {
    if (probeId !== popupProbeId) return;
    popupReceiverState = 'error';
    popupReceiverCapabilities = {};
  }
  updateTabControls();
}

// Load account status and stats from chrome.storage. This must live in an
// external file because Manifest V3 extension pages block inline scripts.
if (globalThis.chrome?.storage?.local) {
  wirePopupActions();
  queryActiveTab().then(probeActiveTab);
  chrome.storage.local.get(POPUP_STORAGE_KEYS, renderPopup);
  chrome.storage.onChanged?.addListener?.((changes, areaName) => {
    if (areaName === 'local' && POPUP_STORAGE_KEYS.some(key => changes[key])) {
      chrome.storage.local.get(POPUP_STORAGE_KEYS, renderPopup);
    }
  });
} else {
  renderPopup({});
}
