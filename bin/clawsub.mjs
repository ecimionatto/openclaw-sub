#!/usr/bin/env node
import fs from "node:fs";
import {
  getSessionBaton,
  loadBatonStore,
  saveBatonStore,
  syncNativeTranscripts,
} from "../src/baton.mjs";
import { generateOpenClawIntegration, runDoctor } from "../src/openclaw-config.mjs";
import { PROVIDERS, detectBinary, inspectProvider } from "../src/providers.mjs";
import { routePrompt } from "../src/router.mjs";
import {
  getDefaultStateDir,
  getProviderCooldown,
  loadConfig,
  loadState,
  saveConfig,
  saveState,
} from "../src/state.mjs";
import {
  CLAWSUB_VERSION,
  getInstalledVersions,
  installOpenClawUbuntu,
  installSkill,
  recordVersionSnapshot,
} from "../src/versions.mjs";

function printHelp() {
  console.log(`🦞 clawsub (openclaw-sub v${CLAWSUB_VERSION})
Run OpenClaw 24/7 on flat-rate AI subscriptions (Claude, Codex, Antigravity/Gemini) with $0 API bills.

Usage:
  clawsub init [--chain claude,codex,agy] [--workspace <path>] [--install-openclaw] [--openclaw-version <ver>] [--install-skill] [--probe]
  clawsub install-ubuntu [--openclaw-version <ver>] [--chain claude,codex,agy] [--dry-run]
  clawsub install-skill [--workspace <path>]
  clawsub version [--json]
  clawsub status [--json]
  clawsub baton [--session <key>] [--clear] [--sync] [--json]
  clawsub doctor [--json]
  clawsub run [--session <key>] <prompt>
  clawsub exec <provider> [--session <key>] [--] <prompt>
  clawsub test [--chain claude,codex,agy]
  clawsub reset [provider]
  clawsub help

Examples:
  curl -fsSL https://raw.githubusercontent.com/ecimionatto/openclaw-sub/main/scripts/install-ubuntu.sh | bash
  npx openclaw-sub init --chain claude,codex,agy --install-openclaw --install-skill --probe
  clawsub version
  clawsub status
  clawsub doctor
`);
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-v") {
      flags.version = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function readStdinIfPiped() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function cmdInit(flags) {
  const stateDir = getDefaultStateDir();
  const existing = loadConfig(stateDir);
  const requestedChain = flags.chain
    ? String(flags.chain)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : existing.chain || ["claude", "codex", "agy"];

  const workspace = flags.workspace || existing.workspace || process.cwd();
  const openclawVersion = flags["openclaw-version"] || "latest";

  console.log(`🦞 clawsub v${CLAWSUB_VERSION} — OpenClaw on Flat-Rate AI Subscriptions ($0 API Bill)\n`);

  let oc = detectBinary("openclaw");
  console.log("[1/5] Checking OpenClaw installation...");
  if (oc.installed && !flags["install-openclaw"]) {
    console.log(`  ✓ openclaw detected (${oc.version})`);
  } else if (flags["install-openclaw"]) {
    console.log(`  ⬇ Installing openclaw@${openclawVersion}...`);
    recordVersionSnapshot(stateDir, "pre-install-openclaw");
    const inst = installOpenClawUbuntu({
      openclawVersion,
      dryRun: Boolean(flags["dry-run"]),
    });
    if (inst.ok) {
      oc = detectBinary("openclaw");
      console.log(`  ✓ openclaw@${openclawVersion} installed (${oc.version || "ready"})`);
    } else {
      console.log(`  ✗ Failed to install openclaw@${openclawVersion}`);
    }
  } else {
    console.log(
      "  ⚠ openclaw not found on PATH. Re-run with `--install-openclaw` or run `scripts/install-ubuntu.sh`."
    );
  }

  console.log("\n[2/5] Scanning Subscription CLIs...");
  const inspected = requestedChain.map((id) => inspectProvider(id));
  for (const p of inspected) {
    const binBadge = p.installed ? "✓" : "✗";
    const authBadge = p.authenticated ? "logged in" : "needs login";
    console.log(
      `  ${binBadge} ${p.id.padEnd(7)} (${p.name}) — ${
        p.installed ? `${p.version} · ${authBadge}` : `missing (install: ${p.installHint})`
      }`
    );
  }

  const readyCount = inspected.filter((p) => p.installed && p.authenticated).length;
  if (readyCount === 1 && !requestedChain.includes("agy") && !requestedChain.includes("ollama")) {
    console.log(
      "\n  💡 Tip: You have 1 paid subscription CLI configured. Add `agy` (Google Gemini/Antigravity free tier) or `ollama` via `--chain claude,agy` for automatic $0 failover when your 5-hour quota window hits."
    );
  }

  console.log("\n[3/5] Writing Subscription-Saver Config, Cooldown Shims & Version Snapshot...");
  const saved = saveConfig(
    {
      ...existing,
      chain: requestedChain,
      workspace,
    },
    stateDir
  );
  const integration = generateOpenClawIntegration({
    stateDir,
    chain: saved.chain,
    workspace: saved.workspace,
  });
  const snap = recordVersionSnapshot(stateDir, "init");

  console.log(`  ✓ Config saved:     ${stateDir}/clawsub.json`);
  console.log(`  ✓ Profile saved:    ${integration.profilePath}`);
  console.log(`  ✓ Version snapshot: ${stateDir}/clawsub-versions.json (clawsub v${snap.clawsub})`);
  console.log(`  ✓ Router shim:      ${integration.routerWrapperPath}`);
  for (const [id, shimPath] of Object.entries(integration.providerShims)) {
    console.log(`  ✓ Provider shim:    ${shimPath} (${id})`);
  }

  console.log("\n[4/5] Agent Skill (SKILL.md)...");
  if (flags["install-skill"] !== false) {
    const sk = installSkill({ workspace });
    for (const p of sk.installedPaths) {
      console.log(`  ✓ Installed skill:  ${p}`);
    }
  } else {
    console.log("  • Skipped skill install (run `clawsub install-skill` anytime)");
  }

  if (flags.probe) {
    console.log("\n[5/5] Running Live Verification Probes...");
    cmdTest({ chain: requestedChain.join(",") });
  } else {
    console.log("\n[5/5] Next Steps:");
    console.log("  • Run `clawsub test` to verify DIRECT_OK / FALLBACK_OK across your CLIs.");
    console.log("  • Run `clawsub status` or `clawsub version` anytime.");
    console.log("  • Run `openclaw onboard` if you haven't connected Telegram/Discord/WhatsApp yet.");
  }
}

function cmdInstallUbuntu(flags) {
  const stateDir = getDefaultStateDir();
  const openclawVersion = flags["openclaw-version"] || "latest";
  const chain = flags.chain
    ? String(flags.chain)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : ["claude", "codex", "agy"];
  const dryRun = Boolean(flags["dry-run"]);

  recordVersionSnapshot(stateDir, "pre-install-ubuntu");
  const res = installOpenClawUbuntu({
    openclawVersion,
    providers: flags["with-clis"] ? chain : [],
    dryRun,
  });

  if (dryRun) {
    console.log("🦞 clawsub install-ubuntu (dry-run)\n");
    for (const c of res.commands) {
      console.log(`  $ ${c}`);
    }
    return;
  }

  if (!res.ok) {
    console.error("✗ Ubuntu OpenClaw installation failed.");
    process.exit(1);
  }

  recordVersionSnapshot(stateDir, "post-install-ubuntu");
  console.log(`✓ Installed: ${res.npmPackages.join(", ")}`);
}

function cmdInstallSkill(flags) {
  const stateDir = getDefaultStateDir();
  const config = loadConfig(stateDir);
  const workspace = flags.workspace || config.workspace || process.cwd();
  const res = installSkill({ workspace });
  console.log("🦞 Installed clawsub SKILL.md:");
  for (const p of res.installedPaths) {
    console.log(`  ✓ ${p}`);
  }
}

function cmdVersion(flags) {
  const versions = getInstalledVersions();
  if (flags.json) {
    console.log(JSON.stringify(versions, null, 2));
    return;
  }
  console.log(`🦞 clawsub v${versions.clawsub} (${versions.platform}, node ${versions.node})\n`);
  console.log(
    `OpenClaw:  ${
      versions.openclaw.installed ? `✓ ${versions.openclaw.version}` : "✗ not installed"
    }`
  );
  console.log("Providers:");
  for (const [id, info] of Object.entries(versions.providers)) {
    console.log(
      `  • ${id.padEnd(7)} (${info.binary}): ${
        info.installed ? `✓ ${info.version}` : "✗ not installed"
      }`
    );
  }
}

function cmdStatus(flags) {
  const stateDir = getDefaultStateDir();
  const config = loadConfig(stateDir);
  const state = loadState(stateDir);
  const now = new Date();

  const rows = (config.chain || []).map((id, idx) => {
    const info = inspectProvider(id);
    const cd = getProviderCooldown(state, id, now);
    const pState = state.providers?.[id] || {};
    return {
      role: idx === 0 ? "primary" : `fallback-#${idx}`,
      id,
      name: info.name,
      subscription: info.subscription,
      version: info.version,
      installed: info.installed,
      authenticated: info.authenticated,
      status: cd.coolingDown
        ? `cooling_down (resets ${cd.until}, ~${cd.remainingMinutes}m)`
        : info.installed && info.authenticated
        ? "ready"
        : "not_ready",
      lastLatencyMs: pState.lastLatencyMs ?? null,
    };
  });

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          clawsubVersion: CLAWSUB_VERSION,
          chain: config.chain,
          workspace: config.workspace,
          lastActiveProvider: state.lastActiveProvider,
          quietWindows: config.quietWindows,
          quotaReservationWindows: config.quotaReservationWindows,
          providers: rows,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`🦞 clawsub status (v${CLAWSUB_VERSION})\n`);
  console.log(`Chain:               ${(config.chain || []).join(" -> ")}`);
  console.log(`Workspace:           ${config.workspace}`);
  console.log(`Last Active CLI:     ${state.lastActiveProvider || "(none yet)"}`);
  console.log(`Quiet Windows:       ${(config.quietWindows || []).join(", ") || "none"}`);
  console.log(`Quota Reservation:   ${(config.quotaReservationWindows || []).join(", ") || "none"}\n`);
  console.log("Providers:");
  for (const r of rows) {
    const latency = r.lastLatencyMs ? ` (${r.lastLatencyMs}ms)` : "";
    console.log(`  • [${r.role}] ${r.id} (${r.subscription}): ${r.status}${latency}`);
  }
}

