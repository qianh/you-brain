import type { BrowserDaemon } from "../api/client.js";

const MIN_INTERVAL_MS = 30_000;
let last = 0;

/**
 * 用户可能马上要搜索时（打开搜索页、⌘K）提前通知 daemon 拉起嵌入进程。嵌入进程空闲两分钟就退出，
 * 冷启动要两秒左右；等用户打完字它已就绪。30 秒内只发一次，失败不提示。
 */
export function warmSearch(client: Pick<BrowserDaemon, "searchWarm">, now = Date.now()): void {
  if (now - last < MIN_INTERVAL_MS) return;
  last = now;
  void client.searchWarm().catch(() => undefined);
}
