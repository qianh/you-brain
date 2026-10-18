# 任务 W3-C：Tauri v2 菜单栏外壳（apps/desktop）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改 apps/desktop/**。`@tauri-apps/cli` 已装在 apps/desktop（`bunx tauri ...`），不要再用 bun add；Rust 依赖用 cargo 管理（可以改 Cargo.toml）。

## 要求（产品说明 5.1/5.2，技术方案 14.1）
- `apps/desktop/src-tauri`：Tauri v2 应用，产品名 you-brain，identifier `dev.youbrain.app`。
- macOS 菜单栏常驻、不占 Dock（ActivationPolicy::Accessory）。托盘图标（自己生成简单的模板图标 PNG，黑色单色，支持暗色模式模板渲染），托盘标题/提示显示同步状态；菜单：打开面板、打开完整窗口、立即同步、退出。
- 点击托盘图标：在图标下方弹出无边框面板窗口（约 380×560，失焦自动隐藏），加载 `http://127.0.0.1:<port>/panel`。完整窗口加载 `/`（约 1100×760，可调整大小，关闭只隐藏）。
- 全局快捷键（默认 `CmdOrCtrl+Shift+Y`，可在配置中修改）切换面板。
- 插件：autostart（开机自启）、global-shortcut、notification、single-instance。
- **daemon 生命周期**：启动时读取数据目录（macOS `~/Library/Application Support/you-brain/daemon.json`，支持 `YOU_BRAIN_DATA_DIR` 覆盖）；daemon 未运行（文件不存在或 pid 已死或 `/api/status` 不通）则拉起它。拉起方式：优先 sidecar 二进制 `you-brain`（externalBin，后续打包时放入），开发时回退到环境变量 `YOU_BRAIN_DAEMON_CMD`（例如 `bun /path/packages/cli/src/index.ts daemon`）。等待 daemon.json 出现并健康后再加载窗口。退出外壳时不杀 daemon（daemon 独立常驻）。
- 定期（30 秒）或通过 SSE 读取 `/api/status`，更新托盘提示与角标（有异常/提醒时）。
- 前端 JS 只需要窗口内的 Web UI（由 daemon 托管），外壳本身不需要前端打包；如需要一个 loading 页，用 src-tauri 内嵌的静态 html。
- 在 tauri.conf.json 中声明 externalBin（指向 `binaries/you-brain`），但开发构建时如果不存在要能跑（可以用 cfg/特性开关或开发配置文件分离）。

## 验收
- `cd apps/desktop/src-tauri && cargo check` 通过；`cargo clippy` 无错误（警告尽量清理）。
- 有条件就跑 `cd apps/desktop && bunx tauri build --debug --no-bundle` 确认能编译出可执行文件（耗时较长可以接受）。
- Rust 侧的纯逻辑（daemon.json 解析、健康检查判断、窗口定位计算）写单元测试，`cargo test` 通过。
- 不需要真正启动 GUI 去点（无界面环境），但最终回复里写清楚手动验证步骤（主控会做）。
