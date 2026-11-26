import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAWSUB_VERSION,
  computeCooldownUntil,
  computeSavings,
  findActiveTimeWindow,
  generateOpenClawIntegration,
  getInstalledVersions,
  getProviderCooldown,
  installOpenClawUbuntu,
  installSkill,
  isHeartbeatPrompt,
  isQuotaError,
  parseResetTime,
  PROVIDER_PRICING,
  recordTurnSavings,
  recordVersionSnapshot,
  routePrompt,
  runDoctor,
} from "../src/index.mjs";
import { inspectOpenClawJson } from "../src/openclaw-config.mjs";

test("isQuotaError detects Claude 5-hour/weekly limits, Codex 429s, and Gemini ResourceExhausted", () => {
  assert.equal(isQuotaError('{"type":"result","error":"usage_limit_reached: resets 6:50pm"}'), true);
  assert.equal(isQuotaError("You've hit your 5-hour limit. Resets at 10:00pm."), true);
  assert.equal(isQuotaError("You've hit your weekly limit. Resets Nov 28, 10:00am."), true);
  assert.equal(isQuotaError("Error: HTTP 429 Too Many Requests"), true);
  assert.equal(isQuotaError("GoogleGenerativeAIError: ResourceExhausted: Quota exceeded"), true);
  assert.equal(isQuotaError("Normal assistant response with 200 OK"), false);
});

test("parseResetTime parses same-day, next-day, multi-day date, and relative durations", () => {
  const now = new Date(2026, 10, 25, 16, 0);

  // 1. Same-day time in future ("resets 6:50pm")
  const sameDay = parseResetTime("hit your 5-hour limit, resets 6:50pm", now);
  assert.ok(sameDay);
  assert.equal(sameDay.getHours(), 18);
  assert.equal(sameDay.getMinutes(), 50);
  assert.equal(sameDay.getDate(), 25);

  // 2. Next-day roll when reset hour is earlier than current time ("resets 2am" seen at 4pm)
  const nextDay = parseResetTime("usage_limit_reached: resets 2:15am", now);
  assert.ok(nextDay);
  assert.equal(nextDay.getHours(), 2);
  assert.equal(nextDay.getMinutes(), 15);
  assert.equal(nextDay.getDate(), 26);

  // 3. Multi-day weekly limit ("resets Nov 28, 10:00am")
  const multiDay = parseResetTime("You've hit your weekly limit. Resets Nov 28, 10:00am", now);
  assert.ok(multiDay);
  assert.equal(multiDay.getMonth(), 10); // November
  assert.equal(multiDay.getDate(), 28);
  assert.equal(multiDay.getHours(), 10);
  assert.equal(multiDay.getMinutes(), 0);

  // 4. Relative duration ("try again in 45 minutes")
  const rel = parseResetTime("Rate limit reached, try again in 45 minutes", now);
  assert.ok(rel);
  assert.equal(rel.getTime() - now.getTime(), 45 * 60_000);
});

test("computeCooldownUntil adds safety buffer to parsed reset time or falls back to default", () => {
  const now = new Date(2026, 10, 25, 16, 0);
  const withReset = computeCooldownUntil("resets 6:50pm", { now, bufferMinutes: 5 });
  assert.equal(withReset.getHours(), 18);
  assert.equal(withReset.getMinutes(), 55);

  const fallback = computeCooldownUntil("HTTP 429 rate_limit_error", {
    now,
    defaultMinutes: 60,
  });
  assert.equal(fallback.getTime() - now.getTime(), 60 * 60_000);
});

