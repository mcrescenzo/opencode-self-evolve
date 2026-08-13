import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveSourceLineage, hashSignature, summarizeGlobalCandidateSupport } from "../self-evolve-observation.js";
import * as schemas from "../self-evolve-schemas.js";
import { openStore } from "../self-evolve-store.js";

const H = (character) => character.repeat(64);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 10);
const SETTINGS_CRASH_CHILD = path.join(import.meta.dirname, "fixtures", "settings-transaction-crash.mjs");
const CANDIDATE_CHILD = path.join(import.meta.dirname, "fixtures", "global-candidate-process.mjs");
const { UNKNOWN_EVIDENCE_DOMAIN_ID, UNKNOWN_ROOT_LINEAGE_HASH } = schemas;

function targetFixture() {
  const root = schemas.makeApprovedGlobalRoot({ canonicalPath: "/global/skills", canUpdate: true, canCreate: false });
  const rootPolicy = schemas.makeGlobalRootPolicy({ roots: [root], creationRootId: null, selectedBy: "operator", updatedAt: 1 });
  const targetBinding = schemas.makeCandidateTargetBinding({
    targetKind: "existing-global-skill",
    rootId: root.rootId,
    logicalName: "durable-review",
    relativePath: "durable-review/SKILL.md",
    currentHash: H("c"),
    catalogGenerationHash: H("d"),
    rootSetHash: rootPolicy.rootSetHash,
  }, rootPolicy);
  return { rootPolicy, targetBinding };
}

function eligibilityFixture({ single = {}, distributed = {}, integrity = {}, target } = {}) {
  const { rootPolicy, targetBinding } = targetFixture();
  const support = schemas.makeGlobalSupportSet({
    candidateId: H("f"),
    targetBinding: target ?? targetBinding,
    contributionIds: ["11111111-1111-4111-8111-111111111111"],
    strongestSingleDomain: {
      lineageClass: "known",
      independentIncidentCount: 2,
      occurrenceCount: 3,
      nonUnknownUserRootLineageCount: 2,
      freshnessRatio: 0.5,
      ...single,
    },
    distributed: {
      independentKnownDomainCount: 1,
      independentIncidentCount: 2,
      unknownLineageCollapsed: false,
      ...distributed,
    },
    integrity: {
      contradictionFree: true,
      injectionFree: true,
      chronologyValid: true,
      correlationValid: true,
      ...integrity,
    },
    firstSeenDay: "2026-08-01",
    lastSeenDay: "2026-08-10",
    evaluatedAt: NOW,
    expiresAt: NOW + 30 * DAY,
  });
  return { support, eligibility: schemas.evaluateGlobalSupportEligibility(support, rootPolicy), rootPolicy, targetBinding };
}

function enableContributionConsent(store) {
  const state = store.getAutomationState();
  assert.equal(state.ok, true, state.reason);
  assert.equal(state.enabled, true);
  assert.equal(Object.values(state.global.consent).every(Boolean), true);
  return state.stamp;
}

function materialize(store, input) {
  const state = store.getAutomationState();
  assert.equal(state.ok, true, state.reason);
  return store.materializeGlobalCandidates({ ...input, automationStamp: state.stamp });
}

function setGlobalRootPolicy(store, rootPolicy) {
  const result = store.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    globalRootPolicy: rootPolicy,
    updatedAt: global.updatedAt + 1,
  }));
  assert.equal(result.ok, true, result.reason);
}

function seedStoredContribution(store, {
  incidentId,
  signatureHash = H("8"),
  targetLogicalName = "durable-review",
  evidenceDomainId,
  occurrenceCount = 1,
  rootLineageHash,
  originKind = "user",
  createdAt = NOW,
  injectionFlagged = false,
  deterministicOutcome = true,
  clusterId = H("9"),
  capsuleId,
}) {
  const automationStamp = enableContributionConsent(store);
  const scopeFingerprint = H("7");
  const observation = schemas.makeObservation({
    id: hashSignature(JSON.stringify({ incidentId, signatureHash, project: store.projectFingerprint })),
    projectFingerprint: store.projectFingerprint,
    receiptIds: [signatureHash],
    structuredFields: {
      receiptType: "repeated-tool-error",
      scopeFingerprint,
      occurrences: occurrenceCount,
      deterministicOutcome,
      targetLogicalName,
    },
    incidentId,
    sessionLineageHash: H("6"),
    rootLineageHash,
    originKind,
    createdAt,
    injectionFlagged,
    redacted: true,
    automationGeneration: automationStamp.generation,
  });
  const cluster = schemas.makeEvidenceCluster({
    id: clusterId,
    receiptType: "repeated-tool-error",
    projectFingerprint: store.projectFingerprint,
    incidentIds: [incidentId],
    scopeFingerprint,
    targetLogicalName,
    occurrencesSum: occurrenceCount,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
  });
  assert.equal(store.appendRecord(schemas.wrapRecord("observation", observation, createdAt), { automationStamp }).ok, true);
  assert.equal(store.appendRecord(schemas.wrapRecord("evidence-cluster", cluster, createdAt), { automationStamp }).ok, true);
  const capsule = schemas.makeEvidenceCapsule({
    capsuleId,
    incidentId,
    receiptType: cluster.receiptType,
    targetLogicalName,
    summary: "Tool lint repeatedly failed with E_CONFIG (2 occurrences).",
    createdAt,
    expiresAt: createdAt + 30 * DAY,
  });
  assert.equal(store.appendEvidenceCapsule(capsule, { automationStamp }).ok, true);
  const published = store.publishContribution({
    claimType: "global-skill-candidate",
    receiptType: cluster.receiptType,
    signatureHash,
    incidentId,
    capsuleId,
    clusterId,
    evidenceDomainId,
    occurrenceCount,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
  }, { automationStamp });
  assert.equal(published.ok, true, published.reason);
  return { observation, cluster, capsule, published };
}

function treeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? treeFiles(filePath) : [filePath];
  }).sort();
}

