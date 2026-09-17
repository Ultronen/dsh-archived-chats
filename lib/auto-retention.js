import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { normalizeRetentionPolicy, planRetention, RetentionError } from './retention.js';

const DAY_MS = 86400000;
const emptyInventory = { summary: { snapshotBytes: 0 }, snapshots: [] };
const fail = (code, status = 409) => new RetentionError(code, code, status);
const samePolicy = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const needsConfirmation = (before, after) => after.recycleAutoDelete
  && (!before.recycleAutoDelete || after.recycleMaxAgeDays < before.recycleMaxAgeDays);

/** Policy confirmation and automatic cleanup share the recycle lifecycle lock. */
export function createAutoRetention({ retentionStore, trashStore, recycleService, lifecycle,
  invalidate, now = () => new Date(), randomBytes = cryptoRandomBytes, tokenTtlMs = 300000 }) {
  const confirmations = new Map();
  let running = null;
  function clock() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw fail('retention-clock-invalid', 500);
    return value;
  }
  async function policy() {
    const loaded = await retentionStore.load();
    if (loaded.status !== 'ready') throw fail('retention-store-unavailable', 503);
    return normalizeRetentionPolicy(loaded.policy);
  }
  async function records() {
    const loaded = await trashStore.load();
    if (loaded.status !== 'ready' || !(loaded.records instanceof Map)) throw fail('retention-authority-unavailable', 503);
    return loaded.records;
  }
  function plan(proposed, trashRecords) {
    return planRetention({ inventory: emptyInventory, trashRecords, policy: proposed, now: clock() });
  }
  async function previewPolicy(input) {
    const proposed = normalizeRetentionPolicy(input);
    return lifecycle.run(async () => {
      const before = await policy();
      const trash = await records();
      const planned = plan(proposed, trash);
      const confirmationRequired = needsConfirmation(before, proposed);
      const candidates = proposed.recycleAutoDelete ? planned.candidates.map((candidate) => ({
        ...candidate, title: trash.get(candidate.sessionId)?.title ?? null,
      })) : [];
      if (!confirmationRequired) return { policy: proposed, confirmationRequired, candidates };
      const at = clock().valueOf();
      for (const [key, entry] of confirmations) if (entry.expiresAt <= at) confirmations.delete(key);
      while (confirmations.size >= 128) confirmations.delete(confirmations.keys().next().value);
      const token = Buffer.from(randomBytes(32)).toString('base64url');
      const nonce = Buffer.from(randomBytes(32)).toString('base64url');
      const expiresAt = at + tokenTtlMs;
      confirmations.set(token, { nonce, expiresAt, before, proposed, fingerprint: planned.fingerprint });
      return { policy: proposed, confirmationRequired, candidates, token, nonce, expiresAt: new Date(expiresAt).toISOString() };
    });
  }
  async function savePolicy(input, confirmation) {
    const proposed = normalizeRetentionPolicy(input);
    return lifecycle.run(async () => {
      const before = await policy();
      if (confirmation != null || needsConfirmation(before, proposed)) {
        if (confirmation == null) throw fail('retention-confirmation-required');
        const entry = confirmations.get(confirmation.token);
        if (!entry || typeof confirmation.nonce !== 'string' || confirmation.nonce !== entry.nonce) {
          throw fail('retention-confirmation-invalid');
        }
        confirmations.delete(confirmation.token);
        if (entry.expiresAt <= clock().valueOf()) throw fail('retention-confirmation-expired');
        if (!samePolicy(entry.before, before) || !samePolicy(entry.proposed, proposed)
          || entry.fingerprint !== plan(proposed, await records()).fingerprint) throw fail('retention-confirmation-stale');
      }
      const saved = await retentionStore.save(proposed);
      invalidate?.();
      return structuredClone(saved);
    });
  }
  async function scan({ isStopped = () => false } = {}) {
    const result = { purged: [], failed: [] };
    if (isStopped()) return result;
    const current = await policy();
    const trash = await records();
    const planned = plan(current, trash);
    // A pending record already carries durable, irreversible delete intent.
    // Complete it even if the user has since disabled new automatic deletions.
    const pending = [...trash.values()].filter((record) => record.state === 'purge-pending')
      .map((record) => ({ sessionId: record.sessionId, state: record.state, trashedAt: record.trashedAt,
        snapshotId: record.snapshotId, bytes: record.snapshotBytes }));
    const candidates = [...pending, ...(current.recycleAutoDelete ? planned.candidates : [])];
    for (const candidate of candidates) {
      if (isStopped()) break;
      const outcome = await recycleService.purge([candidate.sessionId], {
        expected: candidate,
        beforePurge: async (record) => {
          if (isStopped()) throw fail('retention-stopped');
          if (record.state === 'purge-pending') return;
          const latest = await policy();
          if (isStopped()) throw fail('retention-stopped');
          if (!latest.recycleAutoDelete || Date.parse(record.trashedAt) > clock().valueOf() - latest.recycleMaxAgeDays * DAY_MS) {
            throw fail('retention-candidate-stale');
          }
        },
      });
      result.purged.push(...outcome.purged);
      result.failed.push(...outcome.failed);
    }
    if (result.purged.length) invalidate?.();
    return result;
  }
  function runAutomatic(options) {
    if (running) return running;
    running = scan(options).finally(() => { running = null; });
    return running;
  }
  return Object.freeze({ previewPolicy, savePolicy, runAutomatic });
}

/** Start after recovery, then check once a minute without overlapping work. */
export function startRetentionScheduler({ recover, run, report = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 60000 }) {
  let stopped = false;
  let recovered = false;
  let timer;
  const tick = async () => {
    try {
      if (stopped) return;
      if (!recovered) { await recover(); recovered = true; }
      if (stopped) return;
      const result = await run({ isStopped: () => stopped });
      if (result?.failed?.length) report('retention-cleanup-incomplete', result.failed.length);
    } catch (error) { report(error?.code ?? 'retention-cleanup-failed'); }
    finally {
      if (!stopped) { timer = setTimer(tick, intervalMs); timer?.unref?.(); }
    }
  };
  void tick();
  return () => { stopped = true; if (timer !== undefined) clearTimer(timer); };
}
