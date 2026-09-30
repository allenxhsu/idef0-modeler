// The command bar.

import { el, clear } from '../util.js';
import {
  store, set, commit, undo, redo, canUndo, canRedo, loadModel, currentDiagram, goToDiagram, clearAutosave, markSaved,
} from '../state/store.js';
import { addBoxHere, deleteSelection, fitToWindow, zoomBy, renderCanvas, flushEdits } from './canvas.js';
import { confirmDialog, showHelp, showText } from './dialog.js';
import { createModel, findBoxAnywhere, layoutBoxes } from '../model/model.js';
import { buildSampleModel } from '../model/sample.js';
import { saveModel } from '../io/json.js';
import { toXml, toIdl } from '../io/idef0xml.js';
import { exportSvg, exportPng, printDiagrams, printAll } from '../io/exportImage.js';
import { saveMarkdown, saveHtml, toMarkdown } from '../io/report.js';
import { downloadText, slugify } from '../util.js';
import { canSync, deleteFromSync, isSynced, moveToRepository, openFromSync, saveToSync } from './syncMenu.js';
import { syncAfterExport } from '../sync/index.js';

let openMenu = null;

document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.contains(e.target)) { openMenu.querySelector('.menu-pop')?.remove(); openMenu = null; }
});

function menu(label, items) {
  const pop = () => {
    const list = el('div', { class: 'menu-pop' });
    for (const it of items()) {
      if (it === '-') { list.appendChild(el('hr')); continue; }
      if (it.note) { list.appendChild(el('div', { class: 'mnote', text: it.note })); continue; }
      list.appendChild(el('button', {
        text: it.label,
        disabled: it.disabled,
        onclick: () => { list.remove(); openMenu = null; it.run(); },
      }));
    }
    return list;
  };
  const host = el('div', { class: 'menu' });
  const btn = el('button', {
    class: 'btn',
    text: `${label} ▾`,
    onclick: (e) => {
      e.stopPropagation();
      const existing = host.querySelector('.menu-pop');
      if (openMenu && openMenu !== host) { openMenu.querySelector('.menu-pop')?.remove(); }
      if (existing) { existing.remove(); openMenu = null; return; }
      host.appendChild(pop());
      openMenu = host;
    },
  });
  host.appendChild(btn);
  return host;
}

/** The "Theme" toolbar button: a popover holding the shared kit's appearance picker. */
function themeMenu() {
  const pop = () => {
    const wrap = el('div', { class: 'menu-pop', style: 'width:230px;padding:12px' });
    wrap.appendChild(document.createElement('sc-theme-picker'));
    return wrap;
  };
  const host = el('div', { class: 'menu' });
  const btn = el('button', {
    class: 'btn',
    text: '◈ Theme',
    title: 'Appearance',
    onclick: (e) => {
      e.stopPropagation();
      const existing = host.querySelector('.menu-pop');
      if (openMenu && openMenu !== host) { openMenu.querySelector('.menu-pop')?.remove(); }
      if (existing) { existing.remove(); openMenu = null; return; }
      host.appendChild(pop());
      openMenu = host;
    },
  });
  host.appendChild(btn);
  return host;
}

/**
 * What the arrow tool asks for. Typed once here because the toolbar button and
 * the keyboard shortcut both set it, and because it must stay byte-identical
 * to the Mac app's `EditorState.arrowPrompt`.
 */
export const ARROW_PROMPT = 'Click a source: a box side, or the sheet edge for a boundary arrow.';

