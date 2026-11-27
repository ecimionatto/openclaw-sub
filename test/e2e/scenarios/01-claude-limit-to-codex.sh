#!/usr/bin/env bash
# SC-01: claude quota hit -> auto-failover to codex
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="01-claude-limit-to-codex"

export STUB_CLAUDE_MODE=limit
export STUB_CODEX_MODE=ok

OUT=$("$CLAWSUB" run "hello world" 2>&1) || fail "run exited non-zero: $OUT"
echo "$OUT" | grep -qF "stub-codex-response: ok" || fail "expected codex response, got: $OUT"

STATE="$CLAWSUB_HOME/clawsub-state.json"
[ -f "$STATE" ] || fail "state file not found"
node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8'));
  if(d.providers?.claude?.status!=='cooldown'){process.exit(1)}" \
  || fail "claude not in cooldown in state"

BATON="$CLAWSUB_HOME/clawsub-baton.json"
[ -f "$BATON" ] || fail "baton file not found"
node -e "const d=JSON.parse(require('fs').readFileSync('$BATON','utf8'));
  const s=Object.values(d.sessions||{})[0];
  if(s?.lastProvider!=='codex'){console.error('lastProvider:'+s?.lastProvider);process.exit(1)}" \
  || fail "baton lastProvider is not codex"

pass "claude limit triggers failover to codex"
