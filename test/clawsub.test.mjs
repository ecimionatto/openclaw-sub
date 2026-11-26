import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAWSUB_VERSION,
  computeCooldownUntil,
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
  runDoctor,
} from "../src/index.mjs";
import { inspectOpenClawJson } from "../src/openclaw-config.mjs";
import { harvestAll, harvestProvider, resolveTranscriptDirs } from "../src/transcript-harvester.mjs";
import { loadBatonStore, saveBatonStore, syncNativeTranscripts } from "../src/baton.mjs";

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

test("transcript-harvester: resolveTranscriptDirs returns overridable paths", () => {
  const dirs = resolveTranscriptDirs({ claude: "/tmp/claude", codex: "/tmp/codex" });
  assert.equal(dirs.claude, "/tmp/claude");
  assert.equal(dirs.codex, "/tmp/codex");
  assert.match(dirs.gemini, /antigravity-cli/);
});

test("transcript-harvester: harvestProvider reads claude-format JSONL and pairs user/assistant turns", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-harvest-"));
  const sessionDir = path.join(tmpDir, "proj123");
  fs.mkdirSync(sessionDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Hello from claude" }] }, sessionId: "s1", createdAt: "2026-01-01T10:00:00Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] }, sessionId: "s1", createdAt: "2026-01-01T10:00:01Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Second question" }] }, sessionId: "s1", createdAt: "2026-01-01T10:00:02Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Second answer" }] }, sessionId: "s1", createdAt: "2026-01-01T10:00:03Z" }),
  ].join("\n");

  const filePath = path.join(sessionDir, "session.jsonl");
  fs.writeFileSync(filePath, lines + "\n");

  const { pairs, watermarks } = harvestProvider("claude", tmpDir, {});
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].provider, "claude");
  assert.equal(pairs[0].prompt, "Hello from claude");
  assert.equal(pairs[0].response, "Hi there!");
  assert.equal(pairs[1].prompt, "Second question");
  assert.equal(pairs[1].response, "Second answer");
  assert.equal(watermarks[filePath], 4);
});

test("transcript-harvester: harvestProvider reads gemini-format JSONL with parts array", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-gemini-"));
  const brainDir = path.join(tmpDir, "brain", "sess-abc");
  fs.mkdirSync(brainDir, { recursive: true });

  const lines = [
    JSON.stringify({ role: "user", parts: [{ text: "What is clawsub?" }], timestamp: "2026-01-01T12:00:00Z" }),
    JSON.stringify({ role: "model", parts: [{ text: "clawsub is a CLI tool." }], timestamp: "2026-01-01T12:00:01Z" }),
  ].join("\n");

  fs.writeFileSync(path.join(brainDir, "transcript.jsonl"), lines + "\n");

  const { pairs } = harvestProvider("gemini", tmpDir, {});
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].provider, "gemini");
  assert.equal(pairs[0].prompt, "What is clawsub?");
  assert.equal(pairs[0].response, "clawsub is a CLI tool.");
});

test("transcript-harvester: harvestProvider reads codex-format JSONL with plain role/content fields", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-codex-"));
  const sessionDir = path.join(tmpDir, "sess-xyz");
  fs.mkdirSync(sessionDir, { recursive: true });

  const lines = [
    JSON.stringify({ role: "user", content: "Explain the baton", timestamp: "2026-01-01T14:00:00Z", session_id: "xyz" }),
    JSON.stringify({ role: "assistant", content: "The baton passes context between providers.", timestamp: "2026-01-01T14:00:02Z", session_id: "xyz" }),
  ].join("\n");

  fs.writeFileSync(path.join(sessionDir, "session.jsonl"), lines + "\n");

  const { pairs } = harvestProvider("codex", tmpDir, {});
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].provider, "codex");
  assert.equal(pairs[0].prompt, "Explain the baton");
  assert.equal(pairs[0].response, "The baton passes context between providers.");
});

