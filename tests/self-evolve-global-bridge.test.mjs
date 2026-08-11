import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGlobalRecommendationProjection,
  buildProjectParticipationSidecars,
} from "../self-evolve-projection.js";
import {
  BRIDGE_TTL_MS,
  cleanupBridge,
  consumeGlobalActionRequests,
  createGlobalActionRequest,
  hashTuiHostHealth,
  pendingGlobalActionRequestCount,
  pollGlobalActionResponse,
  publishGlobalRecommendationProjection,
  publishProjectParticipationSidecars,
  publishTuiHostHealth,
  readGlobalRecommendationProjection,
  readProjectParticipationSidecar,
  readProjectParticipationSidecars,
  revokeTuiHostHealth,
  submitGlobalActionRequest,
} from "../self-evolve-bridge.js";
import { openStore } from "../self-evolve-store.js";
import * as inventory from "../self-evolve-inventory.js";
import * as schemas from "../self-evolve-schemas.js";

import {
  GLOBAL_BRIDGE_SCHEMA_VERSION,
  GLOBAL_CAPABILITIES,
  GLOBAL_OPERATION_PROTOCOL_VERSION,
  GLOBAL_PROJECTION_VERSION,
  GLOBAL_PROTOCOL_LIMITS,
  hashGlobalProtocol,
  makeGlobalActionGrant,
  makeGlobalActionRequestEnvelope,
  makeGlobalProtocolOffer,
  makeGlobalRecommendationDetail,
  makeGlobalRecommendationIndex,
  makeProjectParticipationSidecar,
  negotiateGlobalProtocol,
} from "../self-evolve-ui-protocol.js";

const NOW = Date.UTC(2026, 7, 11);
const H = (value) => createHash("sha256").update(String(value)).digest("hex");
const ROOT = H("state-root");
const GENERATION = H("generation");
const INDEX_HASH = H("index");
const RECOMMENDATION = H("recommendation");
const SUPPORT = H("support");
const BINDING = H("binding");
const CURRENT = H("current");
const PROPOSED = H("proposed");
const PROJECT = H("acting-project");
const HEALTH = H("acting-health");
const CONTENT = "---\nname: durable-review\ndescription: Reviews failures.\n---\n\n# Durable Review\n";
const PROPOSED_CONTENT = `${CONTENT}\nVerify the exact failure before changing guidance.\n`;
const CONSUMER_PROCESS = new URL("./fixtures/global-bridge-consumer-process.mjs", import.meta.url);
const REAL_DOMAIN_PROCESS = new URL("./fixtures/global-bridge-real-domain-process.mjs", import.meta.url);
const PROJECTION_PUBLISHER = new URL("./fixtures/global-projection-publisher.mjs", import.meta.url);

function runConsumerProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONSUMER_PROCESS.pathname, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`global consumer exited ${code ?? signal}: ${stderr}`));
    });
  });
}

function runRealDomainProcess(args, { expectSignal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REAL_DOMAIN_PROCESS.pathname, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (expectSignal !== null && signal === expectSignal) resolve({ code, signal });
      else if (expectSignal !== null) reject(new Error(`expected ${expectSignal}, real global consumer exited ${code ?? signal}: ${stderr}`));
      else if (code === 0) resolve({ code, signal });
      else reject(new Error(`real global consumer exited ${code ?? signal}: ${stderr}`));
    });
  });
}

async function waitForPath(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filePath)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function globalOffer() {
  return makeGlobalProtocolOffer({
    bridgeSchemaVersions: [GLOBAL_BRIDGE_SCHEMA_VERSION],
    projectionVersions: [GLOBAL_PROJECTION_VERSION],
    operationProtocolVersions: [GLOBAL_OPERATION_PROTOCOL_VERSION],
    capabilities: GLOBAL_CAPABILITIES,
  });
}

const REQUIRED_GLOBAL_WRITE_CAPABILITIES = Object.freeze([
  "global-action-grant-v1",
  "global-action-request-v1",
  "global-generality-v1",
  "global-recommendation-detail-v1",
  "global-recommendation-index-v1",
  "global-transaction-v1",
  "project-participation-v1",
]);

function globalIndex(overrides = {}) {
  const body = {
    projectionVersion: GLOBAL_PROJECTION_VERSION,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.projectionTtlMs,
    capabilities: GLOBAL_CAPABILITIES,
    recommendations: [{
      recommendationId: RECOMMENDATION,
      recommendationVersion: 1,
      supportSetHash: SUPPORT,
      state: "pending",
      target: { kind: "existing-global-skill", label: "durable-review" },
      support: {
        tier: "single-domain",
        independentDomainCount: 1,
        independentIncidentCount: 2,
        occurrenceCount: 3,
      },
      dates: { firstSeenDay: "2026-08-01", lastSeenDay: "2026-08-11", synthesizedAt: NOW - 1_000, updatedAt: NOW - 1_000 },
      safety: { criticScoreBasisPoints: 9_900, criticPassed: true, validDeterministic: true },
      availableActions: ["apply", "reject"],
      detailHash: H("detail"),
    }],
    overflow: { truncated: false, includedCount: 1, omittedCount: 0, omittedBytes: 0, reason: "none" },
    ...overrides,
  };
  return { ...body, indexHash: hashGlobalProtocol("recommendation-index", body) };
}

function globalDetail(overrides = {}) {
  const body = {
    projectionVersion: GLOBAL_PROJECTION_VERSION,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    supportSetHash: SUPPORT,
    targetBindingHash: BINDING,
    targetHash: CURRENT,
    proposedContentHash: PROPOSED,
    priorState: "pending",
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.projectionTtlMs,
    target: { kind: "existing-global-skill", label: "durable-review" },
    support: {
      tier: "single-domain",
      independentDomainCount: 1,
      independentIncidentCount: 2,
      occurrenceCount: 3,
      firstSeenDay: "2026-08-01",
      lastSeenDay: "2026-08-11",
    },
    safety: { criticScoreBasisPoints: 9_900, criticPassed: true, validDeterministic: true },
    generality: { passed: true, basis: "deterministic-generality-gate-v1" },
    rationale: "Independent support warrants one bounded global correction.",
    diff: { kind: "unified", lines: ["--- durable-review/SKILL.md", "+++ durable-review/SKILL.md"], overflow: { truncated: false, includedCount: 2, omittedCount: 0, omittedBytes: 0, reason: "none" } },
    evidenceSummary: [{ kind: "independent-incidents", count: 2 }, { kind: "occurrences", count: 3 }],
    availableActions: ["apply", "reject"],
    ...overrides,
  };
  return { ...body, detailHash: hashGlobalProtocol("recommendation-detail", body) };
}

