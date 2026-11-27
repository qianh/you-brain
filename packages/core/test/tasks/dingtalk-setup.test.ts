import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createDingTalkSetup } from "../../src/tasks/dingtalk-setup.js";

/** 造一个与官方发布包同结构的 tar.gz（根目录下 ./dws），以及包着它的 npm 包。 */
async function fixtures(root: string) {
  const src = join(root, "src");
  await mkdir(join(src, "package", "assets"), { recursive: true });
  await writeFile(join(src, "dws"), "#!/bin/sh\necho fake-dws\n");
  const archivePath = join(src, "package", "assets", "dws-test.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", src, "./dws"]);
  const archive = new Uint8Array(await readFile(archivePath));
  const tgzPath = join(root, "package.tgz");
  execFileSync("tar", ["-czf", tgzPath, "-C", src, "package"]);
  return { archive, tgz: new Uint8Array(await readFile(tgzPath)), sha256: createHash("sha256").update(archive).digest("hex") };
}

test("优先从 GitHub 下载并按 sha256 校验，安装到 ~/.local/bin/dws", async () => {
  const root = await mkdtemp(join(tmpdir(), "yb-dws-setup-"));
  try {
    const { archive, sha256 } = await fixtures(root);
    const urls: string[] = [];
    const setup = createDingTalkSetup({
      homeDir: root, archive: { name: "dws-test.tar.gz", sha256 },
      fetch: (async (url: string) => { urls.push(url); return new Response(archive); }) as unknown as typeof fetch,
    });
    const target = await setup.install();
    expect(target).toBe(join(root, ".local", "bin", "dws"));
    expect(await readFile(target, "utf8")).toContain("fake-dws");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
    expect(urls).toEqual(["https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v1.0.70/dws-test.tar.gz"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub 不通时从 npmmirror 的 npm 包里取出归档", async () => {
  const root = await mkdtemp(join(tmpdir(), "yb-dws-setup-"));
  try {
    const { tgz, sha256 } = await fixtures(root);
    const setup = createDingTalkSetup({
      homeDir: root, archive: { name: "dws-test.tar.gz", sha256 },
      fetch: (async (url: string) => url.includes("github.com")
        ? Promise.reject(new Error("connect timeout")) : new Response(tgz)) as unknown as typeof fetch,
    });
    expect(await readFile(await setup.install(), "utf8")).toContain("fake-dws");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("两个来源校验都不一致时不写入任何文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "yb-dws-setup-"));
  try {
    const { archive, tgz } = await fixtures(root);
    const setup = createDingTalkSetup({
      homeDir: root, archive: { name: "dws-test.tar.gz", sha256: "0".repeat(64) },
      fetch: (async (url: string) => new Response(url.includes("github.com") ? archive : tgz)) as unknown as typeof fetch,
    });
    await expect(setup.install()).rejects.toThrow(/校验不一致/u);
    await expect(stat(join(root, ".local", "bin", "dws"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("不支持的平台直接提示手动安装", async () => {
  const setup = createDingTalkSetup({ platform: "win32", arch: "x64", fetch: (async () => { throw new Error("unexpected"); }) as unknown as typeof fetch });
  await expect(setup.install()).rejects.toThrow(/不支持一键安装/u);
});

function fakeLogin(output: string, code: number) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  queueMicrotask(() => {
    child.stdout.write(output);
    setTimeout(() => child.emit("close", code), 10);
  });
  return child as never;
}

test("登录时上报授权链接，dws 以 0 退出但带 error 时视为失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "yb-dws-login-"));
  try {
    await mkdir(join(root, ".local", "bin"), { recursive: true });
    await writeFile(join(root, ".local", "bin", "dws"), "", { mode: 0o755 });
    const url = "https://login.dingtalk.com/oauth2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcallback";
    const seen: string[] = [];
    const ok = createDingTalkSetup({ homeDir: root, env: { PATH: "" }, spawnLogin: () => fakeLogin(`请手动访问:\n  ${url}\n\n{"success":true}`, 0) });
    await ok.login((value) => seen.push(value));
    expect(seen).toEqual([url]);

    const timeout = createDingTalkSetup({ homeDir: root, env: { PATH: "" },
      spawnLogin: () => fakeLogin(`${url}\n{"error":{"category":"auth","message":"dingtalk login failed: 授权超时（5分钟），请重试"}}`, 0) });
    await expect(timeout.login(() => undefined)).rejects.toThrow("授权超时");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
