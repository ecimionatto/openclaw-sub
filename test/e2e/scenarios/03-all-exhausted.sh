#!/usr/bin/env bash
# SC-03: all providers exhausted -> clear error + reset ETA, no retry storm
set -euo pipefail
pass() { echo "  PASS [$SCENARIO]: $1"; }
fail() { echo "  FAIL [$SCENARIO]: $1"; exit 1; }
SCENARIO="03-all-exhausted"

export STUB_CLAUDE_MODE=limit
export STUB_CODEX_MODE=limit
export STUB_AGY_MODE=limit

START=$(date +%s)
OUT=$("$CLAWSUB" run "hello world" 2>&1) && fail "expected non-zero exit when all exhausted"
END=$(date +%s)
ELAPSED=$(( END - START ))

[ "$ELAPSED" -lt 10 ] || fail "run took ${ELAPSED}s — possible retry storm (threshold: 10s)"

echo "$OUT" | grep -qiE "(exhausted|no provider|all.*limit|quota)" \
  || fail "output lacks exhausted/quota message: $OUT"

echo "$OUT" | grep -qiE "(reset|retry|ETA|again at|resets)" \
  || fail "output lacks reset ETA: $OUT"

pass "all providers exhausted: clear error + ETA, no retry storm"
