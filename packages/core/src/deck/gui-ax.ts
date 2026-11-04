import { spawn } from "node:child_process";

/**
 * GUI App 桥的静默通道：用辅助功能 API 直接写目标 App 的输入框，再把回车事件只发给该进程。
 * 不激活窗口，不走全局键盘和剪贴板，所以不会打断用户，也不可能把内容送进别的 App。
 *
 * 不用 AXPress 按发送按钮：Grok Bot 的按钮收到 AXPress 不会提交（实测），回车才会。
 *
 * 脚本跑在 osascript（JXA）里：不需要额外的原生组件，权限算在 U-Brain 头上。
 * 任务内容走 stdin，不进命令行参数，避免在进程列表里可见。
 */
export type AxAction = "probe" | "send" | "dry-run";

export interface AxRequest {
  action: AxAction;
  bundleId: string;
  /** 窗口关着时，从「Window」菜单里点这一项把它打开。 */
  windowTitle: string;
  text?: string;
}

export type AxFailureCode =
  | "not_running"
  | "no_permission"
  | "no_window"
  | "no_composer"
  | "draft"
  | "no_focus"
  | "write_failed"
  | "not_cleared"
  | "script";

export type AxResult =
  | { ok: true; hasWindow: boolean; hasComposer: boolean; openedWindow: boolean; refocused: boolean }
  | { ok: false; code: AxFailureCode; detail?: string };

export type AxRunner = (request: AxRequest, timeoutMs: number) => Promise<AxResult>;

