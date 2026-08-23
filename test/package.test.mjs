import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('published package includes both architecture guides linked from the READMEs', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [{ files }] = JSON.parse(result.stdout);
  const paths = new Set(files.map((file) => file.path));

  assert(paths.has('docs/ARCHITECTURE.md'));
  assert(paths.has('docs/ARCHITECTURE.en.md'));
});
