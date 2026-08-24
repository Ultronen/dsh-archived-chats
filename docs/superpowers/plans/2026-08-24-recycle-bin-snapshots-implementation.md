# Recycle Bin and Automatic Protection Snapshots 0.11.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ordinary permanent deletion with a recoverable recycle-bin lifecycle backed by verified automatic session-and-attachment snapshots, original-record undo, snapshot fallback restoration, and explicit crash-safe permanent purge.

**Architecture:** Add three focused Host modules: `trash.js` for the atomic recycle catalog, `snapshot.js` for versioned protection snapshots, and `recycle.js` for lifecycle transactions. `lib/index.js` composes them with the existing Harness persistence, attachment, workspace, live-session, metadata, cache, and HTTP seams; `lib/client.js` adds Archived/Recycle Bin views and guarded actions without direct filesystem access.

**Tech Stack:** Node.js ESM, built-in `node:fs/promises`, `node:path`, `node:crypto`, Cordis/DeepSeek Harness Host services, React 18 browser module-loader bundle, Node test runner, existing mocked Host/client smoke harness.

**Spec:** `docs/superpowers/specs/2026-08-24-recycle-bin-snapshots-design.md`

## Global Constraints

- Ordinary archive-page delete moves to trash and never removes the original persistence artifact.
- Permanent purge exists only for a committed trash record and persists `purge-pending` before physical deletion.
- Session batches are sequential; attachment bytes are read and written one at a time.
- Keep at most one active protection snapshot per session; publish a replacement before removing the old active snapshot.
- Internal formats are `dsh-archived-chats/snapshot` v1 and `dsh-archived-chats/snapshot-session` v1; import routes never accept them.
- Limits are exact: 4 MiB manifest, 512 MiB session JSON, 10,000 attachments, 32 MiB per attachment, 8 GiB total.
- Paths use generated UUIDs and digest filenames. User-controlled IDs, titles, paths, and names never become path segments.
- Snapshot files use `0600`, directories use `0700`, and publication is temp-write, sync, atomic rename.
- Unreadable `trash.json` is preserved byte-for-byte, hides nothing, and disables recycle mutations.
- `pending-deletions.json` is strict migration input only. 0.11 never adds pending IDs or boot-deletes them without new purge confirmation.
- Restore never overwrites an existing session ID and uses public `create`/`append` plus `saveImage` only.
- Attachment republish must return the same verified attachment ID and descriptor before session creation.
- Errors/logs contain IDs and stable codes only, never user content or filesystem/workspace paths.
- Preserve all 0.10 archive/search/preview/metadata/stats/export/import/unarchive/theme/locale/responsive/accessibility behavior outside changed delete semantics.
- Add no runtime dependency; use Node built-ins.
- Full real-host target is Harness `0.1.1-rc.2`; older hosts degrade through explicit capability errors.
- Every production change follows RED → minimal GREEN → focused/full verification → commit.
- Prefix every shell command with `rtk`.

---

## File Map

- Create `lib/trash.js` and `test/trash.test.mjs` for the versioned catalog, transitions, summaries, and strict legacy reader.
- Create `lib/snapshot.js` and `test/snapshot.test.mjs` for capture, hashes, attachments, publication, validation, recovery, and cleanup.
- Create `lib/recycle.js` and `test/recycle.test.mjs` for move, undo, fallback restore, purge, empty, recovery, and migration.
- Modify `lib/index.js` and `test/smoke.test.mjs` for Host composition, 17 routes, visibility, preview scopes, caches, and races.
- Modify `lib/client.js` and `test/smoke.test.mjs` for tabs, trash rows, immediate undo, restore/purge/empty, dialogs, localization, and responsive behavior.
- Modify `lib/types/index.d.ts`, `lib/types/client/index.d.ts`, package metadata, READMEs, and architecture guides for public/release contracts.
- Create `assets/screenshots/9-recycle-bin.png` only after the real-host release matrix passes.

---

### Task 1: Versioned Recycle Catalog and Strict Legacy Reader

**Files:**
- Create: `lib/trash.js`
- Create: `test/trash.test.mjs`
- Modify: `package.json:files`

**Interfaces:**
- Consumes: Node filesystem promises and exact record fields/states from the spec.
- Produces: `TRASH_VERSION`, `TrashStoreError`, `normalizeTrashRecord`, `readLegacyPending`, `createTrashStore`, and `selectTrashIds`.

- [ ] **Step 1: Write failing normalization and selection tests**

