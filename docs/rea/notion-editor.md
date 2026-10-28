# REA 分析:本地 Notion 桌面应用与编辑器能力边界

> 方法:morluto/rea 的「分析本地应用」流程;日期 2026-10-29。
> 目标:确定 you-brain 里复刻 Notion **编辑功能**的能力上限。

## Evidence

| # | 证据 | 结论 |
|---|---|---|
| E1 | `/Applications/Notion.app/Contents/Resources/app.asar`(解包 30MB) | Electron 壳:i18n 只有 333 个壳层 key;`.webpack/renderer/` 仅含 `tabs/`、`windows_and_tabs/`、`sqlite_browser/`、`activity_monitor/` 等窗口标签管理 bundle,**没有任何编辑器代码** |
| E2 | 壳内 `node_modules/@notionhq` 等 | 客户端工具与 MCP host,与编辑器无关 |
| E3 | 编辑器 UX(slash 菜单、拖拽把手、实时协作光标) | 随 notion.so 远程 web 应用下发,走 Notion 私有协作 API |

## 结论:复刻边界

1. **编辑器不在本地**——对本地 Notion.app 做 REA 拿不到编辑器功能面(与 Obsidian 不同,那是完整本地渲染)。
2. you-brain 的写入走 **Notion 公开 REST API**(与官方集成同一通道),因此可复刻的编辑能力 = API 写入能力:
   - ✅ 块内容更新(PATCH /blocks/{id}):paragraph、heading 1–3、bulleted/numbered list、to_do(含勾选)、quote、callout(emoji+颜色)、toggle、code(语言+文本)
   - ✅ 块类型转换(turn into):PATCH 换 type
   - ✅ 插入:PATCH /blocks/{parent}/children 支持 `after` 参数(可插到任意块之后)
   - ✅ 删除:DELETE /blocks/{id}(归档)
   - ✅ 页面标题:PATCH /pages/{id}(title property)
   - ❌ 拖拽排序:API 无移动端点;对**无子块**的块用「复制+删除」模拟,有子块的块禁止移动(避免连带删掉子树)
   - ❌ 实时协作、评论、数据库视图编辑、嵌套数据库行排序:不在本期
3. 桌面版的离线缓存(`Application Support/Notion`,better-sqlite3)是私有格式,不复刻、不读。
