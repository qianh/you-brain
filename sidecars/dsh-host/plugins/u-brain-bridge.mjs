// DSH 插件：把 U-Brain 的「GUI App 桥」（Grok Bot、Muse 等没有公开接口的桌面 App）变成模型可调用的工具。
//
// 真正的投递（macOS 辅助功能）和回收（读 App 本地落盘的会话）都在 U-Brain 的 daemon 里完成——
// 辅助功能权限是授给 U-Brain 的，dsh 子进程不能直接去操作别的 App。这里只是回调 daemon 的本机接口，
// 端口和令牌每次调用时从数据目录的 daemon.json 读取（权限 0600，daemon 重启换端口也不受影响）。
//
// 加载方式：补丁里 `- id: u-brain-bridge, name: '<本文件绝对路径>'`（见 deck/dsh/patch.ts）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "u-brain-bridge";
export const inject = ["tools"];

let defineTool;
try {
  ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
} catch {
  // 单元测试不需要它：只测 createTools；真正加载进 dsh 时必然存在。
  defineTool = undefined;
}

const POLL_MS = 20_000;
const MAX_WAIT_SECONDS = 300;
const DEFAULT_WAIT_SECONDS = 120;

async function endpoint(env = process.env) {
  const dataDir = env.YOU_BRAIN_DATA_DIR;
  if (!dataDir) throw new Error("没有 YOU_BRAIN_DATA_DIR，无法连接 U-Brain");
  let info;
  try {
    info = JSON.parse(await readFile(join(dataDir, "daemon.json"), "utf8"));
  } catch {
    throw new Error("U-Brain 的后台没有运行（找不到 daemon.json）");
  }
  if (!Number.isInteger(info.port) || typeof info.token !== "string") throw new Error("daemon.json 内容不合法");
  return { base: `http://127.0.0.1:${info.port}`, token: info.token };
}

/** 调用 daemon 的桥接接口；失败时抛出带原因的错误（工具会把它如实返回给模型）。 */
async function defaultApi(path, { method = "GET", body, signal } = {}, deps = {}) {
  const { base, token } = await (deps.endpoint ?? endpoint)();
  const response = await (deps.fetch ?? fetch)(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  let json;
  try {
    json = text === "" ? {} : JSON.parse(text);
  } catch {
    json = {};
  }
  if (!response.ok) throw new Error(json?.error?.message ?? json?.message ?? `U-Brain 返回 ${response.status}`);
  return json;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function describeApps(apps) {
  if (!apps.length) return "（没有配置任何 GUI App）";
  return apps
    .map((app) => `- ${app.id}（${app.displayName}）：${app.available ? "就绪" : `不可用——${app.detail}`}；${app.recoverable ? "可自动回收回复" : "回复需在 App 里查看"}`)
    .join("\n");
}

function describeReplies(app, replies) {
  return `【来自 ${app} 的回复】\n\n${replies.join("\n\n---\n\n")}`;
}

/**
 * 纯函数：返回三个工具的定义（不依赖 dsh），依赖可注入以便测试。
 * deps.api / deps.sleep / deps.now / deps.pollMs。
 */
export function createTools(deps = {}) {
  const api = deps.api ?? ((path, init) => defaultApi(path, init, deps));
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? POLL_MS;
  const text = { type: "string" };
  const render = (_args, value) => [{ type: "text", text: value }];

  return [
    {
      name: "gui_app_list",
      description:
        "列出本机可通过 U-Brain 桥接的桌面 AI App（如 Grok Bot、Muse）及其当前是否就绪。这些 App 没有公开接口，U-Brain 用 macOS 辅助功能把任务打进它们的输入框。",
      parameters: {},
      output: { schema: text, render },
      async execute(_args, exec) {
        const { apps } = await api("/api/deck/bridge/apps", { signal: exec?.signal });
        return describeApps(apps);
      },
    },
    {
      name: "gui_app_ask",
      description:
        "把一个自包含的任务投递给本机桌面 AI App（先用 gui_app_list 确认 id 和是否就绪），并等待它的回复。投递是静默的：直接写入该 App 当前打开的对话并发送，不切换窗口、不动键盘和剪贴板。它会真的发出一条消息，所以只在用户明确要求用那个 App 做事时使用。回复无法自动回收的 App 只会返回“已投递”。\n规则：①投递报错时，把错误原文告诉用户并停止，不要重试；②等不到回复不代表失败，不要重发同一任务，用 gui_app_replies 稍后再查；③任何情况下都不要用 bash、osascript、python 等去操作 App 的界面，也不要读取 daemon.json 或直接调用 U-Brain 的接口——这些是越权，还可能把内容发到别的 App。",
      parameters: {
        app: { type: "string", required: true, description: "App id，如 grok-bot、muse" },
        prompt: { type: "string", required: true, description: "要它执行的任务，必须自包含（它看不到当前对话）" },
        wait_seconds: { type: "number", description: `最多等回复多少秒（默认 ${DEFAULT_WAIT_SECONDS}，最大 ${MAX_WAIT_SECONDS}）` },
      },
      output: { schema: text, render },
      async execute(args, exec) {
        const sent = await api("/api/deck/bridge/send", { method: "POST", body: { app: args.app, prompt: args.prompt }, signal: exec?.signal });
        if (!sent.recoverable) {
          return `已把任务投递进 ${args.app}。该 App 的回复暂时无法自动回收，请在 ${args.app} 里查看。`;
        }
        const budgetMs = Math.min(Math.max(Number(args.wait_seconds ?? DEFAULT_WAIT_SECONDS), 0), MAX_WAIT_SECONDS) * 1000;
        const startedAt = now();
        while (now() - startedAt < budgetMs && !exec?.signal?.aborted) {
          await wait(Math.min(pollMs, Math.max(budgetMs - (now() - startedAt), 0)), exec?.signal);
          if (exec?.signal?.aborted) break;
          const { replies } = await api("/api/deck/bridge/replies", { method: "POST", body: { app: args.app, sinceMs: sent.sentAtMs }, signal: exec?.signal });
          if (replies.length > 0) return describeReplies(args.app, replies);
        }
        return `已把任务投递进 ${args.app}，但在 ${Math.round(budgetMs / 1000)} 秒内没有等到新回复；它可能仍在执行。稍后可调用 gui_app_replies（app="${args.app}"，since_ms=${sent.sentAtMs}）再查。`;
      },
    },
    {
      name: "gui_app_replies",
      description: "查询桌面 AI App 在指定时间点（毫秒时间戳）之后产生的新回复。用于 gui_app_ask 超时后稍后再查。",
      parameters: {
        app: { type: "string", required: true, description: "App id，如 grok-bot" },
        since_ms: { type: "number", required: true, description: "只看这个毫秒时间戳之后的回复（gui_app_ask 的返回里有）" },
      },
      output: { schema: text, render },
      async execute(args, exec) {
        const { replies } = await api("/api/deck/bridge/replies", { method: "POST", body: { app: args.app, sinceMs: Math.max(0, Math.floor(args.since_ms)) }, signal: exec?.signal });
        return replies.length > 0 ? describeReplies(args.app, replies) : `${args.app} 在该时间点之后还没有新回复。`;
      },
    },
  ];
}

export function apply(ctx) {
  if (defineTool === undefined) throw new Error("@deepseek-ai/dsh-tools 不可用，无法注册 GUI 桥工具");
  for (const spec of createTools()) ctx.tools.register(defineTool(spec));
}
