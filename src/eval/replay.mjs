import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TASKS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../evals/tasks"
);

export function loadTask(taskId, { tasksDir = DEFAULT_TASKS_DIR } = {}) {
  const file = path.join(tasksDir, `${taskId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Task not found: ${taskId} (looked in ${tasksDir})`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function listTasks({ tasksDir = DEFAULT_TASKS_DIR } = {}) {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function replayDryRun(taskId, { tasksDir = DEFAULT_TASKS_DIR } = {}) {
  const task = loadTask(taskId, { tasksDir });
  return {
    taskId: task.id,
    title: task.title,
    plan: [
      { step: 1, action: "spawn", detail: `Spawn worker for task ${task.id}: ${task.title}` },
      { step: 2, action: "prompt", detail: task.prompt },
      { step: 3, action: "review", detail: "Run acceptance criteria checks (no model calls in dry-run)" },
      {
        step: 4,
        action: "verify",
        detail: `Verify ${task.acceptanceCriteria.length} acceptance criterion/criteria`,
        criteria: task.acceptanceCriteria,
      },
      { step: 5, action: "report", detail: "Emit pass/fail per criterion and overall result" },
    ],
    dryRun: true,
  };
}

export function evalReplay({ taskId, tasksDir, json } = {}) {
  if (!taskId) {
    throw new Error("--task <id> is required");
  }
  const plan = replayDryRun(taskId, { tasksDir });
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`\nDry-run plan for task: ${plan.taskId} — ${plan.title}`);
    console.log("Steps:");
    for (const s of plan.plan) {
      console.log(`  ${s.step}. [${s.action}] ${s.detail}`);
      if (s.criteria) {
        for (const c of s.criteria) console.log(`       - ${c}`);
      }
    }
    console.log("\n(dry-run: no model calls executed)");
  }
}
