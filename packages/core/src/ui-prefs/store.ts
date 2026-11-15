import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 界面偏好：只认键和值，不关心具体含义。 */
export type UiPrefs = Record<string, string>;

export interface UiPrefsPatch {
  set?: Record<string, string>;
  remove?: string[];
}

export const UI_PREFS_KEY_MAX = 200;
export const UI_PREFS_VALUE_MAX = 65_536;
export const UI_PREFS_FILE_MAX = 1_048_576;

/** 键、值或整个文件超出限制。 */
export class UiPrefsLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiPrefsLimitError";
  }
}

/**
 * 把界面偏好存成数据目录下的一个 JSON 文件。
 * 偏好放在 daemon 这边，是因为页面来自随机端口，重启后浏览器的 localStorage 会丢。
 * 写入串行，先写临时文件再 rename，中途崩溃也不会留下半截文件。
 */
export class UiPrefsStore {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  read(): Promise<UiPrefs> {
    return this.#enqueue(() => this.#load());
  }

  patch(input: UiPrefsPatch): Promise<UiPrefs> {
    return this.#enqueue(async () => {
      const next = await this.#load();
      for (const [key, value] of Object.entries(input.set ?? {})) {
        if (key.length < 1 || key.length > UI_PREFS_KEY_MAX) {
          throw new UiPrefsLimitError(`偏好键长度必须在 1 到 ${UI_PREFS_KEY_MAX} 个字符之间`);
        }
        if (value.length > UI_PREFS_VALUE_MAX) {
          throw new UiPrefsLimitError(`单个偏好值不能超过 ${UI_PREFS_VALUE_MAX} 个字符`);
        }
        next[key] = value;
      }
      for (const key of input.remove ?? []) delete next[key];
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > UI_PREFS_FILE_MAX) {
        throw new UiPrefsLimitError(`偏好文件不能超过 ${UI_PREFS_FILE_MAX} 字节`);
      }
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, this.file);
      return next;
    });
  }

  /** 前一次失败不影响后一次，所以链上吞掉错误，调用方仍拿到各自的结果。 */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<UiPrefs> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // 文件损坏：改名保留现场，当作没有偏好，避免首页因此打不开。
      await rename(this.file, `${this.file}.bad-${Date.now()}`).catch(() => undefined);
      return {};
    }
    const prefs: UiPrefs = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") prefs[key] = value;
    }
    return prefs;
  }
}
