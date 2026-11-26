// API pricing per 1M tokens (input / output) — what the user would pay without clawsub.
// All `claude` turns use Opus pricing (conservative upper-bound; actual model may be cheaper).
// Unknown provider IDs fall back to GPT/Codex pricing (may overestimate for cheaper models).
export const PROVIDER_PRICING = {
  claude:  { inputPerM: 15,   outputPerM: 75,  label: "Claude Opus API (est.)" },
  codex:   { inputPerM: 3,    outputPerM: 15,  label: "OpenAI GPT/Codex API" },
  agy:     { inputPerM: 1.25, outputPerM: 5,   label: "Gemini API" },
  gemini:  { inputPerM: 1.25, outputPerM: 5,   label: "Gemini API" },
  ollama:  { inputPerM: 0,    outputPerM: 0,   label: "Ollama (local, $0)" },
};

const CHARS_PER_TOKEN = 4;

/**
 * @param {{ providers: Record<string, { turnCount: number, promptChars: number, responseChars: number }>, firstRecordedAt: string | null, lastRecordedAt: string | null }} savingsStats
 * @param {{ now?: Date }} [opts]
 * @returns {{ totalSavedUsd: number, byProvider: object[], dailyAvgUsd: number, monthlyProjectionUsd: number, daysTracked: number, turnsTracked: number }}
 */
export function computeSavings(savingsStats, { now = new Date() } = {}) {
  const { providers = {}, firstRecordedAt } = savingsStats || {};

  let totalSavedUsd = 0;
  let turnsTracked = 0;
  const byProvider = [];

  for (const [id, stats] of Object.entries(providers)) {
    const pricing = PROVIDER_PRICING[id] || PROVIDER_PRICING.codex;
    const inputTokens = (stats.promptChars || 0) / CHARS_PER_TOKEN;
    const outputTokens = (stats.responseChars || 0) / CHARS_PER_TOKEN;
    const savedUsd =
      (inputTokens / 1_000_000) * pricing.inputPerM +
      (outputTokens / 1_000_000) * pricing.outputPerM;
    totalSavedUsd += savedUsd;
    turnsTracked += stats.turnCount || 0;
    byProvider.push({
      provider: id,
      label: pricing.label,
      turnCount: stats.turnCount || 0,
      inputTokens: Math.round(inputTokens),
      outputTokens: Math.round(outputTokens),
      savedUsd: Math.round(savedUsd * 10000) / 10000,
    });
  }

  // Measure window from first recorded turn to now so idle time counts against projections.
  const first = firstRecordedAt ? new Date(firstRecordedAt) : null;
  const daysTracked = first
    ? Math.max(1, (now.getTime() - first.getTime()) / 86_400_000)
    : 1;

  const dailyAvgUsd = totalSavedUsd / daysTracked;
  const monthlyProjectionUsd = dailyAvgUsd * 30;

  return {
    totalSavedUsd: Math.round(totalSavedUsd * 10000) / 10000,
    byProvider,
    daysTracked: Math.round(daysTracked * 10) / 10,
    dailyAvgUsd: Math.round(dailyAvgUsd * 10000) / 10000,
    monthlyProjectionUsd: Math.round(monthlyProjectionUsd * 100) / 100,
    turnsTracked,
  };
}
