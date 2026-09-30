// The File menu's four online commands.
//
// Each one is the same three steps: ask the sync client, tell the editor, and
// say what happened in the status line. They are here rather than in
// toolbar.js because the toolbar is a list of labels and these are the app's
// commands — `main.js` can bind them to keys, and the tests can run them with
// a stubbed client and a stubbed dialog.

import { store, set, loadModel } from '../state/store.js';
import { chooseDialog, confirmDialog } from './dialog.js';
import { fitToWindow, renderCanvas, flushEdits, cancelInlineEdit } from './canvas.js';
import { syncClient, syncAfterExport } from '../sync/index.js';

/** When the last write was, in the words a person uses about their own work. */
function when(at) {
  if (!at) return 'never saved';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? 'never saved' : d.toLocaleString();
}

/**
 * A device id is long, because it has to be unique across every browser this
 * person ever opens the app in; a row is not. The middle is elided in the row
 * and the whole of it is on the row's tooltip, so two devices never read as
 * one and nobody has to squint at sixteen hex digits to pick a model.
 */
const shortDevice = (id) => {
  const s = String(id || '');
  if (!s) return 'unknown device';
  return s.length > 14 ? `${s.slice(0, 4)}…${s.slice(-6)}` : s;
};

/** Name, when it last changed, and which device wrote it — one row's worth. */
const modelNote = (record) => `${when(record.updatedAt)} · ${shortDevice(record.origin)}`;

/** The whole truth, on the tooltip: the record id and the device that wrote it. */
const modelTitle = (record) => `${record.id}\nlast written by ${record.origin || 'an unknown device'}`;

/** True while there is a workspace to talk to; the menu greys out otherwise. */
export const canSync = () => !!syncClient();

/** True while the model on screen is a record in the workspace. */
export const isSynced = () => !!syncClient()?.session.recordId;

/**
 * File ▸ Open from Sync… — the repositories, their models, and what opening
 * one means: the model on screen is replaced, and the record id is kept so the
 * next save writes back to the same record instead of forking it.
 */
export async function openFromSync() {
  const client = syncClient();
  if (!client) return;
  const { groups } = await client.workspace();
  const choice = await chooseDialog(
    'Open from Sync',
    'Models in this workspace, newest first. Opening one replaces the model on screen.',
    groups.map((g) => ({
      name: g.name,
      items: g.models.map((m) => ({ label: m.name, note: modelNote(m), title: modelTitle(m), value: m.id })),
    })),
    { empty: 'No models here yet.' },
  );
  if (!choice) return;
  if (store.ui.dirty && !await confirmDialog('Open that model?', 'Unsaved changes in the current model will be lost.', 'Discard and open')) return;
  try {
    const { model, record } = await client.openModel(choice);
    cancelInlineEdit();                 // an editor left open would point into the old model
    // No file name: this copy came out of the workspace, not off the disk, and
    // Save would otherwise offer to overwrite a file the person never opened.
    loadModel(model, null);
    fitToWindow();
    renderCanvas();
    set({ hint: `Opened “${record.name}” from the workspace.` });
  } catch (e) {
    set({ hint: `That model could not be opened: ${e.message}` });
    await confirmDialog('That model could not be opened', e.message, 'OK');
  }
}

/**
 * File ▸ Save to Sync — write the model to its record, then ask for a sync so
 * it leaves this browser rather than waiting for the timer.
 */
export async function saveToSync() {
  const client = syncClient();
  if (!client) return;
  flushEdits();
  try {
    const record = await client.saveModel(store.model);
    const { groups } = await client.workspace();
    const repository = groups.find((g) => g.id === record.repositoryId)?.name ?? 'the workspace';
    set({ hint: `Saved “${record.name}” to ${repository}.` });
    syncAfterExport();
  } catch (e) {
    set({ hint: `That model could not be saved to the workspace: ${e.message}` });
  }
}

/** File ▸ Move to repository… — one write, and the model's bytes are untouched. */
export async function moveToRepository() {
  const client = syncClient();
  if (!client || !client.session.recordId) return;
  const { groups } = await client.workspace();
  const here = client.session.repositoryId;
  const choice = await chooseDialog(
    'Move to repository',
    'A repository groups models inside the workspace. Moving one changes where it is filed, not what it holds.',
    [{
      name: 'Repositories',
      items: groups.filter((g) => g.id).map((g) => ({
        label: g.name + (g.id === here ? ' (here now)' : ''),
        note: `${g.models.length} model${g.models.length === 1 ? '' : 's'}`,
        value: g.id,
      })),
    }],
    { empty: 'This workspace has no repository yet; sync once and it will have one.' },
  );
  if (!choice || choice === here) return;
  const moved = await client.moveModel(client.session.recordId, choice);
  const name = groups.find((g) => g.id === choice)?.name ?? 'another repository';
  set({ hint: `Moved “${moved.name}” to ${name}.` });
  syncAfterExport();
}

/**
 * File ▸ Delete from Sync… — a tombstone, not a hole: the row stays so the
 * deletion travels to the other devices. The model stays on screen, because
 * deleting the cloud copy is not the same as closing the model.
 */
export async function deleteFromSync() {
  const client = syncClient();
  const recordId = client?.session.recordId;
  if (!client || !recordId) return;
  const ok = await confirmDialog(
    'Delete this model from the workspace?',
    'The copy in the workspace is marked as deleted on every device that syncs. The model stays open here, and saving it again brings it back.',
    'Delete from the workspace',
  );
  if (!ok) return;
  const record = await client.deleteModel(recordId);
  set({ hint: `Deleted “${record.name}” from the workspace.` });
  syncAfterExport();
}
