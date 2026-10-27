---
name: you-brain-portrait
description: 需要用户画像、长期偏好或编码规范时，读取 you-brain 数字分身。
---

当回答依赖用户是谁、长期偏好、项目背景或编码规范时，先取得数字分身，再继续任务。

按这个顺序取用，取到一份即可：

1. 调用 MCP 工具 `get_portrait`。省略参数时返回人格分身 `full`。需要其他版本时传入 `variant`：`full`（人格分身）、`coding`（所有仓库通用的编码规范）、`projects`（各项目已锁定的决定），或用户配置的自定义变体 id。
2. 如果当前环境不能调用 MCP，直接读取 `~/.you-brain/portrait/full.md`。编码任务改读 `~/.you-brain/portrait/coding.md`。
3. 在某个项目里工作时，再读 `projects` 里该项目对应的 `## ` 小节，不需要读全文。

纠正数字分身时使用 `add_portrait_correction` 和 `get_portrait_corrections`。纠正会在下一次每日沉淀时并入，不会立刻改写。

不要把数字分身全文贴回对话，除非用户明确要求查看。只使用和当前任务有关的部分。