Create `test/trash.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrashStoreError, createTrashStore, normalizeTrashRecord, readLegacyPending, selectTrashIds } from '../lib/trash.js';

const readyRecord = (id = 'session-a') => ({
  sessionId: id,
  state: 'trashed',
  trashedAt: '2026-08-24T00:00:00.000Z',
  purgeRequestedAt: null,
  title: 'Alpha',
  createdAt: 10,
  origin: null,
  workspace: { id: 'ws-1', title: 'Project', path: '/project' },
  wasArchived: true,
  tags: ['important'],
  note: 'keep context',
  metadataUpdatedAt: '2026-08-24T00:00:00.000Z',
  snapshotId: '00000000-0000-4000-8000-000000000001',
  snapshotBytes: 123,
  snapshotAttachmentCount: 1,
  liveDisposition: 'cold',
});

test('normalizes an exact record and rejects unsupported states', () => {
  assert.deepEqual(normalizeTrashRecord(readyRecord(), 'session-a'), readyRecord());
  assert.throws(() => normalizeTrashRecord({ ...readyRecord(), state: 'deleted' }, 'session-a'),
    (error) => error instanceof TrashStoreError && error.code === 'trash-store-unavailable');
});

test('selection preserves first request order and filters states', () => {
  const records = new Map([
    ['a', readyRecord('a')],
    ['b', { ...readyRecord('b'), state: 'purge-pending', purgeRequestedAt: '2026-08-24T01:00:00.000Z' }],
  ]);
  assert.deepEqual(selectTrashIds(records, ['b', 'a', 'a'], ['trashed']), {
    selected: ['a'],
    rejected: [{ id: 'b', reason: 'trash-state-conflict' }],
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `rtk node --test test/trash.test.mjs`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/trash.js`.

- [ ] **Step 3: Implement validation and selection**

Create `lib/trash.js` with these exact public primitives:

```js
export const TRASH_VERSION = 1;
const STATES = new Set(['trashed', 'purge-pending', 'degraded']);
const DISPOSITIONS = new Set(['cold', 'disposed', 'parked']);

export class TrashStoreError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'TrashStoreError';
    this.code = code;
    this.status = status;
  }
}

export function selectTrashIds(records, requestedIds, allowedStates) {
  const allowed = allowedStates === undefined ? null : new Set(allowedStates);
  const selected = [];
  const rejected = [];
  const seen = new Set();
  for (const id of Array.isArray(requestedIds) ? requestedIds : []) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    const record = records.get(id);
    if (record === undefined) rejected.push({ id, reason: 'trash-record-missing' });
    else if (allowed !== null && !allowed.has(record.state)) rejected.push({ id, reason: 'trash-state-conflict' });
    else selected.push(id);
  }
  return { selected, rejected };
}
```

`normalizeTrashRecord` must validate every field literally, clone arrays and
nested workspace data, require matching map key/session ID, require a UUID
snapshot for `trashed/purge-pending`, and allow string or null only for
`degraded`.

- [ ] **Step 4: Run normalization tests and verify GREEN**

Run `rtk node --test test/trash.test.mjs`; expect both tests to pass.

- [ ] **Step 5: Add failing store lifecycle/corruption tests**

```js
test('serializes concurrent writes and enforces transitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-trash-'));
  const store = createTrashStore({ path: join(root, 'trash.json') });
  await Promise.all([store.put(readyRecord('a')), store.put(readyRecord('b'))]);
  assert.deepEqual((await store.list()).map((record) => record.sessionId).sort(), ['a', 'b']);
  await store.transition('a', 'purge-pending', { purgeRequestedAt: '2026-08-24T02:00:00.000Z' });
  await assert.rejects(store.transition('a', 'trashed'), (error) => error.code === 'trash-state-conflict');
});

test('preserves malformed bytes and rejects mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-trash-corrupt-'));
  const path = join(root, 'trash.json');
  await writeFile(path, '{broken', 'utf8');
  const store = createTrashStore({ path });
  assert.equal((await store.load()).status, 'unavailable');
  await assert.rejects(store.put(readyRecord()), (error) => error.code === 'trash-store-unavailable');
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
```

Also cover missing file, unsupported version, invalid record field, degraded to
purge-pending, forbidden purge-pending restore, idempotent remove, summary
counts, and deterministic concurrent updates.

- [ ] **Step 6: Run lifecycle tests and verify RED**

Run `rtk node --test test/trash.test.mjs`; expect missing store methods.

- [ ] **Step 7: Implement atomic serialized storage**

`createTrashStore({ path, now? })` returns `{ load, list, get, put, transition,
remove, summary }`. Each mutation loads inside one promise queue, rejects
unavailable state, clones the map, applies one allowed transition, writes
`<path>.<pid>.<counter>.tmp` with mode `0600`, and renames it over the document.
Allowed transitions:

```text
missing -> trashed
trashed -> purge-pending
degraded -> purge-pending
trashed -> removed
degraded -> removed
purge-pending -> removed
```

- [ ] **Step 8: Add strict legacy parsing RED/GREEN**

```js
test('legacy pending accepts only the exact ids array shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-pending-'));
  const path = join(root, 'pending-deletions.json');
  await writeFile(path, '{"ids":["a","a","b"]}\n', 'utf8');
  assert.deepEqual(await readLegacyPending(path), { status: 'ready', ids: ['a', 'b'] });
  await writeFile(path, '{"version":1,"ids":["a"]}\n', 'utf8');
  assert.equal((await readLegacyPending(path)).status, 'unavailable');
});
```

Observe RED, then implement missing as ready-empty and reject parse errors,
extra keys, non-array, empty/non-string IDs without writing.

- [ ] **Step 9: Verify and commit Task 1**

```sh
rtk node --test test/trash.test.mjs
rtk npm test
rtk git diff --check
rtk git add lib/trash.js test/trash.test.mjs package.json
rtk git commit -m "feat: add recycle catalog store"
```

---

