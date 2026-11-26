import fs from "node:fs";

const STRUCTURED_LINE_RE =
  /^(?:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+)?repo:(\S+)\s+task:(\S+)\s+(.+)$/;

const TICK_TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) tick:/;

const PREFIX_REPO_MAP = {
  CS: "ecimionatto/openclaw-sub",
  DT: "ecimionatto/daily-train-app",
  CR: "ecimionatto/crescendo-app",
  RC: "ecimionatto/relaykit",
  ST: "ecimionatto/statura",
};

export function repoFromTaskId(taskId, repoMap = PREFIX_REPO_MAP) {
  const prefix = String(taskId || "").split("-")[0];
  return repoMap[prefix] || `unknown/${prefix.toLowerCase() || "repo"}`;
}

export function parseBoard(text, { repoMap = PREFIX_REPO_MAP } = {}) {
  const rows = [];
  if (!text) return rows;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 7) continue;
    const id = cells[0];
    if (!/^[A-Z]+-[A-Za-z0-9]+$/.test(id)) continue;
    const status = cells[6] || "";
    const prCell = cells[7] || "";
    const repo = repoFromTaskId(id, repoMap);
    rows.push({
      taskId: id,
      tier: cells[1] || "",
      title: cells[2] || "",
      status,
      pr: prCell,
      repo,
      merged: /^merged\b/i.test(status),
      rescoped: /^rescope\b/i.test(status),
    });
  }
  return rows;
}

export function parseLog(text, { repoMap = PREFIX_REPO_MAP } = {}) {
  const events = [];
  let lastTickTs = null;

  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const tickMatch = TICK_TS_RE.exec(line);
    if (tickMatch) {
      lastTickTs = new Date(tickMatch[1].replace(" ", "T") + "Z");
      continue;
    }

    const sm = STRUCTURED_LINE_RE.exec(line);
    if (sm) {
      const [, tsRaw, repo, taskId, eventRaw] = sm;
      events.push({
        ts: tsRaw ? new Date(tsRaw) : lastTickTs,
        repo,
        taskId,
        event: eventRaw.trim(),
      });
      continue;
    }

    // Real ops/loop work-tick.log lines:
    // 1. "spawned CS-14 pid=165042"
    let m = /^spawned\s+([A-Z]+-[A-Za-z0-9]+)\b(.*)$/.exec(line);
    if (m) {
      events.push({
        ts: lastTickTs,
        repo: repoFromTaskId(m[1], repoMap),
        taskId: m[1],
        event: ("spawned" + (m[2] || "")).trim(),
      });
      continue;
    }

    // 2. "CS-14 opened https://github.com/ecimionatto/openclaw-sub/pull/9"
    m = /^([A-Z]+-[A-Za-z0-9]+)\s+opened\s+(https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+.*)$/.exec(line);
    if (m) {
      events.push({
        ts: lastTickTs,
        repo: m[3] || repoFromTaskId(m[1], repoMap),
        taskId: m[1],
        event: `opened ${m[2].trim()}`,
      });
      continue;
    }

    // 3. "CS-14: reviewed -> APPROVE|FIX|BLOCK"
    m = /^([A-Z]+-[A-Za-z0-9]+):\s+(reviewed ->\s*(?:APPROVE|FIX|BLOCK).*)$/.exec(line);
    if (m) {
      events.push({
        ts: lastTickTs,
        repo: repoFromTaskId(m[1], repoMap),
        taskId: m[1],
        event: m[2].trim(),
      });
      continue;
    }

    // 4. "fix CS-14 attempt 1 pid=167022"
    m = /^fix\s+([A-Z]+-[A-Za-z0-9]+)\s+(attempt\s+\d+.*)$/.exec(line);
    if (m) {
      events.push({
        ts: lastTickTs,
        repo: repoFromTaskId(m[1], repoMap),
        taskId: m[1],
        event: `fix ${m[2].trim()}`,
      });
      continue;
    }

    // 5. "CS-14: 3 fix attempts failed -> rescope by Louis" or "CS-14: reviewer BLOCK -> rescope by Louis"
    m = /^([A-Z]+-[A-Za-z0-9]+):.*->\s*rescope\b(.*)$/.exec(line);
    if (m) {
      events.push({
        ts: lastTickTs,
        repo: repoFromTaskId(m[1], repoMap),
        taskId: m[1],
        event: ("rescope" + (m[2] || "")).trim(),
      });
      continue;
    }

    // 6. "merged CS-14" or "CS-14 merged"
    m = /^(?:🚀\s*)?merged\s+([A-Z]+-[A-Za-z0-9]+)\b(.*)$/.exec(line);
    if (m) {
      events.push({
        ts: lastTickTs,
        repo: repoFromTaskId(m[1], repoMap),
        taskId: m[1],
        event: ("merged" + (m[2] || "")).trim(),
      });
      continue;
    }
  }
  return events;
}

