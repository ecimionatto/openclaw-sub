import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS, defaultCommandRunner, detectBinary } from "./providers.mjs";
import { getDefaultStateDir } from "./state.mjs";

export const CLAWSUB_VERSION = "0.3.0";

/**
 * Known-good compatible version matrix and npm package names.
 */
export const VERSION_MATRIX = {
  clawsub: {
    version: CLAWSUB_VERSION,
    minNode: "18.0.0",
    recommendedNode: "22.0.0",
  },
  openclaw: {
    package: "openclaw",
    binary: "openclaw",
    recommendedTrack: "latest",
  },
  providers: {
    claude: {
      package: "@anthropic-ai/claude-code",
      binary: "claude",
      recommendedTrack: "latest",
    },
    codex: {
      package: "@openai/codex",
      binary: "codex",
      recommendedTrack: "latest",
    },
    gemini: {
      package: "@google/gemini-cli",
      binary: "gemini",
      recommendedTrack: "latest",
    },
  },
};

export function getVersionHistoryPath(stateDir = getDefaultStateDir()) {
  return path.join(stateDir, "clawsub-versions.json");
}

/**
 * Inspects current installed versions of Node, OpenClaw, and all subscription CLIs.
 */
export function getInstalledVersions() {
  const openclaw = detectBinary("openclaw");
  const providers = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    let bin = detectBinary(p.binary);
    if (!bin.installed && p.altBinary) {
      bin = detectBinary(p.altBinary);
    }
    providers[id] = {
      installed: bin.installed,
      binary: bin.binary,
      version: bin.version,
    };
  }
  return {
    clawsub: CLAWSUB_VERSION,
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    openclaw: {
      installed: openclaw.installed,
      version: openclaw.version,
    },
    providers,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Records a version snapshot before installing or upgrading so the user can inspect history or roll back.
 */
export function recordVersionSnapshot(stateDir = getDefaultStateDir(), label = "snapshot") {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = getVersionHistoryPath(stateDir);
  let history = { current: null, snapshots: [] };
  try {
    history = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // fresh file
  }
  const snap = {
    label,
    ...getInstalledVersions(),
  };
  history.current = snap;
  history.snapshots = [snap, ...(history.snapshots || [])].slice(0, 20);
  fs.writeFileSync(file, JSON.stringify(history, null, 2) + "\n", "utf8");
  return snap;
}

/**
 * Installs the `clawsub` SKILL.md into an OpenClaw / Antigravity workspace so the agent itself
 * can check quota cooldowns, reorder providers, run doctor checks, and upgrade OpenClaw.
 *
 * @param {{
 *   workspace?: string,
 *   skillSourcePath?: string,
 * }} [opts]
 */
export function installSkill(opts = {}) {
  const workspace = opts.workspace || process.cwd();
  const defaultSource = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../skills/clawsub/SKILL.md"
  );
  const sourcePath = opts.skillSourcePath || defaultSource;
  const content = fs.readFileSync(sourcePath, "utf8");

  // Install into both OpenClaw (`skills/clawsub/SKILL.md`) and Antigravity/Claude (`.agents/skills/clawsub/SKILL.md`)
  const targets = [
    path.join(workspace, "skills", "clawsub", "SKILL.md"),
    path.join(workspace, ".agents", "skills", "clawsub", "SKILL.md"),
  ];

  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }

  return {
    installedPaths: targets,
  };
}

/**
 * Builds or runs the Ubuntu installation commands for OpenClaw + subscription CLIs.
 *
 * @param {{
 *   openclawVersion?: string,
 *   providers?: string[],
 *   dryRun?: boolean,
 *   runner?: Function,
 * }} [opts]
 */
export function installOpenClawUbuntu(opts = {}) {
  const ver = opts.openclawVersion || "latest";
  const providers = opts.providers || [];
  const dryRun = Boolean(opts.dryRun);
  const runner = opts.runner || defaultCommandRunner;

  const npmPackages = [`openclaw@${ver}`];
  for (const p of providers) {
    const entry = VERSION_MATRIX.providers[p];
    if (entry?.package) {
      npmPackages.push(`${entry.package}@${entry.recommendedTrack}`);
    }
  }

  const steps = [
    {
      description: `Install OpenClaw (${ver})${
        providers.length ? ` + CLIs (${providers.join(", ")})` : ""
      }`,
      command: "npm",
      args: ["install", "-g", ...npmPackages],
    },
  ];

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      npmPackages,
      commands: steps.map((s) => `${s.command} ${s.args.join(" ")}`),
    };
  }

  const results = [];
  for (const step of steps) {
    const res = runner({
      command: step.command,
      args: step.args,
    });
    results.push({
      ...step,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    });
    if (res.exitCode !== 0) {
      return {
        ok: false,
        npmPackages,
        results,
      };
    }
  }

  return {
    ok: true,
    npmPackages,
    results,
  };
}
