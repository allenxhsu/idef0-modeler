// The sync client: one model, one record, and the repositories that group them.
//
// This is a thin coordinator over sync-kit, and deliberately thin. The engine
// pulls and pushes (`SyncEngine`), the transport speaks HTTP and reports a 401
// as something a person can act on (`HttpTransport`, `SyncUnauthorized`), the
// store is the browser's IndexedDB (`IndexedDbStore`, opened by
// `state/localStore.js`), and one rule that matters most is already written
// down in `SyncedDocument`: a version pulled from elsewhere is adopted only
// while the local buffer is clean, and an edit that loses the race is not lost
// because the save that follows it is stamped later on purpose.
//
// What is ours is the shape in `records.js` and the four operations a modeller
// asks for: save this model to the workspace, open one out of it, move one to
// another repository, delete one. Nothing here touches the DOM or a clock it
// was not handed, so the node tests drive it over a `MemoryStore` and a stub
// transport.

import { SyncEngine } from '../../sync-kit/js/engine.js';
import { SyncedDocument } from '../../sync-kit/js/document.js';
import { uid } from '../util.js';
import { deserialize } from '../io/json.js';
import {
  DEFAULT_REPOSITORY_NAME, MODEL_FORMAT, UNTITLED,
  groupByRepository, isAlive, isModelRecord, modelBody, parsesAsModel,
  repositoryIds, repositoryRecord,
} from './records.js';

/** The title a record is filed under. Kept in one place; used in three. */
const titleOf = (model) => (model?.title?.trim() || UNTITLED);

export class SyncClient {
  constructor({ store, transport, deviceId, now = Date.now, engine }) {
    this.store = store;
    this.deviceId = deviceId;
    this.now = now;
    this.engine = engine ?? new SyncEngine(store, transport, deviceId);
    /** One `SyncedDocument` per record this session has touched. */
    this.docs = new Map();
    /**
     * Which record the model on screen is. Set by opening one out of the
     * workspace and by saving one into it, and kept for the rest of the
     * session, which is what makes a later save write back to the same record
     * instead of forking a second copy of the same model.
     */
    this.session = { recordId: null, repositoryId: null };
  }

  get label() { return this.engine.label; }
  get status() { return this.engine.status; }

  /** Syncs whenever anything fires `sync-kit:sync-now`. Returns the unsubscribe. */
  listen() { return this.engine.listen(); }

  records() { return this.store.all(); }

  /**
   * Put what the editor currently shows into the open document's buffer.
   *
   * This is how the adoption rule is told about unsaved work, and it needs no
   * flag of its own: the buffer is the model's bytes, `saved` is the bytes last
   * written to the store, so a model with edits that have not been saved to the
   * workspace *is* a dirty buffer and a newer remote version is refused (and
   * remembered, so the save that follows outranks it). Call it before a sync.
   */
  stage(model) {
    const doc = this.session.recordId ? this.docs.get(this.session.recordId) : null;
    if (!doc || !model) return false;
    doc.edit(modelBody(model), titleOf(model));
    return doc.dirty;
  }

  /**
   * One sync: pull, push, and then offer what arrived to the open document.
   *
   * `adopted` says the model on screen has been replaced by a newer version
   * from another device — the caller reloads the canvas from `record` — and is
   * false whenever the buffer was dirty, whatever the timestamps said.
   */
  async sync() {
    const result = await this.engine.sync();
    const doc = this.session.recordId ? this.docs.get(this.session.recordId) : null;
    const adopted = doc ? doc.acceptAll(result.applied) : false;
    return { ...result, adopted, record: adopted ? doc.record : null };
  }

