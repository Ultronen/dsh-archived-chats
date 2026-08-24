import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecycleService, RecycleError } from '../lib/recycle.js';

const NOW = '2026-08-24T00:00:00.000Z';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000001';

function trashRecord(id = 'session-a', state = 'trashed') {
  return {
    sessionId: id,
    state,
    trashedAt: NOW,
    purgeRequestedAt: state === 'purge-pending' ? NOW : null,
    title: 'Alpha',
    createdAt: 10,
    origin: null,
    workspace: { id: 'ws-1', title: 'Project', path: '/project' },
    wasArchived: true,
    tags: ['important'],
    note: 'keep context',
    metadataUpdatedAt: NOW,
    snapshotId: SNAPSHOT_ID,
    snapshotBytes: 123,
    snapshotAttachmentCount: 1,
    liveDisposition: 'cold',
  };
}

function queue() {
  let tail = Promise.resolve();
  return {
    run(operation) {
      const result = tail.then(operation);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

function recycleFixture(options = {}) {
  const calls = options.calls ?? [];
  const id = 'session-a';
  const headers = new Map([[id, { id, version: 1, cwd: '/project', createdAt: 10, origin: null }]]);
  const persistence = {
    ids: new Set(options.originalMissing ? [] : [id]),
    writeCalls: 0,
    created: [],
    appended: [],
    async list() { return [...this.ids].map((sessionId) => headers.get(sessionId)); },
    async inspect(sessionId) {
      if (!this.ids.has(sessionId)) throw new Error('missing');
      return { meta: headers.get(sessionId), events: [{ seq: 0, type: 'session/title', data: { title: 'Alpha' } }] };
    },
  };
  const workspace = {
    id: 'ws-1', title: 'Project', path: '/project', sessionIds: new Set([id]),
    async attachSession(sessionId) { this.sessionIds.add(sessionId); },
  };
  const registry = {
    state: { archivedSessionIds: [id], workspaceIds: ['ws-1'] },
    get archivedSessionIds() { return this.state.archivedSessionIds; },
    list: () => [workspace],
    async setState(next) { this.state = next; },
  };
  const metadata = new Map([[id, { tags: ['important'], note: 'keep context', updatedAt: NOW }]]);
  const metadataStore = {
    async getMany(ids) {
      const entries = {};
      for (const sessionId of ids) if (metadata.has(sessionId)) entries[sessionId] = structuredClone(metadata.get(sessionId));
      return { status: 'ready', entries };
    },
    async set(sessionId, value) { metadata.set(sessionId, { ...structuredClone(value), updatedAt: NOW }); },
  };
  const records = new Map();
  for (const record of options.records ?? (options.trashed ? [trashRecord()] : [])) records.set(record.sessionId, structuredClone(record));
  const trashStore = {
    async load() { return { status: 'ready', records: new Map([...records].map(([key, value]) => [key, structuredClone(value)])) }; },
    async get(sessionId) { return records.has(sessionId) ? structuredClone(records.get(sessionId)) : null; },
    async list() { return [...records.values()].map((record) => structuredClone(record)); },
    async put(record) { calls.push(`trash:put:${record.sessionId}`); records.set(record.sessionId, structuredClone(record)); return structuredClone(record); },
    async remove(sessionId) { const ids = Array.isArray(sessionId) ? sessionId : [sessionId]; const removed = []; for (const key of ids) if (records.delete(key)) removed.push(key); return removed; },
    async summary() { return { count: records.size, snapshotBytes: [...records.values()].reduce((sum, record) => sum + record.snapshotBytes, 0), degradedCount: 0, purgePendingCount: 0 }; },
  };
  const snapshots = new Map(options.trashed ? [[id, { snapshotId: SNAPSHOT_ID, sessionId: id, createdAt: NOW }]] : []);
  let captures = 0;
  let releaseCapture;
  let markCaptureStarted;
  const captureStarted = new Promise((resolve) => { markCaptureStarted = resolve; });
  const snapshotStore = {
    async capture(input) {
      captures += 1;
      calls.push(`snapshot:capture:${input.sessionId}`);
      if (options.pauseCapture) {
        markCaptureStarted();
        await new Promise((resolve) => { releaseCapture = resolve; });
      }
      if (options.snapshotError) throw options.snapshotError;
      const value = { snapshotId: SNAPSHOT_ID, sessionId: input.sessionId, createdAt: NOW, bytes: 123, attachmentCount: 1, sourceRevision: 'rev-1' };
      snapshots.set(input.sessionId, value);
      return structuredClone(value);
    },
    async latestFor(sessionId) { return snapshots.has(sessionId) ? structuredClone(snapshots.get(sessionId)) : null; },
    async remove(snapshotId) {
      calls.push(`snapshot:remove:${snapshotId}`);
      for (const [sessionId, value] of snapshots) if (value.snapshotId === snapshotId) snapshots.delete(sessionId);
    },
  };
  let releaseDispose;
  let markDisposeStarted;
  const disposeStarted = new Promise((resolve) => { markDisposeStarted = resolve; });
  const disposeLive = async (sessionId) => {
    calls.push(`dispose:${sessionId}`);
    if (options.pauseDispose) {
      markDisposeStarted();
      await new Promise((resolve) => { releaseDispose = resolve; });
    }
    return { disposition: options.disposition ?? 'cold' };
  };
  const service = createRecycleService({
    registry, persistence, attachments: null, metadataStore, trashStore, snapshotStore,
    lifecycle: queue(), disposeLive, purgePhysical: async () => {},
    invalidate: (ids) => { for (const sessionId of ids) calls.push(`cache:invalidate:${sessionId}`); },
    logger: { warn() {} }, now: () => new Date(NOW),
  });
  return {
    service, persistence, workspace, registry, metadata, trashStore, snapshotStore,
    calls, captures: () => captures, disposeStarted,
    releaseDispose: () => releaseDispose?.(), captureStarted,
    releaseCapture: () => releaseCapture?.(), records,
  };
}

test('cold move snapshots before catalog commit and keeps authoritative state', async () => {
  const fixture = recycleFixture();
  assert.deepEqual(await fixture.service.move(['session-a']), { trashed: ['session-a'], failed: [] });
  assert.deepEqual(fixture.calls.slice(0, 3), ['dispose:session-a', 'snapshot:capture:session-a', 'trash:put:session-a']);
  assert.equal(fixture.calls.at(-1), 'cache:invalidate:session-a');
  assert.equal(fixture.persistence.ids.has('session-a'), true);
  assert.equal(fixture.workspace.sessionIds.has('session-a'), true);
  assert.equal(fixture.registry.archivedSessionIds.includes('session-a'), true);
});

test('intact-original undo removes only marker and writes no persistence', async () => {
  const fixture = recycleFixture({ trashed: true });
  assert.deepEqual(await fixture.service.restore(['session-a']), { restored: ['session-a'], failed: [], warnings: [] });
  assert.equal(fixture.persistence.writeCalls, 0);
  assert.equal(await fixture.trashStore.get('session-a'), null);
  assert.notEqual(await fixture.snapshotStore.latestFor('session-a'), null);
});

test('processes duplicate ids once and returns stable failures', async () => {
  const fixture = recycleFixture();
  const result = await fixture.service.move(['missing', 'session-a', 'session-a']);
  assert.deepEqual(result.trashed, ['session-a']);
  assert.deepEqual(result.failed, [{ id: 'missing', reason: 'session-not-archived' }]);
  assert.equal(fixture.captures(), 1);
});

test('records live disposition and reports parked snapshot failures safely', async () => {
  const disposed = recycleFixture({ disposition: 'disposed' });
  await disposed.service.move(['session-a']);
  assert.equal((await disposed.trashStore.get('session-a')).liveDisposition, 'disposed');

  const parked = recycleFixture({ disposition: 'parked', snapshotError: new RecycleError('snapshot-write-failed', 'private message') });
  assert.deepEqual(await parked.service.move(['session-a']), {
    trashed: [],
    failed: [{ id: 'session-a', reason: 'session-parked', cause: 'snapshot-write-failed' }],
  });
  assert.equal(await parked.trashStore.get('session-a'), null);
});

test('rechecks archive ownership after disposal and cleans only the new snapshot', async () => {
  const fixture = recycleFixture({ pauseDispose: true });
  const moving = fixture.service.move(['session-a']);
  await fixture.disposeStarted;
  fixture.registry.state.archivedSessionIds = [];
  fixture.releaseDispose();
  assert.deepEqual(await moving, { trashed: [], failed: [{ id: 'session-a', reason: 'operation-cancelled' }] });
  assert.equal(fixture.captures(), 0);
  assert.equal(await fixture.trashStore.get('session-a'), null);
});

test('rechecks ownership after snapshot publication and removes only the cancelled snapshot', async () => {
  const fixture = recycleFixture({ pauseCapture: true });
  const moving = fixture.service.move(['session-a']);
  await fixture.captureStarted;
  fixture.registry.state.archivedSessionIds = [];
  fixture.releaseCapture();
  assert.deepEqual(await moving, { trashed: [], failed: [{ id: 'session-a', reason: 'operation-cancelled' }] });
  assert.equal(await fixture.trashStore.get('session-a'), null);
  assert.equal(await fixture.snapshotStore.latestFor('session-a'), null);
  assert.equal(fixture.calls.includes(`snapshot:remove:${SNAPSHOT_ID}`), true);
});

test('rejects unavailable stores and purge-pending restore without leaking record content', async () => {
  const unavailable = recycleFixture();
  unavailable.trashStore.load = async () => ({ status: 'unavailable', records: new Map() });
  assert.deepEqual(await unavailable.service.move(['session-a']), { trashed: [], failed: [{ id: 'session-a', reason: 'trash-store-unavailable' }] });

  const pending = recycleFixture({ records: [trashRecord('session-a', 'purge-pending')] });
  assert.deepEqual(await pending.service.restore(['session-a']), { restored: [], failed: [{ id: 'session-a', reason: 'trash-state-conflict' }], warnings: [] });
});
