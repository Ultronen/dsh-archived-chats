import { createHash } from 'node:crypto';

export const INTEROP_FORMAT = 'dsh-interop';
export const INTEROP_VERSION = 1;

const MAX_SESSIONS = 2000;
const MAX_MESSAGES = 10000;
const MAX_ATTACHMENTS = 1000;
const MAX_LOSSES = 1000;
const MAX_TEXT_LENGTH = 2000;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 50000;
const MAX_CANONICAL_BYTES = 4 * 1024 * 1024;
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '', maxLength = MAX_TEXT_LENGTH) {
  const normalized = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  return Array.from(normalized).slice(0, maxLength).join('') || fallback;
}

function clone(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (depth > 20 || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 10000).map((item) => clone(item, seen, depth + 1));
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) continue;
    output[key] = clone(child, seen, depth + 1);
  }
  seen.delete(value);
  return output;
}

function normalizeWorkspace(workspace) {
  if (!isObject(workspace)) return workspace === null ? null : {};
  return {
    id: text(workspace.id, '', 200) || null,
    title: text(workspace.title, '', MAX_TEXT_LENGTH) || null,
  };
}

function normalizeMessage(message, index) {
  if (!isObject(message)) return clone(message);
  const output = clone(message) ?? {};
  if (typeof message.id === 'string') output.id = text(message.id, `message-${index + 1}`, 200);
  if (typeof message.role === 'string') output.role = text(message.role, '', 32).toLocaleLowerCase('en-US');
  if (typeof message.content === 'string') output.content = message.content;
  if (Array.isArray(message.content)) output.content = clone(message.content);
  return output;
}

function normalizeAttachment(attachment) {
  return clone(attachment) ?? {};
}

function normalizeList(value, mapper, max) {
  return Array.isArray(value) ? value.slice(0, max).map(mapper) : [];
}

export function createInteropSession({
  id,
  title,
  workspace = null,
  messages = [],
  attachments = [],
  losses = [],
  source = '',
} = {}) {
  return {
    id: text(id, 'session', 240),
    title: text(title, 'Untitled chat', MAX_TEXT_LENGTH),
    workspace: normalizeWorkspace(workspace),
    messages: normalizeList(messages, normalizeMessage, MAX_MESSAGES),
    attachments: normalizeList(attachments, normalizeAttachment, MAX_ATTACHMENTS),
    losses: normalizeList(losses, (item) => clone(item), MAX_LOSSES),
    source: text(source, '', 120),
  };
}

class CanonicalLimitError extends Error {
  constructor(message) {
    super(message);
    this.code = 'manifest-bounded';
  }
}

