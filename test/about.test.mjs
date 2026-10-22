import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as aboutModule from '../lib/about.js';

const { createAboutService } = aboutModule;

const REGISTRY_URL = 'https://registry.npmjs.org/dsh-archived-chats/latest';
const START = Date.parse('2026-09-20T08:00:00.000Z');

test('runtime targets the actual profile, quotes its command and refuses local, changed or HMR installations', async (t) => {
  assert.equal(typeof aboutModule.createUpdateRuntime, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'archive-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'node_modules', 'dsh-archived-chats');
  const cli = join(dir, 'cli');
  mkdirSync(root, { recursive: true }); mkdirSync(cli);
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'bin.js' } }));
  writeFileSync(join(cli, 'bin.js'), '');
  const save = spec => writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-archived-chats': spec } }));
  save('^1.3.3');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-archived-chats', version: '1.3.3' }));
  const installed = [];
  const services = { profileContext: { name: "web's profile", dir }, pluginManager: { async installBundle(spec) {
    installed.push(spec); writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-archived-chats', version: '1.4.0' }));
    return { application: 'restart-required', version: '1.4.0', bundle: 'dsh-archived-chats' };
  } } };
  const runtime = aboutModule.createUpdateRuntime({ get: name => services[name] }, {
    packageRoot: root, argv: ['node', join(cli, 'bin.js')], execPath: '/some path/node', platform: 'darwin', env: {}
  });
  const info = runtime.describe('1.4.0');
  assert.equal(info.profile, "web's profile"); assert.equal(info.source, 'registry'); assert.equal(info.canInstall, true);
  assert(info.command.includes("'web'\"'\"'s profile'")); assert(info.command.startsWith("'/some path/node'"));
  services.hmr = {}; assert.equal(runtime.describe('1.4.0').canInstall, false); delete services.hmr;
  save('link:../../development');
  assert.equal(runtime.describe('1.4.0').source, 'local');
  assert.equal(runtime.describe('1.4.0').command, null);
  await assert.rejects(runtime.install('1.4.0'), { code: 'update-local-install' });
  assert.deepEqual(installed, []);
  save('^1.3.3'); await runtime.install('1.4.0');
  assert.deepEqual(installed, ['dsh-archived-chats@1.4.0']);
  services.profileContext.name = 'desktop';
  const desktop = runtime.describe('1.4.0');
  assert.equal(desktop.environment, 'desktop');
  assert.equal(desktop.command, null, 'desktop never offers the unrelated npm CLI as a fallback');
  delete services.profileContext;
  assert.equal(runtime.describe('1.4.0').canInstall, false, 'missing context must not default writes to web');
});

function response(body, overrides = {}) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: { get: () => null },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    ...overrides,
  };
}

test('about exposes package identity, trusted links, and an unchecked initial state without fetching', () => {
  let fetchCalls = 0;
  const service = createAboutService({
    version: '1.3.3',
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
  });

  assert.deepEqual(service.about(), {
    name: 'dsh-archived-chats',
    version: '1.3.3',
    author: 'Ultronen',
    license: 'MIT',
    links: {
      home: 'https://github.com/Ultronen/dsh-archived-chats',
      feedback: 'https://github.com/Ultronen/dsh-archived-chats/issues/new/choose',
      guide: 'https://github.com/Ultronen/dsh-archived-chats/blob/main/docs/USER_GUIDE.zh-CN.md',
      guideZh: 'https://github.com/Ultronen/dsh-archived-chats/blob/main/docs/USER_GUIDE.zh-CN.md',
      guideEn: 'https://github.com/Ultronen/dsh-archived-chats/blob/main/docs/USER_GUIDE.md',
      changelog: 'https://github.com/Ultronen/dsh-archived-chats/blob/main/CHANGELOG.md',
      marketplace: 'https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/',
    },
    update: { status: 'unchecked', latestVersion: null, checkedAt: null },
  });
  assert.equal(fetchCalls, 0);

  const changed = service.about();
  changed.links.home = 'https://untrusted.invalid';
  changed.update.status = 'available';
  assert.equal(service.about().links.home, 'https://github.com/Ultronen/dsh-archived-chats');
  assert.equal(service.about().update.status, 'unchecked');
});

