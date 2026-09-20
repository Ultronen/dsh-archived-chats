import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRestoreAdapter } from '../lib/restore.js';
import { resolvePersistenceCompat } from '../lib/persistence-compat.js';

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
      source: {
        meta: { version: 3, id, createdAt: 42, cwd: join(tmpdir(), 'dsh-restore-workspace'), isSeeded: false },
        events: [{ seq: 0, time: 42, type: 'session/title', data: { title: `Title ${id}` } }],
      },
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

test('dedicated writer establishes rollback ownership by returning an undo', async () => {
  const f = await fixture();
  const persistence = { restoreSession: f.persistence.restoreSession, inspect: f.persistence.inspect };
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  assert.deepEqual(adapter.capability, { supported: true });
  const tx = await adapter.prepare([item('a')]);
  await tx.stage(item('a'));
  assert.deepEqual((await tx.commit()).restored, ['a']);
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

test('a legacy create/append host without exclusive creation is refused before writing', async () => {
  const f = await fixture();
  const created = [];
  const appended = [];
  let createdEntry = null;
  const persistence = {
    list: async () => createdEntry === null ? [] : [createdEntry],
    inspect: async (id) => { throw Object.assign(new Error('no log yet'), { code: 'ENOENT', id }); },
    create: async (meta) => {
      created.push(meta.id);
      createdEntry = meta;
      const path = join(f.root, 'sessions', String(meta.id), 'session.jsonl.zstd');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'header');
    },
    append: async (id, events) => { appended.push([id, events.length]); },
    locate: (meta) => ({ kind: 'jsonl', path: join(f.root, 'sessions', String(meta.id), 'session.jsonl.zstd') }),
    removeSession: async (id) => { f.removed.push(id); },
  };
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  assert.deepEqual(adapter.capability, { supported: false, reason: 'exclusive-create-missing' });
  await assert.rejects(adapter.prepare([item('session-x')]), { code: 'restore-unsupported' });
  assert.deepEqual(created, []);
  assert.deepEqual(appended, []);
  assert.deepEqual(f.state.archivedSessionIds, ['existing']);
  await rm(f.root, { recursive: true, force: true });
});

test('the create and append writer refuses a destination that is not session-scoped', async () => {
  const f = await fixture();
  const persistence = {
    list: async () => [],
    createExclusive: async () => {},
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
  await assert.rejects(tx.commit(), { code: 'restore-rollback-failed' });
  assert.deepEqual(f.state.archivedSessionIds, ['existing']);
  assert.deepEqual(f.removed, ['a']);
  assert.deepEqual(await readdir(f.root), []);
  await rm(f.root, { recursive: true, force: true });
});

test('a rejected dedicated writer never authorizes removal of an unowned destination', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.persistence.restoreSession = async () => { throw Object.assign(new Error('already exists'), { code: 'id-conflict' }); };
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const record = item('foreign');
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), { code: 'id-conflict' });
  assert.deepEqual(f.removed, []);
});

