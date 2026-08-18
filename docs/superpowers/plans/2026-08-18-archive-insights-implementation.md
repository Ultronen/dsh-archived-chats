# Archive Insights 0.6.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable tags and notes plus non-blocking per-session and aggregate storage statistics to the archived chats settings module.

**Architecture:** Keep `lib/index.js` as the Harness service/HTTP composition boundary and add two dependency-free domain modules: `lib/metadata.js` for a versioned atomic JSON store and `lib/stats.js` for bounded-concurrency directory measurement with a disposable cache. The existing client bundle consumes metadata from `/state`, statistics from `/stats`, and saves metadata through a guarded `/metadata` route without changing archive lifecycle semantics.

**Tech Stack:** Node.js ESM, `node:fs/promises`, React 18 through the Harness client module loader, DeepSeek Harness rc.7 slots/design tokens, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-18-archive-insights-design.md`

## Global Constraints

- Target package version is `0.6.0` and compatibility baseline is DeepSeek Harness `0.1.0-rc.7`.
- Add no runtime dependency, database, scheduled work, export path, transcript search, or cloud synchronization.
- Metadata lives only at `$DSH_HOME/plugin-data/archived-chats/metadata.json` with schema version `1`.
- Tags: maximum 8, trimmed, non-empty, maximum 24 Unicode code points, case-insensitive de-duplication preserving first spelling.
- Notes: preserve internal newlines, trim surrounding whitespace, maximum 2,000 Unicode code points.
- Unarchive retains metadata; completed physical deletion attempts cleanup; deferred/failed deletion retains metadata.
- Metadata or statistics failure must never disable listing, unarchive, or physical deletion.
- Statistics skip symbolic links, scan at concurrency 4, and cache for 30 seconds.
- Continue using `settings.section`; do not use `settings.plugin.item`.
- Do not modify or stage the repository's untracked `data/` directory.

## File Structure

- Create `lib/metadata.js`: metadata normalization, schema parsing, atomic serialized store.
- Create `lib/stats.js`: safe directory measurement, bounded concurrency, cache, summary aggregation.
- Modify `lib/index.js`: compose stores, join metadata, expose metadata/stats routes, order delete cleanup.
- Modify `lib/client.js`: client models, summary strip, tag filter/chips, size labels, metadata editor.
- Create `test/metadata.test.mjs`: direct metadata module tests with isolated real files.
- Create `test/stats.test.mjs`: direct statistics module tests with isolated directory trees.
- Modify `test/smoke.test.mjs`: host route/lifecycle and client integration regression coverage.
- Modify `package.json`: test glob, runtime file allowlist, version, and description.
- Modify `README.md` and `README.zh.md`: features, storage location, compatibility, and privacy behavior.

---

### Task 1: Versioned Metadata Store

**Files:**
- Create: `lib/metadata.js`
- Create: `test/metadata.test.mjs`
- Modify: `package.json:24-25,39-44`

**Interfaces:**
- Consumes: an explicit `filePath`, optional `now(): Date`, and Node filesystem primitives.
- Produces: `MetadataStoreError`, `normalizeMetadata(input)`, and `createMetadataStore({ filePath, now })` with `getMany(ids)`, `set(id, input)`, and `remove(ids)`.

- [ ] **Step 1: Change the test script and write the first failing normalization tests**

Change the script to run every test file:

```json
"test": "node --test test/*.test.mjs"
```

Create `test/metadata.test.mjs` with direct behavior assertions:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MetadataStoreError,
  createMetadataStore,
  normalizeMetadata,
} from '../lib/metadata.js';

test('normalizeMetadata trims, de-duplicates, and preserves the first tag spelling', () => {
  assert.deepEqual(normalizeMetadata({
    tags: [' Important ', 'important', '研究'],
    note: '  first line\nsecond line  ',
  }), {
    tags: ['Important', '研究'],
    note: 'first line\nsecond line',
  });
});

test('normalizeMetadata enforces tag and note limits in Unicode code points', () => {
  assert.throws(() => normalizeMetadata({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`), note: '' }),
    (error) => error instanceof MetadataStoreError && error.code === 'too-many-tags');
  assert.throws(() => normalizeMetadata({ tags: ['界'.repeat(25)], note: '' }),
    (error) => error instanceof MetadataStoreError && error.code === 'tag-too-long');
  assert.throws(() => normalizeMetadata({ tags: [], note: '界'.repeat(2001) }),
    (error) => error instanceof MetadataStoreError && error.code === 'note-too-long');
});
```

- [ ] **Step 2: Run the metadata test and verify RED**

Run:

```bash
node --test test/metadata.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/metadata.js`.

- [ ] **Step 3: Implement validation and public error codes**

Create the validation surface in `lib/metadata.js`:

```js
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 1;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_NOTE_LENGTH = 2000;

