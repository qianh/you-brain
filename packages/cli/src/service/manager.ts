import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { platformPaths } from "@you-brain/core";
import { isProcessAlive } from "@you-brain/core/http";

import { CliError, supportedPlatform } from "../env.js";
import {
  daemonLogPath,
  SERVICE_LABEL,
  serviceLogHint,
  serviceUnitPath,
  SYSTEMD_UNIT,
  type ServicePlatform,
} from "./paths.js";
import { createCommandRunner, type CommandResult, type CommandRunner } from "./runner.js";
import {
  buildProgram,
  collectServiceEnv,
  isBunExecutable,
  renderLaunchdPlist,
  renderSystemdUnit,
} from "./unit.js";

const SYSTEMD_SHOW_PROPERTY = "ActiveState,MainPID,UnitFileState,FragmentPath";

export interface ServiceFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface ServiceManagerOptions {
  platform: ServicePlatform;
  homeDir: string;
  uid: number;
  user: string;
  runner: CommandRunner;
  fs?: ServiceFs;
  /** 注入时钟。单元文本必须稳定，安装过程不把它写进文件。 */
  now?: () => Date;
  isDaemonRunning: () => { pid: number } | null;
  program: string[];
  env: Record<string, string>;
  dataDir: string;
}

export interface InstallResult {
  unitPath: string;
  wrote: boolean;
  started: boolean;
  warnings: string[];
}

export interface UninstallResult {
  removed: string[];
}

export interface ServiceStatus {
  installed: boolean;
  /** darwin：launchd 已加载。linux：单元已进入内存（正在跑或刚失败）。 */
  loaded: boolean;
  /** linux：UnitFileState 为 enabled 一类。darwin：与 loaded 相同。 */
  enabled: boolean;
  running: boolean;
  pid: number | null;
  unitPath: string;
  logHint: string;
  daemonReachable: boolean;
}

const defaultFs: ServiceFs = {
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  },
  async writeFile(path, contents) {
    await writeFile(path, contents, { mode: 0o644 });
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async rm(path) {
    await rm(path, { force: true });
  },
  async chmod(path, mode) {
    await chmod(path, mode);
  },
};

