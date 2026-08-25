# Storage, Retention, and Session Lineage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship dsh-archived-chats 0.12.0 with a trusted space inventory, preview-first retention policies, and a bounded read-only session-lineage tree.

**Architecture:** Extend the snapshot store with a summary-only verifier, compose it with existing session measurement in a focused insights service, and feed immutable inventories into a pure retention planner plus a single-use application coordinator. Derive lineage from durable Harness headers in a separate pure projector. Host routes remain thin, and the existing client settings surface adds lazy Storage & Retention and Session Lineage tabs.

**Tech Stack:** Node.js ESM, `node:test`, DeepSeek Harness Cordis plugin APIs, React primitives supplied by Harness, filesystem JSON stores with atomic rename, built-in `node:crypto` hashing.

**Spec:** `docs/superpowers/specs/2026-08-24-storage-retention-lineage-design.md`

## Global Constraints

- Target package version is `0.12.0`; host baseline is DeepSeek Harness `0.1.1-rc.2`.
- No background policy execution and no default permanent chat deletion.
- Every destructive policy application requires a fresh five-minute preview token and explicit selection.
- Recycle purges must delegate to the existing crash-safe `RecycleService.purge()` transaction.
- Active, degraded, changed, or unvalidated snapshots are never policy-deleted.
- Never expose filesystem paths, transcript content, attachment bytes/names, or tokens in browser responses or logs.
- Keep `trash.json` and snapshot formats at version one; add only version-one `retention.json`.
- Use public Harness persistence/header fields. Do not guess or rewrite private storage formats.
- Production behavior follows strict RED → GREEN → REFACTOR cycles.

---

### Task 1: Summary-only snapshot inventory and retained history

**Files:**
- Modify: `lib/snapshot.js`
- Modify: `lib/recycle.js`
- Test: `test/snapshot.test.mjs`
- Test: `test/recycle.test.mjs`

**Interfaces:**
- Consumes: existing version-one snapshot directories and `TrashStore` active `snapshotId` values.
- Produces: `snapshotStore.inventory(): Promise<{ valid: SnapshotInventoryRow[], degraded: SnapshotFailureRow[] }>` where valid rows contain `snapshotId`, `sessionId`, `createdAt`, `totalBytes`, `sessionBytes`, `attachmentCount`, and `{ sha256, bytes }[]` attachment summaries.

- [ ] **Step 1: Write failing summary-inventory tests**

Add a sequence-capable UUID fixture and tests that prove two valid snapshots are summarized without returning attachment payloads:

```js
test('inventory verifies published snapshots without returning attachment bytes', async () => {
  const ids = [nextId(1), nextId(2)];
  const { store } = await fixture({
    uuid: () => ids.shift(),
    events: [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'image', ...image() }] } } }],
  });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });
  await store.capture({ sessionId: 'session-a', archive, liveDisposition: 'cold' });

  const result = await store.inventory();
  assert.equal(result.valid.length, 2);
  assert.deepEqual(Object.keys(result.valid[0]).sort(), [
    'attachmentCount', 'attachments', 'createdAt', 'sessionBytes',
    'sessionId', 'snapshotId', 'totalBytes',
  ]);
  assert.deepEqual(Object.keys(result.valid[0].attachments[0]).sort(), ['bytes', 'sha256']);
  assert.equal(Object.hasOwn(result.valid[0].attachments[0], 'data'), false);
});
```