function cmdDoctor(flags) {
  const report = runDoctor();
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log(`🩺 clawsub doctor (v${CLAWSUB_VERSION})\n`);
  console.log(
    `OpenClaw: ${
      report.openclaw.installed ? `✓ ${report.openclaw.version}` : "✗ not found on PATH"
    }`
  );
  for (const p of report.providers) {
    console.log(
      `Provider [${p.id}]: ${p.installed ? `✓ ${p.version}` : "✗ missing"} · ${
        p.authenticated ? "✓ authenticated" : "✗ not logged in"
      } · ${p.headlessSafe ? "✓ headless-safe" : "⚠ check headless settings"}`
    );
  }

  if (report.issues.length > 0) {
    console.log("\nIssues:");
    for (const issue of report.issues) {
      console.log(`  ✗ ${issue}`);
    }
  }

  if (report.recommendations.length > 0) {
    console.log("\nRecommendations:");
    for (const rec of report.recommendations) {
      console.log(`  💡 ${rec}`);
    }
  }

  if (report.ok) {
    console.log("\n✅ All checks passed!");
  } else {
    process.exitCode = 1;
  }
}

function cmdTest(flags) {
  const stateDir = getDefaultStateDir();
  const config = loadConfig(stateDir);
  const chain = flags.chain
    ? String(flags.chain)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : config.chain || ["claude", "codex", "agy"];

  console.log(`🧪 Testing subscription CLI chain: ${chain.join(" -> ")}\n`);
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    const token = i === 0 ? `${id.toUpperCase()}_DIRECT_OK` : `${id.toUpperCase()}_FALLBACK_OK`;
    const info = inspectProvider(id);
    if (!info.installed || !info.authenticated) {
      console.log(`  ⚠ [${id}] skipped (${!info.installed ? "not installed" : "not logged in"})`);
      continue;
    }
    const res = routePrompt(`reply with exactly: ${token}`, {
      stateDir,
      onlyProvider: id,
    });
    const matched = res.ok && res.output.includes(token);
    if (matched) {
      console.log(`  ✓ [${id}] -> ${token} (${res.latencyMs}ms)`);
    } else {
      console.log(`  ✗ [${id}] probe failed: ${res.output.slice(0, 160)}`);
    }
  }
}