### Task 2: Verified Automatic Snapshot Store

**Files:**
- Create: `lib/snapshot.js`
- Create: `test/snapshot.test.mjs`
- Modify: `package.json:files`

**Interfaces:**
- Consumes: persistence `inspect/listSnapshots`, attachment `readImage`, archive descriptor, plugin metadata.
- Produces: `SNAPSHOT_LIMITS`, `SnapshotError`, `collectImageReferences`, and `createSnapshotStore({ root, persistence, attachments, now?, uuid? })` with `capture`, `validate`, `latestFor`, `recover`, `removeForSession`.

- [ ] **Step 1: Write failing reference and base capture tests**

```js
test('deduplicates identical image refs and rejects conflicting duplicates', () => {
  const ref = { attachmentId: 'image-a', mediaType: 'image/png', bytes: 4, width: 2, height: 2, name: 'a.png' };
  assert.deepEqual(collectImageReferences([{ data: { content: [{ type: 'image', attachment: ref }, { type: 'image', attachment: ref }] } }]), [ref]);
  assert.throws(() => collectImageReferences([{ data: { first: ref, second: { ...ref, width: 3 } } }]),
    (error) => error.code === 'snapshot-attachment-invalid');
});

test('captures and validates one attachment-free snapshot atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-snapshot-'));
  const meta = { id: 'session-a', version: 1, cwd: '/project' };
  const persistence = {
    listSnapshots: async () => [{ header: meta, revision: 'rev-1' }],
    inspect: async () => ({ meta, events: [{ seq: 0, type: 'session/start', data: {} }] }),
  };
  const store = createSnapshotStore({ root, persistence, attachments: null, uuid: () => '00000000-0000-4000-8000-000000000001', now: () => new Date('2026-08-24T00:00:00.000Z') });
  const summary = await store.capture({ sessionId: 'session-a', archive: { title: 'Alpha', workspace: null, tags: [], note: '' }, liveDisposition: 'cold' });
  assert.equal(summary.snapshotId, '00000000-0000-4000-8000-000000000001');
  assert.equal((await store.validate(summary.snapshotId)).record.source.events[0].seq, 0);
});
```

- [ ] **Step 2: Run and verify RED**

Run `rtk node --test test/snapshot.test.mjs`; expect missing `lib/snapshot.js`.

- [ ] **Step 3: Implement constants, errors, reference collection, and base capture**

```js
export const SNAPSHOT_LIMITS = Object.freeze({
  maxManifestBytes: 4 * 1024 * 1024,
  maxSessionBytes: 512 * 1024 * 1024,
  maxAttachments: 10000,
  maxAttachmentBytes: 32 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxRevisionAttempts: 3,
});

export class SnapshotError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.status = status;
  }
}
```

Recursively collect complete image descriptors, encode
`dsh-archived-chats/snapshot-session` v1, hash exact bytes, write below
`.staging/<uuid>`, sync, and atomically rename to `<root>/<uuid>`. Clean staging
on every error.

- [ ] **Step 4: Run base tests and verify GREEN**

Run `rtk node --test test/snapshot.test.mjs`.

- [ ] **Step 5: Add failing attachment/stability tests**

Use deferred attachment reads to assert max concurrency one. Feed revisions
`rev-1, rev-2, rev-2, rev-2` and assert two attempts/four revision reads. Also
test missing attachment service, descriptor mismatch, missing bytes, every
limit, three unstable attempts, and source disappearance.

- [ ] **Step 6: Implement attachment capture and revision convergence**

For each attempt execute:

```text
revision before -> inspect -> collect refs -> sequential verified reads/writes
-> revision after -> publish only when equal
```

Remove failed staging before retry. After three changes throw
`snapshot-source-busy` 409. Without `listSnapshots`, allow only `cold` or
`disposed`, write `sourceRevision: null`, and reject `parked` with
`snapshot-unsupported` 501. Filenames are ordered index plus first 16 digest
hex characters and a media-type extension.

- [ ] **Step 7: Add failing validation/recovery/replacement tests**

Mutate manifest/session/attachment files and assert `snapshot-hash-mismatch` or
specific schema/path/limit errors. Cover unsafe paths, prototype keys,
duplicate paths, invalid UTF-8/JSON, stale staging cleanup, two complete
orphans, deterministic latest selection, and new-before-old replacement.

- [ ] **Step 8: Implement validation, recovery, and cleanup**

`validate(snapshotId)` enforces manifest cap first, canonical-root containment,
then hashes session and attachments sequentially. It returns:

```js
{ manifest, record, attachments: [{ descriptor, path, data }] }
```

`recover()` removes staging children, preserves complete orphans, and returns
`{ valid, degraded, latestBySession }`. `removeForSession` removes only
directories whose validated manifest names the exact session ID.

- [ ] **Step 9: Verify and commit Task 2**

```sh
rtk node --test test/snapshot.test.mjs
rtk npm test
rtk git diff --check
rtk git add lib/snapshot.js test/snapshot.test.mjs package.json
rtk git commit -m "feat: add verified protection snapshots"
```

---

### Task 3: Move-to-Trash and Original-Record Undo

**Files:**
- Create: `lib/recycle.js`
- Create: `test/recycle.test.mjs`
- Modify: `package.json:files`

