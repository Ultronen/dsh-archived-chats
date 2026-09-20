import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { apply } from '../lib/index.js';
import { createSnapshotStore } from '../lib/snapshot.js';
import { createTrashStore } from '../lib/trash.js';
import { resolvePersistenceCompat } from '../lib/persistence-compat.js';

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// Real routes and disk-backed plugin stores; only the external Host is stubbed.
async function fixture(t, { modern = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dac-lifecycle-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers) dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const data = join(root, 'plugin-data', 'archived-chats');
  const path = join(root, 'sessions', 'chat-a', 'session.jsonl');
  await mkdir(join(root, 'sessions', 'chat-a'), { recursive: true });
  await writeFile(path, 'original');
  const header = modern
    ? { id: 'chat-a', version: 3, createdAt: 10, cwd: root, isSeeded: true, parentSession: 'parent' }
    : { id: 'chat-a', version: 1, createdAt: 10, cwd: root };
  const events = [
    { seq: 0, type: 'session/title', data: { title: 'Greeting from user' } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'inherited hello' }] } },
    { seq: 2, type: 'session/title', data: { title: 'Greeting from user (1)' } },
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'child reasoning' }, { type: 'text', text: 'child reply' }] } } },
  ];
  const persistence = {
    async list() { return await exists(path) ? [header] : []; },
    async inspect() { await access(path); return { meta: header, events }; },
    locate: () => ({ kind: 'jsonl', path }),
  };
  const reads = { opened: 0, closed: 0 };
  const raw = modern ? {
    async list() { return [{ header, revision: 'fork-revision' }]; },
    locate: persistence.locate,
    async open() {
      reads.opened++;
      return { header, inheritedEventCount: 2,
        async read() { return { events }; }, async close() { reads.closed++; } };
    },
  } : persistence;
  const registry = {
    state: { archivedSessionIds: ['chat-a'], workspaceIds: [] },
    get archivedSessionIds() { return this.state.archivedSessionIds; },
    list: () => [],
    async setState(next) { this.state = next; },
  };
  const routes = new Map();
  const services = { workspaceRegistry: registry, sessionPersistence: raw,
    sessions: { get: () => undefined },
    webServer: { register({ path, handler }) { routes.set(path, handler); } } };
  let startScheduler;
  let recoveryFinished;
  const mount = () => apply({ get: key => services[key], on() {}, logger: { warn(message) { recoveryFinished?.(message); } },
    effect(fn, label) {
      if (label === 'archived-chats: automatic recycle cleanup') startScheduler = () => disposers.push(fn());
      else fn();
    } });
  mount();
  async function call(route, body) {
    const req = new EventEmitter();
    req.method = body === undefined ? 'GET' : 'POST';
    req.headers = { 'x-dsh-archived-chats': '1' };
    let status; let result;
    const res = { writeHead(code) { status = code; }, end(value) { result = JSON.parse(value); } };
    queueMicrotask(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
    await routes.get('/plugins/dsh-archived-chats' + route)(req, res);
    return { status, body: result };
  }
  const snapshots = createSnapshotStore({ root: join(data, 'snapshots'), persistence });
  const trash = createTrashStore({ path: join(data, 'trash.json') });
  return { root, data, path, registry, persistence: raw, services, reads, call, snapshots, trash,
    async restart() {
      // Make the post-recovery scan report completion, so cleanup never races
      // an unawaited startup task. Recovery must not depend on policy validity.
      await writeFile(join(data, 'retention.json'), 'unavailable policy');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('startup did not finish')), 2000);
        recoveryFinished = message => { clearTimeout(timer); resolve(message); };
        mount(); startScheduler();
      });
    } };
}

const permanentlyDelete = f => f.call('/delete-all', { sessionIds: ['chat-a'], permanent: true });

test('single unarchive keeps a cwd-less cold chat reachable in Archived', async t => {
  const f = await fixture(t);
  const [header] = await f.persistence.list();
  delete header.cwd;

  const before = await readFile(f.path, 'utf8');
  const result = await f.call('/unarchive', { sessionId: 'chat-a' });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    error: 'session-main-list-unreachable',
    message: 'session cannot be published in the main chat list',
    reason: 'cwd-missing',
    sessionIds: ['chat-a'],
  });
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
  assert.equal(await readFile(f.path, 'utf8'), before);
});

