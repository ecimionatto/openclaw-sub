---
name: clawsub
version: "0.3.0"
description: >-
  Manage OpenClaw's subscription-CLI reasoning chain (Claude Code CLI, OpenAI Codex CLI,
  Google Antigravity/Gemini CLI, Ollama), inspect 5-hour/weekly quota cooldowns, run headless
  health diagnostics, and safely upgrade or pin OpenClaw and CLI versions with zero API bills.
author: Edson Cimionatto (@ecimionatto)
tags:
  - openclaw
  - subscription
  - failover
  - claude-code
  - codex
  - gemini-cli
  - ai-agent
  - agent-skills
permissions:
  - read_files
  - run_commands
---

# `clawsub` (`openclaw-sub`) Agent Skill

Use this skill whenever the user asks to:
- Check which subscription CLI (`claude`, `codex`, `agy` / `gemini`, `ollama`) is currently active or in quota cooldown
- Diagnose why a primary or fallback CLI failed or hung on a headless turn
- Reorder or add a fallback subscription CLI (e.g. *"switch primary to codex"* or *"add gemini/agy as fallback"*)
- Check or upgrade installed versions of `openclaw`, `claude`, `codex`, or `agy`
- Reset quota cooldown timers after a subscription upgrade or account switch
- Hand off work between quota-limited sessions (`clawsub baton`)

---

## 1. Quick Diagnostic & Status Commands

Run these non-interactive JSON commands to inspect live state:

```bash
# Inspect active chain, cooldown timers, reset timestamps, and last latency
clawsub status --json

# Run full readiness & headless-safety diagnostics
clawsub doctor --json

# Inspect installed versions and version snapshot history
clawsub version --json
```

---

## 2. Managing the Subscription Failover Chain

### Reorder or update the provider chain
```bash
clawsub init --chain claude,codex,agy --workspace /path/to/workspace --install-skill
```

### Run live verification probes (`DIRECT_OK` / `FALLBACK_OK`)
```bash
clawsub test --chain claude,codex,agy
```

### Clear a provider's quota cooldown early
```bash
clawsub reset claude   # clear a single provider
clawsub reset          # clear all providers
```

---

## 3. Installing or Upgrading OpenClaw on Ubuntu (Version-Safe)

`clawsub` snapshots the currently installed versions of `openclaw`, `claude`, `codex`, and `agy` into `~/.openclaw/clawsub-versions.json` before upgrading:

```bash
# Install or upgrade OpenClaw on Ubuntu (defaults to latest, or pin a specific version)
clawsub install-ubuntu --openclaw-version latest

# Pin a specific OpenClaw release
clawsub install-ubuntu --openclaw-version 2026.11.0
```

---

## 4. Handing Off Work Between Sessions (`clawsub baton`)

When a provider hits its quota mid-task, `clawsub baton` captures a resume context (last commit SHA, working notes, next steps) and passes it to the first ready provider:

```bash
# Write baton file and print resume instructions for the next provider
clawsub baton --workspace /path/to/workspace

# Read the baton and resume work from where the previous session left off
clawsub baton --read --workspace /path/to/workspace
```

The baton file is written to `<workspace>/.clawsub-baton.json`. The next provider agent reads it at startup and continues from the recorded state.

---

## 5. Installing This Skill

### Via OpenClaw (ClawHub)
```bash
openclaw skills install git:ecimionatto/openclaw-sub
```

### Via `npx skills` (vercel-labs/skills)
```bash
npx skills add ecimionatto/openclaw-sub
```

### Via `clawsub` CLI (workspace or global)
```bash
# Install into .claude/skills/ in the current workspace
clawsub install-skill

# Install globally into ~/.openclaw/skills/
clawsub install-skill --global
```

---

## 6. Troubleshooting Common Headless CLI Traps

1. **Provider stuck in 80-minute retry loop:**
   - Usually means a **weekly** subscription limit was reached (`You've hit your weekly limit. Resets Nov 28, 10:00am`).
   - Run `clawsub status` to confirm `cooldownUntil` reflects the multi-day reset date and that the next CLI in the chain (`codex` or `agy`) is `ready`.
2. **Headless turn hangs for 30 minutes on `agy`:**
   - Caused by an unapproved out-of-workspace file read or shell command waiting for interactive TUI confirmation.
   - Fix: keep file operations inside `--workspace` or enable auto-approve in `~/.gemini/antigravity-cli/settings.json` on the host.
3. **Morning standup fails with `usage_limit_reached`:**
   - Ensure `quotaReservationWindows` (`06:30-08:45`, `19:00-21:30`) are enabled in `~/.openclaw/clawsub.json` so overnight background heartbeats pause before scheduled briefings.
