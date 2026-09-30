// Moving the autosave out of localStorage and into the browser record store.
//
// The promise the migration makes is that the recovery copy is never in one
// place only: the old `idef0-modeler:autosave` key is removed after the new
// store has been written AND read back with the same bytes, and not before.
// Every case below is a fresh module, because the store is opened once and
// remembered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../sync-kit/js/stores/memory.js';

const LEGACY = 'idef0-modeler:autosave';
const LEGACY_CORRUPT = 'idef0-modeler:autosave.corrupt';
const META = 'idef0.autosave';
const META_CORRUPT = 'idef0.autosave.corrupt';

let seq = 0;
/** A fresh localStore module over a fresh localStorage, with `store` injected. */
async function load(entries = {}, store = new MemoryStore('test')) {
  const memory = new Map(Object.entries(entries));
  globalThis.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => { memory.set(k, String(v)); },
    removeItem: (k) => { memory.delete(k); },
  };
  seq += 1;
  const mod = await import(`../../src/state/localStore.js?case=${seq}`);
  mod.setLocalStore(store);
  return { mod, memory, store };
}

const AUTOSAVE = JSON.stringify({ at: 1700000000000, fileName: 'x.idef0.json', model: { title: 'Kept' } });

test('the names carry the idef0 prefix', async () => {
  const { mod } = await load();
  assert.equal(mod.DB_NAME, 'idef0-modeler');
  assert.equal(mod.AUTOSAVE_META, META);
  assert.equal(mod.QUARANTINE_META, META_CORRUPT);
});

test('opening the store migrates the old key and then removes it', async () => {
  const { mod, memory, store } = await load({ [LEGACY]: AUTOSAVE });
  const opened = await mod.localStore();
  assert.equal(opened, store, 'the injected store is the one used');
  assert.equal(await store.meta(META), AUTOSAVE, 'the raw text, byte for byte');
  assert.equal(memory.has(LEGACY), false, 'only now is the old key gone');
});

test('the old key survives a store that does not keep what it was given', async () => {
  // A full disk, a blocked origin, an eviction between the write and the read:
  // whatever the reason, the copy in localStorage is the only one left and
  // must stay.
  const dropping = new MemoryStore('dropping');
  dropping.setMeta = async () => {};
  const { mod, memory } = await load({ [LEGACY]: AUTOSAVE }, dropping);
  await mod.localStore();
  assert.equal(await dropping.meta(META), null);
  assert.equal(memory.get(LEGACY), AUTOSAVE, 'the recovery copy is still somewhere');
});

test('a partial write is retried on the next launch', async () => {
  const store = new MemoryStore('retry');
  const broken = async () => {};
  store.setMeta = broken;
  const first = await load({ [LEGACY]: AUTOSAVE }, store);
  await first.mod.localStore();
  assert.equal(first.memory.get(LEGACY), AUTOSAVE);

  delete store.setMeta;                        // the disk is well again
  const second = await load({ [LEGACY]: AUTOSAVE }, store);
  await second.mod.localStore();
  assert.equal(await store.meta(META), AUTOSAVE);
  assert.equal(second.memory.has(LEGACY), false);
});

test('a store that already holds a copy makes the old key the stale one', async () => {
  const store = new MemoryStore('already');
  const newer = JSON.stringify({ at: 1800000000000, fileName: null, model: { title: 'Newer' } });
  await store.setMeta(META, newer);
  const { mod, memory } = await load({ [LEGACY]: AUTOSAVE }, store);
  await mod.localStore();
  assert.equal(await store.meta(META), newer, 'the newer copy is not overwritten');
  assert.equal(memory.has(LEGACY), false);
});

test('the quarantined copy travels with the live one', async () => {
  const { mod, memory, store } = await load({ [LEGACY]: AUTOSAVE, [LEGACY_CORRUPT]: '{not json' });
  await mod.localStore();
  assert.equal(await store.meta(META_CORRUPT), '{not json');
  assert.equal(memory.size, 0, 'localStorage keeps no autosave of either kind');
});

test('nothing to migrate writes nothing', async () => {
  const { mod, store } = await load({ 'idef0-modeler:persistence.asked': '1' });
  await mod.localStore();
  assert.equal(await store.meta(META), null);
  assert.equal(globalThis.localStorage.getItem('idef0-modeler:persistence.asked'), '1', 'a setting is left alone');
});

test('a store that will not open leaves the app running', async () => {
  const refuses = new MemoryStore('refuses');
  refuses.open = async () => { throw new Error('blocked'); };
  const { mod } = await load({ [LEGACY]: AUTOSAVE }, refuses);
  assert.equal(await mod.localStore(), null, 'null, rather than a rejection nobody can act on');
});
