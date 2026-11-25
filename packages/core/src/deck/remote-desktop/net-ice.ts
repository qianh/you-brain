import { Resolver } from "node:dns/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import type { IceServerEntry } from "@you-brain/protocol";

/**
 * 经实测在中国大陆三网可达、低延迟（20~45ms）且返回真实公网映射端口的公共 STUN 节点。
 * 移除已停服超时的 `stun.qq.com` 以及在代理 Fake-IP 模式下易被分流到海外出口的 `stun.l.google.com` / `stun.cloudflare.com`。
 */
export const DEFAULT_DOMESTIC_STUN_URLS = [
  "stun:stun.chat.bilibili.com:3478",
  "stun:stun.miwifi.com:3478",
] as const;

export const DEFAULT_DIRECT_DNS_SERVERS = ["223.5.5.5", "119.29.29.29"] as const;

const STUN_URL_RE = /^stun:([^:/?#[\]\s]+)(:\d+)?(\?[^\s]*)?$/iu;
const CANDIDATE_PARSE_RE = /^(?:a=)?candidate:\S+\s+\d+\s+\S+\s+\d+\s+([^\s]+)\s+\d+\s+typ\s+\S+(.*)$/iu;
const RADDR_RE = /\braddr\s+([^\s]+)/iu;

const PHYSICAL_LAN_IFACE_RE = /^(?:en\d+|eth\d+|wlan\d+|wl\w+|bond\d+|eno\d+|enp\w+|ens\w+)$/iu;

const STUN_DNS_CACHE_TTL_MS = 5 * 60_000;
const SYSTEM_LOOKUP_TIMEOUT_MS = 450;
const DIRECT_RESOLVE_TIMEOUT_MS = 650;

interface CachedStunUrl {
  url: string;
  expiresAt: number;
}

const stunUrlCache = new Map<string, CachedStunUrl>();

function normalizeIpLiteral(raw: string): string {
  let clean = raw.trim();
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1);
  }
  const zoneIdx = clean.indexOf("%");
  if (zoneIdx >= 0) {
    clean = clean.slice(0, zoneIdx);
  }
  return clean.toLowerCase();
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

/**
 * 判断是否为代理软件（Shadowrocket / Clash / Mihomo / Surge / Sing-box）常用的
 * RFC 2544 Fake-IP / TUN 基准网段 `198.18.0.0/15`（`198.18.x.x` ~ `198.19.x.x`）。
 */
export function isFakeIpV4(ip: string): boolean {
  const octets = parseIpv4Octets(normalizeIpLiteral(ip));
  if (!octets) return false;
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

/**
 * 判断是否为 Tailscale / Headscale / WireGuard CGNAT 组建的直连虚拟局域网地址：
 * - IPv4：`100.64.0.0/10`（`100.64.0.0` ~ `100.127.255.255`）
 * - IPv6：`fd7a:115c:a1e0::/48`
 */
export function isTailscaleIp(ip: string): boolean {
  const clean = normalizeIpLiteral(ip);
  const octets = parseIpv4Octets(clean);
  if (octets) {
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  }
  return clean.startsWith("fd7a:115c:a1e0:");
}

function isKnownProxyTunIpv6(cleanIpv6: string): boolean {
  return (
    cleanIpv6.startsWith("fdfe:dcba:9876:") || // Clash / Mihomo 默认 TUN IPv6
    cleanIpv6.startsWith("fd00:1234:ffff:") // Shadowrocket 默认 TUN IPv6
  );
}

/**
 * 判断某个候选地址是否属于代理虚拟网卡（Fake-IP TUN）、链路本地地址或不可路由伪地址。
 * 注意：绝不拦截 `127.0.0.1`（单机测试）与 Tailscale `100.64.0.0/10` / `fd7a:115c:a1e0::/48`。
 */
export function isProxyFakeOrBogusIp(ip: string, extraBlocked?: ReadonlySet<string>): boolean {
  const clean = normalizeIpLiteral(ip);
  if (!clean) return true;
  if (extraBlocked?.has(clean)) return true;
  if (isTailscaleIp(clean)) return false;

  const octets = parseIpv4Octets(clean);
  if (octets) {
    const [a, b] = octets;
    if (a === 0 || a >= 240) return true;
    if (a === 169 && b === 254) return true; // APIPA link-local
    if (a === 198 && (b === 18 || b === 19)) return true; // Proxy Fake-IP / TUN
    return false;
  }

  if (clean.includes(":")) {
    if (clean === "::") return true;
    if (clean.startsWith("fe80:")) return true; // IPv6 link-local
    if (isKnownProxyTunIpv6(clean)) return true;
  }
  return false;
}

export interface LocalIceInterfaceInspection {
  /** 按优先级排序的优选本机直连地址（Tailscale > 物理局域网 IPv4 > 物理局域网 IPv6）。 */
  preferredHostAddresses: string[];
  /** 本机代理 TUN 虚拟网卡上的所有 IPv4/IPv6 地址集合（全部小写）。 */
  blockedIps: Set<string>;
}

/**
 * 扫描本机网卡：
 * 1. 识别挂载了 `198.18.0.0/15` 或已知代理 ULA 的虚拟 TUN 网卡（如 Shadowrocket `utun5`），
 *    将该网卡上的全部 IPv4 与伴生 IPv6 一并拉黑，防止 WebRTC 绑定到代理隧道；
 * 2. 提取 Tailscale（`100.64.0.0/10`）与物理网卡（`en0` / `eth0`）真实内网地址，优先供给 ICE 收集。
 */
export function inspectLocalIceInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): LocalIceInterfaceInspection {
  const blockedIps = new Set<string>();
  const tailscaleV4: string[] = [];
  const tailscaleV6: string[] = [];
  const lanV4: string[] = [];
  const lanV6: string[] = [];

  for (const [ifaceName, list] of Object.entries(interfaces)) {
    if (!list || list.length === 0) continue;
    const isProxyTunIface = list.some((info) => {
      if (info.internal) return false;
      const clean = normalizeIpLiteral(info.address);
      return isFakeIpV4(clean) || isKnownProxyTunIpv6(clean);
    });

    if (isProxyTunIface) {
      for (const info of list) {
        if (!info.internal && info.address) {
          blockedIps.add(normalizeIpLiteral(info.address));
        }
      }
      continue;
    }

    const isPhysicalLan = PHYSICAL_LAN_IFACE_RE.test(ifaceName);
    for (const info of list) {
      if (info.internal || !info.address) continue;
      const clean = normalizeIpLiteral(info.address);
      if (isProxyFakeOrBogusIp(clean, blockedIps)) continue;
      const v4 = info.family === "IPv4" || parseIpv4Octets(clean) !== null;
      if (isTailscaleIp(clean)) {
        if (v4) tailscaleV4.push(clean);
        else tailscaleV6.push(clean);
      } else if (isPhysicalLan) {
        if (v4) lanV4.push(clean);
        else lanV6.push(clean);
      }
    }
  }

  const preferredHostAddresses = [
    ...new Set([...tailscaleV4, ...lanV4, ...tailscaleV6, ...lanV6]),
  ];
  return { preferredHostAddresses, blockedIps };
}

/** `0.0.0.0` / `::`：浏览器隐藏真实内网地址时 `raddr` 使用的占位地址。 */
function isUnspecifiedIp(ip: string): boolean {
  const clean = normalizeIpLiteral(ip);
  return clean === "0.0.0.0" || clean === "::";
}

/**
 * 检查单条 ICE candidate 字符串（支持带或不带 `a=` 前缀）是否包含代理 Fake-IP / TUN 地址，
 * 同时拦截以代理虚拟网卡为底座（`raddr 198.18.x.x`）派生出的 `srflx` / `relay` 候选。
 */
export function isBlockedIceCandidateLine(
  candidateLine: string,
  extraBlocked?: ReadonlySet<string>,
): boolean {
  const trimmed = candidateLine.trim();
  if (!trimmed) return false;
  const match = CANDIDATE_PARSE_RE.exec(trimmed);
  if (!match) return false;
  const addr = match[1] ?? "";
  const rest = match[2] ?? "";
  if (!addr.toLowerCase().endsWith(".local") && isProxyFakeOrBogusIp(addr, extraBlocked)) {
    return true;
  }
  const raddrMatch = RADDR_RE.exec(rest);
  // 浏览器开启 mDNS 隐私保护时会把 srflx / relay 的 raddr 改写成 `0.0.0.0` / `::`，这是占位而非伪地址，不能据此拦截。
  if (
    raddrMatch?.[1] &&
    !isUnspecifiedIp(raddrMatch[1]) &&
    isProxyFakeOrBogusIp(raddrMatch[1], extraBlocked)
  ) {
    return true;
  }
  return false;
}

/** 从 SDP 文本中剔除所有绑定在代理 Fake-IP / TUN 网卡上的 `a=candidate:` 行。 */
export function stripBlockedIceCandidatesFromSdp(
  sdp: string,
  extraBlocked?: ReadonlySet<string>,
): string {
  if (!sdp.includes("candidate:")) return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp
    .split(/\r?\n/)
    .filter((line) => !(line.startsWith("a=candidate:") && isBlockedIceCandidateLine(line, extraBlocked)))
    .join(eol);
}

export interface DirectStunResolveOptions {
  systemLookup?: (hostname: string) => Promise<string | null>;
  directResolve4?: (hostname: string) => Promise<string[]>;
  dnsServers?: readonly string[];
  now?: () => number;
  useCache?: boolean;
}

function defaultSystemLookup(hostname: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), SYSTEM_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
    dnsLookup(hostname, { family: 4 })
      .then((res) => {
        clearTimeout(timer);
        resolve(res.address || null);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

function createDirectResolve4(dnsServers: readonly string[]): (hostname: string) => Promise<string[]> {
  let resolver: Resolver | null = null;
  return (hostname: string) =>
    new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), DIRECT_RESOLVE_TIMEOUT_MS);
      timer.unref?.();
      try {
        if (!resolver) {
          resolver = new Resolver();
          resolver.setServers([...dnsServers]);
        }
        resolver
          .resolve4(hostname)
          .then((ips) => {
            clearTimeout(timer);
            resolve(Array.isArray(ips) ? ips : []);
          })
          .catch(() => {
            clearTimeout(timer);
            resolve([]);
          });
      } catch {
        clearTimeout(timer);
        resolve([]);
      }
    });
}

