import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { createIntegration, recoverOrphanedAnalyzerSessions, ROLLOUT_GATES } from "../self-evolve-integration.js";
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
          return config.synthesisRecovery ?? [];
        },
        recoverContributionTransactions() {
          calls.contributionRecoveries += 1;
          config.recoveryOrder?.push("contribution-recovery");
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

test("server integration boot exposes incompatible state health without mutating the partition", async (t) => {
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
    scheduler: {
      createScheduler: () => ({
        setMode(mode) { schedulerModes.push(mode); },
        getCircuitBreaker: () => ({ open: false }),
      }),
    },
    options: { stateRoot: root },
  });
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  const boot = await integration.boot({ recoverHostSessions: false });
  assert.equal(boot.ok, false);
  assert.equal(boot.mode, "manual");
  assert.equal(boot.health.lastError, "unsupported-state-version");
  assert.deepEqual(schedulerModes, ["manual"]);
  assert.deepEqual(exactTree(root), before);
});

test("global bridge publication failure does not corrupt project-local boot authority", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  const globalBridge = path.join(h.root, "self-evolve", "bridge", "global");
  mkdirSync(globalBridge, { recursive: true, mode: 0o700 });
  chmodSync(globalBridge, 0o770);

  const result = await h.integration.boot({ processMailbox: false, recoverHostSessions: false });

  assert.equal(result.ok, true);
  assert.equal(result.health.lastError, "ui-projection-ancestor-permissions-rejected");
  assert.equal(result.health.mode, "manual");
});

function headlessCommand(store, item, overrides = {}) {
  const grant = store.readRecords("audit-event").map((record) => record.payload).findLast((event) =>
    event.proposalId === item.id && event.details?.action === "headless-approval-nonce").details;
  return `/self-evolve approve ${item.id} --target-hash ${overrides.targetHash ?? grant.targetHash} --proposed-content-hash ${overrides.proposedContentHash ?? grant.proposedContentHash} --decision-version ${overrides.decisionVersion ?? grant.decisionVersion} --nonce ${overrides.nonce ?? grant.nonce}`;
}

test("both project analysis modes preserve identical evidence and proposal thresholds", async (t) => {
  assert.deepEqual(schemas.Mode.values, ["manual", "auto"]);
  for (const mode of schemas.Mode.values) {
    await t.test(mode, async (t) => {
      const h = harness(t, { rolloutMetrics: { synthesesObserved: 0, successRate: 0 } });
      const set = h.integration.__testBridge.setMode(mode);
      assert.equal(set.ok, true);
      const result = await h.integration.runEvolutionCycle({ sessionID: `session-${mode}`, projectFingerprint: FINGERPRINT, scopeFingerprint: FINGERPRINT });
      assert.deepEqual(result.observations, [{ id: "observation-shared", incidentId: "incident-shared" }]);
      assert.deepEqual(result.eligibility[0].thresholdsMet, { minIncidents: 3 });
      assert.equal(result.proposal.clusterId, "d".repeat(64));
    });
  }
});

test("every admitted cycle records one bounded semantic terminal outcome", async (t) => {
  const h = harness(t);
  assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
  const result = await h.integration.runEvolutionCycle({
    sessionID: "session-sensitive-id",
    projectFingerprint: FINGERPRINT,
    scopeFingerprint: FINGERPRINT,
    trigger: "scheduler",
  });
  assert.equal(result.result, "proposal-ready");
  const outcomes = h.store.readRecords("audit-event")
    .map((record) => record.payload)
    .filter((event) => event.details?.action === "cycle-outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].proposalId, result.proposal.id);
  assert.deepEqual(outcomes[0].details, {
    action: "cycle-outcome",
    outcome: "recommendation-created",
    triggerClass: "idle",
    mode: "auto",
    observationCount: 1,
    eligibilityCount: 1,
    occurredAt: outcomes[0].timestamp,
    reason: null,
  });
  assert.doesNotMatch(JSON.stringify(outcomes[0]), /session-sensitive-id/u);

  const failed = harness(t, { cycleError: "private provider detail" });
  await assert.rejects(
    failed.integration.runEvolutionCycle({
      sessionID: "another-sensitive-session",
      projectFingerprint: FINGERPRINT,
      trigger: "manual-command",
    }),
    /private provider detail/u,
  );
  const failedOutcomes = failed.store.readRecords("audit-event")
    .map((record) => record.payload)
    .filter((event) => event.details?.action === "cycle-outcome");
  assert.equal(failedOutcomes.length, 1);
  assert.equal(failedOutcomes[0].details.outcome, "failed");
  assert.equal(failedOutcomes[0].details.triggerClass, "manual");
  assert.equal(failedOutcomes[0].details.reason, "pipeline-failed");
  assert.doesNotMatch(JSON.stringify(failedOutcomes[0]), /private provider detail|another-sensitive-session/u);
});

test("manual mode has no passive scheduler activity or writes", async (t) => {
  const h = harness(t, { instrumentStore: true });
  const before = h.store.exportAll().records.length;
  const beforeReads = h.calls.settingsReads;
  const beforeWrites = h.calls.recordWrites;
  const result = await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "manual-session" } });
  assert.deepEqual(result, { scheduled: false, reason: "manual-mode" });
  assert.equal(h.calls.settingsReads - beforeReads, 1, "the configured-mode gate performs one fresh settings read");
  assert.equal(h.calls.recordWrites, beforeWrites);
  assert.equal(h.calls.sessionGets, undefined);
  assert.equal(h.calls.events.length, 0);
  assert.equal(h.store.exportAll().records.length, before);
});

test("configured project mode stays separate from fresh operational suppressors", async (t) => {
  const h = harness(t, { instrumentStore: true, enqueueOnEvent: false });
  const setProjectMode = (mode) => {
    const saved = h.store.updateRepoSettings((repo) => schemas.makeRepoSettings({ ...repo, mode }));
    assert.equal(saved.ok, true);
  };
  setProjectMode("auto");
  assert.deepEqual(h.integration.getProjectOperationalState(), {
    configuredMode: "auto",
    passiveAnalysisAllowed: true,
    reason: null,
  });
  assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "auto-next" } })).scheduled, true);
  assert.equal(h.calls.events.length, 1);

  const paused = h.store.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    paused: true,
    updatedAt: h.now(),
  }));
  assert.equal(paused.ok, true);
  assert.deepEqual(h.integration.getProjectOperationalState(), {
    configuredMode: "auto",
    passiveAnalysisAllowed: false,
    reason: "paused",
  });
  const sessionReads = h.calls.sessionGets?.length ?? 0;
  assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "paused-next" } }), {
    scheduled: false,
    reason: "paused",
  });
  assert.equal(h.calls.sessionGets?.length ?? 0, sessionReads);
  assert.equal(h.calls.events.length, 1);

  const resumed = h.store.updateGlobalSettings((global) => schemas.makeGlobalSettings({
    ...global,
    paused: false,
    updatedAt: h.now(),
  }));
  assert.equal(resumed.ok, true);
  setProjectMode("manual");
  assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "manual-next" } }), {
    scheduled: false,
    reason: "manual-mode",
  });
  assert.equal(h.calls.sessionGets?.length ?? 0, sessionReads);
  assert.equal(h.calls.events.length, 1);

  setProjectMode("yolo");
  assert.equal(h.integration.getProjectOperationalState().configuredMode, "auto", "legacy yolo narrows to analysis-only Auto");
});

test("passive scheduling hydrates only trustworthy direct roots through supported 1.18.x session reads", async (t) => {
  for (const hostVersion of ["1.18.3", "1.18.4", "1.18.14"]) {
    await t.test(hostVersion, async (t) => {
      const h = harness(t, { integrationOptions: { hostVersion } });
      assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
      const result = await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: `direct-${hostVersion}` } });
      assert.equal(result.scheduled, true);
      assert.deepEqual(h.calls.sessionGets, [{ path: { id: `direct-${hostVersion}` }, query: { directory: "/workspace/project" } }]);
      assert.equal(h.calls.events.length, 1);
      assert.deepEqual(Object.keys(supportedHostSession("shape", { version: hostVersion })).sort(), ["directory", "id", "projectID", "time", "title", "version"]);
    });
  }
});

test("delegated and package-owned canonical, legacy, and anonymous sessions never reach passive scheduling", async (t) => {
  await t.test("delegated", async (t) => {
    const sessions = {
      child: supportedHostSession("child", { parentID: "root" }),
      root: supportedHostSession("root"),
    };
    const h = harness(t, { sessionGet: ({ path }) => ({ data: sessions[path.id] }) });
    assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
    assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "child" } }), {
      scheduled: false,
      reason: "delegated-root",
    });
    assert.equal(h.calls.events.length, 0);
    assert.equal(h.calls.cycles.length, 0);
  });

  for (const [name, sessionID, agent] of [
    ["canonical", "canonical-private-session", "mcrescenzo.self-evolve.synthesizer"],
    ["legacy", "legacy-private-session", "self-evolve-critic"],
    ["anonymous", "anonymous-private-session", "mcrescenzo.self-evolve.analyzer"],
  ]) {
    await t.test(name, async (t) => {
      const h = harness(t, { sessionGet: ({ path }) => ({ data: supportedHostSession(path.id) }) });
      assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
      const owned = h.store.acquireHostOwner(sessionID, {
        agent,
        projectFingerprint: FINGERPRINT,
        rootIdentity: h.store.rootIdentity,
        generation: 0,
      });
      assert.equal(owned.ok, true);
      assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: { sessionID } }), {
        scheduled: false,
        reason: "non-user-root",
      });
      assert.equal(h.calls.events.length, 0);
      assert.equal(h.calls.cycles.length, 0);
      assert.doesNotMatch(JSON.stringify(h.store.exportAll()), new RegExp(sessionID, "u"));
      assert.equal(h.store.releaseHostOwner(sessionID, owned.nonce).ok, true);
    });
  }
});

test("ancestry metadata failures fail closed without persisting raw session ids", async (t) => {
  const rawSessionID = "private-session-canary";
  const h = harness(t, { sessionGet: async () => { throw new Error(`host failed for ${rawSessionID}`); } });
  assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
  const before = JSON.stringify(h.store.exportAll());
  assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: rawSessionID } }), {
    scheduled: false,
    reason: "session-ancestry-unavailable",
  });
  assert.equal(h.calls.events.length, 0);
  const after = JSON.stringify(h.store.exportAll());
  assert.equal(after, before);
  assert.doesNotMatch(after, new RegExp(rawSessionID, "u"));
});

test("manual scan commands hold the scheduler episode lease", async (t) => {
  const h = harness(t);
  const result = await h.integration.handleCommand({
    command: { verb: "scan" },
    sessionID: "manual-source-session",
    projectFingerprint: FINGERPRINT,
    scopeFingerprint: FINGERPRINT,
  });
  assert.equal(result.result, "proposal-ready");
  assert.deepEqual(h.calls.episodeLeases, [{
    projectFingerprint: FINGERPRINT,
    sessionID: "manual-source-session",
  }]);
});

test("status and health disclose when automatic background analysis awaits restart", async (t) => {
  const h = harness(t, { integrationOptions: { passiveEventHookInstalled: false } });
  assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
  for (const verb of ["status", "health"]) {
    const result = await h.integration.handleCommand({
      command: { verb },
      projectFingerprint: FINGERPRINT,
    });
    assert.match(result.responseText, /Background analysis is awaiting an OpenCode restart/u);
  }
  assert.deepEqual(
    {
      passiveEventHookInstalled: h.integration.__testBridge.getHealth().passiveEventHookInstalled,
      backgroundRestartRequired: h.integration.__testBridge.getHealth().backgroundRestartRequired,
    },
    { passiveEventHookInstalled: false, backgroundRestartRequired: true },
  );
});

test("stream delta bursts perform zero durable integration work in every mode", async (t) => {
  for (const mode of schemas.Mode.values) {
    await t.test(mode, async (t) => {
      let mailboxCalls = 0;
      let mailboxTimers = 0;
      const h = harness(t, {
        instrumentStore: true,
        enqueueOnEvent: false,
        integrationOptions: {
          stateRoot: true,
          __testConsumeDecisionRequests: async () => {
            mailboxCalls += 1;
            return { ok: true, processed: [] };
          },
          __testSetMailboxInterval: () => {
            mailboxTimers += 1;
            return { unref() {} };
          },
        },
      });
      if (mode !== "manual") {
        const changed = h.integration.__testBridge.setMode(mode, mode === "yolo" ? { confirmed: true, allowlist: [h.root] } : {});
        assert.equal(changed.ok, true);
      }
      const baseline = {
        settingsReads: h.calls.settingsReads,
        recordReads: h.calls.recordReads,
        recordWrites: h.calls.recordWrites,
        events: h.calls.events.length,
        published: h.calls.published.length,
        mailboxCalls,
        mailboxTimers,
      };
      const variants = [
        { field: "text", delta: "token" },
        { field: "reasoning", delta: "thought" },
        { field: "tool", delta: "{\"partial\":" },
      ];
      for (let index = 0; index < 3_000; index += 1) {
        const result = await h.integration.handleEvent({
          type: "message.part.delta",
          properties: { sessionID: `delta-${index % 3}`, ...variants[index % variants.length] },
        });
        assert.deepEqual(result, { scheduled: false, reason: "irrelevant-event" });
      }
      assert.deepEqual({
        settingsReads: h.calls.settingsReads,
        recordReads: h.calls.recordReads,
        recordWrites: h.calls.recordWrites,
        events: h.calls.events.length,
        published: h.calls.published.length,
        mailboxCalls,
        mailboxTimers,
      }, baseline);
    });
  }
});

test("admitted event bursts read fresh routing settings", async (t) => {
  const h = harness(t, {
    instrumentStore: true,
    enqueueOnEvent: false,
  });
  assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
  const baseline = h.calls.settingsReads;
  for (let index = 0; index < 100; index += 1) {
    const result = await h.integration.handleEvent({
      event: {
        type: "session.status",
        properties: { sessionID: "status-burst", status: { type: index % 2 ? "busy" : "retry" } },
      },
    });
    assert.equal(result.scheduled, true);
  }
  assert.equal(h.calls.settingsReads - baseline, 100);

  const current = h.store.getSettings();
  h.store.setGlobalSettings(schemas.makeGlobalSettings({
    ...current.global,
    mode: "manual",
    updatedAt: current.global.updatedAt + 1,
  }));
  assert.deepEqual(
    await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "fresh" } }),
    { scheduled: false, reason: "manual-mode" },
  );
});