function cmdReset(targetProvider) {
  const stateDir = getDefaultStateDir();
  const state = loadState(stateDir);
  if (targetProvider) {
    delete state.providers[targetProvider];
    saveState(state, stateDir);
    console.log(`✓ Cleared cooldown state for ${targetProvider}`);
  } else {
    state.providers = {};
    saveState(state, stateDir);
    console.log("✓ Cleared cooldown state for all providers");
  }
}

function cmdBaton(flags) {
  const stateDir = getDefaultStateDir();
  const store = loadBatonStore(stateDir);
  const sessionKey = typeof flags.session === "string" ? flags.session : "main";

  if (flags.clear) {
    delete store.sessions[sessionKey];
    saveBatonStore(store, stateDir);
    console.log(`✓ Cleared shared session baton for session '${sessionKey}'`);
    return;
  }

  if (flags.sync) {
    const result = syncNativeTranscripts(store, { sessionKey });
    saveBatonStore(store, stateDir);
    console.log(`✓ Synced native CLI transcripts into baton (${result.imported} turn pairs imported)`);
    return;
  }

  const session = getSessionBaton(store, sessionKey);
  if (flags.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(`🦞 clawsub baton (session: ${sessionKey})\n`);
  console.log(`Total Turns:         ${session.turnCounter}`);
  console.log(`Last Active Model:   ${session.lastProvider || "(none)"}`);
  console.log(
    `Provider Watermarks: ${
      Object.entries(session.lastSeenTurnByProvider)
        .map(([k, v]) => `${k}=#${v}`)
        .join(", ") || "(none)"
    }`
  );
  if (session.pendingMidTurnHandoff) {
    console.log(
      `Pending Handoff:     ⚠ Mid-turn credit exhaustion from ${session.pendingMidTurnHandoff.failedProvider} at ${session.pendingMidTurnHandoff.failedAt}`
    );
  }
  if (session.turns.length > 0) {
    console.log("\nRecent Shared Turns:");
    for (const t of session.turns.slice(-5)) {
      console.log(`  • [#${t.turnId} via ${t.provider}] ${t.prompt.slice(0, 80)}`);
    }
  }
}

