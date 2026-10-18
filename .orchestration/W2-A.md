# 任务 W2-A：协议数据同步（core/sync）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改：packages/core/src/sync/**、packages/core/test/sync/**。

## 要求（技术方案 4、6.1、6.2、6.3、8）
用 drive（DrivePort / upsertByPath / updateJsonWithMerge / changes）、store、topics、protocol 实现：
1. **事件推送**：`EventLog`（本机事件工厂：生成 ULID、ts、device、单调递增 seq，seq 持久化在 store）→ 写入 store.outbox → `flush()`：把当天（按 roles.timezone 的日期）该设备的全部事件序列化为 jsonl，原地更新 `you-brain/events/<deviceId>/<YYYY-MM-DD>.jsonl`（fileId 不变），成功后确认 outbox。离线/失败保留 outbox，下次按顺序重试。跨天时旧日期文件也要能正确补写。flush 间隔 30 秒由调度方调用，你提供方法即可。
2. **设备心跳**：注册/更新 `devices/<deviceId>.json`（6.1 字段），`heartbeat({active?})` 更新 lastSeenAt / lastActiveAt。
3. **共享配置与角色**：读取 `config/shared.json`、`config/roles.json`（不存在则用 protocol 默认值），写入走 updateJsonWithMerge（etag 乐观锁 + 按字段合并重试）。`protocol.json` 首次初始化。
4. **拉取**：`pull()` 用 changes.list + 游标（存 store.cursors），把变化分三类分派：
   - 事件文件变化 → 读取文件、按 store.cursors 中记录的已读行号只取新增行（文件被重写成更短时退回全量读）→ 交给 topics 增量合并 → 持久化到 store → 触发 `onTopicsChanged` 回调
   - inbox 文件变化 → 触发 `onInboxChanged(files)` 回调（会话索引/搜索/网页会话提炼由别人处理）
   - 数字分身 / config 变化 → 触发对应回调
   - 回调用一个简单的事件总线/接口注入，不要依赖 portrait/output 等其他模块
5. **新设备首次同步**：没有游标时全量读取 you-brain/ 下所有协议数据，重放全部事件生成话题册，再获取 startPageToken。
6. 本机自己产生的事件：写入 outbox 时立即在本地应用到话题册（不必等推送+拉取回来），拉取时按 id 幂等跳过。
7. 测试（用 memory-drive，两个设备各自一个 store 共享同一个 memory-drive）：A 产生事件 flush → B pull 后话题册一致；双方并发产生事件后双方结果完全相同；离线 outbox 重放；跨天分片；首次同步重放；配置并发修改按字段合并。

## 验收
`cd packages/core && bun test test/sync` 全部通过；tsc 无你负责文件的错误。
