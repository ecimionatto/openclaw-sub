# v1.0 Release Checklist

> All items must be green before tagging v1.0 or enabling Louis agent dogfooding.

## Automated gates (CI must be green)

- [ ] `node --test test/*.test.mjs` — all 65+ unit tests pass
- [ ] `bash test/e2e/run.sh` — core e2e pack+install+run passes on ubuntu-latest and macos-latest
- [ ] `bash test/e2e/scenarios/run-all.sh` — all 11 scenario scripts pass on ubuntu-latest and macos-latest
- [ ] Node 20 and Node 22 matrix green

## Scenario green gate (all 11 must pass)

| # | Scenario | Status |
|---|----------|--------|
| 01 | claude limit → codex failover | ⬜ |
| 02 | codex limit → agy failover | ⬜ |
| 03 | all providers exhausted → clear error + reset ETA, no retry storm | ⬜ |
| 04 | auth expired → `auth_expired` status + login hint, no failover loop | ⬜ |
| 05 | weekly limit → cooldown with real `resetAt` ETA | ⬜ |
| 06 | baton handoff preserves last turns + session across provider switch | ⬜ |
| 07 | `init` writes backup, preserves existing config, re-run is idempotent | ⬜ |
| 08 | uninstall/rollback restores original `openclaw.json` | ⬜ |
| 09 | `doctor` exits 0 on healthy setup; surfaces warning on broken setup | ⬜ |
| 10 | concurrent runs leave valid (non-corrupt) state JSON | ⬜ |
| 11 | CS-20 config variants: custom order, single provider, optional missing | ⬜ |

## Must-fix bugs before v1.0

- [ ] No open `bug` / `must` issues in GitHub (label filter: `type:bug status:open`)
- [ ] No `P0` or `P1` issues unresolved

## Manual smoke test (run once per platform)

- [ ] Fresh Ubuntu 22.04 VM: `curl … | bash` bootstrapper completes without error
- [ ] Fresh macOS 14: `npx openclaw-sub init --chain claude,codex,agy` completes
- [ ] `clawsub doctor` reports all three providers as installed/detected
- [ ] Live failover: trigger claude 5h limit, confirm codex takes over within 5 s
- [ ] `clawsub status` shows correct provider states after failover

## Package hygiene

- [ ] `npm pack --dry-run` includes no unintended files (secrets, test dirs)
- [ ] `package.json` `"files"` array covers all shipped artifacts
- [ ] `CHANGELOG.md` entry for v1.0 written
- [ ] `README.md` installation section accurate for published package

## Sign-off

- [ ] @ecimionatto approves PR
- [ ] CI green on the merge commit
- [ ] `npm publish --dry-run` completes without errors
