import { describe, expect, it } from "bun:test";

import { parseMagpieAccounts } from "../../src/quota/parse.js";
import { QuotaService } from "../../src/quota/service.js";

const SAMPLE = JSON.stringify([
  {
    agent: "claude",
    user: "someone@example.com",
    plan: "pro",
    active: true,
    on: true,
    windows: [
      { name: "5 hours", used: 31, remaining: 69, resetsAt: "2026-11-17T00:10:00+08:00" },
      { name: "7 days · Fable", used: 49, remaining: 51, resetsAt: "2026-11-17T16:00:00+08:00" },
    ],
    readAt: "2026-11-16T20:06:09+08:00",
  },
  { agent: "copilot", user: "x", active: true, windows: [] },
  { agent: "grok", user: "y", active: false, windows: [{ name: "7 days", used: 2, remaining: 98 }] },
]);

describe("parseMagpieAccounts", () => {
  it("skips the plugin log line before the JSON and never keeps the email", () => {
    const parsed = parseMagpieAccounts(`2026/11/16 20:06:04 plugin: host starts with HTTPS_PROXY=x\n${SAMPLE}`);
    expect(parsed?.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        agent: "claude",
        plan: "pro",
        active: true,
        windows: [
          { name: "5 hours", used: 31, resetsAt: "2026-11-17T00:10:00+08:00" },
          { name: "7 days · Fable", used: 49, resetsAt: "2026-11-17T16:00:00+08:00" },
        ],
      },
      { agent: "copilot", plan: null, active: true, windows: [] },
      { agent: "grok", plan: null, active: false, windows: [{ name: "7 days", used: 2, resetsAt: null }] },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("example.com");
  });

  it("gives each account an id that is stable across reads and differs per sign-in", () => {
    const one = (user: string) =>
      parseMagpieAccounts(JSON.stringify([{ agent: "claude", user, active: true, windows: [] }]))?.[0]?.id;
    expect(one("a@x.com")).toBe(one("a@x.com"));
    expect(one("a@x.com")).not.toBe(one("b@x.com"));
    expect(one("a@x.com")).toMatch(/^[a-f0-9]{12}$/u);
  });

  it("keeps an account whose windows are unreadable, with no windows", () => {
    expect(
      parseMagpieAccounts(JSON.stringify([{ agent: "kiro", active: true, windows: [{ name: 3 }] }]))?.[0]?.windows,
    ).toEqual([]);
  });

  it("clamps the percentage into 0–100", () => {
    const parsed = parseMagpieAccounts(
      JSON.stringify([{ agent: "a", active: true, windows: [{ name: "w", used: 140 }, { name: "v", used: -3 }] }]),
    );
    expect(parsed?.[0]?.windows.map((window) => window.used)).toEqual([100, 0]);
  });

  it.each(["", "not json", "no array here\n{}", "[1,", '{"agent":"claude"}'])("is null for %j", (text) => {
    expect(parseMagpieAccounts(text)).toBeNull();
  });
});

function harness(reads: Array<() => Promise<string>>) {
  const clock = { now: Date.parse("2026-11-16T12:00:00Z") };
  let calls = 0;
  const service = new QuotaService({
    read: () => {
      const next = reads[Math.min(calls, reads.length - 1)];
      calls += 1;
      if (!next) throw new Error("no read");
      return next();
    },
    nowMs: () => clock.now,
  });
  return { service, clock, calls: () => calls };
}

