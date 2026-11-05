import { describe, expect, test } from "bun:test";
import type { TopicReorganizeStatus } from "@you-brain/core/http/types.js";

import { formatElapsed, watchReorganize } from "../../../src/pages/topics/reorganize-logic.js";

const RUNNING: TopicReorganizeStatus = { state: "running", startedAt: "2026-11-04T10:00:00.000Z" };
const READY: TopicReorganizeStatus = {
  state: "ready",
  plan: { topicCount: 1, reviewedCount: 1, topicCountAfter: 1, groups: [] },
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function reader(answers: Array<TopicReorganizeStatus | Error>): {
  read: () => Promise<TopicReorganizeStatus>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    read: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (!answer) throw new Error("no answer");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe("watchReorganize", () => {
  test("keeps asking while the run is going and stops once it ends", async () => {
    const { read, calls } = reader([RUNNING, RUNNING, READY]);
    const seen: string[] = [];
    watchReorganize({
      read,
      onStatus: (status) => seen.push(status.state),
      onLost: () => seen.push("lost"),
      intervalMs: 1,
    });
    await wait(40);
    expect(seen).toEqual(["running", "running", "ready"]);
    expect(calls()).toBe(3);
  });

  test("a dropped request does not end the watch, and the run is still picked up", async () => {
    const { read } = reader([new Error("connection lost"), new Error("connection lost"), READY]);
    const seen: string[] = [];
    watchReorganize({
      read,
      onStatus: (status) => seen.push(status.state),
      onLost: () => seen.push("lost"),
      intervalMs: 1,
    });
    await wait(40);
    expect(seen).toEqual(["ready"]);
  });

  test("reports the daemon as lost after repeated failures, then stops asking", async () => {
    const { read, calls } = reader([new Error("connection lost")]);
    const seen: string[] = [];
    watchReorganize({
      read,
      onStatus: (status) => seen.push(status.state),
      onLost: () => seen.push("lost"),
      intervalMs: 1,
      maxMisses: 3,
    });
    await wait(40);
    expect(seen).toEqual(["lost"]);
    expect(calls()).toBe(3);
  });

  test("stop ends the watch, even with a request in flight", async () => {
    let release: (status: TopicReorganizeStatus) => void = () => undefined;
    const seen: string[] = [];
    const stop = watchReorganize({
      read: () => new Promise((resolve) => (release = resolve)),
      onStatus: (status) => seen.push(status.state),
      onLost: () => seen.push("lost"),
      intervalMs: 1,
    });
    await wait(10);
    stop();
    release(READY);
    await wait(10);
    expect(seen).toEqual([]);
  });
});

describe("formatElapsed", () => {
  test.each([
    [0, "0:00"],
    [-5_000, "0:00"],
    [59_999, "0:59"],
    [187_000, "3:07"],
    [3_727_000, "1:02:07"],
  ])("%d ms is %s", (ms, label) => {
    expect(formatElapsed(ms)).toBe(label);
  });
});
