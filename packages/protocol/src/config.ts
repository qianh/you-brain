import { z } from "zod";

import {
  DEFAULT_ACTIVE_TOPIC_LIMIT,
  DEFAULT_CONSOLIDATE_TIME,
  DEFAULT_DRIVE_ROOT,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_LANGUAGE,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_MORNING_DIGEST_TIME,
  DEFAULT_TIMEZONE,
  DEFAULT_WEEKLY_REVIEW_DAY,
  DEFAULT_WEEKLY_REVIEW_TIME,
} from "./defaults.js";
import { TimeOfDaySchema } from "./formats.js";
import { mergeConfigInput } from "./merge.js";
import { CAPTURE_SOURCE_IDS, type CaptureSourceId } from "./session.js";

export const LLM_PROVIDERS = [
  "deepseek",
  "glm",
  "qwen",
  "kimi",
  "openai",
  "claude",
  "ollama",
  "custom",
  "grok-cli",
  "claude-cli",
  "codex-cli",
  "gemini-cli",
  "opencode-cli",
] as const;

export const LlmProviderSchema = z.enum(LLM_PROVIDERS);

export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const UI_LANGUAGES = ["zh", "en"] as const;

export const UiLanguageSchema = z.enum(UI_LANGUAGES);

export type UiLanguage = z.infer<typeof UiLanguageSchema>;

const CaptureSourceConfigSchema = z.object({
  enabled: z.boolean(),
  paths: z.array(z.string().min(1)),
  include: z.array(z.string().min(1)),
  exclude: z.array(z.string().min(1)),
});

export type CaptureSourceConfig = z.infer<typeof CaptureSourceConfigSchema>;

function captureSource(): CaptureSourceConfig {
  return { enabled: true, paths: [], include: [], exclude: [] };
}

function captureSources(): Record<CaptureSourceId, CaptureSourceConfig> {
  return {
    "claude-code": captureSource(),
    codex: captureSource(),
    "grok-build": captureSource(),
    cursor: captureSource(),
    "gemini-cli": captureSource(),
    pi: captureSource(),
    "t3-code": captureSource(),
  };
}

const PortraitVariantConfigSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
});

export const DEFAULT_PORTRAIT_VARIANTS = [
  { id: "full", path: "digital-twin/JOHN-DIGITAL-TWIN-latest.md" },
  { id: "coding", path: "digital-twin/JOHN-TWIN-coding.md" },
  { id: "projects", path: "digital-twin/JOHN-TWIN-projects.md" },
];

export const DEFAULT_PORTRAIT_SNAPSHOT_PATTERN =
  "digital-twin/JOHN-DIGITAL-TWIN-v*-*.md";

const SharedConfigObjectSchema = z.object({
  version: z.literal(1),
  drive: z.object({
    root: z.string().min(1),
  }),
  capture: z.object({
    sources: z.object({
      "claude-code": CaptureSourceConfigSchema,
      codex: CaptureSourceConfigSchema,
      "grok-build": CaptureSourceConfigSchema,
      cursor: CaptureSourceConfigSchema,
      "gemini-cli": CaptureSourceConfigSchema,
      pi: CaptureSourceConfigSchema,
      "t3-code": CaptureSourceConfigSchema,
    }),
    keepToolCalls: z.boolean(),
    includeSubagents: z.boolean(),
    redact: z.boolean(),
  }),
  llm: z.object({
    provider: LlmProviderSchema,
    model: z.string(),
    baseUrl: z.union([z.literal(""), z.url()]),
  }),
  refine: z.object({
    idleMinutes: z.int().positive(),
  }),
  topics: z.object({
    activeLimit: z.int().positive(),
    historyDays: z.int().positive(),
  }),
  reminders: z.object({
    notifications: z.boolean(),
    morningDigestTime: TimeOfDaySchema,
    weeklyReviewDay: z.int().min(1).max(7),
    weeklyReviewTime: TimeOfDaySchema,
  }),
  portrait: z.object({
    variants: z.array(PortraitVariantConfigSchema).min(1),
    snapshotPattern: z.string().min(1),
  }),
  integrations: z.object({
    mcpClients: z.array(z.string().min(1)),
    codingPortraitClients: z.array(z.string().min(1)),
    skillClients: z.array(z.string().min(1)),
  }),
  ui: z.object({
    language: UiLanguageSchema,
    shortcut: z.string(),
  }),
  search: z.object({
    semantic: z.boolean(),
  }),
});

