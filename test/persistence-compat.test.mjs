import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersistenceCompat } from '../lib/persistence-compat.js';

const HEADER = Object.freeze({
  id: 'session-modern',
  version: 2,
  cwd: '/workspace',
  createdAt: 42,
  isSeeded: false,
});

test('preserves the modern public locate contract for a session-scoped purge location', async () => {
  const raw = {
    async list() { return [{ header: HEADER, revision: 'rev' }]; },
    async open() { throw new Error('unused'); },
    async locate(header) {
      assert.equal(this, raw);
      assert.equal(header, HEADER);
      return { kind: 'jsonl', path: '/sessions/session-modern/session.v2.jsonl' };
    },
  };
  const view = resolvePersistenceCompat(raw);
  assert.deepEqual(await view.locate(HEADER), {
    kind: 'jsonl',
    path: '/sessions/session-modern/session.v2.jsonl',
  });
  raw.locate = async () => undefined;
  assert.equal(await view.locate(HEADER), undefined);
  for (const location of [
    { kind: '', path: '/sessions/session-modern/session.v2.jsonl' },
    { kind: 'jsonl', path: 'session-modern/session.v2.jsonl' },
    { path: '/sessions/session-modern/session.v2.jsonl' },
  ]) {
    raw.locate = async () => location;
    await assert.rejects(view.locate(HEADER), { code: 'session-location-unavailable' });
  }
  assert.equal(view.create, undefined);
  assert.equal(view.append, undefined);
});

test('preserves a legacy inspection surface and its method receiver', async () => {
  const legacy = {
    marker: 'legacy',
    async inspect(id) {
      assert.equal(this, legacy);
      return { meta: { id }, events: [] };
    },
  };

  const view = resolvePersistenceCompat(legacy);

  assert.equal(view, legacy);
  assert.deepEqual(await view.inspect('session-legacy'), {
    meta: { id: 'session-legacy' },
    events: [],
  });
});

test('maps modern snapshots to legacy headers and forwards opaque revisions', async () => {
  const revision = 'backend-owned:revision:42';
  const snapshot = Object.freeze({ header: HEADER, revision, eventCount: 3, sizeBytes: 128 });
  const raw = {
    async list() {
      assert.equal(this, raw);
      return [snapshot];
    },
    async open() { throw new Error('not used'); },
  };

  const view = resolvePersistenceCompat(raw);

  assert.deepEqual(await view.list(), [HEADER]);
  const snapshots = await view.listSnapshots();
  assert.deepEqual(snapshots, [snapshot]);
  assert.equal(snapshots[0].revision, revision);
  assert.equal(view.locate, undefined);
  assert.equal(view.create, undefined);
  assert.equal(view.append, undefined);
});

test('opens modern persistence for exact read access and always closes after success', async () => {
  const events = Object.freeze([
    { seq: 0, type: 'session/start', data: {} },
    { seq: 1, type: 'user/message', data: { text: 'hello' } },
  ]);
  const openCalls = [];
  const readCalls = [];
  let closes = 0;
  const handle = {
    header: HEADER,
    inheritedEventCount: 0,
    async read(...args) {
      assert.equal(this, handle);
      readCalls.push(args);
      return events;
    },
    async close() {
      assert.equal(this, handle);
      closes += 1;
    },
  };
  const raw = {
    async list() { return [{ header: HEADER, revision: 'rev-1' }]; },
    async open(...args) {
      assert.equal(this, raw);
      openCalls.push(args);
      return handle;
    },
  };

  const inspected = await resolvePersistenceCompat(raw).inspect(HEADER.id);

  assert.deepEqual(inspected, { meta: HEADER, events });
  assert.deepEqual(openCalls, [[HEADER.id, 'read']]);
  assert.deepEqual(readCalls, [[0, undefined]]);
  assert.equal(closes, 1);
});

test('closes a modern read handle when reading fails', async () => {
  const failure = Object.assign(new Error('read failed'), { code: 'backend-read-failed' });
  let closes = 0;
  const raw = {
    async list() { return [{ header: HEADER, revision: 'rev-1' }]; },
    async open() {
      return {
        header: HEADER,
        inheritedEventCount: 0,
        async read() { throw failure; },
        async close() { closes += 1; },
      };
    },
  };

  await assert.rejects(resolvePersistenceCompat(raw).inspect(HEADER.id), (error) => error === failure);
  assert.equal(closes, 1);
});

