/**
 * Quota & rate-limit detection + reset timestamp parser for subscription CLIs
 * (Claude Code CLI, OpenAI Codex CLI, Google Antigravity / Gemini CLI).
 */

export const LIMIT_PATTERNS = [
  /usage_limit_reached/i,
  /hit your (?:5-hour|weekly|daily|monthly) limit/i,
  /rate_limit_error/i,
  /quota[ _-]?exceeded/i,
  /ResourceExhausted/i,
  /too many requests/i,
  /\bHTTP\s*429\b/i,
  /\bstatus(?:\s+code)?:\s*429\b/i,
  /exceeded your current quota/i,
  /try again in \d+\s*(?:minutes?|hours?|seconds?)/i,
];

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Returns true if the CLI stdout/stderr indicates a subscription quota or rate limit.
 * @param {string} output
 * @returns {boolean}
 */
export function isQuotaError(output) {
  if (!output || typeof output !== "string") return false;
  return LIMIT_PATTERNS.some((re) => re.test(output));
}

/**
 * Parses a human-readable reset timestamp from a CLI quota message.
 * Supports:
 *  - "resets 6:50pm" / "resets 10am" / "resets at 14:30"
 *  - "resets Nov 28, 10:00am" / "resets Nov 28 at 2pm"
 *  - "try again in 45 minutes" / "try again in 2 hours" / "retry after 120s"
 *
 * @param {string} output
 * @param {Date} [now]
 * @returns {Date | null}
 */
export function parseResetTime(output, now = new Date()) {
  if (!output || typeof output !== "string") return null;

  // 1. Relative duration: "try again in 45 minutes" / "retry after 300s"
  const relMatch = output.match(
    /(?:try again in|retry after|resets in)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i
  );
  if (relMatch) {
    const amount = Number.parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const mult = unit.startsWith("h")
      ? 3600_000
      : unit.startsWith("m")
      ? 60_000
      : 1_000;
    return new Date(now.getTime() + amount * mult);
  }

  // 2. Explicit month + day + time: "resets Nov 28, 10:00am" or "resets Nov 28 at 6pm"
  const dateMatch = output.match(
    /resets(?:\s+on)?\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,|\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i
  );
  if (dateMatch) {
    const monthIdx = MONTHS[dateMatch[1].toLowerCase()];
    if (monthIdx !== undefined) {
      const day = Number.parseInt(dateMatch[2], 10);
      let hour = Number.parseInt(dateMatch[3], 10);
      const minute = Number.parseInt(dateMatch[4] || "0", 10);
      const meridiem = (dateMatch[5] || "").toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;

      const candidate = new Date(now);
      candidate.setMonth(monthIdx, day);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate.getTime() < now.getTime() - 6 * 3600_000) {
        candidate.setFullYear(candidate.getFullYear() + 1);
      }
      return candidate;
    }
  }

  // 3. Same-day/next-day time of day: "resets 6:50pm" / "resets at 10am"
  const timeMatch = output.match(
    /resets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i
  );
  if (timeMatch) {
    let hour = Number.parseInt(timeMatch[1], 10) % 12;
    if (timeMatch[3].toLowerCase() === "pm") hour += 12;
    const minute = Number.parseInt(timeMatch[2] || "0", 10);

    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate > now) {
      return candidate;
    }
    // If reset time just passed within the last 10 minutes, lift soon; otherwise tomorrow
    const diffMs = now.getTime() - candidate.getTime();
    if (diffMs < 10 * 60_000) {
      return new Date(now.getTime() + 60_000);
    }
    candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  return null;
}

/**
 * Computes the cooldown expiration timestamp for an exhausted provider.
 * Adds a 5-minute buffer when a concrete reset timestamp is parsed, or defaults
 * to `defaultMinutes` (60 min) when no reset time is reported.
 *
 * @param {string} output
 * @param {{ now?: Date, defaultMinutes?: number, bufferMinutes?: number }} [opts]
 * @returns {Date}
 */
export function computeCooldownUntil(output, opts = {}) {
  const now = opts.now || new Date();
  const defaultMinutes = opts.defaultMinutes ?? 60;
  const bufferMinutes = opts.bufferMinutes ?? 5;

  const parsed = parseResetTime(output, now);
  if (parsed) {
    return new Date(parsed.getTime() + bufferMinutes * 60_000);
  }
  return new Date(now.getTime() + defaultMinutes * 60_000);
}

/**
 * Detects whether a prompt is an automated OpenClaw background heartbeat poll.
 * @param {string} prompt
 * @returns {boolean}
 */
export function isHeartbeatPrompt(prompt) {
  if (!prompt || typeof prompt !== "string") return false;
  return (
    prompt.includes("[OpenClaw heartbeat poll]") ||
    prompt.includes("If nothing needs attention, reply NO_REPLY")
  );
}
