import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const packageManifest = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const packageVersion = packageManifest.version;
const declaredScreenshots = JSON.parse(read('screenshots.json'));
const publicRoutes = [
  'GET  /plugins/dsh-archived-chats/about',
  'POST /plugins/dsh-archived-chats/about/check-updates',
  'GET  /plugins/dsh-archived-chats/state',
  'GET  /plugins/dsh-archived-chats/stats',
  'GET  /plugins/dsh-archived-chats/insights',
  'GET  /plugins/dsh-archived-chats/lineage',
  'GET  /plugins/dsh-archived-chats/workspace-archive/workspaces',
  'POST /plugins/dsh-archived-chats/workspace-archive/preview',
  'POST /plugins/dsh-archived-chats/workspace-archive/apply',
  'POST /plugins/dsh-archived-chats/retention/policy/preview',
  'POST /plugins/dsh-archived-chats/retention/policy',
  'POST /plugins/dsh-archived-chats/retention/preview',
  'POST /plugins/dsh-archived-chats/retention/apply',
  'POST /plugins/dsh-archived-chats/preview',
  'POST /plugins/dsh-archived-chats/preview/image',
  'POST /plugins/dsh-archived-chats/search',
  'POST /plugins/dsh-archived-chats/export',
  'POST /plugins/dsh-archived-chats/import/inspect',
  'POST /plugins/dsh-archived-chats/import/restore',
  'POST /plugins/dsh-archived-chats/metadata',
  'GET  /plugins/dsh-archived-chats/trash',
  'POST /plugins/dsh-archived-chats/trash/restore',
  'POST /plugins/dsh-archived-chats/trash/purge',
  'POST /plugins/dsh-archived-chats/trash/empty',
  'POST /plugins/dsh-archived-chats/unarchive',
  'POST /plugins/dsh-archived-chats/unarchive-all',
  'POST /plugins/dsh-archived-chats/delete',
  'POST /plugins/dsh-archived-chats/delete-all',
];

