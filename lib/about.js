import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const HOME = 'https://github.com/Ultronen/dsh-archived-chats';
const REGISTRY_URL = 'https://registry.npmjs.org/dsh-archived-chats/latest';
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_FORCE_COOLDOWN_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 5 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

const IDENTITY = Object.freeze({
  name: manifest.name,
  author: manifest.author,
  license: manifest.license,
  links: Object.freeze({
    home: HOME,
    feedback: `${HOME}/issues/new/choose`,
    guide: `${HOME}/blob/main/docs/USER_GUIDE.zh-CN.md`,
    guideZh: `${HOME}/blob/main/docs/USER_GUIDE.zh-CN.md`,
    guideEn: `${HOME}/blob/main/docs/USER_GUIDE.md`,
    changelog: `${HOME}/blob/main/CHANGELOG.md`,
    marketplace: 'https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/',
  }),
});

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (match === null) return null;
  const core = match.slice(1, 4);
  if (core.some((part) => part.length > 1 && part.startsWith('0'))) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { core, prerelease };
}

function compareNumeric(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : (left < right ? -1 : 1);
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumeric(left.core[index], right.core[index]);
    if (order !== 0) return order;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function readLimitedText(response, maxBytes) {
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && declared !== '') {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) throw new Error('registry response is too large');
  }
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('registry response is invalid');
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('registry response is too large');
        chunks.push(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* Best-effort release. */ }
      throw error;
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }
  if (typeof response.text !== 'function') throw new Error('registry response is invalid');
  const text = await response.text();
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('registry response is too large');
  return text;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

export function createAboutRouteHandlers({ service, guard, readBody, send }) {
  return {
    async about(req, res) {
      if (req.method !== 'GET') {
        send(res, 405, { error: 'method-not-allowed' });
        return;
      }
      send(res, 200, service.about());
    },
    async checkUpdates(req, res) {
      if (!guard(req, res)) return;
      let body;
      try {
        body = await readBody(req, 1024);
      } catch (error) {
        send(res, error?.status ?? 400, { error: 'about-check-invalid' });
        return;
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'force')
        || typeof body.force !== 'boolean') {
        send(res, 400, { error: 'about-check-invalid' });
        return;
      }
      try {
        send(res, 200, await service.checkUpdates({ force: body.force }));
      } catch {
        send(res, 500, { error: 'about-check-failed' });
      }
    },
  };
}

export function createAboutService({
  version = manifest.version,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  forceCooldownMs = DEFAULT_FORCE_COOLDOWN_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const installed = parseSemver(version);
  if (installed === null) throw new TypeError('package version must be valid SemVer');
  if (typeof now !== 'function') throw new TypeError('clock is required');
  positiveInteger(cacheTtlMs, 'cache TTL');
  positiveInteger(forceCooldownMs, 'force cooldown');
  positiveInteger(timeoutMs, 'timeout');
  positiveInteger(maxResponseBytes, 'response size limit');

  let update = { status: 'unchecked', latestVersion: null, checkedAt: null };
  let lastCheckedAt = null;
  let lastForcedAt = null;
  let inFlight = null;

  const clock = () => {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a valid time');
    return milliseconds;
  };

  const about = () => ({
    ...IDENTITY,
    links: { ...IDENTITY.links },
    version,
    update: { ...update },
  });

  const performCheck = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('registry request timed out')), timeoutMs);
    try {
      if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
      const registryResponse = await fetchImpl(REGISTRY_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      const contentType = registryResponse?.headers?.get?.('content-type');
      if (registryResponse?.ok !== true || registryResponse.status !== 200 || registryResponse.redirected === true
        || (contentType !== null && contentType !== undefined && !/^application\/json(?:\s*;|$)/i.test(contentType))) {
        throw new Error('registry response is invalid');
      }
      const body = JSON.parse(await readLimitedText(registryResponse, maxResponseBytes));
      const latest = body !== null && typeof body === 'object' && !Array.isArray(body)
        && body.name === manifest.name
        ? parseSemver(body.version) : null;
      if (latest === null) throw new Error('registry version is invalid');
      update = {
        status: compareSemver(latest, installed) > 0 ? 'available' : 'current',
        latestVersion: body.version,
        checkedAt: null,
      };
    } catch {
      update = { status: 'unavailable', latestVersion: update.latestVersion, checkedAt: null };
    } finally {
      clearTimeout(timer);
      lastCheckedAt = clock();
      update.checkedAt = new Date(lastCheckedAt).toISOString();
    }
    return about();
  };

  return {
    about,
    checkUpdates({ force } = {}) {
      if (typeof force !== 'boolean') return Promise.reject(new TypeError('force must be a boolean'));
      const time = clock();
      if (inFlight !== null) {
        if (force) lastForcedAt = time;
        return inFlight;
      }
      if (force) {
        if (lastForcedAt !== null && time - lastForcedAt < forceCooldownMs) return Promise.resolve(about());
        lastForcedAt = time;
      } else if (lastCheckedAt !== null && time - lastCheckedAt < cacheTtlMs) {
        return Promise.resolve(about());
      }
      inFlight = performCheck().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
