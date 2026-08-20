import { TextDecoder, TextEncoder } from 'node:util';

import { createInteropSession, safeAttachmentPath } from './format.js';
import { createInteropReport } from './report.js';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINES = 20000;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_TEXT = 200000;
const MAX_RECORD_DEPTH = 12;
const MAX_RECORD_NODES = 5000;
const MAX_COLLECTION_ITEMS = 1000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, max = MAX_TEXT) {
  return typeof value === 'string' ? Array.from(value).slice(0, max).join('') : '';
}

function clone(value, seen = new WeakSet(), depth = 0, state = { nodes: 0 }) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }
  if (depth > MAX_RECORD_DEPTH || seen.has(value) || ++state.nodes > MAX_RECORD_NODES) return null;
  seen.add(value);
  let output;
  if (Array.isArray(value)) output = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => clone(item, seen, depth + 1, state));
  else {
    output = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_COLLECTION_ITEMS)) {
      if (!FORBIDDEN_KEYS.has(key)) output[key] = clone(child, seen, depth + 1, state);
    }
  }
  seen.delete(value);
  return output;
}

function recordType(record) {
  return boundedString(record?.type, 80) || 'unknown';
}

function payloadType(record) {
  return boundedString(record?.payload?.type, 120) || recordType(record);
}

