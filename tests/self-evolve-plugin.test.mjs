import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  SELF_EVOLVE_SOURCE,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
} from "../self-evolve-core.js";
import { publishTuiHostHealth } from "../self-evolve-bridge.js";
import DefaultSelfEvolvePlugin from "../self-evolve.js";
import * as inventoryModule from "../self-evolve-inventory.js";
import { makeApprovedGlobalRoot, makeGlobalRootPolicy, makeGlobalSettings } from "../self-evolve-schemas.js";
import { stateRootIdentity } from "../self-evolve-state-root.js";
import { openStore, projectFingerprintFor } from "../self-evolve-store.js";

const SelfEvolvePlugin = DefaultSelfEvolvePlugin;

test("durable inventory uses explicit global root policy and never project roots or folder suggestions", (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-runtime-inventory-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const globalRoot = path.join(projectRoot, "global-skills");
  const suggestedRoot = path.join(projectRoot, "suggested-skills");
  const repoRoot = path.join(projectRoot, ".opencode", "skills");
  for (const [root, name] of [[globalRoot, "global-review"], [suggestedRoot, "suggested-review"], [repoRoot, "repo-review"]]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Reviews exact durable inventory roots safely.\n---\n# Guidance\n`);
  }
  const approvedRoot = makeApprovedGlobalRoot({ canonicalPath: globalRoot, canUpdate: true, canCreate: true });
  const globalRootPolicy = makeGlobalRootPolicy({
    roots: [approvedRoot],
    creationRootId: approvedRoot.rootId,
    selectedBy: "operator",
    updatedAt: 100,
  });
  const loaded = SelfEvolvePlugin.__test.durableInventory(inventoryModule, {
    global: { allowedSkillRoots: [suggestedRoot, repoRoot], globalRootPolicy },
  }, projectRoot);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.blockers));
  assert.deepEqual(loaded.canonicalRoots, [globalRoot]);
  assert.deepEqual(loaded.records.map((record) => record.logicalName), ["global-review"]);
  assert.equal(loaded.records.some((record) => record.canonicalRoot === repoRoot), false);
  assert.equal(loaded.records.some((record) => record.canonicalRoot === suggestedRoot), false);

  const suggestionsOnly = SelfEvolvePlugin.__test.durableInventory(inventoryModule, {
    global: { allowedSkillRoots: [globalRoot], globalRootPolicy: null },
  }, projectRoot);
  assert.equal(suggestionsOnly.ok, false);
  assert.equal(suggestionsOnly.blockers[0].code, "global-root-policy-required");
  assert.deepEqual(suggestionsOnly.canonicalRoots, []);
});

test("public trigger guidance defines the stable v0.4 event-hook boundary", () => {
  const guidance = fs.readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
  assert.match(guidance, /durable v0\.4 always exposes exactly one lifecycle `event` hook, including Automatic recommendations Off and preboot validation\./u);
  assert.match(guidance, /Before validated boot, while Off, without the three required data permissions, or under an operational suppressor, return before source-lineage hydration, session\/message reads, provider calls, durable observation, contribution, or scheduler admission\./u);
  assert.match(guidance, /No legacy analyzer registry:/u);
});

function createMockContext() {
  return { ctx: { directory: "/workspace/project", client: {} } };
}

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForDurableStartup(hooks, sessionID = "startup") {
  const output = { parts: [] };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID, arguments: "status" }, output);
    if (!/startup-validation-pending/u.test(output.parts.at(-1).text)) return output.parts.at(-1).text;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for deferred durable startup");
}

test("config hook collision-safely registers only current hidden deny-tool provider agents", async (t) => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx);
  t.after(async () => hooks.dispose());
  const cfg = { model: "openai/gpt-5.5", agent: {} };
  await hooks.config(cfg);
  const expectedPermissions = [...SelfEvolvePlugin.__test.HIDDEN_AGENT_PERMISSION_NAMES].sort();
  for (const agentName of [SELF_EVOLVE_SYNTHESIZER_AGENT, SELF_EVOLVE_CRITIC_AGENT]) {
    const agent = cfg.agent[agentName];
    assert.equal(agent.hidden, true);
    assert.equal(agent.mode, "primary");
    assert.equal(agent.model, "openai/gpt-5.5");
    assert.equal(agent.temperature, 0);
    assert.equal(agent.steps, 1);
    assert.deepEqual(Object.keys(agent.permission).sort(), expectedPermissions);
    assert.equal(agent.permission.edit, "deny");
    assert.equal(agent.permission.bash, "deny");
    assert.equal(agent.permission.todowrite, "deny");
  }
  assert.equal(cfg.agent[HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT], undefined);
});

test("chat.params caps only canonical package-owned session and agent claims", async (t) => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx);
  t.after(async () => hooks.dispose());
  const cfg = { model: "openai/gpt-5.5", agent: {} };
  await hooks.config(cfg);
  const registrations = SelfEvolvePlugin.__test.registerHiddenAgents(cfg);
  const guard = SelfEvolvePlugin.__test.createHiddenAgentRegistration(() => registrations, () => cfg);
  const nonce = guard.claimSession(SELF_EVOLVE_SYNTHESIZER_AGENT, "owned-synthesis", 1234);

  for (const input of [
    { sessionID: "user-session", agent: "build" },
    { sessionID: "owned-synthesis", agent: "build" },
    { sessionID: "user-session", agent: SELF_EVOLVE_SYNTHESIZER_AGENT },
    { sessionID: "owned-synthesis", agent: SELF_EVOLVE_CRITIC_AGENT },
    { sessionID: "owned-synthesis", agent: HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT },
  ]) {
    const output = { maxOutputTokens: 9000 };
    guard.capChatParams(input, output);
    assert.equal(output.maxOutputTokens, 9000);
  }

  const uncapped = { maxOutputTokens: undefined };
  guard.capChatParams({ sessionID: "owned-synthesis", agent: SELF_EVOLVE_SYNTHESIZER_AGENT }, uncapped);
  assert.equal(uncapped.maxOutputTokens, 1234);
  const lower = { maxOutputTokens: 512 };
  guard.capChatParams({ sessionID: "owned-synthesis", agent: SELF_EVOLVE_SYNTHESIZER_AGENT }, lower);
  assert.equal(lower.maxOutputTokens, 512);

  guard.releaseSession(SELF_EVOLVE_SYNTHESIZER_AGENT, "owned-synthesis", nonce);
  const released = { maxOutputTokens: undefined };
  guard.capChatParams({ sessionID: "owned-synthesis", agent: SELF_EVOLVE_SYNTHESIZER_AGENT }, released);
  assert.equal(released.maxOutputTokens, undefined);
});

test("plugin chat.params hook leaves unclaimed user sessions unchanged", async (t) => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx);
  t.after(async () => hooks.dispose());
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });
  const output = { maxOutputTokens: 777 };
  await hooks["chat.params"]({ sessionID: "working-session", agent: "build" }, output);
  assert.equal(output.maxOutputTokens, 777);
});

test("durable state root precedence prefers explicit, synchronous host, then SDK over environment", async () => {
  const calls = [];
  const ctx = {
    directory: "/workspace/project",
    client: {
      path: {
        get: async (input) => {
          calls.push(input);
          return { data: { state: "/runtime/state" } };
        },
      },
    },
  };

  assert.equal(await SelfEvolvePlugin.__test.resolveStateRoot(ctx, { env: { XDG_STATE_HOME: "/environment" } }), "/runtime/state");
  assert.deepEqual(calls, [{ query: { directory: "/workspace/project" } }]);

  assert.equal(await SelfEvolvePlugin.__test.resolveStateRoot(ctx, { stateRoot: "/explicit/state" }), "/explicit/state");
  assert.equal(calls.length, 1, "an explicit stateRoot must not call the SDK path endpoint");

  ctx.path = { state: "/host/state" };
  assert.equal(await SelfEvolvePlugin.__test.resolveStateRoot(ctx, { env: { XDG_STATE_HOME: "/environment" } }), "/host/state");
  assert.equal(calls.length, 1, "a synchronous official host root must not call the SDK path endpoint");
});

