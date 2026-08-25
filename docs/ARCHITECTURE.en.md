# Architecture and Maintainer Notes

[English](ARCHITECTURE.en.md) | [中文](ARCHITECTURE.md)

This document is for maintainers and developers who need to understand data behavior. End users should start with the repository README.md, whose installation, usage, privacy, and limitation notes take precedence.

## Architecture boundaries

The plugin has a Host service half and a browser client half:

- The Host service in lib/index.js runs inside the DSH Web host, reads the workspace registry and session persistence, and exposes local HTTP routes.
- The browser client in lib/client.js registers the Archived Chats settings.section and renders state and actions.
- Pure domain logic lives in lib/export.js, lib/import.js, lib/restore.js, lib/metadata.js, lib/search.js, lib/stats.js, lib/insights.js, lib/retention.js, lib/retention-service.js, and lib/lineage.js. lib/trash.js owns the recycle catalog, lib/snapshot.js owns verified snapshots, and lib/recycle.js composes recycle lifecycle operations.

The browser never reads session files directly. All reads and writes go through Host routes.

## Host routes

Current routes:

~~~text
GET  /plugins/dsh-archived-chats/state
GET  /plugins/dsh-archived-chats/stats
GET  /plugins/dsh-archived-chats/insights
POST /plugins/dsh-archived-chats/retention/policy
POST /plugins/dsh-archived-chats/retention/preview
POST /plugins/dsh-archived-chats/retention/apply
GET  /plugins/dsh-archived-chats/lineage
POST /plugins/dsh-archived-chats/preview
POST /plugins/dsh-archived-chats/preview/image
POST /plugins/dsh-archived-chats/search
POST /plugins/dsh-archived-chats/export
POST /plugins/dsh-archived-chats/import/inspect
POST /plugins/dsh-archived-chats/import/restore
POST /plugins/dsh-archived-chats/metadata
GET  /plugins/dsh-archived-chats/trash
POST /plugins/dsh-archived-chats/trash/restore
POST /plugins/dsh-archived-chats/trash/purge
POST /plugins/dsh-archived-chats/trash/empty
POST /plugins/dsh-archived-chats/unarchive
POST /plugins/dsh-archived-chats/unarchive-all
POST /plugins/dsh-archived-chats/delete
POST /plugins/dsh-archived-chats/delete-all
~~~

Every mutating route, plus the preview, preview/image, and search routes that return conversation content, requires the `x-dsh-archived-chats: 1` header. GET trash, preview/image, and export are read-only. `delete` / `delete-all` return `trashed` and `failed`; `trash/restore` returns `restored`; `trash/purge` / `trash/empty` return `purged`, preserving first-request order.

## State and local data

The state route joins archived sessions, workspace, tags, notes, and metadataUpdatedAt for the browser list. Tags and notes are stored only at:

~~~text
$DSH_HOME/plugin-data/archived-chats/metadata.json
$DSH_HOME/plugin-data/archived-chats/trash.json
$DSH_HOME/plugin-data/archived-chats/retention.json
$DSH_HOME/plugin-data/archived-chats/snapshots/
~~~

Metadata and recycle catalogs are versioned. Writes serialize and atomically replace their documents through temporary files. An unreadable or unsupported `trash.json` is preserved byte-for-byte, hides no archived sessions, and disables recycle mutations.

The stats route measures session directories with concurrency four, skips symbolic links, and caches results for 30 seconds. A measurement failure marks only that row unavailable; list and mutation actions continue. Delete invalidates the affected cache row.

Insights joins session measurement with a stream-verified snapshot inventory and counts repeated snapshot attachments only from validated SHA-256 descriptors. The browser keeps totals in summary cards and presents session/snapshot inventories only in bounded searchable dialogs. retention.json uses an exact version-one schema; saving never runs cleanup. Preview issues a five-minute single-use token/nonce and apply revalidates inside the lifecycle queue; recycle candidates still delegate to recycle purge. Lineage uses only durable parentSession edges, caps real nodes at 5,000, never rewrites headers, and resolves titles for at most 100 untitled active source nodes already included in the focused tree.

## Preview and full-text search

Preview accepts visible archived IDs by default and only recycle-catalog IDs with explicit `scope: "trash"`; search remains archive-only. lib/search.js uses Harness append-origin message projection, so replacement copies are never indexed twice. User, assistant, reasoning, tool-call, and tool-result text is searchable, while preview returns bounded pages of structured segments and sanitized image descriptors.

