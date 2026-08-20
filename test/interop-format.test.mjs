import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTEROP_FORMAT,
  INTEROP_VERSION,
  createInteropManifest,
  createInteropSession,
  validateInteropManifest,
} from '../lib/interop/format.js';
import { createInteropReport } from '../lib/interop/report.js';

function session(overrides = {}) {
  return createInteropSession({
    id: 'session-1',
    title: '  A useful title  ',
    workspace: { id: 'workspace-1', title: 'Main' },
    messages: [
      { id: 'message-1', role: 'user', content: 'Hello', createdAt: 1 },
      { id: 'message-2', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ],
    attachments: [{ path: 'attachments/image.png', mediaType: 'image/png' }],
    losses: [],
    source: 'codex',
    ...overrides,
  });
}

function manifest(overrides = {}) {
  return createInteropManifest({
    source: 'codex',
    sourceVersion: '1',
    sessions: [session()],
    exportedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  });
}

test('creates and validates a version-one interop manifest', () => {
  const value = manifest();
  assert.equal(value.format, INTEROP_FORMAT);
  assert.equal(value.formatVersion, INTEROP_VERSION);
  assert.equal(value.source, 'codex');
  assert.match(value.sha256, /^[a-f0-9]{64}$/);
  const result = validateInteropManifest(value);
  assert.deepEqual(result, { ok: true, value });
});

test('reports a structured error for a missing source', () => {
  const value = manifest({ source: '' });
  const result = validateInteropManifest(value);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'source-required' && item.path === '$.source'));
});

test('rejects duplicate session IDs', () => {
  const value = manifest({ sessions: [session(), session({ id: 'session-1' })] });
  const result = validateInteropManifest(value);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'session-duplicate'));
});

test('rejects unsupported format versions', () => {
  const value = manifest();
  value.formatVersion = INTEROP_VERSION + 1;
  const result = validateInteropManifest(value);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'version-unsupported'));
});

test('rejects malformed messages', () => {
  const value = manifest({ sessions: [session({ messages: [{ role: 'user' }] })] });
  const result = validateInteropManifest(value);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'message-invalid'));
});

test('rejects unsafe attachment paths', () => {
  const value = manifest({
    sessions: [session({ attachments: [{ path: '../secrets.txt' }] })],
  });
  const result = validateInteropManifest(value);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'attachment-path-unsafe'));
});

test('produces stable SHA-256 values without mutating source objects', () => {
  const input = {
    source: 'codex',
    sourceVersion: '1',
    sessions: [session()],
    exportedAt: '2026-08-21T00:00:00.000Z',
  };
  const before = structuredClone(input);
  const first = createInteropManifest(input);
  const second = createInteropManifest(input);
  assert.deepEqual(input, before);
  assert.equal(first.sha256, second.sha256);
  assert.equal(validateInteropManifest(first).ok, true);
});

test('locks the SHA-256 digest for the canonical wire manifest', () => {
  assert.equal(
    manifest().sha256,
    '446512aadd5c125a881f8d5344f8adba6978f42c53ea4aab32522e8849f4dcc5',
  );
});

test('bounds digest traversal for deeply nested known values and ignores extensions', () => {
  let deep = { leaf: 'x' };
  for (let index = 0; index < 100; index += 1) deep = { nested: deep };

  const knownValue = manifest();
  knownValue.sessions[0].messages[0].content = [deep];
  const bounded = validateInteropManifest(knownValue);
  assert.equal(bounded.ok, false);
  assert.ok(bounded.errors.some((item) => item.code === 'manifest-bounded'));

  const extensionValue = manifest();
  extensionValue.extension = deep;
  assert.doesNotThrow(() => validateInteropManifest(extensionValue));
  assert.equal(validateInteropManifest(extensionValue).ok, true);
});

test('never throws when validating untrusted values', () => {
  for (const value of [null, undefined, 1, 'text', [], { sessions: null }, { get format() { throw new Error('boom'); } }]) {
    assert.doesNotThrow(() => validateInteropManifest(value));
    assert.equal(validateInteropManifest(value).ok, false);
  }
});

test('creates a plain structured interoperability report', () => {
  const value = createInteropReport({
    source: 'claude',
    sessions: [session()],
    losses: [{ code: 'tool-output', message: 'not representable' }],
    conflicts: [{ id: 'session-1', reason: 'existing' }],
    warnings: ['attachments-not-included'],
  });
  assert.deepEqual(value.source, 'claude');
  assert.equal(value.sessions.length, 1);
  assert.equal(value.losses.length, 1);
  assert.equal(value.conflicts.length, 1);
  assert.deepEqual(value.warnings, ['attachments-not-included']);
  assert.deepEqual(value.summary, { sessions: 1, losses: 1, conflicts: 1, warnings: 1 });
});
