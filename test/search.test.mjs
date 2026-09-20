import test from 'node:test';
import assert from 'node:assert/strict';

import * as searchModule from '../lib/search.js';

const {
  paginateProjectedMessages,
  projectArchivedMessages,
  searchArchivedSessions,
  searchProjectedMessages,
} = searchModule;

const imageRef = Object.freeze({
  attachmentId: 'attachment-a',
  mediaType: 'image/png',
  bytes: 4,
  width: 2,
  height: 2,
  name: 'diagram.png',
});

test('preview distinguishes human input from plugin-injected context', () => {
  const events = ['user', 'plugin'].map((kind, seq) => ({
    seq, time: seq, type: 'user/message', surfaceOp: 'append',
    data: { id: `input-${seq}`, role: 'user', source: { kind }, content: [{ type: 'text', text: 'context text' }] },
  }));
  const messages = projectArchivedMessages(events);
  assert.deepEqual(messages.map(({ role }) => role), ['user', 'context']);
  assert.deepEqual(messages.map(({ source }) => source), ['user', 'plugin']);
});

test('preview projection preserves tool correlation and verified image descriptors', () => {
  const messages = projectArchivedMessages([
    {
      seq: 1,
      time: 1001,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'user-1',
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', attachment: imageRef },
        ],
      },
    },
    {
      seq: 2,
      time: 1002,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }],
        },
      },
    },
    {
      seq: 3,
      time: 1003,
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-1',
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'done' }] }],
        },
      },
    },
  ]);

  assert.deepEqual(messages[0].segments[1].attachment, imageRef);
  assert.deepEqual(messages[1].segments[0], {
    kind: 'tool-call',
    label: 'read_file',
    text: '{"path":"README.md"}',
    isError: false,
    callId: 'call-1',
    name: 'read_file',
    argumentsText: '{"path":"README.md"}',
  });
  assert.equal(messages[2].segments[0].toolCallId, 'call-1');
  assert.equal(searchModule.findProjectedImage(messages, 'attachment-a')?.mediaType, 'image/png');
  assert.equal(searchModule.findProjectedImage(messages, 'missing'), null);

  const page = paginateProjectedMessages(messages, { offset: 0, limit: 3 });
  assert.equal(page.messages[0].segments[1].attachment.attachmentId, 'attachment-a');
  assert.equal('normalized' in page.messages[0], false);
  assert.equal('searchable' in page.messages[0], false);
});

test('preview projection bounds native correlation strings and cache accounts for them', async () => {
  const oversized = 'x'.repeat(300_000);
  const messages = projectArchivedMessages([
    {
      seq: 1,
      time: 1001,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'user-large',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: { ...imageRef, attachmentId: oversized, name: oversized } }],
      },
    },
    {
      seq: 2,
      time: 1002,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'tool-call', id: oversized, name: oversized, arguments: 'ok' }],
        },
      },
    },
    {
      seq: 3,
      time: 1003,
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        message: {
          role: 'user',
          source: { kind: 'tool' },
          content: [{ type: 'tool-result', toolCallId: oversized, content: [{ type: 'text', text: 'ok' }] }],
        },
      },
    },
  ]);

  assert.equal(messages[0].segments[0].attachment, null);
  assert.ok(messages[0].segments[0].label === null);
  assert.ok(messages[0].segments[0].text.length < 1_000);
  assert.equal(messages[0].segments[0].text.includes(oversized), false);
  assert.equal(messages[1].segments[0].callId, null);
  assert.ok(messages[1].segments[0].name.length <= 256 * 1024 + 1);
  assert.equal(messages[2].segments[0].toolCallId, null);

  let inspections = 0;
  const cache = searchModule.createProjectedMessageCache(async () => {
    inspections += 1;
    return { events: [{
      seq: 1,
      time: 1001,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'tool-call', id: oversized, name: 'tool', arguments: 'ok' }],
        },
      },
    }] };
  }, { maxCachedCodePoints: 10 });
  await cache.get('large');
  await cache.get('large');
  assert.equal(inspections, 2);
});