The preview/image authorization sequence is fixed: first require POST and `x-dsh-archived-chats: 1`, then bounded-parse `sessionId` and `attachmentId`; next confirm that the session is still in the currently visible archive set, find an exact image-descriptor match in that session's canonical projection, and only then read bytes through the optional `attachments.readImage` service. Both preview and preview/image recheck visible archive state after asynchronous reads and immediately before sending a response, preventing an overlapping unarchive or delete from exposing stale content. Image bytes use `no-store` and `nosniff`; cross-session, non-archived, and unprojected references are rejected, and error responses never echo filesystem paths. A host without attachment-read capability returns `preview-image-unsupported`; this degrades images only and does not block text, Markdown, reasoning, tool, JSON, or code preview.

Cross-session persistence inspection is limited to four concurrent reads. A broken session is reported in `skipped` while other hits still succeed. Canonical projections use a 30-second TTL, a 64-session LRU, and a per-session cached-code-point cap; oversized sessions remain searchable but do not stay resident. Unarchive, delete, and restore invalidate affected cache entries.

## Export flow

The export route accepts a bounded native form request and export.js writes a versioned ZIP:

~~~text
manifest.json
sessions/001-safe-title-id/session.json
sessions/001-safe-title-id/transcript.md
~~~

session.json preserves the complete metadata and event values returned by persistence, plus archive title, workspace, timestamps, origin, tags, notes, and storage facts. transcript.md is produced with Harness's canonical message projection.

ZIP paths are sanitized and collision-safe. Batch export inspects and writes sessions sequentially, retaining at most one inspected payload. Attachment references can remain in JSON, but attachment bytes and descendant sessions are outside the version-one format.

## Import and restore flow

import/inspect accepts only version-one ZIPs produced by this plugin. Host validation is bounded and checks the manifest, paths, versions, session records, and cross-file consistency before returning a preview:

1. The browser uploads the ZIP and receives session summaries, versions, size, and warnings.
2. Existing session IDs are marked as conflicts and deselected by default.
3. Unresolved workspaces and attachment references are warnings, never invented data.
4. After confirmation, the browser submits a single-use token and selected non-conflicting IDs.
5. restore.js uses a feature-detected adapter to write sessions, metadata, and archive state.
6. Any failure rolls back staged data and never overwrites an existing session.

The confirmation token expires quickly and can be used once. Hosts without the supported writer capability return restore-unsupported without writing.

## Recycle and protection-snapshot lifecycle

`trash.json` permits only `trashed`, `purge-pending`, and `degraded`. Legal transitions are `missing -> trashed`, `trashed/degraded -> purge-pending`, and removal of an existing state after a committed transaction. A `purge-pending` record cannot restore.

Protection manifests use `dsh-archived-chats/snapshot` v1 and session payloads use `dsh-archived-chats/snapshot-session` v1. Each recycle record names one active snapshot; older valid snapshots from restore/recycle cycles remain history until explicit retention application or permanent purge. Exact limits remain 4 MiB manifest, 512 MiB session JSON, 10,000 attachments, 32 MiB each, and 8 GiB total.

Move ordering is: validate archive ownership → dispose or park a live session → capture and verify snapshot → recheck ownership → atomically commit `trashed` → invalidate caches. Ordinary move never removes the persistence artifact.

Restore first rejects an existing-ID conflict. With an intact original it restores archive visibility and removes only the recycle record, without rewriting persistence; the snapshot remains history. With a missing original it completes validation and attachment-identity republishing before writing through public `create` / `append` / `saveImage` capabilities. A failure rolls back the new artifact and retains trash.

Permanent purge persists `purge-pending` before physical writes, then removes the original, snapshot, and recycle record in that order. Startup recovery retries only `purge-pending`, never plain `trashed`. Legacy `pending-deletions.json` is strict read-only migration input: each still-archived ID becomes recoverable trash and is never boot-deleted merely because of the old marker.

## Browser client

client.js registers an order-30 settings.section and uses the DSH rc.7 overlay, state, and design tokens. The page state includes:

- A frame-wide archive success notice in `shell.overlay`: during its effect lifetime the plugin wraps the public `workspaces.archiveSession` method, publishes the latest session ID only after the original call succeeds, and restores the method on unload. The notice defaults to three seconds and tracks pointer/focus pause reasons independently. View follows the Host's accessible Settings trigger and Archived Chats nav label; Undo calls the guarded `/unarchive` route and refreshes the workspace projection. Failures remain retryable and never present false success.
- Archived sessions and workspace groups.
- Search, type/project/tag filters, and sorting.
- Tag and note editor.
- Selected-item export, unarchive, and move to Recycle Bin.
- Archived, Recycle Bin, Storage & Retention, and Origins & Branches tabs; storage and relationship requests load on demand and are cancellable. Storage summary cards open searchable session-directory/snapshot dialogs, keeping retention controls stable regardless of inventory size. The projector retains global capability, while the 0.12 route returns only archived/recycled chats, their ancestor chains, and descendant trees; unrelated active chats are never sent to the browser. Necessary source titles resolve on demand, and a recycle record whose original header is gone still appears as a standalone recycled node. Compact rows use visible spines and elbows for parent/child structure. The DOM uses native list/listitem and disclosure-button semantics instead of claiming an incomplete composite ARIA tree keyboard model while rows also contain Copy ID actions. Rows lead with titles and include project plus localized source/type/delegation/branch metadata and one compact ID. The tree supports per-node and global folding, project filtering that retains required ancestors, and title/project/ID search that temporarily reveals matching paths before restoring the user's fold state. It scrolls independently, defaults only root branches to collapsed above 50 nodes, traverses iteratively, and caps visible guide columns at the nearest 12 levels.
- Import preview, disabled conflicts, and restore results.
- Responsive settings-page markers and sidebar refresh injection.

The preview prefers Harness's publicly exported `MarkdownText`, `DisclosureRow`, and `JsonBlock`. When a public primitive is unavailable, only that content falls back to escaped plain text, native `details`/`summary`, or `pre`; the plugin never reaches into a private chat renderer. A tool result folds into an earlier call only when its `toolCallId` exactly matches the call's `callId`, consuming matches in chronological order. Unmatched results remain standalone, and errors use the semantic error token. Images are read from the protected route into Blob URLs, may load lazily before entering the viewport, and abort their read and call `URL.revokeObjectURL` when the preview closes or the image node unmounts.

The turn rail remains part of the preview: on desktop it stays to the left of the feed, jumps and follows feed scrolling, and exposes the active turn through `aria-current`; at 640px or narrower it moves above the feed and scrolls horizontally while user bubbles retain useful width. It is not replaced by a private host navigation component.

The browser never mutates files directly. After an operation, the Host response becomes the new list baseline. Closing a preview or switching to another session aborts the pending request, and a request sequence ignores late responses so a closed dialog cannot reopen and an older session cannot replace the newest preview.

## Security and failure policy

- All state-changing routes require POST and the guard header.
- Import limits ZIP size, entries, paths, versions, and JSON structure, rejecting traversal, duplicates, and prototype-pollution keys.
- Ordinary delete never invokes physical purge; only a committed recycle record can enter purge.
- Snapshot and recycle documents use `0600`, directories use `0700`, and publication is temporary write, sync, atomic rename.
- Purge removes snapshot attachment copies but does not promise immediate cleanup of identical bytes still retained by Harness's global attachment store.
- Unknown host capabilities must degrade or return a clear error; they must not be inferred.

## Compatibility and testing

The complete 0.12.0 target is DeepSeek Harness 0.1.1-rc.2. Version 0.11.x tolerates multiple valid snapshots but does not display or govern history; back up the complete plugin-data directory before downgrading.

Coverage includes:

- export.js records, transcripts, and ZIP streaming.
- import.js bounded validation and unsafe-path rejection.
- restore.js transactional commit, rollback, and unsupported capabilities.
- metadata.js versioning, concurrency, and atomic writes.
- stats.js symlink handling, caching, and concurrency limits.
- search.js message projection, Unicode search, pagination, partial failures, and TTL/LRU caching.
- trash.js, snapshot.js, and recycle.js format validation, concurrency, recovery, rollback, crash intent, and legacy migration.
- insights.js, retention.js, retention-service.js, and lineage.js trusted accounting, policy bounds, short-lived authority, revalidation, and bounded graph projection.
- Host routes and browser settings smoke/responsive behavior.

Run:

~~~sh
npm test
npm pack --dry-run --json
~~~
