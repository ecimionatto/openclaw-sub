#!/usr/bin/env bash
# v1.0 release gate — all scenarios must pass, no KNOWN_BLOCKERs allowed.
# Exit 1 if any scenario fails or any KNOWN_BLOCKER remains unresolved.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
STUBS_DIR="$REPO_ROOT/test/e2e/stubs"
SCENARIOS_DIR="$REPO_ROOT/test/e2e/scenarios"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> Packing tarball"
cd "$REPO_ROOT"
TARBALL=$(npm pack --quiet 2>/dev/null)
mv "$TARBALL" "$WORK/"
TARBALL="$WORK/$(basename "$TARBALL")"

echo "==> Installing tarball"
export npm_config_prefix="$WORK/global"
npm install -g "$TARBALL" --quiet

export CLAWSUB="$WORK/global/bin/clawsub"
[ -x "$CLAWSUB" ] || { echo "FAIL: clawsub binary not found"; exit 1; }

export PATH="$STUBS_DIR:$PATH"
export STUBS_DIR

PASS=0
FAIL=0

for SCRIPT in "$SCENARIOS_DIR"/[0-9][0-9]-*.sh; do
  [ -f "$SCRIPT" ] || continue
  BLOCKER=$(grep -oE 'KNOWN_BLOCKER=[A-Z]+-[0-9]+' "$SCRIPT" | head -1 | cut -d= -f2 || true)
  SCENARIO_WORK=$(mktemp -d)
  export CLAWSUB_HOME="$SCENARIO_WORK/clawsub_home"
  export HOME="$SCENARIO_WORK/home"
  mkdir -p "$HOME"
  unset STUB_CLAUDE_MODE STUB_CODEX_MODE STUB_AGY_MODE 2>/dev/null || true
  if bash "$SCRIPT"; then
    if [ -n "$BLOCKER" ]; then
      echo "  UNEXPECTED PASS [$(basename "$SCRIPT")]: KNOWN_BLOCKER=$BLOCKER still present — remove the marker"
      FAIL=$(( FAIL + 1 ))
    else
      PASS=$(( PASS + 1 ))
    fi
  else
    if [ -n "$BLOCKER" ]; then
      echo "  BLOCKER REMAINS ($BLOCKER): $(basename "$SCRIPT") — v1.0 cannot ship until $BLOCKER is resolved"
    else
      echo "  FAIL: $(basename "$SCRIPT")"
    fi
    FAIL=$(( FAIL + 1 ))
  fi
  rm -rf "$SCENARIO_WORK"
done

echo ""
echo "==> Gate v1 results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "v1.0 gate FAILED — fix all failures and resolve all KNOWN_BLOCKERs before tagging v1.0"; exit 1; }
echo "v1.0 gate PASSED — all scenarios green, no unresolved blockers"
