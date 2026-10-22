import { describe, expect, test } from "bun:test";

import { consolidateGate, formatConsolidationRun } from "../../src/pages/settings/consolidation-status.js";

const labels = { succeeded: "成功", failed: "失败" };

describe("consolidation status", () => {
  test("allows the button only when consolidation is on and this device is main", () => {
    expect(
      consolidateGate({ enabled: true, deviceId: "mac", mainDevice: "mac" }),
    ).toBe("ready");
    expect(
      consolidateGate({ enabled: false, deviceId: "mac", mainDevice: "mac" }),
    ).toBe("off");
    expect(
      consolidateGate({ enabled: true, deviceId: "air", mainDevice: "mac" }),
    ).toBe("not-main");
    expect(
      consolidateGate({ enabled: true, deviceId: null, mainDevice: "mac" }),
    ).toBe("not-main");
    expect(
      consolidateGate({ enabled: true, deviceId: "mac", mainDevice: null }),
    ).toBe("not-main");
  });

  test("formats the latest run with the failure reason", () => {
    expect(formatConsolidationRun({ day: "2026-10-23", ok: true }, labels)).toBe(
      "2026-10-23 成功",
    );
    expect(
      formatConsolidationRun(
        { day: "2026-10-23", ok: false, error: "部分话题概要没有写完" },
        labels,
      ),
    ).toBe("2026-10-23 失败（部分话题概要没有写完）");
    expect(formatConsolidationRun({ day: "2026-10-23", ok: false, error: "  " }, labels)).toBe(
      "2026-10-23 失败",
    );
  });
});
