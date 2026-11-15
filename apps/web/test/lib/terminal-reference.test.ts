import { describe, expect, test } from "bun:test";
import { terminalReferenceMessage } from "../../src/lib/terminal-reference.js";

describe("terminal reference messages", () => {
  const frame = {} as Window;
  const url = "http://127.0.0.1:3001/";
  const data = { type: "u-brain:terminal-reference:open", pane: 140, workspaceId: "ws-1", tabId: "tab-1" };
  const event = { source: frame, origin: new URL(url).origin, data };

  test("accepts handshake and exact terminal identity from the active iframe", () => {
    expect(terminalReferenceMessage({ ...event, data: { type: "u-brain:terminal-reference:ready" } }, frame, url)).toEqual({ type: "ready" });
    expect(terminalReferenceMessage(event, frame, url)).toEqual({ type: "open", pane: 140, workspaceId: "ws-1", tabId: "tab-1" });
  });

  test("rejects foreign windows, stale dsh origins and incomplete identities", () => {
    expect(terminalReferenceMessage({ ...event, source: {} as Window }, frame, url)).toBeNull();
    expect(terminalReferenceMessage(event, null, url)).toBeNull();
    expect(terminalReferenceMessage({ ...event, origin: "http://127.0.0.1:3002" }, frame, url)).toBeNull();
    for (const invalid of [null, {}, { ...data, pane: -1 }, { ...data, pane: "140" }, { ...data, tabId: "" }, { ...data, workspaceId: null }]) {
      expect(terminalReferenceMessage({ ...event, data: invalid }, frame, url)).toBeNull();
    }
  });
});