test("mailbox processing is single-flight with at most one pending rerun", async (t) => {
  let active = 0;
  let maxActive = 0;
  let passes = 0;
  let releaseFirst;
  const firstPass = new Promise((resolve) => { releaseFirst = resolve; });
  const h = harness(t, {
    integrationOptions: {
      stateRoot: true,
      __testConsumeDecisionRequests: async () => {
        passes += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (passes === 1) await firstPass;
        active -= 1;
        return { ok: true, processed: [] };
      },
    },
  });
  const first = h.integration.processMailbox();
  await new Promise((resolve) => setImmediate(resolve));
  const second = h.integration.processMailbox();
  const third = h.integration.processMailbox();
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.equal(maxActive, 1);
  assert.equal(passes, 2);
});

test("an empty manual mailbox pass reads settings once and skips decision-nonce work", async (t) => {
  const h = harness(t, {
    instrumentStore: true,
    integrationOptions: { stateRoot: true },
  });
  seedProposal(h.store, proposal(h.root));
  const baselineReads = h.calls.settingsReads;

  const result = await h.integration.processMailbox();

  assert.equal(result.ok, true);
  assert.equal(h.calls.settingsReads - baselineReads, 1);
  const actions = h.store.readRecords("audit-event").map((record) => record.payload.details?.action);
  assert.equal(actions.includes("bridge-nonce"), false);
  assert.equal(actions.includes("headless-approval-nonce"), false);
  assert.equal(actions.includes("control-nonce"), true);
});

test("the production integration publishes a negotiated server-authored UI projection", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });

  const pass = await h.integration.processMailbox();
  assert.equal(pass.ok, true);
  assert.equal(pass.uiProjectionError, undefined);
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  assert.equal(projected.mode, "native");
  assert.equal(projected.index.projectFingerprint, FINGERPRINT);
  assert.equal(projected.index.status.effectiveMode, "manual");
  assert.deepEqual(projected.index.reviews, []);
  assert.equal(projected.dashboard.indexHash, projected.index.projectionHash);
  assert.equal(projected.dashboard.dashboardVersion, UI_DASHBOARD_VERSION);
  assert.equal(projected.dashboard.automation.state, "on-demand");
  assert.equal(projected.dashboard.usage.storage.usedBytes > 0, true);
  assert.equal(projected.dashboardError, null);
  const generationFiles = readdirSync(path.join(
    h.root,
    "self-evolve",
    "bridge",
    FINGERPRINT,
    "ui-projections",
    "generations",
    projected.index.generation,
  ));
  assert.equal(generationFiles.includes("dashboard-v1.json"), true);
  assert.equal(generationFiles.includes(`dashboard-v${UI_DASHBOARD_VERSION}.json`), true);
  const globalProjection = readGlobalRecommendationProjection(h.root, { now: h.now() });
  assert.equal(globalProjection.mode, "native");
  assert.equal(globalProjection.index.stateRootIdentity, h.store.rootIdentity);
  assert.deepEqual(globalProjection.index.recommendations, []);
});

for (const action of ["apply", "reject", "undo"]) {
  test(`global ${action} requests enter the direct identity-free decision API`, async (t) => {
    let recommendation;
    let directCall;
    let rejectCall;
    const h = harness(t, {
      initialClock: Date.now(),
      decorateStore: (integrationStore) => ({
        ...integrationStore,
        readGlobalRecommendations: () => recommendation ? [recommendation] : [],
        rejectGlobalRecommendation(request) {
          rejectCall = request;
          return { ok: true };
        },
      }),
      integrationOptions: {
        stateRoot: true,
        __testGlobalDecisionDomain: {
          async decide(request) { directCall = request; return { ok: true }; },
          async recover() { return []; },
        },
      },
    });
    const timestamp = h.now();
    const subject = globalActionSubject(action, h.store.rootIdentity, timestamp);
    recommendation = subject.recommendation;
    publishGlobalRecommendationProjection(h.root, subject.projection, {
      store: h.store,
      expectedGeneration: null,
      now: timestamp,
    });
    const projected = readGlobalRecommendationProjection(h.root, { now: timestamp });
    const grant = projected.grants.find((value) => value.action === action);
    assert.ok(grant);
    const actingProjectFingerprint = createHash("sha256").update(`acting:${action}`).digest("hex");
    const health = publishTuiHostHealth(h.root, {
      projectFingerprint: actingProjectFingerprint,
      stateRootIdentity: h.store.rootIdentity,
      hostVersion: "0.3.0",
      issuedAt: timestamp,
      expiresAt: timestamp + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
    });
    const request = createGlobalActionRequest({
      grant,
      actingProjectFingerprint,
      actingHealth: health,
      timestamp,
      requestId: randomUUID(),
    });
    submitGlobalActionRequest(h.root, request);

    const pass = await h.integration.processMailbox();
    assert.equal(pass.globalActions.ok, true);
    assert.equal(pass.globalActions.processed.length, 1);
    const response = pollGlobalActionResponse(h.root, request, { now: h.now() });
    assert.equal(response.ok, true, response.reason);
    const decisionRequest = action === "reject" ? rejectCall : directCall;
    assert.ok(decisionRequest);
    if (action !== "reject") assert.equal(decisionRequest.action, action);
    const decision = decisionRequest.decision;
    assert.equal(decision.recommendationId, recommendation.recommendationId);
    assert.equal(decision.priorState, recommendation.state);
    assert.equal(decision.newState, action === "apply" ? "approved" : action === "undo" ? "undo-approved" : "rejected");
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(`${actingProjectFingerprint}|${FINGERPRINT}`, "u"));
    assert.equal(action === "reject" ? directCall : rejectCall, undefined);
  });
}

test("a failed Reject sweep fences global mailbox actions before consumption", async (t) => {
  let recommendation;
  let decisions = 0;
  let recoveryCalls = 0;
  const h = harness(t, {
    initialClock: Date.now(),
    decorateStore: (integrationStore) => ({
      ...integrationStore,
      readGlobalRecommendations: () => recommendation ? [recommendation] : [],
      recoverGlobalRejections() {
        recoveryCalls += 1;
        return { ok: false, reason: "global-rejection-decision-conflict", recovered: [] };
      },
    }),
    integrationOptions: {
      stateRoot: true,
      __testGlobalDecisionDomain: {
        async decide() { decisions += 1; return { ok: true }; },
        async recover() { return []; },
      },
    },
  });
  const timestamp = h.now();
  const subject = globalActionSubject("apply", h.store.rootIdentity, timestamp);
  recommendation = subject.recommendation;
  publishGlobalRecommendationProjection(h.root, subject.projection, {
    store: h.store,
    expectedGeneration: null,
    now: timestamp,
  });
  const projected = readGlobalRecommendationProjection(h.root, { now: timestamp });
  const grant = projected.grants.find((value) => value.action === "apply");
  const actingProjectFingerprint = createHash("sha256").update("failed-reject-sweep-acting").digest("hex");
  const health = publishTuiHostHealth(h.root, {
    projectFingerprint: actingProjectFingerprint,
    stateRootIdentity: h.store.rootIdentity,
    hostVersion: "0.3.0",
    issuedAt: timestamp,
    expiresAt: timestamp + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
  });
  const request = createGlobalActionRequest({
    grant,
    actingProjectFingerprint,
    actingHealth: health,
    timestamp,
    requestId: randomUUID(),
  });
  submitGlobalActionRequest(h.root, request);

  const pass = await h.integration.processMailbox();

  assert.equal(pass.ok, true);
  assert.equal(pass.globalActions.ok, false);
  assert.equal(pass.globalActions.reason, "global-rejection-decision-conflict");
  assert.deepEqual(pass.globalActions.processed, []);
  assert.equal(recoveryCalls >= 1, true);
  assert.equal(decisions, 0);
  assert.equal(pendingGlobalActionRequestCount(h.root), 1);
  assert.equal(pollGlobalActionResponse(h.root, request, { now: h.now() }), null);
});

test("project analysis control is project-scoped, projection-bound, replay-safe, and legacy-control inert", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  assert.equal(projected.dashboard.capabilities.includes("project-analysis-control-v1"), true);
  assert.equal(projected.dashboard.supportedControls.includes("set-repo-mode"), true);
  const grant = projected.index.allowedActions.find((action) => action.action === "set-repo-mode");
  assert.ok(grant);
  const before = h.store.getSettings();
  const control = readControlState(h.root, FINGERPRINT, { now: h.now() });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant,
    action: "set-repo-mode",
    payload: { mode: "auto", settingsVersion: control.settingsVersion },
    timestamp: h.now(),
    requestId: "project-analysis-auto",
  });
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  const response = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(response.ok, true, response.reason);
  const after = h.store.getSettings();
  assert.equal(after.repo.mode, "auto");
  assert.deepEqual(after.global, before.global, "project analysis control changes no global default or consent");

  assert.throws(() => submitUiOperationRequest(h.root, request), /operation-response-already-exists/u);
  assert.equal(h.store.getSettings().repo.mode, "auto", "replay recovery does not repeat the mutation");

  await h.integration.processMailbox();
  const staleProjection = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const staleGrant = staleProjection.index.allowedActions.find((action) => action.action === "set-repo-mode");
  const staleControl = readControlState(h.root, FINGERPRINT, { now: h.now() });
  const stale = createUiOperationRequest({
    projection: staleProjection.index,
    grant: staleGrant,
    action: "set-repo-mode",
    payload: { mode: "auto", settingsVersion: staleControl.settingsVersion },
    timestamp: h.now(),
    requestId: "project-analysis-stale",
  });
  assert.equal(h.store.updateRepoSettings((repo) => schemas.makeRepoSettings({ ...repo, mode: "manual" })).ok, true);
  submitUiOperationRequest(h.root, stale);
  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, stale, { now: h.now() }).ok, false);
  assert.equal(h.store.getSettings().repo.mode, "manual");

  const legacyState = readControlState(h.root, FINGERPRINT, { now: h.now() });
  const legacy = createControlRequest({
    controlState: legacyState,
    action: "set-repo-mode",
    payload: { mode: "auto" },
    timestamp: h.now(),
    requestId: "legacy-project-analysis",
  });
  submitControlRequest(h.root, legacy);
  await h.integration.processMailbox();
  assert.equal(pollControlResponse(h.root, FINGERPRINT, legacy.requestId).ok, false);
  assert.equal(h.store.getSettings().repo.mode, "manual");
});

test("a legacy yolo control request is rejected outright and never changes the stored mode", async (t) => {
  for (const action of ["set-mode", "set-repo-mode"]) {
    const blocked = harness(t, {
      initialClock: Date.now(),
      inventory: inventoryModule,
      integrationOptions: { stateRoot: true },
    });
    await blocked.integration.processMailbox();
    const controlState = readControlState(blocked.root, FINGERPRINT, { now: blocked.now() });
    const request = createControlRequest({
      controlState,
      action,
      payload: action === "set-mode"
        ? { mode: "yolo", confirmation: "ENABLE YOLO", allowlist: [blocked.root] }
        : { mode: "yolo" },
      timestamp: blocked.now(),
      requestId: `legacy-yolo-${action}`,
    });
    submitControlRequest(blocked.root, request);
    await blocked.integration.processMailbox();
    const response = pollControlResponse(blocked.root, FINGERPRINT, request.requestId);
    assert.equal(response.ok, false);
    // Legacy project-mode control is already inert in v0.3; a yolo payload is
    // rejected either by that gate or by the explicit yolo retirement.
    assert.match(response.reason, /legacy-project-analysis-control-disabled|yolo-retired/u);
    assert.equal(blocked.store.getSettings().global.mode, "manual");
    assert.equal(blocked.store.getSettings().repo.mode, "inherit");
  }
});

for (const controlCase of [
  { action: "set-mode", payload: { mode: "auto" } },
  { action: "set-consent", payload: { key: "sanitizedExcerpts", enabled: true } },
  { action: "set-repo-excluded", payload: { excluded: true } },
  { action: "update-allowlist", payload: (root) => ({ allowlist: [root], confirmation: "UPDATE ALLOWLIST" }) },
]) {
  test(`${controlCase.action} recovers its exact committed result after response-publication crash`, async (t) => {
    let interrupt = true;
    const h = harness(t, {
      initialClock: Date.now(),
      inventory: inventoryModule,
      integrationOptions: {
        stateRoot: true,
        __testAfterRequestHandled({ type, request }) {
          if (!interrupt || type !== "control" || request?.action !== controlCase.action) return;
          interrupt = false;
          throw new Error("simulated-control-response-crash");
        },
      },
    });
    await h.integration.processMailbox();
    const controlState = readControlState(h.root, FINGERPRINT, { now: h.now() });
    const request = createControlRequest({
      controlState,
      action: controlCase.action,
      payload: typeof controlCase.payload === "function" ? controlCase.payload(h.root) : controlCase.payload,
      timestamp: h.now(),
      requestId: `control-crash-${controlCase.action}`,
    });
    submitControlRequest(h.root, request);

    const interrupted = await h.integration.processMailbox();
    assert.equal(interrupted.ok, false);
    assert.equal(pollControlResponse(h.root, FINGERPRINT, request.requestId), null);
    const committed = JSON.stringify(h.store.getSettings());

    await h.integration.processMailbox();
    assert.equal(pollControlResponse(h.root, FINGERPRINT, request.requestId).ok, true);
    assert.equal(JSON.stringify(h.store.getSettings()), committed);
    assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.details?.action === "control-request-complete" && record.payload.details.requestId === request.requestId).length, 1);
  });
}

test("native operation mailbox version-binds pause and recovers one exact response", async (t) => {
  const h = harness(t, {
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  const initialPass = await h.integration.processMailbox();
  assert.equal(initialPass.uiProjectionError, undefined, JSON.stringify(initialPass));
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const grant = projected.index.allowedActions.find((action) => action.action === "set-paused");
  assert.ok(grant, JSON.stringify({
    actions: projected.index.allowedActions,
    grants: h.store.readRecords("audit-event").map((record) => record.payload.details).filter((details) => details?.action === "ui-operation-nonce"),
    generation: projected.index.generation,
    currentGeneration: h.store.readProjectionSnapshot().generation,
  }));
  const control = readControlState(h.root, FINGERPRINT, { now: h.now() });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant,
    payload: { paused: true, settingsVersion: control.settingsVersion },
    timestamp: h.now(),
    requestId: "native-pause-request",
  });
  assert.equal(submitUiOperationRequest(h.root, request).ok, true);
  const consumed = await h.integration.processMailbox();
  assert.equal(consumed.operations.length, 1);
  const response = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(response.ok, true);
  assert.equal(h.store.getSettings().global.paused, true);
  const statuses = h.store.readRecords("audit-event")
    .map((record) => record.payload.details)
    .filter((details) => details?.requestId === request.requestId && details?.action === "ui-operation-status")
    .map((details) => details.status);
  assert.deepEqual(statuses, ["queued", "running", "completed"]);
  assert.throws(() => submitUiOperationRequest(h.root, request), /operation-response-already-exists/u);
});

