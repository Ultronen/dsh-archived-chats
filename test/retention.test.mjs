import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_RETENTION_POLICY,
  RetentionError,
  createRetentionStore,
  normalizeRetentionPolicy,
  planRetention,
} from '../lib/retention.js';

const roots = new Set();
test.after(async () => Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true }))));

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dac-retention-'));
  roots.add(root);
  const path = join(root, 'retention.json');
  return { root, path, store: createRetentionStore({ path }) };
}

test('missing retention file loads conservative defaults', async () => {
  const { store } = await storeFixture();
  assert.deepEqual(await store.load(), { status: 'ready', policy: DEFAULT_RETENTION_POLICY });
  assert.deepEqual(DEFAULT_RETENTION_POLICY, {
    historicalSnapshotsPerSession: 1,
    historicalSnapshotMaxAgeDays: null,
    snapshotQuotaBytes: null,
    recycleMaxAgeDays: null,
  });
});

test('retention policy validation accepts exact boundaries and rejects broadened schemas', () => {
  assert.deepEqual(normalizeRetentionPolicy({
    historicalSnapshotsPerSession: 0,
    historicalSnapshotMaxAgeDays: 1,
    snapshotQuotaBytes: 1024 * 1024,
    recycleMaxAgeDays: 3650,
  }), {
    historicalSnapshotsPerSession: 0,
    historicalSnapshotMaxAgeDays: 1,
    snapshotQuotaBytes: 1024 * 1024,
    recycleMaxAgeDays: 3650,
  });
  assert.equal(normalizeRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, historicalSnapshotsPerSession: 20 }).historicalSnapshotsPerSession, 20);
  assert.equal(normalizeRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, snapshotQuotaBytes: 8 * 1024 ** 4 }).snapshotQuotaBytes, 8 * 1024 ** 4);

  const invalid = [
    { ...DEFAULT_RETENTION_POLICY, historicalSnapshotsPerSession: -1 },
    { ...DEFAULT_RETENTION_POLICY, historicalSnapshotsPerSession: 21 },
    { ...DEFAULT_RETENTION_POLICY, historicalSnapshotsPerSession: 1.5 },
    { ...DEFAULT_RETENTION_POLICY, historicalSnapshotMaxAgeDays: 0 },
    { ...DEFAULT_RETENTION_POLICY, historicalSnapshotMaxAgeDays: 3651 },
    { ...DEFAULT_RETENTION_POLICY, snapshotQuotaBytes: 1024 * 1024 - 1 },
    { ...DEFAULT_RETENTION_POLICY, snapshotQuotaBytes: 8 * 1024 ** 4 + 1 },
    { ...DEFAULT_RETENTION_POLICY, recycleMaxAgeDays: 0 },
    { ...DEFAULT_RETENTION_POLICY, recycleMaxAgeDays: 3651 },
    { ...DEFAULT_RETENTION_POLICY, extra: true },
    { ...DEFAULT_RETENTION_POLICY, __proto__: { unsafe: true } },
  ];
  for (const value of invalid) {
    assert.throws(
      () => normalizeRetentionPolicy(value),
      (error) => error instanceof RetentionError && error.code === 'retention-policy-invalid',
    );
  }
});

test('retention store writes atomically with private modes and serializes saves', async () => {
  const { root, path, store } = await storeFixture();
  const first = { ...DEFAULT_RETENTION_POLICY, historicalSnapshotsPerSession: 2 };
  const second = { ...DEFAULT_RETENTION_POLICY, recycleMaxAgeDays: 30 };
  await Promise.all([store.save(first), store.save(second)]);
  assert.deepEqual(await store.load(), { status: 'ready', policy: second });
  if (process.platform !== 'win32') {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(root), ['retention.json']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, policy: second });
});

test('retention store preserves malformed or unsupported source bytes', async () => {
  for (const source of ['{broken', JSON.stringify({ version: 2, policy: DEFAULT_RETENTION_POLICY })]) {
    const { path, store } = await storeFixture();
    await writeFile(path, source, 'utf8');
    assert.equal((await store.load()).status, 'unavailable');
    await assert.rejects(
      store.save(DEFAULT_RETENTION_POLICY),
      (error) => error instanceof RetentionError && error.code === 'retention-store-unavailable' && error.status === 503,
    );
    assert.equal(await readFile(path, 'utf8'), source);
  }
});

