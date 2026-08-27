import assert from 'node:assert/strict';
import test from 'node:test';
import { syncDirectory, syncFile } from '../lib/durable.js';

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
