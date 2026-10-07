# Architecture and maintainer notes

English · [中文](ARCHITECTURE.md) · [User guide](USER_GUIDE.md)

This document follows `main` and covers 1.4.6 behavior. This release fixes permanent deletion and Recycle Bin cleanup when historical and current session log generations coexist. See the [changelog](../CHANGELOG.md) for release history. Runtime code is the authority for interfaces and behavior; user-facing documentation should agree with it.

## Product boundary and modules

The plugin supplements archive management; it does not replace DSH's main chat area. The browser accesses data only through Host routes. The Host persistence provider owns session files.

| Module (under `lib/`) | Responsibility |
| --- | --- |
| `index.js` | Host capability resolution, routes, archive visibility, lifecycle queue, physical deletion |
| `client.js` | Settings page, six views, dialogs, native archive notice, request state |
| `about.js` | Local plugin identity, bounded public version checks, in-memory cache |
| `persistence-compat.js` | Legacy inspect and modern read-handle adaptation; separate title reads |
| `workspace-bulk-archive.js` | Eligible workspace chats, short-lived confirmation, apply-time checks |
| `trash.js`, `snapshot.js`, `recycle.js` | Recycle catalog, validated protection snapshots, move/restore/purge |
| `export.js`, `import.js`, `restore.js` | ZIP export, bounded import validation, transactional restoration |
| `metadata.js`, `durable.js` | Tags/notes, serialized atomic writes, durability primitives |
| `search.js`, `stats.js`, `insights.js` | Message projection/search, directory measurements, storage accounting |
| `retention.js`, `retention-service.js`, `auto-retention.js` | Policy, confirmation/revalidation, startup recovery and scheduling |
| `lineage.js` | Read-only source, fork, and subagent projection |
| `session-graph.js` | Session-id normalization, subagent descendant resolution, orphan classification |

The UI moves chats to the Recycle Bin only through workspace actions. Rows can permanently delete or unarchive. Workspace export and export-all remain. A compatibility backend endpoint accepting one ID does not imply a row-level recycle action.

Standalone History, legacy-snapshot recovery copies, and cleanup-preview UI are retired. `history.js`, `history-restore.js`, and `legacy-recycle.js` are not current modules.

## Host routes

```text
GET  /plugins/dsh-archived-chats/about
POST /plugins/dsh-archived-chats/about/check-updates
GET  /plugins/dsh-archived-chats/state
GET  /plugins/dsh-archived-chats/stats
GET  /plugins/dsh-archived-chats/insights
GET  /plugins/dsh-archived-chats/lineage
GET  /plugins/dsh-archived-chats/workspace-archive/workspaces
POST /plugins/dsh-archived-chats/workspace-archive/preview
POST /plugins/dsh-archived-chats/workspace-archive/apply
POST /plugins/dsh-archived-chats/retention/policy/preview
POST /plugins/dsh-archived-chats/retention/policy
POST /plugins/dsh-archived-chats/retention/preview
POST /plugins/dsh-archived-chats/retention/apply
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
GET  /plugins/dsh-archived-chats/unarchived
POST /plugins/dsh-archived-chats/unarchived/export
GET  /plugins/dsh-archived-chats/orphans
POST /plugins/dsh-archived-chats/orphans/delete
POST /plugins/dsh-archived-chats/orphans/export
```

Except for export, these POST routes require `x-dsh-archived-chats: 1`. Content preview, images, and search also use guarded POST. Export separately accepts a bounded native form without this header guard and checks current archive visibility for the requested sessions. Other routes parse their respective bounded payloads.

All `/history` and `/history/*` routes are removed; their former 410 response is no longer promised. `/retention/preview` and `/retention/apply` remain manual compatibility APIs, but the client has no separate cleanup-preview entry. API compatibility is not a product page.

`/delete` accepts `sessionId`; `/delete-all` accepts `sessionIds`. By default they call recycle `move`; only `permanent: true` invokes `deleteArchived`. Direct archive purge returns `{ deleted, pending, failed }`. With failures and no successful deletions it returns HTTP 409; partial success can return 200. Consumers must inspect the result arrays rather than the status alone.

