// DOM-free checks of src/state/store.js. Run with:  node --test tests/web/
//
// The store is a module singleton, so every test starts by loading a fresh
// sample model. The autosave now lives in the browser record store's meta
// space rather than in localStorage, so a MemoryStore is injected in place of
// IndexedDB and the tests read what it holds. localStorage is still stubbed:
// the settings and the device id remain there, and the migration reads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); },
};

const { MemoryStore } = await import(new URL('../../sync-kit/js/stores/memory.js', import.meta.url));
const {
  setLocalStore, AUTOSAVE_META, QUARANTINE_META,
} = await import(new URL('../../src/state/localStore.js', import.meta.url));

/** The browser's store, as a Map: what IndexedDB holds in a real browser. */
const browser = new MemoryStore('test');
setLocalStore(browser);

const {
  store, set, commit, undo, redo, loadModel, currentDiagram, goToDiagram,
  canUndo, canRedo, undoLabel, markSaved, markRecovered, readAutosave, quarantineAutosave,
  flushAutosave,
} = await import(new URL('../../src/state/store.js', import.meta.url));
const { buildSampleModel } = await import(new URL('../../src/model/sample.js', import.meta.url));
const {
  addBox, boxEnd, boundaryEnd, layoutBoxes, moveBox, sortedBoxes, staircaseLayout,
} = await import(new URL('../../src/model/model.js', import.meta.url));
const { bindAll } = await import(new URL('../../src/model/concepts.js', import.meta.url));

const AUTOSAVE_SETTLE = 900;                       // the autosave timer is 700 ms
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
/** The autosaved text the browser store holds, after the queue has drained. */
const autosaved = async () => { await flushAutosave(); return browser.meta(AUTOSAVE_META); };
const fresh = () => { memory.clear(); loadModel(buildSampleModel()); return currentDiagram(); };
const labels = () => store._undo.map((e) => e.label);

test('a commit that changes the model is recorded and dirties the model', () => {
  const dg = fresh();
  commit('Rename box', (m) => { m.diagrams[dg.id].boxes[0].name = 'Changed'; });
  assert.equal(undoLabel(), 'Rename box');
  assert.equal(store.ui.dirty, true);
});

test('a no-op commit records nothing, keeps redo and does not dirty the model', () => {
  const dg = fresh();
  commit('Rename box', (m) => { m.diagrams[dg.id].boxes[0].name = 'Changed'; });
  undo();
  assert.equal(canUndo(), false);
  assert.equal(canRedo(), true);
  const dirtyBefore = store.ui.dirty;

  const result = commit('Rename box', () => 'returned');
  assert.equal(result, 'returned');
  assert.equal(canUndo(), false, 'no undo entry for a no-op');
  assert.equal(canRedo(), true, 'redo survives a no-op');
  assert.equal(store.ui.dirty, dirtyBefore);
});

test('ui state changed inside a no-op commit still applies', () => {
  fresh();
  commit('Draw arrow', () => { store.ui.selection = { kind: 'box', id: 'nothing' }; });
  assert.deepEqual(store.ui.selection, { kind: 'box', id: 'nothing' });
});

test('a throwing commit leaves the model untouched and records nothing', () => {
  fresh();
  commit('Edit model author', (m) => { m.author = 'Someone'; });
  undo();
  const before = JSON.stringify(store.model);
  const redoDepth = store._redo.length;
  const dirtyBefore = store.ui.dirty;

  assert.throws(() => commit('Bad edit', (m) => {
    m.diagrams[m.rootDiagramId].boxes[0].name = 'Half done';
    m.glossary.push({ id: 'junk' });
    throw new Error('boom');
  }), /boom/);

  assert.equal(JSON.stringify(store.model), before, 'partial mutation rolled back');
  assert.equal(canUndo(), false);
  assert.equal(store._redo.length, redoDepth);
  assert.equal(store.ui.dirty, dirtyBefore);
});

test('undo drops a pending arrow whose source box is gone', () => {
  const root = fresh();
  goToDiagram(root.boxes[0].childDiagramId);
  const dg = currentDiagram();
  const created = commit('Add box', (m) => addBox(m, m.diagrams[dg.id]));
  set({ pending: { from: boxEnd(created.id, 'right', 0.5), cursor: { x: 0, y: 0 } } });
  undo();
  assert.equal(store.ui.pending, null);
});

test('undo keeps a pending arrow whose source still exists, box or boundary', () => {
  const root = fresh();
  goToDiagram(root.boxes[0].childDiagramId);
  const dg = currentDiagram();
  const survivor = dg.boxes[0];
  commit('Add box', (m) => addBox(m, m.diagrams[dg.id]));
  set({ pending: { from: boxEnd(survivor.id, 'right', 0.5), cursor: { x: 0, y: 0 } } });
  undo();
  assert.equal(store.ui.pending?.from.boxId, survivor.id);

  set({ pending: { from: boundaryEnd('left', 0.5), cursor: { x: 0, y: 0 } } });
  redo();
  assert.equal(store.ui.pending?.from.type, 'boundary');
});

test('goToDiagram clears the hint', () => {
  const root = fresh();
  set({ hint: 'Arrow added. Give it a noun-phrase label.' });
  goToDiagram(root.boxes[0].childDiagramId);
  assert.equal(store.ui.hint, '');
});

