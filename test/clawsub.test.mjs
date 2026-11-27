import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  isAuthError,
  isHeartbeatPrompt,
  isQuotaError,
  loadState,
  loopInit,
  normalizeChain,
  parseResetTime,
  PROVIDER_PRICING,
  PROVIDERS,
  recordTurnSavings,
  recordVersionSnapshot,
  routePrompt,
  runDoctor,
  saveConfig,
  saveState,
  validateConfig,
} from "../src/index.mjs";
import { configureOpenClawJson, inspectOpenClawJson } from "../src/openclaw-config.mjs";
import { generateSystemdService, installSystemdService } from "../src/ubuntu-systemd.mjs";

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

test("isQuotaError table: session/model/weekly limits, curly apostrophe, Request rejected (429)", () => {
  const hits = [
    "You’ve hit your session limit.",
    "You've hit your session limit.",
    "You’ve hit your weekly limit. Resets Mon 12:00am.",
    "You’ve hit your usage limit. Try again at Nov 28th, 2026 3:45 PM.",
    "You've hit your Opus limit for this week.",
    "You've hit your Sonnet limit. Resets in 2 hours.",
    "Request rejected (429): too many requests",
  ];
  for (const msg of hits) {
    assert.equal(isQuotaError(msg), true, `should match: ${msg}`);
  }
  assert.equal(isQuotaError("Everything is working fine."), false);
});

test("parseResetTime: weekday reset 'resets Mon 12:00am'", () => {
  // now = Wednesday Nov 25 2026 16:00 — next Monday is Nov 30
  const now = new Date(2026, 10, 25, 16, 0);
  const result = parseResetTime("You’ve hit your weekly limit. Resets Mon 12:00am.", now);
  assert.ok(result, "should return a date");
  assert.equal(result.getDay(), 1, "should be a Monday");
  assert.equal(result.getHours(), 0);
  assert.equal(result.getMinutes(), 0);
  assert.ok(result > now, "reset must be in the future");
});

test("parseResetTime: Codex 'Try again at 3:45 PM'", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const result = parseResetTime("You’ve hit your usage limit. Try again at 3:45 PM.", now);
  assert.ok(result, "should return a date");
  assert.equal(result.getHours(), 15);
  assert.equal(result.getMinutes(), 45);
  assert.ok(result > now);
});

test("parseResetTime: Codex absolute 'Try again at Nov 28th, 2026 3:45 PM'", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const result = parseResetTime("Try again at Nov 28th, 2026 3:45 PM", now);
  assert.ok(result, "should return a date");
  assert.equal(result.getMonth(), 10);
  assert.equal(result.getDate(), 28);
  assert.equal(result.getHours(), 15);
  assert.equal(result.getMinutes(), 45);
});

test("isAuthError table: Not logged in, OAuth, Invalid API key, RefreshTokenFailed", () => {
  const hits = [
    "Error: Not logged in. Please run `claude login`.",
    "OAuth token refresh failed: token expired",
    "Error: Invalid API key provided.",
    "RefreshTokenFailed: unable to refresh OAuth credentials",
  ];
  for (const msg of hits) {
    assert.equal(isAuthError(msg), true, `should match: ${msg}`);
  }
  assert.equal(isAuthError("Normal response OK"), false);
  assert.equal(isAuthError("You've hit your 5-hour limit"), false);
});

test("routePrompt sets auth_expired status with 6h cooldown and remediation on auth failure", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: ["claude"],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const runner = () => ({
    stdout: "",
    stderr: "OAuth token refresh failed: token expired",
    exitCode: 1,
    latencyMs: 10,
  });
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0].status, "auth_expired");
  assert.ok(result.attempts[0].remediation.includes("openclaw models auth login"));
  assert.ok(result.attempts[0].remediation.includes("--provider claude"));
  assert.ok(result.attempts[0].remediation.includes("--force"));
  const cooldownUntil = new Date(state.providers.claude.cooldownUntil);
  assert.ok(cooldownUntil.getTime() - now.getTime() >= 6 * 3600_000 - 1000);
  assert.ok(cooldownUntil.getTime() - now.getTime() <= 6 * 3600_000 + 1000);
});

test("routePrompt all-auth chain: output names auth cause, not quota cooldown", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: ["claude", "codex"],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const runner = () => ({
    stdout: "",
    stderr: "OAuth token refresh failed: token expired",
    exitCode: 1,
    latencyMs: 10,
  });
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, false);
  assert.ok(result.output.includes("expired credentials"), `expected 'expired credentials' in: ${result.output}`);
  assert.ok(!result.output.includes("quota cooldown"), `should not mention quota cooldown in: ${result.output}`);
  assert.ok(result.output.includes("claude: auth expired"), `expected per-provider label in: ${result.output}`);
  assert.ok(result.output.includes("codex: auth expired"), `expected per-provider label in: ${result.output}`);
  assert.ok(result.output.includes("openclaw models auth login"), `expected remediation cmd in: ${result.output}`);
});

