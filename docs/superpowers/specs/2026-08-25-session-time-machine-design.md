# Session Time Machine 1.0 Design

## Status

Approved product direction for `dsh-archived-chats` 1.0.0. The user delegated
the remaining design decisions and asked development to continue without
additional approval pauses.

## Product goal

Turn the validated protection snapshots introduced in 0.11.0 and retained as
history in 0.12.0 into a user-visible session history. A user can inspect any
healthy historical version and restore it as a new archived session without
overwriting the source session or changing the selected snapshot.

Version 1.0 also captures a history version after an ordinary Harness archive
operation succeeds. It does not periodically inspect active conversations and
does not become a general-purpose manager for unrelated active sessions.

## User promises

1. A successful archive remains successful even if history capture fails.
2. At most one healthy snapshot is retained for the same session revision.
3. Historical preview is read-only and never requires restoring the version.
4. Restore always creates a new session identity. It never overwrites, deletes,
   unarchives, or otherwise mutates the source session.
5. The selected snapshot is fully revalidated immediately before restore.
6. A failed restore rolls back all plugin-controlled session, workspace,
   metadata, and registry mutations.
7. Existing retention and permanent-purge behavior continues governing every
   snapshot in the shared snapshot store.
8. No route exposes local paths, raw unprojected records, attachment storage
   paths, or unrelated active-session content.

## Scope

### In scope

- capture a version after a browser-originated Harness archive succeeds;
- reuse recovery snapshots already created by recycle operations;
- group healthy and degraded versions by source session;
- show capture time, size, attachment count, health, current recycle-protection
  status, and the best available session/workspace title;
- preview projected messages and verified stored images from one version;
- restore one version as a new archived session with a fresh ID;
- retain the snapshot after a successful restore;
- reuse the 0.12 retention policy and permanent-purge paths;
- Chinese and English copy, themes, narrow layouts, keyboard navigation, focus
  management, and reduced-motion-compatible behavior;
- real-host verification in an isolated DSH home before release.

### Out of scope

- scheduled, background, or startup-triggered history capture;
- scanning unrelated active conversations;
- snapshotting every message or token;
- overwriting or rewinding an existing session in place;
- merging branches, repairing `parentSession`, or restoring descendant trees;
- cloud sync, remote backup, encryption, or cross-tool migration;
- direct deletion of one history row in the initial 1.0 surface (existing
  retention preview/apply remains the cleanup control);
- changing Harness private files or inventing a persistence backend;
- claiming rollback or garbage collection of unreferenced global attachment
  objects when the Host exposes no deletion API.

## Compatibility strategy

All new captures remain in
`$DSH_HOME/plugin-data/archived-chats/snapshots/<snapshot-id>/` and use the
existing `dsh-archived-chats/snapshot` version-one manifest. The legacy
manifest field `reason: "trash"` remains unchanged for downgrade compatibility;
1.0 treats it as a legacy protection-format marker, not as the user-visible
capture reason. The UI derives only these stable states:

- **Recycle protection** when the current `trash.json` record names the
  snapshot;
- **Historical version** for every other healthy snapshot.

This deliberately avoids a second history directory, a second binary format,
or snapshots that 0.12 cannot validate, retain, and purge. Existing 0.11/0.12
snapshots need no migration.

## Architecture

### `SnapshotStore` extensions

Keep `lib/snapshot.js` authoritative for filesystem confinement, atomic
publication, manifest validation, hashing, attachment validation, and exact
removal. Add bounded methods rather than duplicating those rules:

- `inspectHistory(snapshotId)` validates the manifest and session record and
  returns a cloned descriptor, source revision, and summary without returning
  attachment bytes or paths;
- `readHistoryPage(snapshotId, window)` validates the manifest and session
  record, projects a bounded page of messages through the existing preview
  projector, and returns only safe projected data;
- `readHistoryImage(snapshotId, reference, signal)` verifies that the requested
  descriptor belongs to that snapshot, reads only that bounded file, rechecks
  its digest, and returns verified bytes;
- `findRevision(sessionId, sourceRevision)` returns an existing healthy
  snapshot with the same non-null revision, if one exists.

