import {
  injectSessionBaton,
  loadBatonStore,
  recordCompletedTurn,
  recordMidTurnCreditExhaustion,
  saveBatonStore,
} from "./baton.mjs";
import { PROVIDERS, defaultCommandRunner } from "./providers.mjs";
import { computeCooldownUntil, isHeartbeatPrompt, isQuotaError } from "./quota.mjs";
import {
  findActiveTimeWindow,
  getProviderCooldown,
  loadConfig,
  loadState,
  recordTurnSavings,
  saveState,
} from "./state.mjs";

/**
 * Executes a prompt across the configured subscription CLI chain (`claude` -> `codex` -> `agy`)
 * with shared cross-model session pass-down (Context Baton).
 *
 * Features:
 *  - 0ms fast-skip for providers currently in a 5-hour or weekly quota cooldown.
 *  - Shared Context & Session Pass-Down (`src/baton.mjs`):
 *      * When Provider A runs out of credit mid-turn, records partial output + git worktree changes
 *        and passes the baton to Provider B so work continues without losing state.
 *      * Tracks per-provider turn watermarks so when Provider A recovers after cooldown, it receives
 *        the delta turns completed by Provider B/C (zero split-brain amnesia).
 *  - Quota-reservation & quiet-window guardrails for background OpenClaw heartbeats.
 *  - Clean `NO_REPLY` auto-pause on heartbeats or reset-time notice when all providers are exhausted.
 *
 * @param {string} prompt
 * @param {{
 *   stateDir?: string,
 *   config?: object,
 *   state?: object,
 *   batonStore?: object,
 *   sessionKey?: string,
 *   now?: Date,
 *   runner?: Function,
 *   onlyProvider?: string,
 * }} [opts]
 */
