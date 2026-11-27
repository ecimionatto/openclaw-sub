#!/usr/bin/env bash
# SC-07: init writes backup, preserves existing config, re-run is idempotent
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="07-init-idempotent"

export STUB_CLAUDE_MODE=ok

OPENCLAW_JSON="$CLAWSUB_HOME/openclaw.json"
mkdir -p "$CLAWSUB_HOME"
echo '{"customKey":"preserved-value","plugins":{"load":{"paths":[]}}}' > "$OPENCLAW_JSON"

"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "first init failed"
CONFIG="$CLAWSUB_HOME/clawsub.json"
[ -f "$CONFIG" ] || fail "clawsub.json not written by init"

ORIG=$(cat "$CONFIG")

OPENCLAW_BAK=$(ls "$CLAWSUB_HOME"/openclaw.json.bak.* 2>/dev/null | head -1)
[ -n "$OPENCLAW_BAK" ] || fail "no openclaw.json backup created on first init"
BAK_CONTENT=$(cat "$OPENCLAW_BAK")
echo "$BAK_CONTENT" | grep -qF '"customKey":"preserved-value"' \
  || fail "openclaw.json backup does not contain original custom key"

"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "second init failed"

NEW=$(cat "$CONFIG")
[ "$ORIG" = "$NEW" ] || fail "re-run changed clawsub.json (not idempotent)"

CONFIG_BAK=$(ls "$CLAWSUB_HOME"/clawsub.json.bak.* 2>/dev/null | head -1)
[ -n "$CONFIG_BAK" ] || fail "no clawsub.json backup file created on second init"

pass "init: backup written, openclaw.json backed up, config preserved, re-run idempotent"
