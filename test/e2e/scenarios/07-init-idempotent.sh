#!/usr/bin/env bash
# SC-07: init writes backup, preserves existing config, re-run is idempotent
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="07-init-idempotent"

export STUB_CLAUDE_MODE=ok

"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "first init failed"
CONFIG="$CLAWSUB_HOME/clawsub.json"
[ -f "$CONFIG" ] || fail "clawsub.json not written by init"

ORIG=$(cat "$CONFIG")

"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "second init failed"

NEW=$(cat "$CONFIG")
[ "$ORIG" = "$NEW" ] || fail "re-run changed clawsub.json (not idempotent)"

BACKUP=$(ls "$CLAWSUB_HOME"/clawsub.json.bak.* 2>/dev/null | head -1)
[ -n "$BACKUP" ] || fail "no backup file created on second init"

pass "init: backup written, config preserved, re-run idempotent"
