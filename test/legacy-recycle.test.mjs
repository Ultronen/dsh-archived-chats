import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createLegacyRecycleService,
  createLegacyRecycleStore,
  createRecycleHub,
  createUnifiedTrashStore,
} from '../lib/legacy-recycle.js';

function queue() {
  let tail = Promise.resolve();
  return { run(operation) { const result = tail.then(operation); tail = result.catch(() => undefined); return result; } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dac-legacy-recycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = Date.parse('2026-09-17T00:00:00.000Z');
  const removed = [];
  let removeFailure = null;
  let inventory = {
    generatedAt: new Date(nowMs).toISOString(),
    sessions: [{
      sessionId: 'source-a', title: 'Alpha old copy', workspace: { id: 'ws-a', title: 'Project A', path: '/a' }, scope: 'history-only',
      versions: [
        { snapshotId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-08-01T00:00:00.000Z', totalBytes: 100, attachmentCount: 1, state: 'history' },
        { snapshotId: '00000000-0000-4000-8000-000000000002', createdAt: '2026-08-02T00:00:00.000Z', totalBytes: 200, attachmentCount: 0, state: 'recycle-protection' },
      ],
    }],
    degraded: [{ snapshotId: '00000000-0000-4000-8000-000000000003', code: 'snapshot-invalid' }],
  };
  const store = createLegacyRecycleStore({ path: join(root, 'legacy-recycle.json'), now: () => new Date(nowMs) });
  const lifecycle = queue();
  let destination = 0;
  const service = createLegacyRecycleService({
    store,
    historyService: { list: async () => structuredClone(inventory), invalidate() {} },
    historyRestoreService: {
      prepare: async (snapshotId) => ({ token: `token:${snapshotId}`, nonce: 'nonce' }),
      restore: async (token, nonce, options = {}) => lifecycle.run(async () => {
        await options.beforeRestore?.();
        const result = { restored: [`copy-${++destination}`], snapshotId: token.slice(6), warnings: [] };
        await options.afterCommit?.(result);
        return result;
      }),
    },
    snapshotStore: {
      remove: async (snapshotId) => {
        if (removeFailure) throw Object.assign(new Error(removeFailure), { code: removeFailure });
        removed.push(snapshotId);
        inventory = {
          ...inventory,
          sessions: inventory.sessions.map((session) => ({ ...session, versions: session.versions.filter((item) => item.snapshotId !== snapshotId) })),
          degraded: inventory.degraded.filter((item) => item.snapshotId !== snapshotId),
        };
      },
    },
    trashStore: { load: async () => ({ status: 'ready', records: new Map() }) },
    lifecycle,
  });
  return {
    root, store, service, removed,
    advance(ms) { nowMs += ms; },
    failRemove(code) { removeFailure = code; },
    clearRemoveFailure() { removeFailure = null; },
  };
}

test('projects every unprotected legacy snapshot into recycle with a stable migration time', async (t) => {
  const f = await fixture(t);
  const first = await f.service.list();
  assert.deepEqual(first.map((row) => ({ id: row.sessionId, state: row.state, restorable: row.restorable, title: row.title })), [
    { id: 'legacy:00000000-0000-4000-8000-000000000001', state: 'trashed', restorable: true, title: 'Alpha old copy' },
    { id: 'legacy:00000000-0000-4000-8000-000000000003', state: 'degraded', restorable: false, title: null },
  ]);
  assert.equal(first[0].trashedAt, '2026-09-17T00:00:00.000Z');
  assert.equal(first.every((row) => Object.hasOwn(row, 'purgeRequestedAt') && row.purgeRequestedAt === null), true,
    'legacy recycle rows satisfy the public purge timestamp contract');
  assert.equal(first.some((row) => row.snapshotId.endsWith('0002')), false, 'active protection is represented by its regular trash record');
  f.advance(86400000);
  assert.equal((await f.service.list())[0].trashedAt, '2026-09-17T00:00:00.000Z');
});

test('successful legacy restore creates an archived copy and retires only that snapshot', async (t) => {
  const f = await fixture(t);
  const id = (await f.service.list())[0].sessionId;
  const result = await f.service.restore([id]);
  assert.deepEqual(result, { restored: [id], created: ['copy-1'], failed: [], warnings: [] });
  assert.deepEqual(f.removed, ['00000000-0000-4000-8000-000000000001']);
  assert.equal((await f.service.list()).some((row) => row.sessionId === id), false);
});

test('committed restore remains hidden when snapshot cleanup fails and startup retries it', async (t) => {
  const f = await fixture(t);
  const id = (await f.service.list())[0].sessionId;
  f.failRemove('disk-busy');
  const result = await f.service.restore([id]);
  assert.deepEqual(result.restored, [id]);
  assert.deepEqual(result.warnings, [{ id, reason: 'legacy-cleanup-pending' }]);
  assert.equal((await f.service.list()).some((row) => row.sessionId === id), false, 'a committed copy cannot be restored twice');
  f.clearRemoveFailure();
  await f.service.recoverStartup();
  assert.deepEqual(f.removed, ['00000000-0000-4000-8000-000000000001']);
});

test('legacy purge records durable intent and startup retries a failed byte removal', async (t) => {
  const f = await fixture(t);
  const id = (await f.service.list())[0].sessionId;
  f.failRemove('disk-busy');
  const failed = await f.service.purge([id]);
  assert.deepEqual(failed, { purged: [], failed: [{ id, reason: 'disk-busy' }] });
  assert.equal((await f.service.list()).find((row) => row.sessionId === id).state, 'purge-pending');
  f.clearRemoveFailure();
  await f.service.recoverStartup();
  assert.equal((await f.service.list()).some((row) => row.sessionId === id), false);
});

test('legacy store fails closed without rewriting malformed bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dac-legacy-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'legacy-recycle.json');
  await writeFile(path, '{broken');
  const store = createLegacyRecycleStore({ path });
  assert.equal((await store.load()).status, 'unavailable');
  await assert.rejects(store.sync(['00000000-0000-4000-8000-000000000001']), { code: 'legacy-recycle-store-unavailable' });
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('recycle hub merges rows, operations, summaries and retention authority', async () => {
  const regularRecord = { sessionId: 'regular', state: 'trashed', trashedAt: '2026-09-17T00:00:00.000Z', snapshotId: 's', snapshotBytes: 2 };
  const legacyId = 'legacy:00000000-0000-4000-8000-000000000004';
  const legacyRecord = { sessionId: legacyId, state: 'trashed', trashedAt: '2026-09-17T00:00:00.000Z', snapshotId: '00000000-0000-4000-8000-000000000004', snapshotBytes: 3 };
  const calls = [];
  const regular = {
    list: async () => [regularRecord], summary: async () => ({ count: 1, snapshotBytes: 2, degradedCount: 0, purgePendingCount: 0 }),
    move: async () => ({ trashed: [] }), restore: async (ids) => { calls.push(['regular-restore', ids]); return { restored: ids, failed: [] }; },
    purge: async (ids) => { calls.push(['regular-purge', ids]); return { purged: ids, failed: [] }; },
    empty: async () => ({ purged: ['regular'], failed: [] }), recoverStartup: async () => { calls.push(['regular-recover']); },
  };
  const legacy = {
    list: async () => [legacyRecord], summary: async () => ({ count: 1, snapshotBytes: 3, degradedCount: 0, purgePendingCount: 0 }),
    retentionRecords: async () => new Map([[legacyId, legacyRecord]]),
    restore: async (ids) => { calls.push(['legacy-restore', ids]); return { restored: ids, created: ['copy'], failed: [], warnings: [] }; },
    purge: async (ids) => { calls.push(['legacy-purge', ids]); return { purged: ids, failed: [] }; },
    empty: async () => ({ purged: [legacyId], failed: [] }), recoverStartup: async () => { calls.push(['legacy-recover']); },
  };
  const hub = createRecycleHub({ recycleService: regular, legacyRecycleService: legacy });
  assert.deepEqual((await hub.list()).map((row) => row.sessionId), ['regular', legacyId]);
  assert.deepEqual(await hub.summary(), { count: 2, snapshotBytes: 5, degradedCount: 0, purgePendingCount: 0 });
  assert.deepEqual(await hub.restore(['regular', legacyId]), { restored: ['regular', legacyId], created: ['copy'], failed: [], warnings: [] });
  assert.deepEqual(await hub.purge(['regular', legacyId]), { purged: ['regular', legacyId], failed: [] });
  assert.deepEqual(await hub.empty(), { purged: ['regular', legacyId], failed: [] });
  await hub.recoverStartup();
  assert.deepEqual(calls, [
    ['regular-restore', ['regular']], ['legacy-restore', [legacyId]],
    ['regular-purge', ['regular']], ['legacy-purge', [legacyId]],
    ['regular-recover'], ['legacy-recover'],
  ]);

  const unified = createUnifiedTrashStore({
    trashStore: { load: async () => ({ status: 'ready', records: new Map([['regular', regularRecord]]) }) },
    legacyRecycleService: legacy,
  });
  assert.deepEqual([...(await unified.load()).records.keys()], ['regular', legacyId]);
});
