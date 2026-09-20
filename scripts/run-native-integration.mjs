import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

async function loadLockedHost(fixtureRoot) {
  const fixture = JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));
  const loaded = [];
  for (const [name, expectedVersion] of Object.entries(fixture.dependencies ?? {})) {
    const packageRoot = join(fixtureRoot, 'node_modules', ...name.split('/'));
    let installed;
    try {
      installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    } catch {
      throw new Error(`native dependency is not installed: ${name}@${expectedVersion}`);
    }
    if (installed.version !== expectedVersion) {
      throw new Error(`native dependency version mismatch: ${name} expected ${expectedVersion}, found ${installed.version}`);
    }
    try {
      await import(pathToFileURL(join(packageRoot, 'lib', 'index.js')));
    } catch (error) {
      throw new Error(`native dependency failed to load: ${name}@${expectedVersion}`, { cause: error });
    }
    loaded.push(`${name}@${installed.version}`);
  }
  if (loaded.length === 0) throw new Error('native fixture declares no Host dependencies');
  return loaded;
}

function summary(output, label) {
  const match = output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
  if (!match) throw new Error(`native test output has no ${label} summary`);
  return Number(match[1]);
}

export async function runNativeIntegration(args = process.argv.slice(2)) {
  const fixtureRoot = resolve(option(args, '--fixture-root', join(repositoryRoot, 'test', 'fixtures', 'native-host')));
  const testFile = resolve(option(args, '--test-file', join(repositoryRoot, 'test', 'backup-roundtrip.test.mjs')));
  const expectedTests = Number(option(args, '--expected-tests', '5'));
  if (!Number.isSafeInteger(expectedTests) || expectedTests < 1) throw new Error('--expected-tests must be a positive integer');

  const host = await loadLockedHost(fixtureRoot);
  process.stdout.write(`[native-integration] os=${platform()} arch=${arch()} node=${process.version} host=${host.join(',')}\n`);
  const childEnvironment = {
    ...process.env,
    DSH_NATIVE_MODULE_ROOT: join(fixtureRoot, 'node_modules'),
    DSH_REQUIRE_NATIVE: '1',
  };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: childEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`native integration test process failed with exit code ${result.status}`);

  const tests = summary(result.stdout, 'tests');
  const pass = summary(result.stdout, 'pass');
  const skipped = summary(result.stdout, 'skipped');
  if (tests !== expectedTests || pass !== expectedTests || skipped !== 0) {
    throw new Error(`native integration did not execute every case: tests=${tests} pass=${pass} skipped=${skipped} expected=${expectedTests}`);
  }
  process.stdout.write(`[native-integration] native integration complete: tests=${tests} pass=${pass} skipped=${skipped}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeIntegration().catch((error) => {
    process.stderr.write(`[native-integration] ${error.message}\n`);
    process.exitCode = 1;
  });
}
