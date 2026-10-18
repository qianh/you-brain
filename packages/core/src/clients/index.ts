export {
  CLAUDE_CODING_PORTRAIT_LINE,
  CLIENT_CATALOG,
  CODING_PORTRAIT_INSTRUCTION,
  DEFAULT_MCP_LAUNCH,
  GROK_INSTRUCTION_LIMIT,
  MCP_SERVER_NAME,
  clientById,
  portraitBody,
  type ClientCatalogEntry,
  type CommandSpec,
} from "./catalog.js";
export { previewDiff } from "./diff.js";
export {
  MANAGED_BLOCK_VERSION,
  hasManagedBlock,
  managedBlock,
  removeManagedBlock,
  removeManagedBlockText,
  upsertManagedBlock,
  upsertManagedBlockText,
  type ManagedBlockWriteResult,
} from "./managed-block.js";
export {
  brainHubServerNames,
  isBrainHubServerName,
  jsonHasServer,
  mcpEntry,
  mergeClaudeDesktopConfig,
  previewJsonMcp,
  previewTomlMcp,
  readTextIfPresent,
  tomlHasServer,
  writeJsonMcp,
  writeTomlMcp,
  type McpServerEntry,
} from "./mcp-config.js";
export {
  CLIENT_IDS,
  ClientRegistry,
  clientMutation,
  launchWithConfig,
  type ClientAction,
  type ClientId,
  type Runner,
} from "./registry.js";
export {
  installYouBrainSkill,
  installYouBrainSkills,
  uninstallYouBrainSkill,
  uninstallYouBrainSkills,
  youBrainSkillOwned,
} from "./skills.js";
export {
  YOU_BRAIN_PORTRAIT_SKILL,
  YOU_BRAIN_SKILL,
  YOU_BRAIN_SKILL_BODIES,
  YOU_BRAIN_SKILL_NAMES,
  type YouBrainSkillName,
} from "./skill-content.js";
export {
  applyClientIntegrations,
  planClientIntegrations,
  planClientUninstall,
  type IntegrationAction,
  type IntegrationKind,
  type IntegrationPlan,
  type IntegrationPlanItem,
  type IntegrationPlanOptions,
} from "./integrations.js";
export { installLocalIntegrations } from "./auto-install.js";
