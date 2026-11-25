import { PROVIDERS, defaultCommandRunner } from "./providers.mjs";
import { computeCooldownUntil, isHeartbeatPrompt, isQuotaError } from "./quota.mjs";
import {
  findActiveTimeWindow,
  getProviderCooldown,
  loadConfig,
  loadState,
  saveState,
} from "./state.mjs";

/**
 * Executes a prompt across the configured subscription CLI chain (`claude` -> `codex` -> `agy`).
 *
 * Features:
 *  - 0ms fast-skip for providers currently in a 5-hour or weekly quota cooldown.
 *  - Quota-reservation & quiet-window guardrails for background OpenClaw heartbeats.
 *  - Automatic cooldown timestamp parsing (`resets 6:50pm`, `resets Nov 28, 10am`) and failover.
 *  - Clean `NO_REPLY` auto-pause on heartbeats or reset-time notice when all providers are exhausted.
 *
 * @param {string} prompt
 * @param {{
 *   stateDir?: string,
 *   config?: object,
 *   state?: object,
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

    // 3. Build and execute the headless CLI command
    const cmdSpec = provider.buildCommand(prompt, {
      workspace: config.workspace,
      ...(config.providerOptions?.[providerId] || {}),
    });

    const result = runner({
      ...cmdSpec,
      cwd: config.workspace,
    });

    const combinedOutput = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");

    // 4. Check for subscription quota / rate-limit exhaustion
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
      if (stateDir || !opts.state) {
        saveState(state, stateDir);
      }
      attempts.push({
        provider: providerId,
        status: "quota_exhausted",
        cooldownUntil: until.toISOString(),
        latencyMs: result.latencyMs,
      });
      continue;
    }

    // 5. Non-quota execution failure -> record and fail over to next CLI
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

    // 6. Success! Clear any stale cooldown and return output
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

    attempts.push({
      provider: providerId,
      status: "ok",
      latencyMs: result.latencyMs,
    });

    return {
      ok: true,
      provider: providerId,
      output: result.stdout,
      latencyMs: result.latencyMs,
      attempts,
    };
  }

  // 7. All configured subscription CLIs are in cooldown or unavailable
  if (heartbeat && config.pauseHeartbeatsWhenAllCoolingDown !== false) {
    return {
      ok: true,
      provider: null,
      output: "NO_REPLY",
      allCoolingDown: true,
      attempts,
    };
  }

  // Find earliest reset time to report to the user
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
