import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeChain, KNOWN_PROVIDERS, loadConfig } from "../src/state.mjs";

test("KNOWN_PROVIDERS contains expected provider ids", () => {
  assert.ok(Array.isArray(KNOWN_PROVIDERS));
  for (const p of ["claude", "codex", "agy", "ollama"]) {
    assert.ok(KNOWN_PROVIDERS.includes(p), `missing ${p}`);
  }
});

test("normalizeChain: string entry back-compat", () => {
  const result = normalizeChain({ chain: ["claude", "codex", "agy"] });
  assert.equal(result.chain.length, 3);
  assert.deepEqual(result.chain[0], { key: "claude", provider: "claude", model: undefined, optional: false, failover: undefined, args: undefined });
  assert.deepEqual(result.chain[1], { key: "codex", provider: "codex", model: undefined, optional: false, failover: undefined, args: undefined });
  assert.deepEqual(result.chain[2], { key: "agy", provider: "agy", model: undefined, optional: false, failover: undefined, args: undefined });
});

test("normalizeChain: string entry with model (provider:model)", () => {
  const result = normalizeChain({ chain: ["claude:opus"] });
  assert.equal(result.chain[0].key, "claude:opus");
  assert.equal(result.chain[0].provider, "claude");
  assert.equal(result.chain[0].model, "opus");
  assert.equal(result.chain[0].optional, false);
});

test("normalizeChain: string entry with ? suffix sets optional", () => {
  const result = normalizeChain({ chain: ["agy?"] });
  assert.equal(result.chain[0].provider, "agy");
  assert.equal(result.chain[0].optional, true);
  assert.equal(result.chain[0].key, "agy");
});

test("normalizeChain: string entry with model and ? suffix", () => {
  const result = normalizeChain({ chain: ["claude:opus?"] });
  assert.equal(result.chain[0].key, "claude:opus");
  assert.equal(result.chain[0].provider, "claude");
  assert.equal(result.chain[0].model, "opus");
  assert.equal(result.chain[0].optional, true);
});

test("normalizeChain: object entry with all fields", () => {
  const raw = { provider: "claude", model: "opus", optional: true, failover: false, args: ["--verbose"] };
  const result = normalizeChain({ chain: [raw] });
  assert.deepEqual(result.chain[0], { key: "claude:opus", provider: "claude", model: "opus", optional: true, failover: false, args: ["--verbose"] });
});

test("normalizeChain: object entry minimal (only provider)", () => {
  const result = normalizeChain({ chain: [{ provider: "codex" }] });
  assert.equal(result.chain[0].key, "codex");
  assert.equal(result.chain[0].provider, "codex");
  assert.equal(result.chain[0].model, undefined);
  assert.equal(result.chain[0].optional, false);
});

test("normalizeChain: top-level failover defaults to true", () => {
  const result = normalizeChain({ chain: ["claude"] });
  assert.equal(result.failover, true);
});

test("normalizeChain: top-level failover can be set false", () => {
  const result = normalizeChain({ chain: ["claude"], failover: false });
  assert.equal(result.failover, false);
});

test("normalizeChain: top-level failover true preserved", () => {
  const result = normalizeChain({ chain: ["claude"], failover: true });
  assert.equal(result.failover, true);
});

test("normalizeChain: mixed string and object entries", () => {
  const result = normalizeChain({ chain: ["claude:opus", { provider: "codex" }, "agy?"] });
  assert.equal(result.chain.length, 3);
  assert.equal(result.chain[0].key, "claude:opus");
  assert.equal(result.chain[1].key, "codex");
  assert.equal(result.chain[2].optional, true);
});

test("normalizeChain: throws on empty chain", () => {
  assert.throws(() => normalizeChain({ chain: [] }), /empty/i);
});

test("normalizeChain: throws on missing chain", () => {
  assert.throws(() => normalizeChain({}), /must be an array/i);
});

test("normalizeChain: throws on unknown provider string", () => {
  assert.throws(() => normalizeChain({ chain: ["unknown-provider"] }), /unknown provider/i);
});

test("normalizeChain: throws on unknown provider in object", () => {
  assert.throws(() => normalizeChain({ chain: [{ provider: "gpt4" }] }), /unknown provider/i);
});

test("normalizeChain: throws on exact duplicate string entries", () => {
  assert.throws(() => normalizeChain({ chain: ["claude", "claude"] }), /duplicate/i);
});

test("normalizeChain: throws on exact duplicate with model", () => {
  assert.throws(() => normalizeChain({ chain: ["claude:opus", "claude:opus"] }), /duplicate/i);
});

test("normalizeChain: different models are NOT duplicates", () => {
  const result = normalizeChain({ chain: ["claude:opus", "claude:sonnet"] });
  assert.equal(result.chain.length, 2);
});

test("normalizeChain: provider + provider:model are NOT duplicates (different keys)", () => {
  const result = normalizeChain({ chain: ["claude", "claude:opus"] });
  assert.equal(result.chain.length, 2);
});

test("normalizeChain: preserves other config fields", () => {
  const result = normalizeChain({ chain: ["claude"], workspace: "/tmp/work", defaultCooldownMinutes: 30 });
  assert.equal(result.workspace, "/tmp/work");
  assert.equal(result.defaultCooldownMinutes, 30);
});

test("normalizeChain: throws on non-array chain", () => {
  assert.throws(() => normalizeChain({ chain: "claude" }), /must be an array/i);
});

test("normalizeChain: throws on string failover value", () => {
  assert.throws(() => normalizeChain({ chain: ["claude"], failover: "false" }), /failover must be a boolean/i);
});

test("normalizeChain: throws on empty model in string entry", () => {
  assert.throws(() => normalizeChain({ chain: ["claude:"] }), /empty model/i);
});

test("normalizeChain: throws on object entry with optional as string", () => {
  assert.throws(
    () => normalizeChain({ chain: [{ provider: "claude", optional: "false" }] }),
    /"optional" must be a boolean/i
  );
});

test("normalizeChain: throws on object entry with non-array args", () => {
  assert.throws(
    () => normalizeChain({ chain: [{ provider: "claude", args: "--verbose" }] }),
    /"args" must be an array/i
  );
});

test("normalizeChain: provider part is lowercased, model case preserved", () => {
  const result = normalizeChain({ chain: ["Claude:MyTag"] });
  assert.equal(result.chain[0].provider, "claude");
  assert.equal(result.chain[0].model, "MyTag");
});

test("loadConfig: throws on unknown provider in saved config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "claw"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "claw", "clawsub.json"),
      JSON.stringify({ chain: ["claude", "badprovider"] }),
      "utf8"
    );
    assert.throws(() => loadConfig(path.join(tmpDir, "claw")), /unknown provider/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig: returns valid string chain on success", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "claw"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "claw", "clawsub.json"),
      JSON.stringify({ chain: ["claude", "codex"] }),
      "utf8"
    );
    const config = loadConfig(path.join(tmpDir, "claw"));
    assert.deepEqual(config.chain, ["claude", "codex"]);
    assert.equal(config.failover, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
