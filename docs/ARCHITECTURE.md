# 架构与维护者说明

[English](ARCHITECTURE.en.md) · 中文 · [用户指南](USER_GUIDE.zh-CN.md)

本文跟随 `main` 分支，功能对应 1.4.2，该版本改用 `fflate` 生成导出 ZIP；版本变更见[更新日志](../CHANGELOG.md)。运行时代码是接口与行为的依据；用户操作说明与本文应保持一致。

## 产品边界与模块

插件补充已归档聊天管理页面，不替代 DSH 主会话区。浏览器仅通过 Host 路由读写数据；会话文件仍由 Host 持久层管理。

| 模块（均位于 `lib/`） | 职责 |
| --- | --- |
| `index.js` | Host 能力解析、路由、归档可见性、生命周期队列及物理删除 |
| `client.js` | 设置页、五个主视图、弹窗、原生归档提示与请求状态 |
| `about.js` | 本地插件信息、受限的公开版本查询与运行期缓存 |
| `persistence-compat.js` | 旧版 inspect 与新版只读句柄适配，独立标题读取 |
| `workspace-bulk-archive.js` | 工作区归档候选、短效确认、执行重检 |
| `trash.js`、`snapshot.js`、`recycle.js` | 回收目录、可验证保护快照、回收／恢复／永久删除 |
| `export.js`、`import.js`、`restore.js` | ZIP 导出、有界导入验证、事务恢复 |
| `metadata.js`、`durable.js` | 标签备注、串行原子写入与持久化操作 |
| `search.js`、`stats.js`、`insights.js` | 消息投影与搜索、会话目录测量、空间分账 |
| `retention.js`、`retention-service.js`、`auto-retention.js` | 策略、确认与重检、启动恢复及定时任务 |
| `lineage.js` | 只读来源、分叉与子代理关系投影 |

界面仅通过工作区操作移入回收站；单条可永久删除或取消归档。保留工作区导出与全部导出。后端兼容接口可接收单条 ID，不代表界面提供单条移入入口。

独立 History、旧快照恢复副本和预览清理界面已移除。`history.js`、`history-restore.js`、`legacy-recycle.js` 不是当前模块。

## Host 路由

```text
GET  /plugins/dsh-archived-chats/about
POST /plugins/dsh-archived-chats/about/check-updates
GET  /plugins/dsh-archived-chats/state
GET  /plugins/dsh-archived-chats/stats
GET  /plugins/dsh-archived-chats/insights
GET  /plugins/dsh-archived-chats/lineage
GET  /plugins/dsh-archived-chats/workspace-archive/workspaces
POST /plugins/dsh-archived-chats/workspace-archive/preview
POST /plugins/dsh-archived-chats/workspace-archive/apply
POST /plugins/dsh-archived-chats/retention/policy/preview
POST /plugins/dsh-archived-chats/retention/policy
POST /plugins/dsh-archived-chats/retention/preview
POST /plugins/dsh-archived-chats/retention/apply
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
```

除导出外，上述 POST 路由要求 `x-dsh-archived-chats: 1`。读取对话内容的预览、图片、搜索也使用受保护 POST。导出单独接受有界原生表单，不使用此 header 守卫，并检查所请求会话的当前归档可见性；其余路由按各自限定解析载荷。

所有 `/history` 和 `/history/*` 路由已移除，不再承诺返回旧的 410 响应。`/retention/preview` 和 `/retention/apply` 仍作为手动兼容 API 存在，但客户端不提供独立预览清理入口；不要混淆接口兼容与产品页面。

`/delete` 接收 `sessionId`，`/delete-all` 接收 `sessionIds`。默认调用回收服务 `move`；仅 `permanent: true` 调用 `deleteArchived`。归档直接永久删除返回 `{ deleted, pending, failed }`；全部失败且没有删除成功项时为 HTTP 409，部分成功仍可返回 200，调用方必须检查结果数组，不能只看状态码。

