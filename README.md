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
- **两种形态，同一个程序**：桌面端（菜单栏常驻）和服务器端（无界面常驻），核心逻辑完全共用。

## 部署形态

| 形态 | 适用 | 采集本机会话 | 常驻方式 |
|---|---|---|---|
| **桌面端** | 日常使用的电脑 | 是 | Tauri 外壳 + 开机自启 |
| **服务器端** | 7×24 在线的机器，通常担任主设备 | 否（本机没有 CLI 会话） | systemd 用户单元 |

同一个 Google 账号下的所有设备组成一个整体：会话原文各设备自管，话题册与数字分身全量同步。任何时刻只需一台设备在线即可，不需要中心服务器。

## 快速开始（源码运行）

```bash
bun install
bun run typecheck
bun test

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

## 部署到服务器

服务器端不需要图形界面，也不采集本机会话，只负责网页会话提炼、每日沉淀和协议同步。详细步骤见 **[docs/部署.md](docs/部署.md)**，要点：

```bash
# 1. 装包（Linux tar.gz，产物来自 CI 或本机 bun run build:server）
tar -xzf you-brain-<version>-<triple>.tar.gz
cd you-brain-<version>-<triple>
./install.sh

# 2. 首次设置：走自己的 Google Cloud 项目，无界面登录
you-brain setup --server --skip-brainhub --oauth custom \
  --client-id <xxx.apps.googleusercontent.com> --client-secret <secret>

# 3. 常驻 + 设为主设备
you-brain service install
sudo loginctl enable-linger $USER
you-brain devices --set-main <这台设备的 id>
```

无界面登录会打印一条 `ssh -N -L` 隧道命令和授权链接：在自己电脑上开隧道，浏览器打开链接即可完成授权。

## 授权方式

默认走**每个人自己的 Google Cloud 项目**，不需要依赖内置凭据，也不受测试用户数量限制：

1. Google Cloud Console 建项目，启用 Google Drive API
2. 创建 OAuth 客户端，类型选「桌面应用」
3. 把 client id（以 `.apps.googleusercontent.com` 结尾）和 secret 填进设置页「账户与 Drive → OAuth 凭据」，或 `setup --oauth custom`

> User type 选 **Internal**（同 Workspace 域名），或把应用发布到 **Production**；停在 Testing 状态时授权每 7 天过期，需要重新登录。

refresh token 只存在本机：桌面端进系统钥匙串，服务器端进数据目录下权限 0600 的 `secrets.json`。

## 文档

| 文档 | 内容 |
|---|---|
| [部署](docs/部署.md) | 桌面端与服务器端的安装、设置、常驻、远程访问、故障排查 |
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
