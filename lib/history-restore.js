import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const TOKEN_TTL_MS = 5 * 60 * 1000;

export class HistoryRestoreError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'HistoryRestoreError';
    this.code = code;
    this.status = status;
  }
}

const failure = (code, message, status = 500) => new HistoryRestoreError(code, message, status);

function digestManifest(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function sessionIds(workspace) {
  if (Array.isArray(workspace?.sessionIds)) return workspace.sessionIds.map(String);
  if (workspace?.sessionIds instanceof Set) return [...workspace.sessionIds].map(String);
  return [];
}

function attachmentReference(value) {
  return {
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(value?.originalDimensions !== undefined ? { originalDimensions: structuredClone(value.originalDimensions) } : {}),
  };
}

function compatibleAttachment(left, right) {
  return typeof right?.attachmentId === 'string' && right.attachmentId !== ''
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.width === right.width
    && left.height === right.height;
}

async function attachmentData(item) {
  const data = typeof item?.read === 'function' ? await item.read() : item?.data;
  if (!(data instanceof Uint8Array)) throw failure('history-snapshot-degraded', 'history attachment bytes are unavailable', 409);
  return data;
}

function rewriteAttachmentReferences(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => rewriteAttachmentReferences(item, replacements));
  if (value === null || typeof value !== 'object') return value;
  const pair = typeof value.attachmentId === 'string' ? replacements.get(value.attachmentId) : undefined;
  if (pair !== undefined && compatibleAttachment(pair.original, value)) {
    return { ...structuredClone(value), ...structuredClone(pair.replacement) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteAttachmentReferences(child, replacements)]));
}

function checkedSnapshot(value, snapshotId) {
  if (value?.manifest?.snapshotId !== snapshotId
    || typeof value.manifest.sessionId !== 'string' || value.manifest.sessionId === ''
    || typeof value.manifest.createdAt !== 'string'
    || value?.record?.source?.meta?.id !== value.manifest.sessionId
    || !Array.isArray(value?.record?.source?.events)
    || !Array.isArray(value?.attachments)) {
    throw failure('history-snapshot-degraded', 'history snapshot is invalid', 409);
  }
  return value;
}