export function renderToolbar() {
  const host = document.getElementById('toolbar');
  clear(host);
  const dg = currentDiagram();
  const m = store.model;
  const parent = dg?.parentBoxId ? findBoxAnywhere(m, dg.parentBoxId) : null;

  host.append(
    el('div', { class: 'brand' }, 'IDEF0', el('small', { text: ' Modeler' })),

    menu('File', () => [
      { label: 'New model', run: newModel },
      { label: 'Open…  (.idef0.json or .xml)', run: () => document.getElementById('file-input').click() },
      { label: 'Load sample model', run: loadSample },
      '-',
      { label: `Save  ${store.ui.fileName || slugify(m.title) + '.idef0.json'}`, run: saveCurrent },
      '-',
      // The workspace commands. Greyed out rather than hidden when this browser
      // is not syncing, so the menu says the same thing everywhere and the
      // Model panel is where syncing is turned on.
      { label: 'Open from Sync…', run: openFromSync, disabled: !canSync() },
      { label: 'Save to Sync', run: saveToSync, disabled: !canSync() },
      { label: 'Move to repository…', run: moveToRepository, disabled: !canSync() || !isSynced() },
      { label: 'Delete from Sync…', run: deleteFromSync, disabled: !canSync() || !isSynced() },
      ...(canSync() ? [] : [{ note: 'Turn sync on in the Model panel to save online.' }]),
    ]),

    menu('Export', () => [
      // Every export is a moment the work is worth getting off this browser,
      // so each one asks for a sync afterwards (which does nothing at all when
      // sync is off).
      { label: `SVG — this diagram (${dg?.node})`, run: () => { set({ hint: `Exported ${exportSvg(m, dg)}` }); syncAfterExport(); } },
      { label: `PNG — this diagram (${dg?.node})`, run: async () => { set({ hint: `Exported ${await exportPng(m, dg)}` }); syncAfterExport(); } },
      { label: `PDF — this diagram (${dg?.node})`, run: () => safePrint(() => printDiagrams(m, [dg])) },
      { label: 'PDF — every diagram (kit)', run: () => safePrint(() => printAll(m)) },
      '-',
      { label: 'IDEF0 XML interchange', run: () => { downloadText(toXml(m), `${slugify(m.title)}.idef0.xml`, 'application/xml'); set({ hint: 'Exported IDEF0 XML' }); } },
      { label: 'IDL node listing (text)', run: () => showText('IDL node listing', toIdl(m), [{ label: 'Download', run: () => downloadText(toIdl(m), `${slugify(m.title)}.idl.txt`) }]) },
      '-',
      { label: 'Report — Markdown', run: () => { set({ hint: `Exported ${saveMarkdown(m)}` }); syncAfterExport(); } },
      { label: 'Report — HTML', run: () => { set({ hint: `Exported ${saveHtml(m)}` }); syncAfterExport(); } },
      { label: 'Report — preview', run: () => showText('Model report', toMarkdown(m), [{ label: 'Download .md', run: () => saveMarkdown(m) }]) },
      { note: 'PDF uses the browser print dialog — choose "Save as PDF".' },
    ]),

    el('div', { class: 'tb-sep' }),
    el('button', { class: 'btn', text: '↶', title: 'Undo (⌘Z)', disabled: !canUndo(), onclick: () => { undo(); renderCanvas(); } }),
    el('button', { class: 'btn', text: '↷', title: 'Redo (⇧⌘Z)', disabled: !canRedo(), onclick: () => { redo(); renderCanvas(); } }),

    el('div', { class: 'tb-sep' }),
    el('button', {
      class: `btn${store.ui.tool === 'select' ? ' on' : ''}`, text: '➤ Select', title: 'Select tool (V)',
      onclick: () => set({ tool: 'select', pending: null, hint: '' }),
    }),
    el('button', {
      class: `btn${store.ui.tool === 'arrow' ? ' on' : ''}`, text: '→ Arrow', title: 'Draw arrow (A)',
      onclick: () => set({ tool: 'arrow', pending: null, hint: ARROW_PROMPT }),
    }),
    el('button', {
      class: 'btn', text: '▭ Box', title: 'Add a box (B)',
      disabled: dg?.id === m.rootDiagramId && dg.boxes.length >= 1,
      onclick: addBoxHere,
    }),
    el('button', { class: 'btn danger', text: '✕', title: 'Delete selection (⌫)', disabled: !store.ui.selection, onclick: deleteSelection }),
    // Lays this diagram's boxes out on the staircase in number order (S01):
    // the one explicit relayout, since nothing is laid out on load. A-0's
    // single box is never laid out, so the button has nothing to do there.
    el('button', {
      class: 'btn', text: '⤡ Arrange', title: 'Lay the boxes out on the staircase in number order',
      disabled: !dg || dg.id === m.rootDiagramId,
      onclick: () => { flushEdits(); commit('Arrange', (mm) => { layoutBoxes(mm.diagrams[dg.id]); }); renderCanvas(); },
    }),

    el('div', { class: 'tb-sep' }),
    el('button', {
      class: 'btn', text: '↑ Parent', title: 'Go to the parent diagram (Esc)', disabled: !parent,
      onclick: () => { if (parent) { goToDiagram(parent.diagram.id); set({ selection: { kind: 'box', id: parent.box.id } }); renderCanvas(); } },
    }),
    el('button', { class: 'btn', text: '⌂ A-0', title: 'Go to the context diagram', onclick: () => { goToDiagram(m.rootDiagramId); renderCanvas(); } }),

    el('div', { class: 'tb-sep' }),
    el('button', { class: 'btn', text: '−', title: 'Zoom out', onclick: () => { zoomBy(1 / 1.2); renderStatusSoon(); } }),
    el('button', { class: 'btn', text: '⤢', title: 'Fit to window (⌘0)', onclick: () => { fitToWindow(); renderStatusSoon(); } }),
    el('button', { class: 'btn', text: '+', title: 'Zoom in', onclick: () => { zoomBy(1.2); renderStatusSoon(); } }),

    el('div', { style: 'flex:1' }),
    el('button', {
      class: `btn${document.body.classList.contains('hide-left') ? '' : ' on'}`,
      text: '◧', title: 'Show or hide the left panel',
      onclick: () => { document.body.classList.toggle('hide-left'); set({}); },
    }),
    el('button', {
      class: `btn${document.body.classList.contains('hide-right') ? '' : ' on'}`,
      text: '◨', title: 'Show or hide the right panel',
      onclick: () => { document.body.classList.toggle('hide-right'); set({}); },
    }),
    el('button', { class: 'btn', text: '?', title: 'Help', onclick: showHelp }),
    themeMenu(),
  );
}

function renderStatusSoon() { set({}); }

/**
 * Save the model the user sees: a field still being typed in is committed
 * first, then the live model is written and the recovery copy dropped. Both
 * File › Save and ⌘S come through here.
 */
export function saveCurrent() {
  flushEdits();
  const n = saveModel(store.model, store.ui.fileName);
  markSaved(n);
  // The file and the record carry the same bytes; a save is the moment to make
  // sure they hold the same ones.
  syncAfterExport();
}

function safePrint(fn) {
  try { fn(); } catch (e) { set({ hint: e.message }); }
}

async function newModel() {
  if (store.ui.dirty && !await confirmDialog('Start a new model?', 'Unsaved changes in the current model will be lost.', 'Discard and start new')) return;
  clearAutosave();
  loadModel(createModel('Untitled Model'));
  fitToWindow();
  renderCanvas();
}

async function loadSample() {
  if (store.ui.dirty && !await confirmDialog('Load the sample model?', 'Unsaved changes in the current model will be lost.', 'Discard and load')) return;
  loadModel(buildSampleModel());
  fitToWindow();
  renderCanvas();
}

export { newModel, loadSample };
