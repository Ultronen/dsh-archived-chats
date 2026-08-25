# Session Time Machine 1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a validated history version after archive, preview retained versions, and restore any healthy version as a new archived session without changing its source.

**Architecture:** Extend the existing version-one `SnapshotStore` with bounded history reads and revision lookup, then add a focused `HistoryService` and `HistoryRestoreService`. Register six guarded routes and a lazy fifth client tab while keeping all snapshot mutation inside the existing lifecycle queue and all restoration behind Host capabilities and a single-use confirmation token.

**Tech Stack:** Node.js 18+ ES modules, Cordis/DeepSeek Harness services, React 18 client module, `node:test`, existing local HTTP and snapshot helpers.

**Spec:** `docs/superpowers/specs/2026-08-25-session-time-machine-design.md`

## Global Constraints

- Keep the existing `dsh-archived-chats/snapshot` manifest at version `1`, including legacy `reason: "trash"`, so 0.12 can validate, retain, and purge 1.0 captures.
- Never overwrite, mutate, unarchive, or delete the source session during history restore.
- Archive success must not be rolled back when history capture fails.
- Do not scan unrelated active conversations or add scheduled/background capture.
- All new POST routes require `x-dsh-archived-chats: 1`, exact bounded JSON, and `no-store` responses.
- No client response or log may expose workspace paths, snapshot paths, attachment paths, raw records, user-authored text, notes, or token values.
- State-changing capture, retention, recycle, and restore boundaries share the existing lifecycle queue.
- Use only explicit Host persistence/attachment capabilities; never hand-write a Harness backend file.
- Preserve Chinese/English locale behavior, theme tokens, keyboard access, focus restoration, narrow layouts, and existing archive/recycle behavior.
- Every production change starts with a failing test and ends with a focused passing test plus a commit.

## File structure

### New production files

- `lib/history.js` — capture orchestration, safe inventory, preview projection, image authorization, cache and invalidation.
- `lib/history-restore.js` — restore token store and transactional restore-as-copy coordinator.

### Existing production files

- `lib/snapshot.js` — bounded history inspection, session-page/image reads, and revision lookup.
- `lib/recycle.js` — reuse an existing same-revision snapshot before publishing duplicate protection bytes.
- `lib/index.js` — construct services, register six routes, serialize mutations, and invalidate dependent caches.
- `lib/client.js` — capture-aware archive notice, History tab, history timeline, preview, and restore confirmation.
- `lib/types/index.d.ts` and `lib/types/client/index.d.ts` — public history response and restore types.
- `package.json` and `package-lock.json` — release version `1.0.0` and package file list/keywords.
- `README.md`, `README.en.md`, `docs/ARCHITECTURE.md`, and `docs/ARCHITECTURE.en.md` — local history, restore-as-copy, safety, downgrade, and attachment-GC boundaries.

### New test files

- `test/history.test.mjs` — `HistoryService` capture, grouping, cache, preview, and image authorization.
- `test/history-restore.test.mjs` — token and restore transaction behavior.

### Existing test files

- `test/snapshot.test.mjs` — new store primitives and limits.
- `test/recycle.test.mjs` — same-revision reuse.
- `test/smoke.test.mjs` — six routes, archive notice, fifth tab, dialogs, localization, and regression assertions.
- `test/package.test.mjs` — 1.0 package metadata and packed file set.
- `test/types.test.mjs` — declaration compilation.

---

### Task 1: Add bounded history primitives to `SnapshotStore`

**Files:**
- Modify: `lib/snapshot.js`
- Test: `test/snapshot.test.mjs`

**Interfaces:**
- Consumes: existing `capture(input)`, `validate(snapshotId)`, `inventory()`, `SNAPSHOT_LIMITS`, manifest and record validators.
- Produces:
  - `inspectHistory(snapshotId) -> Promise<HistorySnapshotDetails>`
  - `readHistoryPage(snapshotId, { offset, limit }) -> Promise<HistoryPage>`
  - `readHistoryImage(snapshotId, reference, signal) -> Promise<{ data, mediaType, width, height, name }>`
  - `findRevision(sessionId, sourceRevision) -> Promise<SnapshotSummary | null>`
  - `HISTORY_SNAPSHOT_LIMIT = 5000`

