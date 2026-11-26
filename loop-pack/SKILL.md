# SDLC Loop Pack — Skill Procedure

## Purpose
Ship features continuously on flat-rate AI subscriptions with a reproducible backlog → worker → review → fix → merge gate → standup cycle, $0 extra API cost.

## Stages

### 1. Backlog
Edit `templates/BACKLOG.md` to list tasks. Each row: `| TASK-ID | description | priority | status |`. Keep one task per isolated worktree.

### 2. Isolated Worker
For each backlog task pick the next `todo` item, create a git worktree:
```
git worktree add -b feat/<TASK-ID> ../worktrees/<TASK-ID> main
```
Launch the worker agent using `templates/worker-prompt.md` with the task filled in. Worker commits, pushes, opens a draft PR.

### 3. Blind Review
Once the worker's PR is open, launch a **separate** agent session (no shared context with the worker) using `templates/review-prompt.md`. The reviewer outputs one of:
- `APPROVE sha=<commit-sha>` — passes merge gate
- `FIX <reason> sha=<commit-sha>` — sends back for capped fixes
- `BLOCK <reason> sha=<commit-sha>` — closes PR, returns task to backlog

### 4. Capped Fixes
On `FIX`, launch one fix agent using `templates/fix-prompt.md`. The fix agent gets a **hard turn cap** (default: 15 tool calls). If not resolved within cap, escalate to `BLOCK`.

### 5. Merge Gate
On `APPROVE sha=<sha>`, verify the branch HEAD matches the sha before merging:
```
git rev-parse HEAD  # must equal sha from review
gh pr merge --squash --delete-branch <PR>
```

### 6. Standup
After each merge (or at cadence), append a row to `templates/standup.md` and optionally post to your team channel.

## Running with clawsub

Initialise a workspace:
```
clawsub loop init [--workspace <path>] [--dry-run]
```

Suggested cron lines are printed after init. Add them to your crontab with `crontab -e`.

## Conventions
- One task per worktree — never share mutable state between workers.
- Workers must not modify files outside their task scope.
- Reviews are always blind — no access to the worker's conversation context.
- Fix cap is enforced by the caller (scheduler or human). The fix agent does not self-report exhaustion.
