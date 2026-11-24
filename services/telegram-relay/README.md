# U-Brain Telegram 中转

多台电脑共用**一个** Telegram Bot 时使用。一个 Bot 同一时间只能有一个程序收消息：每台电脑都直连的话会互相抢消息（Telegram 返回 409），回复也可能落到别的电脑上。

用中转后：

- Telegram 只把消息发给中转（webhook）。
- 每台电脑主动连一条 WebSocket 到中转，不需要公网地址。
- 推送开头标出是哪台电脑（只有一台时不标）。
- 回复某条提醒，会回到推送它的那台电脑。
- 直接发消息，会发给最近推送过、或最近被回复过的那台电脑（2 小时内有效）。
- 发 `/devices` 等任意 `/` 命令，可以看到在线的设备。

可以跑在 Cloudflare Workers + Durable Objects 上，用免费套餐就够：每天 10 万次请求，心跳由运行时自动应答，不计入时长。也可以跑在自己的 VPS 上，见下文。

## 部署到 Cloudflare（一次）

需要一个 Cloudflare 账号（免费），并在本目录执行以下命令。`wrangler` 不加入项目依赖，用 `bunx` 临时运行。

```bash
cd services/telegram-relay
bunx wrangler@4 login                    # 浏览器里授权一次
bunx wrangler@4 secret put BOT_TOKEN     # 粘贴 @BotFather 给的 Token
bunx wrangler@4 secret put RELAY_KEY     # 自己生成一个，例如: openssl rand -hex 24
bunx wrangler@4 deploy                   # 输出 https://u-brain-telegram-relay.<子域>.workers.dev
```

- 第一次部署时，wrangler 可能提示注册 `workers.dev` 子域，按提示操作即可。
- 两个 secret 也可以在部署之后再设置；设置后不用重新部署。
- `RELAY_KEY` 至少 16 位，每台电脑都要用同一个。只有中转和你自己知道它；Telegram webhook 的校验串也由它派生。

## 在自有 VPS 上部署

**推荐：一键部署脚本。** 在本机仓库里执行，会按下面 1–3 步自动完成（本地测试、同步 `src`、建运行用户、首次生成环境文件、安装 systemd 单元、部署 coturn、重启、自检），已有的 `/etc/u-brain-relay.env` 不会被改动，重复执行即升级：

```bash
services/telegram-relay/deploy/deploy.sh --dry-run   # 先看会同步什么，不改 VPS
services/telegram-relay/deploy/deploy.sh             # 正式部署 / 升级
```

连接信息取自 `--target user@host --port N`、环境变量 `RELAY_SSH_TARGET` / `RELAY_SSH_PORT`，或仓库根 `.env` 的 `Address` / `SSH_Port`（需 root + 密钥登录）。`--skip-turn` 跳过 coturn，`--skip-test` 跳过本地测试。首次部署后仍需手工填 `BOT_TOKEN`，并配好 Caddy / cloudflared 反代。下面是手工步骤，脚本出问题时可对照。

中转只监听 `127.0.0.1`，由 Caddy 提供 HTTPS 并反代，WebSocket 不需要额外配置。密钥只放在权限 `0600` 的环境文件里，不要写进命令行参数、shell 历史或聊天。

需要一台 Linux VPS，本机已装好 `bun`（或做一条到 `/usr/local/bin/bun` 的符号链接）和 Caddy。在仓库里执行：

1. 拷贝代码并建立运行用户。

   ```bash
   sudo useradd --system --user-group --home-dir /var/lib/u-brain-relay --shell /usr/sbin/nologin u-brain-relay
   sudo mkdir -p /opt/u-brain-relay
   sudo cp -R services/telegram-relay/src /opt/u-brain-relay/src
   sudo ln -sfn "$(command -v bun)" /usr/local/bin/bun
   ```

2. 写环境文件，权限 `0600`。把 `deploy/u-brain-relay.env.example` 复制成 `/etc/u-brain-relay.env`，只在这个文件里填 `BOT_TOKEN` 和 `RELAY_KEY`（至少 16 位）。

   ```bash
   sudo install -m 0600 -o root -g u-brain-relay services/telegram-relay/deploy/u-brain-relay.env.example /etc/u-brain-relay.env
   sudo editor /etc/u-brain-relay.env
   ```

