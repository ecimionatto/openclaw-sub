#!/usr/bin/env bash
# E2E test: pack + install clawsub from tarball, run assertions with CLI stubs.
# Must be run from the repo root (or pass REPO_ROOT env var).
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
STUBS_DIR="$REPO_ROOT/test/e2e/stubs"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }

echo "==> Packing tarball from $REPO_ROOT"
cd "$REPO_ROOT"
TARBALL=$(npm pack --quiet 2>/dev/null)
mv "$TARBALL" "$WORK/"
TARBALL="$WORK/$(basename "$TARBALL")"

echo "==> Installing tarball globally into $WORK/global"
export npm_config_prefix="$WORK/global"
npm install -g "$TARBALL" --quiet

CLAWSUB="$WORK/global/bin/clawsub"
[ -x "$CLAWSUB" ] || fail "clawsub binary not found at $CLAWSUB"

# Put stubs on PATH before real CLIs
export PATH="$STUBS_DIR:$PATH"

# Point clawsub state to a temp home so we don't touch the real ~/.config
export CLAWSUB_HOME="$WORK/clawsub_home"
export HOME="$WORK/home"
mkdir -p "$HOME"

echo "==> 1. clawsub --version"
OUT=$("$CLAWSUB" --version 2>&1) && pass "--version exited 0" || fail "--version failed: $OUT"
echo "$OUT" | grep -qE "[0-9]+\.[0-9]+\.[0-9]+" || fail "--version output has no semver: $OUT"

echo "==> 2. clawsub version (alias)"
"$CLAWSUB" version >/dev/null 2>&1 && pass "version command exited 0" || fail "version command failed"

echo "==> 3. clawsub init --chain claude,codex,agy"
"$CLAWSUB" init --chain claude,codex,agy 2>&1
CONFIG_FILE="$CLAWSUB_HOME/clawsub.json"
[ -f "$CONFIG_FILE" ] && pass "init wrote clawsub.json at $CONFIG_FILE" || fail "init did not write clawsub.json at $CONFIG_FILE"

echo "==> 4. clawsub doctor"
# Fake auth files so at least one provider appears authenticated
mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini/antigravity-cli"
echo '{"oauthAccount":{}}' > "$HOME/.claude.json"
echo '{"token":"stub"}' > "$HOME/.codex/auth.json"
echo '{}' > "$HOME/.gemini/antigravity-cli/settings.json"
"$CLAWSUB" doctor >/dev/null 2>&1 && pass "doctor exited 0" || fail "doctor failed"

echo "==> 5. clawsub run (failover claude->codex, writes baton)"
RUN_OUT=$("$CLAWSUB" run "hello world" 2>&1)
[ $? -eq 0 ] || fail "run exited non-zero. Output: $RUN_OUT"
echo "$RUN_OUT" | grep -qF "stub-codex-response: ok" \
  && pass "run output contains 'stub-codex-response: ok'" \
  || fail "run did not output 'stub-codex-response: ok'. Output: $RUN_OUT"

BATON_FILE="$CLAWSUB_HOME/clawsub-baton.json"
[ -f "$BATON_FILE" ] \
  && pass "baton file written at $BATON_FILE" \
  || fail "baton file not found at $BATON_FILE"

BATON_CONTENT=$(cat "$BATON_FILE")
node -e "
  const d = JSON.parse(require('fs').readFileSync('$BATON_FILE', 'utf8'));
  const s = Object.values(d.sessions)[0];
  if (s.lastProvider !== 'codex') { console.error('lastProvider: ' + s.lastProvider); process.exit(1); }
" && pass "baton lastProvider is codex (failover confirmed)" \
  || fail "baton lastProvider is not codex. Content: $BATON_CONTENT"

# State file must show claude in cooldown (proves claude was tried first and hit quota)
STATE_FILE="$CLAWSUB_HOME/clawsub-state.json"
[ -f "$STATE_FILE" ] || fail "state file not found at $STATE_FILE"
node -e "
  const d = JSON.parse(require('fs').readFileSync('$STATE_FILE', 'utf8'));
  if (d.providers?.claude?.status !== 'cooldown') { console.error('claude status: ' + d.providers?.claude?.status); process.exit(1); }
" && pass "state records claude quota exhaustion (cooldown)" \
  || fail "state does not show claude in cooldown. Content: $(cat "$STATE_FILE")"

echo "==> 6. clawsub install-skill"
"$CLAWSUB" install-skill --workspace "$WORK/workspace" 2>&1
SKILL_FILE="$WORK/workspace/skills/clawsub/SKILL.md"
[ -f "$SKILL_FILE" ] && pass "install-skill wrote SKILL.md at $SKILL_FILE" || fail "install-skill did not write SKILL.md at $SKILL_FILE"

echo ""
echo "All e2e assertions passed."