export function routePrompt(prompt, opts = {}) {
  const now = opts.now || new Date();
  const stateDir = opts.stateDir;
  const config = opts.config || loadConfig(stateDir);
  const state = opts.state || loadState(stateDir);
  const batonStore = opts.batonStore || loadBatonStore(stateDir);
  const sessionKey = opts.sessionKey || "main";
  const runner = opts.runner || defaultCommandRunner;
  const heartbeat = isHeartbeatPrompt(prompt);

  // 1. Check quiet windows & quota-reservation windows for background heartbeats
  if (heartbeat) {
    const activeQuiet = findActiveTimeWindow(config.quietWindows || [], now);
    if (activeQuiet) {
      return {
        ok: true,
        provider: null,
        output: "NO_REPLY",
        skippedReason: `quiet_window (${activeQuiet})`,
        attempts: [],
      };
    }
    const activeReserve = findActiveTimeWindow(config.quotaReservationWindows || [], now);
    if (activeReserve) {
      return {
        ok: true,
        provider: null,
        output: "NO_REPLY",
        skippedReason: `quota_reservation_window (${activeReserve})`,
        attempts: [],
      };
    }
  }

  const chain = opts.onlyProvider ? [opts.onlyProvider] : config.chain || ["claude", "codex", "agy"];
  const attempts = [];

  for (const providerId of chain) {
    const provider = PROVIDERS[providerId];
    if (!provider) {
      attempts.push({ provider: providerId, status: "unknown_provider" });
      continue;
    }

    // 2. Fast-skip providers currently in active quota cooldown (0ms overhead)
    const cd = getProviderCooldown(state, providerId, now);
    if (cd.coolingDown) {
      attempts.push({
        provider: providerId,
        status: "skipped_cooldown",
        cooldownUntil: cd.until,
        remainingMinutes: cd.remainingMinutes,
      });
      continue;
    }

    // 3. Inject Shared Session Baton (delta turns missed by this provider + any mid-turn credit handoff)
    const baton =
      !heartbeat && config.enableSessionBaton !== false
        ? injectSessionBaton(batonStore, {
            sessionKey,
            targetProvider: providerId,
            prompt,
          })
        : { prompt, handoffInjected: false, header: null };

    // 4. Build and execute the headless CLI command
    const cmdSpec = provider.buildCommand(baton.prompt, {
      workspace: config.workspace,
      ...(config.providerOptions?.[providerId] || {}),
    });

    const result = runner({
      ...cmdSpec,
      cwd: config.workspace,
    });

    const combinedOutput = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");

    // 5. Check for subscription quota / rate-limit exhaustion
    if (isQuotaError(combinedOutput)) {
      const until = computeCooldownUntil(combinedOutput, {
        now,
        defaultMinutes: config.defaultCooldownMinutes ?? 60,
        bufferMinutes: config.cooldownBufferMinutes ?? 5,
      });
      state.providers[providerId] = {
        status: "cooldown",
        cooldownUntil: until.toISOString(),
        lastLimitAt: now.toISOString(),
        lastError: combinedOutput.slice(-400),
      };

      // Record mid-turn credit exhaustion baton (partial progress + modified files in workspace)
      if (!heartbeat && config.enableSessionBaton !== false) {
        recordMidTurnCreditExhaustion(batonStore, {
          sessionKey,
          failedProvider: providerId,
          prompt,
          partialOutput: result.stdout || "",
          cwd: config.workspace,
          now,
        });
        if (stateDir || !opts.batonStore) {
          saveBatonStore(batonStore, stateDir);
        }
      }

      if (stateDir || !opts.state) {
        saveState(state, stateDir);
      }
      attempts.push({
        provider: providerId,
        status: "quota_exhausted",
        cooldownUntil: until.toISOString(),
        latencyMs: result.latencyMs,
        handoffRecorded: !heartbeat,
      });
      continue;
    }

    // 6. Non-quota execution failure -> record and fail over to next CLI
    if (result.exitCode !== 0 || !result.stdout) {
      state.providers[providerId] = {
        ...(state.providers[providerId] || {}),
        status: "error",
        lastErrorAt: now.toISOString(),
        lastError: combinedOutput.slice(-400) || `exit code ${result.exitCode}`,
      };
      if (stateDir || !opts.state) {
        saveState(state, stateDir);
      }
      attempts.push({
        provider: providerId,
        status: "exec_error",
        exitCode: result.exitCode,
        error: combinedOutput.slice(-200),
      });
      continue;
    }

    // 7. Success! Clear any stale cooldown, record completed turn in Shared Session Baton, and return
    state.providers[providerId] = {
      status: "healthy",
      cooldownUntil: null,
      lastSuccessAt: now.toISOString(),
      lastLatencyMs: result.latencyMs,
    };
    state.lastActiveProvider = providerId;
    if (stateDir || !opts.state) {
      saveState(state, stateDir);
    }

    if (!heartbeat && config.enableSessionBaton !== false && result.stdout !== "NO_REPLY") {
      recordCompletedTurn(batonStore, {
        sessionKey,
        provider: providerId,
        prompt,
        response: result.stdout,
        now,
      });
      if (stateDir || !opts.batonStore) {
        saveBatonStore(batonStore, stateDir);
      }
    }

    recordTurnSavings(state, providerId, {
      promptChars: baton.prompt.length,
      responseChars: (result.stdout || "").length,
      now,
    });

    attempts.push({
      provider: providerId,
      status: "ok",
      latencyMs: result.latencyMs,
      handoffInjected: baton.handoffInjected,
    });

    return {
      ok: true,
      provider: providerId,
      output: result.stdout,
      latencyMs: result.latencyMs,
      handoffInjected: baton.handoffInjected,
      attempts,
    };
  }

  // 8. All configured subscription CLIs are in cooldown or unavailable
  if (heartbeat && config.pauseHeartbeatsWhenAllCoolingDown !== false) {
    return {
      ok: true,
      provider: null,
      output: "NO_REPLY",
      allCoolingDown: true,
      attempts,
    };
  }

  const activeCooldowns = chain
    .map((id) => ({ id, ...getProviderCooldown(state, id, now) }))
    .filter((c) => c.coolingDown && c.until)
    .sort((a, b) => new Date(a.until).getTime() - new Date(b.until).getTime());

  const earliest = activeCooldowns[0];
  const resetMsg = earliest
    ? `All configured subscription CLIs (${chain.join(" -> ")}) are currently in quota cooldown. Earliest reset: ${earliest.id} at ${earliest.until} (~${earliest.remainingMinutes} min).`
    : `All configured subscription CLIs (${chain.join(" -> ")}) failed to respond. Run \`clawsub doctor\` to check CLI login state.`;

  return {
    ok: false,
    provider: null,
    output: resetMsg,
    allCoolingDown: activeCooldowns.length > 0,
    attempts,
  };
}
