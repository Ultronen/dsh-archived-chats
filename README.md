# dsh-archived-chats

A settings page for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that brings archived chats back into view.

Once a conversation is archived in DeepSeek Harness it disappears from the sidebar, and there is no built-in way to browse it again — only the workspace store (`~/.dsh/storages/workspace.json`) still remembers it. This plugin adds an **Archived Chats** page under Settings where every archived session is visible, searchable, and manageable.

## Install

```sh
dsh plugin --profile web add dsh-archived-chats
```

Restart DSH once after installing, then open **Settings → Archived Chats**.

## Features

- **Complete archived-session list**, grouped by workspace (project) with a per-group count. Every group can be collapsed or expanded, and the state is remembered per browser.
- **Search** by title, plus two filters: type (all / regular / subagent) and project.
- **Unarchive** a single chat or a whole project group from the group's `⋯` menu — restored chats reappear in the sidebar immediately.
- **Delete** one chat, a project group, or everything (**Delete All**), each behind a confirmation dialog. Deletion is thorough: the session log is removed from disk, the session is detached from its workspace record, and the registry's in-memory header index is purged, so the sidebar drops the rows live.
- Sessions still resident in the background are **deleted in place too**: the plugin disposes the session through the official lifecycle teardown order (cancel → quiesce → flush → fiber teardown → registry detach), the persistence layer releases the write path, and the physical delete completes within the same request — no restart. If the running DSH build does not expose the required internal seams, the plugin falls back to "park permanently + delete on the next start", with parked sessions staying hidden meanwhile.
- Works in light and dark schemes; localized in English and 中文.

## How it works

- **Host half** (`lib/index.js`) registers the `/plugins/dsh-archived-chats/*` routes on the DSH web server: `GET /state`, `POST /unarchive`, `POST /unarchive-all`, `POST /delete`, `POST /delete-all`. Unarchiving writes through the workspace registry's own state path, so every connected client receives the `host/archived-sessions-changed` push. Mutating routes require a custom `x-dsh-archived-chats: 1` header as CSRF hardening.
- **In-place live deletion**: deleting a resident session replays the agent factory's own disposer sequence — `cancel({ kind: 'disposed' })` → `whenIdle` → `flush` → `agent.scope.dispose()` → detach of the `agents` and `sessions` store entries. The session detach emits `session/disposed`, the persistence coordinator retires (drains and releases) the write path, and the ordinary cold delete completes in the same request. The store entries are internal surfaces, so every step is feature-detected; anything missing falls back to park-and-defer.
- **Pending-deletion store** (fallback path and crash bracket): the id is recorded in `$DSH_HOME/plugin-data/archived-chats/pending-deletions.json` while the session stays archived and hidden; the next boot sweeps the queue through the ordinary delete path. In-place deletes are bracketed by the same store (recorded before disposal, cleared once the files are gone), so a crash mid-delete is completed on the next start. Parked sessions are excluded from the listing; unarchiving cancels a pending deletion.
- **Title cache**: resolved titles are memoized per id across list refreshes instead of re-reading every archived log; delete and unarchive invalidate their entries.
- **Browser half** (`lib/client.js`) registers a `settings.section` slot entry (order 30) and renders the page with React and DSH design tokens.

## Uninstall

```sh
dsh plugin --profile web remove dsh-archived-chats
```

The only leftover is the small pending-deletion store under `$DSH_HOME/plugin-data/archived-chats/`; uninstalling does not process the queue.

## License

MIT
