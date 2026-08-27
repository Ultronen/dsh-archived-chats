import {
  deriveEventMessage,
  isAppendSurfaceEvent,
} from '@deepseek-ai/dsh-session';

export const PREVIEW_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maxPageSize: 200,
  maxSegmentCodePoints: 256 * 1024,
  maxIdentityCodePoints: 1024,
  maxSegmentsPerMessage: 1000,
  maxMessageCodePoints: 1024 * 1024,
  maxProjectedMessages: 10000,
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
  const points = [];
  for (const point of String(value ?? '')) {
    if (points.length >= limit) return `${points.join('')}…`;
    points.push(point);
  }
  return points.join('');
}

function identityText(value) {
  if (typeof value !== 'string' || value === '') return null;
  let length = 0;
  for (const _point of value) {
    length += 1;
    if (length > PREVIEW_LIMITS.maxIdentityCodePoints) return null;
  }
  return value;
}

function projectedJson(value, budget, depth = 0, ancestors = new WeakSet()) {
  if (typeof value === 'string') {
    const text = boundedText(value, Math.max(0, budget.remaining));
    budget.remaining = Math.max(0, budget.remaining - codePoints(text).length);
    return text;
  }
  if (value === null || typeof value !== 'object') {
    const text = String(value);
    budget.remaining = Math.max(0, budget.remaining - text.length);
    return value;
  }
  if (depth >= 32 || budget.nodes >= 10000 || budget.remaining === 0) return '[truncated]';
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  budget.nodes += 1;
  let output;
  if (Array.isArray(value)) {
    output = [];
    for (let index = 0; index < value.length && index < 1000 && budget.remaining > 0; index += 1) {
      output.push(projectedJson(value[index], budget, depth + 1, ancestors));
    }
    if (output.length < value.length) output.push('[truncated]');
  } else {
    output = Object.create(null);
    let count = 0;
    let truncated = false;
    for (const rawKey in value) {
      if (!Object.hasOwn(value, rawKey)) continue;
      if (count >= 1000 || budget.remaining <= 0) { truncated = true; break; }
      const key = boundedText(rawKey, Math.min(1024, budget.remaining));
      budget.remaining = Math.max(0, budget.remaining - codePoints(key).length);
      output[key] = projectedJson(value[rawKey], budget, depth + 1, ancestors);
      count += 1;
    }
    if (truncated) output['…'] = '[truncated]';
  }
  ancestors.delete(value);
  return output;
}

function jsonText(value, limit = PREVIEW_LIMITS.maxSegmentCodePoints) {
  try {
    const rendered = JSON.stringify(projectedJson(value, { remaining: limit, nodes: 0 }), null, 2);
    return boundedText(rendered === undefined ? String(value) : rendered, limit);
  } catch {
    return boundedText(String(value), limit);
  }
}

function imageText(block, attachmentOverride) {
  const attachment = attachmentOverride === undefined ? (block?.attachment ?? {}) : (attachmentOverride ?? {});
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

function imageAttachment(block) {
  const ref = block?.attachment;
  if (ref === null || typeof ref !== 'object') return null;
  const attachmentId = identityText(ref.attachmentId);
  if (attachmentId === null) return null;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)) return null;
  if (!Number.isInteger(ref.bytes) || ref.bytes < 0) return null;
  if (!Number.isInteger(ref.width) || ref.width <= 0) return null;
  if (!Number.isInteger(ref.height) || ref.height <= 0) return null;
  const displayName = typeof ref.name === 'string'
    ? boundedText(ref.name.replace(/^.*[\\/]/u, ''), 512)
    : '';
  return {
    attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(displayName !== '' ? { name: displayName } : {}),
    ...(Number.isInteger(ref?.originalDimensions?.width)
      && Number.isInteger(ref?.originalDimensions?.height)
      && ref.originalDimensions.width > 0
      && ref.originalDimensions.height > 0
      ? { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }
      : {}),
  };
}

function nestedText(value, limit = PREVIEW_LIMITS.maxSegmentCodePoints) {
  if (Array.isArray(value)) {
    const parts = [];
    let remaining = limit;
    for (const item of value) {
      if (remaining <= 0) break;
      const part = blockText(item, remaining);
      if (part !== '') {
        parts.push(part);
        remaining -= codePoints(part).length + (parts.length > 1 ? 2 : 0);
      }
    }
    return boundedText(parts.join('\n\n'), limit);
  }
  if (value !== null && typeof value === 'object') return jsonText(value, limit);
  return boundedText(value, limit);
}

function blockText(block, limit = PREVIEW_LIMITS.maxSegmentCodePoints) {
  if (block === null || typeof block !== 'object') return jsonText(block, limit);
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return typeof block.text === 'string' ? boundedText(block.text, limit) : jsonText(block, limit);
    case 'image':
      return boundedText(imageText(block), limit);
    case 'tool-call':
      return boundedText(`${boundedText(block.name ?? 'unknown', Math.min(limit, 1024))}\n${typeof block.arguments === 'string' ? boundedText(block.arguments, limit) : jsonText(block.arguments, limit)}`, limit);
    case 'tool-result':
      return nestedText(block.content, limit);
    default:
      return jsonText(block, limit);
  }
}

