import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { createIntegration, recoverOrphanedHiddenSessions, ROLLOUT_GATES } from "../self-evolve-integration.js";
import {
  createControlRequest,
  createDecisionRequest,
  createGlobalActionRequest,
  createUiOperationRequest,
  makeBridgeRequest,
  makeControlRequest,
  pollControlResponse,
  pollDecisionResponse,
  pollGlobalActionResponse,
  pendingGlobalActionRequestCount,
  pollUiOperationResponse,
  publishGlobalRecommendationProjection,
  publishTuiHostHealth,
  readGlobalRecommendationProjection,
  readControlState,
  readProjectInbox,
  readUiProjection,
  submitControlRequest,
  submitDecisionRequest,
  submitGlobalActionRequest,
  submitUiOperationRequest,
} from "../self-evolve-bridge.js";
import { buildGlobalRecommendationProjection } from "../self-evolve-projection.js";
import * as inventoryModule from "../self-evolve-inventory.js";
import * as observationModule from "../self-evolve-observation.js";
import { createSensitiveExportManager } from "../self-evolve-export.js";
import { createPrivacyGuard } from "../self-evolve-privacy.js";
import { openStore } from "../self-evolve-store.js";
import { spawnSync } from "node:child_process";

// A genuinely-dead OS pid (the child has exited by the time spawnSync returns),
// so recovery's real process-liveness check classifies the seeded owner as dead.
function deadOwnerPid() {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
}
function seedDeadHostOwner(root, sessionId, agent) {
  const store = openStore(root, { projectName: "fixture", projectFingerprint: FINGERPRINT, now: () => 100 });
  const seeded = store.acquireHostOwner(sessionId, { agent, projectFingerprint: FINGERPRINT, rootIdentity: store.rootIdentity, generation: 0, pid: deadOwnerPid() });
  if (seeded.ok) assert.equal(store.retainHostOwner(sessionId, seeded.nonce).ok, true);
  store.close();
  return seeded;
}
import * as schemas from "../self-evolve-schemas.js";
import * as commandModule from "../self-evolve-commands.js";
import {
  GLOBAL_PROTOCOL_LIMITS,
  UI_CAPABILITIES,
  UI_DASHBOARD_VERSION,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
} from "../self-evolve-ui-protocol.js";

const FINGERPRINT = "a".repeat(64);
const CURRENT_HASH = "b".repeat(64);
const PROPOSED_HASH = "c".repeat(64);
const OPERATION_EFFECT_CRASH = path.join(import.meta.dirname, "fixtures", "operation-effect-crash.mjs");

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

function supportedHostSession(id, { parentID, version = "1.18.4" } = {}) {
  return {
    id,
    projectID: "project-fixture",
    directory: "/workspace/project",
    ...(parentID === undefined ? {} : { parentID }),
    title: `Session ${id}`,
    version,
    time: { created: 1, updated: 2 },
  };
}

function proposal(root, overrides = {}) {
  return schemas.makeProposal({
    id: overrides.id ?? "proposal-1",
    projectFingerprint: FINGERPRINT,
    clusterId: "d".repeat(64),
    skillTarget: { canonicalRoot: root, relativePath: "demo/SKILL.md", currentHash: CURRENT_HASH },
    proposedContentHash: PROPOSED_HASH,
    rationaleText: "Evidence supports a bounded skill correction.",
    synthesizedAt: 1,
    synthesizerModelId: "mock-synthesizer",
    criticScore: 0.95,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    injectionFlagged: false,
    ...overrides,
  });
}

function makeAudit(kind, proposalId, details, timestamp = 10) {
  const payloadHash = createHash("sha256").update(JSON.stringify(details)).digest("hex");
  return schemas.makeAuditEvent({
    id: createHash("sha256").update(`${kind}:${proposalId}:${timestamp}:${payloadHash}`).digest("hex"),
    kind,
    proposalId,
    actor: "self-evolve-applier",
    timestamp,
    payloadHash,
    details,
  });
}

function seedOutcome(store, index, status = "accepted", timestamp = 10 + index, projectFingerprint = FINGERPRINT) {
  const event = schemas.makeSynthesisOutcomeAuditEvent({
    outcomeId: createHash("sha256").update(`outcome:${index}`).digest("hex"),
    projectFingerprint,
    clusterId: createHash("sha256").update(`cluster:${index}`).digest("hex"),
    status,
    success: status === "accepted" || status === "no-change",
    terminalAt: timestamp,
    reasonCode: status === "no-change" ? "valid-no-change" : status,
  });
  return store.appendRecord(schemas.wrapRecord("audit-event", event, timestamp));
}

