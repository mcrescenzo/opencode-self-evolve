import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_REQUEST_FIELDS,
  BRIDGE_RESPONSE_FIELDS,
  CONTROL_REQUEST_FIELDS,
  CONTROL_RESPONSE_FIELDS,
  CONTROL_STATE_FIELDS,
  makeBridgeRequest,
  makeBridgeResponse,
  makeControlRequest,
  makeControlResponse,
  makeControlState,
} from "../self-evolve-bridge.js";
import { SCHEMA_VERSION, Decision, makeDecision } from "../self-evolve-schemas.js";
import {
  UI_CAPABILITIES,
  UI_ACTION_CAPABILITIES,
  UI_OPERATION_ACTIONS,
  UI_OPERATION_REQUEST_FIELDS,
  UI_OPERATION_RESPONSE_FIELDS,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROTOCOL_COMPATIBILITY,
  UI_PROTOCOL_LIMITS,
  UI_PROJECTION_INDEX_FIELDS,
  UI_PROJECTION_VERSION,
  UI_REVIEW_DETAIL_FIELDS,
  assertUiProjectionFootprint,
  canonicalUiJson,
  hashUiProtocol,
  makeUiOperationRequest,
  makeUiOperationResponse,
  makeUiOverflowMarker,
  makeUiProjectionIndex,
  makeUiProtocolOffer,
  makeUiReviewDetail,
  negotiateUiProtocol,
} from "../self-evolve-ui-protocol.js";

const H = (character) => character.repeat(64);
const PROJECT = H("a");
const ROOT = H("b");
const GENERATION = H("c");
const NOW = 1_000_000;

function overflow(includedCount, overrides = {}) {
  return {
    truncated: false,
    includedCount,
    omittedCount: 0,
    omittedBytes: 0,
    reason: "none",
    ...overrides,
  };
}

function projectionContext(overrides = {}) {
  return {
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    now: NOW,
    supportedCapabilities: UI_CAPABILITIES,
    ...overrides,
  };
}

function projectionIndex(overrides = {}) {
  const body = {
    projectionVersion: UI_PROJECTION_VERSION,
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    capabilities: UI_CAPABILITIES,
    status: {
      state: "ready",
      reason: null,
      storedMode: "auto",
      effectiveMode: "auto",
      paused: false,
      killSwitchActive: false,
      repoExcluded: false,
      circuitBreakerOpen: false,
    },
    budgets: {
      passiveCallsPerHour: 6,
      synthesisPerDay: 24,
      tokensPerSynthesis: 8_000,
      concurrentObservationsPerProject: 1,
      concurrentSynthesesGlobal: 1,
      idleDebounceMs: 1_500,
      storageQuotaMiB: 8,
    },
    reviews: [{
      proposalId: "proposal-1",
      state: "pending",
      target: "demo/SKILL.md",
      attention: "normal",
      updatedAt: NOW - 2_000,
      detailRevision: 3,
      detailHash: H("d"),
    }],
    operations: [{
      requestId: "request-1",
      action: "snooze-proposal",
      status: "completed",
      updatedAt: NOW - 1_500,
      reason: null,
    }],
    allowedActions: [{
      action: "set-paused",
      capability: "operation-pause-v1",
      nonce: "pause-nonce",
      expiresAt: NOW + 30_000,
    }],
    overflow: {
      reviews: overflow(1),
      operations: overflow(1),
      allowedActions: overflow(1),
    },
    ...overrides,
  };
  return { ...body, projectionHash: hashUiProtocol("projection-index", body) };
}

function reviewDetail(overrides = {}) {
  const body = {
    projectionVersion: UI_PROJECTION_VERSION,
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    proposalId: "proposal-1",
    revision: 3,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    summary: {
      state: "pending",
      target: {
        relativePath: "demo/SKILL.md",
        currentHash: H("e"),
        proposedContentHash: H("f"),
      },
      effectiveMode: "auto",
      rationale: "Repeated deterministic evidence supports this bounded skill change.",
      risk: "low",
      criticScoreBasisPoints: 9_500,
      criticPassed: true,
      validDeterministic: true,
      injectionFlagged: false,
      tokenImpact: { estimatedTokens: 1_200, budgetTokens: 8_000 },
      eligibility: {
        eligible: true,
        reasons: ["all-thresholds-met"],
        checks: [{ name: "minIncidents", met: true, actual: 3, required: 3 }],
      },
      rollback: { eligible: false, reason: "not-applied", appliedHash: null },
      operation: { status: "idle", requestId: null, reason: null, updatedAt: null },
    },
    diff: {
      kind: "unified",
      lines: ["--- current", "+++ proposed", "+bounded guidance"],
      overflow: overflow(3),
    },
    evidence: [{
      id: H("1"),
      kind: "repeated-command",
      summary: "The same bounded command sequence appeared three times.",
      occurredAt: NOW - 3_000,
      redacted: true,
    }],
    audit: [{
      id: H("2"),
      kind: "decision",
      summary: "Critic accepted the deterministic proposal.",
      timestamp: NOW - 2_500,
    }],
    allowedActions: [{
      action: "snooze-proposal",
      capability: "operation-snooze-v1",
      nonce: "snooze-nonce",
      expiresAt: NOW + 30_000,
    }],
    overflow: {
      evidence: overflow(1),
      audit: overflow(1),
      allowedActions: overflow(1),
    },
    ...overrides,
  };
  return { ...body, detailHash: hashUiProtocol("review-detail", body) };
}

function detailContext(value, overrides = {}) {
  return {
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    detailRevision: value.revision,
    detailHash: value.detailHash,
    now: NOW,
    supportedCapabilities: UI_CAPABILITIES,
    ...overrides,
  };
}

