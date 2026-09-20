import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

try {
  const packagePath = resolve(option('--package', join(repositoryRoot, 'package.json')));
  const tag = option('--tag', process.env.GITHUB_REF_NAME);
  if (!tag) throw new Error('release tag is required');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const expected = `v${manifest.version}`;
  if (tag !== expected) {
    throw new Error(`release tag ${tag} does not match ${manifest.name}@${manifest.version} (expected ${expected})`);
  }
  process.stdout.write(`release candidate verified: ${manifest.name}@${manifest.version} tag=${tag}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