3. 安装 systemd 单元。`StateDirectory=u-brain-relay` 会创建 `/var/lib/u-brain-relay`，状态写在里面的 `state.json`（权限 `0600`）。

   ```bash
   sudo cp services/telegram-relay/deploy/u-brain-relay.service /etc/systemd/system/u-brain-relay.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now u-brain-relay
   ```

4. 配置 Caddy。把 `deploy/Caddyfile.example` 里的 `relay.example.com` 换成你的域名，放到 Caddy 的站点配置里并重新加载。Caddy 会带上 `X-Forwarded-Proto`，中转用它注册 `https://你的域名/telegram`。

5. 验证 `/check`。下面把密钥放进 curl 的配置文件，避免出现在命令行参数里。期望输出 `{"ok":true,"botConfigured":true}`。

   ```bash
   umask 077
   cfg=$(mktemp)
   sudo awk -F= '/^RELAY_KEY=/ { key = substr($0, index($0, "=") + 1) } END { printf "header = \"Authorization: Bearer %s\"\nurl = \"https://relay.example.com/check\"\n", key }' /etc/u-brain-relay.env > "$cfg"
   curl --config "$cfg"
   rm -f "$cfg"
   ```

### 远程桌面的 TURN 中继（coturn）

远程桌面（WebRTC）在两台设备跨网或开 VPN 时靠 TURN 中继兜底。中转只负责签发临时凭据，TURN 服务本身要在 VPS 上装 coturn，一条命令搞定（幂等，重跑会复用已有密钥）：

```bash
scp services/telegram-relay/deploy/setup-turn.sh root@<VPS>:/root/
ssh root@<VPS> 'bash /root/setup-turn.sh [公网IP或域名]'
```

脚本会装 coturn、写 `/etc/turnserver.conf`、把 `RELAY_TURN_URLS` 与 `RELAY_TURN_SECRET` 写进 `/etc/u-brain-relay.env`（先备份）、重启 coturn 和中转，并用同一算法签一个临时凭据自检。云厂商若另有安全组，需放行 3478/tcp+udp 与 49152-65535/udp。`coturn.conf.example` 仅作手工配置参考。

### 从 Cloudflare 切换，以及回滚

1. 先在 VPS 上把新中转跑起来，先不要改设备。
2. 一台 Mac 改成新地址并连接。中转会向 Telegram 查询当前 webhook，不一致就 `setWebhook` 到 VPS。私聊绑定存在中转自己的状态里，Cloudflare 上的绑定不会跟着过来，需要在新中转上重新生成绑定链接并绑定一次。
3. 另一台 Mac 和 VPS 上的 daemon 也改过去。各发一条测试消息，确认手机能收到，回复能回到推送它的那台设备。
4. Cloudflare Worker 先留着，至少一周不要删。回滚就是把设备的中转地址改回 Cloudflare。设备连上后会再次比对 webhook，Telegram 上的地址会改回去。这要求 Cloudflare 上的 Worker 也是会调用 `getWebhookInfo` 的这一版；如果线上还是旧版（只看自己记下的「已设置」），需要先重新部署一次 Worker，密钥不用改。

## 每台电脑上

打开 U-Brain「设置 → 集成 → Telegram → 多台设备共用一个 Bot（中转）」，然后：

1. 第一台电脑：填入中转地址和 `RELAY_KEY`，再给这台电脑起个名字，留空则用主机名。点「连接中转」。
   之后的电脑：在已连接的电脑上点「复制连接信息」，到新电脑上粘贴到「连接信息」框，地址和密钥会自动填好，起个名字后点「连接中转」。连接信息包含密钥，别发到聊天软件里。
2. 任意一台电脑上点「生成绑定链接」，用手机打开链接并点「开始」。只需要绑定一次，所有电脑共用这个绑定。

第一台电脑连上时，中转会自动给 Bot 设置 webhook。之后还在直连同一个 Bot 的电脑会报“另一个程序正在用这个 Bot 收消息”，把它们也切到中转即可。

## 设备入网与吊销

