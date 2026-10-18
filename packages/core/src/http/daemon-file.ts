import { randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../domain/atomic.js";
import { YouBrainError } from "../domain/errors.js";
import { DaemonEndpointSchema, type DaemonEndpoint } from "./types.js";

export function daemonFilePath(dataDir: string): string {
  return join(dataDir, "daemon.json");
}

export function createDaemonToken(): string {
  return randomBytes(32).toString("hex");
}

export class DaemonFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonFileError";
  }
}

export async function writeDaemonEndpoint(
  dataDir: string,
  endpoint: DaemonEndpoint,
): Promise<string> {
  const parsed = DaemonEndpointSchema.parse(endpoint);
  const path = daemonFilePath(dataDir);
  const body = `${JSON.stringify({
    port: parsed.port,
    token: parsed.token,
    pid: parsed.pid,
  })}\n`;
  await writeFileAtomic(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function readDaemonEndpoint(
  dataDir: string,
): Promise<DaemonEndpoint | null> {
  const path = daemonFilePath(dataDir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DaemonFileError("daemon.json 不是合法 JSON");
  }
  const result = DaemonEndpointSchema.safeParse(parsed);
  if (!result.success) {
    throw new DaemonFileError("daemon.json 缺少 port、token 或 pid");
  }
  return result.data;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    return code === "EPERM";
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function assertLoopbackPort(port: number | undefined): number {
  if (port === undefined) return 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new YouBrainError("INVALID_INPUT", "端口必须是 0 到 65535 的整数");
  }
  return port;
}