const snapshot = (snapshotId, sessionId, createdAt, totalBytes, active = false) => ({
  snapshotId, sessionId, createdAt, totalBytes, sessionBytes: 10,
  attachmentCount: 0, status: 'ready', active,
});

test('retention planner applies count, age, quota, and recycle age in stable order', () => {
  const MiB = 1024 * 1024;
  const inventory = {
    summary: { snapshotBytes: 7 * MiB },
    snapshots: [
      snapshot('s-active', 'a', '2026-08-24T00:00:00.000Z', 2 * MiB, true),
      snapshot('s-new', 'a', '2026-08-23T00:00:00.000Z', MiB),
      snapshot('s-old-count', 'a', '2026-08-22T00:00:00.000Z', MiB),
      snapshot('s-old-age', 'b', '2026-08-01T00:00:00.000Z', MiB),
      snapshot('s-old-quota', 'c', '2026-08-20T00:00:00.000Z', MiB),
      snapshot('s-new-quota', 'd', '2026-08-21T00:00:00.000Z', MiB),
      { snapshotId: 'broken', status: 'degraded', code: 'snapshot-invalid', active: false },
    ],
  };
  const trashRecords = new Map([
    ['old-chat', { sessionId: 'old-chat', state: 'trashed', trashedAt: '2026-08-01T00:00:00.000Z', snapshotBytes: 40 }],
    ['new-chat', { sessionId: 'new-chat', state: 'degraded', trashedAt: '2026-08-23T00:00:00.000Z', snapshotBytes: 50 }],
    ['pending-chat', { sessionId: 'pending-chat', state: 'purge-pending', trashedAt: '2026-08-01T00:00:00.000Z', snapshotBytes: 60 }],
  ]);
  const plan = planRetention({
    inventory,
    trashRecords,
    policy: {
      historicalSnapshotsPerSession: 1,
      historicalSnapshotMaxAgeDays: 10,
      snapshotQuotaBytes: 4 * MiB,
      recycleMaxAgeDays: 7,
    },
    now: new Date('2026-08-24T00:00:00.000Z'),
  });

  assert.deepEqual(plan.candidates.map(({ key, action, reason }) => ({ key, action, reason })), [
    { key: 'snapshot:s-old-count', action: 'delete-snapshot', reason: 'history-count' },
    { key: 'snapshot:s-old-age', action: 'delete-snapshot', reason: 'snapshot-age' },
    { key: 'snapshot:s-old-quota', action: 'delete-snapshot', reason: 'snapshot-quota' },
    { key: 'trash:old-chat', action: 'purge-trash', reason: 'recycle-age' },
  ]);
  assert.equal(plan.projectedSnapshotBytes, 4 * MiB);
  assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(plan.candidates.some((item) => item.key === 'snapshot:s-active'), false);
  assert.equal(plan.candidates.some((item) => item.key === 'snapshot:broken'), false);
  assert.equal(plan.candidates.some((item) => item.key === 'trash:pending-chat'), false);
  assert.deepEqual(plan.candidates.at(-1), {
    key: 'trash:old-chat', action: 'purge-trash', reason: 'recycle-age', sessionId: 'old-chat',
    state: 'trashed', trashedAt: '2026-08-01T00:00:00.000Z', snapshotId: null, bytes: 40,
  });
});

test('disabled age and quota rules produce no candidates beyond history count', () => {
  const inventory = {
    summary: { snapshotBytes: 200 },
    snapshots: [
      snapshot('new', 'a', '2026-08-24T00:00:00.000Z', 100),
      snapshot('old', 'a', '2026-01-01T00:00:00.000Z', 100),
    ],
  };
  const plan = planRetention({
    inventory,
    trashRecords: new Map(),
    policy: DEFAULT_RETENTION_POLICY,
    now: new Date('2026-08-24T00:00:00.000Z'),
  });
  assert.deepEqual(plan.candidates.map((item) => item.key), ['snapshot:old']);
  assert.equal(plan.projectedSnapshotBytes, 100);
});
