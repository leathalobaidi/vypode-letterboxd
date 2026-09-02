import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../../background.js', import.meta.url)), 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sharedLocal(initial = {}) {
  const store = clone(initial);
  return {
    store,
    get(keys, callback) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = clone(store[key]);
      callback(result);
    },
    set(items, callback) {
      Object.assign(store, clone(items));
      callback?.();
    }
  };
}

function loadBackground(local, options = {}) {
  const listeners = [];
  const context = {
    console,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: options.fetch || (async () => { throw new Error('Unexpected fetch'); }),
    chrome: {
      storage: { local },
      runtime: { lastError: null, onMessage: { addListener(listener) { listeners.push(listener); } } }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'background.js' });
  return {
    request(message, sender = {}) {
      return new Promise(resolve => {
        assert.equal(listeners.length, 1);
        assert.equal(listeners[0](message, sender, resolve), true);
      });
    }
  };
}

function merge(accountId, slug, flag, generation = 0) {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    type: 'vypode-state', action: 'mergeAccount', data: {
      accountId, generation, meta: { updatedAt: timestamp }, slugs: {
        [slug]: { [flag]: true, [`${flag}ChangedAt`]: timestamp, [`${flag}Source`]: 'userAction', updatedAt: timestamp }
      }
    }
  };
}

function outbox(id, action, overrides = {}) {
  const slug = overrides.slug || id;
  const now = overrides.createdAt || new Date().toISOString();
  const generation = overrides.generation ?? 0;
  return {
    type: 'vypode-state', action: 'outboxUpsert', data: { id, generation, account: overrides.account || 'Alice', record: {
      id, filmUrl: `https://letterboxd.com/film/${slug}/`, action, slug,
      previousValue: false, account: 'Alice', createdAt: now,
      mutationAt: overrides.mutationAt || now,
      mutationToken: overrides.mutationToken || `mutation:${id}`,
      generation,
      ...overrides
    } }
  };
}

function reviewDraft(slug, overrides = {}, accountId = 'user:alice') {
  return {
    type: 'vypode-state', action: 'reviewDraftUpsert', data: {
      accountId,
      slug,
      generation: 0,
      draft: {
        reviewText: `Draft for ${slug}`,
        rating: 3.5,
        diaryDate: '2026-01-02',
        rewatch: false,
        spoilers: false,
        likeMode: 'preserve',
        tags: ['cinema'],
        updatedAt: '2026-01-02T00:00:00.000Z',
        ...overrides
      }
    }
  };
}

const reviewSender = {
  frameId: 0,
  tab: { url: 'https://letterboxd.com/film/arrival/' }
};

function reviewSubmission(overrides = {}) {
  return {
    type: 'vypode-review',
    action: 'submit',
    data: {
      accountId: 'user:alice',
      generation: 0,
      slug: 'arrival',
      csrf: 'csrf-token',
      requestId: `review-request-${Math.random()}`,
      draftRevision: 0,
      draftUpdatedAt: '2026-01-02T00:00:00.000Z',
      payload: {
        productionId: 'film-123',
        diaryDetails: { diaryDate: '2026-01-02', rewatch: false },
        tags: ['cinema'],
        like: true,
        review: { text: 'A careful review', containsSpoilers: false },
        rating: 4.5
      },
      ...overrides
    }
  };
}

function reviewResponse(status = 200, body = null, headers = {}) {
  const fallback = {
    logEntry: {
      id: 'entry-1',
      productionId: 'film-123',
      diaryDetails: { diaryDate: '2026-01-02', rewatch: false },
      tags: ['cinema'],
      like: true,
      review: { text: 'A careful review', containsSpoilers: false },
      rating: 4.5
    }
  };
  const text = JSON.stringify(body ?? fallback);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[name] ?? headers[name.toLowerCase()] ?? null; } },
    async text() { return text; }
  };
}

function activate(accountId = 'user:alice', generation = 0) {
  return { type: 'vypode-state', action: 'activateAccount', data: { accountId, generation } };
}

function claimVerifiedAccount(accountId = 'user:alice', generation = 0) {
  return {
    type: 'vypode-state',
    action: 'claimVerifiedAccount',
    data: { accountId, generation }
  };
}

test('two callers are serialized: account merges and interleaved outbox commands retain both records', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);

  const [first, second] = await Promise.all([
    background.request(merge('user:alice', 'arrival', 'watched')),
    background.request(merge('user:alice', 'moonlight', 'liked'))
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.arrival.watched, true);
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.moonlight.liked, true);

  await Promise.all([
    background.request(outbox('arrival', 'watch')),
    background.request(outbox('moonlight', 'like'))
  ]);
  const removal = background.request({ type: 'vypode-state', action: 'outboxRemove', data: { id: 'arrival' } });
  const third = background.request(outbox('parasite', 'watchlist'));
  await Promise.all([removal, third]);
  assert.deepEqual(Object.keys(local.store.vypode_action_outbox_v1).sort(), ['moonlight', 'parasite']);
});

