// VYPODE FOR LETTERBOXD — Background Service Worker v5.0.0
// Handles: chrome.alarms for daily sync, Google auth via chrome.identity,
// Supabase REST cloud sync, message routing from content script.

'use strict';

// ── Supabase configuration ────────────────────────────────────────────
// Replace these with your Supabase project values after running supabase-setup.sql
const SUPABASE_URL = '';    // e.g. 'https://abcdefg.supabase.co'
const SUPABASE_ANON_KEY = ''; // e.g. 'eyJhbGciOi...'

const ALARM_DAILY_SYNC = 'vypode-daily-sync';
const STORAGE_KEY = 'vypode_state';
const CLOUD_KEY = 'vypode_cloud';   // { accessToken, refreshToken, userId, email, expiresAt }
const QUEUE_KEY = 'vypode_queue';   // offline write queue

// ── Alarm setup ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Set daily sync alarm (fires once per 24h)
  chrome.alarms.create(ALARM_DAILY_SYNC, { periodInMinutes: 1440 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_DAILY_SYNC) {
    // Tell any active content script to run a Letterboxd collection sync
    broadcastToContentScripts({ action: 'triggerSync' });
    // Also push local state to cloud if signed in
    pushToCloud();
  }
});

// ── Message handling from content script ──────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'vypode') return;

  switch (msg.action) {

    case 'stateChanged':
      // Content script updated a film flag — queue for cloud push
      queueCloudWrite(msg.data);
      sendResponse({ ok: true });
      break;

    case 'getCloudStatus':
      // Content script wants to know if user is signed into cloud
      getCloudAuth().then(auth => {
        sendResponse({ signedIn: !!auth, email: auth?.email || null, userId: auth?.userId || null });
      });
      return true; // async response

    case 'cloudSignIn':
      // Trigger Google sign-in flow
      handleGoogleSignIn().then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'cloudSignOut':
      chrome.storage.local.remove([CLOUD_KEY, QUEUE_KEY], () => {
        sendResponse({ success: true });
      });
      return true;

    case 'cloudPull':
      // Pull full registry from cloud
      pullFromCloud().then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'cloudPush':
      // Push full local registry to cloud
      pushToCloud().then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'exportCloud':
      pullFromCloud().then(result => {
        sendResponse(result);
      });
      return true;

    case 'flushQueue':
      flushWriteQueue().then(() => sendResponse({ ok: true }));
      return true;
  }
});

// ── Broadcast to content scripts ──────────────────────────────────────

function broadcastToContentScripts(message) {
  chrome.tabs.query({ url: 'https://letterboxd.com/*' }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'vypode', ...message }).catch(() => {});
    }
  });
}

// ── Google auth via chrome.identity ───────────────────────────────────

async function handleGoogleSignIn() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { success: false, error: 'Cloud sync not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in background.js' };
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        resolve({ success: false, error: chrome.runtime.lastError?.message || 'No token returned' });
        return;
      }

      try {
        // Exchange Google token for Supabase session
        const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY
          },
          body: JSON.stringify({
            provider: 'google',
            token: token
          })
        });

        if (!res.ok) {
          // Fallback: try signing in with the token directly
          const signInRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
              provider: 'google',
              access_token: token
            })
          });

          if (!signInRes.ok) {
            resolve({ success: false, error: 'Could not authenticate with cloud service' });
            return;
          }

          const data = await signInRes.json();
          await storeCloudAuth(data);
          resolve({ success: true, email: data.user?.email });
          return;
        }

        const data = await res.json();
        await storeCloudAuth(data);
        resolve({ success: true, email: data.user?.email });

      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });
  });
}

async function storeCloudAuth(data) {
  const auth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    userId: data.user?.id,
    email: data.user?.email,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000
  };
  return new Promise(resolve => {
    chrome.storage.local.set({ [CLOUD_KEY]: auth }, resolve);
  });
}

async function getCloudAuth() {
  return new Promise(resolve => {
    chrome.storage.local.get([CLOUD_KEY], (result) => {
      const auth = result[CLOUD_KEY];
      if (!auth || !auth.accessToken) {
        resolve(null);
        return;
      }
      // Check if token is expired
      if (auth.expiresAt && auth.expiresAt < Date.now()) {
        refreshCloudToken(auth).then(refreshed => {
          resolve(refreshed);
        });
        return;
      }
      resolve(auth);
    });
  });
}

async function refreshCloudToken(auth) {
  if (!auth.refreshToken || !SUPABASE_URL) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ refresh_token: auth.refreshToken })
    });

    if (!res.ok) return null;

    const data = await res.json();
    await storeCloudAuth(data);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user?.id,
      email: data.user?.email,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    };
  } catch (e) {
    return null;
  }
}

// ── Supabase REST API helpers ─────────────────────────────────────────

async function supabaseRequest(path, method, body, auth) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${auth.accessToken}`,
    'Prefer': method === 'POST' ? 'return=representation' : undefined
  };
  // Remove undefined headers
  Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);

  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`);
  }

  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('json')) {
    return res.json();
  }
  return null;
}