test('metadata failure after a Host write removes the session and detaches its workspace', async () => {
  const f = await fixture();
  let projectionCalls = 0;
  f.metadataStore.set = async (id, value) => {
    f.metadata.set(id, { ...value, updatedAt: 'now' });
    throw Object.assign(new Error('metadata failed'), { code: 'metadata-failed' });
  };
  const adapter = createRestoreAdapter({
    persistence: f.persistence,
    registry: f.registry,
    metadataStore: f.metadataStore,
    tempRoot: f.root,
    ctx: { get() { projectionCalls += 1; return undefined; } },
  });
  const tx = await adapter.prepare([item('a')]);
  await tx.stage(item('a'));
  await assert.rejects(() => tx.commit(), /metadata failed/);
  assert.deepEqual(f.removed, ['a']);
  assert.equal(f.metadata.has('a'), false);
  assert.ok(f.writes.some((entry) => entry.attach === 'a'));
  assert.ok(f.writes.some((entry) => entry.detach === 'a'));
  assert.deepEqual(f.state.archivedSessionIds, ['existing']);
  assert.equal(projectionCalls, 0, 'a rolled-back raw write is never published to the optional cache');
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
    async create(meta) {
      calls.create.push(meta.id);
      sessions.set(String(meta.id), { meta, events: [] });
      const path = persistence.locate(meta).path;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'header');
    },
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

test('legacy Host surface without exclusive creation is refused before writing', async () => {
  const f = await fixture();
  const host = realHostSurface(f.root);
  for (const absent of ['restoreSession', 'restore', 'importSession', 'removeSession', 'deleteSession', 'remove']) {
    assert.equal(host.persistence[absent], undefined, `${absent} is absent on the real Host surface`);
  }
  const adapter = createRestoreAdapter({ persistence: host.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  assert.deepEqual(adapter.capability, { supported: false, reason: 'exclusive-create-missing' });
  await assert.rejects(adapter.prepare([item('session-x')]), { code: 'restore-unsupported' });
  assert.deepEqual(host.calls.create, []);
  assert.deepEqual(host.calls.append, []);
  await rm(f.root, { recursive: true, force: true });
});

test('a commit failure on the real Host surface rolls the created session back off disk', async () => {
  const f = await fixture();
  const host = realHostSurface(f.root);
  // No removeSession exists, so rollback must fall back to removing the
  // session-scoped directory — never the shared project parent above it.
  const sessionDirectory = join(f.root, 'sessions', '--proj--', 'session-x');
  const sibling = join(f.root, 'sessions', '--proj--', 'other-session');
  await mkdir(sibling, { recursive: true });
  f.metadataStore.set = async () => { throw Object.assign(new Error('metadata down'), { code: 'metadata-store-unavailable' }); };

  const persistence = { ...host.persistence, createExclusive: host.persistence.create };
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([item('session-x')]);
  await tx.stage(item('session-x'));
  await assert.rejects(() => tx.commit(), (error) => error.code === 'metadata-store-unavailable');
  assert.equal(existsSync(sessionDirectory), false, 'the restored session directory is removed');
  assert.equal(existsSync(sibling), true, 'a sibling session in the same project directory is untouched');
  assert.deepEqual(f.state.archivedSessionIds, ['existing'], 'the archive set is restored');
  await rm(f.root, { recursive: true, force: true });
});

// Modern handle contract, with actual temporary files to check compensation.
function modernHost(root, { fail = null } = {}) {
  const sessions = new Map();
  const handles = new Set();
  const raw = {
    async list() { return [...sessions.values()].map(s => ({ header: s.meta, revision: 'modern' })); },
    async open(id, access) {
      assert.equal(access, 'read');
      const stored = sessions.get(id);
      if (!stored) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return { header: stored.meta, inheritedEventCount: stored.cut, read: async () => ({ events: stored.events }), close: async () => {} };
    },
    locate(meta) { return { kind: 'jsonl', path: join(root, 'sessions', meta.id, 'session.jsonl') }; },
    async create(meta, options) {
      if (fail === 'create-conflict') throw Object.assign(new Error('already exists'), { code: 'SESSION_ALREADY_EXISTS' });
      const stored = { meta, cut: options.inheritedEventCount, events: [] };
      sessions.set(meta.id, stored);
      const handle = { id: meta.id, header: meta, access: 'write', inheritedEventCount: options.inheritedEventCount,
        async append(events) {
          if (fail === 'second-append' && stored.events.length) throw new Error('second append failed');
          assert.equal(events[0].seq, stored.events.length);
          stored.events.push(...events);
          await mkdir(join(root, 'sessions', meta.id), { recursive: true });
          await writeFile(raw.locate(meta).path, JSON.stringify(stored));
          if (fail === 'publication') throw new Error('fsync failed after publication');
        },
        async flush() {
          if (fail === 'flush') throw new Error('flush failed');
          await mkdir(join(root, 'sessions', meta.id), { recursive: true });
          await writeFile(raw.locate(meta).path, JSON.stringify(stored));
        },
        async read() { return { events: stored.events }; },
        async close() { handles.delete(handle); },
      };
      handles.add(handle);
      return handle;
    },
  };
  return { raw, handles };
}

function modernItem(id, count = 1) {
  const record = item(id);
  record.record.source = { meta: { id, version: 3, createdAt: 42, isSeeded: false },
    events: Array.from({ length: count }, (_, seq) => ({ seq, time: 42, type: 'session/title', data: { title: `title ${seq}` } })) };
  return record;
}

test('modern restore flushes an empty log and releases ownership', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const host = modernHost(f.root);
  const adapter = createRestoreAdapter({ ...f, persistence: resolvePersistenceCompat(host.raw), tempRoot: f.root });
  const record = modernItem('empty', 0);
  const tx = await adapter.prepare([record]); await tx.stage(record);
  assert.deepEqual((await tx.commit()).restored, ['empty']);
  assert.equal(host.handles.size, 0);
  assert.equal(existsSync(host.raw.locate(record.record.source.meta).path), true);
});

for (const fail of ['second-append', 'flush']) test(`modern restore rolls back owned logs on ${fail} failure`, async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const host = modernHost(f.root, { fail });
  const record = modernItem('new-chat', 501);
  const adapter = createRestoreAdapter({ ...f, persistence: resolvePersistenceCompat(host.raw), tempRoot: f.root });
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), /failed/);
  assert.equal(host.handles.size, 0);
  assert.equal(existsSync(join(f.root, 'sessions', record.id)), false);
  assert.deepEqual(f.registry.archivedSessionIds, ['existing']);
});

