import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CaptureSourceId } from "@you-brain/protocol";

import {
  CLIENT_CATALOG,
  DEFAULT_MCP_LAUNCH,
  MCP_SERVER_NAME,
  portraitBody,
  type CommandSpec,
} from "./catalog.js";
import { previewDiff } from "./diff.js";
import {
  hasManagedBlock,
  managedBlock,
  removeManagedBlock,
  removeManagedBlockText,
  upsertManagedBlock,
  upsertManagedBlockText,
} from "./managed-block.js";
import {
  jsonHasServer,
  mcpEntry,
  previewJsonMcp,
  previewTomlMcp,
  readTextIfPresent,
  tomlHasServer,
  writeJsonMcp,
  writeTomlMcp,
  type McpServerEntry,
} from "./mcp-config.js";
import type { Runner } from "./registry.js";
import {
  YOU_BRAIN_SKILL_BODIES,
  YOU_BRAIN_SKILL_NAMES,
  type YouBrainSkillName,
} from "./skill-content.js";
import {
  installYouBrainSkill,
  uninstallYouBrainSkill,
  youBrainSkillOwned,
} from "./skills.js";

export type IntegrationKind = "mcp" | "portrait" | "skill";
export type IntegrationAction =
  | "create"
  | "update"
  | "remove"
  | "unchanged"
  | "copy"
  | "skipped";

export interface IntegrationPlanItem {
  id: string;
  client: CaptureSourceId;
  kind: IntegrationKind;
  action: IntegrationAction;
  path?: string;
  preview: string;
  copyText?: string;
  warning?: string;
  skillName?: YouBrainSkillName;
}

export interface IntegrationPlan {
  items: IntegrationPlanItem[];
}

