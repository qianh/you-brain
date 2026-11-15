import { describe, expect, test } from "bun:test";

import { createLatencyProbe, summarize } from "../../src/pages/deck-terminal-latency.js";

describe("summarize", () => {
  test("奇数个取中间值，95 分位取最近排名", () => {
    expect(summarize([5, 1, 3])).toEqual({ count: 3, median: 3, p95: 5 });
  });

  test("偶数个中位数取中间两个的平均", () => {
    expect(summarize([4, 1, 3, 2])).toEqual({ count: 4, median: 2.5, p95: 4 });
  });

  test("20 个样本的 95 分位是第 19 个", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(summarize(samples).p95).toBe(19);
  });

  test("不改动传入的数组", () => {
    const samples = [3, 1, 2];
    summarize(samples);
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe("createLatencyProbe", () => {
  function setup(batch = 3) {
    let now = 0;
    const reports: Array<{ count: number; median: number; p95: number }> = [];
    const probe = createLatencyProbe({ batch, now: () => now, report: (stats) => reports.push(stats) });
    return { probe, reports, advance: (ms: number) => { now += ms; } };
  }

  test("每次输入到其后第一次写入完成的毫秒数，满一批输出一次", () => {
    const { probe, reports, advance } = setup(3);
    for (const delay of [10, 20, 30]) {
      probe.input();
      advance(delay);
      probe.written();
    }
    expect(reports).toEqual([{ count: 3, median: 20, p95: 30 }]);
  });

  test("一次写入完成会结算此前所有未结算的输入，各按自己的起点算", () => {
    const { probe, reports, advance } = setup(2);
    probe.input();
    advance(4);
    probe.input();
    advance(6);
    probe.written();
    expect(reports).toEqual([{ count: 2, median: 8, p95: 10 }]);
  });

  test("没有输入时的写入不记录", () => {
    const { probe, reports, advance } = setup(1);
    advance(5);
    probe.written();
    expect(reports).toEqual([]);
  });

  test("输出后重新开始计下一批", () => {
    const { probe, reports, advance } = setup(1);
    for (const delay of [5, 7]) {
      probe.input();
      advance(delay);
      probe.written();
    }
    expect(reports).toEqual([{ count: 1, median: 5, p95: 5 }, { count: 1, median: 7, p95: 7 }]);
  });

  test("超过 2 秒没有回显的输入丢弃，不当成延迟", () => {
    const { probe, reports, advance } = setup(1);
    probe.input();
    advance(2500);
    probe.input();
    advance(3);
    probe.written();
    expect(reports).toEqual([{ count: 1, median: 3, p95: 3 }]);
  });

  test("没有回显的输入不会无限堆积", () => {
    const { probe, reports, advance } = setup(1);
    for (let index = 0; index < 10_000; index += 1) probe.input();
    advance(1);
    probe.written();
    expect(reports.length).toBe(200);
  });
});
