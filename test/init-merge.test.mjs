import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeOpenClawJson } from "../src/openclaw-config.mjs";

function makeTmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-init-merge-"));
  fs.mkdirSync(path.join(dir, ".openclaw"), { recursive: true });
  return dir;
}

test("writeOpenClawJson: creates openclaw.json with clawsub keys when absent", () => {
  const homeDir = makeTmpHome();
  const result = writeOpenClawJson(homeDir);
  assert.equal(result.changed, true);
  assert.equal(result.backupPath, null, "no backup when file was absent");
  const written = JSON.parse(fs.readFileSync(result.jsonPath, "utf8"));
  assert.equal(written.plugins.entries.anthropic.config.sessionCatalog.enabled, false);
  assert.equal(written.plugins.entries.codex.config.sessionCatalog.enabled, false);
});

test("writeOpenClawJson: preserves user keys while fixing sessionCatalog", () => {
  const homeDir = makeTmpHome();
  const existing = {
    userSetting: "keep-me",
    plugins: {
      entries: {
        anthropic: { config: { sessionCatalog: { enabled: true }, otherKey: "preserve" } },
        codex: { config: { sessionCatalog: { enabled: true } } },
        customProvider: { config: { someKey: "user-value" } },
      },
      load: { paths: ["/some/user/plugin"] },
    },
  };
  const jsonPath = path.join(homeDir, ".openclaw", "openclaw.json");
  fs.writeFileSync(jsonPath, JSON.stringify(existing, null, 2) + "\n", "utf8");

  const result = writeOpenClawJson(homeDir);
  assert.equal(result.changed, true);
  assert.ok(result.backupPath, "backup should be written when file changed");
  assert.ok(fs.existsSync(result.backupPath), "backup file must exist on disk");

  const written = JSON.parse(fs.readFileSync(result.jsonPath, "utf8"));
  assert.equal(written.userSetting, "keep-me", "top-level user key preserved");
  assert.equal(written.plugins.entries.anthropic.config.sessionCatalog.enabled, false);
  assert.equal(written.plugins.entries.anthropic.config.otherKey, "preserve", "other provider config preserved");
  assert.equal(written.plugins.entries.codex.config.sessionCatalog.enabled, false);
  assert.equal(written.plugins.entries.customProvider.config.someKey, "user-value", "user provider preserved");
  assert.deepEqual(written.plugins.load.paths, ["/some/user/plugin"], "load paths preserved");
});

test("writeOpenClawJson: second run is a no-op (file unchanged, no backup)", () => {
  const homeDir = makeTmpHome();
  const result1 = writeOpenClawJson(homeDir);
  assert.equal(result1.changed, true);

  const statBefore = fs.statSync(result1.jsonPath);
  const result2 = writeOpenClawJson(homeDir);
  assert.equal(result2.changed, false);
  assert.equal(result2.backupPath, null, "no backup on no-op");
  const statAfter = fs.statSync(result1.jsonPath);
  assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "file not touched on second run");
});

test("writeOpenClawJson: does not overwrite malformed openclaw.json", () => {
  const homeDir = makeTmpHome();
  const jsonPath = path.join(homeDir, ".openclaw", "openclaw.json");
  fs.writeFileSync(jsonPath, "{ invalid json !!!", "utf8");

  assert.throws(
    () => writeOpenClawJson(homeDir),
    /parse|JSON/i,
    "should throw on malformed JSON"
  );
  assert.equal(fs.readFileSync(jsonPath, "utf8"), "{ invalid json !!!", "malformed file not overwritten");
});

test("writeOpenClawJson: backup filename contains timestamp and is in .openclaw dir", () => {
  const homeDir = makeTmpHome();
  const jsonPath = path.join(homeDir, ".openclaw", "openclaw.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ old: "data" }), "utf8");

  const result = writeOpenClawJson(homeDir);
  assert.ok(result.backupPath.startsWith(path.join(homeDir, ".openclaw")), "backup in .openclaw dir");
  assert.match(result.backupPath, /openclaw\.json\.bak\.\d+/, "backup has timestamp suffix");
});
