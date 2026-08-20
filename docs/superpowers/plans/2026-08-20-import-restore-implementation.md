# Import and Restore 0.8.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a validated, preview-first, atomic import flow for version-one `dsh-archived-chats` backup ZIPs without overwriting existing sessions.

**Architecture:** Keep ZIP parsing and schema validation pure in `lib/import.js`. Keep Harness writes behind a feature-detected transaction adapter in `lib/restore.js`; `lib/index.js` owns bounded multipart uploads, short-lived inspect tokens, conflict rechecks, and HTTP responses. Extend the existing browser bundle with a native ZIP picker, preview dialog, and confirmation flow. No importer code writes directly to a guessed session-log path.

**Tech Stack:** Node.js 18 ESM, `node:test`, existing `fflate` ZIP primitives, existing `zip-stream` exporter, DeepSeek Harness rc.7 services, React JSX runtime in the generated client bundle.

**Spec:** `docs/superpowers/specs/2026-08-20-import-restore-design.md`

## Global Constraints

- Accept only `dsh-archived-chats/export` v1 manifests and `dsh-archived-chats/session` v1 records.
- Never overwrite or merge an existing session ID; mark it `id-conflict` and skip it.
- Validate the whole package before any Harness, registry, or metadata write.
- Enforce 256 MiB uncompressed, 512 MiB compressed, 2,000 sessions, 4 MiB per JSON record, and 8 MiB per Markdown transcript.
- Restore selected records as archived sessions; unresolved workspaces remain ungrouped and produce `workspace-unresolved` warnings.
- Restore tags and notes through the existing metadata store limits; do not restore attachment bytes.
- Use staging plus commit plus rollback; a failed batch must not leave partial sessions or metadata.
- Tokens expire after 10 minutes and are single-use; upload files are private and cleaned up.
- Keep the existing `data/` directory untracked and untouched.
- Keep existing export, archive lifecycle, stats, metadata, locale, theme, and rc.7 compatibility behavior green.

---

## File Map

**Create:**

- `lib/import.js` — pure ZIP index, bounded entry readers, v1 schema validation, preview and reason-code helpers.
- `lib/restore.js` — feature-detected Harness restore adapter and rollback transaction.
- `test/import.test.mjs` — pure package acceptance and preview tests.
- `test/restore.test.mjs` — fake-host transaction and rollback tests.

**Modify:**

- `lib/index.js` — multipart upload parsing, token registry, inspect/restore routes, lifecycle wiring, and startup cleanup.
- `lib/client.js` — import action, file picker, preview/selection dialog, confirmation result, localization, and responsive styles.
- `lib/types/index.d.ts` — document new host routes/capability behavior.
- `lib/types/client/index.d.ts` — document import UI support if client test hooks are exposed.
- `test/smoke.test.mjs` — host route registration, inspect/restore integration, and client smoke coverage.
- `package.json` and `package-lock.json` — move `fflate` from devDependencies to runtime dependencies.
- `README.md` and `README.zh.md` — document import limits, conflict behavior, and attachment policy.

---

### Task 1: Add Pure ZIP Import Validation

**Files:**

- Create: `lib/import.js`
- Create: `test/import.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Produces `inspectImport(source)` where `source` is `{ bytes: Uint8Array, compressedBytes?: number }` and the return value is either `{ ok: false, errors: [{ code, path, message }] }` or `{ ok: true, plan }`.
- `plan` is `{ manifest, items, warnings, totalBytes }`, where each `items` entry contains the validated manifest descriptor, parsed `sessionRecord`, `transcriptBytes`, and `attachmentReferences`.
- Produces `selectImportItems(plan, selectedIds, conflicts)` returning manifest-order records plus `skipped` conflict results; it never mutates `plan`.

- [ ] **Step 1: Move `fflate` to runtime dependencies.**

Change `package.json` so `fflate` is listed under `dependencies` beside `zip-stream`; regenerate `package-lock.json` with `npm install --package-lock-only`. The runtime importer will use `Unzip`, `UnzipInflate`, and `UnzipPassThrough` so validation can enforce central-directory sizes and per-entry limits without calling `unzipSync` on an unbounded archive.

- [ ] **Step 2: Write failing package fixtures and acceptance tests.**

In `test/import.test.mjs`, use `fflate.zipSync` to create fixtures from the existing v1 export shape. Cover:

```js
const valid = makePackage([{ id: 'session-a', title: 'Alpha', workspace: null }]);
const result = inspectImport({ bytes: valid, compressedBytes: valid.length });
assert.equal(result.ok, true);
assert.deepEqual(result.plan.items.map((item) => item.id), ['session-a']);
```

Add tests for missing root manifest, unsupported format/version, duplicate entry names, duplicate IDs, unreferenced entries, traversal/backslash/control-character names, manifest/session field mismatches, invalid JSON, prototype keys, attachment reference warnings, and every compressed/uncompressed/per-file/session-count limit. Assert stable codes such as `manifest-missing`, `format-unsupported`, `entry-duplicate`, `path-unsafe`, `session-mismatch`, and `limit-exceeded`.

- [ ] **Step 3: Run the focused tests and verify they fail.**

Run `node --test test/import.test.mjs`. Expected: module/export failures because `lib/import.js` does not exist yet.

- [ ] **Step 4: Implement bounded ZIP indexing and schema validation.**

Implement `inspectImport` with these internal boundaries:

```js
const LIMITS = Object.freeze({
  maxCompressedBytes: 512 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxSessions: 2000,
  maxJsonBytes: 4 * 1024 * 1024,
  maxMarkdownBytes: 8 * 1024 * 1024,
});

