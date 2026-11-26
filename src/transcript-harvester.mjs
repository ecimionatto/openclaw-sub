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

function isToolResultOrMeta(obj) {
  if (obj.isMeta || obj.isSidechain) return true;
  if (obj.type === "tool_use" || obj.type === "tool_result") return true;
  if (Array.isArray(obj.content) && obj.content.some((c) => c && c.type === "tool_result")) return true;
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

      if (role) turns.push({ role, content: text, timestamp: ts, sessionId, lineIdx: i });
    } catch {
      // malformed line — lastParsedLineIdx not advanced past it
    }
  }

  return { turns, lastParsedLineIdx };
}

function pairTurns(turns) {
  const pairs = [];
  let i = 0;
  while (i < turns.length) {
    if (turns[i].role === "user") {
      const userTurn = turns[i];
      let j = i + 1;
      const assistantParts = [];
      // Aggregate consecutive assistant messages (multi-message / tool-using turns)
      while (j < turns.length && turns[j].role === "assistant") {
        assistantParts.push(turns[j]);
        j++;
      }
      if (assistantParts.length > 0) {
        const response = assistantParts.map((a) => a.content).join("\n");
        const lastAssistant = assistantParts[assistantParts.length - 1];
        pairs.push({
          prompt: userTurn.content,
          response,
          timestamp: userTurn.timestamp,
          sessionId: userTurn.sessionId || lastAssistant.sessionId,
          consumedLineIdx: lastAssistant.lineIdx + 1,
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
  return pairs;
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
    const pairs = pairTurns(turns);

    for (const p of pairs) {
      newPairs.push({ ...p, provider, sourceFile: file });
    }

    if (pairs.length > 0) {
      // Advance only past the last consumed (fully paired) line
      nextWatermarks[file] = pairs[pairs.length - 1].consumedLineIdx;
    } else if (lastParsedLineIdx > fromLine) {
      // Parsed lines but no pairs — may be all filtered (tool_result/meta) or in-flight user turn
      const lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn.role === "user") {
        // In-flight user turn — park watermark just before it so next sync re-reads it
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
