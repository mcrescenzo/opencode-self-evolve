import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { createIntegration, ROLLOUT_GATES } from "../self-evolve-integration.js";
import {
  createControlRequest,
  createDecisionRequest,
  createUiOperationRequest,
  makeBridgeRequest,
  makeControlRequest,
  pollControlResponse,
  pollDecisionResponse,
  pollUiOperationResponse,
  readControlState,
  readProjectInbox,
  readUiProjection,
  submitControlRequest,
  submitDecisionRequest,
  submitUiOperationRequest,
} from "../self-evolve-bridge.js";
import * as inventoryModule from "../self-evolve-inventory.js";
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
  store.close();
  return seeded;
}
import * as schemas from "../self-evolve-schemas.js";
import * as commandModule from "../self-evolve-commands.js";
import {
  UI_CAPABILITIES,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
} from "../self-evolve-ui-protocol.js";

const FINGERPRINT = "a".repeat(64);
const CURRENT_HASH = "b".repeat(64);
const PROPOSED_HASH = "c".repeat(64);

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
    synthesisRecoveries: 0,
    published: [],
    settingsReads: 0,
    recordReads: 0,
    recordWrites: 0,
    applierCloses: 0,
  };
  const integrationStore = config.instrumentStore
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
          if (config.deferredCycle) return config.deferredCycle.promise;
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
        dispose() {},
      };
    },
  };

  const ctx = { client: { tui: { publish(value) { calls.published.push(value); } } } };
  const integration = createIntegration({
    store: integrationStore,
    inventory: config.inventory ?? {},
    privacy,
    schemas,
    observation: {},
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
  t.after(() => { try { store.close(); } catch {} });
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

function headlessCommand(store, item, overrides = {}) {
  const grant = store.readRecords("audit-event").map((record) => record.payload).findLast((event) =>
    event.proposalId === item.id && event.details?.action === "headless-approval-nonce").details;
  return `/self-evolve approve ${item.id} --target-hash ${overrides.targetHash ?? grant.targetHash} --proposed-content-hash ${overrides.proposedContentHash ?? grant.proposedContentHash} --decision-version ${overrides.decisionVersion ?? grant.decisionVersion} --nonce ${overrides.nonce ?? grant.nonce}`;
}

test("all three modes preserve identical evidence and proposal thresholds", async (t) => {
  for (const mode of schemas.Mode.values) {
    await t.test(mode, async (t) => {
      const h = harness(t, { rolloutMetrics: { synthesesObserved: 0, successRate: 0 } });
      const set = h.integration.__testBridge.setMode(mode, mode === "yolo" ? { confirmed: true, allowlist: [h.root] } : {});
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
  const h = harness(t);
  const before = h.store.exportAll().records.length;
  const result = await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "manual-session" } });
  assert.deepEqual(result, { scheduled: false, reason: "manual-mode" });
  assert.equal(h.calls.events.length, 0);
  assert.equal(h.store.exportAll().records.length, before);
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

test("admitted event bursts reuse a bounded routing settings snapshot", async (t) => {
  const h = harness(t, {
    instrumentStore: true,
    enqueueOnEvent: false,
    integrationOptions: { __testRoutingSettingsTtlMs: 250 },
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
  assert.equal(h.calls.settingsReads - baseline, 1);

  const current = h.store.getSettings();
  h.store.setGlobalSettings(schemas.makeGlobalSettings({
    ...current.global,
    mode: "manual",
    updatedAt: current.global.updatedAt + 1,
  }));
  assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "cached" } })).scheduled, true);
  for (let index = 0; index < 251; index += 1) h.now();
  assert.deepEqual(
    await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "refreshed" } }),
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
  assert.equal(projected.dashboard.automation.state, "on-demand");
  assert.equal(projected.dashboard.usage.storage.usedBytes > 0, true);
  assert.equal(projected.dashboardError, null);
});

