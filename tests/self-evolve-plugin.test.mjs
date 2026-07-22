import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { ANALYZER_TOOLS } from "../analyzer-prompt.js";
import { SELF_EVOLVE_ANALYZER_AGENT, SELF_EVOLVE_SOURCE } from "../self-evolve-core.js";
import DefaultSelfEvolvePlugin from "../self-evolve.js";
import { makeGlobalSettings } from "../self-evolve-schemas.js";
import { openStore, projectFingerprintFor } from "../self-evolve-store.js";

const SelfEvolvePlugin = Object.assign(
  (ctx, options = {}) => DefaultSelfEvolvePlugin(ctx, { ...options, durableAutonomy: false }),
  { __test: DefaultSelfEvolvePlugin.__test },
);

function proposalPayload(overrides = {}) {
  return {
    proposal: {
      title: "Add a repo-local troubleshooting note",
      summary: "The recent session shows repeated local test failures, so a focused troubleshooting note would reduce future confusion.",
      evidence: ["The transcript contains repeated failed test output and correction messages."],
      target: { path: "src/troubleshooting.md", surface: "repo docs", symbol: "" },
      placement: "repo-local",
      risk: "low",
      riskMitigation: "Only create a small documentation follow-up after user approval.",
      confidence: 0.9,
      suggestedAction: "Ask whether to add a short repo-local troubleshooting note for the repeated failure pattern.",
      ...(overrides.proposal ?? {}),
    },
    reason: "Specific low-risk repo-local documentation opportunity.",
    ...overrides,
  };
}

function messages(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? "assistant" : "user",
    parts: [{ type: "text", text: `ordinary session message ${index}` }],
  }));
}

function createMockContext({
  promptOutput = JSON.stringify(proposalPayload()),
  messageList = messages(6),
  createImpl,
  messagesImpl,
  promptImpl,
  promptAsyncImpl,
  abortImpl,
  interruptImpl,
  showToastImpl,
} = {}) {
  const calls = { create: [], messages: [], prompt: [], promptAsync: [], abort: [], interrupt: [], showToast: [] };
  const ctx = {
    directory: "/workspace/project",
    client: {
      tui: {
        showToast: async (args) => {
          calls.showToast.push(args);
          if (showToastImpl) return await showToastImpl(args, calls);
          return { data: {} };
        },
      },
      session: {
        create: async (args) => {
          calls.create.push(args);
          if (createImpl) return await createImpl(args, calls);
          return { data: { id: `analyzer-${calls.create.length}` } };
        },
        messages: async (args) => {
          calls.messages.push(args);
          if (messagesImpl) return await messagesImpl(args, calls);
          return { data: messageList };
        },
        prompt: async (args) => {
          calls.prompt.push(args);
          if (promptImpl) return await promptImpl(args, calls);
          return { data: { parts: [{ type: "text", text: promptOutput }] } };
        },
        promptAsync: async (args) => {
          calls.promptAsync.push(args);
          if (promptAsyncImpl) return await promptAsyncImpl(args);
          return { data: {} };
        },
        abort: async (args) => {
          calls.abort.push(args);
          if (abortImpl) return await abortImpl(args, calls);
          return { data: {} };
        },
      },
    },
  };
  if (interruptImpl) {
    ctx.client.session.interrupt = async (args) => {
      calls.interrupt.push(args);
      return await interruptImpl(args, calls);
    };
  }
  return { ctx, calls };
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

beforeEach(() => {
  SelfEvolvePlugin.__test.__resetRegistryForTests();
});

test("config hook registers hidden deny-tool analyzer agent", async () => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx);
  const cfg = { model: "openai/gpt-5.5", agent: {} };
  await hooks.config(cfg);
  const agent = cfg.agent[SELF_EVOLVE_ANALYZER_AGENT];
  const expectedPermissions = ["*", ...Object.keys(ANALYZER_TOOLS), "external_directory"].sort();
  assert.equal(agent.hidden, true);
  assert.equal(agent.mode, "primary");
  assert.equal(agent.model, "openai/gpt-5.5");
  assert.equal(agent.temperature, 0);
  assert.deepEqual(Object.keys(agent.permission).sort(), expectedPermissions);
  assert.deepEqual(SelfEvolvePlugin.__test.analyzerPermissionNames().sort(), expectedPermissions);
  assert.equal(agent.permission.edit, "deny");
  assert.equal(agent.permission.bash, "deny");
  assert.equal(agent.permission.todowrite, "deny");
});

test("commands mutate output.parts in place and handle status pause resume dismiss disable", async () => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 1000 });
  const output = { parts: [{ type: "text", text: "original" }] };
  const originalParts = output.parts;

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "cmd", arguments: "status" }, output);
  assert.equal(output.parts, originalParts);
  assert.match(output.parts.at(-1).text, /Self-evolve status/);

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "cmd", arguments: "pause" }, output);
  assert.equal(output.parts, originalParts);
  assert.match(output.parts.at(-1).text, /paused/i);

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "cmd", arguments: "resume" }, output);
  assert.match(output.parts.at(-1).text, /resumed/i);

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("cmd", 1000);
  state.pendingProposal = { id: "se-99", title: "Pending test proposal", fingerprint: "fp" };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "cmd", arguments: "dismiss se-99" }, output);
  assert.match(output.parts.at(-1).text, /Dismissed self-evolve proposal se-99/);
  assert.equal(state.pendingProposal, null);

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "cmd", arguments: "disable" }, output);
  assert.match(output.parts.at(-1).text, /disabled/i);
  assert.equal(state.disabled, true);
});

