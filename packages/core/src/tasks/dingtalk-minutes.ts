import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { DingTalkMinutesPage, DingTalkMinutesSource } from "./types.js";

const origin = "https://shanji.dingtalk.com";
export const dingTalkTaskId = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.~+=-]{0,199}$/u);
export const dingTalkMinutesQuery = z.object({
  query: z.string().trim().max(200).regex(/^[^\u0000-\u001f]*$/u).optional(),
  cursor: z.string().min(1).max(2048).regex(/^[^\u0000-\u001f]+$/u).optional(),
});
export type DingTalkMinutesQuery = z.infer<typeof dingTalkMinutesQuery>;
export type DingTalkMinutesDetail = { source: DingTalkMinutesSource; actions: Array<{ id?: string; text: string }> };
export const DINGTALK_SYNC_SCOPES = ["mine", "shared"] as const;
type DingTalkSyncScope = typeof DINGTALK_SYNC_SCOPES[number];
export interface DingTalkMinutesPort {
  list(input: DingTalkMinutesQuery): Promise<DingTalkMinutesPage>;
  listForSync(input: { scope: DingTalkSyncScope; start: string; end: string; cursor?: string | undefined }, signal?: AbortSignal): Promise<{ taskUuids: string[]; nextCursor: string | null }>;
  detail(taskUuid: string, signal?: AbortSignal): Promise<DingTalkMinutesDetail>;
}

export const dingTalkMinutesErrors = {
  DINGTALK_NOT_INSTALLED: [503, "未找到钉钉 CLI，请在运行 U-Brain 的设备上安装 dingtalk-workspace-cli。"],
  DINGTALK_AUTH_REQUIRED: [503, "请在运行 U-Brain 的设备上执行 dws auth login，然后重试。"],
  DINGTALK_FORBIDDEN: [403, "当前钉钉账号无权读取此听记，或组织未开通 CLI 权限。"],
  DINGTALK_NOT_FOUND: [404, "未找到此听记，请检查链接或当前钉钉账号。"],
  DINGTALK_TIMEOUT: [504, "读取钉钉听记超时，请重试。"],
  DINGTALK_BAD_RESPONSE: [502, "无法读取钉钉听记，请检查 dws 版本和连接后重试。"],
  DINGTALK_INVALID_LINK: [400, "请输入有效的钉钉听记链接。"],
  DINGTALK_LIMIT: [422, "钉钉行动项数量或长度超过单次导入上限。"],
} as const;

export class DingTalkMinutesError extends Error {
  readonly status: number;

  constructor(readonly code: keyof typeof dingTalkMinutesErrors) {
    const [status, message] = dingTalkMinutesErrors[code];
    super(message);
    this.status = status;
  }
}

export function parseDingTalkMinutesLink(value: string): string {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password) throw new Error();
    const ids = [...url.searchParams.getAll("taskUuid"), ...url.searchParams.getAll("minutesId")];
    const pathId = /^\/(?:app\/)?transcribes\/([^/]+)\/?$/u.exec(url.pathname)?.[1];
    if (pathId !== undefined) ids.push(decodeURIComponent(pathId));
    if (new Set(ids).size !== 1) throw new Error();
    return dingTalkTaskId.parse(ids[0]);
  } catch {
    throw new DingTalkMinutesError("DINGTALK_INVALID_LINK");
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function commandError(stdout: string, stderr: string, exitCode?: number | string): DingTalkMinutesError {
  const fields = [stdout, stderr].flatMap((output) => {
    const payload = record(parseJson(output));
    return [payload, record(payload.error)];
  });
  const codes = fields.flatMap((error) => [error.code, error.reason, error.subtype, error.server_error_code]).join(" ");
  const errors = `${codes} ${fields.map((error) => error.message).join(" ")} ${stderr.slice(0, 4096)}`;
  if (/CLI_ORG_NOT_AUTHORIZED|TOKEN_VERIFIED_FAILED|forbidden|permission.denied|access.denied|no.permission|无权|权限不足|组织未开通/iu.test(errors)) return new DingTalkMinutesError("DINGTALK_FORBIDDEN");
  if (exitCode === 2 || fields.some((error) => error.category === "auth" || error.type === "auth") ||
    /unauthorized|not.logged.in|auth.required|invalid.grant|login.required|未登录|请先登录|dws auth login/iu.test(errors)) return new DingTalkMinutesError("DINGTALK_AUTH_REQUIRED");
  if (/not.found|不存在/iu.test(codes)) return new DingTalkMinutesError("DINGTALK_NOT_FOUND");
  if (/timeout|deadline.exceeded|超时/iu.test(errors)) return new DingTalkMinutesError("DINGTALK_TIMEOUT");
  return new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
}

async function resolveDws(env: NodeJS.ProcessEnv, homeDir: string): Promise<string> {
  const directories = [...(env.PATH ?? "").split(delimiter), join(homeDir, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of new Set(directories.filter(isAbsolute))) {
    const candidate = join(dir, "dws");
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { continue; }
  }
  throw new DingTalkMinutesError("DINGTALK_NOT_INSTALLED");
}

function runDws(bin: string, args: string[], env: NodeJS.ProcessEnv, homeDir: string, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, [...args, "--format", "json", "--timeout", "20"], {
      cwd: homeDir, env: { ...env, NO_COLOR: "1" }, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? new DingTalkMinutesError("DINGTALK_TIMEOUT") : commandError(stdout, stderr, error.code));
        return;
      }
      const payload = parseJson(stdout);
      if (!payload || record(payload).ok === false || record(payload).success === false) reject(commandError(stdout, stderr));
      else resolve(payload);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
  });
}