export class MetadataStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MetadataStoreError';
    this.code = code;
    this.status = status;
  }
}

const codePointLength = (value) => Array.from(value).length;

export function normalizeMetadata(input) {
  if (!Array.isArray(input?.tags) || typeof input?.note !== 'string') {
    throw new MetadataStoreError('metadata-invalid', 'tags must be an array and note must be a string');
  }
  if (input.tags.length > MAX_TAGS) {
    throw new MetadataStoreError('too-many-tags', `at most ${MAX_TAGS} tags are allowed`);
  }
  const tags = [];
  const seen = new Set();
  for (const raw of input.tags) {
    if (typeof raw !== 'string') throw new MetadataStoreError('tag-invalid', 'every tag must be a string');
    const tag = raw.trim();
    if (tag === '') throw new MetadataStoreError('tag-empty', 'tags cannot be empty');
    if (codePointLength(tag) > MAX_TAG_LENGTH) throw new MetadataStoreError('tag-too-long', `tags are limited to ${MAX_TAG_LENGTH} characters`);
    const key = tag.toLocaleLowerCase('en-US');
    if (!seen.has(key)) { seen.add(key); tags.push(tag); }
  }
  const note = input.note.trim();
  if (codePointLength(note) > MAX_NOTE_LENGTH) throw new MetadataStoreError('note-too-long', `notes are limited to ${MAX_NOTE_LENGTH} characters`);
  return { tags, note };
}
```

- [ ] **Step 4: Run the normalization tests and verify GREEN**

Run `node --test test/metadata.test.mjs`.

Expected: both normalization tests PASS.

- [ ] **Step 5: Add failing store lifecycle, corruption, and concurrency tests**

Append tests that use a new temporary path per case:

```js
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dac-metadata-'));
  return { root, filePath: join(root, 'metadata.json') };
}

test('metadata store persists canonical entries and removes empty entries', async () => {
  const { filePath } = await fixture();
  const store = createMetadataStore({ filePath, now: () => new Date('2026-08-18T12:00:00.000Z') });
  const saved = await store.set('session-a', { tags: [' Important '], note: ' note ' });
  assert.deepEqual(saved, { tags: ['Important'], note: 'note', updatedAt: '2026-08-18T12:00:00.000Z' });
  assert.deepEqual(await store.getMany(['session-a']), { status: 'ready', entries: { 'session-a': saved } });
  assert.equal(await store.set('session-a', { tags: [], note: '' }), null);
  assert.deepEqual((await store.getMany(['session-a'])).entries, {});
});

test('unreadable metadata remains untouched and rejects mutations', async () => {
  const { filePath } = await fixture();
  await writeFile(filePath, '{broken', 'utf8');
  const store = createMetadataStore({ filePath });
  assert.deepEqual(await store.getMany(['session-a']), { status: 'unavailable', entries: {} });
  await assert.rejects(store.set('session-a', { tags: [], note: 'x' }),
    (error) => error.code === 'metadata-store-unavailable' && error.status === 503);
  assert.equal(await readFile(filePath, 'utf8'), '{broken');
});

