# 任务 W1-E：授权与密钥 + 客户端接入 + BrainHub 接管（core/auth、core/clients、core/migrate）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
你**只能**修改：packages/core/src/auth/**、packages/core/src/clients/**、packages/core/src/migrate/**、对应的 packages/core/test/{auth,clients,migrate}/**、以及仓库根目录 skills/**（新建）。
可以 import（只读）：@you-brain/protocol、packages/core/src/domain。

## 要求
1. auth（技术方案 15、17）：搬运参考实现 src/auth/*（google-oauth、oauth-loopback、secret-store、platform-secrets、secret-store-factory、google-account、account-status、official-oauth-client）。
   - Scope 改为完整 drive 权限。refresh token 只存钥匙串（macOS `security` 命令 / Linux secret-tool），服务名改为 you-brain。
   - 新增"用户自带 OAuth 凭据"（clientId/clientSecret）：clientId 存本地配置，clientSecret 存钥匙串。
   - 测试模式 refresh token 7 天过期：识别 invalid_grant，返回"需要重新登录"状态。
   - 模型 API Key 存取：`you-brain/llm/<provider>`。
   - 测试中钥匙串一律用内存实现，不要真的调用 security 命令写入。
2. clients（技术方案 10.2、13.2）：
   - 搬运 src/clients/*（registry、skills、auto-install），检测本机客户端（Claude Code、Codex、Grok Build、Cursor、Gemini CLI），MCP 注册命令改为 `you-brain mcp`，条目名 `you-brain`。
   - **托管段落注入**：实现通用函数 upsertManagedBlock / removeManagedBlock，标记 `<!-- you-brain:start v1 -->` … `<!-- you-brain:end -->`；只替换标记间内容；文件不存在则新建；删除后若文件为空且原本不存在则删除文件（需记录"原本不存在"的状态）；版本号或措辞变化时自动更新。
   - 各 CLI 目标文件与写入内容严格按 10.2 的表格：Claude Code `~/.claude/CLAUDE.md` 写 `@~/.you-brain/portrait/coding.md`；Codex/Gemini/Grok 写强制读取指令（Grok 注意 1 万字符上限，只写指令）；Cursor 不写，返回可复制的文本。
   - 所有用户主目录路径必须可注入（测试用临时 HOME），绝不触碰真实配置。
   - 提供 plan → apply 两段式 API：plan 列出将要修改的文件及 diff 预览，apply 只对用户勾选的项生效；uninstall 只删除自己写入的内容。
3. skills/：新建 `skills/you-brain-portrait/SKILL.md`（10.3：指导 AI 需要时调用 MCP get_portrait 或读 ~/.you-brain/portrait/full.md）和 `skills/you-brain/SKILL.md`（今日、话题、搜索的使用方式，参考 BrainHub plugins/ 下现有 skill 的写法）。这是产品交付物，允许编写。
4. migrate（技术方案 16）：检测 BrainHub（配置目录 `~/Library/Application Support/brainhub-mcp/` 或 XDG、launchd plist / systemd timer、各客户端 MCP 配置中的 brainhub 条目）；plan 展示；停用时先备份再卸载定时任务、移除 MCP 条目；读取 BrainHub 的 Drive 根目录和设备 ID 作为默认值；restore 从备份还原。所有 launchctl/systemctl 调用通过可注入的命令执行器，测试中用 fake。

## 验收
`cd packages/core && bun test test/auth test/clients test/migrate` 全部通过；tsc 无你负责文件的错误。