test("native root-policy replacement revalidates canonical global roots and commits exact capabilities", async (t) => {
  const h = harness(t, {
    inventory: inventoryModule,
    useFixtureProjectDirectory: true,
    integrationOptions: { stateRoot: true },
  });
  const approvedRoot = path.join(h.root, "approved-global-skills");
  mkdirSync(approvedRoot);
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const grant = projected.effectiveIndexActions.find((action) => action.action === "replace-global-root-policy");
  assert.ok(grant);
  const request = createUiOperationRequest({
    projection: projected.index,
    grant,
    payload: {
      roots: [{ canonicalPath: approvedRoot, canUpdate: true, canCreate: true }],
      creationRootPath: approvedRoot,
      confirmation: projected.dashboard.settings.globalRootPolicyConfirmation,
      settingsVersion: projected.dashboard.settings.globalSettingsVersion,
    },
    timestamp: h.now(),
    requestId: "native-root-policy-request",
  });
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();

  const response = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(response.ok, true, response.reason);
  assert.deepEqual(h.store.getSettings().global.globalRootPolicy.roots.map((root) => ({
    canonicalPath: root.canonicalPath,
    canUpdate: root.canUpdate,
    canCreate: root.canCreate,
  })), [{ canonicalPath: approvedRoot, canUpdate: true, canCreate: true }]);
});

test("native root-policy replacement rejects missing, project-local, and symlinked roots without mutation", async (t) => {
  for (const invalidCase of ["missing", "project-local", "symlinked"]) {
    const h = harness(t, {
      inventory: inventoryModule,
      useFixtureProjectDirectory: true,
      integrationOptions: { stateRoot: true },
    });
    let candidate;
    if (invalidCase === "missing") {
      candidate = path.join(h.root, "missing-global-skills");
    } else if (invalidCase === "project-local") {
      candidate = path.join(h.ctx.directory, ".opencode", "skills");
      mkdirSync(candidate, { recursive: true });
    } else {
      const real = path.join(h.root, "real-global-skills");
      candidate = path.join(h.root, "linked-global-skills");
      mkdirSync(real);
      symlinkSync(real, candidate);
    }
    await h.integration.processMailbox();
    const projected = readUiProjection(h.root, FINGERPRINT, {
      now: h.now(),
      clientOffer: {
        projectionVersions: [UI_PROJECTION_VERSION],
        operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
        capabilities: UI_CAPABILITIES,
      },
    });
    const request = createUiOperationRequest({
      projection: projected.index,
      grant: projected.effectiveIndexActions.find((action) => action.action === "replace-global-root-policy"),
      payload: {
        roots: [{ canonicalPath: candidate, canUpdate: true, canCreate: false }],
        creationRootPath: null,
        confirmation: projected.dashboard.settings.globalRootPolicyConfirmation,
        settingsVersion: projected.dashboard.settings.globalSettingsVersion,
      },
      timestamp: h.now(),
      requestId: `invalid-root-policy-${invalidCase}`,
    });
    submitUiOperationRequest(h.root, request);
    await h.integration.processMailbox();
    const response = pollUiOperationResponse(h.root, request, { now: h.now() });
    assert.equal(response.ok, false, invalidCase);
    assert.match(response.reason, invalidCase === "project-local" ? /project-skill-root-prohibited/u : /approved-root-noncanonical/u);
    assert.equal(h.store.getSettings().global.globalRootPolicy, null);
  }
});

test("native root-policy replacement aborts when locked catalog revalidation observes drift", async (t) => {
  let rejectLockedValidation = false;
  const inventory = {
    ...inventoryModule,
    buildGlobalSkillCatalog(...args) {
      if (rejectLockedValidation) {
        return { ok: false, blockers: [{ code: "global-root-drift-during-commit" }] };
      }
      return inventoryModule.buildGlobalSkillCatalog(...args);
    },
  };
  const h = harness(t, {
    inventory,
    useFixtureProjectDirectory: true,
    integrationOptions: {
      stateRoot: true,
      __testAfterRootPolicyPrevalidation() {
        rejectLockedValidation = true;
      },
    },
  });
  const approvedRoot = path.join(h.root, "race-global-skills");
  mkdirSync(approvedRoot);
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.effectiveIndexActions.find((action) => action.action === "replace-global-root-policy"),
    payload: {
      roots: [{ canonicalPath: approvedRoot, canUpdate: true, canCreate: true }],
      creationRootPath: approvedRoot,
      confirmation: projected.dashboard.settings.globalRootPolicyConfirmation,
      settingsVersion: projected.dashboard.settings.globalSettingsVersion,
    },
    timestamp: h.now(),
    requestId: "root-policy-locked-revalidation-race",
  });
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();

  const response = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(response.ok, false);
  assert.equal(response.reason, "global-root-drift-during-commit");
  assert.equal(h.store.getSettings().global.globalRootPolicy, null);
  const audits = h.store.readRecords("audit-event").map((record) => record.payload.details);
  assert.equal(audits.filter((details) => details?.action === "replace-global-root-policy").length, 0);
  const completions = audits.filter((details) => details?.action === "ui-operation-complete"
    && details.requestId === request.requestId);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].accepted, false);
  assert.equal(completions[0].terminal, false);
  assert.equal(completions[0].reason, "global-root-drift-during-commit");
  assert.equal(completions[0].uiAction, "replace-global-root-policy");
  assert.equal(completions[0].nonceHash, createHash("sha256").update(request.nonce).digest("hex"));
  assert.equal(completions[0].requestDigest, createHash("sha256")
    .update(`self-evolve-operation-request-completion-v1\n${JSON.stringify(request)}`).digest("hex"));
});

test("root-policy validation rejection survives response-publication crash without re-entering authority", async (t) => {
  let rejectLockedValidation = false;
  let prevalidationHooks = 0;
  let effectCalls = 0;
  let interruptResponse = true;
  const inventory = {
    ...inventoryModule,
    buildGlobalSkillCatalog(...args) {
      if (rejectLockedValidation) {
        return { ok: false, blockers: [{ code: "global-root-drift-during-commit" }] };
      }
      return inventoryModule.buildGlobalSkillCatalog(...args);
    },
  };
  const h = harness(t, {
    inventory,
    useFixtureProjectDirectory: true,
    integrationOptions: {
      stateRoot: true,
      __testAfterRootPolicyPrevalidation() {
        prevalidationHooks += 1;
        if (prevalidationHooks === 1) rejectLockedValidation = true;
      },
      __testAfterOperationEffect({ request }) {
        if (request.action === "replace-global-root-policy") effectCalls += 1;
      },
      __testAfterRequestHandled({ type, request }) {
        if (!interruptResponse || type !== "operation" || request?.action !== "replace-global-root-policy") return;
        interruptResponse = false;
        rejectLockedValidation = false;
        throw new Error("simulated-root-policy-response-crash");
      },
    },
  });
  const approvedRoot = path.join(h.root, "recoverable-race-global-skills");
  mkdirSync(approvedRoot);
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.effectiveIndexActions.find((action) => action.action === "replace-global-root-policy"),
    payload: {
      roots: [{ canonicalPath: approvedRoot, canUpdate: true, canCreate: true }],
      creationRootPath: approvedRoot,
      confirmation: projected.dashboard.settings.globalRootPolicyConfirmation,
      settingsVersion: projected.dashboard.settings.globalSettingsVersion,
    },
    timestamp: h.now(),
    requestId: "root-policy-rejection-response-crash",
  });
  submitUiOperationRequest(h.root, request);

  const interrupted = await h.integration.processMailbox();
  assert.equal(interrupted.ok, false);
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }), null);
  let completions = h.store.readRecords("audit-event")
    .map((record) => record.payload.details)
    .filter((details) => details?.action === "ui-operation-complete" && details.requestId === request.requestId);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].accepted, false);
  assert.equal(completions[0].reason, "global-root-drift-during-commit");
  assert.equal(h.store.getSettings().global.globalRootPolicy, null);

  await h.integration.processMailbox();
  const recovered = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.reason, "global-root-drift-during-commit");
  assert.equal(prevalidationHooks, 1);
  assert.equal(effectCalls, 1);
  assert.equal(h.store.getSettings().global.globalRootPolicy, null);
  const audits = h.store.readRecords("audit-event").map((record) => record.payload.details);
  completions = audits.filter((details) => details?.action === "ui-operation-complete"
    && details.requestId === request.requestId);
  assert.equal(completions.length, 1);
  assert.equal(audits.filter((details) => details?.action === "replace-global-root-policy").length, 0);
});

test("a settings operation killed after its effect replays its transactional completion without mutation", async (t) => {
  let interrupt = true;
  const h = harness(t, {
    inventory: inventoryModule,
    integrationOptions: {
      stateRoot: true,
      __testAfterOperationEffect() {
        if (!interrupt) return;
        interrupt = false;
        throw new Error("simulated-process-death-after-effect");
      },
    },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
  });
  const control = readControlState(h.root, FINGERPRINT, { now: h.now() });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.index.allowedActions.find((action) => action.action === "set-paused"),
    payload: { paused: true, settingsVersion: control.settingsVersion },
    timestamp: h.now(),
    requestId: "pause-effect-crash",
  });
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  const committedUpdatedAt = h.store.getSettings().global.updatedAt;
  const responsePath = path.join(h.root, "self-evolve", "bridge", FINGERPRINT, "operation-responses", `${request.requestId}.json`);
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, false);
  unlinkSync(responsePath);
  submitUiOperationRequest(h.root, request);

  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, true);
  assert.equal(h.store.getSettings().global.updatedAt, committedUpdatedAt);
  assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.details?.action === "ui-operation-complete" && record.payload.details.requestId === request.requestId).length, 1);
});

test("an export killed after publication recovers exact metadata without creating a second artifact", async (t) => {
  let interrupt = true;
  const h = harness(t, {
    inventory: inventoryModule,
    privacy: (store) => ({
      exportScope: () => store.exportProject(),
      exportAll: () => store.exportAll(),
      purgeScope: ({ scope }) => store.purge({ scope }),
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: {
      stateRoot: true,
      __testAfterOperationEffect({ request }) {
        if (!interrupt || request.action !== "export-data") return;
        interrupt = false;
        throw new Error("simulated-process-death-after-export");
      },
    },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
  });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.index.allowedActions.find((action) => action.action === "export-data"),
    payload: { scope: "project", confirmation: "EXPORT SENSITIVE SELF-EVOLVE DATA" },
    timestamp: h.now(),
    requestId: "export-effect-crash",
  });
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  const responsePath = path.join(h.root, "self-evolve", "bridge", FINGERPRINT, "operation-responses", `${request.requestId}.json`);
  unlinkSync(responsePath);
  const exportDir = path.join(h.root, "self-evolve", "exports", FINGERPRINT);
  const before = readdirSync(exportDir).filter((name) => !name.endsWith(".lock")).sort();
  assert.equal(before.filter((name) => /^\d+-.+\.json$/u.test(name) && !name.endsWith(".meta.json")).length, 1);
  submitUiOperationRequest(h.root, request);

  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, true);
  assert.deepEqual(readdirSync(exportDir).filter((name) => !name.endsWith(".lock")).sort(), before);
  const completion = h.store.readRecords("audit-event").map((record) => record.payload).findLast((event) => event.details?.action === "ui-operation-complete" && event.details.requestId === request.requestId);
  assert.match(completion.details.exportPath, /\.json$/u);
  assert.match(completion.details.exportSha256, /^[a-f0-9]{64}$/u);
});

test("native global recommendation export omits project and unrelated global state", async (t) => {
  const h = harness(t, {
    inventory: inventoryModule,
    privacy: (store) => createPrivacyGuard({ projectFingerprint: FINGERPRINT, store }),
    integrationOptions: { stateRoot: true },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
  });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.index.allowedActions.find((action) => action.action === "export-data"),
    payload: { scope: "global-recommendations", confirmation: "EXPORT SENSITIVE SELF-EVOLVE DATA" },
    timestamp: h.now(),
    requestId: "global-recommendations-export",
  });
  submitUiOperationRequest(h.root, request);

  await h.integration.processMailbox();
  const response = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(response.ok, true);
  const completion = h.store.readRecords("audit-event").map((record) => record.payload).findLast((event) =>
    event.details?.action === "ui-operation-complete" && event.details.requestId === request.requestId);
  const archive = JSON.parse(readFileSync(completion.details.exportPath, "utf8"));
  assert.equal(archive.exportScope, "global-recommendations");
  assert.deepEqual(archive.records, []);
  assert.deepEqual(archive.projects, []);
  assert.deepEqual(archive.bridge, []);
  assert.equal("settings" in archive.global, false);
  assert.equal("contributions" in archive.global, false);
  assert.equal("aggregates" in archive.global, false);
});