function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  if (flags.version && positional.length === 0) {
    console.log(CLAWSUB_VERSION);
    return;
  }

  const subcmd = positional[0] || "help";

  if (subcmd === "help" || flags.help) {
    printHelp();
    return;
  }

  if (subcmd === "version") {
    cmdVersion(flags);
    return;
  }

  if (subcmd === "init") {
    cmdInit(flags);
    return;
  }

  if (subcmd === "install-ubuntu") {
    cmdInstallUbuntu(flags);
    return;
  }

  if (subcmd === "install-skill") {
    cmdInstallSkill(flags);
    return;
  }

  if (subcmd === "status") {
    cmdStatus(flags);
    return;
  }

  if (subcmd === "doctor") {
    cmdDoctor(flags);
    return;
  }

  if (subcmd === "test") {
    cmdTest(flags);
    return;
  }

  if (subcmd === "reset") {
    cmdReset(positional[1]);
    return;
  }

  if (subcmd === "baton") {
    cmdBaton(flags);
    return;
  }

  if (subcmd === "run") {
    const prompt = positional.slice(1).join(" ").trim() || readStdinIfPiped();
    if (!prompt) {
      console.error("Usage: clawsub run [--session <key>] <prompt>");
      process.exit(1);
    }
    const sessionKey = typeof flags.session === "string" ? flags.session : "main";
    const res = routePrompt(prompt, { sessionKey });
    console.log(res.output);
    process.exit(res.ok ? 0 : 1);
  }

  if (subcmd === "exec") {
    const providerId = positional[1];
    if (!providerId || !PROVIDERS[providerId]) {
      console.error(`Usage: clawsub exec <${Object.keys(PROVIDERS).join("|")}> [--] <prompt>`);
      process.exit(1);
    }
    const prompt = positional.slice(2).join(" ").trim() || readStdinIfPiped();
    if (!prompt) {
      console.error(`Usage: clawsub exec ${providerId} <prompt>`);
      process.exit(1);
    }
    const sessionKey = typeof flags.session === "string" ? flags.session : "main";
    const res = routePrompt(prompt, { onlyProvider: providerId, sessionKey });
    console.log(res.output);
    process.exit(res.ok ? 0 : 1);
  }

  console.error(`Unknown command: ${subcmd}`);
  printHelp();
  process.exit(1);
}

main();
