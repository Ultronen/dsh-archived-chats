import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { resolveExclusiveSessionDirectory } from '../lib/deletion-safety.js';

async function fixture(t, ids = ['chat-a']) {
  const root = await mkdtemp(join(tmpdir(), 'dac-delete-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const headers = [];
  const paths = new Map();
  for (const id of ids) {
    const path = join(root, 'sessions', id, 'session.jsonl');
    await mkdir(join(root, 'sessions', id), { recursive: true });
    await writeFile(path, id);
    headers.push({ id });
    paths.set(id, path);
  }
  return {
    root, headers, paths,
    persistence: {
      async list() { return headers; },
      async locate(header) { return { kind: 'jsonl', path: paths.get(header.id) }; },
    },
  };
}

test('exclusive deletion scope accepts sibling session directories and missing-original retries', async t => {
  const f = await fixture(t, ['chat-a', 'chat-b']);
  const present = await resolveExclusiveSessionDirectory(f.persistence, 'chat-a');
  assert.equal(present.status, 'present');
  assert.equal(present.sessionDirectory, await realpath(join(f.root, 'sessions', 'chat-a')));

  f.headers.splice(0, 1);
  const missing = await resolveExclusiveSessionDirectory(f.persistence, 'chat-a');
  assert.deepEqual(missing, { status: 'missing', sessionDirectory: null });
});

test('exclusive deletion scope rejects unsafe ids, relative locations, roots, and unreadable inventory', async t => {
  const f = await fixture(t);
  for (const id of ['../chat-a', '/chat-a', 'C:\\chat-a', '\\\\server\\chat-a', '.', '..']) {
    await assert.rejects(resolveExclusiveSessionDirectory(f.persistence, id), { code: 'session-location-unsafe' });
  }

  const relative = { list: async () => [{ id: 'chat-a' }], locate: async () => ({ path: 'sessions/chat-a/session.jsonl' }) };
  await assert.rejects(resolveExclusiveSessionDirectory(relative, 'chat-a'), { code: 'session-location-unsafe' });

  const root = { list: async () => [{ id: 'chat-a' }], locate: async () => ({ path: '/session.jsonl' }) };
  await assert.rejects(resolveExclusiveSessionDirectory(root, 'chat-a'), { code: 'session-location-unsafe' });

  const unreadable = { list: async () => { throw new Error('offline'); }, locate: f.persistence.locate };
  await assert.rejects(resolveExclusiveSessionDirectory(unreadable, 'chat-a'), { code: 'session-location-unavailable' });
});

test('Windows resolves both actual temp-drive letter casings through deletion safety', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  const actualPath = f.paths.get('chat-a');
  const driveRoot = parse(actualPath).root;
  assert.match(driveRoot, /^[A-Za-z]:\\$/u, `expected a local Windows drive, got ${driveRoot}`);
  const upperPath = driveRoot[0].toUpperCase() + actualPath.slice(1);
  const lowerPath = driveRoot[0].toLowerCase() + actualPath.slice(1);
  assert.notEqual(upperPath, lowerPath, 'fixture must exercise two lexical drive-letter forms');
  const expectedDirectory = await realpath(join(f.root, 'sessions', 'chat-a'));

  for (const path of [upperPath, lowerPath]) {
    const persistence = {
      list: async () => [{ id: 'chat-a' }],
      locate: async () => ({ kind: 'jsonl', path }),
    };
    const scope = await resolveExclusiveSessionDirectory(persistence, 'chat-a');
    assert.equal(scope.status, 'present');
    assert.equal(scope.sessionDirectory, expectedDirectory);
  }
});

test('exclusive deletion scope returns a checked canonical directory that a deeper lexical link cannot retarget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dac-delete-deep-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, 'original');
  const decoy = join(root, 'decoy');
  const linked = join(root, 'linked');
  const suffix = join('nested', 'sessions', 'chat-a');
  await mkdir(join(original, suffix), { recursive: true });
  await mkdir(join(decoy, suffix), { recursive: true });
  await writeFile(join(original, suffix, 'session.jsonl'), 'original');
  await writeFile(join(decoy, suffix, 'session.jsonl'), 'decoy');
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(original, linked, directoryLinkType);
  const persistence = {
    list: async () => [{ id: 'chat-a' }],
    locate: async () => ({ path: join(linked, suffix, 'session.jsonl') }),
  };

  const scope = await resolveExclusiveSessionDirectory(persistence, 'chat-a');
  assert.equal(scope.sessionDirectory, await realpath(join(original, suffix)));

  await rm(linked);
  await symlink(decoy, linked, directoryLinkType);
  await rm(scope.sessionDirectory, { recursive: true });

  await assert.rejects(access(join(original, suffix)), { code: 'ENOENT' });
  assert.equal(await readFile(join(decoy, suffix, 'session.jsonl'), 'utf8'), 'decoy');
});