export function createHistoryRestoreService({
  snapshotStore,
  persistence,
  attachments,
  registry,
  metadataStore,
  lifecycle,
  invalidate,
  logger,
  now = () => new Date(),
  uuid = randomUUID,
  secret = randomUUID,
}) {
  if (typeof snapshotStore?.validate !== 'function'
    || typeof persistence?.list !== 'function' || typeof registry?.list !== 'function'
    || typeof metadataStore?.getMany !== 'function' || typeof metadataStore?.set !== 'function'
    || typeof metadataStore?.remove !== 'function' || typeof lifecycle?.run !== 'function') {
    throw new TypeError('history restore dependencies are required');
  }

  const tokens = new Map();
  const capability = Object.freeze(typeof persistence.create === 'function'
    && typeof persistence.append === 'function'
    && typeof persistence.locate === 'function'
    && typeof registry.setState === 'function'
    ? { supported: true }
    : { supported: false, reason: 'writer-missing' });

  function instant() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw failure('history-restore-unavailable', 'history restore clock is unavailable', 503);
    return value;
  }

  function cleanExpired(time) {
    for (const [token, entry] of tokens) if (entry.expiresAtMs <= time) tokens.delete(token);
  }

  async function prepare(snapshotId) {
    if (!capability.supported) throw failure('history-restore-unsupported', 'history restore is unsupported by this Host', 501);
    if (typeof snapshotId !== 'string' || snapshotId === '') throw failure('history-snapshot-invalid', 'history snapshot id is required', 400);
    const checked = checkedSnapshot(await snapshotStore.validate(snapshotId), snapshotId);
    const destinationId = String(uuid());
    if (destinationId === '') throw failure('history-restore-unavailable', 'history destination identity is unavailable', 503);
    const known = new Set((await persistence.list()).map((item) => String(item?.id)));
    for (const id of registry.archivedSessionIds ?? registry.state?.archivedSessionIds ?? []) known.add(String(id));
    if (known.has(destinationId)) throw failure('history-restore-conflict', 'history destination already exists', 409);
    const workspaceId = checked.record.archive?.workspace?.id;
    const workspace = workspaceId === null || workspaceId === undefined
      ? null
      : registry.list().find((item) => String(item.id) === String(workspaceId)) ?? null;
    const warnings = workspaceId !== null && workspaceId !== undefined && workspace === null
      ? [{ id: destinationId, reason: 'workspace-unresolved' }]
      : [];
    const preparedAt = instant();
    cleanExpired(preparedAt.valueOf());
    const token = String(secret());
    const nonce = String(secret());
    if (token === '' || nonce === '' || tokens.has(token)) throw failure('history-restore-unavailable', 'history restore token is unavailable', 503);
    const entry = {
      token,
      nonce,
      snapshotId,
      sourceSessionId: checked.manifest.sessionId,
      sourceRevision: checked.manifest.sourceRevision ?? null,
      manifestDigest: digestManifest(checked.manifest),
      destinationId,
      expiresAtMs: preparedAt.valueOf() + TOKEN_TTL_MS,
    };
    tokens.set(token, entry);
    return {
      token,
      nonce,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      snapshot: {
        snapshotId,
        sourceSessionId: entry.sourceSessionId,
        createdAt: checked.manifest.createdAt,
        title: typeof checked.record.archive?.title === 'string' ? checked.record.archive.title : null,
        totalBytes: checked.manifest.totalBytes,
        attachmentCount: checked.manifest.attachments.length,
      },
      destination: { sessionId: destinationId, archived: true },
      warnings,
    };
  }

  function consume(token, nonce) {
    const entry = typeof token === 'string' ? tokens.get(token) : undefined;
    if (entry !== undefined) tokens.delete(token);
    const time = instant().valueOf();
    if (entry === undefined || typeof nonce !== 'string' || nonce !== entry.nonce || time >= entry.expiresAtMs) {
      throw failure('history-restore-expired', 'history restore confirmation expired', 410);
    }
    return entry;
  }

  async function rollbackCreated(persistenceLocation, destinationId) {
    if (typeof persistence.removeSession === 'function') {
      await persistence.removeSession(destinationId);
      return;
    }
    await rm(dirname(persistenceLocation.path), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  async function restore(token, nonce) {
    const entry = consume(token, nonce);
    return lifecycle.run(async () => {
      const checked = checkedSnapshot(await snapshotStore.validate(entry.snapshotId), entry.snapshotId);
      if (checked.manifest.sessionId !== entry.sourceSessionId
        || (checked.manifest.sourceRevision ?? null) !== entry.sourceRevision
        || digestManifest(checked.manifest) !== entry.manifestDigest) {
        throw failure('history-restore-stale', 'history snapshot changed after confirmation', 409);
      }
      const currentIds = new Set((await persistence.list()).map((item) => String(item?.id)));
      for (const id of registry.archivedSessionIds ?? registry.state?.archivedSessionIds ?? []) currentIds.add(String(id));
      if (currentIds.has(entry.destinationId)) throw failure('history-restore-conflict', 'history destination already exists', 409);
      const meta = structuredClone(checked.record.source.meta);
      meta.id = entry.destinationId;
      const location = await persistence.locate(meta);
      if (typeof location?.path !== 'string' || basename(dirname(location.path)) !== entry.destinationId) {
        throw failure('history-restore-unsupported', 'history restore rollback location is unavailable', 501);
      }
      if (checked.attachments.length > 0 && typeof attachments?.saveImage !== 'function') {
        throw failure('history-restore-unsupported', 'history attachment restore is unavailable', 501);
      }

      const originalArchiveIds = [...(registry.archivedSessionIds ?? registry.state?.archivedSessionIds ?? []).map(String)];
      const originalMetadata = await metadataStore.getMany([entry.destinationId]);
      if (originalMetadata?.status !== 'ready') throw failure('history-restore-unavailable', 'history metadata is unavailable', 503);
      const workspaceId = checked.record.archive?.workspace?.id;
      const workspace = workspaceId === null || workspaceId === undefined
        ? null
        : registry.list().find((item) => String(item.id) === String(workspaceId)) ?? null;
      const warnings = workspaceId !== null && workspaceId !== undefined && workspace === null
        ? [{ id: entry.destinationId, reason: 'workspace-unresolved' }]
        : [];
      let createAttempted = false;
      let attachmentAttempted = false;
      let metadataAttempted = false;
      let registryAttempted = false;
      const rollbackErrors = [];
      try {
        createAttempted = true;
        await persistence.create(meta);

        const replacements = new Map();
        for (const item of checked.attachments) {
          const original = attachmentReference(item.descriptor);
          const data = await attachmentData(item);
          const restored = await attachments.saveImage({
            data,
            mediaType: original.mediaType,
            ...(original.name === undefined ? {} : { name: original.name }),
          });
          if (!compatibleAttachment(original, restored)) {
            throw failure('history-attachment-identity-mismatch', 'history attachment identity does not match', 409);
          }
          replacements.set(original.attachmentId, { original, replacement: attachmentReference(restored) });
        }
        const events = rewriteAttachmentReferences(checked.record.source.events, replacements);
        for (let offset = 0; offset < events.length; offset += 500) {
          await persistence.append(entry.destinationId, events.slice(offset, offset + 500));
        }

        if (workspace !== null && !sessionIds(workspace).includes(entry.destinationId)) {
          if (typeof workspace.attachSession !== 'function' || typeof workspace.detachSession !== 'function') warnings.push({ id: entry.destinationId, reason: 'workspace-unresolved' });
          else {
            attachmentAttempted = true;
            await workspace.attachSession(entry.destinationId);
          }
        }
        const tags = Array.isArray(checked.record.archive?.tags) ? checked.record.archive.tags : [];
        const note = typeof checked.record.archive?.note === 'string' ? checked.record.archive.note : '';
        if (tags.length > 0 || note !== '') {
          metadataAttempted = true;
          await metadataStore.set(entry.destinationId, { tags, note });
        }
        registryAttempted = true;
        await registry.setState({ ...registry.state, archivedSessionIds: [...originalArchiveIds, entry.destinationId] });
        invalidate?.(entry.destinationId, entry.sourceSessionId);
        return {
          restored: [entry.destinationId],
          sourceSessionId: entry.sourceSessionId,
          snapshotId: entry.snapshotId,
          warnings,
        };
      } catch (cause) {
        if (registryAttempted
          && JSON.stringify((registry.archivedSessionIds ?? registry.state?.archivedSessionIds ?? []).map(String)) !== JSON.stringify(originalArchiveIds)) {
          try { await registry.setState({ ...registry.state, archivedSessionIds: originalArchiveIds }); }
          catch (error) { rollbackErrors.push(error); }
        }
        if (metadataAttempted) {
          try {
            const previous = originalMetadata.entries?.[entry.destinationId];
            if (previous === undefined) await metadataStore.remove([entry.destinationId]);
            else await metadataStore.set(entry.destinationId, { tags: previous.tags, note: previous.note });
          } catch (error) { rollbackErrors.push(error); }
        }
        if (attachmentAttempted && sessionIds(workspace).includes(entry.destinationId)) {
          try { await workspace.detachSession(entry.destinationId); }
          catch (error) { rollbackErrors.push(error); }
        }
        if (createAttempted) {
          try { await rollbackCreated(location, entry.destinationId); }
          catch (error) { rollbackErrors.push(error); }
        }
        if (rollbackErrors.length > 0) {
          logger?.warn?.(`archived-chats: history restore rollback failed for ${entry.destinationId}: ${String(rollbackErrors[0]?.code ?? rollbackErrors[0]?.name ?? 'rollback-failed')}`);
          throw failure('history-restore-rollback-failed', 'history restore rollback failed', 500);
        }
        throw cause;
      }
    });
  }

  return Object.freeze({ capability, prepare, restore });
}
