/** The three twin layers. Each rule lives in exactly one of them. */
export const TWIN_LAYERS = ["full", "coding", "projects"] as const;
export type TwinLayer = (typeof TWIN_LAYERS)[number];

/** The coding layer is injected into every CLI session as AGENTS.md / CLAUDE.md, so it stays far smaller than `full`. */
export const TWIN_BUDGET = { full: 12_288, coding: 4_096, section: 4_096 } as const;

/** Where CLIs find the project decisions. Stays a home-relative path so the scan never trips on it. */
export const PROJECTS_LOCAL_PATH = "~/.you-brain/portrait/projects.md";
/** The one coding principle the program owns: it points at the projects file instead of listing projects. */
export const PROJECTS_POINTER_LABEL = "- **项目说明**：";
export const PROJECTS_POINTER = `${PROJECTS_POINTER_LABEL}在已有的具体项目里工作时，先读 [项目说明](${PROJECTS_LOCAL_PATH}) 里该项目的小节；新项目和简单对话不需要读。`;
export const CODING_PRINCIPLES_HEADING = "## 核心原则";
/** The head line older coding layers carried: a list of project names. Dropped when found. */
const LEGACY_INDEX_PREFIX = "在下列项目里工作时";
const ANY_VERSION = /v(\d+)\.(\d+)\.(\d+)/u;

export const TWIN_TITLES: Record<TwinLayer, string> = {
  full: "# 数字分身 · 人格",
  coding: "# 数字分身 · 编码",
  projects: "# 数字分身 · 项目决定",
};

/** Section skeletons used when a layer is built from nothing. */
export const TWIN_SKELETON: Record<TwinLayer, readonly string[]> = {
  full: [
    "## 1. 一句话",
    "## 2. 身份",
    "## 3. 价值排序",
    "## 4. 思维方式",
    "## 5. 说话方式",
    "## 6. 像他与不像他",
    "## 7. 对助手的期待",
    "## 8. 绝对不做",
    "## 9. 品味",
    "## 10. 世界观",
    "## 11. 生活",
  ],
  coding: [CODING_PRINCIPLES_HEADING, "## 默认与红线"],
  projects: [],
};

const LINT = /待确认|不升格|两条都有效|证据 ?ID|样本数/gu;

export const TWIN_SCAN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: "密钥",
    pattern:
      /((api[_-]?key|secret|token|passw\w*)\s*[:=]\s*\S{8,}|sk-[A-Za-z0-9]{16,}|ghp_|xox[bp]-|BEGIN [A-Z ]*PRIVATE)/giu,
  },
  { name: "手机号", pattern: /\+?86[- ]?1[3-9]\d{9}|\b1[3-9]\d{9}\b/gu },
  { name: "邮箱", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gu },
  { name: "IP", pattern: /\b\d{1,3}(\.\d{1,3}){3}\b/gu },
  { name: "本机路径", pattern: /\/(Users|home)\/[A-Za-z]/gu },
];

export interface TwinSection {
  heading: string;
  text: string;
}

export interface TwinDocument {
  /** Lines before the first `## ` heading, without the trailing newline. */
  head: string;
  sections: TwinSection[];
}

export type TwinTexts = Record<TwinLayer, string>;

export interface TwinEdit {
  layer: TwinLayer;
  /** Existing `## ` heading line to replace or delete. A heading not in the file adds a section. */
  heading: string;
  /** New section text starting with its `## ` line. Empty deletes the section. */
  text: string;
}

export function splitTwin(text: string): TwinDocument {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const head: string[] = [];
  const sections: TwinSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) sections.push(closeSection(current));
      current = { heading: line.trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      head.push(line);
    }
  }
  if (current) sections.push(closeSection(current));
  return { head: trimEndLines(head.join("\n")), sections };
}

export function joinTwin(doc: TwinDocument): string {
  const parts = [doc.head, ...doc.sections.map((section) => section.text)].filter(
    (part) => part.trim() !== "",
  );
  return `${parts.join("\n\n")}\n`;
}

