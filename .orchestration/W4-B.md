# 任务 W4-B：Web UI 修复 + Tauri 外壳对齐（apps/web、apps/desktop）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你可以修改：apps/web/**、apps/desktop/**。不要改 packages/**（别人并行在改）。不要新增依赖。
注意：本机 bun 1.3.11 在 `~/.local/share/fnm/node-versions/v22.15.0/installation/bin/bun`，PATH 里已经加好。

## 主控用无头 Chrome 截图验收发现的问题
1. `/panel` 在 380px 宽度下**横向溢出**：会话卡片右侧被截断，"2 个会话"计数被裁掉。修复为面板内所有内容自适应宽度、长文本换行、不出现横向滚动。顺带检查 320px 和完整窗口窄屏（800px）下没有溢出。
2. 话题列表中的状态标签（进行中/待跟进等）被**拉伸为整行宽度**，应为内联胶囊，宽度贴合文字。
3. 面板中"提醒"和"状态摘要"区块要在首屏可见或有清晰入口（产品说明 5.2：今日 / 提醒 / 状态摘要）；今日列表过长时面板内滚动，底部"打开完整窗口"按钮固定。
4. 面板按钮调用的 Tauri 命令名是 `open_main_window`，但 apps/desktop 中没有实现这个命令。在 Rust 侧实现 `open_main_window`（以及 Web UI 中用到的其他 invoke，全部搜一遍对齐），并在 capabilities 中放行；Web UI 侧在 `window.__TAURI__` 不存在时回退 window.open。因为 Web UI 是从 http://127.0.0.1 远程地址加载的，确认 Tauri v2 的 remote 域 capability 配置（`remote.urls`）允许该来源调用这些命令，以及 `app.withGlobalTauri` 已开启。
5. 外壳加载完整窗口和面板时，URL 使用 daemon.json 中的端口；daemon 会在 index.html 注入 token，外壳不需要传 token。确认这一点与实现一致。
6. tauri.conf.json：externalBin `binaries/you-brain`；另外增加 `bundle.resources`，把 `../../../dist/daemon/aarch64-apple-darwin/vendor` 和 `.../web` 打进 app 的 Resources（路径如果不存在，开发构建不能失败——用单独的 `tauri.bundle.conf.json` 或在打包脚本中处理，任选其一并说明）。外壳拉起 sidecar 时设置环境变量 `YOU_BRAIN_WEB_DIR=<Resources>/web`、`YOU_BRAIN_VENDOR_DIR=<Resources>/vendor`。

## 验收
- `cd apps/web && bunx tsc --noEmit && bun run build && bun test` 通过。
- 用 `apps/web/scripts/mock-daemon.ts` 启动后，用无头 Chrome 实测截图检查（`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=380,560 --virtual-time-budget=4000 --screenshot=/tmp/x.png http://127.0.0.1:4731/panel`），确认上述问题已修复，截图存到 /tmp/yb-w4b/ 下并在最终回复列出。注意 zsh 中不要用 `path` 作变量名。测完关掉 mock 进程。
- `cd apps/desktop/src-tauri && cargo check && cargo clippy && cargo test` 通过。