- [ ] **Step 1: Write failing tests for history inspection and revision lookup**

Add tests that capture two fixture revisions and assert cloned safe metadata and exact lookup:

```js
test('history inspection exposes safe descriptor and finds an exact revision', async () => {
  const item = await fixture({ revisions: ['rev-a', 'rev-a'] });
  const saved = await item.store.capture({ sessionId: 'session-a', archive, liveDisposition: 'parked' });
  const details = await item.store.inspectHistory(saved.snapshotId);
  assert.equal(details.snapshotId, saved.snapshotId);
  assert.equal(details.sessionId, 'session-a');
  assert.equal(details.sourceRevision, 'rev-a');
  assert.equal(details.archive.title, archive.title);
  assert.equal('path' in details, false);
  assert.equal(await item.store.findRevision('session-a', 'rev-a').then((row) => row.snapshotId), saved.snapshotId);
  assert.equal(await item.store.findRevision('session-a', 'rev-missing'), null);
});
```

- [ ] **Step 2: Run the focused test and observe the missing-method failure**

Run: `node --test test/snapshot.test.mjs`

Expected: FAIL because `inspectHistory` and `findRevision` do not exist.

- [ ] **Step 3: Implement safe history inspection and exact revision lookup**

Factor the manifest/session validation portion of `validate()` into an internal helper that returns cloned manifest/record plus canonical directory, but does not read attachment bytes. Return only:

```js
{
  snapshotId,
  sessionId,
  createdAt,
  sourceRevision,
  totalBytes,
  sessionBytes,
  attachmentCount,
  archive: {
    title,
    createdAt,
    origin,
    workspace: workspace === null ? null : { id, title },
    tags,
    note,
    metadataUpdatedAt
  }
}
```

Never return `archive.workspace.path`, canonical directories, attachment paths,
or record source events. `findRevision` must return `null` for null/empty
revisions and scan no more than 5,000 UUID directories.

- [ ] **Step 4: Write failing tests for paginated history projection and one-image reads**

Use the existing projected preview fixture and an attachment-bearing snapshot:

```js
const page = await store.readHistoryPage(saved.snapshotId, { offset: 0, limit: 20 });
assert.equal(page.sessionId, 'session-a');
assert.equal(page.messages[0].role, 'user');
assert.equal(page.hasMore, false);
assert.equal(JSON.stringify(page).includes(root), false);

const image = await store.readHistoryImage(saved.snapshotId, projectedRef, new AbortController().signal);
assert.deepEqual(image.data, expectedBytes);
await assert.rejects(
  store.readHistoryImage(otherSnapshotId, projectedRef, new AbortController().signal),
  (error) => error.code === 'snapshot-image-not-found'
);
```

- [ ] **Step 5: Run the focused test and observe missing-method failures**

Run: `node --test test/snapshot.test.mjs`

Expected: FAIL because `readHistoryPage` and `readHistoryImage` do not exist.

- [ ] **Step 6: Implement bounded page and image reads**

Reuse `projectPreviewMessages` and `findProjectedImage` from the current
projection module. Enforce integer `offset >= 0`, integer `limit` in `1..100`,
session-record byte limits, exact descriptor membership, symlink confinement,
per-image byte limits, digest equality, abort propagation, and cloned output.

- [ ] **Step 7: Add and pass the 5,000-directory limit test**

Inject or create 5,001 UUID directory entries and assert `inspectHistory`/
`findRevision` fail with `history-limit-exceeded` before returning partial data.