function sessionIdFor(record, fallback) {
  const payload = isObject(record?.payload) ? record.payload : {};
  for (const candidate of [
    record?.session_id, record?.sessionId, payload.session_id, payload.sessionId,
    record?.conversation_id, payload.conversation_id,
    recordType(record) === 'session_meta' ? payload.id : null,
  ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return boundedString(candidate.trim(), 240);
  }
  return fallback;
}

function textFromContent(content) {
  if (typeof content === 'string') return boundedString(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content.slice(0, MAX_COLLECTION_ITEMS)) {
    if (typeof part === 'string') parts.push(part);
    else if (isObject(part) && typeof part.text === 'string') parts.push(part.text);
    else if (isObject(part) && typeof part.value === 'string' &&
      (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')) parts.push(part.value);
  }
  return boundedString(parts.join(''), MAX_TEXT);
}

function attachmentFrom(value) {
  if (!isObject(value)) return null;
  const nested = isObject(value.attachment);
  const attachment = nested ? value.attachment : value;
  const path = [attachment.path, attachment.file_path, attachment.filePath, nested ? attachment.name : null]
    .find((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
  if (!path) return null;
  const result = { path: boundedString(path.trim(), 1000) };
  for (const key of ['mediaType', 'mimeType', 'bytes', 'width', 'height', 'attachmentId']) {
    if (attachment[key] !== undefined && (typeof attachment[key] === 'string' || typeof attachment[key] === 'number')) result[key] = attachment[key];
  }
  return result;
}

function collectAttachments(value, output, losses, line, sessionId, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_RECORD_DEPTH || seen.has(value)) return;
  seen.add(value);
  const candidate = attachmentFrom(value);
  if (candidate) {
    if (safeAttachmentPath(candidate.path)) {
      if (!output.some((item) => item.path === candidate.path)) output.push(candidate);
    } else losses.push({ code: 'attachment-path-unsafe', line, sessionId, path: candidate.path });
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_COLLECTION_ITEMS)) collectAttachments(item, output, losses, line, sessionId, seen, depth + 1);
  } else {
    for (const child of Object.values(value).slice(0, MAX_COLLECTION_ITEMS)) collectAttachments(child, output, losses, line, sessionId, seen, depth + 1);
  }
  seen.delete(value);
}

function loss(code, line, sessionId, extra = {}) {
  const item = { code };
  if (line !== undefined) item.line = line;
  if (sessionId !== undefined) item.sessionId = sessionId;
  return Object.assign(item, extra);
}

function unsupportedLoss(record, line, sessionId, extra = {}) {
  return loss('unsupported-event', line, sessionId, {
    type: payloadType(record), recordType: recordType(record), record: clone(record), ...extra,
  });
}

function messageForRecord(record, line, sessionId, losses, attachments) {
  const payload = isObject(record?.payload) ? record.payload : {};
  const type = payloadType(record);
  let message = null;
  if (recordType(record) === 'event_msg') {
    if (type === 'user_message') message = { role: 'user', content: textFromContent(payload.message ?? payload.text ?? payload.content) };
    else if (type === 'agent_message' || type === 'assistant_message') message = { role: 'assistant', content: textFromContent(payload.message ?? payload.text ?? payload.content) };
    else if (type === 'tool_call' || type === 'function_call') message = {
      role: 'assistant', content: '', toolCall: { name: boundedString(payload.name ?? payload.function?.name, 200), arguments: clone(payload.arguments ?? payload.parameters) ?? boundedString(payload.arguments ?? payload.parameters) },
      toolCallId: boundedString(payload.call_id ?? payload.callId, 240) || undefined,
    };
    else if (type === 'tool_result' || type === 'function_call_output') message = {
      role: 'tool', content: textFromContent(payload.output ?? payload.result ?? payload.message ?? payload.content),
      toolCallId: boundedString(payload.call_id ?? payload.callId, 240) || undefined,
    };
    else if (!['turn_started', 'turn_completed', 'task_started', 'task_completed', 'thread_started', 'thread_completed'].includes(type)) losses.push(unsupportedLoss(record, line, sessionId, { type }));
  } else if (recordType(record) === 'response_item') {
    if (type === 'message') {
      const role = boundedString(payload.role, 32).toLocaleLowerCase('en-US');
      if (['user', 'assistant', 'system', 'tool'].includes(role)) {
        message = { role, content: textFromContent(payload.content ?? payload.message) };
        if (payload.tool_call_id || payload.toolCallId) message.toolCallId = boundedString(payload.tool_call_id ?? payload.toolCallId, 240);
      } else losses.push(loss('unsupported-message-role', line, sessionId, { role: role || null, record: clone(record) }));
    } else if (type === 'function_call') message = {
      role: 'assistant', content: '', toolCall: { name: boundedString(payload.name ?? payload.function?.name, 200), arguments: clone(payload.arguments) ?? boundedString(payload.arguments) },
      toolCallId: boundedString(payload.call_id ?? payload.callId, 240) || undefined,
    };
    else if (type === 'function_call_output') message = {
      role: 'tool', content: textFromContent(payload.output ?? payload.result ?? payload.message),
      toolCallId: boundedString(payload.call_id ?? payload.callId, 240) || undefined,
    };
    else losses.push(unsupportedLoss(record, line, sessionId, { type }));
  } else if (recordType(record) !== 'session_meta') losses.push(unsupportedLoss(record, line, sessionId));

  if (message) {
    if (message.content === '' && !message.toolCall && message.role !== 'tool') losses.push(loss('empty-message', line, sessionId));
    if (message.toolCallId === undefined) delete message.toolCallId;
    collectAttachments(payload, attachments, losses, line, sessionId);
    message.sourceLine = line;
  }
  return message;
}

function inputBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return encoder.encode(value);
  return null;
}

function parseLines(bytes, maxBytes, maxLines, maxLineBytes, losses, initialSessionId) {
  const bounded = bytes.subarray(0, Math.min(bytes.byteLength, maxBytes));
  if (bytes.byteLength > maxBytes) losses.push({ code: 'input-bounded', message: `input exceeds ${maxBytes} bytes` });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const grouped = new Map();
  let currentSessionId = initialSessionId;
  let start = 0;
  let lineNumber = 0;
  let parsedLines = 0;
  const consume = (raw, number) => {
    const lineBytes = raw[raw.length - 1] === 13 ? raw.subarray(0, raw.length - 1) : raw;
    if (lineBytes.byteLength > maxLineBytes) { losses.push(loss('line-bounded', number, currentSessionId)); return; }
    let line;
    try { line = decoder.decode(lineBytes); } catch { losses.push(loss('invalid-utf8', number, currentSessionId)); return; }
    if (line.trim() === '') return;
    let record;
    try { record = JSON.parse(line); } catch { losses.push(loss('malformed-json', number, currentSessionId)); return; }
    if (!isObject(record)) { losses.push(loss('record-invalid', number, currentSessionId)); return; }
    const id = sessionIdFor(record, currentSessionId);
    currentSessionId = id;
    if (!grouped.has(id)) grouped.set(id, { id, title: '', workspace: null, messages: [], attachments: [] });
    const group = grouped.get(id);
    const payload = isObject(record.payload) ? record.payload : {};
    if (recordType(record) === 'session_meta') {
      group.title = boundedString(payload.title ?? payload.name ?? payload.cwd, 2000) || group.title;
      if (payload.cwd || payload.workspace) {
        const workspace = isObject(payload.workspace) ? payload.workspace : { id: payload.cwd, title: payload.cwd };
        group.workspace = { id: boundedString(workspace.id ?? payload.cwd, 240) || null, title: boundedString(workspace.title ?? payload.cwd, 2000) || null };
      }
    }
    const message = messageForRecord(record, number, id, losses, group.attachments);
    if (message) group.messages.push(message);
  };
  while (start <= bounded.byteLength && parsedLines < maxLines) {
    const newline = bounded.indexOf(10, start);
    const end = newline < 0 ? bounded.byteLength : newline;
    lineNumber += 1;
    consume(bounded.subarray(start, end), lineNumber);
    parsedLines += 1;
    if (newline < 0) break;
    start = end + 1;
  }
  if (start < bounded.byteLength || parsedLines >= maxLines && bounded.indexOf(10, start) >= 0) losses.push({ code: 'line-count-bounded', maxLines });
  return grouped;
}

export function inspectCodexJsonl(bytes, options = {}) {
  options = isObject(options) ? options : {};
  const sourceBytes = inputBytes(bytes);
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES;
  const maxLineBytes = Number.isInteger(options.maxLineBytes) && options.maxLineBytes > 0 ? options.maxLineBytes : DEFAULT_MAX_LINE_BYTES;
  const losses = [];
  if (!sourceBytes) {
    losses.push({ code: 'input-invalid', message: 'input must be UTF-8 bytes or text' });
    return { sessions: [], report: createInteropReport({ source: 'codex', losses }) };
  }
  const fallback = typeof options.sessionId === 'string' && options.sessionId.trim() ? boundedString(options.sessionId.trim(), 240) : 'session-1';
  let grouped;
  try { grouped = parseLines(sourceBytes, maxBytes, maxLines, maxLineBytes, losses, fallback); } catch {
    losses.push({ code: 'invalid-utf8', message: 'input is not valid UTF-8' });
    grouped = new Map();
  }
  const sessions = [...grouped.values()].map((group) => createInteropSession({
    id: group.id, title: group.title || group.id, workspace: group.workspace, messages: group.messages,
    attachments: group.attachments, losses: losses.filter((item) => item.sessionId === group.id), source: 'codex',
  }));
  const warnings = sessions.some((session) => session.attachments.length > 0)
    ? [{ code: 'attachment-references', message: 'attachment references are metadata only' }] : [];
  return { sessions, report: createInteropReport({ source: 'codex', sessions: sessions.map((session) => ({ id: session.id, title: session.title })), losses, warnings }) };
}

function stableValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_RECORD_DEPTH || seen.has(value)) return null;
  seen.add(value);
  let output;
  if (Array.isArray(value)) output = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => stableValue(item, seen, depth + 1));
  else {
    output = {};
    for (const key of Object.keys(value).filter((key) => !FORBIDDEN_KEYS.has(key)).sort()) {
      if (value[key] !== undefined) output[key] = stableValue(value[key], seen, depth + 1);
    }
  }
  seen.delete(value);
  return output;
}