test('refuses malformed or ambiguous modern persistence responses', async () => {
  const malformedListings = [
    null,
    [HEADER],
    [{ header: null, revision: 'rev-1' }],
    [{ header: { ...HEADER, id: '' }, revision: 'rev-1' }],
    [{ header: HEADER, revision: '' }],
    [
      { header: HEADER, revision: 'rev-1' },
      { header: { ...HEADER }, revision: 'rev-2' },
    ],
  ];
  for (const listing of malformedListings) {
    const view = resolvePersistenceCompat({
      async list() { return listing; },
      async open() { throw new Error('not used'); },
    });
    await assert.rejects(view.listSnapshots(), { code: 'persistence-response-invalid' });
  }

  const malformedHandle = resolvePersistenceCompat({
    async list() { return [{ header: HEADER, revision: 'rev-1' }]; },
    async open() {
      return {
        header: { ...HEADER, id: 'another-session' },
        inheritedEventCount: 0,
        async read() { return []; },
        async close() {},
      };
    },
  });
  await assert.rejects(malformedHandle.inspect(HEADER.id), { code: 'persistence-response-invalid' });

  const malformedEvents = resolvePersistenceCompat({
    async list() { return [{ header: HEADER, revision: 'rev-1' }]; },
    async open() {
      return {
        header: HEADER,
        inheritedEventCount: 0,
        async read() { return null; },
        async close() {},
      };
    },
  });
  await assert.rejects(malformedEvents.inspect(HEADER.id), { code: 'persistence-response-invalid' });
});

test('refuses incomplete or invalid current Host headers from both list and inspect', async () => {
  const malformedHeaders = [
    { id: HEADER.id },
    { ...HEADER, version: 1 },
    { ...HEADER, version: '2' },
    { ...HEADER, createdAt: -1 },
    { ...HEADER, createdAt: 1.5 },
    { ...HEADER, createdAt: '42' },
    { ...HEADER, isSeeded: 'false' },
    { ...HEADER, cwd: 42 },
    { ...HEADER, cwd: 'relative/path' },
    { ...HEADER, parentSession: 42 },
    { ...HEADER, origin: 'chat' },
    { ...HEADER, delegationDepth: -1 },
    { ...HEADER, delegationDepth: 1.5 },
    { ...HEADER, agentPreset: 42 },
    { ...HEADER, seedLength: 0 },
  ];

  for (const header of malformedHeaders) {
    const listing = resolvePersistenceCompat({
      async list() { return [{ header, revision: 'rev-invalid' }]; },
      async open() { throw new Error('not used'); },
    });
    await assert.rejects(listing.listSnapshots(), { code: 'persistence-response-invalid' });

    let closes = 0;
    const inspection = resolvePersistenceCompat({
      async list() { return [{ header: HEADER, revision: 'rev-valid' }]; },
      async open() {
        return {
          header,
          inheritedEventCount: 0,
          async read() { return []; },
          async close() { closes += 1; },
        };
      },
    });
    await assert.rejects(inspection.inspect(HEADER.id), { code: 'persistence-response-invalid' });
    assert.equal(closes, 1);
  }
});

test('accepts valid current Host optional fields and preserves unknown header extensions', async () => {
  const header = Object.freeze({
    ...HEADER,
    parentSession: 'parent-session',
    isSeeded: true,
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'coder',
    extension: { retained: true },
  });
  const snapshot = Object.freeze({ header, revision: 'opaque-revision' });
  const view = resolvePersistenceCompat({
    async list() { return [snapshot]; },
    async open() { throw new Error('not used'); },
  });

  assert.equal((await view.list())[0], header);
  assert.equal((await view.listSnapshots())[0], snapshot);
});

test('refuses inherited sessions before reading away lineage evidence and closes the handle', async () => {
  let reads = 0;
  let closes = 0;
  const raw = {
    async list() { return [{ header: { ...HEADER, isSeeded: true }, revision: 'rev-fork' }]; },
    async open() {
      return {
        header: { ...HEADER, isSeeded: true },
        inheritedEventCount: 2,
        async read() { reads += 1; return []; },
        async close() { closes += 1; },
      };
    },
  };

  await assert.rejects(resolvePersistenceCompat(raw).inspect(HEADER.id), {
    code: 'session-inspection-unsupported',
    status: 501,
  });
  assert.equal(reads, 0);
  assert.equal(closes, 1);
});