export type SharedConfig = z.infer<typeof SharedConfigObjectSchema>;

type SourceKeys = keyof SharedConfig["capture"]["sources"];
type SourcesMatch = Exclude<CaptureSourceId, SourceKeys> extends never
  ? Exclude<SourceKeys, CaptureSourceId> extends never
    ? true
    : never
  : never;
const SOURCES_MATCH: SourcesMatch = true;
void SOURCES_MATCH;
void CAPTURE_SOURCE_IDS;

export const DEFAULT_SHARED_CONFIG = {
  version: 1,
  drive: { root: DEFAULT_DRIVE_ROOT },
  capture: {
    sources: captureSources(),
    keepToolCalls: false,
    includeSubagents: false,
    redact: true,
  },
  llm: {
    provider: DEFAULT_LLM_PROVIDER,
    model: "",
    baseUrl: "",
  },
  refine: { idleMinutes: DEFAULT_IDLE_MINUTES },
  topics: {
    activeLimit: DEFAULT_ACTIVE_TOPIC_LIMIT,
    historyDays: DEFAULT_HISTORY_DAYS,
  },
  reminders: {
    notifications: true,
    morningDigestTime: DEFAULT_MORNING_DIGEST_TIME,
    weeklyReviewDay: DEFAULT_WEEKLY_REVIEW_DAY,
    weeklyReviewTime: DEFAULT_WEEKLY_REVIEW_TIME,
  },
  portrait: {
    variants: DEFAULT_PORTRAIT_VARIANTS.map((variant) => ({ ...variant })),
    snapshotPattern: DEFAULT_PORTRAIT_SNAPSHOT_PATTERN,
  },
  integrations: {
    mcpClients: [],
    codingPortraitClients: [],
    skillClients: [],
  },
  ui: {
    language: DEFAULT_LANGUAGE,
    shortcut: "",
  },
  search: {
    semantic: true,
  },
} satisfies SharedConfig;

export const SharedConfigSchema = z.preprocess(
  (input) => mergeConfigInput(DEFAULT_SHARED_CONFIG, input),
  SharedConfigObjectSchema,
);

export function parseSharedConfig(input: unknown = {}): SharedConfig {
  return SharedConfigSchema.parse(input) as SharedConfig;
}

export function createDefaultSharedConfig(): SharedConfig {
  return parseSharedConfig({});
}

const RolesObjectSchema = z.object({
  mainDevice: z.uuid().nullable(),
  webProcessor: z.uuid().nullable(),
  consolidation: z.object({
    enabled: z.boolean(),
    time: TimeOfDaySchema,
  }),
  timezone: z.string().min(1),
});

export type Roles = z.infer<typeof RolesObjectSchema>;

export const DEFAULT_ROLES = {
  mainDevice: null,
  webProcessor: null,
  consolidation: { enabled: false, time: DEFAULT_CONSOLIDATE_TIME },
  timezone: DEFAULT_TIMEZONE,
} satisfies Roles;

export const RolesSchema = z.preprocess(
  (input) => mergeConfigInput(DEFAULT_ROLES, input),
  RolesObjectSchema,
);

export function parseRoles(input: unknown = {}): Roles {
  return RolesSchema.parse(input) as Roles;
}

export function createDefaultRoles(): Roles {
  return parseRoles({});
}

export function resolveWebProcessor(roles: Roles): string | null {
  return roles.webProcessor ?? roles.mainDevice;
}
