import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import SelfEvolvePlugin from "../self-evolve.js";
import {
  HISTORICAL_SELF_EVOLVE_AGENTS,
  HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  SELF_EVOLVE_SOURCE,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
} from "../self-evolve-core.js";
import { recoverOrphanedHiddenSessions } from "../self-evolve-integration.js";
import { CRITIC_AGENT_NAME, SYNTHESIS_AGENT_NAME } from "../self-evolve-synthesis.js";
import { openStore } from "../self-evolve-store.js";
import {
  SELF_EVOLVE_MODULE_ID,
  TUI_IDENTITIES,
  TUI_KV_KEYS,
  TUI_LEGACY_KV_KEYS,
  claimTuiSurfaceOwnership,
  createOwnedKv,
} from "../self-evolve-tui.js";

const PROJECT = "a".repeat(64);
const MODULE_ID = "mcrescenzo.self-evolve";

function pluginContext() {
  return { directory: "/workspace/project", client: {} };
}

function memoryKv(entries = []) {
  const values = new Map(entries);
  const writes = [];
  return {
    values,
    writes,
    get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    set(key, value) { writes.push([key, value]); values.set(key, value); },
  };
}

test("canonical server, durable, synthesis, source, and TUI identities stay aligned", async () => {
  assert.equal(SELF_EVOLVE_MODULE_ID, MODULE_ID);
  assert.equal(SELF_EVOLVE_SOURCE, MODULE_ID);
  assert.equal(HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT, `${MODULE_ID}.analyzer`);
  assert.equal(SELF_EVOLVE_SYNTHESIZER_AGENT, `${MODULE_ID}.synthesizer`);
  assert.equal(SELF_EVOLVE_CRITIC_AGENT, `${MODULE_ID}.critic`);
  assert.equal(SYNTHESIS_AGENT_NAME, SELF_EVOLVE_SYNTHESIZER_AGENT);
  assert.equal(CRITIC_AGENT_NAME, SELF_EVOLVE_CRITIC_AGENT);
  assert.deepEqual(TUI_IDENTITIES, {
    command: `${MODULE_ID}.control-center`,
    route: `${MODULE_ID}.control-center.route`,
    mode: `${MODULE_ID}.control-center`,
    view: `${MODULE_ID}.control-center`,
    paletteLayer: `${MODULE_ID}.control-center.palette`,
    modeLayer: `${MODULE_ID}.control-center.mode`,
  });

  const source = readFileSync(new URL("../self-evolve-tui.tsx", import.meta.url), "utf8");
  assert.match(source, /TUI_IDENTITIES\.command/u);
  assert.match(source, /TUI_IDENTITIES\.route/u);
  assert.match(source, /TUI_IDENTITIES\.mode/u);
  assert.match(source, /TUI_IDENTITIES\.view/u);
  assert.match(source, /id:\s*TUI_IDENTITIES\.paletteLayer/u);
  assert.match(source, /id:\s*TUI_IDENTITIES\.modeLayer/u);
  assert.doesNotMatch(source, /["']self-evolve(?:\.control-center|\.control-center\.route|-control-center)["']/u);
  assert.match(source, /submitDecision/u);
  assert.match(source, /submitOperation/u);
  assert.doesNotMatch(source, /submitControl/u);
  assert.doesNotMatch(source, /appendRecord|updateSettings|api\.client\.selfEvolve|writeFile/u);

  const serverSource = readFileSync(new URL("../self-evolve.js", import.meta.url), "utf8");
  assert.match(serverSource, /import\("\.\/self-evolve-privacy\.js"\)/u);
  assert.doesNotMatch(serverSource, /from\s+["'](?:\.\/tui|@opentui\/)|import\(["'](?:\.\/tui|@opentui\/)/u);

  const hooks = await SelfEvolvePlugin(pluginContext());
  const cfg = { model: "fixture/model", agent: {} };
  await hooks.config(cfg);
  for (const agentName of [SELF_EVOLVE_SYNTHESIZER_AGENT, SELF_EVOLVE_CRITIC_AGENT]) {
    const agent = cfg.agent[agentName];
    assert.ok(agent);
    assert.equal(agent.mode, "primary");
    assert.equal(agent.hidden, true);
    assert.equal(agent.temperature, 0);
    assert.equal(agent.steps, 1);
    assert.equal(agent.permission["*"], "deny");
    assert.equal(agent.permission.edit, "deny");
    assert.equal(agent.metadata, undefined, "agent registration uses only supported config fields");
  }
  assert.equal(cfg.agent[HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT], undefined);
  assert.equal(typeof hooks["chat.params"], "function");
  await hooks.dispose();
});

test("current hidden agent registrations preserve foreign definitions and treat exact duplicates as idempotent", async () => {
  const hooks = await SelfEvolvePlugin(pluginContext());
  const foreign = { description: "Anonymous co-install agent", prompt: "foreign", permission: { "*": "allow" } };
  const foreignFirst = {
    model: "fixture/model",
    agent: {
      [HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT]: foreign,
      [SELF_EVOLVE_SYNTHESIZER_AGENT]: foreign,
      [SELF_EVOLVE_CRITIC_AGENT]: foreign,
    },
  };
  await hooks.config(foreignFirst);
  for (const agentName of [HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT, SELF_EVOLVE_SYNTHESIZER_AGENT, SELF_EVOLVE_CRITIC_AGENT]) {
    assert.equal(foreignFirst.agent[agentName], foreign);
  }

  const owned = { model: "fixture/model", agent: {} };
  await hooks.config(owned);
  const first = new Map(Object.entries(owned.agent));
  await hooks.config(owned);
  for (const [agentName, definition] of first) assert.equal(owned.agent[agentName], definition);

  owned.agent[HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT] = foreign;
  await hooks.config(owned);
  assert.equal(owned.agent[HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT], foreign, "the cleanup-only analyzer key is never claimed");
  await hooks.dispose();
});

test("unsupported host agent config fails closed without replacing host state", () => {
  const cfg = { model: "fixture/model", agent: "unsupported-host-shape" };
  const registrations = SelfEvolvePlugin.__test.registerHiddenAgents(cfg);
  assert.equal(cfg.agent, "unsupported-host-shape");
  assert.equal(registrations.size, 2);
  for (const agentName of [SELF_EVOLVE_SYNTHESIZER_AGENT, SELF_EVOLVE_CRITIC_AGENT]) {
    assert.deepEqual(registrations.get(agentName), {
      registered: false,
      equivalent: false,
      owned: false,
      reason: "host-agent-config-unsupported",
      definitionFingerprint: SelfEvolvePlugin.__test.agentDefinitionFingerprint(
        SelfEvolvePlugin.__test.hiddenAgentDefinitions(cfg.model).get(agentName),
      ),
    });
  }
});

test("durable global synthesis binding overrides caller registration bypasses", async () => {
  const calls = [];
  const registration = { assert: () => {} };
  const module = SelfEvolvePlugin.__test.bindHiddenAgentRegistration({
    async runGlobalSynthesis(args) { calls.push(args); return "global-synthesis"; },
  }, registration);
  const bypass = { assert: () => { throw new Error("must be replaced"); } };

  assert.equal(await module.runGlobalSynthesis({ options: { marker: 1, hiddenAgentRegistration: bypass } }), "global-synthesis");
  assert.equal(calls[0].options.hiddenAgentRegistration, registration);
  assert.equal(calls[0].options.marker, 1);
});

test("TUI surface ownership preserves foreign claims in both load orders and deduplicates package loads", () => {
  const registryKey = Symbol.for("mcrescenzo.self-evolve.tui.surface-registry");
  for (const id of [TUI_IDENTITIES.route, TUI_IDENTITIES.view]) {
    const api = { [registryKey]: new Map([[id, { owner: "anonymous.fixture", fingerprint: "foreign" }]]) };
    const foreignFirst = claimTuiSurfaceOwnership(api);
    assert.equal(foreignFirst.owned, false);
    assert.equal(api[registryKey].get(id).owner, "anonymous.fixture");
  }

  const cleanApi = {};
  const first = claimTuiSurfaceOwnership(cleanApi);
  const duplicate = claimTuiSurfaceOwnership(cleanApi);
  assert.equal(first.owned, true);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.owned, true);
  assert.equal(duplicate.duplicate, true);

  cleanApi[registryKey].set(TUI_IDENTITIES.route, { owner: "anonymous.fixture", fingerprint: "foreign" });
  const foreignAfter = claimTuiSurfaceOwnership(cleanApi);
  assert.equal(foreignAfter.owned, false);
  assert.equal(cleanApi[registryKey].get(TUI_IDENTITIES.route).owner, "anonymous.fixture");
});

test("KV migration is raw-valued, bounded, replay-safe, and never clobbers unrecognized canonical values", () => {
  const legacy = TUI_LEGACY_KV_KEYS.firstUse;
  const canonical = TUI_KV_KEYS.firstUse;
  const raw = memoryKv([[legacy, true]]);
  const kv = createOwnedKv(raw);
  // Legacy value migrates once to the canonical key as a RAW value (no envelope),
  // so an older TUI/server peer reading the canonical key sees the plain value.
  assert.equal(kv.get(canonical, false), true);
  assert.equal(raw.writes.length, 1);
  assert.equal(raw.writes[0][0], canonical);
  assert.equal(raw.writes[0][1], true);
  assert.equal(kv.get(canonical, false), true);
  assert.equal(raw.writes.length, 1, "canonical replay does not rewrite migration");
  assert.equal(raw.values.get(legacy), true, "legacy data remains readable by an old TUI");

  // Corrupt/oversized legacy values are not migrated.
  const corrupt = memoryKv([[TUI_LEGACY_KV_KEYS.dismissed, ["x".repeat(70_000)]]]);
  const corruptKv = createOwnedKv(corrupt);
  assert.deepEqual(corruptKv.get(TUI_KV_KEYS.dismissed, []), []);
  assert.equal(corrupt.values.has(TUI_KV_KEYS.dismissed), false);

  // A foreign value at the canonical key that does not satisfy our validator is
  // left untouched (never clobbered). The canonical key is package-qualified, so a
  // valid value there is accepted as our own namespace.
  const foreign = memoryKv([[canonical, "not-a-boolean"]]);
  const foreignKv = createOwnedKv(foreign);
  assert.equal(foreignKv.get(canonical, false), false);
  assert.equal(foreignKv.set(canonical, true), false);
  assert.equal(foreign.values.get(canonical), "not-a-boolean");
  assert.equal(foreign.writes.length, 0);
});

test("historical hidden session IDs remain bounded to cleanup and owner validation", async (t) => {
  assert.deepEqual(HISTORICAL_SELF_EVOLVE_AGENTS, {
    analyzer: "self-evolve-analyzer",
    synthesizer: "self-evolve-synthesizer",
    critic: "self-evolve-critic",
  });
  const sessions = [
    { id: "canonical", agent: SELF_EVOLVE_SYNTHESIZER_AGENT, state: "running" },
    { id: "historical-analyzer", agent: HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT, state: "running" },
    { id: "legacy", agent: HISTORICAL_SELF_EVOLVE_AGENTS.critic, state: "running" },
    { id: "foreign", agent: "anonymous-agent", state: "running" },
  ];
  const outcomes = await recoverOrphanedHiddenSessions({ session: { list: async () => ({ data: sessions }) } }, "/workspace", {
    store: { hostOwnerStatus: () => ({ classification: "unknown", reason: "fixture" }) },
    projectFingerprint: PROJECT,
    rootIdentity: "b".repeat(64),
  });
  assert.deepEqual(outcomes.map((item) => item.id), ["canonical", "historical-analyzer", "legacy"]);

  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-identity-"));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => 100 });
  t.after(() => {
    try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const [index, agent] of [SELF_EVOLVE_CRITIC_AGENT, HISTORICAL_SELF_EVOLVE_AGENTS.synthesizer].entries()) {
    const acquired = store.acquireHostOwner(`session-${index}`, {
      agent,
      projectFingerprint: PROJECT,
      rootIdentity: store.rootIdentity,
      generation: 1,
      pid: process.pid,
    });
    assert.equal(acquired.ok, true);
  }
  assert.equal(store.acquireHostOwner("foreign", {
    agent: "anonymous-agent",
    projectFingerprint: PROJECT,
    rootIdentity: store.rootIdentity,
    generation: 1,
  }).ok, false);
});
