# 任务 W1-F：M0 验证 + 本地语义搜索（core/search）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改：packages/core/src/search/**、packages/core/test/search/**、以及 /Users/john/private/ai/you-brain/.orchestration/m0/**（验证用的临时脚本放这里）。
可以 import（只读）：@you-brain/protocol、packages/core/src/domain、packages/core/src/drive/drive-port.ts（如已存在；它由别人并行开发，若尚不存在就自己定义一个最小读取接口）。

## 1. M0 验证（技术方案 18 的第 1、2 项）——先做
- 写最小脚本验证：`@huggingface/transformers` 用 `Xenova/multilingual-e5-small`（与参考实现 src/search/e5-embedder.ts 一致）在 `bun run` 下能否产出 384 维向量；再用 `bun build --compile` 编译成单文件可执行后能否运行（模型缓存目录、onnxruntime-node 原生库的加载）。
- 同样验证 `sharp` 转 webp 在 bun run 与 bun build --compile 产物中能否运行。
- 若编译产物不行，尝试可行方案（例如 --external 并把 node_modules 原生库随包分发、或运行时从数据目录加载），把**结论、可行方案和具体命令**写进最终回复。这是主控决策的依据，务必实测，不要猜。
- 模型下载可能较慢，允许联网下载模型。

## 2. search 模块
- 搬运参考实现 src/search/*（embedder、e5-embedder、model-cache、chunk-text、search-service）及测试，存储改用 bun:sqlite（自己管理 search_chunks / search_vectors / manifest / 游标 这几张表，表名与技术方案 9.2 一致，接受外部传入的 Database 实例）。
- 保留 BrainHub 的语义：索引新鲜度（基于 Drive changes 游标增量刷新，失败时用旧索引并标记 stale）、搜索降级（模型未就绪时关键词搜索并返回警告）。
- 新增 FTS5 关键词搜索，与向量结果做混合排序（语义 + 关键词，产品说明 5.2"搜索"页）。
- 根据 M0 结论：若 transformers 在编译产物中不可用，把 embedder 设计为可替换（例如通过子进程运行），并保证 FTS5 路径总能工作。
- 测试中用 fake embedder，不下载模型；真实模型测试默认 skip。

## 验收
`cd packages/core && bun test test/search` 全部通过；tsc 无你负责文件的错误；最终回复里有 M0 两项的实测结论。
