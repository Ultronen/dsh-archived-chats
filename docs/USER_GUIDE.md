# Session Archive user guide

English · [简体中文](USER_GUIDE.zh-CN.md) · [Back to README](../README.md)

Session Archive provides a place to browse and manage DSH's archived chats, plus workspace bulk archiving. This guide describes dsh-archived-chats 1.4.0; see the [changelog](../CHANGELOG.md) for release history. For interfaces and data formats, see the [architecture](ARCHITECTURE.en.md).

## Understand the three locations

| Location | Purpose | Return to the main chat area |
| --- | --- | --- |
| Main chat area | Continue everyday conversations | Already there |
| Archived | Keep chats outside the main chat area | Choose Unarchive |
| Recycle Bin | Remove chats from the archive list while retaining a recovery opportunity | Restore to Archived, then Unarchive |

Archiving is not deletion and creates no historical version. Moving to the Recycle Bin does not immediately remove the original session files, but requires a protection snapshot. Permanent deletion is irreversible; it is not a Recycle Bin move.

## Install and open

```sh
dsh plugin --profile web add dsh-archived-chats@latest
```

Restart DSH and open **Settings → Session Archive**. The views are **Archived**, **Recycle Bin**, **Storage & Retention**, **Origins & Branches**, and **About**.

Before updating an older installation, read “Upgrades, old data, and downgrades” below, especially the snapshot-cleanup warning.

## Archive and find chats

Use DSH's normal session menu to archive one chat. The success notice offers View and Undo and closes after about three seconds. The plugin groups archived chats by workspace.

To archive in bulk:

1. Choose Bulk archive from the settings page.
2. Select one or more entries in the workspace chooser; clicking Select all again clears selection.
3. Click the bottom-right Confirm button and review the aggregate count and destination.
4. Confirm archiving; review the retained itemized results if anything was skipped or failed.

Only workspaces with eligible chats are listed. Blank sessions, chats in use, and chats whose content cannot be verified are skipped. Chats created after preparation are not included; workspaces that become empty are skipped. The operation does not move chats between workspaces or change workspace directories.

Search Archived by title, workspace, tags, notes, messages, and tool results. Filter by type, workspace, and tag; sort by time or title. Content matches show excerpts. Long workspace titles wrap to remain fully visible. Click a workspace folder or title to expand or collapse its chats; the open or closed folder reflects the current state. Group collapse state is saved in the browser.

Forked chats use the last valid title in their own event stream, including renames after branching. The Host creates a new chat ID with history inherited through the fork point; parent and child develop independently afterwards. Modern Hosts support preview and Recycle Bin moves, with ZIP export restrictions described under “Compatibility and limits.”

## Preview, tags, and notes

Read-only preview does not require unarchiving. It supports Markdown, reasoning, code, JSON, tool calls and results, and readable stored images. Missing attachment-read capabilities degrade images only. Closing preview cancels outstanding requests.

Fully loaded turns with a recorded end group intermediate work into a process disclosure, initially collapsed. Its summary shows Thought or recorded tool/message/subagent counts. Expand it to inspect nested reasoning, context provenance, and tool summaries with arguments and results; these details also start collapsed. The final response remains outside the process disclosure. Partial turns or logs without reliable turn boundaries stay expanded in event order instead of being folded into a complete turn.

System prompts start collapsed and scroll within a height-limited area when expanded. On resume or a new request series, the preview shows the recorded effective prompt without inferring missing instructions. Only real user messages appear on the right; assistant work, reasoning, tools, and injected context stay on the left. The preview has no message input. It uses the Host's Markdown renderer when available, but does not promise every native conversation feature or information absent from the log; it does not invent usage or elapsed-time values.

After updating, reload the DSH backend to activate the new preview projection. Refreshing the browser alone does not replace the running backend.

Each chat supports up to 8 tags of 24 Unicode characters each and a note of up to 2,000 Unicode characters. Tag matching is case-insensitive. Notes occupy one line; truncated notes expose their full text on hover or focus.

Tags and notes remain local. Unarchiving preserves them; completed permanent deletion removes them.

## Actions and their scope

| Page and entry | Actions | Scope |
| --- | --- | --- |
| Archived: chat row | Preview, edit tags and note, Unarchive, Delete | One chat |
| Archived: workspace More menu | Unarchive all, Move all to Recycle Bin, Export all; separator; Delete all | All archived chats in that workspace |
| Archived: header | Bulk archive, More | Open the workspace chooser or global action menu |
| Archived: header More menu | Import backup, Export all, Unarchive all; separator; Delete all | Export, unarchive, and delete cover archived chats across all workspaces; Import uses the selected ZIP |
| Recycle Bin: chat row | Preview icon, Restore and Delete text buttons | One recycle record; Delete is permanent after confirmation |
| Recycle Bin: workspace More menu | Restore all, Delete all | Recycle records in that workspace |
| Recycle Bin: header | Restore all | Restore eligible entries across all workspaces after confirmation |
| Recycle Bin: header | Empty Recycle Bin | Permanently delete recycle records across all workspaces after confirmation |

