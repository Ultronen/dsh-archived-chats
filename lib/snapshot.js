import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { findProjectedImage, paginateProjectedMessages, projectArchivedMessages } from './search.js';
import { syncDirectory } from './durable.js';

export const SNAPSHOT_LIMITS = Object.freeze({
  maxManifestBytes: 4 * 1024 * 1024,
  maxSessionBytes: 64 * 1024 * 1024,
  maxAttachments: 1000,
  maxAttachmentBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRevisionAttempts: 3,
});

export const HISTORY_SNAPSHOT_LIMIT = 5000;

/**
 * Windows keeps a deleted directory entry alive while any handle is open (an
 * indexer or antivirus scan is enough), surfacing as EBUSY/EPERM/ENOTEMPTY.
 * Retrying is the documented remedy and is harmless elsewhere.
 */
const RM_RETRY = Object.freeze({ maxRetries: 5, retryDelay: 50 });

const SNAPSHOT_FORMAT = 'dsh-archived-chats/snapshot';
const SESSION_FORMAT = 'dsh-archived-chats/snapshot-session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const REQUIRED_REFERENCE_KEYS = ['attachmentId', 'mediaType', 'bytes', 'width', 'height'];
const OPTIONAL_REFERENCE_KEYS = ['name', 'originalDimensions'];
const REFERENCE_KEYS = [...REQUIRED_REFERENCE_KEYS, ...OPTIONAL_REFERENCE_KEYS];

export class SnapshotError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.status = status;
  }
}

function failure(code, message, status = 500) {
  return new SnapshotError(code, message, status);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUnsafeKey(value) {
  if (Array.isArray(value)) return value.some(hasUnsafeKey);
  if (!plainObject(value)) return false;
  return Object.keys(value).some((key) => UNSAFE_KEYS.has(key) || hasUnsafeKey(value[key]));
}

function cloneJson(value, label = 'value') {
  if (hasUnsafeKey(value)) throw failure('snapshot-schema-invalid', `${label} contains an unsafe key`);
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('not serializable');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw failure('snapshot-schema-invalid', `${label} is not JSON serializable`);
  }
}

function referenceFields(value) {
  return {
    ...Object.fromEntries(REQUIRED_REFERENCE_KEYS.map((key) => [key, value[key]])),
    ...(Object.hasOwn(value, 'name') ? { name: value.name } : {}),
    ...(Object.hasOwn(value, 'originalDimensions') ? {
      originalDimensions: {
        width: value.originalDimensions.width,
        height: value.originalDimensions.height,
      },
    } : {}),
  };
}

function normalizeReference(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => !REFERENCE_KEYS.includes(key))) {
    throw failure('snapshot-attachment-invalid', 'attachment descriptor is invalid');
  }
  if (!REQUIRED_REFERENCE_KEYS.every((key) => Object.hasOwn(value, key))
    || typeof value.attachmentId !== 'string' || value.attachmentId === ''
    || !IMAGE_MEDIA_TYPES.has(value.mediaType)
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || !Number.isSafeInteger(value.width) || value.width <= 0
    || !Number.isSafeInteger(value.height) || value.height <= 0
    || (Object.hasOwn(value, 'name') && typeof value.name !== 'string')
    || (Object.hasOwn(value, 'originalDimensions') && (
      !exactKeys(value.originalDimensions, ['width', 'height'])
      || !Number.isSafeInteger(value.originalDimensions.width) || value.originalDimensions.width <= 0
      || !Number.isSafeInteger(value.originalDimensions.height) || value.originalDimensions.height <= 0
    ))) {
    throw failure('snapshot-attachment-invalid', 'attachment descriptor is invalid');
  }
  return referenceFields(value);
}

