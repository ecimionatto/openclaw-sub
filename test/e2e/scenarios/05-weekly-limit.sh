#!/usr/bin/env bash
# SC-05: weekly limit -> cooldown with real reset ETA in state
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; }
SCENARIO="05-weekly-limit"

export STUB_CLAUDE_MODE=weekly_limit
export STUB_CODEX_MODE=ok

OUT=$("$CLAWSUB" run "hello world" 2>&1) || true

STATE="$CLAWSUB_HOME/clawsub-state.json"
[ -f "$STATE" ] || fail "state file not found"
node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8'));
  const s=d.providers?.claude;
  if(s?.status!=='cooldown'){console.error('status:'+s?.status);process.exit(1)}" \
  || fail "claude not in cooldown after weekly limit"

node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8'));
  const s=d.providers?.claude;
  if(!s?.resetAt){console.error('missing resetAt');process.exit(1)}" \
  || fail "resetAt not set after weekly limit"

node -e "const d=JSON.parse(require('fs').readFileSync('$STATE','utf8'));
  const s=d.providers?.claude;
  if(!s.resetAt.startsWith('2026-12-02')){
    console.error('resetAt does not match weekly-limit date:'+s.resetAt);process.exit(1)}" \
  || fail "resetAt does not match the weekly-limit reset date 2026-12-02"

pass "weekly limit: cooldown with resetAt ETA stored and matches fixture date"