**Moving to the Recycle Bin is available only through workspace actions, not individual rows or a global move-all action.** There is no single-chat export or list multi-select mode. Search and filters do not narrow workspace or global bulk actions.

Every archive workspace action asks for confirmation with the full workspace name and its complete archive count. Global Export all, Unarchive all, and Delete all confirmations count archived chats across every workspace, excluding the Recycle Bin. Check these counts even when the list is filtered. The header keeps consistent dimensions when switching tabs.

Delete all on Archived means permanent deletion, not a Recycle Bin move; its dialog explains the irreversible effect and scope. It does not delete chats already in the Recycle Bin. Workspace deletion affects archived chats, not the workspace or project files.

Empty Recycle Bin captures the exact recycle-record incarnations displayed for confirmation, including their recycle/snapshot identity. Execution purges only those captured targets: records added later are excluded, and a target changed after confirmation fails instead of causing the scope to be recomputed or expanded. Uncertainty retains the record for a later safe retry; this is not a guarantee that unrelated Host filesystem content can be deleted.

## Restore from the Recycle Bin

Move all to Recycle Bin first creates or reuses a healthy protection snapshot for each chat, then writes its recycle record. Failed chats are not reported as successfully recycled. The success notice offers immediate Undo.

Choose Restore on a row, or Restore all for a workspace or the entire Recycle Bin. Restored chats return to **Archived**, not directly to the main chat area. Choose Unarchive afterward to continue chatting there.

Workspace Restore all first confirms the full workspace name, eligible chat count, and destination. Header Restore all confirms the total workspace and eligible chat counts. Both explain skipped pending deletions; canceling performs no restoration. Results report actual restored counts and offer View Archived; workspace results also name the workspace. Partial results include unsuccessful counts and reasons.

Restore prefers an existing, identity-matching original without rewriting its content. Only when the original is missing does it attempt to recreate an ordinary session ID from a validated protection snapshot, and only through an explicitly exclusive Host writer. Plain create/append and seeded snapshots whose inherited boundary cannot be preserved are refused before writing; the recovery record remains. Conflicting sessions are never overwritten. A missing workspace produces a warning and an ungrouped archived chat.

Degraded means protection data is unavailable or incomplete, not necessarily that recovery is impossible: an intact original may still be restored. Workspace Restore all attempts non-pending entries and reports failures. Entries already undergoing permanent deletion cannot be restored.

Recycle Bin preview currently still reads the original session. If the original is missing, preview may fail even when a protection snapshot can be used for recovery. A preview failure alone does not prove the snapshot is unrestorable.

## Permanent deletion and retries

Row, workspace, and archive-wide deletion actions require confirmation. Archived rows use the text label Delete, to the right of Unarchive; workspace and global menus use Delete all. The concise confirmation names the chat or workspace, or the complete global scope, and states that deletion is irreversible. Clicking the action only opens confirmation. The Recycle Bin also offers row/workspace permanent deletion and Empty Recycle Bin. Permanent deletion removes the target chat, plugin tags and notes, and related snapshots.

Once deletion starts, the plugin saves a non-restorable deletion task, removes associated snapshots, deletes the original, and completes index cleanup. Partial failures retain the task and error message for retries while running or on the next startup. Pending items are no longer actionable archive rows and cannot be restored or unarchived. Even if the original file temporarily remains, deletion cannot be undone.

Missing required Host capabilities cause refusal before a deletion task is committed. Removing snapshot attachment copies does not guarantee immediate reclamation of matching bytes in Harness's global attachment store; other references and Host caching or garbage collection may retain them.

## Export and import

Choose Export all from the header's More menu to export every archived chat, or from a workspace menu to export only that workspace's archive. Both ask you to confirm the full scope and chat count and exclude Recycle Bin contents. Restore recycled chats to Archived first if you need to export them. Import backup is also in the header's More menu.

Each ZIP contains:

```text
manifest.json
sessions/001-<safe-title>-<id>/session.json
sessions/001-<safe-title>-<id>/transcript.md
```

JSON is the machine-readable record and Markdown is the readable companion. Modern Hosts export ZIP v2, retaining each fork's exact inherited boundary; legacy readers produce v1. Both preserve attachment references but **do not include attachment bytes or automatically bundle descendant sessions**. This is not an attachment-complete backup. Consult Harness's official Session log export for conversation-tree export capabilities.

