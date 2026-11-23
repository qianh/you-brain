import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * T3 静态构建产物（`/assets/<name>-<hash>.<ext>`）的跨设备共享缓存（L1 内存 + L2 磁盘 + 本机 T3 零流量快路）。
 *
 * 为什么安全且有效：
 * - Vite 产出的 `/assets/*-<hash>.*` 文件名自带内容哈希，同一哈希对应的字节在所有设备上恒等；
 * - 切换或重连「VPS 主控」「我的 Mac」等远端设备的 T3 时，不再为几百个 JS / CSS / 字体块反复走中转隧道；
 * - 若本机恰好也运行着同版本（或部分 chunk 同哈希）的 T3，直接从本机 `127.0.0.1` 秒级命中，零隧道流量；
 * - 严格拒绝缓存非 200 或 `text/html`（SPA 兜底页），避免版本不一致时把 `index.html` 误当成脚本缓存。
 */

const IMMUTABLE_ASSET_RE = /^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/u;
const ABS_ASSET_SCAN_RE = /\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+/gu;
const REL_ASSET_SCAN_RE = /["'(]\.\/([A-Za-z0-9._-]+-[A-Za-z0-9_-]{6,}\.(?:js|mjs|css|wasm|woff2?))["')]/gu;

const DISK_MAGIC = Buffer.from("T3AC", "ascii");
const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DISK_BYTES = 256 * 1024 * 1024;
const LOCAL_PROBE_TIMEOUT_MS = 400;
const PREFETCH_CONCURRENCY = 4;
const MAX_PREFETCH_PER_SCAN = 64;
const PRUNE_INTERVAL_MS = 60_000;

export interface CachedAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface T3AssetCacheOptions {
  /** 磁盘二级缓存目录；不传则只用内存一级缓存。 */
  cacheDir?: string;
  /** 本机 T3 源地址（如 `http://127.0.0.1:3773`），命中同哈希构建产物时免走远端隧道。 */
  localOrigin?: () => string | null;
  /** 测试注入的本机探测 fetch。 */
  localFetch?: typeof fetch;
  maxMemoryBytes?: number;
  maxDiskBytes?: number;
}

export function isImmutableT3AssetPath(pathname: string): boolean {
  if (!pathname.startsWith("/assets/") || pathname.includes("..") || pathname.includes("//")) return false;
  return IMMUTABLE_ASSET_RE.test(pathname);
}

export function extractImmutableT3Assets(text: string, basePath = "/"): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(ABS_ASSET_SCAN_RE)) {
    const candidate = match[0];
    if (candidate && isImmutableT3AssetPath(candidate)) {
      found.add(candidate);
      if (found.size >= MAX_PREFETCH_PER_SCAN) return [...found];
    }
  }
  if (basePath.startsWith("/assets/")) {
    for (const match of text.matchAll(REL_ASSET_SCAN_RE)) {
      const rel = match[1];
      if (!rel) continue;
      const candidate = `/assets/${rel}`;
      if (isImmutableT3AssetPath(candidate)) {
        found.add(candidate);
        if (found.size >= MAX_PREFETCH_PER_SCAN) break;
      }
    }
  }
  return [...found];
}

function isCacheableContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower !== "" && !lower.includes("text/html");
}

function isScannableCodeType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes("javascript") || lower.includes("text/css");
}

function encodeDiskRecord(entry: CachedAsset): Buffer {
  const ct = Buffer.from(entry.contentType, "utf8");
  const header = Buffer.allocUnsafe(6);
  DISK_MAGIC.copy(header, 0);
  header.writeUInt16BE(ct.byteLength, 4);
  return Buffer.concat([header, ct, entry.body]);
}

function decodeDiskRecord(raw: Buffer): CachedAsset | null {
  if (raw.byteLength < 6) return null;
  if (!raw.subarray(0, 4).equals(DISK_MAGIC)) return null;
  const ctLen = raw.readUInt16BE(4);
  if (ctLen === 0 || 6 + ctLen > raw.byteLength) return null;
  const contentType = raw.subarray(6, 6 + ctLen).toString("utf8");
  if (!isCacheableContentType(contentType)) return null;
  return {
    contentType,
    body: new Uint8Array(raw.buffer, raw.byteOffset + 6 + ctLen, raw.byteLength - 6 - ctLen),
  };
}