test("routePrompt mixed auth/quota chain: quota reset shown, auth listed separately", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: ["claude", "codex"],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  let call = 0;
  const runner = () => {
    call++;
    if (call === 1) {
      return {
        stdout: '{"type":"result","error":"usage_limit_reached: resets 6:50pm"}',
        stderr: "",
        exitCode: 1,
        latencyMs: 10,
      };
    }
    return {
      stdout: "",
      stderr: "OAuth token refresh failed: token expired",
      exitCode: 1,
      latencyMs: 10,
    };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, false);
  assert.ok(result.output.includes("quota cooldown"), `expected quota cooldown in: ${result.output}`);
  assert.ok(result.output.includes("Auth expired"), `expected auth section in: ${result.output}`);
  assert.ok(result.output.includes("codex: auth expired"), `expected per-provider auth label in: ${result.output}`);
  assert.ok(!result.output.includes("quota cooldown") || result.output.includes("claude"), `quota reset should reference claude`);
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

  // 2. Skill installation into workspace: writes .claude/skills, skills (ClawHub), and .agents/skills
  const sk = installSkill({ workspace: tmpDir });
  assert.equal(sk.installedPaths.length, 3);
  const claudePath = path.join(tmpDir, ".claude", "skills", "clawsub", "SKILL.md");
  const clawHubPath = path.join(tmpDir, "skills", "clawsub", "SKILL.md");
  const agentsPath = path.join(tmpDir, ".agents", "skills", "clawsub", "SKILL.md");
  assert.ok(sk.installedPaths.includes(claudePath), ".claude/skills path must be in installedPaths");
  assert.ok(sk.installedPaths.includes(clawHubPath), "skills path must be in installedPaths");
  assert.ok(sk.installedPaths.includes(agentsPath), ".agents/skills path must be in installedPaths");
  assert.equal(fs.existsSync(claudePath), true);
  assert.equal(fs.existsSync(clawHubPath), true);
  assert.equal(fs.existsSync(agentsPath), true);
  assert.match(fs.readFileSync(claudePath, "utf8"), /name:\s*clawsub/);

  // 2b. Skill installation with --global also writes ~/.openclaw/skills/clawsub/SKILL.md
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-home-"));
  const skGlobal = installSkill({ workspace: tmpDir, global: true, homeDir });
  assert.equal(skGlobal.installedPaths.length, 4);
  const globalPath = path.join(homeDir, ".openclaw", "skills", "clawsub", "SKILL.md");
  assert.ok(skGlobal.installedPaths.includes(globalPath), "global path must be in installedPaths");
  assert.equal(fs.existsSync(globalPath), true);
  assert.match(fs.readFileSync(globalPath, "utf8"), /name:\s*clawsub/);

  // 2c. Root SKILL.md must be byte-identical to skills/clawsub/SKILL.md (no drift)
  const rootSkillPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../SKILL.md");
  const pkgSkillPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../skills/clawsub/SKILL.md");
  assert.equal(
    fs.readFileSync(rootSkillPath, "utf8"),
    fs.readFileSync(pkgSkillPath, "utf8"),
    "Root SKILL.md must be byte-identical to skills/clawsub/SKILL.md"
  );

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

test("generateSystemdService produces a valid unit file with Restart=on-failure and PATH", () => {
  const result = generateSystemdService({ workspace: "/home/user/myproject", nodeBinDir: "/usr/local/bin" });
  assert.ok(typeof result.content === "string", "content must be a string");
  assert.match(result.content, /Restart=on-failure/);
  assert.match(result.content, /WantedBy=default\.target/);
  assert.match(result.content, /WorkingDirectory=\/home\/user\/myproject/);
  assert.match(result.content, /PATH=\/usr\/local\/bin:/);
  assert.match(result.content, /ExecStart=\/usr\/bin\/env openclaw gateway$/m);
  assert.equal(result.serviceName, "openclaw-sub");
  assert.match(result.suggestedPath, /openclaw-sub\.service$/);
});

test("generateSystemdService resolves relative workspace path to absolute", () => {
  const result = generateSystemdService({ workspace: "./myrelproject", nodeBinDir: "/usr/local/bin" });
  const lines = result.content.split("\n");
  const wdLine = lines.find((l) => l.startsWith("WorkingDirectory="));
  assert.ok(wdLine, "WorkingDirectory line must exist");
  assert.ok(path.isAbsolute(wdLine.replace("WorkingDirectory=", "")), "WorkingDirectory must be absolute");
});

test("generateSystemdService escapes percent signs and spaces in paths", () => {
  const result = generateSystemdService({
    workspace: "/home/user/my project%test",
    nodeBinDir: "/usr/local/bin",
  });
  assert.match(result.content, /WorkingDirectory=.*my project/, "literal space must be preserved in WorkingDirectory");
  assert.match(result.content, /WorkingDirectory=.*%%test/, "percent must be doubled to %%");
  assert.doesNotMatch(result.content, /WorkingDirectory=.*\\x20/, "\\x20 must not appear in WorkingDirectory");
});

test("generateSystemdService escapes percent signs and spaces in nodeBinDir for Environment=PATH", () => {
  const result = generateSystemdService({
    workspace: "/home/user/project",
    nodeBinDir: "/home/user/my node%bin",
  });
  assert.match(result.content, /Environment=.*\\x20/, "space in nodeBinDir must become \\x20 in Environment=");
  assert.match(result.content, /Environment=.*%%bin/, "percent in nodeBinDir must be doubled to %%");
});

test("install-systemd --enable exits 1 when systemctl fails", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-exit1-"));
  const fakeSystemctl = path.join(tmpDir, "systemctl");
  fs.writeFileSync(fakeSystemctl, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const binPath = fileURLToPath(new URL("../bin/clawsub.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [binPath, "install-systemd", "--enable", `--workspace=${tmpDir}`],
    { env: { ...process.env, HOME: tmpDir, PATH: `${tmpDir}:${process.env.PATH}` }, encoding: "utf8" }
  );

  assert.equal(result.status, 1, "exit code must be 1 when daemon-reload or enable fails");
});

test("installSystemdService with enable=true calls systemctl daemon-reload and enable, not on dry-run", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-systemd-enable-"));
  const called = [];
  const fakeRunner = (cmd) => { called.push(cmd); };

  const result = installSystemdService({
    workspace: tmpDir,
    nodeBinDir: "/usr/local/bin",
    dryRun: false,
    enable: true,
    homeDir: tmpDir,
    runner: fakeRunner,
  });

  assert.equal(result.ok, true);
  assert.ok(called.includes("systemctl --user daemon-reload"), "must call daemon-reload");
  assert.ok(called.includes("systemctl --user enable openclaw-sub"), "must call enable");
  assert.equal(result.enableResult.reloaded, true);
  assert.equal(result.enableResult.enabled, true);
  assert.deepEqual(result.enableResult.errors, []);

  called.length = 0;
  const dryResult = installSystemdService({
    workspace: tmpDir,
    nodeBinDir: "/usr/local/bin",
    dryRun: true,
    enable: true,
    homeDir: tmpDir,
    runner: fakeRunner,
  });
  assert.equal(dryResult.dryRun, true);
  assert.equal(called.length, 0, "dry-run must not call runner even with --enable");
});

test("installSystemdService with enable=true reports runner failures in enableResult.errors", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-systemd-fail-"));
  const failRunner = (cmd) => { throw new Error(`${cmd}: mock failure`); };

  const result = installSystemdService({
    workspace: tmpDir,
    nodeBinDir: "/usr/local/bin",
    dryRun: false,
    enable: true,
    homeDir: tmpDir,
    runner: failRunner,
  });

  assert.equal(result.ok, true, "file was written, so ok should be true");
  assert.equal(result.enableResult.reloaded, false);
  assert.equal(result.enableResult.enabled, false);
  assert.equal(result.enableResult.errors.length, 2);
  assert.match(result.enableResult.errors[0], /daemon-reload failed/);
  assert.match(result.enableResult.errors[1], /enable openclaw-sub failed/);
});

test("installSystemdService dry-run returns content and instructions without writing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-systemd-"));
  const result = installSystemdService({
    workspace: tmpDir,
    nodeBinDir: "/usr/local/bin",
    dryRun: true,
    homeDir: tmpDir,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.match(result.content, /Restart=on-failure/);
  assert.ok(Array.isArray(result.lingerInstructions));
  assert.ok(result.lingerInstructions.some((l) => /loginctl enable-linger/.test(l)));
  assert.ok(result.lingerInstructions.some((l) => /systemctl --user enable openclaw-sub/.test(l)));
  assert.equal(fs.existsSync(result.servicePath), false, "dry-run must not write the file");
});

test("installSystemdService writes service file to correct path when not dry-run", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-systemd-write-"));
  const result = installSystemdService({
    workspace: tmpDir,
    nodeBinDir: "/usr/local/bin",
    dryRun: false,
    homeDir: tmpDir,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(fs.existsSync(result.servicePath), true, "service file must be written");
  const written = fs.readFileSync(result.servicePath, "utf8");
  assert.match(written, /Restart=on-failure/);
  assert.match(written, /WantedBy=default\.target/);
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
  // savings = (1000/1M)*15 + (2000/1M)*75 = 0.015 + 0.15 = 0.165
  const stats = {
    providers: { claude: { turnCount: 1, promptChars: 4000, responseChars: 8000 } },
    firstRecordedAt: "2026-11-01T00:00:00Z",
    lastRecordedAt: "2026-11-01T00:00:00Z",
  };
  const result = computeSavings(stats, { now: new Date("2026-11-01T00:00:00Z") });
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
    lastRecordedAt: "2026-11-11T00:00:00Z",
  };
  const result = computeSavings(stats, { now: new Date("2026-11-11T00:00:00Z") });
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
  const result = computeSavings(stats, { now: new Date("2026-11-02T00:00:00Z") });
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-savings-route-"));
  const state = { providers: {} };
  routePrompt("hello world", {
    stateDir: tmpDir,
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
  // Confirm the injected state was NOT persisted to the user's real default state directory
  const defaultDir = path.join(os.homedir(), ".openclaw");
  if (fs.existsSync(path.join(defaultDir, "clawsub-state.json"))) {
    const persisted = JSON.parse(fs.readFileSync(path.join(defaultDir, "clawsub-state.json"), "utf8"));
    assert.ok(
      !persisted.savings || persisted.savings.providers?.claude?.turnCount !== 1 ||
        persisted.savings.firstRecordedAt !== state.savings.firstRecordedAt,
      "injected in-memory state must not leak to real default stateDir"
    );
  }
});

test("computeSavings projects conservatively when idle time follows the last turn", () => {
  // 1 day of heavy use then 29 idle days — projection should be much less than 30x daily use
  const firstRecordedAt = "2026-11-01T00:00:00Z";
  const stats = {
    providers: { claude: { turnCount: 100, promptChars: 400_000, responseChars: 800_000 } },
    firstRecordedAt,
    lastRecordedAt: "2026-11-01T12:00:00Z",
  };
  const now30DaysLater = new Date("2026-11-30T00:00:00Z");
  const result = computeSavings(stats, { now: now30DaysLater });
  assert.ok(result.daysTracked >= 28.9, "daysTracked should include idle days after last turn");
  // The projection must be far less than 30x what a 1-day window would show
  const inflatedResult = computeSavings(stats, { now: new Date("2026-11-01T12:00:00Z") });
  assert.ok(
    result.monthlyProjectionUsd < inflatedResult.monthlyProjectionUsd / 10,
    "idle trailing days must deflate the monthly projection"
  );
});

test("saveState/loadState round-trip preserves savings and handles legacy state with no savings field", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-state-rt-"));

  // Round-trip with savings populated
  const state = {
    providers: {},
    savings: {
      providers: { claude: { turnCount: 7, promptChars: 28000, responseChars: 56000 } },
      firstRecordedAt: "2026-11-01T00:00:00Z",
      lastRecordedAt: "2026-11-05T00:00:00Z",
    },
  };
  saveState(state, tmpDir);
  const loaded = loadState(tmpDir);
  assert.equal(loaded.savings.providers.claude.turnCount, 7);
  assert.equal(loaded.savings.providers.claude.promptChars, 28000);
  assert.equal(loaded.savings.firstRecordedAt, "2026-11-01T00:00:00Z");

  // Legacy state file with no savings field must load with an empty savings object
  const legacyPath = path.join(tmpDir, "clawsub-state.json");
  fs.writeFileSync(legacyPath, JSON.stringify({ providers: {}, lastActiveProvider: "claude" }));
  const legacy = loadState(tmpDir);
  assert.ok(legacy.savings, "loadState must synthesize savings for legacy files");
  assert.deepEqual(legacy.savings.providers, {});
  assert.equal(legacy.savings.firstRecordedAt, null);
});

test("saveState/loadState: new provider cooldown survives round-trip (generic providers object)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-newprovider-"));
  const cooldownUntil = new Date(Date.now() + 3_600_000).toISOString();
  const state = {
    providers: { myNewCLI: { status: "cooldown", cooldownUntil } },
    savings: { providers: {}, firstRecordedAt: null, lastRecordedAt: null },
  };
  saveState(state, tmpDir);
  const loaded = loadState(tmpDir);
  assert.equal(loaded.providers.myNewCLI.cooldownUntil, cooldownUntil, "cooldown must survive reload");
  assert.equal(loaded.providers.myNewCLI.status, "cooldown");
});

