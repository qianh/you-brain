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
- [x] **A6 测试与类型检查加固**：①代理环境变量（`HTTP_PROXY` 等）下 `openai-compatible.test.ts`、`mcp/local.test.ts` 不再失败（测试内清理代理变量）；②`bun run typecheck` 覆盖 `apps/web`；③为 `apps/desktop`（Rust）补可运行的 `cargo test`/`cargo check` 脚本；④`llm/cli.test.ts` 偶发超时查因

## B. P1 功能（按依赖顺序）

- [x] **B1 提醒系统**（拆为五步，参考 技术方案 §12、产品说明 §6.6）
  - [x] B1a 后端：生成（停滞 / 历史 / 早报 / 周回顾）、事件折叠落库、`GET /api/reminders`、`POST /api/actions/reminder`、MCP、`REMINDERS.md`
  - [x] B1b daemon 活跃信号与投递判定（`POST /api/activity`、`delivery`）、今日页与面板的提醒操作
  - [x] B1c 桌面外壳：上报键鼠活动、按 `delivery.notify` 弹系统通知（通知正文用提醒文案、已通知的不重复）、角标
  - [x] B1d 同步层：设备记录的 `lastActiveAt` 写入真实活动时间（目前 Drive 上仍写成「现在」，会让其他设备误判这台正在使用）
  - [x] B1e 提醒相关的多设备端到端验证（两个 daemon 共用内存 Drive：只生成一次、只在一台设备 `notify`）
- [x] **B2 每日全局沉淀**（技术方案 §11）
  - [x] B2a 租约 `leases/consolidate.json`、调度与补跑、话题概要重写、合并建议、`POST /api/actions/consolidate`
  - [x] B2b 数字分身重新生成（先存快照再原地更新、异常变短拒绝覆盖、未应用纠正的输入预留）与状态页/设置页展示 `lastRun`
- [x] **B3 Drive 话题总览与详情文件**：把话题册写成 Drive 上 `topics/TOPICS-latest.md` 及各话题详情文件（路径见 `packages/protocol/src/paths.ts`），随沉淀与话题变更更新，设备 B 可读
- [x] **B4 数字分身纠正**：`portrait.correction` / `portrait.correction_applied` 事件的折叠与应用（`topics/fold.ts` 目前忽略）；界面纠正入口（替换「纠正会在后续版本开放」）；MCP 暴露
- [x] **B5 网页会话处理设备**：`webProcessor` 角色真正生效——被指定设备负责处理网页版 AI 会话的提炼；角色切换的行为与状态展示
- [x] **B6 服务器模式**：生成并安装 launchd / systemd 单元（`you-brain service install|uninstall|status`），与 `maintenance.ts` 的卸载清理对齐，使无界面机器可担任主设备
- [x] **B7 虚拟设备协议**：`docs/protocol/` 协议文档，注册虚拟设备（`kind: virtual`）与对外发布所需的 API / 校验
- [x] **B8 Linux 桌面打包**：`bundle-linux.sh`（运行时生成按 triple 的配置）、`web-dir`/`resolver` 的 `../lib/you-brain` 兜底（`native/layout.ts`）、托盘无 rect 时面板右上角降级、`xprintidle` 空闲读取、`workflow_dispatch` 工作流 `desktop-linux.yml`。未在真实 Linux 上出包：待手动触发工作流验证（arm runner 需账号开通）
- [x] **B9 设备移除传播**：拉取（首次，或任一页 `removedIds` 非空）后用 `devices/` 列表对账，删本地已不存在的虚拟设备行（物理设备/本机不动），list 失败则 pull 失败游标不推进；有删除时 daemon 发 `devices` SSE。已知：GoogleDrive 遇文件夹变更返回 reset 且 removedIds 为空时，当次不对账，下次带 removedIds 的拉取补上

## C. P2

- [x] **C1 Webhook 推送**：`packages/core/src/webhook/`；本机 `<dataDir>/webhook.json`（0600，不进 Drive）；仅主设备推 `reminder.issued`/`topic.created`/`topic.status_changed`/`topic.merged`；HMAC-SHA256 签名（`X-YouBrain-Signature: v1=…`）、退避 1m/5m/30m/2h/6h 共 6 次后放弃；`GET/PUT /api/webhook`、`POST /api/actions/webhook-test`；设置页「接入」下 Webhook 分区。未对真实 webhook 端点联调

## D. 验收与文档

- [x] **D1 M0 六项验证记录**：`scripts/m0/*`（`bun scripts/m0/<项>.ts`）；1/2/6 本机已跑（onnxruntime/sharp 在 vendor 与编译产物中可加载；.app 为 ad-hoc 签名且 `codesign --verify` 失败），3/5 需真实 Drive、4 需真实 CLI 额度，脚本已备未跑，结论写入 进度.md
- [ ] **D3 .app 整包 ad-hoc 签名**：D1 发现 `dist/app.noindex/you-brain.app` 只有链接器 ad-hoc 签名（Sealed Resources=none，`codesign --verify --deep --strict` 失败）；在 `bundle.sh` 末尾对整包 `codesign --force --deep -s -`，并让 `scripts/m0/desktop-package.ts` 通过（不做公证）
- [x] **D2 进度文档更新**：`进度.md`、`产品说明.md`、`技术方案.md` 的状态按现状更新（2026-10-23）；此后每完成一项仍同步更新对应行

## 需要你决定或配合（不进自动队列）

- [!] **P0 真实环境验收**：用真实 CLI、真实 Drive、真实模型走一遍「聊完 → 空闲 5 分钟 → 今日出现概要并归入话题 → 会话继续链接不变 → 新会话读到数字分身 → MCP 搜索到历史会话」。需要你的 Google 账号与模型配置
- [!] **LICENSE**：选 MIT 还是 Apache-2.0
- [!] **README 与 GitHub About**：仓库公开，需要对外说明
- [!] **官方 OAuth 受限范围审核**：属于向 Google 申请的流程，不是代码
- [!] **旧 `.orchestration` 提交历史是否改写**：公开仓库历史里留有编排文件，是否清理
- [!] **手机端**：产品说明第 10 节明确排除手机端采集，保持不做，除非你改变范围