function seedGlobalRecommendation(root, store, candidate, support, targetBinding, rootPolicy, {
  state = "pending",
  synthesizedAt = NOW,
} = {}) {
  const target = schemas.makeRecommendationTargetBinding({
    targetKind: targetBinding.targetKind,
    rootId: targetBinding.rootId,
    logicalName: targetBinding.logicalName,
    relativePath: targetBinding.relativePath,
    currentHash: targetBinding.currentHash,
    catalogGenerationHash: targetBinding.catalogGenerationHash,
    rootSetHash: targetBinding.rootSetHash,
    candidateBindingHash: targetBinding.bindingHash,
  }, targetBinding, rootPolicy);
  const proposed = "---\nname: durable-review\ndescription: Handle repeated failures safely.\n---\n\n# Durable Review\n\nVerify the failure before retrying.\n";
  const recommendation = schemas.makeGlobalRecommendation({
    candidateId: candidate.candidateId,
    supportSetHash: support.supportSetHash,
    candidateTargetBindingHash: targetBinding.bindingHash,
    targetBinding: target,
    proposedContentHash: hashSignature(proposed),
    rationaleText: "Independent support warrants one bounded correction.",
    synthesizedAt,
    synthesizerModelId: "mock/model",
    criticScore: 0.99,
    criticPassed: true,
    validDeterministic: true,
    state,
    decisionVersion: state === "pending" ? 0 : 1,
    burnedNonceHashes: state === "pending" ? [] : [hashSignature(`seed-${state}`)],
  });
  const chunk = schemas.makeGlobalRecommendationContent({
    recommendationId: recommendation.recommendationId,
    contentHash: recommendation.proposedContentHash,
    contentEncoding: "base64",
    chunkIndex: 0,
    chunkCount: 1,
    content: Buffer.from(proposed).toString("base64"),
  });
  const global = path.join(root, "self-evolve", "global");
  const recommendationPath = path.join(global, "recommendations", recommendation.recommendationId.slice(0, 2), `${recommendation.recommendationId}.json`);
  const contentPath = path.join(global, "recommendation-content", recommendation.recommendationId.slice(0, 2), recommendation.recommendationId, "000000.json");
  fs.mkdirSync(path.dirname(recommendationPath), { recursive: true });
  fs.mkdirSync(path.dirname(contentPath), { recursive: true });
  fs.writeFileSync(recommendationPath, `${JSON.stringify(recommendation)}\n`);
  fs.writeFileSync(contentPath, `${JSON.stringify(chunk)}\n`);
  assert.equal(store.transitionGlobalCandidate(candidate.candidateId, {
    state: "synthesis-pending",
    supportSetHash: candidate.supportSetHash,
    eligibilityRoute: candidate.eligibilityRoute,
  }, synthesizedAt).ok, true);
  assert.equal(store.transitionGlobalCandidate(candidate.candidateId, {
    state: "recommended",
    supportSetHash: candidate.supportSetHash,
    eligibilityRoute: candidate.eligibilityRoute,
  }, synthesizedAt).ok, true);
  return recommendation;
}

