import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOOP_PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "loop-pack");

const LOOP_FILES = [
  "SKILL.md",
  "templates/BACKLOG.md",
  "templates/worker-prompt.md",
  "templates/fix-prompt.md",
  "templates/review-prompt.md",
  "templates/standup.md",
];

export function loopInit({ workspace = process.cwd(), dryRun = false, force = false } = {}) {
  const resolvedWorkspace = path.resolve(workspace);
  const destDir = path.join(resolvedWorkspace, ".clawsub-loop");
  const copied = [];
  const skipped = [];

  if (!dryRun) {
    fs.mkdirSync(path.join(destDir, "templates"), { recursive: true });
  }

  for (const file of LOOP_FILES) {
    const src = path.join(LOOP_PACK_DIR, file);
    const dest = path.join(destDir, file);
    if (!dryRun) {
      if (!force && fs.existsSync(dest)) {
        skipped.push(dest);
        continue;
      }
      fs.copyFileSync(src, dest);
    }
    copied.push(dest);
  }

  const quotedWorkspace = "'" + resolvedWorkspace.replace(/'/g, "'\\''").replace(/%/g, "\\%") + "'";
  const cronLines = [
    `# Worker tick — 1) fill in .clawsub-loop/templates/worker-prompt.md with real values and save as .clawsub-loop/worker.prompt.md; 2) set AGENT_CMD to your agent CLI (e.g. claude --print)`,
    `# */30 * * * * cd ${quotedWorkspace} && AGENT_CMD "$(cat .clawsub-loop/worker.prompt.md)" >> .clawsub-loop/worker.log 2>&1`,
    `# Daily standup at 09:00 Mon-Fri — AGENT_CMD reviews merged PRs for the day and appends a row to standup.md`,
    `# 0 9 * * 1-5 cd ${quotedWorkspace} && AGENT_CMD "List PRs merged today ($(date +\\%F)) and append a | date | task | PR | verdict | notes | row to .clawsub-loop/templates/standup.md" >> .clawsub-loop/standup.log 2>&1`,
  ];

  return { destDir, copied, skipped, cronLines, dryRun };
}
