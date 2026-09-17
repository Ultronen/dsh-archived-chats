## 1.2.0 — 简化历史版本与回收站 / Simplify History and Recycle Bin

### 中文

本次更新取消独立的历史版本功能，将日常使用简化为归档管理、回收站恢复与主动导出备份。**升级不会删除已有聊天或快照。**

- **主导航调整为四项**：归档、回收站、空间与策略、来源与分支。独立“历史版本”标签移除。
- **归档不再创建历史快照**：普通归档和工作区批量归档只改变归档状态，不再持续保存多个版本。归档成功提示仍支持查看与撤销。
- **回收站继续负责可撤销删除**：移入回收站时仍保存恢复所需的保护数据，可从回收站恢复。确认永久删除会删除对应聊天及关联快照。长期保存请主动导出 ZIP 备份。
- **已有数据保留**：旧快照可在“空间与策略 → 旧版数据”中预览、恢复为新的归档副本后导出，或经确认后删除。恢复不会覆盖原聊天；正在保护回收站恢复的快照不会出现在可清理的旧版数据列表中。回收站恢复后留下的非活动保护快照也可在此管理。
- **保留策略简化**：移除历史版本数量、快照保存天数、快照容量配额三个设置。旧策略文件仍兼容读取，但这些旧规则不再产生快照删除建议。仅保留回收站天数设置；保存策略不会删除数据，必须预览并确认后才执行清理。
- **可靠性与界面**：空间统计加载失败时，旧版数据仍可独立访问；恢复或删除旧数据后立即更新空间统计，并保留未保存的策略草稿。优化窄屏统计布局，同步更新中英文文档及八张产品截图。

兼容性提示：旧的 `POST /history/capture` 接口现返回 `410 history-capture-retired`。已有快照的读取、恢复与删除接口保留，服务于旧数据迁移。依赖历史捕获的自定义客户端应停止调用该接口。

验证：236 项自动化测试通过；独立代码审查通过；桌面、390px 窄屏、空间统计失败场景和本地 DSH 运行验证通过。

### English

This release retires the standalone History feature and simplifies everyday use around archive management, Recycle Bin recovery, and explicit ZIP backups. **Upgrading does not delete existing chats or snapshots.**

- Navigation now contains four views: Archived, Recycle Bin, Storage & Retention, and Origins & Branches.
- Normal and workspace bulk archiving no longer capture historical versions. Archive success still offers View and Undo.
- Moving a chat to the Recycle Bin still preserves recovery data. Restore it from the Recycle Bin; confirmed permanent deletion removes the chat and its associated snapshots. Export ZIP backups for long-term preservation.
- Existing snapshots remain available under **Storage & Retention → Legacy data** for preview, recovery as a new archived copy for export, or confirmed deletion. Recovery never overwrites the original. Active Recycle Bin protection snapshots are excluded from the legacy cleanup list; inactive protection snapshots retained after recovery can be managed there.
- History count, snapshot age, and snapshot quota controls are retired. Old policy files remain readable, but those rules no longer propose snapshot deletion. Only Recycle Bin age remains; saving a policy does not delete data, and cleanup requires preview and confirmation.
- Legacy data remains accessible when storage statistics fail. Recovery and deletion refresh storage totals without losing unsaved policy edits. Narrow-screen storage cards, bilingual documentation, and all eight product screenshots are updated.

Compatibility: `POST /history/capture` now returns `410 history-capture-retired`. Existing snapshot read, recovery, and deletion endpoints remain for migration. Custom clients must stop requesting historical captures.

Validation: 236 automated tests, independent code review, desktop and 390px browser checks, storage-error recovery access, and local DSH runtime verification passed.
