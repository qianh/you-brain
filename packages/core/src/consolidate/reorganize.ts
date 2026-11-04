import type { EventOf, TopicStatus } from "@you-brain/protocol";
import { z } from "zod";

import type { LlmBackend } from "../llm/types.js";
import { extractJson } from "../refine/parse.js";
import { canonicalTopicName } from "../topics/normalize.js";
import type { TopicBook } from "../topics/types.js";
import { collapseText } from "./text.js";

/**
 * Folding a fragmented topic book back into topics worth having. One topic per
 * conversation is what a backfill leaves behind, and suggesting pairs one at a time
 * never catches up with that, so the model sees every name at once and groups them.
 * Nothing is applied here: a merge has no undo, so the user reviews the plan first.
 */

/** Keeps one prompt within what a model handles well. The oldest topics wait for a later run. */
export const REORGANIZE_TOPIC_LIMIT = 1_500;
const MAX_ATTEMPTS = 2;
/** The whole book in one call: about seven minutes for 931 topics on a subscription CLI. */
const REORGANIZE_TIMEOUT_MS = 20 * 60_000;
const MAX_ALIASES = 20;
const REASON_CHARS = 60;
export const NOISE_GROUP_NAME = "测试与探针会话";

export const REORGANIZE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["groups", "noise"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "reason", "topics"],
        properties: {
          name: { type: "string", minLength: 1 },
          reason: { type: "string" },
          topics: { type: "array", items: { type: "integer", minimum: 0 } },
        },
      },
    },
    noise: { type: "array", items: { type: "integer", minimum: 0 } },
  },
};

const OutputSchema = z.object({
  groups: z.array(
    z.object({
      name: z.string(),
      reason: z.string().default(""),
      topics: z.array(z.number().int()),
    }),
  ),
  noise: z.array(z.number().int()).default([]),
});

export const REORGANIZE_SYSTEM_PROMPT = `你是 you-brain 的话题整理器。下面是用户话题册里的话题，很多是同一件事被拆碎了，每个话题一行：编号｜名称｜会话数。把它们归并成更少、更有意义的话题。只输出一个 JSON 对象，不要 Markdown，不要解释。

话题是跨会话、跨天持续的一件事或一个项目。

规则：
1. 同一个项目、系统或事情的开发、审查、测试、修复、复核，归为一组。
2. 一次性的小问题（查命令、问概念、问常识）按领域归到宽话题，比如「Git 用法」「Mac 开发环境」「健康问答」。
3. 不要只因为都提到同一个常见词（比如 Claude、代码审查）就归为一组：属于不同项目、不同事情的必须分开。拿不准就不归。
4. name 写这件事本身，不写这次做了什么：用项目、系统、领域的名字，4 到 16 个字，不带审查、测试、修复、复核这类动作词。
5. noise 放没有实际内容的话题的编号：连通性或探针测试（只要求回复 ok、记住暗号再复述）、子代理握手、问模型是谁、空会话。讨论真实项目问题的不算。
6. 每个编号最多出现一次，只能用给出的编号。每组至少两个话题。不需要归并的话题不用输出。
7. reason 用中文短句说明为什么是一组，不超过 30 字。JSON 键名保持英文。`;

export interface ReorganizeTopic {
  topicId: string;
  name: string;
  aliases: readonly string[];
  status: TopicStatus;
  userLocked: boolean;
  sessionCount: number;
  createdTs: string | null;
}

export interface ReorganizeMember {
  topicId: string;
  name: string;
  sessionCount: number;
}

/** One proposed merge. `members` includes the survivor, which comes first. */
export interface ReorganizeGroup {
  name: string;
  reason: string;
  intoTopicId: string;
  members: ReorganizeMember[];
  /** Nothing in it is worth following up: the survivor is marked done. */
  archive: boolean;
}

export interface ReorganizePlan {
  /** Live topics before any merge. */
  topicCount: number;
  /** Live topics the model looked at. Smaller than `topicCount` past the limit. */
  reviewedCount: number;
  /** Live topics left if every group is applied. */
  topicCountAfter: number;
  groups: ReorganizeGroup[];
}

export interface ReorganizeSelection {
  intoTopicId: string;
  fromTopicIds: readonly string[];
  name: string;
  archive: boolean;
}

