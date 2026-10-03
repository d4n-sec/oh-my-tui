import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ServiceArtifact {
  path: string;
  contents: string;
  instructions: string[];
}

function cliEntry(): string {
  const entry = process.argv[1] ?? "";
  try {
    return fs.realpathSync(entry);
  } catch {
    return entry;
  }
}

export function renderService(): ServiceArtifact {
  const entry = cliEntry();
  const user = os.userInfo().username;

  if (process.platform === "darwin") {
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    const file = path.join(dir, "com.oh-my-tui.terminal-agent.plist");
    const extraCa = process.env.NODE_EXTRA_CA_CERTS
      ? `\n    <key>NODE_EXTRA_CA_CERTS</key>\n    <string>${escapeXml(process.env.NODE_EXTRA_CA_CERTS)}</string>`
      : "";
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.oh-my-tui.terminal-agent</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(process.execPath)}</string>
      <string>${escapeXml(entry)}</string>
      <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>${extraCa}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(os.homedir(), "Library", "Logs", "terminal-agent.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(os.homedir(), "Library", "Logs", "terminal-agent.err.log"))}</string>
  </dict>
</plist>
`;
    return {
      path: file,
      contents,
      instructions: [
        `launchctl load -w "${file}"`,
        "注意：LaunchAgent 依赖用户登录，注销后不会运行。",
      ],
    };
  }

  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  const file = path.join(dir, "terminal-agent.service");
  const extraCa = process.env.NODE_EXTRA_CA_CERTS
    ? `Environment=NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}\n`
    : "";
  const contents = `[Unit]
Description=Oh-My-TUI terminal-agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${entry} start
${extraCa}Restart=on-failure
RestartSec=5
# Runs as the current user (${user}); no root privileges are required.

[Install]
WantedBy=default.target
`;
  return {
    path: file,
    contents,
    instructions: [
      "systemctl --user daemon-reload",
      "systemctl --user enable --now terminal-agent",
      `如需开机即运行（无登录）：sudo loginctl enable-linger ${user}`,
    ],
  };
}

export function installService(): ServiceArtifact {
  const artifact = renderService();
  fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
  fs.writeFileSync(artifact.path, artifact.contents, { mode: 0o644 });
  return artifact;
}

export function uninstallService(): { path: string; removed: boolean } {
  const artifact = renderService();
  if (fs.existsSync(artifact.path)) {
    fs.rmSync(artifact.path, { force: true });
    return { path: artifact.path, removed: true };
  }
  return { path: artifact.path, removed: false };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
