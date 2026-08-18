# Archive Insights 0.6.0 Design

## Status

Approved product direction. This specification defines the first of two planned product increments:

- `0.6.0`: archive organization and storage insights
- `0.7.0`: export and backup

The split keeps the new metadata store and the future high-volume download path independently testable and releasable.

## Context

`dsh-archived-chats` 0.5.1 manages the lifecycle of sessions after they leave the ordinary Harness sidebar. It can list, search, filter, sort, unarchive, and permanently delete archived sessions. It does not yet help users classify archived material or understand its local storage cost.

The existing host entry is intentionally dependency-free and already owns one small plugin data file for pending deletions. The client is a self-contained Harness settings section. Version 0.6.0 extends those boundaries without changing how Harness itself archives sessions.

## Goals

1. Let users attach tags and a private note to an archived session.
2. Preserve that metadata when a session is unarchived and restore it if the session is archived again.
3. Remove metadata only after permanent physical deletion succeeds.
4. Show per-session and aggregate local storage usage without slowing the ordinary archive listing.
5. Let search and filtering use the new metadata.
6. Preserve the current deletion, deferred-deletion, unarchive, localization, accessibility, and rc.7 compatibility behavior.
7. Add no runtime dependency or database.

## Non-goals

- Export, backup, ZIP generation, or Markdown conversion. These belong to 0.7.0.
- Automatic archive, automatic deletion, retention policies, or scheduled work.
- Full-text search inside session transcripts.
- Cloud synchronization or metadata sharing between machines.
- Replacing Harness workspace/session persistence or changing its archive semantics.
- Migrating pending deletions into the new metadata document.

## Architecture

### Module boundaries

The host gains two focused modules while `lib/index.js` remains the composition and HTTP boundary:

- `lib/metadata.js`: validates, reads, serializes, and atomically writes user-owned archive metadata.
- `lib/stats.js`: resolves session directories and measures their file count and byte size.
- `lib/index.js`: composes both services with the existing registry/persistence services and owns HTTP validation and lifecycle cleanup.
- `lib/client.js`: renders summary, tag, note, filter, and editor UI through the existing `settings.section` registration.

No unrelated rewrite of the current host or client bundle is part of this release.

### Metadata store

Metadata lives at:

```text
$DSH_HOME/plugin-data/archived-chats/metadata.json
```

The versioned schema is:

```json
{
  "version": 1,
  "sessions": {
    "session-id": {
      "tags": ["important", "research"],
      "note": "Reusable findings for the plugin roadmap.",
      "updatedAt": "2026-08-18T12:00:00.000Z"
    }
  }
}
```

Rules:

- A session has at most 8 tags.
- A tag is trimmed, non-empty, and at most 24 Unicode code points.
- Duplicate tags compare case-insensitively while preserving the first spelling.
- A note preserves internal newlines, trims surrounding whitespace, and is at most 2,000 Unicode code points.
- Empty tags plus an empty note removes the session entry instead of storing an empty object.
- Unknown top-level versions are rejected rather than rewritten.
- A missing file is an empty store.
- Invalid JSON or an invalid schema makes the store unavailable. Reads return empty entries plus an `unavailable` status so the archive list remains usable; mutations fail with a stable error and never overwrite the unreadable file.

Writes are serialized through one promise queue. Each save writes a complete temporary sibling file and renames it over `metadata.json`, so a process interruption cannot leave a partially written document. The module exposes operations equivalent to:

```js
getMany(sessionIds)
set(sessionId, { tags, note })
remove(sessionIds)
```

### Metadata lifecycle

- `GET /state` joins metadata onto every archived row as `tags`, `note`, and `metadataUpdatedAt`, and adds top-level `metadataStatus: "ready" | "unavailable"`.
- Unarchive operations do not mutate metadata.
- Re-archiving the same session ID makes its metadata visible again.
- A cold or in-place permanent delete attempts to remove metadata only after the session directory has been removed.
- A parked/deferred delete retains metadata until the boot sweep completes physical deletion.
- A failed delete retains metadata.
- If the metadata store is unavailable after physical deletion succeeds, the session delete still succeeds and logs a cleanup warning; the unreadable metadata file is never rewritten merely to remove the stale entry.
- The plugin does not prune metadata merely because a session is temporarily absent from the archive list.