const DEAD_STUN_HOSTS = new Set(["stun.qq.com"]);
const OVERSEAS_PROXY_PRONE_STUN_HOSTS = new Set(["stun.l.google.com", "stun.cloudflare.com"]);

/**
 * 绕过代理软件的 Fake-IP DNS 劫持解析 `stun:` 域名，并自动清洗旧版中转下发的停服/易被代理劫持节点：
 *
 * 1. 无条件剔除已停服超时的 `stun.qq.com`（否则每次建连白等 STUN 超时）；
 * 2. 当检测到本机处于 Shadowrocket / Clash Fake-IP TUN（`198.18.0.0/15`）环境时：
 *    - 剔除会被 `GEOIP` 分流到海外代理出口（测出美国代理公网 IP）的 `stun.l.google.com` / `stun.cloudflare.com`，
 *      补齐国内高速节点 `stun.chat.bilibili.com:3478` 与 `stun.miwifi.com:3478`；
 *    - 直接通过国内公共 DNS（`223.5.5.5` / `119.29.29.29`）取出 STUN 真实国内 IPv4，
 *      自动命中代理 `GEOIP,CN,DIRECT` 规则，20~40ms 拿到本机真实国内运营商公网映射地址。
 */
export async function resolveDirectStunIceServers(
  servers: readonly IceServerEntry[],
  options?: DirectStunResolveOptions,
): Promise<IceServerEntry[]> {
  if (servers.length === 0) return [];
  const now = options?.now ?? Date.now;
  const useCache = options?.useCache ?? options === undefined;
  const systemLookup = options?.systemLookup ?? defaultSystemLookup;
  const directResolve4 =
    options?.directResolve4 ?? createDirectResolve4(options?.dnsServers ?? DEFAULT_DIRECT_DNS_SERVERS);

  const resolveSingleUrl = async (rawUrl: string): Promise<string | null> => {
    const trimmed = rawUrl.trim();
    const match = STUN_URL_RE.exec(trimmed);
    if (!match) return rawUrl;
    const host = (match[1] ?? "").toLowerCase();
    const portPart = match[2] ?? ":3478";
    const queryPart = match[3] ?? "";
    if (!host || isIP(host) !== 0 || host.endsWith(".local")) {
      return rawUrl;
    }
    if (DEAD_STUN_HOSTS.has(host)) {
      return null;
    }

    const cacheKey = trimmed.toLowerCase();
    const nowMs = now();
    if (useCache) {
      const cached = stunUrlCache.get(cacheKey);
      if (cached && cached.expiresAt > nowMs) {
        return cached.url || null;
      }
    }

    const sysIp = await systemLookup(host);
    const fakeIpHijacked = Boolean(sysIp && isFakeIpV4(sysIp));

    // 在 Fake-IP 代理环境下，海外公共 STUN 即使解出真实 IP 也会走代理出口并测出海外代理 IP，直接剔除。
    if (fakeIpHijacked && OVERSEAS_PROXY_PRONE_STUN_HOSTS.has(host)) {
      if (useCache) {
        stunUrlCache.set(cacheKey, { url: "", expiresAt: nowMs + STUN_DNS_CACHE_TTL_MS });
      }
      return null;
    }

    // 系统 DNS 未被 Fake-IP 劫持时保持原样，兼容纯 IPv6 或无代理环境。
    if (sysIp && !isProxyFakeOrBogusIp(sysIp)) {
      if (useCache) {
        stunUrlCache.set(cacheKey, { url: rawUrl, expiresAt: nowMs + STUN_DNS_CACHE_TTL_MS });
      }
      return rawUrl;
    }

    const directIps = await directResolve4(host);
    const validRealIp = directIps.find((ip) => isIP(ip) === 4 && !isProxyFakeOrBogusIp(ip));
    if (!validRealIp) {
      return OVERSEAS_PROXY_PRONE_STUN_HOSTS.has(host) ? null : rawUrl;
    }

    const rewritten = `stun:${validRealIp}${portPart}${queryPart}`;
    if (useCache) {
      stunUrlCache.set(cacheKey, { url: rewritten, expiresAt: nowMs + STUN_DNS_CACHE_TTL_MS });
    }
    return rewritten;
  };

  const out: IceServerEntry[] = [];
  for (const entry of servers) {
    const hasTurn = entry.urls.some((u) => /^turns?:/iu.test(u.trim()));
    const rawUrls = !hasTurn
      ? [...new Set([...DEFAULT_DOMESTIC_STUN_URLS, ...entry.urls])]
      : entry.urls;
    const resolved = (await Promise.all(rawUrls.map(resolveSingleUrl))).filter(
      (u): u is string => typeof u === "string" && u.length > 0,
    );
    const deduped = [...new Set(resolved)];
    if (deduped.length > 0) {
      out.push({
        ...entry,
        urls: deduped,
      });
    }
  }
  return out;
}
