export const DESKTOP_APP_RELATIVE = "dist/app.noindex/you-brain.app";

/** Shell binary, externalBin sidecar, and the two resource trees the shell expects. */
export const REQUIRED_APP_PARTS = [
  "Contents/MacOS/you-brain-desktop",
  "Contents/MacOS/you-brain",
  "Contents/Resources/vendor",
  "Contents/Resources/web",
] as const;

export function missingAppParts(present: readonly string[]): string[] {
  const have = new Set(present);
  return REQUIRED_APP_PARTS.filter((part) => !have.has(part));
}

export const AUTOSTART_NOTES = [
  "Cargo.toml 把 tauri-plugin-autostart 钉在 2.5.1。",
  "lib.rs 用 tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None) 注册插件。",
  "setup 调用 apply_autostart(app, shell.autostart.unwrap_or(true))。shell.json 读不到时默认开启。",
  "macOS 的 shell.json 在数据目录下，默认路径是 ~/Library/Application Support/you-brain/shell.json。本脚本不读这个文件，也不改登录项。",
  "apply_autostart 直接调用 app.autolaunch().enable() 或 disable()。",
  "capabilities/default.json 只有 allow-open-main-window 和 allow-quit，没有 autostart 权限。网页不能经 IPC 改开机自启。",
  "本脚本没有注册或取消登录项，也没有启动 you-brain.app。开机自启的运行时效果未验证。",
];
