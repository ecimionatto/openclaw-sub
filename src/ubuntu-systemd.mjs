import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function escapeSystemdPath(str) {
  return str.replace(/%/g, "%%");
}

function escapeSystemdEnvValue(str) {
  return str.replace(/%/g, "%%").replace(/ /g, "\\x20");
}

export function generateSystemdService({ workspace, nodeBinDir } = {}) {
  const resolvedNodeBinDir = path.resolve(nodeBinDir || path.dirname(process.execPath));
  const resolvedWorkspace = path.resolve(workspace || process.cwd());

  const escapedWorkspace = escapeSystemdPath(resolvedWorkspace);
  const escapedNodeBinDir = escapeSystemdEnvValue(resolvedNodeBinDir);

  const content = `[Unit]
Description=OpenClaw + clawsub subscription manager
After=network.target

[Service]
Type=simple
WorkingDirectory=${escapedWorkspace}
Environment="PATH=${escapedNodeBinDir}:/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/env openclaw gateway
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  return {
    content,
    serviceName: "openclaw-sub",
    suggestedPath: path.join(os.homedir(), ".config", "systemd", "user", "openclaw-sub.service"),
  };
}

export function installSystemdService({ workspace, nodeBinDir, dryRun = false, enable = false, homeDir, runner } = {}) {
  const { content } = generateSystemdService({ workspace, nodeBinDir });
  const resolvedHome = homeDir || os.homedir();
  const serviceDir = path.join(resolvedHome, ".config", "systemd", "user");
  const servicePath = path.join(serviceDir, "openclaw-sub.service");

  let username;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER || process.env.LOGNAME || "ubuntu";
  }

  const lingerInstructions = [
    `loginctl enable-linger ${username}`,
    "systemctl --user daemon-reload",
    "systemctl --user enable openclaw-sub",
    "systemctl --user start openclaw-sub",
  ];

  if (dryRun) {
    return { ok: true, dryRun: true, servicePath, content, lingerInstructions };
  }

  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(servicePath, content, { mode: 0o644 });

  const enableResult = { reloaded: false, enabled: false, errors: [] };
  if (enable) {
    const shellRun = runner || ((cmd) => execSync(cmd, { stdio: "pipe" }));
    try {
      shellRun("systemctl --user daemon-reload");
      enableResult.reloaded = true;
    } catch (err) {
      enableResult.errors.push(`daemon-reload failed: ${err.message}`);
    }
    try {
      shellRun("systemctl --user enable openclaw-sub");
      enableResult.enabled = true;
    } catch (err) {
      enableResult.errors.push(`enable openclaw-sub failed: ${err.message}`);
    }
  }

  return { ok: true, dryRun: false, servicePath, content, lingerInstructions, enable, enableResult };
}
