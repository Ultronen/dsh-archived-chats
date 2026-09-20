import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { apply } from '../lib/index.js';
import { createExportZip, planExport } from '../lib/export.js';
import { createTrashStore } from '../lib/trash.js';

// Opt in to the installed official backend without depending on a user's store.
// DSH_NATIVE_MODULE_ROOT points at the Host's node_modules directory.
const nativeRoot = process.env.DSH_NATIVE_MODULE_ROOT;
if (process.env.DSH_REQUIRE_NATIVE === '1' && !nativeRoot) {
  throw new Error('DSH_NATIVE_MODULE_ROOT is required for native release validation');
}
const native = async name => import(pathToFileURL(join(nativeRoot, '@deepseek-ai', name, 'lib/index.js')));

async function smallBackup(id, root) {
  const meta = { version: 3, id, createdAt: 42, cwd: root, isSeeded: false };
  const events = [{ seq: 0, time: 42, type: 'session/title', data: { title: 'Backup title' } }];
  const zip = await createExportZip({ plan: planExport([{ id, title: 'Backup title', workspaceId: 'ws-backup', workspaceTitle: 'Backup workspace' }]),
    inspect: async () => ({ meta, events, inheritedEventCount: 0 }), generatorVersion: 'test' });
  const [bytes] = await Promise.all([buffer(zip.stream), zip.completion]);
  return { bytes, meta, events };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dac-backup-native-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const { Context } = await native('cordis');
  const { default: Persistence } = await native('dsh-session-persistence-jsonl');
  const ctx = new Context();
  const raw = new Persistence(ctx, { root: join(root, 'sessions') });
  t.after(async () => {
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const workspace = { id: 'ws-backup', title: 'Backup workspace', sessionIds: [],
    async attachSession(id) { this.sessionIds.push(id); },
    async detachSession(id) { this.sessionIds = this.sessionIds.filter(value => value !== id); } };
  const registry = { state: { archivedSessionIds: [], workspaceIds: [workspace.id] },
    get archivedSessionIds() { return this.state.archivedSessionIds; },
    list: () => [workspace], get: id => id === workspace.id ? workspace : undefined,
    async setState(state) { this.state = state; } };
  const routes = new Map();
  const services = { workspaceRegistry: registry, sessionPersistence: raw,
    sessions: { get: () => undefined },
    webServer: { register({ path, handler }) { routes.set(path, handler); } } };
  apply({ get: key => services[key], on() {}, logger: { warn() {} },
    effect(fn, label) { if (label !== 'archived-chats: automatic recycle cleanup') fn(); } });
  async function call(path, body, headers = {}) {
    const req = new EventEmitter();
    req.method = body === undefined ? 'GET' : 'POST';
    req.headers = { 'x-dsh-archived-chats': '1', ...headers };
    const res = new PassThrough();
    let status;
    res.writeHead = code => { status = code; return res; };
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    const ended = once(res, 'end');
    queueMicrotask(() => {
      if (body !== undefined) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
    await routes.get('/plugins/dsh-archived-chats' + path)(req, res);
    await ended;
    const bytes = Buffer.concat(chunks);
    return { status, bytes, json: () => JSON.parse(bytes) };
  }
  async function inspect(bytes) {
    const boundary = 'dac-native-backup';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await call('/import/inspect', body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    assert.equal(response.status, 200, response.bytes.toString());
    return response.json();
  }
  return { root, raw, registry, workspace, call, inspect };
}

test('official modern backend: export, permanent delete, import, preview, unarchive, and reopen', { skip: !nativeRoot }, async t => {
  const f = await fixture(t);
  const id = 'session-native-backup';
  const header = { version: 3, id, createdAt: 42, cwd: f.root, isSeeded: false };
  const events = [
    { seq: 0, time: 42, type: 'session/title', data: { title: 'Greeting to coding assistant' } },
    { seq: 1, time: 43, type: 'user/message', surfaceOp: 'append', data: { id: 'message-greeting', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Backed up greeting' }] } },
  ];
  const handle = await f.raw.create(header);
  await handle.append(events); await handle.flush(); await handle.close();
  const before = await f.raw.open(id, 'read');
  assert.deepEqual((await before.read()).events, events);
  await before.close();
  await f.workspace.attachSession(id);
  f.registry.state.archivedSessionIds = [id];
  assert.equal((await f.call('/metadata', { sessionId: id, tags: ['keep'], note: 'Backup note' })).status, 200);
  const exported = await f.call('/export', Buffer.from(new URLSearchParams({ sessionIds: JSON.stringify([id]) }).toString()), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(exported.status, 200, exported.bytes.toString());
  const conflict = await f.inspect(exported.bytes);
  assert.equal(conflict.sessions[0].conflict, true);
  assert.deepEqual((await f.call('/delete-all', { sessionIds: [id], permanent: true })).json().deleted, [id]);
  assert.equal(await f.raw.stat(id), undefined);

  // The user's existing v1 ZIP remains restorable after the upgrade.
  const files = unzipSync(exported.bytes);
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  manifest.version = 1;
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  const recordName = manifest.sessions[0].files.json;
  const record = JSON.parse(new TextDecoder().decode(files[recordName]));
  record.version = 1;
  delete record.source.inheritedEventCount;
  files[recordName] = strToU8(JSON.stringify(record));
  const preview = await f.inspect(Buffer.from(zipSync(files)));
  assert.equal(preview.sessions[0].conflict, false);
  const restored = await f.call('/import/restore', { token: preview.token, nonce: preview.nonce, sessionIds: [id] });
  assert.equal(restored.status, 200, restored.bytes.toString());
  assert.deepEqual(restored.json().restored, [id]);
  // This native fixture intentionally mounts persistence without the optional
  // public projection cache. Restore remains durable and reports the exact
  // title-publication limitation instead of claiming the cold row is synced.
  assert.deepEqual(restored.json().warnings, [{
    id,
    reason: 'title-publication-degraded',
    detail: 'cache-unavailable',
  }]);
  assert.deepEqual(f.registry.archivedSessionIds, [id]);
  assert.deepEqual(f.workspace.sessionIds, [id]);
  const rows = (await f.call('/state')).json().sessions;
  assert.equal(rows[0].title, 'Greeting to coding assistant');
  assert.deepEqual(rows[0].tags, ['keep']);
  assert.equal(rows[0].note, 'Backup note');
  const content = await f.call('/preview', { sessionId: id });
  assert.equal(content.status, 200, content.bytes.toString());
  assert.equal(content.json().messages[0].segments[0].text, 'Backed up greeting');
  assert.equal((await f.call('/unarchive', { sessionId: id })).status, 200);
  assert.deepEqual(f.registry.archivedSessionIds, []);
  const reopened = await f.raw.open(id, 'write');
  assert.deepEqual((await reopened.read()).events, events);
  assert.equal(reopened.inheritedEventCount, 0);
  await reopened.close();
});

test('official modern backend: a fork backup restores its inherited cut without its parent', { skip: !nativeRoot }, async t => {
  const f = await fixture(t);
  const { Session } = await native('dsh-session');
  const id = 'session-fork-backup';
  const header = { version: 3, id, createdAt: 42, cwd: f.root, isSeeded: true, parentSession: 'missing-parent' };
  const seed = [{ seq: 0, time: 42, type: 'session/title', data: { title: 'Parent title' } }];
  const session = Session.create(id, seed, header, 1);
  session.append('session/title', { title: 'Fork title' });
  const events = session.snapshotEvents();
  const handle = await f.raw.create(header, { inheritedEventCount: 1 });
  await handle.append(events); await handle.flush(); await handle.close();
  await f.workspace.attachSession(id);
  f.registry.state.archivedSessionIds = [id];
  const exported = await f.call('/export', Buffer.from(new URLSearchParams({ sessionIds: JSON.stringify([id]) }).toString()), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(exported.status, 200, exported.bytes.toString());
  const files = unzipSync(exported.bytes);
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  assert.equal(manifest.version, 2);
  const record = JSON.parse(new TextDecoder().decode(files[manifest.sessions[0].files.json]));
  assert.equal(record.source.inheritedEventCount, 1);
  assert.deepEqual(record.source.events, events);
  assert.deepEqual((await f.call('/delete-all', { sessionIds: [id], permanent: true })).json().deleted, [id]);
  const preview = await f.inspect(exported.bytes);
  const restored = await f.call('/import/restore', { token: preview.token, nonce: preview.nonce, sessionIds: [id] });
  assert.equal(restored.status, 200, restored.bytes.toString());
  assert.equal((await f.call('/state')).json().sessions[0].title, 'Fork title');
  const reopened = await f.raw.open(id, 'read');
  assert.equal(reopened.inheritedEventCount, 1);
  assert.equal(reopened.header.parentSession, 'missing-parent');
  const read = await reopened.read();
  const resumed = Session.fromRestore(id, read.events, reopened.header, reopened.inheritedEventCount, read.eventState);
  assert.deepEqual(read.events, events);
  assert.deepEqual(resumed.ownEvents().slice(0, events.length - 1), events.slice(1));
  await reopened.close();
});

test('official backend publication durability failure preserves uncertain artifacts', { skip: !nativeRoot }, async t => {
  const f = await fixture(t);
  const backup = await smallBackup('session-fsync-failure', f.root);
  let failed = false;
  if (process.platform === 'win32') {
    // Windows publishes through materializeWin32/MoveFileExW rather than a
    // POSIX directory fsync. Fail immediately after that real publication so
    // rollback must preserve the now-uncertain artifact.
    const materialize = f.raw.materializeWin32.bind(f.raw);
    f.raw.materializeWin32 = async (...args) => {
      await materialize(...args);
      if (!failed) { failed = true; throw new Error('injected post-MoveFileExW failure'); }
    };
  } else {
    const sync = f.raw.syncDirPosix.bind(f.raw);
    f.raw.syncDirPosix = async directory => {
      if (!failed && directory.endsWith('session-fsync-failure')) { failed = true; throw new Error('injected directory fsync failure'); }
      return sync(directory);
    };
  }
  const preview = await f.inspect(backup.bytes);
  const result = await f.call('/import/restore', { token: preview.token, nonce: preview.nonce, sessionIds: [backup.meta.id] });
  assert.equal(result.json().error, 'restore-rollback-failed');
  assert.deepEqual(f.registry.archivedSessionIds, []);
  assert.ok(await f.raw.stat(backup.meta.id), 'uncertain artifact must not be silently deleted');
  const handle = await f.raw.open(backup.meta.id, 'write');
  await handle.close(); // The failed importer released its ownership.
});

test('a foreign first-materialization conflict never deletes the foreign log', { skip: !nativeRoot }, async t => {
  const f = await fixture(t);
  const backup = await smallBackup('session-racing-create', f.root);
  const { Context } = await native('cordis');
  const { default: Persistence } = await native('dsh-session-persistence-jsonl');
  const peerContext = new Context();
  const peer = new Persistence(peerContext, { root: join(f.root, 'sessions') });
  t.after(() => peerContext.fiber.dispose());
  const create = f.raw.create.bind(f.raw);
  f.raw.create = async (...args) => {
    const handle = await create(...args);
    const append = handle.append.bind(handle);
    handle.append = async events => {
      const foreign = await peer.create(backup.meta);
      await foreign.append([{ ...backup.events[0], data: { title: 'Foreign conversation' } }]);
      await foreign.flush(); await foreign.close();
      return append(events);
    };
    return handle;
  };
  const preview = await f.inspect(backup.bytes);
  const result = await f.call('/import/restore', { token: preview.token, nonce: preview.nonce, sessionIds: [backup.meta.id] });
  assert.equal(result.json().error, 'restore-rollback-failed');
  const handle = await peer.open(backup.meta.id, 'read');
  assert.equal((await handle.read()).events[0].data.title, 'Foreign conversation');
  await handle.close();
  assert.deepEqual(f.registry.archivedSessionIds, []);
});

test('ZIP restore cannot resurrect an ID still reserved by a pending deletion', { skip: !nativeRoot }, async t => {
  const f = await fixture(t);
  const backup = await smallBackup('session-pending-delete', f.root);
  const preview = await f.inspect(backup.bytes);
  const trash = createTrashStore({ path: join(f.root, 'plugin-data', 'archived-chats', 'trash.json') });
  await trash.put({ sessionId: backup.meta.id, state: 'purge-pending', trashedAt: '2026-09-20T00:00:00.000Z', purgeRequestedAt: '2026-09-20T00:00:00.000Z',
    title: 'Pending deletion', createdAt: 42, origin: null, workspace: null, wasArchived: true,
    tags: [], note: '', metadataUpdatedAt: null, snapshotId: null, snapshotBytes: 0, snapshotAttachmentCount: 0, liveDisposition: 'cold' });
  const result = await f.call('/import/restore', { token: preview.token, nonce: preview.nonce, sessionIds: [backup.meta.id] });
  assert.equal(result.status, 409, result.bytes.toString());
  assert.equal(result.json().skipped[0].reason, 'id-conflict');
  assert.equal(await f.raw.stat(backup.meta.id), undefined);
  assert.equal((await f.inspect(backup.bytes)).sessions[0].conflict, true);
});
