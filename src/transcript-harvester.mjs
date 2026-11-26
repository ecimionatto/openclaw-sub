import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function findJsonlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(full);
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

function parseJsonlLines(filePath, fromLine = 0) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { turns: [], totalLines: 0 };
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const newLines = lines.slice(fromLine);
  const turns = [];
  for (const line of newLines) {
    try {
      const obj = JSON.parse(line);
      const rawRole =
        (obj.message && obj.message.role) ||
        obj.role ||
        obj.type ||
        null;
      const rawContent =
        (obj.message && obj.message.content) ||
        obj.content ||
        (obj.parts ? obj.parts.map((p) => p.text || "").join("") : null) ||
        "";
      const text = extractTextContent(rawContent);
      const ts =
        obj.createdAt ||
        obj.timestamp ||
        obj.created_at ||
        new Date().toISOString();
      const sessionId =
        obj.sessionId ||
        obj.session_id ||
        obj.conversationId ||
        path.basename(path.dirname(filePath));
      if (!rawRole || !text) continue;
      const role =
        rawRole === "assistant" || rawRole === "model"
          ? "assistant"
          : rawRole === "user" || rawRole === "human"
          ? "user"
          : null;
      if (role) turns.push({ role, content: text, timestamp: ts, sessionId });
    } catch {
      // skip malformed lines
    }
  }
  return { turns, totalLines: lines.length };
}

function pairTurns(turns) {
  const pairs = [];
  let i = 0;
  while (i < turns.length) {
    if (turns[i].role === "user") {
      const userTurn = turns[i];
      const next = turns[i + 1];
      if (next && next.role === "assistant") {
        pairs.push({
          prompt: userTurn.content,
          response: next.content,
          timestamp: userTurn.timestamp,
          sessionId: userTurn.sessionId || next.sessionId,
        });
        i += 2;
      } else {
        i += 1;
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
  const files = findJsonlFiles(dir);
  const newPairs = [];
  const nextWatermarks = { ...watermarks };

  for (const file of files) {
    const fromLine = watermarks[file] || 0;
    const { turns, totalLines } = parseJsonlLines(file, fromLine);
    if (turns.length > 0) {
      for (const p of pairTurns(turns)) {
        newPairs.push({ ...p, provider, sourceFile: file });
      }
    }
    if (totalLines > fromLine) {
      nextWatermarks[file] = totalLines;
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
