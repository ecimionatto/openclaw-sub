#!/usr/bin/env bash
# SC-11: CS-20 config variants — custom order, failover off, optional provider missing
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="11-cs20-config-variants"

export STUB_CLAUDE_MODE=ok
export STUB_CODEX_MODE=ok
export STUB_AGY_MODE=ok

"$CLAWSUB" init --chain agy,codex,claude 2>&1 || fail "init with custom order failed"
CONFIG="$CLAWSUB_HOME/clawsub.json"
node -e "const d=JSON.parse(require('fs').readFileSync('$CONFIG','utf8'));
  const c=d.chain||d.providers;
  const order=Array.isArray(c)?c:Object.keys(c);
  if(order[0]!=='agy'){console.error('first:'+order[0]);process.exit(1)}" \
  || fail "custom provider order not persisted"
pass "custom provider order: agy first"

"$CLAWSUB" init --chain claude 2>&1 || fail "init single provider failed"
export STUB_CLAUDE_MODE=limit
OUT=$("$CLAWSUB" run "test" 2>&1) && fail "expected failure when only provider exhausted" || true
echo "$OUT" | grep -qiE "(exhausted|limit|no provider)" \
  || fail "single-provider exhaustion message missing: $OUT"
pass "single provider + failover off: clear error on exhaustion"

export STUB_CLAUDE_MODE=ok
"$CLAWSUB" reset 2>&1 || true
"$CLAWSUB" init --chain nonexistent,claude 2>&1 || fail "init with missing provider failed"
OUT2=$("$CLAWSUB" run "test" 2>&1) || fail "run failed when optional provider missing: $OUT2"
echo "$OUT2" | grep -qF "stub-claude-response: ok" \
  || fail "should succeed via claude when nonexistent provider skipped: $OUT2"
pass "optional provider not installed: skipped, no crash"
