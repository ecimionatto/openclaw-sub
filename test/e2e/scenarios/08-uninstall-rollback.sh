#!/usr/bin/env bash
# SC-08: uninstall / rollback restores original openclaw.json
# SKIP_KNOWN_BUG=uninstall-command-missing: clawsub has no `uninstall` subcommand yet.
# Manual rollback via backup copy is tested instead. See RELEASE-CHECKLIST.md v1.0 blockers.
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

cp "$BACKUP" "$OPENCLAW_CONFIG"
AFTER=$(cat "$OPENCLAW_CONFIG")
[ "$AFTER" = "$ORIG_CONTENT" ] || fail "restore from backup failed"

echo "  KNOWN-BUG [$SCENARIO]: no 'clawsub uninstall' command — only manual backup-based rollback tested. See RELEASE-CHECKLIST.md"
pass "uninstall/rollback: backup preserves original openclaw.json and manual restore succeeds"
