import { readFile } from "node:fs/promises";

import {
  DEFAULT_ACTIVE_TOPIC_LIMIT,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_OUTPUT_DEBOUNCE_SECONDS,
  type Event,
  type UiLanguage,
} from "@you-brain/protocol";

import { writeFileAtomic } from "../domain/atomic.js";
import type { YouBrainPaths } from "../domain/paths.js";
import type {
  ConclusionRecord,
  DeviceRecord,
  SessionRecord,
  TodayQuery,
  TodoRecord,
  TopicRecord,
} from "../store/types.js";
import { foldEvents } from "../topics/index.js";
import type { OutputClock, OutputTimer } from "./clock.js";
import { systemClock } from "./clock.js";
import { renderLocalMarkdown, type RenderedOutput } from "./render.js";

export interface OutputSource {
  listTodaySessions(query: TodayQuery): readonly SessionRecord[];
  listTopics(options?: { liveOnly?: boolean }): readonly TopicRecord[];
  listConclusions(): readonly ConclusionRecord[];
  listTodos(): readonly TodoRecord[];
  listDevices(): readonly DeviceRecord[];
  listEvents(): readonly Event[];
  getSession(sessionKey: string): SessionRecord | null;
}

export interface OutputWriteResult {
  today: boolean;
  topics: boolean;
  reminders: boolean;
}

export interface OutputServiceOptions {
  source: OutputSource;
  paths: Pick<YouBrainPaths, "todayFile" | "topicsFile" | "remindersFile">;
  language: UiLanguage;
  timeZone: string;
  activeLimit?: number;
  historyDays?: number;
  debounceMs?: number;
  clock?: OutputClock;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export class OutputService {
  readonly #source: OutputSource;
  readonly #paths: Pick<YouBrainPaths, "todayFile" | "topicsFile" | "remindersFile">;
  readonly #language: UiLanguage;
  readonly #timeZone: string;
  readonly #activeLimit: number;
  readonly #historyDays: number;
  readonly #debounceMs: number;
  readonly #clock: OutputClock;
  #timer: OutputTimer | null = null;
  #tail: Promise<void> = Promise.resolve();
  #last: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: OutputServiceOptions) {
    this.#source = options.source;
    this.#paths = options.paths;
    this.#language = options.language;
    this.#timeZone = options.timeZone;
    this.#activeLimit = options.activeLimit ?? DEFAULT_ACTIVE_TOPIC_LIMIT;
    this.#historyDays = options.historyDays ?? DEFAULT_HISTORY_DAYS;
    this.#debounceMs = options.debounceMs ?? DEFAULT_OUTPUT_DEBOUNCE_SECONDS * 1000;
    this.#clock = options.clock ?? systemClock();
  }

  schedule(): void {
    if (this.#closed) return;
    this.#timer?.cancel();
    this.#timer = this.#clock.schedule(this.#debounceMs, () => {
      this.#timer = null;
      const pending = this.flush();
      void pending.catch(() => undefined);
      void this.#last.catch(() => undefined);
    });
  }

  flush(): Promise<OutputWriteResult> {
    this.#timer?.cancel();
    this.#timer = null;
    const pending = this.#tail.then(() => this.#write(), () => this.#write());
    this.#last = pending.then(() => undefined);
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  whenIdle(): Promise<void> {
    return this.#last;
  }

  close(): void {
    this.#closed = true;
    this.#timer?.cancel();
    this.#timer = null;
  }

  render(): RenderedOutput {
    const now = this.#clock.now();
    const todaySessions = this.#source.listTodaySessions({ timeZone: this.#timeZone, now });
    const topics = this.#source.listTopics();
    const events = this.#source.listEvents();
    const sessions = loadSessions(this.#source, events, todaySessions);
    return renderLocalMarkdown({
      now,
      timeZone: this.#timeZone,
      language: this.#language,
      activeLimit: this.#activeLimit,
      historyDays: this.#historyDays,
      topics,
      sessions,
      todaySessions,
      conclusions: this.#source.listConclusions(),
      todos: this.#source.listTodos(),
      devices: this.#source.listDevices(),
    });
  }

  async #write(): Promise<OutputWriteResult> {
    const rendered = this.render();
    const [today, topics, reminders] = await Promise.all([
      writeIfChanged(this.#paths.todayFile, rendered.today),
      writeIfChanged(this.#paths.topicsFile, rendered.topics),
      writeIfChanged(this.#paths.remindersFile, rendered.reminders),
    ]);
    return { today, topics, reminders };
  }
}

function loadSessions(
  source: OutputSource,
  events: readonly Event[],
  todaySessions: readonly SessionRecord[],
): SessionRecord[] {
  const byKey = new Map<string, SessionRecord>();
  if (events.length > 0) {
    for (const session of foldEvents(events).sessions) {
      const stored = source.getSession(session.sessionKey);
      byKey.set(
        session.sessionKey,
        stored ?? {
          sessionKey: session.sessionKey,
          source: session.source,
          device: "",
          fileId: session.fileId.length > 0 ? session.fileId : null,
          title: session.title,
          summary: session.summary,
          startedAt: null,
          updatedAt: null,
          msgCount: 0,
          refinedUpTo: session.refinedUpTo,
          topicId: session.topicId,
        },
      );
    }
  }
  for (const session of todaySessions) byKey.set(session.sessionKey, session);
  return [...byKey.values()];
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  const current = await readOptional(path);
  if (current === content) return false;
  await writeFileAtomic(path, content);
  return true;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}
