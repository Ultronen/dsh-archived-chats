import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SNAPSHOT_LIMITS, SnapshotError, collectImageReferences, createSnapshotStore } from '../lib/snapshot.js';

const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000001';
const nextId = (suffix = 1) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const image = (patch = {}) => ({ attachmentId: 'image-a', mediaType: 'image/png', bytes: 4, width: 2, height: 2, name: 'a.png', ...patch });
const archive = { title: 'Alpha', workspace: null, tags: [], note: '', wasArchived: true, origin: null, metadataUpdatedAt: null };
const tempRoots = new Set();
test.after(async () => Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true }))));
const fixture = async ({ events = [{ seq: 0, type: 'session/start', data: {} }], revisions = ['rev-1'], readImage, listSnapshots = true, uuid = () => SNAPSHOT_ID } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'dac-snapshot-'));
  tempRoots.add(root);
  const meta = { id: 'session-a', version: 1, cwd: '/project' };
  let revisionCall = 0;
  const persistence = {
    inspect: async (id) => {
      if (id !== 'session-a') throw new Error('missing');
      return { meta, events };
    },
  };
  if (listSnapshots) {
    persistence.listSnapshots = async () => [{ header: meta, revision: revisions[Math.min(revisionCall++, revisions.length - 1)] }];
  }
  const attachments = readImage === undefined ? null : { readImage };
  const store = createSnapshotStore({ root, persistence, attachments, uuid, now: () => new Date('2026-08-24T00:00:00.000Z') });
  return { root, meta, persistence, store, revisionCalls: () => revisionCall };
};

test('deduplicates identical image refs and rejects conflicting duplicates', () => {
  const ref = image();
  assert.deepEqual(collectImageReferences([{ data: { content: [{ type: 'image', attachment: ref }, { type: 'image', attachment: ref }] } }]), [ref]);
  assert.throws(() => collectImageReferences([{ data: { first: ref, second: { ...ref, width: 3 } } }]),
    (error) => error instanceof SnapshotError && error.code === 'snapshot-attachment-invalid');
});

test('collects a complete image reference when its optional display name is absent', () => {
  const { name: _name, ...unnamed } = image();
  assert.deepEqual(collectImageReferences([{ data: { image: unnamed } }]), [unnamed]);
});

test('captures and validates an image whose optional display name is absent', async () => {
  const { name: _name, ...unnamed } = image();
  const { store } = await fixture({
    events: [{ data: { image: unnamed } }],
    readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
  });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const checked = await store.validate(SNAPSHOT_ID);
  assert.equal(Object.hasOwn(checked.manifest.attachments[0], 'name'), false);
  assert.equal(Object.hasOwn(checked.record.attachments[0], 'name'), false);
});

test('ignores attachment-id lookalikes that are not complete image descriptors', () => {
  assert.deepEqual(collectImageReferences([{
    data: {
      toolResult: { attachmentId: 'business-record', status: 'ready' },
      image: image(),
    },
  }]), [image()]);
});

test('captures and validates one attachment-free snapshot atomically', async () => {
  const { root, store } = await fixture();
  const summary = await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  assert.equal(summary.snapshotId, SNAPSHOT_ID);
  assert.equal(summary.attachmentCount, 0);
  assert.equal((await store.validate(summary.snapshotId)).record.source.events[0].seq, 0);
  assert.deepEqual((await readdir(root)).sort(), [SNAPSHOT_ID, '.staging'].sort());
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, '.staging'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, SNAPSHOT_ID))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, SNAPSHOT_ID, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, SNAPSHOT_ID, 'session.json'))).mode & 0o777, 0o600);
});

test('atomic publication never replaces a pre-existing empty snapshot directory', async () => {
  const { root, store } = await fixture();
  await mkdir(join(root, SNAPSHOT_ID), { recursive: true });
  await assert.rejects(
    store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }),
    (error) => error.code === 'snapshot-conflict' && error.status === 409,
  );
  assert.deepEqual(await readdir(join(root, SNAPSHOT_ID)), []);
  assert.deepEqual(await readdir(join(root, '.staging')), []);
});

test('capture rejects a non-object archive descriptor before publication', async () => {
  const { root, store } = await fixture();
  await assert.rejects(
    store.capture({ sessionId: 'session-a', archive: null, liveDisposition: 'cold' }),
    (error) => error.code === 'snapshot-schema-invalid',
  );
  assert.deepEqual(await readdir(root), ['.staging']);
});

