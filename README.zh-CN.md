<p align="center">
  <img src="assets/brand/archive-management-banner.png" alt="归档管理：面向 DeepSeek Harness 的本地优先归档聊天中心" width="100%">
</p>

<div align="center">

<h1>归档管理</h1>

<p><strong>面向 DeepSeek Harness 的本地优先归档聊天中心</strong></p>
<p><code>dsh-archived-chats</code></p>

<p>
  <a href="https://www.npmjs.com/package/dsh-archived-chats"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-archived-chats?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/dsh-archived-chats"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-archived-chats?style=flat-square"></a>
  <a href="https://github.com/Ultronen/dsh-archived-chats/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Ultronen/dsh-archived-chats/ci.yml?branch=main&amp;style=flat-square&amp;label=CI"></a>
  <a href="https://github.com/Ultronen/dsh-archived-chats/actions/workflows/ci.yml"><img alt="Node.js 18 and 24" src="https://img.shields.io/badge/Node.js-18%20%7C%2024-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white"></a>
</p>
<p>
  <a href="https://github.com/Ultronen/dsh-archived-chats/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-2ea44f?style=flat-square"></a>
  <a href="https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <a href="https://github.com/Ultronen/dsh-archived-chats/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Ultronen/dsh-archived-chats?style=flat-square"></a>
</p>

<p><a href="README.md">English</a> · 简体中文</p>
<p><a href="https://awesome-dsh-plugin.com/p/Ultronen/dsh-archived-chats/">插件市场</a> · <a href="https://www.npmjs.com/package/dsh-archived-chats">npm</a> · <a href="https://github.com/Ultronen/dsh-archived-chats/releases">版本发布</a> · <a href="https://github.com/Ultronen/dsh-archived-chats/discussions">问题交流</a> · <a href="https://github.com/Ultronen/dsh-archived-chats/security/advisories/new">私密报告漏洞</a></p>

</div>

归档管理为 DeepSeek Harness 中归档后从主页面会话区隐藏的聊天提供查看和管理入口。保留 DSH 原有单条归档方式，并扩展工作区批量归档、搜索、预览、备份及按工作区移入回收站的流程。

> 中文名称为「归档管理」，英文名称为 Archive Management；安装包名始终为 `dsh-archived-chats`。
>
> 本文跟随 `main` 分支维护。本文适用于 1.4.3，该版本接受 DSH `0.1.7-rc.2` 及更高版本 Host 发出的 v4 会话格式。1.4.2 的导出实现不再携带会导致新版 Host 启动失败的依赖；已安装用户请先升级。版本变更见[更新日志](CHANGELOG.md)，其中包含 1.4.1 的英文名称统一与交互提示优化。

## 快速开始

在 DSH 插件市场搜索 `dsh-archived-chats`，核对作者为 **Ultronen** 后点击「安装」。安装完成后按宿主提示重启 DSH，打开 **设置 → 归档管理**。

也可以在运行 DSH 的电脑上使用命令行安装：

```sh
dsh plugin --profile web add dsh-archived-chats@latest
```

重启 DSH，打开 **设置 → 归档管理**。

旧版用户请先阅读下方「从旧版升级」，再执行更新：

```sh
dsh plugin --profile web update dsh-archived-chats
```

## 核心能力

| 范围 | 当前行为 |
| --- | --- |
| 浏览与搜索 | 按工作区浏览归档聊天，支持全文搜索、筛选、排序、标签与备注。 |
| 工作区批量归档 | 设置页的工作区选择器支持选择一个或多个工作区，汇总确认后归档；跳过空白、正在使用或无法确认内容的聊天。 |
| 只读预览 | 无需取消归档即可查看对话、思考、工具活动、Markdown、JSON、代码及可读取的已存储图片。 |
| 备份 | 支持按工作区或全部归档导出 JSON + Markdown ZIP；导入先预览，跳过冲突 ID。 |
| 回收站 | 按工作区移入回收站；支持单条、工作区和整个回收站恢复到已归档。 |
| 永久删除 | 确认后删除单条归档、工作区归档或全部归档；回收站删除独立操作。 |
| 空间与关系 | 空间分账、可选的回收站自动清理，以及只读「来源与分支」。 |

五个视图为 **已归档**、**回收站**、**空间与策略**、**来源与分支** 和 **关于**。归档不会创建历史版本；回收站保护快照仅用于恢复，不是可浏览的历史版本库。