Add a corrupted-attachment case that expects the UUID in `degraded` and no trusted valid row. The production mutation caught by these tests is an inventory that trusts manifest sizes or returns restore payloads without hashing stored bytes.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/snapshot.test.mjs`

Expected: FAIL because `store.inventory` is undefined.

- [ ] **Step 3: Implement summary-only verification**

In `lib/snapshot.js`:

```js
async function hashFileBounded(path, limit) {
  const details = await stat(path);
  if (!details.isFile()) throw failure('snapshot-path-unsafe', 'snapshot path is not a file');
  if (details.size > limit) throw failure('snapshot-limit-exceeded', 'snapshot file exceeds a limit', 413);
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw failure('snapshot-limit-exceeded', 'snapshot file exceeds a limit', 413);
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}
```

Import `createReadStream` from `node:fs`. Extract shared manifest/session path validation from `validate()` into an internal inspector. Keep `validate()` behavior unchanged for restoration; add `inventory()` that hashes session/attachment files sequentially, compares every declared size/digest and total, returns only summary fields, sorts valid rows by `snapshotId`, and reports `{ snapshotId, code }` for invalid UUID directories.

In `lib/recycle.js`, remove the post-commit block that deletes `prior.snapshotId`. Keep `removeNewSnapshot()` for rollback/cancellation and keep `purge()` calling `removeForSession()`.

- [ ] **Step 4: Add and run the retained-history test**

Add to `test/recycle.test.mjs`:

```js
test('a new recycle cycle keeps the prior protection snapshot as history', async () => {
  const fixture = recycleFixture({ priorSnapshotId: nextId(9) });
  const result = await fixture.service.move(['session-a']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(fixture.snapshotStore.removed, []);
});
```

Run: `node --test test/snapshot.test.mjs test/recycle.test.mjs`

Expected: PASS. The production mutation caught is reintroducing unconditional prior-snapshot removal after a successful move.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

Commit:

```bash
git add lib/snapshot.js lib/recycle.js test/snapshot.test.mjs test/recycle.test.mjs
git commit -m "feat: retain and inventory protection snapshots"
```

---

### Task 2: Trusted space-insights service

**Files:**
- Create: `lib/insights.js`
- Create: `test/insights.test.mjs`
- Modify: `lib/snapshot.js`

**Interfaces:**
- Consumes: `statsService.measure(ids)`, `trashStore.load()`, `snapshotStore.inventory()`, and a server-owned `listSessions()` callback returning `{ id, title, workspaceId, workspaceTitle, scope }[]`.
- Produces: `createInsightsService({ statsService, trashStore, snapshotStore, listSessions, now, ttlMs }).inspect()` and `.invalidate()`.

- [ ] **Step 1: Write failing insights aggregation tests**

Create `test/insights.test.mjs` with literal fixtures:

```js
test('insights separates session and snapshot bytes and counts repeated snapshot content', async () => {
  const service = createInsightsService({
    listSessions: async () => [
      { id: 'a', title: 'Alpha', workspaceId: 'w', workspaceTitle: 'Work', scope: 'archive' },
      { id: 'b', title: 'Beta', workspaceId: 'w', workspaceTitle: 'Work', scope: 'trash' },
    ],
    statsService: { measure: async () => ({
      summary: { sessionCount: 2, totalBytes: 300, unavailableCount: 0 },
      sessions: { a: { status: 'ready', sizeBytes: 100, fileCount: 1 }, b: { status: 'ready', sizeBytes: 200, fileCount: 2 } },
    }) },
    trashStore: { load: async () => ({ status: 'ready', records: new Map([['b', { snapshotId: 's2' }]]) }) },
    snapshotStore: { inventory: async () => ({ valid: [
      { snapshotId: 's1', sessionId: 'a', createdAt: '2026-08-20T00:00:00.000Z', totalBytes: 80, sessionBytes: 30, attachmentCount: 1, attachments: [{ sha256: 'x', bytes: 50 }] },
      { snapshotId: 's2', sessionId: 'b', createdAt: '2026-08-21T00:00:00.000Z', totalBytes: 90, sessionBytes: 40, attachmentCount: 1, attachments: [{ sha256: 'x', bytes: 50 }] },
    ], degraded: [] }) },
    now: () => new Date('2026-08-24T00:00:00.000Z'),
  });

  const result = await service.inspect();
  assert.deepEqual(result.summary, {
    sessionBytes: 300, snapshotBytes: 170, totalMeasuredBytes: 470,
    duplicateSnapshotBytes: 50, sessionUnavailableCount: 0, degradedSnapshotCount: 0,
  });
  assert.equal(result.snapshots.find((row) => row.snapshotId === 's2').active, true);
  assert.equal(JSON.stringify(result).includes('path'), false);
});
```

Add cases for unavailable session rows, degraded snapshots excluded from trusted totals, shared in-flight inspection, 30-second cache, and explicit invalidation. The production mutation caught is mixing session/snapshot ownership or overstating reclaimable repeated bytes.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/insights.test.mjs`

Expected: FAIL with module-not-found for `lib/insights.js`.

- [ ] **Step 3: Implement `createInsightsService`**

Create `lib/insights.js` with:

```js
export function createInsightsService({
  statsService, trashStore, snapshotStore, listSessions,
  now = () => new Date(), ttlMs = 30_000,
}) { /* inspect + invalidate */ }
```

Normalize server-owned session descriptors, measure unique IDs once, join rows without paths, mark active snapshots from ready trash records, and count digest occurrences by adding `bytes` for every occurrence after the first. Cache only a completed immutable clone, share one in-flight promise, and clear both on `invalidate()`.

If trash or snapshot authority is unavailable, throw a stable `InsightsError('insights-authority-unavailable', ..., 503)`. Individual session measurement failures remain unavailable rows.

- [ ] **Step 4: Run focused tests and refactor**

Run: `node --test test/insights.test.mjs test/stats.test.mjs test/snapshot.test.mjs`

Expected: PASS. Refactor repeated clone/finite-integer checks only after green.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`

Commit:

```bash
git add lib/insights.js lib/snapshot.js test/insights.test.mjs test/snapshot.test.mjs
git commit -m "feat: add archived storage insights"
```

---

### Task 3: Atomic retention policy store and pure planner

**Files:**
- Create: `lib/retention.js`
- Create: `test/retention.test.mjs`

**Interfaces:**
- Consumes: trusted insights inventory plus ready trash records.
- Produces: `DEFAULT_RETENTION_POLICY`, `normalizeRetentionPolicy(input)`, `createRetentionStore({ path })`, and `planRetention({ inventory, trashRecords, policy, now })`.

- [ ] **Step 1: Write failing policy-store tests**

Use a real temporary directory and assert literal defaults, mode-safe atomic persistence, corrupt-byte preservation, unsupported version failure, and concurrent save serialization:

```js
test('missing retention file loads conservative defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-retention-'));
  const store = createRetentionStore({ path: join(root, 'retention.json') });
  assert.deepEqual(await store.load(), {
    status: 'ready',
    policy: {
      historicalSnapshotsPerSession: 1,
      historicalSnapshotMaxAgeDays: null,
      snapshotQuotaBytes: null,
      recycleMaxAgeDays: null,
    },
  });
});
```

Add table cases for history `-1/21`, days `0/3651`, quota below `1 MiB` and above `8 TiB`, extra keys, unsafe keys, non-integers, and valid boundary values. The production mutation caught is accepting a policy that can silently broaden deletion scope.

- [ ] **Step 2: Run policy tests and verify RED**

Run: `node --test test/retention.test.mjs`

Expected: FAIL with module-not-found for `lib/retention.js`.

- [ ] **Step 3: Implement the policy normalizer and store**

Implement exact-key validation, structured cloning, canonical version-one documents, per-resolved-path promise queues, random exclusive temp names, `0700` directory mode, `0600` file mode, atomic rename, and cleanup of failed temps. The public store is:

```js
Object.freeze({
  load: async () => ({ status: 'ready' | 'unavailable', policy }),
  save: async (input) => normalizedPolicy,
});
```

Unavailable stores reject `save()` with `RetentionError('retention-store-unavailable', ..., 503)` and never replace source bytes.

- [ ] **Step 4: Write failing deterministic planner tests**

Add a literal inventory with active, historical, duplicate, degraded, old, and new items. Assert:

```js
assert.deepEqual(plan.candidates.map(({ key, action, reason }) => ({ key, action, reason })), [
  { key: 'snapshot:s-old-count', action: 'delete-snapshot', reason: 'history-count' },
  { key: 'snapshot:s-old-age', action: 'delete-snapshot', reason: 'snapshot-age' },
  { key: 'snapshot:s-old-quota', action: 'delete-snapshot', reason: 'snapshot-quota' },
  { key: 'trash:old-chat', action: 'purge-trash', reason: 'recycle-age' },
]);
```

Assert active and degraded snapshots and `purge-pending` trash never appear; null age/quota produces no candidates for those rules; candidate order is stable; `projectedSnapshotBytes` uses trusted totals only. The production mutation caught is choosing an active snapshot or using a client-controlled ordering.

- [ ] **Step 5: Implement and verify `planRetention`**

Implement count → age → quota ordering, first-reason retention, exact cutoff arithmetic in UTC milliseconds, and SHA-256 fingerprinting of normalized policy plus candidate identities/bytes/timestamps.

Run: `node --test test/retention.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run full suite and commit**

