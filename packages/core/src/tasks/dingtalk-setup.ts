import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDws } from "./dingtalk-minutes.js";

/** 钉钉听记按 v1.0.70 的 dws 接口接入，安装时固定这个版本。 */
export const DWS_VERSION = "1.0.70";
/** 官方发布包的 sha256（与 npm 包 assets/checksums.txt 一致），两条下载路径都按它校验。 */
const ARCHIVES: Record<string, { name: string; sha256: string }> = {
  "darwin-arm64": { name: "dws-darwin-arm64.tar.gz", sha256: "b3d09787741abd64c5a5372d6985ee0f451eaf87f6c6be0a6bfbc2bc9b37943e" },
  "darwin-x64": { name: "dws-darwin-amd64.tar.gz", sha256: "72f85c67bfe0f491cf602495a9db275186b7bf353fd6fd3ae9b1fa5d6834fd93" },
  "linux-arm64": { name: "dws-linux-arm64.tar.gz", sha256: "b5631700e7c86f88fdfcb9278aa28ca83577832991089a23cf77968e414d02b8" },
  "linux-x64": { name: "dws-linux-amd64.tar.gz", sha256: "b3273c91b23d7f300c5b1dae0a6737919fffc2badd3a9834de3289d3e89cdb81" },
};
const RELEASE_URL = `https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v${DWS_VERSION}`;
/** GitHub 不通时退回 npmmirror：npm 包含全部平台（约 140 MB），从中取出本机归档。 */
const MIRROR_TARBALL = `https://registry.npmmirror.com/dingtalk-workspace-cli/-/dingtalk-workspace-cli-${DWS_VERSION}.tgz`;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** dws 自身授权等待 5 分钟，这里留一点余量。 */
const LOGIN_TIMEOUT_MS = 6 * 60_000;

export class DingTalkSetupError extends Error {}

export interface DingTalkSetupPort {
  /** 下载官方 dws 到 ~/.local/bin/dws，返回安装路径。 */
  install(signal?: AbortSignal): Promise<string>;
  /** 拉起 dws auth login（浏览器授权）；拿到授权链接时回调，授权完成后返回。 */
  login(onUrl: (url: string) => void, signal?: AbortSignal): Promise<void>;
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, { timeout: 120_000 }, (error, _stdout, stderr) => {
      if (error) reject(new DingTalkSetupError(`解压钉钉 CLI 失败：${(stderr || error.message).trim().slice(0, 200)}`));
      else resolve();
    });
  });
}

export function createDingTalkSetup(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: string;
  arch?: string;
  fetch?: typeof fetch;
  /** 测试注入：替代内置的平台归档名与 sha256。 */
  archive?: { name: string; sha256: string };
  /** 测试注入：替代真实的 dws auth login 子进程。 */
  spawnLogin?: (bin: string, env: NodeJS.ProcessEnv) => ReturnType<typeof spawn>;
} = {}): DingTalkSetupPort {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const doFetch = options.fetch ?? fetch;
  const archive = options.archive ?? ARCHIVES[`${options.platform ?? process.platform}-${options.arch ?? process.arch}`];

  async function download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const response = await doFetch(url, { redirect: "follow", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new DingTalkSetupError(`下载失败（HTTP ${response.status}）`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** 先下 GitHub 单平台包；失败或校验不符再从 npmmirror 的完整 npm 包里取。 */
  async function fetchArchive(work: string, signal?: AbortSignal): Promise<Uint8Array> {
    const { name, sha256: expected } = archive!;
    const failures: string[] = [];
    try {
      const data = await download(`${RELEASE_URL}/${name}`, signal);
      if (sha256(data) === expected) return data;
      failures.push("GitHub：校验不一致");
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`GitHub：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const tarball = join(work, "package.tgz");
      await writeFile(tarball, await download(MIRROR_TARBALL, signal));
      await tar(["-xzf", tarball, "-C", work, `package/assets/${name}`]);
      const data = await readFile(join(work, "package", "assets", name));
      if (sha256(data) === expected) return data;
      failures.push("npmmirror：校验不一致");
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`npmmirror：${error instanceof Error ? error.message : String(error)}`);
    }
    throw new DingTalkSetupError(`下载钉钉 CLI 失败（${failures.join("；")}），请检查网络后重试。`);
  }

  return {
    async install(signal) {
      if (!archive) throw new DingTalkSetupError("当前系统不支持一键安装钉钉 CLI，请参考官方文档手动安装 dingtalk-workspace-cli。");
      const work = await mkdtemp(join(tmpdir(), "yb-dws-"));
      try {
        const data = await fetchArchive(work, signal);
        const archivePath = join(work, archive.name);
        await writeFile(archivePath, data);
        const extracted = join(work, "out");
        await mkdir(extracted);
        await tar(["-xzf", archivePath, "-C", extracted, "./dws"]);
        const binDir = join(homeDir, ".local", "bin");
        await mkdir(binDir, { recursive: true });
        const target = join(binDir, "dws");
        // 先写同目录临时文件再原子替换，避免半截文件被当成可执行的 dws。
        const staging = join(binDir, `.dws-${process.pid}-${Date.now()}`);
        try {
          await writeFile(staging, await readFile(join(extracted, "dws")));
          await chmod(staging, 0o755);
          await rename(staging, target);
        } catch (error) {
          await rm(staging, { force: true });
          throw error instanceof DingTalkSetupError ? error : new DingTalkSetupError(`写入 ${target} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return target;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },

    async login(onUrl, signal) {
      const bin = await resolveDws(env, homeDir);
      const child = options.spawnLogin
        ? options.spawnLogin(bin, env)
        : spawn(bin, ["auth", "login"], { cwd: homeDir, env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let reported = false;
      const scan = (chunk: Buffer): void => {
        output = (output + chunk.toString("utf8")).slice(-16_384);
        const url = reported ? null : /https:\/\/login\.dingtalk\.(?:com|io)\/\S+/u.exec(output)?.[0];
        if (url) { reported = true; onUrl(url); }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      await new Promise<void>((resolve, reject) => {
        const stop = (): void => { child.kill("SIGTERM"); };
        const timer = setTimeout(stop, LOGIN_TIMEOUT_MS);
        signal?.addEventListener("abort", stop, { once: true });
        child.once("error", (error) => { clearTimeout(timer); reject(new DingTalkSetupError(`启动钉钉登录失败：${error.message}`)); });
        child.once("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          // dws 授权失败也可能以 0 退出，只把 JSON 里的 error 当失败依据。
          const failed = code !== 0 || /"error"\s*:\s*\{/u.test(output);
          if (!failed) { resolve(); return; }
          const reason = /"message"\s*:\s*"([^"]{1,200})"/u.exec(output)?.[1];
          reject(new DingTalkSetupError(reason ? `钉钉登录未完成：${reason}` : "钉钉登录未完成，请重试。"));
        });
      });
    },
  };
}
