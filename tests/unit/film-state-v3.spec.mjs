import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFilmStateRuntime,
  createStorageArea,
  plain,
  waitForDebounce
} from '../helpers/film-state-runtime.mjs';

function v2(slugs) {
  return { vypode_state: { _meta: { version: 2 }, slugs } };
}

test('v2 data migrates into the explicitly selected account', async () => {
  const runtime = createFilmStateRuntime(v2({ arrival: { title: 'Arrival', watched: true } }));
  await runtime.api.init('Alice_1');

  assert.equal(runtime.api.getAccountId(), 'user:alice_1');
  assert.equal(runtime.api.get('arrival').watched, true);
  assert.equal(runtime.localStore.vypode_state._meta.version, 3);
  assert.equal(runtime.localStore.vypode_state._meta.activeAccount, 'user:alice_1');
  assert.equal(runtime.localStore.vypode_state.accounts['user:alice_1'].slugs.arrival.title, 'Arrival');
});

test('switchAccount keeps independent registries for two Letterboxd users', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init('Alice');
  runtime.api.setFlag('arrival', 'watched', true, 'userAction');
  await waitForDebounce();

  await runtime.api.switchAccount('Bob');
  assert.equal(runtime.api.getStats().total, 0);
  runtime.api.setFlag('moonlight', 'liked', true, 'userAction');
  await waitForDebounce();

  await runtime.api.switchAccount('Alice');
  assert.equal(runtime.api.get('arrival').watched, true);
  assert.equal(runtime.api.get('moonlight'), null);

  await runtime.api.switchAccount('Bob');
  assert.equal(runtime.api.get('moonlight').liked, true);
  assert.equal(runtime.api.get('arrival'), null);
  assert.deepEqual(plain((await runtime.api.listAccounts()).map(account => account.id).sort()), ['user:alice', 'user:bob']);
});

test('cached user selects the matching account while an unowned legacy blob stays isolated', async () => {
  const cached = createFilmStateRuntime({
    ...v2({ stalker: { title: 'Stalker', watched: true } }),
    vypode_user: { username: 'CachedUser', active: false }
  });
  await cached.api.init();
  assert.equal(cached.api.getAccountId(), 'user:cacheduser');
  assert.equal(cached.api.get('stalker').watched, true);

  const unowned = createFilmStateRuntime(v2({ parasite: { title: 'Parasite' } }));
  await unowned.api.init();
  assert.equal(unowned.api.getAccountId(), '$legacy');
  await unowned.api.switchAccount('NewUser');
  assert.equal(unowned.api.getStats().total, 0);
  assert.equal(unowned.localStore.vypode_state.accounts.$legacy.slugs.parasite.title, 'Parasite');
});

test('a newer cross-tab clear adopts the legacy account and cancels a pending stale save', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init('Alice');
  runtime.api.updateFilm('arrival', { title: 'Arrival' }, 'domSync');

  const oldValue = runtime.localStore.vypode_state || {
    _meta: { version: 3, generation: 0, activeAccount: 'user:alice' },
    accounts: {}
  };
  const cleared = {
    _meta: { version: 3, generation: 1, activeAccount: '$legacy' },
    accounts: {}
  };
  runtime.localStore.vypode_state = cleared;
  runtime.localStore.vypode_user = null;
  runtime.emitStorageChange({
    vypode_state: { oldValue, newValue: cleared },
    vypode_user: { oldValue: { username: 'Alice', active: true }, newValue: null }
  });

  assert.equal(runtime.api.getAccountId(), '$legacy');
  assert.equal(runtime.api.get('arrival'), null);
  await waitForDebounce();
  assert.equal(runtime.sentMessages.some(message =>
    message.action === 'mergeAccount' && message.data.accountId === 'user:alice'
  ), false, 'the pending pre-clear debounce must not hand off Alice data');

  runtime.api.updateFilm('moonlight', { title: 'Moonlight' }, 'domSync');
  await runtime.api.flush();
  const lastMerge = runtime.sentMessages.filter(message => message.action === 'mergeAccount').at(-1);
  assert.equal(lastMerge?.data.accountId, '$legacy');
  assert.equal(lastMerge?.data.generation, 1);
});

