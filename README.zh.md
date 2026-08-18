# dsh-archived-chats

> ⚡ **删除即生效，无需重启。** 即使会话仍驻留在后台，也会沿官方生命周期当场安全拆除并从磁盘彻底删除——点下删除的那一刻就删干净，而不是"停用后等下次重启"。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 新增一个「已归档的聊天」设置页，把被归档的会话重新找回来。

在 DeepSeek Harness 里，聊天一旦归档就会从侧边栏消失，界面中没有任何入口可以再看到它，只有工作区存档（`~/.dsh/storages/workspace.json`）还记得它。这个插件在「设置」中补上一个「已归档的聊天」页面，让所有归档会话都可见、可搜索、可管理。

## 安装

```sh
dsh plugin --profile web add dsh-archived-chats
```

安装后重启一次 DSH，然后打开 **设置 → 已归档的聊天**。

## 兼容性

0.6.0 版本以 DeepSeek Harness `0.1.0-rc.7` 为验证基线。插件注册的是顶层 `settings.section`，因此 rc.7 针对 `settings.plugin.item` 的 keyed-slot 变更不影响本插件。以后 Harness 发布新版本时，仍应在发布插件更新前重跑冒烟测试并检查真实宿主页面，因为客户端插槽和设计令牌契约仍可能演进。

## 功能

- **完整归档列表**：按工作区（项目）分组并显示每组数量；每个分组都可折叠/展开，状态按浏览器记忆。
- **搜索与排序**：按标题、项目名、标签和备注内容搜索，用类型（全部 / 普通会话 / 子代理会话）、项目和标签筛选，并按最新、最早或标题排序。
- **标签与备注**：任意行打开编辑器即可添加最多 8 个标签（每个最多 24 个 Unicode 字符）和一条备注（最多 2,000 个 Unicode 字符）。每行渲染标签小徽章，超过 3 个折叠为 `+N`，标签筛选不区分大小写。
- **存储统计**：概览条显示归档数量、已统计总大小与无法统计的会话数；每行显示各自占用。统计不会跟随符号链接，无法读取的会话目录显示为「无法统计」而非让请求失败。
- **灵活多选**：逐条选择、选择当前筛选结果或选择整个项目；选中后可一次取消归档或永久删除，隐藏在其他筛选结果中的选择不会丢失。
- **取消归档**单个聊天，或从分组的 `⋯` 菜单整组取消——恢复的聊天会立刻回到侧边栏。
- **删除**单个聊天、某个项目分组或全部（**全部删除**），均有确认弹窗。删除是彻底的：会话日志从磁盘移除、从工作区记录中摘除、注册表内存索引同步清理，主侧边栏的条目也会立即消失。
- 仍驻留后台的会话也**当场删除**：插件按官方生命周期的拆除顺序原地停用并注销会话（取消 → 静默 → 落盘 → 拆纤程 → 摘出注册表），持久层随之释放写入通道，同一次请求内即完成物理删除——无需重启。若当前 DSH 版本不提供所需内部接口，则自动回退为「永久停用 + 下次启动完成删除」，停用期间会话保持隐藏。
- 适配浅色/深色主题，支持中文和英文界面。

## 标签、备注与统计

标签和备注**只保存在本机**的 `$DSH_HOME/plugin-data/archived-chats/metadata.json` 中——不会被上传、同步或发送到任何其他地方。取消归档会保留元数据；物理删除完成后会移除它，而延后或失败的删除会保留它。元数据与统计失败永远不阻塞：即使元数据存储无法读取或某个会话目录无法统计，列表、取消归档和删除仍然可用。

## 实现原理

- **Host 半**（`lib/index.js`）在 DSH Web 服务器上注册 `/plugins/dsh-archived-chats/*` 路由：`GET /state`、`GET /stats`、`POST /metadata`、`POST /unarchive`、`POST /unarchive-all`、`POST /delete`、`POST /delete-all`。`/state` 会把标签、备注和 `metadataUpdatedAt` 拼到每一行，并上报 `metadataStatus`；`/stats` 返回每个会话的字节数/文件数与汇总。取消归档走 workspace registry 自身的状态写入通道，所有已连接的客户端都会收到 `host/archived-sessions-changed` 推送。写操作路由要求自定义请求头 `x-dsh-archived-chats: 1` 作为 CSRF 加固。
- **元数据存储**（`lib/metadata.js`）：带版本号的原子 JSON 存储。写入通过队列串行化，并以临时文件重命名的方式替换原文件，因此并发保存不会互相交叠；无法读取或不支持的版本绝不被覆盖。
- **存储统计**（`lib/stats.js`）：以并发 4 测量会话目录，跳过符号链接，结果缓存 30 秒，无法统计的会话上报为「不可用」而不是让请求失败。删除会使对应缓存失效。
- **活会话原地删除**：删除仍驻留后台的会话时，插件复刻 agent 工厂自身 disposer 的顺序——`cancel({ kind: 'disposed' })` → `whenIdle` → `flush` → `agent.scope.dispose()` → 依次 detach `agents` 与 `sessions` 两个 store 条目；session detach 发出 `session/disposed`，持久化协调器随之 retire（排空并释放）该会话的写入通道，之后冷删除路径在同一请求内完成。所涉 store 条目属于内部接口，每一步都做特性探测，探测失败即回退为停用+延后。
- **待删队列**（回退路径与崩溃兜底）：id 记入 `$DSH_HOME/plugin-data/archived-chats/pending-deletions.json`，会话保持归档与隐藏；下次启动时插件清扫该队列，通过常规删除路径完成物理删除。原地删除也用该队列包裹（删除前登记、文件移除后清除），中途崩溃由下次启动补完。已入队的会话不会出现在列表中；取消归档会撤销待删标记。
- **标题缓存**：列表刷新时按 id 记忆已解析的标题，不再每次全量读日志；删除与取消归档会使对应缓存失效。
- **浏览器半**（`lib/client.js`）注册 `settings.section` 插槽项（order 30），用 React 和 rc.7 的 DSH 浮层/状态设计令牌渲染页面。

## 开发

```sh
npm test
```

测试套件（`test/*.test.mjs`）覆盖元数据存储、统计服务以及宿主+浏览器的冒烟测试，使用隔离的临时 DSH 主目录和模拟的宿主/浏览器运行时，不会读取或修改真实会话。

## 卸载

```sh
dsh plugin --profile web remove dsh-archived-chats
```

唯一残留是 `$DSH_HOME/plugin-data/archived-chats/` 下的待删队列 `pending-deletions.json` 和 `metadata.json` 两个小文件；卸载不会触发队列处理，也不会删除你的标签与备注。

## License

MIT
