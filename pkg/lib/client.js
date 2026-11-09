// @local/dsh-script-orchestrator · Web client（简化档：手写 lazy-CJS，零构建步骤）。
// 协议：window.__ModuleLoader__.load({ id, factory })，factory 内建 module/exports、
// require("react") 取页面 seed 的 React；导出 apply（生成器，yield 注销器）+ inject。
// 数据源：ctx.connection.rpc.call('/script-orchestrator', endpoint, payload)（契约
// docs/temp/11-web-panel.md：零翻译 DTO；权威数据永远来自 list/view 回读，无事件推送）。
// 创建/编辑主入口是对话式（契约 11 胜选 UX）：「新建」→ ctx.uiWorkspace.startSession
// 注入引导 prompt，由模型经 script_create 工具完成配置；面板自身只做管理与排障
//（高密度表格 + 居中模态详情），不引入独立配置表单。
window.__ModuleLoader__.load({
	id: "@local/dsh-script-orchestrator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useState, useEffect } = React;
		const h = React.createElement;

		const CHANNEL = "/script-orchestrator";
		const PANEL_ID = "script-orchestrator";

		// 对话式创建的引导 prompt（注入新会话的首条用户消息；与内置「自动化任务」面板 onNewTask 同一通道）
		const CREATE_PROMPT =
			"请帮我创建一个「脚本编排」：按计划自动运行脚本，并依据运行结果执行动作。请先向我逐项确认配置，再调用 script_create 工具创建：\n" +
			"1. 标题（1–120 字）与 id（可省略，由标题生成）；\n" +
			"2. 触发方式（二选一）：\n" +
			"   - every 间隔（整数秒，不低于 60）与模式（fixed-rate 固定相位 / fixed-delay 上次完成后再等）；\n" +
			"   - cron：五位表达式（minute hour day-of-month month day-of-week）+ 显式 IANA 时区，" +
			'如 { "kind": "cron", "expression": "0 3 * * *", "timeZone": "Asia/Shanghai" }。' +
			"用户说「每天 03:00」→ 0 3 * * *；「每周一、三、五 09:00」→ 0 9 * * 1,3,5；周日生成 0。 " +
			"每日/每周预设与其生成的 cron 使用同一 timeZone（向用户确认时区）。" +
			"不接受秒字段、@宏（如 @daily）与名称写法（JAN/MON）。\n" +
			"3. 脚本：command 与 args（逐项传参、不经 shell）、cwd、超时（可选）；\n" +
			"4. 判定规则：按退出码/输出匹配动作键，未命中可走 fallback；\n" +
			"5. 动作：事件（event）、注册动作（plugin）或开会话（session）。\n" +
			"创建前可先用 script_list 查看现有编排避免重名。创建成功后把编排的 id、状态和下次触发时刻告诉我；如果参数不合法（script_input_invalid），按错误提示修正后重试。";

		// ---------------- 样式（内联，沿用 proto/web-panel 变体 C 视觉） ----------------
		const C = {
			page: { padding: "20px 24px", fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#18181b", background: "#fafafa", minHeight: "100%" },
			card: { background: "#fff", border: "1px solid #e4e4e7", borderRadius: 10, padding: 14 },
			muted: { color: "#71717a" },
			mono: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 },
			row: { display: "flex", alignItems: "center", gap: 8 },
			btn: { border: "1px solid #d4d4d8", background: "#fff", borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
			btnPri: { border: "1px solid #2563eb", background: "#2563eb", color: "#fff", borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
		};
		const STATUS_COLOR = { active: "#16a34a", paused: "#d97706", ended: "#71717a" };
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
		const ACTION_STATUS_COLOR = { succeeded: "#16a34a", failed: "#dc2626", skipped: "#71717a" };
		// 活动 run 轮询周期（契约 11「刷新策略」3：面板可见且存在非终态 run 时每 5 秒 view(id)）
		const POLL_MS = 5000;
		const fmtTime = (iso) => (iso ? iso.replace("T", " ").replace(/(\.\d+|Z).*$/, "") : "—");
		const fmtEvery = (seconds) =>
			seconds % 60 === 0 ? Math.round(seconds / 60) + " 分钟" : seconds + " 秒";
		const pad2 = (n) => String(n).padStart(2, "0");

		// 每日/每周语义识别（契约 02「每日/每周面板预设」：只生成 cron；查看时语义上只是固定
		// 一个本地时间的每日或若干星期规则可回显简单形式）。多时刻、日期/月份限制、step 等
		// 复杂规则返回 null（只显示表达式原文）。简化档不做独立表单，仅文字摘要。
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
			const color = STATUS_COLOR[s] || "#71717a";
			return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, borderRadius: 999, padding: "1px 9px", fontSize: 11, background: color + "1a", color, border: "1px solid " + color + "55" } },
				h("span", { style: { width: 6, height: 6, borderRadius: 99, background: color } }), STATUS_CN[s] || s);
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

		// ---------------- 面板（数据经 Connection 桥，权威数据永远来自回读） ----------------
		function Panel({ call, subscribeReset, startCreateSession }) {
			const [state, setState] = useState({ phase: "loading" });
			const [detailId, setDetailId] = useState(null);
			const [reloadKey, setReloadKey] = useState(0);
			const [actionError, setActionError] = useState(null);

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

			// 行内管理操作（契约 11：暂停/恢复/执行经 Connection 调用并立即回读；
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

			return h("div", { style: C.page },
				h("div", { style: { ...C.row, marginBottom: 10 } },
					h("b", { style: { fontSize: 15 } }, "脚本编排"),
					state.phase === "ready"
						? h("span", { style: { ...C.muted, fontSize: 11 } }, "共 ", state.data.total, " 条")
						: null,
					h("div", { style: { ...C.row, marginLeft: "auto" } },
						h("button", { style: C.btn, onClick: () => void refresh() }, "刷新"),
						h("button", {
							style: C.btnPri,
							title: "经引导会话由模型用 script_create 创建；面板不提供表单",
							onClick: () => startCreateSession && startCreateSession(),
						}, "＋ 新建"))),
				state.phase === "loading" ? h(LoadingView)
				: state.phase === "error" ? h(ErrorView, { state, onRetry: () => void refresh() })
				: state.data.items.length === 0 ? h(EmptyView, { startCreateSession })
				: h("div", null,
					actionError ? h("div", {
						style: { ...C.row, ...C.card, borderColor: "#dc2626", color: "#dc2626", padding: "8px 12px", marginBottom: 8, fontSize: 12 },
					},
						h("b", null, "操作失败（", actionError.code, "）"),
						h("span", { style: { marginLeft: 6 } }, actionError.message),
						h("button", { style: { ...C.btn, marginLeft: "auto", padding: "2px 8px" }, onClick: () => setActionError(null) }, "关闭")) : null,
					h(TableView, { items: state.data.items, onOpen: (id) => setDetailId(id), onAction: (id, action) => void runAction(id, action) })),
				detailId ? h(DetailModal, { key: detailId + ":" + reloadKey, call, id: detailId, onClose: () => setDetailId(null) }) : null);
		}

		function LoadingView() {
			return h("div", { style: { padding: 40, textAlign: "center", color: "#71717a" } }, "加载中…");
		}

		function EmptyView({ startCreateSession }) {
			return h("div", { style: { ...C.card, padding: 40, textAlign: "center", color: "#71717a" } },
				"还没有编排。", h("div", { style: { fontSize: 11, marginTop: 6 } }, "列表为 Host 权威数据（list 回读）"),
				h("div", { style: { marginTop: 12 } },
					h("button", { style: C.btnPri, onClick: () => startCreateSession && startCreateSession() }, "＋ 新建编排（对话式）")));
		}

		function ErrorView({ state, onRetry }) {
			return h("div", { style: { ...C.card, borderColor: "#dc2626", color: "#dc2626", padding: 20 } },
				h("div", { style: { fontWeight: 700 } }, "加载失败"),
				h("div", { style: { ...C.mono, margin: "6px 0 10px", whiteSpace: "pre-wrap" } }, state.code, "：", state.message),
				h("button", { style: C.btn, onClick: onRetry }, "重试"));
		}

		function TableView({ items, onOpen, onAction }) {
			const th = { textAlign: "left", ...C.muted, fontSize: 11, padding: "6px 8px", borderBottom: "1px solid #e4e4e7" };
			const td = { padding: "6px 8px", borderBottom: "1px solid #f0f0f2", fontSize: 12 };
			// 行内操作（契约 11）：active → 暂停+执行；paused → 恢复+执行；ended → 执行（删除属票 29）
			const actionButton = (o, action, label, primary) => h("button", {
				style: primary ? { ...C.btnPri, padding: "3px 8px", fontSize: 11 } : { ...C.btn, padding: "3px 8px", fontSize: 11 },
				onClick: (e) => { e.stopPropagation(); onAction && onAction(o.id, action); },
			}, label);
			return h("table", { style: { width: "100%", borderCollapse: "collapse", background: "#fff", border: "1px solid #e4e4e7" } },
				h("thead", null, h("tr", null, ["状态", "标题", "触发", "下次", "操作"].map((x) => h("th", { key: x, style: th }, x)))),
				h("tbody", null, items.map((o) => h("tr", { key: o.id, style: { cursor: "pointer" }, onClick: () => onOpen(o.id) },
					h("td", { style: td }, h(Chip, { s: o.status })),
					h("td", { style: td }, h("b", null, o.title || o.id), h("div", { style: { ...C.muted, ...C.mono, fontSize: 10 } }, o.id)),
					h("td", { style: td }, h(TriggerSummary, { t: o.trigger })),
					h("td", { style: td }, fmtTime(o.nextOccurrence)),
					h("td", { style: { ...td, whiteSpace: "nowrap" }, onClick: (e) => e.stopPropagation() },
						o.status === "active" ? actionButton(o, "pause", "暂停") : null,
						o.status === "paused" ? actionButton(o, "resume", "恢复") : null,
						actionButton(o, "run", "执行", true))))));
		}

		// ---------------- 居中模态：详情（view 回读） ----------------
		function DetailModal({ call, id, onClose }) {
			const [state, setState] = useState({ phase: "loading" });

			async function load(opts) {
				if (!opts || !opts.silent) setState({ phase: "loading" });
				try {
					const res = await call("view", { id });
					if (res && res.ok) setState({ phase: "ready", data: res.value });
					else {
						const error = (res && res.error) || {};
						setState({ phase: "error", code: error.code || "internal_error", message: error.message || "未知错误" });
					}
				} catch (e) {
					if (opts && opts.silent) return; // 轮询静默失败：保留已呈现的权威数据
					setState({ phase: "error", code: "transport", message: String((e && e.message) || e) });
				}
			}

			useEffect(() => { void load(); }, [id]);

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

			return h("div", {
				style: { position: "fixed", inset: 0, background: "#0006", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 },
				onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
			},
				h("div", { style: { ...C.card, width: 560, maxWidth: "92vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 12px 40px #0003" } },
					state.phase === "loading" ? h("div", { style: { padding: 30, textAlign: "center", ...C.muted } }, "加载详情…")
					: state.phase === "error" ? h("div", { style: { color: "#dc2626" } },
						h("div", null, "详情加载失败（", state.code, "）"),
						h("div", { style: { ...C.mono, fontSize: 11, margin: "6px 0 10px", whiteSpace: "pre-wrap" } }, state.message),
						h("div", { style: C.row },
							h("button", { style: C.btn, onClick: () => void load() }, "重试"),
							h("button", { style: C.btn, onClick: onClose }, "关闭")))
					: h("div", null,
						h("div", { style: { ...C.row, marginBottom: 4 } },
							h("b", { style: { fontSize: 15 } }, state.data.title || state.data.id),
							h(Chip, { s: state.data.status }),
							h("span", { style: { ...C.muted, ...C.mono, fontSize: 11 } }, state.data.id),
							h("button", { style: { ...C.btn, marginLeft: "auto" }, onClick: onClose }, "关闭")),
						section("触发配置",
							h("div", { style: C.mono }, h(TriggerSummary, { t: state.data.trigger }))),
						section("状态与下次触发",
							h("div", { style: C.row },
								h("span", null, "状态：", STATUS_CN[state.data.status] || state.data.status),
								h("span", { style: { marginLeft: 12 } }, "下次触发：",
									state.data.nextOccurrence ? fmtTime(state.data.nextOccurrence) : "—（暂停或等待结算）"))),
						section("执行记录（" + state.data.runs.length + "）",
							state.data.runs.length === 0
								? h("div", { style: { ...C.muted, fontSize: 12 } }, "还没有执行记录（创建不会立即执行脚本）")
								: state.data.runs.map((r) => h(RunCard, { key: r.runId, r }))),
						section("可用注册动作（availableActions）",
							state.data.availableActions.length === 0
								? h("div", { style: { ...C.muted, fontSize: 12 } }, "暂无注册动作（其他插件可通过 ctx.scriptOrchestrator.registerAction 注册）")
								: state.data.availableActions.map((a) => h("div", { key: a.name, style: { ...C.mono, fontSize: 11 } }, a.name, a.description ? " — " + a.description : ""))))));
		}

		// 单条 run 记录卡：三段结果（契约 11：脚本 / 判定 / 动作 + warnings）
		function RunCard({ r }) {
			const s = r.script || {};
			const facts = [];
			if (r.skipReason) facts.push("跳过（" + (SKIP_REASON_CN[r.skipReason] || r.skipReason) + "）");
			if (s.exitCode !== null && s.exitCode !== undefined) facts.push("退出码 " + s.exitCode);
			if (s.signal) facts.push("信号 " + s.signal);
			if (s.timedOut) facts.push("已超时");
			if (typeof s.durationMs === "number" && s.durationMs > 0) facts.push(s.durationMs + "ms");
			if (s.truncated) facts.push("已截断");
			const tail = (s.stdoutTail || "").replace(/\s+$/, "");
			const tailPreview = tail.length > 200 ? tail.slice(-200) : tail;
			// 判定段（契约 04 判定结果表：下标命中 / fallback / 全未命中零动作）。
			// 不展示：skipped（未执行）与 spawn_failed 的 failed（跳过判定、无动作记录）
			const actions = r.actions || [];
			const judged = !r.skipReason && !(r.status === "failed" && actions.length === 0);
			const judgeText = r.matchedRule !== null && r.matchedRule !== undefined
				? "命中规则 " + r.matchedRule
				: r.usedFallback ? "fallback" : "未命中（零动作）";
			return h("div", { style: { border: "1px solid #f0f0f2", borderRadius: 8, padding: "6px 8px", marginBottom: 6 } },
				h("div", { style: { ...C.row, fontSize: 11 } },
					h("span", { style: { fontWeight: 700 } }, RUN_STATUS_CN[r.status] || r.status),
					h("span", { style: { ...C.muted, ...C.mono } }, r.runId),
					h("span", { style: { ...C.muted } }, fmtTime(r.settledAt || r.startedAt || r.scheduledAt)),
					facts.length > 0 ? h("span", { style: { color: "#52525b" } }, facts.join(" · ")) : null),
				judged ? h("div", { style: { ...C.row, fontSize: 11, marginTop: 2 } },
					h("span", { ...C.muted }, "判定："),
					h("span", null, judgeText)) : null,
				(s.stdoutSpillPath || s.stderrSpillPath) && h("div", { style: { ...C.muted, fontSize: 10, marginTop: 2 } },
					"完整输出：", s.stdoutSpillPath ? "stdout " : "", s.stderrSpillPath ? "stderr" : "", "（溢写文件，排障可读）"),
				tailPreview ? h("div", { style: { ...C.mono, fontSize: 10, marginTop: 3, whiteSpace: "pre-wrap", color: "#3f3f46", background: "#fafafa", borderRadius: 6, padding: "4px 6px", maxHeight: 120, overflowY: "auto" } },
					s.truncated ? "…" : "", tailPreview) : null,
				s.warnings && s.warnings.length > 0 ? h("div", { style: { color: "#d97706", fontSize: 10, marginTop: 3 } },
					s.warnings.join("；")) : null,
				actions.length > 0 ? h("div", { style: { marginTop: 4 } },
					h("div", { ...C.muted, fontSize: 10 }, "动作（" + actions.length + "）"),
					actions.map((a) => h("div", { key: a.name, style: { ...C.row, fontSize: 11, marginTop: 2, flexWrap: "wrap" } },
						h("span", { style: { color: ACTION_STATUS_COLOR[a.status] || "#71717a", fontWeight: 600 } },
							ACTION_STATUS_CN[a.status] || a.status),
						h("span", { style: { ...C.mono } }, a.name),
						h("span", { style: { ...C.muted } }, ACTION_KIND_CN[a.kind] || a.kind),
						// 会话引用（票 32）：成功与 delivery_failed 的 sessionId 都展示——
						// persistent 会话随时可接管，失败现场靠该 id 找回
						a.sessionId ? h("span", { style: { ...C.mono, fontSize: 10 } },
							a.sessionId, a.kind === "session" && a.status === "succeeded" ? "（可接管）" : "") : null,
						a.error ? h("span", { style: { ...C.mono, color: "#dc2626", fontSize: 10 } }, a.error.code, "：", a.error.message) : null,
						a.warnings && a.warnings.length > 0 ? h("span", { style: { color: "#d97706", fontSize: 10 } }, a.warnings.join("；")) : null))) : null);
		}

		function PanelIcon() {
			return h("span", { style: { fontWeight: 700 } }, "编");
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
				// 对话式创建（契约 11 胜选 UX）：开新会话注入引导 prompt（schedule 面板 onNewTask 同款通道）
				startCreateSession: () => {
					ctx.uiWorkspace.startSession(void 0, { prompt: CREATE_PROMPT, whenDraftExists: "append" });
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