test("cmdSavings CLI command outputs savings for both empty and populated state dirs", () => {
  const binPath = fileURLToPath(new URL("../bin/clawsub.mjs", import.meta.url));

  // Empty state dir
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-sv-empty-"));
  const emptyResult = spawnSync(
    process.execPath,
    [binPath, "savings", "--json"],
    { env: { ...process.env, HOME: emptyDir }, encoding: "utf8" }
  );
  assert.equal(emptyResult.status, 0, `savings --json failed: ${emptyResult.stderr}`);
  const emptyJson = JSON.parse(emptyResult.stdout);
  assert.equal(emptyJson.turnsTracked, 0);
  assert.equal(emptyJson.totalSavedUsd, 0);

  // Populated state dir
  const populatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-sv-pop-"));
  const stateDirPath = path.join(populatedDir, ".openclaw");
  fs.mkdirSync(stateDirPath, { recursive: true });
  const popState = {
    providers: {},
    savings: {
      providers: { codex: { turnCount: 5, promptChars: 20000, responseChars: 40000 } },
      firstRecordedAt: "2026-11-01T00:00:00Z",
      lastRecordedAt: "2026-11-05T00:00:00Z",
    },
  };
  fs.writeFileSync(path.join(stateDirPath, "clawsub-state.json"), JSON.stringify(popState));
  const popResult = spawnSync(
    process.execPath,
    [binPath, "savings", "--json"],
    { env: { ...process.env, HOME: populatedDir }, encoding: "utf8" }
  );
  assert.equal(popResult.status, 0, `savings --json failed: ${popResult.stderr}`);
  const popJson = JSON.parse(popResult.stdout);
  assert.equal(popJson.turnsTracked, 5);
  assert.ok(popJson.totalSavedUsd > 0, "totalSavedUsd should be positive for codex turns");
});

test("docs/BENCHMARKS.md exists and contains required sections and workload numbers", () => {
  const benchPath = fileURLToPath(new URL("../docs/BENCHMARKS.md", import.meta.url));
  assert.ok(fs.existsSync(benchPath), "docs/BENCHMARKS.md must exist");

  const content = fs.readFileSync(benchPath, "utf8");

  const requiredHeadings = [
    "30-Day Workload Model",
    "Cost Comparison",
    "Failure Recovery",
    "Reproduction Commands",
  ];
  for (const heading of requiredHeadings) {
    assert.ok(content.includes(heading), `docs/BENCHMARKS.md must contain section: ${heading}`);
  }

  // Workload numbers from acceptance criteria
  assert.ok(content.includes("1,440"), "Must document 1,440 heartbeats/month (48/day × 30)");
  assert.ok(content.includes("1,200"), "Must document 1,200 chat turns/month (40/day × 30)");
  assert.ok(content.includes("2,700"), "Must document 2,700 total turns/month");

  // Reproduction commands present
  assert.ok(content.includes("clawsub savings"), "Must include clawsub savings reproduction command");
  assert.ok(content.includes("clawsub doctor"), "Must include clawsub doctor reproduction command");
});

test("BENCHMARKS.md documented costs and token totals are consistent with computeSavings on the baseline fixture", () => {
  // Baseline fixture as documented in BENCHMARKS.md step 4 — chars split proportionally
  // so they sum to the 30-day baseline (1,338,000 input / 672,000 output tokens)
  const stats = {
    providers: {
      claude: { turnCount: 2000, promptChars: 3964000, responseChars: 1992000 },
      codex:  { turnCount: 500,  promptChars: 991000,  responseChars: 498000  },
      agy:    { turnCount: 200,  promptChars: 397000,  responseChars: 198000  },
    },
    firstRecordedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    lastRecordedAt:  new Date().toISOString(),
  };
  const result = computeSavings(stats);

  // Token totals must match the documented baseline
  const totalInput  = result.byProvider.reduce((s, p) => s + p.inputTokens,  0);
  const totalOutput = result.byProvider.reduce((s, p) => s + p.outputTokens, 0);
  assert.equal(totalInput,  1_338_000, "Total input tokens must equal baseline (1,338,000)");
  assert.equal(totalOutput,   672_000, "Total output tokens must equal baseline (672,000)");
  assert.equal(result.turnsTracked, 2700, "Total turns must be 2,700");

  // Savings over 30 days must be ~$55.20 (sum of per-provider avoided API spend)
  assert.ok(
    result.totalSavedUsd > 55 && result.totalSavedUsd < 56,
    `totalSavedUsd (${result.totalSavedUsd}) should be ~$55.20`
  );

  // 30-day API equivalent (all turns on claude): derived from PROVIDER_PRICING constants
  const claudeApiEquiv =
    (totalInput  / 1_000_000) * PROVIDER_PRICING.claude.inputPerM +
    (totalOutput / 1_000_000) * PROVIDER_PRICING.claude.outputPerM;
  assert.ok(Math.abs(claudeApiEquiv - 70.47) < 0.01, `Claude-only API equiv must be ~$70.47 (got ${claudeApiEquiv})`);

  // Verify BENCHMARKS.md contains the computed cost figures
  const benchPath = fileURLToPath(new URL("../docs/BENCHMARKS.md", import.meta.url));
  const benchContent = fs.readFileSync(benchPath, "utf8");
  assert.ok(benchContent.includes("$70.47"), "BENCHMARKS.md must document Claude API equivalent ~$70.47");
  assert.ok(benchContent.includes("$14.09"), "BENCHMARKS.md must document Codex API cost ~$14.09");
  assert.ok(benchContent.includes("$5.03"),  "BENCHMARKS.md must document Gemini API cost ~$5.03");
  assert.ok(benchContent.includes("$55.20"), "BENCHMARKS.md must document total monthly savings ~$55.20");
  assert.ok(benchContent.includes("52.2150"), "BENCHMARKS.md must include Claude per-provider savings $52.2150");
  assert.ok(benchContent.includes("2.6108"),  "BENCHMARKS.md must include Codex per-provider savings $2.6108");
  assert.ok(benchContent.includes("0.3716"),  "BENCHMARKS.md must include Gemini per-provider savings $0.3716");
});

test("README.md links to docs/BENCHMARKS.md", () => {
  const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
  assert.ok(fs.existsSync(readmePath), "README.md must exist");
  const content = fs.readFileSync(readmePath, "utf8");
  assert.ok(content.includes("docs/BENCHMARKS.md"), "README.md must link to docs/BENCHMARKS.md");
});

test("agent discovery manifests exist and are well-formed", () => {
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

  const llmsTxt = path.join(root, "llms.txt");
  assert.equal(fs.existsSync(llmsTxt), true, "llms.txt must exist");
  const llmsTxtContent = fs.readFileSync(llmsTxt, "utf8");
  assert.ok(llmsTxtContent.includes("openclaw-sub"), "llms.txt must mention openclaw-sub");
  assert.ok(llmsTxtContent.includes("npx"), "llms.txt must include install command");

  const llmsFullTxt = path.join(root, "llms-full.txt");
  assert.equal(fs.existsSync(llmsFullTxt), true, "llms-full.txt must exist");
  const llmsFullContent = fs.readFileSync(llmsFullTxt, "utf8");
  assert.ok(llmsFullContent.includes("openclaw.json"), "llms-full.txt must include config schema");
  assert.ok(llmsFullContent.includes("Troubleshooting"), "llms-full.txt must include troubleshooting section");

  const agentJson = path.join(root, ".well-known", "agent.json");
  assert.equal(fs.existsSync(agentJson), true, ".well-known/agent.json must exist");
  const agentData = JSON.parse(fs.readFileSync(agentJson, "utf8"));
  assert.equal(typeof agentData.name, "string", "agent.json must have name");
  assert.equal(typeof agentData.install, "object", "agent.json must have install");
  assert.equal(typeof agentData.install.npx, "string", "agent.json install.npx must be a string");
  assert.ok(Array.isArray(agentData.capabilities), "agent.json must have capabilities array");
  assert.ok(Array.isArray(agentData.providers), "agent.json must have providers array");
  assert.equal(typeof agentData.skill_path, "string", "agent.json must have skill_path");
  assert.ok(agentData.repository && agentData.repository.url, "agent.json must have repository.url");

  assert.equal(fs.existsSync(path.join(root, agentData.skill_path)), true, "agent.json skill_path must exist on disk");

  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(agentData.version, pkgJson.version, "agent.json version must match package.json");
  assert.ok(pkgJson.files.includes(".well-known/"), "package.json files must include .well-known/");
  assert.ok(pkgJson.files.includes("llms.txt"), "package.json files must include llms.txt");
  assert.ok(pkgJson.files.includes("llms-full.txt"), "package.json files must include llms-full.txt");
});