test("a slash-command purge invalidates the cached sensitive export manager", async (t) => {
  const h = harness(t, {
    inventory: inventoryModule,
    privacy: (store) => ({
      exportScope: () => store.exportProject(),
      exportAll: () => store.exportAll(),
      purgeScope: ({ scope }) => store.purge({ scope }),
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: { stateRoot: true },
  });

  async function exportProject(requestId) {
    await h.integration.processMailbox();
    const projected = readUiProjection(h.root, FINGERPRINT, {
      now: h.now(),
      clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
    });
    const request = createUiOperationRequest({
      projection: projected.index,
      grant: projected.index.allowedActions.find((action) => action.action === "export-data"),
      payload: { scope: "project", confirmation: "EXPORT SENSITIVE SELF-EVOLVE DATA" },
      timestamp: h.now(),
      requestId,
    });
    submitUiOperationRequest(h.root, request);
    await h.integration.processMailbox();
    return pollUiOperationResponse(h.root, request, { now: h.now() });
  }

  assert.equal((await exportProject("export-before-slash-purge")).ok, true);
  assert.match((await h.integration.handleCommand("purge observations")).responseText, /Purge observations completed/u);
  const after = await exportProject("export-after-slash-purge");
  assert.equal(after.ok, true);
  assert.notEqual(after.reason, "unknown-error");
});

test("a failed native purge clears the export manager cache in finally", async (t) => {
  let managersCreated = 0;
  const h = harness(t, {
    inventory: inventoryModule,
    privacy: (store) => ({
      exportScope: () => store.exportProject(),
      exportAll: () => store.exportAll(),
      purgeScope: ({ scope }) => store.purge({ scope }),
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: {
      stateRoot: true,
      __testCreateSensitiveExportManager(args) {
        managersCreated += 1;
        const manager = createSensitiveExportManager(args);
        if (managersCreated !== 1) return manager;
        return Object.freeze({
          ...manager,
          purge() { throw new Error("injected-export-purge-failure"); },
        });
      },
    },
  });

  async function operation(action, payload, requestId) {
    await h.integration.processMailbox();
    const projected = readUiProjection(h.root, FINGERPRINT, {
      now: h.now(),
      clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
    });
    const request = createUiOperationRequest({
      projection: projected.index,
      grant: projected.index.allowedActions.find((item) => item.action === action),
      payload,
      timestamp: h.now(),
      requestId,
    });
    submitUiOperationRequest(h.root, request);
    await h.integration.processMailbox();
    return pollUiOperationResponse(h.root, request, { now: h.now() });
  }

  const failed = await operation(
    "purge-scope",
    { scope: "observations", confirmation: "PURGE OBSERVATIONS" },
    "failed-export-manager-purge",
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "injected-export-purge-failure");

  const exported = await operation(
    "export-data",
    { scope: "project", confirmation: "EXPORT SENSITIVE SELF-EVOLVE DATA" },
    "export-after-failed-manager-purge",
  );
  assert.equal(exported.ok, true);
  assert.equal(managersCreated, 2);
});

test("a real process kill after export publication replays completion without a second artifact", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    privacy: (store) => ({
      exportScope: () => store.exportProject(),
      exportAll: () => store.exportAll(),
      purgeScope: ({ scope }) => store.purge({ scope }),
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: { stateRoot: true },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
  });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.index.allowedActions.find((action) => action.action === "export-data"),
    payload: { scope: "project", confirmation: "EXPORT SENSITIVE SELF-EVOLVE DATA" },
    timestamp: h.now(),
    requestId: "export-process-kill",
  });
  submitUiOperationRequest(h.root, request);
  const requestDigest = createHash("sha256").update(`self-evolve-operation-request-completion-v1\n${JSON.stringify(request)}`).digest("hex");
  assert.equal(h.store.beginRequestTransaction({
    requestId: request.requestId,
    projectFingerprint: request.projectFingerprint,
    requestDigest,
    nonceHash: createHash("sha256").update(request.nonce).digest("hex"),
    action: request.action,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
  }).ok, true);
  const killed = spawnSync(process.execPath, [OPERATION_EFFECT_CRASH, h.root, FINGERPRINT], { encoding: "utf8", timeout: 10_000 });
  assert.equal(killed.signal, "SIGKILL", JSON.stringify({ status: killed.status, signal: killed.signal, stdout: killed.stdout, stderr: killed.stderr }));
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }), null);
  const exportDir = path.join(h.root, "self-evolve", "exports", FINGERPRINT);
  const before = readdirSync(exportDir).filter((name) => !name.endsWith(".lock")).sort();
  for (let elapsed = 0; elapsed <= 20_000; elapsed += 1) h.now();

  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, true);
  assert.deepEqual(readdirSync(exportDir).filter((name) => !name.endsWith(".lock")).sort(), before);
  assert.equal(existsSync(path.join(h.root, "self-evolve", "request-transaction.json")), false);
});

test("project purge preserves only its in-flight request and reconstructs completion without repurge", async (t) => {
  let interrupt = true;
  const h = harness(t, {
    inventory: inventoryModule,
    privacy: (store) => ({
      exportScope: () => store.exportProject(),
      exportAll: () => store.exportAll(),
      purgeScope: ({ scope }) => store.purge({ scope }),
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: {
      stateRoot: true,
      __testAfterOperationEffect({ request }) {
        if (!interrupt || request.action !== "purge-scope") return;
        interrupt = false;
        throw new Error("simulated-process-death-after-project-purge");
      },
    },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
  });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.index.allowedActions.find((action) => action.action === "purge-scope"),
    payload: { scope: "project", confirmation: "PURGE PROJECT" },
    timestamp: h.now(),
    requestId: "project-purge-effect-crash",
  });
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  const responsePath = path.join(h.root, "self-evolve", "bridge", FINGERPRINT, "operation-responses", `${request.requestId}.json`);
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, false);
  assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.kind === "purge" && record.payload.details.action === "project").length, 1);
  unlinkSync(responsePath);
  submitUiOperationRequest(h.root, request);

  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, true);
  assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.kind === "purge" && record.payload.details.action === "project").length, 1);
  assert.equal(existsSync(path.join(h.root, "self-evolve", "request-transaction.json")), false);
});

for (const scope of ["observations", "global-recommendations"]) {
  test(`${scope} purge reconstructs completion after an effect crash without repurge`, async (t) => {
    let interrupt = true;
    const h = harness(t, {
      inventory: inventoryModule,
      privacy: (store) => ({
        exportScope: () => store.exportProject(),
        exportAll: () => store.exportAll(),
        purgeScope: ({ scope: requestedScope }) => store.purge({ scope: requestedScope }),
        scanForForbiddenContent: () => ({ ok: true, issues: [] }),
      }),
      integrationOptions: {
        stateRoot: true,
        __testAfterOperationEffect({ request }) {
          if (!interrupt || request.action !== "purge-scope") return;
          interrupt = false;
          throw new Error(`simulated-process-death-after-${scope}-purge`);
        },
      },
    });
    await h.integration.processMailbox();
    const projected = readUiProjection(h.root, FINGERPRINT, {
      now: h.now(),
      clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
    });
    const request = createUiOperationRequest({
      projection: projected.index,
      grant: projected.index.allowedActions.find((action) => action.action === "purge-scope"),
      payload: { scope, confirmation: `PURGE ${scope.toUpperCase()}` },
      timestamp: h.now(),
      requestId: `${scope}-purge-effect-crash`,
    });
    submitUiOperationRequest(h.root, request);
    await h.integration.processMailbox();
    const responsePath = path.join(h.root, "self-evolve", "bridge", FINGERPRINT, "operation-responses", `${request.requestId}.json`);
    assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, false);
    assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.kind === "purge" && record.payload.details.action === scope).length, 1);
    unlinkSync(responsePath);
    submitUiOperationRequest(h.root, request);

    await h.integration.processMailbox();
    assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).ok, true);
    assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.kind === "purge" && record.payload.details.action === scope).length, 1);
    assert.equal(existsSync(path.join(h.root, "self-evolve", "request-transaction.json")), false);
  });
}

test("native operation mailbox rejects a stale projection without settings mutation", async (t) => {
  const h = harness(t, {
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const grant = projected.index.allowedActions.find((action) => action.action === "set-kill-switch");
  assert.ok(grant, JSON.stringify(projected.index.allowedActions));
  const control = readControlState(h.root, FINGERPRINT, { now: h.now() });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant,
    payload: { enabled: true, settingsVersion: control.settingsVersion },
    timestamp: h.now(),
  });
  assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
  submitUiOperationRequest(h.root, request);
  await h.integration.processMailbox();
  const response = pollUiOperationResponse(h.root, request, { now: h.now() });
  assert.equal(response.ok, false);
  assert.match(response.reason, /stale|unavailable/u);
  assert.equal(h.store.getSettings().global.killSwitchActive, false);
});

test("native purge-all acknowledges accepted-terminal before bounded destructive work", async (t) => {
  let purgeCallback;
  let resolveCycle;
  const deferredCycle = { promise: new Promise((resolve) => { resolveCycle = resolve; }) };
  const h = harness(t, {
    deferredCycle,
    inventory: inventoryModule,
    privacy: (store) => ({
      exportScope: () => ({ projectFingerprint: FINGERPRINT, records: [] }),
      exportAll: () => ({ projectFingerprint: FINGERPRINT, records: [] }),
      purgeScope({ scope }) {
        const result = store.purge({ scope });
        if (scope === "all") throw new Error("simulated-terminal-purge-failure");
        return result;
      },
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: {
      stateRoot: true,
      __testSetTerminalPurgeTimeout(callback) {
        purgeCallback = callback;
        return { unref() {} };
      },
    },
  });
  h.integration.__testBridge.setMode("auto");
  const running = h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "native-purge-drain" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.integration.getInFlightWork().length, 1);
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const grant = projected.index.allowedActions.find((action) => action.action === "purge-all");
  const request = createUiOperationRequest({
    projection: projected.index,
    grant,
    payload: { confirmation: "PURGE ALL SELF-EVOLVE 0.3.0" },
    timestamp: h.now(),
  });
  submitUiOperationRequest(h.root, request);
  const consumed = await h.integration.processMailbox();
  assert.equal(consumed.operations[0].status, "accepted-terminal");
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).status, "accepted-terminal");
  assert.equal(existsSync(path.join(h.root, "self-evolve")), true);
  assert.equal(deferredCycle.signal.aborted, true);
  assert.equal(h.calls.schedulerDisposals ?? 0, 0);
  purgeCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(path.join(h.root, "self-evolve")), true, "purge waits for admitted work to terminalize");
  resolveCycle({ result: "failed-closed", cycleOutcome: "failed-closed", reason: "autonomous-work-cancelled" });
  await running;
  const deadline = Date.now() + 1_000;
  while (existsSync(path.join(h.root, "self-evolve")) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(existsSync(path.join(h.root, "self-evolve")), false);
  assert.equal(h.integration.__testBridge.getHealth().lastError, "simulated-terminal-purge-failure");
  assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: {} }), {
    scheduled: false,
    reason: "restart-required-after-purge-all",
  });
  await h.integration.shutdown();
});

test("purge-all boot recovery republishes accepted-terminal before destructive mailbox purge", async (t) => {
  let interrupt = true;
  let purgeCallback;
  let purgeCalls = 0;
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    privacy: (store) => ({
      exportScope: () => store.exportProject(),
      exportAll: () => store.exportAll(),
      purgeScope({ scope }) {
        if (scope === "all") purgeCalls += 1;
        return store.purge({ scope });
      },
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: {
      stateRoot: true,
      __testAfterRequestHandled({ type, request }) {
        if (!interrupt || type !== "operation" || request?.action !== "purge-all") return;
        interrupt = false;
        throw new Error("simulated-crash-before-operation-response");
      },
      __testSetTerminalPurgeTimeout(callback) {
        purgeCallback = callback;
        return { unref() {} };
      },
    },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.index.allowedActions.find((action) => action.action === "purge-all"),
    payload: { confirmation: "PURGE ALL SELF-EVOLVE 0.3.0" },
    timestamp: h.now(),
    requestId: "purge-all-response-crash",
  });
  submitUiOperationRequest(h.root, request);

  const interrupted = await h.integration.processMailbox();
  assert.equal(interrupted.ok, false);
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }), null);
  assert.equal(purgeCalls, 0);
  assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.details?.action === "ui-operation-complete" && record.payload.details.requestId === request.requestId).length, 1);

  const recovered = await h.integration.boot({ recoverHostSessions: false });
  assert.equal(recovered.reason, "restart-required-after-purge-all");
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).status, "accepted-terminal");
  assert.equal(purgeCalls, 0);
  assert.equal(typeof purgeCallback, "function");

  purgeCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(purgeCalls, 1);
  assert.equal(existsSync(path.join(h.root, "self-evolve")), false);
});

test("a real process kill after purge-all completion republishes accepted-terminal before purge", async (t) => {
  let purgeCallback;
  let purgeCalls = 0;
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    privacy: (store) => ({
      exportScope: () => store.exportProject(),
      exportAll: () => store.exportAll(),
      purgeScope({ scope }) {
        if (scope === "all") purgeCalls += 1;
        return store.purge({ scope });
      },
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: {
      stateRoot: true,
      __testSetTerminalPurgeTimeout(callback) {
        purgeCallback = callback;
        return { unref() {} };
      },
    },
  });
  await h.integration.processMailbox();
  const projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const request = createUiOperationRequest({
    projection: projected.index,
    grant: projected.index.allowedActions.find((action) => action.action === "purge-all"),
    payload: { confirmation: "PURGE ALL SELF-EVOLVE 0.3.0" },
    timestamp: h.now(),
    requestId: "purge-all-process-kill",
  });
  submitUiOperationRequest(h.root, request);
  const requestDigest = createHash("sha256").update(`self-evolve-operation-request-completion-v1\n${JSON.stringify(request)}`).digest("hex");
  assert.equal(h.store.beginRequestTransaction({
    requestId: request.requestId,
    projectFingerprint: request.projectFingerprint,
    requestDigest,
    nonceHash: createHash("sha256").update(request.nonce).digest("hex"),
    action: request.action,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
  }).ok, true);

  const killed = spawnSync(process.execPath, [OPERATION_EFFECT_CRASH, h.root, FINGERPRINT, "before-response"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(killed.signal, "SIGKILL", JSON.stringify({ status: killed.status, signal: killed.signal, stdout: killed.stdout, stderr: killed.stderr }));
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }), null);
  assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.details?.action === "ui-operation-complete" && record.payload.details.requestId === request.requestId).length, 1);
  for (let elapsed = 0; elapsed <= 20_000; elapsed += 1) h.now();

  await h.integration.processMailbox();
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).status, "accepted-terminal");
  assert.equal(purgeCalls, 0);
  purgeCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(purgeCalls, 1);
  assert.equal(existsSync(path.join(h.root, "self-evolve")), false);
});

