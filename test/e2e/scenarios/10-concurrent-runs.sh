#!/usr/bin/env bash
# SC-10: concurrent runs don't corrupt state files
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="10-concurrent-runs"

export STUB_CLAUDE_MODE=limit
export STUB_CODEX_MODE=ok

"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "init failed"

"$CLAWSUB" run "prompt-a" >/dev/null 2>&1 &
PID1=$!
"$CLAWSUB" run "prompt-b" >/dev/null 2>&1 &
PID2=$!
wait $PID1 || true
wait $PID2 || true

STATE="$CLAWSUB_HOME/clawsub-state.json"
[ -f "$STATE" ] || fail "state file not found after concurrent runs"
node -e "
  const raw=require('fs').readFileSync('$STATE','utf8');
  try{ JSON.parse(raw) }catch(e){ console.error('corrupt JSON: '+e.message); process.exit(1) }
" || fail "state file is corrupt JSON after concurrent runs"

pass "concurrent runs: state file is valid JSON"
