import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Events appended per call, matching the History restore writer. */
const APPEND_BATCH = 500;

function unsupported(reason = 'writer-missing') {
  const error = new Error('restore is unsupported by this Harness host');
  error.code = 'restore-unsupported';
  error.reason = reason;
  return error;
}

/**
 * Resolve a session writer. A host that exposes a dedicated restore entry point
 * is preferred; otherwise the ordinary create/append/locate surface is used —
 * the same capability History "restore as copy" and recycle snapshot restore
 * already write through, so ZIP import works wherever those work instead of
 * reporting `restore-unsupported` on the very same host.
 */
function resolveWriter(persistence) {
  if (typeof persistence?.restoreSession === 'function') return { kind: 'native', write: persistence.restoreSession.bind(persistence) };
  if (typeof persistence?.restore === 'function') return { kind: 'native', write: persistence.restore.bind(persistence) };
  if (typeof persistence?.importSession === 'function') return { kind: 'native', write: persistence.importSession.bind(persistence) };
  if (typeof persistence?.create === 'function'
    && typeof persistence?.append === 'function'
    && typeof persistence?.locate === 'function') {
    return { kind: 'append', write: (payload) => appendWrite(persistence, payload) };
  }
  return null;
}

/**
 * Write one session through create + append and return an undo that removes it.
 * The destination is confirmed to be session-scoped before anything is created,
 * so the fallback rollback can never delete more than this session.
 */
async function appendWrite(persistence, payload) {
  const meta = structuredClone(payload.meta);
  const location = await persistence.locate(meta);
  if (typeof location?.path !== 'string' || basename(dirname(location.path)) !== String(payload.id)) {
    throw unsupported('rollback-location-missing');
  }
  await persistence.create(meta);
  const events = payload.events;
  for (let offset = 0; offset < events.length; offset += APPEND_BATCH) {
    await persistence.append(payload.id, structuredClone(events.slice(offset, offset + APPEND_BATCH)));
  }
  return async () => {
    if (typeof persistence.removeSession === 'function') { await persistence.removeSession(payload.id); return; }
    await rm(dirname(location.path), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
}

function resolveRemove(persistence) {
  const remove = persistence?.removeSession ?? persistence?.deleteSession ?? persistence?.remove;
  return typeof remove === 'function' ? remove.bind(persistence) : null;
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

/**
 * Build a restore adapter around explicit host writer capabilities. This module
 * never constructs Harness session-log files; it only calls a writer exposed by
 * the running host and brackets it with reversible registry/metadata changes.
 */
export function createRestoreAdapter({ ctx, persistence, registry, metadataStore, tempRoot }) {
  const writer = resolveWriter(persistence);
  const remover = resolveRemove(persistence);
  let capability = { supported: true };
  if (writer === null) capability = { supported: false, reason: 'writer-missing' };
  // The append writer carries its own session-scoped rollback, so a dedicated
  // remover is only required for the native restore entry points.
  else if (remover === null && writer.kind !== 'append') capability = { supported: false, reason: 'rollback-missing' };
  else if (typeof registry?.setState !== 'function' || registry.state === undefined) capability = { supported: false, reason: 'registry-writer-missing' };
  else if (typeof metadataStore?.getMany !== 'function' || typeof metadataStore?.set !== 'function' || typeof metadataStore?.remove !== 'function') capability = { supported: false, reason: 'metadata-writer-missing' };

  async function prepare(records, { knownIds = new Set() } = {}) {
    if (!capability.supported) throw unsupported(capability.reason);
    const items = Array.isArray(records) ? records : [];
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
        const restored = [];
        const warnings = [];
        try {
          for (const item of staged) {
            const payload = {
              id: item.id,
              meta: item.record.source.meta,
              events: item.record.source.events,
              archive: item.record.archive,
            };
            const fallbackUndo = remover === null ? () => undefined : () => remover(item.id);
            transaction._undos.push(fallbackUndo);
            const result = await writer.write(payload);
            transaction._undos[transaction._undos.length - 1] = resolveUndo(result, fallbackUndo);
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
          await cleanup();
          committed = true;
          return { restored, warnings };
        } catch (error) {
          try { await transaction.rollback(); }
          catch (rollbackError) { throw rollbackError; }
          throw error;
        }
      },
    };
    return transaction;
  }

  return { capability, prepare };
}
