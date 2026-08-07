import assert from "node:assert/strict";
import { test } from "node:test";
import { SELF_EVOLVE_MODULE_ID } from "../self-evolve-core.js";
import SelfEvolvePlugin from "../self-evolve.js";

const {
  commandDefinitionFingerprint,
  equivalentSelfEvolveCommandDefinition,
  ownsSelfEvolveCommand,
  registerSelfEvolveCommand,
  selfEvolveCommandDefinition,
} = SelfEvolvePlugin.__test;

function context(overrides = {}) {
  return {
    directory: "/workspace/project",
    client: {},
    ...overrides,
  };
}

async function legacyHooks() {
  return await SelfEvolvePlugin(context(), { durableAutonomy: false, now: () => 1_000 });
}

function trackedOutput(text = "original") {
  const parts = [{ type: "text", text }];
  const splice = parts.splice;
  let mutations = 0;
  parts.splice = function (...args) {
    mutations += 1;
    return splice.call(this, ...args);
  };
  return {
    output: { parts },
    parts,
    get mutations() { return mutations; },
  };
}

test("packed standalone config registers and owns the bundled /self-evolve command", async () => {
  const hooks = await legacyHooks();
  const cfg = { model: "openai/test", agent: {} };

  await hooks.config(cfg);

  const command = cfg.command["self-evolve"];
  assert.equal(command.description, "Inspect or control durable self-evolve behavior");
  assert.match(command.template, /status \| health \| budget \| scan/u);
  assert.match(command.template, /yolo confirm --allowlist/u);
  assert.match(command.template, /review \[id\]/u);
  assert.equal(command.metadata.owner, SELF_EVOLVE_MODULE_ID);
  assert.equal(command.metadata.definitionFingerprint, commandDefinitionFingerprint(command));
  assert.equal(ownsSelfEvolveCommand(cfg, command.metadata.definitionFingerprint), true);
  await hooks.dispose();
});

test("foreign definition registered before self-evolve is preserved and not intercepted", async () => {
  const hooks = await legacyHooks();
  const foreign = { description: "Foreign command", template: "Run foreign behavior: $ARGUMENTS" };
  const cfg = { model: "openai/test", agent: {}, command: { "self-evolve": foreign } };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await hooks.config(cfg);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(cfg.command["self-evolve"], foreign);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].length <= 240);
  const tracked = trackedOutput();
  await hooks["command.execute.before"](
    { command: "self-evolve", sessionID: "foreign-before", arguments: "status" },
    tracked.output,
  );
  assert.equal(tracked.mutations, 0);
  assert.equal(tracked.output.parts, tracked.parts);
  assert.equal(tracked.parts[0].text, "original");
  await hooks.dispose();
});

test("foreign replacement after self-evolve registration is detected without restoration or interception", async () => {
  const hooks = await legacyHooks();
  const cfg = { model: "openai/test", agent: {} };
  await hooks.config(cfg);
  const originallyOwned = cfg.command["self-evolve"];
  const foreign = { description: "Later foreign command", template: "Foreign later behavior" };
  cfg.command["self-evolve"] = foreign;

  const registration = registerSelfEvolveCommand(cfg);
  assert.deepEqual(registration, {
    registered: false,
    equivalent: false,
    owned: false,
    reason: "foreign-command-definition",
    definitionFingerprint: originallyOwned.metadata.definitionFingerprint,
  });
  assert.equal(cfg.command["self-evolve"], foreign);

  const tracked = trackedOutput();
  await hooks["command.execute.before"](
    { command: "self-evolve", sessionID: "foreign-after", arguments: "status" },
    tracked.output,
  );
  assert.equal(tracked.mutations, 0);
  assert.equal(cfg.command["self-evolve"], foreign);
  await hooks.dispose();
});

test("own-equivalent duplicate factories are idempotent", async () => {
  const first = await legacyHooks();
  const second = await legacyHooks();
  const cfg = { model: "openai/test", agent: {} };
  await first.config(cfg);
  const registered = cfg.command["self-evolve"];
  await second.config(cfg);

  assert.equal(cfg.command["self-evolve"], registered);
  assert.equal(equivalentSelfEvolveCommandDefinition(registered, selfEvolveCommandDefinition()), true);
  assert.equal(Object.keys(cfg.command).filter((name) => name === "self-evolve").length, 1);
  await first.dispose();
  await second.dispose();
});

test("execution revalidates ownership and handled legacy branches replace parts exactly once", async () => {
  const hooks = await legacyHooks();
  const cfg = { model: "openai/test", agent: {} };
  const unconfigured = trackedOutput();
  await hooks["command.execute.before"](
    { command: "self-evolve", sessionID: "not-owned-yet", arguments: "status" },
    unconfigured.output,
  );
  // Before the config hook runs, ownership is unknown (not foreign), so the command
  // is handled as on a standalone/legacy install; a foreign definition is only
  // positively detected once config registration has run.
  assert.equal(unconfigured.mutations, 1, "unregistered command is handled until config detects a foreign owner");

  await hooks.config(cfg);
  for (const argumentsValue of ["status", "pause", "resume", "disable"]) {
    const tracked = trackedOutput();
    await hooks["command.execute.before"](
      { command: "self-evolve", sessionID: `owned-${argumentsValue}`, arguments: argumentsValue },
      tracked.output,
    );
    assert.equal(tracked.mutations, 1, `${argumentsValue} must replace parts exactly once`);
    assert.equal(tracked.output.parts, tracked.parts);
    assert.notEqual(tracked.parts[0].text, "original");
  }

  cfg.command["self-evolve"] = { description: "Foreign", template: "Foreign" };
  const foreign = trackedOutput();
  await hooks["command.execute.before"](
    { command: "self-evolve", sessionID: "ownership-recheck", arguments: "status" },
    foreign.output,
  );
  assert.equal(foreign.mutations, 0);
  await hooks.dispose();
});

test("startup-pending and unsupported-host gates retain authority and replace parts exactly once", async () => {
  const pendingHealth = new Promise(() => {});
  const pending = await SelfEvolvePlugin(context({
    client: { global: { health: async () => await pendingHealth } },
  }), { __testHostHealthTimeoutMs: 10_000 });
  await pending.config({ model: "openai/test", agent: {} });
  const pendingOutput = trackedOutput();
  await pending["command.execute.before"](
    { command: "self-evolve", sessionID: "pending", arguments: "auto" },
    pendingOutput.output,
  );
  assert.equal(pendingOutput.mutations, 1);
  assert.match(pendingOutput.parts.at(-1).text, /startup-validation-pending/u);
  assert.match(pendingOutput.parts.at(-1).text, /No mode change.*file write was attempted/u);
  await pending.dispose();

  const unsupported = await SelfEvolvePlugin(context({
    client: { global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) } },
  }), { hostSupported: false });
  await unsupported.config({ model: "openai/test", agent: {} });
  let finalOutput;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const tracked = trackedOutput();
    await unsupported["command.execute.before"](
      { command: "self-evolve", sessionID: "unsupported", arguments: "auto" },
      tracked.output,
    );
    assert.equal(tracked.mutations, 1);
    finalOutput = tracked.parts.at(-1).text;
    if (!/startup-validation-pending/u.test(finalOutput)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(finalOutput, /autonomous authority unavailable/u);
  assert.match(finalOutput, /No mode change.*file write was attempted/u);
  await unsupported.dispose();
});