function globalRecommendationFixture(t, prefix, { firstStoreOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `self-evolve-${prefix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = openStore(root, { projectName: "first", projectFingerprint: H("1"), now: () => NOW, ...firstStoreOptions });
  const second = openStore(root, { projectName: "second", projectFingerprint: H("2"), now: () => NOW });
  t.after(() => first.close());
  t.after(() => second.close());
  enableContributionConsent(first);
  const lineage = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://github.com/example/repo.git" }));
  seedStoredContribution(first, {
    incidentId: `${prefix}-1`,
    evidenceDomainId: lineage.domainId,
    rootLineageHash: H("3"),
    occurrenceCount: 2,
    capsuleId: "11111111-1111-4111-8111-111111111111",
  });
  seedStoredContribution(second, {
    incidentId: `${prefix}-2`,
    evidenceDomainId: lineage.domainId,
    rootLineageHash: H("4"),
    occurrenceCount: 1,
    capsuleId: "22222222-2222-4222-8222-222222222222",
  });
  const { rootPolicy, targetBinding } = targetFixture();
  setGlobalRootPolicy(second, rootPolicy);
  const materialized = materialize(second, { targetBindings: [targetBinding], rootPolicy, nowMs: NOW });
  assert.equal(materialized.ok, true, materialized.reason);
  const recommendation = seedGlobalRecommendation(
    root,
    second,
    materialized.candidates[0],
    materialized.supportSets[0],
    targetBinding,
    rootPolicy,
  );
  return { root, first, second, recommendation };
}

function fact(overrides = {}) {
  return {
    contributionId: overrides.contributionId ?? "11111111-1111-4111-8111-111111111111",
    evidenceDomainId: overrides.evidenceDomainId ?? H("a"),
    incidentId: overrides.incidentId ?? "incident-1",
    occurrenceCount: overrides.occurrenceCount ?? 2,
    observedAt: overrides.observedAt ?? NOW,
    firstSeenDay: overrides.firstSeenDay ?? "2026-08-10",
    lastSeenDay: overrides.lastSeenDay ?? "2026-08-10",
    expiresAt: overrides.expiresAt ?? NOW + 30 * DAY,
    rootLineageHash: overrides.rootLineageHash ?? H("b"),
    originKind: overrides.originKind ?? "user",
    contradictionFree: overrides.contradictionFree ?? true,
    injectionFree: overrides.injectionFree ?? true,
    chronologyValid: overrides.chronologyValid ?? true,
    correlationValid: overrides.correlationValid ?? true,
  };
}

test("incident count immediately below boundary fixture", () => {
  const summary = summarizeGlobalCandidateSupport([fact()], { nowMs: NOW, retentionMs: 30 * DAY });
  assert.equal(summary.strongestSingleDomain.independentIncidentCount, 1);
  assert.equal(summary.independentIncidentCount, 1);
});

test("unknown-lineage fixture helpers remain conservative", () => {
  const summary = summarizeGlobalCandidateSupport([fact({
    evidenceDomainId: UNKNOWN_EVIDENCE_DOMAIN_ID,
    rootLineageHash: UNKNOWN_ROOT_LINEAGE_HASH,
    originKind: "unknown",
  })], { nowMs: NOW, retentionMs: 30 * DAY });
  assert.equal(summary.distributed.independentKnownDomainCount, 0);
  assert.equal(summary.strongestSingleDomain.lineageClass, "local-unknown");
});

test("duplicate events retries and sessions sharing one domain incident do not inflate support", () => {
  const summary = summarizeGlobalCandidateSupport([
    fact({ contributionId: "11111111-1111-4111-8111-111111111111", incidentId: "shared-incident", occurrenceCount: 2 }),
    fact({ contributionId: "22222222-2222-4222-8222-222222222222", incidentId: "shared-incident", occurrenceCount: 1 }),
    fact({ contributionId: "33333333-3333-4333-8333-333333333333", incidentId: "independent-incident", occurrenceCount: 1, rootLineageHash: H("c") }),
  ], { nowMs: NOW, retentionMs: 30 * DAY });
  assert.equal(summary.independentDomainCount, 1);
  assert.equal(summary.independentIncidentCount, 2);
  assert.equal(summary.occurrenceCount, 3, "a retry keeps the incident maximum instead of summing duplicates");
});

test("no-remote and ambiguous lineage partitions collapse to one unknown domain", () => {
  const noRemote = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "" }));
  const ambiguous = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrls: [
    "https://github.com/example/one.git",
    "https://github.com/example/two.git",
  ] }));
  const summary = summarizeGlobalCandidateSupport([
    fact({ evidenceDomainId: noRemote.domainId, incidentId: "no-remote" }),
    fact({ contributionId: "22222222-2222-4222-8222-222222222222", evidenceDomainId: ambiguous.domainId, incidentId: "ambiguous" }),
  ], { nowMs: NOW, retentionMs: 30 * DAY });
  assert.equal(noRemote.domainId, ambiguous.domainId);
  assert.equal(summary.independentDomainCount, 1);
  assert.equal(summary.distributed.independentKnownDomainCount, 0);
  assert.equal(summary.distributed.independentIncidentCount, 0);
});

test("supportSetHash is identity-free and idempotent for the same support", () => {
  const { targetBinding } = targetFixture();
  const summary = summarizeGlobalCandidateSupport([
    fact(),
    fact({ contributionId: "22222222-2222-4222-8222-222222222222", incidentId: "incident-2", occurrenceCount: 1, rootLineageHash: H("e") }),
  ], { nowMs: NOW, retentionMs: 30 * DAY });
  const input = {
    candidateId: H("f"),
    targetBinding,
    contributionIds: summary.contributionIds,
    strongestSingleDomain: summary.strongestSingleDomain,
    distributed: summary.distributed,
    integrity: summary.integrity,
    firstSeenDay: summary.firstSeenDay,
    lastSeenDay: summary.lastSeenDay,
    evaluatedAt: NOW,
    expiresAt: summary.expiresAt,
  };
  const first = schemas.makeGlobalSupportSet(input);
  const retried = schemas.makeGlobalSupportSet({ ...input, evaluatedAt: NOW + 1 });
  assert.equal(first.supportSetHash, retried.supportSetHash);
  assert.deepEqual(first.contributionIds, summary.contributionIds);
});

test("supportSetHash changes when new independent evidence changes support", () => {
  const below = eligibilityFixture({ single: { independentIncidentCount: 1 } }).support;
  const at = eligibilityFixture().support;
  assert.notEqual(below.supportSetHash, at.supportSetHash);
});

test("supportSetHash changes when the exact opaque evidence set changes with identical aggregate metrics", () => {
  const first = eligibilityFixture().support;
  const replacement = schemas.makeGlobalSupportSet({
    ...first,
    supportSetHash: undefined,
    contributionIds: ["22222222-2222-4222-8222-222222222222"],
  });
  assert.notEqual(replacement.supportSetHash, first.supportSetHash);
  assert.deepEqual(replacement.strongestSingleDomain, first.strongestSingleDomain);
  assert.deepEqual(replacement.distributed, first.distributed);
});

for (const [name, field, below] of [
  ["incident count", "independentIncidentCount", 1],
  ["occurrence sum", "occurrenceCount", 2],
  ["distinct non-unknown user root lineages", "nonUnknownUserRootLineageCount", 1],
  ["freshness ratio", "freshnessRatio", 0.499999],
]) {
  test(`${name} immediately below boundary fixture`, () => {
    assert.equal(eligibilityFixture({ single: { [field]: below } }).eligibility.eligible, false);
  });
  test(`${name} exactly at boundary fixture`, () => {
    assert.equal(eligibilityFixture().eligibility.route, "single-domain");
  });
}

for (const [name, field] of [
  ["contradiction", "contradictionFree"],
  ["injection", "injectionFree"],
  ["chronology", "chronologyValid"],
  ["correlation", "correlationValid"],
]) {
  test(`${name} immediately below boundary fixture`, () => {
    assert.equal(eligibilityFixture({ integrity: { [field]: false } }).eligibility.eligible, false);
  });
  test(`${name} exactly at boundary fixture`, () => {
    assert.equal(eligibilityFixture({ integrity: { [field]: true } }).eligibility.route, "single-domain");
  });
}

test("deterministic global target binding immediately below boundary fixture", () => {
  const { rootPolicy, targetBinding } = targetFixture();
  assert.throws(
    () => schemas.evaluateGlobalSupportEligibility(eligibilityFixture().support, schemas.makeGlobalRootPolicy({
      ...rootPolicy,
      roots: rootPolicy.roots.map((root) => ({ ...root, canUpdate: false })),
      rootSetHash: undefined,
    })),
    /approved-root|root-capability|target|root-set/u,
  );
  assert.equal(targetBinding.targetKind, "existing-global-skill");
});

test("deterministic global target binding exactly at boundary fixture", () => {
  assert.equal(eligibilityFixture().eligibility.route, "single-domain");
});

test("distributed 2-domain/3-incident support immediately below boundary fixture", () => {
  const result = eligibilityFixture({
    single: { nonUnknownUserRootLineageCount: 1 },
    distributed: { independentKnownDomainCount: 2, independentIncidentCount: 2 },
  }).eligibility;
  assert.equal(result.eligible, false);
});

test("distributed 2-domain/3-incident support exactly at boundary fixture", () => {
  const result = eligibilityFixture({
    single: { nonUnknownUserRootLineageCount: 1 },
    distributed: { independentKnownDomainCount: 2, independentIncidentCount: 3 },
  }).eligibility;
  assert.equal(result.route, "distributed");
});

test("unknown-lineage anti-inflation immediately below boundary fixture", () => {
  const summary = summarizeGlobalCandidateSupport([
    fact({ evidenceDomainId: H("1"), incidentId: "known-1", occurrenceCount: 1, rootLineageHash: H("4") }),
    fact({ contributionId: "22222222-2222-4222-8222-222222222222", evidenceDomainId: H("1"), incidentId: "known-2", occurrenceCount: 1, rootLineageHash: H("4") }),
    fact({ contributionId: "33333333-3333-4333-8333-333333333333", evidenceDomainId: UNKNOWN_EVIDENCE_DOMAIN_ID, incidentId: "unknown-1", occurrenceCount: 1, rootLineageHash: H("5") }),
  ], { nowMs: NOW, retentionMs: 30 * DAY });
  assert.equal(summary.distributed.independentKnownDomainCount, 1);
  assert.equal(summary.distributed.independentIncidentCount, 2);
  assert.equal(summary.distributed.unknownLineageCollapsed, true);
});

test("unknown-lineage anti-inflation exactly at complete single-domain boundary fixture", () => {
  const summary = summarizeGlobalCandidateSupport([
    fact({ evidenceDomainId: UNKNOWN_EVIDENCE_DOMAIN_ID, incidentId: "unknown-1", occurrenceCount: 2, rootLineageHash: H("6") }),
    fact({ contributionId: "22222222-2222-4222-8222-222222222222", evidenceDomainId: UNKNOWN_EVIDENCE_DOMAIN_ID, incidentId: "unknown-2", occurrenceCount: 1, rootLineageHash: H("7") }),
  ], { nowMs: NOW, retentionMs: 30 * DAY });
  const result = eligibilityFixture({
    single: summary.strongestSingleDomain,
    distributed: summary.distributed,
    integrity: summary.integrity,
  }).eligibility;
  assert.equal(result.route, "single-domain");
  assert.equal(result.distributedEligible, false);
});

test("separate project partitions with one canonical source lineage converge on one global candidate", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-candidate-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = openStore(root, { projectName: "clone", projectFingerprint: H("1"), now: () => NOW });
  const second = openStore(root, { projectName: "linked", projectFingerprint: H("2"), now: () => NOW });
  t.after(() => { first.close(); second.close(); });
  enableContributionConsent(first);
  const lineage = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://github.com/example/repo.git" }));
  seedStoredContribution(first, {
    incidentId: "clone-incident-1",
    evidenceDomainId: lineage.domainId,
    rootLineageHash: H("3"),
    occurrenceCount: 2,
    capsuleId: "11111111-1111-4111-8111-111111111111",
  });
  seedStoredContribution(second, {
    incidentId: "linked-incident-2",
    evidenceDomainId: lineage.domainId,
    rootLineageHash: H("4"),
    occurrenceCount: 1,
    capsuleId: "22222222-2222-4222-8222-222222222222",
  });
  const { rootPolicy, targetBinding } = targetFixture();
  setGlobalRootPolicy(second, rootPolicy);
  const result = materialize(second, { targetBindings: [targetBinding], rootPolicy, nowMs: NOW });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].state, "eligible");
  assert.equal(result.candidates[0].eligibilityRoute, "single-domain");
  assert.equal(result.candidates[0].independentDomainCount, 1, "clone/worktree lineage counts once");
  assert.equal(second.readGlobalSupportSets().length, 1);
});

test("distributed 2-domain/3-incident support counts clone lineage once and excludes unknown support", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-candidate-distributed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stores = [H("1"), H("2"), H("3"), H("4")].map((projectFingerprint, index) => openStore(root, {
    projectName: `partition-${index}`, projectFingerprint, now: () => NOW,
  }));
  t.after(() => stores.forEach((store) => store.close()));
  enableContributionConsent(stores[0]);
  const cloneDomain = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "git@github.com:example/repo.git" }));
  const independentDomain = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://gitlab.com/example/repo.git" }));
  const domains = [cloneDomain.domainId, cloneDomain.domainId, independentDomain.domainId, UNKNOWN_EVIDENCE_DOMAIN_ID];
  stores.forEach((store, index) => seedStoredContribution(store, {
    incidentId: `distributed-${index}`,
    evidenceDomainId: domains[index],
    rootLineageHash: index < 2 ? H("5") : index === 2 ? H("a") : H("b"),
    occurrenceCount: 1,
    capsuleId: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
  }));
  const { rootPolicy, targetBinding } = targetFixture();
  setGlobalRootPolicy(stores[3], rootPolicy);
  const materialized = materialize(stores[3], { targetBindings: [targetBinding], rootPolicy, nowMs: NOW });
  assert.equal(materialized.ok, true, materialized.reason);
  assert.equal(materialized.candidates[0].eligibilityRoute, "distributed");
  assert.equal(materialized.candidates[0].independentDomainCount, 3, "two known domains plus one collapsed unknown domain");
  assert.equal(materialized.supportSets[0].distributed.independentKnownDomainCount, 2);
  assert.equal(materialized.supportSets[0].distributed.independentIncidentCount, 3, "unknown incident cannot supply distributed support");
  assert.equal(materialized.supportSets[0].distributed.unknownLineageCollapsed, true);
  assert.doesNotMatch(JSON.stringify(materialized.supportSets[0]), new RegExp(`${cloneDomain.domainId}|${independentDomain.domainId}|${UNKNOWN_EVIDENCE_DOMAIN_ID}`, "u"));
});

for (const terminalState of ["rejected", "failed-closed"]) {
  test(`${terminalState} support cannot resynthesize until new evidence changes supportSetHash`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `self-evolve-candidate-${terminalState}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stores = [H("1"), H("2"), H("3")].map((projectFingerprint, index) => openStore(root, {
      projectName: `partition-${index}`,
      projectFingerprint,
      now: () => NOW,
    }));
    t.after(() => stores.forEach((store) => store.close()));
    enableContributionConsent(stores[0]);
    const lineage = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://github.com/example/repo.git" }));
    seedStoredContribution(stores[0], {
      incidentId: `${terminalState}-1`, evidenceDomainId: lineage.domainId, rootLineageHash: H("4"), occurrenceCount: 2,
      capsuleId: "11111111-1111-4111-8111-111111111111",
    });
    seedStoredContribution(stores[1], {
      incidentId: `${terminalState}-2`, evidenceDomainId: lineage.domainId, rootLineageHash: H("5"), occurrenceCount: 1,
      capsuleId: "22222222-2222-4222-8222-222222222222",
    });
    const { rootPolicy, targetBinding } = targetFixture();
    setGlobalRootPolicy(stores[2], rootPolicy);
    const first = materialize(stores[2], { targetBindings: [targetBinding], rootPolicy, nowMs: NOW });
    const candidate = first.candidates[0];
    const toSynthesis = stores[2].transitionGlobalCandidate(candidate.candidateId, {
      state: "synthesis-pending",
      supportSetHash: candidate.supportSetHash,
      eligibilityRoute: candidate.eligibilityRoute,
    }, NOW + 1);
    assert.equal(toSynthesis.ok, true, toSynthesis.reason);
    if (terminalState === "rejected") {
      const recommended = stores[2].transitionGlobalCandidate(candidate.candidateId, {
        state: "recommended",
        supportSetHash: candidate.supportSetHash,
        eligibilityRoute: candidate.eligibilityRoute,
      }, NOW + 2);
      assert.equal(recommended.ok, true, recommended.reason);
      assert.equal(stores[2].transitionGlobalCandidate(candidate.candidateId, {
        state: terminalState,
        supportSetHash: candidate.supportSetHash,
        eligibilityRoute: candidate.eligibilityRoute,
      }, NOW + 3).ok, true);
    } else {
      assert.equal(stores[2].transitionGlobalCandidate(candidate.candidateId, {
        state: terminalState,
        supportSetHash: candidate.supportSetHash,
        eligibilityRoute: candidate.eligibilityRoute,
      }, NOW + 2).ok, true);
    }
    const retry = materialize(stores[2], { targetBindings: [targetBinding], rootPolicy, nowMs: NOW + 4 });
    assert.equal(retry.candidates[0].state, terminalState);
    assert.equal(retry.candidates[0].supportSetHash, candidate.supportSetHash);

    seedStoredContribution(stores[2], {
      incidentId: `${terminalState}-3`, evidenceDomainId: lineage.domainId, rootLineageHash: H("6"), occurrenceCount: 1,
      capsuleId: "33333333-3333-4333-8333-333333333333",
    });
    const changed = materialize(stores[2], { targetBindings: [targetBinding], rootPolicy, nowMs: NOW + 5 });
    assert.equal(changed.candidates[0].state, "eligible");
    assert.notEqual(changed.candidates[0].supportSetHash, candidate.supportSetHash);
  });
}

