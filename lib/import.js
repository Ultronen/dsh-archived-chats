import { Unzip, UnzipInflate } from 'fflate';
import { normalizeMetadata } from './metadata.js';

export const IMPORT_LIMITS = Object.freeze({
  maxCompressedBytes: 512 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxSessions: 2000,
  maxEntries: 1 + (2000 * 2),
  maxEntryBytes: 8 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxJsonBytes: 4 * 1024 * 1024,
  maxMarkdownBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000,
  maxJsonStringCodePoints: 4 * 1024 * 1024,
});

const MANIFEST_FORMAT = 'dsh-archived-chats/export';
const SESSION_FORMAT = 'dsh-archived-chats/session';
const ZIP_INPUT_CHUNK_BYTES = 16 * 1024;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

function error(code, path, message) {
  return { code, path, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scanJson(value, path, limits) {
  const stack = [{ value, path, depth: 0 }];
  let nodes = 0;
  let stringCodePoints = 0;

  const countString = (text, stringPath) => {
    for (const _point of text) {
      stringCodePoints += 1;
      if (stringCodePoints > limits.maxJsonStringCodePoints) {
        return error('json-limit-exceeded', stringPath, 'JSON strings exceed limit');
      }
    }
    return null;
  };

  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > limits.maxJsonNodes) return error('json-limit-exceeded', current.path, 'JSON nodes exceed limit');
    if (current.depth > limits.maxJsonDepth) return error('json-limit-exceeded', current.path, 'JSON depth exceeds limit');

    if (typeof current.value === 'string') {
      const exceeded = countString(current.value, current.path);
      if (exceeded !== null) return exceeded;
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], path: `${current.path}[${index}]`, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isObject(current.value)) continue;
    const entries = Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      const childPath = `${current.path}.${key}`;
      if (forbiddenKeys.has(key)) return error('json-key-unsafe', childPath, `unsupported JSON key ${key}`);
      const exceeded = countString(key, childPath);
      if (exceeded !== null) return exceeded;
      stack.push({ value: child, path: childPath, depth: current.depth + 1 });
    }
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

