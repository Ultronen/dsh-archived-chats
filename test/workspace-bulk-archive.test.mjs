import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspaceBulkArchiveService } from '../lib/workspace-bulk-archive.js';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');

function fixture(options = {}) {
  let currentTime = options.now ?? NOW;
  const archived = new Set(options.archivedIds ?? ['already-archived']);
  const live = new Set(options.liveIds ?? ['session-live']);
  const blank = new Set(options.blankIds ?? []);
  const calls = { archive: [], capture: [], lifecycle: [] };
  const workspace = {
    id: 'workspace-a',
    title: 'Workspace A',
    path: '/private/workspace-a',
    sessionIds: options.sessionIds ?? [
      { id: 'cold-b', title: 'Beta', createdAt: 20, events: ['private event'] },
      { id: 'cold-a', title: 'Alpha', createdAt: 10, note: 'private note' },
      { id: 'cold-b', title: 'Beta duplicate', createdAt: 99 },
      'already-archived',
      'session-live',
    ],
  };
  const otherWorkspace = { id: 'workspace-b', title: 'Workspace B', path: '/private/workspace-b', sessionIds: [] };
  const registry = {
    get archivedSessionIds() { return [...archived]; },
    list() { return [workspace, otherWorkspace]; },
    async archiveSession(id) {
      calls.archive.push({ receiver: this, id });
      if ((options.archiveFails ?? new Set()).has(id)) throw Object.assign(new Error('archive failed'), { code: 'host-archive-failed' });
      archived.add(id);
    },
  };
  const sessions = { get: (id) => live.has(String(id)) ? { id } : undefined };
  const historyService = {
    async captureArchived(id, captureOptions) {
      calls.capture.push({ id, captureOptions });
      if ((options.snapshotFails ?? new Set()).has(id)) throw Object.assign(new Error('snapshot failed'), { code: 'snapshot-store-failed' });
      return { snapshot: { snapshotId: `snapshot-${id}`, sessionId: id, privateNote: 'never return this' } };
    },
  };
  const lifecycle = {
    async run(operation) {
      calls.lifecycle.push('run');
      const result = await operation();
      if (options.lifecycleRejectsAfter === true) throw new Error('queue rejected after operation');
      return result;
    },
  };
  const dependencies = {
    registry,
    sessions,
    inspectConversation: async (id) => ({ hasConversation: !blank.has(String(id)) }),
    historyService,
    lifecycle,
    now: () => new Date(currentTime),
    secret: 'test-only-secret',
  };
  const service = createWorkspaceBulkArchiveService(dependencies);
  return {
    service, registry, workspace, archived, live, blank, calls, dependencies,
    advance(ms) { currentTime += ms; },
  };
}

test('rejects hosts without every required public capability', () => {
  const { dependencies } = fixture();
  const mutations = [
    { registry: { ...dependencies.registry, list: undefined } },
    { registry: { ...dependencies.registry, archiveSession: undefined } },
    { sessions: {} },
    { inspectConversation: null },
    { lifecycle: {} },
    { now: null },
    { secret: '' },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => createWorkspaceBulkArchiveService({ ...dependencies, ...mutation }),
      (error) => error?.code === 'workspace-archive-unsupported',
    );
  }
});

test('rejects malformed archivedSessionIds capability shapes before any operation', () => {
  const { dependencies } = fixture();
  for (const archivedSessionIds of [null, {}, 'session-a', new Map(), (function* values() { yield 'session-a'; })()]) {
    assert.throws(
      () => createWorkspaceBulkArchiveService({
        ...dependencies,
        registry: { ...dependencies.registry, archivedSessionIds },
      }),
      (error) => error?.code === 'workspace-archive-unsupported',
    );
  }
});

test('lists and previews only safe workspace and cold-session fields in stable deduplicated order', async () => {
  const item = fixture();

  assert.deepEqual(await item.service.listWorkspaces(), [
    { id: 'workspace-a', title: 'Workspace A', eligibleCount: 2, liveCount: 1 },
  ]);
  const preview = await item.service.preview('workspace-a');

  assert.deepEqual(preview.workspace, { id: 'workspace-a', title: 'Workspace A' });
  assert.deepEqual(preview.sessions, [
    { id: 'cold-b', title: 'Beta', createdAt: 20 },
    { id: 'cold-a', title: 'Alpha', createdAt: 10 },
  ]);
  assert.deepEqual(preview.skipped, [
    { id: 'already-archived', reason: 'session-archived' },
    { id: 'session-live', reason: 'session-live' },
  ]);
  assert.equal(preview.expiresAt, new Date(NOW + 5 * 60_000).toISOString());
  assert.equal(JSON.stringify(preview).includes('/private/'), false);
  assert.equal(JSON.stringify(preview).includes('private event'), false);
  assert.equal(JSON.stringify(preview).includes('private note'), false);
});

