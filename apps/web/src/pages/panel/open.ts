import type { WindowBridge } from "../../lib/window.js";

export async function openAppPath(
  bridge: WindowBridge,
  path: string,
): Promise<"tauri" | "browser" | "blocked"> {
  if (bridge.invoke) {
    await bridge.invoke("open_main_window");
    return "tauri";
  }
  const url = new URL(path, bridge.pageUrl).toString();
  const opened = bridge.open(url, "you-brain-main", "width=1100,height=760");
  if (!opened) return "blocked";
  try {
    if (opened.location && opened.location.href !== url) opened.location.href = url;
  } catch {
    // A named window from another origin cannot be navigated. The new window already used `url`.
  }
  return "browser";
}