test("loopInit copies all loop-pack files into workspace/.clawsub-loop and returns cron lines", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-loop-"));
  const result = loopInit({ workspace: tmpDir });

  assert.equal(result.dryRun, false);
  assert.equal(result.destDir, path.join(tmpDir, ".clawsub-loop"));
  assert.equal(result.copied.length, 6);

  const expectedFiles = [
    "SKILL.md",
    "templates/BACKLOG.md",
    "templates/worker-prompt.md",
    "templates/fix-prompt.md",
    "templates/review-prompt.md",
    "templates/standup.md",
  ];

  for (const file of expectedFiles) {
    const dest = path.join(tmpDir, ".clawsub-loop", file);
    assert.ok(fs.existsSync(dest), `${file} must be copied`);
    assert.ok(fs.readFileSync(dest, "utf8").length > 0, `${file} must not be empty`);
  }

  assert.ok(Array.isArray(result.cronLines), "cronLines must be an array");
  assert.ok(result.cronLines.length >= 2, "at least 2 cron lines");
  assert.ok(result.cronLines.some((l) => l.includes(tmpDir)), "cron lines include resolved workspace path");
  assert.ok(result.cronLines.some((l) => /AGENT_CMD/.test(l)), "cron lines include AGENT_CMD placeholder");
});

test("loopInit dry-run returns expected paths without writing files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-loop-dry-"));
  const result = loopInit({ workspace: tmpDir, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.copied.length, 6);
  assert.ok(!fs.existsSync(result.destDir), "dry-run must not create destDir");
  assert.ok(result.copied.every((p) => p.startsWith(result.destDir)), "all paths are under destDir");
});

test("loopInit skips existing files and an edited BACKLOG.md survives re-run", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-loop-skip-"));
  loopInit({ workspace: tmpDir });

  const backlogPath = path.join(tmpDir, ".clawsub-loop", "templates", "BACKLOG.md");
  const edited = "# My custom backlog\n| MY-1 | custom task | high | todo |\n";
  fs.writeFileSync(backlogPath, edited, "utf8");

  const result2 = loopInit({ workspace: tmpDir });
  assert.equal(fs.readFileSync(backlogPath, "utf8"), edited, "edited BACKLOG.md must not be overwritten");
  assert.ok(result2.skipped.some((p) => p.endsWith("BACKLOG.md")), "BACKLOG.md must appear in skipped");
  assert.ok(result2.copied.length + result2.skipped.length === 6, "copied + skipped === total files");
});

test("loopInit resolves relative workspace to absolute and quotes paths in cron lines", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-loop-abs-"));
  const relPath = path.relative(process.cwd(), tmpDir);
  const result = loopInit({ workspace: relPath, dryRun: true });

  assert.ok(path.isAbsolute(result.destDir), "destDir must be absolute");
  assert.ok(result.cronLines.some((l) => l.includes(`'${tmpDir}'`)), "cron lines must single-quote the absolute workspace path");
});

test("loopInit force=true overwrites an edited file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-loop-force-"));
  loopInit({ workspace: tmpDir });

  const backlogPath = path.join(tmpDir, ".clawsub-loop", "templates", "BACKLOG.md");
  fs.writeFileSync(backlogPath, "custom content");

  const result = loopInit({ workspace: tmpDir, force: true });
  assert.ok(result.copied.some((p) => p.endsWith("BACKLOG.md")), "BACKLOG.md must be in copied with force=true");
  assert.equal(result.skipped.length, 0, "nothing should be skipped when force=true");
  assert.notEqual(fs.readFileSync(backlogPath, "utf8"), "custom content", "file must be overwritten");
});

test("loopInit cron lines escape percent signs for crontab compatibility", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-loop-cron-"));
  const result = loopInit({ workspace: tmpDir, dryRun: true });
  // Strip leading '# ' to get the actual schedule content (all lines are commented out as examples)
  const scheduleLines = result.cronLines
    .map((l) => l.replace(/^#\s*/, ""))
    .filter((l) => /^[\d*]/.test(l));
  assert.ok(scheduleLines.length >= 1, "at least one schedule line must exist");
  assert.ok(scheduleLines.some((l) => l.includes("%")), "at least one schedule line must contain % (to verify escaping is tested)");
  for (const line of scheduleLines) {
    assert.ok(!/(?<!\\)%/.test(line), `schedule line must not contain unescaped % (crontab treats it as newline): ${line}`);
  }
});

test("CLI loop init --force passes force to loopInit and overwrites files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-cli-force-"));
  loopInit({ workspace: tmpDir });

  const backlogPath = path.join(tmpDir, ".clawsub-loop", "templates", "BACKLOG.md");
  fs.writeFileSync(backlogPath, "edited");

  spawnSync(process.execPath, ["./bin/clawsub.mjs", "loop", "init", "--workspace", tmpDir, "--force"], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  });

  assert.notEqual(fs.readFileSync(backlogPath, "utf8"), "edited", "--force must overwrite edited file via CLI");
});

test("fixture-driven: each cli-error fixture classifies and parses correctly", () => {
  const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/cli-errors");
  const nowRef = new Date(2026, 10, 25, 10, 0); // Nov 25 2026 10:00 AM

  const table = [
    { file: "claude-not-logged-in.txt",       isQuota: false, isAuth: true,  parsed: null },
    { file: "claude-oauth-refresh-failed.txt", isQuota: false, isAuth: true,  parsed: null },
    { file: "claude-request-rejected-429.txt", isQuota: true,  isAuth: false, parsed: null },
    { file: "claude-session-limit.txt",        isQuota: true,  isAuth: false, parsed: null },
    { file: "claude-weekly-limit.txt",         isQuota: true,  isAuth: false,
      parsed: { day: 1, hours: 0, minutes: 0 } },
    { file: "codex-invalid-api-key.txt",       isQuota: false, isAuth: true,  parsed: null },
    { file: "codex-refresh-token-failed.txt",  isQuota: false, isAuth: true,  parsed: null },
    { file: "codex-try-again-at.txt",          isQuota: true,  isAuth: false,
      parsed: { hours: 15, minutes: 45 } },
    { file: "codex-usage-limit.txt",           isQuota: true,  isAuth: false,
      parsed: { month: 10, date: 28, hours: 15, minutes: 45 } },
  ];

  for (const { file, isQuota, isAuth, parsed } of table) {
    const text = fs.readFileSync(path.join(fixtureDir, file), "utf8");
    assert.equal(isQuotaError(text), isQuota, `${file}: isQuota should be ${isQuota}`);
    assert.equal(isAuthError(text), isAuth, `${file}: isAuth should be ${isAuth}`);
    if (parsed) {
      const result = parseResetTime(text, nowRef);
      assert.ok(result, `${file}: parseResetTime should return a date`);
      assert.ok(result > nowRef, `${file}: parsed time must be in the future`);
      if (parsed.day !== undefined) assert.equal(result.getDay(), parsed.day, `${file}: wrong weekday`);
      if (parsed.month !== undefined) assert.equal(result.getMonth(), parsed.month, `${file}: wrong month`);
      if (parsed.date !== undefined) assert.equal(result.getDate(), parsed.date, `${file}: wrong date`);
      if (parsed.hours !== undefined) assert.equal(result.getHours(), parsed.hours, `${file}: wrong hours`);
      if (parsed.minutes !== undefined) assert.equal(result.getMinutes(), parsed.minutes, `${file}: wrong minutes`);
    }
  }
});

test("parseResetTime: Codex cross-midnight 'Try again at 1:00 AM' at 23:00 rolls to next day", () => {
  const now = new Date(2026, 10, 25, 23, 0); // Nov 25 2026 11pm
  const result = parseResetTime("Try again at 1:00 AM", now);
  assert.ok(result, "should return a date");
  assert.equal(result.getHours(), 1);
  assert.equal(result.getMinutes(), 0);
  assert.equal(result.getDate(), 26, "should be Nov 26");
  assert.ok(result > now, "result must be in the future");
});

