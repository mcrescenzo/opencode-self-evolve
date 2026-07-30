import fs from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";

const TYPE = "self-evolve-host-spike-folder";

export default async ({ experimental_workspace }) => {
  const directory = process.env.SELF_EVOLVE_TUI_SPIKE_WORKSPACE;
  if (!directory || !path.isAbsolute(directory) || path.basename(directory) !== "warped-workspace") {
    throw new Error("SELF_EVOLVE_TUI_SPIKE_WORKSPACE must identify the scratch folder workspace");
  }
  const target = path.resolve(directory);
  const eventsPath = process.env.SELF_EVOLVE_TUI_SPIKE_EVENTS;
  const recordProviderPromptHook = () => {
    if (!eventsPath || !path.isAbsolute(eventsPath) || !existsSync(eventsPath)) return;
    appendFileSync(eventsPath, `${JSON.stringify({ source: "server-witness", type: "provider-prompt-hook" })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };
  experimental_workspace.register(TYPE, {
    name: "Self-evolve scratch folder",
    description: "Exact-host spike folder workspace",
    configure(input) {
      return {
        ...input,
        name: "Self-evolve scratch folder",
        branch: "spike/exact-host",
        directory: target,
      };
    },
    async create(input) {
      if (path.resolve(input.directory ?? "") !== target) throw new Error("workspace adapter target drifted");
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(target, ".self-evolve-host-spike-created"), "created\n", { mode: 0o600 });
    },
    async remove() {},
    target(input) {
      if (path.resolve(input.directory ?? "") !== target) throw new Error("workspace adapter target drifted");
      return { type: "local", directory: target };
    },
  });
  return {
    "chat.params": async () => {
      recordProviderPromptHook();
    },
  };
};
