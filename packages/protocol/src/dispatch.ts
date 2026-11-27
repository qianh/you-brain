import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

import { z } from "zod";

/** 派活帧版本。规范串前缀 `u-brain-cmd/1` 与此一致。 */
export const DISPATCH_PROTOCOL_VERSION = 1;

/**
 * 权限从紧到松。`minMode` 取更紧的一档。
 * `approval-required` 只出现在本机上限里；发起方不能请求这一档。
 */
export const MODE_ORDER = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

export type RuntimeModeName = (typeof MODE_ORDER)[number];

export const RuntimeModeSchema = z.enum(MODE_ORDER);

export const LAUNCH_MODES = ["auto-accept-edits", "auto", "full-access"] as const;

export type LaunchModeName = (typeof LAUNCH_MODES)[number];

export const LaunchModeSchema = z.enum(LAUNCH_MODES);

export function minMode(a: RuntimeModeName, b: RuntimeModeName): RuntimeModeName {
  const left = MODE_ORDER.indexOf(a);
  const right = MODE_ORDER.indexOf(b);
  return MODE_ORDER[Math.min(left, right)] ?? "auto";
}

export const DISPATCH_KINDS = [
  "t3.projects",
  "t3.start",
  "t3.followup",
  "t3.read",
  "t3.threads",
  "agent.session",
  "agent.send",
  "agent.read",
  "dispatch.list",
  "dispatch.followup",
  "dispatch.refresh",
  "notice.reply",
  "tasks.board",
  "tasks.create",
  "tasks.update",
  "tasks.action",
  "tasks.review",
  "tasks.blob.put",
  "tasks.blob.get",
  "rd.open",
  "rd.ice",
  "rd.close",
] as const;

export type DispatchKind = (typeof DISPATCH_KINDS)[number];

export const T3ProjectsArgsSchema = z.strictObject({});

export const T3ProjectsResultSchema = z.strictObject({
  projects: z.array(z.strictObject({ id: z.string(), name: z.string() })),
});

export const T3StartArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  mode: LaunchModeSchema.optional(),
  dispatchId: z.string().min(1),
});

export const T3StartResultSchema = z.strictObject({
  threadId: z.string(),
  threadUrl: z.string(),
  mode: LaunchModeSchema,
  capped: z.boolean(),
});

export const T3FollowupArgsSchema = z.strictObject({
  threadId: z.string().min(1),
  prompt: z.string(),
  requestId: z.string().min(1),
});

export const T3FollowupResultSchema = z.strictObject({});

export const T3ReadArgsSchema = z.strictObject({
  threadId: z.string().min(1),
});

export const T3ReadResultSchema = z.strictObject({
  state: z.enum(["planning", "running", "ready", "failed"]),
  summary: z.string(),
  error: z.string().optional(),
  link: z.string().nullable(),
});

export const T3ThreadsArgsSchema = z.strictObject({});

export const T3ThreadsResultSchema = z.strictObject({
  threads: z.array(z.strictObject({
    threadId: z.string(),
    title: z.string(),
    status: z.string(),
    link: z.string().nullable(),
    dispatchId: z.string(),
  })),
});

export const AgentSessionArgsSchema = z.strictObject({
  sessionId: z.string().min(1).max(128).optional(),
  create: z.boolean().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

export const AgentSendArgsSchema = z.strictObject({
  text: z
    .string()
    .max(60_000)
    .refine((value) => value.trim().length > 0, { message: "消息不能为空" }),
  sessionId: z.string().min(1).max(128).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).optional(),
  mode: LaunchModeSchema.optional(),
  requestId: z.string().min(1).max(128),
});

export const AgentReadArgsSchema = z.strictObject({
  sessionId: z.string().min(1).max(128).optional(),
  afterPosition: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const DispatchListArgsSchema = z.strictObject({});

export const DispatchFollowupArgsSchema = z.strictObject({
  dispatchId: z.string().min(1).max(128),
  prompt: z
    .string()
    .max(60_000)
    .refine((value) => value.trim().length > 0, { message: "消息不能为空" }),
});

export const DispatchRefreshArgsSchema = z.strictObject({
  dispatchId: z.string().min(1).max(128),
});

export const NoticeReplyArgsSchema = z.strictObject({
  replyToken: z.string().min(1).max(128),
  text: z
    .string()
    .max(10_000)
    .refine((value) => value.trim().length > 0, { message: "回复不能为空" }),
});

const TaskPrioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const TaskNewProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  cwd: z.string().trim().min(1).max(4096).refine((value) => value.startsWith("/"), "项目文件夹必须是绝对路径").optional(),
});
const taskOneProject = (body: { projectId?: string | null | undefined; newProject?: unknown }): boolean =>
  !(body.newProject !== undefined && body.projectId);
const taskOneProjectMessage = { message: "projectId 与 newProject 只能二选一" };

export const TasksBoardArgsSchema = z.strictObject({});

export const TasksCreateArgsSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  projectId: z.string().min(1).max(200).nullable().optional(),
  newProject: TaskNewProjectSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  uploadIds: z.array(z.uuid()).max(4).optional(),
}).refine(taskOneProject, taskOneProjectMessage);

