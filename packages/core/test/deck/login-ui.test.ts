import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import vm from "node:vm";

import { DeckDshLoginBodySchema } from "../../src/http/types.js";
import { DSH_LOGIN_PROVIDER_IDS, DshLogin } from "../../src/deck/dsh/login.js";
// @ts-expect-error 插件是纯 JS 模块（随 App 打包），没有类型声明。
import { handle } from "../../../../sidecars/dsh-host/plugins/u-brain-login/lib/index.js";

const PLUGIN_DIR = join(import.meta.dirname, "..", "..", "..", "..", "sidecars", "dsh-host", "plugins", "u-brain-login");

function fakeReq(method: string, headers: Record<string, string>, body?: string): Readable & { method: string; headers: Record<string, string> } {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as Readable & { method: string; headers: Record<string, string> };
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function fakeRes(): { status: number; headers: Record<string, string>; body: string; writeHead(status: number, headers: Record<string, string>): void; end(text?: string): void } {
  return {
    status: 0, headers: {}, body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(text) { this.body = text ?? ""; },
  };
}

const OK_HEADERS = { host: "127.0.0.1:38777", "x-u-brain": "1" };
const daemon = async () => ({ base: "http://daemon.test", token: "tok" });

describe("u-brain-login host route", () => {
  it("rejects requests that are not same-origin loopback calls carrying the custom header", async () => {
    const calls: string[] = [];
    const deps = { daemon, fetch: async (url: string) => (calls.push(url), new Response("{}")) };
    for (const headers of [
      { host: "127.0.0.1:1" }, // 没有自定义头
      { host: "evil.example.com", "x-u-brain": "1" }, // 非回环 Host（DNS 重绑定）
      { host: "127.0.0.1:1", "x-u-brain": "1", "sec-fetch-site": "cross-site" }, // 跨站
    ]) {
      const res = fakeRes();
      await handle(fakeReq("GET", headers), res, deps);
      expect(res.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("proxies GET with the daemon token and returns its status and body untouched", async () => {
    const seen: Array<{ url: string; auth: string | null; method: string | undefined }> = [];
    const res = fakeRes();
    await handle(fakeReq("GET", OK_HEADERS), res, {
      daemon,
      fetch: async (url: string, init: { headers: Record<string, string>; method?: string }) => {
        seen.push({ url, auth: init.headers.authorization ?? null, method: init.method });
        return new Response('{"providers":[{"id":"xai"}]}', { status: 200 });
      },
    });
    expect(seen).toEqual([{ url: "http://daemon.test/api/deck/dsh/login", auth: "Bearer tok", method: undefined }]);
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"providers":[{"id":"xai"}]}');
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("forwards a POST body, passes through daemon errors, and refuses other methods", async () => {
    let sent = "";
    const post = fakeRes();
    await handle(fakeReq("POST", OK_HEADERS, '{"action":"start","provider":"xai"}'), post, {
      daemon,
      fetch: async (_url: string, init: { body?: string }) => ((sent = init.body ?? ""), new Response('{"error":{"message":"bad"}}', { status: 400 })),
    });
    expect(sent).toBe('{"action":"start","provider":"xai"}');
    expect(post.status).toBe(400);
    const del = fakeRes();
    await handle(fakeReq("DELETE", OK_HEADERS), del, { daemon, fetch: async () => new Response("{}") });
    expect(del.status).toBe(405);
  });

  it("returns 502 with a readable reason when the daemon is unreachable", async () => {
    const res = fakeRes();
    await handle(fakeReq("GET", OK_HEADERS), res, { daemon: async () => { throw new Error("U-Brain 的后台没有运行（找不到 daemon.json）"); } });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toContain("没有运行");
  });

  it("caps the request body", async () => {
    const res = fakeRes();
    await handle(fakeReq("POST", OK_HEADERS, "x".repeat(10_000)), res, { daemon, fetch: async () => new Response("{}") });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toContain("过大");
  });
});

describe("u-brain-login browser module", () => {
  /** 在沙箱里按 DSH 的模块加载约定执行 client.js，捕获它注册的席位。 */
  async function load(): Promise<{ id: string; exports: { apply(ctx: unknown): void; inject: string[] } }> {
    const code = await readFile(join(PLUGIN_DIR, "lib", "client.js"), "utf8");
    type Entry = { id: string; factory: (require: (name: string) => unknown) => { apply(ctx: unknown): void; inject: string[] } };
    const holder: { entry?: Entry } = {};
    const react = {
      createElement: (...args: unknown[]) => args,
      useState: (initial: unknown) => [initial, () => undefined],
      useCallback: (fn: unknown) => fn,
      useEffect: () => undefined,
    };
    vm.runInNewContext(code, { window: { __ModuleLoader__: { load: (entry: Entry) => (holder.entry = entry) } }, fetch: async () => new Response("{}"), setInterval, clearInterval });
    if (holder.entry === undefined) throw new Error("client.js 没有调用 __ModuleLoader__.load");
    return { id: holder.entry.id, exports: holder.entry.factory((name) => (name === "react" ? react : undefined)) };
  }

  it("registers one component in the settings.models.footer list slot, with an id", async () => {
    const { id, exports } = await load();
    const pkg = JSON.parse(await readFile(join(PLUGIN_DIR, "package.json"), "utf8")) as { name: string; dsh: { client: { platform: string; inject: string[] } } };
    expect(id).toBe(pkg.name); // 模块 id 必须等于包名，否则 DSH 找不到它
    expect(pkg.dsh.client.platform).toBe("web");
    expect(pkg.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-settings-models");
    expect(exports.inject).toEqual(["slots"]);
    const injected: string[] = [];
    const registered: Array<{ name: string; id?: string }> = [];
    exports.apply({
      slots: {
        inject: (name: string, factory: () => Generator<unknown>) => { injected.push(name); for (const _ of factory()) void _; },
        register: (options: { name: string; id?: string }) => (registered.push(options), options),
      },
    });
    expect(injected).toEqual(["settings.models.footer"]);
    // list 型席位的注册必须带 id（缺了会在 DSH 里抛 “requires options.id”）。
    expect(registered).toEqual([{ name: "settings.models.footer", id: "u-brain-login" }]);
  });
});

describe("multi-provider subscription login", () => {
  it("accepts exactly the supported providers over HTTP", () => {
    for (const provider of DSH_LOGIN_PROVIDER_IDS) {
      expect(DeckDshLoginBodySchema.safeParse({ action: "start", provider }).success).toBe(true);
    }
    expect(DSH_LOGIN_PROVIDER_IDS).toEqual(["anthropic", "openai-codex", "xai", "github-copilot", "kimi-coding"]);
    expect(DeckDshLoginBodySchema.safeParse({ action: "start", provider: "openai" }).success).toBe(false);
    expect(DeckDshLoginBodySchema.safeParse({ action: "wipe", provider: "xai" }).success).toBe(false);
  });

  it("surfaces a device code for providers that use that flow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-device-"));
    const script = join(dir, "login-oauth.mjs");
    await writeFile(script, `process.stdout.write(JSON.stringify({event:"device_code",userCode:"AB12-CD34",verificationUri:"https://accounts.x.ai/oauth2/device"})+"\\n");setInterval(()=>{},1000);`, "utf8");
    const login = new DshLogin({ nodePath: process.execPath, script, dshHome: join(dir, "home"), env: () => ({ PATH: process.env.PATH ?? "" }) });
    try {
      login.start("xai");
      const start = Date.now();
      let view = (await login.view()).find((item) => item.id === "xai");
      while (view?.deviceCode === undefined && Date.now() - start < 4_000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        view = (await login.view()).find((item) => item.id === "xai");
      }
      expect(view).toMatchObject({ state: "waiting", deviceCode: { userCode: "AB12-CD34", verificationUri: "https://accounts.x.ai/oauth2/device" } });
      expect(view?.url).toBeUndefined();
      expect((await login.view()).find((item) => item.id === "anthropic")?.state).toBe("idle");
    } finally {
      login.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recognises every supported provider's stored credential in the signed-in state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-signedin-"));
    try {
      await writeFile(join(dir, ".credentials.yaml"), "version: 1\nrecords:\n  llm-pi-ai/xai:\n    kind: grant\n  llm-pi-ai/openai-codex:\n    kind: grant\n");
      const login = new DshLogin({ nodePath: "/none", script: "/none", dshHome: dir, env: () => ({}) });
      const views = await login.view();
      expect(views.filter((item) => item.signedIn).map((item) => item.id).sort()).toEqual(["openai-codex", "xai"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
