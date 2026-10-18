import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

import { platformPaths } from "@you-brain/core";
import { PROTOCOL_VERSION } from "@you-brain/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(here, "../package.json"), "utf8"),
) as { version: string };

describe("you-brain cli", () => {
  it("prints the package version", () => {
    const result = spawnSync(
      process.execPath,
      [join(here, "../src/index.ts"), "--version"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("links the core and protocol workspaces", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(
      platformPaths({
        platform: "darwin",
        homeDir: "/Users/test",
        env: {},
      }).dataDir,
    ).toBe("/Users/test/Library/Application Support/you-brain");
  });
});
