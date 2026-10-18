# 任务 W3-A：daemon 组装 + CLI + 端到端测试（core/daemon、packages/cli）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
这是**集成任务**：把已完成的全部 core 模块接成可运行的产品。先通读 packages/core/src 下所有模块的公开接口（index.ts、types.ts）再动手。
你可以修改：packages/core/src/daemon/**、packages/core/test/daemon/**、packages/core/test/e2e/**、packages/cli/**、packages/core/src/index.ts；以及下面"允许的小改动"列出的位置。不要改 apps/**（别人在并行开发 Web UI 和 Tauri）。不要新增依赖。

## 允许的小改动（第二波报告的遗留项）
1. store：新增 `listSessions`（按 updatedAt 倒序，支持 limit / topicId 过滤），并在 http/mcp 中把话题详情与活跃区的会话来源改为覆盖"只存在于 sessions 表"的会话。
2. search：增加只读搜索入口（不触发 Drive 同步），MCP 的 search_sessions 用它（技术方案 13.1：只有 get_session 访问 Drive）；daemon 负责定期刷新搜索索引。search 中复制的 redactText 改为复用 capture/redact。
3. http：托管 Web UI 静态文件时，在 index.html 的 `</head>` 前注入 `<script>window.__YOU_BRAIN__={"token":"…"}</script>`（同源访问，Web UI 从这里拿 token）；`/` 与 `/panel` 等前端路由都回退到 index.html。

## daemon（技术方案 14.1，及 5、7、8 节的调度要求）
- 单实例锁文件（数据目录下，含 pid，进程不存在时可接管）。
- 组装：本地配置 → 钥匙串 → Drive（google-drive，未登录时进入"未授权"状态但 HTTP API 照常可用）→ store → sync → topics → search → llm → refine → upload → portrait → output → http。
- 调度（全部可注入时钟，便于测试）：
  - 采集：fs watch 各来源目录 + 10 分钟全量扫描兜底；会话文件 5 分钟无写入视为空闲（时长取 shared 配置）。
  - 空闲会话：先上传（原地更新）再增量提炼 → 事件写入 EventLog（本地立即应用）→ 更新 sessions 表；持续活跃的会话最多每 5 分钟上传一次。
  - 提炼失败进入 llm 重试队列，状态页可见。无模型配置时跳过提炼但仍上传，并在状态中提示。
  - 事件 flush 30 秒、心跳 5 分钟、pull 60 秒（SSE 订阅者在线时可更快）、数字分身每天一次 + 变更时立即拉取、output 防抖 10 秒、搜索索引后台刷新。
  - 话题册变化 → output 刷新 + HTTP SSE 推送。
- 优雅退出（SIGINT/SIGTERM：flush outbox、关闭数据库、删除 daemon.json 和锁）。

## CLI（技术方案 14.3，P0 范围；commander）
`you-brain daemon`（前台运行）、`mcp`、`setup`、`status`、`today`、`topics [--history]`、`topic <id>`、`portrait [--variant]`、`devices [--set-main <id>] [--set-web-processor <id>]`、`sync [--now]`、`integrations`（列出/应用/撤销 MCP 注册、CLI 注入、skill，逐项确认）、`brainhub restore`、`uninstall`、`--version`。
- 查询类命令通过 daemon HTTP API（读 daemon.json）；daemon 未运行时给出明确提示（status 例外：daemon 未运行时也能读本地库输出基础信息）。
- `setup`：可恢复的分步流程（参考 BrainHub src/setup/setup-service.ts）：Google 登录（官方 / 自带凭据）→ Drive 根目录（继承 BrainHub 配置）→ 检测并询问接管 BrainHub → 模型 Provider/模型/API Key（存钥匙串，测试连接）→ 采集来源 → AI 工具接入逐项勾选 → 首次回填确认（展示各来源会话数量）。支持 `--yes` 非交互和各项参数，便于脚本使用。
- `uninstall`：撤销所有托管段落、MCP 注册、skill，删除 launchd/开机项（如有），可选删除本地数据。

## 测试
- daemon 单元测试：调度节拍、空闲判断、失败重试、锁。
- **端到端（技术方案 19）**：在同一进程里启动两个 daemon（不同 YOU_BRAIN_DATA_DIR/YOU_BRAIN_HOME、临时来源目录），共享同一个 memory-drive 和 fake LLM：在设备 A 的来源目录写一个 claude-code 会话 → 推进时钟 5 分钟 → 断言 A 上传了 inbox 文件、产生提炼事件、TODAY.md 出现概要且已归入话题；B pull 后 /api/today 能看到；A 会话继续增长 → Drive fileId 不变、提炼更新；MCP search_sessions 能搜到。这就是产品验收标准，务必真实跑通。
- CLI：用临时目录跑 `--version`、`status`（daemon 未运行）、`today`（连到测试 daemon）。

## 验收
`bun test`（全仓库）全部通过；`bunx tsc --noEmit -p packages/core` 与 `-p packages/cli` 0 错误；`YOU_BRAIN_DATA_DIR=$(mktemp -d) YOU_BRAIN_HOME=$(mktemp -d) bun packages/cli/src/index.ts daemon` 能在未登录状态下启动并响应 `/api/status`（自己测完要关掉进程）。
