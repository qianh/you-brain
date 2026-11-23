# you-brain Android 客户端（原生 Kotlin）

`apps/android` 是 `you-brain` 的原生 Android 客户端（包名 `ai.youbrain.mobile`），采用 **Kotlin + Jetpack Compose + Material 3 + OkHttp + BouncyCastle 轻量原语 + R8 全量裁剪** 实现：

- **查看所有设备 T3 页面**：通过中转服务器与目标端建立端到端加密 T3 隧道（X25519 + HKDF-SHA256 + AES-256-GCM），经本机 `127.0.0.1` 回环 HTTP/1.1 + WebSocket 代理加载 `WebView`，自动完成 `pair` 凭据登录与按设备隔离 Cookie，并保活最多 4 台设备页面实例。
- **接收全量推送消息**：前台保活服务（`RelayForegroundService`）通过长连接订阅中转队列（`notify` / `pushes` 游标追帧），即使未绑定 Telegram Bot 也能收全 `tty7`、`t3`、`dispatch` 和 U-Brain `reminder.issued` 提醒，并支持通知栏/锁屏直接快捷回复（Ed25519 签名的 `notice.reply`）。
- **主控 Agent 会话与派活调度**：选择已配对的 VPS 主控设备后，可直接创建或切换持久化的主控 T3 会话（支持多轮上下文、运行中队列排队、看板追踪 `dispatch.list` / `dispatch.followup` / `dispatch.refresh` 与快捷派发任务）。

> 注意：根目录 `package.json` 配置了 `"workspaces": ["packages/*", "apps/*"]`，因此 **切勿在 `apps/android/` 下创建 `package.json`**，以免被 Bun workspace 误识别。

---

## 首次配对与授权步骤

1. **生成入网邀请**
   在已连接中转网络的桌面端或 VPS Web UI 中打开 **设置 → Telegram 推送**，点击 **「添加手机 / 新设备」→「生成手机 / 设备入网链接」**（调用 `POST /api/deck/telegram/enroll-invite`）。
2. **手机端配对**
   安装并打开 Android 应用（`ai.youbrain.mobile`），将邀请链接完整粘贴到引导页输入框中，点击配对。手机端无需登录 Google / OAuth，会自动生成本机 Ed25519 密钥对并通过邀请一次性换取中转令牌。
3. **在目标设备上信任手机**
   - 在 **VPS 主控端**（以及需要派活或快捷回复的电脑端）打开 Web UI **设置 → 跨设备派活**：
     - 可直接在该手机设备旁点击 **「信任此设备」**（同时更新 `allowedSenders` 并写入云盘成员信任列表），或开启派活权限与 **「信任已入网的自己人设备」**。
   - 如需在手机端打开某台设备的 **T3 页面**，还需在该目标设备上开启 **「允许远程查看我的 T3」**（`authorizeView`）。
4. **选定主控设备**
   在手机应用 **主控 Agent** 页面或 **设置** 页选定你的 VPS 主控设备后，即可持续对话、下达派活指令并查看看板进度。

---

## 后台保活与通知权限建议

- 启动后请授予应用 **通知权限**（Android 13+）。
- 应用通过系统通知栏常驻 `dataSync` 前台服务保持与中转的 WebSocket 连接，切换 Wi-Fi / 5G 时会自动重连并按 `seq` 游标补齐断线期间的推送。
- 国产定制系统（MIUI / HyperOS / ColorOS / OriginOS / HarmonyOS 等）若需要长时间息屏收推送与快捷回复，建议在系统应用设置中将该应用的省电策略设为 **无限制**，并允许 **自启动 / 后台弹出**。

---

## 本地构建与测试

依赖 **JDK 17** 与 **Android SDK 35**（`platforms;android-35`、`build-tools;35.0.0`）。在 `apps/android/` 目录下执行：

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"

# 运行 JVM 单元测试（含与 @you-brain/protocol 的跨端密码学互通向量与本地代理测试）
./gradlew testDebugUnitTest

# 打 Debug 与 Release 包（Release 默认开启 R8 压缩与资源裁剪）
./gradlew assembleDebug assembleRelease
```

若本机网络需要 HTTP 代理（例如 `127.0.0.1:1082`），可通过环境变量临时传入（切勿写死进提交仓库的 `gradle.properties`）：

```bash
export GRADLE_OPTS="-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=1082 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=1082"
```

产物输出路径：
- `apps/android/app/build/outputs/apk/release/app-release.apk`
- `apps/android/app/build/outputs/apk/debug/app-debug.apk`
