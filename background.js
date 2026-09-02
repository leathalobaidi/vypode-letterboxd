// SWIPE FOR LETTERBOXD — serialized account-state writer

'use strict';

const STATE_KEY = 'vypode_state';
const OUTBOX_KEY = 'vypode_action_outbox_v1';
const OUTBOX_OUTCOMES_KEY = 'vypode_action_outcomes_v1';
const REVIEW_DRAFTS_KEY = 'vypode_review_drafts_v1';
const REVIEW_UNCERTAIN_KEY = 'vypode_review_uncertain_v1';
const REVIEW_SUBMISSIONS_KEY = 'vypode_review_submissions_v1';
const USER_KEY = 'vypode_user';
const DATA_VERSION = 3;
const LEGACY_ACCOUNT = '$legacy';
const FLAGS = ['watched', 'liked', 'watchlist', 'skipped'];
const METADATA_KEYS = ['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl'];
const MAX_REVIEW_DRAFTS = 100;
const MAX_REVIEW_SUBMISSIONS = 500;
const REVIEW_SUBMISSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_REVIEW_TEXT_LENGTH = 50000;
const MAX_REVIEW_TAGS = 20;
const MAX_REVIEW_TAG_LENGTH = 100;
const REVIEW_SUBMIT_ENDPOINT = 'https://api.letterboxd.com/api/v0/production-log-entries';
const REVIEW_SUBMIT_TIMEOUT_MS = 20000;
const MAX_REVIEW_REQUEST_BYTES = 64 * 1024;
const MAX_REVIEW_RESPONSE_BYTES = 512 * 1024;
const MAX_CSRF_LENGTH = 2048;
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OUTBOX_OUTCOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_OUTBOX_OUTCOMES = 2000;
const OUTBOX_MIN_LEASE_MS = 1000;
const OUTBOX_MAX_LEASE_MS = 2 * 60 * 1000;
let stateWriteQueue = Promise.resolve();
const pendingReviewSubmissions = new Map();
const reviewUncertainMemory = new Map();

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAccountId(value) {
  if (value === LEGACY_ACCOUNT) return LEGACY_ACCOUNT;
  if (typeof value !== 'string') return null;
  let username = value.trim();
  if (username.startsWith('user:')) username = username.slice(5);
  return /^[a-zA-Z0-9_]{1,64}$/.test(username) ? `user:${username.toLowerCase()}` : null;
}

function isSafeSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    /^[a-z0-9][a-z0-9-]*$/i.test(value) &&
    value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
}

function canonicalFilmUrl(value, slug) {
  if (typeof value !== 'string' || value.length > 2048 || !isSafeSlug(slug)) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://letterboxd.com' || url.username || url.password || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i);
    return match && match[1].toLowerCase() === slug.toLowerCase()
      ? `https://letterboxd.com/film/${slug}/`
      : null;
  } catch {
    return null;
  }
}

function trustedPosterUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && new Set([
      'https://a.ltrbxd.com',
      'https://s.ltrbxd.com',
      'https://letterboxd.com'
    ]).has(url.origin) ? url.href : null;
  } catch {
    return null;
  }
}

function canonicalReviewUrl(value, slug, accountId) {
  if (typeof value !== 'string' || value.length > 2048 || !isSafeSlug(slug)) return null;
  const owner = normalizeAccountId(accountId)?.replace(/^user:/, '');
  if (!owner || owner === LEGACY_ACCOUNT) return null;
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

function sanitizeEntryUrls(raw, slug, accountId, clearInvalid) {
  const entry = isRecord(raw) ? { ...raw } : {};
  for (const [key, sanitize] of [
    ['url', value => canonicalFilmUrl(value, slug)],
    ['poster', trustedPosterUrl],
    ['reviewUrl', value => canonicalReviewUrl(value, slug, accountId)]
  ]) {
    if (!Object.prototype.hasOwnProperty.call(entry, key) || entry[key] == null) continue;
    const safe = sanitize(entry[key]);
    if (safe) entry[key] = safe;
    else if (clearInvalid) entry[key] = null;
    else delete entry[key];
  }
  return entry;
}

function freshRoot(active = LEGACY_ACCOUNT, generation = 0) {
  return {
    _meta: { version: DATA_VERSION, generation, activeAccount: active, updatedAt: null, lastWriteAt: null, lastError: null },
    accounts: Object.create(null)
  };
}

function freshAccount() {
  return {
    _meta: { version: DATA_VERSION, lastSyncAt: null, syncDuration: null, syncCounts: null, updatedAt: null },
    slugs: Object.create(null)
  };
}

function normalizeRoot(raw, preferred) {
  const accountId = normalizeAccountId(preferred) || LEGACY_ACCOUNT;
  if (Number(raw?._meta?.version) > DATA_VERSION) {
    throw new Error(`Stored state version ${raw._meta.version} requires a newer extension`);
  }
  if (!isRecord(raw) || raw._meta?.version < DATA_VERSION || !isRecord(raw.accounts)) return freshRoot(accountId);
  const generation = Number.isSafeInteger(raw._meta.generation) && raw._meta.generation >= 0 ? raw._meta.generation : 0;
  const root = freshRoot(normalizeAccountId(raw._meta.activeAccount) || accountId, generation);
  root._meta = { ...root._meta, ...raw._meta, version: DATA_VERSION, generation };
  for (const id in raw.accounts) {
    if (normalizeAccountId(id) !== id || !isRecord(raw.accounts[id])) continue;
    const account = freshAccount();
    account._meta = { ...account._meta, ...(isRecord(raw.accounts[id]._meta) ? raw.accounts[id]._meta : {}), version: DATA_VERSION };
    const slugs = isRecord(raw.accounts[id].slugs) ? raw.accounts[id].slugs : {};
    for (const slug in slugs) {
      if (isSafeSlug(slug) && isRecord(slugs[slug])) {
        account.slugs[slug] = sanitizeEntryUrls(slugs[slug], slug, id, true);
      }
    }
    root.accounts[id] = account;
  }
  return root;
}

function abortPendingReviewSubmissions(predicate, reason) {
  for (const pending of pendingReviewSubmissions.values()) {
    if (!predicate(pending)) continue;
    pending.abortReason = reason;
    try { pending.controller.abort(); } catch {}
  }
}

function timestamp(value) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function sourcePriority(source) {
  if (source === 'userAction') return 3;
  if (source === 'import') return 2;
  return 1;
}

function mergeEntry(storedValue, incomingValue, slug, accountId) {
  const stored = sanitizeEntryUrls(storedValue, slug, accountId, true);
  const incoming = sanitizeEntryUrls(incomingValue, slug, accountId, false);
  const merged = { ...stored };
  const incomingMetadataAt = timestamp(incoming.metadataUpdatedAt || incoming.updatedAt);
  const storedMetadataAt = timestamp(stored.metadataUpdatedAt || stored.updatedAt);
  if (incomingMetadataAt > storedMetadataAt ||
      (incomingMetadataAt === storedMetadataAt && sourcePriority(incoming.metadataSource || incoming.source) >= sourcePriority(stored.metadataSource || stored.source))) {
    const cleared = new Set(Array.isArray(stored.metadataCleared)
      ? stored.metadataCleared.filter(key => METADATA_KEYS.includes(key))
      : []);
    if (Array.isArray(incoming.metadataCleared)) {
      for (const key of incoming.metadataCleared) if (METADATA_KEYS.includes(key)) cleared.add(key);
    }
    for (const key of METADATA_KEYS) {
      if (cleared.has(key)) merged[key] = null;
      if (incoming[key] !== undefined && incoming[key] !== null && incoming[key] !== '') {
        merged[key] = incoming[key];
        cleared.delete(key);
      }
    }
    merged.metadataCleared = Array.from(cleared);
    merged.metadataUpdatedAt = incoming.metadataUpdatedAt || incoming.updatedAt || merged.metadataUpdatedAt;
    merged.metadataSource = incoming.metadataSource || incoming.source || merged.metadataSource;
  }
  for (const flag of FLAGS) {
    // A metadata-only snapshot deliberately omits untouched false flags. Do
    // not turn that omission into a newer false value in another tab.
    const incomingAt = timestamp(incoming[`${flag}ChangedAt`] || incoming[`${flag}At`]);
    const incomingChangesFlag = Object.prototype.hasOwnProperty.call(incoming, flag) &&
      (incoming[flag] === true || incomingAt > 0);
    if (!incomingChangesFlag) continue;
    const storedAt = timestamp(stored[`${flag}ChangedAt`] || stored[`${flag}At`]);
    const incomingWins = incomingAt > storedAt ||
      (incomingAt === storedAt && sourcePriority(incoming[`${flag}Source`] || incoming.source) >= sourcePriority(stored[`${flag}Source`] || stored.source));
    if (incomingWins) {
      merged[flag] = incoming[flag] === true;
      merged[`${flag}At`] = incoming[`${flag}At`] || null;
      merged[`${flag}ChangedAt`] = incoming[`${flag}ChangedAt`] || incoming[`${flag}At`] || null;
      merged[`${flag}Source`] = incoming[`${flag}Source`] || incoming.source || null;
      merged[`${flag}MutationToken`] = incoming[`${flag}MutationToken`] || null;
      if (flag === 'watched') merged.watchedDate = incoming.watchedDate || null;
    }
  }
  if (timestamp(incoming.updatedAt) >= timestamp(stored.updatedAt)) {
    for (const key of ['lastAction', 'source', 'lastSyncedAt', 'updatedAt']) {
      if (incoming[key] !== undefined) merged[key] = incoming[key];
    }
  }
  return merged;
}

function mergeMeta(stored, incoming) {
  const left = isRecord(stored) ? stored : {};
  const right = isRecord(incoming) ? incoming : {};
  return timestamp(right.updatedAt || right.lastSyncAt) >= timestamp(left.updatedAt || left.lastSyncAt)
    ? { ...left, ...right, version: DATA_VERSION }
    : { ...right, ...left, version: DATA_VERSION };
}

function getLocal(keys) {
  return new Promise((resolve, reject) => chrome.storage.local.get(keys, result => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(result || {});
  }));
}

