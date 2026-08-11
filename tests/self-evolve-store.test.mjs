import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeTest from "node:test";
import {
  SCHEMA_VERSION,
  makeAggregateClaim,
  makeAuditEvent,
  makeApplyClaim,
  makeCircuitBreaker,
  makeDecision,
  makeEligibilityExplanation,
  makeEpisodeCursor,
  makeEvidenceCapsule,
  makeEvidenceCluster,
  makeGlobalSettings,
  makeInterventionEpoch,
  makeObservation,
  makeProposal,
  makeProposalContent,
  makeReceipt,
  makeRepoSettings,
  makeRollbackRecord,
  makeSynthesisAttempt,
  makeSynthesisOutcomeAuditEvent,
  wrapRecord,
} from "../self-evolve-schemas.js";
import {
  BRIDGE_CONTROL_STATE_RESERVE_BYTES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_MAILBOX_DESCRIPTORS,
  createControlRequest,
  createDecisionRequest,
  makeBridgeResponse,
  makeControlResponse,
} from "../self-evolve-bridge.js";
import { UI_ACTION_CAPABILITIES, UI_OPERATION_PROTOCOL_VERSION, hashUiProtocol } from "../self-evolve-ui-protocol.js";
import {
  hashContent,
  migrate,
  openStore,
  projectFingerprintFor,
  resolveProjectIdentity,
} from "../self-evolve-store.js";
import { stateMutationLockHeld } from "../self-evolve-lock.js";

const H = (character) => character.repeat(64);
const PROJECT = H("a");
const SCOPE = H("b");
const CURRENT = H("c");
const PROPOSED = H("d");
const CLUSTER = H("e");
const CAPSULE_ID = "11111111-1111-4111-8111-111111111111";
const CHILD = path.join(import.meta.dirname, "fixtures", "store-child.mjs");
const SYNTHESIS_ADMISSION_CHILD = path.join(import.meta.dirname, "fixtures", "synthesis-budget-admission.mjs");
const TRANSACTION_CRASH_CHILD = path.join(import.meta.dirname, "fixtures", "decision-transaction-crash.mjs");
const SETTINGS_TRANSACTION_CRASH_CHILD = path.join(import.meta.dirname, "fixtures", "settings-transaction-crash.mjs");
const ownedRoots = new AsyncLocalStorage();

function test(name, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  return nodeTest(name, options, (t) => ownedRoots.run([], async () => {
    try {
      return await callback(t);
    } finally {
      for (const root of ownedRoots.getStore().reverse()) rmSync(root, { recursive: true, force: true });
    }
  }));
}

function ownedTempRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const roots = ownedRoots.getStore();
  if (!roots) throw new Error("temporary root created outside a test");
  roots.push(root);
  return root;
}

function runChild(root, project, operation, value) {
  return new Promise((resolve, reject) => {
    const resultPath = path.join(root, `.store-child-result-${process.pid}-${randomUUID()}.json`);
    const args = [CHILD, root, project, operation, resultPath, ...(value === undefined ? [] : [String(value)])];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`child-exit-${code}:${stderr}`));
      else {
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf8"));
          rmSync(resultPath, { force: true });
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

function runKilledChild(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`expected-SIGKILL:${code}:${signal}:${stderr}`)));
  });
}

function runSynthesisAdmissionChild(root, project, suffix, timestamp = 1_000) {
  return new Promise((resolve, reject) => {
    const resultPath = path.join(root, `.synthesis-admission-${process.pid}-${randomUUID()}.json`);
    const child = spawn(process.execPath, [SYNTHESIS_ADMISSION_CHILD, root, project, resultPath, suffix, String(timestamp)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`child-exit-${code}:${stderr}`));
      else {
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf8"));
          rmSync(resultPath, { force: true });
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

function fixture(now = 1_000) {
  const root = ownedTempRoot("self-evolve-store-");
  return { root, store: openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => now }) };
}

function observation(createdAt = 1_000, id = H("1")) {
  return makeObservation({
    id,
    projectFingerprint: PROJECT,
    receiptIds: [H("2")],
    structuredFields: { receiptType: "repeated-command", scopeFingerprint: SCOPE, occurrences: 2 },
    incidentId: `incident-${id[0]}`,
    createdAt,
    injectionFlagged: false,
    redacted: true,
  });
}

function capsule(overrides = {}) {
  return makeEvidenceCapsule({
    capsuleId: CAPSULE_ID,
    incidentId: "capsule-incident-1",
    receiptType: "repeated-tool-error",
    targetLogicalName: "review",
    summary: "Tool lint repeatedly failed with E_CONFIG (2 occurrences).",
    createdAt: 1_000,
    expiresAt: 1_000 + 30 * 86_400_000,
    ...overrides,
  });
}

function proposal(state = "pending", decisionVersion = 0) {
  return makeProposal({
    id: "proposal-1",
    projectFingerprint: PROJECT,
    clusterId: CLUSTER,
    skillTarget: { canonicalRoot: "/skills", relativePath: "review/SKILL.md", currentHash: CURRENT },
    proposedContentHash: PROPOSED,
    rationaleText: "Repeated deterministic evidence supports this bounded skill change.",
    synthesizedAt: 1_000,
    synthesizerModelId: "mock/model",
    criticScore: 0.95,
    criticPassed: true,
    validDeterministic: true,
    state,
    injectionFlagged: false,
    decisionVersion,
  });
}

function decision() {
  return makeDecision({
    proposalId: "proposal-1",
    targetHash: CURRENT,
    proposedContentHash: PROPOSED,
    decisionVersion: 1,
    actor: "human-reviewer",
    timestamp: 1_100,
    nonce: "decision-1",
    priorState: "pending",
    newState: "approved",
  });
}

function contentChunk(proposalId = "proposal-1", contentHash = PROPOSED, createdAt = 1_000) {
  return wrapRecord("proposal-content", makeProposalContent({
    proposalId, contentHash, contentEncoding: "base64", chunkIndex: 0, chunkCount: 1,
    content: Buffer.from("bounded proposal content", "utf8").toString("base64"),
  }), createdAt);
}

function auditEnvelope(state, timestamp = 1_000) {
  const details = { state, target: "review/SKILL.md" };
  const event = makeAuditEvent({
    id: hashContent(`${state}:${timestamp}`),
    kind: "apply",
    proposalId: "proposal-1",
    actor: "self-evolve-applier",
    timestamp,
    payloadHash: hashContent(JSON.stringify(details)),
    details,
  });
  return wrapRecord("audit-event", event, timestamp);
}

function legacyContentAudit(proposalId, content, overrides = {}, timestamp = 1_000) {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const details = {
    action: "proposal-content",
    chunkCount: 1,
    chunkIndex: 0,
    content: encoded,
    contentEncoding: "base64",
    contentHash: hashContent(content),
    subjectId: proposalId,
    ...overrides,
  };
  const event = makeAuditEvent({
    id: hashContent(JSON.stringify(["legacy-content", proposalId, timestamp, details])),
    kind: "decision",
    actor: "self-evolve-synthesis",
    timestamp,
    payloadHash: hashContent(JSON.stringify(details)),
    details,
  });
  return wrapRecord("audit-event", event, timestamp);
}

function operationRequest(projectFingerprint, requestId, timestamp = 10_000) {
  const body = {
    operationProtocolVersion: UI_OPERATION_PROTOCOL_VERSION,
    requestId,
    projectFingerprint,
    stateRootIdentity: H("1"),
    generation: H("2"),
    projectionHash: H("3"),
    action: "snooze-proposal",
    capability: UI_ACTION_CAPABILITIES["snooze-proposal"],
    actor: "self-evolve-tui",
    issuedAt: timestamp,
    expiresAt: timestamp + 30_000,
    nonce: `nonce-${requestId}`,
    payload: {
      proposalId: "proposal-1",
      targetHash: CURRENT,
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

function regularTreeBytes(directory) {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const filePath = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? regularTreeBytes(filePath) : statSync(filePath).size);
  }, 0);
}

function exactTree(directory, root = directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const filePath = path.join(directory, entry.name);
      const relative = path.relative(root, filePath);
      if (entry.isDirectory()) return [{ path: relative, type: "directory" }, ...exactTree(filePath, root)];
      return [{ path: relative, type: "file", bytes: readFileSync(filePath).toString("base64") }];
    });
}