Recycle endpoints call `restore`, `purge`, and `empty`. Empty requires the exact `trashed`/`degraded` record incarnations captured by the confirmation, including recycle and snapshot identity. The service purges only those targets: later records are excluded, and changed targets fail instead of expanding or recomputing the scope. Existing `purge-pending` tasks continue only through their independent retry flow. Canonical exclusive-directory checks authorize session-owned deletion; they do not claim broad filesystem deletion guarantees, and uncertain outcomes retain their durable records.

The orphan routes are the only place this plugin destroys a session that was never archived. `GET /orphans` lists the residue: subagent sessions whose parent no longer exists, plus top-level sessions that never recorded a turn. A subagent whose parent is still stored is reachable through that parent and is not listed, and neither is a branched chat, which is an independent conversation. Blankness cannot be read from a header, so it is decided by reading the log, and the scan yields cooperatively and supports cancellation instead of silently truncating a fixed prefix. Operation checks inspect only selected blank candidates and preserve unreadable logs.

`POST /orphans/delete` and `POST /orphans/export` never trust the id list they are handed: both recompute the orphan set and refuse the entire request with `orphan-set-changed` when any id is invalid at the start of the operation. Each item is checked again before its deletion; later external Host changes can produce partial results. Being an orphan is what replaces the archive precondition, so without that check the route would delete any session by id. Delete reuses the whole permanent-delete path — exclusive-directory verification, snapshot sweeping, live disposal, the durable `purge-pending` intent, and the registry index purge — with the archive precondition as the single step lifted. Export reuses the archive export writer and its budgets, and like `/export` it accepts a bounded native form with no guard header. Preview and preview-image accept `scope: "orphan"`, whose visibility authority is the same recomputed orphan set.

## State, ownership, and durability

Plugin state lives under `$DSH_HOME/plugin-data/archived-chats/`:

| Path | Current purpose |
| --- | --- |
| `metadata.json` | Versioned tags and notes |
| `trash.json` | Authoritative recycle and permanent-deletion intent catalog |
| `retention.json` | Version 2 policy with explicit `recycleAutoDelete` |
| `snapshots/` | Protection snapshots, staging, and recovery files |
| `pending-deletions.json` | Legacy deletion-marker compatibility and migration input |
| `legacy-recycle.json` | Legacy file, no longer read or projected |

The Host archive registry establishes archive ownership. Normal archive visibility excludes all IDs in the recycle catalog, including pending tasks. An unreadable or unsupported trash catalog retains its original bytes, marks the archive list unverified, and fails mutations closed.

Metadata and recycle writes are serialized and published through temporary files and atomic rename. The lifecycle queue serializes critical rechecks and commits for archive, import restore, recycle, and purge. Files use `0600`, directories `0700`; files and parent directories are synced with safe fallback on platforms lacking directory fsync. Windows transient EPERM/EACCES/EBUSY errors receive bounded retries; containment checks use platform path rules.

## Workspace bulk archive

The client registers `settings.section` and `shell.overlay`. Its Unarchived conversation list lives in **Settings → Archive Management / 设置 → 归档管理**, without depending on a workspace-menu extension or shared client store.

1. List workspace conversations in Unarchived, excluding archived, recycled, pending deletion, and subagent rows. Use `readSession` for cold forks and preserve metadata.
2. Individual archiving binds `sessionIds`; workspace and global actions cover complete workspaces regardless of search or filters. A stale individual target fails rather than expanding scope.
3. Show one aggregate confirmation. Empty preparations return to the refreshed list.
4. Apply token/nonce confirmations, rechecking membership and running status after asynchronous inspection. Refresh archive, Unarchived, sidebar, and storage consumers after success.

