import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetentionService, RetentionServiceError } from '../lib/retention-service.js';

const MiB = 1024 * 1024;
const policy = {
  historicalSnapshotsPerSession: 1,
  historicalSnapshotMaxAgeDays: null,
  snapshotQuotaBytes: null,
  recycleMaxAgeDays: 7,
};

const insightSnapshots = [
  { snapshotId: 's2', sessionId: 'a', createdAt: '2026-08-23T00:00:00.000Z', totalBytes: MiB, sessionBytes: 10, attachmentCount: 0, status: 'ready', active: false },
  { snapshotId: 's1', sessionId: 'a', createdAt: '2026-08-20T00:00:00.000Z', totalBytes: MiB, sessionBytes: 10, attachmentCount: 0, status: 'ready', active: false },
];

const rawSnapshots = insightSnapshots.map((item) => ({
  snapshotId: item.snapshotId,
  sessionId: item.sessionId,
  createdAt: item.createdAt,
  totalBytes: item.totalBytes,
  sessionBytes: item.sessionBytes,
  attachmentCount: item.attachmentCount,
  attachments: [],
}));

function oldTrash(snapshotId = 'trash-snapshot') {
  return {
    sessionId: 't1', state: 'trashed', trashedAt: '2026-08-01T00:00:00.000Z',
    purgeRequestedAt: null, snapshotId, snapshotBytes: MiB,
  };
}

function fixture(options = {}) {
  let nowMs = Date.parse('2026-08-24T00:00:00.000Z');
  let randomCall = 0;
  let currentPolicy = structuredClone(policy);
  const records = new Map([['t1', oldTrash()]]);
  const removed = [];
  const purged = [];
  const lifecycleCalls = [];
  let invalidations = 0;
  const service = createRetentionService({
    insightsService: {
      inspect: async () => ({
        generatedAt: new Date(nowMs).toISOString(),
        summary: {
          sessionBytes: 0, snapshotBytes: 2 * MiB, totalMeasuredBytes: 2 * MiB,
          duplicateSnapshotBytes: 0, sessionUnavailableCount: 0, degradedSnapshotCount: 0,
        },
        sessions: [],
        snapshots: structuredClone(insightSnapshots),
      }),
      invalidate: () => { invalidations += 1; },
    },
    retentionStore: {
      load: async () => ({ status: 'ready', policy: structuredClone(currentPolicy) }),
      save: async (next) => { currentPolicy = structuredClone(next); return structuredClone(next); },
    },
    trashStore: {
      load: async () => ({ status: 'ready', records: new Map([...records].map(([id, record]) => [id, structuredClone(record)])) }),
    },
    snapshotStore: {
      inventory: async () => ({ valid: structuredClone(rawSnapshots), degraded: [] }),
      remove: async (snapshotId) => {
        if (options.removeError) throw options.removeError;
        removed.push(snapshotId);
      },
    },
    recycleService: {
      purge: async (ids) => {
        if (options.purgeError) return { purged: [], failed: [{ id: ids[0], reason: options.purgeError }] };
        purged.push(...ids);
        records.delete(ids[0]);
        return { purged: [...ids], failed: [] };
      },
    },
    lifecycle: {
      async run(operation) { lifecycleCalls.push('run'); return operation(); },
    },
    now: () => new Date(nowMs),
    randomBytes: (size) => Buffer.alloc(size, ++randomCall),
  });
  return {
    service, records, removed, purged, lifecycleCalls,
    advance(ms) { nowMs += ms; },
    invalidations: () => invalidations,
    policy: () => structuredClone(currentPolicy),
  };
}

test('retention preview issues a bounded token and nonce without private data', async () => {
  const current = fixture();
  const preview = await current.service.preview();
  assert.deepEqual(preview.candidates.map((item) => item.key), ['snapshot:s1', 'trash:t1']);
  assert.equal(typeof preview.token, 'string');
  assert.equal(typeof preview.nonce, 'string');
  assert.equal(preview.expiresAt, '2026-08-24T00:05:00.000Z');
  assert.equal(JSON.stringify(preview).includes('path'), false);
  assert.equal(JSON.stringify(preview).includes('content'), false);

  await assert.rejects(
    current.service.apply({ token: preview.token, nonce: 'wrong', keys: [] }),
    (error) => error instanceof RetentionServiceError && error.code === 'retention-token-invalid' && error.status === 400,
  );
});

test('retention preview expires after five minutes and is single-use', async () => {
  const expired = fixture();
  const oldPreview = await expired.service.preview();
  expired.advance(300_001);
  await assert.rejects(
    expired.service.apply({ token: oldPreview.token, nonce: oldPreview.nonce, keys: [] }),
    (error) => error.code === 'retention-token-expired' && error.status === 409,
  );

  const single = fixture();
  const preview = await single.service.preview();
  await single.service.apply({ token: preview.token, nonce: preview.nonce, keys: [] });
  await assert.rejects(
    single.service.apply({ token: preview.token, nonce: preview.nonce, keys: [] }),
    (error) => error.code === 'retention-token-invalid',
  );
});

test('retention apply revalidates and processes an ordered candidate subset', async () => {
  const current = fixture();
  const preview = await current.service.preview();
  const result = await current.service.apply({
    token: preview.token,
    nonce: preview.nonce,
    keys: ['snapshot:s1', 'trash:t1'],
  });
  assert.deepEqual(result.applied, [
    { key: 'snapshot:s1', action: 'delete-snapshot' },
    { key: 'trash:t1', action: 'purge-trash' },
  ]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(current.removed, ['s1']);
  assert.deepEqual(current.purged, ['t1']);
  assert.equal(current.lifecycleCalls.length, 2);
  assert.equal(current.invalidations(), 2);
});

test('retention apply refuses a snapshot that became active after preview', async () => {
  const current = fixture();
  const preview = await current.service.preview();
  current.records.set('new-owner', { ...oldTrash('s1'), sessionId: 'new-owner' });
  const result = await current.service.apply({
    token: preview.token,
    nonce: preview.nonce,
    keys: ['snapshot:s1'],
  });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.failed, [{ key: 'snapshot:s1', reason: 'retention-candidate-stale' }]);
  assert.deepEqual(current.removed, []);
});

test('retention apply reports partial failures and continues independent candidates', async () => {
  const current = fixture({ removeError: Object.assign(new Error('private'), { code: 'snapshot-remove-failed' }) });
  const preview = await current.service.preview();
  const result = await current.service.apply({
    token: preview.token,
    nonce: preview.nonce,
    keys: ['snapshot:s1', 'trash:t1'],
  });
  assert.deepEqual(result.applied, [{ key: 'trash:t1', action: 'purge-trash' }]);
  assert.deepEqual(result.failed, [{ key: 'snapshot:s1', reason: 'snapshot-remove-failed' }]);
  assert.deepEqual(current.purged, ['t1']);
});

test('saving retention policy never previews or applies cleanup', async () => {
  const current = fixture();
  const next = { ...policy, recycleMaxAgeDays: null };
  const result = await current.service.savePolicy(next);
  assert.deepEqual(result, next);
  assert.deepEqual(current.policy(), next);
  assert.deepEqual(current.removed, []);
  assert.deepEqual(current.purged, []);
  assert.equal(current.invalidations(), 1);
});