for (const action of [
  "export-data",
  "purge-all",
  "purge-scope",
  "replace-global-root-policy",
  "retry-bootstrap",
  "rollback-proposal",
  "set-kill-switch",
  "set-paused",
  "snooze-proposal",
]) {
  test(`${action} replays one durable result without re-entering operation authority`, async (t) => {
    let executions = 0;
    let interrupt = true;
    let terminalPurgeCallback;
    const h = harness(t, {
      initialClock: Date.now(),
      inventory: inventoryModule,
      useFixtureProjectDirectory: action === "replace-global-root-policy",
      privacy: (store) => ({
        exportScope: () => store.exportProject(),
        exportAll: () => store.exportAll(),
        purgeScope: ({ scope }) => store.purge({ scope }),
        scanForForbiddenContent: () => ({ ok: true, issues: [] }),
      }),
      integrationOptions: {
        stateRoot: true,
        ...(action === "retry-bootstrap" ? { passiveEventHookInstalled: false } : {}),
        __testAfterOperationEffect({ request }) {
          if (request.action === action) executions += 1;
        },
        __testAfterRequestHandled({ type, request }) {
          if (!interrupt || type !== "operation" || request?.action !== action) return;
          interrupt = false;
          throw new Error("simulated-operation-response-crash");
        },
        __testSetTerminalPurgeTimeout(callback) {
          terminalPurgeCallback = callback;
          return { unref() {} };
        },
      },
    });
    let subject;
    const approvedRoot = path.join(h.root, "approved-global-skills");
    if (action === "replace-global-root-policy") mkdirSync(approvedRoot);
    if (action === "snooze-proposal" || action === "rollback-proposal") {
      const currentContent = "---\nname: demo\ndescription: Existing demo skill.\n---\n# Demo\n";
      const proposedContent = "---\nname: demo\ndescription: Improved demo skill.\n---\n# Demo improved\n";
      const currentHash = createHash("sha256").update(currentContent).digest("hex");
      const proposedHash = createHash("sha256").update(proposedContent).digest("hex");
      mkdirSync(path.join(h.root, "demo"), { recursive: true });
      writeFileSync(path.join(h.root, "demo", "SKILL.md"), action === "rollback-proposal" ? proposedContent : currentContent);
      subject = proposal(h.root, {
        id: action === "rollback-proposal" ? "crash-rollback" : "crash-snooze",
        skillTarget: { canonicalRoot: h.root, relativePath: "demo/SKILL.md", currentHash },
        proposedContentHash: proposedHash,
        ...(action === "rollback-proposal" ? { state: "applied", decisionVersion: 1 } : {}),
      });
      seedProposal(h.store, subject);
      const content = schemas.makeProposalContent({
        proposalId: subject.id,
        contentHash: proposedHash,
        contentEncoding: "base64",
        chunkIndex: 0,
        chunkCount: 1,
        content: Buffer.from(proposedContent).toString("base64"),
      });
      h.store.appendRecord(schemas.wrapRecord("proposal-content", content, h.now()));
      if (action === "rollback-proposal") {
        const audit = makeAudit("apply", subject.id, { state: "readback-verified", appliedHash: proposedHash, "readback-verified": true }, h.now());
        h.store.appendRecord(schemas.wrapRecord("audit-event", audit, audit.timestamp));
      }
    }
    if (action === "retry-bootstrap") assert.equal(h.integration.__testBridge.setMode("auto").ok, true);
    await h.integration.processMailbox();
    const projected = readUiProjection(h.root, FINGERPRINT, {
      now: h.now(),
      clientOffer: { projectionVersions: [UI_PROJECTION_VERSION], operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION], capabilities: UI_CAPABILITIES },
      ...(subject ? { detailProposalIds: [subject.id] } : {}),
    });
    const grant = subject
      ? projected.details.find((detail) => detail.proposalId === subject.id).allowedActions.find((item) => item.action === action)
      : projected.effectiveIndexActions.find((item) => item.action === action);
    assert.ok(grant, JSON.stringify({ action, status: projected.index.status, allowed: projected.index.allowedActions, details: projected.details }));
    const control = readControlState(h.root, FINGERPRINT, { now: h.now() });
    const payload = action === "export-data" ? { scope: "project", confirmation: "EXPORT SENSITIVE SELF-EVOLVE DATA" }
      : action === "purge-all" ? { confirmation: "PURGE ALL SELF-EVOLVE 0.3.0" }
        : action === "purge-scope" ? { scope: "observations", confirmation: "PURGE OBSERVATIONS" }
          : action === "replace-global-root-policy" ? {
            roots: [{ canonicalPath: approvedRoot, canUpdate: true, canCreate: true }],
            creationRootPath: approvedRoot,
            confirmation: projected.dashboard.settings.globalRootPolicyConfirmation,
            settingsVersion: projected.dashboard.settings.globalSettingsVersion,
          }
          : action === "rollback-proposal" ? { proposalId: subject.id, appliedHash: subject.proposedContentHash, decisionVersion: 2 }
            : action === "set-kill-switch" ? { enabled: true, settingsVersion: control.settingsVersion }
              : action === "set-paused" ? { paused: true, settingsVersion: control.settingsVersion }
                : action === "snooze-proposal" ? {
                  proposalId: subject.id,
                  targetHash: subject.skillTarget.currentHash,
                  proposedContentHash: subject.proposedContentHash,
                  decisionVersion: 1,
                  snoozedUntil: h.now() + 60_000,
                }
                  : {};
    const request = createUiOperationRequest({
      projection: projected.index,
      grant,
      payload,
      timestamp: h.now(),
      requestId: `operation-response-crash-${action}`,
    });
    submitUiOperationRequest(h.root, request);

    const interrupted = await h.integration.processMailbox();
    assert.equal(interrupted.ok, false);
    assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }), null);
    assert.equal(executions, 1);

    await h.integration.processMailbox();
    const response = pollUiOperationResponse(h.root, request, { now: h.now() });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (action === "purge-all") {
      assert.equal(response.status, "accepted-terminal");
      assert.equal(typeof terminalPurgeCallback, "function");
    }
    assert.equal(executions, 1);
    assert.equal(h.store.readRecords("audit-event").filter((record) => record.payload.details?.action === "ui-operation-complete" && record.payload.details.requestId === request.requestId).length, 1);
  });
}

test("only scheduler-originated cycles receive the passive provider reservation API", async (t) => {
  const h = harness(t);
  h.integration.__testBridge.setMode("auto");
  await h.integration.runEvolutionCycle({ sessionID: "manual-direct", projectFingerprint: FINGERPRINT, scopeFingerprint: FINGERPRINT, trigger: { kind: "manual" } });
  assert.equal(h.calls.cycles[0].options.reservePassiveProviderCalls, undefined);

  await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "passive-scheduled" } });
  assert.equal(typeof h.calls.cycles[1].options.reservePassiveProviderCalls, "function");
  assert.deepEqual(h.calls.cycles[1].options.reservePassiveProviderCalls(2, { clusterID: "cluster" }), { ok: true, reserved: 2 });
  assert.equal(h.calls.reservations.length, 1);
});

test("auto waits for an exact approval and then applies with a restart reminder", async (t) => {
  const h = harness(t);
  h.integration.__testBridge.setMode("auto");
  const item = proposal(h.root);
  seedProposal(h.store, item);
  assert.equal(h.calls.applies.length, 0);
  const result = await h.integration.__testBridge.decide({ decision: exactDecision(item, "approved", h.now()) });
  assert.equal(result.ok, true);
  assert.equal(h.calls.applies.length, 1);
  assert.match(result.responseText, /OpenCode must be restarted/u);
  assert.equal(latestProposal(h.store, item.id).state, "applied");
});

test("application failure becomes a visible critical failed-closed record without Apply authority", async (t) => {
  const h = harness(t, { applyFailure: "injected-apply-failure" });
  h.integration.__testBridge.setMode("auto");
  const item = proposal(h.root, { id: "failed-closed-apply" });
  seedProposal(h.store, item);
  const result = await h.integration.__testBridge.decide({ decision: exactDecision(item, "approved", h.now()) });
  assert.equal(result.ok, false);
  assert.equal(latestProposal(h.store, item.id).state, "failed-closed");
  const inbox = await h.integration.handleCommand("inbox");
  assert.match(inbox.responseText, /CRITICAL failed-closed/u);
  assert.doesNotMatch(inbox.responseText, /\/self-evolve approve/u);
  assert.equal(h.integration.__testBridge.getInbox().find((entry) => entry.id === item.id).state, "failed-closed");
});

test("auto headless command applies only the exact server-issued tuple once", async (t) => {
  const withState = harness(t, { integrationOptions: { stateRoot: true } });
  withState.integration.__testBridge.setMode("auto");
  const exact = proposal(withState.root, { id: "headless-exact" });
  seedProposal(withState.store, exact);
  withState.integration.issueBridgeNonces();
  const command = headlessCommand(withState.store, exact);
  const inbox = await withState.integration.handleCommand("inbox");
  assert.match(inbox.responseText, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(inbox.responseText, /# proposed/u);
  const result = await withState.integration.handleCommand(command);
  assert.equal(result.ok, true, result.responseText);
  assert.equal(withState.calls.applies.length, 1);
  assert.equal(withState.calls.applies[0].headless, true);
  assert.equal(withState.calls.applies[0].decision.nonce, /--nonce ([a-f0-9]{48})/u.exec(command)[1]);
  assert.equal(latestProposal(withState.store, exact.id).state, "applied");
  const replay = await withState.integration.handleCommand(command);
  assert.equal(replay.ok, false);
  assert.equal(withState.calls.applies.length, 1);
});

test("headless allowlist changes are canonical, confirmed, and mode-independent", async (t) => {
  const h = harness(t, { inventory: inventoryModule });
  const extra = path.join(h.root, "approved-extra");
  mkdirSync(extra);
  const initial = await h.integration.handleCommand("allowlist list");
  assert.equal(initial.responseText.includes(h.root), true);

  const added = await h.integration.handleCommand(`allowlist add ${extra} --confirm UPDATE ALLOWLIST`);
  assert.equal(added.ok, true);
  assert.deepEqual(h.store.getSettings().global.allowedSkillRoots, [h.root, extra]);
  assert.equal(h.store.getSettings().global.mode, "manual");
  assert.equal(h.store.getSettings().global.consent.passiveCalls, true);

  const removed = await h.integration.handleCommand(`allowlist remove ${extra} --confirm UPDATE ALLOWLIST`);
  assert.equal(removed.ok, true);
  assert.deepEqual(h.store.getSettings().global.allowedSkillRoots, [h.root]);
  assert.match((await h.integration.handleCommand("allowlist add /not/a/real/folder --confirm UPDATE ALLOWLIST")).responseText, /invalid-or-unsupported-skill-folder/u);
});

test("bridge nonce issuance reads audit history once for the full actionable inbox", (t) => {
  const h = harness(t, { instrumentStore: true, integrationOptions: { stateRoot: true } });
  seedProposal(h.store, proposal(h.root, { id: "nonce-read-one" }));
  seedProposal(h.store, proposal(h.root, { id: "nonce-read-two" }));
  const baseline = h.calls.recordReads;
  h.integration.issueBridgeNonces();
  assert.equal(h.calls.recordReads - baseline, 2, "one audit read plus one proposal read");
});

test("headless approval mismatches and manual mode fail closed without apply", async (t) => {
  for (const [name, overrides] of [
    ["target hash", { targetHash: "e".repeat(64) }],
    ["content hash", { proposedContentHash: "e".repeat(64) }],
    ["version", { decisionVersion: 2 }],
    ["nonce", { nonce: "e".repeat(48) }],
  ]) await t.test(name, async (t) => {
    const h = harness(t, { integrationOptions: { stateRoot: true } });
    h.integration.__testBridge.setMode("auto");
    const item = proposal(h.root, { id: `mismatch-${name.replace(" ", "-")}` });
    seedProposal(h.store, item);
    h.integration.issueBridgeNonces();
    const result = await h.integration.handleCommand(headlessCommand(h.store, item, overrides));
    assert.equal(result.ok, false);
    assert.match(result.responseText, /approval-tuple-mismatch/u);
    assert.equal(h.calls.applies.length, 0);
    assert.equal(latestProposal(h.store, item.id).state, "pending");
  });
  await t.test("proposal id", async (t) => {
    const h = harness(t, { integrationOptions: { stateRoot: true } });
    h.integration.__testBridge.setMode("auto");
    const item = proposal(h.root, { id: "mismatch-proposal" });
    seedProposal(h.store, item);
    h.integration.issueBridgeNonces();
    const result = await h.integration.handleCommand(headlessCommand(h.store, item).replace(item.id, "another-proposal"));
    assert.equal(result.ok, false);
    assert.equal(h.calls.applies.length, 0);
  });
  await t.test("manual", async (t) => {
    const h = harness(t, { integrationOptions: { stateRoot: true } });
    const item = proposal(h.root, { id: "manual-headless" });
    seedProposal(h.store, item);
    h.integration.issueBridgeNonces();
    const result = await h.integration.handleCommand(headlessCommand(h.store, item));
    assert.equal(result.ok, false);
    assert.match(result.responseText, /manual-advisory-only/u);
    assert.equal(h.calls.applies.length, 0);
  });
});

test("legacy yolo narrows to explicit-review auto after rollout threshold", async (t) => {
  const h = harness(t);
  h.integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
  const result = await h.integration.runEvolutionCycle({ sessionID: "yolo", projectFingerprint: FINGERPRINT, scopeFingerprint: FINGERPRINT });
  assert.equal(result.result, "proposal-ready");
  assert.equal(h.calls.applies.length, 0);
});

test("unknown scopes and below-threshold yolo remain pending", async (t) => {
  await t.test("non-allowlisted", async (t) => {
    const h = harness(t, { allowlisted: false });
    h.integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: [path.join(h.root, "allowed-not-target")] });
    const result = await h.integration.runEvolutionCycle({ sessionID: "unknown", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "proposal-ready");
    assert.equal(h.calls.applies.length, 0);
  });
  await t.test("rollout threshold", async (t) => {
    const h = harness(t, { rolloutOutcomes: 5, rolloutMetrics: { synthesesObserved: 100, successRate: 1 } });
    h.integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
    const result = await h.integration.runEvolutionCycle({ sessionID: "threshold", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "proposal-ready");
    assert.equal(h.calls.applies.length, 0);
  });
  await t.test("auto is always pending before approval", async (t) => {
    const h = harness(t);
    h.integration.__testBridge.setMode("auto");
    const result = await h.integration.runEvolutionCycle({ sessionID: "auto", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "proposal-ready");
    assert.equal(h.calls.applies.length, 0);
  });
});

test("validated rollout outcomes never grant legacy yolo unattended write authority", async (t) => {
  const h = harness(t, {
    rolloutOutcomes: 0,
    rolloutMetrics: { synthesesObserved: 1_000, successRate: 1 },
    getRolloutMetrics: () => ({ synthesesObserved: 1_000, successRate: 1 }),
  });
  for (let index = 0; index < 20; index += 1) {
    const details = { action: index % 2 ? "synthesis-no-op" : "pipeline-synthesis-failure", subjectId: `legacy-${index}` };
    const event = makeAudit("decision", `legacy-${index}`, details, 1_000 + index);
    h.store.appendRecord(schemas.wrapRecord("audit-event", event, event.timestamp));
  }
  seedOutcome(h.store, 100, "accepted", 2_000, "f".repeat(64));
  const duplicate = seedOutcome(h.store, 0, "accepted", 2_001);
  assert.equal(duplicate.ok, true);
  assert.equal(seedOutcome(h.store, 0, "accepted", 2_001).duplicate, true);
  assert.equal(seedOutcome(h.store, 0, "accepted", 9_999).duplicate, true, "same outcome ID remains exactly once across callback timing changes");
  const malformedDetails = { action: "synthesis-outcome", outcomeId: "1".repeat(64), status: "accepted", success: true };
  const malformed = makeAudit("decision", "malformed-outcome", malformedDetails, 2_000);
  h.store.appendRecord(schemas.wrapRecord("audit-event", malformed, malformed.timestamp));
  for (let index = 1; index < 9; index += 1) seedOutcome(h.store, index, "accepted", 2_001 + index);

  h.integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
  assert.equal((await h.integration.runEvolutionCycle({ sessionID: "blocked", projectFingerprint: FINGERPRINT })).result, "proposal-ready");
  assert.equal(h.calls.applies.length, 0);

  seedOutcome(h.store, 9, "no-change", 2_020);
  assert.equal((await h.integration.runEvolutionCycle({ sessionID: "enabled", projectFingerprint: FINGERPRINT })).result, "proposal-ready");
  assert.equal(h.calls.applies.length, 0);
});

test("mode changes converge across integrations on the next event", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-shared-"));
  const store = openStore(root, { projectName: "shared", projectFingerprint: FINGERPRINT });
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const current = store.getSettings();
  store.setGlobalSettings(schemas.makeGlobalSettings({ ...current.global, consent: { passiveCalls: true, durableObservations: true }, updatedAt: Date.now() }));
  const calls = [];
  const schedulerModule = { createScheduler: ({ enqueueWork }) => ({ handleEvent: async (event) => { calls.push(event); await enqueueWork({ sessionID: event.properties.sessionID, projectFingerprint: FINGERPRINT, leaseNonce: "shared", epoch: 1, scheduledAt: Date.now() }); }, setMode() {}, getCircuitBreaker: () => ({ open: false }), recordWorkResult() {}, dispose() {} }) };
  const pipelineModule = { createPipeline: () => ({ runEvolutionCycle: async () => ({ result: "no-eligible" }), runApprovalFlow: async () => ({}), runRollbackFlow: async () => ({}) }) };
  const ctx = { directory: "/workspace/project", client: { session: { get: async ({ path }) => ({ data: supportedHostSession(path.id) }) } } };
  const deps = { store, inventory: {}, privacy: { exportScope: () => ({ records: [] }), purgeScope: () => ({ ok: true }), scanForForbiddenContent: () => ({ ok: true }) }, schemas, observation: observationModule, synthesisModule: {}, applier: { applyProposal: async () => ({ ok: false }), circuitBreakerOpen: () => false, recoverPending: () => [] }, commands: commandModule, pipeline: pipelineModule, scheduler: schedulerModule, options: { ctx } };
  const a = createIntegration(deps);
  const b = createIntegration(deps);
  assert.equal((await b.handleEvent({ type: "session.idle", properties: { sessionID: "before" } })).scheduled, false);
  a.__testBridge.setMode("auto");
  assert.equal((await b.handleEvent({ type: "session.idle", properties: { sessionID: "after" } })).scheduled, true);
  assert.equal(calls.length, 1);
});

test("pause, exclusion, circuit breaker, and kill switch override stored authority", async (t) => {
  await t.test("pause", async (t) => {
    const h = harness(t);
    h.integration.__testBridge.setMode("auto");
    const current = h.store.getSettings();
    h.store.setGlobalSettings(schemas.makeGlobalSettings({ ...current.global, paused: true, updatedAt: h.now() }));
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "paused" } })).scheduled, false);
  });
  await t.test("repo exclusion", async (t) => {
    const h = harness(t, { repoOptOut: true });
    h.integration.__testBridge.setMode("auto");
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "excluded" } })).scheduled, false);
  });
  await t.test("circuit breaker", async (t) => {
    const h = harness(t, { breakerOpen: true });
    h.integration.__testBridge.setMode("auto");
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "breaker" } })).scheduled, false);
  });
  await t.test("kill switch", async (t) => {
    const h = harness(t);
    h.integration.__testBridge.setMode("auto");
    const stopped = h.integration.triggerKillSwitch("test");
    assert.equal(stopped.auditEvent.details.reason, "test");
    const persistedStop = h.store.readRecords("audit-event").map((record) => record.payload).findLast((event) => event.kind === "kill-switch");
    assert.equal(persistedStop.details.reason, "test");
    assert.equal(h.integration.__testBridge.getMode().storedMode, "auto");
    assert.equal(h.integration.__testBridge.getMode().effectiveMode, "manual");
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "killed" } })).scheduled, false);
    h.integration.clearKillSwitch("test-clear");
    assert.equal(h.integration.__testBridge.getMode().effectiveMode, "auto");
  });
  await t.test("slash command clears an environment-sourced runtime kill switch", async (t) => {
    const prior = process.env.SELF_EVOLVE_KILL;
    process.env.SELF_EVOLVE_KILL = "true";
    t.after(() => {
      if (prior === undefined) delete process.env.SELF_EVOLVE_KILL;
      else process.env.SELF_EVOLVE_KILL = prior;
    });
    const h = harness(t);
    h.integration.__testBridge.setMode("auto");
    assert.equal(h.integration.__testBridge.getMode().effectiveMode, "manual");

    const cleared = await h.integration.handleCommand("/self-evolve kill-switch off");

    assert.equal(cleared.ok, true);
    assert.match(cleared.responseText, /Kill switch disabled/u);
    assert.equal(h.integration.__testBridge.getMode().effectiveMode, "auto");
    assert.equal(h.store.getSettings().global.killSwitchActive, false);
  });
});

