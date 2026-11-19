import { describe, expect, it } from "bun:test";

import type { T3ThreadBrief } from "../../src/deck/t3/automation.js";
import { T3ThreadWatcher, diffT3Threads, type T3Notice } from "../../src/deck/t3/watch.js";

function thread(threadId: string, status: string, latestRunId: string | null = "run-1", extra: Partial<T3ThreadBrief> = {}): T3ThreadBrief {
  return { threadId, title: threadId.toUpperCase(), status, latestRunId, snoozed: false, link: null, ...extra };
}

const seen = (...entries: Array<[string, string, string | null]>) =>
  new Map(entries.map(([id, status, run]) => [id, { status, latestRunId: run }]));

describe("diffT3Threads", () => {
  it("only builds a baseline the first time", () => {
    expect(diffT3Threads(null, [thread("a", "completed")])).toEqual([]);
  });

  it("reports finished, waiting and failed turns", () => {
    const notices = diffT3Threads(seen(["a", "running", "run-1"], ["b", "running", "run-1"], ["c", "running", "run-1"]), [
      thread("a", "completed"),
      thread("b", "waiting"),
      thread("c", "failed"),
    ]);
    expect(notices.map((item) => [item.threadId, item.kind])).toEqual([
      ["a", "done"],
      ["b", "waiting"],
      ["c", "failed"],
    ]);
  });

  it("catches a whole turn that ran between two polls", () => {
    expect(diffT3Threads(seen(["a", "completed", "run-1"]), [thread("a", "completed", "run-2")])).toHaveLength(1);
  });

  it("ignores unchanged, new and snoozed threads", () => {
    expect(
      diffT3Threads(seen(["a", "completed", "run-1"], ["s", "running", "run-1"]), [
        thread("a", "completed"),
        thread("new", "completed"),
        thread("s", "completed", "run-1", { snoozed: true }),
      ]),
    ).toEqual([]);
  });

  it("reports an answered approval that then completes", () => {
    expect(diffT3Threads(seen(["a", "waiting", "run-1"]), [thread("a", "completed")])[0]?.kind).toBe("done");
  });
});

describe("T3ThreadWatcher", () => {
  it("polls only while enabled and starts a fresh baseline after being re-enabled", async () => {
    let enabled = true;
    let threads = [thread("a", "running")];
    const notices: T3Notice[] = [];
    let lists = 0;
    const watcher = new T3ThreadWatcher({
      list: async () => {
        lists += 1;
        return threads;
      },
      enabled: () => enabled,
      onNotice: (notice) => notices.push(notice),
    });
    await watcher.tick();
    threads = [thread("a", "completed")];
    await watcher.tick();
    expect(notices.map((item) => item.kind)).toEqual(["done"]);
    expect(watcher.statusOf("a")).toBe("completed");

    enabled = false;
    threads = [thread("a", "running", "run-2")];
    await watcher.tick();
    expect(lists).toBe(2);
    enabled = true;
    threads = [thread("a", "completed", "run-2")];
    await watcher.tick();
    expect(notices).toHaveLength(1);
    watcher.stop();
  });

  it("keeps running after a failed list", async () => {
    let fail = true;
    const watcher = new T3ThreadWatcher({
      list: async () => {
        if (fail) throw new Error("T3 down");
        return [];
      },
      enabled: () => true,
      onNotice: () => undefined,
    });
    await watcher.tick();
    fail = false;
    await watcher.tick();
    watcher.stop();
  });
});
