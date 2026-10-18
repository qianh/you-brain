# 任务 W1-D：模型后端 + 会话增量提炼（core/llm、core/refine）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改：packages/core/src/llm/**、packages/core/src/refine/**、packages/core/test/llm/**、packages/core/test/refine/**。
可以 import（只读）：@you-brain/protocol、packages/core/src/domain。不要 import store/topics（别人在并行开发），用你自己定义的输入接口（候选话题、开放待办、上次提炼结果）解耦。

## 要求（技术方案 7）
1. llm：`LlmBackend { id; complete({system,user,jsonSchema?}): Promise<string>; test(): Promise<void> }`。
   - `openai-compatible`：用 fetch 直接实现 /chat/completions（不要引入 openai SDK），支持 baseUrl/model/apiKey、response_format（json_object 或 json_schema，按 provider 能力降级）、超时、错误分类（鉴权/限流/网络/服务端）。内置预设：DeepSeek、GLM（智谱）、Qwen（DashScope 兼容模式）、Kimi（Moonshot）、OpenAI、Ollama（本地 http://127.0.0.1:11434/v1，无 key）、custom。预设的 baseUrl 与默认模型名请按各家官方文档填写。
   - `anthropic`：fetch 调用 Messages API（x-api-key、anthropic-version），JSON 输出用 tool_use 或提示词约束。默认模型 claude-sonnet-5-5。
   - 工厂：根据 shared 配置（provider、model）+ 一个注入的 `getApiKey(provider)` 函数创建后端（密钥来自钥匙串，键名 `you-brain/llm/<provider>`，由别人实现，你只依赖函数签名）。
   - 重试队列：指数退避（可注入时钟），记录失败原因供状态页展示。
2. refine：
   - 输入：上次提炼结果（可空）、新增消息（第 refinedUpTo+1 条起；超长时截断最早部分，按字符预算）、候选话题（活跃区全部 + 历史区最近 20 个：名称、别名、一句话概要）、候选话题下的开放待办。
   - 提示词（中文为主，可以中英混合）：严格按 7.2 要求——优先归入已有话题、明显是新事情才新建、只输出置信度 ≥0.8 的待办、一个会话只归入一个主话题、todos_completed 只能引用给定的 todoId。
   - 输出用 protocol 中的 zod schema 校验，失败重试一次，仍失败则返回可识别的"跳过"结果。
   - 二次校验：create 却与已有话题规范化名称相同 → 改为 assign；assign 了不存在的 topicId → 视为 create；过滤 confidence < 0.8；去掉与已有结论重复的结论。
   - 把模型输出转成 protocol 的事件序列（session.refined、topic.created、topic.assigned、conclusion.added、todo.added、todo.status_changed by:auto），事件 id 用 ULID，ts/device/seq 由调用方传入的事件工厂生成。
3. 测试：用 fake 后端做快照测试（固定模型响应 → 固定事件序列）；用 Bun.serve 起本地假服务器测试 openai-compatible 与 anthropic 的请求格式、错误分类、超时；提供一个默认跳过的真实模型冒烟测试（读环境变量 YB_SMOKE_PROVIDER 等，未设置则 skip）。

## 验收
`cd packages/core && bun test test/llm test/refine` 全部通过；tsc 无你负责文件的错误。
