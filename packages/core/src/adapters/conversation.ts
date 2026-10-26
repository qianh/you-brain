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

export function isInjectedPrompt(text: string): boolean {
  const head = text.trimStart();
  return INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * A session worth uploading, refining, and turning into a topic.
 *
 * The test is whether the user actually typed something: one user turn that is not
 * injected context. An assistant reply is deliberately not required. A conversation
 * is captured while it is still in progress, and a question the model has not answered
 * yet is still the user's own work; requiring a reply would drop the session that is
 * being written right now and only pick it up on a later scan.
 *
 * Everything else is CLI startup noise: injected instructions and an environment dump.
 */
export function isConversation(turns: readonly Turn[]): boolean {
  return turns.some(
    (turn) => turn.role === "user" && turn.text.trim() !== "" && !isInjectedPrompt(turn.text),
  );
}
