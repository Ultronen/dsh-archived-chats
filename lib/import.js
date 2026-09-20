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

export function validateJsonValue(value, limits = IMPORT_LIMITS) {
  return scanJson(value, '$', limits);
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

function zipUint16(view, offset) {
  if (offset < 0 || offset + 2 > view.byteLength) throw importError('zip-invalid', '$', 'archive is not a complete ZIP');
  return view.getUint16(offset, true);
}

function zipUint32(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) throw importError('zip-invalid', '$', 'archive is not a complete ZIP');
  return view.getUint32(offset, true);
}

function zipName(bytes, offset, length) {
  if (offset < 0 || offset + length > bytes.byteLength) throw importError('zip-invalid', '$', 'archive entry name is truncated');
  return decodeUtf8(bytes.subarray(offset, offset + length), '$');
}

function validateZipStructure(bytes) {
  if (bytes.byteLength < 22) throw importError('zip-invalid', '$', 'archive is not a complete ZIP');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floor = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= floor; offset -= 1) {
    if (zipUint32(view, offset) === 0x06054b50
      && offset + 22 + zipUint16(view, offset + 20) === bytes.byteLength) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) throw importError('zip-invalid', '$', 'ZIP end-of-central-directory is missing');
  const disk = zipUint16(view, eocd + 4);
  const centralDisk = zipUint16(view, eocd + 6);
  const diskEntries = zipUint16(view, eocd + 8);
  const entryCount = zipUint16(view, eocd + 10);
  const centralSize = zipUint32(view, eocd + 12);
  const centralOffset = zipUint32(view, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount
    || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw importError('zip-invalid', '$', 'multi-disk and ZIP64 archives are unsupported');
  }
  if (centralOffset + centralSize !== eocd) throw importError('zip-invalid', '$', 'ZIP central directory is truncated or misplaced');

  const central = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (zipUint32(view, cursor) !== 0x02014b50) throw importError('zip-invalid', '$', 'ZIP central directory entry is invalid');
    const flags = zipUint16(view, cursor + 8);
    const method = zipUint16(view, cursor + 10);
    const crc = zipUint32(view, cursor + 16);
    const compressedSize = zipUint32(view, cursor + 20);
    const originalSize = zipUint32(view, cursor + 24);
    const nameLength = zipUint16(view, cursor + 28);
    const extraLength = zipUint16(view, cursor + 30);
    const commentLength = zipUint16(view, cursor + 32);
    const localOffset = zipUint32(view, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw importError('zip-invalid', '$', 'ZIP central directory entry is truncated');
    const name = zipName(bytes, cursor + 46, nameLength);
    if (central.has(name)) throw importError('entry-duplicate', name, 'ZIP contains duplicate entry names');
    if ((flags & 0x0001) !== 0 || ![0, 8].includes(method)) throw importError('zip-invalid', name, 'encrypted or unsupported ZIP entry');
    if ([compressedSize, originalSize, localOffset].includes(0xffffffff)) throw importError('zip-invalid', name, 'ZIP64 entries are unsupported');
    if (zipUint32(view, localOffset) !== 0x04034b50) throw importError('zip-invalid', name, 'ZIP local entry is missing');
    const localFlags = zipUint16(view, localOffset + 6);
    const localMethod = zipUint16(view, localOffset + 8);
    const localCrc = zipUint32(view, localOffset + 14);
    const localCompressedSize = zipUint32(view, localOffset + 18);
    const localOriginalSize = zipUint32(view, localOffset + 22);
    const localNameLength = zipUint16(view, localOffset + 26);
    const localExtraLength = zipUint16(view, localOffset + 28);
    const localName = zipName(bytes, localOffset + 30, localNameLength);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localName !== name || localFlags !== flags || localMethod !== method
      || dataOffset + compressedSize > centralOffset) {
      throw importError('zip-invalid', name, 'ZIP local and central entries disagree');
    }
    if ((flags & 0x0008) === 0
      && (localCrc !== crc || localCompressedSize !== compressedSize || localOriginalSize !== originalSize)) {
      throw importError('zip-invalid', name, 'ZIP local and central sizes disagree');
    }
    if ((flags & 0x0008) !== 0) {
      let descriptor = dataOffset + compressedSize;
      if (zipUint32(view, descriptor) === 0x08074b50) descriptor += 4;
      if (zipUint32(view, descriptor) !== crc
        || zipUint32(view, descriptor + 4) !== compressedSize
        || zipUint32(view, descriptor + 8) !== originalSize) {
        throw importError('zip-invalid', name, 'ZIP data descriptor disagrees with the central directory');
      }
    }
    central.set(name, { crc, originalSize });
    cursor = end;
  }
  if (cursor !== eocd) throw importError('zip-invalid', '$', 'ZIP central directory declaration is inconsistent');
  return central;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function indexZip(bytes, limits) {
  if (!(bytes instanceof Uint8Array)) throw Object.assign(new Error('ZIP source must be Uint8Array'), { importError: error('source-invalid', '$', 'source bytes are required') });
  if (bytes.byteLength === 0) throw importError('zip-invalid', '$', 'archive is not a readable ZIP');
  const central = validateZipStructure(bytes);
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
  if (entries.size !== central.size) throw importError('zip-invalid', '$', 'ZIP local and central entry counts disagree');
  for (const [name, declaration] of central) {
    const value = entries.get(name);
    if (value === undefined || value.byteLength !== declaration.originalSize || crc32(value) !== declaration.crc) {
      throw importError('zip-invalid', name, 'ZIP entry length or CRC is invalid');
    }
  }
  return { entries, total };
}

