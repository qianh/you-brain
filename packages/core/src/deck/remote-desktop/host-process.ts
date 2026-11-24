/**
 * 远程桌面宿主独立进程。
 *
 * WebRTC（SRTP 加密、RTP 打包、SCTP 数据通道）与输入转发都跑在 JS 事件循环上。
 * daemon 主循环承担索引、同步、HTTP 等大量工作，偶发数百毫秒的阻塞会直接表现为
 * 鼠标卡顿与画面停顿。把宿主放进专用子进程后，媒体与输入只和本进程的事件循环竞争。
 *
 * 父子进程走 stdio JSON 行协议：请求 `{id, method, params}`，响应 `{id, ok, result|error}`，
 * 事件 `{ev: "ice" | "state", ...}`。
 */
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type {
  IceServerEntry,
  RdCloseArgs,
  RdIceArgs,
  RdIceCandidate,
  RdOpenArgs,
  RdOpenResult,
} from "@you-brain/protocol";

import { usesVendorModules } from "../../native/resolver.js";
import { buildMacOsRemoteHostHelper } from "./host-macos.js";
import { RemoteDesktopHostManager, type RemoteDesktopPort } from "./session-manager.js";
import { DEFAULT_CLIENT_ICE_SERVERS, type RemoteDesktopSignalingEvents } from "./types.js";

type StatePayload = Parameters<RemoteDesktopSignalingEvents["onState"]>[2];

type HostRequest =
  | { id: number; method: "open"; params: { from: string; args: RdOpenArgs; iceServers: IceServerEntry[] } }
  | { id: number; method: "ice"; params: { from: string; args: RdIceArgs } }
  | { id: number; method: "close"; params: { from: string; args: RdCloseArgs } }
  | { id: number; method: "closeAll"; params: { reason?: string } }
  | { id: number; method: "shutdown"; params?: undefined };

type HostEvent =
  | { ev: "ice"; to: string; sessionId: string; candidates: RdIceCandidate[] }
  | { ev: "state"; to: string; sessionId: string; payload: StatePayload };

type HostResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CRASH_MESSAGE = "远程桌面宿主进程异常退出，请重新连接";

export function rdHostCommand(bun = "bun", execPath = process.execPath): string[] {
  if (usesVendorModules(execPath)) return [execPath, "rd-host"];
  return [bun, fileURLToPath(new URL("./host-process.ts", import.meta.url))];
}