已归档页顶部仅保留 **批量归档** 和 **更多**；「更多」依次提供导入备份、全部导出、全部取消归档，分隔线后为全部删除。回收站顶部直接并列显示 **全部恢复** 和 **清空回收站**，不再设更多菜单；聊天行保留预览图标，使用紧凑的 **恢复** 和 **删除** 文字按钮。工作区恢复和全局恢复分别确认范围、数量及已归档去向，跳过正在永久删除的条目；清空仍须确认不可恢复的后果。各 Tab 顶部保持一致尺寸。工作区操作及全局导出、取消归档、删除均先确认完整归档范围和聊天数量。

「关于」展示当前运行版本、作者、许可证、指南、项目与反馈链接，提供「检查更新」。打开页面时后台查询公开 npm 版本信息，运行期间自动检查间隔至少 12 小时；失败不会阻断归档功能。有新版时标题旁显示「去更新」，打开插件市场，不自动安装或重启。更新后按宿主提示自行安排重启 DSH，仅刷新网页不一定能加载新版后端。

预览中真实用户消息在右侧，AI 处理过程在左侧。完整加载且已结束的轮次将中间过程默认折叠，最终回复独立展示；未完整加载的轮次保留事件顺序。更新后需要重新加载 DSH 后端才能使用新版预览投影，仅刷新浏览器不够。

## 归档、回收与删除的区别

- **归档：** 保留聊天，但从主页面会话区隐藏；取消归档后返回主页面。
- **移入回收站：** 仅通过已归档工作区菜单操作。恢复先回到已归档，再取消归档返回主页面。
- **归档页「全部删除」：** 永久删除所有工作区的已归档聊天，不影响已经在回收站中的聊天。
- **「清空回收站」：** 永久删除回收聊天及其关联保护数据。

