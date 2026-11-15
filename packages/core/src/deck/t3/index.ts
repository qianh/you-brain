/** T3 的独立本机 Web 服务；不启动第二个进程或打开它的数据库。 */
export const DEFAULT_T3_URL = "http://127.0.0.1:3773/";

/** 只接受服务根地址，不保存配对令牌、账号信息或会话链接。 */
export function normalizeT3Url(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username !== "" || url.password !== "" ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
      url.port === "0"
    ) return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

export type T3WebState =
  | { state: "ready"; url: string }
  | { state: "error"; url: string; reason: "unavailable" | "not-t3" | "frame-blocked" };
