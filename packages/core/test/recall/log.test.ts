import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RECALL_LOG_MAX_LINES, createRecallLog } from "../../src/recall/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function entry(n: number) {
  return { ts: "2026-11-16T08:00:00.000Z", sessionKey: `s${n}`, topicId: "t", outcome: "silent" as const };
}

describe("createRecallLog", () => {
  it("超过 2000 行时只保留最新 2000 行，文件权限 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-log-"));
    dirs.push(dir);
    const path = join(dir, "recall-log.jsonl");
    const write = createRecallLog(path);
    for (let n = 0; n < RECALL_LOG_MAX_LINES + 5; n += 1) write(entry(n));
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(RECALL_LOG_MAX_LINES);
    expect(JSON.parse(lines[0] as string).sessionKey).toBe("s5");
    expect(JSON.parse(lines.at(-1) as string).sessionKey).toBe(`s${RECALL_LOG_MAX_LINES + 4}`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("重新创建后接着已有的行数计，不会让文件无限增长", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-log-"));
    dirs.push(dir);
    const path = join(dir, "recall-log.jsonl");
    const first = createRecallLog(path);
    for (let n = 0; n < RECALL_LOG_MAX_LINES; n += 1) first(entry(n));
    const second = createRecallLog(path);
    second(entry(9999));
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(RECALL_LOG_MAX_LINES);
    expect(JSON.parse(lines.at(-1) as string).sessionKey).toBe("s9999");
  });
});
