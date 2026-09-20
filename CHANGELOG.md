# 更新日志 / Changelog

以下条目描述各版本当时的行为，不代表全部适用于当前版本。当前使用说明见中英文 README 和用户指南；未发布改动单独列在 Unreleased。

Entries describe behavior at each release, not necessarily current behavior. Consult the READMEs and user guides for current usage; unpublished changes remain under Unreleased.

## Unreleased

### 中文

- 中文入口、页面标题和说明统一更名为「归档管理」，英文名称及安装包名保持不变。「关于」去掉重复的插件标题，直接展示简短介绍，保留当前版本、作者、许可证、链接与更新检查。
- 回收站原件缺失时仅允许显式独占的旧版写入器重建普通会话；普通 create/append、所有 seeded 边界不明或无法保留的快照均在写入前拒绝。清空回收站在首次清理前完整校验目标和重复 ID。安装包的可选 Host peer 范围明确接受已验证的 `0.1.5-rc.2`。

- 工作区菜单调整为全部取消归档、全部移入回收站、全部导出，再以分隔线隔开全部删除。「关于」明确显示动态读取的当前版本；区分本地信息与远程更新检查失败，增加本地信息重新读取入口，不伪造版本号。

- 修复新版 Host 的「导出 → 永久删除 → 导入」失败：接入官方 create/append/flush/close 句柄，恢复原 ID、标题、事件、工作区及标签备注，兼容既有 v1 备份。新版 ZIP v2 保存分叉继承边界，支持父会话缺失时恢复；旧 writer 不会展平分叉。导入重检回收记录和待删除任务冲突，失败释放写入占用；归属不明的落盘残留保留并报告回滚未完成。新增官方存储组件临时目录闭环及失败注入测试；不包含附件文件本体。

