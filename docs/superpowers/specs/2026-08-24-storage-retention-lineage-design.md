# Storage, Retention, and Session Lineage Design

Date: 2026-08-24
Target: dsh-archived-chats 0.12.0
Host baseline: DeepSeek Harness 0.1.1-rc.2

## Summary

Version 0.12.0 adds three connected capabilities to the existing archive and
recycle center:

1. a read-only space inventory for archived sessions and protection snapshots;
2. preview-first retention policies for historical snapshots and old recycle
   records; and
3. a read-only lineage view derived from Harness's durable session headers.

The implementation keeps the 0.11.0 safety model. No policy runs in the
background, no default policy permanently deletes a chat, and every destructive
application is based on a short-lived preview and an explicit confirmation.
Permanent recycle deletion continues through the existing `purge-pending`
transaction. The plugin never claims to garbage-collect Harness's global
content-addressed attachment store.

## Scope and decomposition

The release is implemented as three independently testable subprojects in this
order:

1. **Space inventory** establishes the trusted read model used by the other
   features.
2. **Retention policy** consumes an immutable inventory, produces a preview,
   and applies only revalidated selected candidates.
3. **Session lineage** consumes the same session and recycle identities but is
   otherwise read-only.

All three ship together as 0.12.0. Each subproject has its own unit tests and an
integration checkpoint before the next begins.

## Approaches considered

### Selected: focused services over existing stores

Add a focused inventory service, a pure retention planner plus an atomic policy
store, and a pure lineage projector. Extend `SnapshotStore` only with bounded
inventory operations. Keep permanent deletion delegated to `RecycleService`.

This follows existing boundaries, lets policy calculations remain deterministic,
and avoids giving a new module an independent physical-deletion path.

### Rejected: extend `StatsService` and `RecycleService` directly

This minimizes file count but mixes directory measurement, snapshot validation,
policy configuration, deletion planning, and graph projection into services that
already have narrower responsibilities. It would also make pure policy tests
unnecessarily dependent on filesystem and Harness fixtures.

### Rejected: introduce an index database

A SQLite or custom index could answer space and lineage queries quickly, but it
would introduce migration, invalidation, corruption, and privacy responsibilities
without a demonstrated scale requirement. Version 0.12.0 computes bounded views
from authoritative Harness headers, `trash.json`, and snapshot manifests instead.

## Goals

1. Show separate totals for archived/recycled session directories and
   plugin-owned protection snapshots.
2. Identify unavailable measurements and repeated snapshot attachment bytes
   without following symbolic links or exposing filesystem paths.
3. Keep multiple valid protection snapshots for a session after repeated
   restore/recycle cycles so retention has history to govern.
4. Persist a conservative, versioned retention policy locally.
5. Preview exact cleanup candidates before any write.
6. Revalidate every selected candidate immediately before deletion and report
   partial success without mutating unrelated items.
7. Derive parent/child relationships from `SessionHeader.parentSession`, while
   surfacing missing parents and malformed cycles without guessing repairs.
8. Preserve archive listing, search, preview, import/export, metadata, recycle,
   theme, locale, responsive, and accessibility behavior.

## Non-goals

- Background schedules, timers, or startup-triggered policy cleanup.
- Silent automatic permanent deletion.
- Deleting or garbage-collecting Harness global attachment objects.
- Browsing or restoring an arbitrary historical snapshot as a time-machine
  version. That remains 1.0 work.
- Editing `parentSession`, repairing lineage, merging branches, or restoring an
  entire descendant tree.
- Cloud synchronization, remote backup, encryption, or cross-tool migration.
- Replacing Harness persistence or reading guessed private storage formats.

## Existing foundations

Version 0.11.0 already provides:

- symlink-safe session-directory measurement through `StatsService`;
- version-one, hash-validated snapshot manifests and attachment descriptors;
- an atomic `trash.json` store whose records name the active protection
  snapshot;
- crash-safe `purge-pending` deletion through `RecycleService`; and
- durable Harness header fields `parentSession`, `seedLength`, `origin`, and
  `delegationDepth`.

The new design consumes those public structures. It does not change the
`trash.json` version or snapshot format version.

## Architecture

### Space inventory service

Create `lib/insights.js` with `createInsightsService(...)`. It receives:

- `persistence` for authoritative headers and locations;
- the existing `statsService` for bounded session-directory measurement;
- `trashStore` for active snapshot identities and recycle state;
- `snapshotStore` for verified snapshot inventory; and
- `registry` for current archive membership and workspace accounting.