function operationRequest(action = "snooze-proposal", payload = {
  proposalId: "proposal-1",
  targetHash: H("e"),
  proposedContentHash: H("f"),
  decisionVersion: 4,
  snoozedUntil: NOW + 86_400_000,
}, overrides = {}) {
  const body = {
    operationProtocolVersion: UI_OPERATION_PROTOCOL_VERSION,
    requestId: "operation-1",
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    projectionHash: H("d"),
    action,
    capability: UI_ACTION_CAPABILITIES[action],
    actor: "self-evolve-tui",
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 30_000,
    nonce: "operation-nonce",
    payload,
    ...overrides,
  };
  return { ...body, operationHash: hashUiProtocol("operation-request", body) };
}

function operationContext(value, overrides = {}) {
  return {
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    generation: GENERATION,
    projectionHash: H("d"),
    now: NOW,
    supportedCapabilities: UI_CAPABILITIES,
    grant: {
      action: value.action,
      capability: value.capability,
      nonce: value.nonce,
      expiresAt: value.expiresAt,
    },
    ...overrides,
  };
}

function operationResponse(request, overrides = {}) {
  const body = {
    operationProtocolVersion: UI_OPERATION_PROTOCOL_VERSION,
    requestId: request.requestId,
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    action: request.action,
    requestHash: request.operationHash,
    ok: true,
    status: request.action === "purge-all" ? "accepted-terminal" : "accepted",
    processedAt: NOW + 1,
    reason: null,
    ...overrides,
  };
  return { ...body, responseHash: hashUiProtocol("operation-response", body) };
}

test("UI protocols version projections and operations independently with canonical hashes", () => {
  assert.equal(UI_PROJECTION_VERSION, 1);
  assert.equal(UI_OPERATION_PROTOCOL_VERSION, 1);
  assert.equal(canonicalUiJson({ z: [2, { b: true, a: null }], a: "value" }), '{"a":"value","z":[2,{"a":null,"b":true}]}');
  assert.equal(
    hashUiProtocol("projection-index", { z: 2, a: 1 }),
    hashUiProtocol("projection-index", { a: 1, z: 2 }),
  );
  assert.notEqual(
    hashUiProtocol("projection-index", { a: 1, z: 2 }),
    hashUiProtocol("operation-request", { a: 1, z: 2 }),
  );
  assert.throws(() => canonicalUiJson({ value: Number.NaN }), /canonical-number/u);
  assert.throws(() => canonicalUiJson([, "sparse"]), /sparse-array/u);
  assert.throws(() => canonicalUiJson({ value: "\ud800" }), /unicode/u);
  assert.throws(() => canonicalUiJson({ "bad\u0000key": true }), /control-character/u);
  assert.throws(() => hashUiProtocol("unknown", {}), /unknown-ui-protocol-kind/u);

  assert.equal(UI_PROTOCOL_LIMITS.canonicalDepth, 64);
  assert.equal(UI_PROTOCOL_LIMITS.canonicalBytes, 1024 * 1024);
  let nested = null;
  for (let index = 0; index <= UI_PROTOCOL_LIMITS.canonicalDepth; index += 1) nested = { nested };
  assert.throws(() => canonicalUiJson(nested), /canonical-depth/u);
  assert.throws(() => canonicalUiJson("x".repeat(UI_PROTOCOL_LIMITS.canonicalBytes + 1)), /canonical-footprint/u);
});

test("overflow markers deterministically account for omitted canonical bytes", () => {
  const omitted = [{ z: 2, a: 1 }, "é"];
  const marker = makeUiOverflowMarker(3, omitted, "item-limit");
  assert.deepEqual(marker, {
    truncated: true,
    includedCount: 3,
    omittedCount: 2,
    omittedBytes: omitted.reduce((total, item) => total + Buffer.byteLength(canonicalUiJson(item)), 0),
    reason: "item-limit",
  });
  assert.deepEqual(makeUiOverflowMarker(0), overflow(0));
  assert.equal(
    makeUiOverflowMarker(3, [{ a: 1, z: 2 }, "é"], "item-limit").omittedBytes,
    marker.omittedBytes,
  );
  assert.throws(() => makeUiOverflowMarker(3, omitted, "none"), /overflow-reason/u);
  assert.throws(() => makeUiOverflowMarker(0, [], "bogus"), /overflow-reason/u);
  assert.equal(UI_PROTOCOL_LIMITS.overflowSourceItems, 4_096);
  assert.throws(() => makeUiOverflowMarker(0, Array(4_097).fill(null), "item-limit"), /omitted-items-out-of-bounds/u);
});

