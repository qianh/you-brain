import { describe, expect, test } from "bun:test";
import { createElement } from "react";

import { nextIndex, typeaheadIndex } from "../../src/lib/list-nav.js";
import { optionsFromChildren } from "../../src/components/select.js";

describe("nextIndex", () => {
  test("wraps and treats an empty highlight as the first or last row", () => {
    expect(nextIndex(-1, 3, "ArrowDown")).toBe(0);
    expect(nextIndex(-1, 3, "ArrowUp")).toBe(2);
    expect(nextIndex(2, 3, "ArrowDown")).toBe(0);
    expect(nextIndex(0, 3, "ArrowUp")).toBe(2);
    expect(nextIndex(1, 3, "Home")).toBe(0);
    expect(nextIndex(0, 3, "End")).toBe(2);
    expect(nextIndex(0, 0, "ArrowDown")).toBe(-1);
  });
});

describe("typeaheadIndex", () => {
  test("matches a prefix and wraps once", () => {
    const labels = ["Alpha", "beta", "Alpine"];
    expect(typeaheadIndex(labels, "al", 0)).toBe(0);
    expect(typeaheadIndex(labels, "al", 1)).toBe(2);
    expect(typeaheadIndex(labels, "al", 3)).toBe(0);
    expect(typeaheadIndex(labels, "z", 0)).toBe(-1);
    expect(typeaheadIndex([], "a", 0)).toBe(-1);
  });
});

describe("optionsFromChildren", () => {
  test("reads options and groups", () => {
    const node = createElement(
      "optgroup",
      { label: "对话" },
      createElement("option", { value: "claude-code" }, "Claude"),
      createElement("option", { value: "codex", disabled: true }, "Codex"),
    );
    expect(optionsFromChildren(node)).toEqual([
      { value: "claude-code", label: "Claude", disabled: false, group: "对话" },
      { value: "codex", label: "Codex", disabled: true, group: "对话" },
    ]);
  });
});
