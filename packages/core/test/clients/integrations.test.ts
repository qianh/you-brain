import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { CODING_PORTRAIT_INSTRUCTION } from "../../src/clients/catalog.js";
import {
  applyClientIntegrations,
  planClientIntegrations,
  planClientUninstall,
} from "../../src/clients/integrations.js";
import { clientMutation } from "../../src/clients/registry.js";
import {
  YOU_BRAIN_PORTRAIT_SKILL,
  YOU_BRAIN_SKILL,
} from "../../src/clients/skill-content.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "you-brain-clients-"));
}

describe("client integrations", () => {
  it("plans file diffs and applies only the checked items", async () => {
    const root = await home();
    await import("node:fs/promises").then(({ mkdir }) =>
      Promise.all([
        mkdir(join(root, ".claude")),
        mkdir(join(root, ".codex")),
        mkdir(join(root, ".cursor")),
        mkdir(join(root, ".gemini")),
        mkdir(join(root, ".grok")),
      ]),
    );
    await writeFile(join(root, ".codex", "AGENTS.md"), "# mine\n");
    await writeFile(
      join(root, ".cursor", "mcp.json"),
      `${JSON.stringify({ mcpServers: { other: { command: "other" } }, custom: true }, null, 2)}\n`,
    );
    const statePath = join(root, "managed.json");
    const plan = await planClientIntegrations({
      homeDir: root,
      managedStatePath: statePath,
      run: async () => {
        throw new Error("real CLI must not run");
      },
    });
    const claudePortrait = plan.items.find((item) => item.id === "claude-code:portrait");
    const codexPortrait = plan.items.find((item) => item.id === "codex:portrait");
    const cursorPortrait = plan.items.find((item) => item.id === "cursor:portrait");
    const cursorMcp = plan.items.find((item) => item.id === "cursor:mcp");
    expect(claudePortrait?.preview).toContain("@~/.you-brain/portrait/coding.md");
    expect(claudePortrait?.path).toBe(join(root, ".claude", "CLAUDE.md"));
    expect(codexPortrait?.preview).toContain(CODING_PORTRAIT_INSTRUCTION);
    expect(cursorPortrait?.action).toBe("copy");
    expect(cursorPortrait?.copyText).toContain(CODING_PORTRAIT_INSTRUCTION);
    expect(cursorPortrait?.path).toBeUndefined();
    expect(cursorMcp?.preview).toContain("+");
    expect(cursorMcp?.preview).toContain("you-brain");

    await applyClientIntegrations({
      homeDir: root,
      plan,
      selectedIds: ["claude-code:portrait", "cursor:mcp"],
      managedStatePath: statePath,
    });
    expect(await readFile(join(root, ".claude", "CLAUDE.md"), "utf8")).toContain(
      "@~/.you-brain/portrait/coding.md",
    );
    const cursor = JSON.parse(await readFile(join(root, ".cursor", "mcp.json"), "utf8")) as {
      custom: boolean;
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(cursor.custom).toBe(true);
    expect(cursor.mcpServers.other).toEqual({ command: "other" });
    expect(cursor.mcpServers["you-brain"]).toEqual({
      command: "you-brain",
      args: ["mcp"],
    });
    await expect(stat(join(root, ".codex", "config.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, ".codex", "AGENTS.md"), "utf8")).toBe("# mine\n");
  });

  it("skips a Grok instruction file that would pass 10000 characters", async () => {
    const root = await home();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".grok"));
    await writeFile(join(root, ".grok", "AGENTS.md"), "x".repeat(9_900));
    const plan = await planClientIntegrations({
      homeDir: root,
      managedStatePath: join(root, "state.json"),
      clients: ["grok-build"],
    });
    const portrait = plan.items.find((item) => item.id === "grok-build:portrait");
    expect(portrait?.action).toBe("skipped");
    expect(portrait?.warning).toContain("10000");
    await applyClientIntegrations({
      homeDir: root,
      plan,
      selectedIds: [portrait?.id ?? ""],
      managedStatePath: join(root, "state.json"),
    });
    expect(await readFile(join(root, ".grok", "AGENTS.md"), "utf8")).toBe("x".repeat(9_900));
  });

  it("uninstall removes only you-brain content and a file we created", async () => {
    const root = await home();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".gemini"));
    const statePath = join(root, "state.json");
    const plan = await planClientIntegrations({
      homeDir: root,
      managedStatePath: statePath,
      clients: ["gemini-cli"],
    });
    await applyClientIntegrations({
      homeDir: root,
      plan,
      selectedIds: plan.items
        .filter((item) => item.action === "create")
        .map((item) => item.id),
      managedStatePath: statePath,
    });
    expect(await readFile(join(root, ".gemini", "GEMINI.md"), "utf8")).toContain(
      "you-brain:start",
    );
    const uninstall = await planClientUninstall({
      homeDir: root,
      managedStatePath: statePath,
      clients: ["gemini-cli"],
    });
    await applyClientIntegrations({
      homeDir: root,
      plan: uninstall,
      selectedIds: uninstall.items.map((item) => item.id),
      managedStatePath: statePath,
    });
    await expect(stat(join(root, ".gemini", "GEMINI.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const settings = JSON.parse(
      await readFile(join(root, ".gemini", "settings.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(settings.mcpServers["you-brain"]).toBeUndefined();
  });

  it("registers you-brain mcp rather than brainhub serve", () => {
    expect(
      clientMutation("claude-code", "install", { command: "you-brain", args: ["mcp"] }),
    ).toEqual({
      command: "claude",
      args: ["mcp", "add", "--scope", "user", "you-brain", "--", "you-brain", "mcp"],
    });
    expect(
      clientMutation("codex", "install", { command: "you-brain", args: ["mcp"] }).args,
    ).toEqual(["mcp", "add", "you-brain", "--", "you-brain", "mcp"]);
    expect(
      clientMutation("gemini-cli", "uninstall", { command: "you-brain", args: ["mcp"] }).args,
    ).toEqual(["mcp", "remove", "you-brain"]);
  });

  it("ships the same skill text that is installed for clients", async () => {
    const root = await home();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".codex"));
    const plan = await planClientIntegrations({
      homeDir: root,
      managedStatePath: join(root, "state.json"),
      clients: ["codex"],
    });
    await applyClientIntegrations({
      homeDir: root,
      plan,
      selectedIds: ["codex:skill:you-brain", "codex:skill:you-brain-portrait"],
      managedStatePath: join(root, "state.json"),
    });
    expect(await readFile(join(root, ".codex/skills/you-brain/SKILL.md"), "utf8")).toBe(
      YOU_BRAIN_SKILL,
    );
    expect(
      await readFile(join(root, ".codex/skills/you-brain-portrait/SKILL.md"), "utf8"),
    ).toBe(YOU_BRAIN_PORTRAIT_SKILL);
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
    expect(await readFile(join(repoRoot, "skills/you-brain/SKILL.md"), "utf8")).toBe(
      YOU_BRAIN_SKILL,
    );
    expect(
      await readFile(join(repoRoot, "skills/you-brain-portrait/SKILL.md"), "utf8"),
    ).toBe(YOU_BRAIN_PORTRAIT_SKILL);
  });
});
