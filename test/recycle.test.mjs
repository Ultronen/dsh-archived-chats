import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecycleService, RecycleError } from '../lib/recycle.js';

const NOW = '2026-08-24T00:00:00.000Z';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000001';
const LEGACY_VALID_ID = '00000000-0000-4000-8000-000000000002';
const LEGACY_DEGRADED_ID = '00000000-0000-4000-8000-000000000003';
const SECOND_PROTECTED_ID = '00000000-0000-4000-8000-000000000004';
const tempRoots = new Set();
test.after(() => { for (const root of tempRoots) rmSync(root, { recursive: true, force: true }); });

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
  const root = mkdtempSync(join(tmpdir(), 'dac-recycle-'));
  tempRoots.add(root);
  const sessionDir = join(root, id);
  let listCalls = 0;
  const persistence = {
    ids: new Set(options.originalMissing ? [] : [id]),
    writeCalls: 0,
    created: [],
    appended: [],
    async list() {
      listCalls += 1;
      if (options.raceConflict && listCalls >= 2) return [headers.get(id)];
      return [...this.ids].map((sessionId) => headers.get(sessionId));
    },
    async inspect(sessionId) {
      if (!this.ids.has(sessionId)) throw new Error('missing');
      return { meta: headers.get(sessionId), events: [{ seq: 0, type: 'session/title', data: { title: 'Alpha' } }] };
    },
    async listSnapshots() {
      return [...this.ids].map((sessionId) => ({ header: headers.get(sessionId), revision: options.sourceRevision ?? 'rev-1' }));
    },
    locate: options.unsupportedLocate ? undefined : (meta) => ({ kind: 'jsonl', path: join(root, String(meta.id), 'session.jsonl.zstd') }),
    async create(meta) {
      this.writeCalls += 1;
      this.created.push(structuredClone(meta));
      this.ids.add(String(meta.id));
      mkdirSync(join(root, String(meta.id)), { recursive: true });
      writeFileSync(join(root, String(meta.id), 'session.jsonl.zstd'), 'created');
      if (options.failCreateAfterWrite) throw Object.assign(new Error('create failed'), { code: 'create-failed' });
    },
    async append(sessionId, events) {
      this.writeCalls += 1;
      this.appended.push(structuredClone(events));
      if (options.failAppend) throw Object.assign(new Error('append failed'), { code: 'append-failed' });
      if (!this.ids.has(sessionId)) throw new Error('missing');
    },
    async removeSession(sessionId) {
      this.ids.delete(String(sessionId));
      rmSync(join(root, String(sessionId)), { recursive: true, force: true });
    },
  };
  const workspace = {
    id: 'ws-1', title: 'Project', path: '/project', sessionIds: new Set(options.workspaceDetached ? [] : [id]),
    async attachSession(sessionId) {
      this.sessionIds.add(sessionId);
      if (options.restoreAttachError) throw Object.assign(new Error('attach failed'), { code: 'attach-failed' });
    },
    async detachSession(sessionId) { this.sessionIds.delete(sessionId); },
  };
  const registry = {
    state: { archivedSessionIds: options.unarchived ? [] : [id], workspaceIds: ['ws-1'] },
    get archivedSessionIds() { return this.state.archivedSessionIds; },
    list: () => [workspace],
    async setState(next) {
      this.state = next;
      if (options.restoreRegistryError && next.archivedSessionIds.includes(id)) {
        throw Object.assign(new Error('registry failed'), { code: 'registry-failed' });
      }
    },
  };
  const metadata = new Map([[id, { tags: ['important'], note: 'keep context', updatedAt: NOW }]]);
  const metadataStore = {
    async getMany(ids) {
      const entries = {};
      for (const sessionId of ids) if (metadata.has(sessionId)) entries[sessionId] = structuredClone(metadata.get(sessionId));
      return { status: 'ready', entries };
    },
    async set(sessionId, value) {
      metadata.set(sessionId, { ...structuredClone(value), updatedAt: NOW });
      if (options.restoreMetadataError) throw Object.assign(new Error('metadata failed'), { code: 'metadata-failed' });
    },
    async remove(ids) { for (const sessionId of ids) metadata.delete(sessionId); },
  };
  const records = new Map();
  for (const record of options.records ?? (options.trashed ? [trashRecord()] : [])) records.set(record.sessionId, structuredClone(record));
  const trashStore = {
    async load() { return { status: 'ready', records: new Map([...records].map(([key, value]) => [key, structuredClone(value)])) }; },
    async get(sessionId) { return records.has(sessionId) ? structuredClone(records.get(sessionId)) : null; },
    async list() { return [...records.values()].map((record) => structuredClone(record)); },
    async put(record) { calls.push(`trash:put:${record.sessionId}`); records.set(record.sessionId, structuredClone(record)); return structuredClone(record); },
    async transition(sessionId, state, patch = {}) {
      calls.push(`trash:transition:${sessionId}:${state}`);
      const current = records.get(sessionId);
      if (!current) throw Object.assign(new Error('missing'), { code: 'trash-record-missing' });
      const next = { ...current, ...structuredClone(patch), state };
      if (state === 'purge-pending' && next.purgeRequestedAt == null) next.purgeRequestedAt = NOW;
      records.set(sessionId, next);
      return structuredClone(next);
    },
    async markDegraded(sessionId, patch = {}) {
      const current = records.get(sessionId);
      const next = { ...current, ...structuredClone(patch), state: 'degraded' };
      records.set(sessionId, next);
      return structuredClone(next);
    },
    async remove(sessionId) { const ids = Array.isArray(sessionId) ? sessionId : [sessionId]; const removed = []; for (const key of ids) if (records.delete(key)) { calls.push(`trash:remove:${key}`); removed.push(key); } return removed; },
    async summary() { return { count: records.size, snapshotBytes: [...records.values()].reduce((sum, record) => sum + record.snapshotBytes, 0), degradedCount: 0, purgePendingCount: 0 }; },
  };
  const snapshots = new Map(options.priorSnapshotId
    ? [[id, { snapshotId: options.priorSnapshotId, sessionId: id, createdAt: '2026-08-23T00:00:00.000Z' }]]
    : options.trashed ? [[id, { snapshotId: SNAPSHOT_ID, sessionId: id, createdAt: NOW }]] : []);
  const publishedSnapshots = new Map();
  for (const value of snapshots.values()) publishedSnapshots.set(value.snapshotId, { kind: 'valid', value: structuredClone(value) });
  for (const value of options.inventoryValid ?? []) publishedSnapshots.set(value.snapshotId, { kind: 'valid', value: structuredClone(value) });
  for (const value of options.inventoryDegraded ?? []) publishedSnapshots.set(value.snapshotId, { kind: 'degraded', value: structuredClone(value) });
  const snapshotRemoveAttempts = new Map();
  let captures = 0;
  let releaseCapture;
  let markCaptureStarted;
  const captureStarted = new Promise((resolve) => { markCaptureStarted = resolve; });
  const snapshotStore = {
    async findRevision(sessionId, sourceRevision) {
      if (options.existingRevision?.sessionId === sessionId && options.existingRevision.sourceRevision === sourceRevision) {
        return structuredClone(options.existingRevision);
      }
      return null;
    },
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
      publishedSnapshots.set(value.snapshotId, { kind: 'valid', value: structuredClone(value) });
      return structuredClone(value);
    },
    async latestFor(sessionId) { return snapshots.has(sessionId) ? structuredClone(snapshots.get(sessionId)) : null; },
    async validate(snapshotId) {
      if (snapshotId !== SNAPSHOT_ID) throw new Error('missing snapshot');
      const ref = { attachmentId: 'image-a', mediaType: 'image/png', bytes: 4, width: 2, height: 2, name: 'a.png' };
      const archive = trashRecord().workspace;
      return {
        manifest: { snapshotId, sessionId: id },
        record: {
          format: 'dsh-archived-chats/snapshot-session', version: 1,
          archive: { ...trashRecord(), workspace: archive },
          source: {
            meta: structuredClone(headers.get(id)),
            events: [
              { seq: 0, type: 'session/start', data: {} },
              { seq: 1, type: 'user/message', data: { image: ref } },
              { seq: 2, type: 'session/title', data: { title: 'Alpha' } },
            ],
          },
          attachments: options.withAttachment ? [ref] : [],
        },
        attachments: options.withAttachment ? [{ descriptor: { ...ref, file: 'attachments/001.png', sha256: 'a'.repeat(64) }, path: join(root, 'snapshot-image'), data: new Uint8Array([1, 2, 3, 4]) }] : [],
      };
    },
    async remove(snapshotId) {
      calls.push(`snapshot:remove:${snapshotId}`);
      const attempts = (snapshotRemoveAttempts.get(snapshotId) ?? 0) + 1;
      snapshotRemoveAttempts.set(snapshotId, attempts);
      if (attempts <= (options.snapshotRemoveFailures?.[snapshotId] ?? 0)) {
        throw Object.assign(new Error('private snapshot removal detail'), { code: 'snapshot-remove-failed' });
      }
      for (const [sessionId, value] of snapshots) if (value.snapshotId === snapshotId) snapshots.delete(sessionId);
      publishedSnapshots.delete(snapshotId);
    },
    async removeForSession(sessionId) {
      calls.push(`snapshot:remove:${sessionId}`);
      if (options.snapshotRemoveError) throw Object.assign(new Error('snapshot remove failed'), { code: 'snapshot-remove-failed' });
      if (options.snapshotRemoveNoop) return [];
      snapshots.delete(sessionId);
      return [SNAPSHOT_ID];
    },
    async recover() {
      const valid = [...publishedSnapshots.values()].filter((entry) => entry.kind === 'valid').map((entry) => structuredClone(entry.value));
      const degraded = [...publishedSnapshots.values()].filter((entry) => entry.kind === 'degraded').map((entry) => structuredClone(entry.value));
      return { valid, degraded, latestBySession: new Map(valid.filter((value) => typeof value.sessionId === 'string').map((value) => [value.sessionId, value])) };
    },
    async inventory() {
      const valid = [...publishedSnapshots.values()].filter((entry) => entry.kind === 'valid').map((entry) => structuredClone(entry.value));
      const degraded = [...publishedSnapshots.values()].filter((entry) => entry.kind === 'degraded').map((entry) => structuredClone(entry.value));
      return { valid, degraded };
    },
  };
  const attachments = {
    saved: [],
    async saveImage(input) {
      this.saved.push(structuredClone(input));
      return { attachmentId: options.attachmentMismatch ? 'different-image' : 'image-a', mediaType: input.mediaType, bytes: input.data.byteLength, width: 2, height: 2, ...(input.name === undefined ? {} : { name: input.name }) };
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
  const purgedIds = [];
  const pendingPath = join(root, 'pending-deletions.json');
  const purgePhysical = options.unsupportedPurge ? undefined : async (sessionId) => {
    calls.push(`physical:purge:${sessionId}`);
    if (options.purgeError) throw options.purgeError;
    purgedIds.push(sessionId);
    persistence.ids.delete(sessionId);
  };
  const service = createRecycleService({
    registry, persistence, attachments, metadataStore, trashStore, snapshotStore,
    lifecycle: queue(), disposeLive, purgePhysical,
    invalidate: (ids) => { for (const sessionId of ids) calls.push(`cache:invalidate:${sessionId}`); },
    logger: { warn(message) { calls.push(`warn:${message}`); } }, now: () => new Date(NOW),
  });
  return {
    service, persistence, attachments, workspace, registry, metadata, trashStore, snapshotStore,
    calls, captures: () => captures, disposeStarted,
    releaseDispose: () => releaseDispose?.(), captureStarted,
    releaseCapture: () => releaseCapture?.(), records, root, sessionDir, purgedIds, pendingPath,
    publishedSnapshotIds: () => [...publishedSnapshots.keys()].sort(),
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

test('a new recycle cycle keeps the prior protection snapshot as history', async () => {
  const priorSnapshotId = '00000000-0000-4000-8000-000000000009';
  const fixture = recycleFixture({ priorSnapshotId });
  assert.deepEqual(await fixture.service.move(['session-a']), { trashed: ['session-a'], failed: [] });
  assert.equal(fixture.calls.includes(`snapshot:remove:${priorSnapshotId}`), false);
});

test('recycle reuses a healthy archive snapshot for the same stable source revision', async () => {
  const existing = {
    snapshotId: '00000000-0000-4000-8000-000000000009',
    sessionId: 'session-a',
    createdAt: '2026-08-23T00:00:00.000Z',
    sourceRevision: 'rev-1',
    totalBytes: 456,
    attachmentCount: 2,
  };
  const fixture = recycleFixture({ existingRevision: existing });

  assert.deepEqual(await fixture.service.move(['session-a']), { trashed: ['session-a'], failed: [] });
  assert.equal(fixture.captures(), 0);
  const record = await fixture.trashStore.get('session-a');
  assert.equal(record.snapshotId, existing.snapshotId);
  assert.equal(record.snapshotBytes, 456);
  assert.equal(record.snapshotAttachmentCount, 2);
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

test('restores a missing original from snapshot without changing identity', async () => {
  const fixture = recycleFixture({ trashed: true, originalMissing: true, withAttachment: true });
  const result = await fixture.service.restore(['session-a']);
  assert.deepEqual(result.restored, ['session-a']);
  assert.deepEqual(fixture.persistence.created, [{ id: 'session-a', version: 1, cwd: '/project', createdAt: 10, origin: null }]);
  assert.deepEqual(fixture.persistence.appended.flat().map((event) => event.seq), [0, 1, 2]);
  assert.equal(fixture.attachments.saved[0].mediaType, 'image/png');
  assert.equal(fixture.workspace.sessionIds.has('session-a'), true);
  assert.deepEqual(
    { tags: fixture.metadata.get('session-a').tags, note: fixture.metadata.get('session-a').note },
    { tags: ['important'], note: 'keep context' },
  );
  assert.equal(fixture.registry.archivedSessionIds.includes('session-a'), true);
  assert.equal(await fixture.trashStore.get('session-a'), null);
  assert.equal(existsSync(fixture.sessionDir), true);
});

test('fallback preflight rejects id races, unsupported rollback, and attachment identity mismatch without writes', async () => {
  for (const options of [
    { raceConflict: true, expected: 'id-conflict' },
    { unsupportedLocate: true, expected: 'snapshot-restore-unsupported' },
    { withAttachment: true, attachmentMismatch: true, expected: 'snapshot-attachment-identity-mismatch' },
  ]) {
    const fixture = recycleFixture({ trashed: true, originalMissing: true, ...options });
    const result = await fixture.service.restore(['session-a']);
    assert.deepEqual(result.failed, [{ id: 'session-a', reason: options.expected }]);
    assert.equal(fixture.persistence.created.length, 0);
    assert.notEqual(await fixture.trashStore.get('session-a'), null);
  }
});

test('append failure rolls back the newly created artifact and preserves trash', async () => {
  const fixture = recycleFixture({ trashed: true, originalMissing: true, failAppend: true });
  const result = await fixture.service.restore(['session-a']);
  assert.deepEqual(result.failed, [{ id: 'session-a', reason: 'append-failed' }]);
  assert.equal(fixture.persistence.ids.has('session-a'), false);
  assert.equal(existsSync(fixture.sessionDir), false);
  assert.notEqual(await fixture.trashStore.get('session-a'), null);
});

test('snapshot fallback rolls back Host methods that throw after mutating state', async () => {
  const createFailure = recycleFixture({ trashed: true, originalMissing: true, failCreateAfterWrite: true });
  assert.deepEqual((await createFailure.service.restore(['session-a'])).failed, [{ id: 'session-a', reason: 'create-failed' }]);
  assert.equal(createFailure.persistence.ids.has('session-a'), false);
  assert.notEqual(await createFailure.trashStore.get('session-a'), null);

  const attachFailure = recycleFixture({ trashed: true, originalMissing: true, workspaceDetached: true, restoreAttachError: true });
  assert.deepEqual((await attachFailure.service.restore(['session-a'])).failed, [{ id: 'session-a', reason: 'attach-failed' }]);
  assert.equal(attachFailure.workspace.sessionIds.has('session-a'), false);
  assert.equal(attachFailure.persistence.ids.has('session-a'), false);

  const metadataFailure = recycleFixture({ trashed: true, originalMissing: true, workspaceDetached: true, restoreMetadataError: true });
  metadataFailure.metadata.delete('session-a');
  assert.deepEqual((await metadataFailure.service.restore(['session-a'])).failed, [{ id: 'session-a', reason: 'metadata-failed' }]);
  assert.equal(metadataFailure.metadata.has('session-a'), false);
  assert.equal(metadataFailure.persistence.ids.has('session-a'), false);

  const registryFailure = recycleFixture({ trashed: true, originalMissing: true, unarchived: true, restoreRegistryError: true });
  assert.deepEqual((await registryFailure.service.restore(['session-a'])).failed, [{ id: 'session-a', reason: 'registry-failed' }]);
  assert.deepEqual(registryFailure.registry.archivedSessionIds, []);
  assert.equal(registryFailure.persistence.ids.has('session-a'), false);
});

test('intact-original restore keeps trash and rolls back partial registry, workspace, and metadata writes', async () => {
  const registryFailure = recycleFixture({ trashed: true, unarchived: true, restoreRegistryError: true });
  assert.deepEqual((await registryFailure.service.restore(['session-a'])).failed, [{ id: 'session-a', reason: 'registry-failed' }]);
  assert.deepEqual(registryFailure.registry.archivedSessionIds, []);
  assert.notEqual(await registryFailure.trashStore.get('session-a'), null);

  const attachFailure = recycleFixture({ trashed: true, workspaceDetached: true, restoreAttachError: true });
  assert.deepEqual((await attachFailure.service.restore(['session-a'])).failed, [{ id: 'session-a', reason: 'attach-failed' }]);
  assert.equal(attachFailure.workspace.sessionIds.has('session-a'), false);
  assert.notEqual(await attachFailure.trashStore.get('session-a'), null);

  const metadataFailure = recycleFixture({ trashed: true, workspaceDetached: true, restoreMetadataError: true });
  metadataFailure.metadata.delete('session-a');
  assert.deepEqual((await metadataFailure.service.restore(['session-a'])).failed, [{ id: 'session-a', reason: 'metadata-failed' }]);
  assert.equal(metadataFailure.workspace.sessionIds.has('session-a'), false);
  assert.equal(metadataFailure.metadata.has('session-a'), false);
  assert.notEqual(await metadataFailure.trashStore.get('session-a'), null);
});

test('legacy physical purge records intent first, deletes the session last, and removes trash after it', async () => {
  const fixture = recycleFixture({ trashed: true });
  assert.deepEqual(await fixture.service.purge(['session-a']), { purged: ['session-a'], failed: [] });
  // The irreversible step goes last: snapshot removal runs before the session
  // log is destroyed, so any failure still leaves the original restorable on a
  // later attempt instead of stranding purge-pending with nothing to restore.
  assert.deepEqual(fixture.calls.filter((call) => /^(trash:transition|physical:purge|snapshot:remove|trash:remove|cache:invalidate)/.test(call)), [
    'trash:transition:session-a:purge-pending',
    'snapshot:remove:session-a',
    'physical:purge:session-a',
    'trash:remove:session-a',
    'cache:invalidate:session-a',
  ]);
});

test('refuses direct and empty purge before changing records, snapshots, or sessions when physical purge is unavailable', async () => {
  for (const action of ['direct', 'empty']) {
    const fixture = recycleFixture({ trashed: true, unsupportedPurge: true });
    const before = await fixture.trashStore.get('session-a');
    const snapshotBefore = await fixture.snapshotStore.latestFor('session-a');

    const result = action === 'direct'
      ? await fixture.service.purge(['session-a'])
      : await fixture.service.empty();

    assert.deepEqual(result, { purged: [], failed: [{ id: 'session-a', reason: 'purge-unsupported' }] });
    assert.deepEqual(await fixture.trashStore.get('session-a'), before);
    assert.deepEqual(await fixture.snapshotStore.latestFor('session-a'), snapshotBefore);
    assert.equal(fixture.persistence.ids.has('session-a'), true);
    assert.deepEqual(fixture.calls.filter((call) => /^(trash:transition|snapshot:remove|dispose:|physical:purge)/.test(call)), []);
  }
});

test('startup recovery cannot delete purge-pending evidence without physical purge capability', async () => {
  const fixture = recycleFixture({
    records: [trashRecord('session-a', 'purge-pending')],
    unsupportedPurge: true,
  });
  writeFileSync(fixture.pendingPath, '{"ids":[]}\n');
  const before = await fixture.trashStore.get('session-a');
  const snapshotBefore = await fixture.snapshotStore.latestFor('session-a');

  await fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath });

  assert.deepEqual(await fixture.trashStore.get('session-a'), before);
  assert.deepEqual(await fixture.snapshotStore.latestFor('session-a'), snapshotBefore);
  assert.equal(fixture.persistence.ids.has('session-a'), true);
  assert.deepEqual(fixture.calls.filter((call) => /^(trash:transition|snapshot:remove|dispose:|physical:purge)/.test(call)), []);
});

test('startup retries purge-pending but never deletes plain trash', async () => {
  const fixture = recycleFixture({ records: [trashRecord('a'), trashRecord('b', 'purge-pending')] });
  writeFileSync(fixture.pendingPath, '{"ids":[]}\n');
  await fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath });
  assert.deepEqual(fixture.purgedIds, ['b']);
  assert.notEqual(await fixture.trashStore.get('a'), null);
  assert.equal(await fixture.trashStore.get('b'), null);
});

test('legacy pending migration snapshots archived ids and never purges them', async () => {
  const fixture = recycleFixture();
  writeFileSync(fixture.pendingPath, '{"ids":["session-a"]}\n');
  await fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath });
  assert.notEqual(await fixture.trashStore.get('session-a'), null);
  assert.deepEqual(fixture.purgedIds, []);
  assert.equal(readFileSync(fixture.pendingPath, 'utf8'), '{\n  "ids": []\n}\n');
});