function setLocal(items) {
  return new Promise((resolve, reject) => chrome.storage.local.set(items, () => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve();
  }));
}

async function applyStateCommand(action, data) {
  const accountId = normalizeAccountId(data?.accountId);
  if (!accountId) throw new Error('Invalid Letterboxd account identifier');
  const result = await getLocal(action === 'clearAll'
    ? [STATE_KEY, OUTBOX_KEY, REVIEW_UNCERTAIN_KEY]
    : [STATE_KEY]);
  // A verified review claim must start from the authoritative reset owner.
  // Passing its target as normalizeRoot's fallback would make missing or
  // malformed state look as though the target had already won the claim.
  let root = normalizeRoot(
    result[STATE_KEY],
    action === 'claimVerifiedAccount' ? LEGACY_ACCOUNT : accountId
  );

  if (action === 'clearAll') {
    const requestedGeneration = Number(data?.generation);
    if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration <= root._meta.generation) {
      const activeAccount = normalizeAccountId(root._meta.activeAccount) || LEGACY_ACCOUNT;
      return {
        ok: false,
        stale: true,
        generation: root._meta.generation,
        activeAccount,
        account: root.accounts[activeAccount] || freshAccount()
      };
    }
    const nextGeneration = Math.max(root._meta.generation + 1, requestedGeneration);
    const carriedActions = carryDispatchedOutbox(result[OUTBOX_KEY], nextGeneration);
    // A review POST cannot be recalled once dispatched. Carry only its small,
    // redacted account/film/request marker across the generation fence so a
    // local reset cannot make a duplicate diary entry possible. Review text,
    // CSRF tokens, and the submitted payload are never stored here.
    const carriedReviews = normalizeReviewUncertainStore(result[REVIEW_UNCERTAIN_KEY]);
    for (const marker of reviewUncertainMemory.values()) {
      if (!marker?.accountId || !marker?.slug) continue;
      if (!carriedReviews[marker.accountId]) carriedReviews[marker.accountId] = Object.create(null);
      if (!carriedReviews[marker.accountId][marker.slug]) carriedReviews[marker.accountId][marker.slug] = marker;
    }
    for (const pending of pendingReviewSubmissions.values()) {
      if ((!pending.prepared && !pending.dispatched) || !pending.accountId || !pending.slug) continue;
      if (!carriedReviews[pending.accountId]) carriedReviews[pending.accountId] = Object.create(null);
      carriedReviews[pending.accountId][pending.slug] = {
        accountId: pending.accountId,
        slug: pending.slug,
        generation: pending.generation,
        requestId: pending.requestId,
        createdAt: new Date().toISOString(),
        reason: 'A review was being submitted when local film data was cleared',
        status: pending.dispatched ? 'uncertain' : 'dispatched',
        fingerprint: pending.fingerprint
      };
    }
    const carriedReviewStore = Object.create(null);
    let dispatchedReviews = 0;
    for (const carriedAccountId of Object.keys(carriedReviews)) {
      for (const slug of Object.keys(carriedReviews[carriedAccountId] || {})) {
        const marker = carriedReviews[carriedAccountId][slug];
        if (!carriedReviewStore[carriedAccountId]) carriedReviewStore[carriedAccountId] = Object.create(null);
        carriedReviewStore[carriedAccountId][slug] = {
          accountId: carriedAccountId,
          slug,
          generation: nextGeneration,
          requestId: marker.requestId,
          createdAt: marker.createdAt,
          reason: 'A review may have reached Letterboxd before local film data was cleared',
          status: 'uncertain',
          fingerprint: marker.fingerprint || null
        };
        dispatchedReviews += 1;
      }
    }
    abortPendingReviewSubmissions(
      pending => pending.generation !== nextGeneration,
      'State was cleared while the review was being submitted'
    );
    reviewUncertainMemory.clear();
    root = freshRoot(LEGACY_ACCOUNT, nextGeneration);
    root._meta.updatedAt = new Date().toISOString();
    root._meta.lastWriteAt = root._meta.updatedAt;
    // State and recovery actions must be cleared together. One local.set call
    // prevents a successfully cleared library from later replaying an action
    // that was queued before the clear.
    await setLocal({
      [STATE_KEY]: root,
      [OUTBOX_KEY]: carriedActions.outbox,
      [OUTBOX_OUTCOMES_KEY]: Object.create(null),
      [REVIEW_DRAFTS_KEY]: Object.create(null),
      [REVIEW_UNCERTAIN_KEY]: carriedReviewStore,
      [REVIEW_SUBMISSIONS_KEY]: Object.create(null),
      [USER_KEY]: null
    });
    for (const carriedAccountId of Object.keys(carriedReviewStore)) {
      for (const slug of Object.keys(carriedReviewStore[carriedAccountId])) {
        const marker = carriedReviewStore[carriedAccountId][slug];
        reviewUncertainMemory.set(reviewUncertainLockKey(carriedAccountId, slug), marker);
      }
    }
    return {
      ok: true,
      generation: nextGeneration,
      account: freshAccount(),
      dispatchedActions: carriedActions.count,
      dispatchedReviews
    };
  }

  if (action === 'claimVerifiedAccount' &&
      (accountId === LEGACY_ACCOUNT || !Number.isSafeInteger(data?.generation) || data.generation < 0)) {
    throw new Error('Invalid verified account claim');
  }

  if (Number(data?.generation) !== root._meta.generation) {
    const activeAccount = normalizeAccountId(root._meta.activeAccount) || LEGACY_ACCOUNT;
    return {
      ok: false,
      stale: true,
      ...(action === 'claimVerifiedAccount' ? { code: 'generation-changed' } : {}),
      generation: root._meta.generation,
      activeAccount,
      account: root.accounts[activeAccount] || freshAccount()
    };
  }

  const activeAccount = normalizeAccountId(root._meta.activeAccount) || LEGACY_ACCOUNT;
  if (action === 'claimVerifiedAccount') {
    // Review recovery is a compare-and-set owned by the serialized worker.
    // A caller may claim reset state, or observe that the same verified
    // account already claimed it, but can never replace another real account.
    if (activeAccount !== LEGACY_ACCOUNT && activeAccount !== accountId) {
      return {
        ok: false,
        stale: true,
        conflict: true,
        code: 'active-account-changed',
        generation: root._meta.generation,
        activeAccount,
        account: root.accounts[activeAccount] || freshAccount()
      };
    }
    const account = root.accounts[accountId] || freshAccount();
    root.accounts[accountId] = account;
    root._meta.activeAccount = accountId;
    if (activeAccount !== accountId) {
      abortPendingReviewSubmissions(
        pending => pending.accountId !== accountId,
        'The active Letterboxd account changed while the review was being submitted'
      );
    }
    root._meta.updatedAt = new Date().toISOString();
    root._meta.lastWriteAt = root._meta.updatedAt;
    root._meta.lastError = null;
    await setLocal({ [STATE_KEY]: root });
    return {
      ok: true,
      claimed: activeAccount === LEGACY_ACCOUNT,
      generation: root._meta.generation,
      activeAccount: accountId,
      account
    };
  }

  if (action !== 'activateAccount' && activeAccount !== accountId) {
    // Only an explicit account activation may change ownership. A delayed
    // merge or clear-skipped command from another tab must not reclaim state
    // after Clear All or an account switch.
    return {
      ok: false,
      stale: true,
      generation: root._meta.generation,
      activeAccount,
      account: root.accounts[activeAccount] || freshAccount()
    };
  }

  const account = root.accounts[accountId] || freshAccount();
  if (action === 'activateAccount') {
    // Deliberately preserve every other account. This is serialized with
    // mergeAccount so a login/account switch can never overwrite a tab's
    // just-written snapshot.
  } else if (action === 'clearSkipped') {
    const at = data?.at || new Date().toISOString();
    for (const slug in account.slugs) {
      const entry = account.slugs[slug];
      if (!entry.skipped) continue;
      if (timestamp(at) < timestamp(entry.skippedChangedAt || entry.skippedAt)) continue;
      entry.skipped = false;
      entry.skippedAt = null;
      entry.skippedChangedAt = at;
      entry.skippedSource = 'userAction';
      entry.updatedAt = at;
    }
  } else if (action === 'mergeAccount') {
    for (const slug in data?.slugs || {}) {
      if (!isSafeSlug(slug) || !isRecord(data.slugs[slug])) continue;
      account.slugs[slug] = mergeEntry(account.slugs[slug], data.slugs[slug], slug, accountId);
    }
    account._meta = mergeMeta(account._meta, data.meta);
  } else {
    throw new Error(`Unsupported state action: ${action}`);
  }

  root.accounts[accountId] = account;
  root._meta.activeAccount = accountId;
  if (action === 'activateAccount') {
    abortPendingReviewSubmissions(
      pending => pending.accountId !== accountId,
      'The active Letterboxd account changed while the review was being submitted'
    );
  }
  root._meta.updatedAt = new Date().toISOString();
  root._meta.lastWriteAt = root._meta.updatedAt;
  root._meta.lastError = null;
  await setLocal({ [STATE_KEY]: root });
  return { ok: true, generation: root._meta.generation, account };
}