test('a stale account merge cannot reclaim a root cleared by another tab', async () => {
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 1, activeAccount: '$legacy' },
      accounts: {}
    }
  });
  const background = loadBackground(local);

  const result = await background.request(merge('user:alice', 'arrival', 'watched', 1));

  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.activeAccount, '$legacy');
  assert.equal(local.store.vypode_state._meta.activeAccount, '$legacy');
  assert.equal(local.store.vypode_state.accounts['user:alice'], undefined);
});

test('a freshly verified review account can atomically claim legacy ownership', async () => {
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 4, activeAccount: '$legacy' },
      accounts: {}
    }
  });
  const background = loadBackground(local);

  const result = await background.request(claimVerifiedAccount('user:alice', 4));

  assert.equal(result.ok, true);
  assert.equal(result.claimed, true);
  assert.equal(local.store.vypode_state._meta.activeAccount, 'user:alice');

  const repeated = await background.request(claimVerifiedAccount('user:alice', 4));
  assert.equal(repeated.ok, true, 'the same verified account should be idempotent');
  assert.equal(repeated.claimed, false);
});

test('a freshly verified review account can atomically claim absent state', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);

  const result = await background.request(claimVerifiedAccount('user:alice', 0));

  assert.equal(result.ok, true);
  assert.equal(result.claimed, true);
  assert.equal(local.store.vypode_state._meta.activeAccount, 'user:alice');
  assert.ok(local.store.vypode_state.accounts['user:alice']);
});

test('a verified legacy claim cannot replace an account activated before worker serialization', async () => {
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 4, activeAccount: '$legacy' },
      accounts: {}
    }
  });
  const background = loadBackground(local);
  const winner = await background.request(activate('user:bob', 4));
  assert.equal(winner.ok, true);
  assert.equal(local.store.vypode_state._meta.activeAccount, 'user:bob');

  const result = await background.request(claimVerifiedAccount('user:alice', 4));

  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.code, 'active-account-changed');
  assert.equal(result.activeAccount, 'user:bob');
  assert.equal(local.store.vypode_state._meta.activeAccount, 'user:bob');
  assert.equal(local.store.vypode_state.accounts['user:alice'], undefined);
});

test('simultaneous verified claims allow exactly one different account to win', async () => {
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 4, activeAccount: '$legacy' },
      accounts: {}
    }
  });
  const background = loadBackground(local);

  const results = await Promise.all([
    background.request(claimVerifiedAccount('user:alice', 4)),
    background.request(claimVerifiedAccount('user:bob', 4))
  ]);

  const winners = results.filter(result => result.ok);
  const conflicts = results.filter(result => result.code === 'active-account-changed');
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(local.store.vypode_state._meta.activeAccount, winners[0].activeAccount);
});

test('a verified claim never retries across a newer clear generation', async () => {
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 5, activeAccount: '$legacy' },
      accounts: {}
    }
  });
  const background = loadBackground(local);

  const result = await background.request(claimVerifiedAccount('user:alice', 4));

  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.code, 'generation-changed');
  assert.equal(local.store.vypode_state._meta.activeAccount, '$legacy');
  assert.equal(local.store.vypode_state.accounts['user:alice'], undefined);
});

test('serialized claims dedupe account-film-action work and permit exactly one tab to dispatch', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);
  const first = await background.request(outbox('arrival-tab-a', 'watch', { slug: 'arrival' }));
  const duplicate = await background.request(outbox('arrival-tab-b', 'watch', { slug: 'arrival' }));
  assert.equal(first.ok, true);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.id, 'arrival-tab-a');
  assert.deepEqual(Object.keys(local.store.vypode_action_outbox_v1), ['arrival-tab-a']);

  const [ownerA, ownerB] = await Promise.all([
    background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
      id: 'arrival-tab-a', owner: 'tab-a', leaseMs: 30000, account: 'alice', generation: 0
    } }),
    background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
      id: 'arrival-tab-a', owner: 'tab-b', leaseMs: 30000, account: 'alice', generation: 0
    } })
  ]);
  assert.equal(ownerA.claimed, true);
  assert.equal(ownerB.busy, true);

  await background.request(outbox('arrival-tab-a', 'watch', { slug: 'arrival' }));
  assert.equal(local.store.vypode_action_outbox_v1['arrival-tab-a'].leaseOwner, 'tab-a',
    'a retry/upsert must preserve its existing claim');
  const marked = await background.request({
    type: 'vypode-state', action: 'outboxMarkDispatched', data: { id: 'arrival-tab-a', owner: 'tab-a' }
  });
  assert.equal(marked.marked, true, 'the worker must explicitly authorize the irreversible click');
  assert.ok(marked.record.dispatchedAt);
  const wrongComplete = await background.request({
    type: 'vypode-state', action: 'outboxComplete', data: { id: 'arrival-tab-a', owner: 'tab-b' }
  });
  assert.equal(wrongComplete.ownerMismatch, true);
  const completed = await background.request({
    type: 'vypode-state', action: 'outboxComplete', data: { id: 'arrival-tab-a', owner: 'tab-a' }
  });
  assert.equal(completed.completed, true);
  assert.deepEqual(local.store.vypode_action_outbox_v1, {});
});

