import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ANALYZER_TOOLS } from "../analyzer-prompt.js";
import { SELF_EVOLVE_ANALYZER_AGENT, SELF_EVOLVE_SOURCE } from "../self-evolve-core.js";
import SelfEvolvePlugin from "../self-evolve.js";

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
