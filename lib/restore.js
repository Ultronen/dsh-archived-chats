import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveExclusiveSessionDirectory } from './deletion-safety.js';

/** Bound each persistence append without changing event order or payloads. */
const APPEND_BATCH = 500;
const TITLE_PUBLICATION_TIMEOUT_MS = 1000;
const TITLE_PUBLICATION_POLL_MS = 20;

function unsupported(reason = 'writer-missing') {
  const error = new Error('restore is unsupported by this Harness host');
  error.code = 'restore-unsupported';
  error.reason = reason;
  return error;
}

/**
 * Prefer explicitly adapted modern handles. Dedicated restoration and the
 * an explicitly exclusive legacy create/append/locate surface remain fallbacks.
 */
function resolveWriter(persistence) {
  if (typeof persistence?.createWriteHandle === 'function' && typeof persistence?.locate === 'function') {
    return { kind: 'handle', write: (payload, registerUndo) => handleWrite(persistence, payload, registerUndo) };
  }
  if (typeof persistence?.restoreSession === 'function') return { kind: 'native', write: (payload, registerUndo) => dedicatedWrite(persistence.restoreSession.bind(persistence), payload, registerUndo) };
  if (typeof persistence?.restore === 'function') return { kind: 'native', write: (payload, registerUndo) => dedicatedWrite(persistence.restore.bind(persistence), payload, registerUndo) };
  if (typeof persistence?.importSession === 'function') return { kind: 'native', write: (payload, registerUndo) => dedicatedWrite(persistence.importSession.bind(persistence), payload, registerUndo) };
  if (typeof persistence?.createExclusive === 'function'
    && typeof persistence?.append === 'function'
    && typeof persistence?.locate === 'function') {
    return { kind: 'append', write: (payload, registerUndo) => appendWrite(persistence, payload, registerUndo) };
  }
  return null;
}

function confirmedConflict(error) {
  return error?.code === 'id-conflict' || error?.code === 'SESSION_ALREADY_EXISTS';
}

async function dedicatedWrite(write, payload, registerUndo) {
  const uncertain = async () => { throw new Error('dedicated restore creation outcome is uncertain; destination retained'); };
  registerUndo(uncertain);
  let result;
  try { result = await write(payload); }
  catch (error) {
    if (confirmedConflict(error)) registerUndo(() => undefined);
    throw error;
  }
  const undo = resolveUndo(result, null);
  if (undo === null) throw unsupported('rollback-ownership-missing');
  registerUndo(undo);
  return result;
}

