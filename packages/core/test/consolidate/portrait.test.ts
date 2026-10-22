import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import { platformPaths, portraitFile } from "../../src/domain/paths.js";
import {
  PORTRAIT_JSON_SCHEMA,
  PORTRAIT_SYSTEM_PROMPT,
  buildPortraitPrompt,
  createDrivePortrait,
  fillSnapshotPattern,
  pendingCorrections,
  portraitStep,
  runConsolidation,
  type ConsolidationPortrait,
} from "../../src/consolidate/index.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { LlmCompleteRequest } from "../../src/llm/types.js";
import {
  PortraitService,
  type PortraitConfig,
  type PortraitStore,
} from "../../src/portrait/index.js";
import type { PortraitRecord } from "../../src/store/types.js";
import { fakeBackend } from "../daemon/helpers.js";
import {
  DAY_BEFORE,
  DAY_OF,
  LATER,
  LOCAL_DAY,
  SHANGHAI,
  ZONE,
  assigned,
  created,
  ev,
  fold,
  key,
  refined,
} from "./fixture.js";

const FULL = "digital-twin/JOHN-DIGITAL-TWIN-latest.md";
const BRIEF = "digital-twin/JOHN-DIGITAL-TWIN-latest-brief.md";
const PATTERN = "digital-twin/JOHN-DIGITAL-TWIN-v*-*.md";
const ORIGINAL = `# 数字分身\n\n## 工作方式\n${"先问再做，再改。".repeat(12)}\n`;
const UPDATED = `${ORIGINAL}## 今天\n补上当天的结论。\n`;
const BACKUP = `digital-twin/consolidate-backup/JOHN-DIGITAL-TWIN-latest-${LOCAL_DAY}.md`;
const SNAPSHOT = `digital-twin/JOHN-DIGITAL-TWIN-v1.0.0-${LOCAL_DAY}.md`;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function portraitConfig(pattern = PATTERN): PortraitConfig {
  return {
    variants: [
      { id: "full", path: FULL },
      { id: "brief", path: BRIEF },
      { id: "coding", path: "digital-twin/JOHN-TWIN-coding.md" },
    ],
    snapshotPattern: pattern,
  };
}

interface World {
  home: string;
  drive: MemoryDrive;
  events: Event[];
  requests: LlmCompleteRequest[];
  portrait: ConsolidationPortrait;
}

async function world(pattern = PATTERN): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), "you-brain-portrait-step-"));
  homes.push(home);
  const paths = platformPaths({
    platform: "darwin",
    homeDir: home,
    env: { YOU_BRAIN_HOME: home },
  });
  const drive = new MemoryDrive({ now: () => new Date(LATER) });
  const rows = new Map<string, PortraitRecord>();
  const store: PortraitStore = {
    getPortrait(variant) {
      return rows.get(variant) ?? null;
    },
    upsertPortrait(record) {
      rows.set(record.variant, record);
    },
  };
  const service = new PortraitService({
    drive,
    store,
    paths,
    config: portraitConfig(pattern),
    driveRoot: "",
  });
  const events: Event[] = [];
  return {
    home,
    drive,
    events,
    requests: [],
    portrait: createDrivePortrait({
      drive,
      service,
      driveRoot: "",
      config: () => portraitConfig(pattern),
      events: () => events,
    }),
  };
}

function changedTopic(): Event[] {
  const session = key(1);
  return [
    created("alpha", "甲", DAY_BEFORE),
    refined(session, "甲的标题", "会话概要", DAY_BEFORE),
    assigned("alpha", session, DAY_BEFORE),
    ev(
      "conclusion.added",
      { conclusionId: "c1", topicId: "alpha", text: "当天结论", sessionKey: session },
      DAY_OF,
    ),
  ];
}

function correction(
  id: string,
  ts: string,
  variant = "full",
  text = "把语气改短",
): Event {
  return ev("portrait.correction", { correctionId: id, variant, section: "语气", text }, ts);
}

async function seed(drive: MemoryDrive, path: string, text: string) {
  return drive.put({ path, bytes: Buffer.from(text, "utf8"), mimeType: "text/markdown" });
}

async function textAt(drive: MemoryDrive, path: string): Promise<string | null> {
  const object = await drive.readPath(path);
  return object ? object.bytes.toString("utf8") : null;
}

async function pathsOf(drive: MemoryDrive): Promise<string[]> {
  return (await drive.list({})).map((entry) => entry.path).sort();
}

function answer(portrait: string, changed = true): string {
  return JSON.stringify({ changed, portrait });
}

