# Recycle Bin and Automatic Protection Snapshots 0.11.0 Design

## Status

Approved product direction for `dsh-archived-chats` 0.11.0. This specification
turns the existing irreversible delete action into a recoverable recycle-bin
lifecycle, adds automatic protection snapshots, and reserves physical deletion
for explicit actions inside the recycle bin.

The design is intentionally limited to 0.11.0. Space analysis, configurable
retention policies, and session-lineage views remain 0.12.0 work; a general
multi-version time-machine surface remains 1.0 work.

## Context

Version 0.10.0 can browse, search, preview, annotate, back up, restore,
unarchive, and permanently delete archived sessions. Its delete path is safe
against live-session races and crashes, but a successful request removes the
session directory and metadata permanently. The only recovery path is a prior
manual ZIP export, whose version-one format deliberately excludes attachment
bytes and descendant sessions.

The current host already exposes the provider-neutral primitives needed for a
safer boundary:

- `SessionPersistence.inspect(id)` returns immutable header and event data.
- `SessionPersistence.listSnapshots()` exposes a cheap revision identity.
- `SessionPersistence.create(meta)` and `append(id, events)` can rebuild a
  session through the official persistence seam.
- `AttachmentStore.readImage(ref)` verifies stored image bytes.
- `AttachmentStore.saveImage(input)` republishes verified image bytes.
- The existing plugin lifecycle queue serializes delete and unarchive commits.

The attachment service has no deletion API. Therefore 0.11.0 can remove its
own snapshot copies and session logs, but it must not claim that a permanent
delete immediately garbage-collects unreachable content-addressed attachment
objects. Attachment garbage collection belongs to the 0.12.0 retention layer.

## Goals

1. Make the ordinary delete action recoverable by default.
2. Create a verified automatic snapshot before a session enters the recycle
   bin.
3. Preserve session events, archive metadata, plugin metadata, workspace
   accounting, and referenced image bytes.
4. Restore from the original persistence record when it still exists, and use
   the snapshot only as a fallback when the original is missing or corrupt.
5. Never overwrite an existing session ID during snapshot restoration.
6. Keep permanent deletion explicit, recycle-bin-only, crash-recoverable, and
   honest about attachment-store limitations.
7. Migrate 0.10.x pending deletions into the recycle bin instead of completing
   them as surprise permanent deletes after upgrade.
8. Keep snapshot and batch work bounded: sessions are processed sequentially
   and attachment bytes are read and written one at a time.
9. Preserve listing, search, preview, export/import, unarchive, theme, locale,
   responsive, and accessibility behavior outside the changed delete flow.
10. Establish a versioned snapshot foundation that 0.12.0 can measure and
    govern without implementing configurable retention in 0.11.0.

## Non-goals

- Scheduled deletion, age-based cleanup, quota policies, or user-defined
  retention rules.
- Space recommendations, duplicate detection, or attachment garbage
  collection.
- Session lineage visualization or relationship repair.
- Periodic snapshots unrelated to a recycle-bin operation.
- Multiple user-browsable historical versions of one active session.
- Restoring descendants as an implicit session tree. Each selected session is
  snapshotted independently; its durable lineage fields remain intact.
- Password protection, encryption, remote sync, or cross-device backup.
- Importing or exporting the internal snapshot format.
- Cross-tool migration or adaptation.
- Replacing Harness persistence with plugin-owned session files.

## Approaches Considered

### Move the backend-owned session directory

Renaming the current JSONL session directory into a plugin trash directory is
fast and can be atomic on one filesystem, but it couples the plugin to one
backend layout, cannot support SQLite-like stores, does not include global
attachments, and would require private restoration logic. Rejected.

### Keep only a recycle marker

A marker would make undo trivial because the original log remains in place,
but it provides no recovery when the original file is damaged or removed and
does not satisfy automatic snapshots. Rejected as incomplete.

### Recycle marker plus a portable protection snapshot

