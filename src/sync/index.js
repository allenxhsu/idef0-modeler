// Saving online: the app's one sync service.
//
// This module is the only thing that knows both halves — the editor's state and
// the sync client — and it is where the two ways of being configured are
// resolved:
//
//   On the Portal (`portalApp() === 'idef0'`) there is nothing to paste. The
//   workspace comes from `portalRemote('idef0')` and the credential is the
//   session cookie the browser already holds for that origin, which is why
//   `HttpTransport` sends `credentials: 'same-origin'` and no token. A 401 is
//   not an error to report but a session that has run out, so it surfaces the
//   portal bar's Sign in.
//
//   Off the Portal nothing about the app changes. `enabled` defaults to false,
//   no timer runs, no fetch is made, and the Sync section of the Model panel
//   shows the URL and token fields for somebody who has a server of their own.
//
// Sync happens on a timer, when the window regains focus, and after an export
// — the three moments when what is in the browser is worth getting off it —
// and whenever anything fires `sync-kit:sync-now`, which is what the kit's
// `<sc-sync-status>` button and the Sync now button both do.

import { SYNC_CURSOR_KEYS } from '../../sync-kit/js/engine.js';
import { HttpTransport } from '../../sync-kit/js/http.js';
import { publishStatus, requestSync } from '../../sync-kit/js/events.js';
import { portalApp, portalRemote, portalSession } from '../../sync-kit/js/portal.js';
import { deserialize } from '../io/json.js';
import { localStore } from '../state/localStore.js';
import { store, loadModel, set } from '../state/store.js';
import { APP_ID } from '../portal.js';
import { SyncClient } from './client.js';
import { deviceId, saveSyncSettings, syncSettings } from './settings.js';

/** How often a tab that is left open catches up. */
export const SYNC_INTERVAL_MS = 60_000;

/** The one line shown instead of a URL and a token when the Portal signed us in. */
export const PORTAL_CREDENTIAL_LINE = 'Signed in via the toolkit';

const listeners = new Set();
let client = null;
let timer = null;
let unlisten = null;
let wakeUp = null;
let snapshot = { enabled: false, repositoryIds: [], repositoryId: null, stale: [] };
let view = {
  portal: false,
  enabled: false,
  configured: false,
  label: '',
  workspace: '',
  message: '',
};

/** Subscribe to "the sync service's state changed"; returns the unsubscribe. */
export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** What the settings UI shows. Always safe to call, even before `initSync`. */
export function syncView() { return { ...view }; }

/** What the web-only checks read. Synchronous on purpose: the panel is. */
export function syncSnapshot() { return snapshot; }

/** The client, or null when this browser is not syncing. */
export function syncClient() { return client; }

/**
 * Start the service. Resolves once the first configuration is settled — never
 * once the first sync has finished, which may never happen on a train.
 *
 * `deps` exists for the tests: they hand in their own store, transport and
 * clock and never touch the network or the DOM.
 */
export async function initSync(deps = {}) {
  const portal = (deps.portalApp ?? portalApp)() === APP_ID;
  const settings = syncSettings();
  // Off the Portal, silence is no; on it, syncing is the point of being there.
  const enabled = settings.enabled ?? portal;

  const remote = enabled ? await resolveRemote(portal, settings, deps) : null;
  view = {
    portal,
    enabled,
    configured: !!remote,
    label: remote?.label ?? '',
    workspace: remote?.workspace ?? '',
    message: describe(portal, enabled, remote),
  };

  if (!remote) { changed(); return null; }

  const storeToUse = deps.store ?? await localStore();
  if (!storeToUse) { view.message = 'This browser will not keep a copy, so there is nothing to sync from.'; changed(); return null; }

  const transport = deps.transport ?? new HttpTransport({
    baseUrl: remote.baseUrl,
    token: remote.token || undefined,
    label: remote.label,
    onUnauthorized: () => surfaceSignIn(remote.label),
  });

  client = new SyncClient({
    store: storeToUse,
    transport,
    deviceId: deps.deviceId ?? deviceId(),
    now: deps.now,
  });
  view.label = client.label;

  unlisten = client.listen();
  wakeUps(deps);
  await refreshSnapshot();
  changed();
  // The first sync is asked for, never waited on.
  if (deps.syncOnStart !== false) void syncNow();
  return client;
}

/** Stop everything this module wired up. Used by the tests and by a teardown. */
export function stopSync() {
  if (timer) clearInterval(timer);
  timer = null;
  if (wakeUp) wakeUp.win?.removeEventListener?.('focus', wakeUp.handler);
  wakeUp = null;
  unlisten?.();
  unlisten = null;
  client = null;
  snapshot = { enabled: false, repositoryIds: [], repositoryId: null, stale: [] };
  view = { portal: false, enabled: false, configured: false, label: '', workspace: '', message: '' };
}

/**
 * Sync now: stage what the editor shows, run one pass, and take the result.
 *
 * Staging is what makes the adoption rule mean what it says — a model with
 * edits that have not been written to the workspace is a dirty buffer, and a
 * newer version from another device is refused rather than dropped on top of
 * somebody's work. When it *is* adopted the model on screen is reloaded from
 * the record that won.
 */
