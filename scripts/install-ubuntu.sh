#!/usr/bin/env bash
# ==============================================================================
# 🦞 openclaw-sub (clawsub) — Turnkey Ubuntu 22.04 / 24.04 LTS Bootstrapper
# Installs Node.js 22+ LTS (if needed), OpenClaw (version-pinned or latest),
# subscription CLIs (claude, codex, gemini), the clawsub router, and the
# clawsub SKILL.md for OpenClaw & Antigravity agents.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ecimionatto/openclaw-sub/main/scripts/install-ubuntu.sh | bash
#   # Or with version / chain options:
#   OPENCLAW_VERSION=latest CLAWSUB_CHAIN=claude,codex,agy bash scripts/install-ubuntu.sh
# ==============================================================================
set -euo pipefail

OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"
CLAWSUB_VERSION="${CLAWSUB_VERSION:-latest}"
CLAWSUB_CHAIN="${CLAWSUB_CHAIN:-claude,codex,agy}"
CLAWSUB_WORKSPACE="${CLAWSUB_WORKSPACE:-$HOME/clawbot/workspace}"
INSTALL_PROVIDER_CLIS="${INSTALL_PROVIDER_CLIS:-1}"
DRY_RUN="${DRY_RUN:-0}"

log()  { printf "\033[1;34m[clawsub-ubuntu]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m  ✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m  ⚠\033[0m %s\n" "$*"; }

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf "  [dry-run] %s\n" "$*"
  else
    "$@"
  fi
}

log "🦞 Starting OpenClaw + clawsub Ubuntu installer"
log "   OpenClaw version : ${OPENCLAW_VERSION}"
log "   Provider chain   : ${CLAWSUB_CHAIN}"
log "   Workspace        : ${CLAWSUB_WORKSPACE}"

# 1. Verify Ubuntu / Debian base dependencies
if command -v apt-get >/dev/null 2>&1; then
  log "[1/5] Checking Ubuntu/Debian system packages..."
  MISSING_PKGS=()
  for pkg in curl git ca-certificates gnupg jq; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      MISSING_PKGS+=("$pkg")
    fi
  done
  if (( ${#MISSING_PKGS[@]} > 0 )); then
    log "Installing missing packages: ${MISSING_PKGS[*]}"
    run_cmd sudo apt-get update -qq
    run_cmd sudo apt-get install -y -qq "${MISSING_PKGS[@]}"
  fi
  ok "System packages ready"
else
  warn "apt-get not detected; skipping apt package check"
fi

# 2. Check / Install Node.js (>= 18 required, 22 LTS recommended)
log "[2/5] Checking Node.js runtime..."
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if (( NODE_MAJOR < 18 )); then
    NEED_NODE=1
  else
    ok "Node.js $(node -v) detected"
  fi
fi

if (( NEED_NODE == 1 )); then
  log "Installing Node.js 22.x LTS via NodeSource..."
  if [[ "$DRY_RUN" == "1" ]]; then
    printf "  [dry-run] curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs\n"
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  ok "Node.js installed"
fi

# 3. Install OpenClaw + openclaw-sub (with explicit version support)
log "[3/5] Installing OpenClaw (@${OPENCLAW_VERSION}) and openclaw-sub (@${CLAWSUB_VERSION})..."
if command -v openclaw >/dev/null 2>&1 && [[ "$OPENCLAW_VERSION" == "keep" ]]; then
  ok "Keeping existing OpenClaw ($(openclaw --version 2>/dev/null || echo 'installed'))"
else
  run_cmd npm install -g "openclaw@${OPENCLAW_VERSION}"
  ok "openclaw@${OPENCLAW_VERSION} installed"
fi

if [[ -f "$(dirname "${BASH_SOURCE[0]:-.}")/../package.json" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  log "Linking local openclaw-sub checkout from ${REPO_ROOT}..."
  run_cmd npm install -g "$REPO_ROOT"
else
  run_cmd npm install -g "openclaw-sub@${CLAWSUB_VERSION}"
fi
ok "clawsub CLI installed"

# 4. Optionally install subscription CLIs if missing
if [[ "$INSTALL_PROVIDER_CLIS" == "1" ]]; then
  log "[4/5] Checking subscription CLIs in chain (${CLAWSUB_CHAIN})..."
  IFS=',' read -ra CHAIN_ARR <<< "$CLAWSUB_CHAIN"
  for provider in "${CHAIN_ARR[@]}"; do
    case "$provider" in
      claude)
        if ! command -v claude >/dev/null 2>&1; then
          log "Installing Claude Code CLI (@anthropic-ai/claude-code)..."
          run_cmd npm install -g @anthropic-ai/claude-code
        fi
        ok "claude CLI present (run 'claude login' to authenticate with Claude Pro/Max)"
        ;;
      codex)
        if ! command -v codex >/dev/null 2>&1; then
          log "Installing OpenAI Codex CLI (@openai/codex)..."
          run_cmd npm install -g @openai/codex
        fi
        ok "codex CLI present (run 'codex login' to authenticate with ChatGPT Plus/Pro)"
        ;;
      agy|gemini)
        if ! command -v agy >/dev/null 2>&1 && ! command -v gemini >/dev/null 2>&1; then
          log "Installing Google Gemini CLI (@google/gemini-cli)..."
          run_cmd npm install -g @google/gemini-cli
        fi
        ok "Google CLI present (run 'agy' or 'gemini' once to authenticate)"
        ;;
    esac
  done
fi

# 5. Initialize clawsub config, cooldown shims, version snapshot, and agent SKILL.md
log "[5/5] Initializing clawsub router, version snapshot, and agent SKILL.md..."
run_cmd mkdir -p "$CLAWSUB_WORKSPACE"
run_cmd clawsub init --chain "$CLAWSUB_CHAIN" --workspace "$CLAWSUB_WORKSPACE" --install-skill

log "🎉 Ubuntu setup complete!"
log "Next steps:"
log "  1. Authenticate your CLIs (no API keys needed): claude login  |  codex login  |  agy"
log "  2. Verify failover probes:                      clawsub test"
log "  3. Connect Telegram/Discord/WhatsApp:           openclaw onboard"
