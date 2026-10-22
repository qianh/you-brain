import { timingSafeEqual } from "node:crypto";

import {
  mergeDefaults,
  parseRoles,
  parseSharedConfig,
  type Roles,
  type SharedConfig,
} from "@you-brain/protocol";
import { z } from "zod";

import type { HttpDeps } from "./deps.js";
import {
  ConsolidationRejected,
  consolidationRejectMessage,
} from "../consolidate/execute.js";
import { YouBrainError } from "../domain/errors.js";
import { acceptActivityAt } from "../reminders/activity.js";
import { planReminderAction } from "../reminders/action.js";
import { ChangeHub } from "./hub.js";
import { assertPortraitVariant } from "./portrait-files.js";
import {
  ActivityBodySchema,
  ConsolidateActionBodySchema,
  ConclusionActionBodySchema,
  PortraitCorrectionBodySchema,
  ReminderActionBodySchema,
  TodoActionBodySchema,
  TopicMutationBodySchema,
  UploadActionBodySchema,
  type ActionResponse,
  type ApiErrorBody,
  type DaemonChangeKind,
  type PortraitCorrectionResult,
  type SearchRequest,
  type TopicDetail,
  type TopicMutationResponse,
  type TopicsQuery,
  type UploadActionInput,
  type UserEvent,
} from "./types.js";

const SECTION_LIMIT = 80;
const TEXT_LIMIT = 1_000;
const SECTION_MESSAGE = "「哪一部分」需要 1 到 80 个字";
const TEXT_MESSAGE = "「应该怎么改」需要 1 到 1000 个字";
const VARIANT_MESSAGE = "无效的数字分身变体";

const SEARCH_LIMIT = z.coerce.number().int().min(1).max(50);
const ZONE = z.enum(["active", "history"]);

export function json(
  body: unknown,
  status = 200,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, string>,
): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return json(body, status, extra);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return apiError(error.status, error.code, error.message);
  if (error instanceof z.ZodError) {
    return apiError(400, "INVALID_INPUT", error.message);
  }
  if (error instanceof YouBrainError) {
    const status =
      error.code === "SESSION_NOT_FOUND" || error.code === "SOURCE_UNAVAILABLE"
        ? 404
        : error.code === "INVALID_INPUT" || error.code === "CONFIG_INVALID"
          ? 400
          : 500;
    return apiError(status, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : "内部错误";
  return apiError(500, "INTERNAL_ERROR", message);
}

export function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(header);
  return match?.[1] ?? null;
}

export interface ApiContext {
  deps: HttpDeps;
  hub: ChangeHub;
  createId: () => string;
}

export async function handleApi(
  request: Request,
  url: URL,
  context: ApiContext,
): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/events") {
    return apiError(404, "NOT_FOUND", "找不到接口");
  }
  if (path === "/api/today") return method(request, "GET", () => today(context));
  if (path === "/api/topics") return method(request, "GET", () => topics(url, context));
  if (path === "/api/portrait/snapshots") {
    return method(request, "GET", () => snapshots(context));
  }
  if (path === "/api/portrait/corrections") {
    if (request.method === "GET") return portraitCorrections(url, context);
    if (request.method === "POST") return addPortraitCorrection(request, context);
    return methodNotAllowed("GET, POST");
  }
  if (path === "/api/portrait") return method(request, "GET", () => portrait(url, context));
  if (path === "/api/search") return method(request, "GET", () => search(url, context));
  if (path === "/api/devices") return method(request, "GET", () => devices(context));
  if (path === "/api/roles") {
    if (request.method === "GET") return roles(context);
    if (request.method === "PUT") return writeRoles(request, context);
    return methodNotAllowed("GET, PUT");
  }
  if (path === "/api/config") {
    if (request.method === "GET") return config(context);
    if (request.method === "PUT") return writeConfig(request, context);
    return methodNotAllowed("GET, PUT");
  }
  if (path === "/api/status") return method(request, "GET", () => status(context));
  if (path === "/api/reminders") return method(request, "GET", () => reminders(url, context));
  if (path === "/api/activity") return method(request, "POST", () => activity(request, context));
  if (path === "/api/actions/reminder") {
    return method(request, "POST", () => reminderAction(request, context));
  }
  if (path === "/api/actions/sync") return method(request, "POST", () => sync(context));
  if (path === "/api/actions/consolidate") {
    return method(request, "POST", () => consolidate(request, context));
  }
  if (path === "/api/actions/upload") {
    return method(request, "POST", () => upload(request, context));
  }
  if (path === "/api/actions/todo") return method(request, "POST", () => todo(request, context));
  if (path === "/api/actions/conclusion") {
    return method(request, "POST", () => conclusion(request, context));
  }
  const topicMatch = /^\/api\/topics\/([^/]+)$/u.exec(path);
  if (topicMatch) {
    const id = decodeURIComponent(topicMatch[1] ?? "");
    if (id.length === 0) return apiError(404, "NOT_FOUND", "话题不存在");
    if (request.method === "GET") return readTopic(id, context);
    if (request.method === "POST") return mutateTopic(id, request, context);
    return methodNotAllowed("GET, POST");
  }
  return apiError(404, "NOT_FOUND", "找不到接口");
}