test("durable state path SDK calls are bounded and unavailable APIs do not authorize environment fallback", async () => {
  const ctx = { directory: "/workspace/project", client: { path: { get: async () => new Promise(() => {}) } } };
  const started = Date.now();
  assert.equal(await SelfEvolvePlugin.__test.resolveStateRoot(ctx, { env: { XDG_STATE_HOME: "/environment" }, stateRootTimeoutMs: 10 }), null);
  assert.ok(Date.now() - started < 500);
});

test("the provisional legacy mode reader is absent from the v0.4 entry", () => {
  assert.equal(DefaultSelfEvolvePlugin.__test.provisionalStartupMode, undefined);
});

test("provisional standard root validates after startup before durable initialization", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-root-match-"));
  const stateRoot = path.join(root, "state", "opencode");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  let sdkCalls = 0;
  const ctx = {
    directory: worktree,
    worktree,
    client: { global: { health: async () => ({ data: { healthy: true, version: "1.18.4" } }) }, path: { get: async () => { sdkCalls += 1; return { data: { state: stateRoot } }; } }, session: {} },
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hooks = await DefaultSelfEvolvePlugin(ctx, { env: { XDG_STATE_HOME: path.join(root, "state") }, stateRootTimeoutMs: 50 });
  assert.equal(fs.existsSync(path.join(stateRoot, "self-evolve")), false, "provisional startup must not initialize state");
  const deadline = Date.now() + 1_000;
  while (!fs.existsSync(path.join(stateRoot, "self-evolve", "global", "settings.json")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "matched-root", arguments: "status" }, output);
  assert.equal(sdkCalls, 1);
  assert.match(output.parts.at(-1).text, /Automatic recommendations: On/u);
  assert.equal(fs.existsSync(path.join(stateRoot, "self-evolve", "global", "settings.json")), true);
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "matched-root", arguments: "health" }, output);
  assert.match(output.parts.at(-1).text, /host 1\.18\.4/u, "deferred boot must retain the version resolved before provisional root selection");
  await hooks.dispose();
});

test("a later factory instance cannot replace a pending instance state-root plan", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-root-instance-"));
  const firstRoot = path.join(root, "first-state", "opencode");
  const secondRoot = path.join(root, "second-state");
  const firstWorktree = path.join(root, "first-worktree");
  const secondWorktree = path.join(root, "second-worktree");
  fs.mkdirSync(firstWorktree, { recursive: true });
  fs.mkdirSync(secondWorktree, { recursive: true });
  const firstCtx = {
    directory: firstWorktree,
    worktree: firstWorktree,
    client: { global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) }, path: { get: async () => ({ data: { state: firstRoot } }) }, session: {} },
  };
  const secondCtx = { directory: secondWorktree, worktree: secondWorktree, path: { state: secondRoot }, client: { global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) }, session: {} } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await DefaultSelfEvolvePlugin(firstCtx, { env: { XDG_STATE_HOME: path.join(root, "first-state") }, hostRecoveryDelayMs: 20 });
  const second = await DefaultSelfEvolvePlugin(secondCtx, { stateRoot: secondRoot });
  const deadline = Date.now() + 1_000;
  while (!fs.existsSync(path.join(firstRoot, "self-evolve", "global", "settings.json")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(path.join(firstRoot, "self-evolve", "global", "settings.json")), true);
  assert.equal(fs.existsSync(path.join(secondRoot, "self-evolve", "global", "settings.json")), true);
  await first.dispose();
  await second.dispose();
});

test("post-start official root mismatch suspends a provisionally auto runtime without writes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-root-mismatch-"));
  const provisionalRoot = path.join(root, "environment", "opencode");
  const officialRoot = path.join(root, "official");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  const fingerprint = projectFingerprintFor("", worktree);
  const seeded = openStore(provisionalRoot, { projectFingerprint: fingerprint });
  const settings = seeded.getSettings();
  seeded.setGlobalSettings(makeGlobalSettings({ ...settings.global, mode: "auto", updatedAt: settings.global.updatedAt + 1 }));
  seeded.close();
  const before = fs.readFileSync(path.join(provisionalRoot, "self-evolve", "global", "settings.json"), "utf8");
  let sdkCalls = 0;
  const ctx = {
    directory: worktree,
    worktree,
    client: { global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) }, path: { get: async () => { sdkCalls += 1; return { data: { state: officialRoot } }; } }, session: {} },
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hooks = await DefaultSelfEvolvePlugin(ctx, { env: { XDG_STATE_HOME: path.join(root, "environment") }, stateRootTimeoutMs: 50 });
  assert.equal(typeof hooks.event, "function", "read-only persisted mode selection must be preserved");
  await hooks.event({ type: "session.idle", properties: { sessionID: "mismatch" } });
  const statusText = await waitForDurableStartup(hooks, "mismatch");
  assert.equal(sdkCalls, 1, "the prior environment-first probe must call the official SDK");
  assert.match(statusText, /state-root-validation-mismatch/u);
  assert.match(statusText, /explicit stateRoot and restart OpenCode/u);
  assert.equal(fs.existsSync(officialRoot), false);
  assert.equal(fs.readFileSync(path.join(provisionalRoot, "self-evolve", "global", "settings.json"), "utf8"), before);
  await hooks.dispose();
});

test("post-start unavailable SDK fails closed and disposal resolves pending provisional startup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-root-timeout-"));
  const stateRoot = path.join(root, "state", "opencode");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  const ctx = { directory: worktree, worktree, client: { global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) }, path: { get: async () => new Promise(() => {}) }, session: {} } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hooks = await DefaultSelfEvolvePlugin(ctx, { env: { XDG_STATE_HOME: path.join(root, "state") }, stateRootTimeoutMs: 10, stateRootValidationRetries: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "timeout", arguments: "health" }, output);
  assert.match(output.parts.at(-1).text, /official-state-path-timeout/u);
  assert.equal(fs.existsSync(stateRoot), false);
  await hooks.dispose();

  const cleanupHooks = await DefaultSelfEvolvePlugin(ctx, { env: { XDG_STATE_HOME: path.join(root, "state") }, hostRecoveryDelayMs: 100 });
  await cleanupHooks.dispose();
  assert.equal(fs.existsSync(stateRoot), false);
});

test("durable commands fail closed instead of falling through to the legacy parser", async () => {
  const ctx = {
    directory: "/workspace/project",
    client: {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) },
      path: { get: async () => ({ data: {} }) },
      session: {
        messages: async () => {
          assert.fail("legacy analyzer must not run when durable initialization is unavailable");
        },
      },
    },
  };
  const hooks = await DefaultSelfEvolvePlugin(ctx, { mode: "auto", env: {} });
  const output = { parts: [] };

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "durable-unavailable", arguments: "status" }, output);

  assert.match(output.parts.at(-1).text, /durable integration unavailable/i);
  assert.doesNotMatch(output.parts.at(-1).text, /Unknown \/self-evolve command/i);
  await hooks.dispose();
});

function durableFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-plugin-durable-"));
  const stateRoot = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  const ctx = {
    directory: worktree,
    worktree,
    path: { state: stateRoot },
    client: {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) },
      path: { get: async () => ({ data: { state: stateRoot, worktree } }) },
      session: {},
    },
  };
  const projectFingerprint = projectFingerprintFor("", worktree);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateRoot, worktree, ctx, projectFingerprint };
}

