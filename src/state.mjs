import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG = {
  chain: ["claude", "codex", "agy"],
  workspace: process.cwd(),
  defaultCooldownMinutes: 60,
  cooldownBufferMinutes: 5,
  pauseHeartbeatsWhenAllCoolingDown: true,
  quietWindows: ["23:00-08:00"],
  quotaReservationWindows: ["06:30-08:45", "19:00-21:30"],
};

export function getDefaultStateDir() {
  return process.env.CLAWSUB_HOME || path.join(os.homedir(), ".openclaw");
}

export function getConfigPath(stateDir = getDefaultStateDir()) {
  return path.join(stateDir, "clawsub.json");
}

export function getStatePath(stateDir = getDefaultStateDir()) {
  return path.join(stateDir, "clawsub-state.json");
}

export function loadConfig(stateDir = getDefaultStateDir()) {
  const file = getConfigPath(stateDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config, stateDir = getDefaultStateDir()) {
  fs.mkdirSync(stateDir, { recursive: true });
  const merged = { ...DEFAULT_CONFIG, ...config };
  fs.writeFileSync(getConfigPath(stateDir), JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

export function loadState(stateDir = getDefaultStateDir()) {
  const file = getStatePath(stateDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      providers: raw.providers || {},
      lastActiveProvider: raw.lastActiveProvider || null,
      updatedAt: raw.updatedAt || null,
      savings: raw.savings || { providers: {}, firstRecordedAt: null, lastRecordedAt: null },
    };
  } catch {
    return {
      providers: {},
      lastActiveProvider: null,
      updatedAt: null,
      savings: { providers: {}, firstRecordedAt: null, lastRecordedAt: null },
    };
  }
}

/**
 * Records prompt/response character counts for a successful turn, used for cost savings estimation.
 * @param {object} state
 * @param {string} providerId
 * @param {{ promptChars: number, responseChars: number, now?: Date }} opts
 */
export function recordTurnSavings(state, providerId, { promptChars, responseChars, now = new Date() } = {}) {
  if (!state.savings) {
    state.savings = { providers: {}, firstRecordedAt: null, lastRecordedAt: null };
  }
  const s = state.savings;
  if (!s.firstRecordedAt) s.firstRecordedAt = now.toISOString();
  s.lastRecordedAt = now.toISOString();
  if (!s.providers[providerId]) {
    s.providers[providerId] = { turnCount: 0, promptChars: 0, responseChars: 0 };
  }
  const p = s.providers[providerId];
  p.turnCount += 1;
  p.promptChars += promptChars || 0;
  p.responseChars += responseChars || 0;
}

export function saveState(state, stateDir = getDefaultStateDir()) {
  fs.mkdirSync(stateDir, { recursive: true });
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(getStatePath(stateDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/**
 * Checks if a provider is currently in an active quota cooldown.
 * @param {object} state
 * @param {string} providerId
 * @param {Date} [now]
 * @returns {{ coolingDown: boolean, until: string | null, remainingMinutes: number }}
 */
export function getProviderCooldown(state, providerId, now = new Date()) {
  const entry = state?.providers?.[providerId];
  if (!entry || !entry.cooldownUntil) {
    return { coolingDown: false, until: null, remainingMinutes: 0 };
  }
  const untilDate = new Date(entry.cooldownUntil);
  if (Number.isNaN(untilDate.getTime()) || now >= untilDate) {
    return { coolingDown: false, until: null, remainingMinutes: 0 };
  }
  const remainingMinutes = Math.max(1, Math.ceil((untilDate.getTime() - now.getTime()) / 60_000));
  return {
    coolingDown: true,
    until: entry.cooldownUntil,
    remainingMinutes,
  };
}

/**
 * Normalizes a chain array so each entry is an object with at least { provider }.
 * Accepts: strings like "claude", "claude:opus", "agy?" — or already-normalized objects.
 * @param {Array<string|object>} chain
 * @returns {Array<{provider: string, model?: string, optional?: boolean, failover?: boolean, args?: string[]}>}
 */
export function normalizeChain(chain) {
  if (!Array.isArray(chain)) return [];
  return chain.map((entry) => {
    if (typeof entry !== "string") {
      return { optional: false, ...entry };
    }
    const optional = entry.endsWith("?");
    const spec = optional ? entry.slice(0, -1) : entry;
    const colonIdx = spec.indexOf(":");
    if (colonIdx !== -1) {
      return { provider: spec.slice(0, colonIdx), model: spec.slice(colonIdx + 1), optional };
    }
    return { provider: spec, optional };
  });
}

/**
 * Validates a config object's chain field. Returns array of error strings (empty = valid).
 * @param {object} config
 * @param {object} [knownProviders] map of known provider IDs (e.g. PROVIDERS from providers.mjs)
 * @returns {string[]}
 */
export function validateConfig(config, knownProviders) {
  const errors = [];
  const chain = config.chain;
  if (!Array.isArray(chain)) {
    errors.push(`"chain" must be an array, got ${typeof chain}`);
    return errors;
  }
  if (chain.length === 0) {
    errors.push("chain must not be empty");
    return errors;
  }
  if ("failover" in config && typeof config.failover !== "boolean") {
    errors.push(`"failover" must be a boolean, got ${JSON.stringify(config.failover)}`);
  }
  const normalized = normalizeChain(chain);
  for (const entry of normalized) {
    if (knownProviders && !knownProviders[entry.provider]) {
      errors.push(`Unknown provider in chain: "${entry.provider}"`);
    }
    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      errors.push(`"args" for provider "${entry.provider}" must be an array`);
    }
    if ("failover" in entry && typeof entry.failover !== "boolean") {
      errors.push(`per-entry "failover" for "${entry.provider}" must be a boolean`);
    }
    if (entry.model !== undefined && typeof entry.model !== "string") {
      errors.push(`per-entry "model" for "${entry.provider}" must be a string`);
    }
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
      errors.push(`per-entry "optional" for "${entry.provider}" must be a boolean`);
    }
  }
  const seen = new Set();
  for (const e of normalized) {
    const key = `${e.provider}:${e.model || ""}`;
    if (seen.has(key)) {
      errors.push(`Duplicate identical chain entry: "${e.provider}${e.model ? ":" + e.model : ""}"`);
    }
    seen.add(key);
  }
  return errors;
}

/**
 * Checks whether `now` falls inside any "HH:MM-HH:MM" local time window.
 * Supports overnight spans like "23:00-08:00".
 *
 * @param {string[]} windows
 * @param {Date} [now]
 * @returns {string | null} Matching window string, or null
 */
export function findActiveTimeWindow(windows = [], now = new Date()) {
  const curMinutes = now.getHours() * 60 + now.getMinutes();
  for (const win of windows) {
    const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(win).trim());
    if (!m) continue;
    const start = Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
    const end = Number.parseInt(m[3], 10) * 60 + Number.parseInt(m[4], 10);
    if (start <= end) {
      if (curMinutes >= start && curMinutes < end) return win;
    } else {
      // Overnight window e.g. 23:00-08:00
      if (curMinutes >= start || curMinutes < end) return win;
    }
  }
  return null;
}
