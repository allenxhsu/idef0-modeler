// The two ways of being configured, which is the promise the Portal work has to
// keep: under the Portal there is nothing to paste and no token to copy, and off
// the Portal nothing about the app changes — no request, no timer, no fields
// filled in on somebody's behalf.
//
// Everything is injected: the store is a Map, the transport is a stub, and the
// Portal is three functions handed in, so nothing here reaches a network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, FakeNode, settle } from './support/fake-dom.mjs';
import { MemoryStore } from '../../sync-kit/js/stores/memory.js';
import { SyncUnauthorized } from '../../sync-kit/js/http.js';

const hosts = installFakeDom();

// The fake window only has listener no-ops; sync-kit's status and sync-now
// events need a real dispatch, so one is put in with the listeners it feeds.
const published = [];
const listeners = new Map();
globalThis.window.addEventListener = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
};
globalThis.window.removeEventListener = (type, fn) => {
  const l = listeners.get(type) || [];
  const i = l.indexOf(fn);
  if (i >= 0) l.splice(i, 1);
};
globalThis.window.dispatchEvent = (event) => {
  if (event.type === 'sync-kit:status') published.push(event.detail);
  for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
  return true;
};

const SYNC = await import('../../src/sync/index.js');
const { renderModelProps } = await import('../../src/ui/panels.js');
const { loadModel } = await import('../../src/state/store.js');
const { buildSampleModel } = await import('../../src/model/sample.js');

loadModel(buildSampleModel());

/** A transport that answers an empty workspace, or refuses the credential. */
function stubTransport({ label = 'idef0', refuse = false } = {}) {
  const calls = [];
  return {
    label,
    calls,
    async pull(req) {
      calls.push(['pull', req]);
      if (refuse) throw new SyncUnauthorized('/sync/pull');
      return { records: [], cursor: 0 };
    },
    async push(req) {
      calls.push(['push', req]);
      if (refuse) throw new SyncUnauthorized('/sync/push');
      return { accepted: req.records.length, cursor: 0 };
    },
  };
}

/** localStorage, emptied and optionally seeded with the sync settings. */
function settings(value) {
  globalThis.localStorage.removeItem('idef0-modeler:sync');
  if (value) globalThis.localStorage.setItem('idef0-modeler:sync', JSON.stringify(value));
}

const portalDeps = (remote = { baseUrl: 'https://toolkit.example/w/idef0', workspace: 'idef0' }) => ({
  portalApp: () => 'idef0',
  portalSession: async () => ({ email: 'someone@example.com', workspaces: { idef0: 'idef0' }, apps: [] }),
  portalRemote: () => remote,
});

const standaloneDeps = { portalApp: () => null };

async function start(deps) {
  return SYNC.initSync({
    store: new MemoryStore('browser'),
    transport: stubTransport(),
    deviceId: 'dev-test',
    syncOnStart: false,
    ...deps,
  });
}

/** What the Model panel's "Saving online" section shows. */
function panelSection() {
  renderModelProps();
  const host = hosts.get('modelprops');
  return {
    text: host.textContent,
    urlField: host.querySelector('input[placeholder="https://host/w/idef0"]'),
    passwords: host.querySelectorAll('input[type="password"]'),
    readout: host.querySelector('sc-sync-status'),
    syncNow: [...host.querySelectorAll('button')].find((b) => b.textContent === 'Sync now'),
  };
}

test('off the Portal, with nothing configured, nothing is wired and nothing is sent', async () => {
  settings(null);
  const transport = stubTransport();
  const client = await start({ ...standaloneDeps, transport });
  try {
    assert.equal(client, null, 'no client at all');
    assert.equal(SYNC.syncClient(), null);
    const view = SYNC.syncView();
    assert.equal(view.portal, false);
    assert.equal(view.enabled, false, 'silence off the Portal is no');
    assert.equal(view.configured, false);
    assert.match(view.message, /Sync is off/);
    assert.equal(transport.calls.length, 0, 'not one request');
    assert.equal(await SYNC.syncNow(), null, 'Sync now has nothing to sync');
  } finally {
    SYNC.stopSync();
  }
});

