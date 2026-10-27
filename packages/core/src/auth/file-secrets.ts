import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeFileAtomic } from "../domain/atomic.js";
import type { SecretStore } from "./secret-store.js";

/**
 * 无界面服务器上的密钥后端。
 *
 * Linux 的钥匙串走 `secret-tool`，需要 Secret Service 在会话总线里运行。7×24 的
 * 服务器通常没有图形会话，也没有 gnome-keyring / kwallet，`secret-tool` 会直接失败。
 * 这个后端把密钥写进数据目录下的一个 JSON 文件，权限 0600，由操作系统的文件权限
 * 保护，而不是靠桌面会话的钥匙串。
 *
 * 只在显式选择时使用（`YOU_BRAIN_SECRET_BACKEND=file`），桌面端仍走钥匙串。
 */
export interface FileSecretStoreOptions {
  path: string;
  /** 注入读文件，测试用。 */
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, data: string) => Promise<void>;
}

type SecretsFile = Record<string, string>;

/**
 * 同一个文件可能被多个 store 实例写（config、oauth client secret、每个 provider 的 key），
 * 而它们是不同对象。读写改写的队列必须按路径共享，否则并发写入会互相覆盖。
 */
const pathQueues = new Map<string, Promise<unknown>>();

export function fileSecretKey(service: string, account: string): string {
  return `${service}\u0000${account}`;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

function parseSecrets(text: string | null): SecretsFile {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 文件被截断或手改坏了。宁可从空开始，也不要让 daemon 起不来。
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const result: SecretsFile = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export class FileSecretStore implements SecretStore {
  readonly #path: string;
  readonly #read: (path: string) => Promise<string | null>;
  readonly #write: (path: string, data: string) => Promise<void>;

  constructor(
    readonly service: string,
    readonly account: string,
    options: FileSecretStoreOptions,
  ) {
    this.#path = options.path;
    this.#read = options.read ?? readFileOrNull;
    this.#write = options.write ?? ((path, data) => writeFileAtomic(path, data, { mode: 0o600 }));
  }

  get path(): string {
    return this.#path;
  }

  async probe(): Promise<void> {
    // 文件后端没有需要先探活的守护进程。
    return undefined;
  }

  async get(): Promise<string | null> {
    const all = parseSecrets(await this.#read(this.#path));
    return all[fileSecretKey(this.service, this.account)] ?? null;
  }

  async set(value: string): Promise<void> {
    await this.#mutate((all) => {
      all[fileSecretKey(this.service, this.account)] = value;
    });
  }

  async delete(): Promise<void> {
    await this.#mutate((all) => {
      delete all[fileSecretKey(this.service, this.account)];
    });
  }

  #mutate(change: (all: SecretsFile) => void): Promise<void> {
    const key = resolve(this.#path);
    const previous = pathQueues.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const all = parseSecrets(await this.#read(this.#path));
      change(all);
      await this.#write(this.#path, `${JSON.stringify(all, null, 2)}\n`);
    });
    // 一个失败的写入不能让后面的操作全部失败。
    const guarded = next.catch(() => undefined);
    pathQueues.set(key, guarded);
    void guarded.then(() => {
      // 队尾就是自己时才清掉，否则会丢掉后来者的排队。
      if (pathQueues.get(key) === guarded) pathQueues.delete(key);
    });
    return next;
  }
}
