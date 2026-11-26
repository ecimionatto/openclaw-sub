import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../bin/clawsub.mjs");

test("eval metrics --repo with no matching events warns on stderr and exits 0", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  const logFile = path.join(tmpDir, "log.txt");
  fs.writeFileSync(logFile, "2026-01-01T00:00:00Z repo:org/exists task:T-1 spawned\n");
  try {
    const r = spawnSync(process.execPath, [BIN, "eval", "metrics", "--log", logFile, "--repo", "org/nonexistent"], {
      encoding: "utf8",
    });
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
    const r = spawnSync(process.execPath, [BIN, "eval", "metrics", "--log", logFile, "--repo", "org/exists"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});
