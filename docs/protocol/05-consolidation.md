# 沉淀

Schema：[`schemas/lease.json`](schemas/lease.json)。示例：[`examples/lease.json`](examples/lease.json)。

只有 `consolidationBlock` 返回 `null` 的设备会跑。条件见 [02-devices-and-roles.md](02-devices-and-roles.md)。`consolidation.time` 用 `roles.timezone` 判断是否到点（`consolidationTimeDue`）。补跑窗口是 `MAX_CATCH_UP_DAYS`（7），含当天。

## 租约

路径 `you-brain/leases/consolidate.json`（`DRIVE_PATHS.consolidateLease`）。

| 字段 | 约束 |
| --- | --- |
| `date` | `YYYY-MM-DD` |
| `deviceId` | 非空字符串。写出时是跑沉淀的那台设备 |
| `finishedAt` | 带偏移的 ISO 时间 |

`mergeConsolidateLease`：没有旧值则用新值；`date` 字符串更大者保留；同一天比较 `finishedAt` 的毫秒，新值更晚或旧值无法解析则用新值，否则留旧值。

`readConsolidateLease` 在文件缺失、JSON 损坏或过不了 schema 时返回 `null`，并警告「沉淀租约无法解析，按未沉淀处理」或「读取沉淀租约失败，按未沉淀处理」。

`writeConsolidateLease` 用 `updateJsonWithMerge` 做上面的合并。当前文件不是合法 JSON（`INVALID_INPUT`）时，改用 `upsertByPath` 写成新租约。一天的步骤在 `executeConsolidation` 里全部 `ok` 之后才写租约。写失败则这一天记为失败，警告「沉淀记录没有写上」。

## 每日步骤

`consolidationSteps` 的顺序：

1. `topic_summaries`。选出当天有变化、未锁定、未合并的话题，让模型重写概要，发出 `topic.summary_rewritten`。`rewriteTopic` 看到 `userLocked` 或 `mergedInto` 则跳过。有失败则整步失败。
2. `merge_suggestions`。候选不足 2 个时，把游标 `MERGE_SUGGESTIONS_CURSOR` 写成 `{ day, pairs: [] }`。够数时请模型给出建议，仍写入这个游标，不产生事件类型。
3. `portrait`。依赖 `topic_summaries`。只处理配置里 `id === "full"` 的变体。
4. `topic_files`。依赖 `topic_summaries`。调用 `syncTopicFiles`，写出 `topics/TOPICS-latest.md`、`topics/<stem>.md` 和 `topics/history/<stem>.md`。manifest 游标是 `topicfiles.manifest`；内容哈希没变则不写 Drive。

虚拟设备担任主设备时，这四步由它自己执行，并把产生的事件写进自己的事件分片，再按下面的规则写 `topics/` 和 `digital-twin/`。

## 数字分身

`createDrivePortrait.save` 的顺序：

1. 备份。路径是 latest 所在目录下的 `consolidate-backup/<去掉扩展名的文件名>-<day>.md`。该路径已存在则跳过，不覆盖。
2. 用读到的 etag 做 `ifMatch` 更新 latest。冲突抛出 `ConflictError`，步骤改成警告「数字分身在沉淀期间被别处更新，已跳过」，不写快照。
3. 写快照。`snapshotPattern` 必须正好两个 `*`（`fillSnapshotPattern`）。默认 `digital-twin/JOHN-DIGITAL-TWIN-v*-*.md`，第一个 `*` 换成版本，第二个换成 `day`。已有快照里版本最大者的最后一段加 1；没有则从 `1.0.0` 起（`nextVersion`）。
4. `PortraitService.pull` 把 Drive 内容拉回本地。这个服务不把 brief、coding 写回 Drive。

`rejectPortrait` 在写入前丢掉模型结果：空白（「数字分身输出为空，已跳过」）、`textUnits` 不到原文一半（「数字分身输出不到原来的一半，已跳过」）、和原文相同（「数字分身没有变化，已跳过」）。没有 full 文件时警告「没有现有数字分身，跳过」。

纳入提示词的纠正来自 `pendingCorrections`：`variant === "full"` 且尚未应用，最多 `CORRECTION_LIMIT`（20）条。写成功后对实际放进提示词的 id 发出 `portrait.correction_applied`，`snapshot` 是快照文件名（`posix.basename`），不是完整路径。

## 提醒 id

只由主设备通过 `dueRemindersForDevice` 生成，再写成 `reminder.issued`。id 规则在 `computeDueReminders`：

| kind | id |
| --- | --- |
| `stale` | `stale:<topicId>:<lastActive 的本地日期>` |
| `history` | `history:<topicId>:<ISO 周>` |
| `weeklyReview` | `weekly:<ISO 周>`，`topicId` 为 `null` |
| `morningDigest` | `morning:<本地日期>`，`topicId` 为 `null` |

本地日期和 ISO 周用 `roles.timezone` 的偏移。已经出现过的 `reminderId` 不再生成。用户对提醒的操作是新的 `reminder.action` 事件，不改原来的 `reminder.issued`。