test("routePrompt fails over from claude -> codex on 5-hour quota limit and fast-skips claude on next turn", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  const now = new Date(2026, 10, 25, 16, 0);
  const config = {
    chain: ["claude", "codex", "agy"],
    workspace: tmpDir,
    defaultCooldownMinutes: 60,
    cooldownBufferMinutes: 5,
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const state = { providers: {} };

  const calls = [];
  const mockRunner = ({ command }) => {
    calls.push(command);
    if (command === "claude") {
      return {
        exitCode: 1,
        stdout: '{"type":"result","error":"usage_limit_reached: resets 6:50pm"}',
        stderr: "",
        latencyMs: 120,
      };
    }
    if (command === "codex") {
      return {
        exitCode: 0,
        stdout: "CODEX_FALLBACK_OK",
        stderr: "",
        latencyMs: 340,
      };
    }
    return { exitCode: 0, stdout: "AGY_FALLBACK_OK", stderr: "", latencyMs: 250 };
  };

  // Turn 1: tries claude -> hits limit -> records cooldown -> succeeds on codex
  const res1 = routePrompt("Hello world", {
    stateDir: tmpDir,
    config,
    state,
    now,
    runner: mockRunner,
  });

  assert.equal(res1.ok, true);
  assert.equal(res1.provider, "codex");
  assert.equal(res1.output, "CODEX_FALLBACK_OK");
  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(getProviderCooldown(state, "claude", now).coolingDown, true);

  // Turn 2 (5 minutes later): 0ms fast-skip on claude -> goes straight to codex!
  calls.length = 0;
  const fiveMinLater = new Date(now.getTime() + 5 * 60_000);
  const res2 = routePrompt("Second turn", {
    stateDir: tmpDir,
    config,
    state,
    now: fiveMinLater,
    runner: mockRunner,
  });

  assert.equal(res2.ok, true);
  assert.equal(res2.provider, "codex");
  assert.deepEqual(calls, ["codex"]); // claude was never spawned!
  assert.equal(res2.attempts[0].status, "skipped_cooldown");
});

test("routePrompt pauses heartbeats during quota reservation windows and when all CLIs are cooling down", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-hb-"));
  const morningStandupWindow = new Date(2026, 10, 25, 7, 30);
  const config = {
    chain: ["claude", "codex"],
    workspace: tmpDir,
    quietWindows: ["23:00-08:00"],
    quotaReservationWindows: ["06:30-08:45"],
  };
  const state = { providers: {} };

  const hbPrompt = "[OpenClaw heartbeat poll]\nIf nothing needs attention, reply NO_REPLY.";
  assert.equal(isHeartbeatPrompt(hbPrompt), true);

  let runnerCalled = false;
  const resQuiet = routePrompt(hbPrompt, {
    stateDir: tmpDir,
    config,
    state,
    now: morningStandupWindow,
    runner: () => {
      runnerCalled = true;
      return { exitCode: 0, stdout: "OK", stderr: "", latencyMs: 10 };
    },
  });

  assert.equal(resQuiet.ok, true);
  assert.equal(resQuiet.output, "NO_REPLY");
  assert.equal(runnerCalled, false);

  // Outside quiet window, when all providers are in cooldown:
  // - Heartbeat returns NO_REPLY
  // - Direct user message returns earliest reset notice
  const afternoon = new Date(2026, 10, 25, 15, 0);
  state.providers = {
    claude: {
      status: "cooldown",
      cooldownUntil: new Date(afternoon.getTime() + 30 * 60_000).toISOString(),
    },
    codex: {
      status: "cooldown",
      cooldownUntil: new Date(afternoon.getTime() + 90 * 60_000).toISOString(),
    },
  };

  const resHbCooldown = routePrompt(hbPrompt, {
    stateDir: tmpDir,
    config,
    state,
    now: afternoon,
  });
  assert.equal(resHbCooldown.ok, true);
  assert.equal(resHbCooldown.output, "NO_REPLY");
  assert.equal(resHbCooldown.allCoolingDown, true);

  const resUserCooldown = routePrompt("Can you summarize today's commits?", {
    stateDir: tmpDir,
    config,
    state,
    now: afternoon,
  });
  assert.equal(resUserCooldown.ok, false);
  assert.equal(resUserCooldown.allCoolingDown, true);
  assert.match(resUserCooldown.output, /Earliest reset: claude/);
});

test("findActiveTimeWindow handles daytime and overnight windows", () => {
  assert.equal(
    findActiveTimeWindow(["23:00-08:00"], new Date(2026, 10, 25, 23, 30)),
    "23:00-08:00"
  );
  assert.equal(
    findActiveTimeWindow(["23:00-08:00"], new Date(2026, 10, 25, 6, 15)),
    "23:00-08:00"
  );
  assert.equal(
    findActiveTimeWindow(["23:00-08:00"], new Date(2026, 10, 25, 14, 0)),
    null
  );
});

test("generateOpenClawIntegration writes executable router and provider shims", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-gen-"));
  const out = generateOpenClawIntegration({
    stateDir: tmpDir,
    chain: ["claude", "codex", "agy"],
    workspace: tmpDir,
  });
  assert.equal(fs.existsSync(out.profilePath), true);
  assert.equal(fs.existsSync(out.routerWrapperPath), true);
  assert.equal(fs.existsSync(out.providerShims.claude), true);
  assert.equal(fs.existsSync(out.providerShims.codex), true);
  assert.equal(fs.existsSync(out.providerShims.agy), true);
});

