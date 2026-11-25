# CLAUDE.md — `openclaw-sub` (`clawsub`) Repository Guide

## Mission
`openclaw-sub` (`clawsub`) is an open-source CLI, Ubuntu bootstrapper, OpenClaw plugin, and agent skill that lets users run [OpenClaw](https://openclaw.ai) 24/7 on flat-rate AI subscriptions (`claude`, `codex`, `agy` / `gemini`, `ollama`) with **$0 extra API bills** and automatic 0ms quota failover.

## Repository Constraints (Non-Negotiable)
1. **Zero External Runtime Dependencies:** Use Node.js (>=18) built-in ESM modules only (`node:fs`, `node:path`, `node:os`, `node:child_process`, `node:test`, `node:assert/strict`). Never add runtime `dependencies` to `package.json` so `npx openclaw-sub` executes instantaneously.
2. **No Hardcoded User Paths or Secrets:** Never hardcode `/home/ecimio` or real tokens in source code; use `os.homedir()`, `process.env.CLAWSUB_HOME`, or explicit function parameters with unit-testable overrides.
3. **Test Suite Must Pass:** Run `node --test test/*.test.mjs` and `node ./bin/clawsub.mjs help` before committing. Every new feature or file must have unit test coverage in `test/clawsub.test.mjs`.
4. **Package Exports & Files:** When adding new top-level files or directories (e.g. `plugins/`, `llms.txt`, `.well-known/`, `openclaw.plugin.json`), ensure `package.json` `"files"` includes them if they should ship in the npm package.
