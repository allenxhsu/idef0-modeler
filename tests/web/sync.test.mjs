// Saving online, without a server: the client over a MemoryStore and a stub
// transport that behaves the way the deployed one does — a sequence number of
// its own for the pull cursor, last-write-wins on push.
//
// What is checked here is what would be expensive to find out later: that the
// record body is byte-identical to the file the Save command writes, that the
// repository grouping is the one the Open dialog shows, that a record opened
// out of the workspace keeps its id so a later save writes back instead of
// forking, and that a newer version from another device is adopted only while
// there are no unsaved edits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../sync-kit/js/stores/memory.js';

const { SyncClient } = await import(new URL('../../src/sync/client.js', import.meta.url));
const REC = await import(new URL('../../src/sync/records.js', import.meta.url));
const { syncIssues } = await import(new URL('../../src/sync/checks.js', import.meta.url));
const { serialize, deserialize } = await import(new URL('../../src/io/json.js', import.meta.url));
const { buildSampleModel } = await import(new URL('../../src/model/sample.js', import.meta.url));

/**
 * The server, as the protocol sees it: rows keyed by id, each stamped with the
 * server's own sequence number, which is what `cursor` is. `place` is another
 * device having written something.
 */
class Server {
  constructor(label = 'idef0') {
    this.label = label;
    this.rows = new Map();
    this.seq = 0;
    this.pushes = [];
  }

  async pull({ since }) {
    const records = [...this.rows.values()].filter((r) => r.seq > since).map(({ seq, ...rest }) => rest);
    return { records, cursor: this.seq };
  }

  async push({ records }) {
    this.pushes.push(records);
    for (const r of records) {
      const held = this.rows.get(r.id);
      if (held && held.updatedAt > r.updatedAt) continue;
      this.seq += 1;
      this.rows.set(r.id, { ...r, seq: this.seq });
    }
    return { accepted: records.length, cursor: this.seq };
  }

  place(record) {
    this.seq += 1;
    this.rows.set(record.id, { ...record, seq: this.seq });
  }

  get(id) {
    const row = this.rows.get(id);
    if (!row) return null;
    const { seq, ...rest } = row;
    return rest;
  }
}

/** A client on its own store, with a clock the test drives. */
function makeClient({ server = new Server(), deviceId = 'dev-a', at = 1000 } = {}) {
  const store = new MemoryStore('browser');
  const clock = { at };
  const client = new SyncClient({ store, transport: server, deviceId, now: () => clock.at });
  return { client, store, server, clock };
}

const sample = () => buildSampleModel();

/* ------------------------------------------------------- the record shape */

test('a model record is the four contract fields, the repository and the file’s bytes', () => {
  const model = sample();
  const record = REC.modelRecord({ id: 'md1', model, repositoryId: 'rp1', origin: 'dev-a', at: 1234 });
  assert.deepEqual(Object.keys(record), ['id', 'type', 'format', 'name', 'repositoryId', 'body', 'updatedAt', 'deletedAt', 'origin']);
  assert.equal(record.type, 'document');
  assert.equal(record.format, 'idef0-modeler/1');
  assert.equal(record.name, model.title);
  assert.equal(record.repositoryId, 'rp1');
  assert.equal(record.updatedAt, 1234);
  assert.equal(record.deletedAt, null);
  assert.equal(record.origin, 'dev-a');
});

test('the record body is byte-identical to the saved file', async () => {
  const model = sample();
  assert.equal(REC.modelRecord({ id: 'md1', model, origin: 'd', at: 1 }).body, serialize(model),
    'the cloud copy and the file are the same artefact');

  // And through the whole save path, not just the constructor.
  const { client, store } = makeClient();
  const saved = await client.saveModel(model);
  assert.equal((await store.get(saved.id)).body, serialize(model));
  assert.equal(serialize(deserialize((await store.get(saved.id)).body)), serialize(model), 'and it round-trips');
});

test('a repository record is a name and nothing else', () => {
  const record = REC.repositoryRecord({ id: 'rp1', name: 'Plant A', origin: 'dev-a', at: 7 });
  assert.deepEqual(Object.keys(record), ['id', 'type', 'format', 'name', 'body', 'updatedAt', 'deletedAt', 'origin']);
  assert.equal(record.format, 'idef0-repository/1');
  assert.equal(record.body, '', 'nothing but the name');
  assert.equal(REC.repositoryRecord({ id: 'rp2', name: '  ', origin: 'd', at: 1 }).name, 'My models', 'a nameless repository gets the default');
});

/* -------------------------------------------------------------- grouping */