test("capability negotiation is strict and mixed-version peers remain legacy-only", () => {
  const server = makeUiProtocolOffer({
    projectionVersions: [UI_PROJECTION_VERSION],
    operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
    capabilities: UI_CAPABILITIES,
  });
  const client = makeUiProtocolOffer({
    projectionVersions: [UI_PROJECTION_VERSION],
    operationProtocolVersions: [],
    capabilities: ["legacy-decision-v1", "projection-index-v1", "projection-review-detail-v1"],
  });

  assert.deepEqual(negotiateUiProtocol(server, server), {
    mode: "native",
    projectionVersion: 1,
    operationProtocolVersion: 1,
    capabilities: UI_CAPABILITIES,
    reason: null,
  });
  assert.deepEqual(negotiateUiProtocol(server, client), {
    mode: "read-only",
    projectionVersion: 1,
    operationProtocolVersion: null,
    capabilities: ["legacy-decision-v1", "projection-index-v1", "projection-review-detail-v1"],
    reason: "operation-version-unavailable",
  });
  assert.deepEqual(negotiateUiProtocol(null, server), {
    mode: "legacy",
    projectionVersion: null,
    operationProtocolVersion: null,
    capabilities: [],
    reason: "server-offer-unavailable",
  });
  assert.deepEqual(negotiateUiProtocol(server, null), {
    mode: "legacy",
    projectionVersion: null,
    operationProtocolVersion: null,
    capabilities: [],
    reason: "client-offer-unavailable",
  });
  assert.deepEqual(UI_PROTOCOL_COMPATIBILITY, {
    newTuiOldServer: "legacy-read-only-no-new-writes",
    oldTuiNewServer: "legacy-protocols-retained-no-new-writes",
  });

  const futureServer = {
    projectionVersions: [1, 2],
    operationProtocolVersions: [1, 2],
    capabilities: [...UI_CAPABILITIES, "projection-v2"].sort(),
  };
  assert.deepEqual(negotiateUiProtocol(futureServer, server), {
    mode: "native",
    projectionVersion: 1,
    operationProtocolVersion: 1,
    capabilities: UI_CAPABILITIES,
    reason: null,
  });
  assert.deepEqual(negotiateUiProtocol({ ...futureServer, projectionVersions: [2] }, server), {
    mode: "legacy",
    projectionVersion: null,
    operationProtocolVersion: null,
    capabilities: [],
    reason: "projection-version-unavailable",
  });
  assert.deepEqual(negotiateUiProtocol({ ...futureServer, operationProtocolVersions: [2] }, server), {
    mode: "read-only",
    projectionVersion: 1,
    operationProtocolVersion: null,
    capabilities: UI_CAPABILITIES.filter((capability) => !capability.startsWith("operation-")),
    reason: "operation-version-unavailable",
  });

  assert.throws(() => makeUiProtocolOffer({ ...server, projectionVersions: [2] }), /unsupported-projection-version/u);
  assert.throws(() => makeUiProtocolOffer({ ...server, operationProtocolVersions: [2] }), /unsupported-operation-version/u);
  assert.throws(() => makeUiProtocolOffer({ ...server, capabilities: [...server.capabilities, "unknown"] }), /unknown-capability/u);
  assert.throws(() => makeUiProtocolOffer({ ...server, extra: true }), /unknown-field/u);
  assert.throws(() => makeUiProtocolOffer({ ...server, capabilities: [...server.capabilities].reverse() }), /capabilities-not-sorted/u);
});

test("projection indexes are exact, hash-bound, project/root-bound, fresh, and deeply frozen", () => {
  const value = makeUiProjectionIndex(projectionIndex(), projectionContext());
  assert.deepEqual(Object.keys(value), UI_PROJECTION_INDEX_FIELDS);
  assert.equal(value.projectionVersion, 1);
  assert.equal("operationProtocolVersion" in value, false);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.status));
  assert.ok(Object.isFrozen(value.reviews));
  assert.ok(Object.isFrozen(value.reviews[0]));

  assert.throws(() => makeUiProjectionIndex({ ...projectionIndex(), rawSessionId: "secret" }, projectionContext()), /unknown-field/u);
  assert.throws(() => makeUiProjectionIndex(projectionIndex({ projectionVersion: 2 }), projectionContext()), /unsupported-projection-version/u);
  assert.throws(() => makeUiProjectionIndex(projectionIndex({ operationProtocolVersion: 2 }), projectionContext()), /unknown-field/u);
  assert.throws(() => makeUiProjectionIndex(projectionIndex({ projectFingerprint: H("e") }), projectionContext()), /cross-project/u);
  assert.throws(() => makeUiProjectionIndex(projectionIndex({ stateRootIdentity: H("e") }), projectionContext()), /cross-root/u);
  assert.throws(() => makeUiProjectionIndex(projectionIndex({ generation: H("e") }), projectionContext()), /stale-generation/u);
  assert.throws(() => makeUiProjectionIndex(projectionIndex({ expiresAt: NOW }), projectionContext()), /expired-projection/u);
  assert.throws(() => makeUiProjectionIndex(projectionIndex({ issuedAt: NOW + UI_PROTOCOL_LIMITS.futureSkewMs + 1 }), projectionContext()), /future-projection/u);
  assert.throws(() => makeUiProjectionIndex({ ...projectionIndex(), projectionHash: H("f") }, projectionContext()), /projection-hash-mismatch/u);
  assert.throws(() => makeUiProjectionIndex(Object.create(projectionIndex()), projectionContext()), /malformed/u);
  assert.throws(
    () => makeUiProjectionIndex(Object.assign(Object.create({ rawSessionId: "secret" }), projectionIndex()), projectionContext()),
    /malformed/u,
  );
});

test("future artifact versions fail as unsupported before their newer fields are interpreted", () => {
  assert.throws(
    () => makeUiProjectionIndex({ ...projectionIndex({ projectionVersion: 2 }), futureIndexField: true }, projectionContext()),
    /unsupported-projection-version/u,
  );
  const detail = reviewDetail({ projectionVersion: 2 });
  assert.throws(
    () => makeUiReviewDetail({ ...detail, futureDetailField: true }, detailContext(detail)),
    /unsupported-projection-version/u,
  );
  const request = operationRequest("snooze-proposal", undefined, { operationProtocolVersion: 2 });
  assert.throws(
    () => makeUiOperationRequest({ ...request, futureRequestField: true }, operationContext(request)),
    /unsupported-operation-version/u,
  );
  const response = operationResponse(operationRequest(), { operationProtocolVersion: 2 });
  assert.throws(
    () => makeUiOperationResponse({ ...response, futureResponseField: true }, {
      projectFingerprint: PROJECT,
      stateRootIdentity: ROOT,
      requestId: response.requestId,
      action: response.action,
      requestHash: response.requestHash,
      requestIssuedAt: NOW - 1_000,
      requestExpiresAt: NOW + 30_000,
      now: NOW,
    }),
    /unsupported-operation-version/u,
  );
});