export const TasksUpdateArgsSchema = z.strictObject({
  id: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  retainImageIds: z.array(z.uuid()).max(4).optional(),
  uploadIds: z.array(z.uuid()).max(4).optional(),
  projectId: z.string().min(1).max(200).nullable().optional(),
  newProject: TaskNewProjectSchema.optional(),
  priority: TaskPrioritySchema.optional(),
}).refine(taskOneProject, taskOneProjectMessage);

export const TasksBlobPutArgsSchema = z.strictObject({
  uploadId: z.uuid(),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(128).optional(),
  totalBytes: z.number().int().positive().max(10 * 1024 * 1024),
  offset: z.number().int().nonnegative(),
  chunk: z.string().min(1).max(56 * 1024),
  final: z.boolean(),
});

export const TasksBlobGetArgsSchema = z.strictObject({
  taskId: z.string().min(1).max(200),
  imageId: z.uuid(),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().positive().max(140 * 1024).optional(),
});

export const TasksActionArgsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("project"), projectId: z.string().min(1).max(200), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("start"), id: z.string().min(1).max(200) }),
  z.strictObject({ action: z.literal("complete"), id: z.string().min(1).max(200) }),
  z.strictObject({ action: z.literal("retry"), id: z.string().min(1).max(200) }),
  z.strictObject({ action: z.literal("approve"), id: z.string().min(1).max(200), reviewSha: z.string().regex(/^[a-f0-9]{40,64}$/u) }),
  z.strictObject({ action: z.literal("reject"), id: z.string().min(1).max(200), feedback: z.string().trim().min(1).max(10_000) }),
]);

export const TasksReviewArgsSchema = z.strictObject({
  id: z.string().min(1).max(200),
});

export const RD_QUALITIES = ["smooth", "hd", "ultra"] as const;
export type RdQuality = (typeof RD_QUALITIES)[number];
export const RdQualitySchema = z.enum(RD_QUALITIES);

const RD_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/u;

export const RdOpenArgsSchema = z.strictObject({
  sessionId: z.string().regex(RD_SESSION_ID_RE).optional(),
  offerSdp: z.string().min(1).max(48_000),
  quality: RdQualitySchema.optional(),
  displayId: z.number().int().nonnegative().optional(),
});

export type RdOpenArgs = z.infer<typeof RdOpenArgsSchema>;

export const RdIceCandidateSchema = z.strictObject({
  candidate: z.string().max(2048),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(32).nullable().optional(),
  usernameFragment: z.string().max(128).nullable().optional(),
});

export type RdIceCandidate = z.infer<typeof RdIceCandidateSchema>;

export const RdIceArgsSchema = z.strictObject({
  sessionId: z.string().regex(RD_SESSION_ID_RE),
  candidates: z.array(RdIceCandidateSchema).min(1).max(32),
});

export type RdIceArgs = z.infer<typeof RdIceArgsSchema>;

export const RdCloseArgsSchema = z.strictObject({
  sessionId: z.string().regex(RD_SESSION_ID_RE),
});

export type RdCloseArgs = z.infer<typeof RdCloseArgsSchema>;

export const RdDisplayInfoSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  name: z.string().min(1).max(120),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scaleFactor: z.number().positive(),
  primary: z.boolean(),
});

export type RdDisplayInfo = z.infer<typeof RdDisplayInfoSchema>;

export const RdPermissionsSchema = z.strictObject({
  screenRecording: z.boolean(),
  accessibility: z.boolean(),
});

export type RdPermissions = z.infer<typeof RdPermissionsSchema>;

export const RdOpenResultSchema = z.strictObject({
  sessionId: z.string().regex(RD_SESSION_ID_RE),
  answerSdp: z.string().min(1),
  displays: z.array(RdDisplayInfoSchema),
  activeDisplayId: z.number().int().nonnegative(),
  permissions: RdPermissionsSchema,
});

export type RdOpenResult = z.infer<typeof RdOpenResultSchema>;

