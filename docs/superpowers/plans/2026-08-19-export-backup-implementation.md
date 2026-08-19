# Export and Backup 0.7.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded-memory ZIP backups for one or many archived sessions, with authoritative JSON, readable Markdown, a manifest, and native browser downloads.

**Architecture:** A new `lib/export.js` module owns schemas, filenames, transcript projection, and sequential ZIP writing. `lib/index.js` validates a bounded form request and supplies visible archive descriptors plus persistence inspection; `lib/client.js` submits hidden native forms so the browser never buffers the ZIP.

**Tech Stack:** Node.js 18+ ESM, `@deepseek-ai/dsh-session` rc.7 projection helpers, `zip-stream` 7.x, Node test runner, mocked Cordis/Harness host and browser runtime.

**Spec:** `docs/superpowers/specs/2026-08-19-export-backup-design.md`

## Global Constraints

- Export format is `dsh-archived-chats/export` version 1 and `dsh-archived-chats/session` version 1.
- JSON retains `sessionPersistence.inspect(id)` metadata and events without lossy transformation.
- Markdown uses append-origin events through `isAppendSurfaceEvent` and `deriveEventMessage`.
- Every request produces a ZIP containing `manifest.json` and two files per session.
- Batch generation retains at most one inspected session payload at a time.
- Request bodies are at most 512 KiB and selections contain 1 to 2,000 unique string IDs.
- Only currently visible archived sessions can be exported.
- Attachment binaries and descendant sessions are excluded and declared by `attachmentsIncluded: false`.
- Import and restore remain out of scope until `0.8.0`.
- Existing untracked `data/` is never read, modified, staged, or committed.

---

### Task 1: Safe Paths and Versioned Records

**Files:**
- Create: `lib/export.js`
- Create: `test/export.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: archive rows from `/state`, storage rows from `StatsService.measure()`, and inspected `{ meta, events }` values.
- Produces: `safeSegment(value, fallback, maxLength)`, `planExport(descriptors, exportedAt)`, `createManifest(plan, generatorVersion)`, and `createSessionRecord(item, inspected, exportedAt)`.

- [ ] **Step 1: Add only the projection and ZIP dependencies**

Run:

```bash
npm install @deepseek-ai/dsh-session@^0.1.0-rc.7 zip-stream@^7.0.5
npm install --save-dev fflate@^0.8.2
```

Expected: `package.json` and `package-lock.json` add the two runtime dependencies and `fflate` as the ZIP-reader test dependency; no unrelated dependency appears at the top level.

- [ ] **Step 2: Write failing filename and record tests**

Add literal expectations to `test/export.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeSegment,
  planExport,
  createManifest,
  createSessionRecord,
} from '../lib/export.js';

test('safeSegment removes traversal and Windows-reserved path syntax', () => {
  assert.equal(safeSegment('../CON:<bad>\\name', 'untitled', 80), 'CON-bad-name');
  assert.equal(safeSegment(' . ', 'untitled', 80), 'untitled');
});

test('planExport keeps order and disambiguates hostile duplicate titles', () => {
  const plan = planExport([
    { id: 'session-aaaaaaaa', title: '../Plan' },
    { id: 'session-aaaaaaaa', title: '../Plan' },
    { id: 'session-bbbbbbbb', title: '../Plan' },
  ], new Date('2026-08-19T12:00:00.000Z'));
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.items.map((item) => item.directory), [
    'sessions/001-Plan-aaaaaaaa',
    'sessions/002-Plan-bbbbbbbb',
  ]);
  assert.equal(plan.filename, 'dsh-archived-chats-2-2026-08-19.zip');
});

