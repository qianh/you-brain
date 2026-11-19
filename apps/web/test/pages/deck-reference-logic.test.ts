import { describe, expect, test } from "bun:test";
import type { ReferenceCandidateView } from "@you-brain/core/http/types.js";

import {
  flattenReferenceGroups,
  groupReferenceCandidates,
  isReferenceShortcut,
  moveReferenceSelection,
  writeClipboardDeferred,
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

describe("writeClipboardDeferred", () => {
  test("在调用时同步发起 write，文本稍后才到", async () => {
    let resolveText: (value: string) => void = () => undefined;
    const text = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const written: Array<Record<string, Promise<Blob>>> = [];
    let writeCalls = 0;
    const result = writeClipboardDeferred(
      text,
      {
        write: async () => {
          writeCalls += 1;
        },
        writeText: async () => {
          throw new Error("不应走 writeText");
        },
      },
      (data) => {
        written.push(data);
        return data as unknown as ClipboardItem;
      },
    );
    expect(writeCalls).toBe(1);
    resolveText("@/a.md ");
    expect(await result).toBe(true);
    expect(await (await written[0]!["text/plain"]!).text()).toBe("@/a.md ");
  });

  test("没有 ClipboardItem 时退回 writeText", async () => {
    const seen: string[] = [];
    const ok = await writeClipboardDeferred(
      Promise.resolve("@/b.md "),
      { writeText: async (value) => void seen.push(value) },
      null,
    );
    expect(ok).toBe(true);
    expect(seen).toEqual(["@/b.md "]);
  });

  test("写入被拒返回 false", async () => {
    const ok = await writeClipboardDeferred(
      Promise.resolve("x"),
      { write: async () => Promise.reject(new Error("NotAllowedError")), writeText: async () => undefined },
      (data) => data as unknown as ClipboardItem,
    );
    expect(ok).toBe(false);
  });
});
