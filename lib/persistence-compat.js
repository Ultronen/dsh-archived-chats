import { isAbsolute } from 'node:path';

function invalid(message) {
  return Object.assign(new TypeError(message), { code: 'persistence-response-invalid' });
}

function objectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatedHeader(value, expectedId) {
  if (!objectLike(value)
    || (value.version !== 2 && value.version !== 3)
    || typeof value.id !== 'string'
    || value.id === ''
    || (expectedId !== undefined && value.id !== expectedId)
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || typeof value.isSeeded !== 'boolean'
    || Object.hasOwn(value, 'seedLength')
    || (value.cwd !== undefined && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)))
    || (value.parentSession !== undefined && typeof value.parentSession !== 'string')
    || (value.origin !== undefined && value.origin !== 'subagent')
    || (value.delegationDepth !== undefined
      && (!Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0))
    || (value.agentPreset !== undefined && typeof value.agentPreset !== 'string')) {
    throw invalid('persistence session header is invalid');
  }
  return value;
}

function validatedSnapshots(value) {
  if (!Array.isArray(value)) throw invalid('persistence list response must be an array');
  const ids = new Set();
  for (const snapshot of value) {
    if (!objectLike(snapshot)) {
      throw invalid('persistence snapshot header is invalid');
    }
    const header = validatedHeader(snapshot.header);
    const id = header.id;
    if (ids.has(id)) {
      throw invalid('persistence snapshot identity is invalid or ambiguous');
    }
    if (typeof snapshot.revision !== 'string' || snapshot.revision === '') {
      throw invalid('persistence snapshot revision is invalid');
    }
    for (const key of ['eventCount', 'sizeBytes']) {
      if (Object.hasOwn(snapshot, key)
        && (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0)) {
        throw invalid(`persistence snapshot ${key} is invalid`);
      }
    }
    ids.add(id);
  }
  return value;
}

function inspectionUnsupported() {
  return Object.assign(
    new Error('sessions with inherited events cannot be inspected without preserving the inherited cut'),
    { code: 'session-inspection-unsupported', status: 501 },
  );
}

/**
 * Present the legacy read contract consumed by this plugin over either the
 * released inspect/list surface or the current handle-based persistence API.
 * Keep handle creation separate from legacy create/append: their return values
 * and durability contracts differ. Restore callers own and close this handle.
 * Providers exposing locate supply rollback paths without guessing a layout.
 */
export function resolvePersistenceCompat(raw) {
  if (typeof raw?.inspect === 'function') return raw;
  if (typeof raw?.list !== 'function' || typeof raw?.open !== 'function') {
    throw Object.assign(new TypeError('supported session persistence reads are required'), {
      code: 'persistence-read-unsupported',
    });
  }

  async function listSnapshots() {
    return validatedSnapshots(await raw.list.call(raw));
  }

  async function inspect(id, allowInherited = false) {
    const handle = await raw.open.call(raw, id, 'read');
    if (!objectLike(handle) || typeof handle.close !== 'function') {
      throw invalid('persistence read handle is invalid');
    }
    try {
      const header = validatedHeader(handle.header, id);
      if (!Number.isSafeInteger(handle.inheritedEventCount)
        || handle.inheritedEventCount < 0 || typeof handle.read !== 'function'
        || (!header.isSeeded && handle.inheritedEventCount !== 0)) {
        throw invalid('persistence read handle metadata is invalid');
      }
      if (!allowInherited && handle.inheritedEventCount > 0) throw inspectionUnsupported();
      const slice = await handle.read.call(handle, 0, undefined);
      const events = Array.isArray(slice) ? slice : slice?.events;
      if (!Array.isArray(events)) throw invalid('persistence read response must be an event array');
      if (handle.inheritedEventCount > events.length) throw invalid('inherited boundary exceeds the event log');
      return { meta: header, events, ...(allowInherited ? { inheritedEventCount: handle.inheritedEventCount } : {}) };
    } finally {
      await handle.close.call(handle);
    }
  }

  return Object.freeze({
    ...(typeof raw.create === 'function' ? {
      async createWriteHandle(header, options) {
        validatedHeader(header);
        return raw.create.call(raw, header, options);
      },
    } : {}),
    ...(typeof raw.locate === 'function' ? {
      async locate(header) {
        validatedHeader(header);
        const location = await raw.locate.call(raw, header);
        if (location === undefined) return undefined;
        if (!objectLike(location)
          || typeof location.kind !== 'string' || location.kind === ''
          || typeof location.path !== 'string' || !isAbsolute(location.path)) {
          throw Object.assign(new Error('session-scoped log location is unavailable'), {
            code: 'session-location-unavailable',
          });
        }
        return location;
      },
    } : {}),
    async list() {
      return (await listSnapshots()).map((snapshot) => snapshot.header);
    },
    listSnapshots,
    async inspect(id) {
      return inspect(id);
    },
    // Full, read-only storage inspection. Consumers that persist this payload
    // must retain the inherited cut beside the header and complete event log.
    async readSession(id) {
      return inspect(id, true);
    },
    // A title read never exposes a lossy event payload. Backups use readSession
    // and retain its boundary, while legacy inspect keeps its strict contract.
    async readTitle(id) {
      const { events } = await inspect(id, true);
      let title;
      for (const event of events) {
        if (event?.type === 'session/title' && typeof event.data?.title === 'string'
          && event.data.title.trim() !== '') title = event.data.title;
      }
      return title;
    },
  });
}
