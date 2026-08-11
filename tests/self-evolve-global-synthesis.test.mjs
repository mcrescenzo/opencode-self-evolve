import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as inventory from "../self-evolve-inventory.js";
import { deriveSourceLineage, hashSignature } from "../self-evolve-observation.js";
import * as schemas from "../self-evolve-schemas.js";
import { stateMutationLockHeld } from "../self-evolve-lock.js";
import { openStore } from "../self-evolve-store.js";
import {
  CRITIC_AGENT_NAME,
  SYNTHESIS_AGENT_NAME,
  globalSynthesisLeaseKey,
  runGlobalSynthesis,
} from "../self-evolve-synthesis.js";

const NOW = Date.UTC(2026, 7, 10);
const DAY = 86_400_000;
const H = (value) => inventory.hashSkillContent(value);
const CURRENT = "---\nname: durable-review\ndescription: Reviews repeated failures safely.\n---\n\n# Durable Review\n\nInspect the failure.\n";
const PROPOSED = `${CURRENT}\nVerify the repeated failure before suggesting a correction.\n`;
const OTHER_BODY = "# Independent Verification\n\nUse this procedure when a repeated operation needs independent confirmation before it can continue.\n\n1. Capture the bounded expected outcome.\n2. Re-run the smallest deterministic check.\n3. Compare the observed result to the expected outcome.\n4. Stop and report the mismatch without changing external state.\n";
const OTHER_SKILL = `---\nname: other-review\ndescription: Verifies repeated operations independently.\n---\n\n${OTHER_BODY}`;
const PROCESS_CHILD = path.join(import.meta.dirname, "fixtures", "global-synthesis-process.mjs");