test('an expired lease can be recovered but an active owner cannot be displaced', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);
  await background.request(outbox('moonlight', 'like'));
  local.store.vypode_action_outbox_v1.moonlight.leaseOwner = 'crashed-tab';
  local.store.vypode_action_outbox_v1.moonlight.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();

  const staleCompletion = await background.request({
    type: 'vypode-state', action: 'outboxComplete', data: { id: 'moonlight', owner: 'crashed-tab' }
  });
  assert.equal(staleCompletion.leaseExpired, true, 'an expired owner cannot complete work it no longer owns');

  const recovered = await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
    id: 'moonlight', owner: 'recovery-tab', leaseMs: 30000, account: 'alice', generation: 0
  } });
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.record.leaseOwner, 'recovery-tab');
  const wrongAccount = await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
    id: 'moonlight', owner: 'bob-tab', leaseMs: 30000, account: 'bob', generation: 0
  } });
  assert.equal(wrongAccount.accountMismatch, true);
  const blocked = await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
    id: 'moonlight', owner: 'third-tab', leaseMs: 30000, account: 'alice', generation: 0
  } });
  assert.equal(blocked.busy, true);
});

test('listing prunes corrupt records and account-safely rolls back expired optimistic state', async () => {
  const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 0, activeAccount: 'user:alice' },
      accounts: {
        'user:alice': { _meta: { version: 3 }, slugs: {
          arrival: {
            watched: true, watchedAt: expiredAt, watchedChangedAt: expiredAt,
            watchedSource: 'userAction', watchedMutationToken: 'expired-mutation', updatedAt: expiredAt
          },
          newer: {
            liked: true, likedAt: new Date().toISOString(), likedChangedAt: new Date().toISOString(),
            likedSource: 'userAction', likedMutationToken: 'newer-external', updatedAt: new Date().toISOString()
          }
        } },
        'user:bob': { _meta: { version: 3 }, slugs: {
          arrival: { watched: true, watchedChangedAt: expiredAt, watchedMutationToken: 'bob-value' }
        } }
      }
    },
    vypode_action_outbox_v1: {
      expired: outbox('expired', 'watch', {
        slug: 'arrival', createdAt: expiredAt, mutationAt: expiredAt, mutationToken: 'expired-mutation'
      }).data.record,
      staleAgainstNewer: outbox('staleAgainstNewer', 'like', {
        slug: 'newer', createdAt: expiredAt, mutationAt: expiredAt, mutationToken: 'old-like'
      }).data.record,
      corrupt: { id: 'corrupt', action: 'delete-everything' }
    }
  });
  const background = loadBackground(local);
  const listed = await background.request({
    type: 'vypode-state', action: 'outboxList', data: { account: 'alice', generation: 0 }
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.records.length, 0);
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.arrival.watched, false);
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.newer.liked, true,
    'expiry cannot overwrite a newer same-flag mutation');
  assert.equal(local.store.vypode_state.accounts['user:bob'].slugs.arrival.watched, true,
    'expiry reconciliation remains scoped to the record account');
  assert.deepEqual(local.store.vypode_action_outbox_v1, {});
});

test('an early missing-claim response still persists expiry reconciliation', async () => {
  const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 0, activeAccount: 'user:alice' },
      accounts: {
        'user:alice': { _meta: { version: 3 }, slugs: {
          arrival: {
            watched: true,
            watchedAt: expiredAt,
            watchedChangedAt: expiredAt,
            watchedSource: 'userAction',
            watchedMutationToken: 'expired-claim',
            updatedAt: expiredAt
          }
        } }
      }
    },
    vypode_action_outbox_v1: {
      expired: outbox('expired', 'watch', {
        slug: 'arrival', createdAt: expiredAt, mutationAt: expiredAt, mutationToken: 'expired-claim'
      }).data.record
    }
  });
  const background = loadBackground(local);
  const claim = await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
    id: 'expired', owner: 'recovery-tab', leaseMs: 30000, account: 'alice', generation: 0
  } });

  assert.equal(claim.missing, true);
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.arrival.watched, false);
  assert.deepEqual(local.store.vypode_action_outbox_v1, {});
});

