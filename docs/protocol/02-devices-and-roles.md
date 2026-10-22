# 设备与角色

Schema：[`schemas/device.json`](schemas/device.json)、[`schemas/roles.json`](schemas/roles.json)。示例：[`examples/device-virtual.json`](examples/device-virtual.json)、[`examples/roles-virtual-main.json`](examples/roles-virtual-main.json)。

## 设备记录

`DeviceRecordSchema`（`packages/protocol/src/device.ts`）的字段：

| 字段 | 约束 |
| --- | --- |
| `deviceId` | UUID（`z.uuid()`） |
| `displayName` | 非空字符串 |
| `kind` | `desktop`、`server`、`virtual` |
| `platform` | `darwin`、`linux`、`bot` |
| `appVersion` | 非空字符串 |
| `protocolVersion` | 字面量 `1` |
| `capabilities` | `capture`、`refine`、`consolidate` 的数组，可以是空数组 |
| `lastSeenAt` | 带偏移的 ISO 时间 |
| `lastActiveAt` | 带偏移的 ISO 时间 |

虚拟设备用 `createVirtualDeviceRecord`。它固定 `kind: "virtual"`、`platform: "bot"`。缺省 `deviceId` 为 `crypto.randomUUID()`，缺省 `appVersion` 为 `"virtual"`，缺省 `capabilities` 为 `["refine", "consolidate"]`，两个时间都等于传入的 `now`（缺省则是调用时的当前时间）。返回值已经过 `parseDeviceRecord`。

桌面 daemon 给自己写记录时，`kind` 来自本机身份，不是从文件里读回来的。`registerVirtual` 拒绝 `kind !== "virtual"`，也拒绝覆盖一条已经存在的非虚拟记录。

## 心跳

`lastSeenAt` 是这条记录最后一次被写上 Drive 的时间。`#writeDevice` 把它设成调用时的 `now`，不和旧值取最大。`registerVirtual` 则保留调用方记录里的 `lastSeenAt`。

`lastActiveAt` 是这台设备最后一次有人使用的时间。合并函数是 `mergeLastActiveAt`：

- 两边都解析不出时刻时，结果是 `1970-01-01T00:00:00.000Z`（`ACTIVITY_EPOCH`）。
- 只有一边能解析时，保留那一边。
- 两边都能解析时，保留更晚的时刻。新值更早则保持原值，不倒退。

桌面心跳间隔是 `DEFAULT_HEARTBEAT_MINUTES`（5 分钟），对应 `HEARTBEAT_INTERVAL_MS`。虚拟设备自己周期重写 `you-brain/devices/<自己的 id>.json` 时要遵守同一条 `lastActiveAt` 规则。界面把等于纪元的 `lastActiveAt` 显示成还没有使用记录（`hasRecordedActivity` 要求时刻晚于纪元）。

从别的设备拉下来的记录原样 `upsertDevice`。`removedIds` 只有文件 id、没有路径，拉取不按 id 删行。首次拉取，以及增量拉取里任一页的 `removedIds` 非空时，在 `#consume` 之后、写入同步游标之前，用 `list({ prefix: "you-brain/devices/" })` 做一次设备对账：本地 `kind === "virtual"`、`deviceId` 不是本机、且不在远端设备文件名集合里的行会被 `deleteDevice`。物理设备行不会因为这次对账被删除。对账的 `list` 抛错则本次拉取抛错，游标不前进。有行被删时，`onConfigChanged` 收到 `removedDevices`（设备 id 列表）；没有删除则不发空更新。移除方自己会 `deleteDevice`，并 `trash` Drive 上的文件；`findByPath` 不再返回已进回收站的对象。

`DELETE /api/devices/:id` 只移除虚拟设备。该 id 等于 `roles.mainDevice` 或 `roles.webProcessor`（按字段本身，不把空的 `webProcessor` 回落到 `mainDevice`）时返回 409 `DEVICE_IN_USE`。不是虚拟设备返回 409 `NOT_VIRTUAL`。本地列表里没有返回 404。Drive 未连接返回 503 `DRIVE_UNAVAILABLE`。

## roles.json

`RolesSchema` 在解析前用 `mergeConfigInput` 补上缺省（`parseRoles`）：

| 字段 | 缺省 |
| --- | --- |
| `mainDevice` | `null` |
| `webProcessor` | `null` |
| `consolidation.enabled` | `false` |
| `consolidation.time` | `03:00`（`DEFAULT_CONSOLIDATE_TIME`，`HH:MM`） |
| `timezone` | `Asia/Shanghai`（`DEFAULT_TIMEZONE`） |

`resolveWebProcessor` 返回 `webProcessor ?? mainDevice`。

## 门控

本地 daemon 的设备 id 记为 `deviceId`。

提醒：`dueRemindersForDevice` 在 `mainDevice === deviceId` 时才计算。`reminders.notifications` 不参与这条判断。

每日沉淀：`consolidationBlock` 要求 `mainDevice === deviceId`、`consolidation.enabled`、有 LLM、有 Drive。否则分别是 `NOT_MAIN_DEVICE`、`DISABLED`、`NO_LLM`、`NO_DRIVE`。

话题文件：`#canWriteTopicFiles` 要求 Drive 已连接、`consolidation.enabled`、并且 `mainDevice === deviceId`。

网页会话：`#canProcessWebSessions` 要求 LLM、Drive、本地库都在，且 `resolveWebProcessor(roles) === deviceId`。采集到的 CLI 会话走 `#refine`，只要求本机有 LLM，不看网页处理设备。

因此，`mainDevice` 或 `webProcessor` 指向一台虚拟设备时，桌面 daemon 不会做被指走的那些事。虚拟设备要自己生成提醒、写租约、写 `topics/`、写数字分身，或自己提炼 `inbox/web-*`。