test('update check uses only the fixed public endpoint and reports a newer stable version', async () => {
  const calls = [];
  const service = createAboutService({
    version: '1.3.3',
    now: () => START,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ name: 'dsh-archived-chats', version: '1.4.0' });
    },
  });

  const result = await service.checkUpdates({ force: false });

  assert.deepEqual(result.update, {
    status: 'available',
    latestVersion: '1.4.0',
    checkedAt: '2026-09-20T08:00:00.000Z',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REGISTRY_URL);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.accept, 'application/json');
  assert(calls[0].options.signal instanceof AbortSignal);
  assert.equal(Object.hasOwn(calls[0].options, 'body'), false);
});

test('SemVer ordering handles stable, prerelease, build metadata, and an older registry result', async () => {
  const cases = [
    ['1.3.3', '1.3.3', 'current'],
    ['1.3.3', '1.3.3+registry.1', 'current'],
    ['1.3.3', '1.3.4-beta.1', 'available'],
    ['2.0.0-beta.2', '2.0.0-beta.11', 'available'],
    ['2.0.0-beta.11', '2.0.0-beta.2', 'current'],
    ['2.0.0-rc.1', '2.0.0', 'available'],
    ['2.0.0', '2.0.0-rc.9', 'current'],
    ['10.0.0', '9.999.999', 'current'],
  ];
  for (const [installed, latest, status] of cases) {
    const service = createAboutService({
      version: installed,
      now: () => START,
      fetchImpl: async () => response({ name: 'dsh-archived-chats', version: latest }),
    });
    assert.equal((await service.checkUpdates({ force: false })).update.status, status, `${installed} vs ${latest}`);
  }
});

test('automatic checks cache success for twelve hours while forced checks bypass it with a short cooldown', async () => {
  let nowMs = START;
  let calls = 0;
  const versions = ['1.4.0', '1.5.0', '1.6.0', '1.7.0'];
  const service = createAboutService({
    version: '1.3.3',
    now: () => nowMs,
    fetchImpl: async () => response({ name: 'dsh-archived-chats', version: versions[calls++] }),
  });

  assert.equal((await service.checkUpdates({ force: false })).update.latestVersion, '1.4.0');
  nowMs += 12 * 60 * 60 * 1000 - 1;
  assert.equal((await service.checkUpdates({ force: false })).update.latestVersion, '1.4.0');
  assert.equal(calls, 1);

  assert.equal((await service.checkUpdates({ force: true })).update.latestVersion, '1.5.0');
  assert.equal((await service.checkUpdates({ force: true })).update.latestVersion, '1.5.0');
  assert.equal(calls, 2);
  nowMs += 30_000;
  assert.equal((await service.checkUpdates({ force: true })).update.latestVersion, '1.6.0');
  assert.equal(calls, 3);

  nowMs += 12 * 60 * 60 * 1000;
  assert.equal((await service.checkUpdates({ force: false })).update.latestVersion, '1.7.0');
  assert.equal(calls, 4);
});

test('concurrent automatic and forced checks share one registry request', async () => {
  let calls = 0;
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const service = createAboutService({
    version: '1.3.3',
    now: () => START,
    fetchImpl: async () => {
      calls += 1;
      await paused;
      return response({ name: 'dsh-archived-chats', version: '1.4.0' });
    },
  });

  const automatic = service.checkUpdates({ force: false });
  const forced = service.checkUpdates({ force: true });
  release();
  const [left, right] = await Promise.all([automatic, forced]);
  assert.equal(calls, 1);
  assert.deepEqual(left, right);
});

test('failures are cached, report unavailable, and retain only a previously verified latest version', async () => {
  let nowMs = START;
  let calls = 0;
  const service = createAboutService({
    version: '1.3.3',
    now: () => nowMs,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1 || calls === 3) throw new Error('offline');
      return response({ name: 'dsh-archived-chats', version: '1.4.0' });
    },
  });

  assert.deepEqual((await service.checkUpdates({ force: false })).update, {
    status: 'unavailable', latestVersion: null, checkedAt: '2026-09-20T08:00:00.000Z',
  });
  nowMs += 1_000;
  assert.equal((await service.checkUpdates({ force: false })).update.status, 'unavailable');
  assert.equal(calls, 1);

  const recovered = await service.checkUpdates({ force: true });
  assert.equal(recovered.update.status, 'available');
  assert.equal(recovered.update.latestVersion, '1.4.0');
  nowMs += 30_000;
  const failedAgain = await service.checkUpdates({ force: true });
  assert.deepEqual(failedAgain.update, {
    status: 'unavailable', latestVersion: '1.4.0', checkedAt: '2026-09-20T08:00:31.000Z',
  });
});

