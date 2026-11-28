# Contributing to `openclaw-sub` (`clawsub`)

Thank you for helping make flat-rate AI subscriptions work better for everyone.

## Quick Setup

```bash
git clone https://github.com/ecimionatto/openclaw-sub.git
cd openclaw-sub
node --test test/*.test.mjs   # all 62+ tests must pass
node ./bin/clawsub.mjs help
```

No `npm install` needed — the project has zero runtime dependencies (Node.js >= 18 built-ins only).

## Ground Rules

- **Zero external runtime dependencies.** Node built-in modules only (e.g. `node:fs`, `node:path`, `node:os`, `node:child_process`, `node:test`, `node:assert/strict`, `node:url`). Never add entries to `dependencies` in `package.json`.
- **Test-first.** Add or update tests in `test/clawsub.test.mjs` before changing implementation code.
- **No hardcoded paths or secrets.** Use `os.homedir()`, `process.env.CLAWSUB_HOME`, or explicit function parameters.
- **Functional style.** Prefer immutable data and pure functions; avoid shared mutable state.
- **No unnecessary comments.** Only add one when the *why* is non-obvious (a hidden constraint, workaround, or subtle invariant).

## Running Tests

```bash
node --test test/*.test.mjs
node ./bin/clawsub.mjs help
```

Both commands must exit 0 before you open a PR.

---

## Adding a New Subscription CLI Provider

This is the most common contribution. Each provider is a single adapter object inside `src/providers.mjs`.

### Step-by-step guide

#### 1. Identify the CLI

Confirm three things about the target subscription CLI:

| Question | Why it matters |
| :--- | :--- |
| What is the binary name? | Used in `binary` and `buildCommand`. |
| Does it support a non-interactive / headless mode? | `clawsub` runs the CLI without a terminal; interactive prompts will hang forever. |
| Where does it store its OAuth session? | Used in `checkAuth` to detect whether the user is logged in. |

> **Candidate examples:** `cursor` (Cursor Business), `gh copilot` (GitHub Copilot CLI), `windsurf` (Windsurf Pro).

#### 2. Write the test first

Open `test/clawsub.test.mjs` and add a describe block for your provider:

```js
test("providers: myNewCLI adapter shape is valid", () => {
  const p = PROVIDERS.myNewCLI;
  assert.ok(p.id === "myNewCLI");
  assert.ok(typeof p.buildCommand === "function");
  assert.ok(typeof p.checkAuth === "function");
  assert.ok(typeof p.checkHeadlessSafety === "function");

  const cmd = p.buildCommand("hello world");
  assert.ok(Array.isArray(cmd.args));
  assert.equal(cmd.command, p.binary);
});
```

Run `node --test test/*.test.mjs` — the test must **fail** at this point (red-green-refactor).

#### 3. Add the adapter to `src/providers.mjs`

Add your provider inside the `PROVIDERS` object. Copy the shape from an existing provider (e.g. `agy`) and fill in the required fields. Some adapters also define `altBinary` when the CLI can be invoked under a second binary name (e.g. `agy` ships `altBinary: "gemini"`) — include it if your CLI has an alias:

```js
myNewCLI: {
  id: "myNewCLI",
  name: "My New CLI",
  subscription: "My New Subscription Plan",
  binary: "mynewcli",
  installHint: "npm install -g @vendor/mynewcli",
  loginHint: "mynewcli login",

  buildCommand(prompt, opts = {}) {
    const args = ["--headless", "--output", "text"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    return { command: "mynewcli", args, input: prompt };
  },

  checkAuth(homeDir = os.homedir()) {
    const sessionFile = path.join(homeDir, ".mynewcli", "session.json");
    const hasAuth = fs.existsSync(sessionFile);
    return {
      authenticated: hasAuth,
      detail: hasAuth
        ? "OAuth session found (~/.mynewcli/session.json)"
        : "No session found — run `mynewcli login`",
    };
  },

  checkHeadlessSafety() {
    return {
      safe: true,
      warnings: [],
      detail: "Uses `mynewcli --headless --output text` (non-interactive)",
    };
  },
},
```

**Key rules for `buildCommand`:**
- Must accept `(prompt, opts = {})` and return `{ command, args, input }`.
- `input` is the string piped to stdin (or `undefined` if the prompt is passed as a CLI argument).
- The invocation must be fully non-interactive — no TUI, no confirmation prompts.

**Key rules for `checkAuth`:**
- Must return `{ authenticated: boolean, detail: string }`.
- Use only `fs.existsSync` on well-known config paths; never spawn a subprocess.

**Key rules for `checkHeadlessSafety`:**
- Must return `{ safe: boolean, warnings: string[], detail: string }`.
- Set `safe: false` if the CLI has known interactive prompts that cannot be suppressed.

#### 4. Add the provider to the default chain (optional)

