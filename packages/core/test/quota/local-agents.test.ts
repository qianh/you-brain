import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { detectLocalAgents } from "../../src/quota/local-agents.js";

describe("detectLocalAgents", () => {
  it("lists agents whose home directory exists, in the catalog's order", () => {
    const present = new Set([join("/home/u", ".kimi"), join("/home/u", ".claude"), join("/home/u", ".unknown")]);
    expect(detectLocalAgents("/home/u", (path) => present.has(path))).toEqual(["claude", "kimi"]);
  });

  it("is empty when nothing is installed", () => {
    expect(detectLocalAgents("/home/u", () => false)).toEqual([]);
  });
});
