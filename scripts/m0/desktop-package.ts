/**
 * M0 第 6 项：只读检查 Tauri 外壳的打包与签名，并从源码核对开机自启。
 *
 * 前置条件：dist/app.noindex/you-brain.app 已存在。没有则退出码 2。
 * 只对这个 .app 做 codesign / spctl。不启动 app，不注册或取消登录项，
 * 不读 ~/Library/Application Support/you-brain，不碰 /Applications/you-brain.app。
 *
 * spctl 拒绝未公证的包是预期，不把脚本判失败。codesign --verify 失败才判失败。
 *
 * 用法：bun scripts/m0/desktop-package.ts
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseCodesignDisplay, parseSpctl } from "./codesign-parse.ts";
import { AUTOSTART_NOTES, DESKTOP_APP_RELATIVE, missingAppParts, REQUIRED_APP_PARTS } from "./desktop-layout.ts";
import { repoRoot } from "./layout.ts";
import { clip, emit, errorText, type M0Result } from "./result.ts";

const item = "desktop-package";

async function capture(argv: string[]): Promise<{ exitCode: number | null; text: string }> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  const text = [stderr, stdout].filter((part) => part.length > 0).join("\n");
  return { exitCode: timedOut ? null : exitCode, text: clip(text, 4_000) };
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const app = join(repoRoot, DESKTOP_APP_RELATIVE);
  if (!existsSync(app)) {
    emit(
      {
        item,
        ok: false,
        evidence: { app, exists: false },
        notes: ["dist/app.noindex/you-brain.app 不存在。需要先打好桌面包。本脚本不构建、不启动 app。", ...AUTOSTART_NOTES],
      },
      2,
    );
  }
  const macosDir = join(app, "Contents/MacOS");
  const resourceDir = join(app, "Contents/Resources");
  const [display, verify, gatekeeper, macosNames, resourceNames] = await Promise.all([
    capture(["codesign", "-dv", "--verbose=4", app]),
    capture(["codesign", "--verify", "--deep", "--strict", app]),
    capture(["spctl", "-a", "-vv", app]),
    names(macosDir),
    names(resourceDir),
  ]);
  const plist = await capture(["plutil", "-extract", "CFBundleIdentifier", "raw", join(app, "Contents/Info.plist")]);
  const bundleId = plist.exitCode === 0 ? plist.text.trim() : null;
  const present = REQUIRED_APP_PARTS.filter((part) => existsSync(join(app, part)));
  const missing = missingAppParts(present);
  const signature = parseCodesignDisplay(display.text);
  const assessment = parseSpctl(gatekeeper.text);
  const verified = verify.exitCode === 0;
  const ok = missing.length === 0 && verified && bundleId === "dev.youbrain.app";
  const notes = [
    signature.adHoc ? "签名类型是 ad-hoc。" : "签名类型不是 ad-hoc。Authority 见 evidence.codesign.parsed.authorities。",
    `hardened runtime：${signature.hardenedRuntime ? "flags 含 runtime" : "flags 不含 runtime"}。`,
    signature.identifier === "dev.youbrain.app"
      ? "codesign Identifier 与 tauri.conf 的 dev.youbrain.app 一致。"
      : `codesign Identifier 是 ${signature.identifier ?? "空"}。ad-hoc / linker-signed 时这是链接器标识，Bundle id 在 Info.plist（${bundleId ?? "读不到"}）。`,
    verified
      ? "codesign --verify --deep --strict 通过。"
      : `codesign --verify --deep --strict 失败：${verify.text.trim() || "没有输出"}`,
    assessment.accepted === false
      ? "spctl 拒绝。未公证时这是预期，不单独把脚本判失败。"
      : assessment.accepted === true
        ? "spctl 接受。"
        : "spctl 的输出不是标准的 accepted/rejected 行，原样记在 evidence.spctl。",
    ...AUTOSTART_NOTES,
  ];
  const result: M0Result = {
    item,
    ok,
    evidence: {
      app,
      bundleId,
      macosNames,
      resourceNames,
      present,
      missing,
      codesign: {
        exitCode: display.exitCode,
        parsed: signature,
        text: display.text,
      },
      verify: { exitCode: verify.exitCode, text: verify.text },
      spctl: { exitCode: gatekeeper.exitCode, parsed: assessment, text: gatekeeper.text },
    },
    notes,
  };
  emit(result, ok ? 0 : 1);
}

try {
  await main();
} catch (error) {
  emit({ item, ok: false, evidence: { error: errorText(error) }, notes: AUTOSTART_NOTES }, 1);
}
