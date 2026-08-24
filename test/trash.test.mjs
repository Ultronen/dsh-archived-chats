import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrashStoreError, createTrashStore, normalizeTrashRecord, readLegacyPending, selectTrashIds } from '../lib/trash.js';

const readyRecord = (id = 'session-a') => ({
  sessionId: id,
  state: 'trashed',
  trashedAt: '2026-08-24T00:00:00.000Z',
  purgeRequestedAt: null,
  title: 'Alpha',
  createdAt: 10,
  origin: null,
  workspace: { id: 'ws-1', title: 'Project', path: '/project' },
  wasArchived: true,
  tags: ['important'],
  note: 'keep context',
  metadataUpdatedAt: '2026-08-24T00:00:00.000Z',
  snapshotId: '00000000-0000-4000-8000-000000000001',
  snapshotBytes: 123,
  snapshotAttachmentCount: 1,
  liveDisposition: 'cold',
});

test('normalizes an exact record and rejects unsupported states', () => {
  assert.deepEqual(normalizeTrashRecord(readyRecord(), 'session-a'), readyRecord());
  assert.throws(() => normalizeTrashRecord({ ...readyRecord(), state: 'deleted' }, 'session-a'),
    (error) => error instanceof TrashStoreError && error.code === 'trash-store-unavailable');
});

test('selection preserves first request order and filters states', () => {
  const records = new Map([
    ['a', readyRecord('a')],
    ['b', { ...readyRecord('b'), state: 'purge-pending', purgeRequestedAt: '2026-08-24T01:00:00.000Z' }],
  ]);
  assert.deepEqual(selectTrashIds(records, ['b', 'a', 'a'], ['trashed']), {
    selected: ['a'],
    rejected: [{ id: 'b', reason: 'trash-state-conflict' }],
  });
});

test('serializes concurrent writes and enforces transitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-trash-'));
  const store = createTrashStore({ path: join(root, 'trash.json') });
  await Promise.all([store.put(readyRecord('a')), store.put(readyRecord('b'))]);
  assert.deepEqual((await store.list()).map((record) => record.sessionId).sort(), ['a', 'b']);
  await store.transition('a', 'purge-pending', { purgeRequestedAt: '2026-08-24T02:00:00.000Z' });
  await assert.rejects(store.transition('a', 'trashed'), (error) => error.code === 'trash-state-conflict');
});

test('preserves malformed bytes and rejects mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-trash-corrupt-'));
  const path = join(root, 'trash.json');
  await writeFile(path, '{broken', 'utf8');
  const store = createTrashStore({ path });
  assert.equal((await store.load()).status, 'unavailable');
  await assert.rejects(store.put(readyRecord()), (error) => error.code === 'trash-store-unavailable');
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('missing documents are ready-empty and invalid records fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-trash-schema-'));
  const path = join(root, 'trash.json');
  const store = createTrashStore({ path });
  assert.equal((await store.load()).status, 'ready');
  assert.deepEqual(await store.list(), []);
  await writeFile(path, JSON.stringify({ version: 2, records: {} }), 'utf8');
  assert.equal((await store.load()).status, 'unavailable');
  await writeFile(path, JSON.stringify({ version: 1, records: { a: { ...readyRecord('a'), tags: ['ok', 2] } } }), 'utf8');
  assert.equal((await store.load()).status, 'unavailable');
});

test('degraded records can be purged but never restore or downgrade pending purge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-trash-degraded-'));
  const store = createTrashStore({ path: join(root, 'trash.json') });
  await store.put(readyRecord());
  const degraded = await store.markDegraded('session-a', { snapshotId: null });
  assert.equal(degraded.state, 'degraded');
  const same = await store.markDegraded('session-a');
  assert.equal(same.state, 'degraded');
  await store.put(readyRecord('session-b'));
  await store.markDegraded('session-b');
  await store.transition('session-b', 'purge-pending', { purgeRequestedAt: '2026-08-24T02:00:00.000Z' });
  await assert.rejects(store.transition('session-b', 'trashed'), (error) => error.code === 'trash-state-conflict');
  await assert.rejects(store.markDegraded('session-b'), (error) => error.code === 'trash-state-conflict');
});

test('remove is idempotent and summary counts each state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-trash-summary-'));
  const store = createTrashStore({ path: join(root, 'trash.json') });
  await Promise.all([store.put(readyRecord('a')), store.put(readyRecord('b')), store.put(readyRecord('c'))]);
  await store.markDegraded('b', { snapshotId: null });
  await store.transition('c', 'purge-pending', { purgeRequestedAt: '2026-08-24T02:00:00.000Z' });
  assert.deepEqual(await store.summary(), { count: 3, snapshotBytes: 369, degradedCount: 1, purgePendingCount: 1 });
  assert.deepEqual(await store.remove('missing'), []);
  assert.deepEqual(await store.remove('a'), ['a']);
  assert.deepEqual(await store.remove('a'), []);
});

test('legacy pending accepts only the exact ids array shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-pending-'));
  const path = join(root, 'pending-deletions.json');
  assert.deepEqual(await readLegacyPending(join(root, 'missing.json')), { status: 'ready', ids: [] });
  await writeFile(path, '{"ids":["a","a","b"]}\n', 'utf8');
  assert.deepEqual(await readLegacyPending(path), { status: 'ready', ids: ['a', 'b'] });
  await writeFile(path, '{"version":1,"ids":["a"]}\n', 'utf8');
  assert.equal((await readLegacyPending(path)).status, 'unavailable');
  await writeFile(path, '{"ids":[""]}\n', 'utf8');
  assert.equal((await readLegacyPending(path)).status, 'unavailable');
  await writeFile(path, '{broken', 'utf8');
  assert.equal((await readLegacyPending(path)).status, 'unavailable');
});
