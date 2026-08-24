export class RecycleError extends Error {
  constructor(code, message, status = 500, details = undefined) {
    super(message);
    this.name = 'RecycleError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const error = (code, message, status = 500, details) => new RecycleError(code, message, status, details);

function uniqueIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id !== ''))];
}

function stableCode(cause, fallback = 'recycle-failed') {
  return typeof cause?.code === 'string' && cause.code !== '' ? cause.code : fallback;
}

function sessionIds(workspace) {
  const ids = workspace?.sessionIds;
  if (Array.isArray(ids)) return ids.map(String);
  if (ids instanceof Set) return [...ids].map(String);
  return [];
}

function extractTitle(events) {
  let title = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
      title = event.data.title;
    }
  }
  return title;
}

function failure(id, cause) {
  if (cause instanceof RecycleError && cause.code === 'session-parked') {
    return { id, reason: 'session-parked', cause: cause.details?.cause ?? 'snapshot-failed' };
  }
  return { id, reason: stableCode(cause) };
}

export function createRecycleService({
  registry,
  persistence,
  attachments,
  metadataStore,
  trashStore,
  snapshotStore,
  lifecycle,
  disposeLive,
  purgePhysical,
  invalidate,
  logger,
  now = () => new Date(),
}) {
  if (typeof persistence?.list !== 'function') throw new TypeError('persistence.list is required');
  if (typeof trashStore?.load !== 'function' || typeof snapshotStore?.capture !== 'function') throw new TypeError('recycle stores are required');
  if (typeof lifecycle?.run !== 'function') throw new TypeError('lifecycle.run is required');
  void attachments;
  void purgePhysical;

  async function loadedTrash() {
    const loaded = await trashStore.load();
    if (loaded?.status !== 'ready') throw error('trash-store-unavailable', 'trash store is unavailable', 503);
    return loaded.records;
  }

  async function descriptor(id) {
    if (!(registry.archivedSessionIds ?? []).map(String).includes(id)) {
      throw error('session-not-archived', 'session is not archived', 404);
    }
    const records = await loadedTrash();
    if (records.has(id)) throw error('already-trashed', 'session is already in trash', 409);
    const headers = await persistence.list();
    const header = (Array.isArray(headers) ? headers : []).find((item) => String(item?.id) === id);
    if (header === undefined) throw error('session-location-unavailable', 'session is unavailable', 404);
    let title = typeof header.title === 'string' ? header.title : null;
    if (typeof persistence.inspect === 'function') {
      try { title = extractTitle((await persistence.inspect(id))?.events) ?? title; }
      catch { /* Snapshot capture returns the authoritative read failure later. */ }
    }
    const workspace = (registry.list?.() ?? []).find((item) => sessionIds(item).includes(id));
    const metadata = await metadataStore.getMany([id]);
    if (metadata?.status !== 'ready') throw error('metadata-store-unavailable', 'metadata store is unavailable', 503);
    const entry = metadata.entries?.[id];
    return {
      header,
      archive: {
        title,
        createdAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
        origin: typeof header.origin === 'string' ? header.origin : null,
        workspace: workspace === undefined ? null : {
          id: String(workspace.id),
          title: typeof workspace.title === 'string' ? workspace.title : null,
          path: typeof workspace.path === 'string' ? workspace.path : null,
        },
        wasArchived: true,
        tags: Array.isArray(entry?.tags) ? [...entry.tags] : [],
        note: typeof entry?.note === 'string' ? entry.note : '',
        metadataUpdatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
      },
    };
  }

  async function removeNewSnapshot(snapshotId, prior) {
    if (snapshotId === prior?.snapshotId) return;
    try { await snapshotStore.remove(snapshotId); }
    catch (cause) { logger?.warn?.(`archived-chats: recycle snapshot cleanup failed: ${stableCode(cause, 'snapshot-cleanup-failed')}`); }
  }

  async function moveOne(id) {
    return lifecycle.run(async () => {
      const source = await descriptor(id);
      const prior = await snapshotStore.latestFor(id);
      const disposed = typeof disposeLive === 'function' ? await disposeLive(id) : { disposition: 'cold' };
      const disposition = disposed?.disposition;
      if (!['cold', 'disposed', 'parked'].includes(disposition)) throw error('session-disposal-invalid', 'session disposition is invalid');
      if (!(registry.archivedSessionIds ?? []).map(String).includes(id) || (await loadedTrash()).has(id)) {
        throw error('operation-cancelled', 'archive ownership changed', 409);
      }
      let snapshot;
      try {
        snapshot = await snapshotStore.capture({ sessionId: id, archive: source.archive, liveDisposition: disposition });
      } catch (cause) {
        if (disposition === 'parked') throw error('session-parked', 'session is parked after snapshot failure', 409, { cause: stableCode(cause, 'snapshot-failed') });
        throw cause;
      }
      if (!(registry.archivedSessionIds ?? []).map(String).includes(id) || (await loadedTrash()).has(id)) {
        await removeNewSnapshot(snapshot.snapshotId, prior);
        throw error('operation-cancelled', 'archive ownership changed', 409);
      }
      const trashedAt = now().toISOString();
      const record = {
        sessionId: id,
        state: 'trashed',
        trashedAt,
        purgeRequestedAt: null,
        title: source.archive.title,
        createdAt: source.archive.createdAt,
        origin: source.archive.origin,
        workspace: source.archive.workspace,
        wasArchived: source.archive.wasArchived,
        tags: source.archive.tags,
        note: source.archive.note,
        metadataUpdatedAt: source.archive.metadataUpdatedAt,
        snapshotId: snapshot.snapshotId,
        snapshotBytes: snapshot.bytes,
        snapshotAttachmentCount: snapshot.attachmentCount,
        liveDisposition: disposition,
      };
      try { await trashStore.put(record); }
      catch (cause) {
        await removeNewSnapshot(snapshot.snapshotId, prior);
        throw cause;
      }
      if (prior !== null && prior.snapshotId !== snapshot.snapshotId) {
        try { await snapshotStore.remove(prior.snapshotId); }
        catch (cause) { logger?.warn?.(`archived-chats: old snapshot cleanup failed: ${stableCode(cause, 'snapshot-cleanup-failed')}`); }
      }
      invalidate?.([id]);
      return id;
    });
  }

  async function move(ids) {
    const trashed = [];
    const failed = [];
    for (const id of uniqueIds(ids)) {
      try { trashed.push(await moveOne(id)); }
      catch (cause) { failed.push(failure(id, cause)); }
    }
    return { trashed, failed };
  }

  async function restoreOriginal(id, record) {
    const headers = await persistence.list();
    const header = (Array.isArray(headers) ? headers : []).find((item) => String(item?.id) === id);
    if (header === undefined) throw error('snapshot-restore-required', 'original session is missing', 501);
    if (record.workspace?.path !== null && record.workspace?.path !== undefined
      && typeof header.cwd === 'string' && header.cwd !== record.workspace.path) {
      throw error('id-conflict', 'session identity conflicts with recycle record', 409);
    }
    const metadata = await metadataStore.getMany([id]);
    if (metadata?.status !== 'ready') throw error('metadata-store-unavailable', 'metadata store is unavailable', 503);
    await trashStore.remove(id);
    const warnings = [];
    if (record.wasArchived && !(registry.archivedSessionIds ?? []).map(String).includes(id)) {
      if (typeof registry.setState !== 'function' || registry.state === undefined) throw error('restore-unsupported', 'archive writer is unavailable', 501);
      await registry.setState({ ...registry.state, archivedSessionIds: [...registry.archivedSessionIds.map(String), id] });
    }
    if (record.workspace?.id !== null && record.workspace?.id !== undefined) {
      const workspace = (registry.list?.() ?? []).find((item) => String(item.id) === String(record.workspace.id));
      if (workspace === undefined) warnings.push({ id, reason: 'workspace-unresolved' });
      else if (!sessionIds(workspace).includes(id) && typeof workspace.attachSession === 'function') await workspace.attachSession(id);
    }
    if (metadata.entries?.[id] === undefined && (record.tags.length > 0 || record.note !== '')) {
      await metadataStore.set(id, { tags: record.tags, note: record.note });
    }
    invalidate?.([id]);
    return warnings;
  }

  async function restore(ids) {
    const restored = [];
    const failed = [];
    const warnings = [];
    for (const id of uniqueIds(ids)) {
      try {
        const itemWarnings = await lifecycle.run(async () => {
          const records = await loadedTrash();
          const record = records.get(id);
          if (record === undefined) throw error('trash-record-missing', 'trash record is missing', 404);
          if (record.state === 'purge-pending') throw error('trash-state-conflict', 'purge-pending record cannot be restored', 409);
          return restoreOriginal(id, record);
        });
        restored.push(id);
        warnings.push(...itemWarnings);
      } catch (cause) { failed.push(failure(id, cause)); }
    }
    return { restored, failed, warnings };
  }

  async function list() {
    await loadedTrash();
    return trashStore.list();
  }

  async function summary() {
    await loadedTrash();
    return trashStore.summary();
  }

  return Object.freeze({ move, restore, list, summary });
}
