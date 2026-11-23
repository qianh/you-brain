import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import { T3AssetCache, extractImmutableT3Assets, isImmutableT3AssetPath } from "../../src/deck/t3/asset-cache.js";
import { startT3Proxy, type T3Proxy } from "../../src/deck/t3/proxy.js";

describe("T3AssetCache 与跨设备 T3 转发加速", () => {
  const proxies: T3Proxy[] = [];
  let dir = "";

  afterEach(async () => {
    while (proxies.length > 0) proxies.pop()?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("精确识别带内容哈希的 /assets/* 路径并提取 HTML 与相对 chunk 引用", () => {
    expect(isImmutableT3AssetPath("/assets/index-B7f9aK2c.js")).toBe(true);
    expect(isImmutableT3AssetPath("/assets/KaTeX_Main-Cq6N9x8P.woff2")).toBe(true);
    expect(isImmutableT3AssetPath("/assets/plain.js")).toBe(false);
    expect(isImmutableT3AssetPath("/assets/../secret-B7f9aK2c.js")).toBe(false);
    expect(isImmutableT3AssetPath("/api/auth/session")).toBe(false);

    const fromHtml = extractImmutableT3Assets(
      `<link rel="stylesheet" href="/assets/index-C3p0R2d2.css"><script type="module" src="/assets/index-B7f9aK2c.js"></script>`,
      "/",
    );
    expect(fromHtml).toEqual(["/assets/index-C3p0R2d2.css", "/assets/index-B7f9aK2c.js"]);

    const fromJs = extractImmutableT3Assets(
      `import"./vendor-XyZ98765.js";const lazy=()=>import("./editor-AbCd1234.js");`,
      "/assets/index-B7f9aK2c.js",
    );
    expect(fromJs).toEqual(["/assets/vendor-XyZ98765.js", "/assets/editor-AbCd1234.js"]);
  });

  it("多台远端设备共享 L1/L2 构建产物缓存、优先走本机同哈希快路，且绝不把 HTML 兜底页当脚本缓存", async () => {
    dir = await mkdtemp(join(tmpdir(), "ub-t3-cache-"));
    let tunnelHits = 0;
    let localHits = 0;

    const cache = new T3AssetCache({
      cacheDir: dir,
      localOrigin: () => "http://127.0.0.1:3773",
      localFetch: (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        localHits += 1;
        if (path === "/assets/localhit-Aa11Bb22.js") {
          return new Response("console.log('from-local');", {
            status: 200,
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        }
        // 模拟本机 T3 版本不同：对未知哈希返回 SPA index.html，缓存必须忽略它并回退走隧道。
        return new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }) as typeof fetch,
    });

    const makeTransport = () => ({
      fetch: async (path: string) => {
        tunnelHits += 1;
        if (path === "/") {
          return new Response(
            `<!doctype html><html><head><script type="module" src="/assets/entry-Cc33Dd44.js"></script></head><body></body></html>`,
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        if (path === "/assets/entry-Cc33Dd44.js") {
          return new Response(`import("./lazy-Ee55Ff66.js");`, {
            status: 200,
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        }
        if (path === "/assets/lazy-Ee55Ff66.js") {
          return new Response(`export const ok = 1;`, {
            status: 200,
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        }
        // SPA 兜底页：绝不能入缓存。
        return new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
      openSocket: async () => {
        throw new Error("unused");
      },
    });

    const vpsProxy = startT3Proxy("http://t3.tunnel/", {
      port: 0,
      cookiePrefix: "ubd_vps_",
      assetCache: cache,
      transport: makeTransport(),
    });
    const macProxy = startT3Proxy("http://t3.tunnel/", {
      port: 0,
      cookiePrefix: "ubd_mac_",
      assetCache: cache,
      transport: makeTransport(),
    });
    proxies.push(vpsProxy, macProxy);

    // 1. 本机已有的同哈希 chunk：直接走本机快路，0 次隧道请求。
    const localFast = await fetch(new URL("/assets/localhit-Aa11Bb22.js", vpsProxy.url));
    expect(await localFast.text()).toBe("console.log('from-local');");
    expect(localFast.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(tunnelHits).toBe(0);
    expect(localHits).toBe(1);

    // 2. 打开第一台远端设备首页：自动顺着 HTML -> entry.js -> lazy.js 后台预热整棵模块树。
    const htmlRes = await fetch(vpsProxy.url);
    expect(htmlRes.status).toBe(200);
    for (let i = 0; i < 40 && !cache.hasMemory("/assets/lazy-Ee55Ff66.js"); i += 1) {
      await Bun.sleep(10);
    }
    expect(cache.hasMemory("/assets/entry-Cc33Dd44.js")).toBe(true);
    expect(cache.hasMemory("/assets/lazy-Ee55Ff66.js")).toBe(true);

    // 3. 切到第二台远端设备请求相同构建产物：直接命中共享缓存，不再走隧道！
    const beforeMacHits = tunnelHits;
    const macLazy = await fetch(new URL("/assets/lazy-Ee55Ff66.js", macProxy.url));
    expect(await macLazy.text()).toBe("export const ok = 1;");
    expect(tunnelHits).toBe(beforeMacHits);

    // 4. 新建一个只挂同一磁盘目录的新缓存实例（模拟 daemon 重启后）：直接命中磁盘二级缓存，仍不走隧道！
    const coldCache = new T3AssetCache({ cacheDir: dir });
    let coldTunnelHits = 0;
    const coldResult = await coldCache.getOrFetch("/assets/lazy-Ee55Ff66.js", async () => {
      coldTunnelHits += 1;
      return new Response("unexpected", { status: 500 });
    });
    expect("cached" in coldResult).toBe(true);
    expect(coldTunnelHits).toBe(0);

    // 5. 缺失 chunk 返回 text/html 时原样透传且不污染缓存。
    const fallback1 = await fetch(new URL("/assets/missing-Zz99Yy88.js", vpsProxy.url));
    expect(fallback1.headers.get("content-type")).toContain("text/html");
    expect(cache.hasMemory("/assets/missing-Zz99Yy88.js")).toBe(false);
  });
});