test("creates the store atomically and appends and reads records", () => {
  const { root, store } = fixture();
  const envelope = wrapRecord("observation", observation(), 1_000);
  const result = store.appendRecord(envelope);

  assert.equal(result.ok, true);
  assert.deepEqual(store.readRecords("observation"), [envelope]);
  assert.deepEqual(store.getRecord("observation", envelope.id), envelope);
  assert.equal(store.getSettings().global.mode, "manual");

  const base = path.join(root, "self-evolve");
  const state = path.join(base, PROJECT);
  assert.equal(JSON.parse(readFileSync(path.join(base, "version.json"), "utf8")).schemaVersion, SCHEMA_VERSION);
  assert.equal(readdirSync(state).some((name) => name.endsWith(".tmp")), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(state, "observations.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(state, "settings.json")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(base, "global", "settings.json")).mode & 0o777, 0o600);
  }
  store.close();
});

test("capsules deduplicate by local incident and never serialize under global state", () => {
  const { root, store } = fixture();
  assert.equal(store.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    consent: { ...global.consent, sanitizedExcerpts: true },
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  const first = capsule();
  assert.deepEqual(store.appendEvidenceCapsule(first), { ok: true, duplicate: false, capsule: first });

  const retry = capsule({
    capsuleId: "22222222-2222-4222-8222-222222222222",
    createdAt: 1_001,
    expiresAt: 1_001 + 30 * 86_400_000,
  });
  assert.deepEqual(store.appendEvidenceCapsule(retry), { ok: true, duplicate: true, capsule: first });
  assert.deepEqual(store.appendEvidenceCapsule(capsule({
    capsuleId: "33333333-3333-4333-8333-333333333333",
    summary: "A conflicting retry attempted a different summary.",
  })), { ok: false, reason: "capsule-incident-conflict" });
  assert.deepEqual(store.readEvidenceCapsules({ includeExpired: true }), [first]);

  const capsulePath = path.join(root, "self-evolve", PROJECT, "evidence-capsules.jsonl");
  assert.equal(readFileSync(capsulePath, "utf8"), `${JSON.stringify(first)}\n`);
  const globalRoot = path.join(root, "self-evolve", "global");
  const globalFiles = exactTree(globalRoot);
  assert.equal(globalFiles.some((entry) => entry.path.includes("capsule")), false);
  const globalBytes = globalFiles.filter((entry) => entry.type === "file").map((entry) => Buffer.from(entry.bytes, "base64").toString("utf8")).join("\n");
  assert.doesNotMatch(globalBytes, new RegExp(first.capsuleId, "u"));
  assert.doesNotMatch(globalBytes, /Tool lint repeatedly failed/u);
  store.close();
});

test("revocation transaction recovery deletes capsules in every project after a process kill", async () => {
  const root = ownedTempRoot("self-evolve-capsule-revocation-crash-");
  const projectB = H("b");
  const first = openStore(root, { projectFingerprint: PROJECT, now: () => 1_000 });
  const second = openStore(root, { projectFingerprint: projectB, now: () => 1_000 });
  assert.equal(first.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    consent: { ...global.consent, sanitizedExcerpts: true },
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  const firstCapsule = capsule();
  const secondCapsule = capsule({
    capsuleId: "22222222-2222-4222-8222-222222222222",
    incidentId: "capsule-incident-2",
  });
  assert.equal(first.appendEvidenceCapsule(firstCapsule).ok, true);
  assert.equal(second.appendEvidenceCapsule(secondCapsule).ok, true);
  first.close();
  second.close();

  await runKilledChild(SETTINGS_TRANSACTION_CRASH_CHILD, [
    root,
    PROJECT,
    "settings-after-audit-write",
    "revoke-excerpts",
  ]);
  assert.equal(existsSync(path.join(root, "self-evolve", PROJECT, "evidence-capsules.jsonl")), true);
  assert.equal(existsSync(path.join(root, "self-evolve", projectB, "evidence-capsules.jsonl")), true);

  const recovered = openStore(root, { projectFingerprint: PROJECT, now: () => 2_001, staleLockMs: 1 });
  assert.equal(existsSync(path.join(root, "self-evolve", PROJECT, "evidence-capsules.jsonl")), false);
  assert.equal(existsSync(path.join(root, "self-evolve", projectB, "evidence-capsules.jsonl")), false);
  assert.deepEqual(recovered.getEvidenceCapsuleSupport(firstCapsule.incidentId), {
    available: false,
    reason: "sanitized-excerpts-consent-required",
  });
  const globalText = exactTree(path.join(root, "self-evolve", "global"))
    .filter((entry) => entry.type === "file")
    .map((entry) => Buffer.from(entry.bytes, "base64").toString("utf8"))
    .join("\n");
  for (const item of [firstCapsule, secondCapsule]) {
    assert.doesNotMatch(globalText, new RegExp(item.capsuleId, "u"));
    assert.equal(globalText.includes(item.summary), false);
  }
  recovered.close();
});

test("store open rejects symlinked root and durable ancestors without touching their targets", () => {
  for (const target of ["root", "self-evolve", "project"]) {
    const parent = ownedTempRoot(`self-evolve-store-${target}-parent-`);
    const outside = ownedTempRoot(`self-evolve-store-${target}-outside-`);
    const sentinel = path.join(outside, "sentinel");
    writeFileSync(sentinel, "unchanged");
    const root = target === "root" ? path.join(parent, "state") : parent;
    if (target === "root") {
      symlinkSync(outside, root, "dir");
    } else {
      mkdirSync(path.join(root, "self-evolve"), { recursive: true });
      if (target === "self-evolve") {
        rmSync(path.join(root, "self-evolve"), { recursive: true });
        symlinkSync(outside, path.join(root, "self-evolve"), "dir");
      } else {
        symlinkSync(outside, path.join(root, "self-evolve", PROJECT), "dir");
      }
    }

    const beforeRoot = target === "root" ? readdirSync(parent) : readdirSync(root);
    const beforeSelfEvolve = target === "project" ? readdirSync(path.join(root, "self-evolve")) : null;

    assert.throws(() => openStore(root, { projectFingerprint: PROJECT }), /state-root-(?:ancestor|boundary)-rejected/u, target);
    assert.deepEqual(target === "root" ? readdirSync(parent) : readdirSync(root), beforeRoot, target);
    if (beforeSelfEvolve) assert.deepEqual(readdirSync(path.join(root, "self-evolve")), beforeSelfEvolve, target);
    assert.deepEqual(readdirSync(outside), ["sentinel"], target);
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged", target);
  }
});

test("store root and project-ancestor replacement races fail closed before durable writes", () => {
  {
    const parent = ownedTempRoot("self-evolve-store-root-race-parent-");
    const root = path.join(parent, "state");
    const held = path.join(parent, "held-state");
    const outside = ownedTempRoot("self-evolve-store-root-race-outside-");
    mkdirSync(root);
    writeFileSync(path.join(outside, "sentinel"), "unchanged");
    assert.throws(() => openStore(root, {
      projectFingerprint: PROJECT,
      faultInjection(point) {
        if (point !== "state-root-after-boundary-validation") return;
        renameSync(root, held);
        symlinkSync(outside, root, "dir");
      },
    }), /state-root-boundary-(?:rejected|replaced)/u);
    assert.deepEqual(readdirSync(outside), ["sentinel"]);
  }

  {
    const root = ownedTempRoot("self-evolve-store-project-race-");
    const outside = ownedTempRoot("self-evolve-store-project-race-outside-");
    writeFileSync(path.join(outside, "sentinel"), "unchanged");
    let armed = false;
    const store = openStore(root, {
      projectFingerprint: PROJECT,
      faultInjection(point) {
        if (!armed || point !== "state-root-before-atomic-write") return;
        armed = false;
        const project = path.join(root, "self-evolve", PROJECT);
        renameSync(project, path.join(root, "self-evolve", `${PROJECT}.held`));
        symlinkSync(outside, project, "dir");
      },
    });
    armed = true;
    assert.throws(() => store.writeSnapshot("race.before", "must-not-write"), /state-root-ancestor-rejected/u);
    assert.deepEqual(readdirSync(outside), ["sentinel"]);
    store.close();
  }
});

test("future, unsupported, and malformed partition versions are byte-preserving until purge all", () => {
  const markers = [
    ["future", '{"schemaVersion":"9.9.9"}\n', /unsupported-state-version/u],
    ["unsupported-old", '{"schemaVersion":"0.1.9"}\n', /unsupported-state-version/u],
    ["malformed-json", "{not-json\n", /malformed-state-version/u],
    ["missing-field", '{"version":"0.2.2"}\n', /malformed-state-version/u],
    ["extra-field", '{"schemaVersion":"0.2.2","extra":true}\n', /malformed-state-version/u],
    ["missing-marker", null, /malformed-state-version/u],
  ];

  for (const [label, marker, expectedError] of markers) {
    const root = ownedTempRoot(`self-evolve-store-version-${label}-`);
    const base = path.join(root, "self-evolve");
    mkdirSync(path.join(base, PROJECT), { recursive: true });
    if (marker !== null) writeFileSync(path.join(base, "version.json"), marker, { mode: 0o600 });
    writeFileSync(path.join(base, PROJECT, "sentinel.bin"), Buffer.from([0, 1, 2, 255]));
    const before = exactTree(root);

    const store = openStore(root, { projectFingerprint: PROJECT });
    assert.deepEqual(exactTree(root), before, `${label}: open must be byte-preserving`);
    assert.throws(() => store.getSettings(), expectedError, label);
    assert.throws(() => store.writeSnapshot("forbidden.before", "forbidden"), expectedError, label);
    assert.equal(store.purge({ scope: "project" }).ok, false, label);
    assert.deepEqual(exactTree(root), before, `${label}: rejected operations must be byte-preserving`);
    assert.equal(store.purge({ scope: "all" }).ok, true, label);
    assert.equal(existsSync(base), false, label);
    store.close();
  }
});

test("version replacement between admission and locked initialization fails before durable writes", () => {
  const root = ownedTempRoot("self-evolve-store-version-race-");
  const base = path.join(root, "self-evolve");
  const project = path.join(base, PROJECT);
  const versionPath = path.join(base, "version.json");
  mkdirSync(project, { recursive: true });
  writeFileSync(versionPath, JSON.stringify({ schemaVersion: SCHEMA_VERSION }));
  writeFileSync(path.join(project, "sentinel.bin"), Buffer.from([0, 1, 2, 255]));
  let inspections = 0;

  assert.throws(() => openStore(root, {
    projectFingerprint: PROJECT,
    faultInjection(point) {
      if (point !== "state-version-before-open" || ++inspections !== 2) return;
      renameSync(versionPath, `${versionPath}.held`);
      writeFileSync(versionPath, '{"schemaVersion":"9.9.9"}\n');
    },
  }), /malformed-state-version/u);
  assert.deepEqual(readdirSync(base).sort(), [PROJECT, "version.json", "version.json.held"].sort());
  assert.deepEqual(readdirSync(project), ["sentinel.bin"]);
  assert.deepEqual(readFileSync(path.join(project, "sentinel.bin")), Buffer.from([0, 1, 2, 255]));
});

test("bridge and export preboot scaffolding without a version marker admits a fresh partition", () => {
  const root = ownedTempRoot("self-evolve-store-preboot-scaffolding-");
  const base = path.join(root, "self-evolve");
  const bridge = path.join(base, "bridge", PROJECT);
  const exports = path.join(base, "exports", PROJECT);
  mkdirSync(bridge, { recursive: true });
  mkdirSync(exports, { recursive: true });
  writeFileSync(path.join(bridge, "tui-host-health.json"), "preboot-bridge-bytes\n");
  writeFileSync(path.join(exports, "pending-export.json"), "preboot-export-bytes\n");
  const bridgeBefore = exactTree(path.join(base, "bridge"));
  const exportsBefore = exactTree(path.join(base, "exports"));

  const store = openStore(root, { projectFingerprint: PROJECT });
  assert.equal(store.getSettings().repo.projectFingerprint, PROJECT);
  assert.equal(JSON.parse(readFileSync(path.join(base, "version.json"), "utf8")).schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(exactTree(path.join(base, "bridge")), bridgeBefore);
  assert.deepEqual(exactTree(path.join(base, "exports")), exportsBefore);
  store.close();
});

test("duplicate envelope IDs are idempotent", () => {
  const { store } = fixture();
  const envelope = wrapRecord("observation", observation(), 1_000);

  assert.equal(store.appendRecord(envelope).duplicate, false);
  assert.equal(store.appendRecord(envelope).duplicate, true);
  assert.equal(store.readRecords("observation").length, 1);
  store.close();
});

test("synthesis admission atomically persists one attempt and one budget charge", () => {
  const { store } = fixture();
  const current = store.getSettings().global;
  store.setGlobalSettings(makeGlobalSettings({
    ...current,
    budgets: { ...current.budgets, synthesisPerDay: 1 },
    updatedAt: current.updatedAt + 1,
  }));
  assert.equal(store.getSettings().global.budgets.synthesisPerDay, 1);
  const first = makeSynthesisAttempt({
    outcomeId: H("4"),
    proposalId: "proposal-admission-1",
    projectFingerprint: PROJECT,
    clusterId: H("5"),
    targetHash: CURRENT,
    admittedAt: 1_000,
    state: "admitted",
  });
  const second = makeSynthesisAttempt({
    ...first,
    outcomeId: H("6"),
    proposalId: "proposal-admission-2",
  });

  assert.equal(store.admitSynthesisAttempt(wrapRecord("synthesis-attempt", first, 1_000), { rootSessionIDHash: H("7") }).ok, true);
  assert.deepEqual(store.admitSynthesisAttempt(wrapRecord("synthesis-attempt", second, 1_000), { rootSessionIDHash: H("8") }), {
    ok: false,
    reason: "synthesis-budget-exhausted",
    remaining: 0,
  });

  const attempts = store.readRecords("synthesis-attempt");
  const charges = store.readRecords("audit-event").filter((record) => (
    record.payload.actor === "self-evolve-scheduler"
    && record.payload.details.action === "scheduler-budget"
    && record.payload.details.budgetType === "synthesis"
  ));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].payload.proposalId, "proposal-admission-1");
  assert.equal(charges.length, 1);
  assert.equal(charges[0].payload.details.reservationId, hashContent(`synthesis-budget-admission-v1\n${first.outcomeId}`));
  store.close();
});

test("concurrent processes cannot admit beyond the synthesis day cap", async () => {
  const { root, store } = fixture();
  const current = store.getSettings().global;
  store.setGlobalSettings(makeGlobalSettings({
    ...current,
    budgets: { ...current.budgets, synthesisPerDay: 1 },
    updatedAt: current.updatedAt + 1,
  }));
  assert.equal(store.getSettings().global.budgets.synthesisPerDay, 1);
  store.close();

  const results = await Promise.all([
    runSynthesisAdmissionChild(root, PROJECT, "first"),
    runSynthesisAdmissionChild(root, PROJECT, "second"),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.filter((result) => !result.ok), [{ ok: false, reason: "synthesis-budget-exhausted", remaining: 0 }]);

  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 1_000 });
  assert.equal(reopened.readRecords("synthesis-attempt").length, 1);
  assert.equal(reopened.readRecords("audit-event").filter((record) => (
    record.payload.actor === "self-evolve-scheduler"
    && record.payload.details.action === "scheduler-budget"
    && record.payload.details.budgetType === "synthesis"
  )).length, 1);
  reopened.close();
});

test("a lower-clock process cannot ignore a later-timestamp synthesis charge", async () => {
  const { root, store } = fixture();
  const current = store.getSettings().global;
  store.setGlobalSettings(makeGlobalSettings({
    ...current,
    budgets: { ...current.budgets, synthesisPerDay: 1 },
    updatedAt: current.updatedAt + 1,
  }));
  store.close();

  assert.equal((await runSynthesisAdmissionChild(root, PROJECT, "higher-clock", 2_000)).ok, true);
  assert.deepEqual(await runSynthesisAdmissionChild(root, PROJECT, "lower-clock", 1_000), {
    ok: false,
    reason: "synthesis-budget-exhausted",
    remaining: 0,
  });

  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 1_000 });
  assert.equal(reopened.readRecords("synthesis-attempt").length, 1);
  reopened.close();
});

test("append source reuse preserves the prior canonical bytes and atomic JSONL shape", () => {
  const { store } = fixture();
  const first = wrapRecord("observation", observation(1_000, H("1")), 1_000);
  const second = wrapRecord("observation", observation(1_001, H("3")), 1_001);
  assert.equal(store.appendRecord(first).ok, true);
  const prior = store.readRecords("observation");
  const expected = [...prior, second].map((record) => JSON.stringify(record)).join("\n") + "\n";

  assert.equal(store.appendRecord(second).ok, true);

  assert.equal(readFileSync(path.join(store.stateDir, "observations.jsonl"), "utf8"), expected);
  store.close();
});

test("compare-and-swap appends a new version and rejects stale state", () => {
  const { store } = fixture();
  store.appendRecord(wrapRecord("proposal", proposal(), 1_000));

  const changed = store.runCas("proposal", "proposal-1", "pending", (current) => ({
    ...current,
    state: "approved",
    decisionVersion: 1,
  }));
  assert.equal(changed.ok, true);
  assert.equal(changed.newRecord.payload.state, "approved");
  assert.equal(store.readRecords("proposal").length, 2);
  assert.deepEqual(store.runCas("proposal", "proposal-1", "pending", (current) => current), {
    ok: false,
    reason: "stale-prior-state",
  });
  assert.equal(store.readRecords("audit-event").some((record) => record.payload.details.action === "cas"), true);
  store.close();
});

test("compare-and-swap supports a kind-specific prior value selector", () => {
  const { store } = fixture();
  const initial = makeEpisodeCursor({
    sessionIDHash: H("f"),
    lastIdleAt: 1_000,
    lastObservedMessageHash: H("1"),
    leaseNonce: null,
  });
  const saved = store.appendRecord(wrapRecord("episode-cursor", initial, 1_000));
  assert.equal(saved.ok, true);
  const next = makeEpisodeCursor({
    ...initial,
    lastIdleAt: 1_001,
    lastObservedMessageHash: H("2"),
  });

  assert.equal(store.runCas(
    "episode-cursor",
    initial.sessionIDHash,
    H("1"),
    () => next,
    (payload) => payload.lastObservedMessageHash,
  ).ok, true);
  assert.deepEqual(store.runCas(
    "episode-cursor",
    initial.sessionIDHash,
    H("1"),
    (current) => current,
    (payload) => payload.lastObservedMessageHash,
  ), { ok: false, reason: "stale-prior-state" });
  store.close();
});

test("the mutation lock is reentrant within one store instance", () => {
  const { store } = fixture();
  store.appendRecord(wrapRecord("proposal", proposal(), 1_000));
  const changed = store.runCas("proposal", "proposal-1", "pending", (current) => {
    assert.equal(store.getSettings().global.mode, "manual");
    return { ...current, state: "approved", decisionVersion: 1 };
  });
  assert.equal(changed.ok, true);
  store.close();
});

test("leases are create-exclusive, nonce-bound, releasable, and stale-cleaning", () => {
  let now = 1_000;
  const root = ownedTempRoot("self-evolve-store-");
  const first = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => now });
  const second = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => now });

  const acquired = first.acquireLease("target", { ttlMs: 100, actor: "first" });
  assert.equal(acquired.ok, true);
  assert.deepEqual(second.acquireLease("target", { ttlMs: 100, actor: "second" }), {
    ok: false,
    reason: "lease-busy",
    currentOwner: "first",
  });
  assert.deepEqual(first.releaseLease("target", "wrong"), { ok: false, reason: "nonce-mismatch" });
  assert.equal(first.isLeaseHeld("target", 1_050), true);
  assert.deepEqual(first.releaseLease("target", acquired.nonce), { ok: true });

  const processAware = first.acquireLease("target", { ttlMs: 100, actor: "first" });
  assert.equal(processAware.ok, true);
  now = 1_101;
  assert.equal(second.isLeaseHeld("target", now), true, "a live process owner remains authoritative past synthetic expiry");
  first.releaseLease("target", processAware.nonce);
  const reacquired = second.acquireLease("target", { ttlMs: 100, actor: "second" });
  assert.equal(reacquired.ok, true);
  first.close();
  second.close();
});

