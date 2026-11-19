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
  PROJECTS_POINTER,
  TWIN_CLAIMS_JSON_SCHEMA,
  TWIN_CLAIMS_SYSTEM_PROMPT,
  TWIN_CODING_PROPOSALS_JSON_SCHEMA,
  TWIN_CODING_PROPOSALS_SYSTEM_PROMPT,
  TWIN_EDITS_JSON_SCHEMA,
  TWIN_MERGE_SYSTEM_PROMPT,
  TWIN_PROJECT_MERGE_SYSTEM_PROMPT,
  applyTwinEdits,
  changedLayers,
  checkTwin,
  cleanUserTurn,
  createDrivePortrait,
  fillSnapshotPattern,
  normalizeProjectsTwin,
  pendingCorrections,
  portraitEvalStep,
  portraitMonthlyStep,
  portraitStep,
  readTwinSessions,
  rebuildTwin,
  reviewCodingProposals,
  reviewProbes,
  runConsolidation,
  seedCodingFromMarkdown,
  seedCodingTwin,
  twinVersion,
  withHeader,
  withProjectsPointer,
  type ConsolidationPortrait,
} from "../../src/consolidate/index.js";
import {
  TWIN_EVAL_ANSWER_SYSTEM_PROMPT,
  TWIN_EVAL_BLANK_SYSTEM_PROMPT,
  TWIN_EVAL_GENERIC_PERSONA,
  TWIN_EVAL_JUDGE_SYSTEM_PROMPT,
  TWIN_FIX_SYSTEM_PROMPT,
  TWIN_MONTHLY_SYSTEM_PROMPT,
  TWIN_PROBES_SYSTEM_PROMPT,
} from "../../src/consolidate/prompt.js";
import { TWIN_SKELETON } from "../../src/consolidate/twin.js";
import { twinCrossLayerProblems, twinStandardProblems } from "../../src/consolidate/twin-standard.js";
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
const PENDING_PROBES = "digital-twin/eval/pending-probes.jsonl";
const VERSION_LINE = "版本 v2.0.0 · 2026-10-20 · 变更见 changelog";

