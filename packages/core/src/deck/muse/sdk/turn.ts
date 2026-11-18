// Adapted from Meta's muse-gadget-sdk muse_turn.py and wong2/muse-client (Apache-2.0).
import { MuseError, MuseProtocolError } from "./errors.js";
import type { ChatEvent } from "./events.js";

export interface ChatAcknowledgement {
  messageId: string;
  replyToMessageId?: string | undefined;
  raw: Record<string, unknown>;
}

export interface Reply {
  readonly type: "reply";
  readonly messageId: string;
  readonly text: string;
  readonly streamed: string;
  readonly done: boolean;
  readonly bound: boolean;
}

export interface AgentStatus {
  readonly type: "agent-status";
  readonly activityCode?: string | undefined;
  readonly activityText?: string | undefined;
}

export interface TaskFinished {
  readonly type: "task-finished";
}

export type TurnEvent = Reply | AgentStatus | TaskFinished;

export interface TurnOptions {
  sessionId?: string | undefined;
  ownsChat?: boolean | undefined;
  replayScope?: ReplayScope | undefined;
}

const QUIET_MS = 3_000;
const MAX_TEXT_BYTES = 64 * 1024;
const TERMINAL = new Set(["completed", "failed", "errored", "cancelled", "canceled"]);
const MESSAGE_EVENTS = new Set([
  "delta.message_start",
  "delta.text_append",
  "delta.message_done",
  "message.assistant",
]);
const STATUS_EVENTS = new Set(["agent.status", "task.status"]);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
export const cleanControlChars = (text: string): string =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function identifier(value: unknown): string | undefined {
  const id = asString(value);
  if (id && Buffer.byteLength(id) > 512) {
    throw new MuseProtocolError("Muse 返回了过长的消息标识");
  }
  return id;
}

function eventIds(event: ChatEvent, includeParents = true): Set<string> {
  const ids = new Set<string>();
  const keys = [
    "message_id",
    "id",
    "task_id",
    ...(includeParents ? ["reply_to_message_id", "parent_message_id"] : []),
  ];
  for (const key of keys) {
    const id = identifier(event.payload[key]);
    if (id) ids.add(`${key === "task_id" ? "task" : "message"}:${id}`);
  }
  const id = identifier(event.raw.message_id);
  if (id) ids.add(`message:${id}`);
  return ids;
}

export function acknowledgementIds(ack: ChatAcknowledgement): Set<string> {
  const ids = new Set(
    [identifier(ack.messageId), identifier(ack.replyToMessageId)].filter((id): id is string => !!id),
  );
  if (!ids.size) throw new MuseProtocolError("Muse 确认响应缺少消息 ID");
  return ids;
}

export class ReplayScope {
  readonly #ids = new Set<string>();

  constructor(private readonly limit = 2048) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new MuseError("Replay 缓存上限必须为正整数");
    }
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  retire(ids: Iterable<string>): void {
    for (const id of ids) {
      this.#ids.add(id);
      if (this.#ids.size > this.limit) {
        const oldest = this.#ids.values().next().value;
        if (oldest !== undefined) this.#ids.delete(oldest);
      }
    }
  }

  retireRequest(ack: ChatAcknowledgement): void {
    this.retire([...acknowledgementIds(ack)].map((id) => `message:${id}`));
  }

  observeIdle(event: ChatEvent, sessionId: string): void {
    if (
      (event.payload.session_id ?? event.raw.session_id) === sessionId &&
      (STATUS_EVENTS.has(event.event) || MESSAGE_EVENTS.has(event.event))
    ) {
      this.retire(eventIds(event));
    }
  }
}

export function transcriptText(value: unknown, messageId?: string): string {
  if (typeof value === "string") return value;
  const messages = asRecord(value)?.messages;
  if (!Array.isArray(messages)) return "";
  const message = messages
    .map(asRecord)
    .filter((m) => m?.role === "assistant" && (!messageId || m.id === messageId))
    .at(-1);
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map(asRecord)
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => String(item!.text))
    .join("\n");
}

export class MuseTurn {
  #session: string | undefined;
  #acked = false;
  #active = false;
  #finished = false;
  #activity: string | undefined;
  #last = performance.now();
  #userIds = new Set<string>();
  readonly #messages = new Map<string, Reply>();
  #pending: ChatEvent[] = [];
  #pendingBytes = 0;
  readonly #observed = new Set<string>();
  readonly #runningTasks = new Set<string>();
  readonly #ignored = new Set<string>();

