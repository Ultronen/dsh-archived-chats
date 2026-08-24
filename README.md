# dsh-archived-chats

[![npm version](https://img.shields.io/npm/v/dsh-archived-chats)](https://www.npmjs.com/package/dsh-archived-chats)
[![npm downloads](https://img.shields.io/npm/dm/dsh-archived-chats)](https://www.npmjs.com/package/dsh-archived-chats)
[![CI](https://github.com/Ultronen/dsh-archived-chats/actions/workflows/ci.yml/badge.svg)](https://github.com/Ultronen/dsh-archived-chats/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/)

[English](README.en.md) | 中文

> 🔎 **归档不再等于消失。** 直接搜索聊天正文、阅读完整对话和工具调用，然后安全备份、恢复或删除。

> ♻️ **普通删除现在可撤销。** 插件会先创建包含会话与附件的本地保护快照，再移入回收站；只有在回收站中明确选择「永久删除」才会物理清除。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 新增一个本地会话归档中心：找回、搜索、阅读、备份、恢复或删除被归档的会话。

在 DeepSeek Harness 里，聊天一旦归档就会从侧边栏消失，界面中没有任何入口可以再看到它，只有工作区存档（`~/.dsh/storages/workspace.json`）还记得它。这个插件在「设置」中补上一个「已归档的聊天」页面，让所有归档会话都可见、可搜索、可管理。

[插件市场](https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/) · [npm](https://www.npmjs.com/package/dsh-archived-chats) · [版本发布](https://github.com/Ultronen/dsh-archived-chats/releases) · [问题交流](https://github.com/Ultronen/dsh-archived-chats/discussions) · [私密报告漏洞](https://github.com/Ultronen/dsh-archived-chats/security/advisories/new)

<p align="center">
  <a href="assets/screenshots/04-conversation-preview.png"><img src="assets/screenshots/04-conversation-preview.png" width="49%" alt="归档聊天正文搜索与只读对话预览"></a>
  <a href="assets/screenshots/08-recycle-bin.png"><img src="assets/screenshots/08-recycle-bin.png" width="49%" alt="带自动保护快照的归档聊天回收站"></a>
</p>

<p align="center"><sub>无需先取消归档即可搜索和阅读；普通删除先进入带保护快照的回收站。</sub></p>

如果它帮你找回或保护过一次重要对话，欢迎给仓库一个 Star——这能帮助真正需要归档恢复功能的用户更容易发现它。

## 🚀 安装

```sh
dsh plugin --profile web add dsh-archived-chats@latest
```

安装后重启一次 DSH，然后打开 **设置 → 已归档的聊天**。

更新已有安装：

```sh
dsh plugin --profile web update dsh-archived-chats
```

## 兼容性

0.11.0 的完整功能目标是 DeepSeek Harness `0.1.1-rc.2`。较旧宿主仍可使用归档列表，但缺少持久层、附件或运行中会话生命周期能力时，回收操作会返回明确的能力错误，不会猜测宿主内部结构或写入不完整快照。v0.9.0 界面已在 Harness `0.1.0-rc.8` 复核；v0.10.0 搜索、预览和图片读取已在 `0.1.1-rc.2` 复核。

## 预览

以下截图均来自 `0.11.0` 在隔离的真实 DeepSeek Harness `0.1.1-rc.2` 中文浅色 Web profile 中的实际操作，只使用专门创建的演示会话，不包含真实用户数据。

![从会话菜单点击归档](assets/screenshots/01-archive-entry.png)
![已归档的聊天总览](assets/screenshots/02-archived-overview.png)
![聊天正文与工具结果全文搜索](assets/screenshots/03-full-text-search.png)
![归档对话只读预览](assets/screenshots/04-conversation-preview.png)
![标签与备注编辑](assets/screenshots/05-metadata-editor.png)
![按需批量选择](assets/screenshots/06-bulk-selection.png)
![移至回收站确认](assets/screenshots/07-move-to-recycle.png)
![带保护快照的回收站](assets/screenshots/08-recycle-bin.png)
![永久删除二次确认](assets/screenshots/09-permanent-delete.png)

## 使用流程

1. 在 DSH 正常聊天的会话菜单中点击归档。归档只会把会话从侧边栏隐藏，工作区存档仍会保留会话数据。
2. 打开 **设置 → 已归档的聊天**。页面按工作区分组，并在当前浏览器中记住分组的折叠状态。
3. 搜索标题、标签、备注、聊天正文或工具结果；点击行内预览按钮可直接阅读归档对话，无需先取消归档。需要多选时点击 **批量选择** 显示复选框。
4. 点击顶部 **导入备份** 选择本插件导出的 ZIP，预览后确认无冲突会话；点击 **导出备份** 导出当前选中项，未选择时导出全部归档会话。单条会话也可以从行内操作导出。
5. 点击 **取消归档** 将会话放回侧边栏；点击 **移至回收站** 会创建保护快照，可立即点击 **撤销**，也可稍后在 **回收站** 标签恢复。只有回收站中的 **永久删除 / 清空回收站** 会不可撤销地移除原会话和快照。

## 功能

- **完整归档列表**：按工作区（项目）分组并显示每组数量；每个分组都可折叠/展开，状态按浏览器记忆。
- **聊天正文全文搜索**：同一个搜索框同时匹配标题、项目、标签、备注、用户消息、助手回答与工具结果，并在结果行显示命中摘要。
- **原生归档对话预览与轮次导航**：沿用 Harness 会话布局，用户消息靠右、助手消息靠左；以只读方式展示 Markdown、思考过程、工具活动、JSON、代码和可用的已存储图片，并保留可快速跳转的响应式轮次轨道。宿主缺少附件能力时只影响图片，其他预览内容仍可阅读。
- **筛选与排序**：用类型（全部 / 普通会话 / 子代理会话）、项目和标签筛选，并按最新、最早或标题排序。
- **标签与备注**：任意行打开编辑器即可添加最多 8 个标签（每个最多 24 个 Unicode 字符）和一条备注（最多 2,000 个 Unicode 字符）。每行渲染标签小徽章，超过 3 个折叠为 `+N`，标签筛选不区分大小写。
- **存储统计**：概览条显示归档数量、已统计总大小与无法统计的会话数；每行显示各自占用。统计不会跟随符号链接，无法读取的会话目录显示为「无法统计」而非让请求失败。
- **JSON + Markdown 备份**：可导出单条、当前选中项或全部归档会话。每个 ZIP 都包含带版本的清单、用于机器恢复的完整会话 JSON，以及方便阅读的 Markdown 对话稿。
- **预览后导入与恢复**：选择 ZIP 备份后先检查全部会话，默认选中无冲突 ID 的项目，确认后作为已归档聊天恢复。已有 ID 会跳过，绝不会覆盖。
- **紧凑顶部操作**：常用的 **导入备份** / **导出备份** 直接可用，低频危险操作收纳在 **更多**；页面专注于 DSH 归档管理，不常驻来源选择器或冗余菜单。
- **按需多选**：复选框默认隐藏，点击 **批量选择** 后才显示；可逐条选择、选择当前筛选结果或整个项目。选中后可一次导出、取消归档或移至回收站，隐藏在其他筛选结果中的选择不会丢失。
- **取消归档**单个聊天，或从分组的 `⋯` 菜单整组取消——恢复的聊天会立刻回到侧边栏。
- **归档 / 回收站双标签**：回收站按原工作区分组并可独立折叠，显示移入时间、快照大小、附件数和 `trashed` / `degraded` / `purge-pending` 状态；复选框默认隐藏，点击 **批量选择** 后才显示。
- **自动保护快照**：移入回收站前保存完整会话事件和经校验的图片附件字节。每个会话只保留一个当前保护快照；本版不提供按时间的多代保留或会话树恢复。
- **两级恢复**：原会话仍完好时只移除回收标记，不重写持久层；原件丢失时才使用已验证快照和官方写入能力回退恢复，且绝不覆盖同 ID 会话。
- **明确的永久删除**：仅回收站提供永久删除与清空。插件先写入 `purge-pending` 崩溃恢复意图，再删除原会话和保护快照；中途失败会在下次启动重试。
- 适配浅色/深色主题，支持中文和英文界面。

## 回收站、隐私与附件限制

回收目录 `trash.json` 与保护快照位于 `$DSH_HOME/plugin-data/archived-chats/`，全部只保存在本机。快照会逐个读取附件、校验摘要并使用原子发布；不会上传会话或附件。回收站中的预览也使用单独授权范围。

永久删除会删掉该会话的快照附件副本，但 Harness 全局附件存储可能仍因其他会话引用或宿主垃圾回收策略保留相同字节；本插件不声称会立即清理宿主的全局附件库。

## 标签、备注与统计

标签和备注**只保存在本机**的 `$DSH_HOME/plugin-data/archived-chats/metadata.json` 中——不会被上传、同步或发送到任何其他地方。取消归档会保留元数据；物理删除完成后会移除它，而延后或失败的删除会保留它。元数据与统计失败永远不阻塞：即使元数据存储无法读取或某个会话目录无法统计，列表、取消归档和删除仍然可用。

## 导出与备份

导出只会触发本地浏览器下载。单条和批量使用同一种 ZIP 格式：

```text
manifest.json
sessions/001-<安全标题>-<id>/session.json
sessions/001-<安全标题>-<id>/transcript.md
```

`session.json` 是权威备份记录：原样保存 Harness 持久层返回的完整元数据和事件，并附带归档标题、工作区、时间、来源、标签、备注和存储统计。`transcript.md` 是通过 Harness 官方消息投影生成的可读副本。ZIP 路径会净化并处理重名，批量导出逐个会话生成，不会同时把所有会话内容堆进内存。

JSON 会保留附件引用，但**本版不复制附件二进制，也不包含子会话**。需要带完整附件的会话树时，请使用 Harness 官方的 Session log 导出。

## 导入与恢复

导入只接受本插件版本一的导出 ZIP。浏览器会先上传并进行有界校验，然后展示标题、项目、标签、备注、存储信息、ID 冲突、项目不存在警告和附件引用警告；预览不会渲染原始事件或 Markdown。已有会话 ID 会被禁用并跳过，找不到的项目会恢复为未分组。确认令牌 10 分钟后过期且只能使用一次。标签和备注通过现有本地元数据限制恢复，不会恢复附件二进制。宿主没有可用的 Harness 写入能力时返回 `restore-unsupported`，不会写入任何数据。

## 常见问题

<details>
<summary><b>归档会删除聊天吗？</b></summary>

不会。DSH 只是把聊天从侧边栏隐藏，并保留归档会话记录。这个插件提供设置页，用来查找、导出、恢复、取消归档或删除这些记录。

</details>

<details>
<summary><b>导入备份包含已存在的会话 ID 时会怎样？</b></summary>

冲突行会在预览中明确标记，默认禁用并跳过。导入流程绝不会覆盖已有会话。

</details>

<details>
<summary><b>ZIP 备份包含附件吗？</b></summary>

`session.json` 会保留附件引用，但不会包含附件二进制或子会话。需要完整附件会话树时，请使用 Harness 官方 Session log 导出。

</details>

<details>
<summary><b>移入回收站后可以马上恢复吗？</b></summary>

可以。完成移入后的提示会提供 **撤销**，回收站中也可随时恢复。运行中会话会先按宿主生命周期安全停用或停放，然后才提交回收记录；如果宿主能力不足，操作会明确失败并保留归档会话。

</details>

## 实现概览

插件由两部分组成：Host 服务层负责读取本地归档、快照、回收目录和恢复/清除事务，浏览器设置页负责搜索、预览、备份、恢复与明确确认。所有修改都通过受保护的本地路由完成；普通移除只提交回收记录，物理清除仅由回收站的崩溃安全 purge 流程触发。

普通用户需要了解的数据保存、备份限制、删除结果和兼容性说明已列在本 README 中。路由清单、数据流、恢复事务、实时删除生命周期和失败回退等维护者细节请参阅 [架构文档](docs/ARCHITECTURE.md)。

## 开发

```sh
npm test
```

测试套件（`test/*.test.mjs`）覆盖导出记录与真实 ZIP 解包、有界导入校验、恢复事务、元数据存储、统计服务、全文搜索、对话预览，以及宿主+浏览器冒烟测试。测试使用隔离的临时 DSH 主目录和模拟运行时，不会读取或修改真实会话。

## 版本更新记录

### 0.11.0

- 新增 **归档 / 回收站** 双标签、独立批量选择、回收站范围预览、恢复、永久删除和清空。
- 普通删除改为创建完整本地保护快照并移入回收站，成功后可立即 **撤销**。
- 恢复优先使用完好原会话；原件丢失时改用已校验的会话+附件快照，不覆盖同 ID 会话。
- 新增 `purge-pending` 崩溃恢复意图、快照恢复扫描、降级状态，并将旧版 `pending-deletions.json` 安全迁移为可恢复回收记录，不在启动时静默删除。
- **降级警告**：安装 0.11 后如回退到 0.10，旧版不会识别回收目录和保护快照；回退前请先在 0.11 恢复需要的会话并备份 `$DSH_HOME/plugin-data/archived-chats/`。

### 0.10.0

- 新增遵循 Harness 会话布局的归档对话预览：用户消息靠右，助手消息靠左，并支持分页与响应式轮次导航。
- Markdown、思考过程、工具活动、JSON、代码和可用的已存储图片均以只读方式呈现；宿主缺少附件能力时只影响图片，不影响其余对话内容。
- 新增归档聊天正文全文搜索：匹配 Unicode 文本和工具结果，在原有标题/标签/备注筛选上合并命中结果。
- 搜索与预览使用受保护的本地 POST 路由、有界请求、并发 4 的读取、部分失败降级和有上限的 TTL/LRU 内存缓存。

### 0.9.0

- 新增按需显示的批量选择模式：列表默认不展示复选框，点击入口后才显示，完成批量操作后自动退出。
- 将常用 ZIP 备份操作改为直接的 **导入备份 / 导出备份**，危险操作收纳到 **更多**，精简页头布局。
- 移除未提供原生继续能力的跨工具 JSONL 迁移入口，让插件专注于 DSH 已归档聊天管理。
- 在 DeepSeek Harness `0.1.0-rc.8` 真实宿主中复核新控件、备份预览和标题单行布局。

### 0.8.1

- 将中文 README 设为仓库和 npm 包的默认入口，英文文档改为 `README.en.md`。
- 将维护者架构、路由、恢复事务和删除生命周期细节移到 `docs/ARCHITECTURE.md` 与 `docs/ARCHITECTURE.en.md`。
- 安装章节增加快速识别用的 🚀 图标；插件运行时行为保持与 0.8.0 一致。

### 0.8.0

- 新增版本一 ZIP 备份的预览后导入。
- 新增不会覆盖已有会话的冲突安全恢复和事务式写入。
- 新增工作区/附件警告、有界校验、一次性确认令牌和元数据恢复。

### 0.7.0

- 新增单条、选中项和全部归档会话的带版本 JSON + Markdown ZIP 备份。
- 新增流式导出、安全 ZIP 路径、清单记录和官方消息投影生成的 Markdown 对话稿。

### 0.6.0

- 新增标签、备注、存储统计、元数据持久化和归档洞察界面。
- 加固仍在运行会话的删除流程，并为不提供内部生命周期接口的宿主增加回退处理。

### 0.5.1

- 发布面向 DeepSeek Harness `0.1.0-rc.7` 的兼容性修订版本。
- 更新浏览器设置区块，使用 rc.7 的浮层和状态设计令牌。

### 0.5.0

- 新增多选以及批量取消归档/删除流程。
- 改进破坏性操作后的焦点恢复和项目范围选择行为。

### 0.4.0

- 在宿主提供所需生命周期接口时，新增仍在运行会话的原地删除。
- 新增安全的待删队列回退、标题缓存，以及破坏性操作完成后的成功提示。

### 0.3.0

- 首个公开发布版本，提供「已归档的聊天」设置页。
- 新增按工作区分组浏览、标题搜索、类型/项目筛选、取消归档，以及带确认的单条/分组/全部删除。
- 新增 Host 路由、浏览器设置区块，以及用于处理运行中会话的待删队列清扫。

### 0.1.0 和 0.2.0

- 这两个版本从未发布到 npm，也没有对应的仓库标签；`0.3.0` 是首个公开版本。

## 卸载

```sh
dsh plugin --profile web remove dsh-archived-chats
```

卸载不会删除 `$DSH_HOME/plugin-data/archived-chats/` 中的 `metadata.json`、`trash.json`、保护快照或旧版 `pending-deletions.json`，也不会触发永久删除。这是故意的本地数据保护；请先恢复或备份需要的会话，再手动处理该目录。

## License

MIT