export type ReorganizeEvent =
  | { type: "topic.merged"; data: EventOf<"topic.merged">["data"] }
  | { type: "topic.renamed"; data: EventOf<"topic.renamed">["data"] }
  | { type: "topic.status_changed"; data: EventOf<"topic.status_changed">["data"] };

/** Live topics with their session counts, most recently created first. */
export function reorganizeTopics(book: TopicBook): ReorganizeTopic[] {
  const counts = new Map<string, number>();
  for (const session of book.sessions) {
    if (session.topicId !== null) counts.set(session.topicId, (counts.get(session.topicId) ?? 0) + 1);
  }
  return book.topics
    .filter((topic) => topic.mergedInto === null && topic.name.trim() !== "")
    .map((topic) => ({
      topicId: topic.topicId,
      name: topic.name,
      aliases: topic.aliases,
      status: topic.status,
      userLocked: topic.userLocked,
      sessionCount: counts.get(topic.topicId) ?? 0,
      createdTs: topic.createdTs,
    }))
    .sort((left, right) => (right.createdTs ?? "").localeCompare(left.createdTs ?? ""));
}

export function buildReorganizePrompt(topics: readonly ReorganizeTopic[]): {
  system: string;
  user: string;
} {
  const lines = topics.map(
    (topic, index) => `${index}｜${collapseText(topic.name)}｜${topic.sessionCount}`,
  );
  return {
    system: REORGANIZE_SYSTEM_PROMPT,
    user: [
      "## 话题",
      lines.join("\n"),
      "",
      "## 输出 JSON schema",
      JSON.stringify(REORGANIZE_JSON_SCHEMA),
    ].join("\n"),
  };
}

function compareSurvivor(left: ReorganizeTopic, right: ReorganizeTopic): number {
  if (left.userLocked !== right.userLocked) return left.userLocked ? -1 : 1;
  if (left.sessionCount !== right.sessionCount) return right.sessionCount - left.sessionCount;
  const created = (left.createdTs ?? "").localeCompare(right.createdTs ?? "");
  if (created !== 0) return created;
  return left.topicId < right.topicId ? -1 : 1;
}

/**
 * The user's own decisions win: a topic they touched is never merged away. It can take
 * other topics in, but then keeps its name; two of them in one group stay apart.
 */
function makeGroup(
  members: readonly ReorganizeTopic[],
  name: string,
  reason: string,
  archive: boolean,
): ReorganizeGroup | null {
  const sorted = [...members].sort(compareSurvivor);
  const survivor = sorted[0];
  if (!survivor) return null;
  const rest = sorted.slice(1).filter((topic) => !topic.userLocked);
  if (rest.length === 0) return null;
  // Marking a topic done is the user's call once they have touched it.
  if (archive && survivor.userLocked) return null;
  return {
    name: survivor.userLocked ? survivor.name : collapseText(name) || survivor.name,
    reason: Array.from(collapseText(reason)).slice(0, REASON_CHARS).join(""),
    intoTopicId: survivor.topicId,
    members: [survivor, ...rest].map((topic) => ({
      topicId: topic.topicId,
      name: topic.name,
      sessionCount: topic.sessionCount,
    })),
    archive,
  };
}

/** Throws when the output does not parse. Bad indexes and repeats are dropped rather than rejected. */
export function parseReorganizePlan(
  input: unknown,
  reviewed: readonly ReorganizeTopic[],
  topicCount: number,
): ReorganizePlan {
  const parsed = OutputSchema.parse(input);
  const claimed = new Set<number>();
  const take = (indexes: readonly number[]): ReorganizeTopic[] => {
    const taken: ReorganizeTopic[] = [];
    for (const index of indexes) {
      const topic = reviewed[index];
      if (!topic || claimed.has(index)) continue;
      claimed.add(index);
      taken.push(topic);
    }
    return taken;
  };

  const groups: ReorganizeGroup[] = [];
  // Noise first: a topic the model calls both is a probe, not part of a project.
  const noise = take(parsed.noise).filter((topic) => !topic.userLocked);
  const noiseGroup = makeGroup(noise, NOISE_GROUP_NAME, "没有实际内容的测试会话", true);
  for (const group of parsed.groups) {
    const made = makeGroup(take(group.topics), group.name, group.reason, false);
    if (made) groups.push(made);
  }
  groups.sort((left, right) => right.members.length - left.members.length);
  if (noiseGroup) groups.push(noiseGroup);

  const absorbed = groups.reduce((sum, group) => sum + group.members.length - 1, 0);
  return {
    topicCount,
    reviewedCount: reviewed.length,
    topicCountAfter: topicCount - absorbed,
    groups,
  };
}

