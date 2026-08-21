# 架构与维护者说明

[English](ARCHITECTURE.en.md) | 中文

本文面向维护者和需要理解数据行为的开发者。普通用户请先阅读仓库根目录的 README.md；其中的安装、使用、隐私和限制说明优先于本文。

## 架构边界

插件由 Host 服务层和浏览器客户端两部分组成：

- Host 服务层位于 lib/index.js，运行在 DSH Web 宿主中，读取工作区注册表和会话持久层，并提供本地 HTTP 路由。
- 浏览器客户端位于 lib/client.js，通过 settings.section 注册「已归档的聊天」设置页，负责展示状态和发起操作。
- 纯领域逻辑拆分在 lib/export.js、lib/import.js、lib/restore.js、lib/metadata.js、lib/stats.js 和 lib/interop/{format,report,codex,claude}.js 中，便于独立测试。

浏览器不直接访问会话文件。所有读取和写入都经 Host 路由完成。

## Host 路由

当前注册的路由：

~~~text
GET  /plugins/dsh-archived-chats/state
GET  /plugins/dsh-archived-chats/stats
POST /plugins/dsh-archived-chats/export
POST /plugins/dsh-archived-chats/import/inspect
POST /plugins/dsh-archived-chats/import/restore
POST /plugins/dsh-archived-chats/interop/inspect
POST /plugins/dsh-archived-chats/interop/export
POST /plugins/dsh-archived-chats/metadata
POST /plugins/dsh-archived-chats/unarchive
POST /plugins/dsh-archived-chats/unarchive-all
POST /plugins/dsh-archived-chats/delete
POST /plugins/dsh-archived-chats/delete-all
~~~

所有修改路由以及浏览器发起的外部格式导入/导出都要求 x-dsh-archived-chats: 1 请求头。导出是只读操作，不修改插件或 Harness 状态。取消归档通过 workspace registry 自身的状态写入路径完成，并向已连接客户端发送 archived-sessions-changed 更新。

## 状态和本地数据

state 路由把归档会话、工作区、标签、备注和 metadataUpdatedAt 组合成浏览器列表。标签和备注只写入：

~~~text
$DSH_HOME/plugin-data/archived-chats/metadata.json
~~~

元数据文件带版本号，写入通过队列串行化，并用临时文件重命名替换。无法解析或不支持的版本不会被覆盖。

stats 路由以并发 4 测量会话目录，跳过符号链接，结果缓存 30 秒。测量失败只标记当前行不可用，不阻塞列表和其他操作；删除会使对应缓存失效。

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

## 外部工具互操作流程

互操作边界由四个纯逻辑模块组成：format.js 定义并校验交换模型，report.js 汇总损失、警告与冲突，codex.js 和 claude.js 负责各自 JSONL 的读取与导出投影。规范模型固定为 format: "dsh-interop"、formatVersion: 1，并带 source、sourceVersion、sessions 和 SHA-256 摘要；会话投影包含 ID、标题、工作区、消息、附件引用、损失和来源。Harness 原始事件仍是权威数据，交换模型和目标 JSONL 都只是适配投影。

外部导入路径：

1. 浏览器把来源和单个 JSONL 以 multipart 上传到 interop/inspect，并发送 guard header。
2. Host 在 8 MiB 请求上限内读取，适配器继续限制行数、单行字节、嵌套深度和集合规模；未知或畸形记录进入报告，不写日志正文。
3. Host 只返回净化后的会话摘要、报告和短期令牌；浏览器显示保真度、损失、警告和现有 ID 冲突。
4. 确认后继续调用既有 import/restore；互操作会话先转换为有效 Harness 恢复记录，再走同一个冲突检查、能力探测、事务提交和回滚路径。

外部导出路径：

1. 浏览器选择目标和已归档 ID，先向受保护的 interop/export 提交 preview=1。
2. Host 重新确认每个 ID 仍是可见归档会话，逐条读取权威持久层记录并投影，返回不含消息正文的会话数、损失类别/计数和警告；诊断按类别聚合并有界。
3. 用户检查报告后，浏览器向同一路由提交下载请求，并以 Blob 保存 Codex 或 Claude Code JSONL。输出明确定位为可读迁移或交接稿；目前不承诺目标工具原生 resume，也不包含附件二进制。

检查与导出都不修改外部源文件、目标工具目录或 DSH 归档记录。适配器不读取凭据、MCP 密钥或工具本地配置，Host 日志不得包含原始消息或本地路径。

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
- Codex / Claude Code 来源与目标选择、JSONL 文件控件、转换报告，以及外部下载限制提示。
- 响应式设置页标记和侧边栏刷新注入面。

浏览器操作不会直接改变本地文件；操作完成后以 Host 返回的状态作为新的列表基线。

## 安全和失败策略

- 所有状态变更路由都要求 POST 和 guard header。
- 导入限制 ZIP 大小、条目数量、路径格式、版本和 JSON 结构，拒绝遍历、重复和原型污染字段。
- 外部 JSONL 导入限制总字节、行数、单行大小、嵌套深度和集合规模；未知或畸形记录进入预览报告，检查阶段保持只读。
- 互操作附件路径必须是安全相对路径，只保留引用；不得复制附件二进制、凭据、密钥或外部配置，也不得把原始消息写入日志。
- 外部导入继续执行 ID 冲突检查且绝不覆盖；外部导出只读取当前可见的归档 ID，不修改源会话或目标工具状态。
- 删除只在物理位置可确认时报告成功；无法确认时保留会话和权威元数据。
- 元数据或统计服务不可用时，列表、取消归档和删除仍保持可用。
- 未知宿主能力必须降级或返回明确错误，不得猜测内部对象结构。

## 兼容性和测试

兼容性基线是 DeepSeek Harness 0.1.0-rc.7，并在 rc.8 宿主上做过真实页面复核。宿主插槽、设计令牌或会话内部接口变化时，应先运行冒烟测试，再做真实宿主检查。

测试覆盖：

- export.js 的记录、转录和 ZIP 流。
- import.js 的有界校验和拒绝路径。
- restore.js 的事务提交、回滚和能力缺失。
- metadata.js 的版本、并发和原子写入。
- stats.js 的符号链接、缓存和并发限制。
- interop/format.js 的版本、SHA-256、边界和原型污染拒绝。
- Codex / Claude Code 最小、多轮、工具调用、异常行、附件引用、目标投影和往返 fixtures。
- 外部互操作路由的 guard、请求上限、来源/目标拒绝、只读预览和事务恢复复用。
- Host 路由和浏览器设置页的冒烟及响应式行为。

运行：

~~~sh
npm test
npm pack --dry-run --json
~~~
