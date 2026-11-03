import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../domain/atomic.js";
import type { DeckConfig, DeckConversation, DeckTask } from "./types.js";

/** 指挥台本地存储：`<dataDir>/deck/`（不进 Drive；会话原文由 session-sync 上传）。 */
export class DeckStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get root(): string {
    return this.#dir;
  }

  async init(): Promise<void> {
    await mkdir(join(this.#dir, "conversations"), { recursive: true });
  }

  // ---- 会话 ----

  async listConversations(): Promise<DeckConversation[]> {
    const dir = join(this.#dir, "conversations");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const conversations: DeckConversation[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(dir, name), "utf8");
        conversations.push(JSON.parse(raw) as DeckConversation);
      } catch {
        continue;
      }
    }
    conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return conversations;
  }

  async getConversation(id: string): Promise<DeckConversation | null> {
    try {
      const raw = await readFile(this.#conversationPath(id), "utf8");
      return JSON.parse(raw) as DeckConversation;
    } catch {
      return null;
    }
  }

  async saveConversation(conversation: DeckConversation): Promise<void> {
    await writeFileAtomic(this.#conversationPath(conversation.id), JSON.stringify(conversation, null, 2), {
      mode: 0o600,
    });
  }

  async deleteConversation(id: string): Promise<boolean> {
    try {
      await rm(this.#conversationPath(id), { force: false });
      return true;
    } catch {
      return false;
    }
  }

  #conversationPath(id: string): string {
    // id 来自 ulid 或本模块生成的固定前缀，不做路径代换。
    return join(this.#dir, "conversations", `${id.replace(/[^A-Za-z0-9_-]/gu, "")}.json`);
  }

  // ---- 周期任务 ----

  async listTasks(): Promise<DeckTask[]> {
    try {
      const raw = await readFile(join(this.#dir, "tasks.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const tasks = (parsed as { tasks?: unknown })?.tasks;
      return Array.isArray(tasks) ? (tasks as DeckTask[]) : [];
    } catch {
      return [];
    }
  }

  async saveTasks(tasks: readonly DeckTask[]): Promise<void> {
    await writeFileAtomic(
      join(this.#dir, "tasks.json"),
      JSON.stringify({ version: 1, tasks }, null, 2),
      { mode: 0o600 },
    );
  }

  // ---- 配置 ----

  async readConfig(): Promise<DeckConfig> {
    try {
      const raw = await readFile(join(this.#dir, "config.json"), "utf8");
      return JSON.parse(raw) as DeckConfig;
    } catch {
      return {};
    }
  }

  async writeConfig(config: DeckConfig): Promise<void> {
    await writeFileAtomic(join(this.#dir, "config.json"), JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
  }
}