test("in-flight downgrade cancels pending continuation and records downgrade", async (t) => {
  let resolve;
  const deferredCycle = { promise: new Promise((done) => { resolve = done; }) };
  const h = harness(t, { deferredCycle });
  h.integration.__testBridge.setMode("auto");
  const running = h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "in-flight" } });
  await new Promise((done) => setImmediate(done));
  assert.equal(h.integration.getInFlightWork().length, 1);
  h.integration.__testBridge.setMode("manual");
  assert.deepEqual(h.calls.cancelled, ["in-flight"]);
  assert.equal(h.calls.workResults.some((entry) => entry.result.downgrade === true), true);
  resolve({ result: "proposal-ready" });
  await running;
  assert.equal(h.calls.workResults.filter((entry) => entry.item.sessionID === "in-flight").length, 1);
});

test("shutdown aborts and drains admitted autonomous work before releasing resources", async (t) => {
  let resolve;
  let shutdownSettled = false;
  const deferredCycle = { promise: new Promise((done) => { resolve = done; }) };
  const h = harness(t, { deferredCycle });
  h.integration.__testBridge.setMode("auto");
  const running = h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "shutdown-drain" } });
  await new Promise((done) => setImmediate(done));
  assert.equal(h.integration.getInFlightWork().length, 1);

  const shutdown = h.integration.shutdown().then((result) => { shutdownSettled = true; return result; });
  await new Promise((done) => setImmediate(done));
  assert.equal(deferredCycle.signal?.aborted, true);
  assert.equal(shutdownSettled, false);
  assert.equal(h.calls.applierCloses, 0);
  assert.equal(h.calls.schedulerDisposals ?? 0, 0);

  resolve({ result: "failed-closed", cycleOutcome: "failed-closed", reason: "autonomous-work-cancelled" });
  await running;
  assert.equal((await shutdown).ok, true);
  assert.equal(h.calls.schedulerStopped, 1);
  assert.equal(h.calls.schedulerDisposals, 1);
  assert.equal(h.calls.applierCloses, 1);
  assert.equal(h.integration.getInFlightWork().length, 0);
});

test("shutdown timeout keeps resources fenced until background drain completes", async (t) => {
  let resolve;
  const deferredCycle = { promise: new Promise((done) => { resolve = done; }) };
  const h = harness(t, { deferredCycle, integrationOptions: { __testShutdownTimeoutMs: 5 } });
  h.integration.__testBridge.setMode("auto");
  const running = h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "shutdown-timeout" } });
  await new Promise((done) => setImmediate(done));

  const timed = await h.integration.shutdown();
  assert.equal(timed.ok, false);
  assert.equal(timed.reason, "autonomous-work-draining");
  assert.equal(typeof timed.completion?.then, "function");
  assert.equal(h.calls.applierCloses, 0);
  assert.equal(h.calls.schedulerDisposals ?? 0, 0);

  resolve({ result: "failed-closed", cycleOutcome: "failed-closed", reason: "autonomous-work-cancelled" });
  await running;
  assert.equal((await timed.completion).ok, true);
  assert.equal(h.calls.schedulerDisposals, 1);
  assert.equal(h.calls.applierCloses, 1);
});

test("an event awaiting ancestry cannot admit work after shutdown starts", async (t) => {
  let releaseLookup;
  const lookup = new Promise((resolve) => { releaseLookup = resolve; });
  const h = harness(t, {
    sessionGet: async ({ path }) => {
      await lookup;
      return { data: supportedHostSession(path.id) };
    },
  });
  h.integration.__testBridge.setMode("auto");
  const event = h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "ancestry-shutdown" } });
  await new Promise((done) => setImmediate(done));
  const shutdown = h.integration.shutdown();
  releaseLookup();

  assert.deepEqual(await event, { scheduled: false, reason: "integration-closing" });
  assert.equal((await shutdown).ok, true);
  assert.equal(h.calls.events.length, 0);
  assert.equal(h.calls.cycles.length, 0);
});

test("integration leaves normal fulfillment and rejection settlement to the scheduler", async (t) => {
  const fulfilled = harness(t);
  fulfilled.integration.__testBridge.setMode("auto");
  await fulfilled.integration.handleEvent({ type: "session.idle", properties: { sessionID: "scheduler-owned-success" } });
  assert.equal(fulfilled.calls.workResults.length, 0, "integration does not settle fulfilled scheduler work");

  const rejected = harness(t, { cycleError: "scheduler-owned-rejection" });
  rejected.integration.__testBridge.setMode("auto");
  await assert.rejects(
    rejected.integration.handleEvent({ type: "session.idle", properties: { sessionID: "scheduler-owned-failure" } }),
    /scheduler-owned-rejection/u,
  );
  assert.equal(rejected.calls.workResults.length, 0, "integration does not duplicate rejection settlement");
});

test("server-side TUI bridge works without a TUI process and rejects duplicate CAS", async (t) => {
  const h = harness(t);
  h.integration.__testBridge.setMode("auto");
  const item = proposal(h.root);
  seedProposal(h.store, item);
  const decision = exactDecision(item, "approved", h.now());
  const first = await h.integration.__testBridge.decide({ decision });
  const duplicate = await h.integration.__testBridge.decide({ decision });
  assert.equal(first.ok, true);
  assert.deepEqual(duplicate, { ok: false, reason: "stale-prior-state" });
});

test("structured rejection feedback is completion-audit-only and never becomes evidence", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    integrationOptions: {
      stateRoot: true,
      __testSetMailboxInterval: () => ({ unref() {} }),
      __testClearMailboxInterval: () => {},
    },
  });
  h.integration.__testBridge.setMode("auto");
  const item = proposal(h.root, { id: "feedback-rejection" });
  seedProposal(h.store, item, h.now());
  await h.integration.boot({ recoverHostSessions: false });
  const projected = readProjectInbox(h.root, FINGERPRINT, { now: h.now() })
    .find((entry) => entry.id === item.id);
  const request = createDecisionRequest({
    projectFingerprint: FINGERPRINT,
    proposal: projected,
    newState: "rejected",
    feedback: {
      reason: "other",
      text: "The recommendation duplicates a project-specific workflow.",
    },
    timestamp: h.now(),
    requestId: "feedback-rejection-request",
  });
  submitDecisionRequest(h.root, request);
  assert.equal((await h.integration.processMailbox()).ok, true);
  assert.equal(pollDecisionResponse(h.root, FINGERPRINT, request.requestId).ok, true);
  const completion = h.store.readRecords("audit-event").findLast((record) =>
    record.payload.proposalId === item.id
    && record.payload.details?.action === "bridge-request-complete");
  assert.equal(completion.payload.details.rejectionFeedbackReason, "other");
  assert.equal(
    completion.payload.details.rejectionFeedbackText,
    "The recommendation duplicates a project-specific workflow.",
  );
  assert.doesNotMatch(
    JSON.stringify(h.store.readRecords("observation")),
    /duplicates a project-specific workflow/u,
  );
  await h.integration.shutdown();
});

test("a committed decision outcome is republished after response publication fails", async (t) => {
  let failPublication = false;
  const h = harness(t, {
    initialClock: Date.now(),
    integrationOptions: {
      stateRoot: true,
      __testSetMailboxInterval: () => ({ unref() {} }),
      __testClearMailboxInterval: () => {},
      __testAfterRequestHandled() {
        if (!failPublication) return;
        failPublication = false;
        throw new Error("injected-response-publication-failure");
      },
    },
  });
  h.integration.__testBridge.setMode("auto");
  const item = proposal(h.root, { id: "decision-publication-retry" });
  seedProposal(h.store, item, h.now());
  await h.integration.boot({ recoverHostSessions: false });
  const projected = readProjectInbox(h.root, FINGERPRINT, { now: h.now() }).find((entry) => entry.id === item.id);
  assert.ok(projected?.decisionNonce);
  const request = createDecisionRequest({
    projectFingerprint: FINGERPRINT,
    proposal: projected,
    newState: "rejected",
    timestamp: h.now(),
    requestId: "decision-publication-retry",
  });

  failPublication = true;
  submitDecisionRequest(h.root, request);
  const failedPublication = await h.integration.processMailbox();
  assert.equal(failedPublication.ok, false);
  assert.equal(failedPublication.reason, "injected-response-publication-failure");
  assert.equal(pollDecisionResponse(h.root, FINGERPRINT, request.requestId), null);
  assert.equal(latestProposal(h.store, item.id).state, "rejected");

  const completionEvents = () => h.store.readRecords("audit-event").filter((record) =>
    record.payload.proposalId === item.id
    && record.payload.details?.action === "bridge-request-complete"
    && record.payload.details?.requestId === request.requestId);
  const decisionTransitions = () => h.store.readRecords("decision").filter((record) =>
    record.payload.proposalId === item.id && record.payload.newState === "rejected");
  assert.equal(completionEvents().length, 1);
  assert.match(completionEvents()[0].payload.details.requestDigest, /^[a-f0-9]{64}$/u);
  assert.equal(decisionTransitions().length, 1);

  const retried = await h.integration.processMailbox();
  assert.equal(retried.ok, true);
  const response = pollDecisionResponse(h.root, FINGERPRINT, request.requestId);
  assert.equal(response.ok, true);
  assert.equal(response.recovered, true);
  assert.equal(completionEvents().length, 1);
  assert.equal(decisionTransitions().length, 1);

  const responsePath = path.join(h.root, "self-evolve", "bridge", FINGERPRINT, "responses", `${request.requestId}.json`);
  unlinkSync(responsePath);
  const altered = makeBridgeRequest({ ...request, newState: "pending" }, { now: h.now(), projectFingerprint: FINGERPRINT });
  submitDecisionRequest(h.root, altered);
  await h.integration.processMailbox();
  assert.deepEqual(
    { ok: pollDecisionResponse(h.root, FINGERPRINT, request.requestId).ok, reason: pollDecisionResponse(h.root, FINGERPRINT, request.requestId).reason },
    { ok: false, reason: "replayed-request" },
  );

  const differentId = makeBridgeRequest({ ...request, requestId: "decision-publication-new-id" }, { now: h.now(), projectFingerprint: FINGERPRINT });
  submitDecisionRequest(h.root, differentId);
  await h.integration.processMailbox();
  assert.deepEqual(
    { ok: pollDecisionResponse(h.root, FINGERPRINT, differentId.requestId).ok, reason: pollDecisionResponse(h.root, FINGERPRINT, differentId.requestId).reason },
    { ok: false, reason: "replayed-decision" },
  );
  assert.equal(completionEvents().length, 1);
  assert.equal(decisionTransitions().length, 1);
  await h.integration.shutdown();
});

