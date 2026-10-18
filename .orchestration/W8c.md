# 任务 W8c：CLI 后端「卡住无输出」的处理（gemini 登录过期场景）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
可修改：packages/core/src/llm/cli/**、packages/core/src/llm/setup-status.ts、packages/core/src/daemon/daemon.ts（只改模型状态相关）、packages/cli/src/setup.ts、对应测试。

## 现象（主控真机复现）
本机 gemini 登录已过期。`gemini -o json "reply ok"` 在非交互下**一直挂起、stdout/stderr 均无输出**（45 秒仍未结束）。CLI 后端要等默认 300 秒超时，归类为可重试的 network。后果：
- `you-brain setup` 的连接测试要卡 5 分钟；
- daemon 每次沉淀都卡 5 分钟再重试。

## 要求
1. setup 的连接测试对 cli 类使用短超时（90 秒）。超时时打印「xxx 在 90 秒内没有响应，可能需要重新登录：请在终端运行 <登录命令> 后重试」，本步中止，前面完成的步骤保留。等待期间打印一行「正在调用 xxx 测试连接（最多 90 秒）…」。
2. 后端：超时且**全程没有任何输出**时，单独归类（如 `kind: "timeout"` 或在现有类别上加标记），消息提示可能未登录。daemon 遇到连续 2 次此类超时，状态显示 `LLM_CLI_UNRESPONSIVE`：「xxx 没有响应，已上传会话但跳过提炼。请运行 <登录命令> 检查登录」，并停止重试，直到配置变化或 daemon 重启。
3. 各 driver 的登录命令：grok `grok login`，claude `claude`（交互里 /login），codex `codex login`，gemini `gemini`（交互里完成登录），opencode `opencode auth login`。以各 CLI 的 `--help` 为准核对。
4. 测试用假 CLI（sleep 不输出）覆盖：短超时生效、进程组被杀、分类正确、daemon 连续两次后停止重试且状态正确。测试中不得调用真实 CLI，超时值通过选项注入缩短，测试总耗时不要超过几秒。
5. 真机：用本机 gemini 跑一次 setup 同款的连接测试，确认 90 秒内结束并给出上述提示。
6. 全量 `bun test`、protocol/core/cli/web tsc 通过。然后 `bun run build:daemon` 和 `apps/desktop/scripts/bundle.sh` 重新打包。

## 报告
按 COMMON.md 的报告格式。写完报告后立即退出，不要等待任何后台任务。
