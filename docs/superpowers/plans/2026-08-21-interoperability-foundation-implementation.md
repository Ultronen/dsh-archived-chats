# Cross-Tool Chat Interoperability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, preview-first Codex and Claude Code import/export foundation to `dsh-archived-chats` while preserving the existing DSH ZIP backup format and archive behavior.

**Architecture:** Keep the feature inside the existing plugin. Pure adapters in `lib/interop/` convert external JSONL records into a versioned `dsh-interop` projection and produce explicit fidelity reports; `lib/index.js` exposes bounded inspect/export routes; `lib/client.js` adds external import/export controls beside the current backup actions. Existing restore transactions, metadata limits, CSRF guard, and sandbox boundaries remain the write path.

**Tech Stack:** Node.js ESM, built-in `node:crypto` and `node:fs/promises`, existing `fflate`/`zip-stream` helpers, native DSH HTTP routes, and `node:test` fixtures.

**Spec:** `docs/superpowers/specs/2026-08-21-interoperability-foundation-design.md`

## Global Constraints

- Keep `dsh-archived-chats` as the only public package; do not create or publish `dsh-chat-interop`.
- Support Codex and Claude Code first; do not add continuous sync or automatic overwrite.
- External files are read-only inputs; never write credentials, raw messages, or source paths to logs.
- Existing `dsh-archived-chats/export` version-one ZIP imports must remain compatible.
- Import must preview conflicts and losses before restore; existing IDs are never overwritten.
- Preserve the existing local guard header, one-time confirmation tokens, rollback behavior, and package exclusion of `data/`.

### Task 1: Update README preview heading

**Files:**
- Modify: `README.md:29-31`
- Modify: `README.en.md:29-31`

- [ ] **Step 1: Change the section labels**

Change `## 截图` to `## 预览` and `## Screenshots` to `## Preview`. Keep the existing version note and image paths unchanged.

- [ ] **Step 2: Verify the labels and whitespace**

Run:

```bash
rg -n '^## (预览|Preview)$|^## (截图|Screenshots)$' README.md README.en.md
git diff --check
```

Expected: only the new `预览` and `Preview` headings match; no diff-check errors.

### Task 2: Add the versioned interop model and report types

**Files:**
- Create: `lib/interop/format.js`
- Create: `lib/interop/report.js`
- Create: `test/interop-format.test.mjs`

**Interfaces:**
- `createInteropManifest({ source, sourceVersion, sessions, exportedAt }) -> object`
- `validateInteropManifest(manifest) -> { ok: true, value } | { ok: false, errors }`
- `createInteropSession({ id, title, workspace, messages, attachments, losses, source }) -> object`
- `createInteropReport({ source, sessions, losses, conflicts, warnings }) -> object`
- `INTEROP_FORMAT = 'dsh-interop'`, `INTEROP_VERSION = 1`

- [ ] **Step 1: Write failing validation tests**

Cover a valid manifest, missing source, duplicate session IDs, unsupported versions, malformed messages, unsafe attachment paths, and stable SHA-256 values. Assert that validation returns structured errors and never throws for untrusted input.

- [ ] **Step 2: Run the focused test and confirm failure**

Run `node --test test/interop-format.test.mjs`; expect module/import or assertion failures because the interfaces do not exist yet.

- [ ] **Step 3: Implement bounded pure validation**

Use plain objects and defensive checks. Normalize IDs and titles without mutating input. Keep the model independent of DSH host services so adapters and route code can consume it.

- [ ] **Step 4: Run the focused test and then the full suite**

Run `node --test test/interop-format.test.mjs` followed by `npm test`; both must pass.

- [ ] **Step 5: Commit the model**

```bash
git add -- lib/interop/format.js lib/interop/report.js test/interop-format.test.mjs README.md README.en.md
git commit -m "feat: add versioned chat interop model"
```

### Task 3: Implement Codex JSONL conversion

**Files:**
- Create: `lib/interop/codex.js`
- Create: `test/interop-codex.test.mjs`
- Add fixtures: `test/fixtures/interop/codex-simple.jsonl`, `test/fixtures/interop/codex-tools.jsonl`

**Interfaces:**
- `inspectCodexJsonl(bytes, options) -> { sessions, report }`
- `exportCodexJsonl(session, options) -> { bytes, report }`

- [ ] **Step 1: Write fixtures and failing tests**

Test a single session, multiple turns, tool calls/results, malformed lines, unknown event types, attachment references, and repeated inspection. Assert that source bytes are not changed and losses identify unsupported events.

- [ ] **Step 2: Run `node --test test/interop-codex.test.mjs` and confirm failure**

- [ ] **Step 3: Implement read-only line parsing**

Parse bounded UTF-8 JSONL line by line, group records by session ID, map user/assistant/tool messages into the interop model, and preserve unknown records in the loss report rather than silently dropping them.

- [ ] **Step 4: Implement deterministic Codex projection**

Export a valid JSONL transcript with stable ordering, generated IDs only where required, and a report that distinguishes native resume support from transcript/handoff output. Never write to the source path.

- [ ] **Step 5: Run focused and full tests, then commit**

```bash
node --test test/interop-codex.test.mjs
npm test
git add -- lib/interop/codex.js test/interop-codex.test.mjs test/fixtures/interop/codex-*.jsonl
git commit -m "feat: add Codex chat conversion"
```