test('batch unarchive prevalidates every archived header before one state write', async t => {
  const f = await fixture(t);
  const [valid] = await f.persistence.list();
  const blocked = { ...valid, id: 'chat-b' };
  delete blocked.cwd;
  f.registry.state.archivedSessionIds = ['chat-a', 'chat-b'];
  f.persistence.list = async () => [valid, blocked];
  let writes = 0;
  const setState = f.registry.setState.bind(f.registry);
  f.registry.setState = async next => { writes += 1; await setState(next); };

  const result = await f.call('/unarchive-all', { sessionIds: ['chat-a', 'chat-b'] });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'session-main-list-unreachable');
  assert.equal(result.body.reason, 'cwd-missing');
  assert.deepEqual(result.body.sessionIds, ['chat-b']);
  assert.equal(writes, 0);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a', 'chat-b']);
});

test('unarchive fails closed when the persisted header authority is unavailable', async t => {
  const f = await fixture(t);
  f.persistence.list = async () => { throw new Error('inventory offline'); };

  const result = await f.call('/unarchive', { sessionId: 'chat-a' });

  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: 'session-reachability-unavailable',
    message: 'session reachability cannot be verified',
    reason: 'header-inventory-unavailable',
    sessionIds: ['chat-a'],
  });
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
});

test('unarchive fails closed when its authoritative persisted header is absent', async t => {
  const f = await fixture(t);
  f.persistence.list = async () => [];

  const result = await f.call('/unarchive', { sessionId: 'chat-a' });

  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'session-reachability-unavailable');
  assert.equal(result.body.reason, 'session-header-unavailable');
  assert.deepEqual(result.body.sessionIds, ['chat-a']);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
});

test('single unarchive cannot clear a legacy pending deletion reservation', async t => {
  const f = await fixture(t);
  const pendingPath = join(f.data, 'pending-deletions.json');
  await mkdir(f.data, { recursive: true });
  await writeFile(pendingPath, `${JSON.stringify({ ids: ['chat-a'] })}\n`);

  const result = await f.call('/unarchive', { sessionId: 'chat-a' });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'session-deletion-pending');
  assert.deepEqual(result.body.sessionIds, ['chat-a']);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, 'utf8')).ids, ['chat-a']);
});

test('batch unarchive rejects a mixed pending scope before any archive write', async t => {
  const f = await fixture(t);
  const [header] = await f.persistence.list();
  f.registry.state.archivedSessionIds = ['chat-a', 'chat-b'];
  f.persistence.list = async () => [header, { ...header, id: 'chat-b' }];
  await mkdir(f.data, { recursive: true });
  await writeFile(join(f.data, 'pending-deletions.json'), `${JSON.stringify({ ids: ['chat-b'] })}\n`);
  let writes = 0;
  const setState = f.registry.setState.bind(f.registry);
  f.registry.setState = async next => { writes += 1; await setState(next); };

  const result = await f.call('/unarchive-all', { sessionIds: ['chat-a', 'chat-b'] });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'session-deletion-pending');
  assert.deepEqual(result.body.sessionIds, ['chat-b']);
  assert.equal(writes, 0);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a', 'chat-b']);
});

test('fork previews include inherited history and child reasoning without permitting lossy ZIP reads', async t => {
  const f = await fixture(t, { modern: true });
  const state = await f.call('/state');
  assert.equal(state.body.sessions[0].title, 'Greeting from user (1)');
  await assert.rejects(resolvePersistenceCompat(f.persistence).inspect('chat-a'), { code: 'session-inspection-unsupported' });
  const preview = await f.call('/preview', { sessionId: 'chat-a' });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.messages.map(m => [m.role, m.segments.map(s => s.text)]), [
    ['user', ['inherited hello']], ['assistant', ['child reasoning', 'child reply']],
  ]);
  assert.equal(f.reads.opened, f.reads.closed);
  assert.equal(await readFile(f.path, 'utf8'), 'original');
});

