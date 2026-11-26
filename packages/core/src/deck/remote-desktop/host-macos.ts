import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { RdDisplayInfo, RdPermissions, RdQuality } from "@you-brain/protocol";

import { resolveMacKeyCode } from "./keycodes-macos.js";
import { MACOS_REMOTE_HOST_APP_SWIFT, MACOS_REMOTE_HOST_PLIST } from "./macos-app-swift.js";
import { MACOS_UI_BRIDGE_SWIFT } from "./macos-ui-swift.js";
import { MACOS_VIDEO_PIPELINE_SWIFT } from "./macos-video-swift.js";
import { WheelStreamDecoder } from "./wheel.js";
import {
  CLIPBOARD_MAX_CHARS,
  QUALITY_PRESETS,
  type ControlClientMessage,
  type EncodedVideoFrame,
  type FastInputMessage,
  type HostClipboardEvent,
  type HostClipboardFile,
  type HostCursorShape,
  type HostStateSnapshot,
  type HostStreamOptions,
  type HostVideoCounters,
} from "./types.js";

const exec = promisify(execFile);

const VIDEO_MAGIC = 0x55425244; // "UBRD"
const VIDEO_HEADER_BYTES = 24;
const MAX_VIDEO_FRAME_BYTES = 16 * 1024 * 1024;
const CLIPBOARD_IMAGE_TIMEOUT_MS = 10_000;

export interface RemoteDesktopHostBridge {
  warmup?(): Promise<void>;
  ensureStarted(options: {
    quality: RdQuality;
    displayId?: number;
    promptPermissions?: boolean;
  }): Promise<HostStateSnapshot>;
  configure(options: {
    quality: RdQuality;
    displayId?: number;
    promptPermissions?: boolean;
  }): Promise<HostStateSnapshot>;
  getStateSnapshot(): HostStateSnapshot;
  requestKeyframe(): void;
  requestPermissionsPrompt(): void;
  handleFastInput(msg: FastInputMessage): void;
  handleControlInput(msg: ControlClientMessage): void;
  releaseInputs(): void;
  /** 汇总后的流选项：光标是否进画面、是否上报光标形状、是否监听剪贴板。 */
  setStreamOptions?(options: HostStreamOptions): void;
  /** 动态调整编码码率（不触发关键帧）。 */
  setBitrate?(bps: number): void;
  /** 按链路收紧采集分辨率上限与帧率（分辨率变化会重建编码会话并出关键帧），同时保持给定码率。 */
  setStreamProfile?(profile: { maxDimension: number; fps: number; bitrateBps: number }): void;
  /**
   * 请求助手上报视频管线累计计数，返回上一次收到的值（首次或旧版助手为 null）。
   * 按统计周期轮询，结果滞后一个周期，诊断用足够。
   */
  pollVideoCounters?(): HostVideoCounters | null;
  /** 让助手立即重发当前光标形状。 */
  requestCursor?(): void;
  /** 把 PNG 图片写入远端剪贴板。 */
  writeClipboardImage?(pngBase64: string): void;
  /** 读取远端剪贴板里的图片（PNG）；没有图片时为 null。 */
  readClipboardImage?(): Promise<Buffer | null>;
  subscribeVideo(listener: (frame: EncodedVideoFrame) => void): () => void;
  subscribeState(listener: (state: HostStateSnapshot) => void): () => void;
  subscribeClipboard(listener: (text: string, meta?: HostClipboardEvent) => void): () => void;
  subscribeCursor?(listener: (cursor: HostCursorShape) => void): () => void;
  subscribeError(listener: (error: string) => void): () => void;
  close(): Promise<void>;
}

/**
 * 解析本地 `--video` 套接字的二进制 H.264 帧流（24 字节头 + SPS + PPS + AVCC）。
 */