test("state-root-global leases are identity-free, short-lived, and released outside the mutation lock", () => {
  let clock = 1_000;
  const root = ownedTempRoot("self-evolve-global-lease-");
  const first = openStore(root, { projectFingerprint: PROJECT, now: () => clock });
  const second = openStore(root, { projectFingerprint: H("b"), now: () => clock });
  const request = { leaseKind: "candidate-synthesis", leaseKeyHash: H("7"), ttlMs: 1_000 };

  const acquired = first.acquireGlobalLease(request);

  assert.equal(acquired.ok, true);
  assert.equal(stateMutationLockHeld(root), false, "provider work starts only after the mutation lock is released");
  assert.deepEqual(second.acquireGlobalLease(request), { ok: false, reason: "global-lease-busy" });
  assert.deepEqual(second.acquireGlobalLease({ ...request, leaseKeyHash: H("8") }), {
    ok: false,
    reason: "global-synthesis-concurrency-exhausted",
  });
  assert.deepEqual(Object.keys(acquired.lease), [
    "schemaVersion", "leaseId", "leaseKind", "leaseKeyHash", "ownerToken",
    "state", "acquiredAt", "expiresAt", "releasedAt",
  ]);
  assert.doesNotMatch(JSON.stringify(acquired.lease), new RegExp(`${PROJECT}|${H("b")}|${process.pid}`, "u"));
  assert.deepEqual(first.releaseGlobalLease({ leaseKeyHash: request.leaseKeyHash, ownerToken: "11111111-1111-4111-8111-111111111111" }), {
    ok: false,
    reason: "global-lease-owner-mismatch",
  });
  assert.equal(first.releaseGlobalLease({ leaseKeyHash: request.leaseKeyHash, ownerToken: acquired.lease.ownerToken }).ok, true);
  assert.equal(second.acquireGlobalLease(request).ok, true);
  assert.deepEqual(first.acquireGlobalLease({ ...request, leaseKeyHash: H("8"), ttlMs: 3_600_001 }), {
    ok: false,
    reason: "invalid-global-lease-ttl",
  });
  clock = 2_001;
  assert.equal(first.retain(clock).globalLeases >= 1, true);
  first.close();
  second.close();
});

test("global decision store rejects malformed direct-domain admission without durable mutation", () => {
  const root = ownedTempRoot("self-evolve-global-decision-store-");
  const store = openStore(root, { projectFingerprint: PROJECT, now: () => 1_000 });

  assert.deepEqual(store.beginGlobalDecision(null), {
    ok: false,
    reason: "invalid-global-decision-request",
  });
  assert.deepEqual(store.readGlobalApplyIntents(), []);
  assert.deepEqual(store.readGlobalDecisions(), []);
  assert.deepEqual(store.readGlobalDecisionOutcomes(), []);
  assert.deepEqual(store.readGlobalAudits(), []);
  store.close();
});

test("acquireLease removes a partial file after a write failure", () => {
  const root = ownedTempRoot("self-evolve-store-partial-lease-");
  let injectPartial = true;
  const store = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 1_000,
    faultInjection(point, details) {
      if (!injectPartial || point !== "lease-after-create") return;
      injectPartial = false;
      writeFileSync(details.descriptor, "partial", "utf8");
      const error = new Error("injected-partial-lease-write");
      error.code = "EIO";
      throw error;
    },
  });
  const leaseFile = path.join(store.stateDir, "leases", "partial.lock");

  assert.deepEqual(store.acquireLease("partial", { ttlMs: 100, actor: "owner" }), {
    ok: false,
    reason: "lease-acquire-error",
    code: "EIO",
  });
  assert.equal(existsSync(leaseFile), false);
  const retry = store.acquireLease("partial", { ttlMs: 100, actor: "owner" });
  assert.equal(retry.ok, true);
  assert.deepEqual(store.releaseLease("partial", retry.nonce), { ok: true });
  store.close();
});

test("atomic store writes fsync their temporary descriptor before rename", () => {
  const root = ownedTempRoot("self-evolve-store-fsync-");
  let syncCalls = 0;
  const store = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 1_000,
    filesystemSync(descriptor) {
      syncCalls += 1;
      fsyncSync(descriptor);
    },
  });
  syncCalls = 0;

  assert.equal(store.updateGlobalSettings((settings) => makeGlobalSettings({
    ...settings,
    paused: true,
    updatedAt: settings.updatedAt + 1,
  })).ok, true);
  assert.ok(syncCalls > 0, "transaction-intent and settings writes must be fsynced before rename");
  store.close();
});

test("corrupt leases are classified, quarantined once, and repaired only while acquiring", () => {
  const { root, store } = fixture(2_000);
  const leaseFile = path.join(store.stateDir, "leases", "broken.lock");
  writeFileSync(leaseFile, "{not-json", { mode: 0o600 });
  assert.equal(store.getLeaseStatus("broken").state, "corrupt");
  const acquired = store.acquireLease("broken", { ttlMs: 100, actor: "repair" });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.repairedCorruptLease, true);
  const quarantined = readdirSync(path.join(root, "self-evolve", PROJECT, "quarantine"))
    .filter((name) => name.startsWith("lease-broken-") && name.endsWith(".quarantined"));
  assert.equal(quarantined.length, 1);
  assert.deepEqual(store.releaseLease("broken", acquired.nonce), { ok: true });

  writeFileSync(leaseFile, JSON.stringify({ actor: "", acquiredAt: 1, expiresAt: 2, nonce: "x" }), { mode: 0o600 });
  assert.equal(store.cleanupExpiredLeases().corruptLeases, 1);
  assert.equal(readdirSync(path.join(root, "self-evolve", PROJECT, "quarantine"))
    .filter((name) => name.startsWith("lease-broken-") && name.endsWith(".quarantined")).length, 2);
  store.close();
});

test("deterministic quarantine identity hashes the complete source and bounds UTF-8 evidence bytes", () => {
  const { root, store } = fixture(2_000);
  const leaseFile = path.join(store.stateDir, "leases", "bounded.lock");
  const prefix = "x".repeat(64 * 1024);
  const quarantine = path.join(root, "self-evolve", PROJECT, "quarantine");

  writeFileSync(leaseFile, `${prefix}first`, { mode: 0o600 });
  const first = store.acquireLease("bounded", { ttlMs: 100, actor: "repair" });
  assert.equal(first.ok, true);
  assert.deepEqual(store.releaseLease("bounded", first.nonce), { ok: true });

  writeFileSync(leaseFile, `${prefix}second`, { mode: 0o600 });
  const second = store.acquireLease("bounded", { ttlMs: 100, actor: "repair" });
  assert.equal(second.ok, true);
  assert.deepEqual(store.releaseLease("bounded", second.nonce), { ok: true });

  const evidence = readdirSync(quarantine)
    .filter((name) => name.startsWith("lease-bounded-") && name.endsWith(".quarantined"));
  assert.equal(evidence.length, 2, "different complete sources must not alias on a shared prefix");
  assert.equal(evidence.every((name) => Buffer.byteLength(readFileSync(path.join(quarantine, name))) <= 64 * 1024), true);
  const sidecar = JSON.parse(readFileSync(path.join(quarantine, `${evidence[0]}.reason.json`), "utf8"));
  assert.deepEqual(sidecar, { reason: "lease-invalid-json" });

  const unicodeLease = path.join(store.stateDir, "leases", "unicode.lock");
  writeFileSync(unicodeLease, "💥".repeat(32 * 1024), { mode: 0o600 });
  const unicode = store.acquireLease("unicode", { ttlMs: 100, actor: "repair" });
  assert.equal(unicode.ok, true);
  assert.deepEqual(store.releaseLease("unicode", unicode.nonce), { ok: true });
  const unicodeEvidence = readdirSync(quarantine)
    .find((name) => name.startsWith("lease-unicode-") && name.endsWith(".quarantined"));
  assert.ok(unicodeEvidence);
  assert.ok(Buffer.byteLength(readFileSync(path.join(quarantine, unicodeEvidence))) <= 64 * 1024);
  store.close();
});

test("lease release and store close retain ownership until unlink succeeds", { skip: process.platform === "win32" }, () => {
  const { store } = fixture(2_000);
  const acquired = store.acquireLease("retry", { ttlMs: 100, actor: "owner" });
  const leases = path.join(store.stateDir, "leases");
  chmodSync(leases, 0o500);
  const failed = store.releaseLease("retry", acquired.nonce);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "lease-release-error");
  assert.equal(store.close().ok, false);
  chmodSync(leases, 0o700);
  assert.deepEqual(store.releaseLease("retry", acquired.nonce), { ok: true });
  assert.equal(store.close().ok, true);
});

test("unreadable lease files are distinct from absent or corrupt leases", { skip: process.platform === "win32" }, () => {
  const { store } = fixture(2_000);
  const leaseFile = path.join(store.stateDir, "leases", "unreadable.lock");
  writeFileSync(leaseFile, JSON.stringify({ actor: "owner", acquiredAt: 1, expiresAt: 3_000, nonce: "nonce" }), { mode: 0o600 });
  chmodSync(leaseFile, 0o000);
  const status = store.getLeaseStatus("unreadable");
  assert.equal(status.state, "error");
  assert.equal(status.reason, "lease-read-error");
  const acquired = store.acquireLease("unreadable", { ttlMs: 100, actor: "other" });
  assert.equal(acquired.ok, false);
  assert.equal(acquired.reason, "lease-read-error");
  chmodSync(leaseFile, 0o600);
  rmSync(leaseFile);
  store.close();
});

test("isLeaseHeld reclaims an expired pidless lease instead of leaving it on disk", () => {
  const { store } = fixture(2_000);
  const leaseFile = path.join(store.stateDir, "leases", "stale.lock");
  writeFileSync(leaseFile, JSON.stringify({ actor: "ghost", acquiredAt: 1_000, expiresAt: 1_010, nonce: "ghost-nonce" }), { mode: 0o600 });
  assert.equal(existsSync(leaseFile), true);
  assert.equal(store.isLeaseHeld("stale", 5_000), false);
  assert.equal(existsSync(leaseFile), false, "an expired reclaimable lease is removed by isLeaseHeld");
  store.close();
});

test("acquireLease rejects an empty or over-long actor without writing a corrupt lease", () => {
  const { store } = fixture(2_000);
  assert.deepEqual(store.acquireLease("empty", { ttlMs: 100, actor: "" }), { ok: false, reason: "invalid-actor" });
  assert.deepEqual(store.acquireLease("long", { ttlMs: 100, actor: "x".repeat(257) }), { ok: false, reason: "invalid-actor" });
  assert.equal(store.getLeaseStatus("empty").state, "absent");
  assert.equal(store.getLeaseStatus("long").state, "absent");
  store.close();
});

test("retention removes old observations and preserves proposals, decisions, and audit", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const { store } = fixture(now);
  store.appendRecord(wrapRecord("observation", observation(day, H("1")), day));
  store.appendRecord(wrapRecord("observation", observation(20 * day, H("3")), 20 * day));
  store.appendRecord(wrapRecord("proposal", proposal(), day));
  store.appendRecord(wrapRecord("decision", decision(), day));
  store.appendRecord(auditEnvelope("applied", day));

  assert.equal(store.retain(now).observations, 1);
  assert.equal(store.readRecords("observation").length, 1);
  assert.equal(store.readRecords("proposal").length, 1);
  assert.equal(store.readRecords("decision").length, 1);
  assert.equal(store.readRecords("audit-event").length, 1);
  store.close();
});

test("retention removes capsules at their exact expiry and keeps fresh project-local capsules", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const { store } = fixture(now);
  assert.equal(store.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    consent: { ...global.consent, sanitizedExcerpts: true },
    updatedAt: global.updatedAt + 1,
  })).ok, true);
  const expired = capsule({ createdAt: day, expiresAt: now });
  const fresh = capsule({
    capsuleId: "22222222-2222-4222-8222-222222222222",
    incidentId: "capsule-incident-2",
    createdAt: now - day,
    expiresAt: now + day,
  });
  assert.equal(store.appendEvidenceCapsule(expired).ok, true);
  assert.equal(store.appendEvidenceCapsule(fresh).ok, true);

  assert.equal(store.retain(now).capsules, 1);
  assert.deepEqual(store.readEvidenceCapsules({ includeExpired: true }), [fresh]);
  store.close();
});

test("retention unconditionally drains only session-status busy diagnostics", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const { store } = fixture(now);
  const appendSchedulerAudit = (action, status, index) => {
    const details = { action, sessionIDHash: H(String(index)), status, epoch: index };
    const event = makeAuditEvent({
      id: hashContent(`${action}:${status}:${index}`),
      kind: "decision",
      actor: "self-evolve-scheduler",
      timestamp: now - day,
      payloadHash: hashContent(JSON.stringify(details)),
      details,
    });
    assert.equal(store.appendRecord(wrapRecord("audit-event", event, now - day)).ok, true);
  };
  for (let index = 1; index <= 3; index += 1) appendSchedulerAudit("session-status", "busy", index);
  appendSchedulerAudit("session-status", "retry", 4);
  appendSchedulerAudit("scheduler-budget", "busy", 5);

  const removed = store.retain(now);
  const remaining = store.readRecords("audit-event").map((record) => record.payload.details);
  assert.equal(removed.audit, 3);
  assert.deepEqual(remaining.map(({ action, status }) => ({ action, status })), [
    { action: "session-status", status: "retry" },
    { action: "scheduler-budget", status: "busy" },
  ]);
  store.close();
});

test("retention keeps only the latest ui operation nonce per subject and action", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const { store } = fixture(now);
  const appendNonce = (subjectId, uiAction, index) => {
    const details = { action: "ui-operation-nonce", subjectId, uiAction, nonce: `nonce-${index}` };
    const event = makeAuditEvent({
      id: hashContent(`${subjectId}:${uiAction}:${index}`),
      kind: "decision",
      actor: "self-evolve-integration",
      timestamp: now - day + index,
      payloadHash: hashContent(JSON.stringify(details)),
      details,
    });
    assert.equal(store.appendRecord(wrapRecord("audit-event", event, now - day + index)).ok, true);
  };
  for (let index = 1; index <= 5; index += 1) appendNonce("proposal-1", "snooze-proposal", index);
  appendNonce("proposal-1", "rollback-proposal", 6);
  store.appendRecord(auditEnvelope("applied", now - day));

  const removed = store.retain(now);
  const remaining = store.readRecords("audit-event");
  const nonces = remaining.filter((record) => record.payload.details?.action === "ui-operation-nonce");
  assert.equal(removed.audit, 4);
  assert.deepEqual(nonces.map((record) => record.payload.details.nonce), ["nonce-5", "nonce-6"]);
  assert.equal(remaining.some((record) => record.payload.details?.state === "applied"), true);

  assert.equal(store.retain(now).audit, 0, "the current reusable grants survive the same retention pass");
  assert.deepEqual(
    store.readRecords("audit-event")
      .filter((record) => record.payload.details?.action === "ui-operation-nonce")
      .map((record) => record.payload.details.nonce),
    ["nonce-5", "nonce-6"],
  );
  store.close();
});