/** 子进程入口：在本进程内运行完整的远程桌面宿主。 */
export async function serveRemoteDesktopHost(): Promise<void> {
  // stdout 只承载协议帧，日志一律走 stderr。
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  console.info = console.log;

  const write = (frame: HostEvent | HostResponse) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  const manager = new RemoteDesktopHostManager({
    supported: process.platform === "darwin",
    getIceServers: () => DEFAULT_CLIENT_ICE_SERVERS,
  });
  manager.setSignalingEvents({
    onIce: (to, sessionId, candidates) => write({ ev: "ice", to, sessionId, candidates }),
    onState: (to, sessionId, payload) => write({ ev: "state", to, sessionId, payload }),
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= manager.closeAll().catch(() => undefined);
    return shutdownPromise;
  };
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  const handle = async (request: HostRequest): Promise<unknown> => {
    switch (request.method) {
      case "open":
        return manager.openSession(request.params.from, request.params.args, request.params.iceServers);
      case "ice":
        return manager.addIceCandidates(request.params.from, request.params.args);
      case "close":
        return manager.closeSession(request.params.from, request.params.args);
      case "closeAll":
        await manager.closeAll(request.params.reason);
        return { ok: true };
      case "shutdown":
        await shutdown();
        return { ok: true };
      default:
        throw new Error(`未知的远程桌面宿主请求：${(request as { method?: string }).method}`);
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let request: HostRequest;
      try {
        request = JSON.parse(line) as HostRequest;
      } catch {
        continue;
      }
      // 请求并发处理：建连耗时不应阻塞同一时刻的 ICE 候选与关闭请求。
      void handle(request).then(
        (result) => write({ id: request.id, ok: true, result }),
        (error: unknown) =>
          write({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      if (request.method === "shutdown") {
        await shutdown();
        // 让响应帧写出后再退出。
        await new Promise((resolve) => setTimeout(resolve, 20));
        return;
      }
    }
  }
  // 父进程退出（stdin 关闭）：务必关掉原生助手，避免屏幕采集残留。
  await shutdown();
}

export interface ProcessRemoteDesktopPortOptions {
  supported: boolean;
  getIceServers: () => Promise<IceServerEntry[]> | IceServerEntry[];
  command?: string[];
  /** 无会话多久后结束子进程。 */
  idleExitMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** daemon 侧：把远程桌面宿主请求转发到专用子进程，子进程崩溃时自动通知对端并在下次请求时重启。 */
export class ProcessRemoteDesktopPort implements RemoteDesktopPort {
  readonly supported: boolean;
  readonly #getIceServers: () => Promise<IceServerEntry[]> | IceServerEntry[];
  readonly #command: string[];
  readonly #idleExitMs: number;
  #events: RemoteDesktopSignalingEvents | null = null;
  #child: ReturnType<typeof Bun.spawn> | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  /** sessionId → 对端设备，用于子进程崩溃时通知对端会话已关闭。 */
  readonly #sessions = new Map<string, string>();
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #warming: Promise<unknown> | null = null;

  constructor(options: ProcessRemoteDesktopPortOptions) {
    this.supported = options.supported;
    this.#getIceServers = options.getIceServers;
    this.#command = options.command ?? rdHostCommand();
    this.#idleExitMs = options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
  }

  setSignalingEvents(events: RemoteDesktopSignalingEvents | null): void {
    this.#events = events;
  }

  /** 预编译原生助手即可；子进程按需启动，空闲时不占内存。 */
  warmup(): void {
    if (!this.supported || this.#warming) return;
    this.#warming = buildMacOsRemoteHostHelper(homedir())
      .catch(() => undefined)
      .finally(() => {
        this.#warming = null;
      });
  }

  async openSession(fromDeviceId: string, args: RdOpenArgs): Promise<RdOpenResult> {
    if (!this.supported) throw new Error("当前设备不支持远程桌面宿主");
    const iceServers = await Promise.resolve()
      .then(() => this.#getIceServers())
      .catch(() => DEFAULT_CLIENT_ICE_SERVERS);
    const result = (await this.#request("open", { from: fromDeviceId, args, iceServers })) as RdOpenResult;
    this.#sessions.set(result.sessionId, fromDeviceId);
    this.#refreshIdle();
    return result;
  }

  async addIceCandidates(fromDeviceId: string, args: RdIceArgs): Promise<{ ok: true }> {
    if (!this.#child) return { ok: true };
    await this.#request("ice", { from: fromDeviceId, args });
    return { ok: true };
  }

  async closeSession(fromDeviceId: string, args: RdCloseArgs): Promise<{ ok: true }> {
    if (!this.#child) return { ok: true };
    await this.#request("close", { from: fromDeviceId, args });
    if (this.#sessions.get(args.sessionId) === fromDeviceId) this.#sessions.delete(args.sessionId);
    this.#refreshIdle();
    return { ok: true };
  }

  async closeAll(reason?: string): Promise<void> {
    if (!this.#child) return;
    await this.#request("closeAll", reason !== undefined ? { reason } : {}).catch(() => undefined);
    this.#sessions.clear();
    this.#refreshIdle();
  }

  #ensureChild(): ReturnType<typeof Bun.spawn> {
    if (this.#child) return this.#child;
    const child = Bun.spawn(this.#command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: process.env,
    });
    this.#child = child;
    void this.#readFrames(child);
    void child.exited.then(() => this.#onChildExit(child));
    return child;
  }

  async #readFrames(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stdout = child.stdout;
    if (!stdout || typeof stdout === "number") return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line) this.#onFrame(line);
        }
      }
    } catch {
      // 子进程退出时由 #onChildExit 统一收尾
    }
  }

  #onFrame(line: string): void {
    let frame: HostEvent | HostResponse;
    try {
      frame = JSON.parse(line) as HostEvent | HostResponse;
    } catch {
      return;
    }
    if ("ev" in frame) {
      if (frame.ev === "ice") {
        this.#events?.onIce(frame.to, frame.sessionId, frame.candidates);
      } else if (frame.ev === "state") {
        if (frame.payload.state === "closed") {
          this.#sessions.delete(frame.sessionId);
          this.#refreshIdle();
        }
        this.#events?.onState(frame.to, frame.sessionId, frame.payload);
      }
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error));
  }

  #onChildExit(child: ReturnType<typeof Bun.spawn>): void {
    if (this.#child !== child) return;
    this.#child = null;
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(CRASH_MESSAGE));
      this.#pending.delete(id);
    }
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    for (const [sessionId, peer] of sessions) {
      this.#events?.onState(peer, sessionId, { state: "closed", error: CRASH_MESSAGE });
    }
  }

  #request(method: HostRequest["method"], params: unknown): Promise<unknown> {
    const child = this.#ensureChild();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("远程桌面宿主进程响应超时"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        const stdin = child.stdin;
        if (!stdin || typeof stdin === "number") throw new Error("远程桌面宿主进程不可写");
        stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        stdin.flush();
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #refreshIdle(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (!this.#child || this.#sessions.size > 0 || this.#idleExitMs <= 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#sessions.size > 0 || !this.#child) return;
      void this.#request("shutdown", undefined)
        .catch(() => undefined)
        .finally(() => {
          const child = this.#child;
          if (child && this.#sessions.size === 0) {
            const stdin = child.stdin;
            if (stdin && typeof stdin !== "number") void Promise.resolve(stdin.end()).catch(() => undefined);
            setTimeout(() => {
              if (child.exitCode === null) child.kill();
            }, 5_000).unref?.();
          }
        });
    }, this.#idleExitMs);
    this.#idleTimer.unref?.();
  }
}

if (import.meta.main) {
  void serveRemoteDesktopHost().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
