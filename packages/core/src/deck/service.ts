import type { LlmProvider } from "@you-brain/protocol";

import { join } from "node:path";

import type { SearchProvider } from "../auth/search-secrets.js";
import type { SecretStore } from "../auth/secret-store.js";
import type { LlmBackend } from "../llm/types.js";
import type { DshLoginProviderId, DshLoginView } from "./dsh/login.js";
import { DshRuntime, type DshRuntimeOptions } from "./dsh/runtime.js";
import type { DshWebState } from "./dsh/web.js";
import { ActivityMonitor } from "./activity.js";
import { MuseDeckRuntime } from "./muse/runtime.js";
import { summarizeNotice } from "./notice-summary.js";
import {
  SessionNoticeWatcher,
  type SessionNoticeDismissInput,
  type SessionNoticeList,
} from "./session-notices.js";
import type { DeviceIdentity } from "../dispatch/identity.js";
import { startT3Proxy, type T3Proxy } from "./t3/proxy.js";
import { TelegramBridge, type TelegramDispatchPort, type TelegramFetch } from "./telegram/index.js";
import { Tty7, type Tty7SessionsView } from "./tty7.js";
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
  /** 终端会话提醒的总开关（读偏好）；缺省视为开。 */
  noticesEnabled?: () => Promise<boolean>;
  /** 产生了新的会话提醒（daemon 借此通知订阅者）。 */
  onNotices?: () => void;
  /** 当前可用的模型；有就用它把提醒正文写成分析后的结论和建议，没有就用会话自报的状态。 */
  noticeLlm?: () => Promise<Pick<LlmBackend, "complete"> | null>;
  /** Telegram 桥的 Bot Token 存储（daemon 传钥匙串）；不传就不启用 Telegram 桥。 */
  telegramToken?: SecretStore;
  /** Telegram 中转的设备密钥存储；不传就不能用中转。 */
  telegramRelayKey?: SecretStore;
  /** Telegram 中转入网后的设备专属令牌存储；优先于 telegramRelayKey。 */
  telegramRelayToken?: SecretStore;
  /** 跨设备派活中枢（由 daemon 创建后注入）。 */
  dispatch?: TelegramDispatchPort;
  /** 跨设备派活本机身份（Ed25519 密钥对）。 */
  dispatchIdentity?: DeviceIdentity;
  /** 跨设备派活与中转共用的稳定设备 ID。 */
  deviceId?: string;
  /** Telegram 桥状态变了（连接、绑定）。 */
  onTelegram?: () => void;
  telegramFetch?: TelegramFetch;
  dsh?: {
    runtime?: Pick<DshRuntime, "close" | "webState" | "loginView" | "loginAction"> & Partial<Pick<DshRuntime, "refresh">>;
    sidecarDir?: string;
    nodePath?: string;
    mcpLaunch?: DshRuntimeOptions["mcpLaunch"];
  };
}

/** 启动后等这么久再拉起 dsh，避开启动高峰。 */
const DSH_WARM_DELAY_MS = 3_000;
/** 提醒分析读屏幕的行数与模型调用超时。 */
const NOTICE_SCREEN_LINES = 150;
const NOTICE_SUMMARY_TIMEOUT_MS = 40_000;
/** 同一时刻最多保留 8 个 T3 转发，超出时淘汰最久未使用的。 */
const MAX_T3_PROXIES = 8;

function t3ProxyKey(upstream: string): string {
  try {
    return `${new URL(upstream).origin}/`;
  } catch {
    return upstream;
  }
}

export class DeckService {
  readonly #options: DeckServiceOptions;
  readonly #dsh: Pick<DshRuntime, "close" | "webState" | "loginView" | "loginAction"> &
    Partial<Pick<DshRuntime, "refresh">>;
  #stopped = false;
  /** T3 转发池（ADR-0004 / M6）：按上游地址复用，最多保留 8 个，用于多端点独立转发与 Cookie 隔离。 */
  readonly #t3Proxies = new Map<string, { proxy: T3Proxy; lastUsed: number }>();
  #t3UseSeq = 0;
  /** tty7 会话桥（ADR-0004）：与 dsh 无关，dsh 没起来也能用。 */
  readonly tty7: Tty7;
  /** 终端会话提醒：盯着 tty7 会话状态，工作中 → 等你回复/已完成时记一条。 */
  readonly notices: SessionNoticeWatcher;
  /** 终端活动监视：没有 hooks 状态的会话（任意 AI CLI、普通脚本）按进程活动判断是否在执行。 */
  readonly activity: ActivityMonitor;
  /** Muse SDK 会话桥：配对、主对话同步与独立子会话。 */
  readonly muse: MuseDeckRuntime;
  /** Telegram 桥：把「等你回复」推到手机，回复提醒即输入到会话；没配 Token 存储时为 null。 */
  readonly telegram: TelegramBridge | null;