export class BinaryVideoFrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (frame: EncodedVideoFrame) => void): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    let offset = 0;
    while (this.#buf.length - offset >= VIDEO_HEADER_BYTES) {
      const magic = this.#buf.readUInt32BE(offset);
      if (magic !== VIDEO_MAGIC) {
        throw new Error(`无效的视频帧头魔数: 0x${magic.toString(16)}`);
      }
      const flags = this.#buf.readUInt32BE(offset + 4);
      const ptsUs = Number(this.#buf.readBigUInt64BE(offset + 8));
      const spsLen = this.#buf.readUInt16BE(offset + 16);
      const ppsLen = this.#buf.readUInt16BE(offset + 18);
      const avccLen = this.#buf.readUInt32BE(offset + 20);
      const bodyLen = spsLen + ppsLen + avccLen;
      if (bodyLen > MAX_VIDEO_FRAME_BYTES) {
        throw new Error(`视频帧体积超限: ${bodyLen}`);
      }
      const total = VIDEO_HEADER_BYTES + bodyLen;
      if (this.#buf.length - offset < total) break;

      const spsStart = offset + VIDEO_HEADER_BYTES;
      const ppsStart = spsStart + spsLen;
      const avccStart = ppsStart + ppsLen;
      const avccEnd = avccStart + avccLen;

      const sps = spsLen > 0 ? Buffer.from(this.#buf.subarray(spsStart, ppsStart)) : null;
      const pps = ppsLen > 0 ? Buffer.from(this.#buf.subarray(ppsStart, avccStart)) : null;
      const avcc = Buffer.from(this.#buf.subarray(avccStart, avccEnd));

      onFrame({
        keyframe: (flags & 1) === 1,
        ptsUs,
        sps,
        pps,
        avcc,
      });
      offset = avccEnd;
    }

    if (offset > 0) {
      this.#buf =
        offset === this.#buf.length
          ? Buffer.alloc(0)
          : Buffer.from(this.#buf.subarray(offset));
    }
  }

  reset(): void {
    this.#buf = Buffer.alloc(0);
  }
}

let inFlightHelperBuild: Promise<string> | null = null;

const HELPER_BUNDLE_ID = "app.you-brain.remote-host";
const HELPER_DESIGNATED_REQUIREMENT = `designated => identifier "${HELPER_BUNDLE_ID}"`;

export async function buildMacOsRemoteHostHelper(home = homedir()): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("当前平台不支持 macOS 远程桌面宿主");
  }
  if (inFlightHelperBuild) return inFlightHelperBuild;
  inFlightHelperBuild = (async () => {
    const digest = createHash("sha256")
      .update(MACOS_VIDEO_PIPELINE_SWIFT)
      .update(MACOS_UI_BRIDGE_SWIFT)
      .update(MACOS_REMOTE_HOST_APP_SWIFT)
      .update(MACOS_REMOTE_HOST_PLIST)
      .update(HELPER_DESIGNATED_REQUIREMENT)
      .update(process.arch)
      .digest("hex")
      .slice(0, 20);
    const cache = join(home, "Library", "Caches", "you-brain", "remote-desktop");
    const destination = join(cache, digest);
    const appBundle = join(destination, "U-Brain Remote Host.app");
    const executable = join(appBundle, "Contents", "MacOS", "UBrainRemoteHost");
    try {
      await access(executable);
      return appBundle;
    } catch {
      // 首次构建并缓存
    }

    const moduleCache = join(cache, "module-cache");
    await mkdir(moduleCache, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(cache, "build-"));
    const videoSwift = join(temporary, "VideoPipeline.swift");
    const uiSwift = join(temporary, "UiBridge.swift");
    const mainSwift = join(temporary, "main.swift");
    const app = join(temporary, "U-Brain Remote Host.app");
    try {
      await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
      await writeFile(videoSwift, MACOS_VIDEO_PIPELINE_SWIFT, "utf8");
      await writeFile(uiSwift, MACOS_UI_BRIDGE_SWIFT, "utf8");
      await writeFile(mainSwift, MACOS_REMOTE_HOST_APP_SWIFT, "utf8");
      await writeFile(join(app, "Contents", "Info.plist"), MACOS_REMOTE_HOST_PLIST, "utf8");
      await exec(
        "xcrun",
        [
          "swiftc",
          "-O",
          "-module-cache-path",
          moduleCache,
          "-swift-version",
          "5",
          videoSwift,
          uiSwift,
          mainSwift,
          "-o",
          join(app, "Contents", "MacOS", "UBrainRemoteHost"),
          "-framework",
          "AppKit",
          "-framework",
          "ApplicationServices",
          "-framework",
          "Carbon",
          "-framework",
          "IOKit",
          "-framework",
          "CoreGraphics",
          "-framework",
          "CoreMedia",
          "-framework",
          "CoreVideo",
          "-framework",
          "ScreenCaptureKit",
          "-framework",
          "VideoToolbox",
        ],
        { timeout: 120_000 },
      );
      await rm(videoSwift, { force: true });
      await rm(uiSwift, { force: true });
      await rm(mainSwift, { force: true });
      // 临时签名默认按内容哈希认证，每次重编译后系统隐私授权（屏幕录制、辅助功能）都会失效；
      // 固定为按 Bundle ID 认证，更新助手后沿用已有授权。
      await exec(
        "codesign",
        ["--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID, `-r=${HELPER_DESIGNATED_REQUIREMENT}`, app],
        { timeout: 15_000 },
      );
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!existsSync(executable)) throw error;
      }
      return appBundle;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法编译 macOS 远程桌面助手（需安装 Xcode Command Line Tools）：${detail}`);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  })();

  try {
    return await inFlightHelperBuild;
  } finally {
    inFlightHelperBuild = null;
  }
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseStatePayload(raw: Record<string, unknown>, fallback: HostStateSnapshot): HostStateSnapshot {
  const displaysRaw = Array.isArray(raw.displays) ? raw.displays : null;
  const displays: RdDisplayInfo[] = displaysRaw
    ? displaysRaw
        .map((item): RdDisplayInfo | null => {
          if (!item || typeof item !== "object") return null;
          const rec = item as Record<string, unknown>;
          const id = typeof rec.id === "number" ? Math.max(0, Math.trunc(rec.id)) : 0;
          const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : `显示器`;
          const width = typeof rec.width === "number" && rec.width > 0 ? Math.trunc(rec.width) : 1920;
          const height = typeof rec.height === "number" && rec.height > 0 ? Math.trunc(rec.height) : 1080;
          const scaleFactor =
            typeof rec.scaleFactor === "number" && rec.scaleFactor > 0 ? rec.scaleFactor : 2;
          const primary = Boolean(rec.primary);
          return { id, name, width, height, scaleFactor, primary };
        })
        .filter((d): d is RdDisplayInfo => d !== null)
    : fallback.displays;

  const activeDisplayId =
    typeof raw.activeDisplayId === "number" && raw.activeDisplayId >= 0
      ? Math.trunc(raw.activeDisplayId)
      : (displays[0]?.id ?? fallback.activeDisplayId);

  const permObj =
    raw.permissions && typeof raw.permissions === "object"
      ? (raw.permissions as Record<string, unknown>)
      : null;
  const permissions: RdPermissions = permObj
    ? {
        screenRecording: Boolean(permObj.screenRecording),
        accessibility: Boolean(permObj.accessibility),
      }
    : fallback.permissions;

  const doubleClickMs =
    typeof raw.doubleClickMs === "number" && raw.doubleClickMs > 0
      ? Math.min(5_000, Math.trunc(raw.doubleClickMs))
      : fallback.doubleClickMs;

  return { displays, activeDisplayId, permissions, ...(doubleClickMs !== undefined ? { doubleClickMs } : {}) };
}

function parseClipboardImage(raw: unknown): { w: number; h: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { w, h } = raw as { w?: unknown; h?: unknown };
  if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return undefined;
  return { w: Math.round(w), h: Math.round(h) };
}

function parseClipboardFiles(raw: unknown): HostClipboardFile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: HostClipboardFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.path !== "string" || !rec.path.startsWith("/")) continue;
    files.push({
      path: rec.path,
      name: typeof rec.name === "string" && rec.name ? rec.name : rec.path.split("/").pop() || "file",
      size: typeof rec.size === "number" && rec.size >= 0 ? Math.trunc(rec.size) : 0,
    });
  }
  return files.length > 0 ? files : undefined;
}

function parseCursor(raw: Record<string, unknown>): HostCursorShape | null {
  if (typeof raw.png !== "string") return null;
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    png: raw.png,
    hx: num(raw.hx, 0),
    hy: num(raw.hy, 0),
    w: Math.max(1, num(raw.w, 16)),
    h: Math.max(1, num(raw.h, 16)),
  };
}

export class MacOsRemoteDesktopBridge implements RemoteDesktopHostBridge {
  readonly #home: string;
  #state: HostStateSnapshot = {
    displays: [],
    activeDisplayId: 0,
    permissions: { screenRecording: false, accessibility: false },
  };
  #sockDir: string | null = null;
  #ctrlServer: Server | null = null;
  #videoServer: Server | null = null;
  #ctrlSocket: Socket | null = null;
  #videoSocket: Socket | null = null;
  #child: ChildProcess | null = null;
  #startPromise: Promise<void> | null = null;
  #pendingStateWaiters: Array<(state: HostStateSnapshot) => void> = [];
  readonly #decoder = new BinaryVideoFrameDecoder();
  readonly #videoListeners = new Set<(frame: EncodedVideoFrame) => void>();
  readonly #stateListeners = new Set<(state: HostStateSnapshot) => void>();
  readonly #clipboardListeners = new Set<(text: string, meta?: HostClipboardEvent) => void>();
  readonly #imageWaiters = new Map<string, (data: Buffer | null) => void>();
  #imageSeq = 0;
  readonly #cursorListeners = new Set<(cursor: HostCursorShape) => void>();
  readonly #errorListeners = new Set<(error: string) => void>();
  #closed = false;
  /** 最近一次流选项；助手重启后需要补发。 */
  #streamOptions: HostStreamOptions | null = null;
  /** 同一事件循环 tick 内合并连续鼠标移动，避免 SCTP 突发包向助手套接字灌入陈旧坐标。 */
  #pendingMove: { x: number; y: number } | null = null;
  #moveFlushScheduled = false;
  #lastKeyframeReqAt = 0;
  /** 控制端滚轮累计总量 → 增量（丢包、乱序不丢滚动距离）。 */
  readonly #wheel = new WheelStreamDecoder();
  #videoCounters: HostVideoCounters | null = null;

  constructor(options?: { homeDir?: string }) {
    this.#home = options?.homeDir ?? homedir();
  }

  getStateSnapshot(): HostStateSnapshot {
    return this.#state;
  }

  async warmup(): Promise<void> {
    await buildMacOsRemoteHostHelper(this.#home);
  }

  async ensureStarted(options: {
    quality: RdQuality;
    displayId?: number;
    promptPermissions?: boolean;
  }): Promise<HostStateSnapshot> {
    if (this.#closed) {
      this.#closed = false;
    }
    if (!this.#ctrlSocket) {
      if (!this.#startPromise) {
        this.#startPromise = this.#spawnHelper().finally(() => {
          this.#startPromise = null;
        });
      }
      await this.#startPromise;
      if (this.#streamOptions) this.setStreamOptions(this.#streamOptions);
    }
    return this.configure(options);
  }

  async configure(options: {
    quality: RdQuality;
    displayId?: number;
    promptPermissions?: boolean;
  }): Promise<HostStateSnapshot> {
    const preset = QUALITY_PRESETS[options.quality];
    const waitState = new Promise<HostStateSnapshot>((resolve) => {
      const timer = setTimeout(() => resolve(this.#state), 2_500);
      this.#pendingStateWaiters.push((snap) => {
        clearTimeout(timer);
        resolve(snap);
      });
    });
    this.#lastKeyframeReqAt = 0;
    this.#sendCtrl({
      op: "configure",
      ...(options.displayId !== undefined ? { displayId: options.displayId } : {}),
      maxDimension: preset.maxDimension,
      fps: preset.fps,
      bitrateBps: preset.bitrateBps,
      prompt: Boolean(options.promptPermissions),
    });
    return waitState;
  }

  requestKeyframe(): void {
    const now = Date.now();
    // 建连初期 openSession / ICE connected / control open / PLI 常在数十毫秒内连续触发，合并为一次 IDR 避免突发拥塞。
    if (now - this.#lastKeyframeReqAt < 120) return;
    this.#lastKeyframeReqAt = now;
    this.#sendCtrl({ op: "idr" });
  }

  requestPermissionsPrompt(): void {
    this.#sendCtrl({ op: "perm", prompt: true });
  }

  #flushPendingMove(): void {
    const move = this.#pendingMove;
    if (!move) return;
    this.#pendingMove = null;
    this.#sendCtrl({ op: "mm", x: move.x, y: move.y });
  }

  handleFastInput(msg: FastInputMessage): void {
    if (msg.t === "mm") {
      this.#pendingMove = { x: clampUnit(msg.x), y: clampUnit(msg.y) };
      if (!this.#moveFlushScheduled) {
        this.#moveFlushScheduled = true;
        queueMicrotask(() => {
          this.#moveFlushScheduled = false;
          this.#flushPendingMove();
        });
      }
      return;
    }
    if (msg.t === "wh") {
      const step = this.#wheel.decode(msg);
      if (!step) return;
      this.#flushPendingMove();
      this.#sendCtrl({
        op: "wh",
        dx: step.dx,
        dy: step.dy,
        ...(msg.x !== undefined ? { x: clampUnit(msg.x) } : {}),
        ...(msg.y !== undefined ? { y: clampUnit(msg.y) } : {}),
      });
    }
  }

  handleControlInput(msg: ControlClientMessage): void {
    switch (msg.t) {
      case "mm":
      case "wh":
        this.handleFastInput(msg);
        break;
      case "md":
      case "mu":
        // 点击本身已携带精确按下/抬起坐标，丢弃尚未刷出的旧移动坐标。
        this.#pendingMove = null;
        this.#sendCtrl({
          op: msg.t,
          x: clampUnit(msg.x),
          y: clampUnit(msg.y),
          b: msg.b,
          clicks: msg.clicks ?? 1,
        });
        break;
      case "kd":
      case "ku": {
        this.#flushPendingMove();
        const keyCode = resolveMacKeyCode(msg.code);
        if (keyCode === null) return;
        this.#sendCtrl({
          op: msg.t,
          keyCode,
          ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
          ...(msg.ctrl !== undefined ? { ctrl: msg.ctrl } : {}),
          ...(msg.alt !== undefined ? { alt: msg.alt } : {}),
          ...(msg.shift !== undefined ? { shift: msg.shift } : {}),
          ...(msg.t === "kd" && msg.rep ? { rep: true } : {}),
        });
        break;
      }
      case "txt":
        this.#flushPendingMove();
        if (msg.text) {
          this.#sendCtrl({ op: "txt", text: msg.text.slice(0, 65_536) });
        }
        break;
      case "cb.get":
        this.#sendCtrl({ op: "cb.get" });
        break;
      case "cb.set":
        this.#sendCtrl({ op: "cb.set", text: msg.text.slice(0, CLIPBOARD_MAX_CHARS) });
        break;
      case "idr":
        this.#lastKeyframeReqAt = 0;
        this.requestKeyframe();
        break;
      case "perm":
        this.requestPermissionsPrompt();
        break;
      default:
        break;
    }
  }

  releaseInputs(): void {
    this.#pendingMove = null;
    this.#sendCtrl({ op: "release" });
  }

  setStreamOptions(options: HostStreamOptions): void {
    this.#streamOptions = { ...options };
    this.#lastKeyframeReqAt = 0;
    this.#sendCtrl({
      op: "opts",
      showCursor: options.showCursorInVideo,
      cursorShape: options.cursorShape,
      clipboardWatch: options.clipboardWatch,
    });
  }

  setBitrate(bps: number): void {
    if (!Number.isFinite(bps) || bps <= 0) return;
    this.#sendCtrl({ op: "br", bps: Math.round(bps) });
  }

  setStreamProfile(profile: { maxDimension: number; fps: number; bitrateBps: number }): void {
    if (!(profile.maxDimension > 0) || !(profile.fps > 0) || !(profile.bitrateBps > 0)) return;
    // 复用助手的 configure：不带 displayId 时保持当前显示器，帧率在线更新，分辨率变化才重建编码会话。
    this.#sendCtrl({
      op: "configure",
      maxDimension: Math.round(profile.maxDimension),
      fps: Math.round(profile.fps),
      bitrateBps: Math.round(profile.bitrateBps),
      prompt: false,
    });
  }

  pollVideoCounters(): HostVideoCounters | null {
    this.#sendCtrl({ op: "vstats" });
    return this.#videoCounters;
  }

  requestCursor(): void {
    this.#sendCtrl({ op: "cursor.get" });
  }

  writeClipboardImage(pngBase64: string): void {
    if (!pngBase64) return;
    this.#sendCtrl({ op: "cb.img", png: pngBase64 });
  }

  readClipboardImage(): Promise<Buffer | null> {
    if (!this.#ctrlSocket) return Promise.resolve(null);
    const id = `i${++this.#imageSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#imageWaiters.delete(id)) resolve(null);
      }, CLIPBOARD_IMAGE_TIMEOUT_MS);
      this.#imageWaiters.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.#sendCtrl({ op: "cb.img.get", id });
    });
  }

  subscribeVideo(listener: (frame: EncodedVideoFrame) => void): () => void {
    this.#videoListeners.add(listener);
    return () => {
      this.#videoListeners.delete(listener);
    };
  }

  subscribeState(listener: (state: HostStateSnapshot) => void): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  subscribeClipboard(listener: (text: string, meta?: HostClipboardEvent) => void): () => void {
    this.#clipboardListeners.add(listener);
    return () => {
      this.#clipboardListeners.delete(listener);
    };
  }

  subscribeCursor(listener: (cursor: HostCursorShape) => void): () => void {
    this.#cursorListeners.add(listener);
    return () => {
      this.#cursorListeners.delete(listener);
    };
  }

  subscribeError(listener: (error: string) => void): () => void {
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#sendCtrl({ op: "stop" });
    await this.#teardownSockets();
  }

  #sendCtrl(payload: Record<string, unknown>): void {
    const sock = this.#ctrlSocket;
    if (!sock || sock.destroyed || !sock.writable) return;
    try {
      sock.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // 忽略关闭竞争期的写入异常
    }
  }

  async #spawnHelper(): Promise<void> {
    const appBundle = await buildMacOsRemoteHostHelper(this.#home);
    // macOS Unix domain socket 路径上限 104 字节，放在短路径 0700 目录中
    const sockDir = join("/tmp", `yb-rd-${randomUUID().slice(0, 12)}`);
    await mkdir(sockDir, { recursive: true, mode: 0o700 });
    this.#sockDir = sockDir;
    const ctrlPath = join(sockDir, "c.sock");
    const videoPath = join(sockDir, "v.sock");

    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const readyPromise = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    let ctrlConnected = false;
    let videoConnected = false;
    let readyReceived = false;
    const maybeCompleteReady = () => {
      if (ctrlConnected && videoConnected && readyReceived) {
        resolveReady();
      }
    };

    const ctrlServer = createServer((socket) => {
      if (this.#ctrlSocket) {
        socket.destroy();
        return;
      }
      socket.setNoDelay?.(true);
      this.#ctrlSocket = socket;
      ctrlConnected = true;
      // 剪贴板图片以单行 base64 传回（可达数十 MB）：只在新到的分片里找换行，避免反复扫描整行。
      let lineParts: string[] = [];
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        let rest = chunk;
        let nl = rest.indexOf("\n");
        if (nl === -1) {
          lineParts.push(rest);
          return;
        }
        while (nl !== -1) {
          lineParts.push(rest.slice(0, nl));
          const line = (lineParts.length === 1 ? lineParts[0]! : lineParts.join("")).trim();
          lineParts = [];
          rest = rest.slice(nl + 1);
          if (line) {
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              const ev = msg.ev;
              if (ev === "ready" || ev === "state") {
                this.#state = parseStatePayload(msg, this.#state);
                if (ev === "ready") {
                  readyReceived = true;
                  maybeCompleteReady();
                }
                const waiters = this.#pendingStateWaiters.splice(0);
                for (const w of waiters) w(this.#state);
                for (const listener of this.#stateListeners) listener(this.#state);
              } else if (ev === "cb" && typeof msg.text === "string") {
                const files = parseClipboardFiles(msg.files);
                const image = parseClipboardImage(msg.image);
                const meta: HostClipboardEvent = {
                  ...(msg.auto === true ? { auto: true } : {}),
                  ...(files ? { files } : {}),
                  ...(image ? { image } : {}),
                };
                for (const listener of this.#clipboardListeners) listener(msg.text, meta);
              } else if (ev === "cbimg" && typeof msg.id === "string") {
                const waiter = this.#imageWaiters.get(msg.id);
                if (waiter) {
                  this.#imageWaiters.delete(msg.id);
                  waiter(typeof msg.png === "string" && msg.png ? Buffer.from(msg.png, "base64") : null);
                }
              } else if (ev === "cursor") {
                const cursor = parseCursor(msg);
                if (cursor) {
                  for (const listener of this.#cursorListeners) listener(cursor);
                }
              } else if (ev === "vstats") {
                const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
                this.#videoCounters = {
                  captured: num(msg.captured),
                  busy: num(msg.busy),
                  dropped: num(msg.dropped),
                  encoded: num(msg.encoded),
                };
              } else if (ev === "error" && typeof msg.message === "string") {
                for (const listener of this.#errorListeners) listener(msg.message);
              }
            } catch {
              // 忽略单行解析异常
            }
          }
          nl = rest.indexOf("\n");
        }
        if (rest) lineParts.push(rest);
      });
      socket.on("close", () => {
        if (this.#ctrlSocket === socket) {
          this.#ctrlSocket = null;
          void this.#teardownSockets();
        }
      });
      socket.on("error", () => {});
      maybeCompleteReady();
    });

    const videoServer = createServer((socket) => {
      if (this.#videoSocket) {
        socket.destroy();
        return;
      }
      this.#videoSocket = socket;
      videoConnected = true;
      this.#decoder.reset();
      socket.on("data", (chunk: Buffer) => {
        try {
          this.#decoder.push(chunk, (frame) => {
            for (const listener of this.#videoListeners) {
              listener(frame);
            }
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          for (const listener of this.#errorListeners) listener(detail);
          void this.#teardownSockets();
        }
      });
      socket.on("close", () => {
        if (this.#videoSocket === socket) {
          this.#videoSocket = null;
        }
      });
      socket.on("error", () => {});
      maybeCompleteReady();
    });

    this.#ctrlServer = ctrlServer;
    this.#videoServer = videoServer;

    await Promise.all([
      new Promise<void>((res, rej) => {
        ctrlServer.once("error", rej);
        ctrlServer.listen(ctrlPath, () => res());
      }),
      new Promise<void>((res, rej) => {
        videoServer.once("error", rej);
        videoServer.listen(videoPath, () => res());
      }),
    ]);

    const child = spawn(
      "/usr/bin/open",
      ["-W", "-n", appBundle, "--args", "--ctrl", ctrlPath, "--video", videoPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    this.#child = child;
    let stderrText = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      if (stderrText.length < 2048) stderrText += d;
    });
    child.once("exit", (code) => {
      if (!readyReceived) {
        rejectReady(
          new Error(
            `macOS 远程桌面助手启动失败（退出码 ${code ?? "unknown"}）${stderrText ? `: ${stderrText.trim()}` : ""}`,
          ),
        );
      }
      if (this.#child === child) {
        this.#child = null;
        void this.#teardownSockets();
      }
    });
    child.once("error", (err) => {
      rejectReady(err);
    });

    const timeout = setTimeout(() => {
      rejectReady(new Error("等待 macOS 远程桌面助手连接超时"));
    }, 15_000);
    try {
      await readyPromise;
    } catch (error) {
      await this.#teardownSockets();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #teardownSockets(): Promise<void> {
    for (const waiter of this.#imageWaiters.values()) waiter(null);
    this.#imageWaiters.clear();
    this.#decoder.reset();
    const waiters = this.#pendingStateWaiters.splice(0);
    for (const w of waiters) w(this.#state);

    if (this.#ctrlSocket) {
      this.#ctrlSocket.destroy();
      this.#ctrlSocket = null;
    }
    if (this.#videoSocket) {
      this.#videoSocket.destroy();
      this.#videoSocket = null;
    }
    if (this.#ctrlServer) {
      const s = this.#ctrlServer;
      this.#ctrlServer = null;
      await new Promise<void>((res) => s.close(() => res()));
    }
    if (this.#videoServer) {
      const s = this.#videoServer;
      this.#videoServer = null;
      await new Promise<void>((res) => s.close(() => res()));
    }
    if (this.#child) {
      const c = this.#child;
      this.#child = null;
      try {
        c.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    if (this.#sockDir) {
      const dir = this.#sockDir;
      this.#sockDir = null;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
