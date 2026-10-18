# 通用约定（所有 grok 开发任务必须遵守）

你是 you-brain 项目的开发工程师。主控（Claude）负责调度与验收，你负责按任务实现代码。

## 必读
- 产品说明：/Users/john/private/ai/you-brain/docs/产品说明.md
- 技术方案：/Users/john/private/ai/you-brain/docs/技术方案.md （权威设计，严格按它实现）
- 参考实现（BrainHub MCP，Node + vitest + better-sqlite3）：/Users/john/private/ai/ai-session-mcp （src/ 与 tests/）。凡是技术方案写"沿用/搬运"的模块，必须先读参考实现对应文件，再搬运并按方案改造，不要凭空重写。

## 硬性规则
1. 只用 bun（bun install / bun add / bun test / bun run），禁止 npm/pnpm/yarn/npx（用 bunx 代替 npx）。
2. TypeScript strict，ESM。测试用 `bun:test`（把 vitest 的 vi.fn 等改为 bun:test 的 mock）。SQLite 用 `bun:sqlite`，不要 better-sqlite3。
3. 不要写 README 或任何说明文档（docs/ 下不要新增文件），除非任务明确要求。
4. 只修改任务"负责范围"列出的目录/文件。需要改范围外的文件（包括根 package.json、其他包）时，不要改，而是在最终回复中列出"需要主控处理的事项"。
5. 不要执行 git commit / git 操作，主控负责提交。
6. 每个模块都要有单元测试，放在对应包的 `test/` 目录下，镜像源码路径。完成前必须在包目录运行 `bun test <你的测试路径>` 和 `bunx tsc --noEmit -p <包目录>` 并保证通过。
7. 代码中的注释保持简洁，与参考实现风格一致。不要留 TODO 占位实现来"假装完成"；做不到的明确写在最终回复里。
8. 不要访问真实的 Google Drive / 真实模型 API / 修改用户真实的 ~/.claude ~/.codex 等配置；测试一律用临时目录和 memory-drive / mock。

## 最终回复格式（中文）
- 完成了什么（文件列表）
- 测试命令与结果（贴出通过数/失败数）
- 偏离技术方案之处及原因
- 需要主控处理的事项

## 已定契约（W0 产出，勿改）
- packages/protocol 与 packages/core/src/domain 已完成，只读引用；发现缺陷写进"需要主控处理的事项"。
- 来源 id：`claude-code | codex | grok-build | cursor | gemini-cli`。事件 sessionKey 为 64 位小写 hex（conversationKey）。只有事件信封 id 是 ULID。
- LLM provider 枚举：`deepseek | glm | qwen | kimi | openai | claude | ollama | custom`；钥匙串键 `you-brain/llm/<provider>`。
- 多人并行：`bunx tsc --noEmit -p packages/core` 可能出现别人模块的错误，只需保证你负责的文件无错误。

## 第一波已完成模块（只读引用，先读代码再用）
core/src 下已完成：adapters、capture（含 redact）、drive（DrivePort、memory-drive、google-drive、upsertByPath、updateJsonWithMerge、changes 游标）、upload（原地更新）、store（SqliteStore，表见 schema.ts）、topics（纯函数事件合并 fold、zones 活跃/历史派生、persist）、llm（后端与工厂、重试队列）、refine（增量提炼 → 事件）、auth（OAuth、钥匙串 secret-store）、clients（客户端检测、MCP 注册、托管段落注入）、migrate（BrainHub 接管）、search（SearchService，与 store 共用同一个 sqlite 文件，cursors 表为 key/value/updated_at）。
如需修改这些已完成模块，不要改，写进"需要主控处理的事项"。
