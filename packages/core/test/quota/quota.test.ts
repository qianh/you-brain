import { describe, expect, it } from "bun:test";

import { ClaudeUsageError, type ClaudeUsageWindows } from "../../src/quota/claude-usage.js";
import { parseMagpieAccounts } from "../../src/quota/parse.js";
import { QuotaService } from "../../src/quota/service.js";
import { parseUsageLog, tokenWindowCutoffs } from "../../src/quota/usage-log.js";

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

/** magpie that says its own numbers were read an hour ago: past the 30-minute stale mark. */
const SAMPLE_CACHED = JSON.stringify([
  {
    agent: "claude",
    user: "someone@example.com",
    plan: "pro",
    active: true,
    windows: [{ name: "5 hours", used: 5 }],
    asOf: "2026-11-13T10:45:07+08:00",
    readAt: "2026-11-13T10:42:49+08:00",
  },
]);

const LIVE: ClaudeUsageWindows = { fiveHour: 8, sevenDay: 62, models: { seven_day_opus: 12 } };

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
        asOf: "2026-11-16T20:06:09+08:00",
      },
      { agent: "copilot", plan: null, active: true, windows: [], asOf: null },
      { agent: "grok", plan: null, active: false, windows: [{ name: "7 days", used: 2, resetsAt: null }], asOf: null },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("example.com");
  });

  it("takes the older of readAt and asOf: magpie's cache can be days behind its read", () => {
    const parsed = parseMagpieAccounts(
      JSON.stringify([{ agent: "claude", active: true, readAt: "2026-11-17T12:00:00Z", asOf: "2026-11-13T02:00:00Z" }]),
    );
    expect(parsed?.[0]?.asOf).toBe("2026-11-13T02:00:00Z");
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

interface HarnessOptions {
  reads: Array<() => Promise<string>>;
  tokenReads?: Array<() => Promise<string>>;
  claudeLives?: Array<() => Promise<ClaudeUsageWindows>>;
}

function harness({ reads, tokenReads = [], claudeLives = [] }: HarnessOptions) {
  const clock = { now: Date.parse("2026-11-16T12:00:00Z") };
  let calls = 0;
  let tokenCalls = 0;
  let claudeCalls = 0;
  const service = new QuotaService({
    read: () => {
      const next = reads[Math.min(calls, reads.length - 1)];
      calls += 1;
      if (!next) throw new Error("no read");
      return next();
    },
    readTokens: () => {
      const next = tokenReads[Math.min(tokenCalls, tokenReads.length - 1)];
      tokenCalls += 1;
      if (!next) throw new Error("no token read");
      return next();
    },
    readClaudeLive: () => {
      const next = claudeLives[Math.min(claudeCalls, claudeLives.length - 1)];
      claudeCalls += 1;
      if (!next) throw new Error("no claude probe");
      return next();
    },
    nowMs: () => clock.now,
  });
  return { service, clock, calls: () => calls, claudeCalls: () => claudeCalls };
}

describe("tokenWindowCutoffs", () => {
  it("pins every span to local midnight, two and six days back", () => {
    const now = Date.parse("2026-11-16T15:41:00+08:00");
    const cuts = tokenWindowCutoffs(now);
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    expect(cuts.today).toBe(midnight.getTime());
    expect(cuts.threeDays).toBe(midnight.getTime() - 2 * 86_400_000);
    expect(cuts.sevenDays).toBe(midnight.getTime() - 6 * 86_400_000);
  });
});

describe("parseUsageLog", () => {
  const cuts = { today: 1_000_000_000, threeDays: 900_000_000, sevenDays: 800_000_000 };
  const row = (t: number, agent = "codex", tokens: [number, number, number] = [100, 10, 1000]): string =>
    JSON.stringify({ t: new Date(t).toISOString(), agent, in: tokens[0], out: tokens[1], cache_read: tokens[2] });

  it("buckets rows into the three calendar spans, in order", () => {
    const text = [row(cuts.today + 60_000, "codex", [100, 10, 1000]), row(cuts.threeDays + 60_000, "codex", [200, 20, 2000]), row(cuts.sevenDays + 60_000, "codex", [300, 30, 3000])].join("\n");
    const parsed = parseUsageLog(text, ["codex"], cuts);
    expect(parsed.codex).toEqual({
      today: { calls: 1, input: 100, output: 10, cacheRead: 1000, total: 1110 },
      threeDays: { calls: 2, input: 300, output: 30, cacheRead: 3000, total: 3330 },
      sevenDays: { calls: 3, input: 600, output: 60, cacheRead: 6000, total: 6660 },
    });
  });

  it("includes the exact boundary and skips rows older than the widest span", () => {
    const text = [row(cuts.today), row(cuts.sevenDays), row(cuts.sevenDays - 1)].join("\n");
    const parsed = parseUsageLog(text, ["codex"], cuts);
    expect(parsed.codex?.today.total).toBe(1110);
    expect(parsed.codex?.threeDays.total).toBe(1110);
    expect(parsed.codex?.sevenDays.total).toBe(2220);
  });

  it("drops rows dated past tomorrow: clock skew beyond a day is not usage", () => {
    const text = [row(cuts.today + 86_400_000), row(cuts.today + 86_400_000 + 1)].join("\n");
    const parsed = parseUsageLog(text, ["codex"], cuts);
    expect(parsed.codex?.today.total).toBe(1110);
    expect(parsed.codex?.sevenDays.calls).toBe(1);
  });

  it("skips junk lines, locally rejected rows, unknown agents and rows without a timestamp", () => {
    const text = [
      "not json",
      row(cuts.today + 1, "claude"),
      JSON.stringify({ t: new Date(cuts.today + 1).toISOString(), agent: "codex", in: 0, out: 0, rejected: true }),
      row(cuts.today + 1, "codex"),
      JSON.stringify({ agent: "codex", in: 5 }),
      row(cuts.today + 1, "codex", [-1, 10, 1000]),
    ].join("\n");
    const parsed = parseUsageLog(text, ["codex"], cuts);
    expect(Object.keys(parsed)).toEqual(["codex"]);
    expect(parsed.codex?.today).toEqual({ calls: 2, input: 100, output: 20, cacheRead: 2000, total: 2120 });
  });

  it("comes back empty when no wanted agent appears", () => {
    expect(parseUsageLog(row(cuts.today, "claude"), ["codex"], cuts)).toEqual({});
    expect(parseUsageLog("", ["codex"], cuts)).toEqual({});
  });
});

describe("QuotaService", () => {
  it("starts empty, then serves the last good read", async () => {
    const { service } = harness({ reads: [async () => SAMPLE] });
    expect(service.snapshot()).toEqual({ accounts: [], tokens: {}, readAt: null, stale: false });
    await service.refresh();
    const view = service.snapshot();
    expect(view.accounts.map((account) => account.agent)).toEqual(["claude", "grok"]);
    expect(view.readAt).toBe("2026-11-16T12:00:00.000Z");
    expect(view.stale).toBe(false);
  });

  it("marks an account stale when magpie's own numbers are older than half an hour, and carries that time", async () => {
    const { service } = harness({ reads: [async () => SAMPLE_CACHED] });
    await service.refresh();
    const claude = service.snapshot().accounts[0];
    expect(claude?.stale).toBe(true);
    expect(claude?.readAt).toBe("2026-11-13T02:42:49.000Z");
  });

  it("replaces Claude's cached numbers with the live probe and keeps magpie's reset time", async () => {
    const { service } = harness({
      reads: [async () => SAMPLE_CACHED],
      claudeLives: [async () => LIVE],
    });
    await service.refresh();
    const claude = service.snapshot().accounts[0];
    expect(claude?.stale).toBe(false);
    expect(claude?.readAt).toBe("2026-11-16T12:00:00.000Z");
    expect(claude?.windows.map((window) => [window.name, window.used])).toEqual([
      ["5 hours", 8],
      ["7 days", 62],
      ["7 days · Opus", 12],
    ]);
  });

  it.each([
    ["magpie lists Claude without any window", JSON.stringify([{ agent: "claude", user: "someone@example.com", plan: "pro", active: true, windows: [] }, { agent: "grok", user: "y", active: true, windows: [{ name: "7 days", used: 2, remaining: 98 }] }])],
    ["magpie does not list Claude at all", JSON.stringify([{ agent: "grok", user: "y", active: true, windows: [{ name: "7 days", used: 2, remaining: 98 }] }])],
  ])("builds the Claude account from the live probe when %s", async (_name, magpie) => {
    const { service } = harness({ reads: [async () => magpie], claudeLives: [async () => LIVE] });
    await service.refresh();
    const accounts = service.snapshot().accounts;
    const claude = accounts.filter((account) => account.agent === "claude");
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({ active: true, stale: false, readAt: "2026-11-16T12:00:00.000Z" });
    expect(claude[0]?.windows.map((window) => [window.name, window.used])).toEqual([
      ["5 hours", 8],
      ["7 days", 62],
      ["7 days · Opus", 12],
    ]);
    expect(accounts.map((account) => account.agent)).toContain("grok");
  });

  it("shows Claude from the live probe even when magpie itself fails, without duplicating it later", async () => {
    const { service, clock } = harness({
      reads: [() => Promise.reject(new Error("magpie missing")), async () => SAMPLE_CACHED],
      claudeLives: [async () => LIVE],
    });
    await service.refresh();
    expect(service.snapshot().accounts.map((account) => account.agent)).toEqual(["claude"]);
    clock.now += 11 * 60_000;
    await service.refresh();
    expect(service.snapshot().accounts.filter((account) => account.agent === "claude")).toHaveLength(1);
  });

  it("keeps magpie's cached Claude numbers when the live probe fails", async () => {
    const { service } = harness({
      reads: [async () => SAMPLE_CACHED],
      claudeLives: [() => Promise.reject(new Error("no keychain"))],
    });
    await service.refresh();
    const claude = service.snapshot().accounts[0];
    expect(claude?.stale).toBe(true);
    expect(claude?.windows[0]?.used).toBe(5);
  });

  it("probes the live endpoint at most once per interval, reusing the last probe between reads", async () => {
    const { service, clock, claudeCalls } = harness({ reads: [async () => SAMPLE_CACHED], claudeLives: [async () => LIVE] });
    await service.refresh();
    clock.now += 9 * 60_000;
    await service.refresh();
    expect(claudeCalls()).toBe(1);
    const claude = service.snapshot().accounts[0];
    expect(claude?.windows[0]?.used).toBe(8);
    expect(claude?.readAt).toBe("2026-11-16T12:00:00.000Z");
    clock.now += 2 * 60_000;
    await service.refresh();
    expect(claudeCalls()).toBe(2);
  });

  it("backs off after a failed probe and honors the server's Retry-After", async () => {
    const reject = () =>
      Promise.reject(new ClaudeUsageError("usage 探测返回 429", new Response(null, { status: 429, headers: { "retry-after": "900" } })));
    const { service, clock, claudeCalls } = harness({ reads: [async () => SAMPLE_CACHED], claudeLives: [reject, async () => LIVE] });
    await service.refresh();
    expect(service.snapshot().accounts[0]?.windows[0]?.used).toBe(5);
    clock.now += 10 * 60_000;
    await service.refresh();
    expect(claudeCalls()).toBe(1);
    clock.now += 6 * 60_000;
    await service.refresh();
    expect(claudeCalls()).toBe(2);
    const claude = service.snapshot().accounts[0];
    expect(claude?.stale).toBe(false);
    expect(claude?.windows.map((window) => window.used)).toEqual([8, 62, 12]);
  });

  it("ages a cached probe into stale while the probe is in backoff", async () => {
    const reject = () =>
      Promise.reject(new ClaudeUsageError("usage 探测返回 429", new Response(null, { status: 429, headers: { "retry-after": "3600" } })));
    const { service, clock } = harness({
      reads: [async () => SAMPLE_CACHED, async () => SAMPLE_CACHED, async () => SAMPLE_CACHED],
      claudeLives: [async () => LIVE, reject],
    });
    await service.refresh();
    clock.now += 11 * 60_000;
    await service.refresh();
    clock.now += 20 * 60_000;
    await service.refresh();
    const claude = service.snapshot().accounts[0];
    expect(claude?.stale).toBe(true);
    expect(claude?.readAt).toBe("2026-11-16T12:00:00.000Z");
    expect(claude?.windows[0]?.used).toBe(8);
  });

  /** Request-log fixture built from the harness clock, so bucketing holds in any timezone. */
  function usageLog(): string {
    const cuts = tokenWindowCutoffs(Date.parse("2026-11-16T12:00:00Z"));
    const row = (t: number, tokens: [number, number, number]): string =>
      JSON.stringify({ t: new Date(t).toISOString(), agent: "codex", in: tokens[0], out: tokens[1], cache_read: tokens[2] });
    return [
      row(cuts.today + 3_600_000, [100, 10, 1000]),
      row(cuts.threeDays + 3_600_000, [200, 20, 2000]),
      row(cuts.sevenDays + 3_600_000, [300, 30, 3000]),
    ].join("\n");
  }

  it("serves token spans under their agent and merges t3code into codex", async () => {
    const cuts = tokenWindowCutoffs(Date.parse("2026-11-16T12:00:00Z"));
    const t3Row = JSON.stringify({
      t: new Date(cuts.today + 3_600_000).toISOString(),
      agent: "t3code",
      in: 400,
      out: 40,
      cache_read: 4000,
    });
    const { service } = harness({ reads: [async () => SAMPLE], tokenReads: [async () => `${usageLog()}\n${t3Row}`] });
    await service.refresh();
    const view = service.snapshot();
    expect(Object.keys(view.tokens)).toEqual(["codex"]);
    expect(view.tokens.codex).toEqual({
      today: { calls: 2, input: 500, output: 50, cacheRead: 5000, total: 5550 },
      threeDays: { calls: 3, input: 700, output: 70, cacheRead: 7000, total: 7770 },
      sevenDays: { calls: 4, input: 1000, output: 100, cacheRead: 10000, total: 11100 },
    });
  });

  it("keeps token spans when the log read fails, and drops them when the log has no mapped agent", async () => {
    const other = JSON.stringify({ t: "2026-11-16T10:00:00Z", agent: "claude", in: 5, out: 1, cache_read: 0 });
    const { service } = harness({ reads: [async () => SAMPLE], tokenReads: [async () => usageLog(), () => Promise.reject(new Error("gone")), async () => other] });
    await service.refresh();
    expect(service.snapshot().tokens.codex).toBeDefined();
    await service.refresh();
    expect(service.snapshot().tokens.codex).toBeDefined();
    await service.refresh();
    expect(service.snapshot().tokens).toEqual({});
  });

  it("keeps the old numbers and marks them stale when a read fails", async () => {
    const { service, clock } = harness({ reads: [
      async () => SAMPLE,
      async () => {
        throw new Error("timeout");
      },
    ] });
    await service.refresh();
    clock.now += 60_000;
    await service.refresh();
    const view = service.snapshot();
    expect(view.accounts).toHaveLength(2);
    expect(view.readAt).toBe("2026-11-16T12:00:00.000Z");
    expect(view.stale).toBe(true);
  });

  it("treats unparseable output as a failed read", async () => {
    const { service } = harness({ reads: [async () => SAMPLE, async () => "garbage"] });
    await service.refresh();
    await service.refresh();
    expect(service.snapshot().stale).toBe(true);
    expect(service.snapshot().accounts).toHaveLength(2);
  });

  it("is not stale when it never read anything and the first read fails", async () => {
    const { service } = harness({ reads: [
      async () => {
        throw new Error("no magpie");
      },
    ] });
    await service.refresh();
    expect(service.snapshot()).toEqual({ accounts: [], tokens: {}, readAt: null, stale: false });
  });

  it("runs one read at a time", async () => {
    let release: (text: string) => void = () => undefined;
    const { service, calls } = harness({ reads: [() => new Promise<string>((resolve) => (release = resolve))] });
    const first = service.refresh();
    const second = service.refresh();
    expect(calls()).toBe(1);
    release(SAMPLE);
    await Promise.all([first, second]);
    expect(calls()).toBe(1);
  });

  it("refreshIfOlder waits out the age, counted from the last attempt (failed ones too)", async () => {
    const { service, clock, calls } = harness({ reads: [
      async () => {
        throw new Error("down");
      },
    ] });
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
    const { service, clock } = harness({ reads: [async () => SAMPLE, async () => without] });
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

  it("drops kept numbers once they are an hour old, and a live read clears stale", async () => {
    const without = JSON.stringify([{ agent: "claude", user: "someone@example.com", active: true, windows: [] }]);
    // The SAMPLE's numbers carry a readAt an hour before the clock, so a live read uses
    // one without magpie's own time: those count as fresh at the moment they arrived.
    const live = JSON.stringify([{ agent: "claude", user: "someone@example.com", plan: "pro", active: true, windows: [{ name: "5 hours", used: 40 }] }]);
    const { service, clock } = harness({ reads: [async () => SAMPLE, async () => without, async () => without, async () => live] });
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
    expect(claude?.windows[0]?.used).toBe(40);
  });

  it("snapshot is a copy: changing it does not change the cache", async () => {
    const { service } = harness({ reads: [async () => SAMPLE] });
    await service.refresh();
    service.snapshot().accounts.pop();
    expect(service.snapshot().accounts).toHaveLength(2);
  });
});
