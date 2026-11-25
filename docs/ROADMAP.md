# `openclaw-sub` (`clawsub`) Product Roadmap & Socialization Plan

**Mission:** Make `openclaw-sub` (`clawsub`) the standard open-source way for both **humans** and **AI agents** to install and run [OpenClaw](https://openclaw.ai) 24/7 on flat-rate AI subscriptions (`claude`, `codex`, `agy` / `gemini`) with **$0 extra API bills**.

---

## Phase 1 — Native OpenClaw Runtime & Zero-Friction Ubuntu Setup (Current Sprint: v0.3)

| ID | Tier | Milestone | Outcome |
| :--- | :--- | :--- | :--- |
| **CS-01** | **Must** | Bundle `@local/openclaw-agy-cli` plugin & patch `~/.openclaw/openclaw.json` natively | `clawsub init` backs up and patches `~/.openclaw/openclaw.json` with native `claude-cli`, `codex`, and `agy-cli` runtimes (`sessionCatalog.enabled: false`) and registers the bundled `openclaw-agy-cli` stream-json plugin. |
| **CS-02** | **Must** | Headless Auth Doctor & Auto-Remediation (`openclaw models auth login`) | `clawsub doctor` inspects `~/.openclaw/openclaw.json` and recent OpenClaw gateway errors, detecting auth timeouts and running or printing `openclaw models auth login --provider <id> --force`. |
| **CS-03** | **Should** | Ubuntu `systemd --user` service & `loginctl enable-linger` installer | `clawsub install-ubuntu --systemd` generates and enables a resilient user service for OpenClaw with full Node/CLI PATH and auto-restart. |
| **CS-04** | **Should** | Usage & Quota Savings Estimator (`clawsub savings`) | Parses local CLI/OpenClaw turn logs and estimates how much raw API money ($USD) the user saved this week/month by routing over subscription CLIs. |

---

## Phase 2 — Agent-to-Agent & Human Socialization / Discovery (v0.4)

To grow adoption among **both humans and autonomous agents**, `openclaw-sub` ships machine-readable discovery artifacts alongside human launch assets:

| ID | Tier | Milestone | Outcome |
| :--- | :--- | :--- | :--- |
| **CS-05** | **Must** | Agent-to-Agent Discovery Manifests (`llms.txt`, `llms-full.txt`, `.well-known/agent.json`) | Any web-browsing or GitHub-crawling agent (Claude Code, Codex, Antigravity, Perplexity, OpenClaw research agents) immediately gets a structured, copy-pasteable install & verification spec when inspecting the repo. |
| **CS-06** | **Should** | OpenClaw Plugin & Skill Registry Packaging (`openclaw.plugin.json` at root) | Makes `openclaw-sub` directly installable as an official OpenClaw plugin/skill package (`openclaw plugins install openclaw-sub`). |
| **CS-07** | **Should** | Interactive Terminal Demo & Benchmark Comparison (`docs/BENCHMARKS.md`) | Side-by-side 30-day cost & uptime table comparing Raw API Keys ($148/mo) vs Single CLI (downtime on 5h cap) vs `clawsub` ($0 extra, 99.9% uptime via failover), plus SVG terminal cast for README. |
| **CS-08** | **Could** | Community Contribution & Issue Templates + Awesome-List PR Kit | `.github/ISSUE_TEMPLATE/`, `CONTRIBUTING.md` (how to add a new subscription CLI adapter like Cursor/Windsurf/Copilot CLI), and ready-to-submit PR diffs for `awesome-openclaw` / `awesome-claude-code`. |

---

## Phase 3 — Smart Context Continuity & npm Publication (v0.5)

| ID | Tier | Milestone | Outcome |
| :--- | :--- | :--- | :--- |
| **CS-09** | **Should** | Pre-Quota Context Compaction & Session Handoff | Automatically triggers `/compact` or summarizes recent turns when switching from primary (`claude-cli`) to fallback (`agy-cli` / `codex`) so the fallback model has full thread context without overflowing tokens. |
| **CS-10** | **Could** | Automated npm Publish Workflow (`npx openclaw-sub`) | GitHub Actions OIDC provenance publishing to npm on `v*` release tags (requires Edson's `NPM_TOKEN` secret on GitHub). |

---

## Daily SDLC Cadence

1. **Every 20 Minutes (`work_tick.py`):**
   - Picks the highest-priority `ready` `CS-*` task from `BACKLOG.md`, spawns an isolated `clawworker` worktree against `ecimionatto/openclaw-sub`, runs blind review + GitHub Actions CI + `pre-merge-check.sh`, and squash-merges on green.
2. **Every Night at 21:00 EST (Research Cycle):**
   - Rotates through `THEMES_CLAWSUB.md` (technical + socialization themes), archives the report to `~/clawbot/reports/YYYY-MM-DD.md`, delivers to Telegram, and seeds a new `CS-*` row in `BACKLOG.md`.
3. **Every Morning at 08:30 EST (Daily Standup & Blocker Notification):**
   - Reports `CS-*` PRs merged, active work, GitHub repo traction (stars, forks, issues, PRs, views), socialization actions ready for Edson, and any blockers needing human credentials/approval.
