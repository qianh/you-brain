import { describe, expect, it } from "bun:test";

import { parseAntigravityQuota } from "../../src/quota/antigravity.js";
import { QuotaService } from "../../src/quota/service.js";

const OUTPUT = [
  "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-28T12:38:58Z",
  "Gemini Models\tFive Hour Limit Remaining\t75.5%\t2026-11-21T17:38:58Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z",
  "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t40%\t2026-11-28T12:38:58Z",
  "",
].join("\n");

describe("parseAntigravityQuota", () => {
  it("turns remaining into used, names windows by span and group, and treats the epoch as no reset", () => {
    expect(parseAntigravityQuota(OUTPUT)).toEqual([
      { name: "7 days · Gemini", used: 0, resetsAt: "2026-11-28T12:38:58.000Z" },
      { name: "5 hours · Gemini", used: 24.5, resetsAt: "2026-11-21T17:38:58.000Z" },
      { name: "7 days · Claude+GPT", used: 0, resetsAt: null },
      { name: "7 days · Gemini 4 Argon", used: 60, resetsAt: "2026-11-28T12:38:58.000Z" },
    ]);
  });

  it("is null for anything that is not the table", () => {
    expect(parseAntigravityQuota("")).toBeNull();
    expect(parseAntigravityQuota("Please sign in first")).toBeNull();
  });
});

describe("QuotaService with Antigravity", () => {
  const magpie = JSON.stringify([]);
  function service(read: () => Promise<string>, clock: { now: number }): QuotaService {
    return new QuotaService({
      read: async () => magpie,
      readTokens: async () => "",
      readClaudeLive: async () => { throw new Error("no"); },
      readAntigravity: read,
      nowMs: () => clock.now,
    });
  }

  it("adds an antigravity account, asks at most every five minutes, and survives a failure", async () => {
    const clock = { now: Date.parse("2026-11-21T10:00:00Z") };
    let calls = 0;
    let fail = false;
    const quota = service(async () => {
      calls += 1;
      if (fail) throw new Error("agy 退出码 1");
      return OUTPUT;
    }, clock);
    await quota.refresh();
    expect(quota.snapshot().accounts.map((account) => [account.agent, account.windows.length])).toEqual([["antigravity", 4]]);
    clock.now += 60_000;
    await quota.refresh();
    expect(calls).toBe(1);
    clock.now += 5 * 60_000;
    fail = true;
    await quota.refresh();
    expect(calls).toBe(2);
    expect(quota.snapshot().accounts.map((account) => account.agent)).toEqual(["antigravity"]);
  });

  it("shows nothing when agy is missing", async () => {
    const quota = service(async () => { throw new Error("没有找到 agy"); }, { now: 1_000_000 });
    await quota.refresh();
    expect(quota.snapshot().accounts).toEqual([]);
  });
});

describe("QuotaService without magpie", () => {
  it("still serves Antigravity when magpie fails", async () => {
    const quota = new QuotaService({
      read: async () => { throw new Error("没有找到 magpie"); },
      readTokens: async () => "",
      readClaudeLive: async () => { throw new Error("no"); },
      readAntigravity: async () => OUTPUT,
      nowMs: () => 1_000_000,
    });
    await quota.refresh();
    const view = quota.snapshot();
    expect(view.readAt).not.toBeNull();
    expect(view.accounts.map((account) => account.agent)).toEqual(["antigravity"]);
  });
});
