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
import {
  QUALITY_PRESETS,
  type ControlClientMessage,
  type EncodedVideoFrame,
  type FastInputMessage,
  type HostStateSnapshot,
} from "./types.js";

const exec = promisify(execFile);

const VIDEO_MAGIC = 0x55425244; // "UBRD"
const VIDEO_HEADER_BYTES = 24;
const MAX_VIDEO_FRAME_BYTES = 16 * 1024 * 1024;

export interface RemoteDesktopHostBridge {
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
  subscribeVideo(listener: (frame: EncodedVideoFrame) => void): () => void;
  subscribeState(listener: (state: HostStateSnapshot) => void): () => void;
  subscribeClipboard(listener: (text: string) => void): () => void;
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
      await exec("codesign", ["--force", "--sign", "-", app], { timeout: 15_000 });
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

  return { displays, activeDisplayId, permissions };
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
  readonly #clipboardListeners = new Set<(text: string) => void>();
  readonly #errorListeners = new Set<(error: string) => void>();
  #closed = false;

  constructor(options?: { homeDir?: string }) {
    this.#home = options?.homeDir ?? homedir();
  }

  getStateSnapshot(): HostStateSnapshot {
    return this.#state;
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
    this.#sendCtrl({ op: "idr" });
  }

  requestPermissionsPrompt(): void {
    this.#sendCtrl({ op: "perm", prompt: true });
  }

  handleFastInput(msg: FastInputMessage): void {
    if (msg.t === "mm") {
      this.#sendCtrl({ op: "mm", x: clampUnit(msg.x), y: clampUnit(msg.y) });
      return;
    }
    if (msg.t === "wh") {
      this.#sendCtrl({
        op: "wh",
        dx: Number.isFinite(msg.dx) ? msg.dx : 0,
        dy: Number.isFinite(msg.dy) ? msg.dy : 0,
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
        const keyCode = resolveMacKeyCode(msg.code);
        if (keyCode === null) return;
        this.#sendCtrl({
          op: msg.t,
          keyCode,
          ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
          ...(msg.ctrl !== undefined ? { ctrl: msg.ctrl } : {}),
          ...(msg.alt !== undefined ? { alt: msg.alt } : {}),
          ...(msg.shift !== undefined ? { shift: msg.shift } : {}),
        });
        break;
      }
      case "txt":
        if (msg.text) {
          this.#sendCtrl({ op: "txt", text: msg.text.slice(0, 4096) });
        }
        break;
      case "cb.get":
        this.#sendCtrl({ op: "cb.get" });
        break;
      case "cb.set":
        this.#sendCtrl({ op: "cb.set", text: msg.text.slice(0, 262_144) });
        break;
      case "idr":
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
    this.#sendCtrl({ op: "release" });
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

  subscribeClipboard(listener: (text: string) => void): () => void {
    this.#clipboardListeners.add(listener);
    return () => {
      this.#clipboardListeners.delete(listener);
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
      let lineBuf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        lineBuf += chunk;
        let nl = lineBuf.indexOf("\n");
        while (nl !== -1) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
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
                for (const listener of this.#clipboardListeners) listener(msg.text);
              } else if (ev === "error" && typeof msg.message === "string") {
                for (const listener of this.#errorListeners) listener(msg.message);
              }
            } catch {
              // 忽略单行解析异常
            }
          }
          nl = lineBuf.indexOf("\n");
        }
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
