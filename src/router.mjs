import {
  injectSessionBaton,
  loadBatonStore,
  recordCompletedTurn,
  recordMidTurnCreditExhaustion,
  saveBatonStore,
} from "./baton.mjs";
import { PROVIDERS, defaultCommandRunner, detectBinary } from "./providers.mjs";
import { computeCooldownUntil, isAuthError, isHeartbeatPrompt, isQuotaError } from "./quota.mjs";
import {
  findActiveTimeWindow,
  getProviderCooldown,
  loadConfig,
  loadState,
  normalizeChain,
  recordTurnSavings,
  saveState,
} from "./state.mjs";

function isProviderBinaryInstalled(entry, provider, opts) {
  if (opts.installedProviders !== undefined) {
    return opts.installedProviders.has(entry.provider);
  }
  const bin = detectBinary(provider.binary);
  if (bin.installed) return true;
  if (provider.altBinary) return detectBinary(provider.altBinary).installed;
  return false;
}

/**
 * Executes a prompt across the configured subscription CLI chain with shared cross-model session pass-down.
 *
 * Chain entries support flexible config: string IDs, `"claude:opus"`, `"agy?"`, or objects
 * `{provider, model?, optional?, failover?, args?}`.
 *
 * - `optional: true` — silently skip if CLI binary not installed
 * - `failover: false` on an entry — stop chain on failure (no fall-through to next)
 * - top-level `config.failover: false` — single-agent mode, only chain[0] is used
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
 *   installedProviders?: Set<string>,
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

  const rawChain = opts.onlyProvider
    ? [opts.onlyProvider]
    : config.chain || ["claude", "codex", "agy"];
  const normalizedChain = normalizeChain(rawChain);
  // top-level failover: false = single-agent mode
  const chain = config.failover === false ? normalizedChain.slice(0, 1) : normalizedChain;

  const attempts = [];

  for (const entry of chain) {
    const providerId = entry.provider;
    const provider = PROVIDERS[providerId];
    if (!provider) {
      attempts.push({ provider: providerId, status: "unknown_provider" });
      continue;
    }

    // Skip optional entries when their CLI binary is not installed
    if (entry.optional && !isProviderBinaryInstalled(entry, provider, opts)) {
      attempts.push({ provider: providerId, status: "skipped_optional_not_installed" });
      continue;
    }

    // 2. Fast-skip providers currently in active quota cooldown (0ms overhead)
    const cd = getProviderCooldown(state, providerId, now);
    if (cd.coolingDown) {
      const pState = state.providers?.[providerId] || {};
      const authExpired = pState.status === "auth_expired";
      attempts.push({
        provider: providerId,
        status: authExpired ? "auth_expired" : "skipped_cooldown",
        cooldownUntil: cd.until,
        remainingMinutes: cd.remainingMinutes,
        ...(authExpired && pState.remediation && { remediation: pState.remediation }),
      });
      continue;
    }

    // 3. Inject Shared Session Baton
    const baton =
      !heartbeat && config.enableSessionBaton !== false
        ? injectSessionBaton(batonStore, {
            sessionKey,
            targetProvider: providerId,
            prompt,
          })
        : { prompt, handoffInjected: false, header: null };

    // 4. Build and execute the headless CLI command (entry-level model/args override providerOptions)
    const cmdSpec = provider.buildCommand(baton.prompt, {
      workspace: config.workspace,
      ...(config.providerOptions?.[providerId] || {}),
      ...(entry.model && { model: entry.model }),
      ...(entry.args && { extraArgs: entry.args }),
    });

    const result = runner({
      ...cmdSpec,
      cwd: config.workspace,
    });

    const combinedOutput = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");

    // 5a. Auth failure -> 6h cooldown
    if ((result.exitCode !== 0 || result.error) && isAuthError(combinedOutput)) {
      const until = new Date(now.getTime() + 6 * 3600_000);
      state.providers[providerId] = {
        ...(state.providers[providerId] || {}),
        status: "auth_expired",
        cooldownUntil: until.toISOString(),
        lastErrorAt: now.toISOString(),
        lastError: combinedOutput.slice(-400),
        remediation: `openclaw models auth login --provider ${providerId} --force`,
      };
      if (stateDir || !opts.state) {
        saveState(state, stateDir);
      }
      attempts.push({
        provider: providerId,
        status: "auth_expired",
        cooldownUntil: until.toISOString(),
        remediation: `openclaw models auth login --provider ${providerId} --force`,
      });
      continue;
    }

    // 5b. Subscription quota exhaustion
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

    // 6. Non-quota execution failure
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
      // failover: false on this entry = stop here, don't try next provider
      if (entry.failover === false) {
        return {
          ok: false,
          provider: providerId,
          output: combinedOutput || `${providerId} failed (exit code ${result.exitCode})`,
          failoverStopped: true,
          attempts,
        };
      }
      continue;
    }

    // 7. Success
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

  const chainProviderIds = chain.map((e) => e.provider);
  const chainDisplay = chain.map((e) => (e.model ? `${e.provider}:${e.model}` : e.provider)).join(" -> ");

  const authExpiredIds = chainProviderIds.filter(
    (id) => state.providers?.[id]?.status === "auth_expired"
  );
  const quotaCooldowns = chainProviderIds
    .filter((id) => !authExpiredIds.includes(id))
    .map((id) => ({ id, ...getProviderCooldown(state, id, now) }))
    .filter((c) => c.coolingDown && c.until)
    .sort((a, b) => new Date(a.until).getTime() - new Date(b.until).getTime());

  const earliest = quotaCooldowns[0];
  const authLines = authExpiredIds
    .map((id) => {
      const rem = state.providers[id]?.remediation;
      return rem ? `  ${id}: auth expired, run \`${rem}\`` : `  ${id}: auth expired`;
    })
    .join("\n");

  let resetMsg;
  if (authExpiredIds.length > 0 && quotaCooldowns.length === 0) {
    resetMsg = `All configured subscription CLIs (${chainDisplay}) have expired credentials:\n${authLines}`;
  } else if (earliest) {
    const authNote = authExpiredIds.length > 0 ? `\nAuth expired:\n${authLines}` : "";
    resetMsg = `All configured subscription CLIs (${chainDisplay}) are currently in quota cooldown. Earliest reset: ${earliest.id} at ${earliest.until} (~${earliest.remainingMinutes} min).${authNote}`;
  } else {
    const authNote = authExpiredIds.length > 0 ? `\nAuth expired:\n${authLines}` : "";
    resetMsg = `All configured subscription CLIs (${chainDisplay}) failed to respond. Run \`clawsub doctor\` to check CLI login state.${authNote}`;
  }

  return {
    ok: false,
    provider: null,
    output: resetMsg,
    allCoolingDown: quotaCooldowns.length > 0 || authExpiredIds.length > 0,
    attempts,
  };
}
