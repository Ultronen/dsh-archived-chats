import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHistoryRestoreService, HistoryRestoreError } from '../lib/history-restore.js';

const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000001';
const SOURCE_ID = 'session-a';
const DESTINATION_ID = 'session-restored';
const NOW = '2026-08-25T00:00:00.000Z';
const imageRef = { attachmentId: 'image-a', mediaType: 'image/png', bytes: 4, width: 2, height: 2, name: 'a.png' };
const tempRoots = new Set();
test.after(async () => Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dac-history-restore-'));
  tempRoots.add(root);
  let currentMs = Date.parse(NOW);
  let manifestRevision = 'rev-a';
  const calls = [];
  const sourceEvents = [
    { seq: 0, type: 'session/start', data: {} },
    {
      seq: 1,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'user-a',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: imageRef }],
        businessRecord: { attachmentId: 'image-a', status: 'keep' },
      },
    },
    { seq: 2, type: 'session/title', data: { title: 'Alpha' } },
  ];
  const checked = () => ({
    manifest: {
      format: 'dsh-archived-chats/snapshot', version: 1, snapshotId: SNAPSHOT_ID,
      sessionId: SOURCE_ID, createdAt: NOW, reason: 'trash', sourceRevision: manifestRevision,
      session: { file: 'session.json', bytes: 100, sha256: 'a'.repeat(64) },
      attachments: options.withAttachment === false ? [] : [{ ...imageRef, file: 'attachments/001.png', sha256: 'b'.repeat(64) }],
      totalBytes: 104,
    },
    record: {
      format: 'dsh-archived-chats/snapshot-session', version: 1,
      archive: {
        title: 'Alpha', createdAt: 1000, origin: null,
        workspace: { id: 'workspace-a', title: 'Workspace A', path: '/project' },
        wasArchived: true, tags: ['important'], note: 'keep context', metadataUpdatedAt: NOW,
      },
      source: { meta: { id: SOURCE_ID, version: 1, cwd: '/project', createdAt: 1000 }, events: structuredClone(sourceEvents) },
      attachments: options.withAttachment === false ? [] : [structuredClone(imageRef)],
    },
    attachments: options.withAttachment === false ? [] : [{
      descriptor: { ...imageRef, file: 'attachments/001.png', sha256: 'b'.repeat(64) },
      path: join(root, 'snapshot-image'),
      data: new Uint8Array([1, 2, 3, 4]),
    }],
  });
  const snapshotStore = {
    validateCalls: 0,
    async validate(snapshotId) {
      calls.push('validate');
      this.validateCalls += 1;
      if (snapshotId !== SNAPSHOT_ID) throw Object.assign(new Error('missing'), { code: 'snapshot-missing', status: 404 });
      return structuredClone(checked());
    },
  };
  const ids = new Set([SOURCE_ID]);
  const persistence = {
    created: [], appended: [],
    async list() { return [...ids].map((id) => ({ id })); },
    locate(meta) { return { kind: 'jsonl', path: join(root, meta.id, 'session.jsonl.zstd') }; },
    async create(meta) {
      calls.push('create');
      ids.add(meta.id);
      this.created.push(structuredClone(meta));
      if (options.failCreate) throw Object.assign(new Error('create failed'), { code: 'create-failed' });
    },
    async append(id, events) {
      calls.push('append');
      if (options.failAppend) throw Object.assign(new Error('append failed'), { code: 'append-failed' });
      this.appended.push(...structuredClone(events));
    },
    async removeSession(id) { calls.push('remove'); ids.delete(id); },
  };
  const workspace = {
    id: 'workspace-a', title: 'Workspace A', path: '/project', sessionIds: new Set([SOURCE_ID]),
    async attachSession(id) { calls.push('workspace'); this.sessionIds.add(id); if (options.failWorkspace) throw Object.assign(new Error('workspace failed'), { code: 'workspace-failed' }); },
    async detachSession(id) { calls.push('workspace-undo'); this.sessionIds.delete(id); },
  };
  const registry = {
    state: { archivedSessionIds: [SOURCE_ID], workspaceIds: ['workspace-a'] },
    get archivedSessionIds() { return this.state.archivedSessionIds; },
    list: () => options.missingWorkspace ? [] : [workspace],
    async setState(next) {
      calls.push('registry');
      this.state = structuredClone(next);
      if (options.failRegistry && next.archivedSessionIds.includes(DESTINATION_ID)) throw Object.assign(new Error('registry failed'), { code: 'registry-failed' });
    },
  };
  const metadata = new Map([[SOURCE_ID, { tags: ['important'], note: 'keep context', updatedAt: NOW }]]);
  const metadataStore = {
    async getMany(requested) {
      const entries = {};
      for (const id of requested) if (metadata.has(id)) entries[id] = structuredClone(metadata.get(id));
      return { status: 'ready', entries };
    },
    async set(id, value) { calls.push('metadata'); metadata.set(id, { ...structuredClone(value), updatedAt: NOW }); if (options.failMetadata) throw Object.assign(new Error('metadata failed'), { code: 'metadata-failed' }); },
    async remove(requested) { calls.push('metadata-undo'); for (const id of requested) metadata.delete(id); },
  };
  const attachments = {
    async saveImage(input) {
      calls.push('attachments');
      if (options.failAttachment) throw Object.assign(new Error('attachment failed'), { code: 'attachment-failed' });
      return {
        ...imageRef,
        attachmentId: options.rewriteAttachment ? 'image-restored' : imageRef.attachmentId,
        width: options.attachmentMismatch ? 3 : imageRef.width,
        bytes: input.data.byteLength,
        mediaType: input.mediaType,
        ...(input.name === undefined ? {} : { name: input.name }),
      };
    },
  };
  const secrets = ['token-a', 'nonce-a'];
  const service = createHistoryRestoreService({
    snapshotStore, persistence, attachments, registry, metadataStore,
    lifecycle: { run: (operation) => operation() },
    invalidate: (restored, source) => calls.push(`invalidate:${restored}:${source}`),
    logger: { warn() {} },
    now: () => new Date(currentMs),
    uuid: () => DESTINATION_ID,
    secret: () => secrets.shift(),
  });
  return {
    service, calls, snapshotStore, persistence, workspace, registry, metadata, ids,
    sourceEvents, advance(ms) { currentMs += ms; }, changeManifest() { manifestRevision = 'rev-b'; },
  };
}

