import type { CandidateTopic } from "../refine/types.js";
import { rankTopicsByText } from "../topics/similarity.js";
import type { TopicBook } from "../topics/types.js";
import { resolveMergedTopic } from "../topics/zones.js";
import { RECALL_MIN_SCORE } from "./types.js";

/**
 * The topic a session is about, or null when there is no good guess.
 * A session the refiner already placed keeps its topic; otherwise the user's words are
 * matched against topic names, aliases, summaries and recent titles. No model call.
 */
export function matchRecallTopic(input: {
  assignedTopicId: string | null;
  userText: string;
  topics: readonly CandidateTopic[];
  book: TopicBook;
}): string | null {
  if (input.assignedTopicId) return resolveMergedTopic(input.book, input.assignedTopicId);
  const best = rankTopicsByText(input.topics, input.userText)[0];
  if (!best || best.score < RECALL_MIN_SCORE) return null;
  return resolveMergedTopic(input.book, best.topic.topicId);
}