This ordering makes session data authoritative: metadata cannot disappear before the session itself is irrecoverable.

### Storage statistics

Statistics use `sessionPersistence.list()` and `sessionPersistence.locate(header)` to resolve the session log path. Measurement starts at the log's parent directory and recursively counts regular-file bytes and regular files. Symbolic links are skipped and never followed outside the session directory.

Statistics are separate from `GET /state`:

```text
GET /plugins/dsh-archived-chats/stats
```

The response shape is:

```json
{
  "summary": {
    "sessionCount": 12,
    "totalBytes": 4819200,
    "unavailableCount": 1
  },
  "sessions": {
    "session-id": {
      "sizeBytes": 401600,
      "fileCount": 3,
      "status": "ready"
    }
  }
}
```

`status` is `ready` or `unavailable`. One unreadable or missing session never fails the whole response. Unavailable rows use `sizeBytes: null` and `fileCount: null` and contribute to `unavailableCount`, not `totalBytes`.

The service measures at most four session directories concurrently and caches results for 30 seconds. Delete invalidates the affected cache entry. The cache is process-local and disposable; no statistics are written to disk.

### HTTP surface

Version 0.6.0 adds two routes:

```text
GET  /plugins/dsh-archived-chats/stats
POST /plugins/dsh-archived-chats/metadata
```

The metadata request body is:

```json
{
  "sessionId": "session-id",
  "tags": ["important"],
  "note": "Follow up next week."
}
```

The POST route requires the existing `x-dsh-archived-chats: 1` guard header. It accepts only a session ID currently present in `workspaceRegistry.archivedSessionIds`; metadata retained for an unarchived session cannot be edited until it is archived again. Successful responses return the normalized metadata entry.

Validation errors return HTTP 400 with stable codes. A missing archived session returns 404. An unreadable store returns 503 with `metadata-store-unavailable` only for the metadata mutation; `/state` continues returning ordinary session rows with `metadataStatus: "unavailable"`. Other unexpected failures return 500 and are logged without including note contents.

### Client experience

The settings page keeps its existing hierarchy and adds:

1. A compact summary strip below the title showing archived count, measured size, and unavailable measurement count.
2. A tag filter alongside the existing type and project filters.
3. Search matching title, workspace title, tags, and note text locally.
4. Per-row storage size and tag chips. More than three tags collapse into a `+N` indicator.
5. A metadata edit action that opens an accessible dialog with a tag editor and note textarea.

The editor rules mirror host validation and display remaining tag/note limits. Save is disabled while a request is running. A successful save updates the row in place and uses the existing success toast. A failed save keeps the dialog and unsaved input open and uses the existing error notice. When `/state` reports unavailable metadata, the page shows a warning and disables only metadata editing; search, statistics, unarchive, and deletion remain available.

Statistics load independently after the archive list. Until then, the summary and row sizes show a neutral loading state. A statistics failure leaves all archive management functions usable and shows one dismissible warning. Empty archives show zero bytes without calling the statistics route again.

On narrow screens the summary wraps, tag chips stay within the title column, and the metadata dialog uses the existing responsive modal width. All controls have Chinese and English labels, keyboard focus management, and reduced-motion behavior consistent with 0.5.1.

## Data flow

### Page load

1. Client requests `/state`.
2. Host lists archived sessions and joins metadata from one store read; an unreadable store yields empty metadata plus `metadataStatus: "unavailable"`.
3. Client renders rows immediately.
4. Client requests `/stats` when at least one row exists.
5. Host measures or returns cached statistics.
6. Client merges results by session ID without replacing archive state.

### Metadata save

1. User edits tags/note in the dialog.
2. Client validates limits and posts normalized input.
3. Host verifies the session is currently archived and validates again.
4. Metadata store serializes the mutation and atomically replaces the file.
5. Host returns the canonical entry.
6. Client updates only that row, closes the dialog, and announces success.

