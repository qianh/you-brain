import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

import { readGrokBotTranscripts } from "../adapters/grok-bot.js";
import { runAxScript, type AxFailureCode, type AxRunner } from "./gui-ax.js";

const run = promisify(execFile);

/** 探测类命令一律带超时，osascript 首次唤起 System Events 可能卡住。 */
const PROBE_TIMEOUT_MS = 4_000;
/** 探测要遍历一次界面结构；投递还要等发送按钮和输入框清空。 */
const AX_PROBE_TIMEOUT_MS = 8_000;
const AX_SEND_TIMEOUT_MS = 30_000;

function probe(cmd: string, args: string[]): ReturnType<typeof run> {
  return run(cmd, args, { timeout: PROBE_TIMEOUT_MS }) as ReturnType<typeof run>;
}

/**
 * GUI App 通用桥（ADR-0002）：辅助功能 API 投递任务 + 采集适配器回收结果。
 * 一座桥管所有本机 GUI App；每个 App 只需要一份定义。
 */
export interface GuiAppDef {
  id: string;
  displayName: string;
  /** pgrep -x 的名字。 */
  processName: string;
  bundleId: string;
  recoverable: boolean;
}

export const GUI_APPS: GuiAppDef[] = [
  {
    id: "grok-bot",
    displayName: "Grok Bot",
    processName: "Grok Bot",
    bundleId: "com.anysphere.sand",
    recoverable: true,
  },
  {
    id: "muse",
    displayName: "Muse",
    processName: "Muse",
    bundleId: "com.meta.endo",
    // Muse 的会话落盘格式未逆，投递后暂无自动回收。
    recoverable: false,
  },
];

function axFailureMessage(app: GuiAppDef, code: AxFailureCode, detail?: string): string {
  const name = app.displayName;
  switch (code) {
    case "not_running":
      return "App 未运行";
    case "no_permission":
      return "需要授予 U-Brain「辅助功能」权限（系统设置 → 隐私与安全性）";
    case "no_window":
      return `没能打开 ${name} 的窗口，请手动打开后再试`;
    case "no_composer":
      return `${name} 当前版本的输入框没有开放给辅助功能，无法静默投递`;
    case "draft":
      return `${name} 的输入框里有未发送的内容，为避免覆盖已停止投递`;
    case "no_focus":
      return `没能把 ${name} 窗口内的光标移到输入框（可能开着弹窗或其他页面），任务没有发出`;
    case "write_failed":
      return `${name} 的输入框不接受写入，任务没有发出`;
    case "not_cleared":
      return `已触发发送，但 ${name} 没有确认收到（输入框没有变空），任务可能没有发出；请到 App 里确认后再决定是否重发`;
    case "script":
      return `投递失败：${detail ?? "未知错误"}`;
  }
}

export function guiAppById(id: string): GuiAppDef | undefined {
  return GUI_APPS.find((app) => app.id === id);
}

function isMac(): boolean {
  return platform() === "darwin";
}

/** 进程是否在跑(一次 pgrep,毫秒级)。 */
export async function appRunning(app: GuiAppDef): Promise<boolean> {
  try {
    await probe("pgrep", ["-x", app.processName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 辅助功能权限探测。不能用“读 System Events 进程列表”判断：
 * 那只需要自动化权限，没有辅助功能时也会成功。
 */
export async function accessibilityGranted(): Promise<boolean> {
  if (!isMac()) return false;
  try {
    const { stdout } = await probe("osascript", [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()',
    ]);
    return String(stdout).trim() === "true";
  } catch {
    return false;
  }
}

export interface GuiAppStatus {
  id: string;
  displayName: string;
  available: boolean;
  detail: string;
}

export async function guiAppStatus(
  app: GuiAppDef,
  /** 多个 App 一起探测时共用同一次辅助功能权限检测(osascript 要几百毫秒)。 */
  accessibility: () => Promise<boolean> = accessibilityGranted,
  deps: { running?: (app: GuiAppDef) => Promise<boolean>; ax?: AxRunner } = {},
): Promise<GuiAppStatus> {
  const view = (available: boolean, detail: string): GuiAppStatus => ({
    id: app.id,
    displayName: app.displayName,
    available,
    detail,
  });
  if (!isMac()) return view(false, "仅支持 macOS");
  if (!(await (deps.running ?? appRunning)(app))) return view(false, axFailureMessage(app, "not_running"));
  if (!(await accessibility())) return view(false, axFailureMessage(app, "no_permission"));
  const probed = await (deps.ax ?? runAxScript)(
    { action: "probe", bundleId: app.bundleId, windowTitle: app.displayName },
    AX_PROBE_TIMEOUT_MS,
  );
  if (!probed.ok) return view(false, axFailureMessage(app, probed.code, probed.detail));
  if (!probed.hasWindow) return view(true, "就绪（窗口未打开，发送时会自动打开）");
  if (!probed.hasComposer) return view(false, axFailureMessage(app, "no_composer"));
  return view(true, "就绪");
}

export interface GuiDispatchResult {
  sentAtMs: number;
}

/**
 * 静默投递：直接写 App 的输入框，再把回车只发给该进程（见 gui-ax.ts）。
 * 做不到就报错，不退回“激活窗口 + 粘贴 + 回车”：那会打断用户，还可能把内容发进别的 App。
 */
export async function dispatchToGuiApp(
  app: GuiAppDef,
  prompt: string,
  ax: AxRunner = runAxScript,
): Promise<GuiDispatchResult> {
  if (!isMac()) throw new Error("GUI App 桥仅支持 macOS");
  const sentAtMs = Date.now();
  const result = await ax(
    { action: "send", bundleId: app.bundleId, windowTitle: app.displayName, text: prompt },
    AX_SEND_TIMEOUT_MS,
  );
  if (!result.ok) throw new Error(axFailureMessage(app, result.code, result.detail));
  return { sentAtMs };
}

/**
 * 投递后回收 App 里的新回复（grok-bot：读本地落盘转录）。
 * 只看 sinceMs 之后收到过用户消息的对话，且只取那条消息之后的回复：
 * 其它 Bot 会自动发消息，不能当成这次任务的回复。返回按时间正序的 assistant 文本。
 */
export async function recoverGuiAppReplies(
  app: GuiAppDef,
  sinceMs: number,
  homeDir?: string,
): Promise<string[]> {
  if (!app.recoverable) return [];
  if (app.id === "grok-bot") {
    const transcripts = await readGrokBotTranscripts(homeDir);
    const replies: Array<{ atMs: number; text: string }> = [];
    for (const transcript of transcripts) {
      const asked = transcript.turns.findIndex(
        (turn) => turn.role === "user" && turn.atMs !== null && turn.atMs >= sinceMs - 5_000,
      );
      if (asked < 0) continue;
      for (const turn of transcript.turns.slice(asked + 1)) {
        if (turn.role !== "assistant" || turn.atMs === null) continue;
        replies.push({ atMs: turn.atMs, text: turn.text });
      }
    }
    replies.sort((left, right) => left.atMs - right.atMs);
    return replies.map((reply) => reply.text);
  }
  return [];
}
