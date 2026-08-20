# dsh-archived-chats

> ⚡ **Deletion takes effect immediately — no restart.** Even sessions still resident in the background are torn down safely along the official lifecycle and wiped from disk the moment you click delete, instead of being "parked until the next restart".

A settings page for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that brings archived chats back into view.

Once a conversation is archived in DeepSeek Harness it disappears from the sidebar, and there is no built-in way to browse it again — only the workspace store (`~/.dsh/storages/workspace.json`) still remembers it. This plugin adds an **Archived Chats** page under Settings where every archived session is visible, searchable, and manageable.

## Install

```sh
dsh plugin --profile web add dsh-archived-chats
```

Restart DSH once after installing, then open **Settings → Archived Chats**.

## Compatibility

Version 0.8.0 uses DeepSeek Harness `0.1.0-rc.7` as its automated compatibility baseline. The plugin registers a top-level `settings.section`, so the rc.7 keyed-slot change for `settings.plugin.item` does not apply to it. A local real-host UI pass was also completed on Harness `0.1.0-rc.8` for the archive list, search, metadata editor, bulk actions, group actions, and import preview. Future Harness releases should still be checked with the smoke suite and a real-host UI pass before publishing a plugin update, because client slot and design-token contracts may evolve.

## Screenshots

These screenshots were captured from the current 0.8.0 build in a local DeepSeek Harness web profile.

![Archived Chats overview](assets/screenshots/1-archived-chats.png)
![Search and filters](assets/screenshots/2-search.png)
![Delete confirmation](assets/screenshots/3-delete-confirm.png)
![Group actions](assets/screenshots/4-group-menu.png)
![Metadata editor](assets/screenshots/5-metadata-editor.png)
![Bulk actions](assets/screenshots/6-bulk-actions.png)
![Import preview](assets/screenshots/7-import-preview.png)

## Features

- **Complete archived-session list**, grouped by workspace (project) with a per-group count. Every group can be collapsed or expanded, and the state is remembered per browser.
- **Search and sort** by title, workspace title, tags, and note text; filter by type (all / regular / subagent), project, and tag; then order results by newest, oldest, or title.
- **Tags and notes**: open an editor from any row to attach up to 8 tags (24 Unicode characters each) and a note (2,000 Unicode characters). Tag chips render per row, overflowing past three into a `+N` indicator, and the tag filter narrows the list case-insensitively.
- **Storage insights**: a summary strip reports the archived count, total measured size, and how many sessions could not be measured; each row shows its own size. Measurement never follows symbolic links and skips sessions whose directories are unreadable.
- **JSON + Markdown backups**: export one row, the current selection, or every archived chat as a ZIP. Each package has a versioned manifest, a lossless machine-readable session record, and a human-readable transcript for every included session.
- **Preview-first import and restore**: choose a ZIP backup, inspect every session before writing, preselect only non-conflicting IDs, and restore selected sessions as archived chats. Existing IDs are skipped and never overwritten.
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

## How it works

- **Host half** (`lib/index.js`) registers the `/plugins/dsh-archived-chats/*` routes on the DSH web server: `GET /state`, `GET /stats`, `POST /export`, `POST /import/inspect`, `POST /import/restore`, `POST /metadata`, `POST /unarchive`, `POST /unarchive-all`, `POST /delete`, `POST /delete-all`. `/state` joins tags, notes, and `metadataUpdatedAt` onto every row; `/stats` returns byte/file totals; `/export` streams a ZIP response from a bounded native-form request; the import routes validate a bounded multipart ZIP, keep a short-lived single-use preview token, and commit through the feature-detected restore adapter. Unarchiving writes through the workspace registry's own state path, so every connected client receives the `host/archived-sessions-changed` push. Mutating routes require a custom `x-dsh-archived-chats: 1` header as CSRF hardening; read-only export does not mutate plugin or Harness state.
- **Export writer** (`lib/export.js`): owns format-versioned records, safe filenames, Harness transcript projection, and sequential ZIP entries. It preflights the first session before response headers and keeps at most one inspected session payload during a batch.
- **Metadata store** (`lib/metadata.js`): a versioned, atomic JSON store. Writes serialize through a queue and replace the file via a temp-file rename, so simultaneous saves cannot interleave; unreadable or unsupported files are never overwritten.
- **Storage statistics** (`lib/stats.js`): measures session directories at concurrency 4, skips symbolic links, caches results for 30 seconds, and reports unavailable rows instead of failing the request. Delete invalidates the cached row.
- **In-place live deletion**: deleting a resident session replays the agent factory's own disposer sequence — `cancel({ kind: 'disposed' })` → `whenIdle` → `flush` → `agent.scope.dispose()` → detach of the `agents` and `sessions` store entries. The session detach emits `session/disposed`, the persistence coordinator retires (drains and releases) the write path, and the ordinary cold delete completes in the same request. The store entries are internal surfaces, so every step is feature-detected; anything missing falls back to park-and-defer.
- **Pending-deletion store** (fallback path and crash bracket): the id is recorded in `$DSH_HOME/plugin-data/archived-chats/pending-deletions.json` while the session stays archived and hidden; the next boot sweeps the queue through the ordinary delete path. In-place deletes are bracketed by the same store (recorded before disposal, cleared once the files are gone), so a crash mid-delete is completed on the next start. Parked sessions are excluded from the listing; unarchiving cancels a pending deletion.
- **Title cache**: resolved titles are memoized per id across list refreshes instead of re-reading every archived log; delete and unarchive invalidate their entries.
- **Browser half** (`lib/client.js`) registers a `settings.section` slot entry (order 30) and renders the page with React and the rc.7 DSH overlay/state design tokens.

## Development

```sh
npm test
```

The suite (`test/*.test.mjs`) covers export records and real ZIP decoding, bounded import validation, restore transactions, the metadata store, the statistics service, and host-and-browser smoke tests. It uses an isolated temporary DSH home plus mocked host and browser runtimes; it never reads or changes real sessions.

## Uninstall

```sh
dsh plugin --profile web remove dsh-archived-chats
```

The only leftovers are the small `pending-deletions.json` and `metadata.json` files under `$DSH_HOME/plugin-data/archived-chats/`; uninstalling does not process the delete queue or remove your tags/notes.

## License

MIT
