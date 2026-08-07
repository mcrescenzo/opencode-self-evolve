import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, makeRepoSettings } from "../self-evolve-schemas.js";
import { stateRootIdentity } from "../self-evolve-state-root.js";
import { openStore } from "../self-evolve-store.js";
import {
  UI_ACTION_CAPABILITIES,
  UI_OPERATION_PROTOCOL_VERSION,
  hashUiProtocol,
} from "../self-evolve-ui-protocol.js";
import {
  BRIDGE_FEEDBACK_REQUEST_FIELDS,
  BRIDGE_MAILBOX_DESCRIPTORS,
  BRIDGE_REQUEST_FIELDS,
  DECISION_FEEDBACK_VERSION,
  CONTROL_REQUEST_FIELDS,
  TUI_HOST_HEALTH_FIELDS,
  TUI_HOST_HEALTH_TTL_MS,
  cleanupBridge,
  consumeDecisionRequests,
  createControlRequest,
  createDecisionRequest,
  makeBridgeRequest,
  makeControlRequest,
  makeTuiHostHealth,
  pollDecisionResponse,
  pollControlResponse,
  pollUiOperationResponse,
  publishControlState,
  publishTuiHostHealth,
  readControlState,
  readTuiHostHealth,
  readProjectInbox,
  revokeTuiHostHealth,
  submitControlRequest,
  submitDecisionRequest,
  submitUiOperationRequest,
  validateBridgeExportMetadata,
} from "../self-evolve-bridge.js";

const PROJECT = "a".repeat(64);
const TARGET = "b".repeat(64);
const PROPOSED = "c".repeat(64);

