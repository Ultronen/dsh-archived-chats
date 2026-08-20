import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { inspectImport, selectImportItems } from '../lib/import.js';

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
      source: {
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
  const record = JSON.parse(new TextDecoder().decode(withPollution.plan.items[0].jsonBytes));
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