async function run(
  box: World,
  complete: (request: LlmCompleteRequest) => string | Promise<string>,
  options?: { attach?: boolean },
) {
  const cursors = new Map<string, string>();
  return runConsolidation({
    day: LOCAL_DAY,
    timeZone: SHANGHAI,
    now: () => new Date(LATER),
    load: () => ({ book: fold(box.events), sessionUpdatedAt: {} }),
    zone: ZONE,
    llm: fakeBackend(async (request) => {
      box.requests.push(request);
      return complete(request);
    }),
    emit: async (type, data) => {
      box.events.push(ev(type, data, LATER));
    },
    cursors: {
      get: (name) => cursors.get(name) ?? null,
      set: (name, value) => {
        cursors.set(name, value);
      },
    },
    steps: [portraitStep],
    ...(options?.attach === false ? {} : { portrait: box.portrait }),
  });
}

function applied(events: readonly Event[], id: string): string[] {
  return events
    .filter(
      (event) => event.type === "portrait.correction_applied" && event.data.correctionId === id,
    )
    .map((event) => (event.type === "portrait.correction_applied" ? event.data.snapshot : ""));
}

describe("portrait consolidation", () => {
  it("does nothing without a portrait adapter", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    box.events.push(...changedTopic(), correction("corr-1", DAY_OF));
    const result = await run(box, () => answer(UPDATED), { attach: false });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(box.requests).toEqual([]);
    expect(await textAt(box.drive, FULL)).toBe(ORIGINAL);
    expect(await pathsOf(box.drive)).toEqual([FULL]);
    expect(applied(box.events, "corr-1")).toEqual([]);
  });

  it("skips when Drive has no full portrait", async () => {
    const box = await world();
    box.events.push(...changedTopic());
    const result = await run(box, () => answer(UPDATED));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["没有现有数字分身，跳过"]);
    expect(box.requests).toEqual([]);
    expect(await pathsOf(box.drive)).toEqual([]);
  });

  it("skips the model when the day has no changes and no corrections", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    const session = key(2);
    box.events.push(
      created("alpha", "甲", DAY_BEFORE),
      refined(session, "昨天的标题", "会话概要", DAY_BEFORE),
      assigned("alpha", session, DAY_BEFORE),
    );
    const result = await run(box, () => answer(UPDATED));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(box.requests).toEqual([]);
    expect(await textAt(box.drive, FULL)).toBe(ORIGINAL);
    expect(await pathsOf(box.drive)).toEqual([FULL]);
  });

  it("writes a backup, the next snapshot, and refreshes the local cache", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    await seed(box.drive, BRIEF, "# 精简\n");
    await seed(box.drive, "digital-twin/OTHER-v9.9.9-2020-01-01.md", "无关");
    box.events.push(...changedTopic(), correction("corr-1", DAY_OF, "full", "语气再短一点"));
    const result = await run(box, () => answer(UPDATED));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(box.requests).toHaveLength(1);
    expect(box.requests[0]?.system).toContain("数字分身");
    expect(box.requests[0]?.system).not.toContain("话题概要");
    expect(box.requests[0]?.system).not.toContain("合并建议");
    expect(box.requests[0]?.jsonSchema).toEqual(PORTRAIT_JSON_SCHEMA);
    expect(box.requests[0]?.user).toContain("当天结论");
    expect(box.requests[0]?.user).toContain("甲的标题");
    expect(box.requests[0]?.user).toContain("语气再短一点");
    expect(await textAt(box.drive, FULL)).toBe(UPDATED);
    expect(await textAt(box.drive, BACKUP)).toBe(ORIGINAL);
    expect(await textAt(box.drive, SNAPSHOT)).toBe(UPDATED);
    expect(await textAt(box.drive, BRIEF)).toBe("# 精简\n");
    expect(await readFile(portraitFile(platformPaths({
      platform: "darwin",
      homeDir: box.home,
      env: { YOU_BRAIN_HOME: box.home },
    }), "full"), "utf8")).toBe(UPDATED);
    expect(applied(box.events, "corr-1")).toEqual([`JOHN-DIGITAL-TWIN-v1.0.0-${LOCAL_DAY}.md`]);
  });

  it("still updates a topic whose summary was already rewritten today", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    box.events.push(
      ...changedTopic(),
      ev("topic.summary_rewritten", { topicId: "alpha", summary: "已重写", nextStep: "" }, LATER),
    );
    const result = await run(box, () => answer(UPDATED));
    expect(result.ok).toBe(true);
    expect(box.requests).toHaveLength(1);
    expect(await textAt(box.drive, FULL)).toBe(UPDATED);
  });

  it("bumps snapshot versions by numeric segments", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    await seed(box.drive, `digital-twin/JOHN-DIGITAL-TWIN-v1.3.3-${LOCAL_DAY}.md`, "旧");
    await seed(box.drive, "digital-twin/JOHN-DIGITAL-TWIN-v1.9.0-2026-01-01.md", "旧");
    await seed(box.drive, "digital-twin/JOHN-DIGITAL-TWIN-v1.10.0-2026-02-01.md", "旧");
    box.events.push(correction("corr-1", DAY_OF));
    const result = await run(box, () => answer(UPDATED));
    expect(result.ok).toBe(true);
    expect(await textAt(box.drive, `digital-twin/JOHN-DIGITAL-TWIN-v1.10.1-${LOCAL_DAY}.md`)).toBe(
      UPDATED,
    );
    expect(applied(box.events, "corr-1")).toEqual([`JOHN-DIGITAL-TWIN-v1.10.1-${LOCAL_DAY}.md`]);
  });

  it("bumps the last segment of the only existing snapshot", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    await seed(box.drive, "digital-twin/JOHN-DIGITAL-TWIN-v1.3.3-2026-01-01.md", "旧");
    box.events.push(correction("corr-1", DAY_OF));
    const result = await run(box, () => answer(UPDATED));
    expect(result.ok).toBe(true);
    expect(await textAt(box.drive, `digital-twin/JOHN-DIGITAL-TWIN-v1.3.4-${LOCAL_DAY}.md`)).toBe(
      UPDATED,
    );
  });

  it("writes nothing when the model reports no change", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    box.events.push(correction("corr-1", DAY_OF));
    const result = await run(box, () => answer("", false));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await pathsOf(box.drive)).toEqual([FULL]);
    expect(applied(box.events, "corr-1")).toEqual([]);
  });

  it("keeps a bad portrait off Drive and still succeeds", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    box.events.push(correction("corr-1", DAY_OF));
    const empty = await run(box, () => answer(" \n\t "));
    expect(empty.ok).toBe(true);
    expect(empty.warnings).toEqual(["数字分身输出为空，已跳过"]);
    expect(await pathsOf(box.drive)).toEqual([FULL]);

    box.requests.length = 0;
    box.events.length = 0;
    box.events.push(correction("corr-2", DAY_OF));
    const same = await run(box, () => answer(ORIGINAL));
    expect(same.ok).toBe(true);
    expect(same.warnings).toEqual(["数字分身没有变化，已跳过"]);
    expect(await textAt(box.drive, FULL)).toBe(ORIGINAL);

    box.requests.length = 0;
    const short = await run(box, () => answer("太短"));
    expect(short.ok).toBe(true);
    expect(short.warnings).toContain("数字分身输出不到原来的一半，已跳过");
    expect(applied(box.events, "corr-2")).toEqual([]);
    expect(await pathsOf(box.drive)).toEqual([FULL]);
  });

  it("allows a portrait that is exactly half as long", async () => {
    const box = await world();
    await seed(box.drive, FULL, "0123456789");
    box.events.push(correction("corr-1", DAY_OF));
    const result = await run(box, () => answer("01234"));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await textAt(box.drive, FULL)).toBe("01234");
  });

  it("retries invalid JSON once and then fails the step", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    box.events.push(correction("corr-1", DAY_OF));
    const result = await run(box, () => "not-json");
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([{ id: "portrait", ok: false, error: "数字分身没有写完" }]);
    expect(box.requests).toHaveLength(2);
    expect(box.requests[1]?.user).toContain("上次输出无法通过校验");
    expect(await pathsOf(box.drive)).toEqual([FULL]);
    expect(applied(box.events, "corr-1")).toEqual([]);
  });

  it("accepts the second JSON after one invalid reply", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    box.events.push(correction("corr-1", DAY_OF));
    let calls = 0;
    const result = await run(box, () => {
      calls += 1;
      return calls === 1 ? "not-json" : answer(UPDATED);
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(await textAt(box.drive, SNAPSHOT)).toBe(UPDATED);
    expect(applied(box.events, "corr-1")).toEqual([`JOHN-DIGITAL-TWIN-v1.0.0-${LOCAL_DAY}.md`]);
  });

  it("does not overwrite a portrait another writer changed after the read", async () => {
    const box = await world();
    const seeded = await seed(box.drive, FULL, ORIGINAL);
    const other = `${ORIGINAL}别人刚写的一段。\n`;
    box.events.push(correction("corr-1", DAY_OF));
    const result = await run(box, async () => {
      await box.drive.update(seeded.id, other);
      return answer(UPDATED);
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["数字分身在沉淀期间被别处更新，已跳过"]);
    expect(await textAt(box.drive, FULL)).toBe(other);
    expect(await textAt(box.drive, BACKUP)).toBe(ORIGINAL);
    expect(await textAt(box.drive, SNAPSHOT)).toBeNull();
    expect(applied(box.events, "corr-1")).toEqual([]);
    expect(await readFile(join(box.home, "portrait", "full.md"), "utf8").catch(() => "")).toBe("");
  });

  it("keeps the earliest backup from the same day", async () => {
    const box = await world();
    await seed(box.drive, FULL, ORIGINAL);
    box.events.push(...changedTopic());
    const first = await run(box, () => answer(UPDATED));
    expect(first.ok).toBe(true);
    const secondText = `${UPDATED}再补一句。\n`;
    const second = await run(box, () => answer(secondText));
    expect(second.ok).toBe(true);
    expect(await textAt(box.drive, BACKUP)).toBe(ORIGINAL);
    expect(await textAt(box.drive, FULL)).toBe(secondText);
    expect(await textAt(box.drive, `digital-twin/JOHN-DIGITAL-TWIN-v1.0.1-${LOCAL_DAY}.md`)).toBe(
      secondText,
    );
  });

  it("fails clearly when the snapshot pattern does not have two stars", async () => {
    const box = await world("digital-twin/one-*.md");
    await seed(box.drive, FULL, ORIGINAL);
    box.events.push(correction("corr-1", DAY_OF));
    const result = await run(box, () => answer(UPDATED));
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.error).toContain("快照规则必须正好有两个 *");
    expect(await pathsOf(box.drive)).toEqual([FULL]);
    expect(applied(box.events, "corr-1")).toEqual([]);
  });

  it("fills the snapshot pattern and rejects the wrong number of stars", () => {
    expect(fillSnapshotPattern(PATTERN, "1.3.4", LOCAL_DAY)).toBe(
      `digital-twin/JOHN-DIGITAL-TWIN-v1.3.4-${LOCAL_DAY}.md`,
    );
    expect(() => fillSnapshotPattern("digital-twin/one-*.md", "1.0.0", LOCAL_DAY)).toThrow(
      "快照规则必须正好有两个 *，当前是 digital-twin/one-*.md",
    );
  });

  it("keeps unapplied full corrections, oldest first, capped at 20", () => {
    const events: Event[] = [];
    events.push(correction("later", LATER, "full", "后写的"));
    events.push(correction("earlier", DAY_OF, "full", "先写的"));
    events.push(correction("earlier", LATER, "full", "同一条的后写"));
    events.push(correction("brief", DAY_OF, "brief", "精简不用管"));
    events.push(correction("done", DAY_BEFORE, "full", "已经用过"));
    events.push(
      ev("portrait.correction_applied", { correctionId: "done", snapshot: "old.md" }, DAY_OF),
    );
    for (let index = 0; index < 21; index += 1) {
      const at = new Date(Date.parse(DAY_OF) + (index + 1) * 1000).toISOString();
      events.push(correction(`c${String(index).padStart(2, "0")}`, at, "full", `纠正${index}`));
    }
    const pending = pendingCorrections(events);
    expect(pending[0]).toEqual({ correctionId: "earlier", section: "语气", text: "先写的" });
    expect(pending.some((item) => item.correctionId === "brief")).toBe(false);
    expect(pending.some((item) => item.correctionId === "done")).toBe(false);
    expect(pending.some((item) => item.text === "同一条的后写")).toBe(false);
    expect(pending.map((item) => item.correctionId)).toEqual([
      "earlier",
      ...Array.from({ length: 19 }, (_, index) => `c${String(index).padStart(2, "0")}`),
    ]);
  });

  it("sends the current portrait in full and clips the day's evidence", () => {
    const current = "身".repeat(7_000);
    const conclusion = "结".repeat(200);
    const built = buildPortraitPrompt({
      day: LOCAL_DAY,
      current,
      topics: [{ name: "甲", summary: "概要", titles: ["标题"], conclusions: [conclusion] }],
      corrections: [{ correctionId: "corr-1", section: "语气", text: "改".repeat(300) }],
    });
    expect(built.system).toBe(PORTRAIT_SYSTEM_PROMPT);
    expect(built.user).toContain(current);
    expect(built.user).not.toContain(conclusion);
    expect(built.user).toContain("结".repeat(160));
    expect(built.user).toContain("改".repeat(240));
    expect(built.user).not.toContain("改".repeat(241));
    expect(built.includedCorrectionIds).toEqual(["corr-1"]);
  });
});
