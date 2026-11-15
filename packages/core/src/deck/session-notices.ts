import { randomUUID } from "node:crypto";

import type { Tty7Session, Tty7SessionsView } from "./tty7.js";

/**
 * 终端会话提醒：某个会话的 agent 从「工作中」变成「等你回复」或「已完成」时记一条。
 * 状态来自 tty7 的 agent hooks；没有状态的会话（没装 hooks）不提醒。
 * daemon 只负责产生和保存条目，真正弹系统通知的是桌面壳（它来取 `/api/deck/notices`）。
 */
export interface SessionNotice {
  /** 从 1 递增；取的一方记住最大的 seq，只处理比它大的。 */
  seq: number;
  pane: number;
  kind: "waiting" | "done";
  title: string;
  body: string;
  at: string;
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

/**
 * 比较前后两次快照，产生这一轮的提醒。
 * `previous` 为 null 是第一次快照，只建立基线、不提醒（重启后不补弹）。
 * 只有「上一次是 working、这一次是 waiting 或 done」才提醒；正在看的会话不提醒。
 */
export function diffNotices(
  previous: ReadonlyMap<number, string | null> | null,
  sessions: readonly Tty7Session[],
  viewing: number | null,
): Array<Pick<SessionNotice, "pane" | "kind" | "title" | "body">> {
  if (previous === null) return [];
  const result: Array<Pick<SessionNotice, "pane" | "kind" | "title" | "body">> = [];
  for (const session of sessions) {
    if (previous.get(session.pane) !== "working") continue;
    if (session.status !== "waiting" && session.status !== "done") continue;
    if (session.pane === viewing) continue;
    const name = sessionTitle(session);
    result.push({
      pane: session.pane,
      kind: session.status,
      title: session.status === "waiting" ? `${name} 在等你回复` : `${name} 已完成`,
      body: session.statusMessage ?? "",
    });
  }
  return result;
}

export interface SessionNoticeWatcherOptions {
  sessions(): Promise<Tty7SessionsView>;
  /** 订阅 tty7 的事件流：每来一行调用一次 onLine，返回取消订阅的函数。 */
  subscribe(onLine: () => void): () => void;
  /** 总开关；为假时照常更新快照，但不产生条目（重新打开后也不补发关闭期间的变化）。 */
  enabled(): Promise<boolean>;
  /** 产生了新条目。 */
  onNotice(): void;
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

  /** 网页上报正在整屏看的会话；null 表示没在看。15 秒不更新自动失效。 */
  setViewing(pane: number | null): void {
    this.#viewing = pane === null ? null : { pane, at: this.#now() };
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
      const found = enabled ? diffNotices(this.#snapshot, view.sessions, this.#viewingPane()) : [];
      this.#snapshot = new Map(view.sessions.map((session) => [session.pane, session.status]));
      if (found.length === 0) return;
      const at = new Date(this.#now()).toISOString();
      for (const item of found) this.#notices.push({ seq: ++this.#seq, ...item, at });
      if (this.#notices.length > NOTICES_KEPT) this.#notices.splice(0, this.#notices.length - NOTICES_KEPT);
      try {
        this.#options.onNotice();
      } catch {
        // 通知其他部分失败不影响监视。
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