test("parseResetTime: Codex year-boundary 'Try again at Jan 2nd, 2027 3:45 PM' parsed in December 2026", () => {
  const now = new Date(2026, 11, 20, 10, 0); // Dec 20 2026
  const result = parseResetTime("Try again at Jan 2nd, 2027 3:45 PM", now);
  assert.ok(result, "should return a date");
  assert.equal(result.getFullYear(), 2027);
  assert.equal(result.getMonth(), 0);
  assert.equal(result.getDate(), 2);
  assert.equal(result.getHours(), 15);
  assert.equal(result.getMinutes(), 45);
  assert.ok(result > now, "result must be in the future");
});

test("routePrompt does not trigger auth_expired when exitCode=0 and stdout contains auth text", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = { chain: ["claude"], workspace: "/tmp", quietWindows: [], quotaReservationWindows: [] };
  const runner = () => ({
    stdout: "To answer your question: auth_expired tokens cause invalid API key errors. Not logged in is a common mistake.",
    stderr: "",
    exitCode: 0,
    latencyMs: 10,
  });
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, true, "should succeed despite auth text in successful stdout");
  assert.equal(result.attempts[0].status, "ok");
  assert.equal(state.providers.claude?.status, "healthy");
});

test("runDoctor reports auth_expired providers with remediation command from state", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doc-auth-"));
  const expiredState = {
    providers: {
      claude: {
        status: "auth_expired",
        cooldownUntil: new Date(Date.now() + 6 * 3600_000).toISOString(),
        remediation: "openclaw models auth login --provider claude --force",
      },
    },
    savings: { providers: {}, firstRecordedAt: null, lastRecordedAt: null },
  };
  fs.writeFileSync(path.join(tmpDir, "clawsub-state.json"), JSON.stringify(expiredState));

  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir });
  assert.ok(
    report.issues.some((i) => /claude/.test(i) && /auth_expired/.test(i)),
    "Expected auth_expired issue for claude"
  );
  assert.ok(
    report.recommendations.some((r) => r === "openclaw models auth login --provider claude --force"),
    "Expected exact auth login command for claude"
  );
});

test("routePrompt preserves auth_expired status and remediation on second-turn cooldown skip", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = { chain: ["claude"], workspace: "/tmp", quietWindows: [], quotaReservationWindows: [] };
  const authRunner = () => ({
    stdout: "",
    stderr: "OAuth token refresh failed: token expired",
    exitCode: 1,
    latencyMs: 10,
  });
  // Turn 1: claude fails with auth error
  routePrompt("hello", { now, state, config, runner: authRunner });
  assert.equal(state.providers.claude?.status, "auth_expired");

  // Turn 2 (1 min later): claude still in 6h cooldown
  const turn2 = routePrompt("world", {
    now: new Date(now.getTime() + 60_000),
    state,
    config,
    runner: authRunner,
  });
  assert.equal(turn2.ok, false, "single-provider chain, still cooling");
  const skipped = turn2.attempts[0];
  assert.equal(skipped.status, "auth_expired", "skipped attempt must carry auth_expired status");
  assert.ok(
    skipped.remediation?.includes("openclaw models auth login"),
    "skipped attempt must include remediation"
  );
  assert.ok(
    turn2.output.includes("openclaw models auth login --provider claude --force"),
    "human-readable output must reference remediation"
  );
});