test("bare self-evolve command isolates analyzer prompt and returns advisory output after v1 message read", async () => {
  const { ctx, calls } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 1000 });
  const output = { parts: [] };
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "session-a", arguments: "" }, output);

  assert.equal(calls.messages.length, 1);
  assert.deepEqual(calls.messages[0].path, { id: "session-a" });
  assert.deepEqual(calls.messages[0].query, { directory: "/workspace/project", limit: 120 });
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0].query, { directory: "/workspace/project" });
  assert.equal(calls.create[0].body.parentID, "session-a");
  assert.equal(calls.create[0].body.agent, SELF_EVOLVE_ANALYZER_AGENT);
  assert.deepEqual(calls.create[0].body.model, { providerID: "openai", modelID: "gpt-5.5" });
  assert.ok(calls.create[0].body.permission.some((rule) => rule.permission === "*" && rule.action === "deny"));
  assert.deepEqual(calls.create[0].body.permission.map((rule) => rule.permission).sort(), ["*", ...Object.keys(ANALYZER_TOOLS), "external_directory"].sort());
  assert.equal(calls.prompt.length, 1);
  assert.deepEqual(calls.prompt[0].path, { id: "analyzer-1" });
  assert.notDeepEqual(calls.prompt[0].path, { id: "session-a" });
  assert.equal(calls.prompt[0].body.agent, SELF_EVOLVE_ANALYZER_AGENT);
  assert.equal(calls.prompt[0].body.parts[0].metadata.source, SELF_EVOLVE_SOURCE);
  assert.deepEqual(calls.prompt[0].body.model, { providerID: "openai", modelID: "gpt-5.5" });
  assert.equal(calls.prompt[0].body.tools.edit, false);
  assert.match(calls.prompt[0].body.parts[0].text, /Analyze this OpenCode session excerpt/);
  assert.equal(calls.abort.length, 1);
  assert.deepEqual(calls.abort[0].path, { id: "analyzer-1" });
  assert.equal(calls.promptAsync.length, 0);
  assert.doesNotMatch(output.parts.at(-1).text, /Analyze this OpenCode session excerpt|Redacted transcript excerpt|JSON schema/);
  assert.match(output.parts.at(-1).text, /Self-evolve found a possible improvement/);
  assert.match(output.parts.at(-1).text, /Advisory only: no changes will be made unless you explicitly ask/);
  assert.match(output.parts.at(-1).text, /found proposal se-1/);
  assert.match(output.parts.at(-1).text, /No files were changed/);
});

test("accepted proposal shows a TUI toast", async () => {
  const { ctx, calls } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 1500 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "toast", arguments: "" }, { parts: [] });

  assert.equal(calls.showToast.length, 1);
  assert.equal(calls.showToast[0].body.variant, "info");
  assert.equal(calls.showToast[0].body.title, "Self-evolve: Add a repo-local troubleshooting note");
  assert.match(calls.showToast[0].body.message, /Confidence: 0\.90 \| Risk: low/);
  assert.match(calls.showToast[0].body.message, /Target: src\/troubleshooting\.md/);
  assert.equal(calls.showToast[0].body.duration, 8000);
});

test("showProposalToast returns without error when ctx.client.tui is missing", async () => {
  const proposal = proposalPayload().proposal;
  const before = structuredClone(proposal);

  await SelfEvolvePlugin.__test.showProposalToast({ client: {} }, proposal);

  assert.deepEqual(proposal, before);
  assert.equal(SelfEvolvePlugin.__test.registry.has("toast-missing"), false);
});

test("showProposalToast swallows TUI errors without changing proposal state", async () => {
  const proposal = proposalPayload().proposal;
  const before = structuredClone(proposal);
  const ctx = {
    client: {
      tui: {
        showToast: async () => { throw new Error("toast failed"); },
      },
    },
  };

  await SelfEvolvePlugin.__test.showProposalToast(ctx, proposal);

  assert.deepEqual(proposal, before);
  assert.equal(SelfEvolvePlugin.__test.registry.has("toast-throw"), false);
});

test("duplicate manual scans dedupe while analyzer is in flight", async () => {
  let resolvePrompt;
  const promptReady = new Promise((resolve) => { resolvePrompt = resolve; });
  const { ctx, calls } = createMockContext({
    promptImpl: async () => await promptReady,
  });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 2000 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  const firstOutput = { parts: [] };
  const secondOutput = { parts: [] };
  const first = hooks["command.execute.before"]({ command: "self-evolve", sessionID: "session-b", arguments: "" }, firstOutput);
  const second = hooks["command.execute.before"]({ command: "self-evolve", sessionID: "session-b", arguments: "scan" }, secondOutput);
  await tick();
  assert.equal(calls.prompt.length, 1);
  assert.match(firstOutput.parts.at(-1).text, /redacted recent-session transcript to the configured model provider/);

  resolvePrompt({ data: { parts: [{ type: "text", text: JSON.stringify(proposalPayload()) }] } });
  await Promise.all([first, second]);
  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.promptAsync.length, 0);
  assert.match(firstOutput.parts.at(-1).text, /found proposal se-1/);
  assert.match(secondOutput.parts.at(-1).text, /already-analyzing|skipped/i);
});