test('fork recycle captures the inherited cut and restores the original archive without rewriting it', async t => {
  const f = await fixture(t, { modern: true });
  const move = await f.call('/delete', { sessionId: 'chat-a' });
  assert.deepEqual(move.body.failed, []);
  assert.deepEqual(move.body.trashed, ['chat-a']);
  const record = await f.trash.get('chat-a');
  assert.equal(record.title, 'Greeting from user (1)');
  const checked = await f.snapshots.validate(record.snapshotId);
  assert.equal(checked.record.version, 2);
  assert.equal(checked.record.source.inheritedEventCount, 2);
  assert.equal(checked.record.source.meta.parentSession, 'parent');
  assert.equal(checked.record.source.events[1].data.content[0].text, 'inherited hello');
  const preview = await f.call('/preview', { sessionId: 'chat-a', scope: 'trash' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.messages[1].role, 'assistant');
  const restored = await f.call('/trash/restore', { sessionIds: ['chat-a'] });
  assert.deepEqual(restored.body.restored, ['chat-a']);
  assert.equal(await f.trash.get('chat-a'), null);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
  assert.equal(f.reads.opened, f.reads.closed);
  assert.equal(await readFile(f.path, 'utf8'), 'original');
  assert.deepEqual((await permanentlyDelete(f)).body.deleted, ['chat-a']);
  assert.equal(await exists(f.path), false);
});

test('unreadable deletion authority never removes an archived original', async t => {
  const f = await fixture(t);
  await mkdir(f.data, { recursive: true });
  await writeFile(join(f.data, 'trash.json'), 'unreadable authority');
  const result = await permanentlyDelete(f);
  assert.equal(result.body.failed[0].reason, 'trash-store-unavailable');
  assert.equal(await exists(f.path), true);
  assert.equal(await exists(join(f.data, 'pending-deletions.json')), false);
});

test('snapshot cleanup failure preserves the original and durable intent until a later purge succeeds', async t => {
  const f = await fixture(t);
  await f.call('/delete', { sessionId: 'chat-a' });
  await f.call('/trash/restore', { sessionIds: ['chat-a'] });
  const snapshotRoot = join(f.data, 'snapshots');
  const savedRoot = join(f.data, 'snapshots-saved');
  await rename(snapshotRoot, savedRoot);
  await writeFile(snapshotRoot, 'simulate unavailable snapshot directory');
  const failed = await permanentlyDelete(f);
  assert.equal(failed.body.failed.length, 1);
  assert.equal(await exists(f.path), true);
  assert.equal((await f.trash.get('chat-a')).state, 'purge-pending');
  await rm(snapshotRoot);
  await rename(savedRoot, snapshotRoot);
  assert.deepEqual((await f.call('/trash/purge', { sessionIds: ['chat-a'] })).body.purged, ['chat-a']);
  assert.equal(await exists(f.path), false);
  assert.equal((await f.snapshots.inventory()).valid.length, 0);
});

test('permanent archive deletion removes snapshots left by an earlier recycle and restore', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/delete', { sessionId: 'chat-a' })).body.trashed, ['chat-a']);
  assert.deepEqual((await f.call('/trash/restore', { sessionIds: ['chat-a'] })).body.restored, ['chat-a']);
  assert.equal((await f.snapshots.inventory()).valid.length, 1);
  assert.deepEqual((await permanentlyDelete(f)).body.deleted, ['chat-a']);
  assert.equal(await exists(f.path), false);
  assert.equal((await f.snapshots.inventory()).valid.length, 0);
  assert.equal((await f.trash.load()).records.size, 0);
});

test('failed cold permanent deletion keeps durable intent and completes after restart without the original header', async t => {
  const f = await fixture(t);
  const save = f.registry.setState;
  f.registry.setState = async () => { throw new Error('simulated state write failure'); };
  const result = await permanentlyDelete(f);
  assert.equal(result.body.failed.length, 1);
  assert.equal(await exists(f.path), false);
  assert.equal((await f.trash.get('chat-a'))?.state, 'purge-pending');
  assert.deepEqual((await f.call('/state')).body.sessions, []);
  f.registry.setState = save;
  await f.restart();
  assert.equal(await f.trash.get('chat-a'), null);
  assert.deepEqual(f.registry.archivedSessionIds, []);
  assert.deepEqual(JSON.parse(await readFile(join(f.data, 'pending-deletions.json'), 'utf8')).ids, []);
});

test('archive permanent deletion cannot bypass an existing Recycle Bin record', async t => {
  const f = await fixture(t);
  await f.call('/delete', { sessionId: 'chat-a' });
  const before = await f.trash.get('chat-a');
  const result = await permanentlyDelete(f);
  assert.equal(result.status, 409);
  assert.equal(result.body.failed[0].reason, 'session-in-trash');
  assert.deepEqual(await f.trash.get('chat-a'), before);
  assert.equal(await exists(f.path), true);
  assert.equal((await f.snapshots.inventory()).valid.length, 1);
});

