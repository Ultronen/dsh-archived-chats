# dsh-archived-chats

English | [中文](README.zh.md)

**Archived Chats for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — a settings page that shows every archived session, modeled on the CodeX archived-chats view.

Stock DSH hides archived sessions from the sidebar with no list surface: once you archive a chat it is gone from the UI, and only `~/.dsh/storages/workspace.json` remembers it. This plugin adds the missing page.

## Install

```sh
dsh plugin --profile web add dsh-archived-chats
```

Open **Settings → Archived Chats** (a new nav entry). Restart once after install.

## What you get

- **The full archived list**, grouped by workspace (project) with per-group counts — every group is **collapsible** (remembered per browser) so long lists stay manageable.
- **CodeX-style chrome**: an archive-box icon in the Settings nav, and the same delete-confirmation wording as CodeX's archived-chats page.
- **Search** by title, plus **type** (all / regular / subagent) and **project** filters.
- **Unarchive** one chat, or a whole project group from its `⋯` menu — the chat returns to the sidebar live.
- **Delete** one chat, a group, or everything (**Delete All**) with a confirmation dialog; deletion is thorough — the session log is removed from disk, the session is detached from its workspace record, the registry's in-memory header index is purged, and the main sidebar drops the rows live (the page re-baselines `session.list` after every delete). A chat still resident in the background (opened at least once this launch) is **permanently parked** and recorded in the pending-deletion store, stays archived and hidden, leaves the list immediately, and is physically removed on the next DSH boot.
- Works in both light and dark schemes, in 中文 and English.

## How it works

- **Host half** (`lib/index.js`) registers `/plugins/dsh-archived-chats/*` routes on the DSH web server: `GET /state`, `POST /unarchive`, `POST /unarchive-all`, `POST /delete`, `POST /delete-all`. Unarchiving writes through the workspace registry's own state path so every connected client receives the `host/archived-sessions-changed` push. Mutating routes require a custom header (`x-dsh-archived-chats: 1`) as CSRF hardening.
- **Pending-deletion store**: deleting a background-resident session takes the "park and defer" path — the agent is permanently parked (`cancel({kind:'disposed'})`), the session stays archived and hidden, and the id is recorded in `$DSH_HOME/plugin-data/archived-chats/pending-deletions.json`; on the next boot the plugin sweeps the queue once its services bind, completing the removal through the ordinary delete path. Queued sessions are excluded from the archived listing; unarchiving one before the restart cancels its pending deletion.
- **Browser half** (`lib/client.js`) registers a `settings.section` slot entry (order 30) and renders the page with plain React + DSH design tokens.

## Uninstall

```sh
dsh plugin --profile web remove dsh-archived-chats
```

Nothing is left behind beyond the tiny pending-deletion store (`$DSH_HOME/plugin-data/archived-chats/`); the archive set stays the host's, and uninstalling does not trigger the queue.

## License

MIT
