import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from './durable.js';

const VERSION = 1;
const PREFIX = 'legacy:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['available', 'purge-pending', 'restore-complete']);

export class LegacyRecycleError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'LegacyRecycleError';
    this.code = code;
    this.status = status;
  }
}

const failure = (code, message, status = 500) => new LegacyRecycleError(code, message, status);
const unavailable = () => failure('legacy-recycle-store-unavailable', 'legacy recycle store is unavailable', 503);
const stableCode = (error, fallback = 'legacy-recycle-failed') => (
  typeof error?.code === 'string' && error.code !== '' ? error.code : fallback
);

function instant(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw unavailable();
  return value.toISOString();
}

function snapshotId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw unavailable();
  return value;
}

function itemId(snapshot) {
  return `${PREFIX}${snapshot}`;
}

function fromItemId(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const id = value.slice(PREFIX.length);
  return UUID.test(id) ? id : null;
}

function cloneEntries(entries) {
  return new Map([...entries].map(([id, entry]) => [id, structuredClone(entry)]));
}

function parse(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw unavailable(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'entries,version'
    || value.version !== VERSION || !Array.isArray(value.entries)) throw unavailable();
  const entries = new Map();
  for (const entry of value.entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'migratedAt,snapshotId,state'
      || !STATES.has(entry.state) || entries.has(entry.snapshotId)) throw unavailable();
    const id = snapshotId(entry.snapshotId);
    const migrated = new Date(entry.migratedAt);
    if (!Number.isFinite(migrated.valueOf()) || migrated.toISOString() !== entry.migratedAt) throw unavailable();
    entries.set(id, { snapshotId: id, migratedAt: entry.migratedAt, state: entry.state });
  }
  return entries;
}

export function createLegacyRecycleStore({ path, now = () => new Date() }) {
  const filePath = resolve(String(path));
  let queue = Promise.resolve();

  async function load() {
    try { return { status: 'ready', entries: parse(await readFile(filePath, 'utf8')) }; }
    catch (error) {
      if (error?.code === 'ENOENT') return { status: 'ready', entries: new Map() };
      return { status: 'unavailable', entries: new Map() };
    }
  }

  async function write(entries) {
    const document = { version: VERSION, entries: [...entries.values()].sort((a, b) => a.snapshotId.localeCompare(b.snapshotId)) };
    await atomicWriteFile(filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' });
  }

  function mutate(operation) {
    const result = queue.then(async () => {
      const loaded = await load();
      if (loaded.status !== 'ready') throw unavailable();
      const entries = cloneEntries(loaded.entries);
      const changed = await operation(entries);
      if (changed) await write(entries);
      return cloneEntries(entries);
    });
    queue = result.catch(() => undefined);
    return result;
  }

  async function sync(ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(snapshotId));
    return mutate((entries) => {
      let changed = false;
      for (const id of [...entries.keys()]) {
        if (!wanted.has(id)) { entries.delete(id); changed = true; }
      }
      const migratedAt = instant(now);
      for (const id of wanted) {
        if (!entries.has(id)) {
          entries.set(id, { snapshotId: id, migratedAt, state: 'available' });
          changed = true;
        }
      }
      return changed;
    });
  }

  function transition(id, state) {
    snapshotId(id);
    if (!STATES.has(state)) return Promise.reject(unavailable());
    return mutate((entries) => {
      const entry = entries.get(id);
      if (entry === undefined) throw failure('legacy-recycle-missing', 'legacy recycle item is missing', 404);
      if (entry.state === state) return false;
      entries.set(id, { ...entry, state });
      return true;
    }).then((entries) => structuredClone(entries.get(id)));
  }

  function remove(id) {
    snapshotId(id);
    return mutate((entries) => entries.delete(id));
  }

  return Object.freeze({ load, sync, transition, remove });
}

function mergeResults(left, right, key) {
  return {
    [key]: [...(left?.[key] ?? []), ...(right?.[key] ?? [])],
    failed: [...(left?.failed ?? []), ...(right?.failed ?? [])],
  };
}

