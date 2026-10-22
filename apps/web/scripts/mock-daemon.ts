import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.MOCK_TOKEN || "you-brain-mock-token";
const port = Number(process.env.MOCK_PORT || 4731);
const scenario = (process.env.MOCK_SCENARIO || "rich").trim() || "rich";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
const dist = join(fileURLToPath(new URL("..", import.meta.url)), "dist");

if (!existsSync(join(dist, "index.html"))) {
  console.error(`missing ${join(dist, "index.html")}; run bun run build first`);
  process.exit(1);
}

const MAC = "11111111-1111-4111-8111-111111111111";
const OFFICE = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const KEY = {
  sync: "a".repeat(64),
  events: "b".repeat(64),
  trip: "c".repeat(64),
  scratch: "d".repeat(64),
  tax: "e".repeat(64),
};
const MORNING = ago(6 * HOUR);
const NOON = ago(3 * HOUR);
const AFTERNOON = ago(25 * MINUTE);

interface SessionRow {
  sessionKey: string;
  source: string;
  device: string;
  fileId: string | null;
  title: string;
  summary: string;
  startedAt: string;
  updatedAt: string;
  msgCount: number;
  refinedUpTo: number;
  topicId: string | null;
  today: boolean;
}

interface TopicRow {
  topicId: string;
  name: string;
  aliases: string[];
  status: "active" | "follow_up" | "done" | "parked";
  statusBy: "auto" | "user";
  summary: string;
  nextStep: string;
  lastActive: string | null;
  zone: "active" | "history";
  mergedInto: string | null;
  createdTs: string;
  lastUserOpAt: string | null;
  userLocked: boolean;
}

interface ConclusionRow {
  conclusionId: string;
  topicId: string;
  sessionKey: string;
  text: string;
  ts: string;
}

interface TodoRow {
  todoId: string;
  topicId: string;
  sessionKey: string;
  text: string;
  status: "open" | "done" | "dropped";
  statusBy: "auto" | "user";
  confidence: number;
  ts: string;
  userLocked: boolean;
}

const sessions: SessionRow[] = [
  {
    sessionKey: KEY.sync,
    source: "claude-code",
    device: MAC,
    fileId: "1AbCDeFgHiJkLmNoPqRsTuVwXyZ",
    title: "同步按设备分片：事件日志、冲突后写胜出，以及用户锁不能被夜里的自动提炼盖掉",
    summary:
      "事件日志按设备分片写入 Drive。冲突时按字段后写胜出，用户手动改过的状态不会被自动提炼盖掉。This pass also covers the outbox cursor, the per-device events file, and what happens when two machines refine the same topic overnight. 结论是先写本地再上传，合并时用户锁优先。超长摘要用来看截断：后面还有游标过期、补拉、以及办公室那台机器落后十五分钟时怎么对齐。",
    startedAt: ago(6 * HOUR + 20 * MINUTE),
    updatedAt: MORNING,
    msgCount: 28,
    refinedUpTo: 28,
    topicId: "topic-design",
    today: true,
  },
  {
    sessionKey: KEY.events,
    source: "codex",
    device: OFFICE,
    fileId: "1ZyXwVuTsRqPoNmLkJiHgFeDcBa",
    title: "话题册的合并与拆分：from 到 into 只建映射，拆分把单条会话挪到新话题",
    summary: "合并建立 from 到 into 的映射。拆分是把一条会话移出，再归到新话题或已有话题。历史区要能搜索并重新激活。",
    startedAt: ago(2 * HOUR),
    updatedAt: AFTERNOON,
    msgCount: 16,
    refinedUpTo: 16,
    topicId: "topic-design",
    today: true,
  },
  {
    sessionKey: KEY.trip,
    source: "grok-build",
    device: MAC,
    fileId: "1TripFileKyotoOctober2026",
    title: "京都四天：鸭川东的住处、工作日的伏见稻荷，还有没订的返程新干线",
    summary: "想避开周末的人潮，住在鸭川东。还没定返程的新干线。Kyoto, east of the river, weekday visit to Fushimi. 中英混在同一段里，用来看摘要换行。",
    startedAt: ago(4 * HOUR),
    updatedAt: NOON,
    msgCount: 9,
    refinedUpTo: 9,
    topicId: "topic-trip",
    today: true,
  },
  {
    sessionKey: KEY.scratch,
    source: "cursor",
    device: MAC,
    fileId: null,
    title: "临时看了一眼日志：只确认 daemon.json 的权限，没有形成话题，也没有 Drive 原文",
    summary: "只是确认 daemon.json 的权限，没有形成话题。这条故意没有 fileId。",
    startedAt: ago(8 * HOUR),
    updatedAt: ago(8 * HOUR - 6 * MINUTE),
    msgCount: 3,
    refinedUpTo: 3,
    topicId: null,
    today: true,
  },
  {
    sessionKey: "f".repeat(64),
    source: "claude-code",
    device: MAC,
    fileId: "1LongDesignReviewOctober",
    title: "界面重做的验收清单：字号、间距、空状态和窄窗口要一起看，不能只看深色主路径",
    summary:
      "对照设计稿把按钮、输入、选择器和状态胶囊的深浅色都走了一遍。Light mode still needs the same hierarchy: background, surface, then the floating layer. 空状态要居中，不能靠左裸文字。",
    startedAt: ago(90 * MINUTE),
    updatedAt: ago(70 * MINUTE),
    msgCount: 22,
    refinedUpTo: 22,
    topicId: "topic-ui",
    today: true,
  },
  {
    sessionKey: "6".repeat(64),
    source: "cursor",
    device: OFFICE,
    fileId: "1CursorPathMissingNotes",
    title: "Cursor 扫描路径不存在，办公室那台机器的采集停在昨天晚上",
    summary: "路径写成了旧的 Application Support。换机之后没改。English path mixed with 中文说明，错误要说清下一步。",
    startedAt: ago(20 * HOUR),
    updatedAt: ago(18 * HOUR),
    msgCount: 6,
    refinedUpTo: 4,
    topicId: "topic-ui",
    today: true,
  },
  {
    sessionKey: KEY.tax,
    source: "gemini-cli",
    device: OFFICE,
    fileId: "1TaxFolderNotes2025",
    title: "去年的发票",
    summary: "差三张住宿发票。已经搁置，等年底再收。",
    startedAt: "2026-08-02T10:00:00+08:00",
    updatedAt: "2026-08-02T10:40:00+08:00",
    msgCount: 7,
    refinedUpTo: 7,
    topicId: "topic-tax",
    today: false,
  },
];