const hostCompatibilityCases = [
  { name: "minimum supported 1.18.3", response: { data: { healthy: true, version: "1.18.3" } }, supported: true },
  { name: "stable build metadata", response: { data: { healthy: true, version: "1.18.3+orca.1" } }, supported: true },
  { name: "current supported patch", response: { data: { healthy: true, version: "1.18.4" } }, supported: true },
  { name: "newer unsupported minor", response: { data: { healthy: true, version: "1.19.0" } }, version: "1.19.0", reason: "host-version-unsupported" },
  { name: "older 1.18.2", response: { data: { healthy: true, version: "1.18.2" } }, version: "1.18.2", reason: "host-version-unsupported" },
  { name: "legacy 1.17.7", response: { data: { healthy: true, version: "1.17.7" } }, version: "1.17.7", reason: "host-version-unsupported" },
  { name: "malformed version", response: { data: { healthy: true, version: "not-semver" } }, version: "not-semver", reason: "host-version-malformed" },
  { name: "unsafe numeric version", response: { data: { healthy: true, version: "1.999999999999999999999.0" } }, version: "1.999999999999999999999.0", reason: "host-version-malformed" },
  { name: "unhealthy host", response: { data: { healthy: false, version: "1.18.3" } }, version: "1.18.3", reason: "host-health-unhealthy" },
  { name: "prerelease host", response: { data: { healthy: true, version: "1.19.0-beta.1" } }, version: "1.19.0-beta.1", reason: "host-version-prerelease-unsupported" },
  { name: "2.0 host", response: { data: { healthy: true, version: "2.0.0" } }, version: "2.0.0", reason: "host-version-unsupported" },
];

for (const hostCase of hostCompatibilityCases) {
  test(`actual global health gates persisted-auto startup: ${hostCase.name}`, async (t) => {
    const f = durableFixture(t);
    const seeded = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
    const settings = seeded.getSettings();
    seeded.setGlobalSettings(makeGlobalSettings({ ...settings.global, mode: "auto", updatedAt: settings.global.updatedAt + 1 }));
    seeded.close();
    f.ctx.client.global.health = async () => hostCase.response;

    const hooks = await DefaultSelfEvolvePlugin(f.ctx, { hostVersion: "1.99.0", hostSupported: true });
    assert.equal(typeof hooks.event, "function", "persisted auto may expose only an inert provisional hook while validation is pending");
    await waitForDurableStartup(hooks, `startup-${hostCase.name}`);
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: `health-${hostCase.name}`, arguments: "health" }, output);
    if (hostCase.supported) {
      assert.ok(output.parts.at(-1).text.includes(`host ${hostCase.response.data.version}`));
      assert.match(output.parts.at(-1).text, /source global-health/u);
    } else {
      assert.match(output.parts.at(-1).text, new RegExp(`host ${hostCase.version ?? "unknown"}`));
      assert.match(output.parts.at(-1).text, new RegExp(hostCase.reason));
    }
    await hooks.dispose();
  });
}

test("unavailable and timed-out global health fail persisted-auto startup closed", async (t) => {
  for (const [name, health, reason] of [
    ["unavailable", async () => { throw new Error("connection refused"); }, "host-health-unavailable"],
    ["timeout", async () => new Promise(() => {}), "host-health-timeout"],
  ]) {
    const f = durableFixture(t);
    const seeded = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
    const settings = seeded.getSettings();
    seeded.setGlobalSettings(makeGlobalSettings({ ...settings.global, mode: "auto", updatedAt: settings.global.updatedAt + 1 }));
    seeded.close();
    let healthCalls = 0;
    f.ctx.client.global.health = async () => {
      healthCalls += 1;
      return await health();
    };
    const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
      __testHostHealthTimeoutMs: 10,
      __testHostHealthRetryWindowMs: 30,
      __testHostHealthRetryDelayMs: 1,
      hostVersion: "1.99.0",
      hostSupported: true,
    });
    assert.equal(typeof hooks.event, "function", `${name} may retain only the persisted-auto provisional hook`);
    await waitForDurableStartup(hooks, `startup-${name}`);
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: `health-${name}`, arguments: "health" }, output);
    assert.match(output.parts.at(-1).text, /host unknown/u);
    assert.match(output.parts.at(-1).text, new RegExp(reason));
    if (name === "timeout") assert.equal(healthCalls, 1, "an uncancellable timed-out SDK request must not overlap a retry");
    else assert.ok(healthCalls > 1, "transient rejected SDK requests should retry within the bounded window");
    await hooks.dispose();
  }
});

test("transient startup health failure retries until the official host becomes available", async (t) => {
  const f = durableFixture(t);
  let healthCalls = 0;
  f.ctx.client.global.health = async () => {
    healthCalls += 1;
    if (healthCalls === 1) throw new Error("connection refused during host startup");
    return { data: { healthy: true, version: "1.18.3" } };
  };

  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthTimeoutMs: 20,
    __testHostHealthRetryWindowMs: 100,
    __testHostHealthRetryDelayMs: 1,
  });
  t.after(async () => {
    try { await hooks.dispose(); } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  await waitForDurableStartup(hooks, "startup-transient-health");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "health-transient", arguments: "health" }, output);

  assert.equal(healthCalls, 2);
  assert.match(output.parts.at(-1).text, /host 1\.18\.3/u);
});

test("a command recovers durable startup after the TUI host becomes reachable late", async (t) => {
  const f = durableFixture(t);
  let hostReady = false;
  let healthCalls = 0;
  f.ctx.client.global.health = async () => {
    healthCalls += 1;
    if (!hostReady) {
      const error = new Error("embedded TUI host is not listening yet");
      error.code = "ECONNREFUSED";
      throw error;
    }
    return { data: { healthy: true, version: "1.18.3" } };
  };

  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthRetryWindowMs: 30,
    __testHostHealthRetryDelayMs: 1,
  });
  t.after(async () => {
    try { await hooks.dispose(); } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const startupCalls = healthCalls;
  assert.ok(startupCalls > 0);

  hostReady = true;
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "late-tui-host", arguments: "health" }, output);

  assert.ok(healthCalls > startupCalls, "the post-start command must re-check official health");
  assert.match(output.parts.at(-1).text, /host 1\.18\.3/u);
});

test("late command recovery remains fail-closed while official health is unavailable", async (t) => {
  const f = durableFixture(t);
  let healthCalls = 0;
  f.ctx.client.global.health = async () => {
    healthCalls += 1;
    const error = new Error("embedded TUI host remains unavailable");
    error.code = "ECONNREFUSED";
    throw error;
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthRetryWindowMs: 20,
    __testHostHealthRetryDelayMs: 1,
  });
  t.after(async () => {
    try { await hooks.dispose(); } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "late-tui-unavailable", arguments: "health" }, output);
  assert.match(output.parts.at(-1).text, /host-health-unavailable/u);
  assert.match(output.parts.at(-1).text, /Automatic recommendations are operationally unavailable/u);
  const callsAfterLateAttempt = healthCalls;
  const repeated = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "late-tui-unavailable-repeat", arguments: "health" }, repeated);
  assert.equal(healthCalls, callsAfterLateAttempt, "only the first post-start command may run late recovery");

  const store = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(store.getAutomationState().enabled, true);
  store.close();
});