Run: `npm test`

Commit:

```bash
git add lib/retention.js test/retention.test.mjs
git commit -m "feat: add preview-first retention planning"
```

---

### Task 4: Single-use retention coordinator

**Files:**
- Create: `lib/retention-service.js`
- Create: `test/retention-service.test.mjs`

**Interfaces:**
- Consumes: `insightsService.inspect/invalidate`, `retentionStore.load/save`, `trashStore.load`, `snapshotStore.inventory/remove`, `recycleService.purge`, and shared `lifecycle.run`.
- Produces: `createRetentionService(...).get()`, `.savePolicy(input)`, `.preview()`, and `.apply({ token, nonce, keys })`.

- [ ] **Step 1: Write failing preview-token tests**

Use deterministic `now` and random-byte functions. Assert preview contains a token/nonce and candidates but no paths/content; expired, wrong-nonce, and reused tokens fail with stable 400/409 errors:

```js
const preview = await service.preview();
assert.deepEqual(preview.candidates.map((item) => item.key), ['snapshot:s1', 'trash:t1']);
assert.equal(typeof preview.token, 'string');
assert.equal(typeof preview.nonce, 'string');
await assert.rejects(
  service.apply({ token: preview.token, nonce: 'wrong', keys: [] }),
  (error) => error.code === 'retention-token-invalid' && error.status === 400,
);
```