- 回收站顶部直接并列显示纯文字的「全部恢复」与「清空回收站」，移除仅含一项的更多菜单，保留等高布局及清空确认。聊天行保留预览图标，将恢复／删除改为与归档行一致的紧凑文字按钮。主按钮改为黑底白字，Tab 选中使用黑色文字与下划线，随深色主题反转；禁用态淡化，危险操作保留红色。
- 工作区／全局恢复分别确认范围、数量及已归档去向，跳过待删除项；结果显示实际成功和失败数量，提供「查看已归档」。
- 新增末尾「关于」页及标题版本号，提供作者、许可证、指南、反馈和市场入口。后台受限查询公开 npm 版本，自动检查缓存 12 小时，手动检查短限流；失败不误报最新版、不干扰归档，不发送聊天或备份内容。发现新版时「去更新」仅打开市场，不安装或重启。
- 已归档顶部简化为「批量归档」和「更多」，更多菜单提供导入备份、全部导出、全部取消归档及分隔线后的全部删除。工作区导出、取消归档、移入回收站及删除均确认完整工作区名称和归档数量；全局操作确认所有工作区归档数量，排除回收站，筛选不缩小范围。
- 归档删除入口统一使用「删除／全部删除」，确认弹窗简洁说明目标聊天、工作区或全局范围及不可恢复的后果。
- 修复原生 `React.memo` Markdown 组件识别。完整加载且已结束的轮次默认折叠中间过程，嵌套显示思考、上下文来源与工具参数／结果，最终回复单独展示；不完整或缺少边界的日志保持事件顺序。过程在 AI 左侧，真实用户消息在右侧，保持只读无输入框，不编造用量或耗时。新版投影需重新加载 DSH 后端，仅刷新浏览器不够。
- 恢复会话或开启新请求系列时，按已有日志展示当轮生效的系统提示词；保留更新、清空及替换边界，不从缺失信息推测提示词。回收站删除确认同步展示聊天名称或工作区范围、数量及不可撤销说明。
- 修复现代 Host 上分叉正文预览／搜索和移入回收站：使用完整只读接口，保护记录 v2 保存继承历史的精确分界并兼容旧 v1。恢复现存原件不改写日志；原件缺失时拒绝旧写入器展平分叉。读取失败不再一律误报 `snapshot-source-missing`。
- 各 Tab 保留等高的顶部操作区，避免按钮出现／消失导致页面跳动；顶部按钮统一紧凑尺寸，窄窗口在标题下方保留等高操作行。侧栏档案图标沿用宿主尺寸并加深线条，工作区标题、文件夹及右侧数量／菜单垂直居中。
- 顶部中文标签改为「已归档」；归档工作区标题完整换行展示，文件夹图标放大并保持常规线条，与聊天数量统一使用柔和的辅助文字色和正常字重；以文件夹开合样式替代独立箭头，保留点击标题折叠及键盘操作。
- 单条归档聊天的「删除」改为文字按钮，放在「取消归档」右侧，两者采用更紧凑的字号和内边距，并继续要求删除确认。
- 只读预览为系统提示词、思考和注入上下文增加默认收起的标题与图标，优先使用宿主折叠组件；无宿主组件时保留悬停／聚焦切换箭头及键盘展开。系统提示词正文限高滚动，注入上下文不再误呈现为用户气泡，焦点循环跳过折叠内容。
- 「来源与分支」改为按工作区折叠的紧凑关系列表：记住工作区折叠、默认收起后代、标题旁展开分支、详情按需显示时间与 ID；限制深层缩进并保留跨工作区来源。搜索临时展开命中路径，全部展开／折叠覆盖当前筛选结果。
- 修复新版 Host 分叉会话在归档列表中显示“未命名会话”：标题独立只读提取。
- 归档直接永久删除复用持久化删除任务，先清理关联快照，再删除会话；原件已删除但后续清理失败时，仍能在重启后继续完成。
- 归档永久删除拒绝已在回收站中的会话；失败待重试项及时从普通归档列表移除，并保留错误提示。
- 保留工作区导出和仅通过工作区移入回收站的界面操作。
- 清空回收站绑定确认时的精确回收记录实例；新增记录不扩大范围，已变更或结果不确定的目标保留以安全失败或重试。取消归档明确区分缺少工作目录与缺少工作区，前者保留已归档副本。
- 导出在返回下载流前仅读取每个来源一次，并执行与导入共用的完整格式、语义和大小验证。导入严格校验 ZIP 中央目录、CRC 和 UTF-8，拒绝截断、加密、ZIP64 和多磁盘归档。浏览器在五分钟／320 MiB 响应字节上限内缓冲完整 ZIP 后发起下载；这不是峰值堆内存或已保存到磁盘的承诺。
- 按当前实现重整中英文 README、用户指南、架构说明和包简介，明确操作范围、恢复路径、旧快照启动清理与自动保留策略的区别，以及 Host 和分叉限制；将 v1.3.1 截图标为历史素材，尚未重新拍摄。
- 将中英文用户指南和更新日志纳入 npm 包，便于随包查阅使用说明和版本边界。

### English

- Rename the Chinese navigation, page heading, and guidance to 归档管理, keeping the English name and package identifier unchanged. About now opens directly with a short introduction instead of repeating the plugin title, retaining version, author, license, links, and update checks.
- Rebuild a missing Recycle Bin original only through an explicitly exclusive legacy writer for ordinary sessions; refuse plain create/append and every seeded snapshot whose boundary cannot be preserved before writing. Empty Recycle Bin now validates the complete target list and duplicate IDs before its first purge. The installed package's optional Host peer range explicitly admits the verified `0.1.5-rc.2` Host.

- Reorder workspace actions to Unarchive all, Move all to Recycle Bin, Export all, a separator, and Delete all. About explicitly labels the dynamically loaded current version, distinguishes local metadata failures from online update failures, and offers local metadata reload without inventing a version.

- Fix modern-Host export → permanent delete → import through official create/append/flush/close handles, preserving IDs, titles, events, workspaces, and tags/notes with existing v1-backup support. New ZIP v2 preserves fork boundaries and restores without a parent; legacy writers cannot flatten forks. Recheck recycle/pending-deletion conflicts, release write ownership on failure, and retain uncertain artifacts with an incomplete-rollback error. Add isolated official-backend round-trip and fault-injection tests. Attachment bytes remain excluded.