test('startup removes unreferenced valid and degraded snapshots while preserving every trash reference', async () => {
  const second = { ...trashRecord('session-b'), snapshotId: SECOND_PROTECTED_ID };
  const fixture = recycleFixture({
    records: [trashRecord(), second],
    inventoryValid: [
      { snapshotId: SNAPSHOT_ID, sessionId: 'session-a', createdAt: NOW },
      { snapshotId: SECOND_PROTECTED_ID, sessionId: 'session-b', createdAt: NOW },
      { snapshotId: LEGACY_VALID_ID, sessionId: 'old-session', createdAt: NOW },
    ],
    inventoryDegraded: [{ snapshotId: LEGACY_DEGRADED_ID, code: 'snapshot-schema-invalid' }],
  });
  writeFileSync(fixture.pendingPath, '{"ids":[]}\n');

  await fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath });

  assert.deepEqual(fixture.publishedSnapshotIds(), [SNAPSHOT_ID, SECOND_PROTECTED_ID]);
});

test('startup skips all legacy snapshot deletion when the trash authority is unreadable', async () => {
  const fixture = recycleFixture({
    inventoryValid: [{ snapshotId: LEGACY_VALID_ID, sessionId: 'old-session', createdAt: NOW }],
    inventoryDegraded: [{ snapshotId: LEGACY_DEGRADED_ID, code: 'snapshot-schema-invalid' }],
  });
  fixture.trashStore.load = async () => ({ status: 'unavailable', records: new Map() });

  await assert.rejects(
    fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath }),
    (cause) => cause?.code === 'trash-store-unavailable',
  );

  assert.deepEqual(fixture.publishedSnapshotIds(), [LEGACY_VALID_ID, LEGACY_DEGRADED_ID]);
  assert.deepEqual(fixture.calls.filter((call) => call.startsWith('snapshot:remove:')), []);
});

