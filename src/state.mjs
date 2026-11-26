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
    };
  } catch {
    return { providers: {}, lastActiveProvider: null, updatedAt: null };
  }
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
  const curMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
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