- Show text-only Restore all and Empty Recycle Bin directly in the header, removing the one-item More menu while preserving fixed header geometry and empty confirmation. Keep row preview icons and use compact Restore/Delete text buttons matching archive rows. Use black/white primary buttons and black selected-tab text/underlines, inverted in dark mode; mute disabled states and retain red destructive actions.
- Workspace/global restoration separately confirms scope, counts, and the Archived destination, skips pending deletions, and reports actual successes/failures with View Archived navigation.
- Add a final About tab and running-version heading, with author, license, guides, feedback, and marketplace links. Bounded public npm checks use a 12-hour automatic cache and short manual cooldown; failures neither claim current status nor block archives. No chat/backup content is sent; Get update only opens the market, without installation or restart.
- Simplify the Archived header to Bulk archive and More. More contains Import backup, Export all, Unarchive all, and Delete all after a separator. Workspace export, unarchive, recycle, and deletion confirm the full workspace name and archive count. Global actions confirm all workspaces' archived chats, excluding trash; filters do not narrow scope.
- Use Delete/Delete all for archive deletion entry points, with concise confirmations naming the chat, workspace, or global scope and explaining the irreversible effect.
- Recognize native React.memo Markdown components. Fully loaded, closed turns initially fold intermediate work with nested reasoning, context provenance, and tool arguments/results; final responses remain outside. Partial or boundaryless logs retain event order. Keep assistant process content left, real user messages right, and preview read-only without a composer or invented usage/timing. Reload the DSH backend for the new projection; browser refresh alone is insufficient.
- Show the recorded effective system prompt when a session resumes or starts a new request series, respecting updates, clears, and replacement boundaries without inventing missing instructions. Recycle Bin deletion confirmations also name the chat or workspace scope, count, and irreversible consequence.
- Fix modern-Host fork content preview/search and Recycle Bin moves through complete read-only inspection. Version 2 protection records preserve exact inherited boundaries while readers retain v1 support. Restore intact originals without rewriting logs; refuse lossy legacy restoration when a fork original is missing. Stop misreporting all read failures as `snapshot-source-missing`.
- Reserve a consistent header action area across tabs to prevent layout jumps. Use compact header buttons and an equal-height action row below the title on narrow layouts, retain Host navigation-icon dimensions with stronger archive strokes, and vertically center workspace titles/folders with their counts and menus.
- Clarify the Chinese Archived tab label. Show full, wrapping workspace titles with enlarged regular-stroke folder icons, using the same subdued secondary text color and normal weight as chat counts. Use open/closed folders instead of separate chevrons while retaining heading-click and keyboard toggling.
- Place a text Delete button after Unarchive on archived chat rows and make both buttons more compact, retaining required deletion confirmation.
- Give system prompts, reasoning, and injected context default-closed preview headings and icons, preferring Host disclosures. The fallback retains hover/focus chevrons and keyboard toggling. Bound prompt bodies with scrolling, keep injected context out of user bubbles, and exclude collapsed content from the preview focus loop.
- Rework Origins & Branches as compact workspace-grouped disclosures: remember workspace folds, initially fold descendants, expand branches beside titles, and disclose timestamps/IDs on demand. Cap deep indentation while retaining cross-workspace source context. Search temporarily reveals matches; expand/collapse all covers current filtered results.
- Read fork titles separately on modern Hosts.
- Use durable deletion tasks for direct archive purge: remove related snapshots first and finish partial cleanup after restart even when the original log is gone.
- Reject archive purge for chats already in the Recycle Bin. Remove pending deletion tasks from actionable archive rows while retaining failure messages.
- Preserve workspace export and workspace-only Recycle Bin moves in the UI.
- Bind Empty Recycle Bin to the exact recycle-record incarnations captured at confirmation. New records cannot expand scope, while changed or uncertain targets are retained for safe failure or retry. Unarchive now distinguishes a missing working directory from a missing workspace; the former preserves the archived copy.
- Read each export source once and apply the importer's complete format, semantic, and size validation before returning a download stream. Import strictly reconciles ZIP central directories, CRCs, and UTF-8 and rejects truncation, encryption, ZIP64, and multi-disk archives. The browser buffers the complete ZIP within a five-minute/320 MiB response-byte limit before initiating download; this is neither a peak-heap bound nor proof of a file saved to disk.
- Reorganize both READMEs, user guides, architecture documents, and the package description around current behavior: action scope, recovery, startup snapshot cleanup versus opt-in retention, and Host/fork limitations. Label v1.3.1 screenshots as historical; they have not been recaptured.
- Include both user guides and the changelog in the npm package so usage instructions and release boundaries ship with it.