`SnapshotStore.inventory()` scans published UUID directories and validates each
manifest and its declared files through a summary-only verifier. The verifier
reuses the existing exact schemas and path confinement, hashes the session file
and attachment files sequentially, and never accumulates attachment payloads or
returns attachment bytes/filesystem paths. It must not call the restore-oriented
`validate()` in a way that retains every attachment byte in memory.
Each valid item contains:

```json
{
  "snapshotId": "uuid",
  "sessionId": "session-id",
  "createdAt": "2026-08-24T00:00:00.000Z",
  "totalBytes": 123,
  "sessionBytes": 45,
  "attachmentCount": 1,
  "attachments": [{ "sha256": "hex", "bytes": 78 }]
}
```

Invalid published snapshots are represented only as
`{ snapshotId, status: "degraded", code }`; their untrusted sizes are not added
to trusted totals.

`createInsightsService().inspect()` returns:

```json
{
  "generatedAt": "2026-08-24T00:00:00.000Z",
  "summary": {
    "sessionBytes": 0,
    "snapshotBytes": 0,
    "totalMeasuredBytes": 0,
    "duplicateSnapshotBytes": 0,
    "sessionUnavailableCount": 0,
    "degradedSnapshotCount": 0
  },
  "sessions": [],
  "snapshots": []
}
```

Session rows include ID, title, workspace ID/title, archive-or-trash scope,
measurement status, bytes, and file count. They never include workspace paths.
Snapshot rows include whether the snapshot is the active one named by a recycle
record. A digest repeated in multiple valid snapshot copies contributes all but
one occurrence to `duplicateSnapshotBytes`; this is informational and does not
imply that Harness's global attachment object is reclaimable.

The service caches a completed inventory for 30 seconds and shares one in-flight
inspection. Recycle operations and snapshot mutations invalidate it.

### Multiple snapshot history

`RecycleService.moveOne()` no longer removes the prior valid snapshot after a
new snapshot and recycle record commit. The record still points to exactly one
active snapshot. Restoring a recycle record keeps its snapshot, as in 0.11.0.
Repeated restore/recycle cycles therefore create valid historical snapshots.

`RecycleService.purge()` remains authoritative for permanent chat deletion and
continues removing every validated snapshot for that session. Existing 0.11.0
data remains valid without migration.

### Retention policy store

Create `lib/retention.js` with a pure normalizer, an atomic JSON store, a pure
planner, and a coordinator. The local document is:

```json
{
  "version": 1,
  "policy": {
    "historicalSnapshotsPerSession": 1,
    "historicalSnapshotMaxAgeDays": null,
    "snapshotQuotaBytes": null,
    "recycleMaxAgeDays": null
  }
}
```

The file lives at
`$DSH_HOME/plugin-data/archived-chats/retention.json`, uses directory mode
`0700`, file mode `0600`, exclusive random temporary files, atomic rename, and a
per-resolved-path write queue.

Validation rules:

- `historicalSnapshotsPerSession`: integer `0..20`;
- `historicalSnapshotMaxAgeDays`: `null` or integer `1..3650`;
- `snapshotQuotaBytes`: `null` or safe integer `1 MiB..8 TiB`;
- `recycleMaxAgeDays`: `null` or integer `1..3650`;
- exact keys only, canonical version one only, and no unsafe JSON keys.

A missing file yields the default above. Malformed JSON or an unsupported
version is `unavailable`; reads expose the failure and writes refuse to replace
the original bytes.

The default does not age-purge recycle records and does not impose a snapshot
age or quota. The per-session history value affects only a user-requested policy
preview/application; nothing runs automatically.

### Retention planner

`planRetention({ inventory, trashRecords, policy, now })` is pure and returns
ordered candidates plus a deterministic fingerprint.

Snapshot candidate rules:

1. Never select the active snapshot referenced by a current trash record.
2. For each session, sort non-active valid snapshots newest first; keep the
   configured history count and select older excess snapshots.
3. Add remaining non-active snapshots older than the configured maximum age.
4. If trusted snapshot bytes still exceed the quota, add the oldest remaining
   non-active snapshots until the projected total is at or below the quota.
5. De-duplicate candidates by snapshot ID while retaining the first reason.
6. Never select degraded or unvalidated snapshots.

Recycle candidate rules:

1. Produce none when `recycleMaxAgeDays` is `null`.
2. Select only `trashed` or `degraded` records whose canonical `trashedAt` is at
   least the configured age.
3. Never select `purge-pending` records; startup recovery already owns them.

Candidate types are `delete-snapshot` and `purge-trash`. Each includes only the
identity, trusted bytes, timestamp, and reason needed for display and
revalidation.

### Preview and application coordinator

The coordinator exposes:

- `GET /plugins/dsh-archived-chats/insights` — read-only inventory plus current
  policy status and a candidate-count summary;
- `POST /plugins/dsh-archived-chats/retention/policy` — guarded policy save;
- `POST /plugins/dsh-archived-chats/retention/preview` — guarded fresh plan;
- `POST /plugins/dsh-archived-chats/retention/apply` — guarded selected apply.

Preview returns a cryptographically random token and nonce with a five-minute
in-memory TTL. The server stores the exact candidate identities and fingerprint;
raw session content is never stored in the token record.

Apply accepts one token, its nonce, and an ordered subset of candidate keys.
Tokens are single-use. Each candidate is processed sequentially:

- `delete-snapshot` is revalidated as a valid, non-active snapshot with the
  same session ID, created time, and trusted byte count before
  `snapshotStore.remove(snapshotId)`;
- `purge-trash` is revalidated against the same recycle state and `trashedAt`,
  then delegated to `recycleService.purge([sessionId])`.

Changed or missing candidates fail with stable reasons and remain untouched.
The response contains ordered `applied`, `failed`, and refreshed summaries.
There is no client-supplied filesystem path and no direct physical session
deletion in the retention module. Revalidation and mutation run through the
same lifecycle queue used by recycle move/restore/purge so those operations
cannot change active-snapshot ownership between the final check and deletion.

### Session lineage projector

Create `lib/lineage.js` with pure `projectLineage(...)`. The route
`GET /plugins/dsh-archived-chats/lineage` gathers authoritative headers from
`persistence.list()`, active recycle records, archive membership, and workspace
accounting, then returns a bounded forest.

Each real node exposes:

```json
{
  "id": "session-id",
  "parentSession": null,
  "seedLength": null,
  "origin": null,
  "delegationDepth": 0,
  "title": null,
  "createdAt": 0,
  "workspace": { "id": null, "title": null },
  "status": "active",
  "children": []
}
```

Status precedence is `trash`, then `archived`, then `active`. Missing referenced
parents become synthetic `missing` nodes containing only their ID and children.
Workspace paths, event bodies, notes, tags, and attachment descriptors are not
part of this response.

Titles come only from an existing header title, the archive title cache, or a
recycle record. The lineage route does not inspect every active transcript just
to obtain a title; rows without a safe cached title display their session ID.

Projection rules:

- `parentSession` is the only parent edge; `origin` and `delegationDepth` are
  presentation and diagnostic fields, not alternative edges.
- Siblings sort by `createdAt`, then ID.
- Roots sort by `createdAt`, then ID.
- Self-parent and cycles are detached into deterministic roots and reported as
  diagnostics; traversal never loops.
- Diagnostics include `missing-parent`, `self-parent`, `cycle`, and
  `delegation-depth-mismatch`.
- The response is capped at 5,000 real headers. Exceeding the cap returns 413
  without a partial graph.

The view is read-only. It does not rewrite headers or offer relationship repair
in 0.12.0.

## Browser interface

The existing settings page adds two top-level tabs after **Archived** and
**Recycle Bin**:

- **Storage & Retention**
- **Session Lineage**

### Storage & Retention

The tab shows compact summary cards for session bytes, snapshot bytes, measured
total, repeated snapshot bytes, and unavailable/degraded counts. A table groups
session and snapshot usage by project/session without rendering local paths.

Policy controls use explicit inputs with disabled/null choices. Saving a policy
does not run it. **Preview cleanup** opens an accessible dialog containing every
candidate, reason, bytes, and projected reclaim. Snapshot candidates and recycle
purges are visually separated. All candidates start selected except recycle
purges, which start unselected because they permanently delete chats.

Applying snapshot-only cleanup uses an ordinary confirmation. Any selected
recycle purge uses the existing destructive styling and copy that names removal
of the original chat and all protection snapshots. Cancel receives initial
focus, focus is trapped, Escape closes only the plugin dialog, and focus returns
to the trigger.

### Session Lineage