test('validation rejects a non-object archived descriptor', async () => {
  const { root, store } = await fixture();
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const manifestPath = join(root, SNAPSHOT_ID, 'manifest.json');
  const sessionPath = join(root, SNAPSHOT_ID, 'session.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const record = JSON.parse(await readFile(sessionPath, 'utf8'));
  record.archive = null;
  const data = Buffer.from(JSON.stringify(record));
  manifest.session.bytes = data.byteLength;
  manifest.session.sha256 = createHash('sha256').update(data).digest('hex');
  manifest.totalBytes = data.byteLength;
  await writeFile(sessionPath, data);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-schema-invalid');
});

test('reads attachments serially and retries until the source revision converges', async () => {
  const refs = [image(), image({ attachmentId: 'image-b', name: 'b.png' })];
  let active = 0;
  let maximum = 0;
  const { store, revisionCalls } = await fixture({
    events: [{ data: { refs } }],
    revisions: ['rev-1', 'rev-2', 'rev-2', 'rev-2'],
    readImage: async (ref) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return { ref, data: new Uint8Array([1, 2, 3, 4]) };
    },
  });
  const summary = await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  assert.equal(summary.attachmentCount, 2);
  assert.equal(maximum, 1);
  assert.equal(revisionCalls(), 4);
});

test('validates a published attachment-bearing snapshot against its saved descriptors', async () => {
  const { store } = await fixture({
    events: [{ data: { image: image() } }],
    readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
  });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const checked = await store.validate(SNAPSHOT_ID);
  assert.equal(checked.attachments.length, 1);
  assert.deepEqual(checked.attachments[0].descriptor.attachmentId, 'image-a');
  assert.equal(checked.attachments[0].descriptor.file, 'attachments/001-9f64a747e1b97f13.png');
  assert.equal((await stat(join(checked.attachments[0].path, '..'))).mode & 0o777, 0o700);
  assert.equal((await stat(checked.attachments[0].path)).mode & 0o777, 0o600);
});

test('rejects missing attachment capability, mismatched descriptors, missing source, and unstable sources', async () => {
  const events = [{ data: { image: image() } }];
  const noService = await fixture({ events });
  await assert.rejects(noService.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }), (error) => error.code === 'snapshot-unsupported' && error.status === 501);
  const mismatch = await fixture({ events, readImage: async () => ({ ref: image({ width: 3 }), data: new Uint8Array(4) }) });
  await assert.rejects(mismatch.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }), (error) => error.code === 'snapshot-attachment-invalid');
  const absent = await fixture();
  absent.persistence.listSnapshots = async () => [];
  await assert.rejects(absent.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }), (error) => error.code === 'snapshot-source-missing');
  const busy = await fixture({ events, revisions: ['a', 'b', 'c', 'd', 'e', 'f'], readImage: async (ref) => ({ ref, data: new Uint8Array(4) }) });
  await assert.rejects(busy.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }), (error) => error.code === 'snapshot-source-busy' && error.status === 409);
});

test('rejects a verified attachment result with missing bytes and cleans staging', async () => {
  const { root, store } = await fixture({
    events: [{ data: { image: image() } }],
    readImage: async (ref) => ({ ref }),
  });
  await assert.rejects(
    store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }),
    (error) => error.code === 'snapshot-attachment-invalid',
  );
  assert.deepEqual(await readdir(join(root, '.staging')), []);
});

test('rejects a source that disappears after attachment capture and cleans staging', async () => {
  const item = await fixture({
    events: [{ data: { image: image() } }],
    readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
  });
  let revisions = 0;
  item.persistence.listSnapshots = async () => (revisions++ === 0
    ? [{ header: item.meta, revision: 'rev-1' }]
    : []);
  await assert.rejects(
    item.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }),
    (error) => error.code === 'snapshot-source-missing' && error.status === 404,
  );
  assert.equal(revisions, 2);
  assert.deepEqual(await readdir(join(item.root, '.staging')), []);
});

test('rejects an empty persistence revision before publication', async () => {
  const { root, store } = await fixture({ revisions: [''] });
  await assert.rejects(
    store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }),
    (error) => error.code === 'snapshot-source-missing' && error.status === 404,
  );
  assert.deepEqual(await readdir(root), ['.staging']);
});

test('stops after exactly three unstable revision attempts and cleans every attempt', async () => {
  const item = await fixture({
    events: [{ data: { image: image() } }],
    revisions: ['a', 'b', 'c', 'd', 'e', 'f'],
    readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
  });
  await assert.rejects(
    item.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }),
    (error) => error.code === 'snapshot-source-busy' && error.status === 409,
  );
  assert.equal(item.revisionCalls(), SNAPSHOT_LIMITS.maxRevisionAttempts * 2);
  assert.deepEqual(await readdir(join(item.root, '.staging')), []);
});

