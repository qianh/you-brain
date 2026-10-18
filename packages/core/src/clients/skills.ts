import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CaptureSourceId } from "@you-brain/protocol";

import { clientById } from "./catalog.js";
import {
  YOU_BRAIN_SKILL_BODIES,
  YOU_BRAIN_SKILL_NAMES,
  type YouBrainSkillName,
} from "./skill-content.js";

const markerName = ".you-brain-owned.json";

function skillRoot(client: CaptureSourceId, homeDir: string): string {
  return join(homeDir, clientById(client).skillsDir);
}

function skillDir(client: CaptureSourceId, homeDir: string, name: YouBrainSkillName): string {
  return join(skillRoot(client, homeDir), name);
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function installYouBrainSkill(
  client: CaptureSourceId,
  name: YouBrainSkillName,
  homeDir: string,
): Promise<"installed" | "preserved"> {
  await mkdir(skillRoot(client, homeDir), { recursive: true });
  const dir = skillDir(client, homeDir, name);
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "preserved";
    throw error;
  }
  const content = YOU_BRAIN_SKILL_BODIES[name];
  await writeFile(join(dir, "SKILL.md"), content, { flag: "wx" });
  await writeFile(
    join(dir, markerName),
    JSON.stringify({ owner: "you-brain", content }),
    { flag: "wx" },
  );
  return "installed";
}

export async function installYouBrainSkills(
  client: CaptureSourceId,
  homeDir: string,
): Promise<void> {
  for (const name of YOU_BRAIN_SKILL_NAMES) {
    await installYouBrainSkill(client, name, homeDir);
  }
}

export async function uninstallYouBrainSkill(
  client: CaptureSourceId,
  name: YouBrainSkillName,
  homeDir: string,
): Promise<"removed" | "preserved" | "absent"> {
  const dir = skillDir(client, homeDir, name);
  if (!(await statIfPresent(dir))?.isDirectory()) return "absent";
  const file = join(dir, "SKILL.md");
  const marker = join(dir, markerName);
  if (!(await statIfPresent(marker))?.isFile()) return "preserved";
  let ownership: { owner?: unknown; content?: unknown };
  try {
    ownership = JSON.parse(await readFile(marker, "utf8")) as typeof ownership;
  } catch (error) {
    if (error instanceof SyntaxError) return "preserved";
    throw error;
  }
  if (
    !ownership ||
    ownership.owner !== "you-brain" ||
    typeof ownership.content !== "string"
  ) {
    return "preserved";
  }
  const stat = await statIfPresent(file);
  if (stat) {
    if (!stat.isFile() || (await readFile(file, "utf8")) !== ownership.content) {
      return "preserved";
    }
    await unlink(file);
  }
  await unlink(marker);
  try {
    await rmdir(dir);
  } catch (error) {
    if (
      !["ENOTEMPTY", "EEXIST", "ENOENT"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  }
  return "removed";
}

export async function uninstallYouBrainSkills(
  client: CaptureSourceId,
  homeDir: string,
): Promise<void> {
  for (const name of YOU_BRAIN_SKILL_NAMES) {
    await uninstallYouBrainSkill(client, name, homeDir);
  }
}

export async function youBrainSkillOwned(
  client: CaptureSourceId,
  name: YouBrainSkillName,
  homeDir: string,
): Promise<boolean> {
  const marker = join(skillDir(client, homeDir, name), markerName);
  if (!(await statIfPresent(marker))?.isFile()) return false;
  try {
    const ownership = JSON.parse(await readFile(marker, "utf8")) as {
      owner?: unknown;
    };
    return ownership.owner === "you-brain";
  } catch {
    return false;
  }
}