// locate() identifies the Host's append target, not necessarily a materialized log.
test('historical-only logs do not block their own or sibling deletion scopes', async t => {
  for (const filename of ['session.jsonl', 'session.jsonl.zstd', 'session.v3.jsonl', 'session.v3.jsonl.zstd']) {
    await t.test(filename, async t => {
      const f = await fixture(t, ['chat-a', 'chat-b']);
      const directory = join(f.root, 'sessions', 'chat-b');
      await rm(f.paths.get('chat-b'));
      await writeFile(join(directory, filename), 'historical');
      f.paths.set('chat-b', join(directory, 'session.v4.jsonl.zstd'));
      for (const id of ['chat-a', 'chat-b']) {
        assert.deepEqual(await resolveExclusiveSessionDirectory(f.persistence, id), {
          status: 'present', sessionDirectory: await realpath(join(f.root, 'sessions', id)),
        });
      }
    });
  }
});

test('an empty unmaterialized session directory still has an exclusive deletion scope', async t => {
  const f = await fixture(t, ['chat-a', 'chat-b']);
  await rm(f.paths.get('chat-b'));
  assert.deepEqual(await resolveExclusiveSessionDirectory(f.persistence, 'chat-b'), {
    status: 'present', sessionDirectory: await realpath(join(f.root, 'sessions', 'chat-b')),
  });
  assert.equal((await resolveExclusiveSessionDirectory(f.persistence, 'chat-a')).status, 'present');
});

test('missing directories in inventory do not block deletion or interrupted-purge retries', async t => {
  const f = await fixture(t, ['chat-a', 'chat-b']);
  await rm(join(f.root, 'sessions', 'chat-b'), { recursive: true });
  f.headers.push({ id: 'pending' });
  f.paths.set('pending', join(f.root, 'new-store', 'new-project', 'pending', 'session.v4.jsonl.zstd'));
  assert.equal((await resolveExclusiveSessionDirectory(f.persistence, 'chat-a')).status, 'present');
  for (const id of ['chat-b', 'pending']) {
    assert.deepEqual(await resolveExclusiveSessionDirectory(f.persistence, id), {
      status: 'missing', sessionDirectory: null,
    });
  }
});

test('empty and historical session directories still reject nested deletion scopes', async t => {
  const f = await fixture(t, ['chat-a']);
  await rm(f.paths.get('chat-a'));
  const nested = join(f.root, 'sessions', 'chat-a', 'nested', 'chat-b');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'session.v3.jsonl.zstd'), 'historical');
  f.headers.push({ id: 'chat-b' });
  f.paths.set('chat-b', join(nested, 'session.v4.jsonl.zstd'));
  for (const id of ['chat-a', 'chat-b']) {
    await assert.rejects(resolveExclusiveSessionDirectory(f.persistence, id), { code: 'session-location-unsafe' });
  }
});

test('existing located files and historical fallback logs reject non-file artifacts', async t => {
  for (const filename of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl', 'session.jsonl']) {
    await t.test(filename, async t => {
      const f = await fixture(t);
      await rm(f.paths.get('chat-a'));
      f.paths.set('chat-a', join(f.root, 'sessions', 'chat-a', 'session.v4.jsonl.zstd'));
      await mkdir(join(f.root, 'sessions', 'chat-a', filename));
      await assert.rejects(resolveExclusiveSessionDirectory(f.persistence, 'chat-a'), { code: 'session-location-unsafe' });
    });
  }
});

test('located and historical fallback artifacts reject links or Windows junctions', async t => {
  for (const filename of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
    await t.test(filename, async t => {
      const f = await fixture(t);
      await rm(f.paths.get('chat-a'));
      f.paths.set('chat-a', join(f.root, 'sessions', 'chat-a', 'session.v4.jsonl.zstd'));
      const outside = join(f.root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'keep'), 'unrelated');
      await symlink(outside, join(f.root, 'sessions', 'chat-a', filename),
        process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(resolveExclusiveSessionDirectory(f.persistence, 'chat-a'), { code: 'session-location-unsafe' });
      assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'unrelated');
    });
  }
});

test('a linked session directory is unsafe even when the located log is absent', async t => {
  const f = await fixture(t);
  const directory = join(f.root, 'sessions', 'chat-a');
  const outside = join(f.root, 'outside');
  await rm(directory, { recursive: true });
  await mkdir(outside);
  await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveExclusiveSessionDirectory(f.persistence, 'chat-a'), { code: 'session-location-unsafe' });
});

test('noncanonical generation artifacts are not mistaken for committed fallback logs', async t => {
  const f = await fixture(t);
  await rm(f.paths.get('chat-a'));
  const directory = join(f.root, 'sessions', 'chat-a');
  f.paths.set('chat-a', join(directory, 'session.v4.jsonl.zstd'));
  for (const name of ['session.v0.jsonl', 'session.v03.jsonl.zstd', 'session.V3.jsonl',
    'session.v3.jsonl.zstd.tmp', 'session.v9007199254740992.jsonl']) {
    await mkdir(join(directory, name));
  }
  assert.deepEqual(await resolveExclusiveSessionDirectory(f.persistence, 'chat-a'), {
    status: 'present', sessionDirectory: await realpath(directory),
  });
});
