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
// type/project filters, per-workspace grouping, unarchive, delete, and
// delete-all, all driven through the host half's /plugins/dsh-archived-chats/*
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
			"delete.all": "全部删除",
			"search.placeholder": "搜索已归档聊天",
			"filter.allChats": "全部聊天",
			"filter.normal": "普通会话",
			"filter.subagent": "子代理会话",
			"filter.allProjects": "所有项目",
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
			"confirm.cancel": "取消",
			"confirm.delete": "删除",
			"state.loading": "加载中…",
			"state.empty": "暂无已归档的聊天",
			"state.emptyFiltered": "没有匹配的已归档聊天",
			"state.error": "加载失败",
			"state.retry": "重试",
			"notice.dismiss": "关闭"
		};
		const en = {
			"locale.intl": "en-US",
			"nav": "Archived Chats",
			"page.title": "Archived Chats",
			"delete.all": "Delete All",
			"search.placeholder": "Search archived chats",
			"filter.allChats": "All chats",
			"filter.normal": "Regular chats",
			"filter.subagent": "Subagent chats",
			"filter.allProjects": "All projects",
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
			"confirm.cancel": "Cancel",
			"confirm.delete": "Delete",
			"state.loading": "Loading…",
			"state.empty": "No archived chats",
			"state.emptyFiltered": "No archived chats match your filters",
			"state.error": "Failed to load",
			"state.retry": "Retry",
			"notice.dismiss": "Dismiss"
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
		//#endregion

		//#region styles
		const CSS = `
.dac-page{position:relative;display:flex;flex-direction:column;gap:14px;padding:4px 0 28px;font-family:inherit}
.dac-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dac-title{color:var(--dsw-alias-label-primary);font-size:18px;font-weight:500;line-height:28px}
.dac-deleteall{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:999px;padding:6px 14px;background:rgba(229,72,77,.1);color:#e5484d;font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background .15s}
.dac-deleteall:hover:not(:disabled){background:rgba(229,72,77,.18)}
.dac-deleteall:disabled{opacity:.45;cursor:default}
.dac-search{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px;color:var(--dsw-alias-label-tertiary);transition:border-color .15s}
.dac-search:focus-within{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-search input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:0}
.dac-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dac-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dac-select-wrap{position:relative;display:inline-flex;align-items:center}
.dac-select{appearance:none;-webkit-appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 28px 5px 14px;cursor:pointer;outline:none}
.dac-select:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dac-chevron{position:absolute;right:10px;pointer-events:none;color:var(--dsw-alias-label-tertiary);display:inline-flex}
.dac-group{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.dac-group-head{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px}
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
.dac-iconbtn.dac-danger:hover:not(:disabled){color:#e5484d;background:rgba(229,72,77,.1)}
.dac-menu{position:absolute;right:0;top:30px;z-index:40;min-width:150px;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 28px rgba(0,0,0,.18)}
.dac-menu-item{border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;padding:7px 10px;cursor:pointer}
.dac-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-menu-item.dac-danger{color:#e5484d}
.dac-menu-item.dac-danger:hover{background:rgba(229,72,77,.1)}
.dac-list{display:flex;flex-direction:column;gap:8px}
.dac-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 16px;transition:border-color .15s}
.dac-row:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
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
.dac-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid rgba(229,72,77,.45);border-radius:10px;background:rgba(229,72,77,.08);color:#e5484d;font-size:12px;line-height:18px;padding:8px 12px}
.dac-notice button{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0;display:inline-flex}
.dac-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:1200;display:flex;align-items:center;gap:8px;border:1px solid rgba(48,164,108,.4);border-radius:999px;background:color-mix(in srgb,#30a46c 9%,var(--dsw-alias-bg-primary,#fff));color:#2f9e68;font-size:13px;font-weight:500;line-height:20px;padding:7px 12px 7px 14px;box-shadow:0 6px 20px rgba(0,0,0,.10),0 1px 3px rgba(0,0,0,.06);animation:dac-toast-in .28s cubic-bezier(.21,1.02,.55,1) both}
.dac-toast svg{flex:none}
.dac-toast button{border:none;background:transparent;color:inherit;opacity:.55;cursor:pointer;font:inherit;padding:2px;margin-left:2px;display:inline-flex;border-radius:999px}
.dac-toast button:hover{opacity:1;background:rgba(48,164,108,.12)}
@keyframes dac-toast-in{from{opacity:0;transform:translateX(-50%) translateY(-10px) scale(.96)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
@media (prefers-reduced-motion:reduce){.dac-toast{animation:none}}
.dac-confirm-overlay{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)}
.dac-confirm{width:min(400px,calc(100vw - 64px));display:flex;flex-direction:column;gap:12px;border-radius:16px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 16px 64px rgba(0,0,0,.3);padding:20px}
.dac-confirm-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}
.dac-confirm-body{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}
.dac-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dac-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 14px;cursor:pointer}
.dac-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dac-btn-danger{border:none;border-radius:9px;background:#e5484d;color:#fff;font:inherit;font-size:13px;line-height:20px;padding:6px 14px;cursor:pointer}
.dac-btn-danger:hover:not(:disabled){background:#d13438}
.dac-btn-danger:disabled{opacity:.5;cursor:default}
.dac-spin{display:inline-block;width:14px;height:14px;border:2px solid var(--dsw-alias-label-tertiary);border-top-color:transparent;border-radius:50%;animation:dac-rotate .8s linear infinite}
@keyframes dac-rotate{to{transform:rotate(360deg)}}
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

		function patchNavIcons() {
			if (typeof document === "undefined" || document.body === null) return;
			const dialogs = document.querySelectorAll('[role="dialog"]');
			for (const dialog of dialogs) {
				const buttons = dialog.querySelectorAll("nav button");
				for (const button of buttons) {
					const text = button.textContent ?? "";
					if (!NAV_LABELS.some((label) => text.includes(label))) continue;
					const svg = button.querySelector("svg");
					if (svg === null || svg.dataset.dacPatched === "1") continue;
					svg.dataset.dacPatched = "1";
					svg.setAttribute("viewBox", "0 0 24 24");
					svg.setAttribute("fill", "none");
					svg.setAttribute("stroke", "currentColor");
					svg.setAttribute("stroke-width", "1.5");
					svg.setAttribute("stroke-linecap", "round");
					svg.setAttribute("stroke-linejoin", "round");
					svg.innerHTML = ARCHIVE_ICON_INNER;
				}
			}
		}

		let navObserver = null;

		function startNavIconPatch() {
			patchNavIcons();
			const Observer = typeof window !== "undefined" ? window.MutationObserver : void 0;
			if (Observer === void 0 || typeof document === "undefined" || document.body === null) return;
			if (navObserver !== null) return;
			navObserver = new Observer(() => patchNavIcons());
			navObserver.observe(document.body, { childList: true, subtree: true });
		}

		function stopNavIconPatch() {
			navObserver?.disconnect();
			navObserver = null;
		}
		//#endregion

		//#region api
		async function fetchState() {
			const res = await fetch(`${API_BASE}/state`, { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			return Array.isArray(body.sessions) ? body.sessions : [];
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

		function ConfirmDialog({ title, body, confirmLabel, cancelLabel, busy, onConfirm, onCancel }) {
			_react.useEffect(() => {
				const onKey = (e) => { if (e.key === "Escape") onCancel(); };
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [onCancel]);
			return (0, jsx.jsx)("div", {
				className: "dac-confirm-overlay",
				onClick: onCancel,
				children: (0, jsx.jsxs)("div", {
					className: "dac-confirm",
					role: "alertdialog",
					"aria-modal": "true",
					onClick: (e) => e.stopPropagation(),
					children: [
						(0, jsx.jsx)("div", { className: "dac-confirm-title", children: title }),
						(0, jsx.jsx)("div", { className: "dac-confirm-body", children: body }),
						(0, jsx.jsxs)("div", {
							className: "dac-confirm-actions",
							children: [
								(0, jsx.jsx)("button", { type: "button", className: "dac-btn", onClick: onCancel, children: cancelLabel }),
								(0, jsx.jsx)("button", { type: "button", className: "dac-btn-danger", disabled: busy, onClick: onConfirm, children: confirmLabel })
							]
						})
					]
				})
			});
		}

		function GroupSection({ group, t, collapsed, onToggleCollapsed, menuOpen, onToggleMenu, onUnarchive, onDelete, busy }) {
			const wrapRef = _react.useRef(null);
			_react.useEffect(() => {
				if (!menuOpen) return void 0;
				const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) onToggleMenu(null); };
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [menuOpen, onToggleMenu]);
			const ids = group.items.map((s) => s.id);
			return (0, jsx.jsxs)("div", {
				className: "dac-group",
				children: [
					(0, jsx.jsxs)("div", {
						className: "dac-group-head",
						ref: wrapRef,
						children: [
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
							className: "dac-row",
							children: [
								(0, jsx.jsxs)("div", {
									className: "dac-row-main",
									children: [
										(0, jsx.jsx)("div", { className: "dac-row-title", children: session.title ?? t("chat.untitled") }),
										(0, jsx.jsx)("div", { className: "dac-row-date", children: formatDate(t, session.createdAt) })
									]
								}),
								(0, jsx.jsxs)("div", {
									className: "dac-row-actions",
									children: [
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
			const [menuFor, setMenuFor] = _react.useState(null);
			const [confirm, setConfirm] = _react.useState(null);
			const [busy, setBusy] = _react.useState({});
			const [notice, setNotice] = _react.useState(null);
			const [collapsed, setCollapsed] = _react.useState(readCollapsed);

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
					setSessions(await fetchState());
				} catch (error) {
					setLoadError(error);
				}
			}, []);
			_react.useEffect(() => { refresh(); }, [refresh]);

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

			const unarchive = async (ids) => {
				if (ids.length === 0) return;
				markBusy(ids, true);
				setNotice(null);
				try {
					await post("/unarchive-all", { sessionIds: ids });
					setSessions((prev) => (prev ?? []).filter((s) => !ids.includes(s.id)));
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				} finally {
					markBusy(ids, false);
				}
			};

			const runDelete = async (ids) => {
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
						// Pending rows leave the list too: the deletion is accepted,
						// the session is parked and excluded from /state until the
						// next-boot sweep physically removes it.
						setSessions((prev) => (prev ?? []).filter((s) => !deleted.includes(s.id) && !pending.includes(s.id)));
					}
					if (failed.length > 0) setNotice({ kind: "error", text: failureText(t, failed) });
					else if (pending.length > 0) setNotice({ kind: "error", text: pendingText(t, pending.length) });
					else if (deleted.length > 0) setNotice({ kind: "ok", text: deletedText(t, deleted.length) });
				} catch (error) {
					const deleted = error.body?.deleted ?? [];
					const pending = error.body?.pending ?? [];
					const failed = error.body?.failed ?? [];
					if (deleted.length > 0 || pending.length > 0) {
						changed = true;
						setSessions((prev) => (prev ?? []).filter((s) => !deleted.includes(s.id) && !pending.includes(s.id)));
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

			const askDelete = (ids, groupName) => {
				if (ids.length === 0) return;
				if (ids.length === 1 && groupName === null) {
					setConfirm({ title: t("confirm.deleteOne.title"), body: t("confirm.deleteOne.body"), ids });
				} else if (groupName !== null && groupName !== void 0) {
					setConfirm({ title: t("confirm.deleteGroup.title"), body: deleteGroupBody(t, groupName, ids.length), ids });
				} else {
					setConfirm({ title: t("confirm.deleteAll.title"), body: deleteAllBody(t, ids.length), ids });
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

			const groups = _react.useMemo(() => {
				const q = query.trim().toLowerCase();
				const visible = (sessions ?? []).filter((s) => {
					if (projectFilter !== "all" && (s.workspaceId ?? "ungrouped") !== projectFilter) return false;
					if (typeFilter === "normal" && s.origin === "subagent") return false;
					if (typeFilter === "subagent" && s.origin !== "subagent") return false;
					if (q !== "" && !(s.title ?? "").toLowerCase().includes(q)) return false;
					return true;
				});
				const byKey = new Map();
				for (const s of visible) {
					const key = s.workspaceId ?? "ungrouped";
					if (!byKey.has(key)) byKey.set(key, { key, title: s.workspaceTitle ?? t("group.noProject"), items: [] });
					byKey.get(key).items.push(s);
				}
				const list = [...byKey.values()];
				for (const g of list) g.items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
				list.sort((a, b) => {
					if ((a.key === "ungrouped") !== (b.key === "ungrouped")) return a.key === "ungrouped" ? 1 : -1;
					return (b.items[0]?.createdAt ?? 0) - (a.items[0]?.createdAt ?? 0);
				});
				return list;
			}, [sessions, query, projectFilter, typeFilter, t]);

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
			const filtering = query.trim() !== "" || projectFilter !== "all" || typeFilter !== "all";

			return (0, jsx.jsxs)("div", {
				className: "dac-page",
				children: [
					(0, jsx.jsxs)("div", {
						className: "dac-head",
						children: [
							(0, jsx.jsx)("div", { className: "dac-title", children: t("page.title") }),
							(0, jsx.jsxs)("button", {
								type: "button",
								className: "dac-deleteall",
								disabled: allIds.length === 0,
								onClick: () => askDelete(allIds, void 0),
								children: [(0, jsx.jsx)(IconTrash, {}), (0, jsx.jsx)("span", { children: t("delete.all") })]
							})
						]
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
						busy
					}, group.key)),
					confirm !== null && (0, jsx.jsx)(ConfirmDialog, {
						title: confirm.title,
						body: confirm.body,
						confirmLabel: t("confirm.delete"),
						cancelLabel: t("confirm.cancel"),
						busy: confirm.ids.some((id) => busy[id] === true),
						onConfirm: () => runDelete(confirm.ids),
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
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