  /** The document for a record, loaded from the store the first time. */
  async document(id, { name } = {}) {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new SyncedDocument(this.store, {
        id, origin: this.deviceId, format: MODEL_FORMAT, name: name ?? id, now: this.now,
      });
      await doc.load();
      this.docs.set(id, doc);
    }
    return doc;
  }

  /* ------------------------------------------------------- repositories */

  /**
   * The repository a model goes in when nobody has chosen one: the first the
   * workspace holds, or a fresh default. Created after a sync rather than
   * before one, so a workspace that already has repositories is not given a
   * second default by every new browser.
   */
  async ensureDefaultRepository() {
    const named = groupByRepository(await this.records()).filter((g) => g.id);
    if (named.length) return named[0].id;
    return this.createRepository(DEFAULT_REPOSITORY_NAME);
  }

  async createRepository(name) {
    const id = uid('rp');
    await this.store.put([repositoryRecord({ id, name, origin: this.deviceId, at: this.now() })]);
    return id;
  }

  async renameRepository(id, name) {
    const held = await this.store.get(id);
    if (!held) throw new Error('That repository is no longer in the workspace.');
    const record = repositoryRecord({ id, name, origin: this.deviceId, at: this.stamp(held) });
    await this.store.put([record]);
    return record;
  }

  /* ------------------------------------------------------------- models */

  /**
   * Write the model to the workspace, and remember which record it is.
   *
   * The record id is the one this session is already bound to, or the model's
   * own id — which is the same id the file carries, so the same model saved
   * from two browsers is one record rather than two.
   */
  async saveModel(model, { repositoryId } = {}) {
    const id = this.session.recordId ?? model.id ?? uid('md');
    const repo = repositoryId ?? this.session.repositoryId ?? await this.ensureDefaultRepository();
    const doc = await this.document(id, { name: titleOf(model) });
    doc.edit(modelBody(model), titleOf(model));
    let record = await doc.save();
    // The repository is the record's, not the document's: `SyncedDocument` owns
    // the body and the name and passes everything else through, so the grouping
    // field (and the un-deleting of a record that was tombstoned) is written
    // alongside, at the same `updatedAt` so nothing ping-pongs.
    if (record.repositoryId !== repo || record.deletedAt != null) {
      record = { ...record, repositoryId: repo, deletedAt: null };
      await this.store.put([record]);
      await doc.load();
    }
    this.session = { recordId: id, repositoryId: repo };
    return record;
  }

  /**
   * Read a model out of the workspace, keeping its record id.
   *
   * Throws when the body is not this app's format — the `sync-body-stale`
   * check is how a modeller hears about that before trying to open it.
   */
  async openModel(recordId) {
    const record = await this.store.get(recordId);
    if (!record || !isModelRecord(record)) throw new Error('That model is not in this workspace any more.');
    if (!isAlive(record)) throw new Error('That model was deleted; sync again if another device has brought it back.');
    const model = deserialize(String(record.body ?? ''));
    await this.document(recordId, { name: record.name });
    this.session = { recordId, repositoryId: record.repositoryId ?? null };
    return { record, model };
  }

  /** File a model in another repository. One write; the body is untouched. */
  async moveModel(recordId, repositoryId) {
    const held = await this.store.get(recordId);
    if (!held || !isModelRecord(held)) throw new Error('That model is not in this workspace any more.');
    const moved = { ...held, repositoryId, updatedAt: this.stamp(held), origin: this.deviceId };
    await this.store.put([moved]);
    const doc = this.docs.get(recordId);
    if (doc) await doc.load();
    if (this.session.recordId === recordId) this.session = { recordId, repositoryId };
    return moved;
  }

  /** Delete as a tombstone: the row stays so the deletion can travel. */
  async deleteModel(recordId) {
    const doc = await this.document(recordId);
    const record = await doc.remove();
    if (this.session.recordId === recordId) this.session = { recordId: null, repositoryId: null };
    return record;
  }

  /* ---------------------------------------------------------- the whole */

  /**
   * Everything the Open from Sync dialog and the checks need: the repositories
   * with their models, the repository ids that exist, and the records whose
   * body no longer reads as a model.
   */
  async workspace() {
    const records = await this.records();
    return {
      groups: groupByRepository(records),
      repositoryIds: repositoryIds(records),
      stale: records.filter(isModelRecord).filter(isAlive).filter((r) => !parsesAsModel(r))
        .map(({ id, name, origin }) => ({ id, name, origin })),
    };
  }

  /** A write's timestamp: the clock, unless the clock is not ahead of the row. */
  stamp(record) {
    return Math.max(this.now(), (record?.updatedAt ?? 0) + 1);
  }
}