test("transcript-harvester: watermarks prevent re-harvesting already-seen turns", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-wm-"));
  const sessionDir = path.join(tmpDir, "proj999");
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "session.jsonl");

  const line1 = JSON.stringify({ role: "user", content: "Turn 1", timestamp: "2026-01-01T10:00:00Z" });
  const line2 = JSON.stringify({ role: "assistant", content: "Reply 1", timestamp: "2026-01-01T10:00:01Z" });
  fs.writeFileSync(filePath, [line1, line2].join("\n") + "\n");

  const { pairs: pairs1, watermarks: wm1 } = harvestProvider("claude", tmpDir, {});
  assert.equal(pairs1.length, 1);
  assert.equal(wm1[filePath], 2);

  // Append more turns
  const line3 = JSON.stringify({ role: "user", content: "Turn 2", timestamp: "2026-01-01T10:01:00Z" });
  const line4 = JSON.stringify({ role: "assistant", content: "Reply 2", timestamp: "2026-01-01T10:01:01Z" });
  fs.appendFileSync(filePath, [line3, line4].join("\n") + "\n");

  // Re-harvest with existing watermarks — should only get new turns
  const { pairs: pairs2, watermarks: wm2 } = harvestProvider("claude", tmpDir, wm1);
  assert.equal(pairs2.length, 1);
  assert.equal(pairs2[0].prompt, "Turn 2");
  assert.equal(wm2[filePath], 4);

  // Re-harvest again with current watermarks — nothing new
  const { pairs: pairs3 } = harvestProvider("claude", tmpDir, wm2);
  assert.equal(pairs3.length, 0);
});

test("transcript-harvester: harvestAll aggregates from multiple provider dirs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-all-"));
  const claudeDir = path.join(tmpDir, "claude");
  const codexDir = path.join(tmpDir, "codex");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, "s.jsonl"),
    [
      JSON.stringify({ role: "user", content: "Claude Q" }),
      JSON.stringify({ role: "assistant", content: "Claude A" }),
    ].join("\n") + "\n"
  );
  fs.writeFileSync(path.join(codexDir, "s.jsonl"),
    [
      JSON.stringify({ role: "user", content: "Codex Q" }),
      JSON.stringify({ role: "assistant", content: "Codex A" }),
    ].join("\n") + "\n"
  );

  const { pairs } = harvestAll({
    transcriptDirs: { claude: claudeDir, codex: codexDir, gemini: path.join(tmpDir, "gemini-missing") },
    watermarks: {},
  });

  assert.equal(pairs.length, 2);
  const providers = pairs.map((p) => p.provider).sort();
  assert.deepEqual(providers, ["claude", "codex"]);
});

test("transcript-harvester: harvestAll tolerates missing or empty dirs", () => {
  const { pairs, watermarks } = harvestAll({
    transcriptDirs: {
      claude: "/nonexistent/claude",
      codex: "/nonexistent/codex",
      gemini: "/nonexistent/gemini",
    },
    watermarks: {},
  });
  assert.equal(pairs.length, 0);
  assert.deepEqual(watermarks, {});
});

test("transcript-harvester: harvestAll skips malformed JSONL lines gracefully", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-malformed-"));
  const claudeDir = path.join(tmpDir, "claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const lines = [
    "{ INVALID JSON !!!",
    JSON.stringify({ role: "user", content: "Valid turn" }),
    JSON.stringify({ role: "assistant", content: "Valid reply" }),
    "{ also broken",
  ].join("\n") + "\n";

  fs.writeFileSync(path.join(claudeDir, "s.jsonl"), lines);

  const { pairs } = harvestAll({
    transcriptDirs: { claude: claudeDir, codex: "/nonexistent", gemini: "/nonexistent" },
    watermarks: {},
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].prompt, "Valid turn");
});

test("syncNativeTranscripts merges harvested turns into baton store and persists watermarks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-sync-"));
  const claudeDir = path.join(tmpDir, "claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, "s.jsonl"),
    [
      JSON.stringify({ role: "user", content: "Synced prompt", timestamp: "2026-01-01T10:00:00Z", sessionId: "native-1" }),
      JSON.stringify({ role: "assistant", content: "Synced response", timestamp: "2026-01-01T10:00:01Z", sessionId: "native-1" }),
    ].join("\n") + "\n"
  );

  const store = loadBatonStore(tmpDir);
  const { imported } = syncNativeTranscripts(store, {
    sessionKey: "main",
    transcriptDirs: { claude: claudeDir, codex: "/nonexistent", gemini: "/nonexistent" },
  });
  saveBatonStore(store, tmpDir);

  assert.equal(imported, 1);
  const saved = loadBatonStore(tmpDir);
  assert.equal(saved.sessions.main.turnCounter, 1);
  assert.equal(saved.sessions.main.turns[0].provider, "claude");
  assert.equal(saved.sessions.main.turns[0].prompt, "Synced prompt");
  assert.match(saved.sessions.main.turns[0].response, /Synced response/);
  assert.ok(saved.harvestWatermarks, "harvestWatermarks should be persisted in baton store");

  // Re-sync should import nothing new
  const { imported: imported2 } = syncNativeTranscripts(saved, {
    sessionKey: "main",
    transcriptDirs: { claude: claudeDir, codex: "/nonexistent", gemini: "/nonexistent" },
  });
  assert.equal(imported2, 0, "Re-sync should not re-import already-seen turns");
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
