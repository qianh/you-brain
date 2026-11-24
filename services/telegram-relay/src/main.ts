import { startRelayServer } from "./server.js";

/**
 * 进程入口。密钥只从环境变量来（systemd 的 EnvironmentFile），不读命令行参数，日志里也不打印。
 */

function optional(name: string, fallback: string): string {
  const value = process.env[name] ?? "";
  return value === "" ? fallback : value;
}

const missing = ["BOT_TOKEN", "RELAY_KEY"].filter((name) => (process.env[name] ?? "") === "");
if (missing.length > 0) {
  console.error(`缺少环境变量 ${missing.join("、")}。请写进权限为 0600 的环境文件，不要通过命令行参数传入。`);
  process.exit(1);
}

const portText = optional("RELAY_PORT", "8787");
const port = Number(portText);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("RELAY_PORT 不是有效端口");
  process.exit(1);
}

const host = optional("RELAY_HOST", "127.0.0.1");
const dataDir = optional("RELAY_DATA_DIR", "/var/lib/u-brain-relay");
const legacyText = optional("RELAY_ACCEPT_LEGACY_KEY", "true").trim().toLowerCase();
if (legacyText !== "true" && legacyText !== "false" && legacyText !== "1" && legacyText !== "0") {
  console.error("RELAY_ACCEPT_LEGACY_KEY 必须是 true 或 false");
  process.exit(1);
}
const acceptLegacyKey = legacyText === "true" || legacyText === "1";

const turnUrls = optional("RELAY_TURN_URLS", "")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item.length > 0);
const turnSecret = optional("RELAY_TURN_SECRET", "").trim();

const server = await startRelayServer({
  port,
  host,
  botToken: process.env.BOT_TOKEN ?? "",
  relayKey: process.env.RELAY_KEY ?? "",
  dataDir,
  acceptLegacyKey,
  publicOrigin: optional("RELAY_PUBLIC_ORIGIN", ""),
  routerDeviceId: optional("RELAY_ROUTER_DEVICE", ""),
  ...(turnUrls.length > 0
    ? {
        turn: {
          urls: turnUrls,
          ...(turnSecret.length > 0 ? { secret: turnSecret } : {}),
        },
      }
    : {}),
});

console.log(`U-Brain Telegram relay 监听 http://${host}:${server.port}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在退出`);
  try {
    await server.stop();
  } catch {
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
