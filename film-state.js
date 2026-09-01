// SWIPE FOR LETTERBOXD — FilmState Registry v6.3.0-beta.3
// Persistent film state keyed by slug, stored in chrome.storage.local
// Loaded before content.js — exposes window.VypodeFilmState

(function() {
  'use strict';

  const STORAGE_KEY = 'vypode_state';
  const PREFS_KEY = 'vypode_prefs';
  const DATA_VERSION = 2;

  // User preferences (synced across devices via chrome.storage.sync)
  const DEFAULT_PREFS = {
    excludeWatched: true,
    excludeLiked: true,
    excludeWatchlist: true,
    excludeSkipped: true,
    // Opt-in so installing the beta never changes page navigation without
    // the user deliberately enabling it in Settings.
    autoNextPage: false
  };

  // ── In-memory registry ──────────────────────────────────────────────

  let registry = Object.create(null);       // slug -> FilmEntry
  let meta = { version: DATA_VERSION, lastSyncAt: null, syncDuration: null, syncCounts: null };
  let prefs = { ...DEFAULT_PREFS };
  let loaded = false;
  let saveTimer = null;
  let lastStorageError = null;

  function isSafeSlug(slug) {
    return typeof slug === 'string' &&
      slug.length > 0 &&
      slug !== '__proto__' &&
      slug !== 'constructor' &&
      slug !== 'prototype';
  }

  // ── FilmEntry shape ─────────────────────────────────────────────────

  function newEntry() {
    return {
      title: null,
      year: null,
      director: null,
      genres: [],
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

  function storageErrorMessage() {
    return chrome.runtime?.lastError?.message || null;
  }

  function recordStorageError(scope) {
    const message = storageErrorMessage();
    if (!message) return;
    lastStorageError = `${scope}: ${message}`;
    console.warn('Vypode storage error:', lastStorageError);
    try {
      chrome.runtime?.sendMessage?.({ type: 'vypode', action: 'storageError', data: { scope, message } });
    } catch (e) {}
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
      meta = (raw._meta && typeof raw._meta === 'object') ? raw._meta : meta;
      registry = Object.create(null);
      const rawSlugs = (raw.slugs && typeof raw.slugs === 'object') ? raw.slugs : {};
      for (const slug in rawSlugs) {
        if (!isSafeSlug(slug)) continue;
        registry[slug] = normalizeEntry(rawSlugs[slug]);
      }
    }

    if (syncResult[PREFS_KEY]) {
      prefs = { ...DEFAULT_PREFS, ...syncResult[PREFS_KEY] };
    }

    loaded = true;
  }

  function timestamp(value) {
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }

  // Tie-break priority when two writes share the exact same timestamp (e.g. a
  // background reconcile and a deliberate user action landing in the same
  // millisecond across tabs). A real user action must never be silently
  // overwritten by an automated sync/reconcile that merely happened to tie.
  function sourcePriority(source) {
    if (source === 'userAction') return 3;
    if (source === 'import') return 2;
    return 1; // collectionSync, domSync, null
  }

  function mergeEntryForSave(storedEntry, localEntry) {
    const stored = normalizeEntry(storedEntry);
    const local = normalizeEntry(localEntry);
    const merged = { ...stored };

    for (const key of ['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl']) {
      if (local[key] !== undefined && local[key] !== null && local[key] !== '') {
        merged[key] = local[key];
      }
    }

    for (const flag of ['watched', 'liked', 'watchlist', 'skipped']) {
      const localTs = timestamp(local[flag + 'At']);
      const storedTs = timestamp(stored[flag + 'At']);
      if (localTs || storedTs) {
        // Newer timestamp wins; on an exact tie, higher source priority wins so
        // a userAction beats a same-instant collectionSync reconcile.
        const localWins = localTs > storedTs ||
          (localTs === storedTs && sourcePriority(local.source) >= sourcePriority(stored.source));
        if (localWins) {
          merged[flag] = Boolean(local[flag]);
          merged[flag + 'At'] = local[flag + 'At'];
        }
      } else if (local[flag]) {
        merged[flag] = true;
      }
    }

    if (timestamp(local.updatedAt) >= timestamp(stored.updatedAt)) {
      merged.lastAction = local.lastAction || merged.lastAction;
      merged.source = local.source || merged.source;
      merged.lastSyncedAt = local.lastSyncedAt || merged.lastSyncedAt;
      merged.updatedAt = local.updatedAt || merged.updatedAt;
    }

    return merged;
  }

  function writeToStorage() {
    chrome.storage.local.get([STORAGE_KEY], result => {
      const latest = result[STORAGE_KEY];
      const mergedRegistry = Object.create(null);
      const latestSlugs = latest?.slugs || {};

      for (const slug in latestSlugs) {
        if (!isSafeSlug(slug)) continue;
        mergedRegistry[slug] = normalizeEntry(latestSlugs[slug]);
      }
      for (const slug in registry) {
        if (!isSafeSlug(slug)) continue;
        mergedRegistry[slug] = mergeEntryForSave(mergedRegistry[slug], registry[slug]);
      }

      registry = mergedRegistry;
      const payload = {
        _meta: { ...(latest?._meta || {}), ...meta, version: DATA_VERSION },
        slugs: registry
      };
      chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => recordStorageError('local.set'));
      saveTimer = null;
    });
  }

  // Above this many entries, writeToStorage's full re-serialize is expensive
  // enough that even "immediate" user-action writes are coalesced into a short
  // debounce so a burst of swipes doesn't rewrite the whole registry per action.
  const LARGE_REGISTRY = 2000;

  function saveToStorage(delayMs) {
    // Debounced save: coalesce rapid writes into a single storage call
    if (saveTimer) clearTimeout(saveTimer);
    let delay = delayMs === undefined ? 300 : delayMs;
    // Adaptive: never write a large library synchronously per action. flush()
    // (called on visibilitychange/beforeunload) guarantees pending writes land.
    if (delay <= 0 && Object.keys(registry).length > LARGE_REGISTRY) delay = 200;
    if (delay <= 0) {
      writeToStorage();
      return;
    }
    saveTimer = setTimeout(writeToStorage, delay);
  }

  function savePrefs() {
    chrome.storage.sync.set({ [PREFS_KEY]: prefs }, () => recordStorageError('sync.set'));
  }

  // ── Migration ───────────────────────────────────────────────────────

  function migrateData(raw, fromVersion) {
    // Corrupted or hand-edited storage may carry a non-object _meta; coerce it
    // so the version stamps below cannot throw on a primitive.
    if (!raw._meta || typeof raw._meta !== 'object') raw._meta = {};
    // v0 -> v1: no structural changes yet, just stamp the version
    if (fromVersion < 1) {
      raw._meta.version = 1;
    }
    if (fromVersion < 2 && raw.slugs && typeof raw.slugs === 'object') {
      for (const slug in raw.slugs) {
        if (!isSafeSlug(slug)) {
          delete raw.slugs[slug];
          continue;
        }
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
      entry.director,
      ...(Array.isArray(entry.genres) ? entry.genres : []),
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
      if (!isSafeSlug(slug)) return null;
      return registry[slug] || null;
    },

    getAll() {
      return { ...registry };
    },

    getMeta() {
      return { ...meta, lastStorageError };
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
      const genre = (opts.genre || 'all').trim().toLowerCase();
      const dateFilter = opts.dateFilter || 'all';
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

      if (genre !== 'all') {
        rows = rows.filter(e => Array.isArray(e.genres) && e.genres.some(g => String(g).toLowerCase() === genre));
      }

      if (dateFilter === 'watched-with-date') {
        rows = rows.filter(e => e.watched && e.watchedAt);
      } else if (dateFilter === 'watched-last-30') {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        rows = rows.filter(e => e.watched && e.watchedAt && new Date(e.watchedAt).getTime() >= cutoff);
      } else if (dateFilter === 'watched-this-year') {
        const year = new Date().getFullYear();
        rows = rows.filter(e => e.watched && e.watchedAt && new Date(e.watchedAt).getFullYear() === year);
      } else if (dateFilter === 'missing-watched-date') {
        rows = rows.filter(e => e.watched && !e.watchedAt);
      }

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
        if (sort === 'watchedAt') {
          return String(b.watchedAt || '').localeCompare(String(a.watchedAt || '')) || String(a.title || a.slug).localeCompare(String(b.title || b.slug));
        }
        if (sort === 'year') {
          return String(b.year || '').localeCompare(String(a.year || '')) || String(a.title || a.slug).localeCompare(String(b.title || b.slug));
        }
        return String(a.title || a.slug).localeCompare(String(b.title || b.slug));
      });

      return rows;
    },

    getGenres() {
      const genres = new Set();
      for (const slug in registry) {
        const entry = registry[slug];
        if (!Array.isArray(entry?.genres)) continue;
        for (const genre of entry.genres) {
          const label = String(genre || '').trim();
          if (label) genres.add(label);
        }
      }
      return Array.from(genres).sort((a, b) => a.localeCompare(b));
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
      if (!isSafeSlug(slug)) return;
      if (!slug) return;
      const now = new Date().toISOString();
      if (!registry[slug]) registry[slug] = newEntry();
      const entry = registry[slug];
      entry[flag] = value;
      entry[flag + 'At'] = now;
      entry.lastAction = flag;
      entry.source = source || 'userAction';
      entry.updatedAt = now;
      saveToStorage(source === 'userAction' ? 0 : 300);
      // Best-effort notification for popup/test listeners.
      this._notifyBackground('stateChanged', { slug, flag, value, source: entry.source, timestamp: now });
    },

    updateFilm(slug, patch, source) {
      if (!isSafeSlug(slug)) return false;
      if (!slug || !patch || typeof patch !== 'object') return false;
      const now = new Date().toISOString();
      if (!registry[slug]) registry[slug] = newEntry();
      const entry = registry[slug];
      const allowed = [
        'title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl',
        'watched', 'watchedAt', 'liked', 'likedAt', 'watchlist', 'watchlistAt',
        'skipped', 'skippedAt', 'lastAction'
      ];
      for (const key of allowed) {
        if (key in patch && patch[key] !== undefined) entry[key] = patch[key];
      }
      // NOTE: updateFilm is a literal patch — it does NOT fabricate a flag timestamp.
      // A film marked watched with no watchedAt is intentionally surfaced by the
      // 'missing-watched-date' filter. setFlag()/bulkSetFromSync() stamp 'now'
      // because they represent an action that genuinely happened now.
      entry.source = source || patch.source || entry.source || 'userAction';
      entry.lastSyncedAt = patch.lastSyncedAt || entry.lastSyncedAt;
      entry.updatedAt = patch.updatedAt || now;
      saveToStorage(source === 'userAction' ? 0 : 300);
      return true;
    },

    // Bulk update from collection sync — only sets flags that are true
    bulkSetFromSync(slugMap, source) {
      // slugMap: { slug: { title, poster, ratingValue, watched: true, liked: false, watchlist: true } }
      const now = new Date().toISOString();
      let count = 0;
      for (const slug in slugMap) {
        if (!isSafeSlug(slug)) continue;
        if (!registry[slug]) registry[slug] = newEntry();
        const entry = registry[slug];
        const incoming = slugMap[slug];
        const metadataKeys = ['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl'];
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
        if (!isSafeSlug(slug)) continue;
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
        if (!isSafeSlug(slug)) continue;
        const rawImported = importedRegistry[slug] || {};
        const imported = normalizeEntry(rawImported);
        if (!registry[slug]) {
          registry[slug] = { ...newEntry(), ...imported, source: 'import' };
          merged++;
          continue;
        }
        const local = registry[slug];
        for (const key of ['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl']) {
          if (imported[key] && imported[key] !== local[key]) {
            local[key] = imported[key];
            merged++;
          }
        }
        for (const flag of ['watched', 'liked', 'watchlist', 'skipped']) {
          const importedTs = imported[flag + 'At'];
          const localTs = local[flag + 'At'];
          if (Object.prototype.hasOwnProperty.call(rawImported, flag) &&
              typeof rawImported[flag] === 'boolean' &&
              importedTs &&
              (!localTs || importedTs > localTs)) {
            local[flag] = rawImported[flag];
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

    // Watched films as a CSV the official letterboxd.com/import page accepts
    // (Title, Year, Directors, Rating, WatchedDate, Review). Makes the local
    // registry portable back into any Letterboxd account.
    exportLetterboxdCsv() {
      const csvField = (value) => {
        const s = value == null ? '' : String(value);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = ['Title,Year,Directors,Rating,WatchedDate,Review'];
      for (const slug in registry) {
        if (!isSafeSlug(slug)) continue;
        const e = registry[slug];
        if (!e || !e.watched) continue;
        const watchedDate = e.watchedAt ? String(e.watchedAt).slice(0, 10) : '';
        lines.push([
          csvField(e.title || slug),
          csvField(e.year || ''),
          csvField(e.director || ''),
          csvField(e.ratingValue || ''),
          csvField(watchedDate),
          csvField(e.reviewText || '')
        ].join(','));
      }
      return lines.join('\r\n');
    },

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
      registry = Object.create(null);
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
        if (!isSafeSlug(slug)) continue;
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
    },

    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      writeToStorage();
    },

    getLastStorageError() {
      return lastStorageError;
    }
  };

  // Expose globally for content.js
  window.VypodeFilmState = VypodeFilmState;

})();