Inventory remains bounded at 5,000 published snapshot directories. Exceeding
the bound fails the history surface closed instead of returning a partial list.
Existing retention and purge behavior remains authoritative and unbounded by a
client-provided selection.

### `HistoryService`

Create `lib/history.js` as the orchestration boundary. It receives
`snapshotStore`, `trashStore`, `persistence`, `registry`, `metadataStore`,
`attachments`, the existing shared lifecycle queue, and invalidation hooks.

Its public operations are:

```text
captureArchived(sessionId)
list()
preview(snapshotId, window)
readImage(snapshotId, reference, signal)
prepareRestore(snapshotId)
restore(token, nonce)
```

`HistoryService` never accepts a filesystem path, a serialized session record,
or attachment bytes from the browser.

### Archive capture flow

The existing client `archiveSession` interceptor continues calling the original
Harness method first. Only after that promise resolves does it show the archive
notice and start a guarded `POST /history/capture` request.

The Host flow is:

1. validate the body and same-origin guard;
2. enter the shared lifecycle queue;
3. recheck that the ID is currently archived and not recycled;
4. build the archive descriptor from public registry, persistence, workspace,
   and metadata surfaces;
5. require a stable Host revision for a session that is still live;
6. return an existing healthy snapshot when the same non-null source revision
   is already present;
7. otherwise call the existing atomic `snapshotStore.capture()`;
8. invalidate history and insight caches;
9. return only snapshot ID, timestamp, size, attachment count, and whether the
   operation reused an existing version.

`RecycleService.moveOne()` uses the same revision lookup before capturing its
protection snapshot. When an ordinary archive capture already published the
same healthy non-null revision, the recycle record may safely name that exact
snapshot instead of storing duplicate bytes. Null-revision sources retain the
existing conservative behavior and publish a new protection snapshot.

Capture is asynchronous relative to the successful archive operation. Closing
the notice does not cancel a Host capture that has already begun. A capture
failure updates the notice to explain that the chat was archived but its
history version was not saved, with a bounded retry action. Undo remains the
ordinary Harness unarchive operation and does not delete the captured history.

### History inventory

`list()` shares one in-flight scan and caches a completed inventory for 30
seconds. It validates published manifests and session records without retaining
attachment bytes in memory. Healthy items are grouped by original session ID
and sorted newest first. Degraded directories appear as opaque diagnostics by
snapshot ID only; untrusted session IDs, titles, sizes, and paths are never
returned.

The response contains no more than:

```json
{
  "generatedAt": "2026-08-25T00:00:00.000Z",
  "sessions": [
    {
      "sessionId": "source-id",
      "title": "Readable title",
      "workspace": { "id": "workspace-id", "title": "Workspace" },
      "scope": "archived",
      "versions": [
        {
          "snapshotId": "uuid",
          "createdAt": "2026-08-25T00:00:00.000Z",
          "totalBytes": 123,
          "attachmentCount": 1,
          "state": "history"
        }
      ]
    }
  ],
  "degraded": [{ "snapshotId": "uuid", "code": "snapshot-hash-mismatch" }]
}
```

`scope` is one of `archived`, `recycled`, or `history-only`. It is derived from
current registry and trash authority. `state` is `history` or
`recycle-protection`.

### Preview flow

Preview reuses the existing native-style projection and conversation dialog.
It does not pass a snapshot record through the ordinary archive-visibility
guard, because a history-only source may no longer be archived. Authorization
instead requires a valid published snapshot identity discovered server-side.

`POST /history/preview` accepts an exact snapshot ID and bounded offset/limit.
The response contains the same safe projected message shapes used by archived
preview plus the snapshot timestamp and source session ID. The client cannot
request arbitrary fields.

`POST /history/preview/image` accepts snapshot identity plus the exact projected
image descriptor. The Host revalidates membership and digest and returns one
verified image with `no-store` and `nosniff` headers. Closing the dialog aborts
pending reads and revokes browser object URLs.

### Restore preparation

`POST /history/restore/preview` validates the complete snapshot, including every
attachment digest, then creates an in-memory random token and nonce. The token:

- expires after five minutes;
- is single-use;
- is bound to snapshot ID, manifest digest, source session ID, source revision,
  and proposed new session ID;
- returns only a safe summary and workspace warnings;
- is never persisted or logged.

Preparation generates the new ID on the Host. A browser cannot choose or reuse
the identity.

### Restore transaction

Create `lib/history-restore.js`. Extract and reuse the validated attachment
rewrite and rollback patterns already exercised by recycle snapshot restore;
do not route this operation through ZIP import, and do not hand-write Harness
backend files.

On confirmation:

1. consume token and nonce before starting work;
2. enter the shared lifecycle queue;
3. fully revalidate the selected snapshot and compare its manifest digest with
   the prepared value;
4. recheck that the generated ID is absent from persistence and registry;
5. clone the source record and rewrite only the Host session identity and
   verified attachment references required for the new copy;
6. stage session persistence through explicit Host writer capabilities;
7. restore verified attachment bytes through the Host attachment service;
8. attach the new ID to the original workspace when still resolvable, otherwise
   retain it as ungrouped and return a warning;
9. copy plugin tags and notes to the new ID;
10. add the new ID to the archive registry last;
11. invalidate state, statistics, lineage, insights, and history caches;
12. keep the source session and selected snapshot unchanged.

The restored record preserves user-authored events exactly except for the
minimum identity and attachment-reference rewrites required by Host APIs. It
does not append a synthetic title event. The new archived row therefore keeps
the historical title. The successful response and transient client notice name
it as a history restore, but no synthetic badge or provenance is written into
user-authored conversation content.

If any plugin-controlled commit step fails, reverse completed workspace,
metadata, registry, and session persistence mutations in reverse order and
remove private staging data. When the Host attachment service has no deletion
API, rollback may leave an unreachable content-addressed attachment object;
the UI and documentation must not claim global attachment garbage collection.

## HTTP surface

Version 1.0 registers six routes:

```text
POST /plugins/dsh-archived-chats/history/capture
GET  /plugins/dsh-archived-chats/history
POST /plugins/dsh-archived-chats/history/preview
POST /plugins/dsh-archived-chats/history/preview/image
POST /plugins/dsh-archived-chats/history/restore/preview
POST /plugins/dsh-archived-chats/history/restore
```

All POST routes require `x-dsh-archived-chats: 1`, exact JSON schemas, bounded
bodies, and `no-store` responses. Restore confirmation uses the short-lived
token and nonce. GET history returns only the bounded safe inventory.

## Client design

Add **历史版本 / History** as a fifth tab between **归档 / Archived** and
**回收站 / Recycle Bin**. It loads lazily on first activation and refreshes
after capture, restore, retention apply, recycle purge, or manual retry.

The tab contains:

- a compact explanation that versions are local and created after archive or
  before recycle;
- search by safe title and workspace title;
- session groups ordered by newest version;
- a collapsed-by-default version timeline for each session;
- version rows with timestamp, size, attachment count, state, and health;
- **预览 / Preview** and **恢复为副本 / Restore as copy** actions;
- an empty state explaining that the first version appears after a successful
  archive;
- an opaque degraded section that never guesses ownership.

The existing conversation preview dialog is reused with a visible read-only
snapshot timestamp. Restore opens an accessible confirmation dialog with the
source title, version time, destination behavior, workspace warning, and the
explicit promise that the source will not be overwritten.

Only one capture retry, preview, or restore is active per relevant identity.
Newer requests abort or supersede older client requests. Dialogs trap focus,
isolate Escape from the Host settings listener, restore focus on close, and
remain usable at narrow widths.

## Failure behavior

- `history-source-not-archived`: capture refused because archive ownership
  changed before Host validation;
- `history-revision-unavailable`: live source cannot be captured consistently;
- `history-limit-exceeded`: inventory or bounded payload limit exceeded;
- `history-snapshot-degraded`: preview/restore denied after validation failure;
- `history-restore-expired`: token expired or was already consumed;
- `history-restore-stale`: manifest changed after preparation;
- `history-restore-conflict`: generated destination identity unexpectedly
  exists;