function sameReference(left, right) {
  try {
    const a = normalizeReference(left);
    const b = normalizeReference(right);
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}

/** Return unique complete image descriptors in first-seen event order. */
export function collectImageReferences(events) {
  const references = [];
  const seen = new Map();
  const visited = new WeakSet();
  const visit = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);
    if (plainObject(value) && REQUIRED_REFERENCE_KEYS.every((key) => Object.hasOwn(value, key))) {
      const reference = normalizeReference(value);
      const prior = seen.get(reference.attachmentId);
      if (prior !== undefined && !sameReference(prior, reference)) {
        throw failure('snapshot-attachment-invalid', 'attachment identifiers have conflicting descriptors');
      }
      if (prior === undefined) {
        seen.set(reference.attachmentId, reference);
        references.push(reference);
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(Array.isArray(events) ? events : []);
  return references;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mediaExtension(mediaType) {
  const known = new Map([
    ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
    ['image/avif', 'avif'], ['image/bmp', 'bmp'], ['image/svg+xml', 'svg'], ['image/tiff', 'tiff'],
  ]);
  if (known.has(mediaType)) return known.get(mediaType);
  const subtype = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 16);
  return subtype || 'bin';
}

/**
 * Containment test that holds on both separators. `relative()` answers with the
 * platform separator, so a POSIX-only `'../'` check misses `'..\\'` on Windows;
 * an absolute answer means a different drive or root entirely.
 */
function isWithin(root, candidate) {
  const path = relative(root, candidate);
  if (path === '') return true;
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

function validSnapshotId(snapshotId) {
  if (typeof snapshotId !== 'string' || !UUID.test(snapshotId)) throw failure('snapshot-id-invalid', 'snapshot id is invalid', 400);
  return snapshotId;
}

function safeRelativePath(path, prefix) {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.includes('\0')
    || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw failure('snapshot-path-unsafe', 'snapshot path is unsafe');
  }
  if (prefix !== undefined && !path.startsWith(prefix)) throw failure('snapshot-path-unsafe', 'snapshot path is unsafe');
  return path;
}

async function writeSynced(path, data, openFile) {
  await writeFile(path, data, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  const handle = await openFile(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readBounded(path, limit, missingCode = 'snapshot-missing') {
  let details;
  try { details = await stat(path); } catch (error) {
    if (error?.code === 'ENOENT') throw failure(missingCode, 'snapshot file is missing', 404);
    throw error;
  }
  if (!details.isFile()) throw failure('snapshot-path-unsafe', 'snapshot path is not a file');
  if (details.size > limit) throw failure('snapshot-limit-exceeded', 'snapshot file exceeds a limit', 413);
  return readFile(path);
}

function parseJson(bytes, label) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw failure('snapshot-utf8-invalid', `${label} is not valid UTF-8`); }
  let value;
  try { value = JSON.parse(text); }
  catch { throw failure('snapshot-json-invalid', `${label} is not valid JSON`); }
  if (hasUnsafeKey(value)) throw failure('snapshot-schema-invalid', `${label} contains an unsafe key`);
  return value;
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function exactReferenceKeys(value, extraKeys = []) {
  if (!plainObject(value)) return false;
  const expected = [...REQUIRED_REFERENCE_KEYS, ...extraKeys];
  const keys = Object.keys(value);
  return expected.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => expected.includes(key) || OPTIONAL_REFERENCE_KEYS.includes(key))
    && keys.length === expected.length + OPTIONAL_REFERENCE_KEYS.filter((key) => Object.hasOwn(value, key)).length;
}

function nonnegativeSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !UTC_MILLISECONDS.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function validateManifest(value, snapshotId) {
  const fields = ['format', 'version', 'snapshotId', 'sessionId', 'createdAt', 'reason', 'sourceRevision', 'session', 'attachments', 'totalBytes'];
  if (!exactKeys(value, fields) || value.format !== SNAPSHOT_FORMAT || value.version !== 1 || value.snapshotId !== snapshotId
    || typeof value.sessionId !== 'string' || value.sessionId === '' || !canonicalTimestamp(value.createdAt)
    || value.reason !== 'trash'
    || (value.sourceRevision !== null && (typeof value.sourceRevision !== 'string' || value.sourceRevision === ''))
    || !nonnegativeSize(value.totalBytes)) {
    throw failure('snapshot-schema-invalid', 'snapshot manifest is invalid');
  }
  if (value.totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw failure('snapshot-limit-exceeded', 'snapshot total exceeds a limit', 413);
  if (!exactKeys(value.session, ['file', 'bytes', 'sha256'])
    || !nonnegativeSize(value.session.bytes) || !DIGEST.test(value.session.sha256)
    || !Array.isArray(value.attachments) || value.attachments.length > SNAPSHOT_LIMITS.maxAttachments) {
    throw failure('snapshot-schema-invalid', 'snapshot manifest is invalid');
  }
  if (value.session.bytes > SNAPSHOT_LIMITS.maxSessionBytes) throw failure('snapshot-limit-exceeded', 'snapshot session exceeds a limit', 413);
  safeRelativePath(value.session.file);
  if (value.session.file !== 'session.json') throw failure('snapshot-schema-invalid', 'snapshot manifest is invalid');
  const ids = new Set();
  const paths = new Set(['session.json']);
  for (const attachment of value.attachments) {
    if (!exactReferenceKeys(attachment, ['file', 'sha256'])
      || !nonnegativeSize(attachment.bytes) || !DIGEST.test(attachment.sha256)) {
      throw failure('snapshot-schema-invalid', 'snapshot attachment is invalid');
    }
    if (attachment.bytes > SNAPSHOT_LIMITS.maxAttachmentBytes) throw failure('snapshot-limit-exceeded', 'snapshot attachment exceeds a limit', 413);
    try { normalizeReference(referenceFields(attachment)); }
    catch { throw failure('snapshot-schema-invalid', 'snapshot attachment is invalid'); }
    safeRelativePath(attachment.file, 'attachments/');
    if (ids.has(attachment.attachmentId) || paths.has(attachment.file)) throw failure('snapshot-schema-invalid', 'snapshot attachments are duplicated');
    ids.add(attachment.attachmentId);
    paths.add(attachment.file);
  }
  return value;
}

function validateRecord(value, manifest) {
  if (!exactKeys(value, ['format', 'version', 'archive', 'source', 'attachments'])
    || value.format !== SESSION_FORMAT || value.version !== 1 || !plainObject(value.archive) || !plainObject(value.source)
    || !exactKeys(value.source, ['meta', 'events']) || !Array.isArray(value.source.events)
    || !Array.isArray(value.attachments) || value.attachments.length !== manifest.attachments.length) {
    throw failure('snapshot-schema-invalid', 'snapshot session record is invalid');
  }
  if (value.source.meta?.id !== manifest.sessionId || hasUnsafeKey(value.archive)) throw failure('snapshot-schema-invalid', 'snapshot session record is invalid');
  for (let index = 0; index < value.attachments.length; index += 1) {
    const manifestReference = referenceFields(manifest.attachments[index]);
    if (!sameReference(value.attachments[index], manifestReference)) throw failure('snapshot-schema-invalid', 'snapshot attachment descriptors disagree');
  }
  return value;
}

function summary(manifest) {
  return { snapshotId: manifest.snapshotId, sessionId: manifest.sessionId, createdAt: manifest.createdAt };
}

function historyArchive(archive) {
  const workspace = plainObject(archive.workspace)
    ? {
        id: typeof archive.workspace.id === 'string' ? archive.workspace.id : null,
        title: typeof archive.workspace.title === 'string' ? archive.workspace.title : null,
      }
    : null;
  return {
    title: typeof archive.title === 'string' ? archive.title : null,
    createdAt: Number.isFinite(archive.createdAt) ? archive.createdAt : null,
    origin: typeof archive.origin === 'string' ? archive.origin : null,
    workspace,
    tags: Array.isArray(archive.tags) ? archive.tags.filter((tag) => typeof tag === 'string') : [],
    note: typeof archive.note === 'string' ? archive.note : '',
    metadataUpdatedAt: typeof archive.metadataUpdatedAt === 'string' ? archive.metadataUpdatedAt : null,
  };
}

async function hashFileBounded(path, limit) {
  const details = await stat(path);
  if (!details.isFile()) throw failure('snapshot-path-unsafe', 'snapshot path is not a file');
  if (details.size > limit) throw failure('snapshot-limit-exceeded', 'snapshot file exceeds a limit', 413);
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > limit) {
      stream.destroy();
      throw failure('snapshot-limit-exceeded', 'snapshot file exceeds a limit', 413);
    }
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

export function createSnapshotStore({ root, persistence, attachments, now = () => new Date(), uuid = randomUUID, openFile = open }) {
  const configuredRoot = resolve(String(root));
  const storeStartedAt = Date.now();
  if (typeof persistence?.inspect !== 'function') throw new TypeError('persistence.inspect is required');

  async function ensureRoot() {
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    await chmod(configuredRoot, 0o700);
    await mkdir(resolve(configuredRoot, '.staging'), { recursive: true, mode: 0o700 });
    return realpath(configuredRoot);
  }

  async function publishedEntries(canonicalRoot) {
    const entries = (await readdir(canonicalRoot, { withFileTypes: true }))
      .filter((entry) => entry.name !== '.staging' && UUID.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length > HISTORY_SNAPSHOT_LIMIT) {
      throw failure('history-limit-exceeded', 'snapshot history exceeds a limit', 413);
    }
    return entries;
  }

  async function snapshotPath(snapshotId, canonicalRoot) {
    validSnapshotId(snapshotId);
    const rootPath = canonicalRoot ?? await ensureRoot();
    const path = resolve(rootPath, snapshotId);
    if (!isWithin(rootPath, path)) throw failure('snapshot-path-unsafe', 'snapshot path is unsafe');
    return path;
  }

  async function openRecord(snapshotId) {
    const canonicalRoot = await ensureRoot();
    const directory = await snapshotPath(snapshotId, canonicalRoot);
    let canonicalDirectory;
    try { canonicalDirectory = await realpath(directory); }
    catch (error) {
      if (error?.code === 'ENOENT') throw failure('snapshot-missing', 'snapshot is missing', 404);
      throw error;
    }
    if (!isWithin(canonicalRoot, canonicalDirectory)) throw failure('snapshot-path-unsafe', 'snapshot path is outside the snapshot root');
    const filePath = async (file, prefix) => {
      safeRelativePath(file, prefix);
      const path = resolve(canonicalDirectory, file);
      if (!isWithin(canonicalDirectory, path)) throw failure('snapshot-path-unsafe', 'snapshot path is unsafe');
      let canonical;
      try { canonical = await realpath(path); }
      catch (error) {
        if (error?.code === 'ENOENT') throw failure('snapshot-missing', 'snapshot file is missing', 404);
        throw error;
      }
      if (!isWithin(canonicalDirectory, canonical)) throw failure('snapshot-path-unsafe', 'snapshot path is outside its snapshot');
      return canonical;
    };
    const manifestBytes = await readBounded(await filePath('manifest.json'), SNAPSHOT_LIMITS.maxManifestBytes);
    const manifest = validateManifest(parseJson(manifestBytes, 'manifest.json'), snapshotId);
    const sessionBytes = await readBounded(await filePath(manifest.session.file), SNAPSHOT_LIMITS.maxSessionBytes);
    if (sessionBytes.byteLength !== manifest.session.bytes || digest(sessionBytes) !== manifest.session.sha256) {
      throw failure('snapshot-hash-mismatch', 'snapshot session hash does not match');
    }
    const record = validateRecord(parseJson(sessionBytes, manifest.session.file), manifest);
    return { filePath, manifest, record };
  }

  async function sourceRevision(sessionId) {
    if (typeof persistence.listSnapshots !== 'function') return null;
    const snapshots = await persistence.listSnapshots();
    const entry = Array.isArray(snapshots) ? snapshots.find((item) => item?.header?.id === sessionId || item?.id === sessionId) : undefined;
    if (entry === undefined) throw failure('snapshot-source-missing', 'snapshot source is missing', 404);
    if (typeof entry.revision !== 'string' || entry.revision === '') throw failure('snapshot-source-missing', 'snapshot source revision is missing', 404);
    return entry.revision;
  }

  async function capture({ sessionId, archive, liveDisposition }) {
    if (typeof sessionId !== 'string' || sessionId === '') throw failure('snapshot-source-missing', 'snapshot source is missing', 404);
    if (!['cold', 'disposed', 'parked'].includes(liveDisposition)) throw failure('snapshot-unsupported', 'snapshot disposition is unsupported', 501);
    const canonicalRoot = await ensureRoot();
    const snapshotId = validSnapshotId(uuid());
    const destination = await snapshotPath(snapshotId, canonicalRoot);
    const staging = resolve(canonicalRoot, '.staging', snapshotId);
    if (typeof persistence.listSnapshots !== 'function' && !['cold', 'disposed'].includes(liveDisposition)) {
      throw failure('snapshot-unsupported', 'stable snapshot revisions are unavailable', 501);
    }
    try {
      try {
        await lstat(destination);
        throw failure('snapshot-conflict', 'snapshot id already exists', 409);
      } catch (error) {
        if (error instanceof SnapshotError) throw error;
        if (error?.code !== 'ENOENT') throw error;
      }
      for (let attempt = 0; attempt < SNAPSHOT_LIMITS.maxRevisionAttempts; attempt += 1) {
        await rm(staging, { recursive: true, force: true, ...RM_RETRY });
        const before = await sourceRevision(sessionId);
        let inspected;
        try { inspected = await persistence.inspect(sessionId); }
        catch { throw failure('snapshot-source-missing', 'snapshot source is missing', 404); }
        if (!plainObject(inspected) || !plainObject(inspected.meta) || inspected.meta.id !== sessionId || !Array.isArray(inspected.events)) {
          throw failure('snapshot-source-missing', 'snapshot source is missing', 404);
        }
        const references = collectImageReferences(inspected.events);
        if (references.length > SNAPSHOT_LIMITS.maxAttachments) throw failure('snapshot-limit-exceeded', 'snapshot attachment count exceeds a limit', 413);
        if (references.some((reference) => reference.bytes > SNAPSHOT_LIMITS.maxAttachmentBytes)
          || references.reduce((total, reference) => total + reference.bytes, 0) > SNAPSHOT_LIMITS.maxTotalBytes) {
          throw failure('snapshot-limit-exceeded', 'snapshot attachments exceed a limit', 413);
        }
        if (references.length > 0 && typeof attachments?.readImage !== 'function') throw failure('snapshot-unsupported', 'attachment reads are unavailable', 501);
        const createdAt = now().toISOString();
        if (!Number.isFinite(new Date(createdAt).valueOf())) throw failure('snapshot-schema-invalid', 'snapshot timestamp is invalid');
        if (!plainObject(archive)) throw failure('snapshot-schema-invalid', 'archive descriptor is invalid');
        const record = {
          format: SESSION_FORMAT,
          version: 1,
          archive: cloneJson(archive, 'archive'),
          source: { meta: cloneJson(inspected.meta, 'meta'), events: cloneJson(inspected.events, 'events') },
          attachments: references.map((reference) => ({ ...reference })),
        };
        const sessionData = Buffer.from(JSON.stringify(record));
        if (sessionData.byteLength > SNAPSHOT_LIMITS.maxSessionBytes) throw failure('snapshot-limit-exceeded', 'snapshot session exceeds a limit', 413);
        if (sessionData.byteLength + references.reduce((total, reference) => total + reference.bytes, 0) > SNAPSHOT_LIMITS.maxTotalBytes) {
          throw failure('snapshot-limit-exceeded', 'snapshot total exceeds a limit', 413);
        }
        await mkdir(staging, { recursive: true, mode: 0o700 });
        await chmod(staging, 0o700);
        await writeSynced(resolve(staging, 'session.json'), sessionData, openFile);
        const captured = [];
        let totalBytes = sessionData.byteLength;
        if (references.length > 0) await mkdir(resolve(staging, 'attachments'), { mode: 0o700 });
        for (let index = 0; index < references.length; index += 1) {
          const reference = references[index];
          if (reference.bytes > SNAPSHOT_LIMITS.maxAttachmentBytes) throw failure('snapshot-limit-exceeded', 'snapshot attachment exceeds a limit', 413);
          const image = await attachments.readImage(reference);
          if (!sameReference(image?.ref, reference) || !(image?.data instanceof Uint8Array) || image.data.byteLength !== reference.bytes) {
            throw failure('snapshot-attachment-invalid', 'attachment bytes do not match their descriptor');
          }
          if (totalBytes + image.data.byteLength > SNAPSHOT_LIMITS.maxTotalBytes) throw failure('snapshot-limit-exceeded', 'snapshot total exceeds a limit', 413);
          const sha256 = digest(image.data);
          const file = `attachments/${String(index + 1).padStart(3, '0')}-${sha256.slice(0, 16)}.${mediaExtension(reference.mediaType)}`;
          await writeSynced(resolve(staging, file), image.data, openFile);
          totalBytes += image.data.byteLength;
          captured.push({ ...reference, file, sha256 });
        }
        const after = await sourceRevision(sessionId);
        if (before !== after) continue;
        const manifest = {
          format: SNAPSHOT_FORMAT,
          version: 1,
          snapshotId,
          sessionId,
          createdAt,
          reason: 'trash',
          sourceRevision: before,
          session: { file: 'session.json', bytes: sessionData.byteLength, sha256: digest(sessionData) },
          attachments: captured,
          totalBytes,
        };
        const manifestData = Buffer.from(JSON.stringify(manifest));
        if (manifestData.byteLength > SNAPSHOT_LIMITS.maxManifestBytes) throw failure('snapshot-limit-exceeded', 'snapshot manifest exceeds a limit', 413);
        await writeSynced(resolve(staging, 'manifest.json'), manifestData, openFile);
        if (captured.length > 0) await syncDirectory(resolve(staging, 'attachments'));
        await syncDirectory(staging);
        try { await rename(staging, destination); }
        catch (error) {
          // Windows reports a rename onto an existing directory as EPERM/EACCES
          // rather than EEXIST/ENOTEMPTY, so confirm what is actually there.
          if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error?.code)) {
            let occupied = false;
            try { occupied = (await lstat(destination)) !== undefined; }
            catch (probe) { if (probe?.code !== 'ENOENT') throw error; }
            if (occupied) throw failure('snapshot-conflict', 'snapshot id already exists', 409);
          }
          throw error;
        }
        await syncDirectory(canonicalRoot);
        return { ...summary(manifest), bytes: totalBytes, attachmentCount: captured.length, sourceRevision: before };
      }
      throw failure('snapshot-source-busy', 'snapshot source did not stabilize', 409);
    } finally {
      await rm(staging, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
    }
  }

  async function validate(snapshotId) {
    const canonicalRoot = await ensureRoot();
    const directory = await snapshotPath(snapshotId, canonicalRoot);
    let canonicalDirectory;
    try { canonicalDirectory = await realpath(directory); }
    catch (error) {
      if (error?.code === 'ENOENT') throw failure('snapshot-missing', 'snapshot is missing', 404);
      throw error;
    }
    if (!isWithin(canonicalRoot, canonicalDirectory)) throw failure('snapshot-path-unsafe', 'snapshot path is outside the snapshot root');
    const filePath = async (file, prefix) => {
      safeRelativePath(file, prefix);
      const path = resolve(canonicalDirectory, file);
      if (!isWithin(canonicalDirectory, path)) throw failure('snapshot-path-unsafe', 'snapshot path is unsafe');
      let canonical;
      try { canonical = await realpath(path); }
      catch (error) {
        if (error?.code === 'ENOENT') throw failure('snapshot-missing', 'snapshot file is missing', 404);
        throw error;
      }
      if (!isWithin(canonicalDirectory, canonical)) throw failure('snapshot-path-unsafe', 'snapshot path is outside its snapshot');
      return canonical;
    };
    const manifestPath = await filePath('manifest.json');
    const manifestBytes = await readBounded(manifestPath, SNAPSHOT_LIMITS.maxManifestBytes);
    const manifest = validateManifest(parseJson(manifestBytes, 'manifest.json'), snapshotId);
    const sessionPath = await filePath(manifest.session.file);
    const sessionBytes = await readBounded(sessionPath, SNAPSHOT_LIMITS.maxSessionBytes);
    if (sessionBytes.byteLength !== manifest.session.bytes || digest(sessionBytes) !== manifest.session.sha256) {
      throw failure('snapshot-hash-mismatch', 'snapshot session hash does not match');
    }
    let totalBytes = sessionBytes.byteLength;
    const record = validateRecord(parseJson(sessionBytes, manifest.session.file), manifest);
    const output = [];
    const paths = new Set([manifest.session.file]);
    for (const descriptor of manifest.attachments) {
      if (paths.has(descriptor.file)) throw failure('snapshot-schema-invalid', 'snapshot attachment paths are duplicated');
      paths.add(descriptor.file);
      const path = await filePath(descriptor.file, 'attachments/');
      const checked = await hashFileBounded(path, SNAPSHOT_LIMITS.maxAttachmentBytes);
      if (checked.bytes !== descriptor.bytes || checked.sha256 !== descriptor.sha256) {
        throw failure('snapshot-hash-mismatch', 'snapshot attachment hash does not match');
      }
      totalBytes += checked.bytes;
      if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw failure('snapshot-limit-exceeded', 'snapshot total exceeds a limit', 413);
      output.push({
        descriptor: { ...descriptor },
        path,
        async read() {
          const data = await readBounded(path, SNAPSHOT_LIMITS.maxAttachmentBytes);
          if (data.byteLength !== descriptor.bytes || digest(data) !== descriptor.sha256) {
            throw failure('snapshot-hash-mismatch', 'snapshot attachment hash does not match');
          }
          return new Uint8Array(data);
        },
      });
    }
    if (totalBytes !== manifest.totalBytes) throw failure('snapshot-schema-invalid', 'snapshot total does not match');
    return { manifest: cloneJson(manifest), record, attachments: output };
  }

  async function inspectSummary(snapshotId, { history = false } = {}) {
    const canonicalRoot = await ensureRoot();
    const directory = await snapshotPath(snapshotId, canonicalRoot);
    let canonicalDirectory;
    try { canonicalDirectory = await realpath(directory); }
    catch (error) {
      if (error?.code === 'ENOENT') throw failure('snapshot-missing', 'snapshot is missing', 404);
      throw error;
    }
    if (!isWithin(canonicalRoot, canonicalDirectory)) throw failure('snapshot-path-unsafe', 'snapshot path is outside the snapshot root');
    const filePath = async (file, prefix) => {
      safeRelativePath(file, prefix);
      const path = resolve(canonicalDirectory, file);
      if (!isWithin(canonicalDirectory, path)) throw failure('snapshot-path-unsafe', 'snapshot path is unsafe');
      let canonical;
      try { canonical = await realpath(path); }
      catch (error) {
        if (error?.code === 'ENOENT') throw failure('snapshot-missing', 'snapshot file is missing', 404);
        throw error;
      }
      if (!isWithin(canonicalDirectory, canonical)) throw failure('snapshot-path-unsafe', 'snapshot path is outside its snapshot');
      return canonical;
    };

    const manifestPath = await filePath('manifest.json');
    const manifestBytes = await readBounded(manifestPath, SNAPSHOT_LIMITS.maxManifestBytes);
    const manifest = validateManifest(parseJson(manifestBytes, 'manifest.json'), snapshotId);
    const sessionPath = await filePath(manifest.session.file);
    const sessionBytes = await readBounded(sessionPath, SNAPSHOT_LIMITS.maxSessionBytes);
    if (sessionBytes.byteLength !== manifest.session.bytes || digest(sessionBytes) !== manifest.session.sha256) {
      throw failure('snapshot-hash-mismatch', 'snapshot session hash does not match');
    }
    const record = validateRecord(parseJson(sessionBytes, manifest.session.file), manifest);

    let totalBytes = sessionBytes.byteLength;
    const attachments = [];
    for (const descriptor of manifest.attachments) {
      const path = await filePath(descriptor.file, 'attachments/');
      const checked = await hashFileBounded(path, SNAPSHOT_LIMITS.maxAttachmentBytes);
      if (checked.bytes !== descriptor.bytes || checked.sha256 !== descriptor.sha256) {
        throw failure('snapshot-hash-mismatch', 'snapshot attachment hash does not match');
      }
      totalBytes += checked.bytes;
      if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw failure('snapshot-limit-exceeded', 'snapshot total exceeds a limit', 413);
      attachments.push({ sha256: descriptor.sha256, bytes: descriptor.bytes });
    }
    if (totalBytes !== manifest.totalBytes) throw failure('snapshot-schema-invalid', 'snapshot total does not match');
    const inspected = {
      snapshotId: manifest.snapshotId,
      sessionId: manifest.sessionId,
      createdAt: manifest.createdAt,
      totalBytes: manifest.totalBytes,
      sessionBytes: manifest.session.bytes,
      attachmentCount: manifest.attachments.length,
      attachments,
    };
    if (!history) return inspected;
    return {
      snapshotId: inspected.snapshotId,
      sessionId: inspected.sessionId,
      createdAt: inspected.createdAt,
      sourceRevision: manifest.sourceRevision,
      totalBytes: inspected.totalBytes,
      sessionBytes: inspected.sessionBytes,
      attachmentCount: inspected.attachmentCount,
      archive: historyArchive(record.archive),
    };
  }

  async function inspectHistory(snapshotId) {
    return inspectSummary(snapshotId, { history: true });
  }

  async function findRevision(sessionId, sourceRevision) {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof sourceRevision !== 'string' || sourceRevision === '') return null;
    const canonicalRoot = await ensureRoot();
    const entries = await publishedEntries(canonicalRoot);
    for (const entry of entries) {
      try {
        const inspected = await inspectHistory(entry.name);
        if (inspected.sessionId === sessionId && inspected.sourceRevision === sourceRevision) return inspected;
      } catch { /* Degraded snapshots cannot satisfy revision reuse. */ }
    }
    return null;
  }

  async function readHistoryPage(snapshotId, window) {
    const checked = await openRecord(snapshotId);
    const page = paginateProjectedMessages(projectArchivedMessages(checked.record.source.events), window);
    return {
      snapshotId: checked.manifest.snapshotId,
      sessionId: checked.manifest.sessionId,
      createdAt: checked.manifest.createdAt,
      ...page,
    };
  }

  async function readHistoryImage(snapshotId, reference, signal) {
    if (signal?.aborted) throw signal.reason ?? failure('request-aborted', 'request was aborted', 499);
    const checked = await openRecord(snapshotId);
    const projected = findProjectedImage(projectArchivedMessages(checked.record.source.events), reference?.attachmentId);
    if (projected === null || !sameReference(projected, reference)) {
      throw failure('snapshot-image-not-found', 'snapshot image was not found', 404);
    }
    const descriptor = checked.manifest.attachments.find((item) => sameReference(referenceFields(item), projected));
    if (descriptor === undefined) throw failure('snapshot-image-not-found', 'snapshot image was not found', 404);
    const bytes = await readBounded(await checked.filePath(descriptor.file, 'attachments/'), SNAPSHOT_LIMITS.maxAttachmentBytes);
    if (bytes.byteLength !== descriptor.bytes || digest(bytes) !== descriptor.sha256) {
      throw failure('snapshot-hash-mismatch', 'snapshot attachment hash does not match');
    }
    if (signal?.aborted) throw signal.reason ?? failure('request-aborted', 'request was aborted', 499);
    return {
      data: new Uint8Array(bytes),
      mediaType: descriptor.mediaType,
      width: descriptor.width,
      height: descriptor.height,
      ...(typeof descriptor.name === 'string' ? { name: descriptor.name } : {}),
    };
  }

  async function inventory() {
    const canonicalRoot = await ensureRoot();
    const valid = [];
    const degraded = [];
    for (const entry of await publishedEntries(canonicalRoot)) {
      try { valid.push(await inspectSummary(entry.name)); }
      catch (error) { degraded.push({ snapshotId: entry.name, code: error?.code ?? 'snapshot-invalid' }); }
    }
    valid.sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));
    degraded.sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));
    return { valid, degraded };
  }

  async function scanPublished({ cleanStaging = false } = {}) {
    const canonicalRoot = await ensureRoot();
    const staging = resolve(canonicalRoot, '.staging');
    if (cleanStaging) {
      const stagingEntries = await readdir(staging);
      if (stagingEntries.length > HISTORY_SNAPSHOT_LIMIT) throw failure('history-limit-exceeded', 'snapshot staging exceeds a limit', 413);
      for (const entry of stagingEntries) {
        const path = resolve(staging, entry);
        try {
          const details = await lstat(path);
          if (details.mtimeMs < storeStartedAt) await rm(path, { recursive: true, force: true, ...RM_RETRY });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
    const valid = [];
    const degraded = [];
    const latestBySession = new Map();
    for (const entry of await publishedEntries(canonicalRoot)) {
      try {
        const checked = await validate(entry.name);
        const item = summary(checked.manifest);
        valid.push(item);
        const prior = latestBySession.get(item.sessionId);
        if (prior === undefined || item.createdAt > prior.createdAt || (item.createdAt === prior.createdAt && item.snapshotId > prior.snapshotId)) latestBySession.set(item.sessionId, item);
      } catch (error) {
        degraded.push({ snapshotId: entry.name, code: error?.code ?? 'snapshot-invalid' });
      }
    }
    valid.sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
    return { valid, degraded, latestBySession };
  }

  async function recover() {
    return scanPublished({ cleanStaging: true });
  }

  async function latestFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    return (await scanPublished()).latestBySession.get(sessionId) ?? null;
  }

  async function remove(snapshotId) {
    const canonicalRoot = await ensureRoot();
    const directory = await snapshotPath(snapshotId, canonicalRoot);
    await rm(directory, { recursive: true, force: true, ...RM_RETRY });
    try {
      await lstat(directory);
      throw failure('snapshot-delete-unconfirmed', 'snapshot directory still exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await syncDirectory(canonicalRoot);
  }

  /**
   * Read one published snapshot's owning session id without validating its
   * contents, so a degraded snapshot can still be attributed to the session it
   * belongs to. Returns null when even the manifest identity is unreadable.
   */
  async function snapshotOwner(snapshotId, canonicalRoot) {
    try {
      const directory = await snapshotPath(snapshotId, canonicalRoot);
      const bytes = await readBounded(resolve(directory, 'manifest.json'), SNAPSHOT_LIMITS.maxManifestBytes);
      const value = parseJson(bytes, 'manifest.json');
      return plainObject(value) && typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : null;
    } catch { return null; }
  }

  /**
   * Remove every published snapshot belonging to one session. A snapshot that
   * fails validation is still removed when its manifest identity attributes it
   * to this session, and an unrelated degraded snapshot is skipped instead of
   * aborting the sweep — physical purge must never be blocked by corruption
   * somewhere else in the store. `knownIds` covers records whose snapshot is
   * damaged past attribution.
   */
  async function removeForSession(sessionId, { knownIds = [] } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return [];
    const canonicalRoot = await ensureRoot();
    const removed = [];
    const claimed = new Set((Array.isArray(knownIds) ? knownIds : [knownIds])
      .filter((id) => typeof id === 'string' && UUID.test(id)));
    for (const entry of await publishedEntries(canonicalRoot)) {
      let owner;
      try { owner = (await validate(entry.name)).manifest.sessionId; }
      catch { owner = await snapshotOwner(entry.name, canonicalRoot); }
      if (owner !== sessionId && !claimed.has(entry.name)) continue;
      await remove(entry.name);
      removed.push(entry.name);
    }
    return removed;
  }

  return Object.freeze({ capture, validate, inspectHistory, findRevision, readHistoryPage, readHistoryImage, inventory, latestFor, recover, remove, removeForSession });
}