test('markSaved cleans the model, clears the autosave and cancels the pending timer', async () => {
  fresh();
  commit('Edit model author', (m) => { m.author = 'Reviewer'; });
  markSaved('model.idef0.json');
  assert.equal(store.ui.dirty, false);
  assert.equal(store.ui.fileName, 'model.idef0.json');
  assert.equal(store.ui.hint, 'Saved model.idef0.json');
  await sleep(AUTOSAVE_SETTLE);
  assert.equal(await autosaved(), null, 'a timer scheduled before the save must not rewrite the autosave');
});

test('the autosave timer re-checks dirty before writing', async () => {
  fresh();
  commit('Edit model author', (m) => { m.author = 'Reviewer'; });
  store.ui.dirty = false;
  await sleep(AUTOSAVE_SETTLE);
  assert.equal(await autosaved(), null);
});

test('an edit is autosaved while the model is dirty', async () => {
  fresh();
  commit('Edit model author', (m) => { m.author = 'Reviewer'; });
  await sleep(AUTOSAVE_SETTLE);
  assert.equal((await readAutosave())?.model?.author, 'Reviewer');
});

test('markRecovered keeps a restored model dirty and writes the autosave back at once', async () => {
  fresh();
  // Bound before loading (F13 leaves a load that still needs binding dirty,
  // which is a different case from the one this test covers).
  loadModel(bindAll(buildSampleModel()), 'restored.idef0.json');
  assert.equal(store.ui.dirty, false);
  assert.equal(await autosaved(), null, 'loading a clean model clears the copy');
  markRecovered();
  assert.equal(store.ui.dirty, true);
  assert.equal((await readAutosave())?.fileName, 'restored.idef0.json', 'written on the spot, not by the 700 ms timer');
});

test('quarantineAutosave keeps an unreadable autosave under the corrupt key', async () => {
  fresh();
  await browser.setMeta(AUTOSAVE_META, '{not json');
  assert.equal(await readAutosave(), null);
  await quarantineAutosave();
  assert.equal(await browser.meta(QUARANTINE_META), '{not json');
  await browser.setMeta(AUTOSAVE_META, null);
  await browser.setMeta(QUARANTINE_META, null);
  await quarantineAutosave();
  assert.equal(await browser.meta(QUARANTINE_META), null, 'nothing to keep, nothing written');
});

/* ------------------------------------------------- structural edits (S01) */

const rectOf = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });

test('Arrange (commit + layoutBoxes) records nothing on a diagram already on the staircase, and one step when it moves something', () => {
  const root = fresh();
  markSaved('sample.idef0.json');                 // the load bound the sample's concepts: clean it
  goToDiagram(root.boxes[0].childDiagramId);
  const dg = currentDiagram();
  commit('Arrange', (m) => { layoutBoxes(m.diagrams[dg.id]); });
  assert.equal(canUndo(), false, 'the sample is already laid out: a no-op commit');
  assert.equal(store.ui.dirty, false);

  // A file may carry any geometry (nothing is laid out on load); Arrange is
  // the explicit way back to the staircase.
  store.model.diagrams[dg.id].boxes[2].x = 20;
  store.model.diagrams[dg.id].boxes[2].w = 300;
  commit('Arrange', (m) => { layoutBoxes(m.diagrams[dg.id]); });
  assert.equal(undoLabel(), 'Arrange');
  assert.deepEqual(sortedBoxes(store.model.diagrams[dg.id]).map(rectOf), staircaseLayout(4));
  assert.equal(store.ui.dirty, true);
  undo();
  assert.equal(store.model.diagrams[dg.id].boxes[2].x, 20);

  // A-0 is never laid out, so Arrange there is always a no-op.
  goToDiagram(root.id);
  const before = JSON.stringify(store.model);
  commit('Arrange', (m) => { layoutBoxes(m.diagrams[root.id]); });
  assert.equal(JSON.stringify(store.model), before);
  assert.equal(undoLabel(), '');
});

test('a refused moveBox is a no-op commit: no history entry, model still clean', () => {
  const root = fresh();
  markSaved('sample.idef0.json');
  goToDiagram(root.boxes[0].childDiagramId);
  const dg = currentDiagram();
  const first = sortedBoxes(dg)[0];
  assert.equal(commit('Move box earlier', (m) => moveBox(m, m.diagrams[dg.id], first.id, -1)), false);
  assert.equal(canUndo(), false);
  assert.equal(store.ui.dirty, false);
  assert.equal(commit('Move box later', (m) => moveBox(m, m.diagrams[dg.id], first.id, 1)), true);
  assert.equal(undoLabel(), 'Move box later');
  assert.deepEqual(sortedBoxes(store.model.diagrams[dg.id]).map((b) => b.name).slice(0, 2), ['Fabricate Components', 'Plan Production']);
  assert.deepEqual(sortedBoxes(store.model.diagrams[dg.id]).map(rectOf), staircaseLayout(4), 'laid out again');
});

test('labels of recorded edits are kept in order', () => {
  const dg = fresh();
  commit('Rename box', (m) => { m.diagrams[dg.id].boxes[0].name = 'One'; });
  commit('Rename box', () => {});                  // no-op
  commit('Edit model author', (m) => { m.author = 'Two'; });
  assert.deepEqual(labels(), ['Rename box', 'Edit model author']);
});