test('redirects, oversized bodies, malformed JSON, and invalid versions never become latest', async () => {
  const failures = [
    response({ name: 'dsh-archived-chats', version: '9.0.0' }, { redirected: true }),
    response('x'.repeat(257)),
    response('{broken'),
    response({ name: 'another-package', version: '9.0.0' }),
    response({ name: 'dsh-archived-chats', version: '1.4' }),
    response({ name: 'dsh-archived-chats', version: '1.04.0' }),
  ];
  for (const registryResponse of failures) {
    const service = createAboutService({
      version: '1.3.3',
      now: () => START,
      maxResponseBytes: 256,
      fetchImpl: async () => registryResponse,
    });
    assert.deepEqual((await service.checkUpdates({ force: false })).update, {
      status: 'unavailable', latestVersion: null, checkedAt: '2026-09-20T08:00:00.000Z',
    });
  }
});

test('a stalled registry request is aborted at the configured timeout', async () => {
  let aborted = false;
  const service = createAboutService({
    version: '1.3.3',
    now: () => START,
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });

  assert.equal((await service.checkUpdates({ force: false })).update.status, 'unavailable');
  assert.equal(aborted, true);
});

test('about route handlers keep GET read-only and require an exact guarded POST body', async () => {
  assert.equal(typeof aboutModule.createAboutRouteHandlers, 'function');
  const sent = [];
  const checks = [];
  let body = { force: true };
  let guarded = true;
  const payload = createAboutService({ version: '1.3.3' }).about();
  const handlers = aboutModule.createAboutRouteHandlers({
    service: {
      about: () => payload,
      checkUpdates: async (value) => { checks.push(value); return payload; },
    },
    guard: () => guarded,
    readBody: async () => body,
    send: (_res, status, value) => sent.push({ status, value }),
  });

  await handlers.about({ method: 'GET' }, {});
  assert.deepEqual(sent.pop(), { status: 200, value: payload });
  assert.deepEqual(checks, []);

  await handlers.about({ method: 'POST' }, {});
  assert.deepEqual(sent.pop(), { status: 405, value: { error: 'method-not-allowed' } });

  guarded = false;
  await handlers.checkUpdates({ method: 'POST' }, {});
  assert.deepEqual(checks, []);
  guarded = true;

  for (body of [{}, { force: 'true' }, { force: false, extra: true }, null]) {
    await handlers.checkUpdates({ method: 'POST' }, {});
    assert.deepEqual(sent.pop(), { status: 400, value: { error: 'about-check-invalid' } });
  }

  body = { force: false };
  await handlers.checkUpdates({ method: 'POST' }, {});
  assert.deepEqual(checks, [{ force: false }]);
  assert.deepEqual(sent.pop(), { status: 200, value: payload });
});

test('automatic checks retry an offline registry after fifteen minutes, without waiting twelve hours', async () => {
  let clock = START, online = false, calls = 0;
  const service = createAboutService({ now: () => clock, fetchImpl: async () => {
    calls++; if (!online) throw new Error('offline');
    return response({ name: 'dsh-archived-chats', version: '9.0.0' });
  } });
  await service.checkUpdates({ force: false }); online = true;
  clock += 14 * 60_000; await service.checkUpdates({ force: false }); assert.equal(calls, 1);
  clock += 60_000;
  assert.equal((await service.checkUpdates({ force: false })).update.status, 'available');
  assert.equal(calls, 2);
});

