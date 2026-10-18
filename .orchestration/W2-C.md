# 任务 W2-C：本地 HTTP API + MCP 服务（core/http、core/mcp）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改：packages/core/src/http/**、packages/core/src/mcp/**、packages/core/test/http/**、packages/core/test/mcp/**。

## 要求
1. http（技术方案 14.2）：用 `Bun.serve`，只监听 127.0.0.1，端口 0（随机）或配置值；启动时生成随机 token，把 `{port, token, pid}` 原子写入数据目录 `daemon.json`（权限 600）。所有 `/api/*` 请求需要 `Authorization: Bearer <token>`（SSE 允许 `?token=` 查询参数，因为 EventSource 不能设头）。
   - 接口：`GET /api/today`、`GET /api/topics?zone=active|history&status=`、`GET /api/topics/:id`、`POST /api/topics/:id`（改名/改状态/合并/拆分）、`GET /api/portrait?variant=`、`GET /api/portrait/snapshots`、`GET /api/search?q=`、`GET /api/devices`、`GET|PUT /api/roles`、`GET|PUT /api/config`、`GET /api/status`、`GET /api/reminders`（P1，返回空数组）、`POST /api/actions/sync`、`POST /api/actions/upload`、`POST /api/actions/todo`（完成/放弃待办）、`POST /api/actions/conclusion`（追加结论），以及 SSE `GET /api/events`（话题册/今日/状态变化时推送）。
   - 用户操作（改名、改状态 by:user、合并、拆分=unassigned+assigned/created、待办状态、追加结论）转换成 protocol 事件，通过注入的 `EventSink.emit(type, data)` 写入（由 sync 的 EventLog 实现，你只依赖接口）。
   - 处理器依赖全部以接口注入（store 查询、search、portrait、sync 触发、配置读写、状态汇总），便于测试。用 zod 校验请求体。
   - 同时导出给 Web UI 和 CLI 用的 **TypeScript 客户端** `createDaemonClient({port, token})` 与所有响应类型（放在 src/http/client.ts、src/http/types.ts）。CLI 和 Web UI 都会复用这些类型，务必清晰。
   - 静态文件：可选地托管 Web UI 构建产物目录（`/` 下，SPA 回退 index.html），目录路径注入。
2. mcp（技术方案 13.1，参考 BrainHub src/mcp/server.ts 与 tests/mcp）：`@modelcontextprotocol/sdk` stdio 服务。
   - 工具：search_sessions、get_session、get_portrait（新增 variant）、hub_status、upload_sessions（与 BrainHub 同名，入参/出参尽量兼容）、get_today、get_topics、get_topic、update_topic、get_reminders（P1 返回空）。
   - 只读工具直接读本地 SQLite（store/search），get_session 访问 Drive；**写操作（update_topic、upload_sessions）通过读 daemon.json 调用本地 HTTP API**，daemon 未运行时返回明确错误。
   - 测试用 SDK 的 InMemoryTransport 或等价方式，覆盖每个工具。
3. 测试：鉴权失败 401、各接口正反例、SSE 推送、用户操作→事件映射、daemon.json 权限 600。

## 验收
`cd packages/core && bun test test/http test/mcp` 全部通过；tsc 无你负责文件的错误。