test("projection indexes enforce collection, reason, ordering, capability, overflow, and footprint bounds", () => {
  const review = projectionIndex().reviews[0];
  const reviews = Array.from({ length: UI_PROTOCOL_LIMITS.reviewIndexEntries + 1 }, (_, index) => ({
    ...review,
    proposalId: `proposal-${String(index).padStart(3, "0")}`,
  }));
  const tooMany = projectionIndex({
    reviews,
    overflow: {
      reviews: overflow(reviews.length),
      operations: overflow(1),
      allowedActions: overflow(1),
    },
  });
  assert.throws(() => makeUiProjectionIndex(tooMany, projectionContext()), /reviews-out-of-bounds/u);

  const outOfOrder = projectionIndex({
    reviews: [
      { ...review, proposalId: "proposal-normal", attention: "normal" },
      { ...review, proposalId: "proposal-critical", attention: "critical" },
    ],
    overflow: {
      reviews: overflow(2),
      operations: overflow(1),
      allowedActions: overflow(1),
    },
  });
  assert.throws(() => makeUiProjectionIndex(outOfOrder, projectionContext()), /reviews-not-sorted/u);

  const badOverflow = projectionIndex({
    overflow: {
      reviews: overflow(0),
      operations: overflow(1),
      allowedActions: overflow(1),
    },
  });
  assert.throws(() => makeUiProjectionIndex(badOverflow, projectionContext()), /included-count-mismatch/u);
  const impossibleOverflow = projectionIndex({
    overflow: {
      reviews: { truncated: true, includedCount: 1, omittedCount: 1, omittedBytes: 0, reason: "item-limit" },
      operations: overflow(1),
      allowedActions: overflow(1),
    },
  });
  assert.throws(() => makeUiProjectionIndex(impossibleOverflow, projectionContext()), /overflow-inconsistent/u);
  assert.throws(
    () => makeUiProjectionIndex(projectionIndex({ status: { ...projectionIndex().status, reason: "x".repeat(UI_PROTOCOL_LIMITS.reasonBytes + 1) } }), projectionContext()),
    /reason-out-of-bounds/u,
  );
  assert.throws(
    () => makeUiProjectionIndex(projectionIndex({ allowedActions: [{ ...projectionIndex().allowedActions[0], capability: "operation-kill-switch-v1" }] }), projectionContext()),
    /action-capability-mismatch/u,
  );
  assert.throws(
    () => makeUiProjectionIndex(projectionIndex(), projectionContext({ supportedCapabilities: ["projection-index-v1"] })),
    /unsupported-capability/u,
  );
  assert.throws(
    () => makeUiProjectionIndex(projectionIndex({ status: { ...projectionIndex().status, rawMessage: "secret" } }), projectionContext()),
    /unknown-field/u,
  );

  const largeReviews = Array.from({ length: UI_PROTOCOL_LIMITS.reviewIndexEntries }, (_, index) => ({
    ...review,
    proposalId: `large-${String(index).padStart(3, "0")}`,
    target: `${"x".repeat(1_000)}/${index}`,
  }));
  const oversized = projectionIndex({
    reviews: largeReviews,
    overflow: {
      reviews: overflow(largeReviews.length),
      operations: overflow(1),
      allowedActions: overflow(1),
    },
  });
  assert.throws(() => makeUiProjectionIndex(oversized, projectionContext()), /projection-index-footprint-exceeded/u);
});

test("review details are exact, hash/revision/generation-bound, fresh, and privacy-safe", () => {
  const input = reviewDetail();
  const value = makeUiReviewDetail(input, detailContext(input));
  assert.deepEqual(Object.keys(value), UI_REVIEW_DETAIL_FIELDS);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.summary));
  assert.ok(Object.isFrozen(value.diff.lines));
  assert.ok(Object.isFrozen(value.evidence[0]));

  const newer = reviewDetail({ generation: H("9") });
  assert.throws(() => makeUiReviewDetail(newer, detailContext(newer, { generation: GENERATION })), /stale-generation/u);
  assert.throws(() => makeUiReviewDetail(input, detailContext(input, { detailRevision: 4 })), /stale-detail-revision/u);
  assert.throws(() => makeUiReviewDetail(input, detailContext(input, { detailHash: H("9") })), /detail-hash-mismatch/u);
  assert.throws(() => makeUiReviewDetail({ ...input, detailHash: H("9") }, detailContext(input)), /detail-hash-mismatch/u);
  assert.throws(() => makeUiReviewDetail(reviewDetail({ projectFingerprint: H("9") }), detailContext(input)), /cross-project/u);
  assert.throws(() => makeUiReviewDetail(reviewDetail({ stateRootIdentity: H("9") }), detailContext(input)), /cross-root/u);
  assert.throws(() => makeUiReviewDetail(reviewDetail({ expiresAt: NOW }), detailContext(input)), /expired-projection/u);
  assert.throws(
    () => makeUiReviewDetail(reviewDetail({ summary: { ...input.summary, rawSessionId: "session-secret" } }), detailContext(input)),
    /unknown-field/u,
  );
});