test("retention keeps only the latest control and proposal bridge nonces", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const { store } = fixture(now);
  const appendNonce = (action, proposalId, index) => {
    const details = { action, nonce: `${action}-${proposalId ?? "global"}-${index}` };
    const event = makeAuditEvent({
      id: hashContent(JSON.stringify([action, proposalId, index])),
      kind: "decision",
      ...(proposalId ? { proposalId } : {}),
      actor: "self-evolve-integration",
      timestamp: now - day + index,
      payloadHash: hashContent(JSON.stringify(details)),
      details,
    });
    assert.equal(store.appendRecord(wrapRecord("audit-event", event, now - day + index)).ok, true);
  };
  for (const action of ["control-nonce", "bridge-nonce", "headless-approval-nonce"]) {
    for (let index = 1; index <= 3; index += 1) {
      appendNonce(action, action === "control-nonce" ? null : "proposal-1", index);
    }
  }
  appendNonce("bridge-nonce", "proposal-2", 4);
  appendNonce("headless-approval-nonce", "proposal-2", 5);

  const removed = store.retain(now);
  const remaining = store.readRecords("audit-event").map((record) => record.payload);
  assert.equal(removed.audit, 6);
  assert.deepEqual(
    remaining.map((event) => [event.details.action, event.proposalId ?? null, event.details.nonce]),
    [
      ["control-nonce", null, "control-nonce-global-3"],
      ["bridge-nonce", "proposal-1", "bridge-nonce-proposal-1-3"],
      ["headless-approval-nonce", "proposal-1", "headless-approval-nonce-proposal-1-3"],
      ["bridge-nonce", "proposal-2", "bridge-nonce-proposal-2-4"],
      ["headless-approval-nonce", "proposal-2", "headless-approval-nonce-proposal-2-5"],
    ],
  );
  assert.equal(store.retain(now).audit, 0);
  store.close();
});

test("retention leaves record files untouched when no record is pruned", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const { store } = fixture(now);
  store.appendRecord(auditEnvelope("applied", now - day));
  const auditPath = path.join(store.stateDir, "audit.jsonl");
  const before = statSync(auditPath);
  const temporaryBefore = readdirSync(store.stateDir).filter((name) => name.endsWith(".tmp"));

  assert.equal(store.retain(now).audit, 0);

  const after = statSync(auditPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(readdirSync(store.stateDir).filter((name) => name.endsWith(".tmp")), temporaryBefore);
  store.close();
});

