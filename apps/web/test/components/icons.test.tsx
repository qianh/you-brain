import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BrandMark } from "../../src/components/icons.js";

describe("BrandMark", () => {
  test("draws the Lucide brain and two thought dots", () => {
    const html = renderToStaticMarkup(<BrandMark size={20} />);
    expect(html).toContain("M12 18V5");
    expect(html).toContain("M17.996 5.125a4 4 0 012.526 5.77");
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('cx="19.4"');
    expect(html).toContain('cx="21.9"');
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain("M9.64 22.2");
    expect(html).not.toContain('cx="15.2"');
  });
});
