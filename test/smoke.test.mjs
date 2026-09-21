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

// Seed upgrade-era snapshots before the plugin starts. They remain untouched
// compatibility files and must never be projected into the Recycle Bin.
const legacyStore = createSnapshotStore({ root: join(testHome, 'plugin-data', 'archived-chats', 'snapshots'), persistence, attachments: services.attachments });
const seedLegacy = () => legacyStore.capture({ sessionId: 'session-a', archive: { title: 'Legacy Alpha', workspace: { id: 'ws-1', title: 'Project', path: '/ws/private' }, wasArchived: true, tags: [], note: 'keep this' }, liveDisposition: 'cold' });
const capturedSnapshotId = (await seedLegacy()).snapshotId;
const purgeSnapshotId = (await seedLegacy()).snapshotId;
const clearSnapshotId = (await seedLegacy()).snapshotId;

const { apply, name } = await import(new URL('../lib/index.js', import.meta.url));
//#endregion

console.log('\n[1] host half — lazy route registration');
apply(ctx);
assert(name === 'archived-chats', `plugin name is "archived-chats" (got "${name}")`);
assert(routes.size === 0, 'no routes while webServer is unbound');
services.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } };
listeners.find(([event]) => event === 'internal/service')?.[1]('webServer');
assert(routes.size === 28, `twenty-eight archive-management routes registered after webServer binds (got ${routes.size})`);
for (const path of ['about', 'about/check-updates', 'state', 'stats', 'insights', 'retention/policy', 'retention/preview', 'retention/apply', 'lineage', 'preview', 'preview/image', 'search', 'export', 'import/inspect', 'import/restore', 'metadata', 'trash', 'trash/restore', 'trash/purge', 'trash/empty', 'unarchive', 'unarchive-all', 'delete', 'delete-all', 'workspace-archive/workspaces', 'workspace-archive/preview', 'workspace-archive/apply']) {
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

  const clearedTrash = await call(routes, '/plugins/dsh-archived-chats/trash/empty', mockReq('POST', {
    'x-dsh-archived-chats': '1',
  }, '{}'));
  assert(clearedTrash.status === 400 && clearedTrash.json().error === 'trashTargets-required',
    'empty Recycle Bin rejects an absent confirmation scope');
  assert([capturedSnapshotId, purgeSnapshotId, clearSnapshotId].every((id) =>
    existsSync(join(testHome, 'plugin-data', 'archived-chats', 'snapshots', id, 'manifest.json'))),
  'empty Recycle Bin leaves old history snapshot files untouched');

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
  );
  events['session-source-context'] = [{ type: 'session/title', data: { title: '可读的来源会话' } }];
  persistence.inspect = async (id) => {
    lineageInspections.push(id);
    return originalInspect(id);
  };
  const lineage = await call(routes, '/plugins/dsh-archived-chats/lineage', mockReq('GET', {}));
  persistence.inspect = originalInspect;
  delete events['session-source-context'];
  headerRows.splice(-2);
  headerRows[1].parentSession = originalParent;
  assert(lineage.status === 200, `lineage answers 200 (got ${lineage.status})`);
  const sourceContext = lineage.json().roots.find((node) => node.id === 'session-source-context');
  assert(sourceContext?.title === '可读的来源会话' && sourceContext.children[0]?.id === 'session-b',
    'lineage resolves a readable title for the necessary active source context');
  assert(JSON.stringify(lineageInspections) === '["session-source-context"]',
    'lineage inspects only untitled active context included in the focused relationship tree');
  assert(!JSON.stringify(lineage.json()).includes('session-unrelated-active'), 'lineage omits active sessions unrelated to archived or recycled chats');
  assert(!JSON.stringify(lineage.json()).includes('/ws/'), 'lineage never exposes workspace paths');

  const originalArchivedIds = [...workspaceState.archivedSessionIds];
  workspaceState.archivedSessionIds = [];
  const emptyLineage = await call(routes, '/plugins/dsh-archived-chats/lineage', mockReq('GET', {}));
  workspaceState.archivedSessionIds = originalArchivedIds;
  assert(emptyLineage.status === 200 && emptyLineage.json().roots.length === 0,
    'lineage is empty when the archive manager has no archived or recycled sessions');

  const autoGuard = await call(routes, '/plugins/dsh-archived-chats/retention/policy/preview', mockReq('POST', {}, '{}'));
  assert(autoGuard.status === 403, 'automatic cleanup confirmation preview requires guard');
  const autoPolicy = { historicalSnapshotsPerSession: 1, historicalSnapshotMaxAgeDays: null, snapshotQuotaBytes: null, recycleMaxAgeDays: 7, recycleAutoDelete: true };
  const enableWithoutConfirmation = await call(routes, '/plugins/dsh-archived-chats/retention/policy', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify(autoPolicy)));
  assert(enableWithoutConfirmation.status === 409 && enableWithoutConfirmation.json().error === 'retention-confirmation-required', 'enabling auto cleanup requires server confirmation');
  const autoPreview = await call(routes, '/plugins/dsh-archived-chats/retention/policy/preview', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify(autoPolicy)));
  assert(autoPreview.status === 200 && autoPreview.json().confirmationRequired === true && autoPreview.json().candidates.length === 0, 'enabling with an empty bin still explains future automatic deletion');
  const confirmedPolicy = await call(routes, '/plugins/dsh-archived-chats/retention/policy', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ policy: autoPolicy, confirmation: autoPreview.json() })));
  assert(confirmedPolicy.status === 200 && confirmedPolicy.json().policy.recycleAutoDelete === true, 'confirmed policy persists explicit opt-in');
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
  assert(savedPolicy.status === 200, `retention policy save answers 200 (got ${savedPolicy.status})`);

  const preview = await call(routes, '/plugins/dsh-archived-chats/retention/preview', mockReq('POST', {
    'x-dsh-archived-chats': '1',
  }, '{}'));
  assert(preview.status === 200, `retention preview answers 200 (got ${preview.status})`);
  const applyResult = await call(routes, '/plugins/dsh-archived-chats/retention/apply', mockReq('POST', {
    'x-dsh-archived-chats': '1',
  }, JSON.stringify({ token: preview.json().token, nonce: preview.json().nonce, keys: [] })));
  assert(applyResult.status === 200, `empty retention selection safely consumes preview (got ${applyResult.status})`);
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
  const res = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-live"}'));
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
  const res = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq('POST', { 'x-dsh-archived-chats': '1' }, `{"sessionId":"${id}"}`));
  assert(res.status === 200, `in-place trash move answers 200 (got ${res.status}: ${res.body})`);
  const body = res.json();
  assert(body.trashed.includes(id), 'live session reported as trashed');
  assert(body.failed.length === 0, 'no failed entries');
  assert(calls.cancel?.kind === 'disposed', 'agent cancelled with the disposed cause');
  assert(calls.idle === 1, 'quiescence awaited before flush');
  assert(calls.flush === 1, 'durability flushed before detach');
  assert(calls.scope === 1, 'agent fiber disposed (factory disposer order)');
  assert(calls.agentDetach === 1 && calls.sessionDetach === 1, 'both store entries detached');
  assert(existsSync(join(tmp, id)), 'trash move preserves the session directory');
  assert(workspaceState.archivedSessionIds.includes(id), 'trashed session stays archived');
  assert(!readPendingStore().includes(id), 'pending-store crash bracket cleared after completion');
  const purged = await call(routes, '/plugins/dsh-archived-chats/trash/purge', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [id] }),
  ));
  assert(purged.status === 200 && purged.json().purged.includes(id), 'explicit recycle purge succeeds');
  assert(!existsSync(join(tmp, id)), 'permanent purge removes the session directory');
  assert(!workspaceState.archivedSessionIds.includes(id), 'permanent purge removes archive membership');
  headerRows.splice(headerRows.findIndex((header) => header.id === id), 1);
  services.sessions = liveSessions;
  delete services.agents;
}

console.log('\n[6] delete — full path');
{
  const res = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-b"}'));
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
  const res = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq('POST', { 'x-dsh-archived-chats': '1' }, `{"sessionId":"${id}"}`));
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
  assert(res.status === 409, `batch with unavailable metadata answers 409 (got ${res.status})`);
  assert(body.trashed.length === 0 && body.failed.length === 3, 'unavailable metadata prevents incomplete trash snapshots');
  assert(existsSync(join(tmp, 'session-c')), 'failed trash move keeps session-c directory');
  assert(readFileSync(metadataFile, 'utf8') === corruptMetadata, 'failed trash move leaves corrupt metadata bytes untouched');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((id) => id !== 'session-live');
  writeFileSync(metadataFile, JSON.stringify({ version: 1, sessions: {} }), 'utf8');
}

