import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function unsupported(reason = 'writer-missing') {
  const error = new Error('restore is unsupported by this Harness host');
  error.code = 'restore-unsupported';
  error.reason = reason;
  return error;
}

function resolveWriter(persistence) {
  if (typeof persistence?.restoreSession === 'function') return persistence.restoreSession.bind(persistence);
  if (typeof persistence?.restore === 'function') return persistence.restore.bind(persistence);
  if (typeof persistence?.importSession === 'function') return persistence.importSession.bind(persistence);
  return null;
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
  else if (remover === null) capability = { supported: false, reason: 'rollback-missing' };
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
            // the staged record or mutate any existing session.
            await Promise.resolve(persistence.inspect(item.id, { staged: item.record }));
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
            const fallbackUndo = () => remover(item.id);
            transaction._undos.push(fallbackUndo);
            const result = await writer(payload);
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
