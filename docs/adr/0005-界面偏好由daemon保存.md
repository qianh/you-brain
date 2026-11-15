# ADR-0005：界面偏好由 daemon 保存

状态：已接受（2026-11-15）。

## 背景

界面偏好（终端分组颜色、展开状态、只看活跃、主题、T3 地址、知识库侧栏宽度等）原来存在浏览器的 localStorage。界面从 `http://127.0.0.1:<端口>/` 加载，而 daemon 未指定端口时由系统随机分配（`packages/core/src/http/server.ts`），端口一变就换了源，旧数据读不到。结果是每次重装或重启 daemon 后，偏好全部丢失。

## 决定

1. **daemon 保存偏好**：数据目录下的 `ui-prefs.json`（`UiPrefsStore`），界面通过本机接口 `GET/PUT /api/ui-prefs` 读写。机制层只认键和值，不认识任何业务名词；单个值、单个键和文件总大小设上限，超限拒绝写入并报错，不静默截断。
2. **随首屏注入**：daemon 在 `index.html` 的 `<head>` 里注入 `window.__YOU_BRAIN__ = { token, prefs }`，主题等偏好在第一帧前生效，不闪。
3. **界面侧 `prefs` 取代 localStorage**：`apps/web/src/lib/prefs.ts`，读同步、写先更新内存再延迟合并成一次 `PUT`；页面关闭时用 keepalive 补写（只在请求体不超过 60000 字节时）。哪些键算偏好由 `isPrefKey` 列出；纯缓存（启动快照、知识库页面缓存）仍留在 localStorage。
4. **一次性迁移**：升级后首次打开，当前源的 localStorage 里若还有旧键，且 daemon 侧没有对应值，则写入 daemon。旧端口下的数据已读不到，不强求找回。
5. **写入失败**：本次操作照常生效、只是不持久，界面提示一次。

## 没选的方案

**固定端口**。改动最小，但端口被占用时要么启动失败、要么退回随机端口，问题会再次出现；而且偏好仍绑在浏览器源上。

## 后果

- 偏好只在本机，不随 Drive 同步到其他设备。
- 偏好键与业务名词的对应关系留在界面代码里（`PREF_KEYS` 与前缀表），daemon 侧不需要改动就能支持新键。
- 终端会话提醒的开关（`you-brain.deck.terminal-notify`）也存在这里，daemon 的提醒监视器直接读它。
- `removeItem` 同时清除内存、旧存储里的副本和 daemon 里的键，避免被迁移逻辑复活。
