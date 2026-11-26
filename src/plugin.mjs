import { PROVIDERS } from "./providers.mjs";

export const PLUGIN_NAME = "openclaw-sub";

// Registers the agy-cli backend as an OpenClaw plugin entry point.
// When users add this file's path (or its parent directory) to openclaw.json
// plugins.load.paths, OpenClaw can discover and invoke the agy/Gemini CLI backend.
export const agyCLIBackend = {
  ...PROVIDERS.agy,
  plugin: true,
};

/**
 * Returns plugin identity and backend for OpenClaw plugin system discovery.
 * @returns {{ name: string, provides: string[], backend: object }}
 */
export function getPluginInfo() {
  return {
    name: PLUGIN_NAME,
    provides: ["agy-cli"],
    backend: agyCLIBackend,
  };
}

/**
 * Parses JSONL (newline-delimited JSON) output from subscription CLI tools.
 * Lines that are not valid JSON are returned as { raw: line }.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseJSONL(text) {
  return text
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