## 1.3.3 — 移除历史兼容层并清理遗留快照 / Remove History compatibility and clean legacy snapshots

> 说明更正：此前“不更改运行时行为”的描述不准确。以下补充该版本已有的接口移除和启动清理行为，不表示本次文档整理新增这些行为。
>
> Correction: the former “No runtime behaviour changes” statement was inaccurate. The following records route removal and startup cleanup already present in this release, not new behavior introduced by this documentation update.

### 中文

- 调整保护快照术语；该版本文档中遗留的旧快照保留与恢复说明由本次 Unreleased 文档整理纠正。
- 删除已退役的 `lib/history.js`、`lib/history-restore.js`、`lib/legacy-recycle.js` 及其对应测试文件；相关兼容路由已在 1.3.0 中作为迁移层保留，现全部移除。
- 回收站不再展示未被回收记录引用的旧快照，也不再提供将其恢复为新归档副本的流程；`legacy-recycle.json` 不再作为活动迁移状态使用。
- 启动恢复后重新读取回收目录，保留被引用的保护快照，自动清理其他有效或降级快照及其插件附件副本。此行为独立于默认关闭的回收站自动清理，不删除来源聊天本身。
- 升级前应使用旧版恢复并导出仍需要的旧快照内容，或离线备份完整插件数据目录；不能继续承诺“升级保留全部旧快照”。

### English

- Adjusted protection-snapshot terminology. Stale preservation/recovery claims remaining in those documents are corrected by the current Unreleased documentation revision.
- Removed retired `lib/history.js`, `lib/history-restore.js`, `lib/legacy-recycle.js` and their test files; the compatibility routes they backed were retained as a migration layer in 1.3.0 and are now fully removed.
- The Recycle Bin no longer projects unreferenced old snapshots or restores them as new archived copies; `legacy-recycle.json` is no longer active migration state.
- After startup recovery, reread the recycle catalog, retain referenced protection snapshots, and automatically remove other valid or degraded snapshots and their plugin-owned attachment copies. This is independent of default-off automatic Recycle Bin cleanup and does not delete source chats.
- Before upgrading, recover/export needed old snapshot content with an older supporting release or make an offline backup of the entire plugin-data directory. Preserving every old snapshot across upgrades is no longer promised.

## 1.3.2 — DSH 0.1.5 兼容验证 / DSH 0.1.5 compatibility verification

### 中文

- 将开发验证依赖更新到 `@deepseek-ai/dsh-session@0.1.5-rc.2`，并继续保留对旧版 DSH `>=0.1.0-rc.7` 的运行兼容范围。
- 验证插件在 DeepSeek Harness `0.1.5-rc.2` 下可正常加载；本版不直接删除 Host 的 `session_projcache` 文件，因为宿主尚未提供安全的按会话 eviction API。
- 增加兼容性测试，完整测试套件通过。

### English

- Update the development verification dependency to `@deepseek-ai/dsh-session@0.1.5-rc.2` while retaining the existing runtime compatibility range for DSH `>=0.1.0-rc.7`.
- Verify that the plugin loads on DeepSeek Harness `0.1.5-rc.2`; this release does not unlink Host `session_projcache` files because the Host still exposes no safe per-session eviction API.
- Add a compatibility assertion and keep the full test suite green.

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