test("equivalent patterns converge while unrelated patterns and targets remain distinct", () => {
  const { rootPolicy, targetBinding } = targetFixture();
  const otherTarget = schemas.makeCandidateTargetBinding({
    ...targetBinding,
    logicalName: "other-review",
    relativePath: "other-review/SKILL.md",
    currentHash: H("e"),
    bindingHash: undefined,
  }, rootPolicy);
  const base = {
    claimType: "global-skill-candidate",
    receiptType: "repeated-tool-error",
    signatureHash: H("8"),
    targetBindingHash: targetBinding.bindingHash,
    supportSetHash: H("f"),
    state: "collecting",
    eligibilityRoute: null,
    independentDomainCount: 1,
    independentIncidentCount: 1,
    occurrenceCount: 1,
    firstSeenDay: "2026-08-10",
    lastSeenDay: "2026-08-10",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const first = schemas.makeGlobalCandidate(base);
  assert.equal(schemas.makeGlobalCandidate({ ...base }).candidateId, first.candidateId);
  assert.notEqual(schemas.makeGlobalCandidate({ ...base, signatureHash: H("a") }).candidateId, first.candidateId);
  assert.notEqual(schemas.makeGlobalCandidate({ ...base, targetBindingHash: otherTarget.bindingHash }).candidateId, first.candidateId);
});

test("global candidate and support files enumerate identity-free summaries only", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-candidate-firewall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = openStore(root, { projectName: "first", projectFingerprint: H("1"), now: () => NOW });
  const second = openStore(root, { projectName: "second", projectFingerprint: H("2"), now: () => NOW });
  t.after(() => { first.close(); second.close(); });
  enableContributionConsent(first);
  const lineage = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://github.com/example/private-source.git" }));
  const seeded = [
    seedStoredContribution(first, {
      incidentId: "private-local-incident-1", evidenceDomainId: lineage.domainId, rootLineageHash: H("3"), occurrenceCount: 2,
      capsuleId: "11111111-1111-4111-8111-111111111111",
    }),
    seedStoredContribution(second, {
      incidentId: "private-local-incident-2", evidenceDomainId: lineage.domainId, rootLineageHash: H("4"), occurrenceCount: 1,
      capsuleId: "22222222-2222-4222-8222-222222222222",
    }),
  ];
  const { rootPolicy, targetBinding } = targetFixture();
  setGlobalRootPolicy(second, rootPolicy);
  assert.equal(materialize(second, { targetBindings: [targetBinding], rootPolicy, nowMs: NOW }).ok, true);
  const support = second.readGlobalSupportSets()[0];
  assert.deepEqual(support.contributionIds, seeded.map((item) => item.published.contribution.contributionId).sort());
  assert.equal(Object.hasOwn(second.readGlobalCandidates()[0], "contributionIds"), false);

  const globalDir = path.join(root, "self-evolve", "global");
  const files = treeFiles(globalDir).filter((filePath) => /\/(?:candidates|candidate-support)\//u.test(filePath));
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((filePath) => path.relative(globalDir, filePath)), [
    `candidate-support/${second.readGlobalSupportSets()[0].supportSetHash.slice(0, 2)}/${second.readGlobalSupportSets()[0].supportSetHash}.json`,
    `candidates/${second.readGlobalCandidates()[0].candidateId.slice(0, 2)}/${second.readGlobalCandidates()[0].candidateId}.json`,
  ]);
  const serialized = files.map((filePath) => `${path.relative(globalDir, filePath)}\n${fs.readFileSync(filePath, "utf8")}`).join("\n");
  const forbidden = [
    H("1"), H("2"), lineage.domainId, H("9"), H("6"), H("3"), H("4"),
    "private-local-incident-1", "private-local-incident-2",
    "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
    ...seeded.flatMap((item) => [item.observation.id, item.capsule.capsuleId, item.cluster.id]),
  ];
  for (const value of forbidden.flatMap((item) => [item, hashSignature(item)])) {
    assert.equal(serialized.includes(value), false, `forbidden global identity leaked: ${value}`);
  }
  for (const record of [...second.readGlobalCandidates(), ...second.readGlobalSupportSets()]) {
    assert.equal(schemas.assertGlobalIdentitySafe(record, { forbiddenIdentityValues: forbidden.flatMap((item) => [item, hashSignature(item)]) }), true);
  }
});

