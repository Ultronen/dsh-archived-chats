import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { IMPORT_LIMITS, inspectImport, selectImportItems } from '../lib/import.js';
import { createExportZip, planExport } from '../lib/export.js';
import { createRestoreAdapter } from '../lib/restore.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportTokenStore } from '../lib/index.js';

function makePackage(items, extra = {}) {
  const files = {};
  const sessions = items.map((input, index) => {
    const id = input.id ?? `session-${index + 1}`;
    const directory = `sessions/${String(index + 1).padStart(3, '0')}-${id}`;
    const archive = {
      id,
      title: input.title ?? 'Untitled',
      workspace: input.workspace === undefined ? { id: 'ws-1', title: 'Workspace' } : input.workspace,
      createdAt: input.createdAt ?? 1700000000000,
      origin: input.origin ?? 'user',
      metadataUpdatedAt: input.metadataUpdatedAt ?? null,
      tags: input.tags ?? [],
      note: input.note ?? '',
      storage: input.storage ?? { status: 'ready', sizeBytes: 12, fileCount: 1 },
      files: {
        json: `${directory}/session.json`,
        markdown: `${directory}/transcript.md`,
      },
    };
    const record = {
      format: 'dsh-archived-chats/session',
      version: 1,
      exportedAt: '2026-08-20T00:00:00.000Z',
      archive,
      source: input.source ?? {
        meta: { id, createdAt: archive.createdAt },
        events: input.events ?? [],
      },
    };
    files[archive.files.json] = strToU8(JSON.stringify(record));
    files[archive.files.markdown] = strToU8(`# ${archive.title}\n`);
    return archive;
  });
  const manifest = {
    format: 'dsh-archived-chats/export',
    version: 1,
    exportedAt: '2026-08-20T00:00:00.000Z',
    generator: { name: 'dsh-archived-chats', version: '0.7.0' },
    sessionCount: sessions.length,
    attachmentsIncluded: false,
    sessions,
    ...extra.manifest,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  for (const [name, value] of Object.entries(extra.files ?? {})) files[name] = typeof value === 'string' ? strToU8(value) : value;
  return zipSync(files);
}

function rewriteZipUncompressedSize(bytes, size) {
  const rewritten = bytes.slice();
  const view = new DataView(rewritten.buffer, rewritten.byteOffset, rewritten.byteLength);
  const findSignature = (signature) => {
    for (let index = 0; index <= rewritten.length - signature.length; index += 1) {
      if (signature.every((value, offset) => rewritten[index + offset] === value)) return index;
    }
    return -1;
  };
  const local = findSignature([0x50, 0x4b, 0x03, 0x04]);
  const central = findSignature([0x50, 0x4b, 0x01, 0x02]);
  assert.notEqual(local, -1);
  assert.notEqual(central, -1);
  view.setUint32(local + 22, size, true);
  view.setUint32(central + 24, size, true);
  return rewritten;
}

test('valid v1 package produces a preview without raw transcript data', () => {
  const bytes = makePackage([{ id: 'session-a', title: 'Alpha', tags: ['one'], note: 'keep' }]);
  const result = inspectImport({ bytes, compressedBytes: bytes.length });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.items.map((item) => item.id), ['session-a']);
  assert.equal(result.plan.items[0].title, 'Alpha');
  assert.equal(result.plan.items[0].note, 'keep');
  assert.equal('events' in result.plan.items[0], false);
  assert.equal(result.plan.items[0].hasAttachmentReferences, false);
});

test('stops ZIP expansion at the configured actual-byte limit', () => {
  const bytes = rewriteZipUncompressedSize(
    zipSync({ 'manifest.json': new Uint8Array(2048) }, { level: 9 }),
    512,
  );
  const result = inspectImport(
    { bytes, compressedBytes: bytes.byteLength },
    { limits: { ...IMPORT_LIMITS, maxUncompressedBytes: 1024, maxEntryBytes: 1024 } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'limit-exceeded');
});

test('keeps empty input classified as an invalid ZIP', () => {
  const result = inspectImport({ bytes: new Uint8Array(), compressedBytes: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'zip-invalid');
});

test('rejects JSON depth beyond the configured budget', () => {
  let nested = 'leaf';
  for (let depth = 0; depth < 6; depth += 1) nested = { child: nested };
  const bytes = makePackage([{ id: 'deep', events: [nested] }]);
  const result = inspectImport(
    { bytes, compressedBytes: bytes.byteLength },
    { limits: { ...IMPORT_LIMITS, maxJsonDepth: 4 } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'json-limit-exceeded');
});

test('rejects JSON nodes beyond the configured budget', () => {
  const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(Array.from({ length: 25 }, (_, index) => index))) });
  const result = inspectImport(
    { bytes, compressedBytes: bytes.byteLength },
    { limits: { ...IMPORT_LIMITS, maxJsonNodes: 20 } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'json-limit-exceeded');
});

test('rejects JSON strings beyond the configured budget', () => {
  const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify({ probe: '界'.repeat(65) })) });
  const result = inspectImport(
    { bytes, compressedBytes: bytes.byteLength },
    { limits: { ...IMPORT_LIMITS, maxJsonStringCodePoints: 64 } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'json-limit-exceeded');
});

