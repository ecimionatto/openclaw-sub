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
import { loadBatonStore, saveBatonStore, syncNativeTranscripts, recordCompletedTurn } from "../src/baton.mjs";

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
  const savedFilePath = Object.keys(saved.harvestWatermarks)[0];
  assert.ok(savedFilePath, "harvestWatermarks should contain at least one file path");
  assert.ok(saved.harvestWatermarks[savedFilePath] > 0, "per-file watermark should be advanced past line 0");

  // Re-sync should import nothing new (watermark-based, not just dedup)
  const store2 = loadBatonStore(tmpDir);
  const { imported: imported2 } = syncNativeTranscripts(store2, {
    sessionKey: "main",
    transcriptDirs: { claude: claudeDir, codex: "/nonexistent", gemini: "/nonexistent" },
  });
  assert.equal(imported2, 0, "Re-sync should not re-import already-seen turns via watermarks");
});

test("transcript-harvester: tool_result in native Claude message.content is filtered, not imported as user prompt", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-toolresult-"));
  const claudeDir = path.join(tmpDir, "claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, "s.jsonl"),
    [
      // Native Claude shape: tool_result in message.content — should be filtered
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "result text" }] } }),
      JSON.stringify({ role: "user", content: "Real question" }),
      JSON.stringify({ role: "assistant", content: "Real answer", stop_reason: "end_turn" }),
    ].join("\n") + "\n"
  );

  const { pairs } = harvestProvider("claude", claudeDir, {});
  assert.equal(pairs.length, 1, "tool_result entry should be filtered, not imported as a user turn");
  assert.equal(pairs[0].prompt, "Real question");
  assert.equal(pairs[0].response, "Real answer");
});

test("transcript-harvester: user,user,assistant skips retried prompt and continues pairing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-useruserast-"));
  const claudeDir = path.join(tmpDir, "claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, "s.jsonl"),
    [
      JSON.stringify({ role: "user", content: "First attempt (retried)" }),
      JSON.stringify({ role: "user", content: "Second attempt" }),
      JSON.stringify({ role: "assistant", content: "Reply to second", stop_reason: "end_turn" }),
      JSON.stringify({ role: "user", content: "Follow-up" }),
      JSON.stringify({ role: "assistant", content: "Follow-up reply", stop_reason: "end_turn" }),
    ].join("\n") + "\n"
  );

  const { pairs } = harvestProvider("claude", claudeDir, {});
  assert.equal(pairs.length, 2, "should emit pairs for both user2+assistant and follow-up");
  assert.equal(pairs[0].prompt, "Second attempt");
  assert.equal(pairs[1].prompt, "Follow-up");
});

test("transcript-harvester: holds back incomplete trailing pair, captures second assistant on next sync", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-partial-"));
  const claudeDir = path.join(tmpDir, "claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const filePath = path.join(claudeDir, "s.jsonl");

  // Sync 1: user + partial assistant — stop_reason: null signals in-flight in native Claude format
  fs.writeFileSync(filePath,
    [
      JSON.stringify({ role: "user", content: "Long question" }),
      JSON.stringify({ role: "assistant", content: "Partial...", stop_reason: null }),
    ].join("\n") + "\n"
  );

  const wm1 = {};
  const { pairs: pairs1, watermarks: wm2 } = harvestProvider("claude", claudeDir, wm1);
  assert.equal(pairs1.length, 0, "in-flight assistant (stop_reason:null at EOF) should be held back");

  // Sync 2: second assistant chunk appended, this one has stop_reason
  fs.writeFileSync(filePath,
    [
      JSON.stringify({ role: "user", content: "Long question" }),
      JSON.stringify({ role: "assistant", content: "Partial...", stop_reason: null }),
      JSON.stringify({ role: "assistant", content: "...completed.", stop_reason: "end_turn" }),
    ].join("\n") + "\n"
  );

  const { pairs: pairs2 } = harvestProvider("claude", claudeDir, wm2);
  assert.equal(pairs2.length, 1, "completed pair should be emitted after second assistant chunk");
  assert.ok(pairs2[0].response.includes("Partial..."), "response should include first chunk");
  assert.ok(pairs2[0].response.includes("...completed."), "response should include second chunk");
});

