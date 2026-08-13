import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGlobalDecisionDomain } from "../self-evolve-applier.js";
import * as inventory from "../self-evolve-inventory.js";
import { createPrivacyGuard } from "../self-evolve-privacy.js";
import * as schemas from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";

const NOW = Date.UTC(2026, 7, 10);
const DAY = 86_400_000;
const PROJECT = inventory.hashSkillContent("private-domain-fixture");
const CURRENT = "---\nname: durable-review\ndescription: Reviews repeated failures safely.\n---\n\n# Durable Review\n\nInspect the failure.\n";
const PROPOSED = `${CURRENT}\nVerify the exact failure before suggesting a correction.\n`;
const PROCESS_CHILD = path.join(import.meta.dirname, "fixtures", "global-decision-process.mjs");
const GLOBAL_RECORD_MAX_BYTES = 16 * 1024;

function runDecisionChild(f, point, {
  action = "apply",
  decision = f.decision,
  expectSignal = null,
  project = inventory.hashSkillContent(`child:${point}`),
  readyPath = "none",
  releasePath = "none",
  storeOptions = {},
  clockStart = NOW,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      PROCESS_CHILD,
      path.join(f.root, "state"),
      project,
      JSON.stringify(decision),
      action,
      point,
      String(clockStart),
      readyPath,
      releasePath,
      JSON.stringify(storeOptions),
      JSON.stringify(f.policy),
    ], { stdio: ["ignore", "pipe", "pipe"] });
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
        catch (error) { reject(new Error(`child-invalid-json:${error.message}:stdout=${stdout}:stderr=${stderr}`)); }
      }
    });
  });
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed-out-waiting-for:${filePath}`);
}

function regularTreeBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return total + regularTreeBytes(filePath);
    return total + (entry.isFile() ? fs.lstatSync(filePath).size : 0);
  }, 0);
}

function writeGlobalRecord(stateRoot, directory, id, value) {
  const target = path.join(stateRoot, "self-evolve", "global", directory, id.slice(0, 2), `${id}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`);
}

function fixture(t, {
  mode = "manual",
  targetKind = "existing-global-skill",
  additionalRoot = false,
  faultInjection,
  forbiddenIdentityValues = [],
  currentContent = CURRENT,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-domain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillRoot = path.join(root, "global-skills");
  const target = path.join(skillRoot, "durable-review", "SKILL.md");
  fs.mkdirSync(skillRoot, { recursive: true });
  if (targetKind === "existing-global-skill") {
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, currentContent);
  }
  const otherSkillRoot = additionalRoot ? path.join(root, "other-global-skills") : null;
  if (otherSkillRoot) fs.mkdirSync(otherSkillRoot);
  let clock = NOW;
  const store = openStore(path.join(root, "state"), {
    projectFingerprint: PROJECT,
    now: () => clock,
    staleLockMs: 1,
    faultInjection,
  });
  t.after(() => store.close());
  const automationStamp = store.getAutomationState().stamp;
  const approvedRoot = schemas.makeApprovedGlobalRoot({
    canonicalPath: skillRoot,
    canUpdate: true,
    canCreate: targetKind === "new-global-skill",
  });
  const otherApprovedRoot = otherSkillRoot
    ? schemas.makeApprovedGlobalRoot({ canonicalPath: otherSkillRoot, canUpdate: true, canCreate: false })
    : null;
  const policy = schemas.makeGlobalRootPolicy({
    roots: [approvedRoot, ...(otherApprovedRoot ? [otherApprovedRoot] : [])],
    creationRootId: targetKind === "new-global-skill" ? approvedRoot.rootId : null,
    selectedBy: "operator",
    updatedAt: NOW,
  });
  const catalog = inventory.buildGlobalSkillCatalog(policy);
  const candidateResolution = inventory.resolveGlobalSkillCandidate(
    targetKind === "new-global-skill" ? null : "durable-review",
    catalog,
  );
  const recommendationResolution = targetKind === "new-global-skill"
    ? inventory.resolveNewGlobalSkillTarget(candidateResolution.binding, "durable-review", candidateResolution.catalog)
    : candidateResolution;
  const signatureHash = inventory.hashSkillContent("repeated-global-domain-error");
  const contributionIds = [];
  for (let index = 0; index < 2; index += 1) {
    const incidentId = `global-domain-incident-${index}`;
    const clusterId = inventory.hashSkillContent(`global-domain-cluster-${index}`);
    const capsuleId = index === 0
      ? "11111111-1111-4111-8111-111111111111"
      : "22222222-2222-4222-8222-222222222222";
    const targetLogicalName = targetKind === "new-global-skill" ? null : "durable-review";
    const scopeFingerprint = inventory.hashSkillContent(`global-domain-scope-${index}`);
    const observation = schemas.makeObservation({
      id: inventory.hashSkillContent(`global-domain-observation-${index}`),
      projectFingerprint: PROJECT,
      receiptIds: [signatureHash],
      structuredFields: {
        receiptType: "repeated-tool-error",
        scopeFingerprint,
        occurrences: index === 0 ? 2 : 1,
        deterministicOutcome: true,
        targetLogicalName,
      },
      incidentId,
      sessionLineageHash: inventory.hashSkillContent(`global-domain-session-${index}`),
      rootLineageHash: inventory.hashSkillContent(`global-domain-root-${index}`),
      originKind: "user",
      createdAt: NOW,
      injectionFlagged: false,
      redacted: true,
      automationGeneration: automationStamp.generation,
    });
    const cluster = schemas.makeEvidenceCluster({
      id: clusterId,
      receiptType: "repeated-tool-error",
      projectFingerprint: PROJECT,
      incidentIds: [incidentId],
      scopeFingerprint,
      targetLogicalName,
      occurrencesSum: index === 0 ? 2 : 1,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    const capsule = schemas.makeEvidenceCapsule({
      capsuleId,
      incidentId,
      receiptType: cluster.receiptType,
      targetLogicalName,
      summary: "A deterministic global-domain failure repeated during verification.",
      createdAt: NOW,
      expiresAt: NOW + 30 * DAY,
      automationGeneration: automationStamp.generation,
    });
    assert.equal(store.appendRecord(schemas.wrapRecord("observation", observation, NOW), { automationStamp }).ok, true);
    assert.equal(store.appendRecord(schemas.wrapRecord("evidence-cluster", cluster, NOW), { automationStamp }).ok, true);
    assert.equal(store.appendEvidenceCapsule(capsule, { automationStamp }).ok, true);
    const published = store.publishContribution({
      claimType: "global-skill-candidate",
      receiptType: cluster.receiptType,
      signatureHash,
      incidentId,
      capsuleId,
      clusterId,
      evidenceDomainId: inventory.hashSkillContent("global-domain-evidence-domain"),
      occurrenceCount: index === 0 ? 2 : 1,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    }, { automationStamp });
    assert.equal(published.ok, true, published.reason);
    contributionIds.push(published.contribution.contributionId);
  }
  const preliminary = schemas.makeGlobalCandidate({
    claimType: "global-skill-candidate",
    receiptType: "repeated-tool-error",
    signatureHash,
    targetBindingHash: candidateResolution.binding.bindingHash,
    supportSetHash: inventory.hashSkillContent("preliminary-support"),
    state: "recommended",
    eligibilityRoute: "single-domain",
    independentDomainCount: 1,
    independentIncidentCount: 2,
    occurrenceCount: 3,
    firstSeenDay: "2026-08-10",
    lastSeenDay: "2026-08-10",
    createdAt: NOW,
    updatedAt: NOW,
    automationGeneration: automationStamp.generation,
  });
  const support = schemas.makeGlobalSupportSet({
    candidateId: preliminary.candidateId,
    targetBinding: candidateResolution.binding,
    contributionIds,
    strongestSingleDomain: {
      lineageClass: "known",
      independentIncidentCount: 2,
      occurrenceCount: 3,
      nonUnknownUserRootLineageCount: 2,
      freshnessRatio: 1,
    },
    distributed: {
      independentKnownDomainCount: 1,
      independentIncidentCount: 2,
      unknownLineageCollapsed: false,
    },
    integrity: {
      contradictionFree: true,
      injectionFree: true,
      chronologyValid: true,
      correlationValid: true,
    },
    firstSeenDay: "2026-08-10",
    lastSeenDay: "2026-08-10",
    evaluatedAt: NOW,
    expiresAt: NOW + 30 * DAY,
    automationGeneration: automationStamp.generation,
  });
  const candidate = schemas.makeGlobalCandidate({ ...preliminary, supportSetHash: support.supportSetHash });
  const targetBinding = schemas.makeRecommendationTargetBinding({
    targetKind: recommendationResolution.binding.targetKind,
    rootId: recommendationResolution.binding.rootId,
    logicalName: recommendationResolution.binding.logicalName,
    relativePath: recommendationResolution.binding.relativePath,
    currentHash: recommendationResolution.binding.currentHash,
    catalogGenerationHash: recommendationResolution.binding.catalogGenerationHash,
    rootSetHash: recommendationResolution.binding.rootSetHash,
    candidateBindingHash: candidateResolution.binding.bindingHash,
  }, candidateResolution.binding, policy);
  const recommendation = schemas.makeGlobalRecommendation({
    candidateId: candidate.candidateId,
    supportSetHash: support.supportSetHash,
    candidateTargetBindingHash: candidateResolution.binding.bindingHash,
    targetBinding,
    proposedContentHash: inventory.hashSkillContent(PROPOSED),
    rationaleText: "Independent support warrants one bounded global skill correction.",
    synthesizedAt: NOW,
    synthesizerModelId: "mock/model",
    criticScore: 0.99,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    decisionVersion: 0,
    burnedNonceHashes: [],
  });
  const chunk = schemas.makeGlobalRecommendationContent({
    recommendationId: recommendation.recommendationId,
    contentHash: recommendation.proposedContentHash,
    contentEncoding: "base64",
    chunkIndex: 0,
    chunkCount: 1,
    content: Buffer.from(PROPOSED).toString("base64"),
  });
  const stateRoot = path.join(root, "state");
  writeGlobalRecord(stateRoot, "candidates", candidate.candidateId, candidate);
  writeGlobalRecord(stateRoot, "candidate-support", support.supportSetHash, support);
  writeGlobalRecord(stateRoot, "recommendations", recommendation.recommendationId, recommendation);
  const contentPath = path.join(stateRoot, "self-evolve", "global", "recommendation-content", recommendation.recommendationId.slice(0, 2), recommendation.recommendationId, "000000.json");
  fs.mkdirSync(path.dirname(contentPath), { recursive: true });
  fs.writeFileSync(contentPath, `${JSON.stringify(chunk)}\n`);
  let suppressors = { circuitBreakerOpen: false, emergencyStop: false };
  const domain = createGlobalDecisionDomain({
    store,
    inventory,
    now: () => ++clock,
    getCatalog: () => inventory.buildGlobalSkillCatalog(policy),
    getSuppressors: () => ({ ...suppressors }),
    forbiddenIdentityValues,
    faultInjection,
  });
  const decision = schemas.makeGlobalDecision({
    recommendationId: recommendation.recommendationId,
    supportSetHash: recommendation.supportSetHash,
    targetBindingHash: recommendation.targetBinding.bindingHash,
    targetHash: recommendation.targetBinding.currentHash,
    proposedContentHash: recommendation.proposedContentHash,
    decisionVersion: 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce: "explicit-existing-apply",
    priorState: "pending",
    newState: "approved",
  });
  return {
    root,
    skillRoot,
    otherSkillRoot,
    target,
    store,
    policy,
    recommendation,
    decision,
    domain,
    setClock: (value) => { clock = value; },
    setSuppressors: (value) => { suppressors = { ...suppressors, ...value }; },
  };
}

function constrainedDomain(t, f, options, { clockStart = NOW } = {}) {
  let clock = clockStart;
  const store = openStore(path.join(f.root, "state"), {
    projectFingerprint: PROJECT,
    now: () => ++clock,
    staleLockMs: 1,
    ...options,
  });
  t.after(() => store.close());
  const domain = createGlobalDecisionDomain({
    store,
    inventory,
    now: () => ++clock,
    getCatalog: () => inventory.buildGlobalSkillCatalog(f.policy),
    getSuppressors: () => ({ circuitBreakerOpen: false, emergencyStop: false }),
  });
  return { store, domain };
}

function transitionPermission(f, permission, enabled, transitionId) {
  const current = f.store.getAutomationState();
  assert.equal(current.ok, true, current.reason);
  const result = f.store.transitionAutomation({
    transitionId,
    expectedGeneration: current.epoch.generation,
    action: "set-permission",
    permission,
    enabled,
  });
  assert.equal(result.ok, true, result.reason);
  return result;
}

function transitionEmergencyStop(f, enabled, transitionId) {
  const current = f.store.getAutomationState();
  assert.equal(current.ok, true, current.reason);
  const result = f.store.transitionAutomation({
    transitionId,
    expectedGeneration: current.epoch.generation,
    action: "set-emergency-stop",
    enabled,
  });
  assert.equal(result.ok, true, result.reason);
  return result;
}

function rejectDecision(f, nonce = "explicit-global-reject") {
  return schemas.makeGlobalDecision({
    recommendationId: f.recommendation.recommendationId,
    supportSetHash: f.recommendation.supportSetHash,
    targetBindingHash: f.recommendation.targetBinding.bindingHash,
    targetHash: f.recommendation.targetBinding.currentHash,
    proposedContentHash: f.recommendation.proposedContentHash,
    decisionVersion: f.recommendation.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce,
    priorState: "pending",
    newState: "rejected",
  });
}

test("the global decision domain requires an explicit suppressor provider", (t) => {
  const f = fixture(t);
  assert.throws(
    () => createGlobalDecisionDomain({ store: f.store, inventory }),
    /global-decision-suppressors-required/u,
  );
});

test("rejected global recommendation content compacts immediately while the decision remains auditable", (t) => {
  const f = fixture(t);
  const rejected = f.store.rejectGlobalRecommendation({ decision: rejectDecision(f), nowMs: NOW });
  assert.equal(rejected.ok, true, rejected.reason);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "rejected");
  assert.equal(f.store.readGlobalRecommendationContent(f.recommendation.recommendationId), null);
  assert.equal(f.store.readGlobalDecisions().length, 1);
  assert.equal(f.store.readGlobalAudits().length, 1);
});

test("global recommendation purge preserves an applied rollback chain", async (t) => {
  const f = fixture(t);
  const applied = await f.domain.decide({ action: "apply", decision: f.decision });
  assert.equal(applied.ok, true, applied.reason);
  const before = {
    recommendations: f.store.readGlobalRecommendations(),
    decisions: f.store.readGlobalDecisions(),
    intents: f.store.readGlobalApplyIntents(),
    snapshots: f.store.readGlobalSkillSnapshots(),
    outcomes: f.store.readGlobalDecisionOutcomes(),
    audits: f.store.readGlobalAudits(),
  };

  const purged = f.store.purge({
    scope: "global-recommendation",
    recommendationId: f.recommendation.recommendationId,
  });

  assert.equal(purged.ok, true, purged.reason);
  assert.equal(purged.counts.protectedGlobalRecommendations, 1);
  assert.deepEqual(f.store.readGlobalRecommendations(), before.recommendations);
  assert.deepEqual(f.store.readGlobalDecisions(), before.decisions);
  assert.deepEqual(f.store.readGlobalApplyIntents(), before.intents);
  assert.deepEqual(f.store.readGlobalSkillSnapshots(), before.snapshots);
  assert.deepEqual(f.store.readGlobalDecisionOutcomes(), before.outcomes);
  assert.deepEqual(f.store.readGlobalAudits(), before.audits);
});

test("global retention reclaims a rejected chain and its quota footprint", (t) => {
  const f = fixture(t);
  assert.equal(f.store.rejectGlobalRecommendation({ decision: rejectDecision(f), nowMs: NOW }).ok, true);
  const before = f.store.getGlobalUsage();

  const retained = f.store.retain(NOW + 91 * DAY);

  assert.equal(retained.globalRecommendations, 1);
  assert.equal(retained.globalCandidates, 1);
  assert.equal(retained.globalSupportSets, 1);
  assert.equal(retained.globalDecisions, 1);
  assert.equal(retained.globalAudits, 1);
  assert.deepEqual(f.store.readGlobalRecommendations(), []);
  assert.deepEqual(f.store.readGlobalCandidates(), []);
  assert.deepEqual(f.store.readGlobalSupportSets(), []);
  const after = f.store.getGlobalUsage();
  assert.equal(after.bytesUsed < before.bytesUsed, true);
  assert.equal(after.filesUsed < before.filesUsed, true);
});

test("global retention preserves applied audit snapshot and Undo authority past nominal age", async (t) => {
  const f = fixture(t);
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  const before = {
    recommendation: f.store.readGlobalRecommendations(),
    intents: f.store.readGlobalApplyIntents(),
    snapshots: f.store.readGlobalSkillSnapshots(),
    outcomes: f.store.readGlobalDecisionOutcomes(),
    audits: f.store.readGlobalAudits(),
  };

  f.store.retain(NOW + 365 * DAY);

  assert.deepEqual(f.store.readGlobalRecommendations(), before.recommendation);
  assert.deepEqual(f.store.readGlobalApplyIntents(), before.intents);
  assert.deepEqual(f.store.readGlobalSkillSnapshots(), before.snapshots);
  assert.deepEqual(f.store.readGlobalDecisionOutcomes(), before.outcomes);
  assert.deepEqual(f.store.readGlobalAudits(), before.audits);
});

test("identity-bearing decision nonces create no global decision artifacts", async (t) => {
  const local = fixture(t);
  const localResult = await local.domain.decide({
    action: "apply",
    decision: { ...local.decision, nonce: `operator-${PROJECT}` },
  });
  const foreignIdentity = inventory.hashSkillContent("future-acting-project");
  const foreign = fixture(t, { forbiddenIdentityValues: [foreignIdentity] });
  const foreignResult = await foreign.domain.decide({
    action: "apply",
    decision: { ...foreign.decision, nonce: `operator-${foreignIdentity}` },
  });

  for (const [f, result] of [[local, localResult], [foreign, foreignResult]]) {
    assert.equal(result.ok, false);
    assert.match(result.reason, /forbidden-global-identity/u);
    assert.equal(f.store.readGlobalDecisions().length, 0);
    assert.equal(f.store.readGlobalApplyIntents().length, 0);
    assert.equal(f.store.readGlobalSkillSnapshots().length, 0);
    assert.equal(f.store.readGlobalDecisionOutcomes().length, 0);
    assert.equal(f.store.readGlobalAudits().length, 0);
    assert.equal(f.store.readGlobalRecommendations()[0].state, "pending");
  }
});

test("an explicit global Apply succeeds once in project Manual mode", async (t) => {
  const f = fixture(t, { mode: "manual" });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.outcome.reason, "applied");
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "applied");
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
  assert.equal(f.store.readGlobalAudits().filter((audit) => audit.kind === "apply").length, 1);
});

test("the same explicit Apply returns its idempotent outcome without a second write", async (t) => {
  const f = fixture(t, { mode: "auto" });
  const first = await f.domain.decide({ action: "apply", decision: f.decision });
  const firstStat = fs.statSync(f.target);

  const replay = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.outcome, first.outcome);
  assert.equal(fs.statSync(f.target).ino, firstStat.ino);
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
  assert.equal(f.store.readGlobalAudits().filter((audit) => audit.kind === "apply").length, 1);
});

test("durable Reject converges idempotently to one recommendation, decision, and exact audit", (t) => {
  const f = fixture(t);
  const decision = rejectDecision(f);

  const first = f.store.rejectGlobalRecommendation({ decision, nowMs: NOW + 1 });
  const replay = f.store.rejectGlobalRecommendation({ decision, nowMs: NOW + 2 });

  assert.equal(first.ok, true, first.reason);
  assert.equal(replay.ok, true, replay.reason);
  assert.equal(replay.duplicate, true);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "rejected");
  assert.deepEqual(f.store.readGlobalDecisions(), [first.decision]);
  assert.deepEqual(f.store.readGlobalAudits(), [first.audit]);
});

test("durable Reject recovery converges after process death at every decision-first write", async (t) => {
  for (const [point, expectedState, expectedAudits] of [
    ["global-reject-after-decision", "pending", 0],
    ["global-reject-after-recommendation", "rejected", 0],
    ["global-reject-after-audit", "rejected", 1],
  ]) {
    await t.test(point, async (t) => {
      const f = fixture(t);
      const decision = rejectDecision(f, `reject-${point}`);
      await runDecisionChild(f, point, { action: "reject", decision, expectSignal: "SIGKILL" });

      assert.equal(f.store.readGlobalRecommendations()[0].state, expectedState);
      assert.deepEqual(f.store.readGlobalDecisions(), [decision]);
      assert.equal(f.store.readGlobalAudits().length, expectedAudits);

      const first = f.store.recoverGlobalRejections();
      const second = f.store.recoverGlobalRejections();

      assert.equal(first.ok, true, first.reason);
      assert.equal(first.recovered.length, 1);
      assert.equal(second.ok, true, second.reason);
      assert.equal(second.recovered.length, 1);
      assert.equal(second.recovered[0].duplicate, true);
      assert.equal(f.store.readGlobalRecommendations()[0].state, "rejected");
      assert.deepEqual(f.store.readGlobalDecisions(), [decision]);
      assert.deepEqual(f.store.readGlobalAudits(), [first.recovered[0].audit]);
    });
  }
});

test("durable Reject recovery fails closed on conflicting persisted decisions and audits", async (t) => {
  await t.test("decision conflict", async (t) => {
    const f = fixture(t);
    const decision = rejectDecision(f, "reject-decision-conflict");
    await runDecisionChild(f, "global-reject-after-decision", { action: "reject", decision, expectSignal: "SIGKILL" });
    const conflict = schemas.makeGlobalDecision({
      ...decision,
      timestamp: decision.timestamp + 1,
      nonce: "reject-decision-conflict-other",
    });
    writeGlobalRecord(path.join(f.root, "state"), "decisions", schemas.globalDecisionId(conflict), conflict);

    const recovered = f.store.recoverGlobalRejections();

    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, "global-rejection-decision-conflict");
    assert.equal(f.store.readGlobalRecommendations()[0].state, "pending");
    assert.deepEqual(f.store.readGlobalAudits(), []);
  });

  await t.test("audit conflict", async (t) => {
    const f = fixture(t);
    const decision = rejectDecision(f, "reject-audit-conflict");
    await runDecisionChild(f, "global-reject-after-decision", { action: "reject", decision, expectSignal: "SIGKILL" });
    const conflict = schemas.makeGlobalAuditEvent({
      kind: "reject",
      recommendationId: decision.recommendationId,
      actorRole: "operator",
      timestamp: decision.timestamp + 1,
      supportSetHash: decision.supportSetHash,
      targetBindingHash: decision.targetBindingHash,
      proposedContentHash: decision.proposedContentHash,
      decisionVersion: decision.decisionVersion,
      outcome: "failed-closed",
    });
    writeGlobalRecord(path.join(f.root, "state"), "audits", conflict.auditId, conflict);

    const recovered = f.store.recoverGlobalRejections();

    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, "global-rejection-audit-conflict");
    assert.equal(f.store.readGlobalRecommendations()[0].state, "pending");
    assert.deepEqual(f.store.readGlobalAudits(), [conflict]);
  });
});

test("durable Reject reserves its exact decision transition and audit before writing", (t) => {
  const f = fixture(t);
  const usage = f.store.getGlobalUsage();
  f.store.close();
  const constrained = openStore(path.join(f.root, "state"), {
    projectFingerprint: PROJECT,
    now: () => NOW,
    staleLockMs: 1,
    globalQuotaFiles: usage.filesUsed,
  });
  t.after(() => constrained.close());

  const result = constrained.rejectGlobalRecommendation({ decision: rejectDecision(f), nowMs: NOW + 1 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "global-file-quota-exceeded");
  assert.equal(constrained.readGlobalRecommendations()[0].state, "pending");
  assert.deepEqual(constrained.readGlobalDecisions(), []);
  assert.deepEqual(constrained.readGlobalAudits(), []);
});

test("durable Reject recovery remains pending when quota cannot hold the exact audit", async (t) => {
  const f = fixture(t);
  const decision = rejectDecision(f, "reject-recovery-quota");
  await runDecisionChild(f, "global-reject-after-decision", { action: "reject", decision, expectSignal: "SIGKILL" });
  const usage = f.store.getGlobalUsage();
  f.store.close();
  const constrained = openStore(path.join(f.root, "state"), {
    projectFingerprint: PROJECT,
    now: () => NOW + 1,
    staleLockMs: 1,
    globalQuotaFiles: usage.filesUsed - 1,
  });
  t.after(() => constrained.close());

  const recovered = constrained.recoverGlobalRejections();

  assert.equal(recovered.ok, false);
  assert.equal(recovered.reason, "global-file-quota-exceeded");
  assert.equal(constrained.readGlobalRecommendations()[0].state, "pending");
  assert.deepEqual(constrained.readGlobalDecisions(), [decision]);
  assert.deepEqual(constrained.readGlobalAudits(), []);
});

test("a persisted Reject decision fences a conflicting Apply before Reject recovery", async (t) => {
  const f = fixture(t);
  const reject = rejectDecision(f, "reject-fences-apply");
  await runDecisionChild(f, "global-reject-after-decision", { action: "reject", decision: reject, expectSignal: "SIGKILL" });
  const competitor = constrainedDomain(t, f, {});
  const leaseKeyHash = schemas.globalTargetLeaseKey(f.recommendation.targetBinding);
  const leaseBefore = competitor.store.getGlobalLease(leaseKeyHash);
  const usageBefore = competitor.store.getGlobalUsage();

  const applied = await competitor.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(applied.ok, false);
  assert.equal(applied.reason, "global-operator-decision-conflict");
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  assert.deepEqual(competitor.store.readGlobalApplyIntents(), []);
  assert.deepEqual(competitor.store.readGlobalDecisionOutcomes(), []);
  assert.deepEqual(competitor.store.readGlobalAudits(), []);
  assert.deepEqual(competitor.store.getGlobalLease(leaseKeyHash), leaseBefore);
  assert.deepEqual(competitor.store.getGlobalUsage(), usageBefore);
  const recovered = competitor.store.recoverGlobalRejections();
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(competitor.store.readGlobalRecommendations()[0].state, "rejected");
  assert.deepEqual(competitor.store.readGlobalDecisions(), [reject]);
  assert.deepEqual(competitor.store.readGlobalAudits(), [recovered.recovered[0].audit]);
});

test("a decision-only Reject preserves its unchanged byte and file quota for recovery", async (t) => {
  await t.test("bytes", async (t) => {
    const f = fixture(t);
    const decision = rejectDecision(f, "reject-byte-reservation");
    const usage = f.store.getGlobalUsage();
    const recommendationPath = path.join(
      f.root,
      "state",
      "self-evolve",
      "global",
      "recommendations",
      decision.recommendationId.slice(0, 2),
      `${decision.recommendationId}.json`,
    );
    const quotaBytes = usage.bytesUsed
      - fs.lstatSync(recommendationPath).size
      + GLOBAL_RECORD_MAX_BYTES
      + Buffer.byteLength(`${JSON.stringify(decision)}\n`)
      + GLOBAL_RECORD_MAX_BYTES;
    f.store.close();
    await runDecisionChild(f, "global-reject-after-decision", {
      action: "reject",
      decision,
      expectSignal: "SIGKILL",
      storeOptions: { globalQuotaBytes: quotaBytes },
    });
    const constrained = openStore(path.join(f.root, "state"), {
      projectFingerprint: PROJECT,
      now: () => NOW + 1,
      staleLockMs: 1,
      globalQuotaBytes: quotaBytes,
    });
    t.after(() => constrained.close());

    const competing = constrained.updateGlobalSettings((global) => schemas.makeGlobalSettings({
      ...global,
      allowedSkillRoots: [`/${"x".repeat(1000)}`],
      updatedAt: global.updatedAt + 1,
    }));

    assert.equal(competing.ok, false);
    assert.equal(competing.reason, "global-storage-quota-exceeded");
    assert.equal(constrained.getGlobalUsage().quotaBytes, quotaBytes);
    const recovered = constrained.recoverGlobalRejections();
    assert.equal(recovered.ok, true, recovered.reason);
    assert.equal(constrained.getGlobalUsage().quotaBytes, quotaBytes);
    assert.equal(constrained.readGlobalRecommendations()[0].state, "rejected");
    assert.deepEqual(constrained.readGlobalDecisions(), [decision]);
    assert.equal(constrained.readGlobalAudits().length, 1);
  });

  await t.test("files", async (t) => {
    const f = fixture(t);
    const decision = rejectDecision(f, "reject-file-reservation");
    const quotaFiles = f.store.getGlobalUsage().filesUsed + 2;
    f.store.close();
    await runDecisionChild(f, "global-reject-after-decision", {
      action: "reject",
      decision,
      expectSignal: "SIGKILL",
      storeOptions: { globalQuotaFiles: quotaFiles },
    });
    const constrained = openStore(path.join(f.root, "state"), {
      projectFingerprint: PROJECT,
      now: () => NOW + 1,
      staleLockMs: 1,
      globalQuotaFiles: quotaFiles,
    });
    t.after(() => constrained.close());

    const competing = constrained.acquireGlobalLease({
      leaseKind: "target-write",
      leaseKeyHash: inventory.hashSkillContent("reject-reservation-competitor"),
      ttlMs: 60_000,
    });

    assert.equal(competing.ok, false);
    assert.equal(competing.reason, "global-file-quota-exceeded");
    assert.equal(constrained.getGlobalUsage().quotaFiles, quotaFiles);
    const recovered = constrained.recoverGlobalRejections();
    assert.equal(recovered.ok, true, recovered.reason);
    assert.equal(constrained.getGlobalUsage().quotaFiles, quotaFiles);
    assert.equal(constrained.readGlobalRecommendations()[0].state, "rejected");
    assert.deepEqual(constrained.readGlobalDecisions(), [decision]);
    assert.equal(constrained.readGlobalAudits().length, 1);
  });
});

test("an explicit Undo restores the exact existing global skill snapshot", async (t) => {
  const f = fixture(t);
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  const applied = f.store.readGlobalRecommendations()[0];
  const undoDecision = schemas.makeGlobalDecision({
    recommendationId: applied.recommendationId,
    supportSetHash: applied.supportSetHash,
    targetBindingHash: applied.targetBinding.bindingHash,
    targetHash: applied.proposedContentHash,
    proposedContentHash: applied.proposedContentHash,
    decisionVersion: applied.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce: "explicit-existing-undo",
    priorState: "applied",
    newState: "undo-approved",
  });

  const undone = await f.domain.decide({ action: "undo", decision: undoDecision });

  assert.equal(undone.ok, true, undone.reason);
  assert.equal(undone.outcome.reason, "undone");
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "rolled-back");
  assert.equal(f.store.readGlobalAudits().filter((audit) => audit.kind === "undo").length, 1);
});

test("new global skill Apply is create-exclusive and Undo removes only the plugin-created target", async (t) => {
  const f = fixture(t, { targetKind: "new-global-skill" });
  const applied = await f.domain.decide({ action: "apply", decision: f.decision });
  assert.equal(applied.ok, true, applied.reason);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.deepEqual(fs.readdirSync(f.skillRoot).filter((name) => name.startsWith(".self-evolve-owner-")), []);
  const applyIntent = f.store.readGlobalApplyIntents()[0];
  assert.match(applyIntent.directoryDevice, /^(?:0|[1-9][0-9]*)$/u);
  assert.match(applyIntent.directoryInode, /^(?:0|[1-9][0-9]*)$/u);
  const current = f.store.readGlobalRecommendations()[0];
  const undoDecision = schemas.makeGlobalDecision({
    recommendationId: current.recommendationId,
    supportSetHash: current.supportSetHash,
    targetBindingHash: current.targetBinding.bindingHash,
    targetHash: current.proposedContentHash,
    proposedContentHash: current.proposedContentHash,
    decisionVersion: current.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce: "explicit-new-skill-undo",
    priorState: "applied",
    newState: "undo-approved",
  });

  const undone = await f.domain.decide({ action: "undo", decision: undoDecision });

  assert.equal(undone.ok, true, undone.reason);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.existsSync(path.dirname(f.target)), false);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "rolled-back");
});

test("stale decision bindings, revoked consent, support expiry, target drift, and emergency stop fail before mutation", async (t) => {
  await t.test("decision version", async (t) => {
    const f = fixture(t);
    const result = await f.domain.decide({ action: "apply", decision: { ...f.decision, decisionVersion: 2 } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stale-global-decision");
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("support binding", async (t) => {
    const f = fixture(t);
    const result = await f.domain.decide({ action: "apply", decision: { ...f.decision, supportSetHash: inventory.hashSkillContent("changed-support") } });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("recommendation binding", async (t) => {
    const f = fixture(t);
    const result = await f.domain.decide({ action: "apply", decision: { ...f.decision, recommendationId: inventory.hashSkillContent("changed-recommendation") } });
    assert.equal(result.reason, "global-recommendation-not-found");
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("target binding", async (t) => {
    const f = fixture(t);
    const result = await f.domain.decide({ action: "apply", decision: { ...f.decision, targetBindingHash: inventory.hashSkillContent("changed-target-binding") } });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("consent", async (t) => {
    const f = fixture(t);
    transitionPermission(f, "crossRepoAggregation", false, "domain-revoke-consent");
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.reason, "global-apply-consent-required");
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("support expiry", async (t) => {
    const f = fixture(t);
    f.setClock(NOW + 31 * DAY);
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.reason, "global-support-invalid");
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("target hash", async (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.target, `${CURRENT}\nExternal drift.\n`);
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.ok, false);
    assert.match(result.reason, /catalog-stale|target-stale/u);
    assert.match(fs.readFileSync(f.target, "utf8"), /External drift/u);
  });
  await t.test("emergency stop", async (t) => {
    const f = fixture(t);
    f.setSuppressors({ emergencyStop: true });
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.reason, "emergency-stop");
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("kill switch", async (t) => {
    const f = fixture(t);
    transitionEmergencyStop(f, true, "domain-enable-emergency-stop");
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.reason, "kill-switch");
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("circuit breaker", async (t) => {
    const f = fixture(t);
    f.setSuppressors({ circuitBreakerOpen: true });
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.reason, "circuit-breaker");
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
});

test("a nonce replay on a different valid edge fails closed", async (t) => {
  const f = fixture(t);
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  const applied = f.store.readGlobalRecommendations()[0];
  const replayed = schemas.makeGlobalDecision({
    recommendationId: applied.recommendationId,
    supportSetHash: applied.supportSetHash,
    targetBindingHash: applied.targetBinding.bindingHash,
    targetHash: applied.proposedContentHash,
    proposedContentHash: applied.proposedContentHash,
    decisionVersion: applied.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce: f.decision.nonce,
    priorState: "applied",
    newState: "undo-approved",
  });

  const result = await f.domain.decide({ action: "undo", decision: replayed });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "replayed-decision");
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
});

test("duplicate names, path collisions, and symlink drift fail closed through the direct domain", async (t) => {
  await t.test("duplicate logical name", async (t) => {
    const f = fixture(t, { additionalRoot: true });
    const duplicate = path.join(f.otherSkillRoot, "durable-review", "SKILL.md");
    fs.mkdirSync(path.dirname(duplicate));
    fs.writeFileSync(duplicate, CURRENT);
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "duplicate-global-skill-name");
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
  await t.test("new target directory collision", async (t) => {
    const f = fixture(t, { targetKind: "new-global-skill" });
    fs.mkdirSync(path.dirname(f.target));
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "new-global-skill-path-collision");
    assert.equal(fs.existsSync(f.target), false);
  });
  await t.test("symlink drift", async (t) => {
    const f = fixture(t);
    const outside = path.join(f.root, "outside");
    const moved = `${path.dirname(f.target)}-moved`;
    fs.mkdirSync(outside);
    fs.renameSync(path.dirname(f.target), moved);
    fs.symlinkSync(outside, path.dirname(f.target), "dir");
    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "approved-root-symlink-entry");
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.readFileSync(path.join(moved, "SKILL.md"), "utf8"), CURRENT);
  });
});

test("a post-publication readback failure rolls back only the hash-proven plugin mutation", async (t) => {
  const f = fixture(t, {
    faultInjection(point) {
      if (point === "global-apply-before-readback") throw new Error("injected-readback-failure");
    },
  });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });
  const retry = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "injected-readback-failure");
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "failed-closed");
  assert.equal(f.store.readGlobalDecisionOutcomes()[0].state, "failed-closed");
  assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
  assert.equal(retry.ok, false);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.outcome, result.outcome);
  assert.equal(retry.reason, result.outcome.reason);
});

test("rollback refuses post-publication ownership drift and recovery preserves the external bytes", async (t) => {
  let f;
  const external = `${PROPOSED}\nExternal owner replacement.\n`;
  f = fixture(t, {
    faultInjection(point) {
      if (point === "global-apply-before-readback") fs.writeFileSync(f.target, external);
    },
  });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });
  const [recovered] = await f.domain.recover();

  assert.equal(result.reason, "hash-drift");
  assert.equal(result.recoveryRequired, true);
  assert.equal(recovered.ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), external);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "failed-closed");
});

test("rollback rechecks inode ownership immediately before replacing same-content bytes", async (t) => {
  let f;
  let externalInode;
  f = fixture(t, {
    faultInjection(point) {
      if (point === "global-apply-before-readback") throw new Error("injected-readback-failure");
      if (point === "global-rollback-before-rename") {
        fs.unlinkSync(f.target);
        fs.writeFileSync(f.target, PROPOSED);
        externalInode = fs.statSync(f.target).ino;
      }
    },
  });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "global-target-ownership-drift");
  assert.equal(result.recoveryRequired, true);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(fs.statSync(f.target).ino, externalInode);
  assert.notEqual(f.store.readGlobalApplyIntents()[0].state, "failed-closed");
});

test("existing-target post-rename proof failure restores the exact prior snapshot", async (t) => {
  const f = fixture(t, {
    faultInjection(point, details) {
      if (point === "global-apply-existing-after-temp-proof") {
        fs.appendFileSync(details.temporary, "\npost-proof mutation\n");
      }
    },
  });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "failed-closed");
  assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
});

test("existing-target post-rename ownership drift preserves the external replacement", async (t) => {
  let f;
  let externalInode;
  const external = `${PROPOSED}\nExternal replacement after rename.\n`;
  f = fixture(t, {
    faultInjection(point) {
      if (point !== "global-apply-existing-after-rename") return;
      fs.unlinkSync(f.target);
      fs.writeFileSync(f.target, external);
      externalInode = fs.statSync(f.target).ino;
    },
  });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "global-target-ownership-drift");
  assert.equal(result.recoveryRequired, true);
  assert.equal(fs.readFileSync(f.target, "utf8"), external);
  assert.equal(fs.statSync(f.target).ino, externalInode);
  assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
});

test("a crash after a failed outcome preserves failure truth and repairs only the intent", async (t) => {
  const f = fixture(t);
  await runDecisionChild(f, "failed-readback-after-outcome", { expectSignal: "SIGKILL" });
  const before = f.store.readGlobalDecisionOutcomes()[0];
  assert.equal(before.state, "failed-closed");
  const intentBefore = f.store.readGlobalApplyIntents()[0];
  assert.notEqual(intentBefore.state, "failed-closed");
  f.setClock(NOW + 10 * 60 * 1000);
  const leaseKeyHash = schemas.globalTargetLeaseKey(f.recommendation.targetBinding);
  const acquired = f.store.acquireGlobalLease({ leaseKind: "target-write", leaseKeyHash, ttlMs: 60_000 });
  assert.equal(acquired.ok, true, acquired.reason);
  const contradictory = f.store.completeGlobalDecision({
    intentId: intentBefore.intentId,
    leaseKeyHash,
    ownerToken: acquired.lease.ownerToken,
    nowMs: NOW + 10 * 60 * 1000 + 1,
  });
  assert.deepEqual(f.store.readGlobalApplyIntents()[0], intentBefore);
  f.store.releaseGlobalLease({ leaseKeyHash, ownerToken: acquired.lease.ownerToken, nowMs: NOW + 10 * 60 * 1000 + 2 });
  const [recovered] = await f.domain.recover();
  const retry = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(recovered.ok, false);
  assert.equal(recovered.duplicate, true);
  assert.deepEqual(recovered.outcome, before);
  assert.equal(f.store.readGlobalApplyIntents()[0].state, "failed-closed");
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  assert.equal(retry.ok, false);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.outcome, before);
  assert.equal(contradictory.ok, false);
  assert.equal(contradictory.duplicate, true);
  assert.deepEqual(contradictory.outcome, before);
  assert.equal(f.store.readGlobalApplyIntents()[0].state, "failed-closed");
});

test("legacy v0.3 apply intents without directory proof fields normalize and recover", async (t) => {
  const f = fixture(t);
  await runDecisionChild(f, "global-apply-before-temp-write", { expectSignal: "SIGKILL" });
  const intent = f.store.readGlobalApplyIntents()[0];
  const intentPath = path.join(
    f.root,
    "state",
    "self-evolve",
    "global",
    "apply-intents",
    intent.intentId.slice(0, 2),
    `${intent.intentId}.json`,
  );
  const legacy = JSON.parse(fs.readFileSync(intentPath, "utf8"));
  delete legacy.directoryDevice;
  delete legacy.directoryInode;
  fs.writeFileSync(intentPath, `${JSON.stringify(legacy)}\n`);

  const normalized = f.store.readGlobalApplyIntents()[0];
  assert.equal(normalized.directoryDevice, null);
  assert.equal(normalized.directoryInode, null);
  f.setClock(NOW + 10 * 60 * 1000);

  const [recovered] = await f.domain.recover();
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
});

test("legacy new-skill ownership markers migrate into the intent and are removed", async (t) => {
  const f = fixture(t, { targetKind: "new-global-skill" });
  await runDecisionChild(f, "global-apply-before-publication", { expectSignal: "SIGKILL" });
  const intent = f.store.readGlobalApplyIntents()[0];
  const intentPath = path.join(
    f.root,
    "state",
    "self-evolve",
    "global",
    "apply-intents",
    intent.intentId.slice(0, 2),
    `${intent.intentId}.json`,
  );
  const legacy = JSON.parse(fs.readFileSync(intentPath, "utf8"));
  delete legacy.directoryDevice;
  delete legacy.directoryInode;
  fs.writeFileSync(intentPath, `${JSON.stringify(legacy)}\n`);
  const directoryStat = fs.statSync(path.dirname(f.target));
  const binding = inventory.hashSkillContent(
    `self-evolve-global-new-skill-directory-v1\n${intent.intentId}\n${directoryStat.dev}\n${directoryStat.ino}`,
  );
  const marker = path.join(f.skillRoot, `.self-evolve-owner-${intent.intentId}`);
  fs.writeFileSync(
    marker,
    `self-evolve-global-new-skill-owner-v1\n${intent.intentId}\n${binding}\n`,
    { flag: "wx" },
  );
  f.setClock(NOW + 10 * 60 * 1000);

  const [recovered] = await f.domain.recover();

  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  const migrated = f.store.readGlobalApplyIntents()[0];
  assert.match(migrated.directoryDevice, /^(?:0|[1-9][0-9]*)$/u);
  assert.match(migrated.directoryInode, /^(?:0|[1-9][0-9]*)$/u);
});

test("a contradictory failure cannot rewrite an unfinalized successful outcome", async (t) => {
  const f = fixture(t);
  await runDecisionChild(f, "global-outcome-after-record", { expectSignal: "SIGKILL" });
  const before = f.store.readGlobalDecisionOutcomes()[0];
  const intentBefore = f.store.readGlobalApplyIntents()[0];
  assert.equal(before.state, "succeeded");
  assert.notEqual(intentBefore.state, "completed");
  f.setClock(NOW + 10 * 60 * 1000);
  const leaseKeyHash = schemas.globalTargetLeaseKey(f.recommendation.targetBinding);
  const acquired = f.store.acquireGlobalLease({ leaseKind: "target-write", leaseKeyHash, ttlMs: 60_000 });
  assert.equal(acquired.ok, true, acquired.reason);

  const contradictory = f.store.failGlobalDecision({
    intentId: intentBefore.intentId,
    leaseKeyHash,
    ownerToken: acquired.lease.ownerToken,
    nowMs: NOW + 10 * 60 * 1000 + 1,
    reason: "contradictory-failure",
  });

  assert.equal(contradictory.ok, true);
  assert.equal(contradictory.duplicate, true);
  assert.deepEqual(contradictory.outcome, before);
  assert.deepEqual(f.store.readGlobalApplyIntents()[0], intentBefore);
  f.store.releaseGlobalLease({ leaseKeyHash, ownerToken: acquired.lease.ownerToken, nowMs: NOW + 10 * 60 * 1000 + 2 });
  const [recovered] = await f.domain.recover();
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.outcome, before);
  assert.equal(f.store.readGlobalApplyIntents()[0].state, "completed");
});

test("a quota-bound intent replacement leaves the durable decision state unchanged", async (t) => {
  const f = fixture(t);
  await runDecisionChild(f, "global-apply-before-temp-write", { expectSignal: "SIGKILL" });
  f.setClock(NOW + 10 * 60 * 1000);
  const leaseKeyHash = schemas.globalTargetLeaseKey(f.recommendation.targetBinding);
  const acquired = f.store.acquireGlobalLease({ leaseKind: "target-write", leaseKeyHash, ttlMs: 60_000 });
  assert.equal(acquired.ok, true, acquired.reason);
  const before = f.store.readGlobalApplyIntents()[0];
  assert.equal(before.state, "snapshot-ready");
  const temporaryName = `.${"x".repeat(200)}`;
  const after = schemas.transitionGlobalApplyIntent(before, { state: "temp-written", temporaryName }, NOW + 10 * 60 * 1000 + 1);
  const intentPath = path.join(f.root, "state", "self-evolve", "global", "apply-intents", before.intentId.slice(0, 2), `${before.intentId}.json`);
  const growth = Buffer.byteLength(`${JSON.stringify(after)}\n`) - fs.lstatSync(intentPath).size;
  assert.ok(growth > 1);
  const globalDir = path.join(f.root, "state", "self-evolve", "global");
  const quotaBytes = regularTreeBytes(globalDir) + growth - 1;
  f.store.close();
  const constrained = openStore(path.join(f.root, "state"), {
    projectFingerprint: PROJECT,
    now: () => NOW + 10 * 60 * 1000 + 1,
    staleLockMs: 1,
    globalQuotaBytes: quotaBytes,
  });
  t.after(() => constrained.close());

  const result = constrained.advanceGlobalApplyIntent({
    intentId: before.intentId,
    leaseKeyHash,
    ownerToken: acquired.lease.ownerToken,
    nowMs: NOW + 10 * 60 * 1000 + 1,
    state: "temp-written",
    temporaryName,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "global-storage-quota-exceeded");
  assert.deepEqual(constrained.readGlobalApplyIntents()[0], before);
  assert.equal(regularTreeBytes(globalDir) <= quotaBytes, true);
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
});

test("global decision admission reserves bytes and files for snapshot and terminal records", async (t) => {
  await t.test("byte ceiling before snapshot", async (t) => {
    const f = fixture(t);
    const usage = f.store.getGlobalUsage();
    const constrained = constrainedDomain(t, f, { globalQuotaBytes: usage.bytesUsed + 80 * 1024 });

    const result = await constrained.domain.decide({ action: "apply", decision: f.decision });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "global-storage-quota-exceeded");
    assert.deepEqual(constrained.store.readGlobalApplyIntents(), []);
    assert.deepEqual(constrained.store.readGlobalDecisions(), []);
    assert.deepEqual(constrained.store.readGlobalSkillSnapshots(), []);
    assert.deepEqual(constrained.store.readGlobalDecisionOutcomes(), []);
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });

  await t.test("file ceiling before terminalization", async (t) => {
    const f = fixture(t);
    const usage = f.store.getGlobalUsage();
    const constrained = constrainedDomain(t, f, { globalQuotaFiles: usage.filesUsed + 3 });

    const result = await constrained.domain.decide({ action: "apply", decision: f.decision });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "global-file-quota-exceeded");
    assert.deepEqual(constrained.store.readGlobalApplyIntents(), []);
    assert.deepEqual(constrained.store.readGlobalDecisions(), []);
    assert.deepEqual(constrained.store.readGlobalSkillSnapshots(), []);
    assert.deepEqual(constrained.store.readGlobalDecisionOutcomes(), []);
    assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  });
});

test("global settings and global bridge bytes cannot consume a nonterminal decision reservation", async (t) => {
  const f = fixture(t);
  await runDecisionChild(f, "global-apply-before-temp-write", { expectSignal: "SIGKILL" });
  const globalBridgeDir = path.join(f.root, "state", "self-evolve", "bridge", "global");
  fs.mkdirSync(globalBridgeDir, { recursive: true });
  fs.writeFileSync(path.join(globalBridgeDir, "reservation-pressure.json"), "b".repeat(8 * 1024));
  const usage = f.store.getGlobalUsage();
  assert.equal(usage.bytesUsed, regularTreeBytes(path.join(f.root, "state", "self-evolve", "global"))
    + regularTreeBytes(globalBridgeDir));
  const constrained = constrainedDomain(t, f, {
    globalQuotaBytes: usage.bytesUsed + 300 * 1024,
  }, { clockStart: NOW + 10 * 60 * 1000 });
  const priorSettings = constrained.store.getSettings().global;
  const roots = Array.from({ length: 32 }, (_, index) => `/${String(index).padStart(2, "0")}-${"x".repeat(900)}`);

  const changed = constrained.store.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    allowedSkillRoots: roots,
    updatedAt: global.updatedAt + 1,
  }));

  assert.equal(changed.ok, false);
  assert.equal(changed.reason, "global-storage-quota-exceeded");
  assert.deepEqual(constrained.store.getSettings().global, priorSettings);
  assert.equal(fs.existsSync(path.join(f.root, "state", "self-evolve", "settings-transaction.json")), false);

  const [recovered] = await constrained.domain.recover();
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(constrained.store.readGlobalApplyIntents()[0].state, "completed");
});

test("Undo refuses external hash drift and preserves the external bytes", async (t) => {
  const f = fixture(t);
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  const applied = f.store.readGlobalRecommendations()[0];
  const undoDecision = schemas.makeGlobalDecision({
    recommendationId: applied.recommendationId,
    supportSetHash: applied.supportSetHash,
    targetBindingHash: applied.targetBinding.bindingHash,
    targetHash: applied.proposedContentHash,
    proposedContentHash: applied.proposedContentHash,
    decisionVersion: applied.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce: "explicit-drifted-undo",
    priorState: "applied",
    newState: "undo-approved",
  });
  fs.writeFileSync(f.target, `${PROPOSED}\nExternal owner edit.\n`);

  const result = await f.domain.decide({ action: "undo", decision: undoDecision });

  assert.equal(result.ok, false);
  assert.match(result.reason, /catalog-stale|undo-target-stale/u);
  assert.match(fs.readFileSync(f.target, "utf8"), /External owner edit/u);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "applied");
});

test("the final prepublication guard preserves an external target replacement", async (t) => {
  let f;
  const external = `${CURRENT}\nExternal prepublication owner.\n`;
  f = fixture(t, {
    faultInjection(point) {
      if (point === "global-apply-before-publication") fs.writeFileSync(f.target, external);
    },
  });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), external);
  assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
});

test("the final prepublication guard rejects path, authority, suppressor, and lease drift", async (t) => {
  const cases = [
    ["symlink substitution", (f) => {
      const outside = path.join(f.root, "prepublication-outside");
      fs.writeFileSync(outside, CURRENT);
      fs.unlinkSync(f.target);
      fs.symlinkSync(outside, f.target);
      return () => assert.equal(fs.readFileSync(outside, "utf8"), CURRENT);
    }],
    ["consent revocation", (f) => {
      transitionPermission(f, "crossRepoAggregation", false, "guard-revoke-consent");
    }],
    ["kill switch", (f) => {
      transitionEmergencyStop(f, true, "guard-enable-emergency-stop");
    }],
    ["circuit breaker", (f) => { f.setSuppressors({ circuitBreakerOpen: true }); }],
    ["emergency stop", (f) => { f.setSuppressors({ emergencyStop: true }); }],
    ["lease replacement", (f) => {
      f.setClock(NOW + 10 * 60 * 1000);
      const leaseKeyHash = schemas.globalTargetLeaseKey(f.recommendation.targetBinding);
      const acquired = f.store.acquireGlobalLease({ leaseKind: "target-write", leaseKeyHash, ttlMs: 60_000 });
      assert.equal(acquired.ok, true, acquired.reason);
    }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      let f;
      let verify = () => {};
      f = fixture(t, {
        faultInjection(point) {
          if (point === "global-apply-before-publication") verify = mutate(f) ?? verify;
        },
      });
      const result = await f.domain.decide({ action: "apply", decision: f.decision });
      assert.equal(result.ok, false);
      verify();
      if (label !== "symlink substitution") assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
      assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
    });
  }
});

test("consent revocation after prepublication proof rolls back and leaves no stale Apply authority", async (t) => {
  let f;
  f = fixture(t, {
    faultInjection(point) {
      if (point !== "global-apply-after-temp-reproof") return;
      transitionPermission(f, "crossRepoAggregation", false, "after-reproof-revoke-consent");
    },
  });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(result.ok, false);
  assert.match(result.reason, /consent|authority/u);
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
  assert.notEqual(f.store.readGlobalRecommendations()[0].state, "applied");
});

test("revoked consent keeps a recommendation visible exportable and rejectable but not applicable", async (t) => {
  const f = fixture(t);
  transitionPermission(f, "crossRepoAggregation", false, "visible-revoke-consent");
  const pending = f.store.readGlobalRecommendations()[0];
  assert.equal(pending.state, "pending");
  const denied = await f.domain.decide({ action: "apply", decision: f.decision });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "global-apply-consent-required");
  const privacy = createPrivacyGuard({
    projectFingerprint: PROJECT,
    store: f.store,
    now: () => NOW + 1,
  });
  const archive = privacy.exportAll();
  assert.equal(archive.global.recommendations.some((item) => item.recommendationId === f.recommendation.recommendationId), true);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "pending");
  const rejected = f.store.rejectGlobalRecommendation({
    decision: schemas.makeGlobalDecision({
      recommendationId: pending.recommendationId,
      supportSetHash: pending.supportSetHash,
      targetBindingHash: pending.targetBinding.bindingHash,
      targetHash: pending.targetBinding.currentHash,
      proposedContentHash: pending.proposedContentHash,
      decisionVersion: pending.decisionVersion + 1,
      actorRole: "operator",
      timestamp: NOW + 1,
      nonce: "reject-revoked-superseded",
      priorState: "pending",
      newState: "rejected",
    }),
    nowMs: NOW + 1,
  });
  assert.equal(rejected.ok, true, rejected.reason);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "rejected");
});

test("consent revocation preserves explicit Undo authority for an applied rollback chain", async (t) => {
  const f = fixture(t);
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  const applied = f.store.readGlobalRecommendations()[0];
  transitionPermission(f, "crossRepoAggregation", false, "undo-revoke-consent");
  assert.equal(f.store.readGlobalRecommendations()[0].state, "applied");
  const undo = schemas.makeGlobalDecision({
    recommendationId: applied.recommendationId,
    supportSetHash: applied.supportSetHash,
    targetBindingHash: applied.targetBinding.bindingHash,
    targetHash: applied.proposedContentHash,
    proposedContentHash: applied.proposedContentHash,
    decisionVersion: applied.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW + 1,
    nonce: "undo-after-consent-revocation",
    priorState: "applied",
    newState: "undo-approved",
  });
  const result = await f.domain.decide({ action: "undo", decision: undo });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "rolled-back");
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
});

test("same-process Apply is denied after every interrupted project-purge invalidation boundary", async (t) => {
  for (const faultPoint of [
    "global-lifecycle-after-decision",
    "global-lifecycle-after-recommendation",
    "global-lifecycle-after-candidate",
    "global-lifecycle-after-audit",
  ]) {
    await t.test(faultPoint, async (t) => {
      let armed = true;
      const f = fixture(t, {
        faultInjection(point) {
          if (armed && point === faultPoint) {
            armed = false;
            throw new Error(`fixture-fault:${point}`);
          }
        },
      });
      assert.equal(f.store.purge({ scope: "project" }).ok, false);
      const result = await f.domain.decide({ action: "apply", decision: f.decision });
      assert.equal(result.ok, false);
      assert.match(result.reason, /support|stale/u);
      assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
      assert.deepEqual(f.store.readGlobalApplyIntents(), []);
      assert.deepEqual(f.store.readGlobalDecisionOutcomes(), []);
      assert.equal(f.store.readGlobalDecisions().some((decision) => decision.actorRole === "operator"), false);
    });
  }
});

test("the final Undo guard refuses a same-content external inode replacement", async (t) => {
  let armed = false;
  let f;
  f = fixture(t, {
    faultInjection(point) {
      if (!armed || point !== "global-apply-before-publication") return;
      fs.unlinkSync(f.target);
      fs.writeFileSync(f.target, PROPOSED);
    },
  });
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  const applied = f.store.readGlobalRecommendations()[0];
  const undoDecision = schemas.makeGlobalDecision({
    recommendationId: applied.recommendationId,
    supportSetHash: applied.supportSetHash,
    targetBindingHash: applied.targetBinding.bindingHash,
    targetHash: applied.proposedContentHash,
    proposedContentHash: applied.proposedContentHash,
    decisionVersion: applied.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce: "same-content-external-undo",
    priorState: "applied",
    newState: "undo-approved",
  });
  armed = true;

  const result = await f.domain.decide({ action: "undo", decision: undoDecision });

  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "undo"), false);
});

test("temp replacement after descriptor reproof preserves external bytes and never publishes them", async (t) => {
  for (const targetKind of ["existing-global-skill", "new-global-skill"]) {
    await t.test(targetKind, async (t) => {
      const f = fixture(t, { targetKind });
      const result = await runDecisionChild(f, "replace-temp-after-reproof");
      const intent = f.store.readGlobalApplyIntents()[0];
      const temporary = path.join(path.dirname(f.target), `.${path.basename(f.target)}.self-evolve-tmp-${intent.intentId}`);

      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(f.target), targetKind === "existing-global-skill");
      if (targetKind === "existing-global-skill") assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
      assert.equal(fs.readFileSync(temporary, "utf8"), "external temp replacement\n");
      assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
    });
  }
});

test("fresh new-skill Apply rejects an external empty directory created after catalog resolution", async (t) => {
  let f;
  f = fixture(t, {
    targetKind: "new-global-skill",
    faultInjection(point) {
      if (point === "global-apply-before-new-directory-create") fs.mkdirSync(path.dirname(f.target));
    },
  });

  const result = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "new-global-skill-path-collision");
  assert.equal(fs.existsSync(path.dirname(f.target)), true);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), []);
  assert.deepEqual(fs.readdirSync(f.skillRoot).filter((name) => name.startsWith(".self-evolve-owner-")), []);
  assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
});

test("process crashes across the global Apply journal recover to one verified outcome", async (t) => {
  const points = [
    "global-decision-before-intent",
    "global-decision-after-intent",
    "global-decision-before-cas",
    "global-decision-after-cas",
    "global-decision-after-record",
    "global-decision-after-commit",
    "global-apply-before-snapshot",
    "global-apply-after-snapshot",
    "global-apply-before-temp-write",
    "global-apply-after-temp-write",
    "global-apply-after-temp-written",
    "global-apply-before-publication",
    "global-apply-after-publication",
    "global-apply-after-published",
    "global-apply-before-readback",
    "global-apply-after-readback-verified",
    "global-outcome-before-recommendation-cas",
    "global-outcome-after-recommendation-cas",
    "global-outcome-after-decision",
    "global-outcome-after-audit",
    "global-outcome-after-record",
    "global-outcome-after-intent",
  ];
  for (const point of points) {
    await t.test(point, async (t) => {
      const f = fixture(t);
      await runDecisionChild(f, point, { expectSignal: "SIGKILL" });
      f.setClock(NOW + 10 * 60 * 1000);

      const recovered = await f.domain.recover();
      if (recovered.length === 0) recovered.push(await f.domain.decide({ action: "apply", decision: f.decision }));

      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].ok, true, `${point}: ${recovered[0].reason}`);
      assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
      assert.equal(f.store.readGlobalRecommendations()[0].state, "applied");
      assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
      assert.deepEqual(fs.readdirSync(f.skillRoot).filter((name) => name.startsWith(".self-evolve-owner-")), []);
      assert.equal(f.store.readGlobalAudits().filter((audit) => audit.kind === "apply").length, 1);
      assert.equal(f.store.readGlobalApplyIntents()[0].state, "completed");
      assert.deepEqual(fs.readdirSync(path.dirname(f.target)).filter((name) => name.includes("self-evolve-tmp")), []);
    });
  }
});

test("new-skill Apply and existing/new Undo recover exact post-publication process crashes", async (t) => {
  for (const point of [
    "global-apply-before-temp-write",
    "global-apply-after-temp-write",
    "global-apply-after-temp-written",
    "global-apply-before-publication",
    "global-apply-after-publication",
    "global-apply-after-temp-unlink",
    "global-outcome-after-record",
  ]) {
    await t.test(`new Apply ${point}`, async (t) => {
      const f = fixture(t, { targetKind: "new-global-skill" });
      await runDecisionChild(f, point, { expectSignal: "SIGKILL" });
      f.setClock(NOW + 10 * 60 * 1000);
      const [recovered] = await f.domain.recover();
      assert.equal(recovered.ok, true, recovered.reason);
      assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
      assert.equal(f.store.readGlobalApplyIntents()[0].state, "completed");
      assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
      assert.deepEqual(fs.readdirSync(f.skillRoot).filter((name) => name.startsWith(".self-evolve-owner-")), []);
    });
  }
  for (const targetKind of ["existing-global-skill", "new-global-skill"]) {
    for (const point of ["global-apply-after-publication", "global-outcome-after-record", "global-undo-after-directory-cleanup"]) {
      if (point === "global-undo-after-directory-cleanup" && targetKind !== "new-global-skill") continue;
      await t.test(`${targetKind} Undo ${point}`, async (t) => {
        const f = fixture(t, { targetKind });
        assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
        const applied = f.store.readGlobalRecommendations()[0];
        const undoDecision = schemas.makeGlobalDecision({
          recommendationId: applied.recommendationId,
          supportSetHash: applied.supportSetHash,
          targetBindingHash: applied.targetBinding.bindingHash,
          targetHash: applied.proposedContentHash,
          proposedContentHash: applied.proposedContentHash,
          decisionVersion: applied.decisionVersion + 1,
          actorRole: "operator",
          timestamp: NOW,
          nonce: `process-${targetKind}-${point}`,
          priorState: "applied",
          newState: "undo-approved",
        });
        await runDecisionChild(f, point, { action: "undo", decision: undoDecision, expectSignal: "SIGKILL" });
        f.setClock(NOW + 20 * 60 * 1000);
        const [recovered] = await f.domain.recover();
        assert.equal(recovered.ok, true, recovered.reason);
        assert.equal(fs.existsSync(f.target), targetKind === "existing-global-skill");
        if (targetKind === "existing-global-skill") assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
        assert.equal(f.store.readGlobalRecommendations()[0].state, "rolled-back");
        assert.equal(f.store.readGlobalDecisionOutcomes().length, 2);
        assert.equal(f.store.readGlobalApplyIntents().every((intent) => intent.state === "completed"), true);
      });
    }
  }
});

test("new-skill Undo never removes an externally replaced empty directory", async (t) => {
  let armed = false;
  let f;
  let replacedDirectory;
  f = fixture(t, {
    targetKind: "new-global-skill",
    faultInjection(point) {
      if (!armed || point !== "global-undo-before-directory-cleanup") return;
      replacedDirectory = `${path.dirname(f.target)}-plugin-owned`;
      fs.renameSync(path.dirname(f.target), replacedDirectory);
      fs.mkdirSync(path.dirname(f.target));
    },
  });
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  const applied = f.store.readGlobalRecommendations()[0];
  const undoDecision = schemas.makeGlobalDecision({
    recommendationId: applied.recommendationId,
    supportSetHash: applied.supportSetHash,
    targetBindingHash: applied.targetBinding.bindingHash,
    targetHash: applied.proposedContentHash,
    proposedContentHash: applied.proposedContentHash,
    decisionVersion: applied.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce: "external-empty-directory-undo",
    priorState: "applied",
    newState: "undo-approved",
  });
  armed = true;

  const result = await f.domain.decide({ action: "undo", decision: undoDecision });

  assert.equal(result.ok, true, result.reason);
  assert.equal(fs.existsSync(path.dirname(f.target)), true);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), []);
  assert.equal(fs.existsSync(replacedDirectory), true);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "rolled-back");
});

test("new-skill recovery preserves unowned prepared-path entries and same-content external targets", async (t) => {
  await t.test("same-content different inode", async (t) => {
    const f = fixture(t, { targetKind: "new-global-skill" });
    await runDecisionChild(f, "global-apply-before-publication", { expectSignal: "SIGKILL" });
    const [intent] = f.store.readGlobalApplyIntents();
    const temporary = path.join(path.dirname(f.target), intent.temporaryName);
    fs.writeFileSync(f.target, PROPOSED, { flag: "wx" });
    assert.notEqual(fs.statSync(f.target).ino, fs.statSync(temporary).ino);
    f.setClock(NOW + 10 * 60 * 1000);

    const [recovered] = await f.domain.recover();

    assert.equal(recovered.ok, false);
    assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
    assert.equal(f.store.readGlobalRecommendations()[0].state, "failed-closed");
    assert.equal(f.store.readGlobalAudits().some((audit) => audit.kind === "apply"), false);
  });
  await t.test("unknown directory entry", async (t) => {
    const f = fixture(t, { targetKind: "new-global-skill" });
    await runDecisionChild(f, "global-apply-before-temp-write", { expectSignal: "SIGKILL" });
    const unknown = path.join(path.dirname(f.target), "external.txt");
    fs.writeFileSync(unknown, "external owner");
    f.setClock(NOW + 10 * 60 * 1000);

    const [recovered] = await f.domain.recover();

    assert.equal(recovered.ok, false);
    assert.equal(fs.readFileSync(unknown, "utf8"), "external owner");
    assert.equal(fs.existsSync(f.target), false);
  });
});

test("two processes with the same decision identity preserve target lease busy semantics", async (t) => {
  const f = fixture(t);
  const readyPath = path.join(f.root, "held.ready");
  const releasePath = path.join(f.root, "held.release");
  const first = runDecisionChild(f, "hold-before-temp", {
    readyPath,
    releasePath,
    project: inventory.hashSkillContent("target-contender-one"),
  });
  await waitForFile(readyPath);
  let second;
  try {
    second = await runDecisionChild(f, "none", {
      decision: f.decision,
      project: inventory.hashSkillContent("target-contender-two"),
    });
  } finally {
    fs.writeFileSync(releasePath, "release");
  }
  const winner = await first;

  assert.equal(winner.ok, true, winner.reason);
  assert.deepEqual(second, {
    ok: false,
    reason: "global-lease-busy",
    deferred: true,
  });
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
});

test("the decision lease seam replaces an expired target lease before Apply", async (t) => {
  const f = fixture(t);
  const leaseKeyHash = schemas.globalTargetLeaseKey(f.recommendation.targetBinding);
  const expired = f.store.acquireGlobalLease({ leaseKind: "target-write", leaseKeyHash, ttlMs: 1 });
  assert.equal(expired.ok, true, expired.reason);
  f.setClock(NOW + 2);

  const applied = await f.domain.decide({ action: "apply", decision: f.decision });

  assert.equal(applied.ok, true, applied.reason);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  const released = f.store.getGlobalLease(leaseKeyHash);
  assert.equal(released.state, "released");
  assert.notEqual(released.leaseId, expired.lease.leaseId);
});

test("global decision journals remain identity-free and actor-role bounded", async (t) => {
  const f = fixture(t);
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  const records = [
    ...f.store.readGlobalDecisions(),
    ...f.store.readGlobalApplyIntents(),
    ...f.store.readGlobalSkillSnapshots(),
    ...f.store.readGlobalDecisionOutcomes(),
    ...f.store.readGlobalAudits(),
  ];
  const forbidden = [PROJECT, inventory.hashSkillContent(PROJECT), "private-domain-fixture"];

  assert.equal(records.length >= 6, true);
  for (const record of records) assert.equal(schemas.assertGlobalIdentitySafe(record, { forbiddenIdentityValues: forbidden }), true);
  assert.deepEqual(new Set(f.store.readGlobalDecisions().map((decision) => decision.actorRole)), new Set(["operator", "applier"]));
  const exported = f.store.exportAll().global;
  assert.equal(exported.applyIntents.length, 1);
  assert.equal(exported.skillSnapshots[0].classification, "sensitive-skill-snapshot");
  assert.equal(exported.recommendationContent[0].classification, "sensitive-skill-content");
  const globalDecisionTree = path.join(f.root, "state", "self-evolve", "global");
  const serialized = fs.readdirSync(globalDecisionTree, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
  for (const value of forbidden) assert.equal(serialized.includes(value), false);
});

test("snapshot bytes and failure reasons cannot carry local identity canaries into global records", async (t) => {
  await t.test("decoded prior target content", async (t) => {
    const canary = "private-worktree-snapshot-canary-47f1";
    const f = fixture(t, {
      currentContent: `${CURRENT}\n${canary}\n`,
      forbiddenIdentityValues: [canary],
    });

    const result = await f.domain.decide({ action: "apply", decision: f.decision });

    assert.equal(result.ok, false);
    assert.equal(f.store.readGlobalSkillSnapshots().length, 0);
    assert.equal(f.store.readGlobalDecisionOutcomes()[0].reason, "global-decision-failed");
  });

  await t.test("thrown error text", async (t) => {
    const canary = "private-session-error-canary-91c2";
    const f = fixture(t, {
      forbiddenIdentityValues: [canary],
      faultInjection(point) {
        if (point === "global-apply-before-temp-write") throw new Error(canary);
      },
    });

    const result = await f.domain.decide({ action: "apply", decision: f.decision });
    const outcome = f.store.readGlobalDecisionOutcomes()[0];
    const globalTree = path.join(f.root, "state", "self-evolve", "global");
    const serialized = fs.readdirSync(globalTree, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
      .join("\n");

    assert.equal(result.reason, canary);
    assert.equal(outcome.reason, "global-decision-failed");
    assert.equal(serialized.includes(canary), false);
  });
});

test("persisted outcomes cannot be replayed through an action that mismatches the decision edge", async (t) => {
  await t.test("succeeded Apply as Undo", async (t) => {
    const f = fixture(t);
    assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
    const replay = await f.domain.decide({ action: "undo", decision: f.decision });
    assert.deepEqual(replay, { ok: false, reason: "global-action-decision-mismatch" });
  });

  await t.test("failed Apply as Undo", async (t) => {
    const f = fixture(t, {
      faultInjection(point) {
        if (point === "global-apply-before-readback") throw new Error("forced-apply-failure");
      },
    });
    assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, false);
    const replay = await f.domain.decide({ action: "undo", decision: f.decision });
    assert.deepEqual(replay, { ok: false, reason: "global-action-decision-mismatch" });
  });

  for (const outcome of ["succeeded", "failed"]) {
    await t.test(`${outcome} Undo as Apply`, async (t) => {
      let armed = false;
      const f = fixture(t, {
        faultInjection(point) {
          if (armed && point === "global-apply-before-readback") throw new Error("forced-undo-failure");
        },
      });
      assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
      const applied = f.store.readGlobalRecommendations()[0];
      const undoDecision = schemas.makeGlobalDecision({
        recommendationId: applied.recommendationId,
        supportSetHash: applied.supportSetHash,
        targetBindingHash: applied.targetBinding.bindingHash,
        targetHash: applied.proposedContentHash,
        proposedContentHash: applied.proposedContentHash,
        decisionVersion: applied.decisionVersion + 1,
        actorRole: "operator",
        timestamp: NOW,
        nonce: `${outcome}-undo-action-retry`,
        priorState: "applied",
        newState: "undo-approved",
      });
      armed = outcome === "failed";
      assert.equal((await f.domain.decide({ action: "undo", decision: undoDecision })).ok, outcome === "succeeded");
      const replay = await f.domain.decide({ action: "apply", decision: undoDecision });
      assert.deepEqual(replay, { ok: false, reason: "global-action-decision-mismatch" });
    });
  }
});

test("a process killed after readback converges to one completed Apply without a second audit", async (t) => {
  const f = fixture(t);

  await runDecisionChild(f, "global-apply-after-readback", { expectSignal: "SIGKILL" });
  f.setClock(NOW + 10 * 60 * 1000);
  const recovered = await f.domain.recover();
  if (recovered.length === 0) recovered.push(await f.domain.decide({ action: "apply", decision: f.decision }));

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].ok, true, recovered[0].reason);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(f.store.readGlobalRecommendations()[0].state, "applied");
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
  assert.equal(f.store.readGlobalAudits().filter((audit) => audit.kind === "apply").length, 1);
  assert.equal(f.store.readGlobalApplyIntents()[0].state, "completed");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)).filter((name) => name.includes("self-evolve-tmp")), []);
});

test("a process killed inside every publication rollback converges to one terminal decision", async (t) => {
  const cases = [
    {
      label: "new-skill Apply rollback unlink",
      targetKind: "new-global-skill",
      action: "apply",
      // The rollback unlink is only reachable once the plugin-owned hard link is
      // gone, so the failure is injected after the temporary unlink.
      point: "throw:global-apply-after-temp-unlink+kill:global-rollback-before-unlink",
    },
    {
      label: "existing Undo rollback rename",
      targetKind: "existing-global-skill",
      action: "undo",
      point: "throw:global-apply-after-publication+kill:global-undo-rollback-before-rename",
    },
    {
      label: "new-skill Undo rollback link",
      targetKind: "new-global-skill",
      action: "undo",
      point: "throw:global-apply-after-publication+kill:global-undo-rollback-before-link",
    },
  ];
  for (const { label, targetKind, action, point } of cases) {
    await t.test(label, async (t) => {
      const f = fixture(t, { targetKind });
      let decision = f.decision;
      if (action === "undo") {
        assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
        const applied = f.store.readGlobalRecommendations()[0];
        decision = schemas.makeGlobalDecision({
          recommendationId: applied.recommendationId,
          supportSetHash: applied.supportSetHash,
          targetBindingHash: applied.targetBinding.bindingHash,
          targetHash: applied.proposedContentHash,
          proposedContentHash: applied.proposedContentHash,
          decisionVersion: applied.decisionVersion + 1,
          actorRole: "operator",
          timestamp: NOW,
          nonce: `rollback-boundary-${targetKind}`,
          priorState: "applied",
          newState: "undo-approved",
        });
      }

      await runDecisionChild(f, point, { action, decision, expectSignal: "SIGKILL" });
      f.setClock(NOW + 20 * 60 * 1000);
      const first = await f.domain.recover();
      f.setClock(NOW + 30 * 60 * 1000);
      const second = await f.domain.recover();

      assert.deepEqual(second, [], `${label}: recovery is not idempotent`);
      const intents = f.store.readGlobalApplyIntents();
      assert.equal(intents.every((intent) => ["completed", "failed-closed"].includes(intent.state)), true);
      const outcomes = f.store.readGlobalDecisionOutcomes();
      assert.equal(outcomes.length, action === "undo" ? 2 : 1);
      assert.equal(new Set(outcomes.map((outcome) => outcome.intentId)).size, outcomes.length);
      const state = f.store.readGlobalRecommendations()[0].state;
      const targetExists = fs.existsSync(f.target);
      const content = targetExists ? fs.readFileSync(f.target, "utf8") : null;
      if (action === "apply") {
        assert.equal(["failed-closed", "applied"].includes(state), true, `${label}: ${state}`);
        assert.equal(content, state === "applied" ? PROPOSED : null);
      } else {
        assert.equal(["rolled-back", "applied", "failed-closed"].includes(state), true, `${label}: ${state}`);
        if (state === "applied") assert.equal(content, PROPOSED);
        if (state === "rolled-back") assert.equal(content, targetKind === "new-global-skill" ? null : CURRENT);
      }
      assert.deepEqual(fs.readdirSync(f.skillRoot).filter((name) => name.startsWith(".self-evolve-owner-")), []);
      if (fs.existsSync(path.dirname(f.target))) {
        assert.deepEqual(
          fs.readdirSync(path.dirname(f.target)).filter((name) => name.includes("self-evolve-tmp")),
          [],
          `${label}: leftover temporary`,
        );
      }
      assert.equal(first.length <= 1, true);
    });
  }
});

// H9-001: power-loss durability across the FULL decision journal. Each test
// simulates SIGKILL after one `journal-*` stage is namespace-durable and proves
// the two acceptance invariants: (1) no surviving target mutation lacks the
// intent/snapshot/audit/rollback evidence required for recovery or Undo, and
// (2) no durable journal overstates effects (a succeeded outcome implies the
// target effect is durable; no outcome implies the recommendation is not
// "applied"). The `journal-*` points fire immediately after each stage's
// durable namespace commit (file fsync + parent-directory fsync), modeling the
// strongest possible "loss after this stage" boundary.
test("H9-001: loss after each journal/effect stage converges to one verified existing-skill Apply outcome", async (t) => {
  const points = [
    "journal-after-intent",
    "journal-after-recommendation-cas",
    "journal-after-decision-record",
    "journal-after-intent-commit",
    "journal-after-snapshot",
    "journal-after-snapshot-intent",
    "journal-after-intent-transition",
    "journal-after-target-publication",
    "journal-after-publication-commit",
    "journal-after-outcome-recommendation-cas",
    "journal-after-outcome-decision",
    "journal-after-outcome-audit",
    "journal-after-outcome-record",
    "journal-after-outcome-intent",
  ];
  for (const point of points) {
    await t.test(point, async (t) => {
      const f = fixture(t);
      await runDecisionChild(f, point, { expectSignal: "SIGKILL" });
      f.setClock(NOW + 10 * 60 * 1000);

      const recovered = await f.domain.recover();
      if (recovered.length === 0) recovered.push(await f.domain.decide({ action: "apply", decision: f.decision }));

      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].ok, true, `${point}: ${recovered[0].reason}`);
      // Invariant 2: a succeeded outcome must imply a durable target effect.
      assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED, `${point}: target must reflect the applied effect`);
      assert.equal(f.store.readGlobalRecommendations()[0].state, "applied");
      // Invariant 1: the surviving target carries its full evidence chain.
      assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
      assert.equal(f.store.readGlobalDecisionOutcomes()[0].state, "succeeded");
      assert.equal(f.store.readGlobalSkillSnapshots().length, 1, `${point}: existing-skill snapshot evidence must survive`);
      assert.equal(f.store.readGlobalAudits().filter((audit) => audit.kind === "apply").length, 1);
      assert.equal(f.store.readGlobalApplyIntents()[0].state, "completed");
      assert.deepEqual(fs.readdirSync(path.dirname(f.target)).filter((name) => name.includes("self-evolve-tmp")), []);
    });
  }
});

test("H9-001: loss after each new-skill Apply journal/effect stage converges with evidence", async (t) => {
  // New-skill Apply has no snapshot and adds the temp-unlink boundary; the
  // shared admission and outcome points are covered alongside the new-skill
  // publication/temp-unlink/directory-creation boundaries.
  const points = [
    "journal-after-intent",
    "journal-after-intent-commit",
    "journal-after-intent-transition",
    "journal-after-target-publication",
    "journal-after-temp-unlink",
    "journal-after-publication-commit",
    "journal-after-outcome-record",
    "journal-after-outcome-intent",
  ];
  for (const point of points) {
    await t.test(point, async (t) => {
      const f = fixture(t, { targetKind: "new-global-skill" });
      await runDecisionChild(f, point, { expectSignal: "SIGKILL" });
      f.setClock(NOW + 10 * 60 * 1000);
      const recovered = await f.domain.recover();
      // When the crash landed after the terminal journal stage the decision had
      // already completed in the child; recovery has nothing to resume and the
      // durable journal already carries the succeeded outcome.
      if (recovered.length === 0) recovered.push(await f.domain.decide({ action: "apply", decision: f.decision }));
      assert.equal(recovered[0].ok, true, `${point}: ${recovered[0].reason}`);
      assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
      assert.equal(f.store.readGlobalApplyIntents()[0].state, "completed");
      assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
      assert.equal(f.store.readGlobalDecisionOutcomes()[0].state, "succeeded");
      assert.deepEqual(fs.readdirSync(f.skillRoot).filter((name) => name.startsWith(".self-evolve-owner-")), []);
    });
  }
});

test("H9-001: loss after each Undo journal/effect stage converges without an overclaiming journal", async (t) => {
  for (const targetKind of ["existing-global-skill", "new-global-skill"]) {
    await t.test(`${targetKind} Undo`, async (t) => {
      const f = fixture(t, { targetKind });
      assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
      const applied = f.store.readGlobalRecommendations()[0];
      const undoDecision = schemas.makeGlobalDecision({
        recommendationId: applied.recommendationId,
        supportSetHash: applied.supportSetHash,
        targetBindingHash: applied.targetBinding.bindingHash,
        targetHash: applied.proposedContentHash,
        proposedContentHash: applied.proposedContentHash,
        decisionVersion: applied.decisionVersion + 1,
        actorRole: "operator",
        timestamp: NOW,
        nonce: `h9-undo-${targetKind}`,
        priorState: "applied",
        newState: "undo-approved",
      });
      // `journal-after-target-publication` for Undo is the moment the rolled
      // back bytes (existing) or the target removal (new-skill) is durable.
      await runDecisionChild(f, "journal-after-target-publication", { action: "undo", decision: undoDecision, expectSignal: "SIGKILL" });
      f.setClock(NOW + 20 * 60 * 1000);
      const [recovered] = await f.domain.recover();
      assert.equal(recovered.ok, true, recovered.reason);
      // Invariant 1 + 2 for Undo: a rolled-back recommendation must not leave a
      // surviving applied target, and the outcome must record the rolled-back state.
      assert.equal(f.store.readGlobalRecommendations()[0].state, "rolled-back");
      assert.equal(fs.existsSync(f.target), targetKind === "existing-global-skill");
      if (targetKind === "existing-global-skill") assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
      assert.equal(f.store.readGlobalDecisionOutcomes().length, 2);
      assert.equal(f.store.readGlobalApplyIntents().every((intent) => intent.state === "completed"), true);
    });
  }
});

test("H9-001: loss inside an Apply rollback leaves the durable journal consistent with the durable effect", async (t) => {
  // A publication failure followed by loss inside the rollback reaches the
  // `journal-after-rollback-effect` boundary on the existing-skill rename path:
  // the rolled-back bytes are namespace-durable, so the later failed outcome
  // must not claim a surviving applied effect. (The new-skill rollback unlink
  // boundary is gated by a target-identity assert that is covered by the
  // dedicated rollback-crash suite above.)
  const targetKind = "existing-global-skill";
  await t.test(targetKind, async (t) => {
    const f = fixture(t, { targetKind });
    const point = "throw:global-apply-after-publication+kill:journal-after-rollback-effect";
    await runDecisionChild(f, point, { expectSignal: "SIGKILL" });
    f.setClock(NOW + 20 * 60 * 1000);
    await f.domain.recover();
    f.setClock(NOW + 30 * 60 * 1000);
    assert.deepEqual(await f.domain.recover(), [], "recovery must be idempotent after a durable rollback");
    const outcomes = f.store.readGlobalDecisionOutcomes();
    const finalOutcome = outcomes[outcomes.length - 1];
    assert.equal(finalOutcome.state === "failed-closed" || finalOutcome.state === "succeeded", true);
    // Invariant 2: a failed-closed outcome must not coexist with a surviving
    // applied target; a succeeded outcome must.
    if (finalOutcome.state === "failed-closed") {
      assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
    } else {
      assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
    }
  });
});

test("H9-001: unsupported directory-fsync capability fail-closes Apply/Undo and authoritative writes while preserving reads", async (t) => {
  const f = fixture(t);
  assert.equal((await f.domain.decide({ action: "apply", decision: f.decision })).ok, true);
  f.store.close();

  // Reopen the populated partition on a host whose directory-fsync path throws.
  // The capability probe fails once at open and records the stable reason.
  const unsupported = () => { throw Object.assign(new Error("EINVAL"), { code: "EINVAL" }); };
  let clock = NOW + 1_000;
  const readOnlyStore = openStore(path.join(f.root, "state"), {
    projectFingerprint: PROJECT,
    now: () => ++clock,
    staleLockMs: 1,
    filesystemSyncDirectory: unsupported,
  });
  t.after(() => readOnlyStore.close());
  assert.equal(readOnlyStore.durableCapability.available, false);
  assert.equal(readOnlyStore.durableCapability.reason, "directory-fsync-unavailable");

  // Read-only analysis remains available: settings, recommendations, outcomes,
  // and audits are all readable from the already-durable partition.
  assert.equal(readOnlyStore.getSettings().global.mode, "manual");
  assert.equal(readOnlyStore.readGlobalRecommendations().length, 1);
  assert.equal(readOnlyStore.readGlobalRecommendations()[0].state, "applied");
  assert.equal(readOnlyStore.readGlobalDecisionOutcomes().length, 1);
  assert.equal(readOnlyStore.readGlobalAudits().some((audit) => audit.kind === "apply"), true);

  // Authoritative store writes fail closed with the stable reason.
  const writeResult = readOnlyStore.updateGlobalSettings((settings) => schemas.makeGlobalSettings({
    ...settings,
    updatedAt: settings.updatedAt + 1,
  }));
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.reason, "directory-fsync-unavailable");

  // The applier fail-closes Apply/Undo before any skill filesystem effect, with
  // the same stable reason, so no surviving target mutation can outlive its
  // journal evidence on the unsupported host.
  const readOnlyDomain = createGlobalDecisionDomain({
    store: readOnlyStore,
    inventory,
    now: () => ++clock,
    getSuppressors: () => ({ circuitBreakerOpen: false, emergencyStop: false }),
  });
  const undoDecision = schemas.makeGlobalDecision({
    recommendationId: f.recommendation.recommendationId,
    supportSetHash: f.recommendation.supportSetHash,
    targetBindingHash: f.recommendation.targetBinding.bindingHash,
    targetHash: f.recommendation.proposedContentHash,
    proposedContentHash: f.recommendation.proposedContentHash,
    decisionVersion: f.recommendation.decisionVersion + 1,
    actorRole: "operator",
    timestamp: NOW,
    nonce: "h9-unsupported-undo",
    priorState: "applied",
    newState: "undo-approved",
  });
  const undoResult = await readOnlyDomain.decide({ action: "undo", decision: undoDecision });
  assert.equal(undoResult.ok, false);
  assert.equal(undoResult.reason, "directory-fsync-unavailable");
  // The applied target is untouched: the applier never reached the rename/unlink.
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  // A fresh Apply attempt on the already-completed edge returns the persisted
  // outcome without invoking any write path (read-only fast path).
  const reapplied = await readOnlyDomain.decide({ action: "apply", decision: f.decision });
  assert.equal(reapplied.ok, true);
  assert.equal(reapplied.outcome.state, "succeeded");
});

// H10-001: immutable request/consumer deadlines carried into durable decision
// admission. A request that expired after consumption but before admission
// cannot drive a durable decision; the real deadline is compared without
// clamping. The controlled clock crosses expiry in the window between lease
// acquire (consume) and durable admission (begin decision).
test("an expired request deadline is refused at durable admission without clamping (H10-001)", async (t) => {
  for (const [label, deadlineOpt] of [
    ["request deadline", { requestDeadline: NOW + 5 }],
    ["consumer deadline", { consumerDeadline: NOW + 5 }],
  ]) {
    await t.test(label, async (t) => {
      let armed = false;
      const f = fixture(t, {
        faultInjection(point) {
          // Cross expiry between consume (lease acquire) and durable admission.
          if (point === "global-decision-before-admission") {
            f.setClock(NOW + 60_000);
            armed = true;
          }
        },
      });
      const result = await f.domain.decide({ action: "apply", decision: f.decision, ...deadlineOpt });
      assert.equal(armed, true);
      assert.equal(result.ok, false);
      assert.match(result.reason, /request-expired|consumer-claim-expired/u);
      assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
      assert.equal(f.store.readGlobalApplyIntents().length, 0);
      assert.equal(f.store.readGlobalAudits().some((a) => a.kind === "apply"), false);
      assert.equal(f.store.readGlobalRecommendations()[0].state, "pending");
    });
  }
});

test("valid request and consumer deadlines are admitted and apply once (H10-001 positive)", async (t) => {
  const f = fixture(t);
  const result = await f.domain.decide({
    action: "apply",
    decision: f.decision,
    requestDeadline: NOW + 60 * 60 * 1000,
    consumerDeadline: NOW + 60 * 60 * 1000,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
});

test("a deadline that expires between consume and admission is caught only at admission (H10-001 window)", async (t) => {
  let acquireSeen = false;
  const f = fixture(t, {
    faultInjection(point) {
      if (point === "global-decision-after-intent") acquireSeen = true;
      if (point === "global-decision-before-admission") f.setClock(NOW + 60_000);
    },
  });
  // requestDeadline is valid at the lease-acquire (consume) timestamp but
  // expired by the admission timestamp; only admission refuses.
  const result = await f.domain.decide({
    action: "apply",
    decision: f.decision,
    requestDeadline: NOW + 30_000,
  });
  assert.equal(acquireSeen, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "global-request-expired");
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
});

// H9-002: a target lease that expires after final validation but before
// mutation is renewed/fenced immediately adjacent to the filesystem effect. The
// controlled clock crosses the lease TTL between reproof and the renewal fence,
// proving NO late authority survives to the rename/link/unlink.
test("a target lease expired between final proof and mutation is refused at the fence (H9-002)", async (t) => {
  let reproofSeen = false;
  const f = fixture(t, {
    faultInjection(point) {
      if (point === "global-apply-after-temp-reproof") {
        reproofSeen = true;
        // Advance past the target-write lease TTL (CLAIM_TTL_MS = 5 min).
        f.setClock(NOW + 10 * 60 * 1000);
      }
    },
  });
  const result = await f.domain.decide({ action: "apply", decision: f.decision });
  assert.equal(reproofSeen, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /global-target-lease-invalid/u);
  assert.equal(fs.readFileSync(f.target, "utf8"), CURRENT);
  assert.equal(f.store.readGlobalAudits().some((a) => a.kind === "apply"), false);
  assert.notEqual(f.store.readGlobalRecommendations()[0].state, "applied");
});

// H9-002 two-process: process A acquires the lease and passes final proof, then
// its lease expires. Process B acquires the expired lease and settles. When A
// resumes it must be rejected as a stale owner before any effect; only B mutates.
test("a stale owner cannot mutate after a peer acquires the expired lease (H9-002 two-process)", async (t) => {
  const f = fixture(t);
  const readyPath = path.join(f.root, "A-ready");
  const releasePath = path.join(f.root, "A-release");
  // Process A: acquire lease, reach final reproof, and hold BEFORE the renewal
  // fence and mutation.
  const aChild = runDecisionChild(f, "hold-after-reproof", {
    readyPath,
    releasePath,
  });
  await waitForFile(readyPath);
  // A is holding pre-mutation. Advance the test clock and run B with a clock
  // past A's lease TTL so B may acquire the expired lease and settle.
  f.setClock(NOW + 10 * 60 * 1000);
  const bResult = await runDecisionChild(f, "none", {
    decision: f.decision,
    clockStart: NOW + 10 * 60 * 1000,
  });
  assert.equal(bResult.ok, true, bResult.reason);
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  // Release A. A resumes and must fail closed at the renewal fence (B owns).
  fs.writeFileSync(releasePath, "release");
  const aResult = await aChild;
  assert.equal(aResult.ok, false);
  assert.match(aResult.reason, /lease|target/u);
  // Only B mutated and settled; A produced no second mutation, audit, or outcome.
  assert.equal(fs.readFileSync(f.target, "utf8"), PROPOSED);
  assert.equal(f.store.readGlobalDecisionOutcomes().length, 1);
  assert.equal(f.store.readGlobalDecisionOutcomes()[0].state, "succeeded");
  assert.equal(f.store.readGlobalApplyIntents()[0].state, "completed");
  assert.equal(f.store.readGlobalAudits().filter((a) => a.kind === "apply").length, 1);
});

test("lease renewal rotates the authorizing generation and rejects a non-owner (H9-002 renew contract)", async (t) => {
  const f = fixture(t);
  const leaseKeyHash = schemas.globalTargetLeaseKey(f.recommendation.targetBinding);
  const acquired = f.store.acquireGlobalLease({ leaseKind: "target-write", leaseKeyHash, ttlMs: 60_000 });
  assert.equal(acquired.ok, true, acquired.reason);
  const renewed = f.store.renewGlobalLease({
    leaseKeyHash,
    ownerToken: acquired.lease.ownerToken,
    nowMs: NOW + 1_000,
    ttlMs: 60_000,
  });
  assert.equal(renewed.ok, true, renewed.reason);
  assert.notEqual(renewed.lease.ownerToken, acquired.lease.ownerToken);
  assert.equal(renewed.lease.leaseId, acquired.lease.leaseId);
  assert.equal(renewed.lease.expiresAt, NOW + 1_000 + 60_000);
  // The prior generation (old ownerToken) is no longer authoritative.
  const stale = f.store.renewGlobalLease({
    leaseKeyHash,
    ownerToken: acquired.lease.ownerToken,
    nowMs: NOW + 2_000,
    ttlMs: 60_000,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "global-target-lease-invalid");
  // A non-owner is likewise rejected before any effect.
  const foreign = f.store.renewGlobalLease({
    leaseKeyHash,
    ownerToken: "not-the-owner",
    nowMs: NOW + 3_000,
    ttlMs: 60_000,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "global-target-lease-invalid");
  assert.equal(f.store.releaseGlobalLease({ leaseKeyHash, ownerToken: renewed.lease.ownerToken, nowMs: NOW + 4_000 }).ok, true);
});
