// Application state with snapshot undo/redo.
//
// Model edits go through `commit()`, which snapshots the model first; UI-only
// state (selection, zoom, current tool) changes through `set()` and is not
// undoable.

import { deepClone } from '../util.js';
import { createModel } from '../model/model.js';
import { validate } from '../model/validate.js';
import { bindAll, unboundCount } from '../model/concepts.js';
import { localStore, AUTOSAVE_META, QUARANTINE_META } from './localStore.js';

const MAX_HISTORY = 100;

export const store = {
  model: createModel('Untitled Model'),
  ui: {
    currentDiagramId: null,
    selection: null,          // { kind:'box'|'arrow', id }
    tool: 'select',           // 'select' | 'arrow'
    pending: null,            // in-progress arrow: { from, cursor }
    view: { scale: 1, tx: 0, ty: 0 },
    fileName: null,
    dirty: false,
    hint: '',
  },
  issues: [],
  _undo: [],
  _redo: [],
  _subs: new Set(),
  // Bumped by every change to `model` — an edit, a drag step, undo/redo, a
  // load — and never by a UI-only `set()`. The canvas keys what it derives
  // per render (ports, drawn arrows) on it, so a pointer move reuses the
  // last frame's derivation instead of recomputing it, and drops a hover
  // ring the moment the model it was found on is gone.
  _rev: 0,
};

store.model.rootDiagramId && (store.ui.currentDiagramId = store.model.rootDiagramId);

export function subscribe(fn) { store._subs.add(fn); return () => store._subs.delete(fn); }

/** A number that changes whenever `store.model` does (see `_rev`). */
export const modelRevision = () => store._rev;

let emitQueued = false;
let emitMeta = {};
/**
 * Notify subscribers. `meta.light` marks a high-frequency change (a drag in
 * progress) for which only the canvas and status line need redrawing.
 */
export function emit(meta = {}) {
  emitMeta = meta.light && emitQueued ? emitMeta : { ...emitMeta, ...meta };
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => {
    emitQueued = false;
    const m = emitMeta;
    emitMeta = {};
    for (const fn of store._subs) fn(store, m);
  });
}

/** Change UI-only state. */
export function set(patch) {
  Object.assign(store.ui, patch);
  emit();
}

/**
 * Apply an undoable change to the model. `fn` mutates the model in place.
 *
 * Like the Mac app's `IDEF0Document.apply`, an edit that changes nothing is
 * not recorded: no history entry, the redo stack survives and the model stays
 * clean. An edit that throws leaves the model as it was before `fn` ran, so a
 * half-applied mutation can never go live.
 */
export function commit(label, fn) {
  const before = JSON.stringify(store.model);
  let result;
  try {
    result = fn(store.model);
  } catch (e) {
    store.model = JSON.parse(before);
    store._rev += 1;
    ensureCurrent();
    emit();
    throw e;
  }
  if (JSON.stringify(store.model) === before) {
    emit();                                   // `fn` may still have changed ui state
    return result;
  }
  store._undo.push({ label, model: JSON.parse(before) });
  if (store._undo.length > MAX_HISTORY) store._undo.shift();
  store._redo.length = 0;
  store._rev += 1;
  store.ui.dirty = true;
  revalidate();
  scheduleAutosave();
  emit();
  return result;
}

/** Change the model without creating a history entry (e.g. during a drag). */
export function mutate(fn) {
  const result = fn(store.model);
  store._rev += 1;
  store.ui.dirty = true;
  emit({ light: true });
  return result;
}

/** Push a history entry for a change that `mutate` already applied. */
export function beginDrag(label) {
  store._undo.push({ label, model: deepClone(store.model) });
  if (store._undo.length > MAX_HISTORY) store._undo.shift();
  store._redo.length = 0;
}

export function endDrag() { revalidate(); scheduleAutosave(); emit(); }

export function undo() {
  const entry = store._undo.pop();
  if (!entry) return;
  store._redo.push({ label: entry.label, model: deepClone(store.model) });
  store.model = entry.model;
  store._rev += 1;
  ensureCurrent();
  revalidate();
  scheduleAutosave();
  emit();
}

export function redo() {
  const entry = store._redo.pop();
  if (!entry) return;
  store._undo.push({ label: entry.label, model: deepClone(store.model) });
  store.model = entry.model;
  store._rev += 1;
  ensureCurrent();
  revalidate();
  scheduleAutosave();
  emit();
}

export const canUndo = () => store._undo.length > 0;
export const canRedo = () => store._redo.length > 0;
export const undoLabel = () => (store._undo.at(-1)?.label ?? '');

export function loadModel(model, fileName = null) {
  // Every load path arrives here — new, sample, open, import, autosave — so
  // this is where a model without concepts acquires them. Counted before
  // binding: a model that needed it is not the file on disk any more, so it
  // is left dirty (with a status note) rather than looking clean when the new
  // ids exist only in memory (F13). A model whose top-level `id` was likewise
  // missing was flagged by `deserialize` (`model.__idMinted`, json.js) for
  // the same reason: that id, too, exists only in memory until this is saved.
  const bound = unboundCount(model);
  const idMinted = !!model.__idMinted;
  store.model = bindAll(model);
  store._rev += 1;
  store._undo.length = 0;
  store._redo.length = 0;
  store.ui.currentDiagramId = model.rootDiagramId;
  store.ui.selection = null;
  store.ui.pending = null;
  store.ui.tool = 'select';
  store.ui.fileName = fileName;
  store.ui.dirty = bound > 0 || idMinted;
  if (bound > 0 && idMinted) {
    store.ui.hint = `${bound} concept${bound === 1 ? '' : 's'} assigned and a model id generated on load; save to keep them.`;
  } else if (bound > 0) {
    store.ui.hint = `${bound} concept${bound === 1 ? '' : 's'} assigned on load; save to keep ${bound === 1 ? 'it' : 'them'}.`;
  } else if (idMinted) {
    store.ui.hint = 'This model had no id; one was generated on load. Save to keep it.';
  } else {
    store.ui.hint = '';
  }
  revalidate();
  scheduleAutosave();
  emit();
}

