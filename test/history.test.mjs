import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryService, HistoryError } from '../lib/history.js';

const version = (patch = {}) => ({
  snapshotId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session-a',
  createdAt: '2026-08-25T00:00:00.000Z',
  sourceRevision: 'rev-a',
  totalBytes: 120,
  sessionBytes: 100,
  attachmentCount: 1,
  archive: {
    title: 'Alpha',
    createdAt: 1000,
    origin: null,
    workspace: { id: 'workspace-a', title: 'Workspace A' },
    tags: ['important'],
    note: 'private note',
    metadataUpdatedAt: '2026-08-24T00:00:00.000Z',
  },
  ...patch,
});

function fixture(overrides = {}) {
  const calls = { capture: 0, inspect: 0, inventory: 0, page: null, image: null };
  const existing = overrides.existing ?? null;
  const details = new Map((overrides.versions ?? [version()]).map((item) => [item.snapshotId, item]));
  const trashRecords = overrides.trashRecords ?? new Map();
  const deps = {
    registry: {
      archivedSessionIds: overrides.archivedIds ?? ['session-a'],
      list: () => [{ id: 'workspace-a', title: 'Workspace A', path: '/private/workspace-a', sessionIds: ['session-a'] }],
    },
    persistence: {
      list: async () => [{ id: 'session-a', title: 'Header Alpha', createdAt: 1000, origin: null }],
      inspect: async () => {
        calls.inspect += 1;
        return { meta: { id: 'session-a' }, events: [{ type: 'session/title', data: { title: 'Alpha' } }] };
      },
      listSnapshots: async () => [{ header: { id: 'session-a' }, revision: overrides.revision ?? 'rev-a' }],
    },
    sessions: { get: () => overrides.live === true ? { id: 'session-a' } : undefined },
    metadataStore: {
      getMany: async () => ({
        status: 'ready',
        entries: { 'session-a': { tags: ['important'], note: 'private note', updatedAt: '2026-08-24T00:00:00.000Z' } },
      }),
    },
    trashStore: {
      get: async (id) => trashRecords.get(id) ?? null,
      load: async () => ({ status: 'ready', records: new Map(trashRecords) }),
    },
    snapshotStore: {
      findRevision: async () => existing,
      capture: async () => {
        calls.capture += 1;
        return {
          snapshotId: '00000000-0000-4000-8000-000000000099',
          sessionId: 'session-a',
          createdAt: '2026-08-25T01:00:00.000Z',
          bytes: 130,
          attachmentCount: 2,
          sourceRevision: overrides.revision ?? 'rev-a',
        };
      },
      inventory: async () => {
        calls.inventory += 1;
        return {
          valid: [...details.values()].map((item) => ({
            snapshotId: item.snapshotId,
            sessionId: item.sessionId,
            createdAt: item.createdAt,
            totalBytes: item.totalBytes,
            sessionBytes: item.sessionBytes,
            attachmentCount: item.attachmentCount,
            attachments: [],
          })),
          degraded: overrides.degraded ?? [],
        };
      },
      inspectHistory: async (snapshotId) => structuredClone(details.get(snapshotId)),
      readHistoryPage: async (snapshotId, window) => {
        calls.page = { snapshotId, window };
        return {
          snapshotId,
          sessionId: details.get(snapshotId)?.sessionId ?? 'session-a',
          createdAt: details.get(snapshotId)?.createdAt ?? '2026-08-25T00:00:00.000Z',
          messages: [{ seq: 1, role: 'user', segments: [{ kind: 'text', text: 'hello' }] }],
          total: 1,
          nextOffset: null,
        };
      },
      readHistoryImage: async (snapshotId, reference, signal) => {
        calls.image = { snapshotId, reference, signal };
        return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 2, height: 2 };
      },
    },
    lifecycle: { run: (operation) => operation() },
    now: () => new Date('2026-08-25T02:00:00.000Z'),
    ttlMs: 30_000,
  };
  return { service: createHistoryService({ ...deps, ...overrides.deps }), calls, deps };
}

test('capture rechecks archive ownership and reuses a healthy exact revision', async () => {
  const existing = version();
  const { service, calls } = fixture({ existing, live: true });

  const result = await service.captureArchived('session-a');

  assert.deepEqual(result, {
    reused: true,
    snapshot: {
      snapshotId: existing.snapshotId,
      sessionId: 'session-a',
      createdAt: existing.createdAt,
      bytes: 120,
      attachmentCount: 1,
      sourceRevision: 'rev-a',
    },
  });
  assert.equal(calls.capture, 0);
});

test('capture publishes a new version and never returns workspace paths or private metadata', async () => {
  const { service, calls } = fixture({ existing: null, live: true });

  const result = await service.captureArchived('session-a');

  assert.equal(result.reused, false);
  assert.equal(result.snapshot.snapshotId, '00000000-0000-4000-8000-000000000099');
  assert.equal(calls.capture, 1);
  assert.equal(JSON.stringify(result).includes('/private/'), false);
  assert.equal(JSON.stringify(result).includes('private note'), false);
});