test('unsupported versions and malformed session entries make the store unavailable', async () => {
  const { filePath } = await fixture();
  const store = createMetadataStore({ filePath });
  await writeFile(filePath, JSON.stringify({ version: 2, sessions: {} }), 'utf8');
  assert.equal((await store.getMany(['session-a'])).status, 'unavailable');
  await writeFile(filePath, JSON.stringify({
    version: 1,
    sessions: { 'session-a': { tags: 'not-an-array', note: '', updatedAt: '2026-08-18T12:00:00.000Z' } },
  }), 'utf8');
  assert.equal((await store.getMany(['session-a'])).status, 'unavailable');
});

test('concurrent saves serialize without dropping sessions', async () => {
  const { filePath } = await fixture();
  const store = createMetadataStore({ filePath });
  await Promise.all([
    store.set('session-a', { tags: ['a'], note: '' }),
    store.set('session-b', { tags: ['b'], note: '' }),
  ]);
  const result = await store.getMany(['session-a', 'session-b']);
  assert.deepEqual(Object.keys(result.entries).sort(), ['session-a', 'session-b']);
});
```

- [ ] **Step 6: Run the store tests and verify RED**

Run `node --test test/metadata.test.mjs`.

Expected: normalization passes; store tests FAIL because `createMetadataStore` is not exported.

- [ ] **Step 7: Implement schema parsing and atomic serialized mutations**

Implement `createMetadataStore` with these exact semantics:

```js
function emptyDocument() { return { version: VERSION, sessions: {} }; }

function parseStoredEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MetadataStoreError('metadata-store-unavailable', 'metadata entry is invalid', 503);
  }
  const normalized = normalizeMetadata({ tags: value.tags, note: value.note });
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new MetadataStoreError('metadata-store-unavailable', 'metadata timestamp is invalid', 503);
  }
  return { ...normalized, updatedAt: value.updatedAt };
}

function parseDocument(text) {
  const value = JSON.parse(text);
  if (value?.version !== VERSION || value.sessions === null || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) {
    throw new MetadataStoreError('metadata-store-unavailable', 'metadata schema is unsupported', 503);
  }
  const sessions = {};
  for (const [id, entry] of Object.entries(value.sessions)) {
    if (id.trim() === '') throw new MetadataStoreError('metadata-store-unavailable', 'metadata session id is invalid', 503);
    sessions[id] = parseStoredEntry(entry);
  }
  return { version: VERSION, sessions };
}

export function createMetadataStore({ filePath, now = () => new Date() }) {
  let writeQueue = Promise.resolve();

  async function load() {
    try { return { status: 'ready', document: parseDocument(await readFile(filePath, 'utf8')) }; }
    catch (error) {
      if (error?.code === 'ENOENT') return { status: 'ready', document: emptyDocument() };
      return { status: 'unavailable', document: emptyDocument() };
    }
  }

  async function save(document) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  }

  function mutate(operation) {
    const result = writeQueue.then(async () => {
      const loaded = await load();
      if (loaded.status !== 'ready') throw new MetadataStoreError('metadata-store-unavailable', 'metadata store is unreadable', 503);
      return operation(loaded.document);
    });
    writeQueue = result.catch(() => undefined);
    return result;
  }

  return {
    async getMany(ids) {
      const loaded = await load();
      if (loaded.status !== 'ready') return { status: 'unavailable', entries: {} };
      const entries = {};
      for (const id of ids.map(String)) if (loaded.document.sessions[id] !== undefined) entries[id] = loaded.document.sessions[id];
      return { status: 'ready', entries };
    },
    set(id, input) {
      return mutate(async (document) => {
        const normalized = normalizeMetadata(input);
        if (normalized.tags.length === 0 && normalized.note === '') {
          delete document.sessions[String(id)];
          await save(document);
          return null;
        }
        const entry = { ...normalized, updatedAt: now().toISOString() };
        document.sessions[String(id)] = entry;
        await save(document);
        return entry;
      });
    },
    remove(ids) {
      return mutate(async (document) => {
        let changed = false;
        for (const id of ids.map(String)) if (delete document.sessions[id]) changed = true;
        if (changed) await save(document);
      });
    },
  };
}
```

- [ ] **Step 8: Verify Task 1 and commit**

Run:

```bash
npm test
node --check lib/metadata.js
git diff --check
```

Expected: all tests PASS and checks exit 0.

Commit:

```bash
git add package.json lib/metadata.js test/metadata.test.mjs
git commit -m "feat: add archive metadata store"
```

---

### Task 2: Safe Storage Statistics Service

**Files:**
- Create: `lib/stats.js`
- Create: `test/stats.test.mjs`

**Interfaces:**
- Consumes: Harness `persistence.list()` and `persistence.locate(header)` plus optional `now`, `ttlMs`, `concurrency`, and `measure` dependencies.
- Produces: `measureDirectory(directoryPath)` and `createStatsService({ persistence, now, ttlMs, concurrency, measure })` with `measure(ids)` and `invalidate(ids)`.

- [ ] **Step 1: Write failing filesystem measurement tests**

Create `test/stats.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatsService, measureDirectory } from '../lib/stats.js';

