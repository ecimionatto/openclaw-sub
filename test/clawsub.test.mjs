import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAWSUB_VERSION,
  computeCooldownUntil,
  configureOpenClawJson,
  findActiveTimeWindow,
  generateOpenClawIntegration,
  getInstalledVersions,
  getProviderCooldown,
  installOpenClawUbuntu,
  installSkill,
  isHeartbeatPrompt,
  isQuotaError,
  parseResetTime,
  recordVersionSnapshot,
  routePrompt,
} from "../src/index.mjs";

test("isQuotaError detects Claude 5-hour/weekly limits, Codex 429s, and Gemini ResourceExhausted", () => {
  assert.equal(isQuotaError('{"type":"result","error":"usage_limit_reached: resets 6:50pm"}'), true);
  assert.equal(isQuotaError("You've hit your 5-hour limit. Resets at 10:00pm."), true);
  assert.equal(isQuotaError("You've hit your weekly limit. Resets Nov 28, 10:00am."), true);
  assert.equal(isQuotaError("Error: HTTP 429 Too Many Requests"), true);
  assert.equal(isQuotaError("GoogleGenerativeAIError: ResourceExhausted: Quota exceeded"), true);
  assert.equal(isQuotaError("Normal assistant response with 200 OK"), false);
});

test("parseResetTime parses same-day, next-day, multi-day date, and relative durations", () => {
  const now = new Date("2026-11-25T16:00:00-05:00");

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
  const now = new Date("2026-11-25T16:00:00-05:00");
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
  const now = new Date("2026-11-25T16:00:00-05:00");
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
  const morningStandupWindow = new Date("2026-11-25T07:30:00-05:00");
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
  const afternoon = new Date("2026-11-25T15:00:00-05:00");
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
    findActiveTimeWindow(["23:00-08:00"], new Date("2026-11-25T23:30:00-05:00")),
    "23:00-08:00"
  );
  assert.equal(
    findActiveTimeWindow(["23:00-08:00"], new Date("2026-11-25T06:15:00-05:00")),
    "23:00-08:00"
  );
  assert.equal(
    findActiveTimeWindow(["23:00-08:00"], new Date("2026-11-25T14:00:00-05:00")),
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

test("configureOpenClawJson creates openclaw.json on first run and merges/backs up on subsequent runs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-oc-"));
  const configPath = path.join(tmpDir, "openclaw.json");
  const pluginDir = path.join(tmpDir, "plugins", "openclaw-agy-cli");

  // First run: file doesn't exist — no backup, creates from scratch
  const res1 = configureOpenClawJson({
    openclawConfigPath: configPath,
    chain: ["claude", "codex", "agy"],
    workspace: tmpDir,
    pluginDir,
  });
  assert.equal(fs.existsSync(configPath), true);
  assert.equal(res1.backupPath, null);
  const cfg1 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(cfg1.agentRuntime.id, "claude-cli");
  assert.equal(cfg1.agentRuntime.workspace, tmpDir);
  assert.equal(cfg1.agents.defaults.model, "claude");
  assert.deepEqual(cfg1.agents.defaults.models, ["claude", "codex", "agy"]);
  assert.equal(cfg1.sessionCatalog.enabled, false);
  assert.deepEqual(cfg1.plugins.load.paths, [pluginDir]);

  // Second run: file exists — backup created, agy as primary, pluginDir not duplicated
  const res2 = configureOpenClawJson({
    openclawConfigPath: configPath,
    chain: ["agy", "claude"],
    workspace: tmpDir,
    pluginDir,
  });
  assert.ok(res2.backupPath);
  assert.equal(fs.existsSync(res2.backupPath), true);
  const cfg2 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(cfg2.agentRuntime.id, "agy-cli");
  assert.equal(cfg2.agents.defaults.model, "agy");
  assert.deepEqual(cfg2.agents.defaults.models, ["agy", "claude"]);
  assert.equal(cfg2.sessionCatalog.enabled, false);
  assert.equal(cfg2.plugins.load.paths.filter((p) => p === pluginDir).length, 1);

  // codex maps to "codex" runtime id (not "codex-cli")
  const res3 = configureOpenClawJson({
    openclawConfigPath: configPath,
    chain: ["codex"],
    workspace: tmpDir,
  });
  const cfg3 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(cfg3.agentRuntime.id, "codex");
});

test("shared session baton passes context across models on credit exhaustion AND on primary recovery", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-baton-"));
  const t1 = new Date("2026-11-25T16:00:00-05:00");
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
  const afterReset = new Date("2026-11-25T19:05:00-05:00");
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
