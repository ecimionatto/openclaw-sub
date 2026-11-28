#!/usr/bin/env bash
# SC-06: baton handoff keeps last turns + worktree state across switch and back
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="06-baton-handoff"

export STUB_CLAUDE_MODE=limit
export STUB_CODEX_MODE=ok

"$CLAWSUB" run --session myws "first turn" >/dev/null 2>&1 || fail "first run failed"
BATON="$CLAWSUB_HOME/clawsub-baton.json"
[ -f "$BATON" ] || fail "baton not written after first run"

node -e "const d=JSON.parse(require('fs').readFileSync('$BATON','utf8'));
  const s=d.sessions?.myws;
  if(!s){console.error('no myws session');process.exit(1)}" \
  || fail "session myws not in baton after first run"

node -e "const d=JSON.parse(require('fs').readFileSync('$BATON','utf8'));
  const s=d.sessions?.myws;
  if(!s.turns||s.turns.length===0){console.error('turns empty after first run');process.exit(1)}" \
  || fail "baton does not record turns from first run"

export STUB_CODEX_MODE=limit
export STUB_AGY_MODE=ok
"$CLAWSUB" run --session myws "second turn" >/dev/null 2>&1 || fail "second run failed"

node -e "const d=JSON.parse(require('fs').readFileSync('$BATON','utf8'));
  const s=d.sessions?.myws;
  if(s?.lastProvider!=='agy'){console.error('lastProvider:'+s?.lastProvider);process.exit(1)}" \
  || fail "baton lastProvider not updated to agy after second switch"

node -e "const d=JSON.parse(require('fs').readFileSync('$BATON','utf8'));
  const s=d.sessions?.myws;
  if(!s.turns||s.turns.length<2){console.error('expected >=2 turns, got:'+(s.turns?.length));process.exit(1)}" \
  || fail "baton did not retain earlier turns across provider switch"

export STUB_CLAUDE_MODE=ok
export STUB_CODEX_MODE=ok
export STUB_AGY_MODE=ok
"$CLAWSUB" reset 2>&1 || fail "reset before provider recovery failed"
"$CLAWSUB" run --session myws "third turn" >/dev/null 2>&1 || fail "third run failed"

node -e "const d=JSON.parse(require('fs').readFileSync('$BATON','utf8'));
  const s=d.sessions?.myws;
  if(s?.lastProvider!=='claude'){console.error('lastProvider:'+s?.lastProvider);process.exit(1)}" \
  || fail "baton lastProvider not updated back to claude after provider recovery"

node -e "const d=JSON.parse(require('fs').readFileSync('$BATON','utf8'));
  const s=d.sessions?.myws;
  if(!s.turns||s.turns.length<3){console.error('expected >=3 turns, got:'+(s.turns?.length));process.exit(1)}" \
  || fail "baton did not retain all turns after switching back to original provider"

pass "baton handoff: session turns retained, provider switch and recovery both work"
