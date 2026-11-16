// @echo/dsh-script-orchestrator · Web client（简化档：手写 lazy-CJS，零构建步骤）。
// 协议：window.__ModuleLoader__.load({ id, factory })，factory 内建 module/exports、
// require("react") 取页面 seed 的 React；导出 apply（生成器，yield 注销器）+ inject。
// 数据源：ctx.connection.rpc.call('/script-orchestrator', endpoint, payload)（契约
// docs/temp/11-web-panel.md：零翻译 DTO；权威数据永远来自 list/view 回读，无事件推送）。
// 创建与新会话修改通过 ctx.uiWorkspace.startSession 预填草稿；详情另有手动编辑。
// 执行记录的会话引用可经 ctx.uiWorkspace.openSession 跳转（v0.1ab）。
// 对话由内置 SKILL 引导并经 script_create / script_edit 完成；手动修改复用 edit RPC。
// 面板保留高密度列表，详情在可关闭的右栏展示，执行排障与编辑使用独立模态。
window.__ModuleLoader__.load({
	id: "@echo/dsh-script-orchestrator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useState, useEffect, useRef } = React;
		const h = React.createElement;

		const CHANNEL = "/script-orchestrator";
		const PANEL_ID = "script-orchestrator";

		// 对话式创建的引导 prompt（预填新会话草稿；与内置「自动化任务」面板 onNewTask 同一通道）
		const CREATE_PROMPT = "/script-orchestrator\n创建脚本编排：\n请在此描述需求：";
		const EDIT_PROMPT = (id) => "/script-orchestrator\n修改脚本编排 " + id + "：\n请在此描述需求：";

		// ---------------- 样式（内联，沿用 proto/web-panel 变体 C 视觉） ----------------
		const C = {
			page: { padding: "20px 24px", fontFamily: "system-ui, sans-serif", fontSize: 13, color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base)", minHeight: "100%" },
			card: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10, padding: 14 },
			muted: { color: "var(--dsw-alias-label-secondary)" },
			mono: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 },
			row: { display: "flex", alignItems: "center", gap: 8 },
			btn: { color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
			btnPri: { border: "1px solid var(--dsw-alias-brand-primary)", background: "var(--dsw-alias-brand-primary)", color: "var(--dsw-alias-bg-layer-1)", borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
		};
		// 容器查询跟随 DSH 内容区宽度（而非整个浏览器宽度）。
		const PANEL_CSS = `
			.so-page { container-type: inline-size; box-sizing: border-box; }
			.so-page button { color: inherit; font-family: inherit; }
			.so-page input, .so-page select, .so-page textarea { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 6px 8px; font: inherit; }
			.so-page button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
			.so-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
			.so-workspace-split { grid-template-columns: minmax(320px, 0.9fr) minmax(360px, 1.1fr); }
			.so-list { min-width: 0; overflow-x: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
			.so-table tbody tr:hover { background: var(--dsw-alias-bg-layer-2); }
			.so-table tr[data-selected="true"] { background: var(--dsw-alias-bg-layer-2); }
			.so-table tr[data-selected="true"] td:first-child { box-shadow: inset 3px 0 var(--dsw-alias-brand-primary); }
			.so-title { text-align: left; border: 0; padding: 0; background: none; cursor: pointer; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
			.so-detail { min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow-wrap: anywhere; }
			.so-detail-header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
			.so-detail-body { padding: 4px 16px 16px; min-width: 0; }
			.so-detail-body pre { white-space: pre-wrap; overflow-wrap: anywhere; }
			@container (max-width: 760px) { .so-workspace-split { grid-template-columns: minmax(0, 1fr); } }
			/* ---- 手动修改模态：样式遵循宿主主题（契约 11「手动修改」） ---- */
			.so-page .so-edit-dialog { box-sizing: border-box; display: flex; flex-direction: column; width: min(620px, 100%); max-height: calc(100dvh - 48px); margin: 0; padding: 0; border: 0.5px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1)); border-radius: 16px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.6; box-shadow: 0 12px 40px rgba(0,0,0,.28); overflow: hidden; }
			.so-page .so-edit-dialog :focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 2px; }
			.so-page .so-edit-head { display: flex; flex: none; align-items: flex-start; gap: 16px; padding: 20px 20px 12px; }
			.so-page .so-edit-head-text { flex: 1 1 auto; min-width: 0; }
			.so-page .so-edit-close { order: 1; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 16px; line-height: 1; cursor: pointer; }
			@media (hover: hover) { .so-page .so-edit-close:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); } }
			.so-page .so-edit-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; overflow-wrap: anywhere; }
			.so-page .so-edit-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; line-height: 20px; }
			.so-page .so-edit-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; padding: 4px 20px 20px; }
			.so-page .so-edit-section { display: grid; gap: 12px; min-width: 0; }
			.so-page .so-edit-section-title { margin: 0; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; line-height: 20px; font-weight: 500; }
			.so-page .so-edit-field { display: grid; gap: 6px; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
			.so-page .so-edit-field input, .so-page .so-edit-field select, .so-page .so-edit-field textarea { box-sizing: border-box; width: 100%; margin: 0; padding: 7px 10px; border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius: 10px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; transition: border-color .15s; }
			@media (hover: hover) { .so-page .so-edit-field input:not(:disabled):hover, .so-page .so-edit-field select:not(:disabled):hover, .so-page .so-edit-field textarea:not(:disabled):hover { border-color: var(--dsw-alias-border-l2); } }
			.so-page .so-edit-field input:focus, .so-page .so-edit-field select:focus, .so-page .so-edit-field textarea:focus { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline: none; }
			.so-page .so-edit-field :disabled { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); background: var(--dsw-alias-bg-layer-1); cursor: not-allowed; }
			.so-page .so-edit-json { font-family: ui-monospace, Consolas, monospace; font-size: 12px; min-height: 88px; resize: vertical; }
			.so-page .so-edit-notice { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; }
			.so-page .so-edit-notice p { margin: 0; }
			.so-page .so-edit-notice-error { color: var(--dsw-alias-state-error-primary); }
			.so-page .so-edit-foot { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding: 16px 20px; border-top: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1)); }
			.so-page .so-edit-btn { height: 32px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 16px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; cursor: pointer; }
			@media (hover: hover) { .so-page .so-edit-btn:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); } }
			.so-page .so-edit-btn:disabled { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); cursor: default; }
			.so-page .so-edit-btn-primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1)); }
			@media (hover: hover) { .so-page .so-edit-btn-primary:not(:disabled):hover { background: var(--dsw-alias-brand-primary); filter: brightness(1.06); } }
		`;
		const STATUS_COLOR = { active: "var(--dsw-alias-state-success-primary)", paused: "var(--dsw-alias-state-warn-primary)", ended: "var(--dsw-alias-label-secondary)" };
		const STATUS_CN = { active: "运行中", paused: "已暂停", ended: "已结束" };
		// run 终态集合与中文映射（契约 09 执行状态；轮询停止条件 = 无非终态 run）
		const RUN_TERMINAL = { succeeded: 1, partial: 1, failed: 1, skipped: 1, canceled: 1, interrupted: 1 };
		const RUN_STATUS_CN = {
			queued: "排队中", running: "执行中", judging: "判定中", dispatching: "派发动作中",
			succeeded: "成功", partial: "部分成功", failed: "失败", skipped: "已跳过", canceled: "已取消", interrupted: "已中断",
		};
		const SKIP_REASON_CN = { overlap: "重叠", disabled: "已停用", concurrency: "并发额度" };
		// 动作三段结果（契约 05/09）：kind 与动作状态中文映射
		const ACTION_KIND_CN = { event: "事件", plugin: "注册动作", session: "会话" };
		const ACTION_STATUS_CN = { succeeded: "成功", failed: "失败", skipped: "已跳过" };
		const ACTION_STATUS_COLOR = { succeeded: "var(--dsw-alias-state-success-primary)", failed: "var(--dsw-alias-state-error-primary)", skipped: "var(--dsw-alias-label-secondary)" };
		// 活动 run 轮询周期（契约 11「刷新策略」3：面板可见且存在非终态 run 时每 5 秒 view(id)）
		const POLL_MS = 5000;
		const fmtTime = (iso) => (iso ? iso.replace("T", " ").replace(/(\.\d+|Z).*$/, "") : "—");
		// run 状态彩色徽章 token（v0.1x 执行记录直观化；与编排 Chip 同一组主题 token）
		const RUN_STATUS_COLOR = {
			queued: "var(--dsw-alias-brand-primary)", running: "var(--dsw-alias-brand-primary)",
			judging: "var(--dsw-alias-brand-primary)", dispatching: "var(--dsw-alias-brand-primary)",
			succeeded: "var(--dsw-alias-state-success-primary)", partial: "var(--dsw-alias-state-warn-primary)",
			failed: "var(--dsw-alias-state-error-primary)", interrupted: "var(--dsw-alias-state-warn-primary)",
			skipped: "var(--dsw-alias-label-secondary)", canceled: "var(--dsw-alias-label-secondary)",
		};
		// 相对时间（v0.1x）：刚刚 / N 分钟前 / N 小时前 / N 天前，更早显示日期；绝对时刻放 title。
		function fmtRelTime(iso) {
			const t = Date.parse(iso);
			if (!Number.isFinite(t)) return "—";
			const diff = Date.now() - t;
			if (diff < 0) return fmtTime(iso);
			if (diff < 45e3) return "刚刚";
			if (diff < 3600e3) return Math.max(1, Math.round(diff / 60e3)) + " 分钟前";
			if (diff < 86400e3) return Math.round(diff / 3600e3) + " 小时前";
			if (diff < 30 * 86400e3) return Math.round(diff / 86400e3) + " 天前";
			return fmtTime(iso).slice(0, 10);
		}
		// 人性化耗时（v0.1x）：亚秒保 ms 精度；2.2 秒；1 分 5 秒。
		function fmtDuration(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
			if (ms < 1000) return Math.round(ms) + "ms";
			const secs = ms / 1000;
			if (secs < 60) return (Math.round(secs * 10) / 10) + " 秒";
			const m = Math.floor(secs / 60);
			const rest = Math.round(secs % 60);
			return rest ? m + " 分 " + rest + " 秒" : m + " 分钟";
		}
		// 输出尾部预览（v0.1x）：去尾空白，取末 200 字符
		function previewTail(v) {
			const t = (v || "").replace(/\s+$/, "");
			return t.length > 200 ? t.slice(-200) : t;
		}
		const fmtEvery = (seconds) =>
			seconds % 60 === 0 ? Math.round(seconds / 60) + " 分钟" : seconds + " 秒";
		const pad2 = (n) => String(n).padStart(2, "0");

		// 每日/每周语义识别（契约 02「每日/每周面板预设」：只生成 cron；查看时语义上只是固定
		// 一个本地时间的每日或若干星期规则可回显简单形式）。多时刻、日期/月份限制、step 等
		// 复杂规则返回 null（摘要只显示表达式原文）。
		const DOW_CN = { 0: "日", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六" };
		function expandDow(raw) {
			const out = new Set();
			for (const element of raw.split(",")) {
				const m = /^(\d+)(?:-(\d+))?$/.exec(element);
				if (!m) return null;
				const start = Number(m[1]);
				const end = m[2] === undefined ? start : Number(m[2]);
				if (start > 7 || end > 7 || start > end) return null;
				for (let v = start; v <= end; v++) out.add(v === 7 ? 0 : v);
			}
			return out;
		}
		function describeCron(expression) {
			if (!expression || typeof expression !== "string") return null;
			const fields = expression.trim().split(/\s+/);
			if (fields.length !== 5) return null;
			const [minute, hour, dom, month, dow] = fields;
			// 时间须为单一时刻；日期/月份须为 *（受限即复杂规则）
			if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
			if (dom !== "*" || month !== "*") return null;
			if (Number(minute) > 59 || Number(hour) > 23) return null;
			const clock = pad2(hour) + ":" + pad2(minute);
			if (dow === "*") return "每天 " + clock;
			const days = expandDow(dow);
			if (days === null || days.size === 0 || days.size === 7) return null;
			const names = [0, 1, 2, 3, 4, 5, 6].filter((d) => days.has(d)).map((d) => DOW_CN[d]);
			return "每周" + names.join("/") + " " + clock;
		}

		function Chip({ s }) {
			const color = STATUS_COLOR[s] || "var(--dsw-alias-label-secondary)";
			return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, borderRadius: 999, padding: "1px 9px", fontSize: 11, background: "var(--dsw-alias-bg-layer-2)", color, border: "1px solid " + color } },
				h("span", { style: { width: 6, height: 6, borderRadius: 99, background: color } }), STATUS_CN[s] || s);
		}

		// run 状态徽章（v0.1x）：与 Chip 同形，按 RUN_STATUS_COLOR/RUN_STATUS_CN 映射
		function RunChip({ s }) {
			const color = RUN_STATUS_COLOR[s] || "var(--dsw-alias-label-secondary)";
			return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, borderRadius: 999, padding: "1px 9px", fontSize: 11, background: "var(--dsw-alias-bg-layer-2)", color, border: "1px solid " + color } },
				h("span", { style: { width: 6, height: 6, borderRadius: 99, background: color } }), RUN_STATUS_CN[s] || s);
		}

		// 触发配置摘要（every：间隔 + 模式；cron：表达式 + 时区，每日/每周语义可回显摘要）
		function TriggerSummary({ t }) {
			if (!t) return h("span", { style: C.muted }, "—");
			if (t.kind === "cron") {
				const summary = describeCron(t.expression);
				return h("span", { style: C.mono }, t.expression, " @ ", t.timeZone,
					summary ? h("span", { style: { ...C.muted, marginLeft: 6 } }, summary) : null);
			}
			return h("span", { style: C.mono },
				"every ", fmtEvery(t.everySeconds),
				h("span", { style: { ...C.muted, marginLeft: 6 } }, t.mode === "fixed-delay" ? "完成后再等" : "固定相位"));
		}

		// ---------------- 完成后行为翻译（v0.1y 起；v0.1aa 去键化，契约 11「完成后行为展示」） ----------------
		// judge/actions 配置 → 简体中文明话；纯展示，点击不进入编辑。describeWhen 覆盖契约 04 的全部谓词键。
		function clipText(text, n) {
			const s = String(text);
			return s.length > n ? s.slice(0, n) + "…" : s;
		}
		function describeNumberMatcher(v) {
			if (typeof v === "number") return "= " + v;
			if (v && typeof v === "object") {
				const parts = [];
				if (v.not !== undefined) parts.push("≠ " + v.not);
				if (Array.isArray(v.in)) parts.push("∈ [" + v.in.join("、") + "]");
				if (v.min !== undefined || v.max !== undefined)
					parts.push("介于 " + (v.min !== undefined ? v.min : "−∞") + "–" + (v.max !== undefined ? v.max : "∞"));
				return parts.join("、") || JSON.stringify(v);
			}
			return JSON.stringify(v);
		}
		function describeStreamPredicate(p) {
			const parts = [];
			if (p.regex !== undefined) parts.push("匹配 /" + clipText(p.regex, 40) + "/" + (p.flags || ""));
			if (p.contains !== undefined) parts.push("包含“" + clipText(p.contains, 40) + "”");
			if (p.jsonPath !== undefined)
				parts.push("JSON " + p.jsonPath + (p.equals !== undefined ? " = " + clipText(JSON.stringify(p.equals), 40) : ""));
			if (p.truncated !== undefined) parts.push(p.truncated ? "已截断" : "未截断");
			return parts.join("、") || JSON.stringify(p);
		}
		function describeWhen(when) {
			if (!when || typeof when !== "object" || Object.keys(when).length === 0) return "无条件（总是命中）";
			const parts = [];
			for (const [key, value] of Object.entries(when)) {
				if (key === "exitCode") parts.push("退出码 " + describeNumberMatcher(value));
				else if (key === "signal") parts.push("信号 " + (value === null ? "为 null" : "= " + value));
				else if (key === "timedOut") parts.push(value ? "已超时" : "未超时");
				else if (key === "durationMs") parts.push("耗时 " + describeNumberMatcher(value) + "ms");
				else if (key === "stdout") parts.push("stdout " + describeStreamPredicate(value));
				else if (key === "stderr") parts.push("stderr " + describeStreamPredicate(value));
				else if (key === "all") parts.push("（全部）" + value.map(describeWhen).join(" 且 "));
				else if (key === "any") parts.push("（任一）" + value.map(describeWhen).join(" 或 "));
				else parts.push(key + " " + JSON.stringify(value));
			}
			return parts.join("；");
		}
		// v0.1z/v0.1aa：session 动作的 prompt 预览是可点击开关，展开显示完整 prompt（契约 11「prompt 预览可展开」）。
		// v0.1aa：正常展示不出现动作键——规则行给条件，命中动作逐个缩进行给简体中文描述；
		// 仅「引用了未定义动作」的错误场景显示键（排障必需，契约 11「完成后行为展示」）。
		function describeActionText(def, registered) {
			if (!def || typeof def !== "object") return "配置缺失";
			if (def.kind === "event") return "发出事件 " + def.name;
			if (def.kind === "plugin")
				return "调用注册动作 " + def.action + (registered && !registered.has(def.action) ? "（当前未注册）" : "");
			if (def.kind === "session")
				return "开启" + (def.mode === "ephemeral" ? "一次性" : "持久") + "会话" + (def.title ? "「" + def.title + "」" : "");
			return "未知类型的动作（" + String(def.kind) + "）";
		}
		function ActionRuleLine({ dkey, def, registered }) {
			const [expanded, setExpanded] = useState(false);
			const row = { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 4, fontSize: 11, marginTop: 2, marginLeft: 14, overflowWrap: "anywhere" };
			if (!def || typeof def !== "object")
				return h("div", { style: row },
					h("span", { ...C.muted }, "→ "),
					h("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, "未知动作「" + dkey + "」（actions 里没有定义）"));
			if (def.kind === "session") {
				const promptText = typeof def.prompt === "string" ? def.prompt.trim() : "";
				const hasPrompt = promptText.length > 0;
				const firstLine = hasPrompt ? promptText.split(/\r?\n/)[0] : "";
				const clipped = firstLine.length > 60 || /\r?\n/.test(promptText);
				return h("div", { style: { marginTop: 2, marginLeft: 14 } },
					h("div", { style: row },
						h("span", { ...C.muted }, "→ "),
						h("span", null, describeActionText(def, registered)),
						hasPrompt ? h("button", {
							type: "button",
							"aria-expanded": expanded,
							title: expanded ? "收起 prompt" : "展开完整 prompt",
							onClick: () => setExpanded(!expanded),
							style: { border: 0, padding: 0, background: "none", cursor: "pointer", color: "var(--dsw-alias-brand-primary)", font: "inherit", textAlign: "left", overflowWrap: "anywhere" },
						}, "prompt：「" + clipText(firstLine, 60) + (clipped ? "…" : "") + "」 ", expanded ? "▾" : "▸") : null),
					expanded && hasPrompt ? h("pre", {
						style: { ...C.mono, fontSize: 11, margin: "4px 0 0", padding: "8px 10px", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6, maxHeight: 280, overflow: "auto" },
					}, def.prompt) : null);
			}
			return h("div", { style: row },
				h("span", { ...C.muted }, "→ "),
				h("span", null, describeActionText(def, registered)));
		}
		function AfterScriptSummary({ judge, actions, availableActions }) {
			const rules = judge && Array.isArray(judge.rules) ? judge.rules : [];
			const actionMap = actions && typeof actions === "object" ? actions : {};
			const registered = new Set((availableActions || []).map((a) => a.name));
			const hasFallback = judge && judge.fallback !== undefined;
			const referenced = new Set();
			const actionLines = (keys, prefix) => (keys || []).map((k, i) => {
				referenced.add(k);
				return h(ActionRuleLine, { key: prefix + "-" + i + "-" + k, dkey: k, def: actionMap[k], registered: registered });
			});
			const body = [];
			for (let i = 0; i < rules.length; i++) {
				const rule = rules[i] || {};
				const keys = Array.isArray(rule.actions) ? rule.actions : [];
				body.push(h("div", { key: "rule-" + i, style: { fontSize: 11, marginTop: 3, overflowWrap: "anywhere" } },
					h("span", { ...C.muted }, "规则 " + (i + 1) + "：当 "),
					h("span", null, describeWhen(rule.when)),
					keys.length === 0 ? h("span", { ...C.muted }, " → 不执行动作") : null));
				body.push(...actionLines(keys, "rule-" + i));
			}
			if (hasFallback) {
				const keys = Array.isArray(judge.fallback) ? judge.fallback : [];
				body.push(h("div", { key: "fallback", style: { fontSize: 11, marginTop: 3, overflowWrap: "anywhere" } },
					h("span", { ...C.muted }, "兜底（无规则命中）"),
					keys.length === 0 ? h("span", { ...C.muted }, " → 不执行动作") : null));
				body.push(...actionLines(keys, "fallback"));
			}
			if (rules.length === 0 && !hasFallback)
				body.push(h("div", { key: "none", style: { ...C.muted, fontSize: 11, marginTop: 3 } }, "脚本完成后不执行任何动作"));
			// 已定义但未被任何规则/兜底引用的动作：弱化列出描述，不显示键
			const unreferenced = Object.keys(actionMap).filter((k) => !referenced.has(k));
			if (unreferenced.length > 0)
				body.push(h("div", { key: "unref", style: { ...C.muted, fontSize: 11, marginTop: 4, overflowWrap: "anywhere" } },
					"已定义但未引用：",
					unreferenced.map((k) => describeActionText(actionMap[k], registered)).join("、")));
			return h("div", null, body);
		}

		// ---------------- 面板（数据经 Connection 桥，权威数据永远来自回读） ----------------
		function Panel({ call, subscribeReset, startCreateSession, startEditSession, openSession }) {
			const [state, setState] = useState({ phase: "loading" });
			const [detailId, setDetailId] = useState(null);
			const [reloadKey, setReloadKey] = useState(0);
			const [actionError, setActionError] = useState(null);
			const listRef = useRef(null);
			const refreshRef = useRef(null);
			function closeDetail() {
				const trigger = listRef.current && [...listRef.current.querySelectorAll("button.so-title")].find((node) => node.dataset.id === detailId);
				const target = trigger || refreshRef.current;
				if (target) target.focus();
				setDetailId(null);
			}

			async function refresh() {
				setState({ phase: "loading" });
				try {
					const res = await call("list", {});
					if (res && res.ok) {
						setState({ phase: "ready", data: res.value });
					} else {
						const error = (res && res.error) || {};
						setState({ phase: "error", code: error.code || "internal_error", message: error.message || "未知错误" });
					}
				} catch (e) {
					// 传输层失败（HTTP 非 2xx / 网络断开）：以错误态呈现，可重试
					setState({ phase: "error", code: "transport", message: String((e && e.message) || e) });
				}
			}

			// 详情管理操作（契约 11：暂停/恢复/执行经 Connection 调用并立即回读；
			// UI abort 只终止等待——run 端点受理即返回，不取消已受理操作）
			async function runAction(id, action) {
				setActionError(null);
				let res;
				try {
					res = action === "run" ? await call("run", { id }) : await call("edit", { id, action });
				} catch (e) {
					setActionError({ code: "transport", message: String((e && e.message) || e) });
					return;
				}
				if (res && res.ok) {
					setReloadKey((k) => k + 1); // 详情保持打开时也回读操作结果
					void refresh(); // 写后权威回读
				} else {
					const error = (res && res.error) || {};
					setActionError({ code: error.code || "internal_error", message: error.message || "未知错误" });
				}
			}

			// 删除编排（契约 11 详情操作 + 二次确认；票 29）：确认后经 edit action=delete——
			// 服务端先取消在途 run 再同批级联删除；UI abort 只终止等待（无取消已受理删除入口）
			const [deleteTarget, setDeleteTarget] = useState(null);
			const [deleting, setDeleting] = useState(false);
			async function confirmDelete(id) {
				setDeleting(true);
				setActionError(null);
				let res;
				try {
					res = await call("edit", { id, action: "delete" });
				} catch (e) {
					setActionError({ code: "transport", message: String((e && e.message) || e) });
					setDeleteTarget(null);
					setDeleting(false);
					return;
				}
				setDeleteTarget(null);
				setDeleting(false);
				if (res && res.ok) {
					if (detailId === id) setDetailId(null); // 详情正开着已删除的编排 → 一并关闭
					void refresh(); // 写后权威回读
				} else {
					const error = (res && res.error) || {};
					setActionError({ code: error.code || "internal_error", message: error.message || "未知错误" });
				}
			}

			useEffect(() => {
				void refresh();
				const off = subscribeReset ? subscribeReset(() => { void refresh(); setReloadKey((k) => k + 1); }) : null;
				// 无实时事件推送（契约 11）：面板回到可见时按回读恢复权威数据
				const onVisibility = () => {
					if (document.visibilityState === "visible") void refresh();
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					if (off) off();
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, []);

			return h("div", { className: "so-page", style: C.page },
				h("style", null, PANEL_CSS),
				h("div", { style: { ...C.row, marginBottom: 10 } },
					h("b", { style: { fontSize: 15 } }, "脚本编排"),
					state.phase === "ready"
						? h("span", { style: { ...C.muted, fontSize: 11 } }, "共 ", state.data.total, " 条")
						: null,
					h("div", { style: { ...C.row, marginLeft: "auto" } },
						h("button", { ref: refreshRef, style: C.btn, onClick: () => { setReloadKey((k) => k + 1); void refresh(); } }, "刷新"),
						h("button", {
							style: C.btnPri,
							title: "经引导会话由模型用 script_create 创建；面板不提供表单",
							onClick: () => startCreateSession && startCreateSession(),
						}, "＋ 新建"))),
				h("div", { className: "so-workspace" + (detailId ? " so-workspace-split" : "") },
				h("section", { ref: listRef, "aria-label": "编排列表", style: { minWidth: 0 } },
				state.phase === "loading" ? h(LoadingView)
				: state.phase === "error" ? h(ErrorView, { state, onRetry: () => void refresh() })
				: state.data.items.length === 0 ? h(EmptyView, { startCreateSession })
				: h("div", null,
					actionError && !detailId ? h("div", {
						role: "alert",
						style: { ...C.row, ...C.card, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)", padding: "8px 12px", marginBottom: 8, fontSize: 12 },
					},
						h("b", null, "操作失败（", actionError.code, "）"),
						h("span", { style: { marginLeft: 6 } }, actionError.message),
						h("button", { style: { ...C.btn, marginLeft: "auto", padding: "2px 8px" }, onClick: () => setActionError(null) }, "关闭")) : null,
					h("div", { className: "so-list" }, h(TableView, { items: state.data.items, selectedId: detailId, onOpen: (id) => { setActionError(null); setDetailId(id); } })))),
				detailId ? h(DetailPanel, { key: detailId, reloadKey, call, id: detailId, startEditSession, openSession, actionError, dismissActionError: () => setActionError(null), onAction: (id, action) => void runAction(id, action), onDelete: (o) => setDeleteTarget(o), onClose: closeDetail, onSaved: () => void refresh() }) : null),
				deleteTarget ? h(DeleteConfirmModal, {
					target: deleteTarget,
					deleting,
					onCancel: () => { if (!deleting) setDeleteTarget(null); },
					onConfirm: () => void confirmDelete(deleteTarget.id),
				}) : null);
		}

		function LoadingView() {
			return h("div", { style: { padding: 40, textAlign: "center", color: "var(--dsw-alias-label-secondary)" } }, "加载中…");
		}

		function EmptyView({ startCreateSession }) {
			return h("div", { style: { ...C.card, padding: 40, textAlign: "center", color: "var(--dsw-alias-label-secondary)" } },
				"还没有编排。", h("div", { style: { fontSize: 11, marginTop: 6 } }, "列表为 Host 权威数据（list 回读）"),
				h("div", { style: { marginTop: 12 } },
					h("button", { style: C.btnPri, onClick: () => startCreateSession && startCreateSession() }, "＋ 新建编排（对话式）")));
		}

		function ErrorView({ state, onRetry }) {
			return h("div", { style: { ...C.card, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)", padding: 20 } },
				h("div", { style: { fontWeight: 700 } }, "加载失败（列表回读）；若刚保存，保存已成功，请重试回读。"),
				h("div", { style: { ...C.mono, margin: "6px 0 10px", whiteSpace: "pre-wrap" } }, state.code, "：", state.message),
				h("button", { style: C.btn, onClick: onRetry }, "重试"));
		}

		function TableView({ items, selectedId, onOpen }) {
			const th = { textAlign: "left", ...C.muted, fontSize: 11, padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)" };
			const td = { padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)", fontSize: 12 };
			return h("table", { className: "so-table", style: { width: "100%", borderCollapse: "collapse", background: "var(--dsw-alias-bg-layer-1)" } },
				h("thead", null, h("tr", null, ["状态", "标题", "触发", "下次"].map((x) => h("th", { key: x, style: th }, x)))),
				h("tbody", null, items.map((o) => h("tr", { key: o.id, "data-selected": o.id === selectedId, style: { cursor: "pointer" }, onClick: () => onOpen(o.id) },
					h("td", { style: td }, h(Chip, { s: o.status })),
					h("td", { style: { ...td, minWidth: 100 } }, h("button", { className: "so-title", "data-id": o.id, "aria-expanded": o.id === selectedId, "aria-controls": o.id === selectedId ? "so-detail" : undefined, onClick: (e) => { e.stopPropagation(); onOpen(o.id); } }, o.title || o.id), h("div", { style: { ...C.muted, ...C.mono, fontSize: 10, overflowWrap: "anywhere" } }, o.id)),
					h("td", { style: td }, h(TriggerSummary, { t: o.trigger })),
					h("td", { style: td }, fmtTime(o.nextOccurrence))))));
		}

		// 删除二次确认（契约 11：删除有二次确认、操作期间状态清晰；票 29）
		function DeleteConfirmModal({ target, deleting, onConfirm, onCancel }) {
			return h("div", {
				style: { position: "fixed", inset: 0, background: "var(--dsw-alias-bg-overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 },
			},
				h("div", { style: { ...C.card, width: 430, maxWidth: "92vw", boxShadow: "0 12px 40px var(--dsw-alias-bg-overlay)" } },
					h("div", { style: { fontWeight: 700, color: "var(--dsw-alias-state-error-primary)", fontSize: 14 } }, "删除编排"),
					h("div", { style: { marginTop: 8, fontSize: 13 } }, "「", target.title || target.id, "」", h("span", { style: { ...C.muted, ...C.mono, fontSize: 11 } }, " ", target.id)),
					h("div", { style: { ...C.muted, fontSize: 12, marginTop: 8 } }, "将取消在途 run 并删除全部执行记录（含历史）；此操作不可恢复。"),
					h("div", { style: { ...C.row, marginTop: 14, justifyContent: "flex-end" } },
						h("button", { style: C.btn, disabled: deleting, onClick: onCancel }, "取消"),
						h("button", {
							style: { ...C.btn, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 },
							disabled: deleting,
							onClick: onConfirm,
						}, deleting ? "删除中…" : "确认删除"))));
		}

		// ---------------- 非模态详情栏（view 回读，key=id 隔离切换前后的状态） ----------------
		function DetailPanel({ call, id, reloadKey, startEditSession, openSession, actionError, dismissActionError, onAction, onDelete, onClose, onSaved }) {
			const [state, setState] = useState({ phase: "loading" });

			// 完整溢写输出读取（票 34）：RunCard 的「全量」按钮 → spill 端点（排障读面）。
			// 文件已不存在/不可读时以契约错误呈现（服务返回 script_storage_unavailable）。
			const [spill, setSpill] = useState(null);
			const [editing, setEditing] = useState(null);
			// 执行记录折叠（v0.1x）：默认仅渲染最近 3 条；展开是本地展示状态，不触发额外取数
			const [runsExpanded, setRunsExpanded] = useState(false);
			const loadVersion = useRef(0);
			const saved = useRef(false);
			async function openSpill(runId, stream) {
				setSpill({ phase: "loading", runId, stream });
				let res;
				try {
					res = await call("spill", { runId, stream });
				} catch (e) {
					setSpill({ phase: "error", runId, stream, code: "transport", message: String((e && e.message) || e) });
					return;
				}
				if (res && res.ok) setSpill({ phase: "ready", runId, stream, value: res.value });
				else {
					const error = (res && res.error) || {};
					setSpill({ phase: "error", runId, stream, code: error.code || "internal_error", message: error.message || "未知错误" });
				}
			}

			async function load(opts) {
				const version = ++loadVersion.current;
				if (!opts || !opts.silent) setState({ phase: "loading" });
				try {
					// v0.1x：恒定取回最近至多 50 条（服务单次上限），计数/轮询/展开共用同一口径
				const res = await call("view", { id, runs: 50 });
					if (version !== loadVersion.current) return;
					if (res && res.ok) { saved.current = false; setState({ phase: "ready", data: res.value }); }
					else {
						const error = (res && res.error) || {};
						setState({ phase: "error", code: error.code || "internal_error", message: error.message || "未知错误" });
					}
				} catch (e) {
					if (version !== loadVersion.current) return;
					if (opts && opts.silent && !saved.current) { setState(current => current.phase === 'loading' ? { phase:'error', code:'transport', message:String((e && e.message) || e) } : current); return; }
					setState({ phase: "error", code: "transport", message: String((e && e.message) || e) });
				}
			}

			useEffect(() => { void load({ silent: true }); return () => { loadVersion.current++; }; }, [id, reloadKey]);
			// 切换编排时重置折叠回默认 3 条（v0.1x）
			useEffect(() => { setRunsExpanded(false); }, [id]);

			// 活动 run 轮询（契约 11）：可见 + 存在非终态 run 时每 5 秒 view(id)；
			// 任一停止条件（无活动 run / 不可见 / 组件卸载）即停
			const hasActiveRun = state.phase === "ready" && state.data.runs.some((r) => !RUN_TERMINAL[r.status]);
			useEffect(() => {
				if (!hasActiveRun) return;
				const timer = setInterval(() => {
					if (document.visibilityState !== "visible") return;
					void load({ silent: true });
				}, POLL_MS);
				return () => clearInterval(timer);
			}, [hasActiveRun, id]);

			const section = (label, body) => h("div", { style: { marginTop: 12 } },
				h("div", { style: { ...C.muted, fontSize: 11, marginBottom: 4 } }, label), body);

			return h("aside", { id: "so-detail", className: "so-detail", "aria-label": "编排详情" },
				h("div", { className: "so-detail-header" },
					h("b", { style: { fontSize: 14 } }, "编排详情"),
					h("button", { style: { ...C.btn, marginLeft: "auto" }, "aria-label": "关闭详情", onClick: onClose }, "关闭")),
				h("div", { className: "so-detail-body" },
					actionError ? h("div", { role: "alert", style: { ...C.card, marginTop: 12, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" } },
						h("b", null, "操作失败（", actionError.code, "）"),
						h("p", { style: { margin: "6px 0" } }, actionError.message),
						h("button", { style: C.btn, onClick: dismissActionError }, "关闭提示")) : null,
					state.phase === "loading" ? h("div", { style: { padding: 30, textAlign: "center", ...C.muted } }, "加载详情…")
					: state.phase === "error" ? h("div", { style: { color: "var(--dsw-alias-state-error-primary)" } },
						h("div", null, "详情回读失败（", state.code, "）。", saved.current ? "保存已成功，请重试回读。" : "请重试回读。"),
						h("div", { style: { ...C.mono, fontSize: 11, margin: "6px 0 10px", whiteSpace: "pre-wrap" } }, state.message),
						h("div", { style: C.row },
							h("button", { style: C.btn, onClick: () => void load() }, "重试")))
					: h("div", null,
						h("div", { style: { ...C.row, flexWrap: "wrap", marginTop: 12 } },
							h("h2", { style: { fontSize: 15, margin: 0, minWidth: 0, overflowWrap: "anywhere" } }, state.data.title || state.data.id),
							h(Chip, { s: state.data.status })),
						h("div", { style: { ...C.muted, ...C.mono, fontSize: 11, marginTop: 4 } }, state.data.id),
						h("div", { style: { ...C.row, flexWrap: "wrap", marginTop: 12 } },
							state.data.status === "active" ? h("button", { style: C.btn, onClick: () => onAction(id, "pause") }, "暂停") : null,
							state.data.status === "paused" ? h("button", { style: C.btn, onClick: () => onAction(id, "resume") }, "恢复") : null,
							h("button", { style: C.btnPri, onClick: () => onAction(id, "run") }, "执行"),
							h("button", { style: { ...C.btn, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" }, title: "取消在途 run 并级联删除全部执行记录（二次确认）", onClick: () => onDelete(state.data) }, "删除"),
							h("button", { style: C.btn, onClick: () => setEditing(state.data) }, "手动修改"),
							h("button", { style: C.btn, onClick: () => startEditSession && startEditSession(state.data.id) }, "在新会话修改")),
						section("触发配置",
							h("div", { style: C.mono }, h(TriggerSummary, { t: state.data.trigger }))),
						section("状态与下次触发",
							h("div", { style: { ...C.row, flexWrap: "wrap" } },
								h("span", null, "状态：", STATUS_CN[state.data.status] || state.data.status),
								h("span", { style: { marginLeft: 12 } }, "下次触发：",
									state.data.nextOccurrence ? fmtTime(state.data.nextOccurrence) : "—（暂停或等待结算）"))),
						// 完成后行为（v0.1y）：judge/actions 翻译成人话，纯展示不进编辑
						section("脚本完成后",
							h(AfterScriptSummary, { judge: state.data.judge, actions: state.data.actions, availableActions: state.data.availableActions })),
						// 执行记录（v0.1x）：默认仅渲染最近 3 条；>3 提供「展开全部执行记录」，
						// 展开后可收起；取回数达 50（服务单次上限）时如实标注
						section("执行记录（" + state.data.runs.length + "）",
							state.data.runs.length === 0
								? h("div", { style: { ...C.muted, fontSize: 12 } }, "还没有执行记录（创建不会立即执行脚本）")
								: h("div", null,
									state.data.runs.slice(0, runsExpanded ? undefined : 3).map((r) => h(RunCard, { key: r.runId, r, onReadSpill: (runId, stream) => void openSpill(runId, stream), onOpenSession: openSession })),
									!runsExpanded && state.data.runs.length > 3
										? h("button", { style: { ...C.btn, fontSize: 11 }, onClick: () => setRunsExpanded(true) }, "展开全部执行记录")
										: null,
									runsExpanded && state.data.runs.length > 3
										? h("button", { style: { ...C.btn, fontSize: 11 }, onClick: () => setRunsExpanded(false) }, "收起，仅显示最近 3 条")
										: null,
									state.data.runs.length >= 50
										? h("div", { style: { ...C.muted, fontSize: 11, marginTop: 4 } }, "已达服务上限：最多显示最近 50 条执行记录")
										: null)),
						section("可用注册动作",
							state.data.availableActions.length === 0
								? h("div", { style: { ...C.muted, fontSize: 12 } }, "暂无注册动作（其他插件可通过 ctx.scriptOrchestrator.registerAction 注册）")
								: state.data.availableActions.map((a) => h("div", { key: a.name, style: { ...C.mono, fontSize: 11 } }, a.name, a.description ? " — " + a.description : ""))))),
				spill ? h(SpillModal, { spill, onClose: () => setSpill(null) }) : null,
				editing ? h(EditModal, { initial: editing, call, onClose: () => setEditing(null), onSaved: () => { saved.current = true; setEditing(null); void load({ silent: true }); onSaved(); } }) : null);
		}

		// 私有草稿模块：每个编辑区域只拥有自己的字段，嵌套对象作为整块 patch。
		function makeDraft(o) {
			const { command, args, cwd, timeoutSeconds, ...advanced } = o.script;
			return { title: o.title, enabled: o.enabled, overlap: o.overlap,
				kind: o.trigger.kind, everySeconds: String(o.trigger.everySeconds ?? ''), mode: o.trigger.mode || 'fixed-rate',
				expression: o.trigger.expression || '', timeZone: o.trigger.timeZone || '',
				command, args: JSON.stringify(args ?? []), cwd: cwd ?? '', timeoutSeconds: timeoutSeconds == null ? '' : String(timeoutSeconds),
				advanced: JSON.stringify(advanced, null, 2), judge: JSON.stringify(o.judge, null, 2), actions: JSON.stringify(o.actions, null, 2) };
		}
		const stableJson = value => value && typeof value === 'object'
			? (Array.isArray(value) ? '[' + value.map(stableJson).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}')
			: JSON.stringify(value);
		const equalJson = (a,b) => stableJson(a) === stableJson(b);
		function draftPatch(base, d) {
			const parseObject = (value, label) => { let x; try { x = JSON.parse(value); } catch { throw new Error(label + ' JSON 格式错误'); } if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(label + ' 必须是 JSON 对象'); return x; };
			let args; try { args = JSON.parse(d.args); } catch { throw new Error('参数必须是 JSON 字符串数组'); }
			if (!Array.isArray(args) || args.some(x => typeof x !== 'string')) throw new Error('参数必须是 JSON 字符串数组');
			const advanced = parseObject(d.advanced, '脚本高级字段');
			if (['command','args','cwd','timeoutSeconds'].some(k => Object.prototype.hasOwnProperty.call(advanced,k))) throw new Error('脚本高级字段不可包含表单字段');
			const judge = parseObject(d.judge, '判定'); const actions = parseObject(d.actions, '动作');
			if (!Array.isArray(judge.rules)) throw new Error('判定 rules 必须是数组');
			const patch = {};
			for (const k of ['title','enabled','overlap']) if (!equalJson(d[k],base[k])) patch[k] = d[k];
			const original = makeDraft(base);
			if (['kind','everySeconds','mode','expression','timeZone'].some(k => d[k] !== original[k])) {
				if (d.kind === 'every') { const n = Number(d.everySeconds); if (!Number.isInteger(n) || n < 60) throw new Error('间隔必须为至少 60 的整数'); patch.trigger = { ...(base.trigger.kind === 'every' ? base.trigger : {}), kind:'every', everySeconds:n }; if (d.mode !== original.mode || base.trigger.kind !== 'every' || Object.hasOwn(base.trigger, 'mode')) patch.trigger.mode = d.mode; }
				else { if (!d.expression.trim() || !d.timeZone.trim()) throw new Error('cron 表达式及时区必填'); patch.trigger = { ...(base.trigger.kind === 'cron' ? base.trigger : {}), kind:'cron', expression:d.expression, timeZone:d.timeZone }; }
			}
			if (['command','args','cwd','timeoutSeconds','advanced'].some(k => d[k] !== original[k])) {
				if (!d.command.trim()) throw new Error('命令必填');
				const script = { ...advanced, command:d.command };
				if (d.args !== original.args || Object.hasOwn(base.script,'args')) script.args = args;
				if (d.cwd !== original.cwd) { if (d.cwd) script.cwd = d.cwd; } else if (Object.hasOwn(base.script, 'cwd')) script.cwd = base.script.cwd;
				if (d.timeoutSeconds !== '') { const n=Number(d.timeoutSeconds); if (!Number.isInteger(n) || n < 1 || n > 86400) throw new Error('超时必须为 1–86400 秒整数'); script.timeoutSeconds=n; }
				if (!equalJson(script,base.script)) patch.script=script;
			}
			if (!equalJson(judge,base.judge)) patch.judge=judge;
			if (!equalJson(actions,base.actions)) patch.actions=actions;
			if (patch.trigger && equalJson(patch.trigger, base.trigger)) delete patch.trigger;
			return patch;
		}
		function describePatch(base, patch) {
			const labels={title:'标题',enabled:'启用状态',overlap:'重叠策略',trigger:'触发计划',script:'脚本',judge:'判定 JSON',actions:'动作 JSON'};
			return Object.keys(patch).map(key=>{
				const fields=key==='trigger'?{kind:'触发方式',everySeconds:'间隔',mode:'间隔模式',expression:'Cron 表达式',timeZone:'时区'}:key==='script'?{command:'命令',args:'参数',cwd:'工作目录',timeoutSeconds:'超时',env:'环境变量',stdin:'标准输入'}:null;
				const changed=fields?Object.keys(fields).filter(k=>!equalJson(base[key]?.[k],patch[key][k])).map(k=>fields[k]):[];
				return labels[key]+' ('+key+')'+(changed.length?'：'+changed.join('、'):'');
			}).join('；');
		}
		function EditModal({ initial, call, onClose, onSaved }) {
			const [base,setBase] = useState(initial); const [draft,setDraft] = useState(() => makeDraft(initial));
			const [error,setError] = useState(''); const [summary,setSummary] = useState(null); const [saving,setSaving] = useState(false); const [mustReload,setMustReload] = useState(false);
			const busy=useRef(false); const box=useRef(null);
			let dirty; try { dirty=Object.keys(draftPatch(base,draft)).length>0; } catch { dirty=true; }
			const close=() => { if (busy.current) return; if (!dirty || window.confirm('丢弃未保存的修改？')) onClose(); };
			const closeRef=useRef(close); closeRef.current=close;
			useEffect(() => { const previous=document.activeElement; const node=box.current; const focusables=()=>Array.from(node.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')); focusables()[0]?.focus();
				const key=(e)=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closeRef.current(); } else if(e.key==='Tab'){ const f=focusables(); if(!f.length) { e.preventDefault(); node.focus(); return; } const i=f.indexOf(document.activeElement); if(e.shiftKey && i<=0){e.preventDefault();f[f.length-1].focus();} else if(!e.shiftKey && (i<0 || i===f.length-1)){e.preventDefault();f[0].focus();} } };
				const containFocus=()=>{if(!node.contains(document.activeElement)) (focusables()[0] || node).focus();};
				document.addEventListener('keydown',key,true); document.addEventListener('focusin',containFocus);
				return ()=>{document.removeEventListener('keydown',key,true);document.removeEventListener('focusin',containFocus);previous?.focus?.();}; },[]);
			useEffect(()=>{if(saving) box.current?.focus();},[saving]);
			const change=(key,value)=>{setDraft(x=>({...x,[key]:value}));setSummary(null);setError('');};
			const field=(label,key,kind='input',options)=>h('label',{key,className:'so-edit-field'},h('span',{className:'so-edit-field-label'},label), kind==='select' ? h('select',{disabled:saving,value:String(draft[key]),onChange:e=>change(key,key==='enabled' ? e.target.value==='true' : e.target.value)},options.map(([v,t])=>h('option',{key:v,value:v},t))) : h(kind,{disabled:saving,value:draft[key],onChange:e=>change(key,e.target.value), ...(kind==='textarea'?{rows:4,className:'so-edit-json'}: {})}));
			const prepare=()=>{try {if (mustReload) throw new Error('请先加载新版本并核对后再保存'); if (!Object.hasOwn(base, 'updatedAt')) throw new Error('缺少版本信息，请回读后再保存'); const p=draftPatch(base,draft); if(!Object.keys(p).length){setError('没有变更');return;} setError('');setSummary(p);} catch(e){setError(e.message);} };
			const submit=async()=>{ if(busy.current || !summary) return; busy.current=true;setSaving(true);setError('');try {const r=await call('edit',{id:base.id,action:'update',patch:summary,expectedUpdatedAt:base.updatedAt}); if(r?.ok){onSaved();return;} const er=r?.error || {};setError((er.code||'internal_error')+'：'+(er.message||'保存失败')+(er.code==='script_conflict'?'。草稿已保留；请复制草稿，回读新版本并重新确认。':''));if(er.code==='script_conflict') setMustReload(true); setSummary(null);}catch(e){setError('传输失败，保存结果未知；请回读核对后再决定：'+String(e.message||e));setMustReload(true);setSummary(null);}finally{busy.current=false;setSaving(false);} };
			const reload=async()=>{if(busy.current)return;if(dirty && !window.confirm('加载新版本将丢弃草稿，继续？'))return;busy.current=true;setSaving(true);try{const r=await call('view',{id:base.id});if(!r?.ok)throw new Error(r?.error?.message||'回读失败');setBase(r.value);setDraft(makeDraft(r.value));setError('');setSummary(null);setMustReload(false);}catch(e){setError('回读失败：'+String(e.message||e));}finally{busy.current=false;setSaving(false);}};
			return h('div',{style:{position:'fixed',inset:0,background:'rgba(0,0,0,.35)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:90,padding:24},onClick:e=>{if(e.target===e.currentTarget)close();}},
				h('div',{ref:box,tabIndex:-1,role:'dialog','aria-modal':'true','aria-labelledby':'so-edit-title',className:'so-edit-dialog'},
					h('div',{className:'so-edit-head'},
						h('button',{type:'button',className:'so-edit-close','aria-label':'关闭编辑',disabled:saving,onClick:close},'×'),
						h('div',{className:'so-edit-head-text'},
							h('h2',{id:'so-edit-title',className:'so-edit-title'},'手动修改 · ',base.id),
							h('p',{className:'so-edit-subtitle'},'id 与运行派生字段只读；仅提交显式改动的字段。'))),
					h('div',{className:'so-edit-body'},
						h('section',{className:'so-edit-section'},h('h3',{className:'so-edit-section-title'},'基本信息'),
							field('标题','title')),
						h('section',{className:'so-edit-section'},h('h3',{className:'so-edit-section-title'},'触发计划'),
							field('触发方式','kind','select',[['every','间隔'],['cron','Cron']]),
							draft.kind==='every'?field('间隔（秒）','everySeconds'):null,
							draft.kind==='every'?field('间隔模式','mode','select',[['fixed-rate','固定相位'],['fixed-delay','完成后再等']]):null,
							draft.kind==='cron'?field('Cron 表达式','expression'):null,
							draft.kind==='cron'?field('IANA 时区','timeZone'):null),
						h('section',{className:'so-edit-section'},h('h3',{className:'so-edit-section-title'},'脚本'),
							field('命令','command'),
							field('逐项参数（JSON 字符串数组）','args','textarea'),
							field('工作目录','cwd'),
							field('超时（秒，可留空）','timeoutSeconds'),
							field('脚本高级字段 JSON（env、stdin 等）','advanced','textarea')),
						h('section',{className:'so-edit-section'},h('h3',{className:'so-edit-section-title'},'判定与动作'),
							field('判定 JSON','judge','textarea'),
							field('动作 JSON','actions','textarea')),
						h('section',{className:'so-edit-section'},h('h3',{className:'so-edit-section-title'},'运行行为'),
							field('启用状态','enabled','select',[['true','启用'],['false','暂停']]),
							field('重叠策略','overlap','select',[['skip','跳过'],['queue','排队']])),
						error?h('p',{role:'alert',className:'so-edit-notice so-edit-notice-error'},error):null,
						summary?h('div',{role:'status',className:'so-edit-notice'},h('b',null,'变更摘要（不显示字段值）：'),h('p',null,describePatch(base,summary)),h('p',null,'请核对上方表单中的修改；高级 JSON 值不在摘要中重复显示。'),(base.status==='active'||summary.enabled===true)?h('p',null,summary.enabled===true?'保存后将启用此编排，并按计划自动执行。':'此编排已启用，修改可能影响后续自动执行。'):null,summary.enabled===false?h('p',null,'保存后将暂停后续自动触发。'):null,h('p',null,'保存不会试运行。')):null),
					h('div',{className:'so-edit-foot'},
						h('button',{className:'so-edit-btn',disabled:saving,onClick:close},'取消'),
						h('button',{className:'so-edit-btn',disabled:saving,onClick:()=>void reload()},'加载新版本'),
						h('button',{className:'so-edit-btn so-edit-btn-primary',disabled:saving,onClick:()=>summary?void submit():prepare()},saving?'处理中…':summary?'确认保存':'检查变更'))));
		}

		// 会话引用（v0.1ab，契约 11「会话引用可跳转」）：有 openSession 时渲染为链接按钮，
		// 点击选中该会话（纯导航）；宿主未提供时降级为纯文本 span。
		const SESSION_LINK_STYLE = { ...C.mono, fontSize: 10, border: 0, padding: 0, background: "none", cursor: "pointer", color: "var(--dsw-alias-brand-primary)", textAlign: "left", textDecoration: "underline", overflowWrap: "anywhere" };
		function SessionRef({ sessionId, onOpenSession, title, children }) {
			return onOpenSession
				? h("button", { type: "button", title: title || "跳转到该会话", onClick: () => onOpenSession(sessionId), style: SESSION_LINK_STYLE }, children)
				: h("span", { style: { ...C.mono, fontSize: 10 }, title }, children);
		}

		// 结果块（v0.1y，契约 11「结果块优先展示」）：脚本标记行结果（summary 按 level 配色、
		// fields 键值对）+ 其后追加的 reports（相对时间 + sessionId 尾 8 位 + summary + fields）。
		// 渲染位置在判定行之后、原始输出之前；无 result 的 run 卡片不渲染本块。
		// v0.1ab：reports 的上报会话 sessionId 可点击跳转（契约 11「会话引用可跳转」）。
		function ResultBlock({ result, onOpenSession }) {
			const errColor = "var(--dsw-alias-state-error-primary)";
			const warnColor = "var(--dsw-alias-state-warn-primary)";
			const levelColor = result.level === "error" ? errColor : result.level === "warn" ? warnColor : "var(--dsw-alias-label-primary)";
			const fields = result.fields && typeof result.fields === "object" ? Object.entries(result.fields) : [];
			const reports = Array.isArray(result.reports) ? result.reports : [];
			return h("div", { style: { marginTop: 3, borderLeft: "2px solid " + levelColor, paddingLeft: 6 } },
				result.summary !== undefined ? h("div", { style: { ...C.row, fontSize: 11, flexWrap: "wrap", alignItems: "baseline" } },
					h("span", { ...C.muted }, "结果："),
					h("span", { style: { color: levelColor, fontWeight: 600, overflowWrap: "anywhere" } }, result.summary),
					result.level && result.level !== "info" ? h("span", { style: { color: levelColor, fontSize: 10 } }, "（" + result.level + "）") : null) : null,
				fields.map(([k, v]) => h("div", { key: "f-" + k, style: { ...C.row, fontSize: 11, flexWrap: "wrap" } },
					h("span", { style: { ...C.muted, ...C.mono, fontSize: 10 } }, k + "："),
					h("span", { style: { ...C.mono, fontSize: 10, overflowWrap: "anywhere" } }, String(v)))),
				reports.map((rep, i) => h("div", { key: "r-" + i, style: { fontSize: 11, marginTop: 3, overflowWrap: "anywhere" } },
					h("span", { ...C.muted, fontSize: 10, title: fmtTime(rep.at) }, "会话上报 · " + fmtRelTime(rep.at)),
					rep.sessionId ? h("span", { style: { marginLeft: 6 } }, h(SessionRef, { sessionId: rep.sessionId, onOpenSession, title: rep.sessionId + " · 跳转到该会话" },
						"…" + String(rep.sessionId).slice(-8))) : null,
					h("div", { style: { color: rep.level === "error" ? errColor : rep.level === "warn" ? warnColor : "var(--dsw-alias-label-primary)", fontWeight: 600 } },
						rep.summary),
					rep.fields && typeof rep.fields === "object"
						? Object.entries(rep.fields).map(([k, v]) => h("div", { key: "rf-" + i + "-" + k, style: { ...C.row, fontSize: 11, flexWrap: "wrap" } },
							h("span", { style: { ...C.muted, ...C.mono, fontSize: 10 } }, k + "："),
							h("span", { style: { ...C.mono, fontSize: 10, overflowWrap: "anywhere" } }, String(v)))) : null)));
		}

		// 单条 run 记录卡（v0.1x 直观化）：状态彩色徽章 + 相对时间（title 绝对时刻）+
		// 人性化耗时 + 非零退出码/超时错误色 + runId 尾 4 位（title 完整）+ stdout/stderr 尾部直展
		function RunCard({ r, onReadSpill, onOpenSession }) {
			const s = r.script || {};
			const errColor = "var(--dsw-alias-state-error-primary)";
			const warnColor = "var(--dsw-alias-state-warn-primary)";
			const facts = [];
			if (r.skipReason) facts.push({ text: "跳过（" + (SKIP_REASON_CN[r.skipReason] || r.skipReason) + "）" });
			if (s.exitCode !== null && s.exitCode !== undefined) facts.push({ text: "退出码 " + s.exitCode, color: s.exitCode !== 0 ? errColor : undefined });
			if (s.signal) facts.push({ text: "信号 " + s.signal });
			if (s.timedOut) facts.push({ text: "已超时", color: errColor });
			if (typeof s.durationMs === "number" && s.durationMs > 0) facts.push({ text: "耗时 " + fmtDuration(s.durationMs) });
			if (s.truncated) facts.push({ text: "已截断", color: warnColor });
			// 未结算标「开始于」、未开始标「计划于」；绝对时刻在 title
			const timeIso = r.settledAt || r.startedAt || r.scheduledAt;
			const timePrefix = !r.settledAt ? (r.startedAt ? "开始于 " : "计划于 ") : "";
			// runId 仅显尾 4 位（run-<8 hex>），完整 id 在 title
			const shortId = typeof r.runId === "string" && r.runId.length > 4 ? "…" + r.runId.slice(-4) : r.runId;
			const tailPreview = previewTail(s.stdoutTail);
			const errPreview = previewTail(s.stderrTail);
			// 判定段（契约 04 判定结果表：下标命中 / fallback / 全未命中零动作）。
			// 不展示：skipped（未执行）与 spawn_failed 的 failed（跳过判定、无动作记录）
			const actions = r.actions || [];
			const judged = !r.skipReason && !(r.status === "failed" && actions.length === 0);
			const judgeText = r.matchedRule !== null && r.matchedRule !== undefined
				? "命中规则 " + (r.matchedRule + 1) // matchedRule 零下标（契约 04），展示按 1 起始与详情「规则 N」对齐
				: r.usedFallback ? "命中兜底" : "未命中（不执行动作）";
			return h("div", { style: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 8, padding: "6px 8px", marginBottom: 6 } },
				h("div", { style: { ...C.row, fontSize: 11, flexWrap: "wrap" } },
					h(RunChip, { s: r.status }),
					h("span", { style: { ...C.muted }, title: fmtTime(timeIso) }, timePrefix + fmtRelTime(timeIso)),
					facts.map((f, i) => h("span", { key: i, style: { color: f.color || "var(--dsw-alias-label-secondary)" } }, (i ? " · " : "") + f.text)),
					h("span", { style: { ...C.muted, ...C.mono, marginLeft: "auto" }, title: r.runId }, shortId)),
				judged ? h("div", { style: { ...C.row, fontSize: 11, marginTop: 2 } },
					h("span", { ...C.muted }, "判定："),
					h("span", null, judgeText)) : null,
				// 结果块优先展示（v0.1y）：脚本标记行结果 + 会话追加 reports，在原始输出之前
				r.result && (r.result.summary !== undefined || (Array.isArray(r.result.reports) && r.result.reports.length > 0))
					? h(ResultBlock, { result: r.result, onOpenSession }) : null,
				(s.stdoutSpillPath || s.stderrSpillPath) && h("div", { style: { ...C.row, fontSize: 10, marginTop: 2, flexWrap: "wrap" } },
					h("span", { ...C.muted }, "完整输出："),
					s.stdoutSpillPath ? h("button", { style: { ...C.btn, padding: "1px 6px", fontSize: 10 }, onClick: () => onReadSpill && onReadSpill(r.runId, "stdout") }, "stdout 全量") : null,
					s.stderrSpillPath ? h("button", { style: { ...C.btn, padding: "1px 6px", fontSize: 10 }, onClick: () => onReadSpill && onReadSpill(r.runId, "stderr") }, "stderr 全量") : null,
					h("span", { ...C.muted }, "（溢写文件，排障可读）")),
				tailPreview ? h("div", { style: { marginTop: 3 } },
					h("div", { style: { ...C.muted, fontSize: 10 } }, "stdout 尾部"),
					h("div", { style: { ...C.mono, fontSize: 10, whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base)", borderRadius: 6, padding: "4px 6px", maxHeight: 120, overflowY: "auto" } },
						s.truncated ? "…" : "", tailPreview)) : null,
				errPreview ? h("div", { style: { marginTop: 3 } },
					h("div", { style: { ...C.muted, fontSize: 10 } }, "stderr 尾部"),
					h("div", { style: { ...C.mono, fontSize: 10, whiteSpace: "pre-wrap", color: errColor, background: "var(--dsw-alias-bg-base)", borderRadius: 6, padding: "4px 6px", maxHeight: 120, overflowY: "auto" } },
						s.truncated ? "…" : "", errPreview)) : null,
				s.warnings && s.warnings.length > 0 ? h("div", { style: { color: "var(--dsw-alias-state-warn-primary)", fontSize: 10, marginTop: 3 } },
					s.warnings.join("；")) : null,
				actions.length > 0 ? h("div", { style: { marginTop: 4 } },
					h("div", { ...C.muted, fontSize: 10 }, "动作（" + actions.length + "）"),
					actions.map((a) => h("div", { key: a.name, style: { ...C.row, fontSize: 11, marginTop: 2, flexWrap: "wrap" } },
						h("span", { style: { color: ACTION_STATUS_COLOR[a.status] || "var(--dsw-alias-label-secondary)", fontWeight: 600 } },
							ACTION_STATUS_CN[a.status] || a.status),
						h("span", { style: { ...C.mono } }, a.name),
						h("span", { style: { ...C.muted } }, ACTION_KIND_CN[a.kind] || a.kind),
						// 会话引用（票 32）：成功与 delivery_failed 的 sessionId 都展示——
						// persistent 会话随时可接管，失败现场靠该 id 找回；v0.1ab 起渲染为链接按钮可跳转
						a.sessionId ? h(SessionRef, { sessionId: a.sessionId, onOpenSession, title: a.sessionId + " · 跳转到该会话" },
							a.sessionId, a.kind === "session" && a.status === "succeeded" ? "（可接管）" : "") : null,
						a.error ? h("span", { style: { ...C.mono, color: "var(--dsw-alias-state-error-primary)", fontSize: 10 } }, a.error.code, "：", a.error.message) : null,
						a.warnings && a.warnings.length > 0 ? h("span", { style: { color: "var(--dsw-alias-state-warn-primary)", fontSize: 10 } }, a.warnings.join("；")) : null))) : null);
		}

		// 完整溢写输出模态（票 34；契约 03「UI 读取 spill 失败时显示『文件已不存在』」）：
		// 加载态 / 成功全文（只读 pre，可滚动）/ 失败排障态（code + message）。
		function SpillModal({ spill, onClose }) {
			const label = spill.stream === "stdout" ? "stdout" : "stderr";
			return h("div", {
				style: { position: "fixed", inset: 0, background: "var(--dsw-alias-bg-overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 80 },
				onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
			},
				h("div", { style: { ...C.card, width: 720, maxWidth: "94vw", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 12px 40px var(--dsw-alias-bg-overlay)" } },
					h("div", { style: { ...C.row, marginBottom: 8 } },
						h("b", { style: { fontSize: 14 } }, "完整输出 · ", label),
						h("span", { style: { ...C.muted, ...C.mono, fontSize: 10 } }, spill.runId),
						spill.phase === "ready" ? h("span", { style: { ...C.muted, fontSize: 10 } }, "（", spill.value.bytes, " 字节）") : null,
						h("button", { style: { ...C.btn, marginLeft: "auto" }, onClick: onClose }, "关闭")),
					spill.phase === "loading" ? h("div", { style: { padding: 24, textAlign: "center", ...C.muted } }, "读取溢写文件…")
					: spill.phase === "error" ? h("div", { style: { color: "var(--dsw-alias-state-error-primary)", padding: "8px 0" } },
						h("div", null, "无法读取完整输出（", spill.code, "）"),
						h("div", { style: { ...C.mono, fontSize: 11, marginTop: 6, whiteSpace: "pre-wrap" } }, spill.message),
						h("div", { style: { ...C.muted, fontSize: 11, marginTop: 6 } }, "溢写文件已不存在时属正常现象（系统 temp 清理或超 cap 撤回）；输出尾部仍可在 run 记录中查看。"))
					: h("pre", { style: { ...C.mono, fontSize: 11, margin: 0, padding: 10, background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 8, overflow: "auto", flex: 1, whiteSpace: "pre-wrap" } },
						spill.value.content || "（空输出）")));
		}

		// 侧边栏面板图标：20×20 线稿，currentColor 继承宿主明暗主题与选中态；
		// 宿主按「展开 16 / 收起 rail 18」传入 size，故按尺寸自适应而非固定字号。
		// 造型 = 终端窗口 + `>_` 提示符：一眼表达「脚本执行」，与相邻的插件库/自动化任务区分。
		function PanelIcon({ size = 18 } = {}) {
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 20 20",
				fill: "none",
				"aria-hidden": true,
				focusable: "false",
				style: { display: "block" },
			},
				h("rect", {
					x: 1.9, y: 2.9, width: 16.2, height: 14.2, rx: 3.2,
					stroke: "currentColor", strokeWidth: 1.7,
				}),
				h("path", {
					d: "M5.9 7.4 L8.9 10 L5.9 12.6",
					stroke: "currentColor", strokeWidth: 1.7,
					strokeLinecap: "round", strokeLinejoin: "round",
				}),
				h("path", {
					d: "M10.6 12.6 H14.1",
					stroke: "currentColor", strokeWidth: 1.7,
					strokeLinecap: "round",
				}));
		}

		// ---------------- 插件面 ----------------
		const inject = ["slots", "connection", "uiWorkspace"];

		function* apply(ctx) {
			// connection/reset → 面板权威回读（契约 11「刷新策略」）
			const resetListeners = new Set();
			ctx.effect(() => ctx.on("connection/reset", () => {
				for (const listener of [...resetListeners]) listener();
			}));

			const bindings = {
				call: (endpoint, payload, signal) =>
					ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal),
				subscribeReset: (listener) => {
					resetListeners.add(listener);
					return () => resetListeners.delete(listener);
				},
				// 新建仅预填草稿，用户发送后才进入 SKILL 流程。
				startCreateSession: () => {
					ctx.uiWorkspace.startSession(void 0, { prompt: CREATE_PROMPT, whenDraftExists: "append" });
				},
				// 对话式编辑（契约 11：在新会话预填草稿）：
				// 仅传 id，不把配置或敏感值拼入草稿；具体流程由 SKILL 维护。
				startEditSession: (id) => {
					ctx.uiWorkspace.startSession(void 0, { prompt: EDIT_PROMPT(id), whenDraftExists: "append" });
				},
				// 执行记录会话引用跳转（v0.1ab，契约 11「会话引用可跳转」）：
				// openSession 选中该会话并展示其对话，纯导航，不改变 run 记录与编排状态。
				openSession: (sessionId) => {
					ctx.uiWorkspace.openSession(sessionId);
				},
			};

			yield ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID, inject: () => bindings }, Panel));
			yield ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{ name: "sidebar.panellist", id: PANEL_ID, order: 91, label: () => "脚本编排" },
					PanelIcon));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
