import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import { platformPaths, portraitFile } from "../../src/domain/paths.js";
import {
  PORTRAIT_EVAL_CURSOR,
  PORTRAIT_MONTHLY_CURSOR,
  PORTRAIT_TURNS_CURSOR,
  TWIN_CLAIMS_JSON_SCHEMA,
  TWIN_CLAIMS_SYSTEM_PROMPT,
  TWIN_EDITS_JSON_SCHEMA,
  TWIN_MERGE_SYSTEM_PROMPT,
  applyTwinEdits,
  changedLayers,
  checkTwin,
  cleanUserTurn,
  createDrivePortrait,
  fillSnapshotPattern,
  pendingCorrections,
  portraitEvalStep,
  portraitMonthlyStep,
  portraitStep,
  rebuildTwin,
  runConsolidation,
  twinVersion,
  withHeader,
  withProjectsPointer,
  type ConsolidationPortrait,
} from "../../src/consolidate/index.js";
import {
  TWIN_EVAL_ANSWER_SYSTEM_PROMPT,
  TWIN_EVAL_JUDGE_SYSTEM_PROMPT,
  TWIN_FIX_SYSTEM_PROMPT,
  TWIN_MONTHLY_SYSTEM_PROMPT,
  TWIN_PROBES_SYSTEM_PROMPT,
} from "../../src/consolidate/prompt.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { LlmCompleteRequest } from "../../src/llm/types.js";
import {
  PortraitService,
  type PortraitConfig,
  type PortraitStore,
} from "../../src/portrait/index.js";
import type { PortraitRecord } from "../../src/store/types.js";
import { fakeBackend } from "../daemon/helpers.js";
import { DAY_OF, LATER, LOCAL_DAY, SHANGHAI, ZONE, ev, fold } from "./fixture.js";

const FULL = "digital-twin/JOHN-DIGITAL-TWIN-latest.md";
const CODING = "digital-twin/JOHN-TWIN-coding.md";
const PROJECTS = "digital-twin/JOHN-TWIN-projects.md";
const PATTERN = "digital-twin/JOHN-DIGITAL-TWIN-v*-*.md";
const CLAIMS = `digital-twin/claims/${LOCAL_DAY}.jsonl`;
const PENDING = "digital-twin/claims/pending.jsonl";
const CHANGELOG = "digital-twin/changelog-latest.md";
const PROBES = "digital-twin/eval/probes.jsonl";
const VERSION_LINE = "版本 v2.0.0 · 2026-10-20 · 变更见 changelog";

const FULL_TEXT = `# 数字分身 · 人格\n${VERSION_LINE}\n\n## 1. 一句话\n先问再做。\n\n## 3. 价值排序\n${"可靠优先。".repeat(20)}\n`;
const POINTER = "- **项目说明**：在已有的具体项目里工作时，先读 [项目说明](~/.you-brain/portrait/projects.md) 里该项目的小节；新项目和简单对话不需要读。";
const CODING_TEXT = `# 数字分身 · 编码\n${VERSION_LINE}\n\n## 核心原则\n${POINTER}\n\n## 1. 授权与边界\n提问不等于授权改代码。\n\n## 5. 技术栈默认\n${"Python 用 uv。".repeat(10)}\n`;
const PROJECTS_TEXT = `# 数字分身 · 项目决定\n${VERSION_LINE}\n\n## 甲\n甲的口径。\n`;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function portraitConfig(pattern = PATTERN): PortraitConfig {
  return {
    variants: [
      { id: "full", path: FULL },
      { id: "coding", path: CODING },
      { id: "projects", path: PROJECTS },
    ],
    snapshotPattern: pattern,
  };
}

interface World {
  home: string;
  drive: MemoryDrive;
  events: Event[];
  requests: LlmCompleteRequest[];
  sessions: Array<{ sessionKey: string; title: string; turns: string[] }>;
  cursors: Map<string, string>;
  portrait: ConsolidationPortrait;
}

async function world(pattern = PATTERN): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), "you-brain-portrait-step-"));
  homes.push(home);
  const paths = platformPaths({ platform: "darwin", homeDir: home, env: { YOU_BRAIN_HOME: home } });
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
  const service = new PortraitService({ drive, store, paths, config: portraitConfig(pattern), driveRoot: "" });
  const box: World = {
    home,
    drive,
    events: [],
    requests: [],
    sessions: [],
    cursors: new Map(),
    portrait: undefined as unknown as ConsolidationPortrait,
  };
  box.portrait = createDrivePortrait({
    drive,
    service,
    driveRoot: "",
    config: () => portraitConfig(pattern),
    events: () => box.events,
    sessions: async () => box.sessions,
  });
  return box;
}

