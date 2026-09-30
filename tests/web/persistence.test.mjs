// Asking the browser to keep this app's data, and what the app says when it
// will not. Nothing here may throw, and nothing may block.
//
// The asking is the sync kit's `requestPersistentStorage`/`storageStatus`, so
// the fake `navigator.storage` below is what the kit reads: `persisted()`,
// `persist()` and the `estimate()` the kit needs before it will answer at all.

import test from 'node:test';
import assert from 'node:assert/strict';

function defineNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

/** A fresh module per case: the answer is cached, which is the point of it. */
async function load({ persisted, persist, userAgent = 'Chrome', store = new Map(), throws = false, usage = 4096, quota = 1048576 }) {
  const memory = store;
  globalThis.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  };
  // Node ships its own read-only `navigator`, so it is replaced rather than
  // assigned to.
  defineNavigator({
    userAgent,
    maxTouchPoints: 0,
    storage: persisted === undefined ? undefined : {
      persisted: async () => { if (throws) throw new Error('private window'); return persisted; },
      estimate: async () => ({ usage, quota }),
      ...(persist === undefined ? {} : { persist: async () => persist }),
    },
  });
  const mod = await import(`../../src/state/persistence.js?case=${Math.random()}`);
  return { mod, memory };
}

test('a browser that already keeps the data is not asked again', async () => {
  const { mod, memory } = await load({ persisted: true, persist: false });
  assert.equal(await mod.requestPersistence(), 'persisted');
  assert.equal(mod.persistenceState().state, 'persisted');
  assert.equal(mod.persistenceAdvice('persisted'), null, 'nothing to advise');
  assert.equal(memory.size, 0, 'no need to remember having asked');
});

test('the bytes the browser reports come back with the answer', async () => {
  const { mod } = await load({ persisted: true, usage: 8192, quota: 2097152 });
  await mod.requestPersistence();
  const state = mod.persistenceState();
  assert.equal(state.usage, 8192, 'what the kit read from estimate()');
  assert.equal(state.quota, 2097152);
});

test('a browser with no Storage API at all reports unknown, not at risk', async () => {
  const { mod } = await load({ persisted: undefined });
  assert.equal(await mod.requestPersistence(), 'unknown');
  assert.equal(mod.persistenceState().usage, null);
});

test('a granted request reads as persisted', async () => {
  const { mod, memory } = await load({ persisted: false, persist: true });
  assert.equal(await mod.requestPersistence(), 'persisted');
  assert.equal(memory.get('idef0-modeler:persistence.asked'), '1');
});

test('a refused request reads as at risk, with advice, and is not repeated', async () => {
  const shared = new Map();
  const first = await load({ persisted: false, persist: false, store: shared });
  assert.equal(await first.mod.requestPersistence(), 'at-risk');
  assert.match(first.mod.persistenceAdvice(), /Install the app/);

  let asked = 0;
  globalThis.navigator.storage.persist = async () => { asked += 1; return false; };
  const again = await load({ persisted: false, persist: false, store: shared });
  globalThis.navigator.storage.persist = async () => { asked += 1; return false; };
  assert.equal(await again.mod.requestPersistence(), 'at-risk');
  assert.equal(asked, 0, 'the same person is not prompted on every launch');
  assert.equal(await again.mod.requestPersistence({ force: true }), 'at-risk');
  assert.equal(asked, 1, 'turning sync on may ask again');
});

test('an iPhone is told about the Home Screen, not a browser menu', async () => {
  const { mod } = await load({ persisted: false, persist: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
  await mod.requestPersistence();
  assert.match(mod.persistenceAdvice(), /Home Screen/);
});

test('a browser without the API, or one that throws, never breaks the app', async () => {
  const none = await load({ persisted: undefined });
  assert.equal(await none.mod.requestPersistence(), 'unknown');
  assert.equal(none.mod.persistenceState().supported, false);

  const priv = await load({ persisted: false, throws: true });
  assert.equal(await priv.mod.requestPersistence(), 'at-risk');
});

test('initPersistence hands the answer back without being awaited', async () => {
  const { mod } = await load({ persisted: true });
  const state = await new Promise((resolve) => mod.initPersistence(resolve));
  assert.equal(state, 'persisted');
});
