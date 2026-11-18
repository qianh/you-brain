import type { ConsolidationPortrait } from "./steps.js";
import {
  CODING_PRINCIPLES_HEADING,
  TWIN_SKELETON,
  TWIN_TITLES,
  bumpVersion,
  byteLength,
  checkTwin,
  isProjectsPointerLine,
  joinTwin,
  splitTwin,
  twinVersion,
  withHeader,
  withProjectsPointer,
} from "./twin.js";
import { twinStandardProblems } from "./twin-standard.js";

export interface CodingRuleProposal {
  id: string;
  day: string;
  section: string;
  action: "add" | "replace";
  targetLine?: string;
  proposedLine: string;
  reason: string;
}

export type ProposalDecision =
  | { action: "approve"; editedLine?: string }
  | { action: "reject" }
  | { action: "skip" };

const NUMBERED_RULE = /^\s*\d+[.)、]\s*([^。：:]{2,20})[。：:]\s*(.+)$/u;
const BULLET_WITH_TITLE = /^\s*[-*]\s+\*\*([^*]{2,12})\*\*\s*[：:]\s*(.+)$/u;
const PLAIN_BULLET = /^\s*[-*]\s+(.+)$/u;

export function nextCodingProposalNumber(proposals: readonly CodingRuleProposal[]): number {
  let max = 0;
  for (const item of proposals) {
    const match = /^cp(\d+)$/u.exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function normalizeCodingRuleLine(raw: string): string {
  const collapsed = raw.replace(/[\r\n]+/gu, " ").trim();
  // Replace excess semicolons beyond the first with periods so each rule stays easy to scan.
  let seenSemicolon = 0;
  const tidied = collapsed.replace(/[；;]/gu, () => {
    seenSemicolon += 1;
    return seenSemicolon === 1 ? "；" : "。";
  });
  const titled = BULLET_WITH_TITLE.exec(tidied);
  if (titled) {
    return `- **${titled[1]!.trim()}**：${titled[2]!.trim()}`;
  }
  const numbered = NUMBERED_RULE.exec(tidied);
  if (numbered) {
    return `- **${shortTitle(numbered[1]!)}**：${numbered[2]!.trim()}`;
  }
  const bullet = PLAIN_BULLET.exec(tidied);
  const body = bullet ? bullet[1]!.trim() : tidied;
  return `- **${inferShortTitle(body)}**：${body}`;
}

function shortTitle(raw: string): string {
  const cleaned = raw.replace(/[*`\s]+/gu, "").trim();
  if (cleaned.length >= 2 && cleaned.length <= 12) return cleaned;
  return cleaned.slice(0, 10) || "编码规则";
}

function inferShortTitle(body: string): string {
  if (/commit|push|--no-verify|hook/iu.test(body)) {
    if (/--no-verify|hook/iu.test(body)) return "钩子纪律";
    if (/message|中文/iu.test(body)) return "提交说明";
    return "提交授权";
  }
  if (/中文|结论/.test(body) && /审查|P1/.test(body)) return "代码审查";
  if (/中文|先说结论/.test(body)) return "沟通表达";
  if (/注释|标识符/.test(body)) return "命名与注释";
  if (/完成后说明|未完成事项|未执行/.test(body)) return "交付说明";
  if (/权限约束|优先于全局/.test(body)) return "指令优先级";
  if (/中途补充|状态询问/.test(body)) return "中途变更";
  if (/文件规则.*暂停|必须确认/.test(body)) return "规则暂停说明";
  if (/子代理|独立模块/.test(body)) return "子代理边界";
  if (/同时修改同一文件|主代理负责/.test(body)) return "分工与整合";
  if (/测试|lint|typecheck|build/iu.test(body)) return "变更验证";
  if (/验证强度|回归测试/.test(body)) return "分级验证";
  if (/重复实现的测试|扩大验证/.test(body)) return "避免过度测试";
  if (/diff|工具返回成功/.test(body)) return "产物核验";
  const head = body.split(/[，。；：:]/u)[0]?.replace(/[*`\s]+/gu, "") ?? "";
  if (head.length >= 2 && head.length <= 10) return head;
  return head.slice(0, 8) || "协作规则";
}

function extractRuleTitle(line: string): string | null {
  const match = /^- \*\*([^*]+)\*\*：/u.exec(line.trim());
  return match?.[1]?.trim() ?? null;
}

/** Apply one approved coding rule proposal into `coding.md` text. */
export function applyCodingProposal(
  codingText: string,
  proposal: CodingRuleProposal,
  editedLine?: string,
): string {
  const normalized = normalizeCodingRuleLine(editedLine ?? proposal.proposedLine);
  const validHeadings = new Set<string>(TWIN_SKELETON.coding);
  const targetSection = validHeadings.has(proposal.section.trim())
    ? proposal.section.trim()
    : CODING_PRINCIPLES_HEADING;

  const doc = splitTwin(codingText);
  let sectionIndex = doc.sections.findIndex((item) => item.heading === targetSection);
  if (sectionIndex < 0) {
    doc.sections.push({ heading: targetSection, text: targetSection });
    sectionIndex = doc.sections.length - 1;
  }

  const section = doc.sections[sectionIndex]!;
  const lines = section.text.split("\n");
  const headingLine = lines[0] ?? targetSection;
  const body = lines.slice(1).filter((line) => line.trim() !== "");

  const newTitle = extractRuleTitle(normalized);
  const targetTrimmed = proposal.targetLine?.trim() ?? "";
  const targetTitle = targetTrimmed ? extractRuleTitle(targetTrimmed) : null;

  let replaced = false;
  if (proposal.action === "replace" && targetTrimmed !== "") {
    for (let idx = 0; idx < body.length; idx += 1) {
      const candidate = body[idx]!.trim();
      if (isProjectsPointerLine(candidate)) continue;
      if (
        candidate === targetTrimmed ||
        (targetTitle !== null && extractRuleTitle(candidate) === targetTitle)
      ) {
        body[idx] = normalized;
        replaced = true;
        break;
      }
    }
  }
  if (!replaced) {
    const existingIdx =
      newTitle !== null
        ? body.findIndex((line) => !isProjectsPointerLine(line) && extractRuleTitle(line) === newTitle)
        : body.findIndex((line) => line.trim() === normalized);
    if (existingIdx >= 0) body[existingIdx] = normalized;
    else body.push(normalized);
  }

  doc.sections[sectionIndex] = {
    heading: headingLine,
    text: [headingLine, ...body].join("\n"),
  };
  return withProjectsPointer(joinTwin(doc));
}

/**
 * Review pending coding proposals interactively or via HTTP action.
 * Approved proposals are merged into `coding.md`, validated, and saved on Drive.
 */
export async function reviewCodingProposals(input: {
  portrait: ConsolidationPortrait;
  day: string;
  decide: (proposal: CodingRuleProposal) => Promise<ProposalDecision>;
}): Promise<{ approved: number; rejected: number; left: number; version: string | null }> {
  if (!input.portrait.codingProposals || !input.portrait.saveCodingProposals) {
    return { approved: 0, rejected: 0, left: 0, version: null };
  }
  const pending = await input.portrait.codingProposals();
  if (pending.length === 0) {
    return { approved: 0, rejected: 0, left: 0, version: null };
  }
  const files = await input.portrait.read();
  if (!files.coding) {
    throw new Error("Drive 上没有编码分身，请先初始化");
  }

  let coding = files.coding.text;
  const changelog: string[] = [];
  const left: CodingRuleProposal[] = [];
  let approved = 0;
  let rejected = 0;

  for (const proposal of pending) {
    const verdict = await input.decide(proposal);
    if (verdict.action === "approve") {
      coding = applyCodingProposal(coding, proposal, verdict.editedLine);
      approved += 1;
      const title = extractRuleTitle(normalizeCodingRuleLine(verdict.editedLine ?? proposal.proposedLine)) ?? proposal.id;
      changelog.push(`coding · ${proposal.section.replace(/^##\s+/u, "")}：确认合入「${title}」`);
    } else if (verdict.action === "reject") {
      rejected += 1;
    } else {
      left.push(proposal);
    }
  }

  let savedVersion: string | null = null;
  if (approved > 0) {
    const texts = {
      full: files.full?.text ?? "",
      coding,
      projects: files.projects?.text ?? "",
    };
    const check = checkTwin(texts, new Set(["coding"]));
    if (twinStandardProblems("coding", files.coding.text).length === 0) {
      check.blocking.push(...twinStandardProblems("coding", coding));
    }
    if (check.blocking.length > 0) {
      throw new Error(`编码分身未通过质量检查：${check.blocking.join("；")}`);
    }
    if (check.scanHits.length > 0) {
      throw new Error(`编码分身包含疑似敏感信息：${check.scanHits.join("、")}`);
    }
    const version = bumpVersion(twinVersion({ full: texts.full, coding: files.coding.text, projects: texts.projects }), "minor");
    const entry = [
      `## v${version} · ${input.day}`,
      ...changelog.map((line) => `- ${line}`),
      `- 体积：full ${byteLength(texts.full)} 字节，coding ${byteLength(coding)} 字节，projects 最大小节 ${check.sizes.maxSection} 字节`,
    ].join("\n");
    await input.portrait.save({
      day: input.day,
      version,
      files: [
        {
          layer: "coding",
          text: withHeader("coding", coding, version, input.day),
          previous: files.coding,
        },
      ],
      changelog: entry,
    });
    savedVersion = version;
  }

  if (approved + rejected > 0) {
    await input.portrait.saveCodingProposals(left);
  }
  return { approved, rejected, left: left.length, version: savedVersion };
}

/**
 * Convert a hand-crafted `AGENTS.md` / `CLAUDE.md` file into the canonical 4-section `coding.md`
 * baseline, stripping machine-specific blocks (`CODEGRAPH`, `you-brain` managed blocks, `rtk`/env).
 */
export function seedCodingFromMarkdown(sourceMarkdown: string, version: string, day: string): string {
  const stripped = sourceMarkdown
    .replace(/<!--\s*CODEGRAPH_START\s*-->[\s\S]*?<!--\s*CODEGRAPH_END\s*-->/gu, "")
    .replace(/<!--\s*you-brain:start[\s\S]*?<!--\s*you-brain:end\s*-->/gu, "");

  // If the file already uses the 4 canonical sections, normalize its bullets directly.
  const existing = splitTwin(stripped);
  const canonicalHeadings = TWIN_SKELETON.coding;
  if (existing.sections.map((s) => s.heading).join("\n") === canonicalHeadings.join("\n")) {
    const normalizedSections = existing.sections.map((sec) => {
      const items = sec.text
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !isProjectsPointerLine(line))
        .map(normalizeCodingRuleLine);
      return { heading: sec.heading, text: [sec.heading, ...items].join("\n") };
    });
    const built = withHeader(
      "coding",
      withProjectsPointer(joinTwin({ head: TWIN_TITLES.coding, sections: normalizedSections })),
      version,
      day,
    );
    return built;
  }

  const buckets: Record<string, string[]> = {
    "## 行为与范围": [],
    "## 安全与授权": [],
    "## 验证与交付": [],
    "## 并行与指令优先级": [],
  };

  let currentHeading = "";
  for (const rawLine of stripped.replace(/\r\n/gu, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      currentHeading = line.replace(/^##\s+/u, "").trim();
      continue;
    }
    // Skip machine-local tool / shell proxy sections such as RTK or local paths.
    if (/^(环境|本机工具|Local Tools|Environment)$/iu.test(currentHeading)) continue;
    if (/\brtk\b|\/Users\/|\/home\//iu.test(line)) continue;
    if (isProjectsPointerLine(line)) continue;
    if (!/^(?:\d+[.)、]|[-*])\s+/u.test(line)) continue;

    const normalized = clampRuleLength(normalizeCodingRuleLine(line), 175);
    const bucket = routeSeedRule(currentHeading, normalized);
    buckets[bucket]!.push(normalized);
  }

  // Merge short related bullets if a bucket exceeds its section cap (total <= 25 + 1 pointer = 26).
  buckets["## 验证与交付"] = compactBucket(buckets["## 验证与交付"]!, 7);
  buckets["## 行为与范围"] = compactBucket(buckets["## 行为与范围"]!, 8);
  buckets["## 安全与授权"] = compactBucket(buckets["## 安全与授权"]!, 6);
  buckets["## 并行与指令优先级"] = compactBucket(buckets["## 并行与指令优先级"]!, 6);
  while (
    Object.values(buckets).reduce((sum, list) => sum + list.length, 0) > 25
  ) {
    const largest = canonicalHeadings
      .filter((h) => (buckets[h]?.length ?? 0) >= 2)
      .sort((a, b) => (buckets[b]?.length ?? 0) - (buckets[a]?.length ?? 0))[0];
    if (!largest) break;
    buckets[largest] = compactBucket(buckets[largest]!, buckets[largest]!.length - 1);
  }

  const sections = canonicalHeadings.map((heading) => {
    const lines = buckets[heading] ?? [];
    return {
      heading,
      text: [heading, ...lines].join("\n"),
    };
  });

  return withHeader(
    "coding",
    withProjectsPointer(joinTwin({ head: TWIN_TITLES.coding, sections })),
    version,
    day,
  );
}

function routeSeedRule(sectionHeading: string, normalizedLine: string): string {
  if (/安全|授权|Git/iu.test(sectionHeading)) return "## 安全与授权";
  if (/并行|指令|上下文/iu.test(sectionHeading)) return "## 并行与指令优先级";
  if (/验证|完成|沟通|交付/iu.test(sectionHeading)) return "## 验证与交付";
  // Route numbered rules from general `行为准则` into their exact functional section.
  if (/危险操作|敏感信息|新依赖|密钥|\.env/iu.test(normalizedLine)) return "## 安全与授权";
  if (/跨层外推|测试|验证/iu.test(normalizedLine) && /跨层/.test(normalizedLine)) return "## 验证与交付";
  return "## 行为与范围";
}

function clampRuleLength(line: string, maxChars: number): string {
  const chars = Array.from(line);
  if (chars.length <= maxChars) return line;
  return `${chars.slice(0, maxChars - 1).join("")}。`;
}

function compactBucket(lines: readonly string[], limit: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const title = extractRuleTitle(line) ?? line;
    if (seen.has(title)) continue;
    seen.add(title);
    deduped.push(line);
  }
  if (deduped.length <= limit) return deduped;
  // Combine the shortest adjacent pair when over cap so substantive rules never truncate.
  const copy = [...deduped];
  while (copy.length > limit && copy.length >= 2) {
    let bestIdx = copy.length - 2;
    let bestLen = Infinity;
    for (let idx = 0; idx + 1 < copy.length; idx += 1) {
      const combinedLen = copy[idx]!.length + copy[idx + 1]!.length;
      if (combinedLen < bestLen) {
        bestLen = combinedLen;
        bestIdx = idx;
      }
    }
    const prev = copy[bestIdx]!;
    const last = copy[bestIdx + 1]!;
    const prevBody = prev.replace(/^- \*\*[^*]+\*\*：/u, "");
    const lastBody = last.replace(/^- \*\*[^*]+\*\*：/u, "");
    const title = extractRuleTitle(prev) ?? "交付要求";
    const combined = clampRuleLength(
      normalizeCodingRuleLine(`- **${title}**：${prevBody.replace(/。$/u, "")}；${lastBody}`),
      175,
    );
    copy.splice(bestIdx, 2, combined);
  }
  return copy;
}