export function currentDiagram() {
  return store.model.diagrams[store.ui.currentDiagramId] || store.model.diagrams[store.model.rootDiagramId];
}

export function goToDiagram(id) {
  if (!store.model.diagrams[id]) return;
  // Hints are transient guidance for the sheet being left.
  set({ currentDiagramId: id, selection: null, pending: null, hint: '' });
}

/** Drop ui state that points at things the model no longer has. */
function ensureCurrent() {
  if (!store.model.diagrams[store.ui.currentDiagramId]) {
    store.ui.currentDiagramId = store.model.rootDiagramId;
  }
  const dg = currentDiagram();
  const sel = store.ui.selection;
  if (sel && dg) {
    const alive = sel.kind === 'box'
      ? dg.boxes.some((b) => b.id === sel.id)
      : dg.arrows.some((a) => a.id === sel.id);
    if (!alive) store.ui.selection = null;
  }
  // An arrow being drawn from a box that undo/redo removed must not be
  // finished: its source would dangle.
  const p = store.ui.pending;
  if (p && p.from.type === 'box' && !(dg && dg.boxes.some((b) => b.id === p.from.boxId))) {
    store.ui.pending = null;
  }
}

export function revalidate() {
  try {
    store.issues = validate(store.model);
  } catch (e) {
    // A validator crash must not stop the edit from being recorded, autosaved
    // and shown; surface it as an issue instead.
    store.issues = [{
      severity: 'error', code: 'internal-error',
      message: `The checks could not run: ${e.message}`, diagramId: null, kind: null, id: null,
    }];
  }
}

/* ------------------------------------------------------------- autosave  */

// The recovery copy lives in the browser store's key/value space (see
// state/localStore.js), which is asynchronous where localStorage was not.
// Three things follow. Every access goes through `queue`, so the order the app
// asked for — write, then the clear that a save issues a moment later — is the
// order the store sees, whatever the disk does in between. Nothing is awaited
// by the editor: a write that fails is exactly as best-effort as it was when a
// private window refused localStorage. And `flushAutosave()` exists so a test,
// or a caller that really must know, can wait for the queue to drain.

let autosaveTimer = null;
let queue = Promise.resolve();

/** Runs store work in order, swallowing failures. Returns the queue's tail. */
function enqueue(work) {
  queue = queue.then(async () => {
    const store_ = await localStore();
    if (store_) await work(store_);
  }).catch(() => { /* best effort: a store that will not keep it says so elsewhere */ });
  return queue;
}

/** Resolves once every autosave write asked for so far has been attempted. */
export function flushAutosave() { return queue; }

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  // Only unsaved edits are worth recovering; a freshly opened file is not.
  if (!store.ui.dirty) { clearAutosave(); return; }
  autosaveTimer = setTimeout(() => {
    if (!store.ui.dirty) return;          // saved in the meantime
    writeAutosave();
  }, 700);
}

function writeAutosave() {
  // Serialized here rather than in the queue, so what is kept is the model as
  // it was when the timer fired.
  const text = JSON.stringify({ at: Date.now(), fileName: store.ui.fileName, model: store.model });
  return enqueue((s) => s.setMeta(AUTOSAVE_META, text));
}

/**
 * The model was written to a file: it is clean, and the recovery copy (plus
 * any autosave still on its way to storage) is no longer wanted.
 */
export function markSaved(fileName) {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  clearAutosave();
  set({ fileName, dirty: false, hint: `Saved ${fileName}` });
}

/**
 * The model was restored from the autosave. It has never been saved to a
 * file, so it stays dirty: the recovery copy is kept and closing the tab
 * warns, until the user saves or discards it. The copy is written back at
 * once — loading it cleared the key, and until it is back the restored work
 * exists only in memory.
 */
export function markRecovered() {
  clearTimeout(autosaveTimer);
  store.ui.dirty = true;
  writeAutosave();
  emit();
}

/** The recovery copy, parsed, or null. Awaited once on launch. */
export async function readAutosave() {
  try {
    await flushAutosave();                // never read behind a write in flight
    const s = await localStore();
    const raw = s ? await s.meta(AUTOSAVE_META) : null;
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearAutosave() {
  return enqueue((s) => s.setMeta(AUTOSAVE_META, null));
}

/**
 * Keep a copy of an autosave the app could not read. Loading anything else
 * clears the live copy, and a payload the deserializer rejects may still be
 * recoverable by hand.
 */
export function quarantineAutosave() {
  return enqueue(async (s) => {
    const raw = await s.meta(AUTOSAVE_META);
    if (raw != null) await s.setMeta(QUARANTINE_META, raw);
  });
}

revalidate();
