import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { createCommandRunner } from "../../src/service/runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("command runner", () => {
  it("returns stdout from a real command", async () => {
    const result = await createCommandRunner().run("/bin/echo", ["ok"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  });

  it("returns 127 when the command does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-runner-"));
    roots.push(root);
    const missing = join(root, "you-brain-missing-command");
    const result = await createCommandRunner().run(missing, ["daemon"]);
    expect(result.code).toBe(127);
    expect(result.stdout).toBe("");
  });
});
