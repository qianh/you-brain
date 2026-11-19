# U-Brain Telegram 中转

多台电脑共用**一个** Telegram Bot 时使用。一个 Bot 同一时间只能有一个程序收消息：每台电脑都直连的话会互相抢消息（Telegram 返回 409），回复也可能落到别的电脑上。

用中转后：

- Telegram 只把消息发给中转（webhook）。
- 每台电脑主动连一条 WebSocket 到中转，不需要公网地址。
- 推送开头标出是哪台电脑（只有一台时不标）。
- 回复某条提醒，会回到推送它的那台电脑。
- 直接发消息，会发给最近推送过、或最近被回复过的那台电脑（2 小时内有效）。
- 发 `/devices` 等任意 `/` 命令，可以看到在线的设备。

运行在 Cloudflare Workers + Durable Objects 上，用免费套餐就够：每天 10 万次请求，心跳由运行时自动应答，不计入时长。

## 部署（一次）

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

## 每台电脑上

打开 U-Brain「设置 → 集成 → Telegram → 多台设备共用一个 Bot（中转）」，然后：

1. 填入中转地址和 `RELAY_KEY`，再给这台电脑起个名字，留空则用主机名。点「连接中转」。
2. 任意一台电脑上点「生成绑定链接」，用手机打开链接并点「开始」。只需要绑定一次，所有电脑共用这个绑定。

第一台电脑连上时，中转会自动给 Bot 设置 webhook。之后还在直连同一个 Bot 的电脑会报“另一个程序正在用这个 Bot 收消息”，把它们也切到中转即可。

## 停用

- 某台电脑点「停用中转」，就回到直连。如果这台电脑还存着 Bot Token，会直接开始收消息。
- 所有电脑都不再用中转时，需要删除 webhook，否则直连收不到消息：

  ```bash
  curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
  ```

  也可以执行 `bunx wrangler@4 delete` 删除整个 Worker；删除 Worker 不会自动删除 webhook。

## 开发

- `src/core.ts`：分发逻辑，不依赖 Cloudflare 运行时。用 `bun test services/telegram-relay` 测试。
- `src/worker.ts`：Cloudflare 外壳，包括 webhook 校验、WebSocket 休眠和 Durable Object 存储。
- 设备端代码在 `packages/core/src/deck/telegram/relay.ts`。两台设备经中转联调的测试在 `packages/core/test/deck/telegram-relay.test.ts`。