test('projection bounds huge structured values and per-message segment counts before joining', () => {
  const messages = projectArchivedMessages([{
    seq: 1,
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      message: {
        role: 'assistant',
        source: { kind: 'model' },
        content: [
          { type: 'future', payload: { text: 'x'.repeat(2_000_000) } },
          ...Array.from({ length: 2000 }, (_, index) => ({ type: 'text', text: String(index) })),
        ],
      },
    },
  }]);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].segments.length <= searchModule.PREVIEW_LIMITS.maxSegmentsPerMessage);
  assert.ok(messages[0].segments[0].text.length <= searchModule.PREVIEW_LIMITS.maxSegmentCodePoints + 1);
  assert.ok(messages[0].searchable.length <= searchModule.PREVIEW_LIMITS.maxMessageCodePoints + 4096);
});

test('identity fields use code-point limits without truncation', () => {
  const exactId = '😀'.repeat(1024);
  const oversizedId = '😀'.repeat(1025);
  const messages = projectArchivedMessages([
    {
      seq: 1,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [
            { type: 'tool-call', id: exactId, name: 'read', arguments: 'ok' },
            { type: 'tool-call', id: oversizedId, name: 'read', arguments: 'ok' },
          ],
        },
      },
    },
    {
      seq: 2,
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        message: {
          role: 'user',
          source: { kind: 'tool' },
          content: [
            { type: 'tool-result', toolCallId: exactId, content: [{ type: 'text', text: 'ok' }] },
            { type: 'tool-result', toolCallId: oversizedId, content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      },
    },
  ]);

  assert.equal(messages[0].segments[0].callId, exactId);
  assert.equal(messages[0].segments[1].callId, null);
  assert.equal(messages[1].segments[0].toolCallId, exactId);
  assert.equal(messages[1].segments[1].toolCallId, null);
});

