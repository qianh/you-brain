// 订阅（OAuth）登录引擎：复用 pi-ai 的登录代码，把结果写进 DSH 的凭据库。
//
// 由 daemon 以子进程方式驱动，不需要用户碰终端。协议：每行一个 JSON 事件写到 stdout，
//   {"event":"auth_url","url":"…"}   需要用户在浏览器里授权（本进程已尝试自动打开）
//   {"event":"device_code","userCode":"…","verificationUri":"…"}   设备验证码流程：用户在该网址输入验证码
//   {"event":"done"}                  凭据已保存
//   {"event":"error","message":"…"}   失败
// 退出码：0 成功，非 0 失败。授权结果经 pi-ai 的本地回调服务（127.0.0.1）自动收到，无需粘贴。
//
// DSH 把 Anthropic 的登录流程注册在后端，但 Web 界面没有启动它的入口，所以由这里复用同一份代码。
// 存储格式与 DSH 文档一致：<DSH_HOME>/.credentials.yaml → records → llm-pi-ai/<provider>。
//
// 用法：DSH_HOME=<目录> node login-oauth.mjs <login|logout> <provider>
//       node login-oauth.mjs list        列出支持订阅登录的供应商（JSON，一行）
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import yaml from "js-yaml";
import { createModels } from "@earendil-works/pi-ai";

const TIMEOUT_MS = 5 * 60_000;
const [action = "login", providerId = ""] = process.argv.slice(2);
const home = process.env.DSH_HOME;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const fail = (message, code = 1) => {
  emit({ event: "error", message });
  process.exit(code);
};

/**
 * DSH 的 pi-ai 适配器不提供登录的供应商：`openai`（Sign in with ChatGPT）需要应用提供稳定的安装 ID，
 * DSH 没有，所以它对该路由只收 API Key。ChatGPT 订阅用 `openai-codex`。
 */
const UNSERVED = new Set(["openai"]);

const all = await import("@earendil-works/pi-ai/providers/all");
const factories = typeof all.builtinProviders === "function" ? all.builtinProviders() : all.builtinProviders;
const builtin = (Array.isArray(factories) ? factories : Object.values(factories ?? {})).map((entry) => (typeof entry === "function" ? entry() : entry));
const oauthProviders = builtin.filter((provider) => provider.auth?.oauth && !UNSERVED.has(provider.id));

if (action === "list") {
  emit({
    event: "providers",
    providers: oauthProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name ?? provider.name,
    })),
  });
  process.exit(0);
}

if (!home) fail("缺少 DSH_HOME", 2);
if (!["login", "logout"].includes(action)) fail(`未知操作 ${action}`, 2);
const providerDef = oauthProviders.find((provider) => provider.id === providerId);
if (!providerDef) fail(`暂不支持 ${providerId || "（未指定）"}（支持：${oauthProviders.map((provider) => provider.id).join("、")}）`, 2);

const file = join(home, ".credentials.yaml");
const recordKey = `llm-pi-ai/${providerId}`;

async function readDoc() {
  try {
    return yaml.load(await readFile(file, "utf8")) ?? { version: 1 };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1 };
    throw error;
  }
}

async function writeDoc(doc) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, yaml.dump(doc, { lineWidth: -1 }), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

if (action === "logout") {
  const doc = await readDoc();
  if (doc.records && recordKey in doc.records) {
    delete doc.records[recordKey];
    if (Object.keys(doc.records).length === 0) delete doc.records;
    await writeDoc(doc);
  }
  emit({ event: "done" });
  process.exit(0);
}

function openBrowser(url) {
  if (process.env.YB_NO_OPEN === "1") return;
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // 打不开浏览器时，界面里仍有授权链接可点。
  }
}

/** 登录过程中的凭据暂存在内存，成功后一次性写盘，失败不留半截文件。 */
let captured;
const store = {
  async read() { return captured; },
  async list() { return captured ? [{ providerId, type: captured.type }] : []; },
  async modify(_id, mutate) { captured = await mutate(captured); return captured; },
  async delete() { captured = undefined; },
};

const abort = new AbortController();
const timer = setTimeout(() => {
  abort.abort();
  fail("授权超时（5 分钟内没有完成）");
}, TIMEOUT_MS);
process.on("SIGTERM", () => { abort.abort(); process.exit(130); });

try {
  const models = createModels({ credentials: store });
  models.setProvider(providerDef);
  await models.login(providerId, "oauth", {
    signal: abort.signal,
    notify: (event) => {
      if (event.type === "auth_url") {
        emit({ event: "auth_url", url: event.url });
        openBrowser(event.url);
      } else if (event.type === "device_code") {
        emit({ event: "device_code", userCode: event.userCode, verificationUri: event.verificationUri });
        openBrowser(event.verificationUri);
      }
    },
    prompt: async (p) => {
      // 登录方式：默认浏览器授权（本地回调，不需要粘贴）。
      if (p.type === "select") return (p.options.find((option) => option.id === "browser") ?? p.options[0]).id;
      // manual_code：只等本地回调服务先收到结果（pi-ai 会 abort 它），不向用户要粘贴。
      if (p.type === "manual_code") {
        await new Promise((resolve) => p.signal?.addEventListener("abort", resolve, { once: true }));
        return "";
      }
      if (process.env.YB_DEBUG_PROMPT === "1") process.stderr.write(`PROMPT ${JSON.stringify({ ...p, signal: undefined })}\n`);
      // 明确说可以留空的文本提示（如 GitHub Enterprise 域名，留空 = github.com）：留空。
      if (p.type === "text" && /\b(blank|optional)\b|可留空|可选/iu.test(p.message ?? "")) return "";
      // 其它需要用户键入内容的提示（文本、密钥）这里无法代答，明确失败比卡住好。
      throw new Error(`该供应商的登录需要手动输入（${p.type}），暂不支持`);
    },
  });
  clearTimeout(timer);
  if (!captured || captured.type !== "oauth") fail("登录没有产生 OAuth 凭据");
  const doc = await readDoc();
  doc.version = 1;
  doc.records = { ...(doc.records ?? {}), [recordKey]: { kind: "grant", payload: JSON.parse(JSON.stringify(captured)) } };
  await writeDoc(doc);
  emit({ event: "done" });
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{40,}/g, "***").slice(0, 300) : String(error));
}