const topics: TopicRow[] = [
  {
    topicId: "topic-design",
    name: "you-brain 设计",
    aliases: ["记忆中枢", "BrainHub 重写"],
    status: "active",
    statusBy: "user",
    summary:
      "把白天的会话收成话题册，原文留在自己的 Drive 里。同步走事件日志，不依赖某一台机器一直开着。活跃和历史分册存放，合并只建立映射，拆分则把单条会话挪走。菜单栏只留今日和提醒，设置放在主窗口。",
    nextStep: "定下 Web UI 和菜单栏面板的边界，再接真实 daemon。",
    lastActive: AFTERNOON,
    zone: "active",
    mergedInto: null,
    createdTs: "2026-10-01T09:00:00+08:00",
    lastUserOpAt: MORNING,
    userLocked: true,
  },
  {
    topicId: "topic-trip",
    name: "京都旅行",
    aliases: ["秋季出行"],
    status: "follow_up",
    statusBy: "auto",
    summary: "四天行程，住鸭川东，想工作日去伏见稻荷。",
    nextStep: "订返程新干线。",
    lastActive: NOON,
    zone: "active",
    mergedInto: null,
    createdTs: "2026-10-12T20:00:00+08:00",
    lastUserOpAt: null,
    userLocked: false,
  },
  {
    topicId: "topic-tax",
    name: "税务整理",
    aliases: ["发票"],
    status: "parked",
    statusBy: "user",
    summary: "去年的报销还差三张住宿发票。",
    nextStep: "年底前向财务补票。",
    lastActive: "2026-08-02T10:40:00+08:00",
    zone: "history",
    mergedInto: null,
    createdTs: "2026-07-20T09:00:00+08:00",
    lastUserOpAt: "2026-08-03T09:00:00+08:00",
    userLocked: true,
  },
  {
    topicId: "topic-books",
    name: "读书笔记",
    aliases: ["设计书"],
    status: "done",
    statusBy: "user",
    summary: "《如何阅读一本书》的笔记已经收进数字分身。",
    nextStep: "",
    lastActive: "2026-05-01T18:00:00+08:00",
    zone: "history",
    mergedInto: null,
    createdTs: "2026-04-02T12:00:00+08:00",
    lastUserOpAt: "2026-05-02T09:00:00+08:00",
    userLocked: true,
  },
  {
    topicId: "topic-ui",
    name: "界面重做：设计系统、共享组件和窄窗口",
    aliases: ["G1", "design system"],
    status: "active",
    statusBy: "auto",
    summary:
      "令牌、外壳和共享组件先落地，页面之后再重写。深色和浅色要像同一个产品。Empty states stay centered, with an icon and a next step.",
    nextStep: "用 /_design 对一下组件状态，再开页面任务。",
    lastActive: ago(70 * MINUTE),
    zone: "active",
    mergedInto: null,
    createdTs: ago(2 * DAY),
    lastUserOpAt: null,
    userLocked: false,
  },
];