The lineage tab renders an accessible collapsible tree, not a free-form canvas.
Rows show title/ID, active/archived/recycle/missing status, ordinary/subagent
origin, delegation depth, created time, and child count. Search matches title or
ID while preserving ancestor context. Diagnostic badges explain missing parents,
cycles, and depth mismatches. The tree is read-only.

Both tabs preserve the existing responsive host-dialog adaptation, English and
Chinese locale namespaces, light/dark tokens, loading/error/empty states, and
on-demand rendering.

## Error and recovery behavior

- An unavailable session measurement produces an unavailable row, not a failed
  inventory.
- An unreadable trash, retention, or snapshot authority fails closed for policy
  preview/application. The archive and recycle tabs remain usable where their
  existing authorities are healthy.
- Inventory never trusts a degraded snapshot's declared size.
- Policy application is partial and sequential. A failure does not stop later
  independent candidates and never rolls back a successful prior deletion.
- `purge-trash` inherits `purge-pending` crash recovery.
- A snapshot deletion failure leaves its directory and returns a stable failure.
- A stale preview can never delete a newly active snapshot or a changed recycle
  record.
- Logs contain stable IDs/error codes only, never titles, notes, transcript text,
  attachment names, or policy tokens.

## Persistence and downgrade behavior

- `trash.json` remains version one.
- Snapshot manifests and snapshot-session records remain version one.
- `retention.json` is new and ignored by 0.11.x.
- 0.12.0 may leave more than one valid snapshot directory per session. 0.11.x
  startup recovery already tolerates multiple valid snapshots and selects the
  deterministic latest one; permanent purge removes all validated snapshots.
- Downgrading does not corrupt histories, but 0.11.x does not display or govern
  them. Users should back up `$DSH_HOME/plugin-data/archived-chats/` before a
  downgrade.

## Security and privacy

- All POST routes require the existing same-origin guard header and bounded JSON
  bodies.
- Preview tokens are random, single-use, expire after five minutes, and are not
  persisted.
- All path operations resolve below configured roots, reject symbolic-link
  escapes, and use exact server-derived identities.
- The client receives no filesystem path, transcript content, attachment bytes,
  attachment names, or policy token after successful consumption.
- Tests and browser verification use an isolated temporary DSH home only.

## Testing strategy

### Snapshot and inventory tests

- multiple snapshots remain after a second recycle cycle;
- inventory trusts only validated manifests and excludes degraded sizes;
- digest duplication accounting is deterministic;
- active snapshot identification follows `trash.json`;
- session measurement remains bounded, cached, and symlink-safe;
- no response exposes a path or attachment byte.

### Retention tests

- exact policy schema, defaults, limits, atomic writes, concurrency, and corrupt
  byte preservation;
- deterministic count, age, quota, and recycle-age planning;
- active/degraded/purge-pending exclusions;
- preview token expiry, nonce, single use, subset ordering, stale revalidation,
  partial failures, and invalidation;
- recycle candidates delegate to the existing purge transaction.

### Lineage tests

- roots, forks, subagents, multiple levels, missing parents, self-parent, cycles,
  depth mismatch, sorting, status precedence, and 5,000-node cap;
- response privacy and no persistence writes.

### Client and integration tests

- four-tab navigation and lazy request lifecycle;
- localized storage cards, policy fields, preview selection defaults, destructive
  confirmation, focus trapping/restoration, and error states;
- accessible lineage tree, search with ancestor context, collapse state, status
  and diagnostic badges;
- route method/guard/body bounds and exact response shapes;
- unchanged archive, preview, export/import, recycle, and sidebar behavior.

The full `npm test` suite and `npm pack --dry-run --json` must pass. Browser
verification runs against an isolated real Harness host before screenshots or a
release are created.

## Acceptance criteria

1. Users can distinguish archived/recycled session bytes from plugin-owned
   snapshot bytes without seeing local paths.
2. Users can save a valid policy without triggering cleanup.
3. Cleanup always presents exact candidates first; recycle purges are not
   preselected.
4. Applying a stale preview cannot delete changed or newly active data.
5. No default or background behavior permanently deletes a chat.
6. Repeated recycle cycles retain history until an explicit policy application
   or permanent purge.
7. Users can navigate a deterministic, bounded session tree and identify missing
   or malformed lineage without modifying it.
8. Existing 0.11.0 data loads without migration and existing features continue
   to pass their tests.
9. Chinese and English documentation state the local-data, downgrade, attachment
   GC, and non-automatic retention boundaries accurately.