  constructor(options: DeckServiceOptions) {
    this.#options = options;
    this.tty7 = options.tty7 ?? new Tty7({ env: options.env });
    this.muse = new MuseDeckRuntime({
      dataDir: options.dataDir,
      homeDir: options.homeDir,
    });
    this.notices = new SessionNoticeWatcher({
      sessions: () => this.tty7.sessions(),
      subscribe: (onLine) => this.tty7.events(onLine),
      enabled: options.noticesEnabled ?? (async () => true),
      onNotice: () => {
        options.onNotices?.();
        this.telegram?.noticesChanged();
      },
      ...(options.noticeLlm === undefined
        ? {}
        : {
            summarize: async (draft) => {
              const llm = await options.noticeLlm?.();
              if (!llm) return null;
              const screen = await this.tty7
                .screen(draft.pane, NOTICE_SCREEN_LINES)
                .then((view) => view.text)
                .catch(() => "");
              return summarizeNotice(llm, draft, screen, NOTICE_SUMMARY_TIMEOUT_MS);
            },
          }),
    });
    this.telegram =
      options.telegramToken === undefined
        ? null
        : new TelegramBridge({
            configPath: join(options.dataDir, "deck", "telegram.json"),
            token: options.telegramToken,
            ...(options.telegramRelayKey ? { relayKey: options.telegramRelayKey } : {}),
            ...(options.telegramRelayToken ? { relayToken: options.telegramRelayToken } : {}),
            ...(options.dispatch ? { dispatch: options.dispatch } : {}),
            ...(options.dispatchIdentity ? { dispatchIdentity: options.dispatchIdentity } : {}),
            ...(options.deviceId ? { deviceId: options.deviceId } : {}),
            notices: () => this.notices.list(),
            sessions: () => this.tty7.sessions(),
            send: (input) => this.tty7.send(input),
            dismiss: (input) => {
              this.notices.dismiss(input);
            },
            ...(options.onTelegram ? { onChange: options.onTelegram } : {}),
            ...(options.telegramFetch ? { fetch: options.telegramFetch } : {}),
          });
    this.activity = new ActivityMonitor({
      sessions: () => this.tty7.sessions({ withActivity: false }),
      procs: (pane) => this.tty7.procs(pane),
      screen: (pane) => this.tty7.screen(pane, 10).then((view) => view.text),
      onChange: () => this.notices.poke(),
    });
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

  /** 返回 T3 iframe 该加载的转发地址；按上游地址复用，超出上限时淘汰最久未使用的。起不来返回 null，网页退回直连。 */
  t3Frame(upstream: string): string | null {
    if (this.#stopped) return null;
    const key = t3ProxyKey(upstream);
    const existing = this.#t3Proxies.get(key);
    if (existing) {
      existing.lastUsed = ++this.#t3UseSeq;
      return existing.proxy.url;
    }
    let proxy: T3Proxy;
    try {
      proxy = startT3Proxy(upstream);
    } catch {
      return null;
    }
    if (this.#t3Proxies.size >= MAX_T3_PROXIES) {
      let oldestKey: string | null = null;
      let oldestUsed = Infinity;
      for (const [entryKey, entry] of this.#t3Proxies) {
        if (entry.lastUsed < oldestUsed) {
          oldestUsed = entry.lastUsed;
          oldestKey = entryKey;
        }
      }
      if (oldestKey !== null) {
        this.#t3Proxies.get(oldestKey)?.proxy.stop();
        this.#t3Proxies.delete(oldestKey);
      }
    }
    this.#t3Proxies.set(key, { proxy, lastUsed: ++this.#t3UseSeq });
    return proxy.url;
  }

  /** 只保留 keep 里的上游转发，其余全部停掉。 */
  t3Retain(keep: string[]): void {
    const keepSet = new Set(keep.map(t3ProxyKey));
    for (const [key, entry] of this.#t3Proxies) {
      if (keepSet.has(key)) continue;
      entry.proxy.stop();
      this.#t3Proxies.delete(key);
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const entry of this.#t3Proxies.values()) entry.proxy.stop();
    this.#t3Proxies.clear();
    this.notices.stop();
    this.telegram?.stop();
    this.activity.stop();
    this.muse.stop();
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

  /** 开始监视终端会话状态（daemon 启动后调用一次；tty7 没装时什么也不做）。 */
  startNotices(): void {
    this.notices.start();
    this.tty7.setActivity((pane) => this.activity.detail(pane));
    this.activity.start();
    void this.telegram?.start().catch(() => undefined);
  }

  /** 终端会话列表：在 tty7 的会话上补上最近一轮的任务名。 */
  async tty7Sessions(): Promise<Tty7SessionsView> {
    const view = await this.tty7.sessions();
    return { ...view, sessions: view.sessions.map((session) => ({ ...session, task: this.notices.taskOf(session.pane) })) };
  }

  noticeList(): SessionNoticeList {
    return this.notices.list();
  }

  dismissNotice(input: SessionNoticeDismissInput): boolean {
    return this.notices.dismiss(input);
  }

  /** 网页上报正在整屏看的会话（null 表示没在看），这个会话的提醒会被跳过。 */
  setViewing(pane: number | null): void {
    this.notices.setViewing(pane);
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