function globalActionSubject(action, stateRootIdentity, now) {
  const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
  const currentContent = "---\nname: shared-review\ndescription: Reviews failures.\n---\n\n# Shared Review\n";
  const proposedContent = `${currentContent}\nVerify the exact failure before changing guidance.\n`;
  const candidateId = hash(`global-candidate:${action}`);
  const supportSetHash = hash(`global-support:${action}`);
  const state = action === "undo" ? "applied" : "pending";
  const recommendation = {
    recommendationId: hash(`global-recommendation:${action}`),
    candidateId,
    supportSetHash,
    targetBinding: {
      targetKind: "existing-global-skill",
      logicalName: "shared-review",
      relativePath: "shared-review/SKILL.md",
      currentHash: hash(currentContent),
      bindingHash: hash(`global-binding:${action}`),
    },
    proposedContentHash: hash(proposedContent),
    rationaleText: "Independent support warrants one bounded global correction.",
    synthesizedAt: now - 1,
    criticScore: 0.99,
    criticPassed: true,
    validDeterministic: true,
    state,
    decisionVersion: state === "applied" ? 1 : 0,
  };
  const supportSet = {
    supportSetHash,
    candidateId,
    contributionIds: [randomUUID()],
    strongestSingleDomain: { independentIncidentCount: 2, occurrenceCount: 3 },
    distributed: { independentKnownDomainCount: 1, independentIncidentCount: 2 },
    firstSeenDay: "2026-08-01",
    lastSeenDay: "2026-08-11",
  };
  const candidate = {
    candidateId,
    supportSetHash,
    eligibilityRoute: "single-domain",
    independentDomainCount: 1,
    independentIncidentCount: 2,
    occurrenceCount: 3,
    updatedAt: now,
  };
  const targetContent = state === "applied" ? proposedContent : currentContent;
  const projection = buildGlobalRecommendationProjection({
    recommendations: [recommendation],
    supportSets: [supportSet],
    candidates: [candidate],
    audits: [],
    contentByRecommendation: { [recommendation.recommendationId]: proposedContent },
  }, {
    stateRootIdentity,
    now,
    targetReader: () => ({ exists: true, content: targetContent, hash: hash(targetContent) }),
  });
  return { recommendation, projection };
}