test("docs/SOCIALIZATION.md contains awesome-list PR kit entries and agent outreach playbooks", () => {
  const socPath = fileURLToPath(new URL("../docs/SOCIALIZATION.md", import.meta.url));
  assert.ok(fs.existsSync(socPath), "docs/SOCIALIZATION.md must exist");
  const content = fs.readFileSync(socPath, "utf8");

  assert.ok(content.includes("## 5. Awesome-list PR Kit"), "SOCIALIZATION.md must contain Section 5 heading");

  const repoUrl = "https://github.com/ecimionatto/openclaw-sub";
  for (const list of ["awesome-openclaw", "awesome-claude-code", "awesome-mcp-servers"]) {
    const headingIdx = content.indexOf(`### ${list}`);
    assert.ok(headingIdx !== -1, `SOCIALIZATION.md must contain a ### ${list} subsection`);
    const sliceStart = headingIdx + `### ${list}`.length;
    const rest = content.slice(sliceStart);
    const nextHeadingMatch = rest.search(/\n##+ [A-Za-z0-9]/);
    const slice = nextHeadingMatch === -1 ? rest : rest.slice(0, nextHeadingMatch);
    assert.ok(
      slice.includes(`[openclaw-sub](${repoUrl})`),
      `${list} entry must include the full markdown link [openclaw-sub](${repoUrl})`
    );
    assert.ok(slice.includes("Suggested PR title"), `${list} subsection must have a Suggested PR title`);
    assert.ok(slice.includes("Suggested PR body"), `${list} subsection must have a Suggested PR body`);
  }

  assert.ok(content.includes("## 6."), "SOCIALIZATION.md must contain Section 6 heading");
  const sec6Start = content.indexOf("## 6.");
  const afterSec6 = content.slice(sec6Start);
  const nextSecHeading = afterSec6.search(/\n## \d/);
  const sec6 = nextSecHeading === -1 ? afterSec6 : afterSec6.slice(0, nextSecHeading);
  assert.ok(sec6.includes("openclaw-sub"), "Section 6 fenced block must reference openclaw-sub");
  assert.ok(
    sec6.includes("npx openclaw-sub init"),
    "Section 6 must include the npx quick-start command"
  );
  assert.ok(
    sec6.includes("CLAUDE.md") || sec6.includes("AGENTS.md"),
    "Section 6 must reference CLAUDE.md or AGENTS.md"
  );
});

test("community contribution files exist and contain required sections", () => {
  const contributing = fs.readFileSync(fileURLToPath(new URL("../CONTRIBUTING.md", import.meta.url)), "utf8");
  assert.ok(contributing.includes("buildCommand"), "CONTRIBUTING.md must document buildCommand");
  assert.ok(contributing.includes("checkAuth"), "CONTRIBUTING.md must document checkAuth");
  assert.ok(contributing.includes("checkHeadlessSafety"), "CONTRIBUTING.md must document checkHeadlessSafety");
  assert.ok(contributing.includes("src/providers.mjs"), "CONTRIBUTING.md must reference src/providers.mjs");

  const bugReport = fs.readFileSync(fileURLToPath(new URL("../.github/ISSUE_TEMPLATE/bug_report.md", import.meta.url)), "utf8");
  assert.ok(bugReport.includes("name: Bug report"), "bug_report.md must have frontmatter name");
  assert.ok(bugReport.includes("Steps to reproduce"), "bug_report.md must include reproduction steps");

  const newProvider = fs.readFileSync(fileURLToPath(new URL("../.github/ISSUE_TEMPLATE/new_provider.md", import.meta.url)), "utf8");
  assert.ok(newProvider.includes("name: New provider adapter"), "new_provider.md must have frontmatter name");
  assert.ok(newProvider.includes("buildCommand"), "new_provider.md must reference buildCommand checklist");
  assert.ok(newProvider.includes("src/providers.mjs"), "new_provider.md must reference src/providers.mjs");
});

// CS-20: Flexible chain config tests

test("normalizeChain: converts plain strings to { provider } objects", () => {
  const result = normalizeChain(["claude", "codex", "agy"]);
  assert.deepEqual(result, [
    { provider: "claude", optional: false },
    { provider: "codex", optional: false },
    { provider: "agy", optional: false },
  ]);
});

test("normalizeChain: parses 'provider:model' strings", () => {
  const result = normalizeChain(["claude:opus", "claude:sonnet", "codex"]);
  assert.equal(result[0].provider, "claude");
  assert.equal(result[0].model, "opus");
  assert.equal(result[1].provider, "claude");
  assert.equal(result[1].model, "sonnet");
  assert.equal(result[2].provider, "codex");
  assert.equal(result[2].model, undefined);
});

test("normalizeChain: parses '?' suffix as optional", () => {
  const result = normalizeChain(["claude", "agy?"]);
  assert.equal(result[0].optional, false);
  assert.equal(result[1].provider, "agy");
  assert.equal(result[1].optional, true);
});

test("normalizeChain: passes through object entries with defaults", () => {
  const result = normalizeChain([{ provider: "claude", model: "opus" }, { provider: "codex", optional: true }]);
  assert.equal(result[0].provider, "claude");
  assert.equal(result[0].model, "opus");
  assert.equal(result[0].optional, false);
  assert.equal(result[1].optional, true);
});

test("normalizeChain: 'provider:model?' combines model and optional", () => {
  const result = normalizeChain(["claude:opus?"]);
  assert.equal(result[0].provider, "claude");
  assert.equal(result[0].model, "opus");
  assert.equal(result[0].optional, true);
});

test("validateConfig: empty chain returns error", () => {
  const errors = validateConfig({ chain: [] });
  assert.ok(errors.some((e) => /empty/.test(e)));
});

test("validateConfig: unknown provider returns error", () => {
  const errors = validateConfig({ chain: ["claude", "nonexistent"] }, PROVIDERS);
  assert.ok(errors.some((e) => /nonexistent/.test(e)));
});

test("validateConfig: duplicate identical entries returns error", () => {
  const errors = validateConfig({ chain: ["claude", "claude"] });
  assert.ok(errors.some((e) => /Duplicate/.test(e)));
});

test("validateConfig: same provider with different models is allowed", () => {
  const errors = validateConfig({ chain: ["claude:opus", "claude:sonnet"] });
  assert.equal(errors.length, 0);
});

test("validateConfig: valid chain returns no errors", () => {
  const errors = validateConfig({ chain: ["claude", "codex", "agy"] });
  assert.equal(errors.length, 0);
});

test("routePrompt: object chain entries pass per-entry model to buildCommand", () => {
  const receivedOpts = [];
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", model: "claude-opus-4-5" }],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const runner = ({ command, args }) => {
    receivedOpts.push({ command, args });
    return { exitCode: 0, stdout: "OK", stderr: "", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, true);
  const claudeCall = receivedOpts.find((c) => c.command === "claude");
  assert.ok(claudeCall, "claude must be called");
  assert.ok(claudeCall.args.includes("claude-opus-4-5"), "per-entry model must be passed to buildCommand");
});

test("routePrompt: same provider twice with different models both attempted on failure", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", model: "opus" }, { provider: "claude", model: "sonnet" }],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  let call = 0;
  const passedModels = [];
  const runner = ({ args }) => {
    call++;
    passedModels.push(args);
    // First call (opus) fails; second call (sonnet) succeeds
    if (call === 1) return { exitCode: 1, stdout: "", stderr: "opus_error", latencyMs: 10 };
    return { exitCode: 0, stdout: "SONNET_OK", stderr: "", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, true);
  assert.equal(result.output, "SONNET_OK");
  assert.equal(call, 2, "both models must be attempted when first fails");
  assert.ok(passedModels[1]?.includes("sonnet"), "second call must use the sonnet model");
});

test("routePrompt: optional entry silently skipped when not installed", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "agy", optional: true }, "codex"],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const runner = ({ command }) => {
    if (command === "codex") return { exitCode: 0, stdout: "CODEX_OK", stderr: "", latencyMs: 10 };
    return { exitCode: 1, stdout: "", stderr: "not found", latencyMs: 10 };
  };
  // agy not in installedProviders → skipped; codex is installed → runs
  const result = routePrompt("hello", {
    now, state, config, runner,
    installedProviders: new Set(["codex"]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "codex");
  assert.equal(result.output, "CODEX_OK");
  const agyAttempt = result.attempts.find((a) => a.provider === "agy");
  assert.ok(agyAttempt, "agy must appear in attempts");
  assert.equal(agyAttempt.status, "skipped_optional_not_installed");
});

test("routePrompt: required entry missing causes error (not skipped)", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", optional: false }, { provider: "codex", optional: false }],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const runner = () => ({ exitCode: 1, stdout: "", stderr: "error", latencyMs: 10 });
  // Neither provider is in installedProviders — but both are required (optional:false)
  // so they must NOT be silently skipped; the router should still attempt them and report exec_error
  const result = routePrompt("hello", {
    now, state, config, runner,
    installedProviders: new Set([]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.attempts.every((a) => a.status !== "skipped_optional_not_installed"),
    "required entries must not be silently skipped even when binary is missing"
  );
  assert.ok(
    result.attempts.some((a) => a.status === "exec_error"),
    "required missing entries must produce exec_error"
  );
});

test("routePrompt: per-entry failover:false stops chain on exec error", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", failover: false }, "codex"],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const commandsSeen = [];
  const runner = ({ command }) => {
    commandsSeen.push(command);
    return { exitCode: 1, stdout: "", stderr: "exec_error", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, false);
  assert.equal(result.failoverStopped, true);
  assert.ok(!commandsSeen.includes("codex"), "codex must NOT be tried when failover:false stops chain");
});

test("routePrompt: top-level failover:false uses only chain[0]", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: ["claude", "codex", "agy"],
    failover: false,
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const commandsSeen = [];
  const runner = ({ command }) => {
    commandsSeen.push(command);
    return { exitCode: 0, stdout: "CLAUDE_OK", stderr: "", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "claude");
  assert.deepEqual(commandsSeen, ["claude"], "only chain[0] must be used in single-agent mode");
});

test("routePrompt: top-level failover:false stops after chain[0] failure (no codex)", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: ["claude", "codex"],
    failover: false,
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const commandsSeen = [];
  const runner = ({ command }) => {
    commandsSeen.push(command);
    return { exitCode: 1, stdout: "", stderr: "failed", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, false);
  assert.deepEqual(commandsSeen, ["claude"], "must only try claude in single-agent mode");
});

test("runDoctor: optional uninstalled provider is info not error", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doctor-opt-"));
  const config = {
    chain: [{ provider: "claude", optional: false }, { provider: "agy", optional: true }],
    workspace: tmpDir,
  };
  saveConfig(config, tmpDir);

  // Use installedProviders to make the test deterministic regardless of host environment
  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir, installedProviders: new Set(["claude"]) });
  const agyProvider = report.providers.find((p) => p.id === "agy");
  assert.ok(agyProvider, "agy must appear in providers");
  assert.equal(agyProvider.optional, true);
  assert.equal(agyProvider.installed, false, "agy is deterministically not installed via installedProviders");
  const issueAboutAgy = report.issues.some((i) => /agy/i.test(i) && /not installed/.test(i));
  assert.equal(issueAboutAgy, false, "optional uninstalled provider must not create an issue");
  const recAboutAgy = report.recommendations.some((r) => /optional/.test(r) && /agy/i.test(r));
  assert.ok(recAboutAgy, "optional uninstalled provider must appear in recommendations");
});

// ── CS-20: new coverage for review issues ────────────────────────────────────

test("routePrompt: per-entry failover:false stops chain on auth failure", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", failover: false }, "codex"],
    workspace: "/tmp", quietWindows: [], quotaReservationWindows: [],
  };
  const commandsSeen = [];
  const runner = ({ command }) => {
    commandsSeen.push(command);
    return { exitCode: 1, stdout: "", stderr: "OAuth token refresh failed: token expired", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, false);
  assert.equal(result.failoverStopped, true, "failoverStopped must be true");
  assert.ok(!commandsSeen.includes("codex"), "codex must NOT be tried when failover:false stops on auth");
});

test("routePrompt: per-entry failover:false stops chain on quota exhaustion", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", failover: false }, "codex"],
    workspace: "/tmp", quietWindows: [], quotaReservationWindows: [],
    defaultCooldownMinutes: 60, cooldownBufferMinutes: 5,
  };
  const commandsSeen = [];
  const runner = ({ command }) => {
    commandsSeen.push(command);
    return {
      exitCode: 1,
      stdout: '{"type":"result","error":"usage_limit_reached: resets 6:50pm"}',
      stderr: "", latencyMs: 10,
    };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, false);
  assert.equal(result.failoverStopped, true, "failoverStopped must be true");
  assert.ok(!commandsSeen.includes("codex"), "codex must NOT be tried when failover:false stops on quota");
});

test("routePrompt: per-entry failover:false stops chain on cooldown fast-skip", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const future = new Date(now.getTime() + 60 * 60_000);
  const state = {
    providers: { claude: { status: "cooldown", cooldownUntil: future.toISOString() } },
  };
  const config = {
    chain: [{ provider: "claude", failover: false }, "codex"],
    workspace: "/tmp", quietWindows: [], quotaReservationWindows: [],
  };
  const commandsSeen = [];
  const runner = ({ command }) => {
    commandsSeen.push(command);
    return { exitCode: 0, stdout: "OK", stderr: "", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, false);
  assert.equal(result.failoverStopped, true, "failoverStopped must be true on cooldown fast-skip");
  assert.ok(!commandsSeen.includes("codex"), "codex must NOT be tried when failover:false stops on cooldown");
});

test("routePrompt rejects empty chain via validateConfig", () => {
  const config = { chain: [], workspace: "/tmp", quietWindows: [], quotaReservationWindows: [] };
  const result = routePrompt("hello", { config, state: { providers: {} } });
  assert.equal(result.ok, false);
  assert.match(result.output, /Invalid config/);
});