const listRow = z.object({ taskUuid: dingTalkTaskId, title: z.string().trim().min(1).max(255), startTime: z.union([z.number(), z.string().max(64)]).optional() });
const listData = z.object({ minutes: z.array(listRow).max(100), nextToken: dingTalkMinutesQuery.shape.cursor });
const syncListRow = z.object({ taskUuid: dingTalkTaskId.optional(), taskUUID: dingTalkTaskId.optional(), task_uuid: dingTalkTaskId.optional(), uuid: dingTalkTaskId.optional() });
const syncListData = z.object({
  itemList: z.array(syncListRow).max(100), hasMore: z.boolean().optional(), hasNext: z.boolean().optional(),
  nextToken: z.union([dingTalkMinutesQuery.shape.cursor, z.literal(""), z.null()]),
});
const detailData = z.object({
  complete: z.literal(true), taskUuid: dingTalkTaskId,
  basic: z.object({ result: z.object({ title: z.string().trim().min(1).max(255) }) }),
  todos: z.object({ result: z.object({ taskUuid: dingTalkTaskId, state: z.enum(["ready", "known_empty"]), items: z.array(z.unknown()) }) }),
});
const actionText = z.string().trim().min(1).refine((value) => !value.includes("\0"));
const actionObject = z.object({
  minutesTodoId: z.string().trim().min(1).max(200).nullish(),
  title: z.string().nullish(), content: z.string().nullish(), text: z.string().nullish(),
});

function parseAction(value: unknown): DingTalkMinutesDetail["actions"][number] {
  const plain = actionText.safeParse(value);
  if (plain.success) return { text: plain.data };
  const action = actionObject.safeParse(value);
  if (!action.success) throw new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
  const { minutesTodoId } = action.data;
  const title = action.data.title?.trim();
  const content = action.data.content?.trim() || action.data.text?.trim();
  const text = actionText.safeParse(title && content && title !== content ? `${title}\n${content}` : content || title);
  if (!text.success) throw new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
  return { text: text.data, ...(minutesTodoId ? { id: minutesTodoId } : {}) };
}

export function createDingTalkMinutes(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  run?: (args: string[], signal?: AbortSignal) => Promise<unknown>;
} = {}): DingTalkMinutesPort {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const run = options.run ?? (async (args, signal) => runDws(await resolveDws(env, homeDir), args, env, homeDir, signal));
  return {
    async list({ query, cursor }) {
      const raw = record(await run(["minutes", "+list-all", "--limit=20", ...(query ? [`--query=${query}`] : []), ...(cursor ? [`--cursor=${cursor}`] : [])]));
      const response = listData.safeParse(raw.data ?? raw);
      const pagination = record(record(raw.meta).pagination);
      const next = dingTalkMinutesQuery.shape.cursor.safeParse(pagination.next_token ?? (response.success ? response.data.nextToken : undefined));
      if (!response.success || !next.success || (next.data !== undefined && next.data === cursor)) throw new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
      const items = response.data.minutes.map(({ taskUuid, title, startTime }) => ({
        taskUuid, title, ...(startTime === undefined ? {} : { startTime }),
      }));
      return { items, nextCursor: next.data ?? null };
    },
    async listForSync({ scope, start, end, cursor }, signal) {
      const raw = record(await run(["minutes", "list", scope, "--limit=20", `--start=${start}`, `--end=${end}`, ...(cursor ? [`--cursor=${cursor}`] : [])], signal));
      const data = record(raw.data ?? raw);
      const page = syncListData.safeParse(data.result ?? data);
      if (data.success === false || !page.success) throw new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
      const pagination = record(record(raw.meta).pagination);
      const next = dingTalkMinutesQuery.shape.cursor.safeParse(pagination.next_token ?? (page.data.nextToken || undefined));
      const hasMore = page.data.hasMore ?? page.data.hasNext ?? (pagination.endpoint_exhausted === false ? true : undefined);
      if (!next.success || (next.data !== undefined && (next.data === cursor || hasMore === false)) ||
        (hasMore === true && next.data === undefined)) throw new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
      const taskUuids = page.data.itemList.map((item) => {
        const taskUuid = item.taskUuid ?? item.taskUUID ?? item.task_uuid ?? item.uuid;
        if (!taskUuid) throw new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
        return taskUuid;
      });
      return { taskUuids, nextCursor: next.data ?? null };
    },
    async detail(taskUuid, signal) {
      const raw = record(await run(["minutes", "+detail", `--id=${taskUuid}`, "--artifacts=basic,todos"], signal));
      const response = detailData.safeParse(raw.data ?? raw);
      if (!response.success) throw new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
      const { basic, todos } = response.data;
      if (response.data.taskUuid !== taskUuid || todos.result.taskUuid !== taskUuid ||
        (todos.result.state === "known_empty") !== (todos.result.items.length === 0)) {
        throw new DingTalkMinutesError("DINGTALK_BAD_RESPONSE");
      }
      return { source: { taskUuid, title: basic.result.title }, actions: todos.result.items.map(parseAction) };
    },
  };
}
