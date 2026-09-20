import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetentionStore, DEFAULT_RETENTION_POLICY } from '../lib/retention.js';
import { createRetentionService } from '../lib/retention-service.js';
import { createTrashStore } from '../lib/trash.js';
import { createRecycleService } from '../lib/recycle.js';

const DAY = 86400000;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dac-auto-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = Date.parse('2026-09-17T00:00:00.000Z');
  const now = () => new Date(nowMs);
  let tail = Promise.resolve();
  const lifecycle = { run(fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; } };
  const retentionStore = createRetentionStore({ path: join(root, 'policy.json') });
  const trashStore = createTrashStore({ path: join(root, 'trash.json'), now });
  const snapshotStore = { capture() {}, inventory: async () => ({ valid: [] }), remove() {}, removeForSession: async () => {}, latestFor: async () => null };
  let fail = false;
  const recycleService = createRecycleService({
    persistence: { list: async () => [], locate: async () => ({ path: join(root, 'unused', 'session.jsonl') }) },
    trashStore, snapshotStore, lifecycle, now,
    verifyPurgeScope: async (id) => ({ status: 'present', sessionDirectory: join(root, id) }),
    purgePhysical: async (id) => { if (fail) throw Object.assign(new Error('failed'), { code: 'disk-unavailable' }); await rm(join(root, id)); },
  });
  let markPurgeStarted;
  const purgeStarted = new Promise((resolve) => { markPurgeStarted = resolve; });
  const service = createRetentionService({
    insightsService: { inspect: async () => ({ summary: { snapshotBytes: 0 }, snapshots: [] }), invalidate() {} },
    retentionStore, trashStore, snapshotStore, recycleService: { ...recycleService, purge: (...args) => { markPurgeStarted(); return recycleService.purge(...args); } }, lifecycle, now,
  });
  async function add(id, age) {
    const record = { sessionId: id, state: 'trashed', trashedAt: new Date(nowMs - age).toISOString(), purgeRequestedAt: null,
      title: id, createdAt: 1, origin: null, workspace: null, wasArchived: true, tags: [], note: '', metadataUpdatedAt: null,
      snapshotId: '00000000-0000-4000-8000-000000000001', snapshotBytes: 0, snapshotAttachmentCount: 0, liveDisposition: 'cold' };
    await trashStore.put(record);
    await writeFile(join(root, id), 'original');
  }
  const enabled = { ...DEFAULT_RETENTION_POLICY, recycleMaxAgeDays: 7, recycleAutoDelete: true };
  async function enable(policy = enabled) {
    const confirmation = await service.previewPolicy(policy);
    return service.savePolicy(policy, confirmation);
  }
  return { service, retentionStore, trashStore, lifecycle, root, add, enabled, enable, purgeStarted,
    advance(ms) { nowMs += ms; }, fail(value) { fail = value; } };
}

test('automatic cleanup ignores legacy settings, purges only expired chats at the boundary', async (t) => {
  const f = await fixture(t);
  await f.add('old', 8 * DAY); await f.add('boundary', 7 * DAY); await f.add('recent', 7 * DAY - 1);
  await f.retentionStore.save({ ...DEFAULT_RETENTION_POLICY, recycleMaxAgeDays: 7 });
  await f.service.runAutomatic();
  assert.equal((await f.trashStore.load()).records.size, 3);
  const preview = await f.service.previewPolicy(f.enabled);
  assert.deepEqual(preview.candidates.map((r) => r.sessionId), ['old', 'boundary']);
  assert.equal(preview.confirmationRequired, true);
  await assert.rejects(f.service.savePolicy(f.enabled), { code: 'retention-confirmation-required' });
  await f.service.savePolicy(f.enabled, preview);
  assert.equal((await f.trashStore.load()).records.size, 3, 'save does not delete within the request');
  await f.service.runAutomatic();
  assert.deepEqual([...(await f.trashStore.load()).records.keys()], ['recent']);
  await assert.rejects(readFile(join(f.root, 'old')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.root, 'recent'), 'utf8'), 'original');
});