回收接口分别调用 `restore`、`purge`、`empty`。empty 要求确认时捕获的精确 `trashed`／`degraded` 记录实例，包括回收与快照身份。服务只清理这些目标：之后新增的记录被排除，已变更目标失败，不扩大或重算范围。已有 `purge-pending` 任务只由独立重试流程续作。规范的独占目录检查只授权删除会话所有的目标，不是广义文件系统删除保证；结果不确定时保留持久记录。

## 状态、所有权与持久化

插件状态根目录是 `$DSH_HOME/plugin-data/archived-chats/`：

| 路径 | 当前用途 |
| --- | --- |
| `metadata.json` | 版本化标签备注 |
| `trash.json` | 回收和永久删除意图的权威目录 |
| `retention.json` | version 2 策略，含显式 `recycleAutoDelete` |
| `snapshots/` | 保护快照、暂存和恢复所需文件 |
| `pending-deletions.json` | 旧删除标记兼容与迁移输入 |
| `legacy-recycle.json` | 旧版遗留，新版不再读取或投影 |

Host 的归档注册表决定归档归属；正常可见归档列表排除回收目录中的全部 ID，包括待删除任务。`trash.json` 无法解析或版本不支持时保留原字节，列表标为未经核对，修改操作 fail closed，不推断回收状态。

元数据与回收写入串行化，通过临时文件和原子 rename 发布。生命周期队列把归档、导入恢复、回收和永久删除的关键重检与提交串行化。文件使用 `0600`，目录使用 `0700`；同步文件及父目录，不支持目录 fsync 的平台安全降级。Windows 上对瞬时 `EPERM`、`EACCES`、`EBUSY` 做有界重试，路径包含判断使用平台路径规则。

## 工作区批量归档

客户端注册 `settings.section` 和 `shell.overlay`，在 **Settings → Archive Management / 设置 → 归档管理** 内维护工作区选择器，不依赖工作区菜单扩展或共享客户端 store。

1. 列出至少有一条符合条件聊天的工作区。
2. 浏览器为每个选中工作区分别请求 preview；每个 preview 最多绑定 2,000 个有序 ID，凭据 token/nonce 有效 5 分钟且仅用一次。
3. 跳过准备期间变空的工作区，显示一次汇总确认；全部变空则返回更新后的选择器。
4. 按选择顺序 apply 各工作区凭据，汇总结果；后续工作区不会因前一个部分失败而自动停止。

apply 只接受凭据，不接受调用方增补会话 ID。每条执行前在生命周期队列内检查工作区归属、归档状态、agent 状态及真实 `turn/start`。空白为 `session-empty`，内容无法确认则 `session-unavailable`；没有 agent 状态的旧 Host 会保守跳过已加载会话。候选内容检查最多并发 8 条。

调用公开 `workspaceRegistry.archiveSession()` 时保留 receiver；不停止活动聊天、不移动工作区归属、不改目录、不抓取历史快照。缺少该能力返回 `workspace-archive-unsupported`。

## 持久层兼容与分叉标题

带原生 `inspect` 的持久层对象保持原样。新版 `list()` 快照与 `open(id, 'read')` 句柄适配为内部 `list`、`listSnapshots`、`inspect`、`readSession` 和 `readTitle`；句柄从偏移 0 读取，并在成功或失败后关闭。

`readTitle` 允许读取继承事件，但只返回最后一个非空白 `session/title` 字符串，不向备份调用者暴露事件载荷。归档列表优先调用它，解决分叉标题被严格检查阻断的问题。

`readSession` 返回 `{ meta, events, inheritedEventCount }`，用于正文预览／搜索及保护快照；验证继承数为非负整数、不超过日志长度，非 seeded 会话必须为 0。新版保护记录 `snapshot-session` v2 在 source 中保存完整事件及继承分界，manifest 仍为 v1；读取器兼容旧保护记录 v1，并校验 v2 分界。快照读取失败区分“不存在”“不可读”和“不支持”，不再统一伪报源文件丢失。

严格的旧 `inspect` 仍拒绝正继承数；新版 ZIP 改用 `readSession` 和 v2 保存继承分界。回收恢复优先保留现存原日志；其独立的旧快照写入器在原件缺失时仍拒绝正继承分界，不展平分叉，并保留保护记录。