test("review details enforce diff, evidence, audit, reason, overflow, and total footprint limits", () => {
  const base = reviewDetail();
  const tooManyDiffLines = Array(UI_PROTOCOL_LIMITS.diffLines + 1).fill("line");
  assert.throws(
    () => makeUiReviewDetail(reviewDetail({ diff: { kind: "unified", lines: tooManyDiffLines, overflow: overflow(tooManyDiffLines.length) } }), detailContext(base)),
    /diff-lines-out-of-bounds/u,
  );
  const tooManyDiffBytes = Array(65).fill("x".repeat(1_024));
  assert.throws(
    () => makeUiReviewDetail(reviewDetail({ diff: { kind: "unified", lines: tooManyDiffBytes, overflow: overflow(tooManyDiffBytes.length) } }), detailContext(base)),
    /diff-bytes-out-of-bounds/u,
  );

  const evidenceEntry = base.evidence[0];
  const tooMuchEvidence = Array.from({ length: UI_PROTOCOL_LIMITS.evidenceEntries + 1 }, (_, index) => ({
    ...evidenceEntry,
    id: index.toString(16).padStart(64, "0"),
  }));
  assert.throws(
    () => makeUiReviewDetail(reviewDetail({
      evidence: tooMuchEvidence,
      overflow: { evidence: overflow(tooMuchEvidence.length), audit: overflow(1), allowedActions: overflow(1) },
    }), detailContext(base)),
    /evidence-out-of-bounds/u,
  );

  const auditEntry = base.audit[0];
  const tooMuchAudit = Array.from({ length: UI_PROTOCOL_LIMITS.auditEntries + 1 }, (_, index) => ({
    ...auditEntry,
    id: index.toString(16).padStart(64, "0"),
  }));
  assert.throws(
    () => makeUiReviewDetail(reviewDetail({
      audit: tooMuchAudit,
      overflow: { evidence: overflow(1), audit: overflow(tooMuchAudit.length), allowedActions: overflow(1) },
    }), detailContext(base)),
    /audit-out-of-bounds/u,
  );

  assert.throws(
    () => makeUiReviewDetail(reviewDetail({
      summary: { ...base.summary, rationale: "é".repeat((UI_PROTOCOL_LIMITS.rationaleBytes / 2) + 1) },
    }), detailContext(base)),
    /rationale-out-of-bounds/u,
  );
  assert.throws(
    () => makeUiReviewDetail(reviewDetail({
      evidence: [{ ...evidenceEntry, rawMessage: "secret" }],
    }), detailContext(base)),
    /unknown-field/u,
  );
  assert.throws(
    () => makeUiReviewDetail(reviewDetail({
      overflow: { evidence: overflow(0), audit: overflow(1), allowedActions: overflow(1) },
    }), detailContext(base)),
    /included-count-mismatch/u,
  );

  const largeEvidence = Array.from({ length: UI_PROTOCOL_LIMITS.evidenceEntries }, (_, index) => ({
    ...evidenceEntry,
    id: index.toString(16).padStart(64, "0"),
    summary: "e".repeat(UI_PROTOCOL_LIMITS.summaryBytes),
  }));
  const largeAudit = Array.from({ length: UI_PROTOCOL_LIMITS.auditEntries }, (_, index) => ({
    ...auditEntry,
    id: index.toString(16).padStart(64, "0"),
    summary: "a".repeat(UI_PROTOCOL_LIMITS.summaryBytes),
  }));
  const oversized = reviewDetail({
    evidence: largeEvidence,
    audit: largeAudit,
    overflow: {
      evidence: overflow(largeEvidence.length),
      audit: overflow(largeAudit.length),
      allowedActions: overflow(1),
    },
  });
  assert.throws(() => makeUiReviewDetail(oversized, detailContext(oversized)), /review-detail-footprint-exceeded/u);

  const localeAmbiguous = reviewDetail({
    summary: {
      ...base.summary,
      eligibility: { ...base.summary.eligibility, reasons: ["é", "e\u0301"] },
    },
  });
  assert.throws(() => makeUiReviewDetail(localeAmbiguous, detailContext(base)), /eligibility-reasons-not-sorted/u);
});

test("operation requests are an exact capability-gated union bound to fresh projection authority", () => {
  const input = operationRequest();
  const value = makeUiOperationRequest(input, operationContext(input));
  assert.deepEqual(Object.keys(value), UI_OPERATION_REQUEST_FIELDS);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.payload));

  assert.throws(() => makeUiOperationRequest({ ...input, rawSessionId: "secret" }, operationContext(input)), /unknown-field/u);
  assert.throws(
    () => makeUiOperationRequest(operationRequest("scan-session", {}, { capability: "operation-snooze-v1" }), operationContext(input)),
    /unknown-operation-action/u,
  );
  assert.throws(() => makeUiOperationRequest(operationRequest("snooze-proposal", input.payload, { operationProtocolVersion: 2 }), operationContext(input)), /unsupported-operation-version/u);
  assert.throws(() => makeUiOperationRequest(operationRequest("snooze-proposal", input.payload, { projectFingerprint: H("9") }), operationContext(input)), /cross-project/u);
  assert.throws(() => makeUiOperationRequest(operationRequest("snooze-proposal", input.payload, { stateRootIdentity: H("9") }), operationContext(input)), /cross-root/u);
  assert.throws(() => makeUiOperationRequest(operationRequest("snooze-proposal", input.payload, { generation: H("9") }), operationContext(input)), /stale-generation/u);
  assert.throws(() => makeUiOperationRequest(operationRequest("snooze-proposal", input.payload, { projectionHash: H("9") }), operationContext(input)), /stale-projection/u);
  assert.throws(() => makeUiOperationRequest(operationRequest("snooze-proposal", input.payload, { expiresAt: NOW }), operationContext(input)), /expired-operation/u);
  assert.throws(
    () => makeUiOperationRequest(operationRequest("snooze-proposal", input.payload, { capability: "operation-rollback-v1" }), operationContext(input)),
    /action-capability-mismatch/u,
  );
  assert.throws(
    () => makeUiOperationRequest(input, operationContext(input, { supportedCapabilities: ["projection-index-v1"] })),
    /unsupported-capability/u,
  );
  assert.throws(
    () => makeUiOperationRequest(input, operationContext(input, { grant: { ...operationContext(input).grant, nonce: "other-nonce" } })),
    /operation-grant-nonce-mismatch/u,
  );
  assert.throws(
    () => makeUiOperationRequest(input, operationContext(input, { grant: {
      action: "rollback-proposal",
      capability: "operation-rollback-v1",
      nonce: input.nonce,
      expiresAt: input.expiresAt,
    } })),
    /operation-grant-action-mismatch/u,
  );
  assert.throws(
    () => makeUiOperationRequest(input, operationContext(input, { grant: { ...operationContext(input).grant, expiresAt: NOW } })),
    /expired-operation-grant/u,
  );
  assert.throws(
    () => makeUiOperationRequest(input, operationContext(input, { grant: { ...operationContext(input).grant, expiresAt: NOW + 10_000 } })),
    /operation-exceeds-grant-expiry/u,
  );
  assert.throws(() => makeUiOperationRequest({ ...input, operationHash: H("9") }, operationContext(input)), /operation-hash-mismatch/u);
});