Run: `node --test test/snapshot.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit snapshot primitives**

```bash
git add lib/snapshot.js test/snapshot.test.mjs
git commit -m "feat: expose validated snapshot history reads"
```

---

### Task 2: Build `HistoryService` capture and inventory

**Files:**
- Create: `lib/history.js`
- Create: `test/history.test.mjs`

**Interfaces:**
- Consumes: Task 1 `SnapshotStore` methods, `trashStore.load/get`, registry/persistence/metadata public APIs, lifecycle queue.
- Produces:
  - `createHistoryService(deps)`
  - `captureArchived(sessionId)`
  - `list()`
  - `invalidate(sessionIds?)`
  - `HistoryError { code, status }`

- [ ] **Step 1: Write failing capture tests**

Create exact fakes for registry, persistence revisions, metadata, trash, and
snapshot store. Assert archive ownership, revision dedupe, and safe failure:

```js
test('capture rechecks archive ownership and reuses the same revision', async () => {
  const history = createHistoryService(fixture({ archived: ['session-a'], revision: 'rev-a', existingRevision: 'rev-a' }));
  const result = await history.captureArchived('session-a');
  assert.equal(result.reused, true);
  assert.equal(result.snapshot.snapshotId, 'snapshot-existing');
  assert.equal(calls.capture, 0);
});

test('capture refuses non-archived and recycled sources without inspecting content', async () => {
  await assert.rejects(notArchived.captureArchived('session-a'), (error) => error.code === 'history-source-not-archived');
  await assert.rejects(recycled.captureArchived('session-a'), (error) => error.code === 'history-source-recycled');
  assert.equal(calls.inspect, 0);
});
```

- [ ] **Step 2: Run the new test and observe module-not-found**

Run: `node --test test/history.test.mjs`

Expected: FAIL because `lib/history.js` does not exist.

- [ ] **Step 3: Implement capture with exact descriptor construction**

Build a descriptor matching the existing recycle descriptor, excluding the
workspace path before it reaches any response. Use the shared lifecycle queue,
require a stable revision for a live source, reuse `findRevision` for non-null
revisions, call `snapshotStore.capture()` otherwise, and expose only:

```js
{ reused, snapshot: { snapshotId, sessionId, createdAt, bytes, attachmentCount, sourceRevision } }
```

Map missing/stale capabilities to stable `HistoryError` codes. Do not catch and
change the caller's successful Harness archive operation; this service starts
only after archive success.

- [ ] **Step 4: Write failing inventory tests**

Assert grouping, safe current scope, current protection state, degraded opacity,
sort order, cache sharing, and stale in-flight invalidation:

```js
const first = history.list();
const second = history.list();
assert.equal(await first, await second);
assert.equal(calls.inventory, 1);
const response = await first;
assert.deepEqual(response.sessions[0].versions.map((item) => item.snapshotId), ['newer', 'older']);
assert.equal(response.sessions[0].versions[0].state, 'recycle-protection');
assert.deepEqual(Object.keys(response.degraded[0]).sort(), ['code', 'snapshotId']);
assert.equal(JSON.stringify(response).includes('/Users/'), false);
```

- [ ] **Step 5: Implement list caching, grouping, and invalidation**

Use a 30-second completed cache, one shared in-flight promise, generation-based
invalidation, cloned returns, deterministic session/version sorting, and only
`archived`, `recycled`, or `history-only` scope.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/history.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the history service**

```bash
git add lib/history.js test/history.test.mjs
git commit -m "feat: capture and list session history"
```

---

### Task 3: Add history preview and image authorization

**Files:**
- Modify: `lib/history.js`
- Modify: `test/history.test.mjs`

**Interfaces:**
- Consumes: Task 1 `readHistoryPage` and `readHistoryImage`.
- Produces:
  - `preview(snapshotId, { offset, limit })`
  - `readImage(snapshotId, reference, signal)`

- [ ] **Step 1: Write failing service-level authorization tests**

```js
test('preview accepts only a published healthy snapshot identity', async () => {
  const page = await history.preview('snapshot-a', { offset: 0, limit: 50 });
  assert.equal(page.snapshot.snapshotId, 'snapshot-a');
  assert.equal(page.messages.length, 2);
  await assert.rejects(history.preview('degraded-a', { offset: 0, limit: 50 }),
    (error) => error.code === 'history-snapshot-degraded');
});

