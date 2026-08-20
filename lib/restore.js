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

function resolveUndo(persistence, result, id) {
  if (typeof result === 'function') return result;
  if (typeof result?.undo === 'function') return result.undo.bind(result);
  const remove = persistence.removeSession ?? persistence.deleteSession ?? persistence.remove;
  if (typeof remove === 'function') return () => remove.call(persistence, id);
  return async () => {};
}

function workspaceFor(registry, workspaceId) {
  if (workspaceId === null || workspaceId === undefined) return null;
  return registry.list?.().find((workspace) => String(workspace.id) === String(workspaceId)) ?? null;
}

function warningFor(item) {
  const warnings = [];
  if (item.workspace?.id !== null && item.workspace?.id !== undefined && item.workspace?.id !== '') {
    // The exact workspace warning is decided at commit time when the registry is available.
  } else warnings.push({ id: item.id, reason: 'workspace-unresolved' });
  return warnings;
}

/**
 * Build a restore adapter around explicit host writer capabilities. This module
 * never constructs Harness session-log files; it only calls a writer exposed by
 * the running host and brackets it with reversible registry/metadata changes.
 */
export function createRestoreAdapter({ ctx, persistence, registry, metadataStore, tempRoot }) {
  const writer = resolveWriter(persistence);
  const capability = writer === null
    ? { supported: false, reason: 'writer-missing' }
    : { supported: true };

  async function prepare(records, { knownIds = new Set() } = {}) {
    if (!capability.supported) throw unsupported(capability.reason);
    const items = Array.isArray(records) ? records : [];
    const ids = items.map((item) => String(item.id));
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) throw Object.assign(new Error(`duplicate restore id ${duplicate}`), { code: 'restore-duplicate' });
    if (ids.some((id) => knownIds.has(id))) throw Object.assign(new Error('restore records contain an ID conflict'), { code: 'id-conflict' });
    const root = tempRoot ?? join(process.env.DSH_HOME ?? '/tmp', 'plugin-data', 'archived-chats', 'imports');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(root, 'restore-'));
    const originalArchiveIds = (registry.archivedSessionIds ?? registry.state?.archivedSessionIds ?? []).map(String);
    const originalMetadata = await metadataStore.getMany(ids);
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
        if (!items.some((candidate) => candidate.id === item?.id)) throw Object.assign(new Error('record was not prepared'), { code: 'restore-record-unknown' });
        if (staged.some((candidate) => candidate.id === item.id)) return;
        if (!item?.record?.source || item.record?.format !== 'dsh-archived-chats/session') throw Object.assign(new Error('invalid restore record'), { code: 'restore-record-invalid' });
        const path = join(staging, `${staged.length}-${encodeURIComponent(item.id)}.json`);
        await writeFile(path, `${JSON.stringify(item.record)}\n`, { encoding: 'utf8', mode: 0o600 });
        if (typeof persistence.inspect === 'function') {
          // The host inspection is a capability check only; it does not replace
          // the staged record or mutate any existing session.
          await Promise.resolve(persistence.inspect(item.id, { staged: item.record }));
        }
        staged.push(item);
      },
      async rollback() {
        const rollbackErrors = [];
        for (const undo of transaction._undos?.slice().reverse() ?? []) {
          try { await undo(); } catch (error) { rollbackErrors.push(error); }
        }
        for (const undo of transaction._workspaceUndos?.slice().reverse() ?? []) {
          try { await undo(); } catch (error) { rollbackErrors.push(error); }
        }
        try {
          if (typeof registry.setState === 'function' && registry.state !== undefined) {
            await registry.setState({ ...registry.state, archivedSessionIds: originalArchiveIds });
          }
        } catch (error) { rollbackErrors.push(error); }
        for (const item of staged.slice().reverse()) {
          try {
            const previous = originalMetadata.entries?.[item.id];
            if (previous === undefined) await metadataStore.remove([item.id]);
            else await metadataStore.set(item.id, { tags: previous.tags, note: previous.note });
          } catch (error) { rollbackErrors.push(error); }
        }
        try { await cleanup(); } catch (error) { rollbackErrors.push(error); }
        if (rollbackErrors.length > 0) throw Object.assign(new Error('restore rollback failed'), { code: 'restore-rollback-failed', cause: rollbackErrors[0] });
      },
      async commit() {
        if (committed) throw Object.assign(new Error('restore transaction already committed'), { code: 'restore-replayed' });
        if (staged.length === 0) throw Object.assign(new Error('no staged records'), { code: 'nothing-to-restore' });
        transaction._undos = [];
        transaction._workspaceUndos = [];
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
            const result = await writer(payload);
            transaction._undos.push(resolveUndo(persistence, result, item.id));
            const workspace = workspaceFor(registry, item.workspace?.id);
            if (workspace === null) {
              warnings.push(...warningFor(item));
            } else if (typeof workspace.attachSession === 'function') {
              await workspace.attachSession(item.id);
              if (typeof workspace.detachSession === 'function') transaction._workspaceUndos.push(() => workspace.detachSession(item.id));
            }
            if (item.hasAttachmentReferences) warnings.push({ id: item.id, reason: 'attachments-not-included' });
            await metadataStore.set(item.id, { tags: item.tags, note: item.note });
            restored.push(item.id);
          }
          if (typeof registry.setState !== 'function' || registry.state === undefined) throw Object.assign(new Error('archive registry writer is unavailable'), { code: 'restore-unsupported' });
          const current = registry.archivedSessionIds.map(String);
          await registry.setState({ ...registry.state, archivedSessionIds: [...current, ...restored] });
          committed = true;
          await cleanup();
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