test("manual scan validates and notifies", async () => {
  const { ctx, calls } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 5000 });
  const output = { parts: [] };
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "scan", arguments: "scan" }, output);

  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.promptAsync.length, 0);
  assert.match(output.parts.at(-1).text, /found proposal se-1/);
  assert.match(output.parts.at(-1).text, /Suggested action:/);
  assert.match(output.parts.at(-1).text, /No files were changed/);
});

test("proposal notification speaks to the user and remains advisory-only", () => {
  const proposal = { ...proposalPayload().proposal, id: "se-42" };
  const text = SelfEvolvePlugin.__test.proposalNotification(proposal);

  assert.match(text, /^Self-evolve found a possible improvement: Add a repo-local troubleshooting note/);
  assert.match(text, /Advisory only: no changes will be made unless you explicitly ask/);
  assert.match(text, /- Implement now: ask an agent to make this change/);
  assert.match(text, /- Save follow-up: ask to record it as backlog work for later/);
  assert.match(text, /- Ignore it: run \/self-evolve dismiss se-42/);
  assert.match(text, /Proposal ID: se-42/);
  assert.match(text, /Suggested action:/);
  assert.doesNotMatch(text, /Do not implement automatically|Ask the user|JSON schema|Redacted transcript excerpt|\{"proposal"/);
});

test("scan text reports no file changes and humanizes gate reasons", () => {
  const accepted = SelfEvolvePlugin.__test.scanText({ accepted: true, proposal: { ...proposalPayload().proposal, id: "se-5" } });
  assert.match(accepted, /found proposal se-5/);
  assert.match(accepted, /No files were changed/);

  for (const reason of ["proposal-pending", "run-cap", "proposal-cap", "failure-cap", "already-analyzing", "disabled", "paused"]) {
    const text = SelfEvolvePlugin.__test.scanText({ accepted: false, blocked: true, reason });
    assert.match(text, /No files were changed/);
    if (reason.includes("-")) assert.doesNotMatch(text, new RegExp(reason));
    assert.notEqual(text, `Manual self-evolve scan skipped: ${reason}. No files were changed.`);
  }

  assert.equal(SelfEvolvePlugin.__test.humanizeScanReason("already-analyzing"), "a scan is already running for this session");
  assert.match(SelfEvolvePlugin.__test.scanText({ accepted: false, reason: "No safe actionable proposal." }), /No safe actionable proposal\. No files were changed/);
});

test("session create failure fails closed without active-session analyzer prompting", async () => {
  const { ctx, calls } = createMockContext({
    createImpl: async () => ({ error: { message: "create rejected" } }),
  });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 5200, maxAnalyzerFailures: 2 });
  const output = { parts: [] };
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "create-fails", arguments: "scan" }, output);

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("create-fails", 5200);
  assert.equal(calls.create.length, 6, "permission and parentID fallbacks try both v1 and direct create shapes");
  assert.equal(calls.prompt.length, 0, "analyzer must not fallback to prompting the active session");
  assert.equal(calls.promptAsync.length, 0);
  assert.equal(calls.abort.length, 0);
  assert.equal(state.analyzerFailures, 1);
  assert.match(state.lastReason, /create rejected/);
  assert.match(output.parts.at(-1).text, /create rejected/);
});

test("temporary analyzer prompt failure aborts the analyzer session and fails closed", async () => {
  const { ctx, calls } = createMockContext({
    promptImpl: async () => { throw new Error("prompt exploded"); },
  });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 5300, maxAnalyzerFailures: 2 });
  const output = { parts: [] };
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "prompt-fails", arguments: "scan" }, output);

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("prompt-fails", 5300);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.prompt.length, 3);
  assert.equal(calls.prompt[0].path.id, "analyzer-1");
  assert.equal(calls.prompt[1].path.sessionID, "analyzer-1");
  assert.equal(calls.prompt[2].sessionID, "analyzer-1");
  assert.equal(calls.abort.length, 1);
  assert.equal(calls.abort[0].path.id, "analyzer-1");
  assert.equal(calls.promptAsync.length, 0);
  assert.equal(state.analyzerFailures, 1);
  assert.match(output.parts.at(-1).text, /prompt exploded/);
});

test("cleanup failure after a valid analyzer result preserves the accepted proposal", async () => {
  const { ctx, calls } = createMockContext({
    abortImpl: async () => ({ error: { message: "cleanup rejected" } }),
  });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 5400, maxAnalyzerFailures: 1 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "cleanup-fails", arguments: "scan" }, { parts: [] });

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("cleanup-fails", 5400);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.abort.length, 4);
  assert.equal(calls.promptAsync.length, 0);
  assert.equal(state.disabled, false);
  assert.equal(state.analyzerFailures, 0);
  assert.ok(state.pendingProposal);
  assert.equal(state.pendingProposal.id, "se-1");
});

test("cleanup falls back to session interrupt when abort is unavailable", async () => {
  const { ctx, calls } = createMockContext({
    interruptImpl: async () => ({ data: {} }),
  });
  delete ctx.client.session.abort;
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 5600, maxAnalyzerFailures: 1 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "cleanup-interrupt", arguments: "scan" }, { parts: [] });

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("cleanup-interrupt", 5600);
  assert.equal(calls.abort.length, 0);
  assert.equal(calls.interrupt.length, 1);
  assert.equal(state.analyzerFailures, 0);
  assert.equal(state.pendingProposal?.id, "se-1");
});