Apply accepts credentials, not caller-added session IDs. Under the lifecycle queue, each chat is rechecked for workspace membership, archive state, agent state, and a real `turn/start`. Blank chats yield `session-empty`; unverifiable content yields `session-unavailable`. Older Hosts without agent status conservatively skip loaded chats. Candidate inspection concurrency is eight.

Public `workspaceRegistry.archiveSession()` is invoked with its receiver. The operation does not stop active chats, move workspace membership, change directories, or capture versions. Missing capability returns `workspace-archive-unsupported`.

## Persistence compatibility and fork titles

A provider with native `inspect` is preserved unchanged. Modern `list()` snapshots and `open(id, 'read')` handles are adapted to internal `list`, `listSnapshots`, `inspect`, `readSession`, and `readTitle`. Reads start at offset zero; handles close on success and failure.

`readTitle` allows inherited events but returns only the last nonblank `session/title` string, never a backup event payload. Archive listing prefers it, preventing strict backup inspection from blocking fork titles.

`readSession` returns `{ meta, events, inheritedEventCount }` for content preview/search and protection snapshots. The cut must be a nonnegative integer within the complete log; unseeded sessions require zero. Version 2 `snapshot-session` records retain this cut beside the full events; manifests remain version 1. Readers validate the v2 cut while retaining support for legacy v1 records. Snapshot failures distinguish missing, unreadable, and unsupported sources.

Strict legacy `inspect` still refuses positive inherited counts. Modern ZIP export uses `readSession` and v2 instead, retaining the cut. Recycle restore prefers an intact original without rewriting it; its separate legacy snapshot writer still refuses a positive cut when the original is missing and retains the protection record.

The adapter exposes modern `create` as `createWriteHandle`, not legacy create/append. It forwards locate only when the provider exposes it, validating the absolute path result. Without locate, directory accounting, physical purge, and the modern ZIP rollback adapter are unsupported. Read-only providers with locate can still support direct deletion.

## Preview, search, and client behavior

Preview defaults to a currently visible archived ID; `scope: "trash"` instead requires a recycle record. Search covers visible archived chats only. Chat content uses Harness append-origin projection without duplicate replacement copies; system-prompt updates are retained separately. On resume or a new request series, `request/header` may reference the recorded effective system prompt, respecting replacement and clearing while avoiding adjacent duplicate cards. Projection pages retain log order; the client uses `anchorSeq` to place the applicable prompt before that turn's input. Missing prompt information is not inferred.

Image authorization proceeds through request guard, bounded identity fields, current visibility, an exact canonical projected descriptor, and optional public attachments.readImage. Visibility is rechecked after asynchronous reads. Responses use no-store/nosniff; errors do not echo paths.

Recycle preview currently still uses the original session projection, with no protection-snapshot fallback. A missing original can make preview fail even when the recovery service can restore its snapshot. This is a known limitation, not implemented snapshot-preview support.

Search reads have concurrency four. Projection caching uses a 30-second TTL and 64-session LRU. Limits are 256 Ki Unicode code points per segment, 1 Mi code points/1,000 segments per message, and 10,000 projected messages per session. Unknown structured values are bounded before stringify; oversized content is truncated or excluded from cache.

The client accepts public React component types, including React.memo-wrapped MarkdownText, and prefers Host MarkdownText, DisclosureRow, and JsonBlock with escaped text/native details/pre fallbacks. Tool results join only earlier matching calls. Images use Blob URLs, canceled and revoked on close/unmount; request sequence checks reject late responses. Turn navigation is on the left for desktop and horizontally above content at widths up to 640px.

Turn projection retains recorded boundaries and process/final-response positions. Only a fully loaded, closed turn with a known final response is grouped into a default-closed process disclosure; partial or boundaryless content stays in event order. Process summaries use Thought or observed tool/message/subagent counts, with nested reasoning, context provenance, and tool arguments/results initially closed. The final response sits outside the process disclosure. Real user messages align right; all assistant process content aligns left. The preview is read-only with no composer, does not invent usage or timing, and does not promise full native feature parity or missing log content. Deployment must reload the actual DSH backend to replace the projection code; browser refresh alone is insufficient.

