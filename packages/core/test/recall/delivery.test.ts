import { describe, expect, it } from "bun:test";

import {
  RECALL_DAILY_LIMIT,
  decideRecallDelivery,
  recallReminderId,
  type RecallDeliveryInput,
} from "../../src/recall/index.js";
import type { ReminderRecord } from "../../src/store/types.js";

const NOW = Date.parse("2026-11-16T08:00:00.000Z");
const TZ = "Asia/Shanghai";

function sent(id: string, topicId: string, issuedAt: string, kind = "recall"): ReminderRecord {
  return { reminderId: id, kind, topicId, sessionKey: null, text: "x", status: "dismissed", until: null, issuedAt, updatedAt: issuedAt };
}

function input(extra: Partial<RecallDeliveryInput> = {}): RecallDeliveryInput {
  return { grade: "normal", topicId: "t1", reminders: [], nowMs: NOW, timeZone: TZ, ...extra };
}

describe("decideRecallDelivery", () => {
  const sameTopicRecently = [sent("r1", "t1", "2026-11-16T02:00:00.000Z")];
  const fiveToday = Array.from({ length: RECALL_DAILY_LIMIT }, (_, i) =>
    sent(`d${i}`, `other-${i}`, "2026-11-16T01:00:00.000Z"),
  );

  it("一般：没有任何限制时弹通知", () => {
    expect(decideRecallDelivery(input())).toEqual({ kind: "recall", reason: "ok" });
  });

  it("一般：同一话题 24 小时内提过（即使被点掉）就不再提", () => {
    expect(decideRecallDelivery(input({ reminders: sameTopicRecently }))).toEqual({ kind: null, reason: "topic-cooldown" });
    const old = [sent("r0", "t1", "2026-11-15T07:59:00.000Z")];
    expect(decideRecallDelivery(input({ reminders: old })).kind).toBe("recall");
  });

  it("一般：当天（本地日）已有 5 条就不再提", () => {
    expect(decideRecallDelivery(input({ reminders: fiveToday }))).toEqual({ kind: null, reason: "daily-limit" });
    const yesterdayLocal = fiveToday.map((item) => ({ ...item, issuedAt: "2026-11-15T15:00:00.000Z" }));
    expect(decideRecallDelivery(input({ reminders: yesterdayLocal })).kind).toBe("recall");
  });

  it("一般：晚到且已离开也照常弹通知", () => {
    expect(decideRecallDelivery(input({}))).toEqual({ kind: "recall", reason: "ok" });
  });

  it("重要：话题冷却中、当天已满，仍然弹通知", () => {
    const hard = input({
      grade: "important",
      reminders: [...sameTopicRecently, ...fiveToday],
    });
    expect(decideRecallDelivery(hard)).toEqual({ kind: "recall", reason: "ok" });
  });

  it("其他类型的提醒不计入冷却和每日条数", () => {
    const others = Array.from({ length: 8 }, (_, i) => sent(`m${i}`, "t1", "2026-11-16T01:00:00.000Z", "morning_digest"));
    expect(decideRecallDelivery(input({ reminders: others })).kind).toBe("recall");
  });
});

describe("recallReminderId", () => {
  it("同一会话同一话题稳定，换会话或话题就不同", () => {
    expect(recallReminderId("s1", "t1")).toBe(recallReminderId("s1", "t1"));
    expect(recallReminderId("s1", "t1")).not.toBe(recallReminderId("s1", "t2"));
    expect(recallReminderId("s1", "t1")).not.toBe(recallReminderId("s2", "t1"));
    expect(recallReminderId("s1", "t1")).toMatch(/^recall:[0-9a-f]{16}$/);
  });
});
