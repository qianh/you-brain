export const YOU_BRAIN_SKILL = `---
name: you-brain
description: 使用 you-brain 查看今日会话、话题册，并搜索历史会话。
---

you-brain 把各设备、各 AI 工具里的会话汇总到用户自己的 Google Drive，并提炼成今日视图和话题册。需要回忆近期工作、查找旧对话或整理话题时使用本技能。

## 今日

调用 MCP 工具 \`get_today\`。它返回今天所有设备、所有来源的会话和提炼：标题、概要、话题、结论、待办。用户问「今天做了什么」「刚才聊到哪了」时使用。

## 话题

- \`get_topics\`：列出话题，可按活跃区、历史区或状态过滤。
- \`get_topic\`：读取一个话题的概要、结论、待办和相关会话链接。
- \`update_topic\`：只在用户明确要求时，修改话题状态、完成待办或追加结论。这是写操作，会记入事件日志。

用户问「那个项目进展如何」「还有哪些待办」时，先 \`get_topics\`，再对相关话题调用 \`get_topic\`。

## 搜索

调用 \`search_sessions\` 做语义加关键词搜索。用户说「之前讨论过」「上次那个方案」，而今日视图和话题册里没有时使用。需要原文时，用返回的会话引用调用 \`get_session\`。

## 其他

- \`hub_status\`：查看 you-brain 是否在运行、最近一次同步是否正常。
- \`upload_sessions\`：只在用户明确要求立即上传时调用。

MCP 不可用时，可以读本地文件 \`~/.you-brain/TODAY.md\` 和 \`~/.you-brain/TOPICS.md\`。不要编造没有出现过的会话、结论或待办。
`;

export const YOU_BRAIN_PORTRAIT_SKILL = `---
name: you-brain-portrait
description: 需要用户画像、长期偏好或编码规范时，读取 you-brain 数字分身。
---

当回答依赖用户是谁、长期偏好、项目背景或编码规范时，先取得数字分身，再继续任务。

按这个顺序取用，取到一份即可：

1. 调用 MCP 工具 \`get_portrait\`。省略参数时返回人格分身 \`full\`。需要其他版本时传入 \`variant\`：\`full\`（人格分身）、\`coding\`（所有仓库通用的编码规范）、\`projects\`（各项目已锁定的决定），或用户配置的自定义变体 id。
2. 如果当前环境不能调用 MCP，直接读取 \`~/.you-brain/portrait/full.md\`。编码任务改读 \`~/.you-brain/portrait/coding.md\`。
3. 在某个项目里工作时，再读 \`projects\` 里该项目对应的 \`## \` 小节，不需要读全文。

纠正数字分身时使用 \`add_portrait_correction\` 和 \`get_portrait_corrections\`。纠正会在下一次每日沉淀时并入，不会立刻改写。

不要把数字分身全文贴回对话，除非用户明确要求查看。只使用和当前任务有关的部分。
`;

export const YOU_BRAIN_SKILL_BODIES = {
  "you-brain": YOU_BRAIN_SKILL,
  "you-brain-portrait": YOU_BRAIN_PORTRAIT_SKILL,
} as const;

export const YOU_BRAIN_SKILL_NAMES = ["you-brain", "you-brain-portrait"] as const;

export type YouBrainSkillName = (typeof YOU_BRAIN_SKILL_NAMES)[number];