function harness(t, config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-integration-"));
  let clock = config.initialClock ?? 100;
  const now = () => ++clock;
  const store = openStore(root, { projectName: "fixture", projectFingerprint: FINGERPRINT, now });
  const current = store.getSettings();
  store.setGlobalSettings(schemas.makeGlobalSettings({
    ...current.global,
    allowedSkillRoots: config.allowlisted === false ? [] : [root],
    consent: { passiveCalls: true, durableObservations: true, sanitizedExcerpts: false, crossRepoAggregation: false },
    updatedAt: now(),
  }));
  const rolloutOutcomes = config.rolloutOutcomes ?? 10;
  for (let index = 0; index < rolloutOutcomes; index += 1) seedOutcome(store, index);

  const calls = {
    events: [],
    cycles: [],
    applies: [],
    approvals: [],
    rollbacks: [],
    cancelled: [],
    workResults: [],
    reservations: [],
    episodeLeases: [],
    recoveries: 0,
    contributionRecoveries: 0,
    synthesisRecoveries: 0,
    published: [],
    settingsReads: 0,
    recordReads: 0,
    recordWrites: 0,
    applierCloses: 0,
  };
  let integrationStore = config.instrumentStore
    ? {
        ...store,
        getSettings(...args) {
          calls.settingsReads += 1;
          return store.getSettings(...args);
        },
        readRecords(...args) {
          calls.recordReads += 1;
          return store.readRecords(...args);
        },
        appendRecord(...args) {
          calls.recordWrites += 1;
          return store.appendRecord(...args);
        },
      }
    : store;
  if (config.releaseOwnedHostOwners) {
    integrationStore = {
      ...integrationStore,
      releaseOwnedHostOwners: (...args) => config.releaseOwnedHostOwners(store, ...args),
    };
  }
  if (config.decorateStore) integrationStore = config.decorateStore(integrationStore, store);
  const privacy = config.privacy?.(store, root) ?? {
    exportScope: () => ({ projectFingerprint: FINGERPRINT, records: [] }),
    purgeScope: () => ({ ok: true, counts: {} }),
    scanForForbiddenContent: () => ({ ok: true, issues: [] }),
  };
  const rawApplier = {
    circuitBreakerOpen: () => config.breakerOpen === true,
    async applyProposal(args) {
      calls.applies.push(args);
      if (config.applyFailure) return { ok: false, reason: config.applyFailure };
      const audit = makeAudit("apply", args.proposal.id, { state: "readback-verified", appliedHash: args.proposal.proposedContentHash, "readback-verified": true }, now());
      store.appendRecord(schemas.wrapRecord("audit-event", audit, audit.timestamp));
      return { ok: true, appliedHash: args.proposal.proposedContentHash, auditId: audit.id };
    },
    async rollbackApplied(args) {
      calls.rollbacks.push(args);
      const audit = makeAudit("rollback", args.proposalId, { state: "rolled-back", rolledBackHash: CURRENT_HASH, "readback-verified": true }, now());
      store.appendRecord(schemas.wrapRecord("audit-event", audit, audit.timestamp));
      return { ok: true, rolledBackHash: CURRENT_HASH, auditId: audit.id };
    },
    recoverPending() {
      calls.recoveries += 1;
      if (config.recoverPendingThrows) throw new Error(config.recoverPendingThrows);
      return config.recovery ?? [];
    },
    close() {
      calls.applierCloses += 1;
      return config.applierClose?.(calls.applierCloses);
    },
  };

  const pipelineModule = {
    createPipeline(deps) {
      return {
        async runEvolutionCycle(args) {
          calls.cycles.push(args);
          if (config.deferredCycle) {
            config.deferredCycle.signal = args.options?.signal;
            return config.deferredCycle.promise;
          }
          if (config.cycleError) throw new Error(config.cycleError);
          const item = config.cycleProposal ?? proposal(root);
          const fixture = {
            observations: [{ id: "observation-shared", incidentId: "incident-shared" }],
            eligibility: [{ clusterId: item.clusterId, eligible: true, thresholdsMet: { minIncidents: 3 }, thresholdsMissed: {} }],
            proposal: item,
          };
          if (args.options?.stopAfter === "correlate") return { result: "observed-shadow", ...fixture, synthesized: false };
          if (args.mode === "yolo") {
            const applied = await deps.applier.applyProposal({ proposal: { ...item, proposedContent: "# proposed\n" }, mode: "yolo", headless: true });
            if (applied.ok) return { result: "applied", ...fixture, responseText: `appliedHash ${applied.appliedHash}` };
          }
          return { result: "proposal-ready", ...fixture, responseText: "pending review" };
        },
        async runApprovalFlow(args) {
          calls.approvals.push(args);
          const item = latestProposal(store, args.proposalId);
          const decision = store.readRecords("decision").map((record) => record.payload).findLast((entry) => entry.proposalId === args.proposalId && entry.newState === "approved");
          const applied = await deps.applier.applyProposal({ proposal: { ...item, proposedContent: "# proposed\n" }, decision, mode: args.mode, headless: args.headless === true });
          return applied.ok
            ? { result: "applied", auditEvents: [makeAudit("apply", item.id, { state: "readback-verified", appliedHash: applied.appliedHash, "readback-verified": true }, now())], responseText: `Applied proposal ${item.id}; appliedHash ${applied.appliedHash}; auditId ${applied.auditId}.` }
            : { result: "failed-closed", reason: applied.reason, auditEvents: [], responseText: `not applied: ${applied.reason}` };
        },
        async runRollbackFlow(args) {
          const rolledBack = await deps.applier.rollbackApplied(args);
          return rolledBack.ok
            ? { result: "rolled-back", auditEvents: [makeAudit("rollback", args.proposalId, { state: "rolled-back", rolledBackHash: rolledBack.rolledBackHash }, now())], responseText: "rolled back" }
            : { result: "failed-closed", responseText: "rollback failed" };
        },
        recoverSynthesisAttempts() {
          calls.synthesisRecoveries += 1;
          config.recoveryOrder?.push("synthesis-recovery");
          if (config.synthesisRecoveryThrows) throw new Error(config.synthesisRecoveryThrows);
          return config.synthesisRecovery ?? [];
        },
        recoverContributionTransactions() {
          calls.contributionRecoveries += 1;
          config.recoveryOrder?.push("contribution-recovery");
          if (config.contributionRecoveryThrows) throw new Error(config.contributionRecoveryThrows);
          return config.contributionRecovery ?? { ok: true, recovered: 0, failed: 0, outcomes: [] };
        },
      };
    },
  };

  const schedulerModule = {
    createScheduler({ enqueueWork }) {
      let mode = "manual";
      return {
        async handleEvent(event) {
          calls.events.push(event);
          if (config.enqueueOnEvent !== false) {
            await enqueueWork({ sessionID: event.properties.sessionID, projectFingerprint: FINGERPRINT, scopeFingerprint: FINGERPRINT, leaseNonce: `lease-${calls.events.length}`, epoch: calls.events.length, scheduledAt: now() });
          }
        },
        setMode(next) { mode = next; return mode; },
        getCircuitBreaker: () => ({ open: config.breakerOpen === true }),
        cancelPending(sessionID) { calls.cancelled.push(sessionID); return true; },
        reservePassiveProviderCalls(count, context) { calls.reservations.push({ count, context }); return { ok: true, reserved: count }; },
        async runWithEpisodeLease(scope, operation) {
          calls.episodeLeases.push(scope);
          return { ok: true, value: await operation() };
        },
        recordWorkResult(item, result) { calls.workResults.push({ item, result }); return { accepted: true }; },
        stopAdmission() { calls.schedulerStopped = (calls.schedulerStopped ?? 0) + 1; },
        async drain() { calls.schedulerDrains = (calls.schedulerDrains ?? 0) + 1; },
        dispose() { calls.schedulerDisposals = (calls.schedulerDisposals ?? 0) + 1; },
      };
    },
  };

  const projectDirectory = config.useFixtureProjectDirectory ? path.join(root, "project") : "/workspace/project";
  if (config.useFixtureProjectDirectory) mkdirSync(projectDirectory);
  const ctx = {
    directory: projectDirectory,
    client: {
      tui: { publish(value) { calls.published.push(value); } },
      session: {
        async get(args) {
          calls.sessionGets ??= [];
          calls.sessionGets.push(args);
          if (config.sessionGet) return config.sessionGet(args);
          return { data: supportedHostSession(args.path.id, { version: config.integrationOptions?.hostVersion }) };
        },
        ...(config.sessionList ? { list: config.sessionList } : {}),
        ...(config.sessionDelete ? { delete: config.sessionDelete } : {}),
      },
    },
  };
  const integration = createIntegration({
    store: integrationStore,
    inventory: config.inventory ?? {},
    privacy,
    schemas,
    observation: observationModule,
    synthesisModule: {},
    applier: rawApplier,
    commands: commandModule,
    pipeline: pipelineModule,
    scheduler: schedulerModule,
    options: {
      ctx,
      ...(config.rolloutMetrics === undefined ? {} : { rolloutMetrics: config.rolloutMetrics }),
      ...(config.getRolloutMetrics === undefined ? {} : { getRolloutMetrics: config.getRolloutMetrics }),
      rolloutGates: config.rolloutGates,
      processExcluded: config.processExcluded,
      repoOptOut: config.repoOptOut,
      ...(config.integrationOptions ?? {}),
      ...(config.integrationOptions?.stateRoot === true ? { stateRoot: root } : {}),
    },
    now,
  });
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, integration, calls, now, ctx };
}

