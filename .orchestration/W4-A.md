# 任务 W4-A：集成缺口修复 + daemon 打包（core、cli、scripts）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你可以修改：packages/core/**、packages/cli/**、仓库根 scripts/**（新建）、根 package.json 的 scripts 字段。不要改 apps/**（别人并行在改）。
注意：本机 bun 1.3.11 在 `~/.local/share/fnm/node-versions/v22.15.0/installation/bin/bun`，PATH 里已经加好；如果 `bun` 找不到就用这个绝对路径。

## 1. 主控验收发现的缺口（逐项修复并补测试）
1. **Web UI 托管**：`you-brain daemon` 没有把 Web UI 构建目录传给 daemon 的 staticDir，真实运行时打不开界面。按顺序解析：环境变量 `YOU_BRAIN_WEB_DIR` → 可执行文件同级的 `web/` 目录（打包后）→ macOS app 包内 `../Resources/web`（Tauri 资源）→ 源码运行时的 `apps/web/dist`。都没有时 `/` 返回一个说明页。
2. **AI 工具接入的同意没有接上**：`setup` 和 `integrations` 中用户勾选的项（MCP 注册、各 CLI 编码版注入、skill）要持久化为"已同意列表"（本地配置），daemon 启动时及数字分身 coding 变体更新/路径变化时，对已同意的 CLI 自动 apply 托管段落（用 portrait/clients 已有的能力），撤销时删除。这是 P0 验收项"Codex / Claude Code 新会话能读到编码版数字分身"。用临时 HOME 写测试。
3. **沉淀告警误报**：全局沉淀是 P1 且默认关闭。`/api/status` 中只有 `roles.consolidation.enabled = true` 时才计算"超过 1 天未沉淀"告警，否则状态为"未启用"。
4. **采集开关**：确认 shared 配置里的 keepToolCalls / includeSubagents / redact 与各来源开关、扫描路径、包含/排除目录真实传到了适配器（产品说明 5.3），没有接上的接上并测试。
5. 浏览器侧：确认 `@you-brain/core/http` 的 types 可以被 apps/web 以 `import type` 使用（不要引入运行时依赖），不需要改 web。

## 2. daemon 打包（技术方案 2、18；参考 .orchestration/m0/ 中已实测通过的方案与 W1-F 结论：.orchestration/logs/W1-F.log）
- 新建 `scripts/build-daemon.ts`（bun 运行）：
  - `bun build --compile` 把 packages/cli/src/index.ts 编译为单文件 `you-brain`；`@huggingface/transformers`、`sharp`、`onnxruntime-node` 不打进单文件，标为 external。
  - 生成一个只含这几个原生依赖的 vendor `node_modules`（用 bun install 到临时目录再拷贝），运行时由 resolver 从"可执行文件同级的 `vendor/node_modules`"加载（参考 m0 中的 `Module._resolveFilename` 方案，写成 core 内的一个小模块，源码运行时直接走正常 import）。
  - 拷贝 apps/web/dist 到 `web/`（若存在）。
  - 输出到 `dist/daemon/<target-triple>/`（you-brain、vendor/、web/），并复制可执行文件到 `apps/desktop/src-tauri/binaries/you-brain-<target-triple>`（Tauri externalBin 命名规则；本机是 aarch64-apple-darwin）。资源目录（vendor、web）如何随 Tauri 打包，在最终回复中给出 tauri.conf.json 需要的 `bundle.resources` 配置（apps 由别人改，你只给出配置）。
- 根 package.json 加 `build:daemon` 脚本。
- **实测**：编译产物在临时数据目录下 `./you-brain --version`、`./you-brain daemon`（未登录状态启动，curl `/api/status` 带 token 成功，`/` 能返回 Web UI 的 index.html 且已注入 token），`./you-brain mcp` 能响应 MCP initialize（用 stdio 发一条 JSON-RPC 测试），sharp 转 webp 与 e5 嵌入在编译产物中可用（嵌入可以用已下载的模型缓存或允许联网下载）。测完关进程。

## 验收
全仓库 `bun test` 通过；core/cli tsc 0 错误；最终回复包含打包产物实测的命令与输出。