跨设备派活要求每台设备拥有独立令牌与 Ed25519 密钥对，避免单台设备泄露后影响整组设备。管理端点（`/admin/*`）只面向 VPS 本机开放：Caddy 对外返回 404，中转也会对携带 `X-Forwarded-For` 或 `Forwarded` 头的 `/admin/*` 请求直接返回 404。

### 入网流程

1. 在 VPS 本机加载 `/etc/u-brain-relay.env`（不要把密钥写进命令行参数），生成一次性邀请码（8 位、10 分钟有效；连续错误兑换 5 次会作废当前全部未用邀请码）：

   ```bash
   sudo sh -c 'set -a; . /etc/u-brain-relay.env; set +a; /usr/local/bin/bun /opt/u-brain-relay/src/admin.ts invite'
   ```

2. 在目标设备的 U-Brain 设置页输入中转地址与邀请码。设备会向 `POST /enroll` 上报 `deviceId`、设备名和 Ed25519 公钥（base64url SPKI DER），中转返回一次性的专属设备令牌（`ubd_...`，服务端只存 sha256 哈希）。
3. 查看已入网设备列表（不含令牌哈希）：

   ```bash
   sudo sh -c 'set -a; . /etc/u-brain-relay.env; set +a; /usr/local/bin/bun /opt/u-brain-relay/src/admin.ts devices'
   ```

### 吊销设备

如设备丢失、重装或需要更换公钥，先在 VPS 本机吊销该设备：

```bash
sudo sh -c 'set -a; . /etc/u-brain-relay.env; set +a; /usr/local/bin/bun /opt/u-brain-relay/src/admin.ts revoke <deviceId>'
```

中转会写入 `revokedAt`、立即以关闭码 `4001`（`revoked`）断开该设备当前连接，并拒绝其使用旧令牌重连。同一 `deviceId` 必须在吊销后才能重新用新邀请码入网。

### 过渡期与关闭旧共享密钥

- 默认 `RELAY_ACCEPT_LEGACY_KEY=true`：尚未入网的设备仍可用旧 `RELAY_KEY` 连接 `/connect` 与 `/check` 收发 Telegram 通知，但不能发送 `hello`、`cmd`、`event` 等跨设备派活帧（中转会返回「请先入网」）。
- 全部设备完成入网后，编辑 `/etc/u-brain-relay.env` 将 `RELAY_ACCEPT_LEGACY_KEY=false` 并重启服务：

  ```bash
  sudo systemctl restart u-brain-relay
  ```

- 关闭后，`RELAY_KEY` 不能再连 `/connect` 或 `/check`，仅保留给 `/telegram` 的 webhook 校验串派生和本机 `/admin/*` 管理操作。
- 审计日志追加写入 `<RELAY_DATA_DIR>/audit.jsonl`（权限 `0600`，超过 5 MB 轮转为 `audit.jsonl.1`），只记录时间、来源、目标、动作类型与结果，不包含指令参数、返回结果、设备令牌或邀请码。

## 停用

- 某台电脑点「停用中转」，就回到直连。如果这台电脑还存着 Bot Token，会直接开始收消息。
- 所有电脑都不再用中转时，需要删除 webhook，否则直连收不到消息：

  ```bash
  curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
  ```

  也可以执行 `bunx wrangler@4 delete` 删除整个 Worker；删除 Worker 不会自动删除 webhook。

## 开发

- `src/core.ts`：Telegram 分发逻辑，不依赖具体运行时。用 `bun test services/telegram-relay` 测试。
- `src/enroll.ts`：设备入网、一次性邀请码、令牌哈希校验与吊销逻辑。
- `src/dispatch.ts`：跨设备 `hello` / `cmd` / `result` / `event` 路由、防重放、限速与待结果超时（纯逻辑，端口注入）。
- `src/audit.ts`：审计日志（0600，5 MB 轮转）。
- `src/worker.ts`：Cloudflare 外壳，包括 webhook 校验、WebSocket 休眠和 Durable Object 存储。
- `src/server.ts`：Bun 外壳（自有 VPS），`src/main.ts` 是进程入口，`src/admin.ts` 是本机管理命令行。状态在 `state.json`。
- 设备端代码在 `packages/core/src/deck/telegram/relay.ts`。两台设备经中转联调的测试在 `packages/core/test/deck/telegram-relay.test.ts`。