test("operation responses bind exact requests and reserve accepted-terminal for purge-all", () => {
  const request = operationRequest();
  const input = operationResponse(request);
  const context = {
    projectFingerprint: PROJECT,
    stateRootIdentity: ROOT,
    requestId: request.requestId,
    action: request.action,
    requestHash: request.operationHash,
    requestIssuedAt: request.issuedAt,
    requestExpiresAt: request.expiresAt,
    now: NOW,
  };
  const response = makeUiOperationResponse(input, context);
  assert.deepEqual(Object.keys(response), UI_OPERATION_RESPONSE_FIELDS);
  assert.ok(Object.isFrozen(response));
  assert.throws(() => makeUiOperationResponse({ ...input, responseHash: H("9") }, context), /response-hash-mismatch/u);
  assert.throws(() => makeUiOperationResponse(operationResponse(request, { status: "accepted-terminal" }), context), /invalid-terminal-response/u);
  assert.throws(() => makeUiOperationResponse(operationResponse(request, { ok: false, status: "accepted", reason: "no" }), context), /inconsistent-response-status/u);
  const rejected = operationResponse(request, { ok: false, status: "rejected", reason: "stale-generation" });
  assert.equal(makeUiOperationResponse(rejected, context).reason, "stale-generation");
  assert.throws(
    () => makeUiOperationResponse(operationResponse(request, { processedAt: request.issuedAt - 1 }), context),
    /response-precedes-request/u,
  );
  assert.throws(
    () => makeUiOperationResponse(operationResponse(request, { processedAt: request.expiresAt + 1 }), context),
    /response-after-request-expiry/u,
  );
  assert.throws(
    () => makeUiOperationResponse(operationResponse(request, { processedAt: request.expiresAt }), context),
    /response-after-request-expiry/u,
  );
  assert.throws(
    () => makeUiOperationResponse(input, { ...context, requestExpiresAt: request.issuedAt + UI_PROTOCOL_LIMITS.operationTtlMs + 1 }),
    /invalid-request-lifetime/u,
  );

  const purge = operationRequest("purge-all", { confirmation: "PURGE ALL SELF-EVOLVE DATA" });
  const terminal = operationResponse(purge);
  assert.equal(makeUiOperationResponse(terminal, { ...context, requestId: purge.requestId, action: purge.action, requestHash: purge.operationHash }).status, "accepted-terminal");
});

test("every operation action has a closed bounded payload and no native scan action", () => {
  const cases = [
    ["snooze-proposal", {
      proposalId: "proposal-1", targetHash: "must-not-exist", proposedContentHash: H("f"),
      decisionVersion: 4, snoozedUntil: NOW + 60_000,
    }],
    ["rollback-proposal", { proposalId: "proposal-1", appliedHash: H("e"), decisionVersion: 5 }],
    ["set-kill-switch", { enabled: true, settingsVersion: H("4") }],
    ["set-paused", { paused: true, settingsVersion: H("4") }],
    ["purge-scope", { scope: "observations", confirmation: "PURGE OBSERVATIONS" }],
    ["purge-all", { confirmation: "PURGE ALL SELF-EVOLVE DATA" }],
    ["export-data", { scope: "project", confirmation: "EXPORT SENSITIVE SELF-EVOLVE DATA" }],
    ["retry-bootstrap", {}],
  ];
  assert.deepEqual(cases.map(([action]) => action).sort(), UI_OPERATION_ACTIONS);
  assert.equal(UI_OPERATION_ACTIONS.includes("scan-session"), false);
  for (const [action, payload] of cases) {
    const request = operationRequest(action, payload);
    assert.deepEqual(makeUiOperationRequest(request, operationContext(request)).payload, payload, action);
  }

  const base = operationRequest();
  assert.throws(
    () => makeUiOperationRequest(operationRequest("snooze-proposal", { ...base.payload, rawMessageId: "secret" }), operationContext(base)),
    /unknown-field/u,
  );
  assert.throws(
    () => makeUiOperationRequest(operationRequest("snooze-proposal", { ...base.payload, snoozedUntil: NOW + UI_PROTOCOL_LIMITS.snoozeMaxMs + 1 }), operationContext(base)),
    /invalid-snooze-expiry/u,
  );
  const invalidPurgeScope = operationRequest("purge-scope", { scope: "all", confirmation: "PURGE ALL" });
  assert.throws(() => makeUiOperationRequest(invalidPurgeScope, operationContext(invalidPurgeScope)), /invalid-purge-scope/u);
  const invalidPurgeConfirmation = operationRequest("purge-scope", { scope: "project", confirmation: "yes" });
  assert.throws(() => makeUiOperationRequest(invalidPurgeConfirmation, operationContext(invalidPurgeConfirmation)), /invalid-purge-confirmation/u);
  const invalidExportConfirmation = operationRequest("export-data", { scope: "all", confirmation: "yes" });
  assert.throws(() => makeUiOperationRequest(invalidExportConfirmation, operationContext(invalidExportConfirmation)), /invalid-export-confirmation/u);
  const invalidRetry = operationRequest("retry-bootstrap", { force: true });
  assert.throws(() => makeUiOperationRequest(invalidRetry, operationContext(invalidRetry)), /unknown-field/u);
  assert.throws(
    () => makeUiOperationRequest(operationRequest("snooze-proposal", base.payload, { actor: "other" }), operationContext(base)),
    /invalid-operation-actor/u,
  );
  assert.throws(
    () => makeUiOperationRequest(operationRequest("snooze-proposal", base.payload, { issuedAt: NOW + UI_PROTOCOL_LIMITS.futureSkewMs + 1 }), operationContext(base)),
    /future-operation/u,
  );
  assert.throws(
    () => makeUiOperationRequest(operationRequest("snooze-proposal", base.payload, { issuedAt: NOW, expiresAt: NOW + UI_PROTOCOL_LIMITS.operationTtlMs + 1 }), operationContext(base)),
    /invalid-operation-lifetime/u,
  );
});