test('versioned records preserve archive and inspected source data', () => {
  const exportedAt = '2026-08-19T12:00:00.000Z';
  const descriptor = {
    id: 'session-a', title: 'A', workspaceId: 'workspace-a',
    workspaceTitle: 'Workspace', createdAt: 123, origin: 'subagent',
    tags: ['keep'], note: 'literal note', metadataUpdatedAt: exportedAt,
    storage: { status: 'ready', sizeBytes: 42, fileCount: 2 },
  };
  const plan = planExport([descriptor], new Date(exportedAt));
  const manifest = createManifest(plan, '0.7.0');
  assert.equal(manifest.format, 'dsh-archived-chats/export');
  assert.equal(manifest.attachmentsIncluded, false);
  assert.equal(manifest.sessions[0].note, 'literal note');

  const inspected = { meta: { header: 'literal' }, events: [{ seq: 0, type: 'turn/start' }] };
  const record = createSessionRecord(plan.items[0], inspected, exportedAt);
  assert.equal(record.format, 'dsh-archived-chats/session');
  assert.strictEqual(record.source.meta, inspected.meta);
  assert.strictEqual(record.source.events, inspected.events);
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `node --test test/export.test.mjs`

Expected: FAIL because `lib/export.js` does not exist or does not export the named functions.

- [ ] **Step 4: Implement minimal path and record planning**

Implement the named exports in `lib/export.js`. Use Unicode normalization, replace `/`, `\\`, control characters, `<>:"|?*`, leading/trailing dots and whitespace, and reserved DOS basenames. Count Unicode code points for the 80-character bound. Deduplicate IDs in first-seen order before assigning three-digit sequence prefixes. Normalize missing archive fields to `null`, tags to an array, and storage to the exact ready/unavailable shape from the spec.

- [ ] **Step 5: Run the focused and full tests**

Run:

```bash
node --test test/export.test.mjs
npm test
```

Expected: PASS, including all pre-existing tests.

- [ ] **Step 6: Commit the record boundary**

```bash
git add package.json package-lock.json lib/export.js test/export.test.mjs
git commit -m "feat: define archive backup records"
```

---

### Task 2: Human Transcript and Sequential ZIP Writer

**Files:**
- Modify: `lib/export.js`
- Modify: `test/export.test.mjs`

**Interfaces:**
- Consumes: `isAppendSurfaceEvent`, `deriveEventMessage`, a planned export, and `async inspect(sessionId)`.
- Produces: `renderTranscript(item, events, exportedAt)` and `createExportZip({ plan, inspect, generatorVersion })`, returning a readable ZIP stream plus a completion promise.

- [ ] **Step 1: Write failing transcript projection tests**

Create valid literal rc.7 surface events for user, assistant, tool result, and one replacement event. Assert that `renderTranscript()` includes front matter, the append-origin text, reasoning/tool/image placeholders, and a fenced JSON fallback for an unknown block. Assert the replacement copy is absent while the original append-origin message remains.

The key mutation caught is replacing `isAppendSurfaceEvent(event)` with a type-only check; that mutation must make the replacement assertion fail.

- [ ] **Step 2: Run the transcript test and verify RED**

Run: `node --test --test-name-pattern="transcript" test/export.test.mjs`

Expected: FAIL because `renderTranscript` is not exported.

- [ ] **Step 3: Implement deterministic Markdown rendering**

Use the official projection helpers. Render content blocks with a recursive switch. Use JSON fences for raw tool arguments, unknown blocks, and malformed values. Quote front-matter strings with `JSON.stringify` and never render user content as plugin-authored HTML.

- [ ] **Step 4: Verify transcript GREEN**

Run: `node --test --test-name-pattern="transcript" test/export.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write a failing real-ZIP sequencing test**

Use `node:stream/consumers` to collect the returned stream and `fflate.unzipSync` to inspect it. Assert literal central-directory entry names and parsed JSON content. Gate the second `inspect` promise and assert it is not called before the first session's JSON and Markdown entry callbacks complete. Reject the second inspection and assert the ZIP completion rejects without requesting a third session.

- [ ] **Step 6: Run the ZIP tests and verify RED**

Run: `node --test --test-name-pattern="ZIP|serially|mid-stream" test/export.test.mjs`

Expected: FAIL because `createExportZip` is not exported.

- [ ] **Step 7: Implement the sequential ZIP writer**

Wrap `zip-stream` entry callbacks in promises. Inspect the first session before exposing a stream-ready result. Write formatted JSON with a trailing newline. Append one session's JSON and Markdown, await both callbacks, clear local references, then inspect the next session. Finalize only after all entries succeed; destroy the archive on error.

- [ ] **Step 8: Run focused and full tests, then commit**

```bash
node --test test/export.test.mjs
npm test
git add lib/export.js test/export.test.mjs package.json package-lock.json
git commit -m "feat: stream archive backup packages"
```

Expected: all tests PASS and the sequencing assertions prove one-session-at-a-time inspection.

---

### Task 3: Bounded Host Export Route

**Files:**
- Modify: `lib/index.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: `planExport`, `createExportZip`, current visible archive rows, `statsService.measure(ids)`, and `persistence.inspect(id)`.
- Produces: `POST /plugins/dsh-archived-chats/export` accepting URL-encoded `sessionIds` JSON and streaming `application/zip`.

- [ ] **Step 1: Extend the response fixture for streams**

Change the smoke-test `res()` helper into a minimal writable stream or `PassThrough`-backed response that still records `status`, `headers`, and body. Keep all existing JSON route assertions unchanged.

- [ ] **Step 2: Write failing route validation tests**

Assert route count becomes eight and `/export` exists. Add requests for malformed JSON, empty IDs, non-string IDs, a body above 512 KiB, and an invisible ID. Assert 400/404 occurs before `Content-Type: application/zip` and before `persistence.inspect` runs.

- [ ] **Step 3: Run route validation tests and verify RED**

Run: `node --test test/smoke.test.mjs`

Expected: FAIL at the route-count/export assertions.

- [ ] **Step 4: Add a bounded URL-encoded body parser and validate IDs**

Add a dedicated `readExportSelection(req)` helper. Count bytes as chunks arrive and reject once the total exceeds `512 * 1024`. Parse with `URLSearchParams`, then `JSON.parse`, require an array, require 1 to 2,000 unique non-empty string IDs, and preserve first-seen order.

- [ ] **Step 5: Verify validation GREEN**

Run: `node --test --test-name-pattern="host half|export" test/smoke.test.mjs`

Expected: validation cases PASS while valid ZIP assertions still fail.

- [ ] **Step 6: Write failing valid single and batch download tests**

Submit one and two visible IDs. Collect each response, open it as a ZIP, and assert headers, filename, manifest order, row metadata, storage fields, inspected source events, and transcript paths. Submit duplicate IDs and assert only one session directory exists.

- [ ] **Step 7: Implement route composition and streaming**

Factor the existing `/state` row construction into one internal async function used by both `/state` and `/export`, without changing its response shape. Join storage rows, plan the package, pre-inspect the first session, set attachment headers, pipe the ZIP stream to `res`, and destroy the archive on `req.aborted` or response errors. Convert pre-header validation/inspection errors to plain UTF-8 responses and log only stable codes plus session IDs.

- [ ] **Step 8: Run focused and full tests, then commit**

```bash
node --test test/smoke.test.mjs
npm test
git add lib/index.js test/smoke.test.mjs
git commit -m "feat: expose streamed archive exports"
```

Expected: all existing lifecycle behavior remains green and valid exports are readable ZIP files.

---

### Task 4: Single, Selected, and All Export UI

**Files:**
- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: ordered session IDs and the existing transient notice system.
- Produces: `submitExport(sessionIds)` plus row, selected, and all export controls.

- [ ] **Step 1: Write failing browser-helper tests**

Extend the mocked document with `createElement('form')`, `createElement('input')`, append/remove tracking, and `form.submit()`. Call exported test helper `submitExport(['session-b', 'session-a'])` and assert:

```js
assert.equal(form.method, 'POST');
assert.equal(form.action, '/plugins/dsh-archived-chats/export');
assert.equal(input.name, 'sessionIds');
assert.equal(input.value, '["session-b","session-a"]');
assert.equal(form.hidden, true);
```

Advance one timer/task and assert the form is removed only after submission.

- [ ] **Step 2: Run helper tests and verify RED**

Run: `node --test --test-name-pattern="export form" test/smoke.test.mjs`

Expected: FAIL because `submitExport` does not exist.

- [ ] **Step 3: Implement the native form helper and download icon**

Add `IconDownload` using the existing code-native icon conventions. `submitExport` must deduplicate IDs in order, reject an empty list, create a hidden URL-encoded POST form and hidden field, submit, and schedule removal. Export it through `exports.__test`.

- [ ] **Step 4: Verify helper GREEN**

Run: `node --test --test-name-pattern="export form" test/smoke.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing UI workflow tests**

Assert Chinese and English locale keys exist. Render the real section and verify:

- every row has a download icon with `aria-label`;
- top actions include `Export all` when rows exist;
- selected bulk bar includes `Export selected` and submits `selectedIds` in archive-list order;
- controls are disabled for empty or currently busy scopes;
- clicking any enabled export announces the localized download-started notice;
- mobile CSS allows bulk actions to wrap and row buttons retain fixed dimensions.

- [ ] **Step 6: Run UI tests and verify RED**

Run: `node --test --test-name-pattern="export" test/smoke.test.mjs`

Expected: FAIL at missing controls/locales.

- [ ] **Step 7: Implement the controls and responsive styling**

Pass `onExport` into `GroupList`. Put the row icon before delete, add a neutral export-all button next to delete-all, and add export-selected before destructive bulk actions. Reuse `selectedBusy`/`visibleBusy`; do not disable metadata, unarchive, or delete globally during a native download.

- [ ] **Step 8: Run focused and full tests, then commit**

```bash
node --test test/smoke.test.mjs
npm test
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: add archive backup actions"
```

Expected: all host and client tests PASS.

---

### Task 5: Version, Documentation, Types, and Release Evidence

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `lib/types/index.d.ts` only if the host export adds public exports
- Modify: `lib/types/client/index.d.ts` only if the client export adds public exports

**Interfaces:**
- Consumes: the completed v1 package behavior.
- Produces: publishable `dsh-archived-chats@0.7.0` package and user documentation.

- [ ] **Step 1: Update release metadata and docs**

Set package version to `0.7.0`. Update both READMEs with single/batch backup behavior, exact package contents, attachment limitation, local-only privacy, streaming behavior, and `0.8.0` restore deferral. Update route and dependency descriptions without changing installation commands.

- [ ] **Step 2: Run static and package checks**

```bash
node --check lib/export.js
node --check lib/index.js
node --check lib/client.js
npm test
npm pack --dry-run --json
```

Expected: all checks PASS; pack output includes `lib/export.js` and excludes `data/`, tests, screenshots, and superpowers documents.

- [ ] **Step 3: Inspect dependency and diff scope**

```bash
npm ls --depth=0
npm audit --omit=dev
git diff --check
git status --short
```

Expected: only planned source, test, lockfile, version, and documentation changes; zero known production vulnerabilities.

- [ ] **Step 4: Commit release metadata**

```bash
git add package.json package-lock.json README.md README.zh.md lib/types
git commit -m "docs: prepare archive backups 0.7.0"
```

- [ ] **Step 5: Perform real Harness verification**

Start the local Harness from this worktree's linked plugin. In the actual settings page, export one archived session and two selected sessions. Open both ZIP files and compare manifest entries with central-directory entries. Verify desktop, narrow mobile, light, and dark states; confirm export controls do not overlap edit/delete/unarchive and existing actions remain usable.

- [ ] **Step 6: Record final evidence and branch state**

```bash
git status --short --branch
git log --oneline --decorate -6
```

Expected: branch `agent/export-backup-0.7` is clean except user-owned files outside the worktree, and every implementation task has a focused commit.
