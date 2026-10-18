import type { CaptureSourceId } from "@you-brain/protocol";

import type { CommandSpec } from "./catalog.js";
import { applyClientIntegrations, planClientIntegrations } from "./integrations.js";
import type { Runner } from "./registry.js";

export async function installLocalIntegrations(options: {
  homeDir: string;
  launch?: CommandSpec;
  run?: Runner;
  skillsOnly?: boolean;
  managedStatePath: string;
}): Promise<{ installed: CaptureSourceId[]; warnings: string[] }> {
  const plan = await planClientIntegrations({
    homeDir: options.homeDir,
    managedStatePath: options.managedStatePath,
    intent: "install",
    ...(options.launch ? { launch: options.launch } : {}),
    ...(options.skillsOnly || !options.run ? {} : { run: options.run }),
  });
  const kinds = new Set(options.skillsOnly ? ["skill"] : ["mcp", "skill"]);
  const selected = plan.items
    .filter(
      (item) =>
        kinds.has(item.kind) && (item.action === "create" || item.action === "update"),
    )
    .map((item) => item.id);
  const result = await applyClientIntegrations({
    homeDir: options.homeDir,
    plan,
    selectedIds: selected,
    managedStatePath: options.managedStatePath,
    ...(options.launch ? { launch: options.launch } : {}),
  });
  const applied = new Set(result.applied);
  const installed = [
    ...new Set(
      plan.items
        .filter((item) => applied.has(item.id))
        .map((item) => item.client),
    ),
  ];
  const warnings = plan.items
    .filter((item) => item.warning && kinds.has(item.kind))
    .map((item) => `${item.client}: ${item.warning}`);
  return { installed, warnings };
}
