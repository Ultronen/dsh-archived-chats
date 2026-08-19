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
  const cbs = {};
  const req = { method, headers, on: (event, cb) => { cbs[event] = cb; } };
  queueMicrotask(() => {
    if (bodyText !== undefined) cbs.data?.(Buffer.from(bodyText));
    cbs.end?.();
  });
  return req;
}
function mockRes() {
  return {
    status: 0, headers: {}, body: '',
    writeHead(s, h) { this.status = s; this.headers = h ?? {}; },
    end(b) { this.body = b ?? ''; },
    json() { return JSON.parse(this.body); },
  };
}
async function call(routes, path, req) {
  const handler = routes.get(path);
  if (!handler) throw new Error(`no route registered for ${path}`);
  const res = mockRes();
  await handler(req, res);
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

const events = {
  'session-a': [
    { type: 'session/title', data: { title: '第一个归档' } },
    { type: 'session/title', data: { title: '改名后的归档' } },
  ],
  'session-b': [{ type: 'session/title', data: { title: 'Beta chat' } }],
  'session-c': [],
};
const headerRows = [
  { id: 'session-a', createdAt: 1786726311605, cwd: '/ws/one' },
  { id: 'session-b', createdAt: 1786726400000, cwd: '/ws/two', origin: 'subagent' },
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

const { apply, name } = await import(join(here, '../lib/index.js'));
//#endregion

console.log('\n[1] host half — lazy route registration');
apply(ctx);
assert(name === 'archived-chats', `plugin name is "archived-chats" (got "${name}")`);
assert(routes.size === 0, 'no routes while webServer is unbound');
services.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } };
listeners.find(([event]) => event === 'internal/service')?.[1]('webServer');
assert(routes.size === 7, `seven routes registered after webServer binds (got ${routes.size})`);
for (const path of ['state', 'stats', 'metadata', 'unarchive', 'unarchive-all', 'delete', 'delete-all']) {
  assert(routes.has(`/plugins/dsh-archived-chats/${path}`), `route /${path} registered`);
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

console.log('\n[5] delete — live session parked for next-boot deletion');
{
  workspaceState.archivedSessionIds.push('session-live');
  const res = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-live"}'));
  assert(res.status === 200, `live session deletion accepted (got ${res.status})`);
  const body = res.json();
  assert(body.pending.includes('session-live'), 'live session reported as pending');
  assert(body.deleted.length === 0 && body.failed.length === 0, 'no deleted/failed entries for a parked session');
  assert(existsSync(join(tmp, 'session-live')), 'live session files untouched');
  assert(workspaceState.archivedSessionIds.includes('session-live'), 'parked session stays archived (invisible)');
  assert(readPendingStore().includes('session-live'), 'parked id recorded in the pending-deletion store');
  assert(readMetadataStore().sessions['session-live'] !== undefined, 'parked delete keeps metadata until physical deletion');
  const stateAfterPark = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(!stateAfterPark.json().sessions.some((s) => s.id === 'session-live'), 'parked session excluded from /state listing');
  const statsAfterPark = await call(routes, '/plugins/dsh-archived-chats/stats', mockReq('GET', {}));
  assert(statsAfterPark.json().summary.sessionCount === 2, 'stats exclude a parked pending-deletion session');
  assert(statsAfterPark.json().sessions['session-live'] === undefined, 'stats omit the parked session row');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((id) => id !== 'session-live');
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
  assert(res.status === 200, `in-place deletion answers 200 (got ${res.status})`);
  const body = res.json();
  assert(body.deleted.includes(id), 'live session reported as deleted, not pending');
  assert(body.pending.length === 0 && body.failed.length === 0, 'no pending/failed entries');
  assert(calls.cancel?.kind === 'disposed', 'agent cancelled with the disposed cause');
  assert(calls.idle === 1, 'quiescence awaited before flush');
  assert(calls.flush === 1, 'durability flushed before detach');
  assert(calls.scope === 1, 'agent fiber disposed (factory disposer order)');
  assert(calls.agentDetach === 1 && calls.sessionDetach === 1, 'both store entries detached');
  assert(!existsSync(join(tmp, id)), 'session directory removed in the same request');
  assert(!workspaceState.archivedSessionIds.includes(id), 'deleted session left the archive set');
  assert(!readPendingStore().includes(id), 'pending-store crash bracket cleared after completion');
  assert(readPendingStore().includes('session-live'), 'unrelated parked id untouched by the bracket cleanup');
  services.sessions = liveSessions;
  delete services.agents;
}

console.log('\n[6] delete — full path');
{
  const res = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-b"}'));
  assert(res.status === 200, `delete answers 200 (got ${res.status})`);
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
  assert(res.status === 200, `batch with mixed results answers 200 (got ${res.status})`);
  assert(body.pending.includes('session-live'), 'live session reported as pending');
  assert(body.failed.length === 0, 'no failures in the mixed batch');
  assert(!existsSync(join(tmp, 'session-c')), 'session-c directory removed');
  assert(body.deleted.includes('session-c'), 'cold delete remains successful when metadata cleanup is unavailable');
  assert(readFileSync(metadataFile, 'utf8') === corruptMetadata, 'failed metadata cleanup leaves corrupt metadata bytes untouched');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((id) => id !== 'session-live');
}

console.log('\n[9] boot sweep — deferred deletions complete on the next boot');
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
    inspect: async () => ({ events: [] }),
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
  applyBoot(ctx2);
  assert(readPendingStore().includes('session-live'), 'pending store holds the parked id before boot');
  services2.webServer = { register: (r) => { routes2.set(r.path, r.handler); return () => routes2.delete(r.path); } };
  listeners2.find(([event]) => event === 'internal/service')?.[1]('webServer');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(!existsSync(join(tmp, 'session-live')), 'parked session directory removed at boot');
  assert(!state2.archivedSessionIds.includes('session-live'), 'parked session left the archive set');
  assert(readPendingStore().length === 0, 'pending store drained after the sweep');
}