function closeSection(current: { heading: string; lines: string[] }): TwinSection {
  return { heading: current.heading, text: trimEndLines(current.lines.join("\n")) };
}

function trimEndLines(value: string): string {
  return value.replace(/\s+$/u, "");
}

/** Apply section edits in order. Unknown headings append; empty text deletes. */
export function applyTwinEdits(texts: TwinTexts, edits: readonly TwinEdit[]): TwinTexts {
  const docs = {
    full: splitTwin(texts.full),
    coding: splitTwin(texts.coding),
    projects: splitTwin(texts.projects),
  };
  for (const edit of edits) {
    const doc = docs[edit.layer];
    const target = edit.heading.trim();
    const index = doc.sections.findIndex((section) => section.heading === target);
    const text = normalizeSection(edit.text, target);
    if (text === null) {
      if (index >= 0) doc.sections.splice(index, 1);
      continue;
    }
    const next = { heading: firstLine(text), text };
    if (index >= 0) doc.sections[index] = next;
    else doc.sections.push(next);
    doc.sections = doc.sections.filter((section) => section === next || section.heading !== next.heading);
  }
  return {
    full: joinTwin(docs.full),
    coding: joinTwin(docs.coding),
    projects: joinTwin(docs.projects),
  };
}

function normalizeSection(raw: string, heading: string): string | null {
  const text = trimEndLines(raw.replace(/\r\n/gu, "\n")).replace(/^\s*\n/u, "");
  if (text.trim() === "") return null;
  if (text.startsWith("## ")) return text;
  const fallback = heading.startsWith("## ") ? heading : `## ${heading}`;
  return `${fallback}\n${text}`;
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

/** Body that change detection compares: line 2 (the version line) dropped. */
export function twinBody(text: string): string {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  lines.splice(1, 1);
  return lines.join("\n").replace(/\s+$/u, "");
}

export type VersionBump = "patch" | "minor" | "major";

export function twinVersion(texts: Partial<TwinTexts>): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0];
  for (const text of Object.values(texts)) {
    if (text === undefined) continue;
    const second = text.split("\n")[1] ?? "";
    const match = ANY_VERSION.exec(second);
    if (!match) continue;
    const version: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (compareVersion(version, best) > 0) best = version;
  }
  return best;
}