export async function syncNow() {
  if (!client) return null;
  client.stage(store.model);
  try {
    const result = await client.sync();
    if (result.adopted && result.record) {
      loadModel(deserializeRecord(result.record), store.ui.fileName);
      set({ hint: `A newer version of this model arrived from another device (${result.record.origin}).` });
    }
    // A workspace with no repository at all gets its default here, after a
    // sync rather than before one, so an existing repository is found first.
    await client.ensureDefaultRepository();
    await refreshSnapshot();
    // A sync that worked clears whatever the last failure said; the readout
    // beside it carries "Synced · just now" from here on.
    view.message = view.portal ? PORTAL_CREDENTIAL_LINE : '';
    changed();
    return result;
  } catch (e) {
    // A refused credential has its own sentence, and it is the useful one:
    // "not signed in" is not something to fix by trying again.
    if (e?.code === 'unauthorized') surfaceSignIn(view.label);
    else { view.message = `The last sync did not finish: ${e.message}`; changed(); }
    return null;
  }
}

/** Ask for a sync from anywhere — an export, a button, a keyboard shortcut. */
export function syncAfterExport() { return requestSync(); }

/**
 * Change the settings and start again with them.
 *
 * A changed URL or token points the same store at a different server, where
 * neither cursor means anything, so both are cleared before the client is
 * rebuilt. Pointing at a new server and keeping the old position is how a
 * client silently stops sending half its records.
 */
export async function updateSyncSettings(patch, deps = {}) {
  const { settings, remoteMoved } = saveSyncSettings(patch);
  if (remoteMoved) {
    const s = deps.store ?? await localStore();
    if (s) for (const key of SYNC_CURSOR_KEYS) await s.setMeta(key, 0);
  }
  stopSync();
  return initSync({ ...deps, syncOnStart: settings.enabled !== false });
}

/* ------------------------------------------------------------- internals */

async function resolveRemote(portal, settings, deps) {
  if (portal) {
    const session = await (deps.portalSession ?? portalSession)();
    const remote = (deps.portalRemote ?? portalRemote)(APP_ID, session);
    // No token, deliberately: the session cookie is the credential and a token
    // in the page would be a second one to leak for no benefit.
    return remote ? { baseUrl: remote.baseUrl, workspace: remote.workspace, label: remote.workspace, token: '' } : null;
  }
  const url = settings.url.trim();
  if (!url) return null;
  return { baseUrl: url, workspace: '', label: '', token: settings.token.trim() };
}

function describe(portal, enabled, remote) {
  if (!enabled) return 'Sync is off. Nothing leaves this browser.';
  if (portal && !remote) return 'The toolkit has not said which workspace this app syncs. Sign in again from the bar above.';
  if (!remote) return 'Give the sync server’s workspace URL to start syncing.';
  return portal ? PORTAL_CREDENTIAL_LINE : '';
}

/**
 * A 401 is a sign-in that has run out, and the two kits say so in two shapes:
 * the sync engine publishes `lastErrorCode`, while `<sc-sync-status>` reads the
 * code off `lastError`. Publishing the widget's shape *after* the engine's own
 * status turns the readout into a Sign in link instead of a sentence about a
 * status code, and the portal bar is put back into its signed-out state so its
 * own Sign in appears where somebody would look for it.
 */
function surfaceSignIn(label) {
  publishStatus({
    phase: 'error',
    lastError: { code: 'unauthorized', message: 'Your toolkit session has run out. Sign in again to keep saving online.' },
    lastErrorCode: 'unauthorized',
    ...(label ? { label } : {}),
  });
  try {
    const bar = globalThis.document?.querySelector?.('sc-portal-bar');
    if (bar && 'session' in bar) bar.session = null;
  } catch { /* no bar, no Portal: the status line said it anyway */ }
  view.message = 'Your toolkit session has run out. Sign in from the bar above and sync again.';
  changed();
}

function wakeUps(deps) {
  const win = deps.window ?? globalThis.window;
  timer = setInterval(() => { requestSync(); }, deps.intervalMs ?? SYNC_INTERVAL_MS);
  // A tab left open for a day is the common case; a tab coming back to the
  // front is the moment its copy is most likely to be behind. Kept in a
  // variable because the settings can be changed more than once in a session,
  // and a listener per change would sync once per change on every focus.
  wakeUp = { win, handler: () => { requestSync(); } };
  win?.addEventListener?.('focus', wakeUp.handler);
}

async function refreshSnapshot() {
  if (!client) return;
  const { repositoryIds, stale } = await client.workspace();
  snapshot = {
    enabled: true,
    repositoryIds,
    repositoryId: client.session.repositoryId,
    recordId: client.session.recordId,
    stale,
  };
}

/** The record body is the file's bytes, so this is the Open command's parse. */
const deserializeRecord = (record) => deserialize(String(record.body ?? ''));

function changed() { for (const fn of listeners) fn(view); }