Export download uses a guarded fetch, validates status, ZIP content type, and attachment disposition, then buffers the complete response before creating a Blob URL. It has a five-minute end-to-end timeout and a 320 MiB response-byte cap for declared and streamed bodies. The cap is not a peak-heap guarantee because chunks, the contiguous buffer, and Blob can coexist; the non-stream WebView fallback has no stronger universal memory ceiling. Completion says the download started, not that the browser saved it to disk.

Archive row actions are preview, edit tags/note, Unarchive, and Delete. The header exposes More; Unarchived reuses `GroupSection`, with search above filters and a refresh icon at the right; rows offer a read-only preview icon and Archive, while workspace menus and the header offer Archive all; More contains Import backup, Export all, Unarchive all, a separator, and Delete all. Header geometry stays consistent across tabs. Workspace menus contain Unarchive all, Move all to Recycle Bin, Export all, a separator, and Delete all; every action confirms the full workspace name and complete archive count. Global export/unarchive/delete confirms all archived chats across workspaces, excluding trash. Filters do not narrow these scopes. Delete/Delete all labels lead to concise irreversible-action confirmation naming the chat, workspace, or global scope. Recycle rows retain the preview icon and use compact Restore/Delete text buttons matching archive rows. Recycle workspace actions are Restore all and Delete all; its header directly offers text-only Restore all and Empty Recycle Bin, without a More menu. Empty still requires irreversible-action confirmation. Primary buttons and selected tabs use neutral theme colors that invert in dark mode, while destructive actions remain red. Workspace/global restoration separately confirms the workspace name or global workspace count, eligible chat counts, and Archived destination, skipping purge-pending. A synchronous submission lock prevents duplicates; results retain actual success/failure counts and View Archived navigation. Both deleted and pending IDs leave actionable archive rows while failures remain explained and related state refreshes.

Plugin confirmation, preview, import, metadata, storage, and retention dialogs share the opaque `--dsw-alias-bg-layer-2` surface and Host prominent elevation, with a legacy shadow fallback. Menus and toasts use opaque theme layers. Masks and hover states retain their intentional transparency; frosted menu tokens are not used as dialog backgrounds.

## About and version discovery

`GET /about` returns loaded-package identity, controlled links, and cached status without contacting the network. `POST /about/check-updates` uses the existing same-origin guard and accepts exactly `{ force: boolean }`. It requests only `https://registry.npmjs.org/dsh-archived-chats/latest`, without chat data, backups, or client credentials. Redirects, non-success status, wrong package names, and invalid SemVer are rejected. SemVer comparison never recommends a downgrade. Requests time out after 5 seconds and responses are bounded to 64 KiB.

Automatic success/failure results have a 12-hour in-memory cache; manual checks have a 30-second cooldown, and concurrent checks coalesce. Backend reload resets the cache. Failure yields unavailable, never current. The client loads local metadata before a background cache-aware check and ignores canceled/stale results. About is the final tab; the update link beside the heading only opens the plugin market. No installation, commands, or restarts run. Users follow host guidance to reload the backend; refreshing the frontend alone may not activate an updated backend.

## Recycle and restore

Move order: validate archive ownership → dispose/park a loaded session → capture or reuse a healthy protection snapshot → revalidate ownership → atomically write trashed → invalidate caches. Ordinary recycling does not remove the original log.

Snapshot manifests use `dsh-archived-chats/snapshot` v1; `dsh-archived-chats/snapshot-session` payloads use v2 when inherited metadata is available, otherwise legacy v1. Limits: 4 MiB manifest, 64 MiB session JSON, 1,000 attachments, 32 MiB per attachment, 512 MiB total. Attachments are SHA-256-validated as streams and reread individually before restoration, not all retained in memory.

Restore rejects purge-pending. For other records it first checks original identity. If present, it restores archive visibility, workspace association, and missing metadata, then removes the recycle record without rewriting logs. A degraded entry is therefore not necessarily unrestorable.

