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

export function loopInit({ workspace = process.cwd(), dryRun = false } = {}) {
  const destDir = path.join(workspace, ".clawsub-loop");
  const copied = [];

  if (!dryRun) {
    fs.mkdirSync(path.join(destDir, "templates"), { recursive: true });
  }

  for (const file of LOOP_FILES) {
    const src = path.join(LOOP_PACK_DIR, file);
    const dest = path.join(destDir, file);
    if (!dryRun) {
      fs.copyFileSync(src, dest);
    }
    copied.push(dest);
  }

  const cronLines = [
    `# Worker tick — every 30 minutes`,
    `*/30 * * * * cd ${workspace} && clawsub loop tick >> .clawsub-loop/worker.log 2>&1`,
    `# Daily standup — 09:00 Mon-Fri`,
    `0 9 * * 1-5 cd ${workspace} && clawsub loop standup >> .clawsub-loop/standup.log 2>&1`,
  ];

  return { destDir, copied, cronLines, dryRun };
}