test('measureDirectory totals nested regular files and skips symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dac-stats-'));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'a'), '1234');
  await writeFile(join(root, 'nested', 'b'), '12');
  await symlink(join(root, 'a'), join(root, 'link'));
  assert.deepEqual(await measureDirectory(root), { sizeBytes: 6, fileCount: 2, status: 'ready' });
});
```

- [ ] **Step 2: Run the stats test and verify RED**

Run `node --test test/stats.test.mjs`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/stats.js`.

- [ ] **Step 3: Implement non-following directory measurement**

Create `lib/stats.js` using `readdir(path, { withFileTypes: true })` and `lstat` only for regular files. Recurse only when `entry.isDirectory()` is true; skip `entry.isSymbolicLink()` entirely. Return `{ sizeBytes: null, fileCount: null, status: 'unavailable' }` from the service, not from `measureDirectory`, when measurement throws.

Core implementation:

```js
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function measureDirectory(root) {
  let sizeBytes = 0;
  let fileCount = 0;
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(child); continue; }
      if (!entry.isFile()) continue;
      const info = await lstat(child);
      sizeBytes += info.size;
      fileCount += 1;
    }
  }
  await visit(root);
  return { sizeBytes, fileCount, status: 'ready' };
}
```

- [ ] **Step 4: Add failing service tests for summary, cache, unavailable rows, and concurrency**

Use headers whose located file paths point into real temp directories, plus an injected `measure` that tracks active calls. Assert:

```js
assert.deepEqual(result.summary, { sessionCount: 3, totalBytes: 30, unavailableCount: 1 });
assert.deepEqual(result.sessions.missing, { sizeBytes: null, fileCount: null, status: 'unavailable' });
assert.equal(maxActive <= 4, true);
assert.equal(callsAfterSecondMeasure, callsAfterFirstMeasure);
service.invalidate(['session-a']);
assert.equal(callsAfterInvalidation, callsAfterFirstMeasure + 1);
```

- [ ] **Step 5: Run service tests and verify RED**

Run `node --test test/stats.test.mjs`.

Expected: directory test passes; service tests FAIL because `createStatsService` is missing.

- [ ] **Step 6: Implement bounded concurrency, cache, and aggregation**

Implement a worker-index loop so no more than `concurrency` promises measure simultaneously. Cache `{ expiresAt, result }` by session ID for `ttlMs`. Resolve a header from `await persistence.list()`, then use `dirname(persistence.locate(header).path)`.

Use this service implementation:

