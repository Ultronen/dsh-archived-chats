// dsh-archived-chats — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-archived-chats/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with require()
// resolved against the shell's module table — the same shape the shipped ui-*
// packages emit.
//
// Archive Management adds search, preview, recycle, and batch management in
// Settings. Official workspace actions retain their own feedback; plugin
// archive results reuse the Host Toast component when available.
// Durable changes still flow only through
// /plugins/dsh-archived-chats/* routes and the Host workspace registry.
window.__ModuleLoader__.load({
	id: "dsh-archived-chats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let jsx = require("react/jsx-runtime");
		let _react = require("react");
		function resolvePreviewPrimitives(requireFn) {
			let source = null;
			try { source = requireFn("@deepseek-ai/dsh-client-ui-primitives"); } catch { source = null; }
			const component = (value) => typeof value === "function" || (value && typeof value === "object"
				&& [Symbol.for("react.memo"), Symbol.for("react.forward_ref")].includes(value.$$typeof)) ? value : null;
			return Object.freeze({
				MarkdownText: component(source?.MarkdownText),
				Toast: component(source?.Toast),
				DisclosureRow: component(source?.DisclosureRow),
				JsonBlock: component(source?.JsonBlock),
				IconThink: component(source?.IconThinkOutline14),
				IconPrompt: component(source?.IconBrowseOutline16),
				IconSearch: component(source?.IconSearchOutlineRegular),
			});
		}
		const previewPrimitives = resolvePreviewPrimitives(require);
		//#region constants
		const SETTINGS_NS = "settings.archived-chats";
		const API_BASE = "/plugins/dsh-archived-chats";
		const GUARD_HEADER = "x-dsh-archived-chats";
		const STYLE_ID = "dsh-archived-chats-css";
		const KEY_COLLAPSED = "dsh-archived-chats:collapsed";
		//#endregion

		//#region collapsed-group persistence (browser-local, like every visual preference)
		function readCollapsed() {
			try {
				const raw = window.localStorage.getItem(KEY_COLLAPSED);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
			} catch { return {}; }
		}
		function writeCollapsed(map) {
			try { window.localStorage.setItem(KEY_COLLAPSED, JSON.stringify(map)); } catch { /* quota — ignore */ }
		}
		//#endregion

		//#region locale
		const zh = {
			"locale.intl": "zh-CN",
			"nav": "归档管理",
				"page.title": "归档管理",
				"page.description": "查看、搜索和管理会话归档",
				"tab.archived": "已归档",
				"tab.trash": "回收站",
				"tab.insights": "空间与策略",
				"tab.lineage": "来源与分支",
				"tab.about": "关于",
				"about.updateAvailable": "有新版本可用",
				"help.label": "{label}说明",
			"trash.viewArchived": "查看已归档",
				"trash.listUnverified": "回收站目录无法读取：下面的列表可能包含已删除的聊天，归档修改已暂停。",
				"insights.loading": "正在分析空间…",
				"insights.error": "空间分析暂不可用",
				"insights.scopeNote": "这里只统计已归档会话和回收站当前引用的保护快照。归档列表为空时仍可能有保护快照，因为回收记录会保留快照以备恢复。未被回收记录引用的保护快照会在启动时自动清理。残留会话单独检查，不计入已统计总量。",
				"insights.sessions": "会话目录",
				"insights.snapshots": "保护快照",
				"insights.total": "已统计总量",
				"insights.duplicate": "重复快照附件",
				"insights.unavailable": "不可用会话 / 降级快照",
				"insights.snapshot.active": "回收站使用中的恢复快照",
				"insights.snapshot.history": "未被回收记录引用的快照",
				"insights.snapshot.degraded": "不可用的恢复快照",
				"insights.snapshot.original": "原会话",
				"insights.snapshot.created": "创建时间",
				"insights.snapshot.id": "快照 ID",
				"insights.details": "查看明细",
				"insights.openSessions": "查看会话目录明细",
				"insights.openSnapshots": "查看保护快照明细",
				"insights.sessionDetails": "会话目录明细",
				"insights.snapshotDetails": "保护快照明细",
				"insights.searchSessions": "搜索标题、项目或会话 ID",
				"insights.searchSnapshots": "搜索原会话、会话 ID 或快照 ID",
				"insights.scope.archive": "已归档",
				"insights.scope.trash": "回收站",
				"insights.detailsEmpty": "没有匹配的明细",
				"retention.history": "回收站保护快照",
				"retention.snapshotAge": "已取消的快照保留天数",
				"retention.quota": "快照容量上限（字节）",
				"retention.recycleAge": "回收站自动清理",
				"retention.custom": "自定义",
				"retention.days": "{days} 天",
				"retention.customDays": "自定义天数（1–3650）",
				"retention.disabled": "关闭",
				"retention.save": "保存策略",
				"retention.close": "关闭",
				"retention.preview": "查看可清理项",
				"retention.apply": "应用所选清理",
				"retention.empty": "当前已保存策略没有需要清理的回收站聊天。未启用保留天数时，不会产生清理项。",
				"retention.saved": "策略已保存",
				"retention.note": "开启后，聊天从移入回收站时计时，到期自动永久删除，无需再次确认。DSH 关闭期间暂停，重新启动后补清理。",
                "retention.autoTitle": "确认自动清理策略",
                "retention.autoConfirm": "确认并保存",
                "retention.autoBody": "每条聊天在回收站保留 {days} 天后将自动永久删除，无法恢复。已有 {count} 条聊天达到期限，保存后会在下一次检查时清理。",
                "retention.confirmationRetry": "设置或待清理聊天已变化，或确认已过期。请重新保存并核对。",
				"retention.snapshotCandidate": "保护快照由启动流程自动清理",
				"retention.trashCandidate": "永久删除回收站会话",
				"retention.projected": "仅列出按已保存策略可清理的项目；勾选并确认后才会永久删除。",
				"retention.purgeWarning": "所选回收站项会永久删除原会话及其全部保护快照，无法撤销。",
				"retention.reason.history-count": "超过历史数量",
				"retention.reason.snapshot-age": "超过快照年龄",
				"retention.reason.snapshot-quota": "超过快照容量",
				"retention.reason.recycle-age": "超过回收站年龄",
				"retention.applied": "清理完成",
				"retention.result": "已完成 / 失败",
				"lineage.origin.session": "普通会话",
				"lineage.origin.subagent": "子智能体",
                "lineage.origin.fork": "分支会话",
                "lineage.origin.root": "原始会话",
                "lineage.origin.unknown": "来源待确认",
				"lineage.copyId": "复制 ID",
				"lineage.copiedId": "已复制",
				"lineage.loading": "正在读取来源与分支…",
				"lineage.error": "来源与分支暂不可用",
				"lineage.scopeNote": "以已归档会话为中心，展示父级来源和下级分支，包含相关的未归档会话。仅列出相关工作区；重复的来源参考不计入数量。",
				"lineage.search": "搜索会话或项目",
				"lineage.projectFilter": "筛选项目",
				"lineage.statusFilter": "筛选状态",
				"lineage.statusAll": "全部状态",
                "lineage.relatedWorkspaces": "所有相关工作区",
                "lineage.noArchives": "暂无归档会话的来源与分支",
				"lineage.managedHeading": "归档与关联会话",
				"lineage.managedCount": "个会话",
				"lineage.expandAll": "全部展开",
				"lineage.collapseAll": "全部折叠",
				"lineage.searchFoldHint": "筛选期间保持匹配路径展开",
				"lineage.empty": "暂无符合条件的会话",
                "lineage.workspaceEmpty": "暂无会话",
                "lineage.trashUnavailable": "回收站状态暂不可用，当前仅显示官方归档状态。",
				"lineage.status.active": "未归档",
				"lineage.status.archived": "已归档",
				"lineage.status.trash": "回收站",
				"lineage.status.missing": "来源不可用",
				"lineage.untitled": "未命名会话",
				"lineage.sourceUnavailable": "来源信息不可用",
				"lineage.sourceContext": "来源于",
				"lineage.contextOnly": "仅作为来源参考",
				"lineage.start": "起始会话",
				"lineage.created": "创建于",
				"lineage.project": "项目",
				"lineage.delegation": "委派层级",
				"lineage.noBranches": "无分支",
				"lineage.details": "详情",
				"lineage.depth": "层级",
				"lineage.crossWorkspace": "来源工作区",
				"lineage.sourceId": "来源 ID",
				"lineage.diagnostic.missing-parent": "父会话缺失",
				"lineage.diagnostic.missing-parent.detail": "无法读取父会话的来源信息",
				"lineage.diagnostic.self-parent": "会话指向自身",
				"lineage.diagnostic.cycle": "检测到循环",
				"lineage.diagnostic.delegation-depth-mismatch": "委派深度不一致",
					"action.import": "导入备份",
					"action.export": "全部导出",
				"delete.all": "全部移至回收站",
				"import.action": "导入备份",
				"import.title": "导入归档备份",
				"import.inspecting": "正在检查备份…",
				"import.preview": "恢复前请确认要导入的会话",
				"import.package": "备份信息",
				"import.confirm": "恢复选中项",
				"import.cancel": "取消",
				"import.close": "关闭",
				"import.selectAll": "全选可恢复项",
				"import.clear": "清除选择",
				"import.conflict": "ID 冲突，将跳过",
				"import.workspaceWarning": "项目不存在，将保持未分组",
				"import.attachmentWarning": "包含附件引用，但不会恢复附件文件",
				"import.restored": "已恢复",
				"import.skipped": "已跳过",
				"import.expired": "预览已过期，请重新选择备份",
				"import.done": "备份恢复完成",
				"import.unsupported": "当前宿主无法无损恢复此备份，请保留 ZIP 并检查宿主兼容性。",
				"import.rollbackFailed": "恢复未完成，部分写入无法安全回滚，已保留相关文件。请保留 ZIP，排查后再重试；不要直接删除冲突会话。",
				"import.conflictChanged": "所选会话已存在或仍在回收／删除处理中，未覆盖已有内容。请重新选择备份核对。",
				"import.titlePublicationDegraded": "聊天已安全恢复，但标题可能需要打开聊天后才会出现在主列表。",
				"import.seededTitleLimitation": "聊天已安全恢复；当前宿主的冷启动列表无法发布分支标题，打开聊天后可正常显示。",
				"export.all": "全部导出",
				"menu.workspaceScope": "该工作区",
				"menu.allWorkspaces": "所有工作区",
				"export.selected": "导出选中",
				"menu.row": "更多聊天操作",
				"export.started": "已开始下载备份",
				"export.failed": "备份导出失败，应用仍保持打开，请刷新列表后重试",
				"export.tooLarge": "会话 {id} 超出备份限制，无法打包成可导入的备份。请取消选择它后重试。",
				"export.sourceInvalid": "导出源数据无效，无法打包成备份。",
				"export.timeout": "备份导出超时，未下载不完整文件，请稍后重试",
			"search.placeholder": "搜索会话标题、标签、备注和内容",
			"search.loading": "正在搜索聊天内容…",
			"search.error": "聊天内容搜索暂不可用",
			"search.contentMatch": "聊天内容命中",
			"preview.open": "查看对话",
			"preview.title": "归档对话预览",
			"preview.close": "关闭预览",
			"preview.loading": "正在读取对话…",
			"preview.error": "对话预览加载失败",
			"preview.empty": "这个归档暂无可预览的消息",
			"preview.more": "加载更多",
			"preview.timeline": "对话轮次导航",
			"preview.user": "用户",
			"preview.assistant": "助手",
			"preview.tool": "工具",
			"preview.system": "系统提示词",
			"preview.context": "上下文注入",
			"preview.reasoning": "思考",
			"preview.toolCall": "工具调用",
			"preview.toolResult": "工具结果",
			"preview.toolArguments": "参数",
			"preview.json": "JSON",
			"preview.unknown": "未知内容",
			"preview.copy": "复制",
			"preview.copied": "已复制",
			"preview.copyError": "无法复制，请允许剪贴板访问后重试",
			"preview.imageUnavailable": "图片不可用",
			"preview.readOnly": "只读预览",
			"preview.toolPending": "等待中",
			"preview.toolRunning": "运行中",
			"preview.toolComplete": "已完成",
			"preview.toolFailed": "失败",
			"filter.allChats": "全部聊天",
			"filter.type": "类型",
			"filter.normal": "普通会话",
			"filter.subagent": "子代理会话",
			"filter.allProjects": "所有工作区",
            "filter.scheduled": "定时任务",
            "filter.scheduleUnsupported": "当前宿主未启用定时任务服务",
            "filter.scheduleUnavailable": "暂时无法读取定时任务，请刷新重试",
			"sort.label": "排序方式",
			"sort.newest": "最近更新",
			"sort.oldest": "最早更新",
			"sort.title": "按标题",
			"group.noProject": "未分组",
			"chat.untitled": "未命名会话",
			"chat.unarchive": "取消归档",
			"unarchive.cwdMissing": "此聊天没有工作目录，当前宿主无法将它放回主聊天列表。已归档副本仍保留，可继续预览或导出。",
			"unarchive.authorityUnavailable": "暂时无法确认此聊天能否回到主列表。已归档副本未更改，请稍后重试。",
			"unarchive.deletionPending": "此聊天仍在删除处理中，现在不能取消归档。已归档副本仍保留。",
			"unarchive.pendingUnavailable": "暂时无法核对删除状态，未取消归档。已归档副本仍保留，请稍后重试。",
			"chat.delete": "删除",
			"chat.deleteArchived": "删除已归档的聊天",
			"chat.recycle": "移入回收站",
			"menu.deleteAllPermanently": "全部删除",
			"menu.unarchiveAll": "全部取消归档",
			"menu.deleteAll": "全部移入回收站",
			"menu.deletePermanently": "全部删除",
			"action.deleteAll": "全部删除",
			"group.collapse": "折叠",
			"group.expand": "展开",
			"confirm.deleteOne.title": "移至回收站？",
			"confirm.deleteOne.body": "会自动创建保护快照，之后可从回收站恢复",
			"confirm.deleteAll.title": "全部移至回收站？",
			"confirm.deleteGroup.title": "将该项目下的已归档聊天移至回收站？",
			"confirm.deleteSelected.title": "将选中的已归档聊天移至回收站？",
			"confirm.permanent.title": "直接永久删除已归档聊天？",
			"confirm.permanent.body": "这些聊天不会进入回收站，删除后无法恢复。",
			"confirm.permanent.confirm": "删除",
			"confirm.permanentAll.title": "永久删除所有归档聊天？",
			"confirm.cancel": "取消",
			"confirm.delete": "移至回收站",
			"trash.restore": "恢复",
			"trash.restoreAll": "全部恢复",
			"trash.purge": "永久删除",
			"trash.emptyAction": "清空回收站",
			"trash.empty": "回收站为空",
			"trash.loading": "正在读取回收站…",
			"trash.unavailable": "回收站暂不可用；归档管理仍可使用",
			"trash.status.ready": "保护快照可用",
			"trash.status.parked": "会话已停用，可恢复",
			"trash.status.degraded": "快照降级",
			"trash.status.purgePending": "删除未完成，可重试",
			"trash.attachments": "附件",
			"trash.confirm.title": "永久删除回收站中的会话？",
			"trash.confirm.body": "这将删除原会话和保护快照，且无法撤销",
			"trash.confirm.degraded": "部分项的保护快照不可用，但原会话仍会被永久删除。",
			"trash.confirm.emptyTitle": "清空回收站？",
			"trash.confirm.emptyBody": "这将永久删除回收站中所有工作区的会话和保护快照。",
			"trash.moved": "已移至回收站",
			"trash.restored": "已恢复会话",
			"trash.purged": "已永久删除",
			"trash.undo": "撤销",
			"state.loading": "加载中…",
			"state.empty": "暂无已归档会话",
			"state.emptyFiltered": "未找到匹配的会话",
			"state.error": "加载失败",
			"state.retry": "重试",
			"notice.dismiss": "关闭",
			"tag.filter": "全部标签",
			"tag.edit": "编辑标签与备注",
			"tag.input": "标签",
			"tag.placeholder": "输入标签后按回车",
			"note.label": "备注",
			"note.placeholder": "添加备注（最多 2,000 字）",
			"meta.save": "保存",
			"meta.saved": "已保存标签与备注",
			"meta.unavailable": "元数据不可用，暂无法编辑标签与备注",
			"stats.loading": "正在统计存储…",
			"stats.error": "存储统计不可用",
			"stats.unavailable": "部分会话无法统计",
			"workspaceArchive.action": "归档会话",
			"workspaceArchive.settingsAction": "批量归档",
				"workspaceArchive.chooseTitle": "选择工作区",
				"workspaceArchive.chooseBody": "选择一个或多个需要归档会话的工作区。",
				"workspaceArchive.selectAll": "全选",
				"workspaceArchive.chooseConfirm": "确定",
				"workspaceArchive.eligibleCount": "{count} 个可归档会话",
				"workspaceArchive.liveCount": "{count} 个运行中会话",
				"workspaceArchive.noWorkspaces": "当前没有可归档的工作区。",
			"workspaceArchive.loadError": "无法载入工作区，请重试。",
			"workspaceArchive.close": "关闭项目归档",
			"workspaceArchive.loading": "正在准备归档…",
			"workspaceArchive.skipped": "跳过的聊天",
				"workspaceArchive.confirmTitle": "归档此工作区的全部会话？",
				"workspaceArchive.confirmBody": "这会将「{workspace}」中的会话归档。之后可在“已归档”中查看。",
				"workspaceArchive.confirmBodyMany": "这会将所选工作区中的会话归档。之后可在“已归档”中查看。",
			"workspaceArchive.skippedLive": "将跳过 {count} 个仍在运行或状态未确认的会话。",
			"workspaceArchive.apply": "确认归档",
			"workspaceArchive.applying": "正在归档…",
			"workspaceArchive.success": "归档成功，已归档 {count} 个会话",
			"workspaceArchive.result": "批量归档结果",
			"workspaceArchive.archived": "已归档",
			"workspaceArchive.failed": "失败",
			"workspaceArchive.snapshotFailed": "保护快照未保存",
			"workspaceArchive.done": "完成",
			"workspaceArchive.unsupported": "当前 DSH 版本不支持按项目批量归档。",
			"workspaceArchive.error": "无法完成按项目批量归档，请重试。",
			"workspaceArchive.reason.session-live": "仍在运行或状态未确认，已跳过",
			"workspaceArchive.reason.session-archived": "已归档，已跳过",
			"workspaceArchive.reason.session-empty": "空白新会话，已跳过",
			"workspaceArchive.reason.session-unavailable": "会话内容无法确认，已跳过",
			"workspaceArchive.reason.session-workspace-changed": "项目成员已变化，已跳过",
			"workspaceArchive.reason.archive-failed": "归档失败",
			"workspaceArchive.reason.archive-uncommitted": "归档未完成",
			"workspaceArchive.reason.lifecycle-failed": "操作未完成",
			"workspaceArchive.status.captured": "保护快照已保存",
			"workspaceArchive.status.snapshot-failed": "保护快照未保存",
			"workspaceArchive.reason.stop-archive-unsupported": "当前 Host 不支持停止并归档，请先在官方界面停止任务。",
            "workspaceArchive.reason.unknown": "未完成",
			"workspaceArchive.retry": "重新准备",
			"tab.unarchived": "未归档",
			"unarchived.search": "搜索会话标题或 ID",
			"unarchived.empty": "暂无未归档会话",
			"unarchived.error": "未归档会话暂不可用，请重试。",
			"unarchived.loading": "正在加载会话…",
			"unarchived.archiveAll": "全部归档",
			"unarchived.archive": "归档",
			"unarchived.busy": "正在运行",
			"action.refresh": "刷新",
			"residual.cardTitle": "残留会话",
            "residual.count": "{count} 个",
            "residual.view": "查看明细",
            "residual.open": "查看残留会话明细",
            "residual.checking": "正在检查…",
            "residual.failed": "检查失败",
            "insights.sessionIssues": "{count} 个目录无法统计",
            "insights.snapshotIssues": "{count} 个恢复快照异常",
            "residual.title": "残留会话检查",
			"residual.note": "手动检查父会话已不存在的子代理会话。先预览或导出备份，再选择是否永久删除。",
			"residual.check": "开始检查",
			"residual.recheck": "重新检查",
			"residual.summary": "{count} 个残留会话 · 已测量 {size}",
			"residual.checked": "检查于 {time}",
			"residual.selected": "已选 {count} 个",
			"residual.select": "选择当前结果",
			"residual.search": "搜索标题、ID 或目录",
			"residual.empty": "未发现残留会话",
			"residual.backup": "导出备份",
			"orphans.loading": "正在读取残留会话…",
			"orphans.error": "残留会话暂不可用",
			"orphans.unavailable": "残留会话目录无法读取：下面的列表可能不完整。",
			"orphans.empty": "没有残留会话",
			"orphans.kind.subagent": "残留会话",
			"orphans.kind.blank": "空会话",
			"orphans.untitled": "未命名会话",
			"orphans.created": "创建于",
			"orphans.id": "会话 ID",
			"orphans.cwd": "工作目录",
			"orphans.parent": "父会话",
			"orphans.size": "大小",
			"orphans.selectAll": "全选",
			"orphans.clearSelection": "清除选择",
			"orphans.exportSelected": "导出选中项",
			"orphans.summary": "{count} 个残留会话，共 {size}",
			"orphans.delete": "永久删除",
			"orphans.delete.title": "永久删除残留会话？",
			"orphans.delete.body": "这会永久删除选中的 {count} 个残留会话及其目录，无法撤销。未选中的会话会保留。",
			"orphans.deleted": "已永久删除",
			"orphans.setChanged": "残留会话列表已变化，请重新选择。",
			"orphans.blocked": "超出备份限制",
			"orphans.exportPartial": "已导出 {count} 个会话；{skipped} 个超出备份限制的会话未包含在内（列表中已标记）。",
			"orphans.exportAllBlocked": "选中的会话都超出备份限制，无法导出。",
			"orphans.exportConfirm.title": "有会话超出备份限制",
			"orphans.exportConfirm.body": "{blocked} 个会话超出备份限制，无法打包成可导入的备份。取消勾选它们，导出其余 {keep} 个？",
			"orphans.exportConfirm.confirm": "取消勾选并导出",
		};
		const en = {
			"locale.intl": "en-US",
			"nav": "Archive Management",
				"page.title": "Archive Management",
				"page.description": "View, search, and manage archived chats",
				"tab.archived": "Archived",
				"tab.trash": "Recycle Bin",
				"tab.insights": "Storage & Retention",
				"tab.lineage": "Origins & Branches",
				"tab.about": "About",
				"about.updateAvailable": "Update available",
				"help.label": "Help: {label}",
			"trash.viewArchived": "View Archived",
				"trash.listUnverified": "The Recycle Bin catalog is unreadable: this list may include deleted chats, and archive changes are paused.",
				"insights.loading": "Analyzing storage…",
				"insights.error": "Storage insights are unavailable",
				"insights.scopeNote": "This page measures archived chats and protection snapshots currently referenced by Recycle Bin records. Protection snapshots can remain even when the archive list is empty, because recycle records retain snapshots for restoration. Unreferenced legacy snapshots are removed during startup. Residual chats are checked separately and excluded from the measured total.",
				"insights.sessions": "Session directories",
				"insights.snapshots": "Protection snapshots",
				"insights.total": "Measured total",
				"insights.duplicate": "Repeated snapshot attachments",
				"insights.unavailable": "Unavailable sessions / degraded snapshots",
				"insights.snapshot.active": "Recovery snapshot in use by Recycle Bin",
				"insights.snapshot.history": "Unreferenced snapshot",
				"insights.snapshot.degraded": "Unavailable recovery snapshot",
				"insights.snapshot.original": "Original chat",
				"insights.snapshot.created": "Created",
				"insights.snapshot.id": "Snapshot ID",
				"insights.details": "View details",
				"insights.openSessions": "View session directory details",
				"insights.openSnapshots": "View protection snapshot details",
				"insights.sessionDetails": "Session directory details",
				"insights.snapshotDetails": "Protection snapshot details",
				"insights.searchSessions": "Search titles, projects, or session IDs",
				"insights.searchSnapshots": "Search original chats, session IDs, or snapshot IDs",
				"insights.scope.archive": "Archived",
				"insights.scope.trash": "Recycle Bin",
				"insights.detailsEmpty": "No matching details",
				"retention.history": "Recycle Bin protection snapshots",
				"retention.snapshotAge": "Retired snapshot age setting",
				"retention.quota": "Snapshot quota in bytes",
				"retention.recycleAge": "Auto-empty Recycle Bin",
				"retention.custom": "Custom",
				"retention.days": "{days} days",
				"retention.customDays": "Custom days (1–3650)",
				"retention.disabled": "Disabled",
				"retention.save": "Save policy",
				"retention.close": "Close",
				"retention.preview": "Review cleanup items",
				"retention.apply": "Apply selected cleanup",
				"retention.empty": "The saved policy has no Recycle Bin chats to clean up. Enable a retention period to list eligible items.",
				"retention.saved": "Policy saved",
				"retention.note": "When enabled, each chat is permanently deleted after its time in the Recycle Bin expires, without another confirmation. Cleanup pauses while DSH is closed and catches up on startup.",
                "retention.autoTitle": "Confirm automatic cleanup",
                "retention.autoConfirm": "Confirm and save",
                "retention.autoBody": "Each chat will be permanently deleted after {days} days in the Recycle Bin and cannot be recovered. {count} existing chats have expired and will be removed at the next check after saving.",
                "retention.confirmationRetry": "The policy or affected chats changed, or the confirmation expired. Save again to review the current details.",
				"retention.snapshotCandidate": "Legacy snapshots are cleaned at startup",
				"retention.trashCandidate": "Permanently delete recycled chat",
				"retention.projected": "Items are based on the saved policy. Permanent deletion requires selection and confirmation.",
				"retention.purgeWarning": "Selected recycle items permanently remove the original chat and every protection snapshot. This cannot be undone.",
				"retention.reason.history-count": "Exceeds history count",
				"retention.reason.snapshot-age": "Exceeds snapshot age",
				"retention.reason.snapshot-quota": "Exceeds snapshot quota",
				"retention.reason.recycle-age": "Exceeds recycle age",
				"retention.applied": "Cleanup completed",
				"retention.result": "Applied / failed",
				"lineage.origin.session": "Session",
				"lineage.origin.subagent": "Subagent",
                "lineage.origin.fork": "Fork",
                "lineage.origin.root": "Original chat",
                "lineage.origin.unknown": "Unknown origin",
				"lineage.copyId": "Copy ID",
				"lineage.copiedId": "Copied",
				"lineage.loading": "Loading origins and branches…",
				"lineage.error": "Origins and branches are unavailable",
				"lineage.scopeNote": "Shows archived chats with their ancestors and descendants, including related unarchived chats. Only related workspaces are listed; duplicate source references are not counted.",
				"lineage.search": "Search chats or projects",
				"lineage.projectFilter": "Filter by project",
				"lineage.statusFilter": "Filter status",
				"lineage.statusAll": "All statuses",
				"lineage.managedHeading": "Archived and related chats",
                "lineage.relatedWorkspaces": "Related workspaces",
                "lineage.noArchives": "No origins or branches for archived chats",
				"lineage.managedCount": "chats",
				"lineage.expandAll": "Expand all",
				"lineage.collapseAll": "Collapse all",
				"lineage.searchFoldHint": "Matching paths stay expanded while filtering",
				"lineage.empty": "No matching chats",
                "lineage.workspaceEmpty": "No chats",
                "lineage.trashUnavailable": "Recycle status is unavailable; only the official archive state is shown.",
				"lineage.status.active": "Unarchived",
				"lineage.status.archived": "Archived",
				"lineage.status.trash": "Recycle Bin",
				"lineage.status.missing": "Source unavailable",
				"lineage.untitled": "Untitled chat",
				"lineage.sourceUnavailable": "Source information unavailable",
				"lineage.sourceContext": "Source",
				"lineage.contextOnly": "Source context only",
				"lineage.start": "Starting chat",
				"lineage.created": "Created",
				"lineage.project": "Project",
				"lineage.delegation": "Delegation level",
				"lineage.noBranches": "No branches",
				"lineage.details": "Details",
				"lineage.depth": "Level",
				"lineage.crossWorkspace": "Source workspace",
				"lineage.sourceId": "Source ID",
				"lineage.diagnostic.missing-parent": "Missing parent",
				"lineage.diagnostic.missing-parent.detail": "Source information for the parent chat is unavailable",
				"lineage.diagnostic.self-parent": "Self-parent link",
				"lineage.diagnostic.cycle": "Cycle detected",
				"lineage.diagnostic.delegation-depth-mismatch": "Delegation depth mismatch",
					"action.import": "Import backup",
					"action.export": "Export all",
				"delete.all": "Move all to Recycle Bin",
				"import.action": "Import backup",
				"import.title": "Import archived backup",
				"import.inspecting": "Inspecting backup…",
				"import.preview": "Review the sessions before restoring",
				"import.package": "Backup details",
				"import.confirm": "Restore selected",
				"import.cancel": "Cancel",
				"import.close": "Close",
				"import.selectAll": "Select restorable",
				"import.clear": "Clear selection",
				"import.conflict": "ID conflict, will be skipped",
				"import.workspaceWarning": "Workspace is missing; will stay ungrouped",
				"import.attachmentWarning": "Attachment references found; attachment files are not restored",
				"import.restored": "Restored",
				"import.skipped": "Skipped",
				"import.expired": "The preview expired. Choose the backup again",
				"import.done": "Backup restore completed",
				"import.unsupported": "This Host cannot restore this backup losslessly. Keep the ZIP and check Host compatibility.",
				"import.rollbackFailed": "Restore was incomplete and some writes could not be safely rolled back. Related files were retained. Keep the ZIP and investigate before retrying; do not delete conflicting chats.",
				"import.conflictChanged": "Selected chats already exist or remain in recycle/deletion processing. Existing data was not overwritten. Choose the backup again to review.",
				"import.titlePublicationDegraded": "The chat was restored safely, but its title may not appear in the main list until the chat is opened.",
				"import.seededTitleLimitation": "The chat was restored safely. This Host cannot publish a branched title in its cold-start list; opening the chat will display it normally.",
				"export.all": "Export all",
				"menu.workspaceScope": "This workspace",
				"menu.allWorkspaces": "All workspaces",
				"export.selected": "Export selected",
				"menu.row": "More chat actions",
				"export.started": "Backup download started",
				"export.failed": "Backup export failed. The app remains open; refresh the list and try again",
				"export.tooLarge": "Chat {id} exceeds the backup limit and cannot be packaged into an importable backup. Deselect it and try again.",
				"export.sourceInvalid": "The export source is invalid and cannot be packaged into a backup.",
				"export.timeout": "Backup export timed out. No incomplete file was downloaded; try again later",
			"search.placeholder": "Search titles, tags, notes, and conversation content",
			"search.loading": "Searching conversation content…",
			"search.error": "Conversation-content search is unavailable",
			"search.contentMatch": "Conversation match",
			"preview.open": "View conversation",
			"preview.title": "Archived conversation preview",
			"preview.close": "Close preview",
			"preview.loading": "Loading conversation…",
			"preview.error": "Conversation preview failed to load",
			"preview.empty": "This archive has no previewable messages",
			"preview.more": "Load more",
			"preview.timeline": "Conversation timeline",
			"preview.user": "User",
			"preview.assistant": "Assistant",
			"preview.tool": "Tool",
			"preview.system": "System prompt",
			"preview.context": "Injected context",
			"preview.reasoning": "Reasoning",
			"preview.toolCall": "Tool call",
			"preview.toolResult": "Tool result",
			"preview.toolArguments": "Arguments",
			"preview.json": "JSON",
			"preview.unknown": "Unknown content",
			"preview.copy": "Copy",
			"preview.copied": "Copied",
			"preview.copyError": "Could not copy. Allow clipboard access and try again",
			"preview.imageUnavailable": "Image unavailable",
			"preview.readOnly": "Read-only preview",
			"preview.toolPending": "Pending",
			"preview.toolRunning": "Running",
			"preview.toolComplete": "Complete",
			"preview.toolFailed": "Failed",
			"filter.allChats": "All chats",
			"filter.type": "Type",
			"filter.normal": "Regular chats",
			"filter.subagent": "Subagent chats",
			"filter.allProjects": "All workspaces",
            "filter.scheduled": "Scheduled tasks",
            "filter.scheduleUnsupported": "Scheduled tasks are not enabled on this Host",
            "filter.scheduleUnavailable": "Scheduled tasks are unavailable. Refresh to retry.",
			"sort.label": "Sort order",
			"sort.newest": "Recently updated",
			"sort.oldest": "Least recently updated",
			"sort.title": "Title",
			"group.noProject": "Ungrouped",
			"chat.untitled": "Untitled chat",
			"chat.unarchive": "Unarchive",
			"unarchive.cwdMissing": "This chat has no working directory, so this Host cannot return it to the main chat list. Its archived copy is preserved for preview and export.",
			"unarchive.authorityUnavailable": "The Host cannot currently confirm that this chat can return to the main list. Its archived copy is unchanged; try again later.",
			"unarchive.deletionPending": "This chat is still in deletion processing and cannot be unarchived yet. Its archived copy is preserved.",
			"unarchive.pendingUnavailable": "The deletion state cannot be checked right now, so the chat was not unarchived. Its archived copy is preserved; try again later.",
			"chat.delete": "Delete",
			"chat.deleteArchived": "Delete archived chat",
			"chat.recycle": "Move to Recycle Bin",
			"menu.deleteAllPermanently": "Delete all",
			"menu.unarchiveAll": "Unarchive all",
			"menu.deleteAll": "Move all to Recycle Bin",
			"menu.deletePermanently": "Delete all",
			"action.deleteAll": "Delete all",
			"group.collapse": "Collapse",
			"group.expand": "Expand",
			"confirm.deleteOne.title": "Move to Recycle Bin?",
			"confirm.deleteOne.body": "A protection snapshot is created automatically so you can restore this chat later",
			"confirm.deleteAll.title": "Move all to Recycle Bin?",
			"confirm.deleteGroup.title": "Move this project's archived chats to Recycle Bin?",
			"confirm.deleteSelected.title": "Move selected archived chats to Recycle Bin?",
			"confirm.permanent.title": "Permanently delete archived chats directly?",
			"confirm.permanent.body": "These chats will skip the Recycle Bin and cannot be recovered after deletion.",
			"confirm.permanent.confirm": "Delete",
			"confirm.permanentAll.title": "Permanently delete every archived chat?",
			"confirm.cancel": "Cancel",
			"confirm.delete": "Move to Recycle Bin",
			"trash.restore": "Restore",
			"trash.restoreAll": "Restore all",
			"trash.purge": "Delete permanently",
			"trash.emptyAction": "Empty Recycle Bin",
			"trash.empty": "Recycle Bin is empty",
			"trash.loading": "Loading Recycle Bin…",
			"trash.unavailable": "Recycle Bin is unavailable; archived-chat management remains available",
			"trash.status.ready": "Protection snapshot ready",
			"trash.status.parked": "Session parked and restorable",
			"trash.status.degraded": "Snapshot degraded",
			"trash.status.purgePending": "Deletion incomplete; retry available",
			"trash.attachments": "attachments",
			"trash.confirm.title": "Permanently delete recycled chat?",
			"trash.confirm.body": "This removes the original chat and protection snapshot and cannot be undone",
			"trash.confirm.degraded": "Some protection snapshots are unavailable, but the original chats will still be permanently deleted.",
			"trash.confirm.emptyTitle": "Empty Recycle Bin?",
			"trash.confirm.emptyBody": "This permanently deletes the chats and protection snapshots from every workspace in the Recycle Bin.",
			"trash.moved": "Moved to Recycle Bin",
			"trash.restored": "Chat restored",
			"trash.purged": "Permanently deleted",
			"trash.undo": "Undo",
			"state.loading": "Loading…",
			"state.empty": "No archived chats",
			"state.emptyFiltered": "No matching chats found",
			"state.error": "Failed to load",
			"state.retry": "Retry",
			"notice.dismiss": "Dismiss",
			"tag.filter": "All tags",
			"tag.edit": "Edit tags and note",
			"tag.input": "Tags",
			"tag.placeholder": "Type a tag and press Enter",
			"note.label": "Note",
			"note.placeholder": "Add a note (up to 2,000 characters)",
			"meta.save": "Save",
			"meta.saved": "Tags and note saved",
			"meta.unavailable": "Metadata unavailable, editing tags and notes is disabled",
			"stats.loading": "Measuring storage…",
			"stats.error": "Storage statistics unavailable",
			"stats.unavailable": "Some sessions could not be measured",
			"workspaceArchive.action": "Archive chats",
			"workspaceArchive.settingsAction": "Bulk archive",
				"workspaceArchive.chooseTitle": "Choose a workspace",
				"workspaceArchive.chooseBody": "Choose one or more workspaces whose chats you want to archive.",
				"workspaceArchive.selectAll": "Select all",
				"workspaceArchive.chooseConfirm": "Confirm",
				"workspaceArchive.eligibleCount": "{count} chats available",
				"workspaceArchive.liveCount": "{count} running chats",
				"workspaceArchive.noWorkspaces": "There are no workspaces with chats available to archive.",
			"workspaceArchive.loadError": "Could not load workspaces. Try again.",
			"workspaceArchive.close": "Close workspace archive",
			"workspaceArchive.loading": "Preparing archive…",
			"workspaceArchive.skipped": "Skipped chats",
				"workspaceArchive.confirmTitle": "Archive all chats in this workspace?",
				"workspaceArchive.confirmBody": "This will archive chats in \"{workspace}\". You can find them later under Archived in Archive Management.",
				"workspaceArchive.confirmBodyMany": "This will archive chats in the selected workspaces. You can find them later under Archived.",
			"workspaceArchive.skippedLive": "Skipping {count} running chats or chats with unconfirmed status.",
			"workspaceArchive.apply": "Confirm archive",
			"workspaceArchive.applying": "Archiving…",
			"workspaceArchive.success": "Archive complete: {count} chats archived",
			"workspaceArchive.result": "Workspace archive result",
			"workspaceArchive.archived": "Archived",
			"workspaceArchive.failed": "Failed",
			"workspaceArchive.snapshotFailed": "Protection snapshot was not saved",
			"workspaceArchive.done": "Done",
			"workspaceArchive.unsupported": "This DSH version does not support workspace bulk archive.",
			"workspaceArchive.error": "Could not complete workspace bulk archive. Try again.",
			"workspaceArchive.reason.session-live": "Running or status unconfirmed; skipped",
			"workspaceArchive.reason.session-archived": "Already archived; skipped",
			"workspaceArchive.reason.session-empty": "Blank new session; skipped",
			"workspaceArchive.reason.session-unavailable": "Conversation content could not be confirmed; skipped",
			"workspaceArchive.reason.session-workspace-changed": "Workspace membership changed; skipped",
			"workspaceArchive.reason.archive-failed": "Archive failed",
			"workspaceArchive.reason.archive-uncommitted": "Archive did not complete",
			"workspaceArchive.reason.lifecycle-failed": "Operation did not complete",
			"workspaceArchive.status.captured": "Protection snapshot saved",
			"workspaceArchive.status.snapshot-failed": "Protection snapshot was not saved",
			"workspaceArchive.reason.stop-archive-unsupported": "This Host cannot stop and archive. Stop the task in the official UI first.",
            "workspaceArchive.reason.unknown": "Not completed",
			"workspaceArchive.retry": "Prepare again",
			"tab.unarchived": "Unarchived",
			"unarchived.search": "Search chat titles or IDs",
			"unarchived.empty": "No unarchived chats",
			"unarchived.error": "Unarchived chats are unavailable. Please retry.",
			"unarchived.loading": "Loading chats…",
			"unarchived.archiveAll": "Archive all",
			"unarchived.archive": "Archive",
			"unarchived.busy": "Running",
			"action.refresh": "Refresh",
			"residual.cardTitle": "Residual chats",
            "residual.count": "{count} chats",
            "residual.view": "View details",
            "residual.open": "View residual chat details",
            "residual.checking": "Checking…",
            "residual.failed": "Check failed",
            "insights.sessionIssues": "{count} directories could not be measured",
            "insights.snapshotIssues": "{count} recovery snapshots have issues",
            "residual.title": "Residual chat check",
			"residual.note": "Manually check subagent chats whose parent no longer exists. Preview or export a backup before choosing whether to delete permanently.",
			"residual.check": "Start check",
			"residual.recheck": "Check again",
			"residual.summary": "{count} residual chat(s) · {size} measured",
			"residual.checked": "Checked at {time}",
			"residual.selected": "{count} selected",
			"residual.select": "Select current results",
			"residual.search": "Search titles, IDs or directories",
			"residual.empty": "No residual chats found",
			"residual.backup": "Export backup",
			"orphans.loading": "Loading residual chats…",
			"orphans.error": "Cleanup candidates are unavailable",
			"orphans.unavailable": "The cleanup catalog is unreadable: this list may be incomplete.",
			"orphans.empty": "No chats to clean up",
			"orphans.kind.subagent": "Residual chat",
			"orphans.kind.blank": "Blank chat",
			"orphans.untitled": "Untitled chat",
			"orphans.created": "Created",
			"orphans.id": "Chat ID",
			"orphans.cwd": "Working directory",
			"orphans.parent": "Parent chat",
			"orphans.size": "Size",
			"orphans.selectAll": "Select all",
			"orphans.clearSelection": "Clear selection",
			"orphans.exportSelected": "Export selected",
			"orphans.summary": "{count} residual chat(s), {size} total",
			"orphans.delete": "Delete permanently",
			"orphans.delete.title": "Permanently delete residual chats?",
			"orphans.delete.body": "This permanently deletes the {count} selected residual chat(s) and their directories. Unselected chats are preserved. This cannot be undone.",
			"orphans.deleted": "Permanently deleted",
			"orphans.setChanged": "The cleanup list changed. Refresh the list and select again.",
			"orphans.blocked": "Exceeds backup limit",
			"orphans.exportPartial": "Exported {count} chat(s); {skipped} over the backup limit were left out (marked in the list).",
			"orphans.exportAllBlocked": "Every selected chat exceeds the backup limit and cannot be exported.",
			"orphans.exportConfirm.title": "Some chats exceed the backup limit",
			"orphans.exportConfirm.body": "{blocked} chat(s) exceed the backup limit and cannot be packaged into an importable backup. Deselect them and export the other {keep}?",
			"orphans.exportConfirm.confirm": "Deselect and export",
		};
		//#endregion

		//#region localized compositors (interpolation stays in JS)
		const isZh = (t) => t("locale.intl").startsWith("zh");
		const chatsCount = (t, n) => isZh(t) ? `${n} 个聊天` : n === 1 ? "1 chat" : `${n} chats`;
		function archiveActionConfirmation(t, action, ids, sessions, scope = { kind: "chat" }) {
			const selected = sessions.filter((row) => ids.includes(row.id));
			const count = ids.length;
			const zh = isZh(t);
			const workspace = scope.kind === "workspace";
			const all = scope.kind === "all";
			const selection = scope.kind === "selection";
			const workspaceCount = new Set(selected.map((row) => row.workspaceId ?? "ungrouped")).size;
			const target = workspace
				? (zh ? `工作区“${scope.title}”中的全部 ${count} 个已归档聊天` : `all ${count} archived chats in workspace “${scope.title}”`)
				: all ? (zh ? `全部 ${workspaceCount} 个工作区中的 ${count} 个已归档聊天` : `all ${count} archived chats across ${workspaceCount} workspaces`)
				: selection ? (zh ? `选中的 ${count} 个已归档聊天` : `the ${count} selected archived chats`)
				: (zh ? `聊天“${selected[0]?.title || t("chat.untitled")}”` : `chat “${selected[0]?.title || t("chat.untitled")}”`);
			const unaffected = workspace
				? (zh ? "其他工作区和回收站不受影响。" : "Other workspaces and the Recycle Bin are unaffected.")
				: (zh ? "回收站不受影响。" : "The Recycle Bin is unaffected.");
			if (action === "permanent") return {
                title: zh ? (workspace ? "删除该工作区的全部已归档聊天？" : all ? "删除所有已归档本地聊天？" : selection ? "删除选中的已归档聊天？" : "删除已归档的聊天？")
                    : (workspace ? "Delete all archived chats in this workspace?" : all ? "Delete all archived local chats?" : selection ? "Delete selected archived chats?" : "Delete archived chat?"),
                body: zh ? `这将永久删除${all ? "本地" : ""}${target}。${workspace || all ? unaffected : ""}此操作无法恢复。`
                    : `This permanently deletes ${target}. ${workspace || all ? `${unaffected} ` : ""}This cannot be undone.`,
                label: t(workspace || all ? "action.deleteAll" : "chat.delete"), danger: true, deleteAll: workspace || all,
            };
			if (action === "trash") return {
				title: zh ? (all ? "将全部已归档聊天移入回收站？" : selection ? "将选中的聊天移入回收站？" : workspace ? "将该工作区的全部已归档聊天移入回收站？" : "将聊天移入回收站？") : (all ? "Move all archived chats to the Recycle Bin?" : selection ? "Move selected chats to the Recycle Bin?" : workspace ? "Move all archived chats in this workspace to the Recycle Bin?" : "Move chat to the Recycle Bin?"),
				body: zh ? `这将把${target}移入回收站。${workspace ? "其他工作区不受影响。" : selection ? "未选中的聊天不受影响。" : ""}之后可从回收站恢复到“已归档”，再取消归档以返回聊天列表。`
					: `This moves ${target} to the Recycle Bin. ${workspace ? "Other workspaces are unaffected. " : selection ? "Unselected chats are unaffected. " : ""}Restore them to Archived first, then unarchive to return them to the chat list.`,
				label: t(workspace || all ? "menu.deleteAll" : "chat.recycle"), danger: false,
			};
			if (action === "unarchive") {
                const unarchiveTarget = workspace
                    ? (zh ? `「${scope.title}」中的已归档会话` : `archived chats in workspace “${scope.title}”`)
                    : all ? (zh ? "所有工作区中的已归档会话" : "archived chats in all workspaces")
                        : selection ? (zh ? "选中的已归档会话" : "the selected archived chats") : target;
                return {
                    title: zh ? (workspace ? "取消归档此工作区的全部会话？" : selection ? "取消归档选中的会话？" : "取消归档全部会话？")
                        : (workspace ? "Unarchive all chats in this workspace?" : selection ? "Unarchive selected chats?" : "Unarchive all chats?"),
                    body: zh ? `这会将${unarchiveTarget}恢复到聊天列表。${unaffected}`
                        : `This returns ${unarchiveTarget} to the chat list. ${unaffected}`,
                    label: t(selection ? "chat.unarchive" : "menu.unarchiveAll"), danger: false,
                };
            }
			return {
				title: zh ? (workspace ? "导出该工作区的全部已归档聊天？" : selection ? "导出选中的聊天？" : "导出全部已归档聊天？")
					: (workspace ? "Export all archived chats in this workspace?" : selection ? "Export selected chats?" : "Export all archived chats?"),
				body: zh ? `这将把${target}导出为 ZIP 备份，不会改变聊天的归档状态。回收站内容不包含在内。备份可能包含敏感内容，请妥善保存。`
					: `This exports ${target} as a ZIP backup without changing their archived state. Recycle Bin contents are excluded. Backups may contain sensitive content; store them securely.`,
				label: t(selection ? "export.selected" : "export.all"), danger: false,
			};
		}
		const deleteAllBody = (t, n) => isZh(t)
			? `这将为全部 ${n} 个已归档聊天创建保护快照并移至回收站`
			: `This creates protection snapshots and moves all ${n} archived chat${n === 1 ? "" : "s"} to the Recycle Bin`;
		const deleteGroupBody = (t, name, n) => isZh(t)
			? `这将把「${name}」下 ${n} 个已归档聊天移至回收站`
			: `This moves ${n} archived chat${n === 1 ? "" : "s"} under "${name}" to the Recycle Bin`;
		const deleteSelectedBody = (t, n) => isZh(t)
			? `这将把选中的 ${n} 个已归档聊天移至回收站`
			: `This moves the ${n} selected archived chat${n === 1 ? "" : "s"} to the Recycle Bin`;
		const selectedCount = (t, n) => isZh(t)
			? `已选择 ${n} 个聊天`
			: `${n} chat${n === 1 ? "" : "s"} selected`;
		const selectChatLabel = (t, title) => isZh(t) ? `选择 ${title}` : `Select ${title}`;
		const removeTagLabel = (t, tag) => isZh(t) ? `移除标签 ${tag}` : `Remove tag ${tag}`;
		const previewOpenLabel = (t, title) => `${t("preview.open")}${isZh(t) ? " " : ": "}${title}`;
		const previewRoleLabel = (t, role) => t(`preview.${["user", "assistant", "tool", "system", "context"].includes(role) ? role : "system"}`);
		const previewSegmentLabel = (t, segment) => {
            if (segment?.kind === "reasoning") return t("preview.reasoning");
			if (segment?.kind === "tool-call") return `${t("preview.toolCall")}${segment.label ? `: ${segment.label}` : ""}`;
			if (segment?.kind === "tool-result") return `${t("preview.toolResult")}${segment.label ? `: ${segment.label}` : ""}`;
			if (segment?.kind === "json") return segment.label || t("preview.json");
			return segment?.label || t("preview.unknown");
		};
			const previewJumpLabel = (t, index) => isZh(t) ? `转到第 ${index + 1} 条消息` : `Go to message ${index + 1}`;
			const compactSessionId = (id) => {
				const points = [...String(id ?? "")];
				return points.length <= 24 ? points.join("") : `${points.slice(0, 12).join("")}…${points.slice(-8).join("")}`;
			};
			const lineageNodeLabel = (t, node) => typeof node?.title === "string" && node.title.trim() !== ""
				? node.title.trim()
				: t(node?.status === "missing" ? "lineage.sourceUnavailable" : "lineage.untitled");
			const lineageDiagnosticText = (t, item) => item?.code === "missing-parent"
				? t("lineage.diagnostic.missing-parent.detail")
				: t(`lineage.diagnostic.${item?.code}`);
			const lineageContextText = (t, node) => `${t("lineage.sourceContext")}${isZh(t) ? "：" : ": "}${lineageNodeLabel(t, node)}`;
			const lineageRelationText = (t, parent) => parent === null
				? t("lineage.start")
				: isZh(t) ? `从「${lineageNodeLabel(t, parent)}」分出` : `Branched from "${lineageNodeLabel(t, parent)}"`;
			const lineageWorkspaceLabel = (t, node) => {
				const title = typeof node?.workspace?.title === "string" ? node.workspace.title.trim() : "";
				if (title !== "") return title;
				const id = typeof node?.workspace?.id === "string" ? node.workspace.id.trim() : "";
				return id !== "" ? id : t("group.noProject");
			};
			const lineageProjectText = (t, node) => `${t("lineage.project")}${isZh(t) ? "：" : ": "}${lineageWorkspaceLabel(t, node)}`;
			const lineageBranchText = (t, count) => count === 0
				? t("lineage.noBranches")
				: isZh(t) ? `${count} 个分支` : count === 1 ? "1 branch" : `${count} branches`;
			const failureText = (t, failed) => {
			const reasons = {
				"purge-unsupported": ["当前存储后端不支持永久删除。", "This storage backend does not support permanent deletion."],
				"trash-state-conflict": ["会话状态已变化，请刷新后重试。", "The chat state changed. Refresh and try again."],
				"trash-record-missing": ["会话已不在回收站中，请刷新列表。", "The chat is no longer in the recycle bin. Refresh the list."],
				"restore-unsupported": ["当前存储后端不支持恢复此会话。", "This storage backend cannot restore this chat."],
				"snapshot-restore-unsupported": ["当前存储后端不支持从保护快照恢复。", "This storage backend cannot restore from a protection snapshot."],
				"recycle-retired": ["已停止新增回收，请刷新页面。", "New recycle operations are retired. Refresh this page."],
                "retention-retired": ["自动清理与空间策略已停用。", "Automatic cleanup and retention policies are retired."],
                "session-live-purge-pending": ["会话仍在使用中，请停止会话后重试。", "The chat is still active. Stop it and try again."],
			};
			const first = failed[0];
			const reason = reasons[first?.reason]?.[isZh(t) ? 0 : 1]
				?? first?.message ?? first?.reason ?? (isZh(t) ? "请刷新后重试。" : "Refresh and try again.");
			if (isZh(t)) return `${failed.length} 个会话操作失败：${reason}`;
			return `Operation failed for ${failed.length} chat${failed.length === 1 ? "" : "s"}: ${reason}`;
		};
		const recycleErrorText = (t, error) => Array.isArray(error?.body?.failed) && error.body.failed.length > 0
			? failureText(t, error.body.failed) : String(error?.message ?? error);
		const unarchiveFailureText = (t, error) => {
			const code = error?.body?.error;
			if (code === "session-main-list-unreachable" && error?.body?.reason === "cwd-missing") return t("unarchive.cwdMissing");
			if (code === "session-reachability-unavailable") return t("unarchive.authorityUnavailable");
			if (code === "session-deletion-pending") return t("unarchive.deletionPending");
			if (code === "pending-store-unavailable") return t("unarchive.pendingUnavailable");
			return recycleErrorText(t, error);
		};
		// Pin the success toast just inside the settings dialog's top edge: the
		// toast is fixed-positioned (viewport coordinates), so measure where the
		// dialog actually starts instead of hardcoding an offset.
		const toastTop = () => {
			try {
				const top = document.querySelector('[role="dialog"]')?.getBoundingClientRect().top;
				return typeof top === "number" && top >= 0 ? Math.round(top) + 16 : 24;
			} catch { return 24; }
		};
		function formatDate(t, ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
			try {
				return new Intl.DateTimeFormat(t("locale.intl"), {
					year: "numeric", month: "long", day: "numeric",
					hour: "2-digit", minute: "2-digit", hour12: false
				}).format(new Date(ms));
			} catch {
				return new Date(ms).toLocaleString();
			}
		}
		function isoTimestamp(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
			const date = new Date(ms);
			return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
		}

		function formatBytes(value) {
			if (!Number.isFinite(value) || value < 0) return "—";
			if (value < 1024) return `${value} B`;
			const units = ["KB", "MB", "GB", "TB"];
			let amount = value;
			let unit = -1;
			do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
			return `${Number(amount.toFixed(amount >= 10 ? 0 : 1))} ${units[unit]}`;
		}

		// Summary strip size label: neutral ellipsis while idle/loading, a
		// localized failure label on error, otherwise the formatted total.
		function summarySizeText(t, stats) {
			if (stats?.status === "ready") return formatBytes(stats.summary?.totalBytes ?? 0);
			if (stats?.status === "error") return t("stats.error");
			if (stats?.status === "loading") return t("stats.loading");
			return "…";
		}

		// Per-row size label: ellipsis until statistics arrive, dash for rows
		// whose directory could not be measured, formatted size when ready.
		function rowSizeText(t, stats, id) {
			if (stats?.status !== "ready") return "…";
			const row = stats.sessions?.[id];
			if (row?.status !== "ready") return "—";
			return formatBytes(row.sizeBytes);
		}

		const tagsLimitLabel = (t, count) => isZh(t)
			? `标签 ${count}/8，每个最多 24 个字符`
			: `Tags ${count}/8, up to 24 characters each`;
		const noteLimitLabel = (t, count) => isZh(t)
			? `备注 ${count}/2000`
			: `Note ${count}/2000`;

		function matchesArchivedSession(session, query, locale) {
			const normalized = String(query ?? "").trim().toLocaleLowerCase(locale);
			if (normalized === "") return true;
			return [session.title, session.workspaceTitle, ...(Array.isArray(session.tags) ? session.tags : []), session.note]
				.some((value) => String(value ?? "").toLocaleLowerCase(locale).includes(normalized));
		}

		function filterByTag(session, tag, locale) {
			const normalized = String(tag ?? "").trim().toLocaleLowerCase("en-US");
			if (normalized === "") return true;
			return (Array.isArray(session.tags) ? session.tags : [])
				.some((value) => String(value).trim().toLocaleLowerCase("en-US") === normalized);
		}

		function foldTags(values) {
			const seen = new Set();
			const tags = [];
			for (const value of values ?? []) {
				const tag = String(value ?? "").trim();
				const key = tag.toLocaleLowerCase("en-US");
				if (tag !== "" && !seen.has(key)) { seen.add(key); tags.push(tag); }
			}
			return tags;
		}

		function sessionSortTime(session) {
			if (Number.isFinite(session?.updatedAt) && session.updatedAt >= 0) return session.updatedAt;
			return Number.isFinite(session?.createdAt) && session.createdAt >= 0 ? session.createdAt : null;
		}

		function sortArchivedSessions(items, mode, locale) {
			const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
			return items.map((item, index) => ({ item, index })).sort((left, right) => {
				const a = left.item;
				const b = right.item;
				if (mode === "title") {
					const aTitle = typeof a.title === "string" && a.title.trim() !== "" ? a.title.trim() : null;
					const bTitle = typeof b.title === "string" && b.title.trim() !== "" ? b.title.trim() : null;
					if ((aTitle === null) !== (bTitle === null)) return aTitle === null ? 1 : -1;
					if (aTitle !== null && bTitle !== null) {
						const compared = collator.compare(aTitle, bTitle);
						if (compared !== 0) return compared;
					}
				} else {
					const aDate = sessionSortTime(a);
					const bDate = sessionSortTime(b);
					if ((aDate === null) !== (bDate === null)) return aDate === null ? 1 : -1;
					if (aDate !== null && bDate !== null && aDate !== bDate) return mode === "oldest" ? aDate - bDate : bDate - aDate;
					if (a.id !== b.id) return a.id < b.id ? -1 : 1;
				}
				return left.index - right.index;
			}).map(({ item }) => item);
		}

		function setVisibleSelection(selected, visibleIds, checked) {
			const next = new Set(selected);
			for (const id of visibleIds) {
				if (checked) next.add(id);
				else next.delete(id);
			}
			return next;
		}

		function uniqueSessionIds(ids) {
			return [...new Set((Array.isArray(ids) ? ids : [])
				.filter((id) => typeof id === "string" && id !== ""))];
		}

		function defaultRetentionSelection(candidates) {
			return new Set((Array.isArray(candidates) ? candidates : [])
				.filter((item) => item?.action === "delete-snapshot" && typeof item.key === "string")
				.map((item) => item.key));
		}

		function filterLineageForest(roots, query, project = "all", status = "all") {
			const normalized = String(query ?? "").trim().toLocaleLowerCase("en-US");
			const projectKey = typeof project === "string" && project !== "" ? project : "all";
			const statusKey = ["active", "archived", "trash"].includes(status) ? status : "all";
			const sourceRoots = Array.isArray(roots) ? roots : [];
			const results = new Map();
			const stack = sourceRoots.map((node) => ({ node, visited: false }));
			while (stack.length > 0) {
				const current = stack.pop();
				if (!current.visited) {
					const workspace = current.node?.workspace;
                    const queryMatched = current.queryMatched || normalized === "" || [current.node?.id, current.node?.title, workspace?.id, workspace?.title]
                        .some(value => String(value ?? "").toLocaleLowerCase("en-US").includes(normalized));
                    stack.push({ node: current.node, visited: true, queryMatched });
					const children = Array.isArray(current.node?.children) ? current.node.children : [];
					for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], visited: false, queryMatched });
					continue;
				}
				const children = (Array.isArray(current.node?.children) ? current.node.children : []).map((child) => results.get(child)).filter(Boolean);
				const workspace = current.node?.workspace;
				const matchesProject = projectKey === "all" || lineageWorkspaceKey(current.node) === projectKey;
				const matchesQuery = current.queryMatched;
				const managed = !current.node.contextOnly && current.node?.status !== "missing";
				const matchesStatus = statusKey === "all" || current.node?.status === statusKey;
				const own = managed && matchesProject && matchesQuery && matchesStatus;
				results.set(current.node, own || children.length > 0 ? { ...current.node, contextOnly: current.node.contextOnly || !own, children } : null);
			}
			return sourceRoots.map((node) => results.get(node)).filter(Boolean);
		}

		function lineageWorkspaceKey(node) {
			return typeof node?.workspace?.id === "string" && node.workspace.id !== ""
				? node.workspace.id
				: "ungrouped";
		}

		function lineageProjects(roots) {
			const projects = [];
			const seen = new Set();
			const stack = [...(Array.isArray(roots) ? roots : [])].reverse();
			while (stack.length > 0) {
				const node = stack.pop();
				const managed = node?.status !== "missing";
				const value = lineageWorkspaceKey(node);
				if (managed && !seen.has(value)) {
					seen.add(value);
					const title = typeof node?.workspace?.title === "string" && node.workspace.title.trim() !== ""
						? node.workspace.title.trim()
						: typeof node?.workspace?.id === "string" && node.workspace.id.trim() !== "" ? node.workspace.id.trim() : null;
					projects.push({ value, title });
				}
				const children = Array.isArray(node?.children) ? node.children : [];
				for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
			}
			return projects;
		}

		function lineageDisclosureIds(roots) {
			const ids = [];
			const stack = [...(Array.isArray(roots) ? roots : [])].reverse();
			while (stack.length > 0) {
				const node = stack.pop();
				const children = Array.isArray(node?.children) ? node.children : [];
				if (!node.contextOnly && node?.status !== "missing" && typeof node?.id === "string") ids.push(node.id);
				for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
			}
			return ids;
		}

        // Each managed chat belongs to one workspace. Ancestors may be repeated
        // as read-only context so cross-workspace relationships never get rewired.
        function groupLineageWorkspaces(roots, workspaces = []) {
            const groups = new Map(), parents = new Map();
            for (const workspace of workspaces) {
                if (typeof workspace?.id !== "string" || workspace.id === "") continue;
                groups.set(workspace.id, { key: workspace.id, workspace, count: 0, roots: [], copies: new Map() });
            }
            const stack = (Array.isArray(roots) ? roots : []).map(node => ({ node, parent: null })).reverse();
            const entries = [];
            while (stack.length) {
                const entry = stack.pop();
                entries.push(entry);
                parents.set(entry.node, entry.parent);
                for (const child of [...(entry.node.children ?? [])].reverse()) stack.push({ node: child, parent: entry.node });
            }
            for (const { node } of entries) {
                if (!["active", "archived", "trash"].includes(node.status)) continue;
                const key = lineageWorkspaceKey(node);
                if (!groups.has(key)) groups.set(key, { key, workspace: node.workspace, count: 0, roots: [], copies: new Map() });
                const group = groups.get(key);
                group.count += 1;
                const path = [];
                let current = node;
                while (current && !group.copies.has(current)) { path.push(current); current = parents.get(current); }
                let parentCopy = current ? group.copies.get(current) : null;
                for (const source of path.reverse()) {
                    const parent = parents.get(source);
                    const copy = { ...source,
                        contextOnly: !["active", "archived", "trash"].includes(source.status) || lineageWorkspaceKey(source) !== key,
                        sourceParent: parent ? { id: parent.id, title: parent.title, status: parent.status, workspace: parent.workspace } : null,
                        children: [] };
                    group.copies.set(source, copy);
                    if (parentCopy) parentCopy.children.push(copy); else group.roots.push(copy);
                    parentCopy = copy;
                }
            }
            return [...groups.values()].filter(group => group.count > 0).map(({ copies, ...group }) => group);
        }

		const KEY_LINEAGE_WORKSPACES = "dsh-archived-chats:lineage-workspaces";
		function readLineageWorkspaces() {
			try {
				const ids = JSON.parse(window.localStorage.getItem(KEY_LINEAGE_WORKSPACES));
				return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
			} catch { return new Set(); }
		}

		function defaultLineageCollapsed(value) {
			return new Set(lineageDisclosureIds(Array.isArray(value?.roots) ? value.roots : []));
		}

		function countManagedLineageNodes(roots) {
			let count = 0;
			const stack = [...(Array.isArray(roots) ? roots : [])];
			while (stack.length > 0) {
				const node = stack.pop();
				if (!node.contextOnly && ["active", "archived", "trash"].includes(node?.status)) count += 1;
				for (const child of Array.isArray(node?.children) ? node.children : []) stack.push(child);
			}
			return count;
		}

		function sanitizeTrashRow(row) {
			const workspace = row?.workspace !== null && typeof row?.workspace === "object"
				? { id: row.workspace.id ?? null, title: row.workspace.title ?? null }
				: null;
			return { ...row, id: row?.sessionId, workspace };
		}

		function groupTrashSessions(rows) {
			const groups = new Map();
			for (const source of Array.isArray(rows) ? rows : []) {
				if (typeof source?.sessionId !== "string" || source.sessionId === "") continue;
				const row = sanitizeTrashRow(source);
				const key = typeof row.workspace?.id === "string" && row.workspace.id !== ""
					? row.workspace.id
					: "__ungrouped__";
				if (!groups.has(key)) groups.set(key, {
					key,
					title: row.workspace?.title ?? null,
					items: [],
					sessionIds: [],
				});
				const group = groups.get(key);
				group.items.push(row);
				group.sessionIds.push(row.sessionId);
			}
			return [...groups.values()];
		}

		function trashStatusLabel(t, row) {
			if (row?.state === "purge-pending") return t("trash.status.purgePending");
			if (row?.state === "degraded") return t("trash.status.degraded");
			if (row?.liveDisposition === "parked") return t("trash.status.parked");
			return t("trash.status.ready");
		}

		function markArchiveDialog(page) {
			let dialog = null;
			try { dialog = page?.closest?.('[role="dialog"]') ?? null; } catch { return () => {}; }
			if (dialog === null || typeof dialog.setAttribute !== "function") return () => {};
			const previous = typeof dialog.getAttribute === "function" ? dialog.getAttribute("data-dac-section-active") : null;
			dialog.setAttribute("data-dac-section-active", "1");
			return () => {
				try {
					if (previous === null) dialog.removeAttribute?.("data-dac-section-active");
					else dialog.setAttribute("data-dac-section-active", previous);
				} catch { /* host dialog already closed */ }
			};
		}
		//#endregion

		//#region styles
		const CSS = `
.dac-page{position:relative;display:flex;flex-direction:column;gap:12px;padding:0 0 28px;font-family:inherit}
.dac-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:25px}
.dac-heading{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
.dac-version{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dac-update-link{border:0;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;border-radius:6px;padding:3px 8px;background:var(--dsw-alias-label-primary,#171717);color:var(--dsw-alias-bg-layer-1,#fff);font-size:11px;line-height:18px;text-decoration:none;white-space:nowrap}
.dac-update-link:focus-visible,.dac-about a:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#6e6ef7);outline-offset:3px}
.dac-about{display:flex;flex-direction:column;gap:12px;padding:0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.dac-about p{margin:0}.dac-about-meta{display:flex;gap:8px 24px;flex-wrap:wrap;margin-top:10px}
.dac-about-links{display:flex;flex-wrap:wrap;gap:10px 20px}.dac-about a:not(.dac-update-link){color:var(--dsw-alias-label-primary);text-underline-offset:3px}
.dac-about-update{display:flex;flex-direction:column;align-items:flex-start;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}
.dac-action-confirm.dac-update-dialog{width:min(520px,calc(100vw - 48px))}.dac-update-content{display:flex;flex-direction:column;gap:14px}.dac-update-content p{margin:0}.dac-update-content a{color:var(--dsw-alias-label-primary);text-underline-offset:3px}.dac-update-terminal summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.dac-update-terminal[open] summary{margin-bottom:10px}.dac-update-meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 16px;margin:0}.dac-update-meta dt{color:var(--dsw-alias-label-tertiary)}.dac-update-meta dd{margin:0;overflow-wrap:anywhere}.dac-update-command{display:flex;align-items:flex-start;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);margin-top:8px}.dac-update-command code{flex:1;min-width:0;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}.dac-update-command button{flex:none}.dac-update-manual{border-top:1px solid var(--dsw-alias-border-l2);padding-top:14px;display:flex;flex-direction:column;gap:8px}.dac-update-error{color:var(--dsw-alias-state-error-primary)}.dac-update-privacy{font-size:12px;color:var(--dsw-alias-label-tertiary)}@media(max-width:480px){.dac-update-command{flex-direction:column}.dac-update-command button{align-self:flex-end}}
.dac-about-section-title{margin:0;font:inherit;font-weight:600;color:var(--dsw-alias-label-primary)}
.dac-about-maintenance{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}.dac-about-maintenance-row{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}.dac-about-maintenance-row>div{flex:1 1 280px;min-width:0}.dac-about-maintenance-row>button{flex:none}
.dac-about-status{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dac-title{flex:none;white-space:nowrap;margin:0;color:var(--dsw-alias-label-primary);font-size:18px;font-weight:600;line-height:normal;outline:none}
.dac-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}
.dac-head-actions{position:relative;display:flex;flex:0 1 auto;min-width:0;height:25px;box-sizing:border-box;align-items:center;justify-content:safe flex-end;gap:6px;flex-wrap:nowrap;overflow:visible}
.dac-toolbar-more{flex:none}.dac-toolbar-more>summary{list-style:none;gap:5px;border-radius:8px;padding:4px 10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}.dac-toolbar-more>summary::-webkit-details-marker{display:none}.dac-toolbar-more>summary svg{width:14px;height:14px}.dac-toolbar-more .dac-row-menu{min-width:180px;max-width:calc(100vw - 48px);z-index:20}.dac-menu-separator{height:1px;background:var(--dsw-alias-border-l2);margin:4px 10px}
.dac-head-actions .dac-toolbar-more>summary.dac-iconbtn{width:28px;height:25px}
.dac-head-actions>button{flex:none;box-sizing:border-box;height:25px;gap:5px;border-radius:8px;padding:1px 10px;font-size:13px;font-weight:400;line-height:20px;white-space:nowrap}
.dac-head-actions>button>svg{flex:none;width:14px;height:14px}
.dac-head-actions>.dac-action-trigger{color:var(--dsw-alias-label-secondary);background:transparent}
.dac-head-actions>.dac-action-trigger.dac-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dac-head-actions>button:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#6e6ef7);outline-offset:-2px}
.dac-tabs{display:flex;align-items:flex-end;gap:22px;margin-top:2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dac-tab{position:relative;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;padding:7px 1px 9px;cursor:pointer}
.dac-tab:hover,.dac-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}
.dac-tab[aria-selected="true"]:after,.dac-tab:focus-visible:after{content:"";position:absolute;right:0;bottom:-1px;left:0;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}
.dac-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;color:var(--dsw-alias-label-primary);border-radius:2px}
.dac-tab-label{position:relative;display:inline-block}
.dac-intro-row{display:flex;align-items:center;justify-content:space-between;gap:6px 12px;flex-wrap:wrap}
.dac-intro-row .dac-intro{flex:1 1 180px}
.dac-intro-row[data-locale="en"] .dac-intro{flex-basis:260px}
.dac-intro-row .dac-head-actions{flex:0 0 164px;width:164px;margin-left:auto;justify-content:flex-end}
.dac-intro-row[data-locale="en"] .dac-head-actions{flex-basis:220px;width:220px}
.dac-tabs+[role="tabpanel"]{padding-top:2px}
.dac-update-dot{position:absolute;right:-7px;top:0;width:6px;height:6px;border-radius:50%;background:#dc2626;pointer-events:none}
.dac-help-label{display:inline-flex;align-items:center;gap:5px}
.dac-help{display:inline-flex;align-items:center;font-weight:400}
.dac-help-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dac-help-button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dac-help-button:focus-visible,.dac-toast button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.dac-mode-panel{display:flex;flex-direction:column;gap:12px}
.dac-action-wrap{position:relative;display:inline-flex}
.dac-action-trigger{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:5px 11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.dac-action-trigger:hover:not(:disabled),.dac-action-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-toolbar-more>summary.dac-iconbtn{width:32px;height:32px;padding:0}
.dac-action-trigger.dac-danger{color:var(--dsw-alias-state-error-primary)}
.dac-action-trigger:disabled{opacity:.45;cursor:default}
.dac-action-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:60;min-width:190px;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv3)}
.dac-action-menu-item{display:flex;align-items:center;width:100%;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;padding:7px 10px;white-space:nowrap;cursor:pointer}
.dac-action-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-action-menu-item:disabled{opacity:.45;cursor:default}
.dac-action-menu-item.dac-danger{color:var(--dsw-alias-state-error-primary)}
.dac-action-menu-item.dac-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
/* Shared radii follow Host settings cards (xl), inputs/controls (md), and menu surfaces (lg). */
.dac-search{box-sizing:border-box;position:relative;width:100%;display:flex;align-items:center;color:var(--dsw-alias-label-tertiary)}
.dac-search>svg{position:absolute;left:12px;pointer-events:none}
.dac-search input,.dac-residual-search{box-sizing:border-box;width:100%;min-width:0;height:36px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;padding:0 34px 0 12px}
.dac-search:has(>svg) input{padding-left:36px}
.dac-search input::placeholder,.dac-residual-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.dac-search input:focus-visible,.dac-residual-search:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}
.dac-search-state{display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}.dac-search-state details{flex-basis:100%}.dac-search-state ul{padding-left:20px;margin:6px 0}
.dac-search-state.dac-error{color:var(--dsw-alias-state-error-primary)}
.dac-querybar-stacked{display:flex;flex-direction:column;gap:12px;min-width:0}
.dac-querybar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dac-querybar>.dac-search{flex:1 1 180px;min-width:0}
.dac-querybar>.dac-filters{flex:0 1 auto;min-width:0;max-width:100%}
.dac-querybar .dac-select-wrap,.dac-querybar .dac-filter-menu{flex:1 1 120px;width:120px;min-width:90px;max-width:160px}
.dac-lineage-toolbar .dac-filter-menu{width:180px;flex:0 0 180px;max-width:180px}
.dac-querybar .dac-select,.dac-querybar .dac-filter-menu>summary{box-sizing:border-box;min-height:36px}
.dac-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dac-filters>.dac-select-wrap{flex:1 1 90px;min-width:90px;max-width:160px}.dac-filters .dac-select{border-radius:var(--dsw-radius-md);width:100%;min-width:0;text-overflow:ellipsis}
.dac-select-wrap{position:relative;display:inline-flex;align-items:center}
.dac-select{appearance:none;-webkit-appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 28px 5px 14px;cursor:pointer;outline:none}
.dac-select-wrap-fill,.dac-select-fill{width:100%;min-width:0}
.dac-select:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-chevron{position:absolute;right:10px;pointer-events:none;color:var(--dsw-alias-label-tertiary);display:inline-flex}
.dac-selectionbar{container:dac-selection / inline-size;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:7px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dac-selection-info,.dac-selection-actions,.dac-selection-all{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dac-selection-all{font-size:13px;cursor:pointer;white-space:nowrap}
.dac-selection-count{display:flex;flex-direction:column;gap:2px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dac-selection-count small{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dac-selection-actions{gap:6px}.dac-selection-actions .dac-danger{color:var(--dsw-alias-state-error-primary)}
.dac-selection-secondary{display:contents}.dac-selection-overflow{display:none}
@container dac-selection (max-width:500px){.dac-selection-secondary{display:none}.dac-selection-overflow{display:block}}
@container dac-selection (max-width:660px){.dac-selection-actions[data-language="en"] .dac-selection-secondary{display:none}.dac-selection-actions[data-language="en"] .dac-selection-overflow{display:block}}
.dac-selection-cancel{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dac-selection-all .dac-checkbox:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));outline-offset:3px}
@media(max-width:640px){.dac-selection-actions{width:100%}.dac-selectionbar{gap:10px}.dac-selection-actions .dac-action-trigger{font-size:12px;padding:5px 8px}}
.dac-checkbox{width:16px;height:16px;box-sizing:border-box;margin:0;accent-color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));cursor:pointer;flex:none}
.dac-checkbox{color-scheme:light}[data-ds-dark-theme] .dac-checkbox{color-scheme:dark}
.dac-checkbox:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));outline-offset:2px}
.dac-checkbox:disabled{cursor:default;opacity:.45}
.dac-group{display:flex;flex-direction:column;gap:10px}
.dac-group-head{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px}
.dac-group-left{display:flex;align-items:center;gap:8px;min-width:0}
.dac-group-toggle{display:inline-flex;align-items:center;gap:7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;padding:3px 6px;margin:-3px -6px;border-radius:7px}
.dac-group-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-archive-group>.dac-group-head{align-items:center;color:var(--dsw-alias-label-secondary)}
.dac-archive-group>.dac-group-head>.dac-group-left{flex:1}
.dac-archive-group>.dac-group-head>.dac-group-side{flex:none;white-space:nowrap}
.dac-archive-group>.dac-group-head .dac-count{color:inherit;font-weight:400}
.dac-archive-group>.dac-group-head .dac-iconbtn{color:inherit}
.dac-archive-group-toggle{min-width:0;max-width:100%;align-items:center;text-align:left;font-weight:400;color:inherit}
.dac-archive-group-toggle>svg{flex:none}
.dac-archive-group-toggle>span{min-width:0;white-space:normal;overflow-wrap:anywhere}
.dac-archive-group-toggle:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#6e6ef7);outline-offset:3px}
.dac-chev{display:inline-flex;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg);transition:transform .15s}
.dac-chev.open{transform:rotate(0)}
.dac-group-name{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dac-group-side{display:flex;align-items:center;gap:4px}
.dac-count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-right:2px}
.dac-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .15s,color .15s;padding:0}
.dac-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dac-iconbtn:disabled{opacity:.45;cursor:default}
.dac-iconbtn.dac-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-menu{position:absolute;right:0;top:30px;z-index:40;min-width:150px;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv3)}
.dac-menu-heading{padding:6px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dac-menu-item{border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;padding:7px 10px;cursor:pointer}
.dac-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-menu-item.dac-danger{color:var(--dsw-alias-state-error-primary)}
.dac-menu-item.dac-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-list{display:flex;flex-direction:column;gap:8px}
.dac-group:not(.dac-archive-group)>.dac-list{gap:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);padding:0 16px;background:var(--dsw-alias-bg-layer-1)}
.dac-group:not(.dac-archive-group)>.dac-list>.dac-row{border:0;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);padding:14px 0;background:transparent}
.dac-group:not(.dac-archive-group)>.dac-list>.dac-row:last-child{border-bottom:0}
.dac-row-more{position:relative;flex:none}
.dac-row-more>summary{list-style:none}
.dac-row-more>summary::-webkit-details-marker{display:none}
.dac-row-more[open]{z-index:41}
.dac-row-menu{top:34px;min-width:180px;max-width:calc(100vw - 48px)}
.dac-row-menu .dac-menu-item{display:flex;align-items:center;gap:8px}
.dac-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);padding:12px 16px;transition:border-color .15s,background .15s}
.dac-row:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-row-select{display:flex;align-items:center;gap:11px;min-width:0;flex:1}
.dac-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dac-row-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dac-row-open{display:block;width:100%;border:0;padding:0;background:transparent;font-family:inherit;text-align:left;cursor:pointer}
.dac-row-open:hover:not(:disabled){text-decoration:underline;text-underline-offset:3px}
.dac-row-open:disabled{opacity:.45;cursor:default}
.dac-row-open:focus-visible{outline:2px solid var(--dsw-alias-border-l1);outline-offset:3px;border-radius:3px}
.dac-row-footer{display:flex;align-items:center;gap:10px;white-space:nowrap;min-width:0}.dac-row-footer .dac-row-date{min-width:0;overflow:hidden;text-overflow:ellipsis}.dac-row-footer .dac-row-size{flex-shrink:0}.dac-row-meta:empty{display:none}
.dac-row-note{min-width:0;position:relative;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:help;outline-offset:2px}.dac-row-note-summary{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dac-note-tooltip{position:fixed;z-index:10000;box-sizing:border-box;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 6px 24px rgba(0,0,0,.16);font-size:13px;line-height:20px;cursor:text;user-select:text}
.dac-row-extras{min-width:0;flex-wrap:nowrap!important}.dac-row-extras .dac-chip{min-width:0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}.dac-row-extras .dac-chip-more{flex-shrink:0}.dac-row-extras .dac-row-note{flex:1 1 100px}.dac-row-extras .dac-chip~.dac-row-note{border-left:1px solid var(--dsw-alias-border-l2);padding-left:8px}
.dac-row-date{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
/* Archived and unarchived share the host plugin-inventory card tokens and spacing. */
.dac-archive-group>.dac-list{gap:10px}
.dac-archive-group>.dac-list>.dac-row{box-sizing:border-box;min-width:0;min-height:52px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);padding:12px 14px;transition:none}
.dac-archive-group>.dac-list>.dac-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dac-archive-group .dac-row-main{gap:2px}
.dac-archive-group .dac-row-title{font-size:14px;font-weight:500;line-height:20px}
.dac-archive-group .dac-row-note{color:var(--dsw-alias-label-tertiary)}
.dac-row-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.dac-row:not(.dac-orphan-row)>.dac-row-actions:empty{display:none}
.dac-preview-head-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
/* Reserve the action column so a row without actions (a blank session) still
   ends its content block at the same edge as every other row. */
.dac-orphan-row .dac-row-actions{min-width:28px;justify-content:flex-end}
.dac-unarchived-row .dac-row-select,.dac-orphan-row .dac-row-select{flex:none}
.dac-unarchived-row .dac-row-meta,.dac-orphan-row .dac-row-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dac-unarchived-row .dac-row-meta>span,.dac-orphan-row .dac-row-meta>span{min-width:0;overflow-wrap:anywhere}
/* Orphans usually have no title, so several rows can share every other field.
   The id is the only thing that makes a row distinguishable. */
.dac-row-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dac-unarchive{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:400;line-height:18px;padding:4px 10px;cursor:pointer;transition:background .15s,border-color .15s}
.dac-row-actions>.dac-unarchive{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
.dac-row-actions>.dac-unarchive>svg{flex:none}
.dac-workspace-actions>button.dac-stop-archive{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.1));border-color:transparent}
.dac-unarchive:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-unarchive:disabled{opacity:.45;cursor:default}
.dac-unarchive.dac-archive-unarchive{border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));font-size:13px;font-weight:500;line-height:20px;padding:4px 10px}
.dac-unarchive.dac-archive-unarchive:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.16))}
.dac-unarchive.dac-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dac-unarchive.dac-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-trash-status{display:inline-flex;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:1px 8px}
.dac-trash-status-degraded,.dac-trash-status-purge-pending{color:var(--dsw-alias-state-error-primary)}
.dac-trash-meta{row-gap:4px}
.dac-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:56px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.dac-center{display:flex;align-items:center;justify-content:center;gap:8px;padding:48px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dac-retry{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 12px;cursor:pointer}
.dac-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:8px 12px}
/* A success that must stay on screen: it succeeded, so it wears the success
   palette, but it is not a four-second toast because it reports an omission. */
.dac-notice-ok{border-color:var(--dsw-alias-state-success-secondary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-success-primary)}
.dac-notice-ok>span{flex:1}
.dac-notice button{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0;display:inline-flex}
.dac-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:1200;width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-state-success-secondary);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-success-primary);font-size:13px;font-weight:500;line-height:20px;padding:7px 12px 7px 14px;box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv3));animation:dac-toast-in .28s cubic-bezier(.21,1.02,.55,1) both}
.dac-toast svg{flex:none}
.dac-toast button{border:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);opacity:1;cursor:pointer;font:inherit;padding:3px;margin-left:2px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px}
.dac-toast button.dac-notice-action{padding:3px 9px;white-space:nowrap}
.dac-toast button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
@keyframes dac-toast-in{from{opacity:0;transform:translateX(-50%) translateY(-10px) scale(.96)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
@media (prefers-reduced-motion:reduce){.dac-toast{animation:none}}
.dac-confirm-overlay{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)}
.dac-confirm{width:min(400px,calc(100vw - 64px));display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv3));padding:20px;outline:none}
.dac-confirm:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-interactive-primary,#6e6ef7),var(--dsw-shadow-lv3)}
.dac-confirm-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}
.dac-confirm-body{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}
.dac-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dac-confirm-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.dac-confirm-heading>.dac-iconbtn{flex:none}
.dac-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;cursor:pointer}
.dac-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-btn-danger{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;cursor:pointer}
.dac-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-btn-danger:disabled{opacity:.5;cursor:default}
.dac-spin{display:inline-block;width:14px;height:14px;border:2px solid var(--dsw-alias-label-tertiary);border-top-color:transparent;border-radius:50%;animation:dac-rotate .8s linear infinite}
@keyframes dac-rotate{to{transform:rotate(360deg)}}
.dac-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:-6px}
.dac-filter-menu{flex:1 1 90px;min-width:90px;max-width:160px}.dac-filter-menu>summary{box-sizing:border-box;width:100%;justify-content:space-between;border-radius:var(--dsw-radius-md)}.dac-filter-menu>summary>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dac-filter-menu .dac-row-menu{left:0;right:auto;top:calc(100% + 6px);min-width:220px;max-height:min(320px,50vh);overflow-y:auto;gap:0}.dac-filter-menu .dac-menu-item{padding:4px 8px;min-height:28px;box-sizing:border-box}.dac-filter-menu .dac-menu-separator{margin:3px 8px}.dac-filter-menu .dac-filter-label{gap:6px}.dac-filter-options{display:flex;flex-direction:column}.dac-filter-options+.dac-filter-options{margin-top:3px}.dac-filter-options+.dac-filter-options::before{content:"";height:1px;flex:none;background:var(--dsw-alias-border-l2);margin:0 8px 3px}.dac-filter-label{display:flex;align-items:center;gap:8px;min-width:0;flex:1}.dac-filter-label>svg{flex:none}.dac-filter-label>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dac-filter-menu>summary>svg{flex:none}.dac-filter-menu .dac-menu-item:disabled{opacity:.45;cursor:default}.dac-filter-menu .dac-workspace-heading{font-weight:500;color:var(--dsw-alias-label-secondary)}.dac-filter-heading{padding:4px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px}.dac-filter-options .dac-menu-item{justify-content:space-between}
.dac-summary-sep{color:var(--dsw-alias-label-tertiary)}
.dac-summary-warn{color:var(--dsw-alias-state-error-primary)}
.dac-warn{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:8px 12px}
.dac-row-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dac-chip{display:inline-flex;align-items:center;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:1px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* A row the export writer refused: readable at a glance, no id matching. */
.dac-chip-warn{background:transparent;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dac-chip-more{color:var(--dsw-alias-label-tertiary)}
.dac-row-size{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:none}
.dac-row-snippet{background:none;border:0;padding:0;text-align:left;cursor:pointer;max-width:680px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.dac-row-snippet:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,var(--dsw-alias-label-primary));outline-offset:3px}
.dac-preview-node[data-preview-match="true"]{outline:2px solid var(--dsw-alias-interactive-primary,var(--dsw-alias-label-primary));outline-offset:4px;border-radius:8px}
.dac-row-snippet strong{color:var(--dsw-alias-interactive-primary,var(--dsw-alias-label-primary));font-weight:500;margin-right:6px}
.dac-meta-dialog{width:min(440px,calc(100vw - 64px))}
.dac-preview-dialog{width:min(1120px,calc(100vw - 32px));height:min(820px,calc(100vh - 32px));padding:0;gap:0;overflow:hidden}
.dac-preview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:14px 16px}
.dac-preview-heading{min-width:0;display:flex;flex-direction:column;gap:2px}
.dac-preview-heading strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:15px;line-height:22px}
.dac-preview-heading span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-preview-layout{min-height:0;flex:1;display:grid;grid-template-columns:74px minmax(0,1fr)}
.dac-preview-rail{display:flex;flex-direction:column;gap:5px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l2);padding:10px 8px;background:var(--dsw-alias-bg-layer-1)}
.dac-preview-rail button{border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:18px;padding:4px 6px;cursor:pointer}
.dac-preview-rail button:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dac-preview-rail button[aria-current="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-border-l2)}
.dac-preview-feed{min-width:0;overflow:auto;padding:16px;background:var(--dsw-alias-bg-layer-2)}
.dac-preview-column{width:100%;max-width:var(--dsh-chat-content-width,760px);margin:0 auto;display:flex;flex-direction:column;gap:16px}
.dac-preview-node{min-width:0;display:flex;flex-direction:column;gap:8px}
.dac-preview-user{align-items:flex-end}
.dac-preview-user-bubble{max-width:min(525px,82%);border-radius:22px;background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);padding:10px 16px;font-size:16px;line-height:24px;white-space:pre-wrap;overflow-wrap:anywhere}
.dac-preview-images{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:8px;width:min(100%,560px);max-width:100%}
.dac-preview-images[data-align="end"]{align-self:flex-end}
.dac-preview-images[data-align="start"]{align-self:flex-start}
.dac-preview-images img{display:block;width:100%;max-width:100%;height:auto;max-height:420px;object-fit:contain;border-radius:12px}
.dac-preview-image-placeholder{display:block;max-width:100%;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dac-preview-assistant{align-items:stretch;color:var(--dsw-alias-label-primary);font-size:16px;line-height:28px}
.dac-preview-tool,.dac-preview-system,.dac-preview-context{align-items:stretch;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}
.dac-preview-meta{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-preview-plain{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dac-preview-disclosure{color:var(--dsw-alias-label-secondary)}
.dac-preview-process{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}.dac-preview-process>summary{display:flex;align-items:center;gap:6px;list-style:none;cursor:pointer;padding:2px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dac-preview-process>summary::-webkit-details-marker{display:none}.dac-preview-process>summary svg{transition:transform .12s}.dac-preview-process[open]>summary svg{transform:rotate(180deg)}.dac-preview-process-body{display:flex;flex-direction:column;gap:10px;padding-top:12px}.dac-preview-process-body .dac-preview-node{gap:8px}.dac-preview-process-body .dac-preview-assistant{font-size:14px;line-height:24px}
.dac-preview-fold-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:13px}.dac-preview-fold-summary::before{content:"·";margin-right:8px}.dac-preview-fold>summary>span:not([class]){flex:none}.dac-preview-fold[open]>summary>.dac-preview-fold-summary{display:none}.dac-preview-detail-label{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dac-preview-process>summary:focus-visible,.dac-preview-fold>summary:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#6e6ef7);outline-offset:2px;border-radius:4px}
.dac-preview-fold>summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;width:fit-content;max-width:100%;font-size:14px;line-height:24px}
.dac-preview-fold>summary::-webkit-details-marker{display:none}
.dac-preview-fold>summary:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#6e6ef7);outline-offset:3px;border-radius:4px}
.dac-preview-fold-leading{display:inline-grid;width:16px;height:16px;flex:none;align-items:center;justify-items:center}
.dac-preview-fold-icon,.dac-preview-fold-chevron{grid-area:1/1;display:inline-flex}
.dac-preview-fold-chevron{visibility:hidden;transform:rotate(-90deg)}
.dac-preview-fold>summary:hover .dac-preview-fold-icon,.dac-preview-fold>summary:focus-visible .dac-preview-fold-icon,.dac-preview-fold[open]>summary .dac-preview-fold-icon{visibility:hidden}
.dac-preview-fold>summary:hover .dac-preview-fold-chevron,.dac-preview-fold>summary:focus-visible .dac-preview-fold-chevron,.dac-preview-fold[open]>summary .dac-preview-fold-chevron{visibility:visible}
.dac-preview-fold[open]>summary .dac-preview-fold-chevron{transform:rotate(0)}
.dac-preview-prompt-body{max-height:141px;overflow:auto;overscroll-behavior:contain;box-sizing:border-box;margin:4px 0 4px 22px;padding:10px 12px;border-radius:6px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.dac-preview-prompt-body>.dac-preview-plain{display:block}
.dac-preview-prompt-body>.dac-preview-plain+.dac-preview-plain{margin-top:8px}
.dac-preview-reasoning-body{color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;padding:4px 0 4px 22px;font-size:14px;line-height:24px}
.dac-preview-code{border:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);border-radius:12px;padding:12px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
.dac-preview-tool-body{display:flex;flex-direction:column;gap:8px;padding:4px 0 4px 22px}
.dac-preview-tool-result{margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.dac-preview-tool-result.dac-error{color:var(--dsw-alias-state-error-primary)}
.dac-preview-tool-body.dac-error,.dac-preview-disclosure.dac-error{color:var(--dsw-alias-state-error-primary)}
.dac-preview-actions{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;opacity:.58;transition:opacity .15s}
.dac-preview-actions button{border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;padding:2px 5px;cursor:pointer}
.dac-preview-actions button:hover,.dac-preview-actions button:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dac-preview-node:hover .dac-preview-actions,.dac-preview-node:focus-within .dac-preview-actions{opacity:1}
.dac-preview-more{align-self:center;margin:4px 0 8px}
.dac-import-dialog{width:min(560px,calc(100vw - 48px));max-height:min(700px,calc(100vh - 48px));overflow:auto}
.dac-import-package{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dac-import-package strong{grid-column:1/-1;color:var(--dsw-alias-label-primary);font-size:13px}
.dac-import-list{display:flex;flex-direction:column;gap:8px;max-height:360px;overflow:auto}
.dac-import-selection{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
.dac-import-row{display:flex;align-items:flex-start;gap:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);padding:8px 10px;cursor:pointer}
.dac-import-row.dac-import-conflict{opacity:.58;cursor:default}
.dac-import-main{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.dac-context-note{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:9px 12px}
.dac-insights-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.dac-insights-card{display:flex;align-items:center;flex-direction:column;gap:5px;text-align:center;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);padding:14px}.dac-insights-card span{color:var(--dsw-alias-label-tertiary);font-size:12px}.dac-insights-card strong{color:var(--dsw-alias-label-primary);font-size:18px}.dac-policy{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);padding:14px}.dac-policy-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.dac-policy-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dac-policy-label{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.dac-policy .dac-select{min-width:100px;border-radius:var(--dsw-radius-md)}.dac-policy input{width:88px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:7px 9px}.dac-policy-actions{display:flex;justify-content:flex-end;gap:8px;margin-left:auto}.dac-policy-actions .dac-btn{white-space:nowrap}.dac-retention-dialog{width:min(620px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 48px))}.dac-retention-list{display:flex;flex-direction:column;gap:8px;overflow:auto}.dac-retention-row{display:flex;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);padding:9px}.dac-retention-row span{display:flex;flex-direction:column}.dac-retention-row small{color:var(--dsw-alias-label-tertiary)}.dac-retention-row.dac-danger strong{color:var(--dsw-alias-state-error-primary)}
.dac-lineage-toolbar{display:flex;flex-direction:column;gap:12px;min-width:0}
.dac-lineage-toolbar-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none}
.dac-lineage-fold-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex:none}
.dac-lineage-fold{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:5px 8px;cursor:pointer}
.dac-lineage-fold:hover:not(:disabled),.dac-lineage-fold:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dac-lineage-fold:disabled{opacity:.42;cursor:default}
.dac-chev.collapse{transform:rotate(180deg)}
.dac-lineage-list-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dac-lineage-list-head-copy{display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap}.dac-lineage-list-head small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-lineage-workspaces{display:flex;flex-direction:column;gap:14px;min-width:0}
.dac-lineage-workspace{display:flex;flex-direction:column;gap:10px;min-width:0}
.dac-lineage-workspace+.dac-lineage-workspace{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.dac-lineage-workspace h3{margin:0;font:inherit}
.dac-lineage-workspace-toggle{display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:36px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.dac-lineage-workspace-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;font-size:14px;line-height:22px}
.dac-lineage-workspace-toggle small{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dac-lineage-workspace-toggle:disabled{cursor:default}
.dac-lineage-workspace-toggle>svg{flex:none}
.dac-lineage-tree{display:flex;flex-direction:column;gap:10px;min-width:0;padding:0}
.dac-lineage-node{display:flex;align-items:stretch;width:100%;min-width:0}
.dac-lineage-rail{display:flex;align-items:stretch;flex:none}
.dac-lineage-guide,.dac-lineage-junction{position:relative;width:14px;flex:none}
.dac-lineage-guide-continuing::before{content:"";position:absolute;left:6px;top:-10px;bottom:0;border-left:.5px solid var(--dsw-alias-border-l2)}
.dac-lineage-junction-root{width:0}
.dac-lineage-junction-child{width:18px}
.dac-lineage-junction-child::before{content:"";position:absolute;left:6px;top:-10px;bottom:0;border-left:.5px solid var(--dsw-alias-border-l2)}
.dac-lineage-junction-child::after{content:"";position:absolute;left:6px;right:0;top:26px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dac-lineage-junction-last::before{bottom:auto;height:36px}
.dac-lineage-row{display:flex;flex-direction:column;min-width:0;flex:1;overflow:hidden;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.dac-lineage-card-toggle{box-sizing:border-box;display:flex;align-items:center;gap:12px;min-width:0;width:100%;min-height:52px;padding:12px 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left}
button.dac-lineage-card-toggle{cursor:pointer}
button.dac-lineage-card-toggle:hover,button.dac-lineage-card-toggle[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}
button.dac-lineage-card-toggle:disabled{cursor:default}
.dac-lineage-card-content{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.dac-lineage-card-content strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}
.dac-lineage-source,.dac-lineage-source-context,.dac-lineage-card-content small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dac-lineage-card-chevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}.dac-lineage-card-chevron.expanded{transform:rotate(180deg)}
.dac-lineage-card-toggle>.dac-trash-status{flex:none;white-space:nowrap}
.dac-lineage-context-card .dac-lineage-card-content strong{color:var(--dsw-alias-label-secondary)}
.dac-lineage-detail-copy{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 14px 12px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);overflow-wrap:anywhere}
.dac-lineage-detail-copy small{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:normal;overflow-wrap:anywhere}
.dac-lineage-full-title{font-size:13px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dac-lineage-parent-id,.dac-lineage-id{font-family:var(--ds-font-family-code,monospace)}
.dac-lineage-footer,.dac-lineage-id-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}
.dac-lineage-copy{border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;min-height:24px;padding:2px 4px;cursor:pointer}
.dac-lineage-workspace-toggle:focus-visible,.dac-lineage-card-toggle:focus-visible,.dac-lineage-copy:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dac-lineage-archived,.dac-lineage-active,.dac-lineage-missing{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.dac-lineage-trash{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dac-lineage-diagnostics{display:flex;flex-direction:column;gap:3px;padding:0 14px 12px}
.dac-lineage-diagnostic{display:block;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dac-import-main span{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dac-import-main small{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.dac-snapshot-row .dac-row-main{gap:3px}.dac-snapshot-id{white-space:normal;overflow-wrap:anywhere;word-break:break-word}
.dac-insights-card{min-height:98px;box-sizing:border-box}.dac-insights-open{align-self:flex-start;margin-top:auto;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:2px 5px;cursor:pointer}.dac-insights-open:hover,.dac-insights-open:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}.dac-insights-open:disabled{cursor:default;opacity:.45;background:transparent}
.dac-residual-card small{font-size:11px;color:var(--dsw-alias-label-secondary)}.dac-residual-card .dac-insights-open{align-self:center}.dac-residual-card strong.dac-residual-state{font-size:13px;font-weight:500}.dac-insights-card .dac-insights-warning{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}.dac-residual-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}.dac-residual-list{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);overflow:auto;min-height:0;max-height: min(430px,calc(100vh - 300px))}.dac-residual-row{display:flex;align-items:flex-start;gap:12px;padding:14px}.dac-residual-row+.dac-residual-row{border-top:1px solid var(--dsw-alias-border-l2)}.dac-residual-main{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px;font-size:13px;color:var(--dsw-alias-label-primary)}.dac-residual-main code,.dac-residual-main small{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}.dac-residual-path{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dac-residual-row>.dac-row-size{white-space:nowrap}.dac-residual-dialog{overflow:hidden}.dac-residual-heading-actions{display:flex;align-items:center;gap:8px;flex:none}.dac-residual-dialog .dac-confirm-heading{flex-wrap:wrap;gap:8px}.dac-residual-heading-actions>.dac-action-trigger{white-space:nowrap}.dac-residual-dialog .dac-notice{margin:0}

.dac-storage-dialog{width:min(720px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 48px))}.dac-storage-detail-list{display:flex;flex-direction:column;gap:8px;max-height:min(460px,calc(100vh - 250px));overflow:auto}.dac-storage-detail-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:normal;overflow-wrap:anywhere}.dac-storage-dialog .dac-search{margin:0}
.dac-import-result{display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-state-success-primary);font-size:13px;line-height:20px}.dac-import-result-counts{display:flex;gap:14px;flex-wrap:wrap}.dac-import-warning{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dac-import-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dac-field-label{display:block;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dac-meta-input,.dac-meta-note{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:7px 10px;outline:none}
.dac-meta-input:focus,.dac-meta-note:focus{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-tag-editor{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-height:38px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:5px 7px;transition:border-color .15s}
.dac-tag-editor:focus-within{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-tag-editor .dac-meta-input{flex:1 1 140px;min-width:120px;width:auto;border:0;border-radius:0;background:transparent;padding:2px 3px}
.dac-tag-editor .dac-chip{gap:4px;border:0;cursor:pointer;font-family:inherit;padding:2px 7px}
.dac-tag-editor .dac-chip span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dac-tag-editor .dac-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary)}
.dac-tag-editor .dac-chip svg{flex:none}
.dac-meta-note{resize:vertical;min-height:72px}
.dac-meta-limits{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-btn-primary{border:1px solid var(--dsw-alias-label-primary,#171717);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-label-primary,#171717);color:var(--dsw-alias-bg-layer-1,#fff);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;cursor:pointer}
.dac-btn-primary:hover:not(:disabled){opacity:.9}
.dac-btn-primary:disabled{opacity:.5;cursor:default}
/* Match the Host Modal / Button contract, shared by every action confirmation.
   Keep our existing nested-dialog focus and pending-action guards. */
.dac-action-confirm-overlay{box-sizing:border-box;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4))}
.dac-action-confirm,.dac-workspace-dialog{box-sizing:border-box;width:min(380px,calc(100vw - 48px));max-height:calc(100vh - 48px);flex-shrink:0;overflow:auto;gap:0;border:0;border-radius:var(--dsw-radius-panel,24px);padding:0 0 24px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv3))}
.dac-action-confirm .dac-confirm-heading,.dac-workspace-dialog .dac-preview-head{display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;padding:22px 14px 12px 24px;flex-shrink:0}
.dac-action-confirm .dac-confirm-title,.dac-workspace-dialog .dac-preview-head strong{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:500;overflow-wrap:anywhere}
.dac-action-confirm .dac-confirm-heading>.dac-iconbtn,.dac-workspace-dialog .dac-preview-head>.dac-iconbtn{flex:none;width:28px;height:28px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary)}
.dac-action-confirm .dac-confirm-heading>.dac-iconbtn svg,.dac-workspace-dialog .dac-preview-head>.dac-iconbtn svg{width:14px;height:14px}
.dac-action-confirm .dac-confirm-body,.dac-workspace-copy{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:400;overflow-wrap:anywhere;white-space:pre-wrap}
.dac-action-confirm .dac-confirm-body{padding:0 24px}
.dac-workspace-body{display:flex;flex-direction:column;gap:12px;padding:0 24px;color:var(--dsw-alias-label-primary)}
.dac-workspace-choices{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dac-workspace-choice{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;padding:11px 13px;cursor:pointer}
.dac-workspace-choice:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-workspace-choice:focus-within{outline:2px solid var(--dsw-alias-interactive-primary,#6e6ef7);outline-offset:2px}
.dac-workspace-choice-selected{border-color:var(--dsw-alias-interactive-primary,#6e6ef7)}
.dac-workspace-choice-all{grid-template-columns:auto minmax(0,1fr);border:0;background:transparent;padding-top:7px;padding-bottom:7px}
.dac-workspace-choice-all:hover{background:transparent}
.dac-workspace-choice-all:focus-within{outline:0}
.dac-workspace-choice-all .dac-checkbox:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));outline-offset:2px}
.dac-workspace-choice-title{min-width:0;overflow-wrap:anywhere;font-weight:500}
.dac-workspace-choice-counts{display:flex;flex:none;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dac-workspace-skipped-live{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.dac-action-confirm .dac-confirm-actions,.dac-workspace-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin:40px 0 0;padding:0 24px;flex-shrink:0}
.dac-action-confirm .dac-confirm-actions>button,.dac-workspace-actions>button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;min-width:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;padding:0 14px;cursor:pointer}
.dac-action-confirm .dac-confirm-actions>.dac-btn-danger,.dac-workspace-actions>.dac-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dac-action-confirm .dac-confirm-actions>button:hover:not(:disabled),.dac-workspace-actions>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);opacity:1}
.dac-action-confirm .dac-confirm-actions>button:disabled,.dac-workspace-actions>button:disabled{opacity:.4;cursor:not-allowed}
.dac-action-confirm.dac-delete-confirm{width:min(520px,calc(100vw - 48px));padding:20px;border-radius:24px}
.dac-delete-confirm .dac-confirm-heading{padding:0 0 12px}
.dac-delete-confirm .dac-confirm-title{font-size:20px;line-height:28px;font-weight:600}
.dac-delete-confirm .dac-confirm-body{padding:0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.dac-delete-confirm .dac-confirm-actions{padding:0;margin:16px 0 0;gap:12px}
.dac-delete-confirm .dac-confirm-actions>button{height:32px;padding:0 16px;border:0;font-weight:500}
.dac-delete-confirm .dac-confirm-actions>.dac-btn{color:var(--dsw-alias-label-secondary)}
.dac-delete-confirm .dac-confirm-actions>.dac-btn-danger{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dac-delete-confirm .dac-confirm-actions>.dac-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.dac-delete-confirm .dac-confirm-actions>button.dac-delete-all{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:var(--dsw-radius-md,10px);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);font-weight:500}
.dac-delete-confirm .dac-confirm-actions>button.dac-delete-all:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.dac-delete-all>svg{flex:none;width:16px;height:16px}
.dac-delete-control{display:inline-flex;flex:none}
.dac-delete-control>.dac-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary)}
.dac-delete-tooltip{position:fixed;z-index:10000;box-sizing:border-box;width:max-content;max-width:calc(100vw - 24px);padding:6px 12px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:#181b1c;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:13px;font-weight:500;line-height:18px;overflow-wrap:anywhere;pointer-events:none}
.dac-action-confirm button:focus-visible,.dac-workspace-actions>button:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#6e6ef7);outline-offset:2px}
.dac-workspace-body ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dac-workspace-result-group{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}
@media (max-width:640px){[role="dialog"][data-dac-section-active="1"]>nav{display:none}[role="dialog"][data-dac-section-active="1"]>nav+div{width:100%;min-width:0}.dac-head{align-items:flex-start;flex-wrap:wrap}.dac-action-trigger{padding:5px 9px}.dac-action-menu{left:0;right:auto;max-width:calc(100vw - 32px)}.dac-action-wrap:last-child .dac-action-menu{left:auto;right:0}.dac-row{align-items:flex-start;flex-wrap:wrap}.dac-row-actions{gap:4px;flex-wrap:wrap}.dac-trash-actions{width:100%;justify-content:flex-end}.dac-unarchive{padding:4px 10px}.dac-summary{gap:6px}.dac-row-meta{gap:4px}.dac-preview-dialog{width:calc(100vw - 20px);height:calc(100vh - 20px)}.dac-preview-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.dac-preview-feed{padding:10px}.dac-preview-rail{flex-direction:row;overflow-x:auto;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 5px}.dac-preview-rail button{flex:none}}
@media (max-width:640px){.dac-insights-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dac-policy{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.dac-lineage-toolbar .dac-filter-menu{width:160px;flex-basis:160px}.dac-lineage-guide{width:10px}.dac-lineage-junction-child{width:14px}.dac-lineage-card-toggle{gap:8px}.dac-lineage-workspace-toggle small{font-size:11px}.dac-lineage-footer{align-items:flex-start;flex-direction:column}}
	@media (max-width:480px){.dac-row-select{width:100%;flex-basis:100%}.dac-row-actions{width:100%;justify-content:flex-end}}
	@media (max-width:480px){.dac-workspace-choice{grid-template-columns:auto minmax(0,1fr)}.dac-workspace-choice-counts{grid-column:2;flex-wrap:wrap}}
`;

		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.setAttribute("data-plugin-css", "dsh-archived-chats");
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		//#endregion

		//#region settings-nav icon patch
		// The settings shell hardcodes nav icons by section id (models /
		// agent-presets / plugins, gear for everything else). A registrant cannot
		// supply its own glyph, so after the shell renders we rewrite OUR nav
		// button's icon in place — mutating the existing <svg> (never replacing
		// React-managed nodes) and re-marking through dataset, so locale
		// re-renders and dialog reopens simply get re-patched by the observer.
		const NAV_LABELS = ["归档管理", "Archive Management"];
		const ARCHIVE_ICON_INNER = '<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"></path><path d="M10 13h4"></path>';

		function safeQueryAll(root, selector) {
			try {
				return typeof root?.querySelectorAll === "function" ? root.querySelectorAll(selector) : [];
			} catch {
				return [];
			}
		}

		function patchNavIcons() {
			if (typeof document === "undefined" || document.body === null) return;
			const dialogs = safeQueryAll(document, '[role="dialog"]');
			for (const dialog of dialogs) {
				const buttons = safeQueryAll(dialog, "nav button");
				for (const button of buttons) {
					const text = typeof button?.textContent === "string" ? button.textContent : "";
					if (!NAV_LABELS.some((label) => text.includes(label))) continue;
					let svg = null;
					try { svg = typeof button.querySelector === "function" ? button.querySelector("svg") : null; } catch { continue; }
					if (svg === null || svg.dataset === void 0 || svg.dataset.dacPatched === "1" || typeof svg.setAttribute !== "function") continue;
					try {
						svg.dataset.dacPatched = "1";
						svg.setAttribute("viewBox", "0 0 24 24");
						svg.setAttribute("fill", "none");
						svg.setAttribute("stroke", "currentColor");
						svg.setAttribute("stroke-width", "2");
						svg.setAttribute("stroke-linecap", "round");
						svg.setAttribute("stroke-linejoin", "round");
						svg.innerHTML = ARCHIVE_ICON_INNER;
					} catch { /* keep the host-provided fallback icon */ }
				}
			}
		}

		let navObserver = null;

		function startNavIconPatch() {
			patchNavIcons();
			let Observer;
			try { Observer = typeof window !== "undefined" ? window.MutationObserver : void 0; } catch { return; }
			if (Observer === void 0 || typeof document === "undefined" || document.body === null) return;
			if (navObserver !== null) return;
			let observer = null;
			try {
				observer = new Observer(() => patchNavIcons());
				observer.observe(document.body, { childList: true, subtree: true });
				navObserver = observer;
			} catch {
				try { observer?.disconnect?.(); } catch { /* best-effort decoration cleanup */ }
			}
		}

		function stopNavIconPatch() {
			try { navObserver?.disconnect?.(); } catch { /* best-effort decoration cleanup */ }
			navObserver = null;
		}
		//#endregion

		//#region api
		async function fetchState() {
			const res = await fetch(`${API_BASE}/state`, { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			return {
				sessions: Array.isArray(body.sessions) ? body.sessions : [],
                scheduleStatus: body.scheduleStatus ?? "unsupported",
				metadataStatus: body.metadataStatus === "unavailable" ? "unavailable" : "ready",
				// An unreadable recycle catalog cannot be subtracted from this list, so
				// already-deleted chats can reappear here. Surface it instead of
				// silently showing them as ordinary archived chats.
				trashStatus: body.trashStatus === "unavailable" ? "unavailable" : "ready",
			};
		}

		async function fetchStats() {
			const res = await fetch(`${API_BASE}/stats`, { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		}

		async function fetchTrash() {
			const res = await fetch(`${API_BASE}/trash`, { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		}

		async function fetchOrphans(signal, kind) {
			const res = await fetch(`${API_BASE}/orphans${kind ? `?kind=${kind}` : ""}`, { cache: "no-store", signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		}

		async function deleteOrphans(sessionIds, signal, kind) {
			const res = await fetch(`${API_BASE}/orphans/delete${kind ? `?kind=${kind}` : ""}`, {
				method: "POST",
				headers: { "content-type": "application/json", [GUARD_HEADER]: "1" },
				body: JSON.stringify({ sessionIds }),
				signal
			});
			const parsed = await res.json().catch(() => ({}));
			if (!res.ok) {
				const error = new Error(parsed.message || `HTTP ${res.status}`);
				error.body = parsed;
				throw error;
			}
			return parsed;
		}

		async function fetchInsights(signal) {
			const res = await fetch(`${API_BASE}/insights`, { cache: "no-store", signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		}

		async function saveRetentionPolicy(policy, confirmation) {
			return post("/retention/policy", confirmation ? { policy, confirmation: { token: confirmation.token, nonce: confirmation.nonce } } : policy);
		}

		async function previewRetention() {
			return post("/retention/preview", {});
		}

		async function applyRetention(token, nonce, keys) {
			return post("/retention/apply", { token, nonce, keys: uniqueSessionIds(keys) });
		}

		async function fetchLineage(signal) {
			const res = await fetch(`${API_BASE}/lineage`, { cache: "no-store", signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		}

		async function restoreTrash(ids) {
			const sessionIds = uniqueSessionIds(ids);
			if (sessionIds.length === 0) throw new Error("sessionIds is required");
			return post("/trash/restore", { sessionIds });
		}

		async function purgeTrash(ids) {
			const sessionIds = uniqueSessionIds(ids);
			if (sessionIds.length === 0) throw new Error("sessionIds is required");
			return post("/trash/purge", { sessionIds });
		}

		async function emptyTrash(targets) {
			if (!Array.isArray(targets) || targets.length === 0) throw new Error("targets is required");
			const purged = [];
			const failed = [];
			const uncertain = [];
			for (let offset = 0; offset < targets.length; offset += 2000) {
				const batch = targets.slice(offset, offset + 2000);
				let result;
				try { result = await post("/trash/empty", { targets: batch }); }
				catch (error) {
					if (Array.isArray(error.body?.failed)) result = error.body;
					else {
						uncertain.push(...targets.slice(offset).map((target) => target.sessionId));
						break;
					}
				}
				const confirmed = new Set(uniqueSessionIds(result?.purged));
				const failures = new Map((Array.isArray(result?.failed) ? result.failed : []).map((item) => [item?.id, item]));
				for (const target of batch) {
					if (confirmed.has(target.sessionId)) purged.push(target.sessionId);
					else if (failures.has(target.sessionId)) failed.push(failures.get(target.sessionId));
					else uncertain.push(target.sessionId);
				}
			}
			return { purged, failed, uncertain };
		}

		async function fetchArchivePreview(sessionId, offset = 0, limit = 50, signal, scope = "archive", seq) {
			const body = { sessionId, offset, limit, ...(seq === undefined ? {} : { seq }) };
			// Forward every non-default scope. Naming only "trash" here silently
			// downgraded a newer scope to "archive", which the Host then answered
			// with a 404 because the session is not archived at all.
			if (scope !== "archive") body.scope = scope;
			return post("/preview", body, signal);
		}

		async function fetchArchiveImage(sessionId, attachmentId, signal, scope = "archive") {
			const body = { sessionId, attachmentId };
			if (scope !== "archive") body.scope = scope;
			const res = await fetch(`${API_BASE}/preview/image`, {
				method: "POST",
				headers: { "content-type": "application/json", [GUARD_HEADER]: "1" },
				body: JSON.stringify(body),
				signal,
			});
			if (!res.ok) {
				const parsed = await res.json().catch(() => ({}));
				const error = new Error(parsed.message || parsed.error || `HTTP ${res.status}`);
				error.body = parsed;
				throw error;
			}
			return res.blob();
		}

		async function fetchArchiveSearch(query, limit = 50, signal, sessionIds) {
			return post("/search", { query, limit, ...(sessionIds === undefined ? {} : { sessionIds }) }, signal);
		}

        // One request at a time; the Host bounds each request's inspection concurrency.
        // Keep successful results across retry, but never reuse them across candidate scopes.
        async function runArchiveSearch({ query, ids, previous, signal, onUpdate = () => {} }) {
            const candidates = uniqueSessionIds(ids);
            const allowed = new Set(candidates);
            const hits = new Map((previous?.hits ?? []).filter(hit => allowed.has(hit.sessionId)).map(hit => [hit.sessionId, hit]));
            const done = new Set((previous?.completedIds ?? []).filter(id => allowed.has(id)));
            const skipped = new Map((previous?.skipped ?? []).filter(item => allowed.has(item.sessionId)).map(item => [item.sessionId, item]));
            const pending = candidates.filter(id => !done.has(id));
            const snapshot = (status, error = null) => ({ status, query, hits: [...hits.values()], skipped: [...skipped.values()],
                completedIds: [...done], pendingIds: candidates.filter(id => !done.has(id) && !skipped.has(id)),
                processed: done.size + skipped.size, total: candidates.length, error });
            if (Array.from(query.trim()).length < 2) return snapshot("idle");
            if (signal?.aborted) return snapshot("stopped");
            onUpdate(snapshot("loading"));
            for (let offset = 0; offset < pending.length; offset += 20) {
                if (signal?.aborted) return snapshot("stopped");
                const batch = pending.slice(offset, offset + 20);
                try {
                    const result = await fetchArchiveSearch(query, 100, signal, batch);
                    if (signal?.aborted) return snapshot("stopped");
                    const failures = new Map((result.skipped ?? []).map(item => [item.sessionId, item]));
                    for (const id of batch) {
                        if (failures.has(id)) { skipped.set(id, failures.get(id)); hits.delete(id); }
                        else { done.add(id); skipped.delete(id); }
                    }
                    for (const hit of result.hits ?? []) if (batch.includes(hit.sessionId) && done.has(hit.sessionId)) hits.set(hit.sessionId, hit);
                    onUpdate(snapshot("loading"));
                } catch (error) {
                    if (signal?.aborted) return snapshot("stopped");
                    const state = snapshot("error", String(error.message ?? error)); onUpdate(state); return state;
                }
            }
            const state = snapshot(skipped.size > 0 ? "partial" : "ready"); onUpdate(state); return state;
        }

        function matchesWorkspaceFilter(row, value) {
            return value === "all" || (value === "__dac_scheduled__"
                ? row.hasSchedule === true : (row.workspaceId ?? "ungrouped") === value);
        }

        function archiveSearchCandidates(sessions, project, type, tag, locale) {
            return (sessions ?? []).filter(row => matchesWorkspaceFilter(row, project)
                && (type !== "normal" || row.origin !== "subagent") && (type !== "subagent" || row.origin === "subagent")
                && (tag === "" || filterByTag(row, tag, locale))).map(row => row.id);
        }

		async function fetchWorkspaceArchiveWorkspaces() {
			const res = await fetch(`${API_BASE}/workspace-archive/workspaces`, { cache: "no-store" });
			const parsed = await res.json().catch(() => ({}));
			if (!res.ok) {
				const error = new Error(parsed.message || parsed.error || `HTTP ${res.status}`);
				error.body = parsed;
				throw error;
			}
			return parsed;
		}

		async function previewWorkspaceArchive(workspaceId, sessionIds, includeActive = false) {
			return post("/workspace-archive/preview", { workspaceId, ...(sessionIds === undefined ? {} : { sessionIds }), ...(includeActive ? { includeActive: true } : {}) });
		}

		async function applyWorkspaceArchive(token, nonce, stopActivity = false) {
			const res = await fetch(`${API_BASE}/workspace-archive/apply`, {
				method: "POST", headers: { "content-type": "application/json", [GUARD_HEADER]: "1" }, body: JSON.stringify({ token, nonce, ...(stopActivity ? { stopActivity: true } : {}) }),
			});
			const parsed = await res.json().catch(() => ({}));
			const complete = Array.isArray(parsed?.archived) && Array.isArray(parsed?.skipped)
				&& Array.isArray(parsed?.failed) && Array.isArray(parsed?.snapshots);
			if (res.status === 409 && complete) return { ...parsed, status: 409 };
			if (!res.ok) { const error = new Error(parsed.message || parsed.error || `HTTP ${res.status}`); error.body = parsed; throw error; }
			return parsed;
		}

			async function saveMetadata(sessionId, tags, note) {
				return post("/metadata", { sessionId, tags, note });
			}

			async function submitImportFile(file) {
				if (file === null || file === undefined) throw new Error("backup file is required");
				const body = new FormData();
				body.append("file", file, file.name || "backup.zip");
				const res = await fetch(`${API_BASE}/import/inspect`, {
					method: "POST",
					headers: { [GUARD_HEADER]: "1" },
					body,
				});
				const parsed = await res.json().catch(() => ({}));
				if (!res.ok) {
					const error = new Error(parsed.message || parsed.error || `HTTP ${res.status}`);
					error.body = parsed;
					throw error;
				}
				return parsed;
			}

			const EXPORT_DOWNLOAD_MAX_BYTES = 320 * 1024 * 1024;
			const EXPORT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
			function exportFilename(disposition) {
				const value = typeof disposition === "string" ? disposition : "";
				const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
				let filename = null;
				if (encoded) {
					try { filename = decodeURIComponent(encoded.trim()); } catch { filename = null; }
				}
				if (filename === null) filename = value.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
					?? value.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim() ?? null;
				const safe = typeof filename === "string" ? filename.replace(/[\\/\u0000-\u001f\u007f]/g, "-").trim() : "";
				return safe === "" ? "dsh-archived-chats.zip" : safe;
			}

			async function readBoundedDownload(response, maxBytes) {
				const declared = Number(response.headers?.get?.("content-length"));
				if (Number.isFinite(declared) && declared > maxBytes) {
					await response.body?.cancel?.("export-download-too-large").catch(() => {});
					throw new Error("export-download-too-large");
				}
				const reader = response.body?.getReader?.();
				if (reader === undefined) {
					const bytes = new Uint8Array(await response.arrayBuffer());
					if (bytes.byteLength > maxBytes) throw new Error("export-download-too-large");
					return bytes;
				}
				const chunks = [];
				let total = 0;
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (!(value instanceof Uint8Array)) throw new Error("export-stream-invalid");
						total += value.byteLength;
						if (total > maxBytes) {
							await reader.cancel("export-download-too-large").catch(() => {});
							throw new Error("export-download-too-large");
						}
						chunks.push(value);
					}
				} finally { reader.releaseLock?.(); }
				const bytes = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
				return bytes;
			}

			async function submitExport(sessionIds, signal, path = "/export") {
				if (typeof document === "undefined") return false;
				const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
					.filter((id) => typeof id === "string" && id !== ""))];
				if (ids.length === 0) return false;
				const body = new URLSearchParams({ sessionIds: JSON.stringify(ids) });
				const response = await fetch(`${API_BASE}${path}`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: body.toString(),
					signal,
				});
				const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
				const disposition = response.headers?.get?.("content-disposition") ?? "";
				if (!response.ok || contentType !== "application/zip" || !/^attachment\s*;/i.test(disposition)) {
					let detail = `HTTP ${response.status}`;
					try {
						const bytes = await readBoundedDownload(response, 64 * 1024);
						const text = new TextDecoder().decode(bytes).trim();
						if (text !== "") detail = text;
					} catch { /* keep bounded status fallback */ }
					const error = new Error(detail);
					error.status = response.status;
					// The Host answers `code` or `code:subject`. Splitting it here lets
					// the caller act on the code and name the session it refers to,
					// rather than surfacing the raw token to the user.
					const separator = detail.indexOf(":");
					error.code = separator === -1 ? detail : detail.slice(0, separator);
					if (separator !== -1) {
						// `code:id,id` — the Host names every session the code applies to.
						const subjects = detail.slice(separator + 1).split(",")
							.map((id) => id.trim()).filter((id) => id !== "");
						if (subjects.length === 1) error.sessionId = subjects[0];
						if (subjects.length > 0) error.sessionIds = subjects;
					}
					throw error;
				}
				const bytes = await readBoundedDownload(response, EXPORT_DOWNLOAD_MAX_BYTES);
				const filename = exportFilename(disposition);
				const urlApi = window.URL;
				const url = urlApi.createObjectURL(new Blob([bytes], { type: "application/zip" }));
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = filename;
				anchor.hidden = true;
				document.body.appendChild(anchor);
				anchor.click();
				setTimeout(() => {
					try { urlApi.revokeObjectURL(url); } finally { anchor.remove(); }
				}, 0);
				return { filename, bytes: bytes.byteLength };
			}

		async function post(path, body, signal) {
			const res = await fetch(`${API_BASE}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", [GUARD_HEADER]: "1" },
				body: JSON.stringify(body),
				signal
			});
			const parsed = await res.json().catch(() => ({}));
			if (!res.ok) {
				const error = new Error(parsed.message || `HTTP ${res.status}`);
				error.body = parsed;
				throw error;
			}
			return parsed;
		}
		//#endregion

		//#region icons (inline SVG, stroke = currentColor)
		function svgProps(size) {
			return { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" };
		}
		function IconSearch({ size = 16 }) {
            if (previewPrimitives.IconSearch) return (0, jsx.jsx)(previewPrimitives.IconSearch, { size });
            // Match the official artwork on older Hosts without the public icon export.
			return (0, jsx.jsxs)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", strokeWidth: 1, children: [
                (0, jsx.jsx)("path", { d: "M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z", stroke: "currentColor" }),
                (0, jsx.jsx)("path", { d: "M10.2991 10.3933L14.7783 14.8725", stroke: "currentColor" })
            ] });
		}
		function IconEye({ size = 15 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("path", { d: "M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" }), (0, jsx.jsx)("circle", { cx: 12, cy: 12, r: 2.5 })] });
		}
		function IconFolder({ size = 15, open = false, strokeWidth = 1.6 }) {
			return (0, jsx.jsx)("svg", { ...svgProps(size), strokeWidth, children: open
				? (0, jsx.jsxs)("g", { children: [
					(0, jsx.jsx)("path", { d: "M3 17V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2" }),
					(0, jsx.jsx)("path", { d: "M6 11h15l-3 9H3Z" }),
				] })
				: (0, jsx.jsx)("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }) });
		}
		function IconTrash({ size = 14, strokeWidth = 1.6 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), strokeWidth, children: [(0, jsx.jsx)("path", { d: "M4 7h16" }), (0, jsx.jsx)("path", { d: "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }), (0, jsx.jsx)("path", { d: "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" }), (0, jsx.jsx)("path", { d: "M10 11v6M14 11v6" })] });
		}
		function IconDots({ size = 15 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), fill: "currentColor", stroke: "none", children: [(0, jsx.jsx)("circle", { cx: 5, cy: 12, r: 1.6 }), (0, jsx.jsx)("circle", { cx: 12, cy: 12, r: 1.6 }), (0, jsx.jsx)("circle", { cx: 19, cy: 12, r: 1.6 })] });
		}
        // Lucide list-filter, clock, tag and check geometry, using the existing icon renderer.
        function IconFilter({ size = 16 }) {
            return (0, jsx.jsx)("svg", { ...svgProps(size), children: (0, jsx.jsx)("path", { d: "M3 6h18M7 12h10M10 18h4" }) });
        }
        function IconClock({ size = 16 }) {
            return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("circle", { cx: 12, cy: 12, r: 10 }), (0, jsx.jsx)("path", { d: "M12 6v6l4 2" })] });
        }
        function IconTag({ size = 16 }) {
            return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("path", { d: "m20.59 13.41-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" }), (0, jsx.jsx)("path", { d: "M7 7h.01" })] });
        }
        function IconCheck({ size = 16 }) {
            return (0, jsx.jsx)("svg", { ...svgProps(size), children: (0, jsx.jsx)("path", { d: "m20 6-11 11-5-5" }) });
        }
		function IconChevron({ size = 13 }) {
			return (0, jsx.jsx)("svg", { ...svgProps(size), children: (0, jsx.jsx)("path", { d: "m6 9 6 6 6-6" }) });
		}
		function IconArchive({ size = 40, strokeWidth = 1.2 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), strokeWidth, children: [(0, jsx.jsx)("rect", { x: 3, y: 4, width: 18, height: 5, rx: 1 }), (0, jsx.jsx)("path", { d: "M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" }), (0, jsx.jsx)("path", { d: "M10 13h4" })] });
		}
		function IconChat({ size = 15, strokeWidth = 1.6 }) {
			return (0, jsx.jsx)("svg", { ...svgProps(size), strokeWidth, children: (0, jsx.jsx)("path", { d: "M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z" }) });
		}
		function IconClose({ size = 12 }) {
			return (0, jsx.jsx)("svg", { ...svgProps(size), children: (0, jsx.jsx)("path", { d: "M6 6l12 12M18 6 6 18" }) });
		}
			function IconCheckCircle({ size = 15 }) {
				return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("circle", { cx: 12, cy: 12, r: 9 }), (0, jsx.jsx)("path", { d: "m8.5 12.2 2.4 2.4 4.6-5" })] });
			}
			function IconDownload({ size = 15 }) {
				return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("path", { d: "M12 3v12" }), (0, jsx.jsx)("path", { d: "m7 10 5 5 5-5" }), (0, jsx.jsx)("path", { d: "M5 20h14" })] });
			}
			function IconUpload({ size = 15 }) {
				return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("path", { d: "M12 21V9" }), (0, jsx.jsx)("path", { d: "m7 14 5-5 5 5" }), (0, jsx.jsx)("path", { d: "M5 3h14" })] });
			}
		const EDIT_ICON_SPEC = {
			size: 16,
			viewBox: "0 0 1024 1024",
			fill: "currentColor",
			paths: [
				"M832 512a32 32 0 1 1 64 0v352a32 32 0 0 1-32 32H160a32 32 0 0 1-32-32V160a32 32 0 0 1 32-32h352a32 32 0 0 1 0 64H192v640h640V512z",
				"m469.952 554.24 52.8-7.552L847.104 222.4a32 32 0 1 0-45.248-45.248L477.44 501.44l-7.552 52.8zm422.4-422.4a96 96 0 0 1 0 135.808l-331.84 331.84a32 32 0 0 1-18.112 9.088L436.8 623.68a32 32 0 0 1-36.224-36.224l15.104-105.6a32 32 0 0 1 9.024-18.112l331.84-331.84a96 96 0 0 1 135.808 0z"
			]
		};
		function IconEdit({ size = EDIT_ICON_SPEC.size }) {
			return (0, jsx.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: EDIT_ICON_SPEC.viewBox,
				fill: EDIT_ICON_SPEC.fill,
				"aria-hidden": "true",
				children: EDIT_ICON_SPEC.paths.map((d) => (0, jsx.jsx)("path", { d }, d))
			});
		}
		//#endregion

		//#region components
		function EmptyState({ icon: Icon, children }) {
			return (0, jsx.jsxs)("div", {
				className: "dac-empty", role: "status",
				children: [(0, jsx.jsx)(Icon, { size: 40, strokeWidth: 1.2 }), (0, jsx.jsx)("span", { children })]
			});
		}
		function NativeArchiveNotice({ notice, t, onViewArchived, onDismiss }) {
			const Toast = previewPrimitives.Toast;
			if (Toast === null) return null;
			return (0, jsx.jsx)(Toast, {
				key: notice.sequence,
				text: notice.text,
				tone: "success",
				holdMs: 6000,
				actions: [{ label: t("trash.viewArchived"), onClick: onViewArchived }],
				onDone: onDismiss,
			});
		}

        function FilterSelect({ t, value, onChange, options, ariaLabel, icon = IconFilter, optionIcons = true }) {
            const selected = options.find(option => option.value === value);
            return (0, jsx.jsx)(ChatActionMenu, {
                t, filter: true, title: selected?.label ?? ariaLabel, triggerLabel: ariaLabel,
                trigger: [(0, jsx.jsxs)("span", { className: "dac-filter-label", children: [
                    (0, jsx.jsx)(selected?.icon ?? icon, { size: 16 }),
                    (0, jsx.jsx)("span", { children: selected?.label ?? ariaLabel }),
                ] }), (0, jsx.jsx)(IconChevron, {})],
                children: options.flatMap(option => [
                    ...(option.separator ? [(0, jsx.jsx)("div", { role: "separator", className: "dac-menu-separator" }, `${option.value}-separator`)] : []),
                    (0, jsx.jsxs)("button", {
                        type: "button", className: `dac-menu-item${option.heading ? " dac-workspace-heading" : ""}`, "aria-pressed": value === option.value,
                        "data-filter-value": option.value, "aria-label": option.label, disabled: option.disabled, title: option.hint ?? option.label,
                        onClick: () => onChange(option.value), children: [
                            (0, jsx.jsxs)("span", { className: "dac-filter-label", children: [
                                optionIcons && option.showIcon !== false && (0, jsx.jsx)(option.icon ?? icon, { size: 16 }), (0, jsx.jsx)("span", { children: option.label }),
                            ] }), value === option.value && (0, jsx.jsx)(IconCheck, {}),
                        ],
                    }, option.value),
                    ...(option.separatorAfter ? [(0, jsx.jsx)("div", { role: "separator", className: "dac-menu-separator" }, `${option.value}-separator-after`)] : []),
                ]),
            });
        }

        function WorkspaceFilter({ t, value, onChange, workspaces, scheduleStatus }) {
            return (0, jsx.jsx)(FilterSelect, {
                t, value, onChange, ariaLabel: t("filter.allProjects"), icon: IconFolder,
                options: [
                    { value: "all", label: t("filter.allProjects"), heading: true, showIcon: false, separatorAfter: true },
                    ...workspaces.filter(row => row.value !== "ungrouped").map(row => ({ value: row.value, label: row.title || row.value })),
                    { value: "ungrouped", label: t("group.noProject"), icon: IconFolder, separator: true },
                    { value: "__dac_scheduled__", label: t("filter.scheduled"), icon: IconClock,
                        disabled: scheduleStatus !== "ready", hint: scheduleStatus === "ready" ? undefined : t(scheduleStatus === "unavailable" ? "filter.scheduleUnavailable" : "filter.scheduleUnsupported") },
                ],
            });
        }

		function Select({ value, onChange, options, ariaLabel, fill = false, disabled = false }) {
			return (0, jsx.jsxs)("span", {
				className: `dac-select-wrap${fill ? " dac-select-wrap-fill" : ""}`,
				children: [
					(0, jsx.jsx)("select", {
						className: `dac-select${fill ? " dac-select-fill" : ""}`,
						disabled, value,
						"aria-label": ariaLabel,
						onChange: (e) => onChange(e.target.value),
						children: options.map((o) => (0, jsx.jsx)("option", { value: o.value, children: o.label }, o.value))
					}),
					(0, jsx.jsx)("span", { className: "dac-chevron", children: (0, jsx.jsx)(IconChevron, {}) })
				]
			});
		}

			function SelectionCheckbox({ checked, indeterminate = false, disabled = false, ariaLabel, onChange, ...inputProps }) {
			const inputRef = _react.useRef(null);
			_react.useEffect(() => {
				if (inputRef.current !== null) inputRef.current.indeterminate = indeterminate;
			}, [indeterminate]);
			return (0, jsx.jsx)("input", {
				ref: inputRef,
				type: "checkbox",
				className: "dac-checkbox",
				checked,
				disabled,
					"aria-label": ariaLabel,
					"aria-checked": indeterminate ? "mixed" : checked,
					onChange: (event) => onChange(event.target.checked),
					...inputProps
				});
			}

			function WorkspaceArchiveChooserDialog({ t, onChoose, onClose }) {
				const [state, setState] = _react.useState({ status: "loading", workspaces: [] });
				const [selected, setSelected] = _react.useState(() => new Set());
				const dialogRef = _react.useRef(null);
			const cancelRef = _react.useRef(null);
			const mountedRef = _react.useRef(false);
			const load = _react.useCallback(async () => {
				setState({ status: "loading", workspaces: [] });
					try {
						const result = await fetchWorkspaceArchiveWorkspaces();
						if (!mountedRef.current) return;
						const workspaces = (Array.isArray(result?.workspaces) ? result.workspaces : [])
							.filter((workspace) => typeof workspace?.id === "string" && workspace.id !== "" && Number(workspace.eligibleCount) > 0);
						setSelected(new Set());
						setState({ status: "ready", workspaces });
				} catch {
					if (mountedRef.current) setState({ status: "error", workspaces: [] });
				}
			}, []);
			const containKey = (event) => {
				if (event.key === "Escape") {
					event.preventDefault?.(); event.stopPropagation?.(); event.nativeEvent?.stopImmediatePropagation?.(); onClose?.();
					return;
				}
				if (event.key !== "Tab") return;
				const dialog = dialogRef.current;
				if (dialog === null) return;
					const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])')];
				if (focusable.length === 0) { event.preventDefault?.(); dialog.focus?.(); return; }
				const first = focusable[0]; const last = focusable[focusable.length - 1]; const active = document.activeElement;
				const inside = typeof dialog.contains === "function" ? dialog.contains(active) : focusable.includes(active);
				if (event.shiftKey && (active === first || !inside)) { event.preventDefault?.(); last.focus?.(); }
				else if (!event.shiftKey && (active === last || !inside)) { event.preventDefault?.(); first.focus?.(); }
			};
			_react.useEffect(() => {
				mountedRef.current = true;
				void load();
				return () => { mountedRef.current = false; };
			}, [load]);
			_react.useEffect(() => {
				cancelRef.current?.focus?.();
				document.addEventListener("keydown", containKey);
				return () => document.removeEventListener("keydown", containKey);
				}, [onClose]);
				const countText = (key, count) => t(key).replace("{count}", String(Number.isFinite(count) ? count : 0));
				const selectedCount = selected.size;
				const allSelected = state.workspaces.length > 0 && selectedCount === state.workspaces.length;
				const someSelected = selectedCount > 0 && !allSelected;
				const toggleWorkspace = (workspaceId, checked) => setSelected((current) => {
					const next = new Set(current);
					if (checked) next.add(workspaceId); else next.delete(workspaceId);
					return next;
				});
				const toggleAll = (checked) => setSelected(checked ? new Set(state.workspaces.map((workspace) => String(workspace.id))) : new Set());
				const confirmSelection = () => {
					if (selectedCount === 0) return;
					onChoose?.(state.workspaces
						.filter((workspace) => selected.has(String(workspace.id)))
						.map((workspace) => ({ id: String(workspace.id), title: typeof workspace.title === "string" ? workspace.title : null })));
				};
				return (0, jsx.jsx)("div", { className: "dac-confirm-overlay dac-action-confirm-overlay", onClick: onClose, children: (0, jsx.jsxs)("div", {
				ref: dialogRef, className: "dac-confirm dac-workspace-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dac-workspace-chooser-title", tabIndex: -1,
				onClick: (event) => event.stopPropagation(), onKeyDown: containKey,
				children: [
					(0, jsx.jsxs)("div", { className: "dac-preview-head", children: [
						(0, jsx.jsx)("strong", { id: "dac-workspace-chooser-title", children: t("workspaceArchive.chooseTitle") }),
						(0, jsx.jsx)("button", { type: "button", className: "dac-iconbtn", "aria-label": t("workspaceArchive.close"), onClick: onClose, children: (0, jsx.jsx)(IconClose, { size: 16 }) })
					] }),
					(0, jsx.jsxs)("div", { className: "dac-workspace-body", children: [
						(0, jsx.jsx)("p", { className: "dac-workspace-copy", children: t("workspaceArchive.chooseBody") }),
						state.status === "loading" && (0, jsx.jsx)("p", { role: "status", className: "dac-workspace-skipped-live", children: t("workspaceArchive.loading") }),
						state.status === "error" && (0, jsx.jsxs)("div", { className: "dac-error", role: "status", children: [
							(0, jsx.jsx)("span", { children: t("workspaceArchive.loadError") }),
							(0, jsx.jsx)("button", { type: "button", className: "dac-btn", onClick: () => { void load(); }, children: t("workspaceArchive.retry") })
						] }),
						state.status === "ready" && state.workspaces.length === 0 && (0, jsx.jsx)("p", { role: "status", className: "dac-workspace-skipped-live", children: t("workspaceArchive.noWorkspaces") }),
							state.status === "ready" && state.workspaces.length > 0 && (0, jsx.jsxs)("ul", { className: "dac-workspace-choices", children: [
								(0, jsx.jsx)("li", { children: (0, jsx.jsxs)("label", { className: "dac-workspace-choice dac-workspace-choice-all", children: [
									(0, jsx.jsx)(SelectionCheckbox, {
										checked: allSelected, indeterminate: someSelected,
										ariaLabel: t("workspaceArchive.selectAll"),
										"data-workspace-archive-select-all": "1",
										onChange: toggleAll,
									}),
									(0, jsx.jsx)("span", { className: "dac-workspace-choice-title", children: t("workspaceArchive.selectAll") })
								] }) }, "all"),
								...state.workspaces.map((workspace) => {
									const workspaceId = String(workspace.id);
									const checked = selected.has(workspaceId);
									const title = typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : workspaceId === "__dac_ungrouped__" ? t("group.noProject") : workspaceId;
									return (0, jsx.jsx)("li", { children: (0, jsx.jsxs)("label", {
										className: `dac-workspace-choice${checked ? " dac-workspace-choice-selected" : ""}`,
										children: [
											(0, jsx.jsx)(SelectionCheckbox, {
												checked, ariaLabel: title,
												"data-workspace-archive-choice": workspaceId,
												onChange: (next) => toggleWorkspace(workspaceId, next),
											}),
											(0, jsx.jsx)("span", { className: "dac-workspace-choice-title", children: title }),
											(0, jsx.jsxs)("span", { className: "dac-workspace-choice-counts", children: [
												(0, jsx.jsx)("span", { children: countText("workspaceArchive.eligibleCount", workspace.eligibleCount) }),
												Number(workspace.liveCount) > 0 && (0, jsx.jsx)("span", { children: countText("workspaceArchive.liveCount", workspace.liveCount) })
											] })
										]
									}) }, workspaceId);
								})
							] }),
						] }),
						(0, jsx.jsxs)("div", { className: "dac-workspace-actions", children: [
							(0, jsx.jsx)("button", { ref: cancelRef, type: "button", className: "dac-btn", onClick: onClose, children: t("confirm.cancel") }),
							(0, jsx.jsx)("button", { type: "button", className: "dac-btn-primary", disabled: state.status !== "ready" || selectedCount === 0, "data-workspace-archive-choose-confirm": "1", onClick: confirmSelection, children: t("workspaceArchive.chooseConfirm") })
						] })
					]
				}) });
			}

			function WorkspaceArchiveDialog({ t, workspaces, workspaceId, workspaceTitle, restoreFocus, onClose, onApplied, onEmpty, includeActive = false, scope }) {
				const targets = _react.useMemo(() => {
					const source = Array.isArray(workspaces) ? workspaces : [{ id: workspaceId, title: workspaceTitle }];
					const seen = new Set();
					return source.flatMap((workspace) => {
						const id = typeof workspace?.id === "string" ? workspace.id : "";
						if (id === "" || seen.has(id)) return [];
						seen.add(id);
						return [{ id, title: typeof workspace?.title === "string" ? workspace.title : null, ...(Array.isArray(workspace.sessionIds) ? { sessionIds: workspace.sessionIds } : {}) }];
					});
				}, [workspaces, workspaceId, workspaceTitle]);
				const targetKey = JSON.stringify([includeActive, targets.map(({ id, sessionIds }) => [id, sessionIds])]);
				const [previews, setPreviews] = _react.useState([]);
				const [result, setResult] = _react.useState(null);
			const [stage, setStage] = _react.useState("preparing");
			const [busy, setBusy] = _react.useState(false);
			const [error, setError] = _react.useState(null);
			const dialogRef = _react.useRef(null);
			const cancelRef = _react.useRef(null);
			const busyRef = _react.useRef(false);
				const mountedRef = _react.useRef(false);
				const preparationRequestRef = _react.useRef(0);
					const applyRequestRef = _react.useRef(0);
					const targetRef = _react.useRef(targetKey);
					const onEmptyRef = _react.useRef(onEmpty);
					const returningToChooserRef = _react.useRef(false);
				targetRef.current = targetKey;
				onEmptyRef.current = onEmpty;
			busyRef.current = busy;
			const safeLabel = (item) => typeof item?.title === "string" && item.title.trim() !== "" ? item.title : String(item?.id ?? "");
			const safeReason = (reason, status) => {
				const key = typeof reason === "string" ? `workspaceArchive.reason.${reason}` : typeof status === "string" ? `workspaceArchive.status.${status}` : "workspaceArchive.reason.unknown";
				const value = t(key);
				return value === key ? t("workspaceArchive.reason.unknown") : value;
			};
			const errorText = error?.body?.error === "workspace-archive-unsupported" ? t("workspaceArchive.unsupported") : t("workspaceArchive.error");
			const directArchive = scope === "chat" && targets.length === 1 && targets[0].sessionIds?.length === 1;
            const requiresStop = previews.some(item => Array.isArray(item.stopSessionIds) && item.stopSessionIds.length > 0);
            const showDialog = !directArchive || stage === "error" || stage === "result" || (stage === "confirm" && requiresStop);
            const close = () => { if (!busyRef.current) onClose?.(); };
			const containKey = (event) => {
				if (event.key === "Escape") {
					event.preventDefault?.(); event.stopPropagation?.(); event.nativeEvent?.stopImmediatePropagation?.(); close();
					return;
				}
				if (event.key !== "Tab") return;
				const dialog = dialogRef.current;
				if (dialog === null) return;
				const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')];
				if (focusable.length === 0) { event.preventDefault?.(); dialog.focus?.(); return; }
				const first = focusable[0]; const last = focusable[focusable.length - 1]; const active = document.activeElement;
				const inside = typeof dialog.contains === "function" ? dialog.contains(active) : focusable.includes(active);
				if (event.shiftKey && (active === first || !inside)) { event.preventDefault?.(); last.focus?.(); }
				else if (!event.shiftKey && (active === last || !inside)) { event.preventDefault?.(); first.focus?.(); }
			};
			_react.useEffect(() => {
				if (!showDialog) return;
				cancelRef.current?.focus?.();
				document.addEventListener("keydown", containKey);
					return () => {
						document.removeEventListener("keydown", containKey);
						if (!returningToChooserRef.current) restoreFocus?.();
				};
			}, [restoreFocus, showDialog]);
				const prepare = _react.useCallback(async () => {
					const request = ++preparationRequestRef.current;
					const requestKey = targetKey;
					setPreviews([]); setResult(null); setError(null); setStage("preparing");
					try {
						const prepared = await Promise.all(targets.map((workspace) => previewWorkspaceArchive(workspace.id, workspace.sessionIds, includeActive)));
						if (!mountedRef.current || preparationRequestRef.current !== request || targetRef.current !== requestKey) return;
							const available = prepared.filter((item) => Array.isArray(item?.sessions) && item.sessions.length > 0);
							if (available.length === 0) {
								returningToChooserRef.current = true;
								onEmptyRef.current?.();
							return;
						}
						setPreviews(available);
						setStage("confirm");
					} catch (reason) {
						if (mountedRef.current && preparationRequestRef.current === request && targetRef.current === requestKey) { setError(reason); setStage("error"); }
					}
				}, [targetKey, targets]);
			_react.useEffect(() => {
				mountedRef.current = true;
				void prepare();
				return () => {
					mountedRef.current = false;
					preparationRequestRef.current += 1;
					applyRequestRef.current += 1;
				};
				}, [prepare]);
				const apply = async () => {
					const validPreviews = previews.filter((item) => Array.isArray(item?.sessions) && item.sessions.length > 0
						&& typeof item?.token === "string" && typeof item?.nonce === "string");
					if (busyRef.current || stage !== "confirm" || validPreviews.length !== previews.length || validPreviews.length === 0) return;
					const request = ++applyRequestRef.current;
					busyRef.current = true; setBusy(true); setError(null);
					const combined = { workspace: null, archived: [], skipped: [], failed: [], snapshots: [] };
					try {
						for (const prepared of validPreviews) {
							try {
								const applied = await applyWorkspaceArchive(prepared.token, prepared.nonce, Array.isArray(prepared.stopSessionIds) && prepared.stopSessionIds.length > 0);
								for (const key of ["archived", "skipped", "failed", "snapshots"]) {
									if (Array.isArray(applied?.[key])) combined[key].push(...applied[key]);
								}
							} catch (reason) {
								if (validPreviews.length === 1) throw reason;
								const failureReason = typeof reason?.body?.error === "string"
									? reason.body.error
									: typeof reason?.code === "string" ? reason.code : "unknown";
								for (const session of prepared.sessions) combined.failed.push({
									id: session.id,
									title: session.title,
									reason: failureReason,
								});
							}
						}
						if (!mountedRef.current || applyRequestRef.current !== request) return;
						const archived = combined.archived;
						const skipped = combined.skipped;
						const failed = combined.failed;
						const fullSuccess = archived.length > 0 && skipped.length === 0 && failed.length === 0;
						if (fullSuccess && (directArchive || previewPrimitives.Toast !== null)) {
							try { await onApplied?.(combined); } catch { /* refresh failure must not hold a completed dialog open */ }
							if (mountedRef.current && applyRequestRef.current === request) onClose?.();
							return;
						}
						setResult(combined); setStage("result");
						if (archived.length > 0) try { await onApplied?.(combined); } catch { /* the completed result remains readable */ }
					} catch (reason) {
						if (combined.archived.length > 0) try { await onApplied?.(combined); } catch { /* refresh best effort after partial completion */ }
						if (mountedRef.current && applyRequestRef.current === request) { setPreviews([]); setError(reason); setStage("error"); }
					} finally {
					if (mountedRef.current && applyRequestRef.current === request) { busyRef.current = false; setBusy(false); }
				}
			};
				// A single idle chat follows the Host's direct archive interaction.
                // The prepared response, not cached row state, decides whether stopping needs consent.
                _react.useEffect(() => {
                    if (directArchive && stage === "confirm" && !requiresStop) void apply();
                }, [directArchive, stage, previews, requiresStop]);
                const previewSessions = previews.flatMap((item) => Array.isArray(item?.sessions) ? item.sessions : []);
				const previewSkipped = previews.flatMap((item) => Array.isArray(item?.skipped) ? item.skipped : []);
				const count = previewSessions.length;
				const skippedLiveCount = previewSkipped.filter((item) => item?.reason === "session-live").length;
				const targetTitle = safeLabel(previews[0]?.workspace) || targets[0]?.title || targets[0]?.id || "";
                const zh = isZh(t);
                const globalScope = scope === "all";
                const singleSession = targets.length === 1 && targets[0].sessionIds?.length === 1;
                const multipleWorkspaces = targets.length > 1;
                const confirmTitle = requiresStop
                    ? (zh ? (globalScope ? "停止并归档全部会话？" : singleSession || count === 1 ? "停止并归档此会话？" : "停止并归档这些会话？")
                        : (globalScope ? "Stop and archive all chats?" : singleSession || count === 1 ? "Stop and archive this chat?" : "Stop and archive these chats?"))
                    : globalScope ? (zh ? "归档全部会话？" : "Archive all chats?")
                        : singleSession ? (zh ? "归档此会话？" : "Archive this chat?")
                            : multipleWorkspaces ? (zh ? "归档所选工作区的会话？" : "Archive chats in the selected workspaces?") : t("workspaceArchive.confirmTitle");
                const scopeBody = globalScope
                    ? (zh ? "这会将所有工作区中的会话归档。之后可在“已归档”中查看。" : "This will archive chats in all workspaces. You can find them later under Archived.")
                    : singleSession ? (zh ? "这会将此会话归档。之后可在“已归档”中查看。" : "This will archive this chat. You can find it later under Archived.")
                        : multipleWorkspaces ? t("workspaceArchive.confirmBodyMany") : t("workspaceArchive.confirmBody").replace("{workspace}", targetTitle);
                const confirmBody = requiresStop
                    ? `${scopeBody} ${zh ? "归档会停止所选会话中正在进行的工作。之后可以取消归档。" : "Archiving will stop ongoing work in the selected chats. You can unarchive them later."}`
                    : scopeBody;
			const skippedLiveText = t("workspaceArchive.skippedLive").replace("{count}", String(skippedLiveCount));
			const skippedLiveNotice = skippedLiveCount > 0 && (0, jsx.jsx)("p", { className: "dac-workspace-skipped-live", "data-workspace-archive-skipped-live": "1", children: skippedLiveText });
			const resultRows = (label, rows) => {
				const visibleRows = Array.isArray(rows) ? rows : [];
				if (visibleRows.length === 0) return null;
				return (0, jsx.jsxs)("section", { className: "dac-workspace-result-group", children: [
					(0, jsx.jsx)("strong", { children: label }),
					(0, jsx.jsx)("ul", { children: visibleRows.map((item) => (0, jsx.jsx)("li", { children: typeof item === "string" ? item : `${safeLabel(item)} · ${safeReason(item?.reason, item?.status)}` }, typeof item === "string" ? item : `${item?.id}:${item?.reason ?? item?.status ?? ""}`)) })
				] });
			};
			if (!showDialog) return null;
			return (0, jsx.jsx)("div", { className: "dac-confirm-overlay dac-action-confirm-overlay", onClick: close, children: (0, jsx.jsxs)("div", {
				ref: dialogRef, className: "dac-confirm dac-workspace-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dac-workspace-archive-title", tabIndex: -1,
				onClick: (event) => event.stopPropagation(), onKeyDown: containKey,
				children: [
					(0, jsx.jsxs)("div", { className: "dac-preview-head", children: [
						(0, jsx.jsx)("strong", { id: "dac-workspace-archive-title", children: stage === "confirm" ? confirmTitle : stage === "result" ? t("workspaceArchive.result") : t("workspaceArchive.action") }),
						(0, jsx.jsx)("button", { type: "button", className: "dac-iconbtn", disabled: busy, "aria-label": t("workspaceArchive.close"), onClick: close, children: (0, jsx.jsx)(IconClose, { size: 16 }) })
					] }),
					stage === "preparing" && (0, jsx.jsx)("div", { className: "dac-workspace-body", role: "status", children: (0, jsx.jsx)("p", { className: "dac-workspace-copy", children: t("workspaceArchive.loading") }) }),
					stage === "confirm" && (0, jsx.jsxs)("div", { className: "dac-workspace-body", children: [
						(0, jsx.jsx)("p", { className: "dac-workspace-copy", children: confirmBody }),
						skippedLiveNotice,
					] }),
					stage === "result" && (0, jsx.jsxs)("div", { className: "dac-workspace-body", "data-workspace-archive-result": "1", children: [
						resultRows(t("workspaceArchive.archived"), result?.archived),
						resultRows(t("workspaceArchive.skipped"), result?.skipped),
						resultRows(t("workspaceArchive.failed"), result?.failed),
						(0, jsx.jsx)("button", { type: "button", className: "dac-btn-primary", onClick: close, children: t("workspaceArchive.done") })
					] }),
					stage === "error" && (0, jsx.jsxs)("div", { className: "dac-workspace-body dac-error", role: "status", children: [
						(0, jsx.jsx)("span", { children: errorText }),
						(0, jsx.jsx)("button", { type: "button", className: "dac-btn", disabled: busy, "data-workspace-archive-retry": "1", onClick: () => { void prepare(); }, children: t("workspaceArchive.retry") })
					] }),
					stage !== "result" && (0, jsx.jsxs)("div", { className: "dac-workspace-actions", children: [
						(0, jsx.jsx)("button", { ref: cancelRef, type: "button", className: "dac-btn", disabled: busy, "data-workspace-archive-cancel": "1", onClick: close, children: t("confirm.cancel") }),
						(0, jsx.jsx)("button", { type: "button", className: requiresStop ? "dac-btn dac-stop-archive" : "dac-btn", disabled: busy || stage !== "confirm" || count === 0, "data-workspace-archive-apply": "1", onClick: apply, children: busy ? t("workspaceArchive.applying") : requiresStop ? (isZh(t) ? "停止并归档" : "Stop and archive") : t("workspaceArchive.apply") })
					] })
				]
			}) });
		}

		function ConfirmDialog({ title, body, confirmLabel, cancelLabel, confirmClassName = "dac-btn-danger", deleteAll = false, hideConfirm = false, confirmDisabled = false, dialogClassName = "", busy, returnFocus, fallbackFocusRef, onConfirm, onCancel }) {
			const destructive = confirmClassName === "dac-btn-danger";
			const dialogRef = _react.useRef(null);
			const cancelRef = _react.useRef(null);
			const callbacksRef = _react.useRef({ busy, confirmDisabled, onCancel, onConfirm });
			callbacksRef.current = { busy, confirmDisabled, onCancel, onConfirm };
			const submittingRef = _react.useRef(false);
			const cancel = () => { if (!callbacksRef.current.busy && !submittingRef.current) callbacksRef.current.onCancel(); };
			const submit = async () => {
				if (callbacksRef.current.busy || callbacksRef.current.confirmDisabled || submittingRef.current) return;
				submittingRef.current = true;
				try { await callbacksRef.current.onConfirm(); } finally { submittingRef.current = false; }
			};
			const containEscape = (event) => {
				if (event.key !== "Escape") return;
				event.preventDefault?.();
				event.stopPropagation?.();
				event.nativeEvent?.stopImmediatePropagation?.();
				cancel();
			};
			_react.useEffect(() => {
				const previousFocus = returnFocus ?? document.activeElement;
				const dialog = dialogRef.current;
				(cancelRef.current ?? dialog)?.focus?.();
				const onKey = (e) => {
					if (e.key === "Escape") {
						e.preventDefault?.();
						e.stopPropagation?.();
						e.stopImmediatePropagation?.();
						cancel();
						return;
					}
					if (e.key !== "Tab" || dialog === null) return;
					const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
					if (focusable.length === 0) {
						e.preventDefault();
						dialog.focus?.();
						return;
					}
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					const active = document.activeElement;
					const focusIsInside = typeof dialog.contains === "function" ? dialog.contains(active) : focusable.includes(active);
					if (e.shiftKey && (active === first || !focusIsInside)) {
						e.preventDefault();
						last.focus();
					} else if (!e.shiftKey && (active === last || !focusIsInside)) {
						e.preventDefault();
						first.focus();
					}
				};
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("keydown", onKey);
					const previousIsUsable = previousFocus !== null
						&& previousFocus !== document.body
						&& typeof previousFocus?.focus === "function"
						&& (typeof document.contains !== "function" || document.contains(previousFocus));
					const target = previousIsUsable ? previousFocus : fallbackFocusRef?.current;
					target?.focus?.();
				};
			}, [returnFocus, fallbackFocusRef]);
			return (0, jsx.jsx)("div", {
				className: "dac-confirm-overlay dac-action-confirm-overlay",
				onClick: cancel,
				children: (0, jsx.jsxs)("div", {
					ref: dialogRef,
					className: `dac-confirm dac-action-confirm${destructive ? " dac-delete-confirm" : ""}${dialogClassName ? ` ${dialogClassName}` : ""}`,
					role: "alertdialog",
					"aria-modal": "true",
					"aria-labelledby": "dac-confirm-title",
					"aria-describedby": "dac-confirm-body",
					tabIndex: -1,
					onKeyDown: containEscape,
					onClick: (e) => e.stopPropagation(),
					children: [
						(0, jsx.jsxs)("div", { className: "dac-confirm-heading", children: [
							(0, jsx.jsx)("div", { id: "dac-confirm-title", className: "dac-confirm-title", children: title }),
							!destructive && (0, jsx.jsx)("button", { type: "button", className: "dac-iconbtn", "aria-label": cancelLabel, disabled: busy, onClick: cancel, children: (0, jsx.jsx)(IconClose, { size: 16 }) }),
						] }),
						(0, jsx.jsx)("div", { id: "dac-confirm-body", className: "dac-confirm-body", children: body }),
						(0, jsx.jsxs)("div", {
							className: "dac-confirm-actions",
							children: [
								(0, jsx.jsx)("button", { ref: cancelRef, type: "button", className: "dac-btn", disabled: busy, onClick: cancel, children: cancelLabel }),
								!hideConfirm && (0, jsx.jsxs)("button", { type: "button", className: `${confirmClassName}${deleteAll ? " dac-delete-all" : ""}`, disabled: busy || confirmDisabled, "aria-busy": busy === true, onClick: submit, children: [deleteAll && (0, jsx.jsx)(IconTrash, { size: 16 }), confirmLabel] })
							]
						})
					]
				})
			});
		}

		/** Accessible tags/note editor — same focus contract as ConfirmDialog. */
		function MetadataDialog({ session, t, busy, returnFocus, fallbackFocusRef, onSave, onCancel }) {
			const dialogRef = _react.useRef(null);
			const tagInputRef = _react.useRef(null);
			const keyHandlerRef = _react.useRef(null);
			const [tags, setTags] = _react.useState(() => foldTags(session.tags));
			const [tagDraft, setTagDraft] = _react.useState("");
			const [note, setNote] = _react.useState(typeof session.note === "string" ? session.note : "");
			const savedTags = foldTags([...tags, tagDraft]);
			const overTags = savedTags.length > 8 || savedTags.some((tag) => Array.from(tag).length > 24);
			const overNote = Array.from(note).length > 2000;
			const commitDraft = () => {
				if (tagDraft.trim() === "") return;
				setTags((current) => foldTags([...current, tagDraft]));
				setTagDraft("");
			};
			const onKeyDown = (e) => {
				const dialog = dialogRef.current;
				if (e.key === "Escape") {
					e.preventDefault?.();
					e.stopPropagation?.();
					e.stopImmediatePropagation?.();
					e.nativeEvent?.stopImmediatePropagation?.();
					if (!busy) onCancel();
					return;
				}
				if (e.key !== "Tab" || dialog === null) return;
				e.stopPropagation?.();
				const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
				if (focusable.length === 0) {
					e.preventDefault();
					dialog.focus?.();
					return;
				}
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				const active = document.activeElement;
				const focusIsInside = focusable.includes(active);
				if (e.shiftKey && (active === first || !focusIsInside)) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && (active === last || !focusIsInside)) {
					e.preventDefault();
					first.focus();
				}
			};
			keyHandlerRef.current = onKeyDown;
			_react.useEffect(() => {
				const previousFocus = returnFocus ?? document.activeElement;
				const dialog = dialogRef.current;
				(tagInputRef.current ?? dialog)?.focus?.();
				const onDocumentKeyDown = (event) => keyHandlerRef.current?.(event);
				document.addEventListener("keydown", onDocumentKeyDown);
				return () => {
					document.removeEventListener("keydown", onDocumentKeyDown);
					const previousIsUsable = previousFocus !== null
						&& previousFocus !== document.body
						&& typeof previousFocus?.focus === "function"
						&& (typeof document.contains !== "function" || document.contains(previousFocus));
					const target = previousIsUsable ? previousFocus : fallbackFocusRef?.current;
					target?.focus?.();
				};
			}, []);
			return (0, jsx.jsx)("div", {
				className: "dac-confirm-overlay",
				onClick: () => { if (!busy) onCancel(); },
				children: (0, jsx.jsxs)("div", {
					ref: (element) => {
						dialogRef.current = element;
						if (element !== null && busy) element.focus?.();
					},
					className: "dac-confirm dac-meta-dialog",
					role: "dialog",
					"aria-modal": "true",
					"aria-labelledby": "dac-meta-title",
					"aria-describedby": "dac-meta-limits",
					tabIndex: -1,
					onKeyDown,
					onClick: (e) => e.stopPropagation(),
					children: [
						(0, jsx.jsx)("div", { id: "dac-meta-title", className: "dac-confirm-title", children: t("tag.edit") }),
						(0, jsx.jsx)("label", { className: "dac-field-label", htmlFor: "dac-meta-tags", children: t("tag.input") }),
						(0, jsx.jsxs)("div", { className: "dac-tag-editor", children: [
						...tags.map((tag) => (0, jsx.jsxs)("button", { type: "button", className: "dac-chip", "aria-label": removeTagLabel(t, tag), disabled: busy, onClick: () => setTags((current) => current.filter((value) => value !== tag)), children: [(0, jsx.jsx)("span", { children: tag }), (0, jsx.jsx)(IconClose, { size: 10 })] }, tag)),
							(0, jsx.jsx)("input", {
								id: "dac-meta-tags",
								ref: tagInputRef,
								type: "text",
							className: "dac-meta-input",
							disabled: busy,
								value: tagDraft,
								placeholder: t("tag.placeholder"),
								"aria-invalid": overTags,
								onChange: (e) => setTagDraft(e.target.value),
								onKeyDown: (e) => {
									if (e.key === "Enter" && !e.isComposing && !e.nativeEvent?.isComposing) { e.preventDefault(); commitDraft(); }
									if (e.key === "Backspace" && tagDraft === "") setTags((current) => current.slice(0, -1));
								}
							})
						]}),
						(0, jsx.jsx)("div", { id: "dac-meta-limits", className: "dac-meta-limits", children: tagsLimitLabel(t, savedTags.length) }),
						(0, jsx.jsx)("label", { className: "dac-field-label", htmlFor: "dac-meta-note", children: t("note.label") }),
						(0, jsx.jsx)("textarea", {
							id: "dac-meta-note",
						className: "dac-meta-note",
						disabled: busy,
							value: note,
							rows: 4,
							placeholder: t("note.placeholder"),
							"aria-invalid": overNote,
							onChange: (e) => setNote(e.target.value)
						}),
						(0, jsx.jsx)("div", { className: "dac-meta-limits", children: noteLimitLabel(t, Array.from(note).length) }),
						(0, jsx.jsxs)("div", {
							className: "dac-confirm-actions",
							children: [
							(0, jsx.jsx)("button", { type: "button", className: "dac-btn", disabled: busy, onClick: () => { if (!busy) onCancel(); }, children: t("confirm.cancel") }),
								(0, jsx.jsx)("button", { type: "button", className: "dac-btn-primary", disabled: busy || overTags || overNote, onClick: () => onSave(savedTags, note.trim()), children: t("meta.save") })
							]
						})
					]
				})
			});
		}

			function importWarningText(t, warning) {
				if (warning?.reason === "title-publication-degraded") {
					return t(warning.detail === "seeded-cold-list-unsupported"
						? "import.seededTitleLimitation" : "import.titlePublicationDegraded");
				}
				if (warning === "workspace-unresolved") return t("import.workspaceWarning");
				if (warning === "attachment-references" || warning === "attachments-not-included") return t("import.attachmentWarning");
				return typeof warning === "string" ? warning : t("import.titlePublicationDegraded");
			}

			function importFailureText(t, error) {
				const key = {
					"import-token-invalid": "import.expired",
					"restore-unsupported": "import.unsupported",
					"restore-rollback-failed": "import.rollbackFailed",
					"id-conflict": "import.conflictChanged",
					"nothing-to-restore": "import.conflictChanged",
				}[error?.body?.error];
				return key ? t(key) : String(error?.message ?? error);
			}

				function ImportDialog({ preview, t, busy, returnFocus, fallbackFocusRef, onToggle, onSelectAll, onClear, onConfirm, onCancel }) {
				const dialogRef = _react.useRef(null);
				const cancelRef = _react.useRef(null);
				const keyHandlerRef = _react.useRef(null);
				const sessions = Array.isArray(preview?.sessions) ? preview.sessions : [];
				const selected = new Set(preview?.selectedIds ?? []);
				const eligible = sessions.filter((session) => session.conflict !== true);
				const allSelected = eligible.length > 0 && eligible.every((session) => selected.has(session.id));
				const onKeyDown = (event) => {
					const dialog = dialogRef.current;
					if (event.key === "Escape") {
						event.preventDefault?.();
						event.stopPropagation?.();
						event.stopImmediatePropagation?.();
						event.nativeEvent?.stopImmediatePropagation?.();
						if (!busy) onCancel();
						return;
					}
					if (event.key !== "Tab" || dialog === null) return;
					event.stopPropagation?.();
					const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
					if (focusable.length === 0) { event.preventDefault?.(); dialog.focus?.(); return; }
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					const active = document.activeElement;
					const inside = focusable.includes(active);
					if (event.shiftKey && (active === first || !inside)) { event.preventDefault?.(); last.focus?.(); }
					else if (!event.shiftKey && (active === last || !inside)) { event.preventDefault?.(); first.focus?.(); }
				};
				keyHandlerRef.current = onKeyDown;
				_react.useEffect(() => {
					const previousFocus = returnFocus ?? document.activeElement;
					(cancelRef.current ?? dialogRef.current)?.focus?.();
					const onDocumentKeyDown = (event) => keyHandlerRef.current?.(event);
					document.addEventListener("keydown", onDocumentKeyDown);
					return () => {
						document.removeEventListener("keydown", onDocumentKeyDown);
						const previousIsUsable = previousFocus !== null
							&& previousFocus !== document.body
							&& typeof previousFocus?.focus === "function"
							&& (typeof document.contains !== "function" || document.contains(previousFocus));
						(previousIsUsable ? previousFocus : fallbackFocusRef?.current)?.focus?.();
					};
				}, []);
				const result = preview?.result;
				const resultWarnings = Array.isArray(result?.warnings) ? result.warnings : [];
				const generator = preview?.package?.generator;
				const generatorName = typeof generator === "string" ? generator : generator?.name ?? "dsh-archived-chats";
				const generatorVersion = typeof generator === "object" ? generator?.version : undefined;
				const packageVersion = preview?.package?.version ?? "1";
				const packageLabel = generatorVersion
					? `${generatorName} v${generatorVersion} · format v${packageVersion}`
					: `${generatorName} · v${packageVersion}`;
				return (0, jsx.jsx)("div", {
					className: "dac-confirm-overlay",
					onClick: () => { if (!busy) onCancel(); },
					children: (0, jsx.jsxs)("div", {
						ref: (element) => {
							dialogRef.current = element;
							if (element !== null && busy) element.focus?.();
						},
						className: "dac-confirm dac-import-dialog",
						role: "dialog",
						"aria-modal": "true",
						"aria-labelledby": "dac-import-title",
						"aria-describedby": "dac-import-description",
						"aria-busy": busy === true,
						tabIndex: -1,
						onKeyDown,
						onClick: (event) => event.stopPropagation(),
						children: [
							(0, jsx.jsx)("div", { id: "dac-import-title", className: "dac-confirm-title", children: t("import.title") }),
							(0, jsx.jsx)("div", { id: "dac-import-description", className: "dac-confirm-body", children: result ? t("import.done") : t("import.preview") }),
							!result && (0, jsx.jsxs)("div", { className: "dac-import-package", children: [
								(0, jsx.jsx)("strong", { children: t("import.package") }),
								(0, jsx.jsx)("span", { children: packageLabel }),
								(0, jsx.jsx)("span", { children: `${preview?.package?.sessionCount ?? sessions.length} ${isZh(t) ? "个会话" : "sessions"}` }),
							] }),
							result ? (0, jsx.jsxs)("div", { className: "dac-import-result", children: [
								(0, jsx.jsxs)("div", { className: "dac-import-result-counts", children: [
									(0, jsx.jsx)("span", { children: `${t("import.restored")}: ${(result.restored ?? []).length}` }),
									(0, jsx.jsx)("span", { children: `${t("import.skipped")}: ${(result.skipped ?? []).length}` }),
								] }),
								...resultWarnings.map((warning, index) => (0, jsx.jsx)("div", { className: "dac-import-warning", role: "status", children: importWarningText(t, warning) }, `${warning?.id ?? "warning"}-${warning?.detail ?? index}`)),
							] }) : (0, jsx.jsxs)("div", { className: "dac-import-list", children: [
								(0, jsx.jsxs)("div", { className: "dac-import-selection", children: [
									(0, jsx.jsx)("button", { type: "button", className: "dac-btn", onClick: onSelectAll, disabled: allSelected || busy, children: t("import.selectAll") }),
									(0, jsx.jsx)("button", { type: "button", className: "dac-btn", onClick: onClear, disabled: selected.size === 0 || busy, children: t("import.clear") }),
								] }),
								sessions.map((session) => {
									const warnings = Array.isArray(session.warnings) ? session.warnings : [];
									return (0, jsx.jsxs)("label", { className: session.conflict ? "dac-import-row dac-import-conflict" : "dac-import-row", children: [
										(0, jsx.jsx)("input", { type: "checkbox", className: "dac-checkbox", checked: selected.has(session.id), disabled: session.conflict === true || busy, onChange: (event) => onToggle(session.id, event.target.checked) }),
										(0, jsx.jsxs)("span", { className: "dac-import-main", children: [
											(0, jsx.jsx)("strong", { children: session.title || t("chat.untitled") }),
											(0, jsx.jsx)("span", { children: session.workspace?.title || t("group.noProject") }),
											...(session.conflict ? [(0, jsx.jsx)("small", { children: t("import.conflict") })] : []),
											...warnings.map((warning) => (0, jsx.jsx)("small", { children: importWarningText(t, warning) }, `${session.id}-${warning}`)),
										] }),
									] }, session.id);
								})
							] }),
							preview?.error && (0, jsx.jsx)("div", { className: "dac-import-error", role: "alert", children: preview.error }),
							(0, jsx.jsxs)("div", { className: "dac-confirm-actions", children: [
								(0, jsx.jsx)("button", { ref: (element) => {
									cancelRef.current = element;
									if (element !== null && result) element.focus?.();
								}, type: "button", className: "dac-btn", disabled: busy, onClick: () => { if (!busy) onCancel(); }, children: t(result ? "import.close" : "import.cancel") }),
								!result && (0, jsx.jsx)("button", { type: "button", className: "dac-btn-primary", disabled: busy || selected.size === 0, onClick: onConfirm, children: busy ? t("import.inspecting") : t("import.confirm") }),
							] })
						]
					})
				});
				}

				function PreviewMarkdown({ text, t, primitives = previewPrimitives }) {
					const MarkdownText = primitives.MarkdownText;
					if (MarkdownText === null) return (0, jsx.jsx)("p", { className: "dac-preview-plain", children: text });
					return (0, jsx.jsx)(MarkdownText, {
						text,
						streaming: false,
						labels: { code: { copyLabel: t("preview.copy"), copiedLabel: t("preview.copied") }, footnotes: isZh(t) ? "脚注" : "Footnotes" },
					});
				}

				function PreviewDisclosure({ title, summary, kind, children, primitives = previewPrimitives, defaultOpen = false }) {
					const DisclosureRow = primitives.DisclosureRow;
					const [open, setOpen] = _react.useState(defaultOpen);
                    _react.useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
					const NativeIcon = kind === "reasoning" ? primitives.IconThink : kind === "tool" ? null : primitives.IconPrompt;
					const icon = NativeIcon != null ? (0, jsx.jsx)(NativeIcon, { size: 14 })
						: (0, jsx.jsx)("svg", { ...svgProps(14), children: (0, jsx.jsx)("path", { d: kind === "reasoning"
							? "M8 18h8M9 21h6M8 15a7 7 0 1 1 8 0v3H8Z"
							: kind === "tool" ? "M8 8l4 4-4 4m6 0h3M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
							: "M7 3h10a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM8 8h8M8 12h5" }) });
					const collapsedContent = summary ? (0, jsx.jsx)("span", { className: "dac-preview-fold-summary", children: summary }) : null;
					if (DisclosureRow === null) return (0, jsx.jsxs)("details", {
						className: "dac-preview-disclosure dac-preview-fold", open, onToggle: event => setOpen(event.currentTarget.open),
						children: [(0, jsx.jsxs)("summary", { children: [
							(0, jsx.jsxs)("span", { className: "dac-preview-fold-leading", "aria-hidden": true, children: [
								(0, jsx.jsx)("span", { className: "dac-preview-fold-icon", children: icon }),
								(0, jsx.jsx)("span", { className: "dac-preview-fold-chevron", children: (0, jsx.jsx)(IconChevron, { size: 14 }) }),
							] }),
							(0, jsx.jsx)("span", { children: title }),
							collapsedContent,
						] }), children],
					});
					return (0, jsx.jsx)(DisclosureRow, {
						className: "dac-preview-disclosure",
						icon,
						title,
						collapsedContent,
						open,
						expandable: true,
						expandOnRowClick: true,
						onToggle: () => setOpen((value) => !value),
						children,
					});
				}

				function PreviewReasoning({ text, t, primitives = previewPrimitives }) {
					return (0, jsx.jsx)(PreviewDisclosure, { title: t("preview.reasoning"), kind: "reasoning", primitives,
						summary: String(text ?? "").replace(/\s+/gu, " ").slice(0, 180),
						children: (0, jsx.jsx)("div", { className: "dac-preview-reasoning-body", children: text }),
					});
				}

				function PreviewJson({ label, text, t }) {
					const JsonBlock = previewPrimitives.JsonBlock;
					let payload = text;
					try { payload = JSON.parse(text); } catch { /* escaped text fallback stays a string */ }
					if (JsonBlock !== null) return (0, jsx.jsx)(JsonBlock, { label: label || t("preview.json"), payload });
					return (0, jsx.jsx)("pre", { className: "dac-preview-code", children: text });
				}

				function previewJsonValue(text) {
					try { return JSON.parse(text); } catch { return text; }
				}

				function PreviewTool({ segment, t }) {
					const JsonBlock = previewPrimitives.JsonBlock;
					const argumentsText = typeof segment.argumentsText === "string" ? segment.argumentsText : segment.text || "";
					const args = previewJsonValue(argumentsText);
					const summary = [args?.description, args?.title, args?.command, args?.path].find((value) => typeof value === "string" && value.trim() !== "");
					const body = (0, jsx.jsxs)("div", { className: `dac-preview-tool-body${segment.result?.isError ? " dac-error" : ""}`, children: [
						JsonBlock !== null
							? (0, jsx.jsx)(JsonBlock, { label: t("preview.toolArguments"), payload: previewJsonValue(argumentsText) })
							: (0, jsx.jsxs)("div", { children: [(0, jsx.jsx)("span", { className: "dac-preview-detail-label", children: t("preview.toolArguments") }), (0, jsx.jsx)("pre", { className: "dac-preview-code", children: argumentsText })] }),
						segment.result !== undefined && (0, jsx.jsxs)("div", { children: [(0, jsx.jsx)("span", { className: "dac-preview-detail-label", children: t("preview.toolResult") }), (0, jsx.jsx)("pre", { className: `dac-preview-tool-result${segment.result.isError ? " dac-error" : ""}`, children: segment.result.text || "" })] }),
					] });
					return (0, jsx.jsx)(PreviewDisclosure, {
						title: segment.name === "bash" ? "Bash" : segment.name || segment.label || t("preview.toolCall"),
						kind: "tool", summary: summary?.replace(/\s+/gu, " ").slice(0, 180),
						children: body,
					});
				}

				function PreviewToolResult({ segment, t }) {
					const [open, setOpen] = _react.useState(false);
					const DisclosureRow = previewPrimitives.DisclosureRow;
					const body = (0, jsx.jsx)("div", { className: `dac-preview-tool-body${segment.isError ? " dac-error" : ""}`, children: (0, jsx.jsx)("pre", { className: `dac-preview-tool-result${segment.isError ? " dac-error" : ""}`, children: segment.text || "" }) });
					if (DisclosureRow === null) return (0, jsx.jsxs)("details", { className: `dac-preview-disclosure${segment.isError ? " dac-error" : ""}`, children: [
						(0, jsx.jsx)("summary", { children: previewSegmentLabel(t, segment) }),
						body,
					] });
					return (0, jsx.jsx)(DisclosureRow, {
						title: previewSegmentLabel(t, segment),
						open,
						expandable: true,
						expandOnRowClick: true,
						onToggle: () => setOpen((value) => !value),
						children: body,
					});
				}

				function PreviewImage({ sessionId, attachment, t, scope = "archive" }) {
					const rootRef = _react.useRef(null);
					const [state, setState] = _react.useState({ status: "idle", url: null });
					_react.useEffect(() => {
						if (typeof attachment?.attachmentId !== "string") return () => {};
						const controller = new AbortController();
						let objectUrl = null;
						let started = false;
						let disposed = false;
						let observer = null;
						const load = async () => {
							if (started) return;
							started = true;
							setState({ status: "loading", url: null });
							try {
								const blob = await fetchArchiveImage(sessionId, attachment.attachmentId, controller.signal, scope);
								if (disposed) return;
								objectUrl = (window.URL ?? URL).createObjectURL(blob);
								setState({ status: "ready", url: objectUrl });
							} catch (error) {
								if (!controller.signal.aborted) setState({ status: "error", url: null });
							}
						};
						const Observer = typeof window !== "undefined" ? window.IntersectionObserver : null;
						if (typeof Observer !== "function" || rootRef.current === null) void load();
						else {
							observer = new Observer((entries) => {
								if (entries.some((entry) => entry.isIntersecting)) {
									observer.disconnect();
									void load();
								}
							}, { rootMargin: "240px" });
							observer.observe(rootRef.current);
						}
						return () => {
							disposed = true;
							observer?.disconnect();
							controller.abort();
							if (objectUrl !== null) (window.URL ?? URL).revokeObjectURL(objectUrl);
						};
					}, [sessionId, attachment?.attachmentId, scope]);

					const descriptorParts = [];
					if (typeof attachment?.name === "string" && attachment.name !== "") descriptorParts.push(attachment.name);
					if (Number.isFinite(attachment?.width) && Number.isFinite(attachment?.height)) descriptorParts.push(`${attachment.width}×${attachment.height}`);
					const descriptor = descriptorParts.join(" · ");
					const alt = descriptor || t("preview.imageUnavailable");
					if (state.status === "ready") return (0, jsx.jsx)("img", { ref: rootRef, src: state.url, alt, loading: "lazy" });
					return (0, jsx.jsx)("span", { ref: rootRef, className: "dac-preview-image-placeholder", children: state.status === "error" && descriptor !== "" ? `${t("preview.imageUnavailable")} · ${descriptor}` : alt });
				}

				function groupPreviewSegments(segments) {
					const groups = [];
					for (let index = 0; index < (Array.isArray(segments) ? segments.length : 0); index += 1) {
						const segment = segments[index];
						if (segment?.kind !== "image") { groups.push({ kind: "segment", segment }); continue; }
						const images = [segment];
						while (segments[index + 1]?.kind === "image") images.push(segments[++index]);
						groups.push({ kind: "images", images });
					}
					return groups;
				}

				function PreviewSegment({ segment, role, t, matched = false }) {
                    // Matched structured content is expanded as escaped text, including
                    // correlated tool output; Host JSON widgets can independently fold.
                    const expandedText = [segment?.name, segment?.argumentsText ?? segment?.text, segment?.result?.text].filter(Boolean).join("\n\n");
                    if (matched && !["text", "image"].includes(segment?.kind)) return (0, jsx.jsxs)("div", { className: "dac-preview-match-content", children: [
                        (0, jsx.jsx)("span", { className: "dac-preview-detail-label", children: previewSegmentLabel(t, segment) }),
                        (0, jsx.jsx)("pre", { className: "dac-preview-code", children: expandedText })
                    ] });
					if (segment?.kind === "text") {
						return role === "assistant"
							? (0, jsx.jsx)(PreviewMarkdown, { text: segment.text, t })
							: (0, jsx.jsx)("span", { className: "dac-preview-plain", children: segment.text });
					}
					if (segment?.kind === "reasoning") return (0, jsx.jsx)(PreviewReasoning, { text: segment.text, t });
					if (segment?.kind === "json") return (0, jsx.jsx)(PreviewJson, { label: segment.label, text: segment.text, t });
					if (segment?.kind === "image") return (0, jsx.jsx)("span", { className: "dac-preview-image-placeholder", children: segment.text });
					if (segment?.kind === "tool-call") return (0, jsx.jsx)(PreviewTool, { segment, t });
					if (segment?.kind === "tool-result") return (0, jsx.jsx)(PreviewToolResult, { segment, t });
					return (0, jsx.jsxs)("details", { className: `dac-preview-disclosure${segment?.isError ? " dac-error" : ""}`, children: [
						(0, jsx.jsx)("summary", { children: previewSegmentLabel(t, segment) }),
						(0, jsx.jsx)("pre", { className: "dac-preview-code", children: segment?.text || "" }),
					] });
				}

				function previewProcessLabel(t, turn) {
					const labels = [];
					if (turn.toolCallCount > 0) labels.push(isZh(t) ? `${turn.toolCallCount} 次工具调用` : `${turn.toolCallCount} tool call${turn.toolCallCount === 1 ? "" : "s"}`);
					if (turn.messageCount > 0) labels.push(isZh(t) ? `${turn.messageCount} 条消息` : `${turn.messageCount} message${turn.messageCount === 1 ? "" : "s"}`);
					if (turn.subagentCount > 0) labels.push(isZh(t) ? `${turn.subagentCount} 个子代理` : `${turn.subagentCount} subagent${turn.subagentCount === 1 ? "" : "s"}`);
					if (labels.length === 0) labels.push(isZh(t) ? "已思考" : "Thought for a while");
					if (turn.endReason && turn.endReason !== "completed") labels.push(isZh(t) ? "未正常完成" : "Not completed");
					return labels.join(" · ");
				}

				function PreviewMessage({ node, sessionId, t, bindNode, scope = "archive", compact = false, matchSeq }) {
                    const matchesNode = candidate => matchSeq !== undefined && (candidate.seq === matchSeq || candidate.segments?.some(segment => segment.resultSeq === matchSeq));
                    const matched = matchesNode(node);
                    const matchedProcess = node?.members?.some(matchesNode) === true;
					if (node?.kind === "process") return (0, jsx.jsx)("article", {
						ref: bindNode, id: `dac-preview-node-${node.key}`, "data-preview-key": node.key, "data-preview-role": "assistant", tabIndex: -1,
						className: "dac-preview-node dac-preview-assistant",
						children: (0, jsx.jsxs)("details", { className: "dac-preview-process", open: matchedProcess ? true : undefined, children: [
							(0, jsx.jsxs)("summary", { children: [(0, jsx.jsx)("span", { children: previewProcessLabel(t, node.turn) }), (0, jsx.jsx)(IconChevron, { size: 14 })] }),
							(0, jsx.jsx)("div", { className: "dac-preview-process-body", children: node.members.map((member) => (0, jsx.jsx)(PreviewMessage, { node: member, sessionId, t, scope, compact: true, matchSeq }, member.key)) }),
						] }),
					});
					const role = ["user", "assistant", "tool", "context"].includes(node?.role) ? node.role : "system";
					const segments = groupPreviewSegments(node?.segments).map((group, index) => group.kind === "images"
						? (0, jsx.jsx)("div", {
							className: "dac-preview-images",
							"data-align": role === "user" ? "end" : "start",
							children: group.images.map((segment, imageIndex) => (0, jsx.jsx)(PreviewImage, { sessionId, attachment: segment.attachment, t, scope }, `${node.key}:${index}:${imageIndex}`)),
						}, `${node.key}:images:${index}`)
						: (0, jsx.jsx)(PreviewSegment, { segment: group.segment, role, t, matched }, `${node.key}:${index}`));
					return (0, jsx.jsxs)("article", {
						ref: bindNode,
						id: `dac-preview-node-${node.key}`,
						"data-preview-key": node.key,
						"data-preview-role": role,
                        "data-preview-match": matched ? "true" : undefined,
						"aria-label": previewRoleLabel(t, role),
						tabIndex: -1,
						className: `dac-preview-node dac-preview-${role}`,
						children: [
							role === "user" ? (0, jsx.jsx)("div", { className: "dac-preview-user-bubble", children: segments })
								: ["system", "context"].includes(role) ? (0, jsx.jsx)(PreviewDisclosure, {
									title: previewRoleLabel(t, role), kind: role, summary: node.sourceLabel || undefined, defaultOpen: matched,
									children: (0, jsx.jsx)("div", { className: "dac-preview-prompt-body", tabIndex: 0, children: segments }),
								}) : segments,
							!compact && (["user", "assistant"].includes(role)
								? (0, jsx.jsx)(PreviewActions, { node, t })
								: (0, jsx.jsx)("div", { className: "dac-preview-meta", children: formatDate(t, node.time) })),
						],
					});
				}

				function buildPreviewNodes(messages, sessionId = "") {
					const results = new Map();
					const source = Array.isArray(messages) ? messages : [];
					for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
						const message = source[messageIndex];
						const sourceSegments = Array.isArray(message?.segments) ? message.segments : [];
						for (let segmentIndex = 0; segmentIndex < sourceSegments.length; segmentIndex += 1) {
							const segment = sourceSegments[segmentIndex];
							if (segment?.kind !== "tool-result" || typeof segment.toolCallId !== "string") continue;
							const queue = results.get(segment.toolCallId) ?? [];
							queue.push({ messageIndex, segmentIndex, segment, turnKey: message.turn?.key ?? null });
							results.set(segment.toolCallId, queue);
						}
					}
					const consumed = new Set();
					const nodes = [];
					for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
						const message = source[messageIndex];
						const segments = [];
						for (let index = 0; index < (Array.isArray(message?.segments) ? message.segments.length : 0); index += 1) {
							const segment = message.segments[index];
							const identity = `${messageIndex}:${index}`;
							if (segment?.kind === "tool-result" && consumed.has(identity)) continue;
							if (segment?.kind === "tool-call" && typeof segment.callId === "string") {
								const match = (results.get(segment.callId) ?? []).find((entry) => (entry.messageIndex > messageIndex
									|| (entry.messageIndex === messageIndex && entry.segmentIndex > index))
									&& entry.turnKey === (message.turn?.key ?? null)
									&& !consumed.has(`${entry.messageIndex}:${entry.segmentIndex}`));
								if (match !== undefined) {
									consumed.add(`${match.messageIndex}:${match.segmentIndex}`);
									segments.push({ ...segment, result: match.segment, resultSeq: source[match.messageIndex].seq });
									continue;
								}
							}
							segments.push(segment);
						}
						if (segments.length > 0) nodes.push({ ...message, key: `${sessionId ? `${encodeURIComponent(sessionId)}:` : ""}${message.seq}:${messageIndex}`, segments });
					}
					const turns = new Map();
					for (const row of source) {
						if (!row.turn?.key) continue;
						const entry = turns.get(row.turn.key) ?? { turn: row.turn, count: 0 };
						entry.count += 1; turns.set(row.turn.key, entry);
					}
					const processes = new Map();
					for (const { turn, count } of turns.values()) {
						if (!Number.isFinite(turn.endSeq) || !Number.isFinite(turn.answerSeq) || !Number.isFinite(turn.processStartSeq) || count !== turn.rowCount) continue;
						const answer = nodes.find((node) => node.turn?.key === turn.key && node.seq === turn.answerSeq && node.role === "assistant");
						if (!answer) continue;
						const members = nodes.filter((node) => node.turn?.key === turn.key && node.seq >= turn.processStartSeq && node.seq < turn.answerSeq && !["user", "system"].includes(node.role));
						const reasoning = answer.segments.filter((segment) => segment.kind === "reasoning");
						if (reasoning.length > 0) members.push({ ...answer, key: `${answer.key}:reasoning`, segments: reasoning });
						if (members.length === 0) continue;
						processes.set(turn.key, { role: "assistant", kind: "process", key: `${sessionId ? `${encodeURIComponent(sessionId)}:` : ""}${turn.key}:process`, seq: members[0].seq, anchorSeq: members[0].anchorSeq ?? members[0].seq, turn, members, segments: [] });
					}
					const output = [];
					const inserted = new Set();
					for (const node of nodes) {
						const process = processes.get(node.turn?.key);
						const isMember = process?.members.includes(node);
						const isAnswer = process && node.seq === process.turn.answerSeq;
						if (process && (isMember || isAnswer) && !inserted.has(process.key)) { output.push(process); inserted.add(process.key); }
						if (isMember) continue;
						output.push(isAnswer ? { ...node, segments: node.segments.filter((segment) => segment.kind !== "reasoning") } : node);
					}
					return output.sort((left, right) => (left.anchorSeq ?? left.seq) - (right.anchorSeq ?? right.seq));
				}

				function previewCopyText(node) {
					return (Array.isArray(node?.segments) ? node.segments : []).flatMap((segment) => {
						if (segment.kind === "tool-call") return [segment.name, segment.argumentsText, segment.result?.text];
						return [segment.text];
					}).filter((value) => typeof value === "string" && value !== "").join("\n\n");
				}

				function PreviewActions({ node, t }) {
					const [copied, setCopied] = _react.useState(false);
					const [copyFailed, setCopyFailed] = _react.useState(false);
					const copy = async () => {
						const text = previewCopyText(node);
						const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
						if (text === "") return;
						setCopyFailed(false);
						try {
							if (typeof clipboard?.writeText !== "function") throw new Error("clipboard-unavailable");
							await clipboard.writeText(text);
							setCopied(true);
						} catch {
							setCopied(false);
							setCopyFailed(true);
						}
					};
					return (0, jsx.jsxs)("div", { className: "dac-preview-actions", children: [
						(0, jsx.jsx)("time", { dateTime: isoTimestamp(node.time), children: formatDate(t, node.time) }),
						(0, jsx.jsx)("button", { type: "button", onClick: copy, "aria-label": copied ? t("preview.copied") : t("preview.copy"), children: copied ? t("preview.copied") : t("preview.copy") }),
						copyFailed && (0, jsx.jsx)("span", { className: "dac-preview-copy-error", role: "alert", children: t("preview.copyError") }),
					] });
				}

				function usePreviewRail(nodes, feedRef) {
					const [activeKey, setActiveKey] = _react.useState(nodes[0]?.key ?? null);
					const elements = _react.useRef(new Map());
					_react.useEffect(() => {
						const Observer = typeof window !== "undefined" ? window.IntersectionObserver : null;
						if (typeof Observer !== "function" || feedRef.current === null) return () => {};
						const observer = new Observer((entries) => {
							const visible = entries.filter((entry) => entry.isIntersecting)
								.sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
							if (visible?.target?.dataset?.previewKey) setActiveKey(visible.target.dataset.previewKey);
						}, { root: feedRef.current, threshold: [0.25, 0.5, 0.75] });
						for (const element of elements.current.values()) observer.observe(element);
						return () => observer.disconnect();
					}, [nodes]);
					return {
						activeKey,
						bindNode: (key) => (element) => {
							if (element === null) elements.current.delete(key);
							else elements.current.set(key, element);
						},
					};
				}

				function jumpToPreviewNode(node, keyboard) {
					const target = document.getElementById(`dac-preview-node-${node.key}`);
					const reduced = typeof window !== "undefined"
						&& typeof window.matchMedia === "function"
						&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
					target?.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
					if (keyboard) target?.focus?.({ preventScroll: true });
				}

				function previewFocusables(dialog) {
					return [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')].filter((element) => {
						if (element.tabIndex < 0 || element.matches?.(":disabled") || element.closest?.("[hidden],[inert]")) return false;
						// Closed details may still have layout boxes in some browsers.
						for (let details = element.closest?.("details:not([open])"); details; details = details.parentElement?.closest("details:not([open])")) {
							const summary = [...details.children].find((child) => child.tagName === "SUMMARY");
							if (!summary?.contains(element)) return false;
						}
						if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkVisibilityCSS: true })) return false;
						return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
					});
				}

				function PreviewDialog({ preview, t, busy, returnFocus, fallbackFocusRef, onLoadMore, onCancel, onEditMetadata, actionBusy = false, metadataUnavailable = false }) {
					const dialogRef = _react.useRef(null);
					const closeRef = _react.useRef(null);
					const messages = Array.isArray(preview?.messages) ? preview.messages : [];
					const nodes = _react.useMemo(() => buildPreviewNodes(messages, preview?.session?.id), [messages, preview?.session?.id]);
					const feedRef = _react.useRef(null);
					const { activeKey, bindNode } = usePreviewRail(nodes, feedRef);
					const previewSourceId = preview?.session?.id;
					_react.useEffect(() => {
						const previousFocus = returnFocus ?? document.activeElement;
						(closeRef.current ?? dialogRef.current)?.focus?.();
					const onKey = (event) => {
						if (event.key === "Escape") {
							event.preventDefault?.();
							event.stopPropagation?.();
							onCancel();
							return;
						}
						if (event.key !== "Tab" || dialogRef.current === null) return;
						const dialog = dialogRef.current;
						const focusable = previewFocusables(dialog);
						if (focusable.length === 0) {
							event.preventDefault?.();
							dialog.focus?.();
							return;
						}
						const first = focusable[0];
						const last = focusable[focusable.length - 1];
						const active = document.activeElement;
						const focusIsInside = typeof dialog.contains === "function" ? dialog.contains(active) : focusable.includes(active);
						if (event.shiftKey && (active === first || !focusIsInside)) {
							event.preventDefault?.();
							last.focus?.();
						} else if (!event.shiftKey && (active === last || !focusIsInside)) {
							event.preventDefault?.();
							first.focus?.();
						}
					};
						document.addEventListener("keydown", onKey);
						return () => {
							document.removeEventListener("keydown", onKey);
							const usable = previousFocus !== null
								&& previousFocus !== document.body
								&& typeof previousFocus?.focus === "function"
								&& (typeof document.contains !== "function" || document.contains(previousFocus));
							(usable ? previousFocus : fallbackFocusRef?.current)?.focus?.();
						};
					}, [onCancel, returnFocus, fallbackFocusRef]);

                    _react.useEffect(() => {
                        if (preview?.anchor?.status !== "found" || preview.status !== "ready") return;
                        const target = dialogRef.current?.querySelector?.('[data-preview-match="true"]');
                        target?.scrollIntoView?.({ block: "center", behavior: "auto" });
                        target?.focus?.({ preventScroll: true });
                    }, [preview?.session?.id, preview?.anchor?.seq, preview?.anchor?.status, preview?.status]);

					return (0, jsx.jsx)("div", {
						className: "dac-confirm-overlay",
						onClick: onCancel,
						children: (0, jsx.jsxs)("div", {
							ref: dialogRef,
							className: "dac-confirm dac-preview-dialog",
							role: "dialog",
							"aria-modal": "true",
							"aria-labelledby": "dac-preview-title",
							tabIndex: -1,
							onClick: (event) => event.stopPropagation(),
							children: [
								(0, jsx.jsxs)("div", { className: "dac-preview-head", children: [
									(0, jsx.jsxs)("div", { className: "dac-preview-heading", children: [
										(0, jsx.jsx)("strong", { id: "dac-preview-title", children: preview?.session?.title || t("chat.untitled") }),
										(0, jsx.jsx)("span", { children: t("preview.readOnly") }),
									] }),
									(0, jsx.jsxs)("div", { className: "dac-preview-head-actions", children: [
                                        onEditMetadata && (0, jsx.jsx)("button", {
                                            type: "button", className: "dac-iconbtn", "aria-label": t("tag.edit"), title: t("tag.edit"),
                                            disabled: actionBusy || metadataUnavailable, onClick: onEditMetadata,
                                            children: (0, jsx.jsx)(IconEdit, {}),
                                        }),
										(0, jsx.jsx)("button", { ref: closeRef, type: "button", className: "dac-iconbtn", "aria-label": t("preview.close"), onClick: onCancel, children: (0, jsx.jsx)(IconClose, { size: 16 }) })
									] })
								] }),
								preview?.status === "loading" && (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { className: "dac-spin" }), (0, jsx.jsx)("span", { children: t("preview.loading") })] }),
								preview?.status === "error" && (0, jsx.jsx)("div", { className: "dac-center", children: preview.error || t("preview.error") }),
								preview?.anchor?.status === "missing" && (0, jsx.jsx)("div", { className: "dac-warn", role: "status", children: isZh(t) ? "命中消息已变化或不在可预览范围内，已从开头显示。" : "The matched message changed or is outside the preview range. Showing the beginning." }),
                                preview?.status === "ready" && messages.length === 0 && (0, jsx.jsx)("div", { className: "dac-center", children: t("preview.empty") }),
								preview?.status === "ready" && nodes.length > 0 && (0, jsx.jsxs)("div", { className: "dac-preview-layout", children: [
									(0, jsx.jsx)("nav", { className: "dac-preview-rail", "aria-label": t("preview.timeline"), children: nodes.map((node, index) => (0, jsx.jsx)("button", {
										type: "button",
										"aria-label": previewJumpLabel(t, index),
										"aria-current": activeKey === node.key ? "true" : undefined,
										onClick: (event) => jumpToPreviewNode(node, event.detail === 0),
										children: `#${index + 1}`
									}, node.key)) }),
									(0, jsx.jsxs)("div", { ref: feedRef, className: "dac-preview-feed", children: [
										(0, jsx.jsxs)("div", { className: "dac-preview-column", children: [
											preview.previousOffset != null && (0, jsx.jsx)("button", { type: "button", className: "dac-btn dac-preview-more", disabled: busy, onClick: () => onLoadMore("previous"), children: isZh(t) ? "加载更早消息" : "Load earlier messages" }),
                                            ...nodes.map((node) => (0, jsx.jsx)(PreviewMessage, { node, sessionId: previewSourceId, t, bindNode: bindNode(node.key), scope: preview?.scope ?? "archive", matchSeq: preview?.anchor?.status === "found" ? preview.anchor.seq : undefined }, node.key)),
										preview.nextOffset !== null && (0, jsx.jsx)("button", { type: "button", className: "dac-btn dac-preview-more", disabled: busy, onClick: () => onLoadMore("next"), children: busy ? t("preview.loading") : t("preview.more") })
										] })
									] })
								] })
							]
						})
					});
				}

				function TrashGroupSection({ group, t, collapsed, onToggleCollapsed, menuOpen, onToggleMenu, busy, mutationsAvailable, onRestore, onPurge, onPreview, onExport }) {
			const wrapRef = _react.useRef(null);
			_react.useEffect(() => {
				if (!menuOpen) return void 0;
				const onDown = (event) => { if (wrapRef.current && !wrapRef.current.contains(event.target)) onToggleMenu(null); };
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [menuOpen, onToggleMenu]);
			const ids = group.sessionIds;
			const restorableIds = group.items
				.filter((row) => row.state !== "purge-pending")
				.map((row) => row.sessionId);
			const groupBusy = ids.some((id) => busy[id] === true);
			return (0, jsx.jsxs)("section", { className: "dac-group dac-trash-group dac-archive-group", children: [
				(0, jsx.jsxs)("div", { ref: wrapRef, className: "dac-group-head", children: [
					(0, jsx.jsxs)("div", { className: "dac-group-left", children: [
						(0, jsx.jsxs)("button", {
							type: "button",
							className: "dac-group-toggle dac-archive-group-toggle",
							"aria-expanded": collapsed !== true,
							"aria-label": `${collapsed === true ? t("group.expand") : t("group.collapse")}: ${group.title ?? t("group.noProject")}`,
							title: `${collapsed === true ? t("group.expand") : t("group.collapse")}: ${group.title ?? t("group.noProject")}`,
							onClick: () => onToggleCollapsed(group.key),
							children: [
								(0, jsx.jsx)(IconFolder, { size: 18, open: collapsed !== true }),
								(0, jsx.jsx)("span", { children: group.title ?? t("group.noProject") }),
							],
						}),
					] }),
					(0, jsx.jsxs)("div", { className: "dac-group-side", children: [
						(0, jsx.jsx)("span", { className: "dac-count", children: chatsCount(t, group.items.length) }),
						(0, jsx.jsx)("button", {
							type: "button",
							className: "dac-iconbtn",
							"aria-label": `${t("menu.row")}: ${group.title ?? t("group.noProject")}`,
							title: t("menu.row"),
							onClick: () => onToggleMenu(menuOpen ? null : `trash:${group.key}`),
							children: (0, jsx.jsx)(IconDots, {})
						}),
					] }),
					menuOpen && (0, jsx.jsxs)("div", { className: "dac-menu", role: "menu", "aria-label": `${t("menu.workspaceScope")}: ${group.title ?? t("group.noProject")}`, children: [
						(0, jsx.jsx)("div", { className: "dac-menu-heading", role: "presentation", children: t("menu.workspaceScope") }),
						(0, jsx.jsx)("button", {
							type: "button", className: "dac-menu-item", role: "menuitem",
							disabled: !mutationsAvailable || restorableIds.length === 0 || groupBusy,
							onClick: () => {
								wrapRef.current?.querySelector('button[title]')?.focus?.();
								onToggleMenu(null);
								return onRestore(ids, { kind: "workspace", title: group.title ?? t("group.noProject") });
							},
							children: t("trash.restoreAll")
						}),
						(0, jsx.jsx)("button", {
							type: "button", className: "dac-menu-item dac-danger", role: "menuitem",
							disabled: !mutationsAvailable || groupBusy,
							onClick: () => { onToggleMenu(null); onPurge(ids, false, group.title ?? t("group.noProject")); },
							children: t("menu.deletePermanently")
						})
					] }),
				] }),
				collapsed !== true && (0, jsx.jsx)("div", { className: "dac-list", children: group.items.map((row) => {
					const title = row.title || t("chat.untitled");
					const pending = row.state === "purge-pending";
					const restorable = !pending;
					const rowBusy = busy[row.sessionId] === true;
					const trashedMs = typeof row.trashedAt === "string" ? Date.parse(row.trashedAt) : NaN;
					const attachments = Number.isInteger(row.snapshotAttachmentCount) ? row.snapshotAttachmentCount : 0;
					return (0, jsx.jsxs)("article", { className: "dac-row dac-trash-row", children: [
						(0, jsx.jsxs)("div", { className: "dac-row-select", children: [
							(0, jsx.jsxs)("div", { className: "dac-row-main", children: [
								(0, jsx.jsx)(PreviewTitleButton, {
                                    sessionId: row.sessionId, title, label: previewOpenLabel(t, title),
                                    disabled: rowBusy, onPreview: () => onPreview(row),
                                }),
								(0, jsx.jsxs)("div", { className: "dac-row-meta dac-trash-meta", children: [
									Number.isFinite(trashedMs) && (0, jsx.jsx)("time", { className: "dac-row-date", dateTime: row.trashedAt, children: formatDate(t, trashedMs) }),
									(0, jsx.jsx)("span", { className: "dac-row-size", children: formatBytes(row.snapshotBytes ?? 0) }),
									(0, jsx.jsx)("span", { className: "dac-row-size", children: isZh(t) ? `${attachments} 个${t("trash.attachments")}` : `${attachments} ${t("trash.attachments")}` }),
									(0, jsx.jsx)("span", { className: `dac-trash-status dac-trash-status-${row.state}`, children: trashStatusLabel(t, row) }),
								] }),
								row.state === "degraded" && (0, jsx.jsx)("span", { className: "dac-summary-warn", children: t("trash.confirm.degraded") }),
							] }),
						] }),
						(0, jsx.jsxs)("div", { className: "dac-row-actions dac-trash-actions", children: [
							(0, jsx.jsx)("button", { type: "button", className: "dac-unarchive", "aria-label": t("trash.restore"), title: t("trash.restore"), "data-session-id": row.sessionId, disabled: !mutationsAvailable || !restorable || rowBusy, onClick: () => onRestore([row.sessionId]), children: t("trash.restore") }),
                            (0, jsx.jsx)("button", { type: "button", className: "dac-unarchive", disabled: rowBusy || !row.snapshotId, onClick: () => onExport?.(row.sessionId), children: isZh(t) ? "导出快照" : "Export snapshot" }),
							(0, jsx.jsx)("button", { type: "button", className: "dac-unarchive dac-danger", "aria-label": t("trash.purge"), title: t("trash.purge"), "data-session-id": row.sessionId, disabled: !mutationsAvailable || rowBusy, onClick: () => onPurge([row.sessionId]), children: t("chat.delete") }),
						] }),
					] }, row.sessionId);
				}) }),
			] }, group.key);
		}

		function ChatActionMenu({ t, title, children, trigger, triggerLabel, filter = false, toolbar = false }) {
			const menuRef = _react.useRef(null);
			_react.useEffect(() => {
				const closeOutside = (event) => {
					const menu = menuRef.current;
					if (menu?.open && !menu.contains(event.target)) menu.open = false;
				};
				document.addEventListener("pointerdown", closeOutside);
				document.addEventListener("focusin", closeOutside);
				return () => {
					document.removeEventListener("pointerdown", closeOutside);
					document.removeEventListener("focusin", closeOutside);
				};
			}, []);
			return (0, jsx.jsxs)("details", {
				ref: menuRef,
				className: filter ? "dac-row-more dac-filter-menu" : toolbar ? "dac-row-more dac-toolbar-more" : "dac-row-more",
				onKeyDown: (event) => {
                    if (filter && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                        const menu = menuRef.current;
                        if (!menu) return;
                        const options = [...menu.querySelectorAll("button:not(:disabled)")];
                        if (options.length === 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        menu.open = true;
                        const current = options.indexOf(document.activeElement);
                        const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
                            : current < 0 ? (event.key === "ArrowUp" ? options.length - 1 : 0)
                            : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                        options[index].focus();
                        return;
                    }
					if (event.key === "Escape" && menuRef.current?.open) {
						event.preventDefault();
						event.stopPropagation();
						menuRef.current.open = false;
						menuRef.current.querySelector("summary")?.focus();
					}
				},
				children: [
					(0, jsx.jsx)("summary", { className: filter ? "dac-action-trigger" : "dac-iconbtn", "aria-label": triggerLabel ?? `${t("menu.row")}: ${title}`, title: filter ? title : toolbar ? triggerLabel : t("menu.row"), children: trigger ?? (0, jsx.jsx)(IconDots, {}) }),
					(0, jsx.jsx)("div", {
						className: "dac-menu dac-row-menu",
						onClickCapture: (event) => {
							if (event.target.closest("button:not(:disabled)") && menuRef.current) {
								menuRef.current.open = false;
								menuRef.current.querySelector("summary")?.focus();
							}
						},
						children
					})
				]
			});
		}

		// Both pointer and keyboard interaction pause the remaining display time.
		function useSuccessNoticeTimer(value, enabled, onDismiss) {
			const [interaction, setInteraction] = _react.useState(null);
			const remaining = _react.useRef({ value: null, ms: 4000 });
			const paused = interaction?.value === value && (interaction.hover || interaction.focus);
			const latest = _react.useRef(null);
			latest.current = { value, enabled, paused };
			_react.useEffect(() => {
				if (remaining.current.value !== value) remaining.current = { value, ms: 4000 };
				if (!enabled || paused) return;
				const started = Date.now();
				let active = true;
				const timer = setTimeout(() => {
					if (active && latest.current.value === value && latest.current.enabled && !latest.current.paused) {
						active = false;
						onDismiss();
					}
				}, remaining.current.ms);
				return () => {
					active = false;
					clearTimeout(timer);
					remaining.current.ms = Math.max(0, remaining.current.ms - Math.max(0, Date.now() - started));
				};
			}, [value, enabled, paused]);
			const set = (key, next) => setInteraction((current) => ({
				...(current?.value === value ? current : { value, hover: false, focus: false }), [key]: next,
			}));
			return {
				onMouseEnter: () => set("hover", true), onMouseLeave: () => set("hover", false),
				onFocus: () => set("focus", true),
				onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) set("focus", false); },
			};
		}

		function HelpTooltip({ id, label, children }) {
			const [position, setPosition] = _react.useState(null);
			const wrapRef = _react.useRef(null);
			const hovered = _react.useRef(false);
			const focused = _react.useRef(false);
			const pinned = _react.useRef(false);
			const close = () => { pinned.current = false; setPosition(null); };
			const show = () => {
				const rect = wrapRef.current?.getBoundingClientRect();
				if (!rect) return;
				const viewportWidth = window.innerWidth || 1024;
				const viewportHeight = window.innerHeight || 768;
				const width = Math.min(360, viewportWidth - 24);
				const below = viewportHeight - rect.bottom - 12;
				const above = rect.top - 12;
				const placeBelow = below >= Math.min(200, above);
				setPosition({ width, boxSizing: "border-box", left: Math.max(12, Math.min(rect.left, viewportWidth - width - 12)),
					maxHeight: Math.max(40, Math.min(240, placeBelow ? below : above)),
					...(placeBelow ? { top: rect.bottom } : { bottom: viewportHeight - rect.top }) });
			};
			_react.useEffect(() => {
				if (position === null) return;
				const outside = (event) => { if (!wrapRef.current?.contains(event.target)) close(); };
				const escape = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					event.stopImmediatePropagation?.();
					close();
				};
				document.addEventListener("keydown", escape, true);
				document.addEventListener("pointerdown", outside);
				document.addEventListener("focusin", outside);
				window.addEventListener("scroll", outside, true);
				window.addEventListener("resize", close);
				return () => {
					document.removeEventListener("keydown", escape, true);
					document.removeEventListener("pointerdown", outside);
					document.removeEventListener("focusin", outside);
					window.removeEventListener("scroll", outside, true);
					window.removeEventListener("resize", close);
				};
			}, [position]);
			return (0, jsx.jsxs)("span", { className: "dac-help", ref: wrapRef,
				onMouseEnter: () => { hovered.current = true; show(); },
				onMouseLeave: () => { hovered.current = false; if (!focused.current && !pinned.current) close(); },
				onFocus: () => { focused.current = true; show(); },
				onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) { focused.current = false; if (!hovered.current) close(); } },
				onKeyDown: (event) => { if (event.key === "Escape" && position !== null) { event.preventDefault(); event.stopPropagation(); close(); } },
				children: [
					(0, jsx.jsx)("button", { type: "button", className: "dac-help-button", "aria-label": label,
						"aria-describedby": position !== null ? id : void 0,
						onClick: () => { if (pinned.current) close(); else { pinned.current = true; show(); } },
						children: (0, jsx.jsxs)("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true, children: [
							(0, jsx.jsx)("circle", { cx: 12, cy: 12, r: 9 }),
							(0, jsx.jsx)("path", { d: "M12 11v6M12 7v1", strokeLinecap: "round" }),
						] }) }),
					position !== null && (0, jsx.jsx)("span", { id, role: "tooltip", className: "dac-note-tooltip", style: position, children }),
				] });
		}

		function NotePreview({ note, sessionId, t }) {
			const [position, setPosition] = _react.useState(null);
			const wrapRef = _react.useRef(null);
			const hovered = _react.useRef(false);
			const focused = _react.useRef(false);
			const dismiss = () => {
				const wrap = wrapRef.current;
				if (document.activeElement !== wrap && wrap?.contains(document.activeElement)) wrap.focus({ preventScroll: true });
				setPosition(null);
			};
			const tooltipId = `dac-note-${encodeURIComponent(sessionId)}`;
			const show = () => {
				const summary = wrapRef.current?.querySelector(".dac-row-note-summary");
				if (!summary || summary.scrollWidth <= summary.clientWidth) { setPosition(null); return; }
				const rect = wrapRef.current?.getBoundingClientRect();
				if (!rect) return;
				const width = Math.min(420, (window.innerWidth || 1024) - 24);
				const viewportHeight = window.innerHeight || 768;
				const below = viewportHeight - rect.bottom - 12;
				const above = rect.top - 12;
				const placeBelow = below >= Math.min(240, above);
				setPosition({ width, left: Math.max(12, Math.min(rect.left, (window.innerWidth || 1024) - width - 12)),
					maxHeight: Math.max(40, Math.min(240, placeBelow ? below : above)),
					...(placeBelow ? { top: rect.bottom } : { bottom: viewportHeight - rect.top }) });
			};
			_react.useEffect(() => {
				if (position === null) return;
				const close = (event) => { if (!wrapRef.current?.contains(event.target)) setPosition(null); };
				window.addEventListener("scroll", close, true);
				window.addEventListener("resize", close);
				return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
			}, [position]);
			return (0, jsx.jsxs)("div", {
				className: "dac-row-note", ref: wrapRef, tabIndex: 0, "aria-label": t("note.label"),
				"aria-describedby": position === null ? void 0 : tooltipId,
				onMouseEnter: () => { hovered.current = true; show(); },
				onMouseLeave: () => { hovered.current = false; if (!focused.current) setPosition(null); },
				onFocus: () => { focused.current = true; show(); },
				onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) { focused.current = false; if (!hovered.current) setPosition(null); } },
				onClick: (event) => { event.preventDefault(); event.stopPropagation(); show(); },
				onKeyDown: (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); } },
				children: [
					(0, jsx.jsx)("span", { className: "dac-row-note-summary", children: note }),
					position !== null && (0, jsx.jsx)("div", { id: tooltipId, role: "tooltip", tabIndex: 0, className: "dac-note-tooltip", style: position, children: note })
				]
			});
		}

        function useActionTooltip(tooltipId, disabled) {
            const [anchor, setAnchor] = _react.useState(null);
            const tooltipRef = _react.useRef(null);
            const hide = () => setAnchor(null);
            const show = (event) => {
                if (disabled) return;
                const rect = event.currentTarget.getBoundingClientRect();
                setAnchor({ left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, ready: false });
            };
            _react.useEffect(() => {
                if (!anchor) return;
                if (disabled) { hide(); return; }
                if (!anchor.ready && tooltipRef.current) {
                    const rect = tooltipRef.current.getBoundingClientRect();
                    setAnchor({ ...anchor, ready: true,
                        left: Math.max(12, Math.min(anchor.left - rect.width / 2, window.innerWidth - rect.width - 12)),
                        top: anchor.top >= rect.height + 20 ? anchor.top - rect.height - 8 : anchor.bottom + 8,
                    });
                }
                const escape = (event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); hide();
                };
                document.addEventListener("keydown", escape, true);
                window.addEventListener("scroll", hide, true);
                window.addEventListener("resize", hide);
                return () => {
                    document.removeEventListener("keydown", escape, true);
                    window.removeEventListener("scroll", hide, true);
                    window.removeEventListener("resize", hide);
                };
            }, [anchor, disabled]);
            return { anchor, tooltipRef, tooltipId, show, hide };
        }

        function PreviewTitleButton({ sessionId, title, label, disabled, onPreview }) {
            const { anchor, tooltipRef, tooltipId, show, hide } = useActionTooltip(`dac-preview-tip-${sessionId}`, disabled);
            return (0, jsx.jsxs)(jsx.Fragment, { children: [
                (0, jsx.jsx)("button", {
                    type: "button", className: "dac-row-title dac-row-open", disabled,
                    "aria-label": label, "aria-describedby": anchor ? tooltipId : undefined,
                    onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide,
                    onClick: () => { hide(); return onPreview(); }, children: title,
                }),
                anchor && (0, jsx.jsx)("span", { id: tooltipId, ref: tooltipRef, role: "tooltip", className: "dac-delete-tooltip",
                    style: { left: anchor.left, top: anchor.top, visibility: anchor.ready ? "visible" : "hidden" }, children: label,
                }),
            ] });
        }

        function ArchiveDeleteButton({ sessionId, label, disabled, onDelete }) {
            const { anchor, tooltipRef, tooltipId, show, hide } = useActionTooltip(`dac-delete-tip-${sessionId}`, disabled);
            return (0, jsx.jsxs)("span", { className: "dac-delete-control",
                onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide,
                children: [
                    (0, jsx.jsx)("button", { type: "button", className: "dac-iconbtn", disabled,
                        "aria-label": label, "aria-describedby": anchor ? tooltipId : undefined,
                        onClick: () => { hide(); onDelete(); }, children: (0, jsx.jsx)(IconTrash, { size: 16 }),
                    }),
                    anchor && (0, jsx.jsx)("span", { id: tooltipId, ref: tooltipRef, role: "tooltip", className: "dac-delete-tooltip",
                        style: { left: anchor.left, top: anchor.top, visibility: anchor.ready ? "visible" : "hidden" }, children: label,
                    }),
                ],
            });
        }

				function GroupSection({ group, t, collapsed, onToggleCollapsed, menuOpen, onToggleMenu, onUnarchive, onDelete, onPermanentDelete, onExport, onPreview, contentHits, busy, stats, onArchive, selectionMode = false, selectedIds, onSelect }) {
			const wrapRef = _react.useRef(null);
			const closeMenu = () => {
				const trigger = wrapRef.current?.querySelector?.('[data-dac-workspace-menu]');
				trigger?.focus?.();
				onToggleMenu(null);
				return trigger;
			};
			_react.useEffect(() => {
				if (!menuOpen) return void 0;
				const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) onToggleMenu(null); };
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [menuOpen, onToggleMenu]);
			const ids = group.sessionIds;
			const groupBusy = ids.some((id) => busy[id] === true);
			return (0, jsx.jsxs)("div", {
				className: "dac-group dac-archive-group",
				children: [
					(0, jsx.jsxs)("div", {
						className: "dac-group-head",
						ref: wrapRef,
						children: [
							(0, jsx.jsxs)("div", {
								className: "dac-group-left",
								children: [
									(0, jsx.jsxs)("button", {
										type: "button",
										className: "dac-group-toggle dac-archive-group-toggle",
										"aria-expanded": collapsed !== true,
										"aria-label": `${collapsed === true ? t("group.expand") : t("group.collapse")}: ${group.title}`,
										title: `${collapsed === true ? t("group.expand") : t("group.collapse")}: ${group.title}`,
										onClick: () => onToggleCollapsed(group.key),
										children: [
											(0, jsx.jsx)(IconFolder, { size: 18, open: collapsed !== true }),
											(0, jsx.jsx)("span", { children: group.title })
										]
									})
								]
							}),
							(0, jsx.jsxs)("div", {
							className: "dac-group-side",
							children: [
								(0, jsx.jsx)("span", { className: "dac-count", children: chatsCount(t, group.items.length) }),
									!selectionMode && (0, jsx.jsx)("button", {
										type: "button",
										className: "dac-iconbtn",
										"aria-label": "…",
										"data-dac-workspace-menu": true,
										"aria-haspopup": "menu", "aria-expanded": menuOpen,
										onClick: () => onToggleMenu(menuOpen ? null : group.key),
										children: (0, jsx.jsx)(IconDots, {})
									})
								]
							}),
								!selectionMode && menuOpen && (0, jsx.jsxs)("div", {
									className: "dac-menu",
									role: "menu",
									"aria-label": `${t("menu.workspaceScope")}: ${group.title}`,
									children: [
										(0, jsx.jsx)("div", { className: "dac-menu-heading", role: "presentation", children: t("menu.workspaceScope") }),
										...(onArchive ? [(0, jsx.jsx)("button", {
                                        type: "button", className: "dac-menu-item", role: "menuitem",
                                        disabled: group.archiveAvailable === false,
                                        onClick: () => { const trigger = closeMenu(); onArchive(group, { currentTarget: trigger }); },
                                        children: t("unarchived.archiveAll")
                                    })] : [
										(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-menu-item",
										role: "menuitem",
										disabled: groupBusy,
										onClick: () => { closeMenu(); onUnarchive(ids, group.title); },
										children: t("menu.unarchiveAll")
									}),

									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-menu-item",
										role: "menuitem",
										disabled: groupBusy,
										onClick: () => { closeMenu(); onExport(ids, group.title); },
										children: t("export.all")
									}),
									(0, jsx.jsx)("div", { role: "separator", className: "dac-menu-separator" }),
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-menu-item dac-danger",
										role: "menuitem",
										disabled: groupBusy,
										onClick: () => { closeMenu(); onPermanentDelete(ids, { kind: "workspace", title: group.title }); },
										children: t("menu.deleteAllPermanently")
										})
								])
									]
							})
						]
					}),
					collapsed !== true && (0, jsx.jsx)("div", {
					className: "dac-list",
					children: group.items.map((session) => (0, jsx.jsxs)("div", {
						className: "dac-row",
							children: [
								(0, jsx.jsxs)("div", {
									className: "dac-row-select",
									children: [
										selectionMode && (0, jsx.jsx)(SelectionCheckbox, { checked: selectedIds.has(session.id), disabled: busy[session.id] === true, ariaLabel: `${isZh(t) ? "选择" : "Select"}: ${session.title ?? t("chat.untitled")}`, "data-session-id": session.id, onChange: checked => onSelect(session.id, checked) }),
										(0, jsx.jsxs)("div", {
												className: "dac-row-main",
												children: [
													(0, jsx.jsx)(PreviewTitleButton, {
                                                        sessionId: session.id, title: session.title ?? t("chat.untitled"),
                                                        label: previewOpenLabel(t, session.title ?? t("chat.untitled")),
                                                        disabled: busy[session.id] === true,
                                                        onPreview: () => onPreview(session)
                                                    }),
												(0, jsx.jsxs)("div", {
													className: "dac-row-meta dac-row-extras",
														children: [
															...(Array.isArray(session.tags) ? session.tags.slice(0, 3) : []).map((tag) => (0, jsx.jsx)("span", { className: "dac-chip", title: tag, children: tag }, tag)),
															Array.isArray(session.tags) && session.tags.length > 3 && (0, jsx.jsx)("span", { className: "dac-chip dac-chip-more", children: `+${session.tags.length - 3}` }),
														typeof session.note === "string" && session.note.trim() !== "" && (0, jsx.jsx)(NotePreview, { note: session.note, sessionId: session.id, t })
													]
												}),
												(contentHits?.get(session.id)?.matches ?? []).map(match => (0, jsx.jsxs)("button", { type: "button", className: "dac-row-snippet", "aria-label": `${previewOpenLabel(t, session.title || t("chat.untitled"))} #${match.seq}: ${match.excerpt}`, onClick: () => onPreview(session, "archive", match.seq), children: [
                                                    (0, jsx.jsx)("span", { className: "dac-row-snippet-label", children: `${t("search.contentMatch")} · ` }),
                                                    (0, jsx.jsx)("span", { children: match.excerpt })
                                                ] }, match.seq)),
												(0, jsx.jsxs)("div", { className: "dac-row-footer", children: [
														(0, jsx.jsx)("span", { className: "dac-row-date", title: formatDate(t, session.createdAt), children: formatDate(t, session.createdAt) }),
													(0, jsx.jsx)("span", { className: "dac-row-size", children: onArchive ? (session.busy ? t("unarchived.busy") : session.archiveEligible === false ? (isZh(t) ? "暂不可归档" : "Unavailable") : "") : rowSizeText(t, stats, session.id) })
												] })
											]
											})
										]
									}),
								(0, jsx.jsxs)("div", {
									className: "dac-row-actions",
								children: onArchive ? [(0, jsx.jsxs)("button", {
                                        type: "button", className: "dac-unarchive",
                                        disabled: session.archiveEligible === false,
                                        onClick: (event) => onArchive(group, event, session),
                                        children: [(0, jsx.jsx)(IconArchive, { size: 15, strokeWidth: 1.6 }), t("unarchived.archive")]
                                    })] : [
                                    !selectionMode && (0, jsx.jsx)(ArchiveDeleteButton, {
                                        sessionId: session.id, label: t("chat.deleteArchived"),
                                        disabled: busy[session.id] === true,
                                        onDelete: () => onPermanentDelete([session.id])
                                    }),
                                    !selectionMode && (0, jsx.jsxs)("button", {
                                        type: "button", className: "dac-unarchive dac-archive-unarchive",
                                        disabled: busy[session.id] === true,
                                        onClick: () => onUnarchive([session.id]), children: t("chat.unarchive")
                                    })
									]
								})
							]
						}, session.id))
					})
				]
			}, group.key);
		}

		function RetentionPreviewDialog({ preview, selected, t, busy, returnFocus, onToggle, onApply, onCancel }) {
			const dialogRef = _react.useRef(null);
			const cancelRef = _react.useRef(null);
			const candidates = Array.isArray(preview?.candidates) ? preview.candidates : [];
			const trashCandidates = candidates.filter((item) => item.action === "purge-trash");
			const hasPurge = candidates.some((item) => selected.has(item.key) && item.action === "purge-trash");
			const rows = (items) => items.map((item) => (0, jsx.jsxs)("label", { className: `dac-retention-row${item.action === "purge-trash" ? " dac-danger" : ""}`, children: [
				(0, jsx.jsx)("input", { type: "checkbox", checked: selected.has(item.key), onChange: (event) => onToggle(item.key, event.target.checked) }),
				(0, jsx.jsxs)("span", { children: [(0, jsx.jsx)("strong", { children: t(item.action === "purge-trash" ? "retention.trashCandidate" : "retention.snapshotCandidate") }), (0, jsx.jsx)("small", { children: `${t(`retention.reason.${item.reason}`)} · ${item.sessionId} · ${formatBytes(item.bytes)}` })] })
			] }, item.key));
			_react.useEffect(() => {
				const dialog = dialogRef.current;
				(cancelRef.current ?? dialog)?.focus?.();
				const onKey = (event) => {
					if (event.key === "Escape") { event.preventDefault?.(); event.stopPropagation?.(); onCancel(); return; }
					if (event.key !== "Tab" || dialog === null) return;
					const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])')];
					if (focusable.length === 0) return;
					const first = focusable[0]; const last = focusable[focusable.length - 1]; const active = document.activeElement;
					if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
					else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
				};
				document.addEventListener("keydown", onKey);
				return () => { document.removeEventListener("keydown", onKey); returnFocus?.focus?.(); };
			}, [onCancel, returnFocus]);
			return (0, jsx.jsx)("div", { className: "dac-confirm-overlay", onClick: onCancel, children: (0, jsx.jsxs)("div", {
				ref: dialogRef, className: "dac-confirm dac-retention-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dac-retention-title", tabIndex: -1, onClick: (event) => event.stopPropagation(), children: [
					(0, jsx.jsx)("div", { id: "dac-retention-title", className: "dac-confirm-title", children: t("retention.preview") }),
					(0, jsx.jsx)("div", { className: "dac-confirm-body", children: t("retention.projected") }),
					hasPurge && (0, jsx.jsx)("div", { className: "dac-warn", role: "alert", children: t("retention.purgeWarning") }),
					candidates.length === 0 && (0, jsx.jsx)("div", { className: "dac-confirm-body", children: t("retention.empty") }),
					candidates.length > 0 && (0, jsx.jsxs)("div", { className: "dac-retention-list", children: [trashCandidates.length > 0 && (0, jsx.jsxs)(jsx.Fragment, { children: [...rows(trashCandidates)] })] }),
					(0, jsx.jsxs)("div", { className: "dac-confirm-actions", children: [
						(0, jsx.jsx)("button", { ref: cancelRef, type: "button", className: "dac-btn", onClick: onCancel, children: t(candidates.length === 0 ? "retention.close" : "confirm.cancel") }),
						candidates.length > 0 && (0, jsx.jsx)("button", { type: "button", className: hasPurge ? "dac-btn-danger" : "dac-btn", disabled: busy || selected.size === 0, onClick: onApply, children: t("retention.apply") })
					] })
				]
			}) });
		}

		function SnapshotInsightRows({ snapshots, sessions, t }) {
			const sessionById = new Map((Array.isArray(sessions) ? sessions : []).map((session) => [session.id, session]));
			return (0, jsx.jsx)("div", { className: "dac-list", children: (Array.isArray(snapshots) ? snapshots : []).map((row) => {
				const ready = row.status === "ready";
				const label = t(ready ? (row.active ? "insights.snapshot.active" : "insights.snapshot.history") : "insights.snapshot.degraded");
				const source = sessionById.get(row.sessionId);
				const original = typeof source?.title === "string" && source.title.trim() !== "" ? source.title : row.sessionId ?? "—";
				const createdMs = ready && typeof row.createdAt === "string" ? Date.parse(row.createdAt) : Number.NaN;
				return (0, jsx.jsxs)("div", { className: "dac-row dac-snapshot-row", children: [
					(0, jsx.jsxs)("div", { className: "dac-row-main", children: [
						(0, jsx.jsx)("strong", { children: label }),
						(0, jsx.jsx)("span", { className: "dac-row-date", children: `${t("insights.snapshot.original")}：${original}` }),
						(0, jsx.jsx)("span", { className: "dac-row-date", children: `${t("insights.snapshot.created")}：${Number.isFinite(createdMs) ? formatDate(t, createdMs) : "—"}` }),
						(0, jsx.jsx)("span", { className: "dac-row-date dac-snapshot-id", title: row.snapshotId, children: `${t("insights.snapshot.id")}：${row.snapshotId}` }),
					] }),
					(0, jsx.jsx)("span", { className: "dac-row-size", children: ready ? formatBytes(row.totalBytes) : "—" })
				] }, `snapshot:${row.snapshotId}`);
			}) });
		}

		function StorageDetailsDialog({ mode, sessions, snapshots, t, returnFocus, onClose }) {
			const dialogRef = _react.useRef(null);
			const searchRef = _react.useRef(null);
			const [query, setQuery] = _react.useState("");
			const normalized = query.trim().toLocaleLowerCase("en-US");
			const sessionRows = Array.isArray(sessions) ? sessions : [];
			const snapshotRows = Array.isArray(snapshots) ? snapshots : [];
			const sessionById = new Map(sessionRows.map((session) => [session.id, session]));
			const matches = (values) => normalized === "" || values.some((value) => String(value ?? "").toLocaleLowerCase("en-US").includes(normalized));
			const visibleSessions = sessionRows.filter((row) => matches([row.title, row.id, row.workspaceTitle, row.scope, t(`insights.scope.${row.scope}`)]));
			const visibleSnapshots = snapshotRows.filter((row) => {
				const source = sessionById.get(row.sessionId);
				const status = t(row.status === "ready" ? (row.active ? "insights.snapshot.active" : "insights.snapshot.history") : "insights.snapshot.degraded");
				return matches([source?.title, row.sessionId, row.snapshotId, status]);
			});
			_react.useEffect(() => {
				const dialog = dialogRef.current;
				(searchRef.current ?? dialog)?.focus?.();
				const onKey = (event) => {
					if (event.key === "Escape") { event.preventDefault?.(); event.stopPropagation?.(); event.stopImmediatePropagation?.(); onClose(); return; }
					if (event.key !== "Tab" || dialog === null) return;
					const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])')];
					if (focusable.length === 0) return;
					const first = focusable[0]; const last = focusable[focusable.length - 1]; const active = document.activeElement;
					if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
					else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
				};
				document.addEventListener("keydown", onKey);
				return () => { document.removeEventListener("keydown", onKey); returnFocus?.focus?.(); };
			}, [onClose, returnFocus]);
			const sessionContent = visibleSessions.map((row) => (0, jsx.jsxs)("div", { className: "dac-row", children: [
				(0, jsx.jsxs)("div", { className: "dac-row-main", children: [
					(0, jsx.jsx)("strong", { children: typeof row.title === "string" && row.title.trim() !== "" ? row.title : t("chat.untitled") }),
					(0, jsx.jsx)("span", { className: "dac-row-date", children: `${row.workspaceTitle ?? "—"} · ${t(`insights.scope.${row.scope}`)}` }),
					(0, jsx.jsx)("small", { className: "dac-storage-detail-id", title: row.id, children: compactSessionId(row.id) })
				] }),
				(0, jsx.jsx)("span", { className: "dac-row-size", children: row.status === "ready" ? formatBytes(row.sizeBytes) : "—" })
			] }, `session-detail:${row.id}`));
			const hasRows = mode === "sessions" ? visibleSessions.length > 0 : visibleSnapshots.length > 0;
			return (0, jsx.jsx)("div", { className: "dac-confirm-overlay", onClick: onClose, children: (0, jsx.jsxs)("div", {
				ref: dialogRef, className: "dac-confirm dac-storage-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dac-storage-details-title", tabIndex: -1, onClick: (event) => event.stopPropagation(), children: [
					(0, jsx.jsx)("div", { id: "dac-storage-details-title", className: "dac-confirm-title", children: t(mode === "sessions" ? "insights.sessionDetails" : "insights.snapshotDetails") }),
					(0, jsx.jsx)("div", { className: "dac-search", children: (0, jsx.jsx)("input", { ref: searchRef, type: "search", value: query, placeholder: t(mode === "sessions" ? "insights.searchSessions" : "insights.searchSnapshots"), onChange: (event) => setQuery(event.target.value) }) }),
					!hasRows && (0, jsx.jsx)("div", { className: "dac-empty", children: t("insights.detailsEmpty") }),
					hasRows && (0, jsx.jsx)("div", { className: "dac-storage-detail-list", children: mode === "sessions" ? sessionContent : (0, jsx.jsx)(SnapshotInsightRows, { snapshots: visibleSnapshots, sessions: sessionRows, t }) }),
					(0, jsx.jsx)("div", { className: "dac-confirm-actions", children: (0, jsx.jsx)("button", { type: "button", className: "dac-btn", onClick: onClose, children: t("preview.close") }) })
				]
			}) });
		}


        function ResidualSessionsDialog({ state, selected, blocked, busy, suspended, t, returnFocus, fallbackFocusRef, notice, onDismiss, onToggle, onSelectVisible, onPreview, onExport, onDelete, onCheck, onClose }) {
            const [query, setQuery] = _react.useState("");
            const dialogRef = _react.useRef(null);
            const searchRef = _react.useRef(null);
            const callbacksRef = _react.useRef(null);
            callbacksRef.current = { busy, suspended, onClose };
            const close = () => { const current = callbacksRef.current; if (!current.busy && !current.suspended) current.onClose(); };
            _react.useEffect(() => {
                const previous = returnFocus ?? document.activeElement;
                searchRef.current?.focus?.();
                const onKey = event => {
                    if (callbacksRef.current.suspended) return;
                    if (event.key === "Escape") { event.preventDefault?.(); event.stopPropagation?.(); event.stopImmediatePropagation?.(); close(); return; }
                    if (event.key !== "Tab") return;
                    const dialog = dialogRef.current;
                    const items = dialog ? previewFocusables(dialog) : [];
                    if (!items.length) { event.preventDefault(); dialog?.focus?.(); return; }
                    const first = items[0], last = items[items.length - 1], active = document.activeElement;
                    if (event.shiftKey && (active === first || !dialog?.contains?.(active))) { event.preventDefault(); last.focus(); }
                    else if (!event.shiftKey && (active === last || !dialog?.contains?.(active))) { event.preventDefault(); first.focus(); }
                };
                document.addEventListener("keydown", onKey);
                return () => { document.removeEventListener("keydown", onKey); (previous && document.contains?.(previous) ? previous : fallbackFocusRef?.current)?.focus?.(); };
            }, [returnFocus, fallbackFocusRef]);
            const ready = state.status === "ready";
            const loading = state.status === "loading";
            const unavailable = busy || !ready || state.trashStatus !== "ready";
            const normalized = query.trim().toLocaleLowerCase();
            const rows = (ready ? state.sessions : []).filter(row => [row.title, row.id, row.parentSession, row.cwd].some(value => String(value ?? "").toLocaleLowerCase().includes(normalized)));
            const all = rows.length > 0 && rows.every(row => selected.has(row.id));
            return (0, jsx.jsx)("div", { className: "dac-confirm-overlay", onClick: close, children: (0, jsx.jsxs)("div", {
                ref: dialogRef, className: "dac-confirm dac-storage-dialog dac-residual-dialog", role: "dialog", "aria-busy": loading || busy, "aria-modal": !suspended, "aria-labelledby": "dac-residual-title", tabIndex: -1, onClick: event => event.stopPropagation(), children: [
                    (0, jsx.jsxs)("div", { className: "dac-confirm-heading", children: [
                        (0, jsx.jsxs)("div", { children: [(0, jsx.jsx)("div", { id: "dac-residual-title", className: "dac-confirm-title", children: t("residual.title") }), (0, jsx.jsx)("small", { className: "dac-confirm-body", role: "status", children: ready ? t("residual.summary").replace("{count}", String(state.sessions.length)).replace("{size}", formatBytes(state.summary?.bytes)) : t(loading ? "residual.checking" : state.status === "error" ? "residual.failed" : "residual.check") })] }),
                        (0, jsx.jsxs)("div", { className: "dac-residual-heading-actions", children: [
                    (0, jsx.jsx)("button", { type: "button", className: "dac-action-trigger", disabled: busy || loading, onClick: onCheck, children: t(state.status === "error" ? "state.retry" : "residual.recheck") }),
                        (0, jsx.jsx)("button", { className: "dac-iconbtn", disabled: busy, "aria-label": t("retention.close"), onClick: close, children: (0, jsx.jsx)(IconClose, {}) }),
                        ] }),
                    ] }),
                    (0, jsx.jsx)("input", { ref: searchRef, className: "dac-residual-search", type: "search", value: query, disabled: busy, placeholder: t("residual.search"), "aria-label": t("residual.search"), onChange: event => setQuery(event.target.value) }),
                    notice && (0, jsx.jsx)(NoticeBanner, { notice, t, onDismiss }),
                    (0, jsx.jsx)("p", { className: "dac-confirm-body", children: t("residual.note") }),
                    state.status === "error" && (0, jsx.jsx)("div", { role: "alert", children: t("residual.failed") }),
                    ready && state.trashStatus !== "ready" && (0, jsx.jsx)("div", { role: "alert", children: t("orphans.unavailable") }),
                    (0, jsx.jsxs)("div", { className: "dac-residual-toolbar", children: [
                        (0, jsx.jsx)(SelectionCheckbox, { ariaLabel: t("residual.select"), checked: all, indeterminate: !all && rows.some(row => selected.has(row.id)), disabled: unavailable || rows.length === 0, onChange: checked => onSelectVisible(rows.map(row => row.id), checked) }),
                        (0, jsx.jsx)("span", { children: t("residual.selected").replace("{count}", String(selected.size)) }),
                        (0, jsx.jsxs)("div", { className: "dac-policy-actions", children: [
                            (0, jsx.jsx)("button", { className: "dac-btn", disabled: unavailable || selected.size === 0, onClick: onExport, children: t("residual.backup") }),
                            (0, jsx.jsx)("button", { className: "dac-btn dac-btn-danger", disabled: unavailable || selected.size === 0, onClick: onDelete, children: t("orphans.delete") }),
                        ] }),
                    ] }),
                    (0, jsx.jsx)("div", { className: "dac-residual-list", children: rows.length === 0 ? (0, jsx.jsx)("div", { className: "dac-empty", role: "status", children: loading ? t("residual.checking") : ready ? t(state.sessions.length ? "state.emptyFiltered" : "residual.empty") : t("residual.failed") }) : rows.map(row => (0, jsx.jsxs)("div", { className: "dac-residual-row", children: [
                        (0, jsx.jsx)(SelectionCheckbox, { ariaLabel: `${t("orphans.id")} ${row.id}`, checked: selected.has(row.id), disabled: busy, onChange: () => onToggle(row.id) }),
                        (0, jsx.jsxs)("div", { className: "dac-residual-main", children: [
                            (0, jsx.jsx)("strong", { children: row.title || t("orphans.untitled") }),
                            (0, jsx.jsx)("code", { children: row.id }),
                            (0, jsx.jsx)("small", { children: `${t("orphans.parent")}: ${row.parentSession}` }),
                            (0, jsx.jsx)("small", { className: "dac-residual-path", title: row.cwd, children: `${t("orphans.cwd")}: ${row.cwd || "—"}` }),
                            (0, jsx.jsx)("small", { children: `${t("orphans.created")}: ${formatDate(t, row.createdAt)}` }),
                            blocked.has(row.id) && (0, jsx.jsx)("small", { className: "dac-danger", children: t("orphans.blocked") }),
                        ] }),
                        (0, jsx.jsx)("span", { className: "dac-row-size", children: formatBytes(row.sizeBytes) }),
                        (0, jsx.jsx)("button", { className: "dac-iconbtn", disabled: busy, "aria-label": previewOpenLabel(t, row.title || t("orphans.untitled")), onClick: () => onPreview(row), children: (0, jsx.jsx)(IconEye, {}) }),
                    ] }, row.id)) }),
                    (0, jsx.jsx)("div", { className: "dac-confirm-actions", children: (0, jsx.jsx)("button", { className: "dac-btn", disabled: busy, onClick: close, children: t("retention.close") }) }),
                ]
            }) });
        }

		function StorageRetentionPanel({ t, fallbackFocusRef, children }) {
			const [state, setState] = _react.useState({ status: "loading", value: null, error: null });
			const [draft, setDraft] = _react.useState(null);
			const [policyPreview, setPolicyPreview] = _react.useState(null);
			const policyBusyRef = _react.useRef(false);
			const [busy, setBusy] = _react.useState(false);
			const [message, setMessage] = _react.useState(null);
			const [messageKind, setMessageKind] = _react.useState("error");
			const [detailsMode, setDetailsMode] = _react.useState(null);
			const [customRetention, setCustomRetention] = _react.useState(false);
			const previewReturnFocusRef = _react.useRef(null);
			const detailsReturnFocusRef = _react.useRef(null);
			const closePolicyPreview = _react.useCallback(() => { if (!policyBusyRef.current) setPolicyPreview(null); }, []);
			const policyDraft = (policy) => ({ ...policy, recycleAutoDelete: policy.recycleAutoDelete === true, recycleMaxAgeDays: policy.recycleAutoDelete === true ? policy.recycleMaxAgeDays : null });
			const load = _react.useCallback(async (signal) => {
				setState((current) => ({ ...current, status: "loading", error: null }));
				try {
					const value = await fetchInsights(signal);
					if (signal?.aborted) return;
					setState({ status: "ready", value, error: null });
					setDraft(policyDraft(value.policy));
					setCustomRetention(false);
				} catch (error) { if (!signal?.aborted) setState({ status: "error", value: null, error }); }
			}, []);
			_react.useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
			const messageInteraction = useSuccessNoticeTimer(message, message !== null && messageKind === "ok", () => setMessage(null));
			const setNumber = (key, value, nullable) => setDraft((current) => ({ ...current, [key]: nullable && value === "" ? null : Number(value) }));
			const retentionDays = draft?.recycleMaxAgeDays;
			const customDays = customRetention || (retentionDays != null && ![7, 30, 90].includes(retentionDays));
			const validDays = (!customDays && retentionDays == null) || (Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3650);
            const policyError = (error) => {
                const code = error.body?.error;
                setMessage(typeof code === "string" && code.startsWith("retention-confirmation-") ? t("retention.confirmationRetry") : String(error.message ?? error));
            };
            const persistPolicy = async (policy, confirmation) => {
                const result = await saveRetentionPolicy(policy, confirmation);
                setDraft(policyDraft(result.policy ?? policy));
                setPolicyPreview(null);
                setMessageKind("ok"); setMessage(t("retention.saved"));
                await load();
            };
            const save = async () => {
                if (!validDays || policyBusyRef.current) return;
                policyBusyRef.current = true;
                setBusy(true); setMessage(null); setMessageKind("error");
                previewReturnFocusRef.current = document.activeElement;
                try {
                    const policy = { ...draft };
                    const result = await post("/retention/policy/preview", policy);
                    if (result.confirmationRequired) setPolicyPreview(result);
                    else await persistPolicy(policy);
                } catch (error) { policyError(error); }
                finally { policyBusyRef.current = false; setBusy(false); }
            };
            const confirmPolicy = async () => {
                if (policyBusyRef.current || !policyPreview) return;
                policyBusyRef.current = true;
                setBusy(true); setMessage(null); setMessageKind("error");
                try { await persistPolicy(policyPreview.policy, policyPreview); }
                catch (error) { setPolicyPreview(null); policyError(error); }
                finally { policyBusyRef.current = false; setBusy(false); }
            };
            const openDetails = (mode) => {
                detailsReturnFocusRef.current = document.activeElement;
                setDetailsMode(mode);
            };
			const value = state.value ?? { summary: {}, sessions: [], snapshots: [] };
				const cards = [
					["insights.sessions", formatBytes(value.summary.sessionBytes), "sessions", (value.sessions ?? []).length, "insights.openSessions"],
					["insights.snapshots", formatBytes(value.summary.snapshotBytes), "snapshots", (value.snapshots ?? []).length, "insights.openSnapshots"],
					["insights.total", formatBytes(value.summary.totalMeasuredBytes), null, 0, null],
					["insights.duplicate", formatBytes(value.summary.duplicateSnapshotBytes), null, 0, null]
				];
			return (0, jsx.jsxs)("div", { className: "dac-mode-panel", children: [
				state.status === "loading" && (0, jsx.jsx)("div", { className: "dac-center", children: t("insights.loading") }),
				state.status === "error" && (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { children: t("insights.error") }), (0, jsx.jsx)("button", { className: "dac-retry", onClick: () => load(), children: t("state.retry") })] }),
				(0, jsx.jsx)("div", { className: "dac-context-note", role: "note", children: t("insights.scopeNote") }),
					(0, jsx.jsxs)("div", { className: "dac-insights-grid", children: [...cards.map(([label, display, mode, count, actionLabel]) => (0, jsx.jsxs)("div", { className: "dac-insights-card", style: { textAlign: "center", alignItems: "center" }, children: [
					(0, jsx.jsx)("span", { children: t(label) }),
					(0, jsx.jsx)("strong", { children: state.status === "ready" ? display : "—" }),
                    (mode === "sessions" ? value.summary.sessionUnavailableCount : mode === "snapshots" ? value.summary.degradedSnapshotCount : 0) > 0 && (0, jsx.jsx)("small", { className: "dac-insights-warning", children: t(mode === "sessions" ? "insights.sessionIssues" : "insights.snapshotIssues").replace("{count}", String(mode === "sessions" ? value.summary.sessionUnavailableCount : value.summary.degradedSnapshotCount)) }),
					mode && (0, jsx.jsx)("button", { type: "button", className: "dac-insights-open", style: { alignSelf: "center" }, "aria-label": t(actionLabel), disabled: state.status !== "ready" || count === 0, onClick: () => openDetails(mode), children: t("insights.details") })
				] }, label)), children] }),
				state.status === "ready" && (0, jsx.jsxs)("div", { className: "dac-mode-panel", children: [
				message && (0, jsx.jsxs)("div", { ...messageInteraction, className: messageKind === "ok" ? "dac-toast" : "dac-notice", role: messageKind === "ok" ? "status" : "alert", children: [message,
					(0, jsx.jsx)("button", { type: "button", "aria-label": t("notice.dismiss"), onClick: () => setMessage(null), children: (0, jsx.jsx)(IconClose, {}) }),
				] }),
				draft && (0, jsx.jsxs)("div", { className: "dac-policy", children: [
					(0, jsx.jsxs)("div", { className: "dac-policy-row", children: [
						(0, jsx.jsxs)("div", { className: "dac-policy-controls", children: [
							(0, jsx.jsxs)("span", { className: "dac-policy-label dac-help-label", children: [t("retention.recycleAge"),
								(0, jsx.jsx)(HelpTooltip, { id: "dac-retention-help", label: t("help.label").replace("{label}", t("retention.recycleAge")), children: t("retention.note") }),
							] }),
							(0, jsx.jsx)(Select, { disabled: busy, ariaLabel: t("retention.recycleAge"), value: customDays ? "custom" : String(retentionDays ?? ""), onChange: (choice) => {
								setCustomRetention(choice === "custom");
								setDraft((current) => ({ ...current, recycleAutoDelete: choice !== "", recycleMaxAgeDays: choice === "custom" ? current.recycleMaxAgeDays : choice === "" ? null : Number(choice) }));
							}, options: [{ value: "", label: t("retention.disabled") }, ...[7, 30, 90].map((days) => ({ value: String(days), label: t("retention.days").replace("{days}", String(days)) })), { value: "custom", label: t("retention.custom") }] }),
							customDays && (0, jsx.jsx)("input", { type: "number", min: 1, max: 3650, step: 1, "aria-label": t("retention.customDays"), title: t("retention.customDays"), "aria-invalid": !validDays, value: retentionDays ?? "", placeholder: "1–3650", disabled: busy, onChange: (event) => setNumber("recycleMaxAgeDays", event.target.value, true) })
						] }),
						(0, jsx.jsx)("div", { className: "dac-policy-actions", children: (0, jsx.jsx)("button", { className: "dac-btn", disabled: busy || !validDays, onClick: save, children: t("retention.save") }) })
					] }),
				] }),
				] }),
				policyPreview && (0, jsx.jsx)(ConfirmDialog, {
                    title: t("retention.autoTitle"),
                    body: (0, jsx.jsxs)("div", { children: [
                        (0, jsx.jsx)("p", { children: t("retention.autoBody").replace("{days}", String(policyPreview.policy.recycleMaxAgeDays)).replace("{count}", String(policyPreview.candidates.length)) }),
                        policyPreview.candidates.length > 0 && (0, jsx.jsx)("ul", { style: { maxHeight: "180px", overflowY: "auto", overflowWrap: "anywhere", paddingLeft: "20px" }, children: policyPreview.candidates.map((item) => (0, jsx.jsx)("li", { children: item.title || compactSessionId(item.sessionId) }, item.sessionId)) })
                    ] }),
                    confirmLabel: t("retention.autoConfirm"), cancelLabel: t("confirm.cancel"), busy,
                    returnFocus: previewReturnFocusRef.current, fallbackFocusRef,
                    onConfirm: confirmPolicy, onCancel: closePolicyPreview
                }),
				detailsMode && (0, jsx.jsx)(StorageDetailsDialog, { mode: detailsMode, sessions: value.sessions, snapshots: value.snapshots, t, returnFocus: detailsReturnFocusRef.current, onClose: () => setDetailsMode(null) })
			] });
		}

		const MAX_LINEAGE_GUIDES = 2;

		function flattenLineageNodes(nodes, collapsed) {
			const output = [];
			const roots = Array.isArray(nodes) ? nodes : [];
			const stack = roots.map((node, index) => ({
				node,
				level: 1,
				parent: node.sourceParent ?? null,
				guides: [],
				hiddenGuideCount: 0,
				isLast: index === roots.length - 1,
			})).reverse();
			while (stack.length > 0) {
				const current = stack.pop();
				const contextNode = current.node.contextOnly || current.node?.status === "missing";
				output.push(current);
				if (!contextNode && collapsed.has(current.node.id)) continue;
				const children = Array.isArray(current.node.children) ? current.node.children : [];
				const fullGuides = current.level === 1 ? current.guides : [...current.guides, !current.isLast];
				const hiddenGuideCount = current.hiddenGuideCount + Math.max(0, fullGuides.length - MAX_LINEAGE_GUIDES);
				const guides = fullGuides.slice(-MAX_LINEAGE_GUIDES);
				for (let index = children.length - 1; index >= 0; index -= 1) stack.push({
					node: children[index],
					level: current.level + 1,
					parent: children[index].sourceParent ?? current.node,
					guides,
					hiddenGuideCount,
					isLast: index === children.length - 1,
				});
			}
			return output;
		}

        function LineageTreeNodes({ nodes, diagnostics = [], collapsed, onToggle, onCopy, copiedId, foldingDisabled = false, t }) {
            const diagnosticsBySession = new Map();
            for (const item of diagnostics) {
                const items = diagnosticsBySession.get(item.sessionId) ?? [];
                items.push(item); diagnosticsBySession.set(item.sessionId, items);
            }
            return (0, jsx.jsx)(jsx.Fragment, { children: flattenLineageNodes(nodes, collapsed).map(({ node, level, parent, guides, hiddenGuideCount, isLast }) => {
                const contextOnly = node.contextOnly || node.status === "missing";
                const expanded = !contextOnly && !collapsed.has(node.id);
                const title = lineageNodeLabel(t, node);
                const kind = node.origin === "subagent" ? "subagent" : parent || node.parentSession || node.isSeeded === true ? "fork" : node.isSeeded === false ? "root" : "unknown";
                const created = formatDate(t, node.createdAt);
                const crossWorkspace = parent && lineageWorkspaceKey(parent) !== lineageWorkspaceKey(node);
                const relation = parent ? node.origin === "subagent"
                    ? (isZh(t) ? `由「${lineageNodeLabel(t, parent)}」委派` : `Delegated by "${lineageNodeLabel(t, parent)}"`)
                    : lineageRelationText(t, parent)
                    : kind === "root" ? t("lineage.start") : t("lineage.sourceUnavailable");
                const sourceText = crossWorkspace ? `${relation} · ${t("lineage.crossWorkspace")}: ${lineageWorkspaceLabel(t, parent)}` : relation;
                const nodeDiagnostics = diagnosticsBySession.get(node.id) ?? [];
                const header = (0, jsx.jsxs)(contextOnly ? "div" : "button", {
                    className: "dac-lineage-card-toggle", ...(contextOnly ? {} : {
                        type: "button", "aria-expanded": expanded,
                        "aria-label": `${t(expanded ? "group.collapse" : "group.expand")} ${title}`,
                        disabled: foldingDisabled, title: foldingDisabled ? t("lineage.searchFoldHint") : undefined,
                        onClick: () => onToggle?.(node.id),
                    }), children: [
                        (0, jsx.jsxs)("span", { className: "dac-lineage-card-content", children: [
                            (0, jsx.jsx)("strong", { title, children: title }),
                            (0, jsx.jsx)("span", { className: "dac-lineage-source", title: sourceText, children: `${t(`lineage.origin.${kind}`)} · ${sourceText}` }),
                            contextOnly && (0, jsx.jsx)("span", { className: "dac-lineage-source-context", children: t("lineage.contextOnly") }),
                            hiddenGuideCount > 0 && (0, jsx.jsx)("small", { className: "dac-lineage-guide-overflow", children: `${t("lineage.depth")} ${level}` }),
                        ] }),
                        (0, jsx.jsx)("span", { className: `dac-trash-status dac-lineage-${node.status}`, children: t(`lineage.status.${node.status}`) }),
                        !contextOnly && (0, jsx.jsx)("span", { className: `dac-lineage-card-chevron${expanded ? " expanded" : ""}`, children: (0, jsx.jsx)(IconChevron, {}) }),
                    ],
                });
                return (0, jsx.jsxs)("div", { role: "listitem", "aria-level": level, className: "dac-lineage-node", children: [
                    (0, jsx.jsxs)("div", { className: "dac-lineage-rail", "aria-hidden": "true", children: [
                        ...guides.map((continues, index) => (0, jsx.jsx)("span", { className: `dac-lineage-guide${continues ? " dac-lineage-guide-continuing" : ""}` }, index)),
                        (0, jsx.jsx)("span", { className: `dac-lineage-junction ${level === 1 ? "dac-lineage-junction-root" : `dac-lineage-junction-child${isLast ? " dac-lineage-junction-last" : ""}`}` }),
                    ] }),
                    (0, jsx.jsxs)("div", { className: `dac-lineage-row dac-lineage-row-${node.status}${contextOnly ? " dac-lineage-context-card" : ""}`, children: [
                        header,
                        expanded && (0, jsx.jsxs)("div", { className: "dac-lineage-detail-copy", children: [
                            (0, jsx.jsx)("div", { className: "dac-lineage-full-title", children: title }),
                            (0, jsx.jsx)("small", { className: "dac-lineage-meta", children: [lineageProjectText(t, node), t(`lineage.origin.${kind}`), node.origin === "subagent" ? `${t("lineage.delegation")} ${node.delegationDepth ?? 0}` : null].filter(Boolean).join(" · ") }),
                            parent && (0, jsx.jsx)("small", { className: "dac-lineage-parent-id", children: `${t("lineage.sourceId")}: ${parent.id}` }),
                            (0, jsx.jsxs)("div", { className: "dac-lineage-footer", children: [
                                created && (0, jsx.jsx)("small", { className: "dac-lineage-created", children: `${t("lineage.created")}: ${created}` }),
                                (0, jsx.jsxs)("div", { className: "dac-lineage-id-actions", children: [
                                    (0, jsx.jsx)("small", { className: "dac-lineage-id", title: node.id, children: compactSessionId(node.id) }),
                                    (0, jsx.jsx)("button", { type: "button", className: "dac-lineage-copy", "aria-label": `${t("lineage.copyId")} ${node.id}`, onClick: () => onCopy?.(node.id), children: copiedId === node.id ? t("lineage.copiedId") : t("lineage.copyId") }),
                                ] }),
                            ] }),
                        ] }),
                        nodeDiagnostics.length > 0 && (0, jsx.jsx)("div", { className: "dac-lineage-diagnostics", role: "status", children: nodeDiagnostics.map(item => (0, jsx.jsx)("span", { className: "dac-lineage-diagnostic", children: lineageDiagnosticText(t, item) }, `${item.code}:${item.relatedId ?? ""}`)) }),
                    ] }),
                ] }, node.id);
            }) });
        }

		function ArchiveRelationshipsPanel({ t }) {
			const [state, setState] = _react.useState({ status: "loading", value: null });
			const [query, setQuery] = _react.useState("");
			const [projectFilter, setProjectFilter] = _react.useState("all");
			const [collapsed, setCollapsed] = _react.useState(() => new Set());
			const [collapsedWorkspaces, setCollapsedWorkspaces] = _react.useState(readLineageWorkspaces);
			const updateWorkspaceFolds = (update) => setCollapsedWorkspaces((current) => {
				const updated = update(current);
				try { window.localStorage.setItem(KEY_LINEAGE_WORKSPACES, JSON.stringify([...updated])); } catch { /* Browser preferences are optional. */ }
				return updated;
			});
			const toggleWorkspace = (key) => updateWorkspaceFolds((current) => setVisibleSelection(current, [key], !current.has(key)));
			const [copiedId, setCopiedId] = _react.useState(null);
			const copyId = _react.useCallback(async (id) => {
				const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
				if (typeof clipboard?.writeText !== "function") return;
				try { await clipboard.writeText(id); setCopiedId(id); } catch { /* Clipboard denial keeps the button retryable. */ }
			}, []);
			const load = _react.useCallback(async (signal) => {
				setState({ status: "loading", value: null });
				try {
					const value = await fetchLineage(signal);
					if (!signal?.aborted) {
						setCollapsed(defaultLineageCollapsed(value));
						setState({ status: "ready", value });
					}
				}
				catch (error) { if (!signal?.aborted) setState({ status: "error", value: error }); }
			}, []);
			_react.useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
				if (state.status === "loading") return (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { className: "dac-spin" }), t("lineage.loading")] });
				if (state.status === "error") return (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { children: t("lineage.error") }), (0, jsx.jsx)("button", { className: "dac-retry", onClick: () => load(), children: t("state.retry") })] });
				const sourceRoots = Array.isArray(state.value.roots) ? state.value.roots : [];
				const workspaceGroups = groupLineageWorkspaces(sourceRoots, state.value.workspaces ?? []);
                const projects = workspaceGroups.map(group => ({ value: group.key, title: group.workspace?.title ?? null }));
				const groups = workspaceGroups
					.filter((group) => projectFilter === "all" || group.key === projectFilter)
					.map((group) => ({ ...group, roots: filterLineageForest(group.roots, query) }))
					.filter((group) => group.roots.length > 0 || query.trim() === "");
				const roots = groups.flatMap((group) => group.roots);
				const branchIds = lineageDisclosureIds(roots);
				const managedCount = countManagedLineageNodes(roots);
				const managedCountText = `${managedCount} ${t("lineage.managedCount")}`;
				const searchActive = query.trim() !== "";
				const visibleCollapsed = searchActive ? new Set() : collapsed;
				const canFold = groups.length > 0;
				const allExpanded = canFold && groups.every((group) => !collapsedWorkspaces.has(group.key))
					&& branchIds.every((id) => !collapsed.has(id));
				const toggleAll = () => {
					setCollapsed((current) => setVisibleSelection(current, branchIds, allExpanded));
					updateWorkspaceFolds((current) => setVisibleSelection(current, groups.map((group) => group.key), allExpanded));
				};
				return (0, jsx.jsxs)("div", { className: "dac-mode-panel", children: [
                    (0, jsx.jsxs)("div", { className: "dac-lineage-toolbar", children: [
                        (0, jsx.jsxs)("div", { className: "dac-search", children: [
                            (0, jsx.jsx)(IconSearch, {}),
                            (0, jsx.jsx)("input", { type: "search", value: query, placeholder: t("lineage.search"), onChange: (event) => setQuery(event.target.value) }),
                        ] }),
                        (0, jsx.jsxs)("div", { className: "dac-lineage-list-head", children: [
                            (0, jsx.jsxs)("div", { className: "dac-filters", children: [
                                (0, jsx.jsx)(FilterSelect, {
                                    t, icon: IconFolder,
									value: projectFilter,
									onChange: setProjectFilter,
									ariaLabel: t("lineage.projectFilter"),
									fill: true,
									options: [
										{ value: "all", label: t("lineage.relatedWorkspaces"), heading: true, showIcon: false, separatorAfter: true },
										...projects.map((project) => ({ value: project.value, label: project.title ?? t("group.noProject") }))
									]
								}),
                                (0, jsx.jsxs)("span", { className: "dac-lineage-list-head-copy", children: [
                                    (0, jsx.jsx)("small", { children: managedCountText }),
                                    (0, jsx.jsx)(HelpTooltip, { id: "dac-lineage-help", label: t("help.label").replace("{label}", t("lineage.managedHeading")), children: t("lineage.scopeNote") }),
                                ] }),
                            ] }),
                            (0, jsx.jsx)("div", { className: "dac-lineage-fold-actions", children: (0, jsx.jsxs)("button", { type: "button", className: "dac-lineage-fold", disabled: searchActive || !canFold, title: searchActive ? t("lineage.searchFoldHint") : void 0, onClick: toggleAll, children: [
								(0, jsx.jsx)("span", { className: allExpanded ? "dac-chev collapse" : "dac-chev open", children: (0, jsx.jsx)(IconChevron, {}) }),
								(0, jsx.jsx)("span", { children: t(allExpanded ? "lineage.collapseAll" : "lineage.expandAll") })
							] }) }),
                        ] }),
                    ] }),
                    (state.value.trashStatus === "unavailable") && (0, jsx.jsx)("div", { className: "dac-warn", role: "status", children: t("lineage.trashUnavailable") }),
					groups.length === 0 ? (0, jsx.jsx)("div", { className: "dac-empty", children: t(sourceRoots.length === 0 ? "lineage.noArchives" : "lineage.empty") }) : (0, jsx.jsx)("div", { className: "dac-lineage-workspaces", children: groups.map((group) => {
						const open = searchActive || !collapsedWorkspaces.has(group.key);
						return (0, jsx.jsxs)("section", { className: "dac-lineage-workspace", "aria-label": lineageWorkspaceLabel(t, { workspace: group.workspace }), children: [
							(0, jsx.jsx)("h3", { children: (0, jsx.jsxs)("button", { type: "button", className: "dac-lineage-workspace-toggle", "aria-expanded": open, disabled: searchActive, title: searchActive ? t("lineage.searchFoldHint") : void 0, onClick: () => toggleWorkspace(group.key), children: [
								(0, jsx.jsx)(IconFolder, { size: 18, open }),
								(0, jsx.jsx)("span", { className: "dac-lineage-workspace-title", children: lineageWorkspaceLabel(t, { workspace: group.workspace }) }),
								(0, jsx.jsx)("small", { children: `${countManagedLineageNodes(group.roots)} ${t("lineage.managedCount")}` })
							] }) }),
							open && group.roots.length === 0 && (0, jsx.jsx)("div", { className: "dac-empty", children: t("lineage.workspaceEmpty") }),
                            open && group.roots.length > 0 && (0, jsx.jsx)("div", { role: "list", "aria-label": lineageWorkspaceLabel(t, { workspace: group.workspace }), className: "dac-lineage-tree", children: (0, jsx.jsx)(LineageTreeNodes, { nodes: group.roots, diagnostics: state.value.diagnostics, collapsed: visibleCollapsed, copiedId, foldingDisabled: searchActive, t, onCopy: copyId, onToggle: (id) => setCollapsed((current) => setVisibleSelection(current, [id], !current.has(id))) }) })
						] }, group.key);
					}) }),
				] });
		}

		function safeAboutLink(value) {
			try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
			catch { return null; }
		}

		function validAbout(value) {
			return value?.name === "dsh-archived-chats" && typeof value.version === "string"
				&& typeof value.links === "object" && value.links !== null;
		}

        function watchPluginUpdates(check, { target = document, network = window, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
            let stopped = false, lastWake = now(), timer;
            const wake = () => {
                if (stopped || target.visibilityState === "hidden" || network.navigator?.onLine === false || now() - lastWake < 30_000) return;
                lastWake = now();
                try { void Promise.resolve(check()).catch(() => {}); } catch { /* A later check can recover. */ }
            };
            const schedule = () => {
                timer = setTimer(() => { wake(); if (!stopped) schedule(); }, 15 * 60_000);
                timer?.unref?.();
            };
            schedule();
            target.addEventListener?.("visibilitychange", wake);
            network.addEventListener?.("online", wake);
            return () => { stopped = true; clearTimer(timer); target.removeEventListener?.("visibilitychange", wake); network.removeEventListener?.("online", wake); };
        }

        function updateEnvironment(info, zh) {
            const label = info?.environment === "desktop" ? (zh ? "官方桌面端" : "Official Desktop")
                : info?.environment === "web" ? "DSH Web" : info?.environment === "cli" ? (zh ? "当前 DSH 环境" : "Current DSH host")
                : (zh ? "运行环境未识别" : "Unrecognized host");
            return `${label}${info?.profile ? ` · ${info.profile}` : ""}`;
        }

        function UpdateDialog({ t, about, checking, installing, error, onCheck, onInstall, onClose, returnFocus, fallbackFocusRef }) {
            const zh = isZh(t), info = about?.installation, update = about?.update;
            const [copied, setCopied] = _react.useState(null);
            _react.useEffect(() => { setCopied(null); }, [info?.command, info?.packageSpec, info?.localPath]);
            const local = info?.source === "local", restart = about?.install?.status === "restart-required";
            const canInstall = info?.canInstall === true && update?.status === "available" && !local && !restart;
            const copy = async (value, key) => {
                try { if (!globalThis.navigator?.clipboard?.writeText) throw new Error("clipboard unavailable");
                    await globalThis.navigator.clipboard.writeText(value); setCopied(key);
                } catch { setCopied("failed"); }
            };
            const status = restart ? (zh ? `v${about.install.version} 已安装，请重启 DSH 后确认运行版本。` : `v${about.install.version} installed. Restart DSH and verify the running version.`)
                : installing ? (zh ? "正在通过宿主安装更新…" : "Installing through the host…")
                : checking ? (zh ? "正在检查更新…" : "Checking for updates…")
                : update?.status === "available" ? (zh ? `发现新版本 v${update.latestVersion}` : `Version ${update.latestVersion} is available`)
                : update?.status === "current" ? (local ? (zh ? "本地开发版已连接，以下为公开版本信息。" : "Local checkout connected. Public release information is shown below.") : (zh ? "当前已是最新版本" : "You’re up to date"))
                : update?.status === "unavailable" ? (zh ? "检查更新失败，可稍后重试" : "Update check failed. Try again later.")
                : (zh ? "尚未检查更新" : "Updates haven’t been checked yet");
            const codeBlock = (value, label, key) => value ? (0, jsx.jsxs)("div", { className: "dac-update-command", children: [
                (0, jsx.jsx)("code", { children: value }),
                (0, jsx.jsx)("button", { type: "button", className: "dac-action-trigger", disabled: installing, onClick: () => copy(value, key), children: copied === key ? (zh ? "已复制" : "Copied") : label }),
            ] }) : null;
            const body = (0, jsx.jsxs)("div", { className: "dac-update-content", children: [
                (0, jsx.jsx)("p", { role: "status", children: status }),
                (0, jsx.jsxs)("dl", { className: "dac-update-meta", children: [
                    (0, jsx.jsx)("dt", { children: zh ? "运行版本" : "Running version" }), (0, jsx.jsx)("dd", { children: about ? `v${about.version}${local ? (zh ? " · 本地开发版" : " · Local checkout") : ""}` : "—" }),
                    (0, jsx.jsx)("dt", { children: zh ? "公开版本" : "Public release" }), (0, jsx.jsx)("dd", { children: update?.latestVersion ? `v${update.latestVersion}${update.status === "unavailable" ? (zh ? "（上次结果）" : " (previous check)") : ""}` : "—" }),
                    (0, jsx.jsx)("dt", { children: zh ? "当前环境" : "Current environment" }), (0, jsx.jsx)("dd", { children: updateEnvironment(info, zh) }),
                    (0, jsx.jsx)("dt", { children: zh ? "上次检查" : "Last checked" }), (0, jsx.jsx)("dd", { children: update?.checkedAt ? new Date(update.checkedAt).toLocaleString(zh ? "zh-CN" : "en-US") : "—" }),
                ] }),
                (0, jsx.jsxs)("div", { className: "dac-about-links", children: [
                    (0, jsx.jsx)("button", { type: "button", className: "dac-action-trigger", disabled: checking || installing || restart, onClick: onCheck, children: zh ? "重新检查" : "Check again" }),
                    safeAboutLink(about?.links?.changelog) && (0, jsx.jsx)("a", { href: safeAboutLink(about.links.changelog), target: "_blank", rel: "noopener noreferrer", children: zh ? "更新日志" : "Changelog" }),
                ] }),
                local ? (0, jsx.jsxs)("section", { className: "dac-update-manual", children: [
                    (0, jsx.jsx)("p", { children: zh ? "当前连接本地源码，不会被线上更新替换。修改后重启 DSH 即可加载；在另一端接入时，粘贴下面目录到「添加插件」。" : "This local checkout is protected from registry replacement. Restart DSH after editing. To connect it in another host, paste this directory into Add plugin." }),
                    codeBlock(info.localPath, zh ? "复制本地路径" : "Copy local path", "path"),
                ] }) : (0, jsx.jsxs)("section", { className: "dac-update-manual", children: [
                    (0, jsx.jsx)("p", { children: info?.source === "external" ? (zh ? "当前由外部来源安装，请按原来源更新。以下信息可用于在其他环境安装公开版本。" : "This plugin uses an external source; update from that source. Use the information below to install a public release elsewhere.") : canInstall ? (zh ? "点击「安装更新」仅更新当前环境的归档插件。安装完成后手动重启 DSH。" : "Install update changes only this plugin in the current host. Restart DSH manually afterward.") : (zh ? "当前环境请通过插件管理页面更新；宿主要求重新安装时，按页面提示操作。可复制下方包名到「添加插件」。" : "Update through the host’s plugin page; follow its reinstall instructions if required. Paste the package below into Add plugin." ) }),
                    codeBlock(info?.packageSpec ?? "dsh-archived-chats@latest", zh ? "复制安装信息" : "Copy package", "package"),
                    info?.command && (0, jsx.jsxs)("details", { className: "dac-update-terminal", children: [
                        (0, jsx.jsx)("summary", { children: zh ? "终端更新命令" : "Terminal update command" }),
                        (0, jsx.jsx)("p", { children: zh ? `也可在运行 DSH 的电脑${info.environment === "desktop" ? "完全退出桌面端后" : "退出当前 DSH 后"}执行以下命令。` : "Alternatively, quit this DSH host and run this command on the same computer." }),
                        codeBlock(info.command, zh ? "复制更新命令" : "Copy update command", "command"),
                        info.environment === "desktop" && (0, jsx.jsx)("p", { children: zh ? "命令使用当前桌面端自带的 dsh。" : "This command uses the current Desktop’s bundled dsh." }),
                    ] }),
                ] }),
                (error || copied === "failed") && (0, jsx.jsx)("p", { role: "alert", className: "dac-update-error", children: error || (zh ? "复制失败，请选中文本手动复制。" : "Copy failed. Select the text and copy it manually.") }),
                (0, jsx.jsx)("p", { className: "dac-update-privacy", children: zh ? "自动检查只读取公开 npm 版本，不上传会话；不会自动安装或重启。" : "Automatic checks read public npm metadata only, without sending chats. They never install or restart automatically." }),
            ] });
            return (0, jsx.jsx)(ConfirmDialog, { title: zh ? "插件更新" : "Plugin update", body, confirmLabel: installing ? (zh ? "正在安装…" : "Installing…") : (zh ? "安装更新" : "Install update"), cancelLabel: zh ? "关闭" : "Close",
                confirmClassName: "dac-btn-primary", hideConfirm: !canInstall && !installing, confirmDisabled: checking,
                dialogClassName: "dac-update-dialog", busy: installing, returnFocus, fallbackFocusRef, onConfirm: onInstall, onCancel: onClose });
        }

			function AboutPanel({ t, about, loading, checking, onCheck, onReload, onMaintenance, maintenanceBusy }) {
			const zh = isZh(t);
			const update = about?.update;
			const status = loading ? (zh ? "正在读取插件信息…" : "Loading plugin information…")
				: !about ? (zh ? "插件信息读取失败，请重新读取" : "Plugin information could not be loaded. Retry loading.")
				: checking ? (zh ? "正在检查更新…" : "Checking for updates…")
				: update?.status === "available" ? (zh ? `有新版本 v${update.latestVersion}` : `Version ${update.latestVersion} is available`)
				: update?.status === "current" ? (about?.installation?.source === "local" ? (zh ? "当前使用本地开发版" : "Using a local checkout") : (zh ? "当前已是最新版本" : "You’re up to date"))
				: update?.status === "unavailable" ? (zh ? "检查更新失败，可稍后重试" : "Update check failed. Try again later.")
				: (zh ? "尚未检查更新" : "Updates haven’t been checked yet");
			const links = about?.links ?? {};
			return (0, jsx.jsxs)("section", { className: "dac-about", "aria-label": t("tab.about"), children: [
				(0, jsx.jsxs)("div", { children: [
					(0, jsx.jsx)("p", { children: zh ? "搜索和整理 DeepSeek Harness 会话，预览历史内容，管理归档并保存可导入的会话备份。" : "Search and organize DeepSeek Harness chats, preview past work, manage archives, and keep importable conversation backups." }),
					(0, jsx.jsxs)("div", { className: "dac-about-meta", children: [
						(0, jsx.jsx)("span", { children: `${zh ? "当前版本" : "Current version"} · ${about ? `v${about.version}` : loading ? (zh ? "读取中…" : "Loading…") : (zh ? "暂不可用" : "Unavailable")}` }),
						about && (0, jsx.jsx)("span", { children: `${zh ? "作者" : "Author"} · ${about.author}` }),
                        about?.installation && (0, jsx.jsx)("span", { children: about.installation.source === "local" ? (zh ? "本地开发版" : "Local checkout") : updateEnvironment(about.installation, zh) }),
						about && (0, jsx.jsx)("span", { children: `${zh ? "许可证" : "License"} · ${about.license}` }),
					] }),
				] }),
				(0, jsx.jsxs)("div", { className: "dac-about-links", children: [
					["home", zh ? "项目主页" : "Project home"],
					[zh ? "guideZh" : "guideEn", zh ? "使用指南" : "User guide"],
					["changelog", zh ? "更新日志" : "Changelog"],
					["feedback", zh ? "问题反馈" : "Report an issue"],
					["marketplace", zh ? "插件市场" : "Plugin market"],
				].map(([key, label]) => {
					const href = safeAboutLink(links[key] ?? (key.startsWith("guide") ? links.guide : null));
					return href ? (0, jsx.jsx)("a", { href, target: "_blank", rel: "noopener noreferrer", children: label }, key) : null;
				}) }),
				safeAboutLink(links.home) && (0, jsx.jsxs)("p", { children: [
					zh ? "如果它帮你找回了旧方案，欢迎" : "If this helped you find past work, consider ",
					(0, jsx.jsx)("a", { href: safeAboutLink(links.home), target: "_blank", rel: "noopener noreferrer", children: zh ? "给项目一个 Star" : "giving the project a Star" }),
					zh ? "。" : ".",
				] }),
				(0, jsx.jsxs)("div", { className: "dac-about-update", children: [
                    (0, jsx.jsx)("h3", { className: "dac-about-section-title", children: zh ? "版本与更新" : "Version and updates" }),
					(0, jsx.jsxs)("div", { className: "dac-about-status", children: [
						(0, jsx.jsx)("span", { role: "status", children: status }),
						(0, jsx.jsx)("button", { type: "button", className: "dac-action-trigger", disabled: checking || loading, onClick: about ? onCheck : onReload, children: about ? (zh ? "检查更新" : "Check for updates") : (zh ? "重新读取" : "Reload information") }),
					] }),
					!about && !loading && (0, jsx.jsx)("p", { children: zh ? "请确认 DSH 连接正常。如果刚更新插件，请重新加载 DSH 后端后重试；仅刷新页面可能尚未启用新版接口。" : "Check your DSH connection. If you just updated the plugin, reload the DSH backend and retry; refreshing the page alone may not activate the new endpoints." }),
					(0, jsx.jsx)("p", { children: zh ? "打开更新详情，可查看当前环境、复制安装信息，或在宿主支持时安装更新。本地开发版不会被线上包覆盖。" : "Open update details to see the current host, copy installation information, or install an update when supported. Local checkouts are protected from registry replacement." }),
					(0, jsx.jsx)("p", { children: zh ? "打开归档管理后自动检查，页面保持打开或重新联网时补查。成功结果缓存 12 小时，失败 15 分钟后重试；不会自动安装或重启。" : "Opening Archive Management checks automatically, with periodic and reconnection checks while the page stays open. Success is cached for 12 hours; failures retry after 15 minutes. No automatic installation or restart." }),
				] }),
                (0, jsx.jsxs)("section", { className: "dac-about-maintenance", "aria-labelledby": "dac-maintenance-heading", children: [
                    (0, jsx.jsx)("h3", { id: "dac-maintenance-heading", className: "dac-about-section-title", children: zh ? "维护工具" : "Maintenance" }),
                    (0, jsx.jsxs)("div", { className: "dac-about-maintenance-row", children: [
                        (0, jsx.jsxs)("div", { children: [
                            (0, jsx.jsx)("p", { children: t("residual.note") }),
                            (0, jsx.jsx)("p", { children: zh ? "不会自动扫描或清理，也不会把未分组会话当作残留。" : "Nothing is scanned or deleted automatically. Ungrouped chats are not treated as residuals." }),
                        ] }),
                        (0, jsx.jsx)("button", { type: "button", className: "dac-action-trigger", disabled: maintenanceBusy, onClick: onMaintenance, children: zh ? "检查残留会话" : "Check residual chats" }),
                    ] }),
                ] }),
			] });
			}

			const ARCHIVE_TABS = [
				["archived", "tab.archived"],
				["unarchived", "tab.unarchived"],
				["trash", "tab.trash"],

				["lineage", "tab.lineage"],
				["about", "tab.about"],
			];
			function ArchiveTabs({ pageMode, onChange, t, updateStatus, showTrash = false }) {
                const visibleTabs = ARCHIVE_TABS.filter(([mode]) => mode !== "trash" || showTrash);
				const move = (event, index) => {
					let next = index;
					if (event.key === "ArrowRight") next = (index + 1) % visibleTabs.length;
					else if (event.key === "ArrowLeft") next = (index - 1 + visibleTabs.length) % visibleTabs.length;
					else if (event.key === "Home") next = 0;
					else if (event.key === "End") next = visibleTabs.length - 1;
					else return;
					event.preventDefault?.();
					const tabs = event.currentTarget?.parentElement?.querySelectorAll?.('[role="tab"]');
					tabs?.[next]?.focus?.();
					onChange(visibleTabs[next][0]);
				};
				return (0, jsx.jsxs)("div", { className: "dac-tabs", role: "tablist", "aria-label": t("page.title"), children: visibleTabs.map(([mode, label], index) => (0, jsx.jsx)("button", {
					type: "button",
					role: "tab",
					id: `dac-tab-${mode}`,
					className: "dac-tab",
					"aria-selected": pageMode === mode,
					"aria-controls": `dac-panel-${mode}`,
					"aria-label": mode === "about" && updateStatus === "available" ? `${t(label)} · ${t("about.updateAvailable")}` : void 0,
					tabIndex: pageMode === mode ? 0 : -1,
					onKeyDown: (event) => move(event, index),
					onClick: () => onChange(mode),
					children: (0, jsx.jsxs)("span", { className: "dac-tab-label", children: [t(label), mode === "about" && updateStatus === "available" && (0, jsx.jsx)("span", { className: "dac-update-dot", "aria-hidden": true })] }),
				}, mode)) });
			}

			/**
			 * The single success/error feedback surface.
			 *
			 * Only one tab panel is mounted at a time, so each panel renders its own
			 * copy — a notice set while a different tab is open would otherwise have
			 * nowhere to appear, and the action would look like it did nothing.
			 */
			function NoticeBanner({ t, notice, interaction, top, onDismiss, onUndoTrash, onViewArchived }) {
				if (notice === null) return null;
				if (notice.source === "archive") return (0, jsx.jsx)(NativeArchiveNotice, { notice, t, onViewArchived, onDismiss });
				const undo = notice.action === "undo-trash";
				const view = notice.action === "view-archived";
				const dismiss = (0, jsx.jsx)("button", { type: "button", "aria-label": t("notice.dismiss"), onClick: onDismiss, children: (0, jsx.jsx)(IconClose, {}) });
				if (notice.kind === "ok") {
					return (0, jsx.jsxs)("div", {
						className: "dac-toast",
						...interaction,
						role: "status",
						style: { top: `${top}px` },
						children: [
							(0, jsx.jsx)(IconCheckCircle, {}),
							(0, jsx.jsx)("span", { children: notice.text }),
							undo && (0, jsx.jsx)("button", { type: "button", className: "dac-notice-action", onClick: onUndoTrash, children: t("trash.undo") }),
							view && (0, jsx.jsx)("button", { type: "button", className: "dac-notice-action", onClick: onViewArchived, children: t("trash.viewArchived") }),
							dismiss,
						]
					});
				}
				return (0, jsx.jsxs)("div", {
					className: notice.kind === "partial" ? "dac-notice dac-notice-ok" : "dac-notice",
					role: notice.kind === "partial" ? "status" : "alert",
					children: [
						// "partial" is a success that has to stay readable, so it keeps the
						// banner's persistence but not its error styling or its alarm role.
						notice.kind === "partial" && (0, jsx.jsx)(IconCheckCircle, {}),
						(0, jsx.jsx)("span", { children: notice.text }),
						undo && (0, jsx.jsx)("button", { type: "button", className: "dac-notice-action", onClick: onUndoTrash, children: t("trash.undo") }),
						view && (0, jsx.jsx)("button", { type: "button", className: "dac-notice-action", onClick: onViewArchived, children: t("trash.viewArchived") }),
						dismiss,
					]
				});
			}

			function ArchivedChatsSection({ t, refreshSidebar, refreshWorkspaceArchiveConsumers, subscribeArchiveChanges }) {
			const [sessions, setSessions] = _react.useState(null);
			const [pageMode, setPageMode] = _react.useState("archived");
			const [trash, setTrash] = _react.useState({ status: "idle", sessions: [], summary: null, trashStatus: "ready", error: null });
			const [trashBusy, setTrashBusy] = _react.useState({});
			const [trashConfirm, setTrashConfirm] = _react.useState(null);
			const [orphans, setOrphans] = _react.useState({ status: "idle", sessions: [], summary: null, trashStatus: "ready", error: null });
			const [orphansBusy, setOrphansBusy] = _react.useState(false);
			const [orphanSelection, setOrphanSelection] = _react.useState(() => new Set());
			const [orphanConfirm, setOrphanConfirm] = _react.useState(null);
			// Ids the export writer refused. Marking them in the list is what saves
			// the user from hunting a 40-character id among dozens of rows.
			const [orphanBlocked, setOrphanBlocked] = _react.useState(() => new Set());
			// A pending decision: the writer refused some sessions and the user has to
			// say whether to leave them out. Dropping them silently would hand back a
			// backup that quietly omits chats the user asked to back up.
			const [orphanExportConfirm, setOrphanExportConfirm] = _react.useState(null);
			const [loadError, setLoadError] = _react.useState(null);
			const [query, setQuery] = _react.useState("");
			const [typeFilter, setTypeFilter] = _react.useState("all");
			const [projectFilter, setProjectFilter] = _react.useState("all");
			const [sortMode, setSortMode] = _react.useState("newest");
			const [menuFor, setMenuFor] = _react.useState(null);
			const [confirm, setConfirm] = _react.useState(null);
			const [busy, setBusy] = _react.useState({});
			const [notice, setNotice] = _react.useState(null);
			const archiveNoticeSequence = _react.useRef(0);
			const [collapsed, setCollapsed] = _react.useState(readCollapsed);
			const [tagFilter, setTagFilter] = _react.useState("");
			const [metadataStatus, setMetadataStatus] = _react.useState("ready");
			const [archiveTrashStatus, setArchiveTrashStatus] = _react.useState("ready");
			const [stats, setStats] = _react.useState({ status: "idle", summary: null, sessions: {} });
				const [metadataEdit, setMetadataEdit] = _react.useState(null);
				const [metaBusy, setMetaBusy] = _react.useState(false);
				const [importPreview, setImportPreview] = _react.useState(null);
				const [importBusy, setImportBusy] = _react.useState(false);

					const [contentSearch, setContentSearch] = _react.useState({ status: "idle", query: "", hits: [], skipped: [] });
					const [preview, setPreview] = _react.useState(null);
			const [previewBusy, setPreviewBusy] = _react.useState(false);
			const [workspaceArchive, setWorkspaceArchive] = _react.useState(null);
			const [workspaceArchiveRefresh, setWorkspaceArchiveRefresh] = _react.useState(0);
			const [confirmBusy, setConfirmBusy] = _react.useState(false);
			const [about, setAbout] = _react.useState(null);
			const [aboutLoading, setAboutLoading] = _react.useState(true);
			const [aboutChecking, setAboutChecking] = _react.useState(false);
            const [updateOpen, setUpdateOpen] = _react.useState(false);
            const [updateBusy, setUpdateBusy] = _react.useState(false);
            const [updateError, setUpdateError] = _react.useState(null);
            const updateReturnFocusRef = _react.useRef(null);
            const updateRequestRef = _react.useRef(null);
            const [unarchived, setUnarchived] = _react.useState({ status: "idle", sessions: [] });
            const [unarchivedQuery, setUnarchivedQuery] = _react.useState("");
            const [unarchivedWorkspace, setUnarchivedWorkspace] = _react.useState("all");
            const [residualOpen, setResidualOpen] = _react.useState(false);
            const [selectionMode, setSelectionMode] = _react.useState(false);
            const [selectedIds, setSelectedIds] = _react.useState(() => new Set());
            const [scheduleStatus, setScheduleStatus] = _react.useState("unsupported");
            const selectionEntryRef = _react.useRef(null);
            _react.useEffect(() => {
                if (sessions === null) return;
                const available = new Set(sessions.map(row => row.id));
                setSelectedIds(current => {
                    const next = new Set([...current].filter(id => available.has(id)));
                    return next.size === current.size ? current : next;
                });
            }, [sessions]);
            const toggleSelection = (id, checked) => setSelectedIds(current => {
                const next = new Set(current);
                if (checked) next.add(id); else next.delete(id);
                return next;
            });
            const cancelSelection = () => {
                setSelectionMode(false); setSelectedIds(new Set());
                setTimeout(() => selectionEntryRef.current?.focus?.(), 0);
            };
            const orphanRequestRef = _react.useRef(null);
            const orphanActionRef = _react.useRef(false);
            const residualReturnFocusRef = _react.useRef(null);
            const unarchivedRequestRef = _react.useRef(null);
            const archiveRequestRef = _react.useRef(0);
			const confirmActionRef = _react.useRef(false);
			const pageRef = _react.useRef(null);
			const pageHeadingRef = _react.useRef(null);
				const deleteReturnFocusRef = _react.useRef(null);
					const trashReturnFocusRef = _react.useRef(null);
					const orphanReturnFocusRef = _react.useRef(null);
					const metaReturnFocusRef = _react.useRef(null);
					const importReturnFocusRef = _react.useRef(null);
						const importInputRef = _react.useRef(null);
					const searchRequestRef = _react.useRef({ sequence: 0, controller: null });
					const previewReturnFocusRef = _react.useRef(null);
						const previewRequestRef = _react.useRef({ sequence: 0, controller: null });
						const exportRequestRef = _react.useRef(null);
					const workspaceArchiveReturnFocusRef = _react.useRef(null);
			const trashActionRef = _react.useRef(false);
			const metaActionRef = _react.useRef(false);
			const importActionRef = _react.useRef(false);
			const aboutRequestRef = _react.useRef(null);

			const checkUpdates = _react.useCallback(async (force = true) => {
				if (aboutRequestRef.current?.checking || aboutRequestRef.current?.loading || updateRequestRef.current) return;
				aboutRequestRef.current?.controller.abort();
				const request = { controller: new AbortController(), checking: true };
				aboutRequestRef.current = request;
				setAboutChecking(true);
				try {
					const result = await post("/about/check-updates", { force }, request.controller.signal);
					if (!validAbout(result)) throw new Error("invalid-about");
					if (aboutRequestRef.current === request) setAbout(result);
				} catch {
					if (aboutRequestRef.current === request) setAbout((current) => current ? { ...current, update: { ...current.update, status: "unavailable" } } : null);
				} finally {
					if (aboutRequestRef.current === request) {
						request.checking = false;
						setAboutChecking(false);
					}
				}
			}, []);

			const loadAbout = _react.useCallback(async () => {
				if (aboutRequestRef.current?.loading || aboutRequestRef.current?.checking || updateRequestRef.current) return;
				aboutRequestRef.current?.controller.abort();
				const request = { controller: new AbortController(), loading: true, checking: false };
				aboutRequestRef.current = request;
				setAboutLoading(true);
				try {
					const response = await fetch(`${API_BASE}/about`, { cache: "no-store", signal: request.controller.signal });
					if (!response.ok) throw new Error("about-unavailable");
					const result = await response.json();
					if (!validAbout(result)) throw new Error("invalid-about");
					if (aboutRequestRef.current !== request) return;
					setAbout(result);
					setAboutLoading(false);
					request.loading = false;
					await checkUpdates(false);
				} catch {
					// Local metadata failures are shown separately from registry checks.
				} finally {
					if (aboutRequestRef.current === request) {
						request.loading = false;
						setAboutLoading(false);
					}
				}
			}, [checkUpdates]);

			_react.useEffect(() => {
				void loadAbout();
				const stop = watchPluginUpdates(() => loadAbout());
                return () => { stop(); aboutRequestRef.current?.controller.abort(); aboutRequestRef.current = null; updateRequestRef.current?.abort(); };
			}, [loadAbout]);
            const openUpdate = event => {
                updateReturnFocusRef.current = event?.currentTarget ?? null;
                setUpdateError(null); setUpdateOpen(true);
                return checkUpdates(true);
            };
            const installUpdate = async () => {
                if (updateRequestRef.current || about?.installation?.canInstall !== true || about?.installation?.source === "local"
                    || about?.update?.status !== "available" || about?.install?.status === "restart-required") return;
                const request = new AbortController(); updateRequestRef.current = request;
                aboutRequestRef.current?.controller.abort(); aboutRequestRef.current = null;
                setAboutChecking(false); setUpdateBusy(true); setUpdateError(null);
                try {
                    const result = await post("/about/install-update", { version: about.update.latestVersion }, request.signal);
                    if (!validAbout(result) || result.install?.status !== "restart-required") throw new Error("update-unverified");
                    if (!request.signal.aborted) setAbout(result);
                } catch (error) {
                    if (!request.signal.aborted) {
                        const code = error?.body?.error;
                        setUpdateError(code === "update-version-changed" ? (isZh(t) ? "版本信息已变化，请重新检查后再更新。" : "Version information changed. Check again before updating.")
                            : code === "update-local-install" ? (isZh(t) ? "当前已切换为本地开发版，已阻止线上覆盖。" : "This is now a local checkout; registry replacement was blocked.")
                            : code === "update-host-managed" ? (isZh(t) ? "当前宿主要求通过插件管理页面更新，请按下方指引操作。" : "Use the host’s plugin manager to update. Follow the instructions below.")
                            : (isZh(t) ? "未能确认更新完成。请重新打开本页核对状态；仍未完成时，通过宿主插件页面检查错误或使用下方命令。" : "Update completion could not be confirmed. Reopen this page to check its state, then use the host’s plugin page or the command below if needed."));
                    }
                } finally {
                    if (updateRequestRef.current === request) { updateRequestRef.current = null; setUpdateBusy(false); }
                }
            };



					const openWorkspaceArchive = (event) => {
						workspaceArchiveReturnFocusRef.current = event?.currentTarget ?? null;
						setNotice(null);
						setWorkspaceArchive({ stage: "choose" });
					};
						const chooseWorkspaceArchive = (workspaces) => {
							const selected = (Array.isArray(workspaces) ? workspaces : [])
								.filter((workspace) => typeof workspace?.id === "string" && workspace.id !== "")
								.map((workspace) => ({ id: workspace.id, title: typeof workspace.title === "string" ? workspace.title : null }));
							if (selected.length === 0) return;
							setWorkspaceArchive({ stage: "confirm", workspaces: selected });
						};
						const returnToWorkspaceArchiveChoice = () => setWorkspaceArchive({ stage: "choose" });
					const closeWorkspaceArchive = () => setWorkspaceArchive(null);
					const cancelWorkspaceArchiveChoice = () => {
						setWorkspaceArchive(null);
						workspaceArchiveReturnFocusRef.current?.focus?.();
					};
					const restoreWorkspaceArchiveFocus = () => {
						workspaceArchiveReturnFocusRef.current?.focus?.();
						workspaceArchiveReturnFocusRef.current = null;
					};
					const workspaceArchiveApplied = async (result) => {
						try { await refreshWorkspaceArchiveConsumers?.(); }
						finally {
							setWorkspaceArchiveRefresh((revision) => revision + 1);
							const count = result?.archived?.length ?? 0;
							if (previewPrimitives.Toast !== null && count > 0 && result.skipped.length === 0 && result.failed.length === 0) {
								setNotice({ kind: "ok", source: "archive", sequence: ++archiveNoticeSequence.current, text: t("workspaceArchive.success").replace("{count}", String(count)), action: "view-archived" });
							}
						}
					};

					const beginPreviewRequest = () => {
						const current = previewRequestRef.current;
						current.controller?.abort();
						const request = { sequence: current.sequence + 1, controller: new AbortController() };
						previewRequestRef.current = request;
						return request;
					};

					const ownsPreviewRequest = (request) => previewRequestRef.current === request && !request.controller.signal.aborted;

					_react.useEffect(() => () => {
						previewRequestRef.current.controller?.abort();
						exportRequestRef.current?.abort();
					}, []);

			_react.useEffect(() => {
				if (sessions === null || loadError !== null) return undefined;
				return markArchiveDialog(pageRef.current);
			}, [sessions, loadError]);

			const noticeInteraction = useSuccessNoticeTimer(notice, notice?.kind === "ok" && notice.source !== "archive", () => setNotice((current) => current === notice ? null : current));
			const changePageMode = (mode) => {
                if (mode === "insights") return;
				if (mode !== pageMode) setNotice(null);
				if (mode !== "archived") { setSelectionMode(false); setSelectedIds(new Set()); }
				setPageMode(mode);
			};

			const toggleCollapsed = (key) => {
				setCollapsed((prev) => {
					const next = { ...prev };
					if (next[key] === true) delete next[key];
					else next[key] = true;
					writeCollapsed(next);
					return next;
				});
			};

			const refresh = _react.useCallback(async () => {
                const request = ++archiveRequestRef.current;
				setLoadError(null);
				try {
					const loaded = await fetchState();
                    if (request !== archiveRequestRef.current) return;
					setSessions(loaded.sessions);
					setMetadataStatus(loaded.metadataStatus);
					setArchiveTrashStatus(loaded.trashStatus);
                    setScheduleStatus(loaded.scheduleStatus);
					setStats({ status: "idle", summary: null, sessions: {} });
				} catch (error) {
					if (request === archiveRequestRef.current) setLoadError(error);
				}
			}, []);
			_react.useEffect(() => { refresh(); }, [refresh]);
			_react.useEffect(() => { if (workspaceArchiveRefresh > 0) void refresh(); }, [workspaceArchiveRefresh, refresh]);

			const loadTrash = _react.useCallback(async () => {
				setTrash((current) => ({ ...current, status: "loading", error: null }));
				try {
					const body = await fetchTrash();
					setTrash({
						status: "ready",
						sessions: Array.isArray(body?.sessions) ? body.sessions : [],
						summary: body?.summary ?? null,
						trashStatus: body?.trashStatus === "ready" ? "ready" : "unavailable",
						error: null,
					});
				} catch (error) {
					setTrash((current) => ({ ...current, status: "error", trashStatus: "unavailable", error }));
				}
			}, []);
			_react.useEffect(() => {
				if (trash.status === "idle") void loadTrash();
                if (pageMode === "trash" && trash.status === "ready" && trash.sessions.length === 0) setPageMode("archived");
			}, [pageMode, trash.status, trash.sessions.length, loadTrash]);

            const loadUnarchived = _react.useCallback(async () => {
                unarchivedRequestRef.current?.abort();
                const request = new AbortController();
                unarchivedRequestRef.current = request;
                setUnarchived(current => ({ ...current, status: current.status === "ready" || current.status === "refreshing" ? "refreshing" : "loading" }));
                try {
                    const res = await fetch(`${API_BASE}/unarchived`, { cache: "no-store", signal: request.signal });
                    if (!res.ok) throw new Error("unarchived-unavailable");
                    const body = await res.json();
                    if (request.signal.aborted) return;
                    const rows = Array.isArray(body.sessions) ? body.sessions : [];
                    setUnarchived({ status: "ready", sessions: rows, metadataStatus: body.metadataStatus, scheduleStatus: body.scheduleStatus ?? "unsupported" });
                } catch (error) {
                    if (!request.signal.aborted) setUnarchived({ status: "error", sessions: [] });
                }
            }, []);
            _react.useEffect(() => {
                if (pageMode === "unarchived") void loadUnarchived();
                return () => unarchivedRequestRef.current?.abort();
            }, [pageMode, workspaceArchiveRefresh, loadUnarchived]);
            _react.useEffect(() => {
                let timer;
                const changed = () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => { void refresh(); if (pageMode === "unarchived") void loadUnarchived(); }, 80);
                };
                const unsubscribe = subscribeArchiveChanges?.(changed);
                window.addEventListener?.("focus", changed);
                return () => { clearTimeout(timer); unsubscribe?.(); window.removeEventListener?.("focus", changed); };
            }, [subscribeArchiveChanges, pageMode, refresh, loadUnarchived]);
            const unarchivedWorkspaces = [...new Map(unarchived.sessions.map(row => [row.workspaceId ?? "__dac_ungrouped__", { id: row.workspaceId ?? "__dac_ungrouped__", title: row.workspaceTitle || row.workspaceId || t("group.noProject") }])).values()];
            const visibleUnarchived = sortArchivedSessions(unarchived.sessions.filter(row =>
                matchesWorkspaceFilter(row, unarchivedWorkspace)
                && `${row.title ?? ""} ${row.id}`.toLocaleLowerCase().includes(unarchivedQuery.trim().toLocaleLowerCase())), sortMode);
            const unarchivedGroups = [...visibleUnarchived.reduce((groups, row) => {
                const key = row.workspaceId ?? "__dac_ungrouped__";
                if (!groups.has(key)) groups.set(key, { key, title: row.workspaceTitle || row.workspaceId || t("group.noProject"), archiveAvailable: unarchived.sessions.some(candidate => candidate.workspaceId === row.workspaceId && candidate.archiveEligible !== false), items: [], sessionIds: [] });
                const group = groups.get(key);
                group.items.push(row); group.sessionIds.push(row.id);
                return groups;
            }, new Map()).values()];
            const archiveUnarchived = (group, event, session) => {
                const workspaces = group ? [{ id: group.key, title: group.title, ...(session ? { sessionIds: [session.id] } : {}) }] : unarchivedWorkspaces;
                if (workspaceArchive !== null || workspaces.length === 0 || session?.archiveEligible === false) return;
                workspaceArchiveReturnFocusRef.current = event?.currentTarget ?? null;
                setNotice(null);
                setWorkspaceArchive({ stage: "confirm", workspaces, scope: group ? (session ? "chat" : "workspace") : "all", fromUnarchived: true });
            };

			const loadOrphans = _react.useCallback(async () => {
                orphanRequestRef.current?.abort();
                const controller = new AbortController();
                orphanRequestRef.current = controller;
				setOrphans((current) => ({ ...current, status: "loading", error: null }));
				try {
					const body = await fetchOrphans(controller.signal, "subagent");
                    if (controller.signal.aborted || orphanRequestRef.current !== controller) return;
					const rows = Array.isArray(body?.sessions) ? body.sessions : [];
					setOrphans({
						status: "ready",
                        checkedAt: Date.now(),
						sessions: rows,
						summary: body?.summary ?? null,
						trashStatus: body?.trashStatus === "ready" ? "ready" : "unavailable",
						error: null,
					});
					// Drop selections whose row is gone, so a delete or an external
					// change cannot leave the batch acting on an id nobody can see.
					const live = new Set(rows.map((row) => row.id));
					setOrphanSelection((current) => new Set([...current].filter((id) => live.has(id))));
				} catch (error) {
					if (!controller.signal.aborted && orphanRequestRef.current === controller) setOrphans((current) => ({ ...current, status: "error", trashStatus: "unavailable", error }));
				}
			}, []);

            const checkResiduals = () => {
                if (orphanActionRef.current) return;
                setNotice(null);
                setOrphanBlocked(new Set());
                setOrphanSelection(new Set());
                return loadOrphans();
            };
            const openResiduals = event => {
                residualReturnFocusRef.current = event?.currentTarget ?? null;
                setResidualOpen(true);
                void checkResiduals();
            };
            const closeResiduals = () => {
                if (orphanActionRef.current) return;
                orphanRequestRef.current?.abort();
                setOrphans(current => current.status === "loading" ? { ...current, status: "idle" } : current);
                setResidualOpen(false);
            };
            _react.useEffect(() => {
                setResidualOpen(false);
                setOrphans(current => current.status === "loading" ? { ...current, status: "idle" } : current);
                return () => { orphanRequestRef.current?.abort(); };
            }, [pageMode]);


			// Statistics load independently after the archive list and never
			// replace session state. An empty archive reports zero bytes without
			// calling the statistics route; a failure keeps every archive action
			// usable and surfaces one dismissible warning.
			_react.useEffect(() => {
				if (sessions === null) return undefined;
				if (sessions.length === 0) {
					setStats({ status: "ready", summary: { sessionCount: 0, totalBytes: 0, unavailableCount: 0 }, sessions: {} });
					return undefined;
				}
				let cancelled = false;
				setStats((current) => ({ ...current, status: "loading" }));
				fetchStats().then((body) => {
					if (cancelled) return;
					setStats({
						status: "ready",
						summary: body?.summary ?? { sessionCount: sessions.length, totalBytes: 0, unavailableCount: 0 },
						sessions: body?.sessions ?? {},
					});
				}).catch(() => {
					if (cancelled) return;
					setStats({ status: "error", summary: null, sessions: {} });
					setNotice((current) => current === null ? { kind: "error", text: t("stats.error") } : current);
				});
				return () => { cancelled = true; };
				}, [sessions, t]);
            const candidateIds = _react.useMemo(() => archiveSearchCandidates(sessions, projectFilter, typeFilter, tagFilter, t("locale.intl")), [sessions, projectFilter, typeFilter, tagFilter, t]);
            const searchScope = _react.useMemo(() => ({ query: query.trim(), ids: candidateIds, pageMode }), [query, candidateIds, pageMode]);
            const startContentSearch = (previous) => {
                searchRequestRef.current.controller?.abort();
                const request = { controller: new AbortController() };
                searchRequestRef.current = request;
                return runArchiveSearch({ query: searchScope.query, ids: candidateIds, previous, signal: request.controller.signal,
                    onUpdate: value => {
                        if (searchRequestRef.current === request && !request.controller.signal.aborted) setContentSearch({ ...value, scope: searchScope });
                    } });
            };
            _react.useEffect(() => {
                searchRequestRef.current.controller?.abort();
                setContentSearch({ status: "idle", query: searchScope.query, hits: [], skipped: [], scope: searchScope });
                if (pageMode !== "archived" || Array.from(searchScope.query).length < 2 || sessions === null) return;
                const timer = setTimeout(() => { void startContentSearch(); }, 300);
                return () => { clearTimeout(timer); searchRequestRef.current.controller?.abort(); };
            }, [searchScope]);
            const currentSearch = contentSearch.scope === searchScope ? contentSearch : { status: "idle", hits: [], skipped: [] };
            const stopContentSearch = () => {
                searchRequestRef.current.controller?.abort();
                setContentSearch(current => ({ ...current, status: "stopped" }));
            };

			const markBusy = (ids, value) => {
				setBusy((prev) => {
					const next = { ...prev };
					for (const id of ids) {
						if (value) next[id] = true;
						else delete next[id];
					}
					return next;
				});
			};

			const markTrashBusy = (ids, value) => {
				setTrashBusy((current) => {
					const next = { ...current };
					for (const id of ids) {
						if (value) next[id] = true;
						else delete next[id];
					}
					return next;
				});
			};

			const restoreFromTrash = async (ids, scope) => {
				const requested = uniqueSessionIds(ids);
				if (requested.length === 0 || trashActionRef.current) return;
				trashActionRef.current = true;
				markTrashBusy(requested, true);
				setNotice(null);
				try {
					const restored = [];
					const failed = [];
					let uncertainCount = 0;
					// Match the Host route's 2,000-ID bound without losing successful
					// earlier batches when a later one fails. Never retry uncertain writes.
					for (let offset = 0; offset < requested.length; offset += 2000) {
						const batch = requested.slice(offset, offset + 2000);
						let result;
						try { result = await restoreTrash(batch); }
						catch (error) {
							if (Array.isArray(error.body?.failed)) result = error.body;
							else { uncertainCount += requested.length - offset; break; }
						}
						const confirmed = new Set(uniqueSessionIds(result?.restored));
						const failures = new Map((Array.isArray(result?.failed) ? result.failed : []).map((item) => [item?.id, item]));
						for (const id of batch) {
							if (confirmed.has(id)) restored.push(id);
							else if (failures.has(id)) failed.push(failures.get(id));
							else uncertainCount += 1;
						}
					}
					const failedCount = failed.length;
					const zh = isZh(t);
					const prefix = scope?.kind === "workspace" ? (zh ? `工作区“${scope.title}”：` : `Workspace “${scope.title}”: `) : "";
					const summary = zh ? `${prefix}已将 ${restored.length} 个聊天恢复到已归档` : `${prefix}${restored.length} chat(s) restored to Archived`;
					setNotice({
						kind: failedCount > 0 || uncertainCount > 0 ? "error" : "ok",
						text: summary + (failedCount > 0 ? (zh ? `，${failedCount} 个未恢复。` : `; ${failedCount} not restored. `) + failureText(t, failed) : (zh ? "。" : "."))
							+ (uncertainCount > 0 ? (zh ? ` ${uncertainCount} 个未确认恢复，请刷新列表确认后再重试。` : ` Restoration was not confirmed for ${uncertainCount} chats. Refresh the list before retrying.`) : ""),
						action: restored.length > 0 ? "view-archived" : undefined,
					});
					setTrash((current) => ({ ...current, sessions: current.sessions.filter((row) => !restored.includes(row.sessionId)) }));
					if (restored.includes(preview?.session?.id)) closePreview();
					if (restored.length > 0 || uncertainCount > 0) {
						await refresh();
						await Promise.resolve().then(() => refreshSidebar?.()).catch(() => {});
					}
					await loadTrash();
				} catch (error) {
					setNotice({ kind: "error", text: recycleErrorText(t, error) });
				} finally {
					trashActionRef.current = false;
					markTrashBusy(requested, false);
					setTrashConfirm(null);
				}
			};

			const askTrashRestore = (ids, scope) => {
				if (trashActionRef.current) return;
				if (!scope) return restoreFromTrash(ids);
				const selected = trash.sessions.filter((row) => ids.includes(row.sessionId));
				const eligible = selected.filter((row) => row.state !== "purge-pending");
				if (eligible.length === 0) return;
				const skipped = selected.length - eligible.length;
				const workspaceCount = new Set(selected.map((row) => row.workspace?.id ?? "ungrouped")).size;
				const zh = isZh(t);
				const target = scope.kind === "workspace"
					? (zh ? `工作区“${scope.title}”中的 ${eligible.length} 个可恢复聊天` : `${eligible.length} restorable chats in workspace “${scope.title}”`)
					: (zh ? `回收站全部 ${workspaceCount} 个工作区中的 ${eligible.length} 个可恢复聊天` : `${eligible.length} restorable chats across all ${workspaceCount} workspaces in the Recycle Bin`);
				trashReturnFocusRef.current = document.activeElement;
				setTrashConfirm({
					action: "restore", scope, ids: eligible.map((row) => row.sessionId), label: t("trash.restoreAll"),
					title: scope.kind === "workspace" ? (zh ? "恢复该工作区的全部聊天？" : "Restore all chats in this workspace?") : (zh ? "恢复回收站中的全部聊天？" : "Restore all chats in the Recycle Bin?"),
					body: (zh ? `将${target}恢复到“已归档”，不会直接回到主聊天列表。如需继续聊天，请在已归档中取消归档。` : `Restore ${target} to Archived, not to the main chat list. To continue chatting, unarchive them from Archived.`)
						+ (skipped > 0 ? (zh ? ` 将跳过 ${skipped} 个正在永久删除的聊天。` : ` ${skipped} chats pending permanent deletion will be skipped.`) : ""),
				});
			};

			const viewRestoredArchive = () => {
				setPageMode("archived");
				setQuery(""); setTypeFilter("all"); setProjectFilter("all"); setTagFilter("");
				setNotice(null);
			};

			const purgeFromTrash = async (ids) => {
				const requested = uniqueSessionIds(ids);
				if (requested.length === 0 || trashActionRef.current) return;
				trashActionRef.current = true;
				markTrashBusy(requested, true);
				setNotice(null);
				try {
					const result = await purgeTrash(requested);
					const purged = uniqueSessionIds(result?.purged);
					setTrash((current) => ({ ...current, sessions: current.sessions.filter((row) => !purged.includes(row.sessionId)) }));
					if (purged.includes(preview?.session?.id)) closePreview();
					if (purged.length > 0) {
						setNotice({ kind: "ok", text: t("trash.purged") });
						refreshSidebar?.();
					}
					if ((result?.failed ?? []).length > 0) setNotice({ kind: "error", text: failureText(t, result.failed) });
					await loadTrash();
				} catch (error) {
					setNotice({ kind: "error", text: recycleErrorText(t, error) });
				} finally {
					trashActionRef.current = false;
					markTrashBusy(requested, false);
					setTrashConfirm(null);
				}
			};

			const emptyRecycleBin = async (targets) => {
				if (trashActionRef.current) return;
				trashActionRef.current = true;
				const ids = targets.map((target) => target.sessionId);
				markTrashBusy(ids, true);
				setNotice(null);
				try {
					const result = await emptyTrash(targets);
					const purged = uniqueSessionIds(result?.purged);
					const uncertain = uniqueSessionIds(result?.uncertain);
					setTrash((current) => ({ ...current, sessions: current.sessions.filter((row) => !purged.includes(row.sessionId)) }));
					if (purged.length > 0 && (result?.failed ?? []).length === 0 && uncertain.length === 0) {
						setNotice({ kind: "ok", text: t("trash.purged") });
						refreshSidebar?.();
					}
					if ((result?.failed ?? []).length > 0 || uncertain.length > 0) {
						const known = (result?.failed ?? []).length > 0 ? failureText(t, result.failed) : "";
						const unknown = uncertain.length > 0
							? (isZh(t) ? `${uncertain.length} 个删除结果未确认，请刷新后核对，不要直接重试。` : `Deletion was not confirmed for ${uncertain.length} chat(s). Refresh and verify before retrying.`)
							: "";
						setNotice({ kind: "error", text: [known, unknown].filter(Boolean).join(" ") });
						if (purged.length > 0 || uncertain.length > 0) refreshSidebar?.();
					}
					await loadTrash();
				} catch (error) {
					setNotice({ kind: "error", text: recycleErrorText(t, error) });
				} finally {
					trashActionRef.current = false;
					markTrashBusy(ids, false);
					setTrashConfirm(null);
				}
			};

			const askTrashPurge = (ids, empty = false, workspaceTitle) => {
				if (trashActionRef.current) return;
				trashReturnFocusRef.current = document.activeElement;
				const selectedRows = trash.sessions.filter((row) => ids.includes(row.sessionId)
					&& (!empty || ["trashed", "degraded"].includes(row.state)));
				if (selectedRows.length === 0) return;
				const confirmedIds = selectedRows.map((row) => row.sessionId);
				const targets = empty ? selectedRows.map((row) => ({
					sessionId: row.sessionId, state: row.state, trashedAt: row.trashedAt,
					snapshotId: row.snapshotId ?? null, bytes: row.snapshotBytes ?? 0,
				})) : undefined;
				const degraded = !empty && selectedRows.some((row) => row.state === "degraded");
				const zh = isZh(t);
				const workspace = workspaceTitle !== undefined;
				const count = selectedRows.length;
				const workspaceCount = new Set(selectedRows.map((row) => row.workspace?.id ?? "ungrouped")).size;
				const target = empty
					? (zh ? `回收站中全部 ${workspaceCount} 个工作区的 ${count} 个聊天` : `all ${count} chats across ${workspaceCount} workspaces in the Recycle Bin`)
					: workspace ? (zh ? `回收站中工作区“${workspaceTitle}”的全部 ${count} 个聊天` : `all ${count} chats in workspace “${workspaceTitle}” in the Recycle Bin`)
					: (zh ? `回收站中的聊天“${selectedRows[0]?.title || t("chat.untitled")}”` : `chat “${selectedRows[0]?.title || t("chat.untitled")}” in the Recycle Bin`);
				setTrashConfirm({
					ids: confirmedIds,
					targets,
					empty,
					label: t(empty ? "trash.emptyAction" : workspace ? "action.deleteAll" : "chat.delete"),
                    deleteAll: empty || workspace,
					title: empty ? t("trash.confirm.emptyTitle") : workspace
						? (zh ? "删除该工作区的全部回收站聊天？" : "Delete all recycled chats in this workspace?")
						: (zh ? "删除聊天？" : "Delete chat?"),
					body: (zh ? `这将永久删除${target}、相关归档数据和保护快照。已归档列表不受影响。此操作无法撤销。`
						: `This permanently deletes ${target}, their archive data, and protection snapshots. The Archived list is unaffected. This cannot be undone.`)
						+ (degraded ? ` ${t("trash.confirm.degraded")}` : ""),
				});
			};

			const toggleOrphan = (id) => {
				setOrphanSelection((current) => {
					const next = new Set(current);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
			};

			const toggleAllOrphans = (ids, checked) => {
                if (!orphanActionRef.current) setOrphanSelection(current => setVisibleSelection(current, ids, checked));
            };

			const runOrphanExport = async (requested, skipped = []) => {
				// Never narrow the request from the display mark. `orphanBlocked` only
				// records "the writer refused this row" so it can be badged; treating it
				// as an exclusion made Cancel leak — the next export silently dropped
				// those rows instead of asking again.
				if (orphanActionRef.current) return;
                const ids = requested;
				if (ids.length === 0) {
					setNotice({ kind: "error", text: t("orphans.exportAllBlocked") });
					return;
				}
				orphanActionRef.current = true;
                setOrphansBusy(true);
				setNotice(null);
				try {
					const outcome = await exportSessions(ids, "/orphans/export?kind=subagent", { deferNotice: true });
					if (outcome.ok) {
						// A partial backup must not look like a complete one, and a toast
						// auto-dismisses before it can be read, so this stays until closed
						// — but it succeeded, so it keeps the success styling.
						setNotice(skipped.length === 0
							? { kind: "ok", text: t("export.started") }
							: {
								kind: "partial",
								text: t("orphans.exportPartial")
									.replace("{count}", String(ids.length))
									.replace("{skipped}", String(skipped.length)),
							});
						return;
					}
					if (outcome.code === "orphan-set-changed") {
						setNotice({ kind: "error", text: t("orphans.setChanged") });
						await loadOrphans();
						return;
					}
					if (outcome.code !== "export-limit-exceeded" || outcome.sessionIds.length === 0) {
						setNotice({ kind: "error", text: outcome.timedOut ? t("export.timeout") : t("export.failed") });
						return;
					}
					// Mark them so the rows are identifiable, then ask instead of deciding.
					setOrphanBlocked((current) => new Set([...current, ...outcome.sessionIds]));
					setOrphanExportConfirm({ blockedIds: outcome.sessionIds, requested: ids });
				} finally {
					orphanActionRef.current = false;
                    setOrphansBusy(false);
				}
			};

			const exportSelectedOrphans = async (event) => {
				if (orphanSelection.size === 0 || orphansBusy) return;
				orphanReturnFocusRef.current = event?.currentTarget ?? null;
				await runOrphanExport([...orphanSelection]);
			};

			const confirmOrphanExport = async () => {
				const pending = orphanExportConfirm;
				if (pending === null || orphanActionRef.current) return;
				setOrphanExportConfirm(null);
				const keep = pending.requested.filter((id) => !pending.blockedIds.includes(id));
				setOrphanSelection(new Set(keep));
				await runOrphanExport(keep, pending.blockedIds);
			};

			const askOrphanDelete = (event) => {
				if (orphanActionRef.current) return;
				const ids = [...orphanSelection];
				if (ids.length === 0) return;
				orphanReturnFocusRef.current = event?.currentTarget ?? null;
				setOrphanConfirm({ ids });
			};

			const confirmOrphanDelete = async () => {
				if (orphanActionRef.current) return;
				const ids = [...(orphanConfirm?.ids ?? [])];
				if (ids.length === 0) return;
				orphanActionRef.current = true;
                setOrphansBusy(true);
				setNotice(null);
				try {
					const result = await deleteOrphans(ids, undefined, "subagent");
					setTrash(current => ({ ...current, status: "idle" }));
					refreshSidebar?.();
                    setWorkspaceArchiveRefresh(current => current + 1);
					const deleted = uniqueSessionIds(result?.deleted);
					if (deleted.length > 0) {
						setOrphanSelection(current => new Set([...current].filter(id => !deleted.includes(id))));
						setNotice({ kind: "ok", text: `${t("orphans.deleted")} ${deleted.length}` });
					}
					if ((result?.failed ?? []).length > 0) setNotice({ kind: "error", text: failureText(t, result.failed) });
					await loadOrphans();
				} catch (error) {
					if ((error?.body?.pending?.length ?? 0) + (error?.body?.deleted?.length ?? 0) > 0) {
						setTrash(current => ({ ...current, status: "idle" }));
						refreshSidebar?.();
					}
					// The list is advisory: the Host re-verifies the orphan set, so a
					// stale selection comes back as a changed set rather than a delete.
					setNotice({
						kind: "error",
						text: error?.body?.error === "orphan-set-changed" ? t("orphans.setChanged") : String(error.message ?? error),
					});
					await loadOrphans();
				} finally {
					orphanActionRef.current = false;
                    setOrphansBusy(false);
					setOrphanConfirm(null);
				}
			};

			const unarchive = async (ids) => {
				if (ids.length === 0) return;
				markBusy(ids, true);
				setNotice(null);
				try {
					await post("/unarchive-all", { sessionIds: ids });
                    archiveRequestRef.current += 1;
					setSessions((prev) => (prev ?? []).filter((s) => !ids.includes(s.id)));
				} catch (error) {
					await refresh();
                    setNotice({ kind: "error", text: unarchiveFailureText(t, error) });
				} finally {
					markBusy(ids, false);
                    await refreshWorkspaceArchiveConsumers?.();
				}
			};

			const runDelete = async (ids) => {
				if (ids.length === 0) return;
				markBusy(ids, true);
				setNotice(null);
				let changed = false;
				try {
					const result = await post("/delete-all", { sessionIds: ids });
					const trashed = uniqueSessionIds(result.trashed);
					const failed = result.failed ?? [];
					if (trashed.length > 0) {
						changed = true;
						setSessions((prev) => (prev ?? []).filter((s) => !trashed.includes(s.id)));
						setTrash((current) => ({ ...current, status: "idle" }));
					}
					if (failed.length > 0) setNotice({ kind: "error", text: failureText(t, failed) });
					else if (trashed.length > 0) setNotice({ kind: "ok", text: t("trash.moved"), action: "undo-trash", ids: trashed });
				} catch (error) {
					const trashed = uniqueSessionIds(error.body?.trashed);
					const failed = error.body?.failed ?? [];
					if (trashed.length > 0) {
						changed = true;
						setSessions((prev) => (prev ?? []).filter((s) => !trashed.includes(s.id)));
						setTrash((current) => ({ ...current, status: "idle" }));
					}
					setNotice({ kind: "error", text: failed.length > 0 ? failureText(t, failed) : String(error.message ?? error) });
				} finally {
					markBusy(ids, false);
					setConfirm(null);
					// Refresh the baseline after archive membership changes.
					if (changed) refreshSidebar?.();
				}
			};

			const runPermanentDelete = async (ids) => {
				if (ids.length === 0) return;
				markBusy(ids, true);
				setNotice(null);
				try {
					const result = await post("/delete-all", { sessionIds: ids, permanent: true });
					const deleted = uniqueSessionIds(result.deleted);
					const removed = uniqueSessionIds([...deleted, ...uniqueSessionIds(result.pending)]);
					const failed = result.failed ?? [];
					if (removed.length > 0) {
						setSessions((prev) => (prev ?? []).filter((s) => !removed.includes(s.id)));
						setTrash((current) => ({ ...current, status: "idle" }));
						refreshSidebar?.();
					}
					if (failed.length > 0) setNotice({ kind: "error", text: failureText(t, failed) });
					else if (deleted.length > 0) setNotice({ kind: "ok", text: t("trash.purged") });
				} catch (error) {
					const deleted = uniqueSessionIds(error.body?.deleted);
					const removed = uniqueSessionIds([...deleted, ...uniqueSessionIds(error.body?.pending)]);
					const failed = error.body?.failed ?? [];
					if (removed.length > 0) {
						setSessions((prev) => (prev ?? []).filter((s) => !removed.includes(s.id)));
						setTrash((current) => ({ ...current, status: "idle" }));
						refreshSidebar?.();
					}
					setNotice({ kind: "error", text: failed.length > 0 ? failureText(t, failed) : String(error.message ?? error) });
				} finally {
					markBusy(ids, false);
					setConfirm(null);
				}
			};

			const undoTrashMove = async (ids) => {
				const requested = uniqueSessionIds(ids);
				if (requested.length === 0) return;
				markBusy(requested, true);
				try {
					const result = await restoreTrash(requested);
					const restored = uniqueSessionIds(result?.restored);
					if ((result?.failed ?? []).length > 0 || restored.length !== requested.length) {
						setNotice({ kind: "error", text: failureText(t, result?.failed ?? []), action: "undo-trash", ids: requested });
						return;
					}
					setNotice({ kind: "ok", text: t("trash.restored") });
					setTrash((current) => ({ ...current, status: "idle" }));
					await refresh();
					refreshSidebar?.();
				} catch (error) {
					setNotice({ kind: "error", text: recycleErrorText(t, error), action: "undo-trash", ids: requested });
				} finally {
					markBusy(requested, false);
				}
			};

			const askArchiveAction = (action, ids, scope) => {
				const requested = uniqueSessionIds(ids);
                if (requested.length === 0 || confirmActionRef.current || requested.some(id => busy[id] === true)) return;
                if (requested.some(id => !(sessions ?? []).some(row => row.id === id))) {
                    setNotice({ kind: "error", text: isZh(t) ? "聊天列表已变化，请刷新后重新选择。" : "The chat list changed. Refresh and select again." }); return;
                }
				deleteReturnFocusRef.current = document.activeElement;
				setConfirm({ ...archiveActionConfirmation(t, action, requested, sessions ?? [], scope), ids: requested, action });
			};
			const askDelete = (ids, title) => askArchiveAction("trash", ids, title === void 0 ? { kind: "chat" } : { kind: "workspace", title });
			const askPermanentDelete = (ids, scope) => askArchiveAction("permanent", ids, scope);
			const confirmArchiveAction = async () => {
				if (!confirm || confirmActionRef.current) return;
				confirmActionRef.current = true; setConfirmBusy(true);
				try {
					if (confirm.action === "export") await exportSessions(confirm.ids);
					else if (confirm.action === "unarchive") { await unarchive(confirm.ids); refreshSidebar?.(); }
					else if (confirm.action === "permanent") await runPermanentDelete(confirm.ids);
					else await runDelete(confirm.ids);
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				} finally {
					confirmActionRef.current = false; setConfirmBusy(false); setConfirm(null);
				}
			};

			const openMetadataEditor = (session) => {
				metaReturnFocusRef.current = document.activeElement;
				setMetadataEdit(session);
			};

			const openPreview = async (session, scope = "archive", seq) => {
				const request = beginPreviewRequest();
				previewReturnFocusRef.current = document.activeElement;
				setPreview({ status: "loading", session, scope, messages: [], total: 0, nextOffset: null });
				setPreviewBusy(true);
				try {
					const result = await fetchArchivePreview(session.id, 0, 50, request.controller.signal, scope, seq);
					if (!ownsPreviewRequest(request)) return;
					setPreview({ ...result, status: "ready", scope, session: result?.session ?? session, messages: Array.isArray(result?.messages) ? result.messages : [] });
				} catch (error) {
					if (!ownsPreviewRequest(request)) return;
					setPreview({ status: "error", session, scope, messages: [], total: 0, nextOffset: null, error: String(error.message ?? error) });
				} finally {
					if (ownsPreviewRequest(request)) setPreviewBusy(false);
				}
			};

			const loadMorePreview = async (direction = "next") => {
				if (!preview?.session?.id || (direction === "previous" ? preview.previousOffset : preview.nextOffset) == null || previewBusy) return;
				const sessionId = preview.session.id;
				const previous = direction === "previous";
				const nextOffset = previous ? preview.previousOffset : preview.nextOffset;
				const request = beginPreviewRequest();
				setPreviewBusy(true);
				try {
					const result = await fetchArchivePreview(sessionId, nextOffset, previous ? preview.offset - nextOffset : 50, request.controller.signal, preview.scope ?? "archive");
					if (!ownsPreviewRequest(request)) return;
					setPreview((current) => current ? {
						...current,
						status: "ready",
						messages: previous ? [...(result?.messages ?? []), ...(current.messages ?? [])] : [...(current.messages ?? []), ...(result?.messages ?? [])],
                        offset: previous ? result.offset : current.offset,
                        previousOffset: previous ? (result.offset > 0 ? Math.max(0, result.offset - 50) : null) : current.previousOffset,
						total: result?.total ?? current.total,
						nextOffset: previous ? current.nextOffset : result?.nextOffset ?? null,
					} : current);
				} catch (error) {
					if (!ownsPreviewRequest(request)) return;
					setNotice({ kind: "error", text: String(error.message ?? error) });
				} finally {
					if (ownsPreviewRequest(request)) setPreviewBusy(false);
				}
			};
			const closePreview = _react.useCallback(() => {
				const current = previewRequestRef.current;
				current.controller?.abort();
				previewRequestRef.current = { sequence: current.sequence + 1, controller: null };
				setPreviewBusy(false);
				setPreview(null);
			}, []);

				const saveMetadataFor = async (sessionId, tags, note) => {
					if (metaActionRef.current) return;
					metaActionRef.current = true;
					setNotice(null);
					setMetaBusy(true);
				try {
					const result = await saveMetadata(sessionId, tags, note);
					const canonical = result?.metadata;
					setSessions((prev) => (prev ?? []).map((s) => s.id === sessionId ? {
						...s,
						tags: Array.isArray(canonical?.tags) ? canonical.tags : [],
						note: typeof canonical?.note === "string" ? canonical.note : "",
						metadataUpdatedAt: canonical?.updatedAt ?? null,
					} : s));
						setMetadataEdit((current) => current?.id === sessionId ? null : current);
						setNotice({ kind: "ok", text: t("meta.saved") });
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
					} finally {
						metaActionRef.current = false;
						setMetaBusy(false);
					}
					};

					// Returns `{ ok: true }` or `{ ok: false, code, sessionId, timedOut }`.
					// `deferNotice` lets a caller that can recover from a specific code
					// compose one message instead of flashing a generic failure first.
					const exportSessions = async (ids, path = "/export", options = {}) => {
						const controller = new AbortController();
						let timedOut = false;
						let completed = false;
						exportRequestRef.current?.abort();
						exportRequestRef.current = controller;
						const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, EXPORT_DOWNLOAD_TIMEOUT_MS);
						try {
							const result = await submitExport(ids, controller.signal, path);
							// A newer export replaced this one: staying quiet is correct.
							if (exportRequestRef.current !== controller) return { ok: false, code: "superseded" };
							if (result === false) {
								// The helper refused before issuing a request (no document,
								// empty set). Reporting nothing made that look like a no-op.
								if (options.deferNotice !== true) setNotice({ kind: "error", text: t("export.failed") });
								return { ok: false, code: "export-unavailable" };
							}
							completed = true;
							if (options.deferNotice !== true) setNotice({ kind: "ok", text: t("export.started") });
							return { ok: true };
						} catch (error) {
							if (exportRequestRef.current !== controller || (!timedOut && error?.name === "AbortError")) {
								return { ok: false, code: "superseded" };
							}
							const code = typeof error?.code === "string" && error.code !== "" ? error.code : "export-failed";
							const sessionId = typeof error.sessionId === "string" ? error.sessionId : null;
							const sessionIds = Array.isArray(error.sessionIds) ? error.sessionIds : (sessionId === null ? [] : [sessionId]);
							if (options.deferNotice !== true) {
								const base = timedOut ? t("export.timeout")
									: code === "export-limit-exceeded" && sessionId !== null
										? t("export.tooLarge").replace("{id}", sessionId)
										: code === "export-source-invalid" ? t("export.sourceInvalid")
											: t("export.failed");
								const detail = typeof error?.message === "string" ? error.message.trim() : "";
								setNotice({ kind: "error", text: detail === "" || base.includes(detail) ? base : `${base}: ${detail}` });
							}
							return { ok: false, code, sessionId, sessionIds, timedOut };
						} finally {
							clearTimeout(timeout);
							if (!completed) controller.abort();
							if (exportRequestRef.current === controller) exportRequestRef.current = null;
						}
					};

				const importFile = async (file) => {
					if (!file) return;
					setImportBusy(true);
					setNotice(null);
					try {
						const preview = await submitImportFile(file);
						const sessions = Array.isArray(preview.sessions) ? preview.sessions : [];
						setImportPreview({
							...preview,
							sessions,
							selectedIds: sessions.filter((session) => session.conflict !== true).map((session) => session.id),
							result: null,
							error: null,
						});
					} catch (error) {
						setNotice({ kind: "error", text: importFailureText(t, error) });
					} finally {
						setImportBusy(false);
					}
				};
					const restoreImport = async () => {
						if (!importPreview || importPreview.selectedIds.length === 0 || importActionRef.current) return;
						const target = {
							token: importPreview.token,
							nonce: importPreview.nonce,
							selectedIds: [...importPreview.selectedIds],
						};
						importActionRef.current = true;
						setImportBusy(true);
						setImportPreview((current) => current?.token === target.token && current?.nonce === target.nonce
							? { ...current, error: null } : current);
						try {
							const result = await post("/import/restore", {
								token: target.token,
								nonce: target.nonce,
								sessionIds: target.selectedIds,
							});
							setImportPreview((current) => current?.token === target.token && current?.nonce === target.nonce
								? { ...current, result, error: null } : current);
							await refresh();
							refreshSidebar?.();
							setNotice({ kind: "ok", text: t("import.done") });
						} catch (error) {
							const text = importFailureText(t, error);
							setImportPreview((current) => current?.token === target.token && current?.nonce === target.nonce
								? { ...current, error: text } : current);
						} finally {
							importActionRef.current = false;
							setImportBusy(false);
					}
				};
				const toggleImportSelection = (id, checked) => {
					setImportPreview((current) => {
						if (!current) return current;
						const next = new Set(current.selectedIds ?? []);
						if (checked) next.add(id); else next.delete(id);
						return { ...current, selectedIds: [...next] };
					});
				};
				const selectAllImport = () => setImportPreview((current) => current ? { ...current, selectedIds: current.sessions.filter((session) => session.conflict !== true).map((session) => session.id) } : current);
				const clearImport = () => setImportPreview((current) => current ? { ...current, selectedIds: [] } : current);

            const previewArchiveSession = preview?.scope === "archive"
                ? (sessions ?? []).find(session => session.id === preview.session?.id)
                : undefined;
            const leavePreviewFor = action => {
                closePreview();
                previewReturnFocusRef.current?.focus?.();
                action();
            };

			const projects = _react.useMemo(() => {
				const seen = new Map();
				for (const s of sessions ?? []) {
					const key = s.workspaceId ?? "ungrouped";
					if (!seen.has(key)) seen.set(key, s.workspaceTitle ?? null);
				}
				return [...seen.entries()].map(([value, title]) => ({ value, title }));
			}, [sessions]);

			const tagOptions = _react.useMemo(() => {
				const seen = new Set();
				const options = [];
				for (const session of sessions ?? []) {
					for (const tag of Array.isArray(session.tags) ? session.tags : []) {
						const key = String(tag).trim().toLocaleLowerCase("en-US");
						if (key !== "" && !seen.has(key)) { seen.add(key); options.push(tag); }
					}
				}
				const collator = new Intl.Collator(t("locale.intl"), { numeric: true, sensitivity: "base" });
				return options.sort(collator.compare);
			}, [sessions, t]);

			const contentHits = _react.useMemo(() => {
				if (contentSearch.scope !== searchScope) return new Map();
				return new Map((contentSearch.hits ?? []).map((hit) => [hit.sessionId, hit]));
			}, [contentSearch, searchScope]);

			const groups = _react.useMemo(() => {
				const projectIds = new Map();
				for (const session of sessions ?? []) {
					const key = session.workspaceId ?? "ungrouped";
					if (!projectIds.has(key)) projectIds.set(key, []);
					projectIds.get(key).push(session.id);
				}
				const locale = t("locale.intl");
				const visible = (sessions ?? []).filter((s) => {
					if (!matchesWorkspaceFilter(s, projectFilter)) return false;
					if (typeFilter === "normal" && s.origin === "subagent") return false;
					if (typeFilter === "subagent" && s.origin !== "subagent") return false;
						if (tagFilter !== "" && !filterByTag(s, tagFilter, locale)) return false;
					if (query.trim() !== "" && !matchesArchivedSession(s, query, locale) && !contentHits.has(s.id)) return false;
					return true;
				});
				const byKey = new Map();
				for (const s of visible) {
					const key = s.workspaceId ?? "ungrouped";
					if (!byKey.has(key)) byKey.set(key, { key, title: s.workspaceTitle ?? t("group.noProject"), items: [], sessionIds: projectIds.get(key) ?? [] });
					byKey.get(key).items.push(s);
				}
				const list = [...byKey.values()];
				for (const g of list) g.items = sortArchivedSessions(g.items, sortMode, t("locale.intl"));
				const groupCollator = new Intl.Collator(t("locale.intl"), { numeric: true, sensitivity: "base" });
				list.sort((a, b) => {
					if ((a.key === "ungrouped") !== (b.key === "ungrouped")) return a.key === "ungrouped" ? 1 : -1;
					if (sortMode === "title") return groupCollator.compare(a.title, b.title);
					const aDate = sessionSortTime(a.items[0]);
					const bDate = sessionSortTime(b.items[0]);
					if ((aDate === null) !== (bDate === null)) return aDate === null ? 1 : -1;
					if (aDate !== null && bDate !== null && aDate !== bDate) return sortMode === "oldest" ? aDate - bDate : bDate - aDate;
					return groupCollator.compare(a.title, b.title);
				});
				return list;
			}, [sessions, query, projectFilter, typeFilter, tagFilter, sortMode, contentHits, t]);

			if (sessions === null && loadError === null) {
				// jsxs is the runtime for a static children array; jsx would make React
				// treat it as a dynamic list and warn about missing keys on every open.
				return (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { className: "dac-spin" }), (0, jsx.jsx)("span", { children: t("state.loading") })] });
			}
			if (loadError !== null && sessions === null) {
				return (0, jsx.jsxs)("div", {
					className: "dac-center",
					children: [
						(0, jsx.jsx)("span", { children: `${t("state.error")}: ${String(loadError.message ?? loadError)}` }),
						(0, jsx.jsx)("button", { type: "button", className: "dac-retry", onClick: refresh, children: t("state.retry") })
					]
				});
			}

			const allIds = (sessions ?? []).map((s) => s.id);
            const visibleIds = groups.flatMap(group => group.items.map(row => row.id));
            const selectableIds = visibleIds.filter(id => busy[id] !== true);
            const selected = allIds.filter(id => selectedIds.has(id));
            const visibleSelected = selectableIds.filter(id => selectedIds.has(id)).length;
            const hiddenSelected = selected.filter(id => !visibleIds.includes(id)).length;
            const selectionBusy = selected.length === 0 || selected.some(id => busy[id] === true) || confirmBusy;
            const selectCurrentResults = checked => setSelectedIds(current => {
                const next = new Set(current);
                for (const id of selectableIds) { if (checked) next.add(id); else next.delete(id); }
                return next;
            });
            const askSelectionAction = action => askArchiveAction(action, selected, { kind: "selection" });
				const allBusy = allIds.some((id) => busy[id] === true);
				const filtering = query.trim() !== "" || projectFilter !== "all" || typeFilter !== "all" || tagFilter !== "";
				const trashGroups = groupTrashSessions(trash.sessions);
					const trashIds = trash.sessions.map((row) => row.sessionId);
					const purgeableTrashIds = trash.sessions.filter((row) => ["trashed", "degraded"].includes(row.state)).map((row) => row.sessionId);
				const restorableTrashIds = trash.sessions.filter((row) => row.state !== "purge-pending").map((row) => row.sessionId);
				const trashMutationsAvailable = trash.status === "ready" && trash.trashStatus === "ready";
				const trashAllBusy = trashIds.some((id) => trashBusy[id] === true);

			return (0, jsx.jsxs)("div", {
				ref: pageRef,
				className: "dac-page",
				children: [
					(0, jsx.jsxs)("div", {
						className: "dac-head",
						children: [
							(0, jsx.jsxs)("div", { className: "dac-heading", children: [
								(0, jsx.jsx)("h2", { ref: pageHeadingRef, tabIndex: -1, className: "dac-title", children: t("page.title") }),
								about && (0, jsx.jsx)("span", { className: "dac-version", children: `v${about.version}` }),
								(about?.update?.status === "available" || about?.install?.status === "restart-required") && (0, jsx.jsx)("button", { type: "button", className: "dac-update-link", onClick: openUpdate, children: about?.install?.status === "restart-required" ? (isZh(t) ? "等待重启" : "Restart needed") : (isZh(t) ? "查看更新" : "View update") }),
							] }),

						]
					}),
                    (0, jsx.jsxs)("div", { className: "dac-intro-row", "data-locale": isZh(t) ? "zh" : "en", children: [
                        (0, jsx.jsx)("p", { className: "dac-intro", children: t("page.description") }),
                            (0, jsx.jsxs)("div", {
								className: "dac-head-actions",
								children: [pageMode === "archived" && !selectionMode && (0, jsx.jsxs)(jsx.Fragment, { children: [
                                    (0, jsx.jsx)("button", { ref: selectionEntryRef, type: "button", className: "dac-action-trigger", disabled: allIds.length === 0, onClick: () => { setSelectedIds(new Set()); setMenuFor(null); setSelectionMode(true); }, children: isZh(t) ? "选择" : "Select" }),
									(0, jsx.jsxs)(ChatActionMenu, {
										t, toolbar: true, triggerLabel: isZh(t) ? "更多归档操作" : "More archive actions",
										children: [
                                        (0, jsx.jsx)("div", { className: "dac-menu-heading", role: "presentation", children: t("menu.allWorkspaces") }),
										(0, jsx.jsx)("button", { type: "button", className: "dac-menu-item", disabled: importBusy, onClick: () => { importReturnFocusRef.current = document.activeElement; importInputRef.current?.click?.(); }, children: t("action.import") }),
											(0, jsx.jsx)("button", { type: "button", className: "dac-menu-item", disabled: allIds.length === 0 || allBusy, onClick: () => askArchiveAction("export", allIds, { kind: "all" }), children: t("action.export") }),
											(0, jsx.jsx)("button", { type: "button", className: "dac-menu-item", disabled: allIds.length === 0 || allBusy, onClick: () => askArchiveAction("unarchive", allIds, { kind: "all" }), children: t("menu.unarchiveAll") }),
											(0, jsx.jsx)("div", { role: "separator", className: "dac-menu-separator" }),
											(0, jsx.jsx)("button", { type: "button", className: "dac-menu-item dac-danger", disabled: allIds.length === 0 || allBusy, onClick: () => askPermanentDelete(allIds, { kind: "all" }), children: t("menu.deleteAllPermanently") }),
										]
									}),
									(0, jsx.jsx)("input", {
										ref: importInputRef,
										type: "file",
										accept: ".zip,application/zip",
										hidden: true,
										onChange: (event) => { const file = event.target.files?.[0]; void importFile(file); event.target.value = ""; }
									})
								] }), pageMode === "unarchived" && (0, jsx.jsxs)(jsx.Fragment, { children: [
                                    (0, jsx.jsx)("button", {
                                        type: "button", className: "dac-action-trigger",
                                        disabled: unarchived.status === "loading" || unarchived.status === "refreshing",
                                        onClick: loadUnarchived, children: t("action.refresh")
                                    }),
                                    (0, jsx.jsxs)("button", {
                                        type: "button", className: "dac-action-trigger",
                                        disabled: unarchived.status !== "ready" || !unarchived.sessions.some(row => row.archiveEligible !== false),
                                        onClick: (event) => archiveUnarchived(null, event),
                                        children: [(0, jsx.jsx)(IconArchive, { size: 15, strokeWidth: 1.6 }), t("unarchived.archiveAll")]
                                    })
                                ] }), pageMode === "trash" && (0, jsx.jsxs)(jsx.Fragment, { children: [
									(0, jsx.jsx)("button", {
										type: "button", className: "dac-action-trigger",
										disabled: restorableTrashIds.length === 0 || !trashMutationsAvailable || trashAllBusy,
										onClick: () => askTrashRestore(trashIds, { kind: "all" }),
										children: t("trash.restoreAll"),
									}),
									(0, jsx.jsx)("button", {
										type: "button", className: "dac-action-trigger dac-danger",
										disabled: purgeableTrashIds.length === 0 || !trashMutationsAvailable || trashAllBusy,
										onClick: () => askTrashPurge(purgeableTrashIds, true), children: t("trash.emptyAction"),
									}),
								] })]
							})
                    ] }),
                    (0, jsx.jsx)(ArchiveTabs, { pageMode, showTrash: trash.sessions.length > 0 || trash.status === "error", onChange: changePageMode, t, updateStatus: about?.update?.status }),
					pageMode === "archived" && (0, jsx.jsxs)("div", { id: "dac-panel-archived", role: "tabpanel", "aria-labelledby": "dac-tab-archived", className: "dac-mode-panel", children: [
					metadataStatus === "unavailable" && (0, jsx.jsx)("div", {
						className: "dac-warn",
						role: "status",
						children: t("meta.unavailable")
					}),
					archiveTrashStatus === "unavailable" && (0, jsx.jsx)("div", {
						className: "dac-warn",
						role: "status",
						children: t("trash.listUnverified")
					}),
					(0, jsx.jsxs)("div", { className: "dac-querybar-stacked", children: [
						(0, jsx.jsxs)("div", {
							className: "dac-search",
							children: [
								(0, jsx.jsx)(IconSearch, {}),
								(0, jsx.jsx)("input", {
									type: "search",
	                                "aria-label": t("search.placeholder"),
									placeholder: t("search.placeholder"),
									value: query,
						onChange: (e) => setQuery(e.target.value)
								}),
							]
						}),
						(0, jsx.jsxs)("div", {
							className: "dac-filters",
							children: [
								(0, jsx.jsxs)(ChatActionMenu, {
									t, filter: true, title: t(`sort.${sortMode}`), triggerLabel: t("filter.allChats"),
									trigger: [(0, jsx.jsxs)("span", { className: "dac-filter-label", children: [(0, jsx.jsx)(IconFilter, {}), (0, jsx.jsx)("span", { children: t(typeFilter === "all" ? "filter.allChats" : `filter.${typeFilter}`) })] }), (0, jsx.jsx)(IconChevron, {})],
									children: [
							{ label: t("filter.type"), value: typeFilter, onChange: setTypeFilter, options: [["all", "filter.allChats"], ["normal", "filter.normal"], ["subagent", "filter.subagent"]] },
										{ label: t("sort.label"), value: sortMode, onChange: setSortMode, options: [["newest", "sort.newest"], ["oldest", "sort.oldest"], ["title", "sort.title"]] }
									].map((section) => (0, jsx.jsxs)("div", { role: "group", "aria-label": section.label, className: "dac-filter-options", children: [
										(0, jsx.jsx)("div", { className: "dac-filter-heading", children: section.label }),
										...section.options.map(([value, label]) => (0, jsx.jsxs)("button", { type: "button", className: "dac-menu-item", "aria-pressed": section.value === value, "data-filter-value": value, onClick: () => section.onChange(value), children: [
											(0, jsx.jsxs)("span", { className: "dac-filter-label", children: [(0, jsx.jsx)("span", { children: t(label) })] }), section.value === value && (0, jsx.jsx)(IconCheck, {})
										] }, value))
									] }, section.label))
								}),
								(0, jsx.jsx)(WorkspaceFilter, {
	                                t, value: projectFilter, onChange: setProjectFilter, workspaces: projects, scheduleStatus,
	                            }),
	                            (0, jsx.jsx)(FilterSelect, {
	                                t, icon: IconTag,
									value: tagFilter,
						onChange: setTagFilter,
									ariaLabel: t("tag.filter"),
									options: [
										{ value: "", label: t("tag.filter"), heading: true, showIcon: false, separatorAfter: true },
										...tagOptions.map((tag) => ({ value: tag, label: tag }))
									]
								}),
							]
						}),
					] }),
					currentSearch.status !== "idle" && (0, jsx.jsxs)("div", { className: "dac-search-state", role: "status", children: [
                                (0, jsx.jsx)("span", { children: isZh(t)
                                    ? `${currentSearch.status === "loading" ? "正在搜索" : currentSearch.status === "ready" ? "搜索完成" : currentSearch.status === "partial" ? "搜索结束，存在未读取项" : "搜索已停止"}：已处理候选 ${currentSearch.processed ?? 0}/${currentSearch.total ?? 0}，正文命中 ${contentHits.size} 个聊天，当前显示 ${visibleIds.length} 个聊天，失败 ${currentSearch.skipped.length} 个聊天`
                                    : `${currentSearch.status === "loading" ? "Searching" : currentSearch.status === "ready" ? "Search complete" : currentSearch.status === "partial" ? "Scan ended with unreadable chats" : "Search stopped"}: Candidates processed ${currentSearch.processed ?? 0}/${currentSearch.total ?? 0}; Body-matched chats ${contentHits.size}; Displayed chats ${visibleIds.length}; Failed chats ${currentSearch.skipped.length}` }),
                                currentSearch.error && (0, jsx.jsx)("span", { className: "dac-error", children: currentSearch.error }),
                                currentSearch.status === "loading" ? (0, jsx.jsx)("button", { type: "button", className: "dac-btn", onClick: stopContentSearch, children: isZh(t) ? "停止搜索" : "Stop search" })
                                    : ["error", "partial", "stopped"].includes(currentSearch.status) && (0, jsx.jsx)("button", { type: "button", className: "dac-btn", onClick: () => startContentSearch(currentSearch), children: isZh(t) ? "重试未完成项" : "Retry unfinished" }),
                                currentSearch.skipped.length > 0 && (0, jsx.jsxs)("details", { children: [(0, jsx.jsx)("summary", { children: isZh(t) ? "未读取详情" : "Unreadable chats" }), (0, jsx.jsx)("ul", { children: currentSearch.skipped.map(item => (0, jsx.jsx)("li", { children: `${item.sessionId}: ${item.reason}` }, item.sessionId)) })] }),
                            ] }),
					selectionMode && (0, jsx.jsxs)("div", { className: "dac-selectionbar", children: [
                        (0, jsx.jsxs)("div", { className: "dac-selection-info", children: [
                            (0, jsx.jsxs)("label", { className: "dac-selection-all", children: [
                                (0, jsx.jsx)(SelectionCheckbox, { checked: selectableIds.length > 0 && visibleSelected === selectableIds.length, indeterminate: visibleSelected > 0 && visibleSelected < selectableIds.length, disabled: selectableIds.length === 0 || confirmBusy, ariaLabel: isZh(t) ? "全选当前结果" : "Select all current results", onChange: selectCurrentResults }),
                                (0, jsx.jsx)("span", { children: isZh(t) ? "全选" : "Select all" })
                            ] }),
                            (0, jsx.jsxs)("span", { className: "dac-selection-count", role: "status", children: [
                                (0, jsx.jsx)("span", { children: isZh(t) ? `已选 ${selected.length} 项` : `${selected.length} selected` }),
                                hiddenSelected > 0 && (0, jsx.jsx)("small", { children: isZh(t) ? `${hiddenSelected} 项不在当前结果中` : `${hiddenSelected} outside current results` })
                            ] })
                        ] }),
                        (0, jsx.jsxs)("div", { className: "dac-selection-actions", "data-language": isZh(t) ? "zh" : "en", children: [
                            (0, jsx.jsx)("button", { type: "button", className: "dac-action-trigger", disabled: selectionBusy, onClick: () => askSelectionAction("unarchive"), children: t("chat.unarchive") }),
                            (0, jsx.jsxs)("span", { className: "dac-selection-secondary", children: [
                                (0, jsx.jsx)("button", { type: "button", className: "dac-action-trigger", disabled: selectionBusy, onClick: () => askSelectionAction("export"), children: t("export.selected") }),
                            ] }),
                            (0, jsx.jsx)("span", { className: "dac-selection-overflow", children: (0, jsx.jsxs)(ChatActionMenu, { t, toolbar: true, triggerLabel: isZh(t) ? "更多选中项操作" : "More selection actions", children: [
                                (0, jsx.jsx)("button", { type: "button", className: "dac-menu-item", disabled: selectionBusy, onClick: () => askSelectionAction("export"), children: t("export.selected") }),
                            ] }) }),
                            (0, jsx.jsx)(ArchiveDeleteButton, { sessionId: "selection", label: isZh(t) ? "永久删除选中会话" : "Permanently delete selected chats", disabled: selectionBusy, onDelete: () => askSelectionAction("permanent") }),
                            (0, jsx.jsx)("button", { type: "button", className: "dac-action-trigger dac-selection-cancel", disabled: confirmBusy, onClick: cancelSelection, children: t("confirm.cancel") })
                        ] })
                    ] }),
                    (0, jsx.jsx)(NoticeBanner, {
						t, notice, interaction: noticeInteraction, top: toastTop(),
						onDismiss: () => setNotice(null),
						onUndoTrash: () => undoTrashMove(notice.ids),
						onViewArchived: viewRestoredArchive,
					}),
					projectFilter === "__dac_scheduled__" && scheduleStatus !== "ready" && (0, jsx.jsx)("div", { className: "dac-warn", role: "status", children: t(scheduleStatus === "unavailable" ? "filter.scheduleUnavailable" : "filter.scheduleUnsupported") }),
                    (sessions ?? []).length === 0 && (0, jsx.jsx)(EmptyState, {
						icon: IconArchive, children: t("state.empty")
					}),
					(sessions ?? []).length > 0 && groups.length === 0 && filtering && (0, jsx.jsx)(EmptyState, {
						icon: IconSearch, children: t("state.emptyFiltered")
					}),
					groups.map((group) => (0, jsx.jsx)(GroupSection, {
						group,
						t,
						collapsed: collapsed[group.key] === true,
						onToggleCollapsed: toggleCollapsed,
						menuOpen: menuFor === group.key,
						onToggleMenu: setMenuFor,
							onUnarchive: (ids, title) => title === undefined ? unarchive(ids) : askArchiveAction("unarchive", ids, { kind: "workspace", title }),
						onDelete: askDelete,
						onPermanentDelete: askPermanentDelete,
						onExport: (ids, title) => askArchiveAction("export", ids, { kind: "workspace", title }),
						onPreview: openPreview,
						contentHits,
						busy,
						stats,
						selectionMode, selectedIds, onSelect: toggleSelection
							}, group.key)),
					] }),
					pageMode === "trash" && (0, jsx.jsxs)("div", { id: "dac-panel-trash", role: "tabpanel", "aria-labelledby": "dac-tab-trash", className: "dac-mode-panel", children: [
                        (0, jsx.jsx)("p", { className: "dac-intro", children: isZh(t) ? "这里仅保留旧回收记录。自动清理已停用，可恢复到已归档、导出保护快照或确认永久删除。保护快照包含图片，不是常规会话导入包。" : "Legacy recycled chats only. Automatic cleanup is off. Restore to Archived, export a protection snapshot, or explicitly delete permanently. Protection snapshots include images and are not standard conversation import ZIPs." }),
						trash.status === "loading" && (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { className: "dac-spin" }), (0, jsx.jsx)("span", { children: t("trash.loading") })] }),
						trash.status === "error" && (0, jsx.jsxs)("div", { className: "dac-center", children: [
							(0, jsx.jsx)("span", { children: t("trash.unavailable") }),
							(0, jsx.jsx)("button", { type: "button", className: "dac-retry", onClick: loadTrash, children: t("state.retry") }),
						] }),
						trash.status === "ready" && trash.trashStatus !== "ready" && (0, jsx.jsx)("div", { className: "dac-warn", role: "status", children: t("trash.unavailable") }),
						(0, jsx.jsx)(NoticeBanner, {
							t, notice, interaction: noticeInteraction, top: toastTop(),
							onDismiss: () => setNotice(null),
							onUndoTrash: () => undoTrashMove(notice.ids),
							onViewArchived: viewRestoredArchive,
						}),
						trash.status === "ready" && trash.sessions.length === 0 && (0, jsx.jsx)(EmptyState, { icon: IconTrash, children: t("trash.empty") }),
							...trashGroups.map((group) => (0, jsx.jsx)(TrashGroupSection, {
								group, t, collapsed: collapsed[`trash:${group.key}`] === true,
								onToggleCollapsed: (key) => toggleCollapsed(`trash:${key}`),
								menuOpen: menuFor === `trash:${group.key}`,
								onToggleMenu: setMenuFor,
								busy: trashBusy, mutationsAvailable: trashMutationsAvailable,
							onRestore: askTrashRestore, onPurge: askTrashPurge,
                                onExport: async id => { try { await submitExport([id], undefined, "/trash/export"); } catch (error) { setNotice({ kind: "error", text: recycleErrorText(t, error) }); } },
							onPreview: (row) => openPreview(row, "trash"),
						}, group.key)),
					] }),
					pageMode === "lineage" && (0, jsx.jsx)("div", { id: "dac-panel-lineage", role: "tabpanel", "aria-labelledby": "dac-tab-lineage", children: (0, jsx.jsx)(ArchiveRelationshipsPanel, { key: `lineage-${workspaceArchiveRefresh}`, t }) }),
                    pageMode === "unarchived" && (0, jsx.jsxs)("div", { id: "dac-panel-unarchived", role: "tabpanel", "aria-labelledby": "dac-tab-unarchived", "aria-busy": unarchived.status === "loading" || unarchived.status === "refreshing", className: "dac-mode-panel", children: [
                        (0, jsx.jsxs)("div", { className: "dac-querybar-stacked", children: [
                            (0, jsx.jsxs)("div", { className: "dac-search", children: [
                                (0, jsx.jsx)(IconSearch, {}),
                                (0, jsx.jsx)("input", { type: "search", "aria-label": t("unarchived.search"), placeholder: t("unarchived.search"), value: unarchivedQuery, onChange: event => setUnarchivedQuery(event.target.value) }),
                            ] }),
                            (0, jsx.jsxs)("div", { className: "dac-filters", children: [
                                (0, jsx.jsx)(FilterSelect, { t, optionIcons: false, value: sortMode, onChange: setSortMode, ariaLabel: t("sort.label"), options: [["newest", "sort.newest"], ["oldest", "sort.oldest"], ["title", "sort.title"]].map(([value, label]) => ({ value, label: t(label) })) }),
                                (0, jsx.jsx)(WorkspaceFilter, { t, value: unarchivedWorkspace, onChange: setUnarchivedWorkspace, scheduleStatus: unarchived.scheduleStatus, workspaces: unarchivedWorkspaces.map(workspace => ({ value: workspace.id === "__dac_ungrouped__" ? "ungrouped" : workspace.id, title: workspace.title })) }),
                            ] }),
                        ] }),
                        (0, jsx.jsx)(NoticeBanner, { t, notice, interaction: noticeInteraction, top: toastTop(), onDismiss: () => setNotice(null), onViewArchived: viewRestoredArchive }),
                        unarchivedWorkspace === "__dac_scheduled__" && unarchived.scheduleStatus !== "ready" && (0, jsx.jsx)("div", { className: "dac-warn", role: "status", children: t(unarchived.scheduleStatus === "unavailable" ? "filter.scheduleUnavailable" : "filter.scheduleUnsupported") }),
                        unarchived.metadataStatus === "unavailable" && (0, jsx.jsx)("div", { className: "dac-warn", role: "status", children: t("meta.unavailable") }),
                        unarchived.status === "loading" && (0, jsx.jsx)("div", { className: "dac-center", role: "status", children: t("unarchived.loading") }),
                        unarchived.status === "error" && (0, jsx.jsx)("div", { className: "dac-center", role: "alert", children: t("unarchived.error") }),
                        unarchived.status === "ready" && visibleUnarchived.length === 0 && (0, jsx.jsx)(EmptyState, { icon: unarchived.sessions.length > 0 ? IconSearch : IconChat, children: t(unarchived.sessions.length > 0 ? "state.emptyFiltered" : "unarchived.empty") }),
                        (unarchived.status === "ready" || unarchived.status === "refreshing") && unarchivedGroups.map(group => (0, jsx.jsx)(GroupSection, {
                            group, t, collapsed: collapsed[`unarchived:${group.key}`] === true,
                            onToggleCollapsed: key => toggleCollapsed(`unarchived:${key}`),
                            menuOpen: menuFor === `unarchived:${group.key}`,
                            onToggleMenu: key => setMenuFor(key === null ? null : `unarchived:${key}`),
                            onArchive: archiveUnarchived, onPreview: row => openPreview(row, "unarchived"), busy: {},
                        }, group.key)),
                    ] }),
					pageMode === "about" && (0, jsx.jsx)("div", { id: "dac-panel-about", role: "tabpanel", "aria-labelledby": "dac-tab-about", children: (0, jsx.jsx)(AboutPanel, { t, about, loading: aboutLoading, checking: aboutChecking, onCheck: openUpdate, onReload: loadAbout, onMaintenance: openResiduals, maintenanceBusy: orphansBusy || orphans.status === "loading" }) }),
                    updateOpen && (0, jsx.jsx)(UpdateDialog, { t, about, checking: aboutChecking, installing: updateBusy, error: updateError, onCheck: () => { setUpdateError(null); return checkUpdates(true); }, onInstall: installUpdate, onClose: () => { if (!updateRequestRef.current) setUpdateOpen(false); }, returnFocus: updateReturnFocusRef.current, fallbackFocusRef: pageHeadingRef }),
						workspaceArchive?.stage === "choose" && (0, jsx.jsx)(WorkspaceArchiveChooserDialog, {
							t,
							onChoose: chooseWorkspaceArchive,
							onClose: cancelWorkspaceArchiveChoice,
						}),
							workspaceArchive?.stage === "confirm" && (0, jsx.jsx)(WorkspaceArchiveDialog, {
                                includeActive: true,
								t,
								workspaces: workspaceArchive.workspaces,
                                scope: workspaceArchive.scope,
								restoreFocus: restoreWorkspaceArchiveFocus,
								onClose: closeWorkspaceArchive,
								onEmpty: workspaceArchive.fromUnarchived ? () => { closeWorkspaceArchive(); restoreWorkspaceArchiveFocus(); void loadUnarchived(); setNotice({ kind: "error", text: t("workspaceArchive.reason.session-workspace-changed") }); } : returnToWorkspaceArchiveChoice,
								onApplied: workspaceArchiveApplied,
						}),
                    residualOpen && (0, jsx.jsx)(ResidualSessionsDialog, {
                        state: orphans, selected: orphanSelection, blocked: orphanBlocked, busy: orphansBusy,
                        suspended: preview !== null || orphanConfirm !== null || orphanExportConfirm !== null,
                        t, returnFocus: residualReturnFocusRef.current, fallbackFocusRef: pageHeadingRef,
                        notice, onDismiss: () => setNotice(null), onToggle: toggleOrphan, onSelectVisible: toggleAllOrphans,
                        onPreview: row => openPreview(row, "orphan-subagent"), onExport: exportSelectedOrphans,
                        onDelete: askOrphanDelete, onCheck: checkResiduals, onClose: closeResiduals,
                    }),
						preview !== null && (0, jsx.jsx)(PreviewDialog, {
							preview,
							t,
							busy: previewBusy,
							returnFocus: previewReturnFocusRef.current,
							fallbackFocusRef: pageHeadingRef,
                            onEditMetadata: previewArchiveSession ? () => leavePreviewFor(() => openMetadataEditor(previewArchiveSession)) : undefined,
                            actionBusy: previewArchiveSession ? busy[previewArchiveSession.id] === true : false,
                            metadataUnavailable: metadataStatus === "unavailable",
							onLoadMore: loadMorePreview,
							onCancel: closePreview,
						}),
						importPreview !== null && (0, jsx.jsx)(ImportDialog, {
							preview: importPreview,
							t,
							busy: importBusy,
							returnFocus: importReturnFocusRef.current,
							fallbackFocusRef: pageHeadingRef,
							onToggle: toggleImportSelection,
							onSelectAll: selectAllImport,
							onClear: clearImport,
							onConfirm: restoreImport,
							onCancel: () => { if (!importActionRef.current) setImportPreview(null); },
						}),
						metadataEdit !== null && (0, jsx.jsx)(MetadataDialog, {
						session: metadataEdit,
						t,
						busy: metaBusy,
						returnFocus: metaReturnFocusRef.current,
						fallbackFocusRef: pageHeadingRef,
						onSave: (tags, note) => saveMetadataFor(metadataEdit.id, tags, note),
							onCancel: () => { if (!metaActionRef.current) setMetadataEdit(null); }
					}),
					confirm !== null && (0, jsx.jsx)(ConfirmDialog, {
						title: confirm.title,
						body: confirm.body,
						confirmLabel: confirm.label,
                        deleteAll: confirm.deleteAll === true,
						confirmClassName: confirm.danger ? "dac-btn-danger" : "dac-btn-primary",
						cancelLabel: t("confirm.cancel"),
						busy: confirmBusy || confirm.ids.some((id) => busy[id] === true),
						returnFocus: deleteReturnFocusRef.current,
						fallbackFocusRef: pageHeadingRef,
						onConfirm: confirmArchiveAction,
						onCancel: () => { if (!confirmActionRef.current) setConfirm(null); }
					}),
					trashConfirm !== null && (0, jsx.jsx)(ConfirmDialog, {
						title: trashConfirm.title,
						body: trashConfirm.body,
						confirmLabel: trashConfirm.label,
                        deleteAll: trashConfirm.deleteAll === true,
						confirmClassName: trashConfirm.action === "restore" ? "dac-btn-primary" : "dac-btn-danger",
						cancelLabel: t("confirm.cancel"),
						busy: trashConfirm.ids.some((id) => trashBusy[id] === true),
						returnFocus: trashReturnFocusRef.current,
						fallbackFocusRef: pageHeadingRef,
							onConfirm: trashConfirm.action === "restore" ? () => restoreFromTrash(trashConfirm.ids, trashConfirm.scope) : trashConfirm.empty ? () => emptyRecycleBin(trashConfirm.targets) : () => purgeFromTrash(trashConfirm.ids),
						onCancel: () => { if (!trashActionRef.current) setTrashConfirm(null); },
						}),
					orphanConfirm !== null && (0, jsx.jsx)(ConfirmDialog, {
						title: t("orphans.delete.title"),
						body: t("orphans.delete.body").replace("{count}", String(orphanConfirm.ids.length)),
						confirmLabel: t("orphans.delete"),
						confirmClassName: "dac-btn-danger",
						cancelLabel: t("confirm.cancel"),
						busy: orphansBusy,
						returnFocus: orphanReturnFocusRef.current,
						fallbackFocusRef: pageHeadingRef,
						onConfirm: confirmOrphanDelete,
						onCancel: () => { if (!orphansBusy) setOrphanConfirm(null); },
						}),
					orphanExportConfirm !== null && (0, jsx.jsx)(ConfirmDialog, {
						title: t("orphans.exportConfirm.title"),
						body: t("orphans.exportConfirm.body")
							.replace("{blocked}", String(orphanExportConfirm.blockedIds.length))
							.replace("{keep}", String(orphanExportConfirm.requested.length - orphanExportConfirm.blockedIds.length)),
						confirmLabel: t("orphans.exportConfirm.confirm"),
						confirmClassName: "dac-btn-primary",
						cancelLabel: t("confirm.cancel"),
						busy: orphansBusy,
						returnFocus: orphanReturnFocusRef.current,
						fallbackFocusRef: pageHeadingRef,
						onConfirm: confirmOrphanExport,
						onCancel: () => { if (!orphansBusy) setOrphanExportConfirm(null); },
						}),
				]
			});
		}
		//#endregion

		//#region plugin body
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), "archived-chats: dictionaries");
			ensureStyle();
			ctx.effect(() => () => { document.getElementById(STYLE_ID)?.remove(); }, "archived-chats: css cleanup");
			startNavIconPatch();
			ctx.effect(() => () => { stopNavIconPatch(); }, "archived-chats: nav-icon observer cleanup");

			const t = ctx.locale.bind(SETTINGS_NS);
			// Sidebar convergence after deletes: the concrete client sessions
			// service re-pulls its session.list baseline on refresh(). Optional
			// on purpose — an older runtime without it still deletes correctly,
			// the main page just needs a reload to catch up.
			const refreshSidebar = () => {
				try { return ctx.get("sessions")?.refresh?.(); } catch { return undefined; /* sidebar converges on next reconnect */ }
			};
			const refreshWorkspaceArchiveConsumers = async () => {
				await Promise.allSettled([
					Promise.resolve().then(() => refreshSidebar()),
					Promise.resolve().then(() => ctx.get("workspaces")?.refresh?.()),
				]);
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "archived-chats",
				order: 30,
				label: () => t("nav"),
				locale: SETTINGS_NS,
				inject: () => ({ refreshSidebar, refreshWorkspaceArchiveConsumers, subscribeArchiveChanges: listener => {
                        const disposers = [];
                    try {
                        const dispose = ctx.remote?.$on?.("schedule/changed", listener);
                        if (typeof dispose === "function") disposers.push(dispose);
                    } catch { /* Schedule service is optional. */ }
                    try {
                        const dispose = ctx.get("workspaces")?.list?.subscribe?.(listener);
                        if (typeof dispose === "function") disposers.push(dispose);
                    } catch { /* Older hosts may not expose workspace subscriptions. */ }
                    try {
                        const source = ctx.get("sessions")?.list;
                        const snapshot = () => {
                            const rows = source?.getSnapshot?.()?.byId;
                            return rows ? new Map(Object.entries(rows).map(([id, row]) => [id,
                                JSON.stringify([row.title, row.displayTitle, row.blank, row.cwd, row.origin, row.running])
                            ])) : null;
                        };
                        let previous = snapshot();
                        const dispose = source?.subscribe?.(() => {
                            const next = snapshot();
                            // Ignore token/timestamp churn; refresh on list membership,
                            // title, visibility, workspace or running-state changes.
                            const changed = !previous || !next || previous.size !== next.size
                                || [...next].some(([id, value]) => previous.get(id) !== value);
                            previous = next;
                            if (changed) listener();
                        });
                        if (typeof dispose === "function") disposers.push(dispose);
                    } catch { /* Retain workspace/focus refresh on older hosts. */ }
                    return () => { for (const dispose of disposers) dispose(); };
                    } })
			}, ArchivedChatsSection));

		}
		//#endregion

		exports.SETTINGS_NS = SETTINGS_NS;
			exports.__test = { watchPluginUpdates, UpdateDialog, runArchiveSearch, archiveSearchCandidates, NotePreview, formatBytes, matchesArchivedSession, filterByTag, sortArchivedSessions, setVisibleSelection, uniqueSessionIds, NativeArchiveNotice, WorkspaceArchiveChooserDialog, WorkspaceArchiveDialog, MetadataDialog, ImportDialog, ArchiveTabs, defaultRetentionSelection, filterLineageForest, groupLineageWorkspaces, SnapshotInsightRows, LineageTreeNodes, StorageRetentionPanel, ArchiveRelationshipsPanel, groupTrashSessions, trashStatusLabel, markArchiveDialog, submitExport, submitImportFile, fetchTrash, fetchOrphans, deleteOrphans, fetchInsights, NoticeBanner, saveRetentionPolicy, previewRetention, applyRetention, fetchLineage, restoreTrash, purgeTrash, emptyTrash, fetchArchivePreview, fetchArchiveImage, fetchArchiveSearch, fetchWorkspaceArchiveWorkspaces, previewWorkspaceArchive, applyWorkspaceArchive, buildPreviewNodes, previewCopyText, groupPreviewSegments, resolvePreviewPrimitives, PreviewMarkdown, PreviewReasoning, PreviewDisclosure, PreviewMessage, PreviewActions, previewFocusables, PreviewImage, unarchiveFailureText, importWarningText, editIconSpec: EDIT_ICON_SPEC };
		exports.__test.importFailureText = importFailureText;
		exports.__test.useSuccessNoticeTimer = useSuccessNoticeTimer;
		exports.__test.HelpTooltip = HelpTooltip;
        exports.__test.ArchiveDeleteButton = ArchiveDeleteButton;
        exports.__test.PreviewTitleButton = PreviewTitleButton;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