export const IceServerEntrySchema = z.strictObject({
  urls: z.array(z.string().min(1)).min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type IceServerEntry = z.infer<typeof IceServerEntrySchema>;

export const DispatchCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("t3.projects"), args: T3ProjectsArgsSchema }),
  z.strictObject({ kind: z.literal("t3.start"), args: T3StartArgsSchema }),
  z.strictObject({ kind: z.literal("t3.followup"), args: T3FollowupArgsSchema }),
  z.strictObject({ kind: z.literal("t3.read"), args: T3ReadArgsSchema }),
  z.strictObject({ kind: z.literal("t3.threads"), args: T3ThreadsArgsSchema }),
  z.strictObject({ kind: z.literal("agent.session"), args: AgentSessionArgsSchema }),
  z.strictObject({ kind: z.literal("agent.send"), args: AgentSendArgsSchema }),
  z.strictObject({ kind: z.literal("agent.read"), args: AgentReadArgsSchema }),
  z.strictObject({ kind: z.literal("dispatch.list"), args: DispatchListArgsSchema }),
  z.strictObject({ kind: z.literal("dispatch.followup"), args: DispatchFollowupArgsSchema }),
  z.strictObject({ kind: z.literal("dispatch.refresh"), args: DispatchRefreshArgsSchema }),
  z.strictObject({ kind: z.literal("notice.reply"), args: NoticeReplyArgsSchema }),
  z.strictObject({ kind: z.literal("tasks.board"), args: TasksBoardArgsSchema }),
  z.strictObject({ kind: z.literal("tasks.create"), args: TasksCreateArgsSchema }),
  z.strictObject({ kind: z.literal("tasks.update"), args: TasksUpdateArgsSchema }),
  z.strictObject({ kind: z.literal("tasks.action"), args: TasksActionArgsSchema }),
  z.strictObject({ kind: z.literal("tasks.review"), args: TasksReviewArgsSchema }),
  z.strictObject({ kind: z.literal("tasks.blob.put"), args: TasksBlobPutArgsSchema }),
  z.strictObject({ kind: z.literal("tasks.blob.get"), args: TasksBlobGetArgsSchema }),
  z.strictObject({ kind: z.literal("rd.open"), args: RdOpenArgsSchema }),
  z.strictObject({ kind: z.literal("rd.ice"), args: RdIceArgsSchema }),
  z.strictObject({ kind: z.literal("rd.close"), args: RdCloseArgsSchema }),
]);

export type DispatchCommand = z.infer<typeof DispatchCommandSchema>;

/** 参与签名的字段。`t` 与 `sig` 不进入规范串。 */
export interface CommandSigningFields {
  cmdId: string;
  from: string;
  to: string;
  ts: number;
  nonce: string;
  cmd: { kind: string; args: unknown };
}

export const CmdFrameSchema = z.strictObject({
  t: z.literal("cmd"),
  cmdId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  cmd: z.strictObject({
    kind: z.string().min(1),
    args: z.unknown(),
  }),
  ts: z.number(),
  nonce: z.string().min(1),
  sig: z.string().min(1),
});

export type CmdFrame = z.infer<typeof CmdFrameSchema>;

export const CmdResultFrameSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    t: z.literal("cmdres"),
    cmdId: z.string().min(1),
    from: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    t: z.literal("cmdres"),
    cmdId: z.string().min(1),
    from: z.string().min(1),
    ok: z.literal(false),
    error: z.string(),
  }),
]);

export type CmdResultFrame = z.infer<typeof CmdResultFrameSchema>;

export const ThreadStatusDataSchema = z.strictObject({
  threadId: z.string(),
  status: z.string(),
  previous: z.string().nullable(),
  title: z.string(),
  link: z.string().nullable(),
});

export const AgentStatusDataSchema = z.strictObject({
  sessionId: z.string().min(1),
  threadId: z.string().nullable(),
  status: z.string(),
  previous: z.string().nullable(),
  title: z.string(),
  link: z.string().nullable(),
});

export const OutboxUpdatedDataSchema = z.strictObject({
  dispatchId: z.string().min(1),
  status: z.string(),
  title: z.string(),
  deviceName: z.string(),
  updatedAt: z.number(),
  lastSummary: z.string().optional(),
  error: z.string().optional(),
  threadUrl: z.string().optional(),
});

export const RdIceEventDataSchema = z.strictObject({
  sessionId: z.string().regex(RD_SESSION_ID_RE),
  candidates: z.array(RdIceCandidateSchema).min(1).max(32),
});

export type RdIceEventData = z.infer<typeof RdIceEventDataSchema>;

export const RdStateEventDataSchema = z.strictObject({
  sessionId: z.string().regex(RD_SESSION_ID_RE),
  state: z.enum(["ready", "closed", "error"]),
  displays: z.array(RdDisplayInfoSchema).optional(),
  activeDisplayId: z.number().int().nonnegative().optional(),
  permissions: RdPermissionsSchema.optional(),
  error: z.string().optional(),
});

