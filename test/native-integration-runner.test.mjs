import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(repositoryRoot, 'scripts', 'run-native-integration.mjs');
const hostDependencies = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/dsh-session': '0.1.5-rc.2',
  '@deepseek-ai/dsh-session-persistence-jsonl': '0.1.5-rc.2',
};

async function temporaryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dac-native-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function installedHostFixture(t, testLines) {
  const fixtureRoot = await temporaryFixture(t);
  const testFile = join(fixtureRoot, 'native-cases.test.mjs');
  await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({ private: true, dependencies: hostDependencies }));
  for (const [name, version] of Object.entries(hostDependencies)) {
    const packageRoot = join(fixtureRoot, 'node_modules', ...name.split('/'));
    await mkdir(join(packageRoot, 'lib'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version, type: 'module' }));
    await writeFile(join(packageRoot, 'lib', 'index.js'), 'export const loaded = true;\n');
  }
  await writeFile(testFile, [...testLines, ''].join('\n'));
  return { fixtureRoot, testFile };
}

test('native integration runner fails when locked Host dependencies are not installed', async t => {
  const fixtureRoot = await temporaryFixture(t);
  await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({
    private: true,
    dependencies: hostDependencies,
  }));

  const result = spawnSync(process.execPath, [runner, '--fixture-root', fixtureRoot], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /native dependency is not installed: @deepseek-ai\/cordis@4\.0\.2/);
  assert.doesNotMatch(result.stdout + result.stderr, /skip/i);
});

test('native integration runner loads the locked Host and rejects skipped native cases', async t => {
  const { fixtureRoot, testFile } = await installedHostFixture(t, [
    "import test from 'node:test';",
    "test('runs', () => {});",
    "test('cannot hide a missing native case', { skip: true }, () => {});",
  ]);

  const result = spawnSync(process.execPath, [
    runner,
    '--fixture-root', fixtureRoot,
    '--test-file', testFile,
    '--expected-tests', '2',
  ], { cwd: repositoryRoot, encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /native integration did not execute every case: tests=2 pass=1 skipped=1 expected=2/);
  assert.match(result.stdout, /host=@deepseek-ai\/cordis@4\.0\.2,@deepseek-ai\/dsh-session@0\.1\.5-rc\.2,@deepseek-ai\/dsh-session-persistence-jsonl@0\.1\.5-rc\.2/);
});

test('native integration runner succeeds only after every expected case executes', async t => {
  const { fixtureRoot, testFile } = await installedHostFixture(t, [
    "import test from 'node:test';",
    "test('first native case', () => {});",
    "test('second native case', () => {});",
  ]);

  const result = spawnSync(process.execPath, [
    runner,
    '--fixture-root', fixtureRoot,
    '--test-file', testFile,
    '--expected-tests', '2',
  ], { cwd: repositoryRoot, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /native integration complete: tests=2 pass=2 skipped=0/);
});
