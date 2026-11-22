import { normalizeT3Url } from "@you-brain/core/deck/t3/index.js";

/** 本机 T3 地址（保持原有键不变，供 daemon 自动化读取）。 */
export const T3_URL_KEY = "you-brain.deck.t3-url";
/** 额外的远端 T3 端点列表（JSON 数组）。 */
export const T3_ENDPOINTS_KEY = "you-brain.deck.t3-endpoints";
/** 当前选中的 T3 端点 id（"local" 或某端点 id）。 */
export const T3_ACTIVE_KEY = "you-brain.deck.t3-active";
export const LOCAL_T3_ID = "local";
export const MAX_T3_ENDPOINTS = 8;
export const MAX_T3_ENDPOINT_NAME = 24;

export interface T3Endpoint {
  id: string;
  name: string;
  url: string;
}

export type AddEndpointError = "invalid-url" | "duplicate-url" | "limit";
export type AddEndpointResult =
  | { ok: true; endpoint: T3Endpoint; endpoints: T3Endpoint[] }
  | { ok: false; error: AddEndpointError };

function cleanName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, MAX_T3_ENDPOINT_NAME);
}

function defaultNameForUrl(normalizedUrl: string): string {
  return new URL(normalizedUrl).host.slice(0, MAX_T3_ENDPOINT_NAME);
}

function makeEndpointId(normalizedUrl: string, existing: ReadonlySet<string>): string {
  const parsed = new URL(normalizedUrl);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const base = `ep-${port}`;
  if (!existing.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `ep-${Date.now().toString(36)}`;
}

/** 解析端点列表偏好：坏 JSON、非回环地址、重复项或超出上限的项一律丢弃，不导致整体失败。 */
export function parseEndpoints(raw: string | null | undefined, localUrl?: string): T3Endpoint[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seenIds = new Set<string>([LOCAL_T3_ID]);
  const seenUrls = new Set<string>();
  if (localUrl !== undefined) {
    const normalizedLocal = normalizeT3Url(localUrl);
    if (normalizedLocal !== null) seenUrls.add(normalizedLocal);
  }

  const out: T3Endpoint[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_T3_ENDPOINTS) break;
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.url !== "string") continue;
    const id = candidate.id.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
    if (id === "" || id.length > 64 || seenIds.has(id)) continue;
    const name = cleanName(candidate.name);
    if (name === "") continue;
    const url = normalizeT3Url(candidate.url);
    if (url === null || seenUrls.has(url)) continue;
    seenIds.add(id);
    seenUrls.add(url);
    out.push({ id, name, url });
  }
  return out;
}

export function serializeEndpoints(list: readonly T3Endpoint[]): string {
  return JSON.stringify(list.map(({ id, name, url }) => ({ id, name, url })));
}

/** 校验并新增远端端点：仅接受回环地址、不与本机及已有端点重复、不超过上限。 */
export function addEndpoint(
  list: readonly T3Endpoint[],
  input: { name: string; url: string },
  localUrl: string,
): AddEndpointResult {
  if (list.length >= MAX_T3_ENDPOINTS) return { ok: false, error: "limit" };
  const url = normalizeT3Url(input.url);
  if (url === null) return { ok: false, error: "invalid-url" };

  const normalizedLocal = normalizeT3Url(localUrl) ?? localUrl;
  if (url === normalizedLocal || list.some((item) => (normalizeT3Url(item.url) ?? item.url) === url)) {
    return { ok: false, error: "duplicate-url" };
  }

  const existingIds = new Set<string>([LOCAL_T3_ID, ...list.map((item) => item.id)]);
  const id = makeEndpointId(url, existingIds);
  const name = cleanName(input.name) || defaultNameForUrl(url);
  const endpoint: T3Endpoint = { id, name, url };
  return { ok: true, endpoint, endpoints: [...list, endpoint] };
}

export function removeEndpoint(list: readonly T3Endpoint[], id: string): T3Endpoint[] {
  return list.filter((item) => item.id !== id);
}

/** 解析当前激活的端点 id；未知或已删除的 id 回落到本机（"local"）。 */
export function resolveActive(raw: string | null | undefined, list: readonly T3Endpoint[]): string {
  if (!raw || raw === LOCAL_T3_ID) return LOCAL_T3_ID;
  return list.some((item) => item.id === raw) ? raw : LOCAL_T3_ID;
}

/** 检查地址是否与给定端点列表冲突（用于修改本机地址时避免与远端端点重复）。 */
export function isDuplicateEndpointUrl(url: string, list: readonly T3Endpoint[]): boolean {
  const normalized = normalizeT3Url(url) ?? url;
  return list.some((item) => (normalizeT3Url(item.url) ?? item.url) === normalized);
}
