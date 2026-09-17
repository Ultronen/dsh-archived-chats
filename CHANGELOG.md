## 1.3.1 — 更新插件市场截图 / Refresh plugin-market screenshots

### 中文

- 重新拍摄全部 8 个插件市场演示场景，使图片与 1.3 系列的当前界面和操作一致。
- 新增工作区归档选择器、统一回收站工作区菜单和自动清理确认等关键界面展示。
- 同步更新中英文 README 的截图顺序、替代文字和图注。本补丁不改变运行时行为。

### English

- Recaptured all eight plugin-market demo scenes so the images match the current 1.3 interface and actions.
- Added coverage for the workspace archive chooser, unified Recycle Bin workspace menu, and automatic-cleanup confirmation.
- Synchronized screenshot order, alt text, and captions in both READMEs. This patch does not change runtime behavior.

## 1.3.0 — 统一回收站与精简操作 / Unified Recycle Bin and simpler actions

### 中文

本次大更新把旧快照、普通回收会话和保护快照统一到一个回收站，并简化归档与回收站的操作层级。**升级不会删除已有聊天或快照。**

- **旧快照直接进入回收站**：移除“空间与策略”中的独立旧版数据入口。升级后，已有快照自动显示为回收站条目，无需再次迁移或整理；可读取快照支持只读预览和恢复，降级快照只支持永久删除。
- **恢复不会覆盖来源**：恢复旧快照会创建新的归档副本并清理对应迁移条目，不修改来源聊天。普通回收会话仍优先恢复原会话；缺少原件时才从已验证保护快照恢复。
- **自动清理明确选择后才启用**：回收站自动清理默认关闭，可选 7 天、30 天、90 天或 1–3650 天自定义期限。升级会把用户旧版保存的回收天数按“不启用”处理，绝不会因为更新而开始自动永久删除。首次开启或缩短期限会列出已到期内容并要求确认。
- **自动删除时机**：DSH 运行时约每分钟检查一次，关闭期间暂停，并在下次启动恢复完成后补检。每条到期内容在永久删除前都会重新核对策略与回收状态；失败项保留记录并重试。
- **操作层级简化**：归档页和回收站不再提供多选、行复选框或批量工具栏。单条内容使用行内操作，整个工作区使用三点菜单，跨工作区内容使用标题行右上角操作。
- **工作区归档选择器**：只展示至少有一条可归档会话的工作区，支持单选、多选和全选；“全选”首次点击勾选全部，再次点击全部取消。任何选择都通过右下角“确定”进入一次汇总确认，准备期间变为空的工作区会自动跳过，不再显示“没有可归档会话”的额外弹窗。多个工作区会按顺序执行并汇总结果，单个工作区失败不会中断后续工作区。
- **归档操作重新排序**：单条操作依次为预览、编辑标签备注、永久删除和取消归档，编辑统一为图标，取消单条导出和行内更多菜单。工作区菜单依次为“全部导出”“全部取消归档”“全部永久删除”“全部移至回收站”；标题行右上角提供“全部删除”。
- **回收站操作**：单条预览、恢复和永久删除均使用带名称提示的图标按钮。工作区三点菜单提供“全部恢复”和“全部永久删除”；无法恢复的降级快照会被“全部恢复”跳过。标题行右上角提供“清空回收站”。
- **删除范围写清楚**：“全部删除”永久删除所有工作区中的归档聊天及其插件元数据和关联快照，但不影响已在回收站中的内容；“清空回收站”永久删除所有工作区的回收会话和保护快照。
- **归档列表重新排版**：搜索框独占首行；类型与排序合并到“全部聊天”，并与项目、标签筛选同排。工作区使用统一边框和行分隔；备注单行省略，仅在确实截断时悬停或聚焦显示完整内容；时间不再重复显示“创建于”前缀。归档和回收站的文字操作按钮统一为与“全部删除”相同的圆角规格。
- **本地迁移状态**：新增 `legacy-recycle.json` 记录旧快照的回收迁移状态；`retention.json` 升级为 version 2。所有插件数据仍保存在本机。

兼容性：`POST /history/capture` 继续返回 `410 history-capture-retired`。现有 History 清单、预览、恢复和删除路由继续作为迁移及兼容层；浏览器不再显示独立 History 页面。Issue #34 所需的 Host 投影缓存删除生命周期接口仍未公开，因此本版未直接操作 Host 的 `session_projcache` 文件。

### English

This major update combines older snapshots, regular recycled chats, and protection snapshots in one Recycle Bin, while simplifying archive and recycle actions. **Upgrading does not delete existing chats or snapshots.**

