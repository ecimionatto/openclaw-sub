# 🦞 `openclaw-sub` (`clawsub`)

> **Run [OpenClaw](https://openclaw.ai) 24/7 on the flat-rate AI subscriptions you already pay for (`claude`, `codex`, `agy` / `gemini`) — zero API keys, zero per-token bill, automatic 0ms quota failover.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

---

## Why `openclaw-sub` Exists

Running an always-on OpenClaw personal agent over raw API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) quickly burns **$50–$300+/month** in per-token charges once heartbeats, memory files, and long conversations add up.

Meanwhile, most builders **already pay $20–$200/month** for flat-rate consumer/pro subscriptions that include official local CLIs authenticated via browser OAuth:
- **Claude Pro / Max** → Claude Code CLI (`claude`)
- **ChatGPT Plus / Pro** → OpenAI Codex CLI (`codex`)
- **Google AI / Free Tier** → Google Antigravity / Gemini CLI (`agy` / `gemini`)

### Why wiring CLIs by hand breaks in production
If you just point a 24/7 agent at a subscription CLI out of the box, three things break:
1. **5-Hour & Weekly Rolling Caps:** When your primary subscription hits its 5-hour or weekly window (`usage_limit_reached: resets 6:50pm`), your bot either goes dead or wastes 30 seconds failing on the primary CLI on every single turn before falling back.
2. **Headless TUI Permission Traps:** Subscription CLIs are built for interactive terminals. An unapproved file read or command prompt outside the workspace hangs a headless Telegram/Discord turn until it times out.
3. **Overnight Heartbeat Drain:** Default 30-minute heartbeats silently chew through your 5-hour subscription allowance while you sleep, leaving you with zero quota for your 8:30 AM standup or live chat.

**`openclaw-sub` (`clawsub`) fixes all three in one command.**

---

## Cost & Reliability Comparison

| Setup | Extra Monthly API Bill | When Primary Hits 5h/Weekly Limit | Overnight Heartbeat Drain |
| :--- | :--- | :--- | :--- |
| **Raw API Keys** | **$50 – $300+/mo** (metered tokens) | Keeps charging your card | Burns $1–$5/night on idle polls |
| **Naive Single CLI** | **$0** (uses subscription) | **Bot goes offline** for hours/days | Exhausts 5h quota before you wake up |
| **`openclaw-sub` (`clawsub`)** | **$0** (uses existing subscriptions) | **0ms auto-failover** (`claude` → `codex` → `agy`) | **Paused during quiet & reservation windows** |

---

## Architecture

```mermaid
flowchart TD
    U["User (Telegram / Discord / WhatsApp / Heartbeat)"] --> OC["OpenClaw Gateway"]
    OC --> CS["clawsub Cooldown Router & Guardrails"]
    CS -->|1. Primary healthy| P1["claude CLI (Claude Pro / Max)"]
    CS -->|2. Primary in 5h/weekly cooldown (0ms skip)| P2["codex CLI (ChatGPT Plus / Pro)"]
    CS -->|3. Fallback #1 in cooldown (0ms skip)| P3["agy / gemini CLI (Google AI / Free Tier)"]
    CS -->|4. Optional offline fallback| P4["ollama CLI (Local Hardware)"]
    CS -->|All in cooldown| PAUSE["Auto-Pause Heartbeats (NO_REPLY) + Exact Reset Notice"]
```

---

## 60-Second Quickstart

### 1. Log into the subscription CLIs you own (no API keys!)
Log in with your browser on at least **one** paid subscription CLI (and optionally add `agy` / `gemini` or `ollama` as a $0 fallback):

```bash
# Claude Pro / Max
claude login

# ChatGPT Plus / Pro
codex login

# Google Antigravity / Gemini CLI (Pro or Free Tier)
agy
```

### 2. Initialize `openclaw-sub`

```bash
npx openclaw-sub init --chain claude,codex,agy --probe
```

What `clawsub init` does:
1. Verifies your `openclaw` installation.
2. Scans installed subscription CLIs (`claude`, `codex`, `agy`, `ollama`) and checks OAuth session state.
3. Generates cooldown-aware headless wrapper shims in `~/.openclaw/bin/` (`clawsub-router`, `clawsub-claude`, `clawsub-codex`, `clawsub-agy`).
4. Applies **Subscription-Saver Guardrails** (quiet windows + pre-standup quota reservation windows).
5. Runs live `DIRECT_OK` and `FALLBACK_OK` verification probes (`--probe`).

