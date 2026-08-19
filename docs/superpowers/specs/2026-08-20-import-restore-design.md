# Import and Restore 0.8.0 Design

## Status

Approved product direction for the next iteration. This specification defines
the `0.8.0` increment:

- Import only this plugin's version-one export packages.
- Validate the complete ZIP before changing Harness state.
- Restore selected archived sessions atomically.
- Skip existing session IDs and report them; never overwrite silently.

## Context

Version `0.7.0` produces a versioned ZIP containing `manifest.json`, one
authoritative `session.json` per session, and a human-readable
`transcript.md`. The JSON record preserves the archive descriptor plus the
lossless `source.meta` and `source.events` returned by Harness persistence.
Import was deliberately deferred because writing a valid Harness session is a
host-specific operation and a partial write would be worse than no restore.

Version `0.8.0` adds a guarded import flow. It must never infer a disk layout
from an archive or treat Markdown as a source of truth. The importer validates
the package, presents a preview, and hands writes to a feature-detected host
restore adapter with an explicit staging/commit/rollback contract.

## Goals

1. Let a user select a ZIP produced by `dsh-archived-chats` `0.7.0` or later.
2. Validate package structure, schema versions, paths, limits, and cross-file
   consistency before any persistence or registry mutation.
3. Preview sessions, titles, workspaces, tags, notes, sizes, conflicts, and
   warnings before confirmation.
4. Restore a user-selected subset as archived sessions.
5. Preserve session IDs when they do not conflict, along with archive metadata,
   tags, and notes.
6. Make a failed batch all-or-nothing from the user's perspective.
7. Report restored, skipped, and failed items with stable reason codes.
8. Keep the importer bounded in memory and safe against hostile ZIP contents.

## Non-goals

- Overwriting, merging, or silently copying an existing session.
- Importing Markdown, arbitrary JSON, Harness official Session-log packages, or
  packages with unknown format/version markers.
- Restoring attachment bytes, descendant sessions, or external references.
- Uploading, syncing, decrypting, or password-managing backups.
- Automatically creating or renaming user workspaces.
- Changing the existing export format or metadata-store schema.

## Package Acceptance

The importer accepts a ZIP only when all of the following are true:

- exactly one root `manifest.json` exists;
- `manifest.format` is `dsh-archived-chats/export` and `manifest.version` is `1`;
- `manifest.sessionCount` is an integer from 1 through 2,000 and equals the
  number of manifest sessions;
- every manifest session has a unique non-empty string `id` and points to one
  `session.json` and one `transcript.md` under `sessions/`;
- every referenced JSON file exists exactly once and has
  `format: dsh-archived-chats/session`, `version: 1`, and a matching
  `archive.id`;
- every referenced Markdown file exists exactly once; its content is retained
  only for preview/diagnostics and is never parsed for restore;
- no unreferenced entries exist except ZIP directory markers;
- entry names are relative, UTF-8, normalized, free of `..`, backslashes,
  control characters, and NUL bytes;
- compressed and uncompressed package limits are respected: 256 MiB total
  uncompressed, 512 MiB compressed, 2,000 sessions, 4 MiB per JSON record,
  and 8 MiB per Markdown transcript;
- declared size, title, workspace, tags, note, storage, and timestamps match
  between the manifest item and its session record;
- JSON is valid, finite, and contains no prototype-polluting keys in objects
  consumed by the importer (`__proto__`, `constructor`, and `prototype`).

Validation uses the ZIP central directory and bounded entry readers. The
implementation rejects duplicate names before extracting and never extracts
into the real DSH data directory. A package that fails any check produces a
single validation error and cannot reach the restore adapter.

## Restore Policy

### Identity and conflicts

The archive session ID is the requested restored ID. Before confirmation, the
host takes a fresh snapshot of known persistence headers and the archive set.
If an ID already exists in persistence, the item is marked `conflict` and is
skipped. The importer never overwrites it, even if its current session is
unarchived or its metadata differs.

IDs are deduplicated in manifest order. A duplicate in the manifest is a
validation error rather than an implicit merge.

