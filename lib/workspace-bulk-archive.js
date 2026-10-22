import { createHmac, randomUUID } from 'node:crypto';
import { normalizeSessionId } from './session-graph.js';

const CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_ELIGIBLE_SESSIONS = 2_000;
const CONVERSATION_CHECK_CONCURRENCY = 8;
const UNGROUPED_WORKSPACE_ID = '__dac_ungrouped__';

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
    ...(workspace.ungrouped === true ? { ungrouped: true } : {}),
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

export function createWorkspaceBulkArchiveService({ registry, sessions, agents, inspectConversation, listSessionHeaders, getActivity, lifecycle, now = () => new Date(), secret } = {}) {
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

  async function candidateWorkspaces() {
    if (typeof listSessionHeaders !== 'function') return workspaces();
    const headers = await listSessionHeaders();
    if (!Array.isArray(headers) || headers.some(header => safeSession(header) === null)) {
      throw failure('session-inventory-unavailable', 'official session inventory is unavailable', 503);
    }
    // Match the Host sidebar: registered membership first, remaining top-level
    // sessions in Ungrouped. Never infer ownership from a stale cwd or title.
    const groups = workspaces();
    const owned = new Set(groups.flatMap(group => asIds(group.sessionIds).map(row => safeSession(row)?.id)));
    const ungrouped = headers.filter(header => header.origin !== 'subagent' && !owned.has(header.id));
    if (ungrouped.length > 0) groups.push({ id: UNGROUPED_WORKSPACE_ID, title: null, ungrouped: true, sessionIds: ungrouped });
    return groups;
  }

  async function workspaceFor(id) {
    const requested = typeof id === 'string' && id !== '' ? id : null;
    if (requested === null) return null;
    const groups = requested === UNGROUPED_WORKSPACE_ID ? await candidateWorkspaces() : workspaces();
    return groups.find((workspace) => String(workspace.id) === requested) ?? null;
  }

  async function isSessionBusy(sessionId) {
    if (typeof getActivity === 'function') {
      const activity = await getActivity(sessionId);
      if (!Array.isArray(activity)) throw failure('workspace-activity-unavailable', 'official activity state is unavailable', 503);
      return activity.length > 0;
    }
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

  async function snapshotCandidates(workspace, includeActive = false) {
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
        if (!includeActive && await isSessionBusy(session.id)) {
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
              ...(includeActive ? { busy: await isSessionBusy(session.id) } : {}),
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
    for (const workspace of await candidateWorkspaces()) {
      const candidates = await snapshotCandidates(workspace);
      if (candidates.sessions.length === 0) continue;
      output.push({
        ...safeWorkspace(workspace),
        eligibleCount: candidates.sessions.length,
        liveCount: candidates.skipped.filter((item) => item.reason === 'session-live').length,
      });
    }
    return output;
  }

  async function listSessions({ targetIds = null, excludedIds = [] } = {}) {
    const targets = targetIds === null ? null : new Set([...targetIds].map(normalizeSessionId));
    const excluded = new Set([...excludedIds].map(normalizeSessionId));
    const rows = [];
    const seen = new Set();
    for (const workspace of await candidateWorkspaces()) {
      const archived = archivedIds();
      for (const raw of asIds(workspace.sessionIds)) {
        const session = safeSession(raw);
        if (!session || seen.has(session.id) || archived.has(session.id)) continue;
        const id = normalizeSessionId(session.id);
        if ((targets !== null && !targets.has(id)) || excluded.has(id)) continue;
        seen.add(session.id);
        const inspection = await conversationStatus(session.id);
        // Listing is not an eligibility filter: retain unreadable existing chats.
        // Only a verified empty draft is omitted; execution always checks again.
        if (inspection.status === 'empty') continue;
        rows.push({ ...session, title: inspection.title ?? session.title, createdAt: inspection.createdAt ?? session.createdAt,
          workspaceId: workspace.ungrouped === true ? null : String(workspace.id), workspaceTitle: safeWorkspace(workspace).title,
          busy: await isSessionBusy(session.id), archiveEligible: inspection.status === 'present' });
      }
    }
    return rows;
  }

  async function preview(workspaceId, selectedIds, { includeActive = false } = {}) {
    const issuedAt = stableNow(now).valueOf();
    sweepExpired(issuedAt);
    const workspace = await workspaceFor(workspaceId);
    if (workspace === null) throw failure('workspace-not-found', 'workspace was not found', 404);
    let captured = await snapshotCandidates(workspace, includeActive);
    if (selectedIds !== undefined) {
      const eligible = new Set(captured.sessions.map(row => row.id));
      if (!Array.isArray(selectedIds) || selectedIds.length === 0 || selectedIds.length > MAX_ELIGIBLE_SESSIONS
        || selectedIds.some(id => typeof id !== 'string' || !eligible.has(id))) {
        throw failure('workspace-archive-selection-changed', 'selection changed; refresh and select again', 409);
      }
      const selected = new Set(selectedIds);
      captured = { sessions: captured.sessions.filter(row => selected.has(row.id)), skipped: [] };
    }
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
      stopSessionIds: captured.sessions.filter(session => session.busy === true).map(session => session.id),
    };
    confirmations.set(token, confirmation);
    return {
      token,
      nonce,
      expiresAt: new Date(expiresAt).toISOString(),
      workspace: { ...confirmation.workspace },
      stopSessionIds: [...confirmation.stopSessionIds],
      sessions: captured.sessions.map((session) => ({ ...session })),
      skipped: captured.skipped.map((item) => ({ ...item })),
    };
  }

  async function execute(token, nonce, { stopActivity = false } = {}) {
    const confirmation = typeof token === 'string' ? confirmations.get(token) : undefined;
    if (confirmation === undefined || typeof nonce !== 'string' || nonce !== confirmation.nonce) {
      throw failure('workspace-archive-confirmation-invalid', 'workspace archive confirmation is invalid', 409);
    }
    if (stableNow(now).valueOf() >= confirmation.expiresAt) {
      confirmations.delete(token);
      throw failure('workspace-archive-confirmation-expired', 'workspace archive confirmation has expired', 409);
    }
    if (confirmation.stopSessionIds.length > 0 && !stopActivity) {
      throw failure('workspace-archive-stop-confirmation-required', 'confirm stopping active work before archiving', 409);
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
      const stopConfirmed = stopActivity && confirmation.stopSessionIds.includes(sessionId);
      try {
        await lifecycle.run(async () => {
          const workspace = await workspaceFor(confirmation.workspace.id);
          if (workspace === null || !asIds(workspace.sessionIds).some((entry) => safeSession(entry)?.id === sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-workspace-changed' };
            return;
          }
          if (!stopConfirmed && await isSessionBusy(sessionId)) {
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
          // Inspection yields to the Host; membership and task status may have
          // changed while the log was being read. Recheck before committing.
          const currentWorkspace = await workspaceFor(confirmation.workspace.id);
          if (currentWorkspace === null || !asIds(currentWorkspace.sessionIds).some(entry => safeSession(entry)?.id === sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-workspace-changed' };
            return;
          }
          if (!stopConfirmed && await isSessionBusy(sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-live' };
            return;
          }
          if (archivedIds().has(sessionId)) {
            item.skipped = { id: sessionId, reason: 'session-archived' };
            return;
          }
          // Current official Host exposes this helper alongside archiveSession's
          // stopActivity option. Never emulate cancellation on older hosts.
          if (stopConfirmed && typeof registry.stopSessionActivity !== 'function') {
            item.failed = { id: sessionId, reason: 'stop-archive-unsupported' };
            return;
          }
          try {
            await registry.archiveSession.call(registry, sessionId, ...(stopConfirmed ? [{ stopActivity: true }] : []));
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

  return { listWorkspaces, listSessions, preview, execute };
}