test("routePrompt: per-entry args are passed to buildCommand as extraArgs", () => {
  const receivedArgs = [];
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", args: ["--dangerously-skip-permissions"] }],
    workspace: "/tmp", quietWindows: [], quotaReservationWindows: [],
  };
  const runner = ({ args }) => {
    receivedArgs.push(...(args || []));
    return { exitCode: 0, stdout: "OK", stderr: "", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner });
  assert.equal(result.ok, true);
  assert.ok(
    receivedArgs.includes("--dangerously-skip-permissions"),
    "per-entry args must reach the CLI command"
  );
});

test("cmdInit: --chain with model and optional parses correctly via normalizeChain", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-init-chain-"));
  const binPath = fileURLToPath(new URL("../bin/clawsub.mjs", import.meta.url));
  spawnSync(
    process.execPath,
    [binPath, "init", "--chain", "claude:opus,codex,agy?"],
    { env: { ...process.env, CLAWSUB_HOME: tmpDir }, encoding: "utf8" }
  );
  const configPath = path.join(tmpDir, "clawsub.json");
  assert.ok(fs.existsSync(configPath), "clawsub.json must be written");
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(saved.chain.length, 3);
  assert.equal(saved.chain[0].provider, "claude");
  assert.equal(saved.chain[0].model, "opus");
  assert.equal(saved.chain[1].provider ?? saved.chain[1], "codex");
  const agyEntry = typeof saved.chain[2] === "string" ? { provider: saved.chain[2] } : saved.chain[2];
  assert.equal(agyEntry.provider, "agy");
  assert.equal(agyEntry.optional, true);
});

test("cmdInit: --no-failover saves failover:false; re-init without it removes failover:false", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-reinit-failover-"));
  const binPath = fileURLToPath(new URL("../bin/clawsub.mjs", import.meta.url));

  // First init with --no-failover
  spawnSync(
    process.execPath,
    [binPath, "init", "--chain", "claude", "--no-failover"],
    { env: { ...process.env, CLAWSUB_HOME: tmpDir }, encoding: "utf8" }
  );
  const configPath = path.join(tmpDir, "clawsub.json");
  const withNoFailover = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(withNoFailover.failover, false, "--no-failover must save failover:false");

  // Re-init without --no-failover must remove failover:false
  spawnSync(
    process.execPath,
    [binPath, "init", "--chain", "claude,codex"],
    { env: { ...process.env, CLAWSUB_HOME: tmpDir }, encoding: "utf8" }
  );
  const withFailoverRestored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(
    withFailoverRestored.failover !== false,
    "re-init without --no-failover must not keep failover:false"
  );
});

// ── CS-20 fix-up: configureOpenClawJson ─────────────────────────────────────

test("configureOpenClawJson: basic chain emits primary+fallbacks shape", () => {
  const result = configureOpenClawJson(["claude", "codex", "agy"]);
  assert.deepEqual(result, {
    agents: {
      defaults: {
        model: {
          primary: "claude",
          fallbacks: ["codex", "agy"],
        },
      },
    },
  });
});

test("configureOpenClawJson: chain with per-entry models uses provider/model IDs", () => {
  const result = configureOpenClawJson([
    { provider: "claude", model: "opus" },
    { provider: "codex" },
    { provider: "agy", model: "pro" },
  ]);
  assert.equal(result.agents.defaults.model.primary, "claude/opus");
  assert.deepEqual(result.agents.defaults.model.fallbacks, ["codex", "agy/pro"]);
});

test("configureOpenClawJson: single-entry chain emits primary with no fallbacks key", () => {
  const result = configureOpenClawJson(["claude"]);
  assert.ok("primary" in result.agents.defaults.model, "primary must be present");
  assert.ok(!("fallbacks" in result.agents.defaults.model), "fallbacks must be absent for single entry");
});

test("configureOpenClawJson: failover:false omits fallbacks even with multi-entry chain", () => {
  const result = configureOpenClawJson(["claude", "codex", "agy"], { failover: false });
  assert.equal(result.agents.defaults.model.primary, "claude");
  assert.ok(!("fallbacks" in result.agents.defaults.model), "fallbacks must be absent when failover is off");
});

test("configureOpenClawJson: same provider twice with different models both appear", () => {
  const result = configureOpenClawJson([
    { provider: "claude", model: "opus" },
    { provider: "claude", model: "sonnet" },
  ]);
  assert.equal(result.agents.defaults.model.primary, "claude/opus");
  assert.deepEqual(result.agents.defaults.model.fallbacks, ["claude/sonnet"]);
});

test("configureOpenClawJson: optional entries are included in fallbacks", () => {
  const result = configureOpenClawJson([
    { provider: "claude" },
    { provider: "agy", optional: true },
  ]);
  assert.equal(result.agents.defaults.model.primary, "claude");
  assert.deepEqual(result.agents.defaults.model.fallbacks, ["agy"]);
});

test("configureOpenClawJson: empty chain returns empty object", () => {
  const result = configureOpenClawJson([]);
  assert.deepEqual(result, {});
});

// ── CS-20 fix-up: onlyProvider resolves against configured chain ─────────────

test("routePrompt: onlyProvider resolves model from configured chain entry", () => {
  const receivedOpts = [];
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", model: "opus" }, { provider: "codex" }],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const runner = ({ command, args }) => {
    receivedOpts.push({ command, args });
    return { exitCode: 0, stdout: "OK", stderr: "", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner, onlyProvider: "claude" });
  assert.equal(result.ok, true);
  const call = receivedOpts[0];
  assert.ok(call, "runner must be called");
  assert.ok(call.args.includes("opus"), "model from chain entry must be passed");
  assert.equal(state.providers["claude:opus"]?.status, "healthy", "state key must include model");
});

test("routePrompt: onlyProvider for provider not in chain falls back to plain provider entry", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: ["codex"],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const runner = () => ({ exitCode: 0, stdout: "OK", stderr: "", latencyMs: 10 });
  const result = routePrompt("hello", { now, state, config, runner, onlyProvider: "claude" });
  assert.equal(result.ok, true);
});

// ── CS-20 fix-up: cmdInit normalizes existing string config ──────────────────

test("cmdInit: re-init without --chain normalizes existing string-encoded chain entries", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-reinit-str-"));
  const binPath = fileURLToPath(new URL("../bin/clawsub.mjs", import.meta.url));

  // Write a config with legacy string entries (as if hand-edited or from an old version)
  const configPath = path.join(tmpDir, "clawsub.json");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    chain: ["claude:opus", "agy?"],
    workspace: tmpDir,
  }));

  const result = spawnSync(
    process.execPath,
    [binPath, "init"],
    { env: { ...process.env, CLAWSUB_HOME: tmpDir }, encoding: "utf8" }
  );
  assert.equal(result.status, 0, `init must exit 0: ${result.stderr}`);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const entries = normalizeChain(saved.chain);
  assert.equal(entries[0].provider, "claude");
  assert.equal(entries[0].model, "opus");
  assert.equal(entries[1].provider, "agy");
  assert.equal(entries[1].optional, true);
});

// ── CS-20 fix-up: cmdInit failover preservation ──────────────────────────────

test("cmdInit: re-init without --chain or --no-failover preserves existing failover:false", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-failover-preserve-"));
  const binPath = fileURLToPath(new URL("../bin/clawsub.mjs", import.meta.url));
  const configPath = path.join(tmpDir, "clawsub.json");

  spawnSync(
    process.execPath,
    [binPath, "init", "--chain", "claude", "--no-failover"],
    { env: { ...process.env, CLAWSUB_HOME: tmpDir }, encoding: "utf8" }
  );
  const after1 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(after1.failover, false, "--no-failover must save failover:false");

  spawnSync(
    process.execPath,
    [binPath, "init"],
    { env: { ...process.env, CLAWSUB_HOME: tmpDir }, encoding: "utf8" }
  );
  const after2 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(after2.failover, false, "re-init without flags must preserve failover:false");
});

test("cmdInit: re-init with --chain but no --no-failover removes failover:false", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-failover-chain-"));
  const binPath = fileURLToPath(new URL("../bin/clawsub.mjs", import.meta.url));
  const configPath = path.join(tmpDir, "clawsub.json");

  spawnSync(
    process.execPath,
    [binPath, "init", "--chain", "claude", "--no-failover"],
    { env: { ...process.env, CLAWSUB_HOME: tmpDir }, encoding: "utf8" }
  );

  spawnSync(
    process.execPath,
    [binPath, "init", "--chain", "claude,codex"],
    { env: { ...process.env, CLAWSUB_HOME: tmpDir }, encoding: "utf8" }
  );
  const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(after.failover !== false, "new --chain without --no-failover must re-enable failover");
});

// ── CS-20 fix-up: runDoctor chain validation ─────────────────────────────────

