import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BrandMark } from "../../src/components/icons.js";

describe("BrandMark", () => {
  test("renders the app logo image at the requested size", () => {
    const html = renderToStaticMarkup(<BrandMark size={20} />);
    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
    expect(html).toContain('aria-hidden="true"');
  });
});