function normalizeOutboxRecord(id, raw) {
  if (typeof id !== 'string' || !id || id.length > 500 || !isRecord(raw) || raw.id !== id) {
    throw new Error('Invalid outbox record');
  }
  let filmUrl;
  try { filmUrl = new URL(raw.filmUrl); } catch { throw new Error('Invalid outbox film URL'); }
  if (filmUrl.origin !== 'https://letterboxd.com' || !/^\/film\/[a-z0-9][a-z0-9-]*\/?$/i.test(filmUrl.pathname)) {
    throw new Error('Invalid outbox film URL');
  }
  if (!['watch', 'like', 'watchlist'].includes(raw.action) || !isSafeSlug(raw.slug)) {
    throw new Error('Invalid outbox action');
  }
  const urlSlug = filmUrl.pathname.match(/^\/film\/([^/]+)\/?$/i)?.[1];
  if (urlSlug !== raw.slug) throw new Error('Outbox slug does not match film URL');
  const account = normalizeAccountId(raw.account);
  if (!account || account === LEGACY_ACCOUNT) throw new Error('Invalid outbox account');
  const createdAt = new Date(raw.createdAt).getTime();
  const mutationAt = new Date(raw.mutationAt).getTime();
  const generation = Number(raw.generation);
  if (!Number.isFinite(createdAt) || !Number.isFinite(mutationAt) ||
      !Number.isSafeInteger(generation) || generation < 0 ||
      typeof raw.mutationToken !== 'string' || !raw.mutationToken || raw.mutationToken.length > 200) {
    throw new Error('Invalid outbox mutation identity');
  }
  const leaseOwner = raw.leaseOwner == null ? null : raw.leaseOwner;
  const leaseExpiresAt = raw.leaseExpiresAt == null ? null : new Date(raw.leaseExpiresAt).getTime();
  if (leaseOwner !== null && (typeof leaseOwner !== 'string' || !leaseOwner || leaseOwner.length > 200)) {
    throw new Error('Invalid outbox lease owner');
  }
  if (leaseExpiresAt !== null && !Number.isFinite(leaseExpiresAt)) throw new Error('Invalid outbox lease expiry');
  const optimisticMutations = [];
  const addMutation = candidate => {
    const mutationAt = new Date(candidate?.mutationAt).getTime();
    if (!Number.isFinite(mutationAt) || typeof candidate?.mutationToken !== 'string' ||
        !candidate.mutationToken || candidate.mutationToken.length > 200) return;
    if (optimisticMutations.some(existing => existing.mutationToken === candidate.mutationToken)) return;
    optimisticMutations.push({
      mutationAt: new Date(mutationAt).toISOString(),
      mutationToken: candidate.mutationToken,
      previousValue: candidate.previousValue === true
    });
  };
  addMutation(raw);
  if (Array.isArray(raw.optimisticMutations)) raw.optimisticMutations.slice(0, 100).forEach(addMutation);
  return {
    id,
    filmUrl: filmUrl.href,
    action: raw.action,
    slug: raw.slug,
    previousValue: raw.previousValue === true,
    account: account.slice(5),
    createdAt: new Date(createdAt).toISOString(),
    mutationAt: new Date(mutationAt).toISOString(),
    mutationToken: raw.mutationToken,
    optimisticMutations: optimisticMutations.slice(-100),
    generation,
    leaseOwner,
    leaseExpiresAt: leaseExpiresAt === null ? null : new Date(leaseExpiresAt).toISOString(),
    dispatchedAt: raw.dispatchedAt != null && Number.isFinite(new Date(raw.dispatchedAt).getTime())
      ? new Date(raw.dispatchedAt).toISOString()
      : null
  };
}

function validOwnerToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function outboxDedupeKey(record) {
  return `${record.account.toLowerCase()}\u0000${record.slug}\u0000${record.action}`;
}

function rollbackExpiredOutboxRecord(root, record) {
  const accountId = normalizeAccountId(record.account);
  const flag = { watch: 'watched', like: 'liked', watchlist: 'watchlist' }[record.action];
  const entry = accountId && flag ? root.accounts[accountId]?.slugs?.[record.slug] : null;
  if (!entry || entry[flag] !== true) return false;
  const mutations = Array.isArray(record.optimisticMutations) && record.optimisticMutations.length
    ? record.optimisticMutations
    : [record];
  let matched = mutations.find(candidate =>
    timestamp(entry[`${flag}ChangedAt`] || entry[`${flag}At`]) === timestamp(candidate.mutationAt) &&
    entry[`${flag}MutationToken`] === candidate.mutationToken
  );
  // A second tab can persist its optimistic FilmState snapshot and disappear
  // before its deduped outbox upsert is observed. Deck mutation tokens are the
  // only non-null userAction tokens that can supersede the same pending group;
  // direct film-page actions use the reserved `single:` prefix and confirmed
  // reviews carry no mutation token, so preserve those unrelated changes.
  const currentChangedAt = timestamp(entry[`${flag}ChangedAt`] || entry[`${flag}At`]);
  const currentToken = entry[`${flag}MutationToken`];
  if (!matched && entry[flag] === true && entry[`${flag}Source`] === 'userAction' &&
      typeof currentToken === 'string' && currentToken && !currentToken.startsWith('single:') &&
      currentChangedAt >= timestamp(record.createdAt) &&
      currentChangedAt <= timestamp(record.createdAt) + 10 * 60 * 1000) {
    matched = { mutationAt: entry[`${flag}ChangedAt`] || entry[`${flag}At`], mutationToken: currentToken, previousValue: record.previousValue };
  }
  if (!matched) return false;
  const reconciledAt = new Date().toISOString();
  entry[flag] = matched.previousValue === true;
  entry[`${flag}At`] = matched.previousValue === true ? reconciledAt : null;
  entry[`${flag}ChangedAt`] = reconciledAt;
  entry[`${flag}Source`] = 'userAction';
  entry[`${flag}MutationToken`] = `terminal:${matched.mutationToken}`.slice(0, 200);
  if (flag === 'watched' && !matched.previousValue) entry.watchedDate = null;
  entry.lastAction = flag;
  entry.source = 'userAction';
  entry.updatedAt = reconciledAt;
  return true;
}

function sanitizeAndPruneOutbox(raw, root, now = Date.now()) {
  const outbox = Object.create(null);
  const terminalOutcomes = Object.create(null);
  let changed = !isRecord(raw);
  let stateChanged = false;
  if (!isRecord(raw)) return { outbox, changed, stateChanged, terminalOutcomes };
  for (const id of Object.keys(raw)) {
    let record;
    try {
      record = normalizeOutboxRecord(id, raw[id]);
    } catch {
      changed = true;
      continue;
    }
    const createdAt = timestamp(record.createdAt);
    if (createdAt > now + 5 * 60 * 1000 || now - createdAt >= OUTBOX_MAX_AGE_MS) {
      if (record.dispatchedAt) {
        // A click may already have reached Letterboxd. Age alone cannot prove
        // failure, so never roll the optimistic value back as a fact.
        terminalOutcomes[id] = { status: 'uncertain', at: new Date(now).toISOString() };
      } else {
        stateChanged = rollbackExpiredOutboxRecord(root, record) || stateChanged;
        terminalOutcomes[id] = { status: 'failed', at: new Date(now).toISOString() };
      }
      changed = true;
      continue;
    }
    outbox[id] = record;
  }
  return { outbox, changed, stateChanged, terminalOutcomes };
}

function sanitizeOutboxOutcomes(raw, now = Date.now()) {
  const outcomes = Object.create(null);
  let changed = !isRecord(raw);
  if (!isRecord(raw)) return { outcomes, changed };
  const records = [];
  for (const id of Object.keys(raw)) {
    const value = raw[id];
    const at = new Date(value?.at).getTime();
    if (typeof id !== 'string' || !id || id.length > 500 ||
        !['success', 'failed', 'cancelled', 'uncertain'].includes(value?.status) ||
        !Number.isFinite(at) || at > now + 5 * 60 * 1000 || now - at >= OUTBOX_OUTCOME_MAX_AGE_MS) {
      changed = true;
      continue;
    }
    records.push([id, { status: value.status, at: new Date(at).toISOString() }]);
  }
  records.sort((left, right) => right[1].at.localeCompare(left[1].at));
  if (records.length > MAX_OUTBOX_OUTCOMES) changed = true;
  for (const [id, value] of records.slice(0, MAX_OUTBOX_OUTCOMES)) outcomes[id] = value;
  return { outcomes, changed };
}

function carryDispatchedOutbox(raw, generation) {
  const latestByAction = new Map();
  if (isRecord(raw)) {
    for (const id of Object.keys(raw)) {
      let record;
      try { record = normalizeOutboxRecord(id, raw[id]); }
      catch { continue; }
      if (!record.dispatchedAt) continue;
      const key = outboxDedupeKey(record);
      const prior = latestByAction.get(key);
      if (!prior || timestamp(record.dispatchedAt) > timestamp(prior.dispatchedAt)) {
        latestByAction.set(key, record);
      }
    }
  }
  const now = new Date().toISOString();
  const records = Array.from(latestByAction.values())
    .sort((left, right) => timestamp(right.dispatchedAt) - timestamp(left.dispatchedAt))
    .slice(0, MAX_OUTBOX_OUTCOMES);
  const outbox = Object.create(null);
  for (const record of records) {
    outbox[record.id] = {
      ...record,
      generation,
      createdAt: now,
      leaseOwner: null,
      leaseExpiresAt: null
    };
  }
  return { outbox, count: records.length };
}

