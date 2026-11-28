#!/usr/bin/env bash
# SC-07: init writes backup, preserves existing config, re-run is idempotent
# KNOWN_BLOCKER=CS-27: clawsub init overwrites openclaw.json without merging user keys.
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

AFTER_FIRST_INIT=$(cat "$CONFIG")

OPENCLAW_BAK=$(ls "$CLAWSUB_HOME"/openclaw.json.bak.* 2>/dev/null | head -1)
[ -n "$OPENCLAW_BAK" ] || fail "no openclaw.json backup created on first init"
BAK_CONTENT=$(cat "$OPENCLAW_BAK")
echo "$BAK_CONTENT" | grep -qF '"customKey":"preserved-value"' \
  || fail "openclaw.json backup does not contain original custom key"

"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "second init failed"

AFTER_SECOND_INIT=$(cat "$CONFIG")
[ "$AFTER_FIRST_INIT" = "$AFTER_SECOND_INIT" ] || fail "re-run changed clawsub.json (not idempotent)"

CONFIG_BAK=$(ls "$CLAWSUB_HOME"/clawsub.json.bak.* 2>/dev/null | head -1)
[ -n "$CONFIG_BAK" ] || fail "no clawsub.json backup file created"

OPENCLAW_AFTER_FIRST=$(cat "$OPENCLAW_JSON")
"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "third init failed"
OPENCLAW_AFTER_SECOND=$(cat "$OPENCLAW_JSON")
[ "$OPENCLAW_AFTER_FIRST" = "$OPENCLAW_AFTER_SECOND" ] \
  || fail "re-run changed openclaw.json (not idempotent)"

LIVE_CONTENT=$(cat "$OPENCLAW_JSON")
echo "$LIVE_CONTENT" | grep -qF '"customKey":"preserved-value"' \
  || fail "init did not preserve customKey in live openclaw.json (CS-27: merge user keys into live file)"

pass "init: backup written, openclaw.json backed up, config preserved, re-run idempotent, user keys preserved"