function latestProposal(store, id) {
  return store.readRecords("proposal").filter((record) => record.payload.id === id).at(-1)?.payload;
}

function seedProposal(store, item, at = 5) {
  const saved = store.appendRecord(schemas.wrapRecord("proposal", item, at));
  assert.equal(saved.ok, true);
}

function exactDecision(item, newState, at = 20, actor = "self-evolve-tui") {
  return schemas.makeDecision({
    proposalId: item.id,
    targetHash: item.skillTarget.currentHash,
    proposedContentHash: item.proposedContentHash,
    decisionVersion: item.decisionVersion + 1,
    actor,
    timestamp: at,
    nonce: `nonce-${item.id}-${newState}-${at}`,
    priorState: item.state,
    newState,
  });
}

test("server integration boot rejects a replaced store root before mailbox authority starts", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-integration-root-race-"));
  const held = `${root}.held`;
  const outside = mkdtempSync(path.join(tmpdir(), "self-evolve-integration-root-outside-"));
  const store = openStore(root, { projectFingerprint: FINGERPRINT });
  const dependencies = {
    store,
    schemas,
    pipeline: {},
    scheduler: {},
    applier: {},
  };
  assert.throws(() => createIntegration({
    ...dependencies,
    options: { stateRoot: outside },
  }), /state-root-store-mismatch/u);
  assert.deepEqual(readdirSync(outside), []);

  renameSync(root, held);
  symlinkSync(outside, root, "dir");
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
    rmSync(held, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(() => createIntegration({
    ...dependencies,
    options: { stateRoot: root },
  }), /state-root-boundary-rejected/u);
  assert.deepEqual(readdirSync(outside), []);
});

