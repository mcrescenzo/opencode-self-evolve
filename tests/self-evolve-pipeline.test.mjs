import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplier } from "../self-evolve-applier.js";
import { createCommandPolicy, parseSelfEvolveCommand } from "../self-evolve-commands.js";
import * as inventoryModule from "../self-evolve-inventory.js";
import * as observationModule from "../self-evolve-observation.js";
import { createPipeline } from "../self-evolve-pipeline.js";
import { createPrivacyGuard } from "../self-evolve-privacy.js";
import * as schemasModule from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";
import * as synthesisModule from "../self-evolve-synthesis.js";
import SelfEvolvePlugin from "../self-evolve.js";

const PROJECT = inventoryModule.hashSkillContent("pipeline-project");
const SCOPE = inventoryModule.hashSkillContent("pipeline-scope");
const CURRENT = "---\nname: durable-review\ndescription: Reviews repeated commands with bounded evidence.\n---\n\n# Durable Review\n\nCheck the command once.\n";
const PROPOSED = `${CURRENT}\nWhen the same command recurs, verify the result before continuing.\n`;

function commandMessages(command, count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${command}-${index}`,
    role: "user",
    parts: [{ type: "text", text: `${command} --secret should-not-persist-${index}` }],
  }));
}

function fixture(t) {
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
            return { data: { info: { structured_output: {
              score: 0.96,
              evidenceLinked: true,
              nonDuplicative: true,
              reasons: ["The proposal is linked to deterministic repeated-command receipts."],
              recommendedAction: "accept",
            } } } };
          }
          const observationIds = runtime.store.readRecords("observation").map((record) => record.payload.id);
          const beforeTokens = Math.ceil(Buffer.byteLength(CURRENT) / 4);
          const afterTokens = Math.ceil(Buffer.byteLength(PROPOSED) / 4);
          return { data: { info: { structured_output: {
            action: "rewrite",
            targetLogicalName: "durable-review",
            proposedContent: PROPOSED,
            proposedContentHash: inventoryModule.hashSkillContent(PROPOSED),
            evidenceMapping: [{ claim: "Repeated commands need a verification step.", observationIds }],
            expectedBehavior: "Repeated commands are verified before the workflow continues.",
            counterExamples: ["A one-off command does not justify an evolution."],
            overlap: [],
            riskNotes: "Low-risk bounded skill guidance change.",
            evaluationScenarios: ["The same command appears in three independent episodes."],
            sizeDeltaBytes: Buffer.byteLength(PROPOSED) - Buffer.byteLength(CURRENT),
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
    const store = openStore(stateRoot, { projectName: "pipeline-test", projectFingerprint: PROJECT, now: () => ++clock });
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

async function seedEligible(f, prefix = "episode", command = "/verify") {
  let result;
  for (let index = 1; index <= 3; index += 1) {
    const sessionID = `${prefix}-${index}`;
    f.messages.set(sessionID, commandMessages(command));
    result = await scan(f, sessionID);
  }
  return result;
}

test("manual durable cycle persists, deduplicates, approves, applies, rolls back, and recovers cleanly", async (t) => {
  const f = fixture(t);
  const result = await seedEligible(f);
  assert.equal(result.result, "proposal-pending");
  assert.equal(result.proposal.state, "pending");
  assert.match(result.responseText, new RegExp(`/self-evolve approve ${result.proposal.id}`));
  assert.equal(result.eligibility.some((item) => item.eligible), true);
  assert.equal(f.calls.messages.every((call) => call.query.limit === 120), true);
  assert.equal(f.calls.create.length, 2, "only synthesizer and critic hidden sessions are created");
  assert.equal(f.calls.apply.length, 0, "manual scan must not apply");

  const observationsBefore = f.runtime.store.readRecords("observation").length;
  const proposalsBefore = f.runtime.store.readRecords("proposal").length;
  const promptsBefore = f.calls.prompt.length;
  const duplicate = await scan(f, "episode-3");
  assert.equal(duplicate.result, "proposal-pending");
  assert.match(duplicate.responseText, /cursor was already processed/);
  assert.equal(f.runtime.store.readRecords("observation").length, observationsBefore);
  assert.equal(f.runtime.store.readRecords("proposal").length, proposalsBefore);
  assert.equal(f.calls.prompt.length, promptsBefore);

  const parsed = parseSelfEvolveCommand(`/self-evolve approve ${result.proposal.id}`);
  assert.equal(parsed.ok, true);
  const approved = f.runtime.commands.execute(parsed.command, { projectFingerprint: PROJECT });
  assert.match(approved.responseText, /one-use review authorization/);
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

test("new cursors from one session correlate across episodes and cross the unchanged thresholds", async (t) => {
  const f = fixture(t);
  let result;
  for (let count = 2; count <= 4; count += 1) {
    f.messages.set("growing-session", commandMessages("/repeat", count));
    result = await scan(f, "growing-session");
  }
  assert.equal(result.result, "proposal-pending");
  assert.equal(result.eligibility.some((item) => item.eligible), true);
  assert.equal(f.runtime.store.readRecords("observation").length, 3);
  assert.equal(f.calls.create.length, 2);
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
  const parsed = parseSelfEvolveCommand(`approve ${result.proposal.id}`);
  f.runtime.commands.execute(parsed.command, { projectFingerprint: PROJECT });
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
  const parsed = parseSelfEvolveCommand(`approve ${id}`);
  reopened.commands.execute(parsed.command, { projectFingerprint: PROJECT });
  const applied = await reopened.pipeline.runApprovalFlow({ ctx: f.ctx, proposalId: id, actor: "restart-reviewer", mode: "auto", projectFingerprint: PROJECT });
  assert.equal(applied.result, "applied");
  assert.equal(fs.readFileSync(f.skillPath, "utf8"), PROPOSED);
});

test("durableAutonomy defaults false and preserves the legacy bare-command advisory scan", async () => {
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
  const hooks = await SelfEvolvePlugin(ctx, { pipeline: { runEvolutionCycle: async () => { pipelineCalls += 1; return { responseText: "durable" }; } }, now: () => 1_000 });
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
  const ctx = { directory: "/workspace/project", client: { session: {
    messages: async () => { throw new Error("legacy messages must not run"); },
    create: async () => { throw new Error("legacy analyzer must not run"); },
  } } };
  const hooks = await SelfEvolvePlugin(ctx, { durableAutonomy: true, pipeline, projectFingerprint: PROJECT, scopeFingerprint: SCOPE });
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "self-evolve", sessionID: "durable-dispatch", arguments: "scan" }, output);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionID, "durable-dispatch");
  assert.equal(calls[0].mode, "manual");
  assert.equal(output.parts.at(-1).text, "durable pipeline response");
  await hooks.dispose();
});