test("same-context factory hooks share one late durable recovery runtime", async (t) => {
  const f = durableFixture(t);
  let hostReady = false;
  let factoryCalls = 0;
  let recoveryCalls = 0;
  let shutdownCalls = 0;
  f.ctx.client.global.health = async () => {
    if (!hostReady) {
      const error = new Error("embedded TUI host is not ready");
      error.code = "ECONNREFUSED";
      throw error;
    }
    return { data: { healthy: true, version: "1.18.3" } };
  };
  const integration = {
    async boot() { return { ok: true }; },
    async handleCommand() { return { responseText: "shared durable recovery" }; },
    async recoverHostSessions() { recoveryCalls += 1; },
    async shutdown() { shutdownCalls += 1; },
  };
  const options = {
    __testHostHealthRetryWindowMs: 20,
    __testHostHealthRetryDelayMs: 1,
    pipelineFactory: async () => {
      factoryCalls += 1;
      return integration;
    },
  };
  const first = await DefaultSelfEvolvePlugin(f.ctx, options);
  const second = await DefaultSelfEvolvePlugin(f.ctx, options);
  t.after(async () => {
    await first.dispose();
    await second.dispose();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  hostReady = true;
  const firstOutput = { parts: [] };
  const secondOutput = { parts: [] };
  await Promise.all([
    first["command.execute.before"]({ command: "self-evolve", sessionID: "shared-first", arguments: "status" }, firstOutput),
    second["command.execute.before"]({ command: "self-evolve", sessionID: "shared-second", arguments: "status" }, secondOutput),
  ]);

  assert.equal(factoryCalls, 1, "double-instantiated hooks must not create duplicate durable integrations");
  assert.match(firstOutput.parts.at(-1).text, /shared durable recovery/u);
  assert.match(secondOutput.parts.at(-1).text, /shared durable recovery/u);
  assert.equal(recoveryCalls, 1);
  await first.dispose();
  assert.equal(shutdownCalls, 0, "the shared runtime must remain live for the second factory instance");
  await second.dispose();
  assert.equal(shutdownCalls, 1, "the final factory disposal must close the shared runtime exactly once");
});

test("disposing the initiating factory does not abort shared late recovery for a surviving factory", async (t) => {
  const f = durableFixture(t);
  let latePhase = false;
  let resolveLateHealth;
  let markLateHealthStarted;
  const lateHealthStarted = new Promise((resolve) => { markLateHealthStarted = resolve; });
  f.ctx.client.global.health = async () => {
    if (!latePhase) {
      const error = new Error("embedded TUI host is not ready");
      error.code = "ECONNREFUSED";
      throw error;
    }
    markLateHealthStarted();
    return await new Promise((resolve) => { resolveLateHealth = resolve; });
  };
  let factoryCalls = 0;
  let shutdownCalls = 0;
  const options = {
    __testHostHealthRetryWindowMs: 0,
    __testHostHealthTimeoutMs: 1_000,
    pipelineFactory: async () => {
      factoryCalls += 1;
      return {
        async boot() { return { ok: true }; },
        async handleCommand() { return { responseText: "surviving shared runtime" }; },
        async shutdown() { shutdownCalls += 1; },
      };
    },
  };
  const first = await DefaultSelfEvolvePlugin(f.ctx, options);
  const second = await DefaultSelfEvolvePlugin(f.ctx, options);
  t.after(async () => {
    await first.dispose();
    await second.dispose();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  latePhase = true;
  const firstOutput = { parts: [] };
  const firstCommand = first["command.execute.before"]({ command: "self-evolve", sessionID: "disposing-initiator", arguments: "status" }, firstOutput);
  await lateHealthStarted;
  const firstDispose = first.dispose();
  resolveLateHealth({ data: { healthy: true, version: "1.18.3" } });
  await Promise.all([firstCommand, firstDispose]);

  const secondOutput = { parts: [] };
  await second["command.execute.before"]({ command: "self-evolve", sessionID: "surviving-factory", arguments: "status" }, secondOutput);
  assert.equal(factoryCalls, 1);
  assert.match(secondOutput.parts.at(-1).text, /surviving shared runtime/u);
  assert.equal(shutdownCalls, 0, "the shared runtime must stay live for the surviving factory");
  await second.dispose();
  assert.equal(shutdownCalls, 1);
});

test("same-context initial boot and duplicate command delivery use one shared runtime", async (t) => {
  const f = durableFixture(t);
  let factoryCalls = 0;
  let commandCalls = 0;
  let shutdownCalls = 0;
  const integration = {
    async boot() { return { ok: true }; },
    async handleCommand() {
      commandCalls += 1;
      return { responseText: "one shared command" };
    },
    async shutdown() { shutdownCalls += 1; },
  };
  const options = {
    pipelineFactory: async () => {
      factoryCalls += 1;
      return integration;
    },
  };
  const first = await DefaultSelfEvolvePlugin(f.ctx, options);
  const second = await DefaultSelfEvolvePlugin(f.ctx, options);
  t.after(async () => {
    await first.dispose();
    await second.dispose();
  });
  await Promise.all([
    waitForDurableStartup(first, "shared-initial-first"),
    waitForDurableStartup(second, "shared-initial-second"),
  ]);
  assert.equal(factoryCalls, 1, "initial startup must be coordinated across factory instances");
  commandCalls = 0;

  const input = { command: "self-evolve", sessionID: "same-logical-command", arguments: "status" };
  const firstOutput = { parts: [] };
  const secondOutput = { parts: [] };
  await Promise.all([
    first["command.execute.before"](input, firstOutput),
    second["command.execute.before"](input, secondOutput),
  ]);
  assert.equal(commandCalls, 1, "the same command hook delivery must reach the integration once");
  assert.match(firstOutput.parts.at(-1).text, /one shared command/u);
  assert.match(secondOutput.parts.at(-1).text, /one shared command/u);

  await first.dispose();
  await second.dispose();
  assert.equal(shutdownCalls, 1);
});

test("durable coordination isolates different official host origins", async (t) => {
  const f = durableFixture(t);
  const makeContext = (port) => ({
    ...f.ctx,
    serverUrl: new URL(`http://127.0.0.1:${port}/`),
    client: {
      ...f.ctx.client,
      global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) },
    },
  });
  let firstFactories = 0;
  let secondFactories = 0;
  const first = await DefaultSelfEvolvePlugin(makeContext(43101), {
    pipelineFactory: async () => {
      firstFactories += 1;
      return { async boot() { return { ok: true }; }, async handleCommand() { return { responseText: "host A" }; }, async shutdown() {} };
    },
  });
  const second = await DefaultSelfEvolvePlugin(makeContext(43102), {
    pipelineFactory: async () => {
      secondFactories += 1;
      return { async boot() { return { ok: true }; }, async handleCommand() { return { responseText: "host B" }; }, async shutdown() {} };
    },
  });
  t.after(async () => {
    await first.dispose();
    await second.dispose();
  });
  await Promise.all([
    waitForDurableStartup(first, "different-host-a"),
    waitForDurableStartup(second, "different-host-b"),
  ]);
  const firstOutput = { parts: [] };
  const secondOutput = { parts: [] };
  await first["command.execute.before"]({ command: "self-evolve", sessionID: "host-a", arguments: "status" }, firstOutput);
  await second["command.execute.before"]({ command: "self-evolve", sessionID: "host-b", arguments: "status" }, secondOutput);

  assert.equal(firstFactories, 1);
  assert.equal(secondFactories, 1);
  assert.match(firstOutput.parts.at(-1).text, /host A/u);
  assert.match(secondOutput.parts.at(-1).text, /host B/u);
});

test("durable coordination does not share across authority-narrowing options", async (t) => {
  const f = durableFixture(t);
  let unrestrictedFactories = 0;
  let excludedFactories = 0;
  const unrestricted = await DefaultSelfEvolvePlugin(f.ctx, {
    pipelineFactory: async () => {
      unrestrictedFactories += 1;
      return { async boot() { return { ok: true }; }, async handleCommand() { return { responseText: "unrestricted runtime" }; }, async shutdown() {} };
    },
  });
  const excluded = await DefaultSelfEvolvePlugin(f.ctx, {
    processExcluded: true,
    pipelineFactory: async () => {
      excludedFactories += 1;
      return { async boot() { return { ok: true }; }, async handleCommand() { return { responseText: "excluded runtime" }; }, async shutdown() {} };
    },
  });
  t.after(async () => {
    await unrestricted.dispose();
    await excluded.dispose();
  });
  await Promise.all([
    waitForDurableStartup(unrestricted, "unrestricted-runtime"),
    waitForDurableStartup(excluded, "excluded-runtime"),
  ]);
  const unrestrictedOutput = { parts: [] };
  const excludedOutput = { parts: [] };
  await unrestricted["command.execute.before"]({ command: "self-evolve", sessionID: "unrestricted", arguments: "status" }, unrestrictedOutput);
  await excluded["command.execute.before"]({ command: "self-evolve", sessionID: "excluded", arguments: "status" }, excludedOutput);

  assert.equal(unrestrictedFactories, 1);
  assert.equal(excludedFactories, 1);
  assert.match(unrestrictedOutput.parts.at(-1).text, /unrestricted runtime/u);
  assert.match(excludedOutput.parts.at(-1).text, /excluded runtime/u);
});

test("duplicate passive event delivery reaches a shared integration once", async (t) => {
  const f = durableFixture(t);
  const seeded = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  const settings = seeded.getSettings();
  seeded.setGlobalSettings(makeGlobalSettings({ ...settings.global, mode: "auto", updatedAt: settings.global.updatedAt + 1 }));
  seeded.close();
  let eventCalls = 0;
  const integration = {
    async boot() { return { ok: true }; },
    async handleEvent() { eventCalls += 1; },
    async shutdown() {},
  };
  const options = { pipelineFactory: async () => integration };
  const first = await DefaultSelfEvolvePlugin(f.ctx, options);
  const second = await DefaultSelfEvolvePlugin(f.ctx, options);
  t.after(async () => {
    await first.dispose();
    await second.dispose();
  });
  await Promise.all([
    waitForDurableStartup(first, "shared-event-first"),
    waitForDurableStartup(second, "shared-event-second"),
  ]);
  assert.equal(typeof first.event, "function");
  assert.equal(typeof second.event, "function");
  const deltaVariants = ["text", "reasoning", "tool"].flatMap((field) =>
    Array.from({ length: 1_000 }, (_, index) => ({
      type: "message.part.delta",
      properties: { sessionID: `delta-${index % 4}`, field, delta: `${field}-${index}` },
    })));
  for (const delta of deltaVariants) {
    await Promise.all([first.event(delta), second.event({ event: delta })]);
  }
  assert.equal(eventCalls, 0);
  const event = { type: "session.idle", properties: { sessionID: "same-event" } };
  await Promise.all([first.event(event), second.event(event)]);
  assert.equal(eventCalls, 1);
});

test("a new factory waits for final shared-runtime shutdown before joining", async (t) => {
  const f = durableFixture(t);
  let factoryCalls = 0;
  let releaseFirstShutdown;
  let firstShutdownStarted = false;
  const firstShutdownGate = new Promise((resolve) => { releaseFirstShutdown = resolve; });
  const options = {
    pipelineFactory: async () => {
      factoryCalls += 1;
      const ordinal = factoryCalls;
      return {
        async boot() { return { ok: true }; },
        async handleCommand() { return { responseText: `runtime ${ordinal}` }; },
        async shutdown() {
          if (ordinal === 1) {
            firstShutdownStarted = true;
            return { ok: false, reason: "autonomous-work-draining", completion: firstShutdownGate.then(() => ({ ok: true })) };
          }
          return { ok: true };
        },
      };
    },
  };
  const first = await DefaultSelfEvolvePlugin(f.ctx, options);
  await waitForDurableStartup(first, "closing-race-first");
  let firstDisposeResolved = false;
  const firstDispose = first.dispose().then(() => { firstDisposeResolved = true; });
  const deadline = Date.now() + 500;
  while (!firstShutdownStarted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(firstShutdownStarted, true);

  let secondResolved = false;
  const secondPromise = DefaultSelfEvolvePlugin(f.ctx, options).then((hooks) => {
    secondResolved = true;
    return hooks;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(firstDisposeResolved, true, "dispose returns after the bounded shutdown result while full close remains fenced");
  assert.equal(secondResolved, false, "a new factory must not adopt a runtime that is closing");
  releaseFirstShutdown();
  await firstDispose;
  const second = await secondPromise;
  t.after(async () => second.dispose());
  await waitForDurableStartup(second, "closing-race-second");
  assert.equal(factoryCalls, 2, "the post-close factory must create a fresh runtime");
  const output = { parts: [] };
  await second["command.execute.before"]({ command: "self-evolve", sessionID: "closing-race", arguments: "status" }, output);
  assert.match(output.parts.at(-1).text, /runtime 2/u);
});

test("hostSupported false narrows actual supported health and spoof options never widen it", async (t) => {
  const narrowed = durableFixture(t);
  const narrowedStore = openStore(narrowed.stateRoot, { projectFingerprint: narrowed.projectFingerprint });
  const narrowedSettings = narrowedStore.getSettings();
  narrowedStore.setGlobalSettings(makeGlobalSettings({ ...narrowedSettings.global, mode: "auto", updatedAt: narrowedSettings.global.updatedAt + 1 }));
  narrowedStore.close();
  narrowed.ctx.client.global.health = async () => ({ data: { healthy: true, version: "1.18.4" } });
  const narrowedHooks = await DefaultSelfEvolvePlugin(narrowed.ctx, { hostSupported: false });
  await waitForDurableStartup(narrowedHooks, "startup-narrowed");
  const narrowedOutput = { parts: [] };
  await narrowedHooks["command.execute.before"]({ command: "self-evolve", sessionID: "health-narrowed", arguments: "health" }, narrowedOutput);
  assert.match(narrowedOutput.parts.at(-1).text, /host 1\.18\.4/u);
  assert.match(narrowedOutput.parts.at(-1).text, /host-support-disabled-by-option/u);
  await narrowedHooks.dispose();

  const spoofed = durableFixture(t);
  spoofed.ctx.client.global.health = async () => ({ data: { healthy: true, version: "1.17.7" } });
  const spoofedHooks = await DefaultSelfEvolvePlugin(spoofed.ctx, { hostVersion: "1.99.0", hostSupported: true });
  await waitForDurableStartup(spoofedHooks, "startup-spoofed");
  assert.equal(typeof spoofedHooks.event, "function");
  const spoofedOutput = { parts: [] };
  await spoofedHooks["command.execute.before"]({ command: "self-evolve", sessionID: "health-spoofed", arguments: "health" }, spoofedOutput);
  assert.match(spoofedOutput.parts.at(-1).text, /host 1\.17\.7/u);
  assert.match(spoofedOutput.parts.at(-1).text, /host-version-unsupported/u);
  await spoofedHooks.dispose();
});

test("unsupported health is resolved before provisional persisted mode or official path validation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-host-before-root-"));
  const provisionalRoot = path.join(root, "state", "opencode");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  const fingerprint = projectFingerprintFor("", worktree);
  const seeded = openStore(provisionalRoot, { projectFingerprint: fingerprint });
  const settings = seeded.getSettings();
  seeded.setGlobalSettings(makeGlobalSettings({ ...settings.global, mode: "auto", updatedAt: settings.global.updatedAt + 1 }));
  seeded.close();
  const settingsPath = path.join(provisionalRoot, "self-evolve", "global", "settings.json");
  const before = fs.readFileSync(settingsPath, "utf8");
  let pathCalls = 0;
  const ctx = {
    directory: worktree,
    worktree,
    client: {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.2" } }) },
      path: { get: async () => { pathCalls += 1; return { data: { state: provisionalRoot } }; } },
      session: {},
    },
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hooks = await DefaultSelfEvolvePlugin(ctx, { env: { XDG_STATE_HOME: path.join(root, "state") } });
  assert.equal(typeof hooks.event, "function");
  await waitForDurableStartup(hooks, "startup-before-root");
  assert.equal(pathCalls, 0, "unsupported health must stop before provisional or official root resolution");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
  await hooks.dispose();
});

test("serverUrl fallback fetches only the official origin global-health path", async (t) => {
  const f = durableFixture(t);
  delete f.ctx.client.global;
  f.ctx.serverUrl = new URL("http://127.0.0.1:43210/");
  const calls = [];
  f.ctx.__testOnlySelfEvolveFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ healthy: true, version: "1.18.4" }) };
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx);
  const pending = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "fallback-pending", arguments: "health" }, pending);
  assert.match(pending.parts.at(-1).text, /startup-validation-pending/u);
  await waitForDurableStartup(hooks, "fallback-startup");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "fallback-health", arguments: "health" }, output);
  assert.match(output.parts.at(-1).text, /host 1\.18\.4/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:43210/global/health");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "manual");
  assert.match(output.parts.at(-1).text, /source global-health/u);
  await hooks.dispose();
});

