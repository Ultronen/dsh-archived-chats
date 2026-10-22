import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { apply as applyPlugin } from '../lib/index.js';
import { withLegacyFixtures } from './helpers/legacy-recycle-fixture.mjs';
const apply = withLegacyFixtures(applyPlugin);
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
    async unarchiveSession(id) { await this.setState({ ...this.state, archivedSessionIds: this.state.archivedSessionIds.filter(value => value !== id) }); },
    async setState(next) { this.state = next; },
  };
  const routes = new Map();
  const services = { workspaceRegistry: registry, sessionPersistence: raw,
    sessions: { get: () => undefined },
    webServer: { register({ path, handler }) { routes.set(path, handler); } } };
  let startScheduler;
  let recoveryFinished;
  const mount = () => apply({ get: key => services[key], on() {}, emit: (...args) => services.emit?.(...args), logger: { warn(message) { recoveryFinished?.(message); } },
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
      mount();
      // Retirement does not perform destructive startup work. Retry is explicit.
      const before = await trash.get('chat-a');
      if (before?.state === 'purge-pending') {
        assert.equal((await trash.get('chat-a')).state, 'purge-pending');
        await call('/trash/purge', { sessionIds: ['chat-a'] });
      }
    } };
}

const permanentlyDelete = f => f.call('/delete-all', { sessionIds: ['chat-a'], permanent: true });

