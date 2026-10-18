# 任务 W1-C：本地存储 + 话题册事件合并（core/store、core/topics）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改：packages/core/src/store/**、packages/core/src/topics/**、packages/core/test/store/**、packages/core/test/topics/**。
可以 import（只读）：@you-brain/protocol、packages/core/src/domain。

## 要求（技术方案 6.3~6.5、9.2）
1. store：用 `bun:sqlite` 实现，参考 BrainHub src/state/（sqlite-store.ts、store.ts）的风格。建 9.2 中除 search_* 外的全部表（sessions、topics、conclusions、todos、events、outbox、cursors、devices、portrait、reminders），带 schema 版本与迁移机制，WAL 模式。提供类型化的仓储方法（会话 upsert/查询今日、话题查询、outbox 入队/出队/确认、游标读写、设备缓存读写、portrait 记录）。`today` 查询要支持传入时区。
2. topics：**纯函数**事件合并引擎（这是核心，务必严谨）：
   - 输入任意顺序、可能重复的事件集合 → 按 (ts, device, seq) 全局排序 → 按 id 去重 → 依次应用 → 输出确定的话题册状态（topics、sessions 的提炼字段与归属、conclusions、todos）。
   - 实现 6.4 的全部 7 条规则：字段级 LWW；用户优先（by:user 的状态不被之后 by:auto 覆盖，除非用户再次修改）；merged 映射重定向（包括链式 a→b→c、以及 merged 之前/之后到达的指向 from 的事件）；并发同名新建话题（规范化名称：小写、去空白和标点）按 (ts, topicId) 最小者为准自动合并；幂等；session.refined 取 refinedUpTo 最大者。
   - 实现 6.5 活跃区/历史区派生（纯函数，入参 now、activeLimit、historyDays）。lastActive = max(相关会话 updatedAt, 最后一次用户操作时间)。
   - 增量应用：提供"在已有状态上追加新事件"的路径；当新事件的排序位置早于已应用的最后一个事件时，回退为全量重放（保证结果与全量一致）。
   - 把合并结果持久化到 store 的方法（全量替换派生表即可，事件表保留）。
3. **属性测试**（技术方案 19）：随机生成事件流（含多设备、重复投递、乱序、合并链、用户/自动状态竞争、同名并发新建），断言：任意打乱+重复后合并结果完全一致；增量应用与全量重放一致。用固定种子的简单 PRNG 自己写，不要引新依赖，至少跑 200 轮。

## 验收
`cd packages/core && bun test test/store test/topics` 全部通过；tsc 无你负责文件的错误。
