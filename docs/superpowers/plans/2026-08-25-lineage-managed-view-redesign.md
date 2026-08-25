# Managed Lineage View Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Origins & Branches show only archived/recycled chats as managed objects, preserve only necessary ancestor context, and replace the horizontally scrolling debug-like tree with a compact searchable card hierarchy.

**Architecture:** Keep `projectLineage()` as the pure authoritative projector, but change focused projection from “focused node plus every descendant” to “every managed focus node plus its ancestor path.” The client continues consuming the forest, renders active/missing ancestors as lightweight context strips, and renders archived/recycled nodes as full relationship cards. Existing iterative filtering, folding, diagnostics, and copy-ID behavior stay bounded and accessible.

**Tech Stack:** Node.js ESM, DSH client module React runtime, CSS-in-JS string, Node test runner, Playwright browser verification.

**Spec:** `docs/superpowers/specs/2026-08-24-storage-retention-lineage-design.md`

## Global Constraints

- Default scope contains archived and recycle-bin sessions only; unrelated active descendants are excluded.
- Active or missing ancestors may remain only when required to explain a managed session's origin.
- An untitled active ancestor is labelled as unavailable source information, not as a new “untitled chat.”
- The visual reference `/var/folders/ys/gql_w5s5753b185hyw_l7j000000gn/T/codex-clipboard-ClA9YR.png` supplies layout density and styling only; its integrations content is not product truth.
- Keep native list/disclosure semantics, search path expansion, project filtering, large-tree defaults, diagnostics, and exact ID copy.
- No horizontal scrolling in the relationship list.
- Do not commit, push, tag, publish, or delete existing screenshots.

---

### Task 1: Correct Focused Lineage Projection

**Files:**
- Modify: `test/lineage.test.mjs`
- Modify: `lib/lineage.js`
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: `projectLineage({ headers, archivedIds, trashRecords, workspaces, titles, focusIds })`.
- Produces: the same `{ roots, diagnostics, nodeCount }` response shape, with only managed focus nodes and necessary ancestor paths included.

- [x] **Step 1: Write a failing unit test** proving an archived root does not include an unrelated active child.
- [x] **Step 2: Extend the test** proving an active intermediate ancestor remains when it connects two managed nodes.
- [x] **Step 3: Run `node --test test/lineage.test.mjs`** and confirm the old descendant-inclusive projection fails.
- [x] **Step 4: Replace descendant expansion** with inclusion of every focus node plus its ancestor chain.
- [x] **Step 5: Run the lineage and route tests** and confirm unrelated active sessions are neither returned nor inspected for titles.

### Task 2: Redesign Relationship Rows and Toolbar

**Files:**
- Modify: `test/smoke.test.mjs`
- Modify: `lib/client.js`

**Interfaces:**
- Consumes: the unchanged lineage forest response.
- Produces: `ArchiveRelationshipsPanel` with search, project/status filtering, result count, fold controls, compact context strips, managed relationship cards, and a bottom scope note.

- [x] **Step 1: Write failing client tests** for compact context labels, managed-only status filtering, visible managed count, no “untitled source chat” primary row, and preserved copy-ID/disclosure behavior.
- [x] **Step 2: Run `node --test test/smoke.test.mjs`** and confirm the existing full-width active rows and toolbar fail the new expectations.
- [x] **Step 3: Add localized copy** for status filtering, managed count, source context, unavailable source information, and the bottom scope note.
- [x] **Step 4: Extend `filterLineageForest()`** with a managed-status filter while preserving ancestors of matching nodes.
- [x] **Step 5: Render active/missing ancestors as context strips** and archived/trash nodes as full cards with title, relation, project/type/date metadata, status, compact ID, copy action, and disclosure control.
- [x] **Step 6: Replace lineage CSS** with a responsive card list using `min-width:0`, `width:100%`, and `overflow-x:hidden`; retain vertical scrolling and connector rails.
- [x] **Step 7: Run smoke tests** and verify search, project filter, status filter, collapse/expand, deep iterative rendering, diagnostics, and copy ID.

### Task 3: Browser Design QA and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-24-storage-retention-lineage-design.md`
- Modify: `design-qa.md`
- Optionally create after acceptance: `assets/screenshots/14-origins-branches.png`

**Interfaces:**
- Consumes: the synthetic release profile and local DSH server.
- Produces: browser evidence for the redesigned managed lineage view.

- [x] **Step 1: Update the spec** to state that focused projection excludes unrelated active descendants and active ancestors are context-only.
- [x] **Step 2: Run `npm test`, syntax checks, and `git diff --check`.**
- [x] **Step 3: Open the isolated DSH profile** and verify search, project/status filters, collapse/expand, copy ID, narrow layout, and zero horizontal scrolling.
- [x] **Step 4: Capture a desktop screenshot** at the release viewport and a focused relationship-list screenshot.
- [x] **Step 5: Compare the implementation with the layout/style reference** in one combined image; treat the approved DSH content rules as authoritative.
- [x] **Step 6: Update `design-qa.md`** with browser evidence and end with exactly `final result: passed` only when no P0/P1/P2 issue remains.

