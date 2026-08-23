import {
  deriveEventMessage,
  isAppendSurfaceEvent,
} from '@deepseek-ai/dsh-session';

export const PREVIEW_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maxPageSize: 200,
  maxSegmentCodePoints: 256 * 1024,
});

export const SEARCH_LIMITS = Object.freeze({
  maxQueryCodePoints: 200,
  defaultSessions: 50,
  maxSessions: 100,
  matchesPerSession: 3,
  excerptCodePoints: 240,
  concurrency: 4,
  cacheEntries: 64,
  cacheTtlMs: 30_000,
  maxCachedCodePoints: 2 * 1024 * 1024,
});

function codePoints(value) {
  return [...String(value ?? '')];
}

function boundedText(value, limit = PREVIEW_LIMITS.maxSegmentCodePoints) {
  const points = codePoints(value);
  if (points.length <= limit) return points.join('');
  return `${points.slice(0, limit).join('')}…`;
}

function jsonText(value) {
  try {
    const rendered = JSON.stringify(value, null, 2);
    return rendered === undefined ? String(value) : rendered;
  } catch {
    return String(value);
  }
}

function imageText(block) {
  const attachment = block?.attachment ?? {};
  return [
    attachment.name,
    attachment.mediaType,
    Number.isFinite(attachment.width) && Number.isFinite(attachment.height)
      ? `${attachment.width}x${attachment.height}`
      : null,
    Number.isFinite(attachment.bytes) ? `${attachment.bytes} bytes` : null,
    attachment.attachmentId,
  ].filter((value) => value !== null && value !== undefined && value !== '').join(' · ');
}

function nestedText(value) {
  if (Array.isArray(value)) return value.map(blockText).filter(Boolean).join('\n\n');
  if (value !== null && typeof value === 'object') return jsonText(value);
  return String(value ?? '');
}

function blockText(block) {
  if (block === null || typeof block !== 'object') return jsonText(block);
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return typeof block.text === 'string' ? block.text : jsonText(block);
    case 'image':
      return imageText(block);
    case 'tool-call':
      return `${String(block.name ?? 'unknown')}\n${typeof block.arguments === 'string' ? block.arguments : jsonText(block.arguments)}`;
    case 'tool-result':
      return nestedText(block.content);
    default:
      return jsonText(block);
  }
}

function projectBlock(block) {
  if (block === null || typeof block !== 'object') {
    return { kind: 'json', label: null, text: boundedText(jsonText(block)), isError: false };
  }
  switch (block.type) {
    case 'text':
      return { kind: 'text', label: null, text: boundedText(typeof block.text === 'string' ? block.text : jsonText(block)), isError: false };
    case 'reasoning':
      return { kind: 'reasoning', label: null, text: boundedText(typeof block.text === 'string' ? block.text : jsonText(block)), isError: false };
    case 'image':
      return { kind: 'image', label: typeof block?.attachment?.name === 'string' ? block.attachment.name : null, text: boundedText(imageText(block)), isError: false };
    case 'tool-call':
      return {
        kind: 'tool-call',
        label: typeof block.name === 'string' && block.name !== '' ? block.name : 'unknown',
        text: boundedText(typeof block.arguments === 'string' ? block.arguments : jsonText(block.arguments)),
        isError: false,
      };
    case 'tool-result':
      return {
        kind: 'tool-result',
        label: typeof block.toolCallId === 'string' ? block.toolCallId : null,
        text: boundedText(nestedText(block.content)),
        isError: block.isError === true,
      };
    default:
      return { kind: 'json', label: String(block.type ?? 'unknown'), text: boundedText(jsonText(block)), isError: false };
  }
}

function messageRole(message) {
  if (message?.source?.kind === 'tool') return 'tool';
  if (message?.role === 'assistant') return 'assistant';
  if (message?.role === 'user') return 'user';
  return 'system';
}

function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US');
}

/** Project append-origin session events into bounded, browser-safe timeline rows. */
export function projectArchivedMessages(events) {
  const messages = [];
  for (let index = 0; index < (Array.isArray(events) ? events.length : 0); index += 1) {
    const event = events[index];
    if (!isAppendSurfaceEvent(event)) continue;
    const message = deriveEventMessage(event);
    if (message === null) continue;
    const segments = (Array.isArray(message.content) ? message.content : [message.content])
      .map(projectBlock);
    const searchable = segments
      .flatMap((segment) => [segment.label, segment.text])
      .filter((value) => typeof value === 'string' && value !== '')
      .join('\n');
    messages.push({
      seq: Number.isFinite(event.seq) ? event.seq : index,
      time: Number.isFinite(event.time) ? event.time : null,
      role: messageRole(message),
      source: typeof message?.source?.kind === 'string' ? message.source.kind : null,
      segments,
      searchable,
      normalized: normalizeSearchText(searchable),
    });
  }
  return messages;
}

function projectedCodePoints(messages) {
  let total = 0;
  for (const message of messages) {
    for (const segment of message.segments) {
      total += codePoints(segment.label).length + codePoints(segment.text).length;
    }
  }
  return total;
}

