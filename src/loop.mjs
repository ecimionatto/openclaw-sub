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

  const quotedWorkspace = `"${resolvedWorkspace}"`;
  const cronLines = [
    `# Worker tick — replace AGENT_CMD with your agent invocation (e.g. claude --print)`,
    `# */30 * * * * cd ${quotedWorkspace} && AGENT_CMD "$(cat .clawsub-loop/templates/worker-prompt.md)" >> .clawsub-loop/worker.log 2>&1`,
    `# Daily standup — append a row to standup.md at 09:00 Mon-Fri`,
    `# 0 9 * * 1-5 cd ${quotedWorkspace} && echo "| $(date +%F) | TASK | PR | verdict | notes |" >> .clawsub-loop/templates/standup.md`,
  ];

  return { destDir, copied, skipped, cronLines, dryRun };
}
