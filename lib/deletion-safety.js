import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, parse, relative, sep } from 'node:path';

function failure(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function unsafe(message) {
  return failure('session-location-unsafe', message, 409);
}

function unavailable(message) {
  return failure('session-location-unavailable', message, 503);
}

function safeId(id) {
  return typeof id === 'string' && id !== '' && id !== '.' && id !== '..'
    && !id.includes('/') && !id.includes('\\') && !id.includes('\0')
    && !isAbsolute(id) && !/^[A-Za-z]:/u.test(id) && !/^\\\\/u.test(id);
}

function inside(parent, candidate) {
  const offset = relative(parent, candidate);
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

async function checkedStat(path, kind) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw unsafe(`${kind} uses a symbolic link or junction`);
    return stat;
  } catch (cause) {
    if (cause?.code === 'session-location-unsafe') throw cause;
    throw unavailable(`${kind} cannot be inspected`);
  }
}

async function checkCanonicalDirectoryAncestry(path, checked) {
  let current = path;
  while (!checked.has(current)) {
    const stat = await checkedStat(current, 'canonical deletion ancestry');
    if (!stat.isDirectory()) throw unsafe('canonical deletion ancestry is not a directory');
    checked.add(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Resolve the recursively removable directory for one session. The Host's full
 * current inventory is treated as authority: every listed location must be
 * readable, session-scoped, non-linking, and disjoint from the requested tree.
 * The returned deletion directory is canonical and its complete ancestry has
 * been checked, so a lexical platform alias or higher link is never passed to
 * recursive removal.
 * A missing requested header is a successful restart state, not permission to
 * infer a path from stale registry data.
 */
export async function resolveExclusiveSessionDirectory(persistence, sessionId) {
  if (!safeId(sessionId)) throw unsafe('session id is not a safe directory name');
  if (typeof persistence?.list !== 'function' || typeof persistence?.locate !== 'function') {
    throw unavailable('session location inventory is unavailable');
  }

  let headers;
  try { headers = await persistence.list(); }
  catch { throw unavailable('session location inventory is unavailable'); }
  if (!Array.isArray(headers)) throw unavailable('session location inventory is invalid');

  const ids = new Set();
  const entries = [];
  for (const header of headers) {
    const id = header?.id;
    if (!safeId(id) || ids.has(id)) throw unsafe('session location inventory has an unsafe or duplicate id');
    ids.add(id);
    let location;
    try { location = await persistence.locate(header); }
    catch { throw unavailable('session location inventory cannot be resolved'); }
    const rawPath = location?.path;
    if (typeof rawPath !== 'string' || rawPath === '' || rawPath.includes('\0') || !isAbsolute(rawPath)) {
      throw unsafe('session location must be an absolute file path');
    }
    const path = normalize(rawPath);
    if (path !== rawPath) throw unsafe('session location must be normalized');
    const directory = dirname(path);
    if (directory === parse(path).root || basename(directory) !== id) {
      throw unsafe('session location is not session-scoped');
    }
    entries.push({ id, path, directory });
  }

  const checkedCanonicalDirectories = new Set();
  for (const entry of entries) {
    const parent = dirname(entry.directory);
    const storageRoot = dirname(parent);
    if (storageRoot !== parse(storageRoot).root) {
      const storageRootStat = await checkedStat(storageRoot, 'storage-root ancestor');
      if (!storageRootStat.isDirectory()) throw unsafe('storage-root ancestor is not a directory');
    }
    const parentStat = await checkedStat(parent, 'session-root ancestor');
    if (!parentStat.isDirectory()) throw unsafe('session-root ancestor is not a directory');
    const directoryStat = await checkedStat(entry.directory, 'session directory');
    if (!directoryStat.isDirectory()) throw unsafe('session directory is not a directory');
    const fileStat = await checkedStat(entry.path, 'session location');
    if (!fileStat.isFile()) throw unsafe('session location is not a regular file');
    try {
      entry.realDirectory = await realpath(entry.directory);
      entry.realPath = await realpath(entry.path);
    } catch { throw unavailable('session location cannot be canonicalized'); }
    await checkCanonicalDirectoryAncestry(entry.realDirectory, checkedCanonicalDirectories);
    if (!inside(entry.realDirectory, entry.realPath)) throw unsafe('session location escapes its directory');
  }

  const target = entries.find((entry) => entry.id === sessionId);
  if (target === undefined) return { status: 'missing', sessionDirectory: null };
  for (const entry of entries) {
    if (entry === target) continue;
    if (inside(target.realDirectory, entry.realPath)
      || inside(entry.realDirectory, target.realPath)
      || inside(target.realDirectory, entry.realDirectory)
      || inside(entry.realDirectory, target.realDirectory)) {
      throw unsafe('session locations overlap');
    }
  }
  return { status: 'present', sessionDirectory: target.realDirectory };
}
