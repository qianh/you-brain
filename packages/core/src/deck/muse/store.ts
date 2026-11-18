import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DeckMuseImageView, DeckMuseMessage } from "./types.js";

export const MAIN_MUSE_SESSION_ID = "main";
const MAX_MESSAGES_PER_SESSION = 250;
const MAX_SESSIONS = 100;
/** Keep inline image previews only when reasonably compact so chats.json stays fast. */
const MAX_INLINE_PREVIEW_CHARS = 360_000;

export interface StoredMuseSession {
  id: string;
  kind: "main" | "side";
  title: string;
  autoTitle: boolean;
  createdAt: string;
  updatedAt: string;
  /** Whether the side chat has already had at least one message acknowledged by Muse VM. */
  initializedOnServer: boolean;
  messages: DeckMuseMessage[];
}

interface StoredFile {
  version: 1;
  selectedVmId: string | null;
  sessions: StoredMuseSession[];
}

function defaultMainSession(nowIso: string): StoredMuseSession {
  return {
    id: MAIN_MUSE_SESSION_ID,
    kind: "main",
    title: "Muse 主对话",
    autoTitle: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    initializedOnServer: true,
    messages: [],
  };
}

function summarizeTitle(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  if (!line) return "新会话";
  return [...line].slice(0, 28).join("") + ([...line].length > 28 ? "…" : "");
}

export function previewOf(messages: readonly DeckMuseMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  const cleaned = last.text.replace(/\s+/gu, " ").trim();
  if (cleaned) return [...cleaned].slice(0, 80).join("");
  if (last.images && last.images.length > 0) return `[图片 ×${last.images.length}]`;
  return "";
}

export function compactImages(images: readonly DeckMuseImageView[] | undefined): DeckMuseImageView[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((item) => ({
    filename: item.filename,
    mimeType: item.mimeType,
    ...(item.dataUrl && item.dataUrl.length <= MAX_INLINE_PREVIEW_CHARS ? { dataUrl: item.dataUrl } : {}),
  }));
}

export class MuseChatStore {
  #loaded: StoredFile | null = null;
  #loading: Promise<StoredFile> | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async #ensureLoaded(): Promise<StoredFile> {
    if (this.#loaded) return this.#loaded;
    if (this.#loading) return this.#loading;
    const task = this.#loadFromDisk();
    this.#loading = task;
    try {
      const loaded = await task;
      this.#loaded = loaded;
      return loaded;
    } finally {
      if (this.#loading === task) this.#loading = null;
    }
  }

  async #loadFromDisk(): Promise<StoredFile> {
    const nowIso = this.now().toISOString();
    let parsed: Partial<StoredFile> | null = null;
    try {
      const raw = await readFile(this.file, "utf8");
      const json = JSON.parse(raw) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = json as Partial<StoredFile>;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await rename(this.file, `${this.file}.bad-${Date.now()}`).catch(() => undefined);
      }
    }
    const rawSessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const sessions: StoredMuseSession[] = [];
    let hasMain = false;
    for (const entry of rawSessions) {
      if (!entry || typeof entry !== "object") continue;
      const id = typeof entry.id === "string" && entry.id ? entry.id : "";
      if (!id) continue;
      const kind = id === MAIN_MUSE_SESSION_ID ? "main" : "side";
      if (kind === "main") {
        if (hasMain) continue;
        hasMain = true;
      }
      const messages = Array.isArray(entry.messages)
        ? entry.messages.filter(
            (m): m is DeckMuseMessage =>
              !!m &&
              typeof m === "object" &&
              typeof m.id === "string" &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.text === "string",
          )
        : [];
      sessions.push({
        id,
        kind,
        title:
          kind === "main"
            ? "Muse 主对话"
            : typeof entry.title === "string" && entry.title.trim()
              ? entry.title.trim()
              : "新会话",
        autoTitle: kind === "main" ? false : entry.autoTitle === true,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : nowIso,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : nowIso,
        initializedOnServer: kind === "main" ? true : entry.initializedOnServer === true,
        messages: messages.slice(-MAX_MESSAGES_PER_SESSION),
      });
    }
    if (!hasMain) {
      sessions.unshift(defaultMainSession(nowIso));
    }
    return {
      version: 1,
      selectedVmId: typeof parsed?.selectedVmId === "string" ? parsed.selectedVmId : null,
      sessions,
    };
  }