async function applyOutboxCommand(action, data) {
  const result = await getLocal([OUTBOX_KEY, OUTBOX_OUTCOMES_KEY, STATE_KEY]);
  const root = normalizeRoot(result[STATE_KEY], data?.account);
  const pruned = sanitizeAndPruneOutbox(result[OUTBOX_KEY], root);
  const outbox = pruned.outbox;
  const sanitizedOutcomes = sanitizeOutboxOutcomes(result[OUTBOX_OUTCOMES_KEY]);
  const outcomes = sanitizedOutcomes.outcomes;
  let outboxChanged = pruned.changed;
  let outcomesChanged = sanitizedOutcomes.changed;
  for (const id of Object.keys(pruned.terminalOutcomes || {})) {
    outcomes[id] = pruned.terminalOutcomes[id];
    outcomesChanged = true;
  }
  let stateChanged = pruned.stateChanged;
  const suppliedGeneration = Number(data?.generation);
  const generationMatches = Number.isSafeInteger(suppliedGeneration) && suppliedGeneration === root._meta.generation;
  const persistOutboxChanges = async () => {
    if (!outboxChanged && !outcomesChanged && !stateChanged) return;
    await setLocal({
      [OUTBOX_KEY]: outbox,
      [OUTBOX_OUTCOMES_KEY]: outcomes,
      ...(stateChanged ? { [STATE_KEY]: root } : {})
    });
  };

  if (action === 'outboxUpsert') {
    const record = normalizeOutboxRecord(data?.id, data?.record);
    if (!generationMatches || record.generation !== root._meta.generation) {
      await persistOutboxChanges();
      return { ok: false, stale: true, generation: root._meta.generation };
    }
    const key = outboxDedupeKey(record);
    const duplicate = Object.values(outbox).find(candidate => outboxDedupeKey(candidate) === key);
    if (duplicate) {
      const participant = record.optimisticMutations[0];
      if (participant && !duplicate.optimisticMutations.some(existing => existing.mutationToken === participant.mutationToken)) {
        duplicate.optimisticMutations.push(participant);
        duplicate.optimisticMutations = duplicate.optimisticMutations.slice(-100);
        outboxChanged = true;
      }
      await persistOutboxChanges();
      return { ok: true, count: Object.keys(outbox).length, deduped: duplicate.id !== record.id, id: duplicate.id, record: duplicate };
    }
    outbox[record.id] = record;
    if (outcomes[record.id]) {
      delete outcomes[record.id];
      outcomesChanged = true;
    }
    outboxChanged = true;
  } else if (action === 'outboxRemove') {
    const ids = Array.isArray(data?.ids) ? data.ids : [data?.id];
    if (ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id || id.length > 500)) {
      throw new Error('Invalid outbox removal');
    }
    const outcome = data?.outcome;
    if (outcome !== undefined && !['failed', 'cancelled'].includes(outcome)) {
      throw new Error('Invalid outbox terminal outcome');
    }
    for (const id of ids) {
      const removedRecord = outbox[id];
      if (removedRecord && (outcome === 'failed' || outcome === 'cancelled')) {
        stateChanged = rollbackExpiredOutboxRecord(root, removedRecord) || stateChanged;
      }
      if (Object.prototype.hasOwnProperty.call(outbox, id)) outboxChanged = true;
      delete outbox[id];
      if (outcome) {
        outcomes[id] = { status: outcome, at: new Date().toISOString() };
        outcomesChanged = true;
      }
    }
  } else if (action === 'outboxClaim') {
    if (!generationMatches) {
      await persistOutboxChanges();
      return { ok: false, stale: true, generation: root._meta.generation };
    }
    if (typeof data?.id !== 'string' || !validOwnerToken(data?.owner)) throw new Error('Invalid outbox claim');
    const leaseMs = Number(data?.leaseMs);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < OUTBOX_MIN_LEASE_MS || leaseMs > OUTBOX_MAX_LEASE_MS) {
      throw new Error('Invalid outbox lease');
    }
    const record = outbox[data.id];
    if (!record) {
      await persistOutboxChanges();
      return { ok: true, claimed: false, missing: true, outcome: outcomes[data.id]?.status || null };
    }
    if (normalizeAccountId(data?.account) !== normalizeAccountId(record.account)) {
      await persistOutboxChanges();
      return { ok: false, claimed: false, accountMismatch: true };
    }
    const leaseActive = record.leaseOwner && timestamp(record.leaseExpiresAt) > Date.now();
    if (leaseActive && record.leaseOwner !== data.owner) {
      await persistOutboxChanges();
      return { ok: true, claimed: false, busy: true, leaseExpiresAt: record.leaseExpiresAt, owner: record.leaseOwner };
    }
    record.leaseOwner = data.owner;
    record.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    outboxChanged = true;
    await persistOutboxChanges();
    return { ok: true, claimed: true, id: record.id, record };
  } else if (action === 'outboxMarkDispatched') {
    if (typeof data?.id !== 'string' || !validOwnerToken(data?.owner)) throw new Error('Invalid outbox dispatch marker');
    const record = outbox[data.id];
    if (!record || record.leaseOwner !== data.owner || timestamp(record.leaseExpiresAt) <= Date.now()) {
      await persistOutboxChanges();
      return { ok: true, marked: false, missing: !record };
    }
    record.dispatchedAt = new Date().toISOString();
    outboxChanged = true;
    await persistOutboxChanges();
    return { ok: true, marked: true, id: record.id, record };
  } else if (action === 'outboxComplete') {
    if (typeof data?.id !== 'string' || !validOwnerToken(data?.owner)) throw new Error('Invalid outbox completion');
    const record = outbox[data.id];
    if (!record) {
      await persistOutboxChanges();
      return { ok: true, completed: false, missing: true };
    }
    if (record.leaseOwner !== data.owner) {
      await persistOutboxChanges();
      return { ok: true, completed: false, ownerMismatch: true };
    }
    if (timestamp(record.leaseExpiresAt) <= Date.now()) {
      await persistOutboxChanges();
      return { ok: true, completed: false, leaseExpired: true };
    }
    delete outbox[data.id];
    outcomes[data.id] = { status: 'success', at: new Date().toISOString() };
    outcomesChanged = true;
    outboxChanged = true;
    await persistOutboxChanges();
    return { ok: true, completed: true, count: Object.keys(outbox).length };
  } else if (action === 'outboxRelease') {
    if (typeof data?.id !== 'string' || !validOwnerToken(data?.owner)) throw new Error('Invalid outbox release');
    const record = outbox[data.id];
    if (!record) {
      await persistOutboxChanges();
      return { ok: true, released: false, missing: true };
    }
    if (record.leaseOwner !== data.owner) {
      await persistOutboxChanges();
      return { ok: true, released: false, ownerMismatch: true };
    }
    record.leaseOwner = null;
    record.leaseExpiresAt = null;
    outboxChanged = true;
    await persistOutboxChanges();
    return { ok: true, released: true, id: record.id, record };
  } else if (action === 'outboxList') {
    const records = Object.values(outbox);
    await persistOutboxChanges();
    return { ok: true, records, generation: root._meta.generation };
  } else {
    throw new Error(`Unsupported outbox action: ${action}`);
  }
  await persistOutboxChanges();
  return { ok: true, count: Object.keys(outbox).length, id: data?.id, record: outbox[data?.id] || null };
}

function isValidDiaryDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeReviewTags(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_REVIEW_TAGS) throw new Error('Invalid review draft tags');
  const tags = [];
  const seen = new Set();
  for (const value of raw) {
    if (typeof value !== 'string') throw new Error('Invalid review draft tag');
    const tag = value.trim();
    if (!tag || tag.length > MAX_REVIEW_TAG_LENGTH) throw new Error('Invalid review draft tag');
    const key = tag.toLocaleLowerCase('en');
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function normalizeReviewDraft(accountId, slug, raw) {
  if (!accountId || accountId === LEGACY_ACCOUNT || !isSafeSlug(slug) || !isRecord(raw)) {
    throw new Error('Invalid review draft');
  }
  if (typeof raw.reviewText !== 'string' || raw.reviewText.length > MAX_REVIEW_TEXT_LENGTH) {
    throw new Error('Invalid review draft text');
  }
  if (typeof raw.rating !== 'number') throw new Error('Invalid review draft rating');
  const rating = raw.rating;
  if (!Number.isFinite(rating) || rating < 0 || rating > 5 || !Number.isInteger(rating * 2)) {
    throw new Error('Invalid review draft rating');
  }
  if (!isValidDiaryDate(raw.diaryDate)) throw new Error('Invalid review draft date');
  if (typeof raw.rewatch !== 'boolean' || typeof raw.spoilers !== 'boolean') {
    throw new Error('Invalid review draft options');
  }
  if (!['preserve', 'like', 'unlike'].includes(raw.likeMode)) {
    throw new Error('Invalid review draft like option');
  }
  const updatedAt = new Date(raw.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) throw new Error('Invalid review draft timestamp');
  const revision = raw.revision === undefined ? 0 : raw.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid review draft revision');
  return {
    accountId,
    slug,
    reviewText: raw.reviewText,
    rating,
    diaryDate: raw.diaryDate,
    rewatch: raw.rewatch,
    spoilers: raw.spoilers,
    likeMode: raw.likeMode,
    tags: normalizeReviewTags(raw.tags),
    revision,
    updatedAt: new Date(updatedAt).toISOString()
  };
}

function reviewDraftIsAtLeastAsNew(incoming, stored) {
  if (!stored) return true;
  const incomingTime = new Date(incoming.updatedAt).getTime();
  const storedTime = new Date(stored.updatedAt).getTime();
  if (incomingTime !== storedTime) return incomingTime > storedTime;
  return incoming.revision >= (Number.isSafeInteger(stored.revision) ? stored.revision : 0);
}

function normalizeReviewDraftStore(raw) {
  const normalized = Object.create(null);
  if (!isRecord(raw)) return normalized;
  const records = [];
  for (const rawAccountId of Object.keys(raw)) {
    const accountId = normalizeAccountId(rawAccountId);
    if (!accountId || accountId !== rawAccountId || accountId === LEGACY_ACCOUNT || !isRecord(raw[rawAccountId])) continue;
    for (const slug of Object.keys(raw[rawAccountId])) {
      if (!isSafeSlug(slug)) continue;
      try {
        records.push(normalizeReviewDraft(accountId, slug, raw[rawAccountId][slug]));
      } catch {
        // A corrupt draft must not make the rest of the account's drafts unreadable.
      }
    }
  }
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const record of records.slice(0, MAX_REVIEW_DRAFTS)) {
    if (!normalized[record.accountId]) normalized[record.accountId] = Object.create(null);
    normalized[record.accountId][record.slug] = record;
  }
  return normalized;
}

