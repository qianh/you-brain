import { describe, expect, test } from "bun:test";

import { openLocalPath, parseLocalPath } from "../../src/lib/local-path";

describe("parseLocalPath", () => {
  test("file:// 与绝对路径都还原成解码后的路径", () => {
    expect(parseLocalPath("file:///Users/hong/Dzg/ai/dzg-ai-tools/docs/features/contract-compare-benchmark-2026-11-06.html")).toBe(
      "/Users/hong/Dzg/ai/dzg-ai-tools/docs/features/contract-compare-benchmark-2026-11-06.html",
    );
    expect(parseLocalPath("file:///Users/hong/%E6%96%87%E6%A1%A3/a.pdf")).toBe("/Users/hong/文档/a.pdf");
    expect(parseLocalPath("/Users/hong/a.html")).toBe("/Users/hong/a.html");
    expect(parseLocalPath("~/a.html")).toBe("~/a.html");
  });
  test("网址、单段路径、多行文字不算本地路径", () => {
    expect(parseLocalPath("https://example.com/a")).toBeNull();
    expect(parseLocalPath("/api")).toBeNull();
    expect(parseLocalPath("a.html")).toBeNull();
    expect(parseLocalPath("/Users/a\n/Users/b")).toBeNull();
  });
});

describe("openLocalPath", () => {
  test("桌面端调用 open_local_path,浏览器端返回 unsupported", async () => {
    const calls: unknown[][] = [];
    const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      calls.push([command, args]);
      return undefined;
    };
    expect(await openLocalPath({ invoke }, "/Users/a/b.html")).toBe("opened");
    expect(calls).toEqual([["open_local_path", { path: "/Users/a/b.html" }]]);
    expect(await openLocalPath({}, "/Users/a/b.html")).toBe("unsupported");
  });
});
