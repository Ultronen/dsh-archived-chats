const EXPORT_FORMAT = 'dsh-archived-chats/export';
const SESSION_FORMAT = 'dsh-archived-chats/session';
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