test("a rejected generated SDK health call falls back to official serverUrl health", async (t) => {
  const f = durableFixture(t);
  f.ctx.serverUrl = new URL("http://127.0.0.1:4322/");
  f.ctx.client.global.health = async () => { throw new Error("generated SDK transport unavailable"); };
  const calls = [];
  f.ctx.__testOnlySelfEvolveFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async json() { return { healthy: true, version: "1.18.3" }; } };
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx);
  t.after(async () => {
    try { await hooks.dispose(); } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  await waitForDurableStartup(hooks, "sdk-to-server-url-fallback");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "sdk-to-fallback", arguments: "health" }, output);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:4322/global/health");
  assert.equal(calls[0].options.redirect, "manual");
  assert.match(output.parts.at(-1).text, /host 1\.18\.3/u);
});

test("fresh official TUI app-version runtime report recovers an embedded host without HTTP health", async (t) => {
  const f = durableFixture(t);
  f.ctx.serverUrl = new URL("http://127.0.0.1:4326/");
  f.ctx.client.global.health = async () => ({ error: { message: "route unavailable" }, response: { status: 404 } });
  f.ctx.__testOnlySelfEvolveFetch = async () => ({ ok: false, status: 404 });
  fs.mkdirSync(f.stateRoot, { recursive: true, mode: 0o700 });
  publishTuiHostHealth(f.stateRoot, {
    projectFingerprint: f.projectFingerprint,
    stateRootIdentity: stateRootIdentity(f.stateRoot),
    hostVersion: "1.18.3",
  });
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthRetryWindowMs: 20,
    __testHostHealthRetryDelayMs: 1,
  });
  t.after(async () => {
    try { await hooks.dispose(); } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  await waitForDurableStartup(hooks, "tui-app-version-runtime-report");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "tui-app-version", arguments: "health" }, output);

  assert.match(output.parts.at(-1).text, /host 1\.18\.3/u);
  assert.match(output.parts.at(-1).text, /source tui-app-version/u);
});