test("versioning, skill installer, and Ubuntu OpenClaw installer work end-to-end", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-ver-"));

  // 1. Version inspection & snapshot persistence
  const versions = getInstalledVersions();
  assert.equal(versions.clawsub, CLAWSUB_VERSION);
  const snap = recordVersionSnapshot(tmpDir, "unit-test");
  assert.equal(snap.label, "unit-test");
  assert.equal(fs.existsSync(path.join(tmpDir, "clawsub-versions.json")), true);

  // 2. Skill installation into workspace (`skills/clawsub/SKILL.md` + `.agents/skills/clawsub/SKILL.md`)
  const sk = installSkill({ workspace: tmpDir });
  assert.equal(sk.installedPaths.length, 2);
  for (const p of sk.installedPaths) {
    assert.equal(fs.existsSync(p), true);
    assert.match(fs.readFileSync(p, "utf8"), /name:\s*clawsub/);
  }

  // 3. Ubuntu installer dry-run and mocked execution with version pinning
  const dry = installOpenClawUbuntu({
    openclawVersion: "2026.11.0",
    providers: ["claude", "codex"],
    dryRun: true,
  });
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.npmPackages, [
    "openclaw@2026.11.0",
    "@anthropic-ai/claude-code@latest",
    "@openai/codex@latest",
  ]);
});

test("runDoctor reports no openclaw.json issues when config is valid and headless-safe", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doc-valid-"));
  const openclawDir = path.join(tmpDir, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  const agyCli = path.join(tmpDir, "agy-cli");
  fs.writeFileSync(agyCli, "#!/bin/sh\necho agy", { mode: 0o755 });

  const oc = {
    plugins: {
      entries: {
        anthropic: { config: { sessionCatalog: { enabled: false } } },
        codex: { config: { sessionCatalog: { enabled: false } } },
      },
      load: { paths: [agyCli] },
    },
  };
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify(oc));

  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir });
  assert.equal(
    report.openclawJson.issues.length,
    0,
    `Expected no openclaw.json issues but got: ${report.openclawJson.issues.join("; ")}`
  );
});

test("runDoctor detects misconfigured openclaw.json and emits exact remediation commands", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doc-bad-"));
  const openclawDir = path.join(tmpDir, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });

  const oc = {
    plugins: {
      entries: {
        anthropic: { config: { sessionCatalog: { enabled: true } } },
        codex: { config: { sessionCatalog: { enabled: true } } },
      },
      load: { paths: ["/nonexistent/path/to/agy"] },
    },
  };
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify(oc));

  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir });

  assert.ok(
    report.openclawJson.issues.some((i) => /anthropic/.test(i) && /sessionCatalog/.test(i)),
    "Expected sessionCatalog issue for anthropic"
  );
  assert.ok(
    report.openclawJson.issues.some((i) => /codex/.test(i) && /sessionCatalog/.test(i)),
    "Expected sessionCatalog issue for codex"
  );
  assert.ok(
    report.openclawJson.recommendations.some((r) =>
      /plugins\.entries\.anthropic.*sessionCatalog/.test(r)
    ),
    "Expected anthropic remediation command referencing correct JSON path"
  );
  assert.ok(
    report.openclawJson.recommendations.some((r) =>
      /plugins\.entries\.codex.*sessionCatalog/.test(r)
    ),
    "Expected codex remediation command referencing correct JSON path"
  );
  assert.ok(
    report.openclawJson.issues.some((i) => /plugins\.load\.paths/.test(i) && /does not exist/.test(i)),
    "Expected missing plugins.load.paths issue"
  );
  assert.ok(
    report.issues.some((i) => /anthropic/.test(i)),
    "Top-level issues should include openclaw.json issues"
  );
});

test("runDoctor skips openclaw.json checks gracefully when file is absent", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doc-absent-"));
  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir });
  assert.equal(report.openclawJson, null, "openclawJson should be null when file missing");
});

test("runDoctor reports an issue for malformed openclaw.json (not silently skipped)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doc-malformed-"));
  const openclawDir = path.join(tmpDir, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{ invalid json !!!");

  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir });
  assert.ok(
    report.issues.some((i) => /openclaw\.json/.test(i) && /parse/.test(i)),
    "Expected a parse error issue for malformed openclaw.json"
  );
  assert.notEqual(report.openclawJson, null, "openclawJson should not be null for malformed file");
});