test("support expiry removes affected pending authority without backfilling", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-candidate-expiry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = NOW;
  const stores = [H("1"), H("2")].map((projectFingerprint, index) => openStore(root, {
    projectName: `partition-${index}`, projectFingerprint, now: () => clock,
  }));
  t.after(() => stores.forEach((store) => store.close()));
  enableContributionConsent(stores[0]);
  const lineage = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://github.com/example/repo.git" }));
  seedStoredContribution(stores[0], {
    incidentId: "expiring-1", evidenceDomainId: lineage.domainId, rootLineageHash: H("3"), occurrenceCount: 2,
    capsuleId: "11111111-1111-4111-8111-111111111111", signatureHash: H("8"), clusterId: H("9"), createdAt: clock,
  });
  seedStoredContribution(stores[1], {
    incidentId: "expiring-2", evidenceDomainId: lineage.domainId, rootLineageHash: H("4"), occurrenceCount: 1,
    capsuleId: "22222222-2222-4222-8222-222222222222", signatureHash: H("8"), clusterId: H("9"), createdAt: clock,
  });
  clock = NOW + 20 * DAY;
  seedStoredContribution(stores[0], {
    incidentId: "retained-1", evidenceDomainId: lineage.domainId, rootLineageHash: H("5"), occurrenceCount: 2,
    capsuleId: "33333333-3333-4333-8333-333333333333", signatureHash: H("a"), clusterId: H("b"), createdAt: clock,
  });
  seedStoredContribution(stores[1], {
    incidentId: "retained-2", evidenceDomainId: lineage.domainId, rootLineageHash: H("6"), occurrenceCount: 1,
    capsuleId: "44444444-4444-4444-8444-444444444444", signatureHash: H("a"), clusterId: H("b"), createdAt: clock,
  });
  const { rootPolicy, targetBinding } = targetFixture();
  setGlobalRootPolicy(stores[1], rootPolicy);
  const materialized = materialize(stores[1], { targetBindings: [targetBinding], rootPolicy, nowMs: clock });
  assert.equal(materialized.candidates.length, 2);
  const retainedBefore = materialized.candidates.find((candidate) => candidate.signatureHash === H("a"));
  const expiring = materialized.candidates.find((candidate) => candidate.signatureHash === H("8"));
  clock = NOW + 31 * DAY;
  const retained = stores[1].retain(clock);
  assert.equal(retained.contributions, 2);
  assert.equal(stores[1].readGlobalCandidates().some((candidate) => candidate.candidateId === expiring.candidateId), false);
  assert.deepEqual(stores[1].readGlobalCandidates().find((candidate) => candidate.candidateId === retainedBefore.candidateId), retainedBefore);
  assert.equal(stores[1].readGlobalSupportSets().some((support) => support.supportSetHash === expiring.supportSetHash), false);
});

