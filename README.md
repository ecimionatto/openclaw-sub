# 🦞 `openclaw-sub` (`clawsub`)

> **Install and run [OpenClaw](https://openclaw.ai) 24/7 on Ubuntu/macOS using the flat-rate AI subscriptions you already pay for (`claude`, `codex`, `agy` / `gemini`) — zero API keys, zero per-token bill, automatic 0ms quota failover, version pinning, and a built-in agent `SKILL.md`.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version: 0.3.0](https://img.shields.io/badge/version-0.3.0-purple.svg)](CHANGELOG.md)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)
[![Benchmarks](https://img.shields.io/badge/benchmarks-30--day%20cost%20model-orange.svg)](docs/BENCHMARKS.md)

---

## Why `openclaw-sub` Exists

Running an always-on OpenClaw personal agent over raw API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) quickly burns **$50–$300+/month** in per-token charges once heartbeats, memory files, and long conversations add up.

Meanwhile, most builders **already pay $20–$200/month** for flat-rate consumer/pro subscriptions that include official local CLIs authenticated via browser OAuth:
- **Claude Pro / Max** → Claude Code CLI (`claude`)
- **ChatGPT Plus / Pro** → OpenAI Codex CLI (`codex`)
- **Google AI / Free Tier** → Google Antigravity / Gemini CLI (`agy` / `gemini`)

### Why wiring CLIs by hand breaks in production
If you just point a 24/7 agent at a subscription CLI out of the box, four things break:
1. **5-Hour & Weekly Rolling Caps:** When your primary subscription hits its 5-hour or weekly window (`usage_limit_reached: resets 6:50pm`), your bot either goes dead or wastes 30 seconds failing on the primary CLI on every single turn before falling back.
2. **Split-Brain Session Amnesia on Failover & Recovery:** Each CLI (`claude`, `codex`, `agy`) stores sessions in its own isolated format (`~/.claude`, `~/.codex`, `~/.gemini/antigravity-cli`). When Model A runs out of credits mid-conversation or mid-PR and fails over to Model B, Model B has **zero memory** of what Model A just decided or edited — and when Model A's credits reset hours later, Model A doesn't know what Model B did while it was offline!
3. **Headless TUI Permission Traps:** Subscription CLIs are built for interactive terminals. An unapproved file read or command prompt outside the workspace hangs a headless Telegram/Discord turn until it times out.
4. **Overnight Heartbeat Drain:** Default 30-minute heartbeats silently chew through your 5-hour subscription allowance while you sleep, leaving you with zero quota for your 8:30 AM standup or live chat.

**`openclaw-sub` (`clawsub`) fixes all four — with a built-in Cross-Model Session Pass-Down Baton (`src/baton.mjs`) — and bootstraps OpenClaw on Ubuntu in one command.**

---

## Cost & Reliability Comparison

> See [docs/BENCHMARKS.md](docs/BENCHMARKS.md) for a full 30-day workload model, per-provider cost breakdown, failure recovery timelines, and copy-pasteable reproduction commands.

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

## Quickstart

### Option A: One-Line Ubuntu 22.04 / 24.04 Full Bootstrapper (Fresh Server / VPS)
Installs missing Ubuntu system dependencies, Node.js 22+ LTS (if needed), **OpenClaw** (latest or version-pinned), the subscription CLIs (`claude`, `codex`, `gemini`), wires the `clawsub` failover shims, and installs the `clawsub` agent `SKILL.md`:

```bash
curl -fsSL https://raw.githubusercontent.com/ecimionatto/openclaw-sub/main/scripts/install-ubuntu.sh | bash
```

Need to pin a specific OpenClaw version or customize your chain on Ubuntu?
```bash
OPENCLAW_VERSION=2026.11.0 CLAWSUB_CHAIN=claude,codex,agy \
  curl -fsSL https://raw.githubusercontent.com/ecimionatto/openclaw-sub/main/scripts/install-ubuntu.sh | bash
```

#### VPS / headless systemd setup

After `openclaw gateway install` creates `~/.config/systemd/user/openclaw-gateway.service`, install the clawsub PATH drop-in so the failover chain resolves `claude`, `codex`, `agy`, `gemini` correctly under systemd (which does not inherit your login shell's PATH):

```bash
# Dry-run to preview the drop-in and PATH
npx openclaw-sub install-systemd --dry-run

# If you have a legacy openclaw-sub.service from a previous install, use --migrate
# (run this INSTEAD of --enable alone — prevents a port 18789 conflict):
npx openclaw-sub install-systemd --enable --migrate

# Fresh install (no legacy service): write the drop-in and restart openclaw-gateway
npx openclaw-sub install-systemd --enable
```

The drop-in is written to `~/.config/systemd/user/openclaw-gateway.service.d/clawsub.conf` and contains only:

```ini
[Service]
Environment="PATH=/home/user/.local/bin:/home/user/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin:/bin"
```

**Linger** (auto-start on boot without a login session) must be enabled once per user:
```bash
loginctl enable-linger $USER
```

clawsub warns automatically when linger is off or `XDG_RUNTIME_DIR` is unset.

### Option B: Existing Node.js / OpenClaw Machine (`npx`)

```bash
# 1. Log into the subscription CLIs you own via browser OAuth (no API keys!)
claude login
codex login
agy

# 2. Initialize clawsub (add --install-openclaw if OpenClaw isn't installed yet)
npx openclaw-sub init --chain claude,codex,agy --install-openclaw --install-skill --probe
```

---

## Built-In Agent Skill (`skills/clawsub/SKILL.md`)

Why is `clawsub` packaged as **both** a CLI bootstrapper and an agent `SKILL.md`?
- **Day 0 (Before OpenClaw exists):** You use `install-ubuntu.sh` or `npx openclaw-sub init --install-openclaw` to install OpenClaw and wire the subscription CLIs.
- **Day 1+ (Inside Telegram / Discord / Antigravity):** `clawsub init` automatically installs [`skills/clawsub/SKILL.md`](skills/clawsub/SKILL.md) into both `skills/clawsub/SKILL.md` (OpenClaw) and `.agents/skills/clawsub/SKILL.md` (Antigravity / Claude Code).
  - That means you can ask your bot directly in Telegram:
    - *"What's our subscription quota status?"* → Agent runs `clawsub status --json`
    - *"Switch primary to Codex and make Claude the fallback"* → Agent runs `clawsub init --chain codex,claude,agy`
    - *"Why did fallback fail?"* → Agent runs `clawsub doctor --json`

You can also install or refresh the skill in any workspace manually:
```bash
clawsub install-skill --workspace ~/clawbot/workspace
```

---

## Versioning & Safe Upgrades (`clawsub version`)

`openclaw-sub` tracks both its own semantic version ([CHANGELOG.md](CHANGELOG.md)) and snapshots the installed versions of Node.js, OpenClaw, and your subscription CLIs in `~/.openclaw/clawsub-versions.json` before every install or upgrade:

```bash
# Check installed versions of clawsub, OpenClaw, and all subscription CLIs
clawsub version

# Install or upgrade OpenClaw to a pinned version on Ubuntu
clawsub install-ubuntu --openclaw-version 2026.11.0
```

Example output:
```text
🦞 clawsub v0.2.0 (linux-x64, node v24.22.2)

OpenClaw:  ✓ OpenClaw 2026.11.14 (516722b)
Providers:
  • claude  (claude): ✓ 2.1.74 (Claude Code)
  • codex   (codex): ✓ codex-cli 0.114.0
  • agy     (agy): ✓ 0.1.0
  • ollama  (ollama): ✗ not installed
```

---

## CLI Commands

### Check live status & active cooldown timers
```bash
clawsub status
```
Example output:
```text
🦞 clawsub status (v0.2.0)

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

### Run live failover smoke tests
```bash
clawsub test
```

### Run end-to-end tests

The e2e suite packs the package as a tarball, installs it into a temp directory, and verifies the full init → doctor → failover → baton → install-skill flow using stub CLIs (no real Claude/Codex required).

```bash
npm run test:e2e
```

**Docker variant** (clean Ubuntu environment, mirrors CI):
```bash
docker build -t clawsub-e2e -f test/e2e/Dockerfile . && docker run --rm clawsub-e2e
```

**CI matrix** (`.github/workflows/e2e.yml`) runs on every push and pull request to `main`: a Docker job on `ubuntu-latest` (node:22-slim) plus a native matrix across `ubuntu-latest` and `macos-latest` × Node 20 and 22.

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

## Documentation

- [Technical Architecture & Failover Internals](docs/ARCHITECTURE.md)
- [Community & Launch Guide (`SOCIALIZATION.md`)](docs/SOCIALIZATION.md)
- [Agent Skill Definition (`skills/clawsub/SKILL.md`)](skills/clawsub/SKILL.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) © 2026 Edson Cimionatto
