# ADR-0003：指挥台整页改用 DeepSeek Harness（dsh）

状态：已接受（2026-11-03）；取代 ADR-0001。

## 背景

旧指挥台是自研的：对话页 + 主控（本机 CLI 受限补全出决策 JSON）+ 四类执行者 + 周期任务。每多一类执行者就要改 `deck/service.ts`，用户也无法扩展。DeepSeek Harness（`@deepseek-ai/dsh`，MIT，截至 2026-11-03 为 0.2.1-rc.5、官方称 developer preview）是“一切皆插件”的 agent 运行时，自带 Web 界面、会话、模型管理、子代理、定时任务和插件机制。

## 决策

1. **指挥台 = dsh 的 Web 界面**，嵌入 U-Brain 窗口（iframe）。旧页面、旧主控、旧周期任务、旧执行者目录全部删除。
2. dsh 跑在 **随 App 打包的 Node 24** 上（dsh 要求 ≥ 24.9，daemon 在 bun 上）；daemon 托管 `dsh --profile web`：随启动拉起、崩溃自动重启，端口与令牌每次由系统分配。
3. **模型选择交给 dsh 自己**（它的模型设置页），U-Brain 不再有“主控”概念，也不给任何供应商设默认。设置里已有的供应商 Key 作为环境层凭据传给 dsh。
4. **订阅（OAuth）登录**：dsh 后端有登录流程（经 pi-ai），但 Web 界面没有入口；daemon 驱动 `login-oauth.mjs`，凭据写进 dsh 的凭据库（`<home>/.credentials.yaml`，权限 0600），完成后重启 dsh。
5. **扩展面**：CLI = dsh 子代理提供者；GUI App 桥 = dsh 插件 `u-brain-bridge`（回调 daemon，权限仍授给 U-Brain）；U-Brain 自身能力 = `you-brain mcp`；用户自己的插件 = `user.patch.yml`。
6. **会话进数字资产**：新增 `dsh` 采集来源读 dsh 的 zstd JSONL 会话文件。
7. **周期任务**：直接用 dsh 的自动化任务（一次性/间隔/每天/每周/cron，带时区），不再自维护；前提是 dsh 进程常驻（见 2）。

## 后果

- 体积：打包版 App 约 810 MB，其中 dsh 运行时约 490 MB（Node 114 MB + 裁剪后依赖 371 MB）。为控制体积裁掉了 codex / claude-agent-sdk 的原生载荷、LibreOffice、语音、调试器；代价是 claude-code / codex 两个子代理在打包版里不挂载。
- dsh 是预览版，版本固定为 0.2.1-rc.5，升级需单独验证。
- 旧周期任务的数据（`deck/tasks.json`）不迁移（本机为空）。
- 订阅登录借用的是 Claude Code 的 OAuth 客户端身份（授权范围含 `user:sessions:claude_code`）；第三方应用这样使用订阅是否被服务商允许未经核实，界面登录前会提示用户自行确认。
- 未验证：dsh 定时任务到点触发；dsh 会话被采集进数字资产的真实链路（需要一次真实对话）。
