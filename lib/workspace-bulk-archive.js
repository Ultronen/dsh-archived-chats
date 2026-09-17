import { createHmac, randomUUID } from 'node:crypto';

const CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_ELIGIBLE_SESSIONS = 2_000;
const CONVERSATION_CHECK_CONCURRENCY = 8;

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

export function createWorkspaceBulkArchiveService({ registry, sessions, agents, inspectConversation, lifecycle, now = () => new Date(), secret } = {}) {
  if (registry === null || typeof registry !== 'object'
    || typeof registry.list !== 'function' || typeof registry.archiveSession !== 'function'
    || !isArchivedIdCollection(registry.archivedSessionIds)
    || sessions === null || typeof sessions !== 'object' || typeof sessions.get !== 'function'
    || typeof inspectConversation !== 'function'
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

  function isSessionBusy(sessionId) {
    // A loaded session survives navigation. Only an idle agent proves that
    // its task has stopped; keep the conservative fallback for older hosts.
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent !== undefined) return agent.status !== 'idle';
    return sessions.get(sessionId) !== undefined;
  }

  async function conversationStatus(sessionId) {
    try {
      const inspected = await inspectConversation(sessionId);
      if (inspected === null || typeof inspected !== 'object' || typeof inspected.hasConversation !== 'boolean') {
        return { status: 'unavailable' };
      }
      return inspected.hasConversation
        ? {
            status: 'present',
            title: typeof inspected.title === 'string' ? inspected.title : null,
            createdAt: Number.isFinite(inspected.createdAt) ? inspected.createdAt : null,
          }
        : { status: 'empty' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async function snapshotCandidates(workspace) {
    const archived = archivedIds();
    const seen = new Set();
    const candidates = [];
    for (const raw of asIds(workspace.sessionIds)) {
      const session = safeSession(raw);
      if (session === null || seen.has(session.id)) continue;
      seen.add(session.id);
      candidates.push(session);
    }
    const classified = new Array(candidates.length);
    let nextIndex = 0;
    const classify = async () => {
      while (nextIndex < candidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        const session = candidates[index];
        if (isSessionBusy(session.id)) {
          classified[index] = { skipped: { id: session.id, reason: 'session-live' } };
          continue;
        }
        if (archived.has(session.id)) {
          classified[index] = { skipped: { id: session.id, reason: 'session-archived' } };
          continue;
        }
        const inspection = await conversationStatus(session.id);
        classified[index] = inspection.status === 'present'
          ? { session: {
              ...session,
              title: inspection.title ?? session.title,
              createdAt: inspection.createdAt ?? session.createdAt,
            } }
          : { skipped: { id: session.id, reason: inspection.status === 'empty' ? 'session-empty' : 'session-unavailable' } };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONVERSATION_CHECK_CONCURRENCY, candidates.length) }, classify));
    const sessionsOutput = [];
    const skipped = [];
    for (const item of classified) {
      if (item.session !== undefined) sessionsOutput.push(item.session);
      else skipped.push(item.skipped);
    }
    return { sessions: sessionsOutput, skipped };
  }

  async function listWorkspaces() {
    const output = [];
    for (const workspace of workspaces()) {
      const candidates = await snapshotCandidates(workspace);
      output.push({
        ...safeWorkspace(workspace),
        eligibleCount: candidates.sessions.length,
        liveCount: candidates.skipped.filter((item) => item.reason === 'session-live').length,
      });
    }
    return output;
  }

  async function preview(workspaceId) {
    const issuedAt = stableNow(now).valueOf();
    sweepExpired(issuedAt);
    const workspace = workspaceFor(workspaceId);
    if (workspace === null) throw failure('workspace-not-found', 'workspace was not found', 404);
    const captured = await snapshotCandidates(workspace);
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
      const item = { archived: null, skipped: null, failed: null };
      try {
        await lifecycle.run(async () => {
          const workspace = workspaceFor(confirmation.workspace.id);
          if (workspace === null || !asIds(workspace.sessionIds).some((entry) => safeSession(entry)?.id === sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-workspace-changed' };
            return;
          }
          if (isSessionBusy(sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-live' };
            return;
          }
          if (archivedIds().has(sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-archived' };
            return;
          }
          const inspection = await conversationStatus(sessionId);
          if (inspection.status !== 'present') {
            item.skipped = { id: sessionId, reason: inspection.status === 'empty' ? 'session-empty' : 'session-unavailable' };
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
        });
        if (item.archived !== null) {
          result.archived.push(item.archived);
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
