# 任务 W3-B：Web UI（apps/web）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改 apps/web/**。依赖已装好（react 19、react-dom、vite、@vitejs/plugin-react）；确需新依赖时在最终回复中列出，不要自己装。

## 背景
Web UI 由 daemon 在 127.0.0.1 同源托管，也会被 Tauri 外壳的 WebView 加载（弹出面板 + 完整窗口）。daemon 在 index.html 注入 `window.__YOU_BRAIN__ = { token }`，所有请求带 `Authorization: Bearer <token>`，SSE 用 `/api/events?token=`。
API 客户端与类型**必须复用** `@you-brain/core/http`（packages/core/src/http/client.ts、types.ts，先读它们）；如果客户端依赖了 Bun/Node 专有 API 导致不能在浏览器打包，就只 import 类型，自己写一个薄 fetch 客户端，并在最终回复里说明。
开发模式：`bun run dev`（vite），通过 vite proxy 把 /api 代理到 `VITE_DAEMON_URL`，token 取自 `VITE_DAEMON_TOKEN`。

## 页面（产品说明 5.2）
- `/panel`：弹出面板（窄宽度约 380px）——今日（按话题分组的会话与概要）、提醒（P1，空状态）、状态摘要（上次同步时间、异常提示），以及"打开完整窗口"按钮（调用 `window.__TAURI__` 可用时用它，否则 window.open）。
- 完整窗口（左侧导航）：
  - 今日：按话题 / 按时间切换；每个会话显示来源、设备、时间、标题、概要，可打开 Drive 原文链接。
  - 话题册·活跃 / 话题册·历史：列表 + 详情（概要、下一步、结论、待办、相关会话链接）；操作：改名、合并（选目标话题）、拆分（把会话移到新话题/其他话题）、改状态（进行中/待跟进/已完结/搁置）、完成/放弃待办、追加结论；历史区支持搜索和重新激活。
  - 数字分身：各变体（全量/精简/编码）内容（markdown 渲染，自己写一个轻量渲染或纯文本 pre，不要引新依赖）、历史快照列表；纠正是 P1 先不做。
  - 搜索：输入框 + 结果（标题、片段、来源、时间、降级/过期警告）。
  - 设备：设备列表、最后在线时间、设置主设备和网页会话处理设备。
  - 设置：产品说明 5.3 的配置项分组表单（PUT /api/config、/api/roles）；API Key 输入只提交给 daemon 存钥匙串，永不回显。
  - 状态：各来源最近采集时间、同步队列、提炼重试队列、错误日志。
- 订阅 SSE，话题册/今日变化时自动刷新。
- 中英双语（默认中文，跟随配置的界面语言），简单文案表即可。
- 视觉：干净克制的 macOS 风格，支持浅色/深色（prefers-color-scheme），纯 CSS（CSS 变量），不引 UI 库。

## 测试与验收
- `cd apps/web && bunx tsc --noEmit` 0 错误，`bun run build` 成功产出 dist/。
- 用 bun:test 给数据处理函数（分组、格式化、文案）写单元测试。
- 写一个 mock 服务脚本 `apps/web/scripts/mock-daemon.ts`（Bun.serve，实现上面用到的 /api/* 和 SSE，返回逼真的中文假数据，托管 dist 并注入 token），用它启动后**在浏览器中实际检查**主要页面和面板（如果你有浏览器工具），修好看到的问题。检查完关闭进程。
