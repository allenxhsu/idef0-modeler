// Application entry point: wiring, keyboard, file open, autosave recovery.

import {
  store, set, subscribe, undo, redo, loadModel, currentDiagram, goToDiagram,
  readAutosave, clearAutosave, quarantineAutosave, markRecovered,
} from './state/store.js';
import {
  initCanvas, renderCanvas, fitToWindow, zoomBy, addBoxHere, deleteSelection, startBoxEdit, startLabelEdit, cancelInlineEdit,
} from './ui/canvas.js';
import { renderTree, renderModelProps, renderGlossary, renderProps, renderChecks, renderStatus } from './ui/panels.js';
import { renderToolbar, loadSample, saveCurrent, ARROW_PROMPT } from './ui/toolbar.js';
import { confirmDialog, modalOpen } from './ui/dialog.js';
import { deserialize } from './io/json.js';
import { fromXml } from './io/idef0xml.js';
import { findBoxAnywhere, findBox } from './model/model.js';
import { initPortal } from './portal.js';
import { initPersistence } from './state/persistence.js';
import { initSync, onSyncChange } from './sync/index.js';

/* ------------------------------------------------------------------ tabs */

for (const group of document.querySelectorAll('.panel-tabs')) {
  group.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const pane = group.parentElement;
    for (const t of group.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of pane.querySelectorAll('.tabpane')) p.classList.toggle('active', p.id === tab.dataset.tab);
  });
}

/* -------------------------------------------------------------- rendering */

/** True while the keyboard is in a field, where keys are for typing. */
const typing = () => {
  const a = document.activeElement;
  return !!a && (/^(input|textarea|select)$/i.test(a.tagName) || a.isContentEditable);
};

/**
 * Rebuild the panels. A pane the user is typing in is left alone — replacing
 * its DOM would drop focus, the caret and the value not yet committed. A
 * button that merely kept the focus after its click does not hold its pane:
 * what the click did is usually what the pane must now show.
 */
function renderAll() {
  const focused = typing() ? document.activeElement : null;
  const holdsFocus = (id) => focused && document.getElementById(id)?.contains(focused);
  const scrolls = [...document.querySelectorAll('.panel-body')].map((n) => [n, n.scrollTop]);

  renderToolbar();
  if (!holdsFocus('tree')) renderTree();
  if (!holdsFocus('modelprops')) renderModelProps();
  if (!holdsFocus('glossary')) renderGlossary();
  if (!holdsFocus('props')) renderProps();
  renderChecks();
  renderStatus();

  for (const [n, top] of scrolls) n.scrollTop = top;
}

subscribe((_s, meta) => {
  if (meta?.light) { renderStatus(); renderCanvas(); return; }
  renderAll();
  renderCanvas();
});

/* ------------------------------------------------------------------ files */

/**
 * Replace the current model with the contents of `file`. Every way of
 * bringing a file in — the Open dialog, a drop on the window — comes through
 * here, so they all ask before unsaved work is lost and all report a bad
 * file the same way.
 */
async function openFile(file) {
  if (store.ui.dirty && !await confirmDialog(`Open ${file.name}?`, 'Unsaved changes in the current model will be lost.', 'Discard and open')) return;
  try {
    const text = await file.text();
    const isXml = /\.xml$/i.test(file.name) || text.trimStart().startsWith('<');
    const model = isXml ? fromXml(text) : deserialize(text);
    cancelInlineEdit();                 // an editor left open would point into the old model
    loadModel(model, /\.xml$/i.test(file.name) ? null : file.name);
    fitToWindow();
    renderCanvas();
    set({ hint: `Opened ${file.name}` });
  } catch (e) {
    set({ hint: `Could not open ${file.name}: ${e.message}` });
    await confirmDialog('That file could not be opened', e.message, 'OK');
  }
}

const fileInput = document.getElementById('file-input');
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) openFile(file);
});

// Drag a model file anywhere onto the window to open it.
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();                   // before anything async, or the browser navigates to the file
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