function countReviewDrafts(store) {
  let count = 0;
  for (const accountId of Object.keys(store)) count += Object.keys(store[accountId] || {}).length;
  return count;
}

function normalizeReviewUncertainStore(raw) {
  const normalized = Object.create(null);
  if (!isRecord(raw)) return normalized;
  const records = [];
  for (const rawAccountId of Object.keys(raw)) {
    const accountId = normalizeAccountId(rawAccountId);
    if (!accountId || accountId === LEGACY_ACCOUNT || accountId !== rawAccountId || !isRecord(raw[rawAccountId])) continue;
    for (const slug of Object.keys(raw[rawAccountId])) {
      const marker = raw[rawAccountId][slug];
      const createdAt = new Date(marker?.createdAt).getTime();
      if (!isSafeSlug(slug) || !isRecord(marker) || !Number.isSafeInteger(marker.generation) || marker.generation < 0 ||
          typeof marker.requestId !== 'string' || !marker.requestId || marker.requestId.length > 200 ||
          !Number.isFinite(createdAt) || typeof marker.reason !== 'string' || marker.reason.length > 500) continue;
      records.push({
        accountId,
        slug,
        generation: marker.generation,
        requestId: marker.requestId,
        createdAt: new Date(createdAt).toISOString(),
        reason: marker.reason,
        status: marker.status === 'dispatched' ? 'dispatched' : 'uncertain',
        fingerprint: typeof marker.fingerprint === 'string' && marker.fingerprint.length <= 100
          ? marker.fingerprint
          : null
      });
    }
  }
  records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const marker of records.slice(0, MAX_REVIEW_DRAFTS)) {
    if (!normalized[marker.accountId]) normalized[marker.accountId] = Object.create(null);
    normalized[marker.accountId][marker.slug] = marker;
  }
  return normalized;
}

function normalizeReviewSubmissionStore(raw) {
  const normalized = Object.create(null);
  if (!isRecord(raw)) return normalized;
  const cutoff = Date.now() - REVIEW_SUBMISSION_MAX_AGE_MS;
  const records = [];
  for (const requestId of Object.keys(raw)) {
    const record = raw[requestId];
    const accountId = normalizeAccountId(record?.accountId);
    const completedAt = new Date(record?.completedAt).getTime();
    if (!isRecord(record) || record.requestId !== requestId || !requestId || requestId.length > 200 ||
        ['__proto__', 'constructor', 'prototype'].includes(requestId) ||
        !accountId || accountId === LEGACY_ACCOUNT || !isSafeSlug(record.slug) ||
        !Number.isSafeInteger(record.generation) || record.generation < 0 ||
        typeof record.fingerprint !== 'string' || record.fingerprint.length > 100 ||
        !['confirmed', 'rejected'].includes(record.status) || !Number.isFinite(completedAt) || completedAt < cutoff) continue;
    records.push({
      requestId,
      accountId,
      slug: record.slug,
      generation: record.generation,
      fingerprint: record.fingerprint,
      status: record.status,
      completedAt: new Date(completedAt).toISOString(),
      httpStatus: Number.isInteger(record.httpStatus) ? record.httpStatus : 0,
      logEntryId: typeof record.logEntryId === 'string' ? record.logEntryId.slice(0, 200) : null,
      reason: typeof record.reason === 'string' ? record.reason.slice(0, 500) : null,
      stateCommitted: record.stateCommitted === true,
      draftCleared: record.draftCleared === true,
      newerDraft: record.newerDraft === true
    });
  }
  records.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  for (const record of records.slice(0, MAX_REVIEW_SUBMISSIONS)) normalized[record.requestId] = record;
  return normalized;
}

function replayCompletedReview(record) {
  const verification = record.status === 'confirmed'
    ? { status: 'confirmed', logEntryId: record.logEntryId }
    : { status: 'rejected', reason: record.reason || 'Letterboxd rejected entry' };
  return {
    ok: true,
    status: record.httpStatus,
    confirmed: record.status === 'confirmed',
    verification,
    uncertain: false,
    replayed: true,
    stateCommitted: record.stateCommitted,
    draftCleared: record.draftCleared,
    newerDraft: record.newerDraft
  };
}

function reviewUncertainLockKey(accountId, slug) {
  return `${accountId}\u0000${slug}`;
}

async function markReviewUncertain(submission, reason) {
  const lockKey = reviewUncertainLockKey(submission.accountId, submission.slug);
  const marker = {
    accountId: submission.accountId,
    slug: submission.slug,
    generation: submission.generation,
    requestId: submission.requestId,
    createdAt: new Date().toISOString(),
    reason: String(reason || 'Letterboxd did not confirm the submitted entry').slice(0, 500),
    status: 'uncertain',
    fingerprint: submission.fingerprint
  };
  try {
    return await (stateWriteQueue = stateWriteQueue.catch(() => {}).then(async () => {
      const result = await getLocal([STATE_KEY, REVIEW_UNCERTAIN_KEY]);
      const root = normalizeRoot(result[STATE_KEY], submission.accountId);
      if (root._meta.generation !== submission.generation) {
        const memoryMarker = reviewUncertainMemory.get(lockKey);
        if (memoryMarker?.requestId === submission.requestId && memoryMarker.generation === submission.generation) {
          reviewUncertainMemory.delete(lockKey);
        }
        return false;
      }
      const store = normalizeReviewUncertainStore(result[REVIEW_UNCERTAIN_KEY]);
      const current = store[submission.accountId]?.[submission.slug];
      if (current && current.requestId !== submission.requestId) return false;
      if (current?.createdAt) marker.createdAt = current.createdAt;
      if (!store[submission.accountId]) store[submission.accountId] = Object.create(null);
      store[submission.accountId][submission.slug] = marker;
      await setLocal({ [REVIEW_UNCERTAIN_KEY]: normalizeReviewUncertainStore(store) });
      reviewUncertainMemory.set(lockKey, marker);
      return true;
    }));
  } catch {
    return false;
  }
}

function normalizeReviewContextCommand(data, sender, requireMarker = false) {
  const keys = requireMarker
    ? ['accountId', 'generation', 'slug', 'markerRequestId']
    : ['accountId', 'generation', 'slug'];
  if (!supportedReviewSender(sender) || !hasExactKeys(data, keys)) {
    throw new Error('Invalid review resolution context');
  }
  const accountId = normalizeAccountId(data.accountId);
  const generation = Number(data.generation);
  const slug = data.slug;
  if (!accountId || accountId === LEGACY_ACCOUNT || !Number.isSafeInteger(generation) || generation < 0 || !isSafeSlug(slug)) {
    throw new Error('Invalid review resolution identity');
  }
  if (requireMarker && (typeof data.markerRequestId !== 'string' || !data.markerRequestId ||
      data.markerRequestId.length > 200 || /[\r\n\0]/.test(data.markerRequestId))) {
    throw new Error('Invalid review resolution marker');
  }
  return { accountId, generation, slug, ...(requireMarker ? { markerRequestId: data.markerRequestId } : {}) };
}

