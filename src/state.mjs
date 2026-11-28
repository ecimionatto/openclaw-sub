import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KNOWN_PROVIDERS = ["claude", "codex", "agy", "ollama"];

function normalizeEntry(raw) {
  if (typeof raw === "string") {
    let str = raw.trim();
    const optional = str.endsWith("?");
    if (optional) str = str.slice(0, -1);
    const colonIdx = str.indexOf(":");
    const provider = (colonIdx >= 0 ? str.slice(0, colonIdx) : str).toLowerCase();
    const model = colonIdx >= 0 ? str.slice(colonIdx + 1) : undefined;
    if (model !== undefined && model === "") {
      throw new Error(`Empty model in entry "${raw.trim()}"`);
    }
    const key = model ? `${provider}:${model}` : provider;
    return { key, provider, model, optional, failover: undefined, args: undefined };
  }
  if (typeof raw === "object" && raw !== null) {
    const { provider, model, optional = false, failover, args } = raw;
    if (typeof provider !== "string" || provider === "") {
      throw new Error(`Entry "provider" must be a non-empty string, got ${JSON.stringify(provider)}`);
    }
    if (model !== undefined && (typeof model !== "string" || model === "")) {
      throw new Error(`Entry "model" must be a non-empty string or absent, got ${JSON.stringify(model)}`);
    }
    if (typeof optional !== "boolean") {
      throw new Error(`Entry "optional" must be a boolean, got ${JSON.stringify(optional)}`);
    }
    if (failover !== undefined && typeof failover !== "boolean") {
      throw new Error(`Entry "failover" must be a boolean or absent, got ${JSON.stringify(failover)}`);
    }
    if (args !== undefined && !Array.isArray(args)) {
      throw new Error(`Entry "args" must be an array or absent, got ${JSON.stringify(args)}`);
    }
    const key = model ? `${provider}:${model}` : provider;
    return { key, provider, model, optional, failover, args };
  }
  throw new Error(`Invalid chain entry: ${JSON.stringify(raw)}`);
}

export function normalizeChain(config) {
  const rawChain = config.chain;
  if (!Array.isArray(rawChain)) {
    throw new Error(`chain must be an array, got ${typeof rawChain}`);
  }
  if (rawChain.length === 0) {
    throw new Error("chain must not be empty");
  }

  const rawFailover = config.failover;
  if (rawFailover !== undefined && typeof rawFailover !== "boolean") {
    throw new Error(`failover must be a boolean, got ${typeof rawFailover} (${JSON.stringify(rawFailover)})`);
  }
  const failover = rawFailover !== undefined ? rawFailover : true;

  const entries = rawChain.map((raw, i) => {
    const entry = normalizeEntry(raw);
    if (!KNOWN_PROVIDERS.includes(entry.provider)) {
      throw new Error(
        `Unknown provider "${entry.provider}" at chain[${i}]. Known providers: ${KNOWN_PROVIDERS.join(", ")}`
      );
    }
    return entry;
  });

  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      throw new Error(`Duplicate chain entry "${entry.key}"`);
    }
    seen.add(entry.key);
  }

  return { ...config, chain: entries, failover };
}

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
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const merged = { ...DEFAULT_CONFIG, ...raw };
  if (merged.chain && merged.chain.length > 0) {
    const validated = normalizeChain(merged);
    return { ...merged, chain: validated.chain.map((e) => e.provider), failover: validated.failover };
  }
  return merged;
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