function requireString(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value === '') errors.push(error('field-invalid', path, `${path} must be a non-empty string`));
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function requireTimestamp(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!canonicalTimestamp(value)) errors.push(error('field-invalid', path, `${path} must be a canonical timestamp`));
}

function requireDateNumber(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).valueOf())) {
    errors.push(error('field-invalid', path, `${path} must be a valid millisecond timestamp`));
  }
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
  if (forbiddenKeys.has(descriptor.id)) errors.push(error('field-invalid', `${path}.id`, 'session id is unsafe'));
  requireString(descriptor.title, `${path}.title`, errors, { nullable: true });
  requireDateNumber(descriptor.createdAt, `${path}.createdAt`, errors, { nullable: true });
  requireString(descriptor.origin, `${path}.origin`, errors, { nullable: true });
  requireTimestamp(descriptor.metadataUpdatedAt, `${path}.metadataUpdatedAt`, errors, { nullable: true });
  if (!Array.isArray(descriptor.tags) || descriptor.tags.some((tag) => typeof tag !== 'string')) errors.push(error('metadata-invalid', `${path}.tags`, 'tags must be an array of strings'));
  if (typeof descriptor.note !== 'string' && descriptor.note !== null) errors.push(error('metadata-invalid', `${path}.note`, 'note must be a string or null'));
  if (!isObject(descriptor.workspace) && descriptor.workspace !== null) errors.push(error('field-invalid', `${path}.workspace`, 'workspace must be an object or null'));
  else if (isObject(descriptor.workspace)) {
    const keys = Object.keys(descriptor.workspace).sort();
    if (!sameJson(keys, ['id', 'title'])) errors.push(error('field-invalid', `${path}.workspace`, 'workspace fields are unsupported'));
    if (descriptor.workspace.id !== null && (typeof descriptor.workspace.id !== 'string' || descriptor.workspace.id === '')) errors.push(error('field-invalid', `${path}.workspace.id`, 'workspace.id must be a string or null'));
    if (descriptor.workspace.title !== null && typeof descriptor.workspace.title !== 'string') errors.push(error('field-invalid', `${path}.workspace.title`, 'workspace.title must be a string or null'));
  }
  if (!isObject(descriptor.storage)) errors.push(error('field-invalid', `${path}.storage`, 'storage must be an object'));
  else {
    if (!['ready', 'unavailable'].includes(descriptor.storage.status)) errors.push(error('field-invalid', `${path}.storage.status`, 'storage status is unsupported'));
    if (descriptor.storage.status === 'ready') {
      if (!Number.isSafeInteger(descriptor.storage.sizeBytes) || descriptor.storage.sizeBytes < 0) errors.push(error('field-invalid', `${path}.storage.sizeBytes`, 'storage size must be a nonnegative safe integer'));
      if (!Number.isSafeInteger(descriptor.storage.fileCount) || descriptor.storage.fileCount < 0) errors.push(error('field-invalid', `${path}.storage.fileCount`, 'storage file count must be a nonnegative safe integer'));
    } else if (descriptor.storage.status === 'unavailable'
      && (descriptor.storage.sizeBytes !== null || descriptor.storage.fileCount !== null)) {
      errors.push(error('field-invalid', `${path}.storage`, 'unavailable storage sizes must be null'));
    }
  }
  if (!isObject(descriptor.files)) errors.push(error('field-invalid', `${path}.files`, 'files must be an object'));
  else {
    requireString(descriptor.files.json, `${path}.files.json`, errors);
    requireString(descriptor.files.markdown, `${path}.files.markdown`, errors);
  }
}

