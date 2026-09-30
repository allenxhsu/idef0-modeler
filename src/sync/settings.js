// The three settings a sync client needs, and this device's name.
//
// These are the things that genuinely belong in localStorage: a device id that
// must survive the store being evicted (it is what breaks a tie between two
// writes in the same millisecond, so a device that forgot its own name would
// start losing them), and the URL, token and on/off switch that say where to
// sync. No model data, no records — those are in the browser store now.
//
// Under the Portal none of the URL and token is used: the remote comes from
// `portalRemote('idef0')` and the credential is the session cookie the browser
// already holds. The fields are still read and written, so a browser that is
// sometimes on the Portal and sometimes served from a folder keeps whatever it
// was configured with.

import { uid } from '../util.js';

const DEVICE_KEY = 'idef0-modeler:device';
const SETTINGS_KEY = 'idef0-modeler:sync';

/**
 * This device's id, minted once and then kept.
 *
 * A browser that cannot keep it (a private window) gets a new one per session,
 * which costs nothing but a tie-break: the records still carry an origin, and
 * two of this device's own writes cannot tie because `SyncedDocument` stamps
 * the second one later.
 */
export function deviceId() {
  const held = read(DEVICE_KEY);
  if (held) return held;
  const minted = uid('dev');
  write(DEVICE_KEY, minted);
  return minted;
}

/**
 * The settings as stored. `enabled` is null when nobody has ever said — the
 * caller decides what that means, because it means different things on the
 * Portal (where syncing is the point of the deployment) and off it (where
 * nothing about the app may change).
 */
export function syncSettings() {
  let raw = null;
  try { raw = JSON.parse(read(SETTINGS_KEY) ?? 'null'); } catch { raw = null; }
  return {
    url: typeof raw?.url === 'string' ? raw.url : '',
    token: typeof raw?.token === 'string' ? raw.token : '',
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : null,
  };
}

/**
 * Write some of the settings back, and say whether the remote moved.
 *
 * A changed URL is worth reporting because the sync cursors describe this
 * store's position against one particular server and mean nothing against
 * another; whoever changes the URL has to clear them (sync-kit exports
 * `SYNC_CURSOR_KEYS` so nobody has to spell the two strings twice).
 */
export function saveSyncSettings(patch) {
  const before = syncSettings();
  const after = { ...before, ...patch };
  write(SETTINGS_KEY, JSON.stringify(after));
  return { settings: after, remoteMoved: after.url !== before.url || after.token !== before.token };
}

function read(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function write(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* a blocked store is not an error */ }
}