test('blank new-session windows are never counted or prepared as archiveable conversations', async () => {
  const item = fixture({
    sessionIds: ['blank-first', 'real-conversation', 'blank-last'],
    blankIds: ['blank-first', 'blank-last'],
  });

  assert.deepEqual(await item.service.listWorkspaces(), [
    { id: 'workspace-a', title: 'Workspace A', eligibleCount: 1, liveCount: 0 },
  ]);
  const preview = await item.service.preview('workspace-a');
  assert.deepEqual(preview.sessions.map(({ id }) => id), ['real-conversation']);
  assert.deepEqual(preview.skipped, [
    { id: 'blank-first', reason: 'session-empty' },
    { id: 'blank-last', reason: 'session-empty' },
  ]);
});

test('rejects unknown workspaces before issuing a confirmation', async () => {
  await assert.rejects(
    fixture().service.preview('workspace-missing'),
    (error) => error?.code === 'workspace-not-found',
  );
});

test('preview accepts at most two thousand eligible sessions', async () => {
  const ids = (count) => Array.from({ length: count }, (_, index) => `cold-${index}`);
  const accepted = await fixture({ sessionIds: ids(2_000) }).service.preview('workspace-a');
  assert.equal(accepted.sessions.length, 2_000);

  await assert.rejects(
    fixture({ sessionIds: ids(2_001) }).service.preview('workspace-a'),
    (error) => error?.code === 'workspace-archive-too-many' && error?.status === 400,
  );
});

test('confirmation is nonce-bound, expires after five minutes, and releases consumed records', async () => {
  const item = fixture({ sessionIds: ['cold-a'] });
  const expired = await item.service.preview('workspace-a');
  await assert.rejects(item.service.execute(expired.token, 'wrong-nonce'), (error) => error?.code === 'workspace-archive-confirmation-invalid');
  item.advance(5 * 60_000);
  await assert.rejects(item.service.execute(expired.token, expired.nonce), (error) => error?.code === 'workspace-archive-confirmation-expired');
  await assert.rejects(item.service.execute(expired.token, expired.nonce), (error) => error?.code === 'workspace-archive-confirmation-invalid');

  const current = await item.service.preview('workspace-a');
  assert.deepEqual((await item.service.execute(current.token, current.nonce)).archived, ['cold-a']);
  await assert.rejects(item.service.execute(current.token, current.nonce), (error) => error?.code === 'workspace-archive-confirmation-invalid');
});

test('a fresh preview sweeps expired confirmations before retaining another one', async () => {
  const item = fixture({ sessionIds: ['cold-a'] });
  const expired = await item.service.preview('workspace-a');
  item.advance(5 * 60_000);
  await item.service.preview('workspace-a');

  await assert.rejects(item.service.execute(expired.token, expired.nonce), (error) => error?.code === 'workspace-archive-confirmation-invalid');
});

test('execution revalidates stale membership, archive state, and live sessions without touching them', async () => {
  const item = fixture({ sessionIds: ['moved', 'became-archived', 'became-live', 'became-empty'] });
  const preview = await item.service.preview('workspace-a');
  item.workspace.sessionIds = ['became-archived', 'became-live', 'became-empty'];
  item.archived.add('became-archived');
  item.live.add('became-live');
  item.blank.add('became-empty');

  const result = await item.service.execute(preview.token, preview.nonce);

  assert.deepEqual(result.archived, []);
  assert.deepEqual(result.skipped, [
    { id: 'moved', reason: 'session-workspace-changed' },
    { id: 'became-archived', reason: 'session-archived' },
    { id: 'became-live', reason: 'session-live' },
    { id: 'became-empty', reason: 'session-empty' },
  ]);
  assert.equal(item.calls.archive.length, 0);
  assert.equal(item.calls.capture.length, 0);
});