**Interfaces:**
- Consumes: Tasks 1–2 stores, registry, persistence, metadata, lifecycle queue, injected live disposer and cache invalidator.
- Produces: `RecycleError` and `createRecycleService(options)` with `move`, `restore`, `list`, `summary`.

- [ ] **Step 1: Write failing cold move and original undo tests**

In `test/recycle.test.mjs`, define `trashRecord(id, state = 'trashed')`
with the same complete literal fields as Task 1 and a `recycleFixture(options)`
that returns `{ service, persistence, attachments, workspace, registry,
metadata, trashStore, snapshotStore, calls, purgedIds, pendingPath }`. Its fake
persistence owns `ids`, `created`, `appended`, and `writeCalls`; fake stores use
real Maps and record every mutating call before applying it. Construct
`service` through the real `createRecycleService`, never a service mock.

```js
test('cold move snapshots before catalog commit and keeps authoritative state', async () => {
  const calls = [];
  const fixture = recycleFixture({ calls });
  assert.deepEqual(await fixture.service.move(['session-a']), { trashed: ['session-a'], failed: [] });
  assert.deepEqual(calls.slice(0, 3), ['snapshot:capture:session-a', 'trash:put:session-a', 'cache:invalidate:session-a']);
  assert.equal(fixture.persistence.ids.has('session-a'), true);
  assert.equal(fixture.workspace.sessionIds.has('session-a'), true);
  assert.equal(fixture.registry.archivedSessionIds.includes('session-a'), true);
});

test('intact-original undo removes only marker and writes no persistence', async () => {
  const fixture = recycleFixture({ trashed: true });
  assert.deepEqual(await fixture.service.restore(['session-a']), { restored: ['session-a'], failed: [], warnings: [] });
  assert.equal(fixture.persistence.writeCalls, 0);
  assert.equal(await fixture.trashStore.get('session-a'), undefined);
  assert.notEqual(await fixture.snapshotStore.latestFor('session-a'), null);
});
```

- [ ] **Step 2: Run and verify RED**

Run `rtk node --test test/recycle.test.mjs`; expect missing `lib/recycle.js`.

- [ ] **Step 3: Implement exact service boundary and descriptor load**

```js
export function createRecycleService({
  registry, persistence, attachments, metadataStore,
  trashStore, snapshotStore, lifecycle,
  disposeLive, purgePhysical, invalidate, logger,
  now = () => new Date(),
}) {
  return Object.freeze({ move, restore, list, summary });
}
```

Freshly read persistence headers, archive IDs, workspaces, and metadata for each
ID. Never trust a client row. Record the exact descriptor in capture input and
trash record.

- [ ] **Step 4: Implement minimal cold move and verify GREEN**

Inside `lifecycle.run`: reject unknown/unarchived/already-trash/purge IDs, call
snapshot capture, trash put, then cache invalidation. Do not mutate persistence,
workspace, archive state, or metadata. Process unique IDs sequentially and
return ordered partial results.

- [ ] **Step 5: Add failing live/failure/race tests**

Cover disposer `disposed`, disposer `parked` with revisions, parked without
revisions, snapshot failure after parking, move vs unarchive deterministic
winner, duplicate IDs once, and safe diagnostics. Use deferred promises, never
timed sleeps.

- [ ] **Step 6: Implement live disposition and rechecks**

`disposeLive(id)` returns `{ disposition: 'cold'|'disposed'|'parked' }`.
Recheck archive/trash state after disposal and immediately before catalog
commit. If unarchive won, remove only the newly published non-active snapshot
and return `operation-cancelled`.

- [ ] **Step 7: Implement original-record restore**

For `trashed/degraded`, validate current persistence identity. If intact,
remove the trash marker, preserve archive/workspace, fill only missing metadata,
invalidate caches, and retain the snapshot. Reject `purge-pending` 409.

- [ ] **Step 8: Verify and commit Task 3**

```sh
rtk node --test test/recycle.test.mjs
rtk npm test
rtk git diff --check
rtk git add lib/recycle.js test/recycle.test.mjs package.json
rtk git commit -m "feat: add recoverable trash transactions"
```

### Task 4: Snapshot Fallback Restoration with Attachments

**Files:**
- Modify: `lib/recycle.js`
- Modify: `test/recycle.test.mjs`

**Interfaces:**
- Consumes: `snapshotStore.validate`, `attachments.saveImage`, persistence `create/append/locate`, workspace/metadata/registry writers.
- Produces: fallback branch of `service.restore(ids)` and idempotent internal rollback.

- [ ] **Step 1: Write failing exact fallback restore test**

```js
test('restores a missing original from snapshot without changing identity', async () => {
  const fixture = recycleFixture({ trashed: true, originalMissing: true, withAttachment: true });
  const result = await fixture.service.restore(['session-a']);
  assert.deepEqual(result.restored, ['session-a']);
  assert.deepEqual(fixture.persistence.created, [{ id: 'session-a', version: 1, cwd: '/project' }]);
  assert.deepEqual(fixture.persistence.appended.flat().map((event) => event.seq), [0, 1, 2]);
  assert.equal(fixture.attachments.saved[0].mediaType, 'image/png');
  assert.equal(fixture.workspace.sessionIds.has('session-a'), true);
  assert.deepEqual(fixture.metadata.get('session-a'), { tags: ['important'], note: 'keep context' });
  assert.equal(fixture.registry.archivedSessionIds.includes('session-a'), true);
});
```