```js
const unavailable = () => ({ sizeBytes: null, fileCount: null, status: 'unavailable' });

export function createStatsService({
  persistence,
  now = () => Date.now(),
  ttlMs = 30000,
  concurrency = 4,
  measure = measureDirectory,
}) {
  const cache = new Map();

  async function mapWithConcurrency(items, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    async function run() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]);
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => run()));
    return results;
  }

  async function measureOne(id, headerById) {
    const cached = cache.get(id);
    if (cached !== undefined && cached.expiresAt > now()) return cached.result;
    let result;
    try {
      const header = headerById.get(id);
      if (header === undefined || typeof persistence.locate !== 'function') throw new Error('session location unavailable');
      const location = await persistence.locate(header);
      if (typeof location?.path !== 'string') throw new Error('session path unavailable');
      result = await measure(dirname(location.path));
      if (result?.status !== 'ready' || !Number.isFinite(result.sizeBytes) || !Number.isFinite(result.fileCount)) {
        throw new Error('invalid measurement');
      }
    } catch {
      result = unavailable();
    }
    cache.set(id, { expiresAt: now() + ttlMs, result });
    return result;
  }

  return {
    async measure(ids) {
      const normalizedIds = [...new Set(ids.map(String))];
      const headerById = new Map();
      try {
        for (const header of await persistence.list()) headerById.set(String(header.id), header);
      } catch {
        // An unavailable header index becomes unavailable rows, not a failed response.
      }
      const rows = await mapWithConcurrency(normalizedIds, (id) => measureOne(id, headerById));
      const sessions = Object.fromEntries(normalizedIds.map((id, index) => [id, rows[index]]));
      return {
        summary: {
          sessionCount: normalizedIds.length,
          totalBytes: rows.reduce((total, row) => total + (row.status === 'ready' ? row.sizeBytes : 0), 0),
          unavailableCount: rows.filter((row) => row.status === 'unavailable').length,
        },
        sessions,
      };
    },
    invalidate(ids) { for (const id of ids.map(String)) cache.delete(id); },
  };
}
```

The de-duplicated ID list defines `sessionCount`; `totalBytes` sums only ready rows, and `unavailableCount` counts unavailable rows. A missing `persistence.locate`, a failed header listing, a missing header, or a per-directory error produces unavailable rows without rejecting the request.

- [ ] **Step 7: Verify Task 2 and commit**

Run:

```bash
npm test
node --check lib/stats.js
git diff --check
```

Commit:

```bash
git add lib/stats.js test/stats.test.mjs
git commit -m "feat: measure archived session storage"
```

---

### Task 3: Host Metadata State and Mutation Route

**Files:**
- Modify: `lib/index.js:61-70,190-230,410-470,515-540`
- Modify: `test/smoke.test.mjs:1-185`

**Interfaces:**
- Consumes: `createMetadataStore`, `MetadataStoreError`, and the existing registry/persistence services.
- Produces: `/state` rows with metadata, top-level `metadataStatus`, and guarded `POST /metadata`.

- [ ] **Step 1: Write failing host assertions**

Seed `metadata.json` inside isolated `testHome` before route registration, then change route expectations from five to six and assert:

```js
assert(routes.size === 6, `six routes registered (got ${routes.size})`);
assert(routes.has('/plugins/dsh-archived-chats/metadata'), 'metadata route registered');

const state = (await call(routes, '/plugins/dsh-archived-chats/state', mockReq('GET', {}))).json();
assert(state.metadataStatus === 'ready', 'state reports ready metadata');
assert.deepEqual(state.sessions.find((row) => row.id === 'session-a').tags, ['important']);
assert(state.sessions.find((row) => row.id === 'session-a').note === 'keep this');

const saved = await call(routes, '/plugins/dsh-archived-chats/metadata', mockReq(
  'POST',
  { 'x-dsh-archived-chats': '1' },
  JSON.stringify({ sessionId: 'session-a', tags: [' Updated '], note: ' note ' }),
));
assert(saved.status === 200, `metadata save answers 200 (got ${saved.status})`);
assert.deepEqual(saved.json().metadata.tags, ['Updated']);
```

Also assert guard 403, invalid 400, unarchived ID 404, and a corrupt metadata file producing `/state` 200 with `metadataStatus: 'unavailable'` while POST returns 503.

- [ ] **Step 2: Run smoke test and verify RED**

