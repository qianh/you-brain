# 目录布局

路径相对 Drive 根。根文件夹的默认名字是 `brain-hub`（`DEFAULT_DRIVE_ROOT`）。下面的相对路径来自 `DRIVE_PATHS` 和 `paths.ts` 里的函数。

```text
you-brain/protocol.json
you-brain/config/shared.json
you-brain/config/roles.json
you-brain/devices/<deviceId>.json
you-brain/events/<deviceId>/<YYYY-MM-DD>.jsonl
you-brain/leases/consolidate.json
inbox/<device>/<filename>.md
inbox/web-<profile>/...
inbox/_assets/sha256/<前两位>/<sha256>.webp
topics/TOPICS-latest.md
topics/<stem>.md
topics/history/<stem>.md
digital-twin/JOHN-DIGITAL-TWIN-latest.md
digital-twin/JOHN-DIGITAL-TWIN-v<version>-<day>.md
digital-twin/consolidate-backup/<文件名去掉扩展名>-<day>.md
```

`inbox/_assets/...` 的形状由 `inboxAssetPath` 规定：sha256 必须是 64 位小写十六进制，扩展名是 `.webp`。

## 谁写

| 路径 | 谁写 |
| --- | --- |
| `you-brain/protocol.json` | 任意一台跑着 `ProtocolSync.ensureProtocol` 的设备，仅在文件不存在时创建 `{ "version": 1 }`。已存在的文件没有更新路径。 |
| `you-brain/config/shared.json` | 没有单一写入方。任意设备用 `ProtocolSync.updateShared` 做带 etag 的合并写。缺字段按 `DEFAULT_SHARED_CONFIG` 补齐（`parseSharedConfig`）。 |
| `you-brain/config/roles.json` | 同样没有单一写入方。`ProtocolSync.updateRoles` 合并写入。缺字段按 `DEFAULT_ROLES` 补齐。 |
| `you-brain/devices/<id>.json` | 该设备自己的 `register` / `heartbeat`（`#writeDevice`）。虚拟设备还可以由别的 daemon 调用 `registerVirtual` 来写，或由 bot 自己写这个文件。合并时 `lastActiveAt` 不倒退。 |
| `you-brain/events/<deviceId>/` | 只有 `event.device` 等于该 `deviceId` 的事件会进入这个目录。桌面 daemon 的 `flush` 按天重写整天文件（`#writeDay`），不是在字节末尾盲追加。 |
| `you-brain/leases/consolidate.json` | 主设备在一天的沉淀步骤全部成功之后调用 `writeConsolidateLease`。 |
| `inbox/<device>/` | 该设备的 `UploadService`。文件名是 `sessionFileName`：`<source>-<YYYYMMDD>-<conversationId 的前 8 位字母数字>[-<标题>].md`。 |
| `inbox/web-<profile>/` | 浏览器插件。daemon 只索引（游标前缀 `webinbox:`），网页会话处理设备负责提炼。 |
| `topics/` | `roles.mainDevice` 等于本机、`consolidation.enabled` 为真、并且 Drive 已连接时（`#canWriteTopicFiles`）。白天改动会去抖后再写；每日沉淀的 `topic_files` 步骤也会写。 |
| `digital-twin/` 的 full 变体 | 沉淀的 `portrait` 步骤，经 `createDrivePortrait`。它只读写配置里 `id === "full"` 的那条路径。默认是 `digital-twin/JOHN-DIGITAL-TWIN-latest.md`。`PortraitService.pull` 把 Drive 上的变体拉到本地缓存，不把 brief / coding 写回 Drive。 |

`updateJsonWithMerge` 和 `upsertByPath` 在 etag 冲突（`ConflictError`）时重新读取并重试，默认最多 5 次。JSON 用两空格缩进，末尾一个换行。事件 JSONL 是紧凑的一行一个对象。

## 文件名

`deviceRecordPath(deviceId)` 拒绝空串、`.`、`..` 和含 `/`、`\`、NUL 的 id。`eventLogPath(deviceId, day)` 另外要求 `day` 是真实的公历 `YYYY-MM-DD`。话题文件的 stem 不直接用原始 id：`sanitizeTopicFileName` 只保留 `[A-Za-z0-9._-]`，其余变成 `_`；和别的 id 撞车、或 stem 是 `TOPICS-latest` 时，加上 id 的 sha256 前 8 位十六进制（`assignTopicFileStems`）。

## protocol.json

`ProtocolFileSchema` 只有 `version: 1`。`ensureProtocol` 读 `you-brain/protocol.json`。文件缺失或正文为空时，用 `upsertByPath` 写成：

```json
{
  "version": 1
}
```

读到无法通过 `parseProtocolFile` 的内容时，同步按 JSON 解析错误抛出，不会改写该文件。
