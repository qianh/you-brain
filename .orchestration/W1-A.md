# 任务 W1-A：来源适配器 + 采集规范化（core/adapters、core/capture）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
现在有多个开发者并行工作，你**只能**修改：packages/core/src/adapters/**、packages/core/src/capture/**、packages/core/test/adapters/**、packages/core/test/capture/**、packages/core/test/fixtures/{claude,codex,grok,cursor,gemini}/**。
可以 import（只读）：@you-brain/protocol、packages/core/src/domain。

## 要求（技术方案 5.1、产品说明 6.1）
1. 搬运参考实现 src/adapters/*（claude、codex、grok、cursor、jsonl、content、index、types）和 src/capture/*（normalize、redact、images），连同 tests/adapters、tests/capture 与 tests/fixtures 一起搬运并改写为 bun:test。原文 markdown 渲染格式必须与参考实现**逐字节兼容**（历史数据兼容），保留参考实现的快照/断言。
2. 整理为开放接口 `SourceAdapter`（技术方案 5.1 的接口签名：id、defaultRoots、discover、parse、可选 continuationOf），提供注册表，社区可以注册新适配器。
3. 新增 **Gemini CLI** 适配器（来源 id 必须是 `gemini-cli`，已在 protocol 定义）：读取 `~/.gemini/tmp/<projectHash>/chats/*.json`（session-*.json，含 messages 数组，type 为 user / gemini，content 文本，可能有 toolCalls、thoughts）。先在本机 `ls ~/.gemini/tmp/*/chats/ 2>/dev/null` 看看有没有真实样例来确认格式（只读，不要把用户真实内容放进 fixture，fixture 要自己构造/脱敏）；没有样例就按 Gemini CLI 开源代码的 ConversationRecord 格式实现。
4. CaptureOptions 新增开关（产品说明 5.3/6.1）：`keepToolCalls`（保留工具调用，截断到可配置长度，默认 false）、`includeSubagents`（默认 false）、`redact`（默认 true）。默认行为必须与参考实现一致。
5. 恢复会话：调研各 CLI 在 --resume/--continue 时是否复制历史到新 ID（可读本机样例文件结构做判断，只读）。实现 `continuationOf`：若新会话的前 N 条消息与已知会话前缀一致则返回原会话 ID——提供一个基于消息内容前缀哈希的通用辅助函数，各适配器可复用。把你的调研结论写在最终回复里（不要写文档）。
6. 图片处理（sharp → webp，sha256 去重）沿用参考实现。

## 验收
`cd packages/core && bun test test/adapters test/capture` 全部通过，`bunx tsc --noEmit -p packages/core` 中你负责的文件无错误。
