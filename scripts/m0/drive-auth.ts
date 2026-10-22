/**
 * Open Drive the way the daemon does, without writing config or scanning the
 * default data directory. Callers must pass --config and --drive-root.
 * Missing credentials throw M0Skip (exit 2). This module does not run itself.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  createConfigSecretStore,
  createOAuthClientSecretStore,
  GoogleOAuth,
  isUsableOfficialOAuthClient,
  resolveOfficialOAuthClient,
} from "../../packages/core/src/auth/index.ts";
import { LocalConfigSchema, type LocalConfig } from "../../packages/core/src/domain/config.ts";
import { GoogleDrive } from "../../packages/core/src/drive/google-drive.ts";
import { repoRoot } from "./layout.ts";

const require = createRequire(import.meta.url);

type DriveClient = ConstructorParameters<typeof GoogleDrive>[0]["client"];

function loadToml(): { parse(text: string): unknown } {
  return require(join(repoRoot, "packages/core/node_modules/@iarna/toml/toml.js")) as {
    parse(text: string): unknown;
  };
}

function loadDriveFactory(): (options: { version: "v3"; auth: unknown }) => DriveClient {
  const loaded = require(join(repoRoot, "packages/core/node_modules/googleapis/build/src/index.js")) as {
    google: { drive: (options: { version: "v3"; auth: unknown }) => DriveClient };
  };
  return loaded.google.drive;
}

export class M0Skip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "M0Skip";
  }
}

const folderMimeType = "application/vnd.google-apps.folder";

function camelKey(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function mapKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => mapKeys(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [camelKey(key), mapKeys(child)]),
  );
}

export async function readConfigFile(configFile: string): Promise<LocalConfig> {
  let text: string;
  try {
    text = await readFile(configFile, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new M0Skip(`找不到配置 ${configFile}`);
    throw error;
  }
  try {
    return LocalConfigSchema.parse(mapKeys(loadToml().parse(text)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new M0Skip(`配置无法解析：${message}`);
  }
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export interface OpenedDrive {
  drive: GoogleDrive;
  client: DriveClient;
  rootFolderId: string;
  createdRoot: boolean;
  driveRoot: string;
}

export async function openM0Drive(input: {
  configFile: string;
  driveRoot: string;
  createRoot: boolean;
}): Promise<OpenedDrive> {
  if (!input.driveRoot.trim()) throw new M0Skip("需要 --drive-root <名称>");
  const local = await readConfigFile(input.configFile);
  if (local.oauth.mode === "official" && !isUsableOfficialOAuthClient(resolveOfficialOAuthClient(process.env))) {
    throw new M0Skip(
      "官方 OAuth 客户端不可用。请设置 YOU_BRAIN_GOOGLE_OAUTH_CLIENT_ID 和 YOU_BRAIN_GOOGLE_OAUTH_CLIENT_SECRET，或换用已写入自定义凭据的配置。脚本不会打开浏览器。",
    );
  }
  const secrets = createConfigSecretStore({
    platform: process.platform,
    configFile: input.configFile,
  });
  const oauth =
    local.oauth.mode === "custom"
      ? new GoogleOAuth(
          {
            mode: "custom",
            clientId: local.oauth.clientId,
            clientSecret: null,
            clientSecretStore: createOAuthClientSecretStore({
              platform: process.platform,
              configFile: input.configFile,
            }),
          },
          secrets,
        )
      : new GoogleOAuth({ mode: "official", env: process.env }, secrets);
  let auth: Awaited<ReturnType<GoogleOAuth["getClient"]>>;
  try {
    auth = await oauth.getClient({ interactive: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new M0Skip(`没有可用的 Drive 凭据（不交互登录）：${message}`);
  }
  const client = loadDriveFactory()({ version: "v3", auth });
  const listed = await client.files.list({
    q: `'root' in parents and name = '${escapeQuery(input.driveRoot)}' and mimeType = '${folderMimeType}' and trashed = false`,
    fields: "files(id)",
    pageSize: 100,
    spaces: "drive",
  });
  const ids = (listed.data.files ?? []).flatMap((file) => (file.id ? [file.id] : [])).sort();
  if (ids.length > 1) {
    throw new Error(`Drive 根目录 ${input.driveRoot} 有多个匹配：${ids.join(", ")}`);
  }
  let rootFolderId = ids[0];
  let createdRoot = false;
  if (!rootFolderId) {
    if (!input.createRoot) {
      throw new M0Skip(
        `My Drive 根上没有名为 ${input.driveRoot} 的文件夹。确认名称，或显式加上 --create-root 让脚本新建它。`,
      );
    }
    const created = await client.files.create({
      requestBody: { name: input.driveRoot, mimeType: folderMimeType, parents: ["root"] },
      fields: "id",
    });
    if (!created.data.id) throw new Error("Drive 没有返回新建根目录的 id");
    rootFolderId = created.data.id;
    createdRoot = true;
  }
  return {
    drive: new GoogleDrive({ client, rootFolderId }),
    client,
    rootFolderId,
    createdRoot,
    driveRoot: input.driveRoot,
  };
}

export function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => unknown).call(headers, name);
    if (typeof value === "string") return value;
  }
  const record = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === "string") return value;
  }
  return null;
}

export function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;
  const foreach = (headers as { forEach?: unknown }).forEach;
  if (typeof foreach === "function") {
    (foreach as (fn: (value: unknown, key: unknown) => void) => void).call(headers, (value, key) => {
      if (typeof key === "string" && (typeof value === "string" || typeof value === "number")) {
        out[key.toLowerCase()] = String(value);
      }
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") out[key.toLowerCase()] = String(value);
  }
  return out;
}