console.log('\n[10] unarchive of a parked session drops its pending-deletion mark');
{
  workspaceState.archivedSessionIds.push('session-live');
  const res = await call(routes, '/plugins/dsh-archived-chats/delete', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-live"}'));
  assert(res.status === 200, 'parked delete accepted');
  assert(readPendingStore().includes('session-live'), 'session-live parked again');
  const un = await call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionId":"session-live"}'));
  assert(un.status === 200, 'unarchive answers 200');
  assert(!readPendingStore().includes('session-live'), 'unarchive removed the pending-deletion mark');
  assert(!workspaceState.archivedSessionIds.includes('session-live'), 'session-live unarchived');
}

console.log('\n[10b] concurrent pending add/remove operations retain unrelated ids');
{
  const ids = ['session-live-race-a', 'session-live-race-b', 'session-live-race-c'];
  for (const id of ids) {
    mkdirSync(join(tmp, id), { recursive: true });
    writeFileSync(join(tmp, id, 'session.jsonl.zstd'), 'fake');
  }
  workspaceState.archivedSessionIds.push(ids[0], ids[1]);
  const originalSessions = services.sessions;
  services.sessions = { get: (id) => ids.includes(id) ? { id, header: { id } } : undefined };
  const responses = await Promise.all(ids.slice(0, 2).map((id) => call(routes, '/plugins/dsh-archived-chats/delete', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
  ))));
  assert(responses.every((response) => response.json().pending.length === 1), 'each live delete is parked');
  assert(ids.slice(0, 2).every((id) => readPendingStore().includes(id)), 'concurrent pending writes retain the union of parked ids');
  workspaceState.archivedSessionIds.push(ids[2]);
  const [unarchiveResponse, deleteResponse] = await Promise.all([
    call(routes, '/plugins/dsh-archived-chats/unarchive', mockReq(
      'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: ids[0] }),
    )),
    call(routes, '/plugins/dsh-archived-chats/delete', mockReq(
      'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: ids[2] }),
    )),
  ]);
  services.sessions = originalSessions;
  const pendingAfterRace = readPendingStore();
  assert(unarchiveResponse.status === 200 && deleteResponse.json().pending.includes(ids[2]), 'concurrent unarchive and live delete both complete');
  assert(!pendingAfterRace.includes(ids[0]), 'concurrent unarchive removes only its pending id');
  assert(pendingAfterRace.includes(ids[1]) && pendingAfterRace.includes(ids[2]), 'concurrent pending add/remove retains old and newly parked ids');
}