async function resolveReviewUncertainCommand(data, sender) {
  const context = normalizeReviewContextCommand(data, sender, true);
  const result = await getLocal([STATE_KEY, REVIEW_UNCERTAIN_KEY]);
  const root = normalizeRoot(result[STATE_KEY], context.accountId);
  if (root._meta.generation !== context.generation || root._meta.activeAccount !== context.accountId) {
    return { ok: false, stale: true, code: 'context-changed', generation: root._meta.generation };
  }
  const store = normalizeReviewUncertainStore(result[REVIEW_UNCERTAIN_KEY]);
  const lockKey = reviewUncertainLockKey(context.accountId, context.slug);
  let memoryMarker = reviewUncertainMemory.get(lockKey) || null;
  if (memoryMarker && memoryMarker.generation !== context.generation) {
    reviewUncertainMemory.delete(lockKey);
    memoryMarker = null;
  }
  const current = store[context.accountId]?.[context.slug] || memoryMarker;
  if (current && current.requestId !== context.markerRequestId) {
    return {
      ok: false,
      code: 'marker-changed',
      blocked: true,
      markerToken: current.requestId,
      error: 'A newer uncertain submission exists. Check Letterboxd again before clearing it.'
    };
  }
  if (store[context.accountId]) {
    delete store[context.accountId][context.slug];
    if (Object.keys(store[context.accountId]).length === 0) delete store[context.accountId];
  }
  reviewUncertainMemory.delete(lockKey);
  await setLocal({ [REVIEW_UNCERTAIN_KEY]: store });
  return { ok: true, resolved: Boolean(current) };
}

async function getReviewUncertainCommand(data, sender) {
  const context = normalizeReviewContextCommand(data, sender);
  const result = await getLocal([STATE_KEY, REVIEW_UNCERTAIN_KEY]);
  const root = normalizeRoot(result[STATE_KEY], context.accountId);
  if (root._meta.generation !== context.generation || root._meta.activeAccount !== context.accountId) {
    return { ok: false, stale: true, code: 'context-changed', generation: root._meta.generation };
  }
  const lockKey = reviewUncertainLockKey(context.accountId, context.slug);
  const store = normalizeReviewUncertainStore(result[REVIEW_UNCERTAIN_KEY]);
  let memoryMarker = reviewUncertainMemory.get(lockKey) || null;
  if (memoryMarker && memoryMarker.generation !== context.generation) {
    reviewUncertainMemory.delete(lockKey);
    memoryMarker = null;
  }
  const marker = store[context.accountId]?.[context.slug] || memoryMarker;
  if (marker) reviewUncertainMemory.set(lockKey, marker);
  return {
    ok: true,
    blocked: Boolean(marker),
    marker: marker ? { createdAt: marker.createdAt } : null,
    markerToken: marker?.requestId || null
  };
}

async function applyReviewDraftCommand(action, data) {
  const accountId = normalizeAccountId(data?.accountId);
  const slug = data?.slug;
  if (!accountId || accountId === LEGACY_ACCOUNT || !isSafeSlug(slug)) {
    throw new Error('Invalid review draft key');
  }
  const result = await getLocal([REVIEW_DRAFTS_KEY, STATE_KEY]);
  const root = normalizeRoot(result[STATE_KEY], accountId);
  const suppliedGeneration = Number(data?.generation);
  if (!Number.isSafeInteger(suppliedGeneration) || suppliedGeneration !== root._meta.generation) {
    return { ok: false, stale: true, generation: root._meta.generation };
  }
  let drafts = normalizeReviewDraftStore(result[REVIEW_DRAFTS_KEY]);

  if (action === 'reviewDraftGet') {
    return { ok: true, draft: drafts[accountId]?.[slug] || null };
  }
  if (action === 'reviewDraftUpsert') {
    const draft = normalizeReviewDraft(accountId, slug, data?.draft);
    if (!drafts[accountId]) drafts[accountId] = Object.create(null);
    if (reviewDraftIsAtLeastAsNew(draft, drafts[accountId][slug])) drafts[accountId][slug] = draft;
    // Re-normalizing applies the global newest-first cap after this write.
    drafts = normalizeReviewDraftStore(drafts);
  } else if (action === 'reviewDraftRemove') {
    const stored = drafts[accountId]?.[slug] || null;
    const expectedRevision = data?.expectedRevision;
    const expectedUpdatedAt = data?.expectedUpdatedAt;
    if (expectedRevision !== undefined || expectedUpdatedAt !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
          typeof expectedUpdatedAt !== 'string' || !Number.isFinite(new Date(expectedUpdatedAt).getTime())) {
        throw new Error('Invalid review draft removal identity');
      }
      if (stored && (stored.revision !== expectedRevision || stored.updatedAt !== new Date(expectedUpdatedAt).toISOString())) {
        return { ok: true, removed: false, newer: true, draft: stored, count: countReviewDrafts(drafts) };
      }
    }
    if (drafts[accountId]) {
      delete drafts[accountId][slug];
      if (Object.keys(drafts[accountId]).length === 0) delete drafts[accountId];
    }
  } else {
    throw new Error(`Unsupported review draft action: ${action}`);
  }
  // Draft persistence is deliberately not allowed to choose the active
  // account. After Clear All, the content script must first verify a freshly
  // fetched Letterboxd page and explicitly activate that confirmed account.
  await setLocal({ [REVIEW_DRAFTS_KEY]: drafts });
  return { ok: true, removed: action === 'reviewDraftRemove', count: countReviewDrafts(drafts) };
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
  }
  return bytes;
}