test('uncertain first-write publication reports incomplete rollback instead of silently leaving a conflicting log', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const host = modernHost(f.root, { fail: 'publication' });
  const record = modernItem('uncertain-chat');
  const adapter = createRestoreAdapter({ ...f, persistence: resolvePersistenceCompat(host.raw), tempRoot: f.root });
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), { code: 'restore-rollback-failed' });
  assert.equal(host.handles.size, 0);
  assert.equal(existsSync(host.raw.locate(record.record.source.meta).path), true);
  assert.deepEqual(f.registry.archivedSessionIds, ['existing']);
});

test('modern create conflicts cannot authorize a fallback remover', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const host = modernHost(f.root, { fail: 'create-conflict' });
  const persistence = { ...resolvePersistenceCompat(host.raw), removeSession: f.persistence.removeSession };
  const adapter = createRestoreAdapter({ ...f, persistence, tempRoot: f.root });
  const record = modernItem('existing-elsewhere');
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), /already exists/);
  assert.deepEqual(f.removed, []);
});

test('legacy writers refuse modern inherited backups instead of flattening the fork', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const record = modernItem('fork');
  record.record.version = 2;
  record.record.source.meta.isSeeded = true;
  record.record.source.inheritedEventCount = 1;
  const adapter = createRestoreAdapter({ ...f, tempRoot: f.root });
  await assert.rejects(adapter.prepare([record]), { code: 'restore-unsupported' });
  assert.deepEqual(f.writes, []);
});

test('legacy and dedicated writers refuse seeded v1 backups before writing', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const record = item('ambiguous-fork');
  record.record.source.meta.isSeeded = true;
  const legacy = realHostSurface(f.root).persistence;
  for (const persistence of [f.persistence, { ...legacy, createExclusive: legacy.create }]) {
    const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
    await assert.rejects(adapter.prepare([record]), (error) => error.code === 'restore-unsupported' && error.reason === 'inherited-boundary-unsupported');
  }
  assert.deepEqual(f.writes, []);
});

test('legacy append failure rolls back immediately after successful exclusive creation', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = join(f.root, 'sessions', 'partial');
  const path = join(directory, 'session.jsonl');
  await mkdir(dirname(directory), { recursive: true });
  let created = false;
  const persistence = {
    async list() { return created ? [{ id: 'partial' }] : []; },
    locate() { return { path }; },
    async createExclusive() { created = true; await mkdir(directory, { recursive: true }); await writeFile(path, 'header'); },
    async append() { await writeFile(path, 'partial'); throw new Error('append failed'); },
  };
  const record = item('partial');
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), /append failed/);
  assert.equal(existsSync(directory), false);
  assert.deepEqual(f.registry.archivedSessionIds, ['existing']);
});

test('legacy successful create with unverifiable ownership is retained and reported as incomplete rollback', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = join(f.root, 'sessions', 'uncertain');
  const path = join(directory, 'session.jsonl');
  await mkdir(dirname(directory), { recursive: true });
  let created = false;
  const persistence = {
    async list() { return []; },
    locate() { return { path }; },
    async createExclusive() { created = true; await mkdir(directory, { recursive: true }); await writeFile(path, 'header'); },
    async append() { throw new Error('must not append'); },
  };
  const record = item('uncertain');
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), { code: 'restore-rollback-failed' });
  assert.equal(created, true);
  assert.equal(existsSync(directory), true);
  assert.deepEqual(f.registry.archivedSessionIds, ['existing']);
});

