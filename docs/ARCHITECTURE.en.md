# Architecture and Maintainer Notes

[English](ARCHITECTURE.en.md) | [中文](ARCHITECTURE.md)

This document is for maintainers and developers who need to understand data behavior. End users should start with the repository README.md, whose installation, usage, privacy, and limitation notes take precedence.

## Architecture boundaries

The plugin has a Host service half and a browser client half:

- The Host service in lib/index.js runs inside the DSH Web host, reads the workspace registry and session persistence, and exposes local HTTP routes.
- The browser client in lib/client.js registers the Archived Chats settings.section and renders state and actions.
- Pure domain logic lives in lib/export.js, lib/import.js, lib/restore.js, lib/metadata.js, lib/stats.js, and lib/interop/{format,report,codex,claude}.js so it can be tested independently.

The browser never reads session files directly. All reads and writes go through Host routes.

## Host routes

Current routes:

~~~text
GET  /plugins/dsh-archived-chats/state
GET  /plugins/dsh-archived-chats/stats
POST /plugins/dsh-archived-chats/export
POST /plugins/dsh-archived-chats/import/inspect
POST /plugins/dsh-archived-chats/import/restore
POST /plugins/dsh-archived-chats/interop/inspect
POST /plugins/dsh-archived-chats/interop/export
POST /plugins/dsh-archived-chats/metadata
POST /plugins/dsh-archived-chats/unarchive
POST /plugins/dsh-archived-chats/unarchive-all
POST /plugins/dsh-archived-chats/delete
POST /plugins/dsh-archived-chats/delete-all
~~~

Every mutating route, plus browser-initiated external-format import and export, requires the x-dsh-archived-chats: 1 header. Export is read-only. Unarchive writes through the workspace registry state path and broadcasts archived-sessions-changed to connected clients.

## State and local data

The state route joins archived sessions, workspace, tags, notes, and metadataUpdatedAt for the browser list. Tags and notes are stored only at:

~~~text
$DSH_HOME/plugin-data/archived-chats/metadata.json
~~~

The metadata file is versioned. Writes are serialized and replace the file through a temporary-file rename. Unreadable or unsupported versions are never overwritten.

The stats route measures session directories with concurrency four, skips symbolic links, and caches results for 30 seconds. A measurement failure marks only that row unavailable; list and mutation actions continue. Delete invalidates the affected cache row.

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

## External-tool interoperability flow

Four pure modules form the interoperability boundary: format.js defines and validates the exchange model, report.js aggregates losses, warnings, and conflicts, and codex.js plus claude.js read and project their respective JSONL formats. The canonical model fixes format: "dsh-interop" and formatVersion: 1, with source, sourceVersion, sessions, and a SHA-256 digest. Each session projection carries an ID, title, workspace, messages, attachment references, losses, and source. Harness events remain authoritative; the exchange model and target JSONL are adapter projections only.

External import flow:

1. The browser uploads a source and one JSONL file to interop/inspect as multipart with the guard header.
2. Host reads within an 8 MiB request cap; adapters further bound line count, line bytes, nesting depth, and collection size. Unknown or malformed records enter the report, never log bodies.
3. Host returns only sanitized session summaries, a report, and a short-lived token. The browser shows fidelity, losses, warnings, and existing-ID conflicts.
4. Confirmation calls the existing import/restore route. Interop sessions are converted to valid Harness restore records and then use the same conflict recheck, feature detection, transactional commit, and rollback path.

External export flow:

1. The browser chooses a target and archived IDs, then requests the guarded interop/export download.
2. Host rechecks that every ID is still a visible archived session, reads each authoritative persistence record, and projects it to Codex or Claude Code JSONL.
3. The browser downloads the response through a Blob. The output is explicitly a readable migration or handoff transcript; native target-tool resume is not promised, and attachment bytes are absent.

Inspection and export do not mutate external source files, target-tool directories, or DSH archive records. Adapters do not read credentials, MCP keys, or local tool configuration, and Host logs must not contain raw messages or local paths.

## Deletion lifecycle

A cold delete confirms the physical location, removes the session log, workspace record, and registry indexes, then cleans metadata and stats caches.

For a live session, the plugin first attempts the official lifecycle order:

~~~text
cancel(disposed)
  -> whenIdle
  -> flush
  -> agent.scope.dispose()
  -> detach agents and sessions
  -> retire persistence writer
  -> remove session files
~~~

These are internal host surfaces and every call is feature-detected. If a required surface is missing, the plugin does not guess at internal objects. It records the ID in:

~~~text
$DSH_HOME/plugin-data/archived-chats/pending-deletions.json
~~~

The parked session remains archived and hidden, and the next boot sweeps the queue. In-place deletes use the same queue as a crash bracket: record before disposal, clear after files are confirmed gone.

## Browser client

client.js registers an order-30 settings.section and uses the DSH rc.7 overlay, state, and design tokens. The page state includes:

- Archived sessions and workspace groups.
- Search, type/project/tag filters, and sorting.
- Tag and note editor.
- Selected-item export, unarchive, and delete.
- Import preview, disabled conflicts, and restore results.
- Codex / Claude Code source and target selectors, a JSONL file control, conversion report, and external-download limitation notice.
- Responsive settings-page markers and sidebar refresh injection.

The browser never mutates files directly. After an operation, the Host response becomes the new list baseline.

## Security and failure policy

- All state-changing routes require POST and the guard header.
- Import limits ZIP size, entries, paths, versions, and JSON structure, rejecting traversal, duplicates, and prototype-pollution keys.
- External JSONL import bounds total bytes, lines, per-line size, nesting depth, and collection size. Unknown or malformed records are reported while inspection stays read-only.
- Interop attachment paths must be safe and relative; only references remain. Attachment bytes, credentials, keys, and external configuration are never copied, and raw messages are not logged.
- External import repeats the ID-conflict check and never overwrites. External export reads only currently visible archived IDs and mutates neither source sessions nor target-tool state.
- Delete reports success only when the physical location is confirmed; otherwise the session and authoritative metadata remain.
- Metadata or stats outages do not disable listing, unarchive, or delete.
- Unknown host capabilities must degrade or return a clear error; they must not be inferred.

## Compatibility and testing

The compatibility baseline is DeepSeek Harness 0.1.0-rc.7, with a real-host page pass on rc.8. When host slots, design tokens, or session internals change, run the smoke suite first and then repeat a real-host check.

Coverage includes:

- export.js records, transcripts, and ZIP streaming.
- import.js bounded validation and unsafe-path rejection.
- restore.js transactional commit, rollback, and unsupported capabilities.
- metadata.js versioning, concurrency, and atomic writes.
- stats.js symlink handling, caching, and concurrency limits.
- interop/format.js version, SHA-256, bounds, and prototype-pollution rejection.
- Codex / Claude Code minimal, multi-turn, tool-call, malformed-line, attachment-reference, target-projection, and round-trip fixtures.
- Interop route guard, request cap, source/target rejection, read-only inspection, and transactional-restore reuse.
- Host routes and browser settings smoke/responsive behavior.

Run:

~~~sh
npm test
npm pack --dry-run --json
~~~