export type RdStateEventData = z.infer<typeof RdStateEventDataSchema>;

export const EventFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    t: z.literal("event"),
    from: z.string().min(1),
    dispatchId: z.string().min(1),
    kind: z.literal("thread.status"),
    data: ThreadStatusDataSchema,
  }),
  z.strictObject({
    t: z.literal("event"),
    from: z.string().min(1),
    dispatchId: z.string().min(1),
    kind: z.literal("agent.status"),
    data: AgentStatusDataSchema,
  }),
  z.strictObject({
    t: z.literal("event"),
    from: z.string().min(1),
    dispatchId: z.string().min(1),
    kind: z.literal("outbox.updated"),
    data: OutboxUpdatedDataSchema,
  }),
  z.strictObject({
    t: z.literal("event"),
    from: z.string().min(1),
    dispatchId: z.string().min(1),
    kind: z.literal("rd.ice"),
    data: RdIceEventDataSchema,
  }),
  z.strictObject({
    t: z.literal("event"),
    from: z.string().min(1),
    dispatchId: z.string().min(1),
    kind: z.literal("rd.state"),
    data: RdStateEventDataSchema,
  }),
]);

export type EventFrame = z.infer<typeof EventFrameSchema>;

export const MobilePushKindSchema = z.enum(["tty7", "t3", "dispatch", "reminder", "notice"]);
export type MobilePushKind = z.infer<typeof MobilePushKindSchema>;

export const MobilePushStatusSchema = z.enum(["done", "waiting", "failed", "info"]);
export type MobilePushStatus = z.infer<typeof MobilePushStatusSchema>;

export const MobilePushItemSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  kind: MobilePushKindSchema,
  status: MobilePushStatusSchema.optional(),
  title: z.string().max(200),
  body: z.string().max(8000),
  link: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  replyToken: z.string().nullable().optional(),
});

export type MobilePushItem = z.infer<typeof MobilePushItemSchema>;

export const HelloDispatchSchema = z.strictObject({
  enabled: z.boolean(),
  t3: z.strictObject({
    ready: z.boolean(),
    version: z.string().min(1).optional(),
  }),
  projects: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  maxMode: RuntimeModeSchema,
  /** 本机允许被同账号的已授权设备在指挥台里查看 T3（隧道）。旧版本不带这个字段，按 false 处理。 */
  viewT3: z.boolean().optional(),
  /** 本机允许被同账号的已授权设备发起远程桌面操作（WebRTC）。旧版本不带这个字段，按 false 处理。 */
  remoteDesktop: z.boolean().optional(),
  /** 设备运行角色（server 通常是 VPS 主控节点）。 */
  role: z.enum(["desktop", "server"]).optional(),
});

export type HelloDispatch = z.infer<typeof HelloDispatchSchema>;

/** 对象键递归按字典序，无空白。键序不同但内容相同则结果相同。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson 不接受非有限数字");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    if (!isPlainObject(value)) throw new TypeError("canonicalJson 只接受普通对象");
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  throw new TypeError("canonicalJson 不接受该类型");
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 规范串，UTF-8，用 `\n` 连接，末尾不加换行：
 * u-brain-cmd/1 / cmdId / from / to / ts / nonce / sha256(canonicalJson(cmd))
 */
export function signingString(frame: CommandSigningFields): string {
  const hash = createHash("sha256").update(canonicalJson(frame.cmd), "utf8").digest("hex");
  return [
    `u-brain-cmd/${DISPATCH_PROTOCOL_VERSION}`,
    frame.cmdId,
    frame.from,
    frame.to,
    String(frame.ts),
    frame.nonce,
    hash,
  ].join("\n");
}

/** 公钥 SPKI DER、私钥 PKCS8 DER，均 base64url。 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url"),
    privateKey: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString("base64url"),
  };
}

/** 从 PKCS8 DER（base64url）私钥推导出对应的 Ed25519 SPKI DER（base64url）公钥。 */
export function derivePublicKey(privateKey: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(privateKey)) throw new Error("无效的 Ed25519 私钥格式");
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("无法解析 Ed25519 私钥");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("私钥不是 Ed25519 密钥");
  return Buffer.from(createPublicKey(key).export({ type: "spki", format: "der" })).toString("base64url");
}

export function signCommand(privateKey: string, frame: CommandSigningFields): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(signingString(frame), "utf8"), key).toString("base64url");
}

/** 验签失败或公钥无法解析时返回 false，不抛错。 */
export function verifyCommand(publicKey: string, frame: CommandSigningFields & { sig: string }): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return verify(null, Buffer.from(signingString(frame), "utf8"), key, Buffer.from(frame.sig, "base64url"));
  } catch {
    return false;
  }
}

/** 16 字节随机数，base64url。 */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}