test('startup continues after one legacy snapshot deletion fails and retries it next time', async () => {
  const fixture = recycleFixture({
    inventoryValid: [{ snapshotId: LEGACY_VALID_ID, sessionId: 'old-session', createdAt: NOW }],
    inventoryDegraded: [{ snapshotId: LEGACY_DEGRADED_ID, code: 'snapshot-schema-invalid' }],
    snapshotRemoveFailures: { [LEGACY_VALID_ID]: 1 },
  });
  writeFileSync(fixture.pendingPath, '{"ids":[]}\n');

  await fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath });
  assert.deepEqual(fixture.publishedSnapshotIds(), [LEGACY_VALID_ID]);
  assert.equal(fixture.calls.some((call) => call.includes('Alpha') || call.includes('private snapshot removal detail')), false);

  await fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath });
  assert.deepEqual(fixture.publishedSnapshotIds(), []);
});

test('startup cleanup preserves the protection snapshot created by pending migration in the same run', async () => {
  const fixture = recycleFixture({
    inventoryValid: [{ snapshotId: LEGACY_VALID_ID, sessionId: 'old-session', createdAt: NOW }],
  });
  writeFileSync(fixture.pendingPath, '{"ids":["session-a"]}\n');

  await fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath });

  assert.deepEqual(fixture.publishedSnapshotIds(), [SNAPSHOT_ID]);
  assert.equal((await fixture.trashStore.get('session-a')).snapshotId, SNAPSHOT_ID);
});