export class T3AssetCache {
  readonly #cacheDir: string | null;
  readonly #localOrigin: (() => string | null) | undefined;
  readonly #localFetch: typeof fetch;
  readonly #maxMemoryBytes: number;
  readonly #maxDiskBytes: number;
  readonly #memory = new Map<string, CachedAsset>();
  readonly #inflight = new Map<string, Promise<CachedAsset | null>>();
  readonly #prefetchDone = new Set<string>();
  readonly #prefetchQueue: Array<{ path: string; fetcher: (path: string) => Promise<Response> }> = [];
  #memoryBytes = 0;
  #activePrefetch = 0;
  #dirReady: Promise<void> | null = null;
  #lastPruneAt = 0;

  constructor(options: T3AssetCacheOptions = {}) {
    this.#cacheDir = options.cacheDir ?? null;
    this.#localOrigin = options.localOrigin;
    this.#localFetch = options.localFetch ?? fetch;
    this.#maxMemoryBytes = options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
    this.#maxDiskBytes = options.maxDiskBytes ?? DEFAULT_MAX_DISK_BYTES;
  }

  hasMemory(pathname: string): boolean {
    return this.#memory.has(pathname);
  }

  /**
   * 读取或回源获取不可变静态资源。
   * 返回 `{ asset, scanned }`：命中可缓存资源时返回 `CachedAsset`；若上游返回非 200 / HTML 兜底页，则透传原始 `Response` 且不入缓存。
   */
  async getOrFetch(
    pathname: string,
    fetchUpstream: () => Promise<Response>,
    prefetchFetcher?: (assetPath: string) => Promise<Response>,
  ): Promise<{ cached: CachedAsset } | { passthrough: Response }> {
    const mem = this.#getMemory(pathname);
    if (mem) return { cached: mem };

    const existing = this.#inflight.get(pathname);
    if (existing) {
      const shared = await existing;
      if (shared) return { cached: shared };
    }

    let passthroughResponse: Response | null = null;
    const task = (async (): Promise<CachedAsset | null> => {
      const disk = await this.#readDisk(pathname);
      if (disk) {
        this.#putMemory(pathname, disk);
        this.#maybeScanAsset(pathname, disk, prefetchFetcher);
        return disk;
      }

      const local = await this.#probeLocal(pathname);
      if (local) {
        this.#putMemory(pathname, local);
        void this.#writeDisk(pathname, local);
        this.#maybeScanAsset(pathname, local, prefetchFetcher);
        return local;
      }

      const upstream = await fetchUpstream();
      const contentType = upstream.headers.get("content-type") ?? "";
      if (upstream.status !== 200 || !isCacheableContentType(contentType)) {
        passthroughResponse = upstream;
        return null;
      }
      const body = new Uint8Array(await upstream.arrayBuffer());
      const entry: CachedAsset = { body, contentType };
      this.#putMemory(pathname, entry);
      void this.#writeDisk(pathname, entry);
      this.#maybeScanAsset(pathname, entry, prefetchFetcher);
      return entry;
    })();

    this.#inflight.set(pathname, task);
    try {
      const asset = await task;
      if (asset) return { cached: asset };
      if (passthroughResponse) return { passthrough: passthroughResponse };
      return { passthrough: await fetchUpstream() };
    } finally {
      if (this.#inflight.get(pathname) === task) this.#inflight.delete(pathname);
    }
  }

  /** 从 HTML / JS / CSS 文本提取带哈希静态资源路径并在后台并发预热，消除多层模块瀑布流。 */
  prefetchFromText(text: string, basePath: string, fetcher: (assetPath: string) => Promise<Response>): void {
    const assets = extractImmutableT3Assets(text, basePath);
    for (const path of assets) {
      if (this.#memory.has(path) || this.#inflight.has(path) || this.#prefetchDone.has(path)) continue;
      this.#prefetchDone.add(path);
      if (this.#prefetchDone.size > 2_048) {
        const oldest = this.#prefetchDone.values().next().value;
        if (oldest !== undefined) this.#prefetchDone.delete(oldest);
      }
      this.#prefetchQueue.push({ path, fetcher });
    }
    this.#pumpPrefetch();
  }

  #maybeScanAsset(pathname: string, entry: CachedAsset, fetcher?: (assetPath: string) => Promise<Response>): void {
    if (!fetcher || !isScannableCodeType(entry.contentType) || entry.body.byteLength > 4 * 1024 * 1024) return;
    const text = Buffer.from(entry.body.buffer, entry.body.byteOffset, entry.body.byteLength).toString("utf8");
    this.prefetchFromText(text, pathname, fetcher);
  }

  #pumpPrefetch(): void {
    while (this.#activePrefetch < PREFETCH_CONCURRENCY && this.#prefetchQueue.length > 0) {
      const next = this.#prefetchQueue.shift()!;
      if (this.#memory.has(next.path) || this.#inflight.has(next.path)) continue;
      this.#activePrefetch += 1;
      void this.getOrFetch(next.path, () => next.fetcher(next.path), next.fetcher)
        .catch(() => undefined)
        .finally(() => {
          this.#activePrefetch -= 1;
          this.#pumpPrefetch();
        });
    }
  }

  #getMemory(pathname: string): CachedAsset | null {
    const hit = this.#memory.get(pathname);
    if (!hit) return null;
    this.#memory.delete(pathname);
    this.#memory.set(pathname, hit);
    return hit;
  }

