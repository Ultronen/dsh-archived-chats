import {
  deriveEventMessage,
  isAppendSurfaceEvent,
} from '@deepseek-ai/dsh-session';
import ZipStream from 'zip-stream';

const EXPORT_FORMAT = 'dsh-archived-chats/export';
const SESSION_FORMAT = 'dsh-archived-chats/session';
const TRANSCRIPT_FORMAT = 'dsh-archived-chats/transcript';
const FORMAT_VERSION = 1;
const RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function codePoints(value) {
  return [...value];
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
  if (RESERVED_BASENAME.test(segment)) segment = `${segment}-file`;

  segment = codePoints(segment).slice(0, limit).join('')
    .replace(/^[. -]+|[. -]+$/g, '');
  if (segment === '') return 'untitled';
  if (RESERVED_BASENAME.test(segment)) return `${segment}-file`;
  return segment;
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
export function createManifest(plan, generatorVersion) {
  return {
    format: EXPORT_FORMAT,
    version: FORMAT_VERSION,
    exportedAt: plan.exportedAt,
    generator: { name: 'dsh-archived-chats', version: generatorVersion },
    sessionCount: plan.items.length,
    attachmentsIncluded: false,
    sessions: plan.items.map(manifestSession),
  };
}

/** Create one lossless session record around Harness persistence output. */
export function createSessionRecord(item, inspected, exportedAt) {
  return {
    format: SESSION_FORMAT,
    version: FORMAT_VERSION,
    exportedAt,
    archive: manifestSession(item),
    source: {
      meta: inspected?.meta ?? null,
      events: inspected?.events ?? [],
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

function addZipEntry(archive, source, name, date) {
  return new Promise((resolve, reject) => {
    archive.entry(source, { name, date }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Create a sequential ZIP stream. The first inspection happens before the
 * stream is returned so HTTP callers can still send an ordinary error status.
 */
export async function createExportZip({ plan, inspect, generatorVersion }) {
  if (!Array.isArray(plan?.items) || plan.items.length === 0) {
    throw new TypeError('export plan must contain at least one session');
  }
  if (typeof inspect !== 'function') throw new TypeError('inspect must be a function');

  let firstInspection = await inspect(plan.items[0].id);
  const archive = new ZipStream({ level: 9 });
  const entryDate = new Date(plan.exportedAt);

  const completion = new Promise((resolve, reject) => {
    archive.once('end', resolve);
    archive.once('error', reject);
  });

  const write = async () => {
    await addZipEntry(
      archive,
      formattedJson(createManifest(plan, generatorVersion)),
      'manifest.json',
      entryDate,
    );

    for (let index = 0; index < plan.items.length; index += 1) {
      const item = plan.items[index];
      let inspected = index === 0 ? firstInspection : await inspect(item.id);
      await addZipEntry(
        archive,
        formattedJson(createSessionRecord(item, inspected, plan.exportedAt)),
        item.files.json,
        entryDate,
      );
      await addZipEntry(
        archive,
        renderTranscript(item, inspected?.events, plan.exportedAt),
        item.files.markdown,
        entryDate,
      );
      inspected = null;
      if (index === 0) firstInspection = null;
    }
    archive.finalize();
  };

  void write().catch((error) => {
    archive.destroy(error);
  });

  return {
    stream: archive,
    completion,
    abort(error = new Error('export aborted')) {
      archive.destroy(error);
    },
  };
}