---

## CLI Commands

### Check live status & active cooldown timers
```bash
clawsub status
```
Example output:
```text
🦞 clawsub status

Chain:               claude -> codex -> agy
Workspace:           /home/user/clawbot/workspace
Last Active CLI:     codex
Quiet Windows:       23:00-08:00
Quota Reservation:   06:30-08:45, 19:00-21:30

Providers:
  • [primary]     claude (Claude Pro / Max): cooling_down (resets 2026-11-25T23:55:00.000Z, ~42m)
  • [fallback-#1] codex (ChatGPT Plus / Pro): ready (1840ms)
  • [fallback-#2] agy (Google AI Pro / Ultra / Free Tier): ready (2110ms)
```

### Diagnose headless traps or expired OAuth logins
```bash
clawsub doctor
```
Catches:
- Missing or unauthenticated CLIs (`~/.claude`, `~/.codex`, `~/.gemini`)
- Interactive TUI permission traps (e.g., missing `~/.gemini/antigravity-cli/settings.json` or out-of-workspace path mismatches that block headless turns)
- Single-subscription setups without a free-tier fallback

### Run live failover smoke tests
```bash
clawsub test
```
Sends a lightweight `reply with exactly: <PROVIDER>_DIRECT_OK` / `<PROVIDER>_FALLBACK_OK` probe to each configured CLI in your chain.

### Route a prompt through the chain manually
```bash
clawsub run "Summarize today's git commits in 3 bullets"
```

### Clear cooldown state after upgrading or switching accounts
```bash
clawsub reset          # clear all cooldowns
clawsub reset claude   # clear only claude
```

---

## Subscription-Saver Guardrails (`~/.openclaw/clawsub.json`)

`clawsub init` creates `~/.openclaw/clawsub.json` with sensible defaults tailored for flat-rate subscriptions:

```json
{
  "chain": ["claude", "codex", "agy"],
  "workspace": "/home/user/clawbot/workspace",
  "defaultCooldownMinutes": 60,
  "cooldownBufferMinutes": 5,
  "pauseHeartbeatsWhenAllCoolingDown": true,
  "quietWindows": ["23:00-08:00"],
  "quotaReservationWindows": ["06:30-08:45", "19:00-21:30"]
}
```

- **`quietWindows` (`23:00-08:00`):** Background `[OpenClaw heartbeat poll]` turns immediately return `NO_REPLY` overnight without spawning a CLI process. Direct user messages on Telegram/Discord still work 24/7.
- **`quotaReservationWindows` (`06:30-08:45`, `19:00-21:30`):** Reserves your 5-hour subscription window ahead of morning standups (08:30) and evening reports (21:00) so background polling never starves scheduled briefings.
- **Smart Reset Parsing:** When a CLI outputs `usage_limit_reached: resets 6:50pm` or `hit your weekly limit. Resets Nov 28, 10:00am`, `clawsub` parses the exact timestamp, adds a 5-minute buffer, and skips that CLI in **0ms** until the window resets.

---

## Headless TUI Trap Guide

When running subscription CLIs inside a daemon or background gateway (like OpenClaw), interactive terminal prompts will hang the turn. Here is how `clawsub` keeps each CLI headless-safe:

1. **Claude Code CLI (`claude`):** Invoked with `claude -p --output-format text` via stdin pipe.
2. **OpenAI Codex CLI (`codex`):** Invoked with `codex exec --skip-git-repo-check "<prompt>"`.
3. **Google Antigravity / Gemini CLI (`agy` / `gemini`):**
   - Always pass `--workspace <your-workspace-dir>` so file reads/writes stay inside the workspace boundary.
   - If your agent needs to run shell commands or read files outside the workspace during fallback turns, configure auto-approve in `~/.gemini/antigravity-cli/settings.json` (or via `/settings` inside an interactive `agy` session).

---

## Documentation

- [Technical Architecture & Failover Internals](docs/ARCHITECTURE.md)
- [Community & Launch Guide (`SOCIALIZATION.md`)](docs/SOCIALIZATION.md)

## License

[MIT](LICENSE) © 2026 Edson Cimionatto
