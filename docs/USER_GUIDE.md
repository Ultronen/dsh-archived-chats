# Session Archive user guide

English · [简体中文](USER_GUIDE.zh-CN.md) · [Back to README](../README.md)

This guide covers the complete user workflow, data boundaries, and recovery behavior of Session Archive. For Host routes, transactions, and maintainer internals, see [ARCHITECTURE.en.md](ARCHITECTURE.en.md).

## Archive and find a chat

1. Archive a conversation from the normal DSH session menu.
2. After Host success, the global notice offers **View** and **Undo** and dismisses after three seconds. Archiving does not capture a snapshot.
3. Open **Settings → Session Archive**. The **Archived** view groups every visible archived chat by workspace.
4. Search titles, workspaces, tags, notes, user messages, assistant answers, and tool results from one field. Matching conversation content includes a readable excerpt.

Groups remember their collapsed state in the browser. Filter by regular or subagent session, project, and tag, then sort by newest, oldest, or title.

## Archive a workspace

Open **Settings → Session Archive**, choose **Archive workspace chats**, then select a workspace in the workspace chooser. The plugin prepares that workspace and opens one confirmation naming the workspace, eligible-chat count, and the **Archived** destination. When applicable, it also shows how many chats currently in use will be skipped without listing chat identities. There is no session preview list or second confirmation.

Choose **Archive all** to proceed, or **Cancel** to leave everything unchanged. Eligible means a chat is currently unarchived, has no non-idle Host agent, and its inspected live or persisted event log contains `turn/start`. A blank new-session window is therefore not an archivable chat. On an older Host without agent status, loaded chats are conservatively skipped; if the plugin cannot confirm a session's event content, it also skips that session instead of guessing. Preparation is limited to 2,000 eligible chats and creates a five-minute, single-use token and nonce for that exact ordered set, so the apply request cannot add IDs and chats created afterward are excluded.

At apply time, each prepared chat is rechecked for workspace membership, archive state, active-agent status, and a real `turn/start`. A complete success refreshes affected views and closes the confirmation. If any chat is skipped or fails, the Host continues processing and keeps the itemized result visible. An uncertain failure requires a fresh preparation and another explicit confirmation before any retry. The operation never moves chats between workspaces, changes the selected workspace, or changes its directory. A Host without public `archiveSession` rejects preparation with `workspace-archive-unsupported` and changes nothing.

## Read-only conversation preview

Preview does not require unarchiving. It follows the Harness conversation layout and supports:

- Markdown, reasoning, code, JSON, tool calls, and tool results.
- Available stored images loaded through a guarded local route.
- Responsive turn navigation and visible read-only state.
- Safe degradation: if attachment reads are unavailable, text and tool content remain readable.

Closing the preview cancels outstanding image and page requests. Preview never edits the source session.

## Tags, notes, and multi-select

- Each chat supports up to 8 tags, each limited to 24 Unicode characters, plus one note of up to 2,000 Unicode characters.
- Tag matching is case-insensitive; rows show up to three tag chips and collapse the remainder into `+N`.
- Tags and notes stay in local `metadata.json`. Unarchiving keeps them; completed physical deletion removes them.
- Each project has one select-all checkbox to the left of its chat count. Checking it selects that project's currently visible chats. A dash means partial selection; click it to select the remainder, then uncheck to clear that project. Other projects keep their selections. Empty lists hide selection controls.
- Selecting chats reveals row checkboxes and a toolbar showing the selected count, with export, unarchive, Recycle Bin, and permanent-delete actions. Clearing the last selection automatically hides the toolbar and row checkboxes; no Done or Clear button is needed.
- Search and filter changes clear selection; sorting and export preserve it. Batch actions affect selected chats only: successful items leave the list, while failures remain selected for retry. Permanent-delete confirmation shows the exact count.
- The row delete icon sits immediately before Unarchive and opens permanent-delete confirmation for that chat. The row menu contains tag and note editing and single-chat export. Project menus offer Unarchive all, Move all to Recycle Bin, and Delete all permanently, including chats in that project hidden by filters.
- The header’s **Export all** always exports the entire archive, regardless of search, filters, or selection. The batch toolbar’s **Export selected** exports selected chats only.

## Legacy data

The main views are **Archived**, **Recycle Bin**, **Storage & Retention**, and **Origins & Branches**. The separate History feature has been retired. Ordinary and workspace archiving no longer create versions.

Upgrades preserve existing snapshots. Open **Storage & Retention → Legacy data** to browse them by source, preview them read-only, recover a new archived copy, or delete them after confirmation. Recovery never overwrites the source chat. Snapshots still referenced by the Recycle Bin cannot be deleted here; unreadable snapshots can only be cleared, not recovered.

Export a backup for deliberate long-term preservation. Use Recycle Bin restore to recover deleted chats.

## Export, import, and restore

Export one chat, the current selection, or the full archive. Each ZIP contains:

```text
manifest.json
sessions/001-<safe-title>-<id>/session.json
sessions/001-<safe-title>-<id>/transcript.md
```

`session.json` is the authoritative machine-readable record. `transcript.md` is a readable companion. ZIP paths are sanitized and batches are generated one session at a time.

Attachment references remain in JSON, but attachment bytes and descendant sessions are not included. Use Harness's official Session log export when you need an attachment-complete conversation tree.

Import accepts this plugin's version-one ZIP format and always previews before writing:

- Existing session IDs are marked as conflicts, disabled, and skipped.
- Unresolved workspaces are restored as ungrouped archived chats with a warning.
- Tags and notes restore through the same local limits.
- Raw events and Markdown are never rendered in the import preview.
- Confirmation tokens expire after 10 minutes and can be used once.
- Restore writes through a dedicated Host restore entry point when one exists, otherwise through the ordinary `create` / `append` / `locate` session-writer capability — the same path legacy-data recovery already uses. Only a Host exposing neither returns `restore-unsupported`, and it writes nothing.

ZIP import and legacy-data recovery are separate workflows.

## Recycle Bin and permanent deletion

**Move to Recycle Bin** creates or reuses a healthy protection snapshot before committing the recycle record. The success notice offers immediate **Undo**.

Restore has two levels:

1. If the original session remains intact, restore removes only the recycle marker.
2. If the original is missing, the plugin uses a validated snapshot through the public `create` / `append` capability and never overwrites an existing ID.

The Recycle Bin provides **Delete permanently** and **Empty Recycle Bin**. Archived chats can also be permanently deleted after confirmation from a row, project menu, or batch actions. Permanent purge records crash-recovery intent first, then removes that source's validated snapshots, and deletes the original session last. Ordering matters: anything that fails before the original is deleted leaves the chat intact and completable on the next attempt, instead of a recycle entry whose chat is already gone. A snapshot elsewhere in the store that cannot be verified never blocks a purge — it is skipped, reported, and remains reclaimable from Legacy data. Interrupted purges retry on startup.

On a current Host that exposes handle-based reads without physical session locations, browsing, export, and protection snapshots for ordinary sessions remain available. Session-directory accounting is shown as unavailable, while restore writes and permanent deletion report that the Host capability is unsupported. Purge refusal occurs before changing the recycle record, protection snapshots, pending markers, or a live session. Forked sessions with inherited history are not captured into snapshots yet because the current snapshot schema cannot retain the inherited cut. Archiving does not require a snapshot; moving such a session to the Recycle Bin remains unavailable.

If `trash.json` itself cannot be read, the Recycle Bin reports unavailable and every archive change — unarchive, tag and note edits, delete, and purge — is refused rather than guessed. The archived list stays browsable but is labelled as unverified, because a catalog it cannot read cannot prove which chats were already deleted.

Removing snapshot attachment copies does not guarantee immediate cleanup of identical bytes in Harness's global attachment store; another session or Host garbage-collection policy may retain them.

## Storage and retention

Storage accounting separates:

- Archived and recycled session directories.
- Plugin-owned legacy data and protection snapshots.
- Unavailable or degraded measurements.
- Repeated snapshot attachment bytes.

Searchable detail dialogs keep large inventories out of the main policy view. Reported bytes are not described as globally reclaimable Harness attachment storage.

Retention uses Recycle Bin age only. Old version-count, snapshot-age, and quota settings no longer plan deletion of snapshots. Saving a policy never executes cleanup. Every cleanup requires a single-use five-minute preview, explicit selection, confirmation, and execution-time revalidation. Permanent recycle purges start unselected. Manage existing snapshots explicitly through Legacy data.

## Origins and Branches

The read-only relationship view uses durable Harness `parentSession` fields to show sources, forks, and subagent trees for archived or recycled chats. It keeps only the active parent/child context needed to explain managed sessions; unrelated active chats are not sent to the browser.

Search reveals matching paths inside collapsed branches. Project and status filters retain necessary ancestor context. Diagnostics report missing parents, cycles, and delegation-depth mismatches without changing relationships.

A session header this version does not recognize — a newer Harness origin value, an absent timestamp — degrades that one node's detail and leaves the rest of the graph intact. The node limit applies to the graph actually shown, not to how many sessions Harness stores, so a large session history does not by itself disable this view.

## Local data and privacy

All plugin-owned state stays under:

```text
$DSH_HOME/plugin-data/archived-chats/
```

The directory may contain:

- `metadata.json` for tags and notes.
- `trash.json` for Recycle Bin records.
- `retention.json` for saved policy.
- `snapshots/` for legacy data and protection snapshots.
- A legacy `pending-deletions.json` until migration completes.

The plugin does not upload, cloud-sync, or schedule background capture of conversations or attachments. Uninstalling removes only the package and deliberately keeps this directory so a later reinstall can recover the same state.

## FAQ

<details>
<summary><b>Does archiving delete the conversation?</b></summary>

No. DSH hides it from the sidebar and keeps its archived session record. Session Archive provides the management entry.

</details>

<details>
<summary><b>What is Legacy data?</b></summary>

It contains retained local copies of session records and available attachments. Snapshot preview is read-only.

</details>

<details>
<summary><b>Can restore overwrite the source?</b></summary>

No. Legacy-data recovery creates a new archived ID, while Recycle Bin fallback refuses an existing ID. Neither path overwrites the source.

</details>

<details>
<summary><b>What happens when an imported ZIP contains an existing ID?</b></summary>

The row is marked as a conflict, disabled, and skipped. Import never overwrites an existing session.

</details>

<details>
<summary><b>Why can snapshots remain when the archive list is empty?</b></summary>

Restoring a recycled chat removes its recycle record but retains the validated snapshot. Manage retained snapshots explicitly under Storage & Retention → Legacy data when no longer needed.

</details>

<details>
<summary><b>What should I do before downgrading or deleting plugin data?</b></summary>

Restore anything you still need and back up the complete plugin-data directory. Older releases may not display legacy data or understand newer recycle snapshots.

</details>