test('imports validate every value before mutating the active account', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init('Alice');
  runtime.api.updateFilm('arrival', { title: 'Arrival', watched: true, watchedDate: '2024-01-01' }, 'collectionSync');

  const result = await runtime.api.importData(JSON.stringify({
    slugs: {
      arrival: { watched: false, watchedChangedAt: '2027-01-01T00:00:00.000Z', ratingValue: 6 },
      moonlight: { title: 'Moonlight', url: 'javascript:alert(1)' }
    },
    prefs: { excludeLiked: 'no' }
  }));

  assert.equal(result.success, false);
  assert.match(result.error, /Invalid rating value/);
  assert.equal(runtime.api.get('arrival').watched, true);
  assert.equal(runtime.api.get('moonlight'), null);
});

test('watchedAt never invents a diary watchedDate during migration, import, or updates', async () => {
  const runtime = createFilmStateRuntime(v2({ arrival: {
    watched: true, watchedAt: '2024-01-01T12:00:00.000Z', updatedAt: '2024-01-01T12:00:00.000Z'
  } }));
  await runtime.api.init();
  assert.equal(runtime.api.get('arrival').watchedDate, null);

  const result = await runtime.api.importData(JSON.stringify({ slugs: {
    moonlight: { watched: true, watchedAt: '2025-01-01T12:00:00.000Z', updatedAt: '2025-01-01T12:00:00.000Z' }
  } }));
  assert.equal(result.success, true, result.error);
  assert.equal(runtime.api.get('moonlight').watchedDate, null);
  runtime.api.updateFilm('arrival', { watched: true, watchedAt: '2026-01-01T12:00:00.000Z' }, 'collectionSync');
  assert.equal(runtime.api.get('arrival').watchedDate, null);
});

test('sync persists an exact diary date for a legacy watched flag without a flag timestamp', async () => {
  const runtime = createFilmStateRuntime(v2({ arrival: {
    title: 'Arrival', watched: true, source: 'collectionSync'
  } }));
  await runtime.api.init('Alice');

  runtime.api.bulkSetFromSync({
    arrival: { title: 'Arrival', watched: true, watchedDate: '2024-04-03' }
  }, 'collectionSync');
  await runtime.api.flush();

  assert.equal(runtime.api.get('arrival').watchedDate, '2024-04-03');
  assert.equal(
    runtime.localStore.vypode_state.accounts['user:alice'].slugs.arrival.watchedDate,
    '2024-04-03'
  );
});

test('import rejects impossible calendar dates', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init();

  const result = await runtime.api.importData(JSON.stringify({ slugs: {
    arrival: { watched: true, watchedDate: '2024-02-30' }
  } }));

  assert.equal(result.success, false);
  assert.equal(runtime.api.get('arrival'), null);
});

test('import rejects future schema versions and materially future dates without mutating state', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init('Alice');
  runtime.api.updateFilm('arrival', { title: 'Arrival', watched: true }, 'userAction');
  await runtime.api.flush();

  const newerSchema = await runtime.api.importData(JSON.stringify({
    _meta: { version: 4 },
    slugs: { moonlight: { title: 'Moonlight' } }
  }));
  assert.equal(newerSchema.success, false);
  assert.match(newerSchema.error, /requires a newer extension/);

  const futureTimestamp = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 72 * 60 * 60 * 1000);
  const futureDate = [future.getUTCFullYear(), String(future.getUTCMonth() + 1).padStart(2, '0'), String(future.getUTCDate()).padStart(2, '0')].join('-');
  const futureResult = await runtime.api.importData(JSON.stringify({ slugs: {
    moonlight: { title: 'Moonlight', updatedAt: futureTimestamp, watchedDate: futureDate }
  } }));
  assert.equal(futureResult.success, false);
  assert.match(futureResult.error, /future/);
  assert.equal(runtime.api.get('arrival').watched, true);
  assert.equal(runtime.api.get('moonlight'), null);
});

test('import enforces the public entry limit and account-generation binding before mutation', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init('Alice');
  const limits = runtime.api.getLimits();
  assert.equal(limits.importEntries, 20000);
  assert.equal(limits.importBytes, 64 * 1024 * 1024);

  const wrongContext = await runtime.api.importData(JSON.stringify({
    slugs: { arrival: { title: 'Arrival' } }
  }), { accountId: 'user:bob', generation: runtime.api.getMeta().rootGeneration });
  assert.equal(wrongContext.success, false);
  assert.equal(wrongContext.contextChanged, true);
  assert.equal(runtime.api.get('arrival'), null);

  const oversized = Object.create(null);
  for (let index = 0; index <= limits.importEntries; index += 1) oversized[`film-${index}`] = {};
  const tooMany = await runtime.api.importData(JSON.stringify({ slugs: oversized }));
  assert.equal(tooMany.success, false);
  assert.match(tooMany.error, /too many films/);
  assert.equal(runtime.api.getStats().total, 0);
});