test('captures cold and disposed sources without revision support using a null revision', async () => {
  for (const liveDisposition of ['cold', 'disposed']) {
    const { store } = await fixture({ listSnapshots: false });
    const saved = await store.capture({ sessionId: 'session-a', archive, liveDisposition });
    assert.equal((await store.validate(saved.snapshotId)).manifest.sourceRevision, null);
  }
});

test('requires stable source support for parked sessions and applies capture limits', async () => {
  const legacy = await fixture({ listSnapshots: false });
  await assert.rejects(legacy.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'parked' }), (error) => error.code === 'snapshot-unsupported');
  const tooMany = Array.from({ length: SNAPSHOT_LIMITS.maxAttachments + 1 }, (_, index) => image({ attachmentId: `image-${index}` }));
  const many = await fixture({ events: [{ data: { tooMany } }], readImage: async (ref) => ({ ref, data: new Uint8Array(4) }) });
  await assert.rejects(many.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }), (error) => error.code === 'snapshot-limit-exceeded');
  const bytes = await fixture({ events: [{ data: { image: image({ bytes: SNAPSHOT_LIMITS.maxAttachmentBytes + 1 }) } }], readImage: async (ref) => ({ ref, data: new Uint8Array(ref.bytes) }) });
  await assert.rejects(bytes.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }), (error) => error.code === 'snapshot-limit-exceeded');
});

test('rejects a declared total above the snapshot limit before reading attachment bytes', async () => {
  const count = Math.floor(SNAPSHOT_LIMITS.maxTotalBytes / SNAPSHOT_LIMITS.maxAttachmentBytes) + 1;
  const refs = Array.from({ length: count }, (_, index) => image({
    attachmentId: `image-${index}`,
    bytes: SNAPSHOT_LIMITS.maxAttachmentBytes,
  }));
  let reads = 0;
  const { store } = await fixture({
    events: [{ data: { refs } }],
    readImage: async () => {
      reads += 1;
      return { ref: refs[0], data: new Uint8Array() };
    },
  });
  await assert.rejects(
    store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' }),
    (error) => error.code === 'snapshot-limit-exceeded' && error.status === 413,
  );
  assert.equal(reads, 0);
});

test('rejects corrupted bytes and unsafe manifest paths during validation', async () => {
  const { root, store } = await fixture({ events: [{ data: { image: image() } }], readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }) });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const manifestPath = join(root, SNAPSHOT_ID, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(join(root, SNAPSHOT_ID, manifest.session.file), '{bad');
  await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-hash-mismatch');
  const session = JSON.stringify({ format: 'dsh-archived-chats/snapshot-session', version: 1, archive, source: { meta: { id: 'session-a' }, events: [] }, attachments: [] });
  const sessionBytes = Buffer.from(session);
  manifest.session.bytes = sessionBytes.byteLength;
  manifest.session.sha256 = createHash('sha256').update(sessionBytes).digest('hex');
  manifest.session.file = '../outside.json';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-path-unsafe');
});

test('validation requires canonical timestamps and non-empty source revisions', async () => {
  const { root, store } = await fixture();
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const manifestPath = join(root, SNAPSHOT_ID, 'manifest.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const mutate of [
    (manifest) => { manifest.createdAt = '2026-08-24'; },
    (manifest) => { manifest.sourceRevision = ''; },
  ]) {
    const manifest = structuredClone(original);
    mutate(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-schema-invalid');
  }
});

test('validation enforces the manifest byte cap before UTF-8 or JSON parsing', async () => {
  const { root, store } = await fixture();
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  await truncate(join(root, SNAPSHOT_ID, 'manifest.json'), SNAPSHOT_LIMITS.maxManifestBytes + 1);
  await assert.rejects(
    store.validate(SNAPSHOT_ID),
    (error) => error.code === 'snapshot-limit-exceeded' && error.status === 413,
  );
});

