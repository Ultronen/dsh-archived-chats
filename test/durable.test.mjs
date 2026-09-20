import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, replaceFile, syncDirectory, syncFile } from '../lib/durable.js';

async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try { return await run(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}

async function holdWithoutDeleteSharing(t, path) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$targetPath = $env:DSH_ARCHIVED_CHATS_DENY_DELETE_PATH',
    "if ([String]::IsNullOrEmpty($targetPath)) { throw 'deny-delete target path is missing' }",
    '$stream = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)',
    "[Console]::Out.WriteLine('READY')",
    '[Console]::Out.Flush()',
    'try { [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }',
  ].join('; ');
  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, DSH_ARCHIVED_CHATS_DENY_DELETE_PATH: path },
  });
  let stdout = '';
  let stderr = '';
  let released = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lifetime = setTimeout(() => child.kill(), 10_000);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(lifetime);
      resolve({ code, signal });
    });
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`deny-delete helper did not become ready: ${stderr}`)), 5_000);
    const inspect = () => {
      if (!stdout.includes('READY')) return;
      clearTimeout(timeout);
      child.stdout.off('data', inspect);
      resolve();
    };
    child.stdout.on('data', inspect);
    exited.then(({ code, signal }) => {
      clearTimeout(timeout);
      reject(new Error(`deny-delete helper exited before ready: code=${code} signal=${signal} stderr=${stderr}`));
    }, reject);
  });
  const release = async (assertClean) => {
    if (!released) {
      released = true;
      child.stdin.end('\n');
    }
    const result = await exited;
    if (assertClean) assert.equal(result.code, 0, `deny-delete helper failed: signal=${result.signal} stderr=${stderr}`);
  };
  t.after(() => release(false).catch(() => undefined));
  await ready;
  return { release: () => release(true) };
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

test('Windows runner exercises real long Unicode paths, fsync limits, and deny-delete replacement retries', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dac-win32-durable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ...Array.from({ length: 12 }, (_, index) => `会话-${index}-${'x'.repeat(16)}`));
  const target = join(directory, '归档-长路径.json');
  assert(target.length > 260, `fixture must exceed legacy MAX_PATH (got ${target.length})`);
  await mkdir(directory, { recursive: true });

  await atomicWriteFile(target, 'first\n', { encoding: 'utf8' });
  await syncFile(target);
  assert.equal(await syncDirectory(directory), false, 'Node does not expose Windows directory fsync');

  const occupied = join(root, 'occupied.json');
  const replacement = join(root, 'replacement.tmp');
  await writeFile(occupied, 'first\n');
  await writeFile(replacement, 'second\n');
  const holder = await holdWithoutDeleteSharing(t, occupied);
  await assert.rejects(
    rename(replacement, occupied),
    (error) => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code),
    'the real Windows rename must be refused while delete sharing is denied',
  );
  const replacing = replaceFile(replacement, occupied, { delayMs: 100, attempts: 5 });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  await holder.release();
  const attempt = await replacing;
  assert(attempt > 1, `production replacement must retry after a real refusal (attempt=${attempt})`);
  assert.equal(await readFile(occupied, 'utf8'), 'second\n');
});
