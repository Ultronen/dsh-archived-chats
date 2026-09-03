> 提交前务必完整阅读 [贡献指南 / Contributing Guide](https://github.com/Ultronen/dsh-archived-chats/blob/main/CONTRIBUTING.md)。
>
> Before submitting, you must read the guide in full.

- [ ] 我已完整阅读并遵守贡献指南 / I have read and followed the Contributing Guide
- [ ] 分支名、提交信息和 PR 标题符合贡献指南 / Branch, commit, and PR naming follows the guide

## 关联 Issue / Linked issue

<!-- 使用 `Closes #123`。较大的功能与行为变更应先完成需求评审和认领；维护者直接请求的改动或小型维护可说明例外。 -->

Closes #

- [ ] 关联 Issue 已标记 `claimed`，或曾标记 `help wanted` 且我已留言认领；不适用时已在上方说明

## 变更摘要 / Summary

<!-- 说明为什么需要这项变更，以及它解决了什么问题。 -->

## 用户与兼容性影响 / User and compatibility impact

- 用户可见变化：
- DeepSeek Harness 兼容性：
- 持久化数据、导入/恢复或删除影响：

## 验证 / Verification

- [ ] `npm test`
- [ ] `npm pack --dry-run --json`
- [ ] 实现满足关联 Issue 中维护者确认的验收标准
- [ ] 新增或更新了覆盖本次行为的测试
- [ ] 界面变化附有截图；无界面变化则说明不适用
- [ ] 用户行为变化已同步更新中文和英文文档

## 安全与发布边界 / Safety and release boundaries

- [ ] 未提交本地数据、聊天内容、附件、日志、凭据或临时文件
- [ ] 已检查失败、回滚、并发和永久删除场景，或说明不适用
- [ ] 只修改已确认范围所必需的文件；未经书面要求未修改维护者控制文件
- [ ] 未修改版本号、标签、npm 发布或插件市场条目，除非维护者明确要求
