import assert from 'node:assert/strict';
import test from 'node:test';
import * as aboutModule from '../lib/about.js';

const { createAboutService } = aboutModule;

const REGISTRY_URL = 'https://registry.npmjs.org/dsh-archived-chats/latest';
const START = Date.parse('2026-09-20T08:00:00.000Z');

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
