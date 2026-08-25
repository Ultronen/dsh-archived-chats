import test from 'node:test';
import assert from 'node:assert/strict';
import { createInsightsService, InsightsError } from '../lib/insights.js';

const sessionRows = [
  { id: 'a', title: 'Alpha', workspaceId: 'w', workspaceTitle: 'Work', scope: 'archive' },
  { id: 'b', title: 'Beta', workspaceId: 'w', workspaceTitle: 'Work', scope: 'trash' },
];

const validSnapshots = [
  {
    snapshotId: 's1', sessionId: 'a', createdAt: '2026-08-20T00:00:00.000Z',
    totalBytes: 80, sessionBytes: 30, attachmentCount: 1,
    attachments: [{ sha256: 'x', bytes: 50 }],
  },
  {
    snapshotId: 's2', sessionId: 'b', createdAt: '2026-08-21T00:00:00.000Z',
    totalBytes: 90, sessionBytes: 40, attachmentCount: 1,
    attachments: [{ sha256: 'x', bytes: 50 }],
  },
];

function fixture(overrides = {}) {
  let nowMs = Date.parse('2026-08-24T00:00:00.000Z');
  let listCalls = 0;
  let measureCalls = 0;
  let inventoryCalls = 0;
  const service = createInsightsService({
    listSessions: async () => {
      listCalls += 1;
      return structuredClone(overrides.sessions ?? sessionRows);
    },
    statsService: {
      measure: async () => {
        measureCalls += 1;
        if (overrides.pauseMeasure) await overrides.pauseMeasure;
        return structuredClone(overrides.measurement ?? {
          summary: { sessionCount: 2, totalBytes: 300, unavailableCount: 0 },
          sessions: {
            a: { status: 'ready', sizeBytes: 100, fileCount: 1 },
            b: { status: 'ready', sizeBytes: 200, fileCount: 2 },
          },
        });
      },
    },
    trashStore: {
      load: async () => overrides.trash ?? {
        status: 'ready', records: new Map([['b', { snapshotId: 's2' }]]),
      },
    },
    snapshotStore: {
      inventory: async () => {
        inventoryCalls += 1;
        return structuredClone(Object.hasOwn(overrides, 'inventory')
          ? overrides.inventory
          : { valid: validSnapshots, degraded: [] });
      },
    },
    now: () => new Date(nowMs),
    ttlMs: 30_000,
  });
  return {
    service,
    advance(ms) { nowMs += ms; },
    calls: () => ({ listCalls, measureCalls, inventoryCalls }),
  };
}

test('insights separates session and snapshot bytes and counts repeated snapshot content', async () => {
  const { service } = fixture();
  const result = await service.inspect();

  assert.deepEqual(result.summary, {
    sessionBytes: 300,
    snapshotBytes: 170,
    totalMeasuredBytes: 470,
    duplicateSnapshotBytes: 50,
    sessionUnavailableCount: 0,
    degradedSnapshotCount: 0,
  });
  assert.equal(result.generatedAt, '2026-08-24T00:00:00.000Z');
  assert.equal(result.snapshots.find((row) => row.snapshotId === 's2').active, true);
  assert.deepEqual(result.sessions.find((row) => row.id === 'b'), {
    id: 'b', title: 'Beta', workspaceId: 'w', workspaceTitle: 'Work', scope: 'trash',
    status: 'ready', sizeBytes: 200, fileCount: 2,
  });
  assert.equal(JSON.stringify(result).includes('path'), false);
  assert.equal(JSON.stringify(result).includes('attachments'), false);
});

test('insights excludes unavailable and degraded bytes from trusted totals', async () => {
  const { service } = fixture({
    measurement: {
      summary: { sessionCount: 2, totalBytes: 100, unavailableCount: 1 },
      sessions: {
        a: { status: 'ready', sizeBytes: 100, fileCount: 1 },
        b: { status: 'unavailable', sizeBytes: null, fileCount: null },
      },
    },
    inventory: {
      valid: [validSnapshots[0]],
      degraded: [{ snapshotId: 'broken', code: 'snapshot-hash-mismatch' }],
    },
  });
  const result = await service.inspect();
  assert.equal(result.summary.sessionBytes, 100);
  assert.equal(result.summary.snapshotBytes, 80);
  assert.equal(result.summary.totalMeasuredBytes, 180);
  assert.equal(result.summary.sessionUnavailableCount, 1);
  assert.equal(result.summary.degradedSnapshotCount, 1);
  assert.deepEqual(result.snapshots.at(-1), {
    snapshotId: 'broken', status: 'degraded', code: 'snapshot-hash-mismatch', active: false,
  });
});

test('insights shares in-flight work, returns isolated cached clones, and invalidates explicitly', async () => {
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const current = fixture({ pauseMeasure: paused });
  const first = current.service.inspect();
  const second = current.service.inspect();
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(current.calls(), { listCalls: 1, measureCalls: 1, inventoryCalls: 1 });
  left.sessions[0].title = 'mutated';
  assert.equal(right.sessions[0].title, 'Alpha');

  await current.service.inspect();
  assert.deepEqual(current.calls(), { listCalls: 1, measureCalls: 1, inventoryCalls: 1 });
  current.service.invalidate();
  await current.service.inspect();
  assert.deepEqual(current.calls(), { listCalls: 2, measureCalls: 2, inventoryCalls: 2 });
});

test('insights refreshes after the thirty-second cache expires', async () => {
  const current = fixture();
  await current.service.inspect();
  current.advance(30_001);
  await current.service.inspect();
  assert.deepEqual(current.calls(), { listCalls: 2, measureCalls: 2, inventoryCalls: 2 });
});

test('insights fails closed when trash or snapshot authority is unavailable', async () => {
  const trashUnavailable = fixture({ trash: { status: 'unavailable', records: new Map() } });
  await assert.rejects(
    trashUnavailable.service.inspect(),
    (error) => error instanceof InsightsError && error.code === 'insights-authority-unavailable' && error.status === 503,
  );

  const snapshotsUnavailable = fixture({ inventory: null });
  await assert.rejects(
    snapshotsUnavailable.service.inspect(),
    (error) => error instanceof InsightsError && error.code === 'insights-authority-unavailable',
  );
});