test("active-session promptAsync is not used for accepted proposal delivery", async () => {
  const { ctx } = createMockContext();
  ctx.client.session.promptAsync = async () => { throw new Error("network down"); };
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 7000, maxAnalyzerFailures: 1 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "notify-throw", arguments: "scan" }, { parts: [] });

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("notify-throw", 7000);
  assert.equal(state.disabled, false);
  assert.equal(state.analyzerFailures, 0);
  assert.ok(state.pendingProposal, "the accepted proposal must remain pending");
  assert.equal(state.pendingProposal.id, "se-1");
  assert.equal(state.lastReason, "Proposal se-1 pending.");
});

test("a concurrent disable while reading messages skips the analyzer run and LLM call (concurrency-1)", async () => {
  let releaseMessages;
  const messagesGate = new Promise((resolve) => { releaseMessages = resolve; });
  const { ctx, calls } = createMockContext();
  const baseMessages = ctx.client.session.messages;
  ctx.client.session.messages = async (args) => {
    await messagesGate;
    return await baseMessages(args);
  };
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 8000 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  const analysis = hooks["command.execute.before"]({ command: "self-evolve", sessionID: "race", arguments: "scan" }, { parts: [] });
  await tick(); // let reserve happen and park at the messages await

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "race", arguments: "disable" }, output);

  releaseMessages();
  await analysis;

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("race", 8000);
  assert.equal(state.disabled, true);
  assert.equal(state.analyzerRuns, 0, "a cancelled session must not consume an analyzer run");
  assert.equal(calls.prompt.length, 0, "a cancelled session must not make the LLM call");
});

test("pause during message-read failure does not count as analyzer failure", async () => {
  let releaseMessages;
  const messagesGate = new Promise((resolve) => { releaseMessages = resolve; });
  const { ctx, calls } = createMockContext({
    messagesImpl: async () => {
      await messagesGate;
      throw new Error("messages unavailable");
    },
  });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 8500, maxAnalyzerFailures: 1 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  const analysis = hooks["command.execute.before"]({ command: "self-evolve", sessionID: "read-fail-pause", arguments: "scan" }, { parts: [] });
  await waitFor(() => calls.messages.length === 1, "message read attempt");

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "read-fail-pause", arguments: "pause" }, { parts: [] });
  releaseMessages();
  await analysis;

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("read-fail-pause", 8500);
  assert.equal(state.disabled, false);
  assert.equal(state.paused, true);
  assert.equal(state.analyzerFailures, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt.length, 0);
});

test("status reflects configured caps rather than defaults (api-misuse-17)", async () => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 9000, maxAnalyzerRuns: 4, maxAnalyzerFailures: 1, maxProposals: 2 });
  const output = { parts: [] };

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "caps", arguments: "status" }, output);

  const text = output.parts.at(-1).text;
  assert.match(text, /Analyzer runs: 0\/4/);
  assert.match(text, /Failures: 0\/1/);
  assert.match(text, /Proposals: 0\/2/);
});

test("structured_output analyzer result shape is accepted", async () => {
  const { ctx, calls } = createMockContext({
    promptImpl: async () => ({ data: { info: { structured_output: proposalPayload() } } }),
  });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 10000, maxAnalyzerFailures: 1 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "structured", arguments: "scan" }, { parts: [] });

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("structured", 10000);
  assert.equal(state.analyzerFailures, 0);
  assert.equal(state.pendingProposal.id, "se-1");
  assert.equal(calls.promptAsync.length, 0);
});

test("analyzer timeout clears analyzing state and reports a failure", async () => {
  const never = new Promise(() => {});
  const { ctx, calls } = createMockContext({ promptImpl: async () => await never });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 11000, analyzerTimeoutMs: 1, maxAnalyzerFailures: 2 });
  const output = { parts: [] };
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "timeout", arguments: "scan" }, output);

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("timeout", 11000);
  assert.equal(state.analyzing, false);
  assert.equal(state.analyzerFailures, 1);
  assert.match(state.lastReason, /timed out/);
  assert.equal(calls.prompt.length, 1);
  assert.match(output.parts.at(-1).text, /timed out/);
});

test("message read timeout clears analyzing state and reports a failure", async () => {
  const never = new Promise(() => {});
  const { ctx, calls } = createMockContext({ messagesImpl: async () => await never });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 11100, sdkTimeoutMs: 1, maxAnalyzerFailures: 2 });
  const output = { parts: [] };
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "messages-timeout", arguments: "scan" }, output);

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("messages-timeout", 11100);
  assert.equal(state.analyzing, false);
  assert.equal(state.analyzerFailures, 1);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.create.length, 0);
  assert.match(state.lastReason, /message read timed out/i);
  assert.match(output.parts.at(-1).text, /message read timed out/i);
});

test("session create timeout clears analyzing state and reports a failure", async () => {
  const never = new Promise(() => {});
  const { ctx, calls } = createMockContext({ createImpl: async () => await never });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 11200, sdkTimeoutMs: 1, maxAnalyzerFailures: 2 });
  const output = { parts: [] };
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "create-timeout", arguments: "scan" }, output);

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("create-timeout", 11200);
  assert.equal(state.analyzing, false);
  assert.equal(state.analyzerFailures, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.prompt.length, 0);
  assert.equal(calls.abort.length, 0);
  assert.match(state.lastReason, /session\.create timed out/i);
  assert.match(output.parts.at(-1).text, /session\.create timed out/i);
});

