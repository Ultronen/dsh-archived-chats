<p align="center">
  <img src="assets/brand/session-archive-banner.png" alt="Session Archive: local-first archived-chat center for DeepSeek Harness" width="100%">
</p>

<div align="center">

<h1>Session Archive</h1>

<p><strong>A local-first archived-chat center for DeepSeek Harness</strong></p>
<p><code>dsh-archived-chats</code></p>

<p>
  <a href="https://www.npmjs.com/package/dsh-archived-chats"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-archived-chats?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/dsh-archived-chats"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-archived-chats?style=flat-square"></a>
  <a href="https://github.com/Ultronen/dsh-archived-chats/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Ultronen/dsh-archived-chats/ci.yml?branch=main&amp;style=flat-square&amp;label=CI"></a>
  <a href="https://github.com/Ultronen/dsh-archived-chats/actions/workflows/ci.yml"><img alt="Node.js 18 and 24" src="https://img.shields.io/badge/Node.js-18%20%7C%2024-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white"></a>
</p>
<p>
  <a href="https://github.com/Ultronen/dsh-archived-chats/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-2ea44f?style=flat-square"></a>
  <a href="https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <a href="https://github.com/Ultronen/dsh-archived-chats/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Ultronen/dsh-archived-chats?style=flat-square"></a>
</p>

<p>English · <a href="README.zh-CN.md">简体中文</a></p>
<p><a href="https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/">Plugin market</a> · <a href="https://www.npmjs.com/package/dsh-archived-chats">npm</a> · <a href="https://github.com/Ultronen/dsh-archived-chats/releases">Releases</a> · <a href="https://github.com/Ultronen/dsh-archived-chats/discussions">Discussions</a> · <a href="https://github.com/Ultronen/dsh-archived-chats/security/advisories/new">Private security report</a></p>

</div>

Session Archive gives DeepSeek Harness a first-class home for chats that disappear from the sidebar after archive. Browse every archived conversation by workspace, search its full content, inspect validated local history, and recover or remove it through explicit, reversible workflows.

> Formerly **Archived Chats**, now **Session Archive / 会话档案**. The package name, repository, install command, and local data location are unchanged; existing users need no data migration.

## Quick start

```sh
dsh plugin --profile web add dsh-archived-chats@latest
```

Restart DSH once, then open **Settings → Session Archive**.

Update an existing installation:

```sh
dsh plugin --profile web update dsh-archived-chats
```

<p align="center">
  <a href="assets/screenshots/preview-03.png"><img src="assets/screenshots/preview-03.png" width="49%" alt="Native read-only History preview with snapshot time and a synthetic stored image"></a>
  <a href="assets/screenshots/preview-07.png"><img src="assets/screenshots/preview-07.png" width="49%" alt="Storage and Retention with session directories, protection snapshots, and policy controls"></a>
</p>

## Core capabilities

| Area | What it provides |
| --- | --- |
| **Browse and search** | Workspace-grouped archive browsing, full-text search across messages and tool results, filters, sorting, tags, and notes. |
| **Read-only preview** | Native conversation layout for Markdown, reasoning, tool activity, JSON, code, and available stored images, with responsive turn navigation. |
| **Local History** | Validated versions captured after archive, read-only snapshot preview, confirmed deletion, clear-history, and **Restore as copy** without overwriting the source. |
| **Backup and restore** | JSON + Markdown ZIP export with preview-first, conflict-safe import. Existing session IDs are never overwritten. |
| **Recoverable deletion** | Snapshot-protected Recycle Bin with immediate Undo, two-level restore, and separately confirmed permanent deletion. |
| **Storage and relationships** | Separate storage accounting, preview-first retention policies, and read-only Origins & Branches for forks and subagent trees. |

## Safety by design

- **Local only:** plugin metadata, recycle records, policies, and validated snapshots stay under `$DSH_HOME/plugin-data/archived-chats/`. Nothing is uploaded or cloud-synced.
- **No silent overwrite:** imports and History restores create or select non-conflicting IDs; they never replace an existing session.
- **Deletion stays explicit:** ordinary removal enters the Recycle Bin after snapshot protection. Physical removal is available only through confirmed permanent-purge actions.
- **No automatic cleanup:** retention policies are saved separately from execution. Every cleanup starts with a short-lived preview and explicit selection.
- **Backup scope is visible:** ZIP exports preserve complete session JSON and readable Markdown, but do not include attachment bytes or descendant sessions.