Before returning a download stream, export reads each selected source once, stages its rendered manifest/session/Markdown entries, and applies the same complete format and semantic validation as import. A successful plugin export is therefore within the plugin importer's format and size budgets. If any selected source is invalid or over budget, the whole export is refused before a successful download response; it does not emit a partial backup.

The shared package limits are 2,000 sessions and 4,001 entries; 4 MiB each for `manifest.json` and each session JSON; 8 MiB for any ZIP entry and for each Markdown transcript; and 256 MiB total expanded content. Imported ZIP input is capped at 512 MiB compressed. Every JSON document is additionally limited to depth 64, 100,000 nodes, and 4 Mi Unicode code points across its strings. JavaScript string storage can use more memory than the encoded byte totals.

Import accepts this plugin's v1 and v2 ZIP formats and previews before writing:

- Existing IDs, Recycle Bin entries, and unfinished deletion tasks are marked as conflicts, disabled, and skipped; existing sessions are never overwritten.
- Missing workspaces produce warnings and ungrouped archived chats.
- Tags and notes follow the same length limits.
- Expired confirmation requires another preview; unsupported restore writes are refused.

After importing, chats return to Archived with their original IDs, titles, events, and tags/notes. Preview them there, then choose Unarchive to return them to the main chat list. Modern-Host import explicitly flushes writes and releases ownership. If a failed write leaves artifacts whose ownership cannot be proven, the plugin reports incomplete rollback and preserves them: keep the ZIP and resolve the error before retrying; do not delete a conflicting chat merely to clear the warning.

Import requires a complete, internally consistent ZIP and rejects truncation, CRC or local/central-directory disagreement, invalid UTF-8, unsafe paths or JSON keys, duplicate/unreferenced entries, encryption, ZIP64, multi-disk archives, and compression methods other than Store or Deflate. A normal v1 backup remains supported, but a seeded v1 source without an exact inherited boundary is refused instead of flattened.

The browser buffers and validates the complete ZIP before initiating its download. The response-byte cap is 320 MiB and the complete fetch/body-read timeout is five minutes; this is not a peak-heap guarantee, and the current non-stream fallback has no stronger universal WebView memory promise. Download started does not mean the browser has saved the file to disk. A timeout or cap failure downloads no incomplete file and can be retried.

ZIP import and Recycle Bin recovery are separate workflows. A ZIP is not a Recycle Bin protection snapshot.

## Storage and automatic cleanup

Accounting separates archived/recycled session directories, protection snapshots referenced by current recycle records, unavailable or degraded measurements, and repeated snapshot attachment bytes. Searchable dialogs expose details. Totals are neither the entire Harness footprint nor a promise of globally reclaimable space.

**Automatic Recycle Bin cleanup is off by default.** Choose 7, 30, or 90 days, or 1–3650 whole custom days, counted from each chat's recycle time. Enabling or shortening retention shows already-expired entries and explains future deletions. After confirmation, individual cleanups do not ask again.

Checks run about once a minute while DSH is running, pause while closed, and catch up after startup recovery. Only expired records are deleted. Disabling or extending retention saves directly; deletion tasks already started still finish. A retention duration saved by an older version does not automatically enable cleanup.

This is separate from the old-snapshot cleanup below: **disabling automatic Recycle Bin cleanup does not prevent startup removal of unreferenced old snapshots.**

## Origins and Branches

This read-only view shows sources, forks, and subagent trees for archived and recycled chats, plus the active-session context needed to explain their relationships. Unrelated active chats are not listed.

Chats are grouped by their actual workspace, with counts in workspace headings and browser-persisted workspace folding. Compact rows use title-side buttons to expand branches; initially only starting chats are shown, not every descendant. Details disclose full titles, timestamps, sources, and session IDs with Copy ID. Ungrouped chats have their own group.

Deep forks do not keep consuming horizontal space: at most two ancestor-guide columns plus the current connector are shown. Deeper rows display their level, with the parent name and source ID still available for inspection. Cross-workspace forks appear in their own workspace with a source-workspace label, not as duplicate managed entries.

Search temporarily opens matching workspaces and branches; clearing it restores previous folds. Filters retain necessary source information. Expand/collapse all applies to the currently filtered workspaces and branches. Missing parents, cycles, and unknown fields produce diagnostics or degraded details without modifying relationships.

## About and updates

About shows the running plugin version, author, license, and direct links to the project, language-appropriate guide, changelog, issue feedback, and plugin market. The title also displays the running version.

Current version is read dynamically from the running backend, never substituted with the registry's latest version. A failed online check keeps the loaded version, identity, and links. Local metadata failure shows Unavailable and Reload information rather than an update-check error. If newly installed endpoints have not loaded yet, reload the DSH backend and retry.

