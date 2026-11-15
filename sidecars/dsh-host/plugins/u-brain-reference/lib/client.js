// u-brain-reference 的浏览器半边：手写的 DSH 客户端模块（格式与它自己构建的 lib/client.js 一致），
// 不依赖它们 monorepo 的构建链（同 u-brain-brand）。
//
// 做两件事：
// 1. 往 @ 触发流水线注册一个引用 source：候选按「终端会话 / 会话 / 话题 / 知识库」分组，来自宿主半边的
//    同源路由（浏览器到不了 U-Brain daemon，也不该拿它的令牌）。选中插入原子行内引用，
//    隐藏形式是 @[label](u-brain-<kind>:<payload>) mention，发送时由宿主半边展开成上下文。
// 2. 给 UserText 注册匹配规则与渲染槽，让已发送 / 恢复草稿里的 mention 显示成可预览的引用 chip。
window.__ModuleLoader__.load({
	id: "u-brain-reference",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const KIND_SECTION = { tty7: "终端会话", session: "会话", topic: "话题", kb: "知识库" };
		const KIND_APPEARANCE = { tty7: "session", session: "session", topic: "session", kb: "file" };
		const CANDIDATES_PATH = "/u-brain/reference/candidates";
		const MENTION = /@\[([^\]\n]*)\]\(u-brain-(tty7|session|topic|kb):([^)\s]+)\)/uy;
		const REFERENCE = /^@\[([^\]\n]*)\]\(u-brain-(tty7|session|topic|kb):([^)\s]+)\)$/u;
		let hostOrigin;

		function createPreview() {
			let state = null;
			let pending;
			const listeners = new Set();
			const update = (next) => { state = next; for (const listener of listeners) listener(); };
			const close = () => { pending?.abort(); pending = undefined; update(null); };
			const open = (raw) => {
				const match = REFERENCE.exec(raw);
				if (!match) return false;
				pending?.abort();
				const controller = new AbortController();
				pending = controller;
				const reference = { raw, label: match[1], kind: match[2], id: match[3] };
				update({ reference, loading: true });
				const params = new URLSearchParams({ kind: reference.kind, id: reference.id, label: reference.label });
				void fetch(`/u-brain/reference/content?${params}`, {
					headers: { "x-u-brain": "1" }, signal: controller.signal,
				}).then(async (response) => {
					if (!response.ok) throw new Error(`引用读取失败（${response.status}）`);
					const content = await response.json();
					if (!controller.signal.aborted) update({ reference, loading: false, content, error: content.error });
				}).catch((error) => {
					if (!controller.signal.aborted) update({ reference, loading: false, error: error.message });
				});
				return true;
			};
			return {
				open, close,
				connect: (origin) => { hostOrigin = origin; if (state !== null) update({ ...state }); },
				getSnapshot: () => state,
				subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
			};
		}

		function ReferencePreview({ preview }) {
			const state = React.useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
			if (state === null) return null;
			const { reference, content, loading, error } = state;
			return react_jsx_runtime.jsx(primitives.Modal, {
				open: true, onClose: preview.close, closeLabel: "关闭",
				title: content?.title || reference.label,
				description: reference.kind === "tty7" ? "终端当前文本预览 · 发送消息时会重新读取最新内容" : "引用内容预览",
				footer: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					react_jsx_runtime.jsx(primitives.Button, {
						variant: "outline", disabled: loading, onClick: () => preview.open(reference.raw), children: "刷新内容",
					}),
					content?.terminal && hostOrigin && react_jsx_runtime.jsx(primitives.Button, {
						variant: "primary", onClick: () => {
							window.parent.postMessage({ type: "u-brain:terminal-reference:open", ...content.terminal }, hostOrigin);
							preview.close();
						}, children: "打开实时终端",
					}),
				] }),
				children: loading
					? react_jsx_runtime.jsx("p", { role: "status", children: "正在读取引用内容…" })
					: error
						? react_jsx_runtime.jsx("p", { role: "alert", children: error })
						: react_jsx_runtime.jsx("pre", {
							style: { margin: 0, maxHeight: "50vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, lineHeight: 1.65 },
							children: content?.text,
						}),
			});
		}

		//#region 渲染：已发送 / 恢复草稿里的 mention
		/** 找到下一个 u-brain mention（wire 形式，永远可解析，不需要热词表）。 */
		const mentionRule = {
			id: "u-brain-mention",
			order: 20,
			match(text, from) {
				for (let start = text.indexOf("@[", from); start >= 0; start = text.indexOf("@[", start + 1)) {
					MENTION.lastIndex = start;
					const match = MENTION.exec(text);
					if (match !== null) {
						return {
							id: "u-brain-mention",
							start,
							end: start + match[0].length,
							data: { label: match[1] || "(未命名)", kind: match[2] },
						};
					}
				}
				return undefined;
			},
		};

		function UBrainReference(props) {
			return react_jsx_runtime.jsx(primitives.ReferenceChip, {
				appearance: KIND_APPEARANCE[props.node.data.kind] ?? "session",
				label: props.node.data.label,
				title: `查看${KIND_SECTION[props.node.data.kind]}：${props.node.data.label}`,
				...(props.interactive ? { onActivate: () => props.openPreview(props.raw) } : {}),
			});
		}
		//#endregion

		//#region @ 候选 source
		const inject = ["inputTriggers", "slots", "uiConversation"];

		/** 候选行 → 菜单候选；value 与 ui-reference 一样编成 JSON，pick 时原样带回。 */
		function toRow(candidate) {
			const label = candidate.label || "(未命名)";
			return {
				name: label,
				description: candidate.detail || undefined,
				icon: candidate.kind === "kb" ? "file" : "session",
				section: KIND_SECTION[candidate.kind] ?? "U-Brain",
				value: JSON.stringify({ kind: candidate.kind, label, mention: candidate.mention }),
			};
		}

		function apply(ctx) {
			const preview = createPreview();
			const receiveHost = (event) => {
				if (window.parent !== window && event.source === window.parent && event.data?.type === "u-brain:terminal-reference:host") preview.connect(event.origin);
			};
			window.addEventListener("message", receiveHost);
			// 握手探测不含引用或正文；后续请求只发给宿主回复的确切 origin。
			if (window.parent !== window) window.parent.postMessage({ type: "u-brain:terminal-reference:ready" }, "*");
			ctx.effect(() => () => {
				window.removeEventListener("message", receiveHost);
				hostOrigin = undefined;
				preview.close();
			}, "u-brain-reference: preview cleanup");
			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "u-brain-reference-preview" },
				() => react_jsx_runtime.jsx(ReferencePreview, { preview }),
			));
			const source = {
				trigger: "@",
				name: "u-brain-reference",
				order: 10,
				showGroupTitle: true,
				async candidates(_session, req) {
					let response;
					try {
						response = await fetch(`${CANDIDATES_PATH}?q=${encodeURIComponent(req.query)}`, {
							headers: { "x-u-brain": "1" },
							...(req.signal === undefined ? {} : { signal: req.signal }),
						});
					} catch {
						return [];
					}
					if (!response.ok) return [];
					let data;
					try {
						data = await response.json();
					} catch {
						return [];
					}
					return (data.candidates ?? []).map(toRow);
				},
			onPick(pick) {
				const raw = pick.candidate.value;
				let parsed;
				try {
					parsed = JSON.parse(raw);
				} catch {
					parsed = undefined;
				}
				// 新格式：JSON {kind,label,mention}；兜底：value 本身就是 mention（旧缓存）。
				let { mention, label, kind } = parsed ?? {};
				if (mention === undefined && typeof raw === "string") {
					const m = REFERENCE.exec(raw);
					if (m !== null) { mention = raw; label = m[1]; kind = m[2]; }
				}
				if (typeof mention !== "string" || !REFERENCE.test(mention)) {
					console.warn("[u-brain-reference] pick payload not understood:", String(raw ?? "").slice(0, 80));
					return undefined;
				}
				return {
					insert: {
						source: "u-brain-reference",
						ref: mention,
						label: label || "(未命名)",
						appearance: KIND_APPEARANCE[kind] ?? "session",
						clipboardText: mention,
					},
				};
			},
			openReference(_session, { ref }) { return preview.open(ref); },
			codec: {
					clipboardText: (ref) => ref,
					serialize: (ref) => Promise.resolve(ref),
				},
			};
			ctx.effect(() => ctx.get("inputTriggers").registerSource(source), "u-brain-reference: @ source");
			ctx.uiConversation.userText.register(mentionRule);
			ctx.slots.inject("conversation.user.text.node", function* () {
				yield ctx.slots.register(
					{ name: "conversation.user.text.node", key: "u-brain-mention", priority: 100, inject: () => ({ openPreview: preview.open }) },
					UBrainReference,
				);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
