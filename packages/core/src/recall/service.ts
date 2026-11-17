import { localDayKey } from "../consolidate/schedule.js";
import type { LlmBackend } from "../llm/types.js";
import type { CandidateTopic } from "../refine/types.js";
import type { ReminderRecord } from "../store/types.js";
import type { TopicBook } from "../topics/types.js";
import { decideRecallDelivery, recallReminderId } from "./delivery.js";
import type { RecallLogEntry } from "./log.js";
import { matchRecallTopic } from "./match.js";
import { historyCandidates, buildRecallMemory } from "./memory.js";
import { RECALL_JSON_SCHEMA, buildRecallPrompt, parseRecallDecision } from "./prompt.js";
import {
  RECALL_KIND,
  RECALL_REPLY_KEEP_MS,
  RECALL_REPLIES,
  RECALL_RETRY_DELAYS_MS,
  RECALL_USER_CHARS,
  type RecallHistoryItem,
  type RecallReplyItem,
} from "./types.js";

export const RECALL_CONSIDERED_CURSOR = "recall.considered";
const CONSIDERED_KEEP_MS = 7 * 24 * 60 * 60_000;
/** How many of the latest user messages are matched against topics when the session has none. */
const MATCH_TURNS = 3;

export interface RecallPorts {
  llm(): LlmBackend | null;
  book(): TopicBook;
  candidateTopics(): CandidateTopic[];
  sessionUpdatedAt(): Readonly<Record<string, string>>;
  reminders(): readonly ReminderRecord[];
  topicMuted(topicId: string): boolean;
  /**
   * Raw excerpts of the topic's older sessions, newest first. Best effort: a read
   * failure returns fewer items or none, and never blocks the reminder.
   */
  history(input: { sessionKeys: readonly string[] }): Promise<readonly RecallHistoryItem[]>;
  /** What the user replied to earlier reminders on this topic, newest first. */
  replies(topicId: string): readonly RecallReplyItem[];
  emit(data: { reminderId: string; kind: string; topicId: string; text: string; sessionKey?: string }): Promise<void>;
  /** A newer reminder for the topic takes the old one's place. */
  resolve(data: { reminderId: string; topicId: string | null }): Promise<void>;
  cursors: { get(key: string): string | null; set(key: string, value: string): void };
  log(entry: RecallLogEntry): void;
  nowMs(): number;
  timeZone(): string;
}

interface RecallTask {
  sessionKey: string;
  topicId: string;
  userTurns: readonly string[];
  dueAt: number;
  failures: number;
}

interface ConsideredEntry {
  sessionKey: string;
  topicId: string;
  ts: string;
}

/**
 * Decides, for a session that just got a new user message, whether the topic's memory holds
 * something worth saying now. `consider` only queues; `tick` runs one due task at a time.
 * Nothing here throws into the caller: a reminder must never get in the way of collecting.
 */
export class RecallService {
  readonly #ports: RecallPorts;
  readonly #queue: RecallTask[] = [];
  readonly #turnCounts = new Map<string, number>();
  #running = false;

  constructor(ports: RecallPorts) {
    this.#ports = ports;
  }

  pending(): number {
    return this.#queue.length;
  }

