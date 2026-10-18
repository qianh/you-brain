import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { YouBrainError } from "../domain/errors.js";
import type { CommandSpec } from "./catalog.js";
import { MCP_SERVER_NAME } from "./catalog.js";
import {
  readJsonProperty,
  removeJsonProperty,
  upsertJsonProperty,
} from "./json-edit.js";
import {
  removeTomlSection,
  renderTomlMcpServer,
  tomlHasSection,
  upsertTomlSection,
} from "./toml-edit.js";

export interface McpServerEntry {
  command: string;
  args: string[];
}

export function mcpEntry(launch: CommandSpec): McpServerEntry {
  return { command: launch.command, args: [...launch.args] };
}

export function isBrainHubServerName(name: string): boolean {
  const normalized = name.trim().toLowerCase().replaceAll("_", "-");
  return (
    normalized === "brainhub" ||
    normalized === "brain-hub" ||
    normalized === "brainhub-mcp" ||
    normalized === "brain-hub-mcp"
  );
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
}

export function jsonMcpServers(source: string | null): Record<string, unknown> {
  if (!source) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new YouBrainError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "Invalid JSON configuration",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("MCP configuration must be a JSON object");
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new TypeError("mcpServers must be a JSON object");
  }
  return servers as Record<string, unknown>;
}

export function previewJsonMcp(
  source: string | null,
  serverName: string,
  entry: McpServerEntry | null,
): string {
  const current = source ?? "";
  if (entry === null) {
    if (!current.trim()) return current;
    return removeJsonProperty(current, "mcpServers", serverName);
  }
  return upsertJsonProperty(current, "mcpServers", serverName, entry);
}

export async function writeJsonMcp(options: {
  path: string;
  serverName?: string;
  entry: McpServerEntry | null;
}): Promise<void> {
  const serverName = options.serverName ?? MCP_SERVER_NAME;
  const current = await readTextIfPresent(options.path);
  const next =
    options.entry === null
      ? removeJsonProperty(current ?? "{}\n", "mcpServers", serverName)
      : previewJsonMcp(current, serverName, options.entry);
  if (next === (current ?? "")) return;
  await writeText(options.path, next.endsWith("\n") ? next : `${next}\n`);
}

export function jsonHasServer(source: string | null, serverName: string): boolean {
  if (!source) return false;
  return readJsonProperty(source, "mcpServers", serverName) !== undefined;
}

export function previewTomlMcp(
  source: string | null,
  serverName: string,
  entry: McpServerEntry | null,
): string {
  const current = source ?? "";
  if (entry === null) return removeTomlSection(current, "mcp_servers", serverName);
  return upsertTomlSection(
    current,
    "mcp_servers",
    serverName,
    renderTomlMcpServer({
      name: serverName,
      command: entry.command,
      args: entry.args,
    }),
  );
}

export function tomlHasServer(source: string | null, serverName: string): boolean {
  if (!source) return false;
  return tomlHasSection(source, "mcp_servers", serverName);
}

export async function writeTomlMcp(options: {
  path: string;
  serverName?: string;
  entry: McpServerEntry | null;
}): Promise<void> {
  const serverName = options.serverName ?? MCP_SERVER_NAME;
  const current = await readTextIfPresent(options.path);
  const next = previewTomlMcp(current, serverName, options.entry);
  if (next === (current ?? "")) return;
  await writeText(options.path, next);
}

export function brainHubServerNames(source: string, format: "json" | "toml"): string[] {
  if (format === "json") {
    return Object.keys(jsonMcpServers(source)).filter(isBrainHubServerName);
  }
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const match = /^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\].]+))/u.exec(line);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name && isBrainHubServerName(name)) names.add(name);
  }
  return [...names];
}

export async function mergeClaudeDesktopConfig(
  path: string,
  launch: CommandSpec,
): Promise<string> {
  const source = await readTextIfPresent(path);
  if (source !== null) {
    JSON.parse(source);
    const backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
    await copyFile(path, backup);
  }
  const next = previewJsonMcp(source, MCP_SERVER_NAME, mcpEntry(launch));
  await writeText(path, next.endsWith("\n") ? next : `${next}\n`);
  return path;
}