test("syncNativeTranscripts: dedup strips handoff header before comparing fingerprints", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-dedup-hdr-"));
  const store = { sessions: {}, harvestWatermarks: {} };

  // Simulate a turn already in the baton from clawsub run/exec with a handoff header
  const decoratedPrompt = "[CLAWSUB SHARED SESSION BATON — HANDOFF TO CLAUDE]\nYou are continuing...\n[END CLAWSUB SESSION BATON]\nPlain question";
  recordCompletedTurn(store, { provider: "claude", prompt: decoratedPrompt, response: "The answer" });

  // Native transcript has the plain (undecorated) prompt
  const claudeDir = path.join(tmpDir, "claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "s.jsonl"),
    [
      JSON.stringify({ role: "user", content: "Plain question" }),
      JSON.stringify({ role: "assistant", content: "The answer", stop_reason: "end_turn" }),
    ].join("\n") + "\n"
  );

  const { imported } = syncNativeTranscripts(store, {
    sessionKey: "main",
    transcriptDirs: { claude: claudeDir, codex: "/nonexistent", gemini: "/nonexistent" },
  });
  assert.equal(imported, 0, "plain prompt from transcript should match decorated stored prompt after stripping header");
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

test("transcript-harvester: watermark does not advance past in-flight user turn (mid-sync)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-inflight-"));
  const sessionDir = path.join(tmpDir, "proj-inflight");
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "session.jsonl");

  const userLine = JSON.stringify({ role: "user", content: "In-flight question", timestamp: "2026-01-01T11:00:00Z" });
  // Write only the user line (no assistant reply yet)
  fs.writeFileSync(filePath, userLine + "\n");

  const { pairs: pairs1, watermarks: wm1 } = harvestProvider("claude", tmpDir, {});
  assert.equal(pairs1.length, 0, "No pairs when assistant hasn't replied yet");
  // Watermark must stay before the user line so next sync re-reads it
  assert.equal((wm1[filePath] || 0), 0, "Watermark must not advance past in-flight user turn");

  // Now the assistant replies
  const assistantLine = JSON.stringify({ role: "assistant", content: "Here is the answer", timestamp: "2026-01-01T11:00:02Z" });
  fs.appendFileSync(filePath, assistantLine + "\n");

  const { pairs: pairs2, watermarks: wm2 } = harvestProvider("claude", tmpDir, wm1);
  assert.equal(pairs2.length, 1, "Pair must be harvested after assistant replies");
  assert.equal(pairs2[0].prompt, "In-flight question");
  assert.equal(pairs2[0].response, "Here is the answer");
  assert.equal(wm2[filePath], 2);
});

test("transcript-harvester: unterminated trailing line is excluded from watermark", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-partial-"));
  const sessionDir = path.join(tmpDir, "proj-partial");
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "session.jsonl");

  const line1 = JSON.stringify({ role: "user", content: "Complete user", timestamp: "2026-01-01T12:00:00Z" });
  const line2 = JSON.stringify({ role: "assistant", content: "Complete reply", timestamp: "2026-01-01T12:00:01Z" });
  const partial = '{"role":"user","content":"Partial writ';

  // Write two complete lines then a partial line (no trailing newline)
  fs.writeFileSync(filePath, [line1, line2, partial].join("\n"));

  const { pairs, watermarks } = harvestProvider("claude", tmpDir, {});
  assert.equal(pairs.length, 1, "Should parse the complete pair");
  assert.equal(pairs[0].prompt, "Complete user");
  // Watermark must not include the partial line index
  assert.equal(watermarks[filePath], 2);

  // Simulate completing the write
  fs.writeFileSync(filePath, [line1, line2, partial + '", "timestamp":"2026-01-01T12:00:02Z"}'].join("\n") + "\n");
  const { pairs: pairs2 } = harvestProvider("claude", tmpDir, watermarks);
  assert.equal(pairs2.length, 0, "Partial user line without reply should not create a pair");
});