console.log('\n[10c] failed boot sweep retains the pending marker and archive indexes');
{
  const originalHome = process.env.DSH_HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-archive-sweep-failure-'));
  process.env.DSH_HOME = isolatedHome;
  const id = 'session-live-sweep-failure';
  const directory = join(isolatedHome, 'sessions', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'session.jsonl.zstd'), 'fake');
  const state = { initialized: true, workspaceIds: [], archivedSessionIds: [id] };
  const header = { id, createdAt: 1 };
  const registryForPark = {
    state,
    get archivedSessionIds() { return state.archivedSessionIds; },
    list: () => [],
    async setState(next) { state.archivedSessionIds = next.archivedSessionIds; },
    headers: new Map([[id, header]]),
    sessionPaths: new Map([[id, directory]]),
    invalidSessionPaths: new Map(),
  };
  const persistenceForPark = {
    list: async () => [header],
    inspect: async () => ({ meta: header, events: [] }),
    locate: () => ({ kind: 'jsonl', path: join(directory, 'session.jsonl.zstd') }),
  };
  const parkRoutes = new Map();
  const parkServices = {
    webServer: { register: (route) => { parkRoutes.set(route.path, route.handler); return () => {}; } },
    workspaceRegistry: registryForPark,
    sessionPersistence: persistenceForPark,
    sessions: { get: (sessionId) => sessionId === id ? { id, header } : undefined },
  };
  apply({
    get: (key) => parkServices[key],
    on: () => {},
    effect: (fn) => { fn(); },
    logger: { warn: () => {}, info: () => {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const parked = await call(parkRoutes, '/plugins/dsh-archived-chats/delete', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
  ));
  assert(parked.json().pending.includes(id), 'fixture parks a live session through the real delete route');

  const sweepWarnings = [];
  const sweepInfo = [];
  const registryForSweep = {
    ...registryForPark,
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
  };
  const sweepServices = {
    webServer: { register: () => () => {} },
    workspaceRegistry: registryForSweep,
    sessionPersistence: {
      list: async () => [],
      inspect: async () => { throw new Error('session unavailable'); },
      locate: async () => undefined,
    },
    sessions: { get: () => undefined },
  };
  apply({
    get: (key) => sweepServices[key],
    on: () => {},
    effect: (fn) => { fn(); },
    logger: {
      warn: (message) => sweepWarnings.push(String(message)),
      info: (message) => sweepInfo.push(String(message)),
    },
  });
  const sweepFailed = await waitUntil(() => sweepWarnings.some((message) => message.includes(`pending deletion ${id} failed again`)));
  const pendingPath = join(isolatedHome, 'plugin-data', 'archived-chats', 'pending-deletions.json');
  const pendingAfterFailure = JSON.parse(readFileSync(pendingPath, 'utf8')).ids;
  assert(sweepFailed, 'boot sweep reports the unresolved physical location');
  assert(pendingAfterFailure.includes(id), 'failed boot sweep retains the pending marker');
  assert(state.archivedSessionIds.includes(id), 'failed boot sweep keeps the session archived');
  assert(existsSync(directory), 'failed boot sweep leaves the physical session directory');
  assert(!sweepInfo.some((message) => message.includes(`swept pending deletion ${id}`)), 'failed boot sweep never reports a successful deletion');
  process.env.DSH_HOME = originalHome;
  rmSync(isolatedHome, { recursive: true, force: true });
}

console.log('\n[10d] boot sweep cannot overwrite a pending id added after its snapshot');
{
  const originalHome = process.env.DSH_HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-archive-sweep-race-'));
  process.env.DSH_HOME = isolatedHome;
  const sweptId = 'session-sweep-snapshot';
  const addedId = 'session-added-during-sweep';
  const sweptDirectory = join(isolatedHome, 'sessions', sweptId);
  const addedDirectory = join(isolatedHome, 'sessions', addedId);
  for (const directory of [sweptDirectory, addedDirectory]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'session.jsonl.zstd'), 'fake');
  }
  const pendingPath = join(isolatedHome, 'plugin-data', 'archived-chats', 'pending-deletions.json');
  mkdirSync(dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, JSON.stringify({ ids: [sweptId] }), 'utf8');
  const state = { initialized: true, workspaceIds: [], archivedSessionIds: [sweptId, addedId] };
  const sweptHeader = { id: sweptId, createdAt: 1 };
  const registryForRace = {
    state,
    get archivedSessionIds() { return state.archivedSessionIds; },
    list: () => [],
    async setState(next) { state.archivedSessionIds = next.archivedSessionIds; },
    headers: new Map([[sweptId, sweptHeader]]),
    sessionPaths: new Map([[sweptId, sweptDirectory]]),
    invalidSessionPaths: new Map(),
  };
  let releaseList;
  let markListEntered;
  const listEntered = new Promise((resolve) => { markListEntered = resolve; });
  const listReleased = new Promise((resolve) => { releaseList = resolve; });
  const raceRoutes = new Map();
  const sweepInfo = [];
  const raceServices = {
    webServer: { register: (route) => { raceRoutes.set(route.path, route.handler); return () => {}; } },
    workspaceRegistry: registryForRace,
    sessionPersistence: {
      list: async () => {
        markListEntered();
        await listReleased;
        return [sweptHeader];
      },
      inspect: async () => ({ meta: sweptHeader, events: [] }),
      locate: (header) => ({ kind: 'jsonl', path: join(isolatedHome, 'sessions', String(header.id), 'session.jsonl.zstd') }),
    },
    sessions: { get: (id) => id === addedId ? { id, header: { id } } : undefined },
  };
  apply({
    get: (key) => raceServices[key],
    on: () => {},
    effect: (fn) => { fn(); },
    logger: { warn: () => {}, info: (message) => sweepInfo.push(String(message)) },
  });
  await waitFor(listEntered);
  const added = await call(raceRoutes, '/plugins/dsh-archived-chats/delete', mockReq(
    'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: addedId }),
  ));
  assert(added.json().pending.includes(addedId), 'live delete adds a pending id while the sweep is paused');
  // The boot sweep must finish all post-rm cleanup before this fixture is torn down.
  // Its info log is the observable completion boundary, not directory removal alone.
  releaseList();
  const sweepFinished = await waitUntil(() => sweepInfo.some((message) => message.includes(`swept pending deletion ${sweptId}`)));
  const swept = !existsSync(sweptDirectory);
  const pendingAfterSweep = JSON.parse(readFileSync(pendingPath, 'utf8')).ids;
  assert(sweepFinished && swept && !state.archivedSessionIds.includes(sweptId), 'snapshot entry completes deletion after the sweep resumes');
  assert(pendingAfterSweep.includes(addedId), 'sweep cleanup retains the id added after its snapshot');
  assert(!pendingAfterSweep.includes(sweptId), 'sweep cleanup removes only the completed snapshot id');
  assert(existsSync(addedDirectory), 'newly parked session remains available for the next boot');
  process.env.DSH_HOME = originalHome;
  rmSync(isolatedHome, { recursive: true, force: true });
}

