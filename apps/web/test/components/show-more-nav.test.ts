import { describe, expect, test } from "bun:test";

import {
  collapseFocusTarget,
  firstRevealedIndex,
  rowsBeforeToggle,
  shownCount,
  toggleAnchorIndex,
} from "../../src/components/show-more-nav.js";
import { nextIndex, type ListKey } from "../../src/lib/list-nav.js";

const FOLLOWING = 4;

function step(current: number, count: number, key: ListKey): number {
  return nextIndex(current, count, key);
}

describe("show more keyboard", () => {
  test("expand mounts every row and names the first one that was folded", () => {
    expect(shownCount(8, 5, false)).toBe(5);
    expect(shownCount(8, 5, true)).toBe(8);
    expect(shownCount(3, 5, false)).toBe(3);
    expect(firstRevealedIndex(5, 8)).toBe(5);
    expect(firstRevealedIndex(5, 5)).toBe(null);
    expect(firstRevealedIndex(5, 2)).toBe(null);
  });

  test("arrow keys from the last always-visible row walk every revealed row", () => {
    const total = shownCount(8, 5, true);
    let index = 4;
    const visited: number[] = [];
    for (let n = 0; n < 3; n += 1) {
      index = step(index, total, "ArrowDown");
      visited.push(index);
    }
    expect(visited).toEqual([5, 6, 7]);
    expect(step(7, total, "ArrowUp")).toBe(6);
    expect(step(5, total, "ArrowUp")).toBe(4);
  });

  test("the toggle sits between the rows before it and the rows after it", () => {
    const flags = [FOLLOWING, FOLLOWING, FOLLOWING, FOLLOWING, FOLLOWING, FOLLOWING, FOLLOWING, FOLLOWING, 0];
    const before = rowsBeforeToggle(flags, FOLLOWING);
    expect(before).toBe(8);
    const count = flags.length;
    expect(step(toggleAnchorIndex(before, "ArrowUp"), count, "ArrowUp")).toBe(7);
    expect(step(toggleAnchorIndex(before, "ArrowDown"), count, "ArrowDown")).toBe(8);
    expect(step(toggleAnchorIndex(before, "Home"), count, "Home")).toBe(0);
    expect(step(toggleAnchorIndex(before, "End"), count, "End")).toBe(count - 1);
  });

  test("a toggle with no row after it wraps down to the start and up into the last revealed row", () => {
    const before = rowsBeforeToggle([FOLLOWING, FOLLOWING, FOLLOWING, FOLLOWING, FOLLOWING, FOLLOWING], FOLLOWING);
    expect(step(toggleAnchorIndex(before, "ArrowUp"), 6, "ArrowUp")).toBe(5);
    expect(step(toggleAnchorIndex(before, "ArrowDown"), 6, "ArrowDown")).toBe(0);
    expect(step(toggleAnchorIndex(0, "ArrowDown"), 4, "ArrowDown")).toBe(0);
    expect(step(toggleAnchorIndex(0, "ArrowUp"), 4, "ArrowUp")).toBe(3);
  });

  test("collapsing moves focus to the toggle only when it sits in a row that will unmount", () => {
    expect(collapseFocusTarget(5, 5)).toBe("toggle");
    expect(collapseFocusTarget(7, 5)).toBe("toggle");
    expect(collapseFocusTarget(4, 5)).toBe("keep");
    expect(collapseFocusTarget(0, 5)).toBe("keep");
    expect(collapseFocusTarget(-1, 5)).toBe("keep");
    expect(collapseFocusTarget(Number.NaN, 5)).toBe("keep");
  });
});
