import type { Turn } from "../domain/session.js";

/**
 * Text a CLI injects as the first "user" message before the user says anything.
 * Codex writes `# AGENTS.md instructions for …` plus `<environment_context>`, and
 * appends `<recommended_plugins>` / `<user_instructions>` blocks. Opening Codex and
 * closing it again leaves one of these files behind, which is why a library can hold
 * thousands of "sessions" with no conversation in them.
 */
const INJECTED_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<user_instructions>",
  "<recommended_plugins>",
  "<user_action>",
  "<INSTRUCTIONS>",
] as const;

const SYSTEM_WRAPPER_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gu,
  /<local-command-(?:stdout|stderr|caveat)>[\s\S]*?<\/local-command-(?:stdout|stderr|caveat)>/gu,
] as const;

const BUILTIN_CONTROL_COMMAND =
  /^\/?(?:clear|compact|exit|quit|status|cost|context|help|login|logout|doctor|model|permissions|vim|config|terminal-setup|release-notes)(?:\s+[\w.:-]+)?$/iu;

const RAW_LOG_INPUT = /(?:\S+\.(?:raw\.txt|jsonl|log)\b|指定时段的\s*raw\s*文本|时段原始记录)/iu;
const OVERWRITE_DIGEST_OUTPUT = /(?:覆盖写入|覆盖保存|整理[^\n]{0,30}(?:纪要|日报|摘要))/u;
const UNATTENDED_CONSTRAINT = /(?:^只根据|不调用\s*\S+|不读其他|不要询问|不要反问|写完文件后不再输出)/u;

export function isInjectedPrompt(text: string): boolean {
  const head = text.trimStart();
  return INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * True when a user turn is only a built-in CLI housekeeping command (`/clear`, `/compact`,
 * `/status`, etc.) or its `<command-name>` XML wrapper without substantive user arguments.
 */
export function isCliControlTurn(text: string): boolean {
  let stripped = text;
  for (const block of SYSTEM_WRAPPER_BLOCKS) stripped = stripped.replace(block, " ");
  const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/u.exec(stripped);
  const argsText = argsMatch?.[1]?.trim() ?? "";
  const nameMatch = /<command-name>([\s\S]*?)<\/command-name>/u.exec(stripped);
  if (nameMatch) {
    const cmdName = nameMatch[1]?.trim() ?? "";
    if (argsText === "" && BUILTIN_CONTROL_COMMAND.test(cmdName)) return true;
    if (argsText !== "") return false;
  }
  const plain = stripped
    .replace(/<(?:command|local-command)-[a-z-]+>[\s\S]*?<\/(?:command|local-command)-[a-z-]+>/gu, " ")
    .trim();
  if (plain === "") return nameMatch !== null;
  return /^\/[a-z][\w-]*\b/iu.test(plain) && BUILTIN_CONTROL_COMMAND.test(plain);
}

/**
 * True when a prompt is a non-interactive scheduled batch digest template
 * (e.g. reading a raw time-slot log file and overwriting a target markdown digest).
 */
export function isAutomatedBatchPrompt(text: string): boolean {
  const head = text.trim();
  if (head === "") return false;
  if (/^只根据\s*\S+\.raw\.txt\s*整理/u.test(head)) return true;
  return RAW_LOG_INPUT.test(head) && OVERWRITE_DIGEST_OUTPUT.test(head) && UNATTENDED_CONSTRAINT.test(head);
}

/** True when every non-injected user turn in a session is a bare CLI control turn (`/clear`, etc.). */
export function isTrivialControlSession(
  turns: ReadonlyArray<{ role: string; text: string }>,
): boolean {
  const nonInjected = turns.filter(
    (turn) => turn.role === "user" && turn.text.trim() !== "" && !isInjectedPrompt(turn.text),
  );
  return nonInjected.length > 0 && nonInjected.every((turn) => isCliControlTurn(turn.text));
}

/** True when every substantive user turn in a session is an unattended batch digest prompt. */
export function isAutomatedBatchSession(
  turns: ReadonlyArray<{ role: string; text: string }>,
): boolean {
  const userTurns = turns.filter(
    (turn) =>
      turn.role === "user" &&
      turn.text.trim() !== "" &&
      !isInjectedPrompt(turn.text) &&
      !isCliControlTurn(turn.text),
  );
  return userTurns.length > 0 && userTurns.every((turn) => isAutomatedBatchPrompt(turn.text));
}

/**
 * A session worth uploading, refining, and turning into a topic.
 *
 * The test is whether the user actually typed something substantive: at least one user turn
 * that is neither injected CLI startup context nor a bare housekeeping slash command (`/clear`).
 * An assistant reply is deliberately not required so in-progress sessions are captured live.
 */
export function isConversation(turns: readonly Turn[]): boolean {
  return turns.some(
    (turn) =>
      turn.role === "user" &&
      turn.text.trim() !== "" &&
      !isInjectedPrompt(turn.text) &&
      !isCliControlTurn(turn.text),
  );
}