function userEvent(seq, text) {
  return {
    seq,
    time: 1000 + seq,
    type: 'user/message',
    surfaceOp: 'append',
    data: {
      id: `user-${seq}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  };
}

function logEvent(seq, type, data, surfaceOp) {
  return { seq, time: 1000 + seq, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) };
}

function assistantEvent(seq, turn, step, content, extra = {}) {
  return logEvent(seq, 'assistant/message', {
    turn, step, stream: [], ...extra,
    message: { id: `assistant-${seq}`, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content },
  }, 'append');
}

function systemEvent(seq, text, surfaceOp = 'append') {
  return logEvent(seq, 'system/message', {
    turn: 1, step: 1,
    message: { id: `system-${seq}`, role: 'system', source: { kind: 'plugin', plugin: 'system' }, content: text === '' ? [] : [{ type: 'text', text }] },
  }, surfaceOp);
}

function requestHeaderEvent(seq, reason, extra = {}) {
  return logEvent(seq, 'request/header', { header: { config: { provider: 'test', model: 'test' } }, reason, ...extra });
}

test('preview keeps native turn boundaries and counts dispatched process work once', () => {
  const context = userEvent(3, 'environment context');
  context.data.source = { kind: 'plugin', plugin: 'environment', form: 'snapshot' };
  const result = (seq, callId) => logEvent(seq, 'tool/result', {
    turn: 1, step: 1,
    message: { id: `result-${seq}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'done' }] }] },
  }, 'append');
  const messages = projectArchivedMessages([
    logEvent(0, 'turn/start', { turn: 1 }),
    userEvent(1, 'help me'),
    logEvent(2, 'step/start', { turn: 1, step: 1 }),
    context,
    assistantEvent(4, 1, 1, [
      { type: 'reasoning', text: 'inspect first' }, { type: 'text', text: 'I will inspect.' },
      { type: 'tool-call', id: 'read-1', name: 'read', arguments: '{}' },
      { type: 'tool-call', id: 'agent-1', name: 'subagent_review', arguments: '{}' },
    ]),
    logEvent(5, 'tool/call', { turn: 1, step: 1, callId: 'read-1', name: 'read', arguments: '{}' }),
    logEvent(6, 'tool/call', { turn: 1, step: 1, callId: 'agent-1', name: 'subagent_review', arguments: '{}' }),
    result(7, 'read-1'), result(8, 'agent-1'),
    logEvent(9, 'step/end', { turn: 1, step: 1 }),
    logEvent(10, 'step/start', { turn: 1, step: 2 }),
    assistantEvent(11, 1, 2, [{ type: 'reasoning', text: 'ready' }, { type: 'text', text: '**Final answer**' }]),
    logEvent(12, 'step/end', { turn: 1, step: 2 }),
    logEvent(13, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  assert.deepEqual(messages[0].turn, {
    key: 'turn:0', startSeq: 0, endSeq: 13, answerSeq: 11, processStartSeq: 3,
    toolCallCount: 1, messageCount: 1, subagentCount: 1, endReason: 'completed', rowCount: 6,
  });
  assert.ok(messages.every((message) => message.turn === messages[0].turn));
  assert.deepEqual(messages.map(({ step }) => step), [null, 1, 1, 1, 1, 2]);
  const page = paginateProjectedMessages(messages, { offset: 1, limit: 2 });
  assert.equal(page.messages[0].turn.answerSeq, 11);
  assert.equal(page.messages[0].turn.rowCount, 6);
  assert.equal(page.nextOffset, 3);
  assert.equal('searchable' in page.messages[0], false);
});

test('preview never mistakes an earlier commentary or terminal tool request for a final answer', () => {
  const messages = projectArchivedMessages([
    logEvent(0, 'turn/start', { turn: 4 }),
    logEvent(1, 'step/start', { turn: 4, step: 1 }),
    assistantEvent(2, 4, 1, [{ type: 'text', text: 'Checking now.' }]),
    logEvent(3, 'step/end', { turn: 4, step: 1 }),
    logEvent(4, 'step/start', { turn: 4, step: 2 }),
    assistantEvent(5, 4, 2, [{ type: 'text', text: 'Running a tool.' }, { type: 'tool-call', id: 'call-4', name: 'read', arguments: '{}' }]),
    logEvent(6, 'step/end', { turn: 4, step: 2 }),
    logEvent(7, 'turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]);
  assert.equal(messages[0].turn?.answerSeq, null);
  assert.equal(messages[0].turn.toolCallCount, 0);
  assert.equal(messages[0].turn.messageCount, 2);
});

test('preview withholds folding for missing boundaries and retains interrupted answer status', () => {
  const cases = [
    { events: [assistantEvent(1, 1, 1, [{ type: 'text', text: 'orphan' }])], want: null },
    { events: [logEvent(0, 'turn/start', { turn: 1 }), assistantEvent(1, 1, 1, [{ type: 'text', text: 'missing step' }]), logEvent(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })], want: { endSeq: 2, answerSeq: null, endReason: 'completed' } },
    { events: [logEvent(0, 'turn/start', { turn: 1 }), logEvent(1, 'step/start', { turn: 1, step: 1 }), assistantEvent(2, 1, 1, [{ type: 'text', text: 'open' }])], want: { endSeq: null, answerSeq: null, endReason: null } },
    { events: [logEvent(0, 'turn/start', { turn: 1 }), logEvent(1, 'step/start', { turn: 1, step: 1 }), assistantEvent(2, 1, 1, [{ type: 'reasoning', text: 'partial' }, { type: 'text', text: 'partial answer' }], { interrupted: true }), logEvent(3, 'step/end', { turn: 1, step: 1 }), logEvent(4, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })], want: { endSeq: 4, answerSeq: 2, endReason: 'interrupted' } },
  ];
  for (const { events, want } of cases) {
    const [message] = projectArchivedMessages(events);
    if (want === null) assert.equal(message.turn, null);
    else for (const [key, value] of Object.entries(want)) assert.equal(message.turn[key], value, key);
  }
});

test('preview uses start sequence identities across inherited prefixes and seed markers', () => {
  const messages = projectArchivedMessages([
    logEvent(0, 'turn/start', { turn: 1 }), userEvent(1, 'inherited'),
    logEvent(2, 'session/end-seed', { inherited: true }),
    logEvent(3, 'step/start', { turn: 1, step: 1 }),
    assistantEvent(4, 1, 1, [{ type: 'text', text: 'inherited answer' }]),
    logEvent(5, 'step/end', { turn: 1, step: 1 }),
    logEvent(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    logEvent(7, 'session/end-seed', { inherited: true }),
    logEvent(8, 'turn/start', { turn: 1 }), userEvent(9, 'new lifecycle'),
    logEvent(10, 'step/start', { turn: 1, step: 1 }),
    assistantEvent(11, 1, 1, [{ type: 'text', text: 'new answer' }]),
    logEvent(12, 'step/end', { turn: 1, step: 1 }),
    logEvent(13, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  assert.deepEqual(messages.map(({ turn }) => turn?.key), ['turn:0', 'turn:0', 'turn:8', 'turn:8']);
  assert.equal(messages[0].turn.answerSeq, 4);
  assert.equal(messages[2].turn.answerSeq, 11);
});

test('preview leaves torn event windows unfolded even when end markers survived', () => {
  const messages = projectArchivedMessages([
    logEvent(0, 'turn/start', { turn: 1 }),
    logEvent(1, 'step/start', { turn: 1, step: 1 }),
    assistantEvent(3, 1, 1, [{ type: 'text', text: 'answer after missing event' }]),
    logEvent(4, 'step/end', { turn: 1, step: 1 }),
    logEvent(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  assert.equal(messages[0].turn.endSeq, 5);
  assert.equal(messages[0].turn.answerSeq, null);
});

test('preview exposes bounded producer labels without serializing private source payloads', () => {
  const sources = [
    { kind: 'plugin', plugin: 'environment', form: 'snapshot', privateData: 'PRIVATE_SOURCE' },
    { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }, { path: 'nested/AGENTS.md' }, { path: 'AGENTS.md' }] },
    { kind: 'skill-invocation', name: 'debugging' },
    { kind: 'session-reference', form: 'recall', references: [{ label: 'Earlier discussion' }] },
    { kind: 'future-context', form: 'future-form' },
    { kind: 'plugin', plugin: '😀'.repeat(5000) },
  ];
  const messages = projectArchivedMessages(sources.map((source, seq) => {
    const event = userEvent(seq, 'context'); event.data.source = source; return event;
  }));
  assert.deepEqual(messages.slice(0, 5).map(({ sourceLabel }) => sourceLabel), ['environment', 'AGENTS.md, nested/AGENTS.md', 'debugging', 'Earlier discussion', 'future-context']);
  assert.equal(messages[0].sourcePlugin, 'environment');
  assert.equal(messages[0].sourceForm, 'snapshot');
  assert.equal(messages[4].sourceForm, null);
  assert.ok([...messages[5].sourceLabel].length <= 1025);
  assert.equal(JSON.stringify(paginateProjectedMessages(messages)).includes('PRIVATE_SOURCE'), false);
});

test('preview shows independent system prompt updates while excluding other replacement copies', () => {
  const messages = projectArchivedMessages([
    systemEvent(0, 'original prompt'), userEvent(1, 'original input'),
    systemEvent(2, 'replaced prompt', { op: 'replace', startSeq: 0, endSeq: 0 }),
    { ...userEvent(3, 'compaction copy'), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } },
    systemEvent(4, 'appended update'),
    systemEvent(5, '', { op: 'replace', startSeq: 4, endSeq: 4 }),
  ]);
  assert.deepEqual(messages.map(({ seq }) => seq), [0, 1, 2, 4]);
  assert.deepEqual(messages.filter(({ role }) => role === 'system').map(({ systemPromptUpdate }) => systemPromptUpdate), [false, true, true]);
  assert.equal(searchProjectedMessages(messages, 'original prompt').length, 1);
  assert.equal(searchProjectedMessages(messages, 'replaced prompt').length, 1);
  assert.equal(searchProjectedMessages(messages, 'compaction copy').length, 0);
});

test('preview repeats recorded system prompts at resumed and explicit request series starts', () => {
  const messages = projectArchivedMessages([
    logEvent(0, 'turn/start', { turn: 1 }), userEvent(1, 'first prompt'),
    logEvent(2, 'step/start', { turn: 1, step: 1 }), systemEvent(3, 'recorded instructions'),
    requestHeaderEvent(4, 'initial'), assistantEvent(5, 1, 1, [{ type: 'text', text: 'first answer' }]),
    logEvent(6, 'step/end', { turn: 1, step: 1 }), logEvent(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    logEvent(8, 'turn/start', { turn: 2 }), userEvent(9, 'resumed prompt'),
    logEvent(10, 'step/start', { turn: 2, step: 1 }), requestHeaderEvent(11, 'resume'),
    assistantEvent(12, 2, 1, [{ type: 'text', text: 'resumed answer' }]),
    logEvent(13, 'step/end', { turn: 2, step: 1 }), logEvent(14, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    logEvent(15, 'turn/start', { turn: 3 }), userEvent(16, 'new series'),
    logEvent(17, 'step/start', { turn: 3, step: 1 }), requestHeaderEvent(18, 'change', { startsSeries: true }),
    assistantEvent(19, 3, 1, [{ type: 'text', text: 'third answer' }]),
    logEvent(20, 'step/end', { turn: 3, step: 1 }), logEvent(21, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ]);
  const prompts = messages.filter(({ role }) => role === 'system');
  assert.deepEqual(prompts.map(({ seq, anchorSeq }) => [seq, anchorSeq]), [[3, 0], [11, 8], [18, 15]]);
  assert.ok(prompts.every((row) => row.segments[0].text === 'recorded instructions' && row.systemPromptUpdate === false));
  assert.equal(prompts[1].turn.rowCount, 3);
  assert.equal(prompts[1].turn.answerSeq, 12);
  assert.deepEqual(messages.map(({ seq }) => seq), [1, 3, 5, 9, 11, 12, 16, 18, 19]);
  assert.equal(paginateProjectedMessages(messages, { offset: 4, limit: 1 }).messages[0].anchorSeq, 8);
});

test('request prompt cards suppress immediate replacement duplicates and honor cleared instructions', () => {
  const messages = projectArchivedMessages([
    logEvent(0, 'turn/start', { turn: 1 }), logEvent(1, 'step/start', { turn: 1, step: 1 }),
    systemEvent(2, 'first instructions'), requestHeaderEvent(3, 'initial'),
    systemEvent(4, 'new instructions', { op: 'replace', startSeq: 2, endSeq: 2 }),
    requestHeaderEvent(5, 'change'), requestHeaderEvent(6, 'series'),
    systemEvent(7, '', { op: 'replace', startSeq: 4, endSeq: 4 }),
    requestHeaderEvent(8, 'resume'), requestHeaderEvent(9, 'change', { startsSeries: true }),
    logEvent(10, 'step/end', { turn: 1, step: 1 }), logEvent(11, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  assert.deepEqual(messages.map(({ seq, systemPromptUpdate }) => [seq, systemPromptUpdate]), [[2, false], [4, true], [6, false]]);
  assert.equal(messages[2].segments[0].text, 'new instructions');
  assert.equal(messages[2].anchorSeq, 6);
});

test('request prompt cards track surviving system positions through non-system replacements', () => {
  const messages = projectArchivedMessages([
    logEvent(0, 'turn/start', { turn: 1 }), logEvent(1, 'step/start', { turn: 1, step: 1 }),
    systemEvent(2, 'head instructions'), requestHeaderEvent(3, 'initial'),
    systemEvent(4, 'later instructions'), requestHeaderEvent(5, 'change'),
    { ...userEvent(6, 'replacement context'), surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } },
    requestHeaderEvent(7, 'change'),
    systemEvent(8, '', { op: 'replace', startSeq: 2, endSeq: 2 }), requestHeaderEvent(9, 'resume'),
    logEvent(10, 'step/end', { turn: 1, step: 1 }), logEvent(11, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  assert.deepEqual(messages.map(({ seq }) => seq), [2, 4, 7]);
  assert.equal(messages[2].segments[0].text, 'head instructions');
  assert.equal(searchProjectedMessages(messages, 'replacement context').length, 0);
  assert.deepEqual(projectArchivedMessages([requestHeaderEvent(0, 'resume', { header: { config: {}, system: 'unlogged text' } })]), []);
});

test('preview cache budget includes serialized producer metadata', async () => {
  let inspections = 0;
  const cache = searchModule.createProjectedMessageCache(async () => {
    inspections += 1;
    const event = userEvent(1, 'ok');
    event.data.source = { kind: 'plugin', plugin: 'p'.repeat(1000) };
    return { events: [event] };
  }, { maxCachedCodePoints: 100 });
  await cache.get('metadata'); await cache.get('metadata');
  assert.equal(inspections, 2);
});

test('projected search is Unicode-normalized and replacement-safe', () => {
  const messages = projectArchivedMessages([
    userEvent(1, 'ＡＰＩ 部署失败'),
    {
      ...userEvent(2, 'replacement-only'),
      surfaceOp: { op: 'replace', start: 1, end: 1 },
      sourceEventSeqs: [1],
    },
  ]);

  assert.equal(messages.length, 1);
  assert.equal(searchProjectedMessages(messages, 'api 部署').length, 1);
  assert.equal(searchProjectedMessages(messages, 'replacement-only').length, 0);
});

test('preview pagination rejects invalid windows and never leaks private search fields', () => {
  const messages = projectArchivedMessages([userEvent(1, 'one'), userEvent(2, 'two')]);
  const page = paginateProjectedMessages(messages, { offset: 1, limit: 1 });

  assert.equal(page.total, 2);
  assert.equal(page.nextOffset, null);
  assert.equal(page.messages[0].seq, 2);
  assert.equal('normalized' in page.messages[0], false);
  assert.equal('searchable' in page.messages[0], false);
  assert.throws(
    () => paginateProjectedMessages(messages, { offset: -1, limit: 1 }),
    (error) => error?.code === 'preview-page-invalid' && error?.status === 400,
  );
  assert.throws(
    () => paginateProjectedMessages(messages, { offset: 0, limit: 201 }),
    (error) => error?.code === 'preview-page-invalid' && error?.status === 400,
  );
});

test('archive search keeps partial results when one session is unreadable', async () => {
  const result = await searchArchivedSessions({
    ids: ['good-a', 'broken', 'good-b'],
    query: 'needle',
    inspect: async (id) => {
      if (id === 'broken') throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return { events: [userEvent(id === 'good-a' ? 1 : 2, `${id} needle`)] };
    },
  });

  assert.deepEqual(result.hits.map((hit) => hit.sessionId), ['good-a', 'good-b']);
  assert.deepEqual(result.skipped, [{ sessionId: 'broken', reason: 'EACCES' }]);
});

test('archive search bounds concurrent persistence inspection', async () => {
  let active = 0;
  let maximum = 0;
  const ids = Array.from({ length: 12 }, (_, index) => `session-${index}`);

  const result = await searchArchivedSessions({
    ids,
    query: 'match',
    inspect: async (id) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { events: [userEvent(Number(id.split('-')[1]), `${id} match`)] };
    },
  });

  assert.equal(result.hits.length, 12);
  assert.equal(result.skipped.length, 0);
  assert.equal(maximum, 4);
});

test('archive search stops after the first ordered batch satisfying the hit limit', async () => {
  let inspections = 0;
  const result = await searchArchivedSessions({
    ids: Array.from({ length: 100 }, (_, index) => `session-${index}`),
    query: 'match',
    limit: 1,
    inspect: async () => {
      inspections += 1;
      return { events: [userEvent(1, 'match')] };
    },
  });
  assert.equal(result.hits.length, 1);
  assert.ok(inspections <= searchModule.SEARCH_LIMITS.concurrency);
});

test('archive search stops scheduling work after request cancellation', async () => {
  const controller = new AbortController();
  let inspections = 0;
  await assert.rejects(searchArchivedSessions({
    ids: Array.from({ length: 20 }, (_, index) => `session-${index}`),
    query: 'missing',
    signal: controller.signal,
    inspect: async () => {
      inspections += 1;
      controller.abort(Object.assign(new Error('cancelled'), { code: 'request-aborted', status: 499 }));
      return { events: [] };
    },
  }), (error) => error.code === 'request-aborted');
  assert.ok(inspections <= searchModule.SEARCH_LIMITS.concurrency);
});

test('archive search rejects empty and oversized queries before inspection', async () => {
  let inspections = 0;
  const inspect = async () => { inspections += 1; return { events: [] }; };

  await assert.rejects(
    () => searchArchivedSessions({ ids: ['a'], inspect, query: '   ' }),
    (error) => error?.code === 'search-query-invalid' && error?.status === 400,
  );
  await assert.rejects(
    () => searchArchivedSessions({ ids: ['a'], inspect, query: 'x'.repeat(201) }),
    (error) => error?.code === 'search-query-invalid' && error?.status === 400,
  );
  await assert.rejects(
    () => searchArchivedSessions({ ids: ['a'], inspect, query: 'valid', limit: 0 }),
    (error) => error?.code === 'search-limit-invalid' && error?.status === 400,
  );
  assert.equal(inspections, 0);
});

test('projected-message cache reuses fresh entries and supports invalidation', async () => {
  assert.equal(typeof searchModule.createProjectedMessageCache, 'function');
  if (typeof searchModule.createProjectedMessageCache !== 'function') return;
  let inspections = 0;
  const cache = searchModule.createProjectedMessageCache(async (id) => {
    inspections += 1;
    return { events: [userEvent(1, `${id} cached`)] };
  }, { maxEntries: 2, ttlMs: 30_000 });

  const first = await cache.get('a');
  const second = await cache.get('a');
  assert.strictEqual(second, first);
  assert.equal(inspections, 1);

  cache.invalidate(['a']);
  const third = await cache.get('a');
  assert.notStrictEqual(third, first);
  assert.equal(inspections, 2);
});

test('projected-message cache evicts the least-recently-used entry', async () => {
  if (typeof searchModule.createProjectedMessageCache !== 'function') return;
  const calls = new Map();
  const cache = searchModule.createProjectedMessageCache(async (id) => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return { events: [userEvent(1, id)] };
  }, { maxEntries: 2, ttlMs: 30_000 });

  await cache.get('a');
  await cache.get('b');
  await cache.get('a');
  await cache.get('c');
  await cache.get('b');

  assert.deepEqual(Object.fromEntries(calls), { a: 1, b: 2, c: 1 });
});

/**
 * NFKC can change a string's length (ﬁ → fi, ⑴ → (1), ㎡ → m2). A match offset
 * measured in the normalized text is therefore not a valid offset into the
 * original, and using it directly points the excerpt window at unrelated text —
 * or past the end, producing an excerpt with no match in it at all.
 */
test('excerpts stay anchored on the match when normalization changes text length', async (t) => {
  const message = (text) => [{
    seq: 10,
    time: 1,
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }];
  for (const [label, prefix] of [
    ['ascii', 'x'.repeat(300)],
    ['ligature', 'ﬁ'.repeat(300)],
    ['parenthesized digit', '⑴'.repeat(300)],
    ['squared unit', '㎡'.repeat(300)],
    ['astral', '\u{1f600}'.repeat(300)],
    ['cjk', '这是一段中文日志。'.repeat(40)],
  ]) {
    const projected = projectArchivedMessages(message(`${prefix} NEEDLE_TOKEN ${'y'.repeat(300)}`));
    const matches = searchProjectedMessages(projected, 'needle_token');
    assert.equal(matches.length, 1, `${label} matches`);
    assert.ok(
      matches[0].excerpt.includes('NEEDLE_TOKEN'),
      `${label} excerpt contains the match, got ${JSON.stringify([...matches[0].excerpt].slice(0, 40).join(''))}`,
    );
  }
  t.diagnostic('excerpt anchoring verified across length-changing normalizations');
});