describe("QuotaService", () => {
  it("starts empty, then serves the last good read", async () => {
    const { service } = harness([async () => SAMPLE]);
    expect(service.snapshot()).toEqual({ accounts: [], readAt: null, stale: false });
    await service.refresh();
    const view = service.snapshot();
    expect(view.accounts.map((account) => account.agent)).toEqual(["claude", "grok"]);
    expect(view.readAt).toBe("2026-11-16T12:00:00.000Z");
    expect(view.stale).toBe(false);
  });

  it("keeps the old numbers and marks them stale when a read fails", async () => {
    const { service, clock } = harness([
      async () => SAMPLE,
      async () => {
        throw new Error("timeout");
      },
    ]);
    await service.refresh();
    clock.now += 60_000;
    await service.refresh();
    const view = service.snapshot();
    expect(view.accounts).toHaveLength(2);
    expect(view.readAt).toBe("2026-11-16T12:00:00.000Z");
    expect(view.stale).toBe(true);
  });

  it("treats unparseable output as a failed read", async () => {
    const { service } = harness([async () => SAMPLE, async () => "garbage"]);
    await service.refresh();
    await service.refresh();
    expect(service.snapshot().stale).toBe(true);
    expect(service.snapshot().accounts).toHaveLength(2);
  });

  it("is not stale when it never read anything and the first read fails", async () => {
    const { service } = harness([
      async () => {
        throw new Error("no magpie");
      },
    ]);
    await service.refresh();
    expect(service.snapshot()).toEqual({ accounts: [], readAt: null, stale: false });
  });

  it("runs one read at a time", async () => {
    let release: (text: string) => void = () => undefined;
    const { service, calls } = harness([() => new Promise<string>((resolve) => (release = resolve))]);
    const first = service.refresh();
    const second = service.refresh();
    expect(calls()).toBe(1);
    release(SAMPLE);
    await Promise.all([first, second]);
    expect(calls()).toBe(1);
  });

  it("refreshIfOlder waits out the age, counted from the last attempt (failed ones too)", async () => {
    const { service, clock, calls } = harness([
      async () => {
        throw new Error("down");
      },
    ]);
    service.refreshIfOlder(120_000);
    await service.refresh();
    expect(calls()).toBe(1);
    clock.now += 119_000;
    service.refreshIfOlder(120_000);
    expect(calls()).toBe(1);
    clock.now += 2_000;
    service.refreshIfOlder(120_000);
    expect(calls()).toBe(2);
  });

  it("keeps an account's last numbers, marked stale, when one read comes back without them", async () => {
    const without = JSON.stringify([
      { agent: "claude", user: "someone@example.com", plan: "pro", active: true, windows: [] },
      { agent: "grok", user: "y", active: false, windows: [{ name: "7 days", used: 3 }] },
    ]);
    const { service, clock } = harness([async () => SAMPLE, async () => without]);
    await service.refresh();
    clock.now += 60_000;
    await service.refresh();
    const view = service.snapshot();
    expect(view.stale).toBe(false);
    expect(view.readAt).toBe("2026-11-16T12:01:00.000Z");
    const claude = view.accounts.find((account) => account.agent === "claude");
    expect(claude?.stale).toBe(true);
    expect(claude?.readAt).toBe("2026-11-16T12:00:00.000Z");
    expect(claude?.windows[0]?.used).toBe(31);
    const grok = view.accounts.find((account) => account.agent === "grok");
    expect(grok?.stale).toBe(false);
    expect(grok?.windows[0]?.used).toBe(3);
  });

  it("drops kept numbers once they are an hour old, and a later good read clears stale", async () => {
    const without = JSON.stringify([{ agent: "claude", user: "someone@example.com", active: true, windows: [] }]);
    const { service, clock } = harness([async () => SAMPLE, async () => without, async () => without, async () => SAMPLE]);
    await service.refresh();
    clock.now += 59 * 60_000;
    await service.refresh();
    expect(service.snapshot().accounts.some((account) => account.agent === "claude")).toBe(true);
    clock.now += 60_000;
    await service.refresh();
    expect(service.snapshot().accounts.some((account) => account.agent === "claude")).toBe(false);
    clock.now += 60_000;
    await service.refresh();
    const claude = service.snapshot().accounts.find((account) => account.agent === "claude");
    expect(claude?.stale).toBe(false);
  });

  it("snapshot is a copy: changing it does not change the cache", async () => {
    const { service } = harness([async () => SAMPLE]);
    await service.refresh();
    service.snapshot().accounts.pop();
    expect(service.snapshot().accounts).toHaveLength(2);
  });
});
