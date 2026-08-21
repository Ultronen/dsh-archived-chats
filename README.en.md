# dsh-archived-chats

[English](README.en.md) | [中文](README.md)

> ⚡ **Deletion takes effect immediately — no restart.** Even sessions still resident in the background are torn down safely along the official lifecycle and wiped from disk the moment you click delete, instead of being "parked until the next restart".

A settings page for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that brings archived chats back into view.

Once a conversation is archived in DeepSeek Harness it disappears from the sidebar, and there is no built-in way to browse it again — only the workspace store (`~/.dsh/storages/workspace.json`) still remembers it. This plugin adds an **Archived Chats** page under Settings where every archived session is visible, searchable, and manageable.

## 🚀 Install

```sh
dsh plugin --profile web add dsh-archived-chats@latest
```

Restart DSH once after installing, then open **Settings → Archived Chats**.

To update an existing installation:

```sh
dsh plugin --profile web update dsh-archived-chats
```

## Compatibility

Version 0.9.0 uses DeepSeek Harness `0.1.0-rc.7` as its automated compatibility baseline. The plugin registers a top-level `settings.section`, so the rc.7 keyed-slot change for `settings.plugin.item` does not apply to it. A local real-host UI pass was also completed on Harness `0.1.0-rc.8` for the archive list, search, metadata editor, bulk and group actions, backup import preview, and the Codex / Claude Code interoperability controls and conversion report. Future Harness releases should still be checked with the smoke suite and a real-host UI pass before publishing a plugin update, because client slot and design-token contracts may evolve.

## Preview

The overview and external-import preview were captured from 0.9.0 in a local DeepSeek Harness `0.1.0-rc.8` web profile. The remaining screenshots retain unchanged 0.8.x workflows.

![Archived Chats overview](assets/screenshots/1-archived-chats.png)
![Search and filters](assets/screenshots/2-search.png)
![Delete confirmation](assets/screenshots/3-delete-confirm.png)
![Group actions](assets/screenshots/4-group-menu.png)
![Metadata editor](assets/screenshots/5-metadata-editor.png)
![Bulk actions](assets/screenshots/6-bulk-actions.png)
![Import preview](assets/screenshots/7-import-preview.png)
![Codex external-import conversion report](assets/screenshots/8-interop-import-preview.png)
![External-export loss and warning report](assets/screenshots/9-interop-export-preview.png)

## Usage

1. Archive a conversation from the normal DSH session menu. Archiving removes it from the sidebar but keeps its session data in the workspace store.
2. Open **Settings → Archived Chats**. The page groups archived conversations by workspace and remembers collapsed groups in this browser.
3. Search, filter, sort, or select conversations. Open a row's metadata editor to add tags and notes, or use the group menu for workspace-level actions.
4. To migrate from Codex or Claude Code, choose the external source, click **Import from external tool**, and select a JSONL file. Review the conversion report, information losses, warnings, and ID conflicts before confirming only the non-conflicting sessions you want.
5. To hand archived chats to Codex or Claude Code, select one or more sessions (or use all sessions when nothing is selected), click **Export to external tool**, then review the target, session count, loss categories/counts, warnings, and native-resume limitation before downloading JSONL.
6. Use **Export backup** for one conversation, the current selection, or all archived chats. To restore a backup, choose **Import backup**, review the preview, keep the non-conflicting sessions selected, and confirm.
7. Choose **Unarchive** to return a conversation to the sidebar. Choose **Delete** only when you want permanent removal; the confirmation dialog identifies the affected scope.

## Features

