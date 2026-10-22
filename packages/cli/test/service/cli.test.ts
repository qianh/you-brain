import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

import { serviceUnitPath } from "../../src/service/paths.js";

const cli = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("you-brain service", () => {
  it("prints the unit and does not write or call init", async () => {
    const fixture = await makeCliHome();
    const result = await runCli(["service", "install", "--print"], fixture.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`单元：${fixture.unitPath}`);
    expect(result.stdout).toContain("daemon");
    expect(result.stdout).not.toContain("you-brain-test-secret-b6");
    expect(result.stdout).not.toContain("YOU_BRAIN_MODEL_CACHE");
    expect(result.stdout).not.toContain("已写入");
    if (process.platform === "darwin") {
      expect(result.stdout).toContain("RunAtLoad");
      expect(result.stdout).toContain("web&amp;dir");
    } else if (process.platform === "linux") {
      expect(result.stdout).toContain("WantedBy=default.target");
      expect(result.stdout).toContain("/opt/web&dir");
    }
    expect(existsSync(fixture.unitPath)).toBe(false);
    expect(existsSync(fixture.commandLog)).toBe(false);
    expect(existsSync(join(fixture.data, "logs"))).toBe(false);
  });

  it("reports a missing service without calling init", async () => {
    const fixture = await makeCliHome();
    const result = await runCli(["service", "status"], fixture.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("服务未安装");
    expect(result.stdout).toContain("已停止");
    expect(result.stdout).toContain("pid：无");
    expect(result.stdout).toContain(`单元：${fixture.unitPath}`);
    expect(result.stdout).toContain("daemon 本机接口不可达");
    if (process.platform === "linux") {
      expect(result.stdout).toContain("journalctl --user -u you-brain.service -f");
    } else {
      expect(result.stdout).toContain("未加载");
    }
    expect(existsSync(fixture.commandLog)).toBe(false);
  });

  it("writes a unit without starting on --no-start", async () => {
    const fixture = await makeCliHome();
    const result = await runCli(["service", "install", "--no-start"], fixture.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`已写入 ${fixture.unitPath}`);
    expect(result.stdout).toContain("you-brain setup");
    expect(result.stdout).toContain("you-brain devices --set-main <id>");
    expect(existsSync(fixture.unitPath)).toBe(true);
    const body = await readFile(fixture.unitPath, "utf8");
    expect(body).not.toContain("you-brain-test-secret-b6");
    if (process.platform === "darwin") {
      expect(result.stdout).toContain("未立即启动");
      expect(existsSync(fixture.commandLog)).toBe(false);
      expect(body).toContain("<key>RunAtLoad</key>");
    } else if (process.platform === "linux") {
      expect(result.stdout).toContain("已启用，未立即启动。");
      const log = await readFile(fixture.commandLog, "utf8");
      expect(log).toContain("systemctl");
      expect(log).toContain("enable you-brain.service");
      expect(log).not.toContain("enable --now");
      expect(log).toContain("loginctl");
    }
  });
});

describe("you-brain uninstall startup items", () => {
  it("deletes startup files even when launchctl or systemctl fails", async () => {
    const fixture = await makeCliHome({ exitCode: 1 });
    const darwinUnit = serviceUnitPath("darwin", fixture.home);
    const linuxUnit = serviceUnitPath("linux", fixture.home);
    await mkdir(join(fixture.home, "Library", "LaunchAgents"), { recursive: true });
    await mkdir(join(fixture.home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(darwinUnit, "plist\n");
    await writeFile(linuxUnit, "unit\n");
    const result = await runCli(["uninstall", "--yes"], fixture.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`已删除开机项 ${darwinUnit}`);
    expect(result.stdout).toContain(`已删除开机项 ${linuxUnit}`);
    expect(existsSync(darwinUnit)).toBe(false);
    expect(existsSync(linuxUnit)).toBe(false);
    if (process.platform === "darwin" || process.platform === "linux") {
      const log = await readFile(fixture.commandLog, "utf8");
      const command = process.platform === "linux" ? "systemctl" : "launchctl";
      expect(log).toContain(join(fixture.bin, command));
      expect(log).not.toContain("/usr/bin/launchctl");
      expect(log).not.toContain("/usr/bin/systemctl");
    }
  });
});

async function makeCliHome(options?: { exitCode?: number }): Promise<{
  home: string;
  data: string;
  bin: string;
  unitPath: string;
  commandLog: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-service-cli-"));
  roots.push(root);
  const home = join(root, "home");
  const data = join(root, "data");
  const bin = join(root, "bin");
  const commandLog = join(root, "commands.log");
  await mkdir(bin, { recursive: true });
  const exitCode = options?.exitCode ?? 0;
  for (const name of ["launchctl", "systemctl", "loginctl"]) {
    const path = join(bin, name);
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${shellQuote(commandLog)}\nexit ${exitCode}\n`,
    );
    await chmod(path, 0o755);
  }
  const platform = process.platform === "linux" ? "linux" : "darwin";
  return {
    home,
    data,
    bin,
    unitPath: serviceUnitPath(platform, home),
    commandLog,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      YOU_BRAIN_DATA_DIR: data,
      YOU_BRAIN_HOME: home,
      YOU_BRAIN_WEB_DIR: "/opt/web&dir",
      YOU_BRAIN_MODEL_CACHE: "",
      YOU_BRAIN_TOKEN: "you-brain-test-secret-b6",
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
