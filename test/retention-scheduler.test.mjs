import test from 'node:test';
import assert from 'node:assert/strict';
import { startRetentionScheduler } from '../lib/auto-retention.js';
const flush = () => new Promise((r) => setImmediate(r));

test('scheduler waits for recovery, catches up immediately, and cancels after disposal', async () => {
  let finishRecovery; let finishRun; let runs = 0; let stopCheck;
  const timers = new Map(); let unrefs = 0;
  const stop = startRetentionScheduler({
    recover: () => new Promise((r) => { finishRecovery = r; }),
    run: ({ isStopped }) => { runs++; stopCheck = isStopped; return new Promise((r) => { finishRun = r; }); },
    setTimer: (fn, ms) => { assert.equal(ms, 60000); const handle = { unref() { unrefs++; } }; timers.set(handle, fn); return handle; },
    clearTimer: (id) => timers.delete(id),
  });
  assert.equal(runs, 0); finishRecovery(); await flush();
  assert.equal(runs, 1); assert.equal(timers.size, 0, 'no next tick while a run is active');
  finishRun({ failed: [] }); await flush();
  assert.equal(timers.size, 1); assert.equal(unrefs, 1);
  const next = [...timers.values()][0]; stop();
  assert.equal(timers.size, 0); assert.equal(stopCheck(), true);
  await next(); assert.equal(runs, 1);
});

test('disposal during recovery prevents cleanup and recovery failure retries before cleanup', async () => {
  let resolve; let runs = 0;
  const stop = startRetentionScheduler({ recover: () => new Promise((r) => { resolve = r; }), run: async () => { runs++; }, setTimer: () => assert.fail('timer after disposal') });
  stop(); resolve(); await flush(); assert.equal(runs, 0);
  let recoveries = 0; let tick; const reports = [];
  const stopRetry = startRetentionScheduler({
    recover: async () => { if (++recoveries === 1) throw Object.assign(new Error('bad'), { code: 'recovery-failed' }); },
    run: async () => { runs++; return { failed: [{ id: 'a' }] }; }, report: (...values) => reports.push(values),
    setTimer: (fn) => { tick = fn; return 1; }, clearTimer() {},
  });
  await flush(); assert.equal(runs, 0); await tick();
  assert.equal(recoveries, 2); assert.equal(runs, 1);
  assert.deepEqual(reports, [['recovery-failed'], ['retention-cleanup-incomplete', 1]]); stopRetry();
});
