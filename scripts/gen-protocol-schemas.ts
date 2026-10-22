import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConsolidateLeaseSchema } from "../packages/core/src/consolidate/lease.ts";
import {
  ConclusionAddedDataSchema,
  DeviceRecordSchema,
  EVENT_TYPES,
  EventSchema,
  PortraitCorrectionAppliedDataSchema,
  PortraitCorrectionDataSchema,
  ProtocolFileSchema,
  ReminderActionDataSchema,
  ReminderIssuedDataSchema,
  RolesSchema,
  SessionRefinedDataSchema,
  SharedConfigSchema,
  TodoAddedDataSchema,
  TodoStatusChangedDataSchema,
  TopicAssignedDataSchema,
  TopicCreatedDataSchema,
  TopicMergedDataSchema,
  TopicRenamedDataSchema,
  TopicStatusChangedDataSchema,
  TopicSummaryRewrittenDataSchema,
  TopicUnassignedDataSchema,
  parseDeviceRecord,
  parseEventsJsonl,
  parseRoles,
  parseSessionFrontmatter,
} from "../packages/protocol/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "docs/protocol/schemas");
const exampleDir = join(root, "docs/protocol/examples");

const DATA_SCHEMAS = {
  "session.refined": SessionRefinedDataSchema,
  "topic.created": TopicCreatedDataSchema,
  "topic.assigned": TopicAssignedDataSchema,
  "topic.unassigned": TopicUnassignedDataSchema,
  "topic.renamed": TopicRenamedDataSchema,
  "topic.status_changed": TopicStatusChangedDataSchema,
  "topic.merged": TopicMergedDataSchema,
  "topic.summary_rewritten": TopicSummaryRewrittenDataSchema,
  "conclusion.added": ConclusionAddedDataSchema,
  "todo.added": TodoAddedDataSchema,
  "todo.status_changed": TodoStatusChangedDataSchema,
  "portrait.correction": PortraitCorrectionDataSchema,
  "portrait.correction_applied": PortraitCorrectionAppliedDataSchema,
  "reminder.issued": ReminderIssuedDataSchema,
  "reminder.action": ReminderActionDataSchema,
} as const;

type JsonSchemaSource = { toJSONSchema: () => unknown };

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stabilize(item));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = stabilize(source[key]);
    return out;
  }
  return value;
}

function render(schema: JsonSchemaSource): string {
  return `${JSON.stringify(stabilize(schema.toJSONSchema()), null, 2)}\n`;
}

function documents(): Map<string, string> {
  const files = new Map<string, string>();
  files.set("device.json", render(DeviceRecordSchema));
  files.set("event.json", render(EventSchema));
  files.set("roles.json", render(RolesSchema));
  files.set("shared.json", render(SharedConfigSchema));
  files.set("lease.json", render(ConsolidateLeaseSchema));
  files.set("protocol.json", render(ProtocolFileSchema));
  for (const type of EVENT_TYPES) {
    files.set(`data.${type}.json`, render(DATA_SCHEMAS[type]));
  }
  return files;
}

function validateExamples(): string[] {
  const errors: string[] = [];
  const read = (name: string): string => readFileSync(join(exampleDir, name), "utf8");
  try {
    parseDeviceRecord(JSON.parse(read("device-virtual.json")));
  } catch (error) {
    errors.push(`device-virtual.json: ${messageOf(error)}`);
  }
  try {
    const parsed = parseEventsJsonl(read("events.jsonl"));
    for (const error of parsed.errors) errors.push(`events.jsonl:${error.line}: ${error.message}`);
    const seen = new Set(parsed.events.map((event) => event.type));
    for (const type of EVENT_TYPES) {
      if (!seen.has(type)) errors.push(`events.jsonl: 缺少 ${type}`);
    }
  } catch (error) {
    errors.push(`events.jsonl: ${messageOf(error)}`);
  }
  try {
    parseRoles(JSON.parse(read("roles-virtual-main.json")));
  } catch (error) {
    errors.push(`roles-virtual-main.json: ${messageOf(error)}`);
  }
  const lease = ConsolidateLeaseSchema.safeParse(JSON.parse(read("lease.json")));
  if (!lease.success) errors.push(`lease.json: ${lease.error.message}`);
  const session = parseSessionFrontmatter(read("session-web.md"));
  if (!session.ok) {
    for (const error of session.errors) errors.push(`session-web.md: ${error.path}: ${error.message}`);
  }
  return errors;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function check(files: Map<string, string>): boolean {
  let mismatch = false;
  for (const [name, body] of files) {
    const path = join(schemaDir, name);
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== body) mismatch = true;
  }
  return mismatch;
}

const files = documents();
const checking = process.argv.includes("--check");
if (checking) {
  const mismatch = check(files);
  const exampleErrors = validateExamples();
  if (mismatch) console.error("schema 与代码不一致，请运行 bun run protocol:schemas");
  for (const error of exampleErrors) console.error(error);
  if (mismatch || exampleErrors.length > 0) process.exit(1);
} else if (import.meta.main) {
  mkdirSync(schemaDir, { recursive: true });
  for (const [name, body] of files) writeFileSync(join(schemaDir, name), body);
  const exampleErrors = validateExamples();
  for (const error of exampleErrors) console.error(error);
  if (exampleErrors.length > 0) process.exit(1);
}