function validateSource(record, descriptor, jsonName, errors) {
  if (!isObject(record.source)) {
    errors.push(error('source-invalid', `${jsonName}.source`, 'session source must be an object'));
    return;
  }
  const sourceKeys = Object.keys(record.source).sort();
  const expectedKeys = record.version === 2 ? ['events', 'inheritedEventCount', 'meta'] : ['events', 'meta'];
  if (!sameJson(sourceKeys, expectedKeys)) errors.push(error('source-invalid', `${jsonName}.source`, 'session source fields are unsupported'));
  if (!isObject(record.source.meta)) {
    errors.push(error('source-invalid', `${jsonName}.source.meta`, 'session source meta must be an object'));
  } else if (record.source.meta.id !== descriptor.id) {
    errors.push(error('session-mismatch', `${jsonName}.source.meta.id`, 'source meta id does not match session id'));
  }
  if (!Array.isArray(record.source.events)) {
    errors.push(error('source-invalid', `${jsonName}.source.events`, 'session source events must be an array'));
    return;
  }
  if (record.version === 2) {
    const cut = record.source.inheritedEventCount;
    if (!Number.isSafeInteger(cut) || cut < 0 || cut > record.source.events.length
      || typeof record.source.meta?.isSeeded !== 'boolean'
      || (!record.source.meta.isSeeded && cut !== 0)) {
      errors.push(error('source-invalid', `${jsonName}.source.inheritedEventCount`, 'invalid inherited event boundary'));
    }
  }
  for (let index = 0; index < record.source.events.length; index += 1) {
    const eventValue = record.source.events[index];
    const path = `${jsonName}.source.events[${index}]`;
    if (!isObject(eventValue)) {
      errors.push(error('source-invalid', path, 'session events must be objects'));
      continue;
    }
    if (Object.hasOwn(eventValue, 'time') && eventValue.time !== null) {
      requireDateNumber(eventValue.time, `${path}.time`, errors);
    }
  }
}

