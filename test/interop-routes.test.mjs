import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { Session } from '@deepseek-ai/dsh-session';

function request(method, headers, body = '') {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function response() {
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
  res.body = () => res.bytes().toString('utf8');
  res.json = () => JSON.parse(res.body());
  return res;
}

async function invoke(routes, path, req) {
  const res = response();
  await routes.get(path)(req, res);
  if (!res.writableFinished) await new Promise((resolve) => res.once('finish', resolve));
  return res;
}

function multipart(fields, boundary = 'interop-test') {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const filename = name === 'file' ? '; filename="chat.jsonl"' : '';
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename}\r\n\r\n`));
    parts.push(body, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function form(values) {
  return new URLSearchParams(values).toString();
}

async function fixture(name) {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL(`./fixtures/interop/${name}`, import.meta.url));
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-interop-routes-'));
  const archiveDir = join(home, 'session-a');
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, 'session.jsonl.zstd'), 'source');
  const state = { archivedSessionIds: ['session-a'] };
  const events = [{
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'archived' }] },
  }];
  const registry = {
    state,
    get archivedSessionIds() { return state.archivedSessionIds; },
    list: () => [{ id: 'workspace-a', title: 'Workspace', path: '/workspace', sessionIds: ['session-a'] }],
    async setState(next) { state.archivedSessionIds = next.archivedSessionIds; },
    headers: new Map([['session-a', { id: 'session-a', createdAt: 1, cwd: '/workspace' }]]),
  };
  const persistence = {
    list: async () => [{ id: 'session-a', createdAt: 1, cwd: '/workspace' }],
    inspect: async () => ({ meta: { id: 'session-a' }, events }),
    locate: (header) => ({ path: join(home, String(header.id), 'session.jsonl.zstd') }),
    restored: [],
    async restoreSession(payload) {
      Session.fromRestore(payload.id, structuredClone(payload.events), structuredClone(payload.meta));
      this.restored.push(payload);
    },
  };
  const routes = new Map();
  const services = { webServer: undefined, workspaceRegistry: registry, sessionPersistence: persistence };
  const listeners = [];
  const ctx = {
    get: (key) => services[key],
    on: (event, callback) => listeners.push([event, callback]),
    effect: (effect) => effect(),
    logger: { warn() {}, info() {} },
  };
  const { apply } = await import(new URL('../lib/index.js', import.meta.url));
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    apply(ctx);
    services.webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } };
    listeners.find(([event]) => event === 'internal/service')?.[1]('webServer');
  }
  finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
  }
  return { routes, state, persistence };
}

test('interop inspect is guarded, bounded, source-specific, and read-only', async () => {
  const { routes, state } = await setup();
  const path = '/plugins/dsh-archived-chats/interop/inspect';
  assert.equal((await invoke(routes, path, request('GET', {}))).status, 405);
  const missingGuard = multipart({ source: 'codex', file: await fixture('codex-simple.jsonl') });
  assert.equal((await invoke(routes, path, request('POST', missingGuard.headers, missingGuard.body))).status, 403);

  const malformed = multipart({ source: 'codex', file: Buffer.from('{broken\n') });
  const malformedResponse = await invoke(routes, path, request('POST', { ...malformed.headers, 'x-dsh-archived-chats': '1' }, malformed.body));
  assert.equal(malformedResponse.status, 200);
  assert.ok(malformedResponse.json().report.losses.some((loss) => loss.code === 'malformed-json'));

  const unsupported = multipart({ source: 'other', file: Buffer.from('{}\n') });
  assert.equal((await invoke(routes, path, request('POST', { ...unsupported.headers, 'x-dsh-archived-chats': '1' }, unsupported.body))).status, 400);
  const oversized = multipart({ source: 'codex', file: Buffer.alloc(8 * 1024 * 1024) });
  assert.equal((await invoke(routes, path, request('POST', { ...oversized.headers, 'x-dsh-archived-chats': '1' }, oversized.body))).status, 413);

  const valid = multipart({ source: 'codex', file: await fixture('codex-simple.jsonl') });
  const before = [...state.archivedSessionIds];
  const preview = await invoke(routes, path, request('POST', { ...valid.headers, 'x-dsh-archived-chats': '1' }, valid.body));
  assert.equal(preview.status, 200);
  const value = preview.json();
  assert.equal(typeof value.token, 'string');
  assert.equal(typeof value.nonce, 'string');
  assert.equal(value.report.source, 'codex');
  assert.equal(value.sessions[0].id, 'codex-simple');
  assert.deepEqual(state.archivedSessionIds, before);
});

test('interop preview token restores selected external sessions as archived records', async () => {
  const { routes, state, persistence } = await setup();
  const upload = multipart({ source: 'codex', file: await fixture('codex-tools.jsonl') });
  const preview = await invoke(routes, '/plugins/dsh-archived-chats/interop/inspect', request(
    'POST',
    { ...upload.headers, 'x-dsh-archived-chats': '1' },
    upload.body,
  ));
  assert.equal(preview.status, 200);
  const { token, nonce } = preview.json();
  const restored = await invoke(routes, '/plugins/dsh-archived-chats/import/restore', request(
    'POST',
    { 'content-type': 'application/json', 'x-dsh-archived-chats': '1' },
    JSON.stringify({ token, nonce, sessionIds: ['codex-tools'] }),
  ));

  assert.equal(restored.status, 200, restored.body());
  assert.deepEqual(restored.json().restored, ['codex-tools']);
  assert.ok(restored.json().warnings.some((warning) => warning.id === 'codex-tools' && warning.reason === 'attachments-not-included'));
  assert.deepEqual(state.archivedSessionIds, ['session-a', 'codex-tools']);
  assert.equal(persistence.restored.length, 1);
  assert.deepEqual(persistence.restored[0].meta, {
    version: 0,
    id: 'codex-tools',
    createdAt: persistence.restored[0].meta.createdAt,
    cwd: '/work/repo',
  });
  assert.ok(Number.isSafeInteger(persistence.restored[0].meta.createdAt));
  assert.ok(persistence.restored[0].events.some((event) => event.type === 'user/message'));
  assert.ok(persistence.restored[0].events.some((event) => event.type === 'assistant/message'));
  assert.ok(persistence.restored[0].events.some((event) => event.type === 'tool/result'));
});

test('interop export selects archived records and emits target-specific JSONL', async () => {
  const { routes } = await setup();
  const path = '/plugins/dsh-archived-chats/interop/export';
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-dsh-archived-chats': '1' };
  const body = form({ sessionIds: JSON.stringify(['session-a']), target: 'claude' });
  const result = await invoke(routes, path, request('POST', headers, body));
  assert.equal(result.status, 200);
  assert.match(result.headers['content-disposition'], /attachment;/);
  assert.match(result.headers['content-disposition'], /claude/);
  assert.equal(JSON.parse(result.body().split('\n')[0]).type, 'system');
  assert.equal((await invoke(routes, path, request('POST', headers, form({ sessionIds: '[]', target: 'codex' })))).status, 400);
  assert.equal((await invoke(routes, path, request('POST', headers, `${body}&padding=${'x'.repeat(512 * 1024)}`))).status, 413);
  assert.equal((await invoke(routes, path, request('POST', { 'content-type': headers['content-type'] }, body))).status, 403);
});
