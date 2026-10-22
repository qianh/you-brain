import { basename } from "node:path";

/** 编译产物的 execPath 是 you-brain 本体；开发时是 bun，入口要单独传。 */
export function isBunExecutable(execPath: string): boolean {
  return /^bun(\.exe)?$/u.test(basename(execPath));
}

export function buildProgram(input: { execPath: string; entry: string; isBun: boolean }): string[] {
  if (input.isBun) {
    if (input.entry.trim() === "") {
      throw new Error("bun 开发形态需要入口脚本路径");
    }
    return [input.execPath, input.entry, "daemon"];
  }
  return [input.execPath, "daemon"];
}

const SERVICE_ENV_KEYS = [
  "PATH",
  "HOME",
  "YOU_BRAIN_DATA_DIR",
  "YOU_BRAIN_HOME",
  "YOU_BRAIN_WEB_DIR",
  "YOU_BRAIN_MODEL_CACHE",
] as const;

/**
 * 只保留服务启动需要的环境。空白视为空。不带 key、secret、token。
 * PATH 给 launchd 的极简默认路径补上用户安装的模型 CLI。
 */
export function collectServiceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of SERVICE_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    selected[key] = value;
  }
  return selected;
}

export function renderLaunchdPlist(input: {
  label: string;
  program: string[];
  env: Record<string, string>;
  logFile: string;
  workingDirectory: string;
}): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xmlEscape(input.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...input.program.map((argument) => `    <string>${xmlEscape(argument)}</string>`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xmlEscape(input.workingDirectory)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(input.logFile)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(input.logFile)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
  ];
  for (const [key, value] of Object.entries(input.env)) {
    lines.push(`    <key>${xmlEscape(key)}</key>`);
    lines.push(`    <string>${xmlEscape(value)}</string>`);
  }
  lines.push(`  </dict>`, `</dict>`, `</plist>`);
  return `${lines.join("\n")}\n`;
}

export function renderSystemdUnit(input: {
  program: string[];
  env: Record<string, string>;
  workingDirectory: string;
}): string {
  const lines = [
    `[Unit]`,
    `Description=you-brain daemon`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${input.program.map((argument) => systemdQuote(argument)).join(" ")}`,
    `Restart=on-failure`,
    `RestartSec=5`,
  ];
  for (const [key, value] of Object.entries(input.env)) {
    lines.push(`Environment=${systemdQuote(`${key}=${value}`)}`);
  }
  lines.push(
    `WorkingDirectory=${systemdQuote(input.workingDirectory)}`,
    `KillSignal=SIGTERM`,
    `TimeoutStopSec=15`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
  );
  return `${lines.join("\n")}\n`;
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** systemd 字面量：先转义反斜杠和引号，再把 % 写成 %%、$ 写成 $$。 */
export function systemdQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    // replaceAll 的替换串里 $$ 只表示一个 $，所以要写四次。
    .replaceAll("$", "$$$$");
  return `"${escaped}"`;
}