  constructor(private readonly options: TurnOptions = {}) {
    this.#session = options.sessionId;
    if (options.ownsChat && !options.sessionId) {
      throw new MuseError("独占子会话必须提供 sessionId");
    }
  }

  get sessionId(): string | undefined {
    return this.#session;
  }
  get acknowledged(): boolean {
    return this.#acked;
  }
  get busy(): boolean {
    return this.#active;
  }
  get taskFinished(): boolean {
    return this.#finished;
  }
  get activityCode(): string | undefined {
    return this.#activity;
  }
  get lastActivity(): number {
    return this.#last;
  }
  get replies(): ReadonlyMap<string, Reply> {
    return new Map(this.#messages);
  }

  acknowledge(ack: ChatAcknowledgement): TurnEvent[] {
    if (this.#acked) throw new MuseError("该轮对话已确认");
    const ids = acknowledgementIds(ack);
    const result = asRecord(ack.raw.result) ?? ack.raw;
    const session = identifier(result.session_id);
    if (this.options.ownsChat && (session !== this.#session || result.is_thread !== true)) {
      throw new MuseProtocolError("Muse 未确认专属子会话（请先发送首条消息初始化该会话）");
    }
    if (session && this.#session && session !== this.#session) {
      throw new MuseProtocolError("Muse 返回了不匹配的会话 ID");
    }
    this.#session ??= session;
    this.#userIds = ids;
    this.#acked = true;
    const pending = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    return pending.flatMap((event) => this.feed(event));
  }

  feed(event: ChatEvent): TurnEvent[] {
    if (!MESSAGE_EVENTS.has(event.event) && !STATUS_EVENTS.has(event.event)) return [];
    const session = identifier(event.payload.session_id ?? event.raw.session_id);
    if (this.options.ownsChat ? session !== this.#session : session && this.#session && session !== this.#session) {
      return [];
    }
    // Ignore side-thread events when tracking the main chat.
    if (!this.options.ownsChat && event.payload.is_thread === true) {
      return [];
    }
    const ids = eventIds(event);
    if (this.options.replayScope) {
      const ownIds = eventIds(event, false);
      if ([...ownIds].some((id) => this.options.replayScope?.has(id))) return [];
      if (
        this.options.ownsChat &&
        this.#acked &&
        [...ids].some(
          (id) =>
            !ownIds.has(id) &&
            !this.#userIds.has(id.slice("message:".length)) &&
            this.options.replayScope?.has(id),
        )
      ) {
        return [];
      }
      for (const id of ids) this.#observed.add(id);
      if (this.#observed.size > 256) throw new MuseProtocolError("单轮事件标识过多");
    }
    if (!this.#acked) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (this.#pending.length >= 64 || this.#pendingBytes + bytes > MAX_TEXT_BYTES) {
        throw new MuseProtocolError("确认前积压事件过多");
      }
      this.#pending.push(structuredClone(event));
      this.#pendingBytes += bytes;
      return [];
    }
    return STATUS_EVENTS.has(event.event) ? this.#status(event) : this.#message(event);
  }

  #status(event: ChatEvent): TurnEvent[] {
    const p = event.payload;
    const parent = identifier(p.reply_to_message_id ?? p.parent_message_id);
    const reply = this.#messages.get(identifier(p.message_id) ?? "");
    const parentLinked = !!parent && (this.#userIds.has(parent) || this.#messages.get(parent)?.bound === true);
    // Reject explicit foreign parents on shared main chat; parentless statuses are kept (matches Meta muse_turn.py).
    if (!this.options.ownsChat && parent && !parentLinked) return [];
    const linked = parentLinked || reply?.bound === true;
    const task = identifier(p.task_id);
    const status = asString(p.status);
    const activity = typeof p.activity_code === "string" ? p.activity_code : undefined;
    const terminal = !!status && TERMINAL.has(status);
    const wasFinished = this.#finished;
    if (event.event === "task.status") {
      if (terminal && this.options.ownsChat && !linked && !(task && this.#runningTasks.has(task))) return [];
      if (status === "running" && task) {
        if (this.#runningTasks.size >= 256 && !this.#runningTasks.has(task)) {
          throw new MuseProtocolError("单轮运行任务过多");
        }
        this.#runningTasks.add(task);
      }
      if (terminal && task) this.#runningTasks.delete(task);
      if (status) this.#finished = terminal && (!this.options.ownsChat || this.#runningTasks.size === 0);
    }
    if (activity !== undefined) {
      this.#active = !["", "online", "idle"].includes(activity) && !TERMINAL.has(activity);
      if (event.event === "agent.status") this.#activity = activity;
    } else if (status) {
      this.#active = status !== "idle" && !terminal;
    }
    if (this.options.ownsChat && this.#runningTasks.size) {
      this.#active = true;
      this.#finished = false;
    } else if (event.event === "task.status" && this.#finished) {
      this.#active = false;
    }
    this.#last = performance.now();
    if (event.event === "agent.status" && !this.#finished) {
      return [
        Object.freeze({
          type: "agent-status",
          activityCode: activity,
          activityText: typeof p.activity_text === "string" ? cleanControlChars(p.activity_text) : undefined,
        }),
      ];
    }
    return this.#finished && !wasFinished ? [Object.freeze({ type: "task-finished" })] : [];
  }

  #message(event: ChatEvent): TurnEvent[] {
    const p = event.payload;
    if (typeof p.visibility === "string" && p.visibility !== "public") return [];
    const id = identifier(p.message_id ?? event.raw.message_id ?? p.id);
    if (!id || p.role === "user" || this.#userIds.has(id)) return [];
    const parent = identifier(p.reply_to_message_id ?? p.parent_message_id);
    let reply = this.#messages.get(id);
    if (this.#ignored.has(id)) return [];
    if (
      parent &&
      !this.#userIds.has(parent) &&
      !this.#messages.has(parent) &&
      !(this.options.ownsChat && parent === id)
    ) {
      if (!reply) {
        this.#ignored.add(id);
        if (this.#ignored.size > 256) {
          const oldest = this.#ignored.values().next().value;
          if (oldest !== undefined) this.#ignored.delete(oldest);
        }
      }
      return [];
    }
    if (!reply) {
      if (this.#messages.size >= 32) throw new MuseProtocolError("单轮消息条数超过上限");
      reply = { type: "reply", messageId: id, text: "", streamed: "", done: false, bound: false };
    }
    const bound =
      reply.bound ||
      !!this.options.ownsChat ||
      (!!parent && (this.#userIds.has(parent) || this.#messages.get(parent)?.bound === true));
    let { text, streamed, done } = reply;
    if (event.event === "delta.text_append" && typeof p.text === "string" && !done) {
      const delta = cleanControlChars(p.text);
      text += delta;
      streamed += delta;
    }
    if (event.event === "delta.message_done" || event.event === "message.assistant") {
      let final: unknown = p.display_text;
      if (typeof final !== "string") {
        final = transcriptText(p.transcript, id);
        if (!final && typeof p.transcript !== "string") final = p.content;
      }
      if (typeof final === "string") text = cleanControlChars(final);
      if (event.event === "delta.message_done" || p.display_text_ready !== false) done = true;
    }
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES || Buffer.byteLength(streamed) > MAX_TEXT_BYTES) {
      throw new MuseProtocolError("Muse 单条回复超过 64 KB 上限");
    }
    const next: Reply = Object.freeze({ type: "reply", messageId: id, text, streamed, done, bound });
    this.#messages.set(id, next);
    this.#last = performance.now();
    return [next];
  }

  completionDelay(now = performance.now()): number {
    if (!this.#acked || this.#active) return Infinity;
    const replies = [...this.#messages.values()];
    if (replies.some((reply) => !reply.done)) return Infinity;
    if (replies.some((reply) => reply.text.trim())) {
      return this.#finished ? 0 : Math.max(0, this.#last + QUIET_MS - now);
    }
    return this.#finished ? Math.max(0, this.#last + (replies.length ? 1_000 : QUIET_MS) - now) : Infinity;
  }

  complete(now = performance.now()): boolean {
    return this.completionDelay(now) === 0;
  }

  retire(): void {
    if (!this.options.replayScope) return;
    this.options.replayScope.retire(this.#observed);
    this.options.replayScope.retire([...this.#userIds].map((id) => `message:${id}`));
    for (const event of this.#pending) this.options.replayScope.retire(eventIds(event));
  }
}
