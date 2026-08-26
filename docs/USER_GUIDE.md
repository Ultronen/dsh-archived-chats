# Session Archive user guide

English · [简体中文](USER_GUIDE.zh-CN.md) · [Back to README](../README.md)

This guide covers the complete user workflow, data boundaries, and recovery behavior of Session Archive. For Host routes, transactions, and maintainer internals, see [ARCHITECTURE.en.md](ARCHITECTURE.en.md).

## Archive and find a chat

1. Archive a conversation from the normal DSH session menu.
2. After Host success, the global notice reports that it is saving a History version. Its three-second dismissal starts only after capture finishes.
3. Capture failure never rolls back a successful archive. The notice retains **Retry save**, **View**, **Undo**, and close actions.
4. Open **Settings → Session Archive**. The **Archived** view groups every visible archived chat by workspace.
5. Search titles, workspaces, tags, notes, user messages, assistant answers, and tool results from one field. Matching conversation content includes a readable excerpt.

Groups remember their collapsed state in the browser. Filter by regular or subagent session, project, and tag, then sort by newest, oldest, or title.

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
- **Select multiple** reveals checkboxes only when needed. Select individual chats, a filtered result set, or a whole workspace for export, unarchive, or Recycle Bin actions.

## History versions

The **History** view loads on first activation and groups validated local versions by source chat.

- A successful browser-originated archive captures one validated version and deduplicates the same non-empty source revision.
- The plugin does not scan unrelated active chats and performs no scheduled or startup capture.
- Each healthy version shows timestamp, size, attachment count, and Recycle Bin protection state.
- Preview is read-only and identifies the exact snapshot time.
- **Restore as copy** asks the Host for a new session ID and creates a new archived chat. It never overwrites, unarchives, or deletes the source.
- Ordinary versions can be deleted individually or cleared globally after confirmation. Versions protecting Recycle Bin recovery and unreadable degraded versions are skipped.

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
- A Host without the public persistence writer returns `restore-unsupported` without writing anything.

ZIP import and History **Restore as copy** are separate workflows.

## Recycle Bin and permanent deletion

**Move to Recycle Bin** creates or reuses a healthy protection snapshot before committing the recycle record. The success notice offers immediate **Undo**.

Restore has two levels:

1. If the original session remains intact, restore removes only the recycle marker.
2. If the original is missing, the plugin uses a validated snapshot through the public writer and never overwrites an existing ID.

Only the Recycle Bin exposes **Delete permanently** and **Empty Recycle Bin**. Permanent purge records crash-recovery intent before deleting the original and every validated snapshot for that source. Interrupted purges retry on startup.

Removing snapshot attachment copies does not guarantee immediate cleanup of identical bytes in Harness's global attachment store; another session or Host garbage-collection policy may retain them.

## Storage and retention

Storage accounting separates:

- Archived and recycled session directories.
- Plugin-owned History and protection snapshots.
- Unavailable or degraded measurements.
- Repeated snapshot attachment bytes.

Searchable detail dialogs keep large inventories out of the main policy view. Reported bytes are not described as globally reclaimable Harness attachment storage.

Retention can plan by History count per source, snapshot age, snapshot quota, and Recycle Bin age. The default keeps one recovery snapshot per source. Saving a policy never executes it. Every cleanup requires a single-use five-minute preview, explicit selection, confirmation, and execution-time revalidation. Active Recycle Bin protection and unavailable snapshots are excluded; permanent recycle purges start unselected.

## Origins and Branches

The read-only relationship view uses durable Harness `parentSession` fields to show sources, forks, and subagent trees for archived or recycled chats. It keeps only the active parent/child context needed to explain managed sessions; unrelated active chats are not sent to the browser.

Search reveals matching paths inside collapsed branches. Project and status filters retain necessary ancestor context. Diagnostics report missing parents, cycles, and delegation-depth mismatches without changing relationships.

## Local data and privacy

All plugin-owned state stays under:

```text
$DSH_HOME/plugin-data/archived-chats/
```

The directory may contain:

- `metadata.json` for tags and notes.
- `trash.json` for Recycle Bin records.
- `retention.json` for saved policy.
- `snapshots/` for History and protection snapshots.
- A legacy `pending-deletions.json` until migration completes.

The plugin does not upload, cloud-sync, or schedule background capture of conversations or attachments. Uninstalling removes only the package and deliberately keeps this directory so a later reinstall can recover the same state.

## FAQ

<details>
<summary><b>Does archiving delete the conversation?</b></summary>

No. DSH hides it from the sidebar and keeps its archived session record. Session Archive provides the management entry.

</details>

<details>
<summary><b>Are History versions screenshots?</b></summary>

No. They are validated local copies of session records and available attachments. Snapshot preview is read-only.

</details>

<details>
<summary><b>Can restore overwrite the source?</b></summary>

No. History restore creates a new archived ID, while Recycle Bin fallback refuses an existing ID. Neither path overwrites the source.

</details>

<details>
<summary><b>What happens when an imported ZIP contains an existing ID?</b></summary>

The row is marked as a conflict, disabled, and skipped. Import never overwrites an existing session.

</details>

<details>
<summary><b>Why can snapshots remain when the archive list is empty?</b></summary>

Restoring a recycled chat removes its recycle record but retains the validated snapshot as History. Delete ordinary History explicitly or apply a previewed retention policy when it is no longer needed.

</details>

<details>
<summary><b>What should I do before downgrading or deleting plugin data?</b></summary>

Restore anything you still need and back up the complete plugin-data directory. Older releases may not display History or understand newer recycle snapshots.

</details>
