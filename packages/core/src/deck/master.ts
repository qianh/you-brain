import type { LlmBackend } from "../llm/types.js";
import { DECISION_JSON_SCHEMA, parseDecision, type DeckDecision } from "./decision.js";
import { deckSkillText } from "./skill-text.js";
import type { DeckTurn } from "./types.js";

const HISTORY_TURNS = 12;
const SECTION_CAP = 4_000;

/** 主控的执行者目录文本（skill 里的「可用执行者」一节）。 */
export function executorCatalogText(rows: readonly string[]): string {
  return rows.length > 0 ? rows.map((row) => `- ${row}`).join("\n") : "- （暂无可用执行者）";
}

/** 上下文包：每个小节独立截断，坏掉的小节由调用方跳过。 */
export function buildContextPack(sections: readonly { title: string; body: string }[]): string {
  const parts = sections
    .filter((section) => section.body.trim() !== "")
    .map(
      (section) =>
        `### ${section.title}\n${section.body.trim().slice(0, SECTION_CAP)}`,
    );
  return parts.length > 0 ? parts.join("\n\n") : "（暂无）";
}

export function buildDecisionUser(input: {
  contextPack: string;
  history: readonly DeckTurn[];
  message: string;
}): string {
  const history = input.history
    .slice(-HISTORY_TURNS)
    .map((turn) => {
      const role = turn.role === "user" ? "用户" : turn.role === "assistant" ? "主控" : "系统";
      return `${role}：${turn.text.slice(0, 1_500)}`;
    })
    .join("\n");
  return `## 现在掌握的信息

${input.contextPack}

## 最近对话

${history === "" ? "（无）" : history}

## 用户最新消息

${input.message}

请输出决策 JSON。`;
}

export function buildDecisionSystem(input: {
  executors: string;
  now: string;
  timeZone: string;
}): string {
  return deckSkillText(input);
}

/** 跑一次主控决策。模型没给出合法 JSON 时，整段文本按回答处理。 */
export async function runMasterDecision(options: {
  backend: LlmBackend;
  system: string;
  user: string;
  /** 流式显示：增量回调「到目前为止可显示的回答」。缺省走一次性补全。 */
  onDisplay?: (cumulative: string) => void;
}): Promise<DeckDecision> {
  let text: string;
  const request = {
    system: options.system,
    user: options.user,
    jsonSchema: DECISION_JSON_SCHEMA,
  };
  if (options.onDisplay && options.backend.completeStream) {
    const display = createDecisionDisplay();
    text = await options.backend.completeStream(request, (raw) => {
      if (display.push(raw) !== "") options.onDisplay?.(display.text());
    });
  } else {
    text = await options.backend.complete(request);
  }
  const decision = parseDecision(text);
  if (decision !== null) return decision;
  const fallback = text.trim();
  if (fallback === "") {
    throw new Error("主控没有返回决策");
  }
  return { kind: "answer", text: fallback };
}

/**
 * 决策 JSON 的增量显示提取器：决策流式产出时，把 "text" 字段的字符串值
 * 实时解出来给界面显示（对 answer 决策就是回答本身）。整段不是 JSON 时
 * （parseDecision 的 prose 兜底），按原文显示。dispatch/schedule 没有
 * text 字段，全程显示空——由 event 轮接管。
 */
export function createDecisionDisplay(): {
  push(chunk: string): string;
  text(): string;
} {
  let raw = "";
  let display = "";
  let mode: "undecided" | "json" | "prose" = "undecided";
  let cursor = 0;
  let inText = false;
  let done = false;
  let escape = false;
  let unicodeLeft = 0;
  let unicodeValue = 0;
  /** 已找到 "text" 键、还在等冒号和开引号跨块到达。 */
  let pendingKeyAt = -1;

  const scanJson = (): string => {
    let produced = "";
    while (cursor < raw.length && !done) {
      const ch = raw.charAt(cursor);
      if (!inText) {
        // 找 "text" 键：合法 JSON 里字符串值内的引号必是 \"，含反斜杠，
        // 不会与裸的 "text" 混淆。
        if (pendingKeyAt >= 0) {
          const after = raw.slice(pendingKeyAt + 6).match(/^[ \t\r\n]*:[ \t\r\n]*"/u);
          if (!after) break;
          cursor = pendingKeyAt + 6 + after[0].length;
          pendingKeyAt = -1;
          inText = true;
          continue;
        }
        const at = raw.indexOf('"text"', cursor);
        if (at === -1) {
          cursor = raw.length;
          break;
        }
        const after = raw.slice(at + 6).match(/^[ \t\r\n]*:[ \t\r\n]*"/u);
        if (!after) {
          pendingKeyAt = at;
          cursor = at + 6;
          break;
        }
        cursor = at + 6 + after[0].length;
        inText = true;
        continue;
      }
      if (unicodeLeft > 0) {
        const hex = /[0-9a-fA-F]/u.test(ch) ? Number.parseInt(ch, 16) : Number.NaN;
        cursor += 1;
        if (Number.isNaN(hex)) {
          unicodeLeft = 0;
          produced += "\uFFFD";
          display += "\uFFFD";
          continue;
        }
        unicodeValue = unicodeValue * 16 + hex;
        unicodeLeft -= 1;
        if (unicodeLeft === 0) {
          const decoded = String.fromCharCode(unicodeValue);
          produced += decoded;
          display += decoded;
        }
        continue;
      }
      if (escape) {
        escape = false;
        cursor += 1;
        const decoded =
          ch === "n"
            ? "\n"
            : ch === "t"
              ? "\t"
              : ch === "r"
                ? "\r"
                : ch === "b"
                  ? "\b"
                  : ch === "f"
                    ? "\f"
                    : ch === "u"
                      ? ((unicodeLeft = 4), (unicodeValue = 0), "")
                      : ch;
        if (ch === "u") continue;
        produced += decoded;
        display += decoded;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        cursor += 1;
        continue;
      }
      if (ch === '"') {
        done = true;
        cursor += 1;
        break;
      }
      produced += ch;
      display += ch;
      cursor += 1;
    }
    return produced;
  };

  return {
    /** chunk 是到目前为止的模型原始输出（累计），不是增量。 */
    push(chunk: string): string {
      const prevLen = raw.length;
      if (chunk.length <= prevLen && mode !== "undecided") return "";
      raw = chunk;
      if (mode === "undecided") {
        const trimmed = raw.trimStart();
        if (trimmed === "") return "";
        mode = trimmed.startsWith("{") ? "json" : "prose";
        if (mode === "prose") {
          display = raw;
          return raw;
        }
      }
      if (mode === "prose") {
        const added = raw.slice(display.length);
        display = raw;
        return added;
      }
      // 新内容只在尾部。上次 seek 失败时指针可能推过了半截的 "text" 键，
      // 退 5 格保证跨块的键能被重新找到；进了字符串值之后不退（逐字走，
      // 回退会重复出字）。
      if (!inText && cursor > prevLen - 5) cursor = Math.max(0, prevLen - 5);
      return scanJson();
    },
    text(): string {
      return display;
    },
  };
}