适配器将现代 `create` 显式暴露为 `createWriteHandle`，不伪装为旧 create/append。原持久层暴露 `locate` 时才透传并验证绝对路径。没有 locate 时，不支持会话目录统计、物理删除或现代 ZIP 回滚写入器；有 locate 的只读后端仍可能支持直接永久删除。

## 预览、搜索与客户端

`/preview` 默认只接受当前可见归档 ID，`scope: "trash"` 则要求存在回收记录。搜索只覆盖可见归档。聊天正文使用 Harness append-origin 投影，不重复索引 replacement 副本；系统提示词更新单独保留。`request/header` 在恢复或开启新请求系列时可引用日志中已知的有效系统提示词，尊重替换和清空，紧邻提示词卡片不重复展示。投影按日志顺序分页，客户端按 `anchorSeq` 将对应提示词放在当轮输入前；信息不完整时不推测提示词。

图片按顺序校验：请求 guard → 有界身份字段 → 当前可见性 → 规范投影中完全匹配的图片描述符 → 可选公开 `attachments.readImage`。异步读取后再次检查可见性，响应使用 `no-store`、`nosniff`，错误不回显路径。

当前回收站预览仍调用原会话消息投影，没有保护快照回退。原件缺失时预览可能失败，即使恢复服务能从快照恢复；这是已知限制，不应写成已实现的快照预览功能。

搜索读取并发 4；投影缓存为 30 秒 TTL、64 会话 LRU。单段最多 256 Ki Unicode 码点，单消息 1 Mi 码点／1,000 段，单会话 10,000 条投影消息；未知结构化值在 stringify 前限制深度、节点和字符。超预算内容截断或不入缓存。

客户端识别公开 React 组件类型，包括经 `React.memo` 包装的 `MarkdownText`，优先使用宿主 `MarkdownText`、`DisclosureRow`、`JsonBlock`；缺少时降级为转义文本、原生 details 或 pre。工具结果只与更早且 ID 匹配的调用合并。图片使用 Blob URL，关闭／卸载时取消请求并释放 URL；请求序号屏蔽迟到响应。轮次导航在桌面位于左侧，宽度不超过 640px 时改为顶部横向滚动。

轮次投影保留日志中的边界及过程／最终回复位置。仅完整加载、已结束且最终回复已知的轮次组成默认收起的过程折叠项；不完整或缺少边界的内容保持事件顺序。过程摘要显示「已思考」或实际工具／消息／子代理数量，嵌套思考、上下文来源及工具参数／结果默认收起，最终回复位于过程之外。真实用户消息居右，全部 AI 过程居左。预览只读、无输入框，不编造用量或耗时，也不承诺完整原生功能或缺失日志内容。部署时必须重新加载实际 DSH 后端以替换投影代码，仅刷新浏览器不够。

导出下载使用受保护 fetch，验证状态、ZIP 内容类型和附件 disposition，缓冲完整响应后才创建 Blob URL。端到端超时为五分钟，已声明及流式响应上限为 320 MiB 字节。该上限不是峰值堆内存保证，因为分块、连续缓冲区和 Blob 可能同时存在；非流式 WebView 回退也没有更强的通用内存上限。完成文案表示已开始下载，不表示浏览器已保存到磁盘。

归档行操作为预览、编辑标签备注、取消归档、删除。顶部提供批量归档和更多；更多菜单依次为导入备份、全部导出、全部取消归档、分隔线、全部删除，各 Tab 顶部保持一致尺寸。工作区菜单依次为全部取消归档、全部移入回收站、全部导出、分隔线、全部删除，每项均确认完整工作区名称和全部归档聊天数。全局导出／取消归档／删除确认所有工作区归档数量，排除回收站；筛选不缩小这些范围。「删除／全部删除」进入简短的不可恢复确认，点明聊天、工作区或全局范围。回收站聊天行保留预览图标，恢复／删除使用与归档行一致的紧凑文字按钮。工作区操作为全部恢复和全部删除；顶部直接并列显示纯文字的全部恢复和清空回收站，不再设置更多菜单；清空仍须不可恢复确认。主按钮和选中 Tab 使用随深色模式反转的黑白主题色，危险操作保留红色。两级恢复确认分别说明工作区名称或全局工作区数、可恢复聊天数及已归档去向，跳过 purge-pending。同步提交锁避免重复请求；反馈保留实际成功／失败数量及查看已归档入口。永久删除响应中的 deleted 和 pending 都从可操作归档列表移除，同时保留失败说明并刷新相关状态。