function reviewSubmissionFingerprint(submission) {
  const value = `${submission.accountId}\u0000${submission.generation}\u0000${submission.slug}\u0000${submission.bodyText}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${value.length}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function hasExactKeys(value, allowed, required = allowed) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.every(key => allowed.includes(key)) && required.every(key => keys.includes(key));
}

function supportedReviewSender(sender) {
  if (sender?.frameId !== 0 || typeof sender?.tab?.url !== 'string') return false;
  let url;
  try { url = new URL(sender.tab.url); } catch { return false; }
  if (url.origin !== 'https://letterboxd.com') return false;
  return /^\/film\/[a-z0-9][a-z0-9-]*(?:\/[^?#]*)?$/i.test(url.pathname) ||
    /^\/films(?:\/[^?#]*)?$/i.test(url.pathname) ||
    /^\/[a-z0-9_]{1,64}\/(?:films|watchlist|list)(?:\/[^?#]*)?$/i.test(url.pathname);
}

function normalizeReviewSubmission(data, sender) {
  const allowedData = [
    'accountId', 'generation', 'slug', 'csrf', 'payload', 'requestId',
    'draftRevision', 'draftUpdatedAt'
  ];
  if (!supportedReviewSender(sender) || !hasExactKeys(data, allowedData)) {
    throw new Error('Invalid review submission context');
  }
  const accountId = normalizeAccountId(data.accountId);
  const generation = Number(data.generation);
  const slug = data.slug;
  if (!accountId || accountId === LEGACY_ACCOUNT || !Number.isSafeInteger(generation) || generation < 0 || !isSafeSlug(slug)) {
    throw new Error('Invalid review submission identity');
  }
  if (typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 200 || /[\r\n\0]/.test(data.requestId) ||
      ['__proto__', 'constructor', 'prototype'].includes(data.requestId)) {
    throw new Error('Invalid review request id');
  }
  if (typeof data.csrf !== 'string' || !data.csrf.trim() || data.csrf.length > MAX_CSRF_LENGTH || /[\r\n\0]/.test(data.csrf)) {
    throw new Error('Invalid review CSRF token');
  }
  if (!Number.isSafeInteger(data.draftRevision) || data.draftRevision < 0 ||
      typeof data.draftUpdatedAt !== 'string' || !Number.isFinite(new Date(data.draftUpdatedAt).getTime())) {
    throw new Error('Invalid review draft identity');
  }

  const raw = data.payload;
  const allowedPayload = ['productionId', 'diaryDetails', 'tags', 'like', 'review', 'rating', 'privacyPolicy'];
  if (!hasExactKeys(raw, allowedPayload, ['productionId', 'diaryDetails', 'tags', 'like'])) {
    throw new Error('Invalid review payload');
  }
  const productionIdValid = (typeof raw.productionId === 'string' && raw.productionId.length > 0 &&
      raw.productionId.length <= 128 && /^[a-z0-9_-]+$/i.test(raw.productionId)) ||
    (Number.isSafeInteger(raw.productionId) && raw.productionId > 0);
  if (!productionIdValid ||
      !hasExactKeys(raw.diaryDetails, ['diaryDate', 'rewatch']) ||
      !isValidDiaryDate(raw.diaryDetails.diaryDate) || typeof raw.diaryDetails.rewatch !== 'boolean' ||
      typeof raw.like !== 'boolean') {
    throw new Error('Invalid review payload details');
  }
  const tags = normalizeReviewTags(raw.tags);
  const payload = {
    productionId: raw.productionId,
    diaryDetails: { diaryDate: raw.diaryDetails.diaryDate, rewatch: raw.diaryDetails.rewatch },
    tags,
    like: raw.like
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'review')) {
    if (!hasExactKeys(raw.review, ['text', 'containsSpoilers']) ||
        typeof raw.review.text !== 'string' || !raw.review.text.trim() ||
        raw.review.text.length > MAX_REVIEW_TEXT_LENGTH || typeof raw.review.containsSpoilers !== 'boolean') {
      throw new Error('Invalid review text');
    }
    payload.review = { text: raw.review.text, containsSpoilers: raw.review.containsSpoilers };
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'rating')) {
    if (typeof raw.rating !== 'number' || !Number.isFinite(raw.rating) || raw.rating < 0.5 || raw.rating > 5 || !Number.isInteger(raw.rating * 2)) {
      throw new Error('Invalid review rating');
    }
    payload.rating = raw.rating;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'privacyPolicy')) {
    if (typeof raw.privacyPolicy !== 'string' || !raw.privacyPolicy.trim() || raw.privacyPolicy.length > 100 || /[\r\n\0]/.test(raw.privacyPolicy)) {
      throw new Error('Invalid review privacy policy');
    }
    payload.privacyPolicy = raw.privacyPolicy;
  }
  if (!payload.review && payload.rating === undefined) throw new Error('A review or rating is required');
  const bodyText = JSON.stringify(payload);
  if (utf8ByteLength(bodyText) > MAX_REVIEW_REQUEST_BYTES) throw new Error('Review submission is too large');
  const submission = {
    accountId,
    generation,
    slug,
    csrf: data.csrf,
    requestId: data.requestId,
    draftRevision: data.draftRevision,
    draftUpdatedAt: new Date(data.draftUpdatedAt).toISOString(),
    payload,
    bodyText
  };
  submission.fingerprint = reviewSubmissionFingerprint(submission);
  return submission;
}

function responseMessageText(message) {
  if (typeof message === 'string') return message;
  for (const key of ['message', 'text', 'title', 'detail']) {
    if (typeof message?.[key] === 'string' && message[key].trim()) return message[key].trim();
  }
  return '';
}

function verifyReviewResponse(body, intended) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const rejection = messages.find(message => message?.type === 'Error');
  if (rejection) return { status: 'rejected', reason: responseMessageText(rejection) || 'Letterboxd rejected entry' };
  const logEntry = body?.logEntry;
  if (!isRecord(logEntry) || String(logEntry.id || '').trim() === '') {
    return { status: 'unconfirmed', reason: 'Response did not include a log entry id' };
  }
  const comparisons = [
    [logEntry.productionId, intended.productionId, false],
    [logEntry.diaryDetails?.diaryDate, intended.diaryDetails.diaryDate, true],
    [logEntry.diaryDetails?.rewatch, intended.diaryDetails.rewatch, true],
    [logEntry.like, intended.like, true],
    [logEntry.tags, intended.tags, intended.tags.length > 0]
  ];
  if (intended.review) {
    comparisons.push([logEntry.review?.text, intended.review.text, true]);
    comparisons.push([logEntry.review?.containsSpoilers, intended.review.containsSpoilers, false]);
  }
  if (intended.rating !== undefined) comparisons.push([logEntry.rating, intended.rating, true]);
  if (intended.privacyPolicy !== undefined) comparisons.push([logEntry.privacyPolicy, intended.privacyPolicy, false]);
  for (const [actual, expected, required] of comparisons) {
    if (actual === undefined) {
      if (required) return { status: 'unconfirmed', reason: 'Response omitted submitted values' };
      continue;
    }
    if (Array.isArray(actual) || Array.isArray(expected)) {
      if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length ||
          actual.some((value, index) => value !== expected[index])) {
        return { status: 'unconfirmed', reason: 'Returned entry did not match the submitted values' };
      }
    } else if (String(actual) !== String(expected)) {
      return { status: 'unconfirmed', reason: 'Returned entry did not match the submitted values' };
    }
  }
  return { status: 'confirmed', logEntryId: String(logEntry.id) };
}

function ratingDisplay(rating) {
  return rating ? '★'.repeat(Math.floor(rating)) + (rating % 1 ? '½' : '') : null;
}

async function prepareReviewDispatch(submission) {
  const stored = await getLocal([STATE_KEY, REVIEW_UNCERTAIN_KEY, REVIEW_SUBMISSIONS_KEY]);
  const root = normalizeRoot(stored[STATE_KEY], submission.accountId);
  const completed = normalizeReviewSubmissionStore(stored[REVIEW_SUBMISSIONS_KEY]);
  const prior = completed[submission.requestId];
  if (prior) {
    if (prior.accountId !== submission.accountId || prior.slug !== submission.slug ||
        prior.generation !== submission.generation || prior.fingerprint !== submission.fingerprint) {
      return { ok: false, code: 'request-id-reused', error: 'Review request id was already used for different data', uncertain: false };
    }
    return { ok: true, replay: replayCompletedReview(prior) };
  }
  if (root._meta.generation !== submission.generation || root._meta.activeAccount !== submission.accountId) {
    return { ok: false, stale: true, code: 'context-changed', generation: root._meta.generation, uncertain: false };
  }

  const store = normalizeReviewUncertainStore(stored[REVIEW_UNCERTAIN_KEY]);
  const lockKey = reviewUncertainLockKey(submission.accountId, submission.slug);
  let marker = store[submission.accountId]?.[submission.slug] || null;
  if (marker && marker.generation !== submission.generation) {
    delete store[submission.accountId][submission.slug];
    if (Object.keys(store[submission.accountId]).length === 0) delete store[submission.accountId];
    marker = null;
    reviewUncertainMemory.delete(lockKey);
  }
  const memoryMarker = reviewUncertainMemory.get(lockKey);
  if (!marker && memoryMarker?.generation === submission.generation) marker = memoryMarker;
  else if (memoryMarker && memoryMarker.generation !== submission.generation) reviewUncertainMemory.delete(lockKey);
  if (marker) {
    if (marker.requestId === submission.requestId && marker.fingerprint && marker.fingerprint !== submission.fingerprint) {
      return { ok: false, code: 'request-id-reused', error: 'Review request id was already used for different data', uncertain: false };
    }
    reviewUncertainMemory.set(lockKey, marker);
    return {
      ok: false,
      blocked: true,
      uncertain: true,
      code: 'uncertain-review',
      markerToken: marker.requestId,
      error: 'A previous submission for this film was not confirmed. Check Letterboxd before allowing another submission.'
    };
  }

  const existingEntry = root.accounts[submission.accountId]?.slugs?.[submission.slug];
  const existingLogKnown = Boolean(
    existingEntry?.watchedDate || existingEntry?.reviewText || existingEntry?.reviewUrl
  );
  if (existingLogKnown && submission.payload.diaryDetails.rewatch !== true) {
    return {
      ok: false,
      code: 'existing-log',
      error: 'This film already has diary or review data locally. Edit it on Letterboxd, or explicitly submit as a rewatch.',
      uncertain: false
    };
  }

  const dispatchMarker = {
    accountId: submission.accountId,
    slug: submission.slug,
    generation: submission.generation,
    requestId: submission.requestId,
    createdAt: new Date().toISOString(),
    reason: 'A review submission was started but has not yet been confirmed',
    status: 'dispatched',
    fingerprint: submission.fingerprint
  };
  if (!store[submission.accountId]) store[submission.accountId] = Object.create(null);
  store[submission.accountId][submission.slug] = dispatchMarker;
  await setLocal({ [REVIEW_UNCERTAIN_KEY]: normalizeReviewUncertainStore(store) });
  reviewUncertainMemory.set(lockKey, dispatchMarker);
  return { ok: true, prepared: true };
}

async function clearReviewDispatchMarker(submission) {
  const stored = await getLocal([STATE_KEY, REVIEW_UNCERTAIN_KEY]);
  const root = normalizeRoot(stored[STATE_KEY], submission.accountId);
  if (root._meta.generation !== submission.generation) return false;
  const store = normalizeReviewUncertainStore(stored[REVIEW_UNCERTAIN_KEY]);
  const current = store[submission.accountId]?.[submission.slug];
  if (current?.requestId !== submission.requestId) return false;
  delete store[submission.accountId][submission.slug];
  if (Object.keys(store[submission.accountId]).length === 0) delete store[submission.accountId];
  await setLocal({ [REVIEW_UNCERTAIN_KEY]: store });
  const lockKey = reviewUncertainLockKey(submission.accountId, submission.slug);
  if (reviewUncertainMemory.get(lockKey)?.requestId === submission.requestId) reviewUncertainMemory.delete(lockKey);
  return true;
}

async function finalizeRejectedReview(submission, httpStatus, verification) {
  const stored = await getLocal([STATE_KEY, REVIEW_UNCERTAIN_KEY, REVIEW_SUBMISSIONS_KEY]);
  const root = normalizeRoot(stored[STATE_KEY], submission.accountId);
  if (root._meta.generation !== submission.generation) return false;
  const uncertain = normalizeReviewUncertainStore(stored[REVIEW_UNCERTAIN_KEY]);
  if (uncertain[submission.accountId]?.[submission.slug]?.requestId === submission.requestId) {
    delete uncertain[submission.accountId][submission.slug];
    if (Object.keys(uncertain[submission.accountId]).length === 0) delete uncertain[submission.accountId];
  }
  const completed = normalizeReviewSubmissionStore(stored[REVIEW_SUBMISSIONS_KEY]);
  completed[submission.requestId] = {
    requestId: submission.requestId,
    accountId: submission.accountId,
    slug: submission.slug,
    generation: submission.generation,
    fingerprint: submission.fingerprint,
    status: 'rejected',
    completedAt: new Date().toISOString(),
    httpStatus,
    reason: verification.reason || 'Letterboxd rejected entry',
    stateCommitted: false,
    draftCleared: false,
    newerDraft: false
  };
  await setLocal({
    [REVIEW_UNCERTAIN_KEY]: uncertain,
    [REVIEW_SUBMISSIONS_KEY]: normalizeReviewSubmissionStore(completed)
  });
  const lockKey = reviewUncertainLockKey(submission.accountId, submission.slug);
  if (reviewUncertainMemory.get(lockKey)?.requestId === submission.requestId) reviewUncertainMemory.delete(lockKey);
  return true;
}

async function commitConfirmedReview(submission) {
  const result = await getLocal([STATE_KEY, REVIEW_DRAFTS_KEY, REVIEW_UNCERTAIN_KEY, REVIEW_SUBMISSIONS_KEY]);
  const root = normalizeRoot(result[STATE_KEY], submission.accountId);
  if (root._meta.generation !== submission.generation) {
    return { stateCommitted: false, draftCleared: false, contextChanged: true, generation: root._meta.generation };
  }
  const account = root.accounts[submission.accountId] || freshAccount();
  const now = new Date().toISOString();
  const incoming = {
    watched: true,
    watchedAt: null,
    watchedDate: submission.payload.diaryDetails.diaryDate,
    watchedChangedAt: now,
    watchedSource: 'userAction',
    liked: submission.payload.like,
    likedAt: submission.payload.like ? now : null,
    likedChangedAt: now,
    likedSource: 'userAction',
    url: `https://letterboxd.com/film/${submission.slug}/`,
    metadataUpdatedAt: now,
    metadataSource: 'userAction',
    source: 'userAction',
    updatedAt: now
  };
  if (submission.payload.review) incoming.reviewText = submission.payload.review.text;
  if (submission.payload.rating !== undefined) {
    incoming.ratingValue = submission.payload.rating;
    incoming.rating = ratingDisplay(submission.payload.rating);
  }
  account.slugs[submission.slug] = mergeEntry(account.slugs[submission.slug], incoming, submission.slug, submission.accountId);
  account._meta = mergeMeta(account._meta, { updatedAt: now });
  root.accounts[submission.accountId] = account;
  root._meta.updatedAt = now;
  root._meta.lastWriteAt = now;

  const drafts = normalizeReviewDraftStore(result[REVIEW_DRAFTS_KEY]);
  const storedDraft = drafts[submission.accountId]?.[submission.slug] || null;
  let draftCleared = !storedDraft;
  if (storedDraft && storedDraft.revision === submission.draftRevision && storedDraft.updatedAt === submission.draftUpdatedAt) {
    delete drafts[submission.accountId][submission.slug];
    if (Object.keys(drafts[submission.accountId]).length === 0) delete drafts[submission.accountId];
    draftCleared = true;
  }
  const uncertain = normalizeReviewUncertainStore(result[REVIEW_UNCERTAIN_KEY]);
  if (uncertain[submission.accountId]?.[submission.slug]?.requestId === submission.requestId) {
    delete uncertain[submission.accountId][submission.slug];
    if (Object.keys(uncertain[submission.accountId]).length === 0) delete uncertain[submission.accountId];
  }
  const completed = normalizeReviewSubmissionStore(result[REVIEW_SUBMISSIONS_KEY]);
  completed[submission.requestId] = {
    requestId: submission.requestId,
    accountId: submission.accountId,
    slug: submission.slug,
    generation: submission.generation,
    fingerprint: submission.fingerprint,
    status: 'confirmed',
    completedAt: now,
    httpStatus: submission.httpStatus,
    logEntryId: submission.logEntryId,
    stateCommitted: true,
    draftCleared,
    newerDraft: Boolean(storedDraft && !draftCleared)
  };
  const lockKey = reviewUncertainLockKey(submission.accountId, submission.slug);
  if (reviewUncertainMemory.get(lockKey)?.requestId === submission.requestId) reviewUncertainMemory.delete(lockKey);
  await setLocal({
    [STATE_KEY]: root,
    [REVIEW_DRAFTS_KEY]: drafts,
    [REVIEW_UNCERTAIN_KEY]: uncertain,
    [REVIEW_SUBMISSIONS_KEY]: normalizeReviewSubmissionStore(completed)
  });
  return { stateCommitted: true, draftCleared, newerDraft: Boolean(storedDraft && !draftCleared), generation: root._meta.generation };
}

