import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  installYouBrainSkills,
  uninstallYouBrainSkills,
} from "../../src/clients/skills.js";

describe("owned you-brain skills", () => {
  it("removes only owned files and keeps a local edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-skills-"));
    await installYouBrainSkills("codex", root);
    const names = await readdir(join(root, ".codex", "skills"));
    expect(names.sort()).toEqual(["you-brain", "you-brain-portrait"]);
    await writeFile(join(root, ".codex/skills/you-brain/notes.md"), "keep");
    await writeFile(join(root, ".codex/skills/you-brain-portrait/SKILL.md"), "edited");
    await uninstallYouBrainSkills("codex", root);
    expect(await readdir(join(root, ".codex/skills/you-brain"))).toEqual(["notes.md"]);
    expect(await readFile(join(root, ".codex/skills/you-brain-portrait/SKILL.md"), "utf8")).toBe(
      "edited",
    );
  });

  it("does not replace a skill directory the user already created", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-skills-"));
    const dir = join(root, ".codex/skills/you-brain");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "existing");
    await installYouBrainSkills("codex", root);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("existing");
    await uninstallYouBrainSkills("codex", root);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("existing");
  });
});
