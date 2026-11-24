# REA 分析：本地 UU 远程（UURemote.app）架构与丝滑远程桌面复刻边界

> 方法：morluto/rea 的「分析本地应用」流程；日期 2026-11-24。
> 目标：拆解 `/Applications/UURemote.app` 的低延迟推拉流与键鼠触控架构，确定 `you-brain` 原生内置复刻方案与能力边界。

## Evidence

| # | 证据 | 结论 |
|---|---|---|
| E1 | `/Applications/UURemote.app/Contents/` 包结构 | 拆分为主壳 `MacOS/UURemote`、常驻守护 `UURemoteDaemon` / `UURemoteService`、被控端宿主 `Helpers/UURemoteServer` 及跨平台流媒体动态库 `Frameworks/libstreamer.dylib`（26.6 MB） |
| E2 | `otool -L libstreamer.dylib` 与符号表 | 链接 `ScreenCaptureKit.framework`、`IOSurface.framework`、`VideoToolbox.framework`、`Metal.framework`；符号含 `SCStream`、`SCStreamConfiguration`、`video_toolbox_util.cpp`、`_OBJC_CLASS_$_MetalView` |
| E3 | `Resources/licenses.txt` 与 `libstreamer.dylib` 字符串 | 核心实时传输层基于 **WebRTC**（`p2p/base/basic_ice_controller.cc`、`rtp_format_h264.cc`、`data_channel_interface.h`），走 ICE/STUN/TURN UDP 打洞直连 + DTLS-SRTP 视频流 + `RTCDataChannel` 控制流，规避 TCP 队头阻塞 |
| E4 | `Resources/streamer-config.json` | 硬件编码优先 H.264 / HEVC，按设备解码上限动态协商码率与分辨率 |
| E5 | `UURemoteServer` Swift 模块符号 | `ScreenVideoCaptureManager`（屏幕采集）、`InputController` / `MouseEdgePointCompensator`（`CGEvent` 键鼠与滚轮注入、拖拽状态机、双击计数）、`ClipboardPCManager`（剪贴板同步）、`AccessibilityPermission` / `ScreenCapturePermission`（TCC 权限） |
| E6 | `Resources/com.netease.uuremote.daemon.plist` | 系统登录窗（LoginWindow）锁屏态控制依赖 root 级 `LaunchDaemon`；普通用户态进程可完整控制已登录桌面会话 |

## 结论：you-brain 复刻架构与低延迟设计

1. **绝不走中转 TCP/WebSocket 隧道传画面，媒体与控制面统一走原生 WebRTC**
   - 信令握手复用 `services/telegram-relay` 与现有 Ed25519 签名指令（`rd.open` / `rd.ice` / `rd.close`），不新增外部账号体系。
   - 媒体流走 WebRTC SRTP（UDP P2P 直连优先，中转支持按 `RELAY_TURN_URLS` + `RELAY_TURN_SECRET` 下发临时 HMAC TURN 凭据兜底跨对称 NAT）。
2. **零卡顿、60fps 丝滑管线关键点**
   - **被控端零拷贝采集与超低延迟硬编（macOS `U-Brain Remote Host.app`）**：`ScreenCaptureKit`（NV12 `420v`、`minimumFrameInterval = 1/60s`、`queueDepth = 3`）直出 `CVImageBuffer` 送入 Apple Silicon `VideoToolbox` 硬件编码器；开启 `RealTime = true`、`EnableLowLatencyRateControl = true`、`AllowFrameReordering = false`（零 B 帧、零重排延迟、`MaxFrameDelayCount = 0`）。
   - **微突发平滑发包（Micro-burst RTP Pacer）与瞬时关键帧恢复**：对常规 P 帧零等待立即发出；对超大 IDR 关键帧分微片平滑送入 UDP 套接字，防止内核/路由器缓冲区瞬时溢出丢包；收到 WebRTC RTCP `PLI` / `FIR` 丢包反馈时立即触发硬编输出 IDR 帧（<16ms 恢复，不花屏不卡死）。
   - **双 DataChannel 分流**：高频鼠标移动与像素级滚轮走无序零重传通道 `input-fast`（`ordered: false, maxRetransmits: 0`），消除无线网络抖动导致的鼠标粘滞；按键按下/抬起、点击、剪贴板、显示器与画质切换走可靠有序通道 `control`。
   - **控制端零缓冲硬解渲染**：桌面/Web 端与 Android 端均在 `RTCRtpReceiver` 上设置 `playoutDelayHint = 0` 与 `jitterBufferTarget = 0`，帧到达即送 GPU 硬解上屏；Android 端叠加 120Hz 原生 Jetpack Compose 触控板光标与手势层，实现零延迟跟手体验。
3. **能力边界**
   - ✅ 支持：macOS 被控端 60fps 硬件采集编码、多显示器切换、三档画质（流畅 / 高清 60fps / 原画 60fps）动态无感切换、完整键鼠（含拖拽、多击、像素级平滑滚轮、修饰键组合、中文输入法文本直输）、双向文本剪贴板同步、Web/桌面端与 Android 原生端控制。
   - ❌ 暂不纳入本期：无图形界面的 Linux VPS 被控、root 级 LoginWindow 系统锁屏页注入、虚拟显示器/隐私黑屏、远端系统内录音频与大文件拖拽传输。
