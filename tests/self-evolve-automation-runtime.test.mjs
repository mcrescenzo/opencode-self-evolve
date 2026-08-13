import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as inventory from "../self-evolve-inventory.js";
import * as observation from "../self-evolve-observation.js";
import { createGlobalDecisionDomain } from "../self-evolve-applier.js";
import { createPipeline } from "../self-evolve-pipeline.js";
import { createPrivacyGuard } from "../self-evolve-privacy.js";
import { buildGlobalRecommendationProjection } from "../self-evolve-projection.js";
import * as schemas from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";
import * as synthesis from "../self-evolve-synthesis.js";

const PROJECT = inventory.hashSkillContent("automation-runtime-project");
const SCOPE = inventory.hashSkillContent("automation-runtime-scope");
const CURRENT = "---\nname: durable-review\ndescription: Reviews repeated commands with bounded evidence.\n---\n\n# Durable Review\n\nCheck the command once.\n";
const PROPOSED = `${CURRENT}\nWhen the same command recurs, verify the result before continuing.\n`;
const AUTOMATION_PEER = path.join(import.meta.dirname, "fixtures", "automation-state-peer.mjs");

function crashOffPeer(stateRoot, faultPoint) {
  const resultPath = path.join(stateRoot, `crash-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AUTOMATION_PEER, stateRoot, "b".repeat(64), "off", resultPath, faultPoint], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function fixture(t, { synthesisModule = synthesis, breakerOpen = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-automation-runtime-"));
  const stateRoot = path.join(temp, "state");
  const skillRoot = path.join(temp, "skills");
  const skillDir = path.join(skillRoot, "durable-review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), CURRENT);
  let clock = 2_100_000_000_000;
  const calls = { messages: 0, create: 0, prompt: 0, apply: 0 };
  const store = openStore(stateRoot, {
    projectFingerprint: PROJECT,
    projectName: "automation-runtime",
    now: () => ++clock,
    staleLockMs: 1,
    lockTimeoutMs: 10_000,
  });
  const privacy = createPrivacyGuard({ consent: {}, projectFingerprint: PROJECT, store, now: () => ++clock });
  const pipeline = createPipeline({
    store,
    inventory,
    privacy,
    synthesis: synthesisModule,
    applier: {
      circuitBreakerOpen: () => breakerOpen,
      apply: () => { calls.apply += 1; throw new Error("automatic-apply-prohibited"); },
    },
    commands: {},
    schemas,
    observation,
    now: () => ++clock,
  });
  const root = schemas.makeApprovedGlobalRoot({ canonicalPath: skillRoot, canUpdate: true, canCreate: false });
  const policy = schemas.makeGlobalRootPolicy({ roots: [root], creationRootId: null, selectedBy: "operator", updatedAt: 1 });
  const legacyCatalog = inventory.buildGlobalSkillCatalog(policy, { projectRoot: temp });
  const catalog = inventory.adaptHostGlobalSkillCatalog({
    ok: true,
    records: legacyCatalog.records,
    catalogGenerationHash: legacyCatalog.catalogGenerationHash,
    sourceReceiptHash: inventory.hashSkillContent("accepted-host-projection"),
    diagnostics: [],
  }, { updatedAt: 1 });
  assert.equal(catalog.ok, true);
  assert.equal(catalog.hostAuthoritative, true);
  assert.equal(catalog.policy.selectedBy, "host");
  assert.equal(catalog.policy.creationRootId, null);
  const messages = new Map();
  const ctx = {
    directory: temp,
    client: {
      session: {
        messages: async ({ path: requestPath }) => {
          calls.messages += 1;
          return { data: messages.get(requestPath.id) ?? [] };
        },
        create: async () => ({ data: { id: `hidden-${++calls.create}` } }),
        prompt: async (request) => {
          calls.prompt += 1;
          const agent = request.body.agent;
          if (agent === synthesis.CRITIC_AGENT_NAME) {
            return { data: { info: { structured_output: {
              score: 0.97,
              evidenceLinked: true,
              nonDuplicative: true,
              reasons: ["The bounded evidence supports the reusable verification step."],
              recommendedAction: "accept",
            } } } };
          }
          return { data: { info: { structured_output: {
            action: "recommend",
            logicalName: "durable-review",
            proposedContent: PROPOSED,
            rationale: "Add one reusable verification step for repeated commands.",
            overlap: [],
            projectAssumptions: [],
          } } } };
        },
        delete: async () => ({ data: {} }),
        abort: async () => ({ data: {} }),
      },
    },
  };
  t.after(() => {
    try { pipeline.close(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { temp, stateRoot, store, pipeline, catalog, messages, calls, ctx };
}

function commandMessages(command = "/verify", skillName = "durable-review") {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `${command}-${index}`,
    role: "user",
    parts: [
      { type: "text", text: `${command} --case ${index}` },
      ...(skillName === null ? [] : [
        { type: "tool", tool: "skill", state: { status: "completed", input: { name: skillName } } },
      ]),
    ],
  }));
}

function runCycle(f, sessionID, optionOverrides = {}) {
  return f.pipeline.runEvolutionCycle({
    ctx: f.ctx,
    sessionID,
    projectFingerprint: PROJECT,
    scopeFingerprint: SCOPE,
    trigger: { kind: "manual", reason: "automation-runtime-test" },
    mode: "auto",
    options: { globalSkillCatalog: f.catalog, projectRoot: f.temp, ...optionOverrides },
  });
}

function stateSnapshot(root) {
  const visit = (directory) => fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return visit(absolute);
        if (!entry.isFile() || entry.name.endsWith(".lock")) return [];
        return [[path.relative(root, absolute), fs.readFileSync(absolute, "base64")]];
      })
    : [];
  return visit(root).sort(([left], [right]) => left.localeCompare(right));
}

function refreshedHostCatalog(f) {
  const legacy = inventory.buildGlobalSkillCatalog(f.catalog.policy, { projectRoot: f.temp });
  return inventory.adaptHostGlobalSkillCatalog({
    ok: legacy.ok,
    records: legacy.records,
    catalogGenerationHash: legacy.catalogGenerationHash,
    sourceReceiptHash: inventory.hashSkillContent(`refreshed-host-projection:${legacy.catalogGenerationHash}`),
    diagnostics: [],
  }, { updatedAt: 2 });
}

function globalDecision(recommendation, action, nonce) {
  return schemas.makeGlobalDecision({
    recommendationId: recommendation.recommendationId,
    supportSetHash: recommendation.supportSetHash,
    targetBindingHash: recommendation.targetBinding.bindingHash,
    targetHash: action === "undo" ? recommendation.proposedContentHash : recommendation.targetBinding.currentHash,
    proposedContentHash: recommendation.proposedContentHash,
    decisionVersion: recommendation.decisionVersion + 1,
    actorRole: "operator",
    timestamp: recommendation.synthesizedAt,
    nonce,
    priorState: action === "undo" ? "applied" : "pending",
    newState: action === "apply" ? "approved" : action === "undo" ? "undo-approved" : "rejected",
  });
}

test("Off returns before session reads and performs no autonomous durable mutation", async (t) => {
  const f = fixture(t);
  const off = f.store.transitionAutomation({
    transitionId: "runtime-off",
    expectedGeneration: 1,
    action: "set-automatic-recommendations",
    enabled: false,
  });
  assert.equal(off.ok, true);
  f.messages.set("off-session", commandMessages());
  const before = stateSnapshot(f.stateRoot);
  const result = await runCycle(f, "off-session");
  assert.equal(result.result, "automatic-disabled");
  assert.equal(f.calls.messages, 0);
  assert.deepEqual(stateSnapshot(f.stateRoot), before);
});

test("re-enabling establishes a cursor baseline and observes only future messages", async (t) => {
  const f = fixture(t, { synthesisModule: {} });
  f.messages.set("future-only", commandMessages("/before"));
  const first = await runCycle(f, "future-only");
  assert.equal(first.observations.length, 1);
  assert.equal(first.observations[0].automationGeneration, 1);
  assert.equal(f.store.transitionAutomation({ transitionId: "future-off", expectedGeneration: 1, action: "set-automatic-recommendations", enabled: false }).ok, true);
  assert.equal(f.store.transitionAutomation({ transitionId: "future-on", expectedGeneration: 2, action: "set-automatic-recommendations", enabled: true }).ok, true);

  f.messages.set("future-only", [...commandMessages("/before"), ...commandMessages("/during-off")]);
  const baseline = await runCycle(f, "future-only");
  assert.equal(baseline.result, "automatic-baselined");
  assert.equal(baseline.observations.length, 0);
  assert.equal(f.store.readRecords("observation").filter((record) => record.payload.automationGeneration === 3).length, 0);

  f.messages.set("future-only", [...f.messages.get("future-only"), ...commandMessages("/after")]);
  const future = await runCycle(f, "future-only");
  assert.equal(future.observations.length, 1);
  assert.equal(future.observations[0].automationGeneration, 3);
  assert.equal(f.store.readRecords("observation").some((record) =>
    record.payload.automationGeneration === 3
    && record.payload.structuredFields.receiptType === "repeated-command"), true);
  assert.equal(f.store.readGlobalRecommendations().length, 0);
  assert.equal(f.store.readGlobalCandidates().some((candidate) =>
    candidate.automationGeneration === 1 && candidate.state === "superseded"), true);
  assert.equal(f.store.readGlobalCandidates().some((candidate) =>
    candidate.automationGeneration === 3 && candidate.state === "collecting"), true);
});

test("restoring a required permission leaves automation Off until explicit On", async (t) => {
  const f = fixture(t);
  assert.equal(f.store.transitionAutomation({
    transitionId: "revoke-runtime-excerpts",
    expectedGeneration: 1,
    action: "set-permission",
    permission: "sanitizedExcerpts",
    enabled: false,
  }).ok, true);
  assert.equal(f.store.transitionAutomation({
    transitionId: "restore-runtime-excerpts",
    expectedGeneration: 2,
    action: "set-permission",
    permission: "sanitizedExcerpts",
    enabled: true,
  }).ok, true);
  f.messages.set("restored-but-off", commandMessages());
  const before = stateSnapshot(f.stateRoot);
  const result = await runCycle(f, "restored-but-off");
  assert.equal(result.result, "automatic-disabled");
  assert.equal(f.store.getAutomationState().enabled, false);
  assert.equal(f.calls.messages, 0);
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.prompt, 0);
  assert.equal(f.calls.apply, 0);
  assert.deepEqual(stateSnapshot(f.stateRoot), before);
});

test("Off supersedes unfinished generation work, preserves a published recommendation, and fences a peer stamp", async (t) => {
  const f = fixture(t);
  for (const sessionID of ["recommend-1", "recommend-2"]) {
    f.messages.set(sessionID, commandMessages());
    await runCycle(f, sessionID);
  }
  const recommendation = f.store.readGlobalRecommendations()[0];
  assert.equal(recommendation?.state, "pending");
  assert.equal(f.store.readGlobalCandidates().some((candidate) => candidate.state === "recommended"), true);
  assert.equal(f.calls.create, 2);
  assert.equal(f.calls.prompt, 2);
  assert.equal(f.calls.apply, 0);

  const peer = openStore(f.stateRoot, { projectFingerprint: PROJECT, projectName: "automation-runtime-peer" });
  t.after(() => peer.close());
  const staleStamp = peer.getAutomationState().stamp;

  const off = f.store.transitionAutomation({
    transitionId: "peer-fence-off",
    expectedGeneration: 1,
    action: "set-automatic-recommendations",
    enabled: false,
  });
  assert.equal(off.ok, true);
  assert.equal(f.store.readGlobalRecommendations()[0].recommendationId, recommendation.recommendationId);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "pending");

  const afterOff = stateSnapshot(f.stateRoot);
  const late = peer.appendRecord(schemas.wrapRecord("episode-cursor", schemas.makeEpisodeCursor({
    sessionIDHash: observation.hashSessionLineage("late-peer"),
    lastIdleAt: 1,
    lastObservedMessageHash: null,
    leaseNonce: null,
    automationGeneration: staleStamp.generation,
  }), 1), { automationStamp: staleStamp });
  assert.equal(late.ok, false);
  assert.equal(late.reason, "stale-automation-generation");
  assert.deepEqual(stateSnapshot(f.stateRoot), afterOff);
});

test("Off during hidden-session creation fences dispatch and late provider output", async (t) => {
  const f = fixture(t);
  f.messages.set("inflight-1", commandMessages("/inflight"));
  await runCycle(f, "inflight-1");
  assert.equal(f.store.readGlobalRecommendations().length, 0);
  assert.equal(f.calls.create, 0);

  let started;
  let release;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  f.ctx.client.session.create = async () => {
    f.calls.create += 1;
    started();
    await releasePromise;
    return { data: { id: "late-hidden-session" } };
  };
  f.messages.set("inflight-2", commandMessages("/inflight"));
  const pending = runCycle(f, "inflight-2");
  let waitTimer;
  try {
    await Promise.race([
      startedPromise,
      new Promise((_, reject) => {
        waitTimer = setTimeout(() => reject(new Error("hidden-session-create-not-reached")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(waitTimer);
  }
  const beforeOffAttempts = f.store.readGlobalSynthesisAttempts();
  assert.equal(beforeOffAttempts.length, 1);
  assert.equal(beforeOffAttempts[0].state, "admitted");

  const off = f.store.transitionAutomation({
    transitionId: "inflight-off",
    expectedGeneration: 1,
    action: "set-automatic-recommendations",
    enabled: false,
  });
  assert.equal(off.ok, true);
  release();
  const result = await pending;
  assert.equal(result.cycleOutcome, "failed-closed");
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.prompt, 0);
  assert.equal(f.calls.apply, 0);
  assert.equal(f.store.readGlobalRecommendations().length, 0);
  assert.deepEqual(f.store.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["failed-closed"]);
  assert.deepEqual(f.store.readGlobalCandidates().map((candidate) => candidate.state), ["superseded"]);
});

test("breaker, provider budget, catalog drift, and non-global targets never publish or apply", async (t) => {
  await t.test("breaker", async (t) => {
    const f = fixture(t, { breakerOpen: true });
    for (const sessionID of ["breaker-1", "breaker-2"]) {
      f.messages.set(sessionID, commandMessages());
      await runCycle(f, sessionID);
    }
    assert.equal(f.calls.create, 0);
    assert.equal(f.calls.prompt, 0);
    assert.equal(f.calls.apply, 0);
    assert.equal(f.store.readGlobalRecommendations().length, 0);
  });

  await t.test("provider-budget", async (t) => {
    const f = fixture(t);
    for (const sessionID of ["budget-1", "budget-2"]) {
      f.messages.set(sessionID, commandMessages());
      await runCycle(f, sessionID, {
        reservePassiveProviderCalls: () => ({ ok: false, reason: "passive-provider-budget-exhausted" }),
      });
    }
    assert.equal(f.calls.create, 1);
    assert.equal(f.calls.prompt, 0);
    assert.equal(f.calls.apply, 0);
    assert.equal(f.store.readGlobalRecommendations().length, 0);
  });

  await t.test("catalog-drift", async (t) => {
    const f = fixture(t);
    f.messages.set("drift-1", commandMessages());
    await runCycle(f, "drift-1");
    fs.appendFileSync(path.join(f.temp, "skills", "durable-review", "SKILL.md"), "\nDrifted after discovery.\n");
    f.messages.set("drift-2", commandMessages());
    await runCycle(f, "drift-2");
    assert.equal(f.calls.create, 0);
    assert.equal(f.calls.prompt, 0);
    assert.equal(f.calls.apply, 0);
    assert.equal(f.store.readGlobalRecommendations().length, 0);
  });

  await t.test("non-global-target", async (t) => {
    const f = fixture(t);
    for (const sessionID of ["local-1", "local-2"]) {
      f.messages.set(sessionID, commandMessages("/local-only", "project-only-skill"));
      await runCycle(f, sessionID);
    }
    assert.equal(f.calls.create, 0);
    assert.equal(f.calls.prompt, 0);
    assert.equal(f.calls.apply, 0);
    assert.equal(f.store.readGlobalRecommendations().length, 0);
  });

  await t.test("new-target-without-creation-root", async (t) => {
    const f = fixture(t);
    for (const sessionID of ["new-1", "new-2"]) {
      f.messages.set(sessionID, commandMessages("/new-global", null));
      await runCycle(f, sessionID);
    }
    assert.equal(f.catalog.policy.creationRootId, null);
    assert.equal(f.calls.create, 0);
    assert.equal(f.calls.prompt, 0);
    assert.equal(f.calls.apply, 0);
    assert.equal(f.store.readGlobalRecommendations().length, 0);
  });
});

test("deterministically invalid provider output fails before critic publication", async (t) => {
  const f = fixture(t);
  f.ctx.client.session.prompt = async () => {
    f.calls.prompt += 1;
    return { data: { info: { structured_output: {
      action: "recommend",
      logicalName: "durable-review",
      proposedContent: "invalid content without required skill frontmatter",
      rationale: "Invalid on purpose.",
      overlap: [],
      projectAssumptions: [],
    } } } };
  };
  for (const sessionID of ["invalid-1", "invalid-2"]) {
    f.messages.set(sessionID, commandMessages());
    await runCycle(f, sessionID);
  }
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.prompt, 1);
  assert.equal(f.calls.apply, 0);
  assert.equal(f.store.readGlobalRecommendations().length, 0);
  assert.deepEqual(f.store.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["failed-closed"]);
});

test("explicit Apply and exact Undo remain independent of ordinary Off", async (t) => {
  const f = fixture(t);
  for (const sessionID of ["action-1", "action-2"]) {
    f.messages.set(sessionID, commandMessages("/explicit-action"));
    await runCycle(f, sessionID);
  }
  const pending = f.store.readGlobalRecommendations()[0];
  assert.equal(pending.state, "pending");
  const off = f.store.transitionAutomation({
    transitionId: "actions-ordinary-off",
    expectedGeneration: 1,
    action: "set-automatic-recommendations",
    enabled: false,
  });
  assert.equal(off.ok, true);

  let catalog = f.catalog;
  let suppressors = { circuitBreakerOpen: false, emergencyStop: false };
  const domain = createGlobalDecisionDomain({
    store: f.store,
    inventory,
    now: (() => { let timestamp = pending.synthesizedAt + 100; return () => ++timestamp; })(),
    getCatalog: () => catalog,
    getSuppressors: () => ({ ...suppressors }),
  });
  const projected = buildGlobalRecommendationProjection(f.store.readGlobalProjectionSnapshot(), {
    stateRootIdentity: f.store.rootIdentity,
    now: pending.synthesizedAt + 1,
    targetReader: () => ({ exists: true, content: CURRENT, hash: inventory.hashSkillContent(CURRENT) }),
    actionAuthority: {
      apply: { allowed: true, reason: null },
      reject: { allowed: true, reason: null },
      undo: { allowed: true, reason: null },
    },
  });
  assert.deepEqual(projected.details[0].availableActions, ["apply", "reject"]);
  assert.deepEqual(projected.details[0].actionReasons, {
    apply: null,
    reject: null,
    undo: "action-state-mismatch",
  });

  const target = path.join(f.temp, "skills", "durable-review", "SKILL.md");
  const applied = await domain.decide({ action: "apply", decision: globalDecision(pending, "apply", "operator-apply-while-off") });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fs.readFileSync(target, "utf8"), PROPOSED);
  assert.equal(f.store.getAutomationState().enabled, false);
  assert.equal(f.calls.apply, 0);
  const appliedAgain = await domain.decide({ action: "apply", decision: globalDecision(pending, "apply", "operator-apply-while-off") });
  assert.equal(appliedAgain.ok, true);
  assert.equal(appliedAgain.duplicate, true);
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);

  catalog = refreshedHostCatalog(f);
  assert.equal(catalog.ok, true);
  suppressors = { circuitBreakerOpen: true, emergencyStop: true };
  const appliedRecommendation = f.store.readGlobalRecommendations()[0];
  const revoked = f.store.transitionAutomation({
    transitionId: "actions-revoke-before-undo",
    expectedGeneration: 2,
    action: "set-permission",
    permission: "sanitizedExcerpts",
    enabled: false,
  });
  assert.equal(revoked.ok, true);
  const undone = await domain.decide({
    action: "undo",
    decision: globalDecision(appliedRecommendation, "undo", "operator-undo-under-suppressors"),
  });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(fs.readFileSync(target, "utf8"), CURRENT);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "rolled-back");
});

test("privacy revocation blocks Apply but not Reject, and restoration can restore Apply while Off", async (t) => {
  const rejectedFixture = fixture(t);
  for (const sessionID of ["reject-1", "reject-2"]) {
    rejectedFixture.messages.set(sessionID, commandMessages("/privacy-reject"));
    await runCycle(rejectedFixture, sessionID);
  }
  const rejectedRecommendation = rejectedFixture.store.readGlobalRecommendations()[0];
  assert.equal(rejectedFixture.store.transitionAutomation({
    transitionId: "privacy-reject-revoke",
    expectedGeneration: 1,
    action: "set-permission",
    permission: "durableObservations",
    enabled: false,
  }).ok, true);
  const rejected = rejectedFixture.store.rejectGlobalRecommendation({
    decision: globalDecision(rejectedRecommendation, "reject", "operator-reject-without-privacy"),
    nowMs: rejectedRecommendation.synthesizedAt + 10,
  });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(rejectedFixture.store.readGlobalRecommendations()[0].state, "rejected");

  const restoredFixture = fixture(t);
  for (const sessionID of ["restore-action-1", "restore-action-2"]) {
    restoredFixture.messages.set(sessionID, commandMessages("/privacy-restore"));
    await runCycle(restoredFixture, sessionID);
  }
  const recommendation = restoredFixture.store.readGlobalRecommendations()[0];
  assert.equal(restoredFixture.store.transitionAutomation({
    transitionId: "privacy-apply-revoke",
    expectedGeneration: 1,
    action: "set-permission",
    permission: "crossRepoAggregation",
    enabled: false,
  }).ok, true);
  const domain = createGlobalDecisionDomain({
    store: restoredFixture.store,
    inventory,
    now: (() => { let timestamp = recommendation.synthesizedAt + 100; return () => ++timestamp; })(),
    getCatalog: () => restoredFixture.catalog,
    getSuppressors: () => ({ circuitBreakerOpen: false, emergencyStop: false }),
  });
  const target = path.join(restoredFixture.temp, "skills", "durable-review", "SKILL.md");
  const decision = globalDecision(recommendation, "apply", "operator-apply-after-restore");
  const denied = await domain.decide({ action: "apply", decision });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "global-apply-consent-required");
  assert.equal(fs.readFileSync(target, "utf8"), CURRENT);
  const deniedProjection = buildGlobalRecommendationProjection(restoredFixture.store.readGlobalProjectionSnapshot(), {
    stateRootIdentity: restoredFixture.store.rootIdentity,
    now: recommendation.synthesizedAt + 1,
    targetReader: () => ({ exists: true, content: CURRENT, hash: inventory.hashSkillContent(CURRENT) }),
    actionAuthority: {
      apply: { allowed: false, reason: "global-apply-consent-required" },
      reject: { allowed: true, reason: null },
      undo: { allowed: true, reason: null },
    },
  });
  assert.deepEqual(deniedProjection.details[0].availableActions, ["reject"]);
  assert.equal(deniedProjection.details[0].actionReasons.apply, "global-apply-consent-required");
  assert.equal(deniedProjection.details[0].actionReasons.reject, null);
  const callsBeforeRestore = { ...restoredFixture.calls };
  assert.equal(restoredFixture.store.transitionAutomation({
    transitionId: "privacy-apply-restore",
    expectedGeneration: 2,
    action: "set-permission",
    permission: "crossRepoAggregation",
    enabled: true,
  }).ok, true);
  assert.equal(restoredFixture.store.getAutomationState().enabled, false);
  const applied = await domain.decide({ action: "apply", decision });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fs.readFileSync(target, "utf8"), PROPOSED);
  assert.deepEqual(restoredFixture.calls, callsBeforeRestore);
});

test("explicit Apply fails before mutation on breaker or stale host discovery", async (t) => {
  const f = fixture(t);
  for (const sessionID of ["action-fence-1", "action-fence-2"]) {
    f.messages.set(sessionID, commandMessages("/action-fence"));
    await runCycle(f, sessionID);
  }
  const recommendation = f.store.readGlobalRecommendations()[0];
  const target = path.join(f.temp, "skills", "durable-review", "SKILL.md");
  let suppressors = { circuitBreakerOpen: true, emergencyStop: false };
  const domain = createGlobalDecisionDomain({
    store: f.store,
    inventory,
    now: (() => { let timestamp = recommendation.synthesizedAt + 100; return () => ++timestamp; })(),
    getCatalog: () => f.catalog,
    getSuppressors: () => ({ ...suppressors }),
  });
  const decision = globalDecision(recommendation, "apply", "operator-action-fence");
  const breakerDenied = await domain.decide({ action: "apply", decision });
  assert.equal(breakerDenied.ok, false);
  assert.equal(breakerDenied.reason, "circuit-breaker");
  assert.equal(fs.readFileSync(target, "utf8"), CURRENT);
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 0);

  suppressors = { circuitBreakerOpen: false, emergencyStop: false };
  fs.appendFileSync(target, "\nExternally drifted before the operator effect.\n");
  const drifted = fs.readFileSync(target, "utf8");
  const staleDenied = await domain.decide({ action: "apply", decision });
  assert.equal(staleDenied.ok, false);
  assert.equal(staleDenied.reason, "global-skill-catalog-stale");
  assert.equal(fs.readFileSync(target, "utf8"), drifted);
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 0);
});

test("crashes around attempt and candidate Off settlement recover deterministically", async (t) => {
  for (const faultPoint of [
    "automation-before-attempt-settlement",
    "automation-after-attempt-settlement",
    "automation-before-candidate-settlement",
    "automation-after-candidate-settlement",
  ]) {
    const f = fixture(t);
    f.messages.set(`${faultPoint}-1`, commandMessages("/crash-fence"));
    await runCycle(f, `${faultPoint}-1`);

    let started;
    let release;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const releasePromise = new Promise((resolve) => { release = resolve; });
    f.ctx.client.session.create = async () => {
      f.calls.create += 1;
      started();
      await releasePromise;
      return { data: { id: `crashed-hidden-${faultPoint}` } };
    };
    f.messages.set(`${faultPoint}-2`, commandMessages("/crash-fence"));
    const pending = runCycle(f, `${faultPoint}-2`);
    await startedPromise;
    assert.deepEqual(f.store.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["admitted"], faultPoint);

    try {
      const crashed = await crashOffPeer(f.stateRoot, faultPoint);
      assert.equal(crashed.code, 91, `${faultPoint}: ${crashed.stderr}`);
      const recovered = f.store.getAutomationState();
      assert.equal(recovered.enabled, false, `${faultPoint}: ${JSON.stringify(recovered)}`);
      assert.equal(recovered.epoch.generation, 2, faultPoint);
    } finally {
      release();
      await pending;
    }
    assert.deepEqual(f.store.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["failed-closed"], faultPoint);
    assert.deepEqual(f.store.readGlobalCandidates().map((candidate) => candidate.state), ["superseded"], faultPoint);
    assert.equal(f.store.readGlobalRecommendations().length, 0, faultPoint);
    assert.equal(f.calls.prompt, 0, faultPoint);
    assert.equal(f.calls.apply, 0, faultPoint);
  }
});