function uiOffer() {
  return {
    projectionVersions: [UI_PROJECTION_VERSION],
    operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
    capabilities: UI_CAPABILITIES,
  };
}

async function currentProjection(h) {
  const pass = await h.integration.processMailbox();
  assert.equal(pass.ok, true, JSON.stringify(pass));
  assert.equal(pass.uiProjectionError, undefined, JSON.stringify(pass));
  return readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: uiOffer(),
  });
}

function operationRequest(h, projected, action, payload, requestId) {
  const grant = projected.effectiveIndexActions.find((entry) => entry.action === action);
  assert.ok(grant, `missing ${action} grant: ${JSON.stringify(projected.effectiveIndexActions)}`);
  return createUiOperationRequest({
    projection: projected.index,
    grant,
    payload,
    timestamp: h.now(),
    requestId,
  });
}

test("unsupported durable state boots fail closed without mutating its partition", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-integration-version-reject-"));
  const base = path.join(root, "self-evolve");
  mkdirSync(path.join(base, FINGERPRINT), { recursive: true });
  writeFileSync(path.join(base, "version.json"), '{"schemaVersion":"9.9.9"}\n');
  writeFileSync(path.join(base, FINGERPRINT, "sentinel.bin"), Buffer.from([0, 1, 2, 255]));
  const before = exactTree(root);
  const store = openStore(root, { projectFingerprint: FINGERPRINT });
  const schedulerModes = [];
  const integration = createIntegration({
    store,
    schemas,
    privacy: {},
    synthesisModule: {},
    applier: { circuitBreakerOpen: () => false },
    commands: {},
    pipeline: { createPipeline: () => ({}) },
    scheduler: { createScheduler: () => ({
      setMode(mode) { schedulerModes.push(mode); },
      getCircuitBreaker: () => ({ open: false }),
    }) },
    options: { stateRoot: root },
  });
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  const result = await integration.boot({ recoverHostSessions: false });
  assert.equal(result.ok, false);
  assert.equal(result.automaticWorkAllowed, false);
  assert.equal(result.health.lastError, "unsupported-state-version");
  assert.deepEqual(schedulerModes, ["manual"]);
  assert.deepEqual(exactTree(root), before);
});

test("binary automation is the sole normal admission control", async (t) => {
  const h = harness(t);
  const boot = await h.integration.boot({ processMailbox: false, recoverHostSessions: false });
  assert.equal(boot.ok, true);
  assert.equal(h.integration.__testBridge.getAutomation().enabled, true);
  assert.equal("setMode" in h.integration.__testBridge, false);
  assert.equal("getMode" in h.integration.__testBridge, false);

  const off = h.integration.__testBridge.setAutomaticRecommendations(false);
  assert.equal(off.ok, true, off.reason);
  assert.deepEqual(h.integration.getProjectOperationalState(FINGERPRINT), {
    automaticRecommendationsEnabled: false,
    automaticWorkAllowed: false,
    reason: "automatic-recommendations-disabled",
  });
  const suppressed = await h.integration.handleEvent({
    type: "session.idle",
    properties: { sessionID: "off-session", projectFingerprint: FINGERPRINT },
  });
  assert.equal(suppressed.scheduled, false);
  assert.equal(h.calls.cycles.length, 0);

  const on = h.integration.__testBridge.setAutomaticRecommendations(true);
  assert.equal(on.ok, true, on.reason);
  assert.equal(h.integration.__testBridge.getAutomation().enabled, true);
  assert.equal(Object.values(h.integration.__testBridge.getConsent()).every(Boolean), true);
  const admitted = await h.integration.handleEvent({
    type: "session.idle",
    properties: { sessionID: "on-session", projectFingerprint: FINGERPRINT },
  });
  assert.deepEqual(admitted, { scheduled: true, automaticRecommendationsEnabled: true });
  assert.equal(h.calls.cycles.length, 1);
});

