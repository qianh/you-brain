import { describe, expect, test } from "bun:test";

import {
  clockTime,
  countSessionsByTopic,
  PANEL_TOPIC_LIMIT,
  panelShortcut,
  panelTopicSlice,
  recentTopics,
  takeWithRest,
  topicDotClass,
} from "../../src/pages/panel/model.js";
import { openAppPath } from "../../src/pages/panel/open.js";

describe("recentTopics", () => {
  test("keeps the three most recently active topics", () => {
    const topics = recentTopics(
      [
        { topicId: "a", name: "甲", lastActive: "2026-10-21T10:00:00+08:00", status: "active" },
        { topicId: "b", name: "乙", lastActive: "2026-10-21T12:00:00+08:00", status: "done" },
        { topicId: "c", name: "丙", lastActive: "2026-10-21T08:00:00+08:00", status: "parked" },
        { topicId: "d", name: "丁", lastActive: "2026-10-21T12:00:00+08:00", status: "follow_up" },
      ],
      3,
    );
    expect(topics.map((topic) => topic.topicId)).toEqual(["d", "b", "a"]);
  });
});

describe("countSessionsByTopic", () => {
  test("skips sessions without a topic", () => {
    const counts = countSessionsByTopic([
      { topicId: "a" },
      { topicId: "a" },
      { topicId: null },
    ]);
    expect(counts.get("a")).toBe(2);
    expect(counts.has("null")).toBe(false);
  });
});

describe("panelTopicSlice", () => {
  test("shows three topics and counts the rest", () => {
    const slice = panelTopicSlice(
      [
        { topicId: "long", name: "dzg-hl-platform-front WebSocket 连接失败", lastActive: "2026-10-22T16:00:00+08:00" },
        { topicId: "a", name: "甲", lastActive: "2026-10-22T12:00:00+08:00" },
        { topicId: "b", name: "乙", lastActive: "2026-10-22T09:00:00+08:00" },
        { topicId: "c", name: "丙", lastActive: "2026-08-02T10:00:00+08:00" },
        { topicId: "d", name: "丁", lastActive: "2026-05-01T18:00:00+08:00" },
      ],
      PANEL_TOPIC_LIMIT,
    );
    expect(slice.visible.map((topic) => topic.topicId)).toEqual(["long", "a", "b"]);
    expect(slice.rest).toBe(2);
    expect(slice.total).toBe(5);
    expect(panelTopicSlice([{ topicId: "only", name: "仅此", lastActive: null }])).toEqual({
      visible: [{ topicId: "only", name: "仅此", lastActive: null }],
      rest: 0,
      total: 1,
    });
  });
});

describe("takeWithRest", () => {
  test("caps the visible slice", () => {
    expect(takeWithRest(["a", "b", "c"], 2)).toEqual({ visible: ["a", "b"], rest: 1 });
    expect(takeWithRest(["a"], 0)).toEqual({ visible: [], rest: 1 });
  });
});

describe("clockTime", () => {
  test("formats the local clock and a dash when missing", () => {
    expect(clockTime("2026-10-21T16:05:00+08:00", "Asia/Shanghai")).toBe("16:05");
    expect(clockTime(null, "Asia/Shanghai")).toBe("—");
    expect(clockTime("", "Asia/Shanghai")).toBe("—");
    expect(clockTime("nope", "Asia/Shanghai")).toBe("—");
  });
});

describe("topicDotClass", () => {
  test("maps topic status onto a dot", () => {
    expect(topicDotClass("active")).toBe("dot-ok");
    expect(topicDotClass("follow_up")).toBe("dot-warn");
    expect(topicDotClass("done")).toBe("dot-accent");
    expect(topicDotClass("parked")).toBe("dot-muted");
  });
});

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
  test("asks the Tauri shell and ignores the path there", async () => {
    const calls: string[] = [];
    let opened = false;
    const mode = await openAppPath(
      {
        invoke: (command) => {
          calls.push(command);
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
    expect(calls).toEqual(["open_main_window"]);
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
