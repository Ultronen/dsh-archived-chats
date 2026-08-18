import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function measureDirectory(root) {
  let sizeBytes = 0;
  let fileCount = 0;

  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(child);
      sizeBytes += info.size;
      fileCount += 1;
    }
  }

  await visit(root);
  return { sizeBytes, fileCount, status: 'ready' };
}

const unavailable = () => ({ sizeBytes: null, fileCount: null, status: 'unavailable' });

export function createStatsService({
  persistence,
  now = () => Date.now(),
  ttlMs = 30000,
  concurrency = 4,
  measure = measureDirectory,
}) {
  const cache = new Map();

  async function mapWithConcurrency(items, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    async function run() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]);
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => run()));
    return results;
  }

  async function measureOne(id, headerById) {
    const cached = cache.get(id);
    if (cached !== undefined && cached.expiresAt > now()) return cached.result;
    let result;
    try {
      const header = headerById.get(id);
      if (header === undefined || typeof persistence.locate !== 'function') throw new Error('session location unavailable');
      const location = await persistence.locate(header);
      if (typeof location?.path !== 'string') throw new Error('session path unavailable');
      result = await measure(dirname(location.path));
      if (result?.status !== 'ready' || !Number.isFinite(result.sizeBytes) || !Number.isFinite(result.fileCount)) {
        throw new Error('invalid measurement');
      }
    } catch {
      result = unavailable();
    }
    cache.set(id, { expiresAt: now() + ttlMs, result });
    return result;
  }

  return {
    async measure(ids) {
      const normalizedIds = [...new Set(ids.map(String))];
      const headerById = new Map();
      try {
        for (const header of await persistence.list()) headerById.set(String(header.id), header);
      } catch {
        // An unavailable header index becomes unavailable rows, not a failed response.
      }
      const rows = await mapWithConcurrency(normalizedIds, (id) => measureOne(id, headerById));
      const sessions = Object.fromEntries(normalizedIds.map((id, index) => [id, rows[index]]));
      return {
        summary: {
          sessionCount: normalizedIds.length,
          totalBytes: rows.reduce((total, row) => total + (row.status === 'ready' ? row.sizeBytes : 0), 0),
          unavailableCount: rows.filter((row) => row.status === 'unavailable').length,
        },
        sessions,
      };
    },
    invalidate(ids) { for (const id of ids.map(String)) cache.delete(id); },
  };
}
