// Whether the browser has agreed to keep this app's data.
//
// A browser copy is not a copy until the browser says it will keep it: by
// default everything in IndexedDB, localStorage and the caches sits in
// "best-effort" storage, which the browser is free to evict when the disk runs
// low — quietly, and without asking. Chrome answers from its own heuristics
// (an installed app, a bookmarked site, enough engagement) without ever
// showing a prompt; Firefox asks the person once and remembers; Safari grants
// it to a page added to the Home Screen or the Dock. Nothing here blocks, and
// nothing here fails: a browser that has never heard of the API reports
// "unknown" and the app carries on as it always did.
//
// The asking and the reading are now the sync kit's `requestPersistentStorage`
// and `storageStatus` — the same two functions the sync engine publishes on
// every sync status event, so the Model panel's readout and `<sc-sync-status>`
// cannot disagree about whether the store is at risk. What stays here is the
// part that is this app's: the three states the panel shows, the advice that
// goes with them, and the memory of having asked (a setting, which is why it
// may stay in localStorage).

import { requestPersistentStorage, storageStatus } from '../../sync-kit/js/persistence.js';

/** A setting, not a record: which is why it may stay in localStorage. */
const ASKED_KEY = 'idef0-modeler:persistence.asked';

/**
 * The last known answer.
 *
 * `state` is 'persisted' (the browser has promised to keep it), 'at-risk'
 * (best-effort: it may be evicted) or 'unknown' (no API, or not asked yet).
 * `usage` and `quota` are the kit's bytes, or null when the browser will not
 * say.
 */
let current = { state: 'unknown', asked: false, supported: false, usage: null, quota: null };

/** What the UI should show. Never throws, never waits. */
export function persistenceState() {
  return { ...current };
}

/** One sentence of what to do about it, or null when there is nothing to do. */
export function persistenceAdvice(state = current.state) {
  if (state === 'persisted') return null;
  return onIphone()
    ? 'Add the app to your Home Screen (Share ▸ Add to Home Screen) and this browser will keep your work.'
    : 'Install the app from your browser’s menu and it will keep your work instead of evicting it when space runs short.';
}

/**
 * Ask the browser to keep this app's data, at most once per browser unless
 * `force` says otherwise (turning sync on is the other moment worth asking).
 *
 * Returns the state it settled on. The caller is not expected to await it:
 * `initPersistence` below is the normal entry point, and it hands the answer
 * to a callback whenever it arrives.
 */
export async function requestPersistence({ force = false } = {}) {
  // The API surface is read here rather than taken from the kit's answer: the
  // kit reports null both for a browser that has no Storage API and for one
  // that throws on the question (a private window does), and those two are a
  // different thing to tell somebody — "we cannot know" against "it is not
  // being kept".
  const api = globalThis.navigator?.storage;
  current.supported = typeof api?.persisted === 'function';
  if (!current.supported) return settle('unknown', null);

  const before = await storageStatus();
  if (!before) return settle('at-risk', null);
  if (before.persisted) return settle('persisted', before);

  // Asking again after a refusal cannot help on its own — the answer is the
  // browser's policy, not a dialog — so a refusal is remembered and the prompt
  // is not put in front of the same person on every launch.
  const asked = remembered();
  current.asked = asked;
  if (asked && !force) return settle('at-risk', before);
  remember();
  const after = await requestPersistentStorage();
  return settle(after.persisted ? 'persisted' : 'at-risk', after);
}

/**
 * Ask on launch and tell the app when the answer arrives.
 *
 * Deliberately not awaited by the caller: the first paint must not wait on a
 * question about the disk. `onSettled` runs once, after the browser answers.
 */
export function initPersistence(onSettled = () => {}) {
  requestPersistence().then((state) => onSettled(state)).catch(() => {});
}

function settle(state, status) {
  current.state = state;
  current.usage = status?.usage ?? null;
  current.quota = status?.quota ?? null;
  return state;
}

function remembered() {
  try { return globalThis.localStorage?.getItem(ASKED_KEY) === '1'; } catch { return false; }
}

function remember() {
  current.asked = true;
  try { globalThis.localStorage?.setItem(ASKED_KEY, '1'); } catch { /* a blocked store is not an error */ }
}

/** iPhone and iPad, where the advice is the Home Screen rather than Install. */
function onIphone() {
  const ua = globalThis.navigator?.userAgent ?? '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1);
}
