import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { CliError } from "../../src/env.js";
import {
  readRunningDaemon,
  ServiceManager,
  type ServiceManagerOptions,
} from "../../src/service/manager.js";
import { daemonLogPath, serviceUnitPath, type ServicePlatform } from "../../src/service/paths.js";
import type { CommandResult, CommandRunner } from "../../src/service/runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("service manager darwin", () => {
  it("installs the plist and bootstraps it", async () => {
    const fixture = await makeFixture("darwin");
    const result = await fixture.manager.install({ start: true });
    expect(result.wrote).toBe(true);
    expect(result.started).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.unitPath).toBe(fixture.unitPath);
    expect(await readFile(fixture.unitPath, "utf8")).toContain("<key>RunAtLoad</key>");
    expect(existsSync(dirname(daemonLogPath(fixture.data)))).toBe(true);
    expect(existsSync(daemonLogPath(fixture.data))).toBe(false);
    expect((await stat(fixture.unitPath)).mode & 0o777).toBe(0o644);
    expect(fixture.runner.calls).toEqual([
      ["launchctl", "bootout", "gui/501/com.you-brain.daemon"],
      ["launchctl", "bootstrap", "gui/501", fixture.unitPath],
    ]);
  });

  it("does not rewrite an identical unit and still restarts", async () => {
    const fixture = await makeFixture("darwin");
    await fixture.manager.install({ start: true });
    await chmod(fixture.unitPath, 0o600);
    const before = fixture.runner.calls.length;
    const again = await fixture.manager.install({ start: true });
    expect(again.wrote).toBe(false);
    expect((await stat(fixture.unitPath)).mode & 0o777).toBe(0o600);
    expect(fixture.runner.calls.slice(before)).toEqual([
      ["launchctl", "bootout", "gui/501/com.you-brain.daemon"],
      ["launchctl", "bootstrap", "gui/501", fixture.unitPath],
    ]);
  });

  it("writes the unit without launchctl when start is false", async () => {
    const fixture = await makeFixture("darwin", { running: { pid: 77 } });
    const result = await fixture.manager.install({ start: false });
    expect(result.started).toBe(false);
    expect(result.wrote).toBe(true);
    expect(existsSync(fixture.unitPath)).toBe(true);
    expect(fixture.runner.calls).toEqual([]);
  });

  it("refuses to start over a foreground daemon", async () => {
    const fixture = await makeFixture("darwin", {
      running: { pid: 77 },
      results: [{ code: 0, stdout: "state = running\npid = 88\n", stderr: "" }],
    });
    const error = await fixture.manager.install({ start: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      "已有 you-brain daemon 在运行（pid 77）。请先停止，或加 --no-start 只写入单元不启动",
    );
    expect(existsSync(fixture.unitPath)).toBe(false);
    expect(fixture.runner.calls).toEqual([
      ["launchctl", "print", "gui/501/com.you-brain.daemon"],
    ]);
  });

  it("reinstalls when the running daemon is the service itself", async () => {
    const fixture = await makeFixture("darwin", { running: { pid: 77 } });
    fixture.runner.results.push({
      code: 0,
      stdout: `state = running\npid = 77\npath = ${fixture.unitPath}\n`,
      stderr: "",
    });
    const result = await fixture.manager.install({ start: true });
    expect(result.started).toBe(true);
    expect(fixture.runner.calls).toEqual([
      ["launchctl", "print", "gui/501/com.you-brain.daemon"],
      ["launchctl", "bootout", "gui/501/com.you-brain.daemon"],
      ["launchctl", "bootstrap", "gui/501", fixture.unitPath],
    ]);
  });

  it("treats a different plist path as a foreign daemon", async () => {
    const fixture = await makeFixture("darwin", { running: { pid: 77 } });
    fixture.runner.results.push({
      code: 0,
      stdout: "state = running\npid = 77\npath = /elsewhere/com.you-brain.daemon.plist\n",
      stderr: "",
    });
    await expect(fixture.manager.install({ start: true })).rejects.toBeInstanceOf(CliError);
    expect(existsSync(fixture.unitPath)).toBe(false);
    expect(fixture.runner.calls).toEqual([
      ["launchctl", "print", "gui/501/com.you-brain.daemon"],
    ]);
  });

  it("includes only the first stderr line when bootstrap fails", async () => {
    const fixture = await makeFixture("darwin", {
      results: [
        { code: 1, stdout: "", stderr: "Boot-out failed: 3: No such process\n" },
        { code: 1, stdout: "", stderr: "permission denied\nalso this\n" },
      ],
    });
    const error = await fixture.manager.install({ start: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("permission denied");
    expect((error as CliError).message).not.toContain("also this");
    expect(existsSync(fixture.unitPath)).toBe(true);
  });

  it("uninstalls idempotently and ignores a missing job", async () => {
    const fixture = await makeFixture("darwin", {
      results: [{ code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process\n" }],
    });
    await writeUnit(fixture.unitPath, "old\n");
    const removed = await fixture.manager.uninstall();
    expect(removed.removed).toEqual([fixture.unitPath]);
    expect(existsSync(fixture.unitPath)).toBe(false);
    const again = await fixture.manager.uninstall();
    expect(again.removed).toEqual([]);
    expect(fixture.runner.calls).toEqual([
      ["launchctl", "bootout", "gui/501/com.you-brain.daemon"],
    ]);
  });

  it("keeps the plist when bootout fails for another reason", async () => {
    const fixture = await makeFixture("darwin", {
      results: [{ code: 1, stdout: "", stderr: "Operation not permitted\n" }],
    });
    await writeUnit(fixture.unitPath, "old\n");
    const error = await fixture.manager.uninstall().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("Operation not permitted");
    expect(existsSync(fixture.unitPath)).toBe(true);
  });

  it("reads launchctl print for status", async () => {
    const missing = await makeFixture("darwin");
    const absent = await missing.manager.status({ daemonReachable: true });
    expect(absent).toMatchObject({
      installed: false,
      loaded: false,
      enabled: false,
      running: false,
      pid: null,
      daemonReachable: true,
      logHint: daemonLogPath(missing.data),
    });
    expect(missing.runner.calls).toEqual([]);

    const stopped = await makeFixture("darwin", {
      results: [
        {
          code: 0,
          stdout: "state = exited\npid = 12\npath = PLACE\n",
          stderr: "",
        },
      ],
    });
    stopped.runner.results[0] = {
      code: 0,
      stdout: `state = exited\npid = 12\npath = ${stopped.unitPath}\n`,
      stderr: "",
    };
    await writeUnit(stopped.unitPath, "unit\n");
    const stoppedStatus = await stopped.manager.status();
    expect(stoppedStatus).toMatchObject({
      installed: true,
      loaded: true,
      enabled: true,
      running: false,
      pid: null,
    });

    const running = await makeFixture("darwin", {
      results: [
        {
          code: 0,
          stdout: "state = running\npid = 4242\n",
          stderr: "",
        },
      ],
    });
    running.runner.results[0] = {
      code: 0,
      stdout: `state = running\npid = 4242\npath = ${running.unitPath}\n`,
      stderr: "",
    };
    await writeUnit(running.unitPath, "unit\n");
    expect(await running.manager.status()).toMatchObject({
      installed: true,
      loaded: true,
      running: true,
      pid: 4242,
    });

    const unloaded = await makeFixture("darwin", {
      results: [{ code: 3, stdout: "", stderr: "No such process\n" }],
    });
    await writeUnit(unloaded.unitPath, "unit\n");
    expect(await unloaded.manager.status()).toMatchObject({
      installed: true,
      loaded: false,
      running: false,
      pid: null,
    });

    const foreign = await makeFixture("darwin", {
      results: [
        {
          code: 0,
          stdout: "state = running\npid = 9\npath = /elsewhere/com.you-brain.daemon.plist\n",
          stderr: "",
        },
      ],
    });
    await writeUnit(foreign.unitPath, "unit\n");
    expect(await foreign.manager.status()).toMatchObject({
      installed: true,
      loaded: false,
      running: false,
      pid: null,
    });
  });
});

describe("service manager linux", () => {
  it("reloads, enables, and asks loginctl to linger", async () => {
    const fixture = await makeFixture("linux");
    const result = await fixture.manager.install({ start: true });
    expect(result.started).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await readFile(fixture.unitPath, "utf8")).toContain("WantedBy=default.target");
    expect(existsSync(join(fixture.data, "logs"))).toBe(false);
    expect((await stat(fixture.unitPath)).mode & 0o777).toBe(0o644);
    expect(fixture.runner.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "you-brain.service"],
      ["loginctl", "enable-linger", "tester"],
    ]);
  });

  it("enables without starting when start is false", async () => {
    const fixture = await makeFixture("linux", { running: { pid: 77 } });
    const result = await fixture.manager.install({ start: false });
    expect(result.started).toBe(false);
    expect(fixture.runner.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "you-brain.service"],
      ["loginctl", "enable-linger", "tester"],
    ]);
    expect(fixture.runner.calls.some((call) => call.includes("--now"))).toBe(false);
  });

  it("does not rewrite an identical unit", async () => {
    const fixture = await makeFixture("linux");
    await fixture.manager.install({ start: false });
    await chmod(fixture.unitPath, 0o600);
    const again = await fixture.manager.install({ start: false });
    expect(again.wrote).toBe(false);
    expect((await stat(fixture.unitPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses to start over a foreground daemon", async () => {
    const fixture = await makeFixture("linux", {
      running: { pid: 77 },
      results: [
        {
          code: 0,
          stdout: "ActiveState=inactive\nMainPID=0\nUnitFileState=\nFragmentPath=\n",
          stderr: "",
        },
      ],
    });
    const error = await fixture.manager.install({ start: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("pid 77");
    expect(existsSync(fixture.unitPath)).toBe(false);
    expect(fixture.runner.calls).toEqual([
      [
        "systemctl",
        "--user",
        "show",
        "you-brain.service",
        "--property=ActiveState,MainPID,UnitFileState,FragmentPath",
      ],
    ]);
  });

  it("continues when the running pid belongs to this unit", async () => {
    const fixture = await makeFixture("linux", { running: { pid: 77 } });
    fixture.runner.results.push({
      code: 0,
      stdout: "",
      stderr: "",
    });
    fixture.runner.results[0] = {
      code: 0,
      stdout: `ActiveState=active\nMainPID=77\nUnitFileState=enabled\nFragmentPath=${fixture.unitPath}\n`,
      stderr: "",
    };
    const result = await fixture.manager.install({ start: true });
    expect(result.started).toBe(true);
    expect(fixture.runner.calls[0]?.[0]).toBe("systemctl");
    expect(fixture.runner.calls[1]).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(fixture.runner.calls[2]).toEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "you-brain.service",
    ]);
  });

  it("keeps the install when loginctl fails", async () => {
    const fixture = await makeFixture("linux", {
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "Access denied\n" },
      ],
    });
    const result = await fixture.manager.install({ start: true });
    expect(result.started).toBe(true);
    expect(result.warnings).toEqual([
      "无人登录时服务不会开机自启，请以 root 执行 loginctl enable-linger tester",
    ]);
  });

  it("throws when systemctl fails", async () => {
    const fixture = await makeFixture("linux", {
      results: [{ code: 1, stdout: "", stderr: "Failed to reload\nnext\n" }],
    });
    const error = await fixture.manager.install({ start: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("Failed to reload");
    expect((error as CliError).message).not.toContain("next");
  });

  it("uninstalls and reloads systemd", async () => {
    const fixture = await makeFixture("linux");
    await writeUnit(fixture.unitPath, "old\n");
    const removed = await fixture.manager.uninstall();
    expect(removed.removed).toEqual([fixture.unitPath]);
    expect(existsSync(fixture.unitPath)).toBe(false);
    expect(fixture.runner.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "you-brain.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    const again = await fixture.manager.uninstall();
    expect(again.removed).toEqual([]);
    expect(fixture.runner.calls).toHaveLength(2);
  });

  it("ignores a unit that is not installed and still deletes the file", async () => {
    const fixture = await makeFixture("linux", {
      results: [
        {
          code: 1,
          stdout: "",
          stderr: "Failed to disable unit: Unit file you-brain.service does not exist.\n",
        },
        { code: 0, stdout: "", stderr: "" },
      ],
    });
    await writeUnit(fixture.unitPath, "old\n");
    const removed = await fixture.manager.uninstall();
    expect(removed.removed).toEqual([fixture.unitPath]);
    expect(existsSync(fixture.unitPath)).toBe(false);
  });

  it("keeps the unit when disable fails for another reason", async () => {
    const fixture = await makeFixture("linux", {
      results: [{ code: 1, stdout: "", stderr: "Permission denied\n" }],
    });
    await writeUnit(fixture.unitPath, "old\n");
    await expect(fixture.manager.uninstall()).rejects.toBeInstanceOf(CliError);
    expect(existsSync(fixture.unitPath)).toBe(true);
    expect(fixture.runner.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "you-brain.service"],
    ]);
  });

  it("reads systemctl show for status", async () => {
    const missing = await makeFixture("linux");
    expect(await missing.manager.status()).toMatchObject({
      installed: false,
      enabled: false,
      loaded: false,
      running: false,
      pid: null,
      logHint: "journalctl --user -u you-brain.service -f",
    });
    expect(missing.runner.calls).toEqual([]);

    const stopped = await makeFixture("linux", {
      results: [
        {
          code: 0,
          stdout: "ActiveState=inactive\nMainPID=0\nUnitFileState=enabled\n",
          stderr: "",
        },
      ],
    });
    await writeUnit(stopped.unitPath, "unit\n");
    expect(await stopped.manager.status()).toMatchObject({
      installed: true,
      enabled: true,
      loaded: false,
      running: false,
      pid: null,
    });

    const running = await makeFixture("linux");
    await writeUnit(running.unitPath, "unit\n");
    running.runner.results.push({
      code: 0,
      stdout: `ActiveState=active\nMainPID=99\nUnitFileState=enabled\nFragmentPath=${running.unitPath}\n`,
      stderr: "",
    });
    expect(await running.manager.status()).toMatchObject({
      installed: true,
      enabled: true,
      loaded: true,
      running: true,
      pid: 99,
    });

    const disabled = await makeFixture("linux", {
      results: [
        {
          code: 0,
          stdout: "ActiveState=inactive\nMainPID=0\nUnitFileState=disabled\n",
          stderr: "",
        },
      ],
    });
    await writeUnit(disabled.unitPath, "unit\n");
    expect(await disabled.manager.status()).toMatchObject({
      installed: true,
      enabled: false,
      loaded: false,
      running: false,
      pid: null,
    });

    const notFound = await makeFixture("linux", {
      results: [{ code: 1, stdout: "", stderr: "Unit you-brain.service not found.\n" }],
    });
    await writeUnit(notFound.unitPath, "unit\n");
    expect(await notFound.manager.status()).toMatchObject({
      installed: true,
      enabled: false,
      loaded: false,
      running: false,
    });
  });
});