const conclusions: ConclusionRow[] = [
  {
    conclusionId: "conc-sync",
    topicId: "topic-design",
    sessionKey: KEY.sync,
    text: "每台设备只写自己的事件文件，合并顺序是时间、设备、序号。",
    ts: MORNING,
  },
  {
    conclusionId: "conc-user",
    topicId: "topic-design",
    sessionKey: KEY.events,
    text: "用户改过的状态优先于之后的自动判断。",
    ts: AFTERNOON,
  },
  {
    conclusionId: "conc-trip",
    topicId: "topic-trip",
    sessionKey: KEY.trip,
    text: "住宿定在鸭川东，避开周末的伏见稻荷。",
    ts: NOON,
  },
];

const todos: TodoRow[] = [
  {
    todoId: "todo-ui",
    topicId: "topic-design",
    sessionKey: KEY.sync,
    text: "面板只放今日、提醒和状态",
    status: "open",
    statusBy: "auto",
    confidence: 0.8,
    ts: MORNING,
    userLocked: false,
  },
  {
    todoId: "todo-drive",
    topicId: "topic-design",
    sessionKey: KEY.events,
    text: "确认原文链接在原地更新后不变",
    status: "done",
    statusBy: "user",
    confidence: 0.9,
    ts: AFTERNOON,
    userLocked: true,
  },
  {
    todoId: "todo-train",
    topicId: "topic-trip",
    sessionKey: KEY.trip,
    text: "订返程新干线",
    status: "open",
    statusBy: "auto",
    confidence: 0.7,
    ts: NOON,
    userLocked: false,
  },
  {
    todoId: "todo-tax",
    topicId: "topic-tax",
    sessionKey: KEY.tax,
    text: "补三张住宿发票",
    status: "open",
    statusBy: "user",
    confidence: 0.6,
    ts: "2026-08-02T10:40:00+08:00",
    userLocked: true,
  },
];

let config: Record<string, unknown> = {
  version: 1,
  drive: { root: "brain-hub" },
  capture: {
    sources: {
      "claude-code": {
        enabled: true,
        paths: ["~/.claude/projects"],
        include: [],
        exclude: ["**/node_modules/**"],
      },
      codex: { enabled: true, paths: ["~/.codex/sessions"], include: [], exclude: [] },
      "grok-build": { enabled: true, paths: ["~/.grok/sessions"], include: [], exclude: [] },
      cursor: { enabled: false, paths: [], include: [], exclude: [] },
      "gemini-cli": { enabled: true, paths: ["~/.gemini/tmp"], include: [], exclude: [] },
    },
    keepToolCalls: false,
    includeSubagents: false,
    redact: true,
  },
  llm: { provider: "deepseek", model: "deepseek-flash", baseUrl: "" },
  refine: { idleMinutes: 5 },
  topics: { activeLimit: 10, historyDays: 30 },
  reminders: {
    notifications: true,
    morningDigestTime: "08:00",
    weeklyReviewDay: 1,
    weeklyReviewTime: "09:00",
  },
  portrait: {
    variants: [
      { id: "full", path: "digital-twin/JOHN-DIGITAL-TWIN-latest.md" },
      { id: "brief", path: "digital-twin/JOHN-DIGITAL-TWIN-latest-brief.md" },
      { id: "coding", path: "digital-twin/JOHN-TWIN-coding.md" },
    ],
    snapshotPattern: "digital-twin/JOHN-DIGITAL-TWIN-v*-*.md",
  },
  integrations: {
    mcpClients: ["claude-code", "codex"],
    codingPortraitClients: ["claude-code"],
    skillClients: ["codex"],
  },
  ui: { language: "zh", shortcut: "CmdOrCtrl+Shift+Y" },
  search: { semantic: true },
};

let roles: Record<string, unknown> = {
  mainDevice: MAC,
  webProcessor: null,
  consolidation: { enabled: false, time: "03:00" },
  timezone: "Asia/Shanghai",
};