test("transcript-harvester: tool_result entries are skipped and not imported as user prompts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-toolresult-"));
  const sessionDir = path.join(tmpDir, "proj-tool");
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "session.jsonl");

  const lines = [
    JSON.stringify({ role: "user", content: "Real question", timestamp: "2026-01-01T13:00:00Z" }),
    // tool_result entry — role='user' but content is a tool result array
    JSON.stringify({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "tool output" }], timestamp: "2026-01-01T13:00:01Z" }),
    JSON.stringify({ role: "assistant", content: "Real answer", timestamp: "2026-01-01T13:00:02Z" }),
    // isMeta entry
    JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "meta content" }, timestamp: "2026-01-01T13:00:03Z" }),
  ].join("\n") + "\n";

  fs.writeFileSync(filePath, lines);

  const { pairs } = harvestProvider("claude", tmpDir, {});
  assert.equal(pairs.length, 1, "Only one real pair should be imported");
  assert.equal(pairs[0].prompt, "Real question");
  assert.equal(pairs[0].response, "Real answer");
});

test("transcript-harvester: consecutive assistant messages are aggregated into one response", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-multiasst-"));
  const sessionDir = path.join(tmpDir, "proj-multi");
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "session.jsonl");

  const lines = [
    JSON.stringify({ role: "user", content: "Multi-step question", timestamp: "2026-01-01T14:00:00Z" }),
    JSON.stringify({ role: "assistant", content: "Step 1 response", timestamp: "2026-01-01T14:00:01Z" }),
    JSON.stringify({ role: "assistant", content: "Step 2 response", timestamp: "2026-01-01T14:00:02Z" }),
  ].join("\n") + "\n";

  fs.writeFileSync(filePath, lines);

  const { pairs } = harvestProvider("claude", tmpDir, {});
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].prompt, "Multi-step question");
  assert.match(pairs[0].response, /Step 1 response/);
  assert.match(pairs[0].response, /Step 2 response/);
});

test("transcript-harvester: Codex rollout response_item/payload shape is parsed", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-codex-rollout-"));
  const sessionDir = path.join(tmpDir, "sess-rollout");
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "session.jsonl");

  const lines = [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "Rollout user question" }, timestamp: "2026-01-01T15:00:00Z" }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "Rollout assistant answer" }, timestamp: "2026-01-01T15:00:01Z" }),
  ].join("\n") + "\n";

  fs.writeFileSync(filePath, lines);

  const { pairs } = harvestProvider("codex", tmpDir, {});
  assert.equal(pairs.length, 1, "Codex rollout payload shape must be parsed");
  assert.equal(pairs[0].prompt, "Rollout user question");
  assert.equal(pairs[0].response, "Rollout assistant answer");
  assert.equal(pairs[0].provider, "codex");
});

test("transcript-harvester: Antigravity USER_INPUT/PLANNER_RESPONSE types are mapped correctly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-antigravity-"));
  const brainDir = path.join(tmpDir, "sess-antigravity");
  fs.mkdirSync(brainDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: "USER_INPUT", content: "Antigravity user message", timestamp: "2026-01-01T16:00:00Z" }),
    JSON.stringify({ type: "PLANNER_RESPONSE", content: "Antigravity planner reply", timestamp: "2026-01-01T16:00:01Z" }),
  ].join("\n") + "\n";

  fs.writeFileSync(path.join(brainDir, "transcript.jsonl"), lines);

  const { pairs } = harvestProvider("gemini", tmpDir, {});
  assert.equal(pairs.length, 1, "Antigravity USER_INPUT/PLANNER_RESPONSE must be mapped to user/assistant");
  assert.equal(pairs[0].prompt, "Antigravity user message");
  assert.equal(pairs[0].response, "Antigravity planner reply");
});