test('rejects a manifest beyond the configured byte budget', () => {
  const bytes = makePackage([{ id: 'manifest-budget' }]);
  const result = inspectImport(
    { bytes, compressedBytes: bytes.byteLength },
    { limits: { ...IMPORT_LIMITS, maxManifestBytes: 64 } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'limit-exceeded');
  assert.equal(result.errors[0].path, 'manifest.json');
});

test('rejects ZIP entries beyond the configured budget', () => {
  const bytes = zipSync({
    'one.txt': strToU8('1'),
    'two.txt': strToU8('2'),
    'three.txt': strToU8('3'),
  });
  const result = inspectImport(
    { bytes, compressedBytes: bytes.byteLength },
    { limits: { ...IMPORT_LIMITS, maxEntries: 2 } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'limit-exceeded');
});

test('rejects unsupported, incomplete, duplicate, unsafe, and mismatched packages', () => {
  const noManifest = inspectImport({ bytes: zipSync({ 'sessions/a': strToU8('x') }) });
  assert.equal(noManifest.ok, false);
  assert.equal(noManifest.errors[0].code, 'manifest-missing');

  const unsupported = inspectImport({ bytes: makePackage([{ id: 'a' }], { manifest: { version: 2 } }) });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.errors[0].code, 'format-unsupported');

  const duplicateId = inspectImport({ bytes: makePackage([{ id: 'a' }, { id: 'a' }]) });
  assert.equal(duplicateId.ok, false);
  assert.equal(duplicateId.errors[0].code, 'session-duplicate');

  const extra = inspectImport({ bytes: makePackage([{ id: 'a' }], { files: { 'sessions/extra.txt': 'x' } }) });
  assert.equal(extra.ok, false);
  assert.equal(extra.errors[0].code, 'entry-unreferenced');

  const unsafe = inspectImport({ bytes: makePackage([{ id: 'a' }], { files: { '../escape': 'x' } }) });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.errors[0].code, 'path-unsafe');

  const mismatch = makePackage([{ id: 'a' }]);
  const decoded = inspectImport({ bytes: mismatch });
  assert.equal(decoded.ok, true);
});

test('rejects duplicate ZIP entries and prototype pollution keys', () => {
  const duplicate = zipSync({
    'manifest.json': strToU8('{}'),
    'manifest.json\u0000': strToU8('{}'),
  });
  const result = inspectImport({ bytes: duplicate });
  assert.equal(result.ok, false);

  const polluted = makePackage([{ id: 'a' }]);
  const withPollution = inspectImport({ bytes: polluted, compressedBytes: polluted.length });
  assert.equal(withPollution.ok, true);
  const record = withPollution.plan.items[0].record;
  assert.equal(record.format, 'dsh-archived-chats/session');
});

test('reports attachment references and unresolved workspace warnings', () => {
  const bytes = makePackage([{
    id: 'session-a',
    workspace: null,
    events: [{ type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }] } } }],
  }]);
  const result = inspectImport({ bytes });
  assert.equal(result.ok, true);
  assert.equal(result.plan.items[0].hasAttachmentReferences, true);
  assert.deepEqual(result.plan.items[0].warnings, ['attachments-not-included', 'workspace-unresolved']);
});

test('rejects missing, mismatched, and malformed persistence source payloads', () => {
  for (const [source, code] of [
    [{}, 'source-invalid'],
    [{ meta: { id: 'other-session' }, events: [] }, 'session-mismatch'],
    [{ meta: { id: 'session-a' }, events: {} }, 'source-invalid'],
    [{ meta: { id: 'session-a' }, events: [null] }, 'source-invalid'],
    [{ meta: { id: 'session-a' }, events: [{ time: 1e300 }] }, 'field-invalid'],
  ]) {
    const result = inspectImport({ bytes: makePackage([{ id: 'session-a', source }]) });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((entry) => entry.code === code));
  }
});

test('rejects malformed generator, workspace, storage, and unsafe session identities', () => {
  const generator = inspectImport({ bytes: makePackage([{ id: 'a' }], { manifest: { generator: null } }) });
  assert.equal(generator.ok, false);
  assert.ok(generator.errors.some((entry) => entry.path === 'manifest.generator'));

  for (const input of [
    { id: '__proto__' },
    { id: 'a', workspace: { id: 3, title: 'Workspace' } },
    { id: 'a', storage: { status: 'ready', sizeBytes: -1, fileCount: 1 } },
    { id: 'a', createdAt: 1e300 },
  ]) {
    const result = inspectImport({ bytes: makePackage([input]) });
    assert.equal(result.ok, false);
  }
});