console.log('\n[9] boot migration — deferred deletions become recoverable trash');
{
  const state2 = { initialized: true, workspaceIds: [], archivedSessionIds: ['session-live'] };
  const registry2 = {
    state: state2,
    get archivedSessionIds() { return state2.archivedSessionIds; },
    list: () => [],
    async setState(next) { state2.archivedSessionIds = next.archivedSessionIds; },
    headers: new Map([['session-live', { id: 'session-live', createdAt: 1 }]]),
    sessionPaths: new Map([['session-live', join(tmp, 'session-live')]]),
    invalidSessionPaths: new Map(),
  };
  const persistence2 = {
    list: async () => [{ id: 'session-live', createdAt: 1 }],
    inspect: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { meta: { id: 'session-live', createdAt: 1 }, events: [] };
    },
    listSnapshots: async () => [{ header: { id: 'session-live', createdAt: 1 }, revision: 'rev-session-live' }],
    locate: (h) => ({ kind: 'jsonl', path: join(tmp, String(h.id), 'session.jsonl.zstd') }),
  };
  const services2 = { webServer: undefined, workspaceRegistry: registry2, sessionPersistence: persistence2, sessions: { get: () => undefined } };
  const routes2 = new Map();
  const listeners2 = [];
  const ctx2 = {
    get: (k) => services2[k],
    on: (e, cb) => { listeners2.push([e, cb]); },
    effect: (fn) => { fn(); },
    logger: { warn: () => {}, info: () => {} },
  };
  const { apply: applyBoot } = await import(new URL('../lib/index.js', import.meta.url));
  const pendingPath = join(testHome, 'plugin-data', 'archived-chats', 'pending-deletions.json');
  writeFileSync(pendingPath, JSON.stringify({ ids: ['session-live'] }), 'utf8');
  applyBoot(ctx2);
  assert(readPendingStore().includes('session-live'), 'pending store holds the parked id before boot');
  services2.webServer = { register: (r) => { routes2.set(r.path, r.handler); return () => routes2.delete(r.path); } };
  listeners2.find(([event]) => event === 'internal/service')?.[1]('webServer');
  await waitUntil(() => readPendingStore().length === 0, 3000);
  assert(existsSync(join(tmp, 'session-live')), 'migration preserves the session directory');
  assert(state2.archivedSessionIds.includes('session-live'), 'migration keeps archive membership');
  assert(readPendingStore().length === 0, 'pending store drains after trash commit');
  const trash = await call(routes2, '/plugins/dsh-archived-chats/trash', mockReq('GET', {}));
  assert(trash.json().sessions.some((session) => session.sessionId === 'session-live'), 'migrated session appears in recycle bin');
  const restored = await call(routes2, '/plugins/dsh-archived-chats/trash/restore', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, '{"sessionIds":["session-live"]}',
  ));
  assert(restored.status === 200, 'migrated fixture can be restored for later tests');
}

console.log('\n[10] restore of a trashed session returns it to archived management');
{
  const header = { id: 'session-live', createdAt: 1, cwd: '/ws/one' };
  headerRows.push(header);
  events['session-live'] = [];
  workspaceState.archivedSessionIds.push('session-live');
  const res = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-live"}'));
  assert(res.status === 200 && res.json().trashed.includes('session-live'), 'trash move accepted');
  const un = await call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-live"}'));
  assert(un.status === 409, 'ordinary unarchive rejects a trashed session');
  const restored = await call(routes, '/plugins/dsh-archived-chats/trash/restore', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionIds":["session-live"]}'));
  assert(restored.status === 200 && restored.json().restored.includes('session-live'), 'trash restore succeeds');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((id) => id !== 'session-live');
  headerRows.splice(headerRows.indexOf(header), 1);
  delete events['session-live'];
}

console.log('\n[10b] concurrent trash move/restore operations retain unrelated ids');
{
  const ids = ['session-live-race-a', 'session-live-race-b', 'session-live-race-c'];
  for (const id of ids) {
    mkdirSync(join(tmp, id), { recursive: true });
    writeFileSync(join(tmp, id, 'session.jsonl.zstd'), 'fake');
    const header = { id, createdAt: 1, cwd: '/ws/one' };
    headerRows.push(header);
    events[id] = [];
  }
  workspaceState.archivedSessionIds.push(ids[0], ids[1]);
  const originalSessions = services.sessions;
  services.sessions = { get: (id) => ids.includes(id) ? { id, header: { id } } : undefined };
  const responses = await Promise.all(ids.slice(0, 2).map((id) => call(routes, '/plugins/dsh-archived-chats/delete', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
  ))));
  assert(responses.every((response) => response.json().trashed.length === 1), 'each live delete moves to trash');
  const firstTrash = await call(routes, '/plugins/dsh-archived-chats/trash', mockReq('GET', {}));
  assert(ids.slice(0, 2).every((id) => firstTrash.json().sessions.some((row) => row.sessionId === id)), 'concurrent trash writes retain both ids');
  workspaceState.archivedSessionIds.push(ids[2]);
  const [unarchiveResponse, deleteResponse] = await Promise.all([
    call(routes, '/plugins/dsh-archived-chats/trash/restore', mockReq(
      'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [ids[0]] }),
    )),
    call(routes, '/plugins/dsh-archived-chats/delete', mockReq(
      'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: ids[2] }),
    )),
  ]);
  services.sessions = originalSessions;
  const trashAfterRace = await call(routes, '/plugins/dsh-archived-chats/trash', mockReq('GET', {}));
  const trashIds = trashAfterRace.json().sessions.map((row) => row.sessionId);
  assert(unarchiveResponse.status === 200 && deleteResponse.json().trashed.includes(ids[2]), 'concurrent restore and trash move both complete');
  assert(!trashIds.includes(ids[0]), 'concurrent restore removes only its trash id');
  assert(trashIds.includes(ids[1]) && trashIds.includes(ids[2]), 'concurrent trash mutations retain old and newly moved ids');
  await call(routes, '/plugins/dsh-archived-chats/trash/restore', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [ids[1], ids[2]] })));
  for (const id of ids) {
    workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((sessionId) => sessionId !== id);
    const headerIndex = headerRows.findIndex((header) => header.id === id);
    if (headerIndex >= 0) headerRows.splice(headerIndex, 1);
    delete events[id];
  }
}