function stableRecord(record) {
  return JSON.stringify(stableValue(record));
}

export function exportCodexJsonl(session, options = {}) {
  const input = isObject(session) ? session : {};
  const id = boundedString(input.id, 240) || 'codex-session';
  const workspace = isObject(input.workspace) ? input.workspace : {};
  const meta = { id };
  if (typeof workspace.title === 'string' && workspace.title.trim()) meta.cwd = boundedString(workspace.title.trim(), 2000);
  const records = [{ type: 'session_meta', payload: meta }];
  const losses = [];
  const messages = Array.isArray(input.messages) ? input.messages.slice(0, 10000) : [];
  let generatedCall = 0;
  for (const message of messages) {
    if (!isObject(message)) { losses.push({ code: 'message-invalid' }); continue; }
    const role = boundedString(message.role, 32).toLocaleLowerCase('en-US');
    const content = textFromContent(message.content);
    if (role === 'user' || role === 'assistant' || role === 'system') {
      if (message.toolCall && isObject(message.toolCall)) {
        const callId = boundedString(message.toolCallId, 240) || `call-${++generatedCall}`;
        const args = typeof message.toolCall.arguments === 'string' ? boundedString(message.toolCall.arguments) : stableRecord(message.toolCall.arguments ?? {});
        records.push({ type: 'response_item', payload: { type: 'function_call', name: boundedString(message.toolCall.name, 200), call_id: callId, arguments: args } });
      }
      if (content !== '') records.push({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: content }] } });
    } else if (role === 'tool') {
      const callId = boundedString(message.toolCallId, 240) || `call-${++generatedCall}`;
      records.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: content } });
    } else losses.push({ code: 'unsupported-message-role', role: role || null });
  }
  const bytes = encoder.encode(`${records.map(stableRecord).join('\n')}\n`);
  const warnings = [
    { code: 'native-resume-unsupported', message: 'export is transcript-only and cannot resume a native Codex run' },
    { code: 'transcript-handoff', message: 'use the exported transcript for handoff or review' },
  ];
  if (Array.isArray(input.attachments) && input.attachments.length > 0) warnings.push({ code: 'attachments-not-included', message: 'attachment bytes are not exported; references remain outside the transcript' });
  return { bytes, report: createInteropReport({ source: 'codex', sessions: [{ id, title: boundedString(input.title, 2000) || id }], losses, warnings }) };
}