- [ ] **Step 2: Run focused test and verify RED**

Run `rtk node --test test/recycle.test.mjs`.

Expected: restore reports `snapshot-restore-unsupported` or performs no write.

- [ ] **Step 3: Implement complete preflight and attachment republish**

Before any session write: validate the snapshot, refresh persistence IDs,
reject conflicts, require `create/append` and rollback-capable `locate`, require
`saveImage` only when attachments exist, then republish attachments sequentially.
Require returned descriptors to equal manifest descriptors. Never rewrite event
references; a different attachment ID aborts before `persistence.create`.

- [ ] **Step 4: Implement exact commit order**

```text
attachments -> persistence.create -> append batches <=500
-> workspace attach -> metadata set -> archive registry set -> trash remove
```

Snapshot original workspace/metadata/archive state before writes. Preserve event
order and never mutate snapshot event objects.

- [ ] **Step 5: Add failing conflict and rollback matrix**

Table-drive failures at attachment 2, create, append batch 1, append batch 2,
workspace attach, metadata set, registry set, and trash remove. For every row,
assert the trash record remains, no final persistence ID remains, original
registry/workspace/metadata returns, and logs expose stable codes only. Add ID
race and unsupported-backend cases.

- [ ] **Step 6: Implement idempotent rollback and verify GREEN**

Reverse registry, metadata, and workspace mutations, then remove only the newly
created artifact after validating `dirname(locate(meta).path)` against its exact
session identity. Aggregate rollback failures as
`snapshot-restore-rollback-failed`. Calling rollback twice must be harmless.

- [ ] **Step 7: Verify and commit Task 4**

```sh
rtk node --test test/recycle.test.mjs
rtk npm test
rtk git diff --check
rtk git add lib/recycle.js test/recycle.test.mjs
rtk git commit -m "feat: restore recycled sessions from snapshots"
```

---

### Task 5: Permanent Purge, Startup Recovery, and 0.10 Migration

**Files:**
- Modify: `lib/recycle.js`
- Modify: `lib/trash.js`
- Modify: `lib/snapshot.js`
- Modify: `test/recycle.test.mjs`
- Modify: `test/trash.test.mjs`
- Modify: `test/snapshot.test.mjs`

**Interfaces:**
- Consumes: injected `purgePhysical`, strict legacy reader/writer, trash transitions, snapshot recovery/cleanup.
- Produces: `service.purge`, `service.empty`, `service.recoverStartup`.

- [ ] **Step 1: Write failing purge ordering and boot tests**

```js
test('records purge intent before physical deletion and removes trash last', async () => {
  const calls = [];
  const fixture = recycleFixture({ trashed: true, calls });
  assert.deepEqual(await fixture.service.purge(['session-a']), { purged: ['session-a'], failed: [] });
  assert.deepEqual(calls, [
    'trash:transition:session-a:purge-pending',
    'physical:purge:session-a',
    'snapshot:remove:session-a',
    'trash:remove:session-a',
    'cache:invalidate:session-a',
  ]);
});

test('startup retries purge-pending but never deletes plain trash', async () => {
  const fixture = recycleFixture({ records: [trashRecord('a'), trashRecord('b', 'purge-pending')] });
  await fixture.service.recoverStartup({ legacyPendingPath: fixture.pendingPath });
  assert.deepEqual(fixture.purgedIds, ['b']);
  assert.notEqual(await fixture.trashStore.get('a'), undefined);
});
```

- [ ] **Step 2: Run and verify RED**

Run `rtk node --test test/recycle.test.mjs`.

- [ ] **Step 3: Implement purge and empty**

Allow `trashed/degraded -> purge-pending`, reject other sources, persist
`purgeRequestedAt` before `purgePhysical`, then remove every validated snapshot
for the session, then remove trash last. Retain purge-pending on any failure.
`empty()` snapshots current trashed/degraded IDs and processes sequentially with
ordered partial results. Extend the service return boundary to
`Object.freeze({ move, restore, purge, empty, recoverStartup, list, summary })`.

- [ ] **Step 4: Add failing startup snapshot reconciliation tests**

Cover stale staging, valid orphan preservation, deterministic latest selection,
missing/invalid referenced snapshot becoming degraded, both original and
snapshot missing, and purge-pending resumption after each injected crash stage.

- [ ] **Step 5: Implement startup recovery**

Call `snapshotStore.recover()` first. If trash state is unavailable, perform no
migration or purge. Reconcile each record against snapshot/original availability,
mark degraded without destroying expected snapshot identity, then retry only
purge-pending records.

- [ ] **Step 6: Write failing legacy migration tests**

Prove: valid archived pending ID becomes trash only after snapshot; unarchived
ID removes only its marker; snapshot failure retains marker/files; malformed
legacy bytes cause zero writes/deletes; migration never invokes physical purge;
empty migrated file remains exactly `{ "ids": [] }` plus newline.

