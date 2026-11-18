// Adapted from Meta's muse-gadget-sdk and wong2/muse-client (Apache-2.0).
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { object, requiredString, type DeviceCredentials } from "./api.js";

export function externalCredentialsDirectory(home = homedir(), platform = process.platform): string {
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "MuseGadgetPair")
    : "/var/lib/musegadget";
}

export async function hasPairingFiles(directory: string): Promise<boolean> {
  try {
    await Promise.all([
      access(join(directory, "pairing.json")),
      access(join(directory, "identity.json")),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function importExternalPairing(
  sourceDirectory: string,
  targetDirectory: string,
): Promise<DeviceCredentials> {
  const loaded = await loadCredentials(sourceDirectory);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await copyFile(join(sourceDirectory, "identity.json"), join(targetDirectory, "identity.json"));
  await saveCredentials(loaded, targetDirectory);
  if (loaded.sdkToken) {
    const tokenPath = join(targetDirectory, "sdk_token");
    const tmp = `${tokenPath}.${randomUUID()}.tmp`;
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(`${loaded.sdkToken}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, tokenPath);
  }
  return loaded;
}

export async function unpair(directory: string): Promise<boolean> {
  const lockPath = join(directory, "pair.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (code === "EEXIST") {
      throw new Error("正在进行蓝牙配对，请先取消配对后再解除绑定。");
    }
    throw error;
  }
  try {
    await lock.writeFile(String(process.pid));
    try {
      await unlink(join(directory, "pairing.json"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function loadCredentials(directory: string): Promise<DeviceCredentials> {
  const [pairing, identity] = await Promise.all([
    readFile(join(directory, "pairing.json"), "utf8").then((s) => object(JSON.parse(s))),
    readFile(join(directory, "identity.json"), "utf8").then((s) => object(JSON.parse(s))),
  ]);
  const mac = requiredString(identity.mac, "paired identity MAC");
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) {
    throw new Error("无效的设备身份 MAC");
  }
  let sdkToken: string | undefined;
  try {
    sdkToken = (await readFile(join(directory, "sdk_token"), "utf8")).trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    accessToken: requiredString(pairing.access_token, "device access token"),
    refreshToken: requiredString(pairing.refresh_token, "device refresh token"),
    deviceId: `homelink-${mac.replaceAll(":", "").slice(-6)}`,
    sdkToken,
    sdkTokenHint:
      typeof pairing.sdk_token_hint === "string" && pairing.sdk_token_hint.length === 12
        ? pairing.sdk_token_hint
        : undefined,
    apiUrl: typeof pairing.api_url_v2 === "string" ? pairing.api_url_v2 || undefined : undefined,
    noiseHost: typeof pairing.noise_host === "string" ? pairing.noise_host || undefined : undefined,
    savedAt: typeof pairing.access_token_saved_at === "number" ? pairing.access_token_saved_at : undefined,
  };
}

export async function saveCredentials(
  credentials: DeviceCredentials,
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "pairing.json");
  let previous: Record<string, unknown> = {};
  try {
    previous = object(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const data = {
    ...previous,
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    ...(credentials.sdkTokenHint !== undefined ? { sdk_token_hint: credentials.sdkTokenHint } : {}),
    token_type: "device",
    api_url_v2: credentials.apiUrl ?? "",
    noise_host: credentials.noiseHost ?? "",
    access_token_saved_at: credentials.savedAt ?? Math.floor(Date.now() / 1_000),
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(data, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