function projectBlock(block, limit = PREVIEW_LIMITS.maxSegmentCodePoints) {
  const boundedLimit = Math.min(limit, PREVIEW_LIMITS.maxSegmentCodePoints);
  if (block === null || typeof block !== 'object') {
    return { kind: 'json', label: null, text: jsonText(block, boundedLimit), isError: false };
  }
  switch (block.type) {
    case 'text':
      return { kind: 'text', label: null, text: typeof block.text === 'string' ? boundedText(block.text, boundedLimit) : jsonText(block, boundedLimit), isError: false };
    case 'reasoning':
      return { kind: 'reasoning', label: null, text: typeof block.text === 'string' ? boundedText(block.text, boundedLimit) : jsonText(block, boundedLimit), isError: false };
    case 'image': {
      const attachment = imageAttachment(block);
      return {
        kind: 'image',
        label: attachment?.name ?? null,
        text: boundedText(imageText(block, attachment), boundedLimit),
        isError: attachment === null,
        attachment,
      };
    }
    case 'tool-call': {
      const name = boundedText(typeof block.name === 'string' && block.name !== '' ? block.name : 'unknown', boundedLimit);
      const argumentsText = typeof block.arguments === 'string'
        ? boundedText(block.arguments, boundedLimit)
        : jsonText(block.arguments, boundedLimit);
      return {
        kind: 'tool-call',
        label: name,
        text: argumentsText,
        isError: false,
        callId: identityText(block.id),
        name,
        argumentsText,
      };
    }
    case 'tool-result': {
      const text = nestedText(block.content, boundedLimit);
      const toolCallId = identityText(block.toolCallId);
      return {
        kind: 'tool-result',
        label: toolCallId,
        text,
        isError: block.isError === true,
        toolCallId,
      };
    }
    default:
      return { kind: 'json', label: boundedText(block.type ?? 'unknown', 1024), text: jsonText(block, boundedLimit), isError: false };
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
    if (messages.length >= PREVIEW_LIMITS.maxProjectedMessages) break;
    const event = events[index];
    if (!isAppendSurfaceEvent(event)) continue;
    const message = deriveEventMessage(event);
    if (message === null) continue;
    const content = Array.isArray(message.content) ? message.content : [message.content];
    const segments = [];
    let remaining = PREVIEW_LIMITS.maxMessageCodePoints;
    for (let offset = 0; offset < content.length && offset < PREVIEW_LIMITS.maxSegmentsPerMessage && remaining > 0; offset += 1) {
      const segment = projectBlock(content[offset], remaining);
      segments.push(segment);
      remaining -= projectedCodePoints([{ segments: [segment] }]);
    }
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

export function findProjectedImage(messages, attachmentId) {
  if (typeof attachmentId !== 'string' || attachmentId === '') return null;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const segment of Array.isArray(message?.segments) ? message.segments : []) {
      if (segment?.kind === 'image' && segment?.attachment?.attachmentId === attachmentId) {
        return segment.attachment;
      }
    }
  }
  return null;
}

function projectedCodePoints(messages) {
  let total = 0;
  for (const message of messages) {
    for (const segment of message.segments) {
      total += codePoints(segment.label).length + codePoints(segment.text).length;
      total += codePoints(segment.callId).length;
      total += codePoints(segment.name).length;
      total += codePoints(segment.argumentsText).length;
      total += codePoints(segment.toolCallId).length;
      total += codePoints(segment.attachment?.attachmentId).length;
      total += codePoints(segment.attachment?.name).length;
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
  const points = [];
  for (const point of trimmed) {
    points.push(point);
    if (points.length > SEARCH_LIMITS.maxQueryCodePoints) break;
  }
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
  const firstUtf16 = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const first = codePoints(normalized.slice(0, firstUtf16)).length;
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
export async function searchArchivedSessions({ ids, inspect, loadMessages, query, limit, signal }) {
  queryTerms(query);
  if (typeof inspect !== 'function' && typeof loadMessages !== 'function') throw new TypeError('inspect or loadMessages is required');
  const sessionLimit = searchSessionLimit(limit);
  const ordered = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))];
  const hits = [];
  const skipped = [];
  for (let start = 0; start < ordered.length && hits.length < sessionLimit; start += SEARCH_LIMITS.concurrency) {
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('search aborted'), { code: 'request-aborted', status: 499 });
    const batch = ordered.slice(start, start + SEARCH_LIMITS.concurrency);
    const results = await Promise.all(batch.map(async (id) => {
      try {
        const messages = typeof loadMessages === 'function'
          ? await loadMessages(id)
          : projectArchivedMessages((await inspect(id))?.events);
        const matches = searchProjectedMessages(messages, query);
        return matches.length > 0 ? { hit: { sessionId: id, matches } } : {};
      } catch (error) {
        return { skipped: { sessionId: id, reason: String(error?.code ?? error?.name ?? 'inspect-failed') } };
      }
    }));
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('search aborted'), { code: 'request-aborted', status: 499 });
    for (const result of results) {
      if (result.hit !== undefined && hits.length < sessionLimit) hits.push(result.hit);
      if (result.skipped !== undefined) skipped.push(result.skipped);
    }
  }
  return {
    hits,
    skipped,
  };
}
