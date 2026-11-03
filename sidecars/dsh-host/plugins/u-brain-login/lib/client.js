// u-brain-login 的浏览器半边：往「设置 → 模型」页底部的 settings.models.footer 席位注册一个“订阅登录”区块。
// 手写的 DSH 客户端模块（格式与它自己构建出的 lib/client.js 一致：window.__ModuleLoader__.load + factory），
// 不依赖它们 monorepo 的构建链。组件只通过同源的 /u-brain/login 说话（见 lib/index.js），不碰 ctx。
window.__ModuleLoader__.load({
	id: "u-brain-login",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		const CONSENT = {
			anthropic: "这会借用 Claude Code 的登录身份访问你的 Claude 订阅（授权范围含 user:sessions:claude_code）。",
			"openai-codex": "这会借用 OpenAI Codex 命令行的登录方式访问你的 ChatGPT 订阅。",
		};
		const CONSENT_COMMON = "第三方应用这样使用订阅是否被服务商允许，请你自行确认其服务条款后再继续。";

		function call(method, body) {
			return fetch("/u-brain/login", {
				method,
				headers: Object.assign({ "x-u-brain": "1" }, body === undefined ? {} : { "content-type": "application/json" }),
				body: body === undefined ? undefined : JSON.stringify(body),
			}).then(async (response) => {
				const json = await response.json().catch(() => ({}));
				if (!response.ok) throw new Error((json && json.error && (json.error.message || json.error)) || "请求失败 " + response.status);
				return json;
			});
		}

		const styles = {
			section: { marginTop: 28, padding: "16px 18px", border: "1px solid rgba(128,128,128,.28)", borderRadius: 16, display: "flex", flexDirection: "column", gap: 10 },
			title: { fontSize: 15, fontWeight: 600 },
			hint: { fontSize: 12.5, opacity: 0.65, lineHeight: 1.5 },
			row: { display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderTop: "1px solid rgba(128,128,128,.18)" },
			line: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
			label: { fontSize: 14, fontWeight: 500, minWidth: 190 },
			chip: { fontSize: 12, padding: "1px 9px", borderRadius: 999, background: "rgba(128,128,128,.16)", opacity: 0.75 },
			chipOn: { background: "rgba(34,197,94,.16)", color: "#15803d", opacity: 1 },
			button: { fontSize: 13, padding: "5px 14px", borderRadius: 999, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", cursor: "pointer" },
			primary: { background: "#111", color: "#fff", borderColor: "#111" },
			small: { fontSize: 12.5, opacity: 0.8, lineHeight: 1.55 },
			error: { fontSize: 12.5, color: "#dc2626", wordBreak: "break-word" },
			consent: { padding: "10px 12px", borderRadius: 12, background: "rgba(128,128,128,.1)", display: "flex", flexDirection: "column", gap: 8 },
			code: { fontSize: 17, fontWeight: 700, letterSpacing: 1.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", userSelect: "all" },
		};

		function Row({ item, confirming, setConfirming, act }) {
			const waiting = item.state === "waiting";
			const buttons = [];
			if (waiting) {
				buttons.push(h("button", { key: "cancel", type: "button", style: styles.button, onClick: () => act("cancel", item.id) }, "取消"));
			} else if (item.signedIn) {
				buttons.push(h("button", { key: "logout", type: "button", style: styles.button, onClick: () => act("logout", item.id) }, "退出登录"));
			} else {
				buttons.push(h("button", { key: "start", type: "button", style: Object.assign({}, styles.button, styles.primary), onClick: () => setConfirming(item.id) }, "登录"));
			}
			const details = [];
			if (waiting && item.deviceCode) {
				details.push(h("div", { key: "device", style: styles.small },
					"请在浏览器打开 ", h("a", { href: item.deviceCode.verificationUri, target: "_blank", rel: "noreferrer" }, item.deviceCode.verificationUri),
					" 并输入验证码 ", h("span", { style: styles.code }, item.deviceCode.userCode), "（授权后这里会自动变为“已登录”）"));
			} else if (waiting) {
				details.push(h("div", { key: "wait", style: styles.small },
					"等待你在浏览器里完成授权…（没有自动打开？",
					item.url ? h("a", { href: item.url, target: "_blank", rel: "noreferrer" }, "点这里") : "稍候",
					"）"));
			}
			if (item.state === "error" && item.error) details.push(h("div", { key: "error", style: styles.error }, "登录失败：" + item.error));
			if (confirming === item.id) {
				details.push(h("div", { key: "consent", style: styles.consent, role: "alertdialog" },
					h("strong", { style: { fontSize: 13 } }, "登录前请确认"),
					h("div", { style: styles.small }, (CONSENT[item.id] ? CONSENT[item.id] + " " : "这会通过该服务商面向命令行/编程工具的登录授权访问你的订阅。") + CONSENT_COMMON),
					h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
						h("button", { type: "button", style: styles.button, onClick: () => setConfirming(null) }, "取消"),
						h("button", { type: "button", style: Object.assign({}, styles.button, styles.primary), onClick: () => act("start", item.id) }, "我已了解，继续登录"))));
			}
			return h("div", { style: styles.row },
				h("div", { style: styles.line },
					h("span", { style: styles.label }, item.label),
					h("span", { style: Object.assign({}, styles.chip, item.signedIn ? styles.chipOn : {}) }, item.signedIn ? "已登录" : "未登录"),
					buttons),
				details);
		}

		function LoginSection() {
			const [providers, setProviders] = React.useState([]);
			const [failure, setFailure] = React.useState("");
			const [confirming, setConfirming] = React.useState(null);
			const refresh = React.useCallback(() => {
				call("GET").then((json) => setProviders(json.providers || [])).catch((error) => setFailure(error.message));
			}, []);
			React.useEffect(() => { refresh(); }, [refresh]);
			const waiting = providers.some((item) => item.state === "waiting");
			React.useEffect(() => {
				if (!waiting) return undefined;
				const timer = setInterval(refresh, 1500);
				return () => clearInterval(timer);
			}, [waiting, refresh]);
			const act = (action, id) => {
				setFailure("");
				setConfirming(null);
				call("POST", { action, provider: id }).then((json) => setProviders(json.providers || [])).catch((error) => setFailure(error.message));
			};
			if (providers.length === 0 && failure === "") return null;
			return h("section", { style: styles.section },
				h("div", { style: styles.title }, "订阅登录"),
				h("div", { style: styles.hint }, "用已有的订阅登录，不需要 API 密钥。登录成功后，在模型选择里就能选到对应的模型。"),
				providers.map((item) => h(Row, { key: item.id, item, confirming, setConfirming, act })),
				failure !== "" ? h("div", { style: styles.error }, failure) : null);
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.models.footer", function* () {
				// footer 是 list 型席位：多个注册者并存，必须各带一个 id。
				yield ctx.slots.register({ name: "settings.models.footer", id: "u-brain-login" }, LoginSection);
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
