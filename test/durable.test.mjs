import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, replaceFile, syncDirectory, syncFile } from '../lib/durable.js';

async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try { return await run(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}

test('syncFile uses a Windows-compatible writable handle and always closes it', async () => {
  const calls = [];
  const handle = {
    async sync() { calls.push('sync'); },
    async close() { calls.push('close'); },
  };
  const openFile = async (path, flags) => {
    calls.push({ path, flags });
    return handle;
  };

  await syncFile('/private/session.json', openFile);
  assert.deepEqual(calls, [{ path: '/private/session.json', flags: 'r+' }, 'sync', 'close']);
});

test('syncDirectory reports successful directory fsync and closes its handle', async () => {
  const calls = [];
  const result = await syncDirectory('/private/archive', async (path, flags) => {
    calls.push({ path, flags });
    return {
      async sync() { calls.push('sync'); },
      async close() { calls.push('close'); },
    };
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [{ path: '/private/archive', flags: 'r' }, 'sync', 'close']);
});

test('syncDirectory safely degrades for portable unsupported-directory errors', async () => {
  const result = await syncDirectory('/unsupported', async () => {
    throw Object.assign(new Error('directory sync unsupported'), { code: 'EINVAL' });
  });
  assert.equal(result, false);
});

test('syncDirectory safely degrades for Windows open and fsync limitations', async () => {
  await withPlatform('win32', async () => {
    for (const code of ['EACCES', 'EISDIR']) {
      const result = await syncDirectory('C:\\archive', async () => {
        throw Object.assign(new Error('directory open unsupported'), { code });
      });
      assert.equal(result, false);
    }

    let closed = false;
    const result = await syncDirectory('C:\\archive', async () => ({
      async sync() { throw Object.assign(new Error('directory fsync unsupported'), { code: 'EPERM' }); },
      async close() { closed = true; },
    }));
    assert.equal(result, false);
    assert.equal(closed, true);
  });
});

test('syncDirectory rethrows unexpected failures and still closes opened handles', async () => {
  const openFailure = Object.assign(new Error('open failed'), { code: 'ENOENT' });
  await assert.rejects(
    () => syncDirectory('/missing', async () => { throw openFailure; }),
    (error) => error === openFailure,
  );

  let closed = false;
  const syncFailure = Object.assign(new Error('sync failed'), { code: 'EIO' });
  await assert.rejects(
    () => syncDirectory('/broken', async () => ({
      async sync() { throw syncFailure; },
      async close() { closed = true; },
    })),
    (error) => error === syncFailure,
  );
  assert.equal(closed, true);
});

/**
 * Windows cannot atomically replace a file while another handle is open on the
 * destination — an indexer or antivirus scan surfaces as EPERM/EACCES/EBUSY.
 * These are transient, so the replace retries there and only there.
 */
test('file replacement retries the transient Windows rename codes and only on Windows', async () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    let calls = 0;
    const attempt = await replaceFile('temp', 'target', {
      platform: 'win32',
      delayMs: 0,
      renameFile: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error(`windows says ${code}`), { code });
      },
    });
    assert.equal(calls, 3, `${code} is retried until the replace succeeds`);
    assert.equal(attempt, 3);
  }

  // POSIX reports these codes for permanent conditions: fail on the first try.
  for (const platform of ['darwin', 'linux']) {
    let calls = 0;
    await assert.rejects(
      () => replaceFile('temp', 'target', {
        platform,
        delayMs: 0,
        renameFile: async () => { calls += 1; throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
      }),
      (error) => error.code === 'EPERM',
    );
    assert.equal(calls, 1, `${platform} never retries a permanent rename failure`);
  }

  // A code outside the transient set is never retried, even on Windows.
  let missing = 0;
  await assert.rejects(
    () => replaceFile('temp', 'target', {
      platform: 'win32',
      delayMs: 0,
      renameFile: async () => { missing += 1; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
    }),
    (error) => error.code === 'ENOENT',
  );
  assert.equal(missing, 1, 'a non-transient code fails immediately');

  // A destination that never frees up gives up instead of retrying forever.
  let forever = 0;
  await assert.rejects(
    () => replaceFile('temp', 'target', {
      platform: 'win32',
      delayMs: 0,
      attempts: 4,
      renameFile: async () => { forever += 1; throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
    }),
    (error) => error.code === 'EBUSY',
  );
  assert.equal(forever, 4, 'retries are bounded');
});

test('a write whose replacement never succeeds leaves no temporary file behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-durable-replace-'));
  const target = join(root, 'store.json');
  // Point the write at a directory-as-file so the rename cannot land.
  await mkdir(target, { recursive: true });
  await assert.rejects(() => atomicWriteFile(target, 'payload\n', { encoding: 'utf8' }));
  const leftovers = (await readdir(root)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the failed write cleaned up its temporary file');
  await rm(root, { recursive: true, force: true });
});
