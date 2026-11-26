import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getDefaultStateDir } from "./state.mjs";
import { harvestAll } from "./transcript-harvester.mjs";

const MAX_TURNS_STORED = 30;
const MAX_HANDOFF_TURNS = 8;
const MAX_TEXT_CHARS = 1200;

export function getBatonPath(stateDir = getDefaultStateDir()) {
  return path.join(stateDir, "clawsub-baton.json");
}

/**
 * Loads the shared cross-model session baton store.
 * Keyed by sessionKey (default: "main") so multiple conversations or worker tasks
 * each maintain their own cross-provider continuity ledger.
 */
export function loadBatonStore(stateDir = getDefaultStateDir()) {
  const file = getBatonPath(stateDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      sessions: raw.sessions || {},
      updatedAt: raw.updatedAt || null,
      harvestWatermarks: raw.harvestWatermarks || {},
    };
  } catch {
    return { sessions: {}, updatedAt: null };
  }
}

export function saveBatonStore(store, stateDir = getDefaultStateDir()) {
  fs.mkdirSync(stateDir, { recursive: true });
  const next = {
    ...store,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(getBatonPath(stateDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function getSessionBaton(store, sessionKey = "main") {
  if (!store.sessions[sessionKey]) {
    store.sessions[sessionKey] = {
      sessionKey,
      turnCounter: 0,
      lastProvider: null,
      providerNativeSessions: {},
      lastSeenTurnByProvider: {},
      pendingMidTurnHandoff: null,
      turns: [],
    };
  }
  return store.sessions[sessionKey];
}

function truncateText(text, maxChars = MAX_TEXT_CHARS) {
  if (!text || typeof text !== "string") return "";
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars) + "... [truncated]";
}

/**
 * Captures git workspace/worktree state (modified/untracked files + diff stat)
 * when a model runs out of credits mid-task so the fallback model knows what was already changed.
 */
export function captureWorktreeSnapshot(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  try {
    const statusRes = spawnSync("git", ["-C", cwd, "status", "--short"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (statusRes.status !== 0) return null;
    const statusText = (statusRes.stdout || "").trim();
    if (!statusText) return null;

    const diffRes = spawnSync("git", ["-C", cwd, "diff", "--stat"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const diffStat = (diffRes.stdout || "").trim();

    return {
      modifiedFiles: statusText.split("\n").map((l) => l.trim()).filter(Boolean),
      diffStat: truncateText(diffStat, 600),
    };
  } catch {
    return null;
  }
}

/**
 * Records a mid-turn credit exhaustion event so the next provider in the failover chain
 * receives any partial output and uncommitted file changes made before the credit limit hit.
 */
export function recordMidTurnCreditExhaustion(
  store,
  {
    sessionKey = "main",
    failedProvider,
    prompt,
    partialOutput = "",
    cwd = null,
    now = new Date(),
  }
) {
  const session = getSessionBaton(store, sessionKey);
  const worktree = captureWorktreeSnapshot(cwd);
  session.pendingMidTurnHandoff = {
    failedProvider,
    failedAt: now.toISOString(),
    prompt: truncateText(prompt, 800),
    partialOutput: truncateText(partialOutput, 800),
    worktree,
  };
  return session.pendingMidTurnHandoff;
}

/**
 * Records a completed turn into the shared session baton and updates the provider's watermark.
 */
export function recordCompletedTurn(
  store,
  {
    sessionKey = "main",
    provider,
    nativeSessionId = null,
    prompt,
    response,
    now = new Date(),
  }
) {
  const session = getSessionBaton(store, sessionKey);
  session.turnCounter += 1;
  const turnId = session.turnCounter;

  if (nativeSessionId) {
    session.providerNativeSessions[provider] = nativeSessionId;
  }

  session.turns.push({
    turnId,
    timestamp: now.toISOString(),
    provider,
    prompt: truncateText(prompt),
    response: truncateText(response),
  });

  if (session.turns.length > MAX_TURNS_STORED) {
    session.turns = session.turns.slice(-MAX_TURNS_STORED);
  }

  session.lastProvider = provider;
  session.lastSeenTurnByProvider[provider] = turnId;
  session.pendingMidTurnHandoff = null;
  return turnId;
}

/**
 * Builds the cross-model Session Pass-Down header for `targetProvider`.
 *
 * Includes:
 *  1. Delta turns that occurred on OTHER models since `targetProvider` was last active
 *     (solves both A -> B failover AND B -> A recovery when primary credits reset!).
 *  2. Mid-turn partial progress + modified files if the previous model ran out of credit mid-execution.
 *
 * Returns `null` if `targetProvider` is already caught up and there is no mid-turn handoff.
 */
export function buildSessionHandoffHeader(store, { sessionKey = "main", targetProvider }) {
  const session = getSessionBaton(store, sessionKey);
  const lastSeen = session.lastSeenTurnByProvider[targetProvider] || 0;
  const missedTurns = session.turns
    .filter((t) => t.turnId > lastSeen && t.provider !== targetProvider)
    .slice(-MAX_HANDOFF_TURNS);

  const midTurn = session.pendingMidTurnHandoff;
  const hasMidTurn = Boolean(midTurn && midTurn.failedProvider !== targetProvider);

  if (missedTurns.length === 0 && !hasMidTurn) {
    return null;
  }

  const lines = [
    `[CLAWSUB SHARED SESSION BATON — HANDOFF TO ${targetProvider.toUpperCase()}]`,
    "You are continuing an active session across multiple subscription CLI models.",
    "Maintain seamless continuity with the prior turns and decisions below — do not restart or re-ask answered questions.",
  ];

  if (missedTurns.length > 0) {
    lines.push("", "--- Prior Turns Completed on Other Models ---");
    for (const t of missedTurns) {
      lines.push(`[Turn #${t.turnId} via ${t.provider}]`);
      lines.push(`User: ${t.prompt}`);
      lines.push(`Assistant (${t.provider}): ${t.response}`);
    }
  }

  if (hasMidTurn) {
    lines.push(
      "",
      `--- Mid-Turn Credit Exhaustion Handoff from ${midTurn.failedProvider} ---`,
      `Provider '${midTurn.failedProvider}' ran out of subscription credits while executing this request.`
    );
    if (midTurn.worktree?.modifiedFiles?.length) {
      lines.push(
        "Files already modified in workspace/worktree by the previous model (inspect before editing):",
        ...midTurn.worktree.modifiedFiles.map((f) => `  ${f}`)
      );
      if (midTurn.worktree.diffStat) {
        lines.push(`Diff stat:\n${midTurn.worktree.diffStat}`);
      }
    }
    if (midTurn.partialOutput) {
      lines.push(`Partial output before credit limit:\n${midTurn.partialOutput}`);
    }
  }

  lines.push("[END CLAWSUB SESSION BATON]", "");
  return lines.join("\n");
}

/**
 * Harvests native CLI transcripts and merges new turn pairs into the baton store.
 * Watermarks are persisted in `store.harvestWatermarks` to avoid re-importing.
 */
export function syncNativeTranscripts(
  store,
  { sessionKey = "main", transcriptDirs = {}, now = new Date(), maxInitialBackfill = 30 } = {}
) {
  const watermarks = store.harvestWatermarks || {};
  const isInitialSync = Object.keys(watermarks).length === 0;

  const { pairs, watermarks: nextWatermarks } = harvestAll({ transcriptDirs, watermarks });
  store.harvestWatermarks = nextWatermarks;

  // Sort chronologically so the 30-turn cap keeps the latest delta, not arbitrary order
  const sorted = [...pairs].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  const toImport = isInitialSync ? sorted.slice(-maxInitialBackfill) : sorted;

  // Deduplicate against turns already recorded by clawsub run/exec
  const session = getSessionBaton(store, sessionKey);
  const existingFingerprints = new Set(
    session.turns.map((t) => `${t.prompt}|${t.response}`)
  );

  let imported = 0;
  for (const p of toImport) {
    const fp = `${p.prompt}|${p.response}`;
    if (existingFingerprints.has(fp)) continue;
    existingFingerprints.add(fp);
    recordCompletedTurn(store, {
      sessionKey,
      provider: p.provider,
      nativeSessionId: p.sessionId,
      prompt: p.prompt,
      response: p.response,
      now: p.timestamp ? new Date(p.timestamp) : now,
    });
    imported++;
  }

  return { imported };
}

/**
 * Decorates a user prompt with the cross-model session baton if `targetProvider` missed turns
 * or is taking over from a mid-turn credit exhaustion.
 */
export function injectSessionBaton(store, { sessionKey = "main", targetProvider, prompt }) {
  const header = buildSessionHandoffHeader(store, { sessionKey, targetProvider });
  if (!header) return { prompt, handoffInjected: false, header: null };
  return {
    prompt: `${header}\n${prompt}`,
    handoffInjected: true,
    header,
  };
}
