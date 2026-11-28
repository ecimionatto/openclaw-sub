import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Built-in subscription CLI provider definitions.
 * Each adapter specifies how to detect installation, verify OAuth login state,
 * check headless safety, and build a non-interactive CLI invocation.
 */
export const PROVIDERS = {
  claude: {
    id: "claude",
    name: "Claude Code CLI",
    subscription: "Claude Pro / Max",
    binary: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginHint: "claude login",
    buildCommand(prompt, opts = {}) {
      const args = ["-p", "--output-format", "text"];
      if (opts.model) {
        args.push("--model", opts.model);
      }
      if (opts.extraArgs?.length) {
        args.push(...opts.extraArgs);
      }
      return {
        command: "claude",
        args,
        input: prompt,
      };
    },
    checkAuth(homeDir = os.homedir()) {
      const claudeJson = path.join(homeDir, ".claude.json");
      const claudeDir = path.join(homeDir, ".claude");
      const hasConfig = fs.existsSync(claudeJson) || fs.existsSync(claudeDir);
      return {
        authenticated: hasConfig,
        detail: hasConfig
          ? "OAuth session found (~/.claude)"
          : "No ~/.claude session found — run `claude login`",
      };
    },
    checkHeadlessSafety() {
      return {
        safe: true,
        warnings: [],
        detail: "Uses `claude -p --output-format text` (headless print mode)",
      };
    },
  },

  codex: {
    id: "codex",
    name: "OpenAI Codex CLI",
    subscription: "ChatGPT Plus / Pro",
    binary: "codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "codex login",
    buildCommand(prompt, opts = {}) {
      const args = ["exec", "--skip-git-repo-check"];
      if (opts.model) {
        args.push("--model", opts.model);
      }
      if (opts.extraArgs?.length) {
        args.push(...opts.extraArgs);
      }
      args.push(prompt);
      return {
        command: "codex",
        args,
        input: undefined,
      };
    },
    checkAuth(homeDir = os.homedir()) {
      const codexDir = path.join(homeDir, ".codex");
      const authFile = path.join(codexDir, "auth.json");
      const hasAuth = fs.existsSync(authFile) || fs.existsSync(codexDir);
      return {
        authenticated: hasAuth,
        detail: hasAuth
          ? "OAuth session found (~/.codex)"
          : "No ~/.codex session found — run `codex login`",
      };
    },
    checkHeadlessSafety() {
      return {
        safe: true,
        warnings: [],
        detail: "Uses `codex exec --skip-git-repo-check` (non-interactive mode)",
      };
    },
  },

  agy: {
    id: "agy",
    name: "Google Antigravity / Gemini CLI",
    subscription: "Google AI Pro / Ultra / Free Tier",
    binary: "agy",
    altBinary: "gemini",
    installHint: "Install Antigravity CLI (`agy`) or Gemini CLI (`npm install -g @google/gemini-cli`)",
    loginHint: "agy (or `gemini`) and complete browser sign-in",
    buildCommand(prompt, opts = {}) {
      const bin = opts.binary || "agy";
      const args = ["-p", prompt];
      if (opts.workspace) {
        args.push("--workspace", opts.workspace);
      }
      if (opts.extraArgs?.length) {
        args.push(...opts.extraArgs);
      }
      return {
        command: bin,
        args,
        input: undefined,
      };
    },
    checkAuth(homeDir = os.homedir()) {
      const agyDir = path.join(homeDir, ".gemini", "antigravity-cli");
      const geminiDir = path.join(homeDir, ".gemini");
      const hasAuth = fs.existsSync(agyDir) || fs.existsSync(geminiDir);
      return {
        authenticated: hasAuth,
        detail: hasAuth
          ? "Google session found (~/.gemini)"
          : "No ~/.gemini config found — launch `agy` or `gemini` once to authenticate",
      };
    },
    checkHeadlessSafety(homeDir = os.homedir()) {
      const settingsPath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
      const warnings = [];
      if (!fs.existsSync(settingsPath)) {
        warnings.push(
          "~/.gemini/antigravity-cli/settings.json not found. Ensure out-of-workspace reads or shell commands are auto-approved or scoped to --workspace so headless turns never block on TUI prompts."
        );
      }
      return {
        safe: warnings.length === 0,
        warnings,
        detail:
          warnings.length === 0
            ? "Antigravity settings.json present; pass --workspace to keep file operations inside workspace boundary"
            : warnings[0],
      };
    },
  },

  ollama: {
    id: "ollama",
    name: "Ollama Local CLI (Zero-Cost Offline Fallback)",
    subscription: "Free / Local Hardware",
    binary: "ollama",
    installHint: "curl -fsSL https://ollama.com/install.sh | sh",
    loginHint: "ollama pull llama3.2",
    buildCommand(prompt, opts = {}) {
      const model = opts.model || "llama3.2";
      return {
        command: "ollama",
        args: ["run", model, prompt],
        input: undefined,
      };
    },
    checkAuth() {
      return {
        authenticated: true,
        detail: "Local daemon (no cloud login required)",
      };
    },
    checkHeadlessSafety() {
      return {
        safe: true,
        warnings: [],
        detail: "Local non-interactive execution",
      };
    },
  },
};

/**
 * Checks if a binary exists on PATH and returns its version output.
 * @param {string} binary
 * @returns {{ installed: boolean, binary: string, version: string | null }}
 */
export function detectBinary(binary) {
  try {
    const res = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.status === 0 || (res.stdout && res.stdout.trim())) {
      const line = (res.stdout || res.stderr || "").trim().split("\n")[0];
      return { installed: true, binary, version: line || "installed" };
    }
  } catch {
    // ignore
  }
  return { installed: false, binary, version: null };
}

/**
 * Inspects a provider's installation, authentication, and headless safety status.
 * @param {string} providerId
 * @param {{ homeDir?: string }} [opts]
 */
export function inspectProvider(providerId, opts = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  let binInfo = detectBinary(provider.binary);
  if (!binInfo.installed && provider.altBinary) {
    binInfo = detectBinary(provider.altBinary);
  }
  const auth = provider.checkAuth(opts.homeDir);
  const headless = provider.checkHeadlessSafety(opts.homeDir);
  return {
    id: provider.id,
    name: provider.name,
    subscription: provider.subscription,
    installed: binInfo.installed,
    binary: binInfo.binary,
    version: binInfo.version,
    authenticated: auth.authenticated,
    authDetail: auth.detail,
    headlessSafe: headless.safe,
    headlessDetail: headless.detail,
    warnings: headless.warnings,
    installHint: provider.installHint,
    loginHint: provider.loginHint,
  };
}

/**
 * Default synchronous/promise command runner using child_process.spawnSync.
 */
export function defaultCommandRunner({ command, args, input, cwd, timeoutMs = 900_000 }) {
  const start = Date.now();
  const res = spawnSync(command, args, {
    input,
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const latencyMs = Date.now() - start;
  const stdout = (res.stdout || "").trim();
  const stderr = (res.stderr || "").trim();
  const exitCode = res.status ?? (res.error ? 1 : 0);
  return {
    exitCode,
    stdout,
    stderr,
    latencyMs,
    error: res.error ? res.error.message : null,
  };
}
