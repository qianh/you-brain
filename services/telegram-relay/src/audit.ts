import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 中转审计日志：只记时间、来源、目标、动作类型与结果。
 * 绝不记录 cmd.args、result、设备令牌或邀请码。
 */
export interface RelayAuditEntry {
  ts: number;
  from: string | null;
  to: string | null;
  kind: string;
  outcome: string;
}

const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

/** 追加写 `<dataDir>/audit.jsonl`（权限 0600），超过 5 MB 时轮转为 `audit.jsonl.1`。 */
export class RelayAuditLog {
  readonly #file: string;
  readonly #rotateBytes: number;
  #pending: Promise<void> = Promise.resolve();

  constructor(dataDir: string, rotateBytes = DEFAULT_ROTATE_BYTES) {
    this.#file = join(dataDir, "audit.jsonl");
    this.#rotateBytes = rotateBytes;
  }

  file(): string {
    return this.#file;
  }

  write(entry: RelayAuditEntry): Promise<void> {
    const row: RelayAuditEntry = {
      ts: entry.ts,
      from: entry.from,
      to: entry.to,
      kind: entry.kind,
      outcome: entry.outcome,
    };
    const line = `${JSON.stringify(row)}\n`;
    const task = this.#pending.then(() => this.#append(line));
    this.#pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  drain(): Promise<void> {
    return this.#pending;
  }

  async #append(line: string): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    try {
      const info = await stat(this.#file);
      if (info.size >= this.#rotateBytes) {
        await rename(this.#file, `${this.#file}.1`);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    await appendFile(this.#file, line, { encoding: "utf8", mode: 0o600 });
    await chmod(this.#file, 0o600);
  }
}
