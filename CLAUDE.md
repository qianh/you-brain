# you-brain 项目规则

领域术语见 `CONTEXT.md`，部署细节见 `docs/部署.md`。

## 打包安装（macOS）

依赖安装一律走 npmmirror，不要直接从 registry.npmjs.org 下载。完整流程：

```bash
export BUN_CONFIG_REGISTRY=https://registry.npmmirror.com
export npm_config_registry=https://registry.npmmirror.com

bun run build:daemon                # 含 Web 构建，约 3.5 分钟
bun run --cwd apps/desktop bundle   # 产物在 dist/app.noindex/，约 9 分钟

osascript -e 'quit app "U-Brain"'
pkill -TERM -f '/Applications/U-Brain.app/Contents/MacOS/you-brain daemon'
rm -rf /Applications/U-Brain.app
cp -R dist/app.noindex/U-Brain.app /Applications/
codesign --verify --deep --strict /Applications/U-Brain.app
open -a /Applications/U-Brain.app
```

- 这两个构建步骤耗时较长，放后台跑并把日志写到文件，完成后再安装。
- 不需要关 VPN，也不需要取消 `HTTP_PROXY`。
- 退出 App 后旧 daemon 可能还要等一会儿才退出；新 daemon 会等它释放锁，不用手动强杀。
- 应用名是 `U-Brain.app`，不是 `you-brain.app`。

### 为什么

`build:daemon` 里的 `bun install`、`npm ci` 要下载 onnxruntime-node（113 MB）等大包，从 npmjs 下载时要经过本机 Shadowrocket。2026-11-04 实测：

| 下载 onnxruntime-node | 结果 |
|---|---|
| npmjs，走代理 `127.0.0.1:1082` | 约 120 KB/s，要 15 分钟以上 |
| npmjs，取消代理变量（仍走 TUN） | 25 秒内 0 字节 |
| npmjs，绑定物理网卡绕过 VPN | 5.7 MB/s，20 秒 |
| 用 npmmirror 跑 `bun install`（无论是否走代理） | 全部依赖 23～38 秒装完 |

这时 bun 只显示 `Resolving dependencies`，没有进度，看起来像卡死。元数据请求是通的，所以用 curl 测 registry 正常，不能据此排除网络问题。

本地缓存齐全时不用下载，走哪条路都很快，因此这个问题时有时无。

### 又卡住时

1. 确认 `BUN_CONFIG_REGISTRY` 和 `npm_config_registry` 都设置了。
2. 用 `lsof -nP -a -p <pid> -iTCP` 看连接：连着 `127.0.0.1:1082` 或 `198.18.0.x` 说明还在走 VPN，是镜像变量没生效。
3. 不要用已安装 App 里的 vendor 拼包来绕过；那样容易漏掉依赖更新。

## 只换 daemon 时

`bun run install:app` 只替换 daemon、`web`、`vendor`、`dsh`，不重建桌面外壳，且要先跑过 `build:daemon`（同样要设镜像）。改过 `apps/desktop` 必须走上面的完整流程。
