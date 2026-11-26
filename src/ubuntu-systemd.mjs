import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAWSUB_BIN = path.resolve(__dirname, "../bin/clawsub.mjs");

export function generateSystemdService({ workspace, nodeBinDir } = {}) {
  const resolvedNodeBinDir = nodeBinDir || path.dirname(process.execPath);
  const resolvedWorkspace = workspace || process.cwd();

  const content = `[Unit]
Description=OpenClaw + clawsub subscription manager
After=network.target

[Service]
Type=simple
WorkingDirectory=${resolvedWorkspace}
Environment="PATH=${resolvedNodeBinDir}:/usr/local/bin:/usr/bin:/bin"
ExecStart=${resolvedNodeBinDir}/node ${CLAWSUB_BIN} run
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

export function installSystemdService({ workspace, nodeBinDir, dryRun = false, enable = false, homeDir } = {}) {
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

  return { ok: true, dryRun: false, servicePath, content, lingerInstructions, enable };
}
