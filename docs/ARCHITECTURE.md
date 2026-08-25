# 架构与维护者说明

[English](ARCHITECTURE.en.md) | 中文

本文面向维护者和需要理解数据行为的开发者。普通用户请先阅读仓库根目录的 README.md；其中的安装、使用、隐私和限制说明优先于本文。

## 架构边界

插件由 Host 服务层和浏览器客户端两部分组成：

- Host 服务层位于 lib/index.js，运行在 DSH Web 宿主中，读取工作区注册表和会话持久层，并提供本地 HTTP 路由。
- 浏览器客户端位于 lib/client.js，通过 settings.section 注册「会话档案」设置页，负责展示状态和发起操作。
- 纯领域逻辑拆分在 lib/export.js、lib/import.js、lib/restore.js、lib/metadata.js、lib/search.js、lib/stats.js、lib/insights.js、lib/retention.js、lib/retention-service.js 和 lib/lineage.js 中。lib/history.js 负责历史抓取、安全清单和预览授权，lib/history-restore.js 负责单次确认的恢复为副本事务。lib/trash.js 负责版本化回收目录，lib/snapshot.js 负责可验证快照，lib/recycle.js 组合回收生命周期。

浏览器不直接访问会话文件。所有读取和写入都经 Host 路由完成。

## Host 路由

当前注册的路由：

~~~text
GET  /plugins/dsh-archived-chats/state
GET  /plugins/dsh-archived-chats/stats
GET  /plugins/dsh-archived-chats/insights
POST /plugins/dsh-archived-chats/retention/policy
POST /plugins/dsh-archived-chats/retention/preview
POST /plugins/dsh-archived-chats/retention/apply
GET  /plugins/dsh-archived-chats/lineage
POST /plugins/dsh-archived-chats/history/capture
GET  /plugins/dsh-archived-chats/history
POST /plugins/dsh-archived-chats/history/preview
POST /plugins/dsh-archived-chats/history/preview/image
POST /plugins/dsh-archived-chats/history/restore/preview
POST /plugins/dsh-archived-chats/history/restore
POST /plugins/dsh-archived-chats/preview
POST /plugins/dsh-archived-chats/preview/image
POST /plugins/dsh-archived-chats/search
POST /plugins/dsh-archived-chats/export
POST /plugins/dsh-archived-chats/import/inspect
POST /plugins/dsh-archived-chats/import/restore
POST /plugins/dsh-archived-chats/metadata
GET  /plugins/dsh-archived-chats/trash
POST /plugins/dsh-archived-chats/trash/restore
POST /plugins/dsh-archived-chats/trash/purge
POST /plugins/dsh-archived-chats/trash/empty
POST /plugins/dsh-archived-chats/unarchive
POST /plugins/dsh-archived-chats/unarchive-all
POST /plugins/dsh-archived-chats/delete
POST /plugins/dsh-archived-chats/delete-all
~~~

所有修改路由以及会返回对话内容的 preview、preview/image、search、history/preview 和 history/preview/image 路由都要求 `x-dsh-archived-chats: 1` 请求头。`GET /history` 只返回有界安全清单；历史图片只在快照身份与完整描述符同时匹配时返回。

## 状态和本地数据

state 路由把归档会话、工作区、标签、备注和 metadataUpdatedAt 组合成浏览器列表。标签和备注只写入：

~~~text
$DSH_HOME/plugin-data/archived-chats/metadata.json
$DSH_HOME/plugin-data/archived-chats/trash.json
$DSH_HOME/plugin-data/archived-chats/retention.json
$DSH_HOME/plugin-data/archived-chats/snapshots/
~~~

元数据和回收目录均带版本号，写入通过队列串行化并用临时文件原子替换。无法解析或不支持的 `trash.json` 保留原始字节、不隐藏任何归档会话，并禁用回收修改。

stats 路由以并发 4 测量会话目录，跳过符号链接，结果缓存 30 秒。测量失败只标记当前行不可用，不阻塞列表和其他操作；删除会使对应缓存失效。

insights 将会话目录测量与流式校验的快照清单分账，重复附件只按快照内已验证 SHA-256 统计；浏览器只在摘要卡片中显示总量，会话目录和快照明细通过有界、可搜索弹窗按需呈现。retention.json 使用精确 version 1 schema；保存策略不执行清理。preview 生成五分钟、单次使用的 token/nonce，apply 在生命周期队列内重检候选，回收站候选仍委托 recycle purge。lineage 只用持久化 parentSession 建树，最多 5,000 个真实节点，不修改会话头；对已经进入聚焦关系树但没有安全标题的活动来源节点，最多按需读取 100 个标题事件。

## 预览和全文搜索

preview 默认只接受当前可见归档 ID；显式 `scope: "trash"` 时仅接受回收目录中的 ID。search 只搜索可见归档。lib/search.js 使用 Harness 的 append-origin 消息投影，不会将 replacement 副本重复索引。用户、助手、思考、工具调用与工具结果均可搜索，预览窗口以分页方式返回有界段落和净化后的图片描述符。

