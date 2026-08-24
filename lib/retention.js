import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const RETENTION_VERSION = 1;
export const DEFAULT_RETENTION_POLICY = Object.freeze({
  historicalSnapshotsPerSession: 1,
  historicalSnapshotMaxAgeDays: null,
  snapshotQuotaBytes: null,
  recycleMaxAgeDays: null,
});

const POLICY_KEYS = Object.keys(DEFAULT_RETENTION_POLICY);
const WRITE_QUEUES = new Map();
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_QUOTA = 1024 * 1024;
const MAX_QUOTA = 8 * 1024 ** 4;

export class RetentionError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'RetentionError';
    this.code = code;
    this.status = status;
  }
}

const invalidPolicy = () => new RetentionError('retention-policy-invalid', 'retention policy is invalid', 400);
const unavailableStore = () => new RetentionError('retention-store-unavailable', 'retention store is unavailable', 503);
const invalidPlan = () => new RetentionError('retention-plan-invalid', 'retention plan input is invalid', 503);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function clonePolicy(value) {
  return {
    historicalSnapshotsPerSession: value.historicalSnapshotsPerSession,
    historicalSnapshotMaxAgeDays: value.historicalSnapshotMaxAgeDays,
    snapshotQuotaBytes: value.snapshotQuotaBytes,
    recycleMaxAgeDays: value.recycleMaxAgeDays,
  };
}

function nullableInteger(value, minimum, maximum) {
  return value === null || (Number.isSafeInteger(value) && value >= minimum && value <= maximum);
}

export function normalizeRetentionPolicy(input) {
  if (!exactKeys(input, POLICY_KEYS)
    || !Number.isSafeInteger(input.historicalSnapshotsPerSession)
    || input.historicalSnapshotsPerSession < 0
    || input.historicalSnapshotsPerSession > 20
    || !nullableInteger(input.historicalSnapshotMaxAgeDays, 1, 3650)
    || !nullableInteger(input.snapshotQuotaBytes, MIN_QUOTA, MAX_QUOTA)
    || !nullableInteger(input.recycleMaxAgeDays, 1, 3650)) {
    throw invalidPolicy();
  }
  return clonePolicy(input);
}

function parseDocument(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw unavailableStore(); }
  if (!exactKeys(value, ['version', 'policy']) || value.version !== RETENTION_VERSION) throw unavailableStore();
  try { return normalizeRetentionPolicy(value.policy); }
  catch { throw unavailableStore(); }
}