function method(
  request: Request,
  allowed: string,
  run: () => Response | Promise<Response>,
): Response | Promise<Response> {
  if (request.method !== allowed) return methodNotAllowed(allowed);
  return run();
}

function methodNotAllowed(allow: string): Response {
  return apiError(405, "METHOD_NOT_ALLOWED", "方法不被允许", { allow });
}

async function today(context: ApiContext): Promise<Response> {
  return json(await context.deps.today());
}

async function topics(url: URL, context: ApiContext): Promise<Response> {
  const query: TopicsQuery = {};
  const zone = url.searchParams.get("zone");
  if (zone !== null) {
    const parsed = ZONE.safeParse(zone);
    if (!parsed.success) {
      throw new HttpError(400, "INVALID_INPUT", "zone 只能是 active 或 history");
    }
    query.zone = parsed.data;
  }
  const statusFilter = url.searchParams.get("status");
  if (statusFilter !== null) {
    const parsed = z
      .enum(["active", "follow_up", "done", "parked"])
      .safeParse(statusFilter);
    if (!parsed.success) throw new HttpError(400, "INVALID_INPUT", "无效的话题状态");
    query.status = parsed.data;
  }
  return json(await context.deps.topics(query));
}

async function readTopic(id: string, context: ApiContext): Promise<Response> {
  const topic = await context.deps.topic(id);
  if (!topic) return apiError(404, "NOT_FOUND", "话题不存在");
  return json(topic);
}

async function mutateTopic(
  id: string,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const body = TopicMutationBodySchema.parse(await readJson(request));
  const topic = await requireTopic(context, id);
  if (topic.mergedInto !== null) {
    throw new HttpError(409, "TOPIC_MERGED", "话题已经合并，不能再修改");
  }
  let events: UserEvent[];
  if (body.op === "rename") {
    events = [
      {
        type: "topic.renamed",
        data: {
          topicId: id,
          name: body.name,
          aliases: body.aliases ?? [...topic.aliases],
        },
      },
    ];
  } else if (body.op === "status") {
    events = [
      {
        type: "topic.status_changed",
        data: { topicId: id, status: body.status, by: "user" },
      },
    ];
  } else if (body.op === "merge") {
    if (body.intoTopicId === id) {
      throw new HttpError(400, "INVALID_INPUT", "不能把话题合并到自己");
    }
    const target = await context.deps.topic(body.intoTopicId);
    if (!target) throw new HttpError(404, "NOT_FOUND", "目标话题不存在");
    if (target.mergedInto !== null) {
      throw new HttpError(409, "TOPIC_MERGED", "目标话题已经合并到其他话题");
    }
    events = [
      {
        type: "topic.merged",
        data: { fromTopicId: id, intoTopicId: body.intoTopicId },
      },
    ];
  } else {
    const onTopic = topic.sessions.some(
      (session) => session.sessionKey === body.sessionKey,
    );
    if (!onTopic) throw new HttpError(409, "SESSION_NOT_ON_TOPIC", "会话不在这个话题里");
    const unassigned: UserEvent = {
      type: "topic.unassigned",
      data: { topicId: id, sessionKey: body.sessionKey },
    };
    if (body.target.action === "assign") {
      if (body.target.topicId === id) {
        throw new HttpError(400, "INVALID_INPUT", "会话已经在这个话题里");
      }
      const target = await requireLiveTopic(context, body.target.topicId);
      events = [
        unassigned,
        {
          type: "topic.assigned",
          data: { topicId: target.topicId, sessionKey: body.sessionKey },
        },
      ];
    } else {
      const topicId = context.createId();
      events = [
        unassigned,
        {
          type: "topic.created",
          data: {
            topicId,
            name: body.target.name,
            aliases: body.target.aliases ?? [],
          },
        },
        {
          type: "topic.assigned",
          data: { topicId, sessionKey: body.sessionKey },
        },
      ];
    }
  }
  await emitAll(context.deps.events, events);
  publish(context.hub, body.op === "split" ? ["topics", "today"] : ["topics"]);
  const response: TopicMutationResponse = { ok: true, topicId: id, events };
  return json(response);
}