preview/image 的授权顺序固定为：先验证 POST 和 `x-dsh-archived-chats: 1`，再有界解析 `sessionId` 与 `attachmentId`；随后确认会话仍在当前可见归档集合中，从该会话的规范投影中查找完全匹配的图片描述符，最后才通过可选的 `attachments.readImage` 服务读取。preview 和 preview/image 都会在异步读取完成后、响应发送前再次检查可见归档状态，避免并发取消归档或删除泄露旧内容。图片字节以 `no-store`、`nosniff` 返回；跨会话、非归档或不在投影中的引用均会被拒绝，错误响应不回显文件路径。宿主没有附件读取能力时返回 `preview-image-unsupported`；这只降级图片，不阻塞文本、Markdown、思考、工具、JSON 或代码预览。

跨会话搜索的持久层读取并发上限为 4；单个会话失败会记入 skipped，其他命中仍正常返回。规范投影使用 30 秒 TTL、64 会话 LRU 和单会话最大缓存字符数保护内存；超大会话仍可搜索，但不会常驻缓存。取消归档、删除和恢复会使相关缓存失效。

## 历史版本与恢复为副本

`history/capture` 只在浏览器包装的公开 `workspaces.archiveSession` 成功后调用。Host 进入与回收/保留共用的生命周期队列，重新检查归档所有权与回收状态，为仍存活的会话要求稳定 Host 修订，并复用同一非空修订的健康快照。插件不扫描无关活动会话，不在启动、定时器或后台自动抓取。

`history.js` 将已发布快照分组为 `archived` / `recycled` / `history-only`，单次最多检查 5,000 个快照目录，共用进行中请求并缓存已完成结果 30 秒。清单只含安全标题/工作区标题、时间、大小、附件数和保护状态；降级项只显示快照 ID 与稳定代码。分页预览与图片读取每次都重新验证快照、摘要和完整描述符，不返回路径或原始记录。

`history-restore.js` 先完整验证快照，用 Host 生成新会话 ID，再签发五分钟、单次使用的 token/nonce。确认时先消费凭据并重验 manifest；然后依次创建持久会话、重写会话/附件身份、附加事件、恢复工作区和元数据，最后才写入归档注册表。任一插件控制的边界失败都按逆序回滚；来源会话与快照始终不变，也不声称删除了 Host 全局附件对象。

## 导出流程

export 路由接收有界的原生表单请求，由 export.js 生成版本化 ZIP：

~~~text
manifest.json
sessions/001-safe-title-id/session.json
sessions/001-safe-title-id/transcript.md
~~~

session.json 保留持久层返回的完整元数据和事件，并附加归档标题、工作区、时间、来源、标签、备注和存储信息。transcript.md 使用 Harness 的规范消息投影生成。

ZIP 路径会清理遍历字符并处理重名。批量导出按会话顺序逐个检查和写入，最多保留一个已检查的会话载荷。附件引用可保留在 JSON 中，但附件二进制和子会话不属于版本一格式。

## 导入和恢复流程

import/inspect 只接受本插件版本一导出的 ZIP。Host 会有界读取和校验 manifest、路径、版本、会话记录及跨文件一致性，然后生成预览：

1. 浏览器上传 ZIP，Host 返回会话摘要、版本、大小和警告。
2. 已存在的会话 ID 标记为冲突并默认取消选择。
3. 未解析的工作区和附件引用只显示警告，不伪造数据。
4. 用户确认后，浏览器提交一次性令牌和选中的非冲突 ID。
5. restore.js 通过能力探测的适配器写入会话、元数据和归档状态。
6. 任一步骤失败都回滚暂存数据，不覆盖已有会话。

确认令牌短期有效且只能使用一次。宿主不支持写入能力时返回 restore-unsupported，不执行任何写入。

## 回收与保护快照生命周期

`trash.json` 的合法状态只有 `trashed`、`purge-pending`、`degraded`。合法转换为 `missing -> trashed`、`trashed/degraded -> purge-pending`，以及任一现有状态在事务成功后移除。`purge-pending` 不得恢复。

保护快照格式是 `dsh-archived-chats/snapshot` v1，会话载荷是 `dsh-archived-chats/snapshot-session` v1。每个回收记录只引用一个活跃快照，重复恢复/回收产生的旧有效快照保留为历史，直到明确应用保留策略或永久删除。精确上限为：manifest 4 MiB、session JSON 512 MiB、10,000 个附件、单附件 32 MiB、总计 8 GiB。

移入顺序为：校验归档所有权 → 处置/停放运行中会话 → 捕获并验证快照 → 再次校验所有权 → 原子写入 `trashed` 记录 → 使缓存失效。普通移入不删除持久层文件。

恢复先检查同 ID 冲突。原会话完好时只恢复归档可见性并移除回收记录，不重写持久层，保护快照保留为历史；原件丢失时先完成所有校验和附件身份重发，然后仅通过公开 `create` / `append` / `saveImage` 能力写入。失败会回滚新建件并保留回收记录。

