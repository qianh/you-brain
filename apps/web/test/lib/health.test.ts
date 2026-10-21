import { describe, expect, test } from "bun:test";

import { capsuleKind, type CapsuleInput } from "../../src/lib/health.js";

function input(patch: Partial<CapsuleInput>): CapsuleInput {
  return {
    connected: true,
    syncing: false,
    driveReachable: true,
    refineError: null,
    syncError: null,
    warningCount: 0,
    ...patch,
  };
}

describe("capsuleKind", () => {
  test("prefers offline, then loading, then errors, then warnings", () => {
    expect(capsuleKind(input({ connected: false, syncing: true, refineError: "x", warningCount: 2 }))).toBe("offline");
    expect(capsuleKind(input({ syncing: true, refineError: "bad" }))).toBe("loading");
    expect(capsuleKind(input({ refineError: "  解析失败  ", syncError: "sync", warningCount: 3 }))).toBe("refine-error");
    expect(capsuleKind(input({ syncError: "cursor expired" }))).toBe("sync-error");
    expect(capsuleKind(input({ driveReachable: false }))).toBe("sync-error");
    expect(capsuleKind(input({ warningCount: 2 }))).toBe("warn");
    expect(capsuleKind(input({}))).toBe("ok");
  });

  test("treats an unknown drive and a blank error as healthy", () => {
    expect(capsuleKind(input({ driveReachable: null }))).toBe("ok");
    expect(capsuleKind(input({ refineError: "   ", syncError: "" }))).toBe("ok");
    expect(capsuleKind(input({ driveReachable: null, warningCount: 1 }))).toBe("warn");
  });
});
