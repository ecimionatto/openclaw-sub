#!/usr/bin/env bash
# SC-11: CS-20 config variants — same provider/two models, failover off, optional provider missing
# KNOWN_BLOCKER=CS-25
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="11-cs20-config-variants"

# --- Case 1: same provider twice with two different models ---
export STUB_CLAUDE_MODE=ok
"$CLAWSUB" init --chain claude:opus,claude:sonnet 2>&1 \
  || fail "init with same-provider two-model chain failed"
CONFIG="$CLAWSUB_HOME/clawsub.json"
node -e "
  const d=JSON.parse(require('fs').readFileSync('$CONFIG','utf8'));
  const c=Array.isArray(d.chain)?d.chain:Object.keys(d.chain||{});
  if(c.length<2){console.error('expected >=2 entries, got:'+JSON.stringify(c));process.exit(1)}
  if(c[0]!=='claude:opus'){console.error('first entry should be claude:opus, got:'+c[0]);process.exit(1)}
  if(c[1]!=='claude:sonnet'){console.error('second entry should be claude:sonnet, got:'+c[1]);process.exit(1)}
" || fail "same-provider two-model chain not persisted in clawsub.json"
OUT=$("$CLAWSUB" run "test" 2>&1) || fail "run failed with same-provider two-model chain: $OUT"
echo "$OUT" | grep -qF "stub-claude-response: ok" \
  || fail "same-provider two-model chain: expected claude output, got: $OUT"
pass "same provider twice with different models: config persisted and run succeeded"

# --- Case 2: failover off — 2nd provider must never be invoked when 1st succeeds ---
export STUB_CLAUDE_MODE=ok
export STUB_CODEX_MODE=ok
INVLOG=$(mktemp)
export STUB_INVOCATION_LOG="$INVLOG"
"$CLAWSUB" init --chain claude,codex 2>&1 || fail "init with 2-provider chain failed"
# Inject failover=false into config (CS-25 will add the --failover CLI flag)
node -e "
  const f='$CLAWSUB_HOME/clawsub.json';
  const d=JSON.parse(require('fs').readFileSync(f,'utf8'));
  d.failover=false;
  require('fs').writeFileSync(f,JSON.stringify(d,null,2));
"
"$CLAWSUB" run "test" 2>&1 || fail "run failed with failover=false config"
CODEX_CALLS=$(grep -c '^codex ' "$INVLOG" 2>/dev/null || echo 0)
[ "$CODEX_CALLS" -eq 0 ] \
  || fail "failover=false: codex was invoked $CODEX_CALLS time(s), expected 0"
pass "failover off: 2nd provider (codex) not invoked when 1st (claude) succeeded"
rm -f "$INVLOG"
unset STUB_INVOCATION_LOG

# --- Case 3: optional provider (codex) not in PATH — must skip to claude ---
export STUB_CLAUDE_MODE=ok
# Build a PATH that contains all stubs except codex
FAKE_BIN=$(mktemp -d)
for stub in "$STUBS_DIR"/claude "$STUBS_DIR"/agy "$STUBS_DIR"/openclaw; do
  [ -f "$stub" ] && cp "$stub" "$FAKE_BIN/"
done
# Replace STUBS_DIR in PATH with FAKE_BIN so codex is unreachable
CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v "^${STUBS_DIR}$" | tr '\n' ':' | sed 's/:$//')
export PATH="$FAKE_BIN:$CLEAN_PATH"
"$CLAWSUB" init --chain codex,claude 2>&1 || fail "init with codex-first chain failed"
OUT2=$("$CLAWSUB" run "test" 2>&1) || fail "run failed when codex absent from PATH: $OUT2"
echo "$OUT2" | grep -qF "stub-claude-response: ok" \
  || fail "expected claude output when codex absent from PATH, got: $OUT2"
pass "optional provider (codex) not in PATH: skipped, succeeded via claude"