console.log('\n[10f] unarchive cannot interleave while a live session is being disposed');
{
  const id = 'session-live-dispose-race';
  mkdirSync(join(tmp, id), { recursive: true });
  writeFileSync(join(tmp, id, 'session.jsonl.zstd'), 'fake');
  const header = { id, createdAt: 1786726800000, cwd: '/ws/one' };
  headerRows.push(header);
  events[id] = [];
  workspaceState.archivedSessionIds.push(id);
  let releaseIdle;
  let markIdleEntered;
  const idleEntered = new Promise((resolve) => { markIdleEntered = resolve; });
  const idleReleased = new Promise((resolve) => { releaseIdle = resolve; });
  const sessionObj = { id, header };
  const sessionsStore = new Map([[id, {
    session: sessionObj,
    detach: () => { sessionsStore.delete(id); },
  }]]);
  const agentObj = {
    cancel: () => {},
    whenIdle: async () => { markIdleEntered(); await idleReleased; },
    scope: { dispose: async () => {} },
  };
  const agentsStore = new Map([[id, { id, agent: agentObj, announcing: false }]]);
  const originalSessions = services.sessions;
  services.sessions = {
    get: (sessionId) => sessionsStore.get(sessionId)?.session,
    store: sessionsStore,
    flush: async () => {},
  };
  services.agents = {
    get: (sessionId) => agentsStore.get(sessionId)?.agent,
    store: agentsStore,
    detachEntered: (entry) => agentsStore.delete(entry.id),
  };
  const deletePromise = call(routes, '/plugins/dsh-archived-chats/delete', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
  ));
  await waitFor(idleEntered);
  const unarchivePromise = call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
  ));
  let unarchiveSettled = false;
  void unarchivePromise.then(() => { unarchiveSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(!unarchiveSettled, 'unarchive waits for live disposal instead of detaching the active session mid-delete');
  releaseIdle();
  const [deleteResponse, unarchiveResponse] = await Promise.all([deletePromise, unarchivePromise]);
  assert(deleteResponse.status === 200 && unarchiveResponse.status === 409, 'serialized trash move wins and queued unarchive is rejected');
  assert(existsSync(join(tmp, id)) && !sessionsStore.has(id) && !agentsStore.has(id), 'trash move owns the serialized commit without physical deletion');
  const restore = await call(routes, '/plugins/dsh-archived-chats/trash/restore', mockReq('POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionIds: [id] })));
  assert(restore.status === 200, 'race fixture trash record can be restored');
  services.sessions = originalSessions;
  delete services.agents;
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((sessionId) => sessionId !== id);
  headerRows.splice(headerRows.indexOf(header), 1);
  delete events[id];
}

console.log('\n[10g] delete rechecks archive state after a queued unarchive commits');
{
  const id = 'session-live-unarchive-first';
  mkdirSync(join(tmp, id), { recursive: true });
  writeFileSync(join(tmp, id, 'session.jsonl.zstd'), 'fake');
  const header = { id, createdAt: 1786726900000, cwd: '/ws/one' };
  headerRows.push(header);
  events[id] = [];
  workspaceState.archivedSessionIds.push(id);
  let releaseState;
  let markStateEntered;
  const stateEntered = new Promise((resolve) => { markStateEntered = resolve; });
  const stateReleased = new Promise((resolve) => { releaseState = resolve; });
  const originalSetState = registry.setState;
  registry.setState = async (next) => {
    markStateEntered();
    await stateReleased;
    return originalSetState.call(registry, next);
  };
  let cancelCount = 0;
  const sessionObj = { id, header };
  const sessionsStore = new Map([[id, {
    session: sessionObj,
    detach: () => { sessionsStore.delete(id); },
  }]]);
  const agentObj = {
    cancel: () => { cancelCount += 1; },
    whenIdle: async () => {},
    scope: { dispose: async () => {} },
  };
  const agentsStore = new Map([[id, { id, agent: agentObj, announcing: false }]]);
  const originalSessions = services.sessions;
  services.sessions = {
    get: (sessionId) => sessionsStore.get(sessionId)?.session,
    store: sessionsStore,
    flush: async () => {},
  };
  services.agents = {
    get: (sessionId) => agentsStore.get(sessionId)?.agent,
    store: agentsStore,
    detachEntered: (entry) => agentsStore.delete(entry.id),
  };
  const unarchivePromise = call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
  ));
  await waitFor(stateEntered);
  const deletePromise = call(routes, '/plugins/dsh-archived-chats/delete', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
  ));
  releaseState();
  const [unarchiveResponse, deleteResponse] = await Promise.all([unarchivePromise, deletePromise]);
  assert(unarchiveResponse.status === 200 && deleteResponse.status === 409, 'queued unarchive wins before the delete lifecycle callback starts');
  assert(cancelCount === 0 && sessionsStore.has(id) && agentsStore.has(id), 'delete does not dispose a live session after unarchive already removed its archive state');
  assert(existsSync(join(tmp, id)), 'queued unarchive preserves the live session directory');
  registry.setState = originalSetState;
  services.sessions = originalSessions;
  delete services.agents;
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((sessionId) => sessionId !== id);
  headerRows.splice(headerRows.indexOf(header), 1);
  delete events[id];
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
  const newest = clientExports.__test.sortArchivedSessions(rows, 'newest', 'en-US');
  const oldest = clientExports.__test.sortArchivedSessions(rows, 'oldest', 'en-US');
  const byTitle = clientExports.__test.sortArchivedSessions(rows, 'title', 'en-US');
  assert(newest.map((row) => row.id).join(',') === 'b,a,untitled', 'newest sort puts missing dates last');
  assert(oldest.map((row) => row.id).join(',') === 'a,b,untitled', 'oldest sort puts missing dates last');
  assert(byTitle.map((row) => row.id).join(',') === 'a,b,untitled', 'title sort puts untitled chats last');
  assert(rows.map((row) => row.id).join(',') === 'b,untitled,a', 'sorting never mutates session state');

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

  const noticeTimers = [];
  const cancelledNoticeTimers = [];
  const archiveNotice = clientExports.__test.createArchiveNoticeController?.({
    durationMs: 3000,
    schedule: (callback, delay) => {
      const timer = { callback, delay, id: noticeTimers.length + 1 };
      noticeTimers.push(timer);
      return timer.id;
    },
    cancel: (id) => { cancelledNoticeTimers.push(id); },
    undo: async () => {},
    view: async () => true,
  });
  let archiveNoticeUpdates = 0;
  archiveNotice?.subscribe(() => { archiveNoticeUpdates += 1; });
  archiveNotice?.show('session-a');
  assert(archiveNotice?.getSnapshot()?.sessionId === 'session-a'
    && noticeTimers[0]?.delay === 3000 && archiveNoticeUpdates === 1,
  'archive success notice appears and schedules an exact three-second dismissal');
  archiveNotice?.pause();
  assert(cancelledNoticeTimers.includes(1) && archiveNotice?.getSnapshot()?.sessionId === 'session-a',
    'archive success notice pauses without dismissing while hovered or focused');
  archiveNotice?.resume();
  assert(noticeTimers[1]?.delay === 3000, 'archive success notice restarts its three-second window after interaction');
  archiveNotice?.show('session-b');
  assert(archiveNotice?.getSnapshot()?.sessionId === 'session-b'
    && cancelledNoticeTimers.includes(2) && noticeTimers[2]?.delay === 3000,
  'a newer archive replaces the prior notice and resets its dismissal window');
  noticeTimers[2]?.callback();
  assert(archiveNotice?.getSnapshot() === null, 'archive success notice dismisses when its three-second timer elapses');

  const overlapTimers = [];
  const overlapNotice = clientExports.__test.createArchiveNoticeController?.({
    durationMs: 3000,
    schedule: (callback, delay) => { overlapTimers.push({ callback, delay }); return overlapTimers.length; },
    cancel: () => {},
  });
  overlapNotice?.show('session-overlap');
  overlapNotice?.pause('pointer');
  overlapNotice?.pause('focus');
  overlapNotice?.resume('pointer');
  assert(overlapTimers.length === 1, 'archive notice remains paused while any pointer or focus interaction is still active');
  overlapNotice?.resume('focus');
  assert(overlapTimers.length === 2 && overlapTimers[1]?.delay === 3000,
    'archive notice resumes only after every active interaction leaves');

  const undoNoticeTimers = [];
  const undoCalls = [];
  let rejectUndo = false;
  const undoNotice = clientExports.__test.createArchiveNoticeController?.({
    durationMs: 3000,
    schedule: (callback, delay) => { undoNoticeTimers.push({ callback, delay }); return undoNoticeTimers.length; },
    cancel: () => {},
    undo: async (sessionId) => {
      undoCalls.push(sessionId);
      if (rejectUndo) throw new Error('undo unavailable');
    },
    view: async () => true,
  });
  undoNotice?.show('session-undo');
  const undoPromise = undoNotice?.undo();
  assert(undoNotice?.getSnapshot()?.status === 'undoing', 'archive notice stops its timer and exposes progress while undo is pending');
  assert(await undoPromise === true && undoCalls.join(',') === 'session-undo' && undoNotice?.getSnapshot() === null,
  'successful archive undo targets the latest session and closes the notice');
  rejectUndo = true;
  undoNotice?.show('session-retry');
  let undoRetryResult = null;
  try { undoRetryResult = await undoNotice?.undo(); } catch { undoRetryResult = 'threw'; }
  assert(undoRetryResult === false
    && undoNotice?.getSnapshot()?.sessionId === 'session-retry'
    && undoNotice?.getSnapshot()?.status === 'undo-error',
  'failed archive undo stays visible for an explicit retry');

  const viewedSessions = [];
  let viewResult = true;
  const viewNotice = clientExports.__test.createArchiveNoticeController?.({
    durationMs: 3000,
    schedule: () => 1,
    cancel: () => {},
    undo: async () => {},
    view: async (sessionId) => { viewedSessions.push(sessionId); return viewResult; },
  });
  viewNotice?.show('session-view');
  const viewPromise = viewNotice?.view();
  assert(viewNotice?.getSnapshot()?.status === 'viewing', 'archive notice stops its timer while opening the archived-chat view');
  assert(await viewPromise === true && viewedSessions.join(',') === 'session-view' && viewNotice?.getSnapshot() === null,
    'archive notice closes only after the archived-chat view opens');
  viewResult = false;
  viewNotice?.show('session-view-retry');
  assert(await viewNotice?.view() === false && viewNotice?.getSnapshot()?.status === 'view-error',
    'archive notice remains available when the archived-chat view cannot open');

  const interceptedNotice = clientExports.__test.createArchiveNoticeController?.({
    durationMs: 3000,
    schedule: () => 1,
    cancel: () => {},
  });
  const archiveCalls = [];
  let rejectArchive = false;
  const originalArchiveSession = async function archiveSession(sessionId) {
    archiveCalls.push({ receiver: this, sessionId });
    if (rejectArchive) throw new Error('archive rejected');
    return `archived:${sessionId}`;
  };
  const interceptedWorkspaces = { archiveSession: originalArchiveSession };
  const removeArchiveInterceptor = clientExports.__test.installArchiveNoticeInterceptor?.(interceptedWorkspaces, interceptedNotice);
  const archiveResult = await interceptedWorkspaces.archiveSession('session-success');
  assert(archiveResult === 'archived:session-success'
    && archiveCalls[0]?.receiver === interceptedWorkspaces
    && interceptedNotice?.getSnapshot()?.sessionId === 'session-success',
  'successful DSH archive calls preserve their result and show the matching success notice');
  interceptedNotice?.dismiss();
  rejectArchive = true;
  let archiveFailure = null;
  try { await interceptedWorkspaces.archiveSession('session-failure'); } catch (error) { archiveFailure = error; }
  assert(archiveFailure?.message === 'archive rejected' && interceptedNotice?.getSnapshot() === null,
    'failed DSH archive calls propagate the error without showing a false success notice');
  removeArchiveInterceptor?.();
  assert(interceptedWorkspaces.archiveSession === originalArchiveSession,
    'archive notice interceptor restores the original DSH method when the plugin unloads');

  const archiveOrder = [];
  const archiveTimers = [];
  const simpleNotice = clientExports.__test.createArchiveNoticeController({
    schedule: (callback) => { archiveTimers.push(callback); return archiveTimers.length; },
    cancel: () => {},
    capture: async () => { archiveOrder.push('obsolete-capture'); },
  });
  const simpleWorkspaces = { archiveSession: async (id) => { archiveOrder.push(id); return id; } };
  const removeSimpleInterceptor = clientExports.__test.installArchiveNoticeInterceptor(simpleWorkspaces, simpleNotice);
  const archivedResult = await simpleWorkspaces.archiveSession('plain-archive');
  await Promise.resolve();
  assert(archivedResult === 'plain-archive' && archiveOrder.join(',') === 'plain-archive'
    && archiveTimers.length === 1 && simpleNotice.getSnapshot() !== null
    && simpleNotice.retryCapture === undefined,
  'ordinary archive shows a dismissible success notice without invoking obsolete capture or retry');
  removeSimpleInterceptor();
  simpleNotice.dismiss();

  let settingsOpen = false;
  let settingsTriggerClicks = 0;
  let archiveNavClicks = 0;
  let viewPaints = 0;
  const settingsTrigger = { textContent: '设置', click: () => { settingsTriggerClicks += 1; settingsOpen = true; } };
  const unrelatedDialogTrigger = { textContent: '打开预览', click: () => {} };
  const archiveNav = { textContent: ' 归档管理 ', click: () => { archiveNavClicks += 1; } };
  const generalNav = { textContent: '通用', click: () => {} };
  const settingsDocument = {
    querySelectorAll(selector) {
      if (selector === '[role="dialog"] nav button') return settingsOpen ? [generalNav, archiveNav] : [];
      if (selector === 'button[aria-haspopup="dialog"]') return [unrelatedDialogTrigger, settingsTrigger];
      return [];
    },
  };
  const openedArchiveSettings = await clientExports.__test.openArchiveSettings?.(
    (key) => ({ nav: '归档管理', 'archiveNotice.settings': '设置' })[key] ?? key,
    settingsDocument,
    async () => { viewPaints += 1; },
  );
  assert(openedArchiveSettings === true && settingsTriggerClicks === 1 && viewPaints === 2 && archiveNavClicks === 1,
    'archive notice View opens Settings and selects the archived-chat section after it mounts');
  settingsOpen = true;
  const reopenedArchiveSettings = await clientExports.__test.openArchiveSettings?.(
    (key) => ({ nav: '归档管理', 'archiveNotice.settings': '设置' })[key] ?? key,
    settingsDocument,
    async () => { viewPaints += 1; },
  );
  assert(reopenedArchiveSettings === true && settingsTriggerClicks === 1 && archiveNavClicks === 2,
    'archive notice View reuses an already-open Settings panel without reopening it');
  const missingArchiveSettings = await clientExports.__test.openArchiveSettings?.(
    (key) => key,
    { querySelectorAll: () => [] },
    async () => {},
  );
  assert(missingArchiveSettings === false, 'archive notice View reports failure when the host Settings surface is unavailable');

  const overlayTimers = [];
  const overlayCancelledTimers = [];
  let overlayViewCalls = 0;
  let overlayUndoCalls = 0;
  const overlayController = clientExports.__test.createArchiveNoticeController?.({
    durationMs: 3000,
    schedule: (callback, delay) => { overlayTimers.push({ callback, delay }); return overlayTimers.length; },
    cancel: (id) => { overlayCancelledTimers.push(id); },
    view: async () => { overlayViewCalls += 1; return true; },
    undo: async () => { overlayUndoCalls += 1; },
  });
  overlayController?.show('session-overlay');
  const overlayT = (key) => ({
    'archiveNotice.title': '已归档的聊天',
    'archiveNotice.view': '查看',
    'archiveNotice.undo': '撤销',
    'archiveNotice.undoing': '正在撤销',
    'archiveNotice.retry': '重试',
    'archiveNotice.close': '关闭归档提示',
  })[key] ?? key;
  let archiveOverlayTree = clientExports.__test.ArchiveNoticeOverlay?.({ controller: overlayController, t: overlayT });
  let archiveOverlayElements = collectElements(archiveOverlayTree);
  const archiveOverlayView = archiveOverlayElements.find((element) => element.type === 'button' && elementText(element) === '查看');
  const archiveOverlayUndo = archiveOverlayElements.find((element) => element.type === 'button' && elementText(element) === '撤销');
  const archiveOverlayClose = archiveOverlayElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '关闭归档提示');
  assert(archiveOverlayTree?.props?.role === 'region'
    && archiveOverlayTree?.props?.['aria-live'] === 'polite'
    && elementText(archiveOverlayTree).includes('已归档的聊天')
    && archiveOverlayElements.some((element) => element.type === 'svg'),
  'archive success overlay announces the archived state and renders its archive icon without stealing focus');
  assert(archiveOverlayView !== undefined && archiveOverlayUndo !== undefined && archiveOverlayClose !== undefined,
    'archive success overlay exposes View, Undo, and an accessible close action');
  archiveOverlayTree?.props.onMouseEnter();
  archiveOverlayTree?.props.onMouseLeave();
  archiveOverlayTree?.props.onFocusCapture();
  archiveOverlayTree?.props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null });
  assert(overlayCancelledTimers.length === 2 && overlayTimers.length === 3,
    'archive success overlay pauses and resumes its timer for both pointer and keyboard interaction');
  archiveOverlayView?.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(overlayViewCalls === 1 && overlayController?.getSnapshot() === null,
    'archive success overlay View action delegates to the controller');
  overlayController?.show('session-overlay-undo');
  archiveOverlayTree = clientExports.__test.ArchiveNoticeOverlay?.({ controller: overlayController, t: overlayT });
  archiveOverlayElements = collectElements(archiveOverlayTree);
  archiveOverlayElements.find((element) => element.type === 'button' && elementText(element) === '撤销')?.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(overlayUndoCalls === 1 && overlayController?.getSnapshot() === null,
    'archive success overlay Undo action delegates to the controller');
  overlayController?.show('session-overlay-close');
  archiveOverlayTree = clientExports.__test.ArchiveNoticeOverlay?.({ controller: overlayController, t: overlayT });
  collectElements(archiveOverlayTree).find((element) => element.type === 'button' && element.props?.['aria-label'] === '关闭归档提示')?.props.onClick();
  assert(overlayController?.getSnapshot() === null, 'archive success overlay close action dismisses immediately');

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
  assert(groupedLineage?.[0]?.roots?.[1]?.sourceParent?.id === 'fork-b'
    && groupedLineage?.[1]?.roots?.[0]?.sourceParent?.id === 'origin-a'
    && workspaceForest[0].children[0].id === 'fork-b',
    'splitting workspaces retains the exact parent source without mutating the original forest');

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
  const lineageRowTree = clientExports.__test.LineageTreeNodes?.({
    nodes: [{
      id: 'session-source-1234567890-abcdefgh', title: '来源会话', status: 'active', origin: null, delegationDepth: 0, createdAt: 1,
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
  assert(!lineagePrimaryLabels.includes('来源会话') && lineagePrimaryLabels.includes('未命名会话')
    && lineageContexts.length === 0
    && lineageSourceContexts.some((element) => elementText(element).includes('来源于：来源会话'))
    && !lineagePrimaryLabels.includes(fullLineageId),
  'active ancestors render inside managed cards instead of occupying standalone relationship rows');
  assert(lineageRowElements.filter((element) => element.props?.role === 'listitem').length === 1
    && lineageRowElements.find((element) => element.props?.role === 'listitem')?.props?.['aria-level'] === 1,
  'transparent source context does not leave an empty hierarchy level before a managed card');
  assert(lineageIdTexts.length === 1 && lineageIdTexts.every((element) => element.props?.children !== element.props?.title)
    && lineageIdTexts.some((element) => element.props?.title === fullLineageId && element.props?.children === 'session-d81d…b5a81712'),
  'only managed relationship cards show a compact session ID while retaining the full ID on hover');
  assert(lineageText.includes('来源于：来源会话') && !lineageText.includes('活动会话，仅用于解释关系')
    && lineageText.includes('从「来源会话」分出')
    && lineageText.includes('子代理 · 委派层级 1')
    && lineageText.includes('项目：项目一')
    && !lineageText.includes('· d0 ·'),
  'relationship cards explain source, project, type, and delegation without developer shorthand');
  assert(lineageRows.length === 1 && lineageRows[0].props.className.includes('dac-lineage-row-archived')
    && lineageContexts.length === 0 && lineageSourceContexts.length === 1,
  'fork source context stays inside the managed card instead of rendering a separate context strip');
  assert(!elementText(lineageMetadata).includes('创建于')
    && elementText(lineageCreated).startsWith('创建于 ')
    && collectElements(lineageFooter).some((element) => element.props?.className === 'dac-lineage-id-actions'),
  'managed relationship cards place creation time and copy-ID actions together in a dedicated footer row');
  assert(lineageSources.every((element) => element.props.style?.overflowWrap === 'anywhere'),
  'relationship source labels wrap long unbroken titles on narrow layouts');
  assert(lineageStatus?.props.style?.borderRadius === '8px'
    && lineageStatus?.props.style?.whiteSpace === 'nowrap'
    && lineageStatus?.props.style?.flexShrink === 0,
  'lineage status renders as a non-wrapping rounded rectangle instead of a pill');
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
  const connectorToggles = connectorElements.filter((element) => element.type === 'button' && element.props?.className === 'dac-lineage-toggle');
  const connectorRails = connectorElements.filter((element) => element.props?.className === 'dac-lineage-rail');
  assert(connectorItems.every((element) => element.props?.style?.marginLeft === undefined)
    && continuingGuide !== undefined && childJunctions.length === 2,
    'lineage hierarchy retains explicit relationship connectors');
  assert(childGuideCounts.every((count) => count === 0), 'first-level branches do not add empty guide columns');
  assert(connectorToggles.length === 2
    && connectorRails.every((rail) => !collectElements(rail).some((element) => element.type === 'button')),
    'branch disclosures sit beside titles rather than in the connector rail');
  const rootRow = connectorElements.find((element) => element.props?.className === 'dac-lineage-heading');
  const rootToggleButton = collectElements(rootRow).find((element) => element.props?.className === 'dac-lineage-toggle');
  assert(rootToggleButton !== undefined && typeof rootRow?.props.onClick !== 'function',
    'branch expansion uses a dedicated title-side button, not a clickable detail card');
  let stoppedTogglePropagation = false;
  rootToggleButton?.props.onClick({ stopPropagation: () => { stoppedTogglePropagation = true; } });
  assert(stoppedTogglePropagation && toggledConnectorId === 'root-connector',
    'one branch disclosure click targets its parent exactly once');
  const compactDetails = connectorElements.filter((element) => element.type === 'details');
  assert(compactDetails.length === 4 && compactDetails.every((element) => !element.props.open)
    && compactDetails.every((element) => collectElements(element).some((child) => child.props?.className === 'dac-lineage-id')),
    'session IDs and timestamps are available in closed native details instead of always-open cards');
  const collapsedConnectorTree = clientExports.__test.LineageTreeNodes?.({
    nodes: connectorNodes,
    collapsed: new Set(['root-connector']),
    onToggle: () => {},
    t: lineageT,
  });
  const collapsedRootToggle = collectElements(collapsedConnectorTree)
    .find((element) => element.type === 'button' && element.props?.className === 'dac-lineage-toggle');
  const collapsedRootIcon = collectElements(collapsedRootToggle)
    .find((element) => element.type === 'span' && element.props?.className?.includes('dac-chev'));
  assert(collapsedRootToggle?.props?.['aria-expanded'] === false && collapsedRootIcon?.props?.className === 'dac-chev open',
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
    id: 'parent-without-a-readable-title-1234567890', title: null, status: 'active', origin: null, delegationDepth: 0, createdAt: 1,
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
  assert(zhSourceLabels.includes('从「来源信息不可用」分出') && enSourceLabels.includes('Branched from "Source information unavailable"'),
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
  assert(zhDict['export.all'] === '全部导出' && zhDict['export.selected'] === '导出选中项', 'Chinese export actions are localized');
  assert(zhDict['archiveNotice.title'] === '已归档的聊天'
    && zhDict['archiveNotice.view'] === '查看'
    && zhDict['archiveNotice.undo'] === '撤销',
  'Chinese archive success notice copy is localized');
  assert(zhDict['trash.status.legacy'] === undefined
    && zhDict['trash.confirm.emptyBody'] === '这将永久删除回收站中所有工作区的会话和保护快照。',
  'Chinese Recycle Bin copy has no retired legacy state');
  assert(clientCalls.localeRegister[0].dicts.en['export.row'] === undefined, 'single-chat export copy is removed');
  assert(clientCalls.localeRegister[0].dicts.en['nav'] === 'Archive Management'
    && clientCalls.localeRegister[0].dicts.en['page.title'] === 'Archive Management',
  'English archive management label and page title match the documented settings entry');
  assert(clientCalls.localeRegister[0].dicts.en['archiveNotice.title'] === 'Chat archived'
    && clientCalls.localeRegister[0].dicts.en['archiveNotice.view'] === 'View'
    && clientCalls.localeRegister[0].dicts.en['archiveNotice.undo'] === 'Undo',
  'English archive success notice copy is localized');
  assert(clientCalls.localeRegister[0].dicts.en['trash.status.legacy'] === undefined
    && clientCalls.localeRegister[0].dicts.en['trash.confirm.emptyBody'] === 'This permanently deletes the chats and protection snapshots from every workspace in the Recycle Bin.',
  'English Recycle Bin copy has no retired legacy state');
	  assert(clientCalls.slotRegister.length === 2, `settings and shell overlay register exactly twice without requiring an unreleased Host slot (got ${clientCalls.slotRegister.length})`);
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
	  assert(overlayRegistration?.meta?.id === 'archived-chats-success'
	    && overlayRegistration?.meta?.locale === 'settings.archived-chats'
	    && typeof overlayRegistration?.component === 'function',
	  'archive success notice registers in the frame-wide shell overlay');
	  assert(workspaceActionRegistration === undefined,
	  'the public plugin does not register an unreleased workspace-menu Host slot');
  const noticeController = overlayRegistration?.meta?.inject?.().controller;
  const savedNoticeFetch = globalThis.fetch;
  let noticeUndoRequest = null;
  globalThis.fetch = async (url, options = {}) => {
    noticeUndoRequest = { url, options };
    return { ok: true, status: 200, json: async () => ({ ok: true, archivedSessionIds: [] }) };
  };
  await clientServices.workspaces.archiveSession('session-notice');
  assert(clientCalls.workspaceArchive.at(-1) === 'session-notice'
    && noticeController?.getSnapshot()?.sessionId === 'session-notice',
  'the real plugin lifecycle shows the shell notice only after a successful workspace archive');
  await noticeController?.undo();
  assert(noticeUndoRequest?.url === '/plugins/dsh-archived-chats/unarchive'
    && noticeUndoRequest?.options?.headers?.['x-dsh-archived-chats'] === '1'
    && noticeUndoRequest?.options?.body === '{"sessionId":"session-notice"}'
    && clientCalls.workspaceRefresh === 1,
  'shell notice Undo uses the guarded unarchive route and refreshes the workspace projection');
  globalThis.fetch = savedNoticeFetch;
  const style = headChildren.find((c) => c.id === 'dsh-archived-chats-css');
  assert(style !== undefined, 'page stylesheet injected into <head>');
  assert(style?.attrs['data-plugin-css'] === 'dsh-archived-chats', 'stylesheet carries the data-plugin-css marker');
  assert(style?.textContent.includes('.dac-row'), 'stylesheet paints the chat rows');
  assert(
    /\.dac-title\{[^}]*flex:none[^}]*white-space:nowrap[^}]*\}/u.test(style?.textContent ?? ''),
    'page title stays on one line when header actions wrap',
  );
  assert(
    style?.textContent.includes('.dac-head{align-items:flex-start;flex-wrap:wrap}')
      && style?.textContent.includes('.dac-head-actions{width:100%;justify-content:flex-start}'),
    'narrow layouts move the compact action group below the single-line title',
  );
  assert(
    style?.textContent.includes('background:var(--dsw-specific-menu)')
      && style?.textContent.includes('border:1px solid var(--dsw-alias-border-inverted)')
      && style?.textContent.includes('box-shadow:var(--dsw-shadow-lv3)'),
    'menus and dialogs use the rc.7 overlay surface tokens',
  );
  assert(
    style?.textContent.includes('var(--dsw-alias-state-error-primary)')
      && style?.textContent.includes('var(--dsw-alias-interactive-bg-hover-danger)')
      && style?.textContent.includes('var(--dsw-alias-state-success-primary)')
      && style?.textContent.includes('var(--dsw-alias-state-success-tertiary)'),
    'destructive and success states use rc.7 semantic tokens',
  );
  assert(
    !/(?:#e5484d|#d13438|#30a46c|#2f9e68|rgba\(229,72,77|rgba\(48,164,108)/i.test(style?.textContent ?? ''),
    'legacy hard-coded destructive and success colors are absent',
  );
  assert(style?.textContent.includes('.dac-tag-editor') && style?.textContent.includes('.dac-tag-editor .dac-chip span{'), 'token tag editor has layout, focus, and long-label styling');
  assert(style?.textContent.includes('.dac-archive-notice{')
    && style?.textContent.includes('.dac-archive-notice-undo{')
    && style?.textContent.includes('.dac-archive-notice-actions{')
    && style?.textContent.includes('@media (max-width:640px){.dac-archive-notice{')
    && style?.textContent.includes('.dac-archive-notice-actions{flex-wrap:wrap;justify-content:flex-end}'),
  'archive success notice has stable desktop and wrapping narrow-screen styling');
  assert(style?.textContent.includes('.dac-lineage-diagnostic{')
    && style?.textContent.includes('white-space:normal;overflow-wrap:anywhere'),
  'relationship diagnostics wrap completely inside managed cards');
  assert(style?.textContent.includes('@media (max-width:480px){.dac-row-select{width:100%;flex-basis:100%}')
    && style?.textContent.includes('.dac-row-actions{width:100%;justify-content:flex-end}'),
  'phone archive rows reserve a full readable line for identity before wrapping actions');
  assert(!clientSource.includes('settings.plugin.item'), 'rc.7 keyed plugin-item slot is not used by the settings section');
}

function renderTestComponent(node) {
  if (node.type.name !== 'NotePreview') return node.type(node.props ?? {});
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
    const buttons = collectElements(tabsTree).filter((element) => element.props?.role === 'tab');
    const controls = buttons.map(() => ({ focus() { controls.focused = this; } }));
    for (const control of controls) control.parentElement = { querySelectorAll: () => controls };
    buttons[0].props.onKeyDown({ key: 'ArrowRight', currentTarget: controls[0], preventDefault() {} });
    buttons[4].props.onKeyDown({ key: 'Home', currentTarget: controls[4], preventDefault() {} });
    buttons[0].props.onKeyDown({ key: 'End', currentTarget: controls[0], preventDefault() {} });
    assert(buttons.map((button) => button.props.tabIndex).join(',') === '0,-1,-1,-1,-1'
      && changes.join(',') === 'trash,archived,about'
      && controls.focused === controls[4],
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
  const head = elements.find((element) => element.props?.className === 'dac-head');
  const deleteAll = collectElements(head).find((element) => element.type === 'button' && elementText(element) === '全部删除');
  assert(deleteAll !== undefined, 'archive Delete all action sits in the page-title row');
  assert(elements.filter((element) => element.type === 'button' && elementText(element) === '取消归档').length === 3,
    'individual unarchive actions remain available');
  assert(elements.filter((element) => element.type === 'button' && element.props?.['aria-label'] === '永久删除').length === 3,
    'individual permanent-delete actions remain available');
  assert(elements.filter((element) => element.type === 'button' && element.props?.['aria-label'] === '…').length === 2,
    'each workspace keeps its More menu');

  deleteAll?.props.onClick();
  tree = render();
  let dialog = findComponentElement(tree, 'ConfirmDialog');
  assert(dialog?.props.title === '删除全部已归档聊天？', 'global archive deletion has a specific confirmation title');
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
console.log('\n[11c] client half — archive insights UI');
{
  const savedHooks = { ...moduleTable.react };
  const archivedRows = [
    {
      id: 'session-a', title: 'Alpha', createdAt: 10, origin: null,
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
	states[0] = { value: archivedRows, setter: null };
	states[15] = { value: '', setter: null };
	states[16] = { value: 'ready', setter: null };
	states[17] = { value: 'ready', setter: null };
	states[18] = { value: statsFixture, setter: null };
	states[19] = { value: null, setter: null };
	states[20] = { value: false, setter: null };
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
  const importTrigger = elements.find((el) => el.type === 'button' && elementText(el) === '导入备份');
  const exportTrigger = elements.find((el) => el.type === 'button' && elementText(el) === '全部导出');
  const moreTrigger = elements.find((el) => el.type === 'summary' && elementText(el) === '更多');
  assert(importTrigger !== undefined && exportTrigger !== undefined && moreTrigger !== undefined, 'backup actions are inside the header More disclosure');
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
	states[13].value = null;
  tree = renderSection();
  elements = collectElements(tree);

  const renderedMoreTrigger = elements.find((el) => el.type === 'button' && elementText(el) === '更多');
  renderedMoreTrigger?.props.onClick();
  tree = renderSection();
  elements = collectElements(tree);
  const moreMenu = elements.find((el) => el.props?.className === 'dac-action-menu');
  assert(moreMenu === undefined, 'archive header has no duplicate more menu');

  const summary = elements.find((el) => el.props?.className === 'dac-summary dac-filter-summary');
  assert(summary === undefined, 'archive filters omit the redundant global count and size');
  assert(elements.filter((el) => el.type === 'select' && ['所有项目', '全部标签'].includes(el.props?.['aria-label'])).length === 2 && elements.some((el) => el.type === 'summary' && el.props?.['aria-label'] === '全部聊天'), 'filters consist of combined type/sort, project and tag entries');
  const filtersWithSummary = elements.find((el) => el.props?.className === 'dac-filters');
  assert(filtersWithSummary?.props.children.filter(Boolean).length === 3, 'archive has exactly three filter entries');
  assert(elements.findIndex((el) => el.props?.className === 'dac-search') < elements.indexOf(filtersWithSummary), 'search appears above filters and summary');

  const importInput = elements.find((el) => el.type === 'input' && el.props?.type === 'file' && el.props?.accept === '.zip,application/zip');
  assert(importInput?.props.accept === '.zip,application/zip' && importInput?.props.hidden === true, 'import file picker is hidden and accepts ZIP backups');

	states[21].value = {
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
	states[22].value = false;
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
  assert(states[21].value !== null && busyImportCancel?.props.disabled === true,
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
	  states[21].value = {
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
	states[21].value = null;
	states[18].value = statsFixture;
  tree = renderSection();
  elements = collectElements(tree);

  const tagSelect = elements.find((el) => el.type === 'select' && el.props?.['aria-label'] === '全部标签');
  assert(tagSelect !== undefined, 'tag filter select rendered');
  assert(tagSelect?.props.value === '', 'tag filter defaults to the non-colliding no-filter sentinel');
  const importantOptions = tagSelect?.props.children.filter((option) => String(option.props.children).toLowerCase() === 'important') ?? [];
  assert(importantOptions.length === 1, 'tag filter options de-duplicate labels case-insensitively');
	states[15].value = 'all';
  tree = renderSection();
  elements = collectElements(tree);
  const filteredRows = elements.filter(isRow);
  assert(filteredRows.length === 1 && elementText(filteredRows[0]).includes('Beta'), 'selecting the literal all tag renders only sessions carrying that tag');
	states[15].value = '';
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
  const rowActionChildren = rowActions.props.children.filter(Boolean);
  assert(rowActionChildren.every((el) => el?.type === 'button') && rowActionChildren.length === 4,
    'row exposes preview, metadata edit, unarchive, and permanent delete without a More menu');
  const alphaEdit = editButtonsIn(alphaRow)[0];
  assert(alphaEdit?.props.className === 'dac-iconbtn' && elementText(alphaEdit) === '', 'metadata editing uses a named icon button');
  assert(rowActionChildren[1] === alphaEdit, 'metadata edit is the second row action after preview');
  assert(!collectElements(alphaRow).some((el) => el.type === 'details')
    && !elements.some((el) => el.type === 'button' && el.props?.['aria-label'] === '导出本条'),
  'archive rows remove the single-chat export and row More menu');
  const quickDelete = collectElements(rowActions).find((el) => el.type === 'button' && el.props?.['aria-label'] === '永久删除');
  assert(quickDelete?.props.className === 'dac-unarchive dac-danger' && elementText(quickDelete) === '删除'
    && !collectElements(quickDelete).some((el) => el.type === 'svg'), 'row exposes deletion as a named text button without a trash icon');
  assert(rowActionChildren.indexOf(quickDelete) === rowActionChildren.findIndex((el) => el?.props?.className === 'dac-unarchive') + 1,
    'text deletion appears immediately after unarchive');
  const styleText = headChildren.find((child) => child.id === 'dsh-archived-chats-css')?.textContent ?? '';
  assert(styleText.includes('.dac-iconbtn{') && styleText.includes('width:28px;height:28px'), 'row icon dimensions remain stable');
  assert(styleText.includes('.dac-action-trigger{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;')
    && styleText.includes('.dac-unarchive{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;')
    && styleText.includes('.dac-btn-danger{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:9px;'),
  'archive and Recycle Bin text actions share the Delete all corner radius');

  assert(alphaEdit !== undefined, 'row exposes a metadata edit action');
  assert(alphaEdit?.props.disabled !== true, 'edit action enabled when metadata is ready');
  let editFocuses = 0;
  const editTrigger = { focus: () => { editFocuses += 1; documentMock.activeElement = editTrigger; } };
  documentMock.activeElement = editTrigger;
  alphaEdit.props.onClick();
  tree = renderSection();
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
	assert(states[19].value === null, 'metadata Escape cancels only the metadata editor state');
  cleanupMeta?.();
  assert(editFocuses === 1 && documentMock.activeElement === editTrigger, 'metadata dialog restores focus to the row edit button');

	states[19].value = archivedRows[0];
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
  assert(states[19].value?.id === 'session-a' && busyMetadataCancel?.props.disabled === true,
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
  const betaRow = rows.find((row) => elementText(row).includes('Beta'));
  editButtonsIn(betaRow)[0].props.onClick();
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
	states[19].value = commaTagSession;
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
	states[16].value = 'unavailable';
	states[19].value = null;
  tree = renderSection();
  elements = collectElements(tree);
  const disabledEdits = elements.filter((el) => el.type === 'button' && el.props?.['aria-label'] === '编辑标签与备注');
  assert(disabledEdits.length === 3 && disabledEdits.every((el) => el.props?.disabled === true), 'metadata edit disabled when metadata is unavailable');
  assert(elements.find((el) => el.props?.className === 'dac-warn') !== undefined, 'unavailable metadata shows a warning');
  assert(elements.filter(isRow).length === 3, 'unavailable metadata keeps all rows listed');

  // An unreadable recycle catalog means the listing cannot be trusted to exclude
  // already-deleted chats, so it has to be labelled rather than shown as normal.
	states[16].value = 'ready';
	states[17].value = 'unavailable';
  tree = renderSection();
  elements = collectElements(tree);
  const trashWarn = elements.filter((el) => el.props?.className === 'dac-warn');
  assert(trashWarn.length === 1 && elementText(trashWarn[0]).includes('回收站目录无法读取'),
    'an unreadable recycle catalog is surfaced on the archived list');
  assert(elements.filter(isRow).length === 3, 'the warning never hides rows');
	states[17].value = 'ready';
  tree = renderSection();
  assert(collectElements(tree).filter((el) => el.props?.className === 'dac-warn').length === 0,
    'a readable recycle catalog shows no warning');

  // Statistics failure never removes rows or lifecycle actions.
	states[18].value = { status: 'error', summary: null, sessions: {} };
	states[16].value = 'ready';
  tree = renderSection();
  elements = collectElements(tree);
  assert(elements.filter(isRow).length === 3, 'statistics failure keeps all rows rendered');
  assert(elements.filter((el) => el.type === 'button' && elementText(el) === '取消归档').length === 3, 'statistics failure keeps unarchive actions');
  assert(elements.filter((el) => el.type === 'button' && el.props?.['aria-label'] === '编辑标签与备注').every((el) => el.props?.disabled !== true), 'statistics failure keeps metadata editing usable');

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

  const searchInput = elements.find((element) => element.type === 'input' && element.props?.placeholder === '搜索标题、标签、备注和聊天内容');
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
  const filteredSearch = elements.find((element) => element.type === 'input' && element.props?.placeholder === '搜索标题、标签、备注和聊天内容');
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
  assert(tabs.map((tab) => elementText(tab)).join(',') === '已归档,回收站,空间与策略,来源与分支,关于',
    'archive manager keeps management tabs before the final About tab');
  assert(tabs[0]?.props['aria-selected'] === true && tabs.slice(1).every((tab) => tab.props['aria-selected'] === false), 'Archived is the default selected tab');
  assert(requests.every((request) => !request.path.includes('/history')), 'retired History API is never requested');

  for (const [index, actionCount] of [[0, 5], [1, 2], [2, 0], [3, 0], [4, 0]]) {
    if (!tabs[index]) { assert(false, `tab ${index} exists`); continue; }
    tabs[index].props.onClick();
    const modeTree = harness.render({ t, refreshSidebar: () => {} });
    const actionRegions = collectElements(modeTree).filter((item) => item.props?.className === 'dac-head-actions');
    assert(actionRegions.length === 1, `tab ${index} retains a single header action region to prevent layout collapse`);
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
  const storageElement = findComponentElement(tree, 'StorageRetentionPanel');
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
    assert(insightCards.length === 5
      && insightCards.every((card) => card.props?.style?.textAlign === 'center' && card.props?.style?.alignItems === 'center'),
      'storage summary cards center their labels, values, and detail actions');
    assert(insightDetailButtons.length === 2
      && insightDetailButtons.every((button) => button.props?.style?.alignSelf === 'center'),
      'storage summary detail buttons are centered inside their cards');
    assert(storageElements.some((element) => element.props?.role === 'note' && elementText(element).includes('归档列表为空')),
      'storage view explains why retained snapshots can remain without archived chats');
    assert(!storageText.includes('Alpha 归档') && !storageText.includes('snapshot-active')
      && storageText.includes('自动永久删除'),
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
    assert(relationshipElements.some((element) => element.props?.role === 'note' && elementText(element).includes('不受本插件管理')),
      'origins and branches view explains that relationship context is not managed');
    assert(elementText(relationshipsTree).includes('暂无已归档或回收站会话的来源与分支'),
      'origins and branches view has a scoped empty state');
    relationshipsHarness.unmount();

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
      ['Chinese', t, '父会话缺失，无法读取来源会话信息'],
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
    const leafFilterActions = leafRelationshipElements.find((element) => element.props?.className === 'dac-lineage-filter-actions');
    const leafFilterWrappers = collectElements(leafFilterActions).filter((element) => element.props?.className?.includes('dac-select-wrap'));
    const leafFilterSelects = collectElements(leafFilterActions).filter((element) => element.type === 'select');
    const leafFold = leafRelationshipElements.find((element) => element.type === 'button' && element.props?.className === 'dac-lineage-fold');
    const leafFoldIcon = collectElements(leafFold)
      .find((element) => element.type === 'span' && element.props?.className?.includes('dac-chev'));
    assert(leafFilterSelects.length === 2
      && leafFilterWrappers.every((element) => element.props?.className === 'dac-select-wrap dac-select-wrap-fill')
      && leafFilterSelects.every((element) => element.props?.className === 'dac-select dac-select-fill'),
      'lineage project and status filters fill their right-aligned wrappers so each chevron stays inside its control');
    assert(leafFold?.props?.disabled === false && elementText(leafFold) === '全部折叠' && leafFoldIcon?.props?.className === 'dac-chev collapse',
      'leaf-only lineage can still collapse its workspace');
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
    const projectSelect = richRelationshipElements.find((element) => element.type === 'select' && element.props?.['aria-label'] === '筛选项目');
    const statusSelect = richRelationshipElements.find((element) => element.type === 'select' && element.props?.['aria-label'] === '筛选状态');
    let foldAll = richRelationshipElements.find((element) => element.type === 'button' && element.props?.className === 'dac-lineage-fold');
    const initialRelationshipItems = richRelationshipElements.filter((element) => element.props?.role === 'listitem');
    assert(richRelationshipElements.some((element) => element.props?.role === 'list')
      && !richRelationshipElements.some((element) => ['tree', 'treeitem'].includes(element.props?.role)),
    'relationship hierarchy uses native list and disclosure semantics instead of an incomplete ARIA tree widget');
    assert(initialRelationshipItems.length === 2
      && elementText(projectSelect).includes('Project Alpha') && elementText(projectSelect).includes('Project Beta')
      && statusSelect !== undefined && elementText(richRelationshipsTree).includes('3 个已管理会话'),
    'small lineage trees hide standalone source rows while exposing project, status, and managed-result controls');
    const initialFoldIcon = collectElements(foldAll)
      .find((element) => element.type === 'span' && element.props?.className?.includes('dac-chev'));
    assert(richRelationshipElements.filter((element) => element.type === 'button' && element.props?.className === 'dac-lineage-fold').length === 1
      && elementText(foldAll) === '全部展开' && initialFoldIcon?.props?.className === 'dac-chev open',
    'lineage starts with roots visible and deeper branches folded even for small trees');

    foldAll?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);
    assert(richRelationshipElements.filter((element) => element.props?.role === 'listitem').length === 3,
      'expand all reveals every branch');
    const workspaceHeaders = richRelationshipElements.filter((element) => element.props?.className === 'dac-lineage-workspace-toggle');
    assert(workspaceHeaders.length === 2
      && elementText(workspaceHeaders[0]).includes('Project Alpha')
      && elementText(workspaceHeaders[0]).includes('2'),
      'managed relationships are grouped under named workspaces with total counts');
    workspaceHeaders[0]?.props.onClick();
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
      && collectElements(richRelationshipsTree).filter((element) => element.props?.className === 'dac-lineage-workspace-toggle').length === 2,
      'collapse all leaves only workspace headings visible');
    collectElements(richRelationshipsTree).find((element) => element.props?.className === 'dac-lineage-fold')?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);

    statusSelect?.props.onChange({ target: { value: 'trash' } });
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);
    assert(elementText(richRelationshipsTree).includes('Source root') && elementText(richRelationshipsTree).includes('Beta branch')
      && !elementText(richRelationshipsTree).includes('Alpha branch') && elementText(richRelationshipsTree).includes('1 个已管理会话'),
    'status filter keeps necessary source context while showing only matching managed cards');
    statusSelect?.props.onChange({ target: { value: 'all' } });
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);

    const rootToggle = richRelationshipElements.find((element) => element.type === 'button' && element.props?.className === 'dac-lineage-toggle');
    rootToggle?.props.onClick();
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    richRelationshipElements = collectElements(richRelationshipsTree);
    const relationshipSearch = richRelationshipElements.find((element) => element.type === 'input' && element.props?.placeholder === '搜索会话或项目');
    assert(richRelationshipElements.filter((element) => element.props?.role === 'listitem').length === 2,
      'individual branch collapse hides its descendants');
    relationshipSearch?.props.onChange({ target: { value: 'Needle' } });
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    const searchRelationshipElements = collectElements(richRelationshipsTree);
    const searchFoldControls = searchRelationshipElements.filter((element) => element.type === 'button'
      && ['dac-lineage-toggle', 'dac-lineage-fold'].includes(element.props?.className));
    assert(elementText(richRelationshipsTree).includes('Needle chat'), 'lineage search automatically reveals a matching path inside a collapsed branch');
    assert(searchFoldControls.length > 0 && searchFoldControls.every((button) => button.props.disabled === true),
      'search-expanded relationship paths disable fold controls that cannot visibly take effect');
    relationshipSearch?.props.onChange({ target: { value: '' } });
    richRelationshipsTree = richRelationshipsHarness.render({ t });
    assert(!elementText(richRelationshipsTree).includes('Needle chat'), 'clearing lineage search restores the user\'s previous collapsed state');

    const expandAfterSearch = collectElements(richRelationshipsTree).find((element) => element.type === 'button' && elementText(element) === '全部展开');
    expandAfterSearch?.props.onClick();
    projectSelect?.props.onChange({ target: { value: 'ws-beta' } });
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

  const trashHead = elements.find((element) => element.props?.className === 'dac-head');
  const trashTabs = elements.find((element) => element.props?.className === 'dac-tabs');
  const emptyButton = collectElements(trashHead).find((element) => element.type === 'button' && elementText(element) === '清空回收站');
  assert(elementText(trashHead).startsWith('归档管理') && emptyButton !== undefined
    && !collectElements(trashTabs).some((element) => elementText(element) === '清空回收站'),
  'Empty Recycle Bin action sits at the top right of the page-title row');
  const trashHeaderButtons = collectElements(trashHead).filter((element) => element.type === 'button');
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
      return actions.length === 3 && actions[0].props.className === 'dac-iconbtn'
        && elementText(actions[1]) === '恢复' && elementText(actions[2]) === '删除';
    }),
  'Recycle Bin rows keep preview then compact Restore and Delete text actions with permanent-delete accessibility labels');

  const trashGroup = (title) => collectElements(harness.render(recycleProps)).find((element) => element.props?.className === 'dac-group dac-trash-group'
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

  tree = harness.render(recycleProps);
  elements = collectElements(tree);

  const collapseProject = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '折叠' && elementText(element).includes('项目一'));
  assert(collapseProject?.props['aria-expanded'] === true, 'Recycle Bin project group starts expanded');
  collapseProject?.props.onClick();
  tree = harness.render(recycleProps);
  elements = collectElements(tree);
  assert(!elementText(tree).includes('Trash Alpha'), 'collapsing a Recycle Bin project hides every row in that project');
  assert(JSON.parse(storageMap.get('dsh-archived-chats:collapsed') ?? '{}')['trash:ws-1'] === true, 'Recycle Bin collapse preference uses a tab-specific key');
  elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '展开' && elementText(element).includes('项目一'))?.props.onClick();
  tree = harness.render(recycleProps);
  elements = collectElements(tree);

  const ordinaryPreview = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看对话 Trash Alpha');
  await ordinaryPreview?.props.onClick();
  const previewRequest = requests.findLast((request) => request.path.endsWith('/preview'));
  assert(JSON.parse(previewRequest?.options.body ?? '{}').scope === 'trash', 'ordinary Recycle Bin preview is explicitly trash-scoped');
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

  elements = collectElements(tree);
  const currentHead = elements.find((element) => element.props?.className === 'dac-head');
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
  assert(elementText(tree).includes('批量归档') && !elementText(tree).includes('批量归档工作区'), 'archive toolbar uses the shorter bulk archive label');
  assert(elementText(tree).includes('v1.3.3'), 'title row displays the loaded backend version');
  const updateLink = collectElements(tree).find(el => el.type === 'a' && elementText(el) === '去更新');
  assert(updateLink?.props.href === about.links.marketplace, 'new-version header action opens the market rather than running installation');
  const automaticChecks = requests.filter(request => request.path.endsWith('/about/check-updates'));
  assert(automaticChecks.length === 1 && automaticChecks[0].options.body === '{"force":false}', 'opening archive performs one cache-aware metadata check');
  collectElements(tree).find(el => el.props?.role === 'tab' && elementText(el) === '关于')?.props.onClick();
  tree = render();
  const aboutPanel = findComponentElement(tree, 'AboutPanel');
  assert(aboutPanel !== undefined && elementText(tree).includes('Ultronen') && elementText(tree).includes('MIT'), 'About shows package identity and license');
  if (aboutPanel) {
    assert(!collectElements(aboutPanel).some(el => /^h[1-6]$/.test(el.type)), 'About does not repeat the plugin title already shown in the page heading');
    assert(elementText(aboutPanel).startsWith('本插件用于查看和管理 DeepSeek Harness 的归档会话，支持按工作区批量归档、备份导入导出及回收站恢复。'), 'About opens directly with the agreed plugin description');
    const en = clientCalls.localeRegister[0].dicts.en;
    const englishPanel = aboutPanel.type({ ...aboutPanel.props, t: key => en[key] ?? key });
    assert(!collectElements(englishPanel).some(el => /^h[1-6]$/.test(el.type)) && elementText(englishPanel).startsWith('This plugin'), 'English About also starts with an introduction without a repeated title');
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
  assert(elementText(tree).includes('当前版本 · v1.3.3') && elementText(tree).includes('Ultronen'), 'failed remote checks retain the running local version and identity');
  assert(requests.some(request => request.path.endsWith('/about/check-updates') && request.options.body === '{"force":true}'), 'manual update check explicitly bypasses the long cache');
  collectElements(tree).find(el => el.props?.role === 'tab' && elementText(el) === '回收站')?.props.onClick();
  render(); harness.flushEffects(); await new Promise(resolve => setTimeout(resolve, 0));
  tree = render();
  const head = collectElements(tree).find(el => el.props?.className === 'dac-head');
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
    collectElements(render().props.children[0]).find(el => el.type === 'button' && elementText(el) === '全部恢复')?.props.onClick();
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
  const rowDelete = elements.find((element) => element.type === 'button' && elementText(element) === '删除' && element.props?.['aria-label'] === '永久删除');
  rowDelete?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  const deleteDialog = findComponentElement(tree, 'ConfirmDialog');
  assert(deleteDialog?.props.title === '删除聊天？', 'single archive deletion opens a concise confirmation');
  assert(String(deleteDialog?.props.body).includes('Undo Alpha') && String(deleteDialog?.props.body).includes('无法撤销'), 'single archive deletion names the chat and explains irreversibility');
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
    collectElements(renderPending()).find((element) => element.props?.['aria-label'] === '永久删除')?.props.onClick();
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
  assert(projectMenuLabels.join(',') === '全部取消归档,全部移入回收站,全部导出,全部删除',
    'archive project menu follows the requested action order');
  const workspaceMenu = menuElements.find(element => element.props?.role === 'menu');
  const workspaceMenuItems = workspaceMenu?.props.children.filter(Boolean) ?? [];
  assert(workspaceMenuItems.length === 5 && workspaceMenuItems[3].props.role === 'separator'
    && elementText(workspaceMenuItems[2]) === '全部导出' && elementText(workspaceMenuItems[4]) === '全部删除',
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
  menuElements.find((element) => element.props?.role === 'menuitem' && elementText(element) === '全部移入回收站')?.props.onClick();
  await findComponentElement(projectHarness.render({ t, refreshSidebar: () => {} }), 'ConfirmDialog')?.props.onConfirm();
  assert(requests.some((request) => request.path.endsWith('/delete-all') && JSON.parse(request.options.body).permanent !== true), 'project recycle action remains recoverable');
  const undo = collectElements(projectHarness.render({ t, refreshSidebar: () => {} })).find((element) => element.type === 'button' && elementText(element) === '撤销');
  assert(undo !== undefined, 'moving a project to the Recycle Bin exposes immediate undo');
  await undo?.props.onClick();
  assert(requests.some((request) => request.path.endsWith('/trash/restore')), 'undo restores the moved chat');
  assert(collectElements(projectHarness.render({ t, refreshSidebar: () => {} })).some((element) => element.props?.className === 'dac-row'), 'undo returns the chat to the archive list');
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
  for (const label of ['全部导出', '全部取消归档', '全部移入回收站', '全部删除']) {
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
    assert(dialog?.props.body.includes('完整工作区名称/很长的项目名称') && dialog.props.body.includes('2 个已归档聊天'), `${label} confirms full workspace identity and count despite a one-row filter`);
    dialog?.props.onCancel();
    assert(mutations.length === 0 && createdElements.filter((el) => el.tagName === 'FORM').length === formsBefore, `cancelled ${label} has no mutation or download`);
  }
  const head = collectElements(render()).find((el) => el.props?.className === 'dac-head');
  collectElements(head).find((el) => el.type === 'button' && elementText(el) === '全部取消归档')?.props.onClick();
  const dialog = findComponentElement(render(), 'ConfirmDialog');
  assert(dialog?.props.body.includes('2 个工作区') && dialog.props.body.includes('3 个已归档聊天'), 'global unarchive ignores workspace/search filtering');
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
  assert(/\.dac-workspace-dialog\{[^}]*width:min\(540px,calc\(100vw - 32px\)\)[^}]*border-radius:24px[^}]*padding:26px/u.test(workspaceStyle)
    && workspaceStyle.includes('.dac-workspace-dialog .dac-preview-head{border-bottom:0;padding:0}')
    && workspaceStyle.includes('.dac-workspace-dialog .dac-preview-head strong{font-size:24px;line-height:32px}')
    && workspaceStyle.includes('.dac-workspace-copy{margin:0;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:26px'),
  'workspace confirmation uses the approved spacious scoped card typography');
	  assert(workspaceStyle.includes('.dac-checkbox{width:16px;height:16px;'), 'workspace and import checkboxes keep a stable named size');
	  assert(workspaceStyle.includes('.dac-workspace-choice-all{grid-template-columns:auto minmax(0,1fr);border:0;background:transparent'),
	    'workspace Select all stays visually unboxed');
	  assert(workspaceStyle.includes('.dac-workspace-choice-all:hover{background:transparent}')
	    && workspaceStyle.includes('.dac-workspace-choice-all:focus-within{outline:0}')
	    && workspaceStyle.includes('.dac-workspace-choice-all .dac-checkbox:focus-visible{outline:2px solid'),
	    'workspace Select all remains unboxed while its checkbox keeps a keyboard focus indicator');
	  assert(workspaceStyle.includes('.dac-workspace-actions .dac-btn,.dac-workspace-actions .dac-btn-danger,.dac-workspace-actions .dac-btn-primary{min-width:80px;border-radius:9px;font-size:14px;line-height:20px;padding:7px 14px}'),
	    'workspace dialog footer actions use the compact approved dimensions');
  assert(workspaceStyle.includes('.dac-workspace-actions .dac-btn{border:0;')
    && workspaceStyle.includes('.dac-workspace-actions .dac-btn-danger{border:0;background:var(--dsw-alias-interactive-bg-hover-danger)')
    && workspaceStyle.includes('@media (max-width:480px){.dac-workspace-dialog{width:calc(100vw - 32px)')
    && workspaceStyle.includes('.dac-workspace-actions{flex-direction:row;justify-content:flex-end;flex-wrap:wrap}'),
  'workspace confirmation keeps filled scoped actions horizontal on mobile');
  assert(requests.some((request) => request.path.endsWith('/workspace-archive/preview') && request.options.body === '{"workspaceId":"workspace-1"}'), 'workspace confirmation automatically prepares only the supplied workspace');
  assert(elementText(tree).includes('归档 2 个会话？') && elementText(tree).includes('Project One'), 'workspace confirmation shows the prepared count and supplied workspace title');
  assert(elementText(tree).includes('这会将「Project One」中的会话归档。之后你可以在归档管理的“已归档”中找到它们。')
    && !elementText(tree).includes('项目本身不会改变'), 'workspace confirmation names the destination without unrequested contrast copy');
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
  assert(dictionaries?.zh?.['workspaceArchive.confirmTitle'] === '归档 {count} 个会话？'
    && dictionaries?.en?.['workspaceArchive.confirmTitle'] === 'Archive {count} chats?', 'workspace archive has matched direct-confirmation titles');
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
	    && elementText(tree).includes('归档 3 个会话？')
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
  assert(previewCalls === 2 && elementText(tree).includes('归档 3 个会话？'), 'workspace Retry obtains a fresh preparation for the same workspace');
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
    const harness = createHookHarness(Dialog);
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
  const settingsTrigger = pageElements.find((element) => element.type === 'button' && elementText(element) === t('workspaceArchive.settingsAction'));
  settingsTrigger?.props.onClick({ currentTarget: { focus: () => { restoredSettingsFocus += 1; } } });
  pageTree = pageHarness.render(pageProps);
  const chooser = findComponentElement(pageTree, 'WorkspaceArchiveChooserDialog');
  assert(chooser !== undefined, 'settings trigger opens the workspace chooser without a Host workspace-menu slot');
  chooser.props.onChoose([{ id: 'workspace-settings', title: 'Settings Project' }, { id: 'workspace-two', title: 'Second Project' }]);
  pageTree = pageHarness.render(pageProps);
  const refreshDialog = findComponentElement(pageTree, 'WorkspaceArchiveDialog');
  assert(refreshDialog?.props.workspaces?.map((workspace) => workspace.id).join(',') === 'workspace-settings,workspace-two',
    'the settings-owned chooser opens one confirmation for every selected workspace');
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
    && insightsBefore === 'insights-0' && insightsAfter === 'insights-1',
  'workspace apply refreshes independent consumers despite failures and remounts Storage');
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
  assert(injectedSlots.join('|') === 'settings.section|shell.overlay'
    && registrations.length === 2
    && registrations.some((entry) => entry.meta?.name === 'settings.section')
    && registrations.some((entry) => entry.meta?.name === 'shell.overlay'),
  'the plugin requests and registers only the two official Host slots');
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
  assert(officialHostRegistrations.map((entry) => entry.meta?.name).join('|') === 'settings.section|shell.overlay',
  'an official Host without an unreleased workspace action slot preserves settings and archive notice');
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
  const moved = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq(
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
  const moved = await call(modernRoutes, '/plugins/dsh-archived-chats/delete', mockReq(
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

// Tear down the isolated DSH_HOME and session fixture dirs.
rmSync(testHome, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED\n' : `\n💥 ${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