test("runDoctor flags provider with omitted plugins.entries entry as sessionCatalog not explicitly disabled", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doc-omit-"));
  const openclawDir = path.join(tmpDir, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({ plugins: { entries: {} } }));

  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir });
  assert.ok(
    report.openclawJson.issues.some((i) => /anthropic/.test(i) && /sessionCatalog/.test(i)),
    "Expected sessionCatalog issue for omitted anthropic entry"
  );
  assert.ok(
    report.openclawJson.issues.some((i) => /codex/.test(i) && /sessionCatalog/.test(i)),
    "Expected sessionCatalog issue for omitted codex entry"
  );
  assert.ok(
    report.openclawJson.recommendations.some((r) => r === "openclaw models auth login --provider anthropic --force"),
    "Expected exact --force command for anthropic"
  );
  assert.ok(
    report.openclawJson.recommendations.some((r) => r === "openclaw models auth login --provider codex --force"),
    "Expected exact --force command for codex"
  );
});

test("inspectOpenClawJson reports missing agy-cli plugin path when absent from load.paths", () => {
  const withoutAgy = { plugins: { load: { paths: ["/some/other/plugin"] } } };
  const res1 = inspectOpenClawJson(withoutAgy);
  assert.ok(
    res1.issues.some((i) => /agy-cli/.test(i)),
    "Expected agy-cli issue when no agy-cli entry in load.paths"
  );

  const withNoLoadPaths = { plugins: { entries: {} } };
  const res2 = inspectOpenClawJson(withNoLoadPaths);
  assert.ok(
    res2.issues.some((i) => /agy-cli/.test(i)),
    "Expected agy-cli issue when load.paths is absent entirely"
  );

  const withAgyCli = { plugins: { load: { paths: ["/usr/local/lib/agy-cli/entry.js"] } } };
  const res3 = inspectOpenClawJson(withAgyCli);
  assert.ok(
    !res3.issues.some((i) => i === "openclaw.json: plugins.load.paths does not include an agy-cli plugin path."),
    "No missing-agy-cli issue when load.paths includes an agy-cli entry (may still report missing-file)"
  );
});

test("inspectOpenClawJson expands ~ paths before checking existence", () => {
  const expandedDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-home-"));
  const expandedPlugin = path.join(expandedDir, ".local", "agy-cli", "plugin.js");
  fs.mkdirSync(path.dirname(expandedPlugin), { recursive: true });
  fs.writeFileSync(expandedPlugin, "");

  const cfg = { plugins: { load: { paths: ["~/.local/agy-cli/plugin.js"] } } };
  const res = inspectOpenClawJson(cfg, { homeDir: expandedDir });
  assert.ok(
    !res.issues.some((i) => /does not exist/.test(i) && i.includes("~/.local/agy-cli")),
    "~ path that resolves to existing file should not be flagged as missing"
  );
});