### Permanent delete

1. Existing deletion path removes the session directory and registry indexes.
2. After physical deletion succeeds, the plugin invalidates statistics and attempts metadata removal.
3. If disposal is deferred or any delete step fails, metadata remains intact.
4. Metadata cleanup failure never changes a completed physical delete into a failed delete response.

## Failure handling and safety

- Metadata corruption never triggers an automatic empty rewrite and never blocks the base archive list.
- Notes and tags are rendered as React text, never as HTML.
- Logs include session IDs and stable error codes but never note contents.
- Statistics never follow symlinks and never escape the located session directory.
- Statistics failure is non-blocking and cannot disable unarchive or deletion.
- Metadata read/write/cleanup failure cannot disable unarchive or physical deletion.
- Metadata writes are atomic and serialized; simultaneous saves cannot interleave documents.
- All mutating requests retain the current CSRF guard.
- Existing `data/` development artifacts are outside runtime storage and remain untouched.

## Testing strategy

### Metadata unit tests

- Missing store returns empty metadata.
- Valid version-1 data round-trips.
- Tag trimming, de-duplication, limits, and note limits are enforced.
- Empty metadata removes an entry.
- Unarchive retention and permanent-delete cleanup ordering are covered through host tests, including successful physical deletion when metadata cleanup is unavailable.
- Invalid JSON/version keeps reads available with an unavailable status, rejects mutations, and never overwrites the source file.
- Concurrent saves serialize without dropping either session.

### Statistics unit tests

- Nested regular files produce exact byte and file totals.
- Symbolic links are skipped and not followed.
- Missing/unreadable paths produce `unavailable` without rejecting the batch.
- Concurrency never exceeds four measurements.
- Cache reuse and delete invalidation are deterministic.

### Host integration tests

- Seven routes register after services bind: the existing five plus metadata and stats.
- `/state` joins metadata, reports metadata availability, and preserves all existing fields even when the store is unreadable.
- Metadata POST guard, validation, 404, success, and store-unavailable responses are stable.
- Deferred deletion retains metadata; completed deletion removes it when the store is healthy and still succeeds when metadata cleanup is unavailable.
- Statistics include only visible archived sessions, excluding pending-deletion rows.

### Client smoke tests

- Summary, tag filter, row chips, size labels, and editor controls render.
- Search includes tags and notes.
- Save sends the guarded request and applies the canonical response.
- Failed save preserves unsaved input.
- Statistics failure does not remove or disable existing lifecycle actions.
- Existing sorting, selection, accessibility, rc.7 token, and hostile-host-DOM tests remain green.

### Release verification

- Full `npm test` and syntax checks.
- `npm pack --dry-run --json` contains only intended runtime files.
- Local linked Harness rc.7 returns 200 for state and stats.
- Real-host visual pass in light and dark themes when browser access is available.

## Rollout and compatibility

- Package version becomes `0.6.0` because this adds user-facing capabilities without breaking the current API.
- The metadata schema starts at version 1; there is no migration from 0.5.1 because no previous metadata file exists.
- Existing pending-deletion files remain compatible and independent.
- The plugin continues registering the top-level `settings.section`; it does not use the rc.7 keyed `settings.plugin.item` slot.
- If the installed Harness lacks `persistence.locate`, archive management and metadata remain available while statistics return unavailable measurements.

## Acceptance criteria

Version 0.6.0 is ready when:

1. Users can create, edit, filter, search, retain, and permanently remove session metadata according to this lifecycle when the metadata store is healthy.
2. The page reports exact readable storage totals and isolates unreadable sessions.
3. A broken metadata or statistics subsystem cannot corrupt session data or disable existing archive operations.
4. All new behavior is covered by observed red-green tests and the existing 0.5.1 suite remains green.
5. The local rc.7 plugin link loads the release candidate without a plugin-loader error.

## Next increment: 0.7.0

Export and backup will get a separate design because it introduces potentially large response streams, transcript format conversion, file naming, and batch packaging. Its design will build on versioned metadata so exported bundles can include tags and notes without coupling export behavior into the 0.6.0 store.