async function portrait(url: URL, context: ApiContext): Promise<Response> {
  const variant = url.searchParams.get("variant") ?? "full";
  try {
    assertPortraitVariant(variant);
  } catch (error) {
    if (error instanceof YouBrainError) {
      throw new HttpError(400, error.code, error.message);
    }
    throw error;
  }
  const portraitFile = await context.deps.portrait(variant);
  if (!portraitFile) return apiError(404, "NOT_FOUND", "数字分身不存在");
  return json(portraitFile);
}

async function snapshots(context: ApiContext): Promise<Response> {
  return json({ snapshots: await context.deps.portraitSnapshots() });
}

async function portraitCorrections(url: URL, context: ApiContext): Promise<Response> {
  const raw = url.searchParams.get("variant");
  const variant = raw === null ? undefined : raw.trim();
  if (variant !== undefined) await requirePortraitVariant(context, variant);
  return json({ corrections: await context.deps.portraitCorrections(variant) });
}

async function addPortraitCorrection(request: Request, context: ApiContext): Promise<Response> {
  const parsed = PortraitCorrectionBodySchema.safeParse(await readJson(request));
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_INPUT", correctionBodyMessage(parsed.error));
  }
  const section = parsed.data.section.trim();
  const text = parsed.data.text.trim();
  if (section.length < 1 || section.length > SECTION_LIMIT) {
    throw new HttpError(400, "INVALID_INPUT", SECTION_MESSAGE);
  }
  if (text.length < 1 || text.length > TEXT_LIMIT) {
    throw new HttpError(400, "INVALID_INPUT", TEXT_MESSAGE);
  }
  const variant = (parsed.data.variant ?? "full").trim();
  await requirePortraitVariant(context, variant);
  const correctionId = context.createId();
  const events: UserEvent[] = [
    {
      type: "portrait.correction",
      data: { correctionId, variant, section, text },
    },
  ];
  await emitAll(context.deps.events, events);
  publish(context.hub, ["portrait"]);
  const listed = await context.deps.portraitCorrections(variant);
  const correction = listed.find((item) => item.correctionId === correctionId);
  if (!correction) throw new HttpError(500, "INTERNAL_ERROR", "纠正没有写入");
  const response: PortraitCorrectionResult = { ok: true, correction };
  return json(response);
}

async function requirePortraitVariant(context: ApiContext, variant: string): Promise<void> {
  try {
    assertPortraitVariant(variant);
  } catch (error) {
    if (error instanceof YouBrainError) throw new HttpError(400, error.code, error.message);
    throw error;
  }
  const config = await context.deps.readConfig();
  if (!config.portrait.variants.some((item) => item.id === variant)) {
    throw new HttpError(400, "INVALID_INPUT", VARIANT_MESSAGE);
  }
}