test("project purge does not backfill affected or unrelated pending authority", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-candidate-purge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stores = [H("1"), H("2"), H("3"), H("4")].map((projectFingerprint, index) => openStore(root, {
    projectName: `partition-${index}`, projectFingerprint, now: () => NOW,
  }));
  t.after(() => stores.forEach((store) => store.close()));
  enableContributionConsent(stores[0]);
  const lineage = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://github.com/example/repo.git" }));
  for (const [index, store] of stores.entries()) {
    const affected = index < 2;
    seedStoredContribution(store, {
      incidentId: `${affected ? "affected" : "unrelated"}-${index}`,
      evidenceDomainId: lineage.domainId,
      rootLineageHash: H(String(5 + index)),
      occurrenceCount: index % 2 === 0 ? 2 : 1,
      signatureHash: affected ? H("a") : H("b"),
      clusterId: affected ? H("e") : H("f"),
      capsuleId: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
    });
  }
  const { rootPolicy, targetBinding } = targetFixture();
  setGlobalRootPolicy(stores[3], rootPolicy);
  const materialized = materialize(stores[3], { targetBindings: [targetBinding], rootPolicy, nowMs: NOW });
  assert.equal(materialized.ok, true, materialized.reason);
  assert.equal(materialized.candidates.length, 2);
  const affectedBefore = materialized.candidates.find((candidate) => candidate.signatureHash === H("a"));
  const unrelatedBefore = materialized.candidates.find((candidate) => candidate.signatureHash === H("b"));
  assert.equal(stores[0].purge({ scope: "project" }).ok, true);
  const candidates = stores[3].readGlobalCandidates();
  const affectedAfter = candidates.find((candidate) => candidate.candidateId === affectedBefore.candidateId);
  assert.equal(affectedAfter, undefined);
  assert.deepEqual(candidates.find((candidate) => candidate.candidateId === unrelatedBefore.candidateId), unrelatedBefore);
});

test("project purge supersedes stale global Apply authority without removing another project's evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-candidate-recommendation-purge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = openStore(root, { projectName: "first", projectFingerprint: H("1"), now: () => NOW });
  const second = openStore(root, { projectName: "second", projectFingerprint: H("2"), now: () => NOW });
  t.after(() => first.close());
  t.after(() => second.close());
  enableContributionConsent(first);
  const lineage = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://github.com/example/repo.git" }));
  seedStoredContribution(first, {
    incidentId: "purged-recommendation-1",
    evidenceDomainId: lineage.domainId,
    rootLineageHash: H("3"),
    occurrenceCount: 2,
    capsuleId: "11111111-1111-4111-8111-111111111111",
  });
  const retained = seedStoredContribution(second, {
    incidentId: "retained-recommendation-2",
    evidenceDomainId: lineage.domainId,
    rootLineageHash: H("4"),
    occurrenceCount: 1,
    capsuleId: "22222222-2222-4222-8222-222222222222",
  });
  const { rootPolicy, targetBinding } = targetFixture();
  setGlobalRootPolicy(second, rootPolicy);
  const materialized = materialize(second, { targetBindings: [targetBinding], rootPolicy, nowMs: NOW });
  assert.equal(materialized.ok, true, materialized.reason);
  const recommendation = seedGlobalRecommendation(
    root,
    second,
    materialized.candidates[0],
    materialized.supportSets[0],
    targetBinding,
    rootPolicy,
  );

  assert.equal(first.purge({ scope: "project" }).ok, true);

  assert.equal(second.readRecords("observation").some((record) => record.payload.incidentId === retained.observation.incidentId), true);
  assert.deepEqual(second.readContributions({ scope: "project", includeExpired: true }).map((item) => item.contributionId), [retained.published.contribution.contributionId]);
  const stale = second.readGlobalRecommendations().find((item) => item.recommendationId === recommendation.recommendationId);
  assert.equal(stale.state, "superseded");
  assert.equal(second.readGlobalRecommendationContent(recommendation.recommendationId), null);
  assert.equal(second.readGlobalCandidates().find((item) => item.candidateId === recommendation.candidateId).state, "superseded");
});

