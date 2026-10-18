# 任务 W1-B：Drive 层 + 原地更新上传（core/drive、core/upload）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改：packages/core/src/drive/**、packages/core/src/upload/**、packages/core/test/drive/**、packages/core/test/upload/**。
可以 import（只读）：@you-brain/protocol、packages/core/src/domain。不要 import store/adapters（它们由别人并行开发）——上传服务通过你自己定义的小接口（如 `UploadIndex { fileIdOf(key); record(key, fileId, meta) }`、`SessionSource`）解耦，由后续集成任务接线。

## 要求（技术方案 4、5.2、8.2、19）
1. 搬运参考实现 src/drive/*（drive-port、google-drive、memory-drive、scoped-drive）及其测试，改为 bun:test。
2. DrivePort 需要的能力：按路径确保文件夹、create、**update(fileId, content, {ifMatch etag})** 保持 fileId 不变、412 冲突抛出可识别的 ConflictError、read（返回内容 + etag + md5Checksum + modifiedTime）、rename、move（改父目录不变 fileId）、trash、按 appProperties 查找、按路径查找、list、`changes.list` + startPageToken 游标。memory-drive 必须完整模拟这些语义（含 etag 变化、412、md5、changes 游标），它是全项目测试的基石。
3. 重写上传服务为**原地更新**，严格按技术方案 5.2 的伪代码：canonical = createdTime 最早；远端不比本地新才 update；412 重新读取比较后重试（有上限）；用 md5Checksum 校验；existing>1 时合并进 canonical 并把其他移入回收站；标题变化只改名；appProperties 沿用 + 新增 ybSchema。
4. 节流：空闲后上传；持续活跃时最多每 5 分钟一次（做成可注入时钟的纯逻辑，便于测试）。
5. 提供通用的 `upsertByPath(path, content)`（同一路径原地更新，用于事件分片文件、设备文件、topics/*.md、shared.json 等），以及 `updateJsonWithMerge`（etag 乐观锁，冲突时重读→调用方提供的按字段合并函数→重试），供后续 sync 使用。
6. 测试必须覆盖：首次创建、多次更新 fileId 不变、两个"设备"并发 create 产生重复后收敛到同一 canonical、412 重试、md5 校验失败、改名不变 fileId、changes 游标增量。

## 验收
`cd packages/core && bun test test/drive test/upload` 全部通过；tsc 无你负责文件的错误。
