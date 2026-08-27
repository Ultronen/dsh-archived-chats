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
