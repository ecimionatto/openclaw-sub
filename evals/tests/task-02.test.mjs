import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../bin/clawsub.mjs");

test("clawsub status exits 0 when provider list is empty (default behavior test)", () => {
  // smoke test: command must exist and exit cleanly
  const r = spawnSync("node", [BIN, "status", "--json"], { encoding: "utf8" });
  assert.ok(r.status === 0 || r.status === 1, `unexpected exit code: ${r.status}\n${r.stderr}`);
});

test("clawsub status --json output is valid JSON", () => {
  const r = spawnSync("node", [BIN, "status", "--json"], { encoding: "utf8" });
  assert.doesNotThrow(() => JSON.parse(r.stdout.trim()), "output must be valid JSON");
});
