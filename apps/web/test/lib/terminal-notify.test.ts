import { expect, it } from "bun:test";

import { TERMINAL_NOTIFY_KEY, terminalNotifyOn, terminalNotifyValue } from "../../src/lib/terminal-notify.js";
import { isPrefKey } from "../../src/lib/prefs.js";

it("is on unless the stored value is exactly \"0\"", () => {
  expect(terminalNotifyOn(null)).toBe(true);
  expect(terminalNotifyOn("1")).toBe(true);
  expect(terminalNotifyOn("")).toBe(true);
  expect(terminalNotifyOn("0")).toBe(false);
});

it("writes \"0\" to turn it off and removes the key to turn it on", () => {
  expect(terminalNotifyValue(false)).toBe("0");
  expect(terminalNotifyValue(true)).toBeNull();
});

it("is a key the daemon keeps as a preference", () => {
  expect(isPrefKey(TERMINAL_NOTIFY_KEY)).toBe(true);
});
