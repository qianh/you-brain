/**
 * M0 第 5 项：Drive changes.list 的可见延迟，以及 60 秒轮询的配额推算。
 *
 * 不要在自动验证里运行。会用真实凭据在指定 Drive 根下新建 you-brain-m0-<时间>/，
 * 写 10 个小文件并轮询 changes.list，测完把该目录 trash。不读 ~/.you-brain，
 * 不写配置，不打开浏览器。
 *
 * 延迟测量用 500ms 轮询、每个样本最多 30 秒。60 秒只用于配额推算，不用于计时。
 * 每次写入前取 getStartPageToken，之后一直用这个 pageToken，直到看见该 fileId。
 *
 * 官方配额（2026-09-11，https://developers.google.com/workspace/drive/api/guides/limits）：
 * 每分钟每项目 1,000,000 units；每分钟每用户每项目 325,000；每天每项目出口 1 TB；
 * 日计费阈值 400,000,000 units。files.get 5、files.list 100、files.download 200、
 * files.update 50、其他 5。文档没有点名 changes.list / getStartPageToken。
 * 超限是 403，后端也可能回 429。旧的「12,000 次/分钟、每用户每 100 秒」不在这份文档里。
 * changes.watch 的通知本身不计配额，watch / channels.stop / files.watch 计入。
 *
 * 用法：
 *   YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID=... YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET=... \
 *     bun scripts/m0/drive-changes.ts --config /绝对路径/config.toml --drive-root brain-hub
 */
import { hasFlag, option } from "./args.ts";
import { headerMap, M0Skip, openM0Drive } from "./drive-auth.ts";
import { emit, errorText, redactSecrets, type M0Result } from "./result.ts";
import {
  changeListHasFile,
  DRIVE_QUOTA,
  isQuotaStatus,
  quotaHeaders,
  sixtySecondChangeQuota,
  summarizeLatencies,
} from "./stats.ts";

const item = "drive-changes";
const samples = 10;
const pollIntervalMs = 500;
const sampleBudgetMs = 30_000;
const maxPagesPerPoll = 20;

