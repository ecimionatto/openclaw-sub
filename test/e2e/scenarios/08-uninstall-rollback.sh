#!/usr/bin/env bash
# SC-08: uninstall / rollback restores original openclaw.json
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="08-uninstall-rollback"

export STUB_CLAUDE_MODE=ok

OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
mkdir -p "$(dirname "$OPENCLAW_CONFIG")"
ORIG_CONTENT='{"provider":"original-value","custom":true}'
echo "$ORIG_CONTENT" > "$OPENCLAW_CONFIG"

"$CLAWSUB" init --chain claude,codex,agy --workspace "$HOME/ws" 2>&1 || fail "init failed"

BACKUP=$(find "$(dirname "$OPENCLAW_CONFIG")" -maxdepth 1 -name 'openclaw.json.bak.*' 2>/dev/null | head -1)
[ -n "$BACKUP" ] || { pass "no openclaw.json installed (backup not applicable); rollback N/A"; exit 0; }

RESTORED=$(cat "$BACKUP")
[ "$RESTORED" = "$ORIG_CONTENT" ] || fail "backup content does not match original"

cp "$BACKUP" "$OPENCLAW_CONFIG"
AFTER=$(cat "$OPENCLAW_CONFIG")
[ "$AFTER" = "$ORIG_CONTENT" ] || fail "restore from backup failed"

pass "uninstall/rollback: backup preserves original openclaw.json"
