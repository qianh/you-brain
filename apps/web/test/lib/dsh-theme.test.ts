import { describe, expect, test } from "bun:test";

import { dshThemeMessage, isDshThemeRequest } from "../../src/lib/dsh-theme.js";

const URL_ = "http://127.0.0.1:4100/?token=x";
const frame = {} as Window;

describe("isDshThemeRequest", () => {
  test("接受当前 iframe 同源的主题请求", () => {
    expect(isDshThemeRequest({ source: frame, origin: "http://127.0.0.1:4100", data: { type: "u-brain:theme:request" } }, frame, URL_)).toBe(true);
  });

  test("拒绝别的窗口、别的源和其他消息", () => {
    expect(isDshThemeRequest({ source: {} as Window, origin: "http://127.0.0.1:4100", data: { type: "u-brain:theme:request" } }, frame, URL_)).toBe(false);
    expect(isDshThemeRequest({ source: frame, origin: "http://127.0.0.1:4101", data: { type: "u-brain:theme:request" } }, frame, URL_)).toBe(false);
    expect(isDshThemeRequest({ source: frame, origin: "http://127.0.0.1:4100", data: { type: "other" } }, frame, URL_)).toBe(false);
    expect(isDshThemeRequest({ source: frame, origin: "http://127.0.0.1:4100", data: { type: "u-brain:theme:request" } }, null, URL_)).toBe(false);
  });
});

test("dshThemeMessage", () => {
  expect(dshThemeMessage("dopamine")).toEqual({ type: "u-brain:theme", theme: "dopamine" });
});