function usage(): string {
  return "bun scripts/m0/drive-changes.ts --config <config.toml> --drive-root <名称> [--create-root]";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ListedChange {
  fileId?: string | null;
  removed?: boolean | null;
  file?: { id?: string | null } | null;
}

interface ChangeListResponse {
  status: number;
  headers: unknown;
  data: {
    changes?: ListedChange[];
    nextPageToken?: string | null;
    newStartPageToken?: string | null;
  };
}

function rowsOf(changes: readonly ListedChange[]): { fileId: string | null; removed: boolean }[] {
  return changes.map((change) => ({
    fileId: change.fileId ?? change.file?.id ?? null,
    removed: change.removed === true,
  }));
}

interface Sample {
  index: number;
  fileId: string | null;
  latencyMs: number | null;
  writeMs: number | null;
  calls: number;
  pagesTruncated: boolean;
  statuses: number[];
  quotaStatuses: number[];
  quotaHeaders: Record<string, string>;
  error: string | null;
}

async function oneSample(
  opened: Awaited<ReturnType<typeof openM0Drive>>,
  folder: string,
  index: number,
): Promise<Sample> {
  const statuses: number[] = [];
  const quotaStatuses: number[] = [];
  const headerBag: Record<string, string> = {};
  let calls = 0;
  let pagesTruncated = false;
  const tokenResponse = await opened.client.changes.getStartPageToken({ supportsAllDrives: true });
  calls += 1;
  statuses.push(tokenResponse.status);
  Object.assign(headerBag, quotaHeaders(headerMap(tokenResponse.headers)));
  const startToken = tokenResponse.data.startPageToken;
  if (!startToken) {
    return {
      index,
      fileId: null,
      latencyMs: null,
      writeMs: null,
      calls,
      pagesTruncated,
      statuses,
      quotaStatuses,
      quotaHeaders: headerBag,
      error: "getStartPageToken 没有返回 pageToken",
    };
  }
  const writeStarted = performance.now();
  const created = await opened.drive.create({
    path: `${folder}/sample-${index}.txt`,
    bytes: Buffer.from("m0"),
    mimeType: "text/plain",
  });
  const writeFinished = performance.now();
  const deadline = writeFinished + sampleBudgetMs;
  let seenAt: number | null = null;
  while (performance.now() < deadline) {
    let pageToken: string | undefined = startToken;
    let pages = 0;
    let found = false;
    while (pageToken && pages < maxPagesPerPoll) {
      pages += 1;
      calls += 1;
      try {
        const response: ChangeListResponse = await opened.client.changes.list({
          pageToken,
          fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id))",
          pageSize: 1_000,
          spaces: "drive",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
        statuses.push(response.status);
        if (isQuotaStatus(response.status)) quotaStatuses.push(response.status);
        Object.assign(headerBag, quotaHeaders(headerMap(response.headers)));
        const changes = response.data.changes ?? [];
        if (changeListHasFile(rowsOf(changes), created.id)) {
          found = true;
          seenAt = performance.now();
          break;
        }
        pageToken = response.data.nextPageToken ?? undefined;
      } catch (error) {
        const status = statusOf(error);
        if (status !== null) statuses.push(status);
        if (isQuotaStatus(status)) quotaStatuses.push(status);
        Object.assign(headerBag, quotaHeaders(headerMap(headersOf(error))));
        return {
          index,
          fileId: created.id,
          latencyMs: null,
          writeMs: Math.round(writeFinished - writeStarted),
          calls,
          pagesTruncated,
          statuses,
          quotaStatuses,
          quotaHeaders: headerBag,
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
        };
      }
    }
    if (!found && pages >= maxPagesPerPoll) pagesTruncated = true;
    if (found) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  return {
    index,
    fileId: created.id,
    latencyMs: seenAt === null ? null : Math.round(seenAt - writeFinished),
    writeMs: Math.round(writeFinished - writeStarted),
    calls,
    pagesTruncated,
    statuses,
    quotaStatuses,
    quotaHeaders: headerBag,
    error: seenAt === null ? `30 秒内 changes.list 没有看见 ${created.id}` : null,
  };
}

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === "number" ? response.status : null;
}

function headersOf(error: unknown): unknown {
  if (!error || typeof error !== "object") return null;
  return (error as { response?: { headers?: unknown } }).response?.headers ?? null;
}

async function main(): Promise<void> {
  const configFile = option("--config");
  const driveRoot = option("--drive-root");
  const quota = sixtySecondChangeQuota(1);
  if (!configFile || !driveRoot) {
    emit(
      {
        item,
        ok: false,
        evidence: { usage: usage(), quota: { source: DRIVE_QUOTA, perDevice60s: quota } },
        notes: ["缺少 --config 或 --drive-root，未访问 Drive"],
      },
      2,
    );
  }
  const opened = await openM0Drive({
    configFile,
    driveRoot,
    createRoot: hasFlag("--create-root"),
  });
  const folder = `you-brain-m0-${Date.now()}`;
  let folderId: string | null = null;
  const notes = [
    "延迟用 500ms 轮询、N=10、每样本最多 30 秒，样本串行。60 秒一次是生产轮询（技术方案第 18 节），这里只拿来做配额推算。",
    "changes.list 不在官方方法表里。asList 按 files.list = 100 units，asOther 按其他动作 = 5 units。getStartPageToken 同样没有点名，测量时每次写入前会多叫一次。",
    "60 秒、1 台设备是 1440 次/天。按 100 units 计为 100 units/分钟，占每用户每分钟 325,000 的约 0.0308%，占每项目每分钟 1,000,000 的 0.01%；每天 144,000 units，占日计费阈值 400,000,000 的 0.036%。按 5 units 计再除以 20。",
    "多台设备线性相乘。通知通道的推送不计配额，但本脚本不调用 changes.watch。",
    "现行文档没有「12,000 queries/minute」或「每用户每 100 秒」。超限响应是 403，也可能是 429。",
  ];
  let result: M0Result | null = null;
  let code: 0 | 1 = 1;
  try {
    folderId = await opened.drive.ensureFolder(folder);
    const taken: Sample[] = [];
    for (let index = 0; index < samples; index += 1) {
      taken.push(await oneSample(opened, folder, index));
    }
    const latencies = taken.flatMap((sample) => (sample.latencyMs === null ? [] : [sample.latencyMs]));
    const quotaHits = taken.reduce((sum, sample) => sum + sample.quotaStatuses.length, 0);
    const ok = taken.length === samples && taken.every((sample) => sample.latencyMs !== null && sample.error === null) && quotaHits === 0;
    result = {
      item,
      ok,
      evidence: {
        folder,
        folderId,
        createdRoot: opened.createdRoot,
        pollIntervalMs,
        sampleBudgetMs,
        samples: taken,
        latency: latencies.length > 0 ? summarizeLatencies(latencies) : null,
        quotaHits,
        quota: { source: DRIVE_QUOTA, perDevice60s: quota },
      },
      notes,
    };
    code = ok ? 0 : 1;
  } finally {
    const trashId = opened.createdRoot ? opened.rootFolderId : folderId;
    if (trashId) {
      try {
        await opened.drive.trash(trashId);
      } catch (error) {
        process.stderr.write(`trash 失败 ${trashId}: ${redactSecrets(errorText(error))}\n`);
      }
    }
  }
  if (result) emit(result, code);
}

try {
  await main();
} catch (error) {
  const skip = error instanceof M0Skip;
  emit(
    {
      item,
      ok: false,
      evidence: {
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
        usage: usage(),
        quota: { source: DRIVE_QUOTA, perDevice60s: sixtySecondChangeQuota(1) },
      },
      notes: [],
    },
    skip ? 2 : 1,
  );
}
