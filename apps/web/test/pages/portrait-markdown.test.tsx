import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PortraitMarkdown } from "../../src/pages/portrait/markdown-view.js";

describe("PortraitMarkdown", () => {
  test("escapes raw HTML and refuses javascript and data links", () => {
    const html = renderToStaticMarkup(
      <PortraitMarkdown
        source={[
          "# 标题",
          "",
          "<script>alert(1)</script>",
          "",
          "[点我](javascript:alert(1))",
          "",
          "[数据](data:text/html,<script>alert(1)</script>)",
          "",
          "```html",
          "<script>alert(1)</script>",
          "```",
          "",
          "| 格 |",
          "| --- |",
          "| <img src=x onerror=alert(1)> |",
        ].join("\n")}
      />,
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain("<h1");
    expect(html).toContain("<table");
  });
});
