import { describe, expect, it } from "bun:test";

import { pendingCorrections } from "../../src/consolidate/portrait-drive.js";
import { portraitCorrectionViews } from "../../src/portrait/corrections.js";
import { buildEvent } from "../topics/helpers.js";

const T0 = "2026-07-01T00:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

function correction(
  correctionId: string,
  ts: string,
  variant: string,
  text: string,
  counter: number,
) {
  return buildEvent({
    type: "portrait.correction",
    data: { correctionId, variant, section: "语气", text },
    device: "dev-a",
    ts,
    seq: counter,
    counter,
  });
}

function applied(correctionId: string, ts: string, snapshot: string, counter: number) {
  return buildEvent({
    type: "portrait.correction_applied",
    data: { correctionId, snapshot },
    device: "dev-a",
    ts,
    seq: counter,
    counter,
  });
}

describe("portrait correction views", () => {
  it("marks pending and applied rows, and keeps the first text for a repeated id", () => {
    const first = correction("dup", at(0), "full", "先写的", 1);
    const later = correction("dup", at(5), "full", "后写的", 2);
    const pending = correction("open", at(3), "full", "还没应用", 3);
    const done = correction("done", at(1), "brief", "已用", 4);
    const earlyApplied = applied("done", at(0), "old.md", 5);
    const lateApplied = applied("done", at(4), "new.md", 6);
    const onlyApplied = applied("ghost", at(2), "ghost.md", 7);
    const noise = buildEvent({
      type: "topic.created",
      data: { topicId: "topic-1", name: "甲", aliases: [] },
      device: "dev-a",
      ts: at(6),
      seq: 8,
      counter: 8,
    });
    const views = portraitCorrectionViews([
      later,
      pending,
      done,
      earlyApplied,
      lateApplied,
      onlyApplied,
      noise,
      first,
    ]);
    expect(views.map((item) => item.correctionId)).toEqual(["open", "done", "dup"]);
    const dup = views.find((item) => item.correctionId === "dup");
    const open = views.find((item) => item.correctionId === "open");
    const used = views.find((item) => item.correctionId === "done");
    expect(dup).toMatchObject({
      text: "先写的",
      createdAt: at(0),
      status: "pending",
      variant: "full",
    });
    expect(dup !== undefined && "snapshot" in dup).toBe(false);
    expect(open).toMatchObject({ status: "pending", text: "还没应用" });
    expect(used).toMatchObject({
      status: "applied",
      snapshot: "new.md",
      text: "已用",
      variant: "brief",
      createdAt: at(1),
    });
  });

  it("orders same-timestamp rows by event id, newest first", () => {
    const low = correction("low", at(1), "full", "甲", 1);
    const high = correction("high", at(1), "full", "乙", 2);
    expect(low.id < high.id).toBe(true);
    expect(portraitCorrectionViews([low, high]).map((item) => item.correctionId)).toEqual([
      "high",
      "low",
    ]);
    const older = applied("same", at(1), "old.md", 3);
    const newer = applied("same", at(1), "new.md", 4);
    const row = correction("same", at(1), "full", "正文", 5);
    expect(portraitCorrectionViews([older, row, newer])[0]?.snapshot).toBe("new.md");
  });

  it("returns the newest 50 and filters by variant before the cap", () => {
    const events = [];
    for (let index = 0; index < 55; index += 1) {
      events.push(correction(`c${index}`, at(index), index % 2 === 0 ? "full" : "brief", `t${index}`, index + 1));
    }
    const all = portraitCorrectionViews(events);
    expect(all).toHaveLength(50);
    expect(all[0]?.correctionId).toBe("c54");
    expect(all[49]?.correctionId).toBe("c5");
    expect(all.some((item) => item.correctionId === "c4")).toBe(false);

    const full = portraitCorrectionViews(events, "full");
    expect(full.every((item) => item.variant === "full")).toBe(true);
    expect(full[0]?.correctionId).toBe("c54");
    expect(full.some((item) => item.correctionId === "c0")).toBe(true);

    const manyFull = [];
    for (let index = 0; index < 60; index += 1) {
      manyFull.push(correction(`f${index}`, at(index), "full", `f${index}`, index + 1));
    }
    manyFull.push(correction("brief-new", at(100), "brief", "精简", 200));
    const capped = portraitCorrectionViews(manyFull, "full");
    expect(capped).toHaveLength(50);
    expect(capped[0]?.correctionId).toBe("f59");
    expect(capped.some((item) => item.variant !== "full")).toBe(false);
    expect(portraitCorrectionViews(manyFull, "brief").map((item) => item.correctionId)).toEqual([
      "brief-new",
    ]);
  });

  it("keeps unapplied full corrections oldest-first for consolidation", () => {
    const events = [
      correction("later", at(9), "full", "后写的", 1),
      correction("earlier", at(1), "full", "先写的", 2),
      correction("earlier", at(8), "full", "同一条的后写", 3),
      correction("brief", at(0), "brief", "精简不用管", 4),
      correction("done", at(2), "full", "已经用过", 5),
      applied("done", at(3), "old.md", 6),
    ];
    expect(pendingCorrections(events)).toEqual([
      { correctionId: "earlier", section: "语气", text: "先写的" },
      { correctionId: "later", section: "语气", text: "后写的" },
    ]);
  });
});