test("shared session baton passes context across models on credit exhaustion AND on primary recovery", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-baton-"));
  const t1 = new Date(2026, 10, 25, 16, 0);
  const config = {
    chain: ["claude", "codex", "agy"],
    workspace: tmpDir,
    defaultCooldownMinutes: 60,
    cooldownBufferMinutes: 5,
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const state = { providers: {} };
  const batonStore = { sessions: {} };
  const receivedPrompts = [];

  // Turn 1: claude succeeds normally
  const res1 = routePrompt("Design the authentication flow for our CLI", {
    stateDir: tmpDir,
    config,
    state,
    batonStore,
    now: t1,
    runner: ({ command, args, input }) => {
      const actualPrompt = input || args[args.length - 1];
      receivedPrompts.push({ provider: command, prompt: actualPrompt });
      return {
        exitCode: 0,
        stdout: "We will use browser OAuth with zero API keys.",
        stderr: "",
        latencyMs: 100,
      };
    },
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.provider, "claude");
  assert.equal(res1.handoffInjected, false);

  // Turn 2: claude outputs partial work then runs out of credit ("usage_limit_reached: resets 6:50pm")
  // -> codex takes over AND receives Turn 1 history + claude's mid-turn partial progress!
  receivedPrompts.length = 0;
  const res2 = routePrompt("Now implement step 2: cooldown state persistence", {
    stateDir: tmpDir,
    config,
    state,
    batonStore,
    now: new Date(t1.getTime() + 60_000),
    runner: ({ command, args, input }) => {
      const actualPrompt = input || args[args.length - 1];
      receivedPrompts.push({ provider: command, prompt: actualPrompt });
      if (command === "claude") {
        return {
          exitCode: 1,
          stdout: "Edited src/state.mjs (lines 1-40)...\n{\"type\":\"result\",\"error\":\"usage_limit_reached: resets 6:50pm\"}",
          stderr: "",
          latencyMs: 150,
        };
      }
      return {
        exitCode: 0,
        stdout: "Finished step 2 in src/state.mjs and added unit tests.",
        stderr: "",
        latencyMs: 220,
      };
    },
  });

  assert.equal(res2.ok, true);
  assert.equal(res2.provider, "codex");
  assert.equal(res2.handoffInjected, true);
  const codexReceived = receivedPrompts.find((p) => p.provider === "codex");
  assert.ok(codexReceived);
  assert.match(codexReceived.prompt, /CLAWSUB SHARED SESSION BATON — HANDOFF TO CODEX/);
  assert.match(codexReceived.prompt, /We will use browser OAuth with zero API keys/);
  assert.match(codexReceived.prompt, /Mid-Turn Credit Exhaustion Handoff from claude/);
  assert.match(codexReceived.prompt, /Edited src\/state\.mjs/);

  // Turn 3 (after 7:00pm when claude's 5h credit window resets):
  // claude comes back online and receives Turn 2 completed by codex so claude has ZERO split-brain amnesia!
  receivedPrompts.length = 0;
  const afterReset = new Date(2026, 10, 25, 19, 5);
  const res3 = routePrompt("Now add the CLI status command", {
    stateDir: tmpDir,
    config,
    state,
    batonStore,
    now: afterReset,
    runner: ({ command, args, input }) => {
      const actualPrompt = input || args[args.length - 1];
      receivedPrompts.push({ provider: command, prompt: actualPrompt });
      return {
        exitCode: 0,
        stdout: "Added clawsub status building on codex's state.mjs work.",
        stderr: "",
        latencyMs: 140,
      };
    },
  });

  assert.equal(res3.ok, true);
  assert.equal(res3.provider, "claude");
  assert.equal(res3.handoffInjected, true);
  const claudeRecoveryPrompt = receivedPrompts.find((p) => p.provider === "claude");
  assert.ok(claudeRecoveryPrompt);
  assert.match(claudeRecoveryPrompt.prompt, /CLAWSUB SHARED SESSION BATON — HANDOFF TO CLAUDE/);
  assert.match(claudeRecoveryPrompt.prompt, /\[Turn #2 via codex\]/);
  assert.match(claudeRecoveryPrompt.prompt, /Finished step 2 in src\/state\.mjs and added unit tests/);
});

// ── savings ─────────────────────────────────────────────────────────────────

test("PROVIDER_PRICING has correct rates for claude, codex, agy, gemini", () => {
  assert.equal(PROVIDER_PRICING.claude.inputPerM, 15);
  assert.equal(PROVIDER_PRICING.claude.outputPerM, 75);
  assert.equal(PROVIDER_PRICING.codex.inputPerM, 3);
  assert.equal(PROVIDER_PRICING.codex.outputPerM, 15);
  assert.equal(PROVIDER_PRICING.agy.inputPerM, 1.25);
  assert.equal(PROVIDER_PRICING.agy.outputPerM, 5);
  assert.equal(PROVIDER_PRICING.gemini.inputPerM, 1.25);
  assert.equal(PROVIDER_PRICING.gemini.outputPerM, 5);
  assert.equal(PROVIDER_PRICING.ollama.inputPerM, 0);
});

test("computeSavings returns zeros for empty stats", () => {
  const result = computeSavings({ providers: {}, firstRecordedAt: null, lastRecordedAt: null });
  assert.equal(result.totalSavedUsd, 0);
  assert.equal(result.turnsTracked, 0);
  assert.deepEqual(result.byProvider, []);
  assert.equal(result.monthlyProjectionUsd, 0);
});

test("computeSavings handles null/undefined input gracefully", () => {
  const result = computeSavings(null);
  assert.equal(result.totalSavedUsd, 0);
  assert.equal(result.turnsTracked, 0);
});

test("computeSavings computes correct savings for claude (Opus pricing)", () => {
  // 4000 promptChars = 1000 input tokens; 8000 responseChars = 2000 output tokens
  // savings = (1000/1M)*15 + (2000/1M)*75 = 0.000015 + 0.00015 = 0.000165
  const stats = {
    providers: { claude: { turnCount: 1, promptChars: 4000, responseChars: 8000 } },
    firstRecordedAt: "2026-11-01T00:00:00Z",
    lastRecordedAt: "2026-11-01T00:00:00Z",
  };
  const result = computeSavings(stats);
  assert.equal(result.turnsTracked, 1);
  assert.equal(result.byProvider.length, 1);
  assert.equal(result.byProvider[0].provider, "claude");
  assert.equal(result.byProvider[0].inputTokens, 1000);
  assert.equal(result.byProvider[0].outputTokens, 2000);
  assert.ok(result.totalSavedUsd > 0, "totalSavedUsd should be positive");
  const expected = (1000 / 1_000_000) * 15 + (2000 / 1_000_000) * 75;
  assert.ok(Math.abs(result.totalSavedUsd - expected) < 0.000001);
});

test("computeSavings computes monthly projection from tracked days", () => {
  const stats = {
    providers: { codex: { turnCount: 10, promptChars: 40000, responseChars: 80000 } },
    firstRecordedAt: "2026-11-01T00:00:00Z",
    lastRecordedAt: "2026-11-11T00:00:00Z", // 10 days
  };
  const result = computeSavings(stats);
  assert.ok(result.daysTracked >= 9.9 && result.daysTracked <= 10.1, "daysTracked ~10");
  assert.ok(result.monthlyProjectionUsd > 0, "monthlyProjectionUsd should be positive");
  assert.ok(
    Math.abs(result.monthlyProjectionUsd - result.dailyAvgUsd * 30) < 0.01,
    "monthly = daily * 30"
  );
});

test("computeSavings sums across multiple providers", () => {
  const stats = {
    providers: {
      claude: { turnCount: 5, promptChars: 20000, responseChars: 40000 },
      agy: { turnCount: 3, promptChars: 12000, responseChars: 24000 },
    },
    firstRecordedAt: "2026-11-01T00:00:00Z",
    lastRecordedAt: "2026-11-02T00:00:00Z",
  };
  const result = computeSavings(stats);
  assert.equal(result.turnsTracked, 8);
  assert.equal(result.byProvider.length, 2);
  const claudeSaved = result.byProvider.find((p) => p.provider === "claude").savedUsd;
  const agySaved = result.byProvider.find((p) => p.provider === "agy").savedUsd;
  assert.ok(claudeSaved > agySaved, "claude (Opus) saves more per token than agy (Gemini)");
  assert.ok(Math.abs(result.totalSavedUsd - (claudeSaved + agySaved)) < 0.0001);
});

test("recordTurnSavings accumulates stats across multiple calls", () => {
  const state = { providers: {}, savings: { providers: {}, firstRecordedAt: null, lastRecordedAt: null } };
  const t0 = new Date("2026-11-01T10:00:00Z");
  const t1 = new Date("2026-11-02T10:00:00Z");
  recordTurnSavings(state, "claude", { promptChars: 100, responseChars: 200, now: t0 });
  recordTurnSavings(state, "claude", { promptChars: 50, responseChars: 100, now: t1 });
  recordTurnSavings(state, "codex", { promptChars: 80, responseChars: 160, now: t1 });

  assert.equal(state.savings.providers.claude.turnCount, 2);
  assert.equal(state.savings.providers.claude.promptChars, 150);
  assert.equal(state.savings.providers.claude.responseChars, 300);
  assert.equal(state.savings.providers.codex.turnCount, 1);
  assert.equal(state.savings.firstRecordedAt, t0.toISOString());
  assert.equal(state.savings.lastRecordedAt, t1.toISOString());
});

test("recordTurnSavings initializes savings on state without it", () => {
  const state = { providers: {} };
  recordTurnSavings(state, "agy", { promptChars: 400, responseChars: 800, now: new Date() });
  assert.ok(state.savings);
  assert.equal(state.savings.providers.agy.turnCount, 1);
});

test("routePrompt records savings stats on successful turn", () => {
  const state = { providers: {} };
  routePrompt("hello world", {
    config: { chain: ["claude"], enableSessionBaton: false },
    state,
    batonStore: { sessions: {} },
    runner: () => ({ exitCode: 0, stdout: "hi there", stderr: "", latencyMs: 10 }),
  });
  assert.ok(state.savings, "savings should be populated after successful turn");
  assert.ok(state.savings.providers.claude, "claude entry should exist");
  assert.equal(state.savings.providers.claude.turnCount, 1);
  assert.ok(state.savings.providers.claude.promptChars > 0);
  assert.ok(state.savings.providers.claude.responseChars > 0);
});
