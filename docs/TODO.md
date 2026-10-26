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
- [x] **D3 .app 整包 ad-hoc 签名**：`tauri.bundle.conf.json` 设 macOS `signingIdentity: "-"`，Tauri 先签 `.app` 再打 DMG，`codesign --verify --deep --strict` 通过，DMG 内的包 CDHash 与外面一致；`bundle.sh` 留有复查失败时整包重签并重建 DMG 的兜底。未公证，`spctl` 拒绝是预期；未启动应用验证 sidecar 加载 vendor
- [x] **D2 进度文档更新**：`进度.md`、`产品说明.md`、`技术方案.md` 的状态按现状更新（2026-10-23）；此后每完成一项仍同步更新对应行

## F. 真实数据下暴露的问题（2026-10-25 ~ 26）

- [x] **F1 Codex 启动噪音**：Codex 每次启动写一份只含 `AGENTS.md` 注入的 JSONL，6735 个文件里只有 189 个真对话。统一 `isConversation` 判定并接入全部适配器；`scripts/cleanup-noise-sessions.ts` 清理历史（本机删 158 会话 / 34 空话题 / 327 事件）
- [x] **F2 话题活跃时间被提醒污染**：`reminder.action` 的 `touchUser` 让「忽略提醒」算成话题活跃，一次批量清理把 40 个话题刷成今天。拆出 `lastContentAt`（迁移 3），`countReminderActions` 显式选择口径
- [x] **F3 重启全量重扫**：采集指纹只在内存，重启重解析 9,596 个文件（7 分钟）。`capture.files` 持久化指纹 + 会话元数据，启动恢复；未变化的扫描结果要保留旧元数据否则下次恢复不出来
- [x] **F4 上传等模型**：`#uploadOne` 在 idle 时顺带提炼，一次上传 6 秒变 64 秒。上传与提炼解耦，上传移到独立循环
- [x] **F5 慢会话饿死其他**：批处理每次从第一个开始，慢会话占满预算。遍历起点轮转
- [x] **F6 提炼永久停摆**：两次静默超时把提炼永久停用，只能重启。改为暂停 + 指数退避
- [x] **F7 上传挤停变更流**：`lastSync` 停更十几分钟。tick 的 Drive 步骤期间 `#syncBusy`，上传让路
- [x] **F8 新增 Pi 与 T3 Code 采集**：Pi 读 `~/.pi/agent/sessions`，T3 读 `~/.t3/userdata/state.sqlite`（行式数据源，`import:` 会话跳过）
- [x] **F12 插件的半成品被当成会话**：浏览器插件先写 `.tmp` 再改名，中途的临时文件带 `text/markdown` 类型，被按类型判定当成会话，导致同一 `conversation_id` 出现两个文件。`drive/inbox-file.ts` 统一判定（跳过 `.` 开头与 `.tmp`），索引入口与收件箱队列都改用它；已清理索引里混入的 6 个片段
- [x] **F13 统计卡片点不了**：今日页四个数字块是纯 `div`，没有点击能力，看不出明细在哪。`StatBlock` 加 `onSelect`：今日会话滚到本页列表、涉及话题与待办跳话题册、同步跳状态页；状态页的索引文档跳搜索、沉淀跳设置；没有详情页的（待上传、提炼待处理）加 `title` 说明含义
- [x] **F14 部署脚本把目录装成嵌套的**：手写的 `cp -R src dest` 在目标已存在时会把 src 放进 dest，装几次后出现 `Resources/web/web/`、`Resources/vendor/vendor/`。新增 `scripts/install-app.ts`（先删再复制、重新签名、校验），`bun run install:app`
- [x] **F15 提醒占满今日页**：历史话题每周提醒对每个有未完成待办的话题各发一条，回灌后话题从 199 涨到 400+，一周产生 85 条，把今日会话挤到首屏之外。今日页提醒区默认只显示 2 条（可展开，展开后限高滚动）；`HISTORY_REMINDERS_PER_WEEK = 5`，按未完成待办数与最后活跃取前 5，其余由周回顾那一条承载
- [x] **F16 逐话题的历史提醒是噪音**：每个有未完成待办的历史话题每周各发一条，回灌后一周产生 86 条，其中 61 个是一年前的话题；用户明确不要这个机制。删掉逐条生成，改为周回顾里点名最多 3 个「90 天内活跃过且有待办」的话题，更早的只报数量；已发出的 `history` 提醒在读取时过滤，不改写事件日志
- [x] **F17 网页会话提炼排队不当**：`pendingWebSessions` 按最旧优先，2025-06 的网页会话排在前面，用户刚聊完的排到队尾；加上本机回灌 360 个占满唯一的 CLI 槽，网页提炼几乎不动。改成最新优先，并让回灌在网页队列非空时直接让路（回灌只是晚一点，网页会话是用户刚产生的）
- [x] **F18 回灌队列里大半是工具会话**：428 个待提炼里 307 个是 2026-09-27 的批量出图/审核会话（4-6 条消息、毫秒级间隔、已提炼的标题是「仙侠头肩近景3:4图编辑」这类）。按用户决定把提炼窗口从 30 天收到 7 天：只提炼最近 7 天，原文仍全量上传并可搜索
- [x] **F19 话题册里单会话老话题太多**：601 个话题里 503 个只有 1 个会话且 7 天未活跃（多是「XX-front 贡献指南与代码审查」这类一次性审查）。新增 `scripts/archive-stale-topics.ts`（默认只报告，`--apply` 执行）：通过 `topic.status_changed {by: "auto"}` 事件标记为已完成，待办不动。执行后进行中 600 → 97，已完成 504
- [x] **F20 搜索慢（11-12 秒）**：三个原因——①搜索时无条件 `sync({budgetMs:3000})`，索引已就绪也在跑；②本地结果已满仍去 Drive 全文搜索并逐个下载原文（约 5 秒）；③`#rank` 全表 `SELECT` 143,965 行且把 `text` 一起读出来（约 187MB），FTS 一次命中 27,476 行也全量处理。改为：索引就绪时不同步、本地结果够就跳过 Drive、评分阶段不取 text（只取前 N 条）、FTS 按 bm25 取前 500。热态 11-12 秒 → 3.3 秒
- [ ] **F21 搜索仍有 3 秒**：剩余开销是 `#rank` 的 `LEFT JOIN` 全表（143,965 行，其中 124,185 行没有向量）加查询嵌入推理。可拆成「有向量的 INNER JOIN（19,780 行）算语义 + FTS 前 500 补关键词」两组候选
- [ ] **F9 历史回灌的进度可见性**：`upload.pending` 与 `capture.parsed` 已在 `/api/status`，界面还没有展示；欠账大时用户看不出在跑
- [ ] **F10 pull 在大量上传后变慢**：一次 pull 约 2-3 分钟，因为要消化自己刚上传的数百个变更；与上传分时后能跑，但 `lastSync` 周期仍是 2 分钟而非 1 分钟
- [ ] **F11 网页会话队列消化慢**：`web.pending` 长期在 200 上下，每个会话一次模型调用