function indexZip(bytes) { /* returns Map(name, { bytes, compressedSize, originalSize }) */ }
function parseJsonEntry(index, name, limit) { /* bounded UTF-8 + JSON parse */ }
export function inspectImport(source) { /* no filesystem or DSH writes */ }
```

Reject duplicate names before storing an entry, reject non-UTF-8 names, reject directory entries except as ignorable markers, and reject all names that are not normalized relative paths under `manifest.json` or `sessions/`. Walk the manifest references, require exactly one JSON and Markdown file per item, compare all archive descriptor fields with `sessionRecord.archive`, scan every consumed JSON object for `__proto__`, `constructor`, and `prototype`, and count image/attachment blocks for preview warnings. Use `TextDecoder('utf-8', { fatal: true })` and finite-number checks.

- [ ] **Step 5: Implement selection and preview helpers.**

Return a preview-safe object that omits raw event content and Markdown text while retaining `id`, title, workspace, tags, note, storage, `hasAttachmentReferences`, and warnings. `selectImportItems` must preserve manifest order, reject unknown selected IDs with `selection-unknown`, and return `{ records, skipped }` where conflicts are `{ id, reason: 'id-conflict' }`.

- [ ] **Step 6: Run focused tests and commit.**

Run `node --test test/import.test.mjs` and `node --check lib/import.js`; expected result is all import tests passing. Commit:

```bash
git add lib/import.js test/import.test.mjs package.json package-lock.json
git commit -m "feat: validate archived backup imports"
```

---

### Task 2: Build the Restore Transaction Adapter

**Files:**

- Create: `lib/restore.js`
- Create: `test/restore.test.mjs`

**Interfaces:**

- Produces `createRestoreAdapter({ ctx, persistence, registry, metadataStore, tempRoot })`.
- `adapter.capability` is `{ supported: boolean, reason?: 'writer-missing'|'transaction-missing' }`.
- `adapter.prepare(records, { knownIds })` returns a transaction with `stage(record)`, `commit()`, and `rollback()` methods.
- `commit()` returns `{ restored, warnings }`; rollback is idempotent and safe after partial commit.

- [ ] **Step 1: Write fake-host transaction tests.**

Build a fake host with a supported `persistence.restore` writer, `registry.setState`, and a metadata store spy. Assert that staging passes the original `source.meta` and `source.events` losslessly, exact workspace IDs are attached, missing workspaces produce `workspace-unresolved`, tags/notes are written once, and existing IDs are never passed to the writer.

Add failure tests at staging, persistence commit, metadata commit, archive-state commit, and rollback. Every failure must call rollback, remove staged records, leave `registry.archivedSessionIds` unchanged, and leave metadata unchanged. Add an unsupported-host test asserting `restore-unsupported` and zero writes.

- [ ] **Step 2: Run tests to verify the adapter tests fail.**

Run `node --test test/restore.test.mjs`. Expected: missing-module/export failures.

- [ ] **Step 3: Implement capability detection and staging.**

Feature-detect the host writer rather than guessing private files. Prefer a callable `persistence.restore`/`persistence.import` transaction surface if present; otherwise detect a host-provided session-store transaction with explicit stage/commit/rollback methods. If neither exists, set `capability.supported` false. Stage records under a private `mkdtemp` directory, write only through the host adapter, and verify each staged record with `persistence.inspect` before commit.

- [ ] **Step 4: Implement commit ordering and rollback.**

Commit in this order: staged persistence records, metadata entries, then registry archive IDs/workspace membership. Snapshot original archive IDs and metadata entries before the first write. On any error, reverse completed writes through the adapter, restore the registry snapshot through `registry.setState`, restore metadata with the existing store API, and remove the staging directory. Make rollback idempotent so route cleanup can call it after both caught and uncaught failures.

- [ ] **Step 5: Run adapter tests, syntax checks, and commit.**

Run `node --test test/restore.test.mjs` and `node --check lib/restore.js`. Commit:

```bash
git add lib/restore.js test/restore.test.mjs
git commit -m "feat: add transactional archive restore adapter"
```

---

### Task 3: Add Host Upload, Inspect, and Restore Routes

**Files:**

- Modify: `lib/index.js`
- Modify: `test/smoke.test.mjs`
- Modify: `lib/types/index.d.ts`

**Interfaces:**

- Adds `POST /plugins/dsh-archived-chats/import/inspect` and `POST /plugins/dsh-archived-chats/import/restore`.
- Adds internal `createImportTokenStore({ now, ttlMs, tempRoot })` with `create`, `consume`, and `remove` operations.
- Inspect response shape: `{ ok, token, nonce, expiresAt, package: { generator, version, sessionCount, totalBytes }, sessions: [...] }`.
- Restore response shape: `{ ok, restored: string[], skipped: [{ id, reason }], warnings: [{ id, reason }] }`.

- [ ] **Step 1: Add route and token-store tests to the smoke fixture.**

Extend the existing mock request to support `content-type`, multipart bodies, and JSON bodies. Assert both routes reject non-POST and missing `x-dsh-archived-chats: 1`. Add tests for malformed multipart, no ZIP field, uploads over the compressed limit, inspect returning a token, expired token rejection, replay rejection, unknown selected IDs, and a valid restore response from a fake supported adapter.

- [ ] **Step 2: Run the new smoke tests and verify failure.**

Run `node --test test/smoke.test.mjs`. Expected: route lookup or assertion failures because import routes and token storage are absent.

- [ ] **Step 3: Implement bounded multipart upload handling.**

Add a request reader that requires `multipart/form-data; boundary=...`, streams into a private file below `path.join(DSH_HOME, 'plugin-data', 'archived-chats', 'imports')`, enforces the 512 MiB compressed cap while reading, rejects multiple ZIP fields, and removes the file on every error. Parse only headers and the single ZIP part; do not accept arbitrary form fields as package data. Use restrictive file mode `0o600` and a random filename from `crypto.randomUUID()`.

- [ ] **Step 4: Implement inspect tokens and preview construction.**

On inspect, call `inspectImport({ bytes, compressedBytes })`, snapshot `persistence.list()` IDs plus `registry.archivedSessionIds`, build conflict markers, create a 10-minute token/nonce, and retain the validated plan in memory alongside its temp file. Return only preview-safe fields. Ensure no metadata, persistence, workspace, or registry write occurs during inspect.

- [ ] **Step 5: Implement restore route and race checks.**

Consume the token exactly once, verify the nonce and ordered selected IDs, reload the current persistence IDs, mark newly conflicting IDs as skipped, and reject empty eligible selections with `nothing-to-restore`. Create the adapter transaction, stage eligible records, commit, and always delete the temp file/token. On adapter failure invoke rollback; return `restore-rollback-failed` if rollback fails. Log only stable reason codes and IDs, never session content or notes.

- [ ] **Step 6: Wire startup cleanup and route registration.**

Pass `ctx` and `metadataStore` into `registerRoutes`, create the token store beside the existing pending-deletion store, and remove expired import temp files during registration. Keep export and lifecycle routes unchanged. Update the host type declaration to list the two new routes and the restore capability behavior.

- [ ] **Step 7: Run host tests and commit.**

Run `node --test test/smoke.test.mjs`, `node --test test/*.test.mjs`, and `node --check lib/index.js`. Commit:

```bash
git add lib/index.js test/smoke.test.mjs lib/types/index.d.ts
git commit -m "feat: add validated archive import routes"
```

---

### Task 4: Add the Import Preview and Restore UI

**Files:**

- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`
- Modify: `lib/types/client/index.d.ts`

**Interfaces:**

- Adds one `Import backup` action to the existing archive page.
- Adds internal browser helper `submitImportFile(file)` and preview state `{ token, nonce, sessions, selectedIds, expiresAt }`.
- Sends `multipart/form-data` with the existing guard header to inspect; sends JSON `{ token, nonce, sessionIds }` with the guard header to restore.

- [ ] **Step 1: Add localization and UI smoke assertions.**

Add Chinese and English strings for import, invalid package, conflict, attachment warning, workspace warning, preview, confirm, progress, restored, skipped, rollback failure, and expiration. Extend smoke tests to assert the file input is hidden, accepts `.zip`, the import button is present, preview rows can be selected, conflicts are disabled, and confirmation submits the expected IDs.

- [ ] **Step 2: Run client smoke tests and verify failure.**

Run `node --test test/smoke.test.mjs`. Expected: missing import action/localization assertions.

- [ ] **Step 3: Implement file selection and inspect flow.**

Add a hidden native `<input type="file" accept=".zip,application/zip">` triggered by the import icon/text action. Submit the selected file with `FormData` and the guard header to `/import/inspect`; keep the returned token/nonce only in React state. Show server validation errors in the existing notice/dialog pattern and clear file state on cancel or expiration.

- [ ] **Step 4: Implement preview dialog and selection rules.**

Render generator/version, session count, total size, and one stable row per session with title, workspace, tags, note, stored size, conflict state, attachment warning, and workspace warning. Preselect eligible sessions, disable conflict rows, provide select-all/clear controls, and disable confirm when no eligible session is selected. Do not render raw Markdown or event content.

- [ ] **Step 5: Implement confirmation, result, refresh, and responsive styling.**

POST the token/nonce/IDs, show a busy state that prevents duplicate submits, render restored/skipped/warning counts, refresh `/state` and `/stats` after success, and close only after the result is acknowledged. Add fixed-width controls and wrapping rules for narrow screens; use existing icon and dialog conventions and keep focus trapping/escape behavior consistent with the metadata dialog.

- [ ] **Step 6: Run client and full tests, then commit.**

Run `node --test test/smoke.test.mjs`, `node --test test/*.test.mjs`, and `node --check lib/client.js`. Commit:

```bash
git add lib/client.js test/smoke.test.mjs lib/types/client/index.d.ts
git commit -m "feat: add archive import preview and restore UI"
```

---

### Task 5: Documentation, Packaging, and Release Verification

**Files:**

- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `package.json`
- Modify: `lib/types/index.d.ts`
- Modify: `lib/types/client/index.d.ts`
- Test: `test/import.test.mjs`, `test/restore.test.mjs`, `test/smoke.test.mjs`

- [ ] **Step 1: Document the user-visible import contract.**

Add an Import and Restore section to both READMEs describing ZIP-only v1 acceptance, preflight preview, ID-conflict skipping, unresolved workspace behavior, metadata preservation, attachment-reference-only behavior, 10-minute confirmation expiry, and the `restore-unsupported` outcome on hosts without the writer capability.

- [ ] **Step 2: Bump package metadata for the release candidate.**

After implementation is verified, update `package.json` and `package-lock.json` from `0.7.0` to `0.8.0`, keep `fflate` in runtime dependencies, and ensure `npm pack --dry-run --json` includes `lib/import.js`, `lib/restore.js`, the client bundle, declarations, and excludes `data/`.

- [ ] **Step 3: Run release verification.**

Run:

```bash
npm test
node --check lib/import.js
node --check lib/restore.js
node --check lib/index.js
npm pack --dry-run --json
npm audit --omit=dev
git diff --check
```

Expected: all tests pass, syntax checks exit 0, package contents contain no `data/`, audit reports no production vulnerabilities, and `git diff --check` is clean. Perform a real-host isolated-profile round trip: export a `0.7.0` archive, inspect it, restore one non-conflicting session, confirm it is archived and visible in the plugin, then repeat to verify `id-conflict` skipping.

- [ ] **Step 4: Commit release metadata and prepare publication.**

Commit the docs and version bump only after the full verification commands pass:

```bash
git add README.md README.zh.md package.json package-lock.json lib/types
git commit -m "release: prepare archived backup restore 0.8.0"
```

Do not publish or push until the real-host round trip and package inspection are recorded.

---

## Self-Review

- Package acceptance requirements map to Task 1, including all limits, path checks, duplicate rejection, prototype-key rejection, descriptor consistency, and attachment warnings.
- Conflict, archive state, workspace, metadata, and attachment policy map to Tasks 2 and 3.
- Feature-detected writer, staging, commit ordering, rollback, and unsupported-host behavior map to Task 2.
- Bounded multipart upload, single-use ten-minute tokens, race checks, cleanup, and stable route responses map to Task 3.
- Preview UI, selection rules, result reporting, locale, focus behavior, responsive layout, and refresh behavior map to Task 4.
- Documentation, packaging, full tests, audit, and real-host verification map to Task 5.
- Every task names a file, interface, test command, and expected result; no step relies on an unspecified implementation or error path.