The production mutation caught is accepting replayed or unauthenticated destructive plans.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/retention-service.test.mjs`

Expected: FAIL with module-not-found for `lib/retention-service.js`.

- [ ] **Step 3: Implement token lifecycle and policy reads/saves**

Create an in-memory `Map` whose entries contain expiry, nonce hash, fingerprint,
and candidate copies. Generate 32 random bytes for token and nonce, encode base64url,
store only a SHA-256 nonce digest, delete expired entries on preview/apply, and consume
the token before processing candidates. `savePolicy` only persists and invalidates;
it never previews or applies.

- [ ] **Step 4: Write failing stale revalidation and partial-apply tests**

Assert ordered subset processing, unknown keys rejected, snapshot identity/active-state rechecked inside `lifecycle.run`, successful snapshot removal, recycle delegation, stale candidate retention, and continued processing after one failure:

```js
const result = await service.apply({
  token: preview.token,
  nonce: preview.nonce,
  keys: ['snapshot:s1', 'trash:t1'],
});
assert.deepEqual(result.applied, [
  { key: 'snapshot:s1', action: 'delete-snapshot' },
  { key: 'trash:t1', action: 'purge-trash' },
]);
assert.deepEqual(removedSnapshots, ['s1']);
assert.deepEqual(purgeRequests, [['t1']]);
```

The production mutation caught is deleting directly from stale preview data.

- [ ] **Step 5: Implement sequential revalidation/application**

For every selected key, enter `lifecycle.run`, reload ready trash authority and
fresh snapshot inventory, compare identity/session/time/bytes, reject newly active
snapshots, then remove or delegate. Preserve first-seen key order, return stable
failures, invalidate insights after successes, and refresh `get()` summaries.

Run: `node --test test/retention-service.test.mjs test/retention.test.mjs test/insights.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run full suite and commit**

Run: `npm test`

Commit:

```bash
git add lib/retention-service.js test/retention-service.test.mjs
git commit -m "feat: apply retention previews safely"
```

---

### Task 5: Bounded session-lineage projector

**Files:**
- Create: `lib/lineage.js`
- Create: `test/lineage.test.mjs`

**Interfaces:**
- Consumes: durable Harness header fields plus server-owned archive/trash/workspace/title maps.
- Produces: `projectLineage({ headers, archivedIds, trashRecords, workspaces, titles, maxNodes })` returning `{ roots, diagnostics, nodeCount }`.

- [ ] **Step 1: Write failing forest-projection tests**

Create literal headers for a root, ordinary fork, nested subagent, missing parent,
self-parent, two-node cycle, and depth mismatch. Assert exact root/child IDs,
status precedence, synthetic missing nodes, sorting, and diagnostic codes:

```js
const graph = projectLineage({
  headers: [
    { id: 'root', createdAt: 1 },
    { id: 'fork', createdAt: 2, parentSession: 'root', seedLength: 4 },
    { id: 'agent', createdAt: 3, parentSession: 'fork', origin: 'subagent', delegationDepth: 1 },
    { id: 'orphan', createdAt: 4, parentSession: 'missing' },
  ],
  archivedIds: ['fork'],
  trashRecords: new Map([['agent', { sessionId: 'agent' }]]),
  workspaces: [],
  titles: new Map([['root', 'Root']]),
});
assert.deepEqual(graph.roots.map((node) => node.id), ['root', 'missing']);
assert.equal(graph.roots[0].children[0].status, 'archived');
assert.equal(graph.roots[0].children[0].children[0].status, 'trash');
assert.deepEqual(graph.diagnostics, [{ code: 'missing-parent', sessionId: 'orphan', relatedId: 'missing' }]);
```

The production mutation caught is inferring edges from origin/depth or looping on malformed headers.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/lineage.test.mjs`

Expected: FAIL with module-not-found for `lib/lineage.js`.

- [ ] **Step 3: Implement normalization, diagnostics, and deterministic forest construction**

Validate unique non-empty IDs and safe integers, cap real headers at 5,000 with
`LineageError('lineage-limit-exceeded', ..., 413)`, create missing placeholders,
classify status `trash > archived > active`, detect self/cycles before linking,
detach cycle members as roots, diagnose delegation depth against a valid parent,
and recursively clone/sort without mutable aliases. Strip paths, notes, tags,
events, and attachment fields.

- [ ] **Step 4: Add privacy and cap cases, then verify GREEN**

Assert 5,001 headers fail without a partial result and serialized output contains
none of `cwd`, `path`, `events`, `note`, `tags`, or `attachments`.

Run: `node --test test/lineage.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`

Commit:

```bash
git add lib/lineage.js test/lineage.test.mjs
git commit -m "feat: project archived session lineage"
```

---

### Task 6: Host composition, guarded routes, and public types

**Files:**
- Modify: `lib/index.js`
- Modify: `lib/types/index.d.ts`
- Modify: `lib/types/client/index.d.ts`
- Modify: `test/smoke.test.mjs`
- Modify: `test/package.test.mjs`

**Interfaces:**
- Consumes: services from Tasks 1–5.
- Produces: five routes: `GET /insights`, `POST /retention/policy`, `POST /retention/preview`, `POST /retention/apply`, and `GET /lineage`.

- [ ] **Step 1: Write failing route-registration and authorization tests**

Update the smoke fixture to expect 22 registered routes. Add method/guard/body-bound tests:

```js
assert(routes.has('/plugins/dsh-archived-chats/insights'), 'insights route registered');
assert(routes.has('/plugins/dsh-archived-chats/retention/policy'), 'retention policy route registered');
assert(routes.has('/plugins/dsh-archived-chats/retention/preview'), 'retention preview route registered');
assert(routes.has('/plugins/dsh-archived-chats/retention/apply'), 'retention apply route registered');
assert(routes.has('/plugins/dsh-archived-chats/lineage'), 'lineage route registered');
```

Assert GET mutators return 405, missing guard returns 403, malformed/oversized JSON
returns 400/413, insight/lineage responses omit paths, and service errors expose only
stable `error` codes. The production mutation caught is registering an unguarded mutator.

- [ ] **Step 2: Run smoke test and verify RED**

Run: `node --test test/smoke.test.mjs`

Expected: FAIL because only 17 routes exist.

- [ ] **Step 3: Compose stores/services and routes**

Add `retention.json` under the existing plugin-data root, construct services once
per plugin activation, and provide a server-owned inventory session descriptor
callback. The callback includes all archived IDs including trash records, resolves
safe titles/workspace IDs/titles, and never returns paths to `InsightsService`.

Register thin routes using existing `guard`, `readBody`, `send`, `no-store`, and
error mapping patterns. `GET /lineage` uses `persistence.list()`, registry archive
membership, ready trash records, workspace accounting, and title cache; it never
bulk-inspects active transcripts. Route disposal remains owned by `ctx.effect`.

Invalidate insights from recycle move/restore/purge and successful retention apply.

- [ ] **Step 4: Extend public declarations and package coverage**

Declare exact `StorageInsights`, `RetentionPolicy`, `RetentionCandidate`,
`LineageNode`, and `LineageDiagnostic` response types without paths or payloads.
Update the package test to require `lib/insights.js`, `lib/retention.js`,
`lib/retention-service.js`, and `lib/lineage.js`.

Run: `node --test test/smoke.test.mjs test/package.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`

Commit:

```bash
git add lib/index.js lib/types/index.d.ts lib/types/client/index.d.ts test/smoke.test.mjs test/package.test.mjs
git commit -m "feat: expose storage retention and lineage APIs"
```

---

### Task 7: Storage & Retention client tab

**Files:**
- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: Task 6 routes.
- Produces: lazy **Storage & Retention** tab, policy editor, preview dialog, and explicit apply confirmations in English/Chinese.

- [ ] **Step 1: Write failing client request/model tests**

Extend the client test surface with guarded `saveRetentionPolicy`,
`previewRetention`, and `applyRetention`, plus uncached `fetchInsights`. Assert exact
paths, methods, headers, bounded bodies, unique ordered keys, and cancellation:

```js
assert.equal(fetchCalls[0].url, '/plugins/dsh-archived-chats/insights');
assert.deepEqual(JSON.parse(fetchCalls[1].options.body), {
  historicalSnapshotsPerSession: 1,
  historicalSnapshotMaxAgeDays: null,
  snapshotQuotaBytes: null,
  recycleMaxAgeDays: null,
});
```

Add pure model assertions for formatted totals, unavailable/degraded states,
candidate grouping, projected bytes, and default selection: every
`delete-snapshot` selected, every `purge-trash` unselected. The production mutation
caught is silently preselecting permanent chat purges.

- [ ] **Step 2: Run smoke test and verify RED**

Run: `node --test test/smoke.test.mjs`

Expected: FAIL because the third tab/helpers do not exist.

- [ ] **Step 3: Implement lazy tab state and dashboard**

Add localized strings, token-based CSS, and a third tab. Fetch insights only on
first activation; abort requests on unmount/newer request. Render five summary
cards and grouped safe rows without paths. Policy inputs expose exact bounds,
blank values serialize to `null`, saving never calls preview/apply, and unhealthy
authorities disable mutations while leaving archive/recycle tabs functional.

- [ ] **Step 4: Implement accessible preview and apply flow from failing UI tests**

Add tests for labelled dialog, focus trap/Escape isolation/focus restoration,
candidate selection defaults, separate snapshot/recycle sections, projected
reclaim, ordinary snapshot-only confirmation, destructive mixed confirmation,
single-submit busy state, partial results, token expiry, and refresh after apply.

Implement the minimal React tree that passes those behaviors. Reuse the existing
confirmation primitives and semantic danger tokens; do not add a second dialog
framework.

Run: `node --test test/smoke.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`

Commit:

```bash
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: add storage and retention controls"
```

---

### Task 8: Session Lineage client tab

**Files:**
- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: `GET /lineage` from Task 6.
- Produces: lazy accessible lineage tree with search, collapse state, status badges, and diagnostics.

- [ ] **Step 1: Write failing lineage request and tree-model tests**

Assert one lazy uncached request, abort lifecycle, ancestor-preserving title/ID
search, deterministic flattening, independent collapse state, and status labels:

```js
const visible = filterLineageForest(roots, 'grandchild');
assert.deepEqual(visible.map((node) => node.id), ['root', 'child', 'grandchild']);
```

The production mutation caught is hiding a matching descendant because its
ancestor did not match the query.

- [ ] **Step 2: Run smoke test and verify RED**

Run: `node --test test/smoke.test.mjs`

Expected: FAIL because lineage helpers/tab are absent.

- [ ] **Step 3: Implement the lazy fourth tab and accessible tree**

Render `role="tree"`/`role="treeitem"` with `aria-level`, `aria-expanded`, and
keyboard-operable expand buttons. Show title or ID, status, origin, delegation
depth, created time, and child count. Search retains ancestor context. Missing
nodes and diagnostics use warning tokens, not destructive action styling.

Do not add edit, repair, restore-tree, or fork actions.

- [ ] **Step 4: Add error/privacy/responsive cases and verify GREEN**

Assert loading/error/empty/cap errors, no path/body/attachment rendering, narrow
row wrapping, dark/light token use, and request cancellation on unmount.

Run: `node --test test/smoke.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`

Commit:

```bash
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: add session lineage view"
```

---

### Task 9: Version, documentation, isolated browser verification, and release candidate

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `lib/index.js`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE.en.md`
- Modify: `lib/types/index.d.ts`
- Modify: `lib/types/client/index.d.ts`
- Modify: `test/package.test.mjs`
- Add after real-host capture: `assets/screenshots/10-storage-retention.png`
- Add after real-host capture: `assets/screenshots/11-session-lineage.png`

