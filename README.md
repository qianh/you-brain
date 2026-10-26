# you-brain

**你在任何设备上、和任何 AI 聊过的内容，都会被自动收集到你自己的 Google Drive；白天实时提炼成「今日话题」，每天沉淀进数字分身和话题册；换一台设备马上能接上，没跟进的话题会被提醒。**

个人 AI 记忆中枢，BrainHub MCP 的重写和升级版：所有数据存在**你自己的** Drive 里，模型可以用你自己的 API Key 或本机已登录的 AI CLI。

## 解决什么

| 痛点 | you-brain 的做法 |
|---|---|
| 在 Claude Code、Codex、Grok、Cursor、网页 AI 之间来回切换，上下文散落各处 | 七个本地 CLI 来源加浏览器插件，会话自动汇总到一处 |
| 换一台电脑，不知道今天在别的设备上聊了什么 | 提炼结果同步到所有设备，打开就能看到今日话题 |
| 聊过的事情没有下文，慢慢就忘了 | 话题册记录结论和待办，停滞了主动提醒 |
| 每个 AI 都不认识我，要反复交代偏好 | 数字分身自动接入各 AI CLI，按需提供完整画像 |
| 不想当人肉搬运工 | 采集、上传、提炼、同步、提醒全部自动 |

## 主要能力

- **会话采集**：Claude Code、Codex CLI、Grok Build、Cursor、Gemini CLI、Pi、T3 Code，加上浏览器插件上报的网页 AI 会话。只保留可见文本和图片，去掉 system prompt、隐藏推理、工具调用和 shell 输出，凭证脱敏，并过滤掉 CLI 启动时写入的空会话。
- **原地更新上传**：一个会话对应 Drive 上一个文件，后续增长时原地更新，**链接永远不变**。
- **会话提炼**：空闲后由产生它的设备提炼出标题、概要、话题、结论、待办；继续增长时只把「上次结果 + 新增消息」交给模型。
- **话题册**：事件日志驱动，支持合并、活跃区/历史区、状态流转；话题总览和详情也会写成 Drive 上的 markdown。
- **数字分身**：全量版、精简版、编码版三种，由每日沉淀更新，可手动纠正。
- **本地搜索**：语义检索本机会话；其他设备上的会话通过 Drive 全文搜索补齐，不下载全文。
- **本地文件与 MCP**：写出 `TODAY.md`、`TOPICS.md`、`REMINDERS.md`，并通过 MCP 暴露给 AI CLI。
- **多设备**：会话原文各设备自管，话题册全量同步；可用一台服务器担任主设备做每日沉淀。

## 快速开始

```bash
bun install
bun run typecheck
bun test --preload ./scripts/test-preload.ts

# 交互式配置：选模型后端、登录 Google Drive、初次回填
bun packages/cli/src/index.ts setup

# 前台跑起来
bun packages/cli/src/index.ts daemon
```

桌面版（菜单栏常驻）：

```bash
bun run --cwd apps/web build      # 界面产物
bun run build:daemon              # daemon 与 sidecar（含 vendor）
bun run --cwd apps/desktop bundle # macOS 打包；Linux 用 bundle:linux
```

## 文档

| 文档 | 内容 |
|---|---|
| [产品说明](docs/产品说明.md) | 要解决的问题、领域概念、功能说明、里程碑 |
| [技术方案](docs/技术方案.md) | 架构、数据格式、协议同步、调度、安全 |
| [进度](docs/进度.md) | 各里程碑条目与证据、真实环境实跑记录 |
| [待办](docs/TODO.md) | 已完成、进行中、需要决定的事项 |
| [领域术语](CONTEXT.md) | 数字资产、知识库等概念的准确定义 |
| [协议文档](docs/protocol/README.md) | 虚拟设备协议、事件文件、会话文件格式 |

## 技术栈

Bun + TypeScript，SQLite（`bun:sqlite`）保存本地状态，Google Drive 作为唯一的数据中转，Tauri 做桌面外壳，React 做界面，本地嵌入模型（`Xenova/multilingual-e5-small`）做语义检索。

支持 macOS 和 Linux。

## 许可证

尚未确定（见 [TODO](docs/TODO.md)）。