test("synthesis outcomes use audit retention and expire without affecting active proposal protection", () => {
  const day = 86_400_000;
  const now = 60 * day;
  const { root, store } = fixture(now);
  const outcome = makeSynthesisOutcomeAuditEvent({
    outcomeId: H("8"), projectFingerprint: PROJECT, clusterId: CLUSTER,
    status: "accepted", success: true, terminalAt: day, reasonCode: "accepted",
  });
  store.appendRecord(wrapRecord("audit-event", outcome, day));
  store.appendRecord(wrapRecord("proposal", proposal("pending"), day));

  assert.equal(store.retain(now).audit, 0, "60-day outcome remains inside the 90-day audit window");
  assert.equal(store.readRecords("audit-event").some((record) => record.payload.details.action === "synthesis-outcome"), true);
  assert.equal(store.retain(100 * day).audit, 1, "outcome expires after the audit window");
  assert.equal(store.readRecords("proposal").some((record) => record.payload.state === "pending"), true);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("retention applies canonical clocks to every durable record class", () => {
  const day = 86_400_000;
  const now = 120 * day;
  const old = day;
  const { store } = fixture(now);
  const records = [
    ["episode-cursor", makeEpisodeCursor({ sessionIDHash: H("9"), lastIdleAt: old, lastObservedMessageHash: H("8") }), old],
    ["receipt", makeReceipt({ receiptType: "repeated-command", signatureHash: H("4"), occurrences: 1, firstSeenAt: old, lastSeenAt: old, projectFingerprint: PROJECT, scopeFingerprint: SCOPE }), old],
    ["observation", observation(old, H("5")), old],
    ["evidence-cluster", makeEvidenceCluster({ id: H("6"), receiptType: "repeated-command", projectFingerprint: PROJECT, incidentIds: ["old-incident"], scopeFingerprint: SCOPE, occurrencesSum: 1, firstSeenAt: old, lastSeenAt: old }), old],
    ["eligibility-explanation", makeEligibilityExplanation({ clusterId: H("6"), eligible: false, reasons: ["old"], thresholdsMet: {}, thresholdsMissed: {} }), old],
    ["proposal", makeProposal({ ...proposal("rejected", 1), id: "proposal-terminal", synthesizedAt: old }), old],
    ["decision", makeDecision({ ...decision(), proposalId: "proposal-terminal", timestamp: old }), old],
    ["audit-event", makeAuditEvent({ ...auditEnvelope("failed", old).payload, proposalId: "proposal-terminal", timestamp: old }), old],
    ["rollback-record", makeRollbackRecord({ proposalId: "proposal-terminal", appliedHash: PROPOSED, rolledBackAt: old, reason: "completed" }), old],
    ["intervention-epoch", makeInterventionEpoch({ epochId: "old-epoch", startedAt: old, reason: "completed" }), old],
    ["circuit-breaker", makeCircuitBreaker({ open: true, openedAt: old, reason: "old failure", tripCount: 1 }), old],
    ["apply-claim", makeApplyClaim({ proposalId: "proposal-terminal", leaseNonce: "expired", acquiredAt: old, expiresAt: old + 1, actor: "test" }), old],
  ];
  for (const [kind, payload, timestamp] of records) assert.equal(store.appendRecord(wrapRecord(kind, payload, timestamp)).ok, true);
  const result = store.retain(now);
  assert.deepEqual({
    observations: result.observations,
    evidence: result.evidence,
    proposals: result.proposals,
    decisions: result.decisions,
    audit: result.audit,
    rollback: result.rollback,
    interventions: result.interventions,
    circuits: result.circuits,
    applyClaims: result.applyClaims,
  }, { observations: 1, evidence: 4, proposals: 1, decisions: 1, audit: 1, rollback: 1, interventions: 1, circuits: 1, applyClaims: 1 });
  assert.equal(store.exportAll().records.length, 0);
  store.close();
});

test("retention preserves active proposal chains and required snapshots while removing expired orphans", () => {
  const day = 86_400_000;
  const now = 120 * day;
  const { root, store } = fixture(now);
  const active = makeProposal({ ...proposal("applied", 2), synthesizedAt: day });
  store.appendRecord(wrapRecord("proposal", active, day));
  const required = path.join(store.snapshotRoot, `${encodeURIComponent(active.id)}.${active.proposedContentHash}.before`);
  const orphan = path.join(store.snapshotRoot, "orphan.before");
  const freshOrphan = path.join(store.snapshotRoot, "fresh.before");
  writeFileSync(required, "required", { mode: 0o600 });
  writeFileSync(orphan, "orphan", { mode: 0o600 });
  writeFileSync(freshOrphan, "fresh", { mode: 0o600 });
  utimesSync(required, new Date(day), new Date(day));
  utimesSync(orphan, new Date(day), new Date(day));
  utimesSync(freshOrphan, new Date(now), new Date(now));
  const details = { state: "readback-verified", snapshot: required, appliedHash: active.proposedContentHash, "readback-verified": true };
  const event = makeAuditEvent({ id: hashContent("required-snapshot"), kind: "apply", proposalId: active.id, actor: "self-evolve-applier", timestamp: day, payloadHash: hashContent(JSON.stringify(details)), details });
  store.appendRecord(wrapRecord("audit-event", event, day));

  const result = store.retain(now);
  assert.equal(result.snapshots, 1);
  assert.equal(existsSync(required), true);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(freshOrphan), true);
  assert.equal(store.getRecord("proposal", active.id).payload.state, "applied");
  assert.equal(store.readRecords("audit-event").some((record) => record.payload.id === event.id), true);
  assert.equal(existsSync(path.join(root, "self-evolve", PROJECT)), true);
  store.close();
});

test("proposal content remains linked to an active proposal beyond the 90-day audit TTL", () => {
  const day = 86_400_000;
  const { root, store } = fixture(120 * day);
  const active = makeProposal({ ...proposal("pending"), synthesizedAt: day });
  assert.equal(store.appendRecord(wrapRecord("proposal", active, day)).ok, true);
  assert.equal(store.appendRecord(contentChunk(active.id, active.proposedContentHash, day)).ok, true);
  store.retain(120 * day);
  assert.equal(store.getRecord("proposal", active.id).payload.state, "pending");
  assert.equal(store.readRecords("proposal-content").length, 1);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("retention protects an expired critic-pending proposal chain until synthesis recovery", () => {
  const day = 86_400_000;
  const now = 120 * day;
  const { root, store } = fixture(now);
  const draft = makeProposal({ ...proposal("critic-pending"), criticPassed: false, criticScore: 0, synthesizedAt: day });
  assert.equal(store.appendRecord(wrapRecord("proposal", draft, day)).ok, true);
  assert.equal(store.appendRecord(contentChunk(draft.id, draft.proposedContentHash, day)).ok, true);
  const criticDecision = makeDecision({
    ...decision(),
    proposalId: draft.id,
    actor: "self-evolve-critic",
    timestamp: day,
    priorState: "critic-pending",
    newState: "pending",
  });
  assert.equal(store.appendRecord(wrapRecord("decision", criticDecision, day)).ok, true);
  const details = { action: "critic-admitted", state: "critic-pending" };
  const audit = makeAuditEvent({ id: hashContent("critic-pending-audit"), kind: "decision", proposalId: draft.id, actor: "self-evolve-synthesis", timestamp: day, payloadHash: hashContent(JSON.stringify(details)), details });
  assert.equal(store.appendRecord(wrapRecord("audit-event", audit, day)).ok, true);

  store.retain(now);
  assert.equal(store.getRecord("proposal", draft.id).payload.state, "critic-pending");
  assert.equal(store.readRecords("proposal-content").some((record) => record.payload.proposalId === draft.id), true);
  assert.equal(store.readRecords("decision").some((record) => record.payload.proposalId === draft.id), true);
  assert.equal(store.readRecords("audit-event").some((record) => record.payload.proposalId === draft.id), true);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("terminal proposal decisions compact content immediately and exports contain no terminal body", () => {
  const { store } = fixture(2_000);
  store.appendRecord(wrapRecord("proposal", proposal("pending"), 1_000));
  store.appendRecord(contentChunk());
  const rejected = makeDecision({ ...decision(), newState: "rejected" });
  assert.equal(store.commitDecision(rejected).ok, true);
  assert.equal(store.readRecords("proposal-content").length, 0);
  assert.doesNotMatch(JSON.stringify(store.exportAll()), /bounded proposal content|proposal-content/u);
  store.close();
});

test("legacy proposal content migration classifies every group without silently dropping active corruption", () => {
  const root = ownedTempRoot("self-evolve-store-migration-");
  const content = "bounded migrated content";
  const valid = makeProposal({ ...proposal(), id: "valid-active", proposedContentHash: hashContent(content) });
  const invalid = makeProposal({ ...proposal(), id: "invalid-active", proposedContentHash: hashContent("expected") });
  const terminal = makeProposal({ ...proposal("rejected", 1), id: "terminal-proposal", proposedContentHash: hashContent(content) });
  let store = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  for (const item of [valid, invalid, terminal]) assert.equal(store.appendRecord(wrapRecord("proposal", item, 1_000)).ok, true);
  store.close();

  const auditPath = path.join(root, "self-evolve", PROJECT, "audit.jsonl");
  for (const record of [
    legacyContentAudit(valid.id, content, {}, 1_001),
    legacyContentAudit(invalid.id, "wrong", {}, 1_002),
    legacyContentAudit(terminal.id, content, {}, 1_003),
    legacyContentAudit("missing-proposal", content, {}, 1_004),
  ]) appendFileSync(auditPath, `${JSON.stringify(record)}\n`);

  store = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  assert.equal(store.readRecords("proposal-content").filter((record) => record.payload.proposalId === valid.id).length, 1);
  assert.equal(store.getRecord("proposal", invalid.id).payload.state, "failed-closed");
  const audits = store.readRecords("audit-event");
  assert.equal(audits.some((record) => record.payload.details.action === "proposal-content"), false);
  assert.deepEqual(new Set(audits
    .filter((record) => record.payload.details.action === "legacy-proposal-content-migration")
    .map((record) => record.payload.details.outcome)), new Set(["converted", "invalid-active", "terminal", "orphan"]));
  assert.equal(readdirSync(path.join(root, "self-evolve", PROJECT, "quarantine"))
    .filter((name) => name.startsWith("legacy-proposal-") && name.endsWith(".quarantined")).length, 1);
  const counts = {
    proposal: store.readRecords("proposal").length,
    content: store.readRecords("proposal-content").length,
    audit: store.readRecords("audit-event").length,
  };
  store.close();
  store = openStore(root, { projectFingerprint: PROJECT, now: () => 3_000 });
  assert.deepEqual({
    proposal: store.readRecords("proposal").length,
    content: store.readRecords("proposal-content").length,
    audit: store.readRecords("audit-event").length,
  }, counts);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("legacy active corruption remains failed closed across an interrupted migration", () => {
  const root = ownedTempRoot("self-evolve-store-migration-crash-");
  const item = makeProposal({ ...proposal(), id: "crash-invalid", proposedContentHash: hashContent("expected") });
  let store = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  assert.equal(store.appendRecord(wrapRecord("proposal", item, 1_000)).ok, true);
  store.close();
  appendFileSync(path.join(root, "self-evolve", PROJECT, "audit.jsonl"), `${JSON.stringify(legacyContentAudit(item.id, "wrong", {}, 1_001))}\n`);

  assert.throws(() => openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 2_000,
    faultInjection(point) {
      if (point === "legacy-migration-after-proposal-write") throw new Error("simulated-crash");
    },
  }), /simulated-crash/);

  store = openStore(root, { projectFingerprint: PROJECT, now: () => 3_000 });
  assert.equal(store.getRecord("proposal", item.id).payload.state, "failed-closed");
  const migration = store.readRecords("audit-event").find((record) => record.payload.details.action === "legacy-proposal-content-migration");
  assert.equal(migration.payload.details.outcome, "invalid-active");
  assert.match(migration.payload.details.reason, /invalid-legacy-chunk-shape|hash-mismatch/);
  assert.equal(store.readRecords("audit-event").some((record) => record.payload.details.action === "proposal-content"), false);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("snapshot retention unlinks symlinks without touching their targets", { skip: process.platform === "win32" }, () => {
  const day = 86_400_000;
  const now = 120 * day;
  const { root, store } = fixture(now);
  const outside = path.join(root, "outside-secret");
  const link = path.join(store.snapshotRoot, "linked.before");
  writeFileSync(outside, "must-remain", { mode: 0o600 });
  symlinkSync(outside, link);
  assert.equal(store.retain(now).snapshots, 1);
  assert.equal(existsSync(link), false);
  assert.equal(readFileSync(outside, "utf8"), "must-remain");
  store.close();
});

test("retention removes expired lease files but leaves live leases", () => {
  let now = 1_000;
  const { store } = fixture(now);
  const legacyPath = path.join(store.stateDir, "leases", "expired.lock");
  writeFileSync(legacyPath, JSON.stringify({ actor: "legacy", acquiredAt: 1_000, expiresAt: 1_010, nonce: "legacy-expired" }), { mode: 0o600 });
  const live = store.acquireLease("live", { ttlMs: 1_000, actor: "test" });
  now = 1_100;
  const result = store.retain(now);
  assert.equal(result.leases, 1);
  assert.equal(store.isLeaseHeld("expired", now), false);
  assert.equal(store.isLeaseHeld("live", now), true);
  store.releaseLease("live", live.nonce);
  store.close();
});

test("a real retention process contends safely with append and decision writers", async () => {
  const day = 86_400_000;
  const now = 120 * day;
  const { root, store } = fixture(now);
  store.appendRecord(wrapRecord("observation", observation(day, H("7")), day));
  store.close();
  const results = await Promise.all([
    runChild(root, PROJECT, "retain", now),
    ...Array.from({ length: 6 }, () => runChild(root, PROJECT, "append-at", now)),
    ...Array.from({ length: 4 }, () => runChild(root, PROJECT, "decision", now)),
  ]);
  assert.equal(results.every((result) => result.ok !== false), true);
  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => now });
  assert.equal(reopened.readRecords("observation").length, 6);
  assert.equal(reopened.readRecords("decision").length, 4);
  reopened.close();
});

test("aggregate retention repairs contribution indexes in every project partition", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const root = ownedTempRoot("self-evolve-aggregate-retention-");
  const other = H("b");
  const first = openStore(root, { projectFingerprint: PROJECT, now: () => now });
  const second = openStore(root, { projectFingerprint: other, now: () => now });
  const claim = (id, expiresAt) => makeAggregateClaim({
    schemaVersion: SCHEMA_VERSION,
    aggregateId: id,
    claimType: "global-skill-candidate",
    receiptType: "repeated-command",
    signatureHash: H("c"),
    incidentHash: id,
    occurrenceCount: 1,
    firstSeenDay: "2026-01-01",
    lastSeenDay: "2026-01-01",
    createdAt: day,
    expiresAt,
  });
  const legacyClaims = [claim(H("1"), 20 * day), claim(H("2"), 50 * day)];
  writeFileSync(path.join(root, "self-evolve", "global", "aggregates.jsonl"), `${legacyClaims.map(JSON.stringify).join("\n")}\n`);
  writeFileSync(path.join(first.stateDir, "aggregate-contributions.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, aggregateIds: [H("1")] }));
  writeFileSync(path.join(second.stateDir, "aggregate-contributions.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, aggregateIds: [H("2")] }));
  const result = first.retain(now);
  assert.equal(result.aggregates, 1);
  assert.equal(result.indexes, 1);
  assert.equal(existsSync(path.join(first.stateDir, "aggregate-contributions.json")), false);
  assert.deepEqual(second.readAggregates({ scope: "project", includeExpired: true }).map((record) => record.aggregateId), [H("2")]);
  first.close();
  second.close();
});

test("cross-partition aggregate-index quarantine obeys the target project quota", () => {
  const now = 40 * 86_400_000;
  const root = ownedTempRoot("self-evolve-aggregate-quarantine-");
  const other = H("b");
  const first = openStore(root, { projectFingerprint: PROJECT, now: () => now });
  const second = openStore(root, { projectFingerprint: other, now: () => now });
  assert.equal(second.updateRepoSettings((repo) => makeRepoSettings({
    ...repo,
    budgets: { ...repo.budgets, storageQuotaMiB: 1 },
  })).ok, true);
  const quarantine = path.join(second.stateDir, "quarantine");
  writeFileSync(path.join(quarantine, "quota-seed.quarantined"), "q".repeat(990_000));
  writeFileSync(path.join(second.stateDir, "aggregate-contributions.json"), "x".repeat(96 * 1024));
  const before = regularTreeBytes(quarantine);
  assert.throws(() => first.retain(now), /storage-quota-exceeded/u);
  assert.equal(regularTreeBytes(quarantine), before);
  first.close();
  second.close();
});

test("corrupt and unknown-version records are quarantined without disabling the store", () => {
  const { root, store } = fixture();
  const valid = wrapRecord("observation", observation(), 1_000);
  const corrupt = { ...valid, schemaVersion: "99.0.0" };

  assert.deepEqual(store.appendRecord(corrupt), { ok: false, reason: "unsupported-version" });
  assert.equal(readdirSync(path.join(root, "self-evolve", PROJECT, "quarantine")).filter((name) => name.endsWith(".quarantined")).length, 1);
  assert.equal(store.appendRecord(valid).ok, true);
  assert.equal(store.readRecords("observation").length, 1);
  store.close();
});

test("observation and proposal purge scopes retain audit and closed proposals", () => {
  const { store } = fixture();
  store.appendRecord(wrapRecord("observation", observation(), 1_000));
  store.appendRecord(wrapRecord("proposal", proposal("pending"), 1_000));
  store.appendRecord(wrapRecord("proposal", proposal("rejected", 1), 1_001));
  store.appendRecord(auditEnvelope("applied"));

  assert.equal(store.purge({ scope: "observations" }).counts.observations, 1);
  assert.equal(store.readRecords("observation").length, 0);
  assert.equal(store.purge({ scope: "proposals" }).counts.proposals, 1);
  assert.equal(store.readRecords("proposal").length, 1);
  assert.equal(store.readRecords("proposal")[0].payload.state, "rejected");
  assert.equal(store.readRecords("audit-event").length, 3);
  store.close();
});

test("proposal purge removes every content chunk linked to a removed proposal", () => {
  const { store } = fixture();
  store.appendRecord(wrapRecord("proposal", proposal("pending"), 1_000));
  store.appendRecord(contentChunk());
  assert.equal(store.purge({ scope: "proposals" }).counts.proposals, 1);
  assert.equal(store.readRecords("proposal-content").length, 0);
  assert.doesNotMatch(JSON.stringify(store.exportAll()), /proposal-content/u);
  store.close();
});

test("project purge leaves only its purge audit while all purge removes the subtree", () => {
  const projectFixture = fixture();
  projectFixture.store.appendRecord(wrapRecord("observation", observation(), 1_000));
  projectFixture.store.appendRecord(wrapRecord("proposal", proposal(), 1_000));
  const projectResult = projectFixture.store.purge({ scope: "project" });
  assert.equal(projectResult.counts.observations, 1);
  assert.equal(projectResult.counts.proposals, 1);
  assert.equal(projectFixture.store.readRecords("audit-event").length, 1);
  assert.equal(projectFixture.store.readRecords("audit-event")[0].payload.kind, "purge");
  projectFixture.store.close();

  const allFixture = fixture();
  allFixture.store.appendRecord(wrapRecord("observation", observation(), 1_000));
  assert.equal(allFixture.store.purge({ scope: "all" }).counts.observations, 1);
  assert.equal(existsSync(path.join(allFixture.root, "self-evolve")), false);
  allFixture.store.close();
});

for (const scope of ["observations", "proposals", "project"]) {
  test(`${scope} purge preserves its in-flight operation transaction and request`, () => {
    const { root, store } = fixture(10_000);
    const requestId = `purge-${scope}-transaction`;
    const requestDigest = H(scope === "observations" ? "1" : scope === "proposals" ? "2" : "3");
    assert.equal(store.beginRequestTransaction({
      requestId,
      projectFingerprint: PROJECT,
      requestDigest,
      nonceHash: H("4"),
      action: "purge-scope",
      issuedAt: 10_000,
      expiresAt: 40_000,
    }).ok, true);
    const requestPath = path.join(root, "self-evolve", "bridge", PROJECT, "operation-requests", `${requestId}.json`);
    mkdirSync(path.dirname(requestPath), { recursive: true });
    writeFileSync(requestPath, "{}\n");
    assert.equal(store.hasPendingOperationRequest(requestId), true);
    assert.equal(store.hasPendingOperationRequest(`${requestId}-other`), false);

    assert.equal(store.purge({ scope }).ok, true);
    assert.equal(store.readRequestTransaction().requestDigest, requestDigest);
    assert.equal(store.hasPendingOperationRequest(requestId), true);
    assert.equal(existsSync(requestPath), true);
    store.close();
  });
}

test("export produces a JSON archive that round-trips", () => {
  const { store } = fixture();
  store.appendRecord(wrapRecord("observation", observation(), 1_000));
  store.appendRecord(wrapRecord("proposal", proposal(), 1_000));

  const archive = store.exportAll();
  assert.deepEqual(JSON.parse(JSON.stringify(archive)), archive);
  assert.equal(archive.projectFingerprint, PROJECT);
  assert.equal(archive.records.length, 2);
  store.close();
});

test("restart surfaces applied audit events missing readback verification", () => {
  const { root, store } = fixture();
  const applied = auditEnvelope("applied", 1_000);
  store.appendRecord(applied);
  assert.deepEqual(store.getRecoveryPending(), [applied]);
  store.close();

  const reopened = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => 2_000 });
  assert.deepEqual(reopened.getRecoveryPending(), [applied]);
  reopened.appendRecord(auditEnvelope("readback-verified", 1_100));
  assert.deepEqual(reopened.getRecoveryPending(), []);
  reopened.close();
});

test("startup quarantines a truncated JSONL tail and preserves its valid prefix", () => {
  const { root, store } = fixture();
  const envelope = wrapRecord("observation", observation(), 1_000);
  store.appendRecord(envelope);
  store.close();

  const state = path.join(root, "self-evolve", PROJECT);
  appendFileSync(path.join(state, "observations.jsonl"), '{"schemaVersion":"0.2.0","kind":"observation"', "utf8");
  const reopened = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => 2_000 });
  assert.deepEqual(reopened.readRecords("observation"), [envelope]);
  assert.equal(readdirSync(path.join(state, "quarantine")).filter((name) => name.endsWith(".quarantined")).length, 1);
  assert.equal(readFileSync(path.join(state, "observations.jsonl"), "utf8").trim(), JSON.stringify(envelope));
  reopened.close();
});

test("startup quarantines malformed decision intents and fails closed", () => {
  for (const source of ["{not-json", JSON.stringify({ protocolVersion: 1 })]) {
    const { root, store } = fixture();
    const state = store.stateDir;
    store.close();
    writeFileSync(path.join(state, "decision-transaction.json"), source, { mode: 0o600 });
    assert.throws(() => openStore(root, { projectFingerprint: PROJECT }));
    assert.equal(existsSync(path.join(state, "decision-transaction.json")), false);
    assert.equal(readdirSync(path.join(state, "quarantine")).some((name) => name.endsWith(".quarantined")), true);
  }
});

test("startup quarantines a structurally valid newer decision intent and fails closed", () => {
  const root = ownedTempRoot("self-evolve-store-newer-intent-");
  const store = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 2_000,
    faultInjection(point) { if (point === "decision-after-intent-write") throw new Error("leave-intent"); },
  });
  store.appendRecord(wrapRecord("proposal", makeProposal({ ...proposal(), id: "newer-intent-proposal" }), 1_000));
  const item = store.getRecord("proposal", "newer-intent-proposal").payload;
  const change = makeDecision({ ...decision(), proposalId: item.id });
  assert.equal(store.commitDecision(change).reason, "leave-intent");
  const intentPath = path.join(store.stateDir, "decision-transaction.json");
  const intent = JSON.parse(readFileSync(intentPath, "utf8"));
  writeFileSync(intentPath, JSON.stringify({ ...intent, protocolVersion: 99 }), { mode: 0o600 });
  store.close();
  assert.throws(() => openStore(root, { projectFingerprint: PROJECT }), /unsupported-decision-transaction/u);
  assert.equal(existsSync(intentPath), false);
});

test("fingerprints canonicalize remotes and migration rejects newer versions", () => {
  assert.equal(projectFingerprintFor("https://GitHub.com/example/repo.git/", "/one"), projectFingerprintFor("https://github.com/example/repo", "/one"));
  assert.notEqual(projectFingerprintFor("https://github.com/example/repo", "/one"), projectFingerprintFor("https://github.com/example/repo", "/two"));
  assert.equal(projectFingerprintFor("", "/tmp/project"), hashContent(JSON.stringify(["self-evolve-project-v1", "root", path.resolve("/tmp/project"), path.resolve("/tmp/project")])));
  assert.equal(migrate({ schemaVersion: "9.0.0" }), null);
  assert.equal(migrate({ schemaVersion: "0.1.0", global: {}, repo: {} }).schemaVersion, SCHEMA_VERSION);
});

test("server and TUI identity inputs resolve equally and isolate checkout locations", () => {
  const remoteUrl = "git@GitHub.com:Example/Repo.git";
  const cases = [
    { label: "no remote", remoteUrl: "", worktree: "/tmp/identity/main" },
    { label: "explicit remote", remoteUrl, worktree: "/tmp/identity/main" },
    { label: "linked worktree", remoteUrl, worktree: "/tmp/identity/linked" },
    { label: "separate clone", remoteUrl, worktree: "/tmp/identity/clone" },
    { label: "relocated checkout", remoteUrl, worktree: "/tmp/relocated/main" },
  ];
  const fingerprints = new Map();
  for (const item of cases) {
    const server = resolveProjectIdentity({ remoteUrl: item.remoteUrl, worktreePath: item.worktree, directory: "/ignored/server-directory" });
    const tui = resolveProjectIdentity({ remoteUrl: item.remoteUrl, worktreePath: item.worktree, directory: "/ignored/tui-directory" });
    assert.equal(server.projectFingerprint, tui.projectFingerprint, item.label);
    assert.equal(server.worktreePath, tui.worktreePath, item.label);
    fingerprints.set(item.label, server.projectFingerprint);
  }
  assert.notEqual(fingerprints.get("explicit remote"), fingerprints.get("linked worktree"));
  assert.notEqual(fingerprints.get("explicit remote"), fingerprints.get("separate clone"));
  assert.notEqual(fingerprints.get("explicit remote"), fingerprints.get("relocated checkout"));
});

test("explicit project identity is validated against the shared derived inputs", () => {
  const worktree = "/tmp/identity/explicit";
  const remoteUrl = "https://github.com/example/repo.git";
  const expected = projectFingerprintFor(remoteUrl, worktree);
  assert.equal(resolveProjectIdentity({ projectFingerprint: expected, remoteUrl, worktreePath: worktree }).projectFingerprint, expected);
  assert.throws(() => resolveProjectIdentity({ projectFingerprint: "not-a-fingerprint", remoteUrl, worktreePath: worktree }), /invalid-project-fingerprint/);
  assert.throws(() => resolveProjectIdentity({ projectFingerprint: H("f"), remoteUrl, worktreePath: worktree }), /project-fingerprint-mismatch/);
  assert.throws(() => resolveProjectIdentity({ remoteUrl }), /project-worktree-unavailable/);
});

test("legacy combined settings migrate once into global and repository files without merging projects", () => {
  const root = ownedTempRoot("self-evolve-store-migrate-");
  const projectDir = path.join(root, "self-evolve", PROJECT);
  const other = H("b");
  const otherDir = path.join(root, "self-evolve", other);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const combined = (fingerprint, mode, excluded) => ({
    schemaVersion: SCHEMA_VERSION,
    projectName: `legacy-${fingerprint[0]}`,
    global: makeGlobalSettings({ mode, createdAt: 1, updatedAt: 1 }),
    repo: makeRepoSettings({ projectFingerprint: fingerprint, excluded }),
  });
  writeFileSync(path.join(projectDir, "settings.json"), JSON.stringify(combined(PROJECT, "auto", false)));
  writeFileSync(path.join(otherDir, "settings.json"), JSON.stringify(combined(other, "yolo", true)));
  writeFileSync(path.join(otherDir, "observations.jsonl"), "project-evidence-must-not-migrate\n");

  const newFingerprint = H("c");
  const first = openStore(root, { projectFingerprint: newFingerprint, now: () => 2 });
  assert.equal(first.getSettings().global.mode, "auto");
  assert.equal(first.getSettings().repo.projectFingerprint, newFingerprint);
  first.close();
  const second = openStore(root, { projectFingerprint: other, now: () => 2 });
  assert.equal(second.getSettings().global.mode, "auto");
  assert.equal(second.getSettings().repo.excluded, true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(otherDir, "settings.json"), "utf8"))).sort(), ["budgets", "excluded", "mode", "projectFingerprint", "schemaVersion"]);
  assert.equal(existsSync(path.join(projectDir, "observations.jsonl")), false);
  second.close();
});

