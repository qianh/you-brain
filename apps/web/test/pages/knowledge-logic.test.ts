import { describe, expect, test } from "bun:test";

import {
  defaultPageId,
  flattenTree,
  fuzzyFilter,
  fuzzyScore,
  isProxyableAssetUrl,
  relativeTime,
} from "../../src/pages/knowledge/logic.js";

describe("knowledge logic", () => {
  const tree = [
    {
      id: "root",
      object: "page" as const,
      title: "工作区首页",
      icon: "🏠",
      children: [
        { id: "db", object: "database" as const, title: "任务表", icon: null, children: [] },
        { id: "child", object: "page" as const, title: "子页面", icon: null, children: [] },
      ],
    },
    { id: "solo", object: "page" as const, title: "独立页", icon: null, children: [] },
  ];

  test("flattenTree 按深度优先拍平", () => {
    const flat = flattenTree(tree);
    expect(flat.map((page) => page.id)).toEqual(["root", "db", "child", "solo"]);
    expect(flat[2]?.depth).toBe(1);
    expect(flat[1]?.object).toBe("database");
  });

  test("fuzzyScore:子序列、前缀与连续奖励", () => {
    expect(fuzzyScore("", "任意")).toBe(1);
    expect(fuzzyScore("任务", "任务表")).toBeGreaterThan(fuzzyScore("任务", "别的表"));
    expect(fuzzyScore("子页", "子页面")).toBeGreaterThan(0);
    expect(fuzzyScore("xyz", "子页面")).toBe(0);
    // 大小写不敏感
    expect(fuzzyScore("API", "API 设计")).toBeGreaterThan(100);
  });

  test("fuzzyFilter:空查询取前 N 个,有查询按分数排序", () => {
    const flat = flattenTree(tree);
    expect(fuzzyFilter(flat, "").map((page) => page.id)).toEqual(["root", "db", "child", "solo"]);
    const hits = fuzzyFilter(flat, "任务");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("db");
  });

  test("defaultPageId 取第一个根节点", () => {
    expect(defaultPageId(tree)).toBe("root");
    expect(defaultPageId([])).toBeNull();
  });

  test("isProxyableAssetUrl 只放行 Notion 自有域名", () => {
    expect(isProxyableAssetUrl("https://prod-files-secure.s3.us-west-2.amazonaws.com/a.png")).toBe(true);
    expect(isProxyableAssetUrl("https://www.notion.so/image/x")).toBe(true);
    expect(isProxyableAssetUrl("https://example.com/a.png")).toBe(false);
    expect(isProxyableAssetUrl("not a url")).toBe(false);
  });

  test("relativeTime 中文相对时间", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    expect(relativeTime("2026-10-29T11:59:50Z", now, "zh")).toBe("刚刚");
    expect(relativeTime("2026-10-29T11:00:00Z", now, "zh")).toBe("1 小时前");
    expect(relativeTime("2026-10-29T11:30:00Z", now, "zh")).toBe("30 分钟前");
    expect(relativeTime("2026-10-28T12:00:00Z", now, "zh")).toBe("1 天前");
    expect(relativeTime("2026-10-26T12:00:00Z", now, "zh")).toBe("3 天前");
    expect(relativeTime(null, now, "zh")).toBe("从未");
  });
});
