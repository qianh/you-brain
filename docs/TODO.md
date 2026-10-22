# you-brain TODO

> 建立：2026-10-22 ｜ 来源：[进度.md](./进度.md)、界面重做与内存优化过程中记下的遗留项
> 执行方式：主控（Claude）定任务书与验收，grok（`grok-4.7-build-fast`）实现；**每项做完 → 主控检查（测试、tsc、构建、必要的真机/截图验证）→ 提交并推送 → 再开始下一项**。
> 状态：`[ ]` 未开始　`[~]` 进行中　`[x]` 已完成　`[!]` 需要用户决定或配合，不进入自动执行队列

## 进行中

- [x] **Q1 菜单栏面板显示修复**：卡片被压扁截断（flex 子项被压缩）、引导清单已完成步骤折叠、空状态紧凑化、话题长名省略、滚动与页脚固定
- [x] **Q2 应用图标改为「思考的大脑」**：app 图标、托盘模板图标、网页 BrandMark、favicon

## A. 体验与稳定性收尾（小、风险低，先做）

- [x] **A1 daemon 启动慢**：新包启动后约 30 秒 daemon 才就绪（上一版约 5 秒），期间界面显示「后台没有运行」。查明原因（怀疑启动即做首轮采集扫描阻塞健康检查），让 HTTP 先就绪、采集后台进行；验收：冷启动 5 秒内可用，界面不闪「未运行」
- [x] **A2 面板「退出」与深链**：「退出」目前只关窗口，加 Tauri `quit` 命令真正退出应用；`open_main_window` 支持带路径，使面板里的「设置 / 话题 / 今日」跳转到主窗口对应页
- [x] **A3 界面遗留小项**：①路由淡入偶发停在半透明的确认与修复（快速连续切换、窗口失焦、`prefers-reduced-motion`）；②话题列表项补「N 个会话」（接口缺会话数时在前端用已有数据或扩展接口）；③`ShowMore` 展开后键盘 ↑↓ 覆盖全部行；④搜索 `from/to` 改为时间比较；⑤mock `offline` 场景核实运行时行为
- [x] **A4 同步状态与超时显示**：面板「同步」圆点依赖的 sync 字段（目前只有 ok / muted 两态）补全 warn / bad 判定；`daemon.ts` 的 `llmTimeoutMs` 显示修正
- [x] **A5 打包稳健性**：`bundle.sh` 在 DMG 步骤失败（Finder AppleScript 超时）时自动回退为只产 `.app`，并清理 `rw.*.dmg` 残留；产物统一落 `dist/app.noindex/`
- [ ] **A6 测试与类型检查加固**：①代理环境变量（`HTTP_PROXY` 等）下 `openai-compatible.test.ts`、`mcp/local.test.ts` 不再失败（测试内清理代理变量）；②`bun run typecheck` 覆盖 `apps/web`；③为 `apps/desktop`（Rust）补可运行的 `cargo test`/`cargo check` 脚本；④`llm/cli.test.ts` 偶发超时查因

## B. P1 功能（按依赖顺序）

- [ ] **B1 提醒系统**：生成逻辑——停滞话题提醒、每日早报、每周回顾、历史话题每周提醒；系统通知只在「最近 10 分钟活跃的设备」弹出；`GET /api/reminders` 与 MCP `get_reminders` 返回真实数据；桌面角标与通知联动（外壳侧已有）。参考 技术方案、产品说明 §9
- [ ] **B2 每日全局沉淀**：`packages/core/src/consolidate` 实现技术方案第 11 节流程；主设备租约 `leases/consolidate.json` 的写入与续约；沉淀开关与过期提示（读取侧已完成）联动真实结果
- [ ] **B3 Drive 话题总览与详情文件**：把话题册写成 Drive 上 `topics/TOPICS-latest.md` 及各话题详情文件（路径见 `packages/protocol/src/paths.ts`），随沉淀与话题变更更新，设备 B 可读
- [ ] **B4 数字分身纠正**：`portrait.correction` / `portrait.correction_applied` 事件的折叠与应用（`topics/fold.ts` 目前忽略）；界面纠正入口（替换「纠正会在后续版本开放」）；MCP 暴露
- [ ] **B5 网页会话处理设备**：`webProcessor` 角色真正生效——被指定设备负责处理网页版 AI 会话的提炼；角色切换的行为与状态展示
- [ ] **B6 服务器模式**：生成并安装 launchd / systemd 单元（`you-brain service install|uninstall|status`），与 `maintenance.ts` 的卸载清理对齐，使无界面机器可担任主设备
- [ ] **B7 虚拟设备协议**：`docs/protocol/` 协议文档，注册虚拟设备（`kind: virtual`）与对外发布所需的 API / 校验
- [ ] **B8 Linux 桌面打包**：`tauri.bundle.conf.json` 与构建脚本增加 linux 三元组资源（此机为 macOS，无法实机验证，只做配置与可编译性检查，验证项留待 Linux 机器）

## C. P2

- [ ] **C1 Webhook 推送**：把提醒 / 话题事件推送到用户配置的 webhook（含签名、重试、设置页入口、测试）；依赖 B1

## D. 验收与文档

- [ ] **D1 M0 六项验证记录**：补全 [进度.md](./进度.md) M0 表的验证结论（transformers 与 sharp 在编译产物中的运行、Drive etag 并发、CLI 恢复会话 ID、`changes.list` 配额与延迟、Tauri 打包 / 签名 / 开机自启），能自动化验证的写脚本留证据
- [ ] **D2 进度文档更新**：每完成一项，同步更新 `进度.md` 对应行（状态、证据提交）

## 需要你决定或配合（不进自动队列）

- [!] **P0 真实环境验收**：用真实 CLI、真实 Drive、真实模型走一遍「聊完 → 空闲 5 分钟 → 今日出现概要并归入话题 → 会话继续链接不变 → 新会话读到数字分身 → MCP 搜索到历史会话」。需要你的 Google 账号与模型配置
- [!] **LICENSE**：选 MIT 还是 Apache-2.0
- [!] **README 与 GitHub About**：仓库公开，需要对外说明
- [!] **官方 OAuth 受限范围审核**：属于向 Google 申请的流程，不是代码
- [!] **旧 `.orchestration` 提交历史是否改写**：公开仓库历史里留有编排文件，是否清理
- [!] **手机端**：产品说明第 10 节明确排除手机端采集，保持不做，除非你改变范围
