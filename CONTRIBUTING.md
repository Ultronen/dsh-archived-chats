# 贡献指南 / Contributing

感谢你帮助改进 dsh-archived-chats。

## 选择正确入口

- 使用问题、安装帮助和开放式想法：前往 [Discussions](https://github.com/Ultronen/dsh-archived-chats/discussions)。
- 能够复现的插件缺陷：提交 [Bug report](https://github.com/Ultronen/dsh-archived-chats/issues/new/choose)。
- 功能建议：使用 Feature request 表单。
- 安全漏洞：阅读 [SECURITY.md](SECURITY.md)，使用私密漏洞报告，不能公开提交。

提交前请搜索已有 Issue 和 Discussion，并只提供经过脱敏的最小复现信息。

## 本地开发

要求 Node.js 18 或 24。克隆仓库后运行：

```sh
npm ci
npm test
npm pack --dry-run --json
```

PR 应保持单一目的，并说明用户可见变化、兼容性影响、数据安全影响和验证结果。界面变化应附截图。除非维护者明确要求，不要修改版本号、创建标签、发布 npm 包或更新插件市场。

不得提交本地插件数据、数据库、聊天内容、附件、日志、访问令牌、`.DS_Store` 或测试临时文件。对导入、恢复、回收站和永久删除流程的改动必须包含失败与回滚场景测试。

## 发布命名规则

GitHub Release 标题必须与发布 tag 完全一致，例如 tag 为 `v1.0.2` 时标题只能是 `v1.0.2`，不要添加包名或其他前缀。产品名称和版本说明可以写在 Release body 中。

## Pull request checklist

1. 从最新 `main` 创建短期分支。
2. 添加或更新能够证明行为的测试。
3. 同时维护中文和英文用户文档。
4. 运行完整测试和 npm 包内容检查。
5. 等待 GitHub CI 通过，并处理所有评审意见。

## English summary

Use Discussions for questions, Issues for reproducible bugs, and private vulnerability reporting for security problems. Keep pull requests focused, add tests, update both language documents when user behavior changes, and run `npm test` plus `npm pack --dry-run --json`. Never commit local plugin data, conversations, attachments, credentials, logs, or temporary files. Versioning, npm publication, tags, releases, and marketplace updates are maintainer-only unless explicitly requested.

GitHub Release titles must exactly match their tags (for example, `v1.0.2`); do not prefix them with the package name. Put product naming and release descriptions in the release body instead.
