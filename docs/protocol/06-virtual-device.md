# 接入虚拟设备

下面每段都能在仓库里运行。三个脚本用固定的设备 id `44444444-4444-4444-8444-444444444444` 和时刻 `2026-10-18T03:00:00.000Z`，方便对照。

也可以让一台已经连上 Drive 的桌面 daemon 代为登记：

```bash
you-brain devices --add-virtual 沉淀机器人 --capabilities refine,consolidate
you-brain devices --set-main <打印出来的 deviceId>
you-brain devices --remove-virtual <deviceId>
```

`--add-virtual` 打印新的 `deviceId`，以及 `下一步：you-brain devices --set-main <id>`。名称去掉两端空白后须为 1 到 60 个字。`--capabilities` 是逗号分隔的 `capture`、`refine`、`consolidate`，省略时 daemon 使用 `createVirtualDeviceRecord` 的缺省 `refine,consolidate`。该设备当前是 `roles.mainDevice` 或 `roles.webProcessor` 时，移除接口返回 409，中文说明它正担任主设备或网页会话处理设备。

自己写文件时不必经过 daemon。

## 1. 生成记录并写上 Drive

[`examples/create-virtual-device.ts`](examples/create-virtual-device.ts)：

```ts
import { createVirtualDeviceRecord, deviceRecordPath } from "@you-brain/protocol";

const record = createVirtualDeviceRecord({
  deviceId: "44444444-4444-4444-8444-444444444444",
  displayName: "沉淀机器人",
  capabilities: ["refine", "consolidate"],
  now: new Date("2026-10-18T03:00:00.000Z"),
});

console.log(deviceRecordPath(record.deviceId));
console.log(JSON.stringify(record));
```

把 JSON 写到打印出的路径 `you-brain/devices/<deviceId>.json`。用两空格缩进和末尾换行，与 `updateJsonWithMerge` 的序列化一致。文件已存在时先读 etag，合并时遵守 [02-devices-and-roles.md](02-devices-and-roles.md) 的 `lastActiveAt` 规则，再用 `ifMatch` 更新。冲突就重读重试，桌面侧默认最多 5 次。

周期心跳重写同一文件：刷新 `lastSeenAt`，`lastActiveAt` 只在有更新的使用时刻时前进。桌面间隔是 5 分钟（`DEFAULT_HEARTBEAT_MINUTES`），bot 可以用同一量级。

写完后用：

```bash
you-brain protocol validate --kind device device.json
```

## 2. 追加事件

[`examples/append-event.ts`](examples/append-event.ts) 使用 `createEvent` 和 `serializeEventLine`。一天的路径：

```ts
eventLogPath(deviceId, "2026-10-18");
// you-brain/events/<deviceId>/2026-10-18.jsonl
```

日期来自 `zonedDay(new Date(event.ts), roles.timezone)`，不要用 UTC 的日历日。`seq` 在本设备上递增。`id` 用新的 ULID，发出之后不要改这条 JSON。

读出当天已有行，丢弃坏行，按 id 并上新事件，整文件写回并带 `ifMatch`。这和 `#writeDay` 的重写方式一致，避免两条客户端各追加一次把对方的行盖掉。`ts` 必须能被 `Date.parse` 接受，并且通过 `IsoTimestampSchema`（要有时区偏移）。时钟回拨会让排序键变早，后写的事件可能排在已有事件前面；用事件实际发生的时间，而不是一个倒退的本机钟。

校验：

```bash
you-brain protocol validate events.jsonl
```

## 3. 读其他设备的事件

列出 `you-brain/events/` 下每个设备目录里的 `YYYY-MM-DD.jsonl`。[`examples/read-events.ts`](examples/read-events.ts) 用 `parseEventsJsonl` 读 [`examples/events.jsonl`](examples/events.jsonl)。`errors` 里的行跳过，不要因为一行坏掉停掉整天。

折叠前按 `compareEvents` 的键排序：`ts`、`device`、`seq`、`id`。同一个 `id` 只应用一次。自己已经见过的 id，即使远程那一行后来变了，也不要重放。

`v` 不是 1 或 `type` 不认识的行会进 `errors`。保留原始行号即可，不要发明一条替代事件。

## 4. 担任主设备

`roles.json` 示例是 [`examples/roles-virtual-main.json`](examples/roles-virtual-main.json)。把 `mainDevice` 设成虚拟设备的 UUID，`timezone` 设成切日所用的时区，需要每日沉淀时把 `consolidation.enabled` 设为 `true`，`time` 用 `HH:MM`。

担任主设备之后，桌面 daemon 不再发提醒、不再跑沉淀、不再写 `topics/`。虚拟设备需要：

- 用 [05-consolidation.md](05-consolidation.md) 的 id 规则发出 `reminder.issued`，用户操作发 `reminder.action`。
- 在 `consolidation.time` 之后跑当天的四步。成功后写 `you-brain/leases/consolidate.json`，合并规则用 `mergeConsolidateLease`。
- 把 `topic.summary_rewritten` 写进自己的事件分片，再按 `assignTopicFileStems` 写 `topics/`。
- 按 full 变体的备份、`ifMatch`、快照规则写 `digital-twin/`。冲突就放弃这一次，不要强行覆盖。

`webProcessor` 若指向这台虚拟设备（或留空从而回落到 `mainDevice`），还要按 [04-sessions.md](04-sessions.md) 提炼 `inbox/web-*`。CLI 会话仍由采集它们的那台设备提炼。

## 5. 常见错误

etag 冲突：另一端刚写过同一路径。重新 `read`，用新的 etag 再合并。不要在没有 `ifMatch` 的情况下覆盖。

改写事件：同一个 `id` 的新正文不会进入已经折过的话题册。要修正事实，发一条新事件，例如新的 `topic.status_changed` 或 `topic.renamed`。

时钟和 `ts`：文件名按 `roles.timezone` 切日。`lastActiveAt` 用时刻比较，写一个更早的值不会把 Drive 上的值拨回去。`seq` 不跨设备比较大小，只在 `ts` 与 `device` 都相同的时候作为排序键。
