export class HistoryError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
    this.status = status;
  }
}

const failure = (code, message, status = 500) => new HistoryError(code, message, status);
const clone = (value) => structuredClone(value);

function sessionIds(workspace) {
  if (Array.isArray(workspace?.sessionIds)) return workspace.sessionIds.map(String);
  if (workspace?.sessionIds instanceof Set) return [...workspace.sessionIds].map(String);
  return [];
}

function extractTitle(events) {
  let title = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
      title = event.data.title;
    }
  }
  return title;
}

function safeSnapshot(item) {
  return {
    snapshotId: item.snapshotId,
    sessionId: item.sessionId,
    createdAt: item.createdAt,
    bytes: item.bytes ?? item.totalBytes,
    attachmentCount: item.attachmentCount,
    sourceRevision: item.sourceRevision ?? null,
  };
}

function stableNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw failure('history-authority-unavailable', 'history clock is unavailable', 503);
  }
  return value;
}

export function createHistoryService({
  registry,
  persistence,
  sessions,
  metadataStore,
  trashStore,
  snapshotStore,
  lifecycle,
  now = () => new Date(),
  ttlMs = 30_000,
}) {
  if (registry === null || typeof registry !== 'object'
    || typeof persistence?.list !== 'function' || typeof persistence?.inspect !== 'function'
    || typeof metadataStore?.getMany !== 'function'
    || typeof trashStore?.get !== 'function' || typeof trashStore?.load !== 'function'
    || typeof snapshotStore?.findRevision !== 'function' || typeof snapshotStore?.capture !== 'function'
    || typeof snapshotStore?.inventory !== 'function' || typeof snapshotStore?.inspectHistory !== 'function'
    || typeof lifecycle?.run !== 'function') {
    throw new TypeError('history dependencies are required');
  }

  const cacheTtl = Number.isFinite(ttlMs) && ttlMs >= 0 ? Math.floor(ttlMs) : 30_000;
  let cache = null;
  let inFlight = null;
  let generation = 0;

  function invalidate() {
    generation += 1;
    cache = null;
  }

  async function sourceRevision(sessionId, live) {
    if (typeof persistence.listSnapshots !== 'function') {
      if (live) throw failure('history-revision-unavailable', 'stable session revision is unavailable', 501);
      return null;
    }
    const snapshots = await persistence.listSnapshots();
    const item = Array.isArray(snapshots)
      ? snapshots.find((entry) => String(entry?.header?.id ?? entry?.id) === sessionId)
      : undefined;
    if (item === undefined || typeof item.revision !== 'string' || item.revision === '') {
      throw failure('history-revision-unavailable', 'stable session revision is unavailable', 409);
    }
    return item.revision;
  }

  async function captureArchived(input) {
    const sessionId = typeof input === 'string' ? input : '';
    if (sessionId === '') throw failure('history-session-invalid', 'history session id is required', 400);
    return lifecycle.run(async () => {
      if (!(registry.archivedSessionIds ?? []).map(String).includes(sessionId)) {
        throw failure('history-source-not-archived', 'history source is not archived', 404);
      }
      if ((await trashStore.get(sessionId)) !== null) {
        throw failure('history-source-recycled', 'history source is in the recycle bin', 409);
      }
      const headers = await persistence.list();
      const header = (Array.isArray(headers) ? headers : []).find((item) => String(item?.id) === sessionId);
      if (header === undefined) throw failure('history-source-unavailable', 'history source is unavailable', 404);
      let inspected;
      try { inspected = await persistence.inspect(sessionId); }
      catch { throw failure('history-source-unavailable', 'history source is unavailable', 404); }
      if (inspected?.meta?.id !== sessionId || !Array.isArray(inspected?.events)) {
        throw failure('history-source-unavailable', 'history source is unavailable', 404);
      }
      const workspace = (registry.list?.() ?? []).find((item) => sessionIds(item).includes(sessionId));
      const metadata = await metadataStore.getMany([sessionId]);
      if (metadata?.status !== 'ready') throw failure('history-metadata-unavailable', 'history metadata is unavailable', 503);
      const entry = metadata.entries?.[sessionId];
      const live = sessions?.get?.(sessionId) !== undefined;
      const revision = await sourceRevision(sessionId, live);
      if (revision !== null) {
        const existing = await snapshotStore.findRevision(sessionId, revision);
        if (existing !== null) return { reused: true, snapshot: safeSnapshot(existing) };
      }
      const archive = {
        title: extractTitle(inspected.events) ?? (typeof header.title === 'string' ? header.title : null),
        createdAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
        origin: typeof header.origin === 'string' ? header.origin : null,
        workspace: workspace === undefined ? null : {
          id: String(workspace.id),
          title: typeof workspace.title === 'string' ? workspace.title : null,
          path: typeof workspace.path === 'string' ? workspace.path : null,
        },
        wasArchived: true,
        tags: Array.isArray(entry?.tags) ? [...entry.tags] : [],
        note: typeof entry?.note === 'string' ? entry.note : '',
        metadataUpdatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
      };
      const captured = await snapshotStore.capture({
        sessionId,
        archive,
        liveDisposition: live ? 'parked' : 'cold',
      });
      invalidate();
      return { reused: false, snapshot: safeSnapshot(captured) };
    });
  }

  async function compute() {
    const generatedAt = stableNow(now).toISOString();
    const [inventory, trash] = await Promise.all([snapshotStore.inventory(), trashStore.load()]);
    if (!Array.isArray(inventory?.valid) || !Array.isArray(inventory?.degraded)
      || trash?.status !== 'ready' || !(trash.records instanceof Map)) {
      throw failure('history-authority-unavailable', 'history authority is unavailable', 503);
    }
    const active = new Set();
    for (const record of trash.records.values()) {
      if (typeof record?.snapshotId === 'string' && record.snapshotId !== '') active.add(record.snapshotId);
    }
    const degraded = inventory.degraded.map((item) => ({
      snapshotId: String(item?.snapshotId ?? ''),
      code: typeof item?.code === 'string' && item.code !== '' ? item.code : 'snapshot-invalid',
    }));
    const groups = new Map();
    for (const summary of inventory.valid) {
      try {
        const item = await snapshotStore.inspectHistory(summary.snapshotId);
        if (typeof item?.snapshotId !== 'string' || typeof item?.sessionId !== 'string'
          || typeof item?.createdAt !== 'string' || !Number.isSafeInteger(item.totalBytes)
          || !Number.isSafeInteger(item.attachmentCount)) {
          throw failure('history-authority-unavailable', 'history item is invalid', 503);
        }
        let group = groups.get(item.sessionId);
        if (group === undefined) {
          group = { details: item, versions: [] };
          groups.set(item.sessionId, group);
        }
        group.versions.push({
          snapshotId: item.snapshotId,
          createdAt: item.createdAt,
          totalBytes: item.totalBytes,
          attachmentCount: item.attachmentCount,
          state: active.has(item.snapshotId) ? 'recycle-protection' : 'history',
        });
        if (item.createdAt > group.details.createdAt
          || (item.createdAt === group.details.createdAt && item.snapshotId > group.details.snapshotId)) group.details = item;
      } catch (error) {
        degraded.push({ snapshotId: String(summary?.snapshotId ?? ''), code: error?.code ?? 'snapshot-invalid' });
      }
    }
    const archived = new Set((registry.archivedSessionIds ?? []).map(String));
    const sessionsOutput = [...groups.entries()].map(([sessionId, group]) => {
      group.versions.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.snapshotId.localeCompare(left.snapshotId));
      const recycled = trash.records.has(sessionId);
      return {
        sessionId,
        title: group.details.archive.title,
        workspace: group.details.archive.workspace === null ? null : { ...group.details.archive.workspace },
        scope: recycled ? 'recycled' : archived.has(sessionId) ? 'archived' : 'history-only',
        versions: group.versions,
      };
    });
    sessionsOutput.sort((left, right) => {
      const leftNewest = left.versions[0]?.createdAt ?? '';
      const rightNewest = right.versions[0]?.createdAt ?? '';
      return rightNewest.localeCompare(leftNewest) || left.sessionId.localeCompare(right.sessionId);
    });
    degraded.sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));
    return { generatedAt, sessions: sessionsOutput, degraded };
  }

  async function list() {
    const currentTime = Date.now();
    if (cache !== null && currentTime - cache.completedAt < cacheTtl) return clone(cache.value);
    if (inFlight !== null) return clone(await inFlight.promise);
    const startedGeneration = generation;
    const promise = compute().then((value) => {
      if (generation === startedGeneration) cache = { value: clone(value), completedAt: Date.now() };
      return value;
    });
    const state = { promise };
    inFlight = state;
    try { return clone(await promise); }
    finally { if (inFlight === state) inFlight = null; }
  }

  return Object.freeze({ captureArchived, list, invalidate });
}