test('policy confirmation is single use, time limited and bound to policy and affected chats', async (t) => {
  const f = await fixture(t);
  await f.add('old', 9 * DAY);
  const preview = await f.service.previewPolicy(f.enabled);
  await assert.rejects(f.service.savePolicy({ ...f.enabled, recycleMaxAgeDays: 30 }, preview), { code: 'retention-confirmation-stale' });
  await assert.rejects(f.service.savePolicy(f.enabled, preview), { code: 'retention-confirmation-invalid' });
  const expired = await f.service.previewPolicy(f.enabled); f.advance(300001);
  await assert.rejects(f.service.savePolicy(f.enabled, expired), { code: 'retention-confirmation-expired' });
  const changed = await f.service.previewPolicy(f.enabled);
  await f.add('another', 10 * DAY);
  await assert.rejects(f.service.savePolicy(f.enabled, changed), { code: 'retention-confirmation-stale' });
  await f.enable();
  await assert.rejects(f.service.savePolicy({ ...f.enabled, recycleMaxAgeDays: 1 }), { code: 'retention-confirmation-required' });
  await f.service.savePolicy({ ...f.enabled, recycleMaxAgeDays: 30 });
  await f.service.savePolicy({ ...f.enabled, recycleAutoDelete: false });
});

test('turning off while a scan waits in the lifecycle queue prevents deletion', async (t) => {
  const f = await fixture(t); await f.add('old', 9 * DAY); await f.enable();
  let release; let entered;
  const started = new Promise((r) => { entered = r; });
  const held = f.lifecycle.run(() => { entered(); return new Promise((r) => { release = r; }); });
  await started;
  const disable = f.service.savePolicy({ ...f.enabled, recycleAutoDelete: false });
  const scan = f.service.runAutomatic();
  await f.purgeStarted; release();
  await Promise.all([held, disable, scan]);
  assert.equal((await f.trashStore.load()).records.get('old').state, 'trashed');
  assert.equal(await readFile(join(f.root, 'old'), 'utf8'), 'original');
});

test('restored then recycled chats are revalidated before automatic purge', async (t) => {
  const f = await fixture(t); await f.add('old', 9 * DAY); await f.enable();
  let release; let entered;
  const started = new Promise((r) => { entered = r; });
  const held = f.lifecycle.run(() => { entered(); return new Promise((r) => { release = r; }); });
  await started;
  const changed = f.lifecycle.run(async () => { await f.trashStore.remove('old'); await f.add('old', 0); });
  const scan = f.service.runAutomatic(); await f.purgeStarted; release();
  await Promise.all([held, changed, scan]);
  assert.equal((await f.trashStore.load()).records.get('old').state, 'trashed');
  assert.equal(await readFile(join(f.root, 'old'), 'utf8'), 'original');
});

test('failed permanent deletions retain durable intent and retry even after disabling new cleanup', async (t) => {
  const f = await fixture(t); await f.add('old', 9 * DAY); await f.enable(); f.fail(true);
  const first = await f.service.runAutomatic();
  assert.equal(first.failed[0].reason, 'disk-unavailable');
  assert.equal((await f.trashStore.load()).records.get('old').state, 'purge-pending');
  await f.service.savePolicy({ ...f.enabled, recycleAutoDelete: false });
  f.fail(false); await f.service.runAutomatic();
  assert.equal((await f.trashStore.load()).records.size, 0);
});

test('shutdown cancels queued automatic deletion before durable intent', async (t) => {
  const f = await fixture(t); await f.add('old', 9 * DAY); await f.enable();
  let release; let entered; let stopped = false;
  const started = new Promise((r) => { entered = r; });
  const held = f.lifecycle.run(() => { entered(); return new Promise((r) => { release = r; }); });
  await started;
  const scan = f.service.runAutomatic({ isStopped: () => stopped });
  await f.purgeStarted;
  stopped = true; release();
  await Promise.all([held, scan]);
  assert.equal(await readFile(join(f.root, 'old'), 'utf8'), 'original');
  assert.equal((await f.trashStore.load()).records.get('old').state, 'trashed');
});