function parseJson(bytes, path, limits) {
  let value;
  try { value = JSON.parse(decodeUtf8(bytes, path)); }
  catch (cause) {
    if (cause?.importError) throw cause;
    throw Object.assign(new Error(`invalid JSON in ${path}`), { importError: error('json-invalid', path, 'entry is not valid JSON') });
  }
  const unsafe = scanJson(value, '$', limits);
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

function importError(code, path, message) {
  return Object.assign(new Error(message), { importError: error(code, path, message) });
}

function joinChunks(chunks, length) {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function indexZip(bytes, limits) {
  if (!(bytes instanceof Uint8Array)) throw Object.assign(new Error('ZIP source must be Uint8Array'), { importError: error('source-invalid', '$', 'source bytes are required') });
  if (bytes.byteLength === 0) throw importError('zip-invalid', '$', 'archive is not a readable ZIP');
  const entries = new Map();
  const names = new Set();
  let entryCount = 0;
  let declaredTotal = 0;
  let total = 0;
  let active = 0;
  let failure = null;

  const fail = (code, path, message) => {
    if (failure === null) failure = importError(code, path, message);
  };

  const archive = new Unzip((file) => {
    if (failure !== null) { file.terminate(); return; }
    const name = file.name;
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      fail('limit-exceeded', '$', 'ZIP entry count exceeds limit');
      file.terminate();
      return;
    }
    if (!safeEntryName(name)) {
      fail('path-unsafe', name, 'ZIP entry path is unsafe');
      file.terminate();
      return;
    }
    if (names.has(name)) {
      fail('entry-duplicate', name, 'ZIP contains duplicate entry names');
      file.terminate();
      return;
    }
    names.add(name);

    if (Number.isSafeInteger(file.originalSize) && file.originalSize >= 0) {
      if (file.originalSize > limits.maxEntryBytes) {
        fail('limit-exceeded', name, 'ZIP entry exceeds limit');
        file.terminate();
        return;
      }
      declaredTotal += file.originalSize;
      if (declaredTotal > limits.maxUncompressedBytes) {
        fail('limit-exceeded', '$', 'uncompressed package exceeds limit');
        file.terminate();
        return;
      }
    }

    const chunks = [];
    let length = 0;
    active += 1;
    file.ondata = (cause, chunk, final) => {
      if (failure !== null) return;
      if (cause) {
        fail('zip-invalid', name, 'ZIP entry cannot be decompressed');
        return;
      }
      const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk ?? 0);
      length += value.byteLength;
      total += value.byteLength;
      if (length > limits.maxEntryBytes || total > limits.maxUncompressedBytes) {
        fail('limit-exceeded', length > limits.maxEntryBytes ? name : '$', length > limits.maxEntryBytes ? 'ZIP entry exceeds limit' : 'uncompressed package exceeds limit');
        file.terminate();
        return;
      }
      if (!name.endsWith('/') && value.byteLength > 0) chunks.push(value);
      if (final) {
        active -= 1;
        if (!name.endsWith('/')) entries.set(name, joinChunks(chunks, length));
      }
    };
    try { file.start(); }
    catch { fail('zip-invalid', name, 'ZIP entry cannot be decompressed'); }
  });
  archive.register(UnzipInflate);

  for (let offset = 0; offset < bytes.byteLength && failure === null; offset += ZIP_INPUT_CHUNK_BYTES) {
    const end = Math.min(bytes.byteLength, offset + ZIP_INPUT_CHUNK_BYTES);
    try { archive.push(bytes.subarray(offset, end), end === bytes.byteLength); }
    catch { fail('zip-invalid', '$', 'archive is not a readable ZIP'); }
  }
  if (failure !== null) throw failure;
  if (active !== 0) throw importError('zip-invalid', '$', 'archive is not a readable ZIP');
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
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      continue;
    }
    if (!isObject(current)) continue;
    if (current.type === 'image' || current.type === 'attachment' || typeof current.attachmentId === 'string') return true;
    stack.push(...Object.values(current));
  }
  return false;
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
export function inspectImport(source, options = {}) {
  try {
    const limits = { ...IMPORT_LIMITS, ...(options?.limits ?? {}) };
    const bytes = source?.bytes;
    const compressedBytes = Number.isFinite(source?.compressedBytes) ? source.compressedBytes : bytes?.byteLength;
    if (!(bytes instanceof Uint8Array) || !Number.isFinite(compressedBytes)) throw Object.assign(new Error('source bytes are required'), { importError: error('source-invalid', '$', 'source bytes are required') });
    if (compressedBytes > limits.maxCompressedBytes) throw Object.assign(new Error('compressed package exceeds limit'), { importError: error('limit-exceeded', '$', 'compressed package exceeds limit') });

    const { entries, total } = indexZip(bytes, limits);
    if (total > limits.maxUncompressedBytes) throw Object.assign(new Error('uncompressed package exceeds limit'), { importError: error('limit-exceeded', '$', 'uncompressed package exceeds limit') });
    const manifestBytes = entries.get('manifest.json');
    if (manifestBytes === undefined) throw Object.assign(new Error('manifest.json is missing'), { importError: error('manifest-missing', 'manifest.json', 'root manifest.json is required') });
    if (manifestBytes.byteLength > limits.maxManifestBytes) throw Object.assign(new Error('manifest.json exceeds limit'), { importError: error('limit-exceeded', 'manifest.json', 'manifest.json exceeds limit') });
    const manifest = parseJson(manifestBytes, 'manifest.json', limits);
    if (manifest?.format !== MANIFEST_FORMAT || manifest?.version !== 1) throw Object.assign(new Error('unsupported manifest format'), { importError: error('format-unsupported', 'manifest.json', 'only export format version 1 is supported') });
    if (!Number.isInteger(manifest.sessionCount) || manifest.sessionCount < 1 || manifest.sessionCount > limits.maxSessions || !Array.isArray(manifest.sessions) || manifest.sessions.length !== manifest.sessionCount) {
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
      if (jsonBytes.byteLength > limits.maxJsonBytes) errors.push(error('limit-exceeded', jsonName, 'session JSON exceeds limit'));
      if (markdownBytes.byteLength > limits.maxMarkdownBytes) errors.push(error('limit-exceeded', markdownName, 'transcript exceeds limit'));
      let record;
      try { record = parseJson(jsonBytes, jsonName, limits); }
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
