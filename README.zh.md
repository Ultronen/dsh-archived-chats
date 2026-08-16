# dsh-archived-chats

[English](README.md) | 中文

**DeepSeek Harness 已归档聊天管理页** —— 在设置里新增「已归档的聊天」页面，参照 CodeX 的已归档视图 1:1 还原。

原版 DSH 把已归档会话直接从侧边栏隐藏，没有任何列表入口：归档之后聊天就在 UI 里消失了，只有 `~/.dsh/storages/workspace.json` 还记得它。这个插件把缺失的页面补上。

## 安装

```sh
dsh plugin --profile web add dsh-archived-chats
```

打开 **设置 → 已归档的聊天**（新增导航项）。安装后需重启一次。

## 功能

- **完整归档列表**：按工作区（项目）分组并显示每组数量——每个分组都可**折叠/展开**（状态按浏览器记忆），列表再长也好管理。
- **CodeX 同款外观**：设置导航里的归档盒图标，以及与 CodeX 已归档页一致的删除确认文案。
- **搜索**标题，外加**类型**（全部 / 普通会话 / 子代理会话）和**项目**两个筛选器。
- **取消归档**单个聊天，或通过项目组的 `⋯` 菜单整组取消——聊天会实时回到侧边栏。
- **删除**单个聊天、整组、或全部（**全部删除**），带确认弹窗；删除是彻底的——会话日志从磁盘移除、从工作区记录中摘除、注册表内存索引同步清除，主侧边栏的条目也会立即消失（每次删除后页面会重新拉取 `session.list` 基线）。仍驻留后台的会话（本次启动打开过）会立即被**永久停用**并记入待删队列，保持归档隐藏并从列表消失，重启 DSH 后完成物理删除。
- 浅色/深色主题、中英文界面均适配。

## 实现原理

- **Host 半**（`lib/index.js`）在 DSH Web 服务器上注册 `/plugins/dsh-archived-chats/*` 路由：`GET /state`、`POST /unarchive`、`POST /unarchive-all`、`POST /delete`、`POST /delete-all`。取消归档走 workspace registry 自身的状态写入通道，因此所有已连接客户端都会收到 `host/archived-sessions-changed` 推送。写操作路由要求自定义请求头（`x-dsh-archived-chats: 1`）作为 CSRF 加固。
- **待删队列**：仍驻留后台的会话删除走「停用并延后」路径——agent 被永久停用（`cancel({kind:'disposed'})`）、保持归档隐藏、id 记入 `$DSH_HOME/plugin-data/archived-chats/pending-deletions.json`；下次启动插件会在服务绑定后清扫该队列，通过普通删除路径完成物理删除。已入队的会话不再出现在归档列表中；若在重启前将其取消归档，待删标记会被撤销。
- **浏览器半**（`lib/client.js`）注册 `settings.section` 插槽项（order 30），用纯 React + DSH 设计令牌渲染页面。

## 卸载

```sh
dsh plugin --profile web remove dsh-archived-chats
```

卸载后无残留：插件唯一的持久状态是待删队列（`$DSH_HOME/plugin-data/archived-chats/` 下的一个小 JSON）；归档集合始终是宿主的，卸载不会触发队列处理。

## License

MIT