test("real child processes serialize appends and duplicate IDs without lost records", async () => {
  const { root, store } = fixture();
  store.close();
  const unique = await Promise.all(Array.from({ length: 12 }, (_, index) => runChild(root, PROJECT, "append", index)));
  assert.equal(unique.every((result) => result.ok), true);
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => runChild(root, PROJECT, "append", "duplicate")));
  assert.equal(duplicates.filter((result) => result.duplicate === false).length, 1);
  const reopened = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT });
  assert.equal(reopened.readRecords("observation").length, 13);
  reopened.close();
});

test("real child processes permit only one competing CAS transition", async () => {
  const { root, store } = fixture(10_000);
  store.appendRecord(wrapRecord("proposal", proposal(), 1_000));
  store.close();
  const results = await Promise.all([
    runChild(root, PROJECT, "cas", "approved"),
    runChild(root, PROJECT, "cas", "rejected"),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "stale-prior-state").length, 1);
  const reopened = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT });
  assert.equal(reopened.readRecords("proposal").length, 2);
  reopened.close();
});

for (const point of ["decision-after-intent-write", "decision-after-proposal-write", "decision-after-decision-write"]) {
  test(`decision transaction recovers idempotently after process kill at ${point}`, async () => {
    const { root, store } = fixture(2_000);
    store.appendRecord(wrapRecord("proposal", makeProposal({ ...proposal(), id: "transaction-proposal" }), 1_000));
    store.close();
    await runKilledChild(TRANSACTION_CRASH_CHILD, [root, PROJECT, point]);

    let reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 3_000, staleLockMs: 1 });
    assert.equal(reopened.getRecord("proposal", "transaction-proposal").payload.state, "approved");
    assert.equal(reopened.readRecords("proposal").filter((record) => record.payload.id === "transaction-proposal").length, 2);
    assert.equal(reopened.readRecords("decision").filter((record) => record.payload.proposalId === "transaction-proposal").length, 1);
    reopened.close();
    reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 4_000, staleLockMs: 1 });
    assert.equal(reopened.readRecords("proposal").filter((record) => record.payload.id === "transaction-proposal").length, 2);
    assert.equal(reopened.readRecords("decision").filter((record) => record.payload.proposalId === "transaction-proposal").length, 1);
    reopened.close();
  });
}

for (const point of ["decision-before-content-compaction", "decision-after-content-compaction"]) {
  test(`terminal decision recovery compacts content idempotently after process kill at ${point}`, async () => {
    const { root, store } = fixture(2_000);
    store.appendRecord(wrapRecord("proposal", makeProposal({ ...proposal(), id: "transaction-proposal" }), 1_000));
    store.appendRecord(contentChunk("transaction-proposal"));
    store.close();
    await runKilledChild(TRANSACTION_CRASH_CHILD, [root, PROJECT, point, "rejected"]);

    let reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 3_000, staleLockMs: 1 });
    assert.equal(reopened.getRecord("proposal", "transaction-proposal").payload.state, "rejected");
    assert.equal(reopened.readRecords("proposal-content").length, 0);
    assert.doesNotMatch(readFileSync(path.join(reopened.stateDir, "proposals.jsonl"), "utf8"), /proposal-content/u);
    reopened.close();
    reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 4_000, staleLockMs: 1 });
    assert.equal(reopened.readRecords("proposal-content").length, 0);
    assert.equal(reopened.readRecords("decision").filter((record) => record.payload.proposalId === "transaction-proposal").length, 1);
    reopened.close();
  });
}

const SETTINGS_TRANSACTION_POINTS = Object.freeze({
  global: ["settings-before-intent-write", "settings-after-intent-write", "settings-after-global-write", "settings-after-audit-write", "settings-after-transaction-remove"],
  repo: ["settings-before-intent-write", "settings-after-intent-write", "settings-after-repo-write", "settings-after-audit-write", "settings-after-transaction-remove"],
  combined: ["settings-before-intent-write", "settings-after-intent-write", "settings-after-global-write", "settings-after-repo-write", "settings-after-audit-write", "settings-after-transaction-remove"],
});

function assertSettingsTransactionOutcome(store, scope, committed) {
  const settings = store.getSettings();
  assert.equal(settings.global.mode, committed && scope !== "repo" ? "auto" : "manual");
  assert.equal(settings.repo.mode, committed && scope !== "global" ? "auto" : "inherit");
  assert.equal(settings.repo.excluded, committed && scope !== "global");
  const audits = store.readRecords("audit-event").filter((record) => record.payload.kind === "mode-change");
  assert.equal(audits.length, committed ? 1 : 0);
  if (committed) {
    assert.equal(audits[0].payload.details.action, scope === "combined" ? "global-repo-settings" : `${scope}-settings`);
  }
}

for (const [scope, points] of Object.entries(SETTINGS_TRANSACTION_POINTS)) {
  for (const point of points) {
    test(`settings transaction reports truthfully after injected ${scope} failure at ${point}`, () => {
      const root = ownedTempRoot("self-evolve-settings-transaction-");
      const store = openStore(root, {
        projectFingerprint: PROJECT,
        now: () => 2_000,
        faultInjection(current) {
          if (current === point) throw new Error("injected-settings-failure");
        },
      });
      const mutateGlobal = (global) => makeGlobalSettings({ ...global, mode: "auto", updatedAt: 2_000 });
      const mutateRepo = (repo) => makeRepoSettings({ ...repo, mode: "auto", excluded: true });
      const result = scope === "global"
        ? store.updateGlobalSettings(mutateGlobal)
        : scope === "repo"
          ? store.updateRepoSettings(mutateRepo)
          : store.updateSettings(({ global, repo }) => ({ global: mutateGlobal(global), repo: mutateRepo(repo) }));
      const committed = point !== "settings-before-intent-write";
      assert.equal(result.ok, committed);
      assertSettingsTransactionOutcome(store, scope, committed);
      assert.equal(existsSync(path.join(root, "self-evolve", "settings-transaction.json")), false);
      store.close();
      rmSync(root, { recursive: true, force: true });
    });

    test(`settings transaction recovers ${scope} update after process kill at ${point}`, async () => {
      const { root, store } = fixture(1_000);
      store.close();
      await runKilledChild(SETTINGS_TRANSACTION_CRASH_CHILD, [root, PROJECT, point, scope]);
      const committed = point !== "settings-before-intent-write";

      let reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 3_000, staleLockMs: 1 });
      assertSettingsTransactionOutcome(reopened, scope, committed);
      assert.equal(existsSync(path.join(root, "self-evolve", "settings-transaction.json")), false);
      reopened.close();
      reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 4_000, staleLockMs: 1 });
      assertSettingsTransactionOutcome(reopened, scope, committed);
      reopened.close();
      rmSync(root, { recursive: true, force: true });
    });
  }
}

test("global settings written by one project process are fresh in another project process", async () => {
  const root = ownedTempRoot("self-evolve-store-global-");
  assert.equal((await runChild(root, PROJECT, "set-global", "auto")).mode, "auto");
  assert.deepEqual(await runChild(root, H("b"), "read-global"), { mode: "auto" });
  assert.equal(existsSync(path.join(root, "self-evolve", PROJECT, "settings.json")), true);
  assert.equal(existsSync(path.join(root, "self-evolve", "global", "settings.json")), true);
});

for (const scope of ["global", "repo"]) {
  test(`identical malformed ${scope} settings produce one bounded quarantine record across reads and processes`, async () => {
    const { root, store } = fixture(1_000);
    if (scope === "repo") {
      assert.equal(store.updateGlobalSettings((global) => makeGlobalSettings({
        ...global,
        budgets: { ...global.budgets, storageQuotaMiB: 1 },
        updatedAt: global.updatedAt + 1,
      })).ok, true);
    }
    const settingsPath = scope === "global"
      ? path.join(root, "self-evolve", "global", "settings.json")
      : path.join(root, "self-evolve", PROJECT, "settings.json");
    const quarantine = path.join(path.dirname(settingsPath), "quarantine");
    const validSettings = readFileSync(settingsPath, "utf8");
    const malformed = JSON.stringify({ schemaVersion: SCHEMA_VERSION, padding: "x".repeat(96 * 1024) });
    writeFileSync(settingsPath, malformed, "utf8");
    const usageBefore = scope === "repo" ? regularTreeBytes(store.stateDir) : null;

    assert.throws(() => store.getSettings(), /corrupt-settings/u);
    const firstNames = readdirSync(quarantine).sort();
    const firstBytes = regularTreeBytes(quarantine);
    assert.equal(firstNames.filter((name) => name.endsWith(".quarantined")).length, 1);
    assert.equal(firstNames.length, 2);
    assert.ok(firstBytes <= 65 * 1024, `quarantine evidence was ${firstBytes} bytes`);

    assert.throws(() => store.getSettings(), /corrupt-settings/u);
    assert.deepEqual(readdirSync(quarantine).sort(), firstNames);
    assert.equal(regularTreeBytes(quarantine), firstBytes);
    assert.deepEqual(await runChild(root, PROJECT, "read-settings-result"), { ok: false, reason: "corrupt-settings" });
    assert.deepEqual(readdirSync(quarantine).sort(), firstNames);
    assert.equal(regularTreeBytes(quarantine), firstBytes);
    if (scope === "repo") {
      assert.throws(() => store.getProjectUsage(), /corrupt-settings/u);
      assert.equal(regularTreeBytes(store.stateDir), usageBefore + firstBytes);
      writeFileSync(settingsPath, validSettings, "utf8");
      assert.equal(store.getProjectUsage().bytesUsed, regularTreeBytes(store.stateDir));
      writeFileSync(settingsPath, malformed, "utf8");
    }

    store.close();
    const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
    assert.throws(() => reopened.getSettings(), /corrupt-settings/u);
    assert.deepEqual(readdirSync(quarantine).sort(), firstNames);
    assert.equal(regularTreeBytes(quarantine), firstBytes);
    const purge = reopened.purge({ scope: scope === "repo" ? "project" : "all" });
    assert.equal(purge.ok, true);
    if (scope === "repo") assert.doesNotThrow(() => reopened.getSettings());
    else assert.equal(existsSync(path.join(root, "self-evolve")), false);
    reopened.close();
  });
}

test("distinct corrupt global settings evidence remains within the global quarantine cap", () => {
  const { root, store } = fixture(1_000);
  const settingsPath = path.join(root, "self-evolve", "global", "settings.json");
  const quarantine = path.join(root, "self-evolve", "global", "quarantine");
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(settingsPath, JSON.stringify({ padding: `${index}:${"x".repeat(70 * 1024)}` }), "utf8");
    assert.throws(() => store.getSettings(), /corrupt-settings|storage-quota-exceeded/u);
  }
  assert.ok(regularTreeBytes(quarantine) <= 512 * 1024);
  store.close();
  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  assert.throws(() => reopened.getSettings(), /corrupt-settings/u);
  assert.equal(reopened.purge({ scope: "all" }).ok, true);
  reopened.close();
});

test("exhausted repository quarantine still permits reopen and project purge", () => {
  const { root, store } = fixture(1_000);
  assert.equal(store.updateRepoSettings((repo) => makeRepoSettings({
    ...repo,
    budgets: { ...repo.budgets, storageQuotaMiB: 1 },
  })).ok, true);
  const settingsPath = path.join(store.stateDir, "settings.json");
  const quarantine = path.join(store.stateDir, "quarantine");
  writeFileSync(path.join(quarantine, "quota-seed.quarantined"), "q".repeat(990_000));
  writeFileSync(settingsPath, JSON.stringify({ padding: "x".repeat(70 * 1024) }), "utf8");
  assert.throws(() => store.getSettings(), /corrupt-settings/u);
  store.close();

  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  assert.throws(() => reopened.getSettings(), /corrupt-settings/u);
  assert.equal(reopened.purge({ scope: "project" }).ok, true);
  assert.doesNotThrow(() => reopened.getSettings());
  reopened.close();
});