## 关于与版本查询

`GET /about` 只返回已加载包的本地身份、受控链接和内存缓存，无网络副作用。受现有同源 guard 保护的 `POST /about/check-updates` 只接收 `{ force: boolean }`。固定请求 `https://registry.npmjs.org/dsh-archived-chats/latest`，不携带聊天、备份或客户端凭据；拒绝重定向、异常状态、错误包名和非法 SemVer，按 SemVer 判断新版，绝不建议降级。请求超时 5 秒，响应上限 64 KiB。

自动检查的成功／失败均缓存 12 小时；手动检查短限流 30 秒，并发合并，缓存随后端重载重置。失败状态为 unavailable，不误报 current。客户端加载本地信息后在后台发起缓存感知检查，取消或过期结果不覆盖当前页面。关于页位于最后一个 Tab；标题旁的新版入口只打开插件市场，不安装、运行命令或重启。用户按宿主提示自行重载后端，单纯刷新前端不保证加载新版。

## 回收与恢复

移入顺序：核对归档所有权 → 处置／停放已加载会话 → 捕获或复用健康保护快照 → 再核对所有权 → 原子写入 `trashed` → 使缓存失效。普通回收不删除原日志。

快照 manifest 格式为 `dsh-archived-chats/snapshot` v1；`dsh-archived-chats/snapshot-session` 载荷在有继承元数据时使用 v2，否则保留旧 v1。上限：manifest 4 MiB、session JSON 64 MiB、1,000 个附件、单附件 32 MiB、总计 512 MiB。附件流式校验 SHA-256，恢复写入前逐件复读，不同时驻留全部附件字节。

恢复拒绝 `purge-pending`。其他记录先检查原件身份：原件存在时恢复归档可见性、工作区关联和缺失元数据，移除回收记录，不重写日志。因此 degraded 条目不一定不可恢复。

原件缺失时，验证快照身份与完整内容，拒绝无法表达精确继承边界的 seeded 来源，重检 ID 冲突，并要求明确独占的 create、`append`、`locate` 及必要时的 `saveImage`；普通 create 不代表获得归属。恢复原 ID，不创建“新归档副本”。附件身份必须匹配；提交涉及日志、工作区、元数据、归档注册表及回收记录。失败逆序补偿；归属不明的创建和回滚失败会保留目标与回收记录并分别报告。工作区无法解析或没有成对 attach/detach 时降级为未分组警告。

恢复后未引用的保护快照不再投影成回收条目，后续启动时按旧数据清理规则处理。

## 永久删除与崩溃恢复

`trash.json` 状态与转换：

| 状态 | 含义 | 恢复规则 |
| --- | --- | --- |
| `trashed` | 已回收，保护数据可用 | 优先原件，缺失时快照回退 |
| `degraded` | 保护数据缺失或不可用 | 原件仍可恢复，回退需通过验证 |
| `purge-pending` | 已提交永久删除意图 | 不得恢复或取消归档，只能续作 |

普通回收为 missing → trashed；回收永久删除为 trashed/degraded → purge-pending；归档直接永久删除可 missing → purge-pending。直接删除先验证当前归档归属、没有回收记录、公开定位能力及会话独占目录，然后写入 `snapshotId: null`、快照字节及附件数为 0 的任务，不创建恢复副本。

两条路径共用 purge：持久化删除意图 → 清理该会话的全部关联快照并复查 → 物理删除会话 → 完成注册表与元数据清理 → 最后移除回收记录。物理删除在调用方持有生命周期锁且有待删除标记时执行。

快照清扫使用 manifest 身份归属，并点名记录引用的 snapshotId，以覆盖损坏快照；不相关且无法归属的损坏项不会阻塞该会话删除。会话文件必须位于以自身 ID 命名的独占目录中，共享目录不是合法删除目标。已删除日志或索引不代表任务完成：依靠持久化意图继续清理剩余状态。