test('selection keeps manifest order and skips conflicts without mutation', () => {
  const bytes = makePackage([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const result = inspectImport({ bytes });
  assert.equal(result.ok, true);
  const selected = selectImportItems(result.plan, ['c', 'a', 'unknown'], new Set(['a']));
  assert.deepEqual(selected.records.map((item) => item.id), ['c']);
  assert.deepEqual(selected.skipped, [
    { id: 'a', reason: 'id-conflict' },
    { id: 'unknown', reason: 'selection-unknown' },
  ]);
});

test('import confirmation tokens enforce count and retained-byte capacity', () => {
  let now = 0;
  const store = createImportTokenStore({ now: () => now, ttlMs: 100, maxEntries: 2, maxBytes: 10 });
  const first = store.create({ totalBytes: 4, id: 'first' });
  store.create({ totalBytes: 6, id: 'second' });
  assert.throws(() => store.create({ totalBytes: 1, id: 'third' }),
    (error) => error.code === 'import-token-capacity' && error.status === 503);
  assert.equal(store.consume(first.token, first.nonce).id, 'first');
  assert.doesNotThrow(() => store.create({ totalBytes: 4, id: 'replacement' }));
  now = 101;
  store.cleanup();
  assert.doesNotThrow(() => store.create({ totalBytes: 10, id: 'after-expiry' }));
});

/**
 * The backup loop end to end: a ZIP produced by the real exporter has to pass
 * the real importer and then actually land through a host writer. Hand-built
 * fixtures cannot catch a drift between the two halves, or a writer contract
 * the running host never satisfies.
 */
test('a real export ZIP validates and restores through an ordinary create/append host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-roundtrip-'));
  const events = [
    { type: 'session/title', data: { title: 'Round trip 会话' } },
    {
      seq: 10,
      time: Date.parse('2026-08-19T10:00:00.000Z'),
      type: 'user/message',
      surfaceOp: 'append',
      data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    },
  ];
  const plan = planExport([{
    id: 'session-x',
    title: 'Round trip 会话',
    createdAt: 1786726311605,
    origin: null,
    workspaceId: 'ws-1',
    workspaceTitle: 'Project',
    tags: ['keep'],
    note: 'a note',
    metadataUpdatedAt: '2026-08-18T12:00:00.000Z',
    storage: { status: 'ready', sizeBytes: 10, fileCount: 1 },
  }], new Date('2026-08-28T00:00:00.000Z'));
  const zip = await createExportZip({
    plan,
    inspect: async (id) => ({ meta: { id, createdAt: 1786726311605 }, events }),
    generatorVersion: '9.9.9',
  });
  const chunks = [];
  zip.stream.on('data', (chunk) => chunks.push(chunk));
  await zip.completion;
  const bytes = new Uint8Array(Buffer.concat(chunks));

  const inspected = inspectImport({ bytes, compressedBytes: bytes.byteLength });
  assert.deepEqual(inspected.errors, undefined);
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.plan.items.map((item) => item.id), ['session-x']);

  const created = [];
  const appended = [];
  const archiveState = { archivedSessionIds: [] };
  const persistence = {
    list: async () => [],
    // A session log that does not exist yet reads as missing; that must not
    // abort the restore.
    inspect: async (id) => { throw Object.assign(new Error('no log yet'), { code: 'ENOENT', id }); },
    create: async (meta) => { created.push(meta.id); },
    append: async (id, batch) => { appended.push([id, batch.length]); },
    locate: (meta) => ({ kind: 'jsonl', path: join(root, 'sessions', String(meta.id), 'session.jsonl.zstd') }),
    removeSession: async () => {},
  };
  const registry = {
    state: archiveState,
    get archivedSessionIds() { return archiveState.archivedSessionIds; },
    setState: async (next) => { archiveState.archivedSessionIds = next.archivedSessionIds; },
    list: () => [{ id: 'ws-1', title: 'Project', sessionIds: [], attachSession: async () => {}, detachSession: async () => {} }],
  };
  const saved = new Map();
  const metadataStore = {
    getMany: async () => ({ status: 'ready', entries: {} }),
    set: async (id, value) => { saved.set(id, value); return { ...value, updatedAt: 'now' }; },
    remove: async () => {},
  };
  const adapter = createRestoreAdapter({ persistence, registry, metadataStore, tempRoot: root });
  assert.deepEqual(adapter.capability, { supported: true });

  const selected = selectImportItems(inspected.plan, ['session-x'], new Set());
  assert.deepEqual(selected.skipped, []);
  const transaction = await adapter.prepare(selected.records, { knownIds: new Set() });
  for (const item of selected.records) await transaction.stage(item);
  const result = await transaction.commit();

  assert.deepEqual(result.restored, ['session-x']);
  assert.deepEqual(created, ['session-x']);
  assert.deepEqual(appended, [['session-x', events.length]]);
  assert.deepEqual(archiveState.archivedSessionIds, ['session-x']);
  assert.deepEqual(saved.get('session-x'), { tags: ['keep'], note: 'a note' });
  await rm(root, { recursive: true, force: true });
});