The selected approach keeps the authoritative session in Harness persistence,
hides it through a plugin-owned recycle record, and creates an independent
snapshot through public inspection and attachment services. Undo normally
removes only the marker. Snapshot restoration is a fallback, not the ordinary
path. This keeps the common operation cheap while adding a real recovery seam.

## Architecture

### Module boundaries

`lib/trash.js` owns the version-one recycle catalog:

- strict schema parsing and fail-closed mutation behavior;
- serialized atomic whole-document writes;
- state transitions (`trashed`, `purge-pending`, `degraded`);
- migration from `pending-deletions.json`;
- record lookup, batch selection, and operation summaries.

`lib/snapshot.js` owns the internal snapshot format:

- stable persistence revision checks;
- event and archive metadata capture;
- attachment-reference discovery and verified byte reads;
- temporary-directory construction, hashes, fsync, and atomic publication;
- manifest validation and bounded snapshot reads;
- restoration payload construction;
- latest-snapshot replacement for one session.

`lib/recycle.js` is the host transaction adapter:

- move-to-trash orchestration;
- original-record undo;
- snapshot fallback restoration through `create`/`append` and `saveImage`;
- permanent purge and crash continuation;
- capability detection and stable reason codes.

`lib/index.js` remains the composition and HTTP boundary. It owns the existing
live-session disposer, registry/workspace mutation, cache invalidation, and
route registration, but delegates recycle and snapshot state to the focused
modules above.

`lib/client.js` adds the recycle-bin view, undo notices, restore/purge actions,
and localized status presentation. It never reads snapshot files directly.

### Storage layout

All plugin-owned state stays below the existing private plugin directory:

```text
$DSH_HOME/plugin-data/archived-chats/
├── metadata.json
├── pending-deletions.json       # migration input only after 0.11.0
├── trash.json
└── snapshots/
    ├── .staging/
    └── <snapshot-uuid>/
        ├── manifest.json
        ├── session.json
        └── attachments/
            └── 001-<sha256-prefix>.<ext>
```

Snapshot directory names are random UUIDs. Untrusted session IDs, titles, and
attachment names or IDs never become path segments. Attachment filenames use
their ordered index plus the first 16 hexadecimal characters of the verified
content digest. Snapshot files use mode `0600`; created directories use mode
`0700`.

### Recycle catalog schema

`trash.json` is one atomically replaced versioned document:

```json
{
  "version": 1,
  "records": {
    "session-id": {
      "sessionId": "session-id",
      "state": "trashed",
      "trashedAt": "2026-08-24T00:00:00.000Z",
      "purgeRequestedAt": null,
      "title": "Example",
      "createdAt": 1787500000000,
      "origin": null,
      "workspace": {
        "id": "workspace-id",
        "title": "Project",
        "path": "/workspace/path"
      },
      "wasArchived": true,
      "tags": ["important"],
      "note": "keep context",
      "metadataUpdatedAt": "2026-08-24T00:00:00.000Z",
      "snapshotId": "snapshot-uuid",
      "snapshotBytes": 12345,
      "snapshotAttachmentCount": 2,
      "liveDisposition": "cold"
    }
  }
}
```

`state` is one of:

- `trashed`: recoverable and not eligible for boot-time physical deletion;
- `purge-pending`: the user explicitly confirmed permanent deletion and a
  crash-safe purge must continue on boot;
- `degraded`: the catalog or snapshot cannot prove normal recoverability. The
  item stays visible in the recycle bin with restricted actions.

`liveDisposition` is `cold`, `disposed`, or `parked`. It is diagnostic and
does not authorize an operation.

`snapshotId` is required for `trashed` and `purge-pending`. A startup-recovered
`degraded` record may retain the expected ID for diagnostics or use `null` when
no valid published snapshot can be identified.

Catalog reads validate every record. An unreadable or unsupported catalog is
never overwritten. The archive page then shows all persistence-backed archived
sessions, reports `trashStatus: unavailable`, and disables recycle mutations.

