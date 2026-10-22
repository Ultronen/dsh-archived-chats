/**
 * dsh-archived-chats smoke test — exercises the real host half (lib/index.js)
 * under mocked webServer / workspaceRegistry / sessionPersistence services with
 * a real temp directory for the delete path, then runs the real client half
 * (lib/client.js) under a mocked browser runtime for registration-level checks.
 * Run: node test/smoke.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { unzipSync, strFromU8 } from 'fflate';
import { createSnapshotStore } from '../lib/snapshot.js';
import { withLegacyFixtures } from './helpers/legacy-recycle-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageVersion = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;

// Isolate the plugin's pending-deletion store from the real user home: the host
// half writes it under $DSH_HOME/plugin-data/archived-chats/, so point DSH_HOME
// at a throwaway temp dir (the env var is read at call time by the module).
const testHome = mkdtempSync(join(tmpdir(), 'dsh-archived-chats-home-'));
process.env.DSH_HOME = testHome;
const metadataFile = join(testHome, 'plugin-data', 'archived-chats', 'metadata.json');
mkdirSync(dirname(metadataFile), { recursive: true });
writeFileSync(metadataFile, JSON.stringify({
  version: 1,
  sessions: {
    'session-a': {
      tags: ['important'],
      note: 'keep this',
      updatedAt: '2026-08-18T12:00:00.000Z',
    },
  },
}), 'utf8');

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); }
  else { failures += 1; console.log(`  ❌ ${label}`); }
}

/** Read the pending-deletions store inside the isolated DSH_HOME. */
function readPendingStore() {
  try {
    const parsed = JSON.parse(readFileSync(join(testHome, 'plugin-data', 'archived-chats', 'pending-deletions.json'), 'utf8'));
    return Array.isArray(parsed?.ids) ? parsed.ids : [];
  } catch { return []; }
}

/** Read the metadata document while a test expects the store to be healthy. */
function readMetadataStore() {
  return JSON.parse(readFileSync(metadataFile, 'utf8'));
}

//#region shared mocks
function mockReq(method, headers, bodyText) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  queueMicrotask(() => {
    if (bodyText !== undefined) req.emit('data', Buffer.from(bodyText));
    req.emit('end');
  });
  return req;
}
function multipartZip(zip, boundary = 'dsh-import-test') {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    Buffer.from(zip),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}
function mockRes() {
  const res = new PassThrough();
  const chunks = [];
  res.status = 0;
  res.headers = {};
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers ?? {};
    return res;
  };
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  res.bytes = () => Buffer.concat(chunks);
  Object.defineProperty(res, 'body', { get: () => res.bytes().toString('utf8') });
  res.json = () => JSON.parse(res.body);
  return res;
}
async function call(routes, path, req) {
  const handler = routes.get(path);
  if (!handler) throw new Error(`no route registered for ${path}`);
  const res = mockRes();
  await handler(req, res);
  if (!res.writableFinished) await once(res, 'finish');
  return res;
}
async function waitUntil(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}
async function waitFor(promise, timeout = 1000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeout}ms`)), timeout)),
  ]);
}
//#endregion

//#region host-half fixture
const tmp = mkdtempSync(join(tmpdir(), 'dsh-archived-chats-test-'));

const archivedImageRef = {
  attachmentId: 'attachment-session-a',
  mediaType: 'image/png',
  bytes: 4,
  width: 2,
  height: 2,
  name: 'archive.png',
};
const archivedImageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const events = {
  'session-a': [
    { type: 'session/title', data: { title: '第一个归档' } },
    { type: 'session/title', data: { title: '改名后的归档' } },
    {
      seq: 10,
      time: Date.parse('2026-08-19T10:00:00.000Z'),
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'user-search-a',
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '部署失败 EADDRINUSE，请帮我查端口' },
          { type: 'image', attachment: archivedImageRef },
        ],
      },
    },
    {
      seq: 11,
      time: Date.parse('2026-08-19T10:00:01.000Z'),
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-search-a',
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [
            { type: 'reasoning', text: '需要确认哪个进程占用了端口' },
            { type: 'text', text: '请运行 lsof -i :3000 找到占用端口的进程。' },
            { type: 'tool-call', id: 'call-search-a', name: 'read_file', arguments: '{"path":"server.js"}' },
          ],
        },
      },
    },
    {
      seq: 12,
      time: Date.parse('2026-08-19T10:00:02.000Z'),
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-search-a',
          role: 'user',
          source: { kind: 'tool', callId: 'call-search-a' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-search-a',
            isError: false,
            content: [{ type: 'text', text: 'server.js listens on port 3000' }],
          }],
        },
      },
    },
    {
      seq: 13,
      time: Date.parse('2026-08-19T10:00:03.000Z'),
      type: 'assistant/message',
      surfaceOp: { op: 'replace', start: 11, end: 11 },
      sourceEventSeqs: [11],
      data: {
        turn: 2,
        step: 1,
        message: {
          id: 'assistant-search-replacement',
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [{ type: 'text', text: 'replacement-only-secret-needle' }],
        },
      },
    },
  ],
  'session-b': [
    { type: 'session/title', data: { title: 'Beta chat' } },
    {
      seq: 20,
      time: Date.parse('2026-08-19T11:00:00.000Z'),
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'user-search-b',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Prepare the quarterly budget report' }],
      },
    },
  ],
  'session-c': [],
};
const headerRows = [
  { id: 'session-a', createdAt: 1786726311605, cwd: '/ws/one' },
  { id: 'session-b', createdAt: 1786726400000, cwd: '/ws/two', parentSession: 'session-a', seedLength: 2, origin: 'subagent', delegationDepth: 1 },
  { id: 'session-c', createdAt: 1786726500000, cwd: '/ws/one' },
];
// Real on-disk artifacts for the delete path (sessions a, b, c + live one).
for (const id of ['session-a', 'session-b', 'session-c', 'session-live']) {
  const dir = join(tmp, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl.zstd'), 'fake');
}

const detached = [];
const workspaceState = {
  initialized: true,
  workspaceIds: ['ws-1', 'ws-2'],
  archivedSessionIds: ['session-a', 'session-b', 'session-c'],
};
const workspaces = [
  {
    id: 'ws-1', title: '项目一', path: '/ws/one',
    sessionIds: ['session-a', 'session-c'],
    detachSession: async (id) => { detached.push(id); },
  },
  {
    id: 'ws-2', title: '项目二', path: '/ws/two',
    sessionIds: ['session-b'],
    detachSession: async (id) => { detached.push(id); },
  },
];
const registry = {
  state: workspaceState,
  get archivedSessionIds() { return workspaceState.archivedSessionIds; },
  list: () => workspaces,
  async archiveSession(id) {
    if (!workspaceState.archivedSessionIds.includes(id)) workspaceState.archivedSessionIds.push(id);
  },
  async unarchiveSession(id) { await this.setState({ ...this.state, archivedSessionIds: this.archivedSessionIds.filter(value => value !== id) }); },
  async setState(next) {
    workspaceState.archivedSessionIds = next.archivedSessionIds;
    workspaceState.workspaceIds = next.workspaceIds;
  },
  // In-memory header index, like the real WorkspaceRegistry builds at startup.
  headers: new Map(headerRows.map((h) => [h.id, h])),
  sessionPaths: new Map(headerRows.map((h) => [h.id, h.cwd])),
  invalidSessionPaths: new Map(),
};
const persistence = {
  list: async () => headerRows,
  listSnapshots: async () => headerRows.map((header) => ({ header, revision: `rev-${header.id}` })),
  inspect: async (id) => {
    if (!(id in events)) throw new Error(`unknown session ${id}`);
    return { meta: headerRows.find((h) => h.id === id), events: events[id] };
  },
  locate: (header) => ({ kind: 'jsonl', path: join(tmp, String(header.id), 'session.jsonl.zstd') }),
  create: async (header) => {
    headerRows.push(structuredClone(header));
    events[header.id] = [];
    mkdirSync(join(tmp, String(header.id)), { recursive: true });
    writeFileSync(join(tmp, String(header.id), 'session.jsonl.zstd'), 'created');
  },
  append: async (id, batch) => { events[id].push(...structuredClone(batch)); },
  removeSession: async (id) => {
    const index = headerRows.findIndex((header) => String(header.id) === String(id));
    if (index >= 0) headerRows.splice(index, 1);
    delete events[id];
    rmSync(join(tmp, String(id)), { recursive: true, force: true });
  },
};
const liveSessions = { get: (id) => (id === 'session-live' ? { id, header: { id, createdAt: 1 } } : undefined) };

const services = { webServer: undefined, workspaceRegistry: registry, sessionPersistence: persistence, sessions: liveSessions };
const routes = new Map();
const listeners = [];
const warnings = [];
const ctx = {
  get: (key) => services[key],
  on: (event, cb) => { listeners.push([event, cb]); },
  effect: (fn) => { fn(); },
  logger: { warn: (message) => warnings.push(String(message)) },
};

let attachmentReads = 0;
services.attachments = {
  readImage: async (ref, signal) => {
    attachmentReads += 1;
    if (signal !== undefined) assert(signal instanceof AbortSignal, 'image read receives an abort signal');
    assert(ref.attachmentId === archivedImageRef.attachmentId, 'image read receives the projected reference');
    return { ref: archivedImageRef, data: archivedImageBytes };
  },
  saveImage: async ({ data, mediaType, name }) => ({
    ...archivedImageRef,
    bytes: data.byteLength,
    mediaType,
    ...(name === undefined ? {} : { name }),
  }),
};

// Startup recovery removes unreferenced upgrade-era snapshots. They must never
// be projected into the Recycle Bin while recovery is running.
const legacyStore = createSnapshotStore({ root: join(testHome, 'plugin-data', 'archived-chats', 'snapshots'), persistence, attachments: services.attachments });
const seedLegacy = () => legacyStore.capture({ sessionId: 'session-a', archive: { title: 'Legacy Alpha', workspace: { id: 'ws-1', title: 'Project', path: '/ws/private' }, wasArchived: true, tags: [], note: 'keep this' }, liveDisposition: 'cold' });
const capturedSnapshotId = (await seedLegacy()).snapshotId;
const purgeSnapshotId = (await seedLegacy()).snapshotId;
const clearSnapshotId = (await seedLegacy()).snapshotId;

const { apply: applyPlugin, name } = await import(new URL('../lib/index.js', import.meta.url));
const apply = withLegacyFixtures(applyPlugin);
//#endregion

console.log('\n[1] host half — lazy route registration');
apply(ctx);
assert(name === 'archived-chats', `plugin name is "archived-chats" (got "${name}")`);
assert(routes.size === 0, 'no routes while webServer is unbound');
services.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } };
listeners.find(([event]) => event === 'internal/service')?.[1]('webServer');
assert(routes.size === 36, `thirty-five public routes and one legacy fixture builder registered after webServer binds (got ${routes.size})`);
for (const path of ['about', 'about/check-updates', 'about/install-update', 'state', 'stats', 'insights', 'retention/policy', 'retention/preview', 'retention/apply', 'lineage', 'preview', 'preview/image', 'search', 'export', 'import/inspect', 'import/restore', 'metadata', 'trash', 'trash/restore', 'trash/purge', 'trash/empty', 'unarchive', 'unarchive-all', 'delete', 'delete-all', 'unarchived', 'unarchived/export', 'orphans', 'orphans/delete', 'orphans/export', 'workspace-archive/workspaces', 'workspace-archive/preview', 'workspace-archive/apply']) {
  assert(routes.has(`/plugins/dsh-archived-chats/${path}`), `route /${path} registered`);
}
for (const path of ['history/capture', 'history', 'history/preview', 'history/preview/image', 'history/restore/preview', 'history/restore', 'history/delete', 'history/delete-all']) {
  assert(!routes.has(`/plugins/dsh-archived-chats/${path}`), `retired route /${path} is not registered`);
}
assert(!routes.has('/plugins/dsh-archived-chats/interop/inspect'), 'Codex / Claude import route is not registered');
assert(!routes.has('/plugins/dsh-archived-chats/interop/export'), 'Codex / Claude export route is not registered');

console.log('\n[1a] workspace bulk archive routes');
{
  const id = 'session-workspace-cold';
  const blankId = 'session-workspace-blank';
  const staleId = 'session-workspace-stale';
  const workspace = workspaces[0];
  const headers = [
    { id, createdAt: 1786726700000, cwd: '/workspace/private' },
    { id: blankId, createdAt: 1786726750000, cwd: '/workspace/private' },
    { id: staleId, createdAt: 1786726800000, cwd: '/workspace/private' },
  ];
  headerRows.push(...headers);
  registry.headers.set(id, headers[0]);
  registry.headers.set(blankId, headers[1]);
  registry.headers.set(staleId, headers[2]);
  events[id] = [
    { type: 'turn/start', data: {} },
    { type: 'session/title', data: { title: '批量归档预览标题' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'workspace-body-secret' }] } },
  ];
  events[blankId] = [];
  events[staleId] = [{ type: 'turn/start', data: {} }];
  workspace.sessionIds.push(blankId, id);

  const summaries = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/workspaces', mockReq('GET', {}));
  assert(summaries.status === 200 && summaries.json().workspaces.some((item) => item.id === 'ws-1' && item.eligibleCount === 1),
    `workspace summaries exclude blank new-session windows (got ${summaries.status}: ${summaries.body})`);
  assert(!JSON.stringify(summaries.json()).includes('/ws/') && !JSON.stringify(summaries.json()).includes('workspace-body-secret'),
    'workspace summaries expose no paths or session content');
  const wrongSummaryMethod = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/workspaces', mockReq('POST', {}));
  assert(wrongSummaryMethod.status === 405, 'workspace summaries reject non-GET methods');

  const missingGuard = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/preview', mockReq('POST', {}, '{"workspaceId":"ws-1"}'));
  assert(missingGuard.status === 403, 'workspace preview requires the POST guard');
  const invalidPreview = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"workspaceId":"ws-1","extra":true}'));
  assert(invalidPreview.status === 400, 'workspace preview requires an exact request body');
  const oversizedPreview = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ workspaceId: 'x'.repeat(64 * 1024) })));
  assert(oversizedPreview.status === 413, 'workspace preview enforces the 64 KiB body limit');
  const missingWorkspace = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"workspaceId":"missing"}'));
  assert(missingWorkspace.status === 404 && missingWorkspace.json().error === 'workspace-not-found', 'workspace preview preserves stable service errors');

  const preview = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"workspaceId":"ws-1"}'));
  assert(preview.status === 200 && preview.json().sessions.some((item) => item.id === id && item.title === '批量归档预览标题' && item.createdAt === 1786726700000),
    `workspace preview enriches safe title and timestamp fields (got ${preview.status}: ${preview.body})`);
  assert(!JSON.stringify(preview.json()).includes('/workspace/private') && !JSON.stringify(preview.json()).includes('workspace-body-secret'),
    'workspace preview never returns persistence paths or session content');
  const missingApplyGuard = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/apply', mockReq('POST', {}, '{"token":"x","nonce":"y"}'));
  assert(missingApplyGuard.status === 403, 'workspace apply requires the POST guard');
  const invalidApply = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/apply', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"token":"x"}'));
  assert(invalidApply.status === 400, 'workspace apply requires token and nonce exactly');
  const oversizedApply = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/apply', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ token: 'x'.repeat(64 * 1024), nonce: 'y' })));
  assert(oversizedApply.status === 413, 'workspace apply enforces the 64 KiB body limit');
  const applied = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/apply', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ token: preview.json().token, nonce: preview.json().nonce })));
  assert(applied.status === 200 && applied.json().archived.includes(id) && applied.json().snapshots.length === 0,
    `workspace apply archives confirmed cold sessions without history snapshots (got ${applied.status}: ${applied.body})`);
  assert(workspaceState.archivedSessionIds.includes(id), 'workspace apply mutates Host archive membership');

  workspace.sessionIds.push(staleId);
  const stalePreview = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"workspaceId":"ws-1"}'));
  workspaceState.archivedSessionIds.push(staleId);
  const staleApply = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/apply', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ token: stalePreview.json().token, nonce: stalePreview.json().nonce })));
  assert(staleApply.status === 409 && staleApply.json().archived.length === 0 && staleApply.json().skipped.some((item) => item.id === staleId && item.reason === 'session-archived'),
    'workspace apply returns 409 when revalidation leaves no archival success');

  const concurrencyIds = Array.from({ length: 20 }, (_, index) => `session-workspace-concurrent-${index}`);
  const concurrencyHeaders = concurrencyIds.map((sessionId, index) => ({ id: sessionId, createdAt: 1786726900000 + index, cwd: '/workspace/private' }));
  headerRows.push(...concurrencyHeaders);
  for (const header of concurrencyHeaders) {
    registry.headers.set(header.id, header);
    events[header.id] = [
      { type: 'turn/start', data: {} },
      { type: 'session/title', data: { title: `Concurrent ${header.id}` } },
    ];
  }
  workspace.sessionIds.push(...concurrencyIds);
  const inspect = persistence.inspect;
  const failedInspectionId = concurrencyIds[7];
  const inspectedIds = [];
  let activeInspections = 0;
  let maxConcurrentInspections = 0;
  persistence.inspect = async (sessionId) => {
    inspectedIds.push(sessionId);
    activeInspections += 1;
    maxConcurrentInspections = Math.max(maxConcurrentInspections, activeInspections);
    await new Promise((resolve) => setTimeout(resolve, 2));
    try {
      if (sessionId === failedInspectionId) throw new Error('fixture inspection failure');
      return await inspect(sessionId);
    }
    finally { activeInspections -= 1; }
  };
  const concurrentPreview = await call(routes, '/plugins/dsh-archived-chats/workspace-archive/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"workspaceId":"ws-1"}'));
  persistence.inspect = inspect;
  const readableConcurrencyIds = concurrencyIds.filter((sessionId) => sessionId !== failedInspectionId);
  assert(concurrentPreview.status === 200 && concurrentPreview.json().sessions.map((item) => item.id).join(',') === readableConcurrencyIds.join(','),
    'workspace preview retains readable candidate order while excluding an unconfirmed conversation');
  const concurrentRows = concurrentPreview.json().sessions;
  assert(inspectedIds.length === concurrencyIds.length + 1 && new Set(inspectedIds).size === concurrencyIds.length + 1
    && inspectedIds.includes(blankId) && concurrencyIds.every((sessionId) => inspectedIds.includes(sessionId)),
  'workspace preview inspects each unarchived candidate exactly once while checking conversation presence');
  assert(concurrentPreview.json().skipped.some((item) => item.id === failedInspectionId && item.reason === 'session-unavailable'),
    'workspace preview fails closed when conversation content cannot be confirmed');
  assert(concurrentRows.find((item) => item.id === concurrencyIds[6])?.title === `Concurrent ${concurrencyIds[6]}`
    && concurrentRows.find((item) => item.id === concurrencyIds[8])?.title === `Concurrent ${concurrencyIds[8]}`,
  'workspace preview preserves neighboring readable titles around an unavailable candidate');
  assert(maxConcurrentInspections <= 8, `workspace preview bounds persistence inspections (got ${maxConcurrentInspections})`);

  workspace.sessionIds = workspace.sessionIds.filter((sessionId) => sessionId !== id && sessionId !== blankId && sessionId !== staleId && !concurrencyIds.includes(sessionId));
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((sessionId) => sessionId !== id && sessionId !== staleId);
  for (const header of [...headers, ...concurrencyHeaders]) {
    headerRows.splice(headerRows.indexOf(header), 1);
    registry.headers.delete(header.id);
    delete events[header.id];
  }
}

console.log('\n[1a1] workspace archive late session binding');
{
  const lateState = { initialized: true, workspaceIds: ['late-ws'], archivedSessionIds: [] };
  const lateRegistry = {
    get archivedSessionIds() { return lateState.archivedSessionIds; },
    list: () => [{ id: 'late-ws', title: 'Late workspace', sessionIds: ['late-session'] }],
    archiveSession: async () => {},
    setState: async () => {},
  };
  const latePersistence = {
    list: async () => [],
    inspect: async () => ({ meta: { id: 'late-session' }, events: [{ type: 'turn/start' }] }),
    listSnapshots: async () => [],
    locate: () => undefined,
  };
  const lateServices = { webServer: undefined, workspaceRegistry: lateRegistry, sessionPersistence: latePersistence };
  const lateRoutes = new Map();
  const lateListeners = [];
  const lateCtx = {
    get: (key) => lateServices[key],
    on: (event, callback) => { lateListeners.push([event, callback]); },
    effect: (callback) => { callback(); },
    logger: { warn: () => {}, info: () => {} },
  };
  apply(lateCtx);
  lateServices.webServer = { register: (route) => { lateRoutes.set(route.path, route.handler); return () => lateRoutes.delete(route.path); } };
  lateListeners.find(([event]) => event === 'internal/service')?.[1]('webServer');
  const unavailable = await call(lateRoutes, '/plugins/dsh-archived-chats/workspace-archive/workspaces', mockReq('GET', {}));
  assert(unavailable.status === 501, 'workspace archive stays fail-closed while sessions are missing');
  lateServices.sessions = { get: () => undefined };
  const available = await call(lateRoutes, '/plugins/dsh-archived-chats/workspace-archive/workspaces', mockReq('GET', {}));
  assert(available.status === 200 && available.json().workspaces[0]?.id === 'late-ws', 'workspace archive retries capability binding after sessions becomes available');
}

console.log('\n[1a0] storage insights, retention, and lineage routes');
{
  const upgradedTrash = await call(routes, '/plugins/dsh-archived-chats/trash', mockReq('GET', {}));
  assert(upgradedTrash.status === 200 && upgradedTrash.json().sessions.length === 0,
    'upgrade-era snapshots do not appear in the Recycle Bin');
  assert(upgradedTrash.json().summary.count === 0 && upgradedTrash.json().summary.snapshotBytes === 0,
    'upgrade-era snapshots do not affect Recycle Bin totals');

  const startupSnapshotIds = [capturedSnapshotId, purgeSnapshotId, clearSnapshotId];
  assert(startupSnapshotIds.every(id => existsSync(join(testHome, 'plugin-data', 'archived-chats', 'snapshots', id, 'manifest.json'))),
    'retirement preserves unreferenced historical snapshots without startup sweeping');
  const untouchedSnapshotId = (await seedLegacy()).snapshotId;
  const clearedTrash = await call(routes, '/plugins/dsh-archived-chats/trash/empty', mockReq('POST', {
    'x-dsh-archived-chats': '1',
  }, '{}'));
  assert(clearedTrash.status === 400 && clearedTrash.json().error === 'trashTargets-required',
    'empty Recycle Bin rejects an absent confirmation scope');
  assert(existsSync(join(testHome, 'plugin-data', 'archived-chats', 'snapshots', untouchedSnapshotId, 'manifest.json')),
    'empty Recycle Bin with no confirmation scope leaves snapshot files untouched');

  const insights = await call(routes, '/plugins/dsh-archived-chats/insights', mockReq('GET', {}));
  assert(insights.status === 200, `insights answers 200 (got ${insights.status})`);
  assert(insights.json().summary.snapshotBytes === 0 && insights.json().snapshots.length === 0,
    'upgrade-era snapshots do not affect storage insights or cleanup input');
  assert(insights.json().summary.sessionBytes >= 0, 'insights exposes measured session bytes');
  assert(!JSON.stringify(insights.json()).includes('workspacePath'), 'insights never exposes workspace paths');

  const originalParent = headerRows[1].parentSession;
  const originalInspect = persistence.inspect;
  const lineageInspections = [];
  headerRows[1].parentSession = 'session-source-context';
  headerRows.push(
    { id: 'session-source-context', createdAt: 1786726200000, cwd: '/ws/one', title: '   ' },
    { id: 'session-unrelated-active', createdAt: 1786726600000, cwd: '/ws/private' },
    { id: 'session-active-branch', parentSession: 'session-b', createdAt: 1786726700000, title: 'Active branch', cwd: '/ws/one' },
  );
  events['session-source-context'] = [{ type: 'session/title', data: { title: '可读的来源会话' } }];
  persistence.inspect = async (id) => {
    lineageInspections.push(id);
    return originalInspect(id);
  };
  const lineage = await call(routes, '/plugins/dsh-archived-chats/lineage', mockReq('GET', {}));
  persistence.inspect = originalInspect;
  delete events['session-source-context'];
  headerRows.splice(-3);
  headerRows[1].parentSession = originalParent;
  assert(lineage.status === 200, `lineage answers 200 (got ${lineage.status})`);
  const sourceContext = lineage.json().roots.find((node) => node.id === 'session-source-context');
  assert(sourceContext?.title === '可读的来源会话' && sourceContext.children[0]?.id === 'session-b',
    'lineage resolves a readable title for the necessary active source context');
  assert(lineageInspections.includes('session-source-context') && !lineageInspections.includes('session-unrelated-active'),
    'lineage only resolves titles for archive-related chats');
  assert(!JSON.stringify(lineage.json()).includes('session-unrelated-active'), 'lineage excludes unrelated active chats');
  assert(sourceContext?.children[0]?.children.some(node => node.id === 'session-active-branch' && node.status === 'active'), 'lineage route retains unarchived descendants of archived chats');
  assert(!JSON.stringify(lineage.json()).includes('/ws/'), 'lineage never exposes workspace paths');

  const originalArchivedIds = [...workspaceState.archivedSessionIds];
  workspaceState.archivedSessionIds = [];
  const emptyLineage = await call(routes, '/plugins/dsh-archived-chats/lineage', mockReq('GET', {}));
  workspaceState.archivedSessionIds = originalArchivedIds;
  assert(emptyLineage.status === 200 && emptyLineage.json().nodeCount === 0 && emptyLineage.json().workspaces.length === 0,
    'lineage is empty without archived sessions');

  const autoGuard = await call(routes, '/plugins/dsh-archived-chats/retention/policy/preview', mockReq('POST', {}, '{}'));
  assert(autoGuard.status === 403, 'automatic cleanup confirmation preview requires guard');
  const autoPolicy = { historicalSnapshotsPerSession: 1, historicalSnapshotMaxAgeDays: null, snapshotQuotaBytes: null, recycleMaxAgeDays: 7, recycleAutoDelete: true };
  const enableWithoutConfirmation = await call(routes, '/plugins/dsh-archived-chats/retention/policy', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify(autoPolicy)));
  assert(enableWithoutConfirmation.status === 410 && enableWithoutConfirmation.json().error === 'retention-retired', 'enabling auto cleanup requires server confirmation');
  const autoPreview = await call(routes, '/plugins/dsh-archived-chats/retention/policy/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify(autoPolicy)));
  assert(autoPreview.status === 410, 'enabling with an empty bin still explains future automatic deletion');
  const confirmedPolicy = await call(routes, '/plugins/dsh-archived-chats/retention/policy', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ policy: autoPolicy, confirmation: autoPreview.json() })));
  assert(confirmedPolicy.status === 410, 'confirmed policy persists explicit opt-in');
  const policyGet = await call(routes, '/plugins/dsh-archived-chats/retention/policy', mockReq('GET', {}));
  assert(policyGet.status === 405, 'retention policy rejects GET');
  const previewMissingGuard = await call(routes, '/plugins/dsh-archived-chats/retention/preview', mockReq('POST', {}, '{}'));
  assert(previewMissingGuard.status === 403, 'retention preview rejects missing guard');
  const applyMissingGuard = await call(routes, '/plugins/dsh-archived-chats/retention/apply', mockReq('POST', {}, '{}'));
  assert(applyMissingGuard.status === 403, 'retention apply rejects missing guard');

  const savedPolicy = await call(routes, '/plugins/dsh-archived-chats/retention/policy', mockReq('POST', {
    'x-dsh-archived-chats': '1',
  }, JSON.stringify({
    historicalSnapshotsPerSession: 1,
    historicalSnapshotMaxAgeDays: null,
    snapshotQuotaBytes: null,
    recycleMaxAgeDays: null,
  })));
  assert(savedPolicy.status === 410, `retired policy save rejects requests answers 200 (got ${savedPolicy.status})`);

  const preview = await call(routes, '/plugins/dsh-archived-chats/retention/preview', mockReq('POST', {
    'x-dsh-archived-chats': '1',
  }, '{}'));
  assert(preview.status === 410, `retired retention preview rejects requests answers 200 (got ${preview.status})`);
  const applyResult = await call(routes, '/plugins/dsh-archived-chats/retention/apply', mockReq('POST', {
    'x-dsh-archived-chats': '1',
  }, JSON.stringify({ token: preview.json().token, nonce: preview.json().nonce, keys: [] })));
  assert(applyResult.status === 410, `retired retention apply rejects requests (got ${applyResult.status})`);
}
{
  const inspectGet = await call(routes, '/plugins/dsh-archived-chats/import/inspect', mockReq('GET', {}));
  assert(inspectGet.status === 405, `import inspect rejects non-POST methods (got ${inspectGet.status})`);
  const inspectNoGuard = await call(routes, '/plugins/dsh-archived-chats/import/inspect', mockReq('POST', { 'content-type': 'multipart/form-data; boundary=x' }, ''));
  assert(inspectNoGuard.status === 403, `import inspect rejects missing guard header (got ${inspectNoGuard.status})`);
  const restoreGet = await call(routes, '/plugins/dsh-archived-chats/import/restore', mockReq('GET', {}));
  assert(restoreGet.status === 405, `import restore rejects non-POST methods (got ${restoreGet.status})`);
}

console.log('\n[1a] POST /preview and /search');
{
  const attachmentReadsBeforePreview = attachmentReads;
  const jsonReq = (path, body, headers = { 'x-dsh-archived-chats': '1' }, method = 'POST') => call(
    routes,
    `/plugins/dsh-archived-chats/${path}`,
    mockReq(method, { 'content-type': 'application/json', ...headers }, JSON.stringify(body)),
  );

  const previewGet = await jsonReq('preview', { sessionId: 'session-a' }, {}, 'GET');
  assert(previewGet.status === 405, `preview rejects non-POST methods (got ${previewGet.status})`);
  const previewNoGuard = await jsonReq('preview', { sessionId: 'session-a' }, {});
  assert(previewNoGuard.status === 403, `preview rejects missing guard header (got ${previewNoGuard.status})`);
  const imageGet = await jsonReq('preview/image', {
    sessionId: 'session-a',
    attachmentId: archivedImageRef.attachmentId,
  }, {}, 'GET');
  assert(imageGet.status === 405, `preview image rejects non-POST methods (got ${imageGet.status})`);

  const imageNoGuard = await jsonReq('preview/image', {
    sessionId: 'session-a',
    attachmentId: archivedImageRef.attachmentId,
  }, {});
  assert(imageNoGuard.status === 403, `preview image rejects missing guard header (got ${imageNoGuard.status})`);

  const oversizedImageRequest = await jsonReq('preview/image', {
    sessionId: 'session-a',
    attachmentId: archivedImageRef.attachmentId,
    padding: 'x'.repeat(64 * 1024),
  });
  assert(oversizedImageRequest.status === 413, 'preview image rejects bodies over 64 KiB');

  const malformedImageRequest = await call(
    routes,
    '/plugins/dsh-archived-chats/preview/image',
    mockReq('POST', { 'content-type': 'application/json', 'x-dsh-archived-chats': '1' }, '{broken'),
  );
  assert(malformedImageRequest.status === 400, 'preview image rejects malformed JSON');

  const crossSession = await jsonReq('preview/image', {
    sessionId: 'session-b',
    attachmentId: archivedImageRef.attachmentId,
  });
  assert(crossSession.status === 404, 'preview image denies a reference from another archived session');

  const activeImage = await jsonReq('preview/image', {
    sessionId: 'session-live',
    attachmentId: archivedImageRef.attachmentId,
  });
  assert(activeImage.status === 404, 'preview image denies a non-archived session');

  const image = await jsonReq('preview/image', {
    sessionId: 'session-a',
    attachmentId: archivedImageRef.attachmentId,
  });
  assert(image.status === 200, `preview image answers 200 (got ${image.status})`);
  assert(image.headers['content-type'] === 'image/png', 'preview image uses the verified media type');
  assert(image.headers['cache-control'] === 'no-store', 'preview image disables response caching');
  assert(image.bytes().equals(archivedImageBytes), 'preview image returns the verified bytes');
  assert(attachmentReads === attachmentReadsBeforePreview + 1, 'only the authorized request reaches the attachment service');

  const savedAttachments = services.attachments;
  delete services.attachments;
  const unsupportedImage = await jsonReq('preview/image', {
    sessionId: 'session-a',
    attachmentId: archivedImageRef.attachmentId,
  });
  assert(unsupportedImage.status === 503, 'preview image reports an unavailable attachment service');
  services.attachments = savedAttachments;

  services.attachments = { readImage: async () => {
    throw Object.assign(new Error('/private/path/must-not-leak'), { code: 'attachment-corrupt' });
  } };
  const corruptImage = await jsonReq('preview/image', {
    sessionId: 'session-a',
    attachmentId: archivedImageRef.attachmentId,
  });
  assert(corruptImage.status === 500 && corruptImage.json().error === 'preview-image-failed', 'preview image isolates a corrupt stored image');
  assert(!corruptImage.body.includes('/private/path'), 'preview image never returns attachment diagnostics');
  services.attachments = savedAttachments;

  let markImageReadStarted;
  const imageReadStarted = new Promise((resolve) => { markImageReadStarted = resolve; });
  let imageAbortObserved = false;
  services.attachments = { readImage: (_ref, signal) => new Promise((_resolve, reject) => {
    markImageReadStarted();
    signal.addEventListener('abort', () => {
      imageAbortObserved = true;
      reject(signal.reason);
    }, { once: true });
  }) };
  const abortedReq = mockReq('POST', {
    'content-type': 'application/json',
    'x-dsh-archived-chats': '1',
  }, JSON.stringify({ sessionId: 'session-a', attachmentId: archivedImageRef.attachmentId }));
  const abortedRes = mockRes();
  const abortedHandler = routes.get('/plugins/dsh-archived-chats/preview/image');
  const abortedPending = abortedHandler(abortedReq, abortedRes);
  await imageReadStarted;
  abortedReq.emit('aborted');
  await abortedPending;
  assert(imageAbortObserved, 'preview image aborts the attachment read with its request');
  abortedRes.destroy();
  services.attachments = savedAttachments;

  const archivedBeforeImageRace = [...workspaceState.archivedSessionIds];
  let releaseImageRead;
  let markRacingImageReadStarted;
  const racingImageReadStarted = new Promise((resolve) => { markRacingImageReadStarted = resolve; });
  services.attachments = { readImage: async () => {
    markRacingImageReadStarted();
    await new Promise((resolve) => { releaseImageRead = resolve; });
    return { ref: archivedImageRef, data: archivedImageBytes };
  } };
  const racingImage = jsonReq('preview/image', {
    sessionId: 'session-a',
    attachmentId: archivedImageRef.attachmentId,
  });
  await racingImageReadStarted;
  const unarchivedDuringImageRead = await jsonReq('unarchive', { sessionId: 'session-a' });
  releaseImageRead();
  const imageAfterUnarchive = await racingImage;
  assert(unarchivedDuringImageRead.status === 200 && imageAfterUnarchive.status === 404, 'preview image rechecks archive visibility after an overlapping unarchive');
  workspaceState.archivedSessionIds = archivedBeforeImageRace;
  services.attachments = savedAttachments;

  // The racing unarchive invalidated both title and projection caches. Warm
  // only the title cache so the controlled inspection below pauses inside the
  // projected-message read rather than the initial list authorization.
  await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));

  const savedInspect = persistence.inspect;
  const archivedBeforePreviewRace = [...workspaceState.archivedSessionIds];
  let releasePreviewInspect;
  let markPreviewInspectStarted;
  const previewInspectStarted = new Promise((resolve) => { markPreviewInspectStarted = resolve; });
  persistence.inspect = async (id) => {
    if (id !== 'session-a') return savedInspect(id);
    markPreviewInspectStarted();
    await new Promise((resolve) => { releasePreviewInspect = resolve; });
    return savedInspect(id);
  };
  const racingPreview = jsonReq('preview', { sessionId: 'session-a' });
  await previewInspectStarted;
  const unarchivedDuringPreview = await jsonReq('unarchive', { sessionId: 'session-a' });
  releasePreviewInspect();
  const previewAfterUnarchive = await racingPreview;
  assert(unarchivedDuringPreview.status === 200 && previewAfterUnarchive.status === 404, 'preview rechecks archive visibility after an overlapping unarchive');
  workspaceState.archivedSessionIds = archivedBeforePreviewRace;
  persistence.inspect = savedInspect;

  await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  let releaseSearchRead, markSearchRead;
  const searchReadStarted = new Promise(resolve => { markSearchRead = resolve; });
  persistence.inspect = async id => {
    if (id !== 'session-a') return savedInspect(id);
    markSearchRead(); await new Promise(resolve => { releaseSearchRead = resolve; }); return savedInspect(id);
  };
  const racingSearch = jsonReq('search', { query: 'EADDRINUSE', sessionIds: ['session-a'] });
  await searchReadStarted;
  await jsonReq('unarchive', { sessionId: 'session-a' });
  releaseSearchRead(); const hiddenSearch = await racingSearch;
  assert(hiddenSearch.status === 200 && hiddenSearch.json().hits.length === 0 && hiddenSearch.json().skipped[0]?.reason === 'session-not-visible', 'search rechecks visibility after reading and reports a concurrently hidden candidate');
  workspaceState.archivedSessionIds = archivedBeforePreviewRace; persistence.inspect = savedInspect;

  const searchNoGuard = await jsonReq('search', { query: 'EADDRINUSE' }, {});
  assert(searchNoGuard.status === 403, `search rejects missing guard header (got ${searchNoGuard.status})`);

  const preview = await jsonReq('preview', { sessionId: 'session-a', offset: 0, limit: 2 });
  assert(preview.status === 200, `preview answers 200 (got ${preview.status})`);
  if (preview.status === 200) {
    const body = preview.json();
    assert(body.session?.id === 'session-a' && body.session?.title === '改名后的归档', 'preview identifies the archived session');
    assert(body.total === 3 && body.messages.length === 2 && body.nextOffset === 2, 'preview paginates projected messages');
    assert(body.messages[0]?.role === 'user' && body.messages[0]?.seq === 10, 'preview keeps message role and timeline sequence');
    assert(body.messages[1]?.segments?.some((segment) => segment.kind === 'tool-call' && segment.label === 'read_file'), 'preview keeps structured tool calls');
  }

  const previewTail = await jsonReq('preview', { sessionId: 'session-a', offset: 2, limit: 2 });
  assert(previewTail.status === 200 && previewTail.json().messages[0]?.role === 'tool', 'preview loads the next timeline page');

  const activeOnly = await jsonReq('preview', { sessionId: 'session-live' });
  assert(activeOnly.status === 404, `preview refuses non-archived sessions (got ${activeOnly.status})`);

  const search = await jsonReq('search', { query: 'eaddrinuse', limit: 20 });
  assert(search.status === 200, `full-text search answers 200 (got ${search.status})`);
  if (search.status === 200) {
    const body = search.json();
    assert(body.hits.length === 1 && body.hits[0].sessionId === 'session-a', 'full-text search finds archived message content case-insensitively');
    assert(body.hits[0].matches[0]?.excerpt.includes('EADDRINUSE'), 'full-text hit includes a bounded readable excerpt');
  }

  const toolSearch = await jsonReq('search', { query: 'server.js port 3000', limit: 20 });
  assert(toolSearch.status === 200 && toolSearch.json().hits[0]?.sessionId === 'session-a', 'full-text search includes tool output');

  const replacementSearch = await jsonReq('search', { query: 'replacement-only-secret-needle', limit: 20 });
  assert(replacementSearch.status === 200 && replacementSearch.json().hits.length === 0, 'full-text search ignores replacement copies');

  // Candidate lists are an authority restriction, never a fallback to all archives.
  for (const sessionIds of [null, 'session-a', [1], [''], Array(101).fill('session-a')]) {
    const bad = await jsonReq('search', { query: 'eaddrinuse', sessionIds });
    assert(bad.status === 400, 'search rejects malformed or excessive candidate IDs');
  }
  const pendingPathForSearch = join(testHome, 'plugin-data', 'archived-chats', 'pending-deletions.json');
  const previousPending = readPendingStore();
  writeFileSync(pendingPathForSearch, JSON.stringify({ ids: [...previousPending, 'session-a'] }));
  const pendingSearch = await jsonReq('search', { query: 'EADDRINUSE', sessionIds: ['session-a'] });
  assert(pendingSearch.status === 200 && pendingSearch.json().hits.length === 0 && pendingSearch.json().skipped[0]?.reason === 'session-not-visible', 'explicit search candidates cannot expose pending-deletion content');
  writeFileSync(pendingPathForSearch, JSON.stringify({ ids: previousPending }));
  const savedCandidateInspect = persistence.inspect;
  const inspectedCandidates = [];
  workspaceState.archivedSessionIds.push('private-pending-search', 'outside-candidate-search');
  writeFileSync(pendingPathForSearch, JSON.stringify({ ids: [...previousPending, 'private-pending-search'] }));
  persistence.inspect = async id => { inspectedCandidates.push(id); return savedCandidateInspect(id); };
  const pendingOnly = await jsonReq('search', { query: 'needle', sessionIds: ['private-pending-search'] });
  assert(pendingOnly.status === 200 && pendingOnly.json().skipped.length === 1 && !inspectedCandidates.includes('private-pending-search'), 'candidate authorization runs before even a hidden candidate title log is read');
  assert(!inspectedCandidates.includes('outside-candidate-search'), 'explicit candidate search does not inspect other archive logs for titles');
  persistence.inspect = savedCandidateInspect;
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter(id => !['private-pending-search', 'outside-candidate-search'].includes(id));
  writeFileSync(pendingPathForSearch, JSON.stringify({ ids: previousPending }));
  const emptyScope = await jsonReq('search', { query: 'eaddrinuse', sessionIds: [] });
  assert(emptyScope.status === 200 && emptyScope.json().hits.length === 0 && emptyScope.json().total === 0, 'empty candidate scope never widens to all archives');
  const restricted = await jsonReq('search', { query: 'eaddrinuse', sessionIds: ['session-live', 'unknown-candidate'] });
  assert(restricted.status === 200 && restricted.json().hits.length === 0 && restricted.json().skipped.length === 2, 'unarchived and stale candidate IDs are visibly skipped without exposing content');
  const anchored = await jsonReq('preview', { sessionId: 'session-a', seq: 12, limit: 2 });
  assert(anchored.status === 200 && anchored.json().anchor?.status === 'found' && anchored.json().messages.some(row => row.seq === 12), 'guarded preview resolves projected sequence anchors');
  for (const seq of [-1, '12', null, 1.2]) {
    const bad = await jsonReq('preview', { sessionId: 'session-a', seq });
    assert(bad.status === 400, 'guarded preview rejects invalid anchors');
  }

  const oversizedSearch = await jsonReq('search', { query: 'needle', padding: 'x'.repeat(64 * 1024) });
  assert(oversizedSearch.status === 413, `full-text search rejects oversized JSON bodies (got ${oversizedSearch.status})`);
  const malformedPreview = await call(
    routes,
    '/plugins/dsh-archived-chats/preview',
    mockReq('POST', { 'content-type': 'application/json', 'x-dsh-archived-chats': '1' }, '{broken'),
  );
  assert(malformedPreview.status === 400, `preview rejects malformed JSON bodies (got ${malformedPreview.status})`);
}

console.log('\n[1b] POST /export validation');
{
  const path = '/plugins/dsh-archived-chats/export';
  if (routes.has(path)) {
    const originalInspect = persistence.inspect;
    let inspectCalls = 0;
    persistence.inspect = async (...args) => {
      inspectCalls += 1;
      return originalInspect(...args);
    };
    const request = (body, method = 'POST') => call(routes, path, mockReq(method, {
      'content-type': 'application/x-www-form-urlencoded',
    }, body));
    const before = inspectCalls;
    const wrongMethod = await request('sessionIds=%5B%22session-a%22%5D', 'GET');
    assert(wrongMethod.status === 405, `export rejects non-POST methods (got ${wrongMethod.status})`);
    const malformed = await request('sessionIds=%5Bbroken');
    assert(malformed.status === 400, `export rejects malformed selection JSON (got ${malformed.status})`);
    const empty = await request('sessionIds=%5B%5D');
    assert(empty.status === 400, `export rejects an empty selection (got ${empty.status})`);
    const nonString = await request('sessionIds=%5B1%5D');
    assert(nonString.status === 400, `export rejects non-string ids (got ${nonString.status})`);
    const tooMany = encodeURIComponent(JSON.stringify(Array.from({ length: 2001 }, (_, index) => `session-${index}`)));
    const oversizedSelection = await request(`sessionIds=${tooMany}`);
    assert(oversizedSelection.status === 400, `export rejects more than 2,000 ids (got ${oversizedSelection.status})`);
    const oversizedBody = await request(`sessionIds=${'x'.repeat(512 * 1024)}`);
    assert(oversizedBody.status === 413, `export rejects bodies over 512 KiB (got ${oversizedBody.status})`);
    const invisible = await request(`sessionIds=${encodeURIComponent('["missing-session"]')}`);
    assert(invisible.status === 404, `export rejects invisible sessions (got ${invisible.status})`);
    assert(inspectCalls === before, 'invalid export requests never inspect persistence');
    persistence.inspect = originalInspect;
  }
}

console.log('\n[1b] POST /export ZIP downloads');
{
  const path = '/plugins/dsh-archived-chats/export';
  const request = (ids) => call(routes, path, mockReq('POST', {
    'content-type': 'application/x-www-form-urlencoded',
  }, `sessionIds=${encodeURIComponent(JSON.stringify(ids))}`));

  const single = await request(['session-a']);
  assert(single.status === 200, `single export answers 200 (got ${single.status})`);
  if (single.status === 200) {
    assert(single.headers['content-type'] === 'application/zip', 'single export uses the ZIP content type');
    assert(/attachment;/.test(single.headers['content-disposition']), 'single export uses an attachment disposition');
    assert(/dsh-archived-chat-/.test(single.headers['content-disposition']), 'single export filename identifies one archived chat');
    assert(single.headers['cache-control'] === 'no-store', 'single export disables response caching');
    const entries = unzipSync(new Uint8Array(single.bytes()));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    assert(manifest.generator?.name === 'dsh-archived-chats' && manifest.generator.version === packageVersion,
      'single export manifest identifies the installed plugin version');
    assert(manifest.sessionCount === 1, 'single export manifest contains one session');
    assert(manifest.sessions[0].id === 'session-a', 'single export manifest identifies the requested session');
    assert(manifest.sessions[0].tags.includes('important'), 'single export manifest includes plugin tags');
    assert(manifest.sessions[0].note === 'keep this', 'single export manifest includes the plugin note');
    assert(manifest.sessions[0].storage.status === 'ready', 'single export manifest includes storage status');
    const record = JSON.parse(strFromU8(entries[manifest.sessions[0].files.json]));
    assert(record.source.events.some((event) => event.type === 'session/title'), 'single export JSON retains persistence events');
    assert(strFromU8(entries[manifest.sessions[0].files.markdown]).includes('# 改名后的归档'), 'single export includes a readable Markdown file');
  }

  const batch = await request(['session-c', 'session-a', 'session-c']);
  assert(batch.status === 200, `batch export answers 200 (got ${batch.status})`);
  if (batch.status === 200) {
    assert(/dsh-archived-chats-2-/.test(batch.headers['content-disposition']), 'batch filename contains the unique session count');
    const entries = unzipSync(new Uint8Array(batch.bytes()));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    assert(JSON.stringify(manifest.sessions.map((session) => session.id)) === JSON.stringify(['session-c', 'session-a']), 'batch export preserves first-seen order and removes duplicates');
    assert(Object.keys(entries).length === 5, 'batch export contains one manifest and two files per unique session');
  }
}

console.log('\n[1c] POST /import inspect and restore token flow');
{
  const exported = await call(routes, '/plugins/dsh-archived-chats/export', mockReq('POST', {
    'content-type': 'application/x-www-form-urlencoded',
  }, `sessionIds=${encodeURIComponent(JSON.stringify(['session-a']))}`));
  const boundary = 'dsh-import-test';
  const inspected = await call(routes, '/plugins/dsh-archived-chats/import/inspect', mockReq('POST', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-dsh-archived-chats': '1',
  }, multipartZip(exported.bytes(), boundary)));
  assert(inspected.status === 200, `import inspect accepts an exported ZIP (got ${inspected.status})`);
  const preview = inspected.json();
  assert(typeof preview.token === 'string' && typeof preview.nonce === 'string', 'import inspect returns a short-lived token and nonce');
  assert(preview.sessions?.[0]?.conflict === true, 'import preview marks an existing session ID conflict');
  const nothing = await call(routes, '/plugins/dsh-archived-chats/import/restore', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ token: preview.token, nonce: preview.nonce, sessionIds: ['session-a'] }),
  ));
  assert(nothing.status === 409 && nothing.json().error === 'nothing-to-restore', 'restore skips a package containing only conflicting sessions');
  const replay = await call(routes, '/plugins/dsh-archived-chats/import/restore', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ token: preview.token, nonce: preview.nonce, sessionIds: ['session-a'] }),
  ));
  assert(replay.status === 409 && replay.json().error === 'import-token-invalid', 'restore tokens are single-use');
  const malformed = await call(routes, '/plugins/dsh-archived-chats/import/inspect', mockReq('POST', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-dsh-archived-chats': '1',
  }, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nnope\r\n--${boundary}--\r\n`)));
  assert(malformed.status === 400, `import inspect rejects a multipart body without a ZIP field (got ${malformed.status})`);
}

// The request body can be fully consumed before the download is cancelled.
{
  const req = mockReq('POST', { 'content-type': 'application/x-www-form-urlencoded' }, 'sessionIds=%5B%22session-a%22%5D');
  const res = mockRes();
  res.once('data', () => res.destroy());
  const handler = routes.get('/plugins/dsh-archived-chats/export');
  let settled = false;
  const done = handler(req, res).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(settled && req.listenerCount('aborted') === 0, 'cancelled export response settles and releases abort listeners without a request abort');
  // Release the old implementation's blocked producer so the regression can finish.
  if (!settled) req.emit('aborted');
  await done;
}

{
  const originalInspect = persistence.inspect;
  let begin;
  let resume;
  const started = new Promise(resolve => { begin = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  persistence.inspect = async id => { begin(); await released; return originalInspect(id); };
  const req = mockReq('POST', { 'content-type': 'application/x-www-form-urlencoded' }, 'sessionIds=%5B%22session-a%22%5D');
  const res = mockRes();
  const handler = routes.get('/plugins/dsh-archived-chats/export');
  let settled = false;
  const done = handler(req, res).then(() => { settled = true; });
  await started;
  res.destroy();
  resume();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(settled && req.listenerCount('aborted') === 0, 'disconnect during export preparation destroys the prepared ZIP and settles');
  if (!settled) req.emit('aborted');
  await done;
  persistence.inspect = originalInspect;
}

console.log('\n[2] GET /state');
{
  const res = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(res.status === 200, `state answers 200 (got ${res.status})`);
  const body = res.json();
  assert(body.metadataStatus === 'ready', 'state reports ready metadata');
  assert(body.sessions.length === 3, `three archived sessions listed (got ${body.sessions.length})`);
  const a = body.sessions.find((s) => s.id === 'session-a');
  assert(a.title === '改名后的归档', `last title event wins (got "${a.title}")`);
  assert(a.createdAt === 1786726311605, 'createdAt carried from the header');
  assert(a.workspaceId === 'ws-1' && a.workspaceTitle === '项目一', 'workspace resolved from accounting slot');
  assert(Array.isArray(a.tags) && a.tags.length === 1 && a.tags[0] === 'important', 'persisted metadata tags are included');
  assert(a.note === 'keep this', 'persisted metadata note is included');
  assert(a.metadataUpdatedAt === '2026-08-18T12:00:00.000Z', 'persisted metadata timestamp is included');
  const b = body.sessions.find((s) => s.id === 'session-b');
  assert(b.origin === 'subagent', 'subagent origin surfaced for the type filter');
  const c = body.sessions.find((s) => s.id === 'session-c');
  assert(c.title === null, 'title-less session lists with null title');
}

console.log('\n[2-title-sync] official rename updates cached archive titles');
{
  const emitTitle = (id, title) => {
    for (const [name, listener] of listeners) if (name === 'session/event') listener({ header: { id } }, { type: 'session/title', data: { title } });
  };
  emitTitle('session-a', 'Official renamed archive');
  const renamed = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(renamed.json().sessions.find(row => row.id === 'session-a').title === 'Official renamed archive',
    'official rename replaces cached title even before persisted events catch up');
  assert(renamed.json().sessions.find(row => row.id === 'session-b').title === 'Beta chat', 'rename leaves other session titles unchanged');
  emitTitle('session-a', '改名后的归档');

  const raceId = 'rename-during-title-read';
  const originalInspect = persistence.inspect;
  let releaseRead, reading = false;
  workspaceState.archivedSessionIds.push(raceId);
  headerRows.push({ id: raceId, createdAt: 1, cwd: '/ws/one' });
  persistence.inspect = async id => {
    if (id !== raceId) return originalInspect(id);
    reading = true;
    await new Promise(resolve => { releaseRead = resolve; });
    return { meta: { id: raceId }, events: [{ type: 'session/title', data: { title: 'Old disk title' } }] };
  };
  const pending = call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  await waitUntil(() => reading);
  emitTitle(raceId, 'New official title'); releaseRead?.();
  const settled = await pending;
  assert(settled.json().sessions.find(row => row.id === raceId).title === 'New official title', 'in-flight old title read cannot overwrite a newer official rename');
  persistence.inspect = originalInspect;
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter(id => id !== raceId);
  headerRows.splice(headerRows.findIndex(row => row.id === raceId), 1);
}

console.log('\n[2a] list recency matches Host session-list projections');
{
  const originalGet = liveSessions.get;
  const originalArchived = [...workspaceState.archivedSessionIds];
  const originalEvents = events['session-a'];
  const header = headerRows.find(row => row.id === 'session-a');
  let promptAt = 1788000000000;
  const readRow = async (path = 'state') => (await call(routes, `/plugins/dsh-archived-chats/${path}`, mockReq('GET', {})))
    .json().sessions.find(row => row.id === 'session-a');
  services.sessionProjectionCache = {
    cachedSnapshot: meta => meta.id === 'session-a' ? { values: { sessionListMetadata: { blank: false, lastPromptAt: promptAt } } } : undefined,
  };
  try {
    assert((await readRow()).updatedAt === 1788000000000, 'archived list uses the Host cold last-prompt projection, not creation or tag edit time');
    promptAt = 1789000000000;
    assert((await readRow()).updatedAt === 1789000000000, 'refresh reads current recency even when the title is cached');
    promptAt = 1;
    assert((await readRow()).updatedAt === header.createdAt, 'inherited prompts older than creation do not backdate the session');
    promptAt = 1788000000000;
    workspaceState.archivedSessionIds = originalArchived.filter(id => id !== 'session-a');
    events['session-a'] = [{ type: 'turn/start', data: {} }, ...originalEvents];
    assert((await readRow('unarchived')).updatedAt === 1788000000000, 'unarchived cold list exposes the same Host recency');
    const live = { id: 'session-a', header, snapshotEvents: () => events['session-a'] };
    liveSessions.get = id => id === 'session-a' ? live : originalGet(id);
    services.sessionProjections = { cachedSnapshot: session => {
      if (session !== live) throw new Error('wrong live session');
      return { values: { sessionListMetadata: { blank: false, lastPromptAt: 1790000000000 } } };
    } };
    const busyRow = await readRow('unarchived');
    assert(busyRow.busy && busyRow.updatedAt === 1790000000000 && busyRow.createdAt === header.createdAt,
      'running unarchived chats use the live projection and retain their header creation time');
    workspaceState.archivedSessionIds = originalArchived;
    assert((await readRow()).updatedAt === 1790000000000, 'live archived recency takes precedence over a stale cold cache');
    services.sessionProjections.cachedSnapshot = () => ({ values: {} });
    assert((await readRow()).updatedAt === header.createdAt, 'missing live metadata falls back to creation, not a stale cold projection');
    services.sessionProjections.cachedSnapshot = () => { throw new Error('projection unavailable'); };
    assert((await readRow()).updatedAt === header.createdAt, 'projection failure keeps the session manageable with creation-time fallback');
    liveSessions.get = originalGet;
    delete services.sessionProjectionCache;
    assert((await readRow()).updatedAt === header.createdAt, 'older hosts without projection services retain creation-time ordering');
  } finally {
    liveSessions.get = originalGet;
    workspaceState.archivedSessionIds = originalArchived;
    events['session-a'] = originalEvents;
    delete services.sessionProjections;
    delete services.sessionProjectionCache;
  }
}

console.log('\n[2a] GET /stats');
{
  const stats = await call(routes, '/plugins/dsh-archived-chats/stats', mockReq('GET', {}));
  assert(stats.status === 200, `stats answers 200 (got ${stats.status})`);
  assert(stats.json().summary.sessionCount === 3, 'stats count visible archived sessions');
  assert(stats.json().sessions['session-a'].sizeBytes === 4, 'stats report fixture bytes');
}

console.log('\n[2b] POST /metadata');
{
  const saved = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
    'POST',
    { 'x-dsh-archived-chats': '1' },
    JSON.stringify({ sessionId: 'session-a', tags: [' Updated '], note: ' note ' }),
  ));
  assert(saved.status === 200, `metadata save answers 200 (got ${saved.status})`);
  assert(JSON.stringify(saved.json().metadata.tags) === JSON.stringify(['Updated']), 'metadata save normalizes tags');
  const forbidden = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
    'POST', {}, JSON.stringify({ sessionId: 'session-a', tags: [], note: '' }),
  ));
  assert(forbidden.status === 403, `metadata save without guard header rejected (got ${forbidden.status})`);
  const invalid = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: 'session-a', tags: 'bad', note: '' }),
  ));
  assert(invalid.status === 400, `invalid metadata rejected (got ${invalid.status})`);
  const unarchived = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: 'not-archived', tags: [], note: '' }),
  ));
  assert(unarchived.status === 404, `unarchived session metadata rejected (got ${unarchived.status})`);
}

console.log('\n[2c] unavailable metadata store');
{
  writeFileSync(metadataFile, '{broken', 'utf8');
  const state = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(state.status === 200, `state remains available when metadata is corrupt (got ${state.status})`);
  assert(state.json().metadataStatus === 'unavailable', 'state reports unavailable metadata');
  const saved = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
    'POST',
    { 'x-dsh-archived-chats': '1' },
    JSON.stringify({ sessionId: 'session-a', tags: [], note: 'retry later' }),
  ));
  assert(saved.status === 503, `metadata save reports unavailable store (got ${saved.status})`);
  writeFileSync(metadataFile, JSON.stringify({
    version: 1,
    sessions: {
      'session-a': { tags: ['Updated'], note: 'note', updatedAt: '2026-08-18T12:00:00.000Z' },
      'session-b': { tags: ['delete-me'], note: 'remove after physical deletion', updatedAt: '2026-08-18T12:00:00.000Z' },
      'session-live': { tags: ['parked'], note: 'keep until the deferred delete completes', updatedAt: '2026-08-18T12:00:00.000Z' },
    },
  }), 'utf8');
}

console.log('\n[2d] metadata write failures log only safe diagnostics');
{
  const id = 'session-a';
  const secretTag = 'customer-secret-tag';
  const secretNote = 'private incident details';
  const metadataBefore = readFileSync(metadataFile, 'utf8');
  rmSync(metadataFile, { force: true });
  mkdirSync(metadataFile);
  const warningCount = warnings.length;
  const saved = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
    'POST',
    { 'x-dsh-archived-chats': '1' },
    JSON.stringify({ sessionId: id, tags: [secretTag], note: secretNote }),
  ));
  rmSync(metadataFile, { recursive: true, force: true });
  writeFileSync(metadataFile, metadataBefore, 'utf8');
  const newWarnings = warnings.slice(warningCount).join('\n');
  assert(saved.status === 503, `unreadable metadata target fails closed (got ${saved.status})`);
  assert(!newWarnings.includes(secretTag) && !newWarnings.includes(secretNote), 'metadata store failure logs no user-authored content');
}

console.log('\n[3] POST guard');
{
  const noHeader = await call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq('POST', { 'content-type': 'application/json' }, '{"sessionId":"session-a"}'));
  assert(noHeader.status === 403, `POST without guard header rejected (got ${noHeader.status})`);
  const wrongMethod = await call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq('GET', { 'x-dsh-archived-chats': '1' }));
  assert(wrongMethod.status === 405, `GET on a mutating route rejected (got ${wrongMethod.status})`);
  assert(workspaceState.archivedSessionIds.includes('session-a'), 'rejected calls never mutate the archive set');
}

console.log('\n[4] unarchive');
{
  const res = await call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-a"}'));
  assert(res.status === 200, `unarchive answers 200 (got ${res.status})`);
  assert(!workspaceState.archivedSessionIds.includes('session-a'), 'session-a left the archive set');
  assert(readMetadataStore().sessions['session-a'] !== undefined, 'unarchive retains the session metadata entry');
  assert(res.json().archivedSessionIds.length === 2, 'response carries the updated set');
  const again = await call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-a"}'));
  assert(again.status === 200, 'unarchiving a non-archived id is an idempotent 200');
  const missing = await call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{}'));
  assert(missing.status === 400, `missing sessionId rejected (got ${missing.status})`);
}

console.log('\n[5] delete — live session moves to recoverable trash');
{
  const liveHeader = { id: 'session-live', createdAt: 1, cwd: '/ws/one' };
  headerRows.push(liveHeader);
  events['session-live'] = [];
  registry.headers.set('session-live', liveHeader);
  workspaceState.archivedSessionIds.push('session-live');
  const res = await call(routes, '/plugins/dsh-archived-chats/__test_seed_legacy_trash', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-live"}'));
  assert(res.status === 200, `live session deletion accepted (got ${res.status}: ${res.body})`);
  const body = res.json();
  assert(body.trashed.includes('session-live'), 'live session reported as trashed');
  assert(body.failed.length === 0, 'no failures for a parked snapshot-capable session');
  assert(existsSync(join(tmp, 'session-live')), 'live session files untouched');
  assert(workspaceState.archivedSessionIds.includes('session-live'), 'parked session stays archived (invisible)');
  assert(!readPendingStore().includes('session-live'), 'new recycle flow does not add a legacy pending marker');
  assert(readMetadataStore().sessions['session-live'] !== undefined, 'trash keeps metadata');
  const stateAfterPark = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(!stateAfterPark.json().sessions.some((s) => s.id === 'session-live'), 'parked session excluded from /state listing');
  const statsAfterPark = await call(routes, '/plugins/dsh-archived-chats/stats', mockReq('GET', {}));
  assert(statsAfterPark.json().summary.sessionCount === 2, 'stats exclude a trashed session');
  assert(statsAfterPark.json().sessions['session-live'] === undefined, 'stats omit the parked session row');
  const pendingImage = await call(
    routes,
    '/plugins/dsh-archived-chats/preview/image',
    mockReq('POST', {
      'content-type': 'application/json',
      'x-dsh-archived-chats': '1',
    }, JSON.stringify({ sessionId: 'session-live', attachmentId: archivedImageRef.attachmentId })),
  );
  assert(pendingImage.status === 404, 'ordinary preview image denies a trashed session');
  const trashSearch = await call(routes, '/plugins/dsh-archived-chats/search', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ query: 'secret', sessionIds: ['session-live'] })));
  assert(trashSearch.status === 200 && trashSearch.json().hits.length === 0 && trashSearch.json().skipped[0]?.reason === 'session-not-visible', 'explicit search candidates cannot expose Recycle Bin content');
  const trashPreview = await call(routes, '/plugins/dsh-archived-chats/preview', mockReq(
    'POST', { 'content-type': 'application/json', 'x-dsh-archived-chats': '1' },
    JSON.stringify({ sessionId: 'session-live', scope: 'trash' }),
  ));
  assert(trashPreview.status === 200 && trashPreview.json().session.id === 'session-live', 'trash-scoped preview authorizes the recycle record');
  const restored = await call(routes, '/plugins/dsh-archived-chats/trash/restore', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, '{"sessionIds":["session-live"]}',
  ));
  assert(restored.status === 200 && restored.json().restored.includes('session-live'), 'trashed live session can be restored');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((id) => id !== 'session-live');
  headerRows.splice(headerRows.indexOf(liveHeader), 1);
  delete events['session-live'];
  registry.headers.delete('session-live');
}

console.log('\n[5b] delete — live session disposed in place (no restart needed)');
{
  const id = 'session-live2';
  mkdirSync(join(tmp, id), { recursive: true });
  writeFileSync(join(tmp, id, 'session.jsonl.zstd'), 'fake');
  headerRows.push({ id, createdAt: 1786726600000, cwd: '/ws/one' });
  events[id] = [];
  workspaceState.archivedSessionIds.push(id);
  const calls = { cancel: null, idle: 0, flush: 0, scope: 0, agentDetach: 0, sessionDetach: 0 };
  const sessionObj = { id, header: { id, createdAt: 1786726600000 } };
  const agentObj = {
    cancel: (cause) => { calls.cancel = cause; },
    whenIdle: async () => { calls.idle += 1; },
    scope: { dispose: async () => { calls.scope += 1; } },
  };
  const sessionsStore = new Map([[id, {
    session: sessionObj,
    detach: () => { calls.sessionDetach += 1; sessionsStore.delete(id); },
  }]]);
  // Real AgentRegistry entries carry NO detach — unregistration goes through
  // the registry's detachEntered(entry), which is what the plugin must call.
  const agentsStore = new Map([[id, { id, agent: agentObj, announcing: false }]]);
  services.sessions = {
    get: (sid) => sessionsStore.get(sid)?.session,
    store: sessionsStore,
    flush: async () => { calls.flush += 1; },
  };
  services.agents = {
    get: (sid) => agentsStore.get(sid)?.agent,
    store: agentsStore,
    detachEntered: (entry) => { calls.agentDetach += 1; agentsStore.delete(entry.id); },
  };
  const res = await call(routes, '/plugins/dsh-archived-chats/__test_seed_legacy_trash', mockReq('POST', { 'x-dsh-archived-chats': '1' }, `{"sessionId":"${id}"}`));
  assert(res.status === 200, `in-place trash move answers 200 (got ${res.status}: ${res.body})`);
  const body = res.json();
  assert(body.trashed.includes(id), 'live session reported as trashed');
  assert(body.failed.length === 0, 'no failed entries');
  assert(existsSync(join(tmp, id)), 'trash move preserves the session directory');
  assert(workspaceState.archivedSessionIds.includes(id), 'trashed session stays archived');
  assert(!readPendingStore().includes(id), 'pending-store crash bracket cleared after completion');
  const purged = await call(routes, '/plugins/dsh-archived-chats/trash/purge', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [id] }),
  ));
  assert(purged.status === 200 && purged.json().purged.includes(id), 'explicit recycle purge succeeds');
  assert(calls.cancel?.kind === 'disposed', 'agent cancelled with the disposed cause');
  assert(calls.idle === 1, 'quiescence awaited before flush');
  assert(calls.flush === 1, 'durability flushed before detach');
  assert(calls.scope === 1, 'agent fiber disposed (factory disposer order)');
  assert(calls.agentDetach === 1 && calls.sessionDetach === 1, 'both store entries detached');
  assert(!existsSync(join(tmp, id)), 'permanent purge removes the session directory');
  assert(!workspaceState.archivedSessionIds.includes(id), 'permanent purge removes archive membership');
  headerRows.splice(headerRows.findIndex((header) => header.id === id), 1);
  services.sessions = liveSessions;
  delete services.agents;
}

console.log('\n[6] delete — full path');
{
  const res = await call(routes, '/plugins/dsh-archived-chats/__test_seed_legacy_trash', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-b"}'));
  assert(res.status === 200 && res.json().trashed.includes('session-b'), `trash move answers 200 (got ${res.status})`);
  assert(workspaceState.archivedSessionIds.includes('session-b'), 'trash move keeps archive membership');
  assert(existsSync(join(tmp, 'session-b')), 'trash move keeps session directory');
  assert(readMetadataStore().sessions['session-b'] !== undefined, 'trash move keeps metadata');
  const purge = await call(routes, '/plugins/dsh-archived-chats/trash/purge', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, '{"sessionIds":["session-b"]}',
  ));
  assert(purge.status === 200 && purge.json().purged.includes('session-b'), 'permanent purge answers 200');
  assert(!workspaceState.archivedSessionIds.includes('session-b'), 'deleted session left the archive set');
  assert(detached.includes('session-b'), 'deleted session detached from its workspace record');
  assert(!existsSync(join(tmp, 'session-b')), 'session directory removed from disk');
  assert(!registry.headers.has('session-b'), 'registry header index purged (no ghost re-archive)');
  assert(!registry.sessionPaths.has('session-b'), 'registry session-path index purged');
  assert(registry.headers.has('session-c'), 'other sessions stay indexed');
  assert(readMetadataStore().sessions['session-b'] === undefined, 'cold delete removes metadata after physical deletion');
  headerRows.splice(headerRows.findIndex((header) => header.id === 'session-b'), 1);

  const directDelete = await call(routes, '/plugins/dsh-archived-chats/delete-all', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: ['session-c'], permanent: true }),
  ));
  assert(directDelete.status === 200 && directDelete.json().deleted.includes('session-c'), 'direct permanent delete answers 200');
  assert(!existsSync(join(tmp, 'session-c')), 'direct permanent delete skips recycle and removes the session directory');
  assert(!workspaceState.archivedSessionIds.includes('session-c'), 'direct permanent delete removes archive membership');
  headerRows.splice(headerRows.findIndex((header) => header.id === 'session-c'), 1);

  headerRows.push({ id: 'session-c', createdAt: 1786726500000, cwd: '/ws/one' });
  events['session-c'] = [];
  mkdirSync(join(tmp, 'session-c'), { recursive: true });
  writeFileSync(join(tmp, 'session-c', 'session.jsonl.zstd'), 'restored');
  workspaceState.archivedSessionIds.push('session-c');
  registry.headers.set('session-c', headerRows.at(-1));
  registry.sessionPaths.set('session-c', '/ws/one');
  mkdirSync(join(tmp, 'session-b'), { recursive: true });
  writeFileSync(join(tmp, 'session-b', 'session.jsonl.zstd'), 'restored');
  headerRows.push({ id: 'session-b', createdAt: 1786726400000, cwd: '/ws/two', parentSession: 'session-a', seedLength: 2, origin: 'subagent', delegationDepth: 1 });
  workspaceState.archivedSessionIds.push('session-b');
  const statsAfterRearchive = await call(routes, '/plugins/dsh-archived-chats/stats', mockReq('GET', {}));
  assert(statsAfterRearchive.json().sessions['session-b'].sizeBytes === 8, 'delete invalidates cached stats before a session is re-archived');
}

console.log('\n[7] delete fails without a resolvable physical location');
{
  const id = 'session-unconfirmed';
  mkdirSync(join(tmp, id), { recursive: true });
  writeFileSync(join(tmp, id, 'session.jsonl.zstd'), 'fake');
  workspaceState.archivedSessionIds.push(id);
  const metadata = readMetadataStore();
  metadata.sessions[id] = { tags: ['keep'], note: 'physical log remains', updatedAt: '2026-08-18T12:00:00.000Z' };
  writeFileSync(metadataFile, JSON.stringify(metadata), 'utf8');
  const header = { id, createdAt: 1786726700000, cwd: '/ws/one' };
  headerRows.push(header);
  events[id] = [{ type: 'session/title', data: { title: 'Cached before failed delete' } }];
  registry.headers.set(id, header);
  registry.sessionPaths.set(id, join(tmp, id));
  registry.invalidSessionPaths.set(id, 'temporary parse warning');
  const warmed = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(warmed.json().sessions.some((session) => session.id === id && session.title === 'Cached before failed delete'), 'fixture warms the title cache before deletion');
  headerRows.splice(headerRows.indexOf(header), 1);
  delete events[id];
  const list = persistence.list;
  const locate = persistence.locate;
  persistence.list = async () => { throw new Error('temporary header listing outage'); };
  persistence.locate = async () => undefined;
  const res = await call(routes, '/plugins/dsh-archived-chats/__test_seed_legacy_trash', mockReq('POST', { 'x-dsh-archived-chats': '1' }, `{"sessionId":"${id}"}`));
  persistence.list = list;
  persistence.locate = locate;
  assert(res.status === 409 && res.json().failed.some((failure) => failure.id === id), 'unconfirmed delete reports the session as failed');
  assert(existsSync(join(tmp, id)), 'unconfirmed delete leaves the physical session directory');
  assert(readMetadataStore().sessions[id] !== undefined, 'unconfirmed delete retains authoritative metadata');
  assert(workspaceState.archivedSessionIds.includes(id), 'unconfirmed delete keeps the session archived and visible');
  assert(!readPendingStore().includes(id), 'cold unconfirmed delete introduces no pending marker');
  assert(registry.headers.has(id) && registry.sessionPaths.has(id) && registry.invalidSessionPaths.has(id), 'unconfirmed delete retains every registry index');
  const afterFailure = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(afterFailure.json().sessions.some((session) => session.id === id && session.title === 'Cached before failed delete'), 'unconfirmed delete retains the cached title when persistence remains unavailable');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((sessionId) => sessionId !== id);
  registry.headers.delete(id);
  registry.sessionPaths.delete(id);
  registry.invalidSessionPaths.delete(id);
  const cleanedMetadata = readMetadataStore();
  delete cleanedMetadata.sessions[id];
  writeFileSync(metadataFile, JSON.stringify(cleanedMetadata), 'utf8');
  rmSync(join(tmp, id), { recursive: true, force: true });
}

console.log('\n[8] delete-all — partial failure keeps going');
{
  const corruptMetadata = '{broken';
  writeFileSync(metadataFile, corruptMetadata, 'utf8');
  workspaceState.archivedSessionIds.push('session-live');
  const res = await call(routes, '/plugins/dsh-archived-chats/delete-all', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionIds":["session-c","session-live","session-b"]}'));
  const body = res.json();
  assert(res.status === 410, `retired batch recycle answers 410 (got ${res.status})`);
  assert(body.error === 'recycle-retired', 'retired recycle never becomes a permanent deletion');
  assert(existsSync(join(tmp, 'session-c')), 'failed trash move keeps session-c directory');
  assert(readFileSync(metadataFile, 'utf8') === corruptMetadata, 'failed trash move leaves corrupt metadata bytes untouched');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((id) => id !== 'session-live');
  writeFileSync(metadataFile, JSON.stringify({ version: 1, sessions: {} }), 'utf8');
}

console.log('\n[9] retirement preserves parked legacy deletion reservations');
{
  const pendingPath = join(testHome, 'plugin-data', 'archived-chats', 'pending-deletions.json');
  writeFileSync(pendingPath, JSON.stringify({ ids: ['session-live'] }));
  listeners.length = 0;
  applyPlugin(ctx);
  assert(readPendingStore().includes('session-live'), 'startup does not migrate or delete old pending records');
  writeFileSync(pendingPath, JSON.stringify({ ids: [] }));
}

//#region client-half fixture
const clientSource = readFileSync(join(here, '../lib/client.js'), 'utf8');
const headChildren = [];
const createdElements = [];
function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(), id: '', attrs: {}, textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    children: [],
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    click() { this.clicked = (this.clicked ?? 0) + 1; },
    submit() { this.submitted = (this.submitted ?? 0) + 1; },
    remove() { this.removed = true; },
  };
  createdElements.push(el);
  return el;
}
let mockDialogs = [];
const documentMock = {
  createElement: (tag) => makeElement(tag),
  head: { appendChild: (c) => headChildren.push(c) },
  body: { children: [], appendChild(child) { this.children.push(child); child.parentNode = this; return child; } },
  activeElement: null,
  contains: () => true,
  querySelectorAll: (sel) => (sel === '[role="dialog"]' ? mockDialogs : []),
  getElementById: (id) => createdElements.find((e) => e.id === id && !e.removed) || null,
};
const documentListeners = new Map();
documentMock.addEventListener = (event, handler) => documentListeners.set(event, handler);
documentMock.removeEventListener = (event, handler) => {
  if (documentListeners.get(event) === handler) documentListeners.delete(event);
};
const observers = [];
class MockMutationObserver {
  constructor(cb) { this.cb = cb; observers.push(this); }
  observe(target, opts) { this.target = target; this.opts = opts; }
  disconnect() { this.disconnected = true; }
}
const storageMap = new Map();
function MarkdownTextStub(props) { return { type: 'markdown-stub', props }; }
function ToastStub(props) { return { type: 'native-toast-stub', props }; }
function DisclosureRowStub(props) { return { type: 'disclosure-stub', props: { ...props, children: [props.title, props.children] } }; }
function JsonBlockStub(props) { return { type: 'json-stub', props }; }
function MenuActionStub(props) { return { type: 'button', props: { type: 'button', role: 'menuitem', disabled: props.disabled, onClick: props.onSelect, children: props.label } }; }
function defineStoreStub(spec) {
  return {
    spec,
    create() {
      const listeners = new Set();
      const state = spec.init();
      const actions = Object.fromEntries(Object.entries(spec.actions).map(([name, mutate]) => [name, (...args) => {
        mutate(state, ...args);
        for (const listener of listeners) listener();
      }]));
      return {
        actions,
        getSnapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        clearPersisted: () => {},
      };
    },
  };
}
const moduleTable = {
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  '@deepseek-ai/dsh-client-ui-primitives': {
    Toast: ToastStub,
    MarkdownText: MarkdownTextStub,
    DisclosureRow: DisclosureRowStub,
    JsonBlock: JsonBlockStub,
    MenuAction: MenuActionStub,
  },
  '@deepseek-ai/dsh-client-store': { defineStore: defineStoreStub },
  react: {
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  },
};
let loadedModule = null;
let clientExports = null;
const windowMock = {
  __ModuleLoader__: { load: (def) => { loadedModule = def; } },
  localStorage: {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
  },
  MutationObserver: MockMutationObserver,
};
const clientCalls = { localeRegister: [], slotRegister: [], effects: [], sidebarRefresh: 0, workspaceArchive: [], workspaceRefresh: 0 };
const clientServices = {
  sessions: { refresh: () => { clientCalls.sidebarRefresh += 1; return Promise.resolve(); } },
  workspaces: {
    archiveSession: async (sessionId) => { clientCalls.workspaceArchive.push(sessionId); },
    refresh: async () => { clientCalls.workspaceRefresh += 1; },
  },
};
const clientCtx = {
  get: (key) => clientServices[key],
  locale: {
    register: (ns, dicts) => { clientCalls.localeRegister.push({ ns, dicts }); return () => {}; },
    bind: (ns) => (key) => clientCalls.localeRegister.find((r) => r.ns === ns)?.dicts?.zh?.[key] ?? key,
  },
  slots: {
    inject: (name, cb) => cb(),
    register: (meta, component) => { clientCalls.slotRegister.push({ meta, component }); return () => {}; },
  },
  effect: (fn) => { clientCalls.effects.push(true); if (typeof fn === 'function') fn(); },
};
const originalWorkspaceArchiveMethod = clientServices.workspaces.archiveSession;
//#endregion

console.log('\n[10] client half — module registration');
{
  const fn = new Function('window', 'document', 'require', clientSource);
  fn(windowMock, documentMock, (name) => {
    if (!(name in moduleTable)) throw new Error(`unexpected require: ${name}`);
    return moduleTable[name];
  });
  assert(loadedModule !== null, 'client.js registers itself via __ModuleLoader__.load');
  assert(loadedModule.id === 'dsh-archived-chats', `module id is "dsh-archived-chats" (got "${loadedModule.id}")`);
  clientExports = loadedModule.factory((name) => moduleTable[name]);
  assert(typeof clientExports.apply === 'function', 'exports.apply is a function');
  assert(JSON.stringify(clientExports.inject) === JSON.stringify(['slots', 'locale']), 'inject declares exactly [slots, locale]');
  assert(clientExports.SETTINGS_NS === 'settings.archived-chats', 'SETTINGS_NS exported');
}

console.log('\n[10b] client model — sorting and visible selection');
{
  const rows = [
    { id: 'b', title: 'Beta', createdAt: 20 },
    { id: 'untitled', title: null, createdAt: null },
    { id: 'a', title: 'Alpha', createdAt: 10 },
  ];
  const filterRows = [{ id: 'scheduled', workspaceId: 'w1', hasSchedule: true }, { id: 'free', workspaceId: null, hasSchedule: false }, { id: 'unknown', workspaceId: 'w2', hasSchedule: null }];
  assert(JSON.stringify(clientExports.__test.archiveSearchCandidates(filterRows, '__dac_scheduled__', 'all', '', 'en-US')) === JSON.stringify(['scheduled']), 'scheduled scope matches official bindings across workspaces');
  assert(JSON.stringify(clientExports.__test.archiveSearchCandidates(filterRows, 'ungrouped', 'all', '', 'en-US')) === JSON.stringify(['free']), 'ungrouped scope matches sessions without workspace membership');
  const newest = clientExports.__test.sortArchivedSessions(rows, 'newest', 'en-US');
  const oldest = clientExports.__test.sortArchivedSessions(rows, 'oldest', 'en-US');
  const byTitle = clientExports.__test.sortArchivedSessions(rows, 'title', 'en-US');
  assert(newest.map((row) => row.id).join(',') === 'b,a,untitled', 'newest sort puts missing dates last');
  assert(oldest.map((row) => row.id).join(',') === 'a,b,untitled', 'oldest sort puts missing dates last');
  assert(byTitle.map((row) => row.id).join(',') === 'a,b,untitled', 'title sort puts untitled chats last');
  assert(rows.map((row) => row.id).join(',') === 'b,untitled,a', 'sorting never mutates session state');

  const activityRows = [
    { id: 'b', createdAt: 10, updatedAt: 90 },
    { id: 'a', createdAt: 20, updatedAt: 90 },
    { id: 'newly-created', createdAt: 80, updatedAt: 80 },
    { id: 'fallback', createdAt: 30, updatedAt: NaN },
    { id: 'epoch', createdAt: 0, updatedAt: 0 },
    { id: 'unknown', createdAt: null, updatedAt: null },
  ];
  assert(clientExports.__test.sortArchivedSessions(activityRows, 'newest', 'en-US').map(row => row.id).join(',') === 'a,b,newly-created,fallback,epoch,unknown',
    'recently updated uses activity before creation, Host ID tie-breaking, and safe fallback');
  assert(clientExports.__test.sortArchivedSessions(activityRows, 'oldest', 'en-US').map(row => row.id).join(',') === 'epoch,fallback,newly-created,a,b,unknown',
    'least recently updated reverses activity order while keeping unknown dates last');

  const selected = new Set(['hidden', 'a']);
  const selectedVisible = clientExports.__test.setVisibleSelection(selected, ['a', 'b'], true);
  assert([...selectedVisible].sort().join(',') === 'a,b,hidden', 'select-visible preserves hidden selections');
  const deselectedVisible = clientExports.__test.setVisibleSelection(selectedVisible, ['a', 'b'], false);
  assert([...deselectedVisible].join(',') === 'hidden', 'clear-visible preserves hidden selections');

  assert(clientExports.__test.formatBytes(0) === '0 B', 'formats zero bytes');
  assert(clientExports.__test.formatBytes(1536) === '1.5 KB', 'formats binary kilobytes');
  assert(clientExports.__test.matchesArchivedSession(
    { title: 'Alpha', workspaceTitle: '项目', tags: ['Research'], note: 'follow up' },
    'follow',
    'en-US',
  ) === true, 'search includes note text');
  assert(clientExports.__test.matchesArchivedSession(
    { title: 'Alpha', workspaceTitle: '项目', tags: ['Research'], note: '' },
    'research',
    'en-US',
  ) === true, 'search includes tags');
  assert(clientExports.__test.filterByTag({ tags: ['Important'] }, 'important') === true, 'tag filter is case-insensitive');
  assert(clientExports.__test.filterByTag({ tags: ['other'] }, 'all') === false, 'literal all filters instead of acting as the no-filter sentinel');

  assert(
    JSON.stringify(clientExports.__test.editIconSpec) === JSON.stringify({
      size: 16,
      viewBox: '0 0 1024 1024',
      fill: 'currentColor',
      paths: [
        'M832 512a32 32 0 1 1 64 0v352a32 32 0 0 1-32 32H160a32 32 0 0 1-32-32V160a32 32 0 0 1 32-32h352a32 32 0 0 1 0 64H192v640h640V512z',
        'm469.952 554.24 52.8-7.552L847.104 222.4a32 32 0 1 0-45.248-45.248L477.44 501.44l-7.552 52.8zm422.4-422.4a96 96 0 0 1 0 135.808l-331.84 331.84a32 32 0 0 1-18.112 9.088L436.8 623.68a32 32 0 0 1-36.224-36.224l15.104-105.6a32 32 0 0 1 9.024-18.112l331.84-331.84a96 96 0 0 1 135.808 0z',
      ],
    }),
    'desktop edit action uses the Element Plus square edit icon',
  );

  const dialogAttrs = new Map();
  const responsiveDialog = {
    setAttribute: (name, value) => dialogAttrs.set(name, String(value)),
    getAttribute: (name) => dialogAttrs.get(name) ?? null,
    removeAttribute: (name) => dialogAttrs.delete(name),
  };
  const archivePage = { closest: (selector) => selector === '[role="dialog"]' ? responsiveDialog : null };
  const cleanupResponsiveDialog = clientExports.__test.markArchiveDialog?.(archivePage);
  assert(dialogAttrs.get('data-dac-section-active') === '1', 'archive page marks only its host settings dialog for narrow-screen layout');
  cleanupResponsiveDialog?.();
  assert(!dialogAttrs.has('data-dac-section-active'), 'archive page removes the host layout marker when it unmounts');

  const unrelatedAttrs = new Map();
  const unrelatedPage = { closest: () => null };
  const cleanupUnrelatedPage = clientExports.__test.markArchiveDialog?.(unrelatedPage);
  cleanupUnrelatedPage?.();
  assert(unrelatedAttrs.size === 0, 'archive host adaptation ignores content outside a settings dialog');

  const savedExportFetch = globalThis.fetch;
  const savedExportUrl = windowMock.URL;
  const exportRequests = [];
  const exportUrls = [];
  const revokedExportUrls = [];
  windowMock.URL = {
    createObjectURL: (blob) => { exportUrls.push(blob); return `blob:export-${exportUrls.length}`; },
    revokeObjectURL: (url) => revokedExportUrls.push(url),
  };
  globalThis.fetch = async (url, options) => {
    exportRequests.push({ url: String(url), options });
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': "attachment; filename*=UTF-8''%E5%BD%92%E6%A1%A3.zip",
      },
    });
  };
  const anchorsBefore = createdElements.filter((element) => element.tagName === 'A').length;
  const exported = await clientExports.__test.submitExport?.(['session-b', 'session-a', 'session-b']);
  const anchors = createdElements.filter((element) => element.tagName === 'A');
  const exportAnchor = anchors.at(-1);
  assert(exported?.filename === '归档.zip' && anchors.length === anchorsBefore + 1, 'export helper resolves only after a ZIP response is ready to download');
  assert(exportRequests[0]?.url === '/plugins/dsh-archived-chats/export' && exportRequests[0]?.options.method === 'POST', 'export helper posts to the archive export route without navigating the app');
  assert(exportRequests[0]?.options.body === 'sessionIds=%5B%22session-b%22%2C%22session-a%22%5D', 'export helper preserves first-seen id order in the bounded request');
  assert(exportAnchor?.download === '归档.zip' && exportAnchor?.href === 'blob:export-1' && exportAnchor?.clicked === 1, 'export honors the attachment filename and starts the verified blob download');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(exportAnchor?.removed === true && revokedExportUrls[0] === 'blob:export-1', 'export releases its temporary anchor and object URL');
  let exportFailure;
  globalThis.fetch = async () => new Response('session-not-archived', { status: 404, headers: { 'content-type': 'text/plain' } });
  try { await clientExports.__test.submitExport?.(['session-a']); } catch (error) { exportFailure = error; }
  assert(exportFailure?.message.includes('session-not-archived') && exportUrls.length === 1, 'export reports an HTTP failure in place without creating a false download');
  let streamFailure;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream interrupted')); } }), {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="backup.zip"' },
  });
  try { await clientExports.__test.submitExport?.(['session-a']); } catch (error) { streamFailure = error; }
  assert(streamFailure instanceof Error && exportUrls.length === 1, 'export stream failure is surfaced before claiming a download');
  let oversizedCancellationReason = null;
  const oversizedResponse = new Response(new ReadableStream({
    cancel(reason) { oversizedCancellationReason = reason; },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="oversized.zip"',
      'content-length': String(320 * 1024 * 1024 + 1),
    },
  });
  let oversizedFailure;
  globalThis.fetch = async () => oversizedResponse;
  try { await clientExports.__test.submitExport?.(['session-a']); } catch (error) { oversizedFailure = error; }
  assert(oversizedFailure?.message === 'export-download-too-large'
    && oversizedCancellationReason === 'export-download-too-large'
    && oversizedResponse.bodyUsed === true,
  'declared oversized export cancels its genuine unread response stream before rejecting');
  assert(await clientExports.__test.submitExport?.([]) === false, 'export rejects an empty selection without a request');
  globalThis.fetch = savedExportFetch;
  windowMock.URL = savedExportUrl;

  const savedFetch = globalThis.fetch;
  const inspectRequests = [];
  globalThis.fetch = async (url, options) => {
    inspectRequests.push({ url, options });
    const body = String(url).endsWith('/preview')
      ? { ok: true, session: { id: 'session-a', title: 'Alpha' }, messages: [], total: 0, nextOffset: null }
      : String(url).endsWith('/search')
        ? { ok: true, query: 'needle', hits: [{ sessionId: 'session-a', matches: [{ seq: 1, excerpt: 'needle' }] }], skipped: [] }
        : { ok: true, token: 'token-a', nonce: 'nonce-a', sessions: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  const importPreview = await clientExports.__test.submitImportFile?.(new Blob(['zip'], { type: 'application/zip' }));
  assert(importPreview?.token === 'token-a', 'import helper returns inspect preview');
  assert(inspectRequests[0]?.url === '/plugins/dsh-archived-chats/import/inspect', 'import helper targets inspect route');
  assert(inspectRequests[0]?.options.method === 'POST', 'import helper uses POST');
  assert(inspectRequests[0]?.options.headers['x-dsh-archived-chats'] === '1', 'import helper sends the guard header');
  assert(inspectRequests[0]?.options.body instanceof FormData && inspectRequests[0]?.options.body.get('file') !== null, 'import helper sends a multipart file field');

  assert(typeof clientExports.__test.fetchArchivePreview === 'function', 'client exposes the archive preview request boundary');
  const previewController = new AbortController();
  const previewBody = await clientExports.__test.fetchArchivePreview?.('session-a', 50, 25, previewController.signal);
  const previewRequest = inspectRequests.at(-1);
  assert(previewBody?.session?.id === 'session-a', 'preview helper returns the projected page');
  assert(previewRequest?.url === '/plugins/dsh-archived-chats/preview', 'preview helper targets the guarded preview route');
  assert(previewRequest?.options.method === 'POST' && previewRequest?.options.headers['x-dsh-archived-chats'] === '1', 'preview helper uses a guarded POST');
  assert(previewRequest?.options.signal === previewController.signal, 'preview helper forwards cancellation');
  assert(previewRequest?.options.body === '{"sessionId":"session-a","offset":50,"limit":25}', 'preview helper sends the requested timeline window');

  // Every non-default scope must reach the Host. Naming only "trash" here
  // downgraded any other scope to "archive", and the Host then answered 404
  // because the session is not archived at all.
  await clientExports.__test.fetchArchivePreview?.('orphan-a', 0, 50, previewController.signal, 'orphan');
  assert(inspectRequests.at(-1)?.options.body === '{"sessionId":"orphan-a","offset":0,"limit":50,"scope":"orphan"}',
    'preview helper forwards an orphan scope instead of falling back to archive');
  await clientExports.__test.fetchArchivePreview?.('session-a', 0, 50, previewController.signal, 'trash');
  assert(inspectRequests.at(-1)?.options.body === '{"sessionId":"session-a","offset":0,"limit":50,"scope":"trash"}',
    'preview helper still forwards the recycle scope');
  await clientExports.__test.fetchArchivePreview?.('session-a', 0, 50, previewController.signal);
  assert(inspectRequests.at(-1)?.options.body === '{"sessionId":"session-a","offset":0,"limit":50}',
    'the default archive scope stays implicit');

  assert(typeof clientExports.__test.fetchArchiveSearch === 'function', 'client exposes the archive full-text request boundary');
  const searchController = new AbortController();
  const searchBody = await clientExports.__test.fetchArchiveSearch?.('needle', 20, searchController.signal);
  const searchRequest = inspectRequests.at(-1);
  assert(searchBody?.hits?.[0]?.sessionId === 'session-a', 'search helper returns full-text hits');
  assert(searchRequest?.url === '/plugins/dsh-archived-chats/search', 'search helper targets the guarded search route');
  assert(searchRequest?.options.method === 'POST' && searchRequest?.options.headers['x-dsh-archived-chats'] === '1', 'search helper uses a guarded POST');
  assert(searchRequest?.options.signal === searchController.signal, 'search helper forwards cancellation');
  assert(searchRequest?.options.body === '{"query":"needle","limit":20}', 'search helper sends only the bounded query contract');

  const trashRows = [
    { sessionId: 'session-a', state: 'trashed', title: 'Alpha', workspace: { id: 'ws-1', title: '项目一', path: '/private' } },
    { sessionId: 'session-b', state: 'degraded', title: 'Beta', workspace: null },
    { sessionId: 'session-c', state: 'purge-pending', title: 'Gamma', workspace: { id: 'ws-1', title: '项目一', path: '/private' } },
  ];
  globalThis.fetch = async (url, options = {}) => {
    inspectRequests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ status: 'ready', sessions: trashRows, summary: { total: 3 } }) };
  };
  const trashBody = await clientExports.__test.fetchTrash?.();
  let trashRequest = inspectRequests.at(-1);
  assert(trashBody?.sessions?.length === 3, 'trash helper returns recycle rows');
  assert(trashRequest?.url === '/plugins/dsh-archived-chats/trash', 'trash helper targets the recycle route');
  assert(trashRequest?.options.cache === 'no-store' && trashRequest?.options.method === undefined, 'trash helper uses an uncached GET');

  const restored = await clientExports.__test.restoreTrash?.(['session-b', 'session-a', 'session-b']);
  trashRequest = inspectRequests.at(-1);
  assert(restored?.status === 'ready', 'restore helper returns the host response');
  assert(trashRequest?.url === '/plugins/dsh-archived-chats/trash/restore', 'restore targets trash route');
  assert(trashRequest?.options.method === 'POST', 'restore uses POST');
  assert(trashRequest?.options.headers['x-dsh-archived-chats'] === '1', 'restore sends guard');
  assert(trashRequest?.options.body === '{"sessionIds":["session-b","session-a"]}', 'restore preserves unique order');

  await clientExports.__test.purgeTrash?.(['session-c', 'session-a', 'session-c']);
  trashRequest = inspectRequests.at(-1);
  assert(trashRequest?.url === '/plugins/dsh-archived-chats/trash/purge', 'purge targets trash route');
  assert(trashRequest?.options.method === 'POST' && trashRequest?.options.headers['x-dsh-archived-chats'] === '1', 'purge uses guarded POST');
  assert(trashRequest?.options.body === '{"sessionIds":["session-c","session-a"]}', 'purge preserves unique order');

  const capturedEmptyTarget = {
    sessionId: 'session-c', state: 'trashed', trashedAt: '2026-08-24T00:00:00.000Z',
    snapshotId: 'snapshot-c', bytes: 30,
  };
  await clientExports.__test.emptyTrash?.([capturedEmptyTarget]);
  trashRequest = inspectRequests.at(-1);
  assert(trashRequest?.url === '/plugins/dsh-archived-chats/trash/empty', 'empty targets trash authority route');
  assert(trashRequest?.options.method === 'POST' && trashRequest?.options.headers['x-dsh-archived-chats'] === '1', 'empty uses guarded POST');
  assert(trashRequest?.options.body === '{"targets":[{"sessionId":"session-c","state":"trashed","trashedAt":"2026-08-24T00:00:00.000Z","snapshotId":"snapshot-c","bytes":30}]}',
    'empty sends the exact captured record incarnation');
  let emptyRestoreError = null;
  try { await clientExports.__test.restoreTrash?.([]); } catch (error) { emptyRestoreError = error; }
  assert(/sessionIds is required/u.test(String(emptyRestoreError?.message)), 'restore rejects an empty selection before fetch');
  let emptyPurgeError = null;
  try { await clientExports.__test.purgeTrash?.([]); } catch (error) { emptyPurgeError = error; }
  assert(/sessionIds is required/u.test(String(emptyPurgeError?.message)), 'purge rejects an empty selection before fetch');

  globalThis.fetch = async (url, options = {}) => {
    inspectRequests.push({ url, options });
    const path = String(url);
    const body = path.endsWith('/insights')
      ? { summary: { sessionBytes: 10, snapshotBytes: 20, totalMeasuredBytes: 30, duplicateSnapshotBytes: 0, sessionUnavailableCount: 0, degradedSnapshotCount: 0 }, sessions: [], snapshots: [], policy: { historicalSnapshotsPerSession: 1, historicalSnapshotMaxAgeDays: null, snapshotQuotaBytes: null, recycleMaxAgeDays: null }, candidateSummary: { snapshotCount: 0, recycleCount: 0, projectedSnapshotBytes: 20 } }
      : path.endsWith('/retention/preview')
        ? { token: 'retention-token', nonce: 'retention-nonce', candidates: [] }
        : path.endsWith('/lineage')
          ? { roots: [{ id: 'root', title: 'Root', children: [] }], diagnostics: [], nodeCount: 1 }
          : { ok: true, policy: { historicalSnapshotsPerSession: 1 } };
    return { ok: true, status: 200, json: async () => body };
  };
  const insightsController = new AbortController();
  const insightsBody = await clientExports.__test.fetchInsights?.(insightsController.signal);
  let featureRequest = inspectRequests.at(-1);
  assert(insightsBody?.summary?.totalMeasuredBytes === 30, 'insights helper returns storage totals');
  assert(featureRequest?.url === '/plugins/dsh-archived-chats/insights' && featureRequest?.options.cache === 'no-store' && featureRequest?.options.signal === insightsController.signal, 'insights helper uses cancellable uncached GET');
  await clientExports.__test.saveRetentionPolicy?.({ historicalSnapshotsPerSession: 1, historicalSnapshotMaxAgeDays: null, snapshotQuotaBytes: null, recycleMaxAgeDays: null });
  featureRequest = inspectRequests.at(-1);
  assert(featureRequest?.url === '/plugins/dsh-archived-chats/retention/policy' && featureRequest?.options.headers['x-dsh-archived-chats'] === '1', 'retention save uses guarded policy route');
  const retentionPreview = await clientExports.__test.previewRetention?.();
  assert(retentionPreview?.token === 'retention-token', 'retention helper returns preview authority');
  await clientExports.__test.applyRetention?.('retention-token', 'retention-nonce', ['snapshot:s1', 'snapshot:s1']);
  featureRequest = inspectRequests.at(-1);
  assert(featureRequest?.options.body === '{"token":"retention-token","nonce":"retention-nonce","keys":["snapshot:s1"]}', 'retention apply preserves unique ordered candidate keys');
  const lineageController = new AbortController();
  const lineageBody = await clientExports.__test.fetchLineage?.(lineageController.signal);
  featureRequest = inspectRequests.at(-1);
  assert(lineageBody?.roots?.[0]?.id === 'root' && featureRequest?.url.endsWith('/lineage') && featureRequest?.options.signal === lineageController.signal, 'lineage helper returns cancellable uncached forest');

  const defaults = clientExports.__test.defaultRetentionSelection?.([
    { key: 'snapshot:s1', action: 'delete-snapshot' },
    { key: 'trash:t1', action: 'purge-trash' },
  ]);
  assert([...defaults].join(',') === 'snapshot:s1', 'retention preview never preselects permanent recycle purges');
  const lineageVisible = clientExports.__test.filterLineageForest?.([{
    id: 'root', title: 'Root', children: [{ id: 'child', title: 'Child', children: [{ id: 'grandchild', title: 'Needle', children: [] }] }],
  }], 'needle');
  assert(lineageVisible?.[0]?.children?.[0]?.children?.[0]?.id === 'grandchild', 'lineage search preserves ancestors of a matching descendant');
  const projectFiltered = clientExports.__test.filterLineageForest?.([{
    id: 'source', title: 'Shared source', workspace: { id: 'ws-source', title: 'Shared' }, children: [
      { id: 'alpha', title: 'Alpha chat', workspace: { id: 'ws-alpha', title: 'Project Alpha' }, children: [] },
      { id: 'beta', title: 'Beta chat', workspace: { id: 'ws-beta', title: 'Project Beta' }, children: [] },
    ],
  }], '', 'ws-beta');
  assert(JSON.stringify(projectFiltered?.map((node) => ({ id: node.id, children: node.children.map((child) => child.id) })))
    === '[{"id":"source","children":["beta"]}]',
  'lineage project filtering keeps the required ancestor path and removes branches from other projects');
  const projectSearch = clientExports.__test.filterLineageForest?.([{
    id: 'source', title: 'Shared source', workspace: { id: 'ws-source', title: 'Shared' }, children: [
      { id: 'beta', title: 'Ordinary title', workspace: { id: 'ws-beta', title: 'Project Beta' }, children: [] },
    ],
  }], 'project beta');
  assert(projectSearch?.[0]?.children?.[0]?.id === 'beta', 'lineage search matches project names while preserving their ancestor context');
  const statusFiltered = clientExports.__test.filterLineageForest?.([{
    id: 'source', title: 'Source', status: 'active', workspace: { id: 'ws-source', title: 'Shared' }, children: [
      { id: 'archived', title: 'Archived chat', status: 'archived', workspace: { id: 'ws-one', title: 'Project One' }, children: [] },
      { id: 'trash', title: 'Recycled chat', status: 'trash', workspace: { id: 'ws-two', title: 'Project Two' }, children: [] },
    ],
  }], '', 'all', 'trash');
  assert(statusFiltered?.[0]?.id === 'source'
    && statusFiltered[0].children.length === 1
    && statusFiltered[0].children[0].id === 'trash',
  'lineage status filtering keeps necessary source context and only matching managed chats');
  let deepLineage = { id: 'deep-4999', title: 'Needle', children: [] };
  for (let index = 4998; index >= 0; index -= 1) deepLineage = { id: `deep-${index}`, title: '', children: [deepLineage] };
  const deepVisible = clientExports.__test.filterLineageForest?.([deepLineage], 'needle');
  let deepCursor = deepVisible?.[0];
  for (let index = 1; index < 5000; index += 1) deepCursor = deepCursor.children[0];
  assert(deepCursor?.id === 'deep-4999', 'lineage client filtering handles the advertised maximum depth');

  const allWorkspaceGroups = clientExports.__test.groupLineageWorkspaces?.([
    { id: 'live-only', title: 'Live only', status: 'active', workspace: { id: null, title: null }, children: [] },
  ], [{ id: 'empty', title: 'Empty workspace' }]);
  assert(!allWorkspaceGroups?.some(group => group.key === 'empty')
    && allWorkspaceGroups?.some(group => group.key === 'ungrouped' && group.count === 1 && !group.roots[0].contextOnly),
    'workspace grouping excludes empty inventory entries and retains related ungrouped chats');
  const activeOnly = clientExports.__test.filterLineageForest?.([
    { id: 'live', status: 'active', children: [] }, { id: 'archived', status: 'archived', children: [] },
  ], '', 'all', 'active');
  assert(activeOnly?.length === 1 && activeOnly[0].id === 'live', 'unarchived is an independent lineage status filter');

  const workspaceForest = [{
    id: 'origin-a', title: 'Original A', status: 'archived', workspace: { id: 'a', title: 'A' }, children: [{
      id: 'fork-b', title: 'Fork B', status: 'archived', workspace: { id: 'b', title: 'B' }, children: [{
        id: 'back-a', title: 'Back A', status: 'trash', workspace: { id: 'a', title: 'A' }, children: [],
      }],
    }],
  }, { id: 'loose', title: 'Loose', status: 'archived', workspace: null, children: [] }];
  const groupedLineage = clientExports.__test.groupLineageWorkspaces?.(workspaceForest);
  assert(JSON.stringify(groupedLineage?.map((group) => [group.key, group.count])) === '[["a",2],["b",1],["ungrouped",1]]',
    'workspace projection counts each managed session once including ungrouped and cross-workspace forks');
  assert(groupedLineage?.[0]?.roots?.[0]?.children?.[0]?.children?.[0]?.sourceParent?.id === 'fork-b'
    && groupedLineage?.[1]?.roots?.[0]?.children?.[0]?.sourceParent?.id === 'origin-a'
    && workspaceForest[0].children[0].id === 'fork-b',
    'splitting workspaces retains the exact parent source without mutating the original forest');

  const contextualForest = clientExports.__test.groupLineageWorkspaces?.([{
    id: 'live-source', title: 'Live source', status: 'active', workspace: { id: 'a', title: 'A' }, children: [{
      id: 'bridge', title: 'Bridge', status: 'archived', workspace: { id: 'b', title: 'B' }, children: [{
        id: 'recycled', title: 'Recycled', status: 'trash', workspace: { id: 'a', title: 'A' }, children: [],
      }],
    }],
  }]);
  const contextualA = contextualForest?.find(group => group.key === 'a');
  assert(contextualA?.roots[0]?.id === 'live-source'
    && contextualA.roots[0].children[0].id === 'bridge'
    && contextualA.roots[0].children[0].contextOnly === true
    && contextualA.roots[0].children[0].children[0].id === 'recycled'
    && contextualA.count === 2,
  'workspace lineage retains the exact source chain without counting cross-workspace context twice');

  const fullLineageId = 'session-d81d9954-a56b-4e47-a4ee-2eb2b5a81712';
  let copiedLineageId = null;
  const lineageT = (key) => ({
    'lineage.status.active': '来源会话',
    'lineage.status.archived': '已归档',
    'lineage.origin.session': '普通会话',
    'lineage.origin.subagent': '子代理',
    'lineage.untitled': '未命名会话',
    'lineage.sourceUnavailable': '来源信息不可用',
    'lineage.sourceContext': '来源于',
    'lineage.contextOnly': '活动会话，仅用于解释关系',
    'lineage.start': '起始会话',
    'lineage.created': '创建于',
    'lineage.project': '项目',
    'lineage.delegation': '委派层级',
    'lineage.noBranches': '无分支',
    'lineage.copyId': '复制 ID',
    'lineage.copiedId': '已复制',
    'locale.intl': 'zh-CN',
  })[key] ?? key;
  const unnamedActiveTree = clientExports.__test.LineageTreeNodes?.({
    nodes: [{ id: 'unnamed-active', status: 'active', title: null, children: [] }],
    collapsed: new Set(['unnamed-active']), t: lineageT,
  });
  assert(collectElements(unnamedActiveTree).find(el => el.type === 'strong')?.props.children === lineageT('lineage.untitled'),
    'an existing unarchived chat without a title is untitled, not an unavailable source');
  const lineageRowTree = clientExports.__test.LineageTreeNodes?.({
    nodes: [{
      id: 'session-source-1234567890-abcdefgh', title: '来源会话', status: 'active', contextOnly: true, origin: null, delegationDepth: 0, createdAt: 1,
      workspace: { id: 'ws-one', title: '项目一' },
      children: [{ id: fullLineageId, title: null, status: 'archived', origin: 'subagent', delegationDepth: 1, createdAt: 2, workspace: { id: 'ws-one', title: '项目一' }, children: [] }],
    }],
    collapsed: new Set(),
    onToggle: () => {},
    onCopy: (id) => { copiedLineageId = id; },
    copiedId: null,
    t: lineageT,
  });
  const lineageRowElements = collectElements(lineageRowTree);
  const lineageRows = lineageRowElements.filter((element) => element.type === 'div' && element.props?.className?.includes('dac-lineage-row'));
  const lineageContexts = lineageRowElements.filter((element) => element.type === 'div' && element.props?.className === 'dac-lineage-context');
  const lineagePrimaryLabels = lineageRowElements.filter((element) => element.type === 'strong').map(elementText);
  const lineageStatus = lineageRowElements.find((element) => element.type === 'span' && element.props?.className?.includes('dac-lineage-archived'));
  const lineageSourceContexts = lineageRowElements.filter((element) => element.props?.className === 'dac-lineage-source-context');
  const lineageSources = lineageRowElements.filter((element) => element.props?.className === 'dac-lineage-source');
  const lineageMetadata = lineageRowElements.find((element) => element.props?.className === 'dac-lineage-meta');
  const lineageFooter = lineageRowElements.find((element) => element.props?.className === 'dac-lineage-footer');
  const lineageCreated = lineageRowElements.find((element) => element.props?.className === 'dac-lineage-created');
  const lineageIdTexts = lineageRowElements.filter((element) => element.type === 'small' && element.props?.className === 'dac-lineage-id');
  const lineageCopy = lineageRowElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === `复制 ID ${fullLineageId}`);
  const lineageText = elementText(lineageRowTree);
  assert(lineagePrimaryLabels.includes('来源会话') && lineagePrimaryLabels.includes('未命名会话')
    && !lineagePrimaryLabels.includes(fullLineageId),
  'source ancestors have their own visible read-only row and never use IDs as titles');
  assert(JSON.stringify(lineageRowElements.filter(el => el.props?.role === 'listitem').map(el => el.props['aria-level'])) === '[1,2]',
    'source and child preserve their actual relationship levels');
  assert(lineageIdTexts.length === 1 && lineageIdTexts.some(el => el.props.title === fullLineageId && el.props.children === 'session-d81d…b5a81712'),
    'managed details retain compact IDs with a complete hover value');
  assert(lineageText.includes('由「来源会话」委派') && lineageText.includes('子代理 · 委派层级 1') && lineageText.includes('项目：项目一'),
    'subagent delegation is distinguished from ordinary forks');
  assert(lineageRows.length === 2 && lineageRows.some(el => el.props.className.includes('dac-lineage-context-card')),
    'source context is visible separately from the managed card');
  assert(elementText(lineageCreated).startsWith('创建于:') && collectElements(lineageFooter).some(el => el.props?.className === 'dac-lineage-id-actions'),
    'expanded details group creation time and copy-ID controls');
  assert(lineageSources.every(el => typeof el.props.title === 'string' && el.props.title.length > 0),
    'truncated source labels preserve their full explanation on hover');
  assert(elementText(lineageStatus) === '已归档', 'archive state is separate from the relationship type');
  lineageCopy?.props.onClick();
  assert(lineageCopy?.props.children === '复制 ID' && copiedLineageId === fullLineageId,
  'relationship row copies the exact full session ID from its compact display');

  const connectorNodes = [{
      id: 'root-connector', title: 'Root', status: 'archived', origin: null, children: [
        { id: 'branch-a', title: 'Branch A', status: 'archived', origin: null, children: [
          { id: 'leaf-a', title: 'Leaf A', status: 'archived', origin: null, children: [] },
        ] },
        { id: 'branch-b', title: 'Branch B', status: 'archived', origin: null, children: [] },
      ],
    }];
  let toggledConnectorId = null;
  const connectorTree = clientExports.__test.LineageTreeNodes?.({
    nodes: connectorNodes,
    collapsed: new Set(),
    onToggle: (id) => { toggledConnectorId = id; },
    t: lineageT,
  });
  const connectorElements = collectElements(connectorTree);
  const connectorItems = connectorElements.filter((element) => element.props?.role === 'listitem');
  const grandchildItem = connectorItems.find((element) => element.props?.['aria-level'] === 3);
  const grandchildElements = collectElements(grandchildItem);
  const continuingGuide = grandchildElements.find((element) => element.props?.className?.includes('dac-lineage-guide-continuing'));
  const childJunctions = connectorItems
    .filter((element) => element.props?.['aria-level'] === 2)
    .flatMap((element) => collectElements(element))
    .filter((element) => element.props?.className?.includes('dac-lineage-junction-child'));
  const childGuideCounts = connectorItems
    .filter((element) => element.props?.['aria-level'] === 2)
    .map((element) => collectElements(element).filter((child) => child.props?.className?.split(' ').includes('dac-lineage-guide')).length);
  const connectorToggles = connectorElements.filter((element) => element.type === 'button' && element.props?.className === 'dac-lineage-card-toggle');
  const connectorRails = connectorElements.filter((element) => element.props?.className === 'dac-lineage-rail');
  assert(connectorItems.every((element) => element.props?.style?.marginLeft === undefined)
    && continuingGuide !== undefined && childJunctions.length === 2,
    'lineage hierarchy retains explicit relationship connectors');
  assert(childGuideCounts.every((count) => count === 0), 'first-level branches do not add empty guide columns');
  assert(connectorToggles.length === 4 && connectorRails.every(rail => !collectElements(rail).some(el => el.type === 'button')),
    'each managed card has one disclosure and connector rails contain no duplicate control');
  const rootToggleButton = connectorToggles[0];
  assert(rootToggleButton?.props.children.at(-1)?.props.className === 'dac-lineage-card-chevron expanded',
    'the only disclosure chevron is at the trailing end of the card');
  rootToggleButton?.props.onClick();
  assert(toggledConnectorId === 'root-connector', 'one disclosure controls its own card and branch');
  assert(!connectorElements.some(el => el.type === 'details')
    && connectorElements.filter(el => el.props?.className === 'dac-lineage-detail-copy').length === 4,
    'expanded metadata uses the same disclosure as branches without nested details controls');
  const collapsedConnectorTree = clientExports.__test.LineageTreeNodes?.({
    nodes: connectorNodes,
    collapsed: new Set(['root-connector']),
    onToggle: () => {},
    t: lineageT,
  });
  const collapsedRootToggle = collectElements(collapsedConnectorTree)
    .find((element) => element.type === 'button' && element.props?.className === 'dac-lineage-card-toggle');
  const collapsedRootIcon = collectElements(collapsedRootToggle)
    .find((element) => element.type === 'span' && element.props?.className?.includes('dac-lineage-card-chevron'));
  assert(collapsedRootToggle?.props?.['aria-expanded'] === false && collapsedRootIcon?.props?.className === 'dac-lineage-card-chevron'
    && !collectElements(collapsedConnectorTree).some(el => el.props?.className === 'dac-lineage-detail-copy')
    && collectElements(collapsedConnectorTree).filter(el => el.props?.role === 'listitem').length === 1,
    'collapsed parent cards expose a downward accordion control');

  const deepRenderedTree = clientExports.__test.LineageTreeNodes?.({
    nodes: deepVisible,
    collapsed: new Set(),
    onToggle: () => {},
    t: lineageT,
  });
  const deepRenderedItems = deepRenderedTree?.props?.children ?? [];
  const deepestRenderedElements = collectElements(deepRenderedItems.at(-1));
  const deepestGuides = deepestRenderedElements.filter((element) => element.props?.className?.split(' ').includes('dac-lineage-guide'));
  assert(deepRenderedItems.length === 5000
    && deepRenderedItems.at(-1)?.props?.['aria-level'] === 5000
    && deepestGuides.length <= 2
    && deepestRenderedElements.some((element) => element.props?.className === 'dac-lineage-guide-overflow'),
  'deep lineage rendering stays iterative, preserves semantic depth, and keeps deep titles readable with at most two ancestor guide columns');

  const untitledParent = {
    id: 'parent-without-a-readable-title-1234567890', title: null, status: 'missing', origin: null, delegationDepth: 0, createdAt: 1,
    children: [{ id: 'child-with-a-title', title: 'Readable child', status: 'archived', origin: null, delegationDepth: 0, createdAt: 2, children: [] }],
  };
  const zhUntitledSource = clientExports.__test.LineageTreeNodes?.({ nodes: [untitledParent], collapsed: new Set(), onToggle: () => {}, t: lineageT });
  const englishLineageT = (key) => ({
    'lineage.status.active': 'Source chat',
    'lineage.status.archived': 'Archived',
    'lineage.origin.session': 'Session',
    'lineage.untitled': 'Untitled chat',
    'lineage.sourceUnavailable': 'Source information unavailable',
    'lineage.sourceContext': 'Source',
    'lineage.contextOnly': 'Active chat, shown for relationship context only',
    'lineage.start': 'Starting chat',
    'lineage.created': 'Created',
    'lineage.noBranches': 'No branches',
    'lineage.copyId': 'Copy ID',
    'locale.intl': 'en-US',
  })[key] ?? key;
  const enUntitledSource = clientExports.__test.LineageTreeNodes?.({ nodes: [untitledParent], collapsed: new Set(), onToggle: () => {}, t: englishLineageT });
  const zhSourceLabels = collectElements(zhUntitledSource).filter((element) => element.props?.className === 'dac-lineage-source').map(elementText);
  const enSourceLabels = collectElements(enUntitledSource).filter((element) => element.props?.className === 'dac-lineage-source').map(elementText);
  assert(zhSourceLabels.some(label => label.includes('从「来源信息不可用」分出')) && enSourceLabels.some(label => label.includes('Branched from "Source information unavailable"')),
  'unavailable parent relationships use an explicit source-information fallback instead of inventing an untitled chat');

  const snapshotRowsTree = clientExports.__test.SnapshotInsightRows?.({
    snapshots: [
      { snapshotId: 'snapshot-active', sessionId: 'session-a', status: 'ready', active: true, createdAt: '2026-08-25T00:00:00.000Z', totalBytes: 52 * 1024 },
      { snapshotId: 'snapshot-history', sessionId: 'session-b', status: 'ready', active: false, createdAt: '2026-08-24T00:00:00.000Z', totalBytes: 1024 * 1024 },
    ],
    sessions: [{ id: 'session-a', title: '发布计划' }, { id: 'session-b', title: null }],
    t: (key) => ({
      'insights.snapshot.active': '活动保护快照',
      'insights.snapshot.history': '历史保护快照',
      'insights.snapshot.degraded': '降级保护快照',
      'insights.snapshot.original': '原会话',
      'insights.snapshot.created': '创建时间',
      'insights.snapshot.id': '快照 ID',
      'locale.intl': 'zh-CN',
    })[key] ?? key,
  });
  const snapshotRowsText = elementText(snapshotRowsTree);
  assert(snapshotRowsText.includes('活动保护快照') && snapshotRowsText.includes('历史保护快照')
    && snapshotRowsText.includes('原会话：发布计划') && snapshotRowsText.includes('原会话：session-b')
    && snapshotRowsText.includes('创建时间：') && snapshotRowsText.includes('快照 ID：snapshot-active'),
  'snapshot rows explain their state, original chat, creation time, and internal snapshot ID');

  assert(JSON.stringify(clientExports.__test.uniqueSessionIds?.(['b', '', 'a', 'b', null])) === '["b","a"]', 'trash ID normalization preserves unique request order');
  const trashGroups = clientExports.__test.groupTrashSessions?.(trashRows);
  assert(JSON.stringify(trashGroups?.map((group) => ({ key: group.key, ids: group.sessionIds }))) === JSON.stringify([
    { key: 'ws-1', ids: ['session-a', 'session-c'] },
    { key: '__ungrouped__', ids: ['session-b'] },
  ]), 'trash grouping keeps first workspace order and row order');
  assert(trashGroups?.[0]?.items?.[0]?.workspace?.path === undefined, 'trash client model never exposes workspace paths');
  const statusT = (key) => key;
  assert(clientExports.__test.trashStatusLabel?.(statusT, trashRows[0]) === 'trash.status.ready', 'ready trash status is localized');
  assert(clientExports.__test.trashStatusLabel?.(statusT, trashRows[1]) === 'trash.status.degraded', 'degraded trash status is localized');
  assert(clientExports.__test.trashStatusLabel?.(statusT, trashRows[2]) === 'trash.status.purgePending', 'purge-pending trash status is localized');

  assert(clientExports.__test.submitInteropFile === undefined, 'client test surface omits external import helpers');
  assert(clientExports.__test.submitInteropExportPreview === undefined && clientExports.__test.downloadInteropExport === undefined, 'client test surface omits external export helpers');
  globalThis.fetch = savedFetch;
}

console.log('\n[11] client half — settings section registration');
{
  clientExports.apply(clientCtx);
  assert(clientCalls.localeRegister.length === 1, 'locale dictionaries registered once');
  assert(clientCalls.localeRegister[0].ns === 'settings.archived-chats', 'locale namespace is settings.archived-chats');
  const zhDict = clientCalls.localeRegister[0].dicts.zh;
  assert(zhDict['nav'] === '归档管理' && zhDict['page.title'] === '归档管理', 'zh session archive label and page title are localized');
  assert(zhDict['delete.all'] === '全部移至回收站', 'zh recycle-all label present');
  assert(zhDict['confirm.deleteOne.title'] === '移至回收站？', 'move-one confirmation title is localized');
  assert(zhDict['confirm.deleteOne.body'].includes('保护快照'), 'move-one confirmation explains recoverability');
  assert(zhDict['group.collapse'] === '折叠' && zhDict['group.expand'] === '展开', 'collapse/expand labels present');
  assert(zhDict['export.all'] === '全部导出' && zhDict['export.selected'] === '导出选中', 'Chinese export actions are localized');
  assert(zhDict['trash.status.legacy'] === undefined
    && zhDict['trash.confirm.emptyBody'] === '这将永久删除回收站中所有工作区的会话和保护快照。',
  'Chinese Recycle Bin copy has no retired legacy state');
  assert(clientCalls.localeRegister[0].dicts.en['export.row'] === undefined, 'single-chat export copy is removed');
  assert(clientCalls.localeRegister[0].dicts.en['nav'] === 'Archive Management'
    && clientCalls.localeRegister[0].dicts.en['page.title'] === 'Archive Management',
  'English archive management label and page title match the documented settings entry');
  assert(clientCalls.localeRegister[0].dicts.en['trash.status.legacy'] === undefined
    && clientCalls.localeRegister[0].dicts.en['trash.confirm.emptyBody'] === 'This permanently deletes the chats and protection snapshots from every workspace in the Recycle Bin.',
  'English Recycle Bin copy has no retired legacy state');
	  assert(clientCalls.slotRegister.length === 1, `only the settings section registers (got ${clientCalls.slotRegister.length})`);
	  const settingsRegistration = clientCalls.slotRegister.find((entry) => entry.meta?.name === 'settings.section');
	  const overlayRegistration = clientCalls.slotRegister.find((entry) => entry.meta?.name === 'shell.overlay');
	  const workspaceActionRegistration = clientCalls.slotRegister.find((entry) => entry.meta?.name === 'sidebar.workspaces.workspace.action');
  const meta = settingsRegistration?.meta;
  assert(meta.name === 'settings.section', 'registration targets settings.section');
  assert(meta.id === 'archived-chats', `section id is "archived-chats" (got "${meta.id}")`);
  assert(meta.order === 30, `section order is 30 (got ${meta.order})`);
  assert(typeof meta.label === 'function', 'nav label is a locale-bound function');
  assert(meta.label() === '归档管理', `label() resolves to 归档管理 (got "${meta.label()}")`);
  assert(meta.locale === 'settings.archived-chats', 'section carries its locale namespace');
  assert(typeof settingsRegistration?.component === 'function', 'section component is a function');
	  assert(workspaceActionRegistration === undefined,
	  'the public plugin does not register an unreleased workspace-menu Host slot');
  assert(overlayRegistration === undefined, 'official archive feedback has no plugin overlay');
  await clientServices.workspaces.archiveSession('session-native');
  assert(clientCalls.workspaceArchive.at(-1) === 'session-native' && clientServices.workspaces.archiveSession === originalWorkspaceArchiveMethod,
    'official archive calls still use the original Host method');
  const style = headChildren.find((c) => c.id === 'dsh-archived-chats-css');
  assert(style !== undefined, 'page stylesheet injected into <head>');
  assert(style?.attrs['data-plugin-css'] === 'dsh-archived-chats', 'stylesheet carries the data-plugin-css marker');
  assert(style?.textContent.includes('.dac-row'), 'stylesheet paints the chat rows');
  assert(
    /\.dac-title\{[^}]*flex:none[^}]*white-space:nowrap[^}]*\}/u.test(style?.textContent ?? ''),
    'page title stays on one line when header actions wrap',
  );
  assert(
    style?.textContent.includes('.dac-intro-row{display:flex;align-items:center;justify-content:space-between;gap:6px 12px;flex-wrap:wrap}')
      && style?.textContent.includes('.dac-intro-row .dac-head-actions{flex:0 0 164px;width:164px;'),
    'description actions reserve stable space and can wrap on narrow layouts',
  );
  assert(
    style?.textContent.includes('var(--dsw-alias-state-error-primary)')
      && style?.textContent.includes('var(--dsw-alias-interactive-bg-hover-danger)')
      && style?.textContent.includes('var(--dsw-alias-state-success-primary)'),
    'destructive and success states use host semantic colors',
  );
  assert(
    !/(?:#e5484d|#d13438|#30a46c|#2f9e68|rgba\(229,72,77|rgba\(48,164,108)/i.test(style?.textContent ?? ''),
    'legacy hard-coded destructive and success colors are absent',
  );
  assert(style?.textContent.includes('.dac-tag-editor') && style?.textContent.includes('.dac-tag-editor .dac-chip span{'), 'token tag editor has layout, focus, and long-label styling');
  assert(!style?.textContent.includes('.dac-archive-notice') && !clientSource.includes('installArchiveNoticeInterceptor'),
    'retired archive overlay styles and interceptor are removed');
  assert(style?.textContent.includes('.dac-lineage-diagnostic{')
    && style?.textContent.includes('white-space:normal;overflow-wrap:anywhere'),
  'relationship diagnostics wrap completely inside managed cards');
  assert(style?.textContent.includes('@media (max-width:480px){.dac-row-select{width:100%;flex-basis:100%}')
    && style?.textContent.includes('.dac-row-actions{width:100%;justify-content:flex-end}'),
  'phone archive rows reserve a full readable line for identity before wrapping actions');
  assert(!clientSource.includes('settings.plugin.item'), 'rc.7 keyed plugin-item slot is not used by the settings section');
}

function renderTestComponent(node) {
  if (!['NotePreview', 'HelpTooltip', 'SelectionCheckbox', 'ChatActionMenu', 'GroupSection', 'ArchiveDeleteButton', 'PreviewTitleButton'].includes(node.type.name)) return node.type(node.props ?? {});
  // A nested note owns hooks independently of the enclosing page/dialog.
  const savedHooks = { ...moduleTable.react };
  try { return createHookHarness(node.type).render(node.props ?? {}); }
  finally { Object.assign(moduleTable.react, savedHooks); }
}

function collectElements(node, result = []) {
  if (node === null || node === undefined || node === false) return result;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, result);
    return result;
  }
  if (typeof node !== 'object') return result;
  if (typeof node.type === 'function') {
    result.push(node);
    return collectElements(renderTestComponent(node), result);
  }
  result.push(node);
  collectElements(node.props?.children, result);
  return result;
}

function elementText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(elementText).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  if (typeof node.type === 'function') return elementText(renderTestComponent(node));
  return elementText(node.props?.children);
}

function findComponentElement(node, componentName) {
  if (node === null || node === undefined || node === false) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findComponentElement(child, componentName);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  if (typeof node.type === 'function' && node.type.name === componentName) return node;
  return findComponentElement(node.props?.children, componentName);
}

function archiveRowDelete(tree, title) {
  const row = collectElements(tree).find(el => el.props?.className === 'dac-row'
    && collectElements(el).some(child => child.props?.className === 'dac-row-title dac-row-open' && elementText(child) === title));
  return collectElements(row).find(el => el.type === 'button' && el.props?.className === 'dac-iconbtn');
}

async function openArchivePreviewHeader(render, title) {
  findComponentElement(render(), 'PreviewDialog')?.props.onCancel();
  const trigger = collectElements(render()).find(el => el.type === 'button'
    && el.props?.className === 'dac-row-title dac-row-open' && elementText(el) === title);
  assert(trigger !== undefined, `archived title opens preview for ${title}`);
  await trigger?.props.onClick();
  const preview = findComponentElement(render(), 'PreviewDialog');
  assert(preview !== undefined, `title opens the preview dialog for ${title}`);
  const savedHooks = { ...moduleTable.react };
  try {
    return preview && collectElements(createHookHarness(preview.type).render(preview.props)).find(el => el.props?.className === 'dac-preview-head-actions');
  } finally { Object.assign(moduleTable.react, savedHooks); }
}

function createHookHarness(component) {
  const states = [];
  const refs = [];
  const effects = [];
  const memos = [];
  let pendingEffects = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  let memoIndex = 0;
  const sameDependencies = (left, right) => Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
  const hooks = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next;
      }];
    },
    useRef(initial) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useEffect(effect, deps) {
      const index = effectIndex++;
      if (!sameDependencies(effects[index]?.deps, deps)) pendingEffects.push({ index, effect, deps });
    },
    useMemo(fn, deps) {
      const index = memoIndex++;
      if (!sameDependencies(memos[index]?.deps, deps)) memos[index] = { deps, value: fn() };
      return memos[index].value;
    },
    useCallback(fn, deps) {
      const index = memoIndex++;
      if (!sameDependencies(memos[index]?.deps, deps)) memos[index] = { deps, value: fn };
      return memos[index].value;
    },
  };
  return {
    render(props) {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      memoIndex = 0;
      pendingEffects = [];
      Object.assign(moduleTable.react, hooks);
      return component(props);
    },
    flushEffects() {
      for (const pending of pendingEffects) {
        effects[pending.index]?.cleanup?.();
        effects[pending.index] = { deps: pending.deps, cleanup: pending.effect() };
      }
      pendingEffects = [];
    },
    unmount() {
      for (const effect of effects) effect?.cleanup?.();
    },
  };
}

console.log('\n[11a-feedback] pausable success feedback and contextual help');
{
  const savedHooks = { ...moduleTable.react };
  const savedTimeout = globalThis.setTimeout;
  const savedClear = globalThis.clearTimeout;
  const savedNow = Date.now;
  const timers = new Map();
  let clock = 0, timerId = 0, dismissed = 0;
  globalThis.setTimeout = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  Date.now = () => clock;
  try {
    const useTimer = clientExports.__test.useSuccessNoticeTimer;
    assert(typeof useTimer === 'function', 'success notices share a pausable four-second timer');
    if (useTimer) {
      const harness = createHookHarness(({ notice }) => useTimer(notice, notice?.kind === 'ok', () => { dismissed++; }));
      let notice = { kind: 'ok', action: 'view-archived' };
      const render = () => { const handlers = harness.render({ notice }); harness.flushEffects(); return handlers; };
      let handlers = render();
      assert([...timers.values()][0]?.delay === 4000, 'view-archived success gets a four-second timeout');
      const stale = [...timers.values()][0]?.fn;
      clock = 1000;
      handlers.onMouseEnter(); handlers = render();
      assert(timers.size === 0, 'hover pauses successful feedback');
      handlers.onFocus(); handlers = render();
      handlers.onMouseLeave(); handlers = render();
      assert(timers.size === 0, 'focus keeps feedback paused after pointer leaves');
      handlers.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); handlers = render();
      assert([...timers.values()][0]?.delay === 3000, 'leaving hover and focus resumes remaining time');
      const beforeReplacement = [...timers.values()][0]?.fn;
      notice = { kind: 'ok', action: 'undo-trash' };
      handlers = harness.render({ notice });
      beforeReplacement?.();
      assert(dismissed === 0, 'old timeout cannot dismiss a replacement before passive cleanup runs');
      harness.flushEffects();
      stale?.();
      assert(dismissed === 0 && [...timers.values()][0]?.delay === 4000, 'replacement notice gets a fresh timer and ignores stale expiry');
      [...timers.values()][0]?.fn();
      assert(dismissed === 1, 'successful feedback auto-dismisses');
      notice = { kind: 'error' }; render();
      assert(timers.size === 0, 'error feedback never auto-dismisses');
      notice = { kind: 'ok' }; render();
      const unmounted = [...timers.values()][0]?.fn;
      harness.unmount(); unmounted?.();
      assert(timers.size === 0 && dismissed === 1, 'unmount cancels pending and stale expiry');
    }
  } finally {
    globalThis.setTimeout = savedTimeout; globalThis.clearTimeout = savedClear; Date.now = savedNow;
    Object.assign(moduleTable.react, savedHooks);
  }
  const HelpTooltip = clientExports.__test.HelpTooltip;
  assert(typeof HelpTooltip === 'function', 'context explanations use an accessible help control');
  if (HelpTooltip) {
    const savedAddListener = windowMock.addEventListener;
    const savedRemoveListener = windowMock.removeEventListener;
    const helpWindowListeners = new Map();
    windowMock.addEventListener = (name, fn) => helpWindowListeners.set(name, fn);
    windowMock.removeEventListener = name => helpWindowListeners.delete(name);
    const harness = createHookHarness(HelpTooltip);
    const props = { id: 'test-help', label: 'Retention help', children: 'Permanent deletion warning' };
    const render = () => { const tree = harness.render(props); harness.flushEffects(); return tree; };
    const tip = tree => collectElements(tree).find(el => el.props?.role === 'tooltip');
    const button = tree => collectElements(tree).find(el => el.type === 'button');
    let tree = render();
    tree.props.ref.current = { getBoundingClientRect: () => ({ left: 990, top: 30, bottom: 50 }), contains: target => target === 'inside' };
    assert(!tip(tree) && button(tree)?.props['aria-label'] === props.label, 'help starts hidden with a labelled keyboard control');
    tree.props.onMouseEnter(); tree = render();
    assert(elementText(tip(tree)) === props.children && button(tree).props['aria-describedby'] === tip(tree)?.props.id, 'hover opens linked explanation');
    assert(tip(tree)?.props.style.left + tip(tree)?.props.style.width <= (windowMock.innerWidth || 1024) - 12, 'help stays within horizontal viewport');
    let hoverEscapeStopped = false;
    documentListeners.get('keydown')?.({ key: 'Escape', preventDefault() {}, stopPropagation() { hoverEscapeStopped = true; }, stopImmediatePropagation() {} });
    tree = render();
    assert(!tip(tree) && hoverEscapeStopped, 'Escape from outside the help control dismisses pointer-only tooltip without reaching host');
    tree.props.onMouseEnter(); tree = render();
    tree.props.onFocus(); tree = render();
    tree.props.onMouseLeave(); tree = render();
    assert(!!tip(tree), 'focused help persists when pointer leaves');
    tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); tree = render();
    assert(!tip(tree), 'Escape dismisses help without closing the surrounding dialog');
    tree.props.onFocus(); tree = render();
    button(tree).props.onClick(); tree = render();
    assert(!!tip(tree), 'touch focus followed by click keeps help open');
    documentListeners.get('pointerdown')?.({ target: 'outside' }); tree = render();
    assert(!tip(tree), 'outside pointer dismisses help');
    button(tree).props.onClick(); tree = render();
    button(tree).props.onClick(); tree = render();
    assert(!tip(tree), 'repeated touch toggles help closed');
    harness.unmount(); Object.assign(moduleTable.react, savedHooks);
    assert(helpWindowListeners.size === 0, 'help removes viewport listeners on unmount');
    windowMock.addEventListener = savedAddListener;
    windowMock.removeEventListener = savedRemoveListener;
  }
  for (const updateStatus of ['available', 'current', 'unchecked', 'unavailable', undefined]) {
    const tree = clientExports.__test.ArchiveTabs({ pageMode: 'about', onChange() {}, t: key => key, updateStatus });
    const dots = collectElements(tree).filter(el => el.props?.className === 'dac-update-dot');
    assert(dots.length === (updateStatus === 'available' ? 1 : 0), `About update indicator matches ${updateStatus}`);
    if (dots.length) assert(dots[0].props['aria-hidden'] === true, 'decorative update dot does not duplicate the tab accessible label');
  }
}

console.log('\n[11a] client half — responsive host marker follows the loaded page lifecycle');
{
  const savedHooks = { ...moduleTable.react };
  const NotePreview = clientExports.__test.NotePreview;
  assert(typeof NotePreview === 'function', 'archive notes expose a full-text hover preview');
  if (typeof NotePreview === 'function') {
    const note = 'First line\n' + 'Long note <script>plain text</script> '.repeat(30);
    const props = { note, sessionId: 'note-test', t: (key) => key };
    const harness = createHookHarness(NotePreview);
    let tree = harness.render(props);
    assert(!collectElements(tree).some((el) => el.props?.role === 'tooltip'), 'note preview starts collapsed');
    const summaryBounds = { scrollWidth: 1000, clientWidth: 200 };
    tree.props.ref.current = { querySelector: () => summaryBounds, getBoundingClientRect: () => ({ left: 20, top: 30, bottom: 50 }), contains: () => false };
    tree.props.onMouseEnter();
    tree = harness.render(props);
    assert(collectElements(tree).find((el) => el.props?.role === 'tooltip')?.props.children === note, 'hover exposes complete multiline note as plain text');
    let restoredFocus = false;
    const originalActive = documentMock.activeElement;
    documentMock.activeElement = {};
    tree.props.ref.current.contains = (target) => target === documentMock.activeElement;
    tree.props.ref.current.focus = () => { restoredFocus = true; documentMock.activeElement = tree.props.ref.current; };
    let prevented = false;
    tree.props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
    tree = harness.render(props);
    assert(prevented && !collectElements(tree).some((el) => el.props?.role === 'tooltip'), 'Escape dismisses the note popup');
    assert(restoredFocus, 'Escape returns focus from the popup to its note');
    documentMock.activeElement = originalActive;
    tree.props.onFocus();
    tree = harness.render(props);
    assert(collectElements(tree).some((el) => el.props?.role === 'tooltip'), 'keyboard focus also exposes complete note');
    tree.props.onMouseEnter(); tree.props.onMouseLeave(); tree = harness.render(props);
    assert(collectElements(tree).some((el) => el.props?.role === 'tooltip'), 'pointer exit preserves a keyboard-focused note popup');
    assert(collectElements(tree).find((el) => el.props?.role === 'tooltip')?.props.tabIndex === 0, 'long note popup is keyboard scrollable');
    tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
    tree = harness.render(props);
    assert(!collectElements(tree).some((el) => el.props?.role === 'tooltip'), 'leaving focus closes the note popup');
    summaryBounds.scrollWidth = summaryBounds.clientWidth;
    tree.props.onMouseEnter();
    tree = harness.render(props);
    assert(!collectElements(tree).some((el) => el.props?.role === 'tooltip'), 'fully visible notes do not open a hover popup');
    tree.props.onFocus();
    tree = harness.render(props);
    assert(!collectElements(tree).some((el) => el.props?.role === 'tooltip'), 'fully visible notes do not open a focus popup');
    summaryBounds.clientWidth = 100;
    tree.props.onMouseEnter();
    tree = harness.render(props);
    assert(collectElements(tree).some((el) => el.props?.role === 'tooltip'), 'overflow is remeasured when available width changes');
    harness.unmount();
  }
  Object.assign(moduleTable.react, savedHooks);
}

{
	  const savedHooks = { ...moduleTable.react };
	  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => String(url).endsWith('/state')
      ? { metadataStatus: 'ready', sessions: [] }
      : { summary: { sessionCount: 0, totalBytes: 0, unavailableCount: 0 }, sessions: {} },
  });
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const loadedTree = harness.render({ t, refreshSidebar: () => {} });
  const attrs = new Map();
  const hostDialog = {
    setAttribute: (name, value) => attrs.set(name, String(value)),
    getAttribute: (name) => attrs.get(name) ?? null,
    removeAttribute: (name) => attrs.delete(name),
  };
  loadedTree.props.ref.current = { closest: () => hostDialog };
  harness.flushEffects();
  assert(attrs.get('data-dac-section-active') === '1', 'host dialog is marked after the loading state mounts the archive page');
  harness.unmount();
  assert(!attrs.has('data-dac-section-active'), 'loaded archive page removes its host marker on unmount');

  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11a2] client half — modal focus, busy locks, tab navigation, and structured errors');
{
  const savedHooks = { ...moduleTable.react };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const ImportDialog = clientExports.__test.ImportDialog;
  const ArchiveTabs = clientExports.__test.ArchiveTabs;
  assert(typeof ImportDialog === 'function' && typeof ArchiveTabs === 'function', 'client exposes real modal and tab components to behavioral tests');

  if (typeof ImportDialog === 'function') {
    const priorDocumentKeydown = documentListeners.get('keydown');
    documentListeners.delete('keydown');
    const harness = createHookHarness(ImportDialog);
    let cancellations = 0;
    let restored = 0;
    const attachRef = (ref, node) => {
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    };
    const returnControl = { focus: () => { restored += 1; documentMock.activeElement = returnControl; } };
    const first = { focus: () => { documentMock.activeElement = first; } };
    const last = { focus: () => { documentMock.activeElement = last; } };
    const props = {
      preview: { token: 'focus-token', nonce: 'focus-nonce', sessions: [{ id: 'focus-id', title: 'Focus', conflict: false }], selectedIds: ['focus-id'], result: null },
      t,
      busy: false,
      returnFocus: returnControl,
      fallbackFocusRef: { current: null },
      onToggle() {}, onSelectAll() {}, onClear() {}, onConfirm() {},
      onCancel: () => { cancellations += 1; },
    };
    let tree = harness.render(props);
    let elements = collectElements(tree);
    const dialog = elements.find((element) => element.props?.['aria-labelledby'] === 'dac-import-title');
    const cancel = elements.find((element) => element.type === 'button' && elementText(element) === '取消');
    const dialogNode = {
      contains: (node) => node === first || node === last,
      querySelectorAll: () => [first, last],
      focus: () => { documentMock.activeElement = dialogNode; },
    };
    attachRef(dialog.props.ref, dialogNode);
    attachRef(cancel.props.ref, first);
    documentMock.activeElement = returnControl;
    harness.flushEffects();
    assert(documentMock.activeElement === first, 'import dialog moves initial focus inside the modal');
    documentMock.activeElement = last;
    let forwardPrevented = false;
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault: () => { forwardPrevented = true; }, stopPropagation() {} });
    documentMock.activeElement = first;
    let reversePrevented = false;
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault: () => { reversePrevented = true; }, stopPropagation() {} });
    assert(forwardPrevented && reversePrevented && documentMock.activeElement === last, 'import dialog wraps forward and reverse Tab focus');

    tree = harness.render({ ...props, busy: true });
    elements = collectElements(tree);
    const busyDialog = elements.find((element) => element.props?.['aria-labelledby'] === 'dac-import-title');
    const busyCancel = elements.find((element) => element.type === 'button' && elementText(element) === '取消');
    const busyDialogNode = {
      contains: (node) => node === busyDialogNode,
      querySelectorAll: () => [],
      focus: () => { documentMock.activeElement = busyDialogNode; },
    };
    documentMock.activeElement = documentMock.body;
    attachRef(busyDialog.props.ref, busyDialogNode);
    harness.flushEffects();
    assert(documentMock.activeElement === busyDialogNode,
      'busy import synchronously moves native focus from its newly disabled control to the stable dialog');
    documentMock.activeElement = documentMock.body;
    let lostFocusTabPrevented = false;
    const importDocumentKeydown = documentListeners.get('keydown');
    importDocumentKeydown?.({
      key: 'Tab', shiftKey: false,
      preventDefault: () => { lostFocusTabPrevented = true; },
      stopPropagation() {}, stopImmediatePropagation() {},
    });
    assert(typeof importDocumentKeydown === 'function' && lostFocusTabPrevented && documentMock.activeElement === busyDialogNode,
      'busy import traps document-level Tab after native disabled-control focus loss');
    let lostFocusEscapePrevented = false;
    let lostFocusEscapeStopped = false;
    importDocumentKeydown?.({
      key: 'Escape',
      preventDefault: () => { lostFocusEscapePrevented = true; },
      stopPropagation() {},
      stopImmediatePropagation: () => { lostFocusEscapeStopped = true; },
    });
    tree.props.onClick();
    busyDialog.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    busyCancel.props.onClick();
    assert(cancellations === 0 && busyCancel.props.disabled === true && lostFocusEscapePrevented && lostFocusEscapeStopped,
      'busy import contains document-level Escape and cannot imply cancellation from its backdrop, Escape, or Cancel');

    documentMock.activeElement = documentMock.body;
    tree = harness.render({
      ...props,
      busy: false,
      preview: { ...props.preview, result: { restored: ['focus-id'], skipped: [], warnings: [] } },
    });
    elements = collectElements(tree);
    const completedDialog = elements.find((element) => element.props?.['aria-labelledby'] === 'dac-import-title');
    const completedClose = elements.find((element) => element.type === 'button' && elementText(element) === '关闭');
    const completedCloseNode = { focus: () => { documentMock.activeElement = completedCloseNode; } };
    attachRef(completedDialog.props.ref, dialogNode);
    attachRef(completedClose.props.ref, completedCloseNode);
    harness.flushEffects();
    assert(documentMock.activeElement === completedCloseNode,
      'completed import synchronously focuses Close when the focused Restore control is removed');
    harness.unmount();
    assert(restored === 1 && documentMock.activeElement === returnControl, 'import dialog restores focus to its trigger on close');
    if (priorDocumentKeydown) documentListeners.set('keydown', priorDocumentKeydown);
    else documentListeners.delete('keydown');
  }

  if (typeof ArchiveTabs === 'function') {
    const changes = [];
    const tabsTree = ArchiveTabs({ pageMode: 'archived', onChange: (mode) => changes.push(mode), t });
    assert(elementText(tabsTree).includes('未归档') && !elementText(tabsTree).includes('孤儿会话'), 'primary navigation exposes Unarchived rather than an internal orphan category');
    const buttons = collectElements(tabsTree).filter((element) => element.props?.role === 'tab');
    const controls = buttons.map(() => ({ focus() { controls.focused = this; } }));
    for (const control of controls) control.parentElement = { querySelectorAll: () => controls };
    buttons[0].props.onKeyDown({ key: 'ArrowRight', currentTarget: controls[0], preventDefault() {} });
    buttons[3].props.onKeyDown({ key: 'Home', currentTarget: controls[3], preventDefault() {} });
    buttons[0].props.onKeyDown({ key: 'End', currentTarget: controls[0], preventDefault() {} });
    assert(buttons.map((button) => button.props.tabIndex).join(',') === '0,-1,-1,-1'
      && changes.join(',') === 'unarchived,archived,about'
      && controls.focused === controls[3],
    'tab strip has one tab stop and Arrow/Home/End both move focus and selection');
  }

  for (const [body, expectedKey] of [
    [{ error: 'session-main-list-unreachable', reason: 'cwd-missing' }, 'unarchive.cwdMissing'],
    [{ error: 'session-reachability-unavailable', reason: 'session-header-unavailable' }, 'unarchive.authorityUnavailable'],
    [{ error: 'session-deletion-pending' }, 'unarchive.deletionPending'],
    [{ error: 'pending-store-unavailable' }, 'unarchive.pendingUnavailable'],
  ]) {
    assert(clientExports.__test.unarchiveFailureText?.((key) => key, { body, message: 'raw Host message' }) === expectedKey,
      `${body.error} uses its stable structured localization branch`);
  }
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11b] client half — simplified archive actions');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const archivedRows = [
    { id: 'session-a', title: 'Alpha', createdAt: 10, origin: null, workspaceId: 'ws-1', workspaceTitle: '项目一' },
    { id: 'session-b', title: 'Beta', createdAt: 20, origin: 'subagent', workspaceId: 'ws-1', workspaceTitle: '项目一' },
    { id: 'session-c', title: 'Gamma', createdAt: 30, origin: null, workspaceId: 'ws-2', workspaceTitle: '项目二' },
  ];
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (options.method === 'POST') requests.push({ path, body: JSON.parse(options.body) });
    const payload = path.endsWith('/state')
      ? { metadataStatus: 'ready', trashStatus: 'ready', sessions: archivedRows }
      : path.endsWith('/stats')
        ? { summary: { sessionCount: 3, totalBytes: 0, unavailableCount: 0 }, sessions: {} }
        : path.endsWith('/delete-all')
          ? { deleted: archivedRows.map((row) => row.id), pending: [], failed: [] }
          : {};
    return { ok: true, status: 200, json: async () => payload };
  };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const render = () => harness.render({ t, refreshSidebar: () => {} });
  render(); harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let tree = render();
  let elements = collectElements(tree);

  assert(!elements.some((element) => element.type === 'button' && elementText(element) === '批量选择')
    && !elements.some((element) => element.props?.className === 'dac-bulkbar')
    && !elements.some((element) => element.type === 'input' && String(element.props?.['aria-label'] ?? '').startsWith('选择 ')),
  'archive list removes batch selection controls and row checkboxes');
  const head = elements.find((element) => element.props?.className === 'dac-intro-row');
  const deleteAll = collectElements(head).find((element) => element.type === 'button' && elementText(element) === '全部删除');
  assert(deleteAll !== undefined, 'archive header More retains explicitly named permanent deletion');
  assert(elements.filter((element) => element.type === 'button' && elementText(element) === '取消归档').length === 3,
    'individual unarchive actions remain available');
  assert(elements.filter((element) => element.type === 'button' && element.props?.['aria-label'] === '删除已归档的聊天').length === 3,
    'individual permanent delete icons are directly available');
  assert(elements.filter((element) => element.type === 'button' && element.props?.['aria-label'] === '…').length === 2,
    'each workspace keeps its More menu');

  deleteAll?.props.onClick();
  tree = render();
  let dialog = findComponentElement(tree, 'ConfirmDialog');
  assert(dialog?.props.title === '删除所有已归档本地聊天？', 'global archive deletion has a specific confirmation title');
  assert(String(dialog?.props.body).includes('2 个工作区') && String(dialog?.props.body).includes('3 个已归档聊天') && String(dialog?.props.body).includes('回收站不受影响'),
    'global archive deletion explains its complete scope and Recycle Bin boundary');
  dialog?.props.onCancel();
  assert(requests.length === 0, 'cancelling global archive deletion sends no mutation');
  collectElements(render()).find((element) => element.type === 'button' && elementText(element) === '全部删除')?.props.onClick();
  dialog = findComponentElement(render(), 'ConfirmDialog');
  await dialog?.props.onConfirm();
  assert(requests[0]?.path.endsWith('/delete-all') && requests[0]?.body.permanent === true
    && requests[0]?.body.sessionIds.join(',') === 'session-a,session-b,session-c',
  'global archive deletion permanently targets every archived chat in list order');

  harness.unmount();
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}
console.log('\n[11b-global-recycle] global actions retain the complete archive scope');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const rows = [
    { id: 'global-a', title: 'Alpha', workspaceId: 'ws-1', workspaceTitle: 'One', createdAt: 10 },
    { id: 'global-b', title: 'Beta', workspaceId: 'ws-1', workspaceTitle: 'One', createdAt: 20 },
    { id: 'global-c', title: 'Gamma', workspaceId: 'ws-2', workspaceTitle: 'Two', createdAt: 30 },
  ];
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/delete-all') && options.method === 'POST') {
      const body = JSON.parse(options.body); requests.push(body);
      return new Response(JSON.stringify({ trashed: body.sessionIds, failed: [] }));
    }
    const payload = path.endsWith('/state') ? { metadataStatus: 'ready', trashStatus: 'ready', sessions: rows } : {};
    return new Response(JSON.stringify(payload));
  };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const render = () => harness.render({ t, refreshSidebar() {} });
  const elements = () => collectElements(render());
  const headAction = label => collectElements(elements().find(el => el.props?.className === 'dac-head-actions'))
    .find(el => el.type === 'button' && elementText(el) === label);
  render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  elements().find(el => el.type === 'select' && el.props['aria-label'] === t('filter.allProjects'))
    ?.props.onChange({ target: { value: 'ws-2' } });
  assert(headAction('全部移入回收站') === undefined, 'header More retires new recycle operations');
  for (const label of ['全部取消归档', '全部删除']) {
    const action = headAction(label);
    if (!action) continue;
    action.props.onClick();
    const dialog = findComponentElement(render(), 'ConfirmDialog');
    assert(String(dialog?.props.body).includes(label === '全部取消归档' ? '所有工作区中的已归档会话' : '全部 2 个工作区中的 3 个已归档聊天'),
      `${label} confirms every workspace and chat despite the filter`);
    if (label === '全部移入回收站') assert(dialog?.props.title === '将全部已归档聊天移入回收站？',
      'global recycling confirmation has a global title');
    dialog?.props.onCancel();
  }
  assert(requests.length === 0, 'cancelled global confirmations do not mutate chats');
  harness.unmount(); globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}
console.log('\n[11c] client half — archive insights UI');
{
  const savedHooks = { ...moduleTable.react };
  const archivedRows = [
    {
      id: 'session-a', title: 'Alpha', createdAt: 10, updatedAt: 40, origin: null,
      workspaceId: 'ws-1', workspaceTitle: '项目一',
      tags: ['important'], note: 'keep this', metadataUpdatedAt: '2026-08-18T12:00:00.000Z',
    },
    {
      id: 'session-b', title: 'Beta', createdAt: 20, origin: 'subagent',
      workspaceId: 'ws-1', workspaceTitle: '项目一',
      tags: ['research,2026', 'all', 'Important'], note: '', metadataUpdatedAt: '2026-08-18T12:00:00.000Z',
    },
    {
      id: 'session-c', title: 'Gamma', createdAt: 30, origin: null,
      workspaceId: 'ws-2', workspaceTitle: '项目二',
      tags: ['a', 'b', 'c', 'd'], note: '', metadataUpdatedAt: null,
    },
  ];
  const statsFixture = {
    status: 'ready',
    summary: { sessionCount: 3, totalBytes: 1536, unavailableCount: 1 },
    sessions: {
      'session-a': { sizeBytes: 1024, fileCount: 3, status: 'ready' },
      'session-b': { sizeBytes: 512, fileCount: 2, status: 'ready' },
      'session-c': { sizeBytes: null, fileCount: null, status: 'unavailable' },
    },
  };
  const states = [];
  const effectRecords = [];
	// Positional pins into ArchivedChatsSection's useState order: sessions,
	// tagFilter, metadataStatus, archiveTrashStatus, stats, metadataEdit, metaBusy.
	// Adding a useState to that component shifts every pin after it, so re-derive
	// these indices from the component whenever the list changes.
	states[0] = { value: archivedRows, setter: null };
	states[21] = { value: '', setter: null };
	states[22] = { value: 'ready', setter: null };
	states[23] = { value: 'ready', setter: null };
	states[24] = { value: statsFixture, setter: null };
	states[25] = { value: null, setter: null };
	states[26] = { value: false, setter: null };
  const setterAt = (index) => (next) => {
    states[index].value = typeof next === 'function' ? next(states[index].value) : next;
  };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const renderSection = () => {
    let index = -1;
    moduleTable.react.useState = (initial) => {
      index += 1;
      if (states[index] === undefined) {
        const value = typeof initial === 'function' ? initial() : initial;
        states[index] = { value, setter: setterAt(index) };
      } else if (states[index].setter === null) {
        states[index].setter = setterAt(index);
      }
      return [states[index].value, states[index].setter];
    };
    moduleTable.react.useEffect = (effect, deps) => { effectRecords.push({ effect, deps }); };
    moduleTable.react.useMemo = (fn) => fn();
    moduleTable.react.useCallback = (fn) => fn;
    moduleTable.react.useRef = (value) => ({ current: value });
    return clientCalls.slotRegister[0].component({ t, refreshSidebar: () => {} });
  };
  const isRow = (el) => el.props?.className === 'dac-row' || el.props?.className === 'dac-row dac-selected';
  const editButtonsIn = (root) => collectElements(root).filter((el) => el.type === 'button' && el.props?.['aria-label'] === '编辑标签与备注');

  let tree = renderSection();
  let elements = collectElements(tree);
  const archiveGroups = elements.filter(el => el.type?.name === 'GroupSection').map(el => el.props.group);
  assert(archiveGroups.map(group => group.key).join(',') === 'ws-1,ws-2'
    && archiveGroups[0]?.items.map(row => row.id).join(',') === 'session-a,session-b',
    'archive orders both workspaces and their chats by recent activity rather than creation');
  const importTrigger = elements.find((el) => el.type === 'button' && elementText(el) === '导入备份');
  const exportTrigger = elements.find((el) => el.type === 'button' && elementText(el) === '全部导出');
  const moreTrigger = elements.find((el) => el.type === 'summary' && el.props?.['aria-label'] === '更多归档操作');
  assert(importTrigger !== undefined && exportTrigger !== undefined && moreTrigger !== undefined, 'backup actions are inside the header More disclosure');
  assert(elementText(moreTrigger) === '' && collectElements(moreTrigger).some(el => el.type === 'svg'), 'header More is an accessible icon-only disclosure');
  assert(
    !elements.some((el) => /Codex|Claude|JSONL/.test(elementText(el)))
      && !elements.some((el) => el.type === 'input' && String(el.props?.accept).includes('.jsonl')),
    'archive manager exposes no cross-tool JSONL controls',
  );

  const initialImportInput = elements.find((el) => el.type === 'input' && el.props?.accept === '.zip,application/zip');
  let importPickerClicks = 0;
  if (initialImportInput?.props.ref) initialImportInput.props.ref.current = { click: () => { importPickerClicks += 1; } };
  importTrigger?.props.onClick();
  assert(importPickerClicks === 1, 'direct import action opens the DSH ZIP picker');

	  const savedUiExportFetch = globalThis.fetch;
	  const savedUiExportUrl = windowMock.URL;
	  let uiExportRequest;
	  windowMock.URL = { createObjectURL: () => 'blob:ui-export', revokeObjectURL() {} };
	  globalThis.fetch = async (url, options) => {
	    uiExportRequest = { url: String(url), options };
	    return new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: {
	      'content-type': 'application/zip',
	      'content-disposition': 'attachment; filename="all-archives.zip"',
	    } });
	  };
	  exportTrigger?.props.onClick();
  const exportAllDialog = findComponentElement(renderSection(), 'ConfirmDialog');
  assert(exportAllDialog?.props.body.includes('2') && exportAllDialog.props.body.includes('3'), 'global export confirmation includes workspace and chat totals');
  await exportAllDialog?.props.onConfirm();
	  assert(new URLSearchParams(uiExportRequest?.options.body).get('sessionIds') === '["session-a","session-b","session-c"]', 'direct backup export submits archive-list order');
  tree = renderSection();
  elements = collectElements(tree);
	  assert(elements.some((el) => el.props?.className === 'dac-toast' && elementText(el).includes('已开始下载备份')), 'export action announces that the download started');
	  globalThis.fetch = savedUiExportFetch;
	  windowMock.URL = savedUiExportUrl;
	states[19].value = null;
  tree = renderSection();
  elements = collectElements(tree);

  const moreMenu = elements.find((el) => el.props?.className === 'dac-action-menu');
  assert(moreMenu === undefined, 'archive header has no duplicate more menu');

  const summary = elements.find((el) => el.props?.className === 'dac-summary dac-filter-summary');
  assert(summary === undefined, 'archive filters omit the redundant global count and size');
  assert(elements.filter((el) => el.type === 'summary' && ['所有工作区', '全部标签'].includes(el.props?.['aria-label'])).length === 2 && elements.some((el) => el.type === 'summary' && el.props?.['aria-label'] === '全部聊天'), 'filters consist of combined type/sort, workspace and tag entries');
  const filtersWithSummary = elements.find((el) => el.props?.className === 'dac-filters');
  assert(filtersWithSummary?.props.children.filter(Boolean).length === 3, 'archive has exactly three filter entries');
  const archiveQueryBar = elements.find((el) => el.props?.className === 'dac-querybar-stacked');
  assert(archiveQueryBar?.props.children[0]?.props.className === 'dac-search'
    && archiveQueryBar?.props.children[1] === filtersWithSummary, 'archive search stays above filters in a two-row toolbar');

  const importInput = elements.find((el) => el.type === 'input' && el.props?.type === 'file' && el.props?.accept === '.zip,application/zip');
  assert(importInput?.props.accept === '.zip,application/zip' && importInput?.props.hidden === true, 'import file picker is hidden and accepts ZIP backups');

	states[27].value = {
    token: 'token-ui',
    nonce: 'nonce-ui',
    package: { generator: { name: 'dsh-archived-chats', version: '0.8.0' }, version: 1, sessionCount: 2 },
    sessions: [
      { id: 'new-session', title: 'New chat', workspace: { id: 'ws-1', title: '项目一' }, conflict: false, warnings: ['workspace-unresolved'] },
      { id: 'old-session', title: 'Existing chat', workspace: null, conflict: true, warnings: [] },
    ],
    selectedIds: ['new-session'],
    result: null,
  };
	states[28].value = false;
  tree = renderSection();
  elements = collectElements(tree);
  const importDialog = elements.find((el) => el.props?.role === 'dialog' && el.props?.['aria-labelledby'] === 'dac-import-title');
  assert(importDialog !== undefined, 'import preview opens an accessible dialog');
  assert(elementText(importDialog).includes('dsh-archived-chats v0.8.0 · format v1'), 'import preview renders generator and format versions');
  assert(elementText(importDialog).includes('项目不存在，将保持未分组'), 'import preview renders workspace warnings');
  const importCheckboxes = collectElements(importDialog).filter((el) => el.type === 'input' && el.props?.type === 'checkbox');
  assert(importCheckboxes.some((checkbox) => checkbox.props.disabled === true && checkbox.props.checked === false), 'conflicting import rows are disabled and unselected');
  const restoreRequests = [];
  const savedImportFetch = globalThis.fetch;
  let finishRestore;
  globalThis.fetch = async (url, options) => {
    restoreRequests.push({ url, options });
    return String(url).endsWith('/import/restore')
      ? new Promise((resolve) => { finishRestore = () => resolve({ ok: true, status: 200, json: async () => ({
        ok: true,
        restored: ['new-session'],
        skipped: [],
        warnings: [{ id: 'new-session', reason: 'title-publication-degraded', detail: 'seeded-cold-list-unsupported' }],
      }) }); })
      : { ok: true, status: 200, json: async () => ({ metadataStatus: 'ready', sessions: archivedRows }) };
  };
  const restoreButton = collectElements(importDialog).find((el) => el.type === 'button' && elementText(el) === '恢复选中项');
  const restorePending = restoreButton?.props.onClick();
  tree = renderSection();
  const busyImportOverlay = collectElements(tree).find((el) => el.props?.className === 'dac-confirm-overlay');
  const busyImportDialog = collectElements(tree).find((el) => el.props?.['aria-labelledby'] === 'dac-import-title');
  const busyImportCancel = collectElements(busyImportDialog).find((el) => el.type === 'button' && elementText(el) === '取消');
  busyImportOverlay?.props.onClick();
  busyImportDialog?.props.onKeyDown?.({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  busyImportCancel?.props.onClick();
  assert(states[27].value !== null && busyImportCancel?.props.disabled === true,
    'pending import remains visible and cannot be dismissed by Cancel, Escape, or the backdrop');
  finishRestore?.();
  await restorePending;
  assert(restoreRequests[0]?.url === '/plugins/dsh-archived-chats/import/restore', 'import confirmation targets the restore route');
  assert(restoreRequests[0]?.options.headers['x-dsh-archived-chats'] === '1', 'import confirmation sends the guard header');
  assert(JSON.parse(restoreRequests[0]?.options.body ?? '{}').sessionIds.join(',') === 'new-session', 'import confirmation sends only selected non-conflicting IDs');
  tree = renderSection();
  const completedImport = collectElements(tree).find((el) => el.props?.['aria-labelledby'] === 'dac-import-title');
	  assert(elementText(completedImport).includes('备份恢复完成')
    && elementText(completedImport).includes('冷启动')
    && collectElements(completedImport).some((el) => el.type === 'button' && elementText(el) === '关闭'),
	  'completed import keeps its localized title-publication limitation associated with a Close action');
	  collectElements(completedImport).find((el) => el.type === 'button' && elementText(el) === '关闭')?.props.onClick();
	  states[27].value = {
	    token: 'failed-token', nonce: 'failed-nonce', package: { version: 1, sessionCount: 1 },
	    sessions: [{ id: 'failed-session', title: 'Failed restore', conflict: false, warnings: [] }],
	    selectedIds: ['failed-session'], result: null, error: null,
	  };
	  let finishFailedRestore;
	  globalThis.fetch = async (url, options) => String(url).endsWith('/import/restore')
	    ? new Promise((resolve) => { finishFailedRestore = () => resolve({ ok: false, status: 503, json: async () => ({ error: 'restore-unsupported' }) }); })
	    : { ok: true, status: 200, json: async () => ({ metadataStatus: 'ready', sessions: archivedRows }) };
	  tree = renderSection();
	  const failedRestorePending = collectElements(tree).find((el) => el.type === 'button' && elementText(el) === '恢复选中项')?.props.onClick();
	  finishFailedRestore?.();
	  await failedRestorePending;
	  tree = renderSection();
	  const failedImport = collectElements(tree).find((el) => el.props?.['aria-labelledby'] === 'dac-import-title');
	  assert(collectElements(failedImport).some((el) => el.props?.role === 'alert' && elementText(el).includes('无损恢复'))
	    && collectElements(failedImport).some((el) => el.type === 'button' && elementText(el) === '恢复选中项'),
	  'failed import remains associated with the open dialog and can be retried');
  for (const [code, key] of [
    ['restore-unsupported', 'import.unsupported'],
    ['restore-rollback-failed', 'import.rollbackFailed'],
    ['id-conflict', 'import.conflictChanged'],
    ['import-token-invalid', 'import.expired'],
  ]) {
    assert(clientExports.__test.importFailureText?.(value => value, { body: { error: code }, message: 'raw Host error' }) === key,
      `import errors map ${code} to actionable localized copy`);
  }
  globalThis.fetch = savedImportFetch;
	states[27].value = null;
	states[24].value = statsFixture;
  tree = renderSection();
  elements = collectElements(tree);

  const tagSelect = elements.find((el) => el.type?.name === 'FilterSelect' && el.props?.ariaLabel === '全部标签');
  assert(tagSelect !== undefined, 'tag filter select rendered');
  assert(tagSelect?.props.value === '', 'tag filter defaults to the non-colliding no-filter sentinel');
  const importantOptions = tagSelect?.props.options.filter((option) => option.label.toLowerCase() === 'important') ?? [];
  assert(importantOptions.length === 1, 'tag filter options de-duplicate labels case-insensitively');
	states[21].value = 'all';
  tree = renderSection();
  elements = collectElements(tree);
  const filteredRows = elements.filter(isRow);
  assert(filteredRows.length === 1 && elementText(filteredRows[0]).includes('Beta'), 'selecting the literal all tag renders only sessions carrying that tag');
	states[21].value = '';
  tree = renderSection();
  elements = collectElements(tree);

  const chips = elements.filter((el) => el.props?.className === 'dac-chip');
  assert(elements.filter(isRow).every((row) => collectElements(row).filter((el) => el.props?.className === 'dac-chip').length <= 3), 'rows render at most three tag chips each');
  const moreChips = elements.filter((el) => el.props?.className === 'dac-chip dac-chip-more');
  assert(moreChips.map((el) => elementText(el)).join(',') === '+1', 'overflow tags collapse into a +N indicator');

  const rows = elements.filter(isRow);
  const alphaRow = rows.find((row) => elementText(row).includes('Alpha'));
  assert(alphaRow !== undefined && elementText(alphaRow).includes('1 KB'), 'per-row formatted size rendered');
  const alphaDate = collectElements(alphaRow).find((el) => el.props?.className === 'dac-row-date');
  assert(alphaDate !== undefined && !elementText(alphaDate).includes('创建于') && !String(alphaDate.props?.title).includes('创建于'),
    'archive row shows the creation time without a redundant label');
  const gammaRow = rows.find((row) => elementText(row).includes('Gamma'));
  assert(gammaRow !== undefined && elementText(gammaRow).includes('—'), 'unavailable session size renders the dash');

  const rowActions = collectElements(alphaRow).find((el) => el.props?.className === 'dac-row-actions');
  const rowActionChildren = collectElements(rowActions).filter(el => el.type === 'button');
  assert(rowActionChildren.length === 2 && rowActionChildren.every(el => el?.type === 'button'),
    'archived row exposes exactly two native actions');
  const quickDelete = rowActionChildren[0];
  assert(quickDelete?.props.className === 'dac-iconbtn'
    && quickDelete.props['aria-label'] === '删除已归档的聊天' && elementText(quickDelete) === ''
    && collectElements(quickDelete).some(el => el.type === 'svg'),
    'left row action is a named icon for permanent deletion');
  assert(elementText(rowActionChildren[1]) === '取消归档', 'unarchive is the rightmost row action');
  assert(!findComponentElement(rowActions, 'ChatActionMenu') && editButtonsIn(alphaRow).length === 0,
    'archived row has no extra preview, edit or More action controls');
  assert(collectElements(alphaRow).some(el => el.type === 'button'
    && el.props?.className === 'dac-row-title dac-row-open' && elementText(el) === 'Alpha'),
    'chat title is a keyboard accessible preview entry');
  const previewTitle = collectElements(alphaRow).find(el => el.type === 'button' && el.props?.className === 'dac-row-title dac-row-open');
  assert(previewTitle?.props.title === undefined && typeof previewTitle?.props.onMouseEnter === 'function' && typeof previewTitle?.props.onFocus === 'function',
    'preview title uses immediate pointer and keyboard hints instead of delayed native title');
  const previewMore = await openArchivePreviewHeader(renderSection, 'Alpha');
  const alphaEdit = editButtonsIn(previewMore)[0];
  assert(alphaEdit !== undefined && !findComponentElement(previewMore, 'ChatActionMenu')
    && !collectElements(previewMore).some(el => el.type === 'button' && elementText(el) === '删除'),
    'preview header exposes editing directly without More or deletion');
  assert(!elements.some(el => el.type === 'button' && el.props?.['aria-label'] === '导出本条'),
    'compact rows do not introduce single-chat export controls');
  const styleText = headChildren.find((child) => child.id === 'dsh-archived-chats-css')?.textContent ?? '';
  assert(styleText.includes('.dac-iconbtn{') && styleText.includes('width:28px;height:28px'), 'row icon dimensions remain stable');
  assert(styleText.includes('.dac-action-trigger{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);')
    && styleText.includes('.dac-unarchive{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);')
    && styleText.includes('.dac-btn-danger{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);'),
  'base outlined actions use the official medium control radius');

  assert(alphaEdit !== undefined, 'preview exposes a metadata edit action');
  assert(alphaEdit?.props.disabled !== true, 'edit action enabled when metadata is ready');
  let editFocuses = 0;
  const editTrigger = { focus: () => { editFocuses += 1; documentMock.activeElement = editTrigger; } };
  documentMock.activeElement = editTrigger;
  alphaEdit.props.onClick();
  tree = renderSection();
  assert(!findComponentElement(tree, 'PreviewDialog'), 'opening metadata closes preview instead of stacking modal dialogs');
  elements = collectElements(tree);

  const dialog = elements.find((el) => el.props?.role === 'dialog' && el.props?.['aria-modal'] === 'true');
  assert(dialog !== undefined, 'metadata editor opens an accessible dialog');
  assert(dialog?.props['aria-labelledby'] === 'dac-meta-title', 'dialog title is labelled');
  assert(dialog?.props['aria-describedby'] === 'dac-meta-limits', 'dialog limits are described');
  const tagInput = elements.find((el) => el.props?.id === 'dac-meta-tags');
  const noteTextarea = elements.find((el) => el.props?.id === 'dac-meta-note');
  assert(tagInput?.props.type === 'text' && tagInput?.props.value === '', 'tag input starts as a draft beside committed tokens');
  assert(elements.some((el) => el.type === 'button' && el.props?.['aria-label'] === '移除标签 important'), 'existing tags render as localized removable tokens');
  assert(noteTextarea !== undefined && noteTextarea?.props.value === 'keep this', 'note textarea prefilled from the row');

  let tagFocuses = 0;
  const tagControl = { focus: () => { tagFocuses += 1; documentMock.activeElement = tagControl; } };
  const saveControl = { focus: () => { documentMock.activeElement = saveControl; } };
  if (dialog?.props.ref) dialog.props.ref.current = {
    contains: (node) => node === tagControl || node === saveControl,
    querySelectorAll: () => [tagControl, saveControl],
  };
  if (tagInput?.props.ref) tagInput.props.ref.current = tagControl;
  documentMock.activeElement = editTrigger;
  const metaEffect = [...effectRecords].reverse().find(({ deps }) => deps?.length === 0);
  const cleanupMeta = metaEffect?.effect();
  assert(tagFocuses === 1, 'metadata dialog moves initial focus to tag input');
  let stoppedEscape = false;
  let preventedEscape = false;
  dialog?.props.onKeyDown?.({
    key: 'Escape',
    preventDefault: () => { preventedEscape = true; },
    stopPropagation: () => { stoppedEscape = true; },
  });
  assert(preventedEscape && stoppedEscape, 'metadata dialog stops Escape before the host settings dialog sees it');
	assert(states[25].value === null, 'metadata Escape cancels only the metadata editor state');
  cleanupMeta?.();
  assert(editFocuses === 1 && documentMock.activeElement === editTrigger, 'metadata dialog restores focus to its captured return target');

	states[25].value = archivedRows[0];
  tree = renderSection();
  elements = collectElements(tree);

  const requests = [];
  const savedFetch = globalThis.fetch;
  let finishMetadataSave;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Promise((resolve) => { finishMetadataSave = () => resolve({
      ok: true, status: 200,
      json: async () => ({ ok: true, metadata: { tags: ['important'], note: 'keep this', updatedAt: '2026-08-18T12:00:00.000Z' } }),
    }); });
  };
  const saveButton = elements.find((el) => el.type === 'button' && elementText(el) === '保存');
  assert(saveButton?.props.disabled !== true, 'save enabled with valid input');
  const metadataPending = saveButton?.props.onClick();
  tree = renderSection();
  const busyMetadataOverlay = collectElements(tree).find((el) => el.props?.className === 'dac-confirm-overlay');
  const busyMetadataDialog = collectElements(tree).find((el) => el.props?.['aria-labelledby'] === 'dac-meta-title');
  const busyMetadataCancel = collectElements(busyMetadataDialog).find((el) => el.type === 'button' && elementText(el) === '取消');
  busyMetadataOverlay?.props.onClick();
  busyMetadataDialog?.props.onKeyDown?.({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  busyMetadataCancel?.props.onClick();
  assert(states[25].value?.id === 'session-a' && busyMetadataCancel?.props.disabled === true,
    'pending metadata save remains visible and cannot be dismissed by Cancel, Escape, or the backdrop');
  finishMetadataSave?.();
  await metadataPending;
  assert(requests[0]?.url === '/plugins/dsh-archived-chats/metadata', 'metadata save targets the guarded route');
  assert(requests[0]?.options.headers['x-dsh-archived-chats'] === '1', 'metadata save sends the guard header');
  assert(
    JSON.stringify(JSON.parse(requests[0]?.options.body ?? '{}')) === JSON.stringify({ sessionId: 'session-a', tags: ['important'], note: 'keep this' }),
    'metadata save sends normalized tags and note',
  );

  // A rejected save keeps the dialog open with the typed values.
  globalThis.fetch = savedFetch;
  const betaMore = await openArchivePreviewHeader(renderSection, 'Beta');
  editButtonsIn(betaMore)[0].props.onClick();
  tree = renderSection();
  elements = collectElements(tree);
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'metadata-save-failed', message: 'boom' }) });
  const betaNote = elements.find((el) => el.props?.id === 'dac-meta-note');
  betaNote.props.onChange({ target: { value: 'typed note' } });
  tree = renderSection();
  elements = collectElements(tree);
  await elements.find((el) => el.type === 'button' && elementText(el) === '保存')?.props.onClick();
  tree = renderSection();
  elements = collectElements(tree);
  const dialogAfterFailure = elements.find((el) => el.props?.role === 'dialog' && el.props?.['aria-modal'] === 'true');
  assert(dialogAfterFailure !== undefined, 'failed save keeps the dialog open');
  assert(elements.find((el) => el.props?.id === 'dac-meta-note')?.props.value === 'typed note', 'failed save preserves typed note text');
  globalThis.fetch = savedFetch;

  // Exercise the real MetadataDialog with persistent hooks so token semantics,
  // IME input, and effect cleanup are verified across actual re-renders.
  const commaTagSession = { ...archivedRows[1], tags: ['research,2026'], note: '' };
	states[25].value = commaTagSession;
  const rawSectionTree = renderSection();
  const metadataElement = findComponentElement(rawSectionTree, 'MetadataDialog');
  assert(metadataElement !== undefined, 'metadata dialog component is present in the real section tree');
  const harness = createHookHarness(metadataElement.type);
  const savedMetadata = [];
  let restoredDirectFocus = 0;
  let initialTagFocuses = 0;
  let directCancellations = 0;
  const priorMetadataKeydown = documentListeners.get('keydown');
  documentListeners.delete('keydown');
  const attachMetadataRef = (ref, node) => {
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };
  const returnControl = { focus: () => { restoredDirectFocus += 1; documentMock.activeElement = returnControl; } };
  const directTagControl = { focus: () => { initialTagFocuses += 1; documentMock.activeElement = directTagControl; } };
  const directSaveControl = { focus: () => { documentMock.activeElement = directSaveControl; } };
  let dialogProps = {
    ...metadataElement.props,
    returnFocus: returnControl,
    onSave: (tags, note) => { savedMetadata.push({ tags, note }); },
    onCancel: () => { directCancellations += 1; },
  };
  let directTree = harness.render(dialogProps);
  let directElements = collectElements(directTree);
  let directDialog = directElements.find((el) => el.props?.role === 'dialog');
  let directInput = directElements.find((el) => el.props?.id === 'dac-meta-tags');
  const directDialogNode = {
    contains: (node) => node === directTagControl || node === directSaveControl,
    querySelectorAll: () => [directTagControl, directSaveControl],
    focus: () => { documentMock.activeElement = directDialogNode; },
  };
  attachMetadataRef(directDialog?.props.ref, directDialogNode);
  attachMetadataRef(directInput?.props.ref, directTagControl);
  documentMock.activeElement = returnControl;
  harness.flushEffects();
  assert(initialTagFocuses === 1, 'metadata dialog focuses the tag field once on mount');

  documentMock.activeElement = directSaveControl;
  dialogProps = { ...dialogProps, onSave: (tags, note) => { savedMetadata.push({ tags, note }); }, onCancel: () => { directCancellations += 1; } };
  directTree = harness.render(dialogProps);
  harness.flushEffects();
  assert(initialTagFocuses === 1 && restoredDirectFocus === 0 && documentMock.activeElement === directSaveControl, 'parent re-render neither restores nor steals metadata dialog focus');

  documentMock.activeElement = documentMock.body;
  directTree = harness.render({ ...dialogProps, busy: true });
  directElements = collectElements(directTree);
  directDialog = directElements.find((el) => el.props?.role === 'dialog');
  const busyMetadataDialogNode = {
    contains: (node) => node === busyMetadataDialogNode,
    querySelectorAll: () => [],
    focus: () => { documentMock.activeElement = busyMetadataDialogNode; },
  };
  attachMetadataRef(directDialog?.props.ref, busyMetadataDialogNode);
  harness.flushEffects();
  assert(documentMock.activeElement === busyMetadataDialogNode,
    'busy metadata synchronously moves native focus from its newly disabled control to the stable dialog');
  documentMock.activeElement = documentMock.body;
  let metadataLostTabPrevented = false;
  let metadataLostEscapeStopped = false;
  const metadataDocumentKeydown = documentListeners.get('keydown');
  metadataDocumentKeydown?.({
    key: 'Tab', shiftKey: false,
    preventDefault: () => { metadataLostTabPrevented = true; },
    stopPropagation() {}, stopImmediatePropagation() {},
  });
  metadataDocumentKeydown?.({
    key: 'Escape', preventDefault() {}, stopPropagation() {},
    stopImmediatePropagation: () => { metadataLostEscapeStopped = true; },
  });
  assert(typeof metadataDocumentKeydown === 'function'
    && metadataLostTabPrevented
    && documentMock.activeElement === busyMetadataDialogNode
    && metadataLostEscapeStopped
    && directCancellations === 0,
  'busy metadata traps document-level Tab and Escape after native disabled-control focus loss');

  directTree = harness.render(dialogProps);
  directElements = collectElements(directTree);
  directDialog = directElements.find((el) => el.props?.role === 'dialog');
  directInput = directElements.find((el) => el.props?.id === 'dac-meta-tags');
  attachMetadataRef(directDialog?.props.ref, directDialogNode);
  attachMetadataRef(directInput?.props.ref, directTagControl);
  documentMock.activeElement = directSaveControl;
  harness.flushEffects();

  directElements = collectElements(directTree);
  directInput = directElements.find((el) => el.props?.id === 'dac-meta-tags');
  const directLabel = directElements.find((el) => el.type === 'label' && el.props?.htmlFor === 'dac-meta-tags');
  assert(!elementText(directLabel).includes('逗号') && !String(directInput?.props.placeholder).includes('逗号'), 'token editor copy no longer instructs users to enter comma-separated text');
  assert(String(directInput?.props.placeholder).includes('回车'), 'token editor explains the Enter-to-commit interaction');
  assert(directElements.some((el) => el.type === 'button' && el.props?.['aria-label'] === '移除标签 research,2026'), 'token remove action is localized and preserves a comma inside one tag');

  directElements.find((el) => el.props?.id === 'dac-meta-note')?.props.onChange({ target: { value: 'note only edit' } });
  directTree = harness.render(dialogProps);
  directElements = collectElements(directTree);
  directElements.find((el) => el.type === 'button' && elementText(el) === '保存')?.props.onClick();
  assert(
    savedMetadata[0]?.tags.length === 1 && savedMetadata[0]?.tags[0] === 'research,2026' && savedMetadata[0]?.note === 'note only edit',
    'note-only save keeps a tag containing a comma as one token',
  );

  directInput = directElements.find((el) => el.props?.id === 'dac-meta-tags');
  directInput?.props.onChange({ target: { value: '研究' } });
  directTree = harness.render(dialogProps);
  directElements = collectElements(directTree);
  directInput = directElements.find((el) => el.props?.id === 'dac-meta-tags');
  let composingPrevented = false;
  directInput?.props.onKeyDown({
    key: 'Enter',
    isComposing: true,
    nativeEvent: { isComposing: true },
    preventDefault: () => { composingPrevented = true; },
  });
  directTree = harness.render(dialogProps);
  directElements = collectElements(directTree);
  assert(
    composingPrevented === false
      && directElements.find((el) => el.props?.id === 'dac-meta-tags')?.props.value === '研究'
      && !directElements.some((el) => el.type === 'button' && elementText(el) === '研究'),
    'IME composition Enter leaves the draft untouched and does not create a token',
  );
  let committedPrevented = false;
  directElements.find((el) => el.props?.id === 'dac-meta-tags')?.props.onKeyDown({
    key: 'Enter',
    isComposing: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => { committedPrevented = true; },
  });
  directTree = harness.render(dialogProps);
  directElements = collectElements(directTree);
  assert(committedPrevented && directElements.some((el) => el.type === 'button' && elementText(el) === '研究'), 'ordinary Enter commits the current tag draft');
  harness.unmount();
  assert(restoredDirectFocus === 1 && documentMock.activeElement === returnControl, 'metadata dialog restores focus only when it unmounts');
  if (priorMetadataKeydown) documentListeners.set('keydown', priorMetadataKeydown);
  else documentListeners.delete('keydown');

  // Unavailable metadata disables only metadata editing and shows a warning.
	states[22].value = 'unavailable';
	states[25].value = null;
  tree = renderSection();
  elements = collectElements(tree);
  const unavailableMore = await openArchivePreviewHeader(renderSection, 'Alpha');
  const disabledEdits = editButtonsIn(unavailableMore);
  assert(disabledEdits.length === 1 && disabledEdits[0].props.disabled === true, 'preview metadata edit disabled when metadata is unavailable');
  findComponentElement(renderSection(), 'PreviewDialog')?.props.onCancel();
  assert(elements.find((el) => el.props?.className === 'dac-warn') !== undefined, 'unavailable metadata shows a warning');
  assert(elements.filter(isRow).length === 3, 'unavailable metadata keeps all rows listed');

  // An unreadable recycle catalog means the listing cannot be trusted to exclude
  // already-deleted chats, so it has to be labelled rather than shown as normal.
	states[22].value = 'ready';
	states[23].value = 'unavailable';
  tree = renderSection();
  elements = collectElements(tree);
  const trashWarn = elements.filter((el) => el.props?.className === 'dac-warn');
  assert(trashWarn.length === 1 && elementText(trashWarn[0]).includes('回收站目录无法读取'),
    'an unreadable recycle catalog is surfaced on the archived list');
  assert(elements.filter(isRow).length === 3, 'the warning never hides rows');
	states[23].value = 'ready';
  tree = renderSection();
  assert(collectElements(tree).filter((el) => el.props?.className === 'dac-warn').length === 0,
    'a readable recycle catalog shows no warning');

  // Statistics failure never removes rows or lifecycle actions.
	states[24].value = { status: 'error', summary: null, sessions: {} };
	states[22].value = 'ready';
  tree = renderSection();
  elements = collectElements(tree);
  assert(elements.filter(isRow).length === 3, 'statistics failure keeps all rows rendered');
  assert(elements.filter((el) => el.type === 'button' && elementText(el) === '取消归档').length === 3, 'statistics failure keeps unarchive actions');
  const statsFailureMore = await openArchivePreviewHeader(renderSection, 'Alpha');
  const statsFailureEdit = editButtonsIn(statsFailureMore)[0];
  assert(statsFailureEdit !== undefined && statsFailureEdit.props.disabled !== true, 'statistics failure keeps preview metadata editing usable');
  findComponentElement(renderSection(), 'PreviewDialog')?.props.onCancel();

  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11d] client half — full-text results and archived conversation preview');
{
  const correlated = clientExports.__test.buildPreviewNodes?.([
    { seq: 1, role: 'assistant', segments: [{ kind: 'tool-call', callId: 'call-a', name: 'read_file', argumentsText: '{}' }] },
    { seq: 2, role: 'tool', segments: [{ kind: 'tool-result', toolCallId: 'call-a', text: 'ok', isError: false }] },
    { seq: 3, role: 'tool', segments: [{ kind: 'tool-result', toolCallId: 'missing', text: 'orphan', isError: true }] },
  ]);
  assert(correlated?.length === 2, 'tool correlation folds one matching result without hiding an orphan');
  assert(correlated?.[0]?.segments[0]?.result?.text === 'ok', 'tool correlation attaches the matching result');
  assert(correlated?.[1]?.segments[0]?.text === 'orphan', 'tool correlation retains an unmatched result');

  const resultBeforeCall = clientExports.__test.buildPreviewNodes?.([{
    seq: 4,
    role: 'assistant',
    segments: [
      { kind: 'tool-result', toolCallId: 'call-late', text: 'too early', isError: false },
      { kind: 'tool-call', callId: 'call-late', name: 'read_file', argumentsText: '{}' },
    ],
  }]);
  assert(resultBeforeCall?.[0]?.segments.filter((segment) => segment.text === 'too early').length === 1, 'same-message result before its call remains unmatched exactly once');
  assert(resultBeforeCall?.[0]?.segments[1]?.result === undefined, 'same-message result before its call is never folded into that call');

  const copyNode = clientExports.__test.buildPreviewNodes?.([{
    seq: 7,
    role: 'assistant',
    segments: [
      { kind: 'text', text: 'answer' },
      { kind: 'tool-call', name: 'read_file', argumentsText: '{"path":"README.md"}', result: { text: 'contents' } },
    ],
  }])[0];
  assert(clientExports.__test.previewCopyText?.(copyNode) === 'answer\n\nread_file\n\n{"path":"README.md"}\n\ncontents', 'preview copy text follows visible segment order');

  const savedHooks = { ...moduleTable.react };
  const savedIntersectionObserver = windowMock.IntersectionObserver;
  const savedUrl = windowMock.URL;
  const createdObjectUrls = [];
  const revokedObjectUrls = [];
  windowMock.URL = {
    createObjectURL: (blob) => {
      const url = `blob:archived-${createdObjectUrls.length + 1}`;
      createdObjectUrls.push(url);
      return url;
    },
    revokeObjectURL: (url) => { revokedObjectUrls.push(url); },
  };
  let intersectionObserver = null;
  class MockIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
      intersectionObserver = this;
    }
    observe(element) { this.observed.push(element); }
    unobserve(element) { this.observed = this.observed.filter((candidate) => candidate !== element); }
    disconnect() { this.disconnected = true; }
  }
  windowMock.IntersectionObserver = MockIntersectionObserver;
  const savedFetch = globalThis.fetch;
  const requests = [];
  const archivedRows = [
    { id: 'session-a', title: 'Alpha', createdAt: 10, origin: null, workspaceId: 'ws-1', workspaceTitle: '项目一', tags: [], note: '' },
    { id: 'session-b', title: 'Beta', createdAt: 20, origin: null, workspaceId: 'ws-2', workspaceTitle: '项目二', tags: [], note: '' },
  ];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const path = String(url);
    const payload = path.endsWith('/state')
      ? { metadataStatus: 'ready', sessions: archivedRows }
      : path.endsWith('/stats')
        ? { summary: { sessionCount: 2, totalBytes: 10, unavailableCount: 0 }, sessions: {} }
        : path.endsWith('/search')
          ? {
            ok: true,
            query: 'needle',
            hits: [{ sessionId: 'session-b', matches: [{ seq: 21, time: 21, role: 'assistant', excerpt: '…body needle from an archived answer…' }] }],
            skipped: [],
          }
            : path.endsWith('/preview')
            ? {
              ok: true,
              session: archivedRows[0],
              offset: 0,
              limit: 50,
              total: 2,
              nextOffset: null,
              messages: [
                { seq: 10, time: 10, role: 'user', source: 'user', segments: [{ kind: 'text', label: null, text: '查看归档内容', isError: false }] },
                { seq: 11, time: 11, role: 'assistant', source: 'model', segments: [
                  { kind: 'text', label: null, text: '这是助手回复', isError: false },
                  { kind: 'reasoning', label: null, text: '这是推理过程', isError: false },
                  { kind: 'tool-call', label: 'read_file', text: '{"path":"README.md"}', callId: 'call-123', name: 'read_file', argumentsText: '{"path":"README.md"}', isError: false },
                  { kind: 'tool-result', label: 'call-123', text: '{"ok":true}', toolCallId: 'call-123', isError: true },
                  { kind: 'json', label: null, text: '{"answer":42}', isError: false },
                  { kind: 'opaque', label: null, text: 'unrecognized payload', isError: false },
                ] },
                { seq: 12, time: 12, role: 'tool', source: 'tool', segments: [
                  { kind: 'tool-result', label: 'missing', text: 'orphan result', toolCallId: 'missing', isError: true },
                ] },
              ],
            }
            : path.endsWith('/preview/image')
              ? null
            : {};
    return path.endsWith('/preview/image')
      ? { ok: true, status: 200, blob: async () => new Blob(['PNG'], { type: 'image/png' }) }
      : { ok: true, status: 200, json: async () => payload };
  };

  // This fails if the client drops the guard, cancellation signal, or strict
  // archive identity when requesting binary image bytes.
  const controller = new AbortController();
  const imageBlob = await clientExports.__test.fetchArchiveImage?.('session-a', 'attachment-session-a', controller.signal);
  const imageRequest = requests.at(-1);
  assert(imageBlob?.type === 'image/png', 'preview image helper returns a browser Blob');
  assert(imageRequest?.url === '/plugins/dsh-archived-chats/preview/image', 'preview image helper targets the image route');
  assert(imageRequest?.options.method === 'POST', 'preview image helper uses POST');
  assert(imageRequest?.options.headers['x-dsh-archived-chats'] === '1', 'preview image helper sends the guard header');
  assert(imageRequest?.options.signal === controller.signal, 'preview image helper forwards cancellation');
  assert(imageRequest?.options.body === '{"sessionId":"session-a","attachmentId":"attachment-session-a"}', 'preview image helper sends only session and attachment identity');

  const imageGroups = clientExports.__test.groupPreviewSegments?.([
    { kind: 'text', text: 'before' },
    { kind: 'image', attachment: archivedImageRef },
    { kind: 'image', attachment: { ...archivedImageRef, attachmentId: 'attachment-session-b' } },
    { kind: 'text', text: 'after' },
  ]);
  assert(imageGroups?.map((group) => group.kind).join(',') === 'segment,images,segment' && imageGroups[1].images.length === 2, 'consecutive preview images form one gallery without absorbing text');

  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let tree = harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = harness.render({ t, refreshSidebar: () => {} });
  let elements = collectElements(tree);

  const previewTrigger = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看对话 Alpha');
  assert(previewTrigger !== undefined, 'each archived row exposes an accessible conversation preview action');

  const searchInput = elements.find((element) => element.type === 'input' && element.props?.placeholder === '搜索会话标题、标签、备注和内容');
  assert(searchInput !== undefined, 'search copy promises metadata and conversation-content search');
  searchInput?.props.onChange({ target: { value: 'needle' } });
  tree = harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 330));
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = harness.render({ t, refreshSidebar: () => {} });
  elements = collectElements(tree);
  const rows = elements.filter((element) => element.props?.className === 'dac-row');
  assert(rows.length === 1 && elementText(rows[0]).includes('Beta'), 'remote body hit joins the existing archive filters');
  assert(elementText(rows[0]).includes('body needle from an archived answer'), 'body hit renders its readable excerpt in the row');
  assert(requests.some((request) => request.url.endsWith('/search') && request.options.headers?.['x-dsh-archived-chats'] === '1'), 'debounced body search uses the guarded route');

  // Clear the filter so Alpha is visible again, then open its projected log.
  const filteredSearch = elements.find((element) => element.type === 'input' && element.props?.placeholder === '搜索会话标题、标签、备注和内容');
  filteredSearch?.props.onChange({ target: { value: '' } });
  tree = harness.render({ t, refreshSidebar: () => {} });
  elements = collectElements(tree);
  const alphaPreview = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看对话 Alpha');
  await alphaPreview?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  const previewElement = findComponentElement(tree, 'PreviewDialog');
  assert(previewElement !== undefined, 'preview action opens the real conversation dialog component');
  if (previewElement !== undefined) {
    const previewHarness = createHookHarness(previewElement.type);
    let previewTree = previewHarness.render(previewElement.props);
    let previewElements = collectElements(previewTree);
    const dialog = previewElements.find((element) => element.props?.role === 'dialog');
    const rail = previewElements.find((element) => element.props?.className === 'dac-preview-rail');
    const closeButton = previewElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '关闭预览');
    let closeFocuses = 0;
    const previewCloseControl = { focus: () => { closeFocuses += 1; documentMock.activeElement = previewCloseControl; } };
    const previewLastControl = { focus: () => { documentMock.activeElement = previewLastControl; } };
    if (dialog?.props.ref) dialog.props.ref.current = {
      contains: (node) => node === previewCloseControl || node === previewLastControl,
      querySelectorAll: () => [previewCloseControl, previewLastControl],
    };
    if (closeButton?.props.ref) closeButton.props.ref.current = previewCloseControl;
    const feed = previewElements.find((element) => element.props?.className === 'dac-preview-feed');
    if (feed?.props.ref) feed.props.ref.current = { id: 'preview-feed' };
    const previewRows = previewElements.filter((element) => element.props?.['data-preview-key']);
    const previewTargets = previewRows.map((row) => ({ dataset: { previewKey: row.props['data-preview-key'] } }));
    previewRows.forEach((row, index) => row.props.ref?.(previewTargets[index]));
    previewHarness.flushEffects();
    const turnObserver = intersectionObserver;
    assert(dialog?.props['aria-modal'] === 'true' && elementText(dialog).includes('Alpha'), 'conversation preview is an accessible labelled dialog');
    documentMock.activeElement = previewLastControl;
    let previewTrappedForward = false;
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: () => { previewTrappedForward = true; } });
    assert(previewTrappedForward && documentMock.activeElement === previewCloseControl, 'conversation preview traps forward tab focus');
    documentMock.activeElement = previewCloseControl;
    let previewTrappedReverse = false;
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: true, preventDefault: () => { previewTrappedReverse = true; } });
    assert(previewTrappedReverse && documentMock.activeElement === previewLastControl, 'conversation preview traps reverse tab focus');
    const closedPromptBody = { tabIndex: 0, checkVisibility: () => false, focus: () => {} };
    dialog.props.ref.current.querySelectorAll = (selector) => selector.includes('summary')
      ? [previewCloseControl, previewLastControl, closedPromptBody]
      : [previewCloseControl, closedPromptBody];
    documentMock.activeElement = previewCloseControl;
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: true, preventDefault: () => {} });
    assert(documentMock.activeElement === previewLastControl,
      'reverse Tab reaches the last disclosure summary instead of its hidden prompt body');
    documentMock.activeElement = previewLastControl;
    previewTrappedForward = false;
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: () => { previewTrappedForward = true; } });
    assert(previewTrappedForward && documentMock.activeElement === previewCloseControl,
      'Tab from the final closed disclosure summary stays inside the preview');
    dialog.props.ref.current.querySelectorAll = () => [previewCloseControl, previewLastControl];
    assert(collectElements(rail).filter((element) => element.type === 'button').length === 3, 'preview renders one timeline navigation control per visible message');
    assert(elementText(dialog).includes('查看归档内容'), 'preview renders projected user text');
    const toolDisclosures = previewElements.filter((element) => element.type === DisclosureRowStub && element.props?.title === 'read_file');
    const matchedToolElements = collectElements(toolDisclosures[0]);
    const toolArguments = matchedToolElements.filter((element) => element.type === JsonBlockStub && element.props?.payload?.path === 'README.md');
    const toolResults = matchedToolElements.filter((element) => element.props?.className === 'dac-preview-tool-result dac-error' && elementText(element) === '{"ok":true}');
    assert(toolDisclosures.length === 1 && toolArguments.length === 1, 'preview renders structured tool-call content once');
    assert(toolResults.length === 1, 'matched error result carries semantic styling on its result element');
    assert(elementText(dialog).includes('orphan result'), 'preview retains the unmatched tool result');
    const orphanTool = previewElements.find((element) => element.type?.name === 'PreviewToolResult' && element.props?.segment?.text === 'orphan result');
    const orphanResults = collectElements(orphanTool).filter((element) => element.props?.className === 'dac-preview-tool-result dac-error');
    assert(orphanResults.length === 1, 'unmatched error result carries semantic styling on its result element');
    assert(headChildren.find((element) => element.id === 'dsh-archived-chats-css')?.textContent.includes('.dac-preview-tool-result.dac-error{color:var(--dsw-alias-state-error-primary)}'), 'result error styling uses the semantic error token');
    assert(previewElements.some((element) => element.type === JsonBlockStub && element.props?.label === 'JSON'), 'preview gives JSON blocks a localized fallback label');
    assert(elementText(dialog).includes('未知内容') && elementText(dialog).includes('unrecognized payload'), 'preview safely localizes unknown segment fallback content');
    const userRow = previewElements.find((element) => element.props?.['data-preview-role'] === 'user');
    const assistantRow = previewElements.find((element) => element.props?.['data-preview-role'] === 'assistant');
    assert(userRow?.props.className.includes('dac-preview-user'), 'preview aligns the user row with the native bubble treatment');
    assert(assistantRow?.props.className.includes('dac-preview-assistant'), 'preview aligns the assistant row without a generic card');
    assert(collectElements(userRow).some((element) => element.props?.className === 'dac-preview-user-bubble'), 'user text is wrapped by the native-style bubble');
    assert(collectElements(assistantRow).some((element) => element.type === MarkdownTextStub), 'assistant text uses the host Markdown primitive');
    assert(previewElements.some((element) => element.type === DisclosureRowStub), 'reasoning uses the host disclosure primitive');
    assert(!previewElements.some((element) => element.props?.className === 'dac-preview-message'), 'generic preview cards are removed');
    assert(elementText(dialog).includes('只读预览'), 'preview displays the localized read-only label');

    // This component-level harness keeps its hooks isolated while still
    // exercising the rendered image, IntersectionObserver, and fetch boundary.
    const PreviewImage = clientExports.__test.PreviewImage;
    assert(typeof PreviewImage === 'function', 'client exposes the archived image lifecycle component for browser rendering');
    if (typeof PreviewImage === 'function') {
      const imageHarness = createHookHarness(PreviewImage);
      const imageProps = { sessionId: 'session-a', attachment: archivedImageRef, t };
      let imageTree = imageHarness.render(imageProps);
      const imageRoot = { id: 'archived-image-root' };
      imageTree.props.ref.current = imageRoot;
      imageHarness.flushEffects();
      const imageObserver = intersectionObserver;
      assert(imageObserver?.observed.includes(imageRoot), 'archived image waits for its own intersection before loading');
      imageObserver?.callback([{ isIntersecting: true, target: imageRoot }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      imageTree = imageHarness.render(imageProps);
      const imageElements = collectElements(imageTree);
      assert(createdObjectUrls.length === 1, 'visible archived image creates one object URL');
      assert(imageElements.some((element) => element.type === 'img' && element.props?.src === createdObjectUrls[0]), 'archived image renders verified bytes');
      assert(imageElements.some((element) => element.type === 'img' && element.props?.alt === 'archive.png · 2×2'), 'archived image alt text includes its safe name and verified dimensions');
      imageHarness.unmount();
      assert(imageObserver?.disconnected === true && requests.at(-1)?.options.signal?.aborted === true, 'closing an image disconnects observation and aborts pending work');
      assert(revokedObjectUrls.includes(createdObjectUrls[0]), 'closing preview revokes archived image URLs');

      // A failed attachment must stay local to the image rather than replacing
      // the assistant transcript that surrounds it.
      const failedImageHarness = createHookHarness(PreviewImage);
      const imageFetch = globalThis.fetch;
      globalThis.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });
        return { ok: false, status: 404, json: async () => ({ error: 'preview-image-not-found' }) };
      };
      let failedImageTree = failedImageHarness.render(imageProps);
      const failedImageRoot = { id: 'failed-archived-image-root' };
      failedImageTree.props.ref.current = failedImageRoot;
      failedImageHarness.flushEffects();
      intersectionObserver?.callback([{ isIntersecting: true, target: failedImageRoot }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      failedImageTree = failedImageHarness.render(imageProps);
      assert(failedImageTree.props?.className === 'dac-preview-image-placeholder' && elementText(failedImageTree) === '图片不可用 · archive.png · 2×2', 'failed archived image retains its localized safe descriptor');
      assert(previewElements.some((element) => element.type === MarkdownTextStub && element.props?.text === '这是助手回复'), 'failed archived image leaves assistant transcript content rendered');
      failedImageHarness.unmount();
      globalThis.fetch = imageFetch;
    }

    const copied = [];
    const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text) => { copied.push(text); } } } });
    const visibleAssistant = clientExports.__test.buildPreviewNodes(previewElement.props.preview.messages, previewElement.props.preview.session.id)[1];
    const assistantActions = previewElements.find((element) => element.type?.name === 'PreviewActions' && element.props?.node?.key === visibleAssistant.key);
    const copyButton = collectElements(assistantActions).find((element) => element.type === 'button' && element.props?.['aria-label'] === '复制');
    await copyButton?.props.onClick();
    assert(copied[0] === clientExports.__test.previewCopyText(visibleAssistant), 'preview copy action writes the visible node text to the clipboard');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('permission denied'); } } } });
    const failedCopyHarness = createHookHarness(assistantActions.type);
    let failedCopyTree = failedCopyHarness.render(assistantActions.props);
    const failedCopyButton = collectElements(failedCopyTree).find((element) => element.type === 'button');
    let rejectedCopy = false;
    try { await failedCopyButton?.props.onClick(); } catch { rejectedCopy = true; }
    failedCopyTree = failedCopyHarness.render(assistantActions.props);
    const failedCopyElements = collectElements(failedCopyTree);
    assert(!rejectedCopy
      && failedCopyElements.some((element) => element.props?.role === 'alert' && elementText(element).includes('无法复制'))
      && failedCopyElements.some((element) => element.type === 'button' && elementText(element) === '复制'),
    'clipboard denial is handled locally, announced accessibly, and leaves Copy retryable');
    failedCopyHarness.unmount();
    if (savedNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', savedNavigator);

    turnObserver?.callback([{ isIntersecting: true, intersectionRatio: 0.8, target: previewTargets[1] }]);
    previewTree = previewHarness.render(previewElement.props);
    previewElements = collectElements(previewTree);
    const secondRailButton = previewElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '转到第 2 条消息');
    assert(secondRailButton?.props['aria-current'] === 'true', 'turn rail marks the currently visible node');

    const closeFocusesBeforeRerender = closeFocuses;
    const rerenderedSection = harness.render({ t, refreshSidebar: () => {} });
    const rerenderedPreview = findComponentElement(rerenderedSection, 'PreviewDialog');
    previewTree = previewHarness.render(rerenderedPreview?.props ?? previewElement.props);
    previewElements = collectElements(previewTree);
    previewHarness.flushEffects();
    assert(closeFocuses === closeFocusesBeforeRerender, 'parent re-render does not refocus the open conversation preview');
    previewHarness.unmount();
    assert(turnObserver?.disconnected === true, 'turn rail disconnects its observer on unmount');
  }

  harness.unmount();
  globalThis.fetch = savedFetch;
  windowMock.IntersectionObserver = savedIntersectionObserver;
  windowMock.URL = savedUrl;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11e] client half — preview primitive fallback');
{
  const missingPrimitives = clientExports.__test.resolvePreviewPrimitives(() => { throw new Error('missing'); });
  assert(Object.values(missingPrimitives).every((primitive) => primitive === null), 'missing public preview primitives resolve to null entries');
  const memoMarkdown = { $$typeof: Symbol.for('react.memo'), type: () => null };
  const forwardIcon = { $$typeof: Symbol.for('react.forward_ref'), render: () => null };
  const supported = clientExports.__test.resolvePreviewPrimitives(() => ({ MarkdownText: memoMarkdown, IconThinkOutline14: forwardIcon, JsonBlock: {} }));
  assert(supported.MarkdownText === memoMarkdown && supported.IconThink === forwardIcon && supported.JsonBlock === null,
    'native memo Markdown and forwardRef icons are accepted without accepting arbitrary objects');
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientExports.__test.PreviewMarkdown);
  const nativeMarkdown = harness.render({ text: '```js\nconst value = 1;\n```', t, primitives: supported });
  assert(nativeMarkdown.type === memoMarkdown && nativeMarkdown.props.labels?.code?.copyLabel === '复制'
    && nativeMarkdown.props.labels?.footnotes === '脚注', 'native memo Markdown receives complete code-fence and footnote labels');
  const fallback = harness.render({ text: '<b>literal</b>', t, primitives: missingPrimitives });
  assert(fallback.type === 'p' && fallback.props.className === 'dac-preview-plain' && fallback.props.children === '<b>literal</b>', 'preview Markdown fallback renders literal text in a plain paragraph');
}

console.log('\n[11e2] client half — collapsed prompt and reasoning headings');
{
  const turn = { key: 'turn:1', startSeq: 1, endSeq: 12, answerSeq: 11, processStartSeq: 3, rowCount: 6, toolCallCount: 1, messageCount: 0, subagentCount: 0, endReason: 'completed' };
  const messages = [
    { seq: 2, turn, role: 'user', segments: [{ kind: 'text', text: 'inspect' }] },
    { seq: 3, turn, role: 'context', sourceLabel: '@plugin/context', segments: [{ kind: 'text', text: 'injected' }] },
    { seq: 5, turn, role: 'assistant', segments: [{ kind: 'reasoning', text: 'plan' }, { kind: 'tool-call', callId: 'a', name: 'bash', argumentsText: '{"description":"List workspace contents","command":"ls"}' }] },
    { seq: 6, turn, role: 'tool', segments: [{ kind: 'tool-result', toolCallId: 'a', text: 'README.md' }] },
    { seq: 9, turn, role: 'user', segments: [{ kind: 'text', text: 'steer' }] },
    { seq: 11, turn, role: 'assistant', segments: [{ kind: 'reasoning', text: 'done thinking' }, { kind: 'text', text: '**Answer**' }] },
  ];
  const nodes = clientExports.__test.buildPreviewNodes(messages);
  const anchored = clientExports.__test.buildPreviewNodes([
    { seq: 5, role: 'user', segments: [{ kind: 'text', text: 'resumed input' }] },
    { seq: 8, anchorSeq: 4, role: 'system', segments: [{ kind: 'text', text: 'active prompt for resumed turn' }] },
  ]);
  assert(anchored.map((node) => node.role).join(',') === 'system,user', 'resumed system prompt is anchored before the relevant human input');
  const process = nodes.find((node) => node.kind === 'process');
  assert(nodes.length === 4 && process?.members.length === 3, 'a complete turn folds context, tool workflow and final reasoning while retaining steering input');
  assert(process?.members[1]?.segments[1]?.result?.text === 'README.md', 'folded process retains the correlated tool result');
  assert(nodes.at(-1)?.segments.length === 1 && nodes.at(-1)?.segments[0]?.text === '**Answer**', 'final answer stays outside process with no duplicated reasoning');
  assert(!clientExports.__test.buildPreviewNodes(messages.slice(0, 5)).some((node) => node.kind === 'process'), 'partial page never folds an incomplete turn');
  assert(clientExports.__test.buildPreviewNodes(messages).filter((node) => node.kind === 'process').length === 1, 'merging later page creates exactly one process');
  assert(!clientExports.__test.buildPreviewNodes(messages.map((node) => ({ ...node, turn: { ...turn, endSeq: null, answerSeq: null } }))).some((node) => node.kind === 'process'), 'unfinished turns keep visible events without claiming a final answer');
  const otherTurn = { ...turn, key: 'turn:20', startSeq: 20, endSeq: 40, answerSeq: null };
  const isolatedTool = clientExports.__test.buildPreviewNodes([
    { seq: 1, role: 'assistant', turn, segments: [{ kind: 'tool-call', callId: 'reused', name: 'bash', argumentsText: '{}' }] },
    { seq: 22, role: 'tool', turn: otherTurn, segments: [{ kind: 'tool-result', toolCallId: 'reused', text: 'different turn' }] },
  ]);
  assert(isolatedTool.length === 2 && !isolatedTool[0].segments[0].result, 'tool identities never correlate across separate native turns');
  assert(!clientExports.__test.buildPreviewNodes([{ seq: 1, role: 'assistant', turn: { ...turn, answerSeq: 1, rowCount: 1, processStartSeq: null }, segments: [{ kind: 'text', text: 'plain answer' }] }]).some((node) => node.kind === 'process'), 'plain answer does not manufacture a thought disclosure');
  if (process) {
    const savedHooks = { ...moduleTable.react };
    const t = clientCtx.locale.bind('settings.archived-chats');
    const tree = createHookHarness(clientExports.__test.PreviewMessage).render({ node: process, t, sessionId: 'test' });
    const rows = collectElements(tree);
    const fold = rows.find((el) => el.type === 'details' && el.props.className === 'dac-preview-process');
    assert(fold && fold.props.open !== true && elementText(fold.props.children[0]).includes('1 次工具调用'), 'outer process uses actual tool count and starts collapsed');
    assert(rows.some((el) => el.type === DisclosureRowStub && elementText(el.props.collapsedContent).includes('List workspace contents')), 'tool disclosure exposes its actual description as a compact summary');
    assert(!rows.some((el) => el.props?.className === 'dac-preview-user-bubble'), 'all process members remain on the assistant side');
    assert(!rows.some((el) => el.type?.name === 'PreviewActions'), 'process rows do not repeat copy and timestamp chrome');
    Object.assign(moduleTable.react, savedHooks);
  }
}
{
  const savedHooks = { ...moduleTable.react };
  const { PreviewMessage, PreviewDisclosure } = clientExports.__test;
  assert(typeof PreviewMessage === 'function' && typeof PreviewDisclosure === 'function',
    'preview exposes the real message and shared disclosure components for interaction checks');
  if (typeof PreviewMessage === 'function' && typeof PreviewDisclosure === 'function') {
    const t = clientCtx.locale.bind('settings.archived-chats');
    for (const [role, source, kind, title] of [
      ['system', 'system', 'text', '系统提示词'],
      ['assistant', 'model', 'reasoning', '思考'],
      ['context', 'plugin', 'text', '上下文注入'],
    ]) {
      const message = createHookHarness(PreviewMessage);
      const tree = message.render({ node: { key: role, role, source, segments: [{ kind, text: 'first line\n<literal prompt>' }] }, sessionId: 'synthetic', t });
      const rows = collectElements(tree);
      assert(!rows.some((el) => el.props?.className === 'dac-preview-user-bubble'), `${role} content never appears in a user bubble`);
      const disclosure = rows.find((el) => el.type === PreviewDisclosure);
      assert(disclosure?.props.title === title, `${role} preview has an explicit localized disclosure heading`);
      if (disclosure) {
        const harness = createHookHarness(PreviewDisclosure);
        const props = disclosure.props;
        let fold = harness.render(props);
        assert(fold.type === DisclosureRowStub && fold.props.open === false && fold.props.icon != null,
          `${role} uses a default-closed native disclosure with a semantic icon`);
        assert(fold.props.expandOnRowClick === true && fold.props.expandable === true,
          `${role} title row remains an interactive disclosure`);
        fold.props.onToggle();
        fold = harness.render(props);
        assert(fold.props.open === true && elementText(fold.props.children).includes('first line\n<literal prompt>'),
          `${role} expands the complete literal content without losing line breaks`);
        fold.props.onToggle();
        assert(harness.render(props).props.open === false, `${role} can be collapsed again`);
        const fallback = harness.render({ ...props, primitives: clientExports.__test.resolvePreviewPrimitives(() => ({})) });
        assert(fallback.type === 'details' && fallback.props.open !== true
          && collectElements(fallback).some((el) => el.type === 'summary' && elementText(el).startsWith(title)),
        `${role} retains a titled, default-closed native details fallback`);
        assert(collectElements(fallback).some((el) => el.props?.className === 'dac-preview-fold-icon')
          && collectElements(fallback).some((el) => el.props?.className === 'dac-preview-fold-chevron'),
        `${role} fallback includes distinct semantic and disclosure icons for hover/focus`);
        harness.unmount();
      }
      message.unmount();
    }
  }
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11f] client half — recycle navigation and management');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const requests = [];
  const archiveRows = [{ id: 'archive-a', title: 'Archived Alpha', createdAt: 10, origin: null, workspaceId: 'ws-1', workspaceTitle: '项目一' }];
  let lineagePayload = { roots: [], diagnostics: [], nodeCount: 0 };
  let recycleRows = [
    {
      sessionId: 'trash-a', state: 'trashed', trashedAt: '2026-08-24T01:02:03.000Z', title: 'Trash Alpha',
      createdAt: 10, workspace: { id: 'ws-1', title: '项目一' }, snapshotId: 'snapshot-a', snapshotBytes: 1536,
      snapshotAttachmentCount: 2, liveDisposition: 'cold',
    },
    {
      sessionId: 'trash-b', state: 'degraded', trashedAt: '2026-08-24T02:03:04.000Z', title: 'Trash Beta',
      createdAt: 20, workspace: null, snapshotId: null, snapshotBytes: 0, snapshotAttachmentCount: 0, liveDisposition: 'parked',
    },
    {
      sessionId: 'trash-project-purge', state: 'trashed', trashedAt: '2026-08-24T03:04:05.000Z', title: 'Trash Project Purge',
      createdAt: 30, workspace: { id: 'ws-2', title: '项目二' }, snapshotId: 'snapshot-project', snapshotBytes: 512,
      snapshotAttachmentCount: 1, liveDisposition: 'cold',
    },
    {
      sessionId: 'trash-empty', state: 'trashed', trashedAt: '2026-08-24T04:05:06.000Z', title: 'Trash Empty',
      createdAt: 40, workspace: { id: 'ws-3', title: '项目三' }, snapshotId: 'snapshot-empty', snapshotBytes: 256,
      snapshotAttachmentCount: 0, liveDisposition: 'cold',
    },
  ];
  const responseFor = (payload) => ({ ok: true, status: 200, json: async () => payload });
  let storageInsightsPayload = {
    summary: { sessionBytes: 3072, snapshotBytes: 1024, totalMeasuredBytes: 4096, duplicateSnapshotBytes: 0, sessionUnavailableCount: 0, degradedSnapshotCount: 0 },
    sessions: [
      { id: 'session-alpha', title: 'Alpha 归档', workspaceTitle: '项目一', scope: 'archive', status: 'ready', sizeBytes: 1024 },
      { id: 'session-beta', title: 'Beta 回收', workspaceTitle: '项目二', scope: 'trash', status: 'ready', sizeBytes: 2048 },
    ],
    snapshots: [
      { snapshotId: 'snapshot-active', sessionId: 'session-alpha', createdAt: '2026-08-24T00:00:00.000Z', totalBytes: 1024, sessionBytes: 1024, attachmentCount: 0, status: 'ready', active: true },
    ],
    policy: { historicalSnapshotsPerSession: 1, historicalSnapshotMaxAgeDays: null, snapshotQuotaBytes: null, recycleMaxAgeDays: null },
    candidateSummary: { snapshotCount: 0, recycleCount: 0, projectedSnapshotBytes: 1024 },
  };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith('/state')) return responseFor({ metadataStatus: 'ready', sessions: archiveRows });
    if (path.endsWith('/stats')) return responseFor({ summary: { sessionCount: 1, totalBytes: 1, unavailableCount: 0 }, sessions: {} });
    if (path.endsWith('/trash/restore')) {
      const ids = JSON.parse(options.body).sessionIds;
      recycleRows = recycleRows.filter((row) => !ids.includes(row.sessionId));
      return responseFor({ restored: ids, failed: [], warnings: [] });
    }
    if (path.endsWith('/trash/purge')) {
      const ids = JSON.parse(options.body).sessionIds;
      recycleRows = recycleRows.filter((row) => !ids.includes(row.sessionId));
      return responseFor({ purged: ids, failed: [] });
    }
    if (path.endsWith('/trash/empty')) {
      const targets = JSON.parse(options.body).targets;
      const purged = targets.map((target) => target.sessionId);
      recycleRows = recycleRows.filter((row) => !purged.includes(row.sessionId));
      return responseFor({ purged, failed: [] });
    }
    if (path.endsWith('/insights')) return responseFor(storageInsightsPayload);
    if (path.endsWith('/lineage')) return responseFor(lineagePayload);
    if (path.endsWith('/trash')) return responseFor({ trashStatus: 'ready', summary: { total: recycleRows.length }, sessions: recycleRows });
    if (path.endsWith('/preview')) return responseFor({ session: { id: 'trash-a', title: 'Trash Alpha' }, messages: [], total: 0, nextOffset: null });
    return responseFor({});
  };

  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let tree = harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  let elements = collectElements(tree);
  const tabs = elements.filter((element) => element.type === 'button' && element.props?.role === 'tab');
  assert(tabs.map((tab) => elementText(tab)).join(',') === '已归档,未归档,回收站,来源与分支,关于',
    'archive manager keeps management tabs before the final About tab');
  assert(tabs[0]?.props['aria-selected'] === true && tabs.slice(1).every((tab) => tab.props['aria-selected'] === false), 'Archived is the default selected tab');
  assert(requests.every((request) => !request.path.includes('/history')), 'retired History API is never requested');

  for (const [index, actionCount] of [[0, 5], [1, 2], [2, 2], [3, 0], [4, 0]]) {
    if (!tabs[index]) { assert(false, `tab ${index} exists`); continue; }
    tabs[index].props.onClick();
    const modeTree = harness.render({ t, refreshSidebar: () => {} });
    const modeElements = collectElements(modeTree);
    const actionRegions = modeElements.filter((item) => item.props?.className === 'dac-head-actions');
    assert(actionRegions.length === 1, `tab ${index} retains a single header action region to prevent layout collapse`);
    const navRow = modeElements.find(item => item.props?.className === 'dac-intro-row');
    const titleRow = modeElements.find(item => item.props?.className === 'dac-head');
    assert(collectElements(navRow).includes(actionRegions[0]) && !collectElements(titleRow).includes(actionRegions[0]),
      `tab ${index} keeps page actions beside the description and out of the title row`);
    assert(collectElements(actionRegions[0]).filter((item) => item.type === 'button').length === actionCount,
      `tab ${index} exposes only its own actions, without hidden inactive buttons`);
  }
  tabs[0].props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });

  const archiveHeading = (view) => collectElements(view).find((item) => item.type === 'button'
    && item.props?.className?.includes('dac-group-toggle') && elementText(item) === '项目一');
  const expandedHeading = archiveHeading(tree);
  const expandedFolder = collectElements(expandedHeading).find((item) => item.type === 'svg');
  assert(expandedHeading?.props['aria-expanded'] === true
    && expandedHeading?.props['aria-label'] === '折叠: 项目一',
  'archive workspace heading names the workspace and expanded state accessibly');
  assert(!collectElements(expandedHeading).some((item) => item.type?.name === 'IconChevron')
    && expandedFolder?.props.width === 18 && expandedFolder?.props.strokeWidth === 1.6,
  'archive workspace heading uses one larger folder with regular strokes and no separate chevron');
  expandedHeading?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  const collapsedHeading = archiveHeading(tree);
  const collapsedFolder = collectElements(collapsedHeading).find((item) => item.type === 'svg');
  assert(collapsedHeading?.props['aria-expanded'] === false
    && collapsedHeading?.props['aria-label'] === '展开: 项目一'
    && !elementText(tree).includes('Archived Alpha'),
  'clicking the arrow-free workspace heading hides its chats and exposes the expand action');
  assert(JSON.stringify(expandedFolder?.props.children) !== JSON.stringify(collapsedFolder?.props.children),
    'folder shape visibly distinguishes expanded and collapsed workspaces');
  collapsedHeading?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  assert(elementText(tree).includes('Archived Alpha') && archiveHeading(tree)?.props['aria-expanded'] === true,
    'clicking the folder heading again restores the archived chats');

  tabs.find((tab) => elementText(tab) === t('tab.insights'))?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  assert(findComponentElement(tree, 'StorageRetentionPanel') === undefined,
    'retired storage panel is absent from the live archive page');
  const storageElement = { type: clientExports.__test.StorageRetentionPanel, props: { t } };
  const legacyStorageHarness = createHookHarness(storageElement.type);
  legacyStorageHarness.render(storageElement.props);
  legacyStorageHarness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const legacyStorageTree = legacyStorageHarness.render(storageElement.props);
  assert(findComponentElement(legacyStorageTree, 'HistoryPanel') === undefined
    && !collectElements(legacyStorageTree).some((item) => item.type === 'button' && elementText(item) === '旧版数据'),
  'Storage no longer exposes a separate legacy-data entry');
  assert(collectElements(legacyStorageTree).filter((item) => item.type === 'select' && item.props['aria-label'] === t('retention.recycleAge')).length === 1,
    'Storage exposes only Recycle Bin retention and no multi-version policies');
  legacyStorageHarness.unmount();
  assert(requests.every((request) => !request.path.includes('/history')),
    'storage never requests the retired History API');
  assert(clientExports.__test.fetchHistoryPreview === undefined && clientExports.__test.fetchHistoryImage === undefined,
    'client no longer exports retired History request helpers');

  const StorageRetentionPanel = clientExports.__test.StorageRetentionPanel;
  if (typeof StorageRetentionPanel !== 'function') {
    assert(false, 'client exposes the storage and retention panel behavior for verification');
  } else {
    const storageHarness = createHookHarness(StorageRetentionPanel);
    storageHarness.render({ t });
    storageHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let storageTree = storageHarness.render({ t });
    let storageElements = collectElements(storageTree);
    const storageText = elementText(storageTree);
    const insightCards = storageElements.filter((element) => element.props?.className === 'dac-insights-card');
    const insightDetailButtons = storageElements.filter((element) => element.props?.className === 'dac-insights-open');
    assert(insightCards.length === 4
      && insightCards.every((card) => card.props?.style?.textAlign === 'center' && card.props?.style?.alignItems === 'center'),
      'storage summary cards center their labels, values, and detail actions');
    assert(insightDetailButtons.length === 2
      && insightDetailButtons.every((button) => button.props?.style?.alignSelf === 'center'),
      'storage summary detail buttons are centered inside their cards');
    assert(!storageElements.some(element => element.props?.className === 'dac-insights-warning'),
      'healthy storage cards omit diagnostic warnings');
    const storageHooks = { ...moduleTable.react };
    const healthySummary = storageInsightsPayload.summary;
    storageInsightsPayload.summary = { ...healthySummary, sessionUnavailableCount: 2, degradedSnapshotCount: 1 };
    const issueHarness = createHookHarness(StorageRetentionPanel);
    issueHarness.render({ t }); issueHarness.flushEffects();
    await new Promise(resolve => setTimeout(resolve, 0));
    const issueCards = collectElements(issueHarness.render({ t })).filter(element => element.props?.className === 'dac-insights-card');
    assert(issueCards.length === 4 && elementText(issueCards[0]).includes('2 个目录无法统计')
      && elementText(issueCards[1]).includes('1 个恢复快照异常')
      && !elementText(issueCards[2]).includes('异常') && !elementText(issueCards[3]).includes('异常'),
      'measurement and snapshot issues appear only inside their respective storage cards');
    issueHarness.unmount(); storageInsightsPayload.summary = healthySummary;
    Object.assign(moduleTable.react, storageHooks);
    assert(storageElements.some((element) => element.props?.role === 'note' && elementText(element).includes('归档列表为空')),
      'storage view explains why retained snapshots can remain without archived chats');
    assert(!storageText.includes('Alpha 归档') && !storageText.includes('snapshot-active')
      && findComponentElement(storageTree, 'HelpTooltip')?.props.children === t('retention.note')
      && !storageElements.some(element => element.props?.role === 'tooltip'),
      'storage view keeps unbounded directory and snapshot rows out of the policy layout');

    const sessionDetailsButton = storageElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看会话目录明细');
    const snapshotDetailsButton = storageElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看保护快照明细');
    assert(sessionDetailsButton !== undefined && snapshotDetailsButton !== undefined,
      'session and snapshot summary cards expose dedicated detail actions');

    sessionDetailsButton?.props.onClick();
    storageTree = storageHarness.render({ t });
    let detailsElement = findComponentElement(storageTree, 'StorageDetailsDialog');
    assert(detailsElement !== undefined, 'session directory details open in a dedicated dialog');
    if (detailsElement !== undefined) {
      const detailsHarness = createHookHarness(detailsElement.type);
      let detailsTree = detailsHarness.render(detailsElement.props);
      let detailsElements = collectElements(detailsTree);
      const detailsDialog = detailsElements.find((element) => element.props?.role === 'dialog');
      const detailsSearch = detailsElements.find((element) => element.type === 'input' && element.props?.type === 'search');
      assert(detailsDialog?.props['aria-modal'] === 'true' && elementText(detailsDialog).includes('会话目录明细')
        && elementText(detailsDialog).includes('Alpha 归档') && elementText(detailsDialog).includes('已归档')
        && elementText(detailsDialog).includes('Beta 回收') && elementText(detailsDialog).includes('回收站'),
      'session detail dialog localizes archive scope and renders every directory row');
      detailsSearch?.props.onChange({ target: { value: 'Beta' } });
      detailsTree = detailsHarness.render(detailsElement.props);
      assert(!elementText(detailsTree).includes('Alpha 归档') && elementText(detailsTree).includes('Beta 回收'),
        'session detail search filters by readable session data');

      let closeCalls = 0;
      let searchFocuses = 0;
      let returnFocuses = 0;
      const lifecycleHarness = createHookHarness(detailsElement.type);
      const lifecycleProps = {
        ...detailsElement.props,
        onClose: () => { closeCalls += 1; },
        returnFocus: { focus: () => { returnFocuses += 1; } },
      };
      const lifecycleTree = lifecycleHarness.render(lifecycleProps);
      const lifecycleElements = collectElements(lifecycleTree);
      const lifecycleDialog = lifecycleElements.find((element) => element.props?.role === 'dialog');
      const lifecycleSearch = lifecycleElements.find((element) => element.type === 'input' && element.props?.type === 'search');
      const searchControl = { focus: () => { searchFocuses += 1; documentMock.activeElement = searchControl; } };
      const closeControl = { focus: () => { documentMock.activeElement = closeControl; } };
      if (lifecycleDialog?.props.ref) lifecycleDialog.props.ref.current = { querySelectorAll: () => [searchControl, closeControl] };
      if (lifecycleSearch?.props.ref) lifecycleSearch.props.ref.current = searchControl;
      lifecycleHarness.flushEffects();
      assert(searchFocuses === 1, 'storage detail dialog focuses its search field on mount');
      documentMock.activeElement = closeControl;
      let tabTrapped = false;
      documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: () => { tabTrapped = true; } });
      assert(tabTrapped && documentMock.activeElement === searchControl, 'storage detail dialog traps forward tab focus');
      let escapePrevented = false;
      let escapeStopped = false;
      let escapeImmediate = false;
      documentListeners.get('keydown')?.({
        key: 'Escape',
        preventDefault: () => { escapePrevented = true; },
        stopPropagation: () => { escapeStopped = true; },
        stopImmediatePropagation: () => { escapeImmediate = true; },
      });
      assert(escapePrevented && escapeStopped && escapeImmediate && closeCalls === 1,
        'storage detail Escape closes only the plugin dialog and isolates host listeners');
      lifecycleHarness.unmount();
      assert(returnFocuses === 1, 'storage detail dialog restores focus when it unmounts');
      detailsHarness.unmount();
      detailsElement.props.onClose();
    }

    storageTree = storageHarness.render({ t });
    storageElements = collectElements(storageTree);
    storageElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看保护快照明细')?.props.onClick();
    storageTree = storageHarness.render({ t });
    detailsElement = findComponentElement(storageTree, 'StorageDetailsDialog');
    assert(detailsElement !== undefined, 'snapshot details open in the same searchable dialog pattern');
    if (detailsElement !== undefined) {
      const snapshotHarness = createHookHarness(detailsElement.type);
      let snapshotTree = snapshotHarness.render(detailsElement.props);
      let snapshotElements = collectElements(snapshotTree);
      const snapshotSearch = snapshotElements.find((element) => element.type === 'input' && element.props?.type === 'search');
      assert(elementText(snapshotTree).includes('回收站使用中的恢复快照')
        && !elementText(snapshotTree).includes('已保留的恢复快照'),
      'snapshot detail dialog lists only active Recycle Bin protection snapshots');
      snapshotSearch?.props.onChange({ target: { value: 'snapshot-active' } });
      snapshotTree = snapshotHarness.render(detailsElement.props);
      assert(elementText(snapshotTree).includes('snapshot-active'),
        'snapshot detail search filters by snapshot identity');
      snapshotHarness.unmount();
    }
    const policyElements = () => collectElements(storageHarness.render({ t }));
    const chooseDays = (value) => policyElements().find((el) => el.type === 'select' && el.props['aria-label'] === t('retention.recycleAge')).props.onChange({ target: { value } });
    const customInput = () => policyElements().find((el) => el.type === 'input' && el.props.type === 'number');
    const saveDays = () => policyElements().find((el) => el.type === 'button' && elementText(el) === '保存策略');
    assert(!customInput(), 'disabled retention does not show a numeric field');
    chooseDays('custom');
    assert(customInput() && saveDays().props.disabled, 'blank custom retention cannot be saved');
    for (const invalid of ['0', '-1', '1.5', '3651', '']) {
      customInput().props.onChange({ target: { value: invalid } });
      assert(saveDays().props.disabled && customInput().props['aria-invalid'], `custom retention rejects ${invalid}`);
    }
    customInput().props.onChange({ target: { value: '42' } });
    assert(!saveDays().props.disabled, 'valid custom retention can be saved');
    const beforePolicyFetch = globalThis.fetch;
    const savedDayValues = [];
    let previewFails = false;
    let saveFails = false;
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/retention/policy/preview')) {
        if (previewFails) throw new Error('preview unavailable');
        const proposed = JSON.parse(options.body);
        const previous = storageInsightsPayload.policy;
        return responseFor({ policy: proposed, confirmationRequired: proposed.recycleAutoDelete && (!previous.recycleAutoDelete || proposed.recycleMaxAgeDays < previous.recycleMaxAgeDays), token: 'policy-token', nonce: 'policy-nonce', candidates: [{ sessionId: 'expired', title: 'Expired chat' }] });
      }
      if (String(url).endsWith('/retention/policy')) {
        if (saveFails) throw new Error('save unavailable');
        const body = JSON.parse(options.body);
        const policy = body.policy ?? body;
        if (policy.recycleAutoDelete && (!storageInsightsPayload.policy.recycleAutoDelete || policy.recycleMaxAgeDays < storageInsightsPayload.policy.recycleMaxAgeDays)) {
          assert(body.confirmation?.token === 'policy-token' && body.confirmation?.nonce === 'policy-nonce', 'UI sends server-issued confirmation for enabling or shortening');
        }
        savedDayValues.push(policy.recycleMaxAgeDays);
        storageInsightsPayload = { ...storageInsightsPayload, policy };
        return responseFor({ policy });
      }
      return beforePolicyFetch(url, options);
    };
    await saveDays().props.onClick();
    let policyDialog = findComponentElement(storageHarness.render({ t }), 'ConfirmDialog');
    assert(policyDialog && savedDayValues.length === 0 && elementText(policyDialog.props.body).includes('Expired chat') && elementText(policyDialog.props.body).includes('1'), 'enabling previews affected chats and count before any setting is saved');
    policyDialog?.props.onCancel();
    assert(savedDayValues.length === 0 && !findComponentElement(storageHarness.render({ t }), 'ConfirmDialog'), 'canceling leaves automatic cleanup disabled');
    await saveDays().props.onClick();
    policyDialog = findComponentElement(storageHarness.render({ t }), 'ConfirmDialog');
    await policyDialog?.props.onConfirm();
    assert(customInput()?.props.value === 42, 'saved nonpreset period reloads as custom without losing its value');
    for (const preset of ['7', '30', '90', '']) {
      chooseDays(preset);
      assert(!customInput(), 'preset and disabled modes hide custom input');
      await saveDays().props.onClick();
      const confirmation = findComponentElement(storageHarness.render({ t }), 'ConfirmDialog');
      assert(Boolean(confirmation) === (preset === '7'), 'only shortening the enabled period asks again');
      await confirmation?.props.onConfirm();
    }
    assert(JSON.stringify(savedDayValues) === '[42,7,30,90,null]', 'custom, presets and disabled save the correct numeric or null policy values');
    assert(storageInsightsPayload.policy.recycleAutoDelete === false, 'disabled mode persists an explicit false opt-in');
    chooseDays('7'); previewFails = true;
    await saveDays().props.onClick();
    assert(policyElements().some((el) => el.props?.className === 'dac-notice' && elementText(el) === 'preview unavailable'), 'failed confirmation preview is a persistent error and never saves');
    previewFails = false;
    await saveDays().props.onClick();
    saveFails = true;
    await findComponentElement(storageHarness.render({ t }), 'ConfirmDialog')?.props.onConfirm();
    assert(policyElements().some((el) => el.props?.className === 'dac-notice' && elementText(el) === 'save unavailable') && storageInsightsPayload.policy.recycleAutoDelete === false, 'failed confirmed save leaves cleanup disabled and reports the error');
    assert(!policyElements().some((el) => el.type === 'button' && elementText(el) === '查看可清理项'), 'automatic cleanup has no extra manual preview gate');
    storageHarness.unmount();
    globalThis.fetch = beforePolicyFetch;

    storageInsightsPayload = {
      ...storageInsightsPayload,
      summary: { ...storageInsightsPayload.summary, sessionBytes: 0, snapshotBytes: 0 },
      sessions: [],
      snapshots: [],
    };
    const emptyStorageHarness = createHookHarness(StorageRetentionPanel);
    emptyStorageHarness.render({ t });
    emptyStorageHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const emptyStorageTree = emptyStorageHarness.render({ t });
    const emptyDetailButtons = collectElements(emptyStorageTree).filter((element) => element.type === 'button'
      && ['查看会话目录明细', '查看保护快照明细'].includes(element.props?.['aria-label']));
    assert(emptyDetailButtons.length === 2 && emptyDetailButtons.every((button) => button.props.disabled === true),
      'zero-row storage summary cards disable their detail actions');
    emptyStorageHarness.unmount();
  }

  const RelationshipsPanel = clientExports.__test.ArchiveRelationshipsPanel;
  if (typeof RelationshipsPanel !== 'function') {
    assert(false, 'client exposes the origins and branches panel behavior for verification');
  } else {
    const relationshipsHarness = createHookHarness(RelationshipsPanel);
    relationshipsHarness.render({ t });
    relationshipsHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const relationshipsTree = relationshipsHarness.render({ t });
    const relationshipElements = collectElements(relationshipsTree);
    const scopeHelp = findComponentElement(relationshipsTree, 'HelpTooltip');
    assert(scopeHelp?.props.children === t('lineage.scopeNote')
      && !relationshipElements.some(element => element.props?.role === 'tooltip'),
      'origins scope explanation is available as help rather than a permanent paragraph');
    assert(elementText(relationshipsTree).includes('暂无归档会话的来源与分支'),
      'origins and branches view has a scoped empty state');
    relationshipsHarness.unmount();

    lineagePayload = { roots: [], diagnostics: [], nodeCount: 0, workspaces: [{ id: 'empty-official', title: 'Empty official workspace' }] };
    const emptyWorkspaceHarness = createHookHarness(RelationshipsPanel);
    emptyWorkspaceHarness.render({ t });
    emptyWorkspaceHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const emptyWorkspaceTree = emptyWorkspaceHarness.render({ t });
    assert(!elementText(emptyWorkspaceTree).includes('Empty official workspace')
      && !collectElements(emptyWorkspaceTree).some(el => el.props?.className === 'dac-lineage-workspace-toggle'),
      'empty official workspaces are excluded from archive relationships');
    const emptyWorkspaceFilter = collectElements(emptyWorkspaceTree).find(el => el.type?.name === 'FilterSelect' && el.props.ariaLabel === t('lineage.projectFilter'));
    assert(!emptyWorkspaceFilter?.props.options.some(option => option.value === 'empty-official'),
      'empty official workspaces are not selectable');
    emptyWorkspaceHarness.unmount();

    const diagnosticSessionId = 'diagnostic-session-without-a-title-1234567890';
    lineagePayload = {
      roots: [{
        id: diagnosticSessionId, parentSession: null, seedLength: null, origin: null, delegationDepth: 0,
        title: null, createdAt: null, workspace: { id: null, title: null }, status: 'archived', children: [],
      }],
      diagnostics: [{ code: 'missing-parent', sessionId: diagnosticSessionId, relatedId: 'missing-parent-id' }],
      nodeCount: 1,
    };
    const englishRelationshipsT = (key) => ({
      'lineage.loading': 'Loading origins and branches…',
      'lineage.error': 'Origins and branches are unavailable',
      'lineage.scopeNote': 'Relationship context is not managed.',
      'lineage.search': 'Search titles or session IDs',
      'lineage.untitled': 'Untitled chat',
      'lineage.diagnostic.missing-parent': 'Missing parent',
      'lineage.diagnostic.missing-parent.detail': 'Parent chat is missing, so source information is unavailable',
      'state.retry': 'Retry',
    })[key] ?? key;
    for (const [localeName, translate, expected] of [
      ['Chinese', t, '无法读取父会话的来源信息'],
      ['English', englishRelationshipsT, 'Parent chat is missing, so source information is unavailable'],
    ]) {
      const diagnosticHarness = createHookHarness(RelationshipsPanel);
      diagnosticHarness.render({ t: translate });
      diagnosticHarness.flushEffects();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const diagnosticTree = diagnosticHarness.render({ t: translate });
      const diagnosticElements = collectElements(diagnosticTree);
      const diagnosticRow = diagnosticElements.find((element) => element.props?.className?.includes('dac-lineage-row-archived'));
      const inlineDiagnostic = collectElements(diagnosticRow).find((element) => element.props?.className === 'dac-lineage-diagnostic');
      const globalDiagnostic = diagnosticElements.find((element) => element.props?.role === 'status'
        && element.props?.className === 'dac-row-meta');
      assert(elementText(inlineDiagnostic) === expected
        && globalDiagnostic === undefined
        && !elementText(diagnosticTree).includes(diagnosticSessionId),
      `${localeName} relationship diagnostics stay complete inside the affected managed card`);
      diagnosticHarness.unmount();
    }

    lineagePayload = {
      roots: [{
        id: 'leaf-source', title: 'Leaf source', status: 'active', origin: null, delegationDepth: 0, createdAt: 1,
        workspace: { id: 'ws-leaf', title: 'Leaf project' }, children: [
          { id: 'leaf-managed', title: 'Managed leaf', status: 'archived', origin: null, delegationDepth: 0, createdAt: 2, workspace: { id: 'ws-leaf', title: 'Leaf project' }, children: [] },
        ],
      }],
      diagnostics: [],
      nodeCount: 2,
    };
    const leafRelationshipsHarness = createHookHarness(RelationshipsPanel);
    leafRelationshipsHarness.render({ t });
    leafRelationshipsHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const leafRelationshipsTree = leafRelationshipsHarness.render({ t });
    const leafRelationshipElements = collectElements(leafRelationshipsTree);
    const leafQueryBar = leafRelationshipElements.find((element) => element.props?.className === 'dac-lineage-toolbar');
    const leafFilterActions = leafRelationshipElements.find((element) => element.props?.className === 'dac-filters');
    assert(leafQueryBar?.props.children[0]?.props.className === 'dac-search'
      && leafQueryBar?.props.children[1]?.props.className === 'dac-lineage-list-head'
      && collectElements(leafQueryBar.props.children[1]).includes(leafFilterActions)
      && collectElements(leafQueryBar.props.children[1]).some(el => el.props?.className === 'dac-lineage-fold'),
      'relationships place full-width search above one shared workspace, count and expand row');
    const leafFilterMenus = collectElements(leafFilterActions).filter(el => el.type?.name === 'FilterSelect');
    const leafFold = leafRelationshipElements.find((element) => element.type === 'button' && element.props?.className === 'dac-lineage-fold');
    const leafFoldIcon = collectElements(leafFold)
      .find((element) => element.type === 'span' && element.props?.className?.includes('dac-chev'));
    const leafWorkspaceFilter = collectElements(leafFilterActions).find(element => element.type?.name === 'FilterSelect');
    assert(leafFilterMenus.length === 1 && leafFilterMenus[0].props.ariaLabel === '筛选项目',
      'workspace is the only relationship filter');
    assert(leafFold?.props.disabled === false && elementText(leafFold) === '全部展开',
      'leaf metadata starts collapsed and can be expanded together with the workspace');
    assert(leafRelationshipElements.some(el => el.props?.className?.includes('dac-lineage-row-active')),
      'a source remains visible before the managed leaf is expanded');
    leafRelationshipsHarness.unmount();

    lineagePayload = {
      roots: [{
        id: 'source-root', title: 'Source root', status: 'active', origin: null, delegationDepth: 0, createdAt: 1,
        workspace: { id: 'ws-source', title: 'Shared sources' }, children: [
          {
            id: 'alpha-branch', title: 'Alpha branch', status: 'archived', origin: null, delegationDepth: 0, createdAt: 2,
            workspace: { id: 'ws-alpha', title: 'Project Alpha' }, children: [
              { id: 'alpha-needle', title: 'Needle chat', status: 'archived', origin: null, delegationDepth: 0, createdAt: 3, workspace: { id: 'ws-alpha', title: 'Project Alpha' }, children: [] },
            ],
          },
          { id: 'beta-branch', title: 'Beta branch', status: 'trash', origin: null, delegationDepth: 0, createdAt: 4, workspace: { id: 'ws-beta', title: 'Project Beta' }, children: [] },
        ],
      }],
      diagnostics: [],
      nodeCount: 4,
    };
    const richRelationshipsHarness = createHookHarness(RelationshipsPanel);
    richRelationshipsHarness.render({ t });
    richRelationshipsHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let richRelationshipsTree = richRelationshipsHarness.render({ t });
    let richRelationshipElements = collectElements(richRelationshipsTree);
    const projectSelect = richRelationshipElements.find((element) => element.type?.name === 'FilterSelect' && element.props?.ariaLabel === '筛选项目');
    const statusSelect = richRelationshipElements.find(el => el.type?.name === 'FilterSelect' && el.props.ariaLabel === '筛选状态');
    let foldAll = richRelationshipElements.find((element) => element.type === 'button' && element.props?.className === 'dac-lineage-fold');
    const initialRelationshipItems = richRelationshipElements.filter((element) => element.props?.role === 'listitem');
    assert(richRelationshipElements.some((element) => element.props?.role === 'list')
      && !richRelationshipElements.some((element) => ['tree', 'treeitem'].includes(element.props?.role)),
    'relationship hierarchy uses native list and disclosure semantics instead of an incomplete ARIA tree widget');
    assert(initialRelationshipItems.length === 5
      && projectSelect.props.options.some(option => option.label === 'Project Alpha') && projectSelect.props.options.some(option => option.label === 'Project Beta')
      && statusSelect === undefined && elementText(richRelationshipsTree).includes('4 个会话'),
    'lineage counts each official chat once and excludes cross-workspace reference copies');
    const initialFoldIcon = collectElements(foldAll)
      .find((element) => element.type === 'span' && element.props?.className?.includes('dac-chev'));
    assert(richRelationshipElements.filter((element) => element.type === 'button' && element.props?.className === 'dac-lineage-fold').length === 1
      && elementText(foldAll) === '全部展开' && initialFoldIcon?.props?.className === 'dac-chev open',
    'lineage starts with roots visible and deeper branches folded even for small trees');

    foldAll?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);
    assert(richRelationshipElements.filter((element) => element.props?.role === 'listitem').length === 6,
      'expand all reveals every branch and its source context');
    const workspaceHeaders = richRelationshipElements.filter((element) => element.props?.className === 'dac-lineage-workspace-toggle');
    const alphaWorkspaceHeader = workspaceHeaders.find(header => elementText(header).includes('Project Alpha'));
    assert(workspaceHeaders.length === 3
      && alphaWorkspaceHeader
      && elementText(alphaWorkspaceHeader).includes('2'),
      'managed relationships are grouped under named workspaces with total counts');
    alphaWorkspaceHeader?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    assert(!elementText(richRelationshipsTree).includes('Alpha branch')
      && elementText(richRelationshipsTree).includes('Beta branch'),
      'collapsing one workspace does not hide other workspace chats');
    assert(storageMap.get('dsh-archived-chats:lineage-workspaces')?.includes('ws-alpha'),
      'workspace folding is persisted separately from archive folding');
    const remountedRelationships = createHookHarness(RelationshipsPanel);
    remountedRelationships.render({ t });
    remountedRelationships.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(!elementText(remountedRelationships.render({ t })).includes('Alpha branch'),
      'workspace collapse survives leaving and reopening the view');
    remountedRelationships.unmount();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    const workspaceSearch = collectElements(richRelationshipsTree).find((element) => element.type === 'input');
    workspaceSearch?.props.onChange({ target: { value: 'Needle' } });
    assert(elementText(richRelationshipsHarness.render({ t })).includes('Needle chat'),
      'search reveals matches even in a collapsed workspace');
    workspaceSearch?.props.onChange({ target: { value: '' } });
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    assert(!elementText(richRelationshipsTree).includes('Alpha branch'),
      'clearing search restores the prior workspace fold state');
    collectElements(richRelationshipsTree).find((element) => element.props?.className === 'dac-lineage-fold')?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);
    assert(elementText(richRelationshipsTree).includes('Needle chat'),
      'expand all opens collapsed workspaces as well as their branches');
    richRelationshipElements.find((element) => element.props?.className === 'dac-lineage-fold')?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    assert(collectElements(richRelationshipsTree).filter((element) => element.props?.role === 'listitem').length === 0
      && collectElements(richRelationshipsTree).filter((element) => element.props?.className === 'dac-lineage-workspace-toggle').length === 3,
      'collapse all leaves only workspace headings visible');
    collectElements(richRelationshipsTree).find((element) => element.props?.className === 'dac-lineage-fold')?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);

    const rootToggle = richRelationshipElements.find((element) => element.type === 'button' && element.props?.className === 'dac-lineage-card-toggle' && element.props['aria-label'] === '折叠 Alpha branch');
    rootToggle?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);
    const relationshipSearch = richRelationshipElements.find((element) => element.type === 'input' && element.props?.placeholder === '搜索会话或项目');
    assert(richRelationshipElements.filter((element) => element.props?.role === 'listitem').length === 5,
      'individual branch collapse hides its descendants while retaining source context');
    relationshipSearch?.props.onChange({ target: { value: 'Needle' } });
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    const searchRelationshipElements = collectElements(richRelationshipsTree);
    const searchFoldControls = searchRelationshipElements.filter((element) => element.type === 'button'
      && ['dac-lineage-card-toggle', 'dac-lineage-fold'].includes(element.props?.className));
    assert(elementText(richRelationshipsTree).includes('Needle chat'), 'lineage search automatically reveals a matching path inside a collapsed branch');
    assert(searchFoldControls.length > 0 && searchFoldControls.every((button) => button.props.disabled === true),
      'search-expanded relationship paths disable fold controls that cannot visibly take effect');
    relationshipSearch?.props.onChange({ target: { value: '' } });
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    assert(!elementText(richRelationshipsTree).includes('Needle chat'), 'clearing lineage search restores the user\'s previous collapsed state');

    const expandAfterSearch = collectElements(richRelationshipsTree).find((element) => element.type === 'button' && elementText(element) === '全部展开');
    expandAfterSearch?.props.onClick();
    projectSelect?.props.onChange('ws-beta');
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    const projectFilteredText = elementText(richRelationshipsTree);
    assert(projectFilteredText.includes('Source root') && projectFilteredText.includes('Beta branch')
      && !projectFilteredText.includes('Alpha branch') && !projectFilteredText.includes('Needle chat'),
    'lineage project selection keeps ancestor context without duplicating unrelated project branches');
    richRelationshipsHarness.unmount();

    lineagePayload = {
      roots: [{
        id: 'large-root', title: 'Large root', status: 'archived', origin: null, workspace: { id: 'ws-large', title: 'Large project' },
        children: Array.from({ length: 50 }, (_, index) => ({
          id: `large-child-${index}`, title: `Large child ${index}`, status: 'archived', origin: null,
          workspace: { id: 'ws-large', title: 'Large project' }, children: [],
        })),
      }],
      diagnostics: [],
      nodeCount: 51,
    };
    const largeRelationshipsHarness = createHookHarness(RelationshipsPanel);
    largeRelationshipsHarness.render({ t });
    largeRelationshipsHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const largeRelationshipsTree = largeRelationshipsHarness.render({ t });
    assert(collectElements(largeRelationshipsTree).filter((element) => element.props?.role === 'listitem').length === 1,
      'lineage trees over fifty nodes default their roots to collapsed');
    largeRelationshipsHarness.unmount();
  }

  tabs.find((tab) => elementText(tab) === t('tab.trash'))?.props.onClick();

  let recycleSidebarRefreshes = 0;
  const recycleProps = { t, refreshSidebar: () => { recycleSidebarRefreshes += 1; } };
  tree = harness.render(recycleProps);
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = harness.render(recycleProps);
  harness.flushEffects();
  elements = collectElements(tree);
  assert(requests.filter((request) => request.path.endsWith('/trash')).length === 1, 'first Recycle Bin activation loads trash once');
  assert(elements.some((element) => element.type === 'button' && element.props?.role === 'tab' && element.props?.['aria-selected'] === true && elementText(element) === '回收站'), 'Recycle Bin tab becomes selected');

  const trashHead = elements.find((element) => element.props?.className === 'dac-intro-row');
  const trashTabs = elements.find((element) => element.props?.className === 'dac-tabs');
  const emptyButton = collectElements(trashHead).find((element) => element.type === 'button' && elementText(element) === '清空回收站');
  assert(elementText(trashHead).startsWith(t('page.description')) && emptyButton !== undefined
    && !collectElements(trashTabs).some((element) => elementText(element) === '清空回收站'),
  'Empty Recycle Bin action sits beside the description, outside the tablist');
  const trashHeaderButtons = collectElements(trashHead).filter((element) => element.type === 'button' && element.props?.role !== 'tab');
  assert(trashHeaderButtons.map(elementText).join(',') === '全部恢复,清空回收站'
    && !collectElements(trashHead).some((element) => element.type === 'details' || element.type?.name === 'ChatActionMenu')
    && !collectElements(trashHeaderButtons[0]).some((element) => element.type === 'svg' || element.type?.name === 'IconRestore'),
  'Recycle Bin exposes text-only Restore all and Empty directly, without a one-item More menu');
  assert(emptyButton?.props.className.includes('dac-danger'), 'direct Empty Recycle Bin retains destructive styling');
  assert(!elements.some((element) => element.type === 'input' && element.props?.type === 'checkbox')
    && !elements.some((element) => element.type === 'button' && elementText(element) === '批量选择')
    && !elements.some((element) => element.props?.className === 'dac-bulkbar'),
  'Recycle Bin removes batch-selection controls, row checkboxes, and bulk bars');

  assert(elementText(tree).includes('Trash Alpha') && elementText(tree).includes('Trash Beta')
    && !elementText(tree).includes('Legacy Alpha') && elementText(tree).includes('项目一'),
    'Recycle Bin renders only chats explicitly moved there');
  assert(elementText(tree).includes('1.5 KB') && elementText(tree).includes('2 个附件'),
    'Recycle Bin renders bounded snapshot size and attachment metadata');
  assert(elementText(tree).includes('保护快照可用') && !elementText(tree).includes('旧版恢复副本') && elementText(tree).includes('快照降级'),
    'Recycle Bin distinguishes normal and degraded chat records without a legacy-copy state');

  const visibleTrashRows = elements.filter((element) => element.props?.className === 'dac-row dac-trash-row');
  const trashRowActionButtons = visibleTrashRows.flatMap((row) => collectElements(row).filter((element) => element.type === 'button'));
  const restoreTextButtons = trashRowActionButtons.filter((button) => button.props?.['aria-label'] === '恢复');
  const purgeTextButtons = trashRowActionButtons.filter((button) => button.props?.['aria-label'] === '永久删除');
  assert(restoreTextButtons.length === visibleTrashRows.length && purgeTextButtons.length === visibleTrashRows.length
    && restoreTextButtons.every((button) => elementText(button) === '恢复' && button.props.className === 'dac-unarchive')
    && purgeTextButtons.every((button) => elementText(button) === '删除' && button.props.className === 'dac-unarchive dac-danger')
    && visibleTrashRows.every((row) => {
      const actions = collectElements(row).filter((element) => element.type === 'button');
      return actions.length === 4 && actions[0].props.className === 'dac-row-title dac-row-open'
        && elementText(actions[1]) === '恢复' && elementText(actions[2]) === '导出快照' && elementText(actions[3]) === '删除';
    }),
  'Recycle Bin titles open previews while row actions retain Restore and Delete');

  const trashGroup = (title) => collectElements(harness.render(recycleProps)).find((element) => element.props?.className?.split(' ').includes('dac-trash-group')
    && elementText(element).includes(title));
  const openTrashGroupMenu = (title) => {
    const group = trashGroup(title);
    collectElements(group).find((element) => element.type === 'button' && element.props?.['aria-label'] === `更多聊天操作: ${title}`)?.props.onClick();
    return collectElements(trashGroup(title));
  };
  let trashMenuElements = openTrashGroupMenu('项目一');
  assert(trashMenuElements.filter((element) => element.props?.role === 'menuitem').map(elementText).join(',') === '全部恢复,全部删除',
    'Recycle Bin project menu orders restore before permanent deletion');
  trashMenuElements.find((element) => element.props?.role === 'menuitem' && elementText(element) === '全部删除')?.props.onClick();
  let groupPurgeDialog = findComponentElement(harness.render(recycleProps), 'ConfirmDialog');
  assert(groupPurgeDialog?.props.title === '删除该工作区的全部回收站聊天？'
    && groupPurgeDialog.props.body.includes('项目一') && groupPurgeDialog.props.body.includes('1 个聊天')
    && groupPurgeDialog.props.body.includes('无法撤销'), 'Recycle Bin project purge names workspace, count, and irreversible consequence');
  groupPurgeDialog?.props.onCancel();

  trashMenuElements = openTrashGroupMenu('项目二');
  trashMenuElements.find((element) => element.props?.role === 'menuitem' && elementText(element) === '全部删除')?.props.onClick();
  groupPurgeDialog = findComponentElement(harness.render(recycleProps), 'ConfirmDialog');
  await groupPurgeDialog?.props.onConfirm();
  assert(requests.some((request) => request.path.endsWith('/trash/purge')
      && request.options.body === '{"sessionIds":["trash-project-purge"]}')
    && !elementText(harness.render(recycleProps)).includes('Trash Project Purge'),
  'Recycle Bin project purge permanently deletes exactly that project');

  trashMenuElements = openTrashGroupMenu('未分组');
  const restoreCountBeforeConfirm = requests.filter(request => request.path.endsWith('/trash/restore')).length;
  await trashMenuElements.find((element) => element.props?.role === 'menuitem' && elementText(element) === '全部恢复')?.props.onClick();
  const workspaceRestoreDialog = findComponentElement(harness.render(recycleProps), 'ConfirmDialog');
  assert(requests.filter(request => request.path.endsWith('/trash/restore')).length === restoreCountBeforeConfirm,
    'workspace Restore all waits for confirmation before mutating');
  assert(workspaceRestoreDialog?.props.body.includes('未分组') && workspaceRestoreDialog.props.body.includes('1 个')
    && workspaceRestoreDialog.props.body.includes('已归档') && workspaceRestoreDialog.props.body.includes('主聊天列表'),
  'workspace restore confirmation names exact scope and archive destination');
  await workspaceRestoreDialog?.props.onConfirm();
  const projectRestoreRequest = requests.findLast((request) => request.path.endsWith('/trash/restore'));
  const afterProjectRestoreText = elementText(harness.render(recycleProps));
  assert(projectRestoreRequest?.options.body === '{"sessionIds":["trash-b"]}',
    `Recycle Bin project restore targets only restorable chats (got ${projectRestoreRequest?.options.body ?? 'no request'})`);
  assert(!afterProjectRestoreText.includes('Trash Beta'),
    'Recycle Bin project restore returns a degraded chat to the archive when its original still exists');
  assert(afterProjectRestoreText.includes('未分组') && afterProjectRestoreText.includes('1 个聊天恢复到已归档'),
    'workspace restore result names its scope, actual restored count, and destination');

  const savedFeedbackTimeout = globalThis.setTimeout;
  const savedFeedbackClear = globalThis.clearTimeout;
  const feedbackTimers = new Map();
  globalThis.setTimeout = (fn, delay) => { const id = {}; feedbackTimers.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = id => feedbackTimers.delete(id);
  try {
    tree = harness.render(recycleProps); harness.flushEffects();
    const expiry = [...feedbackTimers.values()].find(timer => timer.delay === 4000);
    assert(!!expiry && collectElements(tree).some(el => el.props?.className === 'dac-toast'
      && typeof el.props.onMouseEnter === 'function' && typeof el.props.onFocus === 'function'),
    'actual workspace restore wires a pausable auto-dismiss toast');
    expiry?.fn();
    assert(!collectElements(harness.render(recycleProps)).some(el => el.props?.className === 'dac-toast'),
      'workspace restore success disappears on expiry, including its view-archived action');
    harness.flushEffects();
  } finally { globalThis.setTimeout = savedFeedbackTimeout; globalThis.clearTimeout = savedFeedbackClear; }

  tree = harness.render(recycleProps);
  elements = collectElements(tree);

  const collapseProject = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '折叠: 项目一' && elementText(element).includes('项目一'));
  assert(collapseProject?.props['aria-expanded'] === true, 'Recycle Bin project group starts expanded');
  assert(collapseProject?.props.className.includes('dac-archive-group-toggle')
    && !collectElements(collapseProject).some(el => el.props?.className?.includes('dac-chev')),
  'Recycle Bin workspace uses the shared folder toggle without an extra chevron');
  collapseProject?.props.onClick();
  tree = harness.render(recycleProps);
  elements = collectElements(tree);
  assert(!elementText(tree).includes('Trash Alpha'), 'collapsing a Recycle Bin project hides every row in that project');
  assert(JSON.parse(storageMap.get('dsh-archived-chats:collapsed') ?? '{}')['trash:ws-1'] === true, 'Recycle Bin collapse preference uses a tab-specific key');
  elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '展开: 项目一' && elementText(element).includes('项目一'))?.props.onClick();
  tree = harness.render(recycleProps);
  elements = collectElements(tree);

  const ordinaryPreview = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看对话 Trash Alpha');
  await ordinaryPreview?.props.onClick();
  const previewRequest = requests.findLast((request) => request.path.endsWith('/preview'));
  assert(JSON.parse(previewRequest?.options.body ?? '{}').scope === 'trash', 'ordinary Recycle Bin preview is explicitly trash-scoped');
  assert(JSON.parse(previewRequest?.options.body ?? '{}').sessionId === 'trash-a'
    && elementText(ordinaryPreview) === 'Trash Alpha'
    && typeof ordinaryPreview?.props.onFocus === 'function' && typeof ordinaryPreview?.props.onMouseEnter === 'function',
  'clicking a Recycle Bin title previews that chat and offers keyboard and hover feedback');
  findComponentElement(harness.render(recycleProps), 'PreviewDialog')?.props.onCancel();

  tree = harness.render(recycleProps);
  elements = collectElements(tree);
  const ordinaryRestore = elements.find((element) => element.type === 'button'
    && element.props?.['data-session-id'] === 'trash-a' && element.props?.['aria-label'] === '恢复');
  await ordinaryRestore?.props.onClick();
  tree = harness.render(recycleProps);
  elements = collectElements(tree);
  assert(requests.some((request) => request.path.endsWith('/trash/restore')
      && request.options.body === '{"sessionIds":["trash-a"]}')
    && !elementText(tree).includes('Trash Alpha')
    && recycleSidebarRefreshes === 3,
  'ordinary restore returns the exact chat to the archive and refreshes archive consumers');

  collectElements(tree).find(el => el.props?.role === 'tab' && elementText(el) === t('tab.archived'))?.props.onClick();
  tree = harness.render(recycleProps);
  assert(!collectElements(tree).some(el => el.props?.className === 'dac-toast'), 'tab change immediately clears restore success');
  collectElements(tree).find(el => el.props?.role === 'tab' && elementText(el) === t('tab.trash'))?.props.onClick();
  tree = harness.render(recycleProps);
  assert(!collectElements(tree).some(el => el.props?.className === 'dac-toast'), 'returning to Recycle Bin does not resurrect stale success');

  elements = collectElements(tree);
  const currentHead = elements.find((element) => element.props?.className === 'dac-intro-row');
  const emptyRequestsBeforeConfirm = requests.filter((request) => request.path.endsWith('/trash/empty')).length;
  collectElements(currentHead).find((element) => element.type === 'button' && elementText(element) === '清空回收站')?.props.onClick();
  tree = harness.render(recycleProps);
  let purgeDialog = findComponentElement(tree, 'ConfirmDialog');
  assert(purgeDialog?.props.title === '清空回收站？'
    && purgeDialog?.props.body.includes('个工作区') && purgeDialog.props.body.includes('保护快照') && purgeDialog.props.body.includes('无法撤销'),
  'Empty Recycle Bin confirmation names every workspace chat and protection snapshot');
  assert(requests.filter((request) => request.path.endsWith('/trash/empty')).length === emptyRequestsBeforeConfirm,
    'direct Empty button opens confirmation without deleting');
  purgeDialog?.props.onCancel();
  assert(!findComponentElement(harness.render(recycleProps), 'ConfirmDialog')
    && requests.filter((request) => request.path.endsWith('/trash/empty')).length === emptyRequestsBeforeConfirm,
  'canceling direct Empty confirmation leaves all recycled chats untouched');
  collectElements(currentHead).find((element) => element.type === 'button' && elementText(element) === '清空回收站')?.props.onClick();
  purgeDialog = findComponentElement(harness.render(recycleProps), 'ConfirmDialog');
  await purgeDialog?.props.onConfirm();
  assert(requests.some((request) => request.path.endsWith('/trash/empty')
      && request.options.body === '{"targets":[{"sessionId":"trash-empty","state":"trashed","trashedAt":"2026-08-24T04:05:06.000Z","snapshotId":"snapshot-empty","bytes":256}]}')
    && recycleSidebarRefreshes === 4
    && !elementText(harness.render(recycleProps)).includes('Trash Empty'),
  'confirmed Empty Recycle Bin sends the captured record incarnation and refreshes the sidebar');

  harness.unmount();
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11f1] client half — large Empty Recycle Bin scopes are bounded without retrying uncertain writes');
{
  const savedFetch = globalThis.fetch;
  const targets = Array.from({ length: 2001 }, (_, index) => ({
    sessionId: `empty-${index}`, state: 'trashed', trashedAt: `2026-08-24T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    snapshotId: `snapshot-${index}`, bytes: index,
  }));

  for (const mode of ['success', 'known-later-failure', 'first-response-lost']) {
    const batches = [];
    globalThis.fetch = async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      assert(Array.isArray(body.targets), 'Empty requests always carry a bounded explicit target scope');
      batches.push(body.targets);
      if (mode === 'first-response-lost') throw new Error('response lost after commit');
      if (mode === 'known-later-failure' && batches.length === 2) {
        return { ok: false, status: 409, json: async () => ({ purged: [], failed: body.targets.map((target) => ({ id: target.sessionId, reason: 'retention-candidate-stale' })) }) };
      }
      return { ok: true, status: 200, json: async () => ({ purged: body.targets.map((target) => target.sessionId), failed: [] }) };
    };

    const result = await clientExports.__test.emptyTrash(targets);
    if (mode === 'first-response-lost') {
      assert(batches.length === 1 && batches[0].length === 2000, 'an uncertain first Empty batch stops without retry or scope expansion');
      assert(result.purged.length === 0 && result.failed.length === 0 && result.uncertain.length === 2001, 'response loss never invents purge success');
    } else {
      assert(batches.length === 2 && batches[0].length === 2000 && batches[1].length === 1, `Empty uses bounded batches (${mode})`);
      assert(result.purged.length === 2000 + Number(mode === 'success'), `Empty retains prior confirmed successes (${mode})`);
      assert(result.failed.length === Number(mode === 'known-later-failure') && result.uncertain.length === 0, `Empty preserves known failures (${mode})`);
    }
  }
  globalThis.fetch = savedFetch;
}

console.log('\n[11f2] client half — global recycle restore and About');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  const requests = [];
  let rows = [
    { sessionId: 'restore-a', title: 'A', state: 'trashed', workspace: { id: 'a', title: 'Workspace A' } },
    { sessionId: 'restore-b', title: 'B', state: 'degraded', workspace: { id: 'b', title: 'Workspace B' } },
    { sessionId: 'deleting-c', title: 'C', state: 'purge-pending', workspace: { id: 'b', title: 'Workspace B' } },
  ];
  const about = { name: 'dsh-archived-chats', version: '1.3.3', author: 'Ultronen', license: 'MIT',
    links: { home: 'https://github.com/Ultronen/dsh-archived-chats', feedback: 'https://github.com/Ultronen/dsh-archived-chats/issues/new',
      guideZh: 'https://github.com/Ultronen/dsh-archived-chats/blob/main/docs/USER_GUIDE.zh-CN.md',
      guideEn: 'https://github.com/Ultronen/dsh-archived-chats/blob/main/docs/USER_GUIDE.md',
      changelog: 'https://github.com/Ultronen/dsh-archived-chats/releases', marketplace: 'https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/' },
    update: { status: 'unchecked', latestVersion: null, checkedAt: null } };
  let finishRestore;
  let checkFails = false;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url); requests.push({ path, options });
    let payload = {};
    if (path.endsWith('/state')) payload = { sessions: [], metadataStatus: 'ready', trashStatus: 'ready' };
    if (path.endsWith('/trash')) payload = { sessions: rows, trashStatus: 'ready' };
    if (path.endsWith('/about')) payload = about;
    if (path.endsWith('/about/check-updates')) payload = { ...about, update: { status: checkFails ? 'unavailable' : 'available', latestVersion: '1.4.0', checkedAt: '2026-09-21T00:00:00.000Z' } };
    if (path.endsWith('/trash/restore')) {
      await new Promise(resolve => { finishRestore = resolve; });
      rows = rows.filter(row => row.sessionId !== 'restore-a');
      payload = { restored: ['restore-a'], failed: [{ id: 'restore-b', reason: 'snapshot-invalid' }], warnings: [] };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const render = () => harness.render({ t, refreshSidebar: () => {} });
  render(); harness.flushEffects();
  await new Promise(resolve => setTimeout(resolve, 0));
  let tree = render();
  assert(elementText(tree).includes('未归档') && !elementText(tree).includes('批量归档'), 'archive toolbar integrates bulk archive into the Unarchived view');
  assert(elementText(tree).includes('v1.3.3'), 'title row displays the loaded backend version');
  const updateLink = collectElements(tree).find(el => el.type === 'button' && elementText(el) === '查看更新');
  assert(updateLink !== undefined, 'new-version header opens update details without installing');
  await updateLink?.props.onClick({ currentTarget: null });
  assert(findComponentElement(render(), 'UpdateDialog') !== undefined, 'update details are available from the header');
  findComponentElement(render(), 'UpdateDialog')?.props.onClose();
  assert(collectElements(tree).some(el => el.props?.className === 'dac-update-dot'), 'confirmed backend update appears on the actual About tab');
  const automaticChecks = requests.filter(request => request.path.endsWith('/about/check-updates') && request.options.body === '{"force":false}');
  assert(automaticChecks.length === 1 && automaticChecks[0].options.body === '{"force":false}', 'opening archive performs one cache-aware metadata check');
  collectElements(tree).find(el => el.props?.role === 'tab' && elementText(el) === '关于')?.props.onClick();
  tree = render();
  const aboutPanel = findComponentElement(tree, 'AboutPanel');
  assert(collectElements(tree).some(el => el.props?.className === 'dac-update-dot'), 'visiting About does not falsely mark an available update as installed');
  assert(aboutPanel !== undefined && elementText(tree).includes('Ultronen') && elementText(tree).includes('MIT'), 'About shows package identity and license');
  if (aboutPanel) {
    assert(!collectElements(aboutPanel).some(el => /^h[12]$/.test(el.type)), 'About does not repeat the plugin title already shown in the page heading');
    assert(elementText(aboutPanel).includes('会话备份') && !elementText(aboutPanel).includes('回收站恢复'), 'About opens directly with the agreed plugin description');
    const en = clientCalls.localeRegister[0].dicts.en;
    const englishPanel = aboutPanel.type({ ...aboutPanel.props, t: key => en[key] ?? key });
    assert(!collectElements(englishPanel).some(el => /^h[12]$/.test(el.type)) && elementText(englishPanel).includes('conversation backups'), 'English About also starts with an introduction without a repeated title');
  }
  assert(elementText(aboutPanel).includes('当前版本 · v1.3.3'), 'About labels the loaded local version separately from the latest registry version');
  assert(elementText(tree).includes('重启') && elementText(tree).includes('不会自动'), 'About states restart boundaries and no automatic install/restart');
  for (const label of ['项目主页', '使用指南', '更新日志', '问题反馈', '插件市场']) {
    const link = collectElements(tree).find(el => el.type === 'a' && elementText(el).includes(label));
    assert(link?.props.href.startsWith('https://') && link.props.rel?.includes('noopener'), `About ${label} uses a safe direct link`);
  }
  checkFails = true;
  await collectElements(tree).find(el => el.type === 'button' && elementText(el) === '检查更新')?.props.onClick();
  tree = render();
  assert(elementText(tree).includes('检查更新失败') && !elementText(tree).includes('已是最新版本'), 'offline update checks never report latest');
  assert(!collectElements(tree).some(el => el.props?.className === 'dac-update-dot'), 'failed update checks do not retain a confirmed-update badge');
  assert(elementText(tree).includes('当前版本 · v1.3.3') && elementText(tree).includes('Ultronen'), 'failed remote checks retain the running local version and identity');
  assert(requests.some(request => request.path.endsWith('/about/check-updates') && request.options.body === '{"force":true}'), 'manual update check explicitly bypasses the long cache');
  collectElements(tree).find(el => el.props?.role === 'tab' && elementText(el) === '回收站')?.props.onClick();
  render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  tree = render();
  const head = collectElements(tree).find(el => el.props?.className === 'dac-intro-row');
  const restoreAll = collectElements(head).find(el => el.type === 'button' && elementText(el) === '全部恢复');
  assert(restoreAll !== undefined, 'Recycle Bin header has a global Restore all');
  restoreAll?.props.onClick();
  let confirm = findComponentElement(render(), 'ConfirmDialog');
  assert(confirm?.props.body.includes('2 个工作区') && confirm.props.body.includes('2 个可恢复聊天')
    && confirm.props.body.includes('1 个') && confirm.props.body.includes('跳过') && confirm.props.body.includes('已归档'),
  'global restore confirms all workspaces, eligible count, skipped deletions, and archive destination');
  assert(!requests.some(request => request.path.endsWith('/trash/restore')), 'global restore is confirmation-first');
  confirm?.props.onCancel();
  restoreAll?.props.onClick(); confirm = findComponentElement(render(), 'ConfirmDialog');
  const first = confirm?.props.onConfirm();
  const second = confirm?.props.onConfirm();
  assert(requests.filter(request => request.path.endsWith('/trash/restore')).length === 1, 'repeated confirm cannot submit global restoration twice');
  finishRestore?.(); await Promise.all([first, second]);
  tree = render();
  const sent = requests.find(request => request.path.endsWith('/trash/restore'));
  assert(sent?.options.body === '{"sessionIds":["restore-a","restore-b"]}', 'global restore never submits pending-deletion IDs');
  assert(elementText(tree).includes('1 个聊天恢复到已归档') && elementText(tree).includes('1 个未恢复'), 'partial restore reports actual successes and failures together');
  assert(elementText(tree).includes('B') && elementText(tree).includes('C'), 'failed and pending recycle records remain visible');
  collectElements(tree).find(el => el.type === 'button' && elementText(el) === '查看已归档')?.props.onClick();
  assert(collectElements(render()).some(el => el.props?.role === 'tab' && el.props['aria-selected'] === true && elementText(el) === '已归档'), 'restore result offers navigation to Archived');
  assert(!requests.some(request => /\/unarchive|\/install|\/restart/.test(request.path)), 'restore and update discovery do not unarchive, install, or restart');
  harness.unmount(); globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[updates] recurring checks and reviewed installation');
{
  const { watchPluginUpdates } = clientExports.__test;
  assert(typeof watchPluginUpdates === 'function', 'update watcher exists');
  if (watchPluginUpdates) {
    let now = 0, checks = 0, next = 0;
    const timers = new Map(), events = new Map();
    const target = { visibilityState: 'visible', addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
    const network = { navigator: { onLine: true }, addEventListener: target.addEventListener, removeEventListener: target.removeEventListener };
    const stop = watchPluginUpdates(() => { checks++; }, { target, network, now: () => now,
      setTimer: fn => { timers.set(++next, fn); return next; }, clearTimer: id => timers.delete(id) });
    now = 15 * 60_000; timers.get(1)(); assert(checks === 1, 'open page rechecks periodically');
    target.visibilityState = 'hidden'; now += 31_000; events.get('visibilitychange')(); assert(checks === 1, 'hidden page does not check');
    target.visibilityState = 'visible'; events.get('visibilitychange')(); assert(checks === 2, 'returning to visible page catches up');
    events.get('online')(); assert(checks === 2, 'repeated wake events are coalesced');
    now += 31_000; events.get('online')(); assert(checks === 3, 'network recovery triggers a cache-aware retry');
    stop(); assert(events.size === 0 && !timers.has(next), 'unmount removes listeners and pending timers');
  }
}
{
  const savedHooks = { ...moduleTable.react }, savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  const requests = []; let complete;
  const info = { name: 'dsh-archived-chats', version: '1.3.3', author: 'Ultronen', license: 'MIT', links: {},
    update: { status: 'available', latestVersion: '1.4.0', checkedAt: '2026-10-22T00:00:00Z' },
    installation: { environment: 'desktop', profile: 'desktop', source: 'registry', canInstall: true, command: null, packageSpec: 'dsh-archived-chats@1.4.0' }, install: { status: 'idle' } };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url); requests.push({ path, options });
    if (path.endsWith('/about/install-update')) {
      await new Promise(resolve => { complete = resolve; });
      return { ok: true, json: async () => ({ ...info, install: { status: 'restart-required', version: '1.4.0' } }) };
    }
    return { ok: true, json: async () => path.includes('/about') ? info : { sessions: [], trashStatus: 'ready', metadataStatus: 'ready' } };
  };
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const render = () => harness.render({ t, refreshSidebar: () => {} });
  render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  let tree = render();
  collectElements(tree).find(el => el.type === 'button' && elementText(el) === '查看更新')?.props.onClick({ currentTarget: null });
  let modal = findComponentElement(render(), 'UpdateDialog');
  assert(modal !== undefined, 'review modal opens');
  assert(!requests.some(r => r.path.endsWith('/about/install-update')), 'opening details never installs');
  const first = modal?.props.onInstall(), second = modal?.props.onInstall();
  assert(requests.filter(r => r.path.endsWith('/about/install-update')).length === 1, 'duplicate update clicks submit once');
  complete?.(); await Promise.all([first, second]);
  modal = findComponentElement(render(), 'UpdateDialog');
  assert(modal?.props.about.install.status === 'restart-required' && modal.props.about.version === '1.3.3', 'installed and running versions remain distinct');
  assert(requests.find(r => r.path.endsWith('/about/install-update'))?.options.body === '{"version":"1.4.0"}', 'only the reviewed version is sent');
  harness.unmount(); globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

{
  const savedHooks = { ...moduleTable.react }, savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied = null, fails = false;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { if (fails) throw new Error('denied'); copied = value; } } } });
  const t = clientCtx.locale.bind('settings.archived-chats');
  const about = { version: '1.5.3', links: {}, update: { status: 'available', latestVersion: '1.6.0' }, installation: { source: 'local', environment: 'desktop', profile: 'desktop', canInstall: false, localPath: '/local/development' } };
  const harness = createHookHarness(clientExports.__test.UpdateDialog);
  const render = () => harness.render({ t, about, onClose: () => {}, onCheck: () => {}, onInstall: () => {} });
  let tree = render();
  assert(tree.props.hideConfirm === true && elementText(tree).includes('本地开发版'), 'local checkout is labeled and has no install action');
  await collectElements(tree).find(el => el.type === 'button' && elementText(el) === '复制本地路径')?.props.onClick();
  assert(copied === '/local/development' && elementText(render()).includes('已复制'), 'copy uses the exact local directory and confirms only after clipboard success');
  fails = true; await collectElements(render()).find(el => el.type === 'button' && elementText(el) === '已复制')?.props.onClick();
  assert(elementText(render()).includes('复制失败'), 'clipboard rejection gives selectable-text fallback');
  assert(!elementText(render()).includes('复制更新命令') && !elementText(render()).includes('复制安装信息'), 'local checkout never offers a registry replacement command');
  harness.unmount(); Object.assign(moduleTable.react, savedHooks);
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator); else delete globalThis.navigator;
}

console.log('\n[maintenance] About opens a manual, review-first residual check');
{
  const savedHooks = { ...moduleTable.react }, savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  const requests = [];
  let finishScan, failScan = false, rows = [{ id: 'residual-review', title: 'Old agent result', parentSession: 'missing-parent', cwd: '/synthetic', createdAt: 42, sizeBytes: 64 }];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url); requests.push({ path, options });
    let payload = {};
    if (path.endsWith('/state')) payload = { sessions: [], trashStatus: 'ready', metadataStatus: 'ready' };
    if (path.endsWith('/trash')) payload = { sessions: [], trashStatus: 'ready' };
    if (path.includes('/orphans?')) {
      await new Promise(resolve => { finishScan = resolve; });
      if (failScan) throw new Error('scan unavailable');
      payload = { sessions: rows, trashStatus: 'ready', summary: { total: rows.length, bytes: 64 } };
    }
    if (path.includes('/orphans/delete')) {
      const ids = JSON.parse(options.body).sessionIds;
      rows = rows.filter(row => !ids.includes(row.id));
      payload = { deleted: ids, pending: [], failed: [] };
    }
    if (path.endsWith('/preview')) payload = { session: rows[0], messages: [], nextOffset: null };
    return { ok: true, status: 200, json: async () => payload };
  };
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const render = () => harness.render({ t });
  const settle = async () => { render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0)); return render(); };
  const button = label => collectElements(render()).find(el => el.type === 'button' && elementText(el) === label);
  await settle(); await settle();
  collectElements(render()).find(el => el.props?.id === 'dac-tab-about')?.props.onClick();
  await settle();
  assert(!requests.some(request => request.path.includes('/orphans')), 'opening About never scans or mutates conversations automatically');
  const start = button('检查残留会话');
  assert(start !== undefined && elementText(render()).includes('维护工具'), 'About exposes a manual residual maintenance entry even when version metadata is unavailable');
  if (start) {
    start.props.onClick({ currentTarget: { focus() {} } });
    await settle();
    assert(requests.filter(request => request.path.includes('/orphans?')).length === 1 && requests.at(-1).path.includes('kind=subagent'), 'manual check requests only the missing-parent subagent scope');
    let dialog = findComponentElement(render(), 'ResidualSessionsDialog');
    assert(elementText(dialog).includes('正在检查') && !elementText(dialog).includes('未发现残留会话'), 'pending check cannot report a clean result');
    assert(collectElements(dialog).filter(el => el.type === 'button' && [t('residual.backup'),t('orphans.delete')].includes(elementText(el))).every(el=>el.props.disabled), 'loading results cannot be exported or deleted');
    finishScan(); await settle();
    dialog = findComponentElement(render(), 'ResidualSessionsDialog');
    assert(elementText(dialog).includes('Old agent result'), 'completed manual check displays reviewable candidates');
    const preview = collectElements(dialog).find(el => el.type === 'button' && el.props['aria-label']?.includes('Old agent result'));
    await preview?.props.onClick();
    assert(requests.some(request => request.path.endsWith('/preview') && JSON.parse(request.options.body).scope === 'orphan-subagent'), 'maintenance preview retains the strict residual scope');
    findComponentElement(render(), 'PreviewDialog')?.props.onCancel();
    dialog = findComponentElement(render(), 'ResidualSessionsDialog');
    dialog.props.onToggle('residual-review');
    dialog = findComponentElement(render(), 'ResidualSessionsDialog');
    assert(collectElements(dialog).find(el => el.type === 'button' && elementText(el) === t('residual.backup'))?.props.disabled === false, 'reviewed residual selection can be backed up');
    dialog.props.onDelete({ currentTarget: null });
    let confirm = findComponentElement(render(), 'ConfirmDialog');
    assert(confirm && !requests.some(request => request.path.includes('/orphans/delete')), 'selected cleanup waits for irreversible-delete confirmation');
    confirm?.props.onCancel();
    assert(!requests.some(request => request.path.includes('/orphans/delete')), 'canceling cleanup does not delete any conversation');
    dialog.props.onDelete({ currentTarget: null });
    confirm = findComponentElement(render(), 'ConfirmDialog');
    const applying = confirm.props.onConfirm(), duplicate = confirm.props.onConfirm();
    await settle(); finishScan(); await Promise.all([applying, duplicate]); await settle();
    const deletions = requests.filter(request => request.path.includes('/orphans/delete'));
    assert(deletions.length === 1 && deletions[0].path.includes('kind=subagent') && JSON.parse(deletions[0].options.body).sessionIds.join(',') === 'residual-review', 'confirmed maintenance deletes exactly the selected residual once');
    dialog = findComponentElement(render(), 'ResidualSessionsDialog');
    assert(elementText(dialog).includes('未发现残留会话') && dialog.props.selected.size === 0, 'completed cleanup refreshes candidates and clears deleted selections');

    dialog.props.onCheck(); await settle();
    failScan = true; finishScan(); await settle();
    dialog = findComponentElement(render(), 'ResidualSessionsDialog');
    assert(elementText(dialog).includes('检查失败') && !elementText(dialog).includes('未发现残留会话'), 'failed scan stays visibly failed and never reports no residuals');
    assert(collectElements(dialog).some(el => el.type === 'button' && elementText(el) === t('state.retry')), 'failed manual scan offers retry');
    failScan = false; rows = [];
    dialog.props.onCheck(); await settle(); finishScan(); await settle();
    dialog = findComponentElement(render(), 'ResidualSessionsDialog');
    assert(elementText(dialog).includes('未发现残留会话'), 'only a successful empty scan reports a clean result');
    dialog.props.onCheck(); await settle();
    const pending = requests.filter(request => request.path.includes('/orphans?')).at(-1);
    findComponentElement(render(), 'ResidualSessionsDialog')?.props.onClose();
    assert(pending.options.signal.aborted, 'closing maintenance aborts its in-flight scan');
    finishScan(); await settle();
    assert(findComponentElement(render(), 'ResidualSessionsDialog') === undefined, 'late scan results cannot reopen a closed maintenance dialog');
    button('检查残留会话').props.onClick({ currentTarget: null }); await settle();
    collectElements(render()).find(el => el.props?.id === 'dac-tab-archived').props.onClick(); await settle();
    collectElements(render()).find(el => el.props?.id === 'dac-tab-about').props.onClick(); await settle();
    assert(button('检查残留会话')?.props.disabled !== true, 'leaving during a scan cannot leave maintenance permanently disabled');
    finishScan(); await settle();

  }
  harness.unmount(); globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11f2b] client half — local About failures are distinct and retryable');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  for (const failure of ['missing-route', 'invalid-response', 'network']) {
    let unavailable = true;
    let localReads = 0;
    let updateChecks = 0;
    const localInfo = { name: 'dsh-archived-chats', version: '2.7.4', author: 'Ultronen', license: 'MIT',
      links: { home: 'https://github.com/Ultronen/dsh-archived-chats' },
      update: { status: 'unavailable', latestVersion: null, checkedAt: null } };
    globalThis.fetch = async (url) => {
      const path = String(url);
      if (path.endsWith('/about')) {
        localReads += 1;
        if (unavailable && failure === 'network') throw new Error('connection refused');
        return { ok: !(unavailable && failure === 'missing-route'), status: unavailable && failure === 'missing-route' ? 404 : 200,
          json: async () => unavailable ? {} : localInfo };
      }
      if (path.endsWith('/about/check-updates')) { updateChecks += 1; return { ok: true, json: async () => localInfo }; }
      return { ok: true, json: async () => ({ sessions: [], metadataStatus: 'ready', trashStatus: 'ready' }) };
    };
    const harness = createHookHarness(clientCalls.slotRegister[0].component);
    const render = () => harness.render({ t });
    render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    collectElements(render()).find(el => el.props?.role === 'tab' && elementText(el) === '关于')?.props.onClick();
    let tree = render();
    assert(elementText(tree).includes('插件信息读取失败') && !elementText(tree).includes('检查更新失败'), `${failure}: missing local metadata is not misreported as a registry failure`);
    assert(elementText(tree).includes('当前版本 · 暂不可用'), `${failure}: About keeps a truthful version placeholder instead of silently hiding it`);
    assert(updateChecks === 0, `${failure}: unavailable local metadata does not trigger a registry check`);
    const retry = collectElements(tree).find(el => el.type === 'button' && elementText(el) === '重新读取');
    assert(retry !== undefined && retry.props.disabled !== true, `${failure}: local metadata failure has its own retry action`);
    unavailable = false;
    await retry?.props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
    tree = render();
    assert(localReads === 2 && elementText(tree).includes('当前版本 · v2.7.4') && !elementText(tree).includes('v1.3.3'), `${failure}: retry reads and displays the real backend version dynamically`);
    assert(elementText(tree).includes('检查更新失败') && !elementText(tree).includes('插件信息读取失败'), `${failure}: remote failure after successful local retry retains identity`);
    harness.unmount();
  }
  globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11f3] client half — large recycle restore batches preserve partial results');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  for (const laterFailure of [false, true, 'network', 'first-network']) {
    let rows = Array.from({ length: 2001 }, (_, index) => ({ sessionId: `large-${index}`, title: `Chat ${index}`, state: 'trashed', workspace: { id: 'large', title: 'Large workspace' } }));
    const batches = [];
    let stateReads = 0;
    globalThis.fetch = async (url, options = {}) => {
      const path = String(url);
      let status = 200;
      let payload = {};
      if (path.endsWith('/state')) { stateReads += 1; payload = { sessions: [], metadataStatus: 'ready', trashStatus: 'ready' }; }
      if (path.endsWith('/trash')) payload = { sessions: rows, trashStatus: 'ready' };
      if (path.endsWith('/trash/restore')) {
        const ids = JSON.parse(options.body).sessionIds;
        batches.push(ids);
        if (laterFailure === 'first-network') { rows = rows.filter(row => !ids.includes(row.sessionId)); throw new Error('response lost after commit'); }
        if (ids.length > 2000) { status = 400; payload = { error: 'sessionIds-too-many' }; }
        else if (batches.length > 1 && laterFailure) {
          if (laterFailure === 'network') throw new Error('connection lost');
          status = 409; payload = { restored: [], failed: ids.map(id => ({ id, reason: 'snapshot-invalid' })) };
        } else {
          rows = rows.filter(row => !ids.includes(row.sessionId));
          payload = { restored: ids, failed: [] };
        }
      }
      return { ok: status === 200, status, json: async () => payload };
    };
    const harness = createHookHarness(clientCalls.slotRegister[0].component);
    const render = () => harness.render({ t, refreshSidebar: () => {} });
    render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    collectElements(render()).find(el => el.props?.role === 'tab' && elementText(el) === '回收站')?.props.onClick();
    render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    collectElements(render()).find(el => el.type === 'button' && elementText(el) === '全部恢复')?.props.onClick();
    const dialog = render().props.children.find(el => el?.type?.name === 'ConfirmDialog');
    await dialog?.props.onConfirm();
    const tree = render();
    if (laterFailure === 'first-network') {
      assert(batches.length === 1 && batches[0].length === 2000, 'unknown first-batch result stops further writes without retrying');
      assert(elementText(tree).includes('2001 个未确认恢复') && stateReads === 2, 'unknown first-batch result refreshes Archived as well as trash without inventing successes');
      harness.unmount();
      continue;
    }
    assert(batches.length === 2 && batches[0].length === 2000 && batches[1].length === 1, `global restore obeys the host per-request limit (${laterFailure})`);
    assert(elementText(tree).includes(`${laterFailure ? 2000 : 2001} 个聊天恢复到已归档`), `restore summary retains prior batch successes (${laterFailure})`);
    if (laterFailure) assert(elementText(tree).includes(laterFailure === 'network' ? '1 个未确认恢复' : '1 个未恢复'), 'later batch failure keeps the actual failure or uncertainty count');
    assert(collectElements(tree).some(el => el.type === 'button' && elementText(el) === '查看已归档'), 'large restore retains View Archived after success or partial failure');
    harness.unmount();
  }
  globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[archive-delete-tooltip] pointer and keyboard feedback');
{
  const savedHooks = { ...moduleTable.react };
  const savedWindow = { addEventListener: windowMock.addEventListener, removeEventListener: windowMock.removeEventListener, innerWidth: windowMock.innerWidth };
  const savedKeydown = documentListeners.get('keydown');
  const viewportListeners = new Map();
  windowMock.innerWidth = 390;
  windowMock.addEventListener = (name, fn) => viewportListeners.set(name, fn);
  windowMock.removeEventListener = name => viewportListeners.delete(name);
  const harness = createHookHarness(clientExports.__test.ArchiveDeleteButton);
  let opens = 0;
  const props = { sessionId: 'tooltip-chat', label: '删除已归档的聊天', disabled: false, onDelete: () => { opens += 1; } };
  const tip = tree => collectElements(tree).find(el => el.props?.role === 'tooltip');
  const render = () => {
    const tree = harness.render(props);
    const tooltip = tip(tree);
    if (tooltip?.props.ref) tooltip.props.ref.current = { getBoundingClientRect: () => ({ width: 130, height: 32 }) };
    harness.flushEffects(); return tree;
  };
  const pointer = { currentTarget: { getBoundingClientRect: () => ({ left: 360, width: 28, top: 10, bottom: 38 }) } };
  let tree = render();
  tree.props.onMouseEnter(pointer); render(); tree = render();
  assert(elementText(tip(tree)) === props.label && tip(tree).props.style.visibility === 'visible'
    && tip(tree).props.style.left + 130 <= 378 && tip(tree).props.style.top === 46,
    'hover tooltip stays within the viewport and flips below a control near the top edge');
  tree.props.onMouseLeave(); tree = render();
  assert(!tip(tree) && opens === 0, 'leaving the icon hides its tooltip without triggering deletion');
  tree.props.onFocus(pointer); render(); tree = render();
  assert(!!tip(tree) && collectElements(tree).find(el => el.type === 'button').props['aria-describedby'] === tip(tree).props.id,
    'keyboard focus exposes the same linked tooltip');
  let contained = false;
  documentListeners.get('keydown')?.({ key: 'Escape', preventDefault() {}, stopPropagation() { contained = true; }, stopImmediatePropagation() {} });
  tree = render();
  assert(!tip(tree) && contained && opens === 0, 'Escape dismisses the tooltip without forwarding to the host or deleting');
  tree.props.onMouseEnter(pointer); render(); tree = render();
  viewportListeners.get('scroll')?.(); tree = render();
  assert(!tip(tree), 'scrolling hides tooltip instead of leaving it detached from its row');
  harness.unmount();
  assert(viewportListeners.size === 0, 'tooltip listeners are removed on unmount');
  Object.assign(moduleTable.react, savedHooks); Object.assign(windowMock, savedWindow);
  if (savedKeydown) documentListeners.set('keydown', savedKeydown);
}

console.log('\n[preview-title-tooltip] immediate hints and preview activation');
{
  const savedHooks = { ...moduleTable.react };
  const harness = createHookHarness(clientExports.__test.PreviewTitleButton);
  let opens = 0;
  const result = Promise.resolve('preview-ready');
  const props = { sessionId: 'preview-title', title: 'Preview fixture', label: '查看对话 Preview fixture', disabled: false,
    onPreview: () => { opens += 1; return result; } };
  const button = tree => collectElements(tree).find(el => el.type === 'button');
  const tip = tree => collectElements(tree).find(el => el.props?.role === 'tooltip');
  const render = () => harness.render(props);
  const pointer = { currentTarget: { getBoundingClientRect: () => ({ left: 40, width: 200, top: 100, bottom: 122 }) } };
  let tree = render();
  button(tree).props.onMouseEnter(pointer);
  tree = render();
  assert(elementText(tip(tree)) === props.label && opens === 0 && button(tree).props.title === undefined,
    'hover creates the preview hint synchronously without a native title or opening the chat');
  button(tree).props.onMouseLeave(); tree = render();
  assert(!tip(tree), 'leaving the title removes its preview hint');
  button(tree).props.onFocus(pointer); tree = render();
  assert(button(tree).props['aria-describedby'] === tip(tree)?.props.id, 'focused title links to the same preview hint');
  assert(button(tree).props.onClick() === result && opens === 1, 'title activation preserves the asynchronous preview result');
  tree = render();
  assert(!tip(tree), 'opening preview clears the title hint');
  props.disabled = true;
  tree = render(); button(tree).props.onMouseEnter(pointer); tree = render();
  assert(button(tree).props.disabled && !tip(tree), 'disabled title does not show an actionable preview hint');
  harness.unmount(); Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[archive-delete-icon] direct deletion requires confirmation and skips recycling');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  const rows = [{ id: 'direct-delete', title: 'Direct deletion fixture', workspaceId: 'delete-ws', workspaceTitle: 'Delete workspace' }];
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/delete-all')) {
      writes.push({ body: JSON.parse(options.body), guard: options.headers['x-dsh-archived-chats'] });
      return new Response(JSON.stringify({ deleted: ['direct-delete'], failed: [] }));
    }
    return new Response(JSON.stringify(path.endsWith('/state') ? { sessions: rows, metadataStatus: 'ready', trashStatus: 'ready' } : {}));
  };
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const render = () => harness.render({ t });
  const icon = () => collectElements(collectElements(render()).find(el => el.props?.className === 'dac-row-actions')).find(el => el.type === 'button');
  render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  assert(icon()?.props['aria-label'] === '删除已归档的聊天', 'delete icon announces permanent archived-chat deletion instead of recycling');
  icon()?.props.onClick();
  let dialog = findComponentElement(render(), 'ConfirmDialog');
  assert(dialog?.props.title === '删除已归档的聊天？' && dialog.props.body.includes('永久删除')
    && dialog.props.body.includes('Direct deletion fixture') && dialog.props.confirmLabel === '删除',
    'direct delete confirmation names the exact chat and irreversible action');
  assert(writes.length === 0, 'clicking the trash icon never deletes before confirmation');
  dialog?.props.onCancel();
  assert(writes.length === 0, 'canceling direct deletion sends no mutation');
  icon()?.props.onClick();
  await findComponentElement(render(), 'ConfirmDialog')?.props.onConfirm();
  assert(writes.length === 1 && writes[0].body.permanent === true
    && writes[0].body.sessionIds.join(',') === 'direct-delete' && writes[0].guard === '1',
    'confirmed row deletion sends exactly one guarded permanent delete request');
  assert(!collectElements(render()).some(el => el.props?.className === 'dac-row'), 'confirmed direct deletion removes the archived row');
  harness.unmount(); globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[recycle-actions] explicit selected cleanup preserves recovery and scope');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  for (const english of [false, true]) {
    const labels = english ? { recycle: 'Move to Recycle Bin', permanent: 'Delete', question: 'Move selected chats to the Recycle Bin?', archived: 'Archived', select: 'Select' }
      : { recycle: '移入回收站', permanent: '删除', question: '将选中的聊天移入回收站？', archived: '已归档', select: '选择' };
    const baseT = clientCtx.locale.bind('settings.archived-chats');
    const t = english ? key => clientCalls.localeRegister[0].dicts.en[key] ?? baseT(key) : baseT;
    const rows = [
      { id: 'row-cleanup-a', title: 'Recovery Alpha', workspaceId: 'cleanup-ws', workspaceTitle: 'Cleanup workspace' },
      { id: 'row-cleanup-b', title: 'Recovery Beta', workspaceId: 'cleanup-ws', workspaceTitle: 'Cleanup workspace' },
    ];
    const requests = [];
    let finishMove;
    globalThis.fetch = async (url, options = {}) => {
      const path = String(url);
      if (path.endsWith('/delete-all')) {
        const body = JSON.parse(options.body); requests.push(body);
        await new Promise(resolve => { finishMove = resolve; });
        // A protection-snapshot failure must leave the archive row available.
        return new Response(JSON.stringify({ trashed: [], failed: [{ id: 'row-cleanup-a', reason: 'snapshot-failed', message: english ? 'Protection snapshot failed' : '保护快照失败' }] }));
      }
      return new Response(JSON.stringify(path.endsWith('/state') ? { sessions: rows, metadataStatus: 'ready', trashStatus: 'ready' } : {}));
    };
    const harness = createHookHarness(clientCalls.slotRegister[0].component);
    const render = () => harness.render({ t });
    const selectedRecycle = () => collectElements(render()).find(el => el.type === 'button' && elementText(el) === labels.recycle);
    render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    const header = await openArchivePreviewHeader(render, 'Recovery Alpha');
    const headerButtons = collectElements(header).filter(el => el.type === 'button');
    assert(headerButtons.length === 2 && !findComponentElement(header, 'ChatActionMenu'),
      'preview header contains only direct editing and close controls');
    assert(headerButtons.every(el => collectElements(el).some(child => child.type === 'svg')),
      'preview editing and close controls display icons');
    assert(!headerButtons.some(el => elementText(el) === labels.permanent), 'preview has no delete action');
    findComponentElement(render(), 'PreviewDialog')?.props.onCancel();
    const permanent = archiveRowDelete(render(), 'Recovery Alpha');
    assert(permanent !== undefined, 'outer archived row retains permanent deletion');
    permanent?.props.onClick();
    let dialog = findComponentElement(render(), 'ConfirmDialog');
    assert(dialog?.props.body.includes('Recovery Alpha') && !dialog.props.body.includes('Recovery Beta') && dialog.props.confirmClassName === 'dac-btn-danger',
      'secondary permanent confirmation names only the chosen row and remains irreversible');
    dialog?.props.onCancel();
    collectElements(render()).find(el => el.type === 'button' && elementText(el) === labels.select)?.props.onClick();
    collectElements(render()).find(el => el.type === 'input' && el.props?.type === 'checkbox'
      && String(el.props['aria-label']).includes('Recovery Alpha'))?.props.onChange({ target: { checked: true } });
    assert(selectedRecycle() === undefined, 'selection offers no new recycle action in either locale');
    assert(requests.length === 0, 'retired selection actions do not send mutations');
    harness.unmount();
  }
  globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11g] client half — permanent deletion and recoverable project move');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const savedProjectExportUrl = windowMock.URL;
  windowMock.URL = { createObjectURL: () => 'blob:project-export', revokeObjectURL() {} };
  const requests = [];
  const archived = [{ id: 'undo-a', title: 'Undo Alpha', createdAt: 10, origin: null, workspaceId: null, workspaceTitle: null }];
  const responseFor = (payload) => ({ ok: true, status: 200, json: async () => payload });
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith('/state')) return responseFor({ metadataStatus: 'ready', sessions: archived });
    if (path.endsWith('/stats')) return responseFor({ summary: { sessionCount: 1, totalBytes: 0, unavailableCount: 0 }, sessions: {} });
    if (path.endsWith('/export')) return new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="project.zip"',
    } });
    if (path.endsWith('/delete-all')) return responseFor(JSON.parse(options.body).permanent ? { deleted: ['undo-a'], failed: [] } : { trashed: ['undo-a'], failed: [] });
    if (path.endsWith('/trash/restore')) return responseFor({ restored: ['undo-a'], failed: [], warnings: [] });
    return responseFor({});
  };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let tree = harness.render({ t, refreshSidebar: () => {} });
  let elements = collectElements(tree);
  const renderArchive = () => harness.render({ t, refreshSidebar: () => {} });
  const rowDelete = archiveRowDelete(renderArchive(), 'Undo Alpha');
  rowDelete?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  const deleteDialog = findComponentElement(tree, 'ConfirmDialog');
  assert(deleteDialog?.props.title === '删除已归档的聊天？', 'single archive deletion opens a concise confirmation');
  assert(String(deleteDialog?.props.body).includes('Undo Alpha') && String(deleteDialog?.props.body).includes('无法恢复'), 'single archive deletion names the chat and explains irreversibility');
  deleteDialog?.props.onCancel();
  assert(!requests.some((request) => request.path.endsWith('/delete-all')), 'cancelling permanent deletion sends no mutation');
  rowDelete?.props.onClick();
  await findComponentElement(harness.render({ t, refreshSidebar: () => {} }), 'ConfirmDialog')?.props.onConfirm();
  assert(!collectElements(harness.render({ t, refreshSidebar: () => {} })).some((element) => element.props?.className === 'dac-row'), 'successful single permanent deletion removes the row');
  assert(requests.some((request) => request.path.endsWith('/delete-all') && request.options.body === '{"sessionIds":["undo-a"],"permanent":true}'), 'single archive deletion calls the permanent delete route');
  harness.unmount();
  const normalFetch = globalThis.fetch;
  for (const status of [200, 409]) {
    globalThis.fetch = async (url, options = {}) => String(url).endsWith('/delete-all')
      ? { ok: status === 200, status, json: async () => ({
        deleted: [], pending: ['undo-a'], failed: [{ id: 'undo-a', reason: 'session-live-purge-pending' }],
      }) }
      : normalFetch(url, options);
    const pendingHarness = createHookHarness(clientCalls.slotRegister[0].component);
    const renderPending = () => pendingHarness.render({ t, refreshSidebar: () => {} });
    renderPending(); pendingHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    archiveRowDelete(renderPending(), 'Undo Alpha')?.props.onClick();
    await findComponentElement(renderPending(), 'ConfirmDialog')?.props.onConfirm();
    const pendingElements = collectElements(renderPending());
    assert(!pendingElements.some((element) => element.props?.className === 'dac-row'),
      `HTTP ${status} pending permanent deletion no longer leaves a stale actionable archive row`);
    assert(pendingElements.some((element) => String(element.props?.className).includes('dac-notice')
      && elementText(element).includes('会话仍在使用中')),
    `HTTP ${status} pending permanent deletion retains the failure explanation instead of reporting success`);
    pendingHarness.unmount();
  }
  globalThis.fetch = normalFetch;
  const projectHarness = createHookHarness(clientCalls.slotRegister[0].component);
  projectHarness.render({ t, refreshSidebar: () => {} });
  projectHarness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const openMenu = () => {
    collectElements(projectHarness.render({ t, refreshSidebar: () => {} })).find((element) => element.type === 'button' && element.props?.['aria-label'] === '…')?.props.onClick();
    return collectElements(projectHarness.render({ t, refreshSidebar: () => {} }));
  };
  let menuElements = openMenu();
  const projectMenuLabels = menuElements.filter((element) => element.props?.role === 'menuitem').map(elementText);
  assert(projectMenuLabels.join(',') === '全部取消归档,全部导出,全部删除',
    'archive project menu follows the requested action order');
  const workspaceMenu = menuElements.find(element => element.props?.role === 'menu');
  assert(menuElements.some(el => el.props?.className === 'dac-menu-heading' && elementText(el) === '该工作区'), 'workspace menu displays its scope heading');
  const workspaceMenuItems = workspaceMenu?.props.children.filter(el => el && el.props?.className !== 'dac-menu-heading') ?? [];
  assert(workspaceMenuItems.length === 4 && workspaceMenuItems[2].props.role === 'separator'
    && elementText(workspaceMenuItems[1]) === '全部导出' && elementText(workspaceMenuItems[3]) === '全部删除',
  'workspace menu visually and semantically separates permanent deletion from ordinary actions');
	  const exportRequestsBefore = requests.filter((request) => request.path.endsWith('/export')).length;
  menuElements.find((element) => element.props?.role === 'menuitem' && elementText(element) === '全部导出')?.props.onClick();
  const exportDialog = findComponentElement(projectHarness.render({ t, refreshSidebar: () => {} }), 'ConfirmDialog');
  assert(exportDialog?.props.body.includes('未分组') && exportDialog.props.body.includes('1'), 'workspace export confirmation names its scope and count');
	  assert(requests.filter((request) => request.path.endsWith('/export')).length === exportRequestsBefore, 'workspace export waits for confirmation');
	  await exportDialog?.props.onConfirm();
	  const projectExportRequest = requests.filter((request) => request.path.endsWith('/export')).at(-1);
	  assert(new URLSearchParams(projectExportRequest?.options.body).get('sessionIds') === '["undo-a"]',
	    'archive project export submits every archived chat in that project');
  menuElements = openMenu();
  const permanentProjectAction = menuElements.find((element) => element.props?.role === 'menuitem' && elementText(element) === '全部删除');
  assert(permanentProjectAction !== undefined, 'project menu includes permanent deletion alongside recoverable move');
  permanentProjectAction?.props.onClick();
  const projectDialog = findComponentElement(projectHarness.render({ t, refreshSidebar: () => {} }), 'ConfirmDialog');
  assert(projectDialog?.props.title === '删除该工作区的全部已归档聊天？' && projectDialog?.props.body.includes('未分组'), 'project permanent action names the entire workspace even for one chat');
  projectDialog?.props.onCancel();
  menuElements = openMenu();
  assert(!menuElements.some(element => element.props?.role === 'menuitem' && elementText(element) === '全部移入回收站'), 'workspace menu retires new recycle operations');
  assert(!requests.some(request => request.path.endsWith('/delete-all') && JSON.parse(request.options.body).permanent !== true), 'workspace cannot silently invoke the old recycle route');
  projectHarness.unmount();
	  globalThis.fetch = savedFetch;
	  windowMock.URL = savedProjectExportUrl;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11h] client half — workspace bulk archive dialog');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const archived = [
    { id: 'a', title: 'Alpha', workspaceId: 'one', workspaceTitle: '完整工作区名称/很长的项目名称' },
    { id: 'b', title: 'Beta', workspaceId: 'one', workspaceTitle: '完整工作区名称/很长的项目名称' },
    { id: 'c', title: 'Gamma', workspaceId: 'two', workspaceTitle: '另外一个工作区' },
  ];
  const mutations = [];
  let finishUnarchive;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/unarchive-all')) {
      mutations.push(JSON.parse(options.body));
      await new Promise((resolve) => { finishUnarchive = resolve; });
    }
    return { ok: true, status: 200, json: async () => path.endsWith('/state') ? { metadataStatus: 'ready', trashStatus: 'ready', sessions: archived } : path.endsWith('/stats') ? { sessions: {} } : {} };
  };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const render = () => harness.render({ t });
  render(); harness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  collectElements(render()).find((el) => el.type === 'input' && el.props.placeholder === t('search.placeholder'))?.props.onChange({ target: { value: 'Alpha' } });
  for (const label of ['全部导出', '全部取消归档', '全部删除']) {
    const group = findComponentElement(render(), 'GroupSection');
    group.props.onToggleMenu(group.props.group.key);
    const groupView = findComponentElement(render(), 'GroupSection');
    const groupHarness = createHookHarness(groupView.type);
    const groupTree = groupHarness.render(groupView.props);
    let returnedToWorkspaceMenu = false;
    const groupHead = collectElements(groupTree).find((el) => el.props?.className === 'dac-group-head');
    groupHead.props.ref.current = { querySelector: () => ({ focus: () => { returnedToWorkspaceMenu = true; } }) };
    const action = collectElements(groupTree).find((el) => el.props?.role === 'menuitem' && elementText(el) === label);
    const formsBefore = createdElements.filter((el) => el.tagName === 'FORM').length;
    action?.props.onClick();
    assert(returnedToWorkspaceMenu, `${label} preserves workspace menu trigger as confirmation return-focus target`);
    const dialog = findComponentElement(render(), 'ConfirmDialog');
    assert(dialog?.props.body.includes('完整工作区名称/很长的项目名称') && (label === '全部取消归档' ? !/\d+ 个/.test(dialog.props.body) : dialog.props.body.includes('2 个已归档聊天')), `${label} confirms full workspace identity and appropriate scope despite a one-row filter`);
    dialog?.props.onCancel();
    assert(mutations.length === 0 && createdElements.filter((el) => el.tagName === 'FORM').length === formsBefore, `cancelled ${label} has no mutation or download`);
  }
  const head = collectElements(render()).find((el) => el.props?.className === 'dac-intro-row');
  collectElements(head).find((el) => el.type === 'button' && elementText(el) === '全部取消归档')?.props.onClick();
  const dialog = findComponentElement(render(), 'ConfirmDialog');
  assert(dialog?.props.body.includes('所有工作区中的已归档会话') && !/\d+ 个/.test(dialog.props.body), 'global unarchive confirms full scope without counts despite filtering');
  {
    const confirmHarness = createHookHarness(dialog.type);
    let initialFocus = 0, returnFocus = 0, submissions = 0, cancellations = 0, finishSubmit;
    const props = { ...dialog.props, returnFocus: { focus: () => { returnFocus += 1; } }, onConfirm: () => { submissions += 1; return new Promise((resolve) => { finishSubmit = resolve; }); }, onCancel: () => { cancellations += 1; } };
    const confirmation = confirmHarness.render(props);
    const controls = collectElements(confirmation);
    const cancel = controls.find((el) => el.type === 'button' && el.props.className === 'dac-btn');
    cancel.props.ref.current = { focus: () => { initialFocus += 1; } };
    confirmHarness.flushEffects();
    confirmHarness.render({ ...props, onCancel: () => { cancellations += 1; } }); confirmHarness.flushEffects();
    assert(initialFocus === 1 && returnFocus === 0, 'confirmation focuses Cancel once and does not steal focus on parent rerender');
    const apply = controls.find((el) => el.type === 'button' && el.props.className === 'dac-btn-primary');
    const pending = apply.props.onClick(); const duplicate = apply.props.onClick();
    cancel.props.onClick(); confirmation.props.onClick();
    assert(submissions === 1 && cancellations === 0, 'confirmation prevents duplicate submit and misleading dismissal while applying');
    finishSubmit(); await Promise.all([pending, duplicate]);
    confirmHarness.unmount();
    assert(returnFocus === 1, 'confirmation restores its recorded trigger on close');
  }
  const first = dialog?.props.onConfirm();
  const repeated = dialog?.props.onConfirm();
  dialog?.props.onCancel();
  assert(mutations.length === 1 && mutations[0].sessionIds.join(',') === 'a,b,c', 'double confirmation dispatches unarchive exactly once for all archived IDs');
  assert(findComponentElement(render(), 'ConfirmDialog')?.props.busy === true, 'pending bulk confirmation remains visible and busy');
  finishUnarchive?.(); await Promise.all([first, repeated]);
  assert(!findComponentElement(render(), 'ConfirmDialog') && !findComponentElement(render(), 'GroupSection'), 'completed global unarchive closes confirmation and removes archived rows');
  harness.unmount(); globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const requests = [];
  let applied = 0;
  let closed = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    const payload = path.endsWith('/workspace-archive/workspaces')
      ? { ok: true, workspaces: [
          { id: 'workspace-1', title: 'Project One', eligibleCount: 2, liveCount: 1 },
          { id: 'workspace-2', title: 'Project Two', eligibleCount: 1, liveCount: 0 },
          { id: 'workspace-empty', title: 'Empty Project', eligibleCount: 0, liveCount: 0 },
        ] }
      : path.endsWith('/workspace-archive/preview')
        ? { ok: true, token: 'token-1', nonce: 'nonce-1', workspace: { id: 'workspace-1', title: 'Project One' }, sessions: [{ id: 'session-title', title: 'Safe title' }, { id: 'session-fallback', title: null }], skipped: [{ id: 'session-live', reason: 'session-live' }, { id: 'session-archived', reason: 'session-archived' }] }
        : path.endsWith('/workspace-archive/apply')
          ? { ok: true, workspace: { id: 'workspace-1', title: 'Project One' }, archived: ['session-title'], skipped: [{ id: 'session-fallback', reason: 'session-live' }], failed: [{ id: 'session-failed', reason: 'archive-failed' }], snapshots: [{ id: 'session-title', status: 'snapshot-failed' }] }
          : {};
    return { ok: true, status: 200, json: async () => payload };
  };
	  const t = clientCtx.locale.bind('settings.archived-chats');
	  const Chooser = clientExports.__test.WorkspaceArchiveChooserDialog;
	  const Dialog = clientExports.__test.WorkspaceArchiveDialog;
	  assert(typeof Chooser === 'function', 'workspace bulk archive exposes its settings-owned workspace chooser');
	  assert(typeof Dialog === 'function', 'workspace bulk archive exposes its dialog component for focused verification');
	  assert(typeof clientExports.__test.fetchWorkspaceArchiveWorkspaces === 'function'
	    && typeof clientExports.__test.previewWorkspaceArchive === 'function'
	    && typeof clientExports.__test.applyWorkspaceArchive === 'function', 'workspace bulk archive exposes guarded request helpers');
		  const chosenWorkspaces = [];
		  if (typeof Chooser === 'function') {
	    const chooserHarness = createHookHarness(Chooser);
	    const chooserProps = {
	      t,
		      onChoose: (workspaces) => { chosenWorkspaces.push(workspaces); },
	      onClose: () => {},
	    };
	    chooserHarness.render(chooserProps);
	    chooserHarness.flushEffects();
	    await new Promise((resolve) => setTimeout(resolve, 0));
		    let chooserTree = chooserHarness.render(chooserProps);
		    let chooserElements = collectElements(chooserTree);
		    let chooseConfirm = chooserElements.find((element) => element.props?.['data-workspace-archive-choose-confirm'] === '1');
		    const workspaceChoice = chooserElements.find((element) => element.props?.['data-workspace-archive-choice'] === 'workspace-1');
		    let selectAll = chooserElements.find((element) => element.props?.['data-workspace-archive-select-all'] === '1');
		    assert(elementText(chooserTree).includes('Project One') && elementText(chooserTree).includes('Project Two') && elementText(chooserTree).includes('2'), 'workspace chooser lists safe workspace titles and eligible counts');
		    assert(!elementText(chooserTree).includes('Empty Project'), 'workspace chooser hides workspaces without archiveable chats');
		    assert(chooseConfirm?.props.disabled === true && selectAll?.props.checked === false && workspaceChoice?.props.checked === false,
		      'workspace chooser starts with every checkbox clear and its bottom-right confirmation disabled');
		    const chooserDialog = chooserElements.find((element) => element.props?.role === 'dialog');
		    let chooserFocusableSelector = '';
		    const chooserFirst = { focus: () => { documentMock.activeElement = chooserFirst; } };
		    const chooserLast = { focus: () => { documentMock.activeElement = chooserLast; } };
		    chooserDialog.props.ref.current = {
		      contains: (node) => node === chooserFirst || node === chooserLast,
		      querySelectorAll: (selector) => { chooserFocusableSelector = selector; return [chooserFirst, chooserLast]; },
		    };
		    documentMock.activeElement = chooserLast;
		    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: () => {} });
		    assert(chooserFocusableSelector.includes('input:not([disabled])'), 'workspace chooser includes its checkboxes in the modal focus trap');
		    selectAll?.props.onChange(true);
		    chooserTree = chooserHarness.render(chooserProps);
		    chooserElements = collectElements(chooserTree);
		    selectAll = chooserElements.find((element) => element.props?.['data-workspace-archive-select-all'] === '1');
		    assert(selectAll?.props.checked === true
		      && chooserElements.filter((element) => element.props?.['data-workspace-archive-choice']).every((element) => element.props.checked === true),
		    'the first Select all click checks every visible workspace');
		    selectAll?.props.onChange(false);
		    chooserTree = chooserHarness.render(chooserProps);
		    chooserElements = collectElements(chooserTree);
		    chooseConfirm = chooserElements.find((element) => element.props?.['data-workspace-archive-choose-confirm'] === '1');
		    assert(chooserElements.filter((element) => element.props?.['data-workspace-archive-choice']).every((element) => element.props.checked === false)
		      && chooseConfirm?.props.disabled === true,
		    'clicking Select all again clears every workspace and disables confirmation');
		    const singleChoice = chooserElements.find((element) => element.props?.['data-workspace-archive-choice'] === 'workspace-1');
		    singleChoice?.props.onChange(true);
		    chooserTree = chooserHarness.render(chooserProps);
		    chooserElements = collectElements(chooserTree);
		    chooseConfirm = chooserElements.find((element) => element.props?.['data-workspace-archive-choose-confirm'] === '1');
		    chooseConfirm?.props.onClick();
		    assert(chosenWorkspaces[0]?.length === 1 && chosenWorkspaces[0][0]?.id === 'workspace-1', 'workspace chooser submits a single selection only from the bottom-right confirmation');
		    chooserElements.find((element) => element.props?.['data-workspace-archive-select-all'] === '1')?.props.onChange(true);
		    chooserTree = chooserHarness.render(chooserProps);
		    chooserElements = collectElements(chooserTree);
		    chooserElements.find((element) => element.props?.['data-workspace-archive-choose-confirm'] === '1')?.props.onClick();
		    assert(chosenWorkspaces[1]?.map((workspace) => workspace.id).join(',') === 'workspace-1,workspace-2', 'workspace chooser Select all submits every visible eligible workspace');
		    chooserHarness.unmount();
		  }
	  const harness = createHookHarness(Dialog);
  const props = {
    t,
    workspaceId: 'workspace-1',
    workspaceTitle: 'Project One',
    onClose: () => { closed += 1; },
    onApplied: async () => { applied += 1; },
    restoreFocus: () => {},
  };
  harness.render(props);
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let tree = harness.render(props);
  let elements = collectElements(tree);
  const dialog = elements.find((element) => element.props?.role === 'dialog');
  assert(dialog?.props['aria-modal'] === 'true' && dialog?.props['aria-labelledby'], 'workspace bulk archive opens an accessible labelled modal dialog');
  const workspaceStyle = headChildren.find((child) => child.id === 'dsh-archived-chats-css')?.textContent ?? '';
  assert(workspaceStyle.includes('.dac-action-confirm,.dac-workspace-dialog{box-sizing:border-box;width:min(380px,calc(100vw - 48px))')
    && /\.dac-workspace-dialog \.dac-preview-head strong\{[^}]*font-size:16px;line-height:24px;font-weight:500/u.test(workspaceStyle)
    && /\.dac-workspace-copy\{[^}]*font-size:14px;line-height:22px/u.test(workspaceStyle),
  'workspace and other action confirmations share the official compact modal dimensions and typography');
	  assert(workspaceStyle.includes('.dac-checkbox{width:16px;height:16px;'), 'workspace and import checkboxes keep a stable named size');
	  assert(workspaceStyle.includes('.dac-workspace-choice-all{grid-template-columns:auto minmax(0,1fr);border:0;background:transparent'),
	    'workspace Select all stays visually unboxed');
	  assert(workspaceStyle.includes('.dac-workspace-choice-all:hover{background:transparent}')
	    && workspaceStyle.includes('.dac-workspace-choice-all:focus-within{outline:0}')
	    && workspaceStyle.includes('.dac-workspace-choice-all .dac-checkbox:focus-visible{outline:2px solid'),
	    'workspace Select all remains unboxed while its checkbox keeps a keyboard focus indicator');
	  assert(/\.dac-workspace-actions>button\{[^}]*height:36px;[^}]*font-size:14px;line-height:22px;padding:0 14px/u.test(workspaceStyle),
	    'confirmation actions match the official 36px outline buttons');
  assert(/\.dac-workspace-actions\{[^}]*justify-content:flex-end;flex-wrap:wrap;gap:8px/u.test(workspaceStyle)
    && !workspaceStyle.includes('@media (max-width:480px){.dac-workspace-dialog{'),
  'confirmation actions wrap on narrow screens without enlarging mobile typography');
  assert(requests.some((request) => request.path.endsWith('/workspace-archive/preview') && request.options.body === '{"workspaceId":"workspace-1"}'), 'workspace confirmation automatically prepares only the supplied workspace');
  assert(elementText(tree).includes('归档此工作区的全部会话？') && elementText(tree).includes('Project One'), 'workspace confirmation shows scope and supplied workspace title without a count');
  assert(elementText(tree).includes('这会将「Project One」中的会话归档。之后可在“已归档”中查看。')
    && !elementText(tree).includes('项目本身不会改变'), 'workspace confirmation names the destination without unrequested contrast copy');
  const globalTree = harness.render({ ...props, scope: 'all' });
  assert(elementText(globalTree).includes('归档全部会话？') && elementText(globalTree).includes('所有工作区中的会话')
    && !elementText(globalTree).includes('Project One'), 'global archive retains global copy even with one workspace');
  harness.render(props);
  const skippedLive = elements.find((element) => element.props?.['data-workspace-archive-skipped-live'] === '1');
  assert(elementText(skippedLive) === '将跳过 1 个仍在运行或状态未确认的会话。'
    && !elementText(tree).includes('session-live') && !elementText(tree).includes('session-archived'),
  'workspace confirmation summarizes only nonzero live skips without exposing ids or other reasons');
  assert(!elements.some((element) => element.type === 'select')
    && !elements.some((element) => element.props?.['data-workspace-archive-preview'] === '1')
    && !elements.some((element) => element.props?.['data-workspace-archive-confirm'] === '1'),
  'workspace confirmation contains no selector, preview list, or continue step');
  assert(!requests.some((request) => request.path.endsWith('/workspace-archive/apply')), 'workspace archive never applies before explicit confirmation');
  const firstFocus = { focus: () => { documentMock.activeElement = firstFocus; } };
  const lastFocus = { focus: () => { documentMock.activeElement = lastFocus; } };
  if (dialog?.props.ref) dialog.props.ref.current = { contains: (node) => node === firstFocus || node === lastFocus, querySelectorAll: () => [firstFocus, lastFocus] };
  documentMock.activeElement = lastFocus;
  let trapped = false;
  documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: () => { trapped = true; } });
  documentListeners.get('keydown')?.({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} });
  assert(trapped && documentMock.activeElement === firstFocus && closed === 1, 'workspace bulk archive traps Tab and contains Escape inside its dialog');
  assert(!elementText(tree).includes('Safe title') && !elementText(tree).includes('session-live'), 'automatic preparation keeps the preview list hidden');
  const applyButton = elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1');
  await applyButton?.props.onClick();
  tree = harness.render(props);
  assert(requests.some((request) => request.path.endsWith('/workspace-archive/apply') && request.options.body === '{"token":"token-1","nonce":"nonce-1"}'), 'workspace archive apply sends only preview token and nonce after confirmation');
  assert(applied === 1 && elementText(tree).includes('session-failed') && !elementText(tree).includes('历史快照未保存') && !elementText(tree).includes('archive-failed'), 'workspace archive retains localized final failed and snapshot results while refreshing consumers');
  const dictionaries = clientCalls.localeRegister.find((entry) => entry.ns === 'settings.archived-chats')?.dicts;
  assert(dictionaries?.zh?.['workspaceArchive.confirmTitle'] === '归档此工作区的全部会话？'
    && dictionaries?.en?.['workspaceArchive.confirmTitle'] === 'Archive all chats in this workspace?', 'workspace archive has matched direct-confirmation titles');
  assert(dictionaries?.zh?.['workspaceArchive.action'] === '归档会话'
    && dictionaries?.en?.['workspaceArchive.action'] === 'Archive chats', 'workspace archive has matched approved menu action labels');
  harness.unmount();

	  const multiPreviewBodies = [];
	  const multiApplyBodies = [];
	  let multiApplied = null;
	  let multiClosed = 0;
	  globalThis.fetch = async (url, options = {}) => {
	    const path = String(url);
	    if (path.endsWith('/workspace-archive/preview')) {
	      const workspaceId = JSON.parse(options.body).workspaceId;
	      multiPreviewBodies.push(workspaceId);
	      const sessions = workspaceId === 'workspace-empty' ? [] : workspaceId === 'workspace-2' ? [{ id: 'two-a' }, { id: 'two-b' }] : [{ id: 'one-a' }];
	      return { ok: true, status: 200, json: async () => ({ token: `${workspaceId}-token`, nonce: `${workspaceId}-nonce`, workspace: { id: workspaceId, title: workspaceId }, sessions, skipped: [] }) };
	    }
	    if (path.endsWith('/workspace-archive/apply')) {
	      const body = JSON.parse(options.body);
	      multiApplyBodies.push(body);
	      const id = body.token.replace('-token', '');
	      return { ok: true, status: 200, json: async () => ({ workspace: { id, title: id }, archived: [`${id}-archived`], skipped: [], failed: [], snapshots: [] }) };
	    }
	    return { ok: true, status: 200, json: async () => ({}) };
	  };
	  const multiHarness = createHookHarness(Dialog);
	  const multiProps = {
	    t,
	    workspaces: [
	      { id: 'workspace-1', title: 'Project One' },
	      { id: 'workspace-empty', title: 'Empty Project' },
	      { id: 'workspace-2', title: 'Project Two' },
	    ],
	    onClose: () => { multiClosed += 1; },
	    onApplied: async (result) => { multiApplied = result; },
	    onEmpty: () => {},
	    restoreFocus: () => {},
	  };
	  multiHarness.render(multiProps); multiHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
	  tree = multiHarness.render(multiProps); elements = collectElements(tree);
	  assert(multiPreviewBodies.join(',') === 'workspace-1,workspace-empty,workspace-2'
	    && elementText(tree).includes('归档所选工作区的会话？')
	    && !elementText(tree).includes(t('workspaceArchive.empty')),
	  'multi-workspace confirmation prepares every selection, sums nonempty previews, and omits the old empty popup');
	  await elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1')?.props.onClick();
	  assert(multiApplyBodies.map((body) => body.token).join(',') === 'workspace-1-token,workspace-2-token'
	    && multiApplied?.archived?.join(',') === 'workspace-1-archived,workspace-2-archived'
	    && multiClosed === 1,
	  'multi-workspace confirmation consumes each nonempty workspace credential and reports one aggregated success');
	  multiHarness.unmount();

	  const partialApplyBodies = [];
	  let partialApplied = null;
	  let partialClosed = 0;
	  globalThis.fetch = async (url, options = {}) => {
	    const path = String(url);
	    const body = JSON.parse(options.body ?? '{}');
	    if (path.endsWith('/workspace-archive/preview')) {
	      return { ok: true, status: 200, json: async () => ({
	        token: `${body.workspaceId}-token`,
	        nonce: `${body.workspaceId}-nonce`,
	        workspace: { id: body.workspaceId, title: body.workspaceId },
	        sessions: [{ id: `${body.workspaceId}-chat`, title: `${body.workspaceId} chat` }],
	        skipped: [],
	      }) };
	    }
	    if (path.endsWith('/workspace-archive/apply')) {
	      partialApplyBodies.push(body);
	      const id = body.token.replace('-token', '');
	      if (id === 'workspace-2') return { ok: false, status: 503, json: async () => ({ error: 'archive-failed' }) };
	      return { ok: true, status: 200, json: async () => ({ workspace: { id, title: id }, archived: [`${id}-archived`], skipped: [], failed: [], snapshots: [] }) };
	    }
	    return { ok: true, status: 200, json: async () => ({}) };
	  };
	  const partialHarness = createHookHarness(Dialog);
	  const partialProps = {
	    t,
	    workspaces: ['workspace-1', 'workspace-2', 'workspace-3'].map((id) => ({ id, title: id })),
	    onClose: () => { partialClosed += 1; },
	    onApplied: async (result) => { partialApplied = result; },
	    onEmpty: () => {},
	    restoreFocus: () => {},
	  };
	  partialHarness.render(partialProps); partialHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
	  tree = partialHarness.render(partialProps); elements = collectElements(tree);
	  await elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1')?.props.onClick();
	  tree = partialHarness.render(partialProps);
	  assert(partialApplyBodies.map((body) => body.token).join(',') === 'workspace-1-token,workspace-2-token,workspace-3-token'
	    && partialApplied?.archived?.join(',') === 'workspace-1-archived,workspace-3-archived'
	    && elementText(tree).includes('workspace-2 chat')
	    && elementText(tree).includes(t('workspaceArchive.reason.archive-failed'))
	    && partialClosed === 0,
	  'multi-workspace confirmation preserves earlier success, records a failed workspace, and continues after a thrown apply');
	  partialHarness.unmount();

  globalThis.fetch = async () => ({ ok: false, status: 501, json: async () => ({ error: 'workspace-archive-unsupported' }) });
  const legacyHarness = createHookHarness(Dialog);
  legacyHarness.render(props);
  legacyHarness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(elementText(legacyHarness.render(props)).includes('当前 DSH 版本不支持按项目批量归档。'), 'old Hosts show a clear workspace archive compatibility message');
  legacyHarness.unmount();
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11h2] client half — structured unarchive refusal preserves the archived row');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const archived = [{ id: 'cwdless', title: 'Cwd-less chat', createdAt: 10, workspaceId: null, workspaceTitle: null }];
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/state')) return { ok: true, status: 200, json: async () => ({ metadataStatus: 'ready', trashStatus: 'ready', sessions: archived }) };
    if (path.endsWith('/stats')) return { ok: true, status: 200, json: async () => ({ summary: { sessionCount: 1, totalBytes: 0, unavailableCount: 0 }, sessions: {} }) };
    if (path.endsWith('/unarchive-all')) return { ok: false, status: 409, json: async () => ({ error: 'session-main-list-unreachable', reason: 'cwd-missing', sessionIds: ['cwdless'] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const render = () => harness.render({ t, refreshSidebar: () => {} });
  render(); harness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  const before = collectElements(render());
  await before.find((element) => element.type === 'button' && elementText(element) === '取消归档')?.props.onClick();
  const after = collectElements(render());
  assert(after.some((element) => element.props?.className === 'dac-row' && elementText(element).includes('Cwd-less chat'))
    && after.some((element) => element.props?.role === 'alert' && elementText(element).includes('已归档副本仍保留')),
  'cwd-less unarchive refusal is localized, announced, and keeps the archived chat available');
  harness.unmount();
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11i] client half — workspace archive recovery and completed conflicts');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  let previewCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/workspace-archive/preview')) {
      previewCalls += 1;
      if (previewCalls === 1) return { ok: false, status: 503, json: async () => ({ error: 'preview-failed' }) };
      return { ok: true, status: 200, json: async () => ({ token: 'fresh-token', nonce: 'fresh-nonce', workspace: { id: 'recover', title: 'Recovered' }, sessions: [{ id: 'one' }, { id: 'two' }, { id: 'three' }], skipped: [] }) };
    }
    if (path.endsWith('/workspace-archive/apply')) return { ok: false, status: 409, json: async () => ({ workspace: { id: 'recover', title: 'Recovered' }, archived: [], skipped: [{ id: 'late-live', reason: 'session-live' }], failed: [{ id: 'failed', reason: 'archive-failed' }], snapshots: [{ id: 'snapshot', status: 'snapshot-failed' }] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  let conflictResult = null;
  try { conflictResult = await clientExports.__test.applyWorkspaceArchive('token', 'nonce'); } catch { /* red: intentional 409 is currently treated as an error */ }
  assert(Array.isArray(conflictResult?.skipped) && Array.isArray(conflictResult?.failed) && Array.isArray(conflictResult?.snapshots), 'completed 409 workspace apply returns its safe final result');
  const Dialog = clientExports.__test.WorkspaceArchiveDialog;
  const harness = createHookHarness(Dialog);
  const props = { t, workspaceId: 'recover', workspaceTitle: 'Recovered', onClose: () => {}, onApplied: async () => {}, restoreFocus: () => {} };
  harness.render(props); harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let tree = harness.render(props);
  let retry = collectElements(tree).find((element) => element.props?.['data-workspace-archive-retry'] === '1');
  retry?.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = harness.render(props);
  assert(previewCalls === 2 && elementText(tree).includes('归档此工作区的全部会话？'), 'workspace Retry obtains a fresh preparation for the same workspace');
  harness.unmount();
  let completedCalls = 0;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/workspaces')) return { ok: true, status: 200, json: async () => ({ workspaces: [{ id: 'A', title: 'A workspace', eligibleCount: 1, liveCount: 0 }, { id: 'B', title: 'B workspace', eligibleCount: 1, liveCount: 0 }] }) };
    if (path.endsWith('/preview')) return { ok: true, status: 200, json: async () => ({ token: 'A-token', nonce: 'A-nonce', workspace: { id: 'A', title: 'A workspace' }, sessions: [{ id: 'a', title: null }], skipped: [] }) };
    if (path.endsWith('/apply')) return { ok: false, status: 409, json: async () => ({ workspace: { id: 'A', title: 'A workspace' }, archived: [], skipped: [{ id: 'live', reason: 'session-live' }], failed: [{ id: 'failed', reason: 'archive-failed' }], snapshots: [{ id: 'saved', status: 'captured' }, { id: 'snapshot', status: 'snapshot-failed' }] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const completedHarness = createHookHarness(Dialog);
  const completedProps = { ...props, workspaceId: 'A', workspaceTitle: 'A workspace', onApplied: async () => { completedCalls += 1; } };
  completedHarness.render(completedProps); completedHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  tree = completedHarness.render(completedProps); let elements = collectElements(tree);
  await elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1')?.props.onClick();
  tree = completedHarness.render(completedProps);
  assert(completedCalls === 0 && elementText(tree).includes('仍在运行或状态未确认，已跳过') && elementText(tree).includes('归档失败') && !elementText(tree).includes('历史快照未保存') && !elementText(tree).includes('captured'), 'completed 409 renders localized skipped, failed, and snapshot-failed results without refreshing');
  completedHarness.unmount();
  let resolvePreviewA;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/preview')) {
      const target = JSON.parse(options.body).workspaceId;
      if (target === 'A') return new Promise((resolve) => { resolvePreviewA = () => resolve({ ok: true, status: 200, json: async () => ({ token: 'A-token', nonce: 'A-nonce', workspace: { id: 'A', title: 'A workspace' }, sessions: [{ id: 'a' }], skipped: [] }) }); });
      return { ok: true, status: 200, json: async () => ({ token: 'B-token', nonce: 'B-nonce', workspace: { id: 'B', title: 'B workspace' }, sessions: [{ id: 'b' }], skipped: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const staleHarness = createHookHarness(Dialog);
  const propsA = { ...props, workspaceId: 'A', workspaceTitle: 'A workspace' };
  const propsB = { ...props, workspaceId: 'B', workspaceTitle: 'B workspace' };
  staleHarness.render(propsA); staleHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  staleHarness.render(propsB); staleHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  resolvePreviewA?.(); await new Promise((resolve) => setTimeout(resolve, 0));
  tree = staleHarness.render(propsB); elements = collectElements(tree);
  assert(elementText(tree).includes('B workspace') && !elementText(tree).includes('A workspace'), 'a stale preparation cannot overwrite a newer workspace target');
  staleHarness.unmount();

  let cancelledWhilePreparing = 0;
  let preparingApplyCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/preview')) return new Promise(() => {});
    if (String(url).endsWith('/apply')) preparingApplyCalls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const preparingHarness = createHookHarness(Dialog);
  const preparingProps = { ...props, onClose: () => { cancelledWhilePreparing += 1; } };
  preparingHarness.render(preparingProps); preparingHarness.flushEffects();
  tree = preparingHarness.render(preparingProps); elements = collectElements(tree);
  const preparingApply = elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1');
  elements.find((element) => element.props?.['data-workspace-archive-cancel'] === '1')?.props.onClick();
  assert(preparingApply?.props.disabled === true && cancelledWhilePreparing === 1 && preparingApplyCalls === 0, 'preparation keeps apply disabled while allowing cancellation without mutation');
  preparingHarness.unmount();

  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => String(url).endsWith('/preview')
      ? { token: 'empty-token', nonce: 'empty-nonce', workspace: { id: 'empty', title: 'Empty workspace' }, sessions: [], skipped: [] }
      : {},
  });
  let emptyReturns = 0;
  let emptyRestoreFocuses = 0;
  const emptyHarness = createHookHarness(Dialog);
  const emptyProps = { ...props, workspaceId: 'empty', workspaceTitle: 'Empty workspace', onEmpty: () => { emptyReturns += 1; }, restoreFocus: () => { emptyRestoreFocuses += 1; } };
  emptyHarness.render(emptyProps); emptyHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  tree = emptyHarness.render(emptyProps); elements = collectElements(tree);
  assert(emptyReturns === 1
    && !elementText(tree).includes(t('workspaceArchive.empty'))
    && elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1')?.props.disabled === true
    && !elements.some((element) => element.props?.['data-workspace-archive-skipped-live'] === '1'),
  'an empty preparation returns to the chooser without rendering the obsolete empty popup');
  emptyHarness.unmount();
	  assert(emptyRestoreFocuses === 0, 'returning an empty preparation to the chooser preserves the original settings trigger for the chooser to restore later');

  let doubleApplyCalls = 0;
  let releaseApply;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/preview')) return { ok: true, status: 200, json: async () => ({ token: 'once-token', nonce: 'once-nonce', workspace: { id: 'once', title: 'Once' }, sessions: [{ id: 'one' }], skipped: [] }) };
    if (path.endsWith('/apply')) {
      doubleApplyCalls += 1;
      return new Promise((resolve) => { releaseApply = () => resolve({ ok: true, status: 200, json: async () => ({ workspace: { id: 'once', title: 'Once' }, archived: [], skipped: [], failed: [], snapshots: [] }) }); });
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const doubleHarness = createHookHarness(Dialog);
  const doubleProps = { ...props, workspaceId: 'once', workspaceTitle: 'Once' };
  doubleHarness.render(doubleProps); doubleHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  tree = doubleHarness.render(doubleProps); elements = collectElements(tree);
  const applyOnce = elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1');
  const firstApply = applyOnce.props.onClick();
  const secondApply = applyOnce.props.onClick();
  assert(doubleApplyCalls === 1, 'workspace confirmation blocks duplicate apply synchronously');
  releaseApply(); await Promise.all([firstApply, secondApply]);
  doubleHarness.unmount();

  let uncertainPreviewCalls = 0;
  const uncertainBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/preview')) {
      uncertainPreviewCalls += 1;
      return { ok: true, status: 200, json: async () => ({ token: `token-${uncertainPreviewCalls}`, nonce: `nonce-${uncertainPreviewCalls}`, workspace: { id: 'uncertain', title: 'Uncertain' }, sessions: [{ id: 'one' }], skipped: [] }) };
    }
    if (path.endsWith('/apply')) {
      uncertainBodies.push(options.body);
      return uncertainBodies.length === 1
        ? { ok: false, status: 503, json: async () => ({ error: 'uncertain' }) }
        : { ok: true, status: 200, json: async () => ({ workspace: { id: 'uncertain', title: 'Uncertain' }, archived: ['one'], skipped: [], failed: [], snapshots: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const uncertainHarness = createHookHarness(Dialog);
  const uncertainProps = { ...props, workspaceId: 'uncertain', workspaceTitle: 'Uncertain' };
  uncertainHarness.render(uncertainProps); uncertainHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  tree = uncertainHarness.render(uncertainProps); elements = collectElements(tree);
  await elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1')?.props.onClick();
  tree = uncertainHarness.render(uncertainProps); elements = collectElements(tree);
  assert(elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1')?.props.disabled === true
    && elements.some((element) => element.props?.['data-workspace-archive-retry'] === '1'),
  'an uncertain apply failure invalidates confirmation and requires fresh preparation');
  elements.find((element) => element.props?.['data-workspace-archive-retry'] === '1')?.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = uncertainHarness.render(uncertainProps); elements = collectElements(tree);
  await elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1')?.props.onClick();
  assert(uncertainPreviewCalls === 2
    && uncertainBodies[0] === '{"token":"token-1","nonce":"nonce-1"}'
    && uncertainBodies[1] === '{"token":"token-2","nonce":"nonce-2"}',
  'retry applies only a newly prepared token and nonce after another explicit confirmation');
  uncertainHarness.unmount();
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11j] client half — workspace archive final coverage');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const dictionaries = clientCalls.localeRegister.find((entry) => entry.ns === 'settings.archived-chats')?.dicts;
  const stableResultKeys = [
    'workspaceArchive.reason.session-live',
    'workspaceArchive.reason.session-archived',
    'workspaceArchive.reason.session-workspace-changed',
    'workspaceArchive.reason.archive-failed',
    'workspaceArchive.reason.archive-uncommitted',
    'workspaceArchive.reason.lifecycle-failed',
    'workspaceArchive.reason.unknown',
  ];
  for (const key of stableResultKeys) {
    assert(typeof dictionaries?.zh?.[key] === 'string' && dictionaries.zh[key].length > 0
      && typeof dictionaries?.en?.[key] === 'string' && dictionaries.en[key].length > 0,
    `workspace archive localizes stable service result ${key} in Chinese and English`);
  }
  const t = clientCtx.locale.bind('settings.archived-chats');
  const Dialog = clientExports.__test.WorkspaceArchiveDialog;
  const renderFinalResult = async (applyResult, overrides = {}) => {
    globalThis.fetch = async (url) => {
      const path = String(url);
      if (path.endsWith('/workspace-archive/preview')) return { ok: true, status: 200, json: async () => ({ token: 'final-token', nonce: 'final-nonce', workspace: { id: 'ws-final', title: 'Final workspace' }, sessions: [{ id: 'candidate' }], skipped: [] }) };
      if (path.endsWith('/workspace-archive/apply')) return { ok: applyResult.status !== 409, status: applyResult.status ?? 200, json: async () => applyResult };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const harness = createHookHarness(overrides.Dialog ?? Dialog);
    const props = { t, workspaceId: 'ws-final', workspaceTitle: 'Final workspace', onClose: overrides.onClose ?? (() => {}), onApplied: overrides.onApplied ?? (async () => {}), restoreFocus: () => {} };
    harness.render(props); harness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
    let tree = harness.render(props); let elements = collectElements(tree);
    await elements.find((element) => element.props?.['data-workspace-archive-apply'] === '1')?.props.onClick();
    tree = harness.render(props);
    return { harness, tree };
  };
  const happy = await renderFinalResult({
    workspace: { id: 'ws-final', title: 'Final workspace' }, archived: ['archived-id'],
    skipped: [{ id: 'skipped-id', reason: 'session-archived' }],
    failed: [{ id: 'failed-id', reason: 'archive-uncommitted' }],
    snapshots: [{ id: 'saved', status: 'captured' }, { id: 'snapshot-failed-id', status: 'snapshot-failed' }],
  });
  const happyGroups = collectElements(happy.tree).filter((element) => element.props?.className === 'dac-workspace-result-group');
  const groupText = (heading) => elementText(happyGroups.find((group) => elementText(group.props?.children?.[0]) === heading));
  assert(groupText(t('workspaceArchive.archived')).includes('archived-id')
    && groupText(t('workspaceArchive.skipped')).includes('skipped-id')
    && groupText(t('workspaceArchive.skipped')).includes(t('workspaceArchive.reason.session-archived'))
    && groupText(t('workspaceArchive.failed')).includes('failed-id')
    && groupText(t('workspaceArchive.failed')).includes(t('workspaceArchive.reason.archive-uncommitted')),
  'happy workspace result renders archived, skipped, and failed headings with ids and localized explanations');
  assert(!elementText(happy.tree).includes('snapshot-failed-id'), 'workspace results ignore obsolete history capture statuses');
  happy.harness.unmount();
  const partial = await renderFinalResult({
    workspace: { id: 'ws-final', title: 'Final workspace' }, archived: ['moved-id'],
    skipped: [{ id: 'already-archived', reason: 'session-archived' }], failed: [],
    snapshots: [{ id: 'moved-id', status: 'captured' }],
  });
  const partialGroupHeadings = collectElements(partial.tree)
    .filter((element) => element.props?.className === 'dac-workspace-result-group')
    .map((group) => elementText(group.props?.children?.[0]));
  assert(partialGroupHeadings.join('|') === `${t('workspaceArchive.archived')}|${t('workspaceArchive.skipped')}`,
    'partial workspace result omits empty failure and snapshot-warning groups');
  partial.harness.unmount();
  const completed = await renderFinalResult({
    status: 409, workspace: { id: 'ws-final', title: 'Final workspace' }, archived: [],
    skipped: [{ id: 'completed-skipped', reason: 'session-live' }],
    failed: [{ id: 'completed-failed', reason: 'lifecycle-failed' }],
    snapshots: [{ id: 'completed-snapshot-failed', status: 'snapshot-failed' }],
  });
  const completedText = elementText(completed.tree);
  assert(completedText.includes(t('workspaceArchive.skipped')) && completedText.includes('completed-skipped') && completedText.includes(t('workspaceArchive.reason.session-live'))
    && completedText.includes(t('workspaceArchive.failed')) && completedText.includes('completed-failed') && completedText.includes(t('workspaceArchive.reason.lifecycle-failed'))
    && !completedText.includes('completed-snapshot-failed'),
  'completed 409 final result renders every localized result group and row');
  completed.harness.unmount();

  let fullSuccessRefreshes = 0;
  let fullSuccessCloses = 0;
  const fullSuccess = await renderFinalResult({
    workspace: { id: 'ws-final', title: 'Final workspace' }, archived: ['archived-id'], skipped: [], failed: [],
    snapshots: [{ id: 'archived-id', status: 'captured' }],
  }, {
    onApplied: async () => { fullSuccessRefreshes += 1; throw new Error('consumer refresh failed'); },
    onClose: () => { fullSuccessCloses += 1; },
  });
  assert(fullSuccessRefreshes === 1 && fullSuccessCloses === 1
    && !collectElements(fullSuccess.tree).some((element) => element.props?.['data-workspace-archive-result'] === '1'),
  'full workspace success closes after refresh even when a consumer refresh rejects');
  fullSuccess.harness.unmount();
  const legacyClient = loadedModule.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives'
    ? { ...moduleTable[name], Toast: undefined } : moduleTable[name]);
  let legacyCloses = 0;
  const legacySuccess = await renderFinalResult({ archived: ['legacy-archived'], skipped: [], failed: [], snapshots: [] }, {
    Dialog: legacyClient.__test.WorkspaceArchiveDialog,
    onClose: () => { legacyCloses += 1; },
  });
  assert(legacyCloses === 0 && elementText(legacySuccess.tree).includes('legacy-archived')
    && collectElements(legacySuccess.tree).some(element => element.props?.['data-workspace-archive-result'] === '1'),
    'older Hosts without Toast keep the completed archive result readable');
  legacySuccess.harness.unmount();


  let closeCalls = 0;
  let restoredFocus = 0;
  const focusHarness = createHookHarness(Dialog);
  const focusProps = { t, workspaceId: 'focus', workspaceTitle: 'Focus workspace', onClose: () => { closeCalls += 1; }, onApplied: async () => {}, restoreFocus: () => { restoredFocus += 1; } };
  const focusTree = focusHarness.render(focusProps);
  const focusElements = collectElements(focusTree);
  const focusDialog = focusElements.find((element) => element.props?.role === 'dialog');
  const cancelButton = focusElements.find((element) => element.props?.['data-workspace-archive-cancel'] === '1');
  const first = { focus: () => { documentMock.activeElement = first; } };
  const last = { focus: () => { documentMock.activeElement = last; } };
  focusDialog.props.ref.current = { contains: (node) => node === first || node === last, querySelectorAll: () => [first, last], focus: () => {} };
  cancelButton.props.ref.current = first;
  focusHarness.flushEffects();
  assert(documentMock.activeElement === first, 'workspace archive dialog gives its cancel control initial focus');
  let reverseTrapped = false;
  documentMock.activeElement = first;
  documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: true, preventDefault: () => { reverseTrapped = true; } });
  let forwardTrapped = false;
  documentMock.activeElement = last;
  documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: () => { forwardTrapped = true; } });
  documentListeners.get('keydown')?.({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} });
  assert(reverseTrapped && forwardTrapped && documentMock.activeElement === first && closeCalls === 1, 'workspace archive dialog wraps reverse and forward Tab and closes on Escape');
  focusHarness.unmount();
  assert(restoredFocus === 1, 'workspace archive dialog restores the captured settings trigger on unmount');

  const savedWorkspaceRefresh = clientServices.workspaces.refresh;
  const savedSidebarRefresh = clientServices.sessions.refresh;
  let sidebarAttempts = 0;
  let workspaceRefreshes = 0;
  let stateRequests = 0;
  let rejectStateRefresh = false;
  clientServices.sessions.refresh = () => { sidebarAttempts += 1; throw new Error('sidebar refresh rejected'); };
  clientServices.workspaces.refresh = async () => { workspaceRefreshes += 1; };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/state')) {
      stateRequests += 1;
      if (rejectStateRefresh) throw new Error('state refresh rejected');
      return { ok: true, status: 200, json: async () => ({ metadataStatus: 'ready', sessions: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const settingsRegistration = clientCalls.slotRegister.find((entry) => entry.meta?.name === 'settings.section');
  const pageHarness = createHookHarness(settingsRegistration.component);
  const pageProps = { t, ...settingsRegistration.meta.inject() };
  let pageTree = pageHarness.render(pageProps); pageHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  let pageElements = collectElements(pageHarness.render(pageProps));
  let restoredSettingsFocus = 0;
  assert(!pageElements.some(element => element.type === 'button' && elementText(element) === t('workspaceArchive.settingsAction')), 'settings removes the standalone bulk archive trigger');
  const unarchivedRows = [
    { id: 'chosen-a', title: 'First chat', createdAt: 10, updatedAt: 60, workspaceId: 'workspace-settings', workspaceTitle: 'Settings Project', busy: false },
    { id: 'other-a', title: 'Other chat', createdAt: 20, updatedAt: 50, workspaceId: 'workspace-settings', workspaceTitle: 'Settings Project', busy: false },
    { id: 'chosen-b', title: 'Second chat', createdAt: 30, updatedAt: 30, workspaceId: 'workspace-two', workspaceTitle: 'Second Project', busy: false },
    { id: 'live-a', title: 'Running chat', createdAt: 40, updatedAt: 40, workspaceId: 'workspace-two', workspaceTitle: 'Second Project', busy: true },
  ];
  const previousFetch = globalThis.fetch;
  const unarchivedPreviewRequests = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/unarchived')) return { ok: true, status: 200, json: async () => ({ sessions: unarchivedRows }) };
    if (String(url).endsWith('/preview')) {
      const body = JSON.parse(options.body);
      unarchivedPreviewRequests.push(body);
      return { ok: true, status: 200, json: async () => ({ session: unarchivedRows.find(row => row.id === body.sessionId), messages: [], total: 0, nextOffset: null }) };
    }
    return previousFetch(url, options);
  };
  pageElements.find(el => el.props?.id === 'dac-tab-unarchived').props.onClick();
  pageHarness.render(pageProps); pageHarness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  pageTree = pageHarness.render(pageProps);
  pageElements = collectElements(pageTree);
  assert(elementText(pageTree).includes('First chat') && elementText(pageTree).includes('Running chat'), 'Unarchived lists regular and live workspace conversations');
  const unarchivedSortedGroups = pageElements.filter(el => el.type?.name === 'GroupSection').map(el => el.props.group);
  assert(unarchivedSortedGroups.map(group => group.key).join(',') === 'workspace-settings,workspace-two'
    && unarchivedSortedGroups[0]?.items.map(row => row.id).join(',') === 'chosen-a,other-a',
    'unarchived orders workspaces and chats by the same recent activity rule');
  const unarchivedPanel = pageElements.find(el => el.props?.id === 'dac-panel-unarchived');
  const panelChildren = unarchivedPanel.props.children.filter(Boolean);
  const unarchivedQueryBar = panelChildren[0];
  assert(unarchivedQueryBar?.props.className === 'dac-querybar-stacked'
    && unarchivedQueryBar.props.children[0]?.props.className === 'dac-search'
    && unarchivedQueryBar.props.children[1]?.props.className === 'dac-filters', 'Unarchived search stays above filters in a two-row toolbar');
  const headerActions = pageElements.find(el => el.props?.className === 'dac-head-actions');
  const refreshButton = collectElements(headerActions).find(el => el.type === 'button' && elementText(el) === t('action.refresh'));
  assert(refreshButton && !refreshButton.props.disabled, 'refresh is an enabled text button in the top-right header');
  assert(!collectElements(unarchivedQueryBar.props.children[1]).some(el => el.type === 'button' && (elementText(el) === t('action.refresh') || el.props['aria-label'] === t('action.refresh'))), 'filters do not duplicate the refresh control');
  await refreshButton.props.onClick();
  assert(elementText(pageHarness.render(pageProps)).includes('First chat'), 'header refresh reloads the unarchived list');
  assert(!pageElements.some(el => el.type?.name === 'SelectionCheckbox') && !elementText(unarchivedPanel).includes('导出选中项') && !elementText(unarchivedPanel).includes('可清理'), 'Unarchived only offers archiving, without selection, export, or cleanup');
  const workspaceFilter = pageElements.find(el => el.props.ariaLabel === t('filter.allProjects'));
  workspaceFilter.props.onChange('workspace-settings');
  pageElements.find(el => el.type === 'input' && el.props.type === 'search').props.onChange({ target: { value: 'First' } });
  pageTree = pageHarness.render(pageProps);
  pageElements = collectElements(pageTree);
  assert(!elementText(pageTree).includes('Other chat') && !elementText(pageTree).includes('Second chat'), 'search and workspace filters narrow only the displayed rows');
  const archiveAll = pageElements.find(el => el.type === 'button' && elementText(el) === '全部归档');
  archiveAll?.props.onClick({ currentTarget: { focus: () => { restoredSettingsFocus += 1; } } });
  pageTree = pageHarness.render(pageProps);
  const refreshDialog = findComponentElement(pageTree, 'WorkspaceArchiveDialog');
  assert(JSON.stringify(refreshDialog?.props.workspaces?.map(({ id, sessionIds }) => [id, sessionIds])) === JSON.stringify([['workspace-settings', null], ['workspace-two', null]]),
    'global archive includes all workspaces regardless of search or workspace filters');
  if (!refreshDialog) throw new Error('global archive confirmation missing');
  assert(refreshDialog.props.scope === 'all', 'header Archive all explicitly carries global scope');
  refreshDialog.props.onClose();
  pageTree = pageHarness.render(pageProps);
  const group = findComponentElement(pageTree, 'GroupSection');
  const groupHarness = createHookHarness(group.type);
  let groupTree = groupHarness.render({ ...group.props, menuOpen: true });
  let workspaceMenuFocus = 0;
  const workspaceTrigger = { focus: () => { workspaceMenuFocus += 1; } };
  collectElements(groupTree).find(el => el.props.className === 'dac-group-head').props.ref.current = { querySelector: () => workspaceTrigger };
  const groupMenuItems = collectElements(groupTree).filter(el => el.props?.role === 'menuitem');
  assert(groupMenuItems.length === 1 && elementText(groupMenuItems[0]) === '全部归档', 'Unarchived workspace menu only contains Archive all');
  groupMenuItems[0]?.props.onClick({ currentTarget: { focus() { throw new Error('unmounted menu item must not receive focus'); } } });
  let scopedDialog = findComponentElement(pageHarness.render(pageProps), 'WorkspaceArchiveDialog');
  assert(scopedDialog?.props.workspaces?.length === 1 && scopedDialog.props.workspaces[0].id === 'workspace-settings' && scopedDialog.props.workspaces[0].sessionIds === undefined, 'workspace archive covers the complete workspace even when search hides a chat');
  scopedDialog?.props.onClose();
  try { scopedDialog?.props.restoreFocus(); assert(workspaceMenuFocus === 2, 'cancelling workspace archive restores the stable three-dot trigger'); }
  catch { assert(false, 'cancelling workspace archive restores the stable three-dot trigger'); }
  const rowActions = collectElements(groupTree).find(el => el.props?.className === 'dac-row-actions');
  const rowButtons = collectElements(rowActions).filter(el => el.type === 'button');
  assert(rowButtons.length === 1 && elementText(rowButtons[0]) === '归档', 'Unarchived keeps only Archive in the row action area');
  const unarchivedTitle = collectElements(groupTree).find(el => el.type === 'button' && el.props?.['aria-label'] === '查看对话 First chat');
  assert(unarchivedTitle?.props.className === 'dac-row-title dac-row-open' && unarchivedTitle.props.title === undefined, 'Unarchived opens preview from the title just like Archived');
  await unarchivedTitle?.props.onClick();
  let openedPreview = findComponentElement(pageHarness.render(pageProps), 'PreviewDialog');
  assert(unarchivedPreviewRequests.length === 1 && unarchivedPreviewRequests[0].sessionId === 'chosen-a' && unarchivedPreviewRequests[0].scope === 'unarchived'
    && openedPreview?.props.preview.scope === 'unarchived' && openedPreview.props.preview.status === 'ready', 'Unarchived preview requests the correct scope and opens the shared read-only dialog');
  openedPreview?.props.onCancel();
  const rowArchive = rowButtons.find(el => elementText(el) === '归档');
  rowArchive?.props.onClick({ currentTarget: null });
  scopedDialog = findComponentElement(pageHarness.render(pageProps), 'WorkspaceArchiveDialog');
  assert(scopedDialog?.props.workspaces?.[0].sessionIds?.join(',') === 'chosen-a', 'single chat archive targets exactly that chat');
  scopedDialog?.props.onClose();
  groupTree = groupHarness.render({ ...group.props, group: { ...group.props.group, items: [unarchivedRows[3]], sessionIds: ['live-a'] }, menuOpen: false });
  assert(collectElements(groupTree).find(el => el.type === 'button' && elementText(el) === '归档')?.props.disabled !== true, 'running chats allow entering stop-and-archive confirmation');
  const runningPreview = collectElements(groupTree).find(el => el.type === 'button' && el.props['aria-label'] === '查看对话 Running chat');
  assert(runningPreview?.props.disabled !== true && runningPreview !== undefined, 'running chats still allow read-only preview');
  await runningPreview?.props.onClick();
  openedPreview = findComponentElement(pageHarness.render(pageProps), 'PreviewDialog');
  assert(unarchivedPreviewRequests.at(-1)?.sessionId === 'live-a' && openedPreview?.props.preview.session.id === 'live-a', 'running chat preview targets that conversation');
  openedPreview?.props.onCancel();

  groupHarness.unmount();
  archiveAll.props.onClick({ currentTarget: { focus: () => { restoredSettingsFocus += 1; } } });
  const findTab = (label) => pageElements.find((element) => element.type === 'button' && element.props?.role === 'tab' && elementText(element) === label);
  const archivedTab = findTab(t('tab.archived'));
  const insightsTab = findTab(t('tab.insights'));
  insightsTab?.props.onClick();
  pageTree = pageHarness.render(pageProps);
  const insightsBefore = findComponentElement(pageTree, 'StorageRetentionPanel')?.props.key;
  rejectStateRefresh = true;
  await refreshDialog.props.onApplied();
  pageHarness.render(pageProps); pageHarness.flushEffects(); await new Promise((resolve) => setTimeout(resolve, 0));
  insightsTab?.props.onClick();
  pageTree = pageHarness.render(pageProps);
  const insightsAfter = findComponentElement(pageTree, 'StorageRetentionPanel')?.props.key;
  assert(stateRequests >= 2 && sidebarAttempts === 1 && workspaceRefreshes === 1
    && insightsTab === undefined && insightsBefore === undefined && insightsAfter === undefined,
  'workspace apply refreshes independent consumers despite failures without mounting retired Storage');
  const dialogHarness = createHookHarness(Dialog);
  dialogHarness.render(refreshDialog.props);
  dialogHarness.flushEffects();
  dialogHarness.unmount();
  assert(restoredSettingsFocus === 1, 'closing the settings-owned dialog restores the settings trigger exactly once');
  pageHarness.unmount();
  clientServices.sessions.refresh = savedSidebarRefresh;
  clientServices.workspaces.refresh = savedWorkspaceRefresh;
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11k] client half — confirmed archive success feedback');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  const registration = clientCalls.slotRegister.find(entry => entry.meta?.name === 'settings.section');
  for (const outcome of [
    { archived: ['one'], skipped: [], failed: [] },
    { archived: ['one', 'two'], skipped: [], failed: [] },
    { archived: ['one'], skipped: [{ id: 'two', reason: 'session-live' }], failed: [] },
    { archived: ['one'], skipped: [], failed: [{ id: 'two', reason: 'archive-failed' }] },
    { archived: [], skipped: [], failed: [{ id: 'one', reason: 'archive-failed' }] },
    { error: 'workspace-archive-unavailable' },
  ]) {
    let finishApply;
    globalThis.fetch = async url => {
      const path = String(url);
      const body = path.endsWith('/workspace-archive/preview')
        ? { token: 'notice-token', nonce: 'notice-nonce', sessions: [{ id: 'one' }, { id: 'two' }], skipped: [] }
        : path.endsWith('/unarchived') ? { sessions: [{ id: 'one', workspaceId: 'notice-workspace', title: 'Notice chat' }] }
        : { sessions: [], metadataStatus: 'ready', trashStatus: 'ready' };
      if (path.endsWith('/workspace-archive/apply')) return new Promise(resolve => {
        finishApply = () => resolve({ ok: !outcome.error, status: outcome.error ? 500 : 200, json: async () => outcome });
      });
      return { ok: true, status: 200, json: async () => body };
    };
    const page = createHookHarness(registration.component);
    const props = { t, refreshWorkspaceArchiveConsumers: async () => {} };
    const render = () => page.render(props);
    render(); page.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    collectElements(render()).find(el => el.props?.id === 'dac-tab-unarchived').props.onClick();
    render(); page.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    collectElements(render()).find(el => el.type === 'button' && elementText(el) === '全部归档').props.onClick({ currentTarget: null });
    const dialogProps = findComponentElement(render(), 'WorkspaceArchiveDialog').props;
    const dialog = createHookHarness(clientExports.__test.WorkspaceArchiveDialog);
    dialog.render(dialogProps); dialog.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    const applying = collectElements(dialog.render(dialogProps)).find(el => el.props?.['data-workspace-archive-apply'] === '1').props.onClick();
    assert(findComponentElement(render(), 'NoticeBanner')?.props.notice === null, 'archive feedback waits for the server result');
    finishApply(); await applying;
    const tree = render();
    const banner = findComponentElement(tree, 'NoticeBanner');
    const fullSuccess = outcome.archived?.length > 0 && outcome.skipped.length === 0 && outcome.failed.length === 0;
    if (fullSuccess) {
      assert(!findComponentElement(tree, 'WorkspaceArchiveDialog')
        && banner?.props.notice?.kind === 'ok'
        && banner.props.notice.text === `归档成功，已归档 ${outcome.archived.length} 个会话`
        && banner.props.notice.action === 'view-archived', 'confirmed archive closes the dialog and shows one success notice with the actual archived count');
      banner?.props.onViewArchived();
      assert(collectElements(render()).some(el => el.props?.id === 'dac-panel-archived')
        && findComponentElement(render(), 'NoticeBanner')?.props.notice === null, 'archive success View Archived switches to the archive list and dismisses feedback');
    } else {
      assert(banner?.props.notice === null && findComponentElement(tree, 'WorkspaceArchiveDialog'), 'partial or failed archive retains its detailed dialog without a false full-success toast');
    }
    dialog.unmount(); page.unmount();
  }
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11l] native archive feedback ownership');
{
  assert(clientServices.workspaces.archiveSession === originalWorkspaceArchiveMethod,
    'plugin leaves the official archive method untouched');
  assert(!clientCalls.slotRegister.some(entry => entry.meta?.name === 'shell.overlay'),
    'plugin does not register a duplicate archive-success overlay');
  const native = clientExports.__test.NativeArchiveNotice;
  assert(typeof native === 'function', 'plugin archive feedback resolves the native Toast adapter');
  if (native) {
    let viewed = 0;
    let dismissed = 0;
    const tree = native({ t: key => key, notice: { text: 'Archive complete', sequence: 1 }, onViewArchived: () => { viewed += 1; }, onDismiss: () => { dismissed += 1; } });
    assert(tree.type === ToastStub && tree.props.text === 'Archive complete' && tree.props.tone === 'success' && tree.props.holdMs === 6000,
      'plugin archive renders the official Toast component with the official action hold');
    tree.props.actions[0].onClick(); tree.props.onDone();
    assert(viewed === 1 && dismissed === 1, 'native archive feedback preserves View Archived and expiry actions');
    const newer = native({ t: key => key, notice: { text: 'Archive complete', sequence: 2 }, onViewArchived: () => {}, onDismiss: () => {} });
    assert(newer.props.key !== tree.props.key, 'successive identical archive results remount the native toast');
  }
}

console.log('\n[12] client half — sidebar refresh inject face');
{
  const meta = clientCalls.slotRegister[0].meta;
  assert(typeof meta.inject === 'function', 'section registration carries an inject face');
  const face = meta.inject();
  assert(typeof face.refreshSidebar === 'function', 'inject face exposes refreshSidebar');
  face.refreshSidebar();
  assert(clientCalls.sidebarRefresh === 1, 'refreshSidebar re-baselines the sidebar session list');
  clientServices.sessions = undefined;
  face.refreshSidebar();
  assert(clientCalls.sidebarRefresh === 1, 'missing sessions service degrades without throwing');
  clientServices.sessions = { refresh: () => { clientCalls.sidebarRefresh += 1; return Promise.resolve(); } };
}

console.log('\n[13] client half — settings nav icon patch');
{
  assert(observers.length === 1, `one MutationObserver installed (got ${observers.length})`);
  assert(observers[0].opts?.subtree === true && observers[0].opts?.childList === true, 'observer watches the body subtree');
  const gearSvg = { dataset: {}, attrs: { width: '16', height: '16' }, innerHTML: '<circle cx="12" cy="12" r="3"/>', setAttribute(k, v) { this.attrs[k] = v; } };
  const otherSvg = { dataset: {}, attrs: {}, innerHTML: '<circle cx="12" cy="12" r="3"/>', setAttribute(k, v) { this.attrs[k] = v; } };
  const ownButton = { textContent: '归档管理', querySelector: (sel) => (sel === 'svg' ? gearSvg : null) };
  const otherButton = { textContent: '通用', querySelector: (sel) => (sel === 'svg' ? otherSvg : null) };
  const englishSvg = { dataset: {}, attrs: {}, innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; } };
  const englishButton = { textContent: 'Archive Management', querySelector: (sel) => (sel === 'svg' ? englishSvg : null) };
  mockDialogs = [{ querySelectorAll: (sel) => (sel === 'nav button' ? [ownButton, englishButton, otherButton] : []) }];
  observers[0].cb();
  assert(gearSvg.dataset.dacPatched === '1', 'our nav button icon marked as patched');
  assert(englishSvg.dataset.dacPatched === '1' && englishSvg.innerHTML === gearSvg.innerHTML,
    'the renamed English settings entry receives the same archive icon as the Chinese entry');
  assert(gearSvg.attrs.viewBox === '0 0 24 24', 'archive icon viewBox applied');
  assert(gearSvg.attrs.width === '16' && gearSvg.attrs.height === '16'
    && gearSvg.attrs['stroke-width'] === '2' && gearSvg.attrs.stroke === 'currentColor',
  'archive nav glyph preserves host dimensions and color with legible small-size strokes');
  assert(gearSvg.innerHTML.includes('<rect'), `archive-box paths injected (got ${gearSvg.innerHTML.slice(0, 40)}…)`);
  assert(otherSvg.dataset.dacPatched === undefined, 'other sections keep their own icon');
  observers[0].cb();
  assert(gearSvg.innerHTML.includes('<rect'), 're-patching is idempotent');
  mockDialogs = [];
}

console.log('\n[13b] client half — nav icon patch degrades safely on an unknown host DOM');
{
  let defensiveModule = null;
  const hostileWindow = {
    ...windowMock,
    __ModuleLoader__: { load: (def) => { defensiveModule = def; } },
    MutationObserver: class {
      observe() { throw new Error('observer rejected host root'); }
      disconnect() {}
    },
  };
  const hostileDocument = {
    ...documentMock,
    body: {},
    querySelectorAll: () => { throw new Error('host settings DOM changed'); },
  };
  const fn = new Function('window', 'document', 'require', clientSource);
  fn(hostileWindow, hostileDocument, (name) => moduleTable[name]);
  const defensiveExports = defensiveModule?.factory((name) => moduleTable[name]);
  let threw = false;
  try {
    defensiveExports.apply({
      ...clientCtx,
      slots: { inject: (_name, register) => register(), register: () => () => {} },
    });
  } catch {
    threw = true;
  }
  assert(!threw, 'host DOM or observer changes cannot prevent the plugin section from loading');
}

console.log('\n[13c] client half — locale tables stay complete and unambiguous');
{
  const zhStart = clientSource.indexOf('"locale.intl": "zh-CN"');
  const enStart = clientSource.indexOf('"locale.intl": "en-US"');
  const regionEnd = clientSource.indexOf('//#endregion', enStart);
  assert(zhStart > 0 && enStart > zhStart && regionEnd > enStart, 'both locale tables are present');
  const keysOf = (block) => [...block.matchAll(/^\s*"([a-zA-Z0-9_.-]+)":/gm)].map((match) => match[1]);
  const tables = {
    zh: keysOf(clientSource.slice(zhStart, enStart)),
    en: keysOf(clientSource.slice(enStart, regionEnd)),
  };
  for (const [language, keys] of Object.entries(tables)) {
    // A repeated key silently takes its LAST value, so a new string can be
    // shadowed by an unrelated older one and the UI shows the wrong text.
    const seen = new Set();
    const duplicates = keys.filter((key) => seen.has(key) || (seen.add(key), false));
    assert(duplicates.length === 0, `${language} locale defines every key once (duplicates: ${duplicates.join(', ') || 'none'})`);
  }
  const zhKeys = new Set(tables.zh);
  const enKeys = new Set(tables.en);
  const missingEn = [...zhKeys].filter((key) => !enKeys.has(key));
  const missingZh = [...enKeys].filter((key) => !zhKeys.has(key));
  assert(missingEn.length === 0, `every zh key has an en translation (missing: ${missingEn.join(', ') || 'none'})`);
  assert(missingZh.length === 0, `every en key has a zh translation (missing: ${missingZh.join(', ') || 'none'})`);
  const referenced = new Set([...clientSource.matchAll(/\bt\(\s*"([a-zA-Z0-9_.-]+)"/g)].map((match) => match[1]));
  const undefinedKeys = [...referenced].filter((key) => !zhKeys.has(key));
  assert(undefinedKeys.length === 0, `every literal t() key is defined (undefined: ${undefinedKeys.join(', ') || 'none'})`);
}

console.log('\n[13d] client half — every array-children element uses the static jsx runtime');
{
  // React validates keys for children it believes are a dynamic list. `jsxs` is
  // the runtime for a literal children array and skips that check; `jsx` with an
  // array makes React warn "Each child in a list should have a unique key" in the
  // browser console. The test harness's plain `{type, props}` factory cannot see
  // this, so the shape is checked statically instead.
  const QUOTES = new Set(['"', "'", '`']);
  const OPEN = new Set(['(', '[', '{']);
  const CLOSE = new Set([')', ']', '}']);
  const balancedArgs = (text, start) => {
    let index = start;
    let depth = 1;
    let quote = null;
    while (index < text.length && depth > 0) {
      const character = text[index];
      if (quote !== null) {
        if (character === '\\') index += 1;
        else if (character === quote) quote = null;
      } else if (QUOTES.has(character)) quote = character;
      else if (OPEN.has(character)) depth += 1;
      else if (CLOSE.has(character)) depth -= 1;
      index += 1;
    }
    return { args: text.slice(start, index - 1), end: index };
  };
  const childrenIsArray = (args) => {
    let depth = 0;
    let quote = null;
    for (let index = 0; index < args.length; index += 1) {
      const character = args[index];
      if (quote !== null) {
        if (character === '\\') index += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (QUOTES.has(character)) { quote = character; continue; }
      if (OPEN.has(character)) { depth += 1; continue; }
      if (CLOSE.has(character)) { depth -= 1; continue; }
      if (depth === 1 && args.startsWith('children:', index)) {
        return args.slice(index + 'children:'.length).replace(/^\s+/, '').startsWith('[');
      }
    }
    return false;
  };
  const needle = '(0, jsx.jsx)(';
  const offenders = [];
  let at = 0;
  while ((at = clientSource.indexOf(needle, at)) !== -1) {
    const { args, end } = balancedArgs(clientSource, at + needle.length);
    if (childrenIsArray(args)) {
      offenders.push(`line ${clientSource.slice(0, at).split('\n').length}: ${args.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
    at = end;
  }
  assert(offenders.length === 0, `array children always use jsxs (offenders: ${offenders.join(' | ') || 'none'})`);
}

console.log('\n[13e] client half — official Host slot compatibility and disposal');
{
  const cleanups = [];
  const registrations = [];
  const injectedSlots = [];
  const disposalCtx = {
    ...clientCtx,
    locale: {
      register: () => () => {},
      bind: () => clientCtx.locale.bind('settings.archived-chats'),
    },
    slots: {
      inject: (name, callback) => { injectedSlots.push(name); callback(); },
      register: (meta, component) => { registrations.push({ meta, component }); return () => {}; },
    },
    effect: (factory) => {
      const cleanup = factory();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };
  clientExports.apply(disposalCtx);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert(injectedSlots.join('|') === 'settings.section'
    && registrations.length === 1
    && registrations[0].meta?.name === 'settings.section',
  'the plugin only registers settings and leaves the official overlay alone');
  assert(registrations.every((entry) => entry.meta?.store === undefined)
    && !clientSource.includes('@deepseek-ai/dsh-client-store'),
  'settings-owned workspace archive state has no optional client-store dependency');

  const officialHostRegistrations = [];
  clientExports.apply({
    ...clientCtx,
    locale: disposalCtx.locale,
    slots: {
      inject: (_name, callback) => callback(),
      register: (meta, component) => { officialHostRegistrations.push({ meta, component }); return () => {}; },
    },
    effect: (factory) => { factory(); },
  });
  assert(officialHostRegistrations.map((entry) => entry.meta?.name).join('|') === 'settings.section',
  'an official Host without an unreleased workspace action slot preserves settings');
}

console.log('\n[14] host half — an unreadable recycle catalog fails mutations closed');
{
  const trashFile = join(testHome, 'plugin-data', 'archived-chats', 'trash.json');
  const before = existsSync(trashFile) ? readFileSync(trashFile, 'utf8') : null;
  const archivedBefore = [...workspaceState.archivedSessionIds];
  const target = archivedBefore[0];
  assert(typeof target === 'string', 'a visible archived session is available for the corruption check');
  writeFileSync(trashFile, '{"version":1,"records":{ TRUNCATED', 'utf8');

  const state = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(state.status === 200, `state stays readable while the recycle catalog is corrupt (got ${state.status})`);
  assert(state.json().trashStatus === 'unavailable', 'state reports the unreadable recycle catalog so the UI can warn');

  // An unreadable catalog cannot prove a session is NOT recycled. Unarchiving one
  // that is would resurrect it into the sidebar while its recycle record survives,
  // and the next purge would then delete a chat the user had put back in service.
  const unarchive = await call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: target }),
  ));
  assert(unarchive.status === 503 && unarchive.json().error === 'trash-store-unavailable',
    `single unarchive fails closed on an unreadable recycle catalog (got ${unarchive.status})`);
  const metadata = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: target, tags: ['nope'], note: '' }),
  ));
  assert(metadata.status === 503, `metadata save fails closed on an unreadable recycle catalog (got ${metadata.status})`);
  const batch = await call(routes, '/plugins/dsh-archived-chats/unarchive-all', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [target] }),
  ));
  assert(batch.status === 503, `batch unarchive fails closed the same way (got ${batch.status})`);
  assert(JSON.stringify(workspaceState.archivedSessionIds) === JSON.stringify(archivedBefore),
    'no rejected mutation changed the archive set');

  if (before === null) rmSync(trashFile, { force: true });
  else writeFileSync(trashFile, before, 'utf8');
}

console.log('\n[15] host half — physical deletion refuses a location that is not session-scoped');
{
  const flatRoot = mkdtempSync(join(tmpdir(), 'dsh-archived-chats-flat-'));
  const sibling = join(flatRoot, 'unrelated-session.jsonl');
  writeFileSync(sibling, 'keep me', 'utf8');
  const savedLocate = persistence.locate;
  // A host layout that keeps each log as a flat file gives dirname() the shared
  // session root: deleting it would take every other session with it.
  persistence.locate = (header) => ({ kind: 'jsonl', path: join(flatRoot, `${header.id}.jsonl`) });
  const target = workspaceState.archivedSessionIds.find((id) => id !== 'session-live');
  writeFileSync(join(flatRoot, `${target}.jsonl`), 'target', 'utf8');
  const moved = await call(routes, '/plugins/dsh-archived-chats/__test_seed_legacy_trash', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: target }),
  ));
  assert(moved.status === 200, `the session moves to the recycle bin first (got ${moved.status})`);
  const purged = await call(routes, '/plugins/dsh-archived-chats/trash/purge', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [target] }),
  ));
  assert(purged.json().failed?.[0]?.reason === 'session-location-unsafe',
    `purge refuses a non session-scoped location (got ${JSON.stringify(purged.json().failed)})`);
  assert(existsSync(sibling), 'the unrelated session log next to it is untouched');
  assert(existsSync(flatRoot), 'the shared session root is untouched');
  // The refusal lands before the irreversible step, so the durable purge intent
  // survives and a retry on a session-scoped layout still completes the job.
  persistence.locate = savedLocate;
  const retried = await call(routes, '/plugins/dsh-archived-chats/trash/purge', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [target] }),
  ));
  assert(retried.status === 200 && retried.json().purged.includes(target),
    `retrying the purge afterwards completes it (got ${retried.status} ${retried.text})`);
  const remaining = await call(routes, '/plugins/dsh-archived-chats/trash', mockReq('GET', {}));
  assert(!remaining.json().sessions.some((row) => row.sessionId === target),
    'the completed purge leaves no stranded purge-pending record');
  rmSync(flatRoot, { recursive: true, force: true });
}

console.log('\n[16] host half — one unrecognized session header never costs a whole panel');
{
  const savedList = persistence.list;
  const probes = [
    ['an origin value added by a later Host', { origin: 'schedule' }],
    ['no createdAt at all', { createdAt: undefined }],
    ['createdAt as an ISO string', { createdAt: '2026-08-19T10:00:00.000Z' }],
    ['delegationDepth as null', { origin: 'subagent', delegationDepth: null }],
    ['a field this version has never seen', { agentPreset: 'coder' }],
  ];
  for (const [label, patch] of probes) {
    persistence.list = async () => {
      const rows = (await savedList()).map((header) => ({ ...header }));
      Object.assign(rows[0], patch);
      if (patch.createdAt === undefined) delete rows[0].createdAt;
      return rows;
    };
    const statuses = {};
    for (const route of ['state', 'lineage', 'insights']) {
      statuses[route] = (await call(routes, `/plugins/dsh-archived-chats/${route}`, mockReq('GET', {}))).status;
    }
    assert(Object.values(statuses).every((status) => status === 200),
      `${label}: every panel still answers (${JSON.stringify(statuses)})`);
  }
  // A repeated id in the Host's archive set is meaningless to every reader here.
  const savedArchive = [...workspaceState.archivedSessionIds];
  workspaceState.archivedSessionIds = [...savedArchive, savedArchive[0]];
  persistence.list = savedList;
  const duplicated = {};
  for (const route of ['state', 'lineage', 'insights']) {
    duplicated[route] = (await call(routes, `/plugins/dsh-archived-chats/${route}`, mockReq('GET', {}))).status;
  }
  assert(Object.values(duplicated).every((status) => status === 200),
    `a repeated archived id keeps every panel answering (${JSON.stringify(duplicated)})`);
  const rows = (await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}))).json().sessions;
  assert(new Set(rows.map((row) => row.id)).size === rows.length, 'a repeated archived id is not listed twice');
  workspaceState.archivedSessionIds = savedArchive;
}

console.log('\n[17] host half — export distinguishes a bad request from a bug here');
{
  const path = '/plugins/dsh-archived-chats/export';
  const form = (body) => mockReq('POST', { 'content-type': 'application/x-www-form-urlencoded' }, body);
  const bad = await call(routes, path, form('sessionIds=not-json'));
  assert(bad.status === 400 && bad.body === 'invalid-export-request',
    `a malformed selection is still the caller's fault (got ${bad.status})`);

  // An internal invariant failure is not a client error, and must be logged.
  const visible = (await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}))).json().sessions[0]?.id;
  assert(typeof visible === 'string', 'a visible archived session is available for the export check');
  const savedInspect = persistence.inspect;
  const warningCount = warnings.length;
  persistence.inspect = () => { throw new TypeError('internal invariant broken'); };
  const broken = await call(routes, path, form(`sessionIds=${encodeURIComponent(JSON.stringify([visible]))}`));
  persistence.inspect = savedInspect;
  assert(broken.status === 500 && broken.body === 'export-failed',
    `an internal failure reports a server error, not invalid-export-request (got ${broken.status} ${broken.body})`);
  assert(warnings.length > warningCount, 'the internal failure left a diagnosable warning');
  assert(!warnings.slice(warningCount).join('\n').includes('internal invariant broken'),
    'the warning carries a stable code, not the raw message');
}

console.log('\n[18] host half — modern persistence reads work while unsupported purge preserves evidence');
{
  const modernHome = mkdtempSync(join(tmpdir(), 'dsh-archived-chats-modern-home-'));
  process.env.DSH_HOME = modernHome;
  const id = 'session-modern-read';
  const header = { id, version: 2, cwd: '/modern', createdAt: 1786727000000, isSeeded: false };
  const revision = 'modern-revision-1';
  const modernEvents = [
    { seq: 0, type: 'session/start', data: {} },
    { seq: 1, type: 'session/title', data: { title: 'Modern persisted title' } },
  ];
  let closes = 0;
  let reads = 0;
  let disposeCalls = 0;
  const modernPersistence = {
    async list() { return [{ header, revision, eventCount: modernEvents.length, sizeBytes: 321 }]; },
    async open(sessionId, access) {
      assert(sessionId === id && access === 'read', 'modern adapter requests an exact read handle');
      return {
        header,
        inheritedEventCount: 0,
        async read(offset, length) {
          reads += 1;
          assert(offset === 0 && length === undefined, 'modern adapter reads the complete log from offset zero');
          return modernEvents;
        },
        async close() { closes += 1; },
      };
    },
  };
  const modernState = { initialized: true, workspaceIds: ['modern-workspace'], archivedSessionIds: [id] };
  const modernWorkspace = {
    id: 'modern-workspace', title: 'Modern workspace', path: '/modern', sessionIds: new Set([id]),
    async detachSession(sessionId) { this.sessionIds.delete(sessionId); },
  };
  const modernRegistry = {
    state: modernState,
    get archivedSessionIds() { return modernState.archivedSessionIds; },
    list: () => [modernWorkspace],
    async unarchiveSession(id) { await this.setState({ ...this.state, archivedSessionIds: this.archivedSessionIds.filter(value => value !== id) }); },
    async setState(next) { modernState.archivedSessionIds = next.archivedSessionIds; },
    headers: new Map([[id, header]]),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
  };
  const modernRoutes = new Map();
  const modernServices = {
    webServer: { register: (route) => { modernRoutes.set(route.path, route.handler); return () => modernRoutes.delete(route.path); } },
    workspaceRegistry: modernRegistry,
    sessionPersistence: modernPersistence,
    sessions: { get: () => undefined },
    agents: { get: () => { disposeCalls += 1; return undefined; } },
  };
  apply({
    get: (key) => modernServices[key],
    on: () => {},
    effect: (fn) => { fn(); },
    logger: { warn: () => {}, info: () => {} },
  });

  const state = await call(modernRoutes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(state.status === 200 && state.json().sessions[0]?.title === 'Modern persisted title',
    `modern handle inspection powers archive reads (got ${state.status})`);
  const stats = await call(modernRoutes, '/plugins/dsh-archived-chats/stats', mockReq('GET', {}));
  assert(stats.status === 200 && stats.json().sessions[id]?.status === 'unavailable',
    'modern read-only persistence reports physical storage measurement unavailable');
  const moved = await call(modernRoutes, '/plugins/dsh-archived-chats/__test_seed_legacy_trash', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
  ));
  assert(moved.status === 200 && moved.json().trashed.includes(id), 'modern read-only session can enter the recycle bin with a protection snapshot');
  const snapshotsBefore = readdirSync(join(modernHome, 'plugin-data', 'archived-chats', 'snapshots')).filter((name) => name !== '.staging');
  const purge = await call(modernRoutes, '/plugins/dsh-archived-chats/trash/purge', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [id] }),
  ));
  const trashAfter = await call(modernRoutes, '/plugins/dsh-archived-chats/trash', mockReq('GET', {}));
  const snapshotsAfter = readdirSync(join(modernHome, 'plugin-data', 'archived-chats', 'snapshots')).filter((name) => name !== '.staging');
  assert(purge.status === 409 && purge.json().failed?.[0]?.reason === 'purge-unsupported',
    `modern read-only purge refuses with the stable capability code (got ${purge.status})`);
  assert(trashAfter.json().sessions[0]?.state === 'trashed', 'unsupported purge preserves the original recycle state');
  assert(snapshotsBefore.length === 1 && snapshotsAfter.length === 1 && snapshotsAfter[0] === snapshotsBefore[0],
    `unsupported purge preserves the protection snapshot (before ${JSON.stringify(snapshotsBefore)}, after ${JSON.stringify(snapshotsAfter)})`);
  assert(modernState.archivedSessionIds.includes(id) && modernWorkspace.sessionIds.has(id),
    'unsupported purge preserves the original session and workspace ownership');
  assert(disposeCalls === 0, 'unsupported purge never reaches live-session disposal');
  assert(reads > 0 && closes === reads, 'every modern inspection closes its read handle');
  rmSync(modernHome, { recursive: true, force: true });
  process.env.DSH_HOME = testHome;
}

console.log('\n[19] host half — orphan sessions are listed, and only orphans may be deleted');
{
  const orphanId = 'session-orphan';
  const blankId = 'session-blank';
  const nonemptyId = 'session-unowned-content';
  const addedHeaders = [
    // A subagent whose parent is not in the store at all.
    { id: orphanId, createdAt: 1786726600000, cwd: '/ws/one', parentSession: 'session-gone', origin: 'subagent', delegationDepth: 1 },
    // A top-level session that never recorded a turn.
    { id: blankId, createdAt: 1786726650000, cwd: '/ws/one', delegationDepth: 0 },
    { id: nonemptyId, createdAt: 1786726650000, cwd: '/ws/one' },
  ];
  headerRows.push(...addedHeaders);
  for (const header of addedHeaders) registry.headers.set(header.id, header);
  events[orphanId] = [{ type: 'turn/start', data: {} }, { type: 'session/title', data: { title: '孤儿工作' } }];
  events[blankId] = [];
  events[nonemptyId] = [{ type: 'turn/start', data: {} }];
  for (const header of addedHeaders) {
    const dir = join(tmp, header.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'fake');
  }

  const earlier = Array.from({ length: 201 }, (_, n) => ({ id: `earlier-content-${n}`, createdAt: n, cwd: '/ws/one' }));
  headerRows.push(...earlier);
  for (const h of earlier) events[h.id] = [{ type: 'turn/start', data: {} }];
  const beyondPrefix = await call(routes, '/plugins/dsh-archived-chats/orphans', mockReq('GET', {}));
  assert(beyondPrefix.json().sessions.some(row => row.id === blankId), 'blank sessions beyond the first 200 candidates remain discoverable');
  for (const h of earlier) { headerRows.splice(headerRows.indexOf(h), 1); delete events[h.id]; }

  const scopedOrphanRequest = (method, body, suffix = '') => {
    const req = mockReq(method, method === 'POST' ? { 'x-dsh-archived-chats': '1' } : {}, body);
    req.url = `/plugins/dsh-archived-chats/orphans${suffix}?kind=subagent`;
    return req;
  };
  const scopedList = await call(routes, '/plugins/dsh-archived-chats/orphans', scopedOrphanRequest('GET'));
  assert(scopedList.json().sessions.map(row => row.id).join(',') === orphanId, 'residual checks only list subagents with a missing parent, never empty chats');
  const invalidKindRequest = mockReq('GET', {}); invalidKindRequest.url = '/plugins/dsh-archived-chats/orphans?kind=blank';
  const invalidKind = await call(routes, '/plugins/dsh-archived-chats/orphans', invalidKindRequest);
  assert(invalidKind.status === 400, 'residual scan rejects unsupported kinds');
  const badParentHeaders = [
    { id: 'session-parentless-subagent', origin: 'subagent', createdAt: 30 },
    { id: 'session-self-subagent', origin: 'subagent', parentSession: 'self-subagent', createdAt: 40 },
  ];
  headerRows.push(...badParentHeaders);
  const excludesCorrupt = await call(routes, '/plugins/dsh-archived-chats/orphans', scopedOrphanRequest('GET'));
  assert(excludesCorrupt.json().sessions.map(row => row.id).join(',') === orphanId, 'residual checks preserve subagents with missing or self-referential parent metadata');
  for (const header of badParentHeaders) headerRows.splice(headerRows.indexOf(header), 1);
  const scopedExport = await call(routes, '/plugins/dsh-archived-chats/orphans/export', scopedOrphanRequest('POST', new URLSearchParams({ sessionIds: JSON.stringify([blankId]) }).toString(), '/export'));
  assert(scopedExport.status === 409, 'residual backups refuse a blank chat rather than broadening the accepted scope');
  const scopedPreview = await call(routes, '/plugins/dsh-archived-chats/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: orphanId, scope: 'orphan-subagent' })));
  const blankPreview = await call(routes, '/plugins/dsh-archived-chats/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: blankId, scope: 'orphan-subagent' })));
  assert(scopedPreview.status === 200 && blankPreview.status === 404, 'residual preview accepts missing-parent subagents and refuses empty chats');

  const listed = await call(routes, '/plugins/dsh-archived-chats/orphans', mockReq('GET', {}));
  assert(listed.status === 200, `orphans list answers 200 (got ${listed.status})`);
  const body = listed.json();
  const ids = body.sessions.map((row) => row.id);
  const orphanRow = body.sessions.find((row) => row.id === orphanId);
  const blankRow = body.sessions.find((row) => row.id === blankId);
  assert(orphanRow !== undefined, 'an orphaned subagent is listed');
  assert(blankRow !== undefined, 'a blank top-level session is listed');
  assert(!ids.includes('session-b'), 'a subagent whose parent still exists is not listed');
  assert(!ids.includes('session-a'), 'an archived session is not listed');
  assert(orphanRow?.kind === 'subagent' && blankRow?.kind === 'blank', 'each row carries its own kind');
  assert(body.summary?.subagent >= 1 && body.summary?.blank >= 1, `the summary counts both kinds (${JSON.stringify(body.summary)})`);
  assert(orphanRow?.sizeBytes > 0, `an orphan row carries its measured size (got ${orphanRow?.sizeBytes})`);

  // A regular unarchived conversation retains metadata after unarchiving.
  workspaces[0].sessionIds.push(nonemptyId);
  workspaceState.archivedSessionIds.push(nonemptyId);
  const savedMeta = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: nonemptyId, tags: ['keep'], note: 'preserve this note' })));
  assert(savedMeta.status === 200, 'metadata is set before unarchiving the fixture');
  workspaceState.archivedSessionIds.splice(workspaceState.archivedSessionIds.indexOf(nonemptyId), 1);
  const unarchived = await call(routes, '/plugins/dsh-archived-chats/unarchived', mockReq('GET', {}));
  assert(unarchived.status === 200 && unarchived.json().sessions.some(row => row.id === nonemptyId && row.note === 'preserve this note' && row.tags?.[0] === 'keep'), 'the Unarchived list retains metadata from an earlier archive');
  const previewRegular = await call(routes, '/plugins/dsh-archived-chats/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: nonemptyId, scope: 'unarchived' })));
  assert(previewRegular.status === 200, 'regular unarchived chats can be previewed before archiving');
  const exportedRegular = await call(routes, '/plugins/dsh-archived-chats/unarchived/export', mockReq('POST', { 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ sessionIds: JSON.stringify([nonemptyId]) }).toString()));
  assert(exportedRegular.status === 200, 'regular unarchived chats can be exported before archiving');
  if (exportedRegular.status === 200) {
    const files = unzipSync(exportedRegular.bytes());
    const sessionFile = Object.keys(files).find(path => path.endsWith('/session.json'));
    const archive = JSON.parse(strFromU8(files[sessionFile])).archive;
    assert(archive.note === 'preserve this note' && archive.tags?.[0] === 'keep', 'unarchived backup preserves tags and notes');
  }
  const noLongerVisible = await call(routes, '/plugins/dsh-archived-chats/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: orphanId, scope: 'unarchived' })));
  assert(noLongerVisible.status === 404, 'the regular unarchived scope cannot preview a cleanup-only candidate');
  const metadataBeforeFailure = readFileSync(metadataFile, 'utf8');
  writeFileSync(metadataFile, '{ broken', 'utf8');
  try {
    const degradedList = await call(routes, '/plugins/dsh-archived-chats/unarchived', mockReq('GET', {}));
    assert(degradedList.status === 200 && degradedList.json().metadataStatus === 'unavailable', 'unreadable metadata is surfaced without hiding unarchived conversations');
    const refusedBackup = await call(routes, '/plugins/dsh-archived-chats/unarchived/export', mockReq('POST', { 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ sessionIds: JSON.stringify([nonemptyId]) }).toString()));
    assert(refusedBackup.status === 503 && !String(refusedBackup.headers['content-type']).includes('zip'), 'unarchived export refuses unreadable metadata rather than silently dropping tags and notes');
  } finally { writeFileSync(metadataFile, metadataBeforeFailure, 'utf8'); }
  workspaces[0].sessionIds.splice(workspaces[0].sessionIds.indexOf(nonemptyId), 1);

  // Being an orphan is the only thing that authorizes deleting a session that
  // was never archived, so a non-orphan id must be refused even with a valid
  // guard header — otherwise this route could delete any chat by id.
  const refused = await call(routes, '/plugins/dsh-archived-chats/orphans/delete',
    mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: ['session-c'] })));
  assert(refused.status === 409, `deleting a non-orphan is refused (got ${refused.status})`);
  assert(refused.json().error === 'orphan-set-changed', 'the refusal names the changed orphan set');
  assert(refused.json().sessionIds?.includes('session-c'), 'the refusal names the rejected id');
  assert(headerRows.some((header) => header.id === 'session-c'), 'the refused session still exists');

  const contentRefused = await call(routes, '/plugins/dsh-archived-chats/orphans/delete',
    mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [blankId, nonemptyId] })));
  assert(contentRefused.status === 409, 'a mixed orphan request containing an unowned conversation is rejected as a whole');
  assert(existsSync(join(tmp, blankId)) && existsSync(join(tmp, nonemptyId)), 'mixed rejection preserves both directories');

  const unguarded = await call(routes, '/plugins/dsh-archived-chats/orphans/delete',
    mockReq('POST', {}, JSON.stringify({ sessionIds: [orphanId] })));
  assert(unguarded.status === 403, `an unguarded orphan delete is refused (got ${unguarded.status})`);

  const refusedBlankCleanup = await call(routes, '/plugins/dsh-archived-chats/orphans/delete', scopedOrphanRequest('POST', JSON.stringify({ sessionIds: [blankId] }), '/delete'));
  assert(refusedBlankCleanup.status === 409 && existsSync(join(tmp, blankId)), 'residual deletion cannot delete an empty chat even if its ID is submitted');

  const deleted = await call(routes, '/plugins/dsh-archived-chats/orphans/delete',
    mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [orphanId] })));
  assert(deleted.status === 200, `deleting an orphan succeeds (got ${deleted.status})`);
  assert(deleted.json().deleted?.includes(orphanId), 'the deleted orphan is reported');
  // The Host persistence list is the Host's to refresh; what this plugin owns is
  // its registry header index, and leaving a stale entry there is what lets a
  // deleted session come back as a ghost.
  assert(!registry.headers.has(orphanId), 'the orphan is gone from the registry header index');
  assert(!existsSync(join(tmp, orphanId)), 'the orphan session directory is gone');

  const strictRoot = { id: 'session-strict-root', createdAt: 10, cwd: '/ws/one', parentSession: 'session-missing-parent', origin: 'subagent', delegationDepth: 1 };
  const reachableChild = { id: 'session-reachable-child', createdAt: 20, cwd: '/ws/one', parentSession: strictRoot.id, origin: 'subagent', delegationDepth: 2 };
  for (const header of [strictRoot, reachableChild]) {
    headerRows.push(header); registry.headers.set(header.id, header); events[header.id] = [{ type: 'turn/start', data: {} }];
    mkdirSync(join(tmp, header.id), { recursive: true }); writeFileSync(join(tmp, header.id, 'session.jsonl.zstd'), 'fake');
  }
  workspaceState.archivedSessionIds.push(reachableChild.id);
  workspaces[0].sessionIds.push(reachableChild.id);
  const strictDeletion = await call(routes, '/plugins/dsh-archived-chats/orphans/delete', scopedOrphanRequest('POST', JSON.stringify({ sessionIds: [strictRoot.id] }), '/delete'));
  assert(strictDeletion.status === 200 && strictDeletion.json().deleted.join(',') === strictRoot.id, 'strict residual route deletes only selected records without cascading');
  assert(existsSync(join(tmp, reachableChild.id)) && registry.headers.has(reachableChild.id) && workspaceState.archivedSessionIds.includes(reachableChild.id) && workspaces[0].sessionIds.includes(reachableChild.id), 'strict residual cleanup preserves unselected workspace and archived descendants');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter(id => id !== reachableChild.id);
  workspaces[0].sessionIds = workspaces[0].sessionIds.filter(id => id !== reachableChild.id);
  for (const header of [strictRoot, reachableChild]) { const index = headerRows.indexOf(header); if (index !== -1) headerRows.splice(index, 1); registry.headers.delete(header.id); delete events[header.id]; }

  // Unreadable blankness cannot authorize irreversible deletion.
  const savedInspect = persistence.inspect;
  persistence.inspect = async (id) => {
    if (id === blankId) throw new Error('log temporarily unreadable');
    return savedInspect(id);
  };
  const unreadable = await call(routes, '/plugins/dsh-archived-chats/orphans', mockReq('GET', {}));
  assert(!unreadable.json().sessions.map((row) => row.id).includes(blankId),
    'an unreadable log drops the row from the display list');
  const stillAuthorized = await call(routes, '/plugins/dsh-archived-chats/orphans/delete',
    mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [blankId] })));
  assert(stillAuthorized.status === 409 && existsSync(join(tmp, blankId)),
    'an unreadable log is refused and its directory is preserved');
  persistence.inspect = savedInspect;

  // Restore the shared store so anything appended later starts from the baseline.
  for (const header of addedHeaders) {
    registry.headers.delete(header.id);
    delete events[header.id];
  }
  for (let index = headerRows.length - 1; index >= 0; index -= 1) {
    if (addedHeaders.some((header) => header.id === headerRows[index].id)) headerRows.splice(index, 1);
  }
}

console.log('\n[20] client half — archive-only unarchived requests');
{
  const savedFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => ({ metadataStatus: 'ready', sessions: [] }) };
  };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const props = { t, refreshSidebar: () => {} };
  harness.render(props); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  let tree = harness.render(props);
  collectElements(tree).find(el => el.props?.id === 'dac-tab-unarchived').props.onClick();
  harness.render(props); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  tree = harness.render(props);
  assert(requests.some(path => path.endsWith('/unarchived')) && !requests.some(path => path.includes('/orphans')), 'opening Unarchived loads ordinary conversations without requesting cleanup data');
  assert(elementText(tree).includes('暂无未归档会话'), 'Unarchived displays an empty state');
  harness.unmount(); globalThis.fetch = savedFetch;
}

console.log('\n[21] retired navigation');
{
  const t = clientCtx.locale.bind('settings.archived-chats');
  const tabs = clientExports.__test.ArchiveTabs({ pageMode: 'archived', onChange() {}, t });
  assert(!elementText(tabs).includes('空间与策略') && !elementText(tabs).includes('回收站'), 'empty legacy bin and retired policies stay out of navigation');
  const legacyTabs = clientExports.__test.ArchiveTabs({ pageMode: 'archived', onChange() {}, t, showTrash: true });
  assert(elementText(legacyTabs).includes('回收站') && !elementText(legacyTabs).includes('空间与策略'), 'existing or unreadable legacy records retain a recovery entry');
}

console.log('\n[selection] exact archived selections and cancellation');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  let rows = [
    { id: 'select-a', title: 'Alpha', createdAt: 10, workspaceId: 'ws-1', workspaceTitle: 'One' },
    { id: 'select-b', title: 'Beta', createdAt: 20, workspaceId: 'ws-1', workspaceTitle: 'One' },
    { id: 'select-c', title: 'Gamma', createdAt: 30, workspaceId: 'ws-2', workspaceTitle: 'Two' },
  ];
  const requests = [];
  let failNextDelete = false;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/export')) {
      requests.push({ path, ids: JSON.parse(new URLSearchParams(options.body).get('sessionIds')) });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/zip' } });
    }
    let payload = {};
    if (options.method === 'POST' && /\/(delete-all|unarchive-all)$/.test(path)) {
      const body = JSON.parse(options.body);
      requests.push({ path, body });
      if (path.endsWith('/delete-all') && failNextDelete) {
        failNextDelete = false;
        return new Response(JSON.stringify({ trashed: [], failed: body.sessionIds.map(id => ({ id, error: 'fixture-failure' })) }), { headers: { 'content-type': 'application/json' } });
      }
      rows = rows.filter(row => !body.sessionIds.includes(row.id));
      payload = path.endsWith('/unarchive-all') ? { ok: true }
        : body.permanent ? { deleted: body.sessionIds, pending: [], failed: [] }
          : { trashed: body.sessionIds, failed: [] };
    } else if (path.endsWith('/state')) payload = { metadataStatus: 'ready', trashStatus: 'ready', sessions: rows };
    else if (path.endsWith('/stats')) payload = { summary: { sessionCount: rows.length, totalBytes: 0 }, sessions: {} };
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  };
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  const props = { t: clientCtx.locale.bind('settings.archived-chats'), refreshSidebar() {} };
  const render = () => harness.render(props);
  const elements = () => collectElements(render());
  const button = label => elements().find(el => el.type === 'button' && elementText(el) === label);
  const rowCheck = id => elements().find(el => el.type === 'input' && el.props.type === 'checkbox' && el.props['data-session-id'] === id);
  const allCheck = () => elements().find(el => el.type === 'input' && el.props['aria-label'] === '全选当前结果');
  const toolbar = () => elements().find(el => el.props?.className === 'dac-selectionbar');
  render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  const select = button('选择');
  assert(select !== undefined, 'Archived provides an explicit selection-mode entry');
  if (select) {
    assert(!rowCheck('select-a'), 'normal archive rows have no selection checkbox');
    select.props.onClick();
    assert(button('导出选中')?.props.disabled === true && collectElements(toolbar()).find(el => el.type === 'button' && el.props?.['aria-label'] === '永久删除选中会话')?.props.disabled === true && button('移入回收站') === undefined,
      'empty selection disables export, recycling and permanent deletion');
    rowCheck('select-a')?.props.onChange({ target: { checked: true } });
    assert(allCheck()?.props['aria-checked'] === 'mixed', 'partial selection exposes an indeterminate Select all');
    const workspace = elements().find(el => el.type?.name === 'FilterSelect' && el.props.ariaLabel === props.t('filter.allProjects'));
    workspace?.props.onChange('ws-2');
    allCheck()?.props.onChange({ target: { checked: true } });
    assert(rowCheck('select-c')?.props.checked === true && !rowCheck('select-b'), 'Select all selects only current filtered results');
    assert(elementText(toolbar()).includes('已选 2 项') && elementText(toolbar()).includes('1 项不在当前结果中'),
      'hidden selections stay selected and their count is disclosed');
    allCheck()?.props.onChange({ target: { checked: false } });
    assert(elementText(toolbar()).includes('已选 1 项'), 'deselecting current results preserves hidden selections');
    button('取消')?.props.onClick();
    assert(!toolbar() && !rowCheck('select-c'), 'Cancel closes selection mode');
    button('选择')?.props.onClick();
    assert(elementText(toolbar()).includes('已选 0 项') && button('导出选中')?.props.disabled === true,
      're-entering selection mode does not resurrect cancelled selections');

    // Two independently chosen chats, including one hidden by the workspace filter.
    rowCheck('select-c')?.props.onChange({ target: { checked: true } });
    elements().find(el => el.type?.name === 'FilterSelect' && el.props.ariaLabel === props.t('filter.allProjects'))?.props.onChange('ws-1');
    rowCheck('select-a')?.props.onChange({ target: { checked: true } });
    button('导出选中')?.props.onClick();
    let dialog = findComponentElement(render(), 'ConfirmDialog');
    assert(String(dialog?.props.body).includes('选中的 2 个已归档聊天') && !String(dialog?.props.body).includes('全部 2 个工作区'),
      'selection confirmation names selected count instead of pretending to be a global action');
    dialog?.props.onCancel();
    assert(requests.length === 0, 'cancelling selected export sends no request');
    button('导出选中')?.props.onClick();
    await findComponentElement(render(), 'ConfirmDialog')?.props.onConfirm();
    assert(requests.at(-1)?.path.endsWith('/export') && requests.at(-1)?.ids.join(',') === 'select-a,select-c',
      'selected export sends exactly the selected IDs, including disclosed hidden selections');

    const barElements = collectElements(toolbar());
    assert(['取消归档', '取消'].every(label => barElements.some(el => el.type === 'button' && elementText(el) === label)),
      'selection mode exposes deletion, unarchive and Cancel');
    const more = findComponentElement(toolbar(), 'ChatActionMenu');
    assert(collectElements(more).filter(el => el.type === 'button').map(elementText).join(',') === '导出选中',
      'selection More offers recycling and Export selected');
    const inlineSecondary = barElements.find(el => el.props?.className === 'dac-selection-secondary');
    assert(collectElements(inlineSecondary).filter(el => el.type === 'button').map(elementText).join(',') === '导出选中',
      'selection toolbar exposes export and recycling directly in order');
    const rowActions = elements().filter(el => el.props?.className === 'dac-row-actions');
    assert(rowActions.every(row => row.props.children.filter(Boolean).length === 0)
      && elements().some(el => el.type === 'button' && el.props?.className === 'dac-row-title dac-row-open'),
      'selection mode clears inline actions while keeping title preview accessible');
    const directActions = toolbar().props.children.find(el => el?.props?.className === 'dac-selection-actions')?.props.children;
    const selectedDelete = collectElements(directActions[3]).find(el => el.type === 'button' && el.props?.['aria-label'] === '永久删除选中会话');
    assert(selectedDelete && elementText(selectedDelete) === '' && collectElements(selectedDelete).some(el => el.type === 'svg')
      && directActions.filter(el => el?.type === 'button').map(elementText).join(',') === '取消归档,取消',
      'selection exposes icon-only deletion after secondary actions and before Cancel');
    const selectionMoreTrigger = collectElements(more).find(el => el.type === 'summary');
    assert(selectionMoreTrigger?.props['aria-label'] === '更多选中项操作' && elementText(selectionMoreTrigger) === ''
      && collectElements(selectionMoreTrigger).some(el => el.type === 'svg'), 'selection More uses an accessible icon-only trigger');
    const beforeDeleteCancel = requests.length;
    selectedDelete?.props.onClick();
    findComponentElement(render(), 'ConfirmDialog')?.props.onCancel();
    assert(requests.length === beforeDeleteCancel && elementText(toolbar()).includes('已选 2 项'), 'cancelling direct deletion preserves selected chats without a request');
    assert(button('移入回收站') === undefined, 'selected chats cannot enter the retired recycle flow');
    rowCheck('select-a')?.props.onChange({ target: { checked: false } });
    // Clear the hidden selection before testing an unrelated single selection.
    button('取消')?.props.onClick();
    collectElements(render()).find(el => el.type === 'button' && el.props?.className === 'dac-action-trigger' && elementText(el) === '选择')?.props.onClick();
    rowCheck('select-b')?.props.onChange({ target: { checked: true } });
    collectElements(toolbar()).find(el => el.type === 'button' && el.props?.['aria-label'] === '永久删除选中会话')?.props.onClick();
    await findComponentElement(render(), 'ConfirmDialog')?.props.onConfirm();
    assert(requests.at(-1)?.body.permanent === true && requests.at(-1)?.body.sessionIds.join(',') === 'select-b',
      'selected permanent deletion targets only the remaining checked chat');
  }
  harness.unmount();
  // A fresh page exercises cancellation and the same exact-ID unarchive path.
  rows = [{ id: 'select-a', title: 'Alpha', createdAt: 10, workspaceId: 'ws-1' },
    { id: 'select-b', title: 'Beta', createdAt: 20, workspaceId: 'ws-1' }];
  const second = createHookHarness(clientCalls.slotRegister[0].component);
  const renderSecond = () => second.render(props);
  const secondElements = () => collectElements(renderSecond());
  const secondButton = label => secondElements().find(el => el.type === 'button' && elementText(el) === label);
  renderSecond(); second.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  secondButton('选择')?.props.onClick();
  secondElements().find(el => el.props?.['data-session-id'] === 'select-a')?.props.onChange({ target: { checked: true } });
  secondButton('取消归档')?.props.onClick();
  const capturedConfirm = findComponentElement(renderSecond(), 'ConfirmDialog');
  assert(capturedConfirm?.props.body.includes('选中的已归档会话') && !/\d+ 个/.test(capturedConfirm.props.body),
    'selected unarchive confirms selection scope without counts');
  // Filtering after the dialog opens cannot change the captured operation range.
  secondElements().find(el => el.type === 'input' && el.props.type === 'text')?.props.onChange({ target: { value: 'Beta' } });
  const beforeRequests = requests.length;
  const pending = capturedConfirm?.props.onConfirm();
  await capturedConfirm?.props.onConfirm(); await pending;
  assert(requests.length === beforeRequests + 1 && requests.at(-1)?.path.endsWith('/unarchive-all')
    && requests.at(-1)?.body.sessionIds.join(',') === 'select-a',
    'unarchive keeps the confirmed selected ID snapshot and blocks duplicate submissions');
  renderSecond(); second.flushEffects();
  assert(secondElements().find(el => el.props?.className === 'dac-selectionbar') !== undefined,
    'successful selected unarchive keeps selection mode available for further work');
  assert(!collectElements(renderSecond()).some(el => el.type?.name === 'NoticeBanner' && el.props.notice?.kind === 'ok'),
    'successful unarchive follows the official silent-success behavior');
  secondElements().find(el => el.type === 'button' && el.props.role === 'tab' && elementText(el) === '未归档')?.props.onClick();
  secondElements().find(el => el.type === 'button' && el.props.role === 'tab' && elementText(el) === '已归档')?.props.onClick();
  assert(!secondElements().some(el => el.props?.className === 'dac-selectionbar'),
    'leaving Archived exits selection mode');
  second.unmount(); globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[search] anchored preview rendering');
{
  const t = clientCtx.locale.bind('settings.archived-chats');
  const turn = { key: 'turn:70', endSeq: 90, answerSeq: 82, processStartSeq: 80, rowCount: 3, toolCallCount: 1, messageCount: 0, subagentCount: 0 };
  const nodes = clientExports.__test.buildPreviewNodes([
    { seq: 80, role: 'assistant', turn, segments: [{ kind: 'tool-call', callId: 'hit-call', name: 'read', argumentsText: '{}' }] },
    { seq: 81, role: 'tool', turn, segments: [{ kind: 'tool-result', toolCallId: 'hit-call', text: 'late needle output' }] },
    { seq: 82, role: 'assistant', turn, segments: [{ kind: 'reasoning', text: 'needle reasoning' }, { kind: 'text', text: 'answer' }] },
  ], 'hit-session');
  const context = { type: clientExports.__test.PreviewMessage, props: { node: { key: 'context-hit', seq: 84, role: 'system', segments: [{ kind: 'text', text: 'matched prompt' }] }, t, matchSeq: 84 } };
  assert(collectElements(context).some(el => (el.type === 'details' || el.type === DisclosureRowStub) && el.props.open === true), 'matched prompt content is expanded inside its own disclosure');
  for (const seq of [81, 82]) {
    const rendered = nodes.map(node => ({ type: clientExports.__test.PreviewMessage, props: { node, sessionId: 'hit-session', t, matchSeq: seq } }));
    const elements = collectElements(rendered);
    if (seq === 82) assert(elements.some(el => el.props?.className === 'dac-preview-detail-label' && elementText(el) === t('preview.reasoning')), 'expanded matched reasoning retains its reasoning label');
    assert(elements.some(el => el.props?.['data-preview-match'] === 'true'), `search anchor ${seq} highlights its rendered node even inside a folded process`);
    assert(elements.some(el => el.type === 'details' && el.props.className === 'dac-preview-process' && el.props.open === true), `search anchor ${seq} expands its process turn`);
    assert(elements.some(el => el.type === 'pre' && elementText(el).includes(seq === 81 ? 'late needle output' : 'needle reasoning')), `search anchor ${seq} exposes readable matched tool or reasoning text`);
  }
}

console.log('\n[search] progressive bounded content search');
{
  const run = clientExports.__test.runArchiveSearch;
  assert(typeof run === 'function', 'production progressive search runner is available');
  if (run) {
    const savedFetch = globalThis.fetch;
    const ids = Array.from({ length: 263 }, (_, i) => `batch-${i}`);
    const requests = [];
    let failRead = true, failNetwork = true;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (body.sessionIds.includes('batch-40') && failNetwork) throw new Error('network disconnected');
      return { ok: true, json: async () => ({
        hits: body.sessionIds.filter(id => !(failRead && id === 'batch-3')).map(sessionId => ({ sessionId, matches: [{ seq: 301, excerpt: 'needle' }] })),
        skipped: failRead && body.sessionIds.includes('batch-3') ? [{ sessionId: 'batch-3', reason: 'EACCES' }] : [],
      }) };
    };
    const updates = [];
    const partial = await run({ query: 'needle', ids, signal: new AbortController().signal, onUpdate: value => updates.push(value) });
    assert(partial.status === 'error' && partial.hits.length === 39 && partial.pendingIds.length === 223 && partial.skipped[0]?.reason === 'EACCES', 'network failure retains earlier hits, unreadable reasons and unprocessed IDs');
    failRead = false; failNetwork = false;
    const complete = await run({ query: 'needle', ids, previous: partial, signal: new AbortController().signal });
    assert(complete.status === 'ready' && complete.processed === 263 && complete.hits.length === 263 && complete.hits.some(hit => hit.sessionId === 'batch-262') && complete.skipped.length === 0, 'retry reaches more than 100 matches and the final batch, deduplicating previous hits');
    assert(requests.every(body => body.sessionIds.length <= 20) && updates.some(value => value.hits.length === 19), 'search uses bounded explicit batches and emits progressive hits');
    let release;
    globalThis.fetch = async () => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ hits: [{ sessionId: 'batch-0' }], skipped: [] }) }); });
    const controller = new AbortController(); const lateUpdates = [];
    const cancelled = run({ query: 'needle', ids, signal: controller.signal, onUpdate: value => lateUpdates.push(value) });
    await Promise.resolve(); controller.abort(); const before = lateUpdates.length; release(); await cancelled;
    assert(lateUpdates.length === before, 'aborted search discards a delayed response without publishing more state');
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('unexpected'); };
    await run({ query: 'x', ids }); await run({ query: 'needle', ids: [] });
    assert(calls === 0, 'short queries and empty scopes perform no body request');
    globalThis.fetch = savedFetch;
  }
}

console.log('\n[search] archive scope and request lifecycle');
{
  const savedFetch = globalThis.fetch, savedHooks = { ...moduleTable.react };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const rows = Array.from({ length: 263 }, (_, i) => ({ id: `scope-${i}`, title: `Chat ${i}`, workspaceId: i < 130 ? 'ws-a' : 'ws-b', workspaceTitle: i < 130 ? 'Workspace A' : 'Workspace B', tags: i % 2 ? ['tagged'] : [], note: '', origin: i % 3 === 0 ? 'subagent' : null }));
  const requests = [], previewRequests = []; let delaySearch = false, releaseSearch, delayPreview = false, releasePreview;
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/state')) return ok({ sessions: rows, metadataStatus: 'ready', trashStatus: 'ready' });
    if (path.endsWith('/stats')) return ok({ summary: {}, sessions: {} });
    if (path.endsWith('/search')) {
      const body = JSON.parse(options.body); requests.push({ ...body, signal: options.signal });
      const response = ok({ hits: body.sessionIds.map(sessionId => ({ sessionId, matches: [{ seq: 310, excerpt: `${body.query} body ${sessionId}` }] })), skipped: [] });
      if (delaySearch) return new Promise(resolve => { releaseSearch = () => resolve(response); });
      return response;
    }
    if (path.endsWith('/preview')) {
      const body = JSON.parse(options.body); previewRequests.push(body);
      const offset = body.seq === 310 ? 45 : body.offset;
      const response = ok({ session: rows.find(row => row.id === body.sessionId), offset, limit: body.limit, total: 130,
        previousOffset: offset > 0 ? Math.max(0, offset - 50) : null, nextOffset: offset + body.limit < 130 ? offset + body.limit : null,
        ...(body.seq === undefined ? {} : { anchor: { status: 'found', seq: body.seq } }),
        messages: Array.from({ length: Math.min(body.limit, 130 - offset) }, (_, i) => ({ seq: 100 + (i + offset) * 3, role: 'user', segments: [{ kind: 'text', text: `message ${i + offset}` }] })) });
      if (delayPreview) return new Promise(resolve => { releasePreview = () => resolve(response); });
      return response;
    }
    return ok({});
  };
  const harness = createHookHarness(clientCalls.slotRegister[0].component), props = { t };
  const render = () => harness.render(props);
  const settle = async (ms = 0) => { render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, ms)); return render(); };
  await settle(); await settle();
  const search = value => collectElements(render()).find(el => el.type === 'input' && el.props.placeholder === t('search.placeholder')).props.onChange({ target: { value } });
  const select = (label, value) => collectElements(render()).find(el => el.type?.name === 'FilterSelect' && el.props.ariaLabel === t(label)).props.onChange(value);
  select('filter.allProjects', 'ws-b'); search('needle'); await settle(330);
  let tree = render();
  assert(requests.length === 7 && requests.every(body => body.sessionIds.every(id => Number(id.split('-')[1]) >= 130)), '263-row UI filters workspace before requesting bounded body batches');
  assert(collectElements(tree).filter(el => el.props?.className === 'dac-row').length === 133 && elementText(tree).includes('scope-262'), 'UI shows more than 100 matching chats including its last candidate');
  const snippet = collectElements(tree).find(el => el.type === 'button' && el.props.className === 'dac-row-snippet');
  await snippet.props.onClick(); tree = render(); let preview = findComponentElement(tree, 'PreviewDialog');
  assert(previewRequests.at(-1).seq === 310 && preview.props.preview.offset === 45, 'keyboard-accessible snippet requests its seq and opens the centered page');
  await preview.props.onLoadMore('previous'); preview = findComponentElement(render(), 'PreviewDialog');
  assert(previewRequests.at(-1).offset === 0 && previewRequests.at(-1).limit === 45 && preview.props.preview.messages[0].seq === 100 && preview.props.preview.nextOffset === 95, 'earlier preview paging prepends context without duplicating the anchor page');
  await preview.props.onLoadMore('next'); preview = findComponentElement(render(), 'PreviewDialog');
  assert(previewRequests.at(-1).offset === 95 && preview.props.preview.messages.length === 130, 'later preview paging stays reachable after loading earlier context');
  preview.props.onCancel();
  delayPreview = true;
  const opening = snippet.props.onClick(); findComponentElement(render(), 'PreviewDialog').props.onCancel(); releasePreview(); await opening;
  assert(!findComponentElement(render(), 'PreviewDialog'), 'closing the anchored preview discards late responses');
  delayPreview = false;
  select('filter.allProjects', 'ws-a'); tree = render();
  assert(!elementText(tree).includes('needle body'), 'changing candidate scope hides old body hits before the effect runs');
  select('tag.filter', 'tagged');
  const beforeFiltered = requests.length;
  await settle(330);
  assert(requests.slice(beforeFiltered).every(body => body.sessionIds.every(id => Number(id.split('-')[1]) < 130 && Number(id.split('-')[1]) % 2 === 1)), 'tag selection also restricts body candidates before requests');
  delaySearch = true; search('delayed'); await settle(330);
  const oldRequest = requests.at(-1), releaseOld = releaseSearch;
  search('current'); await settle();
  assert(oldRequest.signal.aborted, 'query change aborts the old body request');
  delaySearch = false; releaseOld(); await new Promise(resolve => setTimeout(resolve, 0));
  assert(!elementText(render()).includes('delayed body'), 'delayed old search response cannot flash into a new query');
  await new Promise(resolve => setTimeout(resolve, 330));
  assert(elementText(render()).includes('current body'), 'new query owns the displayed results');
  delaySearch = true; search('filter-delay'); await settle(330);
  const filterRequest = requests.at(-1), releaseFilter = releaseSearch;
  select('filter.allProjects', 'ws-b'); await settle(); releaseFilter();
  assert(filterRequest.signal.aborted, 'filter change aborts a running batch before scheduling another');
  delaySearch = false; await new Promise(resolve => setTimeout(resolve, 330));
  const beforeShort = requests.length; search('x'); await settle(330);
  assert(requests.length === beforeShort, 'a one-character query keeps metadata matching without body requests');
  harness.unmount(); globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[search] distinct candidate, content-hit, displayed-chat and failure counts');
{
  const savedFetch = globalThis.fetch, savedHooks = { ...moduleTable.react };
  const rows = [
    { id: 'count-body', title: 'Body only', workspaceId: 'count-a' },
    { id: 'count-overlap', title: 'needle overlap', workspaceId: 'count-a' },
    { id: 'count-title', title: 'needle title', workspaceId: 'count-a' },
    { id: 'count-failed', title: 'Note match', note: 'needle note', workspaceId: 'count-a' },
    { id: 'count-other', title: 'Unrelated', workspaceId: 'count-b' },
  ].map(row => ({ tags: [], note: '', origin: null, workspaceTitle: 'Count workspace', ...row }));
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  for (const language of ['zh', 'en']) {
    const dict = clientCalls.localeRegister[0].dicts[language];
    const t = key => dict[key] ?? key;
    let unreadable = true;
    globalThis.fetch = async (url, options = {}) => {
      const path = String(url);
      if (path.endsWith('/state')) return ok({ sessions: rows, metadataStatus: 'ready', trashStatus: 'ready' });
      if (path.endsWith('/stats')) return ok({ summary: {}, sessions: {} });
      if (path.endsWith('/search')) {
        const body = JSON.parse(options.body);
        const matching = body.query === 'needle' ? ['count-body', 'count-overlap', ...(unreadable ? [] : ['count-failed'])] : [];
        return ok({ hits: body.sessionIds.filter(id => matching.includes(id)).map(sessionId => ({ sessionId,
          matches: [1, 2, 3].map(seq => ({ seq, excerpt: `needle snippet ${seq}` })) })),
          skipped: unreadable && body.query === 'needle' && body.sessionIds.includes('count-failed') ? [{ sessionId: 'count-failed', reason: 'EACCES' }] : [] });
      }
      return ok({});
    };
    const harness = createHookHarness(clientCalls.slotRegister[0].component);
    const render = () => harness.render({ t });
    const settle = async (ms = 0) => { render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, ms)); return render(); };
    const status = () => collectElements(render()).find(el => el.props?.className === 'dac-search-state');
    const search = value => collectElements(render()).find(el => el.type === 'input' && el.props.placeholder === t('search.placeholder')).props.onChange({ target: { value } });
    const selectProject = value => collectElements(render()).find(el => el.type?.name === 'FilterSelect' && el.props.ariaLabel === t('filter.allProjects')).props.onChange(value);
    await settle(); await settle(); search('needle'); await settle(330);
    let text = elementText(status());
    const labels = language === 'zh'
      ? ['已处理候选 5/5', '正文命中 2 个聊天', '当前显示 4 个聊天', '失败 1 个聊天']
      : ['Candidates processed 5/5', 'Body-matched chats 2', 'Displayed chats 4', 'Failed chats 1'];
    assert(labels.every(label => text.includes(label)), `${language}: partial search distinguishes five candidates, two body-matched chats, four union rows and one failure`);
    assert(collectElements(render()).filter(el => el.props?.className === 'dac-row').length === 4
      && collectElements(render()).filter(el => el.type === 'button' && el.props.className === 'dac-row-snippet').length === 6,
      `${language}: actual displayed rows include metadata-only matches and six snippets still describe only two body-matched chats`);
    unreadable = false;
    await collectElements(status()).find(el => el.type === 'button').props.onClick();
    text = elementText(status());
    assert((language === 'zh' ? ['已处理候选 5/5', '正文命中 3 个聊天', '当前显示 4 个聊天', '失败 0 个聊天']
      : ['Candidates processed 5/5', 'Body-matched chats 3', 'Displayed chats 4', 'Failed chats 0']).every(label => text.includes(label)),
      `${language}: retry recovers the failed metadata match without double-counting its displayed chat`);
    selectProject('count-b');
    assert(status() === undefined, `${language}: changing scope suppresses the previous nonzero count summary before effects run`);
    await settle(330); text = elementText(status());
    assert((language === 'zh' ? ['已处理候选 1/1', '正文命中 0 个聊天', '当前显示 0 个聊天', '失败 0 个聊天']
      : ['Candidates processed 1/1', 'Body-matched chats 0', 'Displayed chats 0', 'Failed chats 0']).every(label => text.includes(label)),
      `${language}: new workspace counts only its own candidate and zero matches`);
    selectProject('all'); search('absent'); await settle(330); text = elementText(status());
    assert((language === 'zh' ? ['已处理候选 5/5', '正文命中 0 个聊天', '当前显示 0 个聊天', '失败 0 个聊天']
      : ['Candidates processed 5/5', 'Body-matched chats 0', 'Displayed chats 0', 'Failed chats 0']).every(label => text.includes(label)),
      `${language}: completed zero-result scan keeps coverage distinct from zero body and display counts`);
    harness.unmount(); Object.assign(moduleTable.react, savedHooks);
  }
  globalThis.fetch = savedFetch;
}

console.log('\n[30] official archive changes and recycle membership');
{
  const id = 'session-official-recycle';
  const header = { id, createdAt: 1786726800000, cwd: '/ws/one', origin: null };
  headerRows.push(header); registry.headers.set(id, header);
  events[id] = [{ type: 'turn/start', data: {} }];
  workspaces[0].sessionIds.push(id);
  mkdirSync(join(tmp, id), { recursive: true });
  writeFileSync(join(tmp, id, 'session.jsonl.zstd'), 'synthetic conversation');
  const updateOfficialArchive = async archivedSessionIds => {
    const next = { ...workspaceState, archivedSessionIds };
    // The real Host emits the committed domain value before setState updates
    // the registry object's in-memory state.
    for (const [event, listener] of listeners) {
      if (event === 'domain/changed') listener({ domain: 'workspace', table: '', operation: 'put', value: next });
    }
    await registry.setState(next);
  };
  const move = () => call(routes, '/plugins/dsh-archived-chats/__test_seed_legacy_trash',
    mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id })));
  const read = path => call(routes, `/plugins/dsh-archived-chats/${path}`, mockReq('GET', {}));
  await updateOfficialArchive([...workspaceState.archivedSessionIds, id]);
  assert((await move()).json().trashed?.includes(id), 'officially archived chat moves to the recycle bin');
  await updateOfficialArchive(workspaceState.archivedSessionIds.filter(key => key !== id));
  const unarchived = await read('unarchived');
  assert(unarchived.status === 200 && unarchived.json().sessions.some(row => row.id === id),
    'official unarchive exposes the recycled chat in Unarchived');
  assert(!(await read('trash')).json().sessions.some(row => row.sessionId === id),
    'official unarchive releases the old recycle marker');
  await updateOfficialArchive([...workspaceState.archivedSessionIds, id]);
  assert((await read('state')).json().sessions.some(row => row.id === id),
    'official rearchive returns the chat to Archived');
  await move();
  await updateOfficialArchive(workspaceState.archivedSessionIds.filter(key => key !== id));
  await updateOfficialArchive([...workspaceState.archivedSessionIds, id]);
  assert((await read('state')).json().sessions.some(row => row.id === id)
    && !(await read('trash')).json().sessions.some(row => row.sessionId === id),
    'immediate official unarchive and rearchive cannot revive an old recycle marker');
  assert(existsSync(join(tmp, id, 'session.jsonl.zstd')) && registry.headers.has(id)
    && workspaces[0].sessionIds.includes(id), 'official archive synchronization preserves the conversation and its workspace');
}

console.log('\n[official-core] direct idle chat archive');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const t = clientCtx.locale.bind('settings.archived-chats');
  try {
    for (const scenario of ['success', 'failure', 'skipped', 'workspace']) {
      const requests = [];
      let completeApply, closed = 0, refreshed = 0;
      globalThis.fetch = async (url, options = {}) => {
        const body = JSON.parse(options.body);
        requests.push({ url: String(url), body });
        if (String(url).endsWith('/preview')) return { ok: true, json: async () => ({
          workspace: { id: 'idle-ws' }, token: 'idle-token', nonce: 'idle-nonce',
          sessions: [{ id: 'idle-chat' }], skipped: [], stopSessionIds: [],
        }) };
        await new Promise(resolve => { completeApply = resolve; });
        if (scenario === 'failure') throw new Error('archive unavailable');
        return { ok: true, json: async () => ({ archived: scenario === 'skipped' ? [] : ['idle-chat'], skipped: scenario === 'skipped' ? [{ id: 'idle-chat', reason: 'session-live' }] : [], failed: [], snapshots: [] }) };
      };
      const harness = createHookHarness(clientExports.__test.WorkspaceArchiveDialog);
      const props = { t, scope: scenario === 'workspace' ? 'workspace' : 'chat', includeActive: true,
        workspaces: [{ id: 'idle-ws', sessionIds: ['idle-chat'] }],
        onClose: () => { closed++; }, onApplied: () => { refreshed++; } };
      const first = harness.render(props);
      if (scenario !== 'workspace') assert(first === null, 'single idle archive has no preparing modal');
      harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
      const prepared = harness.render(props);
      harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
      const applying = harness.render(props);
      harness.flushEffects();
      const applies = requests.filter(request => request.url.endsWith('/apply'));
      if (scenario === 'workspace') {
        assert(applies.length === 0 && collectElements(prepared).some(el => el.props?.['data-workspace-archive-apply']),
          'workspace archive still requires confirmation even with one chat');
      } else {
        assert(prepared === null && applying === null, 'idle chat archives without confirmation or applying modal');
        assert(applies.length === 1 && applies[0].body.token === 'idle-token' && applies[0].body.stopActivity !== true,
          'idle chat applies exactly once with the prepared token and without stop consent');
        completeApply?.(); await new Promise(resolve => setTimeout(resolve, 0));
        const settled = harness.render(props); harness.flushEffects();
        if (scenario === 'success') assert(closed === 1 && refreshed === 1, 'direct archive closes and refreshes after success');
        else if (scenario === 'skipped') assert(closed === 0 && refreshed === 0 && collectElements(settled).some(el => el.props?.['data-workspace-archive-result']),
          'chat becoming active before apply stays visible as skipped without stop consent or false success');
        else assert(closed === 0 && refreshed === 0 && collectElements(settled).some(el => el.props?.['data-workspace-archive-retry']),
          'direct archive failure remains visible and retryable without false success');
      }
      harness.unmount();
    }
  } finally { globalThis.fetch = savedFetch; Object.assign(moduleTable.react, savedHooks); }
}

console.log('\n[official-core] title subscriptions and stable list refresh');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const savedSessionList = clientServices.sessions.list;
  const savedWorkspaceList = clientServices.workspaces.list;
  let onSessionChange, onWorkspaceChange, disposed = 0, title = 'Original title', stateReads = 0, releaseRefresh;
  let snapshot = { ids: ['sync-chat'], byId: { 'sync-chat': { title, blank: false, running: false, updatedAt: 1 } } };
  clientServices.sessions.list = { getSnapshot: () => snapshot, subscribe: listener => { onSessionChange = listener; return () => { disposed++; }; } };
  clientServices.workspaces.list = { subscribe: listener => { onWorkspaceChange = listener; return () => { disposed++; }; } };
  const t = clientCtx.locale.bind('settings.archived-chats');
  const registration = clientCalls.slotRegister.find(entry => entry.meta?.name === 'settings.section');
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.endsWith('/state')) stateReads++;
    if (path.endsWith('/unarchived') && releaseRefresh === 'hold') await new Promise(resolve => { releaseRefresh = resolve; });
    return { ok: true, json: async () => ({ metadataStatus: 'ready', trashStatus: 'ready', sessions: path.endsWith('/state') || path.endsWith('/unarchived') ? [{ id:'sync-chat', title, workspaceId:'sync-ws', workspaceTitle:'Workspace', archiveEligible:true }] : [] }) };
  };
  const harness = createHookHarness(registration.component);
  const props = { t, ...registration.meta.inject() };
  const render = () => harness.render(props);
  try {
    render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    assert(elementText(render()).includes('Original title'), 'initial archive title is visible');
    title = 'Renamed through official UI';
    snapshot = { ...snapshot, byId: { 'sync-chat': { ...snapshot.byId['sync-chat'], title } } };
    onSessionChange?.(); await new Promise(resolve => setTimeout(resolve, 120));
    assert(elementText(render()).includes(title), 'official session title notification refreshes the open archive list');
    const before = stateReads;
    snapshot = { ...snapshot, byId: { 'sync-chat': { ...snapshot.byId['sync-chat'], updatedAt: 2 } } };
    onSessionChange?.(); await new Promise(resolve => setTimeout(resolve, 120));
    assert(stateReads === before, 'stream-only timestamp changes do not repeatedly reload archive lists');
    collectElements(render()).find(el => el.props?.id === 'dac-tab-unarchived').props.onClick();
    render(); harness.flushEffects();
    const initialLoading = elementText(render());
    assert(initialLoading.includes('正在加载会话') && !initialLoading.includes('正在准备归档'), 'list loading uses loading copy rather than archive-preparation copy');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(elementText(render()).includes(title), 'unarchived row loads with current title');
    releaseRefresh = 'hold';
    collectElements(render()).find(el => el.type === 'button' && elementText(el) === '刷新').props.onClick();
    assert(elementText(render()).includes(title), 'refresh retains existing rows while the response is pending');
    if (typeof releaseRefresh === 'function') releaseRefresh();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(t('filter.allProjects') === '所有工作区', 'workspace filter uses Host terminology');
  } finally {
    harness.unmount();
    assert(disposed >= 2, 'both official list subscriptions are disposed');
    globalThis.fetch = savedFetch; clientServices.sessions.list = savedSessionList; clientServices.workspaces.list = savedWorkspaceList;
    Object.assign(moduleTable.react, savedHooks);
  }
}

console.log('\n[official-core] stop confirmation and Host-driven refresh');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const savedWorkspaceList = clientServices.workspaces.list;
  const t = clientCtx.locale.bind('settings.archived-chats');
  const registration = clientCalls.slotRegister.find(entry => entry.meta?.name === 'settings.section');
  let listener, unsubscribed = 0, archived = false, applyCalls = 0;
  const requests = [];
  clientServices.workspaces.list = { subscribe: callback => { listener = callback; return () => { unsubscribed++; }; } };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : null;
    if (body) requests.push({ path, body });
    const row = { id: 'official-live', title: 'Official live', workspaceId: 'official-ws', busy: true, archiveEligible: true };
    let value = {};
    if (path.endsWith('/state')) value = { sessions: archived ? [row] : [], metadataStatus: 'ready', trashStatus: 'ready' };
    if (path.endsWith('/unarchived')) value = { sessions: archived ? [] : [row], metadataStatus: 'ready' };
    if (path.endsWith('/workspace-archive/preview')) value = { workspace: { id: 'official-ws' }, token: 'confirmed', nonce: 'nonce', sessions: [row], skipped: [], stopSessionIds: [row.id] };
    if (path.endsWith('/workspace-archive/apply')) { applyCalls++; value = { archived: [row.id], skipped: [], failed: [], snapshots: [] }; }
    return { ok: true, status: 200, json: async () => value };
  };
  try {
    const harness = createHookHarness(registration.component);
    const props = { t, ...registration.meta.inject() };
    const render = () => harness.render(props);
    render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    collectElements(render()).find(el => el.props?.id === 'dac-tab-unarchived').props.onClick();
    render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    assert(elementText(render()).includes('Official live'), 'official live row appears before the external update');
    archived = true; listener(); await new Promise(resolve => setTimeout(resolve, 120));
    assert(!elementText(render()).includes('Official live'), 'official state notification removes the archived row from Unarchived without tab remount');
    collectElements(render()).find(el => el.props?.id === 'dac-tab-archived').props.onClick();
    assert(elementText(render()).includes('Official live'), 'same notification also refreshes Archived');
    harness.unmount();
    assert(unsubscribed > 0, 'official subscription is disposed on unmount');
    let cancelled = 0;
    const dialog = createHookHarness(clientExports.__test.WorkspaceArchiveDialog);
    const dp = { t, scope: 'chat', includeActive: true, workspaces: [{ id: 'official-ws', sessionIds: ['official-live'] }], onClose() { cancelled++; } };
    dialog.render(dp); dialog.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    let tree = dialog.render(dp);
    dialog.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
    assert(applyCalls === 0, 'active single chat never auto-applies before stop consent');
    assert(elementText(tree).includes('停止并归档此会话？') && elementText(tree).includes('正在进行的工作'), 'running archive explicitly explains that work will stop');
    collectElements(tree).find(el => el.props?.['data-workspace-archive-cancel'])?.props.onClick();
    assert(cancelled === 1 && applyCalls === 0, 'cancel never stops or archives work');
    const action = collectElements(tree).find(el => el.props?.['data-workspace-archive-apply']);
    assert(action.props.className.includes('dac-stop-archive') && elementText(action) === '停止并归档', 'stop confirmation uses a distinct destructive action');
    await action.props.onClick();
    assert(requests.some(r => r.path.endsWith('/workspace-archive/preview') && r.body.includeActive === true), 'preview asks the Host-backed service about active chats');
    assert(requests.some(r => r.path.endsWith('/workspace-archive/apply') && r.body.stopActivity === true && r.body.token === 'confirmed'), 'explicit confirmation submits stop consent for the prepared token');
    dialog.unmount();
  } finally { globalThis.fetch = savedFetch; clientServices.workspaces.list = savedWorkspaceList; Object.assign(moduleTable.react, savedHooks); }
}

// Tear down the isolated DSH_HOME and session fixture dirs.
rmSync(testHome, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED\n' : `\n💥 ${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