function proposal(overrides = {}) {
  return {
    id: "proposal-bridge",
    projectFingerprint: PROJECT,
    skillTarget: { canonicalRoot: "/skills", relativePath: "demo/SKILL.md", currentHash: TARGET },
    proposedContentHash: PROPOSED,
    decisionVersion: 0,
    state: "pending",
    decisionNonce: "d".repeat(48),
    ...overrides,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function controlState(overrides = {}) {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    projectFingerprint: PROJECT,
    actor: "self-evolve-integration",
    issuedAt: now,
    expiresAt: now + 60_000,
    settingsUpdatedAt: now,
    settingsVersion: "e".repeat(64),
    stateRootIdentity: "f".repeat(64),
    nonce: "control-nonce",
    mode: "manual",
    effectiveMode: "manual",
    allowedSkillRoots: [],
    consent: { passiveCalls: false, durableObservations: false, sanitizedExcerpts: false, crossRepoAggregation: false },
    repoExcluded: false,
    ...overrides,
  };
}

function operationRequest(requestId, timestamp = Date.now()) {
  const body = {
    operationProtocolVersion: UI_OPERATION_PROTOCOL_VERSION,
    requestId,
    projectFingerprint: PROJECT,
    stateRootIdentity: "1".repeat(64),
    generation: "2".repeat(64),
    projectionHash: "3".repeat(64),
    action: "snooze-proposal",
    capability: UI_ACTION_CAPABILITIES["snooze-proposal"],
    actor: "self-evolve-tui",
    issuedAt: timestamp,
    expiresAt: timestamp + 30_000,
    nonce: `nonce-${requestId}`,
    payload: {
      proposalId: "proposal-bridge",
      targetHash: TARGET,
      proposedContentHash: PROPOSED,
      decisionVersion: 1,
      snoozedUntil: timestamp + 60_000,
    },
  };
  return { ...body, operationHash: hashUiProtocol("operation-request", body) };
}

function operationResponse(request, processedAt = request.issuedAt) {
  const body = {
    operationProtocolVersion: UI_OPERATION_PROTOCOL_VERSION,
    requestId: request.requestId,
    projectFingerprint: request.projectFingerprint,
    stateRootIdentity: request.stateRootIdentity,
    action: request.action,
    requestHash: request.operationHash,
    ok: true,
    status: "accepted",
    processedAt,
    reason: null,
  };
  return { ...body, responseHash: hashUiProtocol("operation-response", body) };
}

function addAtomicPublicationResidue(filePath, nonce = "0123456789abcdef") {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${nonce}.tmp`);
  fs.linkSync(filePath, temporary);
  assert.equal(fs.statSync(filePath).nlink, 2);
  return temporary;
}

test("mailbox descriptors are a closed registry for every request and response class", () => {
  assert.equal(Object.isFrozen(BRIDGE_MAILBOX_DESCRIPTORS), true);
  assert.deepEqual(BRIDGE_MAILBOX_DESCRIPTORS.map((descriptor) => descriptor.type), [
    "decision-request",
    "decision-response",
    "control-request",
    "control-response",
    "operation-request",
    "operation-response",
  ]);
  assert.equal(BRIDGE_MAILBOX_DESCRIPTORS.every(Object.isFrozen), true);
  assert.equal(new Set(BRIDGE_MAILBOX_DESCRIPTORS.map((descriptor) => descriptor.directoryName)).size, 6);
});

test("operation export envelopes are strict and response metadata is request-bound", () => {
  const request = operationRequest("operation-export", 10_000);
  const response = operationResponse(request, 10_001);
  assert.deepEqual(validateBridgeExportMetadata("operation-request", request, {
    projectFingerprint: PROJECT,
    requestId: request.requestId,
  }), request);
  assert.deepEqual(validateBridgeExportMetadata("operation-response", response, {
    projectFingerprint: PROJECT,
    requestId: request.requestId,
    request,
  }), response);
  assert.throws(() => validateBridgeExportMetadata("operation-request", {
    ...request,
    projectFingerprint: "9".repeat(64),
  }, { projectFingerprint: PROJECT, requestId: request.requestId }), /cross-project/u);
  assert.throws(() => validateBridgeExportMetadata("operation-response", {
    ...response,
    extra: true,
  }, { projectFingerprint: PROJECT, requestId: request.requestId, request }), /unknown-field/u);
  assert.throws(() => validateBridgeExportMetadata("operation-response", response, {
    projectFingerprint: PROJECT,
    requestId: request.requestId,
    request: { ...request, operationHash: "9".repeat(64) },
  }), /hash|binding|mismatch/u);
});

test("request envelopes are exact, bounded, hash-bound, and reject stale or cross-project input", () => {
  const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "approved", timestamp: Date.now(), requestId: "request-1" });
  assert.deepEqual(Object.keys(request), BRIDGE_REQUEST_FIELDS);
  assert.equal("proposedContent" in request, false);
  assert.throws(() => makeBridgeRequest({ ...request, extra: true }), /unknown-field/u);
  assert.throws(() => makeBridgeRequest({ ...request, projectFingerprint: "e".repeat(64) }, { projectFingerprint: PROJECT }), /cross-project/u);
  assert.throws(() => makeBridgeRequest({ ...request, timestamp: Date.now() - 86_400_001 }, { now: Date.now() }), /stale-request/u);
  assert.throws(() => makeBridgeRequest({ ...request, targetHash: "wrong" }), /invalid-target-hash/u);
});

test("structured rejection feedback is optional, versioned, closed, and legacy-shape compatible", () => {
  const legacy = createDecisionRequest({
    projectFingerprint: PROJECT,
    proposal: proposal(),
    newState: "rejected",
    timestamp: Date.now(),
    requestId: "legacy-rejection",
  });
  assert.deepEqual(Object.keys(legacy), BRIDGE_REQUEST_FIELDS);
  const enhanced = createDecisionRequest({
    projectFingerprint: PROJECT,
    proposal: proposal(),
    newState: "rejected",
    feedback: { reason: "wrong-scope", text: null },
    timestamp: Date.now(),
    requestId: "enhanced-rejection",
  });
  assert.deepEqual(Object.keys(enhanced), BRIDGE_FEEDBACK_REQUEST_FIELDS);
  assert.equal(enhanced.feedbackVersion, DECISION_FEEDBACK_VERSION);
  assert.deepEqual(enhanced.feedback, { reason: "wrong-scope", text: null });
  const other = createDecisionRequest({
    projectFingerprint: PROJECT,
    proposal: proposal(),
    newState: "rejected",
    feedback: { reason: "other", text: "The bounded rationale is not useful here." },
    timestamp: Date.now(),
  });
  assert.equal(other.feedback.text, "The bounded rationale is not useful here.");
  for (const feedback of [
    { reason: "unknown", text: null },
    { reason: "wrong-scope", text: "unexpected text" },
    { reason: "other", text: "" },
    { reason: "other", text: "x".repeat(513) },
  ]) {
    assert.throws(() => createDecisionRequest({
      projectFingerprint: PROJECT,
      proposal: proposal(),
      newState: "rejected",
      feedback,
      timestamp: Date.now(),
    }), /decision-feedback/u);
  }
  assert.throws(() => createDecisionRequest({
    projectFingerprint: PROJECT,
    proposal: proposal(),
    newState: "approved",
    feedback: { reason: "wrong-scope", text: null },
    timestamp: Date.now(),
  }), /decision-feedback/u);
  assert.throws(() => makeBridgeRequest({
    ...enhanced,
    feedbackVersion: 2,
  }), /unsupported-decision-feedback-version/u);
});

test("a new-skill decision request accepts the must-not-exist target hash sentinel", () => {
  const newSkill = proposal({ skillTarget: { canonicalRoot: "/skills", relativePath: "fresh/SKILL.md", currentHash: "must-not-exist" } });
  const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: newSkill, newState: "approved", timestamp: Date.now() });
  assert.equal(request.targetHash, "must-not-exist");
  // A genuinely malformed target hash is still rejected.
  assert.throws(() => createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal({ skillTarget: { canonicalRoot: "/skills", relativePath: "x/SKILL.md", currentHash: "nope" } }), newState: "approved", timestamp: Date.now() }), /invalid-target-hash/u);
});

test("TUI host-health runtime report is exact, root-bound, short-lived, and securely published", (t) => {
  const root = fixture(t);
  const issuedAt = Date.now();
  const identity = stateRootIdentity(root);
  const health = publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: identity,
    hostVersion: "1.18.3",
    issuedAt,
    nonce: "tui-health-nonce",
  });
  assert.deepEqual(Object.keys(health), TUI_HOST_HEALTH_FIELDS);
  assert.equal(health.publisherPid, process.pid);
  const filePath = path.join(root, "self-evolve", "bridge", PROJECT, "tui-host-health.json");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: identity }).hostVersion, "1.18.3");
  assert.throws(() => readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: "f".repeat(64) }), /state-root.*mismatch/u);
  assert.throws(() => readTuiHostHealth(root, PROJECT, { now: issuedAt + TUI_HOST_HEALTH_TTL_MS + 1, stateRootIdentity: identity }), /expired/u);
  assert.throws(() => makeTuiHostHealth({ ...health, extra: true }, { now: issuedAt }), /unknown-field/u);
  assert.equal(revokeTuiHostHealth(root, PROJECT, { nonce: "different-nonce", stateRootIdentity: identity }), false);
  assert.equal(revokeTuiHostHealth(root, PROJECT, { nonce: health.nonce, stateRootIdentity: identity }), true);
  assert.equal(fs.existsSync(filePath), false);
});

test("TUI host-health publication reads supported legacy repository settings before server migration", (t) => {
  const root = fixture(t);
  const projectDir = path.join(root, "self-evolve", PROJECT);
  const settingsPath = path.join(projectDir, "settings.json");
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  for (const schemaVersion of SUPPORTED_SCHEMA_VERSIONS.filter((value) => value !== SCHEMA_VERSION)) {
    const legacySettings = {
      ...makeRepoSettings({ projectFingerprint: PROJECT }),
      schemaVersion,
      consent: {
        passiveCalls: false,
        durableObservations: false,
        sanitizedExcerpts: false,
        crossRepoAggregation: false,
      },
    };
    const source = `${JSON.stringify(legacySettings)}\n`;
    fs.writeFileSync(settingsPath, source, { mode: 0o600 });

    const issuedAt = Date.now();
    const identity = stateRootIdentity(root);
    const health = publishTuiHostHealth(root, {
      projectFingerprint: PROJECT,
      stateRootIdentity: identity,
      hostVersion: "1.18.14",
      issuedAt,
      nonce: `legacy-settings-health-${schemaVersion.replaceAll(".", "-")}`,
    });

    assert.equal(health.hostVersion, "1.18.14");
    assert.equal(readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: identity }).nonce, health.nonce);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), source, "the TUI publisher must remain read-only for settings");
  }
});

test("TUI host-health publication does not relax current repository settings", (t) => {
  const root = fixture(t);
  const projectDir = path.join(root, "self-evolve", PROJECT);
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(projectDir, "settings.json"), `${JSON.stringify({
    ...makeRepoSettings({ projectFingerprint: PROJECT }),
    consent: {},
  })}\n`, { mode: 0o600 });

  assert.throws(() => publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: stateRootIdentity(root),
    hostVersion: "1.18.14",
    nonce: "current-settings-remain-strict",
  }), /unexpected field consent/u);

  fs.writeFileSync(path.join(projectDir, "settings.json"), `${JSON.stringify({
    schemaVersion: "9.0.0",
    repo: makeRepoSettings({ projectFingerprint: PROJECT }),
  })}\n`, { mode: 0o600 });
  assert.throws(() => publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: stateRootIdentity(root),
    hostVersion: "1.18.14",
    nonce: "future-wrapper-remains-strict",
  }), /unsupported-version/u);
});

test("legacy bridge quota normalization preserves repository storage overrides", (t) => {
  const root = fixture(t);
  const projectDir = path.join(root, "self-evolve", PROJECT);
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(projectDir, "settings.json"), `${JSON.stringify({
    ...makeRepoSettings({ projectFingerprint: PROJECT, budgets: { storageQuotaMiB: 0 } }),
    schemaVersion: SUPPORTED_SCHEMA_VERSIONS.find((value) => value !== SCHEMA_VERSION),
    consent: {},
  })}\n`, { mode: 0o600 });

  assert.throws(() => publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: stateRootIdentity(root),
    hostVersion: "1.18.14",
    nonce: "legacy-zero-quota",
  }), /mailbox-byte-quota-exceeded/u);
});

test("TUI host-health rejects dead publishers and stale revocation cannot delete a newer generation", (t) => {
  const root = fixture(t);
  const issuedAt = Date.now();
  const identity = stateRootIdentity(root);
  publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: identity,
    hostVersion: "1.18.3",
    publisherPid: 999_999_999,
    issuedAt,
    nonce: "dead-publisher",
  });
  assert.throws(() => readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: identity }), /stale.*publisher/u);

  publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: identity,
    hostVersion: "1.18.3",
    issuedAt,
    nonce: "new-live-publisher",
  });
  assert.equal(revokeTuiHostHealth(root, PROJECT, { nonce: "dead-publisher", stateRootIdentity: identity }), false);
  assert.equal(readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: identity }).nonce, "new-live-publisher");

  publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: identity,
    hostVersion: "1.18.3",
    publisherPid: 999_999_999,
    issuedAt,
    nonce: "dead-publisher-cleanup",
  });
  const cleanup = cleanupBridge(root, PROJECT, { now: issuedAt });
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.removed, 1);
  assert.equal(readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: identity }), null);
});

test("TUI host-health rejects writable state roots, permissive files, writable bridge ancestors, and foreign ownership", (t) => {
  const root = fixture(t);
  const issuedAt = Date.now();
  const identity = stateRootIdentity(root);
  fs.chmodSync(root, 0o770);
  assert.throws(
    () => publishTuiHostHealth(root, {
      projectFingerprint: PROJECT,
      stateRootIdentity: identity,
      hostVersion: "1.18.3",
      issuedAt,
      nonce: "insecure-root-report",
    }),
    /tui-host-health-state-root-permissions-rejected/u,
  );
  fs.chmodSync(root, 0o700);
  publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: identity,
    hostVersion: "1.18.3",
    issuedAt,
    nonce: "permission-bound-report",
  });
  const filePath = path.join(root, "self-evolve", "bridge", PROJECT, "tui-host-health.json");
  const reportOwner = fs.statSync(filePath).uid;

  fs.chmodSync(filePath, 0o644);
  assert.throws(
    () => readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: identity }),
    /tui-host-health-mode-rejected/u,
  );

  fs.chmodSync(filePath, 0o600);
  fs.chmodSync(root, 0o770);
  assert.throws(
    () => readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: identity }),
    /tui-host-health-state-root-permissions-rejected/u,
  );

  fs.chmodSync(root, 0o700);
  fs.chmodSync(path.dirname(filePath), 0o770);
  assert.throws(
    () => readTuiHostHealth(root, PROJECT, { now: issuedAt, stateRootIdentity: identity }),
    /tui-host-health-ancestor-permissions-rejected/u,
  );

  fs.chmodSync(path.dirname(filePath), 0o700);
  assert.throws(
    () => readTuiHostHealth(root, PROJECT, {
      now: issuedAt,
      stateRootIdentity: identity,
      __testEffectiveUid: reportOwner + 1,
    }),
    /tui-host-health-(?:state-root|ancestor|file)-owner-rejected/u,
  );
});

test("TUI host-health treats an EPERM publisher probe as foreign rather than live", (t) => {
  const root = fixture(t);
  const issuedAt = Date.now();
  const identity = stateRootIdentity(root);
  publishTuiHostHealth(root, {
    projectFingerprint: PROJECT,
    stateRootIdentity: identity,
    hostVersion: "1.18.3",
    issuedAt,
    nonce: "foreign-process-report",
  });
  const permissionError = Object.assign(new Error("not permitted"), { code: "EPERM" });
  assert.throws(
    () => readTuiHostHealth(root, PROJECT, {
      now: issuedAt,
      stateRootIdentity: identity,
      __testSignalProcess: () => { throw permissionError; },
    }),
    /stale-tui-host-health-publisher/u,
  );
});

test("request publication and responses are restrictive, atomic, replay-safe files", async (t) => {
  const root = fixture(t);
  const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp: Date.now(), requestId: "request-files" });
  const submitted = submitDecisionRequest(root, request);
  assert.equal(fs.statSync(submitted.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(submitted.path)).mode & 0o777, 0o700);
  assert.throws(() => submitDecisionRequest(root, request), /EEXIST|bridge-file-exists/u);

  const consumed = await consumeDecisionRequests({ stateRoot: root, projectFingerprint: PROJECT, validateAndDecide: async () => ({ ok: true }) });
  assert.equal(consumed.processed.length, 1);
  assert.equal(fs.existsSync(submitted.path), false);
  const response = pollDecisionResponse(root, PROJECT, request.requestId);
  assert.equal(response.ok, true);
  const responsePath = path.join(root, "self-evolve", "bridge", PROJECT, "responses", `${request.requestId}.json`);
  assert.equal(fs.statSync(responsePath).mode & 0o777, 0o600);
  assert.equal("proposedContent" in response, false);
});

test("owned post-link request residues converge for decision, control, and operation mailboxes", async (t) => {
  const root = fixture(t);
  const timestamp = Date.now();
  const decision = createDecisionRequest({
    projectFingerprint: PROJECT,
    proposal: proposal(),
    newState: "rejected",
    timestamp,
    requestId: "residue-decision-request",
  });
  const state = controlState({ issuedAt: timestamp, settingsUpdatedAt: timestamp });
  const control = createControlRequest({
    controlState: state,
    action: "set-mode",
    payload: { mode: "manual" },
    timestamp,
    requestId: "residue-control-request",
  });
  const operation = operationRequest("residue-operation-request", timestamp);
  const submitted = [
    submitDecisionRequest(root, decision),
    submitControlRequest(root, control),
    submitUiOperationRequest(root, operation),
  ];
  const temporaries = submitted.map(({ path: filePath }, index) => addAtomicPublicationResidue(
    filePath,
    `${index + 1}`.repeat(16),
  ));
  const effects = { decision: 0, control: 0, operation: 0 };
  const consumed = await consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    validateAndDecide: async () => { effects.decision += 1; return { ok: true }; },
    validateAndControl: async () => { effects.control += 1; return { ok: true }; },
    validateAndOperate: async () => { effects.operation += 1; return { ok: true }; },
  });
  assert.deepEqual(effects, { decision: 1, control: 1, operation: 1 });
  assert.deepEqual([consumed.processed.length, consumed.controls.length, consumed.operations.length], [1, 1, 1]);
  for (const temporary of temporaries) assert.equal(fs.existsSync(temporary), false);
  for (const { path: filePath } of submitted) assert.equal(fs.existsSync(filePath), false);
  const bridgeRoot = path.join(root, "self-evolve", "bridge", PROJECT);
  for (const [directory, requestId] of [
    ["responses", decision.requestId],
    ["control-responses", control.requestId],
    ["operation-responses", operation.requestId],
  ]) assert.equal(fs.statSync(path.join(bridgeRoot, directory, `${requestId}.json`)).nlink, 1);
});

test("owned response residues are completion markers and never repeat mailbox effects", async (t) => {
  const root = fixture(t);
  const timestamp = Date.now();
  const decision = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp, requestId: "residue-decision-response" });
  const state = controlState({ issuedAt: timestamp, settingsUpdatedAt: timestamp });
  const control = createControlRequest({ controlState: state, action: "set-mode", payload: { mode: "manual" }, timestamp, requestId: "residue-control-response" });
  const operation = operationRequest("residue-operation-response", timestamp);
  const requests = [
    submitDecisionRequest(root, decision),
    submitControlRequest(root, control),
    submitUiOperationRequest(root, operation),
  ];
  const bridgeRoot = path.join(root, "self-evolve", "bridge", PROJECT);
  const responseValues = [
    ["responses", decision.requestId, {
      schemaVersion: SCHEMA_VERSION,
      requestId: decision.requestId,
      projectFingerprint: PROJECT,
      proposalId: decision.proposalId,
      ok: true,
      status: "accepted",
      processedAt: timestamp,
      reason: null,
      recovered: false,
    }],
    ["control-responses", control.requestId, {
      schemaVersion: SCHEMA_VERSION,
      requestId: control.requestId,
      projectFingerprint: PROJECT,
      ok: true,
      status: "accepted",
      processedAt: timestamp,
      reason: null,
    }],
    ["operation-responses", operation.requestId, operationResponse(operation, timestamp)],
  ];
  const temporaries = responseValues.map(([directory, requestId, value], index) => {
    const responsePath = path.join(bridgeRoot, directory, `${requestId}.json`);
    fs.writeFileSync(responsePath, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    return addAtomicPublicationResidue(responsePath, `${index + 4}`.repeat(16));
  });
  const effects = { decision: 0, control: 0, operation: 0 };
  const consumed = await consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    validateAndDecide: async () => { effects.decision += 1; return { ok: true }; },
    validateAndControl: async () => { effects.control += 1; return { ok: true }; },
    validateAndOperate: async () => { effects.operation += 1; return { ok: true }; },
  });
  assert.deepEqual(effects, { decision: 0, control: 0, operation: 0 });
  assert.deepEqual([consumed.processed.length, consumed.controls.length, consumed.operations.length], [1, 1, 1]);
  for (const temporary of temporaries) assert.equal(fs.existsSync(temporary), false);
  for (const { path: filePath } of requests) assert.equal(fs.existsSync(filePath), false);
  for (const [directory, requestId] of responseValues) {
    assert.equal(fs.statSync(path.join(bridgeRoot, directory, `${requestId}.json`)).nlink, 1);
  }
  assert.equal(pollDecisionResponse(root, PROJECT, decision.requestId).ok, true);
  assert.equal(pollControlResponse(root, PROJECT, control.requestId).ok, true);
  assert.equal(pollUiOperationResponse(root, operation, { now: timestamp }).ok, true);
});

test("owned orphan temps are reclaimed, while unmatched foreign hard links remain fail-closed", async (t) => {
  const root = fixture(t);
  const timestamp = Date.now();
  const decision = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp, requestId: "orphan-temp-request" });
  const first = submitDecisionRequest(root, decision);
  const orphan = path.join(path.dirname(first.path), `.${path.basename(first.path)}.${process.pid}.abcdef0123456789.tmp`);
  fs.renameSync(first.path, orphan);
  assert.equal(fs.statSync(orphan).nlink, 1);
  const retried = submitDecisionRequest(root, decision);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.statSync(retried.path).nlink, 1);

  const foreign = path.join(root, "foreign-request-link");
  fs.linkSync(retried.path, foreign);
  let effects = 0;
  await assert.rejects(consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    validateAndDecide: async () => { effects += 1; return { ok: true }; },
  }), /request-replaced/u);
  assert.equal(effects, 0);
  assert.equal(fs.statSync(retried.path).nlink, 2);
  assert.equal(fs.statSync(foreign).nlink, 2);

  const secondRoot = fixture(t);
  const seed = submitDecisionRequest(secondRoot, { ...decision, requestId: "foreign-owned-name" });
  const source = path.join(secondRoot, "foreign-source");
  fs.renameSync(seed.path, source);
  const disguised = path.join(
    path.dirname(seed.path),
    `.${path.basename(seed.path)}.${process.pid}.0123456789abcdef.tmp`,
  );
  fs.linkSync(source, disguised);
  await assert.rejects(consumeDecisionRequests({
    stateRoot: secondRoot,
    projectFingerprint: PROJECT,
    validateAndDecide: async () => ({ ok: true }),
  }), /temporary-hardlink-rejected/u);
  assert.equal(fs.statSync(source).nlink, 2);
  assert.equal(fs.statSync(disguised).nlink, 2);
});

test("owned post-link consumer-lock residue converges before handler entry", async (t) => {
  const root = fixture(t);
  const timestamp = Date.now();
  const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp, requestId: "lock-residue-request" });
  submitDecisionRequest(root, request);
  const bridgeRoot = path.join(root, "self-evolve", "bridge", PROJECT);
  const lockPath = path.join(bridgeRoot, "consumer.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647, acquiredAt: 1, expiresAt: 2, nonce: "dead-lock-residue" })}\n`, { mode: 0o600, flag: "wx" });
  const temporary = addAtomicPublicationResidue(lockPath, "fedcba9876543210");
  const consumed = await consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => timestamp,
    lockTtlMs: 1,
    validateAndDecide: async () => {
      assert.equal(fs.statSync(lockPath).nlink, 1);
      assert.equal(fs.existsSync(temporary), false);
      return { ok: true };
    },
  });
  assert.equal(consumed.processed.length, 1);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(temporary), false);
});