test('prepare binds a Host-generated destination and restore consumes the token once', async () => {
  const item = await fixture({ rewriteAttachment: true });
  const sourceBefore = structuredClone(item.sourceEvents);

  const prepared = await item.service.prepare(SNAPSHOT_ID);
  assert.equal(prepared.destination.sessionId, DESTINATION_ID);
  assert.equal(prepared.snapshot.snapshotId, SNAPSHOT_ID);
  assert.equal(prepared.snapshot.title, 'Alpha');
  assert.equal(JSON.stringify(prepared).includes('events'), false);
  assert.equal(JSON.stringify(prepared).includes('/project'), false);

  const restored = await item.service.restore(prepared.token, prepared.nonce);
  assert.deepEqual(restored, {
    restored: [DESTINATION_ID],
    sourceSessionId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    warnings: [],
  });
  assert.deepEqual(item.persistence.created, [{ id: DESTINATION_ID, version: 1, cwd: '/project', createdAt: 1000 }]);
  assert.equal(item.persistence.appended[1].data.content[0].attachment.attachmentId, 'image-restored');
  assert.deepEqual(item.persistence.appended[1].data.businessRecord, { attachmentId: 'image-a', status: 'keep' });
  assert.equal(item.workspace.sessionIds.has(DESTINATION_ID), true);
  assert.deepEqual(
    { tags: item.metadata.get(DESTINATION_ID).tags, note: item.metadata.get(DESTINATION_ID).note },
    { tags: ['important'], note: 'keep context' },
  );
  assert.equal(item.registry.archivedSessionIds.at(-1), DESTINATION_ID);
  assert.deepEqual(item.calls.slice(1), ['validate', 'create', 'attachments', 'append', 'workspace', 'metadata', 'registry', `invalidate:${DESTINATION_ID}:${SOURCE_ID}`]);
  assert.deepEqual(item.sourceEvents, sourceBefore);
  assert.equal(item.snapshotStore.validateCalls, 2);
  await assert.rejects(
    item.service.restore(prepared.token, prepared.nonce),
    (error) => error instanceof HistoryRestoreError && error.code === 'history-restore-expired',
  );
});

