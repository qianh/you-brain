import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Banner } from "../../src/components/banner.js";
import { Button } from "../../src/components/button.js";

describe("Banner", () => {
  test("keeps the action beside the text by default", () => {
    const html = renderToStaticMarkup(
      <Banner tone="info" action={<Button size="sm">确定</Button>}>
        正文
      </Banner>,
    );
    expect(html).toContain('class="banner info"');
    expect(html).not.toContain("actions-below");
    expect(html).toContain("banner-actions");
  });

  test("moves the action row below the text with actionBelow", () => {
    const html = renderToStaticMarkup(
      <Banner tone="info" action={<Button size="sm">确定</Button>} actionBelow>
        正文
      </Banner>,
    );
    expect(html).toContain("banner info actions-below");
    expect(html).toContain("banner-actions");
  });

  test("ignores actionBelow without an action or dismiss", () => {
    const html = renderToStaticMarkup(<Banner tone="info" actionBelow>正文</Banner>);
    expect(html).not.toContain("actions-below");
  });
});
