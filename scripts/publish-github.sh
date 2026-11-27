#!/usr/bin/env bash
# Runs the unit test suite, initializes the git repo, creates ecimionatto/openclaw-sub on GitHub, and pushes main.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "1. Running unit tests..."
chmod +x ./bin/clawsub.mjs
node --test test/*.test.mjs

echo "2. Verifying CLI..."
node ./bin/clawsub.mjs help >/dev/null
node ./bin/clawsub.mjs status

echo "3. Initializing Git repository..."
if [[ ! -d .git ]]; then
  git init -b main
fi
git config user.name "Edson Cimionatto"
git config user.email "ecimionatto@users.noreply.github.com"
git add -A
if [[ -n "$(git status --porcelain)" ]]; then
  git commit -m "feat: initial release of openclaw-sub (clawsub v0.1.0)"
fi

echo "4. Creating & pushing to GitHub (ecimionatto/openclaw-sub)..."
if gh repo view ecimionatto/openclaw-sub >/dev/null 2>&1; then
  git remote set-url origin https://github.com/ecimionatto/openclaw-sub.git 2>/dev/null || \
    git remote add origin https://github.com/ecimionatto/openclaw-sub.git
  git push -u origin main
else
  gh repo create ecimionatto/openclaw-sub \
    --public \
    --description "Run OpenClaw 24/7 on flat-rate AI subscriptions (Claude CLI, Codex CLI, Antigravity/Gemini CLI) with $0 API bills and automatic quota failover." \
    --source=. \
    --remote=origin \
    --push
fi

echo "5. Adding GitHub topics..."
gh repo edit ecimionatto/openclaw-sub \
  --add-topic agent-skills \
  --add-topic openclaw-skill \
  --add-topic ai-agent \
  --add-topic subscription-failover || echo "Warning: gh repo edit failed (topics not updated)"

echo "✅ Published: https://github.com/ecimionatto/openclaw-sub"