export function readRunningDaemon(lockFile: string): { pid: number } | null {
  let text: string;
  try {
    text = readFileSync(lockFile, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    if (!isProcessAlive(parsed.pid)) return null;
    return { pid: parsed.pid };
  } catch {
    return null;
  }
}

export function createRuntimeServiceManager(options?: {
  homeDir?: string;
  platform?: ServicePlatform;
  runner?: CommandRunner;
}): ServiceManager {
  const platform = options?.platform ?? supportedPlatform();
  const homeDir = options?.homeDir ?? homedir();
  const paths = platformPaths({ platform, homeDir, env: process.env });
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const home = nonempty(process.env.HOME) ?? homeDir;
  const path = nonempty(process.env.PATH) ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  return new ServiceManager({
    platform,
    homeDir,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    user: currentUser(),
    runner: options?.runner ?? createCommandRunner(),
    now: () => new Date(),
    isDaemonRunning: () => readRunningDaemon(paths.lockFile),
    program: buildProgram({
      execPath: process.execPath,
      entry,
      isBun: isBunExecutable(process.execPath),
    }),
    env: collectServiceEnv({ ...process.env, HOME: home, PATH: path }),
    dataDir: paths.dataDir,
  });
}

export class ServiceManager {
  private readonly fs: ServiceFs;

  constructor(private readonly options: ServiceManagerOptions) {
    this.fs = options.fs ?? defaultFs;
  }

  preview(): { unitPath: string; body: string } {
    return { unitPath: this.unitPath, body: this.renderUnit() };
  }

  async install(input: { start: boolean }): Promise<InstallResult> {
    if (this.options.program.length === 0) throw new CliError("服务启动命令为空");
    if (input.start) await this.assertNoForeignDaemon();
    const wrote = await this.writeUnit();
    const warnings: string[] = [];
    if (!input.start) {
      if (this.options.platform === "linux") warnings.push(...(await this.enableLinux(false)));
      return { unitPath: this.unitPath, wrote, started: false, warnings };
    }
    if (this.options.platform === "darwin") {
      await this.bootoutDarwin();
      await this.must("launchctl", ["bootstrap", this.guiDomain, this.unitPath]);
    } else {
      warnings.push(...(await this.enableLinux(true)));
    }
    return { unitPath: this.unitPath, wrote, started: true, warnings };
  }

  async uninstall(): Promise<UninstallResult> {
    const existing = await this.fs.readFile(this.unitPath);
    if (existing === null) return { removed: [] };
    if (this.options.platform === "darwin") {
      await this.bootoutDarwinStrict();
      await this.fs.rm(this.unitPath);
      return { removed: [this.unitPath] };
    }
    await this.disableLinux();
    await this.fs.rm(this.unitPath);
    await this.must("systemctl", ["--user", "daemon-reload"]);
    return { removed: [this.unitPath] };
  }

  async status(input?: { daemonReachable?: boolean }): Promise<ServiceStatus> {
    const unitPath = this.unitPath;
    const installed = (await this.fs.readFile(unitPath)) !== null;
    const base: ServiceStatus = {
      installed,
      loaded: false,
      enabled: false,
      running: false,
      pid: null,
      unitPath,
      logHint: serviceLogHint(this.options.platform, this.options.dataDir),
      daemonReachable: input?.daemonReachable ?? false,
    };
    if (!installed) return base;
    const observed =
      this.options.platform === "darwin" ? await this.observeDarwin() : await this.observeLinux();
    return { ...base, ...observed };
  }

  private get unitPath(): string {
    return serviceUnitPath(this.options.platform, this.options.homeDir);
  }

  private get guiDomain(): string {
    return `gui/${this.options.uid}`;
  }

  private get serviceTarget(): string {
    return `${this.guiDomain}/${SERVICE_LABEL}`;
  }

  private renderUnit(): string {
    if (this.options.platform === "darwin") {
      return renderLaunchdPlist({
        label: SERVICE_LABEL,
        program: this.options.program,
        env: this.options.env,
        logFile: daemonLogPath(this.options.dataDir),
        workingDirectory: this.options.homeDir,
      });
    }
    return renderSystemdUnit({
      program: this.options.program,
      env: this.options.env,
      workingDirectory: this.options.homeDir,
    });
  }

  private async writeUnit(): Promise<boolean> {
    await this.fs.mkdir(dirname(this.unitPath));
    if (this.options.platform === "darwin") {
      await this.fs.mkdir(dirname(daemonLogPath(this.options.dataDir)));
    }
    const body = this.renderUnit();
    const current = await this.fs.readFile(this.unitPath);
    if (current === body) return false;
    await this.fs.writeFile(this.unitPath, body);
    await this.fs.chmod(this.unitPath, 0o644);
    return true;
  }

  private async assertNoForeignDaemon(): Promise<void> {
    const running = this.options.isDaemonRunning();
    if (!running) return;
    const servicePid = await this.servicePid();
    if (servicePid === running.pid) return;
    throw new CliError(
      `已有 you-brain daemon 在运行（pid ${running.pid}）。请先停止，或加 --no-start 只写入单元不启动`,
    );
  }

  private async servicePid(): Promise<number | null> {
    if (this.options.platform === "darwin") {
      const args = ["print", this.serviceTarget];
      const result = await this.options.runner.run("launchctl", args);
      if (result.code !== 0) {
        if (isAbsentResult(result)) return null;
        throw commandError("launchctl", args, result);
      }
      const parsed = parseLaunchctlPrint(result.stdout);
      if (parsed.path !== null && parsed.path !== this.unitPath) return null;
      if (parsed.state !== "running") return null;
      return parsed.pid;
    }
    const args = systemdShowArgs();
    const result = await this.options.runner.run("systemctl", args);
    if (result.code !== 0) {
      if (isAbsentResult(result)) return null;
      throw commandError("systemctl", args, result);
    }
    const parsed = parseSystemdShow(result.stdout);
    if (parsed.fragmentPath !== null && parsed.fragmentPath !== this.unitPath) return null;
    if (!isSystemdRunning(parsed.activeState)) return null;
    return parsed.mainPid;
  }

  /** 安装时无论是否已加载都 bootout，失败忽略，避免旧任务占着同一个标签。 */
  private async bootoutDarwin(): Promise<void> {
    await this.options.runner.run("launchctl", ["bootout", this.serviceTarget]);
  }

  private async bootoutDarwinStrict(): Promise<void> {
    const args = ["bootout", this.serviceTarget];
    const result = await this.options.runner.run("launchctl", args);
    if (result.code !== 0 && !isAbsentResult(result)) {
      throw commandError("launchctl", args, result);
    }
  }

  private async enableLinux(start: boolean): Promise<string[]> {
    await this.must("systemctl", ["--user", "daemon-reload"]);
    const enable = start
      ? ["--user", "enable", "--now", SYSTEMD_UNIT]
      : ["--user", "enable", SYSTEMD_UNIT];
    await this.must("systemctl", enable);
    return this.linger();
  }

  private async disableLinux(): Promise<void> {
    const args = ["--user", "disable", "--now", SYSTEMD_UNIT];
    const result = await this.options.runner.run("systemctl", args);
    if (result.code !== 0 && !isAbsentResult(result)) {
      throw commandError("systemctl", args, result);
    }
  }

  private async linger(): Promise<string[]> {
    const args = ["enable-linger", this.options.user];
    const result = await this.options.runner.run("loginctl", args);
    if (result.code === 0) return [];
    return [
      `无人登录时服务不会开机自启，请以 root 执行 loginctl enable-linger ${this.options.user}`,
    ];
  }

  private async observeDarwin(): Promise<Pick<ServiceStatus, "loaded" | "enabled" | "running" | "pid">> {
    const args = ["print", this.serviceTarget];
    const result = await this.options.runner.run("launchctl", args);
    if (result.code !== 0) {
      if (isAbsentResult(result)) return idle();
      throw commandError("launchctl", args, result);
    }
    const parsed = parseLaunchctlPrint(result.stdout);
    if (parsed.path !== null && parsed.path !== this.unitPath) return idle();
    const running = parsed.state === "running";
    return {
      loaded: true,
      enabled: true,
      running,
      pid: running ? parsed.pid : null,
    };
  }

  private async observeLinux(): Promise<Pick<ServiceStatus, "loaded" | "enabled" | "running" | "pid">> {
    const args = systemdShowArgs();
    const result = await this.options.runner.run("systemctl", args);
    if (result.code !== 0) {
      if (isAbsentResult(result)) return idle();
      throw commandError("systemctl", args, result);
    }
    const parsed = parseSystemdShow(result.stdout);
    if (parsed.fragmentPath !== null && parsed.fragmentPath !== this.unitPath) return idle();
    const running = isSystemdRunning(parsed.activeState);
    const enabled = isSystemdEnabled(parsed.unitFileState);
    return {
      loaded: running || parsed.activeState === "failed",
      enabled,
      running,
      pid: running ? parsed.mainPid : null,
    };
  }

  private async must(command: string, args: string[]): Promise<void> {
    const result = await this.options.runner.run(command, args);
    if (result.code !== 0) throw commandError(command, args, result);
  }
}

export function parseLaunchctlPrint(text: string): {
  state: string | null;
  pid: number | null;
  path: string | null;
} {
  let state: string | null = null;
  let pid: number | null = null;
  let path: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (state === null) {
      const match = /^state = (\S+)$/.exec(line);
      if (match?.[1]) state = match[1];
    }
    if (pid === null) {
      const match = /^pid = (\d+)$/.exec(line);
      if (match?.[1]) {
        const value = Number(match[1]);
        pid = value > 0 ? value : null;
      }
    }
    if (path === null) {
      const match = /^path = (.+)$/.exec(line);
      if (match?.[1]) path = match[1].trim();
    }
  }
  return { state, pid, path };
}

