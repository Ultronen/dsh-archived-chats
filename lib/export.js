import {
  deriveEventMessage,
  isAppendSurfaceEvent,
} from '@deepseek-ai/dsh-session';
import { Readable } from 'node:stream';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { IMPORT_LIMITS, validateBackupSemantics, validateJsonValue } from './import.js';

const EXPORT_FORMAT = 'dsh-archived-chats/export';
const SESSION_FORMAT = 'dsh-archived-chats/session';
const TRANSCRIPT_FORMAT = 'dsh-archived-chats/transcript';
const FORMAT_VERSION = 1;
const RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function codePoints(value) {
  return [...value];
}

/**
 * Neutralize a Windows device name. The reservation covers every extension too
 * (`NUL.txt` is the device), so the marker has to change the base name instead
 * of trailing the whole segment.
 */
function deviceSafe(segment) {
  if (!RESERVED_BASENAME.test(segment)) return segment;
  const dot = segment.indexOf('.');
  return dot === -1 ? `${segment}-file` : `${segment.slice(0, dot)}-file${segment.slice(dot)}`;
}

/** Normalize untrusted text into one cross-platform archive path segment. */
export function safeSegment(value, fallback = 'untitled', maxLength = 80) {
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 80;
  let segment = typeof value === 'string' ? value.normalize('NFKC') : '';
  segment = segment
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*\s]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '');

  if (segment === '') segment = String(fallback).normalize('NFKC');

  // Truncate first: shortening can itself expose a reserved base name, and the
  // marker is applied exactly once afterwards so it never stacks.
  segment = codePoints(segment).slice(0, limit).join('')
    .replace(/^[. -]+|[. -]+$/g, '');
  if (segment === '') return 'untitled';
  return deviceSafe(segment);
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeStorage(storage) {
  if (storage?.status === 'ready'
    && Number.isFinite(storage.sizeBytes)
    && Number.isFinite(storage.fileCount)) {
    return {
      status: 'ready',
      sizeBytes: storage.sizeBytes,
      fileCount: storage.fileCount,
    };
  }
  return { status: 'unavailable', sizeBytes: null, fileCount: null };
}

function normalizeDescriptor(descriptor) {
  return {
    id: descriptor.id,
    title: nullableString(descriptor.title),
    workspace: {
      id: nullableString(descriptor.workspaceId),
      title: nullableString(descriptor.workspaceTitle),
    },
    createdAt: nullableNumber(descriptor.createdAt),
    origin: nullableString(descriptor.origin),
    metadataUpdatedAt: nullableString(descriptor.metadataUpdatedAt),
    tags: Array.isArray(descriptor.tags)
      ? descriptor.tags.filter((tag) => typeof tag === 'string')
      : [],
    note: nullableString(descriptor.note),
    storage: normalizeStorage(descriptor.storage),
  };
}

function safeIdSuffix(id) {
  const safe = safeSegment(id, 'session', 160);
  return codePoints(safe).slice(-8).join('');
}

function uniqueDirectory(base, used) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase('en-US'))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

/** Build stable filenames and normalized descriptors for an export request. */
export function planExport(descriptors, exportedAt = new Date()) {
  const instant = exportedAt instanceof Date ? exportedAt : new Date(exportedAt);
  if (Number.isNaN(instant.getTime())) throw new TypeError('exportedAt must be a valid date');

  const seenIds = new Set();
  const usedDirectories = new Set();
  const items = [];
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    if (descriptor === null || typeof descriptor !== 'object' || typeof descriptor.id !== 'string') continue;
    if (seenIds.has(descriptor.id)) continue;
    seenIds.add(descriptor.id);

    const archive = normalizeDescriptor(descriptor);
    const index = String(items.length + 1).padStart(3, '0');
    const title = safeSegment(archive.title, 'untitled', 80);
    const leaf = uniqueDirectory(`${index}-${title}-${safeIdSuffix(archive.id)}`, usedDirectories);
    const directory = `sessions/${leaf}`;
    items.push({
      ...archive,
      directory,
      files: {
        json: `${directory}/session.json`,
        markdown: `${directory}/transcript.md`,
      },
    });
  }

  const date = instant.toISOString().slice(0, 10);
  const filename = items.length === 1
    ? `dsh-archived-chat-${safeSegment(items[0].title, 'untitled', 60)}-${date}.zip`
    : `dsh-archived-chats-${items.length}-${date}.zip`;
  return { exportedAt: instant.toISOString(), filename, items };
}