export function createLegacyRecycleService({
  store,
  historyService,
  historyRestoreService,
  snapshotStore,
  trashStore,
  lifecycle,
  logger,
}) {
  if (typeof store?.sync !== 'function' || typeof historyService?.list !== 'function'
    || typeof historyRestoreService?.prepare !== 'function' || typeof historyRestoreService?.restore !== 'function'
    || typeof snapshotStore?.remove !== 'function' || typeof trashStore?.load !== 'function'
    || typeof lifecycle?.run !== 'function') throw new TypeError('legacy recycle dependencies are required');

  async function descriptors() {
    const inventory = await historyService.list();
    const output = new Map();
    for (const session of Array.isArray(inventory?.sessions) ? inventory.sessions : []) {
      for (const version of Array.isArray(session?.versions) ? session.versions : []) {
        if (version?.state !== 'history' || typeof version.snapshotId !== 'string') continue;
        output.set(version.snapshotId, {
          snapshotId: version.snapshotId,
          sourceSessionId: session.sessionId,
          title: typeof session.title === 'string' ? session.title : null,
          workspace: session.workspace === null ? null : structuredClone(session.workspace),
          createdAt: version.createdAt,
          bytes: version.totalBytes,
          attachmentCount: version.attachmentCount,
          degraded: false,
        });
      }
    }
    for (const item of Array.isArray(inventory?.degraded) ? inventory.degraded : []) {
      if (typeof item?.snapshotId !== 'string') continue;
      output.set(item.snapshotId, {
        snapshotId: item.snapshotId, sourceSessionId: null, title: null, workspace: null,
        createdAt: null, bytes: 0, attachmentCount: 0, degraded: true,
      });
    }
    return output;
  }

  function row(entry, descriptor) {
    const pending = entry.state === 'purge-pending';
    return {
      sessionId: itemId(entry.snapshotId),
      sourceKind: 'legacy-snapshot',
      legacySnapshotId: entry.snapshotId,
      sourceSessionId: descriptor.sourceSessionId,
      state: pending ? 'purge-pending' : descriptor.degraded ? 'degraded' : 'trashed',
      trashedAt: entry.migratedAt,
      purgeRequestedAt: null,
      title: descriptor.title,
      createdAt: descriptor.createdAt === null ? null : Date.parse(descriptor.createdAt),
      origin: null,
      workspace: descriptor.workspace,
      wasArchived: true,
      tags: [],
      note: '',
      metadataUpdatedAt: null,
      snapshotId: entry.snapshotId,
      snapshotBytes: descriptor.bytes,
      snapshotAttachmentCount: descriptor.attachmentCount,
      liveDisposition: 'cold',
      restorable: !descriptor.degraded && !pending,
    };
  }

  async function current() {
    const bySnapshot = await descriptors();
    const entries = await store.sync([...bySnapshot.keys()]);
    const rows = [];
    for (const [id, entry] of entries) {
      const descriptor = bySnapshot.get(id);
      if (descriptor === undefined || entry.state === 'restore-complete') continue;
      rows.push(row(entry, descriptor));
    }
    rows.sort((left, right) => left.trashedAt.localeCompare(right.trashedAt)
      || left.legacySnapshotId.localeCompare(right.legacySnapshotId));
    return rows;
  }

  const list = () => current().then((rows) => structuredClone(rows));

  async function summary() {
    const rows = await current();
    return {
      count: rows.length,
      snapshotBytes: rows.reduce((total, item) => total + item.snapshotBytes, 0),
      degradedCount: rows.filter((item) => item.state === 'degraded').length,
      purgePendingCount: rows.filter((item) => item.state === 'purge-pending').length,
    };
  }

  async function retentionRecords() {
    const rows = await current();
    return new Map(rows.map((item) => [item.sessionId, {
      sessionId: item.sessionId,
      state: item.state,
      trashedAt: item.trashedAt,
      snapshotId: item.snapshotId,
      snapshotBytes: item.snapshotBytes,
    }]));
  }

  async function availableEntry(id) {
    const snapshot = fromItemId(id);
    if (snapshot === null) throw failure('legacy-recycle-id-invalid', 'legacy recycle item id is invalid', 400);
    const loaded = await store.load();
    if (loaded.status !== 'ready') throw unavailable();
    const entry = loaded.entries.get(snapshot);
    if (entry === undefined) throw failure('legacy-recycle-missing', 'legacy recycle item is missing', 404);
    return entry;
  }

  async function restore(ids) {
    const restored = [];
    const created = [];
    const failed = [];
    const warnings = [];
    for (const id of [...new Set(Array.isArray(ids) ? ids : [])]) {
      try {
        const snapshot = fromItemId(id);
        const target = (await current()).find((item) => item.sessionId === id);
        if (snapshot === null || target === undefined) throw failure('legacy-recycle-missing', 'legacy recycle item is missing', 404);
        if (!target.restorable) throw failure('legacy-snapshot-degraded', 'legacy snapshot cannot be restored', 409);
        const prepared = await historyRestoreService.prepare(snapshot);
        const outcome = await historyRestoreService.restore(prepared.token, prepared.nonce, {
          beforeRestore: async () => {
            const entry = await availableEntry(id);
            if (entry.state !== 'available') throw failure('legacy-recycle-conflict', 'legacy recycle item changed', 409);
          },
          afterCommit: async (result) => {
            await store.transition(snapshot, 'restore-complete');
            try {
              await snapshotStore.remove(snapshot);
              await store.remove(snapshot);
              historyService.invalidate?.();
            } catch {
              warnings.push({ id, reason: 'legacy-cleanup-pending' });
            }
            return result;
          },
        });
        restored.push(id);
        created.push(...(outcome.restored ?? []));
        warnings.push(...(outcome.warnings ?? []).map((warning) => ({ ...warning, id })));
      } catch (error) { failed.push({ id, reason: stableCode(error) }); }
    }
    return { restored, created, failed, warnings };
  }

  async function purgeOne(id, options = {}) {
    const target = (await current()).find((item) => item.sessionId === id);
    if (target === undefined) throw failure('legacy-recycle-missing', 'legacy recycle item is missing', 404);
    return lifecycle.run(async () => {
      const entry = await availableEntry(id);
      const expected = options.expected;
      if (expected !== undefined && (target.state !== expected.state
        || target.trashedAt !== expected.trashedAt || target.snapshotId !== expected.snapshotId
        || target.snapshotBytes !== expected.bytes)) {
        throw failure('retention-candidate-stale', 'legacy recycle item changed', 409);
      }
      const trash = await trashStore.load();
      if (trash?.status !== 'ready' || !(trash.records instanceof Map)) throw failure('trash-store-unavailable', 'trash store is unavailable', 503);
      if ([...trash.records.values()].some((record) => record?.snapshotId === target.snapshotId)) {
        throw failure('history-snapshot-protected', 'snapshot now protects a recycled chat', 409);
      }
      await options.beforePurge?.(target);
      if (entry.state === 'available') await store.transition(target.snapshotId, 'purge-pending');
      else if (entry.state !== 'purge-pending') throw failure('legacy-recycle-conflict', 'legacy recycle item changed', 409);
      await snapshotStore.remove(target.snapshotId);
      await store.remove(target.snapshotId);
      historyService.invalidate?.();
      return id;
    });
  }

  async function purge(ids, options = {}) {
    const purged = [];
    const failed = [];
    for (const id of [...new Set(Array.isArray(ids) ? ids : [])]) {
      try { purged.push(await purgeOne(id, options.expected?.sessionId === id ? options : {})); }
      catch (error) { failed.push({ id, reason: stableCode(error) }); }
    }
    return { purged, failed };
  }

  async function empty() {
    return purge((await current()).map((item) => item.sessionId));
  }

  async function recoverStartup() {
    const loaded = await store.load();
    if (loaded.status !== 'ready') throw unavailable();
    for (const entry of loaded.entries.values()) {
      if (!['purge-pending', 'restore-complete'].includes(entry.state)) continue;
      try {
        await snapshotStore.remove(entry.snapshotId);
        await store.remove(entry.snapshotId);
        historyService.invalidate?.();
      } catch (error) {
        logger?.warn?.(`archived-chats: legacy recycle recovery failed: ${stableCode(error)}`);
      }
    }
  }

  return Object.freeze({ list, summary, retentionRecords, restore, purge, empty, recoverStartup });
}

