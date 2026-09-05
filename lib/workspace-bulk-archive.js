import { createHmac, randomUUID } from 'node:crypto';

const CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_ELIGIBLE_SESSIONS = 2_000;

function failure(code, message, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

function unsupported() {
  return failure('workspace-archive-unsupported', 'workspace archive is unsupported by this Harness host', 501);
}

function asIds(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return [];
}

function isArchivedIdCollection(value) {
  return Array.isArray(value) || value instanceof Set;
}

function safeWorkspace(workspace) {
  return {
    id: String(workspace.id),
    title: typeof workspace.title === 'string' ? workspace.title : null,
  };
}

function safeSession(entry) {
  if (typeof entry === 'string' && entry !== '') return { id: entry, title: null, createdAt: null };
  if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '') {
    return {
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : null,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
    };
  }
  return null;
}

function stableNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw failure('workspace-archive-clock-unavailable', 'workspace archive clock is unavailable', 503);
  }
  return value;
}

export function createWorkspaceBulkArchiveService({ registry, sessions, historyService, lifecycle, now = () => new Date(), secret } = {}) {
  if (registry === null || typeof registry !== 'object'
    || typeof registry.list !== 'function' || typeof registry.archiveSession !== 'function'
    || !isArchivedIdCollection(registry.archivedSessionIds)
    || sessions === null || typeof sessions !== 'object' || typeof sessions.get !== 'function'
    || historyService === null || typeof historyService !== 'object' || typeof historyService.captureArchived !== 'function'
    || lifecycle === null || typeof lifecycle !== 'object' || typeof lifecycle.run !== 'function'
    || typeof now !== 'function' || (typeof secret !== 'string' && !Buffer.isBuffer(secret))
    || (typeof secret === 'string' && secret === '')) {
    throw unsupported();
  }

  let serial = 0;
  const confirmations = new Map();

  function workspaces() {
    const rows = registry.list.call(registry);
    if (!Array.isArray(rows)) throw unsupported();
    return rows.filter((workspace) => workspace !== null && typeof workspace === 'object'
      && workspace.id !== null && workspace.id !== undefined && String(workspace.id) !== '');
  }

  function archivedIds() {
    const values = registry.archivedSessionIds;
    if (!isArchivedIdCollection(values)) throw unsupported();
    return new Set([...values].map((id) => String(id)));
  }

  function sweepExpired(nowValue) {
    for (const [token, confirmation] of confirmations) {
      if (confirmation.expiresAt <= nowValue) confirmations.delete(token);
    }
  }

  function workspaceFor(id) {
    const requested = typeof id === 'string' && id !== '' ? id : null;
    if (requested === null) return null;
    return workspaces().find((workspace) => String(workspace.id) === requested) ?? null;
  }

  function snapshotCandidates(workspace) {
    const archived = archivedIds();
    const seen = new Set();
    const sessionsOutput = [];
    const skipped = [];
    for (const raw of asIds(workspace.sessionIds)) {
      const session = safeSession(raw);
      if (session === null || seen.has(session.id)) continue;
      seen.add(session.id);
      if (sessions.get(session.id) !== undefined) {
        skipped.push({ id: session.id, reason: 'session-live' });
      } else if (archived.has(session.id)) {
        skipped.push({ id: session.id, reason: 'session-archived' });
      } else {
        sessionsOutput.push(session);
      }
    }
    return { sessions: sessionsOutput, skipped };
  }

  function listWorkspaces() {
    return workspaces().map((workspace) => {
      const candidates = snapshotCandidates(workspace);
      return {
        ...safeWorkspace(workspace),
        eligibleCount: candidates.sessions.length,
        liveCount: candidates.skipped.filter((item) => item.reason === 'session-live').length,
      };
    });
  }

  async function preview(workspaceId) {
    const issuedAt = stableNow(now).valueOf();
    sweepExpired(issuedAt);
    const workspace = workspaceFor(workspaceId);
    if (workspace === null) throw failure('workspace-not-found', 'workspace was not found', 404);
    const captured = snapshotCandidates(workspace);
    if (captured.sessions.length > MAX_ELIGIBLE_SESSIONS) {
      throw failure('workspace-archive-too-many', 'workspace archive selection is too large', 400);
    }
    const expiresAt = issuedAt + CONFIRMATION_TTL_MS;
    const nonce = randomUUID();
    serial += 1;
    const token = createHmac('sha256', secret)
      .update(`${serial}:${nonce}:${expiresAt}`)
      .digest('base64url');
    const confirmation = {
      nonce,
      expiresAt,
      workspace: safeWorkspace(workspace),
      sessionIds: captured.sessions.map((session) => session.id),
    };
    confirmations.set(token, confirmation);
    return {
      token,
      nonce,
      expiresAt: new Date(expiresAt).toISOString(),
      workspace: { ...confirmation.workspace },
      sessions: captured.sessions.map((session) => ({ ...session })),
      skipped: captured.skipped.map((item) => ({ ...item })),
    };
  }

  async function execute(token, nonce) {
    const confirmation = typeof token === 'string' ? confirmations.get(token) : undefined;
    if (confirmation === undefined || typeof nonce !== 'string' || nonce !== confirmation.nonce) {
      throw failure('workspace-archive-confirmation-invalid', 'workspace archive confirmation is invalid', 409);
    }
    if (stableNow(now).valueOf() >= confirmation.expiresAt) {
      confirmations.delete(token);
      throw failure('workspace-archive-confirmation-expired', 'workspace archive confirmation has expired', 409);
    }
    confirmations.delete(token);

    const result = {
      workspace: { ...confirmation.workspace },
      archived: [],
      skipped: [],
      failed: [],
      snapshots: [],
    };
    for (const sessionId of confirmation.sessionIds) {
      const item = { archived: null, skipped: null, failed: null, snapshot: null };
      try {
        await lifecycle.run(async () => {
          const workspace = workspaceFor(confirmation.workspace.id);
          if (workspace === null || !asIds(workspace.sessionIds).some((entry) => safeSession(entry)?.id === sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-workspace-changed' };
            return;
          }
          if (sessions.get(sessionId) !== undefined) {
            item.skipped = { id: sessionId, reason: 'session-live' };
            return;
          }
          if (archivedIds().has(sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-archived' };
            return;
          }
          try {
            await registry.archiveSession.call(registry, sessionId);
          } catch {
            item.failed = { id: sessionId, reason: 'archive-failed' };
            return;
          }
          if (!archivedIds().has(sessionId)) {
            item.failed = { id: sessionId, reason: 'archive-uncommitted' };
            return;
          }
          item.archived = sessionId;
          try {
            await historyService.captureArchived(sessionId, { lockHeld: true });
            item.snapshot = { id: sessionId, status: 'captured' };
          } catch {
            item.snapshot = { id: sessionId, status: 'snapshot-failed' };
          }
        });
        if (item.archived !== null) {
          result.archived.push(item.archived);
          result.snapshots.push(item.snapshot);
        } else if (item.skipped !== null) result.skipped.push(item.skipped);
        else if (item.failed !== null) result.failed.push(item.failed);
        else result.failed.push({ id: sessionId, reason: 'lifecycle-failed' });
      } catch {
        result.failed.push({ id: sessionId, reason: 'lifecycle-failed' });
      }
    }
    return result;
  }

  return { listWorkspaces, preview, execute };
}
