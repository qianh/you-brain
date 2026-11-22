import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** 只记谁、什么指令、结果。调用方不得把 prompt 或 args 正文放进来。 */
export interface AuditEntry {
  ts: number;
  from: string;
  kind: string;
  outcome: string;
  reason?: string;
}

const ROTATE_BYTES = 1_048_576;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** 追加 `<dataDir>/dispatch/audit.jsonl`。超过 1 MB 时轮转成 `audit.jsonl.1`（覆盖旧档）。 */
export class AuditLog {
  readonly #file: string;

  constructor(dataDir: string) {
    this.#file = join(dataDir, "dispatch", "audit.jsonl");
  }

  file(): string {
    return this.#file;
  }

  async write(entry: AuditEntry): Promise<void> {
    await mkdir(join(this.#file, ".."), { recursive: true });
    try {
      const info = await stat(this.#file);
      if (info.size >= ROTATE_BYTES) await rename(this.#file, `${this.#file}.1`);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const row: AuditEntry = { ts: entry.ts, from: entry.from, kind: entry.kind, outcome: entry.outcome };
    if (entry.reason !== undefined) row.reason = entry.reason;
    await appendFile(this.#file, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
