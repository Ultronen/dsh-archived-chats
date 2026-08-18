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
const ctx = {
  get: (key) => services[key],
  on: (event, cb) => { listeners.push([event, cb]); },
  effect: (fn) => { fn(); },
  logger: { warn: () => {} },
};

const { apply, name } = await import(join(here, '../lib/index.js'));
//#endregion

console.log('\n[1] host half — lazy route registration');
apply(ctx);
assert(name === 'archived-chats', `plugin name is "archived-chats" (got "${name}")`);
assert(routes.size === 0, 'no routes while webServer is unbound');
services.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } };
listeners.find(([event]) => event === 'internal/service')?.[1]('webServer');
assert(routes.size === 5, `all five routes registered after webServer binds (got ${routes.size})`);
for (const path of ['state', 'unarchive', 'unarchive-all', 'delete', 'delete-all']) {
  assert(routes.has(`/plugins/dsh-archived-chats/${path}`), `route /${path} registered`);
}

console.log('\n[2] GET /state');
{
  const res = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(res.status === 200, `state answers 200 (got ${res.status})`);
  const body = res.json();
  assert(body.sessions.length === 3, `three archived sessions listed (got ${body.sessions.length})`);
  const a = body.sessions.find((s) => s.id === 'session-a');
  assert(a.title === '改名后的归档', `last title event wins (got "${a.title}")`);
  assert(a.createdAt === 1786726311605, 'createdAt carried from the header');
  assert(a.workspaceId === 'ws-1' && a.workspaceTitle === '项目一', 'workspace resolved from accounting slot');
  const b = body.sessions.find((s) => s.id === 'session-b');
  assert(b.origin === 'subagent', 'subagent origin surfaced for the type filter');
  const c = body.sessions.find((s) => s.id === 'session-c');
  assert(c.title === null, 'title-less session lists with null title');
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
  const stateAfterPark = await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}));
  assert(!stateAfterPark.json().sessions.some((s) => s.id === 'session-live'), 'parked session excluded from /state listing');
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
}

console.log('\n[7] delete-all — partial failure keeps going');
{
  workspaceState.archivedSessionIds.push('session-live');
  const res = await call(routes, '/plugins/dsh-archived-chats/delete-all', mockReq('POST', { 'x-dsh-archived-chats': '1' }, '{"sessionIds":["session-c","session-live","session-b"]}'));
  const body = res.json();
  assert(res.status === 200, `batch with mixed results answers 200 (got ${res.status})`);
  assert(body.deleted.includes('session-c'), 'session-c deleted');
  assert(body.pending.includes('session-live'), 'live session reported as pending');
  assert(body.failed.length === 0, 'no failures in the mixed batch');
  assert(!existsSync(join(tmp, 'session-c')), 'session-c directory removed');
  workspaceState.archivedSessionIds = workspaceState.archivedSessionIds.filter((id) => id !== 'session-live');
}

console.log('\n[8] boot sweep — deferred deletions complete on the next boot');
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

console.log('\n[9] unarchive of a parked session drops its pending-deletion mark');
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
  querySelectorAll: (sel) => (sel === '[role="dialog"]' ? mockDialogs : []),
  getElementById: (id) => createdElements.find((e) => e.id === id && !e.removed) || null,
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

console.log('\n[11b] client half — bulk selection workflow');
{
  const savedHooks = { ...moduleTable.react };
  const archivedRows = [
    { id: 'session-a', title: 'Alpha', createdAt: 10, origin: null, workspaceId: 'ws-1', workspaceTitle: '项目一' },
    { id: 'session-b', title: 'Beta', createdAt: 20, origin: 'subagent', workspaceId: 'ws-1', workspaceTitle: '项目一' },
  ];
  let stateCall = 0;
  moduleTable.react.useState = (initial) => {
    const value = typeof initial === 'function' ? initial() : initial;
    const current = stateCall++ === 0 ? archivedRows : value instanceof Set ? new Set(['session-a']) : value;
    return [current, () => {}];
  };
  moduleTable.react.useEffect = () => {};
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
  const betaCheckbox = checkboxes.find((el) => el.props?.['aria-label'] === '选择 Beta');
  assert(alphaCheckbox?.props.checked === true, 'selected chat renders checked');
  assert(betaCheckbox?.props.checked === false, 'unselected chat renders unchecked');
  assert(checkboxes.some((el) => el.props?.['aria-checked'] === 'mixed'), 'partial visible selection exposes mixed state');

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
  globalThis.fetch = savedFetch;
  Object.assign(moduleTable.react, savedHooks);
  assert(requests[0]?.url === '/plugins/dsh-archived-chats/unarchive-all', 'bulk unarchive uses the batch endpoint');
  assert(JSON.parse(requests[0]?.options.body ?? '{}').sessionIds.join(',') === 'session-a', 'bulk unarchive sends exactly the selected ids');
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

// Tear down the isolated DSH_HOME and session fixture dirs.
rmSync(testHome, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED\n' : `\n💥 ${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
