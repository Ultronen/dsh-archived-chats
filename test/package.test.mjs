import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageVersion = packageManifest.version;
const expectedScreenshots = [
  'assets/screenshots/preview-01.png',
  'assets/screenshots/preview-02.png',
  'assets/screenshots/preview-03.png',
  'assets/screenshots/preview-04.png',
  'assets/screenshots/preview-05.png',
  'assets/screenshots/preview-06.png',
  'assets/screenshots/preview-07.png',
  'assets/screenshots/preview-08.png',
];

test('package declares the verified minimum DeepSeek Harness version', () => {
  assert.equal(packageManifest.dsh?.engines?.dsh, '>=0.1.0-rc.7');
});

test('client bootstrap stays compatible with stable and alpha.2 through the locale dependency closure', () => {
  assert.deepEqual(
    packageManifest.dsh?.client?.inject,
    ['@deepseek-ai/dsh-client-locale'],
  );
});

test('host session API follows the DSH-provided stable or alpha package instead of bundling an old core', () => {
  assert.equal(packageManifest.dependencies?.['@deepseek-ai/dsh-session'], undefined);
  assert.equal(
    packageManifest.peerDependencies?.['@deepseek-ai/dsh-session'],
    '>=0.1.0-rc.7 <0.1.1-0 || >=0.1.1-rc.1 <0.1.2-0 || >=0.1.2-alpha.1 <0.2.0-0',
  );
  assert.equal(packageManifest.peerDependenciesMeta?.['@deepseek-ai/dsh-session']?.optional, true);
});

test('author-owned screenshot manifest keeps the eight stable market slots valid', () => {
  const declared = JSON.parse(readFileSync(join(root, 'screenshots.json'), 'utf8'));

  assert(Array.isArray(declared), 'screenshots.json must be an array');
  assert(declared.length >= 1 && declared.length <= 8, 'market accepts 1-8 screenshots');
  assert.deepEqual(declared, expectedScreenshots);

  for (const screenshot of declared) {
    assert.equal(typeof screenshot, 'string');
    assert(screenshot.length > 0, 'screenshot path must not be empty');
    assert(!isAbsolute(screenshot), `screenshot path must be relative: ${screenshot}`);
    assert(!screenshot.split('/').includes('..'), `screenshot path escapes repository: ${screenshot}`);
    assert(existsSync(join(root, screenshot)), `missing screenshot: ${screenshot}`);
  }
});

test(`published ${packageVersion} package contains runtime, brand banner, fixed previews, and no local state`, () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const cache = mkdtempSync(join(tmpdir(), 'dac-npm-cache-'));
  const result = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
    shell: process.platform === 'win32',
  });
  rmSync(cache, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [{ files, version }] = JSON.parse(result.stdout);
  assert.equal(version, packageVersion);
  const paths = new Set(files.map((file) => file.path));

  for (const required of [
    'screenshots.json',
    'assets/brand/session-archive-banner.png',
    'lib/trash.js',
    'lib/snapshot.js',
    'lib/recycle.js',
    'lib/insights.js',
    'lib/retention.js',
    'lib/retention-service.js',
    'lib/lineage.js',
    'lib/history.js',
    'lib/history-restore.js',
    'docs/ARCHITECTURE.md',
    'docs/ARCHITECTURE.en.md',
  ]) assert(paths.has(required), `missing ${required}`);

  const screenshots = [...paths].filter((path) => path.startsWith('assets/screenshots/')).sort();
  assert.deepEqual(screenshots, expectedScreenshots);

  for (const path of paths) {
    assert(!path.startsWith('data/'), `local data leaked: ${path}`);
    assert(!path.startsWith('.codegraph/'), `CodeGraph state leaked: ${path}`);
    assert(!path.startsWith('docs/superpowers/'), `planning scratch leaked: ${path}`);
    assert(!path.startsWith('.worktrees/'), `worktree leaked: ${path}`);
    assert(!path.includes('/staging/') && !path.endsWith('.tmp'), `staging file leaked: ${path}`);
    assert(!path.startsWith('test/fixtures/'), `test fixture leaked: ${path}`);
    assert(!path.startsWith('test/'), `test artifact leaked: ${path}`);
  }
});