test('import removes deceptive off-site film and poster URLs but preserves canonical trusted URLs', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init('Alice');

  const result = await runtime.api.importData(JSON.stringify({ slugs: {
    arrival: {
      title: 'Arrival',
      url: 'https://tracker.example/film/arrival/',
      poster: 'https://tracker.example/pixel.png',
      updatedAt: '2025-01-01T00:00:00.000Z'
    },
    moonlight: {
      title: 'Moonlight',
      url: 'https://letterboxd.com/film/moonlight/',
      poster: 'https://a.ltrbxd.com/resized/film-poster/1/2/3/123.jpg',
      updatedAt: '2025-01-01T00:00:00.000Z'
    }
  } }));

  assert.equal(result.success, true);
  assert.equal(runtime.api.get('arrival').url, null);
  assert.equal(runtime.api.get('arrival').poster, null);
  assert.equal(runtime.api.get('moonlight').url, 'https://letterboxd.com/film/moonlight/');
  assert.equal(runtime.api.get('moonlight').poster, 'https://a.ltrbxd.com/resized/film-poster/1/2/3/123.jpg');
});

test('metadata tombstones win over conflicting imported values and survive export/import', async () => {
  const cleared = ['title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl'];
  const runtime = createFilmStateRuntime();
  await runtime.api.init('Alice');
  const result = await runtime.api.importData(JSON.stringify({ slugs: {
    arrival: {
      title: 'Arrival', year: '2016', director: 'Denis Villeneuve', genres: ['Science Fiction'],
      poster: 'https://a.ltrbxd.com/resized/film-poster/1/2/3/123.jpg',
      url: 'https://letterboxd.com/film/arrival/', rating: '★★★★', ratingValue: 4,
      reviewText: 'old text', reviewUrl: 'https://letterboxd.com/example/film/arrival/',
      metadataCleared: cleared, metadataUpdatedAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    }
  } }));
  assert.equal(result.success, true);
  for (const key of cleared) assert.equal(runtime.api.get('arrival')[key], null, `${key} should remain cleared`);

  const restored = createFilmStateRuntime();
  await restored.api.init('Alice');
  const roundTrip = await restored.api.importData(runtime.api.exportData());
  assert.equal(roundTrip.success, true, roundTrip.error);
  for (const key of cleared) assert.equal(restored.api.get('arrival')[key], null, `${key} should round-trip as null`);
  assert.deepEqual(plain(restored.api.get('arrival').metadataCleared), cleared);
});

test('import rolls preferences back when the following local registry write fails', async () => {
  const local = createStorageArea();
  const sync = createStorageArea({ vypode_prefs: {
    excludeWatched: true, excludeLiked: true, excludeWatchlist: true, excludeSkipped: true, autoNextPage: false
  } });
  const originalLocalSet = local.set.bind(local);
  let localWrites = 0;
  local.set = (items, callback) => {
    localWrites += 1;
    if (localWrites === 2) throw new Error('forced local write failure');
    originalLocalSet(items, callback);
  };
  const runtime = createFilmStateRuntime({}, {}, { local, sync });
  await runtime.api.init('Alice');

  const result = await runtime.api.importData(JSON.stringify({
    slugs: { arrival: { title: 'Arrival', updatedAt: '2025-01-01T00:00:00.000Z' } },
    prefs: { excludeLiked: false }
  }));

  assert.equal(result.success, false);
  assert.match(result.error, /forced local write failure/);
  assert.equal(runtime.api.get('arrival'), null);
  assert.equal(runtime.api.getPrefs().excludeLiked, true);
  assert.equal(sync.store.vypode_prefs.excludeLiked, true);
});