test("transcript-harvester: Gemini provider only reads transcript.jsonl files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-gemini-filter-"));
  const brainDir = path.join(tmpDir, "sess-brain");
  fs.mkdirSync(brainDir, { recursive: true });

  const transcriptContent = [
    JSON.stringify({ role: "user", parts: [{ text: "Real gemini question" }], timestamp: "2026-01-01T17:00:00Z" }),
    JSON.stringify({ role: "model", parts: [{ text: "Real gemini answer" }], timestamp: "2026-01-01T17:00:01Z" }),
  ].join("\n") + "\n";

  // Write transcript.jsonl (should be read) and other.jsonl (should be ignored)
  fs.writeFileSync(path.join(brainDir, "transcript.jsonl"), transcriptContent);
  fs.writeFileSync(path.join(brainDir, "other.jsonl"),
    JSON.stringify({ role: "user", parts: [{ text: "Should be ignored" }] }) + "\n" +
    JSON.stringify({ role: "model", parts: [{ text: "Should also be ignored" }] }) + "\n"
  );

  const { pairs } = harvestProvider("gemini", tmpDir, {});
  assert.equal(pairs.length, 1, "Gemini provider must only read transcript.jsonl");
  assert.equal(pairs[0].prompt, "Real gemini question");
});

test("syncNativeTranscripts deduplicates turns already recorded by clawsub run", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-dedup-"));
  const claudeDir = path.join(tmpDir, "claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const content = [
    JSON.stringify({ role: "user", content: "Duplicate prompt", timestamp: "2026-01-01T10:00:00Z", sessionId: "s1" }),
    JSON.stringify({ role: "assistant", content: "Duplicate response", timestamp: "2026-01-01T10:00:01Z", sessionId: "s1" }),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(claudeDir, "s.jsonl"), content);

  const store = loadBatonStore(tmpDir);

  // Simulate a turn already recorded by clawsub run/exec
  recordCompletedTurn(store, {
    sessionKey: "main",
    provider: "claude",
    prompt: "Duplicate prompt",
    response: "Duplicate response",
  });
  assert.equal(store.sessions.main.turnCounter, 1);

  // Now sync — should detect duplicate and not add it again
  const { imported } = syncNativeTranscripts(store, {
    sessionKey: "main",
    transcriptDirs: { claude: claudeDir, codex: "/nonexistent", gemini: "/nonexistent" },
  });

  assert.equal(imported, 0, "Duplicate turn must not be re-imported");
  assert.equal(store.sessions.main.turnCounter, 1, "Turn counter must not increase for duplicates");
});

test("syncNativeTranscripts sorts by timestamp and bounds initial backfill", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-backfill-"));
  const claudeDir = path.join(tmpDir, "claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  // Create 5 turn pairs with timestamps in reverse order in the file
  const lines = [];
  for (let i = 5; i >= 1; i--) {
    lines.push(JSON.stringify({ role: "user", content: `Q${i}`, timestamp: `2026-01-0${i}T10:00:00Z` }));
    lines.push(JSON.stringify({ role: "assistant", content: `A${i}`, timestamp: `2026-01-0${i}T10:00:01Z` }));
  }
  fs.writeFileSync(path.join(claudeDir, "s.jsonl"), lines.join("\n") + "\n");

  const store = loadBatonStore(tmpDir);
  // maxInitialBackfill=3 — should import the 3 newest turns (Q3, Q4, Q5)
  const { imported } = syncNativeTranscripts(store, {
    sessionKey: "main",
    transcriptDirs: { claude: claudeDir, codex: "/nonexistent", gemini: "/nonexistent" },
    maxInitialBackfill: 3,
  });

  assert.equal(imported, 3, "Should import at most maxInitialBackfill turns on initial sync");
  // Turns should be in chronological order (oldest first within the import)
  const prompts = store.sessions.main.turns.map((t) => t.prompt);
  assert.equal(prompts[0], "Q3");
  assert.equal(prompts[1], "Q4");
  assert.equal(prompts[2], "Q5");
});