  #putMemory(pathname: string, entry: CachedAsset): void {
    if (entry.body.byteLength > this.#maxMemoryBytes / 2) return;
    const prev = this.#memory.get(pathname);
    if (prev) {
      this.#memoryBytes -= prev.body.byteLength;
      this.#memory.delete(pathname);
    }
    while (this.#memoryBytes + entry.body.byteLength > this.#maxMemoryBytes && this.#memory.size > 0) {
      const oldestKey = this.#memory.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#memory.get(oldestKey);
      this.#memory.delete(oldestKey);
      if (oldest) this.#memoryBytes -= oldest.body.byteLength;
    }
    this.#memory.set(pathname, entry);
    this.#memoryBytes += entry.body.byteLength;
  }

  async #probeLocal(pathname: string): Promise<CachedAsset | null> {
    const origin = this.#localOrigin?.();
    if (!origin) return null;
    try {
      const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
      const response = await this.#localFetch(`${base}${pathname}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (response.status !== 200 || !isCacheableContentType(contentType)) return null;
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength === 0) return null;
      return { body, contentType };
    } catch {
      return null;
    }
  }

  #diskPath(pathname: string): string | null {
    if (!this.#cacheDir) return null;
    const digest = createHash("sha256").update(pathname).digest("hex");
    return join(this.#cacheDir, `${digest}.bin`);
  }

  async #ensureDir(): Promise<boolean> {
    if (!this.#cacheDir) return false;
    try {
      this.#dirReady ??= mkdir(this.#cacheDir, { recursive: true }).then(() => undefined);
      await this.#dirReady;
      return true;
    } catch {
      this.#dirReady = null;
      return false;
    }
  }

  async #readDisk(pathname: string): Promise<CachedAsset | null> {
    const target = this.#diskPath(pathname);
    if (!target) return null;
    try {
      const raw = await readFile(target);
      return decodeDiskRecord(raw);
    } catch {
      return null;
    }
  }

  async #writeDisk(pathname: string, entry: CachedAsset): Promise<void> {
    const target = this.#diskPath(pathname);
    if (!target || entry.body.byteLength > this.#maxDiskBytes / 4) return;
    if (!(await this.#ensureDir())) return;
    const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await writeFile(tmp, encodeDiskRecord(entry));
      await rename(tmp, target);
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      return;
    }
    const now = Date.now();
    if (now - this.#lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.#lastPruneAt = now;
      void this.#pruneDisk().catch(() => undefined);
    }
  }

  async #pruneDisk(): Promise<void> {
    if (!this.#cacheDir) return;
    const names = await readdir(this.#cacheDir);
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let total = 0;
    for (const name of names) {
      if (!name.endsWith(".bin")) continue;
      const fullPath = join(this.#cacheDir, name);
      try {
        const info = await stat(fullPath);
        total += info.size;
        files.push({ path: fullPath, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // 并发删除时忽略。
      }
    }
    if (total <= this.#maxDiskBytes) return;
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of files) {
      if (total <= this.#maxDiskBytes * 0.8) break;
      await rm(file.path, { force: true }).catch(() => undefined);
      total -= file.size;
    }
  }
}
