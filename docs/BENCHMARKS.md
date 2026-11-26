# `clawsub` Benchmarks & 30-Day Cost/Uptime Comparison

Concrete numbers comparing three setups for running an always-on OpenClaw personal agent.

---

## 30-Day Workload Model

A realistic 24/7 personal agent workload used as the benchmark baseline:

| Activity | Frequency | 30-Day Total |
| :--- | :--- | ---: |
| Heartbeats (health / memory polls) | 48/day (every 30 min) | **1,440** |
| Standups / reports | 2/day | **60** |
| Chat turns (Telegram / Discord) | 40/day | **1,200** |
| **Total turns** | | **2,700** |

### Token estimates per turn

| Turn type | Avg prompt tokens | Avg response tokens | Total tokens |
| :--- | ---: | ---: | ---: |
| Heartbeat | 200 | 100 | 300 |
| Standup / report | 1,500 | 800 | 2,300 |
| Chat turn | 800 | 400 | 1,200 |

### Monthly token totals (baseline)

| Turn type | Count | Input tokens | Output tokens |
| :--- | ---: | ---: | ---: |
| Heartbeats | 1,440 | 288,000 | 144,000 |
| Standups | 60 | 90,000 | 48,000 |
| Chat turns | 1,200 | 960,000 | 480,000 |
| **Total** | **2,700** | **1,338,000** | **672,000** |

---

## Cost Comparison

### Setup A: Raw API Keys

You pay per token on every turn. No subscription benefit, no failover — quota exhaustion
returns an error (and keeps charging if retried).

| Provider (API pricing) | Input $/M | Output $/M | 30-day bill (baseline workload) |
| :--- | ---: | ---: | ---: |
| Claude Opus API | $15.00 | $75.00 | **~$70.47** |
| OpenAI GPT/Codex API | $3.00 | $15.00 | **~$14.09** |
| Gemini API | $1.25 | $5.00 | **~$5.03** |

> These match the `PROVIDER_PRICING` constants in `src/savings.mjs` and are what
> `clawsub savings` reports as your estimated avoided spend.

### Setup B: Naive Single CLI (subscription, no failover)

One subscription CLI wired directly — `$0` extra API bill, but:

- **Uptime**: Each subscription CLI has a rolling 5-hour usage window; once the cap is
  reached the bot goes offline until the window resets — from minutes to hours later,
  depending on when in the window the cap was hit.
- **Recovery time** after quota hit: manual human intervention required (minutes → hours)
- **Overnight drain**: if heartbeats are not paused, overnight polling can drain the
  quota window before your morning standup, leaving zero turns for daytime use.

### Setup C: `clawsub` multi-subscription failover

| Metric | Value |
| :--- | :--- |
| Extra monthly API bill | **$0** (uses existing subscriptions) |
| Failover latency on quota hit | **Automatic, same-turn** (quota error detected in-turn; next provider used immediately — no manual wait) |
| Uptime across 2 providers | **~95 %** (qualitative estimate; both providers simultaneously quota-exhausted ~5% of the time) |
| Uptime across 3 providers | **>99 %** (qualitative estimate; independent 5-hour windows rarely overlap simultaneously) |
| Overnight heartbeat drain | **Paused** during quiet/reservation windows; resumes on first active turn |
| Session continuity on failover | **Preserved** via Cross-Model Session Pass-Down Baton (`src/baton.mjs`) |

---

## Failure Recovery Timelines

| Setup | Event | Recovery path | Time to first successful turn |
| :--- | :--- | :--- | :--- |
| Raw API Keys | Budget exhausted | Add credit / raise limit | Minutes (human action required) |
| Naive Single CLI | 5-hour quota hit | Wait for window reset | 0 min – 5 hrs (depends on window) |
| Naive Single CLI | Weekly quota hit | Wait for weekly reset | 0 – 7 days |
| **`clawsub`** | Primary quota hit | Auto-failover to next provider | **Automatic, same-turn** |
| **`clawsub`** | All providers in quota | Heartbeats paused; exact reset time logged | Resumes at earliest provider reset |

### Scenario walk-through: 2 AM quota exhaustion

```
02:14  claude CLI hits 5-hour rolling cap → clawsub detects quota error
02:14  codex CLI activated (automatic same-turn failover) → turn completes
02:14  baton.mjs writes session context to ~/.openclaw/baton.json (codex inherits claude's state)
06:50  claude window resets → clawsub re-probes claude → primary restored automatically
```

Without `clawsub` (naive single CLI): bot offline from 02:14 until a human manually switches or the window resets — potentially missing your 08:30 standup.

---

## Reproduction Commands

Run these against a live `clawsub` installation to reproduce the numbers above.

```bash
# 1. Check live provider status and active cooldown timers
clawsub status --json

# 2. View accumulated savings vs. equivalent API bill (uses PROVIDER_PRICING constants)
clawsub savings

# 3. Full diagnostic: provider chain health, openclaw.json validity, session baton state
clawsub doctor --json

# 4. Reproduce the documented baseline numbers
#    Run from the repository root directory.
export BENCH_HOME=$(mktemp -d) && mkdir -p "$BENCH_HOME/.openclaw"

# Write a 30-day fixture (baseline workload split across providers by turn count)
node --input-type=module --eval "
  import fs from 'node:fs';
  const state = {
    providers: {},
    savings: {
      providers: {
        claude: { turnCount: 2000, promptChars: 3964000, responseChars: 1992000 },
        codex:  { turnCount: 500,  promptChars: 991000,  responseChars: 498000  },
        agy:    { turnCount: 200,  promptChars: 397000,  responseChars: 198000  },
      },
      firstRecordedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      lastRecordedAt:  new Date().toISOString(),
    },
  };
  fs.writeFileSync(process.env.BENCH_HOME + '/.openclaw/clawsub-state.json', JSON.stringify(state));
"

# Run savings against the fixture
HOME="$BENCH_HOME" node ./bin/clawsub.mjs savings

# 5. Check installed versions of clawsub, OpenClaw, and all subscription CLIs
clawsub version
```

### Expected `clawsub savings` output (baseline workload, 2000/500/200 split)

```
🦞 clawsub savings (v0.3.0)

Tracked window:  30.0 days  |  2,700 turns

Provider               Turns   Input tokens   Output tokens   Saved (est.)
──────────────────────────────────────────────────────────────────────────
Claude Opus API (est.) 2,000      991,000        498,000        $52.2150
OpenAI GPT/Codex API     500      247,750        124,500         $2.6108
Gemini API               200       99,250         49,500         $0.3716
──────────────────────────────────────────────────────────────────────────
Total                  2,700    1,338,000        672,000        $55.20/mo

30-day API equivalent (if all turns on claude primary):  ~$70.47
```

> Actual numbers depend on your subscription mix and turn sizes.
> `clawsub savings --json` outputs machine-readable values for scripting.

---

## Notes on Methodology

- Token estimates use `CHARS_PER_TOKEN = 4` (the constant in `src/savings.mjs`).
- Claude pricing uses Opus rates as a conservative upper bound; actual model may be cheaper.
- The 5-hour window model assumes uniform turn distribution; burst usage drains quota faster.
- Uptime percentages are qualitative estimates, not measured — actual uptime depends on your
  subscription tier and usage pattern. Use `clawsub status --json` to observe real-world
  cooldown behavior.
