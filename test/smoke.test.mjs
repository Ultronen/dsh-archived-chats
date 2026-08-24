/**
 * dsh-archived-chats smoke test — exercises the real host half (lib/index.js)
 * under mocked webServer / workspaceRegistry / sessionPersistence services with
 * a real temp directory for the delete path, then runs the real client half
 * (lib/client.js) under a mocked browser runtime for registration-level checks.
 * Run: node test/smoke.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { unzipSync, strFromU8 } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));

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
    assert(signal instanceof AbortSignal, 'image read receives an abort signal');
    assert(ref.attachmentId === archivedImageRef.attachmentId, 'image read receives the projected reference');
    return { ref: archivedImageRef, data: archivedImageBytes };
  },
};

const { apply, name } = await import(join(here, '../lib/index.js'));
//#endregion

console.log('\n[1] host half — lazy route registration');
apply(ctx);
assert(name === 'archived-chats', `plugin name is "archived-chats" (got "${name}")`);
assert(routes.size === 0, 'no routes while webServer is unbound');
services.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } };
listeners.find(([event]) => event === 'internal/service')?.[1]('webServer');
assert(routes.size === 22, `twenty-two archive-management routes registered after webServer binds (got ${routes.size})`);
for (const path of ['state', 'stats', 'insights', 'retention/policy', 'retention/preview', 'retention/apply', 'lineage', 'preview', 'preview/image', 'search', 'export', 'import/inspect', 'import/restore', 'metadata', 'trash', 'trash/restore', 'trash/purge', 'trash/empty', 'unarchive', 'unarchive-all', 'delete', 'delete-all']) {
  assert(routes.has(`/plugins/dsh-archived-chats/${path}`), `route /${path} registered`);
}
assert(!routes.has('/plugins/dsh-archived-chats/interop/inspect'), 'Codex / Claude import route is not registered');
assert(!routes.has('/plugins/dsh-archived-chats/interop/export'), 'Codex / Claude export route is not registered');

console.log('\n[1a0] storage insights, retention, and lineage routes');
{
  const insights = await call(routes, '/plugins/dsh-archived-chats/insights', mockReq('GET', {}));
  assert(insights.status === 200, `insights answers 200 (got ${insights.status})`);
  assert(insights.json().summary.sessionBytes >= 0, 'insights exposes measured session bytes');
  assert(!JSON.stringify(insights.json()).includes('workspacePath'), 'insights never exposes workspace paths');

  const lineage = await call(routes, '/plugins/dsh-archived-chats/lineage', mockReq('GET', {}));
  assert(lineage.status === 200, `lineage answers 200 (got ${lineage.status})`);
  assert(lineage.json().roots[0].children[0].id === 'session-b', 'lineage uses durable parentSession edges');
  assert(!JSON.stringify(lineage.json()).includes('/ws/'), 'lineage never exposes workspace paths');

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
  assert(attachmentReads === 1, 'only the authorized request reaches the attachment service');

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
  const tempPath = `${metadataFile}.${process.pid}.tmp`;
  mkdirSync(tempPath);
  const warningCount = warnings.length;
  const saved = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
    'POST',
    { 'x-dsh-archived-chats': '1' },
    JSON.stringify({ sessionId: id, tags: [secretTag], note: secretNote }),
  ));
  rmSync(tempPath, { recursive: true, force: true });
  const newWarnings = warnings.slice(warningCount).join('\n');
  assert(saved.status === 500, `metadata filesystem failure answers 500 (got ${saved.status})`);
  assert(newWarnings.includes(id) && newWarnings.includes('EISDIR'), 'metadata failure warning identifies the session and error code');
  assert(!newWarnings.includes(secretTag) && !newWarnings.includes(secretNote), 'metadata failure warning excludes user-authored tags and notes');
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
  mkdirSync(join(tmp, 'session-b'), { recursive: true });
  writeFileSync(join(tmp, 'session-b', 'session.jsonl.zstd'), 'restored');
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
  const { apply: applyBoot } = await import(join(here, '../lib/index.js'));
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
const moduleTable = {
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  '@deepseek-ai/dsh-client-ui-primitives': {
    MarkdownText: MarkdownTextStub,
    DisclosureRow: DisclosureRowStub,
    JsonBlock: JsonBlockStub,
  },
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
const clientCalls = { localeRegister: [], slotRegister: [], effects: [], sidebarRefresh: 0 };
const clientServices = { sessions: { refresh: () => { clientCalls.sidebarRefresh += 1; return Promise.resolve(); } } };
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
  const reconciled = clientExports.__test.reconcileSelection(new Set(['hidden', 'b']), [{ id: 'b' }, { id: 'c' }]);
  assert([...reconciled].join(',') === 'b', 'selection drops chats removed by an operation or refresh');

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

  const formsBefore = createdElements.filter((element) => element.tagName === 'FORM').length;
  const submitted = clientExports.__test.submitExport?.(['session-b', 'session-a', 'session-b']);
  const forms = createdElements.filter((element) => element.tagName === 'FORM');
  const exportForm = forms.at(-1);
  const exportInput = exportForm?.children.find((element) => element.tagName === 'INPUT');
  assert(submitted === true && forms.length === formsBefore + 1, 'export form helper accepts a non-empty selection');
  assert(exportForm?.method === 'POST', 'export form uses POST');
  assert(exportForm?.action === '/plugins/dsh-archived-chats/export', 'export form targets the archive export route');
  assert(exportForm?.hidden === true, 'export form stays hidden');
  assert(exportInput?.name === 'sessionIds', 'export form names the sessionIds field');
  assert(exportInput?.value === '["session-b","session-a"]', 'export form preserves first-seen id order');
  assert(exportForm?.submitted === 1 && exportForm?.removed !== true, 'export form submits before cleanup');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(exportForm?.removed === true, 'export form is removed on the next task');
  assert(clientExports.__test.submitExport?.([]) === false, 'export form rejects an empty selection');

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
  const searchBody = await clientExports.__test.fetchArchiveSearch?.('needle', 20);
  const searchRequest = inspectRequests.at(-1);
  assert(searchBody?.hits?.[0]?.sessionId === 'session-a', 'search helper returns full-text hits');
  assert(searchRequest?.url === '/plugins/dsh-archived-chats/search', 'search helper targets the guarded search route');
  assert(searchRequest?.options.method === 'POST' && searchRequest?.options.headers['x-dsh-archived-chats'] === '1', 'search helper uses a guarded POST');
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

  await clientExports.__test.emptyTrash?.();
  trashRequest = inspectRequests.at(-1);
  assert(trashRequest?.url === '/plugins/dsh-archived-chats/trash/empty', 'empty targets trash authority route');
  assert(trashRequest?.options.method === 'POST' && trashRequest?.options.headers['x-dsh-archived-chats'] === '1', 'empty uses guarded POST');
  assert(trashRequest?.options.body === '{}', 'empty sends no hidden client IDs');
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

  assert(JSON.stringify(clientExports.__test.uniqueSessionIds?.(['b', '', 'a', 'b', null])) === '["b","a"]', 'trash ID normalization preserves unique request order');
  const trashGroups = clientExports.__test.groupTrashSessions?.(trashRows);
  assert(JSON.stringify(trashGroups?.map((group) => ({ key: group.key, ids: group.selectionIds }))) === JSON.stringify([
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
  assert(zhDict['nav'] === '已归档的聊天', 'zh nav label is 已归档的聊天');
  assert(zhDict['delete.all'] === '全部移至回收站', 'zh recycle-all label present');
  assert(zhDict['confirm.deleteOne.title'] === '移至回收站？', 'move-one confirmation title is localized');
  assert(zhDict['confirm.deleteOne.body'].includes('保护快照'), 'move-one confirmation explains recoverability');
  assert(zhDict['group.collapse'] === '折叠' && zhDict['group.expand'] === '展开', 'collapse/expand labels present');
  assert(zhDict['export.all'] === '全部导出' && zhDict['export.selected'] === '导出选中项', 'Chinese export actions are localized');
  assert(clientCalls.localeRegister[0].dicts.en['export.row'] === 'Export backup', 'English row export action is localized');
  assert(clientCalls.slotRegister.length === 1, `exactly one slot registration (got ${clientCalls.slotRegister.length})`);
  const meta = clientCalls.slotRegister[0].meta;
  assert(meta.name === 'settings.section', 'registration targets settings.section');
  assert(meta.id === 'archived-chats', `section id is "archived-chats" (got "${meta.id}")`);
  assert(meta.order === 30, `section order is 30 (got ${meta.order})`);
  assert(typeof meta.label === 'function', 'nav label is a locale-bound function');
  assert(meta.label() === '已归档的聊天', `label() resolves to 已归档的聊天 (got "${meta.label()}")`);
  assert(meta.locale === 'settings.archived-chats', 'section carries its locale namespace');
  assert(typeof clientCalls.slotRegister[0].component === 'function', 'section component is a function');
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
  assert(!clientSource.includes('settings.plugin.item'), 'rc.7 keyed plugin-item slot is not used by the settings section');
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
    return collectElements(node.type(node.props ?? {}), result);
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
  if (typeof node.type === 'function') return elementText(node.type(node.props ?? {}));
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

console.log('\n[11b] client half — selection mode and preview request lifecycle');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const archivedRows = [
    { id: 'session-a', title: 'Alpha', createdAt: 10, origin: null, workspaceId: 'ws-1', workspaceTitle: '项目一' },
    { id: 'session-b', title: 'Beta', createdAt: 20, origin: 'subagent', workspaceId: 'ws-1', workspaceTitle: '项目一' },
    { id: 'session-c', title: 'Gamma', createdAt: 30, origin: null, workspaceId: 'ws-2', workspaceTitle: '项目二' },
  ];
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/state')
        ? { metadataStatus: 'ready', sessions: archivedRows }
        : String(url).endsWith('/delete-all')
          ? { trashed: ['session-b'], failed: [] }
          : { summary: { sessionCount: 3, totalBytes: 0, unavailableCount: 0 }, sessions: {} },
    };
  };

  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientCalls.slotRegister[0].component);
  harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const defaultTree = harness.render({ t, refreshSidebar: () => {} });
  const defaultElements = collectElements(defaultTree);
  const defaultCheckboxes = defaultElements.filter((element) => element.type === 'input' && element.props?.type === 'checkbox');
  const startSelection = defaultElements.find((element) => element.type === 'button' && elementText(element) === '批量选择');
  assert(defaultCheckboxes.length === 0, 'archive list hides every selection checkbox by default');
  assert(startSelection !== undefined, 'archive list exposes a batch-selection trigger');
  assert(defaultElements.some((element) => element.type === 'button' && elementText(element) === '空间与策略'), 'archive manager exposes Storage & Retention tab');
  assert(defaultElements.some((element) => element.type === 'button' && elementText(element) === '会话血缘'), 'archive manager exposes Session Lineage tab');

  const moreTrigger = defaultElements.find((element) => element.type === 'button' && elementText(element) === '更多');
  moreTrigger?.props.onClick();
  const openMenuTree = harness.render({ t, refreshSidebar: () => {} });
  const openMenuElements = collectElements(openMenuTree);
  const actionPopover = openMenuElements.find((element) => element.props?.className === 'dac-action-menu');
  const actionContainer = openMenuElements.find((element) => element.props?.className === 'dac-head-actions');
  const renderedMoreTrigger = openMenuElements.find((element) => element.type === 'button' && elementText(element) === '更多');
  let triggerFocuses = 0;
  if (renderedMoreTrigger?.props.ref) renderedMoreTrigger.props.ref.current = { focus: () => { triggerFocuses += 1; } };
  let menuEscapePrevented = false;
  let menuEscapeStopped = false;
  actionContainer?.props.onKeyDown?.({
    key: 'Escape',
    preventDefault: () => { menuEscapePrevented = true; },
    stopPropagation: () => { menuEscapeStopped = true; },
  });
  const escapedMenuTree = harness.render({ t, refreshSidebar: () => {} });
  assert(actionPopover?.props.role === undefined && collectElements(actionPopover).every((element) => element.props?.role !== 'menuitem'), 'compact action popovers use ordinary button disclosure semantics');
  assert(menuEscapePrevented && menuEscapeStopped && triggerFocuses === 1, 'action popover contains Escape and restores focus to its trigger');
  assert(!collectElements(escapedMenuTree).some((element) => element.props?.className === 'dac-action-menu'), 'Escape closes only the open action popover');

  startSelection?.props.onClick();
  const selectionTree = harness.render({ t, refreshSidebar: () => {} });
  const selectionElements = collectElements(selectionTree);
  const selectionCheckboxes = selectionElements.filter((element) => element.type === 'input' && element.props?.type === 'checkbox');
  const finishSelection = selectionElements.find((element) => element.type === 'button' && elementText(element) === '完成');
  assert(selectionCheckboxes.some((element) => element.props?.['aria-label'] === '选择当前结果'), 'selection mode exposes the visible-results checkbox');
  assert(selectionCheckboxes.some((element) => element.props?.['aria-label'] === '选择 Alpha'), 'selection mode exposes chat checkboxes');
  assert(finishSelection !== undefined, 'selection mode exposes a completion action');

  const selectionSearch = selectionElements.find((element) => element.type === 'input' && element.props?.placeholder === '搜索标题、标签、备注和聊天内容');
  selectionSearch?.props.onChange({ target: { value: 'no visible results' } });
  const emptySelectionTree = harness.render({ t, refreshSidebar: () => {} });
  assert(collectElements(emptySelectionTree).some((element) => element.type === 'button' && elementText(element) === '完成'), 'selection mode can finish when filters have no visible results');
  selectionSearch?.props.onChange({ target: { value: '' } });

  finishSelection?.props.onClick();
  const finishedTree = harness.render({ t, refreshSidebar: () => {} });
  const finishedCheckboxes = collectElements(finishedTree).filter((element) => element.type === 'input' && element.props?.type === 'checkbox');
  assert(finishedCheckboxes.length === 0, 'completing selection mode hides the checkboxes again');

  const restartSelection = collectElements(finishedTree).find((element) => element.type === 'button' && elementText(element) === '批量选择');
  restartSelection?.props.onClick();
  const restartedTree = harness.render({ t, refreshSidebar: () => {} });
  const alphaCheckbox = collectElements(restartedTree).find((element) => element.type === 'input' && element.props?.['aria-label'] === '选择 Alpha');
  alphaCheckbox?.props.onChange({ target: { checked: true } });
  const selectedTree = harness.render({ t, refreshSidebar: () => {} });
  const selectedBulkBar = collectElements(selectedTree).find((element) => element.props?.className === 'dac-bulkbar');
  const selectedExport = collectElements(selectedBulkBar).find((element) => element.type === 'button' && elementText(element) === '导出选中项');
  selectedExport?.props.onClick();
  const exportedTree = harness.render({ t, refreshSidebar: () => {} });
  const exportedCheckboxes = collectElements(exportedTree).filter((element) => element.type === 'input' && element.props?.type === 'checkbox');
  assert(exportedCheckboxes.length === 0, 'successful bulk export exits selection mode');

  const restartForUnarchive = collectElements(exportedTree).find((element) => element.type === 'button' && elementText(element) === '批量选择');
  restartForUnarchive?.props.onClick();
  const unarchiveSelectionTree = harness.render({ t, refreshSidebar: () => {} });
  const unarchiveCheckbox = collectElements(unarchiveSelectionTree).find((element) => element.type === 'input' && element.props?.['aria-label'] === '选择 Alpha');
  unarchiveCheckbox?.props.onChange({ target: { checked: true } });
  const unarchiveBulkTree = harness.render({ t, refreshSidebar: () => {} });
  const unarchiveBulkBar = collectElements(unarchiveBulkTree).find((element) => element.props?.className === 'dac-bulkbar');
  const selectedUnarchive = collectElements(unarchiveBulkBar).find((element) => element.type === 'button' && elementText(element) === '取消归档');
  await selectedUnarchive?.props.onClick();
  const unarchivedTree = harness.render({ t, refreshSidebar: () => {} });
  const unarchivedCheckboxes = collectElements(unarchivedTree).filter((element) => element.type === 'input' && element.props?.type === 'checkbox');
  assert(unarchivedCheckboxes.length === 0, 'successful bulk unarchive exits selection mode');

  const restartForDelete = collectElements(unarchivedTree).find((element) => element.type === 'button' && elementText(element) === '批量选择');
  restartForDelete?.props.onClick();
  const deleteSelectionTree = harness.render({ t, refreshSidebar: () => {} });
  const deleteCheckbox = collectElements(deleteSelectionTree).find((element) => element.type === 'input' && element.props?.['aria-label'] === '选择 Beta');
  deleteCheckbox?.props.onChange({ target: { checked: true } });
  const deleteBulkTree = harness.render({ t, refreshSidebar: () => {} });
  const deleteBulkBar = collectElements(deleteBulkTree).find((element) => element.props?.className === 'dac-bulkbar');
  const selectedDelete = collectElements(deleteBulkBar).find((element) => element.type === 'button' && elementText(element) === '移至回收站');
  selectedDelete?.props.onClick();
  const deleteConfirmTree = harness.render({ t, refreshSidebar: () => {} });
  const confirmDelete = collectElements(deleteConfirmTree).find((element) => element.type === 'button' && element.props?.className === 'dac-btn-danger');
  await confirmDelete?.props.onClick();
  const deletedTree = harness.render({ t, refreshSidebar: () => {} });
  const deletedCheckboxes = collectElements(deletedTree).filter((element) => element.type === 'input' && element.props?.type === 'checkbox');
  assert(deletedCheckboxes.length === 0, 'successful bulk delete exits selection mode');

  harness.unmount();

  const responseFor = (payload) => ({ ok: true, status: 200, json: async () => payload });
  const renderLoadedArchiveSection = async (sectionHarness) => {
    sectionHarness.render({ t, refreshSidebar: () => {} });
    sectionHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let loadedTree = sectionHarness.render({ t, refreshSidebar: () => {} });
    sectionHarness.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    loadedTree = sectionHarness.render({ t, refreshSidebar: () => {} });
    return loadedTree;
  };

  const closePending = [];
  globalThis.fetch = (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/state')) return Promise.resolve(responseFor({ metadataStatus: 'ready', sessions: archivedRows }));
    if (path.endsWith('/stats')) return Promise.resolve(responseFor({ summary: { sessionCount: 2, totalBytes: 10, unavailableCount: 0 }, sessions: {} }));
    if (path.endsWith('/preview')) return new Promise((resolve) => { closePending.push({ resolve, options }); });
    return Promise.resolve(responseFor({}));
  };
  const closeHarness = createHookHarness(clientCalls.slotRegister[0].component);
  let closeTree = await renderLoadedArchiveSection(closeHarness);
  let closeElements = collectElements(closeTree);
  const closeAlpha = closeElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看对话 Alpha');
  const closeOpenPromise = closeAlpha?.props.onClick();
  closeTree = closeHarness.render({ t, refreshSidebar: () => {} });
  const loadingPreview = findComponentElement(closeTree, 'PreviewDialog');
  loadingPreview?.props.onCancel();
  assert(closePending[0]?.options.signal?.aborted === true, 'closing a loading conversation preview aborts its request');
  closePending[0]?.resolve(responseFor({ ok: true, session: archivedRows[0], messages: [], total: 0, nextOffset: null }));
  await closeOpenPromise;
  closeTree = closeHarness.render({ t, refreshSidebar: () => {} });
  assert(findComponentElement(closeTree, 'PreviewDialog') === undefined, 'a completed request cannot reopen a closed conversation preview');
  closeHarness.unmount();

  const orderedPending = [];
  globalThis.fetch = (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/state')) return Promise.resolve(responseFor({ metadataStatus: 'ready', sessions: archivedRows }));
    if (path.endsWith('/stats')) return Promise.resolve(responseFor({ summary: { sessionCount: 2, totalBytes: 10, unavailableCount: 0 }, sessions: {} }));
    if (path.endsWith('/preview')) {
      const body = JSON.parse(options.body ?? '{}');
      return new Promise((resolve) => { orderedPending.push({ sessionId: body.sessionId, resolve, options }); });
    }
    return Promise.resolve(responseFor({}));
  };
  const orderHarness = createHookHarness(clientCalls.slotRegister[0].component);
  let orderTree = await renderLoadedArchiveSection(orderHarness);
  let orderElements = collectElements(orderTree);
  const alphaOpenPromise = orderElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看对话 Alpha')?.props.onClick();
  orderTree = orderHarness.render({ t, refreshSidebar: () => {} });
  orderElements = collectElements(orderTree);
  const betaOpenPromise = orderElements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看对话 Beta')?.props.onClick();
  const alphaPending = orderedPending.find((entry) => entry.sessionId === 'session-a');
  const betaPending = orderedPending.find((entry) => entry.sessionId === 'session-b');
  betaPending?.resolve(responseFor({ ok: true, session: archivedRows[1], messages: [], total: 0, nextOffset: null }));
  await betaOpenPromise;
  alphaPending?.resolve(responseFor({ ok: true, session: archivedRows[0], messages: [], total: 0, nextOffset: null }));
  await alphaOpenPromise;
  orderTree = orderHarness.render({ t, refreshSidebar: () => {} });
  const orderedPreview = findComponentElement(orderTree, 'PreviewDialog');
  assert(alphaPending?.options.signal?.aborted === true, 'opening a newer conversation preview aborts the older request');
  assert(orderedPreview?.props.preview?.session?.id === 'session-b', 'an older response cannot overwrite the newest conversation preview');
  orderHarness.unmount();

  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11c] client half — bulk selection workflow');
{
  const savedHooks = { ...moduleTable.react };
  const archivedRows = [
    { id: 'session-a', title: 'Alpha', createdAt: 10, origin: null, workspaceId: 'ws-1', workspaceTitle: '项目一' },
    { id: 'session-b', title: 'Beta', createdAt: 20, origin: 'subagent', workspaceId: 'ws-1', workspaceTitle: '项目一' },
  ];
  let stateCall = 0;
  let selectedAfterGroup = null;
  const renderedEffects = [];
  moduleTable.react.useState = (initial) => {
    const value = typeof initial === 'function' ? initial() : initial;
    const index = stateCall++;
    const current = index === 0
      ? archivedRows
      : index === 7
        ? 'Alpha'
      : index === 12
          ? { title: '将选中的已归档聊天移至回收站？', body: '这将把选中的 1 个已归档聊天移至回收站', ids: ['session-a'] }
          : index === 24
            ? true
          : value instanceof Set ? new Set(['session-a']) : value;
    const setter = value instanceof Set
      ? (next) => { selectedAfterGroup = typeof next === 'function' ? next(current) : next; }
      : () => {};
    return [current, setter];
  };
  moduleTable.react.useEffect = (effect, deps) => { renderedEffects.push({ effect, deps }); };
  moduleTable.react.useMemo = (fn) => fn();
  moduleTable.react.useCallback = (fn) => fn;
  moduleTable.react.useRef = (value) => ({ current: value });

  const t = clientCtx.locale.bind('settings.archived-chats');
  const tree = clientCalls.slotRegister[0].component({ t, refreshSidebar: () => {} });
  const elements = collectElements(tree);
  const sortSelect = elements.find((el) => el.type === 'select' && el.props?.['aria-label'] === '排序方式');
  assert(sortSelect?.props.value === 'newest', 'sort control defaults to newest first');
  assert(sortSelect?.props.children.map((option) => option.props.value).join(',') === 'newest,oldest,title', 'sort control offers newest, oldest, and title');

  const checkboxes = elements.filter((el) => el.type === 'input' && el.props?.type === 'checkbox');
  const alphaCheckbox = checkboxes.find((el) => el.props?.['aria-label'] === '选择 Alpha');
  assert(alphaCheckbox?.props.checked === true, 'selected chat renders checked');
  assert(checkboxes.every((el) => el.props?.['aria-label'] !== '选择 Beta'), 'search filter hides non-matching chats');
  const projectCheckbox = checkboxes.find((el) => el.props?.['aria-label'] === '选择此项目：项目一');
  assert(projectCheckbox?.props['aria-checked'] === 'mixed', 'project selection includes chats hidden by filters');
  projectCheckbox?.props.onChange({ target: { checked: true } });
  assert([...selectedAfterGroup ?? []].sort().join(',') === 'session-a,session-b', 'project selection selects hidden chats in the project');

  const bulkBar = elements.find((el) => el.props?.className === 'dac-bulkbar');
  assert(elementText(bulkBar).includes('已选择 1 个聊天'), 'bulk bar reports the selected count');
  assert(elementText(bulkBar).includes('导出选中项') && elementText(bulkBar).includes('取消归档') && elementText(bulkBar).includes('移至回收站') && elementText(bulkBar).includes('清除'), 'bulk bar exposes export, unarchive, recycle, and clear actions');
  assert(!elements.some((el) => el.type === 'button' && elementText(el) === '全部导出'), 'top-level export all is hidden while the selection bar is active');

  const formsBeforeExport = createdElements.filter((element) => element.tagName === 'FORM').length;
  const bulkExport = collectElements(bulkBar).find((el) => el.type === 'button' && elementText(el) === '导出选中项');
  bulkExport?.props.onClick();
  const bulkExportForms = createdElements.filter((element) => element.tagName === 'FORM');
  const bulkExportInput = bulkExportForms.at(-1)?.children.find((element) => element.tagName === 'INPUT');
  assert(bulkExport?.props.disabled !== true, 'selected export is enabled when the selected scope is idle');
  assert(bulkExportForms.length === formsBeforeExport + 1 && bulkExportInput?.value === '["session-a"]', 'selected export submits ids in archive-list order');

  const requests = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ archivedSessionIds: ['session-b'] }) };
  };
  const bulkButtons = collectElements(bulkBar).filter((el) => el.type === 'button');
  const bulkUnarchive = bulkButtons.find((button) => elementText(button) === '取消归档');
  await bulkUnarchive?.props.onClick();

  const alertDialog = elements.find((el) => el.props?.role === 'alertdialog');
  const dialogTitle = elements.find((el) => el.props?.id === 'dac-confirm-title');
  const dialogBody = elements.find((el) => el.props?.id === 'dac-confirm-body');
  assert(alertDialog?.props['aria-labelledby'] === 'dac-confirm-title' && dialogTitle !== undefined, 'confirmation dialog has an accessible title');
  assert(alertDialog?.props['aria-describedby'] === 'dac-confirm-body' && dialogBody !== undefined, 'confirmation dialog has an accessible description');
  let boundaryEscapePrevented = false;
  let boundaryEscapeStopped = false;
  let boundaryEscapeStoppedImmediately = false;
  alertDialog?.props.onKeyDown?.({
    key: 'Escape',
    preventDefault: () => { boundaryEscapePrevented = true; },
    stopPropagation: () => { boundaryEscapeStopped = true; },
    nativeEvent: { stopImmediatePropagation: () => { boundaryEscapeStoppedImmediately = true; } },
  });
  assert(boundaryEscapePrevented && boundaryEscapeStopped && boundaryEscapeStoppedImmediately, 'confirmation dialog contains Escape at the alertdialog boundary');

  let cancelFocuses = 0;
  let destructiveFocuses = 0;
  let restoredFocuses = 0;
  let fallbackFocuses = 0;
  const previousFocus = { focus: () => { restoredFocuses += 1; documentMock.activeElement = previousFocus; } };
  const fallbackFocus = { focus: () => { fallbackFocuses += 1; documentMock.activeElement = fallbackFocus; } };
  const cancelControl = { focus: () => { cancelFocuses += 1; documentMock.activeElement = cancelControl; } };
  const destructiveControl = { focus: () => { destructiveFocuses += 1; documentMock.activeElement = destructiveControl; } };
  const cancelButton = elements.find((el) => el.type === 'button' && elementText(el) === '取消');
  const destructiveButton = elements.find((el) => el.type === 'button' && elementText(el) === '移至回收站' && el.props?.className === 'dac-btn-danger');
  const pageHeading = elements.find((el) => el.props?.className === 'dac-title');
  if (alertDialog?.props.ref) alertDialog.props.ref.current = { querySelectorAll: () => [cancelControl, destructiveControl] };
  if (cancelButton?.props.ref) cancelButton.props.ref.current = cancelControl;
  if (destructiveButton?.props.ref) destructiveButton.props.ref.current = destructiveControl;
  if (pageHeading?.props.ref) pageHeading.props.ref.current = fallbackFocus;
  documentMock.activeElement = previousFocus;
  documentMock.contains = (node) => node !== previousFocus;
  const modalEffect = [...renderedEffects].reverse().find(({ deps }) => deps?.length === 3 && typeof deps[0] === 'function');
  const cleanupModal = modalEffect?.effect();
  assert(cancelFocuses === 1, 'confirmation dialog moves initial focus to cancel');
  documentMock.activeElement = destructiveControl;
  let trappedForward = false;
  documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: () => { trappedForward = true; } });
  assert(trappedForward && documentMock.activeElement === cancelControl, 'confirmation dialog traps forward tab focus');
  let confirmEscapePrevented = false;
  let confirmEscapeStopped = false;
  let confirmEscapeStoppedImmediately = false;
  documentListeners.get('keydown')?.({
    key: 'Escape',
    preventDefault: () => { confirmEscapePrevented = true; },
    stopPropagation: () => { confirmEscapeStopped = true; },
    stopImmediatePropagation: () => { confirmEscapeStoppedImmediately = true; },
  });
  assert(confirmEscapePrevented && confirmEscapeStopped && confirmEscapeStoppedImmediately, 'confirmation dialog isolates Escape from same-target host settings listeners');
  cleanupModal?.();
  assert(restoredFocuses === 0 && fallbackFocuses === 1, 'dialog falls back to page heading when its trigger was removed');
  documentMock.contains = () => true;

  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
  assert(requests[0]?.url === '/plugins/dsh-archived-chats/unarchive-all', 'bulk unarchive uses the batch endpoint');
  assert(JSON.parse(requests[0]?.options.body ?? '{}').sessionIds.join(',') === 'session-a', 'bulk unarchive sends exactly the selected ids');
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
  states[0] = { value: archivedRows, setter: null };
  states[17] = { value: '', setter: null };
  states[18] = { value: 'ready', setter: null };
  states[19] = { value: statsFixture, setter: null };
  states[20] = { value: null, setter: null };
  states[21] = { value: false, setter: null };
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
  const exportTrigger = elements.find((el) => el.type === 'button' && elementText(el) === '导出备份');
  const moreTrigger = elements.find((el) => el.type === 'button' && elementText(el) === '更多');
  assert(importTrigger !== undefined && exportTrigger !== undefined && moreTrigger !== undefined, 'top actions expose direct backup import, direct backup export, and more');
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

  const formsBeforeAll = createdElements.filter((element) => element.tagName === 'FORM').length;
  exportTrigger?.props.onClick();
  const allForms = createdElements.filter((element) => element.tagName === 'FORM');
  const allInput = allForms.at(-1)?.children.find((element) => element.tagName === 'INPUT');
  assert(allForms.length === formsBeforeAll + 1 && allInput?.value === '["session-a","session-b","session-c"]', 'direct backup export submits archive-list order');
  tree = renderSection();
  elements = collectElements(tree);
  assert(elements.some((el) => el.props?.className === 'dac-toast' && elementText(el).includes('已开始下载备份')), 'export action announces that the download started');
  states[14].value = null;
  tree = renderSection();
  elements = collectElements(tree);

  const renderedMoreTrigger = elements.find((el) => el.type === 'button' && elementText(el) === '更多');
  renderedMoreTrigger?.props.onClick();
  tree = renderSection();
  elements = collectElements(tree);
  const moreMenu = elements.find((el) => el.props?.className === 'dac-action-menu');
  const deleteAllMenuItem = collectElements(moreMenu).find((el) => el.type === 'button' && elementText(el) === '全部移至回收站');
  assert(deleteAllMenuItem?.props.className === 'dac-action-menu-item dac-danger', 'recycle all is a danger item inside the more menu');

  const summary = elements.find((el) => el.props?.className === 'dac-summary');
  assert(summary !== undefined, 'summary strip rendered below the title');
  assert(elementText(summary).includes('3 个聊天'), 'summary reports the archived chat count');
  assert(elementText(summary).includes('1.5 KB'), 'summary reports the measured total size');
  assert(elementText(summary).includes('部分会话无法统计'), 'summary flags unavailable measurements');

  const importInput = elements.find((el) => el.type === 'input' && el.props?.type === 'file' && el.props?.accept === '.zip,application/zip');
  assert(importInput?.props.accept === '.zip,application/zip' && importInput?.props.hidden === true, 'import file picker is hidden and accepts ZIP backups');

  states[22].value = {
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
  states[23].value = false;
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
  globalThis.fetch = async (url, options) => {
    restoreRequests.push({ url, options });
    return String(url).endsWith('/import/restore')
      ? { ok: true, status: 200, json: async () => ({ ok: true, restored: ['new-session'], skipped: [], warnings: [] }) }
      : { ok: true, status: 200, json: async () => ({ metadataStatus: 'ready', sessions: archivedRows }) };
  };
  const restoreButton = collectElements(importDialog).find((el) => el.type === 'button' && elementText(el) === '恢复选中项');
  await restoreButton?.props.onClick();
  assert(restoreRequests[0]?.url === '/plugins/dsh-archived-chats/import/restore', 'import confirmation targets the restore route');
  assert(restoreRequests[0]?.options.headers['x-dsh-archived-chats'] === '1', 'import confirmation sends the guard header');
  assert(JSON.parse(restoreRequests[0]?.options.body ?? '{}').sessionIds.join(',') === 'new-session', 'import confirmation sends only selected non-conflicting IDs');
  globalThis.fetch = savedImportFetch;
  states[22].value = null;
  states[19].value = statsFixture;
  tree = renderSection();
  elements = collectElements(tree);

  const tagSelect = elements.find((el) => el.type === 'select' && el.props?.['aria-label'] === '全部标签');
  assert(tagSelect !== undefined, 'tag filter select rendered');
  assert(tagSelect?.props.value === '', 'tag filter defaults to the non-colliding no-filter sentinel');
  const importantOptions = tagSelect?.props.children.filter((option) => String(option.props.children).toLowerCase() === 'important') ?? [];
  assert(importantOptions.length === 1, 'tag filter options de-duplicate labels case-insensitively');
  states[17].value = 'all';
  tree = renderSection();
  elements = collectElements(tree);
  const filteredRows = elements.filter(isRow);
  assert(filteredRows.length === 1 && elementText(filteredRows[0]).includes('Beta'), 'selecting the literal all tag renders only sessions carrying that tag');
  states[17].value = '';
  tree = renderSection();
  elements = collectElements(tree);

  const chips = elements.filter((el) => el.props?.className === 'dac-chip');
  assert(elements.filter(isRow).every((row) => collectElements(row).filter((el) => el.props?.className === 'dac-chip').length <= 3), 'rows render at most three tag chips each');
  const moreChips = elements.filter((el) => el.props?.className === 'dac-chip dac-chip-more');
  assert(moreChips.map((el) => elementText(el)).join(',') === '+1', 'overflow tags collapse into a +N indicator');

  const rows = elements.filter(isRow);
  const alphaRow = rows.find((row) => elementText(row).includes('Alpha'));
  assert(alphaRow !== undefined && elementText(alphaRow).includes('1 KB'), 'per-row formatted size rendered');
  const gammaRow = rows.find((row) => elementText(row).includes('Gamma'));
  assert(gammaRow !== undefined && elementText(gammaRow).includes('—'), 'unavailable session size renders the dash');

  const alphaExport = collectElements(alphaRow).find((el) => el.type === 'button' && el.props?.['aria-label'] === '导出备份');
  const formsBeforeRow = createdElements.filter((element) => element.tagName === 'FORM').length;
  alphaExport?.props.onClick();
  const rowForms = createdElements.filter((element) => element.tagName === 'FORM');
  const rowInput = rowForms.at(-1)?.children.find((element) => element.tagName === 'INPUT');
  assert(alphaExport !== undefined && alphaExport.props.disabled !== true, 'each idle row exposes an enabled export icon');
  assert(rowForms.length === formsBeforeRow + 1 && rowInput?.value === '["session-a"]', 'row export submits exactly that session');
  const styleText = headChildren.find((child) => child.id === 'dsh-archived-chats-css')?.textContent ?? '';
  assert(styleText.includes('.dac-iconbtn{') && styleText.includes('width:28px;height:28px'), 'row icon dimensions remain stable');
  assert(styleText.includes('.dac-bulk-actions{width:100%;flex-wrap:wrap}'), 'narrow bulk export actions wrap without overlap');

  const alphaEdit = editButtonsIn(alphaRow)[0];
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
  assert(states[20].value === null, 'metadata Escape cancels only the metadata editor state');
  cleanupMeta?.();
  assert(editFocuses === 1 && documentMock.activeElement === editTrigger, 'metadata dialog restores focus to the row edit button');

  states[20].value = archivedRows[0];
  tree = renderSection();
  elements = collectElements(tree);

  const requests = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, metadata: { tags: ['important'], note: 'keep this', updatedAt: '2026-08-18T12:00:00.000Z' } }),
    };
  };
  const saveButton = elements.find((el) => el.type === 'button' && elementText(el) === '保存');
  assert(saveButton?.props.disabled !== true, 'save enabled with valid input');
  await saveButton?.props.onClick();
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
  states[20].value = commaTagSession;
  const rawSectionTree = renderSection();
  const metadataElement = findComponentElement(rawSectionTree, 'MetadataDialog');
  assert(metadataElement !== undefined, 'metadata dialog component is present in the real section tree');
  const harness = createHookHarness(metadataElement.type);
  const savedMetadata = [];
  let restoredDirectFocus = 0;
  let initialTagFocuses = 0;
  const returnControl = { focus: () => { restoredDirectFocus += 1; documentMock.activeElement = returnControl; } };
  const directTagControl = { focus: () => { initialTagFocuses += 1; documentMock.activeElement = directTagControl; } };
  const directSaveControl = { focus: () => { documentMock.activeElement = directSaveControl; } };
  let dialogProps = {
    ...metadataElement.props,
    returnFocus: returnControl,
    onSave: (tags, note) => { savedMetadata.push({ tags, note }); },
    onCancel: () => {},
  };
  let directTree = harness.render(dialogProps);
  let directElements = collectElements(directTree);
  let directDialog = directElements.find((el) => el.props?.role === 'dialog');
  let directInput = directElements.find((el) => el.props?.id === 'dac-meta-tags');
  if (directDialog?.props.ref) directDialog.props.ref.current = {
    contains: (node) => node === directTagControl || node === directSaveControl,
    querySelectorAll: () => [directTagControl, directSaveControl],
  };
  if (directInput?.props.ref) directInput.props.ref.current = directTagControl;
  documentMock.activeElement = returnControl;
  harness.flushEffects();
  assert(initialTagFocuses === 1, 'metadata dialog focuses the tag field once on mount');

  documentMock.activeElement = directSaveControl;
  dialogProps = { ...dialogProps, onSave: (tags, note) => { savedMetadata.push({ tags, note }); }, onCancel: () => {} };
  directTree = harness.render(dialogProps);
  harness.flushEffects();
  assert(initialTagFocuses === 1 && restoredDirectFocus === 0 && documentMock.activeElement === directSaveControl, 'parent re-render neither restores nor steals metadata dialog focus');

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

  // Unavailable metadata disables only metadata editing and shows a warning.
  states[18].value = 'unavailable';
  states[20].value = null;
  tree = renderSection();
  elements = collectElements(tree);
  const disabledEdits = elements.filter((el) => el.type === 'button' && el.props?.['aria-label'] === '编辑标签与备注');
  assert(disabledEdits.length === 3 && disabledEdits.every((el) => el.props?.disabled === true), 'metadata edit disabled when metadata is unavailable');
  assert(elements.find((el) => el.props?.className === 'dac-warn') !== undefined, 'unavailable metadata shows a warning');
  assert(elements.filter(isRow).length === 3, 'unavailable metadata keeps all rows listed');

  // Statistics failure never removes rows or lifecycle actions.
  states[19].value = { status: 'error', summary: null, sessions: {} };
  states[18].value = 'ready';
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
    const visibleAssistant = clientExports.__test.buildPreviewNodes(previewElement.props.preview.messages)[1];
    const assistantActions = previewElements.find((element) => element.type?.name === 'PreviewActions' && element.props?.node?.key === visibleAssistant.key);
    const copyButton = collectElements(assistantActions).find((element) => element.type === 'button' && element.props?.['aria-label'] === '复制');
    await copyButton?.props.onClick();
    assert(copied[0] === clientExports.__test.previewCopyText(visibleAssistant), 'preview copy action writes the visible node text to the clipboard');
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
  const t = clientCtx.locale.bind('settings.archived-chats');
  const harness = createHookHarness(clientExports.__test.PreviewMarkdown);
  const fallback = harness.render({ text: '<b>literal</b>', t, primitives: missingPrimitives });
  assert(fallback.type === 'p' && fallback.props.className === 'dac-preview-plain' && fallback.props.children === '<b>literal</b>', 'preview Markdown fallback renders literal text in a plain paragraph');
}

console.log('\n[11f] client half — recycle navigation and management');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const requests = [];
  const archiveRows = [{ id: 'archive-a', title: 'Archived Alpha', createdAt: 10, origin: null, workspaceId: 'ws-1', workspaceTitle: '项目一' }];
  let recycleRows = [
    {
      sessionId: 'trash-a', state: 'trashed', trashedAt: '2026-08-24T01:02:03.000Z', title: 'Trash Alpha',
      createdAt: 10, workspace: { id: 'ws-1', title: '项目一' }, snapshotBytes: 1536,
      snapshotAttachmentCount: 2, liveDisposition: 'cold',
    },
    {
      sessionId: 'trash-b', state: 'degraded', trashedAt: '2026-08-24T02:03:04.000Z', title: 'Trash Beta',
      createdAt: 20, workspace: null, snapshotBytes: 0, snapshotAttachmentCount: 0, liveDisposition: 'parked',
    },
  ];
  const responseFor = (payload) => ({ ok: true, status: 200, json: async () => payload });
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
      const purged = recycleRows.map((row) => row.sessionId);
      recycleRows = [];
      return responseFor({ purged, failed: [] });
    }
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
  assert(tabs.length === 4, 'archive manager renders Archived, Recycle Bin, Storage, and Lineage tabs');
  assert(tabs[0]?.props['aria-selected'] === true && tabs.slice(1).every((tab) => tab.props['aria-selected'] === false), 'Archived is the default selected tab');
  tabs[1]?.props.onClick();

  tree = harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = harness.render({ t, refreshSidebar: () => {} });
  harness.flushEffects();
  elements = collectElements(tree);
  assert(requests.filter((request) => request.path.endsWith('/trash')).length === 1, 'first Recycle Bin activation loads trash once');
  assert(elements.some((element) => element.type === 'button' && element.props?.role === 'tab' && element.props?.['aria-selected'] === true && elementText(element) === '回收站'), 'Recycle Bin tab becomes selected');
  assert(elementText(tree).includes('Trash Alpha') && elementText(tree).includes('项目一'), 'recycle row renders title and original project');
  assert(elementText(tree).includes('1.5 KB') && elementText(tree).includes('2 个附件'), 'recycle row renders snapshot bytes and attachment count');
  assert(elementText(tree).includes('保护快照可用') && elementText(tree).includes('快照降级'), 'recycle rows render ready and degraded statuses');

  let recycleCheckboxes = elements.filter((element) => element.type === 'input' && element.props?.type === 'checkbox');
  assert(recycleCheckboxes.length === 0, 'recycle rows hide all selection checkboxes by default');
  assert(!elements.some((element) => element.type === 'button' && ['恢复选中项', '永久删除选中项'].includes(elementText(element))), 'recycle selected-item actions are hidden by default');
  const startRecycleSelection = elements.find((element) => element.type === 'button' && elementText(element) === '批量选择');
  assert(startRecycleSelection !== undefined, 'recycle toolbar exposes an on-demand selection trigger');
  startRecycleSelection?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  elements = collectElements(tree);
  recycleCheckboxes = elements.filter((element) => element.type === 'input' && element.props?.type === 'checkbox');
  assert(recycleCheckboxes.some((element) => element.props?.['aria-label'] === '选择全部回收站会话'), 'recycle selection mode exposes the global checkbox');
  assert(recycleCheckboxes.some((element) => element.props?.['aria-label'] === '选择回收站会话: Trash Alpha'), 'recycle selection mode exposes row checkboxes');
  assert(elements.some((element) => element.type === 'button' && elementText(element) === '恢复选中项')
    && elements.some((element) => element.type === 'button' && elementText(element) === '永久删除选中项'), 'recycle selection mode exposes selected-item actions');
  const finishRecycleSelection = elements.find((element) => element.type === 'button' && elementText(element) === '完成');
  finishRecycleSelection?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  elements = collectElements(tree);
  assert(!elements.some((element) => element.type === 'input' && element.props?.type === 'checkbox'), 'finishing recycle selection hides every checkbox');
  assert(!elements.some((element) => element.type === 'button' && ['恢复选中项', '永久删除选中项'].includes(elementText(element))), 'finishing recycle selection hides selected-item actions');

  const collapseProject = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '折叠' && elementText(element).includes('项目一'));
  assert(collapseProject?.props['aria-expanded'] === true, 'recycle project group starts expanded');
  collapseProject?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  elements = collectElements(tree);
  assert(!elements.some((element) => element.props?.['data-session-id'] === 'trash-a'), 'collapsing a recycle group hides its rows');
  assert(JSON.parse(storageMap.get('dsh-archived-chats:collapsed') ?? '{}')['trash:ws-1'] === true, 'recycle collapse preference uses a tab-specific key');
  const expandProject = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '展开' && elementText(element).includes('项目一'));
  expandProject?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  elements = collectElements(tree);
  assert(elements.some((element) => element.props?.['data-session-id'] === 'trash-a'), 'expanding a recycle group restores its rows');

  const previewButton = elements.find((element) => element.type === 'button' && element.props?.['aria-label'] === '查看对话 Trash Alpha');
  await previewButton?.props.onClick();
  const previewRequest = requests.findLast((request) => request.path.endsWith('/preview'));
  assert(JSON.parse(previewRequest?.options.body ?? '{}').scope === 'trash', 'recycle preview is explicitly trash-scoped');

  const restoreButton = elements.find((element) => element.type === 'button' && elementText(element) === '恢复' && element.props?.['data-session-id'] === 'trash-a');
  await restoreButton?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  elements = collectElements(tree);
  assert(requests.some((request) => request.path.endsWith('/trash/restore') && request.options.body === '{"sessionIds":["trash-a"]}'), 'row restore targets exactly one recycle record');
  assert(!elements.some((element) => element.props?.['data-session-id'] === 'trash-a' && elementText(element) === '恢复')
    && elements.some((element) => element.props?.['data-session-id'] === 'trash-b' && elementText(element) === '恢复'), 'restore removes only the Host-confirmed row');

  const purgeButton = elements.find((element) => element.type === 'button' && elementText(element) === '永久删除');
  purgeButton?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  const purgeDialog = findComponentElement(tree, 'ConfirmDialog');
  assert(purgeDialog?.props.title === '永久删除回收站中的会话？', 'permanent purge opens a distinct accessible confirmation');
  assert(String(purgeDialog?.props.body).includes('原会话和保护快照'), 'permanent purge copy names original and snapshot removal');

  harness.unmount();
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
}

console.log('\n[11g] client half — archive move exposes immediate undo');
{
  const savedHooks = { ...moduleTable.react };
  const savedFetch = globalThis.fetch;
  const requests = [];
  const archived = [{ id: 'undo-a', title: 'Undo Alpha', createdAt: 10, origin: null, workspaceId: null, workspaceTitle: null }];
  const responseFor = (payload) => ({ ok: true, status: 200, json: async () => payload });
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith('/state')) return responseFor({ metadataStatus: 'ready', sessions: archived });
    if (path.endsWith('/stats')) return responseFor({ summary: { sessionCount: 1, totalBytes: 0, unavailableCount: 0 }, sessions: {} });
    if (path.endsWith('/delete-all')) return responseFor({ trashed: ['undo-a'], failed: [] });
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
  const rowMove = elements.find((element) => element.type === 'button' && element.props?.className === 'dac-iconbtn dac-danger' && element.props?.['aria-label'] === '全部移至回收站');
  rowMove?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  const moveDialog = findComponentElement(tree, 'ConfirmDialog');
  assert(moveDialog?.props.body === '会自动创建保护快照，之后可从回收站恢复', 'archive move confirmation promises recoverability rather than permanent deletion');
  await moveDialog?.props.onConfirm();
  tree = harness.render({ t, refreshSidebar: () => {} });
  elements = collectElements(tree);
  const undo = elements.find((element) => element.type === 'button' && elementText(element) === '撤销');
  assert(!elementText(tree).includes('Undo Alpha') && undo !== undefined, 'successful move removes the archived row and exposes Undo');
  await undo?.props.onClick();
  tree = harness.render({ t, refreshSidebar: () => {} });
  assert(requests.some((request) => request.path.endsWith('/trash/restore') && request.options.body === '{"sessionIds":["undo-a"]}'), 'Undo calls the guarded recycle restore route');
  assert(elementText(tree).includes('Undo Alpha') && !collectElements(tree).some((element) => element.type === 'button' && elementText(element) === '撤销'), 'successful Undo restores the archive row and clears the action');
  harness.unmount();
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
  const gearSvg = { dataset: {}, attrs: {}, innerHTML: '<circle cx="12" cy="12" r="3"/>', setAttribute(k, v) { this.attrs[k] = v; } };
  const otherSvg = { dataset: {}, attrs: {}, innerHTML: '<circle cx="12" cy="12" r="3"/>', setAttribute(k, v) { this.attrs[k] = v; } };
  const ownButton = { textContent: '已归档的聊天', querySelector: (sel) => (sel === 'svg' ? gearSvg : null) };
  const otherButton = { textContent: '通用', querySelector: (sel) => (sel === 'svg' ? otherSvg : null) };
  mockDialogs = [{ querySelectorAll: (sel) => (sel === 'nav button' ? [ownButton, otherButton] : []) }];
  observers[0].cb();
  assert(gearSvg.dataset.dacPatched === '1', 'our nav button icon marked as patched');
  assert(gearSvg.attrs.viewBox === '0 0 24 24', 'archive icon viewBox applied');
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

// Tear down the isolated DSH_HOME and session fixture dirs.
rmSync(testHome, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED\n' : `\n💥 ${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
