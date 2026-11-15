import { describe, expect, test } from "bun:test";

import { createPrefs, isPrefKey, type PrefsPatch } from "../../src/lib/prefs.js";

function memoryLegacy(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

function setup(options: {
  initial?: Record<string, string> | null;
  legacy?: Record<string, string>;
  fail?: boolean;
} = {}) {
  const pushed: PrefsPatch[] = [];
  const errors: unknown[] = [];
  const legacy = memoryLegacy(options.legacy);
  const p = createPrefs({
    initial: options.initial === undefined ? {} : options.initial,
    legacy,
    isPrefKey,
    legacyKeys: () => [...legacy.store.keys()],
    delayMs: 10_000,
    push: async (patch) => {
      pushed.push(patch);
      if (options.fail) throw new Error("down");
    },
    onError: (error) => void errors.push(error),
  });
  return { p, pushed, errors, legacy };
}

describe("prefs", () => {
  test("读取来自初始值，不碰 legacy", () => {
    const { p } = setup({ initial: { "knowledge-wide": "1" }, legacy: { "knowledge-wide": "0" } });
    expect(p.getItem("knowledge-wide")).toBe("1");
    expect(p.getItem("nope")).toBeNull();
  });

  test("setItem 立刻可读，并在延迟后合并成一次 push", async () => {
    const { p, pushed } = setup();
    p.setItem("you-brain.deck.view", "t3");
    p.setItem("knowledge-wide", "1");
    expect(p.getItem("you-brain.deck.view")).toBe("t3");
    await p.flush();
    expect(pushed).toEqual([{ set: { "you-brain.deck.view": "t3", "knowledge-wide": "1" } }]);
  });

  test("removeItem 进入 remove 列表", async () => {
    const { p, pushed } = setup({ initial: { "knowledge-wide": "1" } });
    p.removeItem("knowledge-wide");
    expect(p.getItem("knowledge-wide")).toBeNull();
    await p.flush();
    expect(pushed).toEqual([{ remove: ["knowledge-wide"] }]);
  });

  test("同一键先设后删，只发删除", async () => {
    const { p, pushed } = setup();
    p.setItem("knowledge-wide", "1");
    p.removeItem("knowledge-wide");
    await p.flush();
    expect(pushed).toEqual([{ remove: ["knowledge-wide"] }]);
  });

  test("首次启动把 legacy 里有、初始值里没有的偏好键迁移过来", async () => {
    const { p, pushed } = setup({
      initial: { "knowledge-wide": "0" },
      legacy: { "you-brain-theme": "dark", "you-brain.boot-snapshot": "{}", "knowledge-wide": "1" },
    });
    await p.flush();
    expect(pushed).toEqual([{ set: { "you-brain-theme": "dark" } }]);
    expect(p.getItem("knowledge-wide")).toBe("0");
    expect(p.getItem("you-brain.boot-snapshot")).toBeNull();
  });

  test("push 失败时值在本次仍可读，并调用一次 onError", async () => {
    const { p, errors } = setup({ fail: true });
    p.setItem("knowledge-wide", "1");
    await p.flush();
    expect(p.getItem("knowledge-wide")).toBe("1");
    expect(errors).toHaveLength(1);
  });

  test("没有注入（initial 为 null）时整体退回 legacy 读写，不调用 push", async () => {
    const { p, pushed, legacy } = setup({ initial: null, legacy: { "knowledge-wide": "1" } });
    expect(p.getItem("knowledge-wide")).toBe("1");
    p.setItem("you-brain-theme", "dark");
    expect(legacy.store.get("you-brain-theme")).toBe("dark");
    p.removeItem("knowledge-wide");
    expect(legacy.store.has("knowledge-wide")).toBe(false);
    await p.flush();
    expect(pushed).toEqual([]);
  });

  test("isPrefKey 认得精确键和三个前缀，不认两个缓存键", () => {
    expect(isPrefKey("you-brain-theme")).toBe(true);
    expect(isPrefKey("knowledge-sidebar-w")).toBe(true);
    expect(isPrefKey("you-brain:knowledge:db-view:abc")).toBe(true);
    expect(isPrefKey("you-brain.deck.terminal-font")).toBe(true);
    expect(isPrefKey("you-brain.memory.x")).toBe(true);
    expect(isPrefKey("you-brain.boot-snapshot")).toBe(false);
    expect(isPrefKey("you-brain:knowledge:v1")).toBe(false);
  });
});
