# 任务 W8b：W8 验收返工（codex 错误误判、移除 kimi-cli、daemon 传 dataDir 与具体状态）

先阅读 /Users/john/private/ai/you-brain/.orchestration/COMMON.md 并遵守。
W8 的改动尚未提交，`git diff` 和 `git status` 可见（packages/core/src/llm/cli/** 等）。在其基础上修改。
可修改：packages/protocol/src/config.ts、packages/core/src/llm/**、packages/core/src/daemon/daemon.ts（只改模型创建和状态相关部分）、packages/cli/src/setup.ts、apps/web/src/lib/format.ts、apps/web/src/pages/settings.tsx、对应测试。
bun 1.3.11 路径：`~/.local/share/fnm/node-versions/v22.15.0/installation/bin/bun`（PATH 已加好）。

## 1. codex 错误被当成正常输出（严重）
主控复现：本机 codex 配置的模型对 ChatGPT 账号不可用时，`codex exec` **退出码 0**，stdout/stderr 打印
```
[...] stream error: unexpected status 400 Bad Request: {"detail":"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."}; retrying 1/5 …
[...] ERROR: unexpected status 400 Bad Request: {"detail":"..."}
Warning: no last agent message; wrote empty content to <last-message 文件>
```
`--output-last-message` 文件为空。现在的 codex driver 在文件为空时回退读 stdout，把错误日志当成模型回复，`test()` 也因此误判成功。

修复：
- codex 的 last-message 文件为空时，**不要回退到 stdout**；改为从 stdout+stderr 中找 `ERROR:` 行或 `no last agent message`，抛 `LlmRequestError`。消息形如「codex 调用失败：The 'xxx' model is not supported when using Codex with a ChatGPT account.（可在模型名里指定该账号支持的模型）」。400 类不可重试（`client`），401/403 归 `auth`，429/5xx/网络归可重试类别（按现有 LlmRequestError 类别命名）。
- 逐个检查其他 driver 有没有同类的「退出码 0 但实际失败」回退路径（grok、claude、gemini、opencode），一并修。
- `test()` 不能只判断非空：至少要求输出不是错误文本。可以让连接测试对 cli 类走一次带极简 schema 的 complete 并校验结构，或用等价方式。
- 用假 CLI 复现上面这段输出写测试。

## 2. 移除 kimi-cli
kimi 的 `-p` 模式会自动批准工具调用，且无法关闭。沉淀的输入是用户会话原文，存在提示注入后执行命令的风险，不上线。
- 从 `LLM_PROVIDERS`、presets、drivers、locate、setup、设置页和所有测试里删干净（`git grep -n kimi-cli` 应无结果；`kimi` 作为普通 API provider 保留）。

## 3. daemon 传 dataDir、状态给出具体原因
- `packages/core/src/daemon/daemon.ts` 的 `#createLlm`：把 daemon 实际使用的 dataDir 传给 `createLlmBackend`（需要的话给 options 加 `dataDir` 并透传到 CLI 后端）。
- 创建失败时保留错误原因。状态里不要统一显示「未配置模型」：
  - 缺 API Key → 保持现有 `LLM_NOT_CONFIGURED` 文案。
  - cli 类找不到可执行文件 → 新 code（如 `LLM_CLI_MISSING`），文案「未找到 xxx 命令行，已上传会话但跳过提炼」。
  - cli 类未登录 → 「xxx 未登录，已上传会话但跳过提炼。请运行 <登录命令>」。
- 检查 Web 状态页/CLI `status` 对未知 code 的展示，确保新 code 显示正常（只改展示映射，不改布局）。
- 补 daemon 测试：注入不存在的 CLI 路径，状态出现新 code，daemon 不崩、不无限重试。

## 4. 验证
- 全量 `bun test`，protocol/core/cli/web 的 tsc 通过。
- 真机：用本机真实 codex 跑一次后端 `test()`，必须**失败**并给出上面的清楚原因（本机 codex 配置的模型不可用）。再用 `-m` 指定一个 ChatGPT 账号可用的模型试一次（自己从 `codex --help` 或报错信息判断，试 1–2 个即可，不行就记录）。grok-cli、claude-cli、opencode-cli 各再跑一次 `test()` 确认没被改坏。
- 完成后 `bun run build:daemon`，并用 `apps/desktop/scripts/bundle.sh` 重新打包 app。

## 报告
按 COMMON.md 的报告格式。写完报告后立即退出，不要等待任何后台任务。

## 5. 补充：cli 类默认不指定模型
所有 cli 类 preset 的默认模型改为空字符串（不传 `-m`，用 CLI 自己的默认模型）。原因：grok 的模型目录偶发返回 "unknown model id"，写死模型名会让沉淀无故失败。用户在模型名里填了值才传。