### Snapshot format

`manifest.json` uses format `dsh-archived-chats/snapshot`, version `1`:

```json
{
  "format": "dsh-archived-chats/snapshot",
  "version": 1,
  "snapshotId": "snapshot-uuid",
  "sessionId": "session-id",
  "createdAt": "2026-08-24T00:00:00.000Z",
  "reason": "trash",
  "sourceRevision": "opaque-backend-revision",
  "session": {
    "file": "session.json",
    "bytes": 10000,
    "sha256": "hex-digest"
  },
  "attachments": [
    {
      "attachmentId": "opaque-id",
      "mediaType": "image/png",
      "bytes": 2345,
      "width": 640,
      "height": 480,
      "name": "diagram.png",
      "file": "attachments/001-0123456789abcdef.png",
      "sha256": "hex-digest"
    }
  ],
  "totalBytes": 12345
}
```

`session.json` uses format `dsh-archived-chats/snapshot-session`, version `1`
and stores:

- the immutable Harness `meta` header;
- the complete inspected `events` array;
- title, workspace, archived state, origin, tags, note, and metadata timestamp;
- the event sequence and attachment descriptors used for validation.

The format is internal and separate from export format version one. Export
compatibility cannot weaken snapshot completeness, and internal snapshots are
never accepted by `/import/inspect`.

`sourceRevision` is an opaque persistence revision string, or `null` only when
an older host exposes no revision API and the session has already been proven
cold or fully disposed.

### Snapshot safety limits

Version one uses fixed defensive read and write limits:

- manifest: 4 MiB;
- session JSON: 512 MiB;
- attachment count: 10,000;
- one attachment: 32 MiB;
- total snapshot bytes: 8 GiB.

Creation checks the limits while serializing and reading one attachment at a
time. Restoration rejects declared or measured values above any limit before
calling a writer. These are safety ceilings, not retention policy; exceeding a
ceiling returns `snapshot-limit-exceeded` and leaves the source visible and
untouched.

### Fixed snapshot retention in 0.11.0

There is at most one active protection snapshot per session. Moving a
previously restored session to trash creates and publishes a new snapshot
first; only after the new recycle record commits may the older active snapshot
be removed. Valid complete orphans found during crash recovery are preserved
but are not treated as active until selected by the deterministic startup
index.

Undo keeps the latest snapshot as a protection copy. A later move replaces it.
Permanent purge removes the original session, every validated snapshot whose
manifest names that session ID, and the recycle record. Configurable history
count, age, and quota rules are deferred to 0.12.0.

## Operation Semantics

### Move one session to trash

Every move runs inside the existing global archive lifecycle queue:

1. Re-read the archive set, recycle catalog, persistence headers, workspace,
   and plugin metadata. Reject unknown, unarchived, already-trashed, or
   `purge-pending` IDs.
2. If the session is live, cancel it with the existing `disposed` cause, wait
   for quiescence, flush durability, and attempt the current feature-detected
   detach sequence. A host that cannot detach leaves it safely parked.
3. Obtain the session revision with `listSnapshots()` when available, inspect
   immutable `meta` and `events`, and collect unique image references.
4. Read one attachment at a time through `attachments.readImage(ref)`. The
   returned verified reference must match the event descriptor.
5. Re-read the source revision. If it changed, discard the temporary attempt
   and retry the snapshot up to three times. A cold or fully disposed session
   normally converges on the first attempt.
6. On older hosts without revisions, snapshot only a cold or fully disposed
   session. A parked live session without revision support returns
   `snapshot-unsupported` and remains outside the recycle bin.
7. Write `session.json`, attachments, and manifest below `.staging`, calculate
   SHA-256 digests and exact byte counts, sync files, then rename the directory
   to its UUID destination.
8. Atomically add the `trashed` recycle record. Only this step hides the row
   from the archive page.
9. Invalidate title, statistics, search, and preview caches and return the
   committed recycle record.