async function seedTwin(box: World, texts = { full: FULL_TEXT, coding: CODING_TEXT, projects: PROJECTS_TEXT }) {
  const full = await seed(box.drive, FULL, texts.full);
  await seed(box.drive, CODING, texts.coding);
  if (texts.projects !== "") await seed(box.drive, PROJECTS, texts.projects);
  return full;
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

function correction(id: string, variant = "full", text = "把语气改短"): Event {
  return ev("portrait.correction", { correctionId: id, variant, section: "语气", text }, DAY_OF);
}

interface Replies {
  claims?: unknown;
  merge?: unknown;
  fix?: unknown;
  probes?: unknown;
  answers?: unknown;
  judge?: unknown;
  monthly?: unknown;
}

/** Route each call by its system prompt. A string reply is sent as is. */
function model(replies: Replies) {
  return (request: LlmCompleteRequest): string => {
    const pick = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
    if (request.system === TWIN_CLAIMS_SYSTEM_PROMPT) return pick(replies.claims ?? { claims: [] });
    if (request.system === TWIN_MERGE_SYSTEM_PROMPT) return pick(replies.merge ?? noEdits);
    if (request.system === TWIN_FIX_SYSTEM_PROMPT) return pick(replies.fix ?? noEdits);
    if (request.system === TWIN_PROBES_SYSTEM_PROMPT) return pick(replies.probes ?? { probes: [] });
    if (request.system === TWIN_EVAL_ANSWER_SYSTEM_PROMPT) return pick(replies.answers ?? { answers: [] });
    if (request.system === TWIN_EVAL_JUDGE_SYSTEM_PROMPT) return pick(replies.judge ?? { results: [] });
    if (request.system === TWIN_MONTHLY_SYSTEM_PROMPT) return pick(replies.monthly ?? { notes: [] });
    throw new Error(`unexpected prompt ${request.system.slice(0, 20)}`);
  };
}

const noEdits = { bump: "patch", changelog: [], edits: [] };

const highCoding = { layer: "coding", project: "", confidence: "high", text: "以后都先跑测试再交付。" };
const lowPersona = { layer: "persona", project: "", confidence: "low", text: "喜欢短回复。" };

const codingEdit = {
  bump: "minor",
  changelog: ["coding · 1 授权与边界：新增先跑测试"],
  edits: [
    {
      layer: "coding",
      heading: "## 1. 授权与边界",
      text: "## 1. 授权与边界\n提问不等于授权改代码。\n交付前先跑测试。",
    },
  ],
};

async function run(
  box: World,
  complete: (request: LlmCompleteRequest) => string | Promise<string>,
  options?: { attach?: boolean; steps?: typeof portraitStep[]; day?: string },
) {
  return runConsolidation({
    day: options?.day ?? LOCAL_DAY,
    timeZone: SHANGHAI,
    now: () => new Date(LATER),
    load: () => ({ book: fold([]), sessionUpdatedAt: {} }),
    zone: ZONE,
    llm: fakeBackend(async (request) => {
      box.requests.push(request);
      return complete(request);
    }),
    emit: async (type, data) => {
      box.events.push(ev(type, data, LATER));
    },
    cursors: {
      get: (name) => box.cursors.get(name) ?? null,
      set: (name, value) => {
        box.cursors.set(name, value);
      },
    },
    steps: options?.steps ?? [portraitStep],
    ...(options?.attach === false ? {} : { portrait: box.portrait }),
  });
}

function applied(events: readonly Event[], id: string): string[] {
  return events
    .filter((event) => event.type === "portrait.correction_applied" && event.data.correctionId === id)
    .map((event) => (event.type === "portrait.correction_applied" ? event.data.snapshot : ""));
}

function reminders(events: readonly Event[]): Array<{ kind: string; text: string }> {
  return events.flatMap((event) =>
    event.type === "reminder.issued" ? [{ kind: event.data.kind, text: event.data.text }] : [],
  );
}

function jsonl(text: string | null): unknown[] {
  return (text ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

describe("twin documents", () => {
  it("replaces, renames, deletes and appends sections", () => {
    const next = applyTwinEdits(
      { full: FULL_TEXT, coding: CODING_TEXT, projects: PROJECTS_TEXT },
      [
        { layer: "full", heading: "## 1. 一句话", text: "## 1. 一句话\n先查证再动手。" },
        { layer: "projects", heading: "## 甲", text: "## 甲 · 审批\n甲的审批口径。" },
        { layer: "projects", heading: "## 乙", text: "## 乙\n乙的口径。" },
        { layer: "coding", heading: "## 5. 技术栈默认", text: "" },
      ],
    );
    expect(next.full).toContain("## 1. 一句话\n先查证再动手。");
    expect(next.full).not.toContain("先问再做");
    expect(next.full.split("\n").slice(0, 2)).toEqual(["# 数字分身 · 人格", VERSION_LINE]);
    expect(next.projects).toContain("## 甲 · 审批\n甲的审批口径。\n\n## 乙\n乙的口径。\n");
    expect(next.projects).not.toContain("## 甲\n");
    expect(next.coding).not.toContain("技术栈默认");
  });

  it("adds a missing heading line to section text and keeps one section per heading", () => {
    const next = applyTwinEdits(
      { full: FULL_TEXT, coding: CODING_TEXT, projects: PROJECTS_TEXT },
      [
        { layer: "projects", heading: "## 甲", text: "只有正文" },
        { layer: "projects", heading: "## 丙", text: "## 甲\n改名撞上已有小节" },
      ],
    );
    expect(next.projects.match(/## 甲/gu)).toHaveLength(1);
    expect(next.projects).toContain("## 甲\n改名撞上已有小节");
  });

  it("writes the version line and keeps the title", () => {
    const text = withHeader("coding", CODING_TEXT, "2.1.0", LOCAL_DAY);
    const lines = text.split("\n");
    expect(lines[0]).toBe("# 数字分身 · 编码");
    expect(lines[1]).toBe(`版本 v2.1.0 · ${LOCAL_DAY} · 变更见 changelog`);
    expect(lines[3]).toBe("## 核心原则");
    expect(withHeader("projects", "## 甲\n口径\n", "1.0.0", LOCAL_DAY)).toStartWith(
      `# 数字分身 · 项目决定\n版本 v1.0.0 · ${LOCAL_DAY} · 变更见 changelog\n\n## 甲`,
    );
  });

  it("reads the version from line 2, including the old format", () => {
    expect(twinVersion({ full: FULL_TEXT })).toEqual([2, 0, 0]);
    expect(twinVersion({ full: "# 旧\nv1.3.11 · 2026-10-27 · derived\n", coding: "# 旧\nv1.2.0 · x\n" })).toEqual([
      1, 3, 11,
    ]);
    expect(twinVersion({ full: "# 无版本\n" })).toEqual([0, 0, 0]);
  });

  it("keeps one projects pointer as the first coding principle", () => {
    const withOld = `# 数字分身 · 编码\n${VERSION_LINE}\n\n在下列项目里工作时，先读 \`~/.you-brain/portrait/projects.md\` 里对应的小节：甲。\n\n## 核心原则\n- **项目说明**：旧写法\n- **先证据**：先查再动手。\n\n## 默认与红线\n- 技术栈：Python。\n`;
    const coding = withProjectsPointer(withOld);
    expect(coding.split("\n").slice(0, 6)).toEqual([
      "# 数字分身 · 编码",
      VERSION_LINE,
      "",
      "## 核心原则",
      POINTER,
      "- **先证据**：先查再动手。",
    ]);
    expect(coding).not.toContain("旧写法");
    expect(coding).not.toContain("在下列项目里工作时");
    expect(withProjectsPointer(coding)).toBe(coding);
  });

  it("creates the principles section when the coding layer has none", () => {
    const coding = withProjectsPointer(CODING_TEXT.replace(`## 核心原则\n${POINTER}\n\n`, ""));
    expect(coding).toContain("## 核心原则\n- **项目说明**：");
    expect(coding.indexOf("## 核心原则")).toBeLessThan(coding.indexOf("## 1. 授权与边界"));
    expect(coding).not.toContain("对应的小节：甲");
  });

  it("ignores the version line when deciding what changed", () => {
    const bumped = withHeader("full", FULL_TEXT, "9.9.9", LOCAL_DAY);
    const texts = { full: FULL_TEXT, coding: CODING_TEXT, projects: PROJECTS_TEXT };
    expect([...changedLayers(texts, { ...texts, full: bumped })]).toEqual([]);
    expect([...changedLayers(texts, { ...texts, projects: `${PROJECTS_TEXT}多一行\n` })]).toEqual(["projects"]);
  });

  it("blocks budgets and bookkeeping words, warns on big project sections, and scans secrets", () => {
    const texts = { full: FULL_TEXT, coding: CODING_TEXT, projects: PROJECTS_TEXT };
    expect(checkTwin(texts, new Set())).toMatchObject({ blocking: [], warnings: [], scanHits: [] });
    const big = { ...texts, full: `${FULL_TEXT}${"长".repeat(4_100)}` };
    expect(checkTwin(big, new Set(["full"])).blocking[0]).toContain("full 为");
    const lint = { ...texts, coding: `${CODING_TEXT}这条待确认。\n` };
    expect(checkTwin(lint, new Set(["coding"])).blocking).toEqual(["coding 出现禁用的记账措辞：待确认"]);
    const section = { ...texts, projects: `${PROJECTS_TEXT}${"口".repeat(1_400)}\n` };
    expect(checkTwin(section, new Set()).warnings).toEqual([]);
    expect(checkTwin(section, new Set(["projects"])).warnings[0]).toContain("## 甲");
    const secret = {
      ...texts,
      projects: `${PROJECTS_TEXT}联系 someone@example.com，机器 10.0.0.12，目录 /Users/alice，api_key=abcdefgh12345\n`,
    };
    expect(checkTwin(secret, new Set()).scanHits).toEqual([
      "projects：密钥",
      "projects：邮箱",
      "projects：IP",
      "projects：本机路径",
    ]);
    expect(checkTwin({ ...texts, full: `${FULL_TEXT}手机 13812345678\n` }, new Set()).scanHits).toEqual([
      "full：手机号",
    ]);
  });

  it("drops injected context from user turns", () => {
    expect(cleanUserTurn("先别改<system-reminder>注入</system-reminder> 代码")).toBe("先别改 代码");
    expect(cleanUserTurn("This session is being continued from a previous conversation")).toBe("");
    expect(cleanUserTurn("<command-name>/x</command-name>")).toBe("");
  });

  it("fills the snapshot pattern and rejects the wrong number of stars", () => {
    expect(fillSnapshotPattern(PATTERN, "1.3.4", LOCAL_DAY)).toBe(
      `digital-twin/JOHN-DIGITAL-TWIN-v1.3.4-${LOCAL_DAY}.md`,
    );
    expect(() => fillSnapshotPattern("digital-twin/one-*.md", "1.0.0", LOCAL_DAY)).toThrow(
      "快照规则必须正好有两个 *，当前是 digital-twin/one-*.md",
    );
  });

  it("keeps unapplied corrections for any layer, oldest first, capped at 20", () => {
    const events: Event[] = [
      ev("portrait.correction", { correctionId: "p", variant: "projects", section: "甲", text: "改甲" }, DAY_OF),
      ev("portrait.correction", { correctionId: "done", variant: "full", section: "x", text: "用过" }, DAY_OF),
      ev("portrait.correction_applied", { correctionId: "done", snapshot: "old.md" }, LATER),
    ];
    for (let index = 0; index < 21; index += 1) {
      const at = new Date(Date.parse(LATER) + (index + 1) * 1000).toISOString();
      events.push(ev("portrait.correction", { correctionId: `c${index}`, variant: "coding", section: "s", text: "t" }, at));
    }
    const pending = pendingCorrections(events);
    expect(pending[0]).toEqual({ correctionId: "p", variant: "projects", section: "甲", text: "改甲" });
    expect(pending).toHaveLength(20);
    expect(pending.some((item) => item.correctionId === "done")).toBe(false);
  });
});

describe("portrait consolidation", () => {
  it("does nothing without a portrait adapter", async () => {
    const box = await world();
    await seedTwin(box);
    box.events.push(correction("corr-1"));
    const result = await run(box, model({ merge: codingEdit }), { attach: false });
    expect(result.ok).toBe(true);
    expect(box.requests).toEqual([]);
    expect(await pathsOf(box.drive)).toEqual([FULL, PROJECTS, CODING].sort());
  });

  it("skips when Drive has no full or coding layer", async () => {
    const box = await world();
    await seed(box.drive, FULL, FULL_TEXT);
    box.events.push(correction("corr-1"));
    const result = await run(box, model({ merge: codingEdit }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["没有现有数字分身，跳过"]);
    expect(box.requests).toEqual([]);
  });

  it("skips the model when there are no new turns and no corrections", async () => {
    const box = await world();
    await seedTwin(box);
    box.sessions = [{ sessionKey: "s1", title: "旧会话", turns: ["说过了"] }];
    box.cursors.set(PORTRAIT_TURNS_CURSOR, JSON.stringify({ s1: 1 }));
    const result = await run(box, model({ merge: codingEdit }));
    expect(result.ok).toBe(true);
    expect(box.requests).toEqual([]);
  });

  it("extracts claims, merges a coding rule, bumps the shared version and notifies", async () => {
    const box = await world();
    await seedTwin(box);
    box.sessions = [
      {
        sessionKey: "s1",
        title: "修 bug",
        turns: ["以后都先跑测试再交付<system-reminder>注入内容</system-reminder>", "我喜欢短回复"],
      },
    ];
    const result = await run(box, model({ claims: { claims: [highCoding, lowPersona] }, merge: codingEdit }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(box.requests.map((request) => request.system)).toEqual([
      TWIN_CLAIMS_SYSTEM_PROMPT,
      TWIN_MERGE_SYSTEM_PROMPT,
    ]);
    expect(box.requests[0]?.jsonSchema).toEqual(TWIN_CLAIMS_JSON_SCHEMA);
    expect(box.requests[0]?.user).toContain("以后都先跑测试再交付");
    expect(box.requests[0]?.user).not.toContain("注入内容");
    expect(box.requests[0]?.user).toContain("甲");
    expect(box.requests[1]?.jsonSchema).toEqual(TWIN_EDITS_JSON_SCHEMA);
    expect(box.requests[1]?.user).toContain(CODING_TEXT);
    expect(box.requests[1]?.user).toContain("[coding high 2026-10-23] 以后都先跑测试再交付。");

    const coding = await textAt(box.drive, CODING);
    expect(coding?.split("\n")[1]).toBe(`版本 v2.1.0 · ${LOCAL_DAY} · 变更见 changelog`);
    expect(coding).toContain("交付前先跑测试。");
    expect(coding).toContain(POINTER);
    expect(coding).not.toContain("对应的小节");
    expect(await textAt(box.drive, FULL)).toBe(FULL_TEXT);
    expect(await textAt(box.drive, PROJECTS)).toBe(PROJECTS_TEXT);
    expect(await textAt(box.drive, `digital-twin/consolidate-backup/JOHN-TWIN-coding-${LOCAL_DAY}.md`)).toBe(
      CODING_TEXT,
    );
    expect(await textAt(box.drive, `digital-twin/JOHN-DIGITAL-TWIN-v2.1.0-${LOCAL_DAY}.md`)).toBeNull();
    expect(await textAt(box.drive, CHANGELOG)).toStartWith(
      `# 数字分身变更记录\n\n## v2.1.0 · ${LOCAL_DAY}\n- coding · 1 授权与边界：新增先跑测试\n- 体积：`,
    );
    expect(jsonl(await textAt(box.drive, CLAIMS))).toEqual([
      { ...highCoding, day: LOCAL_DAY },
      { ...lowPersona, day: LOCAL_DAY },
    ]);
    expect(jsonl(await textAt(box.drive, PENDING))).toEqual([{ ...lowPersona, day: LOCAL_DAY }]);
    const paths = platformPaths({ platform: "darwin", homeDir: box.home, env: { YOU_BRAIN_HOME: box.home } });
    expect(await readFile(portraitFile(paths, "coding"), "utf8")).toBe(coding ?? "");
    expect(reminders(box.events)).toHaveLength(1);
    expect(reminders(box.events)[0]?.kind).toBe("portrait_updated");
    expect(reminders(box.events)[0]?.text).toStartWith("数字分身更新到 v2.1.0：coding · 1 授权与边界");
    expect(reminders(box.events)[0]?.text).toContain("https://drive.google.com/file/d/");
    expect(JSON.parse(box.cursors.get(PORTRAIT_TURNS_CURSOR) ?? "{}")).toEqual({ s1: 2 });

    box.requests.length = 0;
    const again = await run(box, model({ merge: codingEdit }));
    expect(again.ok).toBe(true);
    expect(box.requests).toEqual([]);
  });

  it("writes a full snapshot and stays quiet when only projects change", async () => {
    const box = await world();
    await seedTwin(box);
    box.sessions = [{ sessionKey: "s1", title: "乙", turns: ["乙项目一律按单号去重"] }];
    const projectOnly = {
      bump: "minor",
      changelog: ["projects · 乙：新增按单号去重"],
      edits: [{ layer: "projects", heading: "## 乙", text: "## 乙\n按单号去重。" }],
    };
    const result = await run(
      box,
      model({
        claims: { claims: [{ layer: "project", project: "乙", confidence: "high", text: "按单号去重。" }] },
        merge: projectOnly,
      }),
    );
    expect(result.ok).toBe(true);
    expect(await textAt(box.drive, PROJECTS)).toContain("## 乙\n按单号去重。");
    const coding = await textAt(box.drive, CODING);
    expect(coding).toBe(CODING_TEXT);
    expect(reminders(box.events)).toEqual([]);

    box.events.push(correction("corr-1", "full", "一句话改成先查证"));
    const fullEdit = {
      bump: "patch",
      changelog: ["full · 1 一句话：改为先查证"],
      edits: [{ layer: "full", heading: "## 1. 一句话", text: "## 1. 一句话\n先查证再动手。" }],
    };
    const second = await run(box, model({ merge: fullEdit }));
    expect(second.ok).toBe(true);
    const snapshot = `JOHN-DIGITAL-TWIN-v2.1.1-${LOCAL_DAY}.md`;
    expect(await textAt(box.drive, `digital-twin/${snapshot}`)).toBe(await textAt(box.drive, FULL));
    expect(applied(box.events, "corr-1")).toEqual([snapshot]);
    expect(reminders(box.events).map((item) => item.kind)).toEqual(["portrait_updated"]);
  });

  it("creates the projects layer when it is missing", async () => {
    const box = await world();
    await seedTwin(box, { full: FULL_TEXT, coding: CODING_TEXT, projects: "" });
    box.events.push(correction("corr-1", "projects", "甲用新口径"));
    const result = await run(
      box,
      model({ merge: { bump: "minor", changelog: [], edits: [{ layer: "projects", heading: "## 甲", text: "## 甲\n新口径。" }] } }),
    );
    expect(result.ok).toBe(true);
    expect(await textAt(box.drive, PROJECTS)).toBe(
      `# 数字分身 · 项目决定\n版本 v2.1.0 · ${LOCAL_DAY} · 变更见 changelog\n\n## 甲\n新口径。\n`,
    );
    expect(box.requests[0]?.user).toContain("层：projects");
  });

  it("keeps low-confidence claims pending without a merge", async () => {
    const box = await world();
    await seedTwin(box);
    box.sessions = [{ sessionKey: "s1", title: "闲聊", turns: ["我喜欢短回复"] }];
    const result = await run(box, model({ claims: { claims: [lowPersona] } }));
    expect(result.ok).toBe(true);
    expect(box.requests.map((request) => request.system)).toEqual([TWIN_CLAIMS_SYSTEM_PROMPT]);
    expect(jsonl(await textAt(box.drive, PENDING))).toEqual([{ ...lowPersona, day: LOCAL_DAY }]);
    expect(await textAt(box.drive, FULL)).toBe(FULL_TEXT);

    box.requests.length = 0;
    box.sessions[0]?.turns.push("短回复就好");
    const next = await run(box, model({ claims: { claims: [lowPersona] }, merge: noEdits }), { day: "2026-10-24" });
    expect(next.ok).toBe(true);
    expect(box.requests.map((request) => request.system)).toEqual([
      TWIN_CLAIMS_SYSTEM_PROMPT,
      TWIN_MERGE_SYSTEM_PROMPT,
    ]);
    expect(box.requests[1]?.user).toContain("[persona low 2026-10-23] 喜欢短回复。");
    expect(jsonl(await textAt(box.drive, PENDING))).toHaveLength(2);
  });

  it("runs one fix pass for bookkeeping words and writes the fixed text", async () => {
    const box = await world();
    await seedTwin(box);
    box.events.push(correction("corr-1", "coding"));
    const dirty = {
      ...codingEdit,
      edits: [{ layer: "coding", heading: "## 1. 授权与边界", text: "## 1. 授权与边界\n先跑测试（待确认）。" }],
    };
    const clean = {
      ...noEdits,
      edits: [{ layer: "coding", heading: "## 1. 授权与边界", text: "## 1. 授权与边界\n先跑测试。" }],
    };
    const result = await run(box, model({ merge: dirty, fix: clean }));
    expect(result.ok).toBe(true);
    expect(box.requests.map((request) => request.system)).toEqual([TWIN_MERGE_SYSTEM_PROMPT, TWIN_FIX_SYSTEM_PROMPT]);
    expect(box.requests[1]?.user).toContain("coding 出现禁用的记账措辞：待确认");
    expect(await textAt(box.drive, CODING)).toContain("## 1. 授权与边界\n先跑测试。");
  });

  it("drops the run when the fix pass still fails or a secret shows up", async () => {
    const box = await world();
    await seedTwin(box);
    box.events.push(correction("corr-1", "coding"));
    const dirty = {
      ...codingEdit,
      edits: [{ layer: "coding", heading: "## 1. 授权与边界", text: "## 1. 授权与边界\n样本数 3。" }],
    };
    const stillBad = await run(box, model({ merge: dirty, fix: noEdits }));
    expect(stillBad.ok).toBe(true);
    expect(stillBad.warnings[0]).toStartWith("数字分身没有通过写入前检查，已跳过：coding 出现禁用的记账措辞：样本数");
    expect(await textAt(box.drive, CODING)).toBe(CODING_TEXT);
    expect(applied(box.events, "corr-1")).toEqual([]);

    box.requests.length = 0;
    const leak = {
      ...codingEdit,
      edits: [{ layer: "coding", heading: "## 1. 授权与边界", text: "## 1. 授权与边界\n令牌 token: abcdefghijk。" }],
    };
    const secret = await run(box, model({ merge: leak }));
    expect(secret.warnings).toEqual(["数字分身里发现疑似敏感信息，已跳过：coding：密钥"]);
    expect(box.requests.map((request) => request.system)).toEqual([TWIN_MERGE_SYSTEM_PROMPT]);
    expect(await pathsOf(box.drive)).toEqual([FULL, PROJECTS, CODING].sort());
  });

  it("refuses a layer that shrinks below half", async () => {
    const box = await world();
    await seedTwin(box);
    box.events.push(correction("corr-1", "coding"));
    const shrink = {
      ...codingEdit,
      edits: [
        { layer: "coding", heading: "## 5. 技术栈默认", text: "" },
        { layer: "coding", heading: "## 1. 授权与边界", text: "" },
      ],
    };
    const result = await run(box, model({ merge: shrink }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["数字分身 coding 输出不到原来的一半，已跳过"]);
    expect(await textAt(box.drive, CODING)).toBe(CODING_TEXT);
  });

  it("does not overwrite a layer another writer changed after the read", async () => {
    const box = await world();
    await seedTwin(box);
    const codingFile = await box.drive.findByPath(CODING);
    box.events.push(correction("corr-1", "coding"));
    const other = `${CODING_TEXT}别人刚写的一段。\n`;
    const result = await run(box, async (request) => {
      if (request.system === TWIN_MERGE_SYSTEM_PROMPT && codingFile) await box.drive.update(codingFile.id, other);
      return model({ merge: codingEdit })(request);
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["数字分身在沉淀期间被别处更新，已跳过"]);
    expect(await textAt(box.drive, CODING)).toBe(other);
    expect(applied(box.events, "corr-1")).toEqual([]);
    expect(box.cursors.get(PORTRAIT_TURNS_CURSOR)).toBeUndefined();
  });

  it("retries invalid JSON once and then fails the step", async () => {
    const box = await world();
    await seedTwin(box);
    box.events.push(correction("corr-1"));
    const result = await run(box, () => "not-json");
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.error).toStartWith("数字分身没有写完");
    expect(box.requests).toHaveLength(2);
    expect(box.requests[1]?.user).toContain("上次输出无法通过校验");
    expect(await pathsOf(box.drive)).toEqual([FULL, PROJECTS, CODING].sort());
  });

  it("accepts the second JSON after one invalid reply", async () => {
    const box = await world();
    await seedTwin(box);
    box.events.push(correction("corr-1", "coding"));
    let calls = 0;
    const result = await run(box, (request) => {
      calls += 1;
      return calls === 1 ? "not-json" : model({ merge: codingEdit })(request);
    });
    expect(result.ok).toBe(true);
    expect(await textAt(box.drive, CODING)).toContain("交付前先跑测试。");
    expect(applied(box.events, "corr-1")).toEqual(["v2.0.0"]);
  });

  it("writes nothing and applies corrections when the model has no edits", async () => {
    const box = await world();
    await seedTwin(box);
    box.events.push(correction("corr-1"));
    const result = await run(box, model({ merge: noEdits }));
    expect(result.ok).toBe(true);
    expect(await pathsOf(box.drive)).toEqual([FULL, PROJECTS, CODING].sort());
    expect(applied(box.events, "corr-1")).toEqual(["v2.0.0"]);
  });
});

describe("portrait eval", () => {
  const probe = { id: "p01", layer: "coding", situation: "用户问为什么报错", expect: "只排查不改代码" };

  it("adds probes from the week's claims, scores them, and logs the score", async () => {
    const box = await world();
    await seedTwin(box);
    await seed(box.drive, PROBES, `${JSON.stringify(probe)}\n`);
    await seed(box.drive, CLAIMS, `${JSON.stringify({ ...highCoding, day: LOCAL_DAY })}\n`);
    const result = await run(
      box,
      model({
        probes: { probes: [{ layer: "coding", situation: "用户说先别跑", expect: "停下不执行" }] },
        answers: { answers: [{ id: "p01", answer: "先排查" }, { id: "p02", answer: "继续跑" }] },
        judge: { results: [{ id: "p01", pass: true }, { id: "p02", pass: false }] },
      }),
      { steps: [portraitEvalStep] },
    );
    expect(result.ok).toBe(true);
    expect(box.requests.map((request) => request.system)).toEqual([
      TWIN_PROBES_SYSTEM_PROMPT,
      TWIN_EVAL_ANSWER_SYSTEM_PROMPT,
      TWIN_EVAL_JUDGE_SYSTEM_PROMPT,
    ]);
    expect(box.requests[1]?.user).toContain(FULL_TEXT);
    expect(box.requests[1]?.user).not.toContain(PROJECTS_TEXT);
    expect(box.requests[1]?.user).not.toContain("只排查不改代码");
    expect(jsonl(await textAt(box.drive, PROBES))).toEqual([
      probe,
      { id: "p02", layer: "coding", situation: "用户说先别跑", expect: "停下不执行" },
    ]);
    const log = await textAt(box.drive, CHANGELOG);
    expect(log).toContain(`## 评测 · ${LOCAL_DAY}\n- 得分 1/2\n`);
    expect(log).toContain("- 答错：p02");
    expect(JSON.parse(box.cursors.get(PORTRAIT_EVAL_CURSOR) ?? "{}")).toMatchObject({ day: LOCAL_DAY, pass: 1, total: 2 });
    expect(reminders(box.events)).toEqual([]);

    box.requests.length = 0;
    const soon = await run(box, model({}), { steps: [portraitEvalStep], day: "2026-10-29" });
    expect(soon.ok).toBe(true);
    expect(box.requests).toEqual([]);
  });

  it("flags a score drop in the weekly review", async () => {
    const box = await world();
    await seedTwin(box);
    await seed(box.drive, PROBES, `${JSON.stringify(probe)}\n`);
    box.cursors.set(
      PORTRAIT_EVAL_CURSOR,
      JSON.stringify({ day: "2026-10-16", pass: 1, total: 1, full: 1, coding: 1 }),
    );
    const result = await run(
      box,
      model({ answers: { answers: [{ id: "p01", answer: "直接改" }] }, judge: { results: [{ id: "p01", pass: false }] } }),
      { steps: [portraitEvalStep] },
    );
    expect(result.ok).toBe(true);
    expect(reminders(box.events)).toEqual([
      {
        kind: "portrait_eval",
        text: "保真评测得分从 1/1 降到 0/1；常驻层变长了，评测得分没有上升。答错的题：p01",
      },
    ]);
  });
});

describe("portrait monthly comparison", () => {
  const MONTH_AGO = "digital-twin/JOHN-DIGITAL-TWIN-v1.9.0-2026-09-20.md";

  it("compares against the month-old snapshot and logs the changes", async () => {
    const box = await world();
    await seedTwin(box);
    await seed(
      box.drive,
      MONTH_AGO,
      "# 数字分身 · 人格\n版本 v1.9.0 · 2026-09-20 · 变更见 changelog\n\n## 3. 价值排序\n可靠优先。\n",
    );
    box.cursors.set(
      PORTRAIT_EVAL_CURSOR,
      JSON.stringify({ day: LOCAL_DAY, pass: 2, total: 2, full: 1, coding: 1 }),
    );
    box.cursors.set(
      PORTRAIT_MONTHLY_CURSOR,
      JSON.stringify({ day: "2026-09-23", pass: 1, total: 2 }),
    );
    const result = await run(
      box,
      model({ monthly: { notes: ["新增了「交付前先跑测试」的工程规则。"] } }),
      { steps: [portraitMonthlyStep] },
    );
    expect(result.ok).toBe(true);
    expect(box.requests).toHaveLength(1);
    expect(box.requests[0]?.system).toBe(TWIN_MONTHLY_SYSTEM_PROMPT);
    expect(box.requests[0]?.user).toContain("可靠优先。");
    const log = await textAt(box.drive, CHANGELOG);
    expect(log).toContain(`## 月度对比 · ${LOCAL_DAY}`);
    expect(log).toContain("- 对比基准 2026-09-20（v1.9.0）");
    expect(log).toContain("- 新增了「交付前先跑测试」的工程规则。");
    expect(log).toContain("- 评测得分 1/2 → 2/2");
    expect(JSON.parse(box.cursors.get(PORTRAIT_MONTHLY_CURSOR) ?? "{}")).toMatchObject({
      day: LOCAL_DAY,
      pass: 2,
      total: 2,
    });
    expect(reminders(box.events)).toEqual([
      {
        kind: "portrait_monthly",
        text: "数字分身月度对比：新增了「交付前先跑测试」的工程规则。（详见 changelog）",
      },
    ]);
  });

  it("starts the window without a baseline when no snapshot is old enough", async () => {
    const box = await world();
    await seedTwin(box);
    // Only a recent snapshot exists: nothing to compare against yet.
    await seed(
      box.drive,
      "digital-twin/JOHN-DIGITAL-TWIN-v2.0.0-2026-10-20.md",
      "# 数字分身 · 人格\n版本 v2.0.0 · 2026-10-20 · 变更见 changelog\n\n## 1. 一句话\n先问再做。\n",
    );
    const result = await run(box, model({}), { steps: [portraitMonthlyStep] });
    expect(result.ok).toBe(true);
    expect(box.requests).toEqual([]);
    expect(await textAt(box.drive, CHANGELOG)).toBe(null);
    expect(JSON.parse(box.cursors.get(PORTRAIT_MONTHLY_CURSOR) ?? "{}")).toMatchObject({
      day: LOCAL_DAY,
    });
  });

  it("skips within the month", async () => {
    const box = await world();
    await seedTwin(box);
    box.cursors.set(PORTRAIT_MONTHLY_CURSOR, JSON.stringify({ day: "2026-10-10", pass: 1, total: 2 }));
    const result = await run(box, model({}), { steps: [portraitMonthlyStep] });
    expect(result.ok).toBe(true);
    expect(box.requests).toEqual([]);
    expect(box.cursors.get(PORTRAIT_MONTHLY_CURSOR)).toBe(
      JSON.stringify({ day: "2026-10-10", pass: 1, total: 2 }),
    );
  });
});

describe("portrait rebuild", () => {
  it("reuses today's extracted claims and keeps fixing until the budget holds", async () => {
    const box = await world();
    await seed(box.drive, FULL, "# 旧分身\nv1.3.11 · 2026-10-27\n\n## 1. 行为\n旧规则。\n");
    await seed(box.drive, CODING, "# 旧编码\nv1.3.11 · 2026-10-27\n\n## 编码\n旧编码规则。\n");
    await seed(
      box.drive,
      `digital-twin/claims/rebuild-${LOCAL_DAY}.jsonl`,
      `${JSON.stringify({ ...highCoding, day: LOCAL_DAY })}\n`,
    );
    const bloated = { layer: "coding", heading: "## 3. 实现原则", text: `## 3. 实现原则\n${"一条很长的规则。".repeat(600)}` };
    const fixes: unknown[] = [
      { ...noEdits, edits: [{ ...bloated, text: `## 3. 实现原则\n${"一条很长的规则。".repeat(560)}` }] },
      { ...noEdits, edits: [{ ...bloated, text: `## 3. 实现原则\n${"一条很长的规则。".repeat(530)}` }] },
      { ...noEdits, edits: [{ ...bloated, text: "## 3. 实现原则\n交付前先跑测试。" }] },
    ];
    const lines: string[] = [];
    const result = await rebuildTwin({
      llm: fakeBackend(async (request) => {
        box.requests.push(request);
        if (request.system === TWIN_FIX_SYSTEM_PROMPT) return JSON.stringify(fixes.shift());
        return model({ merge: { bump: "major", changelog: [], edits: [bloated] } })(request);
      }),
      portrait: box.portrait,
      day: LOCAL_DAY,
      log: (line) => lines.push(line),
    });
    expect(result.version).toBe("2.0.0");
    expect(box.requests.some((request) => request.system === TWIN_CLAIMS_SYSTEM_PROMPT)).toBe(false);
    expect(lines[0]).toBe("复用今天已抽取的 1 条主张");
    const fixRequests = box.requests.filter((request) => request.system === TWIN_FIX_SYSTEM_PROMPT);
    expect(fixRequests).toHaveLength(3);
    expect(fixRequests[0]?.user).toContain("- coding ## 3. 实现原则：");
    expect(fixRequests[0]?.user).toContain("超过 4096 字节预算，要压到 3600 字节以内");
    expect(lines.filter((line) => line.startsWith("收尾修正第"))).toHaveLength(2);
    expect(await textAt(box.drive, CODING)).toContain("## 3. 实现原则\n交付前先跑测试。");
  });


  it("rebuilds the three layers from the old files with a major bump", async () => {
    const box = await world();
    const oldFull = `# 旧分身\nv1.3.11 · 2026-10-27 · derived\n\n## 1. 行为\n${"旧规则。".repeat(50)}\n`;
    const oldCoding = `# 旧编码\nv1.3.11 · 2026-10-27\n\n## 编码\n${"旧编码规则。".repeat(50)}\n`;
    await seed(box.drive, FULL, oldFull);
    await seed(box.drive, CODING, oldCoding);
    const claims = {
      claims: [
        { layer: "persona", project: "", confidence: "high", text: "先问再做。" },
        { layer: "coding", project: "", confidence: "high", text: "交付前先跑测试。" },
        { layer: "project", project: "甲", confidence: "high", text: "甲按单号去重。" },
        { layer: "persona", project: "", confidence: "low", text: "暂定喜欢短回复。" },
      ],
    };
    const merges: unknown[] = [
      { bump: "major", changelog: ["full 起步"], edits: [{ layer: "full", heading: "## 1. 一句话", text: "## 1. 一句话\n先问再做。" }] },
      { bump: "major", changelog: [], edits: [{ layer: "coding", heading: "## 5. 技术栈默认", text: "## 5. 技术栈默认\n交付前先跑测试。" }] },
      { bump: "major", changelog: [], edits: [{ layer: "projects", heading: "## 甲", text: "## 甲\n按单号去重。" }] },
    ];
    const lines: string[] = [];
    const result = await rebuildTwin({
      llm: fakeBackend(async (request) => {
        box.requests.push(request);
        if (request.system === TWIN_MERGE_SYSTEM_PROMPT) return JSON.stringify(merges.shift());
        return model({ claims })(request);
      }),
      portrait: box.portrait,
      day: LOCAL_DAY,
      log: (line) => lines.push(line),
    });
    expect(result.version).toBe("2.0.0");
    expect(result.claims).toBe(4);
    expect(box.requests.filter((request) => request.system === TWIN_CLAIMS_SYSTEM_PROMPT)).toHaveLength(2);
    expect(box.requests[0]?.user).toContain("旧版数字分身");
    const merged = box.requests.filter((request) => request.system === TWIN_MERGE_SYSTEM_PROMPT);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.user).toContain("[persona high");
    expect(merged.every((request) => !request.user.includes("暂定喜欢短回复"))).toBe(true);

    const full = await textAt(box.drive, FULL);
    expect(full?.split("\n").slice(0, 2)).toEqual(["# 数字分身 · 人格", `版本 v2.0.0 · ${LOCAL_DAY} · 变更见 changelog`]);
    expect(full).toContain("## 11. 生活");
    expect(full).not.toContain("旧规则");
    const coding = await textAt(box.drive, CODING);
    expect(coding).toContain(POINTER);
    expect(coding).not.toContain("对应的小节");
    expect(coding).toContain("## 5. 技术栈默认\n交付前先跑测试。");
    expect(await textAt(box.drive, PROJECTS)).toBe(
      `# 数字分身 · 项目决定\n版本 v2.0.0 · ${LOCAL_DAY} · 变更见 changelog\n\n## 甲\n按单号去重。\n`,
    );
    expect(await textAt(box.drive, `digital-twin/JOHN-DIGITAL-TWIN-v2.0.0-${LOCAL_DAY}.md`)).toBe(full);
    expect(await textAt(box.drive, `digital-twin/consolidate-backup/JOHN-DIGITAL-TWIN-latest-${LOCAL_DAY}.md`)).toBe(
      oldFull,
    );
    expect(jsonl(await textAt(box.drive, `digital-twin/claims/rebuild-${LOCAL_DAY}.jsonl`))).toHaveLength(4);
    expect(await textAt(box.drive, PENDING)).toBeNull();
    expect(await textAt(box.drive, CHANGELOG)).toContain("从 v1.3.11 重建为三层");
    expect(lines[0]).toBe("旧分身切成 2 段，开始抽取主张");
  });
});
