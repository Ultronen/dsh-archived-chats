import test from 'node:test';
import assert from 'node:assert/strict';
import { buffer } from 'node:stream/consumers';
import { unzipSync, strFromU8 } from 'fflate';

import {
  safeSegment,
  planExport,
  createManifest,
  createSessionRecord,
  renderTranscript,
  createExportZip,
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

function transcriptItem() {
  return planExport([{
    id: 'session-a',
    title: 'Transcript title',
    workspaceId: 'workspace-a',
    workspaceTitle: 'Workspace',
    createdAt: 123,
    origin: 'user',
    tags: ['keep'],
    note: 'line one\nline two',
    metadataUpdatedAt: '2026-08-18T12:00:00.000Z',
    storage: { status: 'ready', sizeBytes: 42, fileCount: 2 },
  }], new Date('2026-08-19T12:00:00.000Z')).items[0];
}

test('transcript renders append-origin Harness messages without replacement copies', () => {
  const events = [
    {
      seq: 0,
      time: Date.parse('2026-08-19T10:00:00.000Z'),
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'user-1',
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'Original user text' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'attachment-1',
              mediaType: 'image/png',
              bytes: 2048,
              width: 640,
              height: 480,
              name: 'diagram.png',
            },
          },
        ],
      },
    },
    {
      seq: 1,
      time: Date.parse('2026-08-19T10:00:01.000Z'),
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [
            { type: 'reasoning', text: 'Private reasoning text' },
            { type: 'text', text: 'Original assistant text' },
            { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.md"}' },
            { type: 'future-block', literal: 'unknown payload' },
          ],
        },
      },
    },
    {
      seq: 2,
      time: Date.parse('2026-08-19T10:00:02.000Z'),
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-1',
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            isError: true,
            content: [{ type: 'text', text: 'Tool failed literally' }],
          }],
        },
      },
    },
    {
      seq: 3,
      time: Date.parse('2026-08-19T10:00:03.000Z'),
      type: 'assistant/message',
      surfaceOp: { op: 'replace', start: 1, end: 1 },
      sourceEventSeqs: [1],
      data: {
        turn: 2,
        step: 2,
        message: {
          id: 'assistant-replacement',
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [{ type: 'text', text: 'Replacement copy must stay hidden' }],
        },
      },
    },
  ];

  const markdown = renderTranscript(
    transcriptItem(),
    events,
    '2026-08-19T12:00:00.000Z',
  );

  assert.match(markdown, /^---\nformat: "dsh-archived-chats\/transcript"/);
  assert.match(markdown, /title: "Transcript title"/);
  assert.match(markdown, /note: "line one\\nline two"/);
  assert.match(markdown, /## User - 2026-08-19T10:00:00\.000Z/);
  assert.match(markdown, /Original user text/);
  assert.match(markdown, /diagram\.png.*image\/png.*640x480.*2048 bytes.*attachment-1/);
  assert.match(markdown, /## Assistant - 2026-08-19T10:00:01\.000Z/);
  assert.match(markdown, /### Reasoning/);
  assert.match(markdown, /Private reasoning text/);
  assert.match(markdown, /### Tool call: read_file/);
  assert.match(markdown, /\{"path":"a\.md"\}/);
  assert.match(markdown, /"type": "future-block"/);
  assert.match(markdown, /## Tool result - 2026-08-19T10:00:02\.000Z/);
  assert.match(markdown, /Tool result `call-1` \(error\)/);
  assert.match(markdown, /Tool failed literally/);
  assert.doesNotMatch(markdown, /Replacement copy must stay hidden/);
});

function zipPlan(count = 2) {
  return planExport(Array.from({ length: count }, (_, index) => ({
    id: `session-${String.fromCharCode(97 + index)}`,
    title: `Session ${index + 1}`,
    tags: [],
    note: '',
    storage: { status: 'ready', sizeBytes: index + 1, fileCount: 1 },
  })), new Date('2026-08-19T12:00:00.000Z'));
}

test('ZIP contains a manifest and two deterministic entries per session', async () => {
  const plan = zipPlan(2);
  const inspect = async (id) => ({
    meta: { id },
    events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
  });
  const { stream, completion } = await createExportZip({
    plan,
    inspect,
    generatorVersion: '0.7.0',
  });
  const [bytes] = await Promise.all([buffer(stream), completion]);
  const entries = unzipSync(new Uint8Array(bytes));
  const names = Object.keys(entries);

  assert.deepEqual(names, [
    'manifest.json',
    plan.items[0].files.json,
    plan.items[0].files.markdown,
    plan.items[1].files.json,
    plan.items[1].files.markdown,
  ]);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.deepEqual(manifest.sessions.map((session) => session.id), ['session-a', 'session-b']);
  const first = JSON.parse(strFromU8(entries[plan.items[0].files.json]));
  assert.deepEqual(first.source.meta, { id: 'session-a' });
  assert.match(strFromU8(entries[plan.items[0].files.markdown]), /# Session 1/);
});

test('ZIP inspects sessions serially', async () => {
  const plan = zipPlan(2);
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const inspect = async (id) => {
    calls.push(id);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { meta: { id }, events: [] };
  };

  const { stream, completion } = await createExportZip({ plan, inspect, generatorVersion: '0.7.0' });
  await Promise.all([buffer(stream), completion]);

  assert.deepEqual(calls, ['session-a', 'session-b']);
  assert.equal(maximumActive, 1);
});

test('mid-stream inspection failure aborts ZIP before later sessions', async () => {
  const plan = zipPlan(3);
  const calls = [];
  const inspect = async (id) => {
    calls.push(id);
    if (id === 'session-b') throw new Error('fixture inspect failure');
    return { meta: { id }, events: [] };
  };

  const { stream, completion } = await createExportZip({ plan, inspect, generatorVersion: '0.7.0' });
  const results = await Promise.allSettled([buffer(stream), completion]);

  assert.deepEqual(calls, ['session-a', 'session-b']);
  assert(results.some((result) => result.status === 'rejected'));
  assert(results.filter((result) => result.status === 'rejected')
    .every((result) => /fixture inspect failure/.test(String(result.reason))));
});
