import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

test('staging tolerates a reader that fails closed on the not-yet-restored id', async () => {
  const f = await fixture();
  // The staged id does not exist yet, so a session reader that rejects unknown
  // ids is the expected answer — it is a capability probe, not a precondition.
  f.persistence.inspect = async () => { throw Object.assign(new Error('inspect failed'), { code: 'inspect-failed' }); };
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('a')]);
  await tx.stage(item('a'));
  assert.deepEqual((await tx.commit()).restored, ['a']);
  assert.deepEqual(await readdir(f.root), []);
  await rm(f.root, { recursive: true, force: true });
});

test('staging rejects a record that was never prepared and cleans its staging directory', async () => {
  const f = await fixture();
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('a')]);
  await assert.rejects(() => tx.stage(item('unprepared')), (error) => error.code === 'restore-record-unknown');
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(f.writes, []);
  await rm(f.root, { recursive: true, force: true });
});

test('a host without a restore entry point still restores through create and append', async () => {
  const f = await fixture();
  const created = [];
  const appended = [];
  const persistence = {
    list: async () => [],
    inspect: async (id) => { throw Object.assign(new Error('no log yet'), { code: 'ENOENT', id }); },
    create: async (meta) => { created.push(meta.id); },
    append: async (id, events) => { appended.push([id, events.length]); },
    locate: (meta) => ({ kind: 'jsonl', path: join(f.root, 'sessions', String(meta.id), 'session.jsonl.zstd') }),
    removeSession: async (id) => { f.removed.push(id); },
  };
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  assert.deepEqual(adapter.capability, { supported: true });
  const tx = await adapter.prepare([item('session-x')]);
  await tx.stage(item('session-x'));
  assert.deepEqual((await tx.commit()).restored, ['session-x']);
  assert.deepEqual(created, ['session-x']);
  assert.deepEqual(appended, [['session-x', 1]]);
  assert.deepEqual(f.state.archivedSessionIds, ['existing', 'session-x']);
  await rm(f.root, { recursive: true, force: true });
});

test('the create and append writer refuses a destination that is not session-scoped', async () => {
  const f = await fixture();
  const persistence = {
    list: async () => [],
    create: async () => {},
    append: async () => {},
    // A flat layout gives no session-owned directory to roll back, so the write
    // must be refused rather than risk removing a shared parent.
    locate: (meta) => ({ kind: 'jsonl', path: join(f.root, `${meta.id}.jsonl`) }),
  };
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('session-x')]);
  await tx.stage(item('session-x'));
  await assert.rejects(() => tx.commit(), (error) => error.code === 'restore-unsupported');
  assert.deepEqual(f.state.archivedSessionIds, ['existing']);
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

/**
 * The exact method surface of the Host's `SessionPersistence` service
 * (@deepseek-ai/dsh-session-persistence 0.1.x): append, create, inspect, list,
 * listSnapshots, load, locate, prepare, readFrom, readRaw — and NOTHING else.
 * There is no `restoreSession`/`restore`/`importSession`, and no
 * `removeSession`/`deleteSession`/`remove`. A restore adapter that requires any
 * of those is permanently unsupported on every real Host, which is exactly how
 * ZIP import shipped broken. This fixture is the guard against that returning.
 */
function realHostSurface(root, { sessions = new Map() } = {}) {
  const calls = { create: [], append: [] };
  const persistence = {
    async append(id, events) { calls.append.push([id, events.length]); sessions.get(id).events.push(...events); },
    async create(meta) { calls.create.push(meta.id); sessions.set(String(meta.id), { meta, events: [] }); },
    async inspect(id) {
      const entry = sessions.get(String(id));
      // A session that does not exist yet reads as missing, like the real backend.
      if (entry === undefined) throw Object.assign(new Error(`unknown session ${id}`), { code: 'ENOENT' });
      return { meta: entry.meta, events: entry.events };
    },
    async list() { return [...sessions.values()].map((entry) => entry.meta); },
    async listSnapshots() { return [...sessions.values()].map((entry) => ({ header: entry.meta, revision: 'rev-1' })); },
    async load(id) { return persistence.inspect(id); },
    // Real layout: <root>/<project-slug>/<session-id>/session.jsonl.zstd — the
    // per-session directory is the deepest level, and it is shared-parent safe.
    locate: (meta) => ({ kind: 'jsonl', path: join(root, 'sessions', '--proj--', String(meta.id), 'session.jsonl.zstd') }),
    async prepare() { throw new Error('not used'); },
    async readFrom(id, fromSeq) {
      const entry = sessions.get(String(id));
      return { meta: entry.meta, events: entry.events.filter((event) => event.seq >= fromSeq) };
    },
    async readRaw() { return undefined; },
  };
  return { persistence, calls, sessions };
}

test('restore is supported on the real Host surface, which exposes no restore or remove entry point', async () => {
  const f = await fixture();
  const host = realHostSurface(f.root);
  for (const absent of ['restoreSession', 'restore', 'importSession', 'removeSession', 'deleteSession', 'remove']) {
    assert.equal(host.persistence[absent], undefined, `${absent} is absent on the real Host surface`);
  }
  const adapter = createRestoreAdapter({ persistence: host.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  assert.deepEqual(adapter.capability, { supported: true });

  const tx = await adapter.prepare([item('session-x')]);
  await tx.stage(item('session-x'));
  assert.deepEqual((await tx.commit()).restored, ['session-x']);
  assert.deepEqual(host.calls.create, ['session-x']);
  assert.deepEqual(host.calls.append, [['session-x', 1]]);
  assert.deepEqual(f.state.archivedSessionIds, ['existing', 'session-x']);
  await rm(f.root, { recursive: true, force: true });
});

test('a commit failure on the real Host surface rolls the created session back off disk', async () => {
  const f = await fixture();
  const host = realHostSurface(f.root);
  // No removeSession exists, so rollback must fall back to removing the
  // session-scoped directory — never the shared project parent above it.
  const sessionDirectory = join(f.root, 'sessions', '--proj--', 'session-x');
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, 'session.jsonl.zstd'), 'written', 'utf8');
  const sibling = join(f.root, 'sessions', '--proj--', 'other-session');
  await mkdir(sibling, { recursive: true });
  f.metadataStore.set = async () => { throw Object.assign(new Error('metadata down'), { code: 'metadata-store-unavailable' }); };

  const adapter = createRestoreAdapter({ persistence: host.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('session-x')]);
  await tx.stage(item('session-x'));
  await assert.rejects(() => tx.commit(), (error) => error.code === 'metadata-store-unavailable');
  assert.equal(existsSync(sessionDirectory), false, 'the restored session directory is removed');
  assert.equal(existsSync(sibling), true, 'a sibling session in the same project directory is untouched');
  assert.deepEqual(f.state.archivedSessionIds, ['existing'], 'the archive set is restored');
  await rm(f.root, { recursive: true, force: true });
});
