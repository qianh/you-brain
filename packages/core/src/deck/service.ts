import type { LlmProvider } from "@you-brain/protocol";

import type { SearchProvider } from "../auth/search-secrets.js";
import type { DshLoginProviderId, DshLoginView } from "./dsh/login.js";
import { DshRuntime, type DshRuntimeOptions } from "./dsh/runtime.js";
import type { DshWebState } from "./dsh/web.js";
import { Tty7 } from "./tty7.js";
import {
  GUI_APPS,
  accessibilityGranted,
  dispatchToGuiApp,
  guiAppById,
  guiAppStatus,
  recoverGuiAppReplies,
  type GuiAppStatus,
} from "./gui-bridge.js";

/**
 * 指挥台（ADR-0003）：界面、对话、主控、周期任务都由 DeepSeek Harness（dsh）承担，
 * 这里只做 daemon 必须做的事：托管 dsh 进程、订阅登录、给 dsh 的插件提供 GUI App 桥。
 */
export interface DeckServiceOptions {
  dataDir: string;
  homeDir: string;
  /** dsh 与 CLI 子进程的查找与运行环境（daemon 传它的 #env；缺省用 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 设置里的各供应商 Key 经这里交给 dsh 做环境层凭据（daemon 传钥匙串读取）。 */
  getApiKey?: (provider: LlmProvider) => string | null | undefined | Promise<string | null | undefined>;
  /** 设置里的 LLM 选择（provider + 地址）；选了 magpie 时指挥台照它挂网关路由。 */
  getLlmConfig?: () => { provider: LlmProvider; baseUrl: string } | Promise<{ provider: LlmProvider; baseUrl: string }>;
  /** 第三方搜索服务（Exa）的 Key，有才给 dsh 挂搜索 MCP。 */
  getSearchKey?: (provider: SearchProvider) => string | null | undefined | Promise<string | null | undefined>;
  /** false 时不在启动后预热 dsh（测试用）。 */
  warmDsh?: boolean;
  /** GUI App 桥的实现（缺省用 macOS 辅助功能 + 采集适配器）；测试注入。 */
  guiBridge?: {
    status(appId: string): Promise<GuiAppStatus>;
    dispatch(appId: string, prompt: string): Promise<{ sentAtMs: number }>;
    replies(appId: string, sinceMs: number): Promise<string[]>;
  };
  /** tty7 会话桥的实现；测试注入。 */
  tty7?: Tty7;
  dsh?: {
    runtime?: Pick<DshRuntime, "close" | "webState" | "loginView" | "loginAction"> & Partial<Pick<DshRuntime, "refresh">>;
    sidecarDir?: string;
    nodePath?: string;
    mcpLaunch?: DshRuntimeOptions["mcpLaunch"];
  };
}

/** 启动后等这么久再拉起 dsh，避开启动高峰。 */
const DSH_WARM_DELAY_MS = 3_000;

export class DeckService {
  readonly #options: DeckServiceOptions;
  readonly #dsh: Pick<DshRuntime, "close" | "webState" | "loginView" | "loginAction"> &
    Partial<Pick<DshRuntime, "refresh">>;
  #stopped = false;
  /** tty7 会话桥（ADR-0004）：与 dsh 无关，dsh 没起来也能用。 */
  readonly tty7: Tty7;

  constructor(options: DeckServiceOptions) {
    this.#options = options;
    this.tty7 = options.tty7 ?? new Tty7({ env: options.env });
    this.#dsh =
      options.dsh?.runtime ??
      new DshRuntime({
        dataDir: options.dataDir,
        homeDir: options.homeDir,
        env: options.env,
        getApiKey: options.getApiKey,
        getLlmConfig: options.getLlmConfig,
        getSearchKey: options.getSearchKey,
        sidecarDir: options.dsh?.sidecarDir,
        nodePath: options.dsh?.nodePath ?? options.env?.YOU_BRAIN_NODE24,
        mcpLaunch: options.dsh?.mcpLaunch,
      });
  }

  stop(): void {
    this.#stopped = true;
    void this.#dsh.close().catch(() => undefined);
  }

  /**
   * 启动后在后台拉起 dsh（不等用户点开指挥台）：它的定时任务只在运行时才会触发。
   * 前置条件不满足（没有 Node、没装依赖）时静默跳过，页面里仍会显示原因。
   */
  warmDsh(): void {
    if (this.#options.warmDsh === false) return;
    const timer = setTimeout(() => {
      if (this.#stopped) return;
      void this.#dsh.webState().catch(() => undefined);
    }, DSH_WARM_DELAY_MS);
    timer.unref?.();
  }

  /** 嵌入指挥台页面的 dsh Web 界面：启动（若未运行）并返回状态；retry 才会重启出错的进程。 */
  async dshWeb(retry = false): Promise<DshWebState> {
    return this.#dsh.webState(retry);
  }

  /** 搜索或模型设置变了：让 dsh 重载补丁。 */
  refresh(): void {
    this.#dsh.refresh?.();
  }

  async dshLogin(): Promise<DshLoginView[]> {
    return this.#dsh.loginView();
  }

  async dshLoginAction(action: "start" | "cancel" | "logout", provider: DshLoginProviderId): Promise<DshLoginView[]> {
    return this.#dsh.loginAction(action, provider);
  }

  /**
   * GUI App 桥（ADR-0002）：给 dsh 里的 u-brain-bridge 插件回调。投递和回收仍在 daemon 里做——
   * 辅助功能权限是授给 U-Brain 的，不能让 dsh 子进程直接去操作别的 App。
   */
  async bridgeApps(): Promise<Array<GuiAppStatus & { recoverable: boolean }>> {
    let accessibility: Promise<boolean> | undefined;
    const shared = (): Promise<boolean> => (accessibility ??= accessibilityGranted());
    return Promise.all(
      GUI_APPS.map(async (app) => ({
        ...(this.#options.guiBridge ? await this.#options.guiBridge.status(app.id) : await guiAppStatus(app, shared)),
        recoverable: app.recoverable,
      })),
    );
  }

  async bridgeSend(appId: string, prompt: string): Promise<{ sentAtMs: number; recoverable: boolean }> {
    const app = guiAppById(appId);
    if (!app) throw new Error(`未知 GUI App：${appId}`);
    if (prompt.trim() === "") throw new Error("投递的内容不能为空");
    const sent = this.#options.guiBridge ? await this.#options.guiBridge.dispatch(app.id, prompt) : await dispatchToGuiApp(app, prompt);
    return { sentAtMs: sent.sentAtMs, recoverable: app.recoverable };
  }

  async bridgeReplies(appId: string, sinceMs: number): Promise<string[]> {
    const app = guiAppById(appId);
    if (!app) throw new Error(`未知 GUI App：${appId}`);
    if (this.#options.guiBridge) return this.#options.guiBridge.replies(app.id, sinceMs);
    return recoverGuiAppReplies(app, sinceMs, this.#options.homeDir);
  }
}
