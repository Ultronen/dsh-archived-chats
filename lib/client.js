// dsh-archived-chats — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-archived-chats/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with require()
// resolved against the shell's module table — the same shape the shipped ui-*
// packages emit.
//
// What this plugin is: an archived-chat settings section plus a frame-wide
// archive-success notice. The stock DSH sidebar hides archived sessions with
// no list surface; this plugin restores search, filters, preview, unarchive,
// recycle, and batch management while offering immediate View/Undo after the
// public workspace archive action succeeds. Durable changes still flow only
// through /plugins/dsh-archived-chats/* routes and the Host workspace registry.
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
			return Object.freeze({
				MarkdownText: typeof source?.MarkdownText === "function" ? source.MarkdownText : null,
				DisclosureRow: typeof source?.DisclosureRow === "function" ? source.DisclosureRow : null,
				JsonBlock: typeof source?.JsonBlock === "function" ? source.JsonBlock : null,
				IconThink: typeof source?.IconThinkOutline14 === "function" ? source.IconThinkOutline14 : null,
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

		//#region archive success notice
		function createArchiveNoticeController({
			durationMs = 3000,
			schedule = (callback, delay) => setTimeout(callback, delay),
			cancel = (timer) => clearTimeout(timer),
			undo: performUndo = async () => {},
			view: performView = async () => true,
		} = {}) {
			const listeners = new Set();
			const timeout = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 3000;
			const pauseReasons = new Set();
			let snapshot = null;
			let timer = null;
			const publish = () => { for (const listener of listeners) listener(); };
			const clearTimer = () => {
				if (timer === null) return;
				cancel(timer);
				timer = null;
			};
			const dismiss = () => {
				if (snapshot === null) return;
				clearTimer();
				pauseReasons.clear();
				snapshot = null;
				publish();
			};
			const arm = () => {
				if (snapshot === null || timer !== null || pauseReasons.size > 0 || snapshot.status !== "ready") return;
				const expected = snapshot;
				timer = schedule(() => {
					timer = null;
					if (snapshot === expected) dismiss();
				}, timeout);
			};
			const run = async (pendingStatus, errorStatus, action) => {
				if (snapshot === null || !["ready", "undo-error", "view-error"].includes(snapshot.status)) return false;
				clearTimer();
				const pending = { sessionId: snapshot.sessionId, status: pendingStatus };
				snapshot = pending;
				publish();
				try {
					const result = await action(pending.sessionId);
					if (result === false) throw new Error(`${pendingStatus} failed`);
					if (snapshot === pending) dismiss();
					return true;
				} catch {
					if (snapshot === pending) {
						snapshot = { sessionId: pending.sessionId, status: errorStatus };
						publish();
					}
					return false;
				}
			};
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
				show(sessionId) {
					if (typeof sessionId !== "string" || sessionId === "") return;
					clearTimer();
					snapshot = { sessionId, status: "ready" };
					publish();
					arm();
				},
				pause(reason = "interaction") { pauseReasons.add(reason); clearTimer(); },
				resume(reason = "interaction") { pauseReasons.delete(reason); arm(); },
				dismiss,
				undo: () => run("undoing", "undo-error", performUndo),
				view: () => run("viewing", "view-error", performView),
			};
		}

		function installArchiveNoticeInterceptor(workspaces, controller) {
			if (workspaces === null || typeof workspaces !== "object"
				|| typeof workspaces.archiveSession !== "function"
				|| typeof controller?.show !== "function") return () => {};
			const hadOwnMethod = Object.prototype.hasOwnProperty.call(workspaces, "archiveSession");
			const original = workspaces.archiveSession;
			const wrapped = async function archiveSessionWithNotice(sessionId) {
				const result = await original.call(this, sessionId);
				controller.show(String(sessionId));
				return result;
			};
			workspaces.archiveSession = wrapped;
			return () => {
				if (workspaces.archiveSession !== wrapped) return;
				if (hadOwnMethod) workspaces.archiveSession = original;
				else delete workspaces.archiveSession;
			};
		}

		async function openArchiveSettings(t, root = document, nextPaint = () => new Promise((resolve) => {
			if (typeof window?.requestAnimationFrame === "function") window.requestAnimationFrame(() => resolve());
			else setTimeout(resolve, 0);
		})) {
			if (typeof root?.querySelectorAll !== "function") return false;
			const text = (node) => String(node?.textContent ?? "").replace(/\s+/gu, " ").trim();
			const selectArchiveSection = () => {
				const target = [...root.querySelectorAll('[role="dialog"] nav button')]
					.find((button) => text(button) === t("nav"));
				if (typeof target?.click !== "function") return false;
				target.click();
				return true;
			};
			if (selectArchiveSection()) return true;
			const triggers = [...root.querySelectorAll('button[aria-haspopup="dialog"]')];
			const settingsLabel = t("archiveNotice.settings");
			const trigger = triggers.find((button) => text(button) === settingsLabel)
				?? (triggers.length === 1 ? triggers[0] : null);
			if (typeof trigger?.click !== "function") return false;
			try {
				trigger.click();
				await nextPaint();
				await nextPaint();
				return selectArchiveSection();
			} catch {
				return false;
			}
		}
		//#endregion

		//#region locale
		const zh = {
			"locale.intl": "zh-CN",
			"nav": "会话档案",
			"archiveNotice.title": "已归档的聊天",
			"archiveNotice.view": "查看",
			"archiveNotice.opening": "正在打开…",
			"archiveNotice.undo": "撤销",
			"archiveNotice.undoing": "正在撤销…",
			"archiveNotice.retry": "重试",
			"archiveNotice.close": "关闭归档提示",
			"archiveNotice.settings": "设置",
			"archiveNotice.undoError": "撤销失败，请重试",
			"archiveNotice.viewError": "无法打开会话档案，请重试",
				"page.title": "会话档案",
				"tab.archived": "归档",
				"tab.trash": "回收站",
				"tab.insights": "空间与策略",
				"tab.lineage": "来源与分支",
				"insights.loading": "正在分析空间…",
				"insights.error": "空间分析暂不可用",
				"insights.scopeNote": "这里只统计已归档、回收站会话，以及本插件为它们创建并继续保留的恢复快照。恢复聊天后快照仍可保留，所以归档列表为空时这里仍可能有数据。",
				"insights.sessions": "会话目录",
				"insights.snapshots": "保护快照",
				"insights.total": "已统计总量",
				"insights.duplicate": "重复快照附件",
				"insights.unavailable": "不可用会话 / 降级快照",
				"insights.snapshot.active": "回收站使用中的恢复快照",
				"insights.snapshot.history": "已保留的恢复快照",
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
				"retention.history": "每个原会话保留的恢复快照",
				"retention.snapshotAge": "历史快照最长保留天数",
				"retention.quota": "快照容量上限（字节）",
				"retention.recycleAge": "回收站最长保留天数",
				"retention.disabled": "不启用",
				"retention.save": "保存策略",
				"retention.preview": "预览清理",
				"retention.apply": "应用所选清理",
				"retention.empty": "当前策略没有清理候选",
				"retention.saved": "策略已保存，不会自动执行清理",
				"retention.note": "保留数量按每个原会话分别计算；保存策略不会删除任何数据，必须再预览并应用清理。",
				"retention.snapshotCandidate": "历史快照清理",
				"retention.trashCandidate": "永久删除回收站会话",
				"retention.projected": "清理后快照占用",
				"retention.purgeWarning": "所选回收站项会永久删除原会话及其全部保护快照，无法撤销。",
				"retention.reason.history-count": "超过历史数量",
				"retention.reason.snapshot-age": "超过快照年龄",
				"retention.reason.snapshot-quota": "超过快照容量",
				"retention.reason.recycle-age": "超过回收站年龄",
				"retention.applied": "清理完成",
				"retention.result": "已完成 / 失败",
				"lineage.origin.session": "普通会话",
				"lineage.origin.subagent": "子代理",
				"lineage.copyId": "复制 ID",
				"lineage.copiedId": "已复制",
				"lineage.loading": "正在读取来源与分支…",
				"lineage.error": "来源与分支暂不可用",
				"lineage.scopeNote": "当前仅展示已归档和回收站会话；活动会话只在连接管理对象时作为来源上下文出现，不受本插件管理。",
				"lineage.search": "搜索会话或项目",
				"lineage.projectFilter": "筛选项目",
				"lineage.statusFilter": "筛选状态",
				"lineage.statusAll": "全部状态",
				"lineage.managedHeading": "已管理会话",
				"lineage.managedCount": "个已管理会话",
				"lineage.expandAll": "全部展开",
				"lineage.collapseAll": "全部折叠",
				"lineage.searchFoldHint": "搜索期间保持命中路径展开",
				"lineage.empty": "暂无已归档或回收站会话的来源与分支",
				"lineage.status.active": "来源会话",
				"lineage.status.archived": "已归档",
				"lineage.status.trash": "回收站",
				"lineage.status.missing": "原会话缺失",
				"lineage.untitled": "未命名会话",
				"lineage.sourceUnavailable": "来源信息不可用",
				"lineage.sourceContext": "来源于",
				"lineage.contextOnly": "活动会话，仅用于解释关系",
				"lineage.start": "起始会话",
				"lineage.created": "创建于",
				"lineage.project": "项目",
				"lineage.delegation": "委派层级",
				"lineage.noBranches": "无分支",
				"lineage.diagnostic.missing-parent": "父会话缺失",
				"lineage.diagnostic.self-parent": "会话指向自身",
				"lineage.diagnostic.cycle": "检测到循环",
				"lineage.diagnostic.delegation-depth-mismatch": "委派深度不一致",
					"action.import": "导入备份",
					"action.export": "导出备份",
				"action.more": "更多",
				"delete.all": "全部移至回收站",
				"import.action": "导入备份",
				"import.title": "导入归档备份",
				"import.inspecting": "正在检查备份…",
				"import.preview": "恢复前请确认要导入的会话",
				"import.package": "备份信息",
				"import.confirm": "恢复选中项",
				"import.cancel": "取消",
				"import.selectAll": "全选可恢复项",
				"import.clear": "清除选择",
				"import.conflict": "ID 冲突，将跳过",
				"import.workspaceWarning": "项目不存在，将保持未分组",
				"import.attachmentWarning": "包含附件引用，但不会恢复附件文件",
				"import.restored": "已恢复",
				"import.skipped": "已跳过",
				"import.expired": "预览已过期，请重新选择备份",
				"import.done": "备份恢复完成",
				"export.all": "全部导出",
				"export.selected": "导出选中项",
				"export.row": "导出备份",
				"export.started": "已开始下载备份",
			"search.placeholder": "搜索标题、标签、备注和聊天内容",
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
			"preview.system": "系统",
			"preview.reasoning": "思考过程",
			"preview.toolCall": "工具调用",
			"preview.toolResult": "工具结果",
			"preview.toolArguments": "参数",
			"preview.json": "JSON",
			"preview.unknown": "未知内容",
			"preview.copy": "复制",
			"preview.copied": "已复制",
			"preview.imageUnavailable": "图片不可用",
			"preview.readOnly": "只读预览",
			"preview.toolPending": "等待中",
			"preview.toolRunning": "运行中",
			"preview.toolComplete": "已完成",
			"preview.toolFailed": "失败",
			"filter.allChats": "全部聊天",
			"filter.normal": "普通会话",
			"filter.subagent": "子代理会话",
			"filter.allProjects": "所有项目",
			"sort.label": "排序方式",
			"sort.newest": "最新优先",
			"sort.oldest": "最早优先",
			"sort.title": "按标题",
			"selection.visible": "选择当前结果",
			"selection.group": "选择此项目",
			"selection.start": "批量选择",
			"selection.done": "完成",
			"selection.clear": "清除",
			"bulk.unarchive": "取消归档",
			"bulk.delete": "移至回收站",
			"group.noProject": "未分组",
			"chat.untitled": "未命名会话",
			"chat.unarchive": "取消归档",
			"menu.unarchiveAll": "全部取消归档",
			"menu.deleteAll": "全部移至回收站",
			"group.collapse": "折叠",
			"group.expand": "展开",
			"confirm.deleteOne.title": "移至回收站？",
			"confirm.deleteOne.body": "会自动创建保护快照，之后可从回收站恢复",
			"confirm.deleteAll.title": "全部移至回收站？",
			"confirm.deleteGroup.title": "将该项目下的已归档聊天移至回收站？",
			"confirm.deleteSelected.title": "将选中的已归档聊天移至回收站？",
			"confirm.cancel": "取消",
			"confirm.delete": "移至回收站",
			"trash.restore": "恢复",
			"trash.purge": "永久删除",
			"trash.emptyAction": "清空回收站",
			"trash.select": "选择回收站会话",
			"trash.selectAll": "选择全部回收站会话",
			"trash.restoreSelected": "恢复选中项",
			"trash.purgeSelected": "永久删除选中项",
			"trash.empty": "回收站是空的",
			"trash.loading": "正在读取回收站…",
			"trash.unavailable": "回收站暂不可用；归档管理仍可使用",
			"trash.status.ready": "保护快照可用",
			"trash.status.parked": "会话已停用，可恢复",
			"trash.status.degraded": "快照降级",
			"trash.status.purgePending": "永久删除待恢复",
			"trash.attachments": "附件",
			"trash.confirm.title": "永久删除回收站中的会话？",
			"trash.confirm.body": "这将删除原会话和保护快照，且无法撤销",
			"trash.confirm.degraded": "部分项的保护快照不可用，但原会话仍会被永久删除。",
			"trash.confirm.emptyTitle": "清空回收站？",
			"trash.confirm.emptyBody": "这将永久删除回收站中所有原会话和保护快照",
			"trash.moved": "已移至回收站",
			"trash.restored": "已恢复会话",
			"trash.purged": "已永久删除",
			"trash.undo": "撤销",
			"state.loading": "加载中…",
			"state.empty": "暂无已归档的聊天",
			"state.emptyFiltered": "没有匹配的已归档聊天",
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
			"stats.unavailable": "部分会话无法统计"
		};
		const en = {
			"locale.intl": "en-US",
			"nav": "Session Archive",
			"archiveNotice.title": "Chat archived",
			"archiveNotice.view": "View",
			"archiveNotice.opening": "Opening…",
			"archiveNotice.undo": "Undo",
			"archiveNotice.undoing": "Undoing…",
			"archiveNotice.retry": "Retry",
			"archiveNotice.close": "Close archive notice",
			"archiveNotice.settings": "Settings",
			"archiveNotice.undoError": "Undo failed. Try again",
			"archiveNotice.viewError": "Could not open Session Archive. Try again",
				"page.title": "Session Archive",
				"tab.archived": "Archived",
				"tab.trash": "Recycle Bin",
				"tab.insights": "Storage & Retention",
				"tab.lineage": "Origins & Branches",
				"insights.loading": "Analyzing storage…",
				"insights.error": "Storage insights are unavailable",
				"insights.scopeNote": "This page measures archived and recycled chats plus recovery snapshots this plugin created and retained for them. Restoring a chat may retain its snapshot, so storage can remain when the archive list is empty.",
				"insights.sessions": "Session directories",
				"insights.snapshots": "Protection snapshots",
				"insights.total": "Measured total",
				"insights.duplicate": "Repeated snapshot attachments",
				"insights.unavailable": "Unavailable sessions / degraded snapshots",
				"insights.snapshot.active": "Recovery snapshot in use by Recycle Bin",
				"insights.snapshot.history": "Retained recovery snapshot",
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
				"retention.history": "Retained recovery snapshots per original chat",
				"retention.snapshotAge": "Historical snapshot maximum age in days",
				"retention.quota": "Snapshot quota in bytes",
				"retention.recycleAge": "Recycle Bin maximum age in days",
				"retention.disabled": "Disabled",
				"retention.save": "Save policy",
				"retention.preview": "Preview cleanup",
				"retention.apply": "Apply selected cleanup",
				"retention.empty": "The current policy has no cleanup candidates",
				"retention.saved": "Policy saved; no cleanup ran automatically",
				"retention.note": "The retention count applies separately to each original chat. Saving never deletes data; preview and apply cleanup separately.",
				"retention.snapshotCandidate": "Historical snapshot cleanup",
				"retention.trashCandidate": "Permanently delete recycled chat",
				"retention.projected": "Snapshot usage after cleanup",
				"retention.purgeWarning": "Selected recycle items permanently remove the original chat and every protection snapshot. This cannot be undone.",
				"retention.reason.history-count": "Exceeds history count",
				"retention.reason.snapshot-age": "Exceeds snapshot age",
				"retention.reason.snapshot-quota": "Exceeds snapshot quota",
				"retention.reason.recycle-age": "Exceeds recycle age",
				"retention.applied": "Cleanup completed",
				"retention.result": "Applied / failed",
				"lineage.origin.session": "Session",
				"lineage.origin.subagent": "Subagent",
				"lineage.copyId": "Copy ID",
				"lineage.copiedId": "Copied",
				"lineage.loading": "Loading origins and branches…",
				"lineage.error": "Origins and branches are unavailable",
				"lineage.scopeNote": "Only archived and recycled chats are managed here. Active chats appear only when needed to explain a managed relationship and are not managed by this plugin.",
				"lineage.search": "Search chats or projects",
				"lineage.projectFilter": "Filter by project",
				"lineage.statusFilter": "Filter status",
				"lineage.statusAll": "All statuses",
				"lineage.managedHeading": "Managed chats",
				"lineage.managedCount": "managed chats",
				"lineage.expandAll": "Expand all",
				"lineage.collapseAll": "Collapse all",
				"lineage.searchFoldHint": "Matching paths stay expanded while searching",
				"lineage.empty": "No origins or branches for archived or recycled chats",
				"lineage.status.active": "Source chat",
				"lineage.status.archived": "Archived",
				"lineage.status.trash": "Recycle Bin",
				"lineage.status.missing": "Original chat missing",
				"lineage.untitled": "Untitled chat",
				"lineage.sourceUnavailable": "Source information unavailable",
				"lineage.sourceContext": "Source",
				"lineage.contextOnly": "Active chat, shown for relationship context only",
				"lineage.start": "Starting chat",
				"lineage.created": "Created",
				"lineage.project": "Project",
				"lineage.delegation": "Delegation level",
				"lineage.noBranches": "No branches",
				"lineage.diagnostic.missing-parent": "Missing parent",
				"lineage.diagnostic.self-parent": "Self-parent link",
				"lineage.diagnostic.cycle": "Cycle detected",
				"lineage.diagnostic.delegation-depth-mismatch": "Delegation depth mismatch",
					"action.import": "Import backup",
					"action.export": "Export backup",
				"action.more": "More",
				"delete.all": "Move all to Recycle Bin",
				"import.action": "Import backup",
				"import.title": "Import archived backup",
				"import.inspecting": "Inspecting backup…",
				"import.preview": "Review the sessions before restoring",
				"import.package": "Backup details",
				"import.confirm": "Restore selected",
				"import.cancel": "Cancel",
				"import.selectAll": "Select restorable",
				"import.clear": "Clear selection",
				"import.conflict": "ID conflict, will be skipped",
				"import.workspaceWarning": "Workspace is missing; will stay ungrouped",
				"import.attachmentWarning": "Attachment references found; attachment files are not restored",
				"import.restored": "Restored",
				"import.skipped": "Skipped",
				"import.expired": "The preview expired. Choose the backup again",
				"import.done": "Backup restore completed",
				"export.all": "Export all",
				"export.selected": "Export selected",
				"export.row": "Export backup",
				"export.started": "Backup download started",
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
			"preview.system": "System",
			"preview.reasoning": "Reasoning",
			"preview.toolCall": "Tool call",
			"preview.toolResult": "Tool result",
			"preview.toolArguments": "Arguments",
			"preview.json": "JSON",
			"preview.unknown": "Unknown content",
			"preview.copy": "Copy",
			"preview.copied": "Copied",
			"preview.imageUnavailable": "Image unavailable",
			"preview.readOnly": "Read-only preview",
			"preview.toolPending": "Pending",
			"preview.toolRunning": "Running",
			"preview.toolComplete": "Complete",
			"preview.toolFailed": "Failed",
			"filter.allChats": "All chats",
			"filter.normal": "Regular chats",
			"filter.subagent": "Subagent chats",
			"filter.allProjects": "All projects",
			"sort.label": "Sort order",
			"sort.newest": "Newest first",
			"sort.oldest": "Oldest first",
			"sort.title": "Title",
			"selection.visible": "Select visible chats",
			"selection.group": "Select this project",
			"selection.start": "Select multiple",
			"selection.done": "Done",
			"selection.clear": "Clear",
			"bulk.unarchive": "Unarchive",
			"bulk.delete": "Move to Recycle Bin",
			"group.noProject": "Ungrouped",
			"chat.untitled": "Untitled chat",
			"chat.unarchive": "Unarchive",
			"menu.unarchiveAll": "Unarchive all",
			"menu.deleteAll": "Move all to Recycle Bin",
			"group.collapse": "Collapse",
			"group.expand": "Expand",
			"confirm.deleteOne.title": "Move to Recycle Bin?",
			"confirm.deleteOne.body": "A protection snapshot is created automatically so you can restore this chat later",
			"confirm.deleteAll.title": "Move all to Recycle Bin?",
			"confirm.deleteGroup.title": "Move this project's archived chats to Recycle Bin?",
			"confirm.deleteSelected.title": "Move selected archived chats to Recycle Bin?",
			"confirm.cancel": "Cancel",
			"confirm.delete": "Move to Recycle Bin",
			"trash.restore": "Restore",
			"trash.purge": "Delete permanently",
			"trash.emptyAction": "Empty Recycle Bin",
			"trash.select": "Select recycled chat",
			"trash.selectAll": "Select all recycled chats",
			"trash.restoreSelected": "Restore selected",
			"trash.purgeSelected": "Delete selected permanently",
			"trash.empty": "Recycle Bin is empty",
			"trash.loading": "Loading Recycle Bin…",
			"trash.unavailable": "Recycle Bin is unavailable; archived-chat management remains available",
			"trash.status.ready": "Protection snapshot ready",
			"trash.status.parked": "Session parked and restorable",
			"trash.status.degraded": "Snapshot degraded",
			"trash.status.purgePending": "Permanent deletion recovery pending",
			"trash.attachments": "attachments",
			"trash.confirm.title": "Permanently delete recycled chat?",
			"trash.confirm.body": "This removes the original chat and protection snapshot and cannot be undone",
			"trash.confirm.degraded": "Some protection snapshots are unavailable, but the original chats will still be permanently deleted.",
			"trash.confirm.emptyTitle": "Empty Recycle Bin?",
			"trash.confirm.emptyBody": "This permanently removes every original chat and protection snapshot in the Recycle Bin",
			"trash.moved": "Moved to Recycle Bin",
			"trash.restored": "Chat restored",
			"trash.purged": "Permanently deleted",
			"trash.undo": "Undo",
			"state.loading": "Loading…",
			"state.empty": "No archived chats",
			"state.emptyFiltered": "No archived chats match your filters",
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
			"stats.unavailable": "Some sessions could not be measured"
		};
		//#endregion

		//#region localized compositors (interpolation stays in JS)
		const isZh = (t) => t("locale.intl").startsWith("zh");
		const chatsCount = (t, n) => isZh(t) ? `${n} 个聊天` : n === 1 ? "1 chat" : `${n} chats`;
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
		const selectProjectLabel = (t, title) => `${t("selection.group")}${isZh(t) ? "：" : ": "}${title}`;
		const removeTagLabel = (t, tag) => isZh(t) ? `移除标签 ${tag}` : `Remove tag ${tag}`;
		const previewOpenLabel = (t, title) => `${t("preview.open")}${isZh(t) ? " " : ": "}${title}`;
		const previewRoleLabel = (t, role) => t(`preview.${["user", "assistant", "tool", "system"].includes(role) ? role : "system"}`);
		const previewSegmentLabel = (t, segment) => {
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
				: t(["active", "missing"].includes(node?.status) ? "lineage.sourceUnavailable" : "lineage.untitled");
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
			if (isZh(t)) return `${failed.length} 个会话删除失败：${failed[0]?.message ?? ""}`;
			return `${failed.length} chat${failed.length === 1 ? "" : "s"} failed to delete: ${failed[0]?.message ?? ""}`;
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
					const aDate = typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : null;
					const bDate = typeof b.createdAt === "number" && Number.isFinite(b.createdAt) ? b.createdAt : null;
					if ((aDate === null) !== (bDate === null)) return aDate === null ? 1 : -1;
					if (aDate !== null && bDate !== null && aDate !== bDate) return mode === "oldest" ? aDate - bDate : bDate - aDate;
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

		function reconcileSelection(selected, sessions) {
			const currentIds = new Set(sessions.map((session) => session.id));
			return new Set([...selected].filter((id) => currentIds.has(id)));
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
			const statusKey = ["archived", "trash"].includes(status) ? status : "all";
			const sourceRoots = Array.isArray(roots) ? roots : [];
			const results = new Map();
			const stack = sourceRoots.map((node) => ({ node, visited: false }));
			while (stack.length > 0) {
				const current = stack.pop();
				if (!current.visited) {
					stack.push({ node: current.node, visited: true });
					const children = Array.isArray(current.node?.children) ? current.node.children : [];
					for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], visited: false });
					continue;
				}
				const children = (Array.isArray(current.node?.children) ? current.node.children : []).map((child) => results.get(child)).filter(Boolean);
				const workspace = current.node?.workspace;
				const matchesProject = projectKey === "all" || lineageWorkspaceKey(current.node) === projectKey;
				const matchesQuery = normalized === "" || [current.node?.id, current.node?.title, workspace?.id, workspace?.title]
					.some((value) => String(value ?? "").toLocaleLowerCase("en-US").includes(normalized));
				const managed = !["active", "missing"].includes(current.node?.status);
				const matchesStatus = statusKey === "all" || current.node?.status === statusKey;
				const own = managed && matchesProject && matchesQuery && matchesStatus;
				results.set(current.node, own || children.length > 0 ? { ...current.node, children } : null);
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
				const managed = !["active", "missing"].includes(node?.status);
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

		function lineageBranchIds(roots) {
			const ids = [];
			const stack = [...(Array.isArray(roots) ? roots : [])].reverse();
			while (stack.length > 0) {
				const node = stack.pop();
				const children = Array.isArray(node?.children) ? node.children : [];
				if (children.length > 0 && !["active", "missing"].includes(node?.status) && typeof node?.id === "string") ids.push(node.id);
				for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
			}
			return ids;
		}

		function defaultLineageCollapsed(value) {
			if (!Number.isFinite(value?.nodeCount) || value.nodeCount <= 50) return new Set();
			return new Set((Array.isArray(value?.roots) ? value.roots : [])
				.filter((node) => Array.isArray(node?.children) && node.children.length > 0 && typeof node?.id === "string")
				.map((node) => node.id));
		}

		function countManagedLineageNodes(roots) {
			let count = 0;
			const stack = [...(Array.isArray(roots) ? roots : [])];
			while (stack.length > 0) {
				const node = stack.pop();
				if (["archived", "trash"].includes(node?.status)) count += 1;
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
					selectionIds: [],
				});
				const group = groups.get(key);
				group.items.push(row);
				group.selectionIds.push(row.sessionId);
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
.dac-page{position:relative;display:flex;flex-direction:column;gap:14px;padding:4px 0 28px;font-family:inherit}
.dac-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dac-title{flex:none;white-space:nowrap;margin:0;color:var(--dsw-alias-label-primary);font-size:18px;font-weight:500;line-height:28px;outline:none}
.dac-head-actions{position:relative;display:flex;flex:0 1 auto;min-width:0;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:nowrap}
.dac-tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto}
.dac-tab{flex:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:8px 12px;cursor:pointer}
.dac-tab[aria-selected="true"]{border-bottom-color:var(--dsw-alias-interactive-primary,#6e6ef7);color:var(--dsw-alias-label-primary);font-weight:500}
.dac-mode-panel{display:flex;flex-direction:column;gap:14px}
.dac-action-wrap{position:relative;display:inline-flex}
.dac-action-trigger{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:5px 11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.dac-action-trigger:hover:not(:disabled),.dac-action-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-action-trigger:disabled{opacity:.45;cursor:default}
.dac-action-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:60;min-width:190px;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--dsw-alias-border-inverted);border-radius:10px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3)}
.dac-action-menu-item{display:flex;align-items:center;width:100%;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;padding:7px 10px;white-space:nowrap;cursor:pointer}
.dac-action-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-action-menu-item:disabled{opacity:.45;cursor:default}
.dac-action-menu-item.dac-danger{color:var(--dsw-alias-state-error-primary)}
.dac-action-menu-item.dac-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-search{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px;color:var(--dsw-alias-label-tertiary);transition:border-color .15s}
.dac-search:focus-within{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-search input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:0}
.dac-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dac-search-state{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.dac-search-state.dac-error{color:var(--dsw-alias-state-error-primary)}
.dac-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dac-select-wrap{position:relative;display:inline-flex;align-items:center}
.dac-select{appearance:none;-webkit-appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 28px 5px 14px;cursor:pointer;outline:none}
.dac-select-wrap-fill,.dac-select-fill{width:100%;min-width:0}
.dac-select:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-chevron{position:absolute;right:10px;pointer-events:none;color:var(--dsw-alias-label-tertiary);display:inline-flex}
.dac-selection-controls{display:flex;align-items:center;gap:8px;margin-left:auto}
.dac-selection-toggle{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer;user-select:none}
.dac-selection-mode{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 12px;cursor:pointer}
.dac-selection-mode:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-checkbox{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-interactive-primary,#6e6ef7);cursor:pointer;flex:none}
.dac-checkbox:disabled{cursor:default;opacity:.45}
.dac-bulkbar{position:sticky;top:8px;z-index:30;display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 35%,var(--dsw-alias-border-l2));border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 8%,var(--dsw-alias-bg-layer-2));padding:9px 12px;box-shadow:0 5px 18px rgba(0,0,0,.08)}
.dac-bulk-count{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.dac-bulk-actions{display:flex;align-items:center;gap:6px}
.dac-bulk-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:5px 11px;cursor:pointer}
.dac-bulk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-bulk-btn.dac-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent}
.dac-bulk-btn.dac-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-bulk-btn:disabled{opacity:.45;cursor:default}
.dac-group{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.dac-group-head{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px}
.dac-group-left{display:flex;align-items:center;gap:8px;min-width:0}
.dac-group-toggle{display:inline-flex;align-items:center;gap:7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;padding:3px 6px;margin:-3px -6px;border-radius:7px}
.dac-group-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-chev{display:inline-flex;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg);transition:transform .15s}
.dac-chev.open{transform:rotate(0)}
.dac-group-name{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dac-group-side{display:flex;align-items:center;gap:4px}
.dac-count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-right:2px}
.dac-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .15s,color .15s;padding:0}
.dac-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dac-iconbtn:disabled{opacity:.45;cursor:default}
.dac-iconbtn.dac-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-menu{position:absolute;right:0;top:30px;z-index:40;min-width:150px;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--dsw-alias-border-inverted);border-radius:10px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3)}
.dac-menu-item{border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;padding:7px 10px;cursor:pointer}
.dac-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-menu-item.dac-danger{color:var(--dsw-alias-state-error-primary)}
.dac-menu-item.dac-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-list{display:flex;flex-direction:column;gap:8px}
.dac-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 16px;transition:border-color .15s,background .15s}
.dac-row:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-row.dac-selected{border-color:color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 45%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 6%,var(--dsw-alias-bg-layer-1))}
.dac-row-select{display:flex;align-items:center;gap:11px;min-width:0;flex:1}
.dac-row-main{min-width:0;display:flex;flex-direction:column;gap:4px}
.dac-row-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dac-row-date{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dac-row-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.dac-unarchive{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;cursor:pointer;transition:background .15s,border-color .15s}
.dac-unarchive:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-unarchive:disabled{opacity:.45;cursor:default}
.dac-unarchive.dac-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dac-unarchive.dac-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-trash-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dac-trash-toolbar-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dac-trash-status{display:inline-flex;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:1px 8px}
.dac-trash-status-degraded,.dac-trash-status-purge-pending{color:var(--dsw-alias-state-error-primary)}
.dac-trash-meta{row-gap:4px}
.dac-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:56px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dac-center{display:flex;align-items:center;justify-content:center;gap:8px;padding:48px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dac-retry{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 12px;cursor:pointer}
.dac-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:8px 12px}
.dac-notice button{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0;display:inline-flex}
.dac-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:1200;display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-state-success-secondary);border-radius:999px;background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);font-size:13px;font-weight:500;line-height:20px;padding:7px 12px 7px 14px;box-shadow:var(--dsw-shadow-lv3);animation:dac-toast-in .28s cubic-bezier(.21,1.02,.55,1) both}
.dac-toast svg{flex:none}
.dac-toast button{border:none;background:transparent;color:inherit;opacity:.55;cursor:pointer;font:inherit;padding:2px;margin-left:2px;display:inline-flex;border-radius:999px}
.dac-toast button:hover{opacity:1;background:var(--dsw-alias-state-success-secondary)}
@keyframes dac-toast-in{from{opacity:0;transform:translateX(-50%) translateY(-10px) scale(.96)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
@media (prefers-reduced-motion:reduce){.dac-toast{animation:none}}
.dac-archive-notice{position:absolute;top:20px;left:50%;z-index:30;display:flex;align-items:center;gap:8px;width:max-content;max-width:calc(100% - 24px);min-height:42px;box-sizing:border-box;transform:translateX(-50%);border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:5px 8px 5px 12px;box-shadow:var(--dsw-shadow-lv3);animation:dac-archive-notice-in .2s cubic-bezier(.21,1.02,.55,1) both}
.dac-archive-notice-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-label-primary)}
.dac-archive-notice-title{min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:2px;font-size:14px;font-weight:600;line-height:20px}
.dac-archive-notice-action{height:28px;box-sizing:border-box;border:0;border-radius:9px;font:inherit;font-size:13px;font-weight:600;line-height:18px;padding:0 8px;white-space:nowrap;cursor:pointer}
.dac-archive-notice-view{background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16)));color:var(--dsw-alias-label-primary)}
.dac-archive-notice-view:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16)))}
.dac-archive-notice-undo{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}
.dac-archive-notice-undo:hover:not(:disabled){opacity:.86}
.dac-archive-notice-action:focus-visible,.dac-archive-notice-close:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#6e6ef7);outline-offset:2px}
.dac-archive-notice-action:disabled{opacity:.52;cursor:default}
.dac-archive-notice-close{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);padding:0;cursor:pointer}
.dac-archive-notice-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dac-archive-notice-error{border-color:var(--dsw-alias-state-error-primary)}
@keyframes dac-archive-notice-in{from{opacity:0;transform:translateX(-50%) translateY(-8px) scale(.98)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
@media (prefers-reduced-motion:reduce){.dac-archive-notice{animation:none}}
.dac-confirm-overlay{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)}
.dac-confirm{width:min(400px,calc(100vw - 64px));display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-inverted);border-radius:16px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);padding:20px;outline:none}
.dac-confirm:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-interactive-primary,#6e6ef7),var(--dsw-shadow-lv3)}
.dac-confirm-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}
.dac-confirm-body{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}
.dac-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dac-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;cursor:pointer}
.dac-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-btn-danger{border:1px solid var(--dsw-alias-state-error-primary);border-radius:9px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;cursor:pointer}
.dac-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dac-btn-danger:disabled{opacity:.5;cursor:default}
.dac-spin{display:inline-block;width:14px;height:14px;border:2px solid var(--dsw-alias-label-tertiary);border-top-color:transparent;border-radius:50%;animation:dac-rotate .8s linear infinite}
@keyframes dac-rotate{to{transform:rotate(360deg)}}
.dac-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:-6px}
.dac-summary-sep{color:var(--dsw-alias-label-tertiary)}
.dac-summary-warn{color:var(--dsw-alias-state-error-primary)}
.dac-warn{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:8px 12px}
.dac-row-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dac-chip{display:inline-flex;align-items:center;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:1px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dac-chip-more{color:var(--dsw-alias-label-tertiary)}
.dac-row-size{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:none}
.dac-row-snippet{max-width:680px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
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
.dac-preview-tool,.dac-preview-system{align-items:stretch;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}
.dac-preview-meta{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-preview-plain{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dac-preview-disclosure{color:var(--dsw-alias-label-secondary)}
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
.dac-import-row{display:flex;align-items:flex-start;gap:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px;cursor:pointer}
.dac-import-row.dac-import-conflict{opacity:.58;cursor:default}
.dac-import-main{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.dac-context-note{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:9px 12px}
.dac-policy-note{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-insights-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.dac-insights-card{display:flex;align-items:center;flex-direction:column;gap:5px;text-align:center;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px}.dac-insights-card span{color:var(--dsw-alias-label-tertiary);font-size:12px}.dac-insights-card strong{color:var(--dsw-alias-label-primary);font-size:18px}.dac-policy{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px}.dac-policy label{display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px}.dac-policy input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:7px 9px}.dac-policy-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px}.dac-retention-dialog{width:min(620px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 48px))}.dac-retention-list{display:flex;flex-direction:column;gap:8px;overflow:auto}.dac-retention-row{display:flex;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px}.dac-retention-row span{display:flex;flex-direction:column}.dac-retention-row small{color:var(--dsw-alias-label-tertiary)}.dac-retention-row.dac-danger strong{color:var(--dsw-alias-state-error-primary)}
.dac-lineage-toolbar{display:block;min-width:0}
.dac-lineage-filter-row{display:flex;flex-direction:column;gap:8px;min-width:0}
.dac-lineage-filter-row .dac-search{min-width:0}
.dac-lineage-filter-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;flex-wrap:wrap}
.dac-lineage-filter-actions .dac-select-wrap{flex:0 1 160px;min-width:140px}
.dac-lineage-toolbar-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none}
.dac-lineage-fold-actions{display:inline-flex;align-items:center;gap:4px}
.dac-lineage-fold{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:5px 8px;cursor:pointer}
.dac-lineage-fold:hover:not(:disabled),.dac-lineage-fold:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dac-lineage-fold:disabled{opacity:.42;cursor:default}
.dac-chev.collapse{transform:rotate(180deg)}
.dac-lineage-list-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dac-lineage-list-head-copy{display:flex;align-items:center;gap:8px;min-width:0}.dac-lineage-list-head small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-lineage-tree{display:flex;flex-direction:column;gap:8px;max-height:min(620px,calc(100vh - 300px));min-height:120px;overflow-y:auto;overflow-x:hidden;background:transparent;padding:1px 2px 2px}
.dac-lineage-node{display:flex;align-items:stretch;width:100%;min-width:0}
.dac-lineage-rail{display:flex;align-items:stretch;flex:none}
.dac-lineage-guide,.dac-lineage-junction,.dac-lineage-guide-overflow{position:relative;width:18px;min-height:68px;flex:none}
.dac-lineage-guide-continuing::before{content:"";position:absolute;left:10px;top:0;bottom:0;border-left:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-lineage-guide-overflow{display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dac-lineage-junction-child{width:36px}
.dac-lineage-junction-child::before{content:"";position:absolute;left:10px;top:0;bottom:0;border-left:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-lineage-junction-child::after{content:"";position:absolute;left:10px;right:9px;top:50%;border-top:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-lineage-junction-last::before{bottom:50%}
.dac-lineage-toggle{position:absolute;z-index:1;left:1px;top:50%;display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;transform:translateY(-50%);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer}
.dac-lineage-junction-child>.dac-lineage-toggle{left:17px}
.dac-lineage-toggle:hover:not(:disabled),.dac-lineage-toggle:focus-visible{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dac-lineage-toggle:disabled{opacity:.48;cursor:default}
.dac-lineage-dot{position:absolute;z-index:1;left:7px;top:50%;width:7px;height:7px;box-sizing:border-box;transform:translateY(-50%);border:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));border-radius:50%;background:var(--dsw-alias-bg-layer-1)}
.dac-lineage-junction-child>.dac-lineage-dot{left:23px}
.dac-lineage-context{display:flex;align-items:center;gap:10px;min-width:0;flex:1;align-self:center;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:7px 10px}
.dac-lineage-context-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;line-height:18px}
.dac-lineage-context small{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.dac-lineage-row{position:relative;display:flex;align-items:stretch;flex-direction:column;gap:7px;box-sizing:border-box;width:auto;min-width:0;max-width:none;flex:1;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:11px 12px 13px;box-shadow:0 1px 2px rgba(15,17,21,.03)}
.dac-lineage-row:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.05))}
.dac-lineage-row button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.dac-lineage-row strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dac-lineage-row small{margin-left:auto;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis}.dac-lineage-missing{color:var(--dsw-alias-state-error-primary)}
.dac-import-main span{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dac-import-main small{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.dac-snapshot-row .dac-row-main{gap:3px}.dac-snapshot-id{white-space:normal;overflow-wrap:anywhere;word-break:break-word}.dac-lineage-row>strong{box-sizing:border-box;min-width:0;width:100%;padding-right:74px;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}.dac-lineage-row>.dac-trash-status{position:absolute;top:11px;right:12px}.dac-lineage-archived{background:var(--dsw-alias-state-success-tertiary,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)));color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}.dac-lineage-trash{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)));color:var(--dsw-alias-state-error-primary)}.dac-lineage-detail{display:flex;align-items:stretch;gap:14px;width:100%;min-width:0}.dac-lineage-detail-copy{display:flex;flex:1 1 auto;min-width:0;flex-direction:column;gap:2px}.dac-lineage-detail-copy small{margin-left:0}.dac-lineage-source-context{color:var(--dsw-alias-label-secondary);font-weight:500}.dac-lineage-source{color:var(--dsw-alias-label-secondary)}.dac-lineage-meta{color:var(--dsw-alias-label-tertiary)}.dac-lineage-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-width:0}.dac-lineage-row .dac-lineage-created{margin-left:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dac-lineage-id-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;flex-wrap:wrap}.dac-lineage-id{margin-left:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}.dac-lineage-copy{flex:none;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-interactive-primary,var(--dsw-alias-label-secondary));font:inherit;font-size:11px;line-height:16px;padding:3px 6px;cursor:pointer}.dac-lineage-copy:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}.dac-lineage-row>.dac-lineage-toggle{position:absolute;z-index:2;left:50%;bottom:-9px;display:inline-flex;align-items:center;justify-content:center;width:28px;height:18px;transform:translateX(-50%);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;box-shadow:0 1px 2px rgba(15,17,21,.04)}.dac-lineage-row>.dac-lineage-toggle:hover:not(:disabled),.dac-lineage-row>.dac-lineage-toggle:focus-visible{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}.dac-lineage-row>.dac-lineage-toggle:disabled{opacity:.48;cursor:default}.dac-lineage-scopebar{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;padding:9px 11px}
.dac-lineage-row>.dac-lineage-toggle{width:24px;height:18px;border:0;background:transparent;box-shadow:none;color:var(--dsw-alias-label-tertiary)}.dac-lineage-row>.dac-lineage-toggle:hover:not(:disabled){border:0;background:transparent;color:var(--dsw-alias-label-primary)}.dac-lineage-row>.dac-lineage-toggle:focus-visible{border:0;outline:2px solid color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 45%,transparent);outline-offset:2px;background:transparent;color:var(--dsw-alias-label-primary)}.dac-lineage-row-foldable{cursor:pointer}.dac-lineage-row-foldable:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 35%,transparent);outline-offset:2px}
.dac-lineage-id-actions{display:flex;flex:0 0 auto;flex-direction:column;align-items:flex-end;justify-content:flex-start;gap:2px;min-width:0}.dac-lineage-id-row{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}.dac-lineage-id-actions>.dac-lineage-toggle{position:static;left:auto;top:auto;bottom:auto;display:inline-flex;width:24px;height:18px;transform:none;border:0;border-radius:999px;background:transparent;box-shadow:none;color:var(--dsw-alias-label-tertiary);padding:0}.dac-lineage-id-actions>.dac-lineage-toggle:hover:not(:disabled){border:0;background:transparent;color:var(--dsw-alias-label-primary)}.dac-lineage-id-actions>.dac-lineage-toggle:focus-visible{border:0;outline:2px solid color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 45%,transparent);outline-offset:2px;background:transparent;color:var(--dsw-alias-label-primary)}
.dac-lineage-id-actions{flex-direction:row;align-items:center;justify-content:flex-end;gap:8px}.dac-lineage-toggle-row{display:flex;align-items:center;justify-content:center;width:100%;min-height:18px;margin-top:1px}.dac-lineage-toggle-row>.dac-lineage-toggle{position:static;left:auto;top:auto;bottom:auto;display:inline-flex;width:24px;height:18px;transform:none;border:0;border-radius:999px;background:transparent;box-shadow:none;color:var(--dsw-alias-label-tertiary);padding:0}.dac-lineage-toggle-row>.dac-lineage-toggle:hover:not(:disabled){border:0;background:transparent;color:var(--dsw-alias-label-primary)}.dac-lineage-toggle-row>.dac-lineage-toggle:focus-visible{border:0;outline:2px solid color-mix(in srgb,var(--dsw-alias-interactive-primary,#6e6ef7) 45%,transparent);outline-offset:2px;background:transparent;color:var(--dsw-alias-label-primary)}
.dac-insights-card{min-height:98px;box-sizing:border-box}.dac-insights-open{align-self:flex-start;margin-top:auto;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:2px 5px;cursor:pointer}.dac-insights-open:hover,.dac-insights-open:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}.dac-insights-open:disabled{cursor:default;opacity:.45;background:transparent}.dac-storage-dialog{width:min(720px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 48px))}.dac-storage-detail-list{display:flex;flex-direction:column;gap:8px;max-height:min(460px,calc(100vh - 250px));overflow:auto}.dac-storage-detail-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:normal;overflow-wrap:anywhere}.dac-storage-dialog .dac-search{margin:0}
.dac-import-result{display:flex;gap:14px;color:var(--dsw-alias-state-success-primary);font-size:13px;line-height:20px}
.dac-field-label{display:block;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dac-meta-input,.dac-meta-note{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:7px 10px;outline:none}
.dac-meta-input:focus,.dac-meta-note:focus{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-tag-editor{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-height:38px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);padding:5px 7px;transition:border-color .15s}
.dac-tag-editor:focus-within{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-tag-editor .dac-meta-input{flex:1 1 140px;min-width:120px;width:auto;border:0;border-radius:0;background:transparent;padding:2px 3px}
.dac-tag-editor .dac-chip{gap:4px;border:0;cursor:pointer;font-family:inherit;padding:2px 7px}
.dac-tag-editor .dac-chip span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dac-tag-editor .dac-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary)}
.dac-tag-editor .dac-chip svg{flex:none}
.dac-meta-note{resize:vertical;min-height:72px}
.dac-meta-limits{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-btn-primary{border:1px solid var(--dsw-alias-interactive-primary,#6e6ef7);border-radius:9px;background:var(--dsw-alias-interactive-primary,#6e6ef7);color:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;cursor:pointer}
.dac-btn-primary:hover:not(:disabled){opacity:.9}
.dac-btn-primary:disabled{opacity:.5;cursor:default}
@media (max-width:640px){[role="dialog"][data-dac-section-active="1"]>nav{display:none}[role="dialog"][data-dac-section-active="1"]>nav+div{width:100%;min-width:0}.dac-head{align-items:flex-start;flex-wrap:wrap}.dac-head-actions{width:100%;justify-content:flex-start}.dac-tabs{width:100%}.dac-action-trigger{padding:5px 9px}.dac-action-menu{left:0;right:auto;max-width:calc(100vw - 32px)}.dac-action-wrap:last-child .dac-action-menu{left:auto;right:0}.dac-selection-controls{width:100%;justify-content:space-between}.dac-bulkbar{align-items:flex-start;flex-direction:column}.dac-bulk-actions{width:100%;flex-wrap:wrap}.dac-trash-toolbar{align-items:flex-start;flex-direction:column}.dac-trash-toolbar-actions{width:100%}.dac-row{align-items:flex-start;flex-wrap:wrap}.dac-row-actions{gap:4px;flex-wrap:wrap}.dac-trash-actions{width:100%;justify-content:flex-end}.dac-unarchive{padding:5px 10px}.dac-summary{gap:6px}.dac-row-meta{gap:4px}.dac-search-state{display:none}.dac-preview-dialog{width:calc(100vw - 20px);height:calc(100vh - 20px)}.dac-preview-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.dac-preview-feed{padding:10px}.dac-preview-rail{flex-direction:row;overflow-x:auto;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 5px}.dac-preview-rail button{flex:none}}
@media (max-width:640px){.dac-lineage-filter-actions{width:100%;justify-content:flex-end}.dac-lineage-filter-actions .dac-select-wrap{flex:0 1 calc(50% - 4px);min-width:132px}.dac-lineage-list-head{align-items:flex-start;flex-direction:column}.dac-lineage-fold-actions{width:100%}.dac-lineage-fold{flex:1;justify-content:center}.dac-lineage-tree{max-height:min(560px,calc(100vh - 300px))}.dac-lineage-guide,.dac-lineage-junction,.dac-lineage-guide-overflow{width:14px}.dac-lineage-junction-child{width:28px}.dac-lineage-junction-child>.dac-lineage-toggle{left:9px}.dac-lineage-junction-child>.dac-lineage-dot{left:15px}.dac-lineage-context{align-items:flex-start;flex-direction:column;gap:2px}.dac-lineage-context small{margin-left:0;white-space:normal}.dac-lineage-detail{align-items:flex-start;flex-direction:column;gap:8px}.dac-lineage-id-actions{width:100%;justify-content:flex-end}}
@media (max-width:640px){.dac-archive-notice{top:8px;left:50%;right:auto;width:max-content;max-width:calc(100% - 16px);min-height:42px;gap:6px;transform:translateX(-50%);padding:5px 7px 5px 10px;animation-name:dac-archive-notice-in}.dac-archive-notice-title{max-width:180px;font-size:13px;line-height:18px}.dac-archive-notice-action{height:28px;border-radius:9px;font-size:12px;padding:0 8px}.dac-archive-notice-close{width:24px;height:24px}}
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
		const NAV_LABELS = ["会话档案", "Session Archive"];
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
						svg.setAttribute("stroke-width", "1.5");
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
				metadataStatus: body.metadataStatus === "unavailable" ? "unavailable" : "ready",
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

		async function fetchInsights(signal) {
			const res = await fetch(`${API_BASE}/insights`, { cache: "no-store", signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		}

		async function saveRetentionPolicy(policy) {
			return post("/retention/policy", policy);
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

		async function emptyTrash() {
			return post("/trash/empty", {});
		}

		async function fetchArchivePreview(sessionId, offset = 0, limit = 50, signal, scope = "archive") {
			const body = { sessionId, offset, limit };
			if (scope === "trash") body.scope = "trash";
			return post("/preview", body, signal);
		}

		async function fetchArchiveImage(sessionId, attachmentId, signal, scope = "archive") {
			const body = { sessionId, attachmentId };
			if (scope === "trash") body.scope = "trash";
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

		async function fetchArchiveSearch(query, limit = 50) {
			return post("/search", { query, limit });
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

			function submitExport(sessionIds) {
				if (typeof document === "undefined") return false;
				const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
					.filter((id) => typeof id === "string" && id !== ""))];
				if (ids.length === 0) return false;
				const form = document.createElement("form");
				form.method = "POST";
				form.action = `${API_BASE}/export`;
				form.enctype = "application/x-www-form-urlencoded";
				form.hidden = true;
				const input = document.createElement("input");
				input.type = "hidden";
				input.name = "sessionIds";
				input.value = JSON.stringify(ids);
				form.appendChild(input);
				document.body.appendChild(form);
				form.submit();
				setTimeout(() => form.remove(), 0);
				return true;
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
		function IconSearch({ size = 15 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("circle", { cx: 11, cy: 11, r: 7 }), (0, jsx.jsx)("path", { d: "m20 20-3.8-3.8" })] });
		}
		function IconEye({ size = 15 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("path", { d: "M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" }), (0, jsx.jsx)("circle", { cx: 12, cy: 12, r: 2.5 })] });
		}
		function IconFolder({ size = 15 }) {
			return (0, jsx.jsx)("svg", { ...svgProps(size), children: (0, jsx.jsx)("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }) });
		}
		function IconTrash({ size = 14 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), children: [(0, jsx.jsx)("path", { d: "M4 7h16" }), (0, jsx.jsx)("path", { d: "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }), (0, jsx.jsx)("path", { d: "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" }), (0, jsx.jsx)("path", { d: "M10 11v6M14 11v6" })] });
		}
		function IconDots({ size = 15 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), fill: "currentColor", stroke: "none", children: [(0, jsx.jsx)("circle", { cx: 5, cy: 12, r: 1.6 }), (0, jsx.jsx)("circle", { cx: 12, cy: 12, r: 1.6 }), (0, jsx.jsx)("circle", { cx: 19, cy: 12, r: 1.6 })] });
		}
		function IconChevron({ size = 13 }) {
			return (0, jsx.jsx)("svg", { ...svgProps(size), children: (0, jsx.jsx)("path", { d: "m6 9 6 6 6-6" }) });
		}
		function IconArchive({ size = 40 }) {
			return (0, jsx.jsxs)("svg", { ...svgProps(size), strokeWidth: 1.2, children: [(0, jsx.jsx)("rect", { x: 3, y: 4, width: 18, height: 5, rx: 1 }), (0, jsx.jsx)("path", { d: "M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" }), (0, jsx.jsx)("path", { d: "M10 13h4" })] });
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
		function ArchiveNoticeOverlay({ controller, t }) {
			const [snapshot, setSnapshot] = _react.useState(controller.getSnapshot());
			_react.useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
			if (snapshot === null) return null;
			const busy = snapshot.status === "undoing" || snapshot.status === "viewing";
			const title = snapshot.status === "undo-error"
				? t("archiveNotice.undoError")
				: snapshot.status === "view-error" ? t("archiveNotice.viewError") : t("archiveNotice.title");
			const viewLabel = snapshot.status === "viewing"
				? t("archiveNotice.opening")
				: snapshot.status === "view-error" ? t("archiveNotice.retry") : t("archiveNotice.view");
			const undoLabel = snapshot.status === "undoing"
				? t("archiveNotice.undoing")
				: snapshot.status === "undo-error" ? t("archiveNotice.retry") : t("archiveNotice.undo");
			return (0, jsx.jsxs)("div", {
				className: `dac-archive-notice${snapshot.status.endsWith("-error") ? " dac-archive-notice-error" : ""}`,
				role: "region",
				"aria-label": title,
				"aria-live": "polite",
				"aria-busy": busy,
				onMouseEnter: () => controller.pause("pointer"),
				onMouseLeave: () => controller.resume("pointer"),
				onFocusCapture: () => controller.pause("focus"),
				onBlurCapture: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) controller.resume("focus"); },
				children: [
					(0, jsx.jsx)("span", { className: "dac-archive-notice-icon", "aria-hidden": "true", children: (0, jsx.jsx)(IconArchive, { size: 14 }) }),
					(0, jsx.jsx)("strong", { className: "dac-archive-notice-title", children: title }),
					(0, jsx.jsx)("button", { type: "button", className: "dac-archive-notice-action dac-archive-notice-view", disabled: busy, onClick: () => { void controller.view(); }, children: viewLabel }),
					(0, jsx.jsx)("button", { type: "button", className: "dac-archive-notice-action dac-archive-notice-undo", disabled: busy, onClick: () => { void controller.undo(); }, children: undoLabel }),
					(0, jsx.jsx)("button", { type: "button", className: "dac-archive-notice-close", "aria-label": t("archiveNotice.close"), onClick: () => controller.dismiss(), children: (0, jsx.jsx)(IconClose, { size: 14 }) })
				]
			});
		}

		function Select({ value, onChange, options, ariaLabel, fill = false }) {
			return (0, jsx.jsxs)("span", {
				className: `dac-select-wrap${fill ? " dac-select-wrap-fill" : ""}`,
				children: [
					(0, jsx.jsx)("select", {
						className: `dac-select${fill ? " dac-select-fill" : ""}`,
						value,
						"aria-label": ariaLabel,
						onChange: (e) => onChange(e.target.value),
						children: options.map((o) => (0, jsx.jsx)("option", { value: o.value, children: o.label }, o.value))
					}),
					(0, jsx.jsx)("span", { className: "dac-chevron", children: (0, jsx.jsx)(IconChevron, {}) })
				]
			});
		}

		function SelectionCheckbox({ checked, indeterminate = false, disabled = false, ariaLabel, onChange }) {
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
				onChange: (event) => onChange(event.target.checked)
			});
		}

		function ConfirmDialog({ title, body, confirmLabel, cancelLabel, busy, returnFocus, fallbackFocusRef, onConfirm, onCancel }) {
			const dialogRef = _react.useRef(null);
			const cancelRef = _react.useRef(null);
			const containEscape = (event) => {
				if (event.key !== "Escape") return;
				event.preventDefault?.();
				event.stopPropagation?.();
				event.nativeEvent?.stopImmediatePropagation?.();
				onCancel();
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
						onCancel();
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
			}, [onCancel, returnFocus, fallbackFocusRef]);
			return (0, jsx.jsx)("div", {
				className: "dac-confirm-overlay",
				onClick: onCancel,
				children: (0, jsx.jsxs)("div", {
					ref: dialogRef,
					className: "dac-confirm",
					role: "alertdialog",
					"aria-modal": "true",
					"aria-labelledby": "dac-confirm-title",
					"aria-describedby": "dac-confirm-body",
					tabIndex: -1,
					onKeyDown: containEscape,
					onClick: (e) => e.stopPropagation(),
					children: [
						(0, jsx.jsx)("div", { id: "dac-confirm-title", className: "dac-confirm-title", children: title }),
						(0, jsx.jsx)("div", { id: "dac-confirm-body", className: "dac-confirm-body", children: body }),
						(0, jsx.jsxs)("div", {
							className: "dac-confirm-actions",
							children: [
								(0, jsx.jsx)("button", { ref: cancelRef, type: "button", className: "dac-btn", onClick: onCancel, children: cancelLabel }),
								(0, jsx.jsx)("button", { type: "button", className: "dac-btn-danger", disabled: busy, onClick: onConfirm, children: confirmLabel })
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
					onCancel();
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
				const focusIsInside = typeof dialog.contains === "function" ? dialog.contains(active) : focusable.includes(active);
				if (e.shiftKey && (active === first || !focusIsInside)) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && (active === last || !focusIsInside)) {
					e.preventDefault();
					first.focus();
				}
			};
			_react.useEffect(() => {
				const previousFocus = returnFocus ?? document.activeElement;
				const dialog = dialogRef.current;
				(tagInputRef.current ?? dialog)?.focus?.();
				return () => {
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
				onClick: onCancel,
				children: (0, jsx.jsxs)("div", {
					ref: dialogRef,
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
							...tags.map((tag) => (0, jsx.jsxs)("button", { type: "button", className: "dac-chip", "aria-label": removeTagLabel(t, tag), onClick: () => setTags((current) => current.filter((value) => value !== tag)), children: [(0, jsx.jsx)("span", { children: tag }), (0, jsx.jsx)(IconClose, { size: 10 })] }, tag)),
							(0, jsx.jsx)("input", {
								id: "dac-meta-tags",
								ref: tagInputRef,
								type: "text",
								className: "dac-meta-input",
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
								(0, jsx.jsx)("button", { type: "button", className: "dac-btn", onClick: onCancel, children: t("confirm.cancel") }),
								(0, jsx.jsx)("button", { type: "button", className: "dac-btn-primary", disabled: busy || overTags || overNote, onClick: () => onSave(savedTags, note.trim()), children: t("meta.save") })
							]
						})
					]
				})
			});
		}

			function importWarningText(t, warning) {
				if (warning === "workspace-unresolved") return t("import.workspaceWarning");
				if (warning === "attachment-references" || warning === "attachments-not-included") return t("import.attachmentWarning");
				return warning;
			}

				function ImportDialog({ preview, t, busy, onToggle, onSelectAll, onClear, onConfirm, onCancel }) {
				const dialogRef = _react.useRef(null);
				const cancelRef = _react.useRef(null);
				const sessions = Array.isArray(preview?.sessions) ? preview.sessions : [];
				const selected = new Set(preview?.selectedIds ?? []);
				const eligible = sessions.filter((session) => session.conflict !== true);
				const allSelected = eligible.length > 0 && eligible.every((session) => selected.has(session.id));
				_react.useEffect(() => {
					(cancelRef.current ?? dialogRef.current)?.focus?.();
					const onKey = (event) => {
						if (event.key === "Escape") { event.preventDefault?.(); onCancel(); }
					};
					document.addEventListener("keydown", onKey);
					return () => document.removeEventListener("keydown", onKey);
				}, [onCancel]);
				const result = preview?.result;
				const generator = preview?.package?.generator;
				const generatorName = typeof generator === "string" ? generator : generator?.name ?? "dsh-archived-chats";
				const generatorVersion = typeof generator === "object" ? generator?.version : undefined;
				const packageVersion = preview?.package?.version ?? "1";
				const packageLabel = generatorVersion
					? `${generatorName} v${generatorVersion} · format v${packageVersion}`
					: `${generatorName} · v${packageVersion}`;
				return (0, jsx.jsx)("div", {
					className: "dac-confirm-overlay",
					onClick: onCancel,
					children: (0, jsx.jsxs)("div", {
						ref: dialogRef,
						className: "dac-confirm dac-import-dialog",
						role: "dialog",
						"aria-modal": "true",
						"aria-labelledby": "dac-import-title",
						"aria-describedby": "dac-import-description",
						tabIndex: -1,
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
								(0, jsx.jsx)("span", { children: `${t("import.restored")}: ${(result.restored ?? []).length}` }),
								(0, jsx.jsx)("span", { children: `${t("import.skipped")}: ${(result.skipped ?? []).length}` }),
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
							(0, jsx.jsxs)("div", { className: "dac-confirm-actions", children: [
								(0, jsx.jsx)("button", { ref: cancelRef, type: "button", className: "dac-btn", onClick: onCancel, children: t("import.cancel") }),
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
						codeLabels: { copyLabel: t("preview.copy"), copiedLabel: t("preview.copied") },
					});
				}

				function PreviewReasoning({ text, t, primitives = previewPrimitives }) {
					const DisclosureRow = primitives.DisclosureRow;
					const [open, setOpen] = _react.useState(false);
					if (DisclosureRow === null) return (0, jsx.jsxs)("details", {
						className: "dac-preview-disclosure",
						children: [(0, jsx.jsx)("summary", { children: t("preview.reasoning") }), (0, jsx.jsx)("div", { className: "dac-preview-reasoning-body", children: text })],
					});
					return (0, jsx.jsx)(DisclosureRow, {
						title: t("preview.reasoning"),
						open,
						expandable: true,
						expandOnRowClick: true,
						onToggle: () => setOpen((value) => !value),
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
					const [open, setOpen] = _react.useState(false);
					const DisclosureRow = previewPrimitives.DisclosureRow;
					const JsonBlock = previewPrimitives.JsonBlock;
					const argumentsText = typeof segment.argumentsText === "string" ? segment.argumentsText : segment.text || "";
					const body = (0, jsx.jsxs)("div", { className: `dac-preview-tool-body${segment.result?.isError ? " dac-error" : ""}`, children: [
						JsonBlock !== null
							? (0, jsx.jsx)(JsonBlock, { label: t("preview.toolArguments"), payload: previewJsonValue(argumentsText) })
							: (0, jsx.jsx)("pre", { className: "dac-preview-code", children: argumentsText }),
						segment.result !== undefined && (0, jsx.jsx)("pre", { className: `dac-preview-tool-result${segment.result.isError ? " dac-error" : ""}`, children: segment.result.text || "" }),
					] });
					if (DisclosureRow === null) return (0, jsx.jsxs)("details", { className: "dac-preview-disclosure", children: [
						(0, jsx.jsx)("summary", { children: segment.name || segment.label || t("preview.toolCall") }),
						body,
					] });
					return (0, jsx.jsx)(DisclosureRow, {
						title: segment.name || segment.label || t("preview.toolCall"),
						open,
						expandable: true,
						expandOnRowClick: true,
						onToggle: () => setOpen((value) => !value),
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

				function PreviewSegment({ segment, role, t }) {
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

				function PreviewMessage({ node, sessionId, t, bindNode, scope = "archive" }) {
					const role = ["user", "assistant", "tool"].includes(node?.role) ? node.role : "system";
					const segments = groupPreviewSegments(node?.segments).map((group, index) => group.kind === "images"
						? (0, jsx.jsx)("div", {
							className: "dac-preview-images",
							"data-align": role === "user" ? "end" : "start",
							children: group.images.map((segment, imageIndex) => (0, jsx.jsx)(PreviewImage, { sessionId, attachment: segment.attachment, t, scope }, `${node.key}:${index}:${imageIndex}`)),
						}, `${node.key}:images:${index}`)
						: (0, jsx.jsx)(PreviewSegment, { segment: group.segment, role, t }, `${node.key}:${index}`));
					return (0, jsx.jsxs)("article", {
						ref: bindNode,
						id: `dac-preview-node-${node.key}`,
						"data-preview-key": node.key,
						"data-preview-role": role,
						"aria-label": previewRoleLabel(t, role),
						tabIndex: -1,
						className: `dac-preview-node dac-preview-${role}`,
						children: [
							role === "user" ? (0, jsx.jsx)("div", { className: "dac-preview-user-bubble", children: segments }) : segments,
							["user", "assistant"].includes(role)
								? (0, jsx.jsx)(PreviewActions, { node, t })
								: (0, jsx.jsx)("div", { className: "dac-preview-meta", children: formatDate(t, node.time) }),
						],
					});
				}

				function buildPreviewNodes(messages) {
					const results = new Map();
					const source = Array.isArray(messages) ? messages : [];
					for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
						const message = source[messageIndex];
						const sourceSegments = Array.isArray(message?.segments) ? message.segments : [];
						for (let segmentIndex = 0; segmentIndex < sourceSegments.length; segmentIndex += 1) {
							const segment = sourceSegments[segmentIndex];
							if (segment?.kind !== "tool-result" || typeof segment.toolCallId !== "string") continue;
							const queue = results.get(segment.toolCallId) ?? [];
							queue.push({ messageIndex, segmentIndex, segment });
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
									&& !consumed.has(`${entry.messageIndex}:${entry.segmentIndex}`));
								if (match !== undefined) {
									consumed.add(`${match.messageIndex}:${match.segmentIndex}`);
									segments.push({ ...segment, result: match.segment });
									continue;
								}
							}
							segments.push(segment);
						}
						if (segments.length > 0) nodes.push({ ...message, key: `${message.seq}:${messageIndex}`, segments });
					}
					return nodes;
				}

				function previewCopyText(node) {
					return (Array.isArray(node?.segments) ? node.segments : []).flatMap((segment) => {
						if (segment.kind === "tool-call") return [segment.name, segment.argumentsText, segment.result?.text];
						return [segment.text];
					}).filter((value) => typeof value === "string" && value !== "").join("\n\n");
				}

				function PreviewActions({ node, t }) {
					const [copied, setCopied] = _react.useState(false);
					const copy = async () => {
						const text = previewCopyText(node);
						const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
						if (text === "" || typeof clipboard?.writeText !== "function") return;
						await clipboard.writeText(text);
						setCopied(true);
					};
					return (0, jsx.jsxs)("div", { className: "dac-preview-actions", children: [
						(0, jsx.jsx)("time", { dateTime: Number.isFinite(node.time) ? new Date(node.time).toISOString() : undefined, children: formatDate(t, node.time) }),
						(0, jsx.jsx)("button", { type: "button", onClick: copy, "aria-label": copied ? t("preview.copied") : t("preview.copy"), children: copied ? t("preview.copied") : t("preview.copy") }),
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

				function PreviewDialog({ preview, t, busy, returnFocus, fallbackFocusRef, onLoadMore, onCancel }) {
					const dialogRef = _react.useRef(null);
					const closeRef = _react.useRef(null);
					const messages = Array.isArray(preview?.messages) ? preview.messages : [];
					const nodes = _react.useMemo(() => buildPreviewNodes(messages), [messages]);
					const feedRef = _react.useRef(null);
					const { activeKey, bindNode } = usePreviewRail(nodes, feedRef);
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
						const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
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
										(0, jsx.jsx)("span", { children: t("preview.readOnly") })
									] }),
									(0, jsx.jsx)("button", { ref: closeRef, type: "button", className: "dac-iconbtn", "aria-label": t("preview.close"), onClick: onCancel, children: (0, jsx.jsx)(IconClose, { size: 16 }) })
								] }),
								preview?.status === "loading" && (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { className: "dac-spin" }), (0, jsx.jsx)("span", { children: t("preview.loading") })] }),
								preview?.status === "error" && (0, jsx.jsx)("div", { className: "dac-center", children: preview.error || t("preview.error") }),
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
											...nodes.map((node) => (0, jsx.jsx)(PreviewMessage, { node, sessionId: preview?.session?.id, t, bindNode: bindNode(node.key), scope: preview?.scope ?? "archive" }, node.key)),
										preview.nextOffset !== null && (0, jsx.jsx)("button", { type: "button", className: "dac-btn dac-preview-more", disabled: busy, onClick: onLoadMore, children: busy ? t("preview.loading") : t("preview.more") })
										] })
									] })
								] })
							]
						})
					});
				}

				function TrashGroupSection({ group, t, collapsed, onToggleCollapsed, selectionMode, selected, busy, mutationsAvailable, onToggleSelected, onRestore, onPurge, onPreview }) {
			const ids = group.selectionIds.filter((id) => group.items.find((row) => row.sessionId === id)?.state !== "purge-pending");
			const selectedInGroup = ids.filter((id) => selected.has(id)).length;
			const allSelected = ids.length > 0 && selectedInGroup === ids.length;
			const someSelected = selectedInGroup > 0 && !allSelected;
			return (0, jsx.jsxs)("section", { className: "dac-group dac-trash-group", children: [
				(0, jsx.jsxs)("div", { className: "dac-group-head", children: [
					(0, jsx.jsxs)("div", { className: "dac-group-left", children: [
						selectionMode && (0, jsx.jsx)(SelectionCheckbox, {
							checked: allSelected,
							indeterminate: someSelected,
							disabled: !mutationsAvailable || ids.length === 0 || ids.some((id) => busy[id] === true),
							ariaLabel: selectProjectLabel(t, group.title ?? t("group.noProject")),
							onChange: (checked) => onToggleSelected(ids, checked),
						}),
						(0, jsx.jsxs)("button", {
							type: "button",
							className: "dac-group-toggle",
							"aria-expanded": collapsed !== true,
							"aria-label": collapsed === true ? t("group.expand") : t("group.collapse"),
							onClick: () => onToggleCollapsed(group.key),
							children: [
								(0, jsx.jsx)("span", { className: collapsed === true ? "dac-chev" : "dac-chev open", children: (0, jsx.jsx)(IconChevron, {}) }),
								(0, jsx.jsx)(IconFolder, {}),
								(0, jsx.jsx)("span", { children: group.title ?? t("group.noProject") }),
							],
						}),
					] }),
					(0, jsx.jsx)("span", { className: "dac-count", children: chatsCount(t, group.items.length) }),
				] }),
				collapsed !== true && (0, jsx.jsx)("div", { className: "dac-list", children: group.items.map((row) => {
					const title = row.title || t("chat.untitled");
					const pending = row.state === "purge-pending";
					const rowBusy = busy[row.sessionId] === true;
					const trashedMs = typeof row.trashedAt === "string" ? Date.parse(row.trashedAt) : NaN;
					const attachments = Number.isInteger(row.snapshotAttachmentCount) ? row.snapshotAttachmentCount : 0;
					return (0, jsx.jsxs)("article", { className: `dac-row dac-trash-row${selectionMode && selected.has(row.sessionId) ? " dac-selected" : ""}`, children: [
						(0, jsx.jsxs)("div", { className: "dac-row-select", children: [
							selectionMode && (0, jsx.jsx)(SelectionCheckbox, {
								checked: selected.has(row.sessionId),
								disabled: !mutationsAvailable || pending || rowBusy,
								ariaLabel: `${t("trash.select")}: ${title}`,
								onChange: (checked) => onToggleSelected([row.sessionId], checked),
							}),
							(0, jsx.jsxs)("div", { className: "dac-row-main", children: [
								(0, jsx.jsx)("div", { className: "dac-row-title", children: title }),
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
							(0, jsx.jsx)("button", { type: "button", className: "dac-iconbtn", "aria-label": previewOpenLabel(t, title), disabled: rowBusy, onClick: () => onPreview(row), children: (0, jsx.jsx)(IconEye, {}) }),
							(0, jsx.jsx)("button", { type: "button", className: "dac-unarchive", "data-session-id": row.sessionId, disabled: !mutationsAvailable || pending || rowBusy, onClick: () => onRestore([row.sessionId]), children: t("trash.restore") }),
							(0, jsx.jsx)("button", { type: "button", className: "dac-unarchive dac-danger", "data-session-id": row.sessionId, disabled: !mutationsAvailable || pending || rowBusy, onClick: () => onPurge([row.sessionId]), children: t("trash.purge") }),
						] }),
					] }, row.sessionId);
				}) }),
			] }, group.key);
		}

				function GroupSection({ group, t, collapsed, onToggleCollapsed, menuOpen, onToggleMenu, onUnarchive, onDelete, onExport, onPreview, contentHits, busy, selectionMode, selected, onToggleSelected, stats, metadataStatus, onEditMetadata }) {
			const wrapRef = _react.useRef(null);
			_react.useEffect(() => {
				if (!menuOpen) return void 0;
				const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) onToggleMenu(null); };
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [menuOpen, onToggleMenu]);
			const ids = group.selectionIds;
			const selectedInGroup = ids.filter((id) => selected.has(id)).length;
			const allSelected = ids.length > 0 && selectedInGroup === ids.length;
			const someSelected = selectedInGroup > 0 && !allSelected;
			const groupBusy = ids.some((id) => busy[id] === true);
			return (0, jsx.jsxs)("div", {
				className: "dac-group",
				children: [
					(0, jsx.jsxs)("div", {
						className: "dac-group-head",
						ref: wrapRef,
						children: [
							(0, jsx.jsxs)("div", {
								className: "dac-group-left",
								children: [
									selectionMode && (0, jsx.jsx)(SelectionCheckbox, {
										checked: allSelected,
										indeterminate: someSelected,
										disabled: groupBusy,
										ariaLabel: selectProjectLabel(t, group.title),
										onChange: (checked) => onToggleSelected(ids, checked)
									}),
									(0, jsx.jsxs)("button", {
										type: "button",
										className: "dac-group-toggle",
										"aria-expanded": collapsed !== true,
										"aria-label": collapsed === true ? t("group.expand") : t("group.collapse"),
										onClick: () => onToggleCollapsed(group.key),
										children: [
											(0, jsx.jsx)("span", { className: collapsed === true ? "dac-chev" : "dac-chev open", children: (0, jsx.jsx)(IconChevron, {}) }),
											(0, jsx.jsx)(IconFolder, {}),
											(0, jsx.jsx)("span", { children: group.title })
										]
									})
								]
							}),
							(0, jsx.jsxs)("div", {
								className: "dac-group-side",
								children: [
									(0, jsx.jsx)("span", { className: "dac-count", children: chatsCount(t, group.items.length) }),
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-iconbtn",
										"aria-label": "…",
										onClick: () => onToggleMenu(menuOpen ? null : group.key),
										children: (0, jsx.jsx)(IconDots, {})
									})
								]
							}),
							menuOpen && (0, jsx.jsxs)("div", {
								className: "dac-menu",
								role: "menu",
								children: [
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-menu-item",
										role: "menuitem",
										onClick: () => { onToggleMenu(null); onUnarchive(ids); },
										children: t("menu.unarchiveAll")
									}),
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-menu-item dac-danger",
										role: "menuitem",
										onClick: () => { onToggleMenu(null); onDelete(ids, group.title); },
										children: t("menu.deleteAll")
									})
								]
							})
						]
					}),
					collapsed !== true && (0, jsx.jsx)("div", {
						className: "dac-list",
						children: group.items.map((session) => (0, jsx.jsxs)("div", {
							className: selectionMode && selected.has(session.id) ? "dac-row dac-selected" : "dac-row",
								children: [
									(0, jsx.jsxs)(selectionMode ? "label" : "div", {
										className: "dac-row-select",
										children: [
											selectionMode && (0, jsx.jsx)(SelectionCheckbox, {
												checked: selected.has(session.id),
												disabled: busy[session.id] === true,
												ariaLabel: selectChatLabel(t, session.title ?? t("chat.untitled")),
												onChange: (checked) => onToggleSelected([session.id], checked)
											}),
											(0, jsx.jsxs)("div", {
												className: "dac-row-main",
												children: [
													(0, jsx.jsx)("div", { className: "dac-row-title", children: session.title ?? t("chat.untitled") }),
													(0, jsx.jsx)("div", { className: "dac-row-date", children: formatDate(t, session.createdAt) }),
												(0, jsx.jsxs)("div", {
													className: "dac-row-meta",
														children: [
															...(Array.isArray(session.tags) ? session.tags.slice(0, 3) : []).map((tag) => (0, jsx.jsx)("span", { className: "dac-chip", children: tag }, tag)),
															Array.isArray(session.tags) && session.tags.length > 3 && (0, jsx.jsx)("span", { className: "dac-chip dac-chip-more", children: `+${session.tags.length - 3}` }),
														(0, jsx.jsx)("span", { className: "dac-row-size", children: rowSizeText(t, stats, session.id) })
													]
												}),
												contentHits?.get(session.id)?.matches?.[0]?.excerpt && (0, jsx.jsxs)("div", { className: "dac-row-snippet", children: [
													(0, jsx.jsx)("strong", { children: t("search.contentMatch") }),
													(0, jsx.jsx)("span", { children: contentHits.get(session.id).matches[0].excerpt })
												] })
											]
											})
										]
									}),
								(0, jsx.jsxs)("div", {
									className: "dac-row-actions",
								children: [
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-iconbtn",
										"aria-label": previewOpenLabel(t, session.title ?? t("chat.untitled")),
										disabled: busy[session.id] === true,
										onClick: () => onPreview(session),
										children: (0, jsx.jsx)(IconEye, {})
									}),
									(0, jsx.jsx)("button", {
											type: "button",
											className: "dac-iconbtn",
											"aria-label": t("tag.edit"),
											disabled: busy[session.id] === true || metadataStatus === "unavailable",
											onClick: () => onEditMetadata(session),
											children: (0, jsx.jsx)(IconEdit, {})
										}),
										(0, jsx.jsx)("button", {
											type: "button",
											className: "dac-iconbtn",
											"aria-label": t("export.row"),
											disabled: busy[session.id] === true,
											onClick: () => onExport([session.id]),
											children: (0, jsx.jsx)(IconDownload, {})
										}),
										(0, jsx.jsx)("button", {
											type: "button",
											className: "dac-iconbtn dac-danger",
											"aria-label": t("menu.deleteAll"),
											disabled: busy[session.id] === true,
											onClick: () => onDelete([session.id], null),
											children: (0, jsx.jsx)(IconTrash, {})
										}),
										(0, jsx.jsx)("button", {
											type: "button",
											className: "dac-unarchive",
											disabled: busy[session.id] === true,
											onClick: () => onUnarchive([session.id]),
											children: t("chat.unarchive")
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
			const snapshotCandidates = candidates.filter((item) => item.action === "delete-snapshot");
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
					(0, jsx.jsx)("div", { className: "dac-confirm-body", children: `${t("retention.projected")}: ${formatBytes(preview.projectedSnapshotBytes)}` }),
					hasPurge && (0, jsx.jsx)("div", { className: "dac-warn", role: "alert", children: t("retention.purgeWarning") }),
					candidates.length === 0 && (0, jsx.jsx)("div", { className: "dac-empty", children: t("retention.empty") }),
					candidates.length > 0 && (0, jsx.jsxs)("div", { className: "dac-retention-list", children: [snapshotCandidates.length > 0 && (0, jsx.jsxs)(jsx.Fragment, { children: [(0, jsx.jsx)("strong", { children: t("retention.snapshotCandidate") }), ...rows(snapshotCandidates)] }), trashCandidates.length > 0 && (0, jsx.jsxs)(jsx.Fragment, { children: [(0, jsx.jsx)("strong", { children: t("retention.trashCandidate") }), ...rows(trashCandidates)] })] }),
					(0, jsx.jsxs)("div", { className: "dac-confirm-actions", children: [
						(0, jsx.jsx)("button", { ref: cancelRef, type: "button", className: "dac-btn", onClick: onCancel, children: t("confirm.cancel") }),
						(0, jsx.jsx)("button", { type: "button", className: hasPurge ? "dac-btn-danger" : "dac-btn", disabled: busy || selected.size === 0, onClick: onApply, children: t("retention.apply") })
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

		function StorageRetentionPanel({ t }) {
			const [state, setState] = _react.useState({ status: "loading", value: null, error: null });
			const [draft, setDraft] = _react.useState(null);
			const [preview, setPreview] = _react.useState(null);
			const [selected, setSelected] = _react.useState(() => new Set());
			const [busy, setBusy] = _react.useState(false);
			const [message, setMessage] = _react.useState(null);
			const [detailsMode, setDetailsMode] = _react.useState(null);
			const previewReturnFocusRef = _react.useRef(null);
			const detailsReturnFocusRef = _react.useRef(null);
			const closeRetentionPreview = _react.useCallback(() => setPreview(null), []);
			const load = _react.useCallback(async (signal) => {
				setState((current) => ({ ...current, status: "loading", error: null }));
				try {
					const value = await fetchInsights(signal);
					if (signal?.aborted) return;
					setState({ status: "ready", value, error: null });
					setDraft({ ...value.policy });
				} catch (error) { if (!signal?.aborted) setState({ status: "error", value: null, error }); }
			}, []);
			_react.useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
			const setNumber = (key, value, nullable) => setDraft((current) => ({ ...current, [key]: nullable && value === "" ? null : Number(value) }));
			const save = async () => {
				setBusy(true); setMessage(null);
				try { const result = await saveRetentionPolicy(draft); setDraft({ ...(result.policy ?? draft) }); setMessage(t("retention.saved")); await load(); }
				catch (error) { setMessage(String(error.message ?? error)); }
				finally { setBusy(false); }
			};
			const openPreview = async () => {
				setBusy(true); setMessage(null);
				try { previewReturnFocusRef.current = document.activeElement; const value = await previewRetention(); setPreview(value); setSelected(defaultRetentionSelection(value.candidates)); }
				catch (error) { setMessage(String(error.message ?? error)); }
				finally { setBusy(false); }
			};
			const openDetails = (mode) => {
				detailsReturnFocusRef.current = document.activeElement;
				setDetailsMode(mode);
			};
			const applySelected = async () => {
				setBusy(true);
				try { const result = await applyRetention(preview.token, preview.nonce, [...selected]); const applied = result?.applied ?? []; const failed = result?.failed ?? []; setMessage(`${t("retention.result")}: ${applied.length} / ${failed.length}${failed.length > 0 ? ` · ${failed.map((item) => `${item.key}: ${item.reason}`).join(" · ")}` : ""}`); setPreview(null); setSelected(new Set()); await load(); }
				catch (error) { const body = error.body ?? {}; const applied = body.applied ?? []; const failed = body.failed ?? []; setMessage(failed.length > 0 ? `${t("retention.result")}: ${applied.length} / ${failed.length} · ${failed.map((item) => `${item.key}: ${item.reason}`).join(" · ")}` : String(error.message ?? error)); setPreview(null); setSelected(new Set()); }
				finally { setBusy(false); }
			};
			if (state.status === "loading") return (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { className: "dac-spin" }), t("insights.loading")] });
			if (state.status === "error") return (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { children: t("insights.error") }), (0, jsx.jsx)("button", { className: "dac-retry", onClick: () => load(), children: t("state.retry") })] });
			const value = state.value;
				const cards = [
					["insights.sessions", formatBytes(value.summary.sessionBytes), "sessions", (value.sessions ?? []).length, "insights.openSessions"],
					["insights.snapshots", formatBytes(value.summary.snapshotBytes), "snapshots", (value.snapshots ?? []).length, "insights.openSnapshots"],
					["insights.total", formatBytes(value.summary.totalMeasuredBytes), null, 0, null],
					["insights.duplicate", formatBytes(value.summary.duplicateSnapshotBytes), null, 0, null],
					["insights.unavailable", `${value.summary.sessionUnavailableCount} / ${value.summary.degradedSnapshotCount}`, null, 0, null]
				];
			return (0, jsx.jsxs)("div", { className: "dac-mode-panel", children: [
				(0, jsx.jsx)("div", { className: "dac-context-note", role: "note", children: t("insights.scopeNote") }),
					(0, jsx.jsx)("div", { className: "dac-insights-grid", children: cards.map(([label, display, mode, count, actionLabel]) => (0, jsx.jsxs)("div", { className: "dac-insights-card", style: { textAlign: "center", alignItems: "center" }, children: [
					(0, jsx.jsx)("span", { children: t(label) }),
					(0, jsx.jsx)("strong", { children: display }),
					mode && (0, jsx.jsx)("button", { type: "button", className: "dac-insights-open", style: { alignSelf: "center" }, "aria-label": t(actionLabel), disabled: count === 0, onClick: () => openDetails(mode), children: t("insights.details") })
				] }, label)) }),
				message && (0, jsx.jsx)("div", { className: "dac-notice", role: "status", children: message }),
				draft && (0, jsx.jsxs)("div", { className: "dac-policy", children: [
					(0, jsx.jsxs)("label", { children: [(0, jsx.jsx)("span", { children: t("retention.history") }), (0, jsx.jsx)("input", { type: "number", min: 0, max: 20, value: draft.historicalSnapshotsPerSession, onChange: (event) => setNumber("historicalSnapshotsPerSession", event.target.value, false) })] }),
					(0, jsx.jsxs)("label", { children: [(0, jsx.jsx)("span", { children: t("retention.snapshotAge") }), (0, jsx.jsx)("input", { type: "number", min: 1, max: 3650, placeholder: t("retention.disabled"), value: draft.historicalSnapshotMaxAgeDays ?? "", onChange: (event) => setNumber("historicalSnapshotMaxAgeDays", event.target.value, true) })] }),
					(0, jsx.jsxs)("label", { children: [(0, jsx.jsx)("span", { children: t("retention.quota") }), (0, jsx.jsx)("input", { type: "number", min: 1048576, value: draft.snapshotQuotaBytes ?? "", placeholder: t("retention.disabled"), onChange: (event) => setNumber("snapshotQuotaBytes", event.target.value, true) })] }),
					(0, jsx.jsxs)("label", { children: [(0, jsx.jsx)("span", { children: t("retention.recycleAge") }), (0, jsx.jsx)("input", { type: "number", min: 1, max: 3650, value: draft.recycleMaxAgeDays ?? "", placeholder: t("retention.disabled"), onChange: (event) => setNumber("recycleMaxAgeDays", event.target.value, true) })] }),
					(0, jsx.jsx)("div", { className: "dac-policy-note", children: t("retention.note") }),
					(0, jsx.jsxs)("div", { className: "dac-policy-actions", children: [(0, jsx.jsx)("button", { className: "dac-btn", disabled: busy, onClick: save, children: t("retention.save") }), (0, jsx.jsx)("button", { className: "dac-btn", disabled: busy, onClick: openPreview, children: t("retention.preview") })] })
				] }),
				preview && (0, jsx.jsx)(RetentionPreviewDialog, { preview, selected, t, busy, returnFocus: previewReturnFocusRef.current, onToggle: (key, checked) => setSelected((current) => setVisibleSelection(current, [key], checked)), onApply: applySelected, onCancel: closeRetentionPreview }),
				detailsMode && (0, jsx.jsx)(StorageDetailsDialog, { mode: detailsMode, sessions: value.sessions, snapshots: value.snapshots, t, returnFocus: detailsReturnFocusRef.current, onClose: () => setDetailsMode(null) })
			] });
		}

		const MAX_LINEAGE_GUIDES = 12;

		function flattenLineageNodes(nodes, collapsed) {
			const output = [];
			const roots = Array.isArray(nodes) ? nodes : [];
			const stack = roots.map((node, index) => ({
				node,
				level: 1,
				parent: null,
				guides: [],
				hiddenGuideCount: 0,
				isLast: index === roots.length - 1,
			})).reverse();
			while (stack.length > 0) {
				const current = stack.pop();
				const contextNode = ["active", "missing"].includes(current.node?.status);
				if (!contextNode) output.push(current);
				if (!contextNode && collapsed.has(current.node.id)) continue;
				const children = Array.isArray(current.node.children) ? current.node.children : [];
				const fullGuides = contextNode
					? current.guides
					: current.level === 1 ? current.guides : [...current.guides, !current.isLast];
				const hiddenGuideCount = contextNode
					? current.hiddenGuideCount
					: current.hiddenGuideCount + Math.max(0, fullGuides.length - MAX_LINEAGE_GUIDES);
				const guides = fullGuides.slice(-MAX_LINEAGE_GUIDES);
				for (let index = children.length - 1; index >= 0; index -= 1) stack.push({
					node: children[index],
					level: contextNode ? current.level : current.level + 1,
					parent: current.node,
					guides,
					hiddenGuideCount,
					isLast: contextNode ? current.isLast && index === children.length - 1 : index === children.length - 1,
				});
			}
			return output;
		}

		function LineageTreeNodes({ nodes, collapsed, onToggle, onCopy, copiedId, foldingDisabled = false, t }) {
			return (0, jsx.jsx)(jsx.Fragment, { children: flattenLineageNodes(nodes, collapsed).map(({ node, level, parent, guides, hiddenGuideCount, isLast }) => {
				const branches = Array.isArray(node.children) ? node.children.length : 0;
				const created = formatDate(t, node.createdAt);
				const metadata = [
					lineageProjectText(t, node),
					t(`lineage.origin.${node.origin ?? "session"}`),
					node.origin === "subagent" ? `${t("lineage.delegation")} ${node.delegationDepth ?? 0}` : null,
				].filter(Boolean).join(" · ");
				const sourceContext = ["active", "missing"].includes(parent?.status) ? lineageContextText(t, parent) : null;
				const canToggle = branches > 0;
				const expanded = canToggle && !collapsed.has(node.id);
				return (0, jsx.jsxs)("div", { role: "listitem", "aria-level": level, className: "dac-lineage-node", children: [
					(0, jsx.jsxs)("div", { className: "dac-lineage-rail", children: [
						hiddenGuideCount > 0 && (0, jsx.jsx)("span", { className: "dac-lineage-guide-overflow", title: `${hiddenGuideCount}`, "aria-hidden": "true", children: "…" }),
						guides.map((continues, index) => (0, jsx.jsx)("span", { className: `dac-lineage-guide${continues ? " dac-lineage-guide-continuing" : ""}`, "aria-hidden": "true" }, `${node.id}:guide:${index}`)),
						(0, jsx.jsx)("span", { className: `dac-lineage-junction ${level === 1 ? "dac-lineage-junction-root" : `dac-lineage-junction-child${isLast ? " dac-lineage-junction-last" : ""}`}`, children: (0, jsx.jsx)("span", { className: "dac-lineage-dot", "aria-hidden": "true" }) })
					] }),
					(0, jsx.jsxs)("div", { className: `dac-lineage-row dac-lineage-row-${node.status}${canToggle ? " dac-lineage-row-foldable" : ""}`, "aria-expanded": canToggle ? expanded : void 0, tabIndex: canToggle && !foldingDisabled ? 0 : void 0, onClick: canToggle && !foldingDisabled ? () => onToggle?.(node.id) : void 0, onKeyDown: canToggle && !foldingDisabled ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle?.(node.id); } } : void 0, children: [
						(0, jsx.jsx)("strong", { children: lineageNodeLabel(t, node) }),
						(0, jsx.jsx)("span", { className: `dac-trash-status dac-lineage-${node.status}`, style: { borderRadius: "8px", whiteSpace: "nowrap", flexShrink: 0 }, children: t(`lineage.status.${node.status}`) }),
						(0, jsx.jsxs)("div", { className: "dac-lineage-detail", children: [
							(0, jsx.jsxs)("div", { className: "dac-lineage-detail-copy", children: [
								sourceContext && (0, jsx.jsx)("small", { className: "dac-lineage-source-context", style: { overflowWrap: "anywhere" }, children: sourceContext }),
								(0, jsx.jsx)("small", { className: "dac-lineage-source", style: { overflowWrap: "anywhere" }, children: lineageRelationText(t, parent) }),
								(0, jsx.jsx)("small", { className: "dac-lineage-meta", children: metadata })
							] })
						] }),
							(0, jsx.jsxs)("div", { className: "dac-lineage-footer", children: [
								created !== "" && (0, jsx.jsx)("small", { className: "dac-lineage-created", children: `${t("lineage.created")} ${created}` }),
								(0, jsx.jsxs)("div", { className: "dac-lineage-id-actions", children: [
									(0, jsx.jsxs)("div", { className: "dac-lineage-id-row", children: [
										(0, jsx.jsx)("small", { className: "dac-lineage-id", title: node.id, children: compactSessionId(node.id) }),
										(0, jsx.jsx)("button", { type: "button", className: "dac-lineage-copy", "aria-label": `${t("lineage.copyId")} ${node.id}`, onClick: (event) => { event?.stopPropagation?.(); onCopy?.(node.id); }, children: copiedId === node.id ? t("lineage.copiedId") : t("lineage.copyId") })
									] }),
								] })
						] }),
						canToggle && (0, jsx.jsxs)("div", { className: "dac-lineage-toggle-row", children: [
							(0, jsx.jsx)("button", { type: "button", className: "dac-lineage-toggle", "aria-label": collapsed.has(node.id) ? t("group.expand") : t("group.collapse"), "aria-expanded": expanded, disabled: foldingDisabled, title: foldingDisabled ? t("lineage.searchFoldHint") : void 0, onClick: (event) => { event?.stopPropagation?.(); onToggle?.(node.id); }, children: (0, jsx.jsx)("span", { className: collapsed.has(node.id) ? "dac-chev open" : "dac-chev collapse", children: (0, jsx.jsx)(IconChevron, {}) }) })
						] })
					] })
				]
				}, node.id);
			}) });
		}

		function ArchiveRelationshipsPanel({ t }) {
			const [state, setState] = _react.useState({ status: "loading", value: null });
			const [query, setQuery] = _react.useState("");
			const [projectFilter, setProjectFilter] = _react.useState("all");
			const [statusFilter, setStatusFilter] = _react.useState("all");
			const [collapsed, setCollapsed] = _react.useState(() => new Set());
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
				const projects = lineageProjects(sourceRoots);
				const branchIds = lineageBranchIds(sourceRoots);
				const roots = filterLineageForest(sourceRoots, query, projectFilter, statusFilter);
				const managedCount = countManagedLineageNodes(roots);
				const managedCountText = `${managedCount} ${t("lineage.managedCount")}`;
				const searchActive = query.trim() !== "";
				const visibleCollapsed = searchActive ? new Set() : collapsed;
				const canFold = branchIds.length > 0;
				const allExpanded = canFold && branchIds.every((id) => !collapsed.has(id));
				const nodesById = new Map();
				const pendingNodes = [...sourceRoots];
				while (pendingNodes.length > 0) {
					const node = pendingNodes.pop();
					if (typeof node?.id === "string" && !nodesById.has(node.id)) nodesById.set(node.id, node);
					for (const child of Array.isArray(node?.children) ? node.children : []) pendingNodes.push(child);
				}
				return (0, jsx.jsxs)("div", { className: "dac-mode-panel", children: [
					(0, jsx.jsxs)("div", { className: "dac-lineage-toolbar", children: [
						(0, jsx.jsxs)("div", { className: "dac-lineage-filter-row", children: [
							(0, jsx.jsxs)("div", { className: "dac-search", children: [
								(0, jsx.jsx)(IconSearch, {}),
								(0, jsx.jsx)("input", { type: "search", value: query, placeholder: t("lineage.search"), onChange: (event) => setQuery(event.target.value) })
							] }),
							(0, jsx.jsxs)("div", { className: "dac-lineage-filter-actions", children: [
								(0, jsx.jsx)(Select, {
									value: projectFilter,
									onChange: setProjectFilter,
									ariaLabel: t("lineage.projectFilter"),
									fill: true,
									options: [
										{ value: "all", label: t("filter.allProjects") },
										...projects.map((project) => ({ value: project.value, label: project.title ?? t("group.noProject") }))
									]
								}),
								(0, jsx.jsx)(Select, {
									value: statusFilter,
									onChange: setStatusFilter,
									ariaLabel: t("lineage.statusFilter"),
									fill: true,
									options: [
										{ value: "all", label: t("lineage.statusAll") },
										{ value: "archived", label: t("lineage.status.archived") },
										{ value: "trash", label: t("lineage.status.trash") }
									]
								})
							] })
						] })
					] }),
					(state.value.diagnostics ?? []).length > 0 && (0, jsx.jsx)("div", { className: "dac-row-meta", role: "status", children: (state.value.diagnostics ?? []).map((item) => (0, jsx.jsx)("span", { className: "dac-chip dac-summary-warn", children: `${t(`lineage.diagnostic.${item.code}`)}: ${lineageNodeLabel(t, nodesById.get(item.sessionId))}` }, `${item.code}:${item.sessionId}`)) }),
					(0, jsx.jsxs)("div", { className: "dac-lineage-list-head", children: [
						(0, jsx.jsxs)("div", { className: "dac-lineage-list-head-copy", children: [
							(0, jsx.jsx)("span", { children: t("lineage.managedHeading") }),
							(0, jsx.jsx)("small", { children: managedCountText })
						] }),
						(0, jsx.jsxs)("div", { className: "dac-lineage-fold-actions", children: [
							(0, jsx.jsxs)("button", { type: "button", className: "dac-lineage-fold", disabled: searchActive || !canFold, title: searchActive ? t("lineage.searchFoldHint") : void 0, onClick: () => setCollapsed(allExpanded ? new Set(branchIds) : new Set()), children: [
								(0, jsx.jsx)("span", { className: allExpanded ? "dac-chev collapse" : "dac-chev open", children: (0, jsx.jsx)(IconChevron, {}) }),
								(0, jsx.jsx)("span", { children: t(allExpanded ? "lineage.collapseAll" : "lineage.expandAll") })
							] })
						] })
					] }),
					roots.length === 0 ? (0, jsx.jsx)("div", { className: "dac-empty", children: t("lineage.empty") }) : (0, jsx.jsx)("div", { role: "list", "aria-label": t("tab.lineage"), className: "dac-lineage-tree", children: (0, jsx.jsx)(LineageTreeNodes, { nodes: roots, collapsed: visibleCollapsed, copiedId, foldingDisabled: searchActive, t, onCopy: copyId, onToggle: (id) => setCollapsed((current) => setVisibleSelection(current, [id], !current.has(id))) }) }),
					(0, jsx.jsx)("div", { className: "dac-lineage-scopebar", role: "note", children: t("lineage.scopeNote") })
				] });
		}

		/** The settings section page for archived-chat management. */
		function ArchivedChatsSection({ t, refreshSidebar }) {
			const [sessions, setSessions] = _react.useState(null);
			const [pageMode, setPageMode] = _react.useState("archived");
			const [trash, setTrash] = _react.useState({ status: "idle", sessions: [], summary: null, trashStatus: "ready", error: null });
			const [trashSelected, setTrashSelected] = _react.useState(() => new Set());
			const [trashBusy, setTrashBusy] = _react.useState({});
			const [trashConfirm, setTrashConfirm] = _react.useState(null);
			const [loadError, setLoadError] = _react.useState(null);
			const [query, setQuery] = _react.useState("");
			const [typeFilter, setTypeFilter] = _react.useState("all");
			const [projectFilter, setProjectFilter] = _react.useState("all");
			const [sortMode, setSortMode] = _react.useState("newest");
			const [menuFor, setMenuFor] = _react.useState(null);
			const [confirm, setConfirm] = _react.useState(null);
			const [busy, setBusy] = _react.useState({});
			const [notice, setNotice] = _react.useState(null);
			const [collapsed, setCollapsed] = _react.useState(readCollapsed);
			const [selected, setSelected] = _react.useState(() => new Set());
			const [tagFilter, setTagFilter] = _react.useState("");
			const [metadataStatus, setMetadataStatus] = _react.useState("ready");
			const [stats, setStats] = _react.useState({ status: "idle", summary: null, sessions: {} });
				const [metadataEdit, setMetadataEdit] = _react.useState(null);
				const [metaBusy, setMetaBusy] = _react.useState(false);
				const [importPreview, setImportPreview] = _react.useState(null);
				const [importBusy, setImportBusy] = _react.useState(false);
					const [selectionMode, setSelectionMode] = _react.useState(false);
					const [actionMenu, setActionMenu] = _react.useState(null);
					const [contentSearch, setContentSearch] = _react.useState({ status: "idle", query: "", hits: [], skipped: [] });
					const [preview, setPreview] = _react.useState(null);
					const [previewBusy, setPreviewBusy] = _react.useState(false);
					const [trashSelectionMode, setTrashSelectionMode] = _react.useState(false);
					const pageRef = _react.useRef(null);
			const pageHeadingRef = _react.useRef(null);
				const actionMenuRef = _react.useRef(null);
				const moreActionRef = _react.useRef(null);
			const deleteReturnFocusRef = _react.useRef(null);
				const trashReturnFocusRef = _react.useRef(null);
				const metaReturnFocusRef = _react.useRef(null);
					const importInputRef = _react.useRef(null);
					const searchRequestRef = _react.useRef(0);
					const previewReturnFocusRef = _react.useRef(null);
					const previewRequestRef = _react.useRef({ sequence: 0, controller: null });

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
					}, []);

			_react.useEffect(() => {
				if (actionMenu === null) return undefined;
				const onDown = (event) => {
					if (actionMenuRef.current && !actionMenuRef.current.contains(event.target)) setActionMenu(null);
				};
				document.addEventListener("mousedown", onDown);
				return () => {
					document.removeEventListener("mousedown", onDown);
				};
			}, [actionMenu]);

			const closeActionMenuFromKeyboard = (event) => {
				if (event.key !== "Escape" || actionMenu === null) return;
				event.preventDefault();
				event.stopPropagation();
				setActionMenu(null);
				moreActionRef.current?.focus?.();
			};

			_react.useEffect(() => {
				if (sessions === null || loadError !== null) return undefined;
				return markArchiveDialog(pageRef.current);
			}, [sessions, loadError]);

			// Success confirmations are transient toasts;
			// errors stay until dismissed.
			_react.useEffect(() => {
				if (notice?.kind !== "ok") return undefined;
				const timer = setTimeout(() => {
					setNotice((current) => (current === notice ? null : current));
				}, 4000);
				return () => clearTimeout(timer);
			}, [notice]);

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
				setLoadError(null);
				try {
					const loaded = await fetchState();
					setSessions(loaded.sessions);
					setMetadataStatus(loaded.metadataStatus);
					setStats({ status: "idle", summary: null, sessions: {} });
				} catch (error) {
					setLoadError(error);
				}
			}, []);
			_react.useEffect(() => { refresh(); }, [refresh]);

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
				if (pageMode === "trash" && trash.status === "idle") void loadTrash();
			}, [pageMode, trash.status, loadTrash]);
			_react.useEffect(() => {
				setTrashSelected((current) => {
					const currentIds = new Set(trash.sessions.map((row) => row.sessionId));
					const next = new Set([...current].filter((id) => currentIds.has(id)));
					return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
				});
			}, [trash.sessions]);

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
				_react.useEffect(() => {
					const trimmed = query.trim();
					const requestId = searchRequestRef.current + 1;
					searchRequestRef.current = requestId;
					if (Array.from(trimmed).length < 2) {
						setContentSearch({ status: "idle", query: trimmed, hits: [], skipped: [] });
						return undefined;
					}
					setContentSearch({ status: "loading", query: trimmed, hits: [], skipped: [] });
					const timer = setTimeout(() => {
						fetchArchiveSearch(trimmed, 100).then((result) => {
							if (searchRequestRef.current !== requestId) return;
							setContentSearch({
								status: "ready",
								query: trimmed,
								hits: Array.isArray(result?.hits) ? result.hits : [],
								skipped: Array.isArray(result?.skipped) ? result.skipped : [],
							});
						}).catch(() => {
							if (searchRequestRef.current !== requestId) return;
							setContentSearch({ status: "error", query: trimmed, hits: [], skipped: [] });
						});
					}, 300);
					return () => clearTimeout(timer);
				}, [query]);
				_react.useEffect(() => {
				if (sessions === null) return;
				setSelected((current) => {
					const next = reconcileSelection(current, sessions);
					return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
				});
			}, [sessions]);

			const toggleSelected = (ids, checked) => {
				setSelected((current) => setVisibleSelection(current, ids, checked));
			};
			const finishSelectionMode = () => {
				setSelected(new Set());
				setSelectionMode(false);
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

			const toggleTrashSelected = (ids, checked) => {
				setTrashSelected((current) => setVisibleSelection(current, ids, checked));
			};
			const finishTrashSelectionMode = () => {
				setTrashSelected(new Set());
				setTrashSelectionMode(false);
			};

			const restoreFromTrash = async (ids) => {
				const requested = uniqueSessionIds(ids);
				if (requested.length === 0) return;
				markTrashBusy(requested, true);
				setNotice(null);
				try {
					const result = await restoreTrash(requested);
					const restored = uniqueSessionIds(result?.restored);
					setTrash((current) => ({ ...current, sessions: current.sessions.filter((row) => !restored.includes(row.sessionId)) }));
					setTrashSelected((current) => setVisibleSelection(current, restored, false));
					if (restored.includes(preview?.session?.id)) closePreview();
					if (restored.length > 0) {
						setNotice({ kind: "ok", text: t("trash.restored") });
						if (trashSelectionMode) finishTrashSelectionMode();
						await refresh();
						refreshSidebar?.();
					}
					if ((result?.failed ?? []).length > 0) setNotice({ kind: "error", text: failureText(t, result.failed) });
					await loadTrash();
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				} finally {
					markTrashBusy(requested, false);
				}
			};

			const purgeFromTrash = async (ids) => {
				const requested = uniqueSessionIds(ids);
				if (requested.length === 0) return;
				markTrashBusy(requested, true);
				setNotice(null);
				try {
					const result = await purgeTrash(requested);
					const purged = uniqueSessionIds(result?.purged);
					setTrash((current) => ({ ...current, sessions: current.sessions.filter((row) => !purged.includes(row.sessionId)) }));
					setTrashSelected((current) => setVisibleSelection(current, purged, false));
					if (purged.includes(preview?.session?.id)) closePreview();
					if (purged.length > 0) {
						setNotice({ kind: "ok", text: t("trash.purged") });
						if (trashSelectionMode) finishTrashSelectionMode();
					}
					if ((result?.failed ?? []).length > 0) setNotice({ kind: "error", text: failureText(t, result.failed) });
					await loadTrash();
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				} finally {
					markTrashBusy(requested, false);
					setTrashConfirm(null);
				}
			};

			const emptyRecycleBin = async () => {
				const ids = trash.sessions.map((row) => row.sessionId);
				markTrashBusy(ids, true);
				setNotice(null);
				try {
					const result = await emptyTrash();
					const purged = uniqueSessionIds(result?.purged);
					setTrash((current) => ({ ...current, sessions: current.sessions.filter((row) => !purged.includes(row.sessionId)) }));
					setTrashSelected((current) => setVisibleSelection(current, purged, false));
					if (purged.length > 0) {
						setNotice({ kind: "ok", text: t("trash.purged") });
						if (trashSelectionMode) finishTrashSelectionMode();
					}
					if ((result?.failed ?? []).length > 0) setNotice({ kind: "error", text: failureText(t, result.failed) });
					await loadTrash();
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				} finally {
					markTrashBusy(ids, false);
					setTrashConfirm(null);
				}
			};

			const askTrashPurge = (ids, empty = false) => {
				trashReturnFocusRef.current = document.activeElement;
				const selectedRows = trash.sessions.filter((row) => ids.includes(row.sessionId));
				const degraded = selectedRows.some((row) => row.state === "degraded");
				setTrashConfirm({
					ids,
					empty,
					title: t(empty ? "trash.confirm.emptyTitle" : "trash.confirm.title"),
					body: `${t(empty ? "trash.confirm.emptyBody" : "trash.confirm.body")}${degraded ? ` ${t("trash.confirm.degraded")}` : ""}`,
				});
			};

			const unarchive = async (ids, finishSelectionAfter = false) => {
				if (ids.length === 0) return;
				markBusy(ids, true);
				setNotice(null);
				try {
					await post("/unarchive-all", { sessionIds: ids });
					setSessions((prev) => (prev ?? []).filter((s) => !ids.includes(s.id)));
					setSelected((current) => setVisibleSelection(current, ids, false));
					if (finishSelectionAfter) finishSelectionMode();
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				} finally {
					markBusy(ids, false);
				}
			};

			const runDelete = async (ids, finishSelectionAfter = false) => {
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
						setSelected((current) => setVisibleSelection(current, trashed, false));
						setTrash((current) => ({ ...current, status: "idle" }));
					}
					if (failed.length > 0) setNotice({ kind: "error", text: failureText(t, failed) });
					else if (trashed.length > 0) setNotice({ kind: "ok", text: t("trash.moved"), action: "undo-trash", ids: trashed });
					if (finishSelectionAfter && failed.length === 0 && trashed.length === ids.length) finishSelectionMode();
				} catch (error) {
					const trashed = uniqueSessionIds(error.body?.trashed);
					const failed = error.body?.failed ?? [];
					if (trashed.length > 0) {
						changed = true;
						setSessions((prev) => (prev ?? []).filter((s) => !trashed.includes(s.id)));
						setSelected((current) => setVisibleSelection(current, trashed, false));
						setTrash((current) => ({ ...current, status: "idle" }));
					}
					setNotice({ kind: "error", text: failed.length > 0 ? failureText(t, failed) : String(error.message ?? error) });
				} finally {
					markBusy(ids, false);
					setConfirm(null);
					// The stock wire has no "persisted session deleted" frame, so the
					// sidebar keeps stale summary rows until it re-baselines. Pull a
					// fresh session.list: deleted sessions are gone from persistence
					// (and were never live), so the main page drops them at once.
					if (changed) refreshSidebar?.();
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
					setNotice({ kind: "error", text: String(error.message ?? error), action: "undo-trash", ids: requested });
				} finally {
					markBusy(requested, false);
				}
			};

			const askDelete = (ids, groupName, selectedScope = false) => {
				if (ids.length === 0) return;
				deleteReturnFocusRef.current = document.activeElement;
				if (selectedScope) {
					setConfirm({ title: t("confirm.deleteSelected.title"), body: deleteSelectedBody(t, ids.length), ids, finishSelectionAfter: true });
				} else if (ids.length === 1 && groupName === null) {
					setConfirm({ title: t("confirm.deleteOne.title"), body: t("confirm.deleteOne.body"), ids });
				} else if (groupName !== null && groupName !== void 0) {
					setConfirm({ title: t("confirm.deleteGroup.title"), body: deleteGroupBody(t, groupName, ids.length), ids });
				} else {
					setConfirm({ title: t("confirm.deleteAll.title"), body: deleteAllBody(t, ids.length), ids });
				}
			};

			const openMetadataEditor = (session) => {
				metaReturnFocusRef.current = document.activeElement;
				setMetadataEdit(session);
			};

			const openPreview = async (session, scope = "archive") => {
				const request = beginPreviewRequest();
				previewReturnFocusRef.current = document.activeElement;
				setPreview({ status: "loading", session, scope, messages: [], total: 0, nextOffset: null });
				setPreviewBusy(true);
				try {
					const result = await fetchArchivePreview(session.id, 0, 50, request.controller.signal, scope);
					if (!ownsPreviewRequest(request)) return;
					setPreview({ ...result, status: "ready", scope, session: result?.session ?? session, messages: Array.isArray(result?.messages) ? result.messages : [] });
				} catch (error) {
					if (!ownsPreviewRequest(request)) return;
					setPreview({ status: "error", session, scope, messages: [], total: 0, nextOffset: null, error: String(error.message ?? error) });
				} finally {
					if (ownsPreviewRequest(request)) setPreviewBusy(false);
				}
			};

			const loadMorePreview = async () => {
				if (!preview?.session?.id || preview.nextOffset === null || previewBusy) return;
				const sessionId = preview.session.id;
				const nextOffset = preview.nextOffset;
				const request = beginPreviewRequest();
				setPreviewBusy(true);
				try {
					const result = await fetchArchivePreview(sessionId, nextOffset, 50, request.controller.signal, preview.scope ?? "archive");
					if (!ownsPreviewRequest(request)) return;
					setPreview((current) => current ? {
						...current,
						status: "ready",
						messages: [...(current.messages ?? []), ...(Array.isArray(result?.messages) ? result.messages : [])],
						total: result?.total ?? current.total,
						nextOffset: result?.nextOffset ?? null,
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
					setMetadataEdit(null);
					setNotice({ kind: "ok", text: t("meta.saved") });
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				} finally {
					setMetaBusy(false);
				}
				};

				const exportSessions = (ids) => {
					if (!submitExport(ids)) return false;
					setNotice({ kind: "ok", text: t("export.started") });
					return true;
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
						});
					} catch (error) {
						const code = error.body?.error;
						setNotice({ kind: "error", text: code === "import-token-invalid" ? t("import.expired") : String(error.message ?? error) });
					} finally {
						setImportBusy(false);
					}
				};
				const restoreImport = async () => {
					if (!importPreview || importPreview.selectedIds.length === 0) return;
					setImportBusy(true);
					try {
						const result = await post("/import/restore", {
							token: importPreview.token,
							nonce: importPreview.nonce,
							sessionIds: importPreview.selectedIds,
						});
						setImportPreview((current) => current ? { ...current, result } : current);
						await refresh();
						refreshSidebar?.();
						setNotice({ kind: "ok", text: t("import.done") });
					} catch (error) {
						const code = error.body?.error;
						setNotice({ kind: "error", text: code === "import-token-invalid" ? t("import.expired") : String(error.message ?? error) });
					} finally {
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
				if (contentSearch.status !== "ready" || contentSearch.query !== query.trim()) return new Map();
				return new Map((contentSearch.hits ?? []).map((hit) => [hit.sessionId, hit]));
			}, [contentSearch, query]);

			const groups = _react.useMemo(() => {
				const projectIds = new Map();
				for (const session of sessions ?? []) {
					const key = session.workspaceId ?? "ungrouped";
					if (!projectIds.has(key)) projectIds.set(key, []);
					projectIds.get(key).push(session.id);
				}
				const locale = t("locale.intl");
				const visible = (sessions ?? []).filter((s) => {
					if (projectFilter !== "all" && (s.workspaceId ?? "ungrouped") !== projectFilter) return false;
					if (typeFilter === "normal" && s.origin === "subagent") return false;
					if (typeFilter === "subagent" && s.origin !== "subagent") return false;
						if (tagFilter !== "" && !filterByTag(s, tagFilter, locale)) return false;
					if (query.trim() !== "" && !matchesArchivedSession(s, query, locale) && !contentHits.has(s.id)) return false;
					return true;
				});
				const byKey = new Map();
				for (const s of visible) {
					const key = s.workspaceId ?? "ungrouped";
					if (!byKey.has(key)) byKey.set(key, { key, title: s.workspaceTitle ?? t("group.noProject"), items: [], selectionIds: projectIds.get(key) ?? [] });
					byKey.get(key).items.push(s);
				}
				const list = [...byKey.values()];
				for (const g of list) g.items = sortArchivedSessions(g.items, sortMode, t("locale.intl"));
				const groupCollator = new Intl.Collator(t("locale.intl"), { numeric: true, sensitivity: "base" });
				list.sort((a, b) => {
					if ((a.key === "ungrouped") !== (b.key === "ungrouped")) return a.key === "ungrouped" ? 1 : -1;
					if (sortMode === "title") return groupCollator.compare(a.title, b.title);
					const aDate = typeof a.items[0]?.createdAt === "number" ? a.items[0].createdAt : null;
					const bDate = typeof b.items[0]?.createdAt === "number" ? b.items[0].createdAt : null;
					if ((aDate === null) !== (bDate === null)) return aDate === null ? 1 : -1;
					if (aDate !== null && bDate !== null && aDate !== bDate) return sortMode === "oldest" ? aDate - bDate : bDate - aDate;
					return groupCollator.compare(a.title, b.title);
				});
				return list;
			}, [sessions, query, projectFilter, typeFilter, tagFilter, sortMode, contentHits, t]);

			if (sessions === null && loadError === null) {
				return (0, jsx.jsx)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { className: "dac-spin" }), (0, jsx.jsx)("span", { children: t("state.loading") })] });
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
			const visibleIds = groups.flatMap((group) => group.items.map((session) => session.id));
			const selectedIds = allIds.filter((id) => selected.has(id));
			const selectedVisibleCount = visibleIds.filter((id) => selected.has(id)).length;
			const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
			const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
				const selectedBusy = selectedIds.some((id) => busy[id] === true);
				const visibleBusy = visibleIds.some((id) => busy[id] === true);
				const allBusy = allIds.some((id) => busy[id] === true);
				const filtering = query.trim() !== "" || projectFilter !== "all" || typeFilter !== "all" || tagFilter !== "";
				const trashGroups = groupTrashSessions(trash.sessions);
				const trashIds = trash.sessions.map((row) => row.sessionId);
				const selectableTrashIds = trash.sessions.filter((row) => row.state !== "purge-pending").map((row) => row.sessionId);
				const selectedTrashIds = trashIds.filter((id) => trashSelected.has(id));
				const trashMutationsAvailable = trash.status === "ready" && trash.trashStatus === "ready";
				const selectedTrashBusy = selectedTrashIds.some((id) => trashBusy[id] === true);
				const trashSnapshotBytes = trash.sessions.reduce((total, row) => total + (Number.isFinite(row.snapshotBytes) ? row.snapshotBytes : 0), 0);

			return (0, jsx.jsxs)("div", {
				ref: pageRef,
				className: "dac-page",
				children: [
					(0, jsx.jsxs)("div", {
						className: "dac-head",
						children: [
							(0, jsx.jsx)("h2", { ref: pageHeadingRef, tabIndex: -1, className: "dac-title", children: t("page.title") }),
								pageMode === "archived" && (0, jsx.jsxs)("div", {
									ref: actionMenuRef,
									className: "dac-head-actions",
									onKeyDown: closeActionMenuFromKeyboard,
								children: [
									(0, jsx.jsx)("div", { className: "dac-action-wrap", children:
										(0, jsx.jsxs)("button", {
											type: "button",
											className: "dac-action-trigger",
											disabled: importBusy,
											onClick: () => importInputRef.current?.click?.(),
											children: [(0, jsx.jsx)(IconUpload, {}), (0, jsx.jsx)("span", { children: t("action.import") })]
										})
									}),
									(0, jsx.jsx)("div", { className: "dac-action-wrap", children:
										(0, jsx.jsxs)("button", {
											type: "button",
											className: "dac-action-trigger",
											disabled: allIds.length === 0 || allBusy,
											onClick: () => { const didExport = exportSessions(selectedIds.length > 0 ? selectedIds : allIds); if (didExport && selectedIds.length > 0) finishSelectionMode(); },
											children: [(0, jsx.jsx)(IconDownload, {}), (0, jsx.jsx)("span", { children: t("action.export") })]
										})
									}),
										(0, jsx.jsxs)("div", { className: "dac-action-wrap", children: [
											(0, jsx.jsxs)("button", {
												ref: moreActionRef,
												type: "button",
												className: "dac-action-trigger",
												disabled: allIds.length === 0,
												"aria-controls": "dac-more-actions",
												"aria-expanded": actionMenu === "more",
												onClick: () => setActionMenu((current) => current === "more" ? null : "more"),
												children: [(0, jsx.jsx)(IconDots, {}), (0, jsx.jsx)("span", { children: t("action.more") })]
											}),
											actionMenu === "more" && (0, jsx.jsx)("div", { id: "dac-more-actions", className: "dac-action-menu", children: (0, jsx.jsx)("button", { type: "button", className: "dac-action-menu-item dac-danger", onClick: () => { setActionMenu(null); askDelete(allIds, void 0); }, children: t("delete.all") }) })
										] })
										]
									}),
									(0, jsx.jsx)("input", {
										ref: importInputRef,
										type: "file",
										accept: ".zip,application/zip",
										hidden: true,
										onChange: (event) => { const file = event.target.files?.[0]; void importFile(file); event.target.value = ""; }
									}),
								]
							}),
					(0, jsx.jsxs)("div", { className: "dac-tabs", role: "tablist", "aria-label": t("page.title"), children: [
						(0, jsx.jsx)("button", { type: "button", role: "tab", className: "dac-tab", "aria-selected": pageMode === "archived", onClick: () => setPageMode("archived"), children: t("tab.archived") }),
						(0, jsx.jsx)("button", { type: "button", role: "tab", className: "dac-tab", "aria-selected": pageMode === "trash", onClick: () => setPageMode("trash"), children: t("tab.trash") }),
						(0, jsx.jsx)("button", { type: "button", role: "tab", className: "dac-tab", "aria-selected": pageMode === "insights", onClick: () => setPageMode("insights"), children: t("tab.insights") }),
						(0, jsx.jsx)("button", { type: "button", role: "tab", className: "dac-tab", "aria-selected": pageMode === "lineage", onClick: () => setPageMode("lineage"), children: t("tab.lineage") }),
					] }),
					pageMode === "archived" && (0, jsx.jsxs)("div", { className: "dac-mode-panel", children: [
				(0, jsx.jsxs)("div", {
						className: "dac-summary",
							role: "status",
							children: [
							(0, jsx.jsx)("span", { children: chatsCount(t, (sessions ?? []).length) }),
							(0, jsx.jsx)("span", { className: "dac-summary-sep", "aria-hidden": "true", children: "·" }),
							(0, jsx.jsx)("span", { children: summarySizeText(t, stats) }),
							stats.status === "ready" && stats.summary?.unavailableCount > 0 && (0, jsx.jsx)("span", { className: "dac-summary-warn", children: t("stats.unavailable") })
						]
					}),
					metadataStatus === "unavailable" && (0, jsx.jsx)("div", {
						className: "dac-warn",
						role: "status",
						children: t("meta.unavailable")
					}),
					(0, jsx.jsxs)("div", {
						className: "dac-search",
						children: [
							(0, jsx.jsx)(IconSearch, {}),
							(0, jsx.jsx)("input", {
								type: "text",
								placeholder: t("search.placeholder"),
								value: query,
								onChange: (e) => setQuery(e.target.value)
							}),
							contentSearch.status === "loading" && (0, jsx.jsx)("span", { className: "dac-search-state", role: "status", children: t("search.loading") }),
							contentSearch.status === "error" && (0, jsx.jsx)("span", { className: "dac-search-state dac-error", role: "status", children: t("search.error") })
						]
					}),
					(0, jsx.jsxs)("div", {
						className: "dac-filters",
						children: [
							(0, jsx.jsx)(Select, {
								value: typeFilter,
								onChange: setTypeFilter,
								ariaLabel: t("filter.allChats"),
								options: [
									{ value: "all", label: t("filter.allChats") },
									{ value: "normal", label: t("filter.normal") },
									{ value: "subagent", label: t("filter.subagent") }
								]
							}),
							(0, jsx.jsx)(Select, {
								value: projectFilter,
								onChange: setProjectFilter,
								ariaLabel: t("filter.allProjects"),
								options: [
									{ value: "all", label: t("filter.allProjects") },
									...projects.map((p) => ({ value: p.value, label: p.title ?? t("group.noProject") }))
								]
							}),
							(0, jsx.jsx)(Select, {
								value: tagFilter,
								onChange: setTagFilter,
								ariaLabel: t("tag.filter"),
								options: [
									{ value: "", label: t("tag.filter") },
									...tagOptions.map((tag) => ({ value: tag, label: tag }))
								]
							}),
							(0, jsx.jsx)(Select, {
								value: sortMode,
								onChange: setSortMode,
								ariaLabel: t("sort.label"),
								options: [
									{ value: "newest", label: t("sort.newest") },
									{ value: "oldest", label: t("sort.oldest") },
									{ value: "title", label: t("sort.title") }
								]
							}),
							(visibleIds.length > 0 || selectionMode) && (0, jsx.jsxs)("div", {
								className: "dac-selection-controls",
								children: [
									selectionMode && visibleIds.length > 0 && (0, jsx.jsxs)("label", {
										className: "dac-selection-toggle",
										children: [
											(0, jsx.jsx)(SelectionCheckbox, {
												checked: allVisibleSelected,
												indeterminate: someVisibleSelected,
												disabled: visibleBusy,
												ariaLabel: t("selection.visible"),
												onChange: (checked) => toggleSelected(visibleIds, checked)
											}),
											(0, jsx.jsx)("span", { children: t("selection.visible") })
										]
									}),
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-selection-mode",
										onClick: selectionMode ? finishSelectionMode : () => setSelectionMode(true),
										children: t(selectionMode ? "selection.done" : "selection.start")
									})
								]
							})
						]
					}),
					selectedIds.length > 0 && (0, jsx.jsxs)("div", {
						className: "dac-bulkbar",
						role: "region",
						"aria-label": selectedCount(t, selectedIds.length),
						children: [
							(0, jsx.jsx)("span", { className: "dac-bulk-count", children: selectedCount(t, selectedIds.length) }),
							(0, jsx.jsxs)("div", {
									className: "dac-bulk-actions",
									children: [
										(0, jsx.jsx)("button", {
											type: "button",
											className: "dac-bulk-btn",
											disabled: selectedBusy,
											onClick: () => { if (exportSessions(selectedIds)) finishSelectionMode(); },
											children: t("export.selected")
										}),
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-bulk-btn",
									disabled: selectedBusy,
									onClick: () => unarchive(selectedIds, true),
									children: t("bulk.unarchive")
									}),
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-bulk-btn dac-danger",
										disabled: selectedBusy,
										onClick: () => askDelete(selectedIds, null, true),
										children: t("bulk.delete")
									}),
									(0, jsx.jsx)("button", {
										type: "button",
										className: "dac-bulk-btn",
										onClick: () => setSelected(new Set()),
										children: t("selection.clear")
									})
								]
							})
						]
					}),
					notice !== null && notice.kind === "ok" && (0, jsx.jsxs)("div", {
						className: "dac-toast",
						role: "status",
						style: { top: `${toastTop()}px` },
						children: [
							(0, jsx.jsx)(IconCheckCircle, {}),
							(0, jsx.jsx)("span", { children: notice.text }),
							notice.action === "undo-trash" && (0, jsx.jsx)("button", { type: "button", className: "dac-notice-action", onClick: () => undoTrashMove(notice.ids), children: t("trash.undo") }),
							(0, jsx.jsx)("button", { type: "button", "aria-label": t("notice.dismiss"), onClick: () => setNotice(null), children: (0, jsx.jsx)(IconClose, {}) })
						]
					}),
					notice !== null && notice.kind !== "ok" && (0, jsx.jsxs)("div", {
						className: "dac-notice",
						children: [
							(0, jsx.jsx)("span", { children: notice.text }),
							notice.action === "undo-trash" && (0, jsx.jsx)("button", { type: "button", className: "dac-notice-action", onClick: () => undoTrashMove(notice.ids), children: t("trash.undo") }),
							(0, jsx.jsx)("button", { type: "button", "aria-label": t("notice.dismiss"), onClick: () => setNotice(null), children: (0, jsx.jsx)(IconClose, {}) })
						]
					}),
					(sessions ?? []).length === 0 && (0, jsx.jsxs)("div", {
						className: "dac-empty",
						children: [(0, jsx.jsx)(IconArchive, {}), (0, jsx.jsx)("span", { children: t("state.empty") })]
					}),
					(sessions ?? []).length > 0 && groups.length === 0 && filtering && (0, jsx.jsx)("div", {
						className: "dac-center",
						children: t("state.emptyFiltered")
					}),
					groups.map((group) => (0, jsx.jsx)(GroupSection, {
						group,
						t,
						collapsed: collapsed[group.key] === true,
						onToggleCollapsed: toggleCollapsed,
						menuOpen: menuFor === group.key,
						onToggleMenu: setMenuFor,
							onUnarchive: unarchive,
						onDelete: askDelete,
						onExport: exportSessions,
						onPreview: openPreview,
						contentHits,
						busy,
						selectionMode,
						selected,
						onToggleSelected: toggleSelected,
						stats,
						metadataStatus,
						onEditMetadata: openMetadataEditor
							}, group.key)),
					] }),
					pageMode === "trash" && (0, jsx.jsxs)("div", { className: "dac-mode-panel", children: [
						trash.status === "loading" && (0, jsx.jsxs)("div", { className: "dac-center", children: [(0, jsx.jsx)("span", { className: "dac-spin" }), (0, jsx.jsx)("span", { children: t("trash.loading") })] }),
						trash.status === "error" && (0, jsx.jsxs)("div", { className: "dac-center", children: [
							(0, jsx.jsx)("span", { children: t("trash.unavailable") }),
							(0, jsx.jsx)("button", { type: "button", className: "dac-retry", onClick: loadTrash, children: t("state.retry") }),
						] }),
						trash.status === "ready" && trash.trashStatus !== "ready" && (0, jsx.jsx)("div", { className: "dac-warn", role: "status", children: t("trash.unavailable") }),
						trash.status === "ready" && (0, jsx.jsxs)("div", { className: "dac-trash-toolbar", children: [
							(0, jsx.jsxs)("div", { className: "dac-summary", role: "status", children: [
								(0, jsx.jsx)("span", { children: chatsCount(t, trash.sessions.length) }),
								(0, jsx.jsx)("span", { className: "dac-summary-sep", "aria-hidden": "true", children: "·" }),
								(0, jsx.jsx)("span", { children: formatBytes(trashSnapshotBytes) }),
							] }),
							(0, jsx.jsxs)("div", { className: "dac-trash-toolbar-actions", children: [
								trashSelectionMode && selectableTrashIds.length > 0 && (0, jsx.jsx)(SelectionCheckbox, {
									checked: selectedTrashIds.length === selectableTrashIds.length,
									indeterminate: selectedTrashIds.length > 0 && selectedTrashIds.length < selectableTrashIds.length,
									disabled: !trashMutationsAvailable,
									ariaLabel: t("trash.selectAll"),
									onChange: (checked) => toggleTrashSelected(selectableTrashIds, checked),
								}),
								trashSelectionMode && (0, jsx.jsx)("button", { type: "button", className: "dac-bulk-btn", disabled: selectedTrashIds.length === 0 || selectedTrashBusy || !trashMutationsAvailable, onClick: () => restoreFromTrash(selectedTrashIds), children: t("trash.restoreSelected") }),
								trashSelectionMode && (0, jsx.jsx)("button", { type: "button", className: "dac-bulk-btn dac-danger", disabled: selectedTrashIds.length === 0 || selectedTrashBusy || !trashMutationsAvailable, onClick: () => askTrashPurge(selectedTrashIds), children: t("trash.purgeSelected") }),
								(selectableTrashIds.length > 0 || trashSelectionMode) && (0, jsx.jsx)("button", {
									type: "button",
									className: "dac-selection-mode",
									onClick: trashSelectionMode ? finishTrashSelectionMode : () => setTrashSelectionMode(true),
									children: t(trashSelectionMode ? "selection.done" : "selection.start"),
								}),
								(0, jsx.jsx)("button", { type: "button", className: "dac-bulk-btn dac-danger", disabled: trashIds.length === 0 || !trashMutationsAvailable || trashIds.some((id) => trashBusy[id] === true), onClick: () => askTrashPurge(trashIds, true), children: t("trash.emptyAction") }),
							] }),
						] }),
						notice !== null && notice.kind === "ok" && (0, jsx.jsxs)("div", { className: "dac-toast", role: "status", style: { top: `${toastTop()}px` }, children: [
							(0, jsx.jsx)(IconCheckCircle, {}), (0, jsx.jsx)("span", { children: notice.text }),
							notice.action === "undo-trash" && (0, jsx.jsx)("button", { type: "button", className: "dac-notice-action", onClick: () => undoTrashMove(notice.ids), children: t("trash.undo") }),
							(0, jsx.jsx)("button", { type: "button", "aria-label": t("notice.dismiss"), onClick: () => setNotice(null), children: (0, jsx.jsx)(IconClose, {}) }),
						] }),
						notice !== null && notice.kind !== "ok" && (0, jsx.jsxs)("div", { className: "dac-notice", children: [(0, jsx.jsx)("span", { children: notice.text }), notice.action === "undo-trash" && (0, jsx.jsx)("button", { type: "button", className: "dac-notice-action", onClick: () => undoTrashMove(notice.ids), children: t("trash.undo") }), (0, jsx.jsx)("button", { type: "button", "aria-label": t("notice.dismiss"), onClick: () => setNotice(null), children: (0, jsx.jsx)(IconClose, {}) })] }),
						trash.status === "ready" && trash.sessions.length === 0 && (0, jsx.jsxs)("div", { className: "dac-empty", children: [(0, jsx.jsx)(IconTrash, { size: 40 }), (0, jsx.jsx)("span", { children: t("trash.empty") })] }),
						...trashGroups.map((group) => (0, jsx.jsx)(TrashGroupSection, {
							group, t, collapsed: collapsed[`trash:${group.key}`] === true,
							onToggleCollapsed: (key) => toggleCollapsed(`trash:${key}`),
							selectionMode: trashSelectionMode, selected: trashSelected, busy: trashBusy, mutationsAvailable: trashMutationsAvailable,
							onToggleSelected: toggleTrashSelected, onRestore: restoreFromTrash, onPurge: askTrashPurge,
							onPreview: (row) => openPreview(row, "trash"),
						}, group.key)),
					] }),
					pageMode === "insights" && (0, jsx.jsx)(StorageRetentionPanel, { t }),
					pageMode === "lineage" && (0, jsx.jsx)(ArchiveRelationshipsPanel, { t }),
						preview !== null && (0, jsx.jsx)(PreviewDialog, {
							preview,
							t,
							busy: previewBusy,
							returnFocus: previewReturnFocusRef.current,
							fallbackFocusRef: pageHeadingRef,
							onLoadMore: loadMorePreview,
							onCancel: closePreview,
						}),
						importPreview !== null && (0, jsx.jsx)(ImportDialog, {
							preview: importPreview,
							t,
							busy: importBusy,
							onToggle: toggleImportSelection,
							onSelectAll: selectAllImport,
							onClear: clearImport,
							onConfirm: restoreImport,
							onCancel: () => setImportPreview(null),
						}),
						metadataEdit !== null && (0, jsx.jsx)(MetadataDialog, {
						session: metadataEdit,
						t,
						busy: metaBusy,
						returnFocus: metaReturnFocusRef.current,
						fallbackFocusRef: pageHeadingRef,
						onSave: (tags, note) => saveMetadataFor(metadataEdit.id, tags, note),
						onCancel: () => setMetadataEdit(null)
					}),
					confirm !== null && (0, jsx.jsx)(ConfirmDialog, {
						title: confirm.title,
						body: confirm.body,
						confirmLabel: t("confirm.delete"),
						cancelLabel: t("confirm.cancel"),
						busy: confirm.ids.some((id) => busy[id] === true),
						returnFocus: deleteReturnFocusRef.current,
						fallbackFocusRef: pageHeadingRef,
						onConfirm: () => runDelete(confirm.ids, confirm.finishSelectionAfter === true),
						onCancel: () => setConfirm(null)
					}),
					trashConfirm !== null && (0, jsx.jsx)(ConfirmDialog, {
						title: trashConfirm.title,
						body: trashConfirm.body,
						confirmLabel: t(trashConfirm.empty ? "trash.emptyAction" : "trash.purge"),
						cancelLabel: t("confirm.cancel"),
						busy: trashConfirm.ids.some((id) => trashBusy[id] === true),
						returnFocus: trashReturnFocusRef.current,
						fallbackFocusRef: pageHeadingRef,
						onConfirm: trashConfirm.empty ? emptyRecycleBin : () => purgeFromTrash(trashConfirm.ids),
						onCancel: () => setTrashConfirm(null),
					})
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
				try { ctx.get("sessions")?.refresh?.(); } catch { /* sidebar converges on next reconnect */ }
			};
			const workspaces = ctx.get("workspaces");
			const archiveNotice = createArchiveNoticeController({
				durationMs: 3000,
				undo: async (sessionId) => {
					await post("/unarchive", { sessionId });
					await workspaces?.refresh?.();
				},
				view: async () => openArchiveSettings(t),
			});
			ctx.effect(() => installArchiveNoticeInterceptor(workspaces, archiveNotice), "archived-chats: archive success notice");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "archived-chats",
				order: 30,
				label: () => t("nav"),
				locale: SETTINGS_NS,
				inject: () => ({ refreshSidebar })
			}, ArchivedChatsSection));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "archived-chats-success",
				order: 30,
				locale: SETTINGS_NS,
				inject: () => ({ controller: archiveNotice })
			}, ArchiveNoticeOverlay));
		}
		//#endregion

		exports.SETTINGS_NS = SETTINGS_NS;
			exports.__test = { formatBytes, matchesArchivedSession, filterByTag, sortArchivedSessions, setVisibleSelection, reconcileSelection, uniqueSessionIds, createArchiveNoticeController, installArchiveNoticeInterceptor, openArchiveSettings, ArchiveNoticeOverlay, defaultRetentionSelection, filterLineageForest, SnapshotInsightRows, LineageTreeNodes, StorageRetentionPanel, ArchiveRelationshipsPanel, groupTrashSessions, trashStatusLabel, markArchiveDialog, submitExport, submitImportFile, fetchTrash, fetchInsights, saveRetentionPolicy, previewRetention, applyRetention, fetchLineage, restoreTrash, purgeTrash, emptyTrash, fetchArchivePreview, fetchArchiveImage, fetchArchiveSearch, buildPreviewNodes, previewCopyText, groupPreviewSegments, resolvePreviewPrimitives, PreviewMarkdown, PreviewReasoning, PreviewImage, editIconSpec: EDIT_ICON_SPEC };
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