test("only stable user-root lifecycle events reach automatic scheduling", async (t) => {
  const h = harness(t);
  await h.integration.boot({ processMailbox: false, recoverHostSessions: false });
  for (const event of [
    { type: "message.part.updated", properties: { sessionID: "delta" } },
    { type: "command.executed", properties: { sessionID: "command" } },
  ]) {
    assert.deepEqual(await h.integration.handleEvent(event), { scheduled: false, reason: "irrelevant-event" });
  }
  assert.equal(h.calls.cycles.length, 0);

  const delegatedSessions = {
    "delegated-session": supportedHostSession("delegated-session", { parentID: "parent-session" }),
    "parent-session": supportedHostSession("parent-session"),
  };
  const delegated = harness(t, {
    sessionGet: ({ path: { id } }) => ({ data: delegatedSessions[id] }),
  });
  await delegated.integration.boot({ processMailbox: false, recoverHostSessions: false });
  assert.deepEqual(await delegated.integration.handleEvent({
    type: "session.idle",
    properties: { sessionID: "delegated-session", projectFingerprint: FINGERPRINT },
  }), { scheduled: false, reason: "delegated-root" });
  assert.equal(delegated.calls.cycles.length, 0);
});

test("cycle outcome audits omit retired mode state", async (t) => {
  const h = harness(t);
  await h.integration.boot({ processMailbox: false, recoverHostSessions: false });
  await h.integration.handleEvent({
    type: "session.idle",
    properties: { sessionID: "cycle-audit", projectFingerprint: FINGERPRINT },
  });
  const outcome = h.store.readRecords("audit-event")
    .map((record) => record.payload.details)
    .findLast((details) => details?.action === "cycle-outcome");
  assert.equal(outcome.outcome, "recommendation-created");
  assert.equal(Object.hasOwn(outcome, "mode"), false);
  assert.equal(outcome.observationCount, 1);
  assert.equal(outcome.eligibilityCount, 1);
});

test("the integration publishes only the current binary projection and dashboard", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  const projected = await currentProjection(h);
  assert.equal(projected.mode, "native");
  assert.equal(projected.index.status.automaticRecommendationsEnabled, true);
  assert.equal(Object.hasOwn(projected.index.status, "effectiveMode"), false);
  assert.equal(projected.dashboard.dashboardVersion, UI_DASHBOARD_VERSION);
  assert.equal(projected.dashboard.settings.automaticRecommendationsEnabled, true);
  assert.equal(Object.hasOwn(projected.dashboard.settings, "globalMode"), false);
  assert.equal(projected.dashboard.automation.state, "ready");
  const generationRoot = path.join(
    h.root,
    "self-evolve",
    "bridge",
    FINGERPRINT,
    "ui-projections",
    "generations",
    projected.index.generation,
  );
  assert.equal(existsSync(path.join(generationRoot, "dashboard-v1.json")), false);
  assert.equal(existsSync(path.join(generationRoot, "dashboard-v2.json")), false);
  assert.equal(existsSync(path.join(generationRoot, "dashboard-v3.json")), true);
});

test("native On and Off operations bind fresh settings authority", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  const projected = await currentProjection(h);
  const request = operationRequest(h, projected, "set-automatic-recommendations", {
    enabled: false,
    settingsVersion: projected.dashboard.settings.globalSettingsVersion,
  }, "automation-off-request");
  assert.equal(submitUiOperationRequest(h.root, request).ok, true);
  const pass = await h.integration.processMailbox();
  assert.equal(pass.operations.length, 1);
  const response = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(response.ok, true, response.reason);
  assert.equal(h.integration.__testBridge.getAutomation().enabled, false);
  assert.equal(Object.values(h.integration.__testBridge.getConsent()).every(Boolean), true);

  const refreshed = await currentProjection(h);
  assert.equal(refreshed.dashboard.settings.automaticRecommendationsEnabled, false);
  assert.equal(refreshed.dashboard.automation.state, "off");
  assert.deepEqual(refreshed.index.reviews, projected.index.reviews);
});