test('the workspace groups models under their repository, newest first', () => {
  const repo = (id, name, at = 1) => REC.repositoryRecord({ id, name, origin: 'd', at });
  const mod = (id, name, repositoryId, at) => ({
    id, type: 'document', format: 'idef0-modeler/1', name, repositoryId, body: '{}', updatedAt: at, deletedAt: null, origin: 'd',
  });
  const groups = REC.groupByRepository([
    repo('rp2', 'Plant B'), repo('rp1', 'Plant A'),
    mod('m1', 'Older', 'rp1', 10), mod('m2', 'Newer', 'rp1', 20), mod('m3', 'Elsewhere', 'rp2', 15),
  ]);
  assert.deepEqual(groups.map((g) => g.name), ['Plant A', 'Plant B'], 'repositories by name');
  assert.deepEqual(groups[0].models.map((m) => m.name), ['Newer', 'Older'], 'models newest first');
  assert.deepEqual(groups[1].models.map((m) => m.name), ['Elsewhere']);

  const deleted = REC.groupByRepository([repo('rp1', 'Plant A'), { ...mod('m1', 'Gone', 'rp1', 10), deletedAt: 11 }]);
  assert.deepEqual(deleted[0].models, [], 'a tombstone is not a model in a list');
});

test('a model whose repository the workspace does not hold is shown, not hidden', () => {
  const groups = REC.groupByRepository([
    REC.repositoryRecord({ id: 'rp1', name: 'Plant A', origin: 'd', at: 1 }),
    { id: 'm1', type: 'document', format: 'idef0-modeler/1', name: 'Loose', repositoryId: 'rp-missing', body: '{}', updatedAt: 5, deletedAt: null, origin: 'd' },
    { id: 'm2', type: 'document', format: 'idef0-modeler/1', name: 'Filed nowhere', repositoryId: null, body: '{}', updatedAt: 6, deletedAt: null, origin: 'd' },
  ]);
  assert.deepEqual(groups.map((g) => g.name), ['Plant A', 'Not in a repository']);
  assert.deepEqual(groups[1].models.map((m) => m.name), ['Filed nowhere', 'Loose']);
  assert.equal(groups[1].id, null);
});

/* ---------------------------------------------------------- repositories */

test('a first sync creates one default repository, and only one', async () => {
  const { client, store } = makeClient();
  const first = await client.ensureDefaultRepository();
  const again = await client.ensureDefaultRepository();
  assert.equal(again, first, 'the second call finds the first');
  const repositories = (await store.all()).filter(REC.isRepositoryRecord);
  assert.equal(repositories.length, 1);
  assert.equal(repositories[0].name, 'My models');
});

test('a workspace that already has a repository is not given a default', async () => {
  const { client, store } = makeClient();
  await store.put([REC.repositoryRecord({ id: 'rp-theirs', name: 'Plant A', origin: 'dev-b', at: 5 })]);
  assert.equal(await client.ensureDefaultRepository(), 'rp-theirs');
  assert.equal((await store.all()).filter(REC.isRepositoryRecord).length, 1);
});

/* ---------------------------------------------------- save, open, move, delete */

test('saving files the model in a repository and remembers which record it is', async () => {
  const { client, store, clock } = makeClient();
  const model = sample();
  const record = await client.saveModel(model);
  assert.equal(record.id, model.id, 'the record is the model’s own id');
  assert.equal(client.session.recordId, record.id);
  assert.ok(record.repositoryId, 'filed somewhere');
  assert.equal(record.origin, 'dev-a');

  clock.at = 2000;
  model.author = 'Reviewer';
  const again = await client.saveModel(model);
  assert.equal(again.id, record.id, 'a second save writes the same record');
  assert.equal(again.repositoryId, record.repositoryId, 'and keeps the repository');
  assert.ok(again.updatedAt > record.updatedAt);
  assert.equal((await store.all()).filter(REC.isModelRecord).length, 1, 'one model, one record');
});

test('opening a model out of the workspace keeps its record id', async () => {
  const shared = new Server();
  const a = makeClient({ server: shared, deviceId: 'dev-a' });
  const model = sample();
  model.title = 'Filed by A';
  const written = await a.client.saveModel(model);
  await a.client.sync();

  // Another browser, another store: it pulls the record and opens it.
  const b = makeClient({ server: shared, deviceId: 'dev-b', at: 3000 });
  await b.client.sync();
  const opened = await b.client.openModel(written.id);
  assert.equal(opened.record.id, written.id);
  assert.equal(opened.model.title, 'Filed by A');
  assert.equal(b.client.session.recordId, written.id);
  assert.equal(b.client.session.repositoryId, written.repositoryId, 'and the repository it was filed in');

  opened.model.author = 'B';
  const resaved = await b.client.saveModel(opened.model);
  assert.equal(resaved.id, written.id, 'saving writes back to the same record, it does not fork');
  assert.equal(resaved.repositoryId, written.repositoryId);
  assert.equal((await b.store.all()).filter(REC.isModelRecord).length, 1);
});

test('a model can be moved to another repository without touching its body', async () => {
  const { client, store, clock } = makeClient();
  const model = sample();
  const record = await client.saveModel(model);
  const other = await client.createRepository('Plant B');
  clock.at = 5000;
  const moved = await client.moveModel(record.id, other);
  assert.equal(moved.repositoryId, other);
  assert.equal(moved.body, record.body, 'the bytes are untouched');
  assert.ok(moved.updatedAt > record.updatedAt, 'the move is a write, so it travels');
  assert.equal(client.session.repositoryId, other);
  assert.equal((await store.get(record.id)).repositoryId, other);
});