test('purge failure retains durable purge-pending intent and keeps the original session', async () => {
  const fixture = recycleFixture({ trashed: true, purgeError: Object.assign(new Error('disk failed'), { code: 'purge-failed' }) });
  assert.deepEqual(await fixture.service.purge(['session-a']), { purged: [], failed: [{ id: 'session-a', reason: 'purge-failed' }] });
  assert.equal((await fixture.trashStore.get('session-a')).state, 'purge-pending');
  // The guarantee that matters after a failed purge is that the session itself
  // still exists, so the next attempt can finish the job.
  assert.equal(fixture.persistence.ids.has('session-a'), true);
});

test('purge never reports success when snapshot deletion fails, and never destroys the session first', async () => {
  for (const options of [
    { snapshotRemoveError: true, reason: 'snapshot-remove-failed' },
    { snapshotRemoveNoop: true, reason: 'snapshot-delete-unconfirmed' },
  ]) {
    const fixture = recycleFixture({ trashed: true, ...options });
    const result = await fixture.service.purge(['session-a']);
    assert.deepEqual(result, { purged: [], failed: [{ id: 'session-a', reason: options.reason }] });
    assert.equal((await fixture.trashStore.get('session-a')).state, 'purge-pending');
    assert.equal(fixture.persistence.ids.has('session-a'), true);
    assert.equal(fixture.calls.includes('physical:purge:session-a'), false);
  }
});

