import { describe, expect, test } from "bun:test";

import { createFocusStore } from "../../src/pages/knowledge/focus-store.js";

describe("knowledge focus store", () => {
  test("只通知目标块和上一个目标块", () => {
    const store = createFocusStore();
    const calls: string[] = [];
    const offA = store.subscribe("a", () => calls.push("a"));
    const offB = store.subscribe("b", () => calls.push("b"));
    const offC = store.subscribe("c", () => calls.push("c"));

    store.request({ blockId: "a", at: "end" });
    expect(calls).toEqual(["a"]);

    calls.length = 0;
    store.request({ blockId: "b", at: "start" });
    expect(calls.sort()).toEqual(["a", "b"]);

    calls.length = 0;
    store.clear();
    expect(calls).toEqual(["b"]);
    offA();
    offB();
    offC();
  });

  test("只有目标块读到请求,且引用在请求不变时稳定", () => {
    const store = createFocusStore();
    store.request({ blockId: "a", at: 3 });
    expect(store.forBlock("b")).toBeNull();
    const first = store.forBlock("a");
    expect(first).toEqual({ blockId: "a", at: 3 });
    expect(store.forBlock("a")).toBe(first);
    store.clear();
    expect(store.forBlock("a")).toBeNull();
  });

  test("同一块连续请求会再次触发", () => {
    const store = createFocusStore();
    let count = 0;
    store.subscribe("a", () => {
      count += 1;
    });
    store.request({ blockId: "a", at: "end" });
    const first = store.forBlock("a");
    store.request({ blockId: "a", at: "end" });
    expect(store.forBlock("a")).not.toBe(first);
    expect(count).toBe(2);
    store.clear();
  });

  test("取消订阅后不再通知", () => {
    const store = createFocusStore();
    let count = 0;
    const off = store.subscribe("a", () => {
      count += 1;
    });
    off();
    store.request({ blockId: "a", at: "end" });
    expect(count).toBe(0);
    store.clear();
  });
});
