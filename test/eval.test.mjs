import { parseBoard } from "../src/eval/metrics.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { computeMetrics, parseLog } from "../src/eval/metrics.mjs";
import { listTasks, loadTask, replayDryRun } from "../src/eval/replay.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "clawsub.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const TASKS_DIR = path.join(__dirname, "..", "evals", "tasks");

const FIXTURE_LOG = `\
2026-11-26T10:00:00Z repo:org/repo task:T-01 spawned
2026-11-26T10:01:00Z repo:org/repo task:T-01 opened
2026-11-26T10:02:00Z repo:org/repo task:T-01 reviewed -> APPROVE
2026-11-26T10:05:00Z repo:org/repo task:T-01 merged
2026-11-26T11:00:00Z repo:org/repo task:T-02 spawned
2026-11-26T11:01:00Z repo:org/repo task:T-02 opened
2026-11-26T11:02:00Z repo:org/repo task:T-02 reviewed -> FIX
2026-11-26T11:03:00Z repo:org/repo task:T-02 fix lint attempt 1
2026-11-26T11:05:00Z repo:org/repo task:T-02 reviewed -> APPROVE
2026-11-26T11:10:00Z repo:org/repo task:T-02 merged
2026-11-26T12:00:00Z repo:org/repo task:T-03 spawned
2026-11-26T12:01:00Z repo:org/repo task:T-03 opened
2026-11-26T12:02:00Z repo:org/repo task:T-03 reviewed -> BLOCK
`;

test("parseLog parses events correctly", () => {
  const events = parseLog(FIXTURE_LOG);
  assert.equal(events.length, 13);
  assert.equal(events[0].repo, "org/repo");
  assert.equal(events[0].taskId, "T-01");
  assert.equal(events[0].event, "spawned");
  assert.ok(events[0].ts instanceof Date);
});

test("parseLog skips blank lines and unrecognized lines", () => {
  const text = `
2026-11-26T10:00:00Z repo:a/b task:T-1 spawned

not a valid line
2026-11-26T10:01:00Z repo:a/b task:T-1 merged
`;
  const events = parseLog(text);
  assert.equal(events.length, 2);
});

test("parseLog handles lines without timestamp", () => {
  const text = `repo:a/b task:T-1 spawned\nrepo:a/b task:T-1 merged\n`;
  const events = parseLog(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].ts, null);
});

test("computeMetrics: first-pass APPROVE rate", () => {
  const events = parseLog(FIXTURE_LOG);
  const m = computeMetrics(events)["org/repo"];
  assert.equal(m.firstPassApproveRate, 33.3);
});

test("computeMetrics: fix runs per merged PR", () => {
  const events = parseLog(FIXTURE_LOG);
  const m = computeMetrics(events)["org/repo"];
  assert.equal(m.fixRunsPerMergedPR, 0.5);
});

test("computeMetrics: fix convergence rate", () => {
  const events = parseLog(FIXTURE_LOG);
  const m = computeMetrics(events)["org/repo"];
  assert.equal(m.fixConvergenceRate, 100);
});

test("computeMetrics: rescope rate is 0 when no rescopes", () => {
  const events = parseLog(FIXTURE_LOG);
  const m = computeMetrics(events)["org/repo"];
  assert.equal(m.rescopeRate, 0);
});

test("computeMetrics: median time-to-merge", () => {
  const events = parseLog(FIXTURE_LOG);
  const m = computeMetrics(events)["org/repo"];
  assert.equal(m.medianTimeToMergeMinutes, 7.5);
});

test("computeMetrics: repo filter isolates one repo", () => {
  const twoRepoLog = FIXTURE_LOG + `2026-11-26T15:00:00Z repo:other/repo task:X-1 spawned\n`;
  const events = parseLog(twoRepoLog);
  const all = computeMetrics(events);
  assert.ok("org/repo" in all);
  assert.ok("other/repo" in all);
  const filtered = computeMetrics(events, { repo: "org/repo" });
  assert.ok(!("other/repo" in filtered));
  assert.ok("org/repo" in filtered);
});

test("computeMetrics: rescope rate with rescoped task", () => {
  const logWithRescope = `\
2026-11-26T10:00:00Z repo:org/r task:T-1 spawned
2026-11-26T10:01:00Z repo:org/r task:T-1 rescope
2026-11-26T10:02:00Z repo:org/r task:T-2 spawned
`;
  const events = parseLog(logWithRescope);
  const m = computeMetrics(events)["org/r"];
  assert.equal(m.rescopeRate, 50);
});