test('terminal outbox outcomes distinguish success, failure, cancellation, and uncertainty', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);

  await background.request(outbox('success-id', 'watch', { slug: 'arrival' }));
  await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
    id: 'success-id', owner: 'owner', leaseMs: 30000, account: 'alice', generation: 0
  } });
  await background.request({ type: 'vypode-state', action: 'outboxComplete', data: { id: 'success-id', owner: 'owner' } });
  const success = await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
    id: 'success-id', owner: 'follower', leaseMs: 30000, account: 'alice', generation: 0
  } });
  assert.equal(success.missing, true);
  assert.equal(success.outcome, 'success');

  for (const [id, outcome] of [['failed-id', 'failed'], ['cancelled-id', 'cancelled']]) {
    await background.request(outbox(id, 'like', { slug: `${outcome}-film` }));
    await background.request({ type: 'vypode-state', action: 'outboxRemove', data: { id, outcome } });
    const result = await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
      id, owner: 'follower', leaseMs: 30000, account: 'alice', generation: 0
    } });
    assert.equal(result.outcome, outcome);
  }
});

test('an expired dispatched action remains uncertain and is never rolled back as a proven failure', async () => {
  const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 0, activeAccount: 'user:alice' },
      accounts: { 'user:alice': { _meta: { version: 3 }, slugs: {
        arrival: {
          watched: true, watchedAt: expiredAt, watchedChangedAt: expiredAt,
          watchedSource: 'userAction', watchedMutationToken: 'clicked-once', updatedAt: expiredAt
        }
      } } }
    },
    vypode_action_outbox_v1: {
      dispatched: outbox('dispatched', 'watch', {
        slug: 'arrival', createdAt: expiredAt, mutationAt: expiredAt,
        mutationToken: 'clicked-once', dispatchedAt: expiredAt
      }).data.record
    }
  });
  const background = loadBackground(local);
  await background.request({ type: 'vypode-state', action: 'outboxList', data: { account: 'alice', generation: 0 } });
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.arrival.watched, true);
  const claim = await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
    id: 'dispatched', owner: 'follower', leaseMs: 30000, account: 'alice', generation: 0
  } });
  assert.equal(claim.missing, true);
  assert.equal(claim.outcome, 'uncertain');
});

test('a clear generation tombstone rejects delayed outbox persistence', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);
  const cleared = await background.request({
    type: 'vypode-state', action: 'clearAll', data: { accountId: 'user:alice', generation: 1 }
  });
  assert.equal(cleared.ok, true);
  const delayed = await background.request(outbox('late-arrival', 'watch', { slug: 'arrival', generation: 0 }));
  assert.equal(delayed.stale, true);
  assert.deepEqual(local.store.vypode_action_outbox_v1, {});
});

test('Clear All from another account carries dispatched actions as verification-only records', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);
  await background.request(activate('user:alice'));
  await background.request(outbox('alice-sent-watch', 'watch', { account: 'Alice', slug: 'arrival' }));
  await background.request({ type: 'vypode-state', action: 'outboxClaim', data: {
    id: 'alice-sent-watch', owner: 'alice-tab', leaseMs: 30000, account: 'Alice', generation: 0
  } });
  await background.request({ type: 'vypode-state', action: 'outboxMarkDispatched', data: {
    id: 'alice-sent-watch', owner: 'alice-tab'
  } });
  await background.request(activate('user:bob'));

  const cleared = await background.request({
    type: 'vypode-state', action: 'clearAll', data: { accountId: 'user:bob', generation: 1 }
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.dispatchedActions, 1);
  const carried = local.store.vypode_action_outbox_v1['alice-sent-watch'];
  assert.equal(carried.account, 'alice');
  assert.equal(carried.generation, 1);
  assert.ok(carried.dispatchedAt);
  assert.equal(carried.leaseOwner, null);
  assert.equal(carried.leaseExpiresAt, null);

  await background.request(activate('user:alice', 1));
  const duplicate = await background.request(outbox('alice-retry', 'watch', {
    account: 'Alice', slug: 'arrival', generation: 1
  }));
  assert.equal(duplicate.deduped, true);
  assert.ok(duplicate.record.dispatchedAt, 'the retry must remain verification-only');
});

