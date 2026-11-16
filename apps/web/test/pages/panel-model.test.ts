import { describe, expect, test } from "bun:test";

import { panelShortcut } from "../../src/pages/panel/model.js";
import { openAppPath } from "../../src/pages/panel/open.js";

describe("panelShortcut", () => {
  const base = { meta: false, ctrl: false, alt: false, shift: false, targetIsText: false };

  test("maps escape, open, and refresh", () => {
    expect(panelShortcut({ ...base, key: "Escape" }, "meta")).toBe("close");
    expect(panelShortcut({ ...base, key: "Escape", meta: true }, "meta")).toBe(null);
    expect(panelShortcut({ ...base, key: "o", meta: true }, "meta")).toBe("open");
    expect(panelShortcut({ ...base, key: "R", meta: true }, "meta")).toBe("refresh");
    expect(panelShortcut({ ...base, key: "r", ctrl: true }, "meta")).toBe(null);
    expect(panelShortcut({ ...base, key: "r", ctrl: true }, "ctrl")).toBe("refresh");
    expect(panelShortcut({ ...base, key: "r", meta: true, shift: true }, "meta")).toBe(null);
    expect(panelShortcut({ ...base, key: "o", meta: true, alt: true }, "meta")).toBe(null);
    expect(panelShortcut({ ...base, key: "k", meta: true }, "meta")).toBe(null);
  });
});

describe("openAppPath", () => {
  test("asks the Tauri shell to open that path", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    let opened = false;
    const mode = await openAppPath(
      {
        invoke: (command, args) => {
          calls.push([command, args]);
          return Promise.resolve(undefined);
        },
        open: () => {
          opened = true;
          return null;
        },
        pageUrl: "http://127.0.0.1:4802/panel",
      },
      "/settings?section=account",
    );
    expect(mode).toBe("tauri");
    expect(calls).toEqual([["open_main_window", { path: "/settings?section=account" }]]);
    expect(opened).toBe(false);
  });

  test("opens the requested path in the browser", async () => {
    let href = "http://127.0.0.1:4802/panel";
    let target = "";
    const location = {
      get href() {
        return href;
      },
      set href(value: string) {
        href = value;
      },
    };
    const mode = await openAppPath(
      {
        open: (url, name) => {
          target = `${name} ${url}`;
          return { location } as Window;
        },
        pageUrl: "http://127.0.0.1:4802/panel",
      },
      "/settings?section=account",
    );
    expect(mode).toBe("browser");
    expect(target).toBe("you-brain-main http://127.0.0.1:4802/settings?section=account");
    expect(href).toBe("http://127.0.0.1:4802/settings?section=account");
  });

  test("leaves a window that is already on that url", async () => {
    let writes = 0;
    const mode = await openAppPath(
      {
        open: () =>
          ({
            location: {
              get href() {
                return "http://127.0.0.1:4802/today";
              },
              set href(_: string) {
                writes += 1;
              },
            },
          }) as Window,
        pageUrl: "http://127.0.0.1:4802/panel",
      },
      "/today",
    );
    expect(mode).toBe("browser");
    expect(writes).toBe(0);
  });

  test("accepts a window handle without a location", async () => {
    const mode = await openAppPath(
      {
        open: () => ({}) as Window,
        pageUrl: "http://127.0.0.1:4802/panel",
      },
      "/today",
    );
    expect(mode).toBe("browser");
  });

  test("reports a blocked popup", async () => {
    const mode = await openAppPath(
      {
        open: () => null,
        pageUrl: "http://127.0.0.1:4802/panel",
      },
      "/today",
    );
    expect(mode).toBe("blocked");
  });
});
