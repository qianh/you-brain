import { TWIN_SKELETON, splitTwin, type TwinLayer } from "./twin.js";

/**
 * The quality standard for the two resident layers, checked in code before every write.
 *
 * It is the part of "a good twin" that a program can verify: fixed structure, a ceiling on
 * every list, one rule per line, short lines, no duplicated rules, no running-log wording, no
 * filler. Whether the content is true is the eval's job (spec §7), not this file's.
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
const CODING_LIMITS: Record<string, number> = { "## 核心原则": 10, "## 默认与红线": 3 };
/** Characters per line. A coding principle merges a whole theme, so it may run longer. */
const FULL_LINE = 110;
const CODING_LINE = 460;
const MAX_SEMICOLONS = 2;
const DUPLICATE_SIMILARITY = 0.7;

const DATE_IN_NOW = /\d{4} ?年 ?\d{1,2} ?月/u;
/** Wording of a diary entry, not of a standing rule. */
const LOG_WORDS = /近期|最近|本周|本月|今天|昨天|刚刚|上次|这次/gu;
/** Wording that adds length and no information. */
const FILLER = /至关重要|值得注意的是|总而言之|众所周知|不言而喻|非常重要|十分重要/gu;

const NOW_HEADING = "## 2. 现在在做什么";
const QUOTES_HEADING = "## 7. 说话方式";
const CODING_THEME = /^- \*\*[^*]{2,6}\*\*：/u;

/** Problems that keep this layer below the standard. Empty when it meets it. */
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
      if (line.length > maxLine) {
        problems.push(`${layer} 这一条有 ${line.length} 字，最多 ${maxLine} 字，拆成几条或删掉解释：${clip(line)}`);
      }
      if (count(line, /；/gu) > MAX_SEMICOLONS) {
        problems.push(`${layer} 用分号串了太多子句，拆成几条：${clip(line)}`);
      }
      if (layer === "coding" && !isPointer(line) && !CODING_THEME.test(line) && section.heading === "## 核心原则") {
        problems.push(`${layer} 核心原则每条要写成「- **主题**：做什么 / 不做什么」：${clip(line)}`);
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
  problems.push(...duplicates(layer, rules));
  return problems;
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

function isPointer(line: string): boolean {
  return line.startsWith("- **项目说明**：");
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