  #scheduleSave(): Promise<void> {
    const snapshot = this.#loaded ? JSON.stringify(this.#loaded) : null;
    if (snapshot === null) return Promise.resolve();
    const task = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.file);
    };
    const next = this.#writeQueue.then(task, task);
    this.#writeQueue = next.catch(() => undefined);
    return next;
  }

  async selectedVmId(): Promise<string | null> {
    return (await this.#ensureLoaded()).selectedVmId;
  }

  async setSelectedVmId(vmId: string | null): Promise<void> {
    const data = await this.#ensureLoaded();
    data.selectedVmId = vmId;
    await this.#scheduleSave();
  }

  async listSessions(): Promise<StoredMuseSession[]> {
    const data = await this.#ensureLoaded();
    const main = data.sessions.find((s) => s.id === MAIN_MUSE_SESSION_ID)!;
    const sides = data.sessions
      .filter((s) => s.id !== MAIN_MUSE_SESSION_ID)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [main, ...sides];
  }

  async getSession(id: string): Promise<StoredMuseSession | null> {
    const data = await this.#ensureLoaded();
    const found = data.sessions.find((s) => s.id === id);
    return found ? structuredClone(found) : null;
  }

  async createSideSession(title?: string): Promise<StoredMuseSession> {
    const data = await this.#ensureLoaded();
    const sideCount = data.sessions.filter((s) => s.kind === "side").length;
    if (sideCount >= MAX_SESSIONS) {
      throw new Error(`独立会话数量已达上限（${MAX_SESSIONS} 个），请先清理旧会话。`);
    }
    const nowIso = this.now().toISOString();
    const cleanTitle = title?.trim() ?? "";
    const created: StoredMuseSession = {
      id: randomUUID(),
      kind: "side",
      title: cleanTitle || "新会话",
      autoTitle: cleanTitle === "",
      createdAt: nowIso,
      updatedAt: nowIso,
      initializedOnServer: false,
      messages: [],
    };
    data.sessions.push(created);
    await this.#scheduleSave();
    return structuredClone(created);
  }

  async renameSession(id: string, title: string): Promise<StoredMuseSession> {
    if (id === MAIN_MUSE_SESSION_ID) {
      throw new Error("主对话名称固定，不支持重命名");
    }
    const clean = title.trim();
    if (!clean) throw new Error("会话标题不能为空");
    const data = await this.#ensureLoaded();
    const target = data.sessions.find((s) => s.id === id);
    if (!target) throw new Error("找不到该 Muse 会话");
    target.title = [...clean].slice(0, 60).join("");
    target.autoTitle = false;
    await this.#scheduleSave();
    return structuredClone(target);
  }

  async deleteOrClearSession(id: string): Promise<void> {
    const data = await this.#ensureLoaded();
    if (id === MAIN_MUSE_SESSION_ID) {
      const main = data.sessions.find((s) => s.id === MAIN_MUSE_SESSION_ID);
      if (main) {
        main.messages = [];
        main.updatedAt = this.now().toISOString();
        await this.#scheduleSave();
      }
      return;
    }
    data.sessions = data.sessions.filter((s) => s.id !== id);
    await this.#scheduleSave();
  }

  async markInitializedOnServer(id: string): Promise<void> {
    const data = await this.#ensureLoaded();
    const target = data.sessions.find((s) => s.id === id);
    if (!target || target.initializedOnServer) return;
    target.initializedOnServer = true;
    await this.#scheduleSave();
  }

  async upsertMessage(
    sessionId: string,
    message: DeckMuseMessage,
    options: { persist?: boolean; replaceId?: string } = {},
  ): Promise<StoredMuseSession> {
    const data = await this.#ensureLoaded();
    const target = data.sessions.find((s) => s.id === sessionId);
    if (!target) throw new Error("找不到该 Muse 会话");

    const searchIds = new Set([message.id, ...(options.replaceId ? [options.replaceId] : [])]);
    const index = target.messages.findIndex((m) => searchIds.has(m.id));
    if (index >= 0) {
      const existing = target.messages[index]!;
      target.messages[index] = {
        ...existing,
        ...message,
        createdAt: existing.createdAt,
        images: message.images ?? existing.images,
      };
    } else {
      target.messages.push(message);
      if (target.messages.length > MAX_MESSAGES_PER_SESSION) {
        target.messages.splice(0, target.messages.length - MAX_MESSAGES_PER_SESSION);
      }
      if (target.kind === "side" && target.autoTitle && message.role === "user" && message.text.trim()) {
        target.title = summarizeTitle(message.text);
        target.autoTitle = false;
      }
    }
    target.updatedAt = this.now().toISOString();
    if (options.persist !== false) {
      await this.#scheduleSave();
    }
    return structuredClone(target);
  }

  async flush(): Promise<void> {
    await this.#scheduleSave();
  }

  async mergeMainHistory(incoming: readonly DeckMuseMessage[]): Promise<boolean> {
    if (incoming.length === 0) return false;
    const data = await this.#ensureLoaded();
    const main = data.sessions.find((s) => s.id === MAIN_MUSE_SESSION_ID);
    if (!main) return false;

    const inFlightLocal: DeckMuseMessage[] = [];
    const byId = new Map<string, DeckMuseMessage>();
    for (const msg of main.messages) {
      if (msg.id.startsWith("local:")) {
        inFlightLocal.push(msg);
      } else {
        byId.set(msg.id, msg);
      }
    }
    let changed = false;
    for (const item of incoming) {
      const existing = byId.get(item.id);
      if (!existing) {
        byId.set(item.id, item);
        changed = true;
      } else if (
        existing.text !== item.text ||
        existing.createdAt !== item.createdAt ||
        (!existing.done && item.done)
      ) {
        byId.set(item.id, {
          ...existing,
          text: item.text,
          createdAt: item.createdAt,
          done: item.done,
        });
        changed = true;
      }
    }
    if (!changed) return false;
    const sorted = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    main.messages = [...sorted, ...inFlightLocal].slice(-MAX_MESSAGES_PER_SESSION);
    const newest = main.messages.at(-1);
    if (newest) main.updatedAt = newest.createdAt;
    await this.#scheduleSave();
    return true;
  }
}