describe("daemon lock", () => {
  it("returns a live pid and ignores a dead or corrupt lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-lock-"));
    roots.push(root);
    const lock = join(root, "daemon.lock");
    expect(readRunningDaemon(lock)).toBeNull();
    await writeFile(lock, "{", "utf8");
    expect(readRunningDaemon(lock)).toBeNull();
    await writeFile(lock, `${JSON.stringify({ pid: "nope" })}\n`, "utf8");
    expect(readRunningDaemon(lock)).toBeNull();
    await writeFile(lock, `${JSON.stringify({ pid: 2_147_483_646 })}\n`, "utf8");
    expect(readRunningDaemon(lock)).toBeNull();
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, startedAt: "x" })}\n`, "utf8");
    expect(readRunningDaemon(lock)).toEqual({ pid: process.pid });
  });
});

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = [];
  readonly results: CommandResult[];

  constructor(results: CommandResult[]) {
    this.results = results;
  }

  run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    return Promise.resolve(this.results.shift() ?? { code: 0, stdout: "", stderr: "" });
  }
}

async function makeFixture(
  platform: ServicePlatform,
  options?: {
    running?: { pid: number } | null;
    results?: CommandResult[];
  },
): Promise<{
  home: string;
  data: string;
  unitPath: string;
  runner: FakeRunner;
  manager: ServiceManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-service-"));
  roots.push(root);
  const home = join(root, "home");
  const data = join(root, "data");
  const runner = new FakeRunner(options?.results ?? []);
  const config: ServiceManagerOptions = {
    platform,
    homeDir: home,
    uid: 501,
    user: "tester",
    runner,
    now: () => new Date("2026-10-23T00:00:00.000Z"),
    isDaemonRunning: () => options?.running ?? null,
    program: ["/usr/local/bin/you-brain", "daemon"],
    env: { PATH: "/usr/bin:/bin", HOME: home },
    dataDir: data,
  };
  return {
    home,
    data,
    unitPath: serviceUnitPath(platform, home),
    runner,
    manager: new ServiceManager(config),
  };
}

async function writeUnit(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
