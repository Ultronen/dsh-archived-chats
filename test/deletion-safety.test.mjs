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
