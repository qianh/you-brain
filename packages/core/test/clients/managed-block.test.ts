import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  hasManagedBlock,
  managedBlock,
  removeManagedBlock,
  upsertManagedBlock,
  upsertManagedBlockText,
} from "../../src/clients/managed-block.js";

describe("managed blocks", () => {
  it("replaces only the marked region and updates wording", async () => {
    const before = "# Notes\n\nkeep me\n\n<!-- you-brain:start v1 -->\nold words\n<!-- you-brain:end -->\n\n# Tail\n";
    const after = upsertManagedBlockText(before, "new words", "v1");
    expect(after).toContain("keep me");
    expect(after).toContain("# Tail");
    expect(after).toContain("new words");
    expect(after).not.toContain("old words");
    expect(hasManagedBlock(after)).toBe(true);
  });

  it("bumps the version marker when the block version changes", () => {
    const updated = upsertManagedBlockText(
      managedBlock("first"),
      "second",
      "v2",
    );
    expect(updated).toContain("<!-- you-brain:start v2 -->");
    expect(updated).toContain("second");
    expect(updated).not.toContain("first");
  });

  it("creates a missing file and deletes it again when the block was the whole file", async () => {
    const home = await mkdtemp(join(tmpdir(), "you-brain-block-"));
    const path = join(home, "AGENTS.md");
    const statePath = join(home, "ledger.json");
    await upsertManagedBlock({ path, body: "read the portrait", statePath });
    expect(await readFile(path, "utf8")).toContain("<!-- you-brain:start v1 -->");
    const removed = await removeManagedBlock({ path, statePath });
    expect(removed.deletedFile).toBe(true);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an originally empty file after the block is removed", async () => {
    const home = await mkdtemp(join(tmpdir(), "you-brain-block-"));
    const path = join(home, "CLAUDE.md");
    const statePath = join(home, "ledger.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "");
    await upsertManagedBlock({ path, body: "instruction", statePath });
    const removed = await removeManagedBlock({ path, statePath });
    expect(removed.deletedFile).toBe(false);
    expect(await readFile(path, "utf8")).toBe("");
  });

  it("leaves surrounding text in place", async () => {
    const home = await mkdtemp(join(tmpdir(), "you-brain-block-"));
    const path = join(home, "GEMINI.md");
    const statePath = join(home, "ledger.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "user rule\n");
    await upsertManagedBlock({ path, body: "instruction", statePath });
    await removeManagedBlock({ path, statePath });
    expect(await readFile(path, "utf8")).toContain("user rule");
    expect(await readFile(path, "utf8")).not.toContain("you-brain:start");
  });
});
