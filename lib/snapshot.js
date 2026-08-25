import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export const SNAPSHOT_LIMITS = Object.freeze({
  maxManifestBytes: 4 * 1024 * 1024,
  maxSessionBytes: 512 * 1024 * 1024,
  maxAttachments: 10000,
  maxAttachmentBytes: 32 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxRevisionAttempts: 3,
});

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

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !path.includes('../'));
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

async function writeSynced(path, data) {
  await writeFile(path, data, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  const handle = await open(path, 'r');
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

export function createSnapshotStore({ root, persistence, attachments, now = () => new Date(), uuid = randomUUID }) {
  const configuredRoot = resolve(String(root));
  const storeStartedAt = Date.now();
  if (typeof persistence?.inspect !== 'function') throw new TypeError('persistence.inspect is required');

  async function ensureRoot() {
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    await chmod(configuredRoot, 0o700);
    await mkdir(resolve(configuredRoot, '.staging'), { recursive: true, mode: 0o700 });
    return realpath(configuredRoot);
  }

  async function snapshotPath(snapshotId, canonicalRoot) {
    validSnapshotId(snapshotId);
    const rootPath = canonicalRoot ?? await ensureRoot();
    const path = resolve(rootPath, snapshotId);
    if (!isWithin(rootPath, path)) throw failure('snapshot-path-unsafe', 'snapshot path is unsafe');
    return path;
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
        await rm(staging, { recursive: true, force: true });
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
        await writeSynced(resolve(staging, 'session.json'), sessionData);
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
          await writeSynced(resolve(staging, file), image.data);
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
        await writeSynced(resolve(staging, 'manifest.json'), manifestData);
        try { await rename(staging, destination); }
        catch (error) {
          if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') throw failure('snapshot-conflict', 'snapshot id already exists', 409);
          throw error;
        }
        return { ...summary(manifest), bytes: totalBytes, attachmentCount: captured.length, sourceRevision: before };
      }
      throw failure('snapshot-source-busy', 'snapshot source did not stabilize', 409);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
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
      const data = await readBounded(path, SNAPSHOT_LIMITS.maxAttachmentBytes);
      if (data.byteLength !== descriptor.bytes || digest(data) !== descriptor.sha256) {
        throw failure('snapshot-hash-mismatch', 'snapshot attachment hash does not match');
      }
      totalBytes += data.byteLength;
      if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw failure('snapshot-limit-exceeded', 'snapshot total exceeds a limit', 413);
      output.push({ descriptor: { ...descriptor }, path, data });
    }
    if (totalBytes !== manifest.totalBytes) throw failure('snapshot-schema-invalid', 'snapshot total does not match');
    return { manifest: cloneJson(manifest), record, attachments: output };
  }

  async function inspectSummary(snapshotId) {
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
    validateRecord(parseJson(sessionBytes, manifest.session.file), manifest);

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
    return {
      snapshotId: manifest.snapshotId,
      sessionId: manifest.sessionId,
      createdAt: manifest.createdAt,
      totalBytes: manifest.totalBytes,
      sessionBytes: manifest.session.bytes,
      attachmentCount: manifest.attachments.length,
      attachments,
    };
  }

  async function inventory() {
    const canonicalRoot = await ensureRoot();
    const valid = [];
    const degraded = [];
    for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (entry.name === '.staging' || !UUID.test(entry.name)) continue;
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
      for (const entry of await readdir(staging)) {
        const path = resolve(staging, entry);
        try {
          const details = await lstat(path);
          if (details.mtimeMs < storeStartedAt) await rm(path, { recursive: true, force: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
    const valid = [];
    const degraded = [];
    const latestBySession = new Map();
    for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (entry.name === '.staging' || !UUID.test(entry.name)) continue;
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
    await rm(directory, { recursive: true, force: true });
  }

  async function removeForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return [];
    const canonicalRoot = await ensureRoot();
    const removed = [];
    for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (!UUID.test(entry.name)) continue;
      try {
        const checked = await validate(entry.name);
        if (checked.manifest.sessionId !== sessionId) continue;
        await remove(entry.name);
        removed.push(entry.name);
      } catch { /* Corrupt or unsafe snapshots are intentionally retained. */ }
    }
    return removed;
  }

  return Object.freeze({ capture, validate, inventory, latestFor, recover, remove, removeForSession });
}
