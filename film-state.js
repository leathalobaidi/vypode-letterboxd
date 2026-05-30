// VYPODE FOR LETTERBOXD — FilmState Registry v5.0.0
// Persistent film state keyed by slug, stored in chrome.storage.local
// Loaded before content.js — exposes window.VypodeFilmState

(function() {
  'use strict';

  const STORAGE_KEY = 'vypode_state';
  const PREFS_KEY = 'vypode_prefs';
  const DATA_VERSION = 2;

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
      title: null,
      year: null,
      poster: null,
      url: null,
      rating: null,
      ratingValue: null,
      reviewText: null,
      reviewUrl: null,
      watched: false,   watchedAt: null,
      liked: false,     likedAt: null,
      watchlist: false,  watchlistAt: null,
      skipped: false,   skippedAt: null,
      lastAction: null,  // 'watched' | 'liked' | 'watchlist' | 'skipped'
      source: null,      // 'userAction' | 'domSync' | 'import' | 'collectionSync'
      lastSyncedAt: null,
      updatedAt: null
    };
  }

  function normalizeEntry(entry) {
    return { ...newEntry(), ...(entry || {}) };
  }

  // ── Storage I/O ─────────────────────────────────────────────────────

  async function loadFromStorage() {
    const [localResult, syncResult] = await Promise.all([
      new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_KEY], resolve);
      }),
      new Promise((resolve) => {
        chrome.storage.sync.get([PREFS_KEY], resolve);
      })
    ]);

    const raw = localResult[STORAGE_KEY];
    if (raw && typeof raw === 'object') {
      const version = raw._meta?.version || 0;
      if (version < DATA_VERSION) {
        migrateData(raw, version);
      }
      meta = raw._meta || meta;
      registry = {};
      const rawSlugs = raw.slugs || {};
      for (const slug in rawSlugs) {
        registry[slug] = normalizeEntry(rawSlugs[slug]);
      }
    }

    if (syncResult[PREFS_KEY]) {
      prefs = { ...DEFAULT_PREFS, ...syncResult[PREFS_KEY] };
    }

    loaded = true;
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
    if (fromVersion < 2 && raw.slugs) {
      for (const slug in raw.slugs) {
        raw.slugs[slug] = normalizeEntry(raw.slugs[slug]);
      }
      raw._meta = raw._meta || {};
      raw._meta.version = 2;
    }
    // Future migrations go here as: if (fromVersion < 2) { ... }
  }

  function searchableText(slug, entry) {
    return [
      slug,
      entry.title,
      entry.year,
      entry.rating,
      entry.reviewText
    ].filter(Boolean).join(' ').toLowerCase();
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
      let rated = 0, reviewed = 0;
      for (const slug in registry) {
        const e = registry[slug];
        if (e.watched) watched++;
        if (e.liked) liked++;
        if (e.watchlist) watchlist++;
        if (e.skipped) skipped++;
        if (e.ratingValue || e.rating) rated++;
        if (e.reviewText) reviewed++;
      }
      return { total: Object.keys(registry).length, watched, liked, watchlist, skipped, rated, reviewed };
    },

    query(options) {
      const opts = options || {};
      const search = (opts.search || '').trim().toLowerCase();
      const filter = opts.filter || 'all';
      const sort = opts.sort || 'title';

      let rows = Object.entries(registry).map(([slug, entry]) => ({
        slug,
        ...normalizeEntry(entry)
      }));

      if (filter === 'watched') rows = rows.filter(e => e.watched);
      else if (filter === 'liked') rows = rows.filter(e => e.liked);
      else if (filter === 'watchlist') rows = rows.filter(e => e.watchlist);
      else if (filter === 'rated') rows = rows.filter(e => e.ratingValue || e.rating);
      else if (filter === 'reviewed') rows = rows.filter(e => e.reviewText);
      else if (filter === 'missing-rating') rows = rows.filter(e => e.watched && !e.ratingValue && !e.rating);
      else if (filter === 'skipped') rows = rows.filter(e => e.skipped);

      if (search) {
        rows = rows.filter(e => searchableText(e.slug, e).includes(search));
      }

      rows.sort((a, b) => {
        if (sort === 'rating') {
          return (b.ratingValue || 0) - (a.ratingValue || 0) || String(a.title || a.slug).localeCompare(String(b.title || b.slug));
        }
        if (sort === 'updated') {
          return String(b.updatedAt || b.lastSyncedAt || '').localeCompare(String(a.updatedAt || a.lastSyncedAt || ''));
        }
        if (sort === 'year') {
          return String(b.year || '').localeCompare(String(a.year || '')) || String(a.title || a.slug).localeCompare(String(b.title || b.slug));
        }
        return String(a.title || a.slug).localeCompare(String(b.title || b.slug));
      });

      return rows;
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

    // Set a single flag on a slug. source: 'userAction' | 'domSync' | 'collectionSync' | 'import'
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
      // Best-effort notification for popup/test listeners.
      this._notifyBackground('stateChanged', { slug, flag, value, source: entry.source, timestamp: now });
    },

    updateFilm(slug, patch, source) {
      if (!slug || !patch || typeof patch !== 'object') return false;
      const now = new Date().toISOString();
      if (!registry[slug]) registry[slug] = newEntry();
      const entry = registry[slug];
      const allowed = [
        'title', 'year', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl',
        'watched', 'watchedAt', 'liked', 'likedAt', 'watchlist', 'watchlistAt',
        'skipped', 'skippedAt', 'lastAction'
      ];
      for (const key of allowed) {
        if (key in patch && patch[key] !== undefined) entry[key] = patch[key];
      }
      entry.source = source || patch.source || entry.source || 'userAction';
      entry.lastSyncedAt = patch.lastSyncedAt || entry.lastSyncedAt;
      entry.updatedAt = patch.updatedAt || now;
      saveToStorage();
      return true;
    },

    // Bulk update from collection sync — only sets flags that are true
    bulkSetFromSync(slugMap, source) {
      // slugMap: { slug: { title, poster, ratingValue, watched: true, liked: false, watchlist: true } }
      const now = new Date().toISOString();
      let count = 0;
      for (const slug in slugMap) {
        if (!registry[slug]) registry[slug] = newEntry();
        const entry = registry[slug];
        const incoming = slugMap[slug];
        const metadataKeys = ['title', 'year', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl'];
        for (const key of metadataKeys) {
          if (incoming[key] !== undefined && incoming[key] !== null && incoming[key] !== entry[key]) {
            entry[key] = incoming[key];
            count++;
          }
        }
        for (const flag of ['watched', 'liked', 'watchlist']) {
          if (incoming[flag] && !entry[flag]) {
            entry[flag] = true;
            entry[flag + 'At'] = now;
            entry.source = source || 'collectionSync';
            entry.updatedAt = now;
            count++;
          }
        }
        entry.lastSyncedAt = now;
      }
      if (count > 0) saveToStorage();
      return count;
    },

    reconcileFlags(flagSets, source) {
      const now = new Date().toISOString();
      let count = 0;
      for (const slug in registry) {
        const entry = registry[slug];
        if (!entry || typeof entry !== 'object') continue;
        for (const flag of ['watched', 'liked', 'watchlist']) {
          const set = flagSets?.[flag];
          if (!set || !entry[flag] || set.has(slug)) continue;
          if (entry.source === (source || 'collectionSync')) {
            entry[flag] = false;
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

    // Merge imported registry data — latest timestamp wins per flag.
    mergeImportedRegistry(importedRegistry) {
      let merged = 0;
      for (const slug in importedRegistry) {
        const imported = normalizeEntry(importedRegistry[slug]);
        if (!registry[slug]) {
          registry[slug] = { ...newEntry(), ...imported, source: 'import' };
          merged++;
          continue;
        }
        const local = registry[slug];
        for (const key of ['title', 'year', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl']) {
          if (imported[key] && imported[key] !== local[key]) {
            local[key] = imported[key];
            merged++;
          }
        }
        for (const flag of ['watched', 'liked', 'watchlist', 'skipped']) {
          const importedTs = imported[flag + 'At'];
          const localTs = local[flag + 'At'];
          if (importedTs && (!localTs || importedTs > localTs)) {
            local[flag] = imported[flag];
            local[flag + 'At'] = importedTs;
            local.source = 'import';
            merged++;
          }
        }
        // Use latest updatedAt
        if (imported.updatedAt && (!local.updatedAt || imported.updatedAt > local.updatedAt)) {
          local.lastAction = imported.lastAction || local.lastAction;
          local.updatedAt = imported.updatedAt;
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
        const importCount = this.mergeImportedRegistry(data.slugs);
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
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      registry = {};
      meta = { version: DATA_VERSION, lastSyncAt: null, syncDuration: null, syncCounts: null };
      prefs = { ...DEFAULT_PREFS };
      return new Promise((resolve) => {
        chrome.storage.local.remove([STORAGE_KEY], () => {
          chrome.storage.sync.remove([PREFS_KEY], resolve);
        });
      });
    },

    async clearSkipped() {
      for (const slug in registry) {
        if (registry[slug].skipped) {
          registry[slug].skipped = false;
          registry[slug].skippedAt = null;
        }
      }
      return new Promise((resolve) => {
        const payload = {
          _meta: { ...meta, version: DATA_VERSION },
          slugs: registry
        };
        chrome.storage.local.set({ [STORAGE_KEY]: payload }, resolve);
      });
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
