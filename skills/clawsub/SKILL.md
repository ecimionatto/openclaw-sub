---
name: clawsub
description: >-
  Manage OpenClaw's subscription-CLI reasoning chain (Claude Code CLI, OpenAI Codex CLI,
  Google Antigravity/Gemini CLI, Ollama), inspect 5-hour/weekly quota cooldowns, run headless
  health diagnostics, and safely upgrade or pin OpenClaw and CLI versions with zero API bills.
---

# `clawsub` (`openclaw-sub`) Agent Skill

Use this skill whenever the user asks to:
- Check which subscription CLI (`claude`, `codex`, `agy` / `gemini`, `ollama`) is currently active or in quota cooldown
- Diagnose why a primary or fallback CLI failed or hung on a headless turn
- Reorder or add a fallback subscription CLI (e.g. *"switch primary to codex"* or *"add gemini/agy as fallback"*)
- Check or upgrade installed versions of `openclaw`, `claude`, `codex`, or `agy`
- Reset quota cooldown timers after a subscription upgrade or account switch

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

## 4. Troubleshooting Common Headless CLI Traps

1. **Provider stuck in 80-minute retry loop:**
   - Usually means a **weekly** subscription limit was reached (`You've hit your weekly limit. Resets Nov 28, 10:00am`).
   - Run `clawsub status` to confirm `cooldownUntil` reflects the multi-day reset date and that the next CLI in the chain (`codex` or `agy`) is `ready`.
2. **Headless turn hangs for 30 minutes on `agy`:**
   - Caused by an unapproved out-of-workspace file read or shell command waiting for interactive TUI confirmation.
   - Fix: keep file operations inside `--workspace` or enable auto-approve in `~/.gemini/antigravity-cli/settings.json` on the host.
3. **Morning standup fails with `usage_limit_reached`:**
   - Ensure `quotaReservationWindows` (`06:30-08:45`, `19:00-21:30`) are enabled in `~/.openclaw/clawsub.json` so overnight background heartbeats pause before scheduled briefings.
