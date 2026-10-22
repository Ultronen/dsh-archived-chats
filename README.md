[![DSH Insights health](https://dsh-insights.com/badge/Ultronen/dsh-archived-chats.svg)](https://dsh-insights.com/p/Ultronen/dsh-archived-chats/)

<p align="center">
  <img src="assets/brand/archive-management-banner.png" alt="Archive Management: local-first archived-chat center for DeepSeek Harness" width="100%">
</p>

<div align="center">

<h1>Archive Management</h1>

<p><strong>Find past DSH chats, manage archives, and keep ZIP backups.</strong></p>
<p><code>dsh-archived-chats</code></p>

<p>
  <a href="https://www.npmjs.com/package/dsh-archived-chats"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-archived-chats?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/dsh-archived-chats"><img alt="npm total downloads" src="https://img.shields.io/npm/dt/dsh-archived-chats?style=flat-square&amp;label=total%20downloads"></a>
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

Archive Management adds conversation search, organization and backups to DeepSeek Harness. Find a past solution, preview its context, archive by workspace, or save a ZIP before deleting a chat.

- **Find past work:** search titles, messages, tool results, tags and notes; open a match with surrounding context.
- **Organize chats:** manage Archived and Unarchived, including workspace groups, ungrouped chats, bulk actions, tags and notes.
- **Keep a backup:** export JSON + Markdown ZIPs; preview imports and skip existing IDs instead of overwriting them.

> This document describes 1.6.0. New recycle operations and automatic cleanup are retired; see [upgrading](#upgrading-from-older-releases) for existing data.

## Install and open

Find `dsh-archived-chats` in the DSH plugin market, verify author **Ultronen**, and install. Follow the host's restart prompt, then open **Settings → Archive Management** (Chinese: **设置 → 归档管理**).

Alternatively, use the CLI. `web` is an example profile; replace it with your running DSH profile and use the same profile for updates and removal:

```sh
dsh plugin --profile web add dsh-archived-chats@latest
```

If installation reports `ERR_PNPM_ADDING_TO_ROOT`, add `-w` after `add`. To update:

```sh
dsh plugin --profile web update dsh-archived-chats
```

## First task

1. Open **Unarchived**, click a chat title to preview it, then archive the chat you want to keep. Blank new chats are excluded; running chats require explicit **Stop and archive** confirmation.
2. Search **Archived**, open a title or matching snippet, and edit tags and notes from the preview.
3. Choose **Select**, check chats, and choose **Export selected**; narrow layouts place this action in the three-dot menu. Verify the ZIP in browser downloads.
4. **Unarchive** to continue chatting. Before deleting, decide whether to keep a backup: deletion is permanent and cannot be undone.

## Pages and capabilities

| Page | Purpose |
| --- | --- |
| Archived | Search, filter, preview, tags and notes, import/export, unarchive and confirmed permanent deletion. |
| Unarchived | Ordinary workspace and ungrouped chats, preview, individual/workspace/global archiving. |
| Origins & Branches | Read-only sources, forks and subagents related to archived chats. |
| About | Automatic update checks, host and local-checkout detection, copyable installation details, host-supported updates, and manual residual-chat checks. |
| Recycle Bin, when records exist | Recover legacy records to Archived, export protection snapshots, or confirm permanent deletion; hidden when empty. |

Content search starts at two characters and scans the selected scope in batches, showing progress, matches and failures; it supports Stop and Retry. Unarchived searches titles or session IDs. See the [user guide](docs/USER_GUIDE.md) for scope, long-log limits and detailed operations.

## Archive, delete and maintain

**Archive organizes; Delete permanently removes.** Archive and unarchive use official Host operations. Row deletion, selected deletion, workspace Delete all and global Delete all require confirmation. Workspace deletion never deletes project directories. Search and filters do not narrow workspace or global bulk actions.

**Residual checks are manual maintenance.** Open **About → Maintenance → Check residual chats** to inspect subagents with an explicit parent reference whose parent no longer exists. Preview or export first, then select and confirm permanent deletion; eligibility is rechecked at execution. Ungrouped chats, independent forks, ordinary unarchived chats and blank chats are excluded. Opening the page never scans or cleans automatically.

## Backups and data boundaries

| Format | Contents | Use |
| --- | --- | --- |
| Conversation backup ZIP | JSON, Markdown, tags, notes and attachment references; no attachment bytes or automatic descendant bundling. | Preview with Import backup, then restore; existing IDs are skipped. |
| Legacy protection-snapshot ZIP | Legacy record, validated session payload and image attachments; 64 MiB per record. | Preserve legacy data; not accepted by the ordinary conversation importer. |

Successful exports are validated against the same format and budgets as import before the download starts. This applies to ordinary conversation backups; protection snapshots use a separate format. A download-started notice does not confirm the file was saved; check browser downloads.

- Data stays on the DSH host under `$DSH_HOME/plugin-data/archived-chats/`, defaulting to `~/.dsh/`. The plugin does not upload or cloud-sync chats.
- Permanent deletion removes session and related plugin data, not all global Host attachments, caches or external backups. Failures retain retryable tasks.
- A chat without a working directory remains in Archived; a missing workspace alone allows an ungrouped chat.
- Empty Recycle Bin uses the exact recycle-record incarnations shown at confirmation; changed targets do not expand the deletion scope.

## Upgrading from older releases

Version 1.6.0 disables new Move to Recycle Bin actions, removes Storage & Retention navigation, and stops automatic expiry and startup snapshot sweeping.

**Removing navigation does not migrate or delete existing data.** Legacy recycle records, snapshots and saved policies remain. Records keep the Recycle Bin visible; catalog read errors retain a retry view instead of being mistaken for an empty bin. Saved cleanup policies do not run, and incomplete permanent deletions require explicit retry.

Recovery prefers an intact original and returns it to Archived. Missing-original snapshot recovery depends on Host capabilities; unsupported or invalid recovery keeps the record and reports failure. Export a protection snapshot to preserve data first. Never treat manually deleting plugin data as emptying the Recycle Bin.

Installing an older release can restore its earlier cleanup rules. Before downgrading, keep a full data backup and check pending tasks and format compatibility.

## Compatibility

The declared range is DSH `>=0.1.0-rc.7`; features still depend on Host capabilities. Native tests use pinned `0.1.7-rc.2` and `0.2.1-rc.2` backends; release CI covers macOS, Windows and Linux.

Archive, unarchive and inventory use official capabilities. Permanent deletion coordinates Host session lifecycle and storage locations rather than calling one unified public deletion API. ZIP import and legacy snapshot recovery also have different writer requirements. See [compatibility and limits](docs/USER_GUIDE.md#compatibility-and-limits).

## Screenshots

These 1.6.0 screenshots use synthetic example chats. The legacy Recycle Bin appears only when records exist; [screenshots.json](screenshots.json) owns the order.

<details>
<summary>View screenshots</summary>

1. [Archived chats](assets/screenshots/preview-01.png)
2. [Full-text search and selected actions](assets/screenshots/preview-02.png)
3. [Unarchived and workspace archiving](assets/screenshots/preview-03.png)
4. [Conversation preview](assets/screenshots/preview-04.png)
5. [Legacy Recycle Bin](assets/screenshots/preview-05.png)
6. [Restore confirmation](assets/screenshots/preview-06.png)
7. [About and manual maintenance](assets/screenshots/preview-07.png)
8. [Origins & Branches](assets/screenshots/preview-08.png)

</details>

## Documentation and feedback

[User guide](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.en.md) · [Changelog](CHANGELOG.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md)

Use [Discussions](https://github.com/Ultronen/dsh-archived-chats/discussions) for questions and suggestions. Bug reports should include plugin and DSH versions, minimal reproduction steps and redacted errors. Report security issues [privately](SECURITY.md). If this helped you find past work, consider [giving the project a Star](https://github.com/Ultronen/dsh-archived-chats).

## Development and validation

```sh
npm test
npm ci --prefix test/fixtures/native-host --ignore-scripts --include=optional
node scripts/run-native-integration.mjs
npm ci --prefix test/fixtures/native-host-0.2.1 --ignore-scripts --include=optional
node scripts/run-native-integration.mjs --fixture-root test/fixtures/native-host-0.2.1
npm pack --dry-run --json
```

Native checks use isolated temporary data; all eight tests in each fixture must run without skips. Read the [contribution guide](CONTRIBUTING.md) in full before contributing.

## Uninstall

```sh
dsh plugin --profile web remove dsh-archived-chats
```

Removing the package preserves plugin data and does not permanently purge chats. See [local data and uninstall](docs/USER_GUIDE.md#local-data-and-uninstall).

[MIT License](LICENSE)