失败保留 `purge-pending`。启动恢复和运行中的重试继续处理这些任务，不将其恢复为普通聊天。归档删除拒绝已有回收记录，所以归档页全部删除不会波及回收站。删除快照副本不承诺清除 Host 全局附件或 `session_projcache`；插件没有对应的安全公开 eviction API。

## 启动恢复与旧数据清理

`recoverStartup` 依次：

1. 恢复快照存储，加载回收权威目录；标记缺失保护数据的非待删除条目为 degraded。
2. 重试 purge-pending。
3. 读取旧 pending-deletions 标记；仍归档且未回收的 ID 尝试迁移为可恢复记录，成功后移除旧标记，不直接永久删除。
4. 在生命周期队列中重新读取回收目录与快照清单，保护所有被当前记录引用的 snapshotId，清理其余有效或降级快照。

这是启动旧数据清理，不受 `recycleAutoDelete` 控制，不提供旧版清理预览。权威目录不可读时不凭猜测清扫；迁移输入不可读可提前返回。单个快照清理失败记录稳定错误，后续启动可再尝试。

此清理删除插件快照和附件副本，不删除来源聊天。旧版本中“升级保留所有快照并放入回收站”的说明不适用于当前实现。用户必须在升级前保全仍需要的旧数据。

## 空间、策略与来源关系

`stats` 并发 4 测量会话目录、跳过符号链接，缓存 30 秒；失败只影响对应项。`insights` 仅统计当前回收记录引用的保护快照，与归档／回收会话目录分账；重复附件按已验证 SHA-256 计算，不当作全局可回收空间。

策略 version 2 显式 opt-in。version 1 读入时 `recycleAutoDelete` 强制 false，不静默改写。旧快照数量、年龄、容量字段不再产生清理候选。开启或缩短回收保留期需要 5 分钟单次 token/nonce，绑定原策略、新策略与到期候选；保存时在生命周期锁内复查，但保存本身不执行删除。

自动任务先做启动恢复，之后约每分钟串行检查。逐条 purge 前重新验证策略与记录；失败保留重试。关闭策略不撤销已提交删除意图，停用插件停止新定时任务。旧手动 retention API 仍需其自己的确认与重检。

`lineage` 仅使用持久化 `parentSession` 建树，聚焦归档／回收聊天及必要上下文。最多按需读 100 个缺失标题，5,000 节点上限针对实际展示图；不认识的字段仅使相关节点降级。搜索和筛选保留必要祖先，不修改关系。

客户端用迭代投影将每个受管理节点归入自身工作区一次；跨工作区节点成为分组内的起点，`sourceParent` 保留真实直接父节点摘要。工作区内再做搜索和状态筛选，折叠只改变可见性。工作区折叠独立保存于浏览器 `dsh-archived-chats:lineage-workspaces`，不写回 Host，也不影响归档页分组偏好。初次加载折叠所有有后代的受管理节点；搜索临时忽略折叠，清空后恢复，批量展开／折叠只修改当前筛选结果。

关系行使用具名原生按钮展开分支，原生 details/summary 展示详细时间、标题与 ID；不把整张卡片设为点击目标。迭代展开保留实际层级，最多两列祖先引导线，深层显示层级标签及直接父来源。窄屏允许标题与状态换行，不增加树内独立滚动区。此改动不改变后端关系图、归档或删除接口。

## ZIP 导出、导入与恢复

导出包含 manifest、每条 session.json 和 transcript.md，路径净化并处理重名。它仅检查每个选中来源一次，在返回顺序 ZIP 流之前暂存渲染后的条目。ZIP 由 `fflate` 同步分片压缩生成，每条目按 256 KiB 分片推送并在分片之间让出事件循环；写入器不再依赖 `zip-stream`，因此不会引入会请求带斜杠内置模块名的 `readable-stream@4`。共用完整语义验证器和全部导入预算先行执行，因此成功导出可被本插件导入，之后的无效来源不会把已成功响应变成不完整备份。现代读取产生 v2 manifest/session 记录，保存 `source.inheritedEventCount`；旧读取保留 v1。导入兼容两版的普通记录，要求包与记录版本一致，校验 v2 继承边界。边界不明的 seeded v1 来源会被拒绝，不会展平。两版均不打包附件二进制或自动递归加入后代会话。

