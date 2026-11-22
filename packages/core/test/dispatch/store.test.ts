import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../../src/dispatch/audit.js";
import { Ledger, type DispatchRecord } from "../../src/dispatch/ledger.js";
import { PolicyStore } from "../../src/dispatch/policy.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yb-dispatch-store-"));
  dirs.push(dir);
  return dir;
}

function record(createdAt: number): DispatchRecord {
  return {
    threadId: "thread-1",
    from: "device-peer",
    projectId: "p1",
    title: "标题",
    createdAt,
    threadUrl: "http://127.0.0.1:3773/env/thread-1",
    mode: "auto",
    capped: false,
  };
}

describe("派活策略与账本文件", () => {
  test("发送方按 deviceId 去重，非法 maxMode 回落 auto", async () => {
    const dir = await tempDir();
    const store = new PolicyStore(dir);
    const written = await store.write({
      enabled: true,
      notify: false,
      maxMode: "full-access",
      allowedSenders: [
        { deviceId: "a", name: "旧", publicKey: "k1" },
        { deviceId: "a", name: "新", publicKey: "k2" },
        { deviceId: "b", name: "乙", publicKey: "k3" },
      ],
      allowedProjects: ["p1", "p1", ""],
    });
    expect(written.allowedSenders).toEqual([
      { deviceId: "a", name: "新", publicKey: "k2" },
      { deviceId: "b", name: "乙", publicKey: "k3" },
    ]);
    expect(written.allowedProjects).toEqual(["p1"]);
    expect(written.notify).toBe(false);

    await writeFile(store.file(), JSON.stringify({
      enabled: true,
      notify: false,
      maxMode: "root",
      allowedSenders: [],
      allowedProjects: ["p9"],
    }));
    expect(await store.read()).toMatchObject({ enabled: true, notify: false, maxMode: "auto", allowedProjects: ["p9"] });
  });

  test("账本保留 7 天且每张表最多 1000 条", async () => {
    const dir = await tempDir();
    let now = 0;
    const ledger = new Ledger(dir, () => now);
    for (let index = 0; index < 1001; index += 1) {
      now = index;
      await ledger.putCommand(`c-${index}`, { ok: true, result: { index } });
    }
    expect(await ledger.getCommand("c-0")).toBeNull();
    expect(await ledger.getCommand("c-1")).not.toBeNull();
    expect((await ledger.getCommand("c-1000"))?.result).toEqual({ ok: true, result: { index: 1000 } });

    now = 0;
    await ledger.putDispatch("d-old", record(0));
    now = 8 * 24 * 60 * 60 * 1000;
    await ledger.putCommand("fresh", { ok: true, result: {} });
    expect(await ledger.getDispatch("d-old")).toBeNull();
    expect(await ledger.getCommand("c-1000")).toBeNull();
    expect(await ledger.getCommand("fresh")).not.toBeNull();
  });

  test("审计超过 1MB 时轮转到 audit.jsonl.1 并覆盖旧档", async () => {
    const dir = await tempDir();
    const audit = new AuditLog(dir);
    await audit.write({ ts: 1, from: "a", kind: "t3.projects", outcome: "ok" });
    const file = audit.file();
    await writeFile(file, "x".repeat(1_048_576));
    await audit.write({ ts: 2, from: "b", kind: "t3.read", outcome: "rejected", reason: "未开启" });
    expect(await readFile(`${file}.1`, "utf8")).toBe("x".repeat(1_048_576));
    const fresh = await readFile(file, "utf8");
    expect(fresh).toContain("t3.read");
    expect(fresh).not.toContain("xxx");
    await writeFile(file, "y".repeat(1_048_576));
    await audit.write({ ts: 3, from: "c", kind: "t3.threads", outcome: "ok" });
    expect(await readFile(`${file}.1`, "utf8")).toBe("y".repeat(1_048_576));
  });
});
