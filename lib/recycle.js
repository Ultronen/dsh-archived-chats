import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createLegacyPendingStore } from './trash.js';

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

function attachmentReference(value) {
  return {
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...(Object.hasOwn(value, 'name') ? { name: value.name } : {}),
    ...(Object.hasOwn(value, 'originalDimensions') ? { originalDimensions: structuredClone(value.originalDimensions) } : {}),
  };
}

function sameAttachmentReference(left, right) {
  return JSON.stringify(attachmentReference(left)) === JSON.stringify(attachmentReference(right));
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
    if (header === undefined) return restoreSnapshot(id, record);
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

  async function restoreSnapshot(id, record) {
    if (typeof snapshotStore.validate !== 'function') throw error('snapshot-restore-unsupported', 'snapshot validation is unavailable', 501);
    const checked = await snapshotStore.validate(record.snapshotId);
    const meta = checked?.record?.source?.meta;
    const events = checked?.record?.source?.events;
    if (String(checked?.manifest?.sessionId) !== id || String(meta?.id) !== id || !Array.isArray(events)) {
      throw error('snapshot-schema-invalid', 'snapshot identity is invalid', 400);
    }
    if ((await persistence.list()).some((item) => String(item?.id) === id)) throw error('id-conflict', 'session id already exists', 409);
    if (typeof persistence.create !== 'function' || typeof persistence.append !== 'function' || typeof persistence.locate !== 'function') {
      throw error('snapshot-restore-unsupported', 'persistence restore capability is unavailable', 501);
    }
    const location = persistence.locate(meta);
    if (typeof location?.path !== 'string' || basename(dirname(location.path)) !== id) {
      throw error('snapshot-restore-unsupported', 'persistence rollback location is unavailable', 501);
    }
    if ((checked.attachments?.length ?? 0) > 0 && typeof attachments?.saveImage !== 'function') {
      throw error('snapshot-restore-unsupported', 'attachment restore capability is unavailable', 501);
    }

    const originalArchiveIds = [...(registry.archivedSessionIds ?? []).map(String)];
    const originalMetadata = await metadataStore.getMany([id]);
    if (originalMetadata?.status !== 'ready') throw error('metadata-store-unavailable', 'metadata store is unavailable', 503);
    const workspace = record.workspace?.id === null || record.workspace?.id === undefined
      ? null
      : (registry.list?.() ?? []).find((item) => String(item.id) === String(record.workspace.id)) ?? null;
    const originallyAttached = workspace !== null && sessionIds(workspace).includes(id);
    let created = false;
    let attached = false;
    let metadataChanged = false;
    let registryChanged = false;
    let trashRemoved = false;
    const warnings = [];
    const rollbackErrors = [];

    try {
      for (const item of checked.attachments ?? []) {
        const descriptor = attachmentReference(item.descriptor);
        const restored = await attachments.saveImage({
          data: item.data,
          mediaType: descriptor.mediaType,
          ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
        });
        if (!sameAttachmentReference(restored, descriptor)) {
          throw error('snapshot-attachment-identity-mismatch', 'restored attachment identity does not match', 409);
        }
      }

      await persistence.create(structuredClone(meta));
      created = true;
      for (let offset = 0; offset < events.length; offset += 500) {
        await persistence.append(id, structuredClone(events.slice(offset, offset + 500)));
      }

      if (workspace === null && record.workspace?.id !== null && record.workspace?.id !== undefined) {
        warnings.push({ id, reason: 'workspace-unresolved' });
      } else if (workspace !== null && !originallyAttached) {
        if (typeof workspace.attachSession !== 'function' || typeof workspace.detachSession !== 'function') {
          warnings.push({ id, reason: 'workspace-unresolved' });
        } else {
          await workspace.attachSession(id);
          attached = true;
        }
      }

      if (originalMetadata.entries?.[id] === undefined && (record.tags.length > 0 || record.note !== '')) {
        await metadataStore.set(id, { tags: record.tags, note: record.note });
        metadataChanged = true;
      }

      if (record.wasArchived && !originalArchiveIds.includes(id)) {
        if (typeof registry.setState !== 'function' || registry.state === undefined) throw error('snapshot-restore-unsupported', 'archive writer is unavailable', 501);
        await registry.setState({ ...registry.state, archivedSessionIds: [...originalArchiveIds, id] });
        registryChanged = true;
      }

      const removed = await trashStore.remove(id);
      if (!removed.includes(id)) throw error('trash-state-conflict', 'trash record changed during restore', 409);
      trashRemoved = true;
      invalidate?.([id]);
      return warnings;
    } catch (cause) {
      if (trashRemoved) {
        try { await trashStore.put(record); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (registryChanged) {
        try { await registry.setState({ ...registry.state, archivedSessionIds: originalArchiveIds }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (metadataChanged) {
        try {
          const prior = originalMetadata.entries?.[id];
          if (prior === undefined) await metadataStore.remove([id]);
          else await metadataStore.set(id, { tags: prior.tags, note: prior.note });
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (attached) {
        try { await workspace.detachSession(id); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (created) {
        try {
          if (typeof persistence.removeSession === 'function') await persistence.removeSession(id);
          else await rm(dirname(location.path), { recursive: true, force: true });
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length > 0) {
        throw error('snapshot-restore-rollback-failed', 'snapshot restore rollback failed', 500, { cause: stableCode(rollbackErrors[0]) });
      }
      throw cause;
    }
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

  async function purgeOne(id, expected) {
    return lifecycle.run(async () => {
      const records = await loadedTrash();
      let record = records.get(id);
      if (record === undefined) throw error('trash-record-missing', 'trash record is missing', 404);
      if (expected !== undefined && (record.state !== expected.state
        || record.trashedAt !== expected.trashedAt
        || record.snapshotId !== expected.snapshotId
        || record.snapshotBytes !== expected.bytes)) {
        throw error('retention-candidate-stale', 'retention candidate changed', 409);
      }
      if (record.state !== 'purge-pending') {
        if (!['trashed', 'degraded'].includes(record.state)) throw error('trash-state-conflict', 'trash record cannot be purged', 409);
        record = await trashStore.transition(id, 'purge-pending', { purgeRequestedAt: now().toISOString() });
      }
      if (typeof purgePhysical !== 'function') throw error('purge-unsupported', 'physical purge is unavailable', 501);
      await purgePhysical(id, record);
      await snapshotStore.removeForSession(id);
      const removed = await trashStore.remove(id);
      if (!removed.includes(id)) throw error('trash-state-conflict', 'trash record changed during purge', 409);
      invalidate?.([id]);
      return id;
    });
  }

  async function purge(ids, options = {}) {
    const purged = [];
    const failed = [];
    for (const id of uniqueIds(ids)) {
      try { purged.push(await purgeOne(id, options.expected?.sessionId === id ? options.expected : undefined)); }
      catch (cause) { failed.push(failure(id, cause)); }
    }
    return { purged, failed };
  }

  async function empty() {
    const records = await loadedTrash();
    return purge([...records.values()]
      .filter((record) => ['trashed', 'degraded'].includes(record.state))
      .map((record) => record.sessionId));
  }

  async function recoverStartup({ legacyPendingPath } = {}) {
    const snapshotRecovery = await snapshotStore.recover();
    const records = await loadedTrash();
    const validSnapshots = new Set((snapshotRecovery.valid ?? []).map((item) => item.snapshotId));
    for (const record of records.values()) {
      if (record.state === 'purge-pending') continue;
      if (record.snapshotId === null || !validSnapshots.has(record.snapshotId)) {
        await trashStore.markDegraded(record.sessionId, { snapshotId: record.snapshotId });
      }
    }
    const refreshed = await loadedTrash();
    for (const record of refreshed.values()) {
      if (record.state !== 'purge-pending') continue;
      try { await purgeOne(record.sessionId); }
      catch (cause) { logger?.warn?.(`archived-chats: recycle purge recovery failed for ${record.sessionId}: ${stableCode(cause)}`); }
    }

    if (typeof legacyPendingPath === 'string' && legacyPendingPath !== '') {
      const legacy = createLegacyPendingStore({ path: legacyPendingPath });
      const pending = await legacy.load();
      if (pending.status !== 'ready') return { status: 'legacy-pending-unavailable' };
      for (const id of pending.ids) {
        if (!(registry.archivedSessionIds ?? []).map(String).includes(id)) {
          await legacy.remove([id]);
          continue;
        }
        if ((await trashStore.get(id)) !== null) {
          await legacy.remove([id]);
          continue;
        }
        try {
          await moveOne(id);
          await legacy.remove([id]);
        } catch (cause) {
          logger?.warn?.(`archived-chats: pending migration failed for ${id}: ${stableCode(cause)}`);
        }
      }
    }
    return { status: 'ready' };
  }

  return Object.freeze({ move, restore, purge, empty, recoverStartup, list, summary });
}