Run `node --test test/smoke.test.mjs`.

Expected: FAIL at route count, metadata route, and state metadata assertions.

- [ ] **Step 3: Compose the metadata store and join state**

Import `createMetadataStore` and construct it once in `apply` using:

```js
const metadataPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'archived-chats', 'metadata.json');
const metadataStore = createMetadataStore({ filePath: metadataPath });
```

Change `listArchived` to read metadata once for visible IDs and return:

```js
return {
  metadataStatus: metadata.status,
  sessions: visibleRows.map((row) => {
    const entry = metadata.entries[row.id];
    return {
      ...row,
      tags: entry?.tags ?? [],
      note: entry?.note ?? '',
      metadataUpdatedAt: entry?.updatedAt ?? null,
    };
  }),
};
```

Update `/state` to send that object directly.

- [ ] **Step 4: Register guarded metadata mutation**

Validate `sessionId`, ensure `registry.archivedSessionIds.map(String).includes(sessionId)`, call `metadataStore.set`, and return:

```js
send(res, 200, { ok: true, metadata: entry ?? { tags: [], note: '', updatedAt: null } });
```

Map `MetadataStoreError.status/code` directly, 404 to `session-not-archived`, and unexpected errors to `metadata-save-failed`. Never log tags or notes.

- [ ] **Step 5: Verify Task 3 and commit**

Run `npm test`, `node --check lib/index.js`, and `git diff --check`.

Commit:

```bash
git add lib/index.js test/smoke.test.mjs
git commit -m "feat: expose archived session metadata"
```

---

### Task 4: Host Statistics Route and Delete Cleanup Ordering

**Files:**
- Modify: `lib/index.js:320-410,410-515,515-540`
- Modify: `test/smoke.test.mjs:140-325`

**Interfaces:**
- Consumes: `createStatsService`, metadata store, visible archived IDs, existing pending-delete store.
- Produces: `GET /stats`, statistics invalidation, best-effort metadata cleanup after physical deletion.

- [ ] **Step 1: Write failing route and lifecycle assertions**

Expect seven routes and call `/stats`:

```js
assert(routes.size === 7, `seven routes registered (got ${routes.size})`);
const stats = await call(routes, '/plugins/dsh-archived-chats/stats', mockReq('GET', {}));
assert(stats.status === 200, `stats answers 200 (got ${stats.status})`);
assert(stats.json().summary.sessionCount === 3, 'stats count visible archived sessions');
assert(stats.json().sessions['session-a'].sizeBytes === 4, 'stats report fixture bytes');
```

Add metadata before a parked delete and assert it remains. Add metadata before a cold delete and assert it is removed. Corrupt `metadata.json`, delete a cold session, and assert the delete response still reports it in `deleted`.

- [ ] **Step 2: Run smoke test and verify RED**

Run `node --test test/smoke.test.mjs`.

Expected: FAIL because `/stats` is absent and delete does not clean metadata/cache.

- [ ] **Step 3: Compose and expose statistics**

Construct once:

```js
const statsService = createStatsService({ persistence });
```

In `/stats`, compute visible IDs as `registry.archivedSessionIds` minus `await loadPending()`, call `statsService.measure(visibleIds)`, and send 200. On an unexpected top-level failure send 500 `{ error: 'stats-failed' }`; per-session failures remain 200/unavailable inside the service.

- [ ] **Step 4: Order post-delete auxiliary cleanup safely**

After physical directory removal and registry index cleanup:

```js
statsService.invalidate([id]);
try { await metadataStore.remove([id]); }
catch (error) { ctx.logger.warn(`archived-chats: metadata cleanup for ${id} failed: ${String(error?.code ?? error)}`); }
```

Pass both services through `deleteSession`, `sweepPendingDeletions`, and `registerRoutes`. Do not run either cleanup on a `pending` or failed outcome.

- [ ] **Step 5: Verify Task 4 and commit**

Run `npm test`, all three `node --check` commands, and `git diff --check`.

Commit:

```bash
git add lib/index.js test/smoke.test.mjs
git commit -m "feat: add archive storage statistics"
```

---

### Task 5: Client Archive Insights Experience

**Files:**
- Modify: `lib/client.js:26-145,180-218,220-303,383-400,470-670,670-1035`
- Modify: `test/smoke.test.mjs:327-670`

**Interfaces:**
- Consumes: `/state` metadata fields/status, `/stats` response, guarded `/metadata` response.
- Produces: `formatBytes`, `matchesArchivedSession`, `filterByTag`, summary strip, row insights, metadata editor, resilient loading/error states.

- [ ] **Step 1: Write failing pure client-model tests**

Extend `exports.__test` expectations with wished-for helpers:

```js
assert(clientExports.__test.formatBytes(0) === '0 B', 'formats zero bytes');
assert(clientExports.__test.formatBytes(1536) === '1.5 KB', 'formats binary kilobytes');
assert(clientExports.__test.matchesArchivedSession(
  { title: 'Alpha', workspaceTitle: '项目', tags: ['Research'], note: 'follow up' },
  'follow',
  'en-US',
) === true, 'search includes note text');
assert(clientExports.__test.matchesArchivedSession(
  { title: 'Alpha', workspaceTitle: '项目', tags: ['Research'], note: '' },
  'research',
  'en-US',
) === true, 'search includes tags');
assert(clientExports.__test.filterByTag({ tags: ['Important'] }, 'important') === true, 'tag filter is case-insensitive');
```

- [ ] **Step 2: Run smoke test and verify RED**

Run `node --test test/smoke.test.mjs`.

Expected: FAIL because the helper exports do not exist.

- [ ] **Step 3: Implement and export pure client helpers**

Use binary units with one decimal only when needed:

```js
function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${Number(amount.toFixed(amount >= 10 ? 0 : 1))} ${units[unit]}`;
}
```

Normalize query/tag matching with `toLocaleLowerCase(locale)` and include title, workspace title, every tag, and note. Export all three helpers through `exports.__test`.

- [ ] **Step 4: Add failing client rendering and request assertions**

Update the mocked `/state` response and rendered fixture rows with `tags`, `note`, `metadataUpdatedAt`, and `metadataStatus`. Mock `/stats`. Assert the rendered tree contains:

- summary text for archive count and total size,
- a tag-filter select,
- at most three tag chip elements plus `+N`,
- a per-row formatted size,
- an accessible metadata dialog with tag input and note textarea,
- a disabled metadata edit action when `metadataStatus === 'unavailable'`.

Trigger save and assert:

```js
assert(request.url === '/plugins/dsh-archived-chats/metadata');
assert(request.options.headers['x-dsh-archived-chats'] === '1');
assert.deepEqual(JSON.parse(request.options.body), {
  sessionId: 'session-a',
  tags: ['important'],
  note: 'keep this',
});
```

For a rejected save, assert the dialog remains rendered with the typed values.

- [ ] **Step 5: Run client smoke test and verify RED**

Run `node --test test/smoke.test.mjs`.

Expected: helper tests pass; UI/render/request assertions FAIL because insights UI is absent.

- [ ] **Step 6: Implement localized client state and fetch flow**

Add Chinese/English keys for summary, size unavailable, tag filter, edit metadata, tag input, note, limits, save/cancel, metadata unavailable, statistics failure, and save success/failure.

Add:

```js
async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function saveMetadata(sessionId, tags, note) {
  return postAction('/metadata', { sessionId, tags, note });
}
```

Store `metadataStatus` separately from sessions and statistics as `{ status: 'idle' | 'loading' | 'ready' | 'error', summary, sessions }`. Fetch stats only after a non-empty state load. Statistics failure sets a warning but does not replace `sessions`.

- [ ] **Step 7: Implement summary, filter, rows, and accessible editor**

Add a summary strip under `.dac-head`, a tag select in `.dac-filters`, chips/size in each row, and an edit icon action. Reuse `ConfirmDialog` focus patterns in a dedicated `MetadataDialog` with `role="dialog"`, labelled title, described limits, initial focus on the tag input, Escape cancel, Tab trap, and focus restoration.

Parse comma-separated tag input, normalize before save, disable save while busy, preserve dialog state on failure, and apply the server's canonical metadata on success.

Use only rc.7 design tokens already present in the theme; destructive colors remain untouched. Add responsive wrapping and reduced-motion rules without changing the existing nav-icon patch.

- [ ] **Step 8: Verify Task 5 and commit**

Run:

```bash
npm test
node --check lib/client.js
git diff --check
```

Commit:

```bash
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: add archive insights UI"
```

---

### Task 6: Package, Documentation, and Release Candidate Verification

**Files:**
- Modify: `package.json:2-4,39-44`
- Modify: `README.md:1-80`
- Modify: `README.zh.md:1-80`
- Modify: `lib/types/index.d.ts`
- Modify: `lib/types/client/index.d.ts`

**Interfaces:**
- Consumes: completed host/client implementation and all passing tests.
- Produces: publishable `dsh-archived-chats@0.6.0` package and bilingual operating documentation.

- [ ] **Step 1: Update package identity and runtime file allowlist**

Set version `0.6.0`, update the description to mention tags, notes, and storage insights, and include:

```json
"files": [
  "lib/index.js",
  "lib/client.js",
  "lib/metadata.js",
  "lib/stats.js",
  "lib/types",
  "cordis.patch.yml"
]
```

Keep peer dependencies and Harness client injection unchanged.

- [ ] **Step 2: Update public types and bilingual documentation**

Keep metadata/stats modules internal. Update entry comments to describe seven routes and archive insights. Document:

- metadata path and privacy/local-only behavior,
- tag/note limits and lifecycle,
- statistics meaning and unavailable rows,
- non-blocking failure behavior,
- rc.7 compatibility baseline,
- `npm test` covering all `test/*.test.mjs` files.

- [ ] **Step 3: Run the complete fresh verification suite**

Run:

```bash
npm test
node --check lib/index.js
node --check lib/client.js
node --check lib/metadata.js
node --check lib/stats.js
node --check test/smoke.test.mjs
node --check test/metadata.test.mjs
node --check test/stats.test.mjs
git diff --check
npm_config_cache=/private/tmp/dsh-archived-chats-npm-cache npm pack --dry-run --json
```

Expected: zero test failures, every syntax/diff check exits 0, and the pack manifest contains `lib/metadata.js` and `lib/stats.js` but excludes `test/`, `docs/`, and `data/`.

- [ ] **Step 4: Verify the local linked Harness host**

Confirm the profile still resolves the development link:

```bash
readlink /Users/h/.dsh/profiles/web/node_modules/dsh-archived-chats
node -p "require('/Users/h/.dsh/profiles/web/node_modules/dsh-archived-chats/package.json').version"
```

Expected: the link targets this repository and version is `0.6.0`.

Restart Harness only if its plugin inventory does not hot-reload the package version. Then read-only check:

```bash
curl --fail --silent --show-error http://127.0.0.1:3080/plugins/dsh-archived-chats/state
curl --fail --silent --show-error http://127.0.0.1:3080/plugins/dsh-archived-chats/stats
```

Expected: both return HTTP 200 JSON, `/state` includes `metadataStatus`, and `/stats` includes `summary` and `sessions`.

- [ ] **Step 5: Perform visual and accessibility checks when browser access is available**

In Harness rc.7, check light/dark themes, desktop/narrow widths, keyboard-only metadata editing, tag overflow, unavailable metadata warning, and statistics failure isolation. Do not perform delete or unarchive actions during this visual pass.

- [ ] **Step 6: Commit the release candidate**

```bash
git add package.json README.md README.zh.md lib/types/index.d.ts lib/types/client/index.d.ts
git commit -m "chore: prepare archive insights 0.6.0"
```

After the commit, run `git status -sb` and verify the only untracked path is the user-owned `data/` directory.