test('validation reports invalid manifest and session JSON with specific errors', async () => {
  const manifestItem = await fixture();
  await manifestItem.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  await writeFile(join(manifestItem.root, SNAPSHOT_ID, 'manifest.json'), '{');
  await assert.rejects(manifestItem.store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-json-invalid');

  const sessionItem = await fixture();
  await sessionItem.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const manifestPath = join(sessionItem.root, SNAPSHOT_ID, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const invalidJson = Buffer.from('{');
  manifest.session.bytes = invalidJson.byteLength;
  manifest.session.sha256 = createHash('sha256').update(invalidJson).digest('hex');
  manifest.totalBytes = invalidJson.byteLength;
  await writeFile(join(sessionItem.root, SNAPSHOT_ID, 'session.json'), invalidJson);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(sessionItem.store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-json-invalid');
});

test('validation detects corrupted attachment bytes before returning a restore payload', async () => {
  const { root, store } = await fixture({
    events: [{ data: { image: image() } }],
    readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
  });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const manifest = JSON.parse(await readFile(join(root, SNAPSHOT_ID, 'manifest.json'), 'utf8'));
  await writeFile(join(root, SNAPSHOT_ID, manifest.attachments[0].file), new Uint8Array([4, 3, 2, 1]));
  await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-hash-mismatch');
});

test('validation rejects duplicate attachment paths before reading attachment bytes', async () => {
  const refs = [image(), image({ attachmentId: 'image-b', name: 'b.png' })];
  const { root, store } = await fixture({
    events: [{ data: { refs } }],
    readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
  });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const manifestPath = join(root, SNAPSHOT_ID, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.attachments[1].file = manifest.attachments[0].file;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-schema-invalid');
});

test('validation rejects declared limits, duplicate paths, unsafe keys, and invalid UTF-8 before any writer can use them', async () => {
  const { root, store } = await fixture({ events: [{ data: { image: image() } }], readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }) });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const manifestPath = join(root, SNAPSHOT_ID, 'manifest.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cases = [
    ['session', (manifest) => { manifest.session.bytes = SNAPSHOT_LIMITS.maxSessionBytes + 1; }],
    ['attachment', (manifest) => { manifest.attachments[0].bytes = SNAPSHOT_LIMITS.maxAttachmentBytes + 1; }],
    ['total', (manifest) => { manifest.totalBytes = SNAPSHOT_LIMITS.maxTotalBytes + 1; }],
  ];
  for (const [, mutate] of cases) {
    const manifest = structuredClone(original);
    mutate(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-limit-exceeded');
  }
  const duplicate = structuredClone(original);
  duplicate.attachments[0].file = 'session.json';
  await writeFile(manifestPath, JSON.stringify(duplicate));
  await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-path-unsafe');
  await writeFile(join(root, SNAPSHOT_ID, 'session.json'), new Uint8Array([0xc3]));
  const invalidUtf8 = structuredClone(original);
  invalidUtf8.session.bytes = 1;
  invalidUtf8.session.sha256 = createHash('sha256').update(new Uint8Array([0xc3])).digest('hex');
  await writeFile(manifestPath, JSON.stringify(invalidUtf8));
  await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-utf8-invalid');
  await writeFile(manifestPath, '{"format":"dsh-archived-chats/snapshot","version":1,"__proto__":{}}');
  await assert.rejects(store.validate(SNAPSHOT_ID), (error) => error.code === 'snapshot-schema-invalid');
});

test('recovery removes stale staging, preserves valid orphans, selects deterministic latest, and exact deletion is isolated', async () => {
  const ids = [nextId(1), nextId(2), nextId(3)];
  let position = 0;
  const { root, store } = await fixture({ uuid: () => ids[position++] });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  const another = await fixture({ uuid: () => ids[position++] });
  another.root = root;
  const second = createSnapshotStore({ root, persistence: another.persistence, attachments: null, uuid: () => ids[1], now: () => new Date('2026-08-24T00:00:00.000Z') });
  await second.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  await writeFile(join(root, '.staging', 'stale'), 'stale');
  await mkdir(join(root, ids[2]));
  await writeFile(join(root, ids[2], 'manifest.json'), '{broken');
  const recovered = await store.recover();
  assert.equal(recovered.valid.length, 2);
  assert.deepEqual(recovered.degraded, [{ snapshotId: ids[2], code: 'snapshot-json-invalid' }]);
  assert.equal(recovered.latestBySession.get('session-a').snapshotId, ids[1]);
  assert.equal((await readdir(join(root, '.staging'))).length, 0);
  assert.equal((await readdir(root)).includes(ids[0]), true);
  assert.equal((await readdir(root)).includes(ids[1]), true);
  await store.remove(ids[0]);
  assert.deepEqual(await store.latestFor('session-a'), { snapshotId: ids[1], sessionId: 'session-a', createdAt: '2026-08-24T00:00:00.000Z' });
  await assert.rejects(store.remove('../outside'), (error) => error.code === 'snapshot-id-invalid');
  await store.removeForSession('other-session');
  assert.equal((await readdir(root)).includes(ids[1]), true);
  await store.removeForSession('session-a');
  assert.equal((await readdir(root)).includes(ids[1]), false);
  assert.equal((await readdir(root)).includes(ids[2]), true);
});
