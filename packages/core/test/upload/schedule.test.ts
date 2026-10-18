import { describe, expect, it } from "bun:test";

import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_UPLOAD_ACTIVE_INTERVAL_MINUTES,
} from "@you-brain/protocol";

import {
  decideUpload,
  emptySchedule,
  noteActivity,
  noteUpload,
} from "../../src/upload/schedule.js";

const idleMs = DEFAULT_IDLE_MINUTES * 60_000;
const activeMs = DEFAULT_UPLOAD_ACTIVE_INTERVAL_MINUTES * 60_000;

describe("upload schedule", () => {
  it("waits out a fresh active session, then uploads on the active interval", () => {
    let state = noteActivity(emptySchedule(), 0);
    expect(decideUpload(state, 0)).toEqual({
      due: false,
      reason: "waiting",
      waitMs: activeMs,
    });

    state = noteActivity(state, 4 * 60_000);
    expect(decideUpload(state, 4 * 60_000).due).toBe(false);

    state = noteActivity(state, activeMs);
    expect(decideUpload(state, activeMs)).toEqual({
      due: true,
      reason: "active",
      waitMs: 0,
    });

    state = noteUpload(state, activeMs);
    state = noteActivity(state, activeMs);
    expect(decideUpload(state, activeMs).due).toBe(false);
    state = noteActivity(state, activeMs + activeMs);
    expect(decideUpload(state, activeMs + activeMs)).toMatchObject({
      due: true,
      reason: "active",
    });
  });

  it("uploads once the session is idle and skips a clean idle period", () => {
    let state = noteActivity(emptySchedule(), 0);
    expect(decideUpload(state, idleMs)).toEqual({
      due: true,
      reason: "idle",
      waitMs: 0,
    });
    state = noteUpload(state, idleMs);
    expect(decideUpload(state, idleMs + idleMs)).toEqual({
      due: false,
      reason: "waiting",
      waitMs: Number.POSITIVE_INFINITY,
    });
  });

  it("uploads after idle when new activity arrived since the last upload", () => {
    let state = noteActivity(emptySchedule(), 0);
    state = noteUpload(state, 0);
    state = noteActivity(state, 60_000);
    expect(decideUpload(state, 60_000 + idleMs)).toEqual({
      due: true,
      reason: "idle",
      waitMs: 0,
    });
  });
});
