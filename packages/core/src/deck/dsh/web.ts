import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 管理 `dsh --profile web` 进程：指挥台标签页里嵌入的就是它提供的 Web 界面。
 * 懒启动；端口交给系统挑（--port 0），从它打印的地址里读出来；进程退出后下次请求重启。
 */
export type DshWebState =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; url: string }
  | { state: "error"; error: string };

export interface DshWebOptions {
  nodePath: string;
  /** dsh 可执行入口（sidecar 里 node_modules/@deepseek-ai/dsh/lib/bin.js）。 */
  binPath: string;
  cwd: string;
  /** dsh 进程的完整环境（DSH_HOME、PATH、各供应商密钥…）。 */
  env: () => Promise<Record<string, string>>;
  /** 要叠加的补丁文件。 */
  patches: () => Promise<string[]>;
  startTimeoutMs?: number;
  /**
   * 就绪之后进程意外退出时自动拉起（DSH 的定时任务只在它运行时才会触发）。
   * 启动阶段就失败的不重启，错误要让页面看到。超过 maxRestarts 次连续失败后放弃并报错。
   */
  keepAlive?: { maxRestarts: number; baseDelayMs: number; stableMs: number };
  /** 测试注入。 */
  spawnImpl?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
}

const STDERR_TAIL = 1_200;
/** `dsh web: http://127.0.0.1:PORT/?token=…`。 */
const URL_PATTERN = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u;

export class DshWeb {
  readonly #options: DshWebOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #state: DshWebState = { state: "stopped" };
  #stderr = "";
  #closed = false;
  #readyAt = 0;
  #restarts = 0;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DshWebOptions) {
    this.#options = options;
  }

  get state(): DshWebState {
    return this.#state;
  }

  /**
   * 确保进程在启动或已就绪；立即返回当前状态（不阻塞到就绪），调用方轮询即可。
   * 出错后不会自动重启（否则轮询的页面永远看不到错误）；`retry` 为 true 才重启。
   */
  ensureStarted(retry = false): DshWebState {
    if (this.#closed) return { state: "error", error: "DSH 已关闭" };
    if (this.#state.state === "starting" || this.#state.state === "ready") return this.#state;
    if (this.#state.state === "error" && !retry) return this.#state;
    this.#state = { state: "starting" };
    void this.#start();
    return this.#state;
  }

  /** 杀掉并立刻重新启动（登录后让界面加载新的模型路由）。 */
  restart(): DshWebState {
    if (this.#restartTimer !== null) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#restarts = 0;
    const child = this.#child;
    this.#child = null;
    this.#state = { state: "stopped" };
    if (child !== null && child.exitCode === null && !child.killed) child.kill("SIGTERM");
    return this.ensureStarted(true);
  }

  stop(): void {
    this.#closed = true;
    if (this.#restartTimer !== null) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#child;
    this.#child = null;
    this.#state = { state: "stopped" };
    if (child !== null && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  async #start(): Promise<void> {
    try {
      const [env, patches] = await Promise.all([this.#options.env(), this.#options.patches()]);
      // 启动器参数（--profile / --patch）必须在 app 参数（--no-open / --port）之前。
      const args = [
        this.#options.binPath,
        "--profile",
        "web",
        ...patches.flatMap((path) => ["--patch", path]),
        "--no-open",
        "--port",
        "0",
      ];
      const spawnImpl = this.#options.spawnImpl ?? (spawn as NonNullable<DshWebOptions["spawnImpl"]>);
      this.#stderr = "";
      const child = spawnImpl(this.#options.nodePath, args, { cwd: this.#options.cwd, env: env as NodeJS.ProcessEnv });
      this.#child = child;
      let buffer = "";
      const onData = (chunk: string): void => {
        if (this.#child !== child || this.#state.state !== "starting") return;
        buffer = (buffer + chunk).slice(-4_000);
        const url = URL_PATTERN.exec(buffer)?.[0];
        if (url !== undefined) {
          this.#state = { state: "ready", url };
          this.#readyAt = Date.now();
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL);
        onData(chunk);
      });
      const fail = (reason: string): void => {
        if (this.#child !== child) return;
        this.#child = null;
        const wasReady = this.#state.state === "ready";
        const tail = this.#stderr.trim();
        const message = `DSH 进程已退出（${reason}）${tail === "" ? "" : `：${tail}`}`;
        const keep = this.#options.keepAlive;
        if (wasReady && keep !== undefined && !this.#closed) {
          // 跑得够久就当上次稳定，重置连续失败计数。
          if (Date.now() - this.#readyAt >= keep.stableMs) this.#restarts = 0;
          if (this.#restarts < keep.maxRestarts) {
            const delay = Math.min(30_000, keep.baseDelayMs * 2 ** this.#restarts);
            this.#restarts += 1;
            this.#state = { state: "starting" };
            this.#restartTimer = setTimeout(() => {
              this.#restartTimer = null;
              if (!this.#closed && this.#state.state === "starting") void this.#start();
            }, delay);
            this.#restartTimer.unref?.();
            return;
          }
        }
        this.#state = { state: "error", error: message };
      };
      child.on("error", (error) => fail(error.message));
      child.on("exit", (code, signal) => fail(`退出码 ${code ?? "?"}${signal ? `，信号 ${signal}` : ""}`));
      const timer = setTimeout(() => {
        if (this.#child === child && this.#state.state === "starting") {
          this.#state = { state: "error", error: "DSH 启动超时（没有等到它打印访问地址）" };
          this.#child = null;
          if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
        }
      }, this.#options.startTimeoutMs ?? 60_000);
      timer.unref?.();
    } catch (error) {
      this.#state = { state: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}
