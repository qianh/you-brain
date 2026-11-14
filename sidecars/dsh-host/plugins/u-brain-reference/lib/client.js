// u-brain-reference 的浏览器半边：手写的 DSH 客户端模块（格式与它自己构建的 lib/client.js 一致），
// 不依赖它们 monorepo 的构建链（同 u-brain-brand）。
//
// 做两件事：
// 1. 往 @ 触发流水线注册一个引用 source：候选按「会话 / 话题 / 知识库」分组，来自宿主半边的
//    同源路由（浏览器到不了 U-Brain daemon，也不该拿它的令牌）。选中插入原子行内引用，
//    隐藏形式是 @[label](u-brain-<kind>:<payload>) mention，发送时由宿主半边展开成上下文。
// 2. 给 UserText 注册匹配规则与渲染槽，让已发送 / 恢复草稿里的 mention 显示成引用 chip。
window.__ModuleLoader__.load({
	id: "u-brain-reference",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react_jsx_runtime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const KIND_SECTION = { session: "会话", topic: "话题", kb: "知识库" };
		const KIND_APPEARANCE = { session: "session", topic: "session", kb: "file" };
		const CANDIDATES_PATH = "/u-brain/reference/candidates";
		const MENTION = /@\[([^\]\n]*)\]\(u-brain-(session|topic|kb):([^)\s]+)\)/uy;

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
				title: props.raw,
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
					const m = /^@\[([^\]\n]*)\]\(u-brain-(session|topic|kb):([^)\s]+)\)/u.exec(raw);
					if (m !== null) { mention = raw; label = m[1]; kind = m[2]; }
				}
				if (mention === undefined || !/u-brain-(session|topic|kb):/u.test(mention)) {
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
			codec: {
					clipboardText: (ref) => ref,
					serialize: (ref) => Promise.resolve(ref),
				},
			};
			ctx.effect(() => ctx.get("inputTriggers").registerSource(source), "u-brain-reference: @ source");
			ctx.uiConversation.userText.register(mentionRule);
			ctx.slots.inject("conversation.user.text.node", function* () {
				yield ctx.slots.register(
					{ name: "conversation.user.text.node", key: "u-brain-mention", priority: 100 },
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