test("repository mode control is capability-advertised, exact, version-bound, replay-safe, and yolo-gated", async (t) => {
  const h = harness(t, {
    initialClock: Date.now(),
    inventory: inventoryModule,
    integrationOptions: { stateRoot: true },
  });
  await h.integration.processMailbox();
  let projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  assert.equal(projected.capabilities.includes("control-repo-mode-v1"), false);
  assert.equal(projected.dashboard.capabilities.includes("control-repo-mode-v1"), true);
  assert.equal(projected.dashboard.supportedControls.includes("set-repo-mode"), true);

  for (const mode of ["manual", "auto", "yolo", "inherit"]) {
    const controlState = readControlState(h.root, FINGERPRINT, { now: h.now() });
    const request = createControlRequest({
      controlState,
      action: "set-repo-mode",
      payload: { mode },
      timestamp: h.now(),
      requestId: `repository-mode-${mode}`,
    });
    submitControlRequest(h.root, request);
    const pass = await h.integration.processMailbox();
    assert.equal(pass.controls.length, 1);
    const response = pollControlResponse(h.root, FINGERPRINT, request.requestId);
    assert.equal(response.ok, true, `${mode}: ${response.reason}`);
    assert.equal(h.store.getSettings().repo.mode, mode);
    submitControlRequest(h.root, request);
    await h.integration.processMailbox();
    assert.equal(h.store.getSettings().repo.mode, mode, "replay recovery must not repeat the settings mutation");
    if (mode === "yolo") {
      const yoloState = readControlState(h.root, FINGERPRINT, { now: h.now() });
      const empty = createControlRequest({
        controlState: yoloState,
        action: "update-allowlist",
        payload: { allowlist: [], confirmation: "UPDATE ALLOWLIST" },
        timestamp: h.now(),
        requestId: "repository-yolo-empty-allowlist",
      });
      submitControlRequest(h.root, empty);
      await h.integration.processMailbox();
      assert.equal(pollControlResponse(h.root, FINGERPRINT, empty.requestId).reason, "yolo-allowlist-required");
      assert.deepEqual(h.store.getSettings().global.allowedSkillRoots, [h.root]);
    }
  }
  const repoTransitions = h.store.readRecords("audit-event")
    .map((record) => record.payload)
    .filter((event) => event.kind === "mode-change" && event.details?.scope === "repo");
  assert.deepEqual(repoTransitions.map((event) => event.details.requestedMode), [
    "manual", "auto", "yolo", "inherit",
  ]);

  projected = readUiProjection(h.root, FINGERPRINT, {
    now: h.now(),
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  assert.equal(projected.dashboard.settings.repositoryMode, "inherit");

  const staleState = readControlState(h.root, FINGERPRINT, { now: h.now() });
  assert.equal(h.integration.__testBridge.setMode("manual").ok, true);
  const stale = createControlRequest({
    controlState: staleState,
    action: "set-repo-mode",
    payload: { mode: "auto" },
    timestamp: h.now(),
    requestId: "repository-mode-stale",
  });
  submitControlRequest(h.root, stale);
  await h.integration.processMailbox();
  assert.equal(pollControlResponse(h.root, FINGERPRINT, stale.requestId).ok, false);
  assert.match(pollControlResponse(h.root, FINGERPRINT, stale.requestId).reason, /stale|nonce/u);

  const canonicalState = readControlState(h.root, FINGERPRINT, { now: h.now() });
  const canonical = createControlRequest({
    controlState: canonicalState,
    action: "update-allowlist",
    payload: {
      allowlist: [path.join(h.root, "missing-skill-folder")],
      confirmation: "UPDATE ALLOWLIST",
    },
    timestamp: h.now(),
    requestId: "repository-invalid-folder",
  });
  submitControlRequest(h.root, canonical);
  await h.integration.processMailbox();
  assert.equal(pollControlResponse(h.root, FINGERPRINT, canonical.requestId).reason,
    "invalid-or-unsupported-skill-folder");
  assert.deepEqual(h.store.getSettings().global.allowedSkillRoots, [h.root]);

  const blockedCases = [
    {
      name: "allowlist",
      config: { allowlisted: false, rolloutOutcomes: 0 },
      reason: "yolo-allowlist-required",
    },
    {
      name: "consent",
      mutate(blocked) {
        blocked.store.updateGlobalSettings((global) => schemas.makeGlobalSettings({
          ...global,
          consent: { ...global.consent, passiveCalls: false },
          updatedAt: blocked.now(),
        }));
      },
      reason: "passive-consent-required",
    },
    {
      name: "rollout",
      config: { rolloutOutcomes: 0 },
      reason: "yolo-rollout-not-ready",
    },
    {
      name: "breaker",
      config: { breakerOpen: true },
      reason: "circuit-breaker-open",
    },
  ];
  for (const blockedCase of blockedCases) {
    const blocked = harness(t, {
      initialClock: Date.now(),
      inventory: inventoryModule,
      integrationOptions: { stateRoot: true },
      ...blockedCase.config,
    });
    blockedCase.mutate?.(blocked);
    await blocked.integration.processMailbox();
    const blockedState = readControlState(blocked.root, FINGERPRINT, { now: blocked.now() });
    const yolo = createControlRequest({
      controlState: blockedState,
      action: "set-repo-mode",
      payload: { mode: "yolo" },
      timestamp: blocked.now(),
      requestId: `repository-yolo-blocked-${blockedCase.name}`,
    });
    submitControlRequest(blocked.root, yolo);
    await blocked.integration.processMailbox();
    const blockedResponse = pollControlResponse(blocked.root, FINGERPRINT, yolo.requestId);
    assert.equal(blockedResponse.ok, false);
    assert.equal(blockedResponse.reason, blockedCase.reason);
    assert.equal(blocked.store.getSettings().repo.mode, "inherit");
  }
});

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
  const h = harness(t, {
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
    payload: { confirmation: "PURGE ALL SELF-EVOLVE DATA" },
    timestamp: h.now(),
  });
  submitUiOperationRequest(h.root, request);
  const consumed = await h.integration.processMailbox();
  assert.equal(consumed.operations[0].status, "accepted-terminal");
  assert.equal(pollUiOperationResponse(h.root, request, { now: h.now() }).status, "accepted-terminal");
  assert.equal(existsSync(path.join(h.root, "self-evolve")), true);
  purgeCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(path.join(h.root, "self-evolve")), false);
  assert.equal(h.integration.__testBridge.getHealth().lastError, "simulated-terminal-purge-failure");
  assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: {} }), {
    scheduled: false,
    reason: "restart-required-after-purge-all",
  });
  await h.integration.shutdown();
});

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