test('import does not mutate the registry when preference persistence fails', async () => {
  const local = createStorageArea();
  const sync = createStorageArea({ vypode_prefs: {
    excludeWatched: true, excludeLiked: true, excludeWatchlist: true, excludeSkipped: true, autoNextPage: false
  } });
  sync.set = () => { throw new Error('forced preference write failure'); };
  const runtime = createFilmStateRuntime({}, {}, { local, sync });
  await runtime.api.init('Alice');

  const result = await runtime.api.importData(JSON.stringify({
    slugs: { arrival: { title: 'Arrival', updatedAt: '2025-01-01T00:00:00.000Z' } },
    prefs: { excludeLiked: false }
  }));

  assert.equal(result.success, false);
  assert.match(result.error, /forced preference write failure/);
  assert.equal(runtime.api.get('arrival'), null);
  assert.equal(runtime.api.getPrefs().excludeLiked, true);
  assert.equal(sync.store.vypode_prefs.excludeLiked, true);
});

test('import resolves offset timestamps by instant and keeps a user action on an exact tie', async () => {
  const runtime = createFilmStateRuntime(v2({ arrival: {
    watched: true,
    watchedChangedAt: '2026-01-01T00:00:00+10:00',
    watchedSource: 'userAction',
    updatedAt: '2026-01-01T00:00:00+10:00'
  } }));
  await runtime.api.init();

  const newer = await runtime.api.importData(JSON.stringify({ slugs: {
    arrival: {
      watched: false,
      watchedChangedAt: '2025-12-31T15:00:00.000Z',
      updatedAt: '2025-12-31T15:00:00.000Z'
    }
  } }));
  assert.equal(newer.success, true);
  assert.equal(runtime.api.get('arrival').watched, false);

  runtime.api.setFlag('arrival', 'watched', true, 'userAction');
  const tiedAt = runtime.api.get('arrival').watchedChangedAt;
  const tied = await runtime.api.importData(JSON.stringify({ slugs: {
    arrival: { watched: false, watchedChangedAt: tiedAt, updatedAt: tiedAt }
  } }));
  assert.equal(tied.success, true);
  assert.equal(runtime.api.get('arrival').watched, true);
});

test('a metadata-only stale snapshot preserves separately stored flags', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init('Alice');
  runtime.localStore.vypode_state = {
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
  };

  runtime.api.updateFilm('arrival', { title: 'Arrival' }, 'domSync');
  await runtime.api.flush();
  assert.equal(runtime.localStore.vypode_state.accounts['user:alice'].slugs.arrival.watched, true);
});

test('per-flag provenance controls reconciliation and survives an external state change', async () => {
  const runtime = createFilmStateRuntime();
  await runtime.api.init();
  runtime.api.setFlag('arrival', 'watched', true, 'userAction');
  runtime.api.setFlag('arrival', 'liked', true, 'collectionSync');
  assert.equal(runtime.api.reconcileFlags({ watched: new Set(), liked: new Set(), watchlist: new Set() }, 'collectionSync'), 1);
  assert.equal(runtime.api.get('arrival').watched, true);
  assert.equal(runtime.api.get('arrival').liked, false);

  const replacement = {
    _meta: { version: 3, generation: 1, activeAccount: '$legacy' },
    accounts: { $legacy: { _meta: { version: 3 }, slugs: { arrival: {
      watched: true, watchedChangedAt: '2027-01-01T00:00:00.000Z', watchedSource: 'collectionSync'
    } } } }
  };
  runtime.emitStorageChange({ vypode_state: { oldValue: runtime.localStore.vypode_state, newValue: replacement } });
  assert.equal(runtime.api.get('arrival').watchedSource, 'collectionSync');
});

test('init may be retried after a storage failure and flush propagates later write failures', async () => {
  const local = createStorageArea();
  const originalGet = local.get;
  let failFirstGet = true;
  local.get = (keys, callback) => {
    if (failFirstGet) {
      failFirstGet = false;
      throw new Error('temporary read failure');
    }
    originalGet(keys, callback);
  };
  const runtime = createFilmStateRuntime({}, {}, { local, sync: createStorageArea() });
  await assert.rejects(runtime.api.init(), /temporary read failure/);
  await runtime.api.init();

  const originalSet = local.set;
  local.set = () => { throw new Error('disk full'); };
  runtime.api.setFlag('arrival', 'watched', true, 'userAction');
  await assert.rejects(runtime.api.flush(), /disk full/);
  local.set = originalSet;
});