console.log('\n[10e] unarchive wins when it cancels the same id during a paused sweep');
{
  const originalHome = process.env.DSH_HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-archive-sweep-cancel-'));
  process.env.DSH_HOME = isolatedHome;
  const id = 'session-cancelled-during-sweep';
  const directory = join(isolatedHome, 'sessions', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'session.jsonl.zstd'), 'fake');
  const pendingPath = join(isolatedHome, 'plugin-data', 'archived-chats', 'pending-deletions.json');
  mkdirSync(dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, JSON.stringify({ ids: [id] }), 'utf8');
  const state = { initialized: true, workspaceIds: [], archivedSessionIds: [id] };
  const header = { id, createdAt: 1 };
  const registry = {
    state,
    get archivedSessionIds() { return state.archivedSessionIds; },
    list: () => [],
    async setState(next) { state.archivedSessionIds = next.archivedSessionIds; },
    headers: new Map([[id, header]]),
    sessionPaths: new Map([[id, directory]]),
    invalidSessionPaths: new Map(),
  };
  let releaseList;
  let markListEntered;
  const listEntered = new Promise((resolve) => { markListEntered = resolve; });
  const listReleased = new Promise((resolve) => { releaseList = resolve; });
  const routesForCancel = new Map();
  const sweepInfo = [];
  const servicesForCancel = {
    webServer: { register: (route) => { routesForCancel.set(route.path, route.handler); return () => {}; } },
    workspaceRegistry: registry,
    sessionPersistence: {
      list: async () => {
        markListEntered();
        await listReleased;
        return [header];
      },
      inspect: async () => ({ meta: header, events: [] }),
      locate: () => ({ kind: 'jsonl', path: join(directory, 'session.jsonl.zstd') }),
    },
    sessions: { get: () => undefined },
  };
  try {
    apply({
      get: (key) => servicesForCancel[key],
      on: () => {},
      effect: (fn) => { fn(); },
      logger: { warn: () => {}, info: (message) => sweepInfo.push(String(message)) },
    });
    await waitFor(listEntered);
    const unarchived = await call(routesForCancel, '/plugins/dsh-archived-chats/unarchive', mockReq(
      'POST', { 'x-dsh-archived-chats': '1' }, JSON.stringify({ sessionId: id }),
    ));
    assert(unarchived.status === 200, 'same-id unarchive succeeds while the boot sweep is paused');
    releaseList();
    const sweepSettled = await waitUntil(() => sweepInfo.some((message) => message.includes(`cancelled pending deletion ${id}`))
      || sweepInfo.some((message) => message.includes(`swept pending deletion ${id}`)));
    const pendingAfterCancel = JSON.parse(readFileSync(pendingPath, 'utf8')).ids;
    assert(sweepSettled && !sweepInfo.some((message) => message.includes(`swept pending deletion ${id}`)), 'cancelled sweep never reports a successful deletion');
    assert(!state.archivedSessionIds.includes(id), 'same-id unarchive removes the session from the archive set');
    assert(!pendingAfterCancel.includes(id), 'same-id unarchive removes the pending marker');
    assert(existsSync(directory), 'same-id unarchive preserves the physical session directory');
  } finally {
    process.env.DSH_HOME = originalHome;
    rmSync(isolatedHome, { recursive: true, force: true });
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
  assert(deleteResponse.status === 200 && unarchiveResponse.status === 200, 'serialized live delete and unarchive both answer successfully');
  assert(!existsSync(join(tmp, id)) && !sessionsStore.has(id) && !agentsStore.has(id), 'live delete owns the serialized commit after disposal begins');
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
    remove() { this.removed = true; },
  };
  createdElements.push(el);
  return el;
}
let mockDialogs = [];
const documentMock = {
  createElement: (tag) => makeElement(tag),
  head: { appendChild: (c) => headChildren.push(c) },
  body: {},
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
const moduleTable = {
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
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
}

console.log('\n[11] client half — settings section registration');
{
  clientExports.apply(clientCtx);
  assert(clientCalls.localeRegister.length === 1, 'locale dictionaries registered once');
  assert(clientCalls.localeRegister[0].ns === 'settings.archived-chats', 'locale namespace is settings.archived-chats');
  const zhDict = clientCalls.localeRegister[0].dicts.zh;
  assert(zhDict['nav'] === '已归档的聊天', 'zh nav label is 已归档的聊天');
  assert(zhDict['delete.all'] === '全部删除', 'zh delete-all label present');
  assert(zhDict['confirm.deleteOne.title'] === '删除已归档聊天？', 'confirm copy matches CodeX (title)');
  assert(zhDict['confirm.deleteOne.body'] === '这将永久删除已归档聊天', 'confirm copy matches CodeX (body)');
  assert(zhDict['group.collapse'] === '折叠' && zhDict['group.expand'] === '展开', 'collapse/expand labels present');
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
  if (typeof node.type === 'function') return collectElements(node.type(node.props ?? {}), result);
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
  let pendingEffects = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
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
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  return {
    render(props) {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
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

console.log('\n[11b] client half — bulk selection workflow');
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
      : index === 2
        ? 'Alpha'
        : index === 7
          ? { title: '删除选中的已归档聊天？', body: '这将永久删除选中的 1 个已归档聊天', ids: ['session-a'] }
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
  assert(elementText(bulkBar).includes('取消归档') && elementText(bulkBar).includes('删除') && elementText(bulkBar).includes('清除'), 'bulk bar exposes unarchive, delete, and clear actions');

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

  let cancelFocuses = 0;
  let destructiveFocuses = 0;
  let restoredFocuses = 0;
  let fallbackFocuses = 0;
  const previousFocus = { focus: () => { restoredFocuses += 1; documentMock.activeElement = previousFocus; } };
  const fallbackFocus = { focus: () => { fallbackFocuses += 1; documentMock.activeElement = fallbackFocus; } };
  const cancelControl = { focus: () => { cancelFocuses += 1; documentMock.activeElement = cancelControl; } };
  const destructiveControl = { focus: () => { destructiveFocuses += 1; documentMock.activeElement = destructiveControl; } };
  const cancelButton = elements.find((el) => el.type === 'button' && elementText(el) === '取消');
  const destructiveButton = elements.find((el) => el.type === 'button' && elementText(el) === '删除' && el.props?.className === 'dac-btn-danger');
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
  states[12] = { value: '', setter: null };
  states[13] = { value: 'ready', setter: null };
  states[14] = { value: statsFixture, setter: null };
  states[15] = { value: null, setter: null };
  states[16] = { value: false, setter: null };
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
  const summary = elements.find((el) => el.props?.className === 'dac-summary');
  assert(summary !== undefined, 'summary strip rendered below the title');
  assert(elementText(summary).includes('3 个聊天'), 'summary reports the archived chat count');
  assert(elementText(summary).includes('1.5 KB'), 'summary reports the measured total size');
  assert(elementText(summary).includes('部分会话无法统计'), 'summary flags unavailable measurements');

  const tagSelect = elements.find((el) => el.type === 'select' && el.props?.['aria-label'] === '全部标签');
  assert(tagSelect !== undefined, 'tag filter select rendered');
  assert(tagSelect?.props.value === '', 'tag filter defaults to the non-colliding no-filter sentinel');
  const importantOptions = tagSelect?.props.children.filter((option) => String(option.props.children).toLowerCase() === 'important') ?? [];
  assert(importantOptions.length === 1, 'tag filter options de-duplicate labels case-insensitively');
  states[12].value = 'all';
  tree = renderSection();
  elements = collectElements(tree);
  const filteredRows = elements.filter(isRow);
  assert(filteredRows.length === 1 && elementText(filteredRows[0]).includes('Beta'), 'selecting the literal all tag renders only sessions carrying that tag');
  states[12].value = '';
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
  assert(states[15].value === null, 'metadata Escape cancels only the metadata editor state');
  cleanupMeta?.();
  assert(editFocuses === 1 && documentMock.activeElement === editTrigger, 'metadata dialog restores focus to the row edit button');

  states[15].value = archivedRows[0];
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
  states[15].value = commaTagSession;
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
  states[13].value = 'unavailable';
  states[15].value = null;
  tree = renderSection();
  elements = collectElements(tree);
  const disabledEdits = elements.filter((el) => el.type === 'button' && el.props?.['aria-label'] === '编辑标签与备注');
  assert(disabledEdits.length === 3 && disabledEdits.every((el) => el.props?.disabled === true), 'metadata edit disabled when metadata is unavailable');
  assert(elements.find((el) => el.props?.className === 'dac-warn') !== undefined, 'unavailable metadata shows a warning');
  assert(elements.filter(isRow).length === 3, 'unavailable metadata keeps all rows listed');

  // Statistics failure never removes rows or lifecycle actions.
  states[14].value = { status: 'error', summary: null, sessions: {} };
  states[13].value = 'ready';
  tree = renderSection();
  elements = collectElements(tree);
  assert(elements.filter(isRow).length === 3, 'statistics failure keeps all rows rendered');
  assert(elements.filter((el) => el.type === 'button' && elementText(el) === '取消归档').length === 3, 'statistics failure keeps unarchive actions');
  assert(elements.filter((el) => el.type === 'button' && el.props?.['aria-label'] === '编辑标签与备注').every((el) => el.props?.disabled !== true), 'statistics failure keeps metadata editing usable');

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
