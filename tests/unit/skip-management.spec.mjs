import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clone,
  createFilmStateRuntime,
  createStorageArea,
  plain
} from '../helpers/film-state-runtime.mjs';

function account(slugs) {
  return { _meta: { version: 3 }, slugs };
}

function v3(accounts, activeAccount = 'user:alice') {
  return {
    vypode_state: {
      _meta: { version: 3, generation: 0, activeAccount },
      accounts
    }
  };
}

test('getSkipped returns only the active account skipped films and handles an empty result', async () => {
  const runtime = createFilmStateRuntime(v3({
    'user:alice': account({
      zed: { title: 'Zed', skipped: true },
      arrival: { title: 'Arrival', skipped: true },
      watched: { title: 'Watched', watched: true }
    }),
    'user:bob': account({ hidden: { title: 'Another account', skipped: true } })
  }));
  await runtime.api.init('Alice');

  assert.deepEqual(plain(runtime.api.getSkipped().map(film => film.slug)), ['arrival', 'zed']);
  assert.deepEqual(plain(runtime.api.getSkipped({ search: 'missing' })), []);

  await runtime.api.switchAccount('Bob');
  assert.deepEqual(plain(runtime.api.getSkipped().map(film => film.slug)), ['hidden']);
});

test('restoreSkipped restores exactly one film, preserves other flags, and makes it deck-eligible', async () => {
  const runtime = createFilmStateRuntime(v3({
    'user:alice': account({
      one: { title: 'One', skipped: true, ratingValue: 4.5, reviewText: 'Keep this' },
      two: { title: 'Two', skipped: true, watchlist: true },
      three: { title: 'Three', skipped: true }
    })
  }));
  await runtime.api.init('Alice');

  assert.equal(runtime.api.shouldExclude('one'), true);
  assert.equal(await runtime.api.restoreSkipped('one'), true);
  assert.equal(runtime.api.get('one').skipped, false);
  assert.equal(runtime.api.get('one').ratingValue, 4.5, 'unrelated film state is preserved');
  assert.equal(runtime.api.get('one').reviewText, 'Keep this');
  assert.equal(runtime.api.get('two').skipped, true, 'other skipped films remain skipped');
  assert.equal(runtime.api.getStats().skipped, 2);
  assert.equal(runtime.api.shouldExclude('one'), false, 'restored film is eligible under the default deck filters');
  assert.equal(runtime.localStore.vypode_state.accounts['user:alice'].slugs.one.skipped, false);
  assert.equal(runtime.localStore.vypode_state.accounts['user:alice'].slugs.one.skippedSource, 'userAction');
});

test('restoreSkipped returns false without writing for zero skips or invalid slugs', async () => {
  const runtime = createFilmStateRuntime(v3({
    'user:alice': account({ arrival: { title: 'Arrival', watched: true } })
  }));
  await runtime.api.init('Alice');
  const before = JSON.stringify(runtime.localStore.vypode_state);

  assert.equal(await runtime.api.restoreSkipped('arrival'), false);
  assert.equal(await runtime.api.restoreSkipped('__proto__'), false);
  assert.equal(await runtime.api.restoreSkipped('missing'), false);
  assert.equal(JSON.stringify(runtime.localStore.vypode_state), before);
});

test('single-film restore remains account-scoped and propagates through storage changes', async () => {
  const local = createStorageArea(v3({
    'user:alice': account({ shared: { title: 'Alice film', skipped: true } }),
    'user:bob': account({ shared: { title: 'Bob film', skipped: true } })
  }));
  const sharedAreas = { local, sync: createStorageArea() };
  const tabA = createFilmStateRuntime({}, {}, sharedAreas);
  const tabB = createFilmStateRuntime({}, {}, sharedAreas);
  await tabA.api.init('Alice');
  await tabB.api.init('Alice');

  const oldValue = clone(local.store.vypode_state);
  assert.equal(await tabA.api.restoreSkipped('shared'), true);
  const newValue = clone(local.store.vypode_state);
  tabB.emitStorageChange({ vypode_state: { oldValue, newValue } });

  assert.equal(tabB.api.get('shared').skipped, false, 'another tab receives the restored flag');
  assert.equal(newValue.accounts['user:bob'].slugs.shared.skipped, true, 'another account remains untouched');
  await tabA.api.switchAccount('Bob');
  assert.equal(tabA.api.get('shared').skipped, true);
  assert.equal(await tabA.api.restoreSkipped('shared', 'user:alice'), false, 'a stale account-bound control is rejected');
  assert.equal(tabA.api.get('shared').skipped, true);
});

test('a failed restore write rolls the optimistic flag back so the UI can retry honestly', async () => {
  const local = createStorageArea(v3({
    'user:alice': account({ arrival: { title: 'Arrival', skipped: true } })
  }));
  const runtime = createFilmStateRuntime({}, {}, { local, sync: createStorageArea() });
  await runtime.api.init('Alice');
  local.set = () => { throw new Error('disk full'); };

  await assert.rejects(runtime.api.restoreSkipped('arrival'), /disk full/);
  assert.equal(runtime.api.get('arrival').skipped, true);
  assert.equal(runtime.api.getStats().skipped, 1);
  assert.match(runtime.api.getLastStorageError(), /disk full/);
});

test('restore failure rolls back a replacement registry record but preserves a newer storage change', async () => {
  async function runFailureScenario(newerExternalChange) {
    const local = createStorageArea(v3({
      'user:alice': account({ arrival: {
        title: 'Arrival',
        skipped: true,
        skippedChangedAt: '2025-01-01T00:00:00.000Z',
        skippedSource: 'userAction'
      } })
    }));
    let rejectWrite;
    const runtime = createFilmStateRuntime({}, {}, {
      local,
      sync: createStorageArea(),
      sendMessage(message) {
        if (message.action !== 'mergeAccount') return undefined;
        return new Promise((resolve, reject) => { rejectWrite = reject; });
      }
    });
    await runtime.api.init('Alice');

    const pending = runtime.api.restoreSkipped('arrival');
    await new Promise(resolve => setTimeout(resolve, 0));
    const optimisticAt = runtime.api.get('arrival').skippedChangedAt;
    const externalAt = newerExternalChange
      ? new Date(new Date(optimisticAt).getTime() + 1000).toISOString()
      : optimisticAt;
    const replacement = v3({
      'user:alice': account({ arrival: {
        title: 'Arrival',
        skipped: false,
        skippedAt: null,
        skippedChangedAt: externalAt,
        skippedSource: 'userAction',
        updatedAt: externalAt
      } })
    }).vypode_state;
    replacement._meta.generation = 1;
    runtime.emitStorageChange({
      vypode_state: { oldValue: clone(local.store.vypode_state), newValue: replacement }
    });
    rejectWrite(new Error('worker write failed'));
    await assert.rejects(pending, /worker write failed/);
    return { runtime, externalAt };
  }

  const matching = await runFailureScenario(false);
  assert.equal(matching.runtime.api.get('arrival').skipped, true, 'the failed optimistic restore is rolled back on the replacement object');

  const newer = await runFailureScenario(true);
  assert.equal(newer.runtime.api.get('arrival').skipped, false, 'a newer external restore wins');
  assert.equal(newer.runtime.api.get('arrival').skippedChangedAt, newer.externalAt);
});