test("a post-handler publication fault leaves the request queued for outcome-safe retry", async (t) => {
  const root = fixture(t);
  const request = createDecisionRequest({
    projectFingerprint: PROJECT,
    proposal: proposal(),
    newState: "rejected",
    timestamp: Date.now(),
    requestId: "post-handler-fault",
  });
  const submitted = submitDecisionRequest(root, request);
  let handled = 0;
  let failOnce = true;
  await assert.rejects(
    consumeDecisionRequests({
      stateRoot: root,
      projectFingerprint: PROJECT,
      validateAndDecide: async () => {
        handled += 1;
        return { ok: true };
      },
      __testAfterRequestHandled() {
        if (!failOnce) return;
        failOnce = false;
        throw new Error("publication-fault");
      },
    }),
    /publication-fault/u,
  );
  assert.equal(fs.existsSync(submitted.path), true);
  assert.equal(pollDecisionResponse(root, PROJECT, request.requestId), null);

  const retried = await consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    validateAndDecide: async () => {
      handled += 1;
      return { ok: true, recovered: true };
    },
  });
  assert.equal(retried.processed.length, 1);
  assert.equal(retried.processed[0].recovered, true);
  assert.equal(handled, 2, "the transport retries; integration supplies semantic idempotency");
  assert.equal(fs.existsSync(submitted.path), false);
});