// ── Cloud sync: pull ──────────────────────────────────────────────────

async function pullFromCloud() {
  const auth = await getCloudAuth();
  if (!auth) return { success: false, error: 'Not signed in' };

  try {
    // Fetch all film states for this user
    const rows = await supabaseRequest(
      `/film_states?user_id=eq.${auth.userId}&select=*`,
      'GET', null, auth
    );

    if (!rows || !Array.isArray(rows)) {
      return { success: true, count: 0, registry: {} };
    }

    // Convert rows to registry format
    const cloudRegistry = {};
    for (const row of rows) {
      cloudRegistry[row.slug] = {
        watched: row.watched || false,
        watchedAt: row.watched_at,
        liked: row.liked || false,
        likedAt: row.liked_at,
        watchlist: row.watchlist || false,
        watchlistAt: row.watchlist_at,
        skipped: row.skipped || false,
        skippedAt: row.skipped_at,
        lastAction: row.last_action,
        source: 'remoteSync',
        updatedAt: row.updated_at
      };
    }

    return { success: true, count: rows.length, registry: cloudRegistry };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Cloud sync: push ──────────────────────────────────────────────────

async function pushToCloud() {
  const auth = await getCloudAuth();
  if (!auth) return { success: false, error: 'Not signed in' };

  // Get local state
  const localState = await new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(result[STORAGE_KEY]);
    });
  });

  if (!localState || !localState.slugs) {
    return { success: true, count: 0 };
  }

  try {
    const slugs = localState.slugs;
    const rows = [];

    for (const slug in slugs) {
      const e = slugs[slug];
      rows.push({
        user_id: auth.userId,
        slug: slug,
        watched: e.watched || false,
        watched_at: e.watchedAt || null,
        liked: e.liked || false,
        liked_at: e.likedAt || null,
        watchlist: e.watchlist || false,
        watchlist_at: e.watchlistAt || null,
        skipped: e.skipped || false,
        skipped_at: e.skippedAt || null,
        last_action: e.lastAction || null,
        source: e.source || null,
        updated_at: e.updatedAt || new Date().toISOString()
      });
    }

    // Upsert in batches of 500
    const BATCH_SIZE = 500;
    let pushed = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await supabaseRequest(
        '/film_states?on_conflict=user_id,slug',
        'POST', batch, auth
      );
      pushed += batch.length;
    }

    // Also update the user profile with letterboxd username
    const userMeta = await new Promise(resolve => {
      chrome.storage.local.get(['vypode_user'], (result) => {
        resolve(result.vypode_user);
      });
    });

    if (userMeta?.username) {
      await supabaseRequest(
        `/user_profiles?user_id=eq.${auth.userId}`,
        'POST',
        [{
          user_id: auth.userId,
          letterboxd_username: userMeta.username,
          last_push_at: new Date().toISOString()
        }],
        auth
      ).catch(() => {});  // Non-fatal
    }

    return { success: true, count: pushed };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Offline write queue ───────────────────────────────────────────────

async function queueCloudWrite(entry) {
  const auth = await getCloudAuth();
  if (!auth) return; // Not signed in, skip cloud

  // Try immediate push first
  try {
    const row = {
      user_id: auth.userId,
      slug: entry.slug,
      [entry.flag]: entry.value,
      [entry.flag.replace(/([A-Z])/g, '_$1').toLowerCase() + '_at']: entry.timestamp,
      last_action: entry.flag,
      source: 'userAction',
      updated_at: entry.timestamp
    };

    await supabaseRequest(
      '/film_states?on_conflict=user_id,slug',
      'POST', [row], auth
    );
  } catch (e) {
    // Network error — queue for later
    chrome.storage.local.get([QUEUE_KEY], (result) => {
      const queue = result[QUEUE_KEY] || [];
      queue.push({ ...entry, userId: auth.userId, queuedAt: new Date().toISOString() });
      // Cap queue at 1000 entries
      if (queue.length > 1000) queue.splice(0, queue.length - 1000);
      chrome.storage.local.set({ [QUEUE_KEY]: queue });
    });
  }
}

async function flushWriteQueue() {
  const auth = await getCloudAuth();
  if (!auth) return;

  const result = await new Promise(resolve => {
    chrome.storage.local.get([QUEUE_KEY], resolve);
  });

  const queue = result[QUEUE_KEY];
  if (!queue || queue.length === 0) return;

  const remaining = [];
  for (const entry of queue) {
    try {
      const row = {
        user_id: auth.userId,
        slug: entry.slug,
        [entry.flag]: entry.value,
        last_action: entry.flag,
        source: 'userAction',
        updated_at: entry.timestamp
      };
      await supabaseRequest(
        '/film_states?on_conflict=user_id,slug',
        'POST', [row], auth
      );
    } catch (e) {
      remaining.push(entry);
    }
  }

  chrome.storage.local.set({ [QUEUE_KEY]: remaining });
}

// On startup, try to flush any queued writes
self.addEventListener('activate', () => {
  flushWriteQueue();
});