test('execution reports a newly live session as live even when an archive marker also appears', async () => {
  const item = fixture({ sessionIds: ['became-live'] });
  const preview = await item.service.preview('workspace-a');
  item.archived.add('became-live');
  item.live.add('became-live');

  const result = await item.service.execute(preview.token, preview.nonce);

  assert.deepEqual(result.skipped, [{ id: 'became-live', reason: 'session-live' }]);
  assert.equal(item.calls.archive.length, 0);
});

test('execution archives exactly the previewed IDs and preserves the registry receiver', async () => {
  const item = fixture({ sessionIds: ['captured'] });
  const preview = await item.service.preview('workspace-a');
  item.workspace.sessionIds.push('new-after-preview');

  const result = await item.service.execute(preview.token, preview.nonce);

  assert.deepEqual(result.archived, ['captured']);
  assert.deepEqual(item.calls.archive.map((call) => call.id), ['captured']);
  assert.equal(item.calls.archive[0]?.receiver, item.registry);
  assert.deepEqual(item.calls.capture, []);
  assert.equal(JSON.stringify(result).includes('never return this'), false);
});

test('continues after archive failures without capturing snapshots', async () => {
  const item = fixture({
    sessionIds: ['good-first', 'archive-fails', 'snapshot-fails', 'good-last'],
    archiveFails: new Set(['archive-fails']),
    snapshotFails: new Set(['snapshot-fails']),
  });
  const preview = await item.service.preview('workspace-a');

  const result = await item.service.execute(preview.token, preview.nonce);

  assert.deepEqual(result.archived, ['good-first', 'snapshot-fails', 'good-last']);
  assert.deepEqual(result.failed, [{ id: 'archive-fails', reason: 'archive-failed' }]);
  assert.deepEqual(result.snapshots, []);
  assert.deepEqual(item.calls.capture, []);
  assert.deepEqual(item.calls.archive.map((call) => call.id), ['good-first', 'archive-fails', 'snapshot-fails', 'good-last']);
  assert.equal(item.calls.lifecycle.length, 4);
});

test('a lifecycle rejection after its callback reports one failure without committed item results', async () => {
  const item = fixture({ sessionIds: ['queue-rejected'], lifecycleRejectsAfter: true });
  const preview = await item.service.preview('workspace-a');

  const result = await item.service.execute(preview.token, preview.nonce);

  assert.deepEqual(result.archived, []);
  assert.deepEqual(result.snapshots, []);
  assert.deepEqual(result.failed, [{ id: 'queue-rejected', reason: 'lifecycle-failed' }]);
});


test('loaded idle sessions can be archived while running agents are skipped', async () => {
  const item = fixture({ sessionIds: ['idle', 'running'], liveIds: ['idle', 'running'] });
  const service = createWorkspaceBulkArchiveService({ ...item.dependencies,
    agents: { get: (id) => ({ status: id === 'running' ? 'running' : 'idle' }) },
  });
  const preview = await service.preview('workspace-a');
  assert.deepEqual(preview.sessions.map(({ id }) => id), ['idle']);
  assert.deepEqual(preview.skipped, [{ id: 'running', reason: 'session-live' }]);
  assert.deepEqual((await service.execute(preview.token, preview.nonce)).archived, ['idle']);
});

test('an idle agent that starts running after preview is rechecked before archive', async () => {
  const item = fixture({ sessionIds: ['idle'], liveIds: ['idle'] });
  const agent = { status: 'idle' };
  const service = createWorkspaceBulkArchiveService({ ...item.dependencies, agents: { get: () => agent } });
  const preview = await service.preview('workspace-a');
  assert.equal(preview.sessions.length, 1);
  agent.status = 'running';
  const result = await service.execute(preview.token, preview.nonce);
  assert.deepEqual(result.skipped, [{ id: 'idle', reason: 'session-live' }]);
  assert.equal(item.calls.archive.length, 0);
});

test('workspace archive no longer requires a history capture service', async () => {
  const item = fixture({ sessionIds: ['cold'] });
  const service = createWorkspaceBulkArchiveService({ ...item.dependencies, historyService: undefined });
  const preview = await service.preview('workspace-a');
  assert.deepEqual((await service.execute(preview.token, preview.nonce)).archived, ['cold']);
});
