import { spawnSync } from "node:child_process";

export const runtimeId = "agy-cli";

export const AGY_FLAGS = [
  "--dangerously-skip-permissions",
  "--disable-slash-commands",
  "--settings",
  JSON.stringify({ allowNonWorkspaceAccess: true }),
  "--output-format",
  "stream-json",
];

export function run(prompt, opts = {}) {
  const { binary = "agy", workspace, extraArgs = [] } = opts;
  const args = [...AGY_FLAGS, ...extraArgs, "--", prompt];
  const result = spawnSync(binary, args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: result.error.message,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

export const plugin = {
  id: "openclaw-agy-cli",
  runtimeId,
  run,
};
