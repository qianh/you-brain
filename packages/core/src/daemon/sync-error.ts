import { YouBrainError } from "../domain/errors.js";

const MAX_SYNC_ERROR_CHARS = 200;

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current) && codes.length < 6) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") codes.push(current.code);
    current = "cause" in current ? current.cause : undefined;
  }
  return codes;
}

function httpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("response" in error && error.response && typeof error.response === "object" && "status" in error.response) {
    const status = error.response.status;
    if (typeof status === "number") return status;
  }
  return null;
}

function isAuth(error: unknown, message: string, status: number | null): boolean {
  if (status === 401 || status === 403) return true;
  if (error instanceof YouBrainError && error.code === "AUTH_REQUIRED") return true;
  return /invalid_grant|unauthorized|permission denied|forbidden|unauthenticated/iu.test(message);
}

function isTimeout(error: unknown, message: string, codes: string[]): boolean {
  if (codes.includes("ETIMEDOUT") || codes.includes("UND_ERR_CONNECT_TIMEOUT")) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return /timeout|timed out|请求超时|aborterror/iu.test(message);
}

function isNetwork(message: string, codes: string[]): boolean {
  if (codes.some((code) => NETWORK_CODES.has(code))) return true;
  return /getaddrinfo|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up|network error|网络不可用|无法连接/iu.test(
    message,
  );
}

/** Drop query strings, bearer tokens, and auth headers. The path of an https URL may stay. */
function sanitize(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        const cut = url.search(/[?#]/u);
        return cut === -1 ? url : url.slice(0, cut);
      }
    })
    .replace(/bearer\s+\S+/giu, "")
    .replace(/authorization\s*[:=]\s*\S+/giu, "")
    .replace(/\b(?:access_token|refresh_token|id_token|pageToken|page_token|api[_-]?key|token)\b\s*[=:]\s*\S+/giu, "")
    .replace(/ya29\.[A-Za-z0-9._~+/-]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function clip(text: string): string {
  const chars = [...text];
  const sliced = chars.length > MAX_SYNC_ERROR_CHARS ? chars.slice(0, MAX_SYNC_ERROR_CHARS).join("") : text;
  const trimmed = sliced.trim();
  return trimmed === "" ? "同步失败" : trimmed;
}

/** Short Chinese copy for a failed pull. At most 200 characters, with secrets removed. */
export function describeSyncFailure(error: unknown): string {
  const message = errorText(error);
  const status = httpStatus(error);
  const codes = errorCodes(error);
  if (isAuth(error, message, status)) return "同步失败：Google 授权无效，请重新登录";
  if (status === 404) return "同步失败：Drive 上的文件不存在";
  if (status === 429) return "同步失败：请求过于频繁，稍后会重试";
  if (isTimeout(error, message, codes)) return "同步失败：请求超时";
  if (isNetwork(message, codes)) return "同步失败：网络不可用";
  if (/cursor|page\s*token|pagetoken|startpagetoken|变更游标/iu.test(message)) {
    return "同步失败：变更游标无效";
  }
  const cleaned = sanitize(message);
  if (cleaned !== "" && /\p{Script=Han}/u.test(cleaned)) {
    const text = cleaned.startsWith("同步失败") ? cleaned : `同步失败：${cleaned}`;
    return clip(text);
  }
  if (status !== null && status >= 400) return clip(`同步失败：远端返回 HTTP ${status}`);
  return "同步失败";
}