function runSynthesisChild(args, { expectSignal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROCESS_CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (expectSignal !== null) {
        if (signal === expectSignal) resolve({ signal, stdout, stderr });
        else reject(new Error(`expected-${expectSignal}:code=${code}:signal=${signal}:${stderr}`));
        return;
      }
      if (code !== 0) reject(new Error(`child-exit-${code}:${signal}:${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch (error) { reject(new Error(`invalid-child-output:${stdout}:${stderr}`, { cause: error })); }
      }
    });
  });
}

function treeText(directory) {
  if (!fs.existsSync(directory)) return "";
  return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? treeText(filePath) : fs.readFileSync(filePath, "utf8");
  }).join("\n");
}

function treeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? treeFiles(filePath) : [filePath];
  }).sort();
}

function seedContribution(store, {
  incidentId,
  capsuleId,
  evidenceDomainId,
  rootLineageHash,
  occurrenceCount,
  summary,
  targetLogicalName = "durable-review",
  capsuleExpiresAt = NOW + 30 * DAY,
}) {
  const signatureHash = H("repeated-config-failure");
  const scopeFingerprint = H("private-scope");
  const clusterId = H(`private-cluster:${incidentId}`);
  const observation = schemas.makeObservation({
    id: H(`private-observation:${incidentId}`),
    projectFingerprint: store.projectFingerprint,
    receiptIds: [signatureHash],
    structuredFields: {
      receiptType: "repeated-tool-error",
      scopeFingerprint,
      occurrences: occurrenceCount,
      deterministicOutcome: true,
      targetLogicalName,
    },
    incidentId,
    sessionLineageHash: H(`private-session:${incidentId}`),
    rootLineageHash,
    originKind: "user",
    createdAt: NOW,
    injectionFlagged: false,
    redacted: true,
  });
  const cluster = schemas.makeEvidenceCluster({
    id: clusterId,
    receiptType: "repeated-tool-error",
    projectFingerprint: store.projectFingerprint,
    incidentIds: [incidentId],
    scopeFingerprint,
    targetLogicalName,
    occurrencesSum: occurrenceCount,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  });
  assert.equal(store.appendRecord(schemas.wrapRecord("observation", observation, NOW)).ok, true);
  assert.equal(store.appendRecord(schemas.wrapRecord("evidence-cluster", cluster, NOW)).ok, true);
  assert.equal(store.appendEvidenceCapsule(schemas.makeEvidenceCapsule({
    capsuleId,
    incidentId,
    receiptType: "repeated-tool-error",
    targetLogicalName,
    summary,
    createdAt: NOW,
    expiresAt: capsuleExpiresAt,
  })).ok, true);
  const published = store.publishContribution({
    claimType: "global-skill-candidate",
    receiptType: "repeated-tool-error",
    signatureHash,
    incidentId,
    capsuleId,
    clusterId,
    evidenceDomainId,
    occurrenceCount,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  });
  assert.equal(published.ok, true, published.reason);
  return { observation, cluster, contribution: published.contribution };
}

function providerContext(store, candidate, prompts, synthesisOutput = {}, criticOutput = {}, lifecycle = {}) {
  const assertAdmission = (expectedState = "dispatched") => {
    const lease = store.getGlobalLease(globalSynthesisLeaseKey(candidate));
    const [attempt] = store.readGlobalSynthesisAttempts();
    assert.equal(lease?.state, "active", "candidate lease precedes dispatch");
    assert.equal(attempt?.state, expectedState, "durable admission precedes session creation and dispatch precedes provider use");
    assert.equal(stateMutationLockHeld(store.rootPath), false, "provider calls occur outside the mutation lock");
  };
  return {
    client: { session: {
      create: async (args) => {
        assertAdmission(args.body.agent === SYNTHESIS_AGENT_NAME ? "admitted" : "dispatched");
        await lifecycle.beforeCreateResolve?.(args.body.agent);
        return { data: { id: `hidden-${args.body.agent}-${prompts.length}` } };
      },
      prompt: async (args) => {
        const agent = args.body.agent;
        assertAdmission();
        prompts.push(args.body.parts[0].text);
        if (agent === CRITIC_AGENT_NAME) {
          return { data: { info: { structured_output: {
            score: 0.97,
            evidenceLinked: true,
            nonDuplicative: true,
            reasons: ["The bounded change is general and evidence-linked."],
            recommendedAction: "accept",
            ...criticOutput,
          } } } };
        }
        assert.equal(agent, SYNTHESIS_AGENT_NAME);
        return { data: { info: { structured_output: {
          action: "recommend",
          logicalName: "durable-review",
          proposedContent: PROPOSED,
          rationale: "Add one general verification step for recurring configuration failures.",
          overlap: [],
          projectAssumptions: [],
          ...synthesisOutput,
        } } } };
      },
      abort: async () => ({ data: {} }),
      delete: async (args) => {
        const id = args.path.id;
        lifecycle.deletions?.push(id);
        if (lifecycle.deleteErrorFor?.(id)) throw new Error("hidden-session-delete-failed");
        return { data: {} };
      },
    } },
  };
}

function createGate(agent) {
  let started;
  let release;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  return {
    started: startedPromise,
    release,
    async wait(current) {
      if (current !== agent) return;
      started();
      await releasePromise;
    },
  };
}

function noProviderContext(calls) {
  return {
    client: { session: {
      create: async () => { calls.create += 1; throw new Error("provider-create-must-not-run"); },
      prompt: async () => { calls.prompt += 1; throw new Error("provider-prompt-must-not-run"); },
      abort: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    } },
  };
}

function noPromptContext(calls) {
  return {
    client: { session: {
      create: async () => { calls.create += 1; return { data: { id: `hidden-no-prompt-${calls.create}` } }; },
      prompt: async () => { calls.prompt += 1; throw new Error("provider-prompt-must-not-run"); },
      abort: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    } },
  };
}

function globalOptions(store, overrides = {}) {
  return {
    store,
    hiddenAgentRegistration: { assert: () => {} },
    suppressors: {
      bootValidated: true,
      hostSupported: true,
      circuitBreakerOpen: false,
      processExcluded: false,
    },
    ...overrides,
  };
}

function existingFixture(t, {
  synthesisPerDay = 24,
  storeFaultInjection,
  additionalRoot = false,
  retentionDays = 30,
  materializedAt = NOW,
  capsuleExpiresAt = NOW + 30 * DAY,
  otherSkillContent = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-synthesis-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillRoot = path.join(root, "global-skills");
  const skillPath = path.join(skillRoot, "durable-review", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, CURRENT);
  if (otherSkillContent !== null) {
    const otherPath = path.join(skillRoot, "other-review", "SKILL.md");
    fs.mkdirSync(path.dirname(otherPath), { recursive: true });
    fs.writeFileSync(otherPath, otherSkillContent);
  }
  const secondSkillRoot = additionalRoot ? path.join(root, "other-global-skills") : null;
  if (secondSkillRoot) fs.mkdirSync(secondSkillRoot, { recursive: true });
  const projectA = H("private-project-a");
  const projectB = H("private-project-b");
  let clock = NOW;
  const first = openStore(root, { projectFingerprint: projectA, now: () => clock, staleLockMs: 1 });
  const second = openStore(root, { projectFingerprint: projectB, now: () => clock, staleLockMs: 1, faultInjection: storeFaultInjection });
  t.after(() => { first.close(); second.close(); });
  const approvedRoot = schemas.makeApprovedGlobalRoot({ canonicalPath: skillRoot, canUpdate: true, canCreate: false });
  const otherApprovedRoot = secondSkillRoot
    ? schemas.makeApprovedGlobalRoot({ canonicalPath: secondSkillRoot, canUpdate: true, canCreate: false })
    : null;
  const rootPolicy = schemas.makeGlobalRootPolicy({
    roots: [approvedRoot, ...(otherApprovedRoot ? [otherApprovedRoot] : [])],
    creationRootId: null,
    selectedBy: "operator",
    updatedAt: NOW,
  });
  assert.equal(first.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    mode: "auto",
    globalRootPolicy: rootPolicy,
    consent: { ...global.consent, sanitizedExcerpts: true, crossRepoAggregation: true },
    budgets: { ...global.budgets, synthesisPerDay },
    retentionDays,
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  const evidenceDomain = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://example.invalid/shared/source.git" }));
  const firstEvidence = seedContribution(first, {
    incidentId: "private-incident-a",
    capsuleId: "11111111-1111-4111-8111-111111111111",
    evidenceDomainId: evidenceDomain.domainId,
    rootLineageHash: H("private-root-a"),
    occurrenceCount: 2,
    summary: "Configuration validation failed repeatedly until the result was checked.",
    capsuleExpiresAt,
  });
  const secondEvidence = seedContribution(second, {
    incidentId: "private-incident-b",
    capsuleId: "22222222-2222-4222-8222-222222222222",
    evidenceDomainId: evidenceDomain.domainId,
    rootLineageHash: H("private-root-b"),
    occurrenceCount: 1,
    summary: "A repeated configuration failure needed one verification step.",
    capsuleExpiresAt,
  });
  const catalog = inventory.buildGlobalSkillCatalog(rootPolicy, { projectRoot: root });
  assert.equal(catalog.ok, true, JSON.stringify(catalog.blockers));
  const resolution = inventory.resolveGlobalSkillCandidate("durable-review", catalog);
  assert.equal(resolution.ok, true, resolution.reason);
  const materialized = second.materializeGlobalCandidates({
    targetBindings: [resolution.binding],
    rootPolicy,
    nowMs: materializedAt,
  });
  assert.equal(materialized.ok, true, materialized.reason);
  const candidate = materialized.candidates[0];
  assert.equal(candidate.state, "eligible");
  return {
    root,
    skillRoot,
    skillPath,
    secondSkillRoot,
    projectA,
    projectB,
    first,
    second,
    rootPolicy,
    evidenceDomain,
    firstEvidence,
    secondEvidence,
    catalog,
    candidate,
    setClock(value) { clock = value; },
  };
}

function newTargetFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-new-synthesis-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillRoot = path.join(root, "global-skills");
  fs.mkdirSync(skillRoot, { recursive: true });
  const projectA = H("private-new-project-a");
  const projectB = H("private-new-project-b");
  const first = openStore(root, { projectFingerprint: projectA, now: () => NOW });
  const second = openStore(root, { projectFingerprint: projectB, now: () => NOW });
  t.after(() => { first.close(); second.close(); });
  const approvedRoot = schemas.makeApprovedGlobalRoot({ canonicalPath: skillRoot, canUpdate: true, canCreate: true });
  const rootPolicy = schemas.makeGlobalRootPolicy({
    roots: [approvedRoot],
    creationRootId: approvedRoot.rootId,
    selectedBy: "operator",
    updatedAt: NOW,
  });
  assert.equal(first.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    mode: "auto",
    globalRootPolicy: rootPolicy,
    consent: { ...global.consent, sanitizedExcerpts: true, crossRepoAggregation: true },
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  const evidenceDomain = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://example.invalid/shared/new-source.git" }));
  seedContribution(first, {
    incidentId: "private-new-incident-a",
    capsuleId: "33333333-3333-4333-8333-333333333333",
    evidenceDomainId: evidenceDomain.domainId,
    rootLineageHash: H("private-new-root-a"),
    occurrenceCount: 2,
    summary: "Repeated validation needed a reusable bounded review procedure.",
    targetLogicalName: null,
  });
  seedContribution(second, {
    incidentId: "private-new-incident-b",
    capsuleId: "44444444-4444-4444-8444-444444444444",
    evidenceDomainId: evidenceDomain.domainId,
    rootLineageHash: H("private-new-root-b"),
    occurrenceCount: 1,
    summary: "A recurring validation gap needed one general verification step.",
    targetLogicalName: null,
  });
  const catalog = inventory.buildGlobalSkillCatalog(rootPolicy, { projectRoot: root });
  const resolution = inventory.resolveGlobalSkillCandidate(null, catalog);
  assert.equal(resolution.ok, true, resolution.reason);
  assert.equal(resolution.binding.rootId, rootPolicy.creationRootId);
  const materialized = second.materializeGlobalCandidates({ targetBindings: [resolution.binding], rootPolicy, nowMs: NOW });
  const candidate = materialized.candidates[0];
  assert.equal(candidate.state, "eligible");
  return { root, skillRoot, first, second, rootPolicy, catalog, candidate };
}

test("existing global support admits before dispatch and persists one identity-free canonical recommendation", async (t) => {
  const f = existingFixture(t);
  const prompts = [];
  const deletions = [];

  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts, {}, {}, { deletions }),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.recommendation.state, "pending");
  assert.deepEqual(f.second.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["completed"]);
  assert.deepEqual(f.second.readGlobalRecommendations(), [result.recommendation]);
  assert.equal(f.second.readGlobalRecommendationContent(result.recommendation.recommendationId), PROPOSED);
  assert.equal(f.second.readGlobalCandidates()[0].state, "recommended");
  assert.equal(prompts.length, 2);
  assert.deepEqual(deletions, [
    `hidden-${SYNTHESIS_AGENT_NAME}-0`,
    `hidden-${CRITIC_AGENT_NAME}-1`,
  ]);
  assert.match(prompts[0], /(?:Configuration validation failed repeatedly|repeated configuration failure)/iu);
  const forbiddenValues = [
    f.projectA,
    f.projectB,
    f.evidenceDomain.domainId,
    "private-incident-a",
    "private-incident-b",
    f.firstEvidence.observation.id,
    f.secondEvidence.observation.id,
    f.firstEvidence.cluster.id,
    f.secondEvidence.cluster.id,
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "Configuration validation failed repeatedly until the result was checked.",
    "A repeated configuration failure needed one verification step.",
  ];
  for (const forbidden of forbiddenValues.flatMap((value) => [value, H(value)])) {
    assert.equal(JSON.stringify(result.recommendation).includes(forbidden), false, forbidden);
    assert.equal(PROPOSED.includes(forbidden), false, forbidden);
    assert.equal(treeText(path.join(f.root, "self-evolve", "global")).includes(forbidden), false, forbidden);
  }
  assert.equal(schemas.assertGlobalIdentitySafe(result.attempt, { forbiddenIdentityValues: forbiddenValues }), true);
  assert.equal(schemas.assertGlobalIdentitySafe(result.recommendation, { forbiddenIdentityValues: forbiddenValues }), true);
  const globalRoot = path.join(f.root, "self-evolve", "global");
  const synthesisFiles = treeFiles(globalRoot)
    .map((filePath) => path.relative(globalRoot, filePath))
    .filter((relative) => /^(?:synthesis-attempts|recommendations|recommendation-content)\//u.test(relative));
  assert.equal(synthesisFiles.filter((relative) => relative.startsWith("synthesis-attempts/")).length, 1);
  assert.equal(synthesisFiles.filter((relative) => relative.startsWith("recommendations/")).length, 1);
  assert.equal(synthesisFiles.filter((relative) => relative.startsWith("recommendation-content/")).length >= 1, true);
});

test("global synthesis refuses every prompt when session deletion is unavailable", async (t) => {
  const f = existingFixture(t);
  const calls = { create: 0, prompt: 0 };
  const result = await runGlobalSynthesis({
    ctx: { client: { session: {
      create: async () => { calls.create += 1; return { data: { id: "must-not-exist" } }; },
      prompt: async () => { calls.prompt += 1; throw new Error("prompt-must-not-run"); },
      abort: async () => ({ data: {} }),
    } } },
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /session\.delete is unavailable/u);
  assert.deepEqual(calls, { create: 0, prompt: 0 });
  assert.equal(f.second.readGlobalRecommendations().length, 0);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "failed-closed");
});

test("synthesizer or critic deletion failure retains ownership and fails closed before recommendation persistence", async (t) => {
  for (const agent of [SYNTHESIS_AGENT_NAME, CRITIC_AGENT_NAME]) {
    await t.test(agent, async (t) => {
      const f = existingFixture(t);
      const prompts = [];
      const deletions = [];
      const failedSessionId = agent === SYNTHESIS_AGENT_NAME
        ? `hidden-${SYNTHESIS_AGENT_NAME}-0`
        : `hidden-${CRITIC_AGENT_NAME}-1`;
      const result = await runGlobalSynthesis({
        ctx: providerContext(f.second, f.candidate, prompts, {}, {}, {
          deletions,
          deleteErrorFor: (id) => id === failedSessionId,
        }),
        candidate: f.candidate,
        catalog: f.catalog,
        inventoryModule: inventory,
        options: globalOptions(f.second),
        now: NOW + 1,
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, /hidden-session-delete-failed/u);
      assert.equal(prompts.length, agent === SYNTHESIS_AGENT_NAME ? 1 : 2);
      assert.equal(f.second.readGlobalRecommendations().length, 0);
      assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "failed-closed");
      const owner = f.second.hostOwnerStatus(failedSessionId, {
        projectFingerprint: f.projectB,
        rootIdentity: f.second.rootIdentity,
        now: NOW + 1,
      });
      assert.equal(owner.classification, "live-owner");
      assert.equal(owner.owner.sessionId, failedSessionId);
    });
  }
});

test("a new global target binds the creation root before dispatch and remains unapplied", async (t) => {
  const f = newTargetFixture(t);
  const content = "---\nname: reusable-validation-review\ndescription: Reviews recurring validation failures safely.\n---\n\n# Reusable Validation Review\n\nVerify the repeated failure before suggesting a correction.\n";
  const prompts = [];

  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts, {
      logicalName: "reusable-validation-review",
      proposedContent: content,
      rationale: "Create one general review procedure for recurring validation failures.",
    }),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.recommendation.targetBinding.targetKind, "new-global-skill");
  assert.equal(result.recommendation.targetBinding.rootId, f.rootPolicy.creationRootId);
  assert.equal(result.recommendation.targetBinding.logicalName, "reusable-validation-review");
  assert.equal(result.recommendation.targetBinding.relativePath, "reusable-validation-review/SKILL.md");
  assert.equal(result.recommendation.targetBinding.currentHash, "must-not-exist");
  assert.equal(f.second.readGlobalRecommendationContent(result.recommendation.recommendationId), content);
  assert.equal(fs.existsSync(path.join(f.skillRoot, "reusable-validation-review")), false, "synthesis has no apply authority");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /creation root is already fixed/u);
});

test("a valid global no-op durably completes the attempt and candidate without a recommendation", async (t) => {
  const f = existingFixture(t);
  const prompts = [];
  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts, {
      action: "no-op",
      logicalName: null,
      proposedContent: "",
      rationale: "The bounded support does not justify a safe reusable change.",
      overlap: [],
      projectAssumptions: [],
    }),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.noChange, true);
  assert.equal(result.recommendation, null);
  assert.equal(prompts.length, 1);
  assert.deepEqual(f.second.readGlobalSynthesisAttempts().map((item) => item.state), ["completed"]);
  assert.deepEqual(f.second.readGlobalCandidates().map((item) => item.state), ["no-change"]);
  assert.deepEqual(f.second.readGlobalRecommendations(), []);

  const calls = { create: 0, prompt: 0 };
  const replay = await runGlobalSynthesis({
    ctx: noProviderContext(calls),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 2,
  });
  assert.equal(replay.ok, false);
  assert.deepEqual(calls, { create: 0, prompt: 0 });
  assert.equal(f.second.readGlobalSynthesisAttempts().length, 1);
});

test("a no-change completion write failure never returns success and leaves a recoverable terminal pair", async (t) => {
  let failed = false;
  const f = existingFixture(t, {
    storeFaultInjection(point) {
      if (point !== "global-synthesis-after-candidate-no-change" || failed) return;
      failed = true;
      throw new Error("fixture-no-change-write-failure");
    },
  });
  const prompts = [];
  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts, {
      action: "no-op",
      logicalName: null,
      proposedContent: "",
      rationale: "The bounded support does not justify a safe reusable change.",
      overlap: [],
      projectAssumptions: [],
    }),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  assert.equal(failed, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /fixture-no-change-write-failure/u);
  assert.equal(prompts.length, 1);
  assert.deepEqual(f.second.readGlobalSynthesisAttempts().map((item) => item.state), ["completed"]);
  assert.deepEqual(f.second.readGlobalCandidates().map((item) => item.state), ["no-change"]);
  assert.deepEqual(f.second.readGlobalRecommendations(), []);
});

test("removing the primary creation root after candidate materialization fails before provider use", async (t) => {
  const f = newTargetFixture(t);
  const updateOnlyRoot = schemas.makeApprovedGlobalRoot({
    canonicalPath: f.rootPolicy.roots[0].canonicalPath,
    canUpdate: true,
    canCreate: false,
  });
  const noCreationRoot = schemas.makeGlobalRootPolicy({
    roots: [updateOnlyRoot],
    creationRootId: null,
    selectedBy: "operator",
    updatedAt: f.rootPolicy.updatedAt + 1,
  });
  assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    globalRootPolicy: noCreationRoot,
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  const calls = { create: 0, prompt: 0 };
  const result = await runGlobalSynthesis({
    ctx: noProviderContext(calls),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /creation-root|root-set-hash-mismatch|target-binding|stale-root-set/u);
  assert.deepEqual(calls, { create: 0, prompt: 0 });
  assert.equal(f.second.readGlobalSynthesisAttempts().length, 0);
  assert.equal(f.second.readGlobalRecommendations().length, 0);
});

test("an invalid model-suggested new skill name fails before critic authority", async (t) => {
  const f = newTargetFixture(t);
  const prompts = [];
  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts, {
      logicalName: "Invalid Suggested Name",
      proposedContent: "---\nname: invalid-suggested-name\ndescription: Invalid suggestion fixture.\n---\n\n# Invalid\n",
    }),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /target-logical-name-invalid/u);
  assert.equal(prompts.length, 1);
  assert.equal(f.second.readGlobalRecommendations().length, 0);
  assert.equal(fs.readdirSync(f.skillRoot).length, 0);
});

test("fresh global preflight gates fail closed before provider creation", async (t) => {
  const cases = [
    ["invalid-model", (f) => ({ options: { model: "invalid-model" }, expected: "invalid-global-synthesis-model" })],
    ["budget-exhausted", () => ({ fixture: { synthesisPerDay: 0 }, expected: "synthesis-budget-exhausted" })],
    ["consent-drift", (f) => {
      assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
        ...global,
        consent: { ...global.consent, sanitizedExcerpts: false, crossRepoAggregation: false },
        updatedAt: global.updatedAt + 1,
      })).ok, true);
      return { expected: "global-synthesis-consent-required" };
    }],
    ["paused", (f) => {
      assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
        ...global, paused: true, updatedAt: global.updatedAt + 1,
      })).ok, true);
      return { expected: "paused" };
    }],
    ["kill-switch", (f) => {
      assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
        ...global, killSwitchActive: true, updatedAt: global.updatedAt + 1,
      })).ok, true);
      return { expected: "kill-switch" };
    }],
    ["runtime-suppressor", () => ({ options: { suppressors: {
      bootValidated: true, hostSupported: true, circuitBreakerOpen: true, processExcluded: false,
    } }, expected: "circuit-breaker" })],
    ["root-policy-drift", (f) => {
      assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
        ...global, globalRootPolicy: null, updatedAt: global.updatedAt + 1,
      })).ok, true);
      return { expected: "global-root-policy-required" };
    }],
    ["target-content-drift", (f) => {
      fs.writeFileSync(f.skillPath, `${CURRENT}\nExternal drift.\n`);
      return { expected: "global-skill-catalog-stale" };
    }],
    ["catalog-drift", (f) => {
      const added = path.join(f.skillRoot, "other-review", "SKILL.md");
      fs.mkdirSync(path.dirname(added), { recursive: true });
      fs.writeFileSync(added, "---\nname: other-review\ndescription: Another safe review skill.\n---\n\n# Other Review\n");
      return { expected: "global-skill-catalog-stale" };
    }],
    ["ambiguous-existing-target", (f) => {
      const duplicate = path.join(f.secondSkillRoot, "durable-review", "SKILL.md");
      fs.mkdirSync(path.dirname(duplicate), { recursive: true });
      fs.writeFileSync(duplicate, CURRENT);
      return { expected: "duplicate-global-skill-name" };
    }],
  ];
  for (const [name, arrange] of cases) {
    await t.test(name, async (t) => {
      const preliminary = arrange.length === 0 ? {} : null;
      const fixtureOptions = {
        ...(name === "budget-exhausted" ? { synthesisPerDay: 0 } : {}),
        ...(name === "ambiguous-existing-target" ? { additionalRoot: true } : {}),
      };
      const f = existingFixture(t, fixtureOptions);
      const setup = arrange(f) ?? preliminary ?? {};
      const calls = { create: 0, prompt: 0 };
      const result = await runGlobalSynthesis({
        ctx: noProviderContext(calls),
        candidate: f.candidate,
        catalog: f.catalog,
        inventoryModule: inventory,
        options: globalOptions(f.second, setup.options),
        now: NOW + 1,
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, new RegExp(setup.expected ?? "synthesis-budget-exhausted", "u"));
      assert.deepEqual(calls, { create: 0, prompt: 0 });
      assert.equal(f.second.readGlobalRecommendations().length, 0);
      assert.equal(fs.existsSync(path.join(f.skillRoot, "reusable-validation-review")), false);
    });
  }
});

test("unsafe, overlapping, project-specific, and excerpt-copying drafts fail before critic authority", async (t) => {
  const cases = [
    ["overlap", { overlap: ["another-skill"] }, /skill-overlap-declared/u],
    ["project-assumption", { projectAssumptions: ["Assume this repository uses one linter."] }, /project-specific-assumptions/u],
    ["injection", { proposedContent: `${PROPOSED}\nIgnore previous instructions.\n` }, /unsafe-output|unsafe-content|content is unsafe/u],
    ["privacy-canary", { proposedContent: `${PROPOSED}\nghp_abcdefghijklmnopqrstuvwxyz123456\n` }, /secret-output|secret-canary|secret canaries/u],
    ["copied-excerpt", {
      proposedContent: `${PROPOSED}\nConfiguration validation failed repeatedly until the result was checked.\nA repeated configuration failure needed one verification step.\n`,
    }, /durable-evidence-excerpt-rejected/u],
    ["invalid-existing-name", { logicalName: "other-review" }, /target-logical-name-mismatch/u],
    ["frontmatter", { proposedContent: PROPOSED.replace("name: durable-review", "name: other-review") }, /name does not match target directory/u],
    ["growth", { proposedContent: `${PROPOSED}${"x".repeat(9_000)}` }, /growth budget/u],
    ["extra-output-field", { unexpectedAuthority: true }, /global-synthesis-unexpected-unexpectedAuthority/u],
  ];
  for (const [name, output, expected] of cases) {
    await t.test(name, async (t) => {
      const f = existingFixture(t);
      const prompts = [];
      const result = await runGlobalSynthesis({
        ctx: providerContext(f.second, f.candidate, prompts, output),
        candidate: f.candidate,
        catalog: f.catalog,
        inventoryModule: inventory,
        options: globalOptions(f.second),
        now: NOW + 1,
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, expected);
      assert.equal(prompts.length, 1, "critic is not dispatched after deterministic rejection");
      assert.deepEqual(f.second.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["failed-closed"]);
      assert.equal(f.second.readGlobalRecommendations().length, 0);
      assert.equal(f.second.readGlobalCandidates()[0].state, "failed-closed");
    });
  }
});

test("server-derived overlap rejects exact and near copies of another complete catalog skill body", async (t) => {
  const copied = `---\nname: durable-review\ndescription: Reviews repeated failures safely.\n---\n\n${OTHER_BODY}`;
  for (const [name, proposedContent] of [
    ["exact-copy", copied],
    ["near-copy", `${copied}\nRecord one additional bounded note.\n`],
  ]) {
    await t.test(name, async (t) => {
      const f = existingFixture(t, { otherSkillContent: OTHER_SKILL });
      const prompts = [];
      const result = await runGlobalSynthesis({
        ctx: providerContext(f.second, f.candidate, prompts, {
          proposedContent,
          overlap: [],
        }),
        candidate: f.candidate,
        catalog: f.catalog,
        inventoryModule: inventory,
        options: globalOptions(f.second),
        now: NOW + 1,
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, /skill-overlap-detected:other-review/u);
      assert.equal(prompts.length, 1, "deterministic overlap blocks critic dispatch");
      assert.equal(f.second.readGlobalRecommendations().length, 0);
    });
  }
});

test("consent, suppressor, target, and catalog drift after admission stop before provider dispatch", async (t) => {
  const cases = [
    ["consent", (f) => f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
      ...global,
      consent: { ...global.consent, sanitizedExcerpts: false, crossRepoAggregation: false },
      updatedAt: global.updatedAt + 1,
    })), /global-synthesis-consent-required/u],
    ["paused", (f) => f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
      ...global, paused: true, updatedAt: global.updatedAt + 1,
    })), /paused/u],
    ["target", (f) => {
      fs.writeFileSync(f.skillPath, `${CURRENT}\nDrift after admission.\n`);
      return { ok: true };
    }, /global-skill-catalog-stale/u],
    ["catalog", (f) => {
      const added = path.join(f.skillRoot, "late-review", "SKILL.md");
      fs.mkdirSync(path.dirname(added), { recursive: true });
      fs.writeFileSync(added, "---\nname: late-review\ndescription: A late safe review skill.\n---\n\n# Late Review\n");
      return { ok: true };
    }, /global-skill-catalog-stale/u],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (t) => {
      const f = existingFixture(t);
      const calls = { create: 0, prompt: 0 };
      let injected = false;
      const result = await runGlobalSynthesis({
        ctx: noPromptContext(calls),
        candidate: f.candidate,
        catalog: f.catalog,
        inventoryModule: inventory,
        options: globalOptions(f.second, {
          faultInjection(point) {
            if (point !== "global-synthesis-after-admission" || injected) return;
            injected = true;
            assert.equal(mutate(f).ok, true);
          },
        }),
        now: NOW + 1,
      });
      assert.equal(injected, true);
      assert.equal(result.ok, false);
      assert.match(result.reason, expected);
      assert.deepEqual(calls, { create: 1, prompt: 0 });
      assert.deepEqual(f.second.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["failed-closed"]);
      assert.equal(f.second.readGlobalRecommendations().length, 0);
    });
  }
});

test("consent revoked while synthesizer session creation is paused suppresses its prompt", async (t) => {
  const f = existingFixture(t);
  const prompts = [];
  const gate = createGate(SYNTHESIS_AGENT_NAME);
  const pending = runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts, {}, {}, { beforeCreateResolve: (agent) => gate.wait(agent) }),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  await gate.started;
  assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    consent: { ...global.consent, sanitizedExcerpts: false, crossRepoAggregation: false },
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  gate.release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.reason, /global-synthesis-consent-required/u);
  assert.equal(prompts.length, 0);
  assert.equal(f.second.readGlobalRecommendations().length, 0);
});

test("passiveCalls-only revocation at the pre-prompt boundary suppresses passive work but not explicit work", async (t) => {
  const passive = existingFixture(t);
  assert.equal(passive.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    consent: { ...global.consent, passiveCalls: true },
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  const prompts = [];
  let reservations = 0;
  const gate = createGate(SYNTHESIS_AGENT_NAME);
  const pending = runGlobalSynthesis({
    ctx: providerContext(passive.second, passive.candidate, prompts, {}, {}, { beforeCreateResolve: (agent) => gate.wait(agent) }),
    candidate: passive.candidate,
    catalog: passive.catalog,
    inventoryModule: inventory,
    options: globalOptions(passive.second, {
      reservePassiveProviderCalls() { reservations += 1; return { ok: true }; },
    }),
    now: NOW + 1,
  });
  await gate.started;
  assert.equal(passive.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    consent: { ...global.consent, passiveCalls: false },
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  gate.release();
  const blocked = await pending;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "passive-calls-consent-required");
  assert.equal(reservations, 0);
  assert.equal(prompts.length, 0);

  const explicit = existingFixture(t);
  const explicitPrompts = [];
  const allowed = await runGlobalSynthesis({
    ctx: providerContext(explicit.second, explicit.candidate, explicitPrompts),
    candidate: explicit.candidate,
    catalog: explicit.catalog,
    inventoryModule: inventory,
    options: globalOptions(explicit.second),
    now: NOW + 1,
  });
  assert.equal(allowed.ok, true, allowed.reason);
  assert.equal(explicitPrompts.length, 2);
});

test("synthesizer pre-prompt freshness suppresses catalog, capsule, support, suppressor, and lease drift", async (t) => {
  const cases = [
    {
      name: "catalog-target",
      expected: /global-skill-catalog-stale/u,
      mutate(f) { fs.writeFileSync(f.skillPath, `${CURRENT}\nDrift while session creation is paused.\n`); },
    },
    {
      name: "capsule-expiry",
      fixture: { capsuleExpiresAt: NOW + 2 },
      expected: /global-evidence-packet-support-unavailable/u,
      initialClock: NOW + 1,
      mutate(_f, state) { state.clock = NOW + 3; },
    },
    {
      name: "support-expiry",
      fixture: { retentionDays: 1, materializedAt: NOW + DAY - 1 },
      expected: /global-support-drift/u,
      initialClock: NOW + DAY - 1,
      mutate(_f, state) { state.clock = NOW + DAY + 1; },
    },
    {
      name: "runtime-suppressor",
      expected: /host-unsupported/u,
      mutate(_f, state) { state.hostSupported = false; },
    },
    {
      name: "candidate-lease-expiry",
      expected: /global-candidate-synthesis-lease-invalid/u,
      initialClock: NOW + 1,
      mutate(_f, state) { state.clock += 5 * 60 * 1000 + 1; },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const f = existingFixture(t, scenario.fixture);
      const state = { clock: scenario.initialClock ?? NOW + 1, hostSupported: true };
      f.setClock(state.clock);
      const prompts = [];
      const gate = createGate(SYNTHESIS_AGENT_NAME);
      const pending = runGlobalSynthesis({
        ctx: providerContext(f.second, f.candidate, prompts, {}, {}, { beforeCreateResolve: (agent) => gate.wait(agent) }),
        candidate: f.candidate,
        catalog: f.catalog,
        inventoryModule: inventory,
        options: globalOptions(f.second, {
          getSuppressors: () => ({
            bootValidated: true,
            hostSupported: state.hostSupported,
            circuitBreakerOpen: false,
            processExcluded: false,
          }),
        }),
        now: () => state.clock,
      });
      await gate.started;
      scenario.mutate(f, state);
      f.setClock(state.clock);
      gate.release();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(result.reason, scenario.expected);
      assert.equal(prompts.length, 0);
      assert.equal(f.second.readGlobalRecommendations().length, 0);
    });
  }
});

test("critic pre-prompt freshness suppresses consent, target, and lease drift", async (t) => {
  const cases = [
    {
      name: "consent",
      expected: /global-synthesis-consent-required/u,
      mutate(f) {
        assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
          ...global,
          consent: { ...global.consent, sanitizedExcerpts: false, crossRepoAggregation: false },
          updatedAt: global.updatedAt + 1,
        })).ok, true);
      },
    },
    {
      name: "target",
      expected: /global-skill-catalog-stale/u,
      mutate(f) { fs.writeFileSync(f.skillPath, `${CURRENT}\nCritic-boundary drift.\n`); },
    },
    {
      name: "lease",
      expected: /global-candidate-synthesis-lease-invalid/u,
      mutate(_f, state) { state.clock += 5 * 60 * 1000 + 1; },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const f = existingFixture(t);
      const state = { clock: NOW + 1 };
      f.setClock(state.clock);
      const prompts = [];
      const gate = createGate(CRITIC_AGENT_NAME);
      const pending = runGlobalSynthesis({
        ctx: providerContext(f.second, f.candidate, prompts, {}, {}, { beforeCreateResolve: (agent) => gate.wait(agent) }),
        candidate: f.candidate,
        catalog: f.catalog,
        inventoryModule: inventory,
        options: globalOptions(f.second),
        now: () => state.clock,
      });
      await gate.started;
      scenario.mutate(f, state);
      f.setClock(state.clock);
      gate.release();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(result.reason, scenario.expected);
      assert.equal(prompts.length, 1);
      assert.equal(f.second.readGlobalRecommendations().length, 0);
    });
  }
});

test("critic pre-prompt budget is used for both its session claim and output parsing", async (t) => {
  const f = existingFixture(t);
  const prompts = [];
  const claims = [];
  const assertions = [];
  const gate = createGate(CRITIC_AGENT_NAME);
  const reasons = Array.from({ length: 13 }, (_, index) => `${index}:${"r".repeat(7_800)}`);
  const pending = runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts, {}, { reasons }, { beforeCreateResolve: (agent) => gate.wait(agent) }),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second, {
      hiddenAgentRegistration: {
        assert: (agent) => { assertions.push(agent); },
        claimSession(agent, sessionID, tokens) {
          claims.push({ agent, sessionID, tokens });
          return `${agent}:${sessionID}`;
        },
        releaseSession: () => {},
      },
    }),
    now: NOW + 1,
  });
  await gate.started;
  assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    budgets: { ...global.budgets, tokensPerSynthesis: 30_000 },
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  gate.release();
  const result = await pending;
  assert.equal(result.ok, true, result.reason);
  assert.equal(prompts.length, 2);
  assert.equal(Buffer.byteLength(JSON.stringify({
    score: 0.97,
    evidenceLinked: true,
    nonDuplicative: true,
    reasons,
    recommendedAction: "accept",
  }), "utf8") > 24_576 * 4, true);
  assert.deepEqual(claims.map(({ agent, tokens }) => ({ agent, tokens })), [
    { agent: SYNTHESIS_AGENT_NAME, tokens: 24_576 },
    { agent: CRITIC_AGENT_NAME, tokens: 30_000 },
  ]);
  assert.deepEqual(assertions, [
    SYNTHESIS_AGENT_NAME,
    SYNTHESIS_AGENT_NAME,
    CRITIC_AGENT_NAME,
    CRITIC_AGENT_NAME,
  ]);
});

test("the injected clock is sampled independently at admission, prompt boundaries, terminalization, failure, and release", async (t) => {
  const cases = [
    ["recommendation", {}, 5, "completed"],
    ["no-change", {
      action: "no-op",
      logicalName: null,
      proposedContent: "",
      rationale: "The bounded support does not justify a safe reusable change.",
      overlap: [],
      projectAssumptions: [],
    }, 4, "completed"],
    ["failure", { unexpectedAuthority: true }, 4, "failed-closed"],
  ];
  for (const [name, synthesisOutput, expectedSamples, expectedState] of cases) {
    await t.test(name, async (t) => {
      const f = existingFixture(t);
      let timestamp = NOW;
      const samples = [];
      const result = await runGlobalSynthesis({
        ctx: providerContext(f.second, f.candidate, [], synthesisOutput),
        candidate: f.candidate,
        catalog: f.catalog,
        inventoryModule: inventory,
        options: globalOptions(f.second),
        now: () => {
          timestamp += 10;
          samples.push(timestamp);
          return timestamp;
        },
      });
      assert.equal(samples.length, expectedSamples);
      assert.deepEqual(samples, Array.from({ length: expectedSamples }, (_, index) => NOW + (index + 1) * 10));
      const attempt = f.second.readGlobalSynthesisAttempts()[0];
      assert.equal(attempt.state, expectedState);
      assert.equal(attempt.admittedAt, samples[0]);
      assert.equal(attempt.updatedAt, samples.at(-2));
      const lease = f.second.getGlobalLease(globalSynthesisLeaseKey(f.candidate));
      assert.equal(lease.state, "released");
      assert.equal(lease.releasedAt, samples.at(-1));
      assert.equal(result.ok, name !== "failure");
    });
  }
});

test("critic rejection and critic-call budget denial terminalize without a recommendation", async (t) => {
  await t.test("critic rejection", async (t) => {
    const f = existingFixture(t);
    const prompts = [];
    const result = await runGlobalSynthesis({
      ctx: providerContext(f.second, f.candidate, prompts, {}, {
        score: 0.2,
        nonDuplicative: false,
        reasons: ["The draft overlaps existing guidance."],
        recommendedAction: "reject",
      }),
      candidate: f.candidate,
      catalog: f.catalog,
      inventoryModule: inventory,
      options: globalOptions(f.second),
      now: NOW + 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "critic-rejected");
    assert.equal(prompts.length, 2);
    assert.deepEqual(f.second.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["failed-closed"]);
    assert.equal(f.second.readGlobalRecommendations().length, 0);
  });

  await t.test("critic provider budget", async (t) => {
    const f = existingFixture(t);
    assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
      ...global,
      consent: { ...global.consent, passiveCalls: true },
      updatedAt: global.updatedAt + 1,
    })).ok, true);
    const prompts = [];
    let reservations = 0;
    const result = await runGlobalSynthesis({
      ctx: providerContext(f.second, f.candidate, prompts),
      candidate: f.candidate,
      catalog: f.catalog,
      inventoryModule: inventory,
      options: globalOptions(f.second, {
        reservePassiveProviderCalls() {
          reservations += 1;
          return reservations === 1 ? { ok: true } : { ok: false, reason: "passive-provider-budget-exhausted" };
        },
      }),
      now: NOW + 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "passive-provider-budget-exhausted");
    assert.equal(reservations, 2);
    assert.equal(prompts.length, 1);
    assert.deepEqual(f.second.readGlobalSynthesisAttempts().map((attempt) => attempt.state), ["failed-closed"]);
    assert.equal(f.second.readGlobalRecommendations().length, 0);
  });
});

test("consent drift while the synthesizer runs blocks critic dispatch", async (t) => {
  const f = existingFixture(t);
  const prompts = [];
  let revoked = false;
  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second, {
      faultInjection(point) {
        if (point !== "global-synthesis-after-provider" || revoked) return;
        revoked = true;
        assert.equal(f.second.updateGlobalSettings((global) => schemas.makeGlobalSettings({
          ...global,
          consent: { ...global.consent, sanitizedExcerpts: false, crossRepoAggregation: false },
          updatedAt: global.updatedAt + 1,
        })).ok, true);
      },
    }),
    now: NOW + 1,
  });
  assert.equal(revoked, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /global-synthesis-consent-required/u);
  assert.equal(prompts.length, 1, "critic provider call is suppressed by the fresh consent read");
  assert.equal(f.second.readGlobalRecommendations().length, 0);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "failed-closed");
});

test("a runtime suppressor activated while the synthesizer runs blocks critic dispatch", async (t) => {
  const f = existingFixture(t);
  const prompts = [];
  let circuitBreakerOpen = false;
  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second, {
      getSuppressors: () => ({
        bootValidated: true,
        hostSupported: true,
        circuitBreakerOpen,
        processExcluded: false,
      }),
      faultInjection(point) {
        if (point === "global-synthesis-after-provider") circuitBreakerOpen = true;
      },
    }),
    now: NOW + 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /circuit-breaker/u);
  assert.equal(prompts.length, 1);
  assert.equal(f.second.readGlobalRecommendations().length, 0);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "failed-closed");
});

test("an unchanged support set cannot admit or recommend twice", async (t) => {
  const f = existingFixture(t);
  const prompts = [];
  const first = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  assert.equal(first.ok, true, first.reason);
  const calls = { create: 0, prompt: 0 };
  const repeated = await runGlobalSynthesis({
    ctx: noProviderContext(calls),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 10,
  });
  assert.equal(repeated.ok, false);
  assert.match(repeated.reason, /global-candidate-drift|global-synthesis-already-admitted/u);
  assert.deepEqual(calls, { create: 0, prompt: 0 });
  assert.equal(f.second.readGlobalSynthesisAttempts().length, 1);
  assert.equal(f.second.readGlobalRecommendations().length, 1);
});

test("the ephemeral packet keeps one capsule per domain, eight domains, 240-byte entries, and 4 KiB total", async (t) => {
  const f = existingFixture(t);
  const summaries = [];
  for (let index = 0; index < 8; index += 1) {
    const digit = (index + 5).toString(16);
    const summary = `Independent validation pattern ${index}: ${"x".repeat(190)}`;
    summaries.push(summary);
    seedContribution(f.second, {
      incidentId: `private-diverse-incident-${index}`,
      capsuleId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      evidenceDomainId: schemas.makeEvidenceDomain({
        lineageStatus: "known",
        sourceLineageHash: H(`private-diverse-source-${index}`),
      }).domainId,
      rootLineageHash: H(`private-diverse-root-${index}`),
      occurrenceCount: 1,
      summary,
    });
  }
  const resolution = inventory.resolveGlobalSkillCandidate("durable-review", f.catalog);
  const rematerialized = f.second.materializeGlobalCandidates({
    targetBindings: [resolution.binding],
    rootPolicy: f.rootPolicy,
    nowMs: NOW,
  });
  assert.equal(rematerialized.ok, true, rematerialized.reason);
  const candidate = rematerialized.candidates[0];
  assert.equal(candidate.independentDomainCount, 9);
  const prompts = [];
  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, candidate, prompts),
    candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  assert.equal(result.ok, true, result.reason);
  const packetSource = /<UNTRUSTED_BOUNDED_EVIDENCE_PACKET>\n([^\n]+)\n<\/UNTRUSTED_BOUNDED_EVIDENCE_PACKET>/u.exec(prompts[0])?.[1];
  assert.ok(packetSource);
  const packet = JSON.parse(packetSource);
  assert.equal(packet.length, 8);
  assert.equal(Buffer.byteLength(packetSource, "utf8") <= 4 * 1024, true);
  assert.equal(packet.every((entry) => Buffer.byteLength(entry.summary, "utf8") <= 240), true);
  assert.equal(new Set(packet.map((entry) => entry.summary)).size, 8);
  const globalText = treeText(path.join(f.root, "self-evolve", "global"));
  for (const summary of summaries) assert.equal(globalText.includes(summary), false);
});

test("recovery never replays a dispatched attempt and waits for the identity-free lease to expire", async (t) => {
  const f = existingFixture(t);
  const leaseKeyHash = globalSynthesisLeaseKey(f.candidate);
  const acquired = f.second.acquireGlobalLease({ leaseKind: "candidate-synthesis", leaseKeyHash, ttlMs: 5 * 60 * 1000 });
  assert.equal(acquired.ok, true, acquired.reason);
  const binding = {
    attemptId: "99999999-9999-4999-8999-999999999999",
    candidateId: f.candidate.candidateId,
    supportSetHash: f.candidate.supportSetHash,
    targetBindingHash: f.candidate.targetBindingHash,
    leaseKeyHash,
    ownerToken: acquired.lease.ownerToken,
    suppressors: globalOptions(f.second).suppressors,
    nowMs: NOW + 1,
  };
  assert.equal(f.second.admitGlobalSynthesisAttempt(binding).ok, true);
  assert.equal(f.second.dispatchGlobalSynthesisAttempt({ ...binding, nowMs: NOW + 2 }).ok, true);

  const live = f.second.recoverGlobalSynthesisAttempts();
  assert.deepEqual(live.recovered, [{
    attemptId: binding.attemptId,
    state: "dispatched",
    deferred: true,
  }]);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "dispatched");

  f.setClock(NOW + 5 * 60 * 1000 + 1);
  const recovered = f.second.recoverGlobalSynthesisAttempts();
  assert.deepEqual(recovered.recovered, [{ attemptId: binding.attemptId, state: "failed-closed" }]);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "failed-closed");
  assert.equal(f.second.readGlobalCandidates()[0].state, "failed-closed");
  const calls = { create: 0, prompt: 0 };
  const replay = await runGlobalSynthesis({
    ctx: noProviderContext(calls),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 5 * 60 * 1000 + 2,
  });
  assert.equal(replay.ok, false);
  assert.deepEqual(calls, { create: 0, prompt: 0 });
  assert.equal(f.second.readGlobalSynthesisAttempts().length, 1);
});

test("recovery removes partial global recommendation content after a completion crash", async (t) => {
  let crashed = false;
  const f = existingFixture(t, {
    storeFaultInjection(point) {
      if (point !== "global-synthesis-after-content-chunk" || crashed) return;
      crashed = true;
      throw new Error("fixture-completion-crash");
    },
  });
  const prompts = [];
  const result = await runGlobalSynthesis({
    ctx: providerContext(f.second, f.candidate, prompts),
    candidate: f.candidate,
    catalog: f.catalog,
    inventoryModule: inventory,
    options: globalOptions(f.second),
    now: NOW + 1,
  });
  assert.equal(crashed, true);
  assert.equal(result.ok, false);
  assert.equal(prompts.length, 2);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "failed-closed");
  assert.equal(f.second.readGlobalRecommendations().length, 0);
  assert.notEqual(treeText(path.join(f.root, "self-evolve", "global", "recommendation-content")), "");

  const recovered = f.second.recoverGlobalSynthesisAttempts();
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(recovered.cleaned >= 1, true);
  assert.equal(treeText(path.join(f.root, "self-evolve", "global", "recommendation-content")), "");
  assert.equal(f.second.readGlobalRecommendations().length, 0);
});

test("concurrent processes admit one attempt and one canonical recommendation for unchanged support", async (t) => {
  const f = existingFixture(t);
  const markerPath = path.join(f.root, "provider-calls.log");
  fs.writeFileSync(markerPath, "");
  const args = [f.root, f.projectB, markerPath, "normal", String(NOW)];
  const results = await Promise.all([runSynthesisChild(args), runSynthesisChild(args)]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => !result.ok).length, 1, JSON.stringify(results));
  assert.match(results.find((result) => !result.ok).reason, /global-lease-busy|global-candidate-drift|global-synthesis-already-admitted/u);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 2);
  assert.equal(f.second.readGlobalSynthesisAttempts().length, 1);
  assert.equal(f.second.readGlobalRecommendations().length, 1);
  assert.equal(f.second.readGlobalCandidates()[0].state, "recommended");
});

test("a process killed after provider dispatch is terminalized and never replayed", async (t) => {
  const f = existingFixture(t);
  const markerPath = path.join(f.root, "provider-crash-calls.log");
  fs.writeFileSync(markerPath, "");
  await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "crash-after-provider",
    String(NOW),
  ], { expectSignal: "SIGKILL" });
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 1);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "dispatched");

  f.setClock(NOW + 5 * 60 * 1000 + 1);
  const recovery = f.second.recoverGlobalSynthesisAttempts();
  assert.deepEqual(recovery.recovered, [{
    attemptId: f.second.readGlobalSynthesisAttempts()[0].attemptId,
    state: "failed-closed",
  }]);
  const replay = await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "normal",
    String(NOW + 5 * 60 * 1000 + 2),
  ]);
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /global-candidate-drift|global-synthesis-already-admitted/u);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 1);
  assert.equal(f.second.readGlobalSynthesisAttempts().length, 1);
  assert.equal(f.second.readGlobalRecommendations().length, 0);
});

test("a process killed after the no-change candidate write recovers completion without replay", async (t) => {
  const f = existingFixture(t);
  const markerPath = path.join(f.root, "provider-no-change-crash.log");
  fs.writeFileSync(markerPath, "");
  await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "crash-after-candidate-no-change",
    String(NOW),
  ], { expectSignal: "SIGKILL" });
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 1);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "dispatched");
  assert.equal(f.second.readGlobalCandidates()[0].state, "no-change");
  assert.deepEqual(f.second.readGlobalRecommendations(), []);

  f.setClock(NOW + 5 * 60 * 1000 + 1);
  const recovery = f.second.recoverGlobalSynthesisAttempts();
  assert.deepEqual(recovery.recovered, [{
    attemptId: f.second.readGlobalSynthesisAttempts()[0].attemptId,
    state: "completed",
    noChange: true,
  }]);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "completed");
  assert.equal(f.second.readGlobalCandidates()[0].state, "no-change");

  const replay = await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "normal",
    String(NOW + 5 * 60 * 1000 + 2),
  ]);
  assert.equal(replay.ok, false);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 1);
});

test("a process killed after critic and canonical recommendation persistence recovers without provider replay", async (t) => {
  const f = existingFixture(t);
  const markerPath = path.join(f.root, "provider-recommendation-crash.log");
  fs.writeFileSync(markerPath, "");
  await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "crash-after-recommendation",
    String(NOW),
  ], { expectSignal: "SIGKILL" });
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 2);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "dispatched");
  assert.equal(f.second.readGlobalRecommendations().length, 1);

  f.setClock(NOW + 5 * 60 * 1000 + 1);
  const recovery = f.second.recoverGlobalSynthesisAttempts();
  assert.deepEqual(recovery.recovered, [{
    attemptId: f.second.readGlobalSynthesisAttempts()[0].attemptId,
    state: "completed",
  }]);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "completed");
  assert.equal(f.second.readGlobalCandidates()[0].state, "recommended");
  const replay = await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "normal",
    String(NOW + 5 * 60 * 1000 + 2),
  ]);
  assert.equal(replay.ok, false);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 2);
  assert.equal(f.second.readGlobalSynthesisAttempts().length, 1);
  assert.equal(f.second.readGlobalRecommendations().length, 1);
});

test("a process killed after candidate recommendation write completes the persisted recommendation without replay", async (t) => {
  const f = existingFixture(t);
  const markerPath = path.join(f.root, "provider-candidate-recommended-crash.log");
  fs.writeFileSync(markerPath, "");
  await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "crash-after-candidate-recommended",
    String(NOW),
  ], { expectSignal: "SIGKILL" });
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 2);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "dispatched");
  assert.equal(f.second.readGlobalCandidates()[0].state, "recommended");
  assert.equal(f.second.readGlobalRecommendations().length, 1);

  f.setClock(NOW + 5 * 60 * 1000 + 1);
  const recovery = f.second.recoverGlobalSynthesisAttempts();
  assert.deepEqual(recovery.recovered, [{
    attemptId: f.second.readGlobalSynthesisAttempts()[0].attemptId,
    state: "completed",
  }]);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "completed");
  assert.equal(f.second.readGlobalCandidates()[0].state, "recommended");
  assert.equal(f.second.readGlobalRecommendations().length, 1);
  assert.equal(f.second.readGlobalRecommendationContent(f.second.readGlobalRecommendations()[0].recommendationId), PROPOSED);

  const replay = await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "normal",
    String(NOW + 5 * 60 * 1000 + 2),
  ]);
  assert.equal(replay.ok, false);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length, 2);
});

test("recovery terminalizes a recommended candidate when its persisted recommendation content is partial", async (t) => {
  const f = existingFixture(t);
  const markerPath = path.join(f.root, "provider-invalid-candidate-recommended-crash.log");
  fs.writeFileSync(markerPath, "");
  await runSynthesisChild([
    f.root,
    f.projectB,
    markerPath,
    "crash-after-candidate-recommended",
    String(NOW),
  ], { expectSignal: "SIGKILL" });
  const contentRoot = path.join(f.root, "self-evolve", "global", "recommendation-content");
  const [firstChunk] = treeFiles(contentRoot);
  assert.ok(firstChunk);
  fs.rmSync(firstChunk);

  f.setClock(NOW + 5 * 60 * 1000 + 1);
  const recovery = f.second.recoverGlobalSynthesisAttempts();
  assert.deepEqual(recovery.recovered, [{
    attemptId: f.second.readGlobalSynthesisAttempts()[0].attemptId,
    state: "failed-closed",
  }]);
  assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, "failed-closed");
  assert.equal(f.second.readGlobalCandidates()[0].state, "failed-closed");
  assert.deepEqual(f.second.readGlobalRecommendations(), []);
  assert.equal(treeText(contentRoot), "");
});

test("a process killed at every remaining durable attempt boundary converges without provider replay", async (t) => {
  const boundaries = [
    { point: "global-synthesis-after-attempt-admission", providerCalls: 0, noChange: false },
    { point: "global-synthesis-after-candidate-pending", providerCalls: 0, noChange: false },
    { point: "global-synthesis-after-dispatch-marker", providerCalls: 0, noChange: false },
    { point: "global-synthesis-after-completion", providerCalls: 2, noChange: false },
    { point: "global-synthesis-after-no-change-completion", providerCalls: 1, noChange: true },
  ];
  for (const { point, providerCalls, noChange } of boundaries) {
    await t.test(point, async (t) => {
      const f = existingFixture(t);
      const markerPath = path.join(f.root, `provider-${point}.log`);
      fs.writeFileSync(markerPath, "");

      await runSynthesisChild([f.root, f.projectB, markerPath, `crash:${point}`, String(NOW)], { expectSignal: "SIGKILL" });

      const dispatched = () => fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length;
      assert.equal(dispatched(), providerCalls, `${point}: unexpected provider dispatch count`);
      const attempts = f.second.readGlobalSynthesisAttempts();
      assert.equal(attempts.length, 1);

      f.setClock(NOW + 5 * 60 * 1000 + 1);
      const recovery = f.second.recoverGlobalSynthesisAttempts();
      assert.equal(recovery.ok, true, recovery.reason);
      const recoveredState = f.second.readGlobalSynthesisAttempts()[0].state;
      assert.equal(["completed", "failed-closed"].includes(recoveredState), true, `${point}: ${recoveredState}`);
      const second = f.second.recoverGlobalSynthesisAttempts();
      assert.deepEqual(second.recovered, [], `${point}: recovery is not idempotent`);
      assert.equal(f.second.readGlobalSynthesisAttempts()[0].state, recoveredState);
      assert.equal(dispatched(), providerCalls, `${point}: recovery replayed the provider`);

      const candidateState = f.second.readGlobalCandidates()[0].state;
      const recommendations = f.second.readGlobalRecommendations();
      if (recoveredState === "completed" && !noChange) {
        assert.equal(candidateState, "recommended");
        assert.equal(recommendations.length, 1);
        assert.equal(f.second.readGlobalRecommendationContent(recommendations[0].recommendationId), PROPOSED);
      } else if (recoveredState === "completed") {
        assert.equal(candidateState, "no-change");
        assert.deepEqual(recommendations, []);
      } else {
        assert.equal(["failed-closed", "eligible", "collecting"].includes(candidateState), true, `${point}: ${candidateState}`);
        assert.deepEqual(recommendations, []);
        assert.equal(treeText(path.join(f.root, "self-evolve", "global", "recommendation-content")), "");
      }

      const replay = await runSynthesisChild([f.root, f.projectB, markerPath, "normal", String(NOW + 10 * 60 * 1000)]);
      assert.equal(replay.ok, false, `${point}: a terminal attempt was replayed`);
      assert.equal(f.second.readGlobalSynthesisAttempts().length, 1);
    });
  }
});

test("concurrent processes cannot exceed the global synthesis day cap with distinct candidates", async (t) => {
  const f = existingFixture(t, { synthesisPerDay: 1, otherSkillContent: OTHER_SKILL });
  seedContribution(f.first, {
    incidentId: "private-incident-other-a",
    capsuleId: "55555555-5555-4555-8555-555555555555",
    evidenceDomainId: f.evidenceDomain.domainId,
    rootLineageHash: H("private-root-other-a"),
    occurrenceCount: 2,
    summary: "A second repeated configuration failure needed its own verification step.",
    targetLogicalName: "other-review",
  });
  seedContribution(f.second, {
    incidentId: "private-incident-other-b",
    capsuleId: "66666666-6666-4666-8666-666666666666",
    evidenceDomainId: f.evidenceDomain.domainId,
    rootLineageHash: H("private-root-other-b"),
    occurrenceCount: 1,
    summary: "The second repeated failure recurred in another independent context.",
    targetLogicalName: "other-review",
  });
  const bindings = ["durable-review", "other-review"].map((logicalName) => {
    const resolution = inventory.resolveGlobalSkillCandidate(logicalName, f.catalog);
    assert.equal(resolution.ok, true, resolution.reason);
    return resolution.binding;
  });
  const materialized = f.second.materializeGlobalCandidates({ targetBindings: bindings, rootPolicy: f.rootPolicy, nowMs: NOW });
  assert.equal(materialized.ok, true, materialized.reason);
  const eligible = materialized.candidates.filter((candidate) => candidate.state === "eligible");
  assert.equal(eligible.length, 2, JSON.stringify(materialized.candidates.map((candidate) => candidate.state)));
  const markerPath = path.join(f.root, "provider-budget-race.log");
  fs.writeFileSync(markerPath, "");

  const results = await Promise.all(eligible.map((candidate) =>
    runSynthesisChild([f.root, f.projectB, markerPath, "normal", String(NOW), candidate.candidateId])));

  // Either protective gate may win the race, but only one attempt may exist.
  const denied = results.filter((result) => !result.ok);
  assert.equal(denied.length, 1, JSON.stringify(results));
  assert.match(denied[0].reason, /synthesis-budget-exhausted|global-synthesis-concurrency-exhausted|global-lease-busy/u);
  const attempts = f.second.readGlobalSynthesisAttempts();
  assert.equal(attempts.length, 1, JSON.stringify(attempts.map((attempt) => attempt.state)));
  const dispatched = fs.readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(dispatched.length <= 2, true, dispatched.join(","));
  assert.equal(f.second.readGlobalCandidates().filter((candidate) => candidate.state === "synthesis-pending").length, 0);

  // With the concurrency arbiter free, the exhausted day cap is what denies the
  // second candidate, and it never reaches the provider.
  const beforeRetry = fs.readFileSync(markerPath, "utf8");
  const retryCandidate = eligible.find((candidate) => candidate.candidateId !== attempts[0].candidateId);
  const retry = await runSynthesisChild([f.root, f.projectB, markerPath, "normal", String(NOW + 1_000), retryCandidate.candidateId]);
  assert.deepEqual(retry, { ok: false, reason: "synthesis-budget-exhausted" });
  assert.equal(fs.readFileSync(markerPath, "utf8"), beforeRetry);
  assert.equal(f.second.readGlobalSynthesisAttempts().length, 1);
});
