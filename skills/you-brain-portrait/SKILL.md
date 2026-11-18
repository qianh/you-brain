---
name: you-brain-portrait
description: 需要用户画像、长期偏好或项目特定口径时，读取 you-brain 数字分身。
---

当回答依赖用户是谁、长期偏好、判断风格或具体项目的既有架构口径时，按需读取数字分身：

1. **通用编码规范**：若当前 CLI 已注入 `<!-- you-brain:start v1 -->` 块，编码公约已在上下文中，无需重复读取 `coding.md`；否则可调用 MCP `get_portrait`（`variant="coding"`）或读取 `~/.you-brain/portrait/coding.md`。
2. **个人画像与判断风格**：非纯代码任务（方案评审、产品设计、写作、决策权衡）时，调用 MCP `get_portrait`（省略参数或 `variant="full"`），无 MCP 时读 `~/.you-brain/portrait/full.md`。
3. **具体项目决定（按需单项目读取）**：在已有代码仓库或业务项目里工作时，调用 MCP `get_portrait` 传 `variant="projects"` 与 `project="<仓库目录名或项目名>"`（不传 `project` 时仅返回轻量项目索引）；无 MCP 时先读 `~/.you-brain/portrait/projects/index.md`，再读对应的 `~/.you-brain/portrait/projects/<项目>.md`，不要一次性通读整份 `projects.md`；若项目口径与仓库当前代码冲突，以代码为准。

用户明确提出跨会话永久修改数字分身或编码规则时，调用 `add_portrait_correction`（可用 `get_portrait_corrections` 查看状态）；纠正会在下一次每日沉淀时并入。不要把数字分身全文贴回对话，除非用户明确要求查看。