永久删除在任何物理写入前持久化 `purge-pending`，再删除原会话、该来源的全部已验证快照和回收记录。启动恢复仅重试 `purge-pending`，从不删除普通 `trashed`。旧 `pending-deletions.json` 是严格、只读的迁移输入：每个仍归档的 ID 都转成可恢复回收记录，绝不因旧标记在启动时直接删除。

## 浏览器客户端

client.js 注册 order 30 的 settings.section，并使用 DSH rc.7 的浮层、状态和设计令牌。页面状态包括：

- `shell.overlay` 中的归档成功提示：插件在 effect 生命周期内包装公开的 `workspaces.archiveSession`，只在原调用成功后发起历史抓取。抓取进行时暂停 3 秒关闭计时，成功后恢复，失败时显示不回滚归档的重试保存；查看与撤销继续可用。
- 归档列表和工作区分组。
- 搜索、类型/项目/标签筛选和排序。
- 标签备注编辑器。
- 选中项批量导出、取消归档和移入回收站。
- 归档、历史版本、回收站、空间与策略、来源与分支五标签。历史首次激活才请求安全清单，会话组默认折叠；预览复用对话弹窗并显示快照时间，恢复确认的初始焦点位于取消，token/nonce 不进入渲染树。其他空间与关系视图保留按需加载、有界弹窗和只读关系投影。
- 导入预览、冲突禁用和恢复结果。
- 响应式设置页标记和侧边栏刷新注入面。

预览优先使用 Harness 公开导出的 `MarkdownText`、`DisclosureRow` 和 `JsonBlock`；某个公开原语不可用时，只把对应内容降级为转义的纯文本、原生 `details`/`summary` 或 `pre`，不调用私有聊天渲染器。工具结果仅在其 `toolCallId` 与更早工具调用的 `callId` 精确匹配时折叠进该调用，匹配按时间顺序消费；未匹配结果保留为独立条目，错误状态使用语义错误令牌。图片由受保护路由读取为 Blob URL，离开视口前可按需加载，预览关闭或图片节点卸载时会中止读取并调用 `URL.revokeObjectURL`。

轮次轨道保留在预览内：桌面位于消息流左侧，跳转后随消息流滚动并用 `aria-current` 标出当前轮次；宽度不超过 640px 时轨道移到消息流上方并水平滚动，用户气泡仍保留可用宽度。轨道不会被替换为宿主私有导航组件。

浏览器操作不会直接改变本地文件；操作完成后以 Host 返回的状态作为新的列表基线。关闭预览或切换到另一条会话会取消未完成的预览请求；客户端同时使用请求序号忽略迟到响应，避免已关闭的弹窗重新出现或旧会话覆盖新会话。

## 安全和失败策略

- 所有状态变更路由都要求 POST 和 guard header。
- 历史响应不包含工作区/快照/附件路径、原始事件、备注或确认 token；日志只记 ID 和稳定代码。
- 导入限制 ZIP 大小、条目数量、路径格式、版本和 JSON 结构，拒绝遍历、重复和原型污染字段。
- 普通删除从不调用物理清除；仅已提交回收记录可进入 purge。
- 快照和回收文件使用 `0600`，目录使用 `0700`，发布为临时写入、sync、原子 rename。
- 物理 purge 删除快照副本，但不承诺立即清理 Harness 全局附件库中仍被其他会话引用的字节。
- 未知宿主能力必须降级或返回明确错误，不得猜测内部对象结构。

## 兼容性和测试

1.0.0 已在 DeepSeek Harness 0.1.1-rc.2 Web profile 中验证加载、28 路由注册、安全空历史清单和能力降级。该 Host 未公开导入/历史恢复所需 writer，因此以 `501 restore-unsupported` 无写入失败。0.12 使用相同 version 1 manifest，能校验、保留和清理 1.0 快照，但不显示历史页或恢复为副本；降级前应备份整个插件数据目录。

测试覆盖：

- export.js 的记录、转录和 ZIP 流。
- import.js 的有界校验和拒绝路径。
- restore.js 的事务提交、回滚和能力缺失。
- metadata.js 的版本、并发和原子写入。
- stats.js 的符号链接、缓存和并发限制。
- search.js 的消息投影、Unicode 搜索、分页、部分失败与 TTL/LRU 缓存。
- trash.js、snapshot.js 和 recycle.js 的格式验证、并发、恢复、回滚、崩溃意图和旧标记迁移。
- insights.js、retention.js、retention-service.js 和 lineage.js 的可信分账、策略边界、短效授权、重检和有界图投影。
- history.js 和 history-restore.js 的修订去重、缓存失效、快照授权、单次确认、事务回滚与来源不变式。
- Host 路由和浏览器设置页的冒烟及响应式行为。

运行：

~~~sh
npm test
npm pack --dry-run --json
~~~