If snapshot creation fails, no recycle record is written and the original
session files, archive membership, workspace membership, and metadata remain.
A live session may already be parked because the user initiated deletion; the
failure response reports `session-parked` explicitly and the session becomes
cold on restart.

Batch moves are sequential and independently committed. One failure does not
roll back successful earlier items. Responses preserve requested order and
return `trashed` plus stable `failed` entries.

### Visibility while trashed

The authoritative persistence record remains present and the session remains
in `registry.archivedSessionIds`. The recycle catalog is an additional state
overlay:

- `/state`, `/stats`, ordinary `/search`, ordinary `/preview`, and archive
  export selection exclude trashed and `purge-pending` IDs;
- the normal Harness sidebar continues hiding them because they stay archived;
- `/trash` lists them with original workspace and metadata;
- recycle-bin preview uses the same projected read path with explicit
  `scope: trash` authorization;
- recycle-bin image preview requires the same explicit scope and cross-session
  reference proof as ordinary preview.

### Undo from the original record

Undo first checks current persistence by ID and validates that the located
record still belongs to the recycle item.

When the original is intact:

1. Remove the recycle record atomically.
2. Keep or restore archive membership according to `wasArchived` (all 0.11.0
   UI-created records are archived).
3. Reattach the exact original workspace only if accounting was externally
   removed while trashed.
4. Restore tags and note only if the metadata entry is missing; do not overwrite
   a newer external edit.
5. Invalidate caches and return the session to the archived list.

The protection snapshot remains as the latest per-session snapshot.

### Undo through snapshot restoration

Fallback restoration is used only when the original persistence record is
missing or fails identity validation:

1. Validate the complete manifest, session file, hashes, attachment files,
   counts, IDs, and metadata before writing anything.
2. Take a fresh persistence ID snapshot. Any existing ID is `id-conflict`; it
   is never overwritten, even if registry indexes are stale.
3. Require `persistence.create`, `persistence.append`, and a rollback-capable
   backend location. The 0.11.0 real-host baseline is the official JSONL
   backend. Other backends return `snapshot-restore-unsupported` unless they
   expose an equivalent reversible writer.
4. Republish attachments one at a time through `attachments.saveImage`. The
   returned attachment ID and verified descriptor must equal the stored
   reference. A mismatch aborts before session creation.
5. Call `persistence.create(meta)`, then append events in ordered batches of at
   most 500 events.
6. Restore the exact existing workspace when available, plugin metadata, and
   archived state.
7. Remove the recycle record only after persistence, workspace, metadata, and
   registry commits all succeed.

Rollback reverses registry, workspace, and metadata changes, then removes only
the newly created persistence artifact after proving its backend-resolved
location. Content-addressed attachments may remain unreachable because the
official attachment service has no remove operation.

### Permanent purge

Permanent deletion exists only inside the recycle bin and always requires a
destructive confirmation.

1. Atomically transition the record from `trashed` or `degraded` to
   `purge-pending` and save `purgeRequestedAt`. A degraded item requires
   confirmation copy that explicitly states no verified snapshot is available.
   This durable state is the crash bracket proving explicit user intent.
2. Reuse the existing serialized live disposal and physical session deletion
   path.
3. Confirm the session directory or backend artifact is gone before mutating
   registry indexes.
4. Remove archive membership, workspace accounting, registry indexes, plugin
   metadata, and caches.
5. Remove every validated snapshot directory for the session after proving each
   path is below the plugin snapshot root.
6. Remove the recycle record last.

A failure leaves `purge-pending`. Boot recovery retries only these records;
ordinary `trashed` items are never physically deleted on boot.

`Empty recycle bin` snapshots the current set of `trashed` IDs, changes each to
`purge-pending` immediately before its own purge, and continues after partial
failure. The response reports `purged` and `failed` arrays.

## Legacy Pending-Deletion Migration

