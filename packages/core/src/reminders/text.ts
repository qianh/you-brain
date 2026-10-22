const LINE = 80;
const TOTAL = 200;

export function textLength(value: string): number {
  return Array.from(value).length;
}

export function clipText(value: string, max: number): string {
  const chars = Array.from(value.replace(/[\r\n]+/gu, " ").trim());
  if (chars.length <= max) return chars.join("");
  if (max <= 1) return "…";
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** Keep every line within 80 characters and the whole note within 200. */
export function boundReminder(lines: readonly string[]): string {
  const clipped = lines.map((line) => clipText(line, LINE)).filter((line) => line.length > 0);
  const kept: string[] = [];
  let used = 0;
  for (const line of clipped) {
    const length = textLength(line);
    const next = kept.length === 0 ? length : used + 1 + length;
    if (kept.length > 0 && next > TOTAL) break;
    kept.push(length > TOTAL ? clipText(line, TOTAL) : line);
    used = kept.length === 1 ? textLength(kept[0] ?? "") : next;
  }
  return kept.join("\n");
}

export function staleText(name: string, openTodos: number): string {
  return boundReminder([
    `「${clipText(displayName(name), 24)}」已 7 天没有新进展，还有 ${openTodos} 件待办未完成。`,
  ]);
}

export function historyText(name: string, openTodos: number): string {
  return boundReminder([
    `「${clipText(displayName(name), 24)}」还有 ${openTodos} 件待办未完成，本周可以看一下。`,
  ]);
}

export function digestText(input: {
  conclusions: readonly string[];
  openTodoCount: number;
  suggestions: readonly string[];
}): string {
  const first = input.conclusions[0];
  const conclusionLine =
    input.conclusions.length === 0 || first === undefined
      ? "昨日没有新结论。"
      : input.conclusions.length === 1
        ? `昨日结论：${clipText(first, 36)}`
        : `昨日结论 ${input.conclusions.length} 条：${clipText(first, 28)}`;
  const todoLine =
    input.openTodoCount === 0
      ? "没有未完成的待办。"
      : `未完成待办 ${input.openTodoCount} 件。`;
  const suggestLine =
    input.suggestions.length === 0
      ? "今天没有特别建议跟进的话题。"
      : `建议跟进：${input.suggestions.map((name) => clipText(name, 12)).join("、")}。`;
  return boundReminder([conclusionLine, todoLine, suggestLine]);
}

export function weeklyText(input: {
  activeCount: number;
  conclusionCount: number;
  staleNames: readonly string[];
  historyNames: readonly string[];
}): string {
  return boundReminder([
    `本周活跃话题 ${input.activeCount} 个。`,
    `新增结论 ${input.conclusionCount} 条。`,
    `停滞话题：${nameList(input.staleNames)}。`,
    `历史未完成：${nameList(input.historyNames)}。`,
    "相似话题：合并建议稍后给出。",
  ]);
}

function nameList(names: readonly string[]): string {
  if (names.length === 0) return "无";
  return names.map((name) => clipText(displayName(name), 12)).join("、");
}

function displayName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length === 0 ? "未命名话题" : trimmed;
}