export function bumpVersion(version: [number, number, number], bump: VersionBump): string {
  const [major, minor, patch] = version;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Fix lines 1 and 2: keep an existing `# ` title, write the shared version line.
 * Anything else the head carried after line 2 stays.
 */
export function withHeader(layer: TwinLayer, text: string, version: string, day: string): string {
  const doc = splitTwin(text);
  const head = splitHead(doc.head);
  const lines = [head.title ?? TWIN_TITLES[layer], `版本 v${version} · ${day} · 变更见 changelog`];
  if (head.rest.length > 0) lines.push("", ...head.rest);
  return joinTwin({ head: lines.join("\n"), sections: doc.sections });
}

function splitHead(head: string): { title: string | null; version: string | null; rest: string[] } {
  let lines = head === "" ? [] : head.split("\n");
  const title = lines[0]?.startsWith("# ") ? lines[0] : null;
  if (title !== null) lines = lines.slice(1);
  const version = lines[0] !== undefined && ANY_VERSION.test(lines[0]) ? lines[0] : null;
  if (version !== null) lines = lines.slice(1);
  while (lines[0]?.trim() === "") lines = lines.slice(1);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines = lines.slice(0, -1);
  return { title, version, rest: lines };
}

/**
 * Make sure the first principle under "核心原则" is the pointer to the projects file.
 * Replaces an older copy, drops the legacy project-name index from the head, and
 * creates the section when the coding layer has none.
 */
export function withProjectsPointer(coding: string): string {
  const doc = splitTwin(coding);
  const head = splitHead(doc.head);
  const rest = head.rest.filter((line) => !line.startsWith(LEGACY_INDEX_PREFIX));
  const lines = [head.title ?? TWIN_TITLES.coding];
  if (head.version !== null) lines.push(head.version);
  if (rest.length > 0) lines.push("", ...rest);
  const sections = doc.sections.map((section) => ({
    heading: section.heading,
    text: section.text
      .split("\n")
      .filter((line) => !line.startsWith(PROJECTS_POINTER_LABEL))
      .join("\n"),
  }));
  const index = sections.findIndex((section) => section.heading === CODING_PRINCIPLES_HEADING);
  if (index < 0) {
    sections.unshift({
      heading: CODING_PRINCIPLES_HEADING,
      text: `${CODING_PRINCIPLES_HEADING}\n${PROJECTS_POINTER}`,
    });
  } else {
    const [heading = CODING_PRINCIPLES_HEADING, ...body] = (sections[index]?.text ?? "").split("\n");
    sections[index] = { heading: CODING_PRINCIPLES_HEADING, text: [heading, PROJECTS_POINTER, ...body].join("\n") };
  }
  return joinTwin({ head: lines.join("\n"), sections });
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface TwinCheck {
  /** Problems that block writing. */
  blocking: string[];
  /** Problems worth one fix pass that do not block writing. */
  warnings: string[];
  /** Sensitive-data hits. Any hit drops the whole run. */
  scanHits: string[];
  sizes: { full: number; coding: number; maxSection: number };
}

/** Asks for 90% of the budget so the next merge has room. */
function overBudget(layer: TwinLayer, size: number, budget: number): string {
  const target = Math.floor((budget * 0.9) / 100) * 100;
  return `${layer} 为 ${size} 字节，超过 ${budget} 字节预算，要压到 ${target} 字节以内`;
}

export function checkTwin(texts: TwinTexts, changed: ReadonlySet<TwinLayer>): TwinCheck {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const full = byteLength(texts.full);
  const coding = byteLength(texts.coding);
  if (full >= TWIN_BUDGET.full) blocking.push(overBudget("full", full, TWIN_BUDGET.full));
  if (coding >= TWIN_BUDGET.coding) blocking.push(overBudget("coding", coding, TWIN_BUDGET.coding));
  for (const layer of TWIN_LAYERS) {
    const hits = [...texts[layer].matchAll(LINT)].map((match) => match[0]);
    if (hits.length > 0) blocking.push(`${layer} 出现禁用的记账措辞：${[...new Set(hits)].join("、")}`);
  }
  let maxSection = 0;
  const oversized: string[] = [];
  for (const section of splitTwin(texts.projects).sections) {
    const size = byteLength(section.text);
    maxSection = Math.max(maxSection, size);
    if (size >= TWIN_BUDGET.section) oversized.push(`${section.heading}（${size} 字节）`);
  }
  if (changed.has("projects") && oversized.length > 0) {
    warnings.push(
      `projects 这些小节超过 ${TWIN_BUDGET.section} 字节：${oversized.join("、")}。只合并同义表述、按子主题拆成新的 ## 小节，不删仍成立的规则`,
    );
  }
  const scanHits: string[] = [];
  for (const layer of TWIN_LAYERS) {
    for (const rule of TWIN_SCAN) {
      if (new RegExp(rule.pattern.source, rule.pattern.flags).test(texts[layer])) {
        scanHits.push(`${layer}：${rule.name}`);
      }
    }
  }
  return { blocking, warnings, scanHits, sizes: { full, coding, maxSection } };
}

/** Layers whose body differs, ignoring the version line. */
export function changedLayers(before: TwinTexts, after: TwinTexts): Set<TwinLayer> {
  const changed = new Set<TwinLayer>();
  for (const layer of TWIN_LAYERS) {
    if (twinBody(before[layer]) !== twinBody(after[layer])) changed.add(layer);
  }
  return changed;
}

/** A fresh layer: title, a placeholder version line, and the skeleton headings. */
export function skeletonTwin(layer: TwinLayer): string {
  return joinTwin({
    head: `${TWIN_TITLES[layer]}\n版本 v0.0.0 · - · 变更见 changelog`,
    sections: TWIN_SKELETON[layer].map((heading) => ({ heading, text: heading })),
  });
}
