import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../bin/clawsub.mjs");

test("clawsub status exits 1 when no providers in chain are installed", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-bin-"));
  fs.writeFileSync(path.join(tmpHome, "clawsub.json"), JSON.stringify({ chain: ["claude"] }));
  try {
    const r = spawnSync(process.execPath, [BIN, "status", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CLAWSUB_HOME: tmpHome, PATH: emptyBinDir },
    });
    assert.equal(r.status, 1, `expected exit 1 when no providers installed; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true });
    fs.rmSync(emptyBinDir, { recursive: true });
  }
});

test("clawsub status exits 0 when at least one provider is installed and authenticated", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-test-"));
  const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-bin-"));
  const mockOllama = path.join(mockBinDir, "ollama");
  fs.writeFileSync(mockOllama, "#!/bin/sh\necho 'ollama version 0.1.0'\n");
  fs.chmodSync(mockOllama, 0o755);
  fs.writeFileSync(path.join(tmpHome, "clawsub.json"), JSON.stringify({ chain: ["ollama"] }));
  try {
    const r = spawnSync(process.execPath, [BIN, "status", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CLAWSUB_HOME: tmpHome, PATH: `${mockBinDir}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0, `expected exit 0 when ollama is installed; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true });
    fs.rmSync(mockBinDir, { recursive: true });
  }
});