test("exhausted project quarantine with corrupt JSONL still permits project purge", () => {
  const { root, store } = fixture(1_000);
  const foreign = openStore(root, { projectFingerprint: H("b"), now: () => 1_000 });
  assert.equal(store.updateRepoSettings((repo) => makeRepoSettings({
    ...repo,
    budgets: { ...repo.budgets, storageQuotaMiB: 1 },
  })).ok, true);
  const aggregateId = H("7");
  const legacyAggregate = makeAggregateClaim({
    schemaVersion: SCHEMA_VERSION,
    aggregateId,
    claimType: "global-skill-candidate",
    receiptType: "repeated-command",
    signatureHash: H("8"),
    incidentHash: H("9"),
    occurrenceCount: 1,
    firstSeenDay: "2026-01-01",
    lastSeenDay: "2026-01-01",
    createdAt: 1_000,
    expiresAt: 100_000,
  });
  writeFileSync(path.join(root, "self-evolve", "global", "aggregates.jsonl"), `${JSON.stringify(legacyAggregate)}\n`);
  writeFileSync(path.join(store.stateDir, "aggregate-contributions.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, aggregateIds: [aggregateId] }));
  writeFileSync(path.join(foreign.stateDir, "aggregate-contributions.json"), "{not-json", "utf8");
  foreign.close();
  const quarantine = path.join(store.stateDir, "quarantine");
  writeFileSync(path.join(quarantine, "quota-seed.quarantined"), "q".repeat(990_000));
  writeFileSync(path.join(store.stateDir, "observations.jsonl"), `${"x".repeat(64 * 1024)}\n`, "utf8");
  store.close();

  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  assert.throws(() => reopened.getSettings(), /corrupt-state/u);
  assert.equal(reopened.purge({ scope: "project" }).ok, true);
  assert.doesNotThrow(() => reopened.getSettings());
  assert.equal(reopened.readAggregates({ scope: "global", includeExpired: true })
    .some((record) => record.aggregateId === aggregateId), false);
  reopened.close();
});

test("a corrupt local aggregate index requires purge all without blocking it", () => {
  const { root, store } = fixture(1_000);
  assert.equal(store.updateRepoSettings((repo) => makeRepoSettings({
    ...repo,
    budgets: { ...repo.budgets, storageQuotaMiB: 1 },
  })).ok, true);
  const quarantine = path.join(store.stateDir, "quarantine");
  writeFileSync(path.join(quarantine, "quota-seed.quarantined"), "q".repeat(990_000));
  writeFileSync(path.join(store.stateDir, "observations.jsonl"), `${"x".repeat(64 * 1024)}\n`, "utf8");
  writeFileSync(path.join(store.stateDir, "aggregate-contributions.json"), "{not-json", "utf8");
  store.close();

  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  assert.equal(reopened.purge({ scope: "project" }).ok, false);
  assert.equal(reopened.purge({ scope: "all" }).ok, true);
  reopened.close();
});

test("exhausted global quarantine with corrupt aggregates still permits purge all", () => {
  const { root, store } = fixture(1_000);
  const settingsPath = path.join(root, "self-evolve", "global", "settings.json");
  const aggregatesPath = path.join(root, "self-evolve", "global", "aggregates.jsonl");
  const validSettings = readFileSync(settingsPath, "utf8");
  for (let index = 0; index < 7; index += 1) {
    writeFileSync(settingsPath, JSON.stringify({ padding: `${index}:${"x".repeat(70 * 1024)}` }), "utf8");
    assert.throws(() => store.getSettings(), /corrupt-settings/u);
  }
  writeFileSync(settingsPath, validSettings, "utf8");
  writeFileSync(aggregatesPath, `${"x".repeat(96 * 1024)}\n`, "utf8");
  store.close();

  const reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  assert.throws(() => reopened.getSettings(), /corrupt-state/u);
  assert.equal(reopened.purge({ scope: "all" }).ok, true);
  reopened.close();
});

test("ordinary record quarantine cannot exceed a repository quota override", () => {
  const { root, store } = fixture(1_000);
  assert.equal(store.updateRepoSettings((repo) => makeRepoSettings({
    ...repo,
    budgets: { ...repo.budgets, storageQuotaMiB: 1 },
  })).ok, true);
  const quarantine = path.join(store.stateDir, "quarantine");
  writeFileSync(path.join(quarantine, "quota-seed.quarantined"), "q".repeat(990_000));
  writeFileSync(path.join(store.stateDir, "observations.jsonl"), `${"x".repeat(64 * 1024)}\n`, "utf8");
  const before = regularTreeBytes(quarantine);
  assert.throws(() => store.readRecords("observation"), /storage-quota-exceeded/u);
  assert.equal(regularTreeBytes(quarantine), before);
  store.close();
});

test("real child settings updaters preserve unrelated global and repository fields", async () => {
  const root = ownedTempRoot("self-evolve-store-settings-cas-");
  const allowlist = path.join(root, "skills");
  mkdirSync(allowlist);
  const initial = openStore(root, { projectFingerprint: PROJECT, now: () => 1 });
  initial.close();

  let results = await Promise.all([
    runChild(root, PROJECT, "update-global-mode", "auto"),
    runChild(root, PROJECT, "update-global-consent", "true"),
  ]);
  assert.equal(results.every((result) => result.ok), true);
  let reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 10 });
  assert.equal(reopened.getSettings().global.mode, "auto");
  assert.equal(reopened.getSettings().global.consent.sanitizedExcerpts, true);
  reopened.close();

  results = await Promise.all([
    runChild(root, PROJECT, "update-global-pause", "true"),
    runChild(root, PROJECT, "update-global-allowlist", allowlist),
  ]);
  assert.equal(results.every((result) => result.ok), true);
  reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 20 });
  assert.equal(reopened.getSettings().global.paused, true);
  assert.deepEqual(reopened.getSettings().global.allowedSkillRoots, [allowlist]);
  reopened.close();

  results = await Promise.all([
    runChild(root, PROJECT, "update-repo-mode", "manual"),
    runChild(root, PROJECT, "update-repo-excluded", "true"),
  ]);
  assert.equal(results.every((result) => result.ok), true);
  reopened = openStore(root, { projectFingerprint: PROJECT, now: () => 30 });
  assert.equal(reopened.getSettings().repo.mode, "manual");
  assert.equal(reopened.getSettings().repo.excluded, true);
  reopened.close();
});

test("settings CAS reports stale versions without invoking the mutator", () => {
  const { store } = fixture(100);
  let called = false;
  const result = store.updateGlobalSettings(() => { called = true; }, { expectedGlobalUpdatedAt: 99 });
  assert.deepEqual(result, { ok: false, reason: "stale-settings-version" });
  assert.equal(called, false);
  store.close();
});

test("one project quota covers settings, records, indexes, leases, quarantine, and snapshots", () => {
  const { root, store } = fixture(100);
  assert.equal(store.updateRepoSettings((repo) => makeRepoSettings({ ...repo, budgets: { ...repo.budgets, storageQuotaMiB: 1 } })).ok, true);
  const state = path.join(root, "self-evolve", PROJECT);
  writeFileSync(path.join(state, "quarantine", "seed.quarantined"), "q".repeat(350_000));
  writeFileSync(path.join(state, "leases", "seed.lock"), "l".repeat(350_000));
  writeFileSync(path.join(state, "aggregate-contributions.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, aggregateIds: [] }).padEnd(350_000, " "));
  assert.throws(() => store.writeSnapshot("quota.before", "s".repeat(280_000)), /storage-quota-exceeded/);
  assert.equal(store.appendRecord(wrapRecord("observation", observation(100, H("9")), 100)).reason, "storage-quota-exceeded");
  store.close();
});

test("one global byte quota combines store and global bridge replacements but excludes project sidecars", () => {
  const { root, store } = fixture(1_000);
  const globalDir = path.join(root, "self-evolve", "global");
  const globalBridgeDir = path.join(root, "self-evolve", "bridge", "global");
  const projectBridgeDir = path.join(root, "self-evolve", "bridge", PROJECT);
  mkdirSync(globalBridgeDir, { recursive: true });
  mkdirSync(projectBridgeDir, { recursive: true });
  const filler = path.join(globalBridgeDir, "quota-filler.json");
  writeFileSync(filler, "bridge-global\n");
  writeFileSync(path.join(projectBridgeDir, "project-sidecar.json"), "project-sidecar-must-not-count\n");
  const expectedBytes = regularTreeBytes(globalDir) + regularTreeBytes(globalBridgeDir);
  assert.equal(store.getGlobalUsage().bytesUsed, expectedBytes);
  store.close();

  const constrained = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 1_100,
    globalQuotaBytes: expectedBytes,
  });
  const replaceSettings = () => constrained.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    updatedAt: global.updatedAt + 1,
  }));
  assert.equal(replaceSettings().ok, true, "an equal-size replacement is admitted at the combined boundary");
  appendFileSync(filler, "x");
  assert.equal(replaceSettings().reason, "global-storage-quota-exceeded");
  rmSync(filler);
  assert.equal(replaceSettings().ok, true, "deleting global bridge bytes restores store admission");
  constrained.close();
});

test("one global file quota combines store and global bridge files with cleanup recovery", () => {
  const { root, store } = fixture(1_000);
  const globalDir = path.join(root, "self-evolve", "global");
  const globalBridgeDir = path.join(root, "self-evolve", "bridge", "global");
  const projectBridgeDir = path.join(root, "self-evolve", "bridge", PROJECT);
  mkdirSync(globalBridgeDir, { recursive: true });
  mkdirSync(projectBridgeDir, { recursive: true });
  writeFileSync(path.join(globalBridgeDir, "existing.json"), "{}\n");
  writeFileSync(path.join(projectBridgeDir, "excluded.json"), "{}\n");
  const expectedFiles = exactTree(globalDir).filter((entry) => entry.type === "file").length
    + exactTree(globalBridgeDir).filter((entry) => entry.type === "file").length;
  assert.equal(store.getGlobalUsage().filesUsed, expectedFiles);
  store.close();

  const constrained = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 1_100,
    globalQuotaFiles: expectedFiles,
  });
  const replaceSettings = () => constrained.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    updatedAt: global.updatedAt + 1,
  }));
  assert.equal(replaceSettings().ok, true, "replacement does not consume another file slot");
  const excess = path.join(globalBridgeDir, "excess.json");
  writeFileSync(excess, "{}\n");
  assert.equal(replaceSettings().reason, "global-file-quota-exceeded");
  rmSync(excess);
  assert.equal(replaceSettings().ok, true, "deleting a global bridge file restores admission");
  constrained.close();
});

test("project quota reserves each mailbox response and shared control state for all request classes", () => {
  const { root, store } = fixture(10_000);
  const bridge = path.join(root, "self-evolve", "bridge", PROJECT);
  for (const descriptor of BRIDGE_MAILBOX_DESCRIPTORS.filter((item) => item.role === "request")) {
    mkdirSync(path.join(bridge, descriptor.directoryName), { recursive: true });
  }
  const decisionDir = path.join(bridge, "requests");
  const controlDir = path.join(bridge, "control-requests");
  const operationDir = path.join(bridge, "operation-requests");
  writeFileSync(path.join(decisionDir, "decision.json"), "{}\n");
  writeFileSync(path.join(controlDir, "control.json"), "{}\n");
  writeFileSync(path.join(operationDir, "operation.json"), "{}\n");

  const physicalBytes = regularTreeBytes(store.stateDir) + regularTreeBytes(bridge);
  const responseReserve = BRIDGE_MAILBOX_DESCRIPTORS
    .filter((descriptor) => descriptor.role === "request")
    .reduce((total, descriptor) => total + descriptor.responseMaxBytes, 0);
  assert.equal(store.getProjectUsage().bytesUsed, physicalBytes + responseReserve + BRIDGE_CONTROL_STATE_RESERVE_BYTES);
  store.close();
});

test("project quota and export reject symlink-following", () => {
  const { root, store } = fixture();
  const outside = path.join(root, "outside");
  writeFileSync(outside, "outside");
  symlinkSync(outside, path.join(store.snapshotRoot, "linked.before"));
  assert.throws(() => store.getProjectUsage(), /storage-symlink-rejected/);
  assert.throws(() => store.exportAll(), /storage-symlink-rejected|export-symlink-rejected/);
  store.close();
});

test("bridge export enforces per-class bounds and rejects bridge symlinks", () => {
  const { root, store } = fixture();
  const bridge = path.join(root, "self-evolve", "bridge", PROJECT);
  const controls = path.join(bridge, "control-responses");
  mkdirSync(controls, { recursive: true });
  const oversized = path.join(controls, "oversized.json");
  writeFileSync(oversized, JSON.stringify({ ok: true }).padEnd(4 * 1024 + 1, " "));
  assert.throws(() => store.exportAll(), /export-size-exceeded/);
  rmSync(oversized);
  const outside = path.join(root, "outside-control.json");
  writeFileSync(outside, JSON.stringify({ ok: true }));
  symlinkSync(outside, path.join(controls, "linked.json"));
  assert.throws(() => store.exportAll(), /storage-symlink-rejected|export-symlink-rejected/);
  store.close();
});

test("exports reject hard-linked snapshots and unknown bridge metadata", () => {
  const { root, store } = fixture();
  const outside = path.join(root, "outside-snapshot");
  writeFileSync(outside, "SECRET-CANARY");
  linkSync(outside, path.join(store.snapshotRoot, "linked.before"));
  assert.throws(() => store.exportAll(), /hardlink-rejected/);
  rmSync(path.join(store.snapshotRoot, "linked.before"));

  const requestDir = path.join(root, "self-evolve", "bridge", PROJECT, "requests");
  mkdirSync(requestDir, { recursive: true });
  const request = createDecisionRequest({
    projectFingerprint: PROJECT,
    proposal: {
      id: "export-invalid",
      skillTarget: { canonicalRoot: "/skills", relativePath: "demo/SKILL.md", currentHash: CURRENT },
      proposedContentHash: PROPOSED,
      decisionVersion: 0,
      state: "pending",
      decisionNonce: "export-invalid-nonce",
    },
    newState: "rejected",
    timestamp: 10_000,
    requestId: "export-invalid",
  });
  const invalidDecisionPath = path.join(requestDir, "export-invalid.json");
  writeFileSync(invalidDecisionPath, JSON.stringify({ ...request, rawUnrelatedSecret: "SECRET-BRIDGE" }));
  assert.throws(() => store.exportAll(), /unknown-field/);
  rmSync(invalidDecisionPath);

  const operationDir = path.join(root, "self-evolve", "bridge", PROJECT, "operation-requests");
  mkdirSync(operationDir, { recursive: true });
  const operationPath = path.join(operationDir, "cross-project-operation.json");
  writeFileSync(operationPath, JSON.stringify(operationRequest(H("b"), "cross-project-operation")));
  assert.throws(() => store.exportAll(), /cross-project/u);
  rmSync(operationPath);

  const malformedOperation = operationRequest(PROJECT, "malformed-operation");
  writeFileSync(path.join(operationDir, "malformed-operation.json"), JSON.stringify({
    ...malformedOperation,
    rawUnrelatedSecret: "SECRET-OPERATION",
  }));
  assert.throws(() => store.exportAll(), /unknown-field/u);
  store.close();
});

test("export rejects a regular record file replaced after inventory capture", (t) => {
  const root = ownedTempRoot("self-evolve-export-race-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recordPath = path.join(root, "self-evolve", PROJECT, "observations.jsonl");
  let replaced = false;
  const store = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 10_000,
    faultInjection(point) {
      if (point !== "export-after-inventory" || replaced) return;
      replaced = true;
      renameSync(recordPath, `${recordPath}.captured`);
      writeFileSync(recordPath, `${JSON.stringify(wrapRecord("observation", observation(10_000, H("9")), 10_000))}\n`);
    },
  });
  assert.equal(store.appendRecord(wrapRecord("observation", observation(10_000), 10_000)).ok, true);
  assert.throws(() => store.exportAll(), /export-file-replaced|export-tree-replaced/);
  store.close();
});

