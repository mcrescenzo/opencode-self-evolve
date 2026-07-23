import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApplier } from "../self-evolve-applier.js";
import { createCommandPolicy } from "../self-evolve-commands.js";
import * as commandModule from "../self-evolve-commands.js";
import { createIntegration } from "../self-evolve-integration.js";
import * as inventoryModule from "../self-evolve-inventory.js";
import * as observationModule from "../self-evolve-observation.js";
import { createPipeline } from "../self-evolve-pipeline.js";
import { createPrivacyGuard } from "../self-evolve-privacy.js";
import * as schemasModule from "../self-evolve-schemas.js";
import { openStore, projectFingerprintFor } from "../self-evolve-store.js";
import * as synthesisModule from "../self-evolve-synthesis.js";
import SelfEvolvePlugin from "../self-evolve.js";

const PROJECT = inventoryModule.hashSkillContent("pipeline-project");
const SCOPE = inventoryModule.hashSkillContent("pipeline-scope");
const CURRENT = "---\nname: durable-review\ndescription: Reviews repeated commands with bounded evidence.\n---\n\n# Durable Review\n\nCheck the command once.\n";
const PROPOSED = `${CURRENT}\nWhen the same command recurs, verify the result before continuing.\n`;
const SYNTHESIS_CRASH_CHILD = fileURLToPath(new URL("./fixtures/synthesis-attempt-crash.mjs", import.meta.url));

function runKilledSynthesis(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SYNTHESIS_CRASH_CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`expected-SIGKILL:${code}:${signal}:${stderr}`)));
  });
}

function stateText(directory) {
  let result = "";
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) result += stateText(candidate);
    else if (entry.isFile()) result += fs.readFileSync(candidate, "utf8");
  }
  return result;
}