window.addEventListener('beforeunload', (e) => {
  if (!store.ui.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

/* -------------------------------------------------------------- keyboard */

window.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (modalOpen()) {
    // A dialog owns the keyboard until it is answered. The editor's own
    // shortcuts are still swallowed, or the browser's Save / Open / zoom
    // would appear behind it; ⌘Z inside a dialog's field keeps its native undo.
    if (meta && (/^[so0=+-]$/i.test(e.key) || (e.key.toLowerCase() === 'z' && !typing()))) e.preventDefault();
    return;
  }

  if (meta && e.key.toLowerCase() === 'z') {
    if (typing()) return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    renderCanvas();
    return;
  }
  if (meta && e.key === '0') { e.preventDefault(); fitToWindow(); return; }
  if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.2); return; }
  if (meta && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
  if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); return; }
  if (meta && e.key.toLowerCase() === 'o') { e.preventDefault(); fileInput.click(); return; }
  if (typing() || meta) return;

  switch (e.key) {
    case 'v': case 'V': set({ tool: 'select', pending: null, hint: '' }); break;
    case 'a': case 'A': set({ tool: 'arrow', pending: null, hint: ARROW_PROMPT }); break;
    case 'b': case 'B': e.preventDefault(); addBoxHere(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); break;
    case 'Enter': {
      const dg = currentDiagram();
      const sel = store.ui.selection;
      if (!sel || !dg) break;
      e.preventDefault();
      if (sel.kind === 'box') { const b = findBox(dg, sel.id); if (b) startBoxEdit(b); }
      else { const a = dg.arrows.find((x) => x.id === sel.id); if (a) startLabelEdit(a); }
      break;
    }
    case 'Escape': {
      if (store.ui.pending) { set({ pending: null }); break; }
      if (store.ui.selection) { set({ selection: null }); break; }
      const dg = currentDiagram();
      const parent = dg?.parentBoxId ? findBoxAnywhere(store.model, dg.parentBoxId) : null;
      if (parent) { goToDiagram(parent.diagram.id); set({ selection: { kind: 'box', id: parent.box.id } }); renderCanvas(); }
      break;
    }
    default: break;
  }
});

/* ----------------------------------------------------------------- start */

initCanvas();

(async function start() {
  renderAll();          // draw the shell before any dialog blocks on the user
  renderCanvas();
  // Off the Portal this resolves to null and changes nothing; under it the bar
  // is in place before the restore dialog, so the shell never jumps.
  await initPortal();
  // Asked for, never waited on: whether the browser will keep the autosave is
  // worth knowing but worth nothing at all if it delays the first paint. The
  // Model panel shows "Checking…" until this lands and redraws it.
  initPersistence(() => renderModelProps());
  // The recovery copy now comes out of the browser store rather than out of
  // localStorage, so reading it is a promise. It is awaited here, where the
  // app was already waiting on the user's answer to the restore dialog.
  const saved = await readAutosave();
  if (saved?.model) {
    const when = new Date(saved.at).toLocaleString();
    // The autosave is the only copy of unsaved work, so it is deleted only on
    // an explicit Discard: the dialog cannot be dismissed, and a restored
    // model stays dirty (and autosaved) until it is saved to a file.
    const restore = await confirmDialog(
      'Restore your last session?',
      `An autosaved model from ${when} was found in this browser: “${saved.model.title || 'Untitled'}”. Discard deletes that copy.`,
      'Restore', 'Discard', { dismissable: false, danger: 'cancel', focus: 'ok' },
    );
    if (restore === false) {
      clearAutosave();
      loadSample();
    } else {
      try {
        const model = deserialize(JSON.stringify(saved.model));
        loadModel(model, saved.fileName);
        markRecovered();
        fitToWindow();
      } catch (e) {
        // Unreadable, but not necessarily worthless: keep it where the user
        // can get at it by hand, since loading the sample clears the live key.
        quarantineAutosave();
        loadSample();
        set({ hint: `The autosaved session could not be read (${e.message}); a copy was kept in this browser's storage.` });
      }
    }
  } else {
    quarantineAutosave();               // an autosave that would not even parse, if any
    loadSample();
  }
  renderAll();
  renderCanvas();
  fitToWindow();

  // Saving online comes last: the model on screen is settled, so the first sync
  // has something to stage and an adopted version has something to replace.
  // Off the Portal, and with no server configured, this wires nothing and makes
  // no request. The panels redraw whenever the service's state changes — a sync
  // finishing, a session running out, the settings being edited.
  onSyncChange(() => { renderToolbar(); renderModelProps(); renderChecks(); });
  initSync().catch((e) => { console.warn('Saving online could not be started.', e); });
})();
