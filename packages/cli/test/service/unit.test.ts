import { describe, expect, it } from "bun:test";

import { daemonLogPath, SERVICE_LABEL, serviceLogHint, serviceUnitPath, SYSTEMD_UNIT } from "../../src/service/paths.js";
import {
  buildProgram,
  collectServiceEnv,
  isBunExecutable,
  renderLaunchdPlist,
  renderSystemdUnit,
} from "../../src/service/unit.js";

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.you-brain.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/you-brain</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/tester</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/Users/tester/Library/Application Support/you-brain/logs/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/tester/Library/Application Support/you-brain/logs/daemon.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/tester</string>
  </dict>
</dict>
</plist>
`;

const plistEscaped = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.you-brain.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/my &amp; &lt;app&gt;/you-brain</string>
    <string>say &quot;hi&quot; &apos;now&apos;</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/a&lt;b&gt;</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/var/log/a&amp;b.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/a&amp;b.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>a&amp;b&lt;c&gt;d&quot;e&apos;f</string>
  </dict>
</dict>
</plist>
`;

const systemd = `[Unit]
Description=you-brain daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="/usr/local/bin/you-brain" "daemon"
Restart=on-failure
RestartSec=5
Environment="PATH=/usr/bin:/bin"
Environment="HOME=/home/tester"
WorkingDirectory="/home/tester"
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;

const systemdEscaped = `[Unit]
Description=you-brain daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="/opt/my app/bin" "a\\"b$$c%%d\\\\e"
Restart=on-failure
RestartSec=5
Environment="PATH=/opt/$$bin & %%s"
WorkingDirectory="/home/user/my dir"
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;

describe("service unit text", () => {
  it("renders a launchd plist", () => {
    expect(
      renderLaunchdPlist({
        label: SERVICE_LABEL,
        program: ["/usr/local/bin/you-brain", "daemon"],
        env: { PATH: "/usr/bin:/bin", HOME: "/Users/tester" },
        logFile: "/Users/tester/Library/Application Support/you-brain/logs/daemon.log",
        workingDirectory: "/Users/tester",
      }),
    ).toBe(plist);
  });

  it("escapes xml in the plist", () => {
    expect(
      renderLaunchdPlist({
        label: SERVICE_LABEL,
        program: ["/opt/my & <app>/you-brain", `say "hi" 'now'`],
        env: { PATH: `a&b<c>d"e'f` },
        logFile: "/var/log/a&b.log",
        workingDirectory: "/Users/a<b>",
      }),
    ).toBe(plistEscaped);
  });

  it("renders a systemd user unit", () => {
    expect(
      renderSystemdUnit({
        program: ["/usr/local/bin/you-brain", "daemon"],
        env: { PATH: "/usr/bin:/bin", HOME: "/home/tester" },
        workingDirectory: "/home/tester",
      }),
    ).toBe(systemd);
  });

  it("quotes systemd arguments and env values", () => {
    expect(
      renderSystemdUnit({
        program: ["/opt/my app/bin", `a"b$c%d\\e`],
        env: { PATH: "/opt/$bin & %s" },
        workingDirectory: "/home/user/my dir",
      }),
    ).toBe(systemdEscaped);
  });

  it("builds the compiled binary and the bun dev command", () => {
    expect(
      buildProgram({
        execPath: "/usr/local/bin/you-brain",
        entry: "/ignored/index.ts",
        isBun: false,
      }),
    ).toEqual(["/usr/local/bin/you-brain", "daemon"]);
    expect(
      buildProgram({
        execPath: "/usr/local/bin/bun",
        entry: "/proj/packages/cli/src/index.ts",
        isBun: true,
      }),
    ).toEqual(["/usr/local/bin/bun", "/proj/packages/cli/src/index.ts", "daemon"]);
    expect(isBunExecutable("/usr/local/bin/bun")).toBe(true);
    expect(isBunExecutable("/opt/node/lib/node_modules/bun/bin/bun.exe")).toBe(true);
    expect(isBunExecutable("/usr/local/bin/you-brain")).toBe(false);
    expect(() =>
      buildProgram({ execPath: "/usr/local/bin/bun", entry: "  ", isBun: true }),
    ).toThrow("入口脚本路径");
  });

  it("keeps only the service env whitelist and drops blanks", () => {
    expect(
      collectServiceEnv({
        PATH: "/usr/bin:/bin",
        HOME: "/Users/tester",
        YOU_BRAIN_DATA_DIR: "/data",
        YOU_BRAIN_HOME: "/out",
        YOU_BRAIN_WEB_DIR: "/web",
        YOU_BRAIN_MODEL_CACHE: "/models",
        YOU_BRAIN_TOKEN: "secret",
        OPENAI_API_KEY: "sk-test",
        YOU_BRAIN_MODEL_CACHE_UNUSED: "",
        EMPTY: "",
      }),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/tester",
      YOU_BRAIN_DATA_DIR: "/data",
      YOU_BRAIN_HOME: "/out",
      YOU_BRAIN_WEB_DIR: "/web",
      YOU_BRAIN_MODEL_CACHE: "/models",
    });
    expect(
      Object.keys(
        collectServiceEnv({
          YOU_BRAIN_WEB_DIR: "   ",
          YOU_BRAIN_MODEL_CACHE: "",
          HOME: "/Users/tester",
          PATH: "/bin",
        }),
      ),
    ).toEqual(["PATH", "HOME"]);
  });

  it("points at the same startup files uninstall removes", () => {
    expect(SERVICE_LABEL).toBe("com.you-brain.daemon");
    expect(SYSTEMD_UNIT).toBe("you-brain.service");
    expect(serviceUnitPath("darwin", "/Users/a")).toBe(
      "/Users/a/Library/LaunchAgents/com.you-brain.daemon.plist",
    );
    expect(serviceUnitPath("linux", "/home/a")).toBe(
      "/home/a/.config/systemd/user/you-brain.service",
    );
    expect(daemonLogPath("/data")).toBe("/data/logs/daemon.log");
    expect(serviceLogHint("darwin", "/data")).toBe("/data/logs/daemon.log");
    expect(serviceLogHint("linux", "/data")).toBe(
      "journalctl --user -u you-brain.service -f",
    );
  });
});
