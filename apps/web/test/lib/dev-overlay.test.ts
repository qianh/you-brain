import { describe, expect, test } from "bun:test";

import { devOverlayAllowed } from "../../src/lib/dev-overlay.js";

describe("devOverlayAllowed", () => {
  test("stays off production routes", () => {
    expect(devOverlayAllowed("/settings", false)).toBe(false);
    expect(devOverlayAllowed("/_design", false)).toBe(true);
  });
});
