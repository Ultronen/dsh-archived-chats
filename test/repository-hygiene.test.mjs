import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, '..');
const checker = join(repositoryRoot, 'scripts', 'check-repository-hygiene.mjs');

function createRepository(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repository-hygiene-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  execFileSync('git', ['add', '--force', '--', ...Object.keys(files)], { cwd: root });
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [checker, '--root', root], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function withRepository(files, assertion) {
  const root = createRepository(files);
  try { assertion(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('repository hygiene accepts tracked product and test files', () => {
  withRepository({
    'README.md': '# Plugin\n',
    'lib/index.js': 'export const value = 1;\n',
    'test/fixtures/synthetic.json': '{"synthetic":true}\n',
  }, (root) => {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('repository hygiene rejects tracked internal process artifacts', () => {
  const internalPath = ['docs', 'superpowers', 'plans', 'private.md'].join('/');
  withRepository({ [internalPath]: '# Internal plan\n' }, (root) => {
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/superpowers\/plans\/private\.md/);
  });
});

test('repository hygiene rejects tracked local machine paths', () => {
  const localPath = ['', 'Users', 'example', 'private', 'capture.png'].join('/');
  withRepository({ 'README.md': `temporary evidence: ${localPath}\n` }, (root) => {
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /README\.md:1/);
  });
});

test('current repository passes the repository hygiene gate', () => {
  const result = runChecker(repositoryRoot);
  assert.equal(result.status, 0, result.stderr);
});
