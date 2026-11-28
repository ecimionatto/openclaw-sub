import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function escapeSystemdEnvValue(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/ /g, "\\x20");
}

function resolveCommandDir(cmd, shellRun) {
  try {
    const loc = shellRun(`which ${cmd}`);
    if (loc && loc.trim()) return path.dirname(loc.trim());
  } catch {}
  return null;
}

export function resolvePATHDirs({ nodeBinDir, homeDir, runner } = {}) {
  const shellRun = runner || ((cmd) => execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim());
  const resolvedHome = homeDir || os.homedir();
  const resolvedNodeBinDir = path.resolve(nodeBinDir || path.dirname(process.execPath));

  const dirs = [];

  for (const tool of ["claude", "codex", "agy", "gemini"]) {
    const d = resolveCommandDir(tool, shellRun);
    if (d) dirs.push(d);
  }

  dirs.push(path.join(resolvedHome, ".local", "bin"));

  try {
    const npmPrefix = shellRun("npm config get prefix");
    if (npmPrefix && npmPrefix.trim()) dirs.push(path.join(npmPrefix.trim(), "bin"));
  } catch {}

  dirs.push(resolvedNodeBinDir);
  dirs.push("/usr/local/bin", "/usr/bin", "/bin");

  const seen = new Set();
  return dirs.filter((d) => { if (seen.has(d)) return false; seen.add(d); return true; });
}

export function generateSystemdService({ nodeBinDir, homeDir, runner, checkGateway = true } = {}) {
  const resolvedHome = homeDir || os.homedir();
  const pathDirs = resolvePATHDirs({ nodeBinDir, homeDir: resolvedHome, runner });
  const escapedPath = pathDirs.map(escapeSystemdEnvValue).join(":");

  const content = `[Service]\nEnvironment="PATH=${escapedPath}"\n`;

  const gatewayServicePath = path.join(resolvedHome, ".config", "systemd", "user", "openclaw-gateway.service");
  const legacyServicePath = path.join(resolvedHome, ".config", "systemd", "user", "openclaw-sub.service");
  const suggestedPath = path.join(
    resolvedHome, ".config", "systemd", "user", "openclaw-gateway.service.d", "clawsub.conf"
  );

  const gatewayServiceMissing = checkGateway && !fs.existsSync(gatewayServicePath);
  const legacyServiceExists = fs.existsSync(legacyServicePath);

  return {
    content,
    dropInName: "clawsub.conf",
    suggestedPath,
    gatewayServicePath,
    gatewayServiceMissing,
    legacyServicePath,
    legacyServiceExists,
  };
}

export function installSystemdService({
  nodeBinDir,
  dryRun = false,
  enable = false,
  migrate = false,
  homeDir,
  runner,
  envGetter,
  checkGateway = true,
} = {}) {
  const resolvedHome = homeDir || os.homedir();
  const shellRun = runner || ((cmd) => execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim());
  const getEnv = envGetter || ((k) => process.env[k]);

  const { content, suggestedPath, gatewayServiceMissing, legacyServicePath, legacyServiceExists } =
    generateSystemdService({ nodeBinDir, homeDir: resolvedHome, runner: shellRun, checkGateway });

  const warnings = [];
  const xdgRuntimeDir = getEnv("XDG_RUNTIME_DIR");
  if (!xdgRuntimeDir) warnings.push("XDG_RUNTIME_DIR is not set — systemd --user services may not start correctly");

  let lingerEnabled = null;
  let username;
  try {
    username = os.userInfo().username;
  } catch {
    username = getEnv("USER") || getEnv("LOGNAME") || "ubuntu";
  }

  try {
    const lingerOutput = shellRun(`loginctl show-user ${username} -p Linger`);
    lingerEnabled = lingerOutput ? /Linger=yes/i.test(lingerOutput) : null;
  } catch {
    lingerEnabled = null;
  }

  if (lingerEnabled === false) {
    warnings.push(`Linger is disabled for ${username} — run: loginctl enable-linger ${username}`);
  }

  const lingerInstructions = [
    `loginctl enable-linger ${username}`,
    "systemctl --user daemon-reload",
    "systemctl --user restart openclaw-gateway",
  ];

  if (gatewayServiceMissing) {
    return {
      ok: false,
      gatewayServiceMissing: true,
      message: "openclaw-gateway.service not found — run: openclaw gateway install",
      servicePath: suggestedPath,
      content,
      lingerInstructions,
      lingerEnabled,
      warnings,
      legacyServiceExists,
      legacyServicePath,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      servicePath: suggestedPath,
      content,
      lingerInstructions,
      lingerEnabled,
      warnings,
      legacyServiceExists,
      legacyServicePath,
    };
  }

  const dropInDir = path.dirname(suggestedPath);
  fs.mkdirSync(dropInDir, { recursive: true });
  fs.writeFileSync(suggestedPath, content, { mode: 0o644 });

  const enableResult = { reloaded: false, restarted: false, errors: [] };
  if (enable) {
    try {
      shellRun("systemctl --user daemon-reload");
      enableResult.reloaded = true;
    } catch (err) {
      enableResult.errors.push(`daemon-reload failed: ${err.message}`);
    }
    try {
      shellRun("systemctl --user restart openclaw-gateway");
      enableResult.restarted = true;
    } catch (err) {
      enableResult.errors.push(`restart openclaw-gateway failed: ${err.message}`);
    }
  }

  const migrateResult = { disabled: false, stopped: false, errors: [] };
  if (migrate && legacyServiceExists) {
    try {
      shellRun("systemctl --user disable openclaw-sub");
      migrateResult.disabled = true;
    } catch (err) {
      migrateResult.errors.push(`disable openclaw-sub failed: ${err.message}`);
    }
    try {
      shellRun("systemctl --user stop openclaw-sub");
      migrateResult.stopped = true;
    } catch (err) {
      migrateResult.errors.push(`stop openclaw-sub failed: ${err.message}`);
    }
  }

  return {
    ok: true,
    dryRun: false,
    servicePath: suggestedPath,
    content,
    lingerInstructions,
    lingerEnabled,
    warnings,
    enable,
    enableResult,
    legacyServiceExists,
    legacyServicePath,
    migrate,
    migrateResult: migrate ? migrateResult : undefined,
  };
}