test("export omits the operational TUI host report and tolerates heartbeat replacement", (t) => {
  const root = ownedTempRoot("self-evolve-export-tui-report-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "self-evolve", "bridge", PROJECT, "tui-host-health.json");
  let replaced = false;
  const store = openStore(root, {
    projectFingerprint: PROJECT,
    now: () => 10_000,
    faultInjection(point) {
      if (point !== "export-after-inventory" || replaced) return;
      replaced = true;
      writeFileSync(reportPath, "heartbeat-two\n", "utf8");
    },
  });
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, "heartbeat-one\n", "utf8");

  const archive = store.exportAll();
  const bridge = archive.bridge.find((item) => item.projectFingerprint === PROJECT);
  assert.equal(replaced, true);
  assert.equal("tuiHostHealth" in bridge, false);
  assert.doesNotMatch(JSON.stringify(archive), /heartbeat-(?:one|two)/u);
  store.close();
});

test("export all archives only the acting partition plus global state and classified bridge metadata", () => {
  const root = ownedTempRoot("self-evolve-export-all-");
  const other = H("b");
  const first = openStore(root, { projectFingerprint: PROJECT, now: () => 10_000 });
  const second = openStore(root, { projectFingerprint: other, now: () => 10_000 });
  first.writeSnapshot("first.before", "# first skill snapshot\n");
  second.writeSnapshot("second.before", "# second skill snapshot\n");
  first.appendRecord(wrapRecord("observation", observation(10_000), 10_000));
  const aggregate = makeAggregateClaim({
    schemaVersion: SCHEMA_VERSION,
    aggregateId: H("7"), claimType: "global-skill-candidate", receiptType: "repeated-command",
    signatureHash: H("8"), incidentHash: H("9"), occurrenceCount: 1,
    firstSeenDay: "1970-01-01", lastSeenDay: "1970-01-01", createdAt: 10_000, expiresAt: 20_000,
  });
  writeFileSync(path.join(root, "self-evolve", "global", "aggregates.jsonl"), `${JSON.stringify(aggregate)}\n`);
  writeFileSync(path.join(first.stateDir, "aggregate-contributions.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, aggregateIds: [aggregate.aggregateId] }));
  const requestDir = path.join(root, "self-evolve", "bridge", PROJECT, "requests");
  const responseDir = path.join(root, "self-evolve", "bridge", PROJECT, "responses");
  const controlRequestDir = path.join(root, "self-evolve", "bridge", PROJECT, "control-requests");
  const controlResponseDir = path.join(root, "self-evolve", "bridge", PROJECT, "control-responses");
  const operationRequestDir = path.join(root, "self-evolve", "bridge", PROJECT, "operation-requests");
  const operationResponseDir = path.join(root, "self-evolve", "bridge", PROJECT, "operation-responses");
  mkdirSync(requestDir, { recursive: true });
  mkdirSync(responseDir, { recursive: true });
  mkdirSync(controlRequestDir, { recursive: true });
  mkdirSync(controlResponseDir, { recursive: true });
  mkdirSync(operationRequestDir, { recursive: true });
  mkdirSync(operationResponseDir, { recursive: true });
  const exportedProposal = {
    id: "export-proposal",
    skillTarget: { canonicalRoot: "/skills", relativePath: "demo/SKILL.md", currentHash: CURRENT },
    proposedContentHash: PROPOSED,
    decisionVersion: 0,
    state: "pending",
    decisionNonce: "export-decision-nonce",
  };
  const decisionRequest = createDecisionRequest({ projectFingerprint: PROJECT, proposal: exportedProposal, newState: "rejected", timestamp: 10_000, requestId: "request" });
  const decisionResponse = makeBridgeResponse({ schemaVersion: BRIDGE_SCHEMA_VERSION, requestId: "request", projectFingerprint: PROJECT, proposalId: exportedProposal.id, ok: true, status: "accepted", processedAt: 10_000, reason: null, recovered: false });
  const exportedControlState = {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    projectFingerprint: PROJECT,
    actor: "self-evolve-integration",
    issuedAt: 10_000,
    expiresAt: 20_000,
    settingsUpdatedAt: 10_000,
    settingsVersion: H("5"),
    stateRootIdentity: H("6"),
    nonce: "export-control-nonce",
    mode: "manual",
    effectiveMode: "manual",
    allowedSkillRoots: [],
    consent: { passiveCalls: false, durableObservations: false, sanitizedExcerpts: false, crossRepoAggregation: false },
    repoExcluded: false,
  };
  const controlRequest = createControlRequest({ controlState: exportedControlState, action: "set-mode", payload: { mode: "auto" }, timestamp: 10_000, requestId: "control" });
  const controlResponse = makeControlResponse({ schemaVersion: BRIDGE_SCHEMA_VERSION, requestId: "control", projectFingerprint: PROJECT, ok: true, status: "accepted", processedAt: 10_000, reason: null });
  const operation = operationRequest(PROJECT, "operation");
  const operationResult = operationResponse(operation, 10_001);
  writeFileSync(path.join(requestDir, "request.json"), JSON.stringify(decisionRequest));
  writeFileSync(path.join(responseDir, "request.json"), JSON.stringify(decisionResponse));
  writeFileSync(path.join(controlRequestDir, "control.json"), JSON.stringify(controlRequest));
  writeFileSync(path.join(controlResponseDir, "control.json"), JSON.stringify(controlResponse));
  writeFileSync(path.join(operationRequestDir, "operation.json"), JSON.stringify(operation));
  writeFileSync(path.join(operationResponseDir, "operation.json"), JSON.stringify(operationResult));
  writeFileSync(path.join(root, "self-evolve", "bridge", PROJECT, "control-state.json"), JSON.stringify(exportedControlState));

  const archive = first.exportAll();
  assert.equal(archive.exportScope, "all");
  assert.equal(archive.classification, "sensitive-self-evolve-archive");
  assert.deepEqual(archive.projects.map((project) => project.projectFingerprint), [PROJECT]);
  assert.deepEqual(archive.projects[0].snapshots.map((snapshot) => snapshot.relativePath), ["first.before"]);
  assert.equal(archive.global.aggregates.length, 1);
  assert.equal(archive.projects.every((project) => project.snapshots[0].classification === "sensitive-skill-snapshot"), true);
  assert.equal(archive.projects.find((project) => project.projectFingerprint === PROJECT).indexes.aggregateContributions.length, 1);
  const bridge = archive.bridge.find((item) => item.projectFingerprint === PROJECT);
  assert.equal(bridge.requests[0].metadata.requestId, "request");
  assert.equal(bridge.requests[0].classification, "sensitive-decision-request-metadata");
  assert.equal(bridge.responses[0].classification, "sensitive-decision-response-metadata");
  assert.equal(bridge.controlRequests[0].metadata.action, "set-mode");
  assert.equal(bridge.controlRequests[0].classification, "sensitive-control-request-metadata");
  assert.equal(bridge.controlResponses[0].classification, "sensitive-control-response-metadata");
  assert.equal(bridge.operationRequests[0].metadata.action, "snooze-proposal");
  assert.equal(bridge.operationRequests[0].classification, "sensitive-operation-request-metadata");
  assert.equal(bridge.operationResponses[0].metadata.requestHash, operation.operationHash);
  assert.equal(bridge.operationResponses[0].classification, "sensitive-operation-response-metadata");
  assert.equal(bridge.controlState.metadata.mode, "manual");
  assert.equal(bridge.controlState.classification, "sensitive-control-state-metadata");
  assert.equal([bridge.requests[0], bridge.responses[0], bridge.controlRequests[0], bridge.controlResponses[0], bridge.operationRequests[0], bridge.operationResponses[0], bridge.controlState].every((item) => Number.isSafeInteger(item.bytes) && item.bytes > 0), true);
  assert.doesNotMatch(JSON.stringify(archive), /rawMessage|transcript/u);
  first.close();
  second.close();
});

test("already-open project stores re-read global settings on every get", () => {
  const root = ownedTempRoot("self-evolve-store-fresh-");
  const first = openStore(root, { projectFingerprint: PROJECT, now: () => 1 });
  const second = openStore(root, { projectFingerprint: H("b"), now: () => 2 });
  const global = first.getSettings().global;
  first.setGlobalSettings(makeGlobalSettings({ ...global, mode: "auto", updatedAt: 3 }));
  assert.equal(second.getSettings().global.mode, "auto");
  first.close();
  second.close();
});

test("stale dead-owner locks recover while stale live-owner locks time out", async () => {
  const root = ownedTempRoot("self-evolve-store-lock-");
  const lock = path.join(root, ".self-evolve-mutation.lock");
  const crashed = await runChild(root, PROJECT, "crash-lock");
  assert.equal(crashed.ok, true);
  const recovered = openStore(root, { projectFingerprint: PROJECT, staleLockMs: 1, lockTimeoutMs: 500 });
  recovered.close();

  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "live", acquiredAt: 0 }), { mode: 0o600 });
  utimesSync(lock, new Date(0), new Date(0));
  assert.throws(() => openStore(root, { projectFingerprint: PROJECT, staleLockMs: 1, lockTimeoutMs: 30 }), /mutation-lock-timeout/);
  assert.equal(existsSync(lock), true);
  rmSync(lock);
});

test("0.2.0 and 0.2.1 partitions migrate explicitly without quarantine", () => {
  const now = 1_000;
  for (const legacy of ["0.2.0", "0.2.1"]) {
    const root = ownedTempRoot(`self-evolve-store-migrate-${legacy}-`);
    const first = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => now });
    const envelope = wrapRecord("observation", observation(now), now);
    assert.equal(first.appendRecord(envelope).ok, true);
    first.close();

    // Rewrite durable state exactly as the previous release left it on disk.
    const base = path.join(root, "self-evolve");
    const versionPath = path.join(base, "version.json");
    const recordsPath = path.join(base, PROJECT, "observations.jsonl");
    const settingsPath = path.join(base, PROJECT, "settings.json");
    writeFileSync(versionPath, JSON.stringify({ schemaVersion: legacy }));
    writeFileSync(settingsPath, JSON.stringify({
      ...JSON.parse(readFileSync(settingsPath, "utf8")),
      schemaVersion: legacy,
      consent: {
        passiveCalls: false,
        durableObservations: false,
        sanitizedExcerpts: false,
        crossRepoAggregation: false,
      },
    }));
    writeFileSync(recordsPath, readFileSync(recordsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.stringify({ ...JSON.parse(line), schemaVersion: legacy }) )
      .join("\n") + "\n");

    const reopened = openStore(root, { projectName: "fixture", projectFingerprint: PROJECT, now: () => now });
    const records = reopened.readRecords("observation");
    reopened.close();

    assert.deepEqual(records, [envelope], "legacy records must be readable and normalized to the current version");
    assert.equal(JSON.parse(readFileSync(versionPath, "utf8")).schemaVersion, SCHEMA_VERSION, "version.json must be migrated");
    const migratedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(migratedSettings.schemaVersion, SCHEMA_VERSION, "repository settings must be migrated");
    assert.equal("consent" in migratedSettings, false, "legacy repository consent must be removed during migration");
    const quarantine = path.join(base, PROJECT, "quarantine");
    assert.equal(existsSync(quarantine) ? readdirSync(quarantine).length : 0, 0, "no legacy record may be quarantined");
  }
});

test("a representative v0.2 partition migrates settings to 0.3.0 without importing legacy global authority", () => {
  const root = ownedTempRoot("self-evolve-store-v02-migration-");
  const seed = openStore(root, { projectFingerprint: PROJECT, now: () => 1_000 });
  const current = seed.getSettings().global;
  assert.equal(seed.setGlobalSettings(makeGlobalSettings({
    ...current,
    mode: "yolo",
    paused: true,
    killSwitchActive: true,
    allowedSkillRoots: ["/skills"],
    consent: { passiveCalls: true, durableObservations: true, sanitizedExcerpts: true, crossRepoAggregation: true },
    budgets: { ...current.budgets, synthesisPerDay: 7 },
    retentionDays: 14,
    updatedAt: 1_001,
  })).mode, "auto");
  const legacyProposal = proposal();
  assert.equal(seed.appendRecord(wrapRecord("proposal", legacyProposal, 1_002)).ok, true);
  seed.close();

  // Re-stamp the partition as a v0.2 generation the way a previous release left it.
  const base = path.join(root, "self-evolve");
  writeFileSync(path.join(base, "version.json"), '{"schemaVersion":"0.2.1"}\n', { mode: 0o600 });
  for (const file of ["settings.json"]) {
    const globalSettingsPath = path.join(base, "global", file);
    const parsed = JSON.parse(readFileSync(globalSettingsPath, "utf8"));
    writeFileSync(globalSettingsPath, `${JSON.stringify({ ...parsed, schemaVersion: "0.2.1", mode: "yolo" })}\n`, { mode: 0o600 });
  }
  const recordsPath = path.join(base, PROJECT, "proposals.jsonl");
  const legacyRecords = readFileSync(recordsPath, "utf8").trim().split("\n")
    .map((line) => JSON.stringify({ ...JSON.parse(line), schemaVersion: "0.2.1" }))
    .join("\n");
  writeFileSync(recordsPath, `${legacyRecords}\n`, { mode: 0o600 });

  const migrated = openStore(root, { projectFingerprint: PROJECT, now: () => 2_000 });
  const settings = migrated.getSettings();

  assert.equal(JSON.parse(readFileSync(path.join(base, "version.json"), "utf8")).schemaVersion, "0.3.0");
  assert.equal(settings.global.schemaVersion, SCHEMA_VERSION);
  assert.equal(settings.global.mode, "auto", "legacy yolo narrows to auto");
  assert.equal(settings.global.paused, true);
  assert.equal(settings.global.killSwitchActive, true);
  assert.deepEqual(settings.global.allowedSkillRoots, ["/skills"]);
  assert.deepEqual(settings.global.consent, {
    passiveCalls: true,
    durableObservations: true,
    sanitizedExcerpts: true,
    crossRepoAggregation: true,
  });
  assert.equal(settings.global.budgets.synthesisPerDay, 7);
  assert.equal(settings.global.retentionDays, 14);
  assert.equal(settings.global.globalRootPolicy, null, "migration never invents an approved global root");
  const proposals = migrated.readRecords("proposal");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].payload.id, legacyProposal.id);
  assert.equal(proposals[0].schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(migrated.readGlobalRecommendations(), [], "legacy proposals never become global recommendations");
  assert.deepEqual(migrated.readGlobalCandidates(), []);
  assert.deepEqual(migrated.readGlobalSupportSets(), []);
  assert.deepEqual(migrated.readGlobalDecisions(), []);
  assert.deepEqual(migrated.readContributions({ scope: "global", includeExpired: true }), []);
  migrated.close();
});
