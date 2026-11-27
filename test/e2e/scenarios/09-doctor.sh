#!/usr/bin/env bash
# SC-09: doctor reports healthy vs broken setups
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="09-doctor"

export STUB_CLAUDE_MODE=ok

"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "init failed"
mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini/antigravity-cli"
echo '{"oauthAccount":{}}' > "$HOME/.claude.json"
echo '{"token":"stub"}' > "$HOME/.codex/auth.json"
echo '{}' > "$HOME/.gemini/antigravity-cli/settings.json"

OUT=$("$CLAWSUB" doctor 2>&1)
EXIT=$?
[ "$EXIT" -eq 0 ] || fail "doctor exited $EXIT on healthy setup: $OUT"
echo "$OUT" | grep -qiE "(ok|healthy|installed|detected)" \
  || fail "doctor healthy output unexpected: $OUT"

pass "doctor: exits 0 on healthy setup"

rm -f "$HOME/.claude.json"
OUT2=$("$CLAWSUB" doctor 2>&1)
echo "$OUT2" | grep -qiE "(not logged|missing|warning|error|not found|auth)" \
  || fail "doctor broken output lacks warning: $OUT2"

pass "doctor: surfaces auth warning on broken setup"