test("host-health diagnostics classify both official paths without leaking error text", async (t) => {
  const f = durableFixture(t);
  f.ctx.serverUrl = new URL("http://127.0.0.1:4323/");
  f.ctx.client.global.health = async () => {
    const error = new Error("sdk secret marker SHOULD_NOT_LEAK");
    error.code = "ECONNRESET";
    error.privateCode = "APIKEY_SUPERSECRET_123";
    throw error;
  };
  f.ctx.__testOnlySelfEvolveFetch = async () => {
    const error = new Error("fallback secret marker ALSO_SHOULD_NOT_LEAK");
    error.name = "TOKEN_PRIVATE_456";
    throw error;
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthRetryWindowMs: 20,
    __testHostHealthRetryDelayMs: 1,
  });
  t.after(async () => hooks.dispose());
  await waitForDurableStartup(hooks, "sdk-and-fallback-unavailable");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "sdk-and-fallback", arguments: "status" }, output);
  const text = output.parts.at(-1).text;

  assert.match(text, /diagnostic sdk-connection-reset-fallback-error/u);
  assert.doesNotMatch(text, /SHOULD_NOT_LEAK/u);
  assert.doesNotMatch(text, /secret marker/u);
});

test("authoritative SDK health errors neither fall back to HTTP nor accept a TUI report", async (t) => {
  const f = durableFixture(t);
  f.ctx.serverUrl = new URL("http://127.0.0.1:4327/");
  f.ctx.client.global.health = async () => ({ error: { message: "unauthorized SECRET_SHOULD_NOT_LEAK" }, response: { status: 401 } });
  let fallbackCalls = 0;
  f.ctx.__testOnlySelfEvolveFetch = async () => {
    fallbackCalls += 1;
    return { ok: true, async json() { return { healthy: true, version: "1.18.3" }; } };
  };
  fs.mkdirSync(f.stateRoot, { recursive: true, mode: 0o700 });
  publishTuiHostHealth(f.stateRoot, {
    projectFingerprint: f.projectFingerprint,
    stateRootIdentity: stateRootIdentity(f.stateRoot),
    hostVersion: "1.18.3",
  });
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthRetryWindowMs: 20,
    __testHostHealthRetryDelayMs: 1,
  });
  t.after(async () => hooks.dispose());
  await waitForDurableStartup(hooks, "authoritative-sdk-health-error");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "authoritative-sdk-health-error", arguments: "health" }, output);

  assert.equal(fallbackCalls, 0);
  assert.match(output.parts.at(-1).text, /host-health-authoritative-error/u);
  assert.doesNotMatch(output.parts.at(-1).text, /SECRET_SHOULD_NOT_LEAK/u);
});

test("a responding SDK 5xx is authoritative and cannot be replaced by HTTP or TUI health", async (t) => {
  const f = durableFixture(t);
  f.ctx.serverUrl = new URL("http://127.0.0.1:4328/");
  f.ctx.client.global.health = async () => ({ error: { message: "service unavailable" }, response: { status: 503 } });
  let fallbackCalls = 0;
  f.ctx.__testOnlySelfEvolveFetch = async () => {
    fallbackCalls += 1;
    return { ok: true, async json() { return { healthy: true, version: "1.18.3" }; } };
  };
  fs.mkdirSync(f.stateRoot, { recursive: true, mode: 0o700 });
  publishTuiHostHealth(f.stateRoot, {
    projectFingerprint: f.projectFingerprint,
    stateRootIdentity: stateRootIdentity(f.stateRoot),
    hostVersion: "1.18.3",
  });
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthRetryWindowMs: 20,
    __testHostHealthRetryDelayMs: 1,
  });
  t.after(async () => hooks.dispose());
  await waitForDurableStartup(hooks, "authoritative-sdk-5xx");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "authoritative-sdk-5xx", arguments: "health" }, output);

  assert.equal(fallbackCalls, 0);
  assert.match(output.parts.at(-1).text, /host-health-authoritative-error/u);
});