On first 0.11.0 activation, the old `pending-deletions.json` is migration input,
not a deletion command. Unlike the 0.10.x best-effort reader, migration treats
malformed JSON or anything other than the exact legacy `{ "ids": string[] }`
shape as unavailable: it preserves the bytes, logs only a stable code, migrates
nothing, and deletes nothing.

1. Load the old ID set without modifying it.
2. If an ID is no longer archived, remove only that stale pending marker.
3. If the session still exists, create a protection snapshot and a `trashed`
   record, then remove that ID from the old pending store.
4. If snapshot creation fails or the physical location is unresolved, keep the
   old marker, do not delete files, expose a startup warning, and retry on the
   next boot.
5. Once the old set is empty, retain the legacy file as an empty migration
   artifact; 0.11.0 never adds new IDs to it.

This deliberately changes the 0.10.x boot behavior: upgrading to 0.11.0 cannot
complete a previously deferred permanent deletion without a new recycle-bin
purge confirmation.

## Crash Recovery

Startup recovery runs before ordinary routes become available:

- Remove abandoned `.staging` directories older than the current process.
- Validate every published snapshot manifest without loading all event data.
- If a valid published snapshot has no recycle record, keep it as the latest
  protection snapshot for its session; never delete an apparently complete
  orphan automatically.
- Build the in-memory latest-snapshot index by validating manifests and choosing
  the newest `createdAt` per session. Equal timestamps are resolved by lexical
  snapshot UUID so repeated scans are deterministic.
- If a recycle record references a missing or invalid snapshot but the original
  session exists, mark it `degraded`; allow original-record undo and block
  claims that a protection snapshot is ready.
- If both snapshot and original are unavailable, keep a `degraded` visible
  record with diagnostics that contain no event, note, path, or attachment
  content.
- Retry every `purge-pending` record. Never retry physical deletion for a plain
  `trashed` or `degraded` record.
- Run legacy pending migration only after the recycle and snapshot stores have
  passed schema validation.

## HTTP Surface

Version 0.11.0 registers these additional routes:

```text
GET  /plugins/dsh-archived-chats/trash
POST /plugins/dsh-archived-chats/trash/restore
POST /plugins/dsh-archived-chats/trash/purge
POST /plugins/dsh-archived-chats/trash/empty
```

Existing delete routes change behavior:

```text
POST /plugins/dsh-archived-chats/delete      -> move one to trash
POST /plugins/dsh-archived-chats/delete-all  -> move selected IDs to trash
```

All new POST routes require `x-dsh-archived-chats: 1`, bounded JSON bodies,
non-empty unique string IDs, and a maximum of 2,000 IDs. Trash mutation routes
are same-origin state changes and return `no-store` JSON.

`GET /trash` returns:

```json
{
  "ok": true,
  "trashStatus": "ready",
  "summary": {
    "count": 1,
    "snapshotBytes": 12345,
    "degradedCount": 0,
    "purgePendingCount": 0
  },
  "sessions": []
}
```

Move responses use:

```json
{
  "ok": true,
  "trashed": ["session-a"],
  "failed": []
}
```

Restore and purge responses use ordered `restored`/`purged` arrays plus stable
`failed` entries. Partial success answers HTTP 200; a request whose every item
fails with a client-correctable conflict answers HTTP 409; malformed,
unauthorized, oversized, unavailable-store, and unexpected failures retain the
existing 400/403/413/503/500 conventions.

Preview and image-preview bodies gain optional `scope: "archive" | "trash"`.
Omitted scope means `archive`, preserving 0.10.x clients. Authorization is
rechecked after asynchronous reads and immediately before the response.

## Client Experience

The settings section gains two page-level tabs:

- `Archived`: the existing list, filters, full-text search, preview, metadata,
  export/import, unarchive, and batch selection.
- `Recycle Bin`: recoverable items grouped by original workspace.

Archive changes:

- Row, group, selected, and all delete actions say `Move to Recycle Bin`.
- Confirmation copy states that a verified protection snapshot is created and
  the item can be restored.