export const AX_SCRIPT = String.raw`
ObjC.import("ApplicationServices");
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("Foundation");

function attr(el, name) {
  const ref = Ref();
  return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ref[0] : null;
}
function text(el, name) {
  const value = attr(el, name);
  if (value === null || value === undefined) return "";
  try { return String(ObjC.unwrap(ObjC.castRefToObject(value))); } catch (e) { return ""; }
}
function list(el, name) {
  const value = attr(el, name);
  if (!value) return [];
  const items = ObjC.castRefToObject(value);
  const out = [];
  for (let i = 0; i < Number(items.count); i++) out.push(items.objectAtIndex(i));
  return out;
}
function kids(el) { return list(el, "AXChildren"); }
function isBlank(value) { return value.replace(/[\s​￼]/g, "") === ""; }
function squeeze(value) { return value.replace(/[\s​￼]/g, ""); }

function scan(win) {
  const found = { inputs: [], hasWeb: false };
  let budget = 5000;
  (function walk(el, depth) {
    if (depth > 60 || budget-- <= 0) return;
    const role = text(el, "AXRole");
    if (role === "AXApplication" || role === "AXMenuBar") return;
    if (role === "AXWebArea") found.hasWeb = true;
    if (role === "AXTextArea") found.inputs.push(el);
    kids(el).forEach((child) => walk(child, depth + 1));
  })(win, 0);
  return found;
}
function mainWindow(app) {
  // 窗口看不到时（已关闭或不在当前桌面），Electron 的 AXWindows 会返回一个 role 为 AXApplication 的假元素。
  const windows = list(app, "AXWindows").filter((win) => text(win, "AXRole") === "AXWindow");
  return windows.find((win) => text(win, "AXMain") === "true") || windows[0] || null;
}
function pressWindowMenuItem(app, title) {
  const bar = kids(app).find((el) => text(el, "AXRole") === "AXMenuBar");
  if (!bar) return false;
  for (const menu of kids(bar)) {
    if (!/^(Window|窗口)$/.test(text(menu, "AXTitle"))) continue;
    for (const submenu of kids(menu)) {
      const item = kids(submenu).find((el) => text(el, "AXTitle") === title);
      if (item) return $.AXUIElementPerformAction(item, $("AXPress")) === 0;
    }
  }
  return false;
}
function frontmostPid() {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return front.isNil() ? -1 : Number(front.processIdentifier);
}
function setComposer(input, value) {
  return $.AXUIElementSetAttributeValue(input, $("AXValue"), $(value));
}
function postKey(pid, keyCode) {
  $.CGEventPostToPid(pid, $.CGEventCreateKeyboardEvent($(), keyCode, true));
  delay(0.02);
  $.CGEventPostToPid(pid, $.CGEventCreateKeyboardEvent($(), keyCode, false));
}
function isFocused(input) { return text(input, "AXFocused") === "true"; }
/**
 * 把目标 App 窗口内部的光标移到输入框（和用户电脑的键盘焦点无关，不激活窗口）。
 * App 在后台时 AXFocused 写入不生效（实测返回成功但没有效果），而发给进程的 Tab 能移动页面焦点；
 * Tab 只移动焦点、不触发任何按钮，循环一圈总会经过输入框。
 */
function focusComposer(input, pid) {
  const TAB_KEY = 48;
  const MAX_TABS = 80;
  if (isFocused(input)) return true;
  $.AXUIElementSetAttributeValue(input, $("AXFocused"), $.kCFBooleanTrue);
  delay(0.1);
  for (let i = 0; i < MAX_TABS && !isFocused(input); i++) {
    postKey(pid, TAB_KEY);
    delay(0.08);
  }
  return isFocused(input);
}

function act(req, app, state) {
  let win = mainWindow(app);
  if (!win && req.action === "probe") return { ok: true, hasWindow: false, hasComposer: false };
  if (!win) {
    if (!pressWindowMenuItem(app, req.windowTitle)) return { ok: false, code: "no_window" };
    state.openedWindow = true;
    for (let i = 0; i < 15 && !win; i++) { delay(0.2); win = mainWindow(app); }
    if (!win) return { ok: false, code: "no_window" };
  }

  // Electron 懒加载网页内容的辅助功能树：刚打开时只有几层空容器，要等一下。
  let found = scan(win);
  for (let i = 0; i < 8 && !found.hasWeb && found.inputs.length === 0; i++) { delay(0.4); found = scan(win); }
  if (found.inputs.length !== 1) {
    if (req.action === "probe") return { ok: true, hasWindow: true, hasComposer: false };
    return { ok: false, code: "no_composer", detail: String(found.inputs.length) };
  }
  if (req.action === "probe") return { ok: true, hasWindow: true, hasComposer: true };

  const input = found.inputs[0];
  if (!isBlank(text(input, "AXValue"))) return { ok: false, code: "draft" };
  if (!focusComposer(input, state.pid)) return { ok: false, code: "no_focus" };
  if (setComposer(input, req.text) !== 0) return { ok: false, code: "write_failed" };
  const clear = () => { setComposer(input, ""); };

  let written = false;
  const wanted = squeeze(req.text);
  for (let i = 0; i < 6 && !written; i++) { delay(0.2); written = squeeze(text(input, "AXValue")).indexOf(wanted) >= 0; }
  if (!written) { clear(); return { ok: false, code: "write_failed" }; }

  if (req.action === "dry-run") { clear(); return { ok: true, hasWindow: true, hasComposer: true }; }

  // 给 App 一点时间把写入同步进自己的状态，否则回车可能提交到空内容。
  delay(0.3);
  const RETURN_KEY = 36;
  postKey(state.pid, RETURN_KEY);
  for (let i = 0; i < 20; i++) {
    delay(0.2);
    const now = scan(win).inputs;
    if (now.length === 1 && isBlank(text(now[0], "AXValue"))) return { ok: true, hasWindow: true, hasComposer: true };
  }
  clear();
  return { ok: false, code: "not_cleared" };
}

function run() {
  const raw = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding);
  const req = JSON.parse(ObjC.unwrap(raw));
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ ok: false, code: "no_permission" });
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(req.bundleId);
  if (Number(apps.count) === 0) return JSON.stringify({ ok: false, code: "not_running" });
  const pid = Number(apps.objectAtIndex(0).processIdentifier);
  const app = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetAttributeValue(app, $("AXManualAccessibility"), $.kCFBooleanTrue);

  const frontAtStart = frontmostPid();
  const state = { openedWindow: false, pid: pid };
  let result;
  try {
    result = act(req, app, state);
  } catch (error) {
    result = { ok: false, code: "script", detail: String(error) };
  }
  // 打开窗口可能把 App 带到前台：只有确实是它抢走的才还回去，用户自己切走的不动。
  let refocused = false;
  if (frontAtStart !== pid && frontmostPid() === pid) {
    try {
      const events = Application("System Events");
      events.processes.whose({ unixId: frontAtStart })[0].frontmost = true;
      refocused = true;
    } catch (error) {}
  }
  if (result.ok) { result.openedWindow = state.openedWindow; result.refocused = refocused; }
  return JSON.stringify(result);
}
`;

function failure(detail: string): AxResult {
  return { ok: false, code: "script", detail: detail.trim().split("\n")[0]?.slice(0, 200) ?? "" };
}

/** 跑一次脚本。脚本自身的失败都走结果，这里只兜底进程级错误，不抛异常。 */
export const runAxScript: AxRunner = (request, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", AX_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(failure(error.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) {
        resolve(failure(`操作超时（${Math.round(timeoutMs / 1000)} 秒）`));
        return;
      }
      if (code !== 0) {
        resolve(failure(stderr || `osascript 退出码 ${code ?? "?"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as AxResult);
      } catch {
        resolve(failure(`无法解析结果：${stdout}`));
      }
    });
    child.stdin.end(JSON.stringify(request), "utf8");
  });