test("cleanup timeout remains best-effort and preserves an accepted proposal", async () => {
  const never = new Promise(() => {});
  const { ctx, calls } = createMockContext({ abortImpl: async () => await never });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 11300, cleanupTimeoutMs: 1, maxAnalyzerFailures: 1 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "cleanup-timeout", arguments: "scan" }, { parts: [] });

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("cleanup-timeout", 11300);
  assert.equal(state.analyzing, false);
  assert.equal(state.analyzerFailures, 0);
  assert.equal(calls.abort.length, 1);
  assert.equal(calls.promptAsync.length, 0);
  assert.ok(state.pendingProposal);
  assert.equal(state.pendingProposal.id, "se-1");
});

test("toast timeout does not block accepted proposal state", async () => {
  const never = new Promise(() => {});
  const { ctx, calls } = createMockContext({ showToastImpl: async () => await never });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 11400, deliveryTimeoutMs: 1, maxAnalyzerFailures: 1 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "toast-timeout", arguments: "scan" }, { parts: [] });

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("toast-timeout", 11400);
  assert.equal(state.analyzing, false);
  assert.equal(state.analyzerFailures, 0);
  assert.equal(calls.showToast.length, 1);
  assert.equal(calls.promptAsync.length, 0);
  assert.ok(state.pendingProposal);
  assert.equal(state.pendingProposal.id, "se-1");
});

test("promptAsync is not called even when configured to never settle", async () => {
  const never = new Promise(() => {});
  const { ctx, calls } = createMockContext({ promptAsyncImpl: async () => await never });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 11500, deliveryTimeoutMs: 1, maxAnalyzerFailures: 1 });
  const output = { parts: [] };
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "notify-timeout", arguments: "scan" }, output);

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("notify-timeout", 11500);
  assert.equal(state.analyzing, false);
  assert.equal(state.analyzerFailures, 0);
  assert.equal(calls.promptAsync.length, 0);
  assert.ok(state.pendingProposal);
  assert.equal(state.pendingProposal.id, "se-1");
  assert.equal(state.lastReason, "Proposal se-1 pending.");
  assert.match(output.parts.at(-1).text, /found proposal se-1/);
});

test("pause cancels an in-flight analyzer result even if resumed before it returns", async () => {
  let resolvePrompt;
  const promptReady = new Promise((resolve) => { resolvePrompt = resolve; });
  const { ctx, calls } = createMockContext({ promptImpl: async () => await promptReady });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 12000 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  const analysis = hooks["command.execute.before"]({ command: "self-evolve", sessionID: "pause-race", arguments: "scan" }, { parts: [] });
  await tick();

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "pause-race", arguments: "pause" }, output);
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "pause-race", arguments: "resume" }, output);

  resolvePrompt({ data: { parts: [{ type: "text", text: JSON.stringify(proposalPayload()) }] } });
  await analysis;

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("pause-race", 12000);
  assert.equal(state.pendingProposal, null);
  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.promptAsync.length, 0);
});

test("stale analyzer completion does not clear a newer in-flight scan token", async () => {
  let resolveFirstPrompt;
  let resolveSecondPrompt;
  const firstPromptReady = new Promise((resolve) => { resolveFirstPrompt = resolve; });
  const secondPromptReady = new Promise((resolve) => { resolveSecondPrompt = resolve; });
  const { ctx, calls } = createMockContext({
    promptImpl: async (_args, currentCalls) => {
      if (currentCalls.prompt.length === 1) return await firstPromptReady;
      return await secondPromptReady;
    },
  });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 12600 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  const first = hooks["command.execute.before"]({ command: "self-evolve", sessionID: "overlap-race", arguments: "scan" }, { parts: [] });
  await waitFor(() => calls.prompt.length === 1, "first analyzer prompt");

  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "overlap-race", arguments: "pause" }, output);
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "overlap-race", arguments: "resume" }, output);

  const second = hooks["command.execute.before"]({ command: "self-evolve", sessionID: "overlap-race", arguments: "scan" }, { parts: [] });
  await waitFor(() => calls.prompt.length === 2, "second analyzer prompt");

  resolveFirstPrompt({ data: { parts: [{ type: "text", text: JSON.stringify(proposalPayload()) }] } });
  await first;

  const stateDuringSecond = SelfEvolvePlugin.__test.registry.getOrCreate("overlap-race", 12600);
  assert.equal(stateDuringSecond.analyzing, true);
  assert.equal(stateDuringSecond.currentAnalysisToken, 2);
  assert.equal(stateDuringSecond.pendingProposal, null);
  assert.equal(calls.promptAsync.length, 0);

  resolveSecondPrompt({ data: { parts: [{ type: "text", text: JSON.stringify(proposalPayload()) }] } });
  await second;

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("overlap-race", 12600);
  assert.equal(state.analyzing, false);
  assert.equal(state.currentAnalysisToken, null);
  assert.equal(state.pendingProposal?.id, "se-1");
  assert.equal(calls.promptAsync.length, 0);
});

