// SWIPE FOR LETTERBOXD — Account-scoped FilmState Registry v3
// Persistent film state keyed by Letterboxd account + film slug.
// Loaded before content.js — exposes window.VypodeFilmState

(function() {
  'use strict';

  const STORAGE_KEY = 'vypode_state';
  const PREFS_KEY = 'vypode_prefs';
  const USER_KEY = 'vypode_user';
  const DATA_VERSION = 3;
  const LEGACY_ACCOUNT = '$legacy';
  const FLAGS = ['watched', 'liked', 'watchlist', 'skipped'];
  const METADATA_KEYS = ['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl'];
  const ENTRY_SOURCES = new Set(['userAction', 'domSync', 'import', 'collectionSync']);
  const MAX_REVIEW_TEXT_LENGTH = 50000;
  const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
  const MAX_IMPORT_ENTRIES = 20000;
  const MAX_IMPORT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

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
  let accountId = LEGACY_ACCOUNT;
  let rootGeneration = 0;
  let loaded = false;
  let initPromise = null;
  let saveTimer = null;
  let writeChain = Promise.resolve();
  let lastStorageError = null;
  let lastClearResult = { dispatchedActions: 0, dispatchedReviews: 0 };
  const subscribers = new Set();

  function isSafeSlug(slug) {
    return typeof slug === 'string' &&
      slug.length > 0 &&
      slug.length <= 200 &&
      /^[a-z0-9][a-z0-9-]*$/i.test(slug) &&
      slug !== '__proto__' &&
      slug !== 'constructor' &&
      slug !== 'prototype';
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function carryReviewSafetyMarkers(raw, generation) {
    const records = [];
    if (isRecord(raw)) {
      for (const rawAccountId of Object.keys(raw)) {
        const normalizedAccountId = normalizeAccountId(rawAccountId);
        if (!normalizedAccountId || normalizedAccountId !== rawAccountId || normalizedAccountId === LEGACY_ACCOUNT ||
            !isRecord(raw[rawAccountId])) continue;
        for (const slug of Object.keys(raw[rawAccountId])) {
          const marker = raw[rawAccountId][slug];
          const createdAt = new Date(marker?.createdAt).getTime();
          if (!isSafeSlug(slug) || !isRecord(marker) ||
              typeof marker.requestId !== 'string' || !marker.requestId || marker.requestId.length > 200 ||
              /[\r\n\0]/.test(marker.requestId) || !Number.isFinite(createdAt)) continue;
          records.push({
            accountId: normalizedAccountId,
            slug,
            generation,
            requestId: marker.requestId,
            createdAt: new Date(createdAt).toISOString(),
            reason: 'A review may have reached Letterboxd before local film data was cleared',
            status: 'uncertain',
            fingerprint: typeof marker.fingerprint === 'string' && marker.fingerprint.length <= 100
              ? marker.fingerprint
              : null
          });
        }
      }
    }
    records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const store = Object.create(null);
    for (const marker of records.slice(0, 100)) {
      if (!store[marker.accountId]) store[marker.accountId] = Object.create(null);
      store[marker.accountId][marker.slug] = marker;
    }
    return { store, count: records.slice(0, 100).length };
  }

  function carryDispatchedActions(raw, generation) {
    const latestByAction = new Map();
    if (isRecord(raw)) {
      for (const id of Object.keys(raw)) {
        const record = raw[id];
        const account = normalizeAccountId(record?.account);
        const slug = record?.slug;
        const filmUrl = canonicalFilmUrl(record?.filmUrl, slug);
        const mutationAt = new Date(record?.mutationAt).getTime();
        const dispatchedAt = new Date(record?.dispatchedAt).getTime();
        if (!isRecord(record) || record.id !== id || id.length > 500 || !filmUrl ||
            !['watch', 'like', 'watchlist'].includes(record.action) || !isSafeSlug(slug) ||
            !account || account === LEGACY_ACCOUNT || !Number.isFinite(mutationAt) ||
            record.dispatchedAt == null || !Number.isFinite(dispatchedAt) || typeof record.mutationToken !== 'string' ||
            !record.mutationToken || record.mutationToken.length > 200) continue;
        const carried = {
          id,
          filmUrl,
          action: record.action,
          slug,
          previousValue: record.previousValue === true,
          account: accountUsername(account),
          createdAt: new Date().toISOString(),
          mutationAt: new Date(mutationAt).toISOString(),
          mutationToken: record.mutationToken,
          generation,
          leaseOwner: null,
          leaseExpiresAt: null,
          dispatchedAt: new Date(dispatchedAt).toISOString()
        };
        const key = `${account}\0${slug}\0${record.action}`;
        const prior = latestByAction.get(key);
        if (!prior || dispatchedAt > new Date(prior.dispatchedAt).getTime()) latestByAction.set(key, carried);
      }
    }
    const records = Array.from(latestByAction.values())
      .sort((left, right) => right.dispatchedAt.localeCompare(left.dispatchedAt))
      .slice(0, 2000);
    const outbox = Object.create(null);
    for (const record of records) outbox[record.id] = record;
    return { outbox, count: records.length };
  }

  function normalizeAccountId(value) {
    if (isRecord(value)) value = value.username;
    if (value === LEGACY_ACCOUNT) return LEGACY_ACCOUNT;
    if (typeof value !== 'string') return null;
    let username = value.trim();
    if (username.startsWith('user:')) username = username.slice(5);
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(username)) return null;
    return `user:${username.toLowerCase()}`;
  }

  function accountUsername(id) {
    return typeof id === 'string' && id.startsWith('user:') ? id.slice(5) : null;
  }

  function isTimestamp(value) {
    return typeof value === 'string' && value.length <= 64 && Number.isFinite(new Date(value).getTime());
  }

  function isWatchedDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function isHttpUrl(value, letterboxdOnly = false) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (!letterboxdOnly || url.origin === 'https://letterboxd.com');
    } catch {
      return false;
    }
  }

  function utf8ByteLength(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
               value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
      if (bytes > MAX_IMPORT_BYTES) return bytes;
    }
    return bytes;
  }

  function canonicalFilmUrl(value, slug) {
    if (value == null) return null;
    try {
      const url = new URL(value);
      if (url.origin !== 'https://letterboxd.com' || url.username || url.password || url.search || url.hash) return null;
      const match = url.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i);
      return match && match[1] === slug ? `https://letterboxd.com/film/${slug}/` : null;
    } catch {
      return null;
    }
  }

  function trustedPosterUrl(value) {
    if (value == null) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      return new Set([
        'https://a.ltrbxd.com',
        'https://s.ltrbxd.com',
        'https://letterboxd.com'
      ]).has(url.origin) ? url.href : null;
    } catch {
      return null;
    }
  }

  function canonicalReviewUrl(value, slug, ownerAccountId) {
    if (value == null || !isSafeSlug(slug)) return null;
    const owner = accountUsername(ownerAccountId);
    if (!owner) return null;
    try {
      const url = new URL(value);
      if (url.origin !== 'https://letterboxd.com' || url.username || url.password || url.search || url.hash) return null;
      const current = url.pathname.match(/^\/([a-z0-9_]{1,64})\/film\/([a-z0-9][a-z0-9-]*)\/(?:([1-9]\d*)\/)?$/i);
      if (current && current[1].toLowerCase() === owner && current[2].toLowerCase() === slug.toLowerCase()) {
        return `https://letterboxd.com/${owner}/film/${slug}/${current[3] ? `${current[3]}/` : ''}`;
      }
      const legacy = url.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/reviews\/by\/([a-z0-9_]{1,64})\/(?:([a-z0-9][a-z0-9-]*)\/)?$/i);
      if (legacy && legacy[1].toLowerCase() === slug.toLowerCase() && legacy[2].toLowerCase() === owner) {
        return `https://letterboxd.com/film/${slug}/reviews/by/${owner}/${legacy[3] ? `${legacy[3]}/` : ''}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  function isRating(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5 &&
      Math.round(value * 2) === value * 2;
  }

  function isSource(value) {
    return value == null || ENTRY_SOURCES.has(value);
  }

  function freshMeta() {
    return {
      version: DATA_VERSION,
      generation: 0,
      lastSyncAt: null,
      syncDuration: null,
      syncCounts: null,
      updatedAt: null
    };
  }

  function freshAccount() {
    return { _meta: freshMeta(), slugs: Object.create(null) };
  }

  function freshRoot(active = LEGACY_ACCOUNT, generation = 0) {
    return {
      _meta: { version: DATA_VERSION, generation, activeAccount: active, updatedAt: null },
      accounts: Object.create(null)
    };
  }

  function normalizePrefs(raw) {
    const next = { ...DEFAULT_PREFS };
    if (!isRecord(raw)) return next;
    for (const key of Object.keys(DEFAULT_PREFS)) if (typeof raw[key] === 'boolean') next[key] = raw[key];
    return next;
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
      metadataCleared: [],
      metadataUpdatedAt: null,
      metadataSource: null,
      watched: false,   watchedAt: null, watchedDate: null, watchedChangedAt: null, watchedSource: null, watchedMutationToken: null,
      liked: false,     likedAt: null, likedChangedAt: null, likedSource: null, likedMutationToken: null,
      watchlist: false, watchlistAt: null, watchlistChangedAt: null, watchlistSource: null, watchlistMutationToken: null,
      skipped: false,   skippedAt: null, skippedChangedAt: null, skippedSource: null, skippedMutationToken: null,
      lastAction: null,  // 'watched' | 'liked' | 'watchlist' | 'skipped'
      source: null,      // 'userAction' | 'domSync' | 'import' | 'collectionSync'
      lastSyncedAt: null,
      updatedAt: null
    };
  }

  function normalizeEntry(entry, slug, ownerAccountId) {
    const raw = isRecord(entry) ? entry : {};
    const normalized = newEntry();
    for (const key of ['title', 'year', 'director', 'rating']) {
      if (typeof raw[key] === 'string' && raw[key].length <= 10000) normalized[key] = raw[key];
    }
    if (typeof raw.reviewText === 'string' && raw.reviewText.length <= MAX_REVIEW_TEXT_LENGTH) normalized.reviewText = raw.reviewText;
    if (Array.isArray(raw.genres)) normalized.genres = raw.genres.filter(value => typeof value === 'string' && value.length <= 200).slice(0, 100);
    normalized.poster = trustedPosterUrl(raw.poster);
    normalized.url = canonicalFilmUrl(raw.url, slug);
    normalized.reviewUrl = canonicalReviewUrl(raw.reviewUrl, slug, ownerAccountId);
    if (isRating(raw.ratingValue)) normalized.ratingValue = raw.ratingValue;
    for (const key of ['metadataUpdatedAt', 'lastSyncedAt', 'updatedAt']) {
      if (isTimestamp(raw[key])) normalized[key] = raw[key];
    }
    normalized.metadataSource = raw.metadataSource != null && isSource(raw.metadataSource) ? raw.metadataSource : null;
    normalized.source = raw.source != null && isSource(raw.source) ? raw.source : null;
    normalized.lastAction = FLAGS.includes(raw.lastAction) ? raw.lastAction : null;
    normalized.watchedDate = isWatchedDate(raw.watchedDate) ? raw.watchedDate : null;
    for (const flag of FLAGS) {
      normalized[flag] = raw[flag] === true;
      normalized[flag + 'At'] = isTimestamp(raw[flag + 'At']) ? raw[flag + 'At'] : null;
      normalized[flag + 'ChangedAt'] = isTimestamp(raw[flag + 'ChangedAt'])
        ? raw[flag + 'ChangedAt']
        : (normalized[flag + 'At'] || null);
      normalized[flag + 'Source'] = raw[flag + 'Source'] != null && isSource(raw[flag + 'Source'])
        ? raw[flag + 'Source']
        : normalized.source;
      normalized[flag + 'MutationToken'] = typeof raw[flag + 'MutationToken'] === 'string' &&
        raw[flag + 'MutationToken'].length > 0 && raw[flag + 'MutationToken'].length <= 200
        ? raw[flag + 'MutationToken']
        : null;
    }
    if (Array.isArray(raw.metadataCleared)) {
      normalized.metadataCleared = [...new Set(raw.metadataCleared.filter(key => METADATA_KEYS.includes(key)))];
      for (const key of normalized.metadataCleared) normalized[key] = null;
    }
    return normalized;
  }

  function normalizeAccount(rawAccount, ownerAccountId) {
    const raw = isRecord(rawAccount) ? rawAccount : {};
    const account = freshAccount();
    if (isRecord(raw._meta)) account._meta = { ...freshMeta(), ...raw._meta, version: DATA_VERSION };
    const rawSlugs = isRecord(raw.slugs) ? raw.slugs : {};
    for (const slug in rawSlugs) {
      if (isSafeSlug(slug)) account.slugs[slug] = normalizeEntry(rawSlugs[slug], slug, ownerAccountId);
    }
    return account;
  }

  function normalizeRoot(rawState, preferredAccount) {
    const preferred = normalizeAccountId(preferredAccount) || LEGACY_ACCOUNT;
    if (Number(rawState?._meta?.version) > DATA_VERSION) {
      throw new Error(`Stored state version ${rawState._meta.version} requires a newer extension`);
    }
    if (isRecord(rawState) && rawState._meta?.version === DATA_VERSION && isRecord(rawState.accounts)) {
      const generation = Number.isSafeInteger(rawState._meta.generation) && rawState._meta.generation >= 0
        ? rawState._meta.generation : 0;
      const root = freshRoot(normalizeAccountId(rawState._meta.activeAccount) || preferred, generation);
      root._meta.updatedAt = rawState._meta.updatedAt || null;
      for (const id in rawState.accounts) {
        const normalizedId = normalizeAccountId(id);
        if (normalizedId && normalizedId === id) root.accounts[id] = normalizeAccount(rawState.accounts[id], id);
      }
      return { root, migrated: false };
    }

    const root = freshRoot(preferred);
    if (isRecord(rawState) && isRecord(rawState.slugs)) {
      root.accounts[preferred] = normalizeAccount({ _meta: rawState._meta, slugs: rawState.slugs }, preferred);
      root._meta.updatedAt = new Date().toISOString();
      return { root, migrated: true };
    }
    return { root, migrated: Boolean(rawState) };
  }

  function ensureAccount(root, id) {
    if (!root.accounts[id]) root.accounts[id] = freshAccount();
    return root.accounts[id];
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

  function storageFailure(scope) {
    const message = storageErrorMessage() || 'Unknown storage error';
    lastStorageError = `${scope}: ${message}`;
    return new Error(lastStorageError);
  }

  function storageGet(area, keys, scope) {
    return new Promise((resolve, reject) => {
      try {
        area.get(keys, result => {
          if (storageErrorMessage()) reject(storageFailure(scope));
          else resolve(result || {});
        });
      } catch (error) {
        lastStorageError = `${scope}: ${error.message}`;
        reject(error);
      }
    });
  }

  function storageSet(area, items, scope) {
    return new Promise((resolve, reject) => {
      try {
        area.set(items, () => {
          if (storageErrorMessage()) reject(storageFailure(scope));
          else {
            lastStorageError = null;
            resolve();
          }
        });
      } catch (error) {
        lastStorageError = `${scope}: ${error.message}`;
        reject(error);
      }
    });
  }

  function storageRemove(area, keys, scope) {
    return new Promise((resolve, reject) => {
      try {
        area.remove(keys, () => {
          if (storageErrorMessage()) reject(storageFailure(scope));
          else {
            lastStorageError = null;
            resolve();
          }
        });
      } catch (error) {
        lastStorageError = `${scope}: ${error.message}`;
        reject(error);
      }
    });
  }

  function notifySubscribers(reason) {
    const snapshot = { reason, accountId, stats: VypodeFilmState.getStats(), meta: VypodeFilmState.getMeta() };
    for (const listener of subscribers) {
      try { listener(snapshot); } catch (error) { console.warn('Vypode state subscriber failed:', error); }
    }
  }

  // ── Storage I/O ─────────────────────────────────────────────────────

  async function loadFromStorage(accountHint) {
    const [localResult, syncResult] = await Promise.all([
      storageGet(chrome.storage.local, [STORAGE_KEY, USER_KEY], 'local.get during init'),
      storageGet(chrome.storage.sync, [PREFS_KEY], 'sync.get during init')
    ]);

    const requested = normalizeAccountId(accountHint) || normalizeAccountId(localResult[USER_KEY]);
    const { root, migrated } = normalizeRoot(localResult[STORAGE_KEY], requested);
    accountId = requested || normalizeAccountId(root._meta.activeAccount) || LEGACY_ACCOUNT;
    rootGeneration = root._meta.generation;
    const activeAccount = ensureAccount(root, accountId);
    registry = activeAccount.slugs;
    meta = activeAccount._meta;

    prefs = normalizePrefs(syncResult[PREFS_KEY]);

    if (migrated || root._meta.activeAccount !== accountId) {
      root._meta.activeAccount = accountId;
      root._meta.updatedAt = new Date().toISOString();
      await storageSet(chrome.storage.local, { [STORAGE_KEY]: root }, 'v3 migration');
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

  function mergeAccountMeta(storedMeta, incomingMeta) {
    const stored = isRecord(storedMeta) ? storedMeta : {};
    const incoming = isRecord(incomingMeta) ? incomingMeta : {};
    const incomingWins = timestamp(incoming.updatedAt || incoming.lastSyncAt) >=
      timestamp(stored.updatedAt || stored.lastSyncAt);
    return incomingWins
      ? { ...stored, ...incoming, version: DATA_VERSION }
      : { ...incoming, ...stored, version: DATA_VERSION };
  }

  function mergeEntryForSave(storedEntry, localEntry, slug, ownerAccountId = accountId) {
    const stored = normalizeEntry(storedEntry, slug, ownerAccountId);
    const local = normalizeEntry(localEntry, slug, ownerAccountId);
    const merged = { ...stored };

    const localMetadataAt = timestamp(local.metadataUpdatedAt || local.updatedAt);
    const storedMetadataAt = timestamp(stored.metadataUpdatedAt || stored.updatedAt);
    const localMetadataWins = localMetadataAt > storedMetadataAt ||
      (localMetadataAt === storedMetadataAt && sourcePriority(local.metadataSource) >= sourcePriority(stored.metadataSource));
    if (localMetadataWins) {
      const cleared = new Set(stored.metadataCleared || []);
      for (const key of local.metadataCleared || []) cleared.add(key);
      for (const key of ['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl']) {
        if (cleared.has(key)) {
          merged[key] = null;
        }
        if (local[key] !== undefined && local[key] !== null && local[key] !== '') {
          merged[key] = local[key];
          cleared.delete(key);
        }
      }
      merged.metadataCleared = Array.from(cleared);
      merged.metadataUpdatedAt = local.metadataUpdatedAt || local.updatedAt || merged.metadataUpdatedAt;
      merged.metadataSource = local.metadataSource || local.source || merged.metadataSource;
    }

    for (const flag of ['watched', 'liked', 'watchlist', 'skipped']) {
      const localTs = timestamp(local[flag + 'ChangedAt'] || local[flag + 'At']);
      const localChangesFlag = Object.prototype.hasOwnProperty.call(localEntry || {}, flag) &&
        (local[flag] === true || localTs > 0);
      if (!localChangesFlag) continue;
      const storedTs = timestamp(stored[flag + 'ChangedAt'] || stored[flag + 'At']);
      if (localTs || storedTs) {
        // Newer timestamp wins; on an exact tie, higher source priority wins so
        // a userAction beats a same-instant collectionSync reconcile.
        const localWins = localTs > storedTs ||
          (localTs === storedTs && sourcePriority(local[flag + 'Source']) >= sourcePriority(stored[flag + 'Source']));
        if (localWins) {
          merged[flag] = Boolean(local[flag]);
          merged[flag + 'At'] = local[flag + 'At'];
          merged[flag + 'ChangedAt'] = local[flag + 'ChangedAt'];
          merged[flag + 'Source'] = local[flag + 'Source'];
          merged[flag + 'MutationToken'] = local[flag + 'MutationToken'];
          if (flag === 'watched') merged.watchedDate = local.watchedDate;
        }
      } else if (local[flag]) {
        merged[flag] = true;
        merged[flag + 'At'] = local[flag + 'At'] || merged[flag + 'At'] || null;
        merged[flag + 'Source'] = local[flag + 'Source'] || merged[flag + 'Source'] || null;
        merged[flag + 'MutationToken'] = local[flag + 'MutationToken'] || merged[flag + 'MutationToken'] || null;
        if (flag === 'watched' && local.watchedDate) merged.watchedDate = local.watchedDate;
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

  function mergeRegistriesForClear(storedSlugs, localSlugs) {
    const merged = Object.create(null);
    for (const slug in storedSlugs || {}) {
      if (isSafeSlug(slug)) merged[slug] = normalizeEntry(storedSlugs[slug], slug, accountId);
    }
    for (const slug in localSlugs || {}) {
      if (!isSafeSlug(slug)) continue;
      merged[slug] = mergeEntryForSave(merged[slug], localSlugs[slug], slug, accountId);
    }
    return merged;
  }

  function snapshotRegistry(source) {
    const snapshot = Object.create(null);
    for (const slug in source) {
      if (!isSafeSlug(slug)) continue;
      const raw = source[slug];
      const entry = normalizeEntry(raw, slug, accountId);
      for (const flag of FLAGS) {
        const changedAt = timestamp(entry[flag + 'ChangedAt'] || entry[flag + 'At']);
        // newEntry() has false defaults. A metadata-only update must not send
        // those defaults as if it had changed each independent flag.
        if (entry[flag] !== true && !changedAt) {
          delete entry[flag];
          delete entry[flag + 'At'];
          delete entry[flag + 'ChangedAt'];
          delete entry[flag + 'Source'];
          delete entry[flag + 'MutationToken'];
          if (flag === 'watched') delete entry.watchedDate;
        }
      }
      snapshot[slug] = entry;
    }
    return snapshot;
  }

  async function sendStateCommand(action, data) {
    const sendMessage = chrome.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') return null;
    const response = sendMessage({ type: 'vypode-state', action, data });
    // Promise-based messaging is available in Manifest V3. The callback-only
    // fallback keeps the registry usable in older test hosts, but never masks a
    // rejected MV3 write: callers can await flush()/clear*() and see the error.
    if (!response || typeof response.then !== 'function') return null;
    return await response;
  }

  function writeToStorage() {
    const targetAccount = accountId;
    const targetGeneration = rootGeneration;
    const registrySnapshot = snapshotRegistry(registry);
    const metaSnapshot = { ...meta };
    writeChain = writeChain.catch(() => {}).then(async () => {
      const remote = await sendStateCommand('mergeAccount', {
        accountId: targetAccount,
        generation: targetGeneration,
        meta: metaSnapshot,
        slugs: registrySnapshot
      });
      if (remote?.ok) {
        if (accountId === targetAccount && remote.account) {
          rootGeneration = remote.generation;
          registry = mergeRegistriesForClear(remote.account.slugs, registry);
          meta = mergeAccountMeta(remote.account._meta, meta);
        }
        saveTimer = null;
        return true;
      }
      if (remote?.stale) {
        if (accountId === targetAccount) {
          const authoritativeAccountId = normalizeAccountId(remote.activeAccount) || targetAccount;
          accountId = authoritativeAccountId;
          rootGeneration = remote.generation;
          const authoritative = normalizeAccount(remote.account, authoritativeAccountId);
          registry = authoritative.slugs;
          meta = authoritative._meta;
          notifySubscribers('stale-write-rejected');
        }
        saveTimer = null;
        return false;
      }
      if (remote?.error) throw new Error(remote.error);
      return new Promise((resolve, reject) => {
      chrome.storage.local.get([STORAGE_KEY], result => {
      const readError = storageErrorMessage();
      if (readError) {
        recordStorageError('local.get');
        reject(new Error(readError));
        return;
      }
      const { root } = normalizeRoot(result[STORAGE_KEY], targetAccount);
      const storedActiveAccount = normalizeAccountId(root._meta.activeAccount) || LEGACY_ACCOUNT;
      if (root._meta.generation > targetGeneration || storedActiveAccount !== targetAccount) {
        if (accountId === targetAccount) {
          accountId = storedActiveAccount;
          rootGeneration = root._meta.generation;
          const authoritative = root.accounts[storedActiveAccount] || freshAccount();
          registry = authoritative.slugs;
          meta = authoritative._meta;
        }
        saveTimer = null;
        resolve(false);
        return;
      }
      const storedAccount = ensureAccount(root, targetAccount);
      const mergedRegistry = Object.create(null);
      const latestSlugs = storedAccount.slugs;

      for (const slug in latestSlugs) {
        if (!isSafeSlug(slug)) continue;
        mergedRegistry[slug] = normalizeEntry(latestSlugs[slug], slug, targetAccount);
      }
      for (const slug in registrySnapshot) {
        if (!isSafeSlug(slug)) continue;
        mergedRegistry[slug] = mergeEntryForSave(mergedRegistry[slug], registrySnapshot[slug], slug, targetAccount);
      }

      storedAccount._meta = mergeAccountMeta(storedAccount._meta, metaSnapshot);
      storedAccount.slugs = mergedRegistry;
      root.accounts[targetAccount] = storedAccount;
      root._meta.activeAccount = targetAccount;
      root._meta.updatedAt = new Date().toISOString();
      chrome.storage.local.set({ [STORAGE_KEY]: root }, () => {
        const writeError = storageErrorMessage();
        if (writeError) {
          recordStorageError('local.set');
          reject(new Error(writeError));
          return;
        }
        if (accountId === targetAccount) {
          rootGeneration = root._meta.generation;
          registry = mergeRegistriesForClear(mergedRegistry, registry);
          meta = mergeAccountMeta(storedAccount._meta, meta);
        }
        saveTimer = null;
        resolve(true);
      });
      });
      });
    });
    return writeChain;
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
      return writeToStorage().catch(error => { lastStorageError = error.message; return false; });
    }
    saveTimer = setTimeout(() => writeToStorage().catch(error => { lastStorageError = error.message; }), delay);
    return writeChain;
  }

  function savePrefs() {
    return storageSet(chrome.storage.sync, { [PREFS_KEY]: prefs }, 'sync.set');
  }

  async function reloadActiveFromStorage(reason, includePrefs = true) {
    const targetAccount = accountId;
    const [localResult, syncResult] = await Promise.all([
      storageGet(chrome.storage.local, [STORAGE_KEY], 'local.get while reloading state'),
      includePrefs ? storageGet(chrome.storage.sync, [PREFS_KEY], 'sync.get while reloading preferences') : Promise.resolve({})
    ]);
    const { root } = normalizeRoot(localResult[STORAGE_KEY], targetAccount);
    if (accountId !== targetAccount) return false;
    rootGeneration = root._meta.generation;
    const authoritative = root.accounts[targetAccount] || freshAccount();
    registry = authoritative.slugs;
    meta = authoritative._meta;
    if (includePrefs) prefs = normalizePrefs(syncResult[PREFS_KEY]);
    notifySubscribers(reason || 'state-reloaded');
    return true;
  }

  async function storedContextStillMatches(targetAccount, targetGeneration) {
    const result = await storageGet(chrome.storage.local, [STORAGE_KEY], 'local.get while checking state context');
    const { root } = normalizeRoot(result[STORAGE_KEY], targetAccount);
    return accountId === targetAccount && rootGeneration === targetGeneration && root._meta.generation === targetGeneration;
  }

  function handoffStateSnapshot() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const sendMessage = chrome.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') return false;
    const message = {
      type: 'vypode-state',
      action: 'mergeAccount',
      data: {
        accountId,
        generation: rootGeneration,
        meta: { ...meta },
        slugs: snapshotRegistry(registry)
      }
    };
    try {
      const pending = sendMessage(message);
      if (pending && typeof pending.then === 'function') pending.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function handleStorageChanged(changes, areaName) {
    if (!loaded || !isRecord(changes)) return;
    if (areaName === 'sync' && changes[PREFS_KEY]) {
      const nextPrefs = changes[PREFS_KEY].newValue;
      prefs = normalizePrefs(nextPrefs);
      notifySubscribers('preferences-changed');
      return;
    }
    if (areaName !== 'local') return;
    if (changes[STORAGE_KEY]) {
      let root;
      try {
        root = normalizeRoot(changes[STORAGE_KEY].newValue, accountId).root;
      } catch (error) {
        lastStorageError = error.message;
        notifySubscribers('unsupported-state-version');
        return;
      }
      const authoritativeAccountId = normalizeAccountId(root._meta.activeAccount) || LEGACY_ACCOUNT;
      let accountChanged = false;
      if (root._meta.generation > rootGeneration) {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        accountChanged = authoritativeAccountId !== accountId;
        accountId = authoritativeAccountId;
        rootGeneration = root._meta.generation;
        const external = root.accounts[accountId] || freshAccount();
        registry = external.slugs;
        meta = external._meta;
      } else if (root._meta.generation === rootGeneration) {
        if (authoritativeAccountId !== accountId) {
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
          }
          accountChanged = true;
          accountId = authoritativeAccountId;
          const external = root.accounts[accountId] || freshAccount();
          registry = external.slugs;
          meta = external._meta;
        } else {
          const external = root.accounts[accountId] || freshAccount();
          registry = mergeRegistriesForClear(external.slugs, registry);
          meta = mergeAccountMeta(external._meta, meta);
        }
      }
      notifySubscribers(accountChanged ? 'account-changed' : 'state-changed');
    }
    const nextAccount = normalizeAccountId(changes[USER_KEY]?.newValue);
    if (nextAccount && nextAccount !== accountId) {
      VypodeFilmState.switchAccount(nextAccount)
        .then(() => notifySubscribers('account-changed'))
        .catch(error => { lastStorageError = `account switch: ${error.message}`; });
    }
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
        raw.slugs[slug] = normalizeEntry(raw.slugs[slug], slug, accountId);
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

  function actualWatchedDate(entry) {
    return entry?.watchedDate || null;
  }

  function validateImportedEntry(raw, slug) {
    if (!isRecord(raw)) throw new Error('Each imported film must be an object');
    const sanitized = { ...raw };
    for (const key of ['title', 'year', 'director', 'rating']) {
      if (key in raw && raw[key] !== null && (typeof raw[key] !== 'string' || raw[key].length > 10000)) throw new Error(`Invalid ${key}`);
    }
    if ('reviewText' in raw && raw.reviewText !== null &&
        (typeof raw.reviewText !== 'string' || raw.reviewText.length > MAX_REVIEW_TEXT_LENGTH)) throw new Error('Invalid reviewText');
    if ('genres' in raw && raw.genres !== null && (!Array.isArray(raw.genres) || raw.genres.length > 100 || raw.genres.some(value => typeof value !== 'string' || value.length > 200))) {
      throw new Error('Invalid genres');
    }
    if ('url' in raw) sanitized.url = canonicalFilmUrl(raw.url, slug);
    if ('poster' in raw) sanitized.poster = trustedPosterUrl(raw.poster);
    if ('reviewUrl' in raw) sanitized.reviewUrl = canonicalReviewUrl(raw.reviewUrl, slug, accountId);
    if ('ratingValue' in raw && raw.ratingValue !== null && !isRating(raw.ratingValue)) throw new Error('Invalid rating value');
    for (const key of ['metadataUpdatedAt', 'lastSyncedAt', 'updatedAt', ...FLAGS.flatMap(flag => [`${flag}At`, `${flag}ChangedAt`])]) {
      if (key in raw && raw[key] !== null) {
        if (!isTimestamp(raw[key])) throw new Error(`Invalid ${key}`);
        if (new Date(raw[key]).getTime() > Date.now() + MAX_IMPORT_FUTURE_SKEW_MS) throw new Error(`Invalid future ${key}`);
      }
    }
    if ('watchedDate' in raw && raw.watchedDate !== null && !isWatchedDate(raw.watchedDate)) throw new Error('Invalid watched date');
    if (raw.watchedDate && new Date(`${raw.watchedDate}T00:00:00.000Z`).getTime() > Date.now() + MAX_IMPORT_FUTURE_SKEW_MS) {
      throw new Error('Invalid future watched date');
    }
    for (const flag of FLAGS) {
      if (flag in raw && typeof raw[flag] !== 'boolean') throw new Error(`Invalid ${flag}`);
      if (`${flag}Source` in raw && !isSource(raw[`${flag}Source`])) throw new Error(`Invalid ${flag} source`);
    }
    if (!isSource(raw.source) || !isSource(raw.metadataSource)) throw new Error('Invalid import source');
    if ('lastAction' in raw && raw.lastAction !== null && !FLAGS.includes(raw.lastAction)) throw new Error('Invalid last action');
    if ('metadataCleared' in raw && (!Array.isArray(raw.metadataCleared) ||
        raw.metadataCleared.length > METADATA_KEYS.length || raw.metadataCleared.some(key => !METADATA_KEYS.includes(key)))) {
      throw new Error('Invalid cleared metadata keys');
    }
    return normalizeEntry(sanitized, slug, accountId);
  }

  function validateImport(jsonString) {
    if (typeof jsonString !== 'string') throw new Error('Import must be text');
    if (utf8ByteLength(jsonString) > MAX_IMPORT_BYTES) throw new Error('Import is too large');
    const data = JSON.parse(jsonString);
    if (!isRecord(data) || !isRecord(data.slugs)) throw new Error('Invalid format: missing slugs object');
    if (Number(data._meta?.version) > DATA_VERSION) throw new Error(`Backup version ${data._meta.version} requires a newer extension`);
    const slugs = Object.keys(data.slugs);
    if (slugs.length > MAX_IMPORT_ENTRIES) throw new Error('Import has too many films');
    const imported = Object.create(null);
    for (const slug of slugs) {
      // Old exports may include dangerous keys. Ignore those records rather than
      // allowing an untrusted backup to mutate object prototypes.
      if (!isSafeSlug(slug)) continue;
      imported[slug] = { raw: data.slugs[slug], entry: validateImportedEntry(data.slugs[slug], slug) };
    }
    let importedPrefs = null;
    if ('prefs' in data) {
      if (!isRecord(data.prefs)) throw new Error('Invalid preferences');
      importedPrefs = {};
      for (const key of Object.keys(data.prefs)) {
        if (!(key in DEFAULT_PREFS) || typeof data.prefs[key] !== 'boolean') throw new Error('Invalid preferences');
        importedPrefs[key] = data.prefs[key];
      }
    }
    return { imported, prefs: importedPrefs };
  }

  // ── Public API ──────────────────────────────────────────────────────

  const VypodeFilmState = {

    // Must be called once before any other method
    async init(requestedAccount) {
      const requested = normalizeAccountId(requestedAccount);
      if (loaded) {
        if (requested && requested !== accountId) await this.switchAccount(requested);
        return;
      }
      if (!initPromise) initPromise = loadFromStorage(requested);
      try {
        await initPromise;
      } catch (error) {
        initPromise = null;
        throw error;
      }
    },

    isLoaded() {
      return loaded;
    },

    getAccountId() {
      return accountId;
    },

    getAccountUsername() {
      return accountUsername(accountId);
    },

    async switchAccount(nextAccount) {
      const normalized = normalizeAccountId(nextAccount);
      if (!normalized) throw new Error('Invalid Letterboxd account identifier');
      if (!loaded) return this.init(normalized);
      if (normalized === accountId) return;
      await this.flush();
      const result = await storageGet(chrome.storage.local, [STORAGE_KEY], 'local.get during account switch');
      const { root } = normalizeRoot(result[STORAGE_KEY], normalized);
      const remote = await sendStateCommand('activateAccount', { accountId: normalized, generation: root._meta.generation });
      if (remote?.error) throw new Error(remote.error);
      if (remote?.stale) {
        const latest = await storageGet(chrome.storage.local, [STORAGE_KEY], 'local.get retrying account switch');
        const retryRoot = normalizeRoot(latest[STORAGE_KEY], normalized).root;
        const retry = await sendStateCommand('activateAccount', { accountId: normalized, generation: retryRoot._meta.generation });
        if (retry?.error || retry?.stale) throw new Error(retry?.error || 'Account switch was superseded by another change');
        accountId = normalized;
        rootGeneration = retry.generation;
        const next = normalizeAccount(retry.account, normalized);
        registry = next.slugs;
        meta = next._meta;
      } else if (remote?.ok) {
        accountId = normalized;
        rootGeneration = remote.generation;
        const next = normalizeAccount(remote.account, normalized);
        registry = next.slugs;
        meta = next._meta;
      } else {
        // The extension service worker may be unavailable in a test page or
        // during startup. This fallback still writes a snapshot, never a live
        // registry reference.
        const next = ensureAccount(root, normalized);
        root._meta.activeAccount = normalized;
        root._meta.updatedAt = new Date().toISOString();
        await storageSet(chrome.storage.local, { [STORAGE_KEY]: root }, 'local.set during account switch');
        accountId = normalized;
        rootGeneration = root._meta.generation;
        registry = next.slugs;
        meta = next._meta;
      }
      notifySubscribers('account-changed');
    },

    async listAccounts() {
      const result = await storageGet(chrome.storage.local, [STORAGE_KEY], 'local.get while listing accounts');
      const { root } = normalizeRoot(result[STORAGE_KEY], accountId);
      return Object.keys(root.accounts).map(id => ({ id, username: accountUsername(id), legacy: id === LEGACY_ACCOUNT }));
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
      return { ...meta, accountId, rootGeneration, lastStorageError };
    },

    getPrefs() {
      return { ...prefs };
    },

    getLimits() {
      return { importBytes: MAX_IMPORT_BYTES, importEntries: MAX_IMPORT_ENTRIES, reviewText: MAX_REVIEW_TEXT_LENGTH };
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
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
        ...normalizeEntry(entry, slug, accountId)
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
        rows = rows.filter(e => e.watched && actualWatchedDate(e));
      } else if (dateFilter === 'watched-last-30') {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        rows = rows.filter(e => e.watched && actualWatchedDate(e) && new Date(actualWatchedDate(e)).getTime() >= cutoff);
      } else if (dateFilter === 'watched-this-year') {
        const year = new Date().getFullYear();
        rows = rows.filter(e => e.watched && actualWatchedDate(e) && new Date(actualWatchedDate(e)).getFullYear() === year);
      } else if (dateFilter === 'missing-watched-date') {
        rows = rows.filter(e => e.watched && !actualWatchedDate(e));
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
          return String(actualWatchedDate(b) || '').localeCompare(String(actualWatchedDate(a) || '')) || String(a.title || a.slug).localeCompare(String(b.title || b.slug));
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

    // A small, explicit API for skip-management surfaces. Keeping this on the
    // account-bound registry avoids callers having to inspect the v3 storage
    // envelope (and accidentally showing another account's skipped films).
    getSkipped(options) {
      return this.query({ ...(options || {}), filter: 'skipped' });
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
    setFlag(slug, flag, value, source, mutationToken) {
      if (!isSafeSlug(slug) || !['watched', 'liked', 'watchlist', 'skipped'].includes(flag) || typeof value !== 'boolean') return false;
      if (mutationToken !== undefined &&
          (typeof mutationToken !== 'string' || !mutationToken || mutationToken.length > 200)) return false;
      const now = new Date().toISOString();
      const provenance = ENTRY_SOURCES.has(source) ? source : 'userAction';
      if (!registry[slug]) registry[slug] = newEntry();
      const entry = registry[slug];
      entry[flag] = value;
      entry[flag + 'At'] = value ? now : null;
      entry[flag + 'ChangedAt'] = now;
      entry[flag + 'Source'] = provenance;
      entry[flag + 'MutationToken'] = mutationToken || null;
      if (flag === 'watched' && !value) entry.watchedDate = null;
      entry.lastAction = flag;
      entry.source = provenance;
      entry.updatedAt = now;
      saveToStorage(source === 'userAction' ? 0 : 300);
      // Best-effort notification for popup/test listeners.
      this._notifyBackground('stateChanged', { slug, flag, value, source: entry.source, timestamp: now });
      return true;
    },

    async setFlagPersisted(slug, flag, value, source, mutationToken, expectedContext) {
      const targetAccount = accountId;
      const targetGeneration = rootGeneration;
      if (expectedContext && (expectedContext.accountId !== targetAccount ||
          Number(expectedContext.generation) !== targetGeneration)) return false;
      if (!this.setFlag(slug, flag, value, source, mutationToken)) return false;
      try {
        const persisted = await this.flush();
        if (persisted === false || accountId !== targetAccount || rootGeneration !== targetGeneration) {
          try { await reloadActiveFromStorage('flag-write-rejected', false); } catch {}
          return false;
        }
        return true;
      } catch (error) {
        try { await reloadActiveFromStorage('flag-write-failed', false); } catch {}
        throw error;
      }
    },

    updateFilm(slug, patch, source) {
      if (!isSafeSlug(slug)) return false;
      if (!slug || !patch || typeof patch !== 'object') return false;
      const now = new Date().toISOString();
      if (!registry[slug]) registry[slug] = newEntry();
      const entry = registry[slug];
      const previousFlags = Object.fromEntries(FLAGS.map(flag => [flag, entry[flag]]));
      const allowed = [
        'title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl',
        'watched', 'watchedAt', 'watchedDate', 'liked', 'likedAt', 'watchlist', 'watchlistAt',
        'skipped', 'skippedAt', 'lastAction'
      ];
      let metadataChanged = false;
      const clearedMetadata = new Set(entry.metadataCleared || []);
      for (const key of allowed) {
        if (key in patch && patch[key] !== undefined) {
          let value = patch[key];
          if (key === 'url' && value !== null) value = canonicalFilmUrl(value, slug);
          if (key === 'poster' && value !== null) value = trustedPosterUrl(value);
          if (key === 'reviewUrl' && value !== null) value = canonicalReviewUrl(value, slug, accountId);
          if (['url', 'poster', 'reviewUrl'].includes(key) && patch[key] !== null && !value) continue;
          if (['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl'].includes(key) && entry[key] !== value) {
            metadataChanged = true;
            if (value === null) clearedMetadata.add(key);
            else if (value !== '') clearedMetadata.delete(key);
          }
          entry[key] = value;
        }
      }
      for (const flag of ['watched', 'liked', 'watchlist', 'skipped']) {
        if (typeof patch[flag] !== 'boolean') continue;
        const explicitChangedAt = patch[flag + 'ChangedAt'] || patch[flag + 'At'] || patch.updatedAt;
        // Metadata enrichment often repeats a true flag already held in the
        // registry. Preserve the original mutation identity in that case so a
        // later failed optimistic action can be rolled back safely. A genuine
        // value change or an explicitly timestamped reconcile gets a new
        // provenance record.
        if (previousFlags[flag] === patch[flag] && !explicitChangedAt) continue;
        entry[flag + 'ChangedAt'] = explicitChangedAt || now;
        entry[flag + 'Source'] = ENTRY_SOURCES.has(source) ? source : (ENTRY_SOURCES.has(patch.source) ? patch.source : entry[flag + 'Source'] || 'userAction');
        entry[flag + 'MutationToken'] = typeof patch[flag + 'MutationToken'] === 'string' &&
          patch[flag + 'MutationToken'].length <= 200 ? patch[flag + 'MutationToken'] : null;
      }
      if (isWatchedDate(patch.watchedDate)) entry.watchedDate = patch.watchedDate;
      else if (patch.watched === false) entry.watchedDate = null;
      // NOTE: updateFilm is a literal patch — it does NOT fabricate a flag timestamp.
      // A film marked watched with no watchedAt is intentionally surfaced by the
      // 'missing-watched-date' filter. setFlag()/bulkSetFromSync() stamp 'now'
      // because they represent an action that genuinely happened now.
      entry.source = source || patch.source || entry.source || 'userAction';
      if (metadataChanged) {
        entry.metadataCleared = Array.from(clearedMetadata);
        entry.metadataUpdatedAt = patch.metadataUpdatedAt || patch.updatedAt || now;
        entry.metadataSource = source || patch.source || 'userAction';
      }
      entry.lastSyncedAt = patch.lastSyncedAt || entry.lastSyncedAt;
      entry.updatedAt = patch.updatedAt || now;
      saveToStorage(source === 'userAction' ? 0 : 300);
      return true;
    },

    // Bulk update from collection sync — only sets flags that are true
    bulkSetFromSync(slugMap, source, options) {
      // slugMap: { slug: { title, poster, ratingValue, watched: true, liked: false, watchlist: true } }
      const now = new Date().toISOString();
      const syncStartedAt = isTimestamp(options?.syncStartedAt) ? options.syncStartedAt : now;
      const cutoff = timestamp(syncStartedAt);
      let count = 0;
      for (const slug in slugMap) {
        if (!isSafeSlug(slug)) continue;
        if (!registry[slug]) registry[slug] = newEntry();
        const entry = registry[slug];
        const incoming = slugMap[slug];
        if (!isRecord(incoming)) continue;
        const metadataKeys = ['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl'];
        let metadataChanged = false;
        if (timestamp(entry.metadataUpdatedAt || entry.updatedAt) <= cutoff) {
          const clearedMetadata = new Set(entry.metadataCleared || []);
          for (const key of metadataKeys) {
            let value = incoming[key];
            if (key === 'url' && value != null) value = canonicalFilmUrl(value, slug);
            if (key === 'poster' && value != null) value = trustedPosterUrl(value);
            if (key === 'reviewUrl' && value != null) value = canonicalReviewUrl(value, slug, accountId);
            if (['url', 'poster', 'reviewUrl'].includes(key) && incoming[key] != null && !value) continue;
            if (value !== undefined && value !== null && value !== entry[key]) {
              entry[key] = value;
              clearedMetadata.delete(key);
              metadataChanged = true;
              count++;
            }
          }
          entry.metadataCleared = Array.from(clearedMetadata);
        }
        if (metadataChanged) {
          entry.metadataUpdatedAt = incoming.metadataUpdatedAt || syncStartedAt;
          entry.metadataSource = source || 'collectionSync';
          entry.updatedAt = now;
        }
        if (isWatchedDate(incoming.watchedDate) && incoming.watchedDate !== entry.watchedDate &&
            timestamp(entry.watchedChangedAt || entry.watchedAt) <= cutoff) {
          entry.watchedDate = incoming.watchedDate;
          entry.updatedAt = now;
          count++;
        }
        for (const flag of ['watched', 'liked', 'watchlist']) {
          if (incoming[flag] && !entry[flag] && timestamp(entry[flag + 'ChangedAt'] || entry[flag + 'At']) <= cutoff) {
            entry[flag] = true;
            entry[flag + 'At'] = incoming[flag + 'At'] || null;
            entry[flag + 'ChangedAt'] = syncStartedAt;
            entry[flag + 'Source'] = source || 'collectionSync';
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

    reconcileFlags(flagSets, source, options) {
      const now = new Date().toISOString();
      const syncStartedAt = isTimestamp(options?.syncStartedAt) ? options.syncStartedAt : now;
      const cutoff = timestamp(syncStartedAt);
      let count = 0;
      for (const slug in registry) {
        if (!isSafeSlug(slug)) continue;
        const entry = registry[slug];
        if (!entry || typeof entry !== 'object') continue;
        for (const flag of ['watched', 'liked', 'watchlist']) {
          const set = flagSets?.[flag];
          if (!set || !entry[flag] || set.has(slug)) continue;
          if (timestamp(entry[flag + 'ChangedAt'] || entry[flag + 'At']) > cutoff) continue;
          if (entry[flag + 'Source'] === (source || 'collectionSync')) {
            entry[flag] = false;
            entry[flag + 'At'] = null;
            entry[flag + 'ChangedAt'] = syncStartedAt;
            entry[flag + 'Source'] = source || 'collectionSync';
            entry.source = source || 'collectionSync';
            entry.updatedAt = now;
            count++;
          }
        }
      }
      if (count > 0) saveToStorage();
      return count;
    },

    reconcileSyncMetadata(diaryEvidence, source, options) {
      const now = new Date().toISOString();
      const syncStartedAt = isTimestamp(options?.syncStartedAt) ? options.syncStartedAt : now;
      const cutoff = timestamp(syncStartedAt);
      const evidence = isRecord(diaryEvidence) ? diaryEvidence : {};
      let count = 0;
      for (const slug in registry) {
        if (!isSafeSlug(slug)) continue;
        const entry = registry[slug];
        if (!entry || timestamp(entry.metadataUpdatedAt || entry.updatedAt) > cutoff) continue;
        const record = isRecord(evidence[slug]) ? evidence[slug] : null;
        // Missing evidence means the remote pages did not authoritatively
        // describe this metadata. Never infer absence from an omitted record,
        // and never tombstone metadata owned by an import or direct user action.
        if (!record || entry.metadataSource !== (source || 'collectionSync')) continue;
        const cleared = new Set(entry.metadataCleared || []);
        let changed = false;
        if (record.ratingPresent === false) {
          for (const key of ['rating', 'ratingValue']) {
            if (entry[key] !== null || !cleared.has(key)) {
              entry[key] = null;
              cleared.add(key);
              changed = true;
            }
          }
        }
        if (record.reviewPresent === false) {
          for (const key of ['reviewText', 'reviewUrl']) {
            if (entry[key] !== null || !cleared.has(key)) {
              entry[key] = null;
              cleared.add(key);
              changed = true;
            }
          }
        }
        if (!changed) continue;
        entry.metadataCleared = Array.from(cleared);
        entry.metadataUpdatedAt = syncStartedAt;
        entry.metadataSource = source || 'collectionSync';
        entry.source = source || 'collectionSync';
        entry.updatedAt = now;
        count++;
      }
      if (count > 0) saveToStorage();
      return count;
    },

    // Merge imported registry data — latest timestamp wins per flag.
    mergeImportedRegistry(importedRegistry, options) {
      let merged = 0;
      for (const slug in importedRegistry) {
        if (!isSafeSlug(slug)) continue;
        const payload = importedRegistry[slug];
        const rawImported = payload?.raw || payload || {};
        const imported = payload?.entry || normalizeEntry(rawImported, slug, accountId);
        if (!registry[slug]) {
          registry[slug] = { ...newEntry(), ...imported, source: 'import' };
          registry[slug].metadataSource = 'import';
          for (const flag of FLAGS) {
            if (typeof rawImported[flag] === 'boolean') {
              registry[slug][flag + 'Source'] = 'import';
              registry[slug][flag + 'ChangedAt'] = imported[flag + 'ChangedAt'];
            }
          }
          merged++;
          continue;
        }
        const local = registry[slug];
        const importedMetadataAt = timestamp(imported.metadataUpdatedAt || imported.updatedAt);
        const localMetadataAt = timestamp(local.metadataUpdatedAt || local.updatedAt);
        if (importedMetadataAt > localMetadataAt ||
            (importedMetadataAt === localMetadataAt && sourcePriority('import') > sourcePriority(local.metadataSource || local.source))) {
          const cleared = new Set(imported.metadataCleared || []);
          for (const key of METADATA_KEYS) {
            if (cleared.has(key) && local[key] !== null) {
              local[key] = null;
              local.metadataSource = 'import';
              local.metadataUpdatedAt = imported.metadataUpdatedAt || imported.updatedAt || local.metadataUpdatedAt;
              merged++;
            } else if (!cleared.has(key) && imported[key] !== null && imported[key] !== '' && imported[key] !== undefined && imported[key] !== local[key]) {
              local[key] = imported[key];
              local.metadataSource = 'import';
              local.metadataUpdatedAt = imported.metadataUpdatedAt || imported.updatedAt || local.metadataUpdatedAt;
              merged++;
            }
          }
          local.metadataCleared = Array.from(cleared);
        }
        for (const flag of FLAGS) {
          const importedTs = imported[flag + 'ChangedAt'] || imported[flag + 'At'];
          const localTs = local[flag + 'ChangedAt'] || local[flag + 'At'];
          const importedTime = timestamp(importedTs);
          const localTime = timestamp(localTs);
          if (Object.prototype.hasOwnProperty.call(rawImported, flag) &&
              typeof rawImported[flag] === 'boolean' &&
              importedTime > 0 &&
              (importedTime > localTime ||
                (importedTime === localTime && sourcePriority('import') > sourcePriority(local[flag + 'Source'] || local.source)))) {
            local[flag] = rawImported[flag];
            local[flag + 'At'] = imported[flag + 'At'];
            local[flag + 'ChangedAt'] = importedTs;
            local[flag + 'Source'] = 'import';
            if (flag === 'watched') local.watchedDate = imported.watchedDate;
            local.source = 'import';
            merged++;
          }
        }
        // Use the latest instant. On an exact tie, a user action remains the
        // authoritative record and equal-priority imports retain the first
        // accepted value instead of depending on string formatting or order.
        const importedUpdatedAt = timestamp(imported.updatedAt);
        const localUpdatedAt = timestamp(local.updatedAt);
        if (importedUpdatedAt > localUpdatedAt ||
            (importedUpdatedAt === localUpdatedAt && importedUpdatedAt > 0 &&
              sourcePriority('import') > sourcePriority(local.source))) {
          local.lastAction = imported.lastAction || local.lastAction;
          local.updatedAt = imported.updatedAt;
        }
      }
      if (merged > 0 && options?.persist !== false) saveToStorage();
      return merged;
    },

    // ── Sync metadata ───────────────────────────────────────────────

    setSyncMeta(lastSyncAt, duration, counts) {
      meta.lastSyncAt = lastSyncAt;
      meta.syncDuration = duration;
      meta.syncCounts = counts;
      meta.updatedAt = new Date().toISOString();
      saveToStorage();
    },

    // ── Preferences ─────────────────────────────────────────────────

    async setPref(key, value) {
      if (key in DEFAULT_PREFS && typeof value === 'boolean') {
        const previous = prefs[key];
        prefs[key] = value;
        try {
          await savePrefs();
          return true;
        } catch (error) {
          if (prefs[key] === value) prefs[key] = previous;
          notifySubscribers('preference-write-failed');
          throw error;
        }
      }
      return false;
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
        const watchedDate = actualWatchedDate(e) || '';
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

    async importData(jsonString, expectedContext) {
      let data;
      try {
        data = validateImport(jsonString);
      } catch (e) {
        return { success: false, error: 'Invalid JSON: ' + e.message };
      }
      const targetAccount = accountId;
      const targetGeneration = rootGeneration;
      if (expectedContext && (expectedContext.accountId !== targetAccount ||
          Number(expectedContext.generation) !== targetGeneration)) {
        return { success: false, contextChanged: true, error: 'The active Letterboxd account or data generation changed' };
      }
      const previousPrefs = { ...prefs };
      let importedPrefsSaved = false;
      let importedPrefsSnapshot = null;
      const restorePreferences = async () => {
        if (!importedPrefsSaved) {
          prefs = previousPrefs;
          return null;
        }
        try {
          const currentResult = await storageGet(chrome.storage.sync, [PREFS_KEY], 'sync.get while rolling back import');
          const currentPrefs = normalizePrefs(currentResult[PREFS_KEY]);
          const rollback = { ...currentPrefs };
          // Another tab may change a preference after the import write. Restore
          // only values that still equal this import's exact snapshot.
          for (const key of Object.keys(DEFAULT_PREFS)) {
            if (currentPrefs[key] === importedPrefsSnapshot?.[key]) rollback[key] = previousPrefs[key];
          }
          prefs = rollback;
          await storageSet(chrome.storage.sync, { [PREFS_KEY]: rollback }, 'sync.set while rolling back import');
          importedPrefsSaved = false;
          return null;
        } catch (error) {
          return error;
        }
      };
      try {
        // Finish any earlier local edits before taking the transaction boundary.
        // Imported preferences are written first; if the subsequent local write
        // fails, they can be restored without ever reporting a partial import.
        const priorPersisted = await this.flush();
        if (priorPersisted === false) throw new Error('Could not persist pending local changes before import');
        if (!(await storedContextStillMatches(targetAccount, targetGeneration))) {
          await reloadActiveFromStorage('import-context-changed');
          return { success: false, contextChanged: true, error: 'The active Letterboxd data changed during import' };
        }
        if (data.prefs) {
          const intendedImportedPrefs = { ...DEFAULT_PREFS, ...data.prefs };
          importedPrefsSnapshot = { ...intendedImportedPrefs };
          prefs = { ...intendedImportedPrefs };
          try {
            await storageSet(chrome.storage.sync, { [PREFS_KEY]: intendedImportedPrefs }, 'sync.set during import');
            importedPrefsSaved = true;
          } catch (error) {
            prefs = previousPrefs;
            return { success: false, error: `Import failed: preferences could not be saved: ${error.message}` };
          }
        }
        const importCount = this.mergeImportedRegistry(data.imported, { persist: false });
        if (accountId !== targetAccount || rootGeneration !== targetGeneration) {
          const rollbackError = await restorePreferences();
          await reloadActiveFromStorage('import-context-changed');
          return {
            success: false,
            contextChanged: true,
            error: rollbackError
              ? `The active Letterboxd account changed; preference rollback also failed: ${rollbackError.message}`
              : 'The active Letterboxd account or data generation changed'
          };
        }
        const statePersisted = await this.flush();
        if (statePersisted === false || !(await storedContextStillMatches(targetAccount, targetGeneration))) {
          const rollbackError = await restorePreferences();
          await reloadActiveFromStorage('import-context-changed');
          return {
            success: false,
            contextChanged: true,
            error: rollbackError
              ? `The active Letterboxd data changed; preference rollback also failed: ${rollbackError.message}`
              : 'The active Letterboxd data changed during import'
          };
        }
        return { success: true, merged: importCount };
      } catch (e) {
        const rollbackError = await restorePreferences();
        try { await reloadActiveFromStorage('import-failed'); } catch {}
        return {
          success: false,
          error: rollbackError
            ? `Import failed: ${e.message}; preference rollback also failed: ${rollbackError.message}`
            : 'Import failed: ' + e.message
        };
      }
    },

    // ── Clear ───────────────────────────────────────────────────────

    async clearAll() {
      lastClearResult = { dispatchedActions: 0, dispatchedReviews: 0 };
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await writeChain.catch(() => {});
      const targetAccount = accountId;
      const requestedGeneration = rootGeneration + 1;
      const remote = await sendStateCommand('clearAll', {
        accountId: targetAccount,
        generation: requestedGeneration
      });
      if (remote?.error) throw new Error(remote.error);
      if (remote?.ok) {
        rootGeneration = remote.generation;
        accountId = LEGACY_ACCOUNT;
        registry = Object.create(null);
        meta = freshMeta();
        lastClearResult = {
          dispatchedActions: Number.isSafeInteger(remote.dispatchedActions) && remote.dispatchedActions > 0
            ? remote.dispatchedActions
            : 0,
          dispatchedReviews: Number.isSafeInteger(remote.dispatchedReviews) && remote.dispatchedReviews > 0
            ? remote.dispatchedReviews
            : 0
        };
        notifySubscribers('cleared-all');
        return true;
      }
      if (remote?.stale) {
        const authoritativeAccountId = normalizeAccountId(remote.activeAccount) || targetAccount;
        accountId = authoritativeAccountId;
        rootGeneration = remote.generation;
        const authoritative = normalizeAccount(remote.account, authoritativeAccountId);
        registry = authoritative.slugs;
        meta = authoritative._meta;
        notifySubscribers('stale-clear-rejected');
        return false;
      }
      const result = await storageGet(
        chrome.storage.local,
        [STORAGE_KEY, 'vypode_action_outbox_v1', 'vypode_review_uncertain_v1'],
        'local.get during clear all'
      );
      const { root } = normalizeRoot(result[STORAGE_KEY], accountId);
      rootGeneration = Math.max(rootGeneration, root._meta.generation) + 1;
      accountId = LEGACY_ACCOUNT;
      registry = Object.create(null);
      meta = freshMeta();
      const cleared = freshRoot(LEGACY_ACCOUNT, rootGeneration);
      cleared._meta.updatedAt = new Date().toISOString();
      const carriedActions = carryDispatchedActions(result.vypode_action_outbox_v1, rootGeneration);
      const carriedReviews = carryReviewSafetyMarkers(result.vypode_review_uncertain_v1, rootGeneration);
      await storageSet(chrome.storage.local, {
        [STORAGE_KEY]: cleared,
        vypode_action_outbox_v1: carriedActions.outbox,
        vypode_action_outcomes_v1: Object.create(null),
        vypode_review_drafts_v1: Object.create(null),
        vypode_review_uncertain_v1: carriedReviews.store,
        vypode_review_submissions_v1: Object.create(null),
        [USER_KEY]: null
      }, 'local.set during clear all');
      lastClearResult = {
        dispatchedActions: carriedActions.count,
        dispatchedReviews: carriedReviews.count
      };
      notifySubscribers('cleared-all');
      return true;
    },

    async clearSkipped() {
      await this.flush();
      const previousRegistry = Object.create(null);
      for (const slug in registry) if (isSafeSlug(slug)) previousRegistry[slug] = normalizeEntry(registry[slug], slug, accountId);
      const previousMeta = { ...meta };
      const clearedAt = new Date().toISOString();
      for (const slug in registry) {
        if (!isSafeSlug(slug)) continue;
        if (registry[slug].skipped) {
          registry[slug].skipped = false;
          registry[slug].skippedAt = null;
          registry[slug].skippedChangedAt = clearedAt;
          registry[slug].skippedSource = 'userAction';
          registry[slug].updatedAt = clearedAt;
        }
      }
      try {
        const remote = await sendStateCommand('clearSkipped', {
          accountId,
          generation: rootGeneration,
          at: clearedAt
        });
        if (remote?.error) throw new Error(remote.error);
        if (remote) {
          rootGeneration = remote.generation;
          const authoritative = normalizeAccount(remote.account, accountId);
          registry = authoritative.slugs;
          meta = authoritative._meta;
          notifySubscribers(remote.ok ? 'cleared-skipped' : 'stale-clear-rejected');
          return remote.ok;
        }
        const result = await storageGet(chrome.storage.local, [STORAGE_KEY], 'local.get during clear skipped');
        const { root } = normalizeRoot(result[STORAGE_KEY], accountId);
        if (root._meta.generation > rootGeneration) {
          rootGeneration = root._meta.generation;
          registry = root.accounts[accountId]?.slugs || Object.create(null);
          notifySubscribers('stale-clear-rejected');
          return false;
        }
        const account = ensureAccount(root, accountId);
        account.slugs = mergeRegistriesForClear(account.slugs, registry);
        account._meta = mergeAccountMeta(account._meta, meta);
        root.accounts[accountId] = account;
        root._meta.activeAccount = accountId;
        root._meta.updatedAt = clearedAt;
        await storageSet(chrome.storage.local, { [STORAGE_KEY]: root }, 'local.set during clear skipped');
        notifySubscribers('cleared-skipped');
        return true;
      } catch (error) {
        try {
          await reloadActiveFromStorage('clear-skipped-failed', false);
        } catch {
          registry = previousRegistry;
          meta = previousMeta;
          notifySubscribers('clear-skipped-failed');
        }
        throw error;
      }
    },

    // Restore one skipped film without touching any of its other state. The
    // normal serialized mergeAccount writer gives this the same cross-tab and
    // account-isolation guarantees as swipes, while the explicit promise lets
    // UI controls report success only after the write has landed.
    async restoreSkipped(slug, expectedAccount) {
      const expectedAccountId = expectedAccount === undefined
        ? accountId
        : normalizeAccountId(expectedAccount);
      if (!expectedAccountId || expectedAccountId !== accountId || !isSafeSlug(slug) || !registry[slug]?.skipped) return false;

      const entry = registry[slug];
      const restoreAccountId = accountId;
      const previous = {
        skipped: entry.skipped,
        skippedAt: entry.skippedAt,
        skippedChangedAt: entry.skippedChangedAt,
        skippedSource: entry.skippedSource,
        lastAction: entry.lastAction,
        source: entry.source,
        updatedAt: entry.updatedAt
      };
      const restoredAt = new Date().toISOString();
      entry.skipped = false;
      entry.skippedAt = null;
      entry.skippedChangedAt = restoredAt;
      entry.skippedSource = 'userAction';
      entry.lastAction = 'skipped';
      entry.source = 'userAction';
      entry.updatedAt = restoredAt;

      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }

      try {
        const persisted = await writeToStorage();
        if (persisted === false) return false;
        if (accountId === restoreAccountId && registry[slug]?.skipped) return false;
        if (accountId === restoreAccountId) notifySubscribers('restored-skipped');
        this._notifyBackground('stateChanged', {
          slug,
          flag: 'skipped',
          value: false,
          source: 'userAction',
          timestamp: restoredAt,
          accountId: restoreAccountId
        });
        return true;
      } catch (error) {
        // storage.onChanged can replace `registry` while this write is in
        // flight, which detaches the original `entry` reference. Roll back the
        // active record only when it still carries this exact optimistic write;
        // a newer external change or an account switch must win.
        const current = accountId === restoreAccountId ? registry[slug] : null;
        const stillThisRestore = current?.skipped === false &&
          timestamp(current.skippedChangedAt || current.skippedAt) === timestamp(restoredAt);
        if (stillThisRestore) Object.assign(current, previous);
        lastStorageError = error.message;
        notifySubscribers('restore-skipped-failed');
        throw error;
      }
    },

    // ── Internal: notify background ─────────────────────────────────

    _notifyBackground(action, data) {
      try {
        chrome.runtime.sendMessage({ type: 'vypode', action, data });
      } catch (e) {
        // Background may not be running — that's fine
      }
    },

    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      return writeToStorage();
    },

    handoffForLifecycle() {
      return handoffStateSnapshot();
    },

    async reload() {
      return reloadActiveFromStorage('state-reloaded');
    },

    getLastStorageError() {
      return lastStorageError;
    },

    getLastClearResult() {
      return { ...lastClearResult };
    }
  };

  try {
    chrome.storage?.onChanged?.addListener?.(handleStorageChanged);
  } catch (error) {
    console.warn('Vypode could not subscribe to storage changes:', error);
  }

  // Expose globally for content.js
  window.VypodeFilmState = VypodeFilmState;

})();