test('Empty Recycle Bin rejects an absent confirmation scope without changing data', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/delete', { sessionId: 'chat-a' })).body.trashed, ['chat-a']);
  const before = await f.trash.get('chat-a');

  const result = await f.call('/trash/empty', {});

  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'trashTargets-required');
  assert.deepEqual(await f.trash.get('chat-a'), before);
  assert.equal(await exists(f.path), true);
});

test('unsupported or unsafe direct deletion fails before recording intent or disposing a live chat', async t => {
  for (const unsafe of [false, true]) {
    await t.test(unsafe ? 'shared directory' : 'no locate capability', async t => {
      const f = await fixture(t);
      f.services.sessions.get = () => ({ header: { id: 'chat-a' } });
      f.persistence.locate = unsafe ? () => ({ path: join(f.root, 'shared', 'session.jsonl') }) : undefined;
      const result = await permanentlyDelete(f);
      assert.equal(result.status, 409);
      assert.equal(result.body.failed[0].reason, unsafe ? 'session-location-unsafe' : 'purge-unsupported');
      assert.equal(await exists(f.path), true);
      assert.equal((await f.trash.load()).records.size, 0);
      assert.equal(await exists(join(f.data, 'pending-deletions.json')), false);
    });
  }
});

test('permanent deletion rejects another session located inside the requested directory before intent', async t => {
  const f = await fixture(t);
  const [requested] = await f.persistence.list();
  const other = { ...requested, id: 'chat-b' };
  const otherPath = join(f.root, 'sessions', 'chat-a', 'other.jsonl');
  await writeFile(otherPath, 'other session');
  f.persistence.list = async () => [requested, other];
  f.persistence.locate = (header) => ({ kind: 'jsonl', path: header.id === 'chat-a' ? f.path : otherPath });

  const result = await permanentlyDelete(f);

  assert.equal(result.status, 409);
  assert.equal(result.body.failed[0].reason, 'session-location-unsafe');
  assert.equal(await exists(f.path), true);
  assert.equal(await readFile(otherPath, 'utf8'), 'other session');
  assert.equal((await f.trash.load()).records.size, 0);
  assert.equal(await exists(join(f.data, 'pending-deletions.json')), false);
});

test('permanent deletion rejects a symlinked session-root ancestor before intent', async t => {
  const f = await fixture(t);
  const [requested] = await f.persistence.list();
  const actualBase = join(f.root, 'actual-base');
  const actualRoot = join(actualBase, 'sessions');
  const actualDirectory = join(actualRoot, 'chat-a');
  const actualPath = join(actualDirectory, 'session.jsonl');
  const linkedBase = join(f.root, 'linked-base');
  await mkdir(actualDirectory, { recursive: true });
  await writeFile(actualPath, 'linked original');
  await symlink(actualBase, linkedBase, process.platform === 'win32' ? 'junction' : 'dir');
  f.persistence.list = async () => [requested];
  f.persistence.locate = () => ({ kind: 'jsonl', path: join(linkedBase, 'sessions', 'chat-a', 'session.jsonl') });

  const result = await permanentlyDelete(f);

  assert.equal(result.status, 409);
  assert.equal(result.body.failed[0].reason, 'session-location-unsafe');
  assert.equal(await readFile(actualPath, 'utf8'), 'linked original');
  assert.equal((await f.trash.load()).records.size, 0);
  assert.equal(await exists(join(f.data, 'pending-deletions.json')), false);
});

test('physical deletion rechecks exclusivity when another session appears after preflight', async t => {
  const f = await fixture(t);
  const [requested] = await f.persistence.list();
  const other = { ...requested, id: 'chat-b' };
  const otherPath = join(f.root, 'sessions', 'chat-a', 'other.jsonl');
  await writeFile(otherPath, 'late session');
  let inventories = 0;
  f.persistence.list = async () => {
    inventories += 1;
    return inventories < 4 ? [requested] : [requested, other];
  };
  f.persistence.locate = (header) => ({ kind: 'jsonl', path: header.id === 'chat-a' ? f.path : otherPath });

  const result = await permanentlyDelete(f);

  assert.equal(result.status, 409);
  assert.equal(result.body.failed[0].reason, 'session-location-unsafe');
  assert.deepEqual(result.body.pending, ['chat-a']);
  assert.equal(await exists(f.path), true);
  assert.equal(await readFile(otherPath, 'utf8'), 'late session');
  assert.equal((await f.trash.get('chat-a')).state, 'purge-pending');
});