test("global recommendation purge removes exactly one global chain and preserves project evidence", (t) => {
  const { second, recommendation } = globalRecommendationFixture(t, "single-global-recommendation-purge");
  const contributionIds = second.readContributions({ scope: "global", includeExpired: true }).map((item) => item.contributionId);
  const projectRecords = second.readRecords("observation");

  const purged = second.purge({
    scope: "global-recommendation",
    recommendationId: recommendation.recommendationId,
  });

  assert.equal(purged.ok, true, purged.reason);
  assert.equal(purged.counts.globalRecommendations, 1);
  assert.deepEqual(second.readGlobalRecommendations(), []);
  assert.deepEqual(second.readGlobalCandidates(), []);
  assert.deepEqual(second.readGlobalSupportSets(), []);
  assert.deepEqual(second.readContributions({ scope: "global", includeExpired: true }).map((item) => item.contributionId), contributionIds);
  assert.deepEqual(second.readRecords("observation"), projectRecords);
});

test("global recommendations purge reclaims candidate domains without deleting project contributions", (t) => {
  const { second } = globalRecommendationFixture(t, "all-global-recommendations-purge");
  const contributions = second.readContributions({ scope: "global", includeExpired: true });

  const purged = second.purge({ scope: "global-recommendations" });

  assert.equal(purged.ok, true, purged.reason);
  assert.equal(purged.counts.globalRecommendations, 1);
  assert.equal(purged.counts.globalCandidates, 1);
  assert.equal(purged.counts.globalSupportSets, 1);
  assert.deepEqual(second.readGlobalRecommendations(), []);
  assert.deepEqual(second.readGlobalCandidates(), []);
  assert.deepEqual(second.readGlobalSupportSets(), []);
  assert.deepEqual(second.readContributions({ scope: "global", includeExpired: true }), contributions);
  assert.equal(second.readRecords("observation").length > 0, true);
});

test("single global recommendation purge converges idempotently across every durable crash boundary", async (t) => {
  for (const faultPoint of [
    "global-purge-after-candidate-domains",
    "global-purge-after-history",
    "global-purge-after-content",
    "global-purge-after-recommendation",
  ]) {
    await t.test(faultPoint, (t) => {
      let armed = true;
      const f = globalRecommendationFixture(t, `global-purge-crash-${faultPoint}`, {
        firstStoreOptions: {
          faultInjection(point) {
            if (armed && point === faultPoint) {
              armed = false;
              throw new Error(`fixture-fault:${point}`);
            }
          },
        },
      });
      const recommendationId = f.recommendation.recommendationId;
      const contributions = f.second.readContributions({ scope: "global", includeExpired: true });
      const projectRecords = f.second.readRecords("observation");
      assert.equal(f.first.purge({ scope: "global-recommendation", recommendationId }).ok, false);

      const recovered = openStore(f.root, {
        projectName: "recovered",
        projectFingerprint: H("2"),
        now: () => NOW + 1,
        staleLockMs: 1,
      });
      t.after(() => recovered.close());
      assert.equal(recovered.purge({ scope: "global-recommendation", recommendationId }).ok, true);
      assert.equal(recovered.purge({ scope: "global-recommendation", recommendationId }).ok, true);
      assert.deepEqual(recovered.readGlobalRecommendations(), []);
      assert.deepEqual(recovered.readGlobalCandidates(), []);
      assert.deepEqual(recovered.readGlobalSupportSets(), []);
      assert.deepEqual(recovered.readGlobalDecisions(), []);
      assert.deepEqual(recovered.readGlobalApplyIntents(), []);
      assert.deepEqual(recovered.readGlobalSkillSnapshots(), []);
      assert.deepEqual(recovered.readGlobalDecisionOutcomes(), []);
      assert.deepEqual(recovered.readGlobalAudits(), []);
      assert.deepEqual(recovered.readContributions({ scope: "global", includeExpired: true }), contributions);
      assert.deepEqual(recovered.readRecords("observation"), projectRecords);
    });
  }
});

test("project purge recommendation invalidation recovers every durable crash boundary idempotently", async (t) => {
  for (const faultPoint of [
    "global-lifecycle-after-decision",
    "global-lifecycle-after-recommendation",
    "global-lifecycle-after-candidate",
    "global-lifecycle-after-audit",
  ]) {
    await t.test(faultPoint, (t) => {
      let armed = true;
      const f = globalRecommendationFixture(t, `lifecycle-crash-${faultPoint}`, {
        firstStoreOptions: {
          faultInjection(point) {
            if (armed && point === faultPoint) {
              armed = false;
              throw new Error(`fixture-fault:${point}`);
            }
          },
        },
      });
      assert.equal(f.first.purge({ scope: "project" }).ok, false);

      const recovered = openStore(f.root, {
        projectName: "recovered",
        projectFingerprint: H("2"),
        now: () => NOW + 1,
        staleLockMs: 1,
      });
      t.after(() => recovered.close());
      const recommendation = recovered.readGlobalRecommendations()
        .find((item) => item.recommendationId === f.recommendation.recommendationId);
      assert.equal(recommendation.state, "superseded");
      assert.equal(recovered.readGlobalRecommendationContent(recommendation.recommendationId), null);
      assert.equal(recovered.readGlobalCandidates().find((item) => item.candidateId === recommendation.candidateId).state, "superseded");
      assert.equal(recovered.readGlobalDecisions().filter((item) => item.recommendationId === recommendation.recommendationId).length, 1);
      assert.equal(recovered.readGlobalAudits().filter((item) => item.recommendationId === recommendation.recommendationId).length, 1);
      assert.equal(recovered.recoverGlobalLifecycle().recovered, 0);
    });
  }
});

