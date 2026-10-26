import { describe, expect, it } from "bun:test";

import { presentReminders } from "../../src/reminders/present.js";
import { reminderRecord } from "./fixture.js";

const NOW = "2026-10-26T09:00:00.000Z";

describe("presentReminders", () => {
  it("hides the per-topic history reminders that are no longer issued", () => {
    // They were issued one per archived topic before the weekly review started naming a
    // shortlist. The events stay in the log, so the view has to drop them.
    const records = [
      reminderRecord({
        reminderId: "history:topic-a:2026-W44",
        kind: "history",
        topicId: "topic-a",
        status: "open",
      }),
      reminderRecord({
        reminderId: "weekly:2026-W44",
        kind: "weekly_review",
        topicId: null,
        status: "open",
      }),
    ];

    const views = presentReminders(records, NOW, [], true);

    expect(views.map((item) => item.reminderId)).toEqual(["weekly:2026-W44"]);
  });

  it("keeps the other kinds", () => {
    const records = [
      reminderRecord({
        reminderId: "stale:topic-a:2026-10-19",
        kind: "stale",
        topicId: "topic-a",
        status: "open",
      }),
      reminderRecord({
        reminderId: "morning:2026-10-26",
        kind: "morning_digest",
        topicId: null,
        status: "open",
      }),
    ];

    const views = presentReminders(records, NOW, [], false);

    expect(views.map((item) => item.kind).sort()).toEqual(["morning_digest", "stale"]);
  });
});