### Task 4: Implement Claude Code JSONL conversion

**Files:**
- Create: `lib/interop/claude.js`
- Create: `test/interop-claude.test.mjs`
- Add fixtures: `test/fixtures/interop/claude-simple.jsonl`, `test/fixtures/interop/claude-tools.jsonl`

**Interfaces:**
- `inspectClaudeJsonl(bytes, options) -> { sessions, report }`
- `exportClaudeJsonl(session, options) -> { bytes, report }`

- [ ] **Step 1: Write failing Claude fixtures and tests**

Cover user/assistant turns, tool use/result pairs, missing optional fields, malformed lines, and events that cannot be represented by Claude Code. Verify deterministic output and explicit loss entries.

- [ ] **Step 2: Run `node --test test/interop-claude.test.mjs` and confirm failure**

- [ ] **Step 3: Implement parser and projection**

Reuse only generic line/UTF-8 helpers from `format.js`; keep Claude-specific event mapping in this module. Treat input as untrusted and preserve source immutability.

- [ ] **Step 4: Run focused/full tests and commit**

```bash
node --test test/interop-claude.test.mjs
npm test
git add -- lib/interop/claude.js test/interop-claude.test.mjs test/fixtures/interop/claude-*.jsonl
git commit -m "feat: add Claude Code chat conversion"
```

### Task 5: Add bounded host routes for inspect and export

**Files:**
- Modify: `lib/index.js`
- Create: `test/interop-routes.test.mjs`

**Interfaces:**
- `POST /plugins/dsh-archived-chats/interop/inspect` multipart `{ file, source } -> { token, nonce, report, sessions }`
- `POST /plugins/dsh-archived-chats/interop/export` guarded form `{ sessionIds, target } -> downloadable JSONL`

- [ ] **Step 1: Write route tests**

Cover method rejection, missing guard, upload/body limits, unsupported source, malformed JSONL, successful preview token creation, source-specific export, and no mutation during inspect.

- [ ] **Step 2: Run the focused route test and confirm failure**

Run `node --test test/interop-routes.test.mjs`; expect missing route responses.

- [ ] **Step 3: Implement route wiring**

Reuse the existing multipart reader, import token store pattern, archive lookup, and guard header. The inspect route only parses and reports. The export route reads the selected archived records and streams a download with a safe content disposition.

- [ ] **Step 4: Run route and full tests**

Run `node --test test/interop-routes.test.mjs` and `npm test`.

- [ ] **Step 5: Commit route integration**

```bash
git add -- lib/index.js test/interop-routes.test.mjs
git commit -m "feat: expose chat interop routes"
```

### Task 6: Add the browser controls and preview report

**Files:**
- Modify: `lib/client.js`
- Modify: `test/smoke.test.mjs`

- [ ] **Step 1: Add locale strings and hidden file controls**

Add Chinese/English labels for external import, target selection, source selection, report categories, fidelity levels, and safe failure messages. Add hidden JSONL file input and keep existing ZIP backup controls unchanged.

- [ ] **Step 2: Add preview dialog state**

Implement source/target selection, upload inspection, report rendering, conflict selection, cancellation, expired-token handling, and download-start feedback. Keep focus restoration and Escape behavior consistent with the existing import metadata dialogs.

- [ ] **Step 3: Add smoke assertions**

Assert that the external import/export controls are registered, the preview dialog is accessible, loss and conflict rows are visible, and the existing backup actions remain available.

- [ ] **Step 4: Run the smoke test and full suite**

Run `node --test test/smoke.test.mjs` and `npm test`.

- [ ] **Step 5: Commit browser integration**

```bash
git add -- lib/client.js test/smoke.test.mjs
git commit -m "feat: add interop preview controls"
```

### Task 7: Documentation, compatibility, and release preparation

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE.en.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Document the user workflow**

Add Codex/Claude import and export steps, fidelity-report meanings, source immutability, attachment limitations, conflict behavior, and the new `0.9.0` version record. Keep the Chinese README default and the `预览`/`Preview` headings.

- [ ] **Step 2: Document architecture and security boundaries**

Describe the adapter boundary, `dsh-interop` manifest, route flow, bounded inputs, and no-secret/no-overwrite guarantees in both architecture guides.

- [ ] **Step 3: Bump version and run package checks**

Use `npm version 0.9.0 --no-git-tag-version`, then run `npm ci`, `npm test`, `npm pack --dry-run --json`, and `git diff --check`. Confirm `data/`, test fixtures, and design-only files are not accidentally included in the npm package.

- [ ] **Step 4: Commit release preparation**

```bash
git add -- README.md README.en.md docs/ARCHITECTURE.md docs/ARCHITECTURE.en.md package.json package-lock.json
git commit -m "release: prepare dsh-archived-chats 0.9.0"
```

### Task 8: Final verification checkpoint

- [ ] **Step 1: Run the complete verification set**

```bash
npm test
npm pack --dry-run --json
git diff --check
git status --short --branch
```

- [ ] **Step 2: Review the user-facing contract**

Confirm that existing v1 ZIP restore still works, import is preview-first, conflicts never overwrite, external sources remain read-only, all losses are reported, and no publish or push is performed until the user explicitly requests release.

- [ ] **Step 3: Commit only confirmed paths**

Keep user-owned `data/` untracked and out of every commit.
