import { describe, expect, it } from "bun:test";

import { loadChunk, type ChunkReloadEnv } from "../../src/lib/load-chunk.js";

function env(stored: string | null, now = 100_000): ChunkReloadEnv & { reloads: number; stored: string | null } {
  const state = {
    reloads: 0,
    stored,
    now: () => now,
    read: () => state.stored,
    write: (value: string) => { state.stored = value; },
    reload: () => { state.reloads += 1; },
  };
  return state;
}

const missing = () => Promise.reject(new Error("Failed to fetch dynamically imported module"));

describe("按需加载的页面块", () => {
  it("加载成功原样返回，不刷新", async () => {
    const e = env(null);
    expect(await loadChunk(() => Promise.resolve(42), e)).toBe(42);
    expect(e.reloads).toBe(0);
  });

  it("升级后旧块缺失：刷新一次并记下时间", async () => {
    const e = env(null);
    void loadChunk(missing, e);
    await Bun.sleep(0);
    expect(e.reloads).toBe(1);
    expect(e.stored).toBe("100000");
  });

  it("10 秒内已经刷新过：不再刷新，把错误抛出去", async () => {
    const e = env("95000");
    await expect(loadChunk(missing, e)).rejects.toThrow("dynamically imported");
    expect(e.reloads).toBe(0);
  });

  it("上次刷新已超过 10 秒：可以再刷新", async () => {
    const e = env("80000");
    void loadChunk(missing, e);
    await Bun.sleep(0);
    expect(e.reloads).toBe(1);
  });
});
