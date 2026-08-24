import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const TRASH_VERSION = 1;

const STATES = new Set(['trashed', 'purge-pending', 'degraded']);
const DISPOSITIONS = new Set(['cold', 'disposed', 'parked']);
const RECORD_FIELDS = [
  'sessionId', 'state', 'trashedAt', 'purgeRequestedAt', 'title', 'createdAt',
  'origin', 'workspace', 'wasArchived', 'tags', 'note', 'metadataUpdatedAt',
  'snapshotId', 'snapshotBytes', 'snapshotAttachmentCount', 'liveDisposition',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class TrashStoreError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'TrashStoreError';
    this.code = code;
    this.status = status;
  }
}

function unavailable(message) {
  return new TrashStoreError('trash-store-unavailable', message, 503);
}

function invalidRecord(message) {
  throw unavailable(`trash record is invalid: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) invalidRecord(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalidRecord(`${label} has unsupported fields`);
  }
}

function cloneWorkspace(workspace) {
  if (workspace === null) return null;
  exactKeys(workspace, ['id', 'title', 'path'], 'workspace');
  if (typeof workspace.id !== 'string' || workspace.id === '') invalidRecord('workspace.id');
  if (typeof workspace.title !== 'string') invalidRecord('workspace.title');
  if (typeof workspace.path !== 'string') invalidRecord('workspace.path');
  return { id: workspace.id, title: workspace.title, path: workspace.path };
}

export function normalizeTrashRecord(input, mapKey) {
  exactKeys(input, RECORD_FIELDS, 'record');
  if (typeof input.sessionId !== 'string' || input.sessionId === '') invalidRecord('sessionId');
  if (UNSAFE_KEYS.has(input.sessionId)) invalidRecord('sessionId');
  if (mapKey !== undefined && (typeof mapKey !== 'string' || input.sessionId !== mapKey)) invalidRecord('sessionId does not match map key');
  if (!STATES.has(input.state)) invalidRecord('state');
  if (!ISO_DATE(input.trashedAt)) invalidRecord('trashedAt');
  if (input.purgeRequestedAt !== null && !ISO_DATE(input.purgeRequestedAt)) invalidRecord('purgeRequestedAt');
  if (input.state === 'trashed' && input.purgeRequestedAt !== null) invalidRecord('trashed purgeRequestedAt');
  if (input.state === 'purge-pending' && input.purgeRequestedAt === null) invalidRecord('purge-pending purgeRequestedAt');
  if (typeof input.title !== 'string') invalidRecord('title');
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) invalidRecord('createdAt');
  if (input.origin !== null && typeof input.origin !== 'string') invalidRecord('origin');
  const workspace = cloneWorkspace(input.workspace);
  if (typeof input.wasArchived !== 'boolean') invalidRecord('wasArchived');
  if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string')) invalidRecord('tags');
  if (typeof input.note !== 'string') invalidRecord('note');
  if (input.metadataUpdatedAt !== null && !ISO_DATE(input.metadataUpdatedAt)) invalidRecord('metadataUpdatedAt');
  if ((input.state === 'trashed' || input.state === 'purge-pending')
    ? (typeof input.snapshotId !== 'string' || !UUID.test(input.snapshotId))
    : (input.snapshotId !== null && (typeof input.snapshotId !== 'string' || !UUID.test(input.snapshotId)))) {
    invalidRecord('snapshotId');
  }
  if (!Number.isSafeInteger(input.snapshotBytes) || input.snapshotBytes < 0) invalidRecord('snapshotBytes');
  if (!Number.isSafeInteger(input.snapshotAttachmentCount) || input.snapshotAttachmentCount < 0) invalidRecord('snapshotAttachmentCount');
  if (!DISPOSITIONS.has(input.liveDisposition)) invalidRecord('liveDisposition');
  return {
    sessionId: input.sessionId,
    state: input.state,
    trashedAt: input.trashedAt,
    purgeRequestedAt: input.purgeRequestedAt,
    title: input.title,
    createdAt: input.createdAt,
    origin: input.origin,
    workspace,
    wasArchived: input.wasArchived,
    tags: [...input.tags],
    note: input.note,
    metadataUpdatedAt: input.metadataUpdatedAt,
    snapshotId: input.snapshotId,
    snapshotBytes: input.snapshotBytes,
    snapshotAttachmentCount: input.snapshotAttachmentCount,
    liveDisposition: input.liveDisposition,
  };
}

function cloneRecord(record) {
  return normalizeTrashRecord(record, record.sessionId);
}

function emptyDocument() { return { version: TRASH_VERSION, records: new Map() }; }

function parseDocument(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw unavailable('trash document is not valid JSON'); }
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || value.version !== TRASH_VERSION || !isPlainObject(value.records)) {
    throw unavailable('trash document schema is unsupported');
  }
  const records = new Map();
  for (const [id, record] of Object.entries(value.records)) {
    if (UNSAFE_KEYS.has(id)) throw unavailable('trash record key is unsafe');
    records.set(id, normalizeTrashRecord(record, id));
  }
  return { version: TRASH_VERSION, records };
}

function documentObject(records) {
  const output = Object.create(null);
  for (const [id, record] of records) output[id] = cloneRecord(record);
  return { version: TRASH_VERSION, records: output };
}

export function selectTrashIds(records, requestedIds, allowedStates) {
  const allowed = allowedStates === undefined ? null : new Set(allowedStates);
  const selected = [];
  const rejected = [];
  const seen = new Set();
  for (const id of Array.isArray(requestedIds) ? requestedIds : []) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    const record = records.get(id);
    if (record === undefined) rejected.push({ id, reason: 'trash-record-missing' });
    else if (allowed !== null && !allowed.has(record.state)) rejected.push({ id, reason: 'trash-state-conflict' });
    else selected.push(id);
  }
  return { selected, rejected };
}

export async function readLegacyPending(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'ready', ids: [] };
    return { status: 'unavailable', ids: [] };
  }
  try {
    const value = JSON.parse(text);
    if (!isPlainObject(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'ids') || !Array.isArray(value.ids)
      || value.ids.some((id) => typeof id !== 'string' || id === '')) {
      return { status: 'unavailable', ids: [] };
    }
    return { status: 'ready', ids: [...new Set(value.ids)] };
  } catch {
    return { status: 'unavailable', ids: [] };
  }
}

export function createTrashStore({ path, now = () => new Date() }) {
  let writeQueue = Promise.resolve();
  let tempCounter = 0;

  async function load() {
    try {
      const document = parseDocument(await readFile(path, 'utf8'));
      const records = new Map([...document.records].map(([id, record]) => [id, cloneRecord(record)]));
      return { status: 'ready', records, document: documentObject(records) };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const document = emptyDocument();
        return { status: 'ready', records: new Map(), document: documentObject(document.records) };
      }
      return { status: 'unavailable', records: new Map(), document: documentObject(new Map()) };
    }
  }

  async function save(records) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    tempCounter += 1;
    const tempPath = `${path}.${process.pid}.${tempCounter}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(documentObject(records), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, path);
  }

  function mutate(operation) {
    const result = writeQueue.then(async () => {
      const loaded = await load();
      if (loaded.status !== 'ready') throw unavailable('trash store is unreadable');
      const records = new Map([...loaded.records].map(([id, record]) => [id, cloneRecord(record)]));
      const value = await operation(records);
      return value;
    });
    writeQueue = result.catch(() => undefined);
    return result;
  }

  function transitionError(message = 'trash state transition is not allowed') {
    return new TrashStoreError('trash-state-conflict', message, 409);
  }

  const api = {
    load,
    async list() {
      const loaded = await load();
      return loaded.status === 'ready' ? [...loaded.records.values()].map(cloneRecord) : [];
    },
    async get(sessionId) {
      const loaded = await load();
      const record = loaded.status === 'ready' ? loaded.records.get(String(sessionId)) : undefined;
      return record === undefined ? null : cloneRecord(record);
    },
    put(input) {
      return mutate(async (records) => {
        const record = normalizeTrashRecord(input, input?.sessionId);
        if (records.has(record.sessionId)) throw transitionError('trash record already exists');
        records.set(record.sessionId, record);
        await save(records);
        return cloneRecord(record);
      });
    },
    transition(sessionId, targetState, patch = {}) {
      return mutate(async (records) => {
        const id = String(sessionId);
        const current = records.get(id);
        if (current === undefined) {
          if (targetState !== 'trashed') throw new TrashStoreError('trash-record-missing', 'trash record is missing', 404);
          const next = normalizeTrashRecord({ ...patch, sessionId: id, state: 'trashed' }, id);
          records.set(id, next);
          await save(records);
          return cloneRecord(next);
        }
        if (targetState === 'removed') {
          if (!['trashed', 'degraded', 'purge-pending'].includes(current.state)) throw transitionError();
          records.delete(id);
          await save(records);
          return null;
        }
        const allowed = (current.state === 'trashed' && targetState === 'purge-pending')
          || (current.state === 'degraded' && targetState === 'purge-pending');
        if (!allowed) throw transitionError();
        const nextPatch = { ...patch, state: targetState };
        if (targetState === 'purge-pending' && nextPatch.purgeRequestedAt === undefined) nextPatch.purgeRequestedAt = now().toISOString();
        const next = normalizeTrashRecord({ ...current, ...nextPatch }, id);
        records.set(id, next);
        await save(records);
        return cloneRecord(next);
      });
    },
    remove(sessionId) {
      return mutate(async (records) => {
        const ids = Array.isArray(sessionId) ? sessionId.map(String) : [String(sessionId)];
        const removed = [];
        for (const id of ids) if (records.delete(id)) removed.push(id);
        if (removed.length > 0) await save(records);
        return removed;
      });
    },
    markDegraded(sessionId, patch = {}) {
      return mutate(async (records) => {
        const id = String(sessionId);
        const current = records.get(id);
        if (current === undefined) throw new TrashStoreError('trash-record-missing', 'trash record is missing', 404);
        if (current.state === 'purge-pending') throw transitionError('purge-pending records cannot be degraded');
        const next = normalizeTrashRecord({ ...current, ...patch, state: 'degraded' }, id);
        records.set(id, next);
        await save(records);
        return cloneRecord(next);
      });
    },
    async summary() {
      const loaded = await load();
      if (loaded.status !== 'ready') return { count: 0, snapshotBytes: 0, degradedCount: 0, purgePendingCount: 0 };
      const counts = { count: loaded.records.size, snapshotBytes: 0, degradedCount: 0, purgePendingCount: 0 };
      for (const record of loaded.records.values()) {
        counts.snapshotBytes += record.snapshotBytes;
        if (record.state === 'purge-pending') counts.purgePendingCount += 1;
        else if (record.state === 'degraded') counts.degradedCount += 1;
      }
      return counts;
    },
  };
  return api;
}