- A successful move shows an assertive but non-danger toast with an immediate
  `Undo` action. Undo is disabled only while its restore request is active.
- Permanent-delete language disappears from the archive view.

Recycle-bin rows show title, original workspace, trashed time, snapshot size,
attachment count, and `Ready`, `Parked`, `Degraded`, or `Purge pending` status.
Each ready row offers read-only preview, `Restore`, and `Delete permanently`.
Batch selection offers restore and permanent delete. `Empty recycle bin` lives
inside the existing `More` danger menu.

Permanent deletion uses an `alertdialog`, names the affected scope, states that
the original and protection snapshot will be removed, starts focus on Cancel,
traps Tab in both directions, stops Escape before the host dialog, and restores
focus to a surviving trigger or page heading.

Narrow layouts keep the two tabs visible, move batch actions below the title,
and preserve existing preview-dialog behavior. Chinese and English strings are
added under the existing locale namespace.

## Security and Privacy

- Snapshot and trash state never leave `$DSH_HOME`.
- Snapshot paths derive only from generated IDs and validated internal names.
- Restoration never trusts catalog paths; every resolved path must remain under
  the canonical snapshot root.
- Manifest JSON rejects prototype-polluting keys and unsupported versions.
- Attachment descriptors are matched to event references and verified service
  responses; caller-provided paths and media types are never accepted.
- Error responses and logs contain session IDs plus stable codes only. They do
  not contain titles, notes, message content, attachment names, workspace
  paths, or filesystem paths.
- All mutations remain guarded POST requests.
- Recycle preview cannot read ordinary active/unarchived sessions, and ordinary
  preview cannot read recycle records.
- Permanent purge requires a durable `purge-pending` record before physical
  deletion begins.

## Failure Semantics

- Unreadable `trash.json`: show all archived persistence records, disable trash
  mutations, return `trash-store-unavailable`, and preserve the bytes.
- Snapshot disk full: do not add a recycle record; report `snapshot-write-failed`.
- Unstable source after three attempts: report `snapshot-source-busy` and keep
  the original visible.
- Missing attachment service with referenced images: report
  `snapshot-attachments-unsupported`; never create an incomplete snapshot.
- One corrupt attachment: report `snapshot-attachment-invalid`; preserve every
  original object and discard staging.
- Original-record undo after external metadata changes: preserve the newer
  metadata instead of overwriting it.
- Snapshot ID conflict: return `id-conflict` without any writer call.
- Snapshot restore unsupported by a backend: keep the recycle record and return
  `snapshot-restore-unsupported`.
- Purge failure: retain `purge-pending` and retry on boot.
- Snapshot cleanup failure after confirmed physical purge: keep the recycle
  record until cleanup succeeds, so the orphan remains discoverable.
- Cache, statistics, or metadata cleanup failures never falsify physical purge
  success; they are logged safely and retried where state remains.

## Testing Strategy

### Trash store unit tests

- Empty, valid, malformed, and unsupported documents.
- Atomic serialized add, transition, remove, and concurrent mutation behavior.
- Corrupt documents remain byte-for-byte untouched after rejected mutations.
- Strict state transitions reject restore from `purge-pending` and purge from
  unknown IDs.
- Batch selection preserves request order and removes duplicates.

### Snapshot unit tests

- Deterministic manifest validation, hashes, byte counts, and path safety.
- Stable revision success, revision retry, and three-attempt busy failure.
- One-at-a-time attachment reads and exact descriptor matching.
- Missing service, missing image, corrupt bytes, duplicate references, and
  unsafe JSON rejection.
- Atomic publication leaves no visible partial snapshot.
- Latest-per-session replacement publishes the new snapshot before deleting the
  old one.
- Manifest reads enforce per-file, attachment-count, and aggregate limits.

### Recycle transaction tests

- Cold and live move-to-trash paths.
- Live disposal unavailable produces a parked record only when a complete
  snapshot is proven.
