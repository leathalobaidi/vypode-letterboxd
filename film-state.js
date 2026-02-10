// VYPODE FOR LETTERBOXD — FilmState Registry v5.0.0
// Persistent film state keyed by slug, stored in chrome.storage.local
// Loaded before content.js — exposes window.VypodeFilmState

(function() {
  'use strict';

  const STORAGE_KEY = 'vypode_state';
  const PREFS_KEY = 'vypode_prefs';
  const DATA_VERSION = 1;

  // Default filter preferences (synced across devices via chrome.storage.sync)
  const DEFAULT_PREFS = {
    excludeWatched: true,
    excludeLiked: true,
    excludeWatchlist: true,
    excludeSkipped: true
  };

  // ── In-memory registry ──────────────────────────────────────────────

  let registry = {};       // slug -> FilmEntry
  let meta = { version: DATA_VERSION, lastSyncAt: null, syncDuration: null, syncCounts: null };
  let prefs = { ...DEFAULT_PREFS };
  let loaded = false;
  let saveTimer = null;

  // ── FilmEntry shape ─────────────────────────────────────────────────

  function newEntry() {
    return {
      watched: false,   watchedAt: null,
      liked: false,     likedAt: null,
      watchlist: false,  watchlistAt: null,
      skipped: false,   skippedAt: null,
      lastAction: null,  // 'watched' | 'liked' | 'watchlist' | 'skipped'
      source: null,      // 'userAction' | 'domSync' | 'remoteSync' | 'collectionSync'
      updatedAt: null
    };
  }

  // ── Storage I/O ─────────────────────────────────────────────────────

  async function loadFromStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        const raw = result[STORAGE_KEY];
        if (raw && typeof raw === 'object') {
          // Migration gate: check version
          const version = raw._meta?.version || 0;
          if (version < DATA_VERSION) {
            migrateData(raw, version);
          }
          meta = raw._meta || meta;
          registry = raw.slugs || {};
        }
        loaded = true;
        resolve();
      });

      // Also load prefs from sync storage
      chrome.storage.sync.get([PREFS_KEY], (result) => {
        if (result[PREFS_KEY]) {
          prefs = { ...DEFAULT_PREFS, ...result[PREFS_KEY] };
        }
      });
    });
  }

  function saveToStorage() {
    // Debounced save: coalesce rapid writes into a single storage call
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const payload = {
        _meta: { ...meta, version: DATA_VERSION },
        slugs: registry
      };
      chrome.storage.local.set({ [STORAGE_KEY]: payload });
      saveTimer = null;
    }, 300);
  }

  function savePrefs() {
    chrome.storage.sync.set({ [PREFS_KEY]: prefs });
  }

  // ── Migration ───────────────────────────────────────────────────────

  function migrateData(raw, fromVersion) {
    // v0 -> v1: no structural changes yet, just stamp the version
    if (fromVersion < 1) {
      raw._meta = raw._meta || {};
      raw._meta.version = 1;
    }
    // Future migrations go here as: if (fromVersion < 2) { ... }
  }

  // ── Public API ──────────────────────────────────────────────────────

  const VypodeFilmState = {

    // Must be called once before any other method
    async init() {
      if (loaded) return;
      await loadFromStorage();
    },

    isLoaded() {
      return loaded;
    },

    // ── Read ────────────────────────────────────────────────────────

    get(slug) {
      return registry[slug] || null;
    },

    getAll() {
      return { ...registry };
    },

    getMeta() {
      return { ...meta };
    },

    getPrefs() {
      return { ...prefs };
    },

    getStats() {
      let watched = 0, liked = 0, watchlist = 0, skipped = 0;
      for (const slug in registry) {
        const e = registry[slug];
        if (e.watched) watched++;
        if (e.liked) liked++;
        if (e.watchlist) watchlist++;
        if (e.skipped) skipped++;
      }
      return { total: Object.keys(registry).length, watched, liked, watchlist, skipped };
    },

    // Returns true if this film should be excluded from the deck
    shouldExclude(slug) {
      const entry = registry[slug];
      if (!entry) return false;
      if (prefs.excludeWatched && entry.watched) return true;
      if (prefs.excludeLiked && entry.liked) return true;
      if (prefs.excludeWatchlist && entry.watchlist) return true;
      if (prefs.excludeSkipped && entry.skipped) return true;
      return false;
    },

    // ── Write ───────────────────────────────────────────────────────

    // Set a single flag on a slug. source: 'userAction' | 'domSync' | 'collectionSync' | 'remoteSync'
    setFlag(slug, flag, value, source) {
      if (!slug) return;
      const now = new Date().toISOString();
      if (!registry[slug]) registry[slug] = newEntry();
      const entry = registry[slug];
      entry[flag] = value;
      entry[flag + 'At'] = now;
      entry.lastAction = flag;
      entry.source = source || 'userAction';
      entry.updatedAt = now;
      saveToStorage();
      // Notify background for cloud push
      this._notifyBackground('stateChanged', { slug, flag, value, timestamp: now });
    },

    // Bulk update from collection sync — only sets flags that are true
    bulkSetFromSync(slugMap, source) {
      // slugMap: { slug: { watched: true, liked: false, watchlist: true } }
      const now = new Date().toISOString();
      let count = 0;
      for (const slug in slugMap) {
        if (!registry[slug]) registry[slug] = newEntry();
        const entry = registry[slug];
        const incoming = slugMap[slug];
        for (const flag of ['watched', 'liked', 'watchlist']) {
          if (incoming[flag] && !entry[flag]) {
            entry[flag] = true;
            entry[flag + 'At'] = now;
            entry.source = source || 'collectionSync';
            entry.updatedAt = now;
            count++;
          }
        }
      }
      if (count > 0) saveToStorage();
      return count;
    },

    // Merge from cloud — uses timestamps to resolve conflicts (latest wins per flag)
    mergeFromCloud(cloudRegistry) {
      let merged = 0;
      for (const slug in cloudRegistry) {
        const cloud = cloudRegistry[slug];
        if (!registry[slug]) {
          registry[slug] = { ...newEntry(), ...cloud, source: 'remoteSync' };
          merged++;
          continue;
        }
        const local = registry[slug];
        for (const flag of ['watched', 'liked', 'watchlist', 'skipped']) {
          const cloudTs = cloud[flag + 'At'];
          const localTs = local[flag + 'At'];
          if (cloudTs && (!localTs || cloudTs > localTs)) {
            local[flag] = cloud[flag];
            local[flag + 'At'] = cloudTs;
            local.source = 'remoteSync';
            merged++;
          }
        }
        // Use latest updatedAt
        if (cloud.updatedAt && (!local.updatedAt || cloud.updatedAt > local.updatedAt)) {
          local.lastAction = cloud.lastAction || local.lastAction;
          local.updatedAt = cloud.updatedAt;
        }
      }
      if (merged > 0) saveToStorage();
      return merged;
    },

    // ── Sync metadata ───────────────────────────────────────────────

    setSyncMeta(lastSyncAt, duration, counts) {
      meta.lastSyncAt = lastSyncAt;
      meta.syncDuration = duration;
      meta.syncCounts = counts;
      saveToStorage();
    },

    // ── Preferences ─────────────────────────────────────────────────

    setPref(key, value) {
      if (key in DEFAULT_PREFS) {
        prefs[key] = value;
        savePrefs();
      }
    },

    // ── Export / Import ─────────────────────────────────────────────

    exportData() {
      return JSON.stringify({
        _meta: { ...meta, version: DATA_VERSION, exportedAt: new Date().toISOString() },
        slugs: registry,
        prefs: prefs
      }, null, 2);
    },

    importData(jsonString) {
      try {
        const data = JSON.parse(jsonString);
        if (!data.slugs || typeof data.slugs !== 'object') {
          return { success: false, error: 'Invalid format: missing slugs object' };
        }
        const importCount = this.mergeFromCloud(data.slugs);
        if (data.prefs) {
          prefs = { ...DEFAULT_PREFS, ...data.prefs };
          savePrefs();
        }
        return { success: true, merged: importCount };
      } catch (e) {
        return { success: false, error: 'Invalid JSON: ' + e.message };
      }
    },

    // ── Clear ───────────────────────────────────────────────────────

    async clearAll() {
      registry = {};
      meta = { version: DATA_VERSION, lastSyncAt: null, syncDuration: null, syncCounts: null };
      return new Promise((resolve) => {
        chrome.storage.local.remove([STORAGE_KEY], resolve);
      });
    },

    async clearSkipped() {
      for (const slug in registry) {
        if (registry[slug].skipped) {
          registry[slug].skipped = false;
          registry[slug].skippedAt = null;
        }
      }
      saveToStorage();
    },

    // ── Internal: notify background ─────────────────────────────────

    _notifyBackground(action, data) {
      try {
        chrome.runtime.sendMessage({ type: 'vypode', action, data });
      } catch (e) {
        // Background may not be running — that's fine
      }
    }
  };

  // Expose globally for content.js
  window.VypodeFilmState = VypodeFilmState;

})();
