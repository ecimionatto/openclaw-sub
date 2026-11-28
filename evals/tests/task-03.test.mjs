import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../bin/clawsub.mjs");

test("eval metrics with tick-only log exits 0 and reports 0 events", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-task03-"));
  const logFile = path.join(tmpDir, "tick-only.log");
  fs.writeFileSync(
    logFile,
    [
      "2026-01-01 00:00:01 tick: worker heartbeat",
      "2026-01-01 00:00:31 tick: worker heartbeat",
      "2026-01-01 00:01:01 tick: worker heartbeat",
    ].join("\n") + "\n"
  );
  try {
    const r = spawnSync(process.execPath, [BIN, "eval", "metrics", "--log", logFile], { encoding: "utf8" });
    assert.equal(r.status, 0, `expected exit 0 for tick-only log; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.trim().includes("No events found."), `expected "No events found." in stdout: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test("eval metrics with tick-only log --json exits 0 and returns valid JSON", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-task03-"));
  const logFile = path.join(tmpDir, "tick-only.log");
  fs.writeFileSync(
    logFile,
    "2026-01-01 00:00:01 tick: worker heartbeat\n2026-01-01 00:00:31 tick: worker heartbeat\n"
  );
  try {
    const r = spawnSync(process.execPath, [BIN, "eval", "metrics", "--log", logFile, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `expected exit 0 for tick-only log --json; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, {}, `expected exactly {} for tick-only log --json: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});