export function parseSystemdShow(text: string): {
  activeState: string | null;
  mainPid: number | null;
  unitFileState: string | null;
  fragmentPath: string | null;
} {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (values.has(key)) continue;
    values.set(key, line.slice(index + 1).trim());
  }
  const pidRaw = values.get("MainPID");
  const pid = pidRaw !== undefined && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
  return {
    activeState: emptyToNull(values.get("ActiveState")),
    mainPid: pid !== null && pid > 0 ? pid : null,
    unitFileState: emptyToNull(values.get("UnitFileState")),
    fragmentPath: emptyToNull(values.get("FragmentPath")),
  };
}

function systemdShowArgs(): string[] {
  return ["--user", "show", SYSTEMD_UNIT, `--property=${SYSTEMD_SHOW_PROPERTY}`];
}

function idle(): Pick<ServiceStatus, "loaded" | "enabled" | "running" | "pid"> {
  return { loaded: false, enabled: false, running: false, pid: null };
}

function isSystemdRunning(state: string | null): boolean {
  return state === "active" || state === "activating" || state === "reloading";
}

function isSystemdEnabled(state: string | null): boolean {
  return (
    state === "enabled" ||
    state === "enabled-runtime" ||
    state === "linked" ||
    state === "linked-runtime" ||
    state === "alias" ||
    state === "indirect"
  );
}

function isAbsentResult(result: CommandResult): boolean {
  if (result.code === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    text.includes("no such process") ||
    text.includes("not found") ||
    text.includes("could not find") ||
    text.includes("not loaded") ||
    text.includes("does not exist") ||
    text.includes("not installed") ||
    text.includes("no such file") ||
    text.includes("unrecognized service") ||
    text.includes("not-found")
  ) {
    return true;
  }
  return result.code === 3 && text.trim() === "";
}

function commandError(command: string, args: string[], result: CommandResult): CliError {
  const reason = firstLine(result.stderr) || firstLine(result.stdout) || `退出码 ${result.code}`;
  return new CliError(`${command} ${args.join(" ")} 失败：${reason}`);
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return value.trim();
}

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function currentUser(): string {
  try {
    const name = userInfo().username;
    if (name.trim() !== "") return name;
  } catch {
    // 容器里可能没有 passwd 项。
  }
  return nonempty(process.env.USER) ?? nonempty(process.env.LOGNAME) ?? "user";
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