test("yolo auto-applies only an allowlisted validated proposal after rollout threshold", async (t) => {
  const h = harness(t);
  h.integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
  const result = await h.integration.runEvolutionCycle({ sessionID: "yolo", projectFingerprint: FINGERPRINT, scopeFingerprint: FINGERPRINT });
  assert.equal(result.result, "applied");
  assert.equal(h.calls.applies.length, 1);
  assert.match(result.responseText, /OpenCode must be restarted/u);
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

test("only validated, project-bound, deduplicated synthesis outcomes grant yolo authority", async (t) => {
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
  assert.equal((await h.integration.runEvolutionCycle({ sessionID: "enabled", projectFingerprint: FINGERPRINT })).result, "applied");
  assert.equal(h.calls.applies.length, 1);
});

test("mode changes converge across integrations on the next event", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-shared-"));
  const store = openStore(root, { projectName: "shared", projectFingerprint: FINGERPRINT });
  t.after(() => { try { store.close(); } catch {} });
  const current = store.getSettings();
  store.setGlobalSettings(schemas.makeGlobalSettings({ ...current.global, consent: { passiveCalls: true, durableObservations: true }, updatedAt: Date.now() }));
  const calls = [];
  const schedulerModule = { createScheduler: ({ enqueueWork }) => ({ handleEvent: async (event) => { calls.push(event); await enqueueWork({ sessionID: event.properties.sessionID, projectFingerprint: FINGERPRINT, leaseNonce: "shared", epoch: 1, scheduledAt: Date.now() }); }, setMode() {}, getCircuitBreaker: () => ({ open: false }), recordWorkResult() {}, dispose() {} }) };
  const pipelineModule = { createPipeline: () => ({ runEvolutionCycle: async () => ({ result: "no-eligible" }), runApprovalFlow: async () => ({}), runRollbackFlow: async () => ({}) }) };
  const deps = { store, inventory: {}, privacy: { exportScope: () => ({ records: [] }), purgeScope: () => ({ ok: true }), scanForForbiddenContent: () => ({ ok: true }) }, schemas, observation: {}, synthesisModule: {}, applier: { applyProposal: async () => ({ ok: false }), circuitBreakerOpen: () => false, recoverPending: () => [] }, commands: commandModule, pipeline: pipelineModule, scheduler: schedulerModule };
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
    h.integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
    h.integration.triggerKillSwitch("test");
    assert.equal(h.integration.__testBridge.getMode().storedMode, "yolo");
    assert.equal(h.integration.__testBridge.getMode().effectiveMode, "manual");
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "killed" } })).scheduled, false);
    h.integration.clearKillSwitch("test-clear");
    assert.equal(h.integration.__testBridge.getMode().effectiveMode, "yolo");
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
  assert.deepEqual(schemas.Mode.values, ["manual", "auto", "yolo"]);
  await t.test("passive shadow stops before synthesis", async (t) => {
    const h = harness(t, { rolloutGates: { passiveShadowObservation: true } });
    h.integration.__testBridge.setMode("auto");
    const result = await h.integration.runEvolutionCycle({ sessionID: "shadow", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "observed-shadow");
    assert.equal(h.calls.cycles[0].options.stopAfter, "correlate");
  });
  await t.test("application-disabled forces pending review", async (t) => {
    const h = harness(t, { rolloutGates: { automaticSynthesisApplicationDisabled: true } });
    h.integration.__testBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
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
  assert.deepEqual(recoveryOrder.slice(0, 2), ["synthesis-recovery", "retention"]);
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

test("purge all is terminal through timer ticks, later events and commands, and shutdown", async (t) => {
  let retentionCallback;
  let timerCleared = false;
  const timer = { unref() {} };
  const h = harness(t, {
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
    },
  });
  await h.integration.boot({ ctx: h.ctx, hostVersion: "1.18.3", recoverHostSessions: false });
  const subtree = path.join(h.root, "self-evolve");
  const secondStore = openStore(h.root, { projectFingerprint: "b".repeat(64), now: h.now });
  assert.equal(existsSync(subtree), true);
  const purged = await h.integration.handleCommand({ command: "purge --all", projectFingerprint: FINGERPRINT });
  assert.equal(purged.terminalPurge, true);
  assert.equal(timerCleared, true);
  assert.equal(existsSync(subtree), false);

  retentionCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(subtree), false);
  assert.deepEqual(await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "after-purge" } }), { scheduled: false, reason: "restart-required-after-purge-all" });
  assert.match((await h.integration.handleCommand({ command: "status" })).responseText, /Restart OpenCode/u);
  assert.throws(() => secondStore.getSettings(), /restart-required-after-purge-all/u);
  secondStore.close();
  assert.equal(existsSync(subtree), false);
  await h.integration.shutdown();
  assert.equal(existsSync(subtree), false);
});

