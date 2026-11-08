// @local/dsh-script-orchestrator · Web client（简化档：手写 lazy-CJS，零构建步骤）。
// 协议：window.__ModuleLoader__.load({ id, factory })，factory 内建 module/exports、
// require("react") 取页面 seed 的 React；导出 apply（生成器，yield 注销器）+ inject。
// 数据源：ctx.connection.rpc.call('/script-orchestrator', endpoint, payload)（契约
// docs/temp/11-web-panel.md：零翻译 DTO；写后回读 + connection/reset 回读 + 活动轮询）。
// 票 24 范围：空态 / 加载态 / 传输错误态；表格骨架为变体 C 高密度表格（对话式创建
// 入口、详情模态、活动 run 轮询属票 25+）。
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

		// ---------------- 样式（内联，沿用 proto/web-panel 变体 C 视觉） ----------------
		const C = {
			page: { padding: "20px 24px", fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#18181b", background: "#fafafa", minHeight: "100%" },
			card: { background: "#fff", border: "1px solid #e4e4e7", borderRadius: 10, padding: 14 },
			muted: { color: "#71717a" },
			mono: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 },
			row: { display: "flex", alignItems: "center", gap: 8 },
			btn: { border: "1px solid #d4d4d8", background: "#fff", borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
		};
		const STATUS_COLOR = { active: "#16a34a", paused: "#d97706", ended: "#71717a" };
		const STATUS_CN = { active: "运行中", paused: "已暂停", ended: "已结束" };
		const fmtTime = (iso) => (iso ? iso.replace("T", " ").replace(/(\.\d+|Z).*$/, "") : "—");

		function Chip({ s }) {
			const color = STATUS_COLOR[s] || "#71717a";
			return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, borderRadius: 999, padding: "1px 9px", fontSize: 11, background: color + "1a", color, border: "1px solid " + color + "55" } },
				h("span", { style: { width: 6, height: 6, borderRadius: 99, background: color } }), STATUS_CN[s] || s);
		}

		// ---------------- 面板（数据经 Connection 桥，权威数据永远来自 list 回读） ----------------
		function Panel({ call, subscribeReset }) {
			const [state, setState] = useState({ phase: "loading" });

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

			useEffect(() => {
				void refresh();
				const off = subscribeReset ? subscribeReset(() => void refresh()) : null;
				return () => {
					if (off) off();
				};
			}, []);

			return h("div", { style: C.page },
				h("div", { style: { ...C.row, marginBottom: 10 } },
					h("b", { style: { fontSize: 15 } }, "脚本编排"),
					state.phase === "ready"
						? h("span", { style: { ...C.muted, fontSize: 11 } }, "共 ", state.data.total, " 条")
						: null),
				state.phase === "loading" ? h(LoadingView)
				: state.phase === "error" ? h(ErrorView, { state, onRetry: () => void refresh() })
				: state.data.items.length === 0 ? h(EmptyView)
				: h(TableView, { items: state.data.items }));
		}

		function LoadingView() {
			return h("div", { style: { padding: 40, textAlign: "center", color: "#71717a" } }, "加载中…");
		}

		function EmptyView() {
			return h("div", { style: { ...C.card, padding: 40, textAlign: "center", color: "#71717a" } },
				"还没有编排。", h("div", { style: { fontSize: 11, marginTop: 6 } }, "列表为 Host 权威数据（list 回读）"));
		}

		function ErrorView({ state, onRetry }) {
			return h("div", { style: { ...C.card, borderColor: "#dc2626", color: "#dc2626", padding: 20 } },
				h("div", { style: { fontWeight: 700 } }, "加载失败"),
				h("div", { style: { ...C.mono, margin: "6px 0 10px", whiteSpace: "pre-wrap" } }, state.code, "：", state.message),
				h("button", { style: C.btn, onClick: onRetry }, "重试"));
		}

		function TableView({ items }) {
			const th = { textAlign: "left", ...C.muted, fontSize: 11, padding: "6px 8px", borderBottom: "1px solid #e4e4e7" };
			const td = { padding: "6px 8px", borderBottom: "1px solid #f0f0f2", fontSize: 12 };
			return h("table", { style: { width: "100%", borderCollapse: "collapse", background: "#fff", border: "1px solid #e4e4e7" } },
				h("thead", null, h("tr", null, ["状态", "标题", "触发", "下次"].map((x) => h("th", { key: x, style: th }, x)))),
				h("tbody", null, items.map((o) => h("tr", { key: o.id },
					h("td", { style: td }, h(Chip, { s: o.status })),
					h("td", { style: td }, h("b", null, o.title || o.id), h("div", { style: { ...C.muted, ...C.mono, fontSize: 10 } }, o.id)),
					h("td", { style: td }, h("span", { style: C.mono }, o.trigger ? (o.trigger.kind === "cron" ? o.trigger.expression : "every") : "—")),
					h("td", { style: td }, fmtTime(o.nextOccurrence))))));
		}

		function PanelIcon() {
			return h("span", { style: { fontWeight: 700 } }, "编");
		}

		// ---------------- 插件面 ----------------
		const inject = ["slots", "connection"];

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