不提供单条移入回收站或单条导出。工作区和全部操作包含被筛选隐藏的聊天；工作区操作不会删除工作区或项目目录。批量操作前可查看[操作范围表](docs/USER_GUIDE.zh-CN.md#操作入口与范围)。

清空回收站只作用于确认时展示的精确回收记录实例。之后新增的记录不纳入本次操作；目标已变更时会失败，不会扩大已确认范围。没有工作目录的聊天会留在已归档，因为当前 Host 无法让它在主聊天列表中可达；仅缺少工作区不等同于没有工作目录，仍可以未分组方式恢复。

## 数据安全与边界

- **聊天数据只在本机：** 插件状态保存在 `$DSH_HOME/plugin-data/archived-chats/`，不会上传或云同步聊天；更新检查仅请求公开 npm 包版本，不发送聊天或备份内容。
- **回收有保护，永久删除不可恢复：** 工作区移入回收站需要健康保护快照；直接永久删除不创建可恢复副本。
- **不覆盖已有聊天：** 导入跳过已有 ID；回收恢复优先使用原会话，原件缺失时只能通过 Host 明确的独占写入器重建普通会话 ID，否则保留回收记录。
- **删除可以续作：** 确认后的任务先清理关联快照，再删除原会话；失败保留不可恢复的任务，在运行期间或重启后重试。
- **回收站自动清理默认关闭：** 开启或缩短期限需确认，只处理到期回收聊天，不自动删除普通归档聊天。
- **ZIP 不等于完整附件备份：** 保留附件引用，但不包含附件字节，也不自动打包后代会话。

导出成功前会按导入使用的同一格式和预算完成验证。浏览器会在五分钟超时和 320 MiB 响应上限内缓冲经验证的 ZIP；这是响应字节上限，不是浏览器峰值内存上限。“备份已开始下载”不表示文件已保存到磁盘。

## 从旧版升级

**名称与版本：** 1.4.2 仅更换导出实现，下列菜单名称不变。1.4.1 的英文名称为 Archive Management，1.4.0 英文菜单显示 Session Archive；两者都对应中文「归档管理」，不是不同插件。中文入口、包名、安装命令和数据位置不变。更新至 1.4.1 或更高版本并重启 DSH 后，英文入口名称生效。

独立「历史版本」和「预览清理」界面已移除，不应再按旧版截图寻找这些入口。

**启动恢复流程会清理未被当前回收记录引用的旧快照及其插件附件副本，不会将它们放进回收站。这项清理不受回收站自动清理开关控制。**

当前回收记录引用的保护快照会保留。清理未引用快照不删除来源聊天本身；已确认删除任务的重试和已启用的到期清理是另外的操作。

如果仍需要旧快照内容，请在升级前使用支持该功能的旧版恢复并导出，另行保留附件，或离线备份完整插件数据目录。降级前应完成待删除任务并备份数据；旧版本可能不识别不带快照的待删除记录。

## 兼容性

包声明支持 DSH `>=0.1.0-rc.7`；具体功能取决于 Host 公开能力。

| Host 能力 | 依赖或限制 |
| --- | --- |
| 公开归档 API | 工作区批量归档必需；不支持时拒绝执行，不作修改。 |
| 会话与附件读取 | 用于预览／搜索；缺少附件读取时只降级图片。 |
| 会话独占物理位置 | 会话目录统计和永久删除必需；不把共享目录当作删除目标。 |
| 公开 writer | ZIP 导入和快照回退恢复必需；恢复完好的原会话不重写日志。仅有旧 create/append 不足以安全恢复 ZIP，除非提供者明确保证独占创建。 |
| 新版句柄接口 | 分叉支持标题、预览／搜索及移入回收站。ZIP v2 保存继承边界；导入通过 create/append/flush/close 写入，并要求安全的会话独占回滚位置。普通 v1 ZIP 仍可读取，但边界不明的 seeded v1 来源会被拒绝，不会展平。 |
| Host 模块解析 | DSH `0.1.6-alpha.2` 新增的解析层会在任何依赖请求带斜杠的内置模块名时失败。1.4.2 之前，本插件经 `zip-stream` 引入 `readable-stream@4`，因此插件一被加载就会中止 Host 启动。1.4.2 的导出改用 `fflate`，不再携带该依赖链；请在这些 Host 版本上先升级。 |

回收站预览目前仍依赖原会话；原件丢失时，即使保护快照可恢复，也可能无法预览。详见[兼容性与限制](docs/USER_GUIDE.zh-CN.md#兼容性与限制)。

声明的版本范围仍以 Host 公开能力为准。发布自动化已通过 Ubuntu 上的 Node.js 18，以及 Ubuntu、macOS 和 Windows 上的 Node.js 24；Node.js 24 矩阵强制运行官方 Host 后端集成（5/5）与打包检查。已安装的 1.4.0 产物也已在 `@deepseek-ai/dsh-session@0.1.5-rc.2` 上通过官方 native 闭环（5/5）。

## 文档

| 资料 | English | 简体中文 |
| --- | --- | --- |
| 用户指南 | [Read the guide](docs/USER_GUIDE.md) | [查看指南](docs/USER_GUIDE.zh-CN.md) |
| 架构说明 | [Maintainer architecture](docs/ARCHITECTURE.en.md) | [维护者架构](docs/ARCHITECTURE.md) |
| 版本历史 | [GitHub Releases](https://github.com/Ultronen/dsh-archived-chats/releases) | [GitHub Releases](https://github.com/Ultronen/dsh-archived-chats/releases) |

另见 [支持说明](SUPPORT.md)、[安全说明](SECURITY.md)、[贡献指南](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md)和[问题交流](https://github.com/Ultronen/dsh-archived-chats/discussions)。认领任务或提交 Pull Request 前，贡献者务必完整阅读[贡献指南](CONTRIBUTING.md)。

## 项目状态

归档管理目前处于积极维护状态。最新 npm 稳定版会接收缺陷修复与安全更新；报告问题前请先从旧版本升级。欢迎可复现的缺陷报告和目标集中的 Pull Request。已开放认领的社区任务会标记为 [`help wanted`](https://github.com/Ultronen/dsh-archived-chats/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)；开始较大改动前，请先阅读[需求认领流程](CONTRIBUTING.md#社区需求与认领)。项目按维护者的可用时间推进，不承诺固定响应或发布时间。

## 开发

```sh
npm test
npm ci --prefix test/fixtures/native-host --ignore-scripts --include=optional
node scripts/run-native-integration.mjs
npm pack --dry-run --json
```

测试覆盖 Host 与浏览器行为、导出导入、快照恢复、回收站、保留策略、全文搜索、响应式布局、公开类型、包内容和仓库卫生。原生集成命令会安装锁定的 `@deepseek-ai/dsh-session@0.1.5-rc.2` fixture，并要求五个原生往返用例全部执行且不能跳过。所有检查只使用隔离临时数据，不读取真实会话。

## 卸载

```sh
dsh plugin --profile web remove dsh-archived-chats
```

卸载只移除插件包，保留 `$DSH_HOME/plugin-data/archived-chats/`，不执行永久删除。重新安装后仍按所安装版本执行启动恢复与清理，包括清理未引用快照。卸载或手动删除插件状态前请备份需要的数据，详见[本地数据与卸载](docs/USER_GUIDE.zh-CN.md#本地数据与卸载)。

## 许可证

[MIT](LICENSE)