function correctionBodyMessage(error: z.ZodError): string {
  const fields = new Set(error.issues.map((issue) => String(issue.path[0])));
  if (fields.has("variant") && !fields.has("section") && !fields.has("text")) return VARIANT_MESSAGE;
  if (fields.has("section") && !fields.has("text")) return SECTION_MESSAGE;
  if (fields.has("text") && !fields.has("section")) return TEXT_MESSAGE;
  return "纠正内容不完整";
}

async function search(url: URL, context: ApiContext): Promise<Response> {
  const q = url.searchParams.get("q");
  if (q === null || q.trim() === "") {
    throw new HttpError(400, "INVALID_INPUT", "缺少搜索词");
  }
  const request: SearchRequest = { query: q };
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = SEARCH_LIMIT.safeParse(limit);
    if (!parsed.success) {
      throw new HttpError(400, "INVALID_INPUT", "limit 必须是 1 到 50 的整数");
    }
    request.limit = parsed.data;
  }
  const from = url.searchParams.get("from");
  if (from !== null && from !== "") request.from = from;
  const to = url.searchParams.get("to");
  if (to !== null && to !== "") request.to = to;
  const sources = [
    ...url.searchParams.getAll("sources"),
    ...url.searchParams.getAll("source"),
  ].flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
  if (sources.length > 0) request.sources = sources;
  return json(await context.deps.search(request));
}

async function devices(context: ApiContext): Promise<Response> {
  return json({ devices: await context.deps.devices() });
}

async function roles(context: ApiContext): Promise<Response> {
  return json(await context.deps.readRoles());
}

async function writeRoles(request: Request, context: ApiContext): Promise<Response> {
  const patch = await readObject(request);
  const current = await context.deps.readRoles();
  let next: Roles;
  try {
    next = parseRoles(mergeDefaults(current, patch));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new HttpError(400, "INVALID_INPUT", error.message);
    }
    throw error;
  }
  await context.deps.writeRoles(next);
  return json(next);
}

async function config(context: ApiContext): Promise<Response> {
  return json(await context.deps.readConfig());
}

async function writeConfig(request: Request, context: ApiContext): Promise<Response> {
  const patch = await readObject(request);
  const current = await context.deps.readConfig();
  let next: SharedConfig;
  try {
    next = parseSharedConfig(mergeDefaults(current, patch));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new HttpError(400, "INVALID_INPUT", error.message);
    }
    throw error;
  }
  await context.deps.writeConfig(next);
  publish(context.hub, ["status"]);
  return json(next);
}

async function status(context: ApiContext): Promise<Response> {
  return json(await context.deps.status());
}

async function reminders(url: URL, context: ApiContext): Promise<Response> {
  const all = url.searchParams.get("all") === "1";
  return json(await context.deps.reminders(all));
}

async function activity(request: Request, context: ApiContext): Promise<Response> {
  const body = ActivityBodySchema.parse(await readJson(request));
  const accepted = acceptActivityAt({ at: body.at, now: context.deps.now().toISOString() });
  if (!accepted.ok) throw new HttpError(400, "INVALID_INPUT", "活动时间超出允许范围");
  return json(await context.deps.reportActivity(accepted.at));
}

async function reminderAction(request: Request, context: ApiContext): Promise<Response> {
  const body = ReminderActionBodySchema.parse(await readJson(request));
  const current = await context.deps.reminder(body.reminderId);
  if (!current) return apiError(404, "NOT_FOUND", "提醒不存在");
  const plan = planReminderAction({
    reminder: current,
    action: body.action,
    until: body.until ?? null,
    now: context.deps.now().toISOString(),
  });
  if ("error" in plan) {
    throw new HttpError(plan.error.status, plan.error.code, plan.error.message);
  }
  await emitAll(context.deps.events, plan.events);
  const kinds: DaemonChangeKind[] = ["status"];
  if (plan.events.some((event) => event.type === "topic.status_changed")) {
    kinds.push("topics", "today");
  }
  publish(context.hub, kinds);
  return json(plan.reminder);
}

async function consolidate(request: Request, context: ApiContext): Promise<Response> {
  const body = ConsolidateActionBodySchema.parse(await readJson(request));
  if (!context.deps.consolidate) return apiError(404, "NOT_FOUND", "找不到接口");
  try {
    const result = await context.deps.consolidate({ force: body.force === true });
    return json(result);
  } catch (error) {
    if (error instanceof ConsolidationRejected) {
      return apiError(409, error.code, consolidationRejectMessage(error.code));
    }
    throw error;
  }
}

