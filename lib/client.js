// dsh-archived-chats — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-archived-chats/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with require()
// resolved against the shell's module table — the same shape the shipped ui-*
// packages emit.
//
// What this plugin is: one settings section — 已归档的聊天 / Archived Chats —
// modeled 1:1 on the CodeX archived-chats page. The stock DSH sidebar hides
// archived sessions with no list surface; this page restores one: search,
// type/project filters, sorting, multi-selection, unarchive, delete, and
// batch actions, all driven through the host half's /plugins/dsh-archived-chats/*
// routes (the archive set itself lives in the host's workspace registry).
window.__ModuleLoader__.load({
	id: "dsh-archived-chats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let jsx = require("react/jsx-runtime");
		let _react = require("react");

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
			"nav": "已归档的聊天",
				"page.title": "已归档的聊天",
				"action.import": "导入",
				"action.export": "导出",
				"action.more": "更多",
				"delete.all": "全部删除",
				"import.action": "导入备份",
				"import.backup": "导入 DSH 备份",
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
				"export.backup": "导出 DSH 备份",
				"export.selected": "导出选中项",
				"export.row": "导出备份",
				"export.started": "已开始下载备份",
				"interop.source.label": "外部来源",
				"interop.source.codex": "Codex",
				"interop.source.claude": "Claude Code",
				"interop.import.action": "从外部工具导入",
				"interop.import.codex": "从 Codex 导入",
				"interop.import.claude": "从 Claude Code 导入",
				"interop.import.title": "导入外部聊天",
				"interop.import.preview": "确认转换报告和要恢复的会话",
				"interop.import.confirm": "导入选中项",
				"interop.report": "转换报告",
				"interop.sessions": "会话",
				"interop.losses": "信息损失",
				"interop.conflicts": "冲突",
				"interop.warnings": "警告",
				"interop.fidelity": "保真度",
				"interop.fidelity.high": "高保真转换",
				"interop.fidelity.readable": "可读迁移",
				"interop.lossWarning": "该会话包含无法完整转换的信息",
				"interop.expired": "外部导入预览已过期，请重新选择文件",
				"interop.done": "外部聊天导入完成",
				"interop.export.action": "导出到外部工具",
				"interop.export.codex": "导出为 Codex",
				"interop.export.claude": "导出为 Claude Code",
				"interop.export.title": "导出外部格式",
				"interop.export.preview": "下载前请确认目标格式和保真限制",
				"interop.export.target": "目标格式",
				"interop.export.download": "下载 JSONL",
				"interop.export.nativeUnsupported": "不支持原生继续；输出用于阅读、迁移或交接",
				"interop.export.started": "已开始下载外部 JSONL",
				"interop.diagnostic.unsupported-message-role": "不支持的消息角色",
				"interop.diagnostic.message-invalid": "无效消息",
				"interop.diagnostic.native-resume-unsupported": "不支持原生继续",
				"interop.diagnostic.transcript-handoff": "仅用于阅读或交接",
				"interop.diagnostic.attachments-not-included": "未包含附件文件",
			"search.placeholder": "搜索已归档聊天",
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
			"bulk.delete": "删除",
			"group.noProject": "未分组",
			"chat.untitled": "未命名会话",
			"chat.unarchive": "取消归档",
			"menu.unarchiveAll": "全部取消归档",
			"menu.deleteAll": "全部删除",
			"group.collapse": "折叠",
			"group.expand": "展开",
			"confirm.deleteOne.title": "删除已归档聊天？",
			"confirm.deleteOne.body": "这将永久删除已归档聊天",
			"confirm.deleteAll.title": "删除全部已归档聊天？",
			"confirm.deleteGroup.title": "删除该项目下的已归档聊天？",
			"confirm.deleteSelected.title": "删除选中的已归档聊天？",
			"confirm.cancel": "取消",
			"confirm.delete": "删除",
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
			"nav": "Archived Chats",
				"page.title": "Archived Chats",
				"action.import": "Import",
				"action.export": "Export",
				"action.more": "More",
				"delete.all": "Delete All",
				"import.action": "Import backup",
				"import.backup": "Import DSH backup",
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
				"export.backup": "Export DSH backup",
				"export.selected": "Export selected",
				"export.row": "Export backup",
				"export.started": "Backup download started",
				"interop.source.label": "External source",
				"interop.source.codex": "Codex",
				"interop.source.claude": "Claude Code",
				"interop.import.action": "Import from external tool",
				"interop.import.codex": "Import from Codex",
				"interop.import.claude": "Import from Claude Code",
				"interop.import.title": "Import external chats",
				"interop.import.preview": "Review the conversion report and sessions to restore",
				"interop.import.confirm": "Import selected",
				"interop.report": "Conversion report",
				"interop.sessions": "Sessions",
				"interop.losses": "Information losses",
				"interop.conflicts": "Conflicts",
				"interop.warnings": "Warnings",
				"interop.fidelity": "Fidelity",
				"interop.fidelity.high": "High-fidelity conversion",
				"interop.fidelity.readable": "Readable migration",
				"interop.lossWarning": "This session contains information that cannot be converted completely",
				"interop.expired": "The external import preview expired. Choose the file again",
				"interop.done": "External chat import completed",
				"interop.export.action": "Export to external tool",
				"interop.export.codex": "Export as Codex",
				"interop.export.claude": "Export as Claude Code",
				"interop.export.title": "Export external format",
				"interop.export.preview": "Review the target format and fidelity limits before downloading",
				"interop.export.target": "Target format",
				"interop.export.download": "Download JSONL",
				"interop.export.nativeUnsupported": "Native resume is not supported; use the output for reading, migration, or handoff",
				"interop.export.started": "External JSONL download started",
				"interop.diagnostic.unsupported-message-role": "Unsupported message role",
				"interop.diagnostic.message-invalid": "Invalid message",
				"interop.diagnostic.native-resume-unsupported": "Native resume unsupported",
				"interop.diagnostic.transcript-handoff": "Reading or handoff only",
				"interop.diagnostic.attachments-not-included": "Attachment files omitted",
			"search.placeholder": "Search archived chats",
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
			"bulk.delete": "Delete",
			"group.noProject": "Ungrouped",
			"chat.untitled": "Untitled chat",
			"chat.unarchive": "Unarchive",
			"menu.unarchiveAll": "Unarchive all",
			"menu.deleteAll": "Delete all",
			"group.collapse": "Collapse",
			"group.expand": "Expand",
			"confirm.deleteOne.title": "Delete archived chat?",
			"confirm.deleteOne.body": "This permanently deletes the archived chat",
			"confirm.deleteAll.title": "Delete all archived chats?",
			"confirm.deleteGroup.title": "Delete this project's archived chats?",
			"confirm.deleteSelected.title": "Delete selected archived chats?",
			"confirm.cancel": "Cancel",
			"confirm.delete": "Delete",
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
			? `这将永久删除全部 ${n} 个已归档聊天`
			: `This permanently deletes all ${n} archived chat${n === 1 ? "" : "s"}`;
		const deleteGroupBody = (t, name, n) => isZh(t)
			? `这将永久删除「${name}」下 ${n} 个已归档聊天`
			: `This permanently deletes ${n} archived chat${n === 1 ? "" : "s"} under "${name}"`;
		const deleteSelectedBody = (t, n) => isZh(t)
			? `这将永久删除选中的 ${n} 个已归档聊天`
			: `This permanently deletes the ${n} selected archived chat${n === 1 ? "" : "s"}`;
		const selectedCount = (t, n) => isZh(t)
			? `已选择 ${n} 个聊天`
			: `${n} chat${n === 1 ? "" : "s"} selected`;
		const selectChatLabel = (t, title) => isZh(t) ? `选择 ${title}` : `Select ${title}`;
		const selectProjectLabel = (t, title) => `${t("selection.group")}${isZh(t) ? "：" : ": "}${title}`;
		const removeTagLabel = (t, tag) => isZh(t) ? `移除标签 ${tag}` : `Remove tag ${tag}`;
		const failureText = (t, failed) => {
			if (isZh(t)) return `${failed.length} 个会话删除失败：${failed[0]?.message ?? ""}`;
			return `${failed.length} chat${failed.length === 1 ? "" : "s"} failed to delete: ${failed[0]?.message ?? ""}`;
		};
		const pendingText = (t, n) => isZh(t)
			? `${n} 个会话已停用，将在重启 DSH 后彻底删除`
			: n === 1
				? "1 chat is parked and will be permanently deleted after DSH restarts"
				: `${n} chats are parked and will be permanently deleted after DSH restarts`;
		// Success confirmation after a completed delete — same copy as CodeX.
		const deletedText = (t, n) => isZh(t)
			? "已删除归档聊天"
			: n === 1 ? "Archived chat deleted" : `${n} archived chats deleted`;
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
.dac-action-wrap{position:relative;display:inline-flex}
.dac-action-trigger{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:5px 11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.dac-action-trigger:hover:not(:disabled),.dac-action-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-action-trigger:disabled{opacity:.45;cursor:default}
.dac-action-trigger .dac-action-chevron{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
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
.dac-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dac-select-wrap{position:relative;display:inline-flex;align-items:center}
.dac-select{appearance:none;-webkit-appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 28px 5px 14px;cursor:pointer;outline:none}
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
.dac-meta-dialog{width:min(440px,calc(100vw - 64px))}
.dac-import-dialog{width:min(560px,calc(100vw - 48px));max-height:min(700px,calc(100vh - 48px));overflow:auto}
.dac-import-package{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dac-import-package strong{grid-column:1/-1;color:var(--dsw-alias-label-primary);font-size:13px}
.dac-import-list{display:flex;flex-direction:column;gap:8px;max-height:360px;overflow:auto}
.dac-import-selection{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
.dac-import-row{display:flex;align-items:flex-start;gap:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px;cursor:pointer}
.dac-import-row.dac-import-conflict{opacity:.58;cursor:default}
.dac-import-main{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.dac-import-main span{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dac-import-main small{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.dac-import-result{display:flex;gap:14px;color:var(--dsw-alias-state-success-primary);font-size:13px;line-height:20px}
.dac-interop-report{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dac-interop-report strong{grid-column:1/-1;color:var(--dsw-alias-label-primary);font-size:13px}
.dac-interop-report .dac-interop-fidelity{grid-column:1/-1;color:var(--dsw-alias-state-success-primary)}
.dac-interop-details{display:flex;flex-direction:column;gap:3px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dac-interop-limit{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
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
@media (max-width:640px){[role="dialog"][data-dac-section-active="1"]>nav{display:none}[role="dialog"][data-dac-section-active="1"]>nav+div{width:100%;min-width:0}.dac-head{align-items:flex-start;flex-wrap:wrap}.dac-head-actions{width:100%;justify-content:flex-start}.dac-action-trigger{padding:5px 9px}.dac-action-menu{left:0;right:auto;max-width:calc(100vw - 32px)}.dac-action-wrap:last-child .dac-action-menu{left:auto;right:0}.dac-selection-controls{width:100%;justify-content:space-between}.dac-bulkbar{align-items:flex-start;flex-direction:column}.dac-bulk-actions{width:100%;flex-wrap:wrap}.dac-row{align-items:flex-start}.dac-row-actions{gap:4px}.dac-unarchive{padding:5px 10px}.dac-summary{gap:6px}.dac-row-meta{gap:4px}}
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
		const NAV_LABELS = ["已归档的聊天", "Archived Chats"];
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

			async function submitInteropFile(file, source) {
				if (file === null || file === undefined) throw new Error("JSONL file is required");
				const normalizedSource = source === "claude" ? "claude" : "codex";
				const body = new FormData();
				body.append("source", normalizedSource);
				body.append("file", file, file.name || `${normalizedSource}.jsonl`);
				const res = await fetch(`${API_BASE}/interop/inspect`, {
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

			function downloadFilename(disposition, fallback) {
				const encoded = String(disposition ?? "").match(/filename\*=UTF-8''([^;]+)/i)?.[1];
				if (encoded) {
					try { return decodeURIComponent(encoded); } catch { /* use the ASCII fallback */ }
				}
				return String(disposition ?? "").match(/filename="?([^";]+)"?/i)?.[1] ?? fallback;
			}

			async function downloadInteropExport(sessionIds, target) {
				if (typeof document === "undefined") return false;
				const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
					.filter((id) => typeof id === "string" && id !== ""))];
				if (ids.length === 0) return false;
				const normalizedTarget = target === "claude" ? "claude" : "codex";
				const body = new URLSearchParams({ sessionIds: JSON.stringify(ids), target: normalizedTarget });
				const res = await fetch(`${API_BASE}/interop/export`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded", [GUARD_HEADER]: "1" },
					body,
				});
				if (!res.ok) {
					const parsed = await res.json().catch(() => ({}));
					const error = new Error(parsed.message || parsed.error || `HTTP ${res.status}`);
					error.body = parsed;
					throw error;
				}
				const blob = await res.blob();
				const href = URL.createObjectURL(blob);
				const anchor = document.createElement("a");
				anchor.href = href;
				anchor.download = downloadFilename(res.headers?.get?.("content-disposition"), `dsh-archived-chats-${normalizedTarget}.jsonl`);
				anchor.hidden = true;
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
				setTimeout(() => URL.revokeObjectURL(href), 0);
				return true;
			}

			async function submitInteropExportPreview(sessionIds, target) {
				const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
					.filter((id) => typeof id === "string" && id !== ""))];
				if (ids.length === 0) throw new Error("At least one session is required");
				const normalizedTarget = target === "claude" ? "claude" : "codex";
				const body = new URLSearchParams({ sessionIds: JSON.stringify(ids), target: normalizedTarget, preview: "1" });
				const res = await fetch(`${API_BASE}/interop/export`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded", [GUARD_HEADER]: "1" },
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

		async function post(path, body) {
			const res = await fetch(`${API_BASE}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", [GUARD_HEADER]: "1" },
				body: JSON.stringify(body)
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
		function Select({ value, onChange, options, ariaLabel }) {
			return (0, jsx.jsxs)("span", {
				className: "dac-select-wrap",
				children: [
					(0, jsx.jsx)("select", {
						className: "dac-select",
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
			_react.useEffect(() => {
				const previousFocus = returnFocus ?? document.activeElement;
				const dialog = dialogRef.current;
				(cancelRef.current ?? dialog)?.focus?.();
				const onKey = (e) => {
					if (e.key === "Escape") {
						e.preventDefault?.();
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
				if (warning === "interop-losses") return t("interop.lossWarning");
				return warning;
			}

			function interopDiagnosticText(t, item) {
				const code = typeof item?.code === "string" && item.code !== "" ? item.code : "unknown";
				const key = `interop.diagnostic.${code}`;
				const translated = t(key);
				const label = translated === key ? code : translated;
				const count = Number.isSafeInteger(item?.count) && item.count > 0 ? item.count : 1;
				const detail = typeof item?.detail === "string" && item.detail !== "" ? ` · ${item.detail}` : "";
				return `${label} ×${count}${detail}`;
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
				const interop = preview?.kind === "interop";
				const titleId = interop ? "dac-interop-import-title" : "dac-import-title";
				const descriptionId = interop ? "dac-interop-import-description" : "dac-import-description";
				const generator = preview?.package?.generator;
				const generatorName = typeof generator === "string" ? generator : generator?.name ?? "dsh-archived-chats";
				const generatorVersion = typeof generator === "object" ? generator?.version : undefined;
				const packageVersion = preview?.package?.version ?? "1";
				const packageLabel = generatorVersion
					? `${generatorName} v${generatorVersion} · format v${packageVersion}`
					: `${generatorName} · v${packageVersion}`;
				const reportSummary = preview?.report?.summary ?? {};
				const metric = (label, value) => `${label}${isZh(t) ? "：" : ": "}${Number(value ?? 0)}`;
				const fidelity = Number(reportSummary.losses ?? 0) === 0 ? t("interop.fidelity.high") : t("interop.fidelity.readable");
				return (0, jsx.jsx)("div", {
					className: "dac-confirm-overlay",
					onClick: onCancel,
					children: (0, jsx.jsxs)("div", {
						ref: dialogRef,
						className: "dac-confirm dac-import-dialog",
						role: "dialog",
						"aria-modal": "true",
						"aria-labelledby": titleId,
						"aria-describedby": descriptionId,
						tabIndex: -1,
						onClick: (event) => event.stopPropagation(),
						children: [
							(0, jsx.jsx)("div", { id: titleId, className: "dac-confirm-title", children: interop ? t("interop.import.title") : t("import.title") }),
							(0, jsx.jsx)("div", { id: descriptionId, className: "dac-confirm-body", children: result ? (interop ? t("interop.done") : t("import.done")) : (interop ? t("interop.import.preview") : t("import.preview")) }),
							!result && interop && (0, jsx.jsxs)("div", { className: "dac-interop-report", children: [
								(0, jsx.jsx)("strong", { children: t("interop.report") }),
								(0, jsx.jsx)("span", { children: metric(t("interop.sessions"), reportSummary.sessions ?? sessions.length) }),
								(0, jsx.jsx)("span", { children: metric(t("interop.losses"), reportSummary.losses) }),
								(0, jsx.jsx)("span", { children: metric(t("interop.conflicts"), reportSummary.conflicts) }),
								(0, jsx.jsx)("span", { children: metric(t("interop.warnings"), reportSummary.warnings) }),
								(0, jsx.jsx)("span", { className: "dac-interop-fidelity", children: `${t("interop.fidelity")}${isZh(t) ? "：" : ": "}${fidelity}` }),
							] }),
							!result && !interop && (0, jsx.jsxs)("div", { className: "dac-import-package", children: [
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
								!result && (0, jsx.jsx)("button", { type: "button", className: "dac-btn-primary", disabled: busy || selected.size === 0, onClick: onConfirm, children: busy ? t("import.inspecting") : (interop ? t("interop.import.confirm") : t("import.confirm")) }),
							] })
						]
					})
				});
			}

			function InteropExportDialog({ count, target, report, t, busy, onTarget, onConfirm, onCancel }) {
				const dialogRef = _react.useRef(null);
				const cancelRef = _react.useRef(null);
				const summary = report?.summary ?? {};
				const lossCount = Number(summary.losses ?? 0);
				const warningCount = Number(summary.warnings ?? 0);
				const losses = Array.isArray(report?.losses) ? report.losses : [];
				const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
				_react.useEffect(() => {
					(cancelRef.current ?? dialogRef.current)?.focus?.();
					const onKey = (event) => {
						if (event.key === "Escape") { event.preventDefault?.(); onCancel(); }
					};
					document.addEventListener("keydown", onKey);
					return () => document.removeEventListener("keydown", onKey);
				}, [onCancel]);
				return (0, jsx.jsx)("div", {
					className: "dac-confirm-overlay",
					onClick: onCancel,
					children: (0, jsx.jsxs)("div", {
						ref: dialogRef,
						className: "dac-confirm dac-import-dialog",
						role: "dialog",
						"aria-modal": "true",
						"aria-labelledby": "dac-interop-export-title",
						"aria-describedby": "dac-interop-export-description",
						tabIndex: -1,
						onClick: (event) => event.stopPropagation(),
						children: [
							(0, jsx.jsx)("div", { id: "dac-interop-export-title", className: "dac-confirm-title", children: t("interop.export.title") }),
							(0, jsx.jsx)("div", { id: "dac-interop-export-description", className: "dac-confirm-body", children: t("interop.export.preview") }),
							(0, jsx.jsx)(Select, {
								value: target,
								onChange: onTarget,
								ariaLabel: t("interop.export.target"),
								options: [
									{ value: "codex", label: t("interop.source.codex") },
									{ value: "claude", label: t("interop.source.claude") },
								],
							}),
							(0, jsx.jsxs)("div", { className: "dac-interop-report", children: [
								(0, jsx.jsx)("strong", { children: t("interop.report") }),
								(0, jsx.jsx)("span", { children: `${t("interop.sessions")}${isZh(t) ? "：" : ": "}${Number(summary.sessions ?? count)}` }),
								(0, jsx.jsx)("span", { children: `${t("interop.losses")}${isZh(t) ? "：" : ": "}${lossCount}` }),
								(0, jsx.jsx)("span", { children: `${t("interop.warnings")}${isZh(t) ? "：" : ": "}${warningCount}` }),
								(0, jsx.jsx)("span", { className: "dac-interop-fidelity", children: `${t("interop.fidelity")}${isZh(t) ? "：" : ": "}${t(lossCount === 0 ? "interop.fidelity.high" : "interop.fidelity.readable")}` }),
							] }),
							(losses.length > 0 || warnings.length > 0) && (0, jsx.jsx)("div", { className: "dac-interop-details", children: [...losses, ...warnings].map((item, index) => (0, jsx.jsx)("span", { children: interopDiagnosticText(t, item) }, `${item?.code ?? "diagnostic"}-${index}`)) }),
							(0, jsx.jsx)("div", { className: "dac-interop-limit", children: t("interop.export.nativeUnsupported") }),
							(0, jsx.jsxs)("div", { className: "dac-confirm-actions", children: [
								(0, jsx.jsx)("button", { ref: cancelRef, type: "button", className: "dac-btn", onClick: onCancel, children: t("import.cancel") }),
								(0, jsx.jsx)("button", { type: "button", className: "dac-btn-primary", disabled: busy || report == null, onClick: onConfirm, children: t("interop.export.download") }),
							] }),
						]
					})
				});
			}

			function GroupSection({ group, t, collapsed, onToggleCollapsed, menuOpen, onToggleMenu, onUnarchive, onDelete, onExport, busy, selectionMode, selected, onToggleSelected, stats, metadataStatus, onEditMetadata }) {
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
													})
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

		/** The settings section page: archived chats, CodeX-layout. */
		function ArchivedChatsSection({ t, refreshSidebar }) {
			const [sessions, setSessions] = _react.useState(null);
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
				const [interop, setInterop] = _react.useState(() => ({ source: "codex", target: "codex", busy: false, preview: null, exportIds: null, exportReport: null }));
				const [selectionMode, setSelectionMode] = _react.useState(false);
				const [actionMenu, setActionMenu] = _react.useState(null);
				const pageRef = _react.useRef(null);
			const pageHeadingRef = _react.useRef(null);
				const actionMenuRef = _react.useRef(null);
				const importActionRef = _react.useRef(null);
				const exportActionRef = _react.useRef(null);
				const moreActionRef = _react.useRef(null);
			const deleteReturnFocusRef = _react.useRef(null);
				const metaReturnFocusRef = _react.useRef(null);
				const importInputRef = _react.useRef(null);
				const interopInputRef = _react.useRef(null);
				const interopImportSourceRef = _react.useRef("codex");

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
				const trigger = actionMenu === "import" ? importActionRef.current : actionMenu === "export" ? exportActionRef.current : moreActionRef.current;
				setActionMenu(null);
				trigger?.focus?.();
			};

			_react.useEffect(() => {
				if (sessions === null || loadError !== null) return undefined;
				return markArchiveDialog(pageRef.current);
			}, [sessions, loadError]);

			// Success confirmations are transient toasts (CodeX behavior);
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
					const deleted = result.deleted ?? [];
					const pending = result.pending ?? [];
					const failed = result.failed ?? [];
					if (deleted.length > 0 || pending.length > 0) {
						changed = true;
						const removed = [...deleted, ...pending];
						// Pending rows leave the list too: the deletion is accepted,
						// the session is parked and excluded from /state until the
						// next-boot sweep physically removes it.
						setSessions((prev) => (prev ?? []).filter((s) => !removed.includes(s.id)));
						setSelected((current) => setVisibleSelection(current, removed, false));
					}
					if (failed.length > 0) setNotice({ kind: "error", text: failureText(t, failed) });
					else if (pending.length > 0) setNotice({ kind: "error", text: pendingText(t, pending.length) });
					else if (deleted.length > 0) setNotice({ kind: "ok", text: deletedText(t, deleted.length) });
					if (finishSelectionAfter && failed.length === 0 && deleted.length + pending.length === ids.length) finishSelectionMode();
				} catch (error) {
					const deleted = error.body?.deleted ?? [];
					const pending = error.body?.pending ?? [];
					const failed = error.body?.failed ?? [];
					if (deleted.length > 0 || pending.length > 0) {
						changed = true;
						const removed = [...deleted, ...pending];
						setSessions((prev) => (prev ?? []).filter((s) => !removed.includes(s.id)));
						setSelected((current) => setVisibleSelection(current, removed, false));
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

				const interopFile = async (file, source = interopImportSourceRef.current) => {
					if (!file) return;
					const normalizedSource = source === "claude" ? "claude" : "codex";
					setInterop((current) => ({ ...current, source: normalizedSource, busy: true }));
					setNotice(null);
					try {
						const inspected = await submitInteropFile(file, normalizedSource);
						const previewSessions = (Array.isArray(inspected.sessions) ? inspected.sessions : []).map((session) => {
							const warnings = [];
							if (session.hasAttachmentReferences === true || Array.isArray(session.attachments) && session.attachments.length > 0) warnings.push("attachments-not-included");
							if (Number(session.lossCount ?? 0) > 0 || Array.isArray(session.losses) && session.losses.length > 0) warnings.push("interop-losses");
							return {
								id: session.id,
								title: session.title,
								workspace: session.workspace ?? null,
								conflict: session.conflict === true,
								warnings,
							};
						});
						const report = {
							source: inspected.report?.source ?? normalizedSource,
							summary: {
								sessions: Number(inspected.report?.summary?.sessions ?? previewSessions.length),
								losses: Number(inspected.report?.summary?.losses ?? 0),
								conflicts: Number(inspected.report?.summary?.conflicts ?? previewSessions.filter((session) => session.conflict).length),
								warnings: Number(inspected.report?.summary?.warnings ?? 0),
							},
						};
						setInterop((current) => ({
							...current,
							preview: {
								kind: "interop",
								token: inspected.token,
								nonce: inspected.nonce,
								expiresAt: inspected.expiresAt,
								report,
								sessions: previewSessions,
								selectedIds: previewSessions.filter((session) => !session.conflict).map((session) => session.id),
								result: null,
							},
						}));
					} catch (error) {
						setNotice({ kind: "error", text: String(error.message ?? error) });
					} finally {
						setInterop((current) => ({ ...current, busy: false }));
					}
				};
				const chooseInteropImport = (source) => {
					const normalizedSource = source === "claude" ? "claude" : "codex";
					interopImportSourceRef.current = normalizedSource;
					setInterop((current) => ({ ...current, source: normalizedSource }));
					setActionMenu(null);
					interopInputRef.current?.click?.();
				};

				const restoreInterop = async () => {
					const preview = interop.preview;
					if (!preview || preview.selectedIds.length === 0) return;
					setInterop((current) => ({ ...current, busy: true }));
					try {
						const result = await post("/import/restore", {
							token: preview.token,
							nonce: preview.nonce,
							sessionIds: preview.selectedIds,
						});
						setInterop((current) => ({ ...current, preview: current.preview ? { ...current.preview, result } : null }));
						await refresh();
						refreshSidebar?.();
						setNotice({ kind: "ok", text: t("interop.done") });
					} catch (error) {
						const code = error.body?.error;
						setNotice({ kind: "error", text: code === "import-token-invalid" ? t("interop.expired") : String(error.message ?? error) });
					} finally {
						setInterop((current) => ({ ...current, busy: false }));
					}
				};

				const toggleInteropSelection = (id, checked) => setInterop((current) => {
					if (!current.preview) return current;
					const selectedIds = new Set(current.preview.selectedIds ?? []);
					if (checked) selectedIds.add(id); else selectedIds.delete(id);
					return { ...current, preview: { ...current.preview, selectedIds: [...selectedIds] } };
				});
				const selectAllInterop = () => setInterop((current) => current.preview ? {
					...current,
					preview: { ...current.preview, selectedIds: current.preview.sessions.filter((session) => !session.conflict).map((session) => session.id) },
				} : current);
				const clearInterop = () => setInterop((current) => current.preview ? { ...current, preview: { ...current.preview, selectedIds: [] } } : current);
				const loadInteropExportPreview = async (ids, target = interop.target) => {
					if (!Array.isArray(ids) || ids.length === 0) return;
					setInterop((current) => ({ ...current, target, exportIds: ids, exportReport: null, busy: true }));
					setNotice(null);
					try {
						const inspected = await submitInteropExportPreview(ids, target);
						setInterop((current) => ({ ...current, exportReport: inspected.report ?? null }));
					} catch (error) {
						setNotice({ kind: "error", text: String(error.message ?? error) });
						setInterop((current) => ({ ...current, exportIds: null, exportReport: null }));
					} finally {
						setInterop((current) => ({ ...current, busy: false }));
					}
				};
				const changeInteropExportTarget = (target) => {
					if (!Array.isArray(interop.exportIds) || interop.exportIds.length === 0) {
						setInterop((current) => ({ ...current, target }));
						return;
					}
					void loadInteropExportPreview(interop.exportIds, target);
				};
				const runInteropExport = async () => {
					if (!Array.isArray(interop.exportIds) || interop.exportIds.length === 0 || interop.exportReport === null) return;
					const finishSelectionAfter = selectionMode && selectedIds.length > 0;
					setInterop((current) => ({ ...current, busy: true }));
					setNotice(null);
					try {
						await downloadInteropExport(interop.exportIds, interop.target);
						setInterop((current) => ({ ...current, exportIds: null, exportReport: null }));
						setNotice({ kind: "ok", text: t("interop.export.started") });
						if (finishSelectionAfter) finishSelectionMode();
					} catch (error) {
						setNotice({ kind: "error", text: String(error.message ?? error) });
					} finally {
						setInterop((current) => ({ ...current, busy: false }));
					}
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
					if (query.trim() !== "" && !matchesArchivedSession(s, query, locale)) return false;
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
			}, [sessions, query, projectFilter, typeFilter, tagFilter, sortMode, t]);

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

			return (0, jsx.jsxs)("div", {
				ref: pageRef,
				className: "dac-page",
				children: [
					(0, jsx.jsxs)("div", {
						className: "dac-head",
						children: [
							(0, jsx.jsx)("h2", { ref: pageHeadingRef, tabIndex: -1, className: "dac-title", children: t("page.title") }),
								(0, jsx.jsxs)("div", {
									ref: actionMenuRef,
									className: "dac-head-actions",
									onKeyDown: closeActionMenuFromKeyboard,
									children: [
										(0, jsx.jsxs)("div", { className: "dac-action-wrap", children: [
											(0, jsx.jsxs)("button", {
												ref: importActionRef,
												type: "button",
												className: "dac-action-trigger",
												"aria-controls": "dac-import-actions",
												"aria-expanded": actionMenu === "import",
												onClick: () => setActionMenu((current) => current === "import" ? null : "import"),
												children: [(0, jsx.jsx)(IconUpload, {}), (0, jsx.jsx)("span", { children: t("action.import") }), (0, jsx.jsx)("span", { className: "dac-action-chevron", children: (0, jsx.jsx)(IconChevron, {}) })]
											}),
											actionMenu === "import" && (0, jsx.jsxs)("div", { id: "dac-import-actions", className: "dac-action-menu", children: [
												(0, jsx.jsx)("button", { type: "button", className: "dac-action-menu-item", disabled: importBusy, onClick: () => { setActionMenu(null); importInputRef.current?.click?.(); }, children: t("import.backup") }),
												(0, jsx.jsx)("button", { type: "button", className: "dac-action-menu-item", disabled: interop.busy, onClick: () => chooseInteropImport("codex"), children: t("interop.import.codex") }),
												(0, jsx.jsx)("button", { type: "button", className: "dac-action-menu-item", disabled: interop.busy, onClick: () => chooseInteropImport("claude"), children: t("interop.import.claude") })
											] })
										] }),
										(0, jsx.jsxs)("div", { className: "dac-action-wrap", children: [
											(0, jsx.jsxs)("button", {
												ref: exportActionRef,
												type: "button",
												className: "dac-action-trigger",
												disabled: allIds.length === 0,
												"aria-controls": "dac-export-actions",
												"aria-expanded": actionMenu === "export",
												onClick: () => setActionMenu((current) => current === "export" ? null : "export"),
												children: [(0, jsx.jsx)(IconDownload, {}), (0, jsx.jsx)("span", { children: t("action.export") }), (0, jsx.jsx)("span", { className: "dac-action-chevron", children: (0, jsx.jsx)(IconChevron, {}) })]
											}),
											actionMenu === "export" && (0, jsx.jsxs)("div", { id: "dac-export-actions", className: "dac-action-menu", children: [
												(0, jsx.jsx)("button", { type: "button", className: "dac-action-menu-item", disabled: allBusy, onClick: () => { const didExport = exportSessions(selectedIds.length > 0 ? selectedIds : allIds); setActionMenu(null); if (didExport && selectedIds.length > 0) finishSelectionMode(); }, children: t("export.backup") }),
												(0, jsx.jsx)("button", { type: "button", className: "dac-action-menu-item", disabled: interop.busy, onClick: () => { setActionMenu(null); void loadInteropExportPreview(selectedIds.length > 0 ? selectedIds : allIds, "codex"); }, children: t("interop.export.codex") }),
												(0, jsx.jsx)("button", { type: "button", className: "dac-action-menu-item", disabled: interop.busy, onClick: () => { setActionMenu(null); void loadInteropExportPreview(selectedIds.length > 0 ? selectedIds : allIds, "claude"); }, children: t("interop.export.claude") })
											] })
										] }),
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
									(0, jsx.jsx)("input", {
										ref: interopInputRef,
										type: "file",
										accept: ".jsonl,application/jsonl,application/x-ndjson,text/plain",
										hidden: true,
									onChange: (event) => { const file = event.target.files?.[0]; void interopFile(file, interopImportSourceRef.current); event.target.value = ""; }
									}),
								]
							}),
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
							})
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
							(0, jsx.jsx)("button", { type: "button", "aria-label": t("notice.dismiss"), onClick: () => setNotice(null), children: (0, jsx.jsx)(IconClose, {}) })
						]
					}),
					notice !== null && notice.kind !== "ok" && (0, jsx.jsxs)("div", {
						className: "dac-notice",
						children: [
							(0, jsx.jsx)("span", { children: notice.text }),
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
						busy,
						selectionMode,
						selected,
						onToggleSelected: toggleSelected,
						stats,
						metadataStatus,
						onEditMetadata: openMetadataEditor
							}, group.key)),
						interop.preview !== null && (0, jsx.jsx)(ImportDialog, {
							preview: interop.preview,
							t,
							busy: interop.busy,
							onToggle: toggleInteropSelection,
							onSelectAll: selectAllInterop,
							onClear: clearInterop,
							onConfirm: restoreInterop,
							onCancel: () => setInterop((current) => ({ ...current, preview: null })),
						}),
						interop.exportIds !== null && (0, jsx.jsx)(InteropExportDialog, {
							count: interop.exportIds.length,
							target: interop.target,
							report: interop.exportReport,
							t,
							busy: interop.busy,
							onTarget: changeInteropExportTarget,
							onConfirm: runInteropExport,
							onCancel: () => setInterop((current) => ({ ...current, exportIds: null, exportReport: null })),
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
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "archived-chats",
				order: 30,
				label: () => t("nav"),
				locale: SETTINGS_NS,
				inject: () => ({ refreshSidebar })
			}, ArchivedChatsSection));
		}
		//#endregion

		exports.SETTINGS_NS = SETTINGS_NS;
		exports.__test = { formatBytes, matchesArchivedSession, filterByTag, sortArchivedSessions, setVisibleSelection, reconcileSelection, markArchiveDialog, submitExport, submitImportFile, submitInteropFile, submitInteropExportPreview, downloadInteropExport, editIconSpec: EDIT_ICON_SPEC };
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