- **Complete archived-session list**, grouped by workspace (project) with a per-group count. Every group can be collapsed or expanded, and the state is remembered per browser.
- **Search and sort** by title, workspace title, tags, and note text; filter by type (all / regular / subagent), project, and tag; then order results by newest, oldest, or title.
- **Tags and notes**: open an editor from any row to attach up to 8 tags (24 Unicode characters each) and a note (2,000 Unicode characters). Tag chips render per row, overflowing past three into a `+N` indicator, and the tag filter narrows the list case-insensitively.
- **Storage insights**: a summary strip reports the archived count, total measured size, and how many sessions could not be measured; each row shows its own size. Measurement never follows symbolic links and skips sessions whose directories are unreadable.
- **JSON + Markdown backups**: export one row, the current selection, or every archived chat as a ZIP. Each package has a versioned manifest, a lossless machine-readable session record, and a human-readable transcript for every included session.
- **Preview-first import and restore**: choose a ZIP backup, inspect every session before writing, preselect only non-conflicting IDs, and restore selected sessions as archived chats. Existing IDs are skipped and never overwritten.
- **Codex / Claude Code interoperability**: inspect external JSONL read-only and show session, information-loss, conflict, warning, and fidelity counts before any write. Export also produces a message-body-free loss/warning report before selected DSH archives can be downloaded as readable target-specific JSONL handoffs.
- **Flexible multi-select**: select individual chats, every visible result, or an entire project. The selection bar can export, unarchive, or permanently delete the chosen chats in one action, while selections hidden by another filter remain intact.
- **Unarchive** a single chat or a whole project group from the group's `⋯` menu — restored chats reappear in the sidebar immediately.
- **Delete** one chat, a project group, or everything (**Delete All**), each behind a confirmation dialog. Deletion is thorough: the session log is removed from disk, the session is detached from its workspace record, and the registry's in-memory header index is purged, so the sidebar drops the rows live.
- Sessions still resident in the background are **deleted in place too**: the plugin disposes the session through the official lifecycle teardown order (cancel → quiesce → flush → fiber teardown → registry detach), the persistence layer releases the write path, and the physical delete completes within the same request — no restart. If the running DSH build does not expose the required internal seams, the plugin falls back to "park permanently + delete on the next start", with parked sessions staying hidden meanwhile.
- Works in light and dark schemes; localized in English and 中文.

## Tags, notes, and statistics

Tags and notes live **only on your machine** in `$DSH_HOME/plugin-data/archived-chats/metadata.json` — they are never uploaded, synced, or sent anywhere else. Unarchiving a session keeps its metadata; a completed physical deletion removes it, while a deferred or failed deletion keeps it intact. Metadata and statistics failures are always non-blocking: the list, unarchive, and deletion keep working even when the metadata store is unreadable or a session directory cannot be measured.

## Export and backup

Every export is a local browser download. A single session and a batch use the same ZIP format:

```text
manifest.json
sessions/001-<safe-title>-<id>/session.json
sessions/001-<safe-title>-<id>/transcript.md
```

`session.json` is the authoritative backup record: it contains the complete metadata and event values returned by Harness persistence plus the archive title, workspace, timestamps, origin, tags, note, and storage facts. `transcript.md` is a readable companion derived with Harness's canonical message projection. ZIP paths are sanitized and collision-safe, and batches are generated one session at a time instead of buffering every transcript together.

Attachment references remain in JSON, but **attachment bytes and descendant sessions are not included**. Use Harness's official Session log export when you need its attachment-complete conversation-tree package.

## Import and restore

Import accepts only this plugin's version-one export ZIPs. The browser first uploads the package for bounded validation and shows a preview containing titles, workspaces, tags, notes, storage facts, ID conflicts, unresolved-workspace warnings, and attachment-reference warnings; raw events and Markdown are never rendered in the preview. Existing session IDs are disabled and skipped, and unresolved workspaces are restored ungrouped. A confirmation token expires after 10 minutes and can be used once. Tags and notes are restored through the same local metadata limits as manual edits. No attachment bytes are restored. Hosts without the supported Harness writer capability return `restore-unsupported` without writing anything.

## Codex and Claude Code interoperability

Version 0.9.0 can convert local Codex or Claude Code JSONL into archived DSH sessions and export DSH archives to the selected target's JSONL. External import accepts one JSONL file. The upload request is capped at 8 MiB, with additional limits on line count, individual line size, and structural complexity. Inspection reads the source without rewriting, moving, or deleting it, and raw messages and local paths are not written to plugin logs.

Every import is preview-first. “High-fidelity conversion” means no known information loss was found; “Readable migration” means the conversation remains readable but some event, field, or content-block detail could not be mapped completely. Malformed JSON, unknown events, attachment references, and duplicate/existing sessions are surfaced as losses, warnings, or conflicts. Conflicts start deselected and are never overwritten. Confirmation reuses the 10-minute, single-use token and transactional rollback path.

Attachments keep only safe relative references; **binary files are not copied or restored**. External export first returns sanitized session, loss-category/count, and warning data; the report contains no message bodies and is recomputed when the target changes. Downloaded JSONL is a conversation projection for reading, migration, or handoff and does not promise native Codex or Claude Code `resume`. Export does not mutate DSH sessions or access the target tool's source directories, credentials, MCP keys, or local configuration.

## FAQ

<details>
<summary><b>Does archiving delete the conversation?</b></summary>

No. DSH hides the conversation from the sidebar and keeps its archived session record. This plugin gives you a settings page for finding, exporting, restoring, unarchiving, or deleting that record.

</details>

<details>
<summary><b>What happens when an imported backup contains an existing session ID?</b></summary>

The conflicting row is shown in the preview, disabled by default, and skipped. Import never overwrites an existing session.

