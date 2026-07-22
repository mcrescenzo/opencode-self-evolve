import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { createIntegration, ROLLOUT_GATES } from "../self-evolve-integration.js";
import { openStore } from "../self-evolve-store.js";
import * as schemas from "../self-evolve-schemas.js";
import * as commandModule from "../self-evolve-commands.js";

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

function harness(t, config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-integration-"));
  let clock = 100;
  const now = () => ++clock;
  const store = openStore(root, { projectName: "fixture", projectFingerprint: FINGERPRINT, now });
  const current = store.getSettings();
  store.setGlobalSettings(schemas.makeGlobalSettings({
    ...current.global,
    allowedSkillRoots: config.allowlisted === false ? [] : [root],
    consent: { passiveCalls: true, durableObservations: true, sanitizedExcerpts: false, crossRepoAggregation: false },
    updatedAt: now(),
  }));

  const calls = { events: [], cycles: [], applies: [], approvals: [], rollbacks: [], cancelled: [], workResults: [], recoveries: 0, published: [] };
  const privacy = {
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
    close() {},
  };

  const pipelineModule = {
    createPipeline(deps) {
      return {
        async runEvolutionCycle(args) {
          calls.cycles.push(args);
          if (config.deferredCycle) return config.deferredCycle.promise;
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
          const applied = await deps.applier.applyProposal({ proposal: { ...item, proposedContent: "# proposed\n" }, decision, mode: args.mode, headless: false });
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
        recordWorkResult(item, result) { calls.workResults.push({ item, result }); return { accepted: true }; },
        dispose() {},
      };
    },
  };

  const ctx = { client: { tui: { publish(value) { calls.published.push(value); } } } };
  const integration = createIntegration({
    store,
    inventory: {},
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
      rolloutMetrics: config.rolloutMetrics ?? { synthesesObserved: 10, successRate: 0.8 },
      rolloutGates: config.rolloutGates,
      processExcluded: config.processExcluded,
      repoOptOut: config.repoOptOut,
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

test("all three modes preserve identical evidence and proposal thresholds", async (t) => {
  for (const mode of schemas.Mode.values) {
    await t.test(mode, async (t) => {
      const h = harness(t, { rolloutMetrics: { synthesesObserved: 0, successRate: 0 } });
      const set = h.integration.tuiBridge.setMode(mode, mode === "yolo" ? { confirmed: true, allowlist: [h.root] } : {});
      assert.equal(set.ok, true);
      const result = await h.integration.runEvolutionCycle({ sessionID: `session-${mode}`, projectFingerprint: FINGERPRINT, scopeFingerprint: FINGERPRINT });
      assert.deepEqual(result.observations, [{ id: "observation-shared", incidentId: "incident-shared" }]);
      assert.deepEqual(result.eligibility[0].thresholdsMet, { minIncidents: 3 });
      assert.equal(result.proposal.clusterId, "d".repeat(64));
    });
  }
});

test("manual mode has no passive scheduler activity or writes", async (t) => {
  const h = harness(t);
  const before = h.store.exportAll().records.length;
  const result = await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "manual-session" } });
  assert.deepEqual(result, { scheduled: false, reason: "manual-mode" });
  assert.equal(h.calls.events.length, 0);
  assert.equal(h.store.exportAll().records.length, before);
});

test("auto waits for an exact approval and then applies with a restart reminder", async (t) => {
  const h = harness(t);
  h.integration.tuiBridge.setMode("auto");
  const item = proposal(h.root);
  seedProposal(h.store, item);
  assert.equal(h.calls.applies.length, 0);
  const result = await h.integration.tuiBridge.decide({ decision: exactDecision(item, "approved", h.now()) });
  assert.equal(result.ok, true);
  assert.equal(h.calls.applies.length, 1);
  assert.match(result.responseText, /OpenCode must be restarted/u);
  assert.equal(latestProposal(h.store, item.id).state, "applied");
});

test("yolo auto-applies only an allowlisted validated proposal after rollout threshold", async (t) => {
  const h = harness(t);
  h.integration.tuiBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
  const result = await h.integration.runEvolutionCycle({ sessionID: "yolo", projectFingerprint: FINGERPRINT, scopeFingerprint: FINGERPRINT });
  assert.equal(result.result, "applied");
  assert.equal(h.calls.applies.length, 1);
  assert.match(result.responseText, /OpenCode must be restarted/u);
});

test("unknown scopes and below-threshold yolo remain pending", async (t) => {
  await t.test("non-allowlisted", async (t) => {
    const h = harness(t, { allowlisted: false });
    h.integration.tuiBridge.setMode("yolo", { confirmed: true, allowlist: [path.join(h.root, "allowed-not-target")] });
    const result = await h.integration.runEvolutionCycle({ sessionID: "unknown", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "proposal-ready");
    assert.equal(h.calls.applies.length, 0);
  });
  await t.test("rollout threshold", async (t) => {
    const h = harness(t, { rolloutMetrics: { synthesesObserved: 5, successRate: 1 } });
    h.integration.tuiBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
    const result = await h.integration.runEvolutionCycle({ sessionID: "threshold", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "proposal-ready");
    assert.equal(h.calls.applies.length, 0);
  });
  await t.test("auto is always pending before approval", async (t) => {
    const h = harness(t);
    h.integration.tuiBridge.setMode("auto");
    const result = await h.integration.runEvolutionCycle({ sessionID: "auto", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "proposal-ready");
    assert.equal(h.calls.applies.length, 0);
  });
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
  a.tuiBridge.setMode("auto");
  assert.equal((await b.handleEvent({ type: "session.idle", properties: { sessionID: "after" } })).scheduled, true);
  assert.equal(calls.length, 1);
});

test("pause, exclusion, circuit breaker, and kill switch override stored authority", async (t) => {
  await t.test("pause", async (t) => {
    const h = harness(t);
    h.integration.tuiBridge.setMode("auto");
    const current = h.store.getSettings();
    h.store.setGlobalSettings(schemas.makeGlobalSettings({ ...current.global, paused: true, updatedAt: h.now() }));
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "paused" } })).scheduled, false);
  });
  await t.test("repo exclusion", async (t) => {
    const h = harness(t, { repoOptOut: true });
    h.integration.tuiBridge.setMode("auto");
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "excluded" } })).scheduled, false);
  });
  await t.test("circuit breaker", async (t) => {
    const h = harness(t, { breakerOpen: true });
    h.integration.tuiBridge.setMode("auto");
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "breaker" } })).scheduled, false);
  });
  await t.test("kill switch", async (t) => {
    const h = harness(t);
    h.integration.tuiBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
    h.integration.triggerKillSwitch("test");
    assert.equal(h.integration.tuiBridge.getMode().storedMode, "yolo");
    assert.equal(h.integration.tuiBridge.getMode().effectiveMode, "manual");
    assert.equal((await h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "killed" } })).scheduled, false);
    h.integration.clearKillSwitch("test-clear");
    assert.equal(h.integration.tuiBridge.getMode().effectiveMode, "yolo");
  });
});