test('clear fences stale writes while retaining only a redacted sent-review safety lock', async () => {
  const local = sharedLocal({
    vypode_action_outbox_v1: {
      'arrival:watch:1': {
        id: 'arrival:watch:1',
        filmUrl: 'https://letterboxd.com/film/arrival/',
        action: 'watch', slug: 'arrival', previousValue: false,
        account: 'alice', createdAt: '2026-01-01T00:00:00.000Z'
      }
    },
    vypode_review_drafts_v1: {
      'user:alice': { arrival: reviewDraft('arrival').data.draft }
    },
    vypode_action_outcomes_v1: { old: { status: 'success', at: new Date().toISOString() } },
    vypode_review_uncertain_v1: { 'user:alice': { arrival: {
      accountId: 'user:alice', slug: 'arrival', generation: 0, requestId: 'old-request',
      createdAt: new Date().toISOString(), reason: 'unknown'
    } } },
    vypode_user: { username: 'alice' }
  });
  const background = loadBackground(local);
  await background.request(activate());
  const cleared = await background.request({ type: 'vypode-state', action: 'clearAll', data: { accountId: 'user:alice', generation: 1 } });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.dispatchedReviews, 1);
  const stale = await background.request(merge('user:alice', 'arrival', 'watched'));
  assert.equal(stale.stale, true);
  assert.equal(local.store.vypode_state._meta.generation, 1);
  assert.deepEqual(local.store.vypode_state.accounts, {});
  assert.deepEqual(local.store.vypode_action_outbox_v1, {});
  assert.deepEqual(local.store.vypode_action_outcomes_v1, {});
  assert.deepEqual(local.store.vypode_review_drafts_v1, {});
  assert.equal(local.store.vypode_review_uncertain_v1['user:alice'].arrival.generation, 1);
  assert.equal(local.store.vypode_review_uncertain_v1['user:alice'].arrival.requestId, 'old-request');
  assert.equal(local.store.vypode_review_uncertain_v1['user:alice'].arrival.status, 'uncertain');
  assert.equal('reviewText' in local.store.vypode_review_uncertain_v1['user:alice'].arrival, false);
  assert.equal('csrf' in local.store.vypode_review_uncertain_v1['user:alice'].arrival, false);
  assert.equal(local.store.vypode_user, null);
  assert.equal(local.store.vypode_state._meta.activeAccount, '$legacy');
  const withoutSafetyLock = { ...local.store, vypode_review_uncertain_v1: {} };
  assert.equal(JSON.stringify(withoutSafetyLock).includes('alice'), false,
    'only the documented duplicate-prevention lock may retain an account identifier');
});

test('review drafts are serialized, isolated by account and film, and removable', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);
  await Promise.all([
    background.request(reviewDraft('arrival')),
    background.request(reviewDraft('moonlight', { rating: 0.5, reviewText: 'Half-star draft' })),
    background.request(reviewDraft('arrival', { reviewText: 'Bob draft' }, 'user:bob'))
  ]);

  const aliceArrival = await background.request({
    type: 'vypode-state', action: 'reviewDraftGet', data: { accountId: 'user:alice', slug: 'arrival', generation: 0 }
  });
  const bobArrival = await background.request({
    type: 'vypode-state', action: 'reviewDraftGet', data: { accountId: 'user:bob', slug: 'arrival', generation: 0 }
  });
  assert.equal(aliceArrival.draft.reviewText, 'Draft for arrival');
  assert.equal(bobArrival.draft.reviewText, 'Bob draft');
  assert.equal(local.store.vypode_review_drafts_v1['user:alice'].moonlight.rating, 0.5);

  await background.request({
    type: 'vypode-state', action: 'reviewDraftRemove', data: { accountId: 'user:alice', slug: 'arrival', generation: 0 }
  });
  assert.equal(local.store.vypode_review_drafts_v1['user:alice'].arrival, undefined);
  assert.equal(local.store.vypode_review_drafts_v1['user:bob'].arrival.reviewText, 'Bob draft');
});

test('a review draft after Clear All cannot choose the active account without fresh session verification', async () => {
  const local = sharedLocal();
  let calls = 0;
  const background = loadBackground(local, { fetch: async () => {
    calls += 1;
    return reviewResponse(200);
  } });
  await background.request(activate());
  const cleared = await background.request({
    type: 'vypode-state', action: 'clearAll', data: { accountId: 'user:alice', generation: 1 }
  });
  assert.equal(cleared.ok, true);
  assert.equal(local.store.vypode_state._meta.activeAccount, '$legacy',
    'clearing still forgets the saved account until the next explicit account-bound action');

  const savedDraft = reviewDraft('arrival', {
    revision: 1,
    updatedAt: '2026-01-02T00:00:00.000Z'
  });
  savedDraft.data.generation = 1;
  const saved = await background.request(savedDraft);
  assert.equal(saved.ok, true);
  assert.equal(local.store.vypode_state._meta.activeAccount, '$legacy');

  const blocked = await background.request(reviewSubmission({
    generation: 1,
    requestId: 'unverified-review-after-clear',
    draftRevision: 1
  }), reviewSender);
  assert.equal(blocked.code, 'context-changed');
  assert.equal(calls, 0);

  const activated = await background.request(activate('user:alice', 1));
  assert.equal(activated.ok, true);

  const submitted = await background.request(reviewSubmission({
    generation: 1,
    requestId: 'first-review-after-clear',
    draftRevision: 1
  }), reviewSender);
  assert.equal(submitted.confirmed, true);
  assert.equal(calls, 1);
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.arrival.reviewText, 'A careful review');
});

test('fresh account activation works when reset state contains one empty legacy account', async () => {
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 4, activeAccount: '$legacy' },
      accounts: {
        $legacy: { _meta: { version: 3 }, slugs: {} }
      }
    }
  });
  const background = loadBackground(local);
  const savedDraft = reviewDraft('arrival', { revision: 2 });
  savedDraft.data.generation = 4;

  const saved = await background.request(savedDraft);
  assert.equal(saved.ok, true);
  assert.equal(local.store.vypode_state._meta.activeAccount, '$legacy');

  const activated = await background.request(activate('user:alice', 4));
  assert.equal(activated.ok, true);
  assert.equal(local.store.vypode_state._meta.activeAccount, 'user:alice');
  assert.deepEqual(Object.keys(local.store.vypode_state.accounts).sort(), ['$legacy', 'user:alice']);
});

