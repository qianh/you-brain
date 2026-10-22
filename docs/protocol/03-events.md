# 事件

Schema：[`schemas/event.json`](schemas/event.json)，每种 `data` 在 `schemas/data.<type>.json`。示例覆盖全部类型：[`examples/events.jsonl`](examples/events.jsonl)。类型名单是 `EVENT_TYPES`，和 `EventSchema` 的判别联合一致。没有 `consolidate.merge_suggestions` 这种事件；合并建议写在游标里，见 [05-consolidation.md](05-consolidation.md)。

## 信封

`eventSchema`（`packages/protocol/src/events.ts`）的公共字段：

| 字段 | 约束 |
| --- | --- |
| `v` | 字面量 `1` |
| `id` | `UlidSchema`：26 位，字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`（没有 I、L、O、U） |
| `ts` | 带偏移的 ISO 时间 |
| `device` | 非空字符串。桌面程序写自己的 UUID。协议只要求非空 |
| `seq` | 非负整数 |
| `type` | 下表之一 |
| `data` | 由 `type` 决定 |

`createEvent` 在省略 `id` 时用 `ulid()`，并带上 `v`。

## 排序键

`eventSortKey` 的顺序是 `ts` 的毫秒、`device` 字符串、`seq`、`id`（`compareSortKeys`）。`seq` 只在时间和设备都相同的时候比较。各设备维护自己的序号。桌面 `EventLog` 从 1 递增，存在该设备本地的游标里。外部写入者用自己的递增序号即可。

`ts` 无法被 `Date.parse` 时，`eventSortKey` 抛错。写文件前先用 `parseEvent`。

同一天的文件名用 `zonedDay(event.ts, roles.timezone)`，不是 UTC 日期。缺省时区是 `Asia/Shanghai`。

## 分片和幂等

路径是 `eventLogPath(deviceId, day)`，即 `you-brain/events/<deviceId>/<YYYY-MM-DD>.jsonl`。

`serializeEventLine` 输出一个 JSON 对象加换行。`serializeEventsJsonl` 把多行接起来；空数组得到空字符串。

桌面 `flush`（`#writeDay`）的写法：

1. 读出当天远程文件，`parseEventsJsonl`，只留下 `event.device === 本机` 的事件。坏行在这一步被丢掉，不进入重写结果。
2. 与本地已折叠的本机当天事件、以及尚未确认的待发事件按 id 合并（`unionBySeq`）。顺序是远程、本地、待发；同一个 id 后者覆盖前者。然后按 `seq`、再按 `id` 排序。
3. `upsertByPath` 重写整个文件。etag 冲突时重试，默认 5 次。

读取方用 `applyEvents`：排序后按 id 去重，已经在 `memory.ids` 里的 id 跳过。所以一行一旦折进去，再改文件里的同 id 内容不会改变话题册。写入之后不要改已发布事件的正文。新事实用新的 `id`。

外部实现者追加时：读出当天文件，用 `parseEventsJsonl` 留下自己的事件，并上新事件，用 `serializeEventsJsonl` 写回，并用读到的 etag 做 `ifMatch`。不要把别的 `device` 写进自己的分片；桌面重写时会滤掉它们。

## 行游标和坏行

`parseEventsJsonl`：按 `\n` 切分，去掉行尾的 `\r`，`trim` 后为空的行跳过。JSON 无法解析或过不了 `EventSchema` 时，记 `{ line, message }`，行号从 1 开始，然后继续。`parseEventLine` 对空行返回 `{ ok: false, error: "empty line" }`；文件级解析不把空行算进错误。

`ProtocolSync` 用 `selectNewLines`。游标是已读的逻辑行数（尾部空行不算一行）。游标在 `0..行数` 之间时只解析新增行，坏行的文件行号要加上已读行数。游标不是安全整数、为负、或大于当前行数（文件变短）时，`reset` 为真，整文件重读，行号从 1 计。游标在解析之后推进到 `selected.next`，因此坏行不会在后续变长的文件里被再次汇报，除非发生上面的重读。

`v` 不是 `1`，或 `type` 不在联合里的行，`EventSchema.safeParse` 失败，进入 `lineErrors`，不写入本地事件表，也不参与折叠。

