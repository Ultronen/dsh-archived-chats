# Task 1 Report: Versioned Recycle Catalog and Strict Legacy Reader

## Implementation

- Added `lib/trash.js` with `TRASH_VERSION`, `TrashStoreError`, strict record normalization, UUID/state/disposition validation, deep cloning, deterministic ID selection, and strict legacy pending parsing.
- Added an atomic, serialized `createTrashStore({ path, now })` with missing-file readiness, fail-closed corruption handling, whole-document replacement through mode-0600 temporary files, lifecycle transitions, idempotent removal, summaries, and `markDegraded` (including idempotent degraded marking and purge-pending protection).
- Added `lib/trash.js` to the package `files` list without changing dependencies or package version.

## Tests and results

- Focused: `rtk node --test test/trash.test.mjs` — 8/8 passing.
- Full suite: `rtk npm test` — 51/51 passing; exit 0.
- Hygiene: `rtk git diff --check` — clean.

## RED evidence

Before `lib/trash.js` existed, the first focused run failed as expected with `ERR_MODULE_NOT_FOUND` for `lib/trash.js` imported by `test/trash.test.mjs`.

## GREEN evidence

After the implementation, the focused suite reported 8 passing tests and 0 failures. The fresh full suite reported 51 passing tests and 0 failures, including the existing production behavior tests.

## Files

- `lib/trash.js`
- `test/trash.test.mjs`
- `package.json`

## Self-review

- Mutations load within a single per-store promise queue, clone records before applying changes, and write atomically.
- Unsupported versions, malformed records, unsafe record keys, and malformed legacy input are unavailable and never rewritten.
- Transition rules reject purge-pending restoration/downgrade; `markDegraded` supports trashed-to-degraded and degraded-to-degraded while preserving the durable pending-purge state.
- Legacy input accepts only an object with exactly one `ids: string[]` field, de-duplicates IDs in first-seen order, treats ENOENT as ready-empty, and performs no writes.

## Concerns

- `list`, `get`, and `summary` expose empty read results when the catalog is unavailable; callers must inspect `load().status` when they need to distinguish unavailable from empty.
- Snapshot existence/content verification and startup migration orchestration are intentionally deferred to later tasks.
