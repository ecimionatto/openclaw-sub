#!/usr/bin/env bash
# SC-08: uninstall / rollback restores original openclaw.json
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="08-uninstall-rollback"

export STUB_CLAUDE_MODE=ok

OPENCLAW_CONFIG="$CLAWSUB_HOME/openclaw.json"
mkdir -p "$CLAWSUB_HOME"
ORIG_CONTENT='{"provider":"original-value","custom":true}'
echo "$ORIG_CONTENT" > "$OPENCLAW_CONFIG"

"$CLAWSUB" init --chain claude,codex,agy 2>&1 || fail "init failed"

BACKUP=$(find "$CLAWSUB_HOME" -maxdepth 1 -name 'openclaw.json.bak.*' 2>/dev/null | head -1)
[ -n "$BACKUP" ] || fail "no openclaw.json backup created by init — rollback not possible"

RESTORED=$(cat "$BACKUP")
[ "$RESTORED" = "$ORIG_CONTENT" ] || fail "backup content does not match original"

"$CLAWSUB" uninstall 2>&1 || fail "clawsub uninstall failed (CS-28: implement uninstall subcommand)"

AFTER=$(cat "$OPENCLAW_CONFIG")
[ "$AFTER" = "$ORIG_CONTENT" ] || fail "uninstall did not restore original openclaw.json"

pass "uninstall: original openclaw.json restored by clawsub uninstall"