test('image reads are snapshot-scoped and forward cancellation', async () => {
  const controller = new AbortController();
  await history.readImage('snapshot-a', imageRef, controller.signal);
  assert.equal(calls.image.snapshotId, 'snapshot-a');
  assert.equal(calls.image.signal, controller.signal);
});
```

- [ ] **Step 2: Run focused tests and observe missing-method failures**

Run: `node --test test/history.test.mjs`

Expected: FAIL because `preview` and `readImage` are absent.

- [ ] **Step 3: Implement preview and image delegation**

Check snapshot identity against a fresh/valid inventory entry, delegate bounded
reads, map validation failures to `history-snapshot-degraded`, and invalidate
the completed inventory if a previously healthy snapshot fails validation.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/history.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit history preview**

```bash
git add lib/history.js test/history.test.mjs
git commit -m "feat: preview validated history versions"
```

---

### Task 4: Implement token-bound restore-as-copy

**Files:**
- Create: `lib/history-restore.js`
- Create: `test/history-restore.test.mjs`
- Modify: `lib/recycle.js` only to extract/share attachment-reference rewriting helpers when necessary

**Interfaces:**
- Consumes: `snapshotStore.validate(snapshotId)`, persistence create/append/locate/list capabilities, attachment `saveImage`, registry state/workspaces, metadata store, lifecycle queue.
- Produces:
  - `createHistoryRestoreService(deps)`
  - `prepare(snapshotId) -> { token, nonce, expiresAt, snapshot, destination, warnings }`
  - `restore(token, nonce) -> { restored, sourceSessionId, snapshotId, warnings }`
  - `capability -> { supported, reason? }`

- [ ] **Step 1: Write failing token lifecycle tests**

Use injected `now`, `uuid`, and random token functions:

```js
test('prepare binds a Host-generated destination and restore consumes once', async () => {
  const prepared = await service.prepare('snapshot-a');
  assert.equal(prepared.destination.sessionId, 'new-session-id');
  assert.equal(JSON.stringify(prepared).includes('events'), false);
  const restored = await service.restore(prepared.token, prepared.nonce);
  assert.deepEqual(restored.restored, ['new-session-id']);
  await assert.rejects(service.restore(prepared.token, prepared.nonce),
    (error) => error.code === 'history-restore-expired');
});

test('wrong nonce, expiry, and changed manifest fail before writes', async () => {
  await assert.rejects(service.restore(token, 'wrong'), hasCode('history-restore-expired'));
  now.advance(300_001);
  await assert.rejects(service.restore(expiring.token, expiring.nonce), hasCode('history-restore-expired'));
  snapshotStore.digest = 'changed';
  await assert.rejects(service.restore(stale.token, stale.nonce), hasCode('history-restore-stale'));
  assert.equal(calls.persistenceCreate, 0);
});
```

- [ ] **Step 2: Run the new tests and observe module-not-found**

Run: `node --test test/history-restore.test.mjs`

Expected: FAIL because `lib/history-restore.js` does not exist.

- [ ] **Step 3: Implement token preparation**

Fully validate the snapshot, compute a stable digest from its validated manifest,
generate token/nonce/destination ID on the Host, store only in memory, expire at
five minutes, and return a safe summary. Consume/delete the token before any
restore writes.

- [ ] **Step 4: Write failing transactional restore tests**

Cover message identity rewrite, attachment rewrite, workspace fallback,
metadata copy, registry-last ordering, source immutability, and failure at every
commit boundary:

```js
assert.deepEqual(calls.order, ['validate', 'create', 'attachments', 'append', 'workspace', 'metadata', 'registry']);
assert.equal(written.meta.id, 'new-session-id');
assert.equal(sourceBytesAfter, sourceBytesBefore);
assert.equal(snapshotBytesAfter, snapshotBytesBefore);
assert.equal(registry.archivedSessionIds.at(-1), 'new-session-id');
```

For each injected failure, assert persistence undo, workspace detach, metadata
restore/remove, registry restoration, and staging cleanup occur in reverse
order. Explicitly assert no claim is made that saved global attachment objects
were deleted.

- [ ] **Step 5: Implement the restore transaction**

Extract pure helpers for recursive exact attachment-reference replacement and
session-ID rewrite. Require explicit Host writer capabilities, stage privately,
check the destination ID again immediately before create, write registry state
last, and reverse completed plugin-controlled operations on failure.

- [ ] **Step 6: Run focused restore and recycle tests**

Run: `node --test test/history-restore.test.mjs test/recycle.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit restore-as-copy**

```bash
git add lib/history-restore.js lib/recycle.js test/history-restore.test.mjs test/recycle.test.mjs
git commit -m "feat: restore history as a new session"
```

