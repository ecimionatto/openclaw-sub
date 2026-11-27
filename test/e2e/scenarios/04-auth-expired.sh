#!/usr/bin/env bash
# SC-04: auth expired -> auth_expired status + login hint, no failover loop
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="04-auth-expired"

export STUB_CLAUDE_MODE=auth_expired
export STUB_CODEX_MODE=ok

OUT=$("$CLAWSUB" run "hello world" 2>&1)

STATE="$CLAWSUB_HOME/clawsub-state.json"
[ -f "$STATE" ] || fail "state file not found"
node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8'));
  if(d.providers?.claude?.status!=='auth_expired'){
    console.error('claude status:'+d.providers?.claude?.status);process.exit(1)}" \
  || fail "claude status is not auth_expired"

echo "$OUT" | grep -qiE "(login|auth login|authenticate)" \
  || fail "output lacks login hint: $OUT"

node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8'));
  if(d.providers?.claude?.status==='cooldown'){process.exit(1)}" \
  || fail "auth_expired should not put provider in cooldown (must not loop)"

echo "$OUT" | grep -qiE "stub-codex-response" \
  || fail "output lacks codex response after failover: $OUT"

export STUB_CODEX_MODE=ok
OUT2=$("$CLAWSUB" run "second turn" 2>&1)
STATE2=$(node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8')); process.stdout.write(d.providers?.claude?.status||'missing')")
[ "$STATE2" = "auth_expired" ] \
  || fail "claude should still be auth_expired on second run, got: $STATE2"

pass "auth_expired: status set, login hint shown, codex used, claude not retried"