test("transcript-harvester: native nested message.stop_reason triggers in-flight holdback", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-nested-sr-"));
  const claudeDir = path.join(tmpDir, "sess");
  fs.mkdirSync(claudeDir, { recursive: true });
  const filePath = path.join(claudeDir, "s.jsonl");

  // Native Claude shape: stop_reason nested under message — null means in-flight
  fs.writeFileSync(filePath,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Native question" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Native partial", stop_reason: null } }),
    ].join("\n") + "\n"
  );

  const { pairs: pairs1, watermarks: wm1 } = harvestProvider("claude", claudeDir, {});
  assert.equal(pairs1.length, 0, "nested message.stop_reason:null must trigger in-flight holdback");

  // Append a completed assistant with stop_reason:end_turn nested under message
  fs.writeFileSync(filePath,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Native question" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Native partial", stop_reason: null } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Native final", stop_reason: "end_turn" } }),
    ].join("\n") + "\n"
  );

  const { pairs: pairs2 } = harvestProvider("claude", claudeDir, wm1);
  assert.equal(pairs2.length, 1, "completed native pair must be emitted after terminal stop_reason");
  assert.ok(pairs2[0].response.includes("Native partial"));
  assert.ok(pairs2[0].response.includes("Native final"));
});

test("transcript-harvester: tool_use stop_reason is non-terminal, held back; two-sync tool-loop emits one complete pair", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-toolloop-"));
  const claudeDir = path.join(tmpDir, "sess");
  fs.mkdirSync(claudeDir, { recursive: true });
  const filePath = path.join(claudeDir, "s.jsonl");

  // Sync 1: user asks, assistant replies with mixed text+tool_use and stop_reason:'tool_use' (non-terminal)
  fs.writeFileSync(filePath,
    [
      JSON.stringify({ role: "user", content: "What is 2+2?" }),
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Let me calculate." }, { type: "tool_use", id: "t1", name: "calc", input: {} }], stop_reason: "tool_use" }),
    ].join("\n") + "\n"
  );

  const { pairs: pairs1, watermarks: wm2 } = harvestProvider("claude", claudeDir, {});
  assert.equal(pairs1.length, 0, "stop_reason:tool_use is non-terminal and must be held back");

  // Sync 2: tool_result + final assistant answer appended
  fs.writeFileSync(filePath,
    [
      JSON.stringify({ role: "user", content: "What is 2+2?" }),
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Let me calculate." }, { type: "tool_use", id: "t1", name: "calc", input: {} }], stop_reason: "tool_use" }),
      JSON.stringify({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "4" }] }),
      JSON.stringify({ role: "assistant", content: "The answer is 4.", stop_reason: "end_turn" }),
    ].join("\n") + "\n"
  );

  const { pairs: pairs2 } = harvestProvider("claude", claudeDir, wm2);
  assert.equal(pairs2.length, 1, "completed tool loop should emit one pair");
  assert.equal(pairs2[0].prompt, "What is 2+2?");
  assert.ok(pairs2[0].response.includes("Let me calculate."), "text from mixed tool_use turn must be preserved");
  assert.ok(pairs2[0].response.includes("The answer is 4."), "final answer must be included");
});

test("transcript-harvester: unreadable subdirectory does not abort the whole sync", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-unreadable-"));
  const readableDir = path.join(tmpDir, "readable");
  const unreadableDir = path.join(tmpDir, "unreadable");
  fs.mkdirSync(readableDir, { recursive: true });
  fs.mkdirSync(unreadableDir, { recursive: true });

  fs.writeFileSync(path.join(readableDir, "s.jsonl"),
    JSON.stringify({ role: "user", content: "Good question" }) + "\n" +
    JSON.stringify({ role: "assistant", content: "Good answer", stop_reason: "end_turn" }) + "\n"
  );
  fs.writeFileSync(path.join(unreadableDir, "s.jsonl"),
    JSON.stringify({ role: "user", content: "Blocked question" }) + "\n" +
    JSON.stringify({ role: "assistant", content: "Blocked answer", stop_reason: "end_turn" }) + "\n"
  );
  fs.chmodSync(unreadableDir, 0o000);

  try {
    const { pairs } = harvestProvider("claude", tmpDir, {});
    assert.equal(pairs.length, 1, "readable dir must still be processed when a sibling subdir is unreadable");
    assert.equal(pairs[0].prompt, "Good question");
  } finally {
    fs.chmodSync(unreadableDir, 0o755);
  }
});