### Archive state

Successfully restored sessions are added to the workspace registry's archived
ID set in the same lifecycle transaction as the persistence commit. They remain
hidden from the normal chat sidebar and appear in this plugin immediately after
refresh. Existing archive membership is a conflict, not a reason to mutate the
existing session.

### Workspaces

The importer attempts an exact workspace-ID match against the current registry.
When the source workspace is missing or no longer exists, the session is
restored without workspace membership and the result includes a
`workspace-unresolved` warning. The importer never creates a workspace or
silently attaches a session to the user's current project. Source workspace
title/path remain in the archive descriptor for later manual organization.

### Metadata and attachments

Tags and notes are restored through the existing version-one metadata store
after the session commit. The same normalization limits apply (at most eight
tags, 24 Unicode characters per tag, and a 2,000-character note). Invalid
metadata is a package validation error, not a lossy truncation.

Attachment blocks remain in `source.events` as references. Because
`attachmentsIncluded` is false in the version-one format, no attachment bytes
are written and the preview says that referenced files are not restored.

## Architecture

### `lib/import.js`

New focused module responsible for pure import-domain behavior:

- bounded ZIP indexing and entry reads;
- manifest/session schema validation;
- safe-entry and limit checks;
- cross-file consistency checks;
- preview model construction;
- stable reason codes and result summaries.

It has no access to DSH services and performs no writes. Its public boundary is
`inspectImport(source)` returning either `{ ok: false, errors }` or a validated
plan containing selected session records and warning metadata.

### `lib/restore.js`

New host-facing module with two explicit interfaces:

```text
createRestoreAdapter({ context, persistence, registry, metadataStore })
  .prepare(records, options) -> transaction

transaction.stage(record)
transaction.commit()
transaction.rollback()
```

The adapter is feature-detected against the running Harness build. It must use
the host's supported persistence writer/serializer for `{ id, meta, events }`;
it must not construct `session.jsonl.zstd` or other private files by hand. If a
required writer or transaction hook is absent, preview remains available but
confirmation returns `restore-unsupported` without touching state.

The adapter stages each session in a private temporary area, verifies that the
host can inspect the staged record, then commits persistence, metadata, and
archive registry state in a defined order. Rollback removes staged files and
reverts any registry or metadata changes already made by the transaction.

### `lib/index.js`

The host registers two routes:

```text
POST /plugins/dsh-archived-chats/import/inspect
POST /plugins/dsh-archived-chats/import/restore
```

Both routes require the existing `x-dsh-archived-chats: 1` guard. The inspect
route accepts `multipart/form-data` with one ZIP field, enforces the package
limits while reading, and returns the preview model. The restore route accepts
the validated package token plus an ordered list of selected IDs and a
confirmation nonce issued by inspect. The token and nonce are short-lived,
single-use, same-process values; the ZIP is never trusted again merely because
the client repeats an ID list.

Before restore, the host rechecks every selected ID against the current
persistence snapshot and metadata store. Any newly appearing conflict is
skipped and reported. The response is JSON and contains:

```json
{
  "ok": true,
  "restored": ["session-a"],
  "skipped": [{ "id": "session-b", "reason": "id-conflict" }],
  "warnings": [{ "id": "session-a", "reason": "workspace-unresolved" }]
}
```

### `lib/client.js`

The existing settings page gains an `Import backup` action. It opens a native
file picker constrained to `.zip`, submits the file to the inspect route, and
renders a preview dialog with:

- package validity and generator/version;
- selectable session rows;
- title, workspace, tags, note, stored size;
- conflict and attachment-reference warnings;
- restored-count and total-size summary;
- disabled confirmation when no session is eligible.

Confirmation submits the short-lived token, nonce, and selected IDs. The dialog
stays open while restoring, then shows the result counts and refreshes the
archive list. Cancel and validation failure discard the in-memory package
without changing Harness state. The UI does not display raw transcript content
by default and never inserts archive Markdown as HTML.

## Data Flow

