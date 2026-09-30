// The browser's own copy of the workspace: one IndexedDB database, opened
// once and shared.
//
// Everything this app keeps in the browser lives here — the sync corpus (the
// model records and the repositories that group them) in the store's records,
// and the recovery copy of unsaved work in its small key/value space. The
// store itself is sync-kit's `IndexedDbStore`, which is what the sync engine
// reads and writes, so the autosave and the records the cloud sees are one
// database rather than two stores that could disagree about which copy is
// newer.
//
// Why the autosave is *meta* rather than a record: a record is, by definition,
// the thing the engine pushes — it sends everything the store reports as
// changed with this device's `origin`, with no way to hold one back — and a
// recovery copy of a half-finished edit has no business travelling to a
// server or to another machine. The key/value space is the part of the store
// the engine only reads its own cursors out of, so a value put there stays on
// this device. What does travel is what the modeller saves, which is the
// record `src/sync/records.js` builds.
//
// localStorage keeps only what it is good for after this: the settings, the
// device id and the theme. The autosave that used to live there is moved
// across once, carefully — see `migrateLegacyAutosave`.

import { IndexedDbStore } from '../../sync-kit/js/stores/idb.js';
import { MemoryStore } from '../../sync-kit/js/stores/memory.js';

/** The database, prefixed like every other name this app owns. */
export const DB_NAME = 'idef0-modeler';

/** Where the recovery copy and its quarantine live in the store's meta space. */
export const AUTOSAVE_META = 'idef0.autosave';
export const QUARANTINE_META = 'idef0.autosave.corrupt';

/** The localStorage keys the autosave used before this, migrated once. */
export const LEGACY_AUTOSAVE_KEY = 'idef0-modeler:autosave';
export const LEGACY_QUARANTINE_KEY = 'idef0-modeler:autosave.corrupt';

let injected = null;
let pending = null;
let opened = null;

/**
 * Use this store instead of opening IndexedDB — the seam the node tests come
 * in through, and the one an embedder could use to point the app at a store of
 * its own. Passing null goes back to the default.
 */
export function setLocalStore(store) {
  injected = store;
  opened = null;
  pending = null;
}

/**
 * The store, opened and migrated. Resolves to null only when there is no way
 * to keep anything at all, which the callers treat the way they always treated
 * a blocked localStorage: the app runs, the recovery copy does not exist.
 *
 * One promise is shared by every caller, so a launch that reads the autosave
 * while an edit is already scheduling one opens the database once.
 */
export function localStore() {
  if (opened) return Promise.resolve(opened);
  if (!pending) {
    pending = openStore().then(async (store) => {
      if (store) {
        try { await migrateLegacyAutosave(store); } catch { /* best effort, always */ }
      }
      opened = store;
      return store;
    }).catch(() => {
      // A database that will not open is not a reason to fail to start: the
      // app carries on with nothing kept, as it did in a private window.
      opened = null;
      pending = null;
      return null;
    });
  }
  return pending;
}

async function openStore() {
  if (injected) {
    await injected.open();
    return injected;
  }
  // No IndexedDB means node, or a browser that has walled it off. A Map keeps
  // the session coherent and loses it on reload, which is the honest outcome.
  const store = typeof indexedDB === 'undefined'
    ? new MemoryStore(DB_NAME)
    : new IndexedDbStore({ name: DB_NAME });
  await store.open();
  return store;
}

/**
 * Move the autosave out of localStorage, once.
 *
 * The rule the migration has to keep is that at no instant is the recovery
 * copy in one place only: the old key is removed after the new store has been
 * written *and* read back with the same bytes. A write that silently did not
 * land — a full disk, a store the browser is about to evict — leaves the old
 * key exactly where it was, and the next launch tries again.
 *
 * The value moved across is the raw text, not a re-serialized object, so what
 * the browser held is what the store holds.
 *
 * Returns the keys that were migrated, for the tests and for anyone debugging
 * a launch.
 */
export async function migrateLegacyAutosave(store) {
  const moved = [];
  for (const [legacy, key] of [[LEGACY_AUTOSAVE_KEY, AUTOSAVE_META], [LEGACY_QUARANTINE_KEY, QUARANTINE_META]]) {
    const raw = readLocal(legacy);
    if (raw == null) continue;
    // A store that already holds one has a copy at least as new as the key's;
    // the key is then the stale one and goes.
    if ((await store.meta(key)) == null) {
      await store.setMeta(key, raw);
      if ((await store.meta(key)) !== raw) continue;   // not written; keep the old key
    }
    removeLocal(legacy);
    moved.push(legacy);
  }
  return moved;
}

function readLocal(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function removeLocal(key) {
  try { globalThis.localStorage?.removeItem(key); } catch { /* a blocked store is not an error */ }
}