## 每种事件

折叠入口是 `applyOne`（`packages/core/src/topics/fold.ts`）。提醒和数字分身纠正有各自的折叠，话题册对 `reminder.issued`、`portrait.correction`、`portrait.correction_applied` 不做字段更新。

| type | data | 折叠 |
| --- | --- | --- |
| `session.refined` | `sessionKey`（64 位小写十六进制）、`fileId`、`source`、`title`、`summary`、`refinedUpTo`（非负整数） | 写入会话行。`refinedUpTo` 比已有值小则忽略。 |
| `topic.created` | `topicId`、`name`、`aliases` | 设置名称和别名。`createdTs` 只在为空时写成事件的 `ts`。同名（`canonicalTopicName`）的两条都还活着时，`createdTs` 更早的留下，平局则 `topicId` 字符串更小的留下，另一条链到留下的那条。 |
| `topic.assigned` | `topicId`、`sessionKey` | 把会话指到这个话题（经合并链解析后的 id）。 |
| `topic.unassigned` | 同上 | 仅当会话当前就在该话题上时清空。并 `touchUser`。 |
| `topic.renamed` | `topicId`、`name`、`aliases` | 改名并 `touchUser`。不设置 `userLocked`，之后自动状态仍可改变它。 |
| `topic.status_changed` | `topicId`、`status`（`active`、`follow_up`、`done`、`parked`）、`by`（`auto` 或 `user`） | `by: "auto"` 且 `userLocked` 时忽略。`by: "user"` 时锁定并 `touchUser`。 |
| `topic.merged` | `fromTopicId`、`intoTopicId` | 把失败的一侧链到胜出的一侧，并 `touchUser` 胜出者。解析后两端相同则不动。 |
| `topic.summary_rewritten` | `topicId`、`summary`、`nextStep` | 直接覆盖概要和下一步，不看 `userLocked`。桌面沉淀在发出这条事件之前会跳过已锁定或已合并的话题（`rewriteTopic`）。 |
| `conclusion.added` | `conclusionId`、`topicId`、`text`、`sessionKey` | 按 `conclusionId` 覆盖结论，话题 id 走合并链，时间用事件 `ts`。 |
| `todo.added` | `todoId`、`topicId`、`text`、`sessionKey`、`confidence`（0 到 1） | 新建时状态 `open`、`by: "auto"`、未锁定。已存在则更新文本和话题，保留锁定。 |
| `todo.status_changed` | `todoId`、`status`（`open`、`done`、`dropped`）、`by` | 与话题状态相同：用户操作锁定，之后的自动状态被忽略。用户操作还会 `touchUser` 所属话题。 |
| `portrait.correction` | `correctionId`、`variant`、`section`、`text` | 话题册忽略。`classifyPortraitCorrections`：同一 id 最早的一条决定文本；有任一 `portrait.correction_applied` 则标为已应用。 |
| `portrait.correction_applied` | `correctionId`、`snapshot` | 话题册忽略。按事件顺序，最后一条的 `snapshot` 留给这个 id。 |
| `reminder.issued` | `reminderId`、`kind`、`topicId`（可空）、`text` | 话题册忽略。`foldReminders` 按 id 建行，未操作过则状态 `open`。 |
| `reminder.action` | `reminderId`、`topicId`（可空）、`action`、`until`（可空 ISO） | 话题册只在 `topicId` 非空时 `touchUser`。提醒折叠：`snooze` → `snoozed` 并保留 `until`；`mute` → `muted`；`ignore` → `dismissed`；`done` 和 `reactivate` → `done`。`until` 只在 `snooze` 时留下。 |

`foldReminders` 和话题册都先按 `compareEvents` 排序，再按 id 去重。同一 id 只保留排序后的第一条。

用户操作时间 `touchUser`：`topic.renamed`、用户发起的 `topic.status_changed`、`topic.unassigned`、`topic.merged` 的胜出者、用户发起的 `todo.status_changed`、以及带话题的 `reminder.action`。仅当新时间不早于已有 `lastUserOpAt` 时更新。