function manifestSession(item) {
  return {
    id: item.id,
    title: item.title,
    workspace: item.workspace,
    createdAt: item.createdAt,
    origin: item.origin,
    metadataUpdatedAt: item.metadataUpdatedAt,
    tags: item.tags,
    note: item.note,
    storage: item.storage,
    files: item.files,
  };
}

/** Create the authoritative inventory for one ZIP package. */
export function createManifest(plan, generatorVersion, formatVersion = FORMAT_VERSION) {
  return {
    format: EXPORT_FORMAT,
    version: formatVersion,
    exportedAt: plan.exportedAt,
    generator: { name: 'dsh-archived-chats', version: generatorVersion },
    sessionCount: plan.items.length,
    attachmentsIncluded: false,
    sessions: plan.items.map(manifestSession),
  };
}

/** Create one lossless session record around Harness persistence output. */
export function createSessionRecord(item, inspected, exportedAt) {
  const hasBoundary = Object.hasOwn(inspected ?? {}, 'inheritedEventCount');
  if (hasBoundary && (!Number.isSafeInteger(inspected.inheritedEventCount)
    || inspected.inheritedEventCount < 0 || inspected.inheritedEventCount > inspected.events?.length
    || (!inspected.meta?.isSeeded && inspected.inheritedEventCount !== 0))) {
    throw Object.assign(new Error('invalid inherited event boundary'), { code: 'export-source-invalid' });
  }
  return {
    format: SESSION_FORMAT,
    version: hasBoundary ? 2 : FORMAT_VERSION,
    exportedAt,
    archive: manifestSession(item),
    source: {
      meta: inspected?.meta ?? null,
      events: inspected?.events ?? [],
      ...(hasBoundary ? { inheritedEventCount: inspected.inheritedEventCount } : {}),
    },
  };
}

function yamlValue(value) {
  return value === null || value === undefined ? 'null' : JSON.stringify(value);
}

function jsonText(value) {
  try {
    const rendered = JSON.stringify(value, null, 2);
    return rendered === undefined ? String(value) : rendered;
  } catch {
    return String(value);
  }
}

function fenced(language, value) {
  const text = String(value);
  const runs = text.match(/`+/g) ?? [];
  const width = Math.max(3, ...runs.map((run) => run.length + 1));
  const fence = '`'.repeat(width);
  return `${fence}${language}\n${text}\n${fence}`;
}

function renderImage(block) {
  const attachment = block?.attachment ?? {};
  const name = typeof attachment.name === 'string' && attachment.name !== ''
    ? attachment.name
    : 'unnamed image';
  const details = [
    attachment.mediaType,
    Number.isFinite(attachment.width) && Number.isFinite(attachment.height)
      ? `${attachment.width}x${attachment.height}`
      : null,
    Number.isFinite(attachment.bytes) ? `${attachment.bytes} bytes` : null,
    attachment.attachmentId,
  ].filter((value) => value !== null && value !== undefined && value !== '');
  return `[Image: ${name}${details.length > 0 ? ` - ${details.join(', ')}` : ''}]`;
}

function renderContentBlock(block) {
  if (block === null || typeof block !== 'object') return fenced('json', jsonText(block));
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : fenced('json', jsonText(block));
    case 'reasoning':
      return `### Reasoning\n\n${fenced('text', typeof block.text === 'string' ? block.text : jsonText(block))}`;
    case 'image':
      return renderImage(block);
    case 'tool-call': {
      const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'unknown';
      const args = typeof block.arguments === 'string' ? block.arguments : jsonText(block.arguments);
      return `### Tool call: ${name}\n\nCall ID: \`${String(block.id ?? 'unknown')}\`\n\n${fenced('json', args)}`;
    }
    case 'tool-result': {
      const status = block.isError === true ? ' (error)' : '';
      const nested = Array.isArray(block.content)
        ? block.content.map(renderContentBlock).filter(Boolean).join('\n\n')
        : fenced('json', jsonText(block.content));
      return `### Tool result \`${String(block.toolCallId ?? 'unknown')}\`${status}\n\n${nested}`;
    }
    default:
      return fenced('json', jsonText(block));
  }
}