- Snapshot failure never commits the recycle marker.
- Original-record undo performs no persistence writes.
- Snapshot fallback restores events in order, republishes attachments, and
  restores workspace, metadata, and archive state.
- ID conflicts call no writer.
- Failure after each restore step rolls back all reversible state.
- Permanent purge records intent before deleting and removes the record last.
- Crash simulations resume every `purge-pending` phase idempotently.
- Plain `trashed` records are never boot-deleted.
- Legacy pending IDs migrate to trash; failed migrations retain their markers
  and files.
- Concurrent undo, move, and purge operations serialize with deterministic
  winners.

### Host integration tests

- Four new routes plus changed delete responses.
- Method, guard, body limit, ID validation, and partial-result status codes.
- Archive state excludes trash IDs; trash state includes them.
- Archive/trash preview scope and image cross-scope denial.
- Cache invalidation after move, restore, and purge.
- Existing export/import, metadata, statistics, unarchive, search, preview,
  live-delete, and sidebar-refresh behavior remains green where semantics are
  unchanged.

### Client tests

- Archived/recycle tab behavior and responsive layout.
- Changed delete copy and immediate undo.
- Trash grouping, status, summary, preview, selection, restore, purge, and empty
  actions.
- Every dialog label, description, Escape behavior, focus trap, and focus
  restoration.
- Partial batch failures retain failed rows and remove successful rows only.
- Metadata/statistics/snapshot degradation does not remove recoverable items.

### Release verification

- `npm test` reports zero failures.
- `node --check` passes every runtime module.
- `npm pack --dry-run --json` includes `trash.js`, `snapshot.js`, `recycle.js`,
  types, documentation, and screenshots, and excludes development data.
- A real Harness `0.1.1-rc.2` profile verifies cold/live trash, restart,
  original undo, forced snapshot fallback, permanent purge, light/dark themes,
  desktop/narrow layout, and attachment preview.
- A copy of the real profile proves that upgrading with a pending 0.10.x live
  deletion migrates it to the recycle bin instead of deleting it.

## Rollout and Compatibility

- Package version becomes `0.11.0` only after the complete recycle flow passes
  automated and real-host verification.
- Automated compatibility remains anchored to the existing rc.7-compatible
  list/UI contracts. Snapshot fallback and attachment capture are capability
  detected; the full real-host release target is `0.1.1-rc.2`.
- Existing metadata and export schemas do not change.
- `pending-deletions.json` is read for migration but no longer receives new
  records.
- Delete route semantics intentionally change from physical deletion to
  recycle-bin movement. Host and client ship together; the route response uses
  `trashed`, not the misleading legacy `deleted` field.
- A downgrade from 0.11.0 to 0.10.x cannot understand `trash.json`. Because
  trashed sessions remain archived and physically present, the old plugin may
  list them again but will not delete them unless the user explicitly invokes
  the old delete action. The README must warn against downgrade before emptying
  or restoring the recycle bin.

## Acceptance Criteria

0.11.0 is ready when all of the following are true:

1. Ordinary delete creates a verified snapshot and moves the row to the recycle
   bin without removing the original session artifact.
2. Undo with an intact original performs no persistence rewrite and restores the
   row immediately.
3. Forced loss of the original can be restored from the snapshot with identical
   session ID, header, events, attachment references, workspace, tags, note, and
   archived state.
4. Snapshot failure leaves no visible recycle record and no partial published
   snapshot.
5. ID conflicts and unsupported backends never overwrite or partially write.
6. Permanent purge is available only in the recycle bin, records durable user
   intent before deletion, and resumes safely after a crash.
7. Boot recovery never physically deletes a plain recycle record.
8. Every 0.10.x pending deletion migrates or remains safely pending; none is
   silently purged by the 0.11.0 startup path.
9. Archive and trash preview scopes cannot read each other's unauthorized IDs or
   attachment references.
10. Corrupt catalogs and snapshots remain preserved and produce explicit
    degraded states rather than destructive repair guesses.
11. The full automated suite, package verification, and real-host matrix pass.
