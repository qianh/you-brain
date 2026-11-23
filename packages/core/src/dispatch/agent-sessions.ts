import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ulid } from "@you-brain/protocol";

import { writeFileAtomic } from "../domain/atomic.js";

export interface AgentSessionRecord {
  sessionId: string;
  threadId: string | null;
  threadUrl: string | null;
  projectId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSessionsState {
  activeSessionId: string | null;
  subscribers: string[];
  sessions: AgentSessionRecord[];
}

const MAX_SESSIONS = 50;
const MAX_SUBSCRIBERS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): AgentSessionRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId === "" ||
    typeof value.title !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return null;
  }
  const threadId = typeof value.threadId === "string" && value.threadId !== "" ? value.threadId : null;
  const threadUrl = typeof value.threadUrl === "string" && value.threadUrl !== "" ? value.threadUrl : null;
  const projectId = typeof value.projectId === "string" && value.projectId !== "" ? value.projectId : null;
  return {
    sessionId: value.sessionId,
    threadId,
    threadUrl,
    projectId,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function emptyState(): AgentSessionsState {
  return { activeSessionId: null, subscribers: [], sessions: [] };
}

function normalizeState(raw: unknown): AgentSessionsState {
  if (!isRecord(raw)) return emptyState();
  const subscribers = Array.isArray(raw.subscribers)
    ? [...new Set(raw.subscribers.filter((item): item is string => typeof item === "string" && item !== ""))].slice(-MAX_SUBSCRIBERS)
    : [];
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.map(parseSession).filter((item): item is AgentSessionRecord => item !== null).slice(0, MAX_SESSIONS)
    : [];
  const activeCandidate = typeof raw.activeSessionId === "string" ? raw.activeSessionId : null;
  const activeSessionId =
    activeCandidate && sessions.some((item) => item.sessionId === activeCandidate)
      ? activeCandidate
      : (sessions[0]?.sessionId ?? null);
  return { activeSessionId, subscribers, sessions };
}

/**
 * `<dataDir>/dispatch/agent-sessions.json`（0600，原子写）。
 * 维护手机端与主控设备持续会话列表、当前激活会话和事件订阅者设备 ID。
 */
export class AgentSessionStore {
  readonly #file: string;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  #cached: AgentSessionsState | null = null;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.#file = join(dataDir, "dispatch", "agent-sessions.json");
    this.#now = now;
  }

  read(): Promise<AgentSessionsState> {
    return this.#enqueue(async () => structuredClone(await this.#load()));
  }

  addSubscriber(deviceId: string): Promise<AgentSessionsState> {
    return this.#enqueue(async () => {
      const state = await this.#load();
      if (deviceId === "") return structuredClone(state);
      const next = state.subscribers.filter((id) => id !== deviceId);
      next.push(deviceId);
      state.subscribers = next.slice(-MAX_SUBSCRIBERS);
      await this.#save(state);
      return structuredClone(state);
    });
  }

  async subscribers(): Promise<string[]> {
    const state = await this.read();
    return state.subscribers;
  }

  ensureSession(opts: {
    sessionId?: string;
    create?: boolean;
    title?: string;
  }): Promise<{ state: AgentSessionsState; session: AgentSessionRecord }> {
    return this.#enqueue(async () => {
      const state = await this.#load();
      const now = this.#now();

      if (opts.create === true) {
        const sessionId = `ag-${ulid(now)}`;
        const record: AgentSessionRecord = {
          sessionId,
          threadId: null,
          threadUrl: null,
          projectId: null,
          title: opts.title?.trim() || "主控会话",
          createdAt: now,
          updatedAt: now,
        };
        state.sessions = [record, ...state.sessions].slice(0, MAX_SESSIONS);
        state.activeSessionId = sessionId;
        await this.#save(state);
        return { state: structuredClone(state), session: { ...record } };
      }

      if (opts.sessionId) {
        const matched = state.sessions.find((item) => item.sessionId === opts.sessionId);
        if (!matched) throw new Error("找不到这个主控会话");
        state.activeSessionId = matched.sessionId;
        await this.#save(state);
        return { state: structuredClone(state), session: { ...matched } };
      }

      const active =
        (state.activeSessionId ? state.sessions.find((item) => item.sessionId === state.activeSessionId) : undefined) ??
        state.sessions[0];
      if (active) {
        if (state.activeSessionId !== active.sessionId) {
          state.activeSessionId = active.sessionId;
          await this.#save(state);
        }
        return { state: structuredClone(state), session: { ...active } };
      }

      const sessionId = `ag-${ulid(now)}`;
      const created: AgentSessionRecord = {
        sessionId,
        threadId: null,
        threadUrl: null,
        projectId: null,
        title: opts.title?.trim() || "主控会话",
        createdAt: now,
        updatedAt: now,
      };
      state.sessions = [created];
      state.activeSessionId = sessionId;
      await this.#save(state);
      return { state: structuredClone(state), session: { ...created } };
    });
  }

  bindThread(
    sessionId: string,
    binding: { threadId: string; threadUrl: string; projectId: string; title?: string },
  ): Promise<AgentSessionRecord | null> {
    return this.#enqueue(async () => {
      const state = await this.#load();
      const target = state.sessions.find((item) => item.sessionId === sessionId);
      if (!target) return null;
      target.threadId = binding.threadId;
      target.threadUrl = binding.threadUrl;
      target.projectId = binding.projectId;
      if (binding.title && target.title === "主控会话") target.title = binding.title;
      target.updatedAt = this.#now();
      state.activeSessionId = sessionId;
      state.sessions = [target, ...state.sessions.filter((item) => item.sessionId !== sessionId)].slice(0, MAX_SESSIONS);
      await this.#save(state);
      return { ...target };
    });
  }

  touch(sessionId: string): Promise<void> {
    return this.#enqueue(async () => {
      const state = await this.#load();
      const target = state.sessions.find((item) => item.sessionId === sessionId);
      if (!target) return;
      target.updatedAt = this.#now();
      state.activeSessionId = sessionId;
      state.sessions = [target, ...state.sessions.filter((item) => item.sessionId !== sessionId)].slice(0, MAX_SESSIONS);
      await this.#save(state);
    });
  }

  async findByThread(threadId: string): Promise<AgentSessionRecord | null> {
    const state = await this.read();
    return state.sessions.find((item) => item.threadId === threadId) ?? null;
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<AgentSessionsState> {
    if (this.#cached !== null) return this.#cached;
    try {
      this.#cached = normalizeState(JSON.parse(await readFile(this.#file, "utf8")));
    } catch {
      this.#cached = emptyState();
    }
    return this.#cached;
  }

  async #save(state: AgentSessionsState): Promise<void> {
    this.#cached = state;
    await writeFileAtomic(this.#file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.#file, 0o600);
  }
}
