import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checker = join(repositoryRoot, 'scripts', 'check-release-candidate.mjs');

async function manifest(t, version) {
  const root = await mkdtemp(join(tmpdir(), 'dac-release-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'package.json');
  await writeFile(path, JSON.stringify({ name: 'candidate', version }));
  return path;
}

test('release candidate checker rejects a tag that differs from the manifest version', async t => {
  const packagePath = await manifest(t, '1.3.3');
  const result = spawnSync(process.execPath, [checker, '--package', packagePath, '--tag', 'v1.3.4'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /release tag v1\.3\.4 does not match candidate@1\.3\.3 \(expected v1\.3\.3\)/);
});

test('release candidate checker accepts the exact manifest tag without publishing', async t => {
  const packagePath = await manifest(t, '1.3.3');
  const result = spawnSync(process.execPath, [checker, '--package', packagePath, '--tag', 'v1.3.3'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /release candidate verified: candidate@1\.3\.3 tag=v1\.3\.3/);
});