test("a committed control outcome is republished without repeating its settings mutation", async (t) => {
  let failPublication = false;
  const h = harness(t, {
    initialClock: Date.now(),
    integrationOptions: {
      stateRoot: true,
      __testSetMailboxInterval: () => ({ unref() {} }),
      __testClearMailboxInterval: () => {},
      __testAfterRequestHandled() {
        if (!failPublication) return;
        failPublication = false;
        throw new Error("injected-control-publication-failure");
      },
    },
  });
  await h.integration.boot({ recoverHostSessions: false });
  const controlState = readControlState(h.root, FINGERPRINT, { now: h.now() });
  const request = createControlRequest({
    controlState,
    action: "set-consent",
    payload: { key: "sanitizedExcerpts", enabled: true },
    timestamp: h.now(),
    requestId: "control-publication-retry",
  });

  failPublication = true;
  submitControlRequest(h.root, request);
  const failedPublication = await h.integration.processMailbox();
  assert.equal(failedPublication.ok, false);
  assert.equal(failedPublication.reason, "injected-control-publication-failure");
  assert.equal(pollControlResponse(h.root, FINGERPRINT, request.requestId), null);
  const committedVersion = h.store.getSettings().global.updatedAt;
  assert.equal(h.store.getSettings().global.consent.sanitizedExcerpts, true);

  const completionEvents = () => h.store.readRecords("audit-event").filter((record) =>
    record.payload.details?.action === "control-request-complete"
    && record.payload.details?.requestId === request.requestId);
  assert.equal(completionEvents().length, 1);
  assert.match(completionEvents()[0].payload.details.requestDigest, /^[a-f0-9]{64}$/u);

  const retried = await h.integration.processMailbox();
  assert.equal(retried.ok, true);
  const response = pollControlResponse(h.root, FINGERPRINT, request.requestId);
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response).sort(), ["ok", "processedAt", "projectFingerprint", "reason", "requestId", "schemaVersion", "status"].sort());
  assert.equal(h.store.getSettings().global.updatedAt, committedVersion);
  assert.equal(completionEvents().length, 1);

  const responsePath = path.join(h.root, "self-evolve", "bridge", FINGERPRINT, "control-responses", `${request.requestId}.json`);
  unlinkSync(responsePath);
  const altered = makeControlRequest(
    { ...request, payload: { key: "sanitizedExcerpts", enabled: false } },
    { now: h.now(), projectFingerprint: FINGERPRINT },
  );
  submitControlRequest(h.root, altered);
  await h.integration.processMailbox();
  assert.deepEqual(
    { ok: pollControlResponse(h.root, FINGERPRINT, request.requestId).ok, reason: pollControlResponse(h.root, FINGERPRINT, request.requestId).reason },
    { ok: false, reason: "replayed-request" },
  );

  const differentId = makeControlRequest(
    { ...request, requestId: "control-publication-new-id" },
    { now: h.now(), projectFingerprint: FINGERPRINT },
  );
  submitControlRequest(h.root, differentId);
  await h.integration.processMailbox();
  assert.deepEqual(
    { ok: pollControlResponse(h.root, FINGERPRINT, differentId.requestId).ok, reason: pollControlResponse(h.root, FINGERPRINT, differentId.requestId).reason },
    { ok: false, reason: "replayed-control" },
  );
  assert.equal(h.store.getSettings().global.updatedAt, committedVersion);
  assert.equal(h.store.getSettings().global.consent.sanitizedExcerpts, true);
  assert.equal(completionEvents().length, 1);
  await h.integration.shutdown();
});

test("apply and rollback each produce audited state and rollback CAS", async (t) => {
  const h = harness(t);
  h.integration.__testBridge.setMode("auto");
  const item = proposal(h.root);
  seedProposal(h.store, item);
  const applied = await h.integration.__testBridge.decide({ decision: exactDecision(item, "approved", h.now()) });
  assert.equal(applied.ok, true);
  const appliedProposal = latestProposal(h.store, item.id);
  const rolledBack = await h.integration.__testBridge.decide({ decision: exactDecision(appliedProposal, "rolled-back", h.now()) });
  assert.equal(rolledBack.ok, true);
  assert.equal(latestProposal(h.store, item.id).state, "rolled-back");
  const auditKinds = h.store.readRecords("audit-event").map((record) => record.payload.kind);
  assert.equal(auditKinds.includes("apply"), true);
  assert.equal(auditKinds.includes("rollback"), true);
});

test("internal rollout gates remain hidden and gate shadow and application behavior", async (t) => {
  assert.deepEqual(Object.keys(ROLLOUT_GATES).sort(), ["autoReviewRollout", "automaticSynthesisApplicationDisabled", "offlineCorpus", "passiveShadowObservation", "yoloEnablementThreshold"].sort());
  assert.deepEqual(schemas.Mode.values, ["manual", "auto"]);
  await t.test("passive shadow stops before synthesis", async (t) => {
    const h = harness(t, { rolloutGates: { passiveShadowObservation: true } });
    h.integration.__testBridge.setMode("auto");
    const result = await h.integration.runEvolutionCycle({ sessionID: "shadow", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "observed-shadow");
    assert.equal(h.calls.cycles[0].options.stopAfter, "correlate");
  });
  await t.test("application-disabled forces pending review", async (t) => {
    const h = harness(t, { rolloutGates: { automaticSynthesisApplicationDisabled: true } });
    h.integration.__testBridge.setMode("auto");
    const result = await h.integration.runEvolutionCycle({ sessionID: "disabled", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "proposal-ready");
    assert.equal(h.calls.cycles[0].mode, "manual");
    assert.equal(h.calls.applies.length, 0);
  });
});

test("TUI inbox and proposal bridge filter partitions and sanitize previews", async (t) => {
  const h = harness(t);
  const item = proposal(h.root);
  seedProposal(h.store, item);
  const inbox = h.integration.__testBridge.getInbox({ projectFingerprint: FINGERPRINT });
  assert.equal(inbox.length, 1);
  assert.equal("proposedContent" in inbox[0], false);
  const detail = h.integration.__testBridge.getProposal({ proposalId: item.id, projectFingerprint: FINGERPRINT });
  assert.equal(detail.proposal.id, item.id);
  assert.equal(typeof detail.diffPreview, "string");
  assert.equal(h.integration.__testBridge.getProposal({ proposalId: item.id, projectFingerprint: "f".repeat(64) }), null);
});

test("boot runs recovery, records health, and corrupt settings fail closed", async (t) => {
  await t.test("recovery", async (t) => {
    const recovery = [{ ok: true, proposalId: "proposal-1" }];
    const h = harness(t, { recovery });
    const report = await h.integration.boot({ ctx: h.ctx, hostVersion: "1.18.3" });
    assert.equal(report.ok, true);
    assert.deepEqual(report.recovered, recovery);
    assert.equal(h.calls.recoveries, 1);
    assert.equal(h.store.readRecords("audit-event").some((record) => record.payload.details.action === "boot"), true);
  });
  await t.test("corrupt settings", async (t) => {
    const h = harness(t);
    writeFileSync(path.join(h.store.stateDir, "settings.json"), "{not-json", "utf8");
    const report = await h.integration.boot({ hostVersion: "1.18.3" });
    assert.equal(report.mode, "manual");
    assert.match(report.health.lastError, /corrupt-settings/u);
  });
});

test("boot completes verified approved state without reapplying and recovery is idempotent", async (t) => {
  const h = harness(t);
  h.integration.__testBridge.setMode("auto");
  const item = proposal(h.root, { id: "verified-before-final-transition" });
  seedProposal(h.store, item);
  assert.equal(h.store.commitDecision(exactDecision(item, "approved", h.now())).ok, true);
  const audit = makeAudit("apply", item.id, { state: "readback-verified", appliedHash: item.proposedContentHash, "readback-verified": true }, h.now());
  h.store.appendRecord(schemas.wrapRecord("audit-event", audit, audit.timestamp));
  const first = await h.integration.boot({ ctx: h.ctx, hostVersion: "1.18.3", recoverHostSessions: false });
  assert.equal(first.ok, true);
  assert.equal(latestProposal(h.store, item.id).state, "applied");
  assert.equal(h.calls.applies.length, 0);
  const second = await h.integration.boot({ ctx: h.ctx, hostVersion: "1.18.3", recoverHostSessions: false });
  assert.equal(second.ok, true);
  assert.equal(h.calls.applies.length, 0);
  assert.equal(h.store.readRecords("decision").filter((record) => record.payload.proposalId === item.id && record.payload.newState === "applied").length, 1);
});

test("boot resumes approval once or converts an unverified apply to failed-closed", async (t) => {
  await t.test("approved before apply", async (t) => {
    const h = harness(t);
    h.integration.__testBridge.setMode("auto");
    const item = proposal(h.root, { id: "approved-before-apply" });
    seedProposal(h.store, item);
    assert.equal(h.store.commitDecision(exactDecision(item, "approved", h.now())).ok, true);
    const first = await h.integration.boot({ ctx: h.ctx, recoverHostSessions: false });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(latestProposal(h.store, item.id).state, "applied");
    assert.equal(h.calls.applies.length, 1);
    await h.integration.boot({ ctx: h.ctx, recoverHostSessions: false });
    assert.equal(h.calls.applies.length, 1);
  });
  await t.test("unverified apply", async (t) => {
    const h = harness(t, { recovery: [{ ok: false, proposalId: "unverified-apply", reason: "apply-not-published" }] });
    h.integration.__testBridge.setMode("auto");
    const item = proposal(h.root, { id: "unverified-apply" });
    seedProposal(h.store, item);
    assert.equal(h.store.commitDecision(exactDecision(item, "approved", h.now())).ok, true);
    const report = await h.integration.boot({ ctx: h.ctx, recoverHostSessions: false });
    assert.equal(report.ok, true);
    assert.equal(latestProposal(h.store, item.id).state, "failed-closed");
    assert.equal(h.calls.applies.length, 0);
    assert.equal(h.integration.__testBridge.getInbox().find((entry) => entry.id === item.id).state, "failed-closed");
  });
});

test("boot synthesis recovery runs before retention and one unrefed daily timer repeats until shutdown", async (t) => {
  const day = 86_400_000;
  let callback;
  let delay;
  let unrefed = false;
  let cleared = false;
  const recoveryOrder = [];
  const timer = { unref() { unrefed = true; } };
  const h = harness(t, {
    initialClock: 40 * day,
    recoveryOrder,
    integrationOptions: {
      __testSetInterval(fn, milliseconds) { callback = fn; delay = milliseconds; return timer; },
      __testClearInterval(value) { assert.equal(value, timer); cleared = true; },
      __testRunStoreRetention(timestamp) { recoveryOrder.push("retention"); return h.store.retain(timestamp); },
    },
  });
  const old = schemas.makeObservation({
    id: "1".repeat(64), projectFingerprint: FINGERPRINT, receiptIds: ["2".repeat(64)],
    structuredFields: { receiptType: "repeated-command", scopeFingerprint: FINGERPRINT, occurrences: 1 },
    incidentId: "startup-old", createdAt: day, injectionFlagged: false, redacted: true,
  });
  h.store.appendRecord(schemas.wrapRecord("observation", old, day));
  const report = await h.integration.boot({ ctx: h.ctx, hostVersion: "1.18.3" });
  assert.equal(report.ok, true);
  assert.equal(h.store.readRecords("observation").length, 0);
  assert.equal(h.calls.recoveries, 1);
  assert.equal(h.calls.synthesisRecoveries, 1);
  assert.equal(h.calls.contributionRecoveries, 1);
  assert.deepEqual(recoveryOrder.slice(0, 3), ["contribution-recovery", "synthesis-recovery", "retention"]);
  assert.equal(delay, day);
  assert.equal(unrefed, true);
  assert.deepEqual(h.integration.getRetentionState(), { scheduled: true, inFlight: false });

  const dailyOld = schemas.makeObservation({ ...old, id: "3".repeat(64), incidentId: "daily-old" });
  h.store.appendRecord(schemas.wrapRecord("observation", dailyOld, day));
  callback();
  await h.integration.runRetentionSweep();
  assert.equal(h.store.readRecords("observation").length, 0);
  await h.integration.shutdown();
  assert.equal(cleared, true);
  assert.deepEqual(h.integration.getRetentionState(), { scheduled: false, inFlight: false });
});

test("shutdown cancels retention scheduling and awaits an in-flight sweep before store close", async (t) => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  let cleared = false;
  let sweeps = 0;
  const timer = { unref() {} };
  const h = harness(t, {
    integrationOptions: {
      __testSetInterval() { return timer; },
      __testClearInterval() { cleared = true; },
      __testRunStoreRetention: () => (++sweeps === 1 ? { observations: 0 } : deferred),
    },
  });
  await h.integration.boot({ ctx: h.ctx, hostVersion: "1.18.3" });
  void h.integration.runRetentionSweep();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.integration.getRetentionState().inFlight, true);
  let settled = false;
  const stopping = h.integration.shutdown().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release({ observations: 0 });
  await stopping;
  assert.equal(cleared, true);
  assert.deepEqual(h.integration.getRetentionState(), { scheduled: false, inFlight: false });
});

