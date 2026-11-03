import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { locateCliBinary, type CliProvider } from "../../llm/cli/locate.js";

/**
 * 指挥台自带的 DSH 插件目录：把本机 CLI 作为 dsh 的子代理提供者挂进去。
 * 新增一个 CLI / 一类插件 = 往这里加一条，补丁文件由 renderDshPatch 统一生成。
 * 目录之外的任意 dsh 插件走用户补丁（`<dataDir>/deck/dsh/user.patch.yml`）。
 */
export type DshCliPlugin =
  | {
      id: string;
      title: string;
      cli: CliProvider;
      /** dsh 官方提供的原生子代理包。 */
      kind: "native";
      pkg: string;
      /** 该子代理的原生载荷所在的包（scope 与前缀）；打包时可能被裁掉，缺失就不挂载。 */
      payload: { scope: string; prefix: string };
      provider: string;
      toolName: string;
    }
  | {
      id: string;
      title: string;
      cli: CliProvider;
      /** 经 ACP（Agent Client Protocol）起子进程。 */
      kind: "acp";
      args: readonly string[];
      toolName: string;
    };

export const DSH_CLI_PLUGINS: readonly DshCliPlugin[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    cli: "claude-cli",
    kind: "native",
    pkg: "@deepseek-ai/dsh-subagent-claude-code",
    payload: { scope: "@anthropic-ai", prefix: "claude-agent-sdk-" },
    provider: "claude-code",
    toolName: "subagent_claude_code",
  },
  {
    id: "codex",
    title: "Codex",
    cli: "codex-cli",
    kind: "native",
    pkg: "@deepseek-ai/dsh-subagent-codex",
    payload: { scope: "@openai", prefix: "codex-" },
    provider: "codex",
    toolName: "subagent_codex",
  },
  // ACP 入口已在本机核对：`gemini --acp`、`opencode acp`。grok 的 ACP 入口未核实，暂不接。
  { id: "gemini", title: "Gemini CLI", cli: "gemini-cli", kind: "acp", args: ["--acp"], toolName: "subagent_gemini" },
  { id: "opencode", title: "opencode", cli: "opencode-cli", kind: "acp", args: ["acp"], toolName: "subagent_opencode" },
];

export interface DshPluginStatus {
  id: string;
  title: string;
  /** 本机 CLI 路径；null = 没装，不挂载。 */
  bin: string | null;
}

/** 原生子代理的载荷是否在 sidecar 里（打包时为控制体积会裁掉）。未给 sidecarDir 时不检查。 */
function payloadPresent(plugin: DshCliPlugin, sidecarDir: string | undefined): boolean {
  if (plugin.kind !== "native" || sidecarDir === undefined) return true;
  const dir = join(sidecarDir, "node_modules", plugin.payload.scope);
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => name.startsWith(plugin.payload.prefix));
  } catch {
    return false;
  }
}

export function detectDshPlugins(options: {
  homeDir: string;
  sidecarDir?: string;
  env?: NodeJS.ProcessEnv;
}): DshPluginStatus[] {
  return DSH_CLI_PLUGINS.map((plugin) => {
    const found = locateCliBinary({
      provider: plugin.cli,
      homeDir: options.homeDir,
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    if (found === null || !payloadPresent(plugin, options.sidecarDir)) return { id: plugin.id, title: plugin.title, bin: null };
    return { id: plugin.id, title: plugin.title, bin: stablePath(found) };
  });
}

/** fnm/nvm 的 shell 临时目录会随会话消失，写进补丁要用真实路径。 */
function stablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface RenderDshPatchInput {
  /** detectDshPlugins 的结果：只挂载 bin 非 null 的。 */
  plugins: readonly DshPluginStatus[];
  /** 把 you-brain 的 MCP（搜索、话题、分身…）挂给 dsh；缺省不挂。 */
  mcp?: { command: string; args: readonly string[]; env?: Record<string, string> } | undefined;
  /** 随 App 带的本地 dsh 插件：`path` 是模块文件的绝对路径，或 sidecar 里的包名，按 `name: <值>` 加载。 */
  localPlugins?: ReadonlyArray<{ id: string; path: string }> | undefined;
  /** 自有品牌包的包名：给了就禁用官方品牌包（行 id `ui-brand-official`）并挂上它；缺省保留 DeepSeek 品牌。 */
  brandPlugin?: string | undefined;
  /** llm-pi-ai 的 providers 配置（整体替换该行的 config）；缺省不动。 */
  piAiProviders?: Record<string, unknown> | null | undefined;
}

const yaml = (value: string): string => JSON.stringify(value);

/** 生成 dsh 的 cordis.patch.yml 文本（只含 insert 行）。 */
export function renderDshPatch(input: RenderDshPatchInput): string {
  const rows: string[] = [];
  const mounted = new Set(input.plugins.filter((item) => item.bin !== null).map((item) => item.id));
  for (const plugin of DSH_CLI_PLUGINS) {
    if (!mounted.has(plugin.id)) continue;
    const bin = input.plugins.find((item) => item.id === plugin.id)?.bin ?? "";
    if (plugin.kind === "native") {
      rows.push(
        `    - id: subagent-${plugin.id}`,
        `      name: ${yaml(plugin.pkg)}`,
      );
    } else {
      rows.push(
        `    - id: subagent-${plugin.id}`,
        `      name: ${yaml("@deepseek-ai/dsh-subagent-acp")}`,
        "      config:",
        `        providerName: ${yaml(plugin.id)}`,
        `        command: ${yaml(bin)}`,
        `        args: [${plugin.args.map(yaml).join(", ")}]`,
        "        permission: reject",
      );
    }
    rows.push(
      `    - id: tool-subagent-${plugin.id}`,
      `      name: ${yaml("@deepseek-ai/dsh-tool-subagent")}`,
      "      config:",
      `        provider: ${yaml(plugin.kind === "native" ? plugin.provider : plugin.id)}`,
      `        toolName: ${yaml(plugin.toolName)}`,
      "        maxDepth: provider-managed",
    );
  }
  for (const plugin of input.localPlugins ?? []) {
    rows.push(`    - id: ${plugin.id}`, `      name: ${yaml(plugin.path)}`);
  }
  if (input.mcp !== undefined) {
    rows.push(
      "    - id: mcp-you-brain",
      `      name: ${yaml("@deepseek-ai/dsh-mcp-client")}`,
      "      config:",
      "        serverName: youbrain",
      "        transport: stdio",
      `        command: ${yaml(input.mcp.command)}`,
      `        args: [${input.mcp.args.map(yaml).join(", ")}]`,
    );
    const env = Object.entries(input.mcp.env ?? {});
    if (env.length > 0) {
      rows.push("        env:", ...env.map(([key, value]) => `          ${key}: ${yaml(value)}`));
    }
  }
  const parts: string[] = [];
  if (rows.length > 0) parts.push(`- insert:\n${rows.join("\n")}\n`);
  if (input.brandPlugin !== undefined) {
    // 补丁只能改行的字段、不能换包名，所以禁用官方行再插入自有行。
    parts.push(`- id: ui-brand-official\n  disabled: true\n`);
    parts.push(`- insert:\n    - id: ui-brand-u-brain\n      name: ${yaml(input.brandPlugin)}\n`);
  }
  if (input.piAiProviders) {
    // JSON 是合法的 YAML 流式写法，字符串转义由 JSON.stringify 保证。
    parts.push(`- id: llm-pi-ai\n  config: ${JSON.stringify({ providers: input.piAiProviders })}\n`);
  }
  return parts.length === 0 ? "[]\n" : parts.join("");
}
