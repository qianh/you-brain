import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

import { readGrokBotTranscripts } from "../adapters/grok-bot.js";

const run = promisify(execFile);

/** 探测类命令一律带超时，osascript 首次唤起 System Events 可能卡住。 */
const PROBE_TIMEOUT_MS = 4_000;

function probe(cmd: string, args: string[]): ReturnType<typeof run> {
  return run(cmd, args, { timeout: PROBE_TIMEOUT_MS }) as ReturnType<typeof run>;
}

function writeClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy");
    child.stdin.on("error", reject);
    child.stdin.end(text, "utf8");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy 退出码 ${code ?? "?"}`));
    });
  });
}

/**
 * GUI App 通用桥（ADR-0002）：辅助功能 API 投递任务 + 采集适配器回收结果。
 * 一座桥管所有本机 GUI App；每个 App 只需要一份定义。
 */
export interface GuiAppDef {
  id: string;
  displayName: string;
  /** System Events 里的进程名 / pgrep -x 的名字。 */
  processName: string;
  /** 激活后粘贴前等待的毫秒（App 冷启动聚焦慢）。 */
  focusDelayMs: number;
  recoverable: boolean;
}

export const GUI_APPS: GuiAppDef[] = [
  {
    id: "grok-bot",
    displayName: "Grok Bot",
    processName: "Grok Bot",
    focusDelayMs: 800,
    recoverable: true,
  },
  {
    id: "muse",
    displayName: "Muse",
    processName: "Muse",
    focusDelayMs: 800,
    // Muse 的会话落盘格式未逆，投递后暂无自动回收。
    recoverable: false,
  },
];

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

/** 辅助功能权限探测：能读到进程列表即有权限。 */
export async function accessibilityGranted(): Promise<boolean> {
  if (!isMac()) return false;
  try {
    await probe("osascript", [
      "-e",
      'tell application "System Events" to get name of first application process',
    ]);
    return true;
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
): Promise<GuiAppStatus> {
  if (!isMac()) {
    return { id: app.id, displayName: app.displayName, available: false, detail: "仅支持 macOS" };
  }
  if (!(await appRunning(app))) {
    return { id: app.id, displayName: app.displayName, available: false, detail: "App 未运行" };
  }
  if (!(await accessibility())) {
    return {
      id: app.id,
      displayName: app.displayName,
      available: false,
      detail: "需要授予 U-Brain「辅助功能」权限（系统设置 → 隐私与安全性）",
    };
  }
  return { id: app.id, displayName: app.displayName, available: true, detail: "就绪" };
}

export interface GuiDispatchResult {
  sentAtMs: number;
  /** recoverable=false 或投递失败说明。 */
  note?: string;
}

/** 把任务投递进 App 的输入框：复制到剪贴板 → 激活 → 粘贴 → 回车。 */
export async function dispatchToGuiApp(
  app: GuiAppDef,
  prompt: string,
): Promise<GuiDispatchResult> {
  if (!isMac()) throw new Error("GUI App 桥仅支持 macOS");
  const status = await guiAppStatus(app);
  if (!status.available) throw new Error(status.detail);
  await writeClipboard(prompt);
  const script = [
    `tell application "${app.displayName}" to activate`,
    `delay ${Math.max(0.3, app.focusDelayMs / 1000)}`,
    'tell application "System Events"',
    'keystroke "v" using command down',
    "delay 0.3",
    "key code 36",
    "end tell",
  ].join("\n");
  try {
    await run("osascript", ["-e", script]);
  } catch (error) {
    throw new Error(`投递失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return { sentAtMs: Date.now() };
}

/**
 * 投递后回收 App 里的新回复（grok-bot：读本地落盘转录）。
 * 返回按时间正序的 assistant 文本。
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
      for (const turn of transcript.turns) {
        if (turn.role !== "assistant") continue;
        if (turn.atMs === null || turn.atMs < sinceMs - 5_000) continue;
        replies.push({ atMs: turn.atMs, text: turn.text });
      }
    }
    replies.sort((left, right) => left.atMs - right.atMs);
    return replies.map((reply) => reply.text);
  }
  return [];
}