For a missing original, validate snapshot identity/content, reject seeded sources whose exact inherited boundary cannot be represented, recheck ID conflicts, and require explicitly exclusive create plus append/locate and saveImage where needed. Plain create is never ownership. Restore uses the original ID, not a new archived copy. Attachment identity must match. Commit spans the log, workspace, metadata, archive registry, and recycle record. Failure compensates in reverse; uncertain creation and rollback failure retain the destination and recovery record and are reported separately. Missing workspaces or unpaired attach/detach capabilities yield an ungrouped warning.

Protection snapshots left unreferenced after restore are not projected as recycle entries. A later startup handles them through legacy-data cleanup.

## Permanent deletion and crash recovery

Trash states and transitions:

| State | Meaning | Restoration |
| --- | --- | --- |
| `trashed` | Recycled, protection data available | Prefer original, otherwise validated snapshot |
| `degraded` | Protection data missing or unavailable | Original may restore; fallback requires validation |
| `purge-pending` | Permanent-deletion intent committed | No restore or unarchive; completion only |

Move is missing → trashed; recycle purge is trashed/degraded → purge-pending; direct archive purge can be missing → purge-pending. Direct deletion first validates archive ownership, absence of a recycle record, public location capability, and a session-scoped directory. It writes snapshotId null with zero snapshot bytes and attachment count, creating no recoverable copy.

Both paths share purge: persist intent → remove and recheck all associated snapshots → physically delete the session → finish registry/metadata cleanup → remove the recycle record last. Physical deletion runs with the caller's lifecycle lock and a pending marker.

Snapshot sweeping uses manifest ownership and the record's named snapshotId to cover corrupted protection data. Unrelated unassignable corruption does not block a session's purge. The log must reside in a directory named for that session ID; shared directories are not purge targets. Safety checks use the actual session directory as the removal scope. If the current-generation log named by `locate()` is absent, inspect canonical generation logs that exist in the directory; empty directories still undergo ancestry and overlap checks. Inventory entries with absent directories are treated as missing and do not block other purges. Links/junctions, non-file logs, overlapping directories, and unreadable inventory still refuse deletion. A missing log or archive index is not proof of completion: durable intent authorizes remaining cleanup.

Failures retain purge-pending. Startup and runtime retries continue these tasks, never restore them to ordinary chats. Archive deletion rejects existing recycle records, protecting the Recycle Bin from archive-wide Delete all. Purging snapshot copies does not promise global attachment cleanup or Host session_projcache eviction; no corresponding safe public eviction API is used.

Destroying a session also destroys its subagent descendants, transitively, so a deletion cannot strand sessions that no workspace owns and no view lists. Session ids are stored in two dialects — a bare UUID and the same UUID behind `session-` — and one edge may mix them, so every parent/child comparison normalizes first; without that, each parent looks absent and the cascade silently finds nothing. Only `origin: "subagent"` edges are followed. A branched chat keeps a pointer to the chat it came from but is an independent conversation, so neither it nor its own subagents are cascade targets. Descendants are resolved *before* the parent is destroyed, because a child edge is only visible while its parent is still listed; resolving afterwards would strand exactly the sessions the cascade exists to remove.

Cascade runs on the permanent paths only: direct archive deletion, recycle purge, Empty Recycle Bin, and automatic retention. A move to the Recycle Bin leaves the original log on disk, so its subagents are not orphans yet — they become orphans exactly when the parent's log is destroyed, which is where the cascade runs. Descendants are never archived, so they take the direct permanent-delete path with only the archive precondition lifted; exclusive-directory verification, snapshot sweeping, live disposal, and registry index cleanup are all shared with an archived session. A descendant that already owns a recycle record keeps its own lifecycle, and a parent whose own deletion failed still exists, so its subagents are kept.

## Startup recovery and old-data cleanup

recoverStartup performs:

1. Recover snapshot storage and load the authoritative recycle catalog; mark missing protection data degraded, excluding pending tasks.
2. Retry purge-pending.
3. Read legacy pending-deletion markers. Attempt recoverable migration for still-archived, non-recycled IDs and remove successful markers; do not immediately purge them.
4. Under the lifecycle queue, reread the catalog and snapshot inventory. Protect every currently referenced snapshotId and remove other valid or degraded snapshots.

This startup old-data cleanup is independent of recycleAutoDelete and has no retired cleanup-preview UI. An unreadable authoritative catalog prevents speculative sweeping; unreadable migration input can return early. Individual snapshot cleanup errors are logged as stable codes and can be retried on a later startup.

Cleanup removes plugin snapshots and attachment copies, not source chats. The older promise that every snapshot survives an upgrade as a Recycle Bin entry no longer applies. Users must preserve needed old data before upgrading.

## Storage, retention, and lineage

Stats measures directories with concurrency four, skips symlinks, and caches for 30 seconds; failure affects only the relevant item. Insights counts only protection snapshots referenced by current recycle records, separately from archived/recycled session directories. Repeated attachments use validated SHA-256 and are not presented as globally reclaimable space.

Policy version 2 explicitly opts in. Reading version 1 forces recycleAutoDelete false without rewriting disk. Legacy count/age/quota fields no longer produce snapshot candidates. Enabling or shortening recycle retention requires a five-minute, single-use token/nonce bound to old/new policy and expired candidates. Saving rechecks under the lifecycle lock but does not itself delete.

The scheduler completes startup recovery, then checks serially about once a minute. Each purge revalidates policy and record; failures remain for retry. Disabling policy does not cancel committed deletion intent. Plugin disposal stops new timers. Legacy manual retention APIs retain their own confirmation/revalidation.

Lineage uses durable parentSession only, focusing archived/recycled chats and required context. At most 100 missing titles are read on demand; the 5,000-node limit applies to the displayed graph. Unknown fields degrade individual nodes. Search/filtering preserve ancestors and never modify relationships.

The client iteratively assigns each managed node to its own workspace once. Cross-workspace nodes become local roots while sourceParent retains the actual immediate-parent summary. Search/status filtering then runs within groups; folding changes visibility only. Workspace folds persist separately in browser key dsh-archived-chats:lineage-workspaces, without Host writes or changes to archive-group preferences. Initial loading folds every managed node with descendants. Search temporarily ignores folds and clearing restores them; bulk folding affects only the current filtered results.

Named native buttons expand branches and native details/summary disclose timestamps, full titles, and IDs, without making the whole row clickable. Iterative flattening retains actual levels with at most two ancestor-guide columns; deeper rows show a level label and direct-parent context. Narrow layouts allow title/status wrapping and avoid a separate scroll area inside the tree. Backend lineage, archive, and deletion interfaces are unchanged.

## ZIP export, import, and restore

Export contains a manifest and per-chat session.json/transcript.md with sanitized collision-safe paths. It inspects every selected source exactly once and stages the rendered entries before returning a sequential ZIP stream. `fflate` compresses those entries synchronously in 256 KiB slices with an event-loop yield between slices, and the writer no longer depends on `zip-stream`, so it cannot pull in the `readable-stream@4` chain that requests a builtin name with a trailing slash. The shared complete semantic validator and all importer budgets run first, so a successful export is importable by this plugin and a later invalid source cannot turn an already successful response into a partial backup. Modern reads produce v2 manifest/session records with `source.inheritedEventCount`; legacy reads retain v1. Import accepts ordinary records in both versions, requires matching manifest/record versions, and validates the v2 boundary. An ambiguous seeded v1 source is refused rather than flattened. Both formats exclude attachment bytes and automatic descendant recursion.