function runCandidateChild(root, projectFingerprint, rootPolicy, targetBinding, nowMs, mode = "none", { expectSignal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CANDIDATE_CHILD,
      root,
      projectFingerprint,
      JSON.stringify(rootPolicy),
      JSON.stringify(targetBinding),
      String(nowMs),
      mode,
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
      else resolve(JSON.parse(stdout));
    });
  });
}

function candidateConcurrencyFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `self-evolve-${prefix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = openStore(root, { projectName: "first", projectFingerprint: H("1"), now: () => NOW });
  const second = openStore(root, { projectName: "second", projectFingerprint: H("2"), now: () => NOW });
  t.after(() => first.close());
  t.after(() => second.close());
  enableContributionConsent(first);
  const lineage = schemas.makeEvidenceDomain(deriveSourceLineage({ remoteUrl: "https://github.com/example/repo.git" }));
  seedStoredContribution(first, {
    incidentId: `${prefix}-first`,
    evidenceDomainId: lineage.domainId,
    rootLineageHash: H("3"),
    occurrenceCount: 2,
    capsuleId: "11111111-1111-4111-8111-111111111111",
  });
  seedStoredContribution(second, {
    incidentId: `${prefix}-second`,
    evidenceDomainId: lineage.domainId,
    rootLineageHash: H("4"),
    occurrenceCount: 1,
    capsuleId: "22222222-2222-4222-8222-222222222222",
  });
  const { rootPolicy, targetBinding } = targetFixture();
  setGlobalRootPolicy(second, rootPolicy);
  return { root, first, second, rootPolicy, targetBinding };
}

function globalRecordBytes(root) {
  const global = path.join(root, "self-evolve", "global");
  return Object.fromEntries(["candidates", "candidate-support"].map((directory) => [
    directory,
    treeFiles(path.join(global, directory)).map((filePath) => [
      path.relative(global, filePath),
      fs.readFileSync(filePath, "utf8"),
    ]),
  ]));
}

test("concurrent project processes materialize one canonical candidate and support set", async (t) => {
  const f = candidateConcurrencyFixture(t, "candidate-concurrent-materialization");

  const results = await Promise.all([
    runCandidateChild(f.root, H("1"), f.rootPolicy, f.targetBinding, NOW),
    runCandidateChild(f.root, H("2"), f.rootPolicy, f.targetBinding, NOW),
  ]);

  assert.deepEqual(results.map((result) => result.ok), [true, true], JSON.stringify(results));
  assert.deepEqual(results[0].candidateIds, results[1].candidateIds);
  assert.deepEqual(results[0].supportSetHashes, results[1].supportSetHashes);
  assert.equal(results[0].candidateIds.length, 1);
  assert.equal(results.filter((result) => result.changed > 0).length, 1, "materialization is not idempotent across processes");
  assert.equal(f.second.readGlobalCandidates().length, 1);
  assert.equal(f.second.readGlobalSupportSets().length, 1);
  assert.equal(treeFiles(path.join(f.root, "self-evolve", "global", "candidates")).length, 1);
  assert.equal(treeFiles(path.join(f.root, "self-evolve", "global", "candidate-support")).length, 1);
});

test("a process killed between candidate change writes converges on the next materialization", async (t) => {
  for (const crashAfter of [1, 2]) {
    await t.test(`crash after change ${crashAfter}`, async (t) => {
      const f = candidateConcurrencyFixture(t, `candidate-crash-${crashAfter}`);
      const complete = await runCandidateChild(f.root, H("2"), f.rootPolicy, f.targetBinding, NOW);
      assert.equal(complete.ok, true, complete.reason);
      const expected = globalRecordBytes(f.root);
      assert.equal(expected.candidates.length + expected["candidate-support"].length >= 2, true);
      fs.rmSync(path.join(f.root, "self-evolve", "global", "candidates"), { recursive: true, force: true });
      fs.rmSync(path.join(f.root, "self-evolve", "global", "candidate-support"), { recursive: true, force: true });

      await runCandidateChild(f.root, H("2"), f.rootPolicy, f.targetBinding, NOW, `crash:${crashAfter}`, { expectSignal: "SIGKILL" });
      const partial = globalRecordBytes(f.root);
      assert.equal(partial.candidates.length + partial["candidate-support"].length, crashAfter);

      const converged = await runCandidateChild(f.root, H("1"), f.rootPolicy, f.targetBinding, NOW);

      assert.equal(converged.ok, true, converged.reason);
      assert.deepEqual(globalRecordBytes(f.root), expected, "partial materialization did not converge byte-identically");
      assert.equal(f.second.readGlobalCandidates().length, 1);
      assert.equal(f.second.readGlobalSupportSets().length, 1);
    });
  }
});

test("a project purge concurrent with materialization leaves no orphan candidate support", async (t) => {
  const f = candidateConcurrencyFixture(t, "candidate-purge-race");
  const seeded = await runCandidateChild(f.root, H("2"), f.rootPolicy, f.targetBinding, NOW);
  assert.equal(seeded.ok, true, seeded.reason);

  const [purged, rematerialized] = await Promise.all([
    Promise.resolve().then(() => f.first.purge({ scope: "project" })),
    runCandidateChild(f.root, H("2"), f.rootPolicy, f.targetBinding, NOW + 1),
  ]);

  assert.equal(purged.ok, true, purged.reason);
  assert.equal(rematerialized.ok, true, rematerialized.reason);
  const supportSets = f.second.readGlobalSupportSets();
  const candidates = f.second.readGlobalCandidates();
  const activeContributions = new Set(f.second.readContributions({ scope: "global" }).map((item) => item.contributionId));
  for (const supportSet of supportSets) {
    for (const contributionId of supportSet.contributionIds) {
      assert.equal(activeContributions.has(contributionId), true, "support set references a purged contribution");
    }
  }
  const supportHashes = new Set(supportSets.map((supportSet) => supportSet.supportSetHash));
  for (const candidate of candidates) {
    assert.equal(supportHashes.has(candidate.supportSetHash), true, "candidate references a removed support set");
  }
  assert.equal(f.second.readRecords("observation").length > 0, true);
});