test("mode changes publish a TUI event and consent remains command-policy managed", (t) => {
  const h = harness(t);
  const mode = h.integration.__testBridge.setMode("auto");
  assert.equal(mode.ok, true);
  assert.equal(h.calls.published.some((event) => event.type === "self-evolve.settings"), true);
  const consent = h.integration.__testBridge.setConsent("sanitizedExcerpts", true);
  assert.equal(consent.ok, true);
  assert.equal(h.integration.__testBridge.getConsent().sanitizedExcerpts, true);
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
  };
  // Recovery (self-evolve-3r4) aborts only a session with a provably DEAD self-evolve
  // owner record matching this project/root. "terminal"/"other" are not candidates;
  // a same-name session without an owner record is foreign/unknown and never aborted.
  assert.equal(seedDeadHostOwner(h.root, "active", "self-evolve-analyzer").ok, true);
  const [first, concurrent] = await Promise.all([
    h.integration.recoverHostSessions({ timeoutMs: 20, retries: 1, backoffMs: 1 }),
    h.integration.recoverHostSessions({ timeoutMs: 20, retries: 1, backoffMs: 1 }),
  ]);
  const repeated = await h.integration.recoverHostSessions();
  assert.deepEqual(concurrent, first);
  assert.deepEqual(repeated, first);
  assert.equal(lists, 1);
  assert.deepEqual(aborted, ["active"]);
  assert.deepEqual(h.integration.__testBridge.getHealth().hostSessionRecovery, { ok: true, cancelled: false, attempts: 1, aborted: 1, failed: 0 });
  await h.integration.shutdown();
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