export function createRetentionStore({ path }) {
  const filePath = resolve(String(path));

  async function load() {
    try {
      const policy = parseDocument(await readFile(filePath, 'utf8'));
      return { status: 'ready', policy: clonePolicy(policy) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'ready', policy: clonePolicy(DEFAULT_RETENTION_POLICY) };
      return { status: 'unavailable', policy: clonePolicy(DEFAULT_RETENTION_POLICY) };
    }
  }

  async function write(policy) {
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const text = `${JSON.stringify({ version: RETENTION_VERSION, policy }, null, 2)}\n`;
      await writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(tempPath, 0o600);
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  function save(input) {
    const previous = WRITE_QUEUES.get(filePath) ?? Promise.resolve();
    const result = previous.then(async () => {
      const loaded = await load();
      if (loaded.status !== 'ready') throw unavailableStore();
      const policy = normalizeRetentionPolicy(input);
      await write(policy);
      return clonePolicy(policy);
    });
    const settled = result.catch(() => undefined);
    WRITE_QUEUES.set(filePath, settled);
    settled.then(() => {
      if (WRITE_QUEUES.get(filePath) === settled) WRITE_QUEUES.delete(filePath);
    });
    return result;
  }

  return Object.freeze({ load, save });
}

function canonicalTime(value) {
  if (typeof value !== 'string') throw invalidPlan();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw invalidPlan();
  return parsed.valueOf();
}

function snapshotOrderNewest(left, right) {
  const time = canonicalTime(right.createdAt) - canonicalTime(left.createdAt);
  return time || right.snapshotId.localeCompare(left.snapshotId);
}

function snapshotOrderOldest(left, right) {
  const time = canonicalTime(left.createdAt) - canonicalTime(right.createdAt);
  return time || left.snapshotId.localeCompare(right.snapshotId);
}

function normalizeSnapshots(inventory) {
  if (!plainObject(inventory) || !plainObject(inventory.summary)
    || !Number.isSafeInteger(inventory.summary.snapshotBytes) || inventory.summary.snapshotBytes < 0
    || !Array.isArray(inventory.snapshots)) throw invalidPlan();
  const seen = new Set();
  const output = [];
  for (const item of inventory.snapshots) {
    if (item?.status !== 'ready') continue;
    if (!plainObject(item)
      || typeof item.snapshotId !== 'string' || item.snapshotId === '' || seen.has(item.snapshotId)
      || typeof item.sessionId !== 'string' || item.sessionId === ''
      || !Number.isSafeInteger(item.totalBytes) || item.totalBytes < 0
      || typeof item.active !== 'boolean') throw invalidPlan();
    canonicalTime(item.createdAt);
    seen.add(item.snapshotId);
    output.push({
      snapshotId: item.snapshotId,
      sessionId: item.sessionId,
      createdAt: item.createdAt,
      totalBytes: item.totalBytes,
      active: item.active,
    });
  }
  return output;
}

function normalizeTrashRecords(records) {
  if (!(records instanceof Map)) throw invalidPlan();
  const output = [];
  for (const [key, value] of records) {
    if (!plainObject(value) || typeof value.sessionId !== 'string' || value.sessionId !== key
      || !['trashed', 'degraded', 'purge-pending'].includes(value.state)
      || !Number.isSafeInteger(value.snapshotBytes) || value.snapshotBytes < 0) throw invalidPlan();
    canonicalTime(value.trashedAt);
    output.push({
      sessionId: value.sessionId,
      state: value.state,
      trashedAt: value.trashedAt,
      snapshotId: typeof value.snapshotId === 'string' ? value.snapshotId : null,
      snapshotBytes: value.snapshotBytes,
    });
  }
  return output;
}

export function planRetention({ inventory, trashRecords, policy: inputPolicy, now = new Date() }) {
  const policy = normalizeRetentionPolicy(inputPolicy);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw invalidPlan();
  const snapshots = normalizeSnapshots(inventory);
  const trash = normalizeTrashRecords(trashRecords);
  const candidates = [];
  const selectedSnapshots = new Set();
  const trustedSnapshotBytes = snapshots.reduce((total, item) => total + item.totalBytes, 0);
  let projectedSnapshotBytes = trustedSnapshotBytes;

  const addSnapshot = (item, reason) => {
    if (item.active || selectedSnapshots.has(item.snapshotId)) return;
    selectedSnapshots.add(item.snapshotId);
    projectedSnapshotBytes = Math.max(0, projectedSnapshotBytes - item.totalBytes);
    candidates.push({
      key: `snapshot:${item.snapshotId}`,
      action: 'delete-snapshot',
      reason,
      snapshotId: item.snapshotId,
      sessionId: item.sessionId,
      createdAt: item.createdAt,
      bytes: item.totalBytes,
    });
  };

  const bySession = new Map();
  for (const item of snapshots) {
    if (item.active) continue;
    const current = bySession.get(item.sessionId) ?? [];
    current.push(item);
    bySession.set(item.sessionId, current);
  }
  for (const sessionId of [...bySession.keys()].sort()) {
    const history = bySession.get(sessionId).sort(snapshotOrderNewest);
    for (const item of history.slice(policy.historicalSnapshotsPerSession)) addSnapshot(item, 'history-count');
  }

  if (policy.historicalSnapshotMaxAgeDays !== null) {
    const cutoff = now.valueOf() - policy.historicalSnapshotMaxAgeDays * DAY_MS;
    for (const item of snapshots.filter((row) => !row.active && !selectedSnapshots.has(row.snapshotId)).sort(snapshotOrderOldest)) {
      if (canonicalTime(item.createdAt) <= cutoff) addSnapshot(item, 'snapshot-age');
    }
  }

  if (policy.snapshotQuotaBytes !== null && projectedSnapshotBytes > policy.snapshotQuotaBytes) {
    for (const item of snapshots.filter((row) => !row.active && !selectedSnapshots.has(row.snapshotId)).sort(snapshotOrderOldest)) {
      if (projectedSnapshotBytes <= policy.snapshotQuotaBytes) break;
      addSnapshot(item, 'snapshot-quota');
    }
  }

  if (policy.recycleMaxAgeDays !== null) {
    const cutoff = now.valueOf() - policy.recycleMaxAgeDays * DAY_MS;
    const eligible = trash
      .filter((record) => ['trashed', 'degraded'].includes(record.state) && canonicalTime(record.trashedAt) <= cutoff)
      .sort((left, right) => canonicalTime(left.trashedAt) - canonicalTime(right.trashedAt)
        || left.sessionId.localeCompare(right.sessionId));
    for (const record of eligible) {
      candidates.push({
        key: `trash:${record.sessionId}`,
        action: 'purge-trash',
        reason: 'recycle-age',
        sessionId: record.sessionId,
        state: record.state,
        trashedAt: record.trashedAt,
        snapshotId: record.snapshotId,
        bytes: record.snapshotBytes,
      });
    }
  }

  const fingerprint = createHash('sha256').update(JSON.stringify({ policy, candidates })).digest('hex');
  return { policy, candidates, projectedSnapshotBytes, fingerprint };
}
