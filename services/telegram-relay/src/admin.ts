/**
 * 中转本机管理命令行：
 *   bun src/admin.ts invite
 *   bun src/admin.ts revoke <deviceId>
 *   bun src/admin.ts devices
 *
 * 读取环境变量 `RELAY_KEY`（必填，绝不打印）与 `RELAY_ADMIN_URL`（默认 http://127.0.0.1:8787）。
 */

export interface AdminCliDeps {
  fetch?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const USAGE = "用法：bun src/admin.ts invite | revoke <deviceId> | devices";

function scrubKey(text: string, key: string): string {
  return key === "" ? text : text.split(key).join("<key>");
}

export async function runAdminCli(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: AdminCliDeps = {},
): Promise<number> {
  const out = deps.stdout ?? ((line) => console.log(line));
  const err = deps.stderr ?? ((line) => console.error(line));
  const fetchImpl = deps.fetch ?? fetch;

  const key = env.RELAY_KEY ?? "";
  if (key === "") {
    err("缺少环境变量 RELAY_KEY，请从 0600 权限的环境文件加载后再执行。");
    return 1;
  }

  const base = (env.RELAY_ADMIN_URL && env.RELAY_ADMIN_URL !== "" ? env.RELAY_ADMIN_URL : "http://127.0.0.1:8787").replace(
    /\/+$/u,
    "",
  );
  const [command, arg] = argv;
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  try {
    if (command === "invite") {
      const response = await fetchImpl(`${base}/admin/invite`, { method: "POST", headers });
      const data = (await response.json().catch(() => ({}))) as { code?: string; expiresAt?: string; error?: string };
      if (!response.ok) {
        err(`生成邀请码失败（HTTP ${response.status}）：${scrubKey(data.error ?? "请求失败", key)}`);
        return 1;
      }
      out(`邀请码：${data.code ?? ""}`);
      out(`过期时间：${data.expiresAt ?? ""}`);
      return 0;
    }

    if (command === "revoke") {
      const deviceId = (arg ?? "").trim();
      if (deviceId === "") {
        err(`缺少设备 ID。\n${USAGE}`);
        return 1;
      }
      const response = await fetchImpl(`${base}/admin/revoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({ deviceId }),
      });
      const data = (await response.json().catch(() => ({}))) as { deviceId?: string; revokedAt?: number; error?: string };
      if (!response.ok) {
        err(`吊销设备失败（HTTP ${response.status}）：${scrubKey(data.error ?? "请求失败", key)}`);
        return 1;
      }
      out(`已吊销设备：${data.deviceId ?? deviceId}`);
      return 0;
    }

    if (command === "devices") {
      const response = await fetchImpl(`${base}/admin/devices`, { method: "GET", headers });
      const data = (await response.json().catch(() => ({}))) as {
        devices?: Array<{
          deviceId: string;
          name: string;
          online: boolean;
          createdAt: number;
          revokedAt?: number;
        }>;
        error?: string;
      };
      if (!response.ok) {
        err(`查询设备失败（HTTP ${response.status}）：${scrubKey(data.error ?? "请求失败", key)}`);
        return 1;
      }
      const devices = data.devices ?? [];
      if (devices.length === 0) {
        out("当前没有已入网的设备。");
        return 0;
      }
      for (const device of devices) {
        const status = device.revokedAt !== undefined ? "已吊销" : device.online ? "在线" : "离线";
        const created = new Date(device.createdAt).toISOString();
        const revoked = device.revokedAt !== undefined ? ` revoked=${new Date(device.revokedAt).toISOString()}` : "";
        out(`${device.deviceId}\t${device.name}\t${status}\tcreated=${created}${revoked}`);
      }
      return 0;
    }

    err(USAGE);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(`调用管理端点失败：${scrubKey(message, key)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runAdminCli(process.argv.slice(2), process.env);
  process.exit(code);
}
