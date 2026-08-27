import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestoreAdapter } from '../lib/restore.js';

function item(id, workspaceId = 'ws-1') {
  return {
    id,
    title: `Title ${id}`,
    workspace: workspaceId === null ? null : { id: workspaceId, title: 'Workspace' },
    tags: ['tag'],
    note: `note ${id}`,
    record: {
      format: 'dsh-archived-chats/session',
      version: 1,
      archive: { id, title: `Title ${id}` },
      source: { meta: { id }, events: [{ type: 'session/title', data: { title: `Title ${id}` } }] },
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restore-test-'));
  const state = { archivedSessionIds: ['existing'] };
  const writes = [];
  const removed = [];
  const metadata = new Map();
  const workspaceIds = new Set();
  const registry = {
    state,
    get archivedSessionIds() { return state.archivedSessionIds; },
    list: () => [{
      id: 'ws-1', title: 'Workspace', sessionIds: workspaceIds,
      attachSession: async (id) => { workspaceIds.add(id); writes.push({ attach: id }); },
      detachSession: async (id) => { workspaceIds.delete(id); writes.push({ detach: id }); },
    }],
    async setState(next) { state.archivedSessionIds = next.archivedSessionIds; },
  };
  const metadataStore = {
    async getMany(ids) {
      const entries = {};
      for (const id of ids) if (metadata.has(id)) entries[id] = metadata.get(id);
      return { status: 'ready', entries };
    },
    async set(id, value) { metadata.set(id, { ...value, updatedAt: 'now' }); writes.push({ metadata: id }); return metadata.get(id); },
    async remove(ids) { for (const id of ids) { metadata.delete(id); writes.push({ metadataRemove: id }); } },
  };
  const persistence = {
    async restoreSession(payload) {
      writes.push(payload);
      return async () => { removed.push(payload.id); };
    },
    async removeSession(id) { removed.push(id); },
    async inspect(id) { return { meta: { id }, events: [] }; },
  };
  return { root, state, writes, removed, metadata, registry, metadataStore, persistence };
}

test('restore adapter stages records and commits persistence, metadata, and archive state', async () => {
  const f = await fixture();
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  assert.equal(adapter.capability.supported, true);
  const tx = await adapter.prepare([item('session-a'), item('session-b', null)], { knownIds: new Set(['existing']) });
  await tx.stage(item('session-a'));
  await tx.stage(item('session-b', null));
  const result = await tx.commit();
  assert.deepEqual(result.restored, ['session-a', 'session-b']);
  assert.deepEqual(f.state.archivedSessionIds, ['existing', 'session-a', 'session-b']);
  assert.equal(f.writes.filter((entry) => entry.metadata).length, 2);
  assert.ok(result.warnings.some((warning) => warning.id === 'session-b' && warning.reason === 'workspace-unresolved'));
  assert.deepEqual(await readdir(f.root), []);
  await rm(f.root, { recursive: true, force: true });
});

test('unsupported host never writes', async () => {
  const f = await fixture();
  const adapter = createRestoreAdapter({ persistence: { inspect: f.persistence.inspect }, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  assert.deepEqual(adapter.capability, { supported: false, reason: 'writer-missing' });
  await assert.rejects(() => adapter.prepare([item('a')], { knownIds: new Set() }), (error) => error.code === 'restore-unsupported');
  assert.deepEqual(f.writes, []);
  await rm(f.root, { recursive: true, force: true });
});

test('writer without a preflight rollback capability is rejected before writing', async () => {
  const f = await fixture();
  const persistence = { restoreSession: f.persistence.restoreSession, inspect: f.persistence.inspect };
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  assert.deepEqual(adapter.capability, { supported: false, reason: 'rollback-missing' });
  await assert.rejects(() => adapter.prepare([item('a')]), (error) => error.code === 'restore-unsupported');
  assert.deepEqual(f.writes, []);
  await rm(f.root, { recursive: true, force: true });
});

test('unavailable metadata rejects preparation before staging or persistence writes', async () => {
  const f = await fixture();
  f.metadataStore.getMany = async () => ({ status: 'unavailable', entries: {} });
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  await assert.rejects(() => adapter.prepare([item('a')]), (error) => error.code === 'metadata-store-unavailable' && error.status === 503);
  assert.deepEqual(f.writes, []);
  await rm(f.root, { recursive: true, force: true });
});

test('staging capability failures clean temporary records before returning', async () => {
  const f = await fixture();
  f.persistence.inspect = async () => { throw Object.assign(new Error('inspect failed'), { code: 'inspect-failed' }); };
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('a')]);
  await assert.rejects(() => tx.stage(item('a')), (error) => error.code === 'inspect-failed');
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(f.writes, []);
  await rm(f.root, { recursive: true, force: true });
});

test('commit failure rolls back persistence, metadata, archive state, and staging files', async () => {
  const f = await fixture();
  let count = 0;
  f.persistence.restoreSession = async (payload) => {
    f.writes.push(payload);
    count += 1;
    if (count === 2) throw Object.assign(new Error('writer failed'), { code: 'writer-failed' });
    return async () => { f.removed.push(payload.id); };
  };
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('a'), item('b')], { knownIds: new Set() });
  await tx.stage(item('a'));
  await tx.stage(item('b'));
  await assert.rejects(() => tx.commit(), /writer failed/);
  assert.deepEqual(f.state.archivedSessionIds, ['existing']);
  assert.deepEqual(f.removed, ['b', 'a']);
  assert.deepEqual(await readdir(f.root), []);
  await rm(f.root, { recursive: true, force: true });
});

test('metadata failure after a Host write removes the session and detaches its workspace', async () => {
  const f = await fixture();
  f.metadataStore.set = async (id, value) => {
    f.metadata.set(id, { ...value, updatedAt: 'now' });
    throw Object.assign(new Error('metadata failed'), { code: 'metadata-failed' });
  };
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('a')]);
  await tx.stage(item('a'));
  await assert.rejects(() => tx.commit(), /metadata failed/);
  assert.deepEqual(f.removed, ['a']);
  assert.equal(f.metadata.has('a'), false);
  assert.ok(f.writes.some((entry) => entry.attach === 'a'));
  assert.ok(f.writes.some((entry) => entry.detach === 'a'));
  assert.deepEqual(f.state.archivedSessionIds, ['existing']);
  await rm(f.root, { recursive: true, force: true });
});

test('workspace attachment is skipped with a warning unless detach is available', async () => {
  const f = await fixture();
  f.registry.list = () => [{ id: 'ws-1', sessionIds: [], attachSession: async (id) => { f.writes.push({ attach: id }); } }];
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('a')]);
  await tx.stage(item('a'));
  const result = await tx.commit();
  assert.ok(result.warnings.some((entry) => entry.id === 'a' && entry.reason === 'workspace-unresolved'));
  assert.equal(f.writes.some((entry) => entry.attach === 'a'), false);
  await rm(f.root, { recursive: true, force: true });
});

test('restore reports warnings for missing workspaces and attachment references', async () => {
  const f = await fixture();
  const record = item('missing-workspace', 'ws-missing');
  record.hasAttachmentReferences = true;
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([record], { knownIds: new Set() });
  await tx.stage(record);
  const result = await tx.commit();
  assert.ok(result.warnings.some((warning) => warning.id === 'missing-workspace' && warning.reason === 'workspace-unresolved'));
  assert.ok(result.warnings.some((warning) => warning.id === 'missing-workspace' && warning.reason === 'attachments-not-included'));
  await rm(f.root, { recursive: true, force: true });
});