test('deleting writes a tombstone the deletion can travel on', async () => {
  const { client, store } = makeClient();
  const record = await client.saveModel(sample());
  const gone = await client.deleteModel(record.id);
  assert.ok(gone.deletedAt, 'marked, not removed');
  assert.ok(await store.get(record.id), 'the row stays');
  assert.equal(REC.groupByRepository(await store.all()).flatMap((g) => g.models).length, 0);
  assert.equal(client.session.recordId, null, 'nothing on screen is that record any more');
});

test('a model saved again after a delete comes back to life', async () => {
  const { client, store, clock } = makeClient();
  const model = sample();
  const record = await client.saveModel(model);
  await client.deleteModel(record.id);
  clock.at = 9000;
  const revived = await client.saveModel(model);
  assert.equal(revived.id, record.id);
  assert.equal(revived.deletedAt, null, 'a tombstone that is saved over is no longer a tombstone');
  assert.equal((await store.get(record.id)).deletedAt, null);
});

/* --------------------------------------------- the clean/dirty adoption rule */

test('a newer version from another device is adopted while there are no unsaved edits', async () => {
  const shared = new Server();
  const { client, clock } = makeClient({ server: shared });
  const model = sample();
  const record = await client.saveModel(model);
  await client.sync();

  const theirs = sample();
  theirs.id = model.id;
  theirs.title = 'Renamed on the other machine';
  shared.place({ ...record, name: theirs.title, body: serialize(theirs), updatedAt: record.updatedAt + 1000, origin: 'dev-b' });

  clock.at = 4000;
  client.stage(model);                             // nothing has changed here
  const result = await client.sync();
  assert.equal(result.adopted, true);
  assert.equal(result.record.origin, 'dev-b');
  assert.equal(deserialize(result.record.body).title, 'Renamed on the other machine');
});

test('a newer version is refused while the editor holds unsaved edits, and the save that follows wins', async () => {
  const shared = new Server();
  const { client, clock } = makeClient({ server: shared });
  const model = sample();
  const record = await client.saveModel(model);
  await client.sync();

  const theirs = sample();
  theirs.id = model.id;
  theirs.title = 'Theirs';
  const theirStamp = record.updatedAt + 1000;
  shared.place({ ...record, name: 'Theirs', body: serialize(theirs), updatedAt: theirStamp, origin: 'dev-b' });

  model.title = 'Mine, not yet saved';
  clock.at = 4000;
  assert.equal(client.stage(model), true, 'an unsaved edit is a dirty buffer');
  const result = await client.sync();
  assert.equal(result.adopted, false, 'nobody’s unsaved work is replaced');

  const saved = await client.saveModel(model);
  assert.equal(deserialize(saved.body).title, 'Mine, not yet saved');
  assert.ok(saved.updatedAt > theirStamp, 'the refused version is outranked, so the edit is not lost');
});

test('the model’s own record is pushed to the server', async () => {
  const shared = new Server();
  const { client } = makeClient({ server: shared });
  const model = sample();
  const record = await client.saveModel(model);
  await client.sync();
  assert.equal(shared.get(record.id)?.body, serialize(model));
  assert.ok(shared.get(record.repositoryId), 'the repository travels too');
});

/* ----------------------------------------------------------- the checks */

test('a model filed in a repository the workspace does not hold is reported', () => {
  const issues = syncIssues({ enabled: true, repositoryIds: ['rp1'], repositoryId: 'rp-missing', stale: [] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'sync-repository-unknown');
  assert.equal(issues[0].severity, 'warning');
  assert.match(issues[0].message, /Move to repository/);
  assert.equal(issues[0].diagramId, null);
});

test('a record whose body is not a model is reported, with the device that wrote it', () => {
  const issues = syncIssues({ enabled: true, repositoryIds: ['rp1'], repositoryId: 'rp1', stale: [{ id: 'm1', name: 'Odd one', origin: 'dev-b' }] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'sync-body-stale');
  assert.match(issues[0].message, /“Odd one”/);
  assert.match(issues[0].message, /dev-b/);
});

test('a browser that does not sync has nothing to report', () => {
  assert.deepEqual(syncIssues({ enabled: false, repositoryIds: [], repositoryId: 'rp-missing', stale: [{ id: 'm', name: 'x' }] }), []);
  assert.deepEqual(syncIssues(null), []);
});

test('a record that does parse is not stale', async () => {
  const { client } = makeClient();
  const record = await client.saveModel(sample());
  assert.equal(REC.parsesAsModel(record), true);
  assert.equal(REC.parsesAsModel({ ...record, body: 'not json' }), false);
  const { stale } = await client.workspace();
  assert.deepEqual(stale, []);
});

test('the workspace reports a record whose body no longer parses', async () => {
  const { client, store } = makeClient();
  const record = await client.saveModel(sample());
  await store.put([{ ...record, body: '{"schema":"wrong"}', updatedAt: record.updatedAt + 1 }]);
  const { stale, repositoryIds } = await client.workspace();
  assert.deepEqual(stale, [{ id: record.id, name: record.name, origin: 'dev-a' }]);
  assert.deepEqual(repositoryIds, [record.repositoryId]);
});