test("runDoctor: reports config error for chain with unknown provider", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doctor-unk-"));
  const badConfig = { chain: ["claude", "unknownprovider123"], workspace: tmpDir };
  saveConfig(badConfig, tmpDir);
  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir, installedProviders: new Set(["claude"]) });
  assert.ok(
    report.issues.some((i) => /unknownprovider123/.test(i)),
    "runDoctor must report unknown provider from validateConfig"
  );
});

test("runDoctor: required missing provider is an issue, not a recommendation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-doctor-req-"));
  const config = {
    chain: [{ provider: "claude", optional: false }],
    workspace: tmpDir,
  };
  saveConfig(config, tmpDir);

  // claude is required but not installed
  const report = runDoctor({ stateDir: tmpDir, homeDir: tmpDir, installedProviders: new Set([]) });
  const claudeProvider = report.providers.find((p) => p.id === "claude");
  assert.ok(claudeProvider, "claude must appear in providers");
  assert.equal(claudeProvider.optional, false);
  assert.equal(claudeProvider.installed, false);
  const issueAboutClaude = report.issues.some((i) => /claude/i.test(i) && /not installed/.test(i));
  assert.ok(issueAboutClaude, "required missing provider must produce an issue (not a recommendation)");
});

// ── CS-20 fix-up: validateConfig type checks ─────────────────────────────────

test("validateConfig: non-array chain returns clear type error", () => {
  const errors = validateConfig({ chain: "claude,codex" });
  assert.ok(errors.length > 0, "must return errors for non-array chain");
  assert.ok(errors[0].includes('"chain"'), `error must mention "chain": ${errors[0]}`);
});

test("validateConfig: failover:\"false\" (string) returns clear type error", () => {
  const errors = validateConfig({ chain: ["claude"], failover: "false" });
  assert.ok(errors.length > 0, "must return errors for string failover");
  assert.ok(errors.some((e) => e.includes('"failover"')), `error must mention "failover": ${errors}`);
});

test("validateConfig: non-array args per entry returns error", () => {
  const errors = validateConfig({ chain: [{ provider: "claude", args: "--flag" }] });
  assert.ok(errors.length > 0, "must return errors for non-array args");
  assert.ok(errors.some((e) => e.includes('"args"')), `error must mention "args": ${errors}`);
});

test("normalizeChain: non-array input returns empty array", () => {
  assert.deepStrictEqual(normalizeChain("claude,codex"), []);
  assert.deepStrictEqual(normalizeChain(null), []);
  assert.deepStrictEqual(normalizeChain(undefined), []);
});

// ── CS-20 fix-up: heartbeat NO_REPLY on failover:false + cooldown/auth/quota ──

test("routePrompt: heartbeat on failover:false + cooldown fast-skip returns NO_REPLY", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const cooldownUntil = new Date(now.getTime() + 60 * 60_000).toISOString();
  const state = { providers: { claude: { status: "cooldown", cooldownUntil } } };
  const config = {
    chain: [{ provider: "claude", failover: false }],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const hbPrompt = "[OpenClaw heartbeat poll]\nIf nothing needs attention, reply NO_REPLY.";
  const result = routePrompt(hbPrompt, { now, state, config, runner: () => {} });
  assert.equal(result.output, "NO_REPLY", "heartbeat on failover:false cooldown must return NO_REPLY");
  assert.equal(result.ok, true);
  assert.equal(result.failoverStopped, true);
});

test("routePrompt: heartbeat on failover:false + auth failure returns NO_REPLY", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", failover: false }],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const hbPrompt = "[OpenClaw heartbeat poll]\nIf nothing needs attention, reply NO_REPLY.";
  const runner = () => ({
    exitCode: 1,
    stdout: "",
    stderr: "OAuth token refresh failed — not logged in",
    latencyMs: 10,
  });
  const result = routePrompt(hbPrompt, { now, state, config, runner });
  assert.equal(result.output, "NO_REPLY", "heartbeat on failover:false auth failure must return NO_REPLY");
  assert.equal(result.ok, true);
  assert.equal(result.failoverStopped, true);
});

test("routePrompt: heartbeat on failover:false + quota exhaustion returns NO_REPLY", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", failover: false }],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const hbPrompt = "[OpenClaw heartbeat poll]\nIf nothing needs attention, reply NO_REPLY.";
  const runner = () => ({
    exitCode: 1,
    stdout: "usage_limit_reached — try again in 120 minutes",
    stderr: "",
    latencyMs: 10,
  });
  const result = routePrompt(hbPrompt, { now, state, config, runner });
  assert.equal(result.output, "NO_REPLY", "heartbeat on failover:false quota must return NO_REPLY");
  assert.equal(result.ok, true);
  assert.equal(result.failoverStopped, true);
});

// ── CS-20 fix-up: onlyProvider with model-qualified key ──────────────────────

test("routePrompt: onlyProvider with model-qualified key selects correct model entry", () => {
  const receivedArgs = [];
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [
      { provider: "claude", model: "opus" },
      { provider: "claude", model: "sonnet" },
    ],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const runner = ({ args }) => {
    receivedArgs.push(args);
    return { exitCode: 0, stdout: "OK", stderr: "", latencyMs: 10 };
  };
  const result = routePrompt("hello", { now, state, config, runner, onlyProvider: "claude:sonnet" });
  assert.equal(result.ok, true);
  assert.ok(receivedArgs[0]?.includes("sonnet"), "must use sonnet model");
  assert.ok(!receivedArgs[0]?.includes("opus"), "must NOT use opus model");
  assert.equal(state.providers["claude:sonnet"]?.status, "healthy");
});

// ── CS-20 fix-up: heartbeat NO_REPLY on failover:false + exec error ───────────

test("routePrompt: heartbeat on failover:false + exec error returns NO_REPLY", () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { providers: {} };
  const config = {
    chain: [{ provider: "claude", failover: false }, "codex"],
    workspace: "/tmp",
    quietWindows: [],
    quotaReservationWindows: [],
  };
  const hbPrompt = "[OpenClaw heartbeat poll]\nIf nothing needs attention, reply NO_REPLY.";
  const runner = () => ({ exitCode: 1, stdout: "", stderr: "unexpected crash", latencyMs: 10 });
  const result = routePrompt(hbPrompt, { now, state, config, runner });
  assert.equal(result.output, "NO_REPLY", "heartbeat on failover:false exec error must return NO_REPLY");
  assert.equal(result.ok, true);
  assert.equal(result.failoverStopped, true);
});

// ── CS-20 fix-up: configureOpenClawJson per-entry failover:false ──────────────

test("configureOpenClawJson: per-entry failover:false truncates chain, no fallbacks emitted", () => {
  const result = configureOpenClawJson([
    { provider: "claude", failover: false },
    "codex",
    "agy",
  ]);
  assert.deepStrictEqual(result, { agents: { defaults: { model: { primary: "claude" } } } });
});

test("configureOpenClawJson: per-entry failover:false mid-chain truncates at that entry", () => {
  const result = configureOpenClawJson([
    "claude",
    { provider: "codex", failover: false },
    "agy",
  ]);
  assert.deepStrictEqual(result, {
    agents: { defaults: { model: { primary: "claude", fallbacks: ["codex"] } } },
  });
});

// ── CS-20 fix-up: cmdInit/cmdTest lowercase only provider part ────────────────

test("cmdInit: --chain with mixed-case model ID preserves model case", () => {
  const binPath = fileURLToPath(new URL("../bin/clawsub.mjs", import.meta.url));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  try {
    spawnSync(process.execPath, [binPath, "init", "--chain", "claude:Opus-4,codex"], {
      env: { ...process.env, CLAWSUB_HOME: tmpDir },
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, "clawsub.json"), "utf8"));
    const claudeEntry = normalizeChain(cfg.chain).find((e) => e.provider === "claude");
    assert.equal(claudeEntry?.model, "Opus-4", "model case must be preserved");
    assert.equal(claudeEntry?.provider, "claude", "provider must be lowercase");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cmdInit/cmdTest: lowercase normalizer preserves mixed-case model IDs", () => {
  // Unit-test the normalizer logic used by cmdInit and cmdTest
  const normalize = (s) => {
    const t = s.trim();
    const ci = t.indexOf(":");
    return ci === -1 ? t.toLowerCase() : t.slice(0, ci).toLowerCase() + t.slice(ci);
  };
  assert.equal(normalize("CLAUDE:Opus-4"), "claude:Opus-4");
  assert.equal(normalize("Claude:SONNET-3"), "claude:SONNET-3");
  assert.equal(normalize("AGY"), "agy");
  const parsed = normalizeChain(["claude:Opus-4,codex"].flatMap((s) => s.split(",")).map(normalize));
  assert.equal(parsed[0]?.provider, "claude");
  assert.equal(parsed[0]?.model, "Opus-4", "model case must be preserved");
});