async function sync(context: ApiContext): Promise<Response> {
  const result = await context.deps.sync();
  publish(context.hub, ["status"]);
  return json(result);
}

async function upload(request: Request, context: ApiContext): Promise<Response> {
  const body = UploadActionBodySchema.parse(await readJson(request));
  const input: UploadActionInput = {};
  if (body.sources !== undefined) input.sources = body.sources;
  if (body.backfill !== undefined) input.backfill = body.backfill;
  if (body.includeSubagents !== undefined) input.includeSubagents = body.includeSubagents;
  if (body.dryRun !== undefined) input.dryRun = body.dryRun;
  const result = await context.deps.upload(input);
  publish(context.hub, ["status"]);
  return json(result);
}

async function todo(request: Request, context: ApiContext): Promise<Response> {
  const body = TodoActionBodySchema.parse(await readJson(request));
  const current = await context.deps.todo(body.todoId);
  if (!current) return apiError(404, "NOT_FOUND", "待办不存在");
  const events: UserEvent[] = [
    {
      type: "todo.status_changed",
      data: { todoId: body.todoId, status: body.status, by: "user" },
    },
  ];
  await emitAll(context.deps.events, events);
  publish(context.hub, ["topics", "today"]);
  const response: ActionResponse = { ok: true, events };
  return json(response);
}

async function conclusion(request: Request, context: ApiContext): Promise<Response> {
  const body = ConclusionActionBodySchema.parse(await readJson(request));
  await requireTopic(context, body.topicId);
  const events: UserEvent[] = [
    {
      type: "conclusion.added",
      data: {
        conclusionId: context.createId(),
        topicId: body.topicId,
        text: body.text,
        sessionKey: body.sessionKey,
      },
    },
  ];
  await emitAll(context.deps.events, events);
  publish(context.hub, ["topics", "today"]);
  const response: ActionResponse = { ok: true, events };
  return json(response);
}

async function requireTopic(context: ApiContext, id: string): Promise<TopicDetail> {
  const topic = await context.deps.topic(id);
  if (!topic) throw new HttpError(404, "NOT_FOUND", "话题不存在");
  return topic;
}

async function requireLiveTopic(context: ApiContext, id: string): Promise<TopicDetail> {
  const topic = await requireTopic(context, id);
  if (topic.mergedInto !== null) {
    throw new HttpError(409, "TOPIC_MERGED", "目标话题已经合并到其他话题");
  }
  return topic;
}

async function emitAll(
  sink: HttpDeps["events"],
  events: readonly UserEvent[],
): Promise<void> {
  for (const event of events) {
    switch (event.type) {
      case "topic.renamed":
        await sink.emit(event.type, event.data);
        break;
      case "topic.status_changed":
        await sink.emit(event.type, event.data);
        break;
      case "topic.merged":
        await sink.emit(event.type, event.data);
        break;
      case "topic.unassigned":
        await sink.emit(event.type, event.data);
        break;
      case "topic.assigned":
        await sink.emit(event.type, event.data);
        break;
      case "topic.created":
        await sink.emit(event.type, event.data);
        break;
      case "todo.status_changed":
        await sink.emit(event.type, event.data);
        break;
      case "conclusion.added":
        await sink.emit(event.type, event.data);
        break;
      case "reminder.action":
        await sink.emit(event.type, event.data);
        break;
      case "portrait.correction":
        await sink.emit(event.type, event.data);
        break;
      default: {
        const unreachable: never = event;
        throw new HttpError(500, "INTERNAL_ERROR", `未处理的事件 ${String(unreachable)}`);
      }
    }
  }
}

function publish(hub: ChangeHub, kinds: readonly DaemonChangeKind[]): void {
  for (const kind of kinds) hub.publish(kind);
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_INPUT", "请求体不是合法 JSON");
  }
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const value = await readJson(request);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_INPUT", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}