test("computeMetrics: fix convergence rate is below 100 when FIX task never merges", () => {
  const logWithUnmergedFix = `\
2026-11-26T10:00:00Z repo:org/r task:T-1 spawned
2026-11-26T10:01:00Z repo:org/r task:T-1 reviewed -> FIX
2026-11-26T10:02:00Z repo:org/r task:T-1 fix lint attempt 1
2026-11-26T10:03:00Z repo:org/r task:T-1 reviewed -> APPROVE
2026-11-26T10:05:00Z repo:org/r task:T-1 merged
2026-11-26T11:00:00Z repo:org/r task:T-2 spawned
2026-11-26T11:01:00Z repo:org/r task:T-2 reviewed -> FIX
`;
  const events = parseLog(logWithUnmergedFix);
  const m = computeMetrics(events)["org/r"];
  assert.ok(m.fixConvergenceRate < 100, `expected rate < 100 but got ${m.fixConvergenceRate}`);
  assert.equal(m.fixConvergenceRate, 50);
});

test("computeMetrics: returns null metrics for empty task set", () => {
  const m = computeMetrics([], {})["org/r"];
  assert.equal(m, undefined);
});

test("loadTask loads a valid task", () => {
  const task = loadTask("task-01", { tasksDir: TASKS_DIR });
  assert.equal(task.id, "task-01");
  assert.ok(typeof task.title === "string");
  assert.ok(typeof task.prompt === "string");
  assert.ok(Array.isArray(task.acceptanceCriteria));
  assert.ok(task.acceptanceCriteria.length > 0);
});

test("loadTask throws for missing task", () => {
  assert.throws(
    () => loadTask("does-not-exist", { tasksDir: TASKS_DIR }),
    /Task not found/
  );
});

test("listTasks returns all seed task ids", () => {
  const ids = listTasks({ tasksDir: TASKS_DIR });
  assert.ok(ids.includes("task-01"));
  assert.ok(ids.includes("task-02"));
  assert.ok(ids.includes("task-03"));
  assert.equal(ids.length, 3);
});

test("replayDryRun returns a 5-step plan without model calls", () => {
  const plan = replayDryRun("task-01", { tasksDir: TASKS_DIR });
  assert.equal(plan.taskId, "task-01");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.plan.length, 5);
  const actions = plan.plan.map((s) => s.action);
  assert.deepEqual(actions, ["spawn", "prompt", "review", "verify", "report"]);
});

test("replayDryRun verify step lists all acceptance criteria", () => {
  const plan = replayDryRun("task-01", { tasksDir: TASKS_DIR });
  const verifyStep = plan.plan.find((s) => s.action === "verify");
  const task = loadTask("task-01", { tasksDir: TASKS_DIR });
  assert.deepEqual(verifyStep.criteria, task.acceptanceCriteria);
});

test("replayDryRun plan step 3 names the hidden acceptance test file", () => {
  const plan = replayDryRun("task-01", { tasksDir: TASKS_DIR });
  const reviewStep = plan.plan.find((s) => s.action === "review");
  assert.ok(reviewStep.detail.includes("evals/tests/task-01.test.mjs"), `expected test file in detail: ${reviewStep.detail}`);
  assert.ok(plan.acceptanceTestFile, "expected acceptanceTestFile on plan");
  assert.match(plan.acceptanceTestCmd, /node --test/);
});

test("loadTask rejects taskId with path traversal characters", () => {
  assert.throws(
    () => loadTask("../etc/passwd", { tasksDir: TASKS_DIR }),
    /Invalid task id/
  );
});