## Compatibility

Features activate from the public capabilities exposed by the DeepSeek Harness Host instead of a hard-coded Host version.

| Host capability | Plugin behavior |
| --- | --- |
| Archive and session reads | Browsing, search, preview, History inventory, storage accounting, and lineage. |
| Attachment reads | Stored images appear in conversation and snapshot previews; without it, text remains readable. |
| Public session writer | ZIP import, **Restore as copy**, and snapshot fallback when an original is missing all write through the Host's public `create` / `append` / `locate` capability, or a dedicated restore entry point where one exists. |
| Missing write capability | The operation returns `restore-unsupported` without writing or overwriting data. |

Back up `$DSH_HOME/plugin-data/archived-chats/` before downgrading to a release that does not display History or understand recycle snapshots.

## Demo preview

The eight fixed screenshots below come from an isolated Simplified Chinese light-theme Web environment with synthetic conversations. They contain no real user data, paths, notes, or credentials, and are the same ordered image set declared to the plugin market.

<details>
<summary><strong>View all eight screenshots</strong></summary>
<br>
<table>
  <tr>
    <td><img src="assets/screenshots/preview-01.png" alt="Session Archive overview with five management views"><br><sub>Archive overview</sub></td>
    <td><img src="assets/screenshots/preview-02.png" alt="Full-text search, filters, tags, and readable hit excerpts"><br><sub>Full-text search</sub></td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/preview-03.png" alt="Native read-only History preview with a stored image"><br><sub>Read-only preview</sub></td>
    <td><img src="assets/screenshots/preview-04.png" alt="History timeline with restore-as-copy and deletion actions"><br><sub>History timeline</sub></td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/preview-05.png" alt="Irreversible confirmation before clearing ordinary History"><br><sub>Clear History confirmation</sub></td>
    <td><img src="assets/screenshots/preview-06.png" alt="Recycle Bin protection snapshot, restore, and permanent deletion"><br><sub>Recycle Bin</sub></td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/preview-07.png" alt="Storage accounting and retention policy controls"><br><sub>Storage and retention</sub></td>
    <td><img src="assets/screenshots/preview-08.png" alt="Origins and Branches with forks, subagents, and recycled state"><br><sub>Origins and Branches</sub></td>
  </tr>
</table>
</details>

## Documentation

| Resource | English | 简体中文 |
| --- | --- | --- |
| User guide | [Read the guide](docs/USER_GUIDE.md) | [查看指南](docs/USER_GUIDE.zh-CN.md) |
| Architecture | [Maintainer architecture](docs/ARCHITECTURE.en.md) | [维护者架构](docs/ARCHITECTURE.md) |
| Release history | [GitHub Releases](https://github.com/Ultronen/dsh-archived-chats/releases) | [GitHub Releases](https://github.com/Ultronen/dsh-archived-chats/releases) |

See also [Support](SUPPORT.md), [Security](SECURITY.md), [Contributing](CONTRIBUTING.md), [Code of Conduct](CODE_OF_CONDUCT.md), and [Discussions](https://github.com/Ultronen/dsh-archived-chats/discussions).

## Project status

Session Archive is actively maintained. The latest stable npm release receives fixes and security updates; older releases should be upgraded before reporting a problem. Reproducible bug reports and focused pull requests are welcome. Accepted community tasks are marked [`help wanted`](https://github.com/Ultronen/dsh-archived-chats/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22); read the [claim workflow](CONTRIBUTING.md#community-proposals-and-claims) before starting substantial work. Maintenance is performed as availability permits, so no fixed response or release schedule is promised.

## Development

```sh
npm test
```

The suite covers Host and browser behavior, export/import, History, Recycle Bin, retention, search, responsive layout, public types, package contents, and repository hygiene. It uses isolated temporary data and never reads real sessions.

## Uninstall

```sh
dsh plugin --profile web remove dsh-archived-chats
```

Uninstalling removes only the plugin package. It does not delete local data under `$DSH_HOME/plugin-data/archived-chats/` or trigger Recycle Bin permanent purge. Retained data includes `metadata.json`, `trash.json`, `retention.json`, the `snapshots/` directory, and any legacy `pending-deletions.json` that has not yet been migrated. A later reinstall can use this data. Before permanently removing the directory, restore and back up anything you need, then delete it manually only after confirming that none of its data is still required.

## License

[MIT](LICENSE)