test('off the Portal the URL and token fields are the settings UI', async () => {
  settings({ url: 'https://mine.example/w/idef0', token: 'secret', enabled: true });
  await start({ ...standaloneDeps });
  try {
    const section = panelSection();
    assert.ok(section.urlField, 'the workspace URL is asked for');
    assert.equal(section.urlField.value, 'https://mine.example/w/idef0');
    assert.equal(section.passwords.length, 1, 'and a token, not shown in the clear');
    assert.ok(!section.text.includes('Signed in via the toolkit'), 'nothing signed us in');
    assert.ok(section.readout, 'the kit’s readout is there either way');
    assert.ok(section.syncNow && !section.syncNow.disabled, 'Sync now is live once a server is named');
  } finally {
    SYNC.stopSync();
  }
});

test('on the Portal sync is on with nothing configured, and the workspace comes from the toolkit', async () => {
  settings(null);
  const client = await start(portalDeps());
  try {
    assert.ok(client, 'a client, with no URL and no token anywhere');
    const view = SYNC.syncView();
    assert.equal(view.portal, true);
    assert.equal(view.enabled, true, 'syncing is the point of the deployment');
    assert.equal(view.configured, true);
    assert.equal(view.workspace, 'idef0');
    assert.equal(view.message, SYNC.PORTAL_CREDENTIAL_LINE);
  } finally {
    SYNC.stopSync();
  }
});

test('on the Portal the URL and token are replaced by one line', async () => {
  settings(null);
  await start(portalDeps());
  try {
    const section = panelSection();
    assert.equal(section.urlField, null, 'no URL to paste');
    assert.equal(section.passwords.length, 0, 'no token to copy');
    assert.ok(section.text.includes('Signed in via the toolkit'));
    assert.ok(section.text.includes('idef0'), 'the workspace is named');
  } finally {
    SYNC.stopSync();
  }
});

test('on the Portal a switched-off setting is still respected', async () => {
  settings({ url: '', token: '', enabled: false });
  const client = await start(portalDeps());
  try {
    assert.equal(client, null, 'the person said no, and no is no');
    assert.equal(SYNC.syncView().enabled, false);
  } finally {
    SYNC.stopSync();
  }
});

test('a Portal that has not said which workspace this app syncs says so', async () => {
  settings(null);
  const client = await start(portalDeps(null));
  try {
    assert.equal(client, null);
    assert.match(SYNC.syncView().message, /Sign in again/);
  } finally {
    SYNC.stopSync();
  }
});

test('a refused credential surfaces Sign in, not a status code', async () => {
  settings(null);
  const bar = new FakeNode('sc-portal-bar');
  bar.session = { email: 'someone@example.com' };
  document.documentElement.appendChild(bar);
  published.length = 0;
  await start({ ...portalDeps(), transport: stubTransport({ refuse: true }) });
  try {
    assert.equal(await SYNC.syncNow(), null, 'the sync did not finish');
    await settle();
    const unauthorized = published.filter((d) => d.lastError?.code === 'unauthorized');
    assert.ok(unauthorized.length, 'the readout is told in the shape it reads: lastError.code');
    assert.equal(unauthorized.at(-1).phase, 'error');
    assert.match(unauthorized.at(-1).lastError.message, /Sign in again/);
    assert.equal(bar.session, null, 'and the portal bar shows its own Sign in');
    assert.match(SYNC.syncView().message, /Sign in/);
  } finally {
    SYNC.stopSync();
    document.documentElement.childNodes.length = 0;
  }
});

test('the checks say nothing while this browser does not sync', async () => {
  settings(null);
  await start({ ...standaloneDeps });
  try {
    assert.equal(SYNC.syncSnapshot().enabled, false);
  } finally {
    SYNC.stopSync();
  }
});

test('a sync fills the snapshot the checks read', async () => {
  settings(null);
  const client = await start(portalDeps());
  try {
    const record = await client.saveModel(buildSampleModel());
    await SYNC.syncNow();
    const snapshot = SYNC.syncSnapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.recordId, record.id);
    assert.deepEqual(snapshot.repositoryIds, [record.repositoryId]);
    assert.deepEqual(snapshot.stale, []);
  } finally {
    SYNC.stopSync();
  }
});