test('capture refuses non-archived and recycled sources before persistence inspection', async () => {
  const notArchived = fixture({ archivedIds: [] });
  await assert.rejects(
    notArchived.service.captureArchived('session-a'),
    (error) => error instanceof HistoryError && error.code === 'history-source-not-archived' && error.status === 404,
  );
  assert.equal(notArchived.calls.inspect, 0);

  const recycled = fixture({ trashRecords: new Map([['session-a', { sessionId: 'session-a' }]]) });
  await assert.rejects(
    recycled.service.captureArchived('session-a'),
    (error) => error instanceof HistoryError && error.code === 'history-source-recycled' && error.status === 409,
  );
  assert.equal(recycled.calls.inspect, 0);
});

test('history inventory groups newest first, marks current protection, and caches cloned safe results', async () => {
  const older = version({
    snapshotId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-24T00:00:00.000Z',
    sourceRevision: 'rev-old',
  });
  const newer = version({
    snapshotId: '00000000-0000-4000-8000-000000000002',
    createdAt: '2026-08-25T00:00:00.000Z',
    sourceRevision: 'rev-new',
  });
  const trashRecords = new Map([['session-a', { sessionId: 'session-a', snapshotId: newer.snapshotId }]]);
  const { service, calls } = fixture({
    versions: [older, newer],
    trashRecords,
    degraded: [{ snapshotId: '00000000-0000-4000-8000-000000000003', code: 'snapshot-hash-mismatch', title: 'untrusted' }],
  });

  const [first, second] = await Promise.all([service.list(), service.list()]);
  assert.equal(calls.inventory, 1);
  assert.deepEqual(first.sessions[0].versions.map((item) => item.snapshotId), [newer.snapshotId, older.snapshotId]);
  assert.equal(first.sessions[0].scope, 'recycled');
  assert.equal(first.sessions[0].versions[0].state, 'recycle-protection');
  assert.equal(first.sessions[0].versions[1].state, 'history');
  assert.deepEqual(first.degraded, [{ snapshotId: '00000000-0000-4000-8000-000000000003', code: 'snapshot-hash-mismatch' }]);
  assert.equal(JSON.stringify(first).includes('/private/'), false);
  assert.equal(JSON.stringify(first).includes('private note'), false);
  first.sessions[0].versions.length = 0;
  assert.equal(second.sessions[0].versions.length, 2);
  assert.equal((await service.list()).sessions[0].versions.length, 2);
});

test('history invalidation prevents an older in-flight result from repopulating the cache', async () => {
  let resolveInventory;
  let inventories = 0;
  const item = fixture({
    deps: {
      snapshotStore: {
        inventory: () => {
          inventories += 1;
          if (inventories === 1) return new Promise((resolve) => { resolveInventory = resolve; });
          return Promise.resolve({ valid: [], degraded: [] });
        },
        inspectHistory: async () => { throw new Error('not expected'); },
        findRevision: async () => null,
        capture: async () => { throw new Error('not expected'); },
      },
    },
  });
  const stale = item.service.list();
  item.service.invalidate();
  resolveInventory({ valid: [], degraded: [] });
  await stale;
  await item.service.list();
  assert.equal(inventories, 2);
});

test('history preview accepts only a published healthy snapshot identity', async () => {
  const healthy = version();
  const item = fixture({
    versions: [healthy],
    degraded: [{ snapshotId: '00000000-0000-4000-8000-000000000099', code: 'snapshot-hash-mismatch' }],
  });

  const page = await item.service.preview(healthy.snapshotId, { offset: 0, limit: 50 });
  assert.equal(page.snapshot.snapshotId, healthy.snapshotId);
  assert.equal(page.snapshot.createdAt, healthy.createdAt);
  assert.equal(page.messages[0].segments[0].text, 'hello');
  assert.deepEqual(item.calls.page, { snapshotId: healthy.snapshotId, window: { offset: 0, limit: 50 } });

  await assert.rejects(
    item.service.preview('00000000-0000-4000-8000-000000000099', { offset: 0, limit: 50 }),
    (error) => error.code === 'history-snapshot-degraded' && error.status === 409,
  );
  await assert.rejects(
    item.service.preview('00000000-0000-4000-8000-000000000098', { offset: 0, limit: 50 }),
    (error) => error.code === 'history-snapshot-missing' && error.status === 404,
  );
});

test('history image reads stay authorized to one healthy snapshot and forward cancellation', async () => {
  const healthy = version();
  const item = fixture({ versions: [healthy] });
  const controller = new AbortController();
  const reference = { attachmentId: 'image-a', mediaType: 'image/png', bytes: 3, width: 2, height: 2 };

  const image = await item.service.readImage(healthy.snapshotId, reference, controller.signal);

  assert.deepEqual(image.data, new Uint8Array([1, 2, 3]));
  assert.equal(item.calls.image.snapshotId, healthy.snapshotId);
  assert.deepEqual(item.calls.image.reference, reference);
  assert.equal(item.calls.image.signal, controller.signal);
});
