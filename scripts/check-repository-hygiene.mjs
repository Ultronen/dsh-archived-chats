#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootIndex = process.argv.indexOf('--root');
if (rootIndex !== -1 && process.argv[rootIndex + 1] === undefined) {
  console.error('--root requires a directory');
  process.exit(2);
}

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(rootIndex === -1 ? defaultRoot : process.argv[rootIndex + 1]);

const forbiddenPrefixes = [
  '.codegraph/',
  '.release-work/',
  '.screenshot-staging/',
  '.superpowers/',
  '.worktrees/',
  'data/',
  'docs/superpowers/',
];

const forbiddenExact = new Set([
  '.anonymous-user-id',
  '.credentials.yaml',
  '.env',
  '.npmrc',
  'design-qa.md',
]);

const forbiddenSuffixes = ['.DS_Store', '.log', '.tgz', '.tmp'];
const fragments = (...parts) => parts.join('');
const localContent = [
  ['macOS user path', fragments('/', 'Users', '/')],
  ['private temporary path', fragments('/', 'private', '/', 'tmp', '/')],
  ['macOS temporary path', fragments('/', 'var', '/', 'folders', '/')],
  ['loopback IPv4 address', fragments('127', '.0', '.0', '.1')],
  ['loopback host name', fragments('local', 'host')],
  ['removed RTK command', fragments('r', 't', 'k', ' ')],
  ['GitHub token command', fragments('gh', ' auth', ' token')],
  ['GitHub token variable', fragments('GITHUB', '_TOKEN')],
  ['npm credential text', fragments('npm', ' token')],
];

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
} catch (error) {
  console.error(`could not list tracked files in ${root}: ${error.message}`);
  process.exit(2);
}

const violations = [];
for (const path of tracked) {
  const normalized = path.replaceAll('\\', '/');
  if (forbiddenExact.has(normalized)
    || forbiddenPrefixes.some((prefix) => normalized.startsWith(prefix))
    || forbiddenSuffixes.some((suffix) => normalized.endsWith(suffix))) {
    violations.push(`${normalized}: forbidden tracked path`);
    continue;
  }

  const absolute = resolve(root, path);
  let stat;
  try { stat = lstatSync(absolute); }
  catch { continue; }
  if (!stat.isFile()) continue;

  let bytes;
  try { bytes = readFileSync(absolute); }
  catch { continue; }
  if (bytes.includes(0)) continue;

  const lines = bytes.toString('utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const [label, value] of localContent) {
      if (lines[index].includes(value)) {
        violations.push(`${normalized}:${index + 1}: ${label}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('repository hygiene failed:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`repository hygiene: ${tracked.length} tracked files checked`);