test("shutdown remains closed while retrying a degraded applier lease release", async (t) => {
  const h = harness(t, {
    applierClose(attempt) {
      return attempt === 1
        ? { ok: false, unreleased: [{ key: "apply_retry", reason: "lease-release-error" }] }
        : { ok: true, unreleased: [] };
    },
  });
  await h.integration.boot({ ctx: h.ctx, hostVersion: "1.18.3" });
  const first = await h.integration.shutdown();
  assert.equal(first.ok, false);
  assert.equal(first.reason, "applier-close-degraded");
  assert.deepEqual(await h.integration.handleCommand({ command: "self-evolve", arguments: "status", sessionID: "closed" }), {
    ok: false,
    reason: "integration-closed",
  });
  assert.deepEqual(await h.integration.shutdown(), { ok: true });
  assert.equal(h.calls.applierCloses, 2);
});

test("headless purge-all rejects missing and wrong durable confirmation without stopping authority", async (t) => {
  const h = harness(t);
  for (const command of [
    "purge --all",
    "purge all",
    "purge --all --confirm PURGE ALL SELF-EVOLVE 0.2.0",
  ]) {
    const result = await h.integration.handleCommand({ command, projectFingerprint: FINGERPRINT });
    assert.equal(result.ok, false, command);
    assert.match(result.responseText, /Usage:.*PURGE ALL SELF-EVOLVE 0\.3\.0/u);
  }
  assert.equal(existsSync(path.join(h.root, "self-evolve")), true);
  assert.match((await h.integration.handleCommand("status")).responseText, /Self-evolve status/u);
});

test("purge all is terminal through timer ticks, later events and commands, and shutdown", async (t) => {
  let retentionCallback;
  let terminalPurgeCallback;
  let responseAssignedWhenScheduled = false;
  let timerCleared = false;
  let resolveCycle;
  const deferredCycle = { promise: new Promise((resolve) => { resolveCycle = resolve; }) };
  const timer = { unref() {} };
  const h = harness(t, {
    deferredCycle,
    privacy: (store) => ({
      exportScope: () => store.exportProject(),
      exportAll: () => store.exportAll(),
      purgeScope: ({ scope }) => store.purge({ scope }),
      scanForForbiddenContent: () => ({ ok: true, issues: [] }),
    }),
    integrationOptions: {
      __testSetInterval(callback) { retentionCallback = callback; return timer; },
      __testClearInterval(value) { if (value === timer) timerCleared = true; },
      __testRetentionIntervalMs: 5,
      __testSetTerminalPurgeTimeout(callback) {
        responseAssignedWhenScheduled = /accepted-terminal/u.test(commandOutput.responseText ?? "");
        terminalPurgeCallback = callback;
        return timer;
      },
    },
  });
  await h.integration.boot({ ctx: h.ctx, hostVersion: "1.18.3", recoverHostSessions: false });
  const subtree = path.join(h.root, "self-evolve");
  const secondStore = openStore(h.root, { projectFingerprint: "b".repeat(64), now: h.now });
  assert.equal(existsSync(subtree), true);
  h.integration.__testBridge.setMode("auto");
  const running = h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "headless-purge-drain" } });
  await new Promise((resolve) => setImmediate(resolve));
  const commandOutput = {};
  const purged = await h.integration.handleCommand({
    command: "purge --all --confirm PURGE ALL SELF-EVOLVE 0.3.0",
    projectFingerprint: FINGERPRINT,
  }, commandOutput);
  assert.equal(deferredCycle.signal.aborted, true);
  assert.equal(purged.status, "accepted-terminal");
  assert.equal(purged.terminalPurge, true);
  assert.match(commandOutput.responseText, /accepted-terminal/u);
  assert.equal(responseAssignedWhenScheduled, true);
  assert.equal(typeof terminalPurgeCallback, "function");
  assert.equal(existsSync(subtree), true);
  assert.equal(h.store.readRecords("audit-event").some((record) =>
    record.payload.details?.action === "headless-purge-all-accepted"
      && record.payload.details?.status === "accepted-terminal"
      && record.payload.details?.terminal === true), true);
  assert.equal(h.calls.schedulerDisposals ?? 0, 0);
  assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "after-acceptance" } }), { scheduled: false, reason: "restart-required-after-purge-all" });
  assert.match((await h.integration.handleCommand({ command: "status" })).responseText, /Restart OpenCode/u);
  resolveCycle({ result: "failed-closed", cycleOutcome: "failed-closed", reason: "autonomous-work-cancelled" });
  await running;
  assert.equal(timerCleared, true);
  assert.equal(existsSync(subtree), true);
  terminalPurgeCallback();
  await h.integration.shutdown();
  assert.equal(existsSync(subtree), false);

  retentionCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(subtree), false);
  assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "after-purge" } }), { scheduled: false, reason: "integration-closing" });
  assert.equal((await h.integration.handleCommand({ command: "status" })).reason, "integration-closed");
  assert.throws(() => secondStore.getSettings(), /restart-required-after-purge-all/u);
  secondStore.close();
  assert.equal(existsSync(subtree), false);
});

test("mode changes publish a TUI event and consent revocation deletes local capsules", (t) => {
  const h = harness(t);
  const mode = h.integration.__testBridge.setMode("auto");
  assert.equal(mode.ok, true);
  assert.equal(h.calls.published.some((event) => event.type === "self-evolve.settings"), true);
  const consent = h.integration.__testBridge.setConsent("sanitizedExcerpts", true);
  assert.equal(consent.ok, true);
  assert.equal(h.integration.__testBridge.getConsent().sanitizedExcerpts, true);
  const createdAt = h.now();
  assert.equal(h.store.appendEvidenceCapsule(schemas.makeEvidenceCapsule({
    capsuleId: "11111111-1111-4111-8111-111111111111",
    incidentId: "integration-consent-capsule",
    receiptType: "repeated-command",
    targetLogicalName: null,
    summary: "Command verify recurred 2 times and required repeated handling.",
    createdAt,
    expiresAt: createdAt + 30 * 86_400_000,
  })).ok, true);
  assert.equal(existsSync(path.join(h.store.stateDir, "evidence-capsules.jsonl")), true);

  const revoked = h.integration.__testBridge.setConsent("sanitizedExcerpts", false);
  assert.equal(revoked.ok, true);
  assert.equal(h.integration.__testBridge.getConsent().sanitizedExcerpts, false);
  assert.deepEqual(h.store.readEvidenceCapsules({ includeExpired: true }), []);
  assert.equal(existsSync(path.join(h.store.stateDir, "evidence-capsules.jsonl")), false);
});

test("a synchronous TUI publish failure does not reject the settings mutation", async (t) => {
  const h = harness(t);
  h.ctx.client.tui.publish = () => { throw new Error("tui-unavailable"); };
  const result = h.integration.__testBridge.setMode("auto");
  assert.equal(result.ok, true, "the mode change succeeds even when TUI publish throws synchronously");
  await h.integration.shutdown();
});

test("host session recovery is bounded, selective, and idempotent", async (t) => {
  const h = harness(t);
  let lists = 0;
  const aborted = [];
  const deleted = [];
  h.ctx.directory = h.root;
  h.ctx.client.session = {
    list: async () => {
      lists += 1;
      return { data: [
        { id: "active", agent: "self-evolve-analyzer", state: "running" },
        { id: "terminal", agent: "self-evolve-critic", state: "completed" },
        { id: "other", agent: "build", state: "running" },
      ] };
    },
    abort: async (args) => { aborted.push(args?.path?.id ?? args?.path?.sessionID ?? args?.sessionID); return { data: {} }; },
    delete: async (args) => { deleted.push(args?.path?.id); return { data: {} }; },
  };
  // Recovery mutates only sessions with a provably dead self-evolve owner record
  // matching this project/root. Unknown same-name and foreign sessions stay untouched.
  assert.equal(seedDeadHostOwner(h.root, "active", "self-evolve-analyzer").ok, true);
  assert.equal(seedDeadHostOwner(h.root, "terminal", "self-evolve-critic").ok, true);
  const [first, concurrent] = await Promise.all([
    h.integration.recoverHostSessions({ timeoutMs: 20, retries: 1, backoffMs: 1 }),
    h.integration.recoverHostSessions({ timeoutMs: 20, retries: 1, backoffMs: 1 }),
  ]);
  const repeated = await h.integration.recoverHostSessions();
  assert.deepEqual(concurrent, first);
  assert.deepEqual(repeated, first);
  assert.equal(lists, 1);
  assert.deepEqual(aborted, ["active"]);
  assert.deepEqual(deleted, ["active", "terminal"]);
  assert.deepEqual(h.integration.__testBridge.getHealth().hostSessionRecovery, { ok: true, cancelled: false, attempts: 1, aborted: 2, failed: 0 });
  await h.integration.shutdown();
});

test("failed orphan deletion retains its owner for one successful recovery retry", async () => {
  const sessionId = "retry-hidden-session";
  const ownerNonce = "ab".repeat(24);
  let owner = ownerNonce;
  let deletions = 0;
  const leases = new Map();
  const store = {
    hostOwnerStatus(id) {
      return id === sessionId && owner
        ? { classification: "abortable", nonce: owner, reason: "host-owner-process-dead" }
        : { classification: "unknown", reason: "host-owner-not-found" };
    },
    acquireLease(key) {
      if (leases.has(key)) return { ok: false, reason: "lease-busy" };
      const nonce = `claim-${leases.size}`;
      leases.set(key, nonce);
      return { ok: true, nonce };
    },
    releaseLease(key, nonce) {
      if (leases.get(key) !== nonce) return { ok: false, reason: "nonce-mismatch" };
      leases.delete(key);
      return { ok: true };
    },
    releaseHostOwner(id, nonce) {
      if (id !== sessionId || owner !== nonce) return { ok: false, reason: "nonce-mismatch" };
      owner = null;
      return { ok: true };
    },
  };
  const client = { session: {
    list: async () => ({ data: [{ id: sessionId, agent: "self-evolve-synthesizer", state: "running" }] }),
    abort: async () => ({ data: {} }),
    delete: async () => {
      deletions += 1;
      if (deletions === 1) throw new Error("fail-once");
      return { data: {} };
    },
  } };
  const recovery = { store, projectFingerprint: FINGERPRINT, rootIdentity: "d".repeat(64), now: 100 };

  const failed = await recoverOrphanedAnalyzerSessions(client, "/workspace", recovery);
  assert.equal(failed[0].action, "delete-failed");
  assert.equal(store.hostOwnerStatus(sessionId).nonce, ownerNonce);

  const succeeded = await recoverOrphanedAnalyzerSessions(client, "/workspace", recovery);
  assert.equal(succeeded[0].action, "deleted");
  assert.equal(store.hostOwnerStatus(sessionId).classification, "unknown");
  assert.equal(deletions, 2);
});

test("concurrent orphan recovery claims one abort and never claims live or foreign owners", async () => {
  const ownerNonce = "cd".repeat(24);
  let owner = ownerNonce;
  let claimNonce;
  let aborts = 0;
  let deletions = 0;
  let startAbort;
  let finishAbort;
  const abortStarted = new Promise((resolve) => { startAbort = resolve; });
  const abortFinished = new Promise((resolve) => { finishAbort = resolve; });
  const store = {
    hostOwnerStatus(id) {
      if (id === "dead" && owner) return { classification: "abortable", nonce: owner, reason: "host-owner-process-dead" };
      if (id === "live") return { classification: "live-owner", reason: "host-owner-process-live" };
      return { classification: "foreign", reason: "host-owner-scope-mismatch" };
    },
    acquireLease() {
      if (claimNonce) return { ok: false, reason: "lease-busy" };
      claimNonce = "recovery-claim";
      return { ok: true, nonce: claimNonce };
    },
    releaseLease(_key, nonce) {
      if (nonce !== claimNonce) return { ok: false, reason: "nonce-mismatch" };
      claimNonce = null;
      return { ok: true };
    },
    releaseHostOwner(id, nonce) {
      if (id !== "dead" || nonce !== owner) return { ok: false, reason: "nonce-mismatch" };
      owner = null;
      return { ok: true };
    },
  };
  const client = { session: {
    list: async () => ({ data: [
      { id: "dead", agent: "self-evolve-synthesizer", state: "running" },
      { id: "live", agent: "self-evolve-critic", state: "running" },
      { id: "foreign", agent: "self-evolve-analyzer", state: "running" },
    ] }),
    abort: async () => {
      aborts += 1;
      startAbort();
      await abortFinished;
      return { data: {} };
    },
    delete: async () => { deletions += 1; return { data: {} }; },
  } };
  const recovery = { store, projectFingerprint: FINGERPRINT, rootIdentity: "d".repeat(64), now: 100 };

  const first = recoverOrphanedAnalyzerSessions(client, "/workspace", recovery);
  await abortStarted;
  const second = await recoverOrphanedAnalyzerSessions(client, "/workspace", recovery);
  finishAbort();
  const completed = await first;

  assert.equal(aborts, 1);
  assert.equal(deletions, 1);
  assert.equal(completed.find((item) => item.id === "dead").action, "deleted");
  assert.equal(second.find((item) => item.id === "dead").action, "deferred");
  assert.equal(completed.find((item) => item.id === "live").action, "deferred");
  assert.equal(completed.find((item) => item.id === "foreign").action, "foreign");
  assert.equal(owner, null);
});

test("integration shutdown preserves a hidden-session owner whose cleanup is still pending", async (t) => {
  const sessionId = "cleanup-pending-at-shutdown";
  let acquired;
  const h = harness(t, {
    releaseOwnedHostOwners(store) {
      store.releaseHostOwner(sessionId, acquired.nonce);
      return { ok: true, released: 1 };
    },
  });
  acquired = h.store.acquireHostOwner(sessionId, {
    agent: "self-evolve-synthesizer",
    projectFingerprint: FINGERPRINT,
    rootIdentity: h.store.rootIdentity,
    generation: 0,
  });
  assert.equal(acquired.ok, true);
  assert.equal(h.store.retainHostOwner(sessionId, acquired.nonce).ok, true);

  await h.integration.shutdown();

  const reopened = openStore(h.root, { projectName: "fixture", projectFingerprint: FINGERPRINT, now: h.now });
  try {
    const status = reopened.hostOwnerStatus(sessionId, {
      projectFingerprint: FINGERPRINT,
      rootIdentity: reopened.rootIdentity,
      now: h.now(),
    });
    assert.equal(status.classification, "live-owner");
    assert.equal(status.owner.nonce, acquired.nonce);
  } finally {
    reopened.close();
  }
});

test("shutdown cancels and awaits unavailable-client host recovery", async (t) => {
  const h = harness(t);
  let lists = 0;
  h.ctx.client.session = { list: async () => { lists += 1; return await new Promise(() => {}); } };
  const recovery = h.integration.recoverHostSessions({ timeoutMs: 5_000, retries: 2, backoffMs: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  await h.integration.shutdown();
  const report = await recovery;
  assert.equal(report.cancelled, true);
  assert.equal(lists, 1);
});