/** Validate the complete format semantics shared by export staging and import. */
export function validateBackupSemantics(manifest, records = []) {
  const errors = [];
  if (manifest?.format !== MANIFEST_FORMAT || ![1, 2].includes(manifest?.version)) {
    errors.push(error('format-unsupported', 'manifest.json', 'only export format versions 1 and 2 are supported'));
    return errors;
  }
  if (!Number.isInteger(manifest.sessionCount) || manifest.sessionCount < 1
    || !Array.isArray(manifest.sessions) || manifest.sessions.length !== manifest.sessionCount) {
    errors.push(error('session-count-invalid', 'manifest.sessionCount', 'sessionCount must match the manifest sessions'));
    return errors;
  }
  if (manifest.attachmentsIncluded !== false) {
    errors.push(error('attachments-unsupported', 'manifest.attachmentsIncluded', 'backup packages must not include attachment bytes'));
  }
  requireTimestamp(manifest.exportedAt, 'manifest.exportedAt', errors);
  if (!isObject(manifest.generator)
    || typeof manifest.generator.name !== 'string' || manifest.generator.name === ''
    || typeof manifest.generator.version !== 'string' || manifest.generator.version === '') {
    errors.push(error('field-invalid', 'manifest.generator', 'generator name and version are required'));
  }
  const ids = new Set();
  const referenced = new Set(['manifest.json']);
  for (let index = 0; index < manifest.sessions.length; index += 1) {
    const descriptor = manifest.sessions[index];
    const path = `manifest.sessions[${index}]`;
    validateDescriptor(descriptor, path, errors);
    if (!isObject(descriptor) || typeof descriptor.id !== 'string') continue;
    if (ids.has(descriptor.id)) errors.push(error('session-duplicate', `${path}.id`, 'session IDs must be unique'));
    ids.add(descriptor.id);
    const jsonName = descriptor.files?.json;
    const markdownName = descriptor.files?.markdown;
    if (typeof jsonName === 'string' && typeof markdownName === 'string') {
      if (!safeEntryName(jsonName) || !safeEntryName(markdownName)
        || !jsonName.startsWith('sessions/') || !markdownName.startsWith('sessions/')) {
        errors.push(error('path-unsafe', path, 'manifest file paths must be safe sessions/ paths'));
      }
      if (referenced.has(jsonName) || referenced.has(markdownName)) {
        errors.push(error('entry-duplicate', path, 'manifest references duplicate file paths'));
      }
      referenced.add(jsonName);
      referenced.add(markdownName);
    }
    const record = records[index];
    if (record === undefined) continue;
    const recordPath = typeof jsonName === 'string' ? jsonName : `${path}.files.json`;
    if (record?.format !== SESSION_FORMAT || record?.version !== manifest.version
      || !isObject(record.archive) || record.archive.id !== descriptor.id) {
      errors.push(error('session-mismatch', recordPath, 'session JSON format, version, or archive.id does not match manifest'));
      continue;
    }
    requireTimestamp(record.exportedAt, `${recordPath}.exportedAt`, errors);
    if (!sameJson(record.archive, descriptor)) {
      errors.push(error('session-mismatch', recordPath, 'manifest descriptor does not match session archive descriptor'));
    }
    validateSource(record, descriptor, recordPath, errors);
    try { normalizeMetadata({ tags: descriptor.tags, note: descriptor.note ?? '' }); }
    catch { errors.push(error('metadata-invalid', `${path}.tags`, 'tags or note exceed metadata limits')); }
  }
  return errors;
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
 * Validate a version-one or version-two backup without writing to disk or DSH.
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
    if (manifest?.format !== MANIFEST_FORMAT || ![1, 2].includes(manifest?.version)) throw Object.assign(new Error('unsupported manifest format'), { importError: error('format-unsupported', 'manifest.json', 'only export format versions 1 and 2 are supported') });
    if (!Number.isInteger(manifest.sessionCount) || manifest.sessionCount < 1 || manifest.sessionCount > limits.maxSessions || !Array.isArray(manifest.sessions) || manifest.sessions.length !== manifest.sessionCount) {
      throw Object.assign(new Error('invalid manifest session count'), { importError: error('session-count-invalid', 'manifest.sessionCount', 'sessionCount must match 1..2000 manifest sessions') });
    }
    if (manifest.attachmentsIncluded !== false) throw Object.assign(new Error('attachment bytes are not accepted'), { importError: error('attachments-unsupported', 'manifest.attachmentsIncluded', 'backup packages must not include attachment bytes') });

    const errors = [];
    const referenced = new Set(['manifest.json']);
    const items = [];
    const records = [];
    for (let index = 0; index < manifest.sessions.length; index += 1) {
      const descriptor = manifest.sessions[index];
      const path = `manifest.sessions[${index}]`;
      if (!isObject(descriptor) || typeof descriptor.id !== 'string') continue;
      const jsonName = descriptor.files?.json;
      const markdownName = descriptor.files?.markdown;
      if (typeof jsonName !== 'string' || typeof markdownName !== 'string') continue;
      if (!safeEntryName(jsonName) || !safeEntryName(markdownName) || !jsonName.startsWith('sessions/') || !markdownName.startsWith('sessions/')) {
        continue;
      }
      referenced.add(jsonName); referenced.add(markdownName);
      const jsonBytes = entries.get(jsonName);
      const markdownBytes = entries.get(markdownName);
      if (jsonBytes === undefined) { errors.push(error('entry-missing', jsonName, 'session JSON entry is missing')); continue; }
      if (markdownBytes === undefined) { errors.push(error('entry-missing', markdownName, 'transcript entry is missing')); continue; }
      if (jsonBytes.byteLength > limits.maxJsonBytes) errors.push(error('limit-exceeded', jsonName, 'session JSON exceeds limit'));
      if (markdownBytes.byteLength > limits.maxMarkdownBytes) errors.push(error('limit-exceeded', markdownName, 'transcript exceeds limit'));
      try { decodeUtf8(markdownBytes, markdownName); }
      catch (cause) { errors.push(cause.importError ?? error('utf8-invalid', markdownName, 'entry is not valid UTF-8')); }
      let record;
      try { record = parseJson(jsonBytes, jsonName, limits); }
      catch (cause) { errors.push(cause.importError ?? error('json-invalid', jsonName, 'session JSON is invalid')); continue; }
      records[index] = record;
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
        transcriptSizeBytes: markdownBytes.byteLength,
      });
    }
    errors.push(...validateBackupSemantics(manifest, records));
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