test("permission revocation turns Off and restoration never silently restarts", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  let projected = await currentProjection(h);
  let request = operationRequest(h, projected, "set-permission", {
    permission: "sanitizedExcerpts",
    enabled: false,
    settingsVersion: projected.dashboard.settings.globalSettingsVersion,
  }, "permission-revoke-request");
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, true);
  assert.equal(h.integration.__testBridge.getAutomation().enabled, false);
  assert.equal(h.integration.__testBridge.getConsent().sanitizedExcerpts, false);

  projected = await currentProjection(h);
  request = operationRequest(h, projected, "set-permission", {
    permission: "sanitizedExcerpts",
    enabled: true,
    settingsVersion: projected.dashboard.settings.globalSettingsVersion,
  }, "permission-restore-request");
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, true);
  assert.equal(h.integration.__testBridge.getConsent().sanitizedExcerpts, true);
  assert.equal(h.integration.__testBridge.getAutomation().enabled, false);
});

test("project exclusion suppresses work without rewriting the global preference", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  const projected = await currentProjection(h);
  const request = operationRequest(h, projected, "set-repo-excluded", {
    excluded: true,
    settingsVersion: projected.dashboard.settings.globalSettingsVersion,
  }, "project-exclude-request");
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, true);
  assert.equal(h.integration.__testBridge.getAutomation().enabled, true);
  assert.deepEqual(h.integration.getProjectOperationalState(FINGERPRINT), {
    automaticRecommendationsEnabled: true,
    automaticWorkAllowed: false,
    reason: "project-excluded",
  });
});

test("removed commands are deterministic and perform no durable reads or writes", async (t) => {
  const h = harness(t, { instrumentStore: true });
  const before = {
    settingsReads: h.calls.settingsReads,
    recordReads: h.calls.recordReads,
    recordWrites: h.calls.recordWrites,
    bytes: JSON.stringify(h.store.getSettings()),
  };
  for (const command of ["manual", "auto", "scan", "pause", "resume", "repo auto", "consent passive on"]) {
    const result = await h.integration.handleCommand({ command });
    assert.match(result.responseText, /removed in Self-evolve v0\.4/u);
  }
  assert.deepEqual({
    settingsReads: h.calls.settingsReads,
    recordReads: h.calls.recordReads,
    recordWrites: h.calls.recordWrites,
    bytes: JSON.stringify(h.store.getSettings()),
  }, before);
});

test("turning Off aborts admitted automatic work before shutdown", async (t) => {
  let resolveCycle;
  const deferredCycle = { promise: new Promise((resolve) => { resolveCycle = resolve; }) };
  const h = harness(t, { deferredCycle });
  await h.integration.boot({ processMailbox: false, recoverHostSessions: false });
  const running = h.integration.handleEvent({
    type: "session.idle",
    properties: { sessionID: "in-flight", projectFingerprint: FINGERPRINT },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.integration.getInFlightWork().length, 1);
  const off = await h.integration.handleCommand({ command: "off" });
  assert.match(off.responseText, /Automatic recommendations Off/u);
  assert.equal(deferredCycle.signal.aborted, true);
  resolveCycle({ result: "failed-closed", reason: "automatic-recommendations-off" });
  const outcome = await running;
  assert.equal(outcome.scheduled, true);
  await h.integration.shutdown();
  assert.equal(h.integration.getInFlightWork().length, 0);
});

test("root-policy replacement remains an explicit separately validated operation", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    useFixtureProjectDirectory: true,
    integrationOptions: { stateRoot: true },
  });
  const approvedRoot = path.join(h.root, "approved-global-skills");
  mkdirSync(approvedRoot);
  const projected = await currentProjection(h);
  const request = operationRequest(h, projected, "replace-global-root-policy", {
    roots: [{ canonicalPath: approvedRoot, canUpdate: true, canCreate: true }],
    creationRootPath: approvedRoot,
    confirmation: projected.dashboard.settings.globalRootPolicyConfirmation,
    settingsVersion: projected.dashboard.settings.globalSettingsVersion,
  }, "root-policy-request");
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  const response = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(response.ok, true, response.reason);
  assert.deepEqual(h.store.getSettings().global.globalRootPolicy.roots.map((root) => ({
    canonicalPath: root.canonicalPath,
    canUpdate: root.canUpdate,
    canCreate: root.canCreate,
  })), [{ canonicalPath: approvedRoot, canUpdate: true, canCreate: true }]);
  assert.equal(h.integration.__testBridge.getAutomation().enabled, true);
});