- `history-restore-unsupported`: required Host writer or attachment capability
  is missing;
- `history-restore-rollback-failed`: rollback could not fully restore
  plugin-controlled state and safe diagnostics were logged.

Errors return stable codes and user-safe localized copy. Logs may contain
snapshot/session IDs and stable error codes but never titles, notes, messages,
workspace paths, attachment names, raw records, or token values.

## Concurrency and cache invalidation

Snapshot capture, retention application, recycle restore/purge, and history
restore share the existing lifecycle queue for state-changing boundaries.
Read-only preview may run concurrently but revalidates snapshot identity at the
start of each request. History inventory uses a shared in-flight promise and a
30-second completed cache.

Every snapshot publication/removal and every restore invalidates history and
insight caches. A successful restore also invalidates archive state, statistics,
and lineage. Cache invalidation prevents an older in-flight result from
repopulating the cache after a mutation.

## Testing strategy

### Snapshot/history unit tests

- same non-null source revision deduplicates capture;
- a different revision creates a second version;
- null revisions never claim deduplication;
- inventory groups and sorts healthy versions deterministically;
- active recycle snapshot state follows `trash.json`;
- history-only sessions remain visible without reading an active session;
- degraded snapshots expose only opaque IDs and stable codes;
- 5,000-directory bound and cache invalidation are enforced;
- preview pagination and projected output remain bounded;
- image reads require exact membership and digest;
- no response contains a path or raw attachment bytes except the authorized
  single-image response.

### Capture integration tests

- original archive is called before history capture;
- failed original archive performs no capture;
- capture failure does not change successful archive state;
- retry is idempotent for the same revision;
- ownership is rechecked inside the lifecycle queue;
- archive notice reports pending, success, and retryable failure without
  breaking View or Undo.

### Restore tests

- preparation returns a short-lived token/nonce and no raw data;
- token expiry, replay, wrong nonce, and changed manifest fail before writes;
- new identity is Host-generated and conflict-checked;
- source session and snapshot remain byte-for-byte unchanged;
- message order and safe attachment reference rewrites are preserved;
- missing workspace produces a warning and an ungrouped archived copy;
- unsupported writer or attachment capabilities perform no mutation;
- failure at each commit boundary rolls back plugin-controlled state;
- archive registry update occurs last;
- successful restore invalidates every dependent cache.

### Client and route tests

- twenty-eight total routes register after the six history routes are added;
- method, guard, body, token, and response schemas are exact;
- fifth-tab order, lazy load, empty/error/degraded states, grouping, search, and
  timeline disclosure are localized;
- preview and restore dialogs are labelled, focus-safe, cancellable, and narrow
  layout-safe;
- History actions do not appear in unrelated active-session surfaces;
- existing Archived, Recycle Bin, Storage, Origins & Branches, notice, import,
  export, retention, and preview tests remain unchanged and passing.

### Release verification

- full `npm test` passes with zero failures;
- published declarations compile for consumers;
- `npm pack --dry-run --json` contains the new runtime and type files but no
  plugin data, worktrees, fixtures, or test artifacts;
- an isolated real DSH host verifies archive capture, two-version history,
  stored-image preview, restore-as-copy, undo, retention cleanup, light/dark
  themes, and narrow layout;
- Chinese and English README, architecture docs, release notes, and screenshots
  describe local-only history, restore-as-copy, cleanup, downgrade, and global
  attachment-GC boundaries accurately.

## Acceptance criteria

1. Archiving a stable conversation creates or reuses one validated history
   version without changing the archive result.
2. Users can find and preview every healthy retained version, including versions
   whose source is no longer archived.
3. Restoring a version creates a new archived session with a new identity and
   leaves both source and snapshot unchanged.
4. Restore is token-bound, revalidated, transactional for plugin-controlled
   state, and explicit about unreachable global attachment cleanup.
5. Degraded or over-limit history fails closed without leaking untrusted data.
6. Existing retention and purge paths continue managing all snapshots.
7. No background scanning, active-chat takeover, in-place rewind, cloud sync,
   cross-tool migration, or private Host storage writes are introduced.
8. Existing 0.12 behavior and all automated tests remain passing.