test('install requires the exact reviewed newer version, deduplicates submissions and keeps the running version honest', async () => {
  let release, calls = [];
  const runtime = { describe: () => ({ source: 'registry', canInstall: true }),
    install: async version => { calls.push(version); await new Promise(resolve => { release = resolve; }); } };
  const service = createAboutService({ version: '1.3.3', runtime,
    fetchImpl: async () => response({ name: 'dsh-archived-chats', version: '1.4.0' }) });
  assert.equal(typeof service.installUpdate, 'function');
  await service.checkUpdates({ force: false });
  await assert.rejects(service.installUpdate({ version: '1.5.0' }), { code: 'update-version-changed' });
  const first = service.installUpdate({ version: '1.4.0' });
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(service.installUpdate({ version: '1.4.0' }), { code: 'update-busy' });
  release(); const result = await first;
  assert.deepEqual(calls, ['1.4.0']);
  assert.equal(result.version, '1.3.3');
  assert.equal(result.install.status, 'restart-required');
  assert.equal(result.install.version, '1.4.0');
  await assert.rejects(service.installUpdate({ version: '1.4.0' }), { code: 'update-restart-required' });
});

test('local checkout protection is enforced by the backend and failed installation never reports success', async () => {
  let calls = 0;
  const service = createAboutService({ version: '1.3.3', runtime: {
    describe: () => ({ source: 'local', canInstall: false }), install: async () => { calls++; }
  }, fetchImpl: async () => response({ name: 'dsh-archived-chats', version: '1.4.0' }) });
  assert.equal(typeof service.installUpdate, 'function');
  await service.checkUpdates({ force: false });
  await assert.rejects(service.installUpdate({ version: '1.4.0' }), { code: 'update-local-install' });
  assert.equal(calls, 0);
  const failed = createAboutService({ version: '1.3.3', runtime: {
    describe: () => ({ source: 'registry', canInstall: true }), install: async () => { throw new Error('/synthetic/private/token-secret'); }
  }, fetchImpl: async () => response({ name: 'dsh-archived-chats', version: '1.4.0' }) });
  await failed.checkUpdates({ force: false });
  await assert.rejects(failed.installUpdate({ version: '1.4.0' }), { code: 'update-install-failed' });
  assert.equal(failed.about().install.status, 'failed');
  assert(!JSON.stringify(failed.about()).includes('token-secret'));
});

test('install route rejects nonlocal or cross-origin writes and never accepts a package or command from the browser', async () => {
  const sent = [], installs = [];
  let body = { version: '1.4.0' }, guarded = true;
  const handlers = aboutModule.createAboutRouteHandlers({
    service: { installUpdate: async value => { installs.push(value); return { ok: true }; } },
    guard: () => guarded, readBody: async () => body, send: (_res, status, value) => sent.push({ status, value }),
  });
  const req = { method: 'POST', headers: { host: '[::1]:3000', origin: 'http://[::1]:3000' }, socket: { remoteAddress: '127.0.0.2' } };
  guarded = false; await handlers.installUpdate(req, {}); assert.equal(installs.length, 0); guarded = true;
  for (const bad of [
    { ...req, socket: { remoteAddress: '192.168.1.2' } },
    { ...req, headers: { ...req.headers, origin: 'https://attacker.example' } },
    { ...req, headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } },
  ]) { await handlers.installUpdate(bad, {}); assert.equal(sent.pop().status, 403); }
  for (body of [{ version: '1.4.0', command: 'anything' }, { version: 'latest' }, { version: '--help' }, {}]) {
    await handlers.installUpdate(req, {}); assert.equal(sent.pop().status, 400);
  }
  assert.equal(installs.length, 0);
  body = { version: '1.4.0' }; await handlers.installUpdate(req, {});
  assert.deepEqual(installs, [{ version: '1.4.0' }]);
  // Official Desktop forwards its HTTP request without an Origin.
  await handlers.installUpdate({ ...req, headers: { host: '[::1]:3000' }, socket: { remoteAddress: '::1' } }, {});
  assert.equal(sent.pop().status, 200);
});

test('manual update information never targets an older public release than the running version', async () => {
  const service = createAboutService({ version: '2.0.0', runtime: { describe: version => ({ packageSpec: `dsh-archived-chats@${version}` }) },
    fetchImpl: async () => response({ name: 'dsh-archived-chats', version: '1.9.9' }) });
  const info = await service.checkUpdates({ force: false });
  assert.equal(info.installation.packageSpec, 'dsh-archived-chats@2.0.0');
  assert.equal(info.update.status, 'current');
});