## E. 后续功能（不在第一期，第一期以当前功能为主）

- [!] **E1 知识库（Obsidian vault）**：作为会话之外的第二类数字资产接入，术语见 `CONTEXT.md`
  - 已定：只读接入，可搜索、可供 MCP 查询，并作为数字分身的蒸馏输入；不进会话提炼和话题册。按目录或标签设纳入范围（包含/排除）；每天只喂纳入范围内当天新增或修改的笔记，首次接入时分批回灌。只在电脑和服务器之间复制，手机暂不接入。必须满足接力：任意时刻一台设备在线即可，A 编辑后关机、B 开机就能看到最新内容
  - 倾向：vault 走 Google Drive 中转，不用 Syncthing（Syncthing 要满足接力就必须有一台 7×24 在线的 VPS）
  - 未定：①前提验证：M0 第 3 项（Drive 服务端是否拒绝过期 `If-Match`，`scripts/m0/drive-etag.ts`）、第 5 项（`changes.list` 延迟，`scripts/m0/drive-changes.ts`），跑完才能确认 Drive 方案成立 ②冲突处理（倾向 Markdown 三方合并，合不了再保留两份）③改名、移动、删除的传播 ④`.obsidian/` 配置目录和附件是否复制 ⑤"有改动未上传"的关机前提示 ⑥日记类每天修改的笔记是否只喂新增部分 ⑦vault 复制的正式名称（不与现有的"同步"混用）

## 需要你决定或配合（不进自动队列）

- [!] **P0 真实环境验收**：已在真实 Drive 与真实模型上跑通采集 → 上传 → 提炼 → 话题册（见进度.md「真实环境实跑记录」）。仍未逐条走：会话继续后链接不变且内容更新、新会话读到编码版数字分身、MCP 搜索历史会话
- [!] **LICENSE**：选 MIT 还是 Apache-2.0
- [~] **README 与 GitHub About**：`README.md` 已补（2026-10-26）；GitHub About 与截图仍需你补
- [!] **官方 OAuth 受限范围审核**：属于向 Google 申请的流程，不是代码
- [!] **旧 `.orchestration` 提交历史是否改写**：公开仓库历史里留有编排文件，是否清理
- [!] **手机端**：产品说明第 10 节明确排除手机端采集，保持不做，除非你改变范围