test("pause cancels an in-flight analyzer failure without incrementing failures", async () => {
  let rejectPrompt;
  const promptReady = new Promise((_, reject) => { rejectPrompt = reject; });
  const { ctx } = createMockContext({ promptImpl: async () => await promptReady });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 12500, analyzerTimeoutMs: 1000, maxAnalyzerFailures: 1 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  const analysis = hooks["command.execute.before"]({ command: "self-evolve", sessionID: "pause-timeout", arguments: "scan" }, { parts: [] });
  await tick();
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "pause-timeout", arguments: "pause" }, output);
  rejectPrompt(new Error("network down"));
  await analysis;

  const state = SelfEvolvePlugin.__test.registry.getOrCreate("pause-timeout", 12500);
  assert.equal(state.analyzerFailures, 0);
  assert.equal(state.disabled, false);
  assert.match(state.lastReason, /state changed/i);
});

test("analyzer lifecycle falls back to direct session SDK shape", async () => {
  const { ctx, calls } = createMockContext({
    createImpl: async (args) => {
      if (args.body) return { error: { message: "unsupported shape" } };
      assert.equal(args.directory, "/workspace/project");
      assert.equal(args.parentID, "v2");
      assert.equal(args.agent, SELF_EVOLVE_ANALYZER_AGENT);
      assert.deepEqual(args.model, { providerID: "openai", modelID: "gpt-5.5" });
      return { data: { id: "analyzer-v2" } };
    },
    promptImpl: async (args) => {
      if (args.path) return { error: { message: "unsupported shape" } };
      assert.equal(args.sessionID, "analyzer-v2");
      assert.equal(args.directory, "/workspace/project");
      assert.equal(args.agent, SELF_EVOLVE_ANALYZER_AGENT);
      assert.deepEqual(args.model, { providerID: "openai", modelID: "gpt-5.5" });
      return { data: { parts: [{ type: "text", text: JSON.stringify(proposalPayload()) }] } };
    },
    abortImpl: async (args) => {
      if (args.path) return { error: { message: "unsupported shape" } };
      assert.equal(args.sessionID, "analyzer-v2");
      assert.equal(args.directory, "/workspace/project");
      return { data: {} };
    },
  });
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 13000 });
  await hooks.config({ model: "openai/gpt-5.5", agent: {} });

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "v2", arguments: "scan" }, { parts: [] });

  assert.equal(calls.create.length, 2);
  assert.equal(calls.create[1].parentID, "v2");
  assert.equal(calls.prompt.length, 3);
  assert.equal(calls.promptAsync.length, 0);
  assert.equal(calls.abort.length, 3);
  assert.equal(calls.prompt[2].sessionID, "analyzer-v2");
  assert.equal(calls.abort[2].sessionID, "analyzer-v2");
});

test("plugin registers no passive event or chat analysis hooks", async () => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 14000 });
  assert.equal(hooks.event, undefined);
  assert.equal(hooks["chat.message"], undefined);
  assert.equal(SelfEvolvePlugin.__test.registry.map.size, 0);
});

test("self-evolve command without a session id does not create undefined state", async () => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 15000 });
  const output = { parts: [] };

  await hooks["command.execute.before"]({ command: "self-evolve", arguments: "status" }, output);

  assert.match(output.parts.at(-1).text, /no session ID/i);
  assert.equal(SelfEvolvePlugin.__test.registry.has(undefined), false);
});

test("dispose hook clears the registry so per-session state does not outlive the plugin", async () => {
  const { ctx } = createMockContext();
  const hooks = await SelfEvolvePlugin(ctx, { now: () => 16000 });

  SelfEvolvePlugin.__test.registry.getOrCreate("disposed-a", 16000);
  SelfEvolvePlugin.__test.registry.getOrCreate("disposed-b", 16000);
  assert.equal(SelfEvolvePlugin.__test.registry.has("disposed-a"), true);
  assert.equal(SelfEvolvePlugin.__test.registry.has("disposed-b"), true);

  assert.equal(typeof hooks.dispose, "function");
  await hooks.dispose();

  assert.equal(SelfEvolvePlugin.__test.registry.has("disposed-a"), false);
  assert.equal(SelfEvolvePlugin.__test.registry.has("disposed-b"), false);
  assert.equal(SelfEvolvePlugin.__test.registry.map.size, 0);
});