1. User chooses a ZIP from the settings page.
2. The browser sends it to `/import/inspect` with the mutation guard.
3. The host writes only to a private temporary upload file, indexes the ZIP,
   validates all entries and schemas, and creates a short-lived import token.
4. The host snapshots current IDs, builds the preview, and returns it.
5. User selects eligible sessions and confirms.
6. The host verifies the token/nonce, rechecks IDs and conflict state, and
   creates a restore transaction.
7. The transaction stages each selected `source.meta` and `source.events`,
   verifies the staged records, then commits persistence, metadata, and archive
   membership atomically.
8. On success, the temporary upload and token are deleted and the result is
   returned. On any failure, rollback runs before the error response and the
   upload is deleted.

## Failure Handling and Safety

- No write occurs during inspection, including no metadata normalization write.
- Temporary uploads use a private directory with restrictive permissions and
  are removed on success, cancellation, expiration, and process shutdown when
  possible.
- Tokens expire after 10 minutes and are single-use; restore requests cannot
  replay an old package.
- ZIP bombs, duplicate entries, traversal paths, oversized records, invalid
  UTF-8, unsupported versions, and manifest/session mismatches fail closed.
- Existing IDs are skipped, not overwritten. A race that creates an ID between
  preview and commit is treated as a conflict and does not abort unrelated
  sessions.
- A restore adapter failure rolls back all sessions in that transaction. If
  rollback itself fails, the host returns `restore-rollback-failed`, logs only
  stable IDs/reason codes, and marks the transaction for a startup recovery
  sweep rather than pretending success.
- Session content, notes, and transcript text never enter logs.
- Attachment references are displayed as warnings and remain references only.
- The import routes reject GET and cross-origin requests; browser UI uses the
  existing same-origin guard header.

## Testing Strategy

### Import Unit Tests

- Valid single and batch `0.7.0` packages produce the expected preview.
- Unknown format/version, missing files, extra entries, duplicate entries,
  duplicate IDs, path traversal, invalid JSON, prototype keys, and all size
  limits are rejected.
- Manifest/session descriptor mismatches are reported with stable field-level
  reasons.
- Selection preserves manifest order and filters conflicts without mutating
  the validated records.

### Restore Adapter Tests

- A fake host writer receives the original `meta` and `events` losslessly.
- Exact workspace matches are retained; missing workspaces become ungrouped
  with a warning; no workspace is created.
- Tags and notes use the existing metadata limits and are committed once.
- Same-ID conflicts are skipped without calling the writer.
- A failure at each stage invokes rollback and leaves no staged files, archive
  IDs, or metadata entries.
- A commit race is reported as `id-conflict` while independent sessions restore.
- Missing host writer/transaction support returns `restore-unsupported` and
  performs no writes.

### Host and Client Integration Tests

- Inspect and restore routes enforce POST and the mutation guard.
- Uploads over the limits are rejected before extraction.
- Inspect returns a preview token; expired or replayed tokens fail.
- Restore returns stable restored/skipped/warning counts and refreshes state.
- Existing export, metadata, statistics, unarchive, delete, theme, locale,
  accessibility, and rc.7 compatibility tests remain green.

### Release Verification

- Full `npm test` and syntax checks.
- `npm pack --dry-run --json` includes the new host modules and excludes
  development `data/`.
- On a real Harness rc.7-compatible host, a backup exported by `0.7.0` can be
  inspected and restored into an isolated test profile.
- A forced mid-transaction failure proves that no partial session remains.
- Desktop/mobile and light/dark checks confirm the import dialog does not
  overlap existing archive controls.

## Compatibility and Rollout

- Minimum supported Harness remains `0.1.0-rc.7` and Node.js 18.
- The import format is independent of the npm package version and accepts only
  `dsh-archived-chats/export` v1 plus `dsh-archived-chats/session` v1.
- `0.8.0` adds no migration to `metadata.json`.
- Hosts without the restore writer remain fully functional for listing,
  export, and preview, but show `restore-unsupported` on confirmation.
- Import is disabled by default until the host capability probe passes; the
  UI still exposes inspection so users can diagnose package compatibility.
