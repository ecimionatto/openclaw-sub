import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GEMINI_TRANSCRIPT_NAME = "transcript.jsonl";

function findJsonlFiles(dir, nameFilter = null) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(full, nameFilter));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (!nameFilter || entry.name === nameFilter) {
        results.push(full);
      }
    }
  }
  return results;
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") return c.text || c.content || "";
        return "";
      })
      .join("")
      .trim();
  }
  if (content && typeof content === "object") return content.text || content.content || "";
  return "";
}

function hasToolBlock(content) {
  return Array.isArray(content) && content.some((c) => c && (c.type === "tool_result" || c.type === "tool_use"));
}

function isToolResultOrMeta(obj) {
  if (obj.isMeta || obj.isSidechain) return true;
  if (obj.type === "tool_use" || obj.type === "tool_result") return true;
  if (hasToolBlock(obj.content)) return true;
  // Native Claude: {type:'user', message:{role:'user', content:[{type:'tool_result',...}]}}
  if (obj.message && hasToolBlock(obj.message.content)) return true;
  // Codex response_item: {type:'response_item', payload:{type:'message', content:[...]}}
  if (obj.payload && hasToolBlock(obj.payload.content)) return true;
  return false;
}

function parseJsonlLines(filePath, fromLine = 0) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { turns: [], lastParsedLineIdx: fromLine };
  }
  const rawLines = raw.split("\n");
  // Always exclude the last element: either empty string (file ends with \n, complete)
  // or potentially partial write (no trailing \n). Safe either way.
  const lineCount = rawLines.length - 1;

  const turns = [];
  let lastParsedLineIdx = fromLine;

  for (let i = fromLine; i < lineCount; i++) {
    const line = rawLines[i];
    if (!line.trim()) {
      lastParsedLineIdx = i + 1;
      continue;
    }
    try {
      const obj = JSON.parse(line);
      lastParsedLineIdx = i + 1;

      if (isToolResultOrMeta(obj)) continue;

      // Support Codex rollout shape: {type:'response_item', payload:{type:'message', role, content}}
      const msgObj = obj.type === "response_item" && obj.payload ? obj.payload : obj;

      const rawRole =
        (msgObj.message && msgObj.message.role) ||
        msgObj.role ||
        msgObj.type ||
        null;
      const rawContent =
        (msgObj.message && msgObj.message.content) ||
        msgObj.content ||
        (msgObj.parts ? msgObj.parts.map((p) => p.text || "").join("") : null) ||
        "";
      const text = extractTextContent(rawContent);
      const ts = obj.createdAt || obj.timestamp || obj.created_at || new Date().toISOString();
      const sessionId =
        obj.sessionId || obj.session_id || obj.conversationId ||
        path.basename(path.dirname(filePath));

      if (!rawRole || !text) continue;

      // Map provider-specific role names to canonical user/assistant
      const role =
        rawRole === "assistant" || rawRole === "model" || rawRole === "PLANNER_RESPONSE"
          ? "assistant"
          : rawRole === "user" || rawRole === "human" || rawRole === "USER_INPUT"
          ? "user"
          : null;

      const stopReason = "stop_reason" in msgObj ? msgObj.stop_reason : "stop_reason" in obj ? obj.stop_reason : undefined;

      if (role) turns.push({ role, content: text, timestamp: ts, sessionId, lineIdx: i, stopReason });
    } catch {
      // malformed line — lastParsedLineIdx not advanced past it
    }
  }

  return { turns, lastParsedLineIdx };
}

function pairTurns(turns, lastParsedLineIdx = Infinity) {
  const pairs = [];
  let heldBackAt = null; // lineIdx of user turn held back due to in-flight assistant
  let i = 0;
  while (i < turns.length) {
    if (turns[i].role === "user") {
      const userTurn = turns[i];
      let j = i + 1;

      // Skip consecutive user turns (retried/interrupted prompts) — continue pairing later turns
      if (j < turns.length && turns[j].role === "user") {
        i += 1;
        continue;
      }

      const assistantParts = [];
      while (j < turns.length && turns[j].role === "assistant") {
        assistantParts.push(turns[j]);
        j++;
      }
      if (assistantParts.length > 0) {
        const lastAssistant = assistantParts[assistantParts.length - 1];
        // If the last assistant is at end of parsed window and stop_reason is explicitly
        // absent (null/falsy) in a format that uses it (field present), it may be in-flight.
        // Record userTurn.lineIdx so watermark can park before it for re-read on next sync.
        const isAtEnd = lastAssistant.lineIdx + 1 >= lastParsedLineIdx;
        const hasStopReasonField = lastAssistant.stopReason !== undefined;
        if (isAtEnd && hasStopReasonField && !lastAssistant.stopReason) {
          heldBackAt = userTurn.lineIdx;
          break;
        }

        const response = assistantParts.map((a) => a.content).join("\n");
        pairs.push({
          prompt: userTurn.content,
          response,
          timestamp: userTurn.timestamp,
          sessionId: userTurn.sessionId || lastAssistant.sessionId,
          consumedLineIdx: lastAssistant.lineIdx + 1,
          startLineIdx: userTurn.lineIdx,
        });
        i = j;
      } else {
        // User turn with no assistant reply yet (in-flight) — stop here
        break;
      }
    } else {
      i += 1;
    }
  }
  return { pairs, heldBackAt };
}

export function resolveTranscriptDirs(overrides = {}) {
  const home = os.homedir();
  return {
    claude: overrides.claude || path.join(home, ".claude", "projects"),
    codex: overrides.codex || path.join(home, ".codex", "sessions"),
    gemini: overrides.gemini || path.join(home, ".gemini", "antigravity-cli", "brain"),
  };
}

export function harvestProvider(provider, dir, watermarks = {}) {
  const nameFilter = provider === "gemini" ? GEMINI_TRANSCRIPT_NAME : null;
  const files = findJsonlFiles(dir, nameFilter);
  const newPairs = [];
  const nextWatermarks = { ...watermarks };

  for (const file of files) {
    const fromLine = watermarks[file] || 0;
    const { turns, lastParsedLineIdx } = parseJsonlLines(file, fromLine);
    const { pairs, heldBackAt } = pairTurns(turns, lastParsedLineIdx);

    for (const p of pairs) {
      newPairs.push({ ...p, provider, sourceFile: file });
    }

    if (heldBackAt !== null) {
      // In-flight assistant: park watermark at user turn so next sync re-reads from there
      nextWatermarks[file] = heldBackAt;
    } else if (pairs.length > 0) {
      nextWatermarks[file] = pairs[pairs.length - 1].consumedLineIdx;
    } else if (lastParsedLineIdx > fromLine) {
      const lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn.role === "user") {
        nextWatermarks[file] = lastTurn.lineIdx;
      } else {
        nextWatermarks[file] = lastParsedLineIdx;
      }
    }
  }

  return { pairs: newPairs, watermarks: nextWatermarks };
}

export function harvestAll(opts = {}) {
  const dirs = resolveTranscriptDirs(opts.transcriptDirs || {});
  const watermarks = opts.watermarks || {};
  const allPairs = [];
  const nextWatermarks = { ...watermarks };

  for (const [provider, dir] of [
    ["claude", dirs.claude],
    ["codex", dirs.codex],
    ["gemini", dirs.gemini],
  ]) {
    const { pairs, watermarks: wm } = harvestProvider(provider, dir, watermarks);
    allPairs.push(...pairs);
    Object.assign(nextWatermarks, wm);
  }

  return { pairs: allPairs, watermarks: nextWatermarks };
}
