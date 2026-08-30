<p align="center">
  <img src="assets/brand/session-archive-banner.png" alt="会话档案：面向 DeepSeek Harness 的本地优先归档聊天中心" width="100%">
</p>

<div align="center">

<h1>会话档案</h1>

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

会话档案为 DeepSeek Harness 中归档后从侧边栏消失的聊天提供统一入口。你可以按工作区浏览全部归档聊天、全文搜索对话、查看已验证的本地历史，并通过明确且可恢复的流程恢复或删除它们。

> 原「已归档的聊天」现已更名为「会话档案 / Session Archive」。包名、仓库、安装命令和本地数据位置均未改变，现有用户无需迁移数据。

## 快速开始

```sh
dsh plugin --profile web add dsh-archived-chats@latest
```

安装后重启一次 DSH，然后打开 **设置 → 会话档案**。

更新已有安装：

```sh
dsh plugin --profile web update dsh-archived-chats
```

<p align="center">
  <a href="assets/screenshots/preview-03.png"><img src="assets/screenshots/preview-03.png" width="49%" alt="带历史快照时间和合成图片的原生只读预览"></a>
  <a href="assets/screenshots/preview-07.png"><img src="assets/screenshots/preview-07.png" width="49%" alt="空间与策略中的会话目录、保护快照和保留策略"></a>
</p>

## 核心能力

| 范围 | 提供的能力 |
| --- | --- |
| **浏览与搜索** | 按工作区浏览归档聊天，全文搜索消息和工具结果，并支持筛选、排序、标签与备注。 |
| **原生只读预览** | 以原生对话布局展示 Markdown、思考过程、工具活动、JSON、代码和可用的已存储图片，并提供响应式轮次导航。 |
| **本地历史版本** | 归档后保存已验证版本，支持只读快照预览、确认删除、清空历史，以及不覆盖来源的 **恢复为副本**。 |
| **备份与恢复** | 导出 JSON + Markdown ZIP，并通过预览优先、冲突安全的流程导入；已有会话 ID 永不覆盖。 |
| **可恢复删除** | 带保护快照的回收站支持立即撤销、两级恢复，以及单独确认的永久删除。 |
| **空间与关系** | 空间分账、预览优先的保留策略，以及用于分叉和子代理树的只读「来源与分支」。 |

## 安全设计

- **数据只在本机：** 插件元数据、回收记录、策略和已验证快照均保存在 `$DSH_HOME/plugin-data/archived-chats/`，不会上传或云同步。
- **不静默覆盖：** 导入和历史恢复只创建或选择无冲突 ID，绝不覆盖已有会话。
- **删除必须明确：** 普通移除会在快照保护后进入回收站；只有经过确认的永久删除操作才会物理清除。
- **不自动清理：** 保留策略的保存与执行分离，每次清理都从短效预览和明确选择开始。
- **备份范围清楚：** ZIP 保留完整会话 JSON 和可读 Markdown，但不包含附件二进制或后代会话。

## 兼容性

插件根据 DeepSeek Harness Host 暴露的公开能力启用功能，不绑定固定 Host 版本。

| Host 能力 | 插件行为 |
| --- | --- |
| 归档与会话读取 | 浏览、搜索、预览、历史清单、空间分账和会话血缘。 |
| 附件读取 | 对话和快照预览可显示已存储图片；缺少时文本内容仍可阅读。 |
| 公开会话 writer | ZIP 导入、**恢复为副本** 和原件丢失时的快照回退，都通过 Host 公开的 `create` / `append` / `locate` 能力写入；Host 提供专用恢复入口时优先使用。 |
| 缺少写入能力 | 操作返回 `restore-unsupported`，不会写入或覆盖数据。 |

降级到不显示历史版本或不识别回收快照的版本前，请备份 `$DSH_HOME/plugin-data/archived-chats/`。

## 演示预览

下列固定 8 张图片来自隔离的简体中文浅色 Web 环境和合成会话，不包含真实用户数据、路径、备注或凭据；其文件与顺序和插件市场声明完全一致。

<details>
<summary><strong>查看全部 8 张演示图</strong></summary>
<br>
<table>
  <tr>
    <td><img src="assets/screenshots/preview-01.png" alt="会话档案总览和五个管理视图"><br><sub>归档总览</sub></td>
    <td><img src="assets/screenshots/preview-02.png" alt="全文搜索、筛选、标签与命中摘要"><br><sub>全文搜索</sub></td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/preview-03.png" alt="带已存储图片的原生只读历史预览"><br><sub>原生只读预览</sub></td>
    <td><img src="assets/screenshots/preview-04.png" alt="带恢复为副本与删除操作的历史时间线"><br><sub>历史时间线</sub></td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/preview-05.png" alt="清空普通历史前的不可恢复确认"><br><sub>清空历史确认</sub></td>
    <td><img src="assets/screenshots/preview-06.png" alt="保护快照、恢复和永久删除"><br><sub>回收站</sub></td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/preview-07.png" alt="空间分账和保留策略控件"><br><sub>空间与策略</sub></td>
    <td><img src="assets/screenshots/preview-08.png" alt="来源与分支中的分叉、子代理和回收状态"><br><sub>来源与分支</sub></td>
  </tr>
</table>
</details>

## 文档

| 资料 | English | 简体中文 |
| --- | --- | --- |
| 用户指南 | [Read the guide](docs/USER_GUIDE.md) | [查看指南](docs/USER_GUIDE.zh-CN.md) |
| 架构说明 | [Maintainer architecture](docs/ARCHITECTURE.en.md) | [维护者架构](docs/ARCHITECTURE.md) |
| 版本历史 | [GitHub Releases](https://github.com/Ultronen/dsh-archived-chats/releases) | [GitHub Releases](https://github.com/Ultronen/dsh-archived-chats/releases) |

另见 [支持说明](SUPPORT.md)、[安全说明](SECURITY.md)、[贡献指南](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md)和[问题交流](https://github.com/Ultronen/dsh-archived-chats/discussions)。

## 项目状态

Session Archive 目前处于积极维护状态。最新 npm 稳定版会接收缺陷修复与安全更新；报告问题前请先从旧版本升级。欢迎可复现的缺陷报告和目标集中的 Pull Request。项目按维护者的可用时间推进，不承诺固定响应或发布时间。

## 开发

```sh
npm test
```

测试覆盖 Host 与浏览器行为、导出导入、历史版本、回收站、保留策略、全文搜索、响应式布局、公开类型、包内容和仓库卫生。测试只使用隔离临时数据，不读取真实会话。

## 卸载

```sh
dsh plugin --profile web remove dsh-archived-chats
```

卸载只移除插件包，不会删除 `$DSH_HOME/plugin-data/archived-chats/` 中的本地数据，也不会触发回收站永久删除。保留的数据包括 `metadata.json`、`trash.json`、`retention.json`、`snapshots/` 目录，以及尚未迁移时可能存在的旧版 `pending-deletions.json`。之后重新安装仍可继续使用这些数据。准备彻底删除该目录前，请先恢复并备份需要的内容；只有确认其中的数据都不再需要时，才手动删除整个目录。

## 许可证

[MIT](LICENSE)
