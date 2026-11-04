# ADR-0002：派活给本机 GUI App 走通用桥（辅助功能 API 投递 + 采集适配器回收）

状态：已接受（2026-10-31）；2026-11-03 起桥的调用方改为 dsh 插件 `u-brain-bridge`；2026-11-04 投递改为静默（见文末「修订」）。

## 背景

用户要求把任务丢进 Grok Bot、Muse 这类本机 GUI App，由它们（各自的多模型编排）完成任务。核实（2026-10-31）：两家都没有「接受第三方派任务」的公开接口——Grok Bot 的 deep link 仅有 MCP OAuth 回调路由、不监听本地端口；Muse 仅支持作为 MCP 宿主连远程 connector。候选通道：等官方 API、X 上交互、桌面 UI 自动化。

## 决策

建一座**通用 GUI App 桥**，作为第四类执行者：

- **投递**：macOS 辅助功能 API（Accessibility）定位 App 输入框，粘入任务、回车。需要用户给 you-brain 授「辅助功能」权限，授权须明示用途。
- **回收**：采集适配器读 App 本地落盘的会话数据（Grok Bot 待探明：`Local Storage/leveldb`、`shared_proto_db`、`sand-client-persistence`），与七个 CLI 来源同一适配器模式；AX 读窗口内容为兜底。
- X 上的交互只作桥断时的兜底通道；官方 API 出现后替换投递端。
- 一座桥管所有本机 GUI App（Grok Bot、Muse、未来的任何 App），不做每家定制集成。

## 后果

- 与「直接操作、不跳回原应用」的产品哲学一致；派活侧与采集侧合流——回收的对话既是任务结果又是数字资产。
- 代价：App 改版会打断选择器，需要兜底与修复机制；无回调，结果靠轮询采集；辅助功能权限是敏感授权。
- Grok Bot / Muse 定位为「编排者」，本决策不寻求它们被程序化编排的正规接口；该接口出现即迁移。

## 修订（2026-11-04）：静默投递

原实现是“写剪贴板 → 激活 App → 全局 Cmd+V + 回车”，会打断用户，覆盖剪贴板；App 窗口没开时按键还可能落进别的 App。

- **投递**：用辅助功能 API 直接写输入框的值，再用 `CGEventPostToPid` 把回车只发给目标进程，不激活窗口，不走全局键盘和剪贴板。不用 AXPress 按发送按钮：Grok Bot 的按钮收到后不会提交（实测）。回车要落在输入框上，而 App 在后台时写 `AXFocused` 不生效（实测），所以同样用只发给该进程的 Tab 把窗口内的光标移到输入框。以输入框被清空作为“已发出”的依据；不看本地会话文件，它有落盘延迟，会造成误报和重复发送。
- **做不到就报错**：不退回按键模拟。输入框已有内容时也停止，不覆盖用户草稿。
- **窗口没开**：从 App 的 Window 菜单打开；如果 App 因此到了前台，再把焦点还回去。
- **Muse 当前做不到静默**：Muse 10.0 的输入框包在 `role="button"` 的容器里（`data-hatch-composer-chrome`），WebKit 不向辅助功能暴露按钮的子元素，所以投递会报错。Muse 改版后如果暴露出来，桥会自动可用。

Muse Gadget SDK（`facebookincubator/muse-gadget-sdk`）提供 `send-user-msg --session-id --wait`，但配对依赖 Linux BlueZ。用户要求在 Mac 上直接使用，因此不采用。
