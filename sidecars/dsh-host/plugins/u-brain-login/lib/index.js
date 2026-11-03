// u-brain-login 的宿主半边（跑在 dsh 进程里）：挂一条同源路由，把前端的登录请求转给 U-Brain 的 daemon。
//
// 为什么要转一道：真正的登录引擎和凭据写入由 daemon 管（它还负责登录后让 dsh 重载路由）；
// 而浏览器里的 DSH 页面和 daemon 不同源，也拿不到 daemon 的令牌。所以前端只请求本页同源的
// /u-brain/login，由这里读 <数据目录>/daemon.json（权限 0600）拿端口和令牌再转发。
//
// 访问控制：路由只在 127.0.0.1 上可达；要求 Host 是回环地址、带自定义头 x-u-brain（跨站页面无法带上它，
// 因为我们从不响应 CORS 预检）、且 Sec-Fetch-Site 不是跨站。DSH 自己的令牌栅栏不覆盖插件路由。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "u-brain-login";
export const inject = ["webServer"];

const PATH = "/u-brain/login";
const MAX_BODY = 4_096;

function allowed(req) {
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(req.headers.host ?? "")) return false;
  if (req.headers["x-u-brain"] !== "1") return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

async function daemon() {
  const dataDir = process.env.YOU_BRAIN_DATA_DIR;
  if (!dataDir) throw new Error("没有 YOU_BRAIN_DATA_DIR，无法连接 U-Brain");
  let info;
  try {
    info = JSON.parse(await readFile(join(dataDir, "daemon.json"), "utf8"));
  } catch {
    throw new Error("U-Brain 的后台没有运行（找不到 daemon.json）");
  }
  if (!Number.isInteger(info.port) || typeof info.token !== "string") throw new Error("daemon.json 内容不合法");
  return { base: `http://127.0.0.1:${info.port}`, token: info.token };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 纯函数，便于测试：处理一次请求，daemon 的获取与 fetch 可注入。 */
export async function handle(req, res, deps = {}) {
  if (!allowed(req)) return send(res, 403, { error: "forbidden" });
  try {
    const { base, token } = await (deps.daemon ?? daemon)();
    const init = { headers: { authorization: `Bearer ${token}` } };
    if (req.method === "POST") {
      init.method = "POST";
      init.headers["content-type"] = "application/json";
      init.body = await readBody(req);
    } else if (req.method !== "GET") {
      return send(res, 405, { error: "method not allowed" });
    }
    const response = await (deps.fetch ?? fetch)(`${base}/api/deck/dsh/login`, init);
    const text = await response.text();
    res.writeHead(response.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  } catch (error) {
    send(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: PATH,
      handler: (req, res) => handle(req, res),
    }),
  );
}