The shared limits are 2,000 sessions, 4,001 entries, 4 MiB manifest, 4 MiB per session JSON, 8 MiB per entry/Markdown, and 256 MiB expanded total. Imported compressed input is limited to 512 MiB. Each JSON document is limited to depth 64, 100,000 nodes, and 4 Mi Unicode code points across strings. Import uses bounded decompression and validates declared/actual sizes, paths, version, generator, JSON budgets, and cross-file identities. It reconciles local entries, data descriptors, and the central directory, including sizes and CRCs; truncation, invalid UTF-8, duplicates, encryption, ZIP64, multi-disk archives, and methods other than Store/Deflate are rejected. Existing IDs are disabled; missing workspaces or attachment references produce warnings. Confirmation lasts ten minutes and is single-use; at most eight previews totaling 128 MiB remain in process. Conflict rechecks and confirmed commits run in the lifecycle queue.

restore.js adapts verified modern create handles first, then dedicated restore or an explicitly exclusive legacy create/append/locate contract. Plain legacy create/append is unsupported: inventory absence does not prove exclusive ownership. Modern import preserves the exact cut, appends in batches, flushes (including empty logs), validates a full read, and closes handles after registry/metadata commit. Rollback authority starts only after successful creation. A safely located session-owned destination is required; an uncertain first-write artifact is preserved and reported as `restore-rollback-failed`, never blindly deleted. Legacy writers refuse inherited v2 records. Workspace attachment requires paired attach/detach. Conflicts include Recycle Bin entries and pending deletion tasks and are rechecked inside the lifecycle queue. This adapter serves ZIP import; recycle snapshot fallback has separate checks in recycle.js.

After raw import commits, optional public cold-title publication verifies the exact title and final event watermark under a shared bounded deadline. Cache absence, failure, timeout, or seeded-cold-list limitations return stable degraded warnings without rolling back durable restored data. Unarchive separately requires an authoritative readable persisted header with `cwd`; missing `cwd` is not the same as missing workspace and leaves the archived copy available for preview/export.

## Validation and release boundaries

`test/backup-roundtrip.test.mjs` uses an installed official backend with temporary storage when `DSH_NATIVE_MODULE_ROOT` points to its node_modules directory. It covers v1 recovery, fork v2 round-trips, preview/unarchive/reopen, first-publication failures, foreign-create races, and pending-deletion conflicts. Without that opt-in these native tests are explicitly skipped; modern adapter unit tests still run.

Tests cover retained modules: export/import rollback, snapshots/recycle states, interrupted deletion and restart, fork titles, complete reads and strict ZIP reads, retention scheduling, statistics, lineage, Host routes, client behavior, types, and package contents. test/archive-lifecycle.test.mjs covers fork preview, recycle/restore, inherited-cut preservation, and direct purge. Tests use isolated data, not real chats.

```sh
npm test
npm ci --prefix test/fixtures/native-host --ignore-scripts --include=optional
node scripts/run-native-integration.mjs
npm pack --dry-run --json
git diff --check
```

The native commands install the locked `@deepseek-ai/dsh-session@0.1.7-rc.2` fixture and require all six native integration cases to run without skips. This is the local equivalent of the mandatory native Host integration gate in CI.

The declared DSH `>=0.1.0-rc.7` range remains capability-based. Release automation tests Node.js 18 on Ubuntu and Node.js 24 on Ubuntu, macOS, and Windows; the Node.js 24 matrix requires the official `@deepseek-ai/dsh-session@0.1.7-rc.2` Host backend integration (6/6) and package checks, including the v4 session format. The [screenshots](../screenshots.json) show the current interface with synthetic example chats.

Permanent deletion quiesces live agents before the final descendant inventory. Optional `cascadeSessionIds` in the parent purge-pending record persist the complete targets until every descendant finishes, so startup can recover after the parent directory disappears. Forks and subtrees with independent recycle records remain outside the cascade. Do not downgrade to a version that does not understand this field while these records are pending.

`GET /unarchived` is read-only; `/unarchived/export` and preview `scope: "unarchived"` validate current workspace visibility. Normal conversations gain no direct permanent-delete route. Cleanup UI retains `/orphans` authority checks.
