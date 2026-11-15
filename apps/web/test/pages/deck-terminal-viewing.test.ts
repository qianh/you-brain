import { expect, it } from "bun:test";

import { viewingTarget } from "../../src/pages/deck-terminal-viewing.js";

it("reports the active pane only when the window is focused and the page is visible", () => {
  expect(viewingTarget(7, true, true)).toBe(7);
  expect(viewingTarget(0, true, true)).toBe(0);
  expect(viewingTarget(7, false, true)).toBeNull();
  expect(viewingTarget(7, true, false)).toBeNull();
  expect(viewingTarget(null, true, true)).toBeNull();
});