export interface IntegrationPlanOptions {
  homeDir: string;
  launch?: CommandSpec;
  run?: Runner;
  managedStatePath: string;
  intent?: "install" | "uninstall";
  clients?: readonly CaptureSourceId[];
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function clientAvailable(
  entry: (typeof CLIENT_CATALOG)[number],
  homeDir: string,
  run: Runner | undefined,
): Promise<boolean> {
  if (await directoryExists(join(homeDir, entry.directory))) return true;
  if (!run) return false;
  try {
    const args = entry.id === "cursor" ? ["--version"] : ["mcp", "list"];
    return (await run(entry.bin, args)).exitCode === 0;
  } catch {
    return false;
  }
}

function mcpRegistered(source: string | null, format: "json" | "toml"): boolean {
  if (!source) return false;
  try {
    return format === "json"
      ? jsonHasServer(source, MCP_SERVER_NAME)
      : tomlHasServer(source, MCP_SERVER_NAME);
  } catch {
    return false;
  }
}

export async function planClientIntegrations(
  options: IntegrationPlanOptions,
): Promise<IntegrationPlan> {
  const intent = options.intent ?? "install";
  const launch = options.launch ?? DEFAULT_MCP_LAUNCH;
  const entry = mcpEntry(launch);
  const wanted = options.clients ? new Set(options.clients) : null;
  const items: IntegrationPlanItem[] = [];
  for (const client of CLIENT_CATALOG) {
    if (wanted && !wanted.has(client.id)) continue;
    if (!(await clientAvailable(client, options.homeDir, options.run))) continue;
    items.push(
      ...(await planMcp(client, options.homeDir, entry, intent, options.run)),
      ...(await planPortrait(client, options.homeDir, intent)),
      ...(await planSkills(client, options.homeDir, intent)),
    );
  }
  return { items };
}

async function cliListsServer(
  client: (typeof CLIENT_CATALOG)[number],
  run: Runner | undefined,
): Promise<boolean> {
  if (!run || client.id === "cursor") return false;
  try {
    const listed = await run(client.bin, ["mcp", "list"]);
    return listed.exitCode === 0 && listed.stdout.includes(MCP_SERVER_NAME);
  } catch {
    return false;
  }
}

async function planMcp(
  client: (typeof CLIENT_CATALOG)[number],
  homeDir: string,
  entry: McpServerEntry,
  intent: "install" | "uninstall",
  run: Runner | undefined,
): Promise<IntegrationPlanItem[]> {
  const path = join(homeDir, client.mcp.path);
  let current: string | null;
  try {
    current = await readTextIfPresent(path);
  } catch (error) {
    return [mcpProblem(client.id, path, error)];
  }
  let registered = false;
  try {
    registered = mcpRegistered(current, client.mcp.format);
  } catch (error) {
    return [mcpProblem(client.id, path, error)];
  }
  if (intent === "install" && !registered && (await cliListsServer(client, run))) {
    return [];
  }
  if (intent === "uninstall" && !registered) return [];
  let next: string;
  try {
    next =
      intent === "uninstall"
        ? client.mcp.format === "json"
          ? previewJsonMcp(current, MCP_SERVER_NAME, null)
          : previewTomlMcp(current, MCP_SERVER_NAME, null)
        : client.mcp.format === "json"
          ? previewJsonMcp(current, MCP_SERVER_NAME, entry)
          : previewTomlMcp(current, MCP_SERVER_NAME, entry);
  } catch (error) {
    return [mcpProblem(client.id, path, error)];
  }
  const unchanged = (current ?? "") === next;
  let action: IntegrationAction;
  if (intent === "uninstall") action = "remove";
  else if (unchanged) action = "unchanged";
  else if (current === null) action = "create";
  else action = registered ? "update" : "create";
  return [
    {
      id: `${client.id}:mcp`,
      client: client.id,
      kind: "mcp",
      action,
      path,
      preview: previewDiff(path, current, next),
    },
  ];
}

async function planPortrait(
  client: (typeof CLIENT_CATALOG)[number],
  homeDir: string,
  intent: "install" | "uninstall",
): Promise<IntegrationPlanItem[]> {
  const body = portraitBody(client);
  const block = managedBlock(body);
  if (client.portrait.kind === "copy") {
    if (intent === "uninstall") return [];
    return [
      {
        id: `${client.id}:portrait`,
        client: client.id,
        kind: "portrait",
        action: "copy",
        preview: block,
        copyText: block,
      },
    ];
  }
  const path = join(homeDir, client.portrait.path);
  const current = await readTextIfPresent(path);
  if (intent === "uninstall") {
    if (!current || !hasManagedBlock(current)) return [];
    const next = removeManagedBlockText(current);
    return [
      {
        id: `${client.id}:portrait`,
        client: client.id,
        kind: "portrait",
        action: "remove",
        path,
        preview: previewDiff(path, current, next),
      },
    ];
  }
  const next = upsertManagedBlockText(current ?? "", body);
  const limit = client.portrait.maxChars;
  if (limit !== undefined && next.length > limit) {
    return [
      {
        id: `${client.id}:portrait`,
        client: client.id,
        kind: "portrait",
        action: "skipped",
        path,
        preview: previewDiff(path, current, current),
        warning: `Grok 指令文件上限为 ${limit} 字符，跳过写入`,
      },
    ];
  }
  const unchanged = (current ?? "") === next;
  return [
    {
      id: `${client.id}:portrait`,
      client: client.id,
      kind: "portrait",
      action: unchanged ? "unchanged" : current === null ? "create" : "update",
      path,
      preview: previewDiff(path, current, next),
    },
  ];
}

async function planSkills(
  client: (typeof CLIENT_CATALOG)[number],
  homeDir: string,
  intent: "install" | "uninstall",
): Promise<IntegrationPlanItem[]> {
  const items: IntegrationPlanItem[] = [];
  for (const name of YOU_BRAIN_SKILL_NAMES) {
    const path = join(homeDir, client.skillsDir, name, "SKILL.md");
    const current = await readTextIfPresent(path);
    const owned = await youBrainSkillOwned(client.id, name, homeDir);
    if (intent === "uninstall") {
      if (!owned) continue;
      items.push({
        id: `${client.id}:skill:${name}`,
        client: client.id,
        kind: "skill",
        action: "remove",
        path,
        skillName: name,
        preview: previewDiff(path, current, null),
      });
      continue;
    }
    if (current !== null && !owned) {
      items.push({
        id: `${client.id}:skill:${name}`,
        client: client.id,
        kind: "skill",
        action: "skipped",
        path,
        skillName: name,
        preview: `(preserved) ${path}`,
        warning: "已有同名 skill，未覆盖",
      });
      continue;
    }
    const next = YOU_BRAIN_SKILL_BODIES[name];
    items.push({
      id: `${client.id}:skill:${name}`,
      client: client.id,
      kind: "skill",
      action: current === next ? "unchanged" : current === null ? "create" : "update",
      path,
      skillName: name,
      preview: previewDiff(path, current, next),
    });
  }
  return items;
}

export async function applyClientIntegrations(options: {
  homeDir: string;
  plan: IntegrationPlan;
  selectedIds: readonly string[];
  launch?: CommandSpec;
  managedStatePath: string;
}): Promise<{ applied: string[]; skipped: string[] }> {
  const selected = new Set(options.selectedIds);
  const launch = options.launch ?? DEFAULT_MCP_LAUNCH;
  const entry = mcpEntry(launch);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const item of options.plan.items) {
    if (!selected.has(item.id)) continue;
    if (item.action === "unchanged" || item.action === "skipped") {
      skipped.push(item.id);
      continue;
    }
    if (item.action === "copy") {
      applied.push(item.id);
      continue;
    }
    const client = CLIENT_CATALOG.find((candidate) => candidate.id === item.client);
    if (!client) {
      skipped.push(item.id);
      continue;
    }
    if (item.kind === "mcp") {
      const path = join(options.homeDir, client.mcp.path);
      const value = item.action === "remove" ? null : entry;
      if (client.mcp.format === "json") await writeJsonMcp({ path, entry: value });
      else await writeTomlMcp({ path, entry: value });
      applied.push(item.id);
      continue;
    }
    if (item.kind === "portrait") {
      if (client.portrait.kind !== "file") {
        skipped.push(item.id);
        continue;
      }
      const path = join(options.homeDir, client.portrait.path);
      if (item.action === "remove") {
        await removeManagedBlock({ path, statePath: options.managedStatePath });
      } else {
        const limit = client.portrait.maxChars;
        if (limit !== undefined) {
          const current = await readTextIfPresent(path);
          const updated = upsertManagedBlockText(current ?? "", portraitBody(client));
          if (updated.length > limit) {
            skipped.push(item.id);
            continue;
          }
        }
        await upsertManagedBlock({
          path,
          body: portraitBody(client),
          statePath: options.managedStatePath,
        });
      }
      applied.push(item.id);
      continue;
    }
    if (item.skillName) {
      if (item.action === "remove") {
        await uninstallYouBrainSkill(client.id, item.skillName, options.homeDir);
      } else {
        await installYouBrainSkill(client.id, item.skillName, options.homeDir);
      }
      applied.push(item.id);
    }
  }
  return { applied, skipped };
}

function mcpProblem(
  client: CaptureSourceId,
  path: string,
  error: unknown,
): IntegrationPlanItem {
  const message = error instanceof Error ? error.message : "MCP configuration is invalid";
  return {
    id: `${client}:mcp`,
    client,
    kind: "mcp",
    action: "skipped",
    path,
    preview: `(skipped) ${path}`,
    warning: message,
  };
}

export async function planClientUninstall(
  options: Omit<IntegrationPlanOptions, "intent">,
): Promise<IntegrationPlan> {
  return planClientIntegrations({ ...options, intent: "uninstall" });
}
