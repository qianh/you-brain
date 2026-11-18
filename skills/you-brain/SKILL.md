---
name: you-brain
description: 使用 you-brain 查看今日会话、话题册，并搜索历史会话。
---

you-brain 把各设备、各 AI 工具里的会话汇总到用户自己的 Google Drive，并提炼成今日视图和话题册。需要回忆近期工作、查找旧对话或整理话题时使用本技能。

## 今日

调用 MCP 工具 `get_today`。它返回今天所有设备、所有来源的会话和提炼：标题、概要、话题、结论、待办。用户问「今天做了什么」「刚才聊到哪了」时使用。

## 话题

- `get_topics`：列出话题（默认返回活跃区 `zone="active"`；需查历史或全部时传 `zone="history"` 或 `zone="all"`）。
- `get_topic`：读取一个话题的概要、近期结论、开放待办和相关会话链接（默认截断保护，支持 `conclusion_limit`、`todo_limit`、`include_closed_todos`）。
- `update_topic`：只在用户明确要求时，修改话题状态、完成待办或追加结论。这是写操作，会记入事件日志。

用户问「那个项目进展如何」「还有哪些待办」时，先 `get_topics`，再对相关话题调用 `get_topic`。

## 搜索

调用 `search_sessions` 做语义加关键词搜索。用户说「之前讨论过」「上次那个方案」，而今日视图和话题册里没有时使用。需要原文时，用返回的会话引用调用 `get_session`。

## 知识库与 @ 引用

- `search_notion` / `get_notion_page`：在已同步的 Notion 知识库中搜索并读取页面 Markdown 正文。
- `search_references` / `get_reference`：统一检索并读取可 `@` 引用的终端会话、今日/历史会话、话题与知识库页面（也可使用 `you-brain-ref` 技能或 `you-brain://` MCP 资源；无 MCP 时可用 CLI `you-brain ref`）。

## 其他

- `hub_status`：查看 you-brain 是否在运行、最近一次同步是否正常。
- `upload_sessions`：只在用户明确要求立即上传时调用。

MCP 不可用时，可以读本地文件 `~/.you-brain/TODAY.md` 和 `~/.you-brain/TOPICS.md`。不要编造没有出现过的会话、结论或待办。
