import { describe, expect, test } from "bun:test";

import {
  isNavActive,
  isPrimaryNavActive,
  parseAppLocation,
  readQuery,
  searchHref,
  settingsHref,
  topicHref,
} from "../../src/lib/route.js";
import { openFullWindow, quitShell } from "../../src/lib/window.js";

describe("routes", () => {
  test("reads the topic id and trims a trailing slash", () => {
    expect(parseAppLocation("/topics/history/?id=you-brain")).toEqual({
      pathname: "/topics/history",
      id: "you-brain",
      section: "account",
      q: null,
    });
    expect(parseAppLocation("/panel")).toEqual({ pathname: "/panel", id: null, section: "account", q: null });
  });

  test("settings and search links keep unknown sections on account", () => {
    expect(settingsHref("model")).toBe("/settings?section=model");
    expect(settingsHref()).toBe("/settings?section=account");
    expect(parseAppLocation("/settings?section=appearance").section).toBe("appearance");
    expect(parseAppLocation("/settings?section=nope").section).toBe("account");
    expect(parseAppLocation("/settings").section).toBe("account");
    expect(searchHref("京都 夜")).toBe("/search?q=%E4%BA%AC%E9%83%BD%20%E5%A4%9C");
    expect(parseAppLocation("/search?q=hello").q).toBe("hello");
    expect(parseAppLocation("/search?q=%20").q).toBe(null);
    expect(parseAppLocation("/search").q).toBe(null);
    expect(readQuery("/_design?open=palette&pq=话题", "open")).toBe("palette");
    expect(readQuery("/_design?open=palette&pq=话题", "pq")).toBe("话题");
    expect(readQuery("/today", "open")).toBe(null);
  });

  test("builds topic links and does not mark history as the active shelf", () => {
    expect(topicHref("active", "a b")).toBe("/topics?id=a%20b");
    expect(topicHref("history")).toBe("/topics/history");
    expect(isNavActive("/topics/history", "/topics")).toBe(false);
    expect(isNavActive("/topics", "/topics")).toBe(true);
    expect(isNavActive("/status", "/status")).toBe(true);
    expect(isPrimaryNavActive("/topics/history", "/topics")).toBe(true);
    expect(isPrimaryNavActive("/topics", "/topics")).toBe(true);
    expect(isPrimaryNavActive("/today", "/topics")).toBe(false);
    expect(isPrimaryNavActive("/status", "/status")).toBe(true);
  });
});

describe("quitShell", () => {
  test("asks the shell to quit when the command exists", async () => {
    const calls: string[] = [];
    const mode = await quitShell({
      invoke: (command) => {
        calls.push(command);
        return Promise.resolve(undefined);
      },
      open: () => null,
      pageUrl: "http://127.0.0.1:4731/panel",
      close: () => {
        throw new Error("should not close");
      },
    });
    expect(mode).toBe("invoked");
    expect(calls).toEqual(["quit"]);
  });

  test("closes the window when the shell has no quit command", async () => {
    let closed = false;
    const mode = await quitShell({
      invoke: () => Promise.reject(new Error("missing")),
      open: () => null,
      pageUrl: "http://127.0.0.1:4731/panel",
      close: () => {
        closed = true;
      },
    });
    expect(mode).toBe("closed");
    expect(closed).toBe(true);
  });
});

describe("openFullWindow", () => {
  test("asks the Tauri shell when it is present", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const mode = await openFullWindow({
      invoke: (command, args) => {
        calls.push([command, args]);
        return Promise.resolve(undefined);
      },
      open: () => null,
      pageUrl: "http://127.0.0.1:4731/panel",
    });
    expect(mode).toBe("tauri");
    expect(calls).toEqual([["open_main_window", { path: "/" }]]);
  });

  test("opens the full window in the browser otherwise", async () => {
    let opened = "";
    const mode = await openFullWindow({
      open: (url) => {
        opened = url;
        return {} as Window;
      },
      pageUrl: "http://127.0.0.1:4731/panel",
    });
    expect(mode).toBe("browser");
    expect(opened).toBe("http://127.0.0.1:4731/");
  });

  test("reports a blocked popup", async () => {
    const mode = await openFullWindow({
      open: () => null,
      pageUrl: "http://127.0.0.1:4731/panel",
    });
    expect(mode).toBe("blocked");
  });
});
