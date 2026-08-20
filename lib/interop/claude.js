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
  if (value === null || typeof value !== 'object') return typeof value === 'number' && !Number.isFinite(value) ? null : value;
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

function stableValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value !== 'object') return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  if (depth > MAX_RECORD_DEPTH || seen.has(value)) return null;
  seen.add(value);
  let output;
  if (Array.isArray(value)) output = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => stableValue(item, seen, depth + 1));
  else {
    output = {};
    for (const key of Object.keys(value).filter((item) => !FORBIDDEN_KEYS.has(item)).sort()) {
      if (value[key] !== undefined) output[key] = stableValue(value[key], seen, depth + 1);
    }
  }
  seen.delete(value);
  return output;
}

function stableRecord(value) {
  return JSON.stringify(stableValue(value));
}

function eventType(record) {
  return boundedString(record?.type, 100) || 'unknown';
}

function sessionIdFor(record, fallback) {
  const message = isObject(record?.message) ? record.message : {};
  for (const candidate of [
    record?.sessionId, record?.session_id, record?.conversationId, record?.conversation_id,
    message.sessionId, message.session_id,
  ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return boundedString(candidate.trim(), 240);
  }
  return fallback;
}

function inputBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return encoder.encode(value);
  return null;
}

function textFromContent(content) {
  if (typeof content === 'string') return boundedString(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content.slice(0, MAX_COLLECTION_ITEMS)) {
    if (typeof part === 'string') parts.push(part);
    else if (isObject(part) && typeof part.text === 'string') parts.push(part.text);
    else if (isObject(part) && typeof part.value === 'string') parts.push(part.value);
  }
  return boundedString(parts.join(''), MAX_TEXT);
}

function attachmentFrom(value) {
  if (!isObject(value)) return null;
  const type = boundedString(value.type, 40).toLocaleLowerCase('en-US');
  const source = isObject(value.source) ? value.source : value;
  const path = [source.path, source.file_path, source.filePath, value.path, value.file_path, value.filePath]
    .find((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
  const hasAttachmentType = ['image', 'document', 'file', 'attachment'].includes(type)
    || value.mediaType !== undefined || value.mimeType !== undefined || value.attachmentId !== undefined
    || source.mediaType !== undefined || source.mimeType !== undefined;
  if (!path || !hasAttachmentType) return null;
  const result = { path: boundedString(path.trim(), 1000) };
  for (const key of ['mediaType', 'mimeType', 'bytes', 'width', 'height', 'attachmentId']) {
    const candidate = value[key] ?? source[key];
    if (candidate !== undefined && (typeof candidate === 'string' || typeof candidate === 'number')) result[key] = candidate;
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
    } else losses.push(loss('attachment-path-unsafe', line, sessionId, { path: candidate.path }));
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
    type: eventType(record), record: clone(record), ...extra,
  });
}

function blockContent(block) {
  if (typeof block === 'string') return block;
  if (!isObject(block)) return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  return textFromContent(block.content);
}

function toolResultContent(block) {
  if (!isObject(block)) return textFromContent(block);
  if (typeof block.content === 'string') return block.content;
  if (typeof block.output === 'string') return block.output;
  if (typeof block.result === 'string') return block.result;
  return textFromContent(block.content ?? block.output ?? block.result);
}

