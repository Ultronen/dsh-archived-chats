import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';
import { planRetention } from './retention.js';

export class RetentionServiceError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'RetentionServiceError';
    this.code = code;
    this.status = status;
  }
}

const serviceError = (code, message, status) => new RetentionServiceError(code, message, status);
const stableCode = (error, fallback = 'retention-apply-failed') => (
  typeof error?.code === 'string' && error.code !== '' ? error.code : fallback
);

function nonceDigest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function sameNonce(value, expected) {
  const actual = nonceDigest(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function randomToken(randomBytes) {
  const bytes = randomBytes(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw serviceError('retention-token-unavailable', 'retention token generation failed', 500);
  }
  return Buffer.from(bytes).toString('base64url');
}

function readyTrash(value) {
  if (value?.status !== 'ready' || !(value.records instanceof Map)) {
    throw serviceError('retention-authority-unavailable', 'retention authority is unavailable', 503);
  }
  return value.records;
}

function readyPolicy(value) {
  if (value?.status !== 'ready') {
    throw serviceError('retention-store-unavailable', 'retention store is unavailable', 503);
  }
  return value.policy;
}

function uniqueKeys(value) {
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string' || key === '')) {
    throw serviceError('retention-selection-invalid', 'retention selection is invalid', 400);
  }
  return [...new Set(value)];
}

export function createRetentionService({
  insightsService,
  retentionStore,
  trashStore,
  snapshotStore,
  recycleService,
  lifecycle,
  now = () => new Date(),
  randomBytes = cryptoRandomBytes,
  tokenTtlMs = 5 * 60 * 1000,
}) {
  if (typeof insightsService?.inspect !== 'function' || typeof insightsService?.invalidate !== 'function'
    || typeof retentionStore?.load !== 'function' || typeof retentionStore?.save !== 'function'
    || typeof trashStore?.load !== 'function'
    || typeof snapshotStore?.inventory !== 'function' || typeof snapshotStore?.remove !== 'function'
    || typeof recycleService?.purge !== 'function' || typeof lifecycle?.run !== 'function'
    || typeof randomBytes !== 'function') {
    throw new TypeError('retention service dependencies are required');
  }

  const ttl = Number.isFinite(tokenTtlMs) && tokenTtlMs > 0 ? Math.floor(tokenTtlMs) : 5 * 60 * 1000;
  const tokens = new Map();

  function currentDate() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw serviceError('retention-clock-invalid', 'retention clock is invalid', 500);
    }
    return value;
  }

  function pruneTokens(at) {
    for (const [token, entry] of tokens) if (entry.expiresAtMs <= at) tokens.delete(token);
    while (tokens.size >= 128) tokens.delete(tokens.keys().next().value);
  }

  async function planCurrent() {
    const [insights, loadedPolicy, loadedTrash] = await Promise.all([
      insightsService.inspect(),
      retentionStore.load(),
      trashStore.load(),
    ]);
    const policy = readyPolicy(loadedPolicy);
    const trashRecords = readyTrash(loadedTrash);
    return { insights, plan: planRetention({ inventory: insights, trashRecords, policy, now: currentDate() }) };
  }

  async function get() {
    const { insights, plan } = await planCurrent();
    return {
      policy: structuredClone(plan.policy),
      insights,
      candidateSummary: {
        snapshotCount: plan.candidates.filter((item) => item.action === 'delete-snapshot').length,
        recycleCount: plan.candidates.filter((item) => item.action === 'purge-trash').length,
        projectedSnapshotBytes: plan.projectedSnapshotBytes,
      },
    };
  }

  async function savePolicy(input) {
    const saved = await retentionStore.save(input);
    insightsService.invalidate();
    return structuredClone(saved);
  }

  async function preview() {
    const createdAt = currentDate();
    pruneTokens(createdAt.valueOf());
    const { plan } = await planCurrent();
    const token = randomToken(randomBytes);
    const nonce = randomToken(randomBytes);
    const expiresAtMs = createdAt.valueOf() + ttl;
    const candidates = structuredClone(plan.candidates);
    tokens.set(token, {
      nonceDigest: nonceDigest(nonce),
      expiresAtMs,
      fingerprint: plan.fingerprint,
      candidates,
    });
    return {
      token,
      nonce,
      expiresAt: new Date(expiresAtMs).toISOString(),
      fingerprint: plan.fingerprint,
      policy: structuredClone(plan.policy),
      candidates,
      projectedSnapshotBytes: plan.projectedSnapshotBytes,
    };
  }

  function consumeToken({ token, nonce, keys }) {
    if (typeof token !== 'string' || token === '' || typeof nonce !== 'string' || nonce === '') {
      throw serviceError('retention-token-invalid', 'retention token is invalid', 400);
    }
    const entry = tokens.get(token);
    if (entry === undefined) throw serviceError('retention-token-invalid', 'retention token is invalid', 400);
    if (entry.expiresAtMs <= currentDate().valueOf()) {
      tokens.delete(token);
      throw serviceError('retention-token-expired', 'retention token expired', 409);
    }
    if (!sameNonce(nonce, entry.nonceDigest)) throw serviceError('retention-token-invalid', 'retention token is invalid', 400);
    const selectedKeys = uniqueKeys(keys);
    const byKey = new Map(entry.candidates.map((candidate) => [candidate.key, candidate]));
    if (selectedKeys.some((key) => !byKey.has(key))) {
      throw serviceError('retention-selection-invalid', 'retention selection is invalid', 400);
    }
    tokens.delete(token);
    return selectedKeys.map((key) => structuredClone(byKey.get(key)));
  }

  async function applySnapshot(candidate) {
    const records = readyTrash(await trashStore.load());
    for (const record of records.values()) {
      if (record?.snapshotId === candidate.snapshotId) {
        throw serviceError('retention-candidate-stale', 'retention candidate changed', 409);
      }
    }
    const inventory = await snapshotStore.inventory();
    if (!Array.isArray(inventory?.valid)) throw serviceError('retention-authority-unavailable', 'retention authority is unavailable', 503);
    const current = inventory.valid.find((item) => item?.snapshotId === candidate.snapshotId);
    if (current === undefined
      || current.sessionId !== candidate.sessionId
      || current.createdAt !== candidate.createdAt
      || current.totalBytes !== candidate.bytes) {
      throw serviceError('retention-candidate-stale', 'retention candidate changed', 409);
    }
    await snapshotStore.remove(candidate.snapshotId);
  }

  async function applyTrash(candidate) {
    const records = readyTrash(await trashStore.load());
    const record = records.get(candidate.sessionId);
    if (record === undefined || !['trashed', 'degraded'].includes(record.state)
      || record.trashedAt !== candidate.trashedAt) {
      throw serviceError('retention-candidate-stale', 'retention candidate changed', 409);
    }
    const result = await recycleService.purge([candidate.sessionId]);
    if (!Array.isArray(result?.purged) || !result.purged.includes(candidate.sessionId)) {
      const reason = result?.failed?.find((item) => item?.id === candidate.sessionId)?.reason;
      throw serviceError(typeof reason === 'string' ? reason : 'retention-purge-failed', 'retention purge failed', 409);
    }
  }

  async function apply(input) {
    const candidates = consumeToken(input ?? {});
    const applied = [];
    const failed = [];
    for (const candidate of candidates) {
      try {
        await lifecycle.run(async () => {
          if (candidate.action === 'delete-snapshot') await applySnapshot(candidate);
          else if (candidate.action === 'purge-trash') await applyTrash(candidate);
          else throw serviceError('retention-candidate-invalid', 'retention candidate is invalid', 400);
        });
        applied.push({ key: candidate.key, action: candidate.action });
        insightsService.invalidate();
      } catch (error) {
        failed.push({ key: candidate.key, reason: stableCode(error) });
      }
    }
    let insights = null;
    try { insights = await insightsService.inspect(); } catch { /* Keep ordered apply results available. */ }
    return { applied, failed, insights };
  }

  return Object.freeze({ get, savePolicy, preview, apply });
}
