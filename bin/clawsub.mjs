#!/usr/bin/env node
import fs from "node:fs";
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

function printHelp() {
  console.log(`🦞 clawsub (openclaw-sub v0.1.0)
Run OpenClaw 24/7 on flat-rate AI subscriptions (Claude, Codex, Antigravity/Gemini) with $0 API bills.

Usage:
  clawsub init [--chain claude,codex,agy] [--workspace <path>] [--probe]
  clawsub status [--json]
  clawsub doctor [--json]
  clawsub run <prompt>
  clawsub exec <provider> [--] <prompt>
  clawsub test [--chain claude,codex,agy]
  clawsub reset [provider]
  clawsub help

Examples:
  npx openclaw-sub init --chain claude,codex,agy
  clawsub status
  clawsub doctor
  clawsub test
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

  console.log("🦞 clawsub — OpenClaw on Flat-Rate AI Subscriptions ($0 API Bill)\n");

  const oc = detectBinary("openclaw");
  console.log("[1/4] Checking OpenClaw installation...");
  if (oc.installed) {
    console.log(`  ✓ openclaw detected (${oc.version})`);
  } else {
    console.log("  ⚠ openclaw not found on PATH. Install via: npm install -g openclaw");
  }

  console.log("\n[2/4] Scanning Subscription CLIs...");
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

  console.log("\n[3/4] Writing Subscription-Saver Config & Cooldown Shims...");
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

  console.log(`  ✓ Config saved:   ${stateDir}/clawsub.json`);
  console.log(`  ✓ Profile saved:  ${integration.profilePath}`);
  console.log(`  ✓ Router shim:    ${integration.routerWrapperPath}`);
  for (const [id, shimPath] of Object.entries(integration.providerShims)) {
    console.log(`  ✓ Provider shim:  ${shimPath} (${id})`);
  }

  if (flags.probe) {
    console.log("\n[4/4] Running Live Verification Probes...");
    cmdTest({ chain: requestedChain.join(",") });
  } else {
    console.log("\n[4/4] Next Steps:");
    console.log("  • Run `clawsub test` to verify DIRECT_OK / FALLBACK_OK across your CLIs.");
    console.log("  • Run `clawsub status` anytime to inspect active cooldowns and reset times.");
    console.log("  • Run `openclaw onboard` if you haven't connected Telegram/Discord/WhatsApp yet.");
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

  console.log("🦞 clawsub status\n");
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

  console.log("🩺 clawsub doctor\n");
  console.log(
    `OpenClaw: ${
      report.openclaw.installed ? `✓ ${report.openclaw.version}` : "✗ not found on PATH"
    }`
  );
  for (const p of report.providers) {
    console.log(
      `Provider [${p.id}]: ${p.installed ? "✓ installed" : "✗ missing"} · ${
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

function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const subcmd = positional[0] || "help";

  if (subcmd === "help" || flags.help) {
    printHelp();
    return;
  }

  if (subcmd === "init") {
    cmdInit(flags);
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

  if (subcmd === "run") {
    const prompt = positional.slice(1).join(" ").trim() || readStdinIfPiped();
    if (!prompt) {
      console.error("Usage: clawsub run <prompt>");
      process.exit(1);
    }
    const res = routePrompt(prompt);
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
    const res = routePrompt(prompt, { onlyProvider: providerId });
    console.log(res.output);
    process.exit(res.ok ? 0 : 1);
  }

  console.error(`Unknown command: ${subcmd}`);
  printHelp();
  process.exit(1);
}

main();