function messageForRecord(record, line, sessionId, losses, attachments) {
  const type = eventType(record);
  if (!['user', 'assistant', 'tool_use', 'tool_result'].includes(type)) return [];
  const source = isObject(record.message) ? record.message : ['tool_use', 'tool_result'].includes(type)
    ? { role: type === 'tool_use' ? 'assistant' : 'user', content: [record] } : record;
  if (!isObject(record.message) && ['user', 'assistant'].includes(type)) {
    losses.push(loss('record-invalid', line, sessionId, { reason: 'message-object-required', record: clone(record) }));
    return [];
  }
  const declaredRole = boundedString(source.role, 32).toLocaleLowerCase('en-US');
  const expectedRole = type === 'assistant' ? 'assistant' : 'user';
  if (!declaredRole) losses.push(loss('optional-field-missing', line, sessionId, { field: 'message.role' }));
  else if (declaredRole !== expectedRole && !(type === 'user' && declaredRole === 'tool')) {
    losses.push(loss('unsupported-message-role', line, sessionId, { role: declaredRole, record: clone(record) }));
    return [];
  }
  const content = source.content;
  if (!(typeof content === 'string' || Array.isArray(content))) {
    losses.push(loss('record-invalid', line, sessionId, { reason: 'message-content-required', record: clone(record) }));
    return [];
  }
  const blocks = Array.isArray(content) ? content.slice(0, MAX_COLLECTION_ITEMS) : [content];
  const messages = [];
  let textParts = [];
  const flushText = () => {
    if (textParts.length > 0) {
      messages.push({ role: expectedRole, content: boundedString(textParts.join(''), MAX_TEXT), sourceLine: line });
      textParts = [];
    }
  };
  for (const block of blocks) {
    const blockType = isObject(block) ? boundedString(block.type, 80).toLocaleLowerCase('en-US') : 'text';
    if (blockType === 'text' || blockType === 'input_text' || blockType === 'output_text' || typeof block === 'string') {
      textParts.push(blockContent(block));
    } else if (blockType === 'tool_use' || blockType === 'function_call' || type === 'tool_use') {
      flushText();
      const id = boundedString(block?.id ?? block?.tool_use_id ?? record.id, 240);
      messages.push({ role: 'assistant', content: '', toolCall: { name: boundedString(block?.name ?? block?.function?.name, 200), arguments: clone(block?.input ?? block?.arguments ?? {}) ?? {} }, ...(id ? { toolCallId: id } : {}), sourceLine: line });
      if (!id) losses.push(loss('optional-field-missing', line, sessionId, { field: 'tool_use.id' }));
    } else if (blockType === 'tool_result' || blockType === 'function_call_output' || type === 'tool_result') {
      flushText();
      const id = boundedString(block?.tool_use_id ?? block?.call_id ?? block?.toolCallId, 240);
      messages.push({ role: 'tool', content: toolResultContent(block), ...(id ? { toolCallId: id } : {}), sourceLine: line });
      if (!id) losses.push(loss('optional-field-missing', line, sessionId, { field: 'tool_result.tool_use_id' }));
    } else if (['image', 'document', 'file', 'attachment'].includes(blockType)) {
      collectAttachments(block, attachments, losses, line, sessionId);
    } else {
      losses.push(loss('unsupported-content-block', line, sessionId, { type: blockType, block: clone(block) }));
      collectAttachments(block, attachments, losses, line, sessionId);
    }
  }
  flushText();
  collectAttachments(record, attachments, losses, line, sessionId);
  return messages;
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
    const type = eventType(record);
    if (type === 'system' && boundedString(record.subtype, 80).toLocaleLowerCase('en-US') === 'init') {
      group.title = boundedString(record.title ?? record.cwd ?? record.model, 2000) || group.title;
      if (record.cwd || record.workspace) {
        const workspace = isObject(record.workspace) ? record.workspace : { id: record.cwd, title: record.cwd };
        group.workspace = { id: boundedString(workspace.id ?? record.cwd, 240) || null, title: boundedString(workspace.title ?? record.cwd, 2000) || null };
      }
    } else if (type !== 'user' && type !== 'assistant' && type !== 'tool_use' && type !== 'tool_result') {
      losses.push(unsupportedLoss(record, number, id, { subtype: boundedString(record.subtype, 80) || undefined }));
    }
    for (const message of messageForRecord(record, number, id, losses, group.attachments)) group.messages.push(message);
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

export function inspectClaudeJsonl(bytes, options = {}) {
  options = isObject(options) ? options : {};
  const sourceBytes = inputBytes(bytes);
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES;
  const maxLineBytes = Number.isInteger(options.maxLineBytes) && options.maxLineBytes > 0 ? options.maxLineBytes : DEFAULT_MAX_LINE_BYTES;
  const losses = [];
  if (!sourceBytes) {
    losses.push({ code: 'input-invalid', message: 'input must be UTF-8 bytes or text' });
    return { sessions: [], report: createInteropReport({ source: 'claude', losses }) };
  }
  const fallback = typeof options.sessionId === 'string' && options.sessionId.trim() ? boundedString(options.sessionId.trim(), 240) : 'session-1';
  let grouped;
  try { grouped = parseLines(sourceBytes, maxBytes, maxLines, maxLineBytes, losses, fallback); } catch {
    losses.push({ code: 'invalid-utf8', message: 'input is not valid UTF-8' });
    grouped = new Map();
  }
  const sessions = [...grouped.values()].map((group) => createInteropSession({
    id: group.id, title: group.title || group.id, workspace: group.workspace, messages: group.messages,
    attachments: group.attachments, losses: losses.filter((item) => item.sessionId === group.id), source: 'claude',
  }));
  const warnings = sessions.some((session) => session.attachments.length > 0)
    ? [{ code: 'attachment-references', message: 'attachment references are metadata only' }] : [];
  return { sessions, report: createInteropReport({ source: 'claude', sessions: sessions.map((session) => ({ id: session.id, title: session.title })), losses, warnings }) };
}

function exportTextBlock(content) {
  return [{ type: 'text', text: boundedString(content) }];
}

export function exportClaudeJsonl(session, options = {}) {
  const input = isObject(session) ? session : {};
  const id = boundedString(input.id, 240) || 'claude-session';
  const workspace = isObject(input.workspace) ? input.workspace : {};
  const records = [{ type: 'system', subtype: 'init', sessionId: id, ...(typeof workspace.title === 'string' && workspace.title.trim() ? { cwd: boundedString(workspace.title.trim(), 2000) } : {}) }];
  const losses = [];
  const messages = Array.isArray(input.messages) ? input.messages.slice(0, 10000) : [];
  const usedCallIds = new Set(messages.map((message) => boundedString(message?.toolCallId, 240)).filter(Boolean));
  let generatedCall = 0;
  const callIdFor = (message) => {
    const explicit = boundedString(message?.toolCallId, 240);
    if (explicit) return explicit;
    let generated;
    do generated = `toolu-${++generatedCall}`; while (usedCallIds.has(generated));
    usedCallIds.add(generated);
    return generated;
  };
  for (const message of messages) {
    if (!isObject(message)) { losses.push({ code: 'message-invalid' }); continue; }
    const role = boundedString(message.role, 32).toLocaleLowerCase('en-US');
    const content = textFromContent(message.content);
    if (role === 'user') records.push({ type: 'user', sessionId: id, message: { role: 'user', content: exportTextBlock(content) } });
    else if (role === 'assistant') {
      const blocks = [];
      if (message.toolCall && isObject(message.toolCall)) {
        blocks.push({ type: 'tool_use', id: callIdFor(message), name: boundedString(message.toolCall.name, 200), input: clone(message.toolCall.arguments ?? {}) ?? {} });
      }
      if (content !== '' || !message.toolCall) blocks.push(...exportTextBlock(content));
      records.push({ type: 'assistant', sessionId: id, message: { role: 'assistant', content: blocks } });
    } else if (role === 'tool') {
      records.push({ type: 'user', sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callIdFor(message), content }] } });
    } else losses.push({ code: 'unsupported-message-role', role: role || null });
  }
  const bytes = encoder.encode(`${records.map(stableRecord).join('\n')}\n`);
  const warnings = [
    { code: 'native-resume-unsupported', message: 'export is transcript-only and cannot resume a native Claude Code run' },
    { code: 'transcript-handoff', message: 'use the exported transcript for handoff or review' },
  ];
  if (Array.isArray(input.attachments) && input.attachments.length > 0) warnings.push({ code: 'attachments-not-included', message: 'attachment bytes are not exported; references remain outside the transcript' });
  return { bytes, report: createInteropReport({ source: 'claude', sessions: [{ id, title: boundedString(input.title, 2000) || id }], losses, warnings }) };
}