test('legacy restore refuses an unlisted pre-existing destination before exclusive creation', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = join(f.root, 'sessions', 'foreign');
  const path = join(directory, 'session.jsonl');
  await mkdir(directory, { recursive: true });
  await writeFile(path, 'foreign');
  let createCalls = 0;
  const persistence = {
    async list() { return []; },
    locate() { return { path }; },
    async createExclusive() { createCalls += 1; await writeFile(path, 'overwritten'); },
    async append() { throw new Error('must not append'); },
  };
  const record = item('foreign');
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), (error) => error.code === 'id-conflict');
  assert.equal(createCalls, 0);
  assert.equal(await readFile(path, 'utf8'), 'foreign');
});

test('legacy exclusive create that materializes then rejects retains the artifact and reports uncertainty', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = join(f.root, 'sessions', 'uncertain-exclusive');
  const path = join(directory, 'session.jsonl');
  await mkdir(dirname(directory), { recursive: true });
  let created = false;
  const persistence = {
    async list() { return []; },
    locate() { return { path }; },
    async createExclusive() {
      created = true;
      await mkdir(directory, { recursive: true });
      await writeFile(path, 'uncertain');
      throw new Error('create durability failed');
    },
    async append() { throw new Error('must not append'); },
  };
  const record = item('uncertain-exclusive');
  const adapter = createRestoreAdapter({ persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), { code: 'restore-rollback-failed' });
  assert.equal(created, true);
  assert.equal(existsSync(directory), true);
});

test('dedicated writer that materializes then rejects retains the artifact and reports uncertainty', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const directory = join(f.root, 'sessions', 'uncertain-dedicated');
  f.persistence.restoreSession = async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.jsonl'), 'uncertain');
    throw new Error('dedicated durability failed');
  };
  const record = item('uncertain-dedicated');
  const adapter = createRestoreAdapter({ persistence: f.persistence, registry: f.registry, metadataStore: f.metadataStore, tempRoot: f.root });
  const tx = await adapter.prepare([record]); await tx.stage(record);
  await assert.rejects(tx.commit(), { code: 'restore-rollback-failed' });
  assert.equal(existsSync(directory), true);
  assert.deepEqual(f.removed, []);
});

test('modern restore rejects same-count event or immutable header mutation before publication', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const mutation of ['event', 'header']) {
    const host = modernHost(f.root);
    const originalCreate = host.raw.create;
    host.raw.create = async (...args) => {
      const handle = await originalCreate(...args);
      if (mutation === 'event') handle.read = async () => ({ events: [{ ...args[0], type: 'mutated' }] });
      else handle.header = { ...handle.header, createdAt: 999 };
      return handle;
    };
    const persistence = resolvePersistenceCompat(host.raw);
    const record = modernItem(`mutated-${mutation}`);
    const adapter = createRestoreAdapter({ ...f, persistence, tempRoot: f.root });
    const tx = await adapter.prepare([record]); await tx.stage(record);
    await assert.rejects(tx.commit(), (error) => error.code === 'restore-unsupported' && error.reason === 'restored-log-invalid');
    assert.equal(f.registry.archivedSessionIds.includes(record.id), false);
  }
});

async function commitWithProjection(t, records, projectionCache, titlePublicationTimeoutMs = 40) {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const requestedServices = [];
  const adapter = createRestoreAdapter({
    ...f,
    ctx: { get(key) { requestedServices.push(key); return key === 'sessionProjectionCache' ? projectionCache : undefined; } },
    titlePublicationTimeoutMs,
    tempRoot: f.root,
  });
  const tx = await adapter.prepare(records);
  for (const record of records) await tx.stage(record);
  return { result: await tx.commit(), requestedServices };
}