- **Existing snapshots move into the Recycle Bin:** the separate Legacy data entry is removed from Storage & Retention. Existing snapshots appear automatically as Recycle Bin items after upgrade. Readable snapshots support read-only preview and recovery; degraded snapshots support permanent deletion only.
- **Recovery never overwrites the source:** restoring an older snapshot creates a new archived copy and cleans up its migration item without changing the source chat. Regular recycled chats still restore the original first and use a verified protection snapshot only when the original is missing.
- **Automatic cleanup requires explicit opt-in:** it is disabled by default and supports 7, 30, 90, or 1–3650 custom days. An older saved Recycle Bin duration is treated as disabled after upgrade, so updating alone can never start permanent deletion. Enabling or shortening the period lists already-expired items and requires confirmation.
- **Automatic deletion timing:** DSH checks about once a minute while running, pauses while closed, and catches up after startup recovery. Every expired item is revalidated against the current policy and recycle state before permanent deletion; failures retain their records for retry.
- **Simpler action levels:** Archived and Recycle Bin no longer expose multi-select, row checkboxes, or batch toolbars. Use row actions for one item, the three-dot workspace menu for a workspace, and the upper-right title action across workspaces.
- **Workspace archive chooser:** only workspaces with at least one eligible chat are listed. Single selection, multi-selection, and Select all are supported; the first Select all click checks every workspace and the second clears them. Every selection proceeds through the bottom-right Confirm button into one aggregate confirmation. Workspaces that become empty during preparation are skipped without opening the old no-eligible-chats dialog. Selected workspaces run in order with one aggregated result, and one failed workspace does not stop later workspaces.
- **Reordered archive actions:** row actions are preview, edit tags and note, permanent delete, and Unarchive. Editing uses an icon, while single-chat export and the row More menu are removed. Workspace menus list Export all, Unarchive all, Delete all permanently, and Move all to Recycle Bin. Delete all sits at the upper right of the title row.
- **Recycle Bin actions:** preview, restore, and permanent delete use named icon buttons. Workspace menus provide Restore all and Delete all permanently; Restore all skips degraded or otherwise unrestorable snapshots. Empty Recycle Bin sits at the upper right of the title row.
- **Clear deletion scope:** Delete all permanently removes archived chats across every workspace together with plugin metadata and related snapshots, while leaving existing Recycle Bin items untouched. Empty Recycle Bin permanently deletes every recycled chat and protection snapshot across all workspaces.
- **Archive layout:** search owns the top row. Type and sorting move into All chats beside project and tag filters. Workspace rows share one border with separators. Notes stay on one ellipsized line and show the full popup only when actually truncated; timestamps omit the redundant Created prefix. Archived and Recycle Bin text actions now share the same corner radius as Delete all.
- **Local migration state:** `legacy-recycle.json` records older-snapshot recycle migration state, and `retention.json` moves to schema version 2. All plugin data remains local.

Compatibility: `POST /history/capture` continues to return `410 history-capture-retired`. Existing History inventory, preview, restore, and delete routes remain as migration and compatibility APIs; the browser no longer shows a standalone History page. The Host projection-cache deletion lifecycle required by Issue #34 is still unavailable, so this release does not manipulate Host `session_projcache` files directly.

## 1.2.0 — 简化历史版本与回收站 / Simplify History and Recycle Bin

### 中文

本次更新取消独立的历史版本功能，将日常使用简化为归档管理、回收站恢复与主动导出备份。**升级不会删除已有聊天或快照。**

- **主导航调整为四项**：归档、回收站、空间与策略、来源与分支。独立“历史版本”标签移除。
- **归档不再创建历史快照**：普通归档和工作区批量归档只改变归档状态，不再持续保存多个版本。归档成功提示仍支持查看与撤销。
- **回收站继续负责可撤销删除**：移入回收站时仍保存恢复所需的保护数据，可从回收站恢复。确认永久删除会删除对应聊天及关联快照。长期保存请主动导出 ZIP 备份。
- **已有数据保留**：旧快照可在“空间与策略 → 旧版数据”中预览、恢复为新的归档副本后导出，或经确认后删除。恢复不会覆盖原聊天；正在保护回收站恢复的快照不会出现在可清理的旧版数据列表中。回收站恢复后留下的非活动保护快照也可在此管理。
- **保留策略简化**：移除历史版本数量、快照保存天数、快照容量配额三个设置。旧策略文件仍兼容读取，但这些旧规则不再产生快照删除建议。仅保留回收站天数设置；保存策略不会删除数据，必须预览并确认后才执行清理。
- **可靠性与界面**：空间统计加载失败时，旧版数据仍可独立访问；恢复或删除旧数据后立即更新空间统计，并保留未保存的策略草稿。优化窄屏统计布局，同步更新中英文文档及八张产品截图。

兼容性提示：旧的 `POST /history/capture` 接口现返回 `410 history-capture-retired`。已有快照的读取、恢复与删除接口保留，服务于旧数据迁移。依赖历史捕获的自定义客户端应停止调用该接口。

验证：236 项自动化测试通过；独立代码审查通过；桌面、390px 窄屏、空间统计失败场景和本地 DSH 运行验证通过。

### English

This release retires the standalone History feature and simplifies everyday use around archive management, Recycle Bin recovery, and explicit ZIP backups. **Upgrading does not delete existing chats or snapshots.**

- Navigation now contains four views: Archived, Recycle Bin, Storage & Retention, and Origins & Branches.
- Normal and workspace bulk archiving no longer capture historical versions. Archive success still offers View and Undo.
- Moving a chat to the Recycle Bin still preserves recovery data. Restore it from the Recycle Bin; confirmed permanent deletion removes the chat and its associated snapshots. Export ZIP backups for long-term preservation.
- Existing snapshots remain available under **Storage & Retention → Legacy data** for preview, recovery as a new archived copy for export, or confirmed deletion. Recovery never overwrites the original. Active Recycle Bin protection snapshots are excluded from the legacy cleanup list; inactive protection snapshots retained after recovery can be managed there.
- History count, snapshot age, and snapshot quota controls are retired. Old policy files remain readable, but those rules no longer propose snapshot deletion. Only Recycle Bin age remains; saving a policy does not delete data, and cleanup requires preview and confirmation.
- Legacy data remains accessible when storage statistics fail. Recovery and deletion refresh storage totals without losing unsaved policy edits. Narrow-screen storage cards, bilingual documentation, and all eight product screenshots are updated.

Compatibility: `POST /history/capture` now returns `410 history-capture-retired`. Existing snapshot read, recovery, and deletion endpoints remain for migration. Custom clients must stop requesting historical captures.

Validation: 236 automated tests, independent code review, desktop and 390px browser checks, storage-error recovery access, and local DSH runtime verification passed.
