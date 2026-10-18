import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { mergeClaudeDesktopConfig } from "../../src/clients/mcp-config.js";
import { ClientRegistry, launchWithConfig } from "../../src/clients/registry.js";
import { installLocalIntegrations } from "../../src/clients/auto-install.js";

describe("MCP client registration", () => {
  it("preserves a custom config path on the launch command", () => {
    expect(
      launchWithConfig({ command: "you-brain", args: ["mcp"] }, "/custom/config.toml"),
    ).toEqual({
      command: "you-brain",
      args: ["mcp", "--config", "/custom/config.toml"],
    });
  });

  it("merges Cursor config in a temp home and removes only you-brain", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-cursor-"));
    await mkdir(join(root, ".cursor"));
    const path = join(root, ".cursor", "mcp.json");
    const original = { mcpServers: { other: { command: "other" } }, custom: true };
    await writeFile(path, JSON.stringify(original));
    const registry = new ClientRegistry({
      homeDir: root,
      launch: { command: "you-brain", args: ["mcp"] },
      run: async () => {
        throw new Error("CLI not installed");
      },
    });
    await expect(registry.status("cursor")).resolves.toEqual({
      available: true,
      registered: false,
    });
    await registry.mutate("cursor", "install");
    const installed = JSON.parse(await readFile(path, "utf8")) as {
      custom: boolean;
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(installed.custom).toBe(true);
    expect(installed.mcpServers.other).toEqual({ command: "other" });
    expect(installed.mcpServers["you-brain"]).toEqual({
      command: "you-brain",
      args: ["mcp"],
    });
    await registry.mutate("cursor", "uninstall");
    const removed = JSON.parse(await readFile(path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(removed.mcpServers["you-brain"]).toBeUndefined();
    expect(removed.mcpServers.other).toEqual({ command: "other" });
  });

  it("does not replace malformed JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-cursor-"));
    await mkdir(join(root, ".cursor"));
    const path = join(root, ".cursor", "mcp.json");
    await writeFile(path, '{"mcpServers": []}');
    const registry = new ClientRegistry({ homeDir: root });
    await expect(registry.mutate("cursor", "install")).rejects.toThrow(/mcpServers/);
    expect(await readFile(path, "utf8")).toBe('{"mcpServers": []}');
  });

  it("does not overwrite a malformed Claude Desktop config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-desktop-"));
    const path = join(directory, "claude_desktop_config.json");
    await writeFile(path, '{"mcpServers":');
    await expect(
      mergeClaudeDesktopConfig(path, { command: "you-brain", args: ["mcp"] }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe('{"mcpServers":');
  });

  it("installs skills for a detected directory and isolates a broken client", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-auto-"));
    await mkdir(join(root, ".claude"));
    await mkdir(join(root, ".cursor"));
    await writeFile(join(root, ".cursor", "mcp.json"), "broken");
    const result = await installLocalIntegrations({
      homeDir: root,
      managedStatePath: join(root, "state.json"),
      run: async () => {
        throw new Error("not installed");
      },
    });
    expect(result.installed).toContain("claude-code");
    expect(result.warnings.join(" ")).toContain("cursor");
    expect(
      await readFile(join(root, ".claude/skills/you-brain/SKILL.md"), "utf8"),
    ).toContain("name: you-brain");
    expect(await readFile(join(root, ".cursor/mcp.json"), "utf8")).toBe("broken");
  });

  it("backfills skills without adding MCP when the CLI already lists you-brain", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-auto-"));
    const calls: string[][] = [];
    await installLocalIntegrations({
      homeDir: root,
      managedStatePath: join(root, "state.json"),
      run: async (command, args) => {
        calls.push([command, ...args]);
        return {
          exitCode: command === "codex" ? 0 : 1,
          stdout: command === "codex" ? "you-brain --config /custom/config.toml" : "",
        };
      },
    });
    expect(
      await readFile(join(root, ".codex/skills/you-brain-portrait/SKILL.md"), "utf8"),
    ).toContain("you-brain-portrait");
    expect(calls).toContainEqual(["codex", "mcp", "list"]);
    expect(calls.some((call) => call.includes("add"))).toBe(false);
    await expect(readFile(join(root, ".codex/config.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