/** Small TTL/LRU cache for projected archived logs; oversized sessions bypass it. */
export function createProjectedMessageCache(inspect, options = {}) {
  if (typeof inspect !== 'function') throw new TypeError('inspect is required');
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : SEARCH_LIMITS.cacheEntries;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0
    ? options.ttlMs
    : SEARCH_LIMITS.cacheTtlMs;
  const maxCachedCodePoints = Number.isInteger(options.maxCachedCodePoints) && options.maxCachedCodePoints > 0
    ? options.maxCachedCodePoints
    : SEARCH_LIMITS.maxCachedCodePoints;
  const entries = new Map();
  const inFlight = new Map();
  const versions = new Map();

  const touch = (id, entry) => {
    entries.delete(id);
    entries.set(id, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };

  return {
    async get(id) {
      const key = String(id);
      const now = Date.now();
      const existing = entries.get(key);
      if (existing !== undefined && existing.expiresAt > now) {
        touch(key, existing);
        return existing.messages;
      }
      entries.delete(key);
      if (inFlight.has(key)) return inFlight.get(key);
      const version = versions.get(key) ?? 0;
      const pending = Promise.resolve(inspect(key)).then((inspected) => {
        const messages = projectArchivedMessages(inspected?.events);
        if ((versions.get(key) ?? 0) === version && projectedCodePoints(messages) <= maxCachedCodePoints) {
          touch(key, { messages, expiresAt: Date.now() + ttlMs });
        }
        return messages;
      }).finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
      inFlight.set(key, pending);
      return pending;
    },
    invalidate(ids) {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        const key = String(id);
        entries.delete(key);
        versions.set(key, (versions.get(key) ?? 0) + 1);
      }
    },
    clear() {
      entries.clear();
      for (const key of inFlight.keys()) versions.set(key, (versions.get(key) ?? 0) + 1);
    },
  };
}

function pageInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw Object.assign(new Error('preview page is invalid'), { status: 400, code: 'preview-page-invalid' });
  }
  return value;
}

/** Return one stable offset page without exposing the private search corpus. */
export function paginateProjectedMessages(messages, options = {}) {
  const offset = pageInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = pageInteger(options.limit, PREVIEW_LIMITS.defaultPageSize, 1, PREVIEW_LIMITS.maxPageSize);
  const total = Array.isArray(messages) ? messages.length : 0;
  const items = (Array.isArray(messages) ? messages : []).slice(offset, offset + limit)
    .map(({ normalized: _normalized, searchable: _searchable, ...message }) => message);
  const nextOffset = offset + items.length < total ? offset + items.length : null;
  return { offset, limit, total, nextOffset, messages: items };
}

function queryTerms(query) {
  if (typeof query !== 'string') throw Object.assign(new Error('query is required'), { status: 400, code: 'search-query-invalid' });
  const trimmed = query.trim();
  const points = codePoints(trimmed);
  if (points.length === 0 || points.length > SEARCH_LIMITS.maxQueryCodePoints) {
    throw Object.assign(new Error('query length is invalid'), { status: 400, code: 'search-query-invalid' });
  }
  return normalizeSearchText(trimmed).split(/\s+/u).filter(Boolean);
}

function searchSessionLimit(value) {
  if (value === undefined || value === null) return SEARCH_LIMITS.defaultSessions;
  if (!Number.isInteger(value) || value < 1 || value > SEARCH_LIMITS.maxSessions) {
    throw Object.assign(new Error('search limit is invalid'), { status: 400, code: 'search-limit-invalid' });
  }
  return value;
}

function excerptFor(message, terms) {
  const points = codePoints(message.searchable.replace(/\s+/gu, ' ').trim());
  const normalized = normalizeSearchText(points.join(''));
  const first = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const radius = Math.floor(SEARCH_LIMITS.excerptCodePoints / 2);
  const start = Math.max(0, first - radius);
  const end = Math.min(points.length, start + SEARCH_LIMITS.excerptCodePoints);
  return `${start > 0 ? '…' : ''}${points.slice(start, end).join('')}${end < points.length ? '…' : ''}`;
}

/** Search one projected session; every whitespace-separated term must match one event. */
export function searchProjectedMessages(messages, query) {
  const terms = queryTerms(query);
  const matches = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!terms.every((term) => message.normalized.includes(term))) continue;
    matches.push({
      seq: message.seq,
      time: message.time,
      role: message.role,
      excerpt: excerptFor(message, terms),
    });
    if (matches.length >= SEARCH_LIMITS.matchesPerSession) break;
  }
  return matches;
}

/** Inspect archived sessions with bounded concurrency and preserve caller order. */
export async function searchArchivedSessions({ ids, inspect, loadMessages, query, limit }) {
  queryTerms(query);
  if (typeof inspect !== 'function' && typeof loadMessages !== 'function') throw new TypeError('inspect or loadMessages is required');
  const sessionLimit = searchSessionLimit(limit);
  const ordered = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))];
  const found = new Array(ordered.length);
  const skipped = new Array(ordered.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ordered.length) {
      const index = cursor;
      cursor += 1;
      try {
        const messages = typeof loadMessages === 'function'
          ? await loadMessages(ordered[index])
          : projectArchivedMessages((await inspect(ordered[index]))?.events);
        const matches = searchProjectedMessages(messages, query);
        if (matches.length > 0) found[index] = { sessionId: ordered[index], matches };
      } catch (error) {
        skipped[index] = {
          sessionId: ordered[index],
          reason: String(error?.code ?? error?.name ?? 'inspect-failed'),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_LIMITS.concurrency, ordered.length) }, worker));
  return {
    hits: found.filter(Boolean).slice(0, sessionLimit),
    skipped: skipped.filter(Boolean),
  };
}