function messageLabel(message) {
  if (message?.source?.kind === 'tool') return 'Tool result';
  if (message?.role === 'assistant') return 'Assistant';
  if (message?.role === 'user') return 'User';
  return 'System';
}

function isoTimestamp(value) {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

/** Render the durable human transcript from append-origin Harness messages. */
export function renderTranscript(item, events, exportedAt) {
  const lines = [
    '---',
    `format: ${yamlValue(TRANSCRIPT_FORMAT)}`,
    `version: ${FORMAT_VERSION}`,
    `exportedAt: ${yamlValue(exportedAt)}`,
    `id: ${yamlValue(item.id)}`,
    `title: ${yamlValue(item.title)}`,
    `workspaceId: ${yamlValue(item.workspace.id)}`,
    `workspaceTitle: ${yamlValue(item.workspace.title)}`,
    `createdAt: ${yamlValue(item.createdAt)}`,
    `origin: ${yamlValue(item.origin)}`,
    `tags: ${yamlValue(item.tags)}`,
    `note: ${yamlValue(item.note)}`,
    `metadataUpdatedAt: ${yamlValue(item.metadataUpdatedAt)}`,
    '---',
    '',
    `# ${item.title ?? 'Untitled archived chat'}`,
  ];

  for (const event of Array.isArray(events) ? events : []) {
    if (!isAppendSurfaceEvent(event)) continue;
    const message = deriveEventMessage(event);
    if (message === null) continue;
    const isoTime = isoTimestamp(event.time);
    const timestamp = isoTime === null ? '' : ` - ${isoTime}`;
    const content = Array.isArray(message.content)
      ? message.content.map(renderContentBlock).filter(Boolean).join('\n\n')
      : fenced('json', jsonText(message.content));
    lines.push('', `## ${messageLabel(message)}${timestamp}`, '', content);
  }

  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n`;
}

function formattedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Bytes handed to one synchronous deflate call. fflate compresses on the calling
 * thread, so a whole entry at once would stall the event loop for the length of
 * its compression. Slicing bounds each stall to a few milliseconds while leaving
 * the archive byte-for-byte deterministic for a given plan.
 */
const ZIP_ENTRY_SLICE_BYTES = 256 * 1024;
const ZIP_COMPRESSION_LEVEL = 9;
const ZIP_STREAM_HIGH_WATER_MARK = 64 * 1024;

/**
 * Bridge fflate's callback-driven archive into a Node readable. fflate pushes
 * synchronously from `push()`, so the chunks are queued and drained through the
 * readable's own backpressure instead of being forwarded directly.
 */
function createArchiveStream(staged, entryDate) {
  const state = {
    queue: [],
    parked: null,
    halted: false,
    started: false,
    failure: null,
    finalized: false,
  };

  const stream = new Readable({
    highWaterMark: ZIP_STREAM_HIGH_WATER_MARK,
    read() {
      if (state.parked !== null) {
        const resume = state.parked;
        state.parked = null;
        resume();
      }
      if (!state.started) {
        state.started = true;
        void pump();
      }
    },
    destroy(error, done) {
      // Release a producer parked on backpressure, otherwise the pump would wait
      // for a read that a destroyed stream never issues.
      state.halted = true;
      if (state.parked !== null) {
        const resume = state.parked;
        state.parked = null;
        resume();
      }
      done(error);
    },
  });

  const archive = new Zip((error, chunk) => {
    if (error) {
      state.failure ??= error;
      return;
    }
    if (chunk !== null && chunk.byteLength > 0) state.queue.push(chunk);
  });

  const stopped = () => state.halted || stream.destroyed;

  /** Push one chunk, waiting for the consumer when the buffer is full. */
  const emit = async (chunk) => {
    if (stopped()) return false;
    if (stream.push(chunk)) return true;
    await new Promise((resolve) => { state.parked = resolve; });
    return !stopped();
  };

  /** Forward everything fflate produced for the current push. */
  const drain = async () => {
    while (state.queue.length > 0) {
      const chunk = state.queue.shift();
      if (!(await emit(chunk))) return false;
    }
    return !stopped();
  };

  const pump = async () => {
    try {
      for (const entry of staged) {
        const file = new ZipDeflate(entry.name, { level: ZIP_COMPRESSION_LEVEL });
        file.mtime = entryDate;
        archive.add(file);
        const bytes = strToU8(entry.source);
        if (bytes.byteLength === 0) {
          file.push(bytes, true);
          if (!(await drain())) return;
          continue;
        }
        for (let offset = 0; offset < bytes.byteLength; offset += ZIP_ENTRY_SLICE_BYTES) {
          const end = Math.min(offset + ZIP_ENTRY_SLICE_BYTES, bytes.byteLength);
          const last = end >= bytes.byteLength;
          file.push(bytes.subarray(offset, end), last);
          if (!(await drain())) return;
          // Yield between slices so other requests keep their turn on the loop.
          if (!last && !stopped()) await new Promise((resolve) => { setImmediate(resolve); });
        }
        if (stopped()) return;
      }
      archive.end();
      if (!(await drain())) return;
      if (state.failure !== null) throw state.failure;
      state.finalized = true;
      stream.push(null);
    } catch (error) {
      stream.destroy(error);
    }
  };

  const completion = new Promise((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
  });

  return { stream, completion, archive };
}

/**
 * Create a sequential ZIP stream. The first inspection happens before the
 * stream is returned so HTTP callers can still send an ordinary error status.
 */
export async function createExportZip({ plan, inspect, generatorVersion, limits: limitOverrides }) {
  if (!Array.isArray(plan?.items) || plan.items.length === 0) {
    throw new TypeError('export plan must contain at least one session');
  }
  if (typeof inspect !== 'function') throw new TypeError('inspect must be a function');

  const limits = { ...IMPORT_LIMITS, ...(limitOverrides ?? {}) };
  const fail = (message) => { throw Object.assign(new Error(message), { code: 'export-limit-exceeded' }); };
  if (plan.items.length > limits.maxSessions || 1 + (plan.items.length * 2) > limits.maxEntries) {
    fail('export session or entry count exceeds import limits');
  }

  let firstInspection = await inspect(plan.items[0].id);
  const formatVersion = Object.hasOwn(firstInspection ?? {}, 'inheritedEventCount') ? 2 : 1;
  const manifest = createManifest(plan, generatorVersion, formatVersion);
  const manifestText = formattedJson(manifest);
  const manifestBytes = Buffer.byteLength(manifestText, 'utf8');
  if (manifestBytes > limits.maxManifestBytes || manifestBytes > limits.maxEntryBytes
    || validateJsonValue(manifest, limits) !== null) fail('export manifest exceeds import limits');

  const staged = [{ source: manifestText, name: 'manifest.json' }];
  const records = [];
  let totalBytes = manifestBytes;
  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index];
    let inspected = index === 0 ? firstInspection : await inspect(item.id);
    const record = createSessionRecord(item, inspected, plan.exportedAt);
    if (record.version !== formatVersion) throw new Error('inconsistent export source format');
    const json = formattedJson(record);
    records[index] = JSON.parse(json);
    const markdown = renderTranscript(item, inspected?.events, plan.exportedAt);
    const jsonBytes = Buffer.byteLength(json, 'utf8');
    const markdownBytes = Buffer.byteLength(markdown, 'utf8');
    if (jsonBytes > limits.maxJsonBytes || jsonBytes > limits.maxEntryBytes
      || markdownBytes > limits.maxMarkdownBytes || markdownBytes > limits.maxEntryBytes
      || validateJsonValue(record, limits) !== null) fail(`export session ${item.id} exceeds import limits`);
    totalBytes += jsonBytes + markdownBytes;
    if (totalBytes > limits.maxUncompressedBytes) fail('export package exceeds import expansion limit');
    staged.push({ source: json, name: item.files.json }, { source: markdown, name: item.files.markdown });
    inspected = null;
    if (index === 0) firstInspection = null;
  }
  const semanticErrors = validateBackupSemantics(manifest, records);
  if (records.some((record) => record.version === 1 && record.source?.meta?.isSeeded === true)) {
    semanticErrors.push({ code: 'source-invalid', path: '$.source.meta.isSeeded', message: 'seeded v1 sources lack an inherited boundary' });
  }
  if (semanticErrors.length > 0) {
    throw Object.assign(new Error('export source is invalid'), { code: 'export-source-invalid', errors: semanticErrors });
  }

  const entryDate = new Date(plan.exportedAt);
  const { stream, completion, archive } = createArchiveStream(staged, entryDate);

  return {
    stream,
    completion,
    abort(error = new Error('export aborted')) {
      archive.terminate();
      stream.destroy(error);
    },
  };
}
