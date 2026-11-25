# Changelog

All notable changes to `openclaw-sub` (`clawsub`) are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-25

### Added
- **Cross-Model Shared Context & Session Pass-Down Baton (`src/baton.mjs` & `clawsub baton`):**
  - Solves **split-brain session amnesia** across subscription CLIs (`claude`, `codex`, `agy`, `ollama`), each of which stores sessions in its own isolated native directory.
  - **Mid-Turn Credit Exhaustion Handoff:** When a model runs out of credits mid-task, `clawsub` captures its partial stdout + uncommitted git worktree changes (`git status --short` + `git diff --stat`) and passes the baton down to the fallback CLI so execution resumes in-place without losing work.
  - **Round-Trip Delta Catch-Up (A → B → A):** Tracks per-provider turn watermarks (`lastSeenTurnByProvider`). When Primary (`claude`) recovers after its 5-hour or weekly cooldown resets, it automatically receives the delta turns completed on Fallback (`codex` / `agy`) while it was offline.
  - Added `clawsub baton [--session <key>] [--clear] [--json]` CLI command.

## [0.2.0] - 2026-11-25

### Added
- **Ubuntu Turnkey Installer (`scripts/install-ubuntu.sh` & `clawsub install-ubuntu`):**
  - Installs missing Ubuntu/Debian system packages (`curl`, `git`, `ca-certificates`, `gnupg`, `jq`), Node.js 22+ LTS (if needed), `openclaw` (with explicit `--openclaw-version` pinning), subscription CLIs (`claude`, `codex`, `gemini`), and wires `clawsub`.
- **Version Management & Snapshots (`src/versions.mjs` & `clawsub version`):**
  - Added `clawsub --version` (`-v`) and `clawsub version [--json]`.
  - Records pre-install/pre-upgrade version snapshots of Node, OpenClaw, and all subscription CLIs in `~/.openclaw/clawsub-versions.json`.
- **Installable Agent Skill (`skills/clawsub/SKILL.md` & `clawsub install-skill`):**
  - Packaged a portable `SKILL.md` that installs into both OpenClaw (`skills/clawsub/SKILL.md`) and Antigravity/Claude Code (`.agents/skills/clawsub/SKILL.md`) so the agent can check its own quota cooldowns, reorder providers, and run doctor checks from chat.
- **Automated GitHub Release Workflow (`.github/workflows/release.yml`):**
  - Pushes on `v*` tags run the test suite and publish a GitHub Release with `install-ubuntu.sh` attached.

## [0.1.0] - 2026-11-25

### Added
- Initial release of `openclaw-sub` (`clawsub`).
- Multi-subscription failover router across `claude` -> `codex` -> `agy` -> `ollama` with 0ms cooldown fast-skip.
- 5-hour and weekly quota regex detection and exact reset timestamp parser (`src/quota.mjs`).
- Quiet hours (`23:00-08:00`) and pre-standup quota-reservation windows (`06:30-08:45`, `19:00-21:30`) for background OpenClaw heartbeats.
- `clawsub init`, `clawsub status`, `clawsub doctor`, `clawsub test`, `clawsub run`, `clawsub exec`, and `clawsub reset`.
