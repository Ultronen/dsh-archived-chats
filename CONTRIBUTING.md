# 贡献指南 / Contributing

感谢你帮助改进 dsh-archived-chats。

> 认领任务或提交 Pull Request 前，务必完整阅读本指南。提交贡献即表示你愿意遵守这里的流程、命名、测试和安全要求。
>
> Before claiming work or opening a pull request, read this guide in full. By contributing, you agree to follow its workflow, naming, testing, and safety requirements.

## 选择正确入口

- 使用问题、安装帮助和开放式想法：前往 [Discussions](https://github.com/Ultronen/dsh-archived-chats/discussions)。
- 能够复现的插件缺陷：提交 [Bug report](https://github.com/Ultronen/dsh-archived-chats/issues/new/choose)。
- 功能建议：使用 Feature request 表单。
- 安全漏洞：阅读 [SECURITY.md](SECURITY.md)，使用私密漏洞报告，不能公开提交。

提交前请搜索已有 Issue 和 Discussion，并只提供经过脱敏的最小复现信息。

## 社区需求与认领

任何人都可以提出需求，但新 Issue 只是待评审的建议，不代表功能已进入路线图。维护者负责最终的产品方向、数据安全边界、需求范围、合并与发布决定。社区讨论会影响这些决定，但不会自动替代维护者确认。

需求按以下流程推进：

1. **提议：** 使用 Feature request 表单说明用户问题、验收标准、范围边界和数据影响。此时的 `enhancement` 标签只表示建议类型，不表示已经接受。
2. **可认领：** 维护者在 Issue 中确认范围和验收标准，并添加 `help wanted`。只有获得该确认的需求才面向社区开放实现；`good first issue` 表示任务边界清晰且适合首次贡献。
3. **认领：** 在 Issue 留言说明计划采用的方法、准备补充的测试，以及预计何时提供第一次进展。维护者回复确认后会添加 `claimed` 并移除 `help wanted`。默认同一时间只确认一位认领者；未获确认前请勿开始大规模实现。
4. **进行中：** 外部贡献者先 Fork 本仓库，将 Fork 同步到上游最新 `main`，再在 Fork 中创建单一目的的短期分支。尽早从该分支向 `Ultronen/dsh-archived-chats:main` 提交 Draft PR，并关联原 Issue。这一流程不需要仓库写权限，也不会自动获得协作者权限。至少每 14 天更新一次进展；需要更多时间时可以直接说明。连续 14 天没有进展或延期说明时，维护者可以释放认领并重新添加 `help wanted`，不会因此惩罚贡献者。
5. **交付：** PR 使用 `Closes #编号`，逐项满足已确认的验收标准、测试、双语文档和安全要求。只有 PR 合并才表示需求完成；维护者可以在评审中缩小范围或要求拆分后续 Issue。

拼写修正、小型文档修正、维护者直接请求的改动可以跳过正式认领。其他用户可见行为、持久化数据、导入恢复、回收站或永久删除相关改动，必须先有 Issue 和维护者确认。

## 分支、提交与 PR 命名

- 分支使用 `<type>/<short-description>`；`type` 可为 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore` 或 `ci`。
- `short-description` 使用简短、小写的英文，单词之间用连字符，例如 `feat/archive-filter` 或 `fix/import-timeout`。分支名不必重复 Issue 编号。
- 提交信息和 PR 标题使用 Conventional Commits 格式 `<type>(<optional-scope>): <description>`，描述使用现在时命令语气并保持在 72 个字符内，例如 `fix(import): prevent restore timeout`。
- 一个分支和 PR 只处理一项逻辑改动；Issue 关联写在 PR 描述中，例如 `Closes #42`。
- `release/*` 分支仅由维护者使用。安全漏洞不得使用公开分支或 PR，请按 [SECURITY.md](SECURITY.md) 私密报告。

## 贡献范围与维护者控制文件

外部贡献者可以修改已确认 Issue 的验收标准所必需的产品代码、自动化测试，以及与该行为直接相关的 README 和用户指南。与认领范围无关的改动应拆分到另一个先经确认的 Issue 和 PR。

除非关联 Issue 中有维护者的明确书面要求，外部 PR 不得修改：

- 项目治理、法律与安全文件：`LICENSE`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md` 和 `SUPPORT.md`。
- 所有权、社区入口与自动化配置：`.github/CODEOWNERS`、`.github/ISSUE_TEMPLATE/**`、`.github/PULL_REQUEST_TEMPLATE.md` 和 `.github/workflows/**`。
- 发布与市场资产：包版本号、Tag、GitHub Release、npm 发布、插件市场条目、`screenshots.json`、`assets/brand/**` 和 `assets/screenshots/**`。

贡献者在 Fork 中可以提出任何改动，但只有通过 `@Ultronen` Code Owner 审核并合并的内容才代表项目决定。超出上述边界的外部 PR 会被要求移除越界改动，或直接关闭。

## 本地开发

要求 Node.js 18 或 24。克隆仓库后运行：

```sh
npm ci
npm test
npm pack --dry-run --json
```

PR 应保持单一目的，并说明用户可见变化、兼容性影响、数据安全影响和验证结果。界面变化应附截图。

不得提交本地插件数据、数据库、聊天内容、附件、日志、访问令牌、`.DS_Store` 或测试临时文件。对导入、恢复、回收站和永久删除流程的改动必须包含失败与回滚场景测试。

## Pull request checklist

1. 完整阅读并遵守本贡献指南。
2. 外部贡献者在自己的 Fork 中，从上游最新 `main` 创建符合命名规则的单一目的短期分支，并向上游 `main` 提交 PR。
3. 只修改已确认范围所必需的文件；未经书面要求不修改维护者控制文件。
4. 添加或更新能够证明行为的测试。
5. 同时维护中文和英文用户文档。
6. 运行完整测试和 npm 包内容检查。
7. 等待 GitHub CI 和 Code Owner 审核通过，并处理所有评审意见。

## English summary

Use Discussions for questions, Issues for reproducible bugs, and private vulnerability reporting for security problems. Keep pull requests focused, add tests, update both language documents when user behavior changes, and run `npm test` plus `npm pack --dry-run --json`. Never commit local plugin data, conversations, attachments, credentials, logs, or temporary files.

### Branch, commit, and pull request naming

- Name branches `<type>/<short-description>`, where `type` is `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, or `ci`.
- Write the short description in concise lowercase English with hyphens, such as `feat/archive-filter` or `fix/import-timeout`. The issue number does not need to be repeated in the branch name.
- Use Conventional Commits for commit messages and PR titles: `<type>(<optional-scope>): <description>`. Use imperative present tense and keep the title within 72 characters, for example `fix(import): prevent restore timeout`.
- Keep one logical change per branch and PR. Link the issue in the PR description, for example `Closes #42`.
- `release/*` branches are maintainer-only. Never disclose a vulnerability in a public branch or PR; follow [SECURITY.md](SECURITY.md) instead.

### Contribution scope and maintainer-controlled files

External contributors may modify the product code, automated tests, and directly related README or user-guide content required by the confirmed acceptance criteria. Unrelated changes belong in a separate Issue and PR that the maintainer has confirmed first.

Unless the linked Issue contains an explicit written request from the maintainer, external pull requests must not modify:

- Project governance, legal, and security files: `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and `SUPPORT.md`.
- Ownership, community-entry, and automation configuration: `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md`, and `.github/workflows/**`.
- Release and marketplace assets: the package version, tags, GitHub Releases, npm publication, marketplace entries, `screenshots.json`, `assets/brand/**`, and `assets/screenshots/**`.

Contributors can propose any change in their forks, but only content reviewed and merged by the `@Ultronen` Code Owner represents a project decision. An external PR outside these boundaries will be asked to remove the out-of-scope changes or may be closed.

### Community proposals and claims

Anyone may propose a feature, but opening an issue starts review; it does not add the feature to the roadmap. The maintainer retains the final decision on product direction, data-safety boundaries, scope, merge, and release.

1. **Proposal:** describe the user problem, observable acceptance criteria, scope boundaries, and data impact. The automatic `enhancement` label classifies the proposal but does not mean it is accepted.
2. **Ready to claim:** the maintainer confirms the scope and acceptance criteria in writing and adds `help wanted`. Only then is implementation open to community contributors. `good first issue` marks a bounded newcomer-friendly task.
3. **Claim:** comment with the intended approach, planned tests, and an expected first progress update. After confirming the claim, the maintainer adds `claimed` and removes `help wanted`. One contributor is confirmed at a time by default; avoid substantial implementation before confirmation.
4. **In progress:** external contributors first fork the repository, sync the fork with the latest upstream `main`, and create a focused short-lived branch in the fork. Open a linked Draft PR from that branch to `Ultronen/dsh-archived-chats:main` early. This workflow does not require repository write access and does not automatically grant collaborator access. Post an update at least every 14 days. Ask for more time when needed. After 14 days without an update or extension request, the maintainer may release the claim and restore `help wanted`, with no penalty to the contributor.
5. **Delivery:** use `Closes #number` and meet the confirmed acceptance criteria, tests, bilingual documentation, and safety requirements. An issue is complete only when its PR is merged; review may narrow the scope or move follow-up work into separate issues.

Typos, small documentation fixes, and changes directly requested by the maintainer may skip formal claiming. Other user-visible behavior and all changes involving persisted data, import or restore, the Recycle Bin, or permanent deletion require an issue and maintainer confirmation first.
