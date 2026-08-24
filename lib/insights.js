export class InsightsError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'InsightsError';
    this.code = code;
    this.status = status;
  }
}

const authorityUnavailable = () => new InsightsError(
  'insights-authority-unavailable',
  'storage insights authority is unavailable',
  503,
);

function clone(value) {
  return structuredClone(value);
}

function readyMeasurement(value) {
  return value?.status === 'ready'
    && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0
    && Number.isSafeInteger(value.fileCount) && value.fileCount >= 0;
}

function normalizeSessions(input) {
  if (!Array.isArray(input)) throw authorityUnavailable();
  const rows = [];
  const seen = new Set();
  for (const value of input) {
    if (value === null || typeof value !== 'object' || typeof value.id !== 'string' || value.id === '' || seen.has(value.id)) {
      throw authorityUnavailable();
    }
    if (!['archive', 'trash'].includes(value.scope)) throw authorityUnavailable();
    seen.add(value.id);
    rows.push({
      id: value.id,
      title: typeof value.title === 'string' ? value.title : null,
      workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : null,
      workspaceTitle: typeof value.workspaceTitle === 'string' ? value.workspaceTitle : null,
      scope: value.scope,
    });
  }
  return rows;
}

function normalizeInventory(input) {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.valid) || !Array.isArray(input.degraded)) {
    throw authorityUnavailable();
  }
  return input;
}

export function createInsightsService({
  statsService,
  trashStore,
  snapshotStore,
  listSessions,
  now = () => new Date(),
  ttlMs = 30_000,
}) {
  if (typeof statsService?.measure !== 'function'
    || typeof trashStore?.load !== 'function'
    || typeof snapshotStore?.inventory !== 'function'
    || typeof listSessions !== 'function') {
    throw new TypeError('storage insights dependencies are required');
  }

  const cacheTtl = Number.isFinite(ttlMs) && ttlMs >= 0 ? Math.floor(ttlMs) : 30_000;
  let cache = null;
  let inFlight = null;
  let generation = 0;

  async function compute() {
    const generated = now();
    if (!(generated instanceof Date) || !Number.isFinite(generated.valueOf())) throw authorityUnavailable();
    const descriptors = normalizeSessions(await listSessions());
    const ids = descriptors.map((row) => row.id);
    const [measurement, trash, rawInventory] = await Promise.all([
      statsService.measure(ids),
      trashStore.load(),
      snapshotStore.inventory(),
    ]);
    if (trash?.status !== 'ready' || !(trash.records instanceof Map)) throw authorityUnavailable();
    const inventory = normalizeInventory(rawInventory);

    const sessions = descriptors.map((descriptor) => {
      const measured = measurement?.sessions?.[descriptor.id];
      return readyMeasurement(measured)
        ? { ...descriptor, status: 'ready', sizeBytes: measured.sizeBytes, fileCount: measured.fileCount }
        : { ...descriptor, status: 'unavailable', sizeBytes: null, fileCount: null };
    });

    const activeSnapshotIds = new Set();
    for (const record of trash.records.values()) {
      if (typeof record?.snapshotId === 'string' && record.snapshotId !== '') activeSnapshotIds.add(record.snapshotId);
    }

    let snapshotBytes = 0;
    let duplicateSnapshotBytes = 0;
    const seenAttachments = new Set();
    const snapshots = [];
    for (const item of inventory.valid) {
      if (item === null || typeof item !== 'object'
        || typeof item.snapshotId !== 'string' || item.snapshotId === ''
        || typeof item.sessionId !== 'string' || item.sessionId === ''
        || typeof item.createdAt !== 'string'
        || !Number.isSafeInteger(item.totalBytes) || item.totalBytes < 0
        || !Number.isSafeInteger(item.sessionBytes) || item.sessionBytes < 0
        || !Number.isSafeInteger(item.attachmentCount) || item.attachmentCount < 0
        || !Array.isArray(item.attachments)) throw authorityUnavailable();
      snapshotBytes += item.totalBytes;
      for (const attachment of item.attachments) {
        if (typeof attachment?.sha256 !== 'string'
          || !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0) throw authorityUnavailable();
        const key = `${attachment.sha256}\u0000${attachment.bytes}`;
        if (seenAttachments.has(key)) duplicateSnapshotBytes += attachment.bytes;
        else seenAttachments.add(key);
      }
      snapshots.push({
        snapshotId: item.snapshotId,
        sessionId: item.sessionId,
        createdAt: item.createdAt,
        totalBytes: item.totalBytes,
        sessionBytes: item.sessionBytes,
        attachmentCount: item.attachmentCount,
        status: 'ready',
        active: activeSnapshotIds.has(item.snapshotId),
      });
    }
    for (const item of inventory.degraded) {
      if (item === null || typeof item !== 'object'
        || typeof item.snapshotId !== 'string' || item.snapshotId === ''
        || typeof item.code !== 'string' || item.code === '') throw authorityUnavailable();
      snapshots.push({
        snapshotId: item.snapshotId,
        status: 'degraded',
        code: item.code,
        active: activeSnapshotIds.has(item.snapshotId),
      });
    }

    const sessionBytes = sessions.reduce(
      (total, row) => total + (row.status === 'ready' ? row.sizeBytes : 0),
      0,
    );
    return {
      generatedAt: generated.toISOString(),
      summary: {
        sessionBytes,
        snapshotBytes,
        totalMeasuredBytes: sessionBytes + snapshotBytes,
        duplicateSnapshotBytes,
        sessionUnavailableCount: sessions.filter((row) => row.status === 'unavailable').length,
        degradedSnapshotCount: inventory.degraded.length,
      },
      sessions,
      snapshots,
    };
  }

  async function inspect() {
    const currentTime = now();
    const currentMs = currentTime instanceof Date ? currentTime.valueOf() : Number.NaN;
    if (!Number.isFinite(currentMs)) throw authorityUnavailable();
    if (cache !== null && cache.expiresAt > currentMs) return clone(cache.value);
    if (inFlight !== null && inFlight.generation === generation) return clone(await inFlight.promise);
    const taskGeneration = generation;
    const promise = compute();
    inFlight = { generation: taskGeneration, promise };
    try {
      const value = await promise;
      const completed = now();
      const completedMs = completed instanceof Date ? completed.valueOf() : Number.NaN;
      if (!Number.isFinite(completedMs)) throw authorityUnavailable();
      if (generation === taskGeneration) cache = { value: clone(value), expiresAt: completedMs + cacheTtl };
      return clone(value);
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  }

  function invalidate() {
    generation += 1;
    cache = null;
    inFlight = null;
  }

  return Object.freeze({ inspect, invalidate });
}