function projectionFixture(stateRootIdentity = ROOT) {
  const contributionId = "11111111-1111-4111-8111-111111111111";
  const recommendation = {
    recommendationId: RECOMMENDATION,
    candidateId: H("candidate"),
    supportSetHash: SUPPORT,
    targetBinding: {
      targetKind: "existing-global-skill",
      logicalName: "durable-review",
      relativePath: "durable-review/SKILL.md",
      currentHash: H(CONTENT),
      bindingHash: BINDING,
    },
    proposedContentHash: H(PROPOSED_CONTENT),
    rationaleText: "Independent support warrants one bounded global correction.",
    synthesizedAt: NOW - 1_000,
    criticScore: 0.99,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    decisionVersion: 0,
  };
  const supportSet = {
    supportSetHash: SUPPORT,
    candidateId: recommendation.candidateId,
    contributionIds: [contributionId],
    strongestSingleDomain: { independentIncidentCount: 2, occurrenceCount: 3 },
    distributed: { independentKnownDomainCount: 1, independentIncidentCount: 2 },
    firstSeenDay: "2026-08-01",
    lastSeenDay: "2026-08-11",
  };
  const candidate = {
    candidateId: recommendation.candidateId,
    supportSetHash: SUPPORT,
    eligibilityRoute: "single-domain",
    independentDomainCount: 1,
    independentIncidentCount: 2,
    occurrenceCount: 3,
    updatedAt: NOW - 500,
  };
  let nonce = 0;
  const projection = buildGlobalRecommendationProjection({
    recommendations: [recommendation],
    supportSets: [supportSet],
    candidates: [candidate],
    audits: [],
    contentByRecommendation: { [RECOMMENDATION]: PROPOSED_CONTENT },
  }, {
    stateRootIdentity,
    now: NOW,
    targetReader: () => ({ exists: true, content: CONTENT, hash: H(CONTENT) }),
    nonceFactory: () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, "0")}`,
  });
  return { contributionId, recommendation, supportSet, candidate, projection };
}

function projectionFixtureWithCount(count, stateRootIdentity = ROOT, detailRecommendationIds) {
  const recommendations = [];
  const supportSets = [];
  const candidates = [];
  const contentByRecommendation = {};
  for (let index = 0; index < count; index += 1) {
    const candidateId = H(`candidate:${index}`);
    const supportSetHash = H(`support:${index}`);
    const recommendationId = H(`recommendation:${index}`);
    const proposedContent = `${PROPOSED_CONTENT}\nEntry ${index}.\n`;
    recommendations.push({
      recommendationId,
      candidateId,
      supportSetHash,
      targetBinding: {
        targetKind: "existing-global-skill",
        logicalName: `durable-review-${String(index).padStart(3, "0")}`,
        relativePath: `durable-review-${index}/SKILL.md`,
        currentHash: H(CONTENT),
        bindingHash: H(`binding:${index}`),
      },
      proposedContentHash: H(proposedContent),
      rationaleText: "Independent support warrants one bounded global correction.",
      synthesizedAt: NOW - 1_000 - index,
      criticScore: 0.99,
      criticPassed: true,
      validDeterministic: true,
      state: "pending",
      decisionVersion: 0,
    });
    supportSets.push({
      supportSetHash,
      candidateId,
      contributionIds: [`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`],
      strongestSingleDomain: { independentIncidentCount: 2, occurrenceCount: 3 },
      distributed: { independentKnownDomainCount: 1, independentIncidentCount: 2 },
      firstSeenDay: "2026-08-01",
      lastSeenDay: "2026-08-11",
    });
    candidates.push({
      candidateId,
      supportSetHash,
      eligibilityRoute: "single-domain",
      independentDomainCount: 1,
      independentIncidentCount: 2,
      occurrenceCount: 3,
      updatedAt: NOW - index,
    });
    contentByRecommendation[recommendationId] = proposedContent;
  }
  const snapshot = { recommendations, supportSets, candidates, audits: [], contentByRecommendation };
  const projection = buildGlobalRecommendationProjection(snapshot, {
    stateRootIdentity,
    now: NOW,
    targetReader: () => ({ exists: true, content: CONTENT, hash: H(CONTENT) }),
    ...(detailRecommendationIds === undefined ? {} : { detailRecommendationIds }),
  });
  return { snapshot, recommendations, supportSets, candidates, projection };
}

function hashIndex(value) {
  const { indexHash: _indexHash, ...body } = value;
  return { ...body, indexHash: hashGlobalProtocol("recommendation-index", body) };
}

function hashDetail(value) {
  const { detailHash: _detailHash, ...body } = value;
  return { ...body, detailHash: hashGlobalProtocol("recommendation-detail", body) };
}

function hashGrant(value) {
  const { grantHash: _grantHash, ...body } = value;
  return { ...body, grantHash: hashGlobalProtocol("action-grant", body) };
}

function hashRequest(value) {
  const { requestHash: _requestHash, ...body } = value;
  return { ...body, requestHash: hashGlobalProtocol("action-request", body) };
}

function paddedJson(value, bytes) {
  const source = JSON.stringify(value);
  const width = Buffer.byteLength(source, "utf8");
  if (width > bytes) throw new Error(`fixture exceeds ${bytes} bytes`);
  return `${source}${" ".repeat(bytes - width)}`;
}

function writeGlobalRecord(stateRoot, directory, id, value) {
  const target = path.join(stateRoot, "self-evolve", "global", directory, id.slice(0, 2), `${id}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function seedRealGlobalRecommendations(stateRoot, actingProjectFingerprint, root) {
  const skillRoot = path.join(root, "global-skills");
  fs.mkdirSync(skillRoot, { recursive: true, mode: 0o700 });
  const values = [
    {
      logicalName: "process-apply-review",
      current: "---\nname: process-apply-review\ndescription: Apply process review.\n---\n\n# Apply Review\n",
      proposedSuffix: "\nVerify process failures before changing guidance.\n",
    },
    {
      logicalName: "process-reject-review",
      current: "---\nname: process-reject-review\ndescription: Reject process review.\n---\n\n# Reject Review\n",
      proposedSuffix: "\nThis recommendation will be rejected.\n",
    },
  ];
  for (const value of values) {
    value.targetPath = path.join(skillRoot, value.logicalName, "SKILL.md");
    value.proposed = value.current + value.proposedSuffix;
    fs.mkdirSync(path.dirname(value.targetPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(value.targetPath, value.current, { mode: 0o600 });
  }
  const setupStore = openStore(stateRoot, { projectFingerprint: actingProjectFingerprint, now: () => NOW });
  const approvedRoot = schemas.makeApprovedGlobalRoot({ canonicalPath: skillRoot, canUpdate: true, canCreate: false });
  const policy = schemas.makeGlobalRootPolicy({ roots: [approvedRoot], creationRootId: null, selectedBy: "operator", updatedAt: NOW });
  const updated = setupStore.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    globalRootPolicy: policy,
    consent: {
      ...global.consent,
      durableObservations: true,
      sanitizedExcerpts: true,
      crossRepoAggregation: true,
    },
    updatedAt: global.updatedAt + 1,
  }));
  assert.equal(updated.ok, true, updated.reason);
  const catalog = inventory.buildGlobalSkillCatalog(policy);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const signatureHash = inventory.hashSkillContent(`process-signature:${index}`);
    const incidentId = `process-incident-${index}`;
    const clusterId = inventory.hashSkillContent(`process-cluster:${index}`);
    const capsule = schemas.makeEvidenceCapsule({
      capsuleId: randomUUID(),
      incidentId,
      receiptType: "repeated-tool-error",
      targetLogicalName: value.logicalName,
      summary: "Process verification failed repeatedly with a deterministic error.",
      createdAt: NOW,
      expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
    });
    const observation = schemas.makeObservation({
      id: inventory.hashSkillContent(`process-observation:${index}`),
      projectFingerprint: actingProjectFingerprint,
      receiptIds: [signatureHash],
      structuredFields: {
        receiptType: "repeated-tool-error",
        scopeFingerprint: inventory.hashSkillContent(`process-scope:${index}`),
        occurrences: 3,
        deterministicOutcome: true,
        targetLogicalName: value.logicalName,
      },
      incidentId,
      sessionLineageHash: inventory.hashSkillContent(`process-session:${index}`),
      rootLineageHash: inventory.hashSkillContent(`process-root:${index}`),
      originKind: "user",
      createdAt: NOW,
      injectionFlagged: false,
      redacted: true,
    });
    const cluster = schemas.makeEvidenceCluster({
      id: clusterId,
      receiptType: "repeated-tool-error",
      projectFingerprint: actingProjectFingerprint,
      incidentIds: [incidentId],
      scopeFingerprint: observation.structuredFields.scopeFingerprint,
      targetLogicalName: value.logicalName,
      occurrencesSum: 3,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    assert.equal(setupStore.appendRecord(schemas.wrapRecord("observation", observation, NOW)).ok, true);
    assert.equal(setupStore.appendRecord(schemas.wrapRecord("evidence-cluster", cluster, NOW)).ok, true);
    assert.equal(setupStore.appendEvidenceCapsule(capsule).ok, true);
    const published = setupStore.publishContribution({
      claimType: "global-skill-candidate",
      receiptType: cluster.receiptType,
      signatureHash,
      incidentId,
      capsuleId: capsule.capsuleId,
      clusterId,
      evidenceDomainId: inventory.hashSkillContent(`process-domain:${index}`),
      occurrenceCount: 3,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    assert.equal(published.ok, true, published.reason);
    const secondIncidentId = `process-incident-${index}-second`;
    const secondClusterId = inventory.hashSkillContent(`process-cluster:${index}:second`);
    const secondCapsule = schemas.makeEvidenceCapsule({
      ...capsule,
      capsuleId: randomUUID(),
      incidentId: secondIncidentId,
    });
    const secondObservation = schemas.makeObservation({
      ...observation,
      id: inventory.hashSkillContent(`process-observation:${index}:second`),
      incidentId: secondIncidentId,
      sessionLineageHash: inventory.hashSkillContent(`process-session:${index}:second`),
      rootLineageHash: inventory.hashSkillContent(`process-root:${index}:second`),
    });
    const secondCluster = schemas.makeEvidenceCluster({
      ...cluster,
      id: secondClusterId,
      incidentIds: [secondIncidentId],
    });
    assert.equal(setupStore.appendRecord(schemas.wrapRecord("observation", secondObservation, NOW)).ok, true);
    assert.equal(setupStore.appendRecord(schemas.wrapRecord("evidence-cluster", secondCluster, NOW)).ok, true);
    assert.equal(setupStore.appendEvidenceCapsule(secondCapsule).ok, true);
    const secondPublished = setupStore.publishContribution({
      claimType: "global-skill-candidate",
      receiptType: secondCluster.receiptType,
      signatureHash,
      incidentId: secondIncidentId,
      capsuleId: secondCapsule.capsuleId,
      clusterId: secondClusterId,
      evidenceDomainId: inventory.hashSkillContent(`process-domain:${index}`),
      occurrenceCount: 3,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    assert.equal(secondPublished.ok, true, secondPublished.reason);
    const resolution = inventory.resolveGlobalSkillCandidate(value.logicalName, catalog);
    const preliminary = schemas.makeGlobalCandidate({
      claimType: "global-skill-candidate",
      receiptType: "repeated-tool-error",
      signatureHash,
      targetBindingHash: resolution.binding.bindingHash,
      supportSetHash: inventory.hashSkillContent(`preliminary-support:${index}`),
      state: "recommended",
      eligibilityRoute: "single-domain",
      independentDomainCount: 1,
      independentIncidentCount: 2,
      occurrenceCount: 6,
      firstSeenDay: "2026-08-11",
      lastSeenDay: "2026-08-11",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const support = schemas.makeGlobalSupportSet({
      candidateId: preliminary.candidateId,
      targetBinding: resolution.binding,
      contributionIds: [published.contribution.contributionId, secondPublished.contribution.contributionId],
      strongestSingleDomain: {
        lineageClass: "known",
        independentIncidentCount: 2,
        occurrenceCount: 6,
        nonUnknownUserRootLineageCount: 2,
        freshnessRatio: 1,
      },
      distributed: { independentKnownDomainCount: 1, independentIncidentCount: 2, unknownLineageCollapsed: false },
      integrity: { contradictionFree: true, injectionFree: true, chronologyValid: true, correlationValid: true },
      firstSeenDay: "2026-08-11",
      lastSeenDay: "2026-08-11",
      evaluatedAt: NOW,
      expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
    });
    const candidate = schemas.makeGlobalCandidate({ ...preliminary, supportSetHash: support.supportSetHash });
    const targetBinding = schemas.makeRecommendationTargetBinding({
      targetKind: resolution.binding.targetKind,
      rootId: resolution.binding.rootId,
      logicalName: resolution.binding.logicalName,
      relativePath: resolution.binding.relativePath,
      currentHash: resolution.binding.currentHash,
      catalogGenerationHash: resolution.binding.catalogGenerationHash,
      rootSetHash: resolution.binding.rootSetHash,
      candidateBindingHash: resolution.binding.bindingHash,
    }, resolution.binding, policy);
    const recommendation = schemas.makeGlobalRecommendation({
      candidateId: candidate.candidateId,
      supportSetHash: support.supportSetHash,
      candidateTargetBindingHash: resolution.binding.bindingHash,
      targetBinding,
      proposedContentHash: inventory.hashSkillContent(value.proposed),
      rationaleText: "Independent support warrants one process-tested correction.",
      synthesizedAt: NOW,
      synthesizerModelId: "no-provider/process-fixture",
      criticScore: 0.99,
      criticPassed: true,
      validDeterministic: true,
      state: "pending",
      decisionVersion: 0,
      burnedNonceHashes: [],
    });
    const content = schemas.makeGlobalRecommendationContent({
      recommendationId: recommendation.recommendationId,
      contentHash: recommendation.proposedContentHash,
      contentEncoding: "base64",
      chunkIndex: 0,
      chunkCount: 1,
      content: Buffer.from(value.proposed).toString("base64"),
    });
    writeGlobalRecord(stateRoot, "candidates", candidate.candidateId, candidate);
    writeGlobalRecord(stateRoot, "candidate-support", support.supportSetHash, support);
    writeGlobalRecord(stateRoot, "recommendations", recommendation.recommendationId, recommendation);
    const contentPath = path.join(
      stateRoot,
      "self-evolve",
      "global",
      "recommendation-content",
      recommendation.recommendationId.slice(0, 2),
      recommendation.recommendationId,
      "000000.json",
    );
    fs.mkdirSync(path.dirname(contentPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(contentPath, `${JSON.stringify(content)}\n`, { mode: 0o600 });
    value.recommendationId = recommendation.recommendationId;
  }
  const stateRootIdentity = setupStore.rootIdentity;
  setupStore.close();
  return { apply: values[0], reject: values[1], stateRootIdentity };
}

function contradictoryProjection(projection) {
  const originalDetail = projection.details[0];
  const { detailHash: _detailHash, ...detailBody } = originalDetail;
  const detailWithoutHash = {
    ...detailBody,
    support: { ...detailBody.support, occurrenceCount: detailBody.support.occurrenceCount + 1 },
    evidenceSummary: detailBody.evidenceSummary.map((entry) => entry.kind === "occurrences"
      ? { ...entry, count: entry.count + 1 }
      : entry),
  };
  const detail = {
    ...detailWithoutHash,
    detailHash: hashGlobalProtocol("recommendation-detail", detailWithoutHash),
  };
  const { indexHash: _indexHash, ...indexBody } = projection.index;
  const indexWithoutHash = {
    ...indexBody,
    recommendations: indexBody.recommendations.map((entry) => entry.recommendationId === detail.recommendationId
      ? { ...entry, detailHash: detail.detailHash }
      : entry),
  };
  const index = {
    ...indexWithoutHash,
    indexHash: hashGlobalProtocol("recommendation-index", indexWithoutHash),
  };
  const grants = projection.grants.map((originalGrant) => {
    const { grantHash: _grantHash, ...grantBody } = originalGrant;
    const grantWithoutHash = { ...grantBody, indexHash: index.indexHash, detailHash: detail.detailHash };
    return { ...grantWithoutHash, grantHash: hashGlobalProtocol("action-grant", grantWithoutHash) };
  });
  return { ...projection, index, details: [detail], grants };
}

function contradictoryGrantProjection(projection) {
  const grants = projection.grants.map((originalGrant, index) => {
    if (index !== 0) return originalGrant;
    const { grantHash: _grantHash, ...grantBody } = originalGrant;
    const grantWithoutHash = { ...grantBody, targetHash: H("contradictory-grant-target") };
    return { ...grantWithoutHash, grantHash: hashGlobalProtocol("action-grant", grantWithoutHash) };
  });
  return { ...projection, grants };
}

test("global protocol records are exact, bounded, identity-free, and independently negotiated", () => {
  const offer = globalOffer();
  assert.deepEqual(negotiateGlobalProtocol(offer, offer), {
    mode: "native",
    label: "authoritative-global-v1",
    bridgeSchemaVersion: 1,
    projectionVersion: 1,
    operationProtocolVersion: 1,
    capabilities: GLOBAL_CAPABILITIES,
    reason: null,
  });
  assert.equal(negotiateGlobalProtocol(null, offer).label, "limited-new-tui-old-server");
  assert.equal(negotiateGlobalProtocol(offer, null).label, "limited-old-tui-new-server");
  for (const capability of REQUIRED_GLOBAL_WRITE_CAPABILITIES) {
    const limitedClient = negotiateGlobalProtocol(offer, {
      ...offer,
      capabilities: offer.capabilities.filter((value) => value !== capability),
    });
    const limitedServer = negotiateGlobalProtocol({
      ...offer,
      capabilities: offer.capabilities.filter((value) => value !== capability),
    }, offer);
    for (const limited of [limitedClient, limitedServer]) {
      assert.equal(limited.mode, "limited", capability);
      assert.equal(limited.label, "limited-incompatible-global-protocol", capability);
      assert.deepEqual(limited.capabilities, [], capability);
    }
  }
  assert.equal(negotiateGlobalProtocol(offer, {
    ...offer,
    capabilities: offer.capabilities.filter((value) => value !== "project-analysis-control-v1"),
  }).mode, "native", "project analysis control is not global write authority");

  const indexValue = globalIndex();
  const index = makeGlobalRecommendationIndex(indexValue, {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    now: NOW,
    supportedCapabilities: GLOBAL_CAPABILITIES,
  });
  assert.equal(index.recommendations[0].target.label, "durable-review");
  assert.equal(Buffer.byteLength(JSON.stringify(index)), Buffer.byteLength(JSON.stringify(indexValue)));
  for (const forbidden of [
    "sourceproject", "actingproject", "consumerproject", "projectfingerprint", "contributorid",
    "capsuleid", "clusterid", "observationid", "sessionid", "localincidentid", "excerpt",
  ]) {
    assert.doesNotMatch(JSON.stringify(index).toLowerCase(), new RegExp(forbidden, "u"));
  }
  assert.throws(() => makeGlobalRecommendationIndex({ ...indexValue, sourceProjectFingerprint: PROJECT }, {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    now: NOW,
    supportedCapabilities: GLOBAL_CAPABILITIES,
  }), /unknown-field/u);

  const detailValue = globalDetail();
  const detail = makeGlobalRecommendationDetail(detailValue, {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    detailHash: detailValue.detailHash,
    now: NOW,
  });
  assert.equal(detail.evidenceSummary[0].count, 2);
  assert.deepEqual(detail.generality, { passed: true, basis: "deterministic-generality-gate-v1" });
  for (const invalidGenerality of [
    undefined,
    { passed: false, basis: "deterministic-generality-gate-v1" },
    { passed: true, basis: "model-score" },
    { passed: true, basis: "deterministic-generality-gate-v1", score: 1 },
  ]) {
    const { detailHash: _detailHash, ...body } = globalDetail();
    if (invalidGenerality === undefined) delete body.generality;
    else body.generality = invalidGenerality;
    const invalid = { ...body, detailHash: hashGlobalProtocol("recommendation-detail", body) };
    assert.throws(() => makeGlobalRecommendationDetail(invalid, {
      stateRootIdentity: ROOT,
      generation: GENERATION,
      recommendationId: RECOMMENDATION,
      recommendationVersion: 1,
      detailHash: invalid.detailHash,
      now: NOW,
    }), /generality|unknown-field/u);
  }
  assert.throws(() => makeGlobalRecommendationDetail({ ...detailValue, excerpt: "private" }, {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    detailHash: detailValue.detailHash,
    now: NOW,
  }), /unknown-field/u);

  const grantBody = {
    grantVersion: 1,
    capability: "global-action-grant-v1",
    stateRootIdentity: ROOT,
    generation: GENERATION,
    indexHash: index.indexHash,
    detailHash: detail.detailHash,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    supportSetHash: SUPPORT,
    targetBindingHash: BINDING,
    targetHash: CURRENT,
    proposedContentHash: PROPOSED,
    priorState: "pending",
    action: "apply",
    nonce: randomUUID(),
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  };
  const grant = makeGlobalActionGrant({ ...grantBody, grantHash: hashGlobalProtocol("action-grant", grantBody) }, {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    indexHash: index.indexHash,
    detailHash: detail.detailHash,
    now: NOW,
  });
  const requestBody = {
    protocolVersion: GLOBAL_OPERATION_PROTOCOL_VERSION,
    capability: "global-action-request-v1",
    requestId: randomUUID(),
    stateRootIdentity: ROOT,
    actingProjectFingerprint: PROJECT,
    actingHealthHash: HEALTH,
    projectionGenerationHash: GENERATION,
    indexHash: index.indexHash,
    detailHash: detail.detailHash,
    grantHash: grant.grantHash,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    supportSetHash: SUPPORT,
    targetBindingHash: BINDING,
    targetHash: CURRENT,
    proposedContentHash: PROPOSED,
    priorState: "pending",
    action: "apply",
    actorRole: "operator",
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
    nonce: grant.nonce,
  };
  const request = makeGlobalActionRequestEnvelope({
    ...requestBody,
    requestHash: hashGlobalProtocol("action-request", requestBody),
  }, { now: NOW, stateRootIdentity: ROOT, grant });
  assert.equal(request.grantHash, grant.grantHash);
  assert.throws(() => makeGlobalActionRequestEnvelope({ ...request, nonce: randomUUID() }, {
    now: NOW,
    stateRootIdentity: ROOT,
    grant,
  }), /nonce|hash/u);

  const sidecarBody = {
    participationVersion: 1,
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    indexHash: index.indexHash,
    recommendationId: RECOMMENDATION,
    supportSetHash: SUPPORT,
    currentProjectContributed: true,
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.projectionTtlMs,
  };
  const sidecar = makeProjectParticipationSidecar({
    ...sidecarBody,
    participationHash: hashGlobalProtocol("project-participation", sidecarBody),
  }, {
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    indexHash: index.indexHash,
    recommendationId: RECOMMENDATION,
    supportSetHash: SUPPORT,
    now: NOW,
  });
  assert.deepEqual(Object.keys(sidecar).sort(), [...Object.keys(sidecarBody), "participationHash"].sort());
});

test("global index accepts exactly the maximum entry count and rejects max plus one", () => {
  const fixture = projectionFixtureWithCount(GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries);
  assert.equal(fixture.projection.index.recommendations.length, GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries);
  assert.equal(makeGlobalRecommendationIndex(fixture.projection.index, {
    stateRootIdentity: ROOT,
    generation: fixture.projection.index.generation,
    now: NOW,
    supportedCapabilities: GLOBAL_CAPABILITIES,
  }).recommendations.length, GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries);

  const last = fixture.projection.index.recommendations.at(-1);
  const over = hashIndex({
    ...fixture.projection.index,
    recommendations: [
      ...fixture.projection.index.recommendations,
      {
        ...last,
        recommendationId: H("index-max-plus-one"),
        supportSetHash: H("index-max-plus-one-support"),
        detailHash: H("index-max-plus-one-detail"),
        dates: { ...last.dates, synthesizedAt: last.dates.synthesizedAt - 1, updatedAt: last.dates.updatedAt - 1 },
      },
    ],
    overflow: {
      truncated: false,
      includedCount: GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries + 1,
      omittedCount: 0,
      omittedBytes: 0,
      reason: "none",
    },
  });
  assert.throws(() => makeGlobalRecommendationIndex(over, {
    stateRootIdentity: ROOT,
    generation: over.generation,
    now: NOW,
    supportedCapabilities: GLOBAL_CAPABILITIES,
  }), /global-recommendations-out-of-bounds/u);
});

test("global detail UTF-8 rationale and diff byte limits accept max and reject max plus one", () => {
  const rationaleAtMax = "é".repeat(GLOBAL_PROTOCOL_LIMITS.rationaleBytes / 2);
  const diffAtMax = Array.from({ length: GLOBAL_PROTOCOL_LIMITS.diffBytes / 1024 }, () => "é".repeat(512));
  const exact = hashDetail({
    ...globalDetail(),
    rationale: rationaleAtMax,
    diff: {
      kind: "unified",
      lines: diffAtMax,
      overflow: { truncated: false, includedCount: diffAtMax.length, omittedCount: 0, omittedBytes: 0, reason: "none" },
    },
  });
  assert.equal(Buffer.byteLength(exact.rationale, "utf8"), GLOBAL_PROTOCOL_LIMITS.rationaleBytes);
  assert.equal(exact.diff.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line, "utf8"), 0), GLOBAL_PROTOCOL_LIMITS.diffBytes);
  assert.equal(makeGlobalRecommendationDetail(exact, {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    detailHash: exact.detailHash,
    now: NOW,
  }).detailHash, exact.detailHash);

  const rationaleOver = hashDetail({ ...exact, rationale: `${rationaleAtMax}a` });
  assert.throws(() => makeGlobalRecommendationDetail(rationaleOver, {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    detailHash: rationaleOver.detailHash,
    now: NOW,
  }), /global-rationale-out-of-bounds/u);
  const diffOverLines = [...diffAtMax, "a"];
  const diffOver = hashDetail({
    ...exact,
    diff: {
      ...exact.diff,
      lines: diffOverLines,
      overflow: { truncated: false, includedCount: diffOverLines.length, omittedCount: 0, omittedBytes: 0, reason: "none" },
    },
  });
  assert.throws(() => makeGlobalRecommendationDetail(diffOver, {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    detailHash: diffOver.detailHash,
    now: NOW,
  }), /global-diff-bytes-out-of-bounds/u);
});

test("global action request binding matrix rejects every stale cross-root and mismatched field", async (t) => {
  const detail = globalDetail();
  const index = globalIndex({ recommendations: [{ ...globalIndex().recommendations[0], detailHash: detail.detailHash }] });
  const grantBody = {
    grantVersion: 1,
    capability: "global-action-grant-v1",
    stateRootIdentity: ROOT,
    generation: GENERATION,
    indexHash: index.indexHash,
    detailHash: detail.detailHash,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    supportSetHash: SUPPORT,
    targetBindingHash: BINDING,
    targetHash: CURRENT,
    proposedContentHash: PROPOSED,
    priorState: "pending",
    action: "apply",
    nonce: randomUUID(),
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  };
  const grant = makeGlobalActionGrant(hashGrant(grantBody), {
    stateRootIdentity: ROOT,
    generation: GENERATION,
    indexHash: index.indexHash,
    detailHash: detail.detailHash,
    now: NOW,
  });
  const body = {
    protocolVersion: GLOBAL_OPERATION_PROTOCOL_VERSION,
    capability: "global-action-request-v1",
    requestId: randomUUID(),
    stateRootIdentity: ROOT,
    actingProjectFingerprint: PROJECT,
    actingHealthHash: HEALTH,
    projectionGenerationHash: GENERATION,
    indexHash: index.indexHash,
    detailHash: detail.detailHash,
    grantHash: grant.grantHash,
    recommendationId: RECOMMENDATION,
    recommendationVersion: 1,
    supportSetHash: SUPPORT,
    targetBindingHash: BINDING,
    targetHash: CURRENT,
    proposedContentHash: PROPOSED,
    priorState: "pending",
    action: "apply",
    actorRole: "operator",
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
    nonce: grant.nonce,
  };
  const request = hashRequest(body);
  const cases = [
    ["cross root", { stateRootIdentity: H("wrong-root") }, /cross-root/u],
    ["generation", { projectionGenerationHash: H("wrong-generation") }, /global-request-grant-mismatch/u],
    ["index hash", { indexHash: H("wrong-index") }, /global-request-grant-mismatch/u],
    ["detail hash", { detailHash: H("wrong-detail") }, /global-request-grant-mismatch/u],
    ["recommendation", { recommendationId: H("wrong-recommendation") }, /global-request-grant-mismatch/u],
    ["version", { recommendationVersion: 2 }, /global-request-grant-mismatch/u],
    ["support", { supportSetHash: H("wrong-support") }, /global-request-grant-mismatch/u],
    ["target binding", { targetBindingHash: H("wrong-binding") }, /global-request-grant-mismatch/u],
    ["target", { targetHash: H("wrong-target") }, /global-request-grant-mismatch/u],
    ["content", { proposedContentHash: H("wrong-content") }, /global-request-grant-mismatch/u],
    ["prior state", { priorState: "applied" }, /global-request-grant-mismatch/u],
    ["action", { action: "undo" }, /global-request-grant-mismatch/u],
    ["protocol version", { protocolVersion: 2 }, /unsupported-global-operation-version/u],
    ["expiry", { expiresAt: NOW }, /invalid-global-request-lifetime/u],
  ];
  for (const [name, change, expected] of cases) {
    await t.test(name, () => {
      const changed = hashRequest({ ...request, ...change });
      assert.throws(() => makeGlobalActionRequestEnvelope(changed, { now: NOW, stateRootIdentity: ROOT, grant }), expected);
    });
  }
  await t.test("request hash", () => {
    assert.throws(() => makeGlobalActionRequestEnvelope({ ...request, requestId: randomUUID() }, {
      now: NOW,
      stateRootIdentity: ROOT,
      grant,
    }), /global-request-hash-mismatch/u);
  });
});

test("global projection and project participation builders keep identity scopes separate", () => {
  const { contributionId, recommendation, supportSet, projection } = projectionFixture();

  assert.equal(projection.index.recommendations.length, 1);
  assert.equal(projection.details.length, 1);
  assert.deepEqual(projection.details[0].generality, {
    passed: true,
    basis: "deterministic-generality-gate-v1",
  });
  assert.deepEqual(projection.details[0].availableActions, ["apply", "reject"]);
  assert.equal(projection.grants.length, 2);
  assert.equal(projection.grants.every((grant) => grant.indexHash === projection.index.indexHash), true);
  assert.equal(projection.details.length <= GLOBAL_PROTOCOL_LIMITS.residentDetails, true);
  assert.doesNotMatch(JSON.stringify(projection.index), new RegExp(PROJECT, "u"));

  const sidecarsA = buildProjectParticipationSidecars({
    index: projection.index,
    recommendations: [recommendation],
    supportSets: [supportSet],
    contributionLinks: [{ contributionId, state: "active" }],
  }, { projectFingerprint: PROJECT, stateRootIdentity: ROOT, now: NOW });
  const projectB = H("project-b");
  const sidecarsB = buildProjectParticipationSidecars({
    index: projection.index,
    recommendations: [recommendation],
    supportSets: [supportSet],
    contributionLinks: [],
  }, { projectFingerprint: projectB, stateRootIdentity: ROOT, now: NOW });
  assert.equal(sidecarsA[0].currentProjectContributed, true);
  assert.equal(sidecarsB[0].currentProjectContributed, false);
  for (const field of ["stateRootIdentity", "generation", "indexHash", "recommendationId", "supportSetHash"]) {
    assert.equal(sidecarsA[0][field], sidecarsB[0][field]);
  }
  assert.equal("contributorIds" in sidecarsA[0], false);
});

test("global detail grant and sidecar collections accept exact maxima and reject max plus one", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-collection-bounds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => store.close());
  const fixture = projectionFixtureWithCount(3, store.rootIdentity);
  assert.equal(fixture.projection.details.length, GLOBAL_PROTOCOL_LIMITS.residentDetails);
  assert.equal(fixture.projection.grants.length, GLOBAL_PROTOCOL_LIMITS.residentDetails * 2);
  publishGlobalRecommendationProjection(root, fixture.projection, { store, expectedGeneration: null, now: NOW });

  const third = buildGlobalRecommendationProjection(fixture.snapshot, {
    stateRootIdentity: store.rootIdentity,
    now: NOW,
    targetReader: () => ({ exists: true, content: CONTENT, hash: H(CONTENT) }),
    detailRecommendationIds: [fixture.projection.index.recommendations[2].recommendationId],
  });
  assert.throws(() => publishGlobalRecommendationProjection(root, {
    ...fixture.projection,
    details: [...fixture.projection.details, ...third.details],
    grants: [...fixture.projection.grants, ...third.grants],
  }, { store, expectedGeneration: fixture.projection.index.generation, now: NOW }), /global-resident-details-out-of-bounds/u);

  const duplicateGrant = hashGrant({
    ...fixture.projection.grants[0],
    nonce: randomUUID(),
  });
  assert.throws(() => publishGlobalRecommendationProjection(root, {
    ...fixture.projection,
    grants: [...fixture.projection.grants, duplicateGrant],
  }, { store, expectedGeneration: fixture.projection.index.generation, now: NOW }), /global-grants-out-of-bounds/u);

  const sidecarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-sidecar-bounds-"));
  t.after(() => fs.rmSync(sidecarRoot, { recursive: true, force: true }));
  const sidecarStore = openStore(sidecarRoot, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => sidecarStore.close());
  const maximum = projectionFixtureWithCount(GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries, sidecarStore.rootIdentity);
  publishGlobalRecommendationProjection(sidecarRoot, maximum.projection, { store: sidecarStore, expectedGeneration: null, now: NOW });
  const sidecars = buildProjectParticipationSidecars({
    index: maximum.projection.index,
    recommendations: maximum.recommendations,
    supportSets: maximum.supportSets,
    contributionLinks: [],
  }, { projectFingerprint: PROJECT, stateRootIdentity: sidecarStore.rootIdentity, now: NOW });
  assert.equal(sidecars.length, GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries);
  assert.equal(publishProjectParticipationSidecars(sidecarRoot, PROJECT, sidecars, { now: NOW }).length, GLOBAL_PROTOCOL_LIMITS.recommendationIndexEntries);
  assert.throws(() => publishProjectParticipationSidecars(sidecarRoot, PROJECT, [...sidecars, sidecars[0]], { now: NOW }), /project-participation-out-of-bounds/u);
});

test("publication and readback reject contradictory hash-valid index detail and grants", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => store.close());
  const { projection } = projectionFixture(store.rootIdentity);
  const contradictory = contradictoryProjection(projection);

  assert.throws(() => publishGlobalRecommendationProjection(root, contradictory, {
    store,
    expectedGeneration: null,
    now: NOW,
  }), /global-detail-index-mismatch/u);

  publishGlobalRecommendationProjection(root, projection, { store, expectedGeneration: null, now: NOW });
  const globalRoot = path.join(root, "self-evolve", "bridge", "global");
  const generationRoot = path.join(globalRoot, "generations", projection.index.generation);
  fs.writeFileSync(path.join(globalRoot, "index.json"), `${JSON.stringify(contradictory.index)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(generationRoot, "details", `${contradictory.details[0].recommendationId}.json`),
    `${JSON.stringify(contradictory.details[0])}\n`,
    { mode: 0o600 },
  );
  const grantsRoot = path.join(generationRoot, "grants");
  for (const entry of fs.readdirSync(grantsRoot)) fs.rmSync(path.join(grantsRoot, entry));
  for (const grant of contradictory.grants) {
    fs.writeFileSync(path.join(grantsRoot, `${grant.grantHash}.json`), `${JSON.stringify(grant)}\n`, { mode: 0o600 });
  }

  assert.throws(() => readGlobalRecommendationProjection(root, { now: NOW }), /global-detail-index-mismatch/u);
});

test("publication and readback reject contradictory hash-valid grant semantics", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-grant-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => store.close());
  const { projection } = projectionFixture(store.rootIdentity);
  const contradictory = contradictoryGrantProjection(projection);

  assert.throws(() => publishGlobalRecommendationProjection(root, contradictory, {
    store,
    expectedGeneration: null,
    now: NOW,
  }), /global-grant-detail-mismatch/u);

  publishGlobalRecommendationProjection(root, projection, { store, expectedGeneration: null, now: NOW });
  const grantsRoot = path.join(
    root,
    "self-evolve",
    "bridge",
    "global",
    "generations",
    projection.index.generation,
    "grants",
  );
  for (const entry of fs.readdirSync(grantsRoot)) fs.rmSync(path.join(grantsRoot, entry));
  for (const grant of contradictory.grants) {
    fs.writeFileSync(path.join(grantsRoot, `${grant.grantHash}.json`), `${JSON.stringify(grant)}\n`, { mode: 0o600 });
  }

  assert.throws(() => readGlobalRecommendationProjection(root, { now: NOW }), /global-grant-detail-mismatch/u);
});

test("global index detail grant and sidecar files accept exact byte caps and reject one byte beyond", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-file-byte-bounds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => store.close());
  const { contributionId, recommendation, supportSet, projection } = projectionFixture(store.rootIdentity);
  publishGlobalRecommendationProjection(root, projection, { store, expectedGeneration: null, now: NOW });
  const globalRoot = path.join(root, "self-evolve", "bridge", "global");
  const generationRoot = path.join(globalRoot, "generations", projection.index.generation);
  const indexPath = path.join(globalRoot, "index.json");
  const detail = projection.details[0];
  const detailPath = path.join(generationRoot, "details", `${detail.recommendationId}.json`);
  const grant = projection.grants[0];
  const grantPath = path.join(generationRoot, "grants", `${grant.grantHash}.json`);

  for (const [label, filePath, value, bytes] of [
    ["index", indexPath, projection.index, GLOBAL_PROTOCOL_LIMITS.indexBytes],
    ["detail", detailPath, detail, GLOBAL_PROTOCOL_LIMITS.detailBytes],
    ["grant", grantPath, grant, GLOBAL_PROTOCOL_LIMITS.grantBytes],
  ]) {
    fs.writeFileSync(filePath, paddedJson(value, bytes));
    assert.equal(readGlobalRecommendationProjection(root, { now: NOW }).index.indexHash, projection.index.indexHash, `${label} exact max`);
    fs.writeFileSync(filePath, paddedJson(value, bytes + 1));
    assert.throws(() => readGlobalRecommendationProjection(root, { now: NOW }), /oversized/u, `${label} max plus one`);
    fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
  }

  const sidecars = buildProjectParticipationSidecars({
    index: projection.index,
    recommendations: [recommendation],
    supportSets: [supportSet],
    contributionLinks: [{ contributionId, state: "active" }],
  }, { projectFingerprint: PROJECT, stateRootIdentity: store.rootIdentity, now: NOW });
  publishProjectParticipationSidecars(root, PROJECT, sidecars, { now: NOW });
  const sidecarPath = path.join(root, "self-evolve", "bridge", PROJECT, "global-participation", `${recommendation.recommendationId}.json`);
  fs.writeFileSync(sidecarPath, paddedJson(sidecars[0], GLOBAL_PROTOCOL_LIMITS.grantBytes));
  assert.equal(readProjectParticipationSidecar(root, PROJECT, recommendation.recommendationId, { now: NOW }).participationHash, sidecars[0].participationHash);
  fs.writeFileSync(sidecarPath, paddedJson(sidecars[0], GLOBAL_PROTOCOL_LIMITS.grantBytes + 1));
  assert.throws(() => readProjectParticipationSidecar(root, PROJECT, recommendation.recommendationId, { now: NOW }), /oversized/u);
});

test("global publication is CAS-leased and byte-identical while project sidecars stay local", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectB = H("project-b");
  const storeA = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  const storeB = openStore(root, { projectFingerprint: projectB, now: () => NOW });
  t.after(() => { storeA.close(); storeB.close(); });
  assert.deepEqual(storeA.readGlobalProjectionSnapshot(), {
    recommendations: [],
    supportSets: [],
    candidates: [],
    audits: [],
    contentByRecommendation: {},
  });
  const { contributionId, recommendation, supportSet, projection } = projectionFixture(storeA.rootIdentity);

  const published = publishGlobalRecommendationProjection(root, projection, {
    store: storeA,
    expectedGeneration: null,
    now: NOW,
  });
  assert.equal(published.index.indexHash, projection.index.indexHash);
  const readA = readGlobalRecommendationProjection(root, { now: NOW });
  const readB = readGlobalRecommendationProjection(root, { now: NOW });
  assert.equal(readA.mode, "native");
  assert.equal(readA.indexBytes, readB.indexBytes);
  assert.equal(readA.details.length <= GLOBAL_PROTOCOL_LIMITS.residentDetails, true);
  assert.deepEqual(readA.details[0].generality, {
    passed: true,
    basis: "deterministic-generality-gate-v1",
  });
  assert.equal(readA.grants.length, 2);
  const generalityLimited = readGlobalRecommendationProjection(root, {
    now: NOW,
    clientOffer: {
      ...globalOffer(),
      capabilities: GLOBAL_CAPABILITIES.filter((value) => value !== "global-generality-v1"),
    },
  });
  assert.equal(generalityLimited.mode, "limited");
  assert.equal(generalityLimited.index, null);
  assert.deepEqual(generalityLimited.details, []);
  assert.deepEqual(generalityLimited.grants, []);
  const transactionLimited = readGlobalRecommendationProjection(root, {
    now: NOW,
    clientOffer: {
      ...globalOffer(),
      capabilities: GLOBAL_CAPABILITIES.filter((value) => value !== "global-transaction-v1"),
    },
  });
  assert.equal(transactionLimited.mode, "limited");
  assert.equal(transactionLimited.index, null);
  assert.deepEqual(transactionLimited.grants, []);

  assert.throws(() => publishGlobalRecommendationProjection(root, projection, {
    store: storeB,
    expectedGeneration: H("stale-generation"),
    now: NOW,
  }), /stale-global-projection-cas/u);

  const sidecarsA = buildProjectParticipationSidecars({
    index: readA.index,
    recommendations: [recommendation],
    supportSets: [supportSet],
    contributionLinks: [{ contributionId, state: "active" }],
  }, { projectFingerprint: PROJECT, stateRootIdentity: storeA.rootIdentity, now: NOW });
  const sidecarsB = buildProjectParticipationSidecars({
    index: readB.index,
    recommendations: [recommendation],
    supportSets: [supportSet],
    contributionLinks: [],
  }, { projectFingerprint: projectB, stateRootIdentity: storeB.rootIdentity, now: NOW });
  publishProjectParticipationSidecars(root, PROJECT, sidecarsA, { now: NOW });
  publishProjectParticipationSidecars(root, projectB, sidecarsB, { now: NOW });
  assert.equal(readProjectParticipationSidecar(root, PROJECT, RECOMMENDATION, { now: NOW }).currentProjectContributed, true);
  assert.equal(readProjectParticipationSidecar(root, projectB, RECOMMENDATION, { now: NOW }).currentProjectContributed, false);
  const participationA = readProjectParticipationSidecars(root, PROJECT, { now: NOW });
  const participationB = readProjectParticipationSidecars(root, projectB, { now: NOW });
  assert.equal(participationA.indexHash, readA.index.indexHash);
  assert.equal(participationB.indexHash, readB.index.indexHash);
  assert.deepEqual(participationA.entries.map((entry) => entry.currentProjectContributed), [true]);
  assert.deepEqual(participationB.entries.map((entry) => entry.currentProjectContributed), [false]);
  assert.equal(Object.isFrozen(participationA.entries), true);

  const globalBytes = fs.readFileSync(path.join(root, "self-evolve", "bridge", "global", "index.json"));
  assert.equal(globalBytes.toString("utf8"), readA.indexBytes);
  assert.doesNotMatch(globalBytes.toString("utf8"), new RegExp(PROJECT, "u"));
  assert.doesNotMatch(globalBytes.toString("utf8"), new RegExp(projectB, "u"));
});

test("a different project consumer leases one global request and validates acting TUI health", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-mailbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectB = H("consumer-project");
  const storeA = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  const storeB = openStore(root, { projectFingerprint: projectB, now: () => NOW + 1 });
  t.after(() => { storeA.close(); storeB.close(); });
  const { projection } = projectionFixture(storeA.rootIdentity);
  publishGlobalRecommendationProjection(root, projection, { store: storeA, expectedGeneration: null, now: NOW });
  const global = readGlobalRecommendationProjection(root, { now: NOW });
  const grant = global.grants.find((value) => value.action === "reject");
  const health = publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: storeA.rootIdentity,
    hostVersion: "0.3.0",
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  });
  assert.equal(hashTuiHostHealth(health), hashTuiHostHealth({ ...health }));
  const request = createGlobalActionRequest({
    grant,
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  submitGlobalActionRequest(root, request);

  let effects = 0;
  let releaseEffect;
  const effectGate = new Promise((resolve) => { releaseEffect = resolve; });
  const first = consumeGlobalActionRequests({
    stateRoot: root,
    consumerProjectFingerprint: projectB,
    consumerInstanceId: randomUUID(),
    store: storeB,
    now: () => NOW + 1,
    consumerBootValidated: true,
    validateAndDecide: async (value, authority) => {
      effects += 1;
      assert.equal(value.actingProjectFingerprint, PROJECT);
      assert.equal(authority.consumerClaim.consumerProjectFingerprint, projectB);
      await effectGate;
      return { ok: true };
    },
  });
  const contender = consumeGlobalActionRequests({
    stateRoot: root,
    consumerProjectFingerprint: PROJECT,
    consumerInstanceId: randomUUID(),
    store: storeA,
    now: () => NOW + 1,
    consumerBootValidated: true,
    validateAndDecide: async () => { effects += 1; return { ok: true }; },
  });
  const contested = await contender;
  assert.equal(contested.ok, false);
  assert.equal(contested.reason, "global-lease-busy");
  releaseEffect();
  const consumed = await first;
  assert.equal(consumed.ok, true);
  assert.equal(consumed.processed.length, 1);
  assert.equal(effects, 1);
  assert.equal(pollGlobalActionResponse(root, request, { now: NOW + 1 }).ok, true);
  assert.throws(() => submitGlobalActionRequest(root, { ...request, requestId: randomUUID() }), /hash|nonce|response|replay/u);
  const replay = createGlobalActionRequest({
    grant,
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  assert.throws(() => submitGlobalActionRequest(root, replay), /nonce|replay/u);

  const secondGrant = global.grants.find((value) => value.action === "apply");
  const staleRequest = createGlobalActionRequest({
    grant: secondGrant,
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  submitGlobalActionRequest(root, staleRequest);
  assert.equal(revokeTuiHostHealth(root, PROJECT, {
    nonce: health.nonce,
    stateRootIdentity: storeA.rootIdentity,
  }), true);
  const stale = await consumeGlobalActionRequests({
    stateRoot: root,
    consumerProjectFingerprint: projectB,
    consumerInstanceId: randomUUID(),
    store: storeB,
    now: () => NOW + 2,
    consumerBootValidated: true,
    validateAndDecide: async () => { effects += 1; return { ok: true }; },
  });
  assert.equal(stale.processed[0].ok, false);
  assert.match(stale.processed[0].reason, /health/u);
  const staleResponse = pollGlobalActionResponse(root, staleRequest, { now: NOW + 2 });
  assert.equal(staleResponse.ok, false);
  assert.match(staleResponse.reason, /health/u);
  assert.equal(effects, 1);
  const cleanup = cleanupBridge(root, projectB, { now: NOW + BRIDGE_TTL_MS + 3 });
  assert.equal(cleanup.ok, true);
  assert.equal(pollGlobalActionResponse(root, request, { now: NOW + BRIDGE_TTL_MS + 3 }), null);
  assert.equal(pollGlobalActionResponse(root, staleRequest, { now: NOW + BRIDGE_TTL_MS + 3 }), null);
});

test("global action request files accept the exact byte cap and reject one byte beyond", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-request-byte-bounds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const consumerProject = H("request-byte-consumer");
  const storeA = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  const storeB = openStore(root, { projectFingerprint: consumerProject, now: () => NOW + 1 });
  t.after(() => { storeA.close(); storeB.close(); });
  const { projection } = projectionFixture(storeA.rootIdentity);
  publishGlobalRecommendationProjection(root, projection, { store: storeA, expectedGeneration: null, now: NOW });
  const projected = readGlobalRecommendationProjection(root, { now: NOW });
  const health = publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: storeA.rootIdentity,
    hostVersion: "0.3.0",
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  });
  const exactRequest = createGlobalActionRequest({
    grant: projected.grants.find((value) => value.action === "reject"),
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  const exactSubmission = submitGlobalActionRequest(root, exactRequest);
  fs.writeFileSync(exactSubmission.path, paddedJson(exactRequest, GLOBAL_PROTOCOL_LIMITS.operationBytes));
  const exact = await consumeGlobalActionRequests({
    stateRoot: root,
    consumerProjectFingerprint: consumerProject,
    consumerInstanceId: randomUUID(),
    store: storeB,
    now: () => NOW + 1,
    consumerBootValidated: true,
    validateAndDecide: async () => ({ ok: true }),
  });
  assert.equal(exact.processed[0].ok, true);

  const overRequest = createGlobalActionRequest({
    grant: projected.grants.find((value) => value.action === "apply"),
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  const overSubmission = submitGlobalActionRequest(root, overRequest);
  fs.writeFileSync(overSubmission.path, paddedJson(overRequest, GLOBAL_PROTOCOL_LIMITS.operationBytes + 1));
  const over = await consumeGlobalActionRequests({
    stateRoot: root,
    consumerProjectFingerprint: consumerProject,
    consumerInstanceId: randomUUID(),
    store: storeB,
    now: () => NOW + 1,
    consumerBootValidated: true,
    validateAndDecide: async () => ({ ok: true }),
  });
  assert.equal(over.processed[0].ok, false);
  assert.match(over.processed[0].reason, /oversized/u);
});

test("global mailbox rejects missing grants and mismatched acting identity or health", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-mailbox-negative-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const consumerProject = H("negative-consumer-project");
  const storeA = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  const storeB = openStore(root, { projectFingerprint: consumerProject, now: () => NOW + 1 });
  t.after(() => { storeA.close(); storeB.close(); });
  const { projection } = projectionFixture(storeA.rootIdentity);
  publishGlobalRecommendationProjection(root, projection, { store: storeA, expectedGeneration: null, now: NOW });
  const projected = readGlobalRecommendationProjection(root, { now: NOW });
  const health = publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: storeA.rootIdentity,
    hostVersion: "0.3.0",
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  });
  const applyRequest = createGlobalActionRequest({
    grant: projected.grants.find((value) => value.action === "apply"),
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  assert.throws(() => submitGlobalActionRequest(root, hashRequest({
    ...applyRequest,
    grantHash: H("missing-grant"),
  })), /global-grant-unavailable/u);

  const wrongActingProject = H("wrong-acting-project");
  const identityRequest = hashRequest({
    ...createGlobalActionRequest({
      grant: projected.grants.find((value) => value.action === "reject"),
      actingProjectFingerprint: PROJECT,
      actingHealth: health,
      timestamp: NOW,
      requestId: randomUUID(),
    }),
    actingProjectFingerprint: wrongActingProject,
  });
  const healthRequest = hashRequest({ ...applyRequest, actingHealthHash: H("wrong-health") });
  submitGlobalActionRequest(root, identityRequest);
  submitGlobalActionRequest(root, healthRequest);
  let effects = 0;
  const consumed = await consumeGlobalActionRequests({
    stateRoot: root,
    consumerProjectFingerprint: consumerProject,
    consumerInstanceId: randomUUID(),
    store: storeB,
    now: () => NOW + 1,
    consumerBootValidated: true,
    validateAndDecide: async () => { effects += 1; return { ok: true }; },
  });
  assert.equal(consumed.processed.length, 2);
  assert.equal(consumed.processed.every((value) => value.ok === false), true);
  assert.equal(consumed.processed.some((value) => /missing-acting-project-health/u.test(value.reason)), true);
  assert.equal(consumed.processed.some((value) => /stale-acting-project-health/u.test(value.reason)), true);
  assert.equal(effects, 0);
});

test("global mailbox accepts exactly 64 pending requests and rejects request 65", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-mailbox-count-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => store.close());
  const { projection } = projectionFixture(store.rootIdentity);
  publishGlobalRecommendationProjection(root, projection, { store, expectedGeneration: null, now: NOW });
  const projected = readGlobalRecommendationProjection(root, { now: NOW });
  const health = publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: store.rootIdentity,
    hostVersion: "0.3.0",
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  });
  const request = createGlobalActionRequest({
    grant: projected.grants.find((value) => value.action === "apply"),
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  const requestsRoot = path.join(root, "self-evolve", "bridge", "global", "requests");
  for (let index = 0; index < 63; index += 1) {
    const requestId = randomUUID();
    fs.writeFileSync(path.join(requestsRoot, `${requestId}.json`), `${JSON.stringify(hashRequest({ ...request, requestId }))}\n`, { mode: 0o600 });
  }
  submitGlobalActionRequest(root, request);
  assert.equal(fs.readdirSync(requestsRoot).length, 64);

  const sixtyFifth = createGlobalActionRequest({
    grant: projected.grants.find((value) => value.action === "reject"),
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  assert.throws(() => submitGlobalActionRequest(root, sixtyFifth), /global-mailbox-file-count-exceeded/u);
  assert.equal(fs.readdirSync(requestsRoot).length, 64);
});

test("cross-project processes contend on one durable global mailbox lease", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-process-mailbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => store.close());
  const { projection } = projectionFixture(store.rootIdentity);
  publishGlobalRecommendationProjection(root, projection, { store, expectedGeneration: null, now: NOW });
  const global = readGlobalRecommendationProjection(root, { now: NOW });
  const grant = global.grants.find((value) => value.action === "reject");
  const health = publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: store.rootIdentity,
    hostVersion: "0.3.0",
    issuedAt: NOW,
    expiresAt: NOW + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  });
  const request = createGlobalActionRequest({
    grant,
    actingProjectFingerprint: PROJECT,
    actingHealth: health,
    timestamp: NOW,
    requestId: randomUUID(),
  });
  submitGlobalActionRequest(root, request);

  const readyPath = path.join(root, "first-ready");
  const releasePath = path.join(root, "release-first");
  const effectPath = path.join(root, "effect-owner");
  const firstResultPath = path.join(root, "first-result.json");
  const secondResultPath = path.join(root, "second-result.json");
  const firstProject = H("first-consumer-project");
  const secondProject = H("second-consumer-project");
  const first = runConsumerProcess([
    root, firstProject, randomUUID(), String(NOW), firstResultPath, readyPath, releasePath, effectPath,
  ]);
  await waitForPath(readyPath);
  await runConsumerProcess([
    root, secondProject, randomUUID(), String(NOW), secondResultPath, "-", "-", effectPath,
  ]);
  const contested = JSON.parse(fs.readFileSync(secondResultPath, "utf8"));
  assert.equal(contested.ok, false);
  assert.equal(contested.reason, "global-lease-busy");

  fs.writeFileSync(releasePath, "release", { flag: "wx" });
  await first;
  const consumed = JSON.parse(fs.readFileSync(firstResultPath, "utf8"));
  assert.equal(consumed.ok, true);
  assert.equal(consumed.processed.length, 1);
  assert.equal(fs.readFileSync(effectPath, "utf8"), firstProject);
  assert.equal(pollGlobalActionResponse(root, request, { now: NOW + 10 }).ok, true);
});

test("consumer project B performs real Apply Reject and Undo while source integration A is absent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-real-domain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actingProject = H("real-acting-project");
  const consumerProject = H("real-consumer-project");
  const consumerProjectRoot = path.join(root, "consumer-project");
  fs.mkdirSync(consumerProjectRoot, { mode: 0o700 });
  const seeded = seedRealGlobalRecommendations(root, actingProject, root);
  const readyPath = path.join(root, "consumer-ready");
  const applyReadyPath = path.join(root, "apply-ready");
  const resultPath = path.join(root, "result.json");
  const configPath = path.join(root, "consumer-config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    consumerProjectFingerprint: consumerProject,
    consumerProjectRoot,
    applyRecommendationId: seeded.apply.recommendationId,
    rejectRecommendationId: seeded.reject.recommendationId,
    applyTargetPath: seeded.apply.targetPath,
    rejectTargetPath: seeded.reject.targetPath,
    readyPath,
    applyReadyPath,
    resultPath,
  }), { mode: 0o600 });
  const consumer = runRealDomainProcess([root, configPath]);
  await waitForPath(readyPath);

  const timestamp = Date.now();
  const health = publishTuiHostHealth(root, {
    projectFingerprint: actingProject,
    stateRootIdentity: seeded.stateRootIdentity,
    hostVersion: "0.3.0",
    issuedAt: timestamp,
    expiresAt: timestamp + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  });
  const initial = readGlobalRecommendationProjection(root, { now: timestamp });
  const applyGrant = initial.grants.find((value) => value.recommendationId === seeded.apply.recommendationId && value.action === "apply");
  const rejectGrant = initial.grants.find((value) => value.recommendationId === seeded.reject.recommendationId && value.action === "reject");
  assert.ok(applyGrant);
  assert.ok(rejectGrant);
  const applyRequest = createGlobalActionRequest({
    grant: applyGrant,
    actingProjectFingerprint: actingProject,
    actingHealth: health,
    timestamp,
    requestId: randomUUID(),
  });
  const rejectRequest = createGlobalActionRequest({
    grant: rejectGrant,
    actingProjectFingerprint: actingProject,
    actingHealth: health,
    timestamp,
    requestId: randomUUID(),
  });
  submitGlobalActionRequest(root, applyRequest);
  submitGlobalActionRequest(root, rejectRequest);
  await waitForPath(applyReadyPath);

  assert.equal(pollGlobalActionResponse(root, applyRequest, { now: Date.now() }).ok, true);
  assert.equal(pollGlobalActionResponse(root, rejectRequest, { now: Date.now() }).ok, true);
  const afterApply = readGlobalRecommendationProjection(root, { now: Date.now() });
  const undoGrant = afterApply.grants.find((value) => value.recommendationId === seeded.apply.recommendationId && value.action === "undo");
  assert.ok(undoGrant);
  const undoRequest = createGlobalActionRequest({
    grant: undoGrant,
    actingProjectFingerprint: actingProject,
    actingHealth: health,
    timestamp: Date.now(),
    requestId: randomUUID(),
  });
  submitGlobalActionRequest(root, undoRequest);
  await consumer;

  assert.equal(pollGlobalActionResponse(root, undoRequest, { now: Date.now() }).ok, true);
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(result.applyState, "rolled-back");
  assert.equal(result.rejectState, "rejected");
  assert.equal(result.applyContent, seeded.apply.current);
  assert.equal(result.rejectContent, seeded.reject.current);
  assert.equal(result.audits.filter((value) => value.kind === "apply").length, 1);
  assert.equal(result.audits.filter((value) => value.kind === "undo").length, 1);
  assert.equal(result.audits.filter((value) => value.kind === "reject").length, 1);
  assert.equal(result.outcomes.length, 2);
  assert.doesNotMatch(JSON.stringify({
    recommendations: result.recommendations,
    decisions: result.decisions,
    audits: result.audits,
  }), new RegExp(`${actingProject}|${consumerProject}`, "u"));
});

test("real consumer restart autonomously recovers every durable Reject prefix before authority refresh", async (t) => {
  for (const [faultPoint, expectedState, expectedAudits] of [
    ["global-reject-after-decision", "pending", 0],
    ["global-reject-after-recommendation", "rejected", 0],
    ["global-reject-after-audit", "rejected", 1],
  ]) {
    await t.test(faultPoint, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-reject-recovery-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const actingProject = H(`reject-recovery-acting:${faultPoint}`);
      const consumerProject = H(`reject-recovery-consumer:${faultPoint}`);
      const consumerProjectRoot = path.join(root, "consumer-project");
      fs.mkdirSync(consumerProjectRoot, { mode: 0o700 });
      const seeded = seedRealGlobalRecommendations(root, actingProject, root);
      const readyPath = path.join(root, "crash-consumer-ready");
      const requestReadyPath = path.join(root, "reject-request-ready");
      const crashConfigPath = path.join(root, "crash-config.json");
      fs.writeFileSync(crashConfigPath, JSON.stringify({
        mode: "reject-crash",
        faultPoint,
        consumerProjectFingerprint: consumerProject,
        consumerProjectRoot,
        rejectRecommendationId: seeded.reject.recommendationId,
        readyPath,
        requestReadyPath,
      }), { mode: 0o600 });
      const crash = runRealDomainProcess([root, crashConfigPath], { expectSignal: "SIGKILL" });
      await waitForPath(readyPath);

      const timestamp = Date.now();
      const health = publishTuiHostHealth(root, {
        projectFingerprint: actingProject,
        stateRootIdentity: seeded.stateRootIdentity,
        hostVersion: "0.3.0",
        issuedAt: timestamp,
        expiresAt: timestamp + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
      });
      const projection = readGlobalRecommendationProjection(root, { now: timestamp });
      const grant = projection.grants.find((value) => value.recommendationId === seeded.reject.recommendationId && value.action === "reject");
      assert.ok(grant);
      const request = createGlobalActionRequest({
        grant,
        actingProjectFingerprint: actingProject,
        actingHealth: health,
        timestamp,
        requestId: randomUUID(),
      });
      submitGlobalActionRequest(root, request);
      fs.writeFileSync(requestReadyPath, "ready", { flag: "wx" });
      await crash;

      const crashedStore = openStore(root, { projectFingerprint: consumerProject, now: () => Date.now(), staleLockMs: 1 });
      assert.equal(crashedStore.readGlobalRecommendations().find((value) => value.recommendationId === seeded.reject.recommendationId).state, expectedState);
      assert.equal(crashedStore.readGlobalDecisions().length, 1);
      assert.equal(crashedStore.readGlobalAudits().length, expectedAudits);
      crashedStore.close();
      assert.equal(pendingGlobalActionRequestCount(root), 1);
      assert.equal(pollGlobalActionResponse(root, request, { now: Date.now() }), null);
      assert.equal(revokeTuiHostHealth(root, actingProject, {
        nonce: health.nonce,
        stateRootIdentity: seeded.stateRootIdentity,
      }), true);

      const resultPath = path.join(root, "recovery-result.json");
      const recoveryConfigPath = path.join(root, "recovery-config.json");
      fs.writeFileSync(recoveryConfigPath, JSON.stringify({
        mode: "reject-recover",
        clockOffsetMs: 11_000,
        consumerProjectFingerprint: consumerProject,
        consumerProjectRoot,
        rejectRecommendationId: seeded.reject.recommendationId,
        resultPath,
      }), { mode: 0o600 });
      await runRealDomainProcess([root, recoveryConfigPath]);

      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      const recoveryNow = Date.now() + 11_000;
      const response = pollGlobalActionResponse(root, request, { now: recoveryNow });
      const refreshed = readGlobalRecommendationProjection(root, { now: recoveryNow });
      const expectedDecision = schemas.makeGlobalDecision({
        recommendationId: request.recommendationId,
        supportSetHash: request.supportSetHash,
        targetBindingHash: request.targetBindingHash,
        targetHash: request.targetHash,
        proposedContentHash: request.proposedContentHash,
        decisionVersion: request.recommendationVersion,
        actorRole: "operator",
        timestamp: request.issuedAt,
        nonce: request.nonce,
        priorState: request.priorState,
        newState: "rejected",
      });
      const expectedAudit = schemas.makeGlobalAuditEvent({
        kind: "reject",
        recommendationId: expectedDecision.recommendationId,
        actorRole: "operator",
        timestamp: expectedDecision.timestamp,
        supportSetHash: expectedDecision.supportSetHash,
        targetBindingHash: expectedDecision.targetBindingHash,
        proposedContentHash: expectedDecision.proposedContentHash,
        decisionVersion: expectedDecision.decisionVersion,
        outcome: "rejected",
      });
      assert.equal(result.boot.globalRejectionRecovery.ok, true);
      assert.equal(result.boot.globalRejectionRecovery.recovered.length, 1);
      assert.equal(result.rejectState, "rejected");
      assert.deepEqual(result.decisions, [expectedDecision]);
      assert.deepEqual(result.audits, [expectedAudit]);
      assert.deepEqual(result.outcomes, []);
      assert.equal(response.ok, true, response.reason);
      assert.equal(response.status, "accepted");
      assert.equal(pendingGlobalActionRequestCount(root), 0);
      assert.equal(refreshed.grants.some((value) => value.recommendationId === seeded.reject.recommendationId
        && ["apply", "reject"].includes(value.action)), false);
      assert.doesNotMatch(JSON.stringify({
        recommendations: result.recommendations,
        decisions: result.decisions,
        audits: result.audits,
      }), new RegExp(`${actingProject}|${consumerProject}`, "u"));

      const replayResultPath = path.join(root, "recovery-replay-result.json");
      const replayConfigPath = path.join(root, "recovery-replay-config.json");
      fs.writeFileSync(replayConfigPath, JSON.stringify({
        mode: "reject-recover",
        clockOffsetMs: 12_000,
        consumerProjectFingerprint: consumerProject,
        consumerProjectRoot,
        rejectRecommendationId: seeded.reject.recommendationId,
        resultPath: replayResultPath,
      }), { mode: 0o600 });
      await runRealDomainProcess([root, replayConfigPath]);
      const replay = JSON.parse(fs.readFileSync(replayResultPath, "utf8"));
      assert.equal(replay.boot.globalRejectionRecovery.recovered[0].duplicate, true);
      assert.deepEqual(replay.decisions, [expectedDecision]);
      assert.deepEqual(replay.audits, [expectedAudit]);
      assert.deepEqual(replay.outcomes, []);
    });
  }
});

test("a decision-first Reject fences a competing consumer Apply before recovery", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-reject-apply-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actingProject = H("reject-apply-race-acting");
  const rejectConsumer = H("reject-apply-race-reject-consumer");
  const applyConsumer = H("reject-apply-race-apply-consumer");
  const consumerProjectRoot = path.join(root, "consumer-project");
  fs.mkdirSync(consumerProjectRoot, { mode: 0o700 });
  const seeded = seedRealGlobalRecommendations(root, actingProject, root);
  const readyPath = path.join(root, "reject-consumer-ready");
  const requestReadyPath = path.join(root, "reject-request-ready");
  const crashConfigPath = path.join(root, "reject-crash-config.json");
  fs.writeFileSync(crashConfigPath, JSON.stringify({
    mode: "reject-crash",
    faultPoint: "global-reject-after-decision",
    consumerProjectFingerprint: rejectConsumer,
    consumerProjectRoot,
    rejectRecommendationId: seeded.reject.recommendationId,
    readyPath,
    requestReadyPath,
  }), { mode: 0o600 });
  const crash = runRealDomainProcess([root, crashConfigPath], { expectSignal: "SIGKILL" });
  await waitForPath(readyPath);

  const timestamp = Date.now();
  const health = publishTuiHostHealth(root, {
    projectFingerprint: actingProject,
    stateRootIdentity: seeded.stateRootIdentity,
    hostVersion: "0.3.0",
    issuedAt: timestamp,
    expiresAt: timestamp + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  });
  const projection = readGlobalRecommendationProjection(root, { now: timestamp });
  const rejectGrant = projection.grants.find((value) => value.recommendationId === seeded.reject.recommendationId && value.action === "reject");
  const applyGrant = projection.grants.find((value) => value.recommendationId === seeded.reject.recommendationId && value.action === "apply");
  assert.ok(rejectGrant);
  assert.ok(applyGrant);
  const rejectRequest = createGlobalActionRequest({
    grant: rejectGrant,
    actingProjectFingerprint: actingProject,
    actingHealth: health,
    timestamp,
    requestId: randomUUID(),
  });
  submitGlobalActionRequest(root, rejectRequest);
  fs.writeFileSync(requestReadyPath, "ready", { flag: "wx" });
  await crash;

  const interrupted = openStore(root, { projectFingerprint: applyConsumer, now: () => Date.now(), staleLockMs: 1 });
  assert.equal(interrupted.readGlobalRecommendations().find((value) => value.recommendationId === seeded.reject.recommendationId).state, "pending");
  assert.deepEqual(interrupted.readGlobalApplyIntents(), []);
  assert.deepEqual(interrupted.readGlobalDecisionOutcomes(), []);
  assert.equal(interrupted.readGlobalDecisions().length, 1);
  interrupted.close();
  const applyRequest = createGlobalActionRequest({
    grant: applyGrant,
    actingProjectFingerprint: actingProject,
    actingHealth: health,
    timestamp,
    requestId: randomUUID(),
  });
  submitGlobalActionRequest(root, applyRequest);
  assert.equal(pendingGlobalActionRequestCount(root), 2);

  const resultPath = path.join(root, "race-recovery-result.json");
  const recoveryConfigPath = path.join(root, "race-recovery-config.json");
  fs.writeFileSync(recoveryConfigPath, JSON.stringify({
    mode: "reject-recover",
    clockOffsetMs: 11_000,
    consumerProjectFingerprint: applyConsumer,
    consumerProjectRoot,
    rejectRecommendationId: seeded.reject.recommendationId,
    rejectTargetPath: seeded.reject.targetPath,
    resultPath,
  }), { mode: 0o600 });
  await runRealDomainProcess([root, recoveryConfigPath]);

  const recoveryNow = Date.now() + 11_000;
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const rejectResponse = pollGlobalActionResponse(root, rejectRequest, { now: recoveryNow });
  const applyResponse = pollGlobalActionResponse(root, applyRequest, { now: recoveryNow });
  const refreshed = readGlobalRecommendationProjection(root, { now: recoveryNow });
  assert.equal(result.boot.globalRejectionRecovery.ok, true);
  assert.equal(result.rejectState, "rejected");
  assert.equal(result.rejectContent, seeded.reject.current);
  assert.deepEqual(result.applyIntents, []);
  assert.deepEqual(result.outcomes, []);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].newState, "rejected");
  assert.equal(result.audits.filter((value) => value.kind === "reject").length, 1);
  assert.equal(result.audits.some((value) => value.kind === "apply"), false);
  assert.equal(rejectResponse.ok, true, rejectResponse.reason);
  assert.equal(rejectResponse.status, "accepted");
  assert.equal(applyResponse.ok, false);
  assert.equal(applyResponse.status, "rejected");
  assert.equal(pendingGlobalActionRequestCount(root), 0);
  assert.equal(refreshed.grants.some((value) => value.recommendationId === seeded.reject.recommendationId
    && ["apply", "reject"].includes(value.action)), false);
  assert.doesNotMatch(JSON.stringify({
    recommendations: result.recommendations,
    decisions: result.decisions,
    audits: result.audits,
  }), new RegExp(`${actingProject}|${rejectConsumer}|${applyConsumer}`, "u"));
});

function runProjectionPublisher(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROJECTION_PUBLISHER.pathname, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`global projection publisher exited ${code ?? signal}: ${stderr}`));
    });
  });
}

test("concurrent project processes publish exactly one global projection generation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-projection-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => store.close());
  const firstResult = path.join(root, "first.json");
  const secondResult = path.join(root, "second.json");
  const readyPath = path.join(root, "publisher-ready");
  const releasePath = path.join(root, "publisher-release");

  const first = runProjectionPublisher([
    root, H("publisher-a"), "1", "null", String(NOW), firstResult, readyPath, releasePath,
  ]);
  await waitForPath(readyPath);
  const second = runProjectionPublisher([
    root, H("publisher-b"), "2", "null", String(NOW), secondResult, "-", "-",
  ]);
  fs.writeFileSync(releasePath, "release", { flag: "wx" });
  await Promise.all([first, second]);

  const results = [firstResult, secondResult].map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(losers.length, 1, JSON.stringify(results));
  assert.match(losers[0].reason, /stale-global-projection-cas|global-lease-busy/u);
  const projection = readGlobalRecommendationProjection(root, { now: NOW });
  assert.equal(projection.mode, "native");
  assert.equal(projection.index.generation, winners[0].generation);
  assert.equal(projection.index.indexHash, winners[0].indexHash);
  assert.deepEqual(projection.index.recommendations.map((entry) => entry.recommendationId), [winners[0].recommendationId]);
  const generations = fs.readdirSync(path.join(root, "self-evolve", "bridge", "global", "generations"));
  assert.deepEqual(generations, [winners[0].generation]);
});

test("a dead global projection lease owner never blocks a later publication", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-global-projection-dead-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => NOW });
  t.after(() => store.close());
  const abandonedResult = path.join(root, "abandoned.json");
  const blockedResult = path.join(root, "blocked.json");
  const recoveredResult = path.join(root, "recovered.json");

  await assert.rejects(runProjectionPublisher([
    root, H("abandoning-project"), "abandon", "null", String(NOW), abandonedResult, "-", "-",
  ]));
  assert.equal(JSON.parse(fs.readFileSync(abandonedResult, "utf8")).ok, true);

  await runProjectionPublisher([root, H("blocked-project"), "3", "null", String(NOW + 1), blockedResult, "-", "-"]);
  const blocked = JSON.parse(fs.readFileSync(blockedResult, "utf8"));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /lease/u);
  assert.equal(fs.existsSync(path.join(root, "self-evolve", "bridge", "global", "index.json")), false);

  await runProjectionPublisher([root, H("recovering-project"), "4", "null", String(NOW + 20_000), recoveredResult, "-", "-"]);

  const recovered = JSON.parse(fs.readFileSync(recoveredResult, "utf8"));
  assert.equal(recovered.ok, true, recovered.reason);
  const projection = readGlobalRecommendationProjection(root, { now: NOW + 20_000 });
  assert.equal(projection.mode, "native");
  assert.equal(projection.index.generation, recovered.generation);
  assert.deepEqual(
    fs.readdirSync(path.join(root, "self-evolve", "bridge", "global", "generations")),
    [recovered.generation],
  );
});
