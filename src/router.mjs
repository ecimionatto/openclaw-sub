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
  validateConfig,
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
 * - `failover: false` on an entry — stop chain on any failure (cooldown, auth, quota, exec)
 * - top-level `config.failover: false` — single-agent mode, only chain[0] is used
 *
 * State keys are `provider` or `provider:model` so claude:opus and claude:sonnet track independently.
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

  // Validate config before routing
  const configErrors = validateConfig(config, PROVIDERS);
  if (configErrors.length > 0) {
    return { ok: false, provider: null, output: `Invalid config: ${configErrors.join("; ")}`, attempts: [] };
  }

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

  let rawChain;
  if (opts.onlyProvider) {
    const normalizedConfigChain = normalizeChain(config.chain || ["claude", "codex", "agy"]);
    const matched = normalizedConfigChain.find((e) => e.provider === opts.onlyProvider);
    rawChain = matched ? [matched] : [opts.onlyProvider];
  } else {
    rawChain = config.chain || ["claude", "codex", "agy"];
  }
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

    // Model-specific state key so claude:opus and claude:sonnet track quota independently
    const stateKey = entry.model ? `${providerId}:${entry.model}` : providerId;

    // 2. Fast-skip providers currently in active quota cooldown (0ms overhead)
    const cd = getProviderCooldown(state, stateKey, now);
    if (cd.coolingDown) {
      const pState = state.providers?.[stateKey] || {};
      const authExpired = pState.status === "auth_expired";
      attempts.push({
        provider: providerId,
        status: authExpired ? "auth_expired" : "skipped_cooldown",
        cooldownUntil: cd.until,
        remainingMinutes: cd.remainingMinutes,
        ...(authExpired && pState.remediation && { remediation: pState.remediation }),
      });
      if (entry.failover === false) {
        return {
          ok: false,
          provider: providerId,
          output: authExpired
            ? `${providerId} auth expired — run \`${pState.remediation || `openclaw models auth login --provider ${providerId} --force`}\``
            : `${providerId} is in quota cooldown until ${cd.until} (~${cd.remainingMinutes} min)`,
          failoverStopped: true,
          attempts,
        };
      }
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
      state.providers[stateKey] = {
        ...(state.providers[stateKey] || {}),
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
      if (entry.failover === false) {
        return {
          ok: false,
          provider: providerId,
          output: combinedOutput || `${providerId} auth expired`,
          failoverStopped: true,
          attempts,
        };
      }
      continue;
    }

    // 5b. Subscription quota exhaustion
    if (isQuotaError(combinedOutput)) {
      const until = computeCooldownUntil(combinedOutput, {
        now,
        defaultMinutes: config.defaultCooldownMinutes ?? 60,
        bufferMinutes: config.cooldownBufferMinutes ?? 5,
      });
      state.providers[stateKey] = {
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
      if (entry.failover === false) {
        return {
          ok: false,
          provider: providerId,
          output: combinedOutput || `${providerId} quota exhausted`,
          failoverStopped: true,
          attempts,
        };
      }
      continue;
    }

    // 6. Non-quota execution failure
    if (result.exitCode !== 0 || !result.stdout) {
      state.providers[stateKey] = {
        ...(state.providers[stateKey] || {}),
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
    state.providers[stateKey] = {
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

  // Clear error when single-agent mode (failover:false) has optional chain[0] that isn't installed
  if (
    config.failover === false &&
    attempts.length === 1 &&
    attempts[0].status === "skipped_optional_not_installed"
  ) {
    return {
      ok: false,
      provider: null,
      output: `Single-agent mode (failover: false): ${chain[0].provider} is optional and not installed — nothing to run. Install it or remove failover: false to enable chain failover.`,
      attempts,
    };
  }

  const chainDisplay = chain.map((e) => (e.model ? `${e.provider}:${e.model}` : e.provider)).join(" -> ");

  // Look up auth/cooldown status per stateKey
  const authExpiredEntries = chain.filter((e) => {
    const sk = e.model ? `${e.provider}:${e.model}` : e.provider;
    return state.providers?.[sk]?.status === "auth_expired";
  });

  const quotaCooldowns = chain
    .filter((e) => !authExpiredEntries.some((ae) => ae.provider === e.provider && ae.model === e.model))
    .map((e) => {
      const sk = e.model ? `${e.provider}:${e.model}` : e.provider;
      return { id: e.provider, ...getProviderCooldown(state, sk, now) };
    })
    .filter((c) => c.coolingDown && c.until)
    .sort((a, b) => new Date(a.until).getTime() - new Date(b.until).getTime());

  const earliest = quotaCooldowns[0];
  const authLines = authExpiredEntries
    .map((e) => {
      const sk = e.model ? `${e.provider}:${e.model}` : e.provider;
      const rem = state.providers[sk]?.remediation;
      return rem ? `  ${e.provider}: auth expired, run \`${rem}\`` : `  ${e.provider}: auth expired`;
    })
    .join("\n");

  let resetMsg;
  if (authExpiredEntries.length > 0 && quotaCooldowns.length === 0) {
    resetMsg = `All configured subscription CLIs (${chainDisplay}) have expired credentials:\n${authLines}`;
  } else if (earliest) {
    const authNote = authExpiredEntries.length > 0 ? `\nAuth expired:\n${authLines}` : "";
    resetMsg = `All configured subscription CLIs (${chainDisplay}) are currently in quota cooldown. Earliest reset: ${earliest.id} at ${earliest.until} (~${earliest.remainingMinutes} min).${authNote}`;
  } else {
    const authNote = authExpiredEntries.length > 0 ? `\nAuth expired:\n${authLines}` : "";
    resetMsg = `All configured subscription CLIs (${chainDisplay}) failed to respond. Run \`clawsub doctor\` to check CLI login state.${authNote}`;
  }

  return {
    ok: false,
    provider: null,
    output: resetMsg,
    allCoolingDown: quotaCooldowns.length > 0 || authExpiredEntries.length > 0,
    attempts,
  };
}