test("double-instantiation preserves existing registry state and still re-seeds options for new sessions (regression)", async () => {
  // OpenCode calls every exported plugin factory and may instantiate
  // SelfEvolvePlugin more than once per process. Session state (pause,
  // disable, pending proposal, rate-limit counters) must survive a second
  // factory call: the module-level registry must be created exactly once
  // and never reassigned.
  const { ctx: ctxA } = createMockContext();
  const hooksA = await SelfEvolvePlugin(ctxA, { now: () => 17000 });

  const output = { parts: [] };
  await hooksA["command.execute.before"]({ command: "self-evolve", sessionID: "double-instance", arguments: "pause" }, output);
  assert.match(output.parts.at(-1).text, /paused/i);

  const stateAfterFirst = SelfEvolvePlugin.__test.registry.getOrCreate("double-instance", 17000);
  assert.equal(stateAfterFirst.paused, true);

  // A second factory instantiation (simulating OpenCode's double-instantiation).
  const { ctx: ctxB } = createMockContext();
  const hooksB = await SelfEvolvePlugin(ctxB, { now: () => 17100, maxAnalyzerRuns: 5 });

  assert.equal(
    SelfEvolvePlugin.__test.registry.has("double-instance"),
    true,
    "second factory call must not wipe existing registry entries",
  );
  const stateAfterSecond = SelfEvolvePlugin.__test.registry.getOrCreate("double-instance", 17100);
  assert.equal(
    stateAfterSecond,
    stateAfterFirst,
    "the same session state object must be preserved, not recreated",
  );
  assert.equal(
    stateAfterSecond.paused,
    true,
    "pause state set via the first instance must survive a second factory instantiation",
  );

  // A status check driven through the SECOND instance's hooks must still see
  // the pause applied through the FIRST instance's hooks: both read the same
  // shared module-level registry.
  const statusOutput = { parts: [] };
  await hooksB["command.execute.before"]({ command: "self-evolve", sessionID: "double-instance", arguments: "status" }, statusOutput);
  assert.match(statusOutput.parts.at(-1).text, /paused/i);

  // Options still re-seed for brand-new sessions created after the second
  // instantiation, proving the fix does not just freeze options forever.
  const freshState = SelfEvolvePlugin.__test.registry.getOrCreate("fresh-after-second-instance", 17100);
  assert.equal(freshState.options.maxAnalyzerRuns, 5);
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

test("provisional standard root validates after startup before durable initialization", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-root-match-"));
  const stateRoot = path.join(root, "state", "opencode");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  let sdkCalls = 0;
  const ctx = {
    directory: worktree,
    worktree,
    client: { global: { health: async () => ({ data: { healthy: true, version: "1.24.6" } }) }, path: { get: async () => { sdkCalls += 1; return { data: { state: stateRoot } }; } }, session: {} },
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
  assert.match(output.parts.at(-1).text, /effective mode manual|stored mode manual/u);
  assert.equal(fs.existsSync(path.join(stateRoot, "self-evolve", "global", "settings.json")), true);
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "matched-root", arguments: "health" }, output);
  assert.match(output.parts.at(-1).text, /host 1\.24\.6/u, "deferred boot must retain the version resolved before provisional root selection");
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

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "durable-unavailable", arguments: "auto" }, output);

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
  { name: "newer supported 1.x", response: { data: { healthy: true, version: "1.99.0" } }, supported: true },
  { name: "older 1.18.2", response: { data: { healthy: true, version: "1.18.2" } }, version: "1.18.2", reason: "host-version-unsupported" },
  { name: "legacy 1.17.7", response: { data: { healthy: true, version: "1.17.7" } }, version: "1.17.7", reason: "host-version-unsupported" },
  { name: "malformed version", response: { data: { healthy: true, version: "not-semver" } }, version: "not-semver", reason: "host-version-malformed" },
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
      assert.match(output.parts.at(-1).text, new RegExp(`host ${hostCase.response.data.version.replaceAll(".", "\\.")}`));
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
    f.ctx.client.global.health = health;
    const hooks = await DefaultSelfEvolvePlugin(f.ctx, { __testHostHealthTimeoutMs: 10, hostVersion: "1.99.0", hostSupported: true });
    assert.equal(typeof hooks.event, "function", `${name} may retain only the persisted-auto provisional hook`);
    await waitForDurableStartup(hooks, `startup-${name}`);
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: `health-${name}`, arguments: "health" }, output);
    assert.match(output.parts.at(-1).text, /host unknown/u);
    assert.match(output.parts.at(-1).text, new RegExp(reason));
    await hooks.dispose();
  }
});