test("the aggregate projection footprint binds index entries to at most two matching details", () => {
  const detail = reviewDetail();
  const index = projectionIndex({
    reviews: [{ ...projectionIndex().reviews[0], detailHash: detail.detailHash, detailRevision: detail.revision }],
  });
  const result = assertUiProjectionFootprint(index, [detail], projectionContext());
  assert.equal(result.index.projectionHash, index.projectionHash);
  assert.equal(result.details[0].detailHash, detail.detailHash);
  assert.ok(result.bytes > 0 && result.bytes <= UI_PROTOCOL_LIMITS.totalProjectionBytes);
  assert.ok(Object.isFrozen(result));

  const stale = reviewDetail({ generation: H("9") });
  assert.throws(() => assertUiProjectionFootprint(index, [stale], projectionContext()), /stale-generation/u);
  const unlisted = reviewDetail({ proposalId: "proposal-unlisted" });
  assert.throws(() => assertUiProjectionFootprint(index, [unlisted], projectionContext()), /unlisted-review-detail/u);
  assert.throws(() => assertUiProjectionFootprint(index, [detail, detail], projectionContext()), /duplicate-review-detail/u);
  assert.throws(() => assertUiProjectionFootprint(index, [detail, detail, detail], projectionContext()), /resident-details-out-of-bounds/u);

  const readOnlyIndex = projectionIndex({
    capabilities: ["projection-index-v1", "projection-review-detail-v1"],
    reviews: [{ ...projectionIndex().reviews[0], detailHash: detail.detailHash, detailRevision: detail.revision }],
    operations: [],
    allowedActions: [],
    overflow: { reviews: overflow(1), operations: overflow(0), allowedActions: overflow(0) },
  });
  assert.throws(() => assertUiProjectionFootprint(readOnlyIndex, [detail], projectionContext()), /unsupported-capability/u);

  const wrongState = reviewDetail({ summary: { ...detail.summary, state: "approved" } });
  const wrongStateIndex = projectionIndex({
    reviews: [{ ...projectionIndex().reviews[0], detailHash: wrongState.detailHash, detailRevision: wrongState.revision }],
  });
  assert.throws(() => assertUiProjectionFootprint(wrongStateIndex, [wrongState], projectionContext()), /detail-state-mismatch/u);

  const wrongTarget = reviewDetail({
    summary: { ...detail.summary, target: { ...detail.summary.target, relativePath: "other/SKILL.md" } },
  });
  const wrongTargetIndex = projectionIndex({
    reviews: [{ ...projectionIndex().reviews[0], detailHash: wrongTarget.detailHash, detailRevision: wrongTarget.revision }],
  });
  assert.throws(() => assertUiProjectionFootprint(wrongTargetIndex, [wrongTarget], projectionContext()), /detail-target-mismatch/u);
});

test("the aggregate projection footprint rejects individually valid artifacts above the resident byte cap", () => {
  const makeLargeDetail = (proposalId, revision, offset) => {
    const base = reviewDetail();
    const evidence = Array.from({ length: 20 }, (_, index) => ({
      ...base.evidence[0],
      id: (offset + index).toString(16).padStart(64, "0"),
      summary: "e".repeat(1_600),
    }));
    const audit = Array.from({ length: 45 }, (_, index) => ({
      ...base.audit[0],
      id: (offset + 100 + index).toString(16).padStart(64, "0"),
      summary: "a".repeat(1_600),
    }));
    return reviewDetail({
      proposalId,
      revision,
      evidence,
      audit,
      overflow: {
        evidence: overflow(evidence.length),
        audit: overflow(audit.length),
        allowedActions: overflow(1),
      },
    });
  };
  const details = [makeLargeDetail("proposal-000", 3, 1), makeLargeDetail("proposal-001", 4, 1_000)];
  const baseReview = projectionIndex().reviews[0];
  const reviews = Array.from({ length: UI_PROTOCOL_LIMITS.reviewIndexEntries }, (_, index) => ({
    ...baseReview,
    proposalId: `proposal-${String(index).padStart(3, "0")}`,
    target: index < details.length ? details[index].summary.target.relativePath : `${"x".repeat(700)}/${index}`,
    detailRevision: index < details.length ? details[index].revision : 1,
    detailHash: index < details.length ? details[index].detailHash : H("d"),
  }));
  const index = projectionIndex({
    reviews,
    overflow: {
      reviews: overflow(reviews.length),
      operations: overflow(1),
      allowedActions: overflow(1),
    },
  });
  assert.ok(Buffer.byteLength(canonicalUiJson(index)) <= UI_PROTOCOL_LIMITS.indexBytes);
  assert.ok(details.every((detail) => Buffer.byteLength(canonicalUiJson(detail)) <= UI_PROTOCOL_LIMITS.detailBytes));
  assert.ok(
    Buffer.byteLength(canonicalUiJson(index)) + details.reduce((total, detail) => total + Buffer.byteLength(canonicalUiJson(detail)), 0)
      > UI_PROTOCOL_LIMITS.totalProjectionBytes,
  );
  assert.throws(() => assertUiProjectionFootprint(index, details, projectionContext()), /total-projection-footprint-exceeded/u);
});

