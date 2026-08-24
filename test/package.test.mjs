import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('published 0.11 package contains recycle runtime and excludes local state', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const cache = mkdtempSync(join(tmpdir(), 'dac-npm-cache-'));
  const result = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
  });
  rmSync(cache, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [{ files, version }] = JSON.parse(result.stdout);
  assert.equal(version, '0.11.0');
  const paths = new Set(files.map((file) => file.path));

  for (const required of [
    'lib/trash.js',
    'lib/snapshot.js',
    'lib/recycle.js',
    'lib/insights.js',
    'lib/retention.js',
    'lib/retention-service.js',
    'lib/lineage.js',
    'docs/ARCHITECTURE.md',
    'docs/ARCHITECTURE.en.md',
  ]) assert(paths.has(required), `missing ${required}`);

  for (const path of paths) {
    assert(!path.startsWith('data/'), `local data leaked: ${path}`);
    assert(!path.startsWith('.codegraph/'), `CodeGraph state leaked: ${path}`);
    assert(!path.startsWith('docs/superpowers/'), `planning scratch leaked: ${path}`);
    assert(!path.startsWith('.worktrees/'), `worktree leaked: ${path}`);
    assert(!path.includes('/staging/') && !path.endsWith('.tmp'), `staging file leaked: ${path}`);
    assert(!path.startsWith('test/fixtures/'), `test fixture leaked: ${path}`);
  }
});
