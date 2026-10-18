# 任务 W2-B：数字分身 + 本地 markdown 输出（core/portrait、core/output）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改：packages/core/src/portrait/**、packages/core/src/output/**、packages/core/test/portrait/**、packages/core/test/output/**。

## 要求
1. portrait（技术方案 10.1~10.3，参考 BrainHub src/portrait/portrait-service.ts、portrait-sync-service.ts）：
   - 按 shared.json 的 portrait.variants 从 Drive 拉取各变体到 `~/.you-brain/portrait/<id>.md`（原子写），路径相对 Drive 根目录，也支持 `/` 开头的 My Drive 绝对路径；记录到 store.portrait（版本/modifiedTime/md5，未变化不重写）。
   - 列出历史快照（snapshotPattern）供 GUI 对比。
   - `getPortrait(variant = "full")` 读本地副本，本地没有时从 Drive 拉。
   - CLI 注入编排：调用 clients 模块已有的托管段落 plan/apply（不要重复实现），当 coding 变体路径或措辞变化时自动重新 apply 用户已同意的项（同意列表存本地配置或 store，你定义接口）。
2. output（技术方案 9.3）：从 store 读取数据，渲染并原子写入 `~/.you-brain/TODAY.md`、`TOPICS.md`（REMINDERS.md 是 P1，先输出"暂无提醒"占位即可，不做提醒逻辑）。
   - TODAY.md：今日会话（按时区计算今日）——来源、设备名、时间、标题、概要、所属话题、Drive 链接（`https://drive.google.com/file/d/<fileId>/view`），按话题分组。
   - TOPICS.md：活跃话题（状态、概要、下一步、未完成待办、最近结论、相关会话链接）+ 历史话题名称列表。活跃/历史用 topics/zones 派生。
   - 防抖 10 秒（可注入时钟/定时器），内容未变化不重写文件。
   - 中文输出（界面语言 en 时英文，做个简单的文案表即可）。
3. 测试：快照测试 markdown 内容；防抖；原子写；portrait 拉取与未变化跳过；注入在路径变化时自动更新（使用临时 HOME）。

## 验收
`cd packages/core && bun test test/portrait test/output` 全部通过；tsc 无你负责文件的错误。