---

### Task 5: Register the six Host routes

**Files:**
- Modify: `lib/index.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–4 service constructors and methods.
- Produces the six routes named in the spec and safe HTTP response shapes.

- [ ] **Step 1: Add failing route-registration and method/guard tests**

Update the expected route count from 22 to 28 and assert each history path is
registered. Add checks:

```js
assertStatus('GET', '/history', 200);
assertStatus('GET', '/history/capture', 405);
assertStatus('POST', '/history/capture', 403, { headers: {} });
assertStatus('POST', '/history/preview', 403, { headers: {} });
assertStatus('POST', '/history/restore/preview', 403, { headers: {} });
assertStatus('POST', '/history/restore', 403, { headers: {} });
```

- [ ] **Step 2: Run the smoke test and observe route failures**

Run: `node --test test/smoke.test.mjs`

Expected: FAIL at route count and missing history paths.

- [ ] **Step 3: Construct history services in `apply()`**

Create one `HistoryService` and one `HistoryRestoreService` beside
`RecycleService`, inject the shared lifecycle queue and cache invalidators, and
pass them into `registerRoutes`. Do not register partial history routes when
core registry/persistence/web services are absent.

- [ ] **Step 4: Register exact bounded handlers**

Implement:

```text
POST /history/capture              body <= 64 KiB, exact { sessionId }
GET  /history                      no request body
POST /history/preview              body <= 64 KiB, exact { snapshotId, offset, limit }
POST /history/preview/image        body <= 64 KiB, exact snapshot/image identity
POST /history/restore/preview      body <= 64 KiB, exact { snapshotId }
POST /history/restore              body <= 64 KiB, exact { token, nonce }
```

Use `sendImage` for authorized bytes and `requestAbort` for image cancellation.
Set stable status/code mappings from the spec and log only IDs plus stable codes.

- [ ] **Step 5: Add successful and stale restore route tests**

Exercise inventory response privacy, capture idempotence, preview pagination,
single-image response headers, restore preparation, confirmation, replay, and
manifest-change rejection.

- [ ] **Step 6: Run smoke and focused service tests**

Run: `node --test test/smoke.test.mjs test/history.test.mjs test/history-restore.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit Host integration**

```bash
git add lib/index.js test/smoke.test.mjs
git commit -m "feat: register session history routes"
```

---

### Task 6: Reuse same-revision snapshots in recycle moves

**Files:**
- Modify: `lib/recycle.js`
- Modify: `test/recycle.test.mjs`

**Interfaces:**
- Consumes: `snapshotStore.findRevision(sessionId, sourceRevision)` and current capture return shape.
- Produces: recycle records that may safely name an existing same-revision healthy snapshot.

- [ ] **Step 1: Write the failing same-revision recycle test**

```js
test('recycle reuses a healthy archive snapshot for the same source revision', async () => {
  const item = fixture({ existingSnapshot: { snapshotId: 'archive-snapshot', sourceRevision: 'rev-a' } });
  const result = await item.service.move(['session-a']);
  assert.deepEqual(result.trashed, ['session-a']);
  assert.equal(item.calls.capture, 0);
  assert.equal((await item.trashStore.get('session-a')).snapshotId, 'archive-snapshot');
});
```

Also assert null revisions and changed revisions still publish a new protection
snapshot.

- [ ] **Step 2: Run recycle tests and observe duplicate capture**

Run: `node --test test/recycle.test.mjs`

Expected: FAIL because `moveOne` always calls `capture`.

- [ ] **Step 3: Implement conservative same-revision reuse**

Resolve the source revision through a safe snapshot-store method, reuse only a
fully healthy exact match, and preserve all ownership rechecks and cleanup rules.
Never reuse a null-revision or degraded snapshot.

- [ ] **Step 4: Run recycle, snapshot, and history tests**