test('restore reports title publication only after the exact public cache observation', async t => {
  const record = item('published-title');
  let cached;
  const calls = [];
  const cache = {
    coldSnapshot(meta, cut, events) {
      calls.push({ kind: 'cold', meta, cut, events });
      cached = { asOfSeq: 0, values: { title: 'Title published-title' } };
      return cached;
    },
    cachedSnapshot(meta, cut, keys) {
      calls.push({ kind: 'cached', meta, cut, keys });
      return cached;
    },
  };

  const { result, requestedServices } = await commitWithProjection(t, [record], cache);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls[0], {
    kind: 'cold', meta: record.record.source.meta, cut: 0, events: record.record.source.events,
  });
  assert.deepEqual(calls[1], {
    kind: 'cached', meta: record.record.source.meta, cut: 0, keys: ['title'],
  });
  assert.deepEqual(requestedServices, ['sessionProjectionCache']);
});

test('bulk restore starts every cold fold before waiting for delayed cache writes', async t => {
  const records = [item('delayed-a'), item('delayed-b')];
  const ready = new Map(records.map(record => [record.id, { asOfSeq: -1, values: { title: `Title ${record.id}` } }]));
  const cold = [];
  let cachedReads = 0;
  const cache = {
    coldSnapshot(meta) {
      cold.push(meta.id);
      setTimeout(() => ready.set(meta.id, { asOfSeq: 0, values: { title: `Title ${meta.id}` } }), 10);
      return { asOfSeq: 0, values: { title: `Title ${meta.id}` } };
    },
    cachedSnapshot(meta) {
      assert.equal(cold.length, 2, 'all fire-and-forget folds start before observation polling');
      cachedReads += 1;
      return ready.get(meta.id);
    },
  };

  const { result } = await commitWithProjection(t, records, cache, 100);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(cold, ['delayed-a', 'delayed-b']);
  assert.ok(cachedReads > 2, 'a stale same-title checkpoint is not accepted before its watermark advances');
});

test('optional projection cache failures degrade restore without rolling data back', async t => {
  const cases = [
    ['cache-unavailable', undefined],
    ['cold-fold-failed', { coldSnapshot() { throw new Error('cache offline'); }, cachedSnapshot() {} }],
    ['projection-missing', { coldSnapshot: () => ({ asOfSeq: 0, values: {} }), cachedSnapshot: () => undefined }],
    ['cache-timeout', { coldSnapshot: () => ({ asOfSeq: 0, values: { title: 'Title degraded' } }), cachedSnapshot: () => undefined }],
  ];
  for (const [detail, cache] of cases) {
    await t.test(detail, async t => {
      const record = item(`degraded-${detail}`);
      record.record.source.events[0].data.title = 'Title degraded';
      const { result } = await commitWithProjection(t, [record], cache, 15);
      assert.deepEqual(result.restored, [record.id]);
      assert.deepEqual(result.warnings, [{
        id: record.id,
        reason: 'title-publication-degraded',
        detail,
      }]);
    });
  }
});

test('cold title publication preserves a fork cut and never activates sessions or agents', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const host = modernHost(f.root);
  const record = modernItem('cold-fork', 2);
  record.record.source.meta.isSeeded = true;
  record.record.source.meta.parentSession = 'missing-parent';
  record.record.source.inheritedEventCount = 1;
  let observed;
  const cache = {
    coldSnapshot(meta, cut, events) {
      observed = { meta, cut, events };
      return { asOfSeq: 1, values: { title: 'title 1' } };
    },
    cachedSnapshot() { return { asOfSeq: 1, values: { title: 'title 1' } }; },
  };
  const requestedServices = [];
  const adapter = createRestoreAdapter({
    ...f,
    persistence: resolvePersistenceCompat(host.raw),
    ctx: { get(key) { requestedServices.push(key); return key === 'sessionProjectionCache' ? cache : undefined; } },
    titlePublicationTimeoutMs: 20,
    tempRoot: f.root,
  });
  const tx = await adapter.prepare([record]); await tx.stage(record);

  const result = await tx.commit();

  assert.deepEqual(result.warnings, [{
    id: 'cold-fork',
    reason: 'title-publication-degraded',
    detail: 'seeded-cold-list-unsupported',
  }]);
  assert.equal(observed.cut, 1);
  assert.deepEqual(observed.meta, record.record.source.meta);
  assert.deepEqual(observed.events, record.record.source.events);
  assert.deepEqual(requestedServices, ['sessionProjectionCache']);
});