test('a review draft cannot replace a different active account', async () => {
  const local = sharedLocal();
  let calls = 0;
  const background = loadBackground(local, { fetch: async () => {
    calls += 1;
    return reviewResponse(200);
  } });
  await background.request(activate('user:bob'));
  await background.request(reviewDraft('arrival'));
  assert.equal(local.store.vypode_state._meta.activeAccount, 'user:bob');

  const submitted = await background.request(reviewSubmission({
    requestId: 'alice-draft-while-bob-active'
  }), reviewSender);
  assert.equal(submitted.code, 'context-changed');
  assert.equal(calls, 0);
});

test('review draft validation rejects unsafe and unbounded records without changing storage', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);
  const invalid = [
    reviewDraft('../account'),
    reviewDraft('arrival', { rating: 3.25 }),
    reviewDraft('arrival', { diaryDate: '2026-02-31' }),
    reviewDraft('arrival', { tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }),
    reviewDraft('arrival', { reviewText: 'x'.repeat(50001) }),
    reviewDraft('arrival', {}, '$legacy')
  ];
  for (const message of invalid) {
    const response = await background.request(message);
    assert.equal(response.ok, false);
    assert.match(response.error, /invalid/i);
  }
  assert.equal(local.store.vypode_review_drafts_v1, undefined);
});

test('review draft storage retains only the 100 newest valid records', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);
  for (let index = 0; index < 105; index += 1) {
    const day = String((index % 28) + 1).padStart(2, '0');
    await background.request(reviewDraft(`film-${index}`, {
      updatedAt: `2026-02-${day}T00:${String(index % 60).padStart(2, '0')}:00.000Z`
    }));
  }
  assert.equal(Object.keys(local.store.vypode_review_drafts_v1['user:alice']).length, 100);
});

test('a delayed older draft command cannot overwrite a newer lifecycle revision', async () => {
  const local = sharedLocal();
  const background = loadBackground(local);
  const newer = reviewDraft('arrival', {
    reviewText: 'Latest text at teardown',
    revision: 7,
    updatedAt: '2026-03-01T12:00:00.010Z'
  });
  const older = reviewDraft('arrival', {
    reviewText: 'Earlier autosave text',
    revision: 6,
    updatedAt: '2026-03-01T12:00:00.000Z'
  });

  await background.request(newer);
  await background.request(older);
  assert.equal(local.store.vypode_review_drafts_v1['user:alice'].arrival.reviewText, 'Latest text at teardown');
  assert.equal(local.store.vypode_review_drafts_v1['user:alice'].arrival.revision, 7);
});

test('review submission bridge validates its sender and uses the exact credentialed API endpoint', async () => {
  const local = sharedLocal();
  const calls = [];
  const background = loadBackground(local, { fetch: async (url, options) => {
    calls.push({ url, options });
    return reviewResponse(201);
  } });
  await background.request(activate());
  await background.request(reviewDraft('arrival'));

  const rejected = await background.request(reviewSubmission(), {
    frameId: 1,
    tab: { url: 'https://letterboxd.com/film/arrival/' }
  });
  assert.equal(rejected.ok, false);
  assert.equal(calls.length, 0);

  const result = await background.request(reviewSubmission(), reviewSender);
  assert.equal(result.confirmed, true);
  assert.equal(result.status, 201, 'any verified 2xx response is a success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.letterboxd.com/api/v0/production-log-entries');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers['X-CSRF-TOKEN'], 'csrf-token');
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.arrival.reviewText, 'A careful review');
  assert.equal(local.store.vypode_review_drafts_v1['user:alice'], undefined,
    'the worker clears the exact submitted draft even if the content tab goes away');
});

test('review bridge permits only one concurrent account-film submission', async () => {
  const local = sharedLocal();
  let releaseFetch;
  const fetchStarted = new Promise(resolve => { releaseFetch = resolve; });
  let calls = 0;
  const background = loadBackground(local, { fetch: async () => {
    calls++;
    return await fetchStarted;
  } });
  await background.request(activate());
  const first = background.request(reviewSubmission({ requestId: 'request-one' }), reviewSender);
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 0));
  const second = await background.request(reviewSubmission({ requestId: 'request-two' }), reviewSender);
  assert.equal(second.busy, true);
  assert.equal(calls, 1);
  releaseFetch(reviewResponse(200));
  assert.equal((await first).confirmed, true);
});