function groupByTask(events, boardRows = []) {
  const tasks = new Map();
  for (const ev of events) {
    const key = `${ev.repo}::${ev.taskId}`;
    if (!tasks.has(key)) tasks.set(key, { repo: ev.repo, taskId: ev.taskId, events: [], boardRow: null });
    tasks.get(key).events.push(ev);
  }
  for (const row of boardRows) {
    const key = `${row.repo}::${row.taskId}`;
    if (tasks.has(key)) {
      tasks.get(key).boardRow = row;
    }
  }
  return [...tasks.values()];
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function computeMetrics(events, { repo, boardRows = [] } = {}) {
  const filtered = repo ? events.filter((e) => e.repo === repo) : events;
  const filteredBoard = repo ? boardRows.filter((b) => b.repo === repo) : boardRows;
  const tasks = groupByTask(filtered, filteredBoard);

  const repos = [...new Set(filtered.map((e) => e.repo))];
  const result = {};

  for (const r of repos) {
    const repoTasks = tasks.filter((t) => t.repo === r);

    let firstPassApprove = 0;
    let tasksWithReview = 0;
    let totalFixRuns = 0;
    let mergedCount = 0;
    let fixedThenMerged = 0;
    let hadFix = 0;
    let rescopedCount = 0;
    const timesToMerge = [];

    for (const task of repoTasks) {
      const evs = task.events;
      const spawnEv = evs.find((e) => e.event === "spawned" || e.event.startsWith("spawned "));
      const mergedEv = evs.find((e) => e.event === "merged" || e.event.startsWith("merged "));
      const reviews = evs.filter((e) => e.event.startsWith("reviewed ->"));
      const fixes = evs.filter((e) => /^fix(?: .+)? attempt \d+/.test(e.event));
      const hasApproval = reviews.some((e) => e.event.startsWith("reviewed -> APPROVE"));
      const isMerged = Boolean(mergedEv) || Boolean(task.boardRow?.merged) || (boardRows.length === 0 && !mergedEv && false);
      const hasRescope =
        evs.some((e) => e.event === "rescope" || e.event.startsWith("rescope ")) ||
        Boolean(task.boardRow?.rescoped);

      if (reviews.length > 0) {
        tasksWithReview++;
        if (reviews[0].event.startsWith("reviewed -> APPROVE")) firstPassApprove++;
      }

      if (isMerged || ( !mergedEv && task.boardRow == null && hasApproval && !evs.some((e) => e.event.startsWith("merged")) && false )) {
        mergedCount++;
        totalFixRuns += fixes.length;
        const hadFixReview = reviews.some((e) => e.event.startsWith("reviewed -> FIX"));
        if (hadFixReview) fixedThenMerged++;
        if (spawnEv?.ts && mergedEv?.ts && mergedEv.ts >= spawnEv.ts) {
          timesToMerge.push((mergedEv.ts - spawnEv.ts) / 60000);
        }
      }

      if (evs.some((e) => e.event.startsWith("reviewed -> FIX"))) hadFix++;
      if (hasRescope) rescopedCount++;
    }

    result[r] = {
      taskCount: repoTasks.length,
      firstPassApproveRate:
        tasksWithReview > 0
          ? Math.round((firstPassApprove / tasksWithReview) * 1000) / 10
          : null,
      fixRunsPerMergedPR:
        mergedCount > 0
          ? Math.round((totalFixRuns / mergedCount) * 100) / 100
          : null,
      fixConvergenceRate:
        hadFix > 0
          ? Math.round((fixedThenMerged / hadFix) * 1000) / 10
          : null,
      rescopeRate:
        repoTasks.length > 0
          ? Math.round((rescopedCount / repoTasks.length) * 1000) / 10
          : null,
      medianTimeToMergeMinutes: median(timesToMerge),
    };
  }

  return result;
}

export function evalMetrics({ logPath, boardPath, repo, json } = {}) {
  let text;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    process.stderr.write(`error: cannot read log file: ${logPath}\n`);
    process.exit(1);
  }
  let boardRows = [];
  if (boardPath) {
    try {
      boardRows = parseBoard(fs.readFileSync(boardPath, "utf8"));
    } catch {
      process.stderr.write(`error: cannot read board file: ${boardPath}\n`);
      process.exit(1);
    }
  }
  const events = parseLog(text);
  const nonBlankLines = text.split("\n").filter((l) => l.trim()).length;
  if (events.length === 0 && nonBlankLines > 0) {
    process.stderr.write(
      `error: 0 events parsed from ${nonBlankLines} non-blank line(s) — verify log contains work-loop events\n`
    );
    process.exit(1);
  }
  const metrics = computeMetrics(events, { repo, boardRows });
  if (json) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    const entries = Object.entries(metrics);
    if (entries.length === 0) {
      if (repo) {
        process.stderr.write(`warning: no events for repo ${repo}\n`);
      } else {
        console.log("No events found.");
      }
      return;
    }
    for (const [r, m] of entries) {
      console.log(`\nRepo: ${r}  (${m.taskCount} tasks)`);
      console.log(`  First-pass APPROVE rate:    ${m.firstPassApproveRate != null ? m.firstPassApproveRate + "%" : "n/a"}`);
      console.log(`  Fix runs per merged PR:     ${m.fixRunsPerMergedPR ?? "n/a"}`);
      console.log(`  Fix convergence rate:       ${m.fixConvergenceRate != null ? m.fixConvergenceRate + "%" : "n/a"}`);
      console.log(`  Rescope rate:               ${m.rescopeRate != null ? m.rescopeRate + "%" : "n/a"}`);
      console.log(
        `  Median time-to-merge:       ${m.medianTimeToMergeMinutes != null ? m.medianTimeToMergeMinutes + " min" : "n/a"}`
      );
    }
  }
}
