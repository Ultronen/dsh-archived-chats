# 架构与维护者说明

[English](ARCHITECTURE.en.md) | 中文

本文面向维护者和需要理解数据行为的开发者。普通用户请先阅读仓库根目录的 README.md；其中的安装、使用、隐私和限制说明优先于本文。

## 架构边界

插件由 Host 服务层和浏览器客户端两部分组成：

- Host 服务层位于 lib/index.js，运行在 DSH Web 宿主中，读取工作区注册表和会话持久层，并提供本地 HTTP 路由。
- 浏览器客户端位于 lib/client.js，通过 settings.section 注册「已归档的聊天」设置页，负责展示状态和发起操作。
- 纯领域逻辑拆分在 lib/export.js、lib/import.js、lib/restore.js、lib/metadata.js、lib/search.js 和 lib/stats.js 中，便于独立测试。

浏览器不直接访问会话文件。所有读取和写入都经 Host 路由完成。

## Host 路由

当前注册的路由：

~~~text
GET  /plugins/dsh-archived-chats/state
GET  /plugins/dsh-archived-chats/stats
POST /plugins/dsh-archived-chats/preview
POST /plugins/dsh-archived-chats/preview/image
POST /plugins/dsh-archived-chats/search
POST /plugins/dsh-archived-chats/export
POST /plugins/dsh-archived-chats/import/inspect
POST /plugins/dsh-archived-chats/import/restore
POST /plugins/dsh-archived-chats/metadata
POST /plugins/dsh-archived-chats/unarchive
POST /plugins/dsh-archived-chats/unarchive-all
POST /plugins/dsh-archived-chats/delete
POST /plugins/dsh-archived-chats/delete-all
~~~

所有修改路由以及会返回对话内容的 preview、preview/image、search 路由都要求 `x-dsh-archived-chats: 1` 请求头。preview/image 和 export 都是只读操作，不修改插件或 Harness 状态。取消归档通过 workspace registry 自身的状态写入路径完成，并向已连接客户端发送 archived-sessions-changed 更新。

## 状态和本地数据

state 路由把归档会话、工作区、标签、备注和 metadataUpdatedAt 组合成浏览器列表。标签和备注只写入：

~~~text
$DSH_HOME/plugin-data/archived-chats/metadata.json
~~~

元数据文件带版本号，写入通过队列串行化，并用临时文件重命名替换。无法解析或不支持的版本不会被覆盖。

stats 路由以并发 4 测量会话目录，跳过符号链接，结果缓存 30 秒。测量失败只标记当前行不可用，不阻塞列表和其他操作；删除会使对应缓存失效。

## 预览和全文搜索

preview 和 search 只接受当前可见归档 ID，等待删除或已取消归档的会话不可读。lib/search.js 使用 Harness 的 append-origin 消息投影，不会将 replacement 副本重复索引。用户、助手、思考、工具调用与工具结果均可搜索，预览窗口以分页方式返回有界段落和净化后的图片描述符。

preview/image 的授权顺序固定为：先验证 POST 和 `x-dsh-archived-chats: 1`，再有界解析 `sessionId` 与 `attachmentId`；随后重新确认会话仍在当前可见归档集合中，从该会话的规范投影中查找完全匹配的图片描述符，最后才通过可选的 `attachments.readImage` 服务读取并以 `no-store`、`nosniff` 响应返回字节。跨会话、非归档或不在投影中的引用均在读取附件前拒绝，错误响应不回显文件路径。宿主没有附件读取能力时返回 `preview-image-unsupported`；这只降级图片，不阻塞文本、Markdown、思考、工具、JSON 或代码预览。

跨会话搜索的持久层读取并发上限为 4；单个会话失败会记入 skipped，其他命中仍正常返回。规范投影使用 30 秒 TTL、64 会话 LRU 和单会话最大缓存字符数保护内存；超大会话仍可搜索，但不会常驻缓存。取消归档、删除和恢复会使相关缓存失效。

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

## 删除生命周期

删除普通冷会话时，插件确认物理位置后移除会话日志、工作区记录和注册表索引，并清理元数据和统计缓存。

删除仍在后台运行的会话时，优先尝试官方生命周期顺序：

~~~text
cancel(disposed)
  -> whenIdle
  -> flush
  -> agent.scope.dispose()
  -> detach agents and sessions
  -> retire persistence writer
  -> remove session files
~~~

这些是内部宿主接口，全部通过能力探测调用。宿主缺少任一必要接口时，插件不会强行操作内部对象，而是把 ID 写入：

~~~text
$DSH_HOME/plugin-data/archived-chats/pending-deletions.json
~~~

待删会话保持归档并从列表隐藏，下次启动清扫队列。原地删除同样使用队列作为崩溃保护：删除前登记，文件确认移除后清除。

## 浏览器客户端

client.js 注册 order 30 的 settings.section，并使用 DSH rc.7 的浮层、状态和设计令牌。页面状态包括：

- 归档列表和工作区分组。
- 搜索、类型/项目/标签筛选和排序。
- 标签备注编辑器。
- 选中项批量导出、取消归档和删除。
- 导入预览、冲突禁用和恢复结果。
- 响应式设置页标记和侧边栏刷新注入面。

预览优先使用 Harness 公开导出的 `MarkdownText`、`DisclosureRow` 和 `JsonBlock`；某个公开原语不可用时，只把对应内容降级为转义的纯文本、原生 `details`/`summary` 或 `pre`，不调用私有聊天渲染器。工具结果仅在其 `toolCallId` 与更早工具调用的 `callId` 精确匹配时折叠进该调用，匹配按时间顺序消费；未匹配结果保留为独立条目，错误状态使用语义错误令牌。图片由受保护路由读取为 Blob URL，离开视口前可按需加载，预览关闭或图片节点卸载时会中止读取并调用 `URL.revokeObjectURL`。

轮次轨道保留在预览内：桌面位于消息流左侧，跳转后随消息流滚动并用 `aria-current` 标出当前轮次；宽度不超过 640px 时轨道移到消息流上方并水平滚动，用户气泡仍保留可用宽度。轨道不会被替换为宿主私有导航组件。

浏览器操作不会直接改变本地文件；操作完成后以 Host 返回的状态作为新的列表基线。

## 安全和失败策略

- 所有状态变更路由都要求 POST 和 guard header。
- 导入限制 ZIP 大小、条目数量、路径格式、版本和 JSON 结构，拒绝遍历、重复和原型污染字段。
- 删除只在物理位置可确认时报告成功；无法确认时保留会话和权威元数据。
- 元数据或统计服务不可用时，列表、取消归档和删除仍保持可用。
- 未知宿主能力必须降级或返回明确错误，不得猜测内部对象结构。

## 兼容性和测试

自动化兼容性基线是 DeepSeek Harness 0.1.0-rc.7；v0.9.0 界面已在 rc.8 宿主上复核。v0.10.0 的正文搜索与对话预览在发布前仍需真实宿主检查。宿主插槽、设计令牌或会话内部接口变化时，应先运行冒烟测试，再做真实宿主检查。

测试覆盖：

- export.js 的记录、转录和 ZIP 流。
- import.js 的有界校验和拒绝路径。
- restore.js 的事务提交、回滚和能力缺失。
- metadata.js 的版本、并发和原子写入。
- stats.js 的符号链接、缓存和并发限制。
- search.js 的消息投影、Unicode 搜索、分页、部分失败与 TTL/LRU 缓存。
- Host 路由和浏览器设置页的冒烟及响应式行为。

运行：

~~~sh
npm test
npm pack --dry-run --json
~~~