function parseArchitectureRoutes(contents) {
  const block = contents.match(/## (?:Host routes|Host 路由)[\s\S]*?```text\r?\n([\s\S]*?)\r?\n```/)?.[1];
  return block?.split(/\r?\n/);
}

test('package and lock root publish one approved identity', () => {
  assert.equal(
    packageManifest.description,
    '查看、搜索和恢复已归档会话，支持按工作区批量归档、备份导入导出与回收站管理。',
  );
  assert.equal(packageManifest.author, 'Ultronen');
  assert.equal(packageLock.name, packageManifest.name);
  assert.equal(packageLock.version, packageManifest.version);
  assert.equal(packageLock.packages?.['']?.name, packageManifest.name);
  assert.equal(packageLock.packages?.['']?.version, packageManifest.version);
});

test('each public overview states its own destructive and backup boundaries', () => {
  const expected = new Map([
    ['README.md', [
      'exact recycle-record incarnations shown at confirmation',
      'Successful exports are validated against the same format and budgets as import before the download starts.',
      'A chat without a working directory remains in Archived',
    ]],
    ['README.zh-CN.md', [
      '确认时展示的精确回收记录实例',
      '导出成功前会按导入使用的同一格式和预算完成验证。',
      '没有工作目录的聊天会留在已归档',
    ]],
    ['docs/USER_GUIDE.md', [
      'exact recycle-record incarnations displayed for confirmation',
      'A successful plugin export is therefore within the plugin importer\'s format and size budgets.',
      'Download started does not mean the browser has saved the file to disk.',
    ]],
    ['docs/USER_GUIDE.zh-CN.md', [
      '确认时展示的精确回收记录实例',
      '因此，本插件成功导出的备份会符合本插件导入器的格式与大小预算。',
      '“已开始下载”不表示浏览器已将文件保存到磁盘。',
    ]],
  ]);

  for (const [path, phrases] of expected) {
    const contents = read(path);
    for (const phrase of phrases) assert(contents.includes(phrase), `${path} missing: ${phrase}`);
  }
});

test('both architecture documents list every current public route exactly once', () => {
  const runtime = read('lib/index.js');
  for (const line of publicRoutes) {
    const path = line.slice(5).trim();
    assert(runtime.includes(path.replace('/plugins/dsh-archived-chats', '${ROUTE_PREFIX}')), `runtime route missing: ${path}`);
  }

  for (const path of ['docs/ARCHITECTURE.en.md', 'docs/ARCHITECTURE.md']) {
    const routes = parseArchitectureRoutes(read(path));
    assert(routes, `${path} route block missing`);
    assert.deepEqual(routes, publicRoutes, `${path} route inventory is stale`);
  }
});

test('architecture route inventory parser accepts LF and CRLF documents', () => {
  for (const path of ['docs/ARCHITECTURE.en.md', 'docs/ARCHITECTURE.md']) {
    const lf = read(path).replace(/\r\n/g, '\n');
    const variants = new Map([
      ['LF', lf],
      ['CRLF', lf.replace(/\n/g, '\r\n')],
    ]);
    for (const [lineEnding, contents] of variants) {
      const routes = parseArchitectureRoutes(contents);
      assert(routes, `${path} ${lineEnding} route block missing`);
      assert.deepEqual(routes, publicRoutes, `${path} ${lineEnding} route inventory is stale`);
    }
  }
});

test('package declares a capability range and the tested Host fixture separately', () => {
  assert.equal(packageManifest.dsh?.engines?.dsh, '>=0.1.0-rc.7');
  assert.equal(packageManifest.dependencies?.['@deepseek-ai/dsh-session'], undefined);
  assert.equal(packageManifest.devDependencies?.['@deepseek-ai/dsh-session'], '0.1.7-rc.2');
  assert.equal(
    packageManifest.peerDependencies?.['@deepseek-ai/dsh-session'],
    '>=0.1.0-rc.7 <0.1.1-0 || >=0.1.1-rc.1 <0.1.2-0 || >=0.1.2-alpha.1 <0.2.0-0 || 0.1.5-rc.2 || 0.1.7-rc.2',
  );
  assert.equal(packageManifest.peerDependenciesMeta?.['@deepseek-ai/dsh-session']?.optional, true);
});

test('runtime dependencies stay free of the builtin-slash resolution chain', () => {
  // DSH 0.1.6-alpha.2 routes module resolution through a layer that calls
  // createRequire().resolve.paths() and iterates the result. `readable-stream@4`
  // requests 'process/' (trailing slash, to dodge the builtin) and that layer
  // strips the slash, resolves a builtin, receives null, and throws while
  // iterating — which aborts the whole host boot. The chain reached this package
  // through zip-stream, so the export writer must not reintroduce it.
  const offenders = ['zip-stream', 'compress-commons', 'crc32-stream', 'readable-stream'];
  const installed = new Set(
    Object.keys(packageLock.packages ?? {})
      .filter((path) => path.startsWith('node_modules/'))
      .map((path) => path.slice('node_modules/'.length)),
  );
  for (const offender of offenders) {
    assert(!installed.has(offender), `published dependency tree must not contain ${offender}`);
  }
  for (const [name, range] of Object.entries(packageManifest.dependencies ?? {})) {
    assert(!offenders.includes(name), `runtime dependency must not be ${name} (${range})`);
  }
});

test('packed artifact resolves normally beside the tested Host prerelease', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const fixture = mkdtempSync(join(tmpdir(), 'dac-peer-resolution-'));
  const packDirectory = join(fixture, 'pack');
  const peerDirectory = join(fixture, 'peers');
  const consumer = join(fixture, 'consumer');
  const cache = join(fixture, 'npm-cache');
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(peerDirectory, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  const localPackage = (directory, name, version) => {
    const path = join(peerDirectory, directory);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), `${JSON.stringify({ name, version })}\n`);
    const packed = spawnSync(npm, ['pack', '--json', '--pack-destination', packDirectory, path], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
      shell: process.platform === 'win32',
    });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const [{ filename }] = JSON.parse(packed.stdout);
    return `file:${join(packDirectory, filename)}`;
  };

  try {
    const packed = spawnSync(npm, ['pack', '--json', '--pack-destination', packDirectory], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
      shell: process.platform === 'win32',
    });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const [{ filename }] = JSON.parse(packed.stdout);
    writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
      name: 'dsh-archived-chats-peer-resolution-test',
      version: '1.0.0',
      private: true,
      dependencies: {
        'dsh-archived-chats': `file:${join(packDirectory, filename)}`,
        '@deepseek-ai/dsh-session': localPackage('dsh-session', '@deepseek-ai/dsh-session', '0.1.7-rc.2'),
        '@deepseek-ai/cordis': localPackage('cordis', '@deepseek-ai/cordis', '4.0.4'),
        react: localPackage('react', 'react', '18.3.1'),
        fflate: localPackage('fflate', 'fflate', '0.8.3'),
      },
    }, null, 2)}\n`);

    const installed = spawnSync(npm, ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
      shell: process.platform === 'win32',
    });

    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert(existsSync(join(consumer, 'node_modules', 'dsh-archived-chats', 'package.json')));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('client bootstrap declares only the locale injection dependency', () => {
  assert.deepEqual(packageManifest.dsh?.client?.inject, ['@deepseek-ai/dsh-client-locale']);
});

test('public runtime exports stay paired with their TypeScript declarations', () => {
  for (const [specifier, runtime, declarations] of [
    ['.', './lib/index.js', './lib/types/index.d.ts'],
    ['./client', './lib/client.js', './lib/types/client/index.d.ts'],
  ]) {
    assert.deepEqual(packageManifest.exports?.[specifier], {
      types: declarations,
      default: runtime,
    });
  }
});

test('screenshot manifest contains 1-8 safe existing image paths', () => {
  assert(Array.isArray(declaredScreenshots), 'screenshots.json must be an array');
  assert(declaredScreenshots.length >= 1 && declaredScreenshots.length <= 8, 'market accepts 1-8 screenshots');
  assert.equal(new Set(declaredScreenshots).size, declaredScreenshots.length, 'screenshot paths must be unique');

  for (const screenshot of declaredScreenshots) {
    assert.equal(typeof screenshot, 'string');
    assert.match(screenshot, /^assets\/screenshots\/[^/]+\.png$/);
    assert(!isAbsolute(screenshot), `screenshot path must be relative: ${screenshot}`);
    assert(!screenshot.split('/').includes('..'), `screenshot path escapes repository: ${screenshot}`);
    assert(existsSync(join(root, screenshot)), `missing screenshot: ${screenshot}`);
  }
});

test(`published ${packageVersion} package contains public docs and runtime but no internal evidence`, () => {
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
  const [{ files, name, version }] = JSON.parse(result.stdout);
  assert.equal(name, packageManifest.name);
  assert.equal(version, packageVersion);
  const paths = new Set(files.map((file) => file.path));

  for (const required of [
    'screenshots.json',
    'assets/brand/archive-management-banner.png',
    'CHANGELOG.md',
    'docs/ARCHITECTURE.md',
    'docs/ARCHITECTURE.en.md',
    'docs/USER_GUIDE.md',
    'docs/USER_GUIDE.zh-CN.md',
    'lib/about.js',
    'lib/auto-retention.js',
    'lib/client.js',
    'lib/deletion-safety.js',
    'lib/durable.js',
    'lib/export.js',
    'lib/import.js',
    'lib/index.js',
    'lib/insights.js',
    'lib/lineage.js',
    'lib/metadata.js',
    'lib/persistence-compat.js',
    'lib/recycle.js',
    'lib/restore.js',
    'lib/retention-service.js',
    'lib/retention.js',
    'lib/search.js',
    'lib/snapshot.js',
    'lib/stats.js',
    'lib/trash.js',
    'lib/types/client/index.d.ts',
    'lib/types/index.d.ts',
    'lib/workspace-bulk-archive.js',
  ]) assert(paths.has(required), `missing ${required}`);

  assert(!paths.has('assets/brand/session-archive-banner.png'), 'obsolete banner must not be published');
  const packedScreenshots = [...paths].filter((path) => path.startsWith('assets/screenshots/')).sort();
  assert.deepEqual(packedScreenshots, [...declaredScreenshots].sort(), 'publish only manifest screenshots');

  for (const path of paths) {
    assert(!path.startsWith('data/'), `local data leaked: ${path}`);
    assert(!path.startsWith('.codegraph/'), `CodeGraph state leaked: ${path}`);
    assert(!path.startsWith('.superpowers/'), `planning evidence leaked: ${path}`);
    assert(!path.startsWith('docs/superpowers/'), `planning scratch leaked: ${path}`);
    assert(!path.startsWith('.worktrees/'), `worktree leaked: ${path}`);
    assert(!/(^|\/)(?:raw|source|sources|fixtures?|logs?)(\/|$)/i.test(path), `raw/log/fixture artifact leaked: ${path}`);
    assert(!/(?:\.bak|\.backup|\.log|\.tmp|~)$/i.test(path), `backup/log/temp file leaked: ${path}`);
    assert(!path.includes('/staging/'), `staging file leaked: ${path}`);
    assert(!path.startsWith('test/'), `test artifact leaked: ${path}`);
  }
});