export async function planTopicReorganization(
  llm: LlmBackend,
  topics: readonly ReorganizeTopic[],
): Promise<ReorganizePlan> {
  const reviewed = topics.slice(0, REORGANIZE_TOPIC_LIMIT);
  if (reviewed.length < 2) {
    return {
      topicCount: topics.length,
      reviewedCount: reviewed.length,
      topicCountAfter: topics.length,
      groups: [],
    };
  }
  const prompt = buildReorganizePrompt(reviewed);
  let lastDetail = "模型输出无法校验";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const user =
      attempt === 1
        ? prompt.user
        : `${prompt.user}\n\n## 上次输出无法通过校验\n${lastDetail}\n请只输出修正后的 JSON。`;
    const raw = await llm.complete({
      system: prompt.system,
      user,
      jsonSchema: REORGANIZE_JSON_SCHEMA,
      timeoutMs: REORGANIZE_TIMEOUT_MS,
    });
    try {
      return parseReorganizePlan(extractJson(raw), reviewed, topics.length);
    } catch (error) {
      lastDetail = error instanceof Error ? error.message.slice(0, 500) : lastDetail;
    }
  }
  throw new Error(`话题整理方案生成失败：${lastDetail}`);
}

function mergedAliases(
  newName: string,
  survivor: TopicBook["topics"][number],
  losers: readonly TopicBook["topics"][number][],
): string[] {
  const taken = new Set([canonicalTopicName(newName)]);
  const aliases: string[] = [];
  for (const text of [
    survivor.name,
    ...survivor.aliases,
    ...losers.flatMap((topic) => [topic.name, ...topic.aliases]),
  ]) {
    const trimmed = text.trim();
    const key = canonicalTopicName(trimmed);
    if (trimmed === "" || taken.has(key)) continue;
    taken.add(key);
    aliases.push(trimmed);
    if (aliases.length >= MAX_ALIASES) break;
  }
  return aliases;
}

/**
 * Events for the groups the user accepted, checked against the book as it is now: a
 * plan can be minutes old by the time it comes back. Topics merged or locked since are
 * skipped. All marked `by: "auto"`, so tidying does not make topics look active today.
 */
export function reorganizeEvents(
  book: TopicBook,
  selections: readonly ReorganizeSelection[],
): { events: ReorganizeEvent[]; merged: number } {
  const byId = new Map(book.topics.map((topic) => [topic.topicId, topic]));
  const used = new Set<string>();
  const events: ReorganizeEvent[] = [];
  let merged = 0;
  for (const selection of selections) {
    const survivor = byId.get(selection.intoTopicId);
    if (!survivor || survivor.mergedInto !== null || used.has(survivor.topicId)) continue;
    const losers = selection.fromTopicIds.flatMap((id) => {
      const topic = byId.get(id);
      if (!topic || id === survivor.topicId || used.has(id)) return [];
      if (topic.mergedInto !== null || topic.userLocked) return [];
      used.add(id);
      return [topic];
    });
    if (losers.length === 0) continue;
    used.add(survivor.topicId);
    for (const loser of losers) {
      events.push({
        type: "topic.merged",
        data: { fromTopicId: loser.topicId, intoTopicId: survivor.topicId, by: "auto" },
      });
    }
    merged += losers.length;
    const name = collapseText(selection.name);
    if (!survivor.userLocked && name !== "" && name !== survivor.name) {
      events.push({
        type: "topic.renamed",
        data: {
          topicId: survivor.topicId,
          name,
          aliases: mergedAliases(name, survivor, losers),
          by: "auto",
        },
      });
    }
    const stillOpen = losers.some((topic) => topic.status !== "done");
    if (selection.archive && !survivor.userLocked && survivor.status !== "done") {
      events.push({
        type: "topic.status_changed",
        data: { topicId: survivor.topicId, status: "done", by: "auto" },
      });
    } else if (!selection.archive && stillOpen && survivor.status === "done" && !survivor.userLocked) {
      // Work that was still open must not vanish into a topic that was archived.
      events.push({
        type: "topic.status_changed",
        data: { topicId: survivor.topicId, status: "active", by: "auto" },
      });
    }
  }
  return { events, merged };
}
