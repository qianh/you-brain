# you-brain 协议

协议是 Google Drive 根目录（默认文件夹名 `brain-hub`，见 `DEFAULT_DRIVE_ROOT`）里的一组 JSON、JSONL 和 Markdown。桌面程序、命令行和外部 bot 读写同一套文件。当前版本是 `PROTOCOL_VERSION`，值为 `1`（`packages/protocol/src/version.ts`）。设备记录、事件信封和 `you-brain/protocol.json` 都把这个数字写成字面量，不是范围。

路径都相对 Drive 根，定义在 `DRIVE_PATHS`（`packages/protocol/src/paths.ts`）。JSON Schema 在 [`schemas/`](schemas/)，示例在 [`examples/`](examples/)。Schema 由 `bun run protocol:schemas` 从 zod schema 生成。

## 三类实现者

只读者读取设备、事件、`roles.json`、会话 Markdown 和话题文件，不写 Drive。

事件写入者已经有一台设备记录（桌面程序注册的，或下面的虚拟设备）。它只往 `you-brain/events/<自己的 deviceId>/` 追加自己的事件，并可以上传自己的 `inbox/<device>/` 会话。

虚拟设备是 `kind: "virtual"`、`platform: "bot"` 的设备记录。它可以上报事件。当 `roles.json` 的 `mainDevice` 或 `webProcessor` 指向它时，桌面 daemon 不会代做对应的工作，这些工作由这台虚拟设备自己做。见 [02-devices-and-roles.md](02-devices-and-roles.md) 和 [06-virtual-device.md](06-virtual-device.md)。

## 目录

| 文档 | 内容 |
| --- | --- |
| [01-layout.md](01-layout.md) | 目录树、谁写哪个目录、`protocol.json` |
| [02-devices-and-roles.md](02-devices-and-roles.md) | 设备记录、心跳、角色和门控 |
| [03-events.md](03-events.md) | 事件信封、分片、游标、每种事件的折叠 |
| [04-sessions.md](04-sessions.md) | `inbox/` 会话 Markdown 和谁来提炼 |
| [05-consolidation.md](05-consolidation.md) | 沉淀租约、话题文件、数字分身、提醒 id |
| [06-virtual-device.md](06-virtual-device.md) | 从零接入一台虚拟设备 |

校验本地文件（不访问 Drive，也不要求 daemon）：

```bash
you-brain protocol validate --kind device docs/protocol/examples/device-virtual.json
you-brain protocol validate docs/protocol/examples/events.jsonl
you-brain protocol validate --kind roles docs/protocol/examples/roles-virtual-main.json
you-brain protocol validate --kind lease docs/protocol/examples/lease.json
you-brain protocol validate --kind session docs/protocol/examples/session-web.md
```

`--kind` 可以省略：`.jsonl` 当作 events，`.md` 当作 session，其他 `.json` 当作 device。有错误时逐条打印到 stderr，退出码为 1；全部通过则退出码为 0。

## 一致性清单

实现者对照代码自检时用这份清单。

- 写出的 `protocolVersion`、事件 `v`、`protocol.json` 的 `version` 都是 `1`。
- 设备记录能通过 `parseDeviceRecord`。`deviceId` 是 UUID。`lastSeenAt` 和 `lastActiveAt` 是带时区偏移的 ISO 时间（`Z` 可以）。
- 再次写入设备记录时，`lastActiveAt` 取较新的时刻，不往回拨。两边都没有可用时刻时用 `1970-01-01T00:00:00.000Z`（`mergeLastActiveAt`）。
- 事件一行一个 JSON，行尾有换行。`id` 是 26 位 Crockford ULID。排序键是 `ts`、`device`、`seq`、`id`（`eventSortKey`）。
- 同一事件 `id` 只生效一次。已经折进话题册的 id 不会因为文件里的那一行被改写而重放（`applyEvents`）。
- 按 `roles.timezone` 把事件时间切到本地日，文件名是 `YYYY-MM-DD.jsonl`（`zonedDay`）。不是 UTC 日。
- 读事件时跳过空行。坏行记下行号和原因，继续读后面的行（`parseEventsJsonl`）。行游标记到文件末尾，坏行不会在文件变长时被重试；文件变短或游标越过末尾时整文件重读（`selectNewLines`）。
- `roles.mainDevice` 等于自己的 `deviceId` 时，才生成提醒、跑每日沉淀、写 `topics/`。
- `resolveWebProcessor(roles)`（`webProcessor ?? mainDevice`）等于自己，并且本机有 LLM 和 Drive 时，才提炼 `inbox/web-*`。采集进来的 CLI 会话由采集那台设备自己提炼，不看网页处理设备。
- 沉淀租约 `date` 更大者保留；同一天保留更晚的 `finishedAt`（`mergeConsolidateLease`）。
- 写数字分身 latest 时带上读到的 etag（`ifMatch`）。冲突则跳过，不覆盖别人刚写的内容。
