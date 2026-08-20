import { unzipSync } from 'fflate';
import { normalizeMetadata } from './metadata.js';

export const IMPORT_LIMITS = Object.freeze({
  maxCompressedBytes: 512 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxSessions: 2000,
  maxJsonBytes: 4 * 1024 * 1024,
  maxMarkdownBytes: 8 * 1024 * 1024,
});

const MANIFEST_FORMAT = 'dsh-archived-chats/export';
const SESSION_FORMAT = 'dsh-archived-chats/session';
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

function error(code, path, message) {
  return { code, path, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scanKeys(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) scanKeys(value[index], `${path}[${index}]`);
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) return error('json-key-unsafe', `${path}.${key}`, `unsupported JSON key ${key}`);
    const found = scanKeys(child, `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

function decodeUtf8(bytes, path) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error(`invalid UTF-8 in ${path}`), { importError: error('utf8-invalid', path, 'entry is not valid UTF-8') });
  }
}

function parseJson(bytes, path) {
  let value;
  try { value = JSON.parse(decodeUtf8(bytes, path)); }
  catch (cause) {
    if (cause?.importError) throw cause;
    throw Object.assign(new Error(`invalid JSON in ${path}`), { importError: error('json-invalid', path, 'entry is not valid JSON') });
  }
  const unsafe = scanKeys(value);
  if (unsafe !== null) throw Object.assign(new Error(unsafe.message), { importError: unsafe });
  return value;
}

function safeEntryName(name) {
  if (typeof name !== 'string' || name === '' || name.includes('\\') || name.includes('\u0000')) return false;
  if (name.startsWith('/') || name.includes(':')) return false;
  if (/^[\u0000-\u001f\u007f]/u.test(name) || /[\u0000-\u001f\u007f]/u.test(name)) return false;
  if (name.endsWith('/')) return true;
  const segments = name.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function indexZip(bytes) {
  if (!(bytes instanceof Uint8Array)) throw Object.assign(new Error('ZIP source must be Uint8Array'), { importError: error('source-invalid', '$', 'source bytes are required') });
  let unzipped;
  try { unzipped = unzipSync(bytes); }
  catch { throw Object.assign(new Error('ZIP cannot be read'), { importError: error('zip-invalid', '$', 'archive is not a readable ZIP') }); }
  const entries = new Map();
  let total = 0;
  for (const [name, value] of Object.entries(unzipped)) {
    if (!safeEntryName(name)) throw Object.assign(new Error(`unsafe ZIP entry ${name}`), { importError: error('path-unsafe', name, 'ZIP entry path is unsafe') });
    if (name.endsWith('/')) continue;
    if (entries.has(name)) throw Object.assign(new Error(`duplicate ZIP entry ${name}`), { importError: error('entry-duplicate', name, 'ZIP contains duplicate entry names') });
    const bytesValue = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += bytesValue.byteLength;
    entries.set(name, bytesValue);
  }
  return { entries, total };
}

function requireString(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value === '') errors.push(error('field-invalid', path, `${path} must be a non-empty string`));
}

function requireFinite(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value)) errors.push(error('field-invalid', path, `${path} must be finite`));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasAttachment(value) {
  if (Array.isArray(value)) return value.some(hasAttachment);
  if (!isObject(value)) return false;
  if (value.type === 'image' || value.type === 'attachment' || typeof value.attachmentId === 'string') return true;
  return Object.values(value).some(hasAttachment);
}

function validateDescriptor(descriptor, path, errors) {
  if (!isObject(descriptor)) {
    errors.push(error('field-invalid', path, `${path} must be an object`));
    return;
  }
  requireString(descriptor.id, `${path}.id`, errors);
  requireString(descriptor.title, `${path}.title`, errors, { nullable: true });
  requireFinite(descriptor.createdAt, `${path}.createdAt`, errors, { nullable: true });
  requireString(descriptor.origin, `${path}.origin`, errors, { nullable: true });
  requireString(descriptor.metadataUpdatedAt, `${path}.metadataUpdatedAt`, errors, { nullable: true });
  if (!Array.isArray(descriptor.tags) || descriptor.tags.some((tag) => typeof tag !== 'string')) errors.push(error('metadata-invalid', `${path}.tags`, 'tags must be an array of strings'));
  if (typeof descriptor.note !== 'string' && descriptor.note !== null) errors.push(error('metadata-invalid', `${path}.note`, 'note must be a string or null'));
  if (!isObject(descriptor.workspace) && descriptor.workspace !== null) errors.push(error('field-invalid', `${path}.workspace`, 'workspace must be an object or null'));
  if (!isObject(descriptor.storage)) errors.push(error('field-invalid', `${path}.storage`, 'storage must be an object'));
  else {
    if (!['ready', 'unavailable'].includes(descriptor.storage.status)) errors.push(error('field-invalid', `${path}.storage.status`, 'storage status is unsupported'));
    if (descriptor.storage.status === 'ready') {
      requireFinite(descriptor.storage.sizeBytes, `${path}.storage.sizeBytes`, errors);
      requireFinite(descriptor.storage.fileCount, `${path}.storage.fileCount`, errors);
    }
  }
  if (!isObject(descriptor.files)) errors.push(error('field-invalid', `${path}.files`, 'files must be an object'));
  else {
    requireString(descriptor.files.json, `${path}.files.json`, errors);
    requireString(descriptor.files.markdown, `${path}.files.markdown`, errors);
  }
}

function normalizeWarnings(item, record) {
  const warnings = [];
  if (hasAttachment(record.source?.events)) warnings.push('attachments-not-included');
  if (item.workspace === null || item.workspace?.id === null) warnings.push('workspace-unresolved');
  return warnings;
}

function importFailure(cause) {
  if (cause?.importError) return { ok: false, errors: [cause.importError] };
  return { ok: false, errors: [error('import-invalid', '$', String(cause?.message ?? cause))] };
}

/**
 * Validate a version-one archived backup without writing to disk or DSH.
 * The current implementation receives bounded bytes from the host route;
 * every decompressed entry is still checked against per-entry and total caps.
 */
export function inspectImport(source) {
  try {
    const bytes = source?.bytes;
    const compressedBytes = Number.isFinite(source?.compressedBytes) ? source.compressedBytes : bytes?.byteLength;
    if (!(bytes instanceof Uint8Array) || !Number.isFinite(compressedBytes)) throw Object.assign(new Error('source bytes are required'), { importError: error('source-invalid', '$', 'source bytes are required') });
    if (compressedBytes > IMPORT_LIMITS.maxCompressedBytes) throw Object.assign(new Error('compressed package exceeds limit'), { importError: error('limit-exceeded', '$', 'compressed package exceeds limit') });

    const { entries, total } = indexZip(bytes);
    if (total > IMPORT_LIMITS.maxUncompressedBytes) throw Object.assign(new Error('uncompressed package exceeds limit'), { importError: error('limit-exceeded', '$', 'uncompressed package exceeds limit') });
    const manifestBytes = entries.get('manifest.json');
    if (manifestBytes === undefined) throw Object.assign(new Error('manifest.json is missing'), { importError: error('manifest-missing', 'manifest.json', 'root manifest.json is required') });
    const manifest = parseJson(manifestBytes, 'manifest.json');
    if (manifest?.format !== MANIFEST_FORMAT || manifest?.version !== 1) throw Object.assign(new Error('unsupported manifest format'), { importError: error('format-unsupported', 'manifest.json', 'only export format version 1 is supported') });
    if (!Number.isInteger(manifest.sessionCount) || manifest.sessionCount < 1 || manifest.sessionCount > IMPORT_LIMITS.maxSessions || !Array.isArray(manifest.sessions) || manifest.sessions.length !== manifest.sessionCount) {
      throw Object.assign(new Error('invalid manifest session count'), { importError: error('session-count-invalid', 'manifest.sessionCount', 'sessionCount must match 1..2000 manifest sessions') });
    }
    if (manifest.attachmentsIncluded !== false) throw Object.assign(new Error('attachment bytes are not accepted'), { importError: error('attachments-unsupported', 'manifest.attachmentsIncluded', 'version-one packages must not include attachment bytes') });

    const errors = [];
    const ids = new Set();
    const referenced = new Set(['manifest.json']);
    const items = [];
    for (let index = 0; index < manifest.sessions.length; index += 1) {
      const descriptor = manifest.sessions[index];
      const path = `manifest.sessions[${index}]`;
      validateDescriptor(descriptor, path, errors);
      if (!isObject(descriptor) || typeof descriptor.id !== 'string') continue;
      if (ids.has(descriptor.id)) errors.push(error('session-duplicate', `${path}.id`, 'session IDs must be unique'));
      ids.add(descriptor.id);
      const jsonName = descriptor.files?.json;
      const markdownName = descriptor.files?.markdown;
      if (typeof jsonName !== 'string' || typeof markdownName !== 'string') continue;
      if (!safeEntryName(jsonName) || !safeEntryName(markdownName) || !jsonName.startsWith('sessions/') || !markdownName.startsWith('sessions/')) {
        errors.push(error('path-unsafe', path, 'manifest file paths must be safe sessions/ paths'));
        continue;
      }
      if (referenced.has(jsonName) || referenced.has(markdownName)) errors.push(error('entry-duplicate', path, 'manifest references duplicate file paths'));
      referenced.add(jsonName); referenced.add(markdownName);
      const jsonBytes = entries.get(jsonName);
      const markdownBytes = entries.get(markdownName);
      if (jsonBytes === undefined) { errors.push(error('entry-missing', jsonName, 'session JSON entry is missing')); continue; }
      if (markdownBytes === undefined) { errors.push(error('entry-missing', markdownName, 'transcript entry is missing')); continue; }
      if (jsonBytes.byteLength > IMPORT_LIMITS.maxJsonBytes) errors.push(error('limit-exceeded', jsonName, 'session JSON exceeds limit'));
      if (markdownBytes.byteLength > IMPORT_LIMITS.maxMarkdownBytes) errors.push(error('limit-exceeded', markdownName, 'transcript exceeds limit'));
      let record;
      try { record = parseJson(jsonBytes, jsonName); }
      catch (cause) { errors.push(cause.importError ?? error('json-invalid', jsonName, 'session JSON is invalid')); continue; }
      if (record?.format !== SESSION_FORMAT || record?.version !== 1 || !isObject(record.archive) || record.archive.id !== descriptor.id) {
        errors.push(error('session-mismatch', jsonName, 'session JSON format, version, or archive.id does not match manifest'));
        continue;
      }
      if (!sameJson(record.archive, descriptor)) errors.push(error('session-mismatch', jsonName, 'manifest descriptor does not match session archive descriptor'));
      try { normalizeMetadata({ tags: descriptor.tags, note: descriptor.note ?? '' }); }
      catch { errors.push(error('metadata-invalid', `${path}.tags`, 'tags or note exceed metadata limits')); }
      items.push({
        id: descriptor.id,
        title: descriptor.title,
        workspace: descriptor.workspace,
        createdAt: descriptor.createdAt,
        origin: descriptor.origin,
        metadataUpdatedAt: descriptor.metadataUpdatedAt,
        tags: descriptor.tags,
        note: descriptor.note ?? '',
        storage: descriptor.storage,
        hasAttachmentReferences: hasAttachment(record.source?.events),
        warnings: normalizeWarnings(descriptor, record),
        record,
        jsonBytes,
        transcriptSizeBytes: markdownBytes.byteLength,
      });
    }
    for (const name of entries.keys()) if (!referenced.has(name)) errors.push(error('entry-unreferenced', name, 'ZIP contains an unreferenced file'));
    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      plan: {
        manifest,
        items,
        warnings: items.flatMap((item) => item.warnings.map((reason) => ({ id: item.id, reason }))),
        totalBytes: total,
      },
    };
  } catch (cause) {
    return importFailure(cause);
  }
}

export function selectImportItems(plan, selectedIds, conflicts = new Set()) {
  const selected = Array.isArray(selectedIds) ? selectedIds : [];
  const byId = new Map((plan?.items ?? []).map((item) => [item.id, item]));
  const records = [];
  const skipped = [];
  const seen = new Set();
  for (const id of selected) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const item = byId.get(id);
    if (item === undefined) { skipped.push({ id, reason: 'selection-unknown' }); continue; }
    if (conflicts.has(id)) { skipped.push({ id, reason: 'id-conflict' }); continue; }
    records.push(item);
  }
  return { records, skipped };
}
