import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP']);
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EISDIR', 'EPERM']);

function directorySyncUnsupported(error) {
  return DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)
    || (process.platform === 'win32' && WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(error?.code));
}

/** Flush a file after it has been written. `r+` is supported on Windows. */
export async function syncFile(path, openFile = open) {
  const handle = await openFile(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Flush directory-entry changes where the platform exposes directory fsync. */
export async function syncDirectory(path, openFile = open) {
  let handle;
  try { handle = await openFile(path, 'r'); }
  catch (error) {
    if (directorySyncUnsupported(error)) return false;
    throw error;
  }
  try {
    await handle.sync();
    return true;
  } catch (error) {
    if (directorySyncUnsupported(error)) return false;
    throw error;
  } finally {
    await handle.close();
  }
}

/** Atomically replace one private file and make the rename crash-durable. */
export async function atomicWriteFile(filePath, data, { encoding = undefined } = {}) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let tempPath = null;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(candidate, data, {
          ...(encoding === undefined ? {} : { encoding }),
          mode: 0o600,
          flag: 'wx',
        });
        tempPath = candidate;
        break;
      } catch (error) {
        await rm(candidate, { force: true }).catch(() => undefined);
        if (error?.code !== 'EEXIST' || attempt === 7) throw error;
      }
    }
    await chmod(tempPath, 0o600);
    await syncFile(tempPath);
    await rename(tempPath, filePath);
    tempPath = null;
    await syncDirectory(directory);
  } finally {
    if (tempPath !== null) await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