for (const mode of ['single', 'all', 'ungrouped']) {
  test(`permanent ${mode} deletion never exposes archived chats in intermediate sidebar frames`, async t => {
    const f = await fixture(t);
    const ids = mode === 'all' ? ['chat-a', 'chat-b'] : ['chat-a'];
    const headers = new Map(ids.map(id => [id, { id, version: 1, createdAt: 10, cwd: f.root }]));
    const pathFor = id => join(f.root, 'sessions', id, 'session.jsonl');
    if (mode === 'all') {
      await mkdir(join(f.root, 'sessions', 'chat-b'));
      await writeFile(pathFor('chat-b'), 'second chat');
    }
    f.persistence.list = async () => [...headers.values()].filter(header => existsSync(pathFor(header.id)));
    f.persistence.locate = header => ({ kind: 'jsonl', path: pathFor(header.id) });
    f.persistence.inspect = async id => ({ meta: headers.get(id), events: [] });
    f.registry.state.archivedSessionIds = [...ids];
    f.registry.headers = new Map(headers);
    f.registry.sessionPaths = new Map(ids.map(id => [id, f.root]));
    const frames = [];
    // Two connected clients retain their own cold session.list baselines.
    // Workspace feed frames do not refresh these summaries in the Host.
    const clients = [new Set(ids), new Set(ids)];
    const sample = phase => frames.push({ phase,
      visible: clients.map(client => [...client].filter(id => !f.registry.archivedSessionIds.includes(id))),
    });
    const workspace = { id: 'ws-a', sessionIds: mode === 'ungrouped' ? [] : [...ids],
      async detachSession(id) { this.sessionIds = this.sessionIds.filter(value => value !== id); sample('workspace'); },
    };
    f.registry.list = () => [workspace];
    f.registry.setState = async next => { f.registry.state = next; sample('archive'); };
    const removals = [];
    f.services.emit = (name, id) => {
      if (name !== 'api-session/removed') return;
      assert.equal(existsSync(pathFor(id)), false, 'only confirmed physical deletion can remove a client summary');
      removals.push(id);
      for (const client of clients) client.delete(id);
      sample('removed');
    };
    const result = mode === 'all'
      ? await f.call('/delete-all', { sessionIds: ids, permanent: true })
      : await f.call('/delete', { sessionId: ids[0], permanent: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.deleted, ids);
    assert.ok(frames.every(frame => frame.visible.every(visible => visible.length === 0)), JSON.stringify(frames));
    assert.deepEqual(removals, ids);
    assert.deepEqual(workspace.sessionIds, []);
    assert.deepEqual(f.registry.archivedSessionIds, []);
    assert.equal(f.registry.headers.size, 0);
  });
}

test('failed deletion does not broadcast a removed session or unarchive it', async t => {
  const f = await fixture(t);
  const notifications = [];
  f.services.emit = (...args) => notifications.push(args);
  f.persistence.locate = () => ({ path: join(f.root, 'shared', 'session.jsonl') });
  const result = await permanentlyDelete(f);
  assert.equal(result.status, 409);
  assert.equal(await exists(f.path), true);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
  assert.deepEqual(notifications, []);
});

test('failed workspace detach keeps archive protection and deletion intent until explicit retry', async t => {
  const f = await fixture(t);
  const [header] = await f.persistence.list();
  f.registry.headers = new Map([['chat-a', header]]);
  let failDetach = true;
  let members = ['chat-a'];
  const workspace = {
    // Like the Host, membership visibility depends on the header index.
    get sessionIds() { return members.filter(id => f.registry.headers.has(id)); },
    async detachSession(id) {
      assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
      if (failDetach) throw new Error('simulated workspace write failure');
      members = members.filter(value => value !== id);
    },
  };
  f.registry.list = () => [workspace];
  const notifications = [];
  f.services.emit = (name, id) => {
    assert.equal(existsSync(f.path), false);
    notifications.push([name, id]);
  };
  const result = await permanentlyDelete(f);
  assert.equal(result.body.failed.length, 1);
  assert.equal(await exists(f.path), false);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
  assert.deepEqual(workspace.sessionIds, ['chat-a']);
  assert.deepEqual(JSON.parse(await readFile(join(f.data, 'pending-deletions.json'), 'utf8')).ids, ['chat-a']);
  assert.equal((await f.trash.get('chat-a'))?.state, 'purge-pending');

  failDetach = false;
  await f.restart();
  assert.deepEqual(members, []);
  assert.equal(f.registry.headers.size, 0);
  assert.deepEqual(f.registry.archivedSessionIds, []);
  assert.deepEqual(JSON.parse(await readFile(join(f.data, 'pending-deletions.json'), 'utf8')).ids, []);
  assert.equal(await f.trash.get('chat-a'), null);
  assert.deepEqual(notifications, [
    ['api-session/removed', 'chat-a'], ['api-session/removed', 'chat-a'],
  ]);
});

test('lineage excludes unrelated unarchived chats and empty workspaces without archives', async t => {
  const f = await fixture(t);
  f.registry.state.archivedSessionIds = [];
  f.registry.list = () => [{ id: 'empty-workspace', title: 'Empty workspace', path: f.root, sessionIds: [] }];
  const result = await f.call('/lineage');
  assert.equal(result.status, 200);
  assert.equal(result.body.nodeCount, 0);
  assert.deepEqual(result.body.roots, []);
  assert.deepEqual(result.body.workspaces, []);
  assert.equal(JSON.stringify(result.body).includes(f.root), false);
});

test('unreadable recycle metadata does not hide the official lineage inventory', async t => {
  const f = await fixture(t);
  await mkdir(f.data, { recursive: true });
  await writeFile(join(f.data, 'trash.json'), 'invalid json');
  const result = await f.call('/lineage');
  assert.equal(result.status, 200);
  assert.equal(result.body.trashStatus, 'unavailable');
  assert.equal(result.body.roots[0].id, 'chat-a');
  assert.equal(result.body.roots[0].status, 'archived');
});

test('archived ungrouped chats remain visible in archive and lineage despite matching workspace cwd', async t => {
  const f = await fixture(t);
  f.registry.list = () => [{ id: 'workspace-a', title: 'Workspace A', path: f.root, sessionIds: [] }];

  const archive = await f.call('/state');
  assert.equal(archive.status, 200);
  assert.deepEqual(archive.body.sessions.map(row => [row.id, row.workspaceId, row.workspaceTitle]),
    [['chat-a', null, null]]);

  const lineage = await f.call('/lineage');
  assert.equal(lineage.status, 200);
  assert.equal(lineage.body.roots[0].id, 'chat-a');
  assert.equal(lineage.body.roots[0].status, 'archived');
  assert.deepEqual(lineage.body.roots[0].workspace, { id: null, title: null });
});

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

test('a cold archive preview reads only its selected conversation', async t => {
  const f = await fixture(t);
  const originalInspect = f.persistence.inspect;
  const [header] = await f.persistence.list();
  f.persistence.list = async () => [header, { ...header, id: 'unrelated-archive' }];
  f.registry.state.archivedSessionIds.push('unrelated-archive');
  const reads = [];
  f.persistence.inspect = async id => {
    reads.push(id);
    return originalInspect(id);
  };

  const result = await f.call('/preview', { sessionId: 'chat-a' });
  assert.equal(result.status, 200);
  assert.equal(result.body.session.id, 'chat-a');
  assert.ok(result.body.messages.length > 0);
  assert.ok(reads.length > 0);
  assert.deepEqual([...new Set(reads)], ['chat-a']);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a', 'unrelated-archive']);
});

for (const route of ['/preview', '/preview/image']) {
  test(`a single unarchived ${route} reads only its selected conversation`, async t => {
    const f = await fixture(t);
    const originalInspect = f.persistence.inspect;
    const [header] = await f.persistence.list();
    f.persistence.list = async () => [header, { ...header, id: 'unrelated-unarchived' }];
    f.registry.state.archivedSessionIds = [];
    f.registry.archiveSession = async () => { throw new Error('read-only preview must not archive'); };
    const reads = [];
    f.persistence.inspect = async id => {
      reads.push(id);
      const inspected = await originalInspect(id);
      return { ...inspected, events: [...inspected.events, { seq: 4, type: 'turn/start', data: {} }] };
    };

    const result = await f.call(route, { sessionId: 'chat-a', scope: 'unarchived', attachmentId: 'missing-image' });
    if (route === '/preview') {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.session.id, 'chat-a');
      assert.ok(result.body.messages.length > 0);
    } else {
      assert.equal(result.status, 404);
      assert.equal(result.body.error, 'preview-image-not-found');
    }
    assert.ok(reads.length > 0);
    assert.deepEqual([...new Set(reads)], ['chat-a']);
    assert.deepEqual(f.registry.archivedSessionIds, []);
  });
}