test("consumer rejects malformed and stale requests and cleanup removes expired envelopes", async (t) => {
  const root = fixture(t);
  const valid = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp: Date.now(), requestId: "seed-dirs" });
  submitDecisionRequest(root, valid);
  const requests = path.join(root, "self-evolve", "bridge", PROJECT, "requests");
  const stale = { ...valid, requestId: "stale-request", timestamp: Date.now() - 86_400_001 };
  fs.writeFileSync(path.join(requests, "stale-request.json"), `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(requests, "malformed.json"), "{bad-json\n", { mode: 0o600 });
  const result = await consumeDecisionRequests({ stateRoot: root, projectFingerprint: PROJECT, validateAndDecide: async () => ({ ok: true }) });
  assert.equal(result.processed.find((item) => item.requestId === "stale-request").reason, "stale-request");
  const malformed = result.processed.find((item) => item.requestId === "malformed");
  assert.equal(malformed.ok, false);
  assert.equal(typeof malformed.reason, "string");

  const cleaned = cleanupBridge(root, PROJECT, { now: Date.now() + 86_400_001 });
  assert.ok(cleaned.removed >= 3);
  assert.equal(fs.readdirSync(path.join(root, "self-evolve", "bridge", PROJECT, "responses")).length, 0);
});

test("cleanup cannot remove an in-flight request or steal a live expired consumer lock", async (t) => {
  const root = fixture(t);
  const timestamp = Date.now();
  const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp, requestId: "in-flight" });
  const submitted = submitDecisionRequest(root, request);
  let release;
  let clock = timestamp;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const active = new Promise((resolve) => { entered = resolve; });
  const consuming = consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    now: () => clock,
    lockTtlMs: 1,
    validateAndDecide: async () => { clock = timestamp + 86_400_001; entered(); await waiting; return { ok: true }; },
  });
  await active;
  const cleanup = cleanupBridge(root, PROJECT, { now: timestamp + 86_400_001, lockTtlMs: 1 });
  assert.deepEqual(cleanup, { ok: false, reason: "bridge-lease-busy", removed: 0 });
  assert.equal(fs.existsSync(submitted.path), true);
  assert.equal(fs.existsSync(path.join(root, "self-evolve", "bridge", PROJECT, "consumer.lock")), true);
  release();
  assert.equal((await consuming).processed.length, 1);
  assert.equal(fs.existsSync(path.join(root, "self-evolve", "bridge", PROJECT, "consumer.lock")), false);
});

test("cleanup safely recovers an expired dead-owner lock", (t) => {
  const root = fixture(t);
  const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp: Date.now(), requestId: "seed-lock" });
  submitDecisionRequest(root, request);
  const lockPath = path.join(root, "self-evolve", "bridge", PROJECT, "consumer.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, acquiredAt: 1, expiresAt: 2, nonce: "dead-owner" }), { mode: 0o600, flag: "wx" });
  const result = cleanupBridge(root, PROJECT, { now: Date.now() });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("control envelopes use a separate exact namespace and strict action payloads", async (t) => {
  const root = fixture(t);
  const state = controlState();
  state.stateRootIdentity = stateRootIdentity(root);
  publishControlState(root, state);
  assert.deepEqual(readControlState(root, PROJECT).settingsVersion, state.settingsVersion);
  const request = createControlRequest({ controlState: state, action: "set-mode", payload: { mode: "auto" }, timestamp: state.issuedAt, requestId: "control-auto" });
  assert.deepEqual(Object.keys(request), CONTROL_REQUEST_FIELDS);
  assert.equal("proposalId" in request, false);
  assert.throws(() => makeControlRequest({ ...request, command: "mode yolo" }), /unknown-field/u);
  assert.throws(() => createControlRequest({ controlState: state, action: "unknown", payload: {}, timestamp: state.issuedAt }), /unknown-control-action/u);
  assert.throws(() => createControlRequest({ controlState: state, action: "set-mode", payload: { mode: "yolo", allowlist: [], confirmation: "ENABLE YOLO" }, timestamp: state.issuedAt }), /allowlist/u);
  assert.throws(() => createControlRequest({ controlState: state, action: "update-allowlist", payload: { allowlist: ["/skills"], confirmation: "yes" }, timestamp: state.issuedAt }), /confirmation/u);
  const repoMode = createControlRequest({
    controlState: state,
    action: "set-repo-mode",
    payload: { mode: "inherit" },
    timestamp: state.issuedAt,
    requestId: "control-repo-mode",
  });
  assert.deepEqual(repoMode.payload, { mode: "inherit" });
  for (const mode of ["manual", "auto", "yolo"]) {
    assert.equal(createControlRequest({
      controlState: state,
      action: "set-repo-mode",
      payload: { mode },
      timestamp: state.issuedAt,
      requestId: `control-repo-${mode}`,
    }).payload.mode, mode);
  }
  assert.throws(() => createControlRequest({
    controlState: state,
    action: "set-repo-mode",
    payload: { mode: "automatic" },
    timestamp: state.issuedAt,
  }), /repository-mode/u);
  assert.throws(() => createControlRequest({
    controlState: state,
    action: "set-repo-mode",
    payload: { mode: "auto", confirmation: "yes" },
    timestamp: state.issuedAt,
  }), /unknown-field/u);
  const submitted = submitControlRequest(root, request);
  assert.match(submitted.path, /control-requests/u);
  const consumed = await consumeDecisionRequests({ stateRoot: root, projectFingerprint: PROJECT, validateAndControl: async () => ({ ok: true }) });
  assert.equal(consumed.controls.length, 1);
  assert.equal(pollControlResponse(root, PROJECT, request.requestId).ok, true);
});

test("decision and control publishers share bounded mailbox bytes and file count while reserving store capacity", (t) => {
  const root = fixture(t);
  const store = openStore(root, { projectFingerprint: PROJECT });
  t.after(() => store.close());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(store.updateRepoSettings((repo) => makeRepoSettings({
    ...repo,
    budgets: { ...repo.budgets, storageQuotaMiB: 1 },
  })).ok, true);
  const state = controlState({ stateRootIdentity: stateRootIdentity(root) });
  publishControlState(root, state);

  let rejected;
  for (let index = 0; index < 256; index += 1) {
    try {
      if (index % 2 === 0) {
        submitDecisionRequest(root, createDecisionRequest({
          projectFingerprint: PROJECT,
          proposal: proposal(),
          newState: "rejected",
          timestamp: Date.now(),
          requestId: `quota-decision-${index}`,
        }));
      } else {
        submitControlRequest(root, createControlRequest({
          controlState: state,
          action: "set-mode",
          payload: { mode: "manual" },
          timestamp: state.issuedAt,
          requestId: `quota-control-${index}`,
        }));
      }
    } catch (error) {
      rejected = error;
      break;
    }
  }

  assert.match(String(rejected?.message), /mailbox-(?:byte-quota|file-count)-exceeded/u);
  const bridgeRoot = path.join(root, "self-evolve", "bridge", PROJECT);
  const requestCount = fs.readdirSync(path.join(bridgeRoot, "requests")).length
    + fs.readdirSync(path.join(bridgeRoot, "control-requests")).length;
  assert.ok(requestCount > 0 && requestCount <= 64);
  assert.doesNotThrow(() => store.writeSnapshot("quota-reserve.before", "later store write"));
  const usage = store.getProjectUsage();
  assert.ok(usage.bytesUsed <= usage.quotaBytes);
});

test("canonical state boundary rejects symlinked self-evolve, bridge, project, and mailbox ancestors", (t) => {
  for (const target of ["self-evolve", "bridge", "project", "requests", "responses"]) {
    const root = fixture(t);
    const outside = fixture(t);
    fs.writeFileSync(path.join(outside, "sentinel"), "unchanged");
    if (target === "self-evolve") {
      fs.symlinkSync(outside, path.join(root, "self-evolve"), "dir");
    } else {
      fs.mkdirSync(path.join(root, "self-evolve"), { mode: 0o700 });
      if (target === "bridge") fs.symlinkSync(outside, path.join(root, "self-evolve", "bridge"), "dir");
      else if (target === "project") {
        fs.mkdirSync(path.join(root, "self-evolve", "bridge"), { mode: 0o700 });
        fs.symlinkSync(outside, path.join(root, "self-evolve", "bridge", PROJECT), "dir");
      } else {
        fs.mkdirSync(path.join(root, "self-evolve", "bridge", PROJECT), { recursive: true, mode: 0o700 });
        fs.symlinkSync(outside, path.join(root, "self-evolve", "bridge", PROJECT, target), "dir");
      }
    }
    const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp: Date.now(), requestId: `attack-${target}` });
    assert.throws(() => submitDecisionRequest(root, request), /ancestor|boundary/u, target);
    assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "unchanged");
    assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
  }
});

test("project inbox, request, and response symlinks never read or unlink outside files", async (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.mkdirSync(path.join(root, "self-evolve"), { mode: 0o700 });
  fs.symlinkSync(outside, path.join(root, "self-evolve", PROJECT), "dir");
  fs.writeFileSync(path.join(outside, "proposals.jsonl"), "outside-secret\n");
  assert.throws(() => readProjectInbox(root, PROJECT), /ancestor/u);
  fs.unlinkSync(path.join(root, "self-evolve", PROJECT));

  const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp: Date.now(), requestId: "symlink-files" });
  const submitted = submitDecisionRequest(root, request);
  const outsideRequest = path.join(outside, "request.json");
  fs.writeFileSync(outsideRequest, `${JSON.stringify(request)}\n`);
  fs.unlinkSync(submitted.path);
  fs.symlinkSync(outsideRequest, submitted.path);
  await assert.rejects(consumeDecisionRequests({ stateRoot: root, projectFingerprint: PROJECT, validateAndDecide: async () => ({ ok: true }) }), /request-replaced/u);
  assert.equal(fs.readFileSync(outsideRequest, "utf8"), `${JSON.stringify(request)}\n`);

  fs.unlinkSync(submitted.path);
  submitDecisionRequest(root, request);
  await consumeDecisionRequests({ stateRoot: root, projectFingerprint: PROJECT, validateAndDecide: async () => ({ ok: true }) });
  const responsePath = path.join(root, "self-evolve", "bridge", PROJECT, "responses", `${request.requestId}.json`);
  const outsideResponse = path.join(outside, "response.json");
  fs.writeFileSync(outsideResponse, fs.readFileSync(responsePath));
  fs.unlinkSync(responsePath);
  fs.symlinkSync(outsideResponse, responsePath);
  assert.throws(() => pollDecisionResponse(root, PROJECT, request.requestId), /symlink|path-rejected/u);
  const cleaned = cleanupBridge(root, PROJECT);
  assert.equal(cleaned.ok, true);
  assert.equal(fs.existsSync(outsideResponse), true);
});

test("request ancestor replacement between enumeration and open fails closed without outside unlink", async (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  const request = createDecisionRequest({ projectFingerprint: PROJECT, proposal: proposal(), newState: "rejected", timestamp: Date.now(), requestId: "race-replace" });
  submitDecisionRequest(root, request);
  const requests = path.join(root, "self-evolve", "bridge", PROJECT, "requests");
  const held = path.join(root, "self-evolve", "bridge", PROJECT, "held-requests");
  const outsideRequest = path.join(outside, `${request.requestId}.json`);
  fs.writeFileSync(outsideRequest, "outside-unchanged");
  await assert.rejects(consumeDecisionRequests({
    stateRoot: root,
    projectFingerprint: PROJECT,
    validateAndDecide: async () => ({ ok: true }),
    __testBeforeRequestRead() {
      fs.renameSync(requests, held);
      fs.symlinkSync(outside, requests, "dir");
    },
  }), /request-replaced/u);
  assert.equal(fs.readFileSync(outsideRequest, "utf8"), "outside-unchanged");
  assert.equal(fs.existsSync(outsideRequest), true);
});