Opening the archive loads local metadata immediately, then checks the public npm package version in the background. Automatic checks, including failures, are cached in memory for 12 hours during the running backend session. Check for updates bypasses this long cache with a short 30-second cooldown; concurrent checks share one request. No chat or backup content is sent. An unavailable registry reports failure without blocking archive management or claiming the plugin is up to date.

When a newer version is found, Get update beside the title opens the plugin market. This plugin does not download or install updates, run commands, or restart DSH. Follow the host's instructions after updating and restart when convenient; refreshing the page alone may not activate a new backend. The displayed version remains the actually loaded version until the backend reloads.

## Upgrades, old data, and downgrades

The standalone History and cleanup-preview interfaces are retired. Archiving no longer creates versions. Recycle Bin protection snapshots support recovery; they are not a browsable version-history library.

**After upgrading from an older release and starting the new version, startup recovery automatically removes old snapshots not referenced by current recycle records, including their plugin-owned attachment copies. They do not become Recycle Bin entries and cannot be recovered through the plugin afterward.** Referenced protection snapshots are retained. This cleanup does not delete source chats; retrying confirmed deletion tasks and enabled expiry cleanup are separate mechanisms.

If you still need old snapshot content, recover and export it using a supporting older release before updating, and separately preserve required attachments. You can also make an offline backup of the complete plugin-data directory first. Old pending-deletion markers are migrated toward recoverable recycle records, not treated as authority to immediately delete chats on startup.

Before downgrading, finish pending deletion tasks and back up plugin data. Older versions may not recognize newer pending records, particularly direct permanent-deletion tasks without a protection snapshot.

## Compatibility and limits

Features depend on public Host capabilities, not just a version number:

- Workspace bulk archiving requires public archive capability.
- Session-directory accounting and permanent deletion require session-scoped physical locations. The plugin does not guess paths or delete shared directories.
- Restoring an existing recycled original needs no log rewrite; snapshot fallback and ZIP import require the corresponding public writer capabilities.
- Modern-Host ZIP v2 supports exporting and importing inherited-history forks, including when the parent is absent. Old v1 backups without the boundary cannot safely rebuild a seeded session and are refused. Recycle Bin recovery remains separate: an intact original is restored without rewriting, but its legacy snapshot-fallback writer still refuses a missing fork original and retains the protection record.
- ZIP restore supports verified modern create handles and dedicated/exclusive writer contracts. Plain legacy create/append without an explicit exclusive-create guarantee is unsupported because absence from an inventory does not prove safe ownership.
- Unarchive requires an authoritative, readable persisted header with a working directory. A cwd-less chat remains safely available in Archived for preview/export; this differs from a missing workspace, which can degrade to an ungrouped archived chat. Optional cold-title publication can warn after a durable restore without rolling back or corrupting restored data.
- Version 2 protection records require this or a newer plugin. Before downgrading, restore recycled chats you need to retain and back up plugin data.
- If `trash.json` cannot be read, Archived is marked unverified, the Recycle Bin is unavailable, and archive mutations such as unarchive, tag/note editing, and deletion are refused instead of guessing.

The declared DSH `>=0.1.0-rc.7` range remains capability-based. Release automation passed Node.js 18 on Ubuntu and Node.js 24 on Ubuntu, macOS, and Windows; the Node.js 24 matrix required the official Host backend integration (5/5) and package checks. The installed 1.4.0 artifact also passed the official native round trip (5/5) against `@deepseek-ai/dsh-session@0.1.5-rc.2`.

## Local data and uninstall

Plugin state lives under:

```text
$DSH_HOME/plugin-data/archived-chats/
```

| File | Purpose |
| --- | --- |
| `metadata.json` | Tags and notes |
| `trash.json` | Recycle records and pending permanent-deletion tasks |
| `retention.json` | Automatic cleanup policy |
| `snapshots/` | Protection data and legacy snapshots awaiting cleanup |
| `pending-deletions.json` (legacy) | Migration input for old deletion markers |
| `legacy-recycle.json` (legacy) | Old snapshot migration state, no longer used |

The plugin does not upload, cloud-sync, or schedule historical captures. To uninstall:

```sh
dsh plugin --profile web remove dsh-archived-chats
```

Uninstalling preserves plugin data and does not permanently purge chats. Reinstalling still runs the installed version's recovery and cleanup rules; preserving the directory does not promise permanent retention of old snapshots. Do not treat manually deleting plugin data as Empty Recycle Bin: it loses recovery information without necessarily removing Host sessions. Prefer the UI and back up anything you still need first.