- [ ] **Step 7: Implement non-destructive migration**

Read exact legacy shape. For each ID sequentially, refresh archive/persistence,
snapshot and write a trash record, then atomically remove only that ID from the
legacy file. Use a separate serialized writer with no version field and preserve
malformed bytes.

- [ ] **Step 8: Verify and commit Task 5**

```sh
rtk node --test test/trash.test.mjs test/snapshot.test.mjs test/recycle.test.mjs
rtk npm test
rtk git diff --check
rtk git add lib/trash.js lib/snapshot.js lib/recycle.js test/trash.test.mjs test/snapshot.test.mjs test/recycle.test.mjs
rtk git commit -m "feat: add crash-safe recycle purge and migration"
```

---

### Task 6: Host Composition, Routes, Visibility, and Preview Scopes

**Files:**
- Modify: `lib/index.js`
- Modify: `test/smoke.test.mjs`
- Modify: `lib/types/index.d.ts`

**Interfaces:**
- Consumes: Tasks 1–5, existing lifecycle queue/disposer/physical delete, metadata/stats/search/preview caches.
- Produces: four trash routes, changed delete semantics, `trashStatus`, scoped authorization, startup recovery wiring.

- [ ] **Step 1: Add failing route/guard/body assertions**

Change route count from 13 to 17 and assert:

```js
for (const path of ['trash', 'trash/restore', 'trash/purge', 'trash/empty']) {
  assert(routes.has(`/plugins/dsh-archived-chats/${path}`), `route /${path} registered`);
}
```

Add GET-on-mutation 405, missing guard 403, malformed/empty IDs 400, more than
2,000 IDs 400, and oversized body 413.

- [ ] **Step 2: Run smoke and verify RED**

Run `rtk node --test test/smoke.test.mjs`; expect count/registration failures.

- [ ] **Step 3: Compose stores/service and refactor physical delete callback**

Resolve paths below `$DSH_HOME/plugin-data/archived-chats`, instantiate stores,
and construct recycle service after Host dependencies bind. Refactor current
physical branch into
`purgePhysicalSession(ctx, registry, persistence, id, titleCache, statsService,
metadataStore, lifecycle, { lockHeld = false, livePrepared = false } = {})`
without changing existing path confirmation, live disposal,
workspace/registry/metadata/cache behavior.
Expose `disposeLive(id)` returning exact disposition vocabulary.

- [ ] **Step 4: Register changed and new routes**

```text
/delete -> recycle.move([sessionId])
/delete-all -> recycle.move(sessionIds)
/trash -> recycle.list + summary
/trash/restore -> recycle.restore
/trash/purge -> recycle.purge
/trash/empty -> recycle.empty
```

Responses use `trashed/restored/purged/failed`, preserve request order and
partial success, and omit misleading legacy `deleted/pending` success fields.

- [ ] **Step 5: Add failing visibility and original-undo integration tests**

Move through the real route and prove `/state`, `/stats`, archive search/preview,
and export exclude it; `/trash` includes it; archive ID, physical directory,
workspace and metadata remain; trash preview works; cross-scope preview/image
fails; original undo returns it without persistence write.

- [ ] **Step 6: Implement visibility and scoped preview authorization**

Load trash state per request. Unavailable store filters nothing and reports
`trashStatus: unavailable`. Ordinary scope excludes every recycle record; trash
scope requires one. Add optional validated `scope` to preview/image and recheck
after async reads immediately before response.

- [ ] **Step 7: Replace old boot sweep with recovery/migration**

Remove activation-time physical sweep. Call
`recycle.recoverStartup({ legacyPendingPath })`. Assert an old pending live ID
becomes trash and its directory survives.

- [ ] **Step 8: Add races and cache invalidation tests**

Use deferred calls for move vs unarchive, restore vs purge, preview vs purge,
and simultaneous moves. Assert deterministic winner and cache invalidation only
after committed move/restore/purge.

- [ ] **Step 9: Update Host types, verify, and commit**

Document 17 routes, stores, recoverable delete, preview scopes, fallback
capability errors, and attachment-GC limitation.

```sh
rtk node --test test/smoke.test.mjs
rtk npm test
rtk node --check lib/index.js
rtk git diff --check
rtk git add lib/index.js lib/types/index.d.ts test/smoke.test.mjs
rtk git commit -m "feat: expose recycle bin host lifecycle"
```

### Task 7: Client Data Model, Guarded APIs, and Archived/Recycle Tabs

**Files:**
- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`
- Modify: `lib/types/client/index.d.ts`

**Interfaces:**
- Consumes: Task 6 routes and existing hook harness.
- Produces: `fetchTrash`, `restoreTrash`, `purgeTrash`, `emptyTrash`, pure grouping/status helpers, page tabs, trash load/error state, and immediate undo.

- [ ] **Step 1: Add failing guarded API tests**

```js
const restored = await clientExports.__test.restoreTrash?.(['session-b', 'session-a', 'session-b']);
assert(request.url.endsWith('/trash/restore'), 'restore targets trash route');
assert(request.options.method === 'POST', 'restore uses POST');
assert(request.options.headers['x-dsh-archived-chats'] === '1', 'restore sends guard');
assert(request.options.body === '{"sessionIds":["session-b","session-a"]}', 'restore preserves unique order');
```

Repeat exact method/header/body assertions for fetch, purge, and empty. Empty
restore/purge arrays reject before fetch.

- [ ] **Step 2: Run client smoke and verify RED**

Run `rtk node --test test/smoke.test.mjs`.

- [ ] **Step 3: Implement API and pure model helpers**

```js
function uniqueSessionIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id !== ''))];
}