for (const fallbackCase of [
  { name: "503 response", response: { ok: false, status: 503 } },
  { name: "302 redirect response", response: { ok: false, status: 302 } },
  { name: "malformed JSON", response: { ok: true, status: 200, async json() { throw new SyntaxError("SECRET_PARSE_TEXT"); } } },
]) {
  test(`a responding HTTP fallback ${fallbackCase.name} is authoritative and blocks TUI relay`, async (t) => {
    const f = durableFixture(t);
    delete f.ctx.client.global;
    f.ctx.serverUrl = new URL("http://127.0.0.1:4329/");
    f.ctx.__testOnlySelfEvolveFetch = async (_url, init) => {
      assert.equal(init.redirect, "manual", "redirect responses must remain observable and authoritative");
      return fallbackCase.response;
    };
    fs.mkdirSync(f.stateRoot, { recursive: true, mode: 0o700 });
    publishTuiHostHealth(f.stateRoot, {
      projectFingerprint: f.projectFingerprint,
      stateRootIdentity: stateRootIdentity(f.stateRoot),
      hostVersion: "1.18.3",
    });
    const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
      __testHostHealthRetryWindowMs: 20,
      __testHostHealthRetryDelayMs: 1,
    });
    t.after(async () => hooks.dispose());
    await waitForDurableStartup(hooks, `authoritative-http-${fallbackCase.name}`);
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: `authoritative-http-${fallbackCase.name}`, arguments: "health" }, output);

    assert.match(output.parts.at(-1).text, /host-health-authoritative-error/u);
    assert.doesNotMatch(output.parts.at(-1).text, /SECRET_PARSE_TEXT/u);
    assert.equal(fs.existsSync(path.join(f.stateRoot, "self-evolve", "global", "settings.json")), false);
  });
}

test("a generated SDK health timeout cannot launch fallback after late settlement", async (t) => {
  const f = durableFixture(t);
  f.ctx.serverUrl = new URL("http://127.0.0.1:4324/");
  let rejectSdk;
  f.ctx.client.global.health = async () => await new Promise((_, reject) => { rejectSdk = reject; });
  let fallbackCalls = 0;
  f.ctx.__testOnlySelfEvolveFetch = async () => {
    fallbackCalls += 1;
    return { ok: true, async json() { return { healthy: true, version: "1.18.3" }; } };
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthTimeoutMs: 10,
    __testHostHealthRetryWindowMs: 0,
  });
  t.after(async () => hooks.dispose());
  await waitForDurableStartup(hooks, "sdk-timeout-no-late-fallback");
  assert.equal(fallbackCalls, 0);
  rejectSdk(new Error("late SDK rejection"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fallbackCalls, 0, "a timed-out SDK continuation must remain unable to launch fallback");
});

for (const fallbackCase of [
  { name: "unhealthy", body: { healthy: false, version: "1.18.3" }, reason: "host-health-unhealthy" },
  { name: "malformed", body: { healthy: true, version: "bad" }, reason: "host-version-malformed" },
]) {
  test(`serverUrl fallback fails closed for ${fallbackCase.name} health`, async (t) => {
    const f = durableFixture(t);
    delete f.ctx.client.global;
    f.ctx.serverUrl = "https://localhost:4443";
    f.ctx.__testOnlySelfEvolveFetch = async () => ({ ok: true, status: 200, json: async () => fallbackCase.body });
    const hooks = await DefaultSelfEvolvePlugin(f.ctx);
    await waitForDurableStartup(hooks, `fallback-${fallbackCase.name}`);
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: `fallback-${fallbackCase.name}`, arguments: "health" }, output);
    assert.match(output.parts.at(-1).text, new RegExp(fallbackCase.reason));
    await hooks.dispose();
  });
}

test("serverUrl fallback timeout and invalid or user-supplied URLs fail closed", async (t) => {
  const timed = durableFixture(t);
  delete timed.ctx.client.global;
  timed.ctx.serverUrl = "http://localhost:4321/";
  let timedSignal;
  timed.ctx.__testOnlySelfEvolveFetch = async (_url, options) => {
    timedSignal = options.signal;
    return await new Promise(() => {});
  };
  const timedHooks = await DefaultSelfEvolvePlugin(timed.ctx, {
    __testHostHealthTimeoutMs: 10,
    __testHostHealthRetryWindowMs: 30,
    __testHostHealthRetryDelayMs: 1,
  });
  await waitForDurableStartup(timedHooks, "fallback-timeout");
  const timedOutput = { parts: [] };
  await timedHooks["command.execute.before"]({ command: "self-evolve", sessionID: "fallback-timeout", arguments: "health" }, timedOutput);
  assert.match(timedOutput.parts.at(-1).text, /host-health-timeout/u);
  assert.equal(timedSignal?.aborted, true, "a timed-out fallback fetch must be aborted before any retry");
  await timedHooks.dispose();

  for (const serverUrl of ["file:///tmp/opencode", "http://user:pass@localhost/", "http://localhost/base", "http://localhost/?target=elsewhere"]) {
    const invalid = durableFixture(t);
    delete invalid.ctx.client.global;
    invalid.ctx.serverUrl = serverUrl;
    let fetchCalls = 0;
    invalid.ctx.__testOnlySelfEvolveFetch = async () => { fetchCalls += 1; throw new Error("must not fetch"); };
    const hooks = await DefaultSelfEvolvePlugin(invalid.ctx, { serverUrl: "http://attacker.invalid", hostVersion: "1.99.0", hostSupported: true });
    await waitForDurableStartup(hooks, `invalid-${serverUrl}`);
    assert.equal(fetchCalls, 0);
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "invalid-server-url", arguments: "health" }, output);
    assert.match(output.parts.at(-1).text, /host-health-unavailable/u);
    await hooks.dispose();
  }
});

test("deferred health grants no integration authority before resolution and dispose settles it", async (t) => {
  const f = durableFixture(t);
  const seeded = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  const settings = seeded.getSettings();
  seeded.setGlobalSettings(makeGlobalSettings({ ...settings.global, mode: "auto", updatedAt: settings.global.updatedAt + 1 }));
  seeded.close();
  let resolveHealth;
  const healthPending = new Promise((resolve) => { resolveHealth = resolve; });
  f.ctx.client.global.health = async () => await healthPending;
  const calls = { events: 0, commands: 0 };
  const integration = {
    async handleEvent() { calls.events += 1; },
    async handleCommand() { calls.commands += 1; return { responseText: "unexpected" }; },
    close() {},
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, { pipeline: integration });
  assert.equal(typeof hooks.event, "function");
  const eventStarted = Date.now();
  await hooks.event({ type: "session.idle", properties: { sessionID: "pending" } });
  assert.ok(Date.now() - eventStarted < 50, "provisional event hook must return without awaiting startup");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "pending", arguments: "health" }, output);
  assert.match(output.parts.at(-1).text, /startup-validation-pending/u);
  assert.deepEqual(calls, { events: 0, commands: 0 });
  resolveHealth({ data: { healthy: true, version: "1.18.3" } });
  await waitForDurableStartup(hooks, "pending-authority");
  await hooks.event({ type: "session.idle", properties: { sessionID: "ready" } });
  // The event hook is fire-and-forget (OpenCode does not await it); flush the
  // queued delivery before asserting the integration observed exactly one event.
  await tick();
  assert.equal(calls.events, 1);
  await hooks.dispose();

  const blocked = durableFixture(t);
  blocked.ctx.client.global.health = async () => new Promise(() => {});
  const blockedHooks = await DefaultSelfEvolvePlugin(blocked.ctx, { __testHostHealthTimeoutMs: 10_000 });
  const started = Date.now();
  await blockedHooks.dispose();
  assert.ok(Date.now() - started < 500, "dispose must abort and settle pending startup");
});