  consider(input: { sessionKey: string; userTurns: readonly string[] }): void {
    try {
      this.#consider(input);
    } catch {
      // A broken port never reaches the caller.
    }
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const now = this.#ports.nowMs();
      const task = this.#queue.find((item) => item.dueAt <= now);
      if (task) await this.#run(task);
    } catch {
      // See consider().
    } finally {
      this.#running = false;
    }
  }

  #consider(input: { sessionKey: string; userTurns: readonly string[] }): void {
    const { sessionKey, userTurns } = input;
    const previous = this.#turnCounts.get(sessionKey);
    if (userTurns.length === 0 || (previous !== undefined && userTurns.length <= previous)) return;
    this.#turnCounts.set(sessionKey, userTurns.length);
    const now = this.#ports.nowMs();

    const book = this.#ports.book();
    const assigned = book.sessions.find((session) => session.sessionKey === sessionKey)?.topicId ?? null;
    const topicId = matchRecallTopic({
      assignedTopicId: assigned,
      userText: userTurns.slice(-MATCH_TURNS).join("\n").slice(-RECALL_USER_CHARS),
      topics: this.#ports.candidateTopics(),
      book,
    });
    if (topicId === null) {
      this.#log({ sessionKey, topicId: null, outcome: "no-topic" });
      return;
    }
    if (this.#ports.topicMuted(topicId)) {
      this.#log({ sessionKey, topicId, outcome: "muted" });
      return;
    }
    if (this.#isConsidered(sessionKey, topicId)) return;
    const queued = this.#queue.find((task) => task.sessionKey === sessionKey && task.topicId === topicId);
    if (queued) {
      queued.userTurns = userTurns;
      return;
    }
    const memory = buildRecallMemory({
      book,
      topicId,
      sessionKey,
      sessionUpdatedAt: this.#ports.sessionUpdatedAt(),
      timeZone: this.#ports.timeZone(),
      nowMs: now,
    });
    if (memory === null) {
      this.#log({ sessionKey, topicId, outcome: "no-memory" });
      return;
    }
    this.#queue.push({ sessionKey, topicId, userTurns, dueAt: now, failures: 0 });
  }

  async #run(task: RecallTask): Promise<void> {
    const { sessionKey, topicId } = task;
    let failure: string | null = null;
    try {
      const llm = this.#ports.llm();
      if (llm === null) throw new Error("没有可用的模型");
      const memory = buildRecallMemory({
        book: this.#ports.book(),
        topicId,
        sessionKey,
        sessionUpdatedAt: this.#ports.sessionUpdatedAt(),
        timeZone: this.#ports.timeZone(),
        nowMs: this.#ports.nowMs(),
      });
      if (memory === null) {
        this.#drop(task);
        this.#log({ sessionKey, topicId, outcome: "no-memory" });
        return;
      }
      const history = await this.#history(memory.topicId, sessionKey);
      const replies = this.#recentReplies(memory.topicId);
      const prompt = buildRecallPrompt({
        memory,
        userTurns: task.userTurns,
        today: localDayKey(new Date(this.#ports.nowMs()), this.#ports.timeZone()),
        ...(history.length > 0 ? { history } : {}),
        ...(replies.length > 0 ? { replies } : {}),
      });
      const raw = await llm.complete({
        system: prompt.system,
        user: prompt.user,
        jsonSchema: RECALL_JSON_SCHEMA,
      });
      const decision = parseRecallDecision(raw, memory, history);
      if (!decision.say) {
        this.#finish(task);
        this.#log({ sessionKey, topicId, outcome: "silent" });
        return;
      }
      const reminderId = recallReminderId(sessionKey, topicId);
      if (this.#ports.reminders().some((item) => item.reminderId === reminderId)) {
        this.#finish(task);
        this.#log({ sessionKey, topicId, outcome: "duplicate" });
        return;
      }
      const now = this.#ports.nowMs();
      const delivery = decideRecallDelivery({
        grade: decision.grade,
        topicId,
        reminders: this.#ports.reminders(),
        nowMs: now,
        timeZone: this.#ports.timeZone(),
      });
      if (delivery.kind === null) {
        this.#finish(task);
        this.#log({
          sessionKey,
          topicId,
          outcome: "suppressed",
          grade: decision.grade,
          reason: delivery.reason,
          text: decision.text,
        });
        return;
      }
      const basisMemory = memory.items.find((item) => item.id === decision.basisId);
      const basisHistory = history.find((item) => item.id === decision.basisId);
      const source = basisMemory?.sessionKey ?? basisHistory?.sessionKey ?? null;
      await this.#ports.emit({
        reminderId,
        kind: delivery.kind,
        topicId,
        text: decision.text,
        ...(source === null ? {} : { sessionKey: source }),
      });
      await this.#supersede(topicId, reminderId);
      this.#finish(task);
      this.#log({
        sessionKey,
        topicId,
        outcome: "issued",
        grade: decision.grade,
        kind: delivery.kind,
        reason: delivery.reason,
        text: decision.text,
      });
      return;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    this.#retryOrGiveUp(task, failure);
  }

  /** Best effort: a history read that fails never blocks the reminder. */
  async #history(topicId: string, sessionKey: string): Promise<readonly RecallHistoryItem[]> {
    try {
      const candidates = historyCandidates({
        book: this.#ports.book(),
        topicId,
        sessionKey,
        sessionUpdatedAt: this.#ports.sessionUpdatedAt(),
        nowMs: this.#ports.nowMs(),
      });
      if (candidates.length === 0) return [];
      return await this.#ports.history({ sessionKeys: candidates });
    } catch {
      return [];
    }
  }

  #recentReplies(topicId: string): readonly RecallReplyItem[] {
    const now = this.#ports.nowMs();
    return this.#ports
      .replies(topicId)
      .filter((reply) => reply.day === null || now - this.#dayMs(reply.day) <= RECALL_REPLY_KEEP_MS)
      .slice(0, RECALL_REPLIES);
  }

  #dayMs(day: string): number {
    const ms = Date.parse(`${day}T00:00:00Z`);
    return Number.isNaN(ms) ? 0 : ms;
  }

  /** A newer reminder takes over: open ones for the same topic are closed as handled. */
  async #supersede(topicId: string, keepReminderId: string): Promise<void> {
    const stale = this.#ports.reminders().filter(
      (item) =>
        item.topicId === topicId &&
        item.reminderId !== keepReminderId &&
        (item.kind === RECALL_KIND.notify || item.kind === RECALL_KIND.quiet) &&
        (item.status === "open" || item.status === "snoozed"),
    );
    for (const item of stale) {
      try {
        await this.#ports.resolve({ reminderId: item.reminderId, topicId });
        this.#log({ sessionKey: "", topicId, outcome: "superseded", text: item.text });
      } catch {
        // Closing the old one is cosmetic; the new reminder is already out.
      }
    }
  }

  #retryOrGiveUp(task: RecallTask, reason: string): void {    task.failures += 1;
    const delay = RECALL_RETRY_DELAYS_MS[task.failures - 1];
    if (delay === undefined) {
      this.#drop(task);
      this.#log({ sessionKey: task.sessionKey, topicId: task.topicId, outcome: "gave-up", reason });
      return;
    }
    task.dueAt = this.#ports.nowMs() + delay;
    this.#log({ sessionKey: task.sessionKey, topicId: task.topicId, outcome: "failed", reason });
  }

  #drop(task: RecallTask): void {
    const index = this.#queue.indexOf(task);
    if (index >= 0) this.#queue.splice(index, 1);
  }

  /** The task is settled for good: leave the queue and remember not to ask again. */
  #finish(task: RecallTask): void {
    this.#drop(task);
    const now = this.#ports.nowMs();
    const kept = this.#readConsidered().filter(
      (entry) => now - Date.parse(entry.ts) < CONSIDERED_KEEP_MS,
    );
    kept.push({ sessionKey: task.sessionKey, topicId: task.topicId, ts: new Date(now).toISOString() });
    this.#ports.cursors.set(RECALL_CONSIDERED_CURSOR, JSON.stringify(kept));
  }

  #isConsidered(sessionKey: string, topicId: string): boolean {
    return this.#readConsidered().some(
      (entry) => entry.sessionKey === sessionKey && entry.topicId === topicId,
    );
  }

  #readConsidered(): ConsideredEntry[] {
    const raw = this.#ports.cursors.get(RECALL_CONSIDERED_CURSOR);
    if (raw === null) return [];
    try {
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      return value.filter(
        (entry): entry is ConsideredEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as ConsideredEntry).sessionKey === "string" &&
          typeof (entry as ConsideredEntry).topicId === "string" &&
          typeof (entry as ConsideredEntry).ts === "string",
      );
    } catch {
      return [];
    }
  }

  #log(entry: Omit<RecallLogEntry, "ts">): void {
    try {
      this.#ports.log({ ts: new Date(this.#ports.nowMs()).toISOString(), ...entry });
    } catch {
      // The record is for tuning; losing a line must not change what the user sees.
    }
  }
}
