import fs from "node:fs";

// Log line format:
// <ISO8601> TASK <id> <event> [key=value ...]
// Events: STARTED, APPROVE, FIX, FIX_APPLIED, FIX_EXHAUSTED, BLOCK
const LOG_RE =
  /^(\S+)\s+TASK\s+(\S+)\s+(STARTED|APPROVE|FIX_APPLIED|FIX_EXHAUSTED|FIX|BLOCK)(?:\s+(.*))?$/;

export function parseLoopLog(text) {
  const events = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = LOG_RE.exec(line);
    if (!m) continue;
    const [, ts, taskId, event, rest = ""] = m;
    const kv = {};
    for (const part of rest.matchAll(/(\w+)="([^"]*?)"|(\w+)=(\S+)/g)) {
      kv[part[1] ?? part[3]] = part[2] ?? part[4];
    }
    events.push({ ts, taskId, event, ...kv });
  }
  return events;
}

export function computeLoopMetrics(events) {
  const tasks = {};
  for (const e of events) {
    if (!tasks[e.taskId]) tasks[e.taskId] = { fixRounds: 0, outcome: null };
    const t = tasks[e.taskId];
    if (e.event === "FIX") t.fixRounds += 1;
    if (e.event === "APPROVE") t.outcome = "approved";
    if (e.event === "BLOCK") t.outcome = "blocked";
  }

  const all = Object.values(tasks);
  const total = all.length;
  if (total === 0)
    return { total: 0, firstPassApprovalRate: 0, fixSuccessRate: 0, blockRate: 0, avgFixRounds: 0 };

  const firstPassApproved = all.filter((t) => t.outcome === "approved" && t.fixRounds === 0).length;
  const approved = all.filter((t) => t.outcome === "approved").length;
  const withFix = all.filter((t) => t.fixRounds > 0).length;
  const fixedAndApproved = all.filter((t) => t.fixRounds > 0 && t.outcome === "approved").length;
  const blocked = all.filter((t) => t.outcome === "blocked").length;
  const totalFixRounds = all.reduce((s, t) => s + t.fixRounds, 0);

  return {
    total,
    approved,
    blocked,
    firstPassApprovalRate: +(firstPassApproved / total).toFixed(4),
    fixSuccessRate: withFix > 0 ? +(fixedAndApproved / withFix).toFixed(4) : null,
    blockRate: +(blocked / total).toFixed(4),
    avgFixRounds: +(totalFixRounds / total).toFixed(2),
  };
}

export function evalMetrics({ logPath, json = false } = {}) {
  const text = logPath ? fs.readFileSync(logPath, "utf8") : "";
  const events = parseLoopLog(text);
  const metrics = computeLoopMetrics(events);

  if (json) {
    console.log(JSON.stringify(metrics, null, 2));
    return metrics;
  }

  const pct = (n) => (n == null ? "n/a" : (n * 100).toFixed(1) + "%");
  console.log("🦞 clawsub eval metrics\n");
  console.log(`Tasks in log:              ${metrics.total}`);
  console.log(`Approved:                  ${metrics.approved}`);
  console.log(`Blocked:                   ${metrics.blocked}`);
  console.log(`First-pass approval rate:  ${pct(metrics.firstPassApprovalRate)}`);
  console.log(`Fix success rate:          ${pct(metrics.fixSuccessRate)}`);
  console.log(`Block rate:                ${pct(metrics.blockRate)}`);
  console.log(`Avg fix rounds / task:     ${metrics.avgFixRounds}`);
  return metrics;
}
