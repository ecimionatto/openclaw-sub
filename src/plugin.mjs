import { PROVIDERS } from "./providers.mjs";

export const PLUGIN_NAME = "openclaw-sub";

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

const agyCLIBackend = {
  id: "agy-cli",
  command: PROVIDERS.agy.binary,
  altCommand: PROVIDERS.agy.altBinary,
  buildArgs: (prompt, opts = {}) => {
    const { args } = PROVIDERS.agy.buildCommand(prompt, opts);
    return args;
  },
  parseOutput: (text) => parseJSONL(text),
};

export function getPluginInfo() {
  return {
    name: PLUGIN_NAME,
    provides: ["agy-cli"],
    backend: agyCLIBackend,
  };
}

export default {
  register(api) {
    api.registerCliBackend({
      id: agyCLIBackend.id,
      config: {
        command: agyCLIBackend.command,
        buildArgs: agyCLIBackend.buildArgs,
        parseOutput: agyCLIBackend.parseOutput,
      },
    });
  },
};