test('legacy migration removes only unarchived markers and preserves malformed or failed entries', async () => {
  const unarchived = recycleFixture({ unarchived: true });
  writeFileSync(unarchived.pendingPath, '{"ids":["session-a"]}\n');
  await unarchived.service.recoverStartup({ legacyPendingPath: unarchived.pendingPath });
  assert.equal(readFileSync(unarchived.pendingPath, 'utf8'), '{\n  "ids": []\n}\n');
  assert.equal(await unarchived.trashStore.get('session-a'), null);

  const failed = recycleFixture({ snapshotError: Object.assign(new Error('full'), { code: 'snapshot-write-failed' }) });
  writeFileSync(failed.pendingPath, '{"ids":["session-a"]}\n');
  await failed.service.recoverStartup({ legacyPendingPath: failed.pendingPath });
  assert.equal(readFileSync(failed.pendingPath, 'utf8'), '{"ids":["session-a"]}\n');

  const malformed = recycleFixture();
  writeFileSync(malformed.pendingPath, '{broken');
  assert.deepEqual(await malformed.service.recoverStartup({ legacyPendingPath: malformed.pendingPath }), { status: 'legacy-pending-unavailable' });
  assert.equal(readFileSync(malformed.pendingPath, 'utf8'), '{broken');
  assert.deepEqual(malformed.purgedIds, []);
});