test("in-flight downgrade cancels pending continuation and records downgrade", async (t) => {
  let resolve;
  const deferredCycle = { promise: new Promise((done) => { resolve = done; }) };
  const h = harness(t, { deferredCycle });
  h.integration.tuiBridge.setMode("auto");
  const running = h.integration.handleEvent({ type: "session.idle", properties: { sessionID: "in-flight" } });
  await new Promise((done) => setImmediate(done));
  assert.equal(h.integration.getInFlightWork().length, 1);
  h.integration.tuiBridge.setMode("manual");
  assert.deepEqual(h.calls.cancelled, ["in-flight"]);
  assert.equal(h.calls.workResults.some((entry) => entry.result.downgrade === true), true);
  resolve({ result: "proposal-ready" });
  await running;
  assert.equal(h.calls.workResults.filter((entry) => entry.item.sessionID === "in-flight").length, 1);
});

test("server-side TUI bridge works without a TUI process and rejects duplicate CAS", async (t) => {
  const h = harness(t);
  h.integration.tuiBridge.setMode("auto");
  const item = proposal(h.root);
  seedProposal(h.store, item);
  const decision = exactDecision(item, "approved", h.now());
  const first = await h.integration.tuiBridge.decide({ decision });
  const duplicate = await h.integration.tuiBridge.decide({ decision });
  assert.equal(first.ok, true);
  assert.deepEqual(duplicate, { ok: false, reason: "stale-prior-state" });
});

test("apply and rollback each produce audited state and rollback CAS", async (t) => {
  const h = harness(t);
  h.integration.tuiBridge.setMode("auto");
  const item = proposal(h.root);
  seedProposal(h.store, item);
  const applied = await h.integration.tuiBridge.decide({ decision: exactDecision(item, "approved", h.now()) });
  assert.equal(applied.ok, true);
  const appliedProposal = latestProposal(h.store, item.id);
  const rolledBack = await h.integration.tuiBridge.decide({ decision: exactDecision(appliedProposal, "rolled-back", h.now()) });
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
    h.integration.tuiBridge.setMode("auto");
    const result = await h.integration.runEvolutionCycle({ sessionID: "shadow", projectFingerprint: FINGERPRINT });
    assert.equal(result.result, "observed-shadow");
    assert.equal(h.calls.cycles[0].options.stopAfter, "correlate");
  });
  await t.test("application-disabled forces pending review", async (t) => {
    const h = harness(t, { rolloutGates: { automaticSynthesisApplicationDisabled: true } });
    h.integration.tuiBridge.setMode("yolo", { confirmed: true, allowlist: [h.root] });
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
  const inbox = h.integration.tuiBridge.getInbox({ projectFingerprint: FINGERPRINT });
  assert.equal(inbox.length, 1);
  assert.equal("proposedContent" in inbox[0], false);
  const detail = h.integration.tuiBridge.getProposal({ proposalId: item.id, projectFingerprint: FINGERPRINT });
  assert.equal(detail.proposal.id, item.id);
  assert.equal(typeof detail.diffPreview, "string");
  assert.equal(h.integration.tuiBridge.getProposal({ proposalId: item.id, projectFingerprint: "f".repeat(64) }), null);
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

test("mode changes publish a TUI event and consent remains command-policy managed", (t) => {
  const h = harness(t);
  const mode = h.integration.tuiBridge.setMode("auto");
  assert.equal(mode.ok, true);
  assert.equal(h.calls.published.some((event) => event.type === "self-evolve.settings"), true);
  const consent = h.integration.tuiBridge.setConsent("sanitizedExcerpts", true);
  assert.equal(consent.ok, true);
  assert.equal(h.integration.tuiBridge.getConsent().sanitizedExcerpts, true);
});
