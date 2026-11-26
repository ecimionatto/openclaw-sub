import { PROVIDERS } from "./providers.mjs";
import { detectBinary } from "./providers.mjs";

export const PLUGIN_NAME = "openclaw-sub";

export const AGY_SESSION_SETTINGS = JSON.stringify({
  allowNonWorkspaceAccess: true,
});

export function normalizeAgyUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const usage = {};
  if (typeof raw.input_tokens === "number" && Number.isFinite(raw.input_tokens)) {
    usage.input = raw.input_tokens;
  }
  if (typeof raw.output_tokens === "number" && Number.isFinite(raw.output_tokens)) {
    usage.output = raw.output_tokens;
  }
  if (typeof raw.cache_read_tokens === "number" && Number.isFinite(raw.cache_read_tokens)) {
    usage.cacheRead = raw.cache_read_tokens;
  }
  if (typeof raw.total_tokens === "number" && Number.isFinite(raw.total_tokens)) {
    usage.total = raw.total_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function parseAgyJsonlEvent(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.event !== "string") {
    return null;
  }

  if (parsed.event === "init") {
    const sessionId =
      typeof parsed.conversation_id === "string" ? parsed.conversation_id.trim() : "";
    return sessionId ? { kind: "sessionId", sessionId } : [];
  }

  if (parsed.event === "step_update") {
    const update = parsed.step_update;
    if (!update || typeof update !== "object") {
      return [];
    }
    const events = [];
    const sessionId =
      typeof update.conversation_id === "string" ? update.conversation_id.trim() : "";
    if (sessionId) {
      events.push({ kind: "sessionId", sessionId });
    }
    if (update.step_type === "agent_response") {
      if (typeof update.text_delta === "string" && update.text_delta.length > 0) {
        events.push({ kind: "text", text: update.text_delta });
      }
      return events;
    }
    return events;
  }

  if (parsed.event === "result") {
    const res = parsed.result && typeof parsed.result === "object" ? parsed.result : {};
    const sessionId =
      (typeof res.conversation_id === "string" && res.conversation_id.trim()) ||
      (typeof parsed.conversation_id === "string" && parsed.conversation_id.trim()) ||
      undefined;
    const usage = normalizeAgyUsage(res.usage);
    const status = typeof res.status === "string" ? res.status.trim() : "";
    const explicitError = typeof res.error === "string" ? res.error.trim() : "";
    const isFailure = Boolean(explicitError) || (Boolean(status) && status !== "SUCCESS");
    const errorText = isFailure
      ? explicitError || `Antigravity CLI ended with status ${status || "ERROR"}.`
      : undefined;
    const text = !errorText && typeof res.response === "string" ? res.response : "";

    return {
      kind: "result",
      text,
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {}),
      ...(errorText ? { errorText } : {}),
    };
  }

  return [];
}

export function parseJSONL(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

export function resolveAgyCommand(findBinary = detectBinary) {
  const primary = findBinary(PROVIDERS.agy.binary);
  if (primary?.installed) {
    return primary.path || PROVIDERS.agy.binary;
  }
  const alt = PROVIDERS.agy.altBinary ? findBinary(PROVIDERS.agy.altBinary) : null;
  if (alt?.installed) {
    return alt.path || PROVIDERS.agy.altBinary;
  }
  return PROVIDERS.agy.binary;
}

export function buildAgyCliBackend({ findBinary = detectBinary } = {}) {
  const command = resolveAgyCommand(findBinary);
  const baseFlags = [
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--settings",
    AGY_SESSION_SETTINGS,
    "--output-format",
    "stream-json",
  ];

  return {
    id: "agy-cli",
    modelProvider: "agy-cli",
    ownsNativeCompaction: true,
    nativeToolMode: "selectable",
    sideQuestionToolMode: "disabled",
    toolAvailabilityEnforcement: "prepare-execution",
    autoSelectAuthProfile: false,
    parseJsonlEvent: parseAgyJsonlEvent,
    config: {
      command,
      args: [...baseFlags, "--prompt", "{prompt}"],
      resumeArgs: ["--conversation", "{sessionId}", ...baseFlags, "--prompt", "{prompt}"],
      output: "jsonl",
      resumeOutput: "jsonl",
      input: "arg",
      modelArg: "--model",
      sessionMode: "existing",
      sessionIdFields: ["conversation_id", "conversationId", "session_id", "sessionId"],
      serialize: true,
    },
  };
}

export default {
  id: PLUGIN_NAME,
  name: "openclaw-sub (Antigravity CLI)",
  description: "Run Google Antigravity CLI (agy) and subscription failover through OpenClaw",
  register(api, opts) {
    api.registerCliBackend(buildAgyCliBackend(opts));
  },
};