</details>

<details>
<summary><b>Are attachments included in ZIP backups?</b></summary>

Attachment references are preserved in `session.json`, but attachment bytes and descendant sessions are not included. Use Harness's official Session log export for a complete attachment-bearing conversation tree.

</details>

<details>
<summary><b>Can Codex or Claude Code resume the exported JSONL as the original session?</b></summary>

Not guaranteed. It is a readable migration and handoff format that preserves mappable messages and tool traces, not a native target-tool session archive. The download dialog states that native resume is unsupported.

</details>

<details>
<summary><b>Does deleting a live session require a restart?</b></summary>

On hosts that expose the required lifecycle hooks, deletion tears down the live session and removes its files in the same request. Older or incompatible hosts use the safe fallback queue and finish the physical delete on the next start.

</details>

## Implementation overview

The plugin has two halves: the Host service reads and mutates local archive data, while the browser settings page provides search, filtering, backup, restore, and cross-tool conversion actions. Codex / Claude Code adapters project into a versioned `dsh-interop` v1 domain model with SHA-256 integrity validation. Mutations go through guarded local routes; imports are previewed before writing, and live deletion uses the safest lifecycle path available on the host before falling back to next-boot cleanup.

User-facing storage, backup limits, deletion outcomes, and compatibility notes stay in this README. Maintainer details such as route contracts, data flow, restore transactions, live-deletion lifecycle, and failure fallbacks are documented in [ARCHITECTURE.md](docs/ARCHITECTURE.en.md).

## Development

```sh
npm test
```

The suite (`test/*.test.mjs`) covers export records and real ZIP decoding, bounded import validation, restore transactions, the metadata store, the statistics service, `dsh-interop` schema and SHA-256 checks, Codex / Claude Code fixtures and round trips, and host-and-browser smoke tests. It uses an isolated temporary DSH home plus mocked host and browser runtimes; it never reads or changes real sessions.

## Version history

### 0.9.0

- Added preview-first Codex and Claude Code JSONL import, reusing conflict-safe single-use tokens and transactional restore.
- Added readable migration and handoff export for Codex / Claude Code, with a sanitized pre-download loss/warning report and explicit native-resume and attachment-binary limitations.
- Added the `dsh-interop` v1 exchange model, SHA-256 integrity checks, conversion loss/warning/conflict reports, and matching fixtures, route tests, and browser tests.
- Verified the new controls, conversion preview, and single-line page title in a real DeepSeek Harness `0.1.0-rc.8` host.

### 0.8.1

- Made the Chinese README the default repository and npm entry point; the English guide is now `README.en.md`.
- Moved maintainer architecture, routes, restore transactions, and deletion lifecycle details to `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.en.md`.
- Added a 🚀 marker to the install heading; runtime behavior remains unchanged from 0.8.0.

### 0.8.0

- Added preview-first import for version-one ZIP backups.
- Added conflict-safe, transaction-based restore without overwriting existing sessions.
- Added workspace and attachment warnings, bounded validation, single-use confirmation tokens, and metadata restoration.

### 0.7.0

- Added versioned JSON + Markdown ZIP backups for single, selected, and all archived sessions.
- Added streaming export, safe ZIP paths, manifest records, and canonical Markdown transcripts.

### 0.6.0

- Added tags, notes, storage statistics, metadata persistence, and the archive insights UI.
- Hardened live deletion and added fallback handling for hosts that do not expose the internal lifecycle hooks.

### 0.5.1

- Published a compatibility-focused patch release for DeepSeek Harness `0.1.0-rc.7`.
- Updated the browser settings section to use the rc.7 overlay and state design tokens.

### 0.5.0

- Added bulk selection and bulk unarchive/delete workflows.
- Improved destructive-action focus handling and project-wide selection behavior.

### 0.4.0

- Added in-place deletion for live sessions when the host exposes the required lifecycle hooks.
- Added the safe pending-deletion fallback, title caching, and a success toast after destructive actions.

### 0.3.0

- First published release of the Archived Chats settings page.
- Added workspace-grouped browsing, title search, type/project filters, unarchive, and confirmed single/group/all deletion.
- Added host routes, the browser settings section, and the pending-deletion sweep for live sessions.

### 0.1.0 and 0.2.0

- These versions were never published to npm and have no repository tags. `0.3.0` is the first public release.

## Uninstall

```sh
dsh plugin --profile web remove dsh-archived-chats
```

The only leftovers are the small `pending-deletions.json` and `metadata.json` files under `$DSH_HOME/plugin-data/archived-chats/`; uninstalling does not process the delete queue or remove your tags/notes.

## License

MIT
