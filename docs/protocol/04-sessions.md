# 会话原文

示例：[`examples/session-web.md`](examples/session-web.md)。解析函数是 `parseSessionFrontmatter` 和桌面用的 `parseWebSession`。

## Markdown

文件以 frontmatter 开头。`sessionFrontmatterFields` 要求第一行是 `---`，块以单独一行的 `---` 结束，并且结束行后面还有一个换行。行内第一个冒号分隔键和值，两边去掉空白。冒号在行首、或没有冒号的行跳过。重复键保留最后一次。没有这个块时，字段表是空的。

`parseSessionFrontmatter` 要求这四项非空，否则每个缺项一条错误，消息是 `缺少 <字段>`。整块缺失时只有一条 `path: "frontmatter"`、消息 `缺少 frontmatter`，不再逐项报缺。

| 字段 | 谁要求 |
| --- | --- |
| `source` | 必填 |
| `conversation_id` | 必填 |
| `started_at` | 必填。`parseWebSession` 不检查它是不是 ISO |
| `updated_at` | 必填 |
| `device` | 可省略。解析结果里缺省是空字符串 |
| `turn_count` | 桌面上传会写。`parseWebSession` 不用它，轮数等于解析出的回合 |
| `redaction_version`、`redaction_count`、`content_sha256` | `renderSessionMarkdown` 会写。协议解析不要求 |

回合标题只认 `## User` 和 `## Assistant`，行尾可以有空格或制表符（`HEADING`）。其他行并进当前回合。空文本的回合丢掉。frontmatter 之前如果没有合法的块，正文从文件开头算起，`parseWebSession` 在四个必填字段有空时返回 `null`。

`conversationKey(source, conversationId)` 是 sha256，输入为 `source`、一个 NUL、`conversationId`。事件里的 `sessionKey` 用这个 64 位小写十六进制。

## 两条 inbox

桌面采集写到 `inbox/<device>/`，`device` 是设备名分段，不能含斜杠。`UploadService` 同时写 Drive appProperties，键来自 `inboxAppProperties`：`brainhubKey`、`source`、`conversationId`、`deviceId`、`updatedAt`、`contentSha256`、`ybSchema`。`ybSchema` 缺省是 `"1"`（`YB_SCHEMA_VERSION`）。

浏览器插件写到 `inbox/web-<profile>/`（`inboxWebDir`，前缀常量 `WEB_INBOX_PATH_PREFIX` 是 `inbox/web-`）。每台设备的同步都会索引这些文件，游标键是 `webinbox:<sessionKey>`。

## 谁提炼

`inbox/web-*`：`#processWebSessions` 每隔 `webSessionsMs`（60 秒）看一次。`#canProcessWebSessions` 为真才处理，也就是 `resolveWebProcessor(roles)` 指向本机，且本机有 LLM 和 Drive。每次最多 `WEB_SESSION_BATCH`（3）条，还要过 `refine.idleMinutes` 的空闲。`parseWebSession` 返回 `null` 时不调用模型，记一次失败「网页会话无法解析」。

CLI 采集会话：上传成功后由采集那台设备的 `#refine` 提炼，条件是本机有 LLM。不看 `webProcessor`。

两边提炼成功都发出 `session.refined`，以及模型决定的话题、结论和 todo 事件。事件的 `device` 是做提炼的那台设备。虚拟设备担任网页处理设备时，要自己读 `inbox/web-*`、调用模型、把这些事件写进自己的事件分片。桌面 daemon 不会代写。
