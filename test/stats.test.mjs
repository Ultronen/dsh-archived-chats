import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatsService, measureDirectory } from '../lib/stats.js';

test('measureDirectory totals nested regular files and skips symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-stats-'));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'a'), '1234');
  await writeFile(join(root, 'nested', 'b'), '12');
  await symlink(join(root, 'a'), join(root, 'link'));
  assert.deepEqual(await measureDirectory(root), { sizeBytes: 6, fileCount: 2, status: 'ready' });
});

test('measureDirectory rejects a symbolic-link root instead of following files outside the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-stats-root-link-'));
  const outside = join(root, 'outside');
  const linkedRoot = join(root, 'linked-session');
  await mkdir(outside);
  await writeFile(join(outside, 'private-log'), '1234');
  await symlink(outside, linkedRoot);
  await assert.rejects(measureDirectory(linkedRoot));
});

test('stats service summarizes available sessions, caches rows, and invalidates selected sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-stats-service-'));
  const paths = new Map();
  for (const id of ['session-a', 'session-b']) {
    const directory = join(root, id);
    await mkdir(directory);
    paths.set(id, join(directory, 'session.jsonl.zstd'));
  }
  const persistence = {
    list: async () => [{ id: 'session-a' }, { id: 'session-b' }],
    locate: (header) => ({ path: paths.get(header.id) }),
  };
  const measured = new Map([
    [join(root, 'session-a'), { sizeBytes: 10, fileCount: 1, status: 'ready' }],
    [join(root, 'session-b'), { sizeBytes: 20, fileCount: 2, status: 'ready' }],
  ]);
  let calls = 0;
  const service = createStatsService({
    persistence,
    measure: async (directory) => {
      calls += 1;
      return measured.get(directory);
    },
  });

  const result = await service.measure(['session-a', 'session-b', 'missing']);
  const callsAfterFirstMeasure = calls;
  assert.deepEqual(result.summary, { sessionCount: 3, totalBytes: 30, unavailableCount: 1 });
  assert.deepEqual(result.sessions.missing, { sizeBytes: null, fileCount: null, status: 'unavailable' });

  await service.measure(['session-a', 'session-b', 'missing']);
  const callsAfterSecondMeasure = calls;
  assert.equal(callsAfterSecondMeasure, callsAfterFirstMeasure);

  service.invalidate(['session-a']);
  await service.measure(['session-a']);
  const callsAfterInvalidation = calls;
  assert.equal(callsAfterInvalidation, callsAfterFirstMeasure + 1);
});

test('stats service bounds concurrent directory measurements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-stats-concurrency-'));
  const headers = [];
  const paths = new Map();
  for (let index = 0; index < 6; index += 1) {
    const id = `session-${index}`;
    const directory = join(root, id);
    await mkdir(directory);
    headers.push({ id });
    paths.set(id, join(directory, 'session.jsonl.zstd'));
  }
  let active = 0;
  let maxActive = 0;
  const service = createStatsService({
    persistence: {
      list: async () => headers,
      locate: (header) => ({ path: paths.get(header.id) }),
    },
    measure: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { sizeBytes: 1, fileCount: 1, status: 'ready' };
    },
  });

  await service.measure(headers.map((header) => header.id));
  assert.equal(maxActive <= 4, true);
});

test('stats service shares a four-measurement limit across overlapping requests', async () => {
  const headers = Array.from({ length: 8 }, (_, index) => ({ id: `session-${index}` }));
  let active = 0;
  let maxActive = 0;
  const service = createStatsService({
    persistence: {
      list: async () => headers,
      locate: (header) => ({ path: `/sessions/${header.id}/session.jsonl.zstd` }),
    },
    measure: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { sizeBytes: 1, fileCount: 1, status: 'ready' };
    },
  });
  await Promise.all([
    service.measure(headers.slice(0, 4).map((header) => header.id)),
    service.measure(headers.slice(4).map((header) => header.id)),
  ]);
  assert.equal(maxActive <= 4, true);
});

test('stats service shares an in-flight measurement for identical overlapping requests', async () => {
  let resolveMeasurement;
  let calls = 0;
  const service = createStatsService({
    persistence: {
      list: async () => [{ id: 'session-a' }],
      locate: () => ({ path: '/sessions/session-a/session.jsonl.zstd' }),
    },
    measure: async () => {
      calls += 1;
      await new Promise((resolve) => { resolveMeasurement = resolve; });
      return { sizeBytes: 3, fileCount: 1, status: 'ready' };
    },
  });
  const first = service.measure(['session-a']);
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.measure(['session-a']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveMeasurement();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.sessions['session-a'].sizeBytes, 3);
  assert.equal(secondResult.sessions['session-a'].sizeBytes, 3);
});

test('stats invalidation prevents an older in-flight result from repopulating the cache', async () => {
  const resolvers = [];
  let calls = 0;
  const service = createStatsService({
    persistence: {
      list: async () => [{ id: 'session-a' }],
      locate: () => ({ path: '/sessions/session-a/session.jsonl.zstd' }),
    },
    measure: async () => {
      calls += 1;
      const result = calls;
      await new Promise((resolve) => resolvers.push(resolve));
      return { sizeBytes: result, fileCount: 1, status: 'ready' };
    },
  });
  const oldRequest = service.measure(['session-a']);
  await new Promise((resolve) => setImmediate(resolve));
  service.invalidate(['session-a']);
  const freshRequest = service.measure(['session-a']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  resolvers[1]();
  assert.equal((await freshRequest).sessions['session-a'].sizeBytes, 2);
  resolvers[0]();
  await oldRequest;
  assert.equal((await service.measure(['session-a'])).sessions['session-a'].sizeBytes, 2);
  assert.equal(calls, 2);
});
