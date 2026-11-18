import { describe, expect, test } from "bun:test";
import type { ReferenceCandidateView } from "@you-brain/core/http/types.js";

import {
  flattenReferenceGroups,
  groupReferenceCandidates,
  isReferenceShortcut,
  moveReferenceSelection,
} from "../../src/pages/deck-reference-logic.js";

function candidate(kind: ReferenceCandidateView["kind"], label: string): ReferenceCandidateView {
  return {
    kind,
    id: `${kind}-${label}`,
    uri: `u-brain-${kind}:${label}`,
    resourceUri: `you-brain://${kind}/${label}`,
    mention: `@[${label}](u-brain-${kind}:${label})`,
    label,
    detail: "",
  };
}

describe("deck reference logic", () => {
  test("groups candidates in tty7 -> session -> topic -> kb order and flattens consistently", () => {
    const raw = [
      candidate("kb", "手册"),
      candidate("topic", "架构"),
      candidate("tty7", "Codex"),
      candidate("session", "昨日回顾"),
      candidate("kb", "合同"),
    ];
    const groups = groupReferenceCandidates(raw);
    expect(groups.map((g) => g.kind)).toEqual(["tty7", "session", "topic", "kb"]);
    expect(groups[3]?.items.map((i) => i.label)).toEqual(["手册", "合同"]);
    expect(flattenReferenceGroups(groups).map((i) => i.label)).toEqual([
      "Codex",
      "昨日回顾",
      "架构",
      "手册",
      "合同",
    ]);
  });

  test("moves selection index with wraparound", () => {
    expect(moveReferenceSelection(-1, 3, 1)).toBe(0);
    expect(moveReferenceSelection(-1, 3, -1)).toBe(2);
    expect(moveReferenceSelection(2, 3, 1)).toBe(0);
    expect(moveReferenceSelection(0, 3, -1)).toBe(2);
    expect(moveReferenceSelection(0, 0, 1)).toBe(-1);
  });

  test("detects ⌘⇧2 / Ctrl+Shift+2 / @ shortcuts per platform", () => {
    const key = (k: string, extra: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
      key: k,
      meta: false,
      ctrl: false,
      alt: false,
      shift: false,
      ...extra,
    });
    expect(isReferenceShortcut(key("@", { meta: true, shift: true }), "meta")).toBe(true);
    expect(isReferenceShortcut(key("2", { meta: true, shift: true }), "meta")).toBe(true);
    expect(isReferenceShortcut(key("@", { ctrl: true, shift: true }), "ctrl")).toBe(true);
    expect(isReferenceShortcut(key("@", { meta: true, shift: true }), "ctrl")).toBe(false);
    expect(isReferenceShortcut(key("@", { shift: true }), "meta")).toBe(false);
    expect(isReferenceShortcut(key("2", { meta: true }), "meta")).toBe(false);
    expect(isReferenceShortcut(key("@", { meta: true, shift: true, alt: true }), "meta")).toBe(false);
  });
});
