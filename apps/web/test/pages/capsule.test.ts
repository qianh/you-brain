import { describe, expect, test } from "bun:test";

import type { CapsuleStatus } from "../../src/lib/health.js";
import { panelCapsuleKind } from "../../src/pages/panel.js";
import { shellCapsuleKind } from "../../src/shell.js";

function status(patch: {
  lastError?: string | null;
  reachable?: boolean | null;
  refineError?: string | null;
  warnings?: readonly unknown[];
}): CapsuleStatus {
  return {
    drive: { reachable: patch.reachable === undefined ? true : patch.reachable },
    refine: { lastError: patch.refineError ?? null },
    sync: { lastError: patch.lastError ?? null },
    warnings: patch.warnings ?? [],
  };
}

describe("shell and panel capsules", () => {
  test("lastError is sync-error, and never-synced or a backlog is not", () => {
    const idle = status({ lastError: null });
    expect(shellCapsuleKind({ loading: false, status: idle })).toBe("ok");
    expect(panelCapsuleKind({ loading: false, error: null, status: idle })).toBe("ok");

    const neverSynced = status({ lastError: "   " });
    expect(shellCapsuleKind({ loading: false, status: neverSynced })).toBe("ok");
    expect(panelCapsuleKind({ loading: false, error: null, status: neverSynced })).toBe("ok");

    const failed = status({ lastError: "同步失败：变更游标无效" });
    expect(shellCapsuleKind({ loading: false, status: failed })).toBe("sync-error");
    expect(panelCapsuleKind({ loading: false, error: null, status: failed })).toBe("sync-error");
  });

  test("keeps refine ahead of sync, and an unreachable drive as sync-error", () => {
    const both = status({ lastError: "同步失败", refineError: "解析失败" });
    expect(shellCapsuleKind({ loading: false, status: both })).toBe("refine-error");
    expect(panelCapsuleKind({ loading: false, error: null, status: both })).toBe("refine-error");

    const down = status({ reachable: false });
    expect(shellCapsuleKind({ loading: false, status: down })).toBe("sync-error");
    expect(panelCapsuleKind({ loading: false, error: null, status: down })).toBe("sync-error");
  });
});
