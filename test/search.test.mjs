import test from 'node:test';
import assert from 'node:assert/strict';

import * as searchModule from '../lib/search.js';

const {
  paginateProjectedMessages,
  projectArchivedMessages,
  searchArchivedSessions,
  searchProjectedMessages,
} = searchModule;

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
