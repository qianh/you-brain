import { randomUUID } from "node:crypto";

import type { Tty7Session, Tty7SessionsView } from "./tty7.js";

/**
 * 终端会话提醒：某个会话从「工作中」变成「等你回复」或「已完成」时记一条。
 * 状态来自 tty7 的 agent hooks 或终端进程/屏幕活动监测（activity.ts）。
 * daemon 负责产生、收口过时条目并提供确认关闭接口；桌面壳弹系统通知并拉起置顶弹框。
 */
export interface SessionNotice {
  /** 从 1 递增；取的一方记住最大的 seq，只处理比它大的。 */
  seq: number;
  pane: number;
  kind: "waiting" | "done";
  /** open = 待处理（在置顶弹框队列里展示）；closed = 已确认、已跳转或会话状态已推进。 */
  status: "open" | "closed";
  sessionName: string;
  agent: string | null;
  cwd: string;
  title: string;
  body: string;
  at: string;
}

export interface SessionNoticeDismissInput {
  seq?: number | undefined;
  pane?: number | undefined;
}

export interface SessionNoticeList {
  /** 本次 daemon 运行的随机串；变了说明 daemon 重启过，seq 要从头算。 */
  epoch: string;
  latest: number;
  notices: SessionNotice[];
}

/** 偏好键：值为 "0" 表示关闭会话提醒，其余（含不存在）为开。 */
export const TERMINAL_NOTIFY_PREF_KEY = "you-brain.deck.terminal-notify";

const NOTICES_KEPT = 50;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_SUMMARIZE_TIMEOUT_MS = 45_000;
/** 网页每 5 秒报一次正在看的会话；超过这么久没更新就当没人在看。 */
const VIEWING_TTL_MS = 15_000;

function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** 会话名：与网页的 `sessionTitle`（apps/web/src/pages/deck-tty7-sessions.ts）规则一致。 */
export function sessionTitle(session: Pick<Tty7Session, "pane" | "tabLabel" | "cwd">): string {
  return session.tabLabel ?? (session.cwd === "" ? `%${session.pane}` : baseName(session.cwd));
}

export type SessionNoticeDraft = Pick<
  SessionNotice,
  "pane" | "kind" | "sessionName" | "agent" | "cwd" | "title" | "body"
>;

/**
 * 比较前后两次快照，产生这一轮的提醒。
 * `previous` 为 null 是第一次快照，只建立基线、不提醒（重启后不补弹）。
 * 只有「上一次是 working、这一次是 waiting 或 done」才提醒；正在看的会话不提醒。
 */
export function diffNotices(
  previous: ReadonlyMap<number, string | null> | null,
  sessions: readonly Tty7Session[],
  viewing: number | null,
): SessionNoticeDraft[] {
  if (previous === null) return [];
  const result: SessionNoticeDraft[] = [];
  for (const session of sessions) {
    if (previous.get(session.pane) !== "working") continue;
    if (session.status !== "waiting" && session.status !== "done") continue;
    if (session.pane === viewing) continue;
    const name = sessionTitle(session);
    result.push({
      pane: session.pane,
      kind: session.status,
      sessionName: name,
      agent: session.agent,
      cwd: session.cwd,
      title: session.status === "waiting" ? `${name} 在等你回复` : `${name} 已完成`,
      body: session.statusMessage ?? "",
    });
  }
  return result;
}

/**
 * 根据最新会话快照收口已过时的待处理提醒，返回是否有状态变化：
 * - 会话已关闭（不在 sessions 里）→ 关闭
 * - 用户正在整屏看这个会话（pane === viewing）→ 关闭
 * - waiting 提醒：会话不再处于 waiting（用户已在终端回复、继续执行或已结束）→ 关闭
 * - done 提醒：会话重新进入 working（开始了新任务）→ 关闭（停在 done 或 idle 时保留，等用户确认）
 */
export function reconcileOpenNotices(
  notices: SessionNotice[],
  sessions: readonly Tty7Session[],
  viewing: number | null,
): boolean {
  const byPane = new Map(sessions.map((session) => [session.pane, session]));
  let changed = false;
  for (const notice of notices) {
    if (notice.status !== "open") continue;
    const current = byPane.get(notice.pane);
    const stale =
      current === undefined ||
      notice.pane === viewing ||
      (notice.kind === "waiting" && current.status !== "waiting") ||
      (notice.kind === "done" && current.status === "working");
    if (stale) {
      notice.status = "closed";
      changed = true;
    }
  }
  return changed;
}

export interface SessionNoticeWatcherOptions {
  sessions(): Promise<Tty7SessionsView>;
  /** 订阅 tty7 的事件流：每来一行调用一次 onLine，返回取消订阅的函数。 */
  subscribe(onLine: () => void): () => void;
  /** 总开关；为假时照常更新快照，但不产生条目（重新打开后也不补发关闭期间的变化）。 */
  enabled(): Promise<boolean>;
  /** 产生了新条目。 */
  onNotice(): void;
  /**
   * 把提醒正文写成分析后的结论和建议（读屏幕交给模型）。返回 null 或抛错时用会话自报的状态兜底。
   * 提供时，提醒等分析完成（或超时）后才记下，系统通知和弹框一出来就是分析后的内容。
   */
  summarize?(draft: SessionNoticeDraft): Promise<string | null>;
  /** 等分析的上限，超时就用兜底正文先记下。 */
  summarizeTimeoutMs?: number;
  now?(): number;
  pollMs?: number;
  debounceMs?: number;
}