function canonical(value, state, depth = 0) {
  if (depth > MAX_CANONICAL_DEPTH) throw new CanonicalLimitError('manifest nesting exceeds the validation limit');
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES) throw new CanonicalLimitError('manifest contains too many values');
  if (Array.isArray(value)) return boundedText(`[${value.map((item) => canonical(item, state, depth + 1)).join(',')}]`, state);
  if (isObject(value)) {
    return boundedText(`{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], state, depth + 1)}`).join(',')}}`, state);
  }
  if (value === undefined) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  return boundedText(JSON.stringify(value), state);
}

function boundedText(value, state) {
  const textValue = String(value);
  state.bytes += textValue.length;
  if (state.bytes > MAX_CANONICAL_BYTES) throw new CanonicalLimitError('manifest canonical form exceeds the validation limit');
  return textValue;
}

function manifestProjection(manifest) {
  return {
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    source: manifest.source,
    sourceVersion: manifest.sourceVersion,
    exportedAt: manifest.exportedAt,
    sessions: Array.isArray(manifest.sessions) ? manifest.sessions.map((session) => ({
      id: session?.id,
      title: session?.title,
      workspace: session?.workspace,
      messages: session?.messages,
      attachments: session?.attachments,
      losses: session?.losses,
      source: session?.source,
    })) : manifest.sessions,
  };
}

function manifestDigest(manifest) {
  const state = { nodes: 0, bytes: 0 };
  return createHash('sha256').update(canonical(manifestProjection(manifest), state)).digest('hex');
}

export function createInteropManifest({
  source,
  sourceVersion,
  sessions = [],
  exportedAt = new Date().toISOString(),
} = {}) {
  const value = {
    format: INTEROP_FORMAT,
    formatVersion: INTEROP_VERSION,
    source: text(source, '', 120),
    sourceVersion: text(typeof sourceVersion === 'number' && Number.isFinite(sourceVersion) ? String(sourceVersion) : sourceVersion, '', 120),
    exportedAt: exportedAt instanceof Date ? exportedAt.toISOString() : text(exportedAt, '', 80),
    sessions: normalizeList(sessions, (item) => createInteropSession(item ?? {}), MAX_SESSIONS),
  };
  value.sha256 = manifestDigest(value);
  return value;
}

function error(code, path, message) {
  return { code, path, message };
}

function safeAttachmentPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f]/u.test(part));
}

function validateMessage(message, path, errors) {
  if (!isObject(message)) {
    errors.push(error('message-invalid', path, 'message must be an object'));
    return;
  }
  if (typeof message.role !== 'string' || !MESSAGE_ROLES.has(message.role)) errors.push(error('message-invalid', `${path}.role`, 'message role is unsupported'));
  if (!(typeof message.content === 'string' || Array.isArray(message.content))) errors.push(error('message-invalid', `${path}.content`, 'message content must be text or an array'));
  if (message.id !== undefined && (typeof message.id !== 'string' || message.id.trim() === '')) errors.push(error('message-invalid', `${path}.id`, 'message id must be a non-empty string'));
}

function validateSession(session, path, errors, seenIds) {
  if (!isObject(session)) {
    errors.push(error('session-invalid', path, 'session must be an object'));
    return;
  }
  if (typeof session.id !== 'string' || session.id.trim() === '') errors.push(error('session-id-required', `${path}.id`, 'session id must be a non-empty string'));
  else if (seenIds.has(session.id)) errors.push(error('session-duplicate', `${path}.id`, `duplicate session id ${session.id}`));
  else seenIds.add(session.id);
  if (typeof session.title !== 'string' || session.title.trim() === '') errors.push(error('field-invalid', `${path}.title`, 'session title must be a non-empty string'));
  if (!Array.isArray(session.messages) || session.messages.length > MAX_MESSAGES) errors.push(error('messages-invalid', `${path}.messages`, 'messages must be a bounded array'));
  else session.messages.forEach((message, index) => validateMessage(message, `${path}.messages[${index}]`, errors));
  if (!Array.isArray(session.attachments) || session.attachments.length > MAX_ATTACHMENTS) errors.push(error('attachments-invalid', `${path}.attachments`, 'attachments must be a bounded array'));
  else session.attachments.forEach((attachment, index) => {
    const attachmentPath = `${path}.attachments[${index}]`;
    if (!isObject(attachment) || !safeAttachmentPath(attachment.path)) errors.push(error('attachment-path-unsafe', `${attachmentPath}.path`, 'attachment path must be relative and safe'));
  });
  if (!Array.isArray(session.losses) || session.losses.length > MAX_LOSSES) errors.push(error('losses-invalid', `${path}.losses`, 'losses must be a bounded array'));
}

export function validateInteropManifest(manifest) {
  try {
    const errors = [];
    if (!isObject(manifest)) return { ok: false, errors: [error('manifest-invalid', '$', 'manifest must be an object')] };
    if (manifest.format !== INTEROP_FORMAT) errors.push(error('format-unsupported', '$.format', `format must be ${INTEROP_FORMAT}`));
    if (manifest.formatVersion !== INTEROP_VERSION) errors.push(error('version-unsupported', '$.formatVersion', `only format version ${INTEROP_VERSION} is supported`));
    if (typeof manifest.source !== 'string' || manifest.source.trim() === '') errors.push(error('source-required', '$.source', 'source is required'));
    if (typeof manifest.sourceVersion !== 'string' || manifest.sourceVersion.trim() === '') errors.push(error('source-version-required', '$.sourceVersion', 'sourceVersion is required'));
    if (typeof manifest.exportedAt !== 'string' || !Number.isFinite(Date.parse(manifest.exportedAt))) errors.push(error('exported-at-invalid', '$.exportedAt', 'exportedAt must be a valid date'));
    if (!Array.isArray(manifest.sessions) || manifest.sessions.length > MAX_SESSIONS) errors.push(error('sessions-invalid', '$.sessions', 'sessions must be a bounded array'));
    else {
      const seenIds = new Set();
      manifest.sessions.forEach((session, index) => validateSession(session, `$.sessions[${index}]`, errors, seenIds));
    }
    if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) errors.push(error('sha256-invalid', '$.sha256', 'sha256 must be a lowercase SHA-256 digest'));
    else {
      try {
        if (manifestDigest(manifest) !== manifest.sha256) errors.push(error('sha256-mismatch', '$.sha256', 'sha256 does not match the manifest contents'));
      } catch (cause) {
        if (cause?.code === 'manifest-bounded') errors.push(error('manifest-bounded', '$', cause.message));
        else throw cause;
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: clone(manifest) };
  } catch (cause) {
    return { ok: false, errors: [error('manifest-invalid', '$', `manifest could not be validated: ${String(cause?.message ?? cause)}`)] };
  }
}

export { safeAttachmentPath };
