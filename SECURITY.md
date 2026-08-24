# 安全政策 / Security Policy

## 支持范围

安全修复以 npm 上的最新稳定版本为准。旧版本仍可用于回滚，但通常不会单独接收安全补丁；报告问题前请先确认能否在最新版本复现。

| Version | Security support |
| --- | --- |
| Latest stable npm release | Supported |
| Older releases | Upgrade and reproduce first |

## 私密报告漏洞

请使用 GitHub 的[私密漏洞报告](https://github.com/Ultronen/dsh-archived-chats/security/advisories/new)。不要在公开 Issue、Discussion、PR 或日志中披露尚未修复的漏洞。

报告应尽量包含：

- 插件版本、DeepSeek Harness 版本、操作系统和安装来源。
- 最小复现步骤、预期行为、实际行为和潜在影响。
- 已脱敏的日志、请求或备份结构，以及你已经尝试过的缓解方式。
- 如果已知，受影响版本范围和建议修复方向。

请勿提交真实聊天内容、附件、访问令牌、Cookie、私钥、完整用户目录路径或其他个人数据。可以使用最小化的虚构数据复现。

以下问题尤其适合私密报告：越权访问、CSRF 或认证绕过、路径遍历、任意文件读写、敏感数据泄露、不安全的备份导入，以及可导致会话或附件意外永久删除的问题。DeepSeek Harness 本身的问题应同时报告给对应的上游项目。

维护者会在可用时间内确认和分级报告，但不承诺固定响应时限。公开披露前请先协调修复和发布时间；适合时会使用 GitHub Security Advisory 发布说明。

## Reporting in English

Use [GitHub private vulnerability reporting](https://github.com/Ultronen/dsh-archived-chats/security/advisories/new). Do not disclose an unpatched vulnerability in a public issue, discussion, pull request, or log.

Include the plugin and DeepSeek Harness versions, operating system, installation source, minimal reproduction steps, impact, and sanitized diagnostics. Never include real chat content, attachments, credentials, cookies, private keys, full home-directory paths, or other personal data. Please coordinate disclosure with the maintainer before publishing details.