test('a confirmed rewatch request id replays durably without a second POST', async () => {
  const local = sharedLocal();
  let calls = 0;
  const rewatchPayload = clone(reviewSubmission().data.payload);
  rewatchPayload.diaryDetails.rewatch = true;
  const responseBody = JSON.parse(await reviewResponse().text());
  responseBody.logEntry.diaryDetails.rewatch = true;
  const background = loadBackground(local, { fetch: async () => {
    calls += 1;
    return reviewResponse(200, responseBody);
  } });
  await background.request(activate());
  const request = reviewSubmission({ requestId: 'durable-rewatch-request', payload: rewatchPayload });
  const first = await background.request(request, reviewSender);
  const replay = await background.request(request, reviewSender);
  assert.equal(first.confirmed, true);
  assert.equal(replay.confirmed, true);
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
  assert.equal(local.store.vypode_review_submissions_v1['durable-rewatch-request'].status, 'confirmed');
});

test('Clear All carries an in-flight review lock into the new generation and blocks a duplicate POST', async () => {
  const local = sharedLocal();
  let calls = 0;
  let releaseFirst;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  const background = loadBackground(local, { fetch: async () => {
    calls += 1;
    if (calls === 1) {
      startedResolve();
      return await firstResponse;
    }
    return reviewResponse(200);
  } });
  await background.request(activate());
  const pending = background.request(reviewSubmission({ requestId: 'sent-before-clear' }), reviewSender);
  await started;
  const cleared = await background.request({
    type: 'vypode-state', action: 'clearAll', data: { accountId: 'user:alice', generation: 1 }
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.dispatchedReviews, 1);
  const marker = local.store.vypode_review_uncertain_v1['user:alice'].arrival;
  assert.equal(marker.generation, 1);
  assert.equal(marker.requestId, 'sent-before-clear');
  assert.equal('reviewText' in marker, false);
  assert.equal('csrf' in marker, false);

  releaseFirst(reviewResponse(200));
  await pending;
  await background.request(activate('user:alice', 1));
  const duplicate = await background.request(reviewSubmission({
    generation: 1,
    requestId: 'retry-after-clear'
  }), reviewSender);
  assert.equal(duplicate.code, 'uncertain-review');
  assert.equal(calls, 1);
});

test('worker blocks a stale fresh-film editor after another tab creates the first diary entry', async () => {
  const local = sharedLocal();
  let calls = 0;
  const background = loadBackground(local, { fetch: async () => {
    calls++;
    return reviewResponse(200);
  } });
  await background.request(activate());
  const first = await background.request(reviewSubmission({ requestId: 'first-tab' }), reviewSender);
  assert.equal(first.confirmed, true);
  const staleSecond = await background.request(reviewSubmission({ requestId: 'stale-second-tab' }), reviewSender);
  assert.equal(staleSecond.code, 'existing-log');
  assert.equal(calls, 1, 'the stale second editor must be rejected before a second POST');

  const rewatchPayload = clone(reviewSubmission().data.payload);
  rewatchPayload.diaryDetails.rewatch = true;
  const allowed = await background.request(reviewSubmission({
    requestId: 'explicit-rewatch',
    payload: rewatchPayload
  }), reviewSender);
  // The canned response says rewatch:false, so strict verification leaves the
  // deliberately dispatched request uncertain rather than claiming success.
  assert.equal(allowed.uncertain, true);
  assert.equal(calls, 2);
});

test('an uncertain dispatched review persists a lock and cannot be retried until explicitly resolved', async () => {
  const local = sharedLocal();
  let calls = 0;
  let fail = true;
  const background = loadBackground(local, { fetch: async () => {
    calls++;
    if (fail) throw new Error('connection dropped');
    return reviewResponse(200);
  } });
  await background.request(activate());
  const first = await background.request(reviewSubmission({ requestId: 'uncertain-one' }), reviewSender);
  assert.equal(first.uncertain, true);
  assert.equal(first.blocked, true);
  assert.equal(local.store.vypode_review_uncertain_v1['user:alice'].arrival.requestId, 'uncertain-one');

  fail = false;
  const blocked = await background.request(reviewSubmission({ requestId: 'uncertain-two' }), reviewSender);
  assert.equal(blocked.code, 'uncertain-review');
  assert.equal(calls, 1, 'a retry cannot dispatch while its uncertain marker exists');
  const status = await background.request({ type: 'vypode-review', action: 'getUncertain', data: {
    accountId: 'user:alice', generation: 0, slug: 'arrival'
  } }, reviewSender);
  assert.equal(status.blocked, true);

  const resolved = await background.request({ type: 'vypode-review', action: 'resolveUncertain', data: {
    accountId: 'user:alice', generation: 0, slug: 'arrival', markerRequestId: status.markerToken
  } }, reviewSender);
  assert.equal(resolved.ok, true);
  const confirmed = await background.request(reviewSubmission({ requestId: 'after-explicit-check' }), reviewSender);
  assert.equal(confirmed.confirmed, true);
  assert.equal(calls, 2);
});

test('an older panel cannot clear a newer uncertain review marker', async () => {
  const local = sharedLocal();
  const background = loadBackground(local, { fetch: async () => { throw new Error('connection lost'); } });
  await background.request(activate());
  const first = await background.request(reviewSubmission({ requestId: 'old-marker' }), reviewSender);
  assert.equal(first.markerToken, 'old-marker');
  const cleared = await background.request({ type: 'vypode-review', action: 'resolveUncertain', data: {
    accountId: 'user:alice', generation: 0, slug: 'arrival', markerRequestId: 'old-marker'
  } }, reviewSender);
  assert.equal(cleared.ok, true);

  const second = await background.request(reviewSubmission({ requestId: 'new-marker' }), reviewSender);
  assert.equal(second.markerToken, 'new-marker');
  const staleClear = await background.request({ type: 'vypode-review', action: 'resolveUncertain', data: {
    accountId: 'user:alice', generation: 0, slug: 'arrival', markerRequestId: 'old-marker'
  } }, reviewSender);
  assert.equal(staleClear.ok, false);
  assert.equal(staleClear.code, 'marker-changed');
  assert.equal(staleClear.markerToken, 'new-marker');
  assert.equal(local.store.vypode_review_uncertain_v1['user:alice'].arrival.requestId, 'new-marker');
});

test('only an explicit structured rejection is retryable after a non-2xx review response', async () => {
  for (const scenario of [
    {
      name: 'structured rejection',
      response: reviewResponse(400, { messages: [{ type: 'Error', text: 'Review is not allowed' }] }),
      uncertain: false
    },
    {
      name: 'unexplained server failure',
      response: reviewResponse(500, { message: 'server failed' }),
      uncertain: true
    },
    {
      name: 'invalid server body',
      response: {
        status: 500,
        ok: false,
        headers: { get: () => null },
        async text() { return '<html>unknown</html>'; }
      },
      uncertain: true
    }
  ]) {
    const local = sharedLocal();
    const background = loadBackground(local, { fetch: async () => scenario.response });
    await background.request(activate());
    const result = await background.request(reviewSubmission({ requestId: `non-2xx-${scenario.name}` }), reviewSender);
    assert.equal(result.uncertain, scenario.uncertain, scenario.name);
    assert.equal(Boolean(local.store.vypode_review_uncertain_v1?.['user:alice']?.arrival), scenario.uncertain, scenario.name);
  }
});

test('confirmed review preserves a newer draft revision written while the request is in flight', async () => {
  const local = sharedLocal();
  let resolveFetch;
  const responsePending = new Promise(resolve => { resolveFetch = resolve; });
  const background = loadBackground(local, { fetch: async () => await responsePending });
  await background.request(activate());
  await background.request(reviewDraft('arrival'));
  const submission = background.request(reviewSubmission({ requestId: 'edit-race' }), reviewSender);
  await new Promise(resolve => setTimeout(resolve, 0));
  await background.request(reviewDraft('arrival', {
    reviewText: 'Newer edits while submitting',
    revision: 1,
    updatedAt: '2026-01-02T00:00:01.000Z'
  }));
  resolveFetch(reviewResponse(200));
  const result = await submission;
  assert.equal(result.confirmed, true);
  assert.equal(result.draftCleared, false);
  assert.equal(result.newerDraft, true);
  assert.equal(local.store.vypode_review_drafts_v1['user:alice'].arrival.reviewText, 'Newer edits while submitting');
});

test('future-version state is rejected without downgrade writes', async () => {
  const futureRoot = {
    _meta: { version: 4, generation: 9, activeAccount: 'user:alice' },
    accounts: { 'user:alice': { _meta: { version: 4 }, slugs: { arrival: { watched: true } } } }
  };
  const local = sharedLocal({ vypode_state: futureRoot });
  const background = loadBackground(local);
  const result = await background.request(merge('user:alice', 'arrival', 'liked'));
  assert.equal(result.ok, false);
  assert.match(result.error, /newer extension/i);
  assert.deepEqual(local.store.vypode_state, futureRoot);
});

test('metadata-only snapshots cannot clear a separately-timestamped flag', async () => {
  const local = sharedLocal({
    vypode_state: {
      _meta: { version: 3, generation: 0, activeAccount: 'user:alice' },
      accounts: {
        'user:alice': {
          _meta: { version: 3 },
          slugs: {
            arrival: {
              watched: true,
              watchedChangedAt: '2024-01-01T00:00:00.000Z',
              watchedSource: 'userAction',
              updatedAt: '2024-01-01T00:00:00.000Z'
            }
          }
        }
      }
    }
  });
  const background = loadBackground(local);
  const response = await background.request({
    type: 'vypode-state', action: 'mergeAccount', data: {
      accountId: 'user:alice', generation: 0,
      meta: { updatedAt: '2026-01-01T00:00:00.000Z' },
      slugs: {
        arrival: {
          title: 'Arrival', metadataUpdatedAt: '2026-01-01T00:00:00.000Z',
          metadataSource: 'domSync', source: 'domSync', updatedAt: '2026-01-01T00:00:00.000Z'
        }
      }
    }
  });

  assert.equal(response.ok, true);
  assert.equal(local.store.vypode_state.accounts['user:alice'].slugs.arrival.watched, true);
});