/** Restore through the modern Host, keeping ownership until transaction commit. */
async function handleWrite(persistence, payload, registerUndo) {
  const { meta, events } = payload;
  const inheritedEventCount = payload.inheritedEventCount ?? (meta.isSeeded === false ? 0 : undefined);
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0
    || inheritedEventCount > events.length || (!meta.isSeeded && inheritedEventCount !== 0)) {
    throw unsupported('inherited-boundary-missing');
  }
  const location = await persistence.locate(meta);
  if (typeof location?.path !== 'string' || !isAbsolute(location.path)
    || !payload.id || ['.', '..'].includes(payload.id)
    || basename(dirname(location.path)) !== payload.id) throw unsupported('rollback-location-missing');
  const directory = dirname(location.path);
  try {
    await lstat(directory);
    throw Object.assign(new Error('restore destination already exists'), { code: 'id-conflict', status: 409 });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  // A failed create (including a concurrent ID conflict) never grants deletion
  // authority. Register compensation only after this caller owns a new handle.
  const handle = await persistence.createWriteHandle(structuredClone(meta), { inheritedEventCount });
  let materialized = false;
  let closing;
  const close = () => closing ??= Promise.resolve().then(() => handle.close());
  const undo = async () => {
    let closeError;
    try { await close(); } catch (error) { closeError = error; }
    if (materialized) {
      const owned = await resolveExclusiveSessionDirectory(persistence, payload.id);
      if (owned.status !== 'present') throw new Error('owned restore destination cannot be verified');
      await rm(owned.sessionDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    else {
      // The Host can publish and then reject a durability barrier, or another
      // process may have won creation. Its public handle cannot distinguish
      // these cases. Preserve uncertain artifacts and report incomplete undo.
      try {
        await lstat(directory);
        throw new Error('restore left an uncertain destination; retained for inspection');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (closeError) throw closeError;
  };
  registerUndo(undo);
  if (handle?.id !== payload.id || handle?.access !== 'write'
    || typeof handle.append !== 'function' || typeof handle.flush !== 'function'
    || typeof handle.read !== 'function' || typeof handle.close !== 'function') throw unsupported('write-handle-invalid');
  for (let offset = 0; offset < events.length; offset += APPEND_BATCH) {
    await handle.append(structuredClone(events.slice(offset, offset + APPEND_BATCH)));
    materialized = true;
  }
  await handle.flush();
  materialized = true;
  // Read through the Host validator before publishing an apparently restored
  // archive. A successfully appended but unreplayable log is not a backup.
  const checked = await handle.read(0, undefined);
  if (!Array.isArray(checked?.events) || !isDeepStrictEqual(checked.events, events)
    || !isDeepStrictEqual(handle.header, meta)
    || handle.inheritedEventCount !== inheritedEventCount) throw unsupported('restored-log-invalid');
  return { undo, finish: close };
}

/**
 * Write one session through exclusive create + append and return its scoped undo.
 * The destination is confirmed to be session-scoped before anything is created,
 * so the fallback rollback can never delete more than this session.
 */
async function appendWrite(persistence, payload, registerUndo) {
  const meta = structuredClone(payload.meta);
  const location = await persistence.locate(meta);
  if (typeof location?.path !== 'string' || !isAbsolute(location.path)
    || basename(dirname(location.path)) !== String(payload.id)) {
    throw unsupported('rollback-location-missing');
  }
  const directory = dirname(location.path);
  const before = await resolveExclusiveSessionDirectory(persistence, payload.id);
  if (before.status !== 'missing') throw Object.assign(new Error('restore destination already exists'), { code: 'id-conflict', status: 409 });
  const parent = await realpath(dirname(directory));
  const canonicalDestination = join(parent, basename(directory));
  try {
    await lstat(canonicalDestination);
    throw Object.assign(new Error('restore destination already exists'), { code: 'id-conflict', status: 409 });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const uncertain = async () => { throw new Error('legacy exclusive creation outcome is uncertain; destination retained'); };
  registerUndo(uncertain);
  try { await persistence.createExclusive(meta); }
  catch (error) {
    if (confirmedConflict(error)) registerUndo(() => undefined);
    throw error;
  }
  const owned = await resolveExclusiveSessionDirectory(persistence, payload.id);
  if (owned.status !== 'present' || owned.sessionDirectory !== canonicalDestination) {
    throw unsupported('rollback-location-missing');
  }
  const undo = async () => {
    const current = await resolveExclusiveSessionDirectory(persistence, payload.id);
    if (current.status === 'missing') return;
    if (current.sessionDirectory !== owned.sessionDirectory) throw new Error('owned restore destination changed');
    await rm(current.sessionDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  registerUndo(undo);
  const events = payload.events;
  for (let offset = 0; offset < events.length; offset += APPEND_BATCH) {
    await persistence.append(payload.id, structuredClone(events.slice(offset, offset + APPEND_BATCH)));
  }
  return undo;
}

function resolveUndo(result, fallback) {
  if (typeof result === 'function') return result;
  if (typeof result?.undo === 'function') return result.undo.bind(result);
  return fallback;
}

function workspaceFor(registry, workspaceId) {
  if (workspaceId === null || workspaceId === undefined) return null;
  return registry.list?.().find((workspace) => String(workspace.id) === String(workspaceId)) ?? null;
}

function warningFor(item) {
  return [{ id: item.id, reason: 'workspace-unresolved' }];
}

function workspaceSessionIds(workspace) {
  if (Array.isArray(workspace?.sessionIds)) return workspace.sessionIds.map(String);
  if (workspace?.sessionIds instanceof Set) return [...workspace.sessionIds].map(String);
  return [];
}

function loggedTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title;
  }
  return undefined;
}

function publicationWarning(id, detail) {
  return { id, reason: 'title-publication-degraded', detail };
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Ask the optional public Host cache to fold restored cold logs, then observe
 * the exact title through its synchronous public read surface. One deadline is
 * shared by the batch so large imports do not multiply the timeout.
 */
async function publishColdTitles(ctx, staged, timeoutMs) {
  const candidates = staged.map((item) => {
    const source = item.record.source;
    return {
      id: item.id,
      meta: source.meta,
      events: source.events,
      inheritedEventCount: source.inheritedEventCount ?? 0,
      title: loggedTitle(source.events),
      asOfSeq: source.events.at(-1)?.seq ?? -1,
    };
  }).filter((item) => item.title !== undefined);
  if (candidates.length === 0) return [];

  let cache;
  try { cache = ctx?.get?.('sessionProjectionCache'); }
  catch { cache = undefined; }
  if (typeof cache?.coldSnapshot !== 'function' || typeof cache?.cachedSnapshot !== 'function') {
    return candidates.map((item) => publicationWarning(item.id, 'cache-unavailable'));
  }

  const warnings = [];
  const pending = new Map();
  for (const item of candidates) {
    let folded;
    try {
      folded = cache.coldSnapshot(item.meta, item.inheritedEventCount, item.events);
    } catch {
      warnings.push(publicationWarning(item.id, 'cold-fold-failed'));
      continue;
    }
    if (!Object.hasOwn(folded?.values ?? {}, 'title')) {
      warnings.push(publicationWarning(item.id, 'projection-missing'));
      continue;
    }
    if (folded.values.title !== item.title || folded.asOfSeq !== item.asOfSeq) {
      warnings.push(publicationWarning(item.id, 'fold-mismatch'));
      continue;
    }
    pending.set(item.id, item);
  }

  const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : TITLE_PUBLICATION_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  while (pending.size > 0) {
    for (const [id, item] of pending) {
      try {
        const observed = cache.cachedSnapshot(item.meta, item.inheritedEventCount, ['title']);
        if (observed?.values?.title === item.title && observed.asOfSeq === item.asOfSeq) {
          pending.delete(id);
          // The official cold list cannot supply a seeded record's inherited
          // cut to cachedSnapshot, so it deliberately omits all projections for
          // that row. The exact checkpoint is useful but is not sidebar-title
          // publication and must not be reported as fully synchronized.
          if (item.meta?.isSeeded === true) {
            warnings.push(publicationWarning(id, 'seeded-cold-list-unsupported'));
          }
        }
      } catch {
        warnings.push(publicationWarning(id, 'cache-read-failed'));
        pending.delete(id);
      }
    }
    if (pending.size === 0 || Date.now() >= deadline) break;
    await pause(Math.min(TITLE_PUBLICATION_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  for (const id of pending.keys()) warnings.push(publicationWarning(id, 'cache-timeout'));
  return warnings;
}

/**
 * Build a restore adapter around explicit host writer capabilities. This module
 * never constructs Harness session-log files; it only calls a writer exposed by
 * the running host and brackets it with reversible registry/metadata changes.
 */
export function createRestoreAdapter({ ctx, persistence, registry, metadataStore, tempRoot, titlePublicationTimeoutMs = TITLE_PUBLICATION_TIMEOUT_MS }) {
  const writer = resolveWriter(persistence);
  let capability = { supported: true };
  if (writer === null) {
    const ambiguousLegacy = typeof persistence?.create === 'function'
      && typeof persistence?.append === 'function' && typeof persistence?.locate === 'function';
    capability = { supported: false, reason: ambiguousLegacy ? 'exclusive-create-missing' : 'writer-missing' };
  }
  else if (typeof registry?.setState !== 'function' || registry.state === undefined) capability = { supported: false, reason: 'registry-writer-missing' };
  else if (typeof metadataStore?.getMany !== 'function' || typeof metadataStore?.set !== 'function' || typeof metadataStore?.remove !== 'function') capability = { supported: false, reason: 'metadata-writer-missing' };

  async function prepare(records, { knownIds = new Set() } = {}) {
    if (!capability.supported) throw unsupported(capability.reason);
    const items = Array.isArray(records) ? records : [];
    if (writer.kind !== 'handle' && items.some(item => item.record?.source?.inheritedEventCount > 0
      || item.record?.source?.meta?.isSeeded === true)) {
      throw unsupported('inherited-boundary-unsupported');
    }
    const ids = items.map((item) => String(item.id));
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) throw Object.assign(new Error(`duplicate restore id ${duplicate}`), { code: 'restore-duplicate' });
    if (ids.some((id) => knownIds.has(id))) throw Object.assign(new Error('restore records contain an ID conflict'), { code: 'id-conflict' });
    const root = tempRoot ?? join(process.env.DSH_HOME ?? '/tmp', 'plugin-data', 'archived-chats', 'imports');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const originalArchiveIds = (registry.archivedSessionIds ?? registry.state?.archivedSessionIds ?? []).map(String);
    const originalMetadata = await metadataStore.getMany(ids);
    if (originalMetadata?.status !== 'ready') throw Object.assign(new Error('restore metadata is unavailable'), { code: 'metadata-store-unavailable', status: 503 });
    const staging = await mkdtemp(join(root, 'restore-'));
    const staged = [];
    let committed = false;
    let cleaned = false;

    async function cleanup() {
      if (!cleaned) {
        cleaned = true;
        await rm(staging, { recursive: true, force: true });
      }
    }

    const transaction = {
      async stage(item) {
        try {
          if (!items.some((candidate) => candidate.id === item?.id)) throw Object.assign(new Error('record was not prepared'), { code: 'restore-record-unknown' });
          if (staged.some((candidate) => candidate.id === item.id)) return;
          if (!item?.record?.source || item.record?.format !== 'dsh-archived-chats/session'
            || item.record.source.meta?.id !== item.id || !Array.isArray(item.record.source.events)) {
            throw Object.assign(new Error('invalid restore record'), { code: 'restore-record-invalid' });
          }
          const path = join(staging, `${staged.length}-${encodeURIComponent(item.id)}.json`);
          await writeFile(path, `${JSON.stringify(item.record)}\n`, { encoding: 'utf8', mode: 0o600 });
          if (typeof persistence.inspect === 'function') {
            // The host inspection is a capability check only; it does not replace
            // the staged record or mutate any existing session. The id does not
            // exist yet, so a reader that fails closed on unknown sessions is the
            // expected answer and must not abort the restore.
            await Promise.resolve(persistence.inspect(item.id, { staged: item.record })).catch(() => undefined);
          }
          staged.push(item);
        } catch (error) {
          await cleanup().catch(() => undefined);
          throw error;
        }
      },
      async rollback() {
        const rollbackErrors = [];
        if (transaction._registryAttempted
          && JSON.stringify((registry.archivedSessionIds ?? registry.state?.archivedSessionIds ?? []).map(String)) !== JSON.stringify(originalArchiveIds)) {
          try { await registry.setState({ ...registry.state, archivedSessionIds: originalArchiveIds }); }
          catch (error) { rollbackErrors.push(error); }
        }
        for (const id of transaction._metadataTouched?.slice().reverse() ?? []) {
          try {
            const previous = originalMetadata.entries?.[id];
            if (previous === undefined) await metadataStore.remove([id]);
            else await metadataStore.set(id, { tags: previous.tags, note: previous.note });
          } catch (error) { rollbackErrors.push(error); }
        }
        for (const undo of transaction._workspaceUndos?.slice().reverse() ?? []) {
          try { await undo(); } catch (error) { rollbackErrors.push(error); }
        }
        for (const undo of transaction._undos?.slice().reverse() ?? []) {
          try { await undo(); } catch (error) { rollbackErrors.push(error); }
        }
        try { await cleanup(); } catch (error) { rollbackErrors.push(error); }
        if (rollbackErrors.length > 0) throw Object.assign(new Error('restore rollback failed'), { code: 'restore-rollback-failed', cause: rollbackErrors[0] });
      },
      async commit() {
        if (committed) throw Object.assign(new Error('restore transaction already committed'), { code: 'restore-replayed' });
        if (staged.length === 0) throw Object.assign(new Error('no staged records'), { code: 'nothing-to-restore' });
        transaction._undos = [];
        transaction._workspaceUndos = [];
        transaction._metadataTouched = [];
        transaction._registryAttempted = false;
        const finishWrites = [];
        const restored = [];
        const warnings = [];
        try {
          for (const item of staged) {
            const payload = {
              id: item.id,
              meta: item.record.source.meta,
              events: item.record.source.events,
              inheritedEventCount: item.record.source.inheritedEventCount,
              archive: item.record.archive,
            };
            const fallbackUndo = () => undefined;
            transaction._undos.push(fallbackUndo);
            const result = await writer.write(payload, (undo) => { transaction._undos[transaction._undos.length - 1] = undo; });
            const ownedUndo = resolveUndo(result, fallbackUndo);
            transaction._undos[transaction._undos.length - 1] = ownedUndo;
            if (typeof result?.finish === 'function') finishWrites.push(result.finish);
            const workspace = workspaceFor(registry, item.workspace?.id);
            if (workspace === null) {
              warnings.push(...warningFor(item));
            } else if (!workspaceSessionIds(workspace).includes(item.id)) {
              if (typeof workspace.attachSession !== 'function' || typeof workspace.detachSession !== 'function') {
                warnings.push(...warningFor(item));
              } else {
                transaction._workspaceUndos.push(() => workspaceSessionIds(workspace).includes(item.id)
                  ? workspace.detachSession(item.id)
                  : undefined);
                await workspace.attachSession(item.id);
              }
            }
            if (item.hasAttachmentReferences) warnings.push({ id: item.id, reason: 'attachments-not-included' });
            transaction._metadataTouched.push(item.id);
            await metadataStore.set(item.id, { tags: item.tags, note: item.note });
            restored.push(item.id);
          }
          const current = registry.archivedSessionIds.map(String);
          transaction._registryAttempted = true;
          await registry.setState({ ...registry.state, archivedSessionIds: [...current, ...restored] });
          for (const finish of finishWrites) await finish();
          await cleanup();
          committed = true;
        } catch (error) {
          try { await transaction.rollback(); }
          catch (rollbackError) { throw rollbackError; }
          throw error;
        }
        warnings.push(...await publishColdTitles(ctx, staged, titlePublicationTimeoutMs));
        return { restored, warnings };
      },
    };
    return transaction;
  }

  return { capability, prepare };
}
