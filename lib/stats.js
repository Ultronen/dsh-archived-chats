import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const isWithin = (root, path) => {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !pathFromRoot.startsWith(sep));
};

export async function measureDirectory(root) {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('session directory is not a regular directory');
  const canonicalRoot = await realpath(root);
  let sizeBytes = 0;
  let fileCount = 0;

  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('session directory changed during measurement');
    const canonicalPath = await realpath(path);
    if (!isWithin(canonicalRoot, canonicalPath)) throw new Error('session directory escapes root');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) continue;
      if (childInfo.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!childInfo.isFile()) continue;
      sizeBytes += childInfo.size;
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
  const generations = new Map();
  const inFlight = new Map();
  const permits = Math.max(1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 4);
  let active = 0;
  const waiting = [];

  async function withPermit(operation) {
    if (active >= permits) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try { return await operation(); }
    finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  function generationFor(id) { return generations.get(id) ?? 0; }

  function measureOne(id, headerById) {
    const generation = generationFor(id);
    const cached = cache.get(id);
    if (cached !== undefined && cached.expiresAt > now() && cached.generation === generation) return Promise.resolve(cached.result);
    const key = `${id}\u0000${generation}`;
    const current = inFlight.get(key);
    if (current !== undefined) return current;
    const task = (async () => {
      let result;
      try {
        const header = headerById.get(id);
        if (header === undefined || typeof persistence.locate !== 'function') throw new Error('session location unavailable');
        const location = await persistence.locate(header);
        if (typeof location?.path !== 'string') throw new Error('session path unavailable');
        result = await withPermit(() => measure(dirname(location.path)));
        if (result?.status !== 'ready' || !Number.isFinite(result.sizeBytes) || !Number.isFinite(result.fileCount)) {
          throw new Error('invalid measurement');
        }
      } catch {
        result = unavailable();
      }
      if (generationFor(id) === generation) cache.set(id, { expiresAt: now() + ttlMs, generation, result });
      return result;
    })();
    inFlight.set(key, task);
    task.finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
    return task;
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
      const rows = await Promise.all(normalizedIds.map((id) => measureOne(id, headerById)));
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
    invalidate(ids) {
      for (const id of ids.map(String)) {
        cache.delete(id);
        generations.set(id, generationFor(id) + 1);
      }
    },
  };
}
