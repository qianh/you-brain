import { TWIN_SKELETON, isProjectsPointerLine, splitTwin, type TwinLayer } from "./twin.js";

/**
 * The quality standard for the two resident layers, checked in code before every write.
 *
 * It is the part of "a good twin" that a program can verify: fixed structure, a ceiling on
 * every list, one rule per line, short lines, no duplicated rules, no running-log wording, no
 * filler, and no project/company-specific jargon leaking into global coding rules.
 */

/** Rules per section, counted as non-empty lines. Quote samples are counted separately. */
const FULL_LIMITS: Record<string, number> = {
  "## 2. 现在在做什么": 6,
  "## 3. 价值排序": 5,
  "## 4. 行为签名": 12,
  "## 5. 判断力地图": 6,
  "## 6. 情绪与信任": 5,
  "## 8. 合作说明": 16,
  "## 9. 红线": 10,
  "## 10. 世界观与品味": 10,
  "## 11. 生活": 8,
};
const QUOTE_LIMIT = 10;
const CODING_LIMITS: Record<string, number> = {
  "## 行为与范围": 9,
  "## 安全与授权": 6,
  "## 验证与交付": 7,
  "## 并行与指令优先级": 6,
};
const CODING_TOTAL_LIMIT = 26;
/** Characters per line. One rule states one behavior boundary clearly, not a paragraph dump. */
const FULL_LINE = 110;
const CODING_LINE = 180;
const FULL_MAX_SEMICOLONS = 2;
const CODING_MAX_SEMICOLONS = 1;
const DUPLICATE_SIMILARITY = 0.7;
const CROSS_LAYER_SIMILARITY = 0.55;

const DATE_IN_NOW = /\d{4} ?年 ?\d{1,2} ?月/u;
/** Wording of a diary entry, not of a standing rule. */
const LOG_WORDS = /近期|最近|本周|本月|今天|昨天|刚刚|上次|这次/gu;
/** Wording that adds length and no information. */
const FILLER = /至关重要|值得注意的是|总而言之|众所周知|不言而喻|非常重要|十分重要/gu;
/** Company infra or project-internal terms that never belong in universal coding principles. */
const CODING_PROJECT_LEAKS =
  /\b(Apollo|XXL-JOB|RAGFlow|Langfuse|WorkBuddy|Taro)\b|宜搭|飞驼|船视宝|(?<![A-Za-z0-9])H[12](?![A-Za-z0-9])/gu;
/** Single-product UI fallback copy that belongs in `projects`, not persona red lines. */
const FULL_REDLINE_UI_LEAKS = /「(分析失败|上一次结果|待补录)」/gu;

const NOW_HEADING = "## 2. 现在在做什么";
const QUOTES_HEADING = "## 7. 说话方式";
const REDLINES_HEADING = "## 9. 红线";
const CODING_THEME = /^- \*\*[^*]{2,12}\*\*：/u;

/** Problems that keep this layer below the standard. Empty when it meets it. */
/** Rules in coding and how many the whole layer or one section may hold. */
export function codingCapacity(
  text: string,
  section: string,
): { total: number; totalLimit: number; inSection: number; sectionLimit: number | null } {
  const sections = splitTwin(text).sections;
  const total = sections.reduce((sum, item) => sum + bodyLines(item.text).length, 0);
  const target = sections.find((item) => item.heading === section);
  return {
    total,
    totalLimit: CODING_TOTAL_LIMIT,
    inSection: target ? bodyLines(target.text).length : 0,
    sectionLimit: CODING_LIMITS[section] ?? null,
  };
}