Run: `node --test test/recycle.test.mjs test/snapshot.test.mjs test/history.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit recycle integration**

```bash
git add lib/recycle.js test/recycle.test.mjs
git commit -m "fix: avoid duplicate recycle snapshots"
```

---

### Task 7: Extend the archive notice with history capture state

**Files:**
- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: `POST /history/capture` and existing archive notice controller/interceptor.
- Produces: capture pending/saved/failure state and bounded retry without changing View/Undo.

- [ ] **Step 1: Write failing controller/interceptor tests**

Assert the original archive runs first, capture starts only after success, a
failed archive never captures, and capture failure preserves archive success:

```js
const result = await intercepted.archiveSession('session-a');
assert.deepEqual(calls.order, ['archive:session-a', 'capture:session-a']);
assert.equal(controller.getSnapshot().captureStatus, 'saved');

await assert.rejects(intercepted.archiveSession('session-fail'));
assert.equal(calls.capture.includes('session-fail'), false);

capture.reject(new Error('busy'));
assert.equal(controller.getSnapshot().captureStatus, 'error');
await controller.retryCapture();
assert.equal(calls.capture.at(-1), 'session-a');
```

- [ ] **Step 2: Run smoke tests and observe missing capture state**

Run: `node --test test/smoke.test.mjs`

Expected: FAIL because the controller/interceptor does not call history capture.

- [ ] **Step 3: Implement capture-aware controller and interceptor**

Add injected `capture(sessionId)` to the controller. Keep the three-second timer
paused while capture is pending, retain existing `view()` and `undo()`, and add
`retryCapture()`. Do not cancel Host capture when the notice closes. Ignore a
late response belonging to an older notice identity.

- [ ] **Step 4: Add Chinese/English copy and overlay assertions**

Add exact localized strings for saving, saved, not saved, and retry. Verify
screen-reader status semantics, retry focus, hover/focus timer pause, and narrow
styles without hard-coded colors.

- [ ] **Step 5: Run smoke tests**

Run: `node --test test/smoke.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit capture-aware notice**

```bash
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: save history after archive"
```

---

### Task 8: Build the lazy History tab and restore dialogs

**Files:**
- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: all history HTTP routes and existing native preview components.
- Produces: fifth tab, grouped timeline, search, preview, restore preparation/confirmation, and transient success notice.

- [ ] **Step 1: Write failing tab, lazy-load, grouping, and empty-state tests**

```js
assert.equal(tabLabels.join(','), '归档,历史版本,回收站,存储与保留,来源与分支');
assert.equal(fetchCalls.history, 0);
activateTab('history');
assert.equal(fetchCalls.history, 1);
assert.equal(text(tree).includes('2 个历史版本'), true);
assert.equal(findVersionRows(tree).map((row) => row.snapshotId).join(','), 'newer,older');
```

Cover search by title/workspace, `history-only` scope, recycle-protection label,
opaque degraded rows, retry, and no path/session-content leakage.

- [ ] **Step 2: Run smoke tests and observe missing fifth tab**

Run: `node --test test/smoke.test.mjs`

Expected: FAIL because only four tabs exist.

- [ ] **Step 3: Implement focused client helpers and `HistoryPanel`**

Add `fetchHistory`, `fetchHistoryPreview`, `fetchHistoryImage`,
`prepareHistoryRestore`, and `confirmHistoryRestore`. Build `HistoryPanel` as a
focused component inside the current module, lazy-load once, group by safe
server response, sort versions newest first, and use disclosure/list semantics.

- [ ] **Step 4: Reuse the existing conversation preview dialog**

Parameterize the current preview/image loaders by source scope rather than
copying the dialog. Show the snapshot timestamp and read-only label, preserve
pagination/tool/image rendering, abort older requests, and revoke image URLs on
close.

- [ ] **Step 5: Write failing restore-dialog tests**

Assert preparation occurs before confirmation, raw token values are not
rendered, confirmation names restore-as-copy and no overwrite, cancel performs
no restore, success refreshes archive/history/sidebar, and errors keep the
dialog available for a fresh preparation.

- [ ] **Step 6: Implement accessible restore confirmation and success state**

Use the existing alert-dialog focus trap and Escape isolation. Initial focus is
Cancel. On success close the dialog, refresh history/archive/sidebar, and show a
transient localized notice containing the safe restored ID/title only.

- [ ] **Step 7: Add responsive/theme/localization assertions**