export class SessionNoticeWatcher {
  readonly #options: SessionNoticeWatcherOptions;
  readonly #epoch = randomUUID();
  #snapshot: Map<number, string | null> | null = null;
  #notices: SessionNotice[] = [];
  #seq = 0;
  #viewing: { pane: number; at: number } | null = null;
  #started = false;
  #unsubscribe: (() => void) | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #reading = false;
  #again = false;
  /** 正在分析、还没记下的会话；同一会话分析期间再次触发不重复分析。 */
  readonly #summarizing = new Set<number>();

  constructor(options: SessionNoticeWatcherOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribe = this.#options.subscribe(() => this.#schedule());
    this.#pollTimer = setInterval(() => void this.#read(), this.#options.pollMs ?? DEFAULT_POLL_MS);
    this.#pollTimer.unref?.();
    // 马上读一次建立基线，之后的变化才能和它比较。
    void this.#read();
  }

  stop(): void {
    this.#started = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = null;
  }

  /** 外部（终端活动监视）发现状态变了，尽快读一次。 */
  poke(): void {
    this.#schedule();
  }

  /** 网页上报正在整屏看的会话；null 表示没在看。15 秒不更新自动失效，并立即收口该会话的待处理提醒。 */
  setViewing(pane: number | null): void {
    this.#viewing = pane === null ? null : { pane, at: this.#now() };
    if (pane !== null) {
      this.dismiss({ pane });
    }
  }

  /** 用户在置顶弹框里确认、忽略或跳转到终端后关闭对应提醒。 */
  dismiss(input: SessionNoticeDismissInput): boolean {
    let changed = false;
    for (const notice of this.#notices) {
      if (notice.status !== "open") continue;
      const matchSeq = input.seq !== undefined && notice.seq === input.seq;
      const matchPane = input.pane !== undefined && notice.pane === input.pane;
      if (matchSeq || matchPane) {
        notice.status = "closed";
        changed = true;
      }
    }
    if (changed) {
      try {
        this.#options.onNotice();
      } catch {
        // 通知其他部分失败不影响状态更新。
      }
    }
    return changed;
  }

  list(): SessionNoticeList {
    return { epoch: this.#epoch, latest: this.#seq, notices: [...this.#notices] };
  }

  #viewingPane(): number | null {
    if (this.#viewing === null) return null;
    return this.#now() - this.#viewing.at > VIEWING_TTL_MS ? null : this.#viewing.pane;
  }

  #schedule(): void {
    if (!this.#started) return;
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#read();
    }, this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.#debounceTimer.unref?.();
  }

  async #summarizeThenPush(item: SessionNoticeDraft): Promise<void> {
    const summarize = this.#options.summarize;
    let summary: string | null = null;
    if (summarize !== undefined) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.#options.summarizeTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        summary = await Promise.race([summarize(item).catch(() => null), timeout]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }
    if (!this.#started) return;
    // 分析期间会话状态变了（又开始工作、已关闭）或用户已经在看，这条就不用记了。
    if (this.#snapshot?.get(item.pane) !== item.kind || this.#viewingPane() === item.pane) return;
    const text = summary?.trim() ?? "";
    this.#push([text === "" ? item : { ...item, body: text }]);
  }

  #push(found: readonly SessionNoticeDraft[]): void {
    const at = new Date(this.#now()).toISOString();
    const replacedPanes = new Set(found.map((item) => item.pane));
    for (const existing of this.#notices) {
      if (existing.status === "open" && replacedPanes.has(existing.pane)) {
        existing.status = "closed";
      }
    }
    for (const item of found) {
      this.#notices.push({ seq: ++this.#seq, status: "open", ...item, at });
    }
    if (this.#notices.length > NOTICES_KEPT) this.#notices.splice(0, this.#notices.length - NOTICES_KEPT);
    try {
      this.#options.onNotice();
    } catch {
      // 通知其他部分失败不影响监视。
    }
  }

  /** 读一次会话并和上次快照比较。同一时刻只有一次在跑，跑的时候来的请求合并成再读一次。 */
  async #read(): Promise<void> {
    if (!this.#started) return;
    if (this.#reading) {
      this.#again = true;
      return;
    }
    this.#reading = true;
    try {
      let view: Tty7SessionsView;
      try {
        view = await this.#options.sessions();
      } catch {
        return; // 本轮跳过，保留上一次快照。
      }
      // tty7 暂时不可用时列表是空的；不能拿空列表当快照，否则恢复后所有会话都像「新出现」。
      if (!view.available || !this.#started) return;
      let enabled = false;
      try {
        enabled = await this.#options.enabled();
      } catch {
        enabled = false;
      }
      const viewing = this.#viewingPane();
      const reconciled = reconcileOpenNotices(this.#notices, view.sessions, viewing);
      const found = enabled ? diffNotices(this.#snapshot, view.sessions, viewing) : [];
      this.#snapshot = new Map(view.sessions.map((session) => [session.pane, session.status]));
      if (found.length === 0) {
        if (reconciled) {
          try {
            this.#options.onNotice();
          } catch {
            // 通知其他部分失败不影响监视。
          }
        }
        return;
      }
      if (this.#options.summarize === undefined) {
        this.#push(found);
        return;
      }
      if (reconciled) {
        try {
          this.#options.onNotice();
        } catch {
          // 通知其他部分失败不影响监视。
        }
      }
      for (const item of found) {
        if (this.#summarizing.has(item.pane)) continue;
        this.#summarizing.add(item.pane);
        void this.#summarizeThenPush(item).finally(() => this.#summarizing.delete(item.pane));
      }
    } finally {
      this.#reading = false;
      if (this.#again) {
        this.#again = false;
        void this.#read();
      }
    }
  }
}