export function twinStandardProblems(layer: TwinLayer, text: string): string[] {
  if (layer === "projects") return [];
  const doc = splitTwin(text);
  const problems: string[] = [];
  const expected = TWIN_SKELETON[layer];
  const found = doc.sections.map((section) => section.heading);
  if (found.join("\n") !== expected.join("\n")) {
    problems.push(`${layer} 的小节要固定为：${expected.join(" / ")}；现在是：${found.join(" / ") || "无"}`);
    return problems;
  }

  const limits = layer === "full" ? FULL_LIMITS : CODING_LIMITS;
  const maxLine = layer === "full" ? FULL_LINE : CODING_LINE;
  const maxSemicolons = layer === "full" ? FULL_MAX_SEMICOLONS : CODING_MAX_SEMICOLONS;
  const rules: string[] = [];
  for (const section of doc.sections) {
    const lines = bodyLines(section.text);
    const quotes = lines.filter(isQuote);
    const counted = section.heading === QUOTES_HEADING ? [] : lines;
    const limit = limits[section.heading];
    if (limit !== undefined && counted.length > limit) {
      problems.push(`${layer} ${section.heading} 有 ${counted.length} 条，最多 ${limit} 条，合并同类或删掉最次要的`);
    }
    if (quotes.length > QUOTE_LIMIT) {
      problems.push(`${layer} ${section.heading} 有 ${quotes.length} 条原话，最多 ${QUOTE_LIMIT} 条，留最能看出他怎么判断的`);
    }
    for (const line of lines) {
      if (isQuote(line)) continue;
      rules.push(line);
      if (!isProjectsPointerLine(line) && line.length > maxLine) {
        problems.push(`${layer} 这一条有 ${line.length} 字，最多 ${maxLine} 字，拆成单条规则或删掉解释：${clip(line)}`);
      }
      if (!isProjectsPointerLine(line) && count(line, /；/gu) > maxSemicolons) {
        problems.push(`${layer} 用分号串了太多子句，保持一条一事：${clip(line)}`);
      }
      if (layer === "coding" && !isProjectsPointerLine(line) && !CODING_THEME.test(line)) {
        problems.push(`${layer} 每条规则要写成「- **短标题**：触发条件与具体动作」：${clip(line)}`);
      }
      if (layer === "coding" && !isProjectsPointerLine(line)) {
        const leaks = [...line.matchAll(CODING_PROJECT_LEAKS)].map((match) => match[0]);
        if (leaks.length > 0) {
          problems.push(
            `${layer} 混入了特定项目或基建专名「${[...new Set(leaks)].join("、")}」，下放 projects 或删除：${clip(line)}`,
          );
        }
      }
      if (layer === "full" && section.heading === REDLINES_HEADING) {
        const uiLeaks = [...line.matchAll(FULL_REDLINE_UI_LEAKS)].map((match) => match[0]);
        if (uiLeaks.length > 0) {
          problems.push(`${layer} 红线混入了具体产品文案口径 ${[...new Set(uiLeaks)].join("、")}，应移入 projects`);
        }
      }
      const hits = [...line.matchAll(FILLER)].map((match) => match[0]);
      if (hits.length > 0) problems.push(`${layer} 删掉空话「${[...new Set(hits)].join("、")}」：${clip(line)}`);
      if (section.heading !== NOW_HEADING) {
        const log = [...line.matchAll(LOG_WORDS)].map((match) => match[0]);
        if (log.length > 0) {
          problems.push(`${layer} 像流水账，规则里不写「${[...new Set(log)].join("、")}」这类时间词，改成长期成立的写法：${clip(line)}`);
        }
      }
    }
    if (layer === "full" && section.heading === NOW_HEADING && lines.length > 0 && !DATE_IN_NOW.test(section.text)) {
      problems.push("full 「现在在做什么」要写明年月，例如「以下是 2026 年 11 月的状态」");
    }
  }
  if (layer === "coding" && rules.length > CODING_TOTAL_LIMIT) {
    problems.push(`coding 共有 ${rules.length} 条规则，最多 ${CODING_TOTAL_LIMIT} 条，合并高度重叠项`);
  }
  problems.push(...duplicates(layer, rules));
  return problems;
}

/**
 * Rules repeated across `full` and `coding`. Universal engineering rules already in `coding`
 * should stay in `coding` instead of occupying `full` again.
 */
export function twinCrossLayerProblems(fullText: string, codingText: string): string[] {
  if (fullText.trim() === "" || codingText.trim() === "") return [];
  const fullRules = splitTwin(fullText)
    .sections.filter((sec) => sec.heading !== QUOTES_HEADING)
    .flatMap((sec) => bodyLines(sec.text))
    .filter((line) => !isQuote(line));
  const codingRules = splitTwin(codingText)
    .sections.flatMap((sec) => bodyLines(sec.text))
    .filter((line) => !isProjectsPointerLine(line));
  if (fullRules.length === 0 || codingRules.length === 0) return [];

  const fullGrams = fullRules.map((line) => bigrams(stripRuleLead(line)));
  const codingGrams = codingRules.map((line) => bigrams(stripRuleLead(line)));
  const problems: string[] = [];
  for (let i = 0; i < fullRules.length; i += 1) {
    const a = fullGrams[i];
    if (!a || a.size < 8) continue;
    for (let j = 0; j < codingRules.length; j += 1) {
      const b = codingGrams[j];
      if (!b || b.size < 8) continue;
      let shared = 0;
      for (const gram of a) if (b.has(gram)) shared += 1;
      if (shared / (a.size + b.size - shared) >= CROSS_LAYER_SIMILARITY) {
        problems.push(
          `full 与 coding 重复写了同一条通用规范（保留在 coding，从 full 删除或只留非编码差异）：${clip(fullRules[i] ?? "")} / ${clip(codingRules[j] ?? "")}`,
        );
        break;
      }
    }
  }
  return problems;
}

function stripRuleLead(line: string): string {
  return line
    .replace(/^- \*\*[^*]+\*\*：/u, "")
    .replace(/^\d+\.\s+/u, "")
    .trim();
}

function bodyLines(sectionText: string): string[] {
  return sectionText
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function isQuote(line: string): boolean {
  return line.startsWith("「");
}

function count(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function clip(line: string): string {
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

/** Two lines that say nearly the same thing: character bigrams overlap past the threshold. */
function duplicates(layer: TwinLayer, rules: readonly string[]): string[] {
  const grams = rules.map((rule) => bigrams(rule));
  const problems: string[] = [];
  for (let left = 0; left < rules.length; left += 1) {
    for (let right = left + 1; right < rules.length; right += 1) {
      const a = grams[left];
      const b = grams[right];
      if (!a || !b || a.size < 8 || b.size < 8) continue;
      let shared = 0;
      for (const gram of a) if (b.has(gram)) shared += 1;
      if (shared / (a.size + b.size - shared) >= DUPLICATE_SIMILARITY) {
        problems.push(`${layer} 这两条说的是同一件事，合并成一条：${clip(rules[left] ?? "")} / ${clip(rules[right] ?? "")}`);
      }
    }
  }
  return problems;
}

function bigrams(value: string): Set<string> {
  const text = value.replace(/[\s，。；：、「」（）()\-*\d.]/gu, "");
  const result = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) result.add(text.slice(index, index + 2));
  return result;
}