export function createRecycleHub({ recycleService, legacyRecycleService }) {
  if (typeof recycleService?.list !== 'function' || typeof legacyRecycleService?.list !== 'function') {
    throw new TypeError('recycle hub dependencies are required');
  }
  const partition = (ids) => ({
    regular: [...new Set(ids)].filter((id) => fromItemId(id) === null),
    legacy: [...new Set(ids)].filter((id) => fromItemId(id) !== null),
  });
  async function list() { return [...await recycleService.list(), ...await legacyRecycleService.list()]; }
  async function summary() {
    const [left, right] = await Promise.all([recycleService.summary(), legacyRecycleService.summary()]);
    return {
      count: (left.count ?? 0) + (right.count ?? 0),
      snapshotBytes: (left.snapshotBytes ?? 0) + (right.snapshotBytes ?? 0),
      degradedCount: (left.degradedCount ?? 0) + (right.degradedCount ?? 0),
      purgePendingCount: (left.purgePendingCount ?? 0) + (right.purgePendingCount ?? 0),
    };
  }
  async function restore(ids) {
    const { regular, legacy } = partition(ids);
    const [left, right] = await Promise.all([
      regular.length ? recycleService.restore(regular) : { restored: [], failed: [] },
      legacy.length ? legacyRecycleService.restore(legacy) : { restored: [], created: [], failed: [], warnings: [] },
    ]);
    return { ...mergeResults(left, right, 'restored'), created: right.created ?? [], warnings: right.warnings ?? [] };
  }
  async function purge(ids, options = {}) {
    const { regular, legacy } = partition(ids);
    const [left, right] = await Promise.all([
      regular.length ? recycleService.purge(regular, options) : { purged: [], failed: [] },
      legacy.length ? legacyRecycleService.purge(legacy, options) : { purged: [], failed: [] },
    ]);
    return mergeResults(left, right, 'purged');
  }
  async function empty() {
    const left = await recycleService.empty();
    const right = await legacyRecycleService.empty();
    return mergeResults(left, right, 'purged');
  }
  async function recoverStartup(options) {
    await recycleService.recoverStartup(options);
    await legacyRecycleService.recoverStartup();
  }
  return Object.freeze({
    list, summary, restore, purge, empty, recoverStartup,
    move: (...args) => recycleService.move(...args),
  });
}

export function createUnifiedTrashStore({ trashStore, legacyRecycleService }) {
  return Object.freeze({
    async load() {
      const [regular, legacy] = await Promise.all([trashStore.load(), legacyRecycleService.retentionRecords()]);
      if (regular?.status !== 'ready' || !(regular.records instanceof Map)) return regular;
      return { status: 'ready', records: new Map([...regular.records, ...legacy]) };
    },
  });
}