test("hostSupported false narrows actual supported health and spoof options never widen it", async (t) => {
  const narrowed = durableFixture(t);
  const narrowedStore = openStore(narrowed.stateRoot, { projectFingerprint: narrowed.projectFingerprint });
  const narrowedSettings = narrowedStore.getSettings();
  narrowedStore.setGlobalSettings(makeGlobalSettings({ ...narrowedSettings.global, mode: "auto", updatedAt: narrowedSettings.global.updatedAt + 1 }));
  narrowedStore.close();
  narrowed.ctx.client.global.health = async () => ({ data: { healthy: true, version: "1.19.0" } });
  const narrowedHooks = await DefaultSelfEvolvePlugin(narrowed.ctx, { hostSupported: false });
  await waitForDurableStartup(narrowedHooks, "startup-narrowed");
  const narrowedOutput = { parts: [] };
  await narrowedHooks["command.execute.before"]({ command: "self-evolve", sessionID: "health-narrowed", arguments: "health" }, narrowedOutput);
  assert.match(narrowedOutput.parts.at(-1).text, /host 1\.19\.0/u);
  assert.match(narrowedOutput.parts.at(-1).text, /host-support-disabled-by-option/u);
  await narrowedHooks.dispose();

  const spoofed = durableFixture(t);
  spoofed.ctx.client.global.health = async () => ({ data: { healthy: true, version: "1.17.7" } });
  const spoofedHooks = await DefaultSelfEvolvePlugin(spoofed.ctx, { hostVersion: "1.99.0", hostSupported: true });
  await waitForDurableStartup(spoofedHooks, "startup-spoofed");
  assert.equal(spoofedHooks.event, undefined);
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
    return { ok: true, status: 200, json: async () => ({ healthy: true, version: "1.20.4" }) };
  };
  const hooks = await DefaultSelfEvolvePlugin(f.ctx);
  const pending = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "fallback-pending", arguments: "health" }, pending);
  assert.match(pending.parts.at(-1).text, /startup-validation-pending/u);
  await waitForDurableStartup(hooks, "fallback-startup");
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "fallback-health", arguments: "health" }, output);
  assert.match(output.parts.at(-1).text, /host 1\.20\.4/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:43210/global/health");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  await hooks.dispose();
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
  timed.ctx.__testOnlySelfEvolveFetch = async () => new Promise(() => {});
  const timedHooks = await DefaultSelfEvolvePlugin(timed.ctx, { __testHostHealthTimeoutMs: 10 });
  await waitForDurableStartup(timedHooks, "fallback-timeout");
  const timedOutput = { parts: [] };
  await timedHooks["command.execute.before"]({ command: "self-evolve", sessionID: "fallback-timeout", arguments: "health" }, timedOutput);
  assert.match(timedOutput.parts.at(-1).text, /host-health-timeout/u);
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
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "pending", arguments: "auto" }, output);
  assert.match(output.parts.at(-1).text, /startup-validation-pending/u);
  assert.deepEqual(calls, { events: 0, commands: 0 });
  resolveHealth({ data: { healthy: true, version: "1.18.3" } });
  await waitForDurableStartup(hooks, "pending-authority");
  await hooks.event({ type: "session.idle", properties: { sessionID: "ready" } });
  assert.equal(calls.events, 1);
  await hooks.dispose();

  const blocked = durableFixture(t);
  blocked.ctx.client.global.health = async () => new Promise(() => {});
  const blockedHooks = await DefaultSelfEvolvePlugin(blocked.ctx, { __testHostHealthTimeoutMs: 10_000 });
  const started = Date.now();
  await blockedHooks.dispose();
  assert.ok(Date.now() - started < 500, "dispose must abort and settle pending startup");
});

test("plain registration boots durable v0.2 in persisted manual mode", async (t) => {
  const f = durableFixture(t);
  const hooks = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(hooks.event, undefined);
  assert.equal(hooks["chat.message"], undefined);
  await waitForDurableStartup(hooks, "plain-registration");
  const store = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(store.getSettings().global.mode, "manual");
  assert.equal(fs.existsSync(path.join(f.stateRoot, "self-evolve", "global", "settings.json")), true);
  store.close();
  await hooks.dispose();
});

for (const mode of ["auto", "yolo"]) {
  test(`persisted ${mode} registers the passive event hook after an options-free restart`, async (t) => {
    const f = durableFixture(t);
    const first = await DefaultSelfEvolvePlugin(f.ctx);
    await waitForDurableStartup(first, `${mode}-startup-first`);
    const output = { parts: [] };
    if (mode === "auto") {
      await first["command.execute.before"]({ command: "self-evolve", sessionID: `${mode}-first`, arguments: "auto" }, output);
    } else {
      const skillRoot = path.join(f.root, "skills");
      fs.mkdirSync(skillRoot, { recursive: true });
      await first["command.execute.before"]({ command: "self-evolve", sessionID: `${mode}-first`, arguments: `yolo confirm --allowlist ${skillRoot}` }, output);
    }
    assert.match(output.parts.at(-1).text, new RegExp(`changed to ${mode}`, "i"));
    await first.dispose();

    const restarted = await DefaultSelfEvolvePlugin(f.ctx);
    assert.equal(typeof restarted.event, "function");
    assert.equal(restarted["chat.message"], undefined);
    await restarted.dispose();
  });
}

test("persisted manual returns no passive hook after restart", async (t) => {
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
  await automatic.dispose();
  const restarted = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(restarted.event, undefined);
  await restarted.dispose();
});

test("startup mode is not authority and cannot override an existing durable preference", async (t) => {
  const f = durableFixture(t);
  const hooks = await DefaultSelfEvolvePlugin(f.ctx, { mode: "auto" });
  assert.equal(hooks.event, undefined);
  await waitForDurableStartup(hooks, "startup-mode-not-authority");
  const store = openStore(f.stateRoot, { projectFingerprint: f.projectFingerprint });
  assert.equal(store.getSettings().global.mode, "manual");
  store.close();
  await hooks.dispose();
});

test("unavailable or corrupt durable state fails closed to no passive hook", async (t) => {
  const unavailable = await DefaultSelfEvolvePlugin({ directory: "/workspace/unavailable", client: {} }, { env: {} });
  assert.equal(unavailable.event, undefined);
  await unavailable.dispose();

  const f = durableFixture(t);
  const initialized = await DefaultSelfEvolvePlugin(f.ctx);
  await waitForDurableStartup(initialized, "corrupt-initialize");
  await initialized.dispose();
  fs.writeFileSync(path.join(f.stateRoot, "self-evolve", "global", "settings.json"), "{corrupt", "utf8");
  const corrupt = await DefaultSelfEvolvePlugin(f.ctx);
  assert.equal(corrupt.event, undefined);
  await waitForDurableStartup(corrupt, "corrupt-startup");
  const output = { parts: [] };
  await corrupt["command.execute.before"]({ command: "self-evolve", sessionID: "corrupt", arguments: "auto" }, output);
  assert.match(output.parts.at(-1).text, /durable integration unavailable/i);
  await corrupt.dispose();
});
