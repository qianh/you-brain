import { describe, expect, test } from "bun:test";

import { isNavActive, parseAppLocation, topicHref } from "../../src/lib/route.js";
import { openFullWindow } from "../../src/lib/window.js";

describe("routes", () => {
  test("reads the topic id and trims a trailing slash", () => {
    expect(parseAppLocation("/topics/history/?id=you-brain")).toEqual({
      pathname: "/topics/history",
      id: "you-brain",
    });
    expect(parseAppLocation("/panel")).toEqual({ pathname: "/panel", id: null });
  });

  test("builds topic links and does not mark history as the active shelf", () => {
    expect(topicHref("active", "a b")).toBe("/topics?id=a%20b");
    expect(topicHref("history")).toBe("/topics/history");
    expect(isNavActive("/topics/history", "/topics")).toBe(false);
    expect(isNavActive("/topics", "/topics")).toBe(true);
    expect(isNavActive("/status", "/status")).toBe(true);
  });
});

describe("openFullWindow", () => {
  test("asks the Tauri shell when it is present", async () => {
    const calls: string[] = [];
    const mode = await openFullWindow({
      invoke: (command) => {
        calls.push(command);
        return Promise.resolve(undefined);
      },
      open: () => null,
      pageUrl: "http://127.0.0.1:4731/panel",
    });
    expect(mode).toBe("tauri");
    expect(calls).toEqual(["open_main_window"]);
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
