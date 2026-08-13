import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as pluginModule from "../self-evolve.js";
import {
  HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
} from "../self-evolve-core.js";

const SelfEvolvePlugin = pluginModule.default;

test("the package and server entry have no analyzer implementation reachability", async () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const source = readFileSync(new URL("../self-evolve.js", import.meta.url), "utf8");

  assert.deepEqual(Object.keys(pluginModule), ["default"]);
  assert.equal(existsSync(new URL("../analyzer-prompt.js", import.meta.url)), false);
  assert.equal(packageJson.files.includes("analyzer-prompt.js"), false);
  assert.doesNotMatch(packageJson.scripts.check, /analyzer-prompt/u);
  assert.doesNotMatch(source, /runHiddenAnalyzer|runAnalysis|createRegistry|proposalNotification|registerAnalyzerAgent|analyzerAgentDefinition/u);
  assert.doesNotMatch(source, /durableAutonomy\s*!==\s*false/u);

  await assert.rejects(
    SelfEvolvePlugin({ directory: "/workspace", client: {} }, { durableAutonomy: false }),
    /durableAutonomy-option-retired-v04/u,
  );
  await assert.rejects(
    SelfEvolvePlugin({ directory: "/workspace", client: {} }, { durableAutonomy: true }),
    /durableAutonomy-option-retired-v04/u,
  );
});

test("fresh startup registers only provider roles and never creates or prompts an analyzer", async (t) => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "self-evolve-no-analyzer-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const calls = { create: 0, messages: 0, prompt: 0, promptAsync: 0 };
  const pipeline = {
    async boot() { return { ok: true }; },
    async handleCommand() { return { responseText: "Self-evolve status: fresh durable runtime." }; },
    getProjectOperationalState() { return { passiveAnalysisAllowed: false }; },
    async shutdown() { return { ok: true }; },
  };
  const ctx = {
    directory: "/workspace/project",
    client: {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) },
      session: {
        create: async () => { calls.create += 1; return { data: { id: "unexpected" } }; },
        messages: async () => { calls.messages += 1; return { data: [] }; },
        prompt: async () => { calls.prompt += 1; return { data: {} }; },
        promptAsync: async () => { calls.promptAsync += 1; return { data: {} }; },
      },
    },
  };
  const hooks = await SelfEvolvePlugin(ctx, {
    stateRoot,
    pipeline,
  });
  t.after(async () => hooks.dispose());
  const cfg = { model: "fixture/model", agent: {} };
  await hooks.config(cfg);

  let response = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "fresh", arguments: "status" }, output);
    response = output.parts.at(-1)?.text ?? "";
    if (!response.includes("startup-validation-pending")) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.match(response, /fresh durable runtime/u);
  assert.deepEqual(Object.keys(cfg.agent).sort(), [SELF_EVOLVE_CRITIC_AGENT, SELF_EVOLVE_SYNTHESIZER_AGENT].sort());
  assert.equal(cfg.agent[HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT], undefined);
  assert.deepEqual(calls, { create: 0, messages: 0, prompt: 0, promptAsync: 0 });
  assert.equal(typeof hooks.event, "function");
  assert.equal(hooks["chat.message"], undefined);
});
