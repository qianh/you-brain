/**
 * 中转「连接信息」：把中转地址和密钥打成一串文字，在已连接的电脑上复制，到新电脑的设置里粘贴即可，
 * 不用分别抄地址和密钥。只是编码不是加密，等同于密钥本身，不要发到聊天软件里。
 * 不依赖 Node，网页端也用它来解析粘贴的内容。
 */

const PREFIX = "u-brain-relay:";

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function encodeRelayInvite(url: string, key: string): string {
  return `${PREFIX}${toBase64Url(JSON.stringify({ u: url, k: key }))}`;
}

/** 解析粘贴的连接信息；不是连接信息时返回 null。 */
export function decodeRelayInvite(input: string): { url: string; key: string } | null {
  const text = input.trim();
  if (!text.startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(fromBase64Url(text.slice(PREFIX.length))) as { u?: unknown; k?: unknown };
    if (typeof value.u !== "string" || typeof value.k !== "string" || !value.u || !value.k) return null;
    return { url: value.u, key: value.k };
  } catch {
    return null;
  }
}