test("one durable lifecycle hook stays inert before boot and follows fresh project analysis state", async (t) => {
  const f = durableFixture(t);
  const calls = {
    operationalState: 0,
    integrationEvents: 0,
    lineage: 0,
    sessionReads: 0,
    providerCalls: 0,
    storeEffects: 0,
    schedulerAdmissions: 0,
  };
  f.ctx.client.session = {
    async get() { calls.sessionReads += 1; return { data: {} }; },
    async messages() { calls.sessionReads += 1; return { data: [] }; },
    async create() { calls.providerCalls += 1; return { data: { id: "unexpected" } }; },
    async prompt() { calls.providerCalls += 1; return { data: {} }; },
  };
  let operationalState = {
    automaticRecommendationsEnabled: false,
    automaticWorkAllowed: false,
    reason: "automatic-recommendations-disabled",
  };
  const integration = {
    async boot() { return { ok: true }; },
    getProjectOperationalState() {
      calls.operationalState += 1;
      return operationalState;
    },
    async handleEvent() {
      calls.integrationEvents += 1;
      calls.lineage += 1;
      calls.storeEffects += 1;
      calls.schedulerAdmissions += 1;
    },
    async handleCommand() { return { responseText: "ready" }; },
    async shutdown() {},
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    hostRecoveryDelayMs: 25,
    pipelineFactory: async () => integration,
  });
  t.after(async () => hooks.dispose());

  assert.equal(typeof hooks.event, "function");
  assert.equal(hooks["chat.message"], undefined);
  hooks.event({ type: "session.idle", properties: { sessionID: "preboot" } });
  await tick();
  assert.deepEqual(calls, {
    operationalState: 0,
    integrationEvents: 0,
    lineage: 0,
    sessionReads: 0,
    providerCalls: 0,
    storeEffects: 0,
    schedulerAdmissions: 0,
  });

  await waitForDurableStartup(hooks, "stable-binary-hook");
  hooks.event({ type: "session.idle", properties: { sessionID: "off" } });
  await tick();
  assert.equal(calls.operationalState, 1);
  assert.equal(calls.integrationEvents, 0);
  assert.equal(calls.sessionReads, 0);
  assert.equal(calls.providerCalls, 0);
  assert.equal(calls.storeEffects, 0);
  assert.equal(calls.schedulerAdmissions, 0);

  operationalState = { automaticRecommendationsEnabled: true, automaticWorkAllowed: true, reason: null };
  hooks.event({ type: "session.idle", properties: { sessionID: "on" } });
  await tick();
  assert.equal(calls.integrationEvents, 1, "Off to On admits the next eligible event without restart");

  operationalState = { automaticRecommendationsEnabled: true, automaticWorkAllowed: false, reason: "project-excluded" };
  hooks.event({ type: "session.idle", properties: { sessionID: "excluded" } });
  await tick();
  operationalState = { automaticRecommendationsEnabled: false, automaticWorkAllowed: false, reason: "automatic-recommendations-disabled" };
  hooks.event({ type: "session.idle", properties: { sessionID: "off-again" } });
  await tick();
  assert.equal(calls.operationalState, 4);
  assert.equal(calls.integrationEvents, 1, "fresh suppressors and On to Off block more work");
});

test("dispose interrupts host-health retry backoff before another attempt starts", async (t) => {
  const f = durableFixture(t);
  let healthCalls = 0;
  f.ctx.client.global.health = async () => {
    healthCalls += 1;
    throw new Error("connection refused during startup");
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, {
    __testHostHealthRetryWindowMs: 5_000,
    __testHostHealthRetryDelayMs: 1_000,
  });
  const deadline = Date.now() + 500;
  while (healthCalls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(healthCalls, 1);

  const started = Date.now();
  await hooks.dispose();
  assert.ok(Date.now() - started < 500, "dispose must abort the retry delay rather than await its timer");
  assert.equal(healthCalls, 1, "disposal must not permit another health attempt");
});

test("plain registration boots fresh v0.4 state On with one stable event hook", async (t) => {
  const f = durableFixture(t);
  const hooks = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(typeof hooks.event, "function");
  assert.equal(hooks["chat.message"], undefined);
  await waitForDurableStartup(hooks, "plain-registration");
  const store = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(store.getAutomationState().enabled, true);
  assert.equal(fs.existsSync(path.join(f.stateRoot, "self-evolve", "global", "settings.json")), true);
  store.close();
  await hooks.dispose();
});

test("fresh v0.4 automatic state keeps the stable event hook after an options-free restart", async (t) => {
  const f = durableFixture(t);
  const first = await DefaultSelfEvolvePlugin(f.ctx);
  await waitForDurableStartup(first, "auto-startup-first");
  const store = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(store.getAutomationState().enabled, true);
  store.close();
  await first.dispose();

  const restarted = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(typeof restarted.event, "function");
  assert.equal(restarted["chat.message"], undefined);
  await restarted.dispose();
});

test("a removed yolo command changes nothing and legacy yolo compatibility stays On", async (t) => {
  const f = durableFixture(t);
  const first = await DefaultSelfEvolvePlugin(f.ctx);
  await waitForDurableStartup(first, "yolo-retired-startup");
  const skillRoot = path.join(f.root, "skills");
  fs.mkdirSync(skillRoot, { recursive: true });
  const output = { parts: [] };
  await first["command.execute.before"]({ command: "self-evolve", sessionID: "yolo-retired", arguments: `yolo confirm --allowlist ${skillRoot}` }, output);
  assert.match(output.parts.at(-1).text, /removed in Self-evolve v0\.4/i);
  await first.dispose();

  const store = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(store.getAutomationState().enabled, true);
  const settings = store.getSettings();
  // A partition written by v0.2 can still hold `yolo`; it must read back as auto.
  fs.writeFileSync(
    path.join(f.stateRoot, "self-evolve", "global", "settings.json"),
    `${JSON.stringify({ ...settings.global, mode: "yolo", updatedAt: settings.global.updatedAt + 1 })}\n`,
  );
  store.close();

  const restarted = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(typeof restarted.event, "function");
  assert.equal(restarted["chat.message"], undefined);
  const reopened = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(reopened.getSettings().global.mode, "auto");
  assert.equal(reopened.getAutomationState().enabled, true);
  reopened.close();
  await restarted.dispose();
});

test("a removed manual command cannot turn automatic recommendations Off", async (t) => {
  const f = durableFixture(t);
  const store = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  const settings = store.getSettings();
  store.setGlobalSettings(makeGlobalSettings({ ...settings.global, mode: "auto", updatedAt: settings.global.createdAt + 1 }));
  store.close();
  const automatic = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(typeof automatic.event, "function");
  const output = { parts: [] };
  await waitForDurableStartup(automatic, "manual-reset-startup");
  await automatic["command.execute.before"]({ command: "self-evolve", sessionID: "manual-reset", arguments: "manual" }, output);
  assert.match(output.parts.at(-1).text, /removed in Self-evolve v0\.4/u);
  await automatic.dispose();
  const restarted = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(typeof restarted.event, "function");
  const reopened = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(reopened.getAutomationState().enabled, true);
  reopened.close();
  await restarted.dispose();
});

test("startup mode is not authority and cannot override an existing durable preference", async (t) => {
  const f = durableFixture(t);
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, { mode: "auto" });
  assert.equal(typeof hooks.event, "function");
  await waitForDurableStartup(hooks, "startup-mode-not-authority");
  const store = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(store.getAutomationState().enabled, true);
  store.close();
  await hooks.dispose();
});

test("unavailable or corrupt durable state keeps the event hook inert", async (t) => {
  const unavailable = await DefaultSelfEvolvePlugin({ directory: "/workspace/unavailable", client: {} }, { env: {} });
  assert.equal(typeof unavailable.event, "function");
  await unavailable.dispose();

  const f = durableFixture(t);
  const initialized = await DefaultSelfEvolvePlugin(f.ctx);
  await waitForDurableStartup(initialized, "corrupt-initialize");
  await initialized.dispose();
  fs.writeFileSync(path.join(f.stateRoot, "self-evolve", "global", "settings.json"), "{corrupt", "utf8");
  const corrupt = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(typeof corrupt.event, "function");
  await waitForDurableStartup(corrupt, "corrupt-startup");
  const output = { parts: [] };
  await corrupt["command.execute.before"]({ command: "self-evolve", sessionID: "corrupt", arguments: "health" }, output);
  assert.match(output.parts.at(-1).text, /durable integration unavailable/i);
  await corrupt.dispose();
});
