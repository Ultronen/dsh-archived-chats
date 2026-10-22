# Archive Management user guide

Version 1.6.0 disables new recycle operations and automatic cleanup while retaining legacy data. See [upgrading and legacy data](#upgrades-old-data-and-downgrades).

English · [简体中文](USER_GUIDE.zh-CN.md) · [Back to README](../README.md)

Archive Management provides a place to browse and manage DSH's archived chats, plus workspace bulk archiving. This document describes 1.6.0, which supports DSH `0.2.1-rc.2` and retains older Host support, with native integration coverage for both pinned Host versions. See the [changelog](../CHANGELOG.md) for release history. For interfaces and data formats, see the [architecture](ARCHITECTURE.en.md).

## Chat states and legacy data

| Location | Purpose | Return to the main chat area |
| --- | --- | --- |
| Main chat area | Continue everyday conversations | Already there |
| Archived | Keep chats outside the main chat area | Choose Unarchive |
| Legacy Recycle Bin | Handle records saved by earlier versions; no new moves | Restore to Archived, then Unarchive |

Archiving is not deletion and creates no historical version. Earlier Recycle Bin moves retained the original session files and a protection snapshot. Permanent deletion is irreversible; it is not a Recycle Bin move.

## Install and open

Search for `dsh-archived-chats` in DSH's plugin market, verify the author is **Ultronen**, and choose **Install**. After installation, follow the host's restart instructions. The settings entry is **归档管理** in Chinese; in English it is **Archive Management**.

Alternatively, run this command on the computer running DSH. `web` is an example profile; replace it with the profile that actually runs your DSH instance. Use that same profile for updates and removal:

```sh
dsh plugin --profile web add dsh-archived-chats@latest
```

If installation reports `ERR_PNPM_ADDING_TO_ROOT`, the profile is a pnpm workspace root. Retry with `-w` (using your actual profile):

```sh
dsh plugin --profile web add -w dsh-archived-chats@latest
```

Restart DSH and open **Settings → Archive Management** (Chinese: **设置 → 归档管理**). The main views are **Archived**, **Unarchived**, **Origins & Branches**, and **About**; Recycle Bin appears only for existing records or a catalog error.

If the settings entry is missing, verify that the plugin is installed and enabled in the profile actually running DSH, reload the host, and check the [compatibility requirements](#compatibility-and-limits).

Before updating an older installation, read “Upgrades, old data, and downgrades” below, especially the snapshot-cleanup warning.

## First task: find and back up a chat

1. Open **Archived** and search for a keyword you remember. If the list is empty, archive a completed chat from DSH’s normal session menu first.
2. Click the chat title to preview the conversation, confirm its content, and close the preview.
3. Click **Select**, check the chats to keep, then choose **Export selected** (under **More** in narrow panels). Review the selected count and confirm.
4. Check your browser’s downloads to confirm the ZIP was saved. Keep attachment files separately; the ZIP does not include them.

See [search scope](#archive-and-find-chats) and [export and import](#export-and-import) for limits and restoring a backup.

## Archive and find chats

Use DSH's normal session menu to archive one chat. The Host owns its success notice and Undo action; the plugin adds no second notice and does not replace the official archive method. The plugin groups archived chats by workspace.

The **All workspaces** menu in both lists shows folder icons and includes **Ungrouped** and **Scheduled tasks**. Ungrouped follows official workspace membership, rather than titles or stale directories. Scheduled tasks matches session bindings returned by the official `schedule.catalog()`, including retained active and ended tasks. Deleted tasks stop matching; this is not a permanent historical session type. If the Host has no schedule service or its catalog cannot be read, the option is disabled with an explanation while ordinary chats remain available.

Archived and Unarchived use a two-row toolbar: full-width search above the filters. Origins & Branches puts full-width search above a shared row for related-workspace filtering, chat count and expand/collapse all, wrapping as needed on narrow screens.

Archived and Unarchived default to **Recently updated**, matching the Host sidebar: the later of creation time and the last user prompt. **Least recently updated** reverses that order; title sorting is also available. Assistant output and tag/note edits do not affect recency. When the Host has no corresponding time metadata, sorting falls back to creation time. The date shown on each chat remains its creation time.

In **Unarchived**, title/ID search occupies the first row, with time/title sorting and workspace filtering below it. The **Refresh** text button at the top right reloads the list, beside **Archive all**. Workspace groups and chat rows use the same layout as Archived.

- Click the chat title for a read-only preview, or **Archive** on an individual chat.
- The workspace three-dot menu offers **Archive all** for that workspace.
- The header **Archive all** covers every workspace in the list.

Search and workspace filters only change display; they do not narrow workspace or global archiving. An idle individual chat archives directly after eligibility checks, without confirmation. Global and workspace bulk actions still confirm their scope, without counts. Existing chats in registered workspaces and Ungrouped are listed; verified empty drafts are omitted, while unreadable chats remain visible but cannot be archived yet. Running chats can be archived after an explicit Stop and archive confirmation using the official Host operation. Bulk actions also explain when ongoing work will stop. Blank or unverifiable chats cannot be archived. New chats after preparation are excluded; newly running chats without prior stop consent, or chats moved to another workspace, are skipped. Unarchived offers read-only previews and archiving, without selection, export, deletion, or a cleanup entry. Archiving preserves workspace directories and prior tags and notes. Unarchive uses the official operation, and official workspace and session subscriptions synchronize both lists after changes from the homepage or another tab, including renames. Background refreshes retain existing Unarchived rows; initial loading displays “Loading chats…”. Older hosts without official stop or unarchive support report an error instead of simulating it by rewriting state.

After confirming an archive, full success closes the dialog and uses the Host's native Toast to show the actual archived count with a **View Archived** action. Older Hosts without that component keep the result dialog open. If any chats are skipped or fail, the detailed results stay open without a full-success notice.

Search Archived by title, workspace, tags, notes, messages, and tool results. Filter by type, workspace, and tag; sort by time or title. Content matches show excerpts. Long workspace titles wrap to remain fully visible. Click a workspace folder or title to expand or collapse its chats; the open or closed folder reflects the current state. Group collapse state is saved in the browser.

Content search starts when the trimmed query contains at least two Unicode characters. Workspace, type, and tag filters determine the candidates before requests begin. The client searches 20 candidates per batch; the API accepts at most 100 explicit candidate IDs per request. Results appear progressively, with separate counts for processed candidates/total, body-matched chats, displayed chats, and failed chats. Displayed chats combine metadata and body matches without counting a chat twice; these counts describe chats, not snippets. A completed scan covers the selected candidates within the projection limits; it has no 100-match total cap. Each matching chat shows up to three snippets. Shorter queries still match titles, workspaces, tags, and notes locally. Unarchived does not search conversation content, tool results, tags, or notes.

Stop search keeps the results already found. Retry unfinished retries unreadable and unprocessed candidates without duplicating successful hits. Read failures expose the affected IDs and reasons; a network error stops later batches and preserves earlier results. A removed or newly hidden candidate is reported as skipped, never replaced with a broader search. Changing the query, filters, session list, or page cancels the old scan and discards late responses.

Search and preview use bounded projections, not an unlimited raw-log index: at most 10,000 projected messages, 1,000 segments per message, 256 Ki Unicode code points per segment, and 1 Mi code points per message. Long logs or blocks can therefore contain text outside the searchable projection. No hit does not prove the original log contains no matching text.

Forked chats use the last valid title in their own event stream, including renames after branching. The Host creates a new chat ID with history inherited through the fork point; parent and child develop independently afterwards. Modern Hosts support preview and ZIP v2 export/import that preserves inherited history, even when the parent is absent. ZIPs do not include attachment bytes; see “Compatibility and limits” for older backups and Recycle Bin snapshot fallback.

## Preview, tags, and notes

Clicking a search snippet opens a page around its projected message sequence, highlights and focuses the match, and expands matched tool or reasoning text inside a folded turn. Load earlier messages and Load more keep both directions reachable. If the message is no longer present in the projection, preview explicitly reports the missing anchor and starts at the beginning. Click a chat title in Archived or Unarchived to preview from the beginning. Hovering or focusing the title immediately shows the View conversation hint. Recycle Bin and residual-session details retain preview icons.

Read-only preview does not require unarchiving. It supports Markdown, reasoning, code, JSON, tool calls and results, and readable stored images. Missing attachment-read capabilities degrade images only. Closing preview cancels outstanding requests.

Fully loaded turns with a recorded end group intermediate work into a process disclosure, initially collapsed. Its summary shows Thought or recorded tool/message/subagent counts. Expand it to inspect nested reasoning, context provenance, and tool summaries with arguments and results; these details also start collapsed. The final response remains outside the process disclosure. Partial turns or logs without reliable turn boundaries stay expanded in event order instead of being folded into a complete turn.

System prompts start collapsed and scroll within a height-limited area when expanded. On resume or a new request series, the preview shows the recorded effective prompt without inferring missing instructions. Only real user messages appear on the right; assistant work, reasoning, tools, and injected context stay on the left. The preview has no message input. It uses the Host's Markdown renderer when available, but does not promise every native conversation feature or information absent from the log; it does not invent usage or elapsed-time values.

After updating, reload the DSH backend to activate the new preview projection. Refreshing the browser alone does not replace the running backend.

Use the Edit tags and note icon in the preview header to edit metadata. Each chat supports up to 8 tags of 24 Unicode characters each and a note of up to 2,000 Unicode characters. Tag matching is case-insensitive. Notes occupy one line; truncated notes expose their full text on hover or focus.

Tags and notes remain local. Unarchiving preserves them; completed permanent deletion removes them.

## Actions and their scope

| Page and entry | Actions | Scope |
| --- | --- | --- |
| Archived: chat row | Trash icon (permanent deletion), then Unarchive; click the title to preview, with an Edit tags and note icon directly in the preview header | One chat |
| Archived: workspace More menu | This workspace: Unarchive all, Export all; separator; Delete all | All archived chats in that workspace |
| Unarchived: chat row | Click title to preview, Archive | One chat; archives directly, with stop confirmation for active work |
| Unarchived: workspace three-dot menu | This workspace: Archive all | Every eligible chat in that workspace |
| Unarchived: header | Archive all | Eligible chats across all workspaces |
| Archived: header | Select, three-dot More | Enter selection mode or open the global action menu |
| Archived: selection mode | Select all, Unarchive, Export selected, trash icon (permanent deletion), Cancel | Checked chats only; Select all covers current results |
| Archived: header More menu | Import backup, Export all, Unarchive all; separator; Delete all | Export, unarchive, and delete cover archived chats across all workspaces; Import uses the selected ZIP |
| Recycle Bin: chat row | Preview, Restore, Export snapshot and Delete | One recycle record; Delete is permanent after confirmation |
| Recycle Bin: workspace More menu | Restore all, Delete all | Recycle records in that workspace |
| Recycle Bin: header | Restore all | Restore eligible entries across all workspaces after confirmation |
| Recycle Bin: header | Empty Recycle Bin | Permanently delete recycle records across all workspaces after confirmation |

**Selection mode supports one or many chats.** Select shows checkboxes and an action bar; inline action buttons disappear, while the title still opens preview. Unarchive, Export selected, the trash icon (permanent deletion), and Cancel appear directly in that order. In narrow panels, Export selected moves into the three-dot More menu. With no selection, actions are disabled while Cancel remains available. Select all checks current search/filter results and shows an indeterminate state for partial selection. Hidden selections remain checked with a visible count; clearing current results preserves them. Cancel or leaving Archived clears the selection and exits. Actions confirm the selected count, and failed items stay checked. Ordinary rows show only the trash icon (permanent deletion) and Unarchive; click the title to preview, then use the Edit tags and note icon in its header; Unarchived provides read-only previews and archiving. Search and filters do not narrow workspace or global bulk actions.

Every archive workspace action asks for confirmation with the full workspace name. Unarchive confirmations explain scope and the return to the chat list without counts; global unarchive covers all workspaces and excludes the Recycle Bin. Successful unarchive updates the lists without an additional success notice; failures still show errors. Export and deletion continue to confirm full scope and counts regardless of filtering. Page actions sit to the right of the description with the same text size, wrapping below it when space is limited. Reserved action space keeps tab switching stable.

Delete all in the Archived header and workspace menus requires a confirmation that explains the irreversible effect and scope. It does not delete chats already in the Recycle Bin. Workspace deletion affects archived chats, not the workspace or project files.

Empty Recycle Bin captures the exact recycle-record incarnations displayed for confirmation, including their recycle/snapshot identity. Execution purges only those captured targets: records added later are excluded, and a target changed after confirmation fails instead of causing the scope to be recomputed or expanded. Uncertainty retains the record for a later safe retry; this is not a guarantee that unrelated Host filesystem content can be deleted.

## Restore from the Recycle Bin

New Recycle Bin moves are disabled. This section applies only to records created by earlier releases. Export snapshot preserves the validated session and image bytes in a separate ZIP; it is not accepted by the ordinary conversation importer.

Choose Restore on a row, or Restore all for a workspace or the entire Recycle Bin. Restored chats return to **Archived**, not directly to the main chat area. Choose Unarchive afterward to continue chatting there.

If you use the official Unarchive action on the home page, the plugin releases the recycle marker after verifying that the original chat still exists and matches its recorded identity. The chat appears in Unarchived with its tags and notes preserved. Archiving it again returns it to Archived without putting it back in the Recycle Bin. Recovery snapshots whose originals are missing and permanent deletions already in progress are not discarded or canceled by this synchronization.

Workspace Restore all first confirms the full workspace name, eligible chat count, and destination. Header Restore all confirms the total workspace and eligible chat counts. Both explain skipped pending deletions; canceling performs no restoration. Results report actual restored counts and offer View Archived; workspace results also name the workspace. Partial results include unsuccessful counts and reasons.

Restore prefers an existing, identity-matching original without rewriting its content. Only when the original is missing does it attempt to recreate an ordinary session ID from a validated protection snapshot, and only through an explicitly exclusive Host writer. Plain create/append and seeded snapshots whose inherited boundary cannot be preserved are refused before writing; the recovery record remains. Conflicting sessions are never overwritten. A missing workspace produces a warning and an ungrouped archived chat.

Degraded means protection data is unavailable or incomplete, not necessarily that recovery is impossible: an intact original may still be restored. Workspace Restore all attempts non-pending entries and reports failures. Entries already undergoing permanent deletion cannot be restored.

Recycle Bin preview currently still reads the original session. If the original is missing, preview may fail even when a protection snapshot can be used for recovery. A preview failure alone does not prove the snapshot is unrestorable.

## Permanent deletion and retries

The trash icon shows “Delete archived chat” on hover or keyboard focus and performs permanent deletion without using the Recycle Bin. Row, workspace, and archive-wide deletion actions require confirmation. The selection toolbar shows a trash icon for permanent deletion directly, while archived-chat previews provide editing only, with no Delete or More menu; workspace and global menus use Delete all. The concise confirmation names the chat or workspace, or the complete global scope, and states that deletion is irreversible. Clicking the action only opens confirmation. The Recycle Bin also offers row/workspace permanent deletion and Empty Recycle Bin. Permanent deletion removes the target chat, plugin tags and notes, and related snapshots.

Once deletion starts, the plugin saves a non-restorable deletion task, removes associated snapshots, deletes the original, and completes index cleanup. Partial failures retain the task and error message for explicit user retries from the legacy Recycle Bin. Reading the bin also records legacy pending markers that lack recycle records, without executing deletion. Pending items are no longer actionable archive rows and cannot be restored or unarchived. Even if the original file temporarily remains, deletion cannot be undone.

Missing required Host capabilities cause refusal before a deletion task is committed. Removing snapshot attachment copies does not guarantee immediate reclamation of matching bytes in Harness's global attachment store; other references and Host caching or garbage collection may retain them.

Permanent deletion also cleans up the chat's subagent descendants while preserving independent forks. Unarchived lists ordinary workspace chats.

## Manual residual chat check

Open **About → Maintenance → Check residual chats**. Opening Archive Management or About never scans automatically; clicking the button starts the check. Loading is explicit, failures offer Retry, and only a successful empty scan reports no residual chats. Closing the dialog or leaving the page cancels the in-flight scan.

Candidates are subagent chats with an explicit parent reference whose parent no longer exists, excluding chats still owned by a workspace or the archive. Ordinary ungrouped chats, blank chats, independent forks, and chats with missing or invalid parent metadata are excluded. This is not a whole-disk cleanup and does not remove global attachments or caches.

1. Review candidate titles, IDs, parent references and directories; preview the conversation.
2. Select content to keep and choose Export backup. Verify the saved download.
3. Select only unwanted records, choose Delete, and confirm the irreversible result. Execution rechecks eligibility and deletes only the selected records, without widening the scope to other chats.
4. Review results. Failures or changed eligibility remain visible and reload the list; Check again is also available.

Checking and previewing do not delete data. Canceling deletion does not clean anything. This entry is independent of retired Storage & Retention.

## Export and import

Choose Export all from the header's More menu to export every archived chat, or Export all from a workspace menu to export only that workspace's archive. Both ask you to confirm the full scope and chat count and exclude Recycle Bin contents. For a standard conversation ZIP, restore to Archived first. Existing recycle rows also offer Export snapshot: a separate preservation ZIP with image bytes, not a conversation-import package. Import backup is also in the header's More menu.

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

Export compresses the staged entries in 256 KiB slices and yields to the event loop between them, so a large backup does not freeze the rest of the Host while it is written. When a download is cancelled, the archive stops and the response fails; a cancelled export is never reported as a completed one.

ZIP import and Recycle Bin recovery are separate workflows. A ZIP is not a Recycle Bin protection snapshot.

## Origins and Branches

The scope explanation is behind the help icon beside the chat count. Hover, keyboard focus, or a touch tap reveals it.

This read-only view starts from officially archived chats and includes their ancestors and descendants, including related unarchived chats, subagents, and ungrouped chats. Unrelated unarchived chats and empty workspaces are excluded. Archive and legacy recycle states remain visible. Recycle snapshots without an official session record do not create separate graph entries.

Chats are grouped by their actual workspace, with counts and browser-persisted workspace folding. Cards follow the built-in plugin settings layout. A single trailing disclosure opens both metadata and child branches; there is no second Details disclosure. Ungrouped chats have their own group.

Unarchived chats count in their own workspace. Duplicate cross-workspace ancestors, ancestors retained only by filters, and unavailable sources remain read-only context and are not counted again. Current state (Unarchived, Archived, Recycle Bin, or Source unavailable) is separate from relationship type (Original chat, Fork, or Subagent). Incomplete metadata is shown as Unknown origin, never assumed to mean original or deleted.

Deep forks use at most two ancestor-guide columns plus the current connector, with deeper levels labeled explicitly. A managed chat is counted only in its own workspace; contextual copies elsewhere are labeled read-only sources.

Full-width search occupies the first row. Related-workspace filtering, chat count, scope help and expand/collapse all share the second row, wrapping as needed on narrow screens. There is no state filter. Searching chat or source names preserves required ancestors and temporarily opens matching paths. Clearing search restores previous folds. Expand/collapse all controls the current workspaces, metadata and branches. Expanded metadata contains the complete title, timestamp, source ID and Copy ID.

Relationships use the Host's `parentSession`, `isSeeded` and subagent metadata. Exact v4 inherited-event counts are not header metadata and are not guessed here; older seed lengths are kept only for compatibility. This view never mutates relationships or duplicates archive/recycle management actions. If recycle metadata is unavailable, official chats and archive states remain visible with a warning. The graph has a 5,000-node limit and reports an error rather than silently truncating larger inventories.

## About and updates

About groups product information and links, Version and updates, and Maintenance. The maintenance entry opens a manual residual-chat check; it does not reactivate storage policies or scheduled cleanup.

From 1.4.1, a red dot appears on the About tab only when a newer version is confirmed. Unchecked, failed, and up-to-date checks show no dot. Visiting About does not dismiss an available update.

Archiving within the plugin uses the Host's native Toast with a six-second hold followed by the native fade. The Host controls archive feedback on the main chat page. Other success notices, including View Archived after Recycle Bin restoration, dismiss after four seconds and pause while hovered or keyboard-focused. Switching tabs clears the current notice. Errors do not auto-dismiss and can be closed manually.

About shows the running plugin version, author, license, and direct links to the project, language-appropriate guide, changelog, issue feedback, and plugin market. The title also displays the running version.

Current version is read dynamically from the running backend, never substituted with the registry's latest version. A failed online check keeps the loaded version, identity, and links. Local metadata failure shows Unavailable and Reload information rather than an update-check error. If newly installed endpoints have not loaded yet, reload the DSH backend and retry.

Opening Archive Management loads local metadata, then automatically checks public npm metadata. While the page stays open, cache-aware checks run every 15 minutes and on visibility/network recovery. Success is cached for 12 hours and failure for 15 minutes; manual checks have a 30-second cooldown and concurrent requests coalesce. No chats or backups are sent. Failure never blocks chat management or claims the plugin is current. Leaving the page removes timers and listeners.

When diagnosing an unchanged version after an update, also verify that you updated the profile actually running DSH.

Check for updates and View update beside the heading open a dialog with the running version, public release, last check and current host. Copy the package spec into Add plugin in another host. A terminal command is offered only when the current launcher and profile can be verified; official Desktop uses its own bundled command, never an unrelated dsh on PATH. This detects the current host only, not other Desktop installations.

Local link:/file: installations are labeled Local checkout, offer Copy local path and are protected on the backend against registry replacement. Registry installations show Install update only when the host manager permits replacement; the official HMR restriction is retained, with manual guidance instead. Installation submits only the exact reviewed version through the official manager, preserving compatibility, locking and build-script checks. Failures never report completion and duplicate submissions are blocked. Success shows Restart needed; the running version changes only after the backend restarts. DSH is never restarted automatically.

## Upgrades, old data, and downgrades

**Recycle Bin transition:** New recycle operations are retired; deletion requires explicit permanent-delete confirmation. Existing records are never automatically migrated or emptied. Recovery, protection-snapshot export and confirmed deletion remain available while records exist; the tab hides when empty. Storage & Policy navigation, automatic expiry and startup snapshot sweeping are disabled. Saved policies are preserved but not executed. Unsupported recovery keeps the record and reports failure. Protection-snapshot exports include images, are limited to 64 MiB per record, and are not standard conversation-import ZIPs.

## Compatibility and limits

- **Settings closes unexpectedly (known Host issue):** On DSH `0.2.1-rc.2`, archiving the current chat while initial setup is incomplete can trigger onboarding and close Settings. Reported upstream in [#10596](https://github.com/deepseek-ai/deepseek-harness/discussions/10596). This does not by itself mean archiving failed; reopen Settings to check. Plugin 1.6.0 does not include a Host fix.

Features depend on public Host capabilities, not just a version number:

- Workspace bulk archiving requires public archive capability.
- Session-directory accounting and permanent deletion require session-scoped physical locations. The plugin does not guess paths or delete shared directories.
- Restoring an existing recycled original needs no log rewrite; snapshot fallback and ZIP import require the corresponding public writer capabilities.
- Modern-Host ZIP v2 supports exporting and importing inherited-history forks, including when the parent is absent. Old v1 backups without the boundary cannot safely rebuild a seeded session and are refused. Recycle Bin recovery remains separate: an intact original is restored without rewriting, but its legacy snapshot-fallback writer still refuses a missing fork original and retains the protection record.
- ZIP restore supports verified modern create handles and dedicated/exclusive writer contracts. Plain legacy create/append without an explicit exclusive-create guarantee is unsupported because absence from an inventory does not prove safe ownership.
- Unarchive requires an authoritative, readable persisted header with a working directory. A cwd-less chat remains safely available in Archived for preview/export; this differs from a missing workspace, which can degrade to an ungrouped archived chat. Optional cold-title publication can warn after a durable restore without rolling back or corrupting restored data.
- Version 2 protection records require this or a newer plugin. Before downgrading, restore recycled chats you need to retain and back up plugin data.
- If `trash.json` cannot be read, Archived is marked unverified, the Recycle Bin is unavailable, and archive mutations such as unarchive, tag/note editing, and deletion are refused instead of guessing.

The declared DSH `>=0.1.0-rc.7` range remains capability-based. Release automation tests Node.js 18 on Ubuntu and Node.js 24 on Ubuntu, macOS, and Windows; the Node.js 24 matrix requires both pinned official Host backends, `@deepseek-ai/dsh-session@0.1.7-rc.2` and `0.2.1-rc.2` (eight integration cases each) and package checks, including the v4 session format.

## Local data and uninstall

Plugin state lives under:

```text
$DSH_HOME/plugin-data/archived-chats/
```

| File | Purpose |
| --- | --- |
| `metadata.json` | Tags and notes |
| `trash.json` | Recycle records and pending permanent-deletion tasks |
| `retention.json` | Preserved legacy cleanup policy, not executed |
| `snapshots/` | Protection data and legacy snapshots awaiting cleanup |
| `pending-deletions.json` (legacy) | Migration input for old deletion markers |
| `legacy-recycle.json` (legacy) | Old snapshot migration state, no longer used |

The plugin does not upload, cloud-sync, or schedule historical captures. To uninstall:

```sh
dsh plugin --profile web remove dsh-archived-chats
```

Uninstalling preserves plugin data and does not permanently purge chats. This transition version performs no startup cleanup; check the behavior before reinstalling an older release. Do not treat manually deleting plugin data as Empty Recycle Bin: it loses recovery information without necessarily removing Host sessions. Prefer the UI and back up anything you still need first.