function commandMessages(command, count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${command}-${index}`,
    role: "user",
    parts: [{ type: "text", text: `${command} --secret should-not-persist-${index}` }],
  }));
}

function fixture(t, config = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-pipeline-"));
  const stateRoot = path.join(temp, "state");
  const skillRoot = path.join(temp, "skills");
  const skillDir = path.join(skillRoot, "durable-review");
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, CURRENT);
  const messages = new Map();
  let clock = 2_100_000_000_000;
  const calls = { messages: [], create: [], prompt: [], abort: [], apply: [] };
  const ctx = {
    directory: temp,
    client: {
      session: {
        messages: async (args) => {
          calls.messages.push(args);
          const id = args?.path?.id ?? args?.path?.sessionID ?? args?.sessionID;
          return { data: messages.get(id) ?? [] };
        },
        create: async (args) => {
          calls.create.push(args);
          return { data: { id: `hidden-analyzer-${calls.create.length}` } };
        },
        prompt: async (args) => {
          calls.prompt.push(args);
          const agent = args?.body?.agent ?? args?.agent;
          if (agent === synthesisModule.CRITIC_AGENT_NAME) {
            if (config.providerScenario === "critic-rejected") {
              return { data: { info: { structured_output: {
                score: 0.2, evidenceLinked: true, nonDuplicative: true,
                reasons: ["The proposal does not meet the quality threshold."], recommendedAction: "reject",
              } } } };
            }
            return { data: { info: { structured_output: {
              score: 0.96,
              evidenceLinked: true,
              nonDuplicative: true,
              reasons: ["The proposal is linked to deterministic repeated-command receipts."],
              recommendedAction: "accept",
            } } } };
          }
          if (config.providerScenario === "failed") return { data: { info: { structured_output: "not-json" } } };
          const promptText = args?.body?.parts?.[0]?.text ?? "";
          const evidenceText = /<UNTRUSTED_EVIDENCE_METADATA>\n([^\n]+)\n<\/UNTRUSTED_EVIDENCE_METADATA>/u.exec(promptText)?.[1];
          const observationIds = evidenceText
            ? JSON.parse(evidenceText).observations.map((item) => item.id)
            : runtime.store.readRecords("observation").map((record) => record.payload.id).slice(-3);
          const proposed = config.providerScenario === "no-change" ? CURRENT : PROPOSED;
          const beforeTokens = Math.ceil(Buffer.byteLength(CURRENT) / 4);
          const afterTokens = Math.ceil(Buffer.byteLength(proposed) / 4);
          return { data: { info: { structured_output: {
            action: config.providerScenario === "no-change" ? "no-op" : "rewrite",
            targetLogicalName: "durable-review",
            proposedContent: proposed,
            proposedContentHash: inventoryModule.hashSkillContent(proposed),
            evidenceMapping: [{ claim: "Repeated commands need a verification step.", observationIds }],
            expectedBehavior: "Repeated commands are verified before the workflow continues.",
            counterExamples: ["A one-off command does not justify an evolution."],
            overlap: [],
            riskNotes: "Low-risk bounded skill guidance change.",
            evaluationScenarios: ["The same command appears in three independent episodes."],
            sizeDeltaBytes: Buffer.byteLength(proposed) - Buffer.byteLength(CURRENT),
            approxTokenDelta: afterTokens - beforeTokens,
          } } } };
        },
        abort: async (args) => {
          calls.abort.push(args);
          return { data: {} };
        },
        promptAsync: async () => { throw new Error("promptAsync must never be called"); },
      },
      tui: {
        appendPrompt: async () => { throw new Error("appendPrompt must never be called"); },
      },
    },
  };
  let runtime;

  function openRuntime() {
    const durableStore = openStore(stateRoot, { projectName: "pipeline-test", projectFingerprint: PROJECT, now: () => ++clock });
    const store = config.failProposalContentPersist
      ? Object.freeze({
          ...durableStore,
          appendRecord(envelope) {
            if (envelope?.kind === "proposal-content") {
              return { ok: false, reason: "fixture-proposal-content-write-failed" };
            }
            return durableStore.appendRecord(envelope);
          },
        })
      : durableStore;
    const roots = inventoryModule.loadAllowlist({ globalSkillRoots: [skillRoot] }).canonicalRoots;
    const records = inventoryModule.discoverSkills(roots);
    const privacy = createPrivacyGuard({ consent: {}, projectFingerprint: PROJECT, store, now: () => ++clock });
    const realApplier = createApplier({ store, inventory: { records, canonicalRoots: roots }, privacy, now: () => ++clock });
    const applier = {
      applyProposal: async (args) => {
        calls.apply.push(args);
        return await realApplier.applyProposal(args);
      },
      rollbackApplied: (args) => realApplier.rollbackApplied(args),
      recoverPending: () => realApplier.recoverPending(),
      close: () => realApplier.close(),
    };
    const commands = createCommandPolicy({ store, privacy, now: () => ++clock });
    const pipeline = createPipeline({
      store,
      inventory: inventoryModule,
      privacy,
      synthesis: synthesisModule,
      applier,
      commands,
      schemas: schemasModule,
      observation: observationModule,
      now: () => ++clock,
    });
    runtime = { store, roots, records, privacy, applier, commands, pipeline };
    return runtime;
  }

  openRuntime();
  t.after(() => {
    try { runtime.pipeline.close(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
    synthesisModule.disposeSynthesis();
  });
  return { temp, stateRoot, skillRoot, skillPath, messages, calls, ctx, get runtime() { return runtime; }, reopen() { runtime.pipeline.close(); return openRuntime(); } };
}

function scan(f, sessionID, options = {}) {
  return f.runtime.pipeline.runEvolutionCycle({
    ctx: f.ctx,
    sessionID,
    projectFingerprint: PROJECT,
    scopeFingerprint: SCOPE,
    trigger: { kind: "manual", reason: "test-scan" },
    mode: "manual",
    options: { inventoryRecords: f.runtime.records, targetSkill: f.runtime.records[0], currentContent: CURRENT, ...options },
  });
}

test("durable message read timeout settles the cycle and permits later work", async (t) => {
  const f = fixture(t);
  const original = f.ctx.client.session.messages;
  f.ctx.client.session.messages = async () => await new Promise(() => {});
  const timed = await scan(f, "hung-messages", { sdkTimeoutMs: 2 });
  assert.equal(timed.result, "failed-closed");
  assert.match(timed.responseText, /session\.messages timed out/u);
  assert.equal(f.runtime.store.readRecords("audit-event").some((record) =>
    record.payload.details.action === "pipeline-failure"
    && /session\.messages timed out/u.test(record.payload.details.reason)), true);

  f.ctx.client.session.messages = original;
  f.messages.set("later-messages", commandMessages("/later"));
  const later = await scan(f, "later-messages", { sdkTimeoutMs: 20 });
  assert.equal(later.result, "no-eligible");
});

async function seedEligible(f, prefix = "episode", command = "/verify") {
  let result;
  for (let index = 1; index <= 3; index += 1) {
    const sessionID = `${prefix}-${index}`;
    f.messages.set(sessionID, commandMessages(command));
    result = await scan(f, sessionID);
  }
  return result;
}

function approveStoredProposal(store, item, timestamp) {
  const decision = schemasModule.makeDecision({
    proposalId: item.id,
    targetHash: item.skillTarget.currentHash,
    proposedContentHash: item.proposedContentHash,
    decisionVersion: item.decisionVersion + 1,
    actor: "integration-reviewer",
    timestamp,
    nonce: `pipeline-review-${item.id}`,
    priorState: "pending",
    newState: "approved",
  });
  const changed = store.runCas("proposal", item.id, "pending", (current) => schemasModule.transitionProposalState(current, decision, timestamp).state);
  assert.equal(changed.ok, true);
  assert.equal(store.appendRecord(schemasModule.wrapRecord("decision", decision, timestamp)).ok, true);
}

test("manual durable cycle persists, deduplicates, approves, applies, rolls back, and recovers cleanly", async (t) => {
  const f = fixture(t);
  const result = await seedEligible(f);
  assert.equal(result.result, "proposal-pending");
  assert.equal(result.proposal.state, "pending");
  assert.match(result.responseText, /Manual mode is advisory and cannot approve or apply/);
  assert.equal(result.eligibility.some((item) => item.eligible), true);
  assert.equal(f.calls.messages.every((call) => call.query.limit === 120), true);
  assert.equal(f.calls.create.length, 2, "only synthesizer and critic hidden sessions are created");
  assert.equal(f.calls.apply.length, 0, "manual scan must not apply");
  const outcomes = f.runtime.store.readRecords("audit-event").filter((record) => record.payload.details.action === "synthesis-outcome");
  assert.equal(outcomes.length, 1);
  assert.deepEqual(
    { status: outcomes[0].payload.details.status, success: outcomes[0].payload.details.success },
    { status: "accepted", success: true },
  );

  const observationsBefore = f.runtime.store.readRecords("observation").length;
  const proposalsBefore = f.runtime.store.readRecords("proposal").length;
  const promptsBefore = f.calls.prompt.length;
  const duplicate = await scan(f, "episode-3");
  assert.equal(duplicate.result, "proposal-pending");
  assert.match(duplicate.responseText, /cursor was already processed/);
  assert.equal(f.runtime.store.readRecords("observation").length, observationsBefore);
  assert.equal(f.runtime.store.readRecords("proposal").length, proposalsBefore);
  assert.equal(f.calls.prompt.length, promptsBefore);
  assert.equal(f.runtime.store.readRecords("audit-event").filter((record) => record.payload.details.action === "synthesis-outcome").length, 1);

  approveStoredProposal(f.runtime.store, result.proposal, result.proposal.synthesizedAt + 100);
  assert.equal(f.runtime.store.getRecord("proposal", result.proposal.id).payload.state, "approved");
  const applied = await f.runtime.pipeline.runApprovalFlow({ ctx: f.ctx, proposalId: result.proposal.id, actor: "integration-reviewer", mode: "auto", projectFingerprint: PROJECT });
  assert.equal(applied.result, "applied");
  assert.match(applied.responseText, /appliedHash [a-f0-9]{64}; auditId [a-f0-9]{64}/);
  assert.equal(fs.readFileSync(f.skillPath, "utf8"), PROPOSED);
  assert.equal(f.runtime.store.readRecords("audit-event").some((record) => record.payload.details?.["readback-verified"] === true), true);

  const rolledBack = await f.runtime.pipeline.runRollbackFlow({ ctx: f.ctx, proposalId: result.proposal.id, actor: "integration-reviewer", reason: "integration-test" });
  assert.equal(rolledBack.result, "rolled-back");
  assert.equal(fs.readFileSync(f.skillPath, "utf8"), CURRENT);
  const reopened = f.reopen();
  const recovery = await reopened.pipeline.runRecoveryOnStartup();
  assert.deepEqual(recovery, { healthy: true, recovered: 0, failed: 0, outcomes: [] });
});

test("non-eligible scan records observations and exact default threshold explanations without synthesis", async (t) => {
  const f = fixture(t);
  f.messages.set("one-incident", commandMessages("/verify"));
  const result = await scan(f, "one-incident");
  assert.equal(result.result, "no-eligible");
  assert.equal(result.observations.length, 1);
  assert.equal(result.eligibility.length, 1);
  assert.equal(result.eligibility[0].eligible, false);
  assert.match(result.eligibility[0].thresholdsMissed.minIndependentIncidents, /^3 /);
  assert.match(result.eligibility[0].thresholdsMissed.minDistinctSessions, /^2 /);
  assert.equal(f.runtime.store.readRecords("eligibility-explanation").length, 1);
  assert.equal(f.calls.create.length, 0);
});

test("passive synthesis reserves both provider slots before either hidden session starts", async (t) => {
  const f = fixture(t);
  const reservations = [];
  let result;
  for (let index = 1; index <= 3; index += 1) {
    const sessionID = `passive-budget-${index}`;
    f.messages.set(sessionID, commandMessages("/passive-budget"));
    result = await scan(f, sessionID, {
      reservePassiveProviderCalls(count, context) {
        reservations.push({ count, context });
        return { ok: false, reason: "passive-provider-budget-insufficient", requested: count, remaining: 1 };
      },
    });
  }
  assert.equal(result.result, "deferred");
  assert.equal(result.reason, "passive-provider-budget-insufficient");
  assert.equal(result.remaining, 1);
  assert.deepEqual(reservations.map((item) => item.count), [2]);
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.calls.prompt.length, 0);
  assert.equal(result.auditEvents.some((event) => event.details.action === "pipeline-passive-provider-reservation-denied"), true);
});

test("manual synthesis does not consume passive provider slots", async (t) => {
  const f = fixture(t);
  const result = await seedEligible(f, "manual-passive-budget", "/manual-passive-budget");
  assert.equal(result.result, "proposal-pending");
  assert.equal(f.calls.create.length, 2);
  assert.equal(f.runtime.store.readRecords("audit-event").filter((record) =>
    record.payload.details.action === "scheduler-budget" && record.payload.details.budgetType === "passive").length, 0);
});

test("production synthesis attempts persist exactly one bounded terminal status", async (t) => {
  for (const [providerScenario, status, success] of [
    ["no-change", "no-change", true],
    ["critic-rejected", "critic-rejected", false],
    ["failed", "failed", false],
  ]) {
    await t.test(providerScenario, async (t) => {
      const f = fixture(t, { providerScenario });
      await seedEligible(f, `status-${providerScenario}`, `/status-${providerScenario}`);
      const outcomes = f.runtime.store.readRecords("audit-event").filter((record) => record.payload.details.action === "synthesis-outcome");
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].payload.details.status, status);
      assert.equal(outcomes[0].payload.details.success, success);
      assert.deepEqual(Object.keys(outcomes[0].payload.details).sort(), ["action", "clusterId", "outcomeId", "projectFingerprint", "reasonCode", "status", "success", "terminalAt"].sort());
    });
  }
});

test("real mocked synthesis and critic history alone crosses the yolo threshold", async (t) => {
  const f = fixture(t);
  const scheduler = { createScheduler: () => ({ setMode() {}, getCircuitBreaker: () => ({ open: false }), handleEvent() {}, recordWorkResult() {}, dispose() {} }) };
  const integration = createIntegration({
    store: f.runtime.store,
    inventory: inventoryModule,
    privacy: f.runtime.privacy,
    schemas: schemasModule,
    observation: observationModule,
    synthesisModule,
    applier: f.runtime.applier,
    commands: commandModule,
    pipeline: { createPipeline },
    scheduler,
    options: { ctx: f.ctx, rolloutGates: { yoloEnablementThreshold: { minSynthesesObserved: 2, minSuccessRate: 1 } } },
    now: () => 2_100_100_000_000 + f.calls.prompt.length,
  });
  integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: f.runtime.roots });
  const cycleOptions = { inventoryRecords: f.runtime.records, targetSkill: f.runtime.records[0], currentContent: CURRENT };

  let first;
  for (let index = 1; index <= 3; index += 1) {
    const sessionID = `integrated-first-${index}`;
    f.messages.set(sessionID, commandMessages("/integrated-first"));
    first = await integration.runEvolutionCycle({ sessionID, projectFingerprint: PROJECT, scopeFingerprint: SCOPE, trigger: "test", options: cycleOptions });
  }
  assert.equal(first.result, "proposal-ready", JSON.stringify(first.auditEvents));
  assert.equal(f.calls.apply.length, 0);
  const rejected = schemasModule.makeDecision({
    proposalId: first.proposal.id,
    targetHash: first.proposal.skillTarget.currentHash,
    proposedContentHash: first.proposal.proposedContentHash,
    decisionVersion: first.proposal.decisionVersion + 1,
    actor: "self-evolve-tui",
    timestamp: first.proposal.synthesizedAt + 1,
    nonce: "reject-first-rollout-proposal",
    priorState: "pending",
    newState: "rejected",
  });
  const rejection = await integration.__testBridge.decide({ decision: rejected });
  assert.equal(rejection.ok, true, JSON.stringify(rejection));

  let second;
  let secondSessionID;
  for (let index = 1; index <= 3; index += 1) {
    const sessionID = `integrated-second-${index}`;
    secondSessionID = sessionID;
    f.messages.set(sessionID, commandMessages("/integrated-second"));
    second = await integration.runEvolutionCycle({ sessionID, projectFingerprint: PROJECT, scopeFingerprint: SCOPE, trigger: "test", options: cycleOptions });
    if (second.result === "applied") break;
  }
  assert.equal(second.result, "applied", JSON.stringify(second.auditEvents));
  assert.equal(f.calls.apply.length, 1);
  assert.equal(f.runtime.store.readRecords("audit-event").filter((record) => record.payload.details.action === "synthesis-outcome").length, 2);

  const duplicate = await integration.runEvolutionCycle({ sessionID: secondSessionID, projectFingerprint: PROJECT, scopeFingerprint: SCOPE, trigger: "replay", options: cycleOptions });
  assert.match(duplicate.responseText, /already processed/u);
  assert.equal(f.runtime.store.readRecords("audit-event").filter((record) => record.payload.details.action === "synthesis-outcome").length, 2);
});

test("proposal-content persistence failure records one failed outcome and grants no yolo authority", async (t) => {
  const f = fixture(t, { failProposalContentPersist: true });
  const scheduler = { createScheduler: () => ({ setMode() {}, getCircuitBreaker: () => ({ open: false }), handleEvent() {}, recordWorkResult() {}, dispose() {} }) };
  const integration = createIntegration({
    store: f.runtime.store,
    inventory: inventoryModule,
    privacy: f.runtime.privacy,
    schemas: schemasModule,
    observation: observationModule,
    synthesisModule,
    applier: f.runtime.applier,
    commands: commandModule,
    pipeline: { createPipeline },
    scheduler,
    options: { ctx: f.ctx, rolloutGates: { yoloEnablementThreshold: { minSynthesesObserved: 1, minSuccessRate: 1 } } },
    now: () => 2_100_200_000_000 + f.calls.prompt.length,
  });
  integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: f.runtime.roots });
  const cycleOptions = { inventoryRecords: f.runtime.records, targetSkill: f.runtime.records[0], currentContent: CURRENT };
  let result;
  for (let index = 1; index <= 3; index += 1) {
    const sessionID = `content-failure-${index}`;
    f.messages.set(sessionID, commandMessages("/content-failure"));
    result = await integration.runEvolutionCycle({ sessionID, projectFingerprint: PROJECT, scopeFingerprint: SCOPE, trigger: "test", options: cycleOptions });
  }
  assert.equal(result.result, "failed-closed");
  const outcomes = f.runtime.store.readRecords("audit-event").filter((record) => record.payload.details.action === "synthesis-outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].payload.details.status, "failed");
  assert.equal(outcomes[0].payload.details.success, false);
  assert.equal(outcomes[0].payload.details.reasonCode, "proposal-content-persistence-failed");
  assert.equal(f.runtime.store.readRecords("proposal-content").length, 0);

  const proposal = f.runtime.store.readRecords("proposal").map((record) => record.payload).findLast((item) => item.criticPassed);
  let applies = 0;
  const authorityProbe = createIntegration({
    store: f.runtime.store,
    inventory: {},
    privacy: f.runtime.privacy,
    schemas: schemasModule,
    observation: {},
    synthesisModule: {},
    applier: { circuitBreakerOpen: () => false, recoverPending: () => [], close() {}, applyProposal: async () => { applies += 1; return { ok: true }; } },
    commands: commandModule,
    pipeline: { createPipeline(deps) { return { runEvolutionCycle: async () => {
      const applied = await deps.applier.applyProposal({ proposal, mode: "yolo", headless: true });
      return { result: applied.ok ? "applied" : "proposal-ready" };
    }, runApprovalFlow: async () => ({}), runRollbackFlow: async () => ({}) }; } },
    scheduler,
    options: { rolloutGates: { yoloEnablementThreshold: { minSynthesesObserved: 1, minSuccessRate: 1 } } },
    now: () => 2_100_200_000_100,
  });
  assert.equal((await authorityProbe.runEvolutionCycle({ projectFingerprint: PROJECT })).result, "proposal-ready");
  assert.equal(applies, 0);
});

test("new cursors from one session cannot manufacture distinct-session eligibility", async (t) => {
  const f = fixture(t);
  let result;
  for (const count of [2, 4, 6]) {
    f.messages.set("growing-session", commandMessages("/repeat", count));
    result = await scan(f, "growing-session");
  }
  assert.equal(result.result, "no-eligible");
  assert.equal(result.eligibility.some((item) => item.eligible), false);
  assert.match(result.eligibility[0].thresholdsMissed.minDistinctSessions, /actual 1/);
  assert.equal(f.runtime.store.readRecords("observation").length, 3);
  assert.equal(f.calls.create.length, 0);
});

test("a shifted full message window processes only the suffix after the prior cursor", async (t) => {
  const f = fixture(t);
  const initial = Array.from({ length: 120 }, (_, index) => ({ id: `shift-${index}`, role: "assistant", parts: [{ type: "text", text: `status ${index}` }] }));
  f.messages.set("shifted-window", initial);
  assert.equal((await scan(f, "shifted-window")).observations.length, 0);

  const shifted = [...initial.slice(5), ...commandMessages("/shifted-new", 5).map((message, index) => ({ ...message, id: `shift-new-${index}` }))];
  f.messages.set("shifted-window", shifted);
  const result = await scan(f, "shifted-window");
  assert.equal(result.observations.length, 1);
  assert.equal(f.runtime.store.readRecords("observation").length, 1);
});

test("a cursor gap advances without creating evidence from unknown overlap", async (t) => {
  const f = fixture(t);
  const initial = Array.from({ length: 120 }, (_, index) => ({ id: `gap-old-${index}`, role: "assistant", parts: [{ type: "text", text: `old ${index}` }] }));
  f.messages.set("cursor-gap", initial);
  await scan(f, "cursor-gap");

  f.messages.set("cursor-gap", Array.from({ length: 120 }, (_, index) => ({ id: `gap-new-${index}`, role: "user", parts: [{ type: "text", text: "/gap-evidence" }] })));
  const result = await scan(f, "cursor-gap");
  assert.equal(result.observations.length, 0);
  assert.equal(f.runtime.store.readRecords("observation").length, 0);
  assert.equal(result.auditEvents.some((event) => event.details.action === "message-cursor-gap"), true);
});

test("a transient empty message window preserves the established cursor", async (t) => {
  const f = fixture(t);
  const initial = commandMessages("/transient-empty", 2);
  f.messages.set("transient-empty", initial);
  assert.equal((await scan(f, "transient-empty")).observations.length, 1);
  const before = f.runtime.store.readRecords("episode-cursor").at(-1).payload;

  f.messages.set("transient-empty", []);
  const empty = await scan(f, "transient-empty");
  assert.equal(empty.observations.length, 0);
  assert.equal(empty.auditEvents.some((event) => event.details.action === "message-window-empty"), true);
  assert.equal(f.runtime.store.readRecords("episode-cursor").at(-1).payload.lastObservedMessageHash, before.lastObservedMessageHash);

  const shifted = [
    initial.at(-1),
    { id: "transient-new-1", role: "user", parts: [{ type: "text", text: "/transient-empty --new" }] },
    { id: "transient-new-2", role: "user", parts: [{ type: "text", text: "/transient-empty --newer" }] },
  ];
  f.messages.set("transient-empty", shifted);
  const resumed = await scan(f, "transient-empty");
  assert.equal(resumed.observations.length, 1);
  assert.equal(resumed.observations[0].structuredFields.occurrences, 2);
  assert.equal(f.runtime.store.readRecords("observation").length, 2);
});

test("duplicate cursor suppression creates neither observations nor synthesis", async (t) => {
  const f = fixture(t);
  f.messages.set("duplicate", commandMessages("/duplicate"));
  const first = await scan(f, "duplicate");
  const counts = {
    observations: f.runtime.store.readRecords("observation").length,
    prompts: f.calls.prompt.length,
  };
  const second = await scan(f, "duplicate");
  assert.equal(first.result, "no-eligible");
  assert.equal(second.result, "no-eligible");
  assert.match(second.responseText, /already processed/);
  assert.equal(f.runtime.store.readRecords("observation").length, counts.observations);
  assert.equal(f.calls.prompt.length, counts.prompts);
});

test("durable records exclude transcript bodies and analyzer IDs while hidden sessions deny all tools", async (t) => {
  const f = fixture(t);
  const result = await seedEligible(f, "privacy");
  assert.equal(result.result, "proposal-pending");
  const archive = JSON.stringify(f.runtime.store.exportAll());
  assert.doesNotMatch(archive, /should-not-persist/);
  assert.doesNotMatch(archive, /hidden-analyzer-/);
  assert.doesNotMatch(archive, /privacy-[123]/);
  assert.doesNotMatch(archive, /"message"\s*:\s*\{[^}]*"content"/);
  for (const call of f.calls.create) {
    assert.equal(call.body.tools, undefined);
    assert.ok(call.body.permission.some((rule) => rule.permission === "*" && rule.action === "deny"));
  }
  for (const call of f.calls.prompt) assert.equal(call.body.tools, undefined);
});

test("manual run never calls apply and manual approval remains fail-closed", async (t) => {
  const f = fixture(t);
  const result = await seedEligible(f, "manual-only");
  assert.equal(f.calls.apply.length, 0);
  approveStoredProposal(f.runtime.store, result.proposal, result.proposal.synthesizedAt + 100);
  const approval = await f.runtime.pipeline.runApprovalFlow({ ctx: f.ctx, proposalId: result.proposal.id, actor: "reviewer", mode: "manual", projectFingerprint: PROJECT });
  assert.equal(approval.result, "failed-closed");
  assert.match(approval.responseText, /manual-advisory-only/);
  assert.equal(fs.readFileSync(f.skillPath, "utf8"), CURRENT);
});

test("pending proposal survives pipeline restart and can be approved afterward", async (t) => {
  const f = fixture(t);
  const result = await seedEligible(f, "restart-mid-cycle");
  const id = result.proposal.id;
  const reopened = f.reopen();
  assert.equal(reopened.store.getRecord("proposal", id).payload.state, "pending");
  approveStoredProposal(reopened.store, result.proposal, result.proposal.synthesizedAt + 100);
  const applied = await reopened.pipeline.runApprovalFlow({ ctx: f.ctx, proposalId: id, actor: "restart-reviewer", mode: "auto", projectFingerprint: PROJECT });
  assert.equal(applied.result, "applied");
  assert.equal(fs.readFileSync(f.skillPath, "utf8"), PROPOSED);
});

test("proposal-content readers reject mixed hashes, duplicate indexes, and incomplete chunks", async (t) => {
  const f = fixture(t);
  const result = await seedEligible(f, "content-attacks");
  const proposal = result.proposal;
  assert.equal(f.runtime.pipeline.readProposalContent(proposal), PROPOSED);

  const wrongHash = inventoryModule.hashSkillContent("wrong proposal body");
  const rejected = f.runtime.store.appendRecord(schemasModule.wrapRecord("proposal-content", schemasModule.makeProposalContent({
    proposalId: proposal.id, contentHash: wrongHash, contentEncoding: "base64", chunkIndex: 0, chunkCount: 1,
    content: Buffer.from("wrong proposal body").toString("base64"),
  }), proposal.synthesizedAt + 1));
  assert.equal(rejected.reason, "proposal-content-binding-mismatch");

  const first = f.runtime.store.readRecords("proposal-content")[0].payload;
  const duplicate = schemasModule.makeProposalContent({ ...first, content: Buffer.from("attacker chunk").toString("base64") });
  assert.equal(f.runtime.store.appendRecord(schemasModule.wrapRecord("proposal-content", duplicate, proposal.synthesizedAt + 2)).ok, true);
  assert.equal(f.runtime.pipeline.readProposalContent(proposal), null, "duplicate/mixed chunk index must reject the whole body");

  const partialBody = "partial proposal body";
  const partialHash = inventoryModule.hashSkillContent(partialBody);
  const partial = schemasModule.makeProposal({ ...proposal, id: "partial-proposal", proposedContentHash: partialHash });
  const other = schemasModule.makeProposal({ ...proposal, id: "other-proposal", proposedContentHash: partialHash });
  f.runtime.store.appendRecord(schemasModule.wrapRecord("proposal", partial, proposal.synthesizedAt + 3));
  f.runtime.store.appendRecord(schemasModule.wrapRecord("proposal", other, proposal.synthesizedAt + 3));
  const encoded = Buffer.from(partialBody).toString("base64");
  f.runtime.store.appendRecord(schemasModule.wrapRecord("proposal-content", schemasModule.makeProposalContent({
    proposalId: partial.id, contentHash: partialHash, contentEncoding: "base64", chunkIndex: 0, chunkCount: 2, content: encoded.slice(0, 4),
  }), proposal.synthesizedAt + 4));
  f.runtime.store.appendRecord(schemasModule.wrapRecord("proposal-content", schemasModule.makeProposalContent({
    proposalId: other.id, contentHash: partialHash, contentEncoding: "base64", chunkIndex: 1, chunkCount: 2, content: encoded.slice(4),
  }), proposal.synthesizedAt + 4));
  assert.equal(f.runtime.pipeline.readProposalContent(partial), null, "a chunk bound to another proposal cannot complete a partial body");
});

test("real process kills recover every admitted synthesis attempt exactly once", async (t) => {
  const points = [
    ["synthesis-after-admission", "failed", 0],
    ["synthesis-after-provider-return", "failed", 1],
    ["synthesis-after-draft-proposal", "failed", 1],
    ["pipeline-after-critic-transaction", "failed", 2],
    ["pipeline-after-content-chunks", "accepted", 2],
    ["pipeline-after-outcome-append", "accepted", 2],
  ];
  for (const [point, expectedStatus, expectedCalls] of points) {
    await t.test(point, async () => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-synthesis-crash-"));
      const marker = path.join(temp, "provider-calls.log");
      fs.writeFileSync(marker, "");
      try {
        await runKilledSynthesis([temp, PROJECT, point, marker]);
        const beforeRecoveryCalls = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length;
        assert.equal(beforeRecoveryCalls, expectedCalls);
        let store = openStore(temp, { projectFingerprint: PROJECT, now: () => 2_300_000_000_000, staleLockMs: 1 });
        let pipeline = createPipeline({
          store, inventory: inventoryModule, privacy: {}, synthesis: {},
          applier: { close() {} }, commands: {}, schemas: schemasModule, observation: observationModule,
          now: () => 2_300_000_000_001,
        });
        const recovered = pipeline.recoverSynthesisAttempts();
        const attempts = store.readRecords("synthesis-attempt");
        const outcomes = store.readRecords("audit-event").map((record) => schemasModule.parseSynthesisOutcomeAuditEvent(record.payload)).filter(Boolean);
        assert.equal(attempts.length, 1);
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].status, expectedStatus);
        const proposal = store.getRecord("proposal", attempts[0].payload.proposalId)?.payload;
        assert.equal(proposal?.state === "critic-pending" || (proposal?.state === "pending" && proposal.criticPassed !== true), false);
        if (expectedStatus === "failed") {
          assert.equal(store.readRecords("proposal-content").length, 0);
          assert.doesNotMatch(stateText(store.stateDir), /"kind":"proposal-content"/u);
          assert.equal(proposal === undefined || ["failed-closed", "rejected", "superseded", "rolled-back"].includes(proposal.state), true, "failed recovery must release duplicate suppression");
        }
        const countAfterFirstRecovery = outcomes.length;
        pipeline.close();
        store = openStore(temp, { projectFingerprint: PROJECT, now: () => 2_300_000_000_100, staleLockMs: 1 });
        pipeline = createPipeline({
          store, inventory: inventoryModule, privacy: {}, synthesis: {},
          applier: { close() {} }, commands: {}, schemas: schemasModule, observation: observationModule,
          now: () => 2_300_000_000_101,
        });
        assert.deepEqual(pipeline.recoverSynthesisAttempts(), []);
        assert.equal(store.readRecords("audit-event").map((record) => schemasModule.parseSynthesisOutcomeAuditEvent(record.payload)).filter(Boolean).length, countAfterFirstRecovery);
        assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length, beforeRecoveryCalls, "boot recovery must not call a provider");
        pipeline.close();
        assert.equal(recovered.length, expectedStatus === "accepted" && point === "pipeline-after-outcome-append" ? 0 : 1);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
        synthesisModule.disposeSynthesis();
      }
    });
  }
});

test("durableAutonomy false preserves the legacy bare-command advisory scan", async () => {
  SelfEvolvePlugin.__test.__resetRegistryForTests();
  let pipelineCalls = 0;
  let analyzerCalls = 0;
  const legacyProposal = {
    proposal: {
      title: "Add a repo-local troubleshooting note",
      summary: "Repeated local failures justify a focused troubleshooting note for future sessions.",
      evidence: ["Repeated troubleshooting failures connect directly to the requested troubleshooting note."],
      target: { path: "src/troubleshooting.md", surface: "repo docs", symbol: "" },
      placement: "repo-local",
      risk: "low",
      riskMitigation: "Keep the proposed troubleshooting note bounded and advisory.",
      confidence: 0.9,
      suggestedAction: "Ask whether to add the repo-local troubleshooting note after explicit review.",
    },
    reason: "Specific advisory improvement.",
  };
  const ctx = {
    directory: "/workspace/project",
    client: { session: {
      messages: async () => ({ data: commandMessages("/legacy") }),
      create: async () => ({ data: { id: "legacy-hidden" } }),
      prompt: async () => { analyzerCalls += 1; return { data: { parts: [{ type: "text", text: JSON.stringify(legacyProposal) }] } }; },
      abort: async () => ({ data: {} }),
    } },
  };
  const hooks = await SelfEvolvePlugin(ctx, { durableAutonomy: false, pipeline: { runEvolutionCycle: async () => { pipelineCalls += 1; return { responseText: "durable" }; } }, now: () => 1_000 });
  await hooks.config({ model: "openai/mock", agent: {} });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "legacy-default", arguments: "" }, output);
  assert.equal(pipelineCalls, 0);
  assert.equal(analyzerCalls, 1);
  assert.match(output.parts.at(-1).text, /Manual self-evolve scan found proposal/);
  await hooks.dispose();
});

test("durableAutonomy scan dispatches to the injected pipeline without invoking the legacy analyzer", async () => {
  SelfEvolvePlugin.__test.__resetRegistryForTests();
  const calls = [];
  const pipeline = {
    runEvolutionCycle: async (input) => {
      calls.push(input);
      return { responseText: "durable pipeline response" };
    },
    close() {},
  };
  const ctx = { directory: "/workspace/project", client: {
    global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) },
    session: {
      messages: async () => { throw new Error("legacy messages must not run"); },
      create: async () => { throw new Error("legacy analyzer must not run"); },
    },
  } };
  const projectFingerprint = projectFingerprintFor("", ctx.directory);
  const hooks = await SelfEvolvePlugin(ctx, { pipeline, projectFingerprint, scopeFingerprint: SCOPE });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const startup = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "durable-dispatch-startup", arguments: "status" }, startup);
    if (!/startup-validation-pending/u.test(startup.parts.at(-1).text)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "durable-dispatch", arguments: "scan" }, output);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionID, "durable-dispatch");
  assert.equal(calls[0].mode, "manual");
  assert.equal(output.parts.at(-1).text, "durable pipeline response");
  await hooks.dispose();
});

test("durableAutonomy routes mode commands through the durable integration", async () => {
  SelfEvolvePlugin.__test.__resetRegistryForTests();
  const calls = [];
  const integration = {
    handleCommand: async (input) => {
      calls.push(input);
      return { responseText: "Self-evolve mode preference changed to auto." };
    },
    close() {},
  };
  const ctx = { directory: "/workspace/project", client: { global: { health: async () => ({ data: { healthy: true, version: "1.18.3" } }) }, session: {} } };
  const hooks = await SelfEvolvePlugin(ctx, {
    pipeline: integration,
    projectFingerprint: projectFingerprintFor("", ctx.directory),
    scopeFingerprint: SCOPE,
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const startup = { parts: [] };
    await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "durable-mode-startup", arguments: "status" }, startup);
    if (!/startup-validation-pending/u.test(startup.parts.at(-1).text)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  calls.length = 0;
  const output = { parts: [] };

  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "durable-mode", arguments: "auto" }, output);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "auto");
  assert.equal(calls[0].sessionID, "durable-mode");
  assert.equal(calls[0].projectFingerprint, projectFingerprintFor("", ctx.directory));
  assert.equal(calls[0].scopeFingerprint, SCOPE);
  assert.equal(output.parts.at(-1).text, "Self-evolve mode preference changed to auto.");
  await hooks.dispose();
});