If the new provider should appear in the default failover chain, you must update **all three** places that define the default:

1. `src/state.mjs` — `DEFAULT_CONFIG.chain` array (the authoritative default; `loadConfig` merges from this).
2. `src/openclaw-config.mjs` — the `chain` fallback in `generateOpenClawIntegration` (`config.chain || ["claude", "codex", "agy"]`).
3. `src/router.mjs` — the `chain` fallback in `routePrompt` (`config.chain || ["claude", "codex", "agy"]`).

> **Note:** An existing `~/.openclaw/clawsub.json` or `state.json` stores the user's saved chain. Those files take precedence over code defaults, so users who have already configured their chain will not automatically pick up the new provider. Document this in your PR.

Open an issue first if you are unsure — changing the default chain affects all users.

#### 4.5. Verify cooldown persistence

`loadState` in `src/state.mjs` stores provider state as a plain JSON object keyed by provider ID — no hardcoded list of known providers. This means your new provider's quota cooldown is automatically preserved across save/reload cycles without any changes to `src/state.mjs`.

Add a test confirming this:

```js
test("providers: myNewCLI cooldown survives saveState/loadState round-trip", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsub-myNewCLI-"));
  const cooldownUntil = new Date(Date.now() + 3_600_000).toISOString();
  const state = { providers: { myNewCLI: { status: "cooldown", cooldownUntil } }, savings: { providers: {}, firstRecordedAt: null, lastRecordedAt: null } };
  saveState(state, tmpDir);
  const loaded = loadState(tmpDir);
  assert.equal(loaded.providers.myNewCLI.cooldownUntil, cooldownUntil);
});
```

#### 5. Document the quota / reset signals

Subscription CLIs emit different error messages when the quota is exhausted. Add any new error patterns to `test/fixtures/cli-errors/` as a plain-text `.txt` file containing the raw stderr output, then add a corresponding row to the hardcoded table in the `"fixture-driven: each cli-error fixture classifies and parses correctly"` test in `test/clawsub.test.mjs`:

```js
{ file: "mynewcli-quota-exceeded.txt", isQuota: true, isAuth: false, parsed: null },
```

If the error includes a parseable reset time, set `parsed` to an object with the expected time fields (`hours`, `minutes`, `month`, `date`, `year`). The `date` field is the day-of-month (1–31), not a weekday.

#### 6. Verify everything

```bash
node --test test/*.test.mjs   # must be all green
node ./bin/clawsub.mjs help
```

#### 7. Open a PR

Use the **New Provider** issue template (`.github/ISSUE_TEMPLATE/new_provider.md`) to track your work, then open a PR that links to the tracking issue.

---

## Other Contributions

| Area | Where to look |
| :--- | :--- |
| Quota / reset-time parsing | `src/quota.mjs`, `test/fixtures/cli-errors/` |
| Cross-model session baton | `src/baton.mjs` |
| Ubuntu bootstrapper | `scripts/install-ubuntu.sh` |
| Agent skill | `SKILL.md` |
| Loop-pack templates | `loop-pack/` |

## Filing Bugs

Use `.github/ISSUE_TEMPLATE/bug_report.md`. Include your OS, Node.js version, `clawsub` version (`node ./bin/clawsub.mjs version`), and the full error output.

## Code of Conduct

Be kind. Be direct. Focus on the work.

---

## Release Flow (CD Pipeline)

Every green merge to `main` ships automatically via `.github/workflows/cd.yml`.

### How the pipeline works

1. **Unit tests** run on Node 18, 20, and 22.
2. **Docker e2e** builds the image and runs the test container.
3. **Eval scenarios** (CS-18) run `test/eval.test.mjs`.
4. **Release job** (after all three pass):
   - Runs `scripts/next-version.mjs` to compute the next semver from conventional commits since the last tag.
   - Sets `package.json` version in the runner workspace and pushes a `vX.Y.Z` tag (no commit to `main`).
   - Creates a GitHub Release with auto-generated notes.
   - Runs `npm publish --tag next` if `NPM_TOKEN` is set; prints a notice and skips otherwise.
5. **Promote job** (gated by the `production` GitHub Environment — requires Edson's approval):
   - Runs `npm dist-tag add openclaw-sub@X.Y.Z latest`.

### Semver bump rules

| Commit prefix | Bump |
|---------------|------|
| `feat:` | **minor** |
| `fix:`, `chore:`, `perf:`, etc. | **patch** |
| `feat!:` or `BREAKING CHANGE:` | **major** (but stays **minor** while no `v1.x` tag exists) |

Write your commit/PR title using the [Conventional Commits](https://www.conventionalcommits.org/) format — it drives the version bump directly.

See `docs/RELEASE-CHECKLIST.md` for edge-case procedures (rollbacks, forced versions, skipping CI).