async function fetchTrash() {
  const res = await fetch(`${API_BASE}/trash`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function restoreTrash(ids) {
  const sessionIds = uniqueSessionIds(ids);
  if (sessionIds.length === 0) throw new Error('sessionIds is required');
  return post('/trash/restore', { sessionIds });
}

async function purgeTrash(ids) {
  const sessionIds = uniqueSessionIds(ids);
  if (sessionIds.length === 0) throw new Error('sessionIds is required');
  return post('/trash/purge', { sessionIds });
}

async function emptyTrash() {
  return post('/trash/empty', {});
}

function trashStatusLabel(t, row) {
  if (row.state === 'purge-pending') return t('trash.status.purgePending');
  if (row.state === 'degraded') return t('trash.status.degraded');
  if (row.liveDisposition === 'parked') return t('trash.status.parked');
  return t('trash.status.ready');
}
```

Implement `groupTrashSessions(rows)` with the existing archive group return
shape `{ key, title, items, selectionIds }`, using original workspace ID as key,
`__ungrouped__` for null, first-seen workspace order, and row order unchanged.
Expose no snapshot/filesystem paths.

- [ ] **Step 4: Add failing tab/load/error tests**

Assert two `role=tab` buttons, one selected; Archived defaults and retains all
current controls; first Recycle activation fetches once; loading/error/empty
states render; returning to Archived preserves query/filter/sort/selection;
unavailable trash status disables only recycle mutations.

- [ ] **Step 5: Implement tabs and trash state**

```js
const [pageMode, setPageMode] = useState('archived');
const [trash, setTrash] = useState({ status: 'idle', sessions: [], summary: null, error: null });
```

Fetch on first recycle activation and after successful mutation. Tabs remain
visible on narrow layouts.

- [ ] **Step 6: Add failing changed-delete and immediate-undo tests**

Assert archive copy says Move to Recycle Bin, no archive dialog claims permanent
deletion, success removes only `trashed` rows, toast exposes Undo calling
`/trash/restore`, and failed undo keeps the item/notice.

- [ ] **Step 7: Implement changed archive action and undo notice**

Consume `trashed` arrays, retain failed rows/selections, and store last committed
IDs in notice action state. Clear it after successful undo or a newer destructive
action.

- [ ] **Step 8: Update types, verify, and commit**

```sh
rtk node --test test/smoke.test.mjs
rtk npm test
rtk node --check lib/client.js
rtk git diff --check
rtk git add lib/client.js lib/types/client/index.d.ts test/smoke.test.mjs
rtk git commit -m "feat: add recycle bin client navigation"
```

---

### Task 8: Recycle Rows, Batch Restore/Purge, and Accessibility

**Files:**
- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: Task 7 state/helpers and existing preview/dialog primitives.
- Produces: trash groups/rows/selection, scoped preview, restore/purge/empty workflows, responsive styles, bilingual accessible dialogs.

- [ ] **Step 1: Add failing row/group/status tests**

Use two workspaces and all states. Assert title, original project, trash time,
snapshot bytes, attachment count, and status. Degraded permits original undo and
purge with no-snapshot warning; purge-pending disables both while showing retry.

- [ ] **Step 2: Implement focused TrashGroupSection**

Do not branch the archive `GroupSection`. Reuse icons/date/size helpers. Each row
offers trash-scoped preview, restore, and permanent purge. Keep trash selection
separate from archive selection.

- [ ] **Step 3: Add failing batch restore/purge/empty tests**

Assert request order, partial results, successful-row removal, failed-row
retention, summary refresh, scoped busy states, and that empty uses Host
authority rather than hidden client IDs.

- [ ] **Step 4: Implement batch actions and reconciliation**

Use a trash-ID busy map. Apply only Host `restored/purged` IDs, then refresh
`/trash`; never optimistically remove absent IDs.

- [ ] **Step 5: Add failing permanent-dialog accessibility matrix**

For one/selected/group/empty scopes assert alertdialog role, labels/descriptions,
Cancel initial focus, forward/reverse Tab trap, Escape isolation, trigger/fallback
focus restoration, degraded warning, and original+snapshot removal copy.

- [ ] **Step 6: Implement dialogs using proven focus pattern**

Reuse the exact focusable selector/cleanup behavior from current dialogs. Add no
document listener without an open dialog. Use semantic danger tokens only.

- [ ] **Step 7: Add responsive/localization/regression assertions**

Add all Chinese/English keys. Assert 640px tabs, wrapping metadata/batch actions,
fitting dialogs, and unchanged metadata/import/preview focus tests.

- [ ] **Step 8: Verify and commit Task 8**

```sh
rtk node --test test/smoke.test.mjs
rtk npm test
rtk node --check lib/client.js
rtk git diff --check
rtk git add lib/client.js test/smoke.test.mjs
rtk git commit -m "feat: complete recycle bin management UI"
```

---

### Task 9: Version, Documentation, Packaging, Migration Drill, and Release Gate

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE.en.md`
- Modify: `lib/types/index.d.ts`
- Modify: `lib/types/client/index.d.ts`
- Modify: `test/package.test.mjs`
- Create after verification: `assets/screenshots/9-recycle-bin.png`

**Interfaces:**
- Consumes: complete Tasks 1–8.
- Produces: release-ready 0.11.0 package, accurate bilingual docs/types, package guard, real-host evidence, downgrade warning.

- [ ] **Step 1: Add failing package-content test**

Extend `test/package.test.mjs` to run dry-run pack and require:

```text
lib/trash.js
lib/snapshot.js
lib/recycle.js
docs/ARCHITECTURE.md
docs/ARCHITECTURE.en.md
```

Assert exclusion of `data/`, `.codegraph/`, `docs/superpowers/`, staging files,
test fixtures, and `.worktrees/`.

- [ ] **Step 2: Run package test and verify RED**

Run `rtk node --test test/package.test.mjs`; expect runtime modules absent from
the package allowlist.

- [ ] **Step 3: Update package metadata to 0.11.0**

Set version 0.11.0, add three runtime files, update description and add
`recycle-bin`, `undo`, `snapshot` keywords. Run
`rtk npm install --package-lock-only --ignore-scripts`; dependency versions must
not change.

- [ ] **Step 4: Update bilingual user docs**

Document tabs, automatic snapshot scope/one-active rule, original/fallback undo,
attachment inclusion and global-GC limitation, purge/empty, local paths/privacy,
0.10 pending migration, downgrade warning, degraded states, changelog and update
command. Do not claim retention, tree restore, or immediate attachment GC.

- [ ] **Step 5: Update architecture and public type docs**

Mirror exact schemas, transitions, 17-route table, ordering, recovery, security,
rollback, compatibility, attachment limitation, and response names
`trashed/restored/purged/failed`.

- [ ] **Step 6: Run full automated verification**

```sh
rtk npm test
rtk node --check lib/index.js
rtk node --check lib/client.js
rtk node --check lib/trash.js
rtk node --check lib/snapshot.js
rtk node --check lib/recycle.js
rtk npm pack --dry-run --json
rtk git diff --check
```

Expected: zero failures and no local DSH data in the package.

- [ ] **Step 7: Run real-host lifecycle matrix**

Link the feature worktree into an isolated Web profile copy on Harness
0.1.1-rc.2. Use disposable sessions with text, tools, images, metadata,
workspaces, one live agent, and one legacy pending ID. Verify:

1. cold move snapshots and preserves original artifact;
2. live move stops activity and reports disposed/parked;
3. restart never deletes ordinary trash;
4. original undo writes no persistence;
5. forced original removal uses exact snapshot fallback;
6. attachments preview before/after fallback;
7. ID conflict writes nothing;
8. injected purge crash resumes;
9. legacy pending migrates without deletion;
10. light/dark desktop/640px layouts;
11. keyboard/focus matrix;
12. archive search/preview/export/import/unarchive regression.

- [ ] **Step 8: Capture verified screenshot and link it**

After Step 7, capture the real light-theme Recycle Bin as
`assets/screenshots/9-recycle-bin.png` and link it after screenshot 8 in both
READMEs. Never generate/mock it.

- [ ] **Step 9: Re-run final verification**

```sh
rtk npm test
rtk npm pack --dry-run --json
rtk git diff --check
rtk git status --short --branch
```

Expected: zero failures and only planned Task 9 changes.

- [ ] **Step 10: Commit release candidate**

```sh
rtk git add package.json package-lock.json README.md README.en.md docs/ARCHITECTURE.md docs/ARCHITECTURE.en.md lib/types/index.d.ts lib/types/client/index.d.ts test/package.test.mjs assets/screenshots/9-recycle-bin.png
rtk git commit -m "release: prepare dsh-archived-chats 0.11.0"
```

- [ ] **Step 11: Request final code review and stop before release**

Use `superpowers:requesting-code-review` for base `e26f7df` through final HEAD.
Fix Critical/Important findings, rerun Step 9, and leave a clean branch ready for
the user-authorized PR/tag/release workflow.

---

## Plan Self-Review Checklist

- [ ] Every spec goal and acceptance criterion maps to Tasks 1–9.
- [ ] Ordinary delete never calls physical purge in Tasks 3, 6, 7, or 8.
- [ ] Only Task 5/6 purge flow invokes `purgePhysical`.
- [ ] States are consistently `trashed`, `purge-pending`, `degraded`.
- [ ] Snapshot methods are consistently `capture`, `validate`, `latestFor`, `recover`, `removeForSession`.
- [ ] Recycle methods are consistently `move`, `restore`, `purge`, `empty`, `recoverStartup`, `list`, `summary`.
- [ ] Responses are consistently `trashed`, `restored`, `purged`, `failed`.
- [ ] Every production behavior starts with an observed failing test.
- [ ] No private renderer, guessed attachment path, or hand-built session backend file is required.
- [ ] 0.12 retention/space/lineage and 1.0 time-machine work is absent.