**Interfaces:**
- Consumes: completed Tasks 1–8.
- Produces: installable `0.12.0` release candidate with synchronized public documentation and verified real-host UI.

- [ ] **Step 1: Write failing package-version/content assertions**

Update `test/package.test.mjs` to expect package version `0.12.0`, `PLUGIN_VERSION`
behavior where surfaced, the four new runtime modules, and exclusion of
`retention.json`, trash/snapshot contents, tokens, worktrees, and temporary data.

Run: `node --test test/package.test.mjs`

Expected: FAIL while package metadata is still `0.11.0`.

- [ ] **Step 2: Update version and public documentation**

Run `npm version 0.12.0 --no-git-tag-version`, set `PLUGIN_VERSION = '0.12.0'`,
and update Chinese/English README and architecture docs with:

- separate session/snapshot accounting and duplicate-byte meaning;
- exact policy defaults and preview/application flow;
- no background cleanup and no preselected recycle purge;
- multi-snapshot downgrade warning;
- global attachment-GC limitation;
- read-only lineage diagnostics and 5,000-node cap;
- installation/update command, compatibility, local paths, privacy, and 0.12.0 changelog.

Update declarations to mirror actual responses and remove stale 0.11-only comments.

- [ ] **Step 3: Run automated release-candidate verification**