test('wrong nonce, expiry, and changed manifest fail before persistence writes', async () => {
  const wrong = await fixture();
  const wrongPrepared = await wrong.service.prepare(SNAPSHOT_ID);
  await assert.rejects(wrong.service.restore(wrongPrepared.token, 'wrong'), (error) => error.code === 'history-restore-expired');
  assert.equal(wrong.persistence.created.length, 0);

  const expired = await fixture();
  const expiredPrepared = await expired.service.prepare(SNAPSHOT_ID);
  expired.advance(300_001);
  await assert.rejects(expired.service.restore(expiredPrepared.token, expiredPrepared.nonce), (error) => error.code === 'history-restore-expired');
  assert.equal(expired.persistence.created.length, 0);

  const stale = await fixture();
  const stalePrepared = await stale.service.prepare(SNAPSHOT_ID);
  stale.changeManifest();
  await assert.rejects(stale.service.restore(stalePrepared.token, stalePrepared.nonce), (error) => error.code === 'history-restore-stale');
  assert.equal(stale.persistence.created.length, 0);
});

test('append failure rolls back the new session and preserves source registry state', async () => {
  const item = await fixture({ failAppend: true });
  const prepared = await item.service.prepare(SNAPSHOT_ID);

  await assert.rejects(item.service.restore(prepared.token, prepared.nonce), (error) => error.code === 'append-failed');

  assert.equal(item.ids.has(DESTINATION_ID), false);
  assert.deepEqual(item.registry.archivedSessionIds, [SOURCE_ID]);
  assert.equal(item.workspace.sessionIds.has(DESTINATION_ID), false);
  assert.equal(item.metadata.has(DESTINATION_ID), false);
  assert.equal(item.calls.includes('remove'), true);
});

test('missing workspace restores an ungrouped archived copy with a warning', async () => {
  const item = await fixture({ missingWorkspace: true, withAttachment: false });
  const prepared = await item.service.prepare(SNAPSHOT_ID);
  assert.deepEqual(prepared.warnings, [{ id: DESTINATION_ID, reason: 'workspace-unresolved' }]);

  const restored = await item.service.restore(prepared.token, prepared.nonce);

  assert.deepEqual(restored.warnings, [{ id: DESTINATION_ID, reason: 'workspace-unresolved' }]);
  assert.equal(item.registry.archivedSessionIds.includes(DESTINATION_ID), true);
});

test('each failed commit boundary removes the partial destination and restores plugin state', async () => {
  for (const options of [
    { failCreate: true, expected: 'create-failed' },
    { failAttachment: true, expected: 'attachment-failed' },
    { attachmentMismatch: true, expected: 'history-attachment-identity-mismatch' },
    { failWorkspace: true, expected: 'workspace-failed' },
    { failMetadata: true, expected: 'metadata-failed' },
    { failRegistry: true, expected: 'registry-failed' },
  ]) {
    const item = await fixture(options);
    const prepared = await item.service.prepare(SNAPSHOT_ID);

    await assert.rejects(item.service.restore(prepared.token, prepared.nonce), (error) => error.code === options.expected);

    assert.equal(item.ids.has(DESTINATION_ID), false, options.expected);
    assert.deepEqual(item.registry.archivedSessionIds, [SOURCE_ID], options.expected);
    assert.equal(item.workspace.sessionIds.has(DESTINATION_ID), false, options.expected);
    assert.equal(item.metadata.has(DESTINATION_ID), false, options.expected);
  }
});

test('unsupported Host writers keep the plugin loadable and reject preparation without writes', async () => {
  let validations = 0;
  const service = createHistoryRestoreService({
    snapshotStore: { async validate() { validations += 1; return {}; } },
    persistence: { async list() { return []; } },
    attachments: null,
    registry: { archivedSessionIds: [], state: { archivedSessionIds: [] }, list: () => [] },
    metadataStore: { async getMany() { return { status: 'ready', entries: {} }; }, async set() {}, async remove() {} },
    lifecycle: { run: (operation) => operation() },
  });

  assert.deepEqual(service.capability, { supported: false, reason: 'writer-missing' });
  await assert.rejects(service.prepare(SNAPSHOT_ID), (error) => error.code === 'history-restore-unsupported' && error.status === 501);
  assert.equal(validations, 0);
});