Verify Chinese and English labels, `Intl` dates, narrow action wrapping, stable
icons, theme tokens, keyboard disclosure, focus restoration, and degraded
disabled actions.

- [ ] **Step 8: Run smoke and history tests**

Run: `node --test test/smoke.test.mjs test/history.test.mjs test/history-restore.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit the History UI**

```bash
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: add session history time machine"
```

---

### Task 9: Publish types, metadata, documentation, and release verification

**Files:**
- Modify: `lib/types/index.d.ts`
- Modify: `lib/types/client/index.d.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE.en.md`
- Modify: `test/package.test.mjs`
- Modify: `test/types.test.mjs`

**Interfaces:**
- Consumes: final runtime response shapes.
- Produces: public 1.0 declarations, package contents, release notes, and verified delivery metadata.

- [ ] **Step 1: Write failing package and type assertions**

Require package version `1.0.0`, new runtime files in the packed package, no
plugin-data/worktree/test artifacts, and declarations for:

```ts
export type HistoryScope = 'archived' | 'recycled' | 'history-only';
export type HistoryVersionState = 'history' | 'recycle-protection';
export interface HistoryVersion { snapshotId: string; createdAt: string; totalBytes: number; attachmentCount: number; state: HistoryVersionState; }
export interface HistorySession { sessionId: string; title: string | null; workspace: { id: string | null; title: string | null } | null; scope: HistoryScope; versions: HistoryVersion[]; }
export interface HistoryResponse { generatedAt: string; sessions: HistorySession[]; degraded: Array<{ snapshotId: string; code: string }>; }
export interface HistoryRestoreResult { restored: string[]; sourceSessionId: string; snapshotId: string; warnings: Array<{ id: string; reason: string }>; }
```

- [ ] **Step 2: Run package/type tests and observe old-version failures**

Run: `node --test test/package.test.mjs test/types.test.mjs`

Expected: FAIL because metadata is `0.12.0` and declarations/files are absent.

- [ ] **Step 3: Update declarations and package metadata**

Set both package files to `1.0.0`, add `history`, `time-machine`, and
`version-restore` keywords, add new runtime/type files to package expectations,
and keep the Node/Harness dependency floors unchanged unless verification proves
a required public capability is missing.

- [ ] **Step 4: Update bilingual documentation**

Document:

- versions are local validated data copies, not UI screenshots;
- browser archive success triggers one version per stable revision;
- recycle protection snapshots also appear in history;
- preview is read-only and restore always creates a new archived ID;
- retention governs history and permanent purge removes validated history for
  that source;
- no background active-chat scan, cloud sync, in-place overwrite, or global
  attachment garbage-collection claim;
- downgrade backup warning and real-host compatibility result.

Keep Chinese and English structure synchronized and preserve the established
`## 预览` / `## Preview` headings and screenshot paths until new verified 1.0
screenshots are captured.

- [ ] **Step 5: Run focused package/type tests**

Run: `node --test test/package.test.mjs test/types.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run complete automated verification**

Run:

```bash
npm test
npm pack --dry-run --json
git diff --check
```

Expected: all tests pass with zero failures; pack output includes the new
runtime/type/docs files and excludes local state, `.worktrees`, `.codegraph`,
and tests; diff check prints nothing.

- [ ] **Step 7: Run isolated real-host verification**

Start a random-port DSH Web profile with an isolated temporary `DSH_HOME` and
verify:

```text
archive -> capture saved -> History shows version
unarchive/change/rearchive -> second version
preview old messages and one stored image
restore old version -> new archived ID, source unchanged
replay restore confirmation rejected
retention preview/apply can select old non-active history
light/dark and narrow layout remain usable
```

Do not claim browser clicking if only HTTP/automated checks ran.

- [ ] **Step 8: Commit the 1.0 release package**

```bash
git add package.json package-lock.json README.md README.en.md docs/ARCHITECTURE.md docs/ARCHITECTURE.en.md lib/types/index.d.ts lib/types/client/index.d.ts test/package.test.mjs test/types.test.mjs
git commit -m "release: prepare session time machine 1.0.0"
```

- [ ] **Step 9: Record final verification state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -12
npm test
```

Expected: clean feature worktree, task commits visible, and full test suite exits
zero immediately before handoff.