Run:

```bash
npm test
npm pack --dry-run --json
git diff --check
```

Expected: all tests pass, pack lists runtime/docs/types/screenshots and excludes
local stores, fixtures, logs, worktrees, and temporary files.

- [ ] **Step 4: Verify in an isolated real Harness host**

Create a temporary `DSH_HOME`, install the worktree package into an isolated web
profile, use only synthetic sessions, and verify:

1. archived/recycle totals and duplicate bytes;
2. save policy causes no deletion;
3. cleanup preview candidate ordering/default selection;
4. stale preview rejection;
5. snapshot-only cleanup;
6. explicitly selected recycle purge through `purge-pending`;
7. lineage roots/forks/subagents/missing-parent diagnostics;
8. English/Chinese, light/dark, narrow layout, focus, Escape, and request aborts.

Never point the profile at the user's real DSH home. Remove the temporary home
after capture. Save only the two representative PNG screenshots named above.

- [ ] **Step 5: Re-run verification after screenshots and commit**

Run:

```bash
npm test
npm pack --dry-run --json
git diff --check
git status --short
```

Commit:

```bash
git add package.json package-lock.json lib/index.js lib/types/index.d.ts lib/types/client/index.d.ts README.md README.en.md docs/ARCHITECTURE.md docs/ARCHITECTURE.en.md test/package.test.mjs assets/screenshots/10-storage-retention.png assets/screenshots/11-session-lineage.png
git commit -m "release: prepare dsh-archived-chats 0.12.0"
```

---

## Final verification checklist

- [ ] Every new production branch was introduced by an observed failing test.
- [ ] Snapshot inventory never accumulates or exposes attachment payloads.
- [ ] Space totals distinguish session bytes and plugin-owned snapshot bytes.
- [ ] Policy save never applies; preview/apply uses single-use five-minute tokens.
- [ ] Active/degraded/stale snapshots and purge-pending trash are excluded.
- [ ] Recycle purges delegate to the existing transaction and recover at startup.
- [ ] Lineage uses only `parentSession` edges and never writes headers.
- [ ] Browser responses/logs contain no paths, content, names, bytes, or tokens beyond the active preview response.
- [ ] Full tests and dry-run package pass on the final tree.
- [ ] Real-host verification uses an isolated temporary DSH home only.
