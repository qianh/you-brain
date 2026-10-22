/**
 * M0 第 3 项：Drive files.update 的 etag 并发行为。
 *
 * 不要在自动验证里运行。会用真实凭据在指定 Drive 根下新建 you-brain-m0-<时间>/，
 * 测完把该目录 trash。不读 ~/.you-brain，不写配置，不打开浏览器。
 *
 * 前置条件：
 * - --config <config.toml>  显式路径。密钥仍从该路径对应的钥匙串项读取（与 daemon 相同）。
 * - --drive-root <文件夹名>  必须已在 My Drive 根上存在，除非同时给 --create-root。
 * - 官方 OAuth：环境变量 YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID / YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET。
 *   自定义 OAuth：配置里的 client id，密钥在钥匙串。
 *
 * 用法：
 *   YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID=... YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET=... \
 *     bun scripts/m0/drive-etag.ts --config /绝对路径/config.toml --drive-root brain-hub
 *
 * GoogleDrive.update 在发请求前会自己再读一次 etag，客户端不一致就抛 ConflictError。
 * 所以并发测试分两段：走 GoogleDrive.update 的两路竞赛，以及绕过客户端比较、
 * 用 googleapis 直接带过期 If-Match 的 update（记录 HTTP 状态）。后者才是
 * 「服务端是否拒绝过期 etag」。
 */
import { Readable } from "node:stream";

import { hasFlag, option } from "./args.ts";
import { headerValue, M0Skip, openM0Drive } from "./drive-auth.ts";
import { emit, errorText, redactSecrets, type M0Result } from "./result.ts";
import { ConflictError } from "../../packages/core/src/drive/errors.ts";
import { updateJsonWithMerge } from "../../packages/core/src/upload/write.ts";
import { httpStatus, mergeIdsPreserved, raceMatchesExpectation, tallyRace } from "./stats.ts";

const item = "drive-etag";

function usage(): string {
  return "bun scripts/m0/drive-etag.ts --config <config.toml> --drive-root <名称> [--create-root]";
}

async function rawUpdate(
  client: Awaited<ReturnType<typeof openM0Drive>>["client"],
  fileId: string,
  body: string,
  ifMatch: string,
): Promise<{ status: number | null; error: string | null }> {
  try {
    const response = await client.files.update(
      {
        fileId,
        media: { mimeType: "text/plain", body: Readable.from(Buffer.from(body)) },
        fields: "id,version",
        supportsAllDrives: true,
      },
      { headers: { "If-Match": ifMatch } },
    );
    return { status: response.status, error: null };
  } catch (error) {
    return { status: httpStatus(error), error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}

async function main(): Promise<void> {
  const configFile = option("--config");
  const driveRoot = option("--drive-root");
  if (!configFile || !driveRoot) {
    emit({ item, ok: false, evidence: { usage: usage() }, notes: ["缺少 --config 或 --drive-root，未访问 Drive"] }, 2);
  }
  const opened = await openM0Drive({
    configFile,
    driveRoot,
    createRoot: hasFlag("--create-root"),
  });
  const stamp = Date.now();
  const folder = `you-brain-m0-${stamp}`;
  let folderId: string | null = null;
  const notes = [
    "GoogleDrive.update 先 GET 元数据，etag 不一致就在本地抛 ConflictError，然后才把 If-Match 交给服务端。",
    "updateJsonWithMerge 的生产默认重试是 5（upload/write.ts）。8 路并发这里用 maxAttempts 12，避免把重试上限当成合并丢失。",
  ];
  let result: M0Result | null = null;
  let code: 0 | 1 = 1;
  try {
    folderId = await opened.drive.ensureFolder(folder);
    const created = await opened.drive.create({
      path: `${folder}/etag.txt`,
      bytes: Buffer.from("base"),
      mimeType: "text/plain",
    });
    const meta = await opened.client.files.get({
      fileId: created.id,
      fields: "id,version",
      supportsAllDrives: true,
    });
    const headerEtag = headerValue(meta.headers, "etag");
    const version = meta.data.version ?? null;
    const outcomes = await Promise.all(
      ["device-a", "device-b"].map(async (name) => {
        try {
          await opened.drive.update(created.id, name, { ifMatch: created.etag, mimeType: "text/plain" });
          return "success" as const;
        } catch (error) {
          if (error instanceof ConflictError) return "conflict" as const;
          return "other" as const;
        }
      }),
    );
    const tally = tallyRace(outcomes);
    const current = await opened.client.files.get({
      fileId: created.id,
      fields: "id,version",
      supportsAllDrives: true,
    });
    const currentEtag = headerValue(current.headers, "etag");
    const stale = await rawUpdate(opened.client, created.id, "stale-write", created.etag);
    const freshEtag = headerValue(
      (await opened.client.files.get({
        fileId: created.id,
        fields: "id,version",
        supportsAllDrives: true,
      })).headers,
      "etag",
    );
    const currentMatch = freshEtag
      ? await rawUpdate(opened.client, created.id, "fresh-write", freshEtag)
      : { status: null, error: "响应没有 etag 头，无法做当前 etag 对照" };
    const versionMatch =
      version !== null && String(version) !== (headerEtag ?? "")
        ? await rawUpdate(opened.client, created.id, "version-string", String(version))
        : null;
    const ids = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
    const merged = await Promise.all(
      ids.map((id) =>
        updateJsonWithMerge<{ ids: string[] }>(
          opened.drive,
          `${folder}/merge.json`,
          (currentValue) => {
            const seen = Array.isArray(currentValue?.ids) ? currentValue.ids : [];
            return { ids: [...seen, id] };
          },
          { maxAttempts: 12 },
        ),
      ),
    );
    const finalIds = merged.at(-1)?.value.ids ?? [];
    const preserved = mergeIdsPreserved(finalIds, ids);
    const serverRejectsStale = stale.status === 412;
    const serverAcceptsCurrent = currentMatch.status === 200;
    const ok = raceMatchesExpectation(tally) && serverRejectsStale && serverAcceptsCurrent && preserved.ok;
    if (!serverRejectsStale) {
      notes.push("服务端没有用 412 拒绝过期 If-Match。GoogleDrive 的客户端比较不能代替这一结果。");
    }
    result = {
      item,
      ok,
      evidence: {
        folder,
        folderId,
        createdRoot: opened.createdRoot,
        fileId: created.id,
        googleDriveEtag: created.etag,
        headerEtag,
        version,
        currentEtag,
        race: { outcomes, tally, expected: "恰有一个 success 和一个 conflict" },
        server: {
          staleIfMatch: stale,
          currentIfMatch: currentMatch,
          versionStringIfMatch: versionMatch,
        },
        merge: { maxAttempts: 12, productionDefault: 5, finalIds, preserved },
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
        process.stderr.write(`trash 失败 ${trashId}: ${errorText(error)}\n`);
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
    { item, ok: false, evidence: { error: redactSecrets(error instanceof Error ? error.message : String(error)), usage: usage() }, notes: [] },
    skip ? 2 : 1,
  );
}