const llmKeys = new Map<string, string>();
let oauthSecret = "";
let accountEmail: string | null = "john@example.com";
let nextId = 1;

const portraits: Record<string, string> = {
  full: [
    "# 全量数字分身",
    "",
    "独立开发者，长期用 bun，回复偏好中文。",
    "",
    "## 工作方式",
    "",
    "- 数据放在自己的 Google Drive，不经过维护者的服务器",
    "- 配置一次之后尽量不再手工搬运",
    "",
    "参考 [产品说明](https://example.com/you-brain)。",
  ].join("\n"),
  brief: ["# 精简", "", "用 bun。中文回复。数据留在自己的 Drive。"].join("\n"),
  coding: [
    "# 编码偏好",
    "",
    "统一用 bun，测试用 `bun:test`。",
    "",
    "```",
    "bun test",
    "```",
    "",
    "> 不要写没有要求的 README。",
  ].join("\n"),
};

const subscribers = new Set<(frame: string) => void>();
let seq = 0;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return structuredClone(patch);
  const merged: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    merged[key] = isObject(current) && isObject(value) ? merge(current, value) : structuredClone(value);
  }
  return merged;
}

function publish(kind: "topics" | "today" | "status"): void {
  seq += 1;
  const event = { id: seq, kind, at: new Date().toISOString() };
  const frame = `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const send of subscribers) send(frame);
}

function topicName(topicId: string | null): string | null {
  if (topicId === null) return null;
  return topics.find((topic) => topic.topicId === topicId)?.name ?? null;
}

function openTodoCount(topicId: string): number {
  return todos.filter((todo) => todo.topicId === topicId && todo.status === "open").length;
}

function listTopics(url: URL): Response {
  const zone = url.searchParams.get("zone");
  const status = url.searchParams.get("status");
  const items = topics
    .filter((topic) => topic.mergedInto === null)
    .filter((topic) => (zone === null ? true : topic.zone === zone))
    .filter((topic) => (status === null ? true : topic.status === status))
    .map((topic) => ({
      topicId: topic.topicId,
      name: topic.name,
      aliases: [...topic.aliases],
      status: topic.status,
      statusBy: topic.statusBy,
      summary: topic.summary,
      nextStep: topic.nextStep,
      lastActive: topic.lastActive,
      zone: topic.zone,
      createdTs: topic.createdTs,
      lastUserOpAt: topic.lastUserOpAt,
      userLocked: topic.userLocked,
      openTodoCount: openTodoCount(topic.topicId),
    }));
  return json({ topics: items });
}

function topicDetail(topic: TopicRow): unknown {
  return {
    ...topic,
    aliases: [...topic.aliases],
    conclusions: conclusions.filter((item) => item.topicId === topic.topicId),
    todos: todos.filter((item) => item.topicId === topic.topicId),
    sessions: sessions
      .filter((session) => session.topicId === topic.topicId)
      .map((session) => ({
        sessionKey: session.sessionKey,
        source: session.source,
        device: session.device,
        fileId: session.fileId,
        title: session.title,
        summary: session.summary,
        updatedAt: session.updatedAt,
      })),
  };
}

function requireTopic(id: string): TopicRow | Response {
  const topic = topics.find((item) => item.topicId === id);
  if (!topic || topic.mergedInto !== null) return fail(404, "NOT_FOUND", "话题不存在");
  return topic;
}

function today(): Response {
  return json({
    date: shanghaiToday(),
    timeZone: "Asia/Shanghai",
    sessions: sessions
      .filter((session) => session.today)
      .map((session) => ({
        sessionKey: session.sessionKey,
        source: session.source,
        device: session.device,
        fileId: session.fileId,
        title: session.title,
        summary: session.summary,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        msgCount: session.msgCount,
        refinedUpTo: session.refinedUpTo,
        topicId: session.topicId,
        topicName: topicName(session.topicId),
        conclusions: conclusions.filter((item) => item.sessionKey === session.sessionKey),
        todos: todos.filter((item) => item.sessionKey === session.sessionKey),
      })),
  });
}

function statusBody(): unknown {
  if (scenario === "fresh") {
    return {
      deviceId: MAC,
      drive: { reachable: null, accountEmail: null },
      sync: { lastSyncAt: null, pendingOutbox: 0 },
      search: { ready: false, documents: 0 },
      refine: { pending: 0, lastError: null },
      consolidation: { enabled: false, lastFinishedAt: null, stale: false, status: "disabled" },
      warnings: [{ code: "LLM_NOT_CONFIGURED", message: "提炼模型还没配置" }],
      captures: [],
      logs: [],
    };
  }
  const healthy = scenario === "healthy";
  return {
    deviceId: MAC,
    drive: { reachable: accountEmail !== null, accountEmail },
    sync: { lastSyncAt: ago(4 * MINUTE), pendingOutbox: healthy ? 0 : 1 },
    search: { ready: healthy, documents: 128 },
    refine: { pending: healthy ? 0 : 2, lastError: null },
    consolidation: { enabled: false, lastFinishedAt: null, stale: false, status: "disabled" },
    warnings: healthy
      ? []
      : [
          { code: "SEARCH_STALE", message: "搜索索引已超过一天没有更新" },
          { code: "CAPTURE_CURSOR", message: "Cursor 的扫描路径不存在" },
        ],
    captures: [
      { source: "claude-code", lastCaptureAt: MORNING, error: null },
      { source: "codex", lastCaptureAt: AFTERNOON, error: null },
      { source: "grok-build", lastCaptureAt: NOON, error: null },
      {
        source: "cursor",
        lastCaptureAt: healthy ? AFTERNOON : null,
        error: healthy ? null : "扫描路径不存在：~/Library/Application Support/Cursor",
      },
      { source: "gemini-cli", lastCaptureAt: ago(20 * HOUR), error: null },
    ],
    logs: healthy
      ? []
      : [
          { at: ago(50 * MINUTE), message: "搜索索引已超过一天没有更新" },
          { at: ago(5 * HOUR), message: "Drive 变更游标过期，已从头拉取" },
        ],
  };
}

async function mutateTopic(id: string, request: Request): Promise<Response> {
  const found = requireTopic(id);
  if (found instanceof Response) return found;
  const body: unknown = await request.json().catch(() => null);
  if (!isObject(body) || typeof body.op !== "string") return fail(400, "INVALID_INPUT", "请求体不完整");
  if (body.op === "rename" && typeof body.name === "string" && body.name.trim() !== "") {
    found.name = body.name.trim();
    if (Array.isArray(body.aliases)) {
      found.aliases = body.aliases.filter((item): item is string => typeof item === "string" && item !== "");
    }
    found.userLocked = true;
    found.statusBy = "user";
    found.lastUserOpAt = new Date().toISOString();
  } else if (body.op === "status" && typeof body.status === "string") {
    if (!["active", "follow_up", "done", "parked"].includes(body.status)) {
      return fail(400, "INVALID_INPUT", "无效的话题状态");
    }
    found.status = body.status as TopicRow["status"];
    found.statusBy = "user";
    found.userLocked = true;
    found.lastUserOpAt = new Date().toISOString();
    if (body.status === "done") found.zone = "history";
    if (body.status === "active") found.zone = "active";
  } else if (body.op === "merge" && typeof body.intoTopicId === "string") {
    const target = requireTopic(body.intoTopicId);
    if (target instanceof Response) return target;
    if (target.topicId === found.topicId) return fail(400, "INVALID_INPUT", "不能把话题合并到自己");
    found.mergedInto = target.topicId;
    for (const session of sessions) {
      if (session.topicId === found.topicId) session.topicId = target.topicId;
    }
    for (const conclusion of conclusions) {
      if (conclusion.topicId === found.topicId) conclusion.topicId = target.topicId;
    }
    for (const todo of todos) {
      if (todo.topicId === found.topicId) todo.topicId = target.topicId;
    }
  } else if (body.op === "split" && typeof body.sessionKey === "string" && isObject(body.target)) {
    const session = sessions.find((item) => item.sessionKey === body.sessionKey && item.topicId === id);
    if (!session) return fail(409, "SESSION_NOT_ON_TOPIC", "会话不在这个话题里");
    if (body.target.action === "create" && typeof body.target.name === "string") {
      const topicId = `topic-new-${nextId++}`;
      topics.push({
        topicId,
        name: body.target.name.trim() || "新话题",
        aliases: [],
        status: "active",
        statusBy: "user",
        summary: session.summary,
        nextStep: "",
        lastActive: session.updatedAt,
        zone: "active",
        mergedInto: null,
        createdTs: new Date().toISOString(),
        lastUserOpAt: new Date().toISOString(),
        userLocked: true,
      });
      session.topicId = topicId;
    } else if (body.target.action === "assign" && typeof body.target.topicId === "string") {
      const target = requireTopic(body.target.topicId);
      if (target instanceof Response) return target;
      session.topicId = target.topicId;
    } else {
      return fail(400, "INVALID_INPUT", "拆分目标不完整");
    }
  } else {
    return fail(400, "INVALID_INPUT", "无法识别的话题操作");
  }
  publish(body.op === "split" ? "topics" : "topics");
  publish("today");
  return json({ ok: true, topicId: id, events: [] });
}

const searchHits = [
  {
    score: 0.86,
    source: "claude-code",
    conversationId: "conv-sync-design",
    startedAt: "2026-10-18T09:12:00+08:00",
    updatedAt: MORNING,
    excerpt: "事件日志按设备分片写入。\n每台设备只写自己的 events 文件，合并时按时间、设备和序号排序。",
  },
  {
    score: 0.61,
    source: "codex",
    conversationId: "conv-topic-book",
    startedAt: "2026-10-18T14:02:00+08:00",
    updatedAt: AFTERNOON,
    excerpt: "话题册需要能改名、合并、拆分，历史区要能搜索并重新激活。",
  },
  {
    score: 0.44,
    source: "grok-build",
    conversationId: "conv-kyoto",
    startedAt: "2026-10-18T11:20:00+08:00",
    updatedAt: NOON,
    excerpt: "京都住在鸭川东，工作日去伏见稻荷，返程新干线还没订。",
  },
];

function search(url: URL): Response {
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (query === "") return fail(400, "INVALID_INPUT", "缺少搜索词");
  if (scenario === "fresh") {
    return json({ query, indexStatus: "stale", searchMode: "keyword", results: [], warnings: [] });
  }
  const needle = query.toLocaleLowerCase();
  const sources = url.searchParams.getAll("sources");
  const results = searchHits.filter((hit) => {
    if (sources.length > 0 && !sources.includes(hit.source)) return false;
    return hit.excerpt.toLocaleLowerCase().includes(needle);
  });
  return json({
    query,
    indexStatus: scenario === "healthy" ? "fresh" : "stale",
    searchMode: scenario === "healthy" ? "semantic" : "keyword",
    results,
    warnings: scenario === "healthy" ? [] : [{ code: "EMBED_UNAVAILABLE", message: "嵌入模型还没就绪，已改用关键词" }],
  });
}

function authorized(request: Request, url: URL): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)/iu.exec(header);
  if (match?.[1] === token) return true;
  return url.pathname === "/api/events" && url.searchParams.get("token") === token;
}

function staticFile(pathname: string): Response {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return fail(404, "NOT_FOUND", "找不到页面");
  }
  const relative = decoded.replace(/^\/+/u, "");
  if (relative === "" || relative.endsWith("/")) return htmlPage();
  const target = resolve(dist, relative);
  const prefix = dist.endsWith(sep) ? dist : `${dist}${sep}`;
  if (target !== dist && !target.startsWith(prefix)) return fail(404, "NOT_FOUND", "找不到页面");
  if (existsSync(target) && statSync(target).isFile()) {
    if (relative === "index.html") return htmlPage();
    return new Response(Bun.file(target));
  }
  if (extname(relative) === "") return htmlPage();
  return fail(404, "NOT_FOUND", "找不到页面");
}

function htmlPage(): Response {
  const raw = readFileSync(join(dist, "index.html"), "utf8");
  const script = `<script>window.__YOU_BRAIN__=${JSON.stringify({ token })};</script>`;
  const html = raw.includes("</head>") ? raw.replace("</head>", `${script}</head>`) : `${script}${raw}`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/events" && request.method === "GET") {
    let send: (frame: string) => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        send = (frame) => {
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            subscribers.delete(send);
          }
        };
        subscribers.add(send);
        send(`id: 0\nevent: ready\ndata: ${JSON.stringify({ id: 0, kind: "ready", at: new Date().toISOString() })}\n\n`);
      },
      cancel() {
        subscribers.delete(send);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
  }
  if (path === "/api/today" && request.method === "GET") return today();
  if (path === "/api/topics" && request.method === "GET") return listTopics(url);
  if (path === "/api/portrait/snapshots" && request.method === "GET") {
    if (scenario === "fresh") return json({ snapshots: [] });
    return json({
      snapshots: [
        { name: "JOHN-DIGITAL-TWIN-v13.md", path: "digital-twin/JOHN-DIGITAL-TWIN-v13.md", updatedAt: ago(DAY) },
        { name: "JOHN-DIGITAL-TWIN-v12.md", path: "digital-twin/JOHN-DIGITAL-TWIN-v12.md", updatedAt: ago(18 * DAY) },
        { name: "JOHN-DIGITAL-TWIN-v11.md", path: "digital-twin/JOHN-DIGITAL-TWIN-v11.md", updatedAt: ago(48 * DAY) },
      ],
    });
  }
  if (path === "/api/portrait" && request.method === "GET") {
    const variant = url.searchParams.get("variant") ?? "full";
    const content = portraits[variant];
    if (content === undefined) return fail(404, "NOT_FOUND", "数字分身不存在");
    const variantPath =
      variant === "brief"
        ? "digital-twin/JOHN-DIGITAL-TWIN-latest-brief.md"
        : variant === "coding"
          ? "digital-twin/JOHN-TWIN-coding.md"
          : "digital-twin/JOHN-DIGITAL-TWIN-latest.md";
    if (scenario === "fresh") return json({ variant, content: "", path: variantPath, updatedAt: null });
    return json({ variant, content, path: variantPath, updatedAt: ago(20 * HOUR) });
  }
  if (path === "/api/search" && request.method === "GET") return search(url);
  if (path === "/api/devices" && request.method === "GET") {
    if (scenario === "fresh") {
      return json({
        devices: [
          {
            deviceId: MAC,
            displayName: "这台 Mac",
            kind: "desktop",
            platform: "darwin",
            appVersion: "0.1.0",
            protocolVersion: 1,
            capabilities: ["capture"],
            lastSeenAt: ago(MINUTE),
            lastActiveAt: ago(MINUTE),
          },
        ],
      });
    }
    return json({
      devices: [
        {
          deviceId: MAC,
          displayName: "MacBook Air",
          kind: "desktop",
          platform: "darwin",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["capture", "refine", "consolidate"],
          lastSeenAt: ago(2 * MINUTE),
          lastActiveAt: AFTERNOON,
        },
        {
          deviceId: OFFICE,
          displayName: "办公室 Mac mini",
          kind: "desktop",
          platform: "darwin",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["capture", "refine"],
          lastSeenAt: ago(15 * MINUTE),
          lastActiveAt: ago(20 * MINUTE),
        },
        {
          deviceId: SERVER,
          displayName: "家用服务器",
          kind: "server",
          platform: "linux",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["consolidate"],
          lastSeenAt: ago(2 * DAY),
          lastActiveAt: ago(2 * DAY + 3 * HOUR),
        },
      ],
    });
  }
  if (path === "/api/roles" && request.method === "GET") return json(roles);
  if (path === "/api/roles" && request.method === "PUT") {
    const patch: unknown = await request.json().catch(() => null);
    if (!isObject(patch)) return fail(400, "INVALID_INPUT", "请求体必须是 JSON 对象");
    roles = merge(roles, patch) as Record<string, unknown>;
    publish("status");
    return json(roles);
  }
  if (path === "/api/config" && request.method === "GET") return json(config);
  if (path === "/api/config" && request.method === "PUT") {
    const patch: unknown = await request.json().catch(() => null);
    if (!isObject(patch)) return fail(400, "INVALID_INPUT", "请求体必须是 JSON 对象");
    if ("apiKey" in patch || (isObject(patch.llm) && "apiKey" in patch.llm)) {
      return fail(400, "INVALID_INPUT", "API Key 不能写入配置");
    }
    config = merge(config, patch) as Record<string, unknown>;
    publish("status");
    return json(config);
  }
  if (path === "/api/status" && request.method === "GET") return json(statusBody());
  if (path === "/api/reminders" && request.method === "GET") {
    if (scenario === "fresh" || scenario === "healthy") return json({ reminders: [] });
    return json({
      reminders: [
        {
          reminderId: "rem-train",
          kind: "follow_up",
          topicId: "topic-trip",
          text: "订返程新干线，京都行程还差这一段。",
          status: "open",
          until: ago(-2 * DAY),
          issuedAt: ago(2 * HOUR),
        },
        {
          reminderId: "rem-ui",
          kind: "digest",
          topicId: "topic-ui",
          text: "界面重做的验收清单还有几条没过。",
          status: "open",
          until: null,
          issuedAt: ago(30 * MINUTE),
        },
      ],
    });
  }
  if (path === "/api/actions/sync" && request.method === "POST") {
    publish("status");
    return json({ started: true, at: new Date().toISOString() });
  }
  if (path === "/api/actions/upload" && request.method === "POST") {
    return json({ dryRun: false, scanned: 4, uploaded: 1, warnings: [] });
  }
  if (path === "/api/actions/todo" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null);
    if (!isObject(body) || typeof body.todoId !== "string" || typeof body.status !== "string") {
      return fail(400, "INVALID_INPUT", "待办请求不完整");
    }
    const todo = todos.find((item) => item.todoId === body.todoId);
    if (!todo) return fail(404, "NOT_FOUND", "待办不存在");
    if (body.status !== "open" && body.status !== "done" && body.status !== "dropped") {
      return fail(400, "INVALID_INPUT", "无效的待办状态");
    }
    todo.status = body.status;
    todo.statusBy = "user";
    todo.userLocked = true;
    publish("topics");
    publish("today");
    return json({ ok: true, events: [] });
  }
  if (path === "/api/actions/conclusion" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null);
    if (!isObject(body) || typeof body.topicId !== "string" || typeof body.text !== "string" || typeof body.sessionKey !== "string") {
      return fail(400, "INVALID_INPUT", "结论请求不完整");
    }
    const topic = requireTopic(body.topicId);
    if (topic instanceof Response) return topic;
    const text = body.text.trim();
    if (text === "") return fail(400, "INVALID_INPUT", "结论不能为空");
    conclusions.push({
      conclusionId: `conc-${nextId++}`,
      topicId: topic.topicId,
      sessionKey: body.sessionKey,
      text,
      ts: new Date().toISOString(),
    });
    publish("topics");
    publish("today");
    return json({ ok: true, events: [] });
  }
  if (path === "/api/secrets/llm" && request.method === "PUT") {
    const body: unknown = await request.json().catch(() => null);
    if (!isObject(body) || typeof body.provider !== "string" || typeof body.apiKey !== "string") {
      return fail(400, "INVALID_INPUT", "缺少 provider 或 API Key");
    }
    const apiKey = body.apiKey.trim();
    if (apiKey === "") return fail(400, "INVALID_INPUT", "API Key 是空的");
    llmKeys.set(body.provider, apiKey);
    return json({ stored: true });
  }
  if (path === "/api/secrets/oauth" && request.method === "PUT") {
    const body: unknown = await request.json().catch(() => null);
    if (!isObject(body)) return fail(400, "INVALID_INPUT", "请求体必须是 JSON 对象");
    if (typeof body.clientSecret === "string") oauthSecret = body.clientSecret;
    return json({ stored: true, echoed: false, hasSecret: oauthSecret !== "" });
  }
  if (path === "/api/actions/llm-test" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null);
    const provider = isObject(body) && typeof body.provider === "string" ? body.provider : "";
    if (provider === "ollama" || llmKeys.has(provider)) {
      return json({ ok: true, message: "连接成功，模型有响应。" });
    }
    return json({ ok: false, message: "钥匙串里还没有这个服务商的 API Key。" });
  }
  if (path === "/api/actions/google-login" && request.method === "POST") {
    accountEmail = "john@example.com";
    publish("status");
    return json({ ok: true, message: "已使用 john@example.com 登录。" });
  }
  const topicMatch = /^\/api\/topics\/([^/]+)$/u.exec(path);
  if (topicMatch) {
    const id = decodeURIComponent(topicMatch[1] ?? "");
    if (request.method === "GET") {
      const topic = requireTopic(id);
      if (topic instanceof Response) return topic;
      return json(topicDetail(topic));
    }
    if (request.method === "POST") return mutateTopic(id, request);
    return fail(405, "METHOD_NOT_ALLOWED", "方法不被允许");
  }
  return fail(404, "NOT_FOUND", "找不到接口");
}

if (scenario === "fresh") {
  sessions.length = 0;
  topics.length = 0;
  conclusions.length = 0;
  todos.length = 0;
  accountEmail = null;
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (scenario === "offline") return undefined as unknown as Response;
      if (!authorized(request, url)) return fail(401, "UNAUTHORIZED", "缺少或无效的访问令牌");
      if (scenario === "error") return fail(500, "INTERNAL", "后台暂时不可用");
      if (scenario === "slow") {
        const ms = 1500 + Math.floor(Math.random() * 1001);
        return new Promise((resolve) => {
          setTimeout(() => resolve(handleApi(request, url)), ms);
        });
      }
      return handleApi(request, url);
    }
    return staticFile(url.pathname);
  },
});

console.log(`mock daemon http://127.0.0.1:${port}/  token=${token}  scenario=${scenario}`);
