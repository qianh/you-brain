import type { Event, EventOf, EventType } from "@you-brain/protocol";

import { foldEvents } from "../../src/topics/index.js";
import { buildEvent, plus, sessionKey } from "../topics/helpers.js";

export const TZ = "Asia/Shanghai";
export const CURRENT = sessionKey(9);
export const OLD = sessionKey(1);

let seq = 0;
function at<T extends EventType>(type: T, data: EventOf<T>["data"], ts: string): Event {
  seq += 1;
  return buildEvent<T>({ type, data, device: "dev-a", ts, seq });
}

/** 两个话题；A 是旧话题（待办、结论、下一步），B 已并入 A。 */
export function recallBook(extra: Event[] = []) {
  seq = 0;
  const events: Event[] = [
    at("topic.created", { topicId: "topic-a", name: "海运运价预测", aliases: ["运价"] }, "2026-11-08T02:00:00.000Z"),
    at("topic.created", { topicId: "topic-b", name: "运价数据源", aliases: [] }, "2026-11-08T03:00:00.000Z"),
    at("topic.created", { topicId: "topic-c", name: "Agent Reach", aliases: [] }, "2026-11-08T04:00:00.000Z"),
    at("session.refined", { sessionKey: OLD, fileId: "f1", source: "claude-code", title: "运价预测讨论", summary: "", refinedUpTo: 4 }, "2026-11-08T05:00:00.000Z"),
    at("topic.assigned", { topicId: "topic-a", sessionKey: OLD }, "2026-11-08T05:00:01.000Z"),
    at("todo.added", { todoId: "todo-1", topicId: "topic-a", text: "接入 10 月运价数据后重训", sessionKey: OLD, confidence: 0.9 }, "2026-11-13T02:00:00.000Z"),
    at("todo.added", { todoId: "todo-2", topicId: "topic-b", text: "核对数据源的字段口径", sessionKey: OLD, confidence: 0.9 }, "2026-11-12T02:00:00.000Z"),
    at("conclusion.added", { conclusionId: "con-1", topicId: "topic-a", text: "按月重训，周数据噪声太大", sessionKey: OLD }, "2026-11-08T06:00:00.000Z"),
    at("topic.summary_rewritten", { topicId: "topic-a", summary: "预测海运运价", nextStep: "等数据到齐" }, "2026-11-13T03:00:00.000Z"),
    at("topic.merged", { fromTopicId: "topic-b", intoTopicId: "topic-a" }, "2026-11-13T04:00:00.000Z"),
    ...extra,
  ];
  return foldEvents(events);
}

export { at as event, plus };
