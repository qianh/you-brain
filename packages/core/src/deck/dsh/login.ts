import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 订阅（OAuth）登录：DSH 后端支持，但它的 Web 界面没有启动入口，所以由 daemon 驱动
 * sidecar 里的登录引擎（login-oauth.mjs），界面上点一下即可，用户不碰终端。
 */
export const DSH_LOGIN_PROVIDERS = [
  { id: "anthropic", label: "Claude（Pro / Max）" },
  { id: "openai-codex", label: "ChatGPT（Plus / Pro）" },
  { id: "xai", label: "Grok（SuperGrok / X Premium）" },
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "kimi-coding", label: "Kimi Code" },
] as const;

export type DshLoginProviderId = (typeof DSH_LOGIN_PROVIDERS)[number]["id"];

export const DSH_LOGIN_PROVIDER_IDS = DSH_LOGIN_PROVIDERS.map((provider) => provider.id) as [
  DshLoginProviderId,
  ...DshLoginProviderId[],
];

export interface DshLoginView {
  id: DshLoginProviderId;
  label: string;
  /** 凭据库里已有该登录。 */
  signedIn: boolean;
  /** waiting = 等用户在浏览器里授权（url 可点；设备验证码流程给 deviceCode）。 */
  state: "idle" | "waiting" | "error";
  url?: string;
  /** 设备验证码流程（Grok、GitHub Copilot、Kimi Code）：用户在 verificationUri 输入 userCode。 */
  deviceCode?: { userCode: string; verificationUri: string };
  error?: string;
}

export interface DshLoginOptions {
  nodePath: string;
  /** login-oauth.mjs 的路径。 */
  script: string;
  dshHome: string;
  /** 子进程环境（PATH、HOME 等），不含任何密钥。 */
  env: () => Record<string, string>;
  /** 登录成功后调用（用来重启 dsh 界面，让它加载新路由）。 */
  onSignedIn?: (id: DshLoginProviderId) => void;
  timeoutMs?: number;
  spawnImpl?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  url?: string;
  deviceCode?: { userCode: string; verificationUri: string };
}

const KILL_GRACE_MS = 2_000;

export class DshLogin {
  readonly #options: DshLoginOptions;
  readonly #running = new Map<DshLoginProviderId, Running>();
  readonly #errors = new Map<DshLoginProviderId, string>();

  constructor(options: DshLoginOptions) {
    this.#options = options;
  }

  async view(): Promise<DshLoginView[]> {
    const text = await readFile(join(this.#options.dshHome, ".credentials.yaml"), "utf8").catch(() => "");
    return DSH_LOGIN_PROVIDERS.map((provider): DshLoginView => {
      const running = this.#running.get(provider.id);
      const error = this.#errors.get(provider.id);
      const base = { id: provider.id, label: provider.label, signedIn: text.includes(`llm-pi-ai/${provider.id}:`) };
      if (running) {
        return {
          ...base,
          state: "waiting",
          ...(running.url !== undefined ? { url: running.url } : {}),
          ...(running.deviceCode !== undefined ? { deviceCode: running.deviceCode } : {}),
        };
      }
      if (error !== undefined) return { ...base, state: "error", error };
      return { ...base, state: "idle" };
    });
  }

  /** 发起登录：立即返回，授权地址通过 view() 取（引擎打印后才有）。 */
  start(id: DshLoginProviderId): void {
    if (this.#running.has(id)) return;
    this.#errors.delete(id);
    const child = this.#spawn(["login", id]);
    const running: Running = { child };
    this.#running.set(id, running);
    let buffer = "";
    let settled = false;
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 已被取消（或被新一次登录取代）的流程，它的退出事件不能再改状态。
      if (this.#running.get(id) !== running) return;
      this.#running.delete(id);
      if (error !== undefined) this.#errors.set(id, error);
      else this.#options.onSignedIn?.(id);
    };
    const timer = setTimeout(() => {
      finish("授权超时（5 分钟内没有完成）");
      this.#kill(child);
    }, this.#options.timeoutMs ?? 6 * 60_000);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at === -1) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let event: { event?: string; url?: string; message?: string; userCode?: string; verificationUri?: string };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          continue;
        }
        if (event.event === "auth_url" && typeof event.url === "string") running.url = event.url;
        else if (event.event === "device_code" && typeof event.userCode === "string" && typeof event.verificationUri === "string") {
          running.deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri };
        }
        else if (event.event === "done") finish();
        else if (event.event === "error") finish(event.message ?? "登录失败");
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-600);
    });
    child.on("error", (error) => finish(error.message));
    child.on("exit", (code) => {
      // 正常路径下 done / error 事件已先到；没有事件就退出的算失败。
      finish(code === 0 ? "登录进程没有返回结果" : `登录进程异常退出（${code ?? "?"}）${stderr.trim() === "" ? "" : `：${stderr.trim()}`}`);
    });
  }

  cancel(id: DshLoginProviderId): void {
    const running = this.#running.get(id);
    if (!running) return;
    this.#running.delete(id);
    this.#errors.delete(id);
    this.#kill(running.child);
  }

  /** 登出：删除凭据库里的记录。 */
  async logout(id: DshLoginProviderId): Promise<void> {
    this.cancel(id);
    this.#errors.delete(id);
    await new Promise<void>((resolve, reject) => {
      const child = this.#spawn(["logout", id]);
      let failure = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const line = chunk.split("\n").find((entry) => entry.includes('"error"'));
        if (line) failure = line;
      });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(failure !== "" ? failure : `登出失败（${code ?? "?"}）`))));
    });
  }

  stop(): void {
    for (const running of this.#running.values()) this.#kill(running.child);
    this.#running.clear();
  }

  #spawn(args: string[]): ChildProcessWithoutNullStreams {
    const spawnImpl = this.#options.spawnImpl ?? (spawn as NonNullable<DshLoginOptions["spawnImpl"]>);
    return spawnImpl(this.#options.nodePath, [this.#options.script, ...args], {
      env: { ...this.#options.env(), DSH_HOME: this.#options.dshHome },
    });
  }

  #kill(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    force.unref?.();
  }
}