async function submitReviewCommand(data, sender) {
  let submission;
  try { submission = normalizeReviewSubmission(data, sender); }
  catch (error) { return { ok: false, code: 'invalid-request', error: error.message, uncertain: false }; }

  const lockKey = `${submission.accountId}\u0000${submission.slug}`;
  if (pendingReviewSubmissions.has(lockKey)) {
    return { ok: false, busy: true, code: 'submission-in-progress', error: 'A review for this film is already being submitted', uncertain: false };
  }
  const controller = new AbortController();
  const pending = { ...submission, controller, dispatched: false, abortReason: null };
  pendingReviewSubmissions.set(lockKey, pending);
  let timeout = null;
  const uncertainResult = async (result, reason) => {
    const markerSaved = await markReviewUncertain(submission, reason || result.error);
    return { ...result, uncertain: true, blocked: true, markerSaved, markerToken: submission.requestId };
  };
  try {
    const prepared = await (stateWriteQueue = stateWriteQueue.catch(() => {}).then(() => prepareReviewDispatch(submission)));
    if (!prepared.ok) return prepared;
    if (prepared.replay) return prepared.replay;
    pending.prepared = true;
    if (controller.signal.aborted) {
      await (stateWriteQueue = stateWriteQueue.catch(() => {}).then(() => clearReviewDispatchMarker(submission)));
      return { ok: false, code: 'context-changed', error: pending.abortReason || 'Review submission was cancelled', uncertain: false };
    }
    timeout = setTimeout(() => {
      pending.abortReason = 'Letterboxd did not respond in time';
      controller.abort();
    }, REVIEW_SUBMIT_TIMEOUT_MS);
    pending.dispatched = true;
    let response;
    try {
      response = await fetch(REVIEW_SUBMIT_ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          'X-CSRF-TOKEN': submission.csrf
        },
        body: submission.bodyText,
        signal: controller.signal
      });
    } catch (error) {
      return await uncertainResult({
        ok: false,
        code: controller.signal.aborted ? 'submission-aborted' : 'network-error',
        error: pending.abortReason || error.message || 'Review request failed'
      }, pending.abortReason || error.message);
    }
    const announcedLength = Number(response.headers?.get?.('Content-Length'));
    if (Number.isFinite(announcedLength) && announcedLength > MAX_REVIEW_RESPONSE_BYTES) {
      return await uncertainResult({ ok: false, code: 'response-too-large', error: 'Letterboxd returned an oversized response', status: response.status });
    }
    const responseText = await response.text();
    if (utf8ByteLength(responseText) > MAX_REVIEW_RESPONSE_BYTES) {
      return await uncertainResult({ ok: false, code: 'response-too-large', error: 'Letterboxd returned an oversized response', status: response.status });
    }
    let body = null;
    if (responseText) {
      try { body = JSON.parse(responseText); }
      catch {
        return await uncertainResult({
          ok: false,
          code: 'invalid-response',
          error: 'Letterboxd returned an invalid response after the submission was sent',
          status: response.status
        });
      }
    }
    const verification = verifyReviewResponse(body, submission.payload);
    if (!response.ok) {
      if (verification.status === 'rejected') {
        await (stateWriteQueue = stateWriteQueue.catch(() => {}).then(() =>
          finalizeRejectedReview(submission, response.status, verification)
        ));
        return { ok: true, status: response.status, body, confirmed: false, verification, uncertain: false };
      }
      return await uncertainResult({
        ok: false,
        code: 'unconfirmed-http-error',
        error: `Letterboxd returned ${response.status} without an explicit rejection`,
        status: response.status,
        verification
      }, verification.reason);
    }
    if (verification.status !== 'confirmed') {
      if (verification.status === 'unconfirmed') {
        return await uncertainResult({ ok: true, status: response.status, body, confirmed: false, verification }, verification.reason);
      }
      await (stateWriteQueue = stateWriteQueue.catch(() => {}).then(() =>
        finalizeRejectedReview(submission, response.status, verification)
      ));
      return { ok: true, status: response.status, body, confirmed: false, verification, uncertain: false };
    }
    submission.httpStatus = response.status;
    submission.logEntryId = verification.logEntryId;
    const committed = await (stateWriteQueue = stateWriteQueue.catch(() => {}).then(() => commitConfirmedReview(submission)));
    return { ok: true, status: response.status, body, confirmed: true, verification, ...committed, uncertain: false };
  } catch (error) {
    if (pending.dispatched) {
      return await uncertainResult({ ok: false, code: 'worker-error', error: error.message }, error.message);
    }
    return { ok: false, code: 'worker-error', error: error.message, uncertain: false };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (pendingReviewSubmissions.get(lockKey) === pending) pendingReviewSubmissions.delete(lockKey);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'vypode-review' && ['submit', 'resolveUncertain', 'getUncertain'].includes(msg.action)) {
    const operation = msg.action === 'submit'
      ? submitReviewCommand(msg.data, sender)
      : msg.action === 'resolveUncertain'
        ? (stateWriteQueue = stateWriteQueue.catch(() => {}).then(() => resolveReviewUncertainCommand(msg.data, sender)))
        : getReviewUncertainCommand(msg.data, sender);
    operation.then(sendResponse, error => {
      sendResponse({ ok: false, code: 'worker-error', error: error.message, uncertain: false });
    });
    return true;
  }
  if (msg?.type === 'vypode-state') {
    stateWriteQueue = stateWriteQueue.catch(() => {}).then(() =>
      ['outboxUpsert', 'outboxRemove', 'outboxClaim', 'outboxMarkDispatched',
        'outboxComplete', 'outboxRelease', 'outboxList'].includes(msg.action)
        ? applyOutboxCommand(msg.action, msg.data)
        : msg.action === 'reviewDraftGet' || msg.action === 'reviewDraftUpsert' || msg.action === 'reviewDraftRemove'
          ? applyReviewDraftCommand(msg.action, msg.data)
        : applyStateCommand(msg.action, msg.data)
    );
    stateWriteQueue.then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg?.type !== 'vypode') return;

  if (msg.action === 'stateChanged') {
    sendResponse({ ok: true });
  }
});
