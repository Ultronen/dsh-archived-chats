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
