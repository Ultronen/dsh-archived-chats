function invalid(message) {
  return Object.assign(new TypeError(message), { code: 'persistence-response-invalid' });
}

function objectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatedSnapshots(value) {
  if (!Array.isArray(value)) throw invalid('persistence list response must be an array');
  const ids = new Set();
  for (const snapshot of value) {
    if (!objectLike(snapshot) || !objectLike(snapshot.header)) {
      throw invalid('persistence snapshot header is invalid');
    }
    const id = snapshot.header.id;
    if (typeof id !== 'string' || id === '' || ids.has(id)) {
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
 * The current API remains deliberately read-only here: its handle writer and
 * physical backend layout have no legacy equivalent safe enough to invent.
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

  return Object.freeze({
    async list() {
      return (await listSnapshots()).map((snapshot) => snapshot.header);
    },
    listSnapshots,
    async inspect(id) {
      const handle = await raw.open.call(raw, id, 'read');
      if (!objectLike(handle) || typeof handle.close !== 'function') {
        throw invalid('persistence read handle is invalid');
      }
      try {
        if (!objectLike(handle.header)
          || typeof handle.header.id !== 'string'
          || handle.header.id !== id
          || !Number.isSafeInteger(handle.inheritedEventCount)
          || handle.inheritedEventCount < 0
          || typeof handle.read !== 'function') {
          throw invalid('persistence read handle metadata is invalid');
        }
        if (handle.inheritedEventCount > 0) throw inspectionUnsupported();
        const events = await handle.read.call(handle, 0, undefined);
        if (!Array.isArray(events)) throw invalid('persistence read response must be an event array');
        return { meta: handle.header, events };
      } finally {
        await handle.close.call(handle);
      }
    },
  });
}
