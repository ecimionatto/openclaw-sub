---
name: New provider adapter
about: Track work to add a new subscription CLI (Cursor, Windsurf, GitHub Copilot CLI, etc.)
title: "feat: add <ProviderName> adapter"
labels: new-provider
assignees: ""
---

## Provider details

- **CLI binary name:** <!-- e.g. cursor, windsurf, gh -->
- **Subscription plan(s):** <!-- e.g. Cursor Business, Windsurf Pro -->
- **Install command:** <!-- e.g. npm install -g @cursor-ai/cursor -->
- **Login command:** <!-- e.g. cursor login -->
- **Official docs / homepage:** <!-- URL -->

## Headless / non-interactive mode

Does the CLI support a fully non-interactive mode (no TUI, no confirmation prompts)?

- [ ] Yes — command and flags: `<!-- e.g. cursor exec --no-tty --output text "<prompt>" -->`
- [ ] No — interactive mode only (explain below)
- [ ] Unknown — needs investigation

<!-- If "No" or "Unknown", describe what you know about the interactive behavior. -->

## OAuth session location

Where does the CLI store its session / credentials on disk?

<!-- e.g. ~/.cursor/session.json, ~/.config/windsurf/auth -->

## Quota / rate-limit error signals

What does the CLI output when the subscription quota is exhausted?

```
<!-- Paste example stderr/stdout from a quota-exhausted run, or "unknown". -->
```

Does it include a reset time?

- [ ] Yes — format: `<!-- e.g. "Try again at 6:30 PM" -->`
- [ ] No
- [ ] Unknown

## Implementation checklist

- [ ] Test added to `test/clawsub.test.mjs` (adapter shape + `buildCommand`)
- [ ] Adapter added to `src/providers.mjs`
- [ ] Quota error fixture(s) added to `test/fixtures/cli-errors/`
- [ ] `CONTRIBUTING.md` provider list updated (if applicable)
- [ ] `node --test test/*.test.mjs` passes
- [ ] `node ./bin/clawsub.mjs help` exits 0

## Notes / open questions

<!-- Anything else reviewers should know. -->