test("eval metrics CLI --log --json outputs valid JSON", () => {
  const r = spawnSync("node", [BIN, "eval", "metrics", "--log", path.join(FIXTURES, "work-tick.txt"), "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const m = JSON.parse(r.stdout);
  assert.ok("ecimionatto/openclaw-sub" in m);
});

test("eval metrics CLI missing --log exits 1", () => {
  const r = spawnSync("node", [BIN, "eval", "metrics"], { encoding: "utf8" });
  assert.equal(r.status, 1);
});

test("eval replay CLI --task --json outputs valid plan", () => {
  const r = spawnSync("node", [BIN, "eval", "replay", "--task", "task-01", "--tasks-dir", TASKS_DIR, "--json", "--dry-run"], { encoding: "utf8" });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.taskId, "task-01");
  assert.equal(plan.dryRun, true);
});

test("eval replay CLI missing --task exits 1", () => {
  const r = spawnSync("node", [BIN, "eval", "replay"], { encoding: "utf8" });
  assert.equal(r.status, 1);
});

test("eval unknown subcommand exits 1", () => {
  const r = spawnSync("node", [BIN, "eval", "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
});

test("metrics fixture file parses correctly", () => {
  const text = fs.readFileSync(path.join(FIXTURES, "work-tick.txt"), "utf8");
  const events = parseLog(text);
  assert.ok(events.length > 0);
  const m = computeMetrics(events)["ecimionatto/openclaw-sub"];
  assert.ok(m != null);
  assert.equal(m.taskCount, 4);
  assert.equal(m.firstPassApproveRate, 25);
});

test("eval replay CLI without --dry-run exits 1 with helpful message", () => {
  const r = spawnSync("node", [BIN, "eval", "replay", "--task", "task-01", "--tasks-dir", TASKS_DIR, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dry-run/);
});

test("parseLog: fix regex matches 'fix attempt 1' (no middle word)", () => {
  const text = `2026-11-26T10:00:00Z repo:a/b task:T-1 fix attempt 1\n`;
  const events = parseLog(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "fix attempt 1");
});

test("computeMetrics: events with trailing detail are not silently dropped", () => {
  const log = `\
2026-11-26T10:00:00Z repo:a/b task:T-1 spawned PR#42
2026-11-26T10:01:00Z repo:a/b task:T-1 reviewed -> FIX (details)
2026-11-26T10:02:00Z repo:a/b task:T-1 fix lint attempt 1
2026-11-26T10:03:00Z repo:a/b task:T-1 reviewed -> APPROVE (details)
2026-11-26T10:05:00Z repo:a/b task:T-1 merged main
2026-11-26T10:10:00Z repo:a/b task:T-2 spawned
2026-11-26T10:11:00Z repo:a/b task:T-2 rescope reason:too-big
`;
  const events = parseLog(log);
  const m = computeMetrics(events)["a/b"];
  assert.equal(m.taskCount, 2, "both tasks counted");
  assert.equal(m.rescopeRate, 50, "rescoped task counted despite trailing detail on rescope event");
  assert.equal(m.fixConvergenceRate, 100, "fix→merge pipeline works with trailing detail on spawned/merged/review");
  assert.equal(m.firstPassApproveRate, 0, "FIX review not counted as first-pass approve");
});

test("replayDryRun resolves acceptanceTest relative to tasksDir, not PKG_ROOT", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-eval-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true }));
  const testFile = path.join(tmpDir, "acceptance.test.mjs");
  fs.writeFileSync(testFile, "// stub\n");
  const task = {
    id: "tmp-01",
    title: "Tmp",
    prompt: "do thing",
    acceptanceCriteria: ["pass"],
    acceptanceTest: "acceptance.test.mjs",
  };
  fs.writeFileSync(path.join(tmpDir, "tmp-01.json"), JSON.stringify(task));
  const plan = replayDryRun("tmp-01", { tasksDir: tmpDir });
  assert.equal(plan.acceptanceTestFile, testFile, "resolves relative to tasksDir");
});

test("parseLog and parseBoard parse real ops/loop work-tick.log lines + BACKLOG.md board", () => {
  const logText = fs.readFileSync(path.join(FIXTURES, "real-work-tick.txt"), "utf8");
  const boardText = fs.readFileSync(path.join(FIXTURES, "backlog-board.md"), "utf8");
  const events = parseLog(logText);
  const boardRows = parseBoard(boardText);

  assert.equal(boardRows.length, 3);
  assert.equal(boardRows[0].merged, true);
  assert.equal(boardRows[2].rescoped, true);

  const m = computeMetrics(events, { boardRows })["ecimionatto/openclaw-sub"];
  assert.ok(m);
  assert.equal(m.taskCount, 3);
  assert.equal(m.firstPassApproveRate, 33.3);
  assert.equal(m.fixRunsPerMergedPR, 0.5);
  assert.equal(m.fixConvergenceRate, 50);
  assert.equal(m.rescopeRate, 33.3);
});

test("eval metrics CLI human-readable text output and --board option work", () => {
  const r = spawnSync(
    "node",
    [
      BIN,
      "eval",
      "metrics",
      "--log",
      path.join(FIXTURES, "real-work-tick.txt"),
      "--board",
      path.join(FIXTURES, "backlog-board.md"),
    ],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("Repo: ecimionatto/openclaw-sub  (3 tasks)"));
  assert.match(r.stdout, /First-pass APPROVE rate:\s+33\.3%/);
  assert.match(r.stdout, /Fix runs per merged PR:\s+0\.5/);
});

test("eval metrics --repo with no matching events warns on stderr and exits 0", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  const logFile = path.join(tmpDir, "log.txt");
  fs.writeFileSync(logFile, "2026-01-01T00:00:00Z repo:org/exists task:T-1 spawned\n");
  try {
    const r = spawnSync("node", [BIN, "eval", "metrics", "--log", logFile, "--repo", "org/nonexistent"], { encoding: "utf8" });
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /warning.*no events for repo/i, `expected warning in stderr: ${JSON.stringify(r.stderr)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test("eval metrics --repo that matches events exits 0 with no warning", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  const logFile = path.join(tmpDir, "log.txt");
  fs.writeFileSync(logFile, "2026-01-01T00:00:00Z repo:org/exists task:T-1 spawned\n");
  try {
    const r = spawnSync("node", [BIN, "eval", "metrics", "--log", logFile, "--repo", "org/exists"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});