const FULL_TEXT = `# 数字分身 · 人格\n${VERSION_LINE}\n\n## 1. 一句话\n先问再做。\n\n## 3. 价值排序\n${"可靠优先。".repeat(20)}\n`;
const POINTER = PROJECTS_POINTER;
const CODING_TEXT = `# 数字分身 · 编码\n${VERSION_LINE}\n\n## 核心原则\n${POINTER}\n\n## 1. 授权与边界\n${"提问不等于授权改代码。".repeat(15)}\n\n## 5. 技术栈默认\n${"Python 用 uv。".repeat(20)}\n`;
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
  codingProposals?: unknown;
  merge?: unknown;
  projectMerge?: unknown;
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
    if (request.system === TWIN_CODING_PROPOSALS_SYSTEM_PROMPT) {
      return pick(replies.codingProposals ?? { proposals: [] });
    }
    if (request.system === TWIN_MERGE_SYSTEM_PROMPT) return pick(replies.merge ?? noEdits);
    if (request.system === TWIN_PROJECT_MERGE_SYSTEM_PROMPT) {
      return pick(replies.projectMerge ?? replies.merge ?? noEdits);
    }
    if (request.system === TWIN_FIX_SYSTEM_PROMPT) return pick(replies.fix ?? noEdits);
    if (request.system === TWIN_PROBES_SYSTEM_PROMPT) return pick(replies.probes ?? { probes: [] });
    if (request.system === TWIN_EVAL_ANSWER_SYSTEM_PROMPT || request.system === TWIN_EVAL_BLANK_SYSTEM_PROMPT) {
      return pick(replies.answers ?? { answers: [] });
    }
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
    expect(coding).toContain("## 行为与范围\n- **项目口径**：");
    expect(coding.indexOf("## 行为与范围")).toBeLessThan(coding.indexOf("## 1. 授权与边界"));
    expect(coding).not.toContain("对应的小节：甲");
  });

  it("groups split project sections contiguously and normalizes repos metadata", () => {
    const messy = `# 数字分身 · 项目决定\n${VERSION_LINE}\n\n## 甲 · 架构\n> repos: repo-a\n甲架构。\n\n## 乙\n乙口径。\n\n## 甲 · 接口\n> repos: repo-b\n甲接口。\n`;
    const normalized = normalizeProjectsTwin(messy);
    expect(normalized).toContain("## 甲 · 架构\n> repos: repo-a, repo-b\n甲架构。\n\n## 甲 · 接口\n甲接口。\n\n## 乙\n乙口径。\n");
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

  it("drops injected context and automated raw batch digests from user turns", () => {
    expect(cleanUserTurn("先别改<system-reminder>注入</system-reminder> 代码")).toBe("先别改 代码");
    expect(cleanUserTurn("This session is being continued from a previous conversation")).toBe("");
    expect(cleanUserTurn("<command-name>/x</command-name>")).toBe("");
    expect(cleanUserTurn("只根据 2026-11-10/1400.raw.txt 整理拼车群日报")).toBe("");
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

  it("routes session coding claims to pending proposals while merging persona claims, then applies approved proposals", async () => {
    const box = await world();
    await seedTwin(box);
    box.sessions = [
      {
        sessionKey: "s1",
        title: "修 bug",
        turns: ["以后都先跑测试再交付<system-reminder>注入内容</system-reminder>", "我一律先查证再动手", "我喜欢短回复"],
      },
    ];
    const highPersona = { layer: "persona", project: "", confidence: "high", text: "先查证再动手。" };
    const personaEdit = {
      bump: "minor",
      changelog: ["full · 1 一句话：改为先查证再动手"],
      edits: [{ layer: "full", heading: "## 1. 一句话", text: "## 1. 一句话\n先查证再动手。" }],
    };
    const result = await run(
      box,
      model({
        claims: { claims: [highPersona, highCoding, lowPersona] },
        codingProposals: {
          proposals: [
            {
              section: "## 验证与交付",
              action: "add",
              proposedLine: "- **变更验证**：修改后先跑适用测试再交付。",
              reason: "用户要求交付前跑测试",
            },
          ],
        },
        merge: personaEdit,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(box.requests.map((request) => request.system)).toEqual([
      TWIN_CLAIMS_SYSTEM_PROMPT,
      TWIN_CODING_PROPOSALS_SYSTEM_PROMPT,
      TWIN_MERGE_SYSTEM_PROMPT,
    ]);
    expect(box.requests[0]?.jsonSchema).toEqual(TWIN_CLAIMS_JSON_SCHEMA);
    expect(box.requests[0]?.user).toContain("以后都先跑测试再交付");
    expect(box.requests[0]?.user).not.toContain("注入内容");
    expect(box.requests[0]?.user).toContain("甲");
    expect(box.requests[1]?.jsonSchema).toEqual(TWIN_CODING_PROPOSALS_JSON_SCHEMA);
    expect(box.requests[1]?.user).toContain(CODING_TEXT);
    expect(box.requests[1]?.user).toContain("[coding high 2026-10-23] 以后都先跑测试再交付。");
    expect(box.requests[2]?.jsonSchema).toEqual(TWIN_EDITS_JSON_SCHEMA);
    expect(box.requests[2]?.user).not.toContain(PROJECTS_TEXT);

    // coding.md is NOT mutated until the user approves the proposal!
    expect(await textAt(box.drive, CODING)).toBe(CODING_TEXT);
    const full = await textAt(box.drive, FULL);
    expect(full?.split("\n")[1]).toBe(`版本 v2.1.0 · ${LOCAL_DAY} · 变更见 changelog`);
    expect(full).toContain("先查证再动手。");
    expect(await textAt(box.drive, PROJECTS)).toBe(PROJECTS_TEXT);
    expect(await textAt(box.drive, `digital-twin/consolidate-backup/JOHN-DIGITAL-TWIN-latest-${LOCAL_DAY}.md`)).toBe(
      FULL_TEXT,
    );
    expect(await textAt(box.drive, CHANGELOG)).toStartWith(
      `# 数字分身变更记录\n\n## v2.1.0 · ${LOCAL_DAY}\n- full · 1 一句话：改为先查证再动手\n- 体积：`,
    );
    expect(jsonl(await textAt(box.drive, CLAIMS))).toEqual([
      { ...highPersona, day: LOCAL_DAY },
      { ...highCoding, day: LOCAL_DAY },
      { ...lowPersona, day: LOCAL_DAY },
    ]);
    expect(jsonl(await textAt(box.drive, PENDING))).toEqual([{ ...lowPersona, day: LOCAL_DAY }]);
    expect(jsonl(await textAt(box.drive, "digital-twin/proposals/coding-pending.jsonl"))).toEqual([
      {
        id: "cp01",
        day: LOCAL_DAY,
        section: "## 验证与交付",
        action: "add",
        proposedLine: "- **变更验证**：修改后先跑适用测试再交付。",
        reason: "用户要求交付前跑测试",
      },
    ]);
    expect(reminders(box.events).map((item) => item.kind)).toEqual([
      "portrait_coding_proposal",
      "portrait_updated",
    ]);
    expect(JSON.parse(box.cursors.get(PORTRAIT_TURNS_CURSOR) ?? "{}")).toEqual({ s1: 3 });

    // Approving cp01 merges it into coding.md and clears coding-pending.jsonl
    const reviewed = await reviewCodingProposals({
      portrait: box.portrait,
      day: LOCAL_DAY,
      decide: async () => ({ action: "approve" }),
    });
    expect(reviewed).toEqual({ approved: 1, rejected: 0, left: 0, version: "2.2.0" });
    const codingAfter = await textAt(box.drive, CODING);
    expect(codingAfter).toContain("- **变更验证**：修改后先跑适用测试再交付。");
    expect(codingAfter).toContain(POINTER);
    const paths = platformPaths({ platform: "darwin", homeDir: box.home, env: { YOU_BRAIN_HOME: box.home } });
    expect(await readFile(portraitFile(paths, "coding"), "utf8")).toBe(codingAfter ?? "");
    expect(jsonl(await textAt(box.drive, "digital-twin/proposals/coding-pending.jsonl"))).toEqual([]);

    box.requests.length = 0;
    const again = await run(box, model({ merge: codingEdit }));
    expect(again.ok).toBe(true);
    expect(box.requests).toEqual([]);
  });

  it("merges only the touched project group during project consolidation without sending unrelated projects", async () => {
    const box = await world();
    const bigProjects = `# 数字分身 · 项目决定\n${VERSION_LINE}\n\n## 甲 · 架构\n> repos: legal-ai\n旧数据源用 A。\n\n## 无关大项目\n${"无关口径。".repeat(80)}\n`;
    await seedTwin(box, { full: FULL_TEXT, coding: CODING_TEXT, projects: bigProjects });
    box.sessions = [{ sessionKey: "s1", title: "法务", turns: ["legal-ai 数据源改成 B，废弃 A"] }];
    const result = await run(
      box,
      model({
        claims: {
          claims: [
            { layer: "project", project: "甲", repo: "legal-ai", confidence: "high", text: "数据源改为 B，不再用 A。" },
          ],
        },
        projectMerge: {
          bump: "minor",
          changelog: ["projects · 甲：更新数据源为 B"],
          edits: [{ layer: "projects", heading: "## 甲 · 架构", text: "## 甲 · 架构\n> repos: legal-ai\n数据源改为 B。" }],
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(box.requests.map((request) => request.system)).toEqual([
      TWIN_CLAIMS_SYSTEM_PROMPT,
      TWIN_PROJECT_MERGE_SYSTEM_PROMPT,
    ]);
    expect(box.requests[1]?.user).toContain("## 甲 · 架构");
    expect(box.requests[1]?.user).toContain("repo:legal-ai");
    expect(box.requests[1]?.user).not.toContain("无关大项目");
    const updatedProjects = await textAt(box.drive, PROJECTS);
    expect(updatedProjects).toContain("## 甲 · 架构\n> repos: legal-ai\n数据源改为 B。");
    expect(updatedProjects).not.toContain("旧数据源用 A");
    expect(updatedProjects).toContain("## 无关大项目");
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

describe("twin quality standard", () => {
  const head = (title: string) => `${title}\n${VERSION_LINE}\n\n`;
  const section = (heading: string, body: string) => `${heading}\n${body}\n`;
  const fullWith = (overrides: Record<string, string> = {}) =>
    head("# 数字分身 · 人格") +
    TWIN_SKELETON.full
      .map((heading, index) =>
        section(
          heading,
          overrides[heading] ?? (index === 1 ? "以下是 2026 年 11 月的状态。" : `第${index + 1}节：先查证再动手。`),
        ),
      )
      .join("\n");
  const codingWith = (principles = `${POINTER}\n- **先证据**：先读代码再给方案。`) =>
    [
      head("# 数字分身 · 编码").trimEnd(),
      section("## 行为与范围", principles).trimEnd(),
      section("## 安全与授权", "- **提交授权**：仅在用户要求时执行 commit 或 push。").trimEnd(),
      section("## 验证与交付", "- **变更验证**：修改后运行适用的测试与类型检查。").trimEnd(),
      section("## 并行与指令优先级", "- **指令优先级**：用户明确要求优先于通用建议。"),
    ].join("\n\n");

  it("accepts a layer that follows the standard", () => {
    expect(twinStandardProblems("full", fullWith())).toEqual([]);
    expect(twinStandardProblems("coding", codingWith())).toEqual([]);
    expect(twinStandardProblems("projects", "任意内容")).toEqual([]);
  });

  it("rejects a changed skeleton, over-long lists and lines, loose semicolons, and project leaks", () => {
    expect(twinStandardProblems("full", FULL_TEXT)[0]).toContain("小节要固定为");
    const crowded = [
      "技术正确优先于对话舒服。",
      "通用方案优先于现象补丁。",
      "真实数据优先于好看的入口。",
      "可复现优先于单次更好。",
      "守住范围优先于顺手多做。",
      "验收通过优先于先交再改。",
    ].join("\n");
    expect(twinStandardProblems("full", fullWith({ "## 3. 价值排序": crowded }))).toEqual([
      expect.stringContaining("价值排序 有 6 条，最多 5 条"),
    ]);
    expect(twinStandardProblems("full", fullWith({ "## 9. 红线": "长".repeat(111) }))[0]).toContain("最多 110 字");
    expect(twinStandardProblems("full", fullWith({ "## 9. 红线": "甲；乙；丙；丁。" }))[0]).toContain("分号");
    expect(twinStandardProblems("full", fullWith({ "## 9. 红线": "空值展示「待补录」。" }))[0]).toContain("产品文案口径");
    expect(twinStandardProblems("coding", codingWith(`${POINTER}\n先证据，没有主题。`))[0]).toContain("**短标题**");
    expect(twinStandardProblems("coding", codingWith(`${POINTER}\n- **配置中心**：优先走 Apollo 和 XXL-JOB。`))[0]).toContain(
      "Apollo",
    );
  });

  it("seeds a compliant 4-section coding twin from hand-crafted AGENTS.md while stripping local tools", async () => {
    const handCrafted = [
      "# AGENTS.md",
      "",
      "## 行为准则",
      "1. 问 ≠ 做，行动请求 = 授权。 按动词判断执行与分析。",
      "2. 保护用户修改。 不覆盖用户已有的未提交修改。",
      "3. 危险操作需授权。 删除数据或部署需明确授权。",
      "",
      "## Git",
      "- 仅在用户要求时 commit / push。",
      "",
      "## 沟通与交付",
      "- 默认用中文，先说结论。",
      "",
      "## 指令与上下文",
      "- 用户明确要求优先于通用建议。",
      "",
      "## 并行协作",
      "- 仅当子任务相互独立时交给子代理。",
      "",
      "## 验证与完成",
      "- 修改后运行适用的测试、lint、typecheck 或 build。",
      "",
      "## 本机工具",
      "<!-- CODEGRAPH_START -->",
      "- 使用 codegraph_explore。",
      "<!-- CODEGRAPH_END -->",
      "- 执行命令前读取 /Users/alice/.codex/RTK.md，使用 rtk 前缀。",
    ].join("\n");
    const seeded = seedCodingFromMarkdown(handCrafted, "3.0.0", LOCAL_DAY);
    expect(twinStandardProblems("coding", seeded)).toEqual([]);
    expect(seeded).not.toContain("codegraph");
    expect(seeded).not.toContain("rtk");
    expect(seeded).not.toContain("/Users/alice");
    expect(seeded).toContain("- **问≠做，行动请求=授权**：");

    const box = await world();
    await seedTwin(box);
    const saved = await seedCodingTwin({ portrait: box.portrait, sourceMarkdown: handCrafted, day: LOCAL_DAY });
    expect(saved.version).toBe("2.1.0");
    expect(await textAt(box.drive, CODING)).toBe(saved.text);
  });

  it("counts quote samples apart and exempts them from the line rules", () => {
    const quotes = Array.from({ length: 10 }, (_, index) => `「最近这句话是第 ${index} 句。」`).join("\n");
    expect(twinStandardProblems("full", fullWith({ "## 7. 说话方式": `原话样本：\n${quotes}` }))).toEqual([]);
    expect(
      twinStandardProblems("full", fullWith({ "## 7. 说话方式": `${quotes}\n「第十一句。」` }))[0],
    ).toContain("11 条原话");
  });

  it("rejects diary wording, filler, a missing date, and rules that say the same thing", () => {
    expect(twinStandardProblems("full", fullWith({ "## 9. 红线": "最近不要直接改线上。" }))[0]).toContain("流水账");
    expect(twinStandardProblems("full", fullWith({ "## 9. 红线": "验证至关重要。" }))[0]).toContain("空话");
    expect(twinStandardProblems("full", fullWith({ "## 2. 现在在做什么": "主业在做合同比对。" }))[0]).toContain("年月");
    expect(
      twinStandardProblems("full", fullWith({ "## 2. 现在在做什么": "以下是 2026 年 11 月的状态。\n近期在做合同比对。" })),
    ).toEqual([]);
    const same = "交付前助手要自己把功能跑通再交给用户。\n交付前助手要自己把功能跑通再交给用户试用。";
    expect(twinStandardProblems("full", fullWith({ "## 9. 红线": same }))[0]).toContain("同一件事");
  });

  it("sends a merge that breaks the standard through the fix pass, and drops it if still broken", async () => {
    const box = await world();
    await seedTwin(box, { full: fullWith(), coding: codingWith(), projects: PROJECTS_TEXT });
    box.events.push(correction("corr-1", "full"));
    const edit = (text: string) => ({
      ...noEdits,
      bump: "minor",
      edits: [{ layer: "full", heading: "## 9. 红线", text: `## 9. 红线\n${text}` }],
    });
    const fixed = await run(box, model({ merge: edit("最近不要直接改线上。"), fix: edit("不要直接改线上。") }));
    expect(fixed.ok).toBe(true);
    expect(box.requests.map((request) => request.system)).toEqual([TWIN_MERGE_SYSTEM_PROMPT, TWIN_FIX_SYSTEM_PROMPT]);
    expect(box.requests[1]?.user).toContain("像流水账");
    expect(await textAt(box.drive, FULL)).toContain("## 9. 红线\n不要直接改线上。");

    box.requests.length = 0;
    box.events.push(correction("corr-2", "full"));
    const before = await textAt(box.drive, FULL);
    const stuck = await run(box, model({ merge: edit("今天不要直接改线上。"), fix: noEdits }));
    expect(stuck.warnings[0]).toContain("数字分身没有通过写入前检查，已跳过");
    expect(stuck.warnings[0]).toContain("像流水账");
    expect(await textAt(box.drive, FULL)).toBe(before);
  });

  it("does not hold a layer still in an older shape to the standard", async () => {
    const box = await world();
    await seedTwin(box);
    box.events.push(correction("corr-1", "coding"));
    const result = await run(box, model({ merge: codingEdit }));
    expect(result.ok).toBe(true);
    expect(box.requests.map((request) => request.system)).toEqual([TWIN_MERGE_SYSTEM_PROMPT]);
    expect(await textAt(box.drive, CODING)).toContain("交付前先跑测试。");
  });
});

describe("portrait eval", () => {
  const probe = { id: "p01", layer: "coding", situation: "用户问为什么报错", expect: "只排查不改代码" };
  const OLD_FULL = `# 数字分身 · 人格\n${VERSION_LINE}\n\n## 1. 一句话\n上上周的分身。\n`;
  const backup = (name: string, day: string) => `digital-twin/consolidate-backup/${name}-${day}.md`;

  /** Each answer prompt gets its own marks; the judge passes answers marked ✓. */
  function scripted(marks: { twin: string[]; old: string[]; generic: string[]; blank: string[] }) {
    return (request: LlmCompleteRequest): string => {
      if (request.system === TWIN_PROBES_SYSTEM_PROMPT) {
        return JSON.stringify({ probes: [{ layer: "coding", situation: "用户说先别跑", expect: "停下不执行" }] });
      }
      if (request.system === TWIN_EVAL_JUDGE_SYSTEM_PROMPT) {
        const results = request.user
          .split("\n### ")
          .slice(1)
          .map((block) => ({ id: block.split("\n")[0]?.trim() ?? "", pass: block.includes("回答：✓") }));
        return JSON.stringify({ results });
      }
      const pick =
        request.system === TWIN_EVAL_BLANK_SYSTEM_PROMPT
          ? marks.blank
          : request.user.includes(OLD_FULL)
            ? marks.old
            : request.user.includes(TWIN_EVAL_GENERIC_PERSONA)
              ? marks.generic
              : marks.twin;
      const ids = [...request.user.matchAll(/^- (p\d+)：/gmu)].map((match) => match[1] ?? "");
      return JSON.stringify({ answers: ids.map((id, index) => ({ id, answer: pick[index] ?? "✗" })) });
    };
  }

  it("puts new probes up for review and scores the reviewed ones against the held-out twin and both baselines", async () => {
    const box = await world();
    await seedTwin(box);
    const dated = { id: "p02", layer: "persona", situation: "助手准备长篇汇报进度", expect: "一句话说还没好", day: LOCAL_DAY };
    await seed(box.drive, PROBES, `${JSON.stringify(probe)}\n${JSON.stringify(dated)}\n`);
    await seed(box.drive, backup("JOHN-DIGITAL-TWIN-latest", "2026-10-12"), "太早的备份");
    await seed(box.drive, backup("JOHN-DIGITAL-TWIN-latest", "2026-10-19"), OLD_FULL);
    box.sessions = [{ sessionKey: "s1", title: "会话一", turns: ["先别跑，我还没确认"] }];
    const result = await run(
      box,
      scripted({ twin: ["✓", "✓"], old: ["✗"], generic: ["✓", "✗"], blank: ["✗", "✗"] }),
      { steps: [portraitEvalStep] },
    );
    expect(result.ok).toBe(true);
    // Each condition agrees with itself across two rounds, so no third round is needed.
    expect(box.requests.map((request) => request.system)).toEqual([
      TWIN_PROBES_SYSTEM_PROMPT,
      ...Array.from({ length: 8 }).flatMap((_, index) => [
        index === 2 || index === 3 ? TWIN_EVAL_BLANK_SYSTEM_PROMPT : TWIN_EVAL_ANSWER_SYSTEM_PROMPT,
        TWIN_EVAL_JUDGE_SYSTEM_PROMPT,
      ]),
    ]);
    expect(box.requests[0]?.user).toContain("先别跑，我还没确认");
    const [current, blank, generic, held] = [1, 5, 9, 13].map((index) => box.requests[index]?.user ?? "");
    expect(current).toContain(FULL_TEXT);
    expect(current).not.toContain(PROJECTS_TEXT);
    expect(current).not.toContain("只排查不改代码");
    expect(current).not.toContain("用户说先别跑");
    expect(blank).not.toContain("人格分身");
    expect(generic).not.toContain(FULL_TEXT);
    expect(held).toContain(OLD_FULL);
    expect(held).toContain(CODING_TEXT);
    expect(held).toContain("- p02：");
    expect(held).not.toContain("- p01：");
    expect(jsonl(await textAt(box.drive, PROBES))).toEqual([probe, dated]);
    expect(jsonl(await textAt(box.drive, PENDING_PROBES))).toEqual([
      { id: "p03", layer: "coding", situation: "用户说先别跑", expect: "停下不执行", day: LOCAL_DAY },
    ]);
    const log = await textAt(box.drive, CHANGELOG);
    expect(log).toContain(
      [
        `## 评测 · ${LOCAL_DAY}`,
        "- 全部 2 道，当前分身作答：分身 2，不读分身 0，通用人设 1；比两组对照里较好的多答对 1 道",
        "- 留出 1 道，出题前一周的分身作答：分身 0，不读分身 0，通用人设 0；和两组对照里较好的持平",
        "- 新出 1 道题，1 道等你过目后才计分",
      ].join("\n"),
    );
    expect(log).not.toContain("当前分身答错");
    expect(JSON.parse(box.cursors.get(PORTRAIT_EVAL_CURSOR) ?? "{}")).toMatchObject({ day: LOCAL_DAY, pass: 2, total: 2 });
    expect(reminders(box.events)).toEqual([
      {
        kind: "portrait_eval",
        text: "留出题上分身没有比对照答得更好；有 1 道新评测题等你过目，可在数字分身页或运行 you-brain portrait-probes 审核。答错的题：无",
      },
    ]);

    box.requests.length = 0;
    const soon = await run(box, model({}), { steps: [portraitEvalStep], day: "2026-10-29" });
    expect(soon.ok).toBe(true);
    expect(box.requests).toEqual([]);
  });

  it("marks probes every condition agrees on and shows the mark to the probe writer", async () => {
    const box = await world();
    await seedTwin(box);
    const probes = [
      { ...probe, flat: "2026-10-16" },
      { id: "p02", layer: "persona", situation: "助手准备长篇汇报进度", expect: "一句话说还没好" },
      { id: "p03", layer: "persona", situation: "助手准备抢前台焦点", expect: "静默处理" },
    ];
    await seed(box.drive, PROBES, probes.map((row) => `${JSON.stringify(row)}\n`).join(""));
    box.sessions = [{ sessionKey: "s1", title: "会话一", turns: ["先别跑，我还没确认"] }];
    const result = await run(
      box,
      scripted({
        twin: ["✓", "✓", "✗", "✓"],
        old: [],
        blank: ["✓", "✓", "✗", "✗"],
        generic: ["✗", "✓", "✗", "✗"],
      }),
      { steps: [portraitEvalStep] },
    );
    expect(result.ok).toBe(true);
    const writer = box.requests[0]?.user ?? "";
    expect(writer).toContain("- 用户问为什么报错（没有区分度）");
    expect(writer).not.toContain("助手准备长篇汇报进度（没有区分度）");
    const [, p02, p03] = probes;
    expect(jsonl(await textAt(box.drive, PROBES))).toEqual([probe, { ...p02, flat: LOCAL_DAY }, { ...p03, flat: LOCAL_DAY }]);
    expect(jsonl(await textAt(box.drive, PENDING_PROBES))).toEqual([
      { id: "p04", layer: "coding", situation: "用户说先别跑", expect: "停下不执行", day: LOCAL_DAY },
    ]);
    expect(await textAt(box.drive, CHANGELOG)).toContain("- 没有区分度 2 道：三组都答对 p02；三组都答错 p03");
  });

  it("settles a probe the first two rounds split on with a third round over that probe alone", async () => {
    const box = await world();
    await seedTwin(box);
    const steady = { id: "p02", layer: "persona", situation: "助手准备长篇汇报进度", expect: "一句话说还没好" };
    await seed(box.drive, PROBES, `${JSON.stringify(probe)}\n${JSON.stringify(steady)}\n`);
    const judge = scripted({ twin: [], old: [], generic: [], blank: [] });
    let twinRounds = 0;
    const result = await run(
      box,
      (request) => {
        if (request.system === TWIN_EVAL_JUDGE_SYSTEM_PROMPT) return judge(request);
        const twin = request.system === TWIN_EVAL_ANSWER_SYSTEM_PROMPT && request.user.includes(FULL_TEXT);
        if (twin) twinRounds += 1;
        // With the twin, p01 passes in rounds one and three and fails in round two.
        const ids = [...request.user.matchAll(/^- (p\d+)：/gmu)].map((match) => match[1] ?? "");
        const mark = (id: string) => (twin && (id === "p02" || twinRounds !== 2) ? "✓" : "✗");
        return JSON.stringify({ answers: ids.map((id) => ({ id, answer: mark(id) })) });
      },
      { steps: [portraitEvalStep] },
    );
    expect(result.ok).toBe(true);
    const twinAnswers = box.requests.filter(
      (request) => request.system === TWIN_EVAL_ANSWER_SYSTEM_PROMPT && request.user.includes(FULL_TEXT),
    );
    expect(twinAnswers).toHaveLength(3);
    expect(twinAnswers[2]?.user).toContain("- p01：");
    expect(twinAnswers[2]?.user).not.toContain("- p02：");
    expect(await textAt(box.drive, CHANGELOG)).toContain("分身 2，不读分身 0，通用人设 0");
  });

  it("moves kept probes into the scored set, drops the rest, and leaves skipped ones pending", async () => {
    const box = await world();
    const pending = ["p02", "p03", "p04"].map((id) => ({
      id,
      layer: "persona",
      situation: `情境 ${id}`,
      expect: `反应 ${id}`,
      day: LOCAL_DAY,
    }));
    await seed(box.drive, PROBES, `${JSON.stringify(probe)}\n`);
    await seed(box.drive, PENDING_PROBES, pending.map((row) => `${JSON.stringify(row)}\n`).join(""));
    const verdicts: Record<string, boolean | null> = { p02: true, p03: false, p04: null };
    const result = await reviewProbes({
      portrait: box.portrait,
      decide: async (row) => verdicts[row.id] ?? null,
    });
    expect(result).toEqual({ kept: 1, dropped: 1, left: 1 });
    expect(jsonl(await textAt(box.drive, PROBES))).toEqual([probe, pending[0]]);
    expect(jsonl(await textAt(box.drive, PENDING_PROBES))).toEqual([pending[2]]);
  });

  it("restores the twin from before a run out of the backups", async () => {
    const box = await world();
    await seedTwin(box);
    await seed(box.drive, backup("JOHN-DIGITAL-TWIN-latest", "2026-10-12"), "十月十二日之前");
    await seed(box.drive, backup("JOHN-DIGITAL-TWIN-latest", "2026-10-19"), "十月十九日之前");
    await seed(box.drive, backup("JOHN-TWIN-coding", "2026-10-15"), "编码 十月十五日之前");
    const twinBefore = box.portrait.twinBefore?.bind(box.portrait);
    expect(await twinBefore?.("2026-10-12")).toEqual({ full: "十月十二日之前", coding: "编码 十月十五日之前" });
    expect(await twinBefore?.("2026-10-16")).toEqual({ full: "十月十九日之前", coding: CODING_TEXT });
    expect(await twinBefore?.("2026-10-20")).toEqual({ full: FULL_TEXT, coding: CODING_TEXT });
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
    expect(fixRequests[0]?.user).toContain("超过 6144 字节预算，要压到 5500 字节以内");
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

  it("warns on oversized project groups and flags rules duplicated across full and coding", () => {
    const bigProject = `# 数字分身 · 项目决定\n版本 v4.5.0 · ${LOCAL_DAY} · 变更见 changelog\n\n## 超大项目 · 一\n${"甲".repeat(1_200)}\n\n## 超大项目 · 二\n${"乙".repeat(1_200)}\n\n## 超大项目 · 三\n${"丙".repeat(1_200)}\n`;
    const check = checkTwin({ full: FULL_TEXT, coding: CODING_TEXT, projects: bigProject }, new Set(["projects"]));
    expect(check.warnings.some((w) => w.includes("超大项目") && w.includes("项目总长超过"))).toBe(true);

    const dupFull = `# 数字分身 · 人格\n版本 v4.5.0 · ${LOCAL_DAY} · 变更见 changelog\n\n## 8. 合作说明\n仅在用户明确要求时执行 commit 或 push，不要自作主张提交代码。\n`;
    const dupCoding = `# 数字分身 · 编码\n版本 v4.5.0 · ${LOCAL_DAY} · 变更见 changelog\n\n## 安全与授权\n- **提交授权**：仅在用户明确要求时执行 commit 或 push，不要自作主张提交代码。\n`;
    expect(twinCrossLayerProblems(dupFull, dupCoding)[0]).toContain("full 与 coding 重复写了同一条通用规范");
  });

  it("retains unmerged high-confidence claims when finishTwin skips, and skips action=none noise in readTwinSessions", async () => {
    const box = await world();
    await seedTwin(box);
    await seed(
      box.drive,
      "inbox/dev/noise.md",
      "---\nsource: codex\nconversation_id: c-noise\nstarted_at: 2026-10-23T01:00:00.000Z\nupdated_at: 2026-10-23T01:05:00.000Z\n---\n\n## User\n\n回复 ok\n",
    );
    await seed(
      box.drive,
      "inbox/dev/older-unread.md",
      "---\nsource: codex\nconversation_id: c-unread\nstarted_at: 2026-10-20T08:00:00.000Z\nupdated_at: 2026-10-20T08:05:00.000Z\n---\n\n## User\n\n以后汇报先说结论\n",
    );
    const noiseEntry = await box.drive.findByPath("inbox/dev/noise.md");
    const unreadEntry = await box.drive.findByPath("inbox/dev/older-unread.md");
    const sessions = await readTwinSessions({
      drive: box.drive,
      timeZone: SHANGHAI,
      day: LOCAL_DAY,
      seenTurns: {},
      sessions: [
        {
          sessionKey: "noise-1",
          title: "探针",
          fileId: noiseEntry?.id ?? null,
          updatedAt: `${LOCAL_DAY}T01:05:00.000Z`,
          msgCount: 2,
          refinedUpTo: 2,
          topicId: null,
        },
        {
          sessionKey: "unread-1",
          title: "三天前未读完",
          fileId: unreadEntry?.id ?? null,
          updatedAt: "2026-10-20T08:05:00.000Z",
          msgCount: 2,
          refinedUpTo: 2,
          topicId: "topic-1",
        },
      ],
    });
    expect(sessions.map((s) => s.sessionKey)).toEqual(["unread-1"]);

    box.sessions = [{ sessionKey: "s-high", title: "新原则", turns: ["以后汇报一律先给结论"] }];
    const extracted = {
      claims: [{ layer: "persona", project: "", confidence: "high", text: "汇报时先给结论。" }],
    };
    const badMerge = {
      bump: "minor",
      changelog: ["新增结论规则"],
      edits: [{ layer: "full", heading: "## 1. 一句话", text: "## 1. 一句话\n样本数 5。" }],
    };
    const skipped = await run(box, model({ claims: extracted, merge: badMerge, fix: noEdits }));
    expect(skipped.warnings[0]).toContain("没有通过写入前检查");
    const pendingAfterSkip = jsonl(await textAt(box.drive, PENDING));
    expect(pendingAfterSkip).toEqual([
      expect.objectContaining({ layer: "persona", confidence: "high", text: "汇报时先给结论。" }),
    ]);

    // Next day with no new turns still merges the retained high-confidence claim and clears pending
    box.sessions = [];
    const cleanMerge = {
      bump: "minor",
      changelog: ["补入结论规则"],
      edits: [{ layer: "full", heading: "## 1. 一句话", text: "## 1. 一句话\n汇报时先给结论。" }],
    };
    const nextDay = await run(box, model({ merge: cleanMerge }), { day: "2026-10-24" });
    expect(nextDay.ok).toBe(true);
    expect(await textAt(box.drive, FULL)).toContain("汇报时先给结论。");
    expect(jsonl(await textAt(box.drive, PENDING))).toEqual([]);
  });
});