test('pending deletion is excluded before an unarchived preview reads conversation content', async t => {
  const f = await fixture(t);
  f.registry.state.archivedSessionIds = [];
  f.registry.archiveSession = async () => {};
  await mkdir(f.data, { recursive: true });
  await writeFile(join(f.data, 'pending-deletions.json'), JSON.stringify({ ids: ['chat-a'] }));
  let reads = 0;
  const originalInspect = f.persistence.inspect;
  f.persistence.inspect = async id => { reads++; return originalInspect(id); };
  const result = await f.call('/preview', { sessionId: 'chat-a', scope: 'unarchived' });
  assert.equal(result.status, 404);
  assert.equal(reads, 0);
});

test('a pending-deletion archive cannot be previewed or read for its title', async t => {
  const f = await fixture(t);
  await mkdir(f.data, { recursive: true });
  await writeFile(join(f.data, 'pending-deletions.json'), JSON.stringify({ ids: ['chat-a'] }));
  let reads = 0;
  const originalInspect = f.persistence.inspect;
  f.persistence.inspect = async id => { reads++; return originalInspect(id); };

  const result = await f.call('/preview', { sessionId: 'chat-a' });
  assert.equal(result.status, 404);
  assert.equal(reads, 0);
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
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
  const move = await f.call('/__test_seed_legacy_trash', { sessionId: 'chat-a' });
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
  await f.call('/__test_seed_legacy_trash', { sessionId: 'chat-a' });
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
  assert.deepEqual((await f.call('/__test_seed_legacy_trash', { sessionId: 'chat-a' })).body.trashed, ['chat-a']);
  assert.deepEqual((await f.call('/trash/restore', { sessionIds: ['chat-a'] })).body.restored, ['chat-a']);
  assert.equal((await f.snapshots.inventory()).valid.length, 1);
  assert.deepEqual((await permanentlyDelete(f)).body.deleted, ['chat-a']);
  assert.equal(await exists(f.path), false);
  assert.equal((await f.snapshots.inventory()).valid.length, 0);
  assert.equal((await f.trash.load()).records.size, 0);
});

test('failed cold permanent deletion keeps durable intent and completes on explicit retry after restart without the original header', async t => {
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
  await f.call('/__test_seed_legacy_trash', { sessionId: 'chat-a' });
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
  assert.deepEqual((await f.call('/__test_seed_legacy_trash', { sessionId: 'chat-a' })).body.trashed, ['chat-a']);
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

test('unarchive delegates to official queue and preserves intervening Host state', async t => {
  const f = await fixture(t);
  let called = 0;
  f.registry.setState = async () => { throw new Error('plugin must not directly overwrite registry state'); };
  f.registry.unarchiveSession = async id => {
    called++;
    await Promise.resolve();
    f.registry.state = { ...f.registry.state, archivedSessionIds: ['another-official-archive'], pinnedSessionIds: ['new-pin'] };
    assert.equal(id, 'chat-a');
  };
  const result = await f.call('/unarchive-all', { sessionIds: ['chat-a', 'chat-a'] });
  assert.equal(result.status, 200);
  assert.equal(called, 1);
  assert.deepEqual(result.body.archivedSessionIds, ['another-official-archive']);
  assert.deepEqual(f.registry.state.pinnedSessionIds, ['new-pin']);
});

test('missing official unarchive capability fails without direct state writes', async t => {
  const f = await fixture(t);
  f.registry.unarchiveSession = undefined;
  const result = await f.call('/unarchive', { sessionId: 'chat-a' });
  assert.equal(result.status, 501);
  assert.equal(result.body.error, 'unarchive-unsupported');
  assert.deepEqual(f.registry.archivedSessionIds, ['chat-a']);
});
