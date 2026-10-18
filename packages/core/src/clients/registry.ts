import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CaptureSourceId } from "@you-brain/protocol";

import { YouBrainError } from "../domain/errors.js";
import {
  CLIENT_CATALOG,
  DEFAULT_MCP_LAUNCH,
  MCP_SERVER_NAME,
  clientById,
  type CommandSpec,
} from "./catalog.js";
import {
  jsonHasServer,
  mcpEntry,
  readTextIfPresent,
  tomlHasServer,
  writeJsonMcp,
  writeTomlMcp,
} from "./mcp-config.js";
import { installYouBrainSkills, uninstallYouBrainSkills } from "./skills.js";

export const CLIENT_IDS = CLIENT_CATALOG.map((entry) => entry.id);
export type ClientId = CaptureSourceId;
export type ClientAction = "install" | "uninstall";

export type Runner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

const defaultRunner: Runner = async (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({
        stdout: Buffer.concat(output).toString("utf8"),
        exitCode: exitCode ?? 1,
      }),
    );
  });

export function launchWithConfig(launch: CommandSpec, configFile: string): CommandSpec {
  return {
    command: launch.command,
    args: [...launch.args, "--config", configFile],
  };
}

export function clientMutation(
  client: ClientId,
  action: ClientAction,
  launch: CommandSpec,
): { command: string; args: string[] } {
  const entry = clientById(client);
  if (entry.id === "cursor") {
    throw new YouBrainError(
      "INVALID_INPUT",
      "Cursor MCP registration is a file edit, not a CLI mutation",
    );
  }
  if (action === "install") {
    const scope = entry.installScope ? ["--scope", "user"] : [];
    return {
      command: entry.bin,
      args: ["mcp", "add", ...scope, MCP_SERVER_NAME, "--", launch.command, ...launch.args],
    };
  }
  return entry.installScope
    ? { command: entry.bin, args: ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME] }
    : { command: entry.bin, args: ["mcp", "remove", MCP_SERVER_NAME] };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class ClientRegistry {
  readonly launch: CommandSpec;
  readonly run: Runner | undefined;
  readonly homeDir: string;

  constructor(options: {
    homeDir: string;
    launch?: CommandSpec;
    run?: Runner;
  }) {
    this.homeDir = options.homeDir;
    this.launch = options.launch ?? DEFAULT_MCP_LAUNCH;
    this.run = options.run;
  }

  async targets(action: ClientAction): Promise<ClientId[]> {
    const statuses = await Promise.all(CLIENT_IDS.map((client) => this.status(client)));
    return CLIENT_IDS.filter((_, index) =>
      action === "install" ? statuses[index]?.available : statuses[index]?.registered,
    );
  }

  async mutate(client: ClientId, action: ClientAction): Promise<void> {
    const entry = clientById(client);
    const path = join(this.homeDir, entry.mcp.path);
    const entryValue = action === "install" ? mcpEntry(this.launch) : null;
    if (entry.mcp.format === "json") {
      await writeJsonMcp({ path, entry: entryValue });
    } else {
      await writeTomlMcp({ path, entry: entryValue });
    }
    if (action === "install") await this.installSkills(client);
    else await this.uninstallSkills(client);
  }

  installSkills(client: ClientId): Promise<void> {
    return installYouBrainSkills(client, this.homeDir);
  }

  uninstallSkills(client: ClientId): Promise<void> {
    return uninstallYouBrainSkills(client, this.homeDir);
  }

  async status(client: ClientId): Promise<{ available: boolean; registered: boolean }> {
    const entry = clientById(client);
    let available = await directoryExists(join(this.homeDir, entry.directory));
    const runner = this.run;
    if (!available && runner) {
      try {
        const args = client === "cursor" ? ["--version"] : ["mcp", "list"];
        available = (await runner(entry.bin, args)).exitCode === 0;
      } catch {
        available = false;
      }
    }
    const source = await readTextIfPresent(join(this.homeDir, entry.mcp.path)).catch(
      () => null,
    );
    let registered = false;
    if (source !== null) {
      try {
        registered =
          entry.mcp.format === "json"
            ? jsonHasServer(source, MCP_SERVER_NAME)
            : tomlHasServer(source, MCP_SERVER_NAME);
      } catch {
        registered = false;
      }
    }
    if (!registered && runner && client !== "cursor") {
      try {
        const listed = await runner(entry.bin, ["mcp", "list"]);
        registered = listed.exitCode === 0 && listed.stdout.includes(MCP_SERVER_NAME);
      } catch {
        registered = false;
      }
    }
    return { available, registered };
  }
}

export { mergeClaudeDesktopConfig } from "./mcp-config.js";
