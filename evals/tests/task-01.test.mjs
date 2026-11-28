import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../bin/clawsub.mjs");

test("clawsub version --json outputs valid JSON with version and node keys", () => {
  const r = spawnSync("node", [BIN, "version", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, `exit code: ${r.status}\n${r.stderr}`);
  const obj = JSON.parse(r.stdout.trim());
  assert.ok("version" in obj, "missing 'version' key");
  assert.ok("node" in obj, "missing 'node' key");
  assert.match(obj.version, /^\d+\.\d+\.\d+/);
});

test("clawsub version (no flag) outputs human-readable string", () => {
  const r = spawnSync("node", [BIN, "version"], { encoding: "utf8" });
  assert.equal(r.status, 0, `exit code: ${r.status}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout.trim(), /^\{/);
});

test("clawsub help includes --json in version signature", () => {
  const r = spawnSync("node", [BIN, "help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /version.*--json/);
});
