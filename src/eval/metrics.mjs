import fs from "node:fs";

const LINE_RE =
  /^(?:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+)?repo:(\S+)\s+task:(\S+)\s+(.+)$/;

export function parseLog(text) {
  const events = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, tsRaw, repo, taskId, eventRaw] = m;
    events.push({
      ts: tsRaw ? new Date(tsRaw) : null,
      repo,
      taskId,
      event: eventRaw.trim(),
    });
  }
  return events;
}

function groupByTask(events) {
  const tasks = new Map();
  for (const ev of events) {
    const key = `${ev.repo}::${ev.taskId}`;
    if (!tasks.has(key)) tasks.set(key, { repo: ev.repo, taskId: ev.taskId, events: [] });
    tasks.get(key).events.push(ev);
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

export function computeMetrics(events, { repo } = {}) {
  const filtered = repo ? events.filter((e) => e.repo === repo) : events;
  const tasks = groupByTask(filtered);

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
      const spawnEv = evs.find((e) => e.event === "spawned");
      const mergedEv = evs.find((e) => e.event === "merged");
      const reviews = evs.filter((e) => e.event.startsWith("reviewed ->"));
      const fixes = evs.filter((e) => /^fix .+ attempt \d+$/.test(e.event));
      const hasRescope = evs.some((e) => e.event === "rescope");

      if (reviews.length > 0) {
        tasksWithReview++;
        if (reviews[0].event === "reviewed -> APPROVE") firstPassApprove++;
      }

      if (mergedEv) {
        mergedCount++;
        totalFixRuns += fixes.length;
        const hadFixReview = reviews.some((e) => e.event === "reviewed -> FIX");
        if (hadFixReview) fixedThenMerged++;
        if (spawnEv?.ts && mergedEv.ts) {
          timesToMerge.push((mergedEv.ts - spawnEv.ts) / 60000);
        }
      }

      if (evs.some((e) => e.event === "reviewed -> FIX")) hadFix++;
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
      rescapeRate:
        repoTasks.length > 0
          ? Math.round((rescopedCount / repoTasks.length) * 1000) / 10
          : null,
      medianTimeToMergeMinutes: median(timesToMerge),
    };
  }

  return result;
}

export function evalMetrics({ logPath, repo, json } = {}) {
  const text = fs.readFileSync(logPath, "utf8");
  const events = parseLog(text);
  const metrics = computeMetrics(events, { repo });
  if (json) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    for (const [r, m] of Object.entries(metrics)) {
      console.log(`\nRepo: ${r}  (${m.taskCount} tasks)`);
      console.log(`  First-pass APPROVE rate:    ${m.firstPassApproveRate ?? "n/a"}%`);
      console.log(`  Fix runs per merged PR:     ${m.fixRunsPerMergedPR ?? "n/a"}`);
      console.log(`  Fix convergence rate:       ${m.fixConvergenceRate ?? "n/a"}%`);
      console.log(`  Rescope rate:               ${m.rescapeRate ?? "n/a"}%`);
      console.log(
        `  Median time-to-merge:       ${m.medianTimeToMergeMinutes != null ? m.medianTimeToMergeMinutes + " min" : "n/a"}`
      );
    }
  }
}
