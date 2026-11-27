#!/usr/bin/env bash
# SC-02: claude+codex quota hit -> auto-failover to agy
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="02-codex-limit-to-agy"

export STUB_CLAUDE_MODE=limit
export STUB_CODEX_MODE=limit
export STUB_AGY_MODE=ok

OUT=$("$CLAWSUB" run "hello world" 2>&1) || fail "run exited non-zero: $OUT"
echo "$OUT" | grep -qF "stub-agy-response: ok" || fail "expected agy response, got: $OUT"

STATE="$CLAWSUB_HOME/clawsub-state.json"
node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8'));
  if(d.providers?.claude?.status!=='cooldown'){process.exit(1)}" \
  || fail "claude not in cooldown"
node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8'));
  if(d.providers?.codex?.status!=='cooldown'){process.exit(1)}" \
  || fail "codex not in cooldown"

pass "codex limit triggers failover to agy"