共用限制为 2,000 条会话、4,001 个条目、4 MiB manifest、单会话 JSON 4 MiB、单条目／Markdown 8 MiB，以及解压总量 256 MiB。导入的压缩输入上限为 512 MiB。每个 JSON 文档限制深度 64、节点 100,000 个，所有字符串合计 4 Mi Unicode 码点。导入有界解压，验证声明／实际大小、路径、版本、生成器、JSON 预算及跨文件身份。它对齐本地条目、数据描述符和中央目录，包括大小与 CRC；拒绝截断、无效 UTF-8、重复项、加密、ZIP64、多磁盘及 Store／Deflate 之外的压缩方法。已有 ID 禁用；缺失工作区或附件引用给警告。确认凭据有效 10 分钟、单次使用，进程最多保留 8 份、总计 128 MiB。确认后的冲突检查和提交进入生命周期队列。

`restore.js` 优先已验证的现代 create 句柄，其次专用恢复入口或明确独占的旧 create/append/locate 合约。普通旧 create/append 不受支持：目录中不存在记录不能证明独占所有权。现代导入保留继承边界、分批追加、flush（包括空日志）、完整回读校验，并在注册表和元数据提交后关闭句柄。仅在创建成功后获得回滚权限，要求安全定位的会话独占目录；首次写入失败留下归属不确定的文件时保留并报告 `restore-rollback-failed`，不盲删。旧 writer 拒绝带继承的 v2 记录。工作区关联需 attach/detach 成对支持。冲突集包含回收记录和待删除任务，并在生命周期队列内重检。此适配器用于 ZIP 导入；回收快照回退在 `recycle.js` 中有独立检查。

原始导入提交后，可选公开冷标题发布会在共享有界截止时间内验证精确标题和最终事件水位。缓存缺失、失败、超时或 seeded 冷列表限制只返回稳定降级警告，不回滚持久化恢复数据。取消归档另外要求权威可读的持久化 header 包含 `cwd`；缺少 `cwd` 不等于缺少工作区，并会把已归档副本保留为可预览／导出。

## 验证与发布边界

`test/backup-roundtrip.test.mjs` 在 `DSH_NATIVE_MODULE_ROOT` 指向已安装 Host 的 node_modules 时，使用官方存储组件和临时目录验证 v1 恢复、分叉 v2 往返、预览／取消归档／重新打开、首次落盘失败、并发创建及待删除冲突。未配置时显式跳过这些原生集成测试，现代写入器单元测试仍照常执行。

测试覆盖实际保留模块：导出导入及回滚、快照与回收状态、删除中断重启、分叉标题、完整读取和严格 ZIP 读取、策略调度、统计、关系树、Host 路由、浏览器行为、类型和包内容。`test/archive-lifecycle.test.mjs` 覆盖分叉预览、回收／恢复、继承分界保留及直接永久删除链路。测试使用隔离数据，不读取真实聊天。

```sh
npm test
npm ci --prefix test/fixtures/native-host --ignore-scripts --include=optional
node scripts/run-native-integration.mjs
npm pack --dry-run --json
git diff --check
```

原生集成命令会安装锁定的 `@deepseek-ai/dsh-session@0.1.5-rc.2` fixture，并要求五个原生往返用例全部执行且不能跳过；这是 CI 强制原生 Host 集成门禁的本地等价检查。

声明的 DSH `>=0.1.0-rc.7` 范围仍以 Host 公开能力为准。发布自动化已通过 Ubuntu 上的 Node.js 18，以及 Ubuntu、macOS 和 Windows 上的 Node.js 24；Node.js 24 矩阵强制运行官方 Host 后端集成（5/5）与打包检查。已安装的 1.4.0 产物也已在 `@deepseek-ai/dsh-session@0.1.5-rc.2` 上通过官方 native 闭环（5/5）。现有截图来自 v1.3.1，含退役快照界面；它们仍是历史示例，不作为当前行为说明。