test("new UI protocols do not change legacy Decision, decision-request, or control wire bytes", () => {
  const decision = makeDecision({
    proposalId: "proposal-1",
    targetHash: H("1"),
    proposedContentHash: H("2"),
    decisionVersion: 3,
    actor: "self-evolve-tui",
    timestamp: NOW,
    nonce: "decision-nonce",
    priorState: "pending",
    newState: "approved",
  });
  const decisionBytes = `{"proposalId":"proposal-1","targetHash":"${H("1")}","proposedContentHash":"${H("2")}","decisionVersion":3,"actor":"self-evolve-tui","timestamp":${NOW},"nonce":"decision-nonce","priorState":"pending","newState":"approved"}`;
  assert.deepEqual(Object.keys(decision), Decision.fields);
  assert.equal(JSON.stringify(decision), decisionBytes);

  const request = makeBridgeRequest({
    schemaVersion: SCHEMA_VERSION,
    requestId: "request-1",
    projectFingerprint: PROJECT,
    ...decision,
  }, { now: NOW, projectFingerprint: PROJECT });
  const requestBytes = `{"schemaVersion":"${SCHEMA_VERSION}","requestId":"request-1","projectFingerprint":"${PROJECT}","proposalId":"proposal-1","targetHash":"${H("1")}","proposedContentHash":"${H("2")}","decisionVersion":3,"priorState":"pending","newState":"approved","actor":"self-evolve-tui","timestamp":${NOW},"nonce":"decision-nonce"}\n`;
  assert.deepEqual(Object.keys(request), BRIDGE_REQUEST_FIELDS);
  assert.equal(`${JSON.stringify(request)}\n`, requestBytes);

  const controlRequest = makeControlRequest({
    schemaVersion: SCHEMA_VERSION,
    requestId: "control-1",
    projectFingerprint: PROJECT,
    actor: "self-evolve-tui",
    timestamp: NOW,
    settingsUpdatedAt: NOW - 1,
    settingsVersion: H("3"),
    nonce: "control-nonce",
    action: "set-mode",
    payload: { mode: "manual" },
  }, { now: NOW, projectFingerprint: PROJECT });
  assert.deepEqual(Object.keys(controlRequest), CONTROL_REQUEST_FIELDS);
  assert.equal(
    `${JSON.stringify(controlRequest)}\n`,
    `{"schemaVersion":"${SCHEMA_VERSION}","requestId":"control-1","projectFingerprint":"${PROJECT}","actor":"self-evolve-tui","timestamp":${NOW},"settingsUpdatedAt":${NOW - 1},"settingsVersion":"${H("3")}","nonce":"control-nonce","action":"set-mode","payload":{"mode":"manual"}}\n`,
  );

  const controlState = makeControlState({
    schemaVersion: SCHEMA_VERSION,
    projectFingerprint: PROJECT,
    actor: "self-evolve-integration",
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    settingsUpdatedAt: NOW - 1,
    settingsVersion: H("3"),
    stateRootIdentity: ROOT,
    nonce: "state-nonce",
    mode: "manual",
    effectiveMode: "manual",
    allowedSkillRoots: [],
    consent: { passiveCalls: false, durableObservations: false, sanitizedExcerpts: false, crossRepoAggregation: false },
    repoExcluded: false,
  }, { now: NOW, projectFingerprint: PROJECT });
  assert.deepEqual(Object.keys(controlState), CONTROL_STATE_FIELDS);
  assert.equal(
    `${JSON.stringify(controlState)}\n`,
    `{"schemaVersion":"${SCHEMA_VERSION}","projectFingerprint":"${PROJECT}","actor":"self-evolve-integration","issuedAt":${NOW},"expiresAt":${NOW + 60_000},"settingsUpdatedAt":${NOW - 1},"settingsVersion":"${H("3")}","stateRootIdentity":"${ROOT}","nonce":"state-nonce","mode":"manual","effectiveMode":"manual","allowedSkillRoots":[],"consent":{"passiveCalls":false,"durableObservations":false,"sanitizedExcerpts":false,"crossRepoAggregation":false},"repoExcluded":false}\n`,
  );

  const bridgeResponse = makeBridgeResponse({
    schemaVersion: SCHEMA_VERSION,
    requestId: "request-1",
    projectFingerprint: PROJECT,
    proposalId: "proposal-1",
    ok: false,
    status: "rejected",
    processedAt: NOW,
    reason: "stale-decision-version",
    recovered: false,
  });
  assert.deepEqual(Object.keys(bridgeResponse), BRIDGE_RESPONSE_FIELDS);
  assert.equal(
    `${JSON.stringify(bridgeResponse)}\n`,
    `{"schemaVersion":"${SCHEMA_VERSION}","requestId":"request-1","projectFingerprint":"${PROJECT}","proposalId":"proposal-1","ok":false,"status":"rejected","processedAt":${NOW},"reason":"stale-decision-version","recovered":false}\n`,
  );

  const controlResponse = makeControlResponse({
    schemaVersion: SCHEMA_VERSION,
    requestId: "control-1",
    projectFingerprint: PROJECT,
    ok: true,
    status: "accepted",
    processedAt: NOW,
    reason: null,
  });
  assert.deepEqual(Object.keys(controlResponse), CONTROL_RESPONSE_FIELDS);
  assert.equal(
    `${JSON.stringify(controlResponse)}\n`,
    `{"schemaVersion":"${SCHEMA_VERSION}","requestId":"control-1","projectFingerprint":"${PROJECT}","ok":true,"status":"accepted","processedAt":${NOW},"reason":null}\n`,
  );
});
