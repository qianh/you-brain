import { YouBrainError } from "../../domain/errors.js";
import { normalizeT3Url, type T3WebState } from "./index.js";

const SHELL_LIMIT = 64 * 1024;

/** 只读检查公开 HTML shell，不向 T3 转发 daemon 的认证信息。 */
export async function probeT3Web(value: string): Promise<T3WebState> {
  const url = normalizeT3Url(value);
  if (url === null) throw new YouBrainError("INVALID_INPUT", "请输入 T3 的本机 HTTP(S) 服务根地址，不含账号、参数或会话路径。");
  try {
    const response = await fetch(url, {
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(3_000),
      headers: { accept: "text/html" },
    });
    const reader = response.body?.getReader();
    try {
      if (!response.ok) return { state: "error", url, reason: "unavailable" };
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
        return { state: "error", url, reason: "not-t3" };
      }
      const decoder = new TextDecoder();
      let html = "";
      let bytes = 0;
      while (reader && bytes < SHELL_LIMIT) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.subarray(0, SHELL_LIMIT - bytes);
        bytes += chunk.byteLength;
        html += decoder.decode(chunk, { stream: true });
      }
      html += decoder.decode();
      if (!/<title>\s*T3 Code(?:\s*\([^<]*\))?\s*<\/title>/iu.test(html)) {
        return { state: "error", url, reason: "not-t3" };
      }
      const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]+)/iu.exec(response.headers.get("content-security-policy") ?? "")?.[1]?.trim();
      const frameOptions = response.headers.get("x-frame-options")?.trim().toLowerCase();
      if (frameOptions === "deny" || frameOptions === "sameorigin" || ancestors === "'none'" || ancestors === "'self'") {
        return { state: "error", url, reason: "frame-blocked" };
      }
      return { state: "ready", url };
    } finally {
      await reader?.cancel();
    }
  } catch {
    return { state: "error", url, reason: "unavailable" };
  }
}
