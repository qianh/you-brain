# you-brain 项目规则

领域术语见 `CONTEXT.md`，部署细节见 `docs/部署.md`。

## 打包安装（macOS）

依赖安装一律走 npmmirror，不要直接从 registry.npmjs.org 下载；`build:daemon` 已默认使用，不用手动设置。完整流程：

```bash
bun run build:daemon                              # 含 Web 构建；依赖没变约 25 秒，要重装约 1 分钟
bun run --cwd apps/desktop bundle --bundles app   # 只出 .app，产物在 dist/app.noindex/，约 2.5 分钟

osascript -e 'quit app "U-Brain"'
pkill -TERM -f '/Applications/U-Brain.app/Contents/MacOS/you-brain daemon'
rm -rf /Applications/U-Brain.app
cp -R dist/app.noindex/U-Brain.app /Applications/
codesign --verify --deep --strict /Applications/U-Brain.app
open -a /Applications/U-Brain.app
```

- 本机安装不需要 DMG；要发布时才去掉 `--bundles app`。
- 不需要关 VPN，也不需要手动取消 `HTTP_PROXY`：vendor 的 `bun install` 第一次会自动直连镜像，失败才走代理。
- 依赖没变时复用 `dist/.build-cache/`；怀疑缓存有问题就设 `YOU_BRAIN_NO_BUILD_CACHE=1` 重跑。
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

2026-11-05 又发现即使用了镜像，`bun install` 也可能卡住：缓存里的元数据过期后，经代理会一直停在 `Resolving dependencies`。

| 镜像 + 已有缓存（元数据过期） | 结果 |
|---|---|
| 走代理 `127.0.0.1:1082` | 脚本内 5 分钟未完成（连续两次），手动 60 秒未完成 |
| 直连（仍走 TUN） | 0.4 秒 |
| 直连刷新元数据后再走代理 | 0.1 秒 |

没有缓存时不会卡：走代理 66 秒，直连 19 秒。`npm ci` 也没有卡住，走代理 52 秒，直连 104 秒，所以只有 `bun install` 优先直连。

### 又卡住时

1. 安装步骤 5 分钟没完成会自动结束并重试一次，日志里能看到“第 2 次”。
2. 用 `lsof -nP -a -p <pid> -iTCP` 看连接：第一次安装连着 `127.0.0.1:1082` 说明没有直连。
3. 不要用已安装 App 里的 vendor 拼包来绕过；那样容易漏掉依赖更新。

## 只换 daemon 时

`bun run install:app` 只替换 daemon、`web`、`vendor`、`dsh`，不重建桌面外壳，且要先跑过 `build:daemon`（同样要设镜像）。改过 `apps/desktop` 必须走上面的完整流程。
