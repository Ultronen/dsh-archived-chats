import test from 'node:test';
import assert from 'node:assert/strict';

import {
  safeSegment,
  planExport,
  createManifest,
  createSessionRecord,
} from '../lib/export.js';

test('safeSegment removes traversal and Windows-reserved path syntax', () => {
  assert.equal(safeSegment('../CON:<bad>\\name', 'untitled', 80), 'CON-bad-name');
  assert.equal(safeSegment(' . ', 'untitled', 80), 'untitled');
  assert.equal(safeSegment('NUL', 'untitled', 80), 'NUL-file');
  assert.equal(safeSegment('a'.repeat(81), 'untitled', 80), 'a'.repeat(80));
});

test('planExport keeps order and disambiguates hostile duplicate titles', () => {
  const plan = planExport([
    { id: 'session-aaaaaaaa', title: '../Plan' },
    { id: 'session-aaaaaaaa', title: '../Plan' },
    { id: 'session-bbbbbbbb', title: '../Plan' },
  ], new Date('2026-08-19T12:00:00.000Z'));

  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.items.map((item) => item.directory), [
    'sessions/001-Plan-aaaaaaaa',
    'sessions/002-Plan-bbbbbbbb',
  ]);
  assert.equal(plan.filename, 'dsh-archived-chats-2-2026-08-19.zip');
});

test('single-session plan uses a title-based dated filename', () => {
  const plan = planExport([
    { id: 'session-aaaaaaaa', title: 'Release / Notes' },
  ], new Date('2026-08-19T12:00:00.000Z'));

  assert.equal(plan.filename, 'dsh-archived-chat-Release-Notes-2026-08-19.zip');
});

test('versioned records preserve archive and inspected source data', () => {
  const exportedAt = '2026-08-19T12:00:00.000Z';
  const descriptor = {
    id: 'session-a',
    title: 'A',
    workspaceId: 'workspace-a',
    workspaceTitle: 'Workspace',
    createdAt: 123,
    origin: 'subagent',
    tags: ['keep'],
    note: 'literal note',
    metadataUpdatedAt: exportedAt,
    storage: { status: 'ready', sizeBytes: 42, fileCount: 2 },
  };
  const plan = planExport([descriptor], new Date(exportedAt));
  const manifest = createManifest(plan, '0.7.0');

  assert.equal(manifest.format, 'dsh-archived-chats/export');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.attachmentsIncluded, false);
  assert.equal(manifest.sessions[0].note, 'literal note');
  assert.deepEqual(manifest.sessions[0].files, {
    json: 'sessions/001-A-ession-a/session.json',
    markdown: 'sessions/001-A-ession-a/transcript.md',
  });

  const inspected = {
    meta: { header: 'literal' },
    events: [{ seq: 0, type: 'turn/start' }],
  };
  const record = createSessionRecord(plan.items[0], inspected, exportedAt);
  assert.equal(record.format, 'dsh-archived-chats/session');
  assert.equal(record.version, 1);
  assert.strictEqual(record.source.meta, inspected.meta);
  assert.strictEqual(record.source.events, inspected.events);
  assert.deepEqual(record.archive.storage, {
    status: 'ready',
    sizeBytes: 42,
    fileCount: 2,
  });
});

test('missing optional fields and unavailable storage normalize predictably', () => {
  const plan = planExport([
    { id: 'session-a', title: null, tags: null, storage: null },
  ], new Date('2026-08-19T12:00:00.000Z'));
  const session = createManifest(plan, '0.7.0').sessions[0];

  assert.equal(session.title, null);
  assert.deepEqual(session.workspace, { id: null, title: null });
  assert.equal(session.createdAt, null);
  assert.equal(session.origin, null);
  assert.equal(session.note, null);
  assert.deepEqual(session.tags, []);
  assert.deepEqual(session.storage, {
    status: 'unavailable',
    sizeBytes: null,
    fileCount: null,
  });
});
