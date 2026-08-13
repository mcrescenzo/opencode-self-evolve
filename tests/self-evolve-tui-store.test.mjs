import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BRIDGE_ACTOR,
  BRIDGE_TTL_MS,
} from "../self-evolve-bridge.js";
import {
  GLOBAL_PROTOCOL_LIMITS,
  UI_ACTION_CAPABILITIES,
  UI_CAPABILITIES,
  UI_DASHBOARD_BLOCKER_DESTINATIONS,
  UI_PROJECTION_VERSION,
  hashGlobalProtocol,
  hashUiProtocol,
} from "../self-evolve-ui-protocol.js";
import {
  CONTROL_CENTER_SECTIONS,
  __testTuiStore,
  acquireProjectTuiStore,
  buildActivityModel,
  buildControlCenterModel,
  buildHomeModel,
  buildRecommendationsModel,
  buildSettingsModel,
  controlCenterRouteParams,
  deriveOperationalView,
  deriveSidebarCard,
  deriveSidebarModeControl,
  parseControlCenterDestination,
  validateApprovedSkillFolderInput,
} from "../self-evolve-tui-store.js";
import { BRIDGE_SCHEMA_VERSION as SCHEMA_VERSION } from "../self-evolve-bridge.js";

function lifecycle() {
  const controller = new AbortController();
  const disposers = [];
  return {
    signal: controller.signal,
    onDispose(callback) {
      disposers.push(callback);
      return () => {
        const index = disposers.indexOf(callback);
        if (index !== -1) disposers.splice(index, 1);
      };
    },
    abort() { controller.abort(); },
    dispose() {
      for (const callback of disposers.splice(0)) callback();
    },
    count() { return disposers.length; },
  };
}

function eventBus() {
  const listeners = new Map();
  return {
    on(type, callback) {
      const values = listeners.get(type) ?? new Set();
      values.add(callback);
      listeners.set(type, values);
      return () => values.delete(callback);
    },
    emit(type) {
      for (const callback of listeners.get(type) ?? []) callback();
    },
    count() {
      return [...listeners.values()].reduce((sum, values) => sum + values.size, 0);
    },
  };
}

function apiFor(root, worktree) {
  return {
    state: { ready: true, path: { state: root, worktree, directory: worktree } },
    event: eventBus(),
    lifecycle: lifecycle(),
  };
}

function harness({ watchError } = {}) {
  const intervals = new Set();
  const watchers = [];
  let nextWatchError = watchError;
  return {
    intervals,
    watchers,
    setInterval(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {}, cleared: false };
      intervals.add(timer);
      return timer;
    },
    clearInterval(timer) {
      if (timer) timer.cleared = true;
      intervals.delete(timer);
    },
    watch(watchPath, options, callback) {
      if (nextWatchError) {
        const error = nextWatchError;
        nextWatchError = null;
        throw error;
      }
      const errors = new Set();
      const watcher = {
        watchPath,
        options,
        callback,
        closed: false,
        close() { this.closed = true; },
        on(type, listener) {
          if (type === "error") errors.add(listener);
          return this;
        },
        emitError(error) {
          for (const listener of errors) listener(error);
        },
      };
      watchers.push(watcher);
      return watcher;
    },
    tick() {
      for (const timer of [...intervals]) timer.callback();
    },
  };
}

function projection(generation = "a") {
  return Object.freeze({
    mode: "native",
    projectionVersion: 1,
    operationProtocolVersion: 2,
    index: Object.freeze({ generation: generation.repeat(64) }),
    details: Object.freeze([]),
    effectiveIndexActions: Object.freeze([]),
    effectiveDetailActions: Object.freeze({}),
  });
}

function dashboard(overrides = {}) {
  return {
    dashboardVersion: 3,
    generatedAt: 1_000,
    automation: { state: "ready", reason: null },
    blockers: [],
    inFlight: { active: false, count: 0, stage: null, startedAt: null },
    lastCycle: null,
    nextEligibleAt: null,
    usage: {
      provider: { used: 1, limit: 3, remaining: 2, resetAt: 2_000 },
      synthesis: { used: 1, limit: 2, remaining: 1, resetAt: 3_000 },
      storage: { usedBytes: 100, limitBytes: 1_000, remainingBytes: 900 },
    },
    rollout: {
      ready: true,
      synthesesObserved: 10,
      minSynthesesObserved: 10,
      successRateBasisPoints: 9_000,
      minSuccessRateBasisPoints: 8_000,
    },
    settings: {
      automaticRecommendationsEnabled: true,
      automationGeneration: 1,
      killSwitchActive: false,
      repositoryExcluded: false,
      consent: {
        durableObservations: true,
        sanitizedExcerpts: true,
        crossRepoAggregation: true,
      },
      approvedSkillFolderCount: 1,
      collectionSuggestions: [],
      globalSettingsVersion: "b".repeat(64),
      globalRootPolicy: null,
      globalRootPolicyConfirmation: "REPLACE GLOBAL ROOT POLICY bbbbbbbbbbbb",
      globalRootPolicyAction: null,
    },
    retention: { observationsDays: 30, operationalDays: 90 },
    capabilities: ["decision-feedback-v1", "operation-global-root-policy-v1", "project-participation-v1"],
    supportedControls: ["set-automatic-recommendations", "set-kill-switch", "set-permission", "set-repo-excluded"],
    activity: [],
    overflow: {
      activity: {
        truncated: false,
        includedCount: 0,
        omittedCount: 0,
        omittedBytes: 0,
        reason: "none",
      },
    },
    ...overrides,
  };
}

function modelSnapshot({
  dashboard: dashboardValue = dashboard(),
  dashboardError = null,
  status = {},
  reviews = [],
  operations = [],
  phase = "ready",
  acknowledgedOutcomes = [],
} = {}) {
  const projectFingerprint = "a".repeat(64);
  const stateRootIdentity = "b".repeat(64);
  return {
    phase,
    updatedAt: 1_000,
    projectFingerprint,
    stateRootIdentity,
    tuiHealth: {
      projectFingerprint,
      stateRootIdentity,
      expiresAt: 10_000,
    },
    pending: [],
    acknowledgedOutcomes,
    dashboard: dashboardValue,
    dashboardError,
    projection: {
      mode: "native",
      projectionVersion: 1,
      operationProtocolVersion: 2,
      capabilities: [...UI_CAPABILITIES],
      dashboard: dashboardValue,
      dashboardError,
      index: {
        projectFingerprint,
        stateRootIdentity,
        capabilities: [...UI_CAPABILITIES],
        budgets: {
          passiveCallsPerHour: 3,
          synthesisPerDay: 2,
          tokensPerSynthesis: 100,
          concurrentObservationsPerProject: 1,
          concurrentSynthesesGlobal: 1,
          idleDebounceMs: 1_500,
          storageQuotaMiB: 8,
        },
        status: {
          state: "ready",
          reason: null,
          automaticRecommendationsEnabled: true,
          killSwitchActive: false,
          repoExcluded: false,
          circuitBreakerOpen: false,
          ...status,
        },
        reviews,
        operations,
      },
      details: [],
      effectiveIndexActions: [],
      effectiveDetailActions: {},
    },
  };
}

function options(api, scheduler, clientFactory, extra = {}) {
  return {
    api,
    clientFactory,
    watch: scheduler.watch,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
    pollMs: 50,
    ...extra,
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach(() => __testTuiStore.reset());
test.afterEach(() => __testTuiStore.reset());

test("one operational precedence drives truthful sidebar states and bounded entry destinations", () => {
  const privateReview = { proposalId: "private-proposal-id", state: "pending", attention: "normal" };
  const cases = [
    ["terminal", modelSnapshot({ status: { state: "terminal" } }), "home"],
    ["corrupt", modelSnapshot({ status: { state: "corrupt" } }), "activity"],
    ["emergency-stop", modelSnapshot({ dashboard: dashboard({ automation: { state: "emergency-stop", reason: "emergency-stop" } }) }), "settings"],
    ["circuit-breaker", modelSnapshot({ dashboard: dashboard({ automation: { state: "circuit-breaker", reason: "three-failures-in-24h" } }) }), "activity"],
    ["off", modelSnapshot({ dashboard: dashboard({
      automation: { state: "off", reason: "automatic-recommendations-off" },
      settings: { ...dashboard().settings, automaticRecommendationsEnabled: false },
    }) }), "settings"],
    ["excluded", modelSnapshot({ dashboard: dashboard({ automation: { state: "excluded", reason: "repository-excluded" } }) }), "settings"],
    ["setup-required", modelSnapshot({ dashboard: dashboard({
      automation: { state: "setup-required", reason: "setup-required" },
      blockers: [{ code: "provider", summary: "Background analysis has no usable provider.", destination: "settings" }],
    }) }), "settings"],
    ["running", modelSnapshot({ dashboard: dashboard({
      automation: { state: "running", reason: null },
      inFlight: { active: true, count: 1, stage: "pipeline", startedAt: 500 },
    }) }), "home"],
    ["backoff", modelSnapshot({ dashboard: dashboard({
      automation: { state: "backoff", reason: "backoff" },
      nextEligibleAt: 2_000,
    }) }), "activity"],
    ["budget", modelSnapshot({ dashboard: dashboard({
      automation: { state: "budget", reason: "passive-provider-budget-exhausted" },
      nextEligibleAt: 2_000,
    }) }), "home"],
    ["quiet-period", modelSnapshot({ dashboard: dashboard({
      automation: { state: "quiet-period", reason: "quiet-period" },
      nextEligibleAt: 2_000,
    }) }), "home"],
    ["recommendation", modelSnapshot({ reviews: [privateReview] }), "recommendations"],
    ["applied", modelSnapshot({
      reviews: [{ ...privateReview, state: "applied" }],
      dashboard: dashboard({
        activity: [{
          id: "a".repeat(64),
          category: "recommendation",
          audience: "default",
          outcome: "applied",
          summary: "A verified recommendation was applied.",
          occurredAt: 900,
          proposalId: privateReview.proposalId,
          reason: null,
        }],
      }),
    }), "recommendations"],
    ["startup", modelSnapshot({ status: { state: "startup-pending" }, dashboard: null }), "home"],
    ["ready", modelSnapshot(), "home"],
  ];
  for (const [expectedState, snapshot, expectedSection] of cases) {
    const operational = deriveOperationalView(snapshot);
    const sidebar = deriveSidebarCard(snapshot);
    assert.equal(operational.state, expectedState);
    assert.equal(sidebar.destination.section, expectedSection);
    assert.equal(
      operational.destination.section,
      sidebar.destination.section,
    );
    assert.equal(sidebar.summary, expectedState === "ready" ? "Watching this project" : operational.label);
    assert.doesNotMatch(JSON.stringify(sidebar), /private-proposal-id|[a-f0-9]{64}/u);
  }
});

test("safety blockers outrank global operation failures, which still outrank recommendation attention", () => {
  const failedOperation = {
    requestId: "failed-global-operation",
    kind: "global-action",
    action: "apply",
    subject: "global-recommendation",
    submittedAt: 800,
    expiresAt: 900,
    response: { ok: false, status: "rejected", processedAt: 850, reason: "stale-global-generation" },
  };
  const withFailure = (snapshot) => {
    snapshot.global = { phase: "ready", pending: [], responses: [failedOperation], projection: null };
    return snapshot;
  };
  for (const [state, snapshot, destination] of [
    ["terminal", withFailure(modelSnapshot({ status: { state: "terminal" } })), { section: "home" }],
    ["corrupt", withFailure(modelSnapshot({ status: { state: "corrupt" } })), { section: "activity", filter: "errors" }],
    ["emergency-stop", withFailure(modelSnapshot({ dashboard: dashboard({ automation: { state: "emergency-stop", reason: "emergency-stop" } }) })), { section: "settings", anchor: "emergency-stop" }],
    ["circuit-breaker", withFailure(modelSnapshot({ dashboard: dashboard({ automation: { state: "circuit-breaker", reason: "three-failures-in-24h" } }) })), { section: "activity", filter: "errors" }],
  ]) {
    const operational = deriveOperationalView(snapshot);
    assert.equal(operational.state, state);
    assert.deepEqual(operational.destination, destination);
    assert.deepEqual(deriveSidebarCard(snapshot).destination, destination);
  }

  const recommendation = withFailure(modelSnapshot({
    reviews: [{ proposalId: "pending-review", state: "pending", target: "review/SKILL.md", attention: "normal", updatedAt: 900 }],
  }));
  const failure = deriveOperationalView(recommendation);
  assert.equal(failure.state, "failure");
  assert.deepEqual(failure.destination, { section: "activity", filter: "errors" });
  assert.deepEqual(deriveSidebarCard(recommendation).destination, { section: "activity", filter: "errors" });
});

test("critic-pending is absent from TUI attention, queue, routes, detail, and actions; failed-closed routes to errors", () => {
  const critic = {
    proposalId: "critic-hidden",
    state: "critic-pending",
    target: "hidden/SKILL.md",
    attention: "warning",
    updatedAt: 2,
  };
  const pending = {
    proposalId: "pending-visible",
    state: "pending",
    target: "visible/SKILL.md",
    attention: "normal",
    updatedAt: 1,
  };
  const snapshot = modelSnapshot({ reviews: [critic, pending] });
  snapshot.projection.details = [
    { proposalId: critic.proposalId, summary: { rationale: "hidden" } },
  ];
  snapshot.projection.effectiveDetailActions = {
    [critic.proposalId]: [{ action: "apply-proposal" }],
  };

  const operational = deriveOperationalView(snapshot);
  const recommendations = buildRecommendationsModel(snapshot, { filter: "all", selectedIndex: 0 });
  assert.equal(operational.state, "recommendation");
  assert.equal(operational.count, 1);
  assert.equal(operational.destination.selectedIndex, 1);
  assert.deepEqual(recommendations.queue.map((entry) => entry.state), ["pending"]);
  assert.equal(recommendations.selected.summary, null);
  assert.deepEqual(recommendations.selected.actions, []);
  assert.deepEqual(controlCenterRouteParams({ section: "recommendations", selectedIndex: 0 }, snapshot), {
    section: "recommendations",
  });
  assert.deepEqual(parseControlCenterDestination({
    section: "recommendations",
    recommendation: critic.proposalId,
  }, snapshot), { section: "home" });
  assert.doesNotMatch(JSON.stringify(buildControlCenterModel(snapshot)), /critic-hidden|hidden\/SKILL\.md/u);

  const failed = modelSnapshot({
    reviews: [{ ...pending, state: "failed-closed", attention: "critical" }],
    dashboard: dashboard({ automation: { state: "setup-required", reason: "setup-required" } }),
  });
  const failure = deriveOperationalView(failed);
  assert.equal(failure.state, "failure");
  assert.deepEqual(failure.destination, { section: "activity", filter: "errors" });
  assert.equal(deriveSidebarCard(failed).kind, "failure");
});

test("failed-closed reviews override healthy enhanced and limited views without exposing Apply authority", () => {
  const failedReview = {
    proposalId: "failed-review",
    state: "failed-closed",
    target: "failed/SKILL.md",
    attention: "critical",
    updatedAt: 1_000,
  };
  const enhanced = modelSnapshot({ reviews: [failedReview] });
  enhanced.projection.effectiveDetailActions = {
    [failedReview.proposalId]: [
      { action: "apply-proposal" },
      { action: "reject-proposal" },
    ],
  };

  const enhancedOperational = deriveOperationalView(enhanced);
  assert.equal(enhanced.dashboard.automation.state, "ready");
  assert.equal(enhancedOperational.state, "failure");
  assert.deepEqual(enhancedOperational.destination, { section: "activity", filter: "errors" });
  assert.equal(Buffer.byteLength(enhancedOperational.explanation, "utf8") <= 240, true);
  assert.deepEqual(buildRecommendationsModel(enhanced, { filter: "all" }).selected.actions, []);

  const limited = modelSnapshot({ reviews: [failedReview], dashboard: null });
  const limitedOperational = deriveOperationalView(limited);
  assert.equal(limitedOperational.state, "failure");
  assert.equal(limitedOperational.limited, true);
  assert.deepEqual(limitedOperational.destination, { section: "activity", filter: "errors" });

  for (const [expected, snapshot] of [
    ["terminal", modelSnapshot({ status: { state: "terminal" }, reviews: [failedReview] })],
    ["corrupt", modelSnapshot({ status: { state: "corrupt" }, reviews: [failedReview] })],
    ["emergency-stop", modelSnapshot({
      reviews: [failedReview],
      dashboard: dashboard({ automation: { state: "emergency-stop", reason: "emergency-stop" } }),
    })],
    ["circuit-breaker", modelSnapshot({
      reviews: [failedReview],
      dashboard: dashboard({ automation: { state: "circuit-breaker", reason: "three-failures-in-24h" } }),
    })],
  ]) assert.equal(deriveOperationalView(snapshot).state, expected);
});

test("project runtime strips inconsistent failed-closed detail grants before any decision submit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-failed-authority-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-failed-authority-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const proposalId = "failed-runtime-review";
  const failedProjection = {
    ...projection(),
    dashboard: dashboard(),
    index: {
      generation: "a".repeat(64),
      reviews: [{ proposalId, state: "failed-closed", attention: "critical" }],
    },
    effectiveDetailActions: {
      [proposalId]: [{ action: "apply-proposal" }],
    },
  };
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), harness(), () => ({
    async read() { return failedProjection; },
  })));

  await store.refresh();
  assert.deepEqual(store.getSnapshot().projection.effectiveDetailActions[proposalId], []);
  await assert.rejects(
    store.submitDecision({ proposalId, newState: "approved" }),
    /decision-not-authorized-by-current-projection/u,
  );
  store.dispose();
});

test("setup semantics cover missing permissions and provider without ambiguous readiness", () => {
  for (const blocker of [
    { code: "provider", summary: "Background analysis has no usable provider.", destination: "settings" },
    { code: "observation-consent", summary: "Saved structured patterns are not allowed.", destination: "settings" },
  ]) {
    const snapshot = modelSnapshot({ dashboard: dashboard({
      automation: { state: "setup-required", reason: "setup-required" },
      blockers: [blocker],
    }) });
    const sidebar = deriveSidebarCard(snapshot);
    assert.equal(sidebar.summary, "Setup needed");
    assert.equal(sidebar.destination.section, "settings");
    assert.doesNotMatch(JSON.stringify(sidebar), /Auto · Ready/u);
  }
});

test("sidebar indicator remains visible during startup and old-server fallback is explicit", () => {
  const startup = deriveSidebarCard({ phase: "loading", pending: [], projection: null });
  assert.equal(startup.summary, "Starting Self-evolve");
  assert.equal(startup.destination.section, "home");
  assert.equal(startup.limited, true);
  const oldServer = deriveSidebarCard(modelSnapshot({ dashboard: null }));
  assert.equal(oldServer.summary, "Limited view");
  assert.match(oldServer.detail, /aligned server/u);
  assert.equal(oldServer.limited, true);
  const malformed = deriveSidebarCard(modelSnapshot({ dashboard: null, dashboardError: "dashboard-hash-mismatch" }));
  assert.equal(malformed.summary, "Limited view");
  assert.match(malformed.detail, /could not be validated/u);
});

test("Off sidebar entry opens the binary control in Settings", () => {
  const snapshot = modelSnapshot({ dashboard: dashboard({
    automation: { state: "off", reason: "automatic-recommendations-off" },
    settings: { ...dashboard().settings, automaticRecommendationsEnabled: false },
  }) });
  const operational = deriveOperationalView(snapshot);
  const sidebar = deriveSidebarCard(snapshot);
  assert.deepEqual(operational.destination, { section: "settings", anchor: "automatic-recommendations" });
  assert.deepEqual(sidebar.destination, operational.destination);
  assert.equal(sidebar.action, "Open Settings");
});

test("every published blocker round-trips through one closed exact destination contract", () => {
  for (const [code, contract] of Object.entries(UI_DASHBOARD_BLOCKER_DESTINATIONS)) {
    const value = modelSnapshot({ dashboard: dashboard({
      automation: { state: "setup-required", reason: code },
      blockers: [{ code, summary: `Resolve ${code}.`, destination: contract.dashboard }],
    }) });
    const blocker = buildHomeModel(value).blockers[0];
    assert.deepEqual(blocker.destination, {
      section: contract.section,
      ...(contract.filter ? { filter: contract.filter } : {}),
      ...(contract.anchor ? { anchor: contract.anchor } : {}),
    }, code);
    const params = controlCenterRouteParams(blocker.destination, value);
    assert.deepEqual(parseControlCenterDestination(params, value), blocker.destination, code);
  }
  const firstRun = UI_DASHBOARD_BLOCKER_DESTINATIONS["first-run"];
  assert.deepEqual(firstRun, {
    dashboard: "settings",
    section: "settings",
    anchor: "automatic-recommendations",
  });
});

test("applied attention supports multiple local acknowledgements while Activity history remains", () => {
  const reviews = [
    { proposalId: "proposal-one", state: "applied", target: "one/SKILL.md", attention: "normal", updatedAt: 900, detailHash: "a".repeat(64) },
    { proposalId: "proposal-two", state: "applied", target: "two/SKILL.md", attention: "normal", updatedAt: 800, detailHash: "b".repeat(64) },
  ];
  const activity = reviews.map((review, index) => ({
    id: `${index + 1}`.repeat(64),
    category: "recommendation",
    audience: "default",
    outcome: "applied",
    summary: "A verified recommendation was applied.",
    occurredAt: 900 - index,
    proposalId: review.proposalId,
    reason: null,
  }));
  const value = dashboard({ activity });
  const binding = (index) => ({
    scope: "project",
    subjectId: reviews[index].proposalId,
    version: reviews[index].detailHash,
    auditIds: [activity[index].id],
    acknowledgedAt: 1_000 + index,
  });
  const oneAcknowledged = modelSnapshot({ dashboard: value, reviews, acknowledgedOutcomes: [binding(0)] });
  assert.equal(deriveOperationalView(oneAcknowledged).count, 1);
  const allAcknowledged = modelSnapshot({
    dashboard: value,
    reviews,
    acknowledgedOutcomes: [binding(0), binding(1)],
  });
  assert.equal(deriveOperationalView(allAcknowledged).state, "ready");
  assert.equal(buildActivityModel(allAcknowledged).activity.length, 2);
  const staleVersion = modelSnapshot({
    dashboard: value,
    reviews: [{ ...reviews[0], detailHash: "c".repeat(64) }],
    acknowledgedOutcomes: [binding(0)],
  });
  assert.equal(deriveOperationalView(staleVersion).state, "applied", "an old detail version cannot suppress a new outcome");
  const staleAudit = modelSnapshot({
    dashboard: dashboard({ activity: [{ ...activity[0], id: "9".repeat(64) }] }),
    reviews: [reviews[0]],
    acknowledgedOutcomes: [binding(0)],
  });
  assert.equal(deriveOperationalView(staleAudit).state, "applied", "an unrelated audit cannot suppress the current outcome");

  const partiallyProjected = modelSnapshot({
    dashboard: dashboard({ activity: [activity[0]] }),
    reviews,
    acknowledgedOutcomes: [binding(0)],
  });
  const remaining = deriveOperationalView(partiallyProjected);
  assert.equal(remaining.state, "applied");
  assert.equal(remaining.count, 1);
  assert.equal(remaining.destination.selectedIndex, 1);
});

test("control center model exposes exactly four sections and remains available when degraded", () => {
  const degraded = buildControlCenterModel({ phase: "error", error: "projection unavailable", projection: null });
  assert.deepEqual(Object.keys(degraded.sections), CONTROL_CENTER_SECTIONS);
  assert.equal(degraded.sections.home.operational.state, "corrupt");
  assert.equal(degraded.sections.activity.limited, true);
  const healthy = buildControlCenterModel(modelSnapshot());
  assert.deepEqual(Object.keys(healthy.sections), ["home", "recommendations", "activity", "settings"]);
  assert.equal(healthy.sections.home.operational.state, "ready");
  assert.equal(healthy.sections.settings.automaticRecommendations.enabled, true);
  assert.equal(Object.isFrozen(healthy.sections), true);
});

test("error and expired snapshots retain bounded stale context but remove every projected action", () => {
  const proposalId = "stale-proposal";
  const snapshot = modelSnapshot({
    phase: "error",
    reviews: [{ proposalId, state: "pending", target: "stale/SKILL.md", attention: "normal", updatedAt: 900 }],
  });
  snapshot.stale = true;
  snapshot.error = `expired-projection:${"x".repeat(400)}`;
  snapshot.pending = [{ requestId: "pending-request", kind: "decision", action: "apply-proposal", submittedAt: 800 }];
  snapshot.projection.effectiveIndexActions = [
    { action: "set-automatic-recommendations" },
    { action: "set-kill-switch" },
    { action: "export-data" },
  ];
  snapshot.projection.effectiveDetailActions = {
    [proposalId]: [{ action: "apply-proposal" }, { action: "reject-proposal" }],
  };

  const model = buildControlCenterModel(snapshot);
  assert.equal(model.recovery.stale, true);
  assert.equal(model.recovery.canRetry, true);
  assert.equal(model.recovery.diagnostic.length, 240);
  assert.equal(model.sections.recommendations.queue.length, 1, "stale recommendation context remains readable");
  assert.deepEqual(model.sections.recommendations.selected.actions, []);
  assert.deepEqual(model.sections.settings.controls, {
    automaticRecommendations: false,
    consent: false,
    projectInclusion: false,
    approvedSkillFolders: false,
    emergencyStop: false,
  });
  assert.deepEqual(model.sections.settings.maintenance, {
    scopes: model.sections.settings.maintenance.scopes,
    canExport: false,
    canDeleteScope: false,
    canDeleteAll: false,
  });
  assert.equal(snapshot.pending.length, 1, "pending status remains read-only context");
});

test("control-center route parameters are bounded, project-current, and round-trip sidebar destinations", () => {
  const reviews = [
    { proposalId: "proposal-one", state: "pending" },
    { proposalId: "proposal-two", state: "applied" },
  ];
  const snapshot = modelSnapshot({ reviews });
  const recommendation = controlCenterRouteParams({ section: "recommendations", selectedIndex: 1 }, snapshot);
  assert.deepEqual(recommendation, { section: "recommendations", recommendation: "proposal-two" });
  assert.deepEqual(parseControlCenterDestination(recommendation, snapshot), {
    section: "recommendations",
    selectedIndex: 1,
  });
  assert.deepEqual(parseControlCenterDestination({
    section: "activity",
    activityFilter: "errors",
  }, snapshot), { section: "activity", filter: "errors" });
  assert.deepEqual(parseControlCenterDestination({
    section: "settings",
    settingsAnchor: "provider",
  }, snapshot), { section: "settings", anchor: "provider" });
  for (const invalid of [
    { section: "overview" },
    { section: "recommendations", recommendation: "stale-or-cross-project" },
    { section: "activity", activityFilter: "raw-logs" },
    { section: "settings", settingsAnchor: "arbitrary" },
    { section: "home", extra: true },
    "home",
  ]) assert.deepEqual(parseControlCenterDestination(invalid, snapshot), { section: "home" });
});

test("native renderer binds the four-section shell, deep links, granted header controls, and narrow wrapping", () => {
  const source = fs.readFileSync(new URL("../self-evolve-tui.tsx", import.meta.url), "utf8");
  for (const required of [
    "CONTROL_CENTER_SECTIONS",
    "parseControlCenterDestination",
    "controlCenterRouteParams",
    "setSettingsAnchor",
    "<Show when={settingsAnchor()}>",
    "Opened at {anchor().replaceAll",
    'section: "home"',
    'section() === "recommendations"',
    'section() === "activity"',
    'section() === "settings"',
    "settings().controls.automaticRecommendations",
    "settings().controls.emergencyStop",
    'flexWrap="wrap"',
    '["all", "All"]',
    '["recommendations", "Recommendations"]',
    '["system", "System"]',
    '["errors", "Errors"]',
    "relativeTime(entry.occurredAt)",
    "Open recommendation",
    "Diagnostics",
    "overflowMessage",
    "Automatic recommendations",
    "Approved global skill folders",
    "Turning Off does not purge retained data or remove existing recommendations and actions",
    "confirmation() === confirmationKey",
    "automatic-recommendations",
    "Review consent for",
    "Confirm allow",
    "Cancel consent change",
    "globalRootPolicyConfirmation",
    "replace-global-root-policy",
    "EXPORT SENSITIVE SELF-EVOLVE DATA",
    "PURGE ALL SELF-EVOLVE 0.4.0",
    "Actual:",
    "Configured limit:",
    "set-repo-excluded",
    "isActivationKey",
    "cmd: closeControlCenter",
    "openControlCenter(card.destination)",
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /submitControl\("update-allowlist"/u);
  assert.doesNotMatch(source, /ENABLE YOLO|Apply automatically expands write authority/u);
  assert.doesNotMatch(source, /const names = \["overview"|"Health \/ Budgets"|openReview\(\)\s*$/mu);
  assert.doesNotMatch(source, />Help<|>Safety<|>Maintenance<\/text>\s*<\/box>\s*<\/Show>/u);
  assert.doesNotMatch(source, /ReviewDialog|REVIEW_DIALOG_ID|api\.ui\.dialog\.replace/u);
  assert.doesNotMatch(source, /api\.ui\.toast|api\.attention\.notify/u);
  assert.match(source, /submitOperation\("set-automatic-recommendations", \{ enabled:/u);
  assert.doesNotMatch(source, /submitControl\("set-mode"|set-paused|set-repo-mode/u);
  assert.match(source, /entry\.enabled\s*\?\s*actionButton\([\s\S]*enabled: false[\s\S]*:\s*localActionButton\([\s\S]*Review consent for/u);
});

test("section models are pure, immutable, human-labeled, and share Home/sidebar operational state", () => {
  const proposalId = "private-proposal-id";
  const hash = "f".repeat(64);
  const review = {
    proposalId,
    state: "pending",
    target: "review/SKILL.md",
    attention: "normal",
    updatedAt: 900,
  };
  const snapshot = modelSnapshot({
    reviews: [review],
    dashboard: dashboard({
      lastCycle: {
        outcome: "recommendation-created",
        triggerClass: "idle",
        observationCount: 3,
        eligibilityCount: 1,
        proposalId,
        occurredAt: 900,
        reason: null,
      },
      activity: [
        {
          id: "a".repeat(64),
          category: "cycle",
          audience: "default",
          outcome: "recommendation-created",
          summary: "A bounded recommendation is ready.",
          occurredAt: 900,
          proposalId,
          reason: null,
        },
        {
          id: "b".repeat(64),
          category: "error",
          audience: "diagnostic",
          outcome: "failed",
          summary: "A bounded operation failed.",
          occurredAt: 800,
          proposalId: null,
          reason: "operation-failed",
        },
      ],
    }),
  });
  snapshot.dashboard.settings.collectionSuggestions = ["/private/canonical/root"];
  snapshot.projection.details = [{
    proposalId,
    summary: {
      state: "pending",
      target: { relativePath: "review/SKILL.md", currentHash: hash, proposedContentHash: "e".repeat(64) },
      effectiveMode: "auto",
      rationale: "Repeated bounded evidence supports this improvement.",
      risk: "low",
      criticScoreBasisPoints: 9_500,
      criticPassed: true,
      validDeterministic: true,
      injectionFlagged: false,
      tokenImpact: { estimatedTokens: 10, budgetTokens: 100 },
      eligibility: { eligible: true, reasons: ["thresholds-met"], checks: [] },
      rollback: { eligible: false, reason: "not-applied", appliedHash: hash },
      operation: { status: "completed", requestId: "private-request-id", reason: null, updatedAt: 900 },
    },
    diff: { kind: "unified", lines: ["-old", "+new"], overflow: null },
    evidence: [{ id: "private-evidence-id", kind: "receipt", summary: "Bounded evidence", occurredAt: 700, redacted: true }],
    audit: [{ id: hash, kind: "decision", summary: "Recommendation created", timestamp: 800 }],
  }];
  snapshot.projection.effectiveDetailActions = {
    [proposalId]: [
      { action: "apply-proposal", capability: "legacy-decision-v1" },
      { action: "reject-proposal", capability: "legacy-decision-v1" },
    ],
  };

  const home = buildHomeModel(snapshot);
  const recommendations = buildRecommendationsModel(snapshot);
  const activity = buildActivityModel(snapshot);
  const errors = buildActivityModel(snapshot, { filter: "errors" });
  const settings = buildSettingsModel(snapshot);
  assert.deepEqual(home.operational, deriveOperationalView(snapshot));
  assert.deepEqual(home.operational.destination, deriveSidebarCard(snapshot).destination);
  assert.equal(home.recentActivity.length, 1);
  assert.equal(recommendations.queue.length, 1);
  assert.equal(recommendations.queue[0].target, "review");
  assert.equal(recommendations.selected.actions[0].label, "Apply Proposal");
  assert.equal(recommendations.selected.actions[1].feedbackSupported, true);
  assert.equal(activity.activity.length, 1, "diagnostic entries are excluded from All");
  assert.equal(errors.activity.length, 1);
  assert.equal(settings.automaticRecommendations.enabled, true);
  assert.equal(settings.consent[0].label, "Saved structured patterns");
  assert.equal(settings.approvedSkillFolderCount, null);
  assert.deepEqual(settings.collectionSuggestions, ["/private/canonical/root"]);
  for (const model of [home, recommendations, activity, errors]) {
    assert.equal(Object.isFrozen(model), true);
    assert.doesNotMatch(
      JSON.stringify(model),
      /private-proposal-id|private-request-id|private-evidence-id|\/private\/canonical\/root|f{64}|e{64}/u,
    );
  }
  assert.equal(Object.isFrozen(settings), true);
  assert.deepEqual(settings.approvedSkillFolders, []);
  assert.doesNotMatch(
    JSON.stringify({ ...settings, approvedSkillFolders: [], collectionSuggestions: [] }),
    /private-proposal-id|private-request-id|private-evidence-id|\/private\/canonical\/root|f{64}|e{64}/u,
  );
});

test("Activity filters semantic history, deep-links safely, bounds diagnostics, and explains limited peers", () => {
  const proposalId = "proposal-activity";
  const snapshot = modelSnapshot({
    reviews: [{
      proposalId,
      state: "pending",
      target: "private/parent/review-helper/SKILL.md",
      attention: "normal",
      updatedAt: 900,
    }],
    dashboard: dashboard({
      nextEligibleAt: 2_000,
      activity: [
        {
          id: "a".repeat(64),
          category: "recommendation",
          audience: "default",
          outcome: "recommendation-approved",
          summary: "A recommendation was approved for fresh server-side validation.",
          occurredAt: 950,
          proposalId,
          reason: null,
        },
        {
          id: "b".repeat(64),
          category: "cycle",
          audience: "default",
          outcome: "valid-no-change",
          summary: "Analysis completed successfully and found no useful safe change.",
          occurredAt: 900,
          proposalId: null,
          reason: "no-change",
        },
        {
          id: "c".repeat(64),
          category: "error",
          audience: "diagnostic",
          outcome: "failed",
          summary: "Automatic work failed and entered bounded backoff.",
          occurredAt: 850,
          proposalId: null,
          reason: "backoff",
        },
      ],
      overflow: {
        activity: {
          truncated: true,
          includedCount: 3,
          omittedCount: 7,
          omittedBytes: 700,
          reason: "entry-limit",
        },
      },
    }),
  });
  snapshot.runtime = {
    hostVersion: "1.18.3",
    hostVersionSource: "TUI application version",
    pluginVersion: "0.2.0",
    projectionVersion: 1,
    dashboardVersion: 1,
    projectionMode: "native",
  };
  snapshot.watcher = "polling";
  snapshot.watcherError = "/private/watch/root: permission denied";
  snapshot.projection.index.status.circuitBreakerOpen = false;

  const all = buildActivityModel(snapshot);
  const recommendations = buildActivityModel(snapshot, { filter: "recommendations" });
  const system = buildActivityModel(snapshot, { filter: "system" });
  const errors = buildActivityModel(snapshot, { filter: "errors" });
  assert.deepEqual(all.activity.map((entry) => entry.outcome), [
    "recommendation-approved",
    "valid-no-change",
  ]);
  assert.deepEqual(recommendations.activity.map((entry) => entry.outcome), ["recommendation-approved"]);
  assert.deepEqual(system.activity.map((entry) => entry.outcome), ["valid-no-change"]);
  assert.deepEqual(errors.activity.map((entry) => entry.outcome), ["failed"]);
  assert.equal(recommendations.activity[0].target, "review helper");
  assert.deepEqual(recommendations.activity[0].destination, {
    section: "recommendations",
    selectedIndex: 0,
  });
  assert.equal(all.overflowMessage,
    "7 older entries were omitted by the bounded projection. Use Sensitive export in Settings for complete classified records.");
  assert.equal(all.diagnostics.watcherStatus, "Polling fallback active");
  assert.equal(all.diagnostics.breakerStatus, "Closed");
  assert.equal(all.diagnostics.nextEligibleAt, 2_000);
  assert.deepEqual(all.diagnostics.budgetResetAt, {
    provider: 2_000,
    synthesis: 3_000,
  });
  assert.equal(all.diagnostics.runtime.pluginVersion, "0.2.0");
  assert.equal(errors.diagnostics.lastError.summary, "Automatic work failed and entered bounded backoff.");
  for (const model of [all, recommendations, system, errors]) {
    assert.doesNotMatch(
      JSON.stringify(model),
      /private\/parent|private\/watch|[a-c]{64}|proposal-activity/u,
    );
  }

  const limited = buildActivityModel(modelSnapshot({ dashboard: null }));
  assert.equal(limited.limited, true);
  assert.equal(limited.activity.length, 0);
  assert.match(limited.emptyState, /aligned server/u);
  assert.equal(limited.diagnostics.enhancedProjection, "unavailable");
});

test("Settings exposes binary automation, project participation, permissions, limits, and maintenance", () => {
  const value = dashboard({
    dashboardVersion: 2,
    retention: { observationsDays: 10, operationalDays: 30 },
  });
  const snapshot = modelSnapshot({ dashboard: value });
  snapshot.dashboard.settings.collectionSuggestions = ["/approved/skills"];
  snapshot.inspection = {
    observations: [{}, {}],
    eligibility: [],
    overflow: { observations: 3, eligibility: 0 },
  };
  snapshot.runtime = {
    hostVersion: "1.18.3",
    pluginVersion: "0.2.0",
    projectionVersion: 1,
    dashboardVersion: 1,
  };
  snapshot.latestExport = {
    scope: "project",
    path: "/private/self-evolve/export.json",
    bytes: 321,
    sha256: "a".repeat(64),
    expiresAt: 5_000,
  };
  snapshot.projection.effectiveIndexActions = [
    { action: "export-data" },
    { action: "purge-scope" },
    { action: "purge-all" },
    { action: "set-automatic-recommendations" },
    { action: "set-permission" },
    { action: "set-repo-excluded" },
  ];

  const settings = buildSettingsModel(snapshot);
  assert.equal(settings.controls.automaticRecommendations, true);
  assert.equal(settings.controls.projectInclusion, true);
  assert.equal(settings.controls.consent, true);
  assert.equal(settings.automaticRecommendations.enabled, true);
  assert.equal(settings.approvedSkillFolderRequiresNonEmpty, false);
  assert.deepEqual(settings.approvedSkillFolders, []);
  assert.deepEqual(settings.collectionSuggestions, ["/approved/skills"]);
  assert.match(settings.approvedSkillFolderWarning, /grant no write authority/u);
  assert.deepEqual(settings.consent.map((entry) => entry.label), [
    "Saved structured patterns",
    "Sanitized evidence excerpts",
    "Cross-project learning (limited)",
  ]);
  assert.equal(settings.consent.find((entry) => entry.key === "crossRepoAggregation").canEnable, false);
  assert.match(settings.limits.find((limit) => limit.key === "provider").actual, /1 used; 2 remaining/u);
  assert.match(settings.limits.find((limit) => limit.key === "provider").configured, /3 per rolling hour/u);
  assert.match(settings.limits.find((limit) => limit.key === "retention").actual, /5 retained observations/u);
  assert.equal(
    settings.limits.find((limit) => limit.key === "retention").configured,
    "10 days for observations; 30 days for operational records",
  );
  assert.deepEqual(settings.retention, { observationsDays: 10, operationalDays: 30 });
  assert.match(settings.limits.find((limit) => limit.key === "concurrency").configured, /1 observation/u);
  assert.deepEqual(settings.maintenance, {
    scopes: [
      { value: "observations", label: "Observations", explanation: "Bounded structured patterns for this project." },
      { value: "global-recommendations", label: "Recommendations", explanation: "Global recommendation, support, decision, and rollback records." },
      { value: "project", label: "This project", explanation: "All Self-evolve state in this project partition." },
      { value: "all", label: "Everything", explanation: "All Self-evolve project partitions and authority. Restart is required." },
    ],
    canExport: true,
    canDeleteScope: true,
    canDeleteAll: true,
  });
  assert.equal(settings.latestExport.path, "/private/self-evolve/export.json");
  assert.equal(settings.footer.pluginVersion, "0.2.0");
  assert.equal(Object.isFrozen(settings.limits), true);
  const exactRootSnapshot = structuredClone(snapshot);
  exactRootSnapshot.dashboard.settings.globalRootPolicy = {
    roots: [
      { canonicalPath: "/global/update", canUpdate: true, canCreate: false },
      { canonicalPath: "/global/create", canUpdate: true, canCreate: true },
    ],
    creationRootPath: "/global/create",
    rootSetHash: "3".repeat(64),
    updatedAt: 900,
  };
  exactRootSnapshot.dashboard.settings.globalRootPolicyAction = {
    action: "replace-global-root-policy",
    capability: "operation-global-root-policy-v1",
    nonce: "root-policy-nonce",
    expiresAt: 10_000,
  };
  exactRootSnapshot.projection.effectiveIndexActions.push(exactRootSnapshot.dashboard.settings.globalRootPolicyAction);
  const exactRoots = buildSettingsModel(exactRootSnapshot);
  assert.deepEqual(exactRoots.globalRoots, [
    { canonicalPath: "/global/update", canUpdate: true, canCreate: false, primaryCreationRoot: false },
    { canonicalPath: "/global/create", canUpdate: true, canCreate: true, primaryCreationRoot: true },
  ]);
  assert.equal(exactRoots.creationRootConfigured, true);
  assert.deepEqual(exactRoots.collectionSuggestions, []);
  assert.equal(exactRoots.controls.approvedSkillFolders, true);
  const oldTuiPeer = modelSnapshot();
  oldTuiPeer.projection.operationProtocolVersion = 1;
  assert.equal(buildSettingsModel(oldTuiPeer).controls.automaticRecommendations, false,
    "a legacy peer remains read-only");

  const blockedSnapshot = modelSnapshot({
    dashboard: dashboard({
      rollout: { ...value.rollout, ready: false, synthesesObserved: 2 },
      settings: {
        ...value.settings,
        consent: { ...value.settings.consent, sanitizedExcerpts: false },
      },
    }),
  });
  const blocked = buildSettingsModel(blockedSnapshot);
  assert.equal(blocked.automaticRecommendations.enabled, true);
  assert.equal(blocked.consent.find((entry) => entry.key === "sanitizedExcerpts").enabled, false);

  assert.deepEqual(validateApprovedSkillFolderInput("/approved/new", ["/approved/skills"]), {
    ok: true,
    value: "/approved/new",
    error: null,
    warning: "The server will revalidate existence, canonical identity, symlinks, and supported-root policy before saving.",
  });
  assert.match(validateApprovedSkillFolderInput("relative", []).error, /canonical absolute/u);
  assert.match(validateApprovedSkillFolderInput("/approved/skills", ["/approved/skills"]).error, /already listed/u);
  assert.match(validateApprovedSkillFolderInput("/approved/../escape", []).error, /canonical absolute/u);
});

test("Home distinguishes valid no-change, still learning, automation Off, and no-activity empty states", () => {
  const make = (lastCycle, settings = dashboard().settings, automation = { state: "ready", reason: null }) => buildHomeModel(modelSnapshot({
    dashboard: dashboard({ lastCycle, settings, automation }),
  })).emptyState;
  assert.equal(make({
    outcome: "valid-no-change", triggerClass: "idle",
    observationCount: 1, eligibilityCount: 1, proposalId: null, occurredAt: 900, reason: "no-change",
  }).heading, "No useful change found");
  assert.equal(make({
    outcome: "not-eligible", triggerClass: "idle",
    observationCount: 1, eligibilityCount: 0, proposalId: null, occurredAt: 900, reason: "insufficient-evidence",
  }).heading, "Still learning");
  assert.equal(make(null, {
    ...dashboard().settings,
    automaticRecommendationsEnabled: false,
  }, { state: "off", reason: "automatic-recommendations-off" }).heading, "Automatic recommendations are off");
  assert.equal(make(null).heading, "No activity yet");
});

test("Home exposes Off guidance and labels unavailable cross-project learning honestly", () => {
  const value = dashboard();
  const freshDashboard = dashboard({
    automation: { state: "off", reason: "automatic-recommendations-off" },
    blockers: [{
      code: "automatic-recommendations-off",
      summary: "Automatic recommendations are off.",
      destination: "settings",
    }],
    settings: {
      ...value.settings,
      automaticRecommendationsEnabled: false,
      consent: {
        durableObservations: true,
        sanitizedExcerpts: true,
        crossRepoAggregation: true,
      },
    },
  });
  const snapshot = modelSnapshot({ dashboard: freshDashboard });
  const home = buildHomeModel(snapshot);
  assert.equal(home.operational.destination.section, "settings");
  assert.match(home.operational.explanation, /Existing recommendations remain reviewable/u);
  const settings = buildSettingsModel(snapshot);
  assert.equal(home.blockers[0].destination.section, "settings");
  const crossProject = settings.consent.find((entry) => entry.key === "crossRepoAggregation");
  assert.equal(crossProject.label, "Cross-project learning (limited)");
  assert.equal(crossProject.canEnable, false);
  assert.match(crossProject.description, /identity-free bounded support/u);
});

test("Recommendations filters the full lifecycle and uses legacy rejection when feedback is not advertised", () => {
  const reviews = [
    { proposalId: "pending-one", state: "pending", target: "alpha/SKILL.md", attention: "normal", updatedAt: 4 },
    { proposalId: "applied-one", state: "applied", target: "beta/SKILL.md", attention: "normal", updatedAt: 3 },
    { proposalId: "rejected-one", state: "rejected", target: "gamma/SKILL.md", attention: "normal", updatedAt: 2 },
    { proposalId: "superseded-one", state: "superseded", target: "delta/SKILL.md", attention: "normal", updatedAt: 1 },
  ];
  const snapshot = modelSnapshot({ reviews });
  snapshot.projection.effectiveDetailActions = {
    "pending-one": [{ action: "reject-proposal", capability: "legacy-decision-v1" }],
  };
  assert.deepEqual(buildRecommendationsModel(snapshot).queue.map((item) => item.state), ["pending"]);
  assert.deepEqual(buildRecommendationsModel(snapshot, { filter: "applied" }).queue.map((item) => item.state), ["applied"]);
  assert.deepEqual(buildRecommendationsModel(snapshot, { filter: "dismissed" }).queue.map((item) => item.state), ["rejected", "superseded"]);
  assert.equal(buildRecommendationsModel(snapshot, { filter: "all" }).queue.length, 4);
  assert.equal(buildRecommendationsModel(snapshot).selected.actions[0].feedbackSupported, true);
  snapshot.dashboard.capabilities = ["control-repo-mode-v1"];
  assert.equal(buildRecommendationsModel(snapshot).selected.actions[0].feedbackSupported, false);
  assert.equal(buildRecommendationsModel(snapshot, { filter: "unknown" }).filter, "needs-review");
});

test("global Recommendations exposes privacy-safe queue detail, participation, exact grants, and mounted outcomes", () => {
  const recommendationId = "1".repeat(64);
  const projectFingerprint = "2".repeat(64);
  const otherProjectFingerprint = "3".repeat(64);
  const supportSetHash = "4".repeat(64);
  const snapshot = modelSnapshot();
  snapshot.projectFingerprint = projectFingerprint;
  snapshot.stateRootIdentity = "5".repeat(64);
  snapshot.projection.index.projectFingerprint = projectFingerprint;
  snapshot.projection.index.stateRootIdentity = snapshot.stateRootIdentity;
  snapshot.tuiHealth = {
    projectFingerprint,
    stateRootIdentity: snapshot.stateRootIdentity,
    expiresAt: 10_000,
  };
  snapshot.participation = { [recommendationId]: true };
  snapshot.global = {
    phase: "ready",
    stateRootIdentity: "5".repeat(64),
    pending: [{
      requestId: "pending-global-apply",
      kind: "global-action",
      action: "apply",
      subject: recommendationId,
      submittedAt: 950,
      expiresAt: 2_000,
    }],
    responses: [{
      requestId: "failed-global-reject",
      kind: "global-action",
      action: "reject",
      subject: recommendationId,
      submittedAt: 800,
      expiresAt: 900,
      response: { ok: false, status: "rejected", processedAt: 850, reason: "stale-global-generation" },
    }],
    projection: {
      mode: "native",
      label: "authoritative-global-v1",
      operationProtocolVersion: 1,
      capabilities: ["project-participation-v1"],
      indexBytes: "byte-identical-global-index",
      index: {
        recommendations: [{
          recommendationId,
          recommendationVersion: 1,
          supportSetHash,
          state: "pending",
          target: { kind: "new-global-skill", label: "shared-review" },
          support: { tier: "distributed", independentDomainCount: 2, independentIncidentCount: 3, occurrenceCount: 7 },
          dates: { firstSeenDay: "2026-08-01", lastSeenDay: "2026-08-11", synthesizedAt: 700, updatedAt: 900 },
          safety: { criticScoreBasisPoints: 9_750, criticPassed: true, validDeterministic: true },
          availableActions: ["apply", "reject"],
          detailHash: "6".repeat(64),
        }],
      },
      details: [{
        recommendationId,
        recommendationVersion: 1,
        detailHash: "6".repeat(64),
        priorState: "pending",
        target: { kind: "new-global-skill", label: "shared-review" },
        support: {
          tier: "distributed",
          independentDomainCount: 2,
          independentIncidentCount: 3,
          occurrenceCount: 7,
          firstSeenDay: "2026-08-01",
          lastSeenDay: "2026-08-11",
        },
        safety: { criticScoreBasisPoints: 9_750, criticPassed: true, validDeterministic: true },
        generality: { passed: true, basis: "deterministic-generality-gate-v1" },
        rationale: "Independent identity-free support warrants one bounded global skill.",
        diff: { kind: "new-file", lines: ["+# Shared review", "+Bounded content."], overflow: { truncated: false } },
        evidenceSummary: [
          { kind: "independent-domains", count: 2 },
          { kind: "independent-incidents", count: 3 },
          { kind: "occurrences", count: 7 },
        ],
        availableActions: ["apply", "reject"],
      }],
      grants: [
        { recommendationId, action: "apply", grantHash: "7".repeat(64) },
        { recommendationId, action: "reject", grantHash: "8".repeat(64) },
      ],
    },
  };

  const recommendations = buildRecommendationsModel(snapshot);
  assert.equal(recommendations.protocolLabel, "authoritative-global-v1");
  assert.deepEqual(recommendations.queue.map((entry) => [entry.targetKind, entry.supportTier]), [
    ["new-global-skill", "distributed"],
  ]);
  assert.equal(recommendations.selected.summary.currentProjectContributed, true);
  assert.equal(recommendations.selected.summary.support.independentDomainCount, 2);
  assert.equal(recommendations.selected.summary.support.independentIncidentCount, 3);
  assert.equal(recommendations.selected.summary.support.occurrenceCount, 7);
  assert.equal(recommendations.selected.summary.criticScoreBasisPoints, 9_750);
  assert.deepEqual(recommendations.selected.summary.generality, {
    available: true,
    passed: true,
    basis: "deterministic-generality-gate-v1",
    status: "Passed",
    explanation: "Passed the deterministic generality gate.",
  });
  assert.equal(recommendations.selected.summary.tokenImpact.available, false);
  assert.deepEqual(recommendations.selected.actions.map((entry) => [entry.action, entry.pending]), [
    ["apply", true],
    ["reject", false],
  ]);
  assert.deepEqual(recommendations.selected.diff.lines, ["+# Shared review", "+Bounded content."]);
  assert.equal(recommendations.selected.audit.length, 1, "failed terminal response remains mounted");
  const activity = buildActivityModel(snapshot);
  assert.deepEqual(activity.activity.slice(0, 2).map((entry) => entry.scope), ["Global", "Global"]);
  assert.match(activity.activity[0].summary, /pending fresh global validation/u);
  assert.match(activity.activity[1].summary, /stale-global-generation/u);
  assert.equal(activity.activity[1].acknowledgementRequestId, "failed-global-reject");
  assert.equal(deriveOperationalView(snapshot).state, "failure");
  snapshot.acknowledgedOutcomes = [{
    scope: "global",
    subjectId: "failed-global-reject",
    version: "rejected:850:failed-global-reject",
    auditIds: ["failed-global-reject"],
    acknowledgedAt: 1_000,
  }];
  assert.equal(buildActivityModel(snapshot).activity[1].acknowledgementRequestId, null);
  assert.equal(deriveOperationalView(snapshot).state, "recommendation");
  const longFailure = structuredClone(snapshot);
  longFailure.acknowledgedOutcomes = [];
  longFailure.global.responses[0].response.reason = "failure-detail-".repeat(30);
  assert.match(buildActivityModel(longFailure).activity[1].summary, /\[truncated\]\.$/u);
  assert.equal(buildHomeModel(snapshot).globalReadiness.recommendationCount, 1);
  assert.doesNotMatch(
    JSON.stringify({ recommendations, activity }),
    new RegExp(`${recommendationId}|${supportSetHash}|${projectFingerprint}|${otherProjectFingerprint}|contributor|excerpt`, "u"),
  );
  const staleActingHealth = structuredClone(snapshot);
  staleActingHealth.tuiHealth.expiresAt = staleActingHealth.updatedAt;
  assert.deepEqual(buildRecommendationsModel(staleActingHealth).selected.actions, []);
  const mismatchedProjection = structuredClone(snapshot);
  mismatchedProjection.projection.index.projectFingerprint = otherProjectFingerprint;
  assert.deepEqual(buildRecommendationsModel(mismatchedProjection).selected.actions, []);

  const applied = structuredClone(snapshot);
  applied.global.pending = [];
  applied.global.projection.index.recommendations[0].state = "applied";
  applied.global.projection.index.recommendations[0].availableActions = ["undo"];
  applied.global.projection.details[0].priorState = "applied";
  applied.global.projection.details[0].availableActions = ["undo"];
  applied.global.projection.grants = [{ recommendationId, action: "undo", grantHash: "9".repeat(64) }];
  assert.deepEqual(buildRecommendationsModel(applied, { filter: "applied" }).selected.actions.map((entry) => entry.action), [
    "undo",
    "acknowledge-audit",
  ]);
  applied.acknowledgedOutcomes = [...snapshot.acknowledgedOutcomes, {
    scope: "global",
    subjectId: recommendationId,
    version: `1:${"6".repeat(64)}`,
    auditIds: ["6".repeat(64)],
    acknowledgedAt: 1_000,
  }];
  assert.deepEqual(buildRecommendationsModel(applied, { filter: "applied" }).selected.actions.map((entry) => entry.action), ["undo"]);
  assert.equal(deriveOperationalView(applied).state, "ready");

  const stale = structuredClone(snapshot);
  stale.global.phase = "error";
  stale.global.stale = true;
  stale.global.error = "expired-global-projection";
  stale.global.projection.grants = [];
  assert.deepEqual(buildRecommendationsModel(stale).selected.actions, []);
  const limited = structuredClone(snapshot);
  limited.global.phase = "limited";
  limited.global.projection.mode = "limited";
  limited.global.projection.grants = [];
  assert.deepEqual(buildRecommendationsModel(limited).selected.actions, []);
  assert.equal(buildSettingsModel(limited).globalProtocol.authoritative, false);
  assert.equal(buildSettingsModel(limited).controls.automaticRecommendations, false);
});

test("sidebar binary model exposes only fresh operation authority", () => {
  const snapshot = modelSnapshot();
  snapshot.global = {
    phase: "ready",
    projection: { mode: "native", operationProtocolVersion: 1, label: "authoritative-global-v1" },
    pending: [],
    responses: [],
  };
  snapshot.projection.effectiveIndexActions = [{ action: "set-automatic-recommendations" }];
  assert.deepEqual(deriveSidebarModeControl(snapshot), {
    current: "on",
    pending: false,
    available: true,
    status: "ready",
    options: [
      { value: "off", label: "Off", confirmationRequired: false },
      { value: "on", label: "On", confirmationRequired: true },
    ],
  });
  for (const [status, mutate] of [
    ["pending", (value) => value.pending.push({ action: "set-automatic-recommendations", subject: "automatic-recommendations" })],
    ["stale", (value) => { value.phase = "error"; }],
    ["limited", (value) => { value.global.phase = "limited"; value.global.projection.mode = "limited"; }],
    ["unsupported", (value) => { value.projection.effectiveIndexActions = []; }],
  ]) {
    const value = structuredClone(snapshot);
    mutate(value);
    const model = deriveSidebarModeControl(value);
    assert.equal(model.status, status);
    assert.equal(model.available, false);
  }
});

test("duplicate TUI owners share one project runtime and one global runtime with bounded pollers and watchers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-shared-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  let clients = 0;
  let reads = 0;
  const clientFactory = () => {
    clients += 1;
    return { async read() { reads += 1; return projection(); } };
  };
  const firstApi = apiFor(root, worktree);
  const secondApi = apiFor(root, worktree);
  const first = acquireProjectTuiStore(options(firstApi, scheduler, clientFactory));
  const second = acquireProjectTuiStore(options(secondApi, scheduler, clientFactory));

  await Promise.all([first.refresh(), second.refresh()]);
  assert.equal(__testTuiStore.registrySize(), 1);
  assert.equal(clients, 1);
  assert.equal(reads, 1);
  assert.equal(scheduler.intervals.size, 2);
  assert.equal(scheduler.watchers.length, 2);
  assert.deepEqual(first.getSnapshot(), second.getSnapshot());
  assert.equal(first.getSnapshot().phase, "ready");
  assert.equal(Object.isFrozen(first.getSnapshot()), true);
  assert.equal(Object.isFrozen(first.getSnapshot().projection), true);
  assert.equal(firstApi.lifecycle.count(), 1);
  assert.equal(secondApi.lifecycle.count(), 1);

  first.dispose();
  assert.equal(__testTuiStore.registrySize(), 1);
  assert.equal(scheduler.intervals.size, 2);
  assert.equal(firstApi.lifecycle.count(), 0);
  second.dispose();
  assert.equal(__testTuiStore.registrySize(), 0);
  assert.equal(scheduler.intervals.size, 0);
  assert.equal(scheduler.watchers.every((watcher) => watcher.closed), true);
  assert.equal(firstApi.event.count(), 0);
  assert.equal(secondApi.event.count(), 0);
  assert.equal(secondApi.lifecycle.count(), 0);
});

test("accepted-terminal purge stops every shared state-root runtime and remains inert for later owners and ticks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-terminal-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-terminal-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  let reads = 0;
  let accepted = false;
  const clientFactory = (context) => {
    const grant = {
      action: "purge-all",
      capability: UI_ACTION_CAPABILITIES["purge-all"],
      nonce: "terminal-purge-nonce",
      expiresAt: 10_000,
    };
    return {
      async read() {
        reads += 1;
        return {
          mode: "native",
          projectionVersion: UI_PROJECTION_VERSION,
          operationProtocolVersion: 2,
          index: {
            projectFingerprint: context.projectFingerprint,
            stateRootIdentity: context.stateRootIdentity,
            generation: "a".repeat(64),
            projectionHash: "b".repeat(64),
            capabilities: UI_CAPABILITIES,
            allowedActions: [grant],
          },
          dashboard: dashboard(),
          details: [],
          effectiveIndexActions: [grant],
          effectiveDetailActions: {},
        };
      },
      async submitOperation() { accepted = true; },
      async reconcilePending(entries) {
        if (!accepted) return { pending: entries, responses: [] };
        return {
          pending: [],
          responses: entries.map((entry) => ({
            ...entry,
            response: { ok: true, status: "accepted-terminal", processedAt: 1_101, reason: null },
          })),
        };
      },
    };
  };
  const firstApi = apiFor(root, worktree);
  const first = acquireProjectTuiStore(options(firstApi, scheduler, clientFactory, { now: () => 1_100 }));
  await first.refresh();
  const request = await first.submitOperation("purge-all", { confirmation: "PURGE ALL SELF-EVOLVE 0.4.0" });
  const terminal = first.getSnapshot();
  assert.equal(terminal.phase, "terminal");
  assert.equal(deriveOperationalView(terminal).state, "terminal");
  assert.deepEqual(terminal.pending, []);
  assert.equal(terminal.responses.at(-1).requestId, request.requestId);
  assert.equal(terminal.responses.at(-1).response.status, "accepted-terminal");
  assert.equal(scheduler.intervals.size, 0);
  assert.equal(scheduler.watchers.every((watcher) => watcher.closed), true);

  const readsAtAcceptance = reads;
  scheduler.tick();
  for (const watcher of scheduler.watchers) watcher.callback("change");
  firstApi.event.emit("project.updated");
  await first.refresh();
  assert.equal(reads, readsAtAcceptance);
  await assert.rejects(first.submitControl("set-permission", { permission: "durableObservations", enabled: false }), /restart-required-after-purge-all/u);
  await assert.rejects(first.submitOperation("purge-all", { confirmation: "PURGE ALL SELF-EVOLVE 0.4.0" }), /restart-required-after-purge-all/u);

  const watcherCount = scheduler.watchers.length;
  const secondApi = apiFor(root, worktree);
  const second = acquireProjectTuiStore(options(secondApi, scheduler, clientFactory, { now: () => 1_200 }));
  assert.equal(second.getSnapshot().phase, "terminal");
  await second.refresh();
  assert.equal(reads, readsAtAcceptance);
  assert.equal(scheduler.watchers.length, watcherCount);
  assert.equal(scheduler.intervals.size, 0);
  first.dispose();
  second.dispose();
});

test("project and worktree changes isolate runtimes and rebind on the supported path poll", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-isolation-"));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-project-a-"));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-project-b-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(firstWorktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondWorktree, { recursive: true, force: true }));
  const scheduler = harness();
  const clients = [];
  const clientFactory = (context) => {
    clients.push(context);
    return { async read() { return projection(clients.length === 1 ? "a" : "b"); } };
  };
  const api = apiFor(root, firstWorktree);
  const store = acquireProjectTuiStore(options(api, scheduler, clientFactory));
  await store.refresh();
  const first = store.getSnapshot();

  api.state.path.worktree = secondWorktree;
  api.state.path.directory = secondWorktree;
  scheduler.tick();
  await store.refresh();
  const second = store.getSnapshot();
  assert.notEqual(second.key, first.key);
  assert.notEqual(second.projectFingerprint, first.projectFingerprint);
  assert.equal(second.worktreePath, secondWorktree);
  assert.equal(clients.length, 2);
  assert.equal(__testTuiStore.registrySize(), 1);
  assert.equal(scheduler.watchers[0].closed, true);
  store.dispose();
});

test("project switching preserves one state-root-global queue runtime while replacing project participation and status", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-global-runtime-"));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-global-project-a-"));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-global-project-b-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(firstWorktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondWorktree, { recursive: true, force: true }));
  const scheduler = harness();
  const recommendationId = "1".repeat(64);
  const supportSetHash = "2".repeat(64);
  const generation = "3".repeat(64);
  const indexHash = "4".repeat(64);
  const indexBytes = JSON.stringify({ generation, recommendationId });
  const globalValue = Object.freeze({
    mode: "native",
    label: "authoritative-global-v1",
    bridgeSchemaVersion: 1,
    projectionVersion: 1,
    operationProtocolVersion: 2,
    capabilities: Object.freeze([]),
    reason: null,
    index: Object.freeze({
      stateRootIdentity: "5".repeat(64),
      generation,
      indexHash,
      recommendations: Object.freeze([Object.freeze({
        recommendationId,
        recommendationVersion: 1,
        supportSetHash,
        state: "pending",
        target: Object.freeze({ kind: "existing-global-skill", label: "shared-review" }),
        support: Object.freeze({ tier: "distributed", independentDomainCount: 2, independentIncidentCount: 3, occurrenceCount: 5 }),
        dates: Object.freeze({ firstSeenDay: "2026-08-01", lastSeenDay: "2026-08-11", synthesizedAt: 900, updatedAt: 1_000 }),
        safety: Object.freeze({ criticScoreBasisPoints: 9_500, criticPassed: true, validDeterministic: true }),
        availableActions: Object.freeze(["apply", "reject"]),
        detailHash: "6".repeat(64),
      })]),
    }),
    indexBytes,
    details: Object.freeze([]),
    grants: Object.freeze([]),
  });
  let globalClients = 0;
  const projectContexts = [];
  const api = apiFor(root, firstWorktree);
  const store = acquireProjectTuiStore(options(api, scheduler, (context) => {
    projectContexts.push(context);
    const first = context.worktreePath === firstWorktree;
    return {
      async read() {
        return Object.freeze({
          ...projection(first ? "a" : "b"),
          dashboard: dashboard({
            automation: { state: first ? "excluded" : "ready", reason: first ? "repository-excluded" : null },
            settings: {
              ...dashboard().settings,
              repositoryExcluded: first,
            },
          }),
        });
      },
      async readParticipation() {
        return {
          stateRootIdentity: globalValue.index.stateRootIdentity,
          generation,
          indexHash,
          entries: [{
            recommendationId,
            supportSetHash,
            currentProjectContributed: first,
          }],
        };
      },
      async reconcilePending(entries) { return { pending: entries, responses: [] }; },
    };
  }, {
    globalClientFactory() {
      globalClients += 1;
      return {
        async read() { return globalValue; },
        async reconcilePending(entries) { return { pending: entries, responses: [] }; },
      };
    },
    now: () => 1_100,
  }));

  await store.refresh();
  await store.selectDetails([recommendationId]);
  await store.trackGlobalPending({
    requestId: "global-request",
    kind: "global-action",
    action: "apply",
    subject: recommendationId,
    submittedAt: 1_000,
    expiresAt: 2_000,
  });
  const first = store.getSnapshot();
  assert.equal(first.global.projection.indexBytes, indexBytes);
  assert.equal(first.participation[recommendationId], true);
  assert.equal(first.dashboard.settings.repositoryExcluded, true);
  assert.deepEqual(first.global.selectedRecommendationIds, [recommendationId]);
  assert.equal(first.global.pending.length, 1);

  api.state.path.worktree = secondWorktree;
  api.state.path.directory = secondWorktree;
  api.event.emit("project.updated");
  await store.refresh();
  const second = store.getSnapshot();
  assert.equal(second.global.projection.indexBytes, indexBytes);
  assert.equal(second.global.projection, first.global.projection);
  assert.equal(second.participation[recommendationId], false);
  assert.equal(second.dashboard.settings.repositoryExcluded, false);
  assert.deepEqual(second.global.selectedRecommendationIds, [recommendationId]);
  assert.equal(second.global.pending[0].requestId, "global-request");
  assert.equal(globalClients, 1);
  assert.equal(projectContexts.length, 2);
  assert.equal(__testTuiStore.globalRegistrySize(), 1);
  assert.equal(__testTuiStore.projectRegistrySize(), 1);
  assert.doesNotMatch(JSON.stringify(second.global.projection.index), new RegExp(`${first.projectFingerprint}|${second.projectFingerprint}`, "u"));
  store.dispose();
});

test("global Apply submits one fresh acting-project request and keeps its terminal outcome across project switching", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-global-action-"));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-global-action-a-"));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-global-action-b-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(firstWorktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondWorktree, { recursive: true, force: true }));
  const scheduler = harness();
  const api = apiFor(root, firstWorktree);
  const recommendationId = "1".repeat(64);
  const generation = "2".repeat(64);
  const indexHash = "3".repeat(64);
  const detailHash = "4".repeat(64);
  const supportSetHash = "5".repeat(64);
  const targetBindingHash = "6".repeat(64);
  const targetHash = "7".repeat(64);
  const proposedContentHash = "8".repeat(64);
  let submitted;
  let complete = false;
  const projectClient = (context) => ({
    async read() {
      const value = projection();
      return {
        ...value,
        index: {
          ...value.index,
          projectFingerprint: context.projectFingerprint,
          stateRootIdentity: context.stateRootIdentity,
        },
        dashboard: dashboard(),
      };
    },
    async readTuiHealth() {
      return {
        schemaVersion: SCHEMA_VERSION,
        projectFingerprint: context.projectFingerprint,
        actor: BRIDGE_ACTOR,
        issuedAt: 1_000,
        expiresAt: 10_000,
        stateRootIdentity: context.stateRootIdentity,
        hostVersion: "1.18.3",
        publisherPid: process.pid,
        nonce: `health-${path.basename(context.worktreePath)}`,
      };
    },
  });
  const store = acquireProjectTuiStore(options(api, scheduler, projectClient, {
    now: () => 1_100,
    globalClientFactory(context) {
      const grantBody = {
        grantVersion: 1,
        capability: "global-action-grant-v1",
        stateRootIdentity: context.stateRootIdentity,
        generation,
        indexHash,
        detailHash,
        recommendationId,
        recommendationVersion: 1,
        supportSetHash,
        targetBindingHash,
        targetHash,
        proposedContentHash,
        priorState: "pending",
        action: "apply",
        nonce: "00000000-0000-4000-8000-000000000001",
        issuedAt: 1_000,
        expiresAt: 1_000 + GLOBAL_PROTOCOL_LIMITS.operationTtlMs,
      };
      const grant = { ...grantBody, grantHash: hashGlobalProtocol("action-grant", grantBody) };
      const globalProjection = {
        mode: "native",
        label: "authoritative-global-v1",
        operationProtocolVersion: 1,
        capabilities: ["project-participation-v1"],
        indexBytes: "same-global-index-bytes",
        index: {
          stateRootIdentity: context.stateRootIdentity,
          generation,
          indexHash,
          recommendations: [{
            recommendationId,
            recommendationVersion: 1,
            supportSetHash,
            state: "pending",
            target: { kind: "existing-global-skill", label: "global-action" },
            support: { tier: "single-domain", independentDomainCount: 1, independentIncidentCount: 2, occurrenceCount: 3 },
            dates: { firstSeenDay: "2026-08-01", lastSeenDay: "2026-08-11", synthesizedAt: 900, updatedAt: 1_000 },
            safety: { criticScoreBasisPoints: 9_500, criticPassed: true, validDeterministic: true },
            availableActions: ["apply"],
            detailHash,
          }],
        },
        details: [{ recommendationId, availableActions: ["apply"] }],
        grants: [grant],
      };
      return {
        async read() { return globalProjection; },
        async submitAction(request) { submitted = request; },
        async reconcilePending(entries) {
          return complete
            ? {
              pending: [],
              responses: entries.map((entry) => ({
                ...entry,
                response: { ok: true, status: "accepted", processedAt: 1_101, reason: null },
              })),
            }
            : { pending: entries, responses: [] };
        },
      };
    },
  }));

  await store.refresh();
  const firstFingerprint = store.getSnapshot().projectFingerprint;
  const request = await store.submitRecommendationAction(recommendationId, "apply");
  assert.equal(submitted, request);
  assert.equal(request.actingProjectFingerprint, firstFingerprint);
  assert.equal(request.recommendationId, recommendationId);
  assert.equal(request.action, "apply");
  assert.equal(store.getSnapshot().global.pending.length, 1);

  complete = true;
  api.state.path.worktree = secondWorktree;
  api.state.path.directory = secondWorktree;
  api.event.emit("project.updated");
  await store.refresh();
  const switched = store.getSnapshot();
  assert.notEqual(switched.projectFingerprint, firstFingerprint);
  assert.equal(switched.global.pending.length, 0);
  assert.equal(switched.global.responses.length, 1);
  assert.equal(switched.global.responses[0].response.status, "accepted");
  assert.equal(switched.global.responses[0].request.actingProjectFingerprint, firstFingerprint,
    "the mounted outcome retains the original transient request without rebinding it to the new project");
  store.dispose();
});

test("attachment and project switch expose non-actionable Starting before bounded server recovery", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-starting-root-"));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-starting-a-"));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-starting-b-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(firstWorktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondWorktree, { recursive: true, force: true }));
  const scheduler = harness();
  const api = apiFor(root, firstWorktree);
  const store = acquireProjectTuiStore(options(api, scheduler, (context) => ({
    async read() {
      if (context.worktreePath === secondWorktree) return await new Promise(() => {});
      return projection("a");
    },
  }), { config: { serverTimeoutMs: 5 } }));
  assert.equal(store.getSnapshot().phase, "initializing");
  assert.equal(store.getSnapshot().projection, null);
  assert.equal(deriveOperationalView(store.getSnapshot()).state, "startup");
  await store.refresh();
  const predecessor = store.getSnapshot();
  assert.equal(predecessor.phase, "ready");

  api.state.path.worktree = secondWorktree;
  api.state.path.directory = secondWorktree;
  api.event.emit("project.updated");
  const starting = store.getSnapshot();
  assert.equal(starting.phase, "initializing");
  assert.equal(starting.projection, null);
  assert.equal("controlState" in starting, false);
  assert.equal(deriveOperationalView(starting).state, "startup");
  assert.notEqual(starting.projectFingerprint, predecessor.projectFingerprint);

  await store.refresh();
  const unavailable = store.getSnapshot();
  assert.equal(unavailable.phase, "error");
  assert.equal(unavailable.projection, null);
  assert.match(unavailable.error, /server-not-responding/u);
  const recovery = buildControlCenterModel(unavailable).recovery;
  assert.equal(recovery.canRetry, true);
  assert.match(recovery.diagnostic, /server-not-responding/u);
  store.dispose();
});

test("startup path fallbacks do not pin the projection store after live paths arrive", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-startup-path-"));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-startup-a-"));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-startup-b-"));
  const placeholderDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-startup-placeholder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(firstWorktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondWorktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(placeholderDirectory, { recursive: true, force: true }));
  const scheduler = harness();
  const contexts = [];
  const api = apiFor("", "");
  api.state.ready = true;
  api.state.path.directory = placeholderDirectory;
  const store = acquireProjectTuiStore(options(api, scheduler, (context) => {
    contexts.push(context);
    return { async read() { return projection(contexts.length === 1 ? "a" : "b"); } };
  }, {
    config: { startupStateRoot: root, startupWorktree: firstWorktree },
  }));
  await store.refresh();
  const first = store.getSnapshot();
  assert.equal(first.worktreePath, firstWorktree);

  api.state.path.state = root;
  api.state.path.worktree = secondWorktree;
  api.state.path.directory = secondWorktree;
  scheduler.tick();
  await store.refresh();
  const second = store.getSnapshot();

  assert.notEqual(second.projectFingerprint, first.projectFingerprint);
  assert.equal(second.worktreePath, secondWorktree);
  assert.equal(contexts.length, 2);

  api.state.path.worktree = "";
  api.state.path.directory = "";
  scheduler.tick();
  await store.refresh();
  const unavailable = store.getSnapshot();
  assert.equal(unavailable.phase, "error");
  assert.equal("projectFingerprint" in unavailable, false);
  store.dispose();
});

test("directory-only changes do not replace an explicitly pinned runtime or lose pending requests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-explicit-path-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-explicit-worktree-"));
  const otherDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-explicit-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(otherDirectory, { recursive: true, force: true }));
  const scheduler = harness();
  const contexts = [];
  const api = apiFor(root, worktree);
  const store = acquireProjectTuiStore(options(api, scheduler, (context) => {
    contexts.push(context);
    return {
      async read() { return projection(); },
      async reconcilePending(entries) { return { pending: entries, responses: [] }; },
    };
  }, { config: { worktree }, now: () => 1_100 }));
  await store.refresh();
  await store.trackPending({
    requestId: "explicit-path-pending",
    kind: "decision",
    action: "apply-proposal",
    subject: "proposal-explicit-path",
    submittedAt: 1_000,
    expiresAt: 2_000,
  });
  const before = store.getSnapshot();

  api.state.path.directory = otherDirectory;
  scheduler.tick();
  await store.refresh();
  const after = store.getSnapshot();

  assert.equal(after.key, before.key);
  assert.equal(contexts.length, 1);
  assert.equal(after.pending.length, 1);
  assert.equal(after.pending[0].requestId, "explicit-path-pending");
  store.dispose();
});

test("an identity-less subscribed store becomes identified without retaining the error snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-late-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-late-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const api = apiFor("relative-state-root", worktree);
  const store = acquireProjectTuiStore(options(api, scheduler, () => ({
    async read() { return projection(); },
  })));
  const snapshots = [];
  store.subscribe((value) => snapshots.push(value));
  assert.equal(store.getSnapshot().phase, "error");
  assert.equal("key" in store.getSnapshot(), false);
  assert.equal("projectFingerprint" in store.getSnapshot(), false);
  assert.equal("stateRootIdentity" in store.getSnapshot(), false);

  api.state.path.state = root;
  api.event.emit("project.updated");
  await store.refresh();
  const identified = store.getSnapshot();
  assert.equal(identified.phase, "ready");
  assert.match(identified.key, /^[a-f0-9]{64}:[a-f0-9]{64}$/u);
  assert.match(identified.projectFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(identified.stateRootIdentity, /^[a-f0-9]{64}$/u);
  assert.equal(snapshots.some((value) => value.phase === "error" && !("key" in value)), true);
  assert.equal(snapshots.at(-1), identified);
  store.dispose();
});

test("dashboard snapshots and local audit acknowledgements remain immutable and project-isolated across rebind", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-ack-"));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-ack-one-"));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-ack-two-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(firstWorktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondWorktree, { recursive: true, force: true }));
  const scheduler = harness();
  const values = new Map();
  const acknowledgementStore = {
    read(projectFingerprint) {
      return values.get(projectFingerprint) ?? [];
    },
    acknowledge(projectFingerprint, binding) {
      const next = [...(values.get(projectFingerprint) ?? []), binding];
      values.set(projectFingerprint, next);
      return next;
    },
  };
  const api = apiFor(root, firstWorktree);
  const clientFactory = () => ({
    async read() {
      const value = projection();
      const appliedActivity = {
        id: "1".repeat(64),
        category: "recommendation",
        audience: "default",
        outcome: "applied",
        summary: "A verified recommendation was applied.",
        occurredAt: 900,
        proposalId: "proposal-one",
        reason: null,
      };
      return Object.freeze({
        ...value,
        index: {
          ...value.index,
          reviews: [{
            proposalId: "proposal-one",
            state: "applied",
            target: "one/SKILL.md",
            attention: "normal",
            updatedAt: 900,
            detailHash: "a".repeat(64),
          }],
        },
        details: [{
          proposalId: "proposal-one",
          detailHash: "a".repeat(64),
          audit: [{ id: appliedActivity.id, kind: "apply" }],
        }],
        dashboard: dashboard({ activity: [appliedActivity] }),
        dashboardError: null,
      });
    },
  });
  const store = acquireProjectTuiStore(options(api, scheduler, clientFactory, {
    acknowledgementStore,
    runtimeMetadata: {
      hostVersion: "1.18.3",
      hostVersionSource: "tui-app-version",
      pluginVersion: "0.2.0",
    },
  }));
  await store.refresh();
  const firstFingerprint = store.getSnapshot().projectFingerprint;
  assert.equal(store.getSnapshot().dashboard.automation.state, "ready");
  assert.equal(store.getSnapshot().dashboardError, null);
  assert.deepEqual(store.getSnapshot().runtime, {
    hostVersion: "1.18.3",
    hostVersionSource: "TUI application version",
    pluginVersion: "0.2.0",
    projectionVersion: null,
    dashboardVersion: 3,
    projectionMode: "native",
  });
  const firstBinding = { scope: "project", subjectId: "proposal-one", version: "a".repeat(64), auditIds: ["1".repeat(64)] };
  store.acknowledgeOutcome("proposal-one");
  assert.deepEqual(store.getSnapshot().acknowledgedOutcomes, [firstBinding]);
  assert.equal(Object.isFrozen(store.getSnapshot().acknowledgedOutcomes), true);

  api.state.path.worktree = secondWorktree;
  api.state.path.directory = secondWorktree;
  scheduler.tick();
  await store.refresh();
  const secondFingerprint = store.getSnapshot().projectFingerprint;
  assert.notEqual(secondFingerprint, firstFingerprint);
  assert.deepEqual(store.getSnapshot().acknowledgedOutcomes, []);
  const otherBinding = firstBinding;
  store.acknowledgeOutcome("proposal-one");

  api.state.path.worktree = firstWorktree;
  api.state.path.directory = firstWorktree;
  scheduler.tick();
  await store.refresh();
  assert.equal(store.getSnapshot().projectFingerprint, firstFingerprint);
  assert.deepEqual(store.getSnapshot().acknowledgedOutcomes, [firstBinding]);
  assert.deepEqual(values.get(secondFingerprint), [otherBinding]);
  store.dispose();
});

test("TUI store sends structured rejection only when the current projection advertises it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-feedback-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-feedback-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const submissions = [];
  let feedbackSupported = true;
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, (context) => ({
    async read() {
      return {
        mode: "native",
        projectionVersion: 1,
        operationProtocolVersion: 2,
        index: {
          generation: "a".repeat(64),
          capabilities: ["legacy-decision-v1"],
          reviews: [{ proposalId: "proposal-feedback", state: "pending", target: "review/SKILL.md", attention: "normal" }],
          allowedActions: [],
        },
        dashboard: dashboard({
          capabilities: feedbackSupported ? ["decision-feedback-v1"] : [],
        }),
        details: [],
        effectiveDetailActions: {
          "proposal-feedback": [{ action: "reject-proposal", capability: "legacy-decision-v1" }],
        },
      };
    },
    async readInbox() {
      return [{
        id: "proposal-feedback",
        projectFingerprint: context.projectFingerprint,
        skillTarget: { currentHash: "b".repeat(64) },
        proposedContentHash: "c".repeat(64),
        decisionVersion: 0,
        state: "pending",
        decisionNonce: "decision-feedback-nonce",
      }];
    },
    async submitDecision(request) {
      submissions.push(request);
    },
    async reconcilePending(entries) {
      return {
        pending: [],
        responses: entries.map((entry) => ({ ...entry, response: { ok: true, status: "accepted" } })),
      };
    },
  })));
  await store.refresh();
  await store.submitDecision({
    proposalId: "proposal-feedback",
    newState: "rejected",
    feedback: { reason: "wrong-scope", text: null },
  });
  assert.deepEqual(submissions[0].feedback, { reason: "wrong-scope", text: null });

  feedbackSupported = false;
  await store.refresh();
  await assert.rejects(store.submitDecision({
    proposalId: "proposal-feedback",
    newState: "rejected",
    feedback: { reason: "wrong-scope", text: null },
  }), /decision-feedback-not-supported/u);
  await store.submitDecision({ proposalId: "proposal-feedback", newState: "rejected" });
  assert.equal("feedback" in submissions[1], false, "legacy peers receive the exact legacy request shape");
  store.dispose();
});

test("TUI store submits Automatic recommendations only through fresh native operation authority", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-repo-mode-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-repo-mode-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const operationSubmissions = [];
  let supported = false;
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, (context) => ({
    async read() {
      const grant = {
        action: "set-automatic-recommendations",
        capability: "automatic-recommendations-control-v1",
        nonce: "automatic-recommendations-operation-nonce",
        expiresAt: 10_000,
      };
      return {
        mode: "native",
        projectionVersion: 1,
        operationProtocolVersion: 2,
        capabilities: UI_CAPABILITIES,
        index: {
          projectFingerprint: context.projectFingerprint,
          stateRootIdentity: context.stateRootIdentity,
          generation: "a".repeat(64),
          projectionHash: "c".repeat(64),
          capabilities: UI_CAPABILITIES,
          reviews: [],
          allowedActions: supported ? [grant] : [],
        },
        dashboard: dashboard({
          supportedControls: supported ? ["set-automatic-recommendations"] : [],
        }),
        details: [],
        effectiveIndexActions: supported ? [grant] : [],
        effectiveDetailActions: {},
      };
    },
    async submitOperation(request) { operationSubmissions.push(request); },
  }), { now: () => 1_100 }));
  await store.refresh();
  await assert.rejects(
    store.submitOperation("set-automatic-recommendations", { enabled: false }),
    /operation-not-authorized/u,
  );
  await assert.rejects(
    store.submitControl("set-automatic-recommendations", { enabled: false }),
    /retired-v04-control/u,
  );
  assert.equal(operationSubmissions.length, 0);

  supported = true;
  await store.refresh();
  const request = await store.submitOperation("set-automatic-recommendations", { enabled: false });
  assert.equal(request.action, "set-automatic-recommendations");
  assert.deepEqual(request.payload, { enabled: false, settingsVersion: "b".repeat(64) });
  assert.equal(request.generation, "a".repeat(64));
  assert.equal(request.projectionHash, "c".repeat(64));
  assert.equal(request.capability, "automatic-recommendations-control-v1");
  assert.equal(operationSubmissions.length, 1);
  await assert.rejects(
    store.submitOperation("set-automatic-recommendations", { enabled: false }),
    /matching-request-already-pending/u,
  );
  store.dispose();
});

test("authoritative root-policy submission uses the fresh dashboard grant and settings version", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-root-policy-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-root-policy-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const submissions = [];
  const grant = {
    action: "replace-global-root-policy",
    capability: "operation-global-root-policy-v1",
    nonce: "root-policy-operation-nonce",
    expiresAt: 10_000,
  };
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, (context) => ({
    async read() {
      return {
        mode: "native",
        projectionVersion: 1,
        operationProtocolVersion: 2,
        capabilities: UI_CAPABILITIES,
        index: {
          projectFingerprint: context.projectFingerprint,
          stateRootIdentity: context.stateRootIdentity,
          generation: "a".repeat(64),
          projectionHash: "c".repeat(64),
          capabilities: UI_CAPABILITIES,
          reviews: [],
          allowedActions: [],
        },
        dashboard: dashboard({
          settings: {
            ...dashboard().settings,
            globalRootPolicyAction: grant,
          },
        }),
        details: [],
        effectiveIndexActions: [grant],
        effectiveDetailActions: {},
      };
    },
    async readInbox() { return []; },
    async submitOperation(request) { submissions.push(request); },
    async reconcilePending(entries) { return { pending: entries, responses: [] }; },
  }), { now: () => 1_100 }));
  await store.refresh();

  const request = await store.submitOperation("replace-global-root-policy", {
    roots: [{ canonicalPath: "/global/skills", canUpdate: true, canCreate: true }],
    creationRootPath: "/global/skills",
    confirmation: "REPLACE GLOBAL ROOT POLICY bbbbbbbbbbbb",
  });
  assert.deepEqual(request.payload, {
    roots: [{ canonicalPath: "/global/skills", canUpdate: true, canCreate: true }],
    creationRootPath: "/global/skills",
    confirmation: "REPLACE GLOBAL ROOT POLICY bbbbbbbbbbbb",
    settingsVersion: "b".repeat(64),
  });
  assert.equal(submissions.length, 1);
  store.dispose();
});

test("downgraded peers never expose raw grants or write mailbox requests", async (t) => {
  for (const mode of ["read-only", "legacy"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `self-evolve-tui-${mode}-root-`));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `self-evolve-tui-${mode}-project-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
    const scheduler = harness();
    const writes = [];
    const proposalId = `proposal-${mode}`;
    const rawGrant = {
      action: "set-automatic-recommendations",
      capability: "automatic-recommendations-control-v1",
      nonce: "raw-index-nonce",
      expiresAt: 10_000,
    };
    let negotiatedMode = mode;
    let negotiatedOperationProtocolVersion = null;
    const projectionValue = mode === "legacy" ? {
      mode,
      projectionVersion: null,
      operationProtocolVersion: null,
      index: null,
      details: [],
      effectiveIndexActions: [],
      effectiveDetailActions: {},
    } : {
      mode,
      projectionVersion: 1,
      operationProtocolVersion: null,
      index: {
        generation: "a".repeat(64),
        reviews: [{ proposalId, state: "pending", target: "review/SKILL.md", attention: "normal" }],
        allowedActions: [rawGrant],
      },
      dashboard: dashboard(),
      details: [],
      effectiveIndexActions: [],
      effectiveDetailActions: { [proposalId]: [] },
    };
    const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, () => ({
      async read() {
        return {
          ...projectionValue,
          mode: negotiatedMode,
          operationProtocolVersion: negotiatedOperationProtocolVersion,
        };
      },
      async readInbox() { return [{ id: proposalId }]; },
      async submitDecision(request) { writes.push(request); },
      async submitOperation(request) { writes.push(request); },
    }), { now: () => 1_100 }));
    await store.refresh();
    const snapshot = store.getSnapshot();
    assert.deepEqual(buildRecommendationsModel(snapshot).selected?.actions ?? [], []);
    assert.deepEqual(buildSettingsModel(snapshot).controls, {
      automaticRecommendations: false,
      consent: false,
      projectInclusion: false,
      approvedSkillFolders: false,
      emergencyStop: false,
    });
    assert.deepEqual(buildSettingsModel(snapshot).maintenance, {
      scopes: buildSettingsModel(snapshot).maintenance.scopes,
      canExport: false,
      canDeleteScope: false,
      canDeleteAll: false,
    });
    await assert.rejects(store.submitDecision({ proposalId, newState: "rejected" }), /native.*protocol/u);
    await assert.rejects(store.submitControl("set-mode", { mode: "manual" }), /retired-v04-control/u);
    await assert.rejects(store.submitOperation("set-automatic-recommendations", { enabled: false }), /native.*protocol/u);
    assert.equal(writes.length, 0);
    if (mode === "read-only") {
      negotiatedMode = "native";
      negotiatedOperationProtocolVersion = 2;
      await store.refresh();
      await assert.rejects(store.submitOperation("set-automatic-recommendations", { enabled: false }), /operation-not-authorized/u);
      assert.equal(writes.length, 0, "an empty effective list never falls back to the raw index grant");
      await assert.rejects(store.submitControl("set-mode", { mode: "manual" }), /retired-v04-control/u);
      assert.equal(writes.length, 0);
    }
    store.dispose();
  }
});

test("failed refresh strips retained authority and Retry restores only freshly negotiated actions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-stale-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-stale-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const proposalId = "proposal-stale-retry";
  let state = "initial";
  const projectionFor = () => ({
    mode: "native",
    projectionVersion: 1,
    operationProtocolVersion: 1,
    index: {
      generation: (state === "fresh" ? "b" : "a").repeat(64),
      reviews: [{ proposalId, state: "pending", target: "review/SKILL.md", attention: "normal", updatedAt: 1_000 }],
      allowedActions: [],
    },
    dashboard: dashboard(),
    details: [],
    effectiveIndexActions: state === "fresh" ? [{ action: "set-kill-switch" }] : [{ action: "set-automatic-recommendations" }],
    effectiveDetailActions: {
      [proposalId]: state === "fresh" ? [{ action: "reject-proposal" }] : [{ action: "apply-proposal" }],
    },
  });
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, () => ({
    async read() {
      if (state === "expired") throw new Error(`expired-projection:${"private".repeat(80)}`);
      return projectionFor();
    },
    async reconcilePending(entries) { return { pending: entries, responses: [] }; },
  }), { now: () => 1_100 }));

  await store.refresh();
  await store.trackPending({
    requestId: "still-pending",
    kind: "decision",
    action: "apply-proposal",
    subject: proposalId,
    submittedAt: 1_000,
    expiresAt: 2_000,
  });
  state = "expired";
  await store.refresh();
  const expired = store.getSnapshot();
  assert.equal(expired.phase, "error");
  assert.equal(expired.stale, true);
  assert.equal(expired.error.length, 240);
  assert.equal("controlState" in expired, false);
  assert.deepEqual(expired.projection.effectiveIndexActions, []);
  assert.deepEqual(expired.projection.effectiveDetailActions[proposalId], []);
  assert.equal(expired.pending.length, 1);
  await assert.rejects(store.submitOperation("set-automatic-recommendations", { enabled: false }), /native-operation-protocol-unavailable/u);

  state = "fresh";
  await store.refresh();
  const fresh = store.getSnapshot();
  assert.equal(fresh.phase, "ready");
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.projection.effectiveIndexActions.map((entry) => entry.action), ["set-kill-switch"]);
  assert.deepEqual(buildRecommendationsModel(fresh).selected.actions, [],
    "a fresh project projection remains read-only while the global protocol is unavailable");
  assert.equal(buildSettingsModel(fresh).controls.automaticRecommendations, false);
  assert.equal(buildSettingsModel(fresh).controls.emergencyStop, false,
    "a missing global protocol keeps even a fresh project projection read-only");
  store.dispose();
});

test("authority preflight waits for replacement reads and fails closed before every current submit boundary", async (t) => {
  for (const kind of ["decision", "operation"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `self-evolve-tui-preflight-${kind}-root-`));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `self-evolve-tui-preflight-${kind}-project-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
    const scheduler = harness();
    const proposalId = `proposal-${kind}-race`;
    const writes = [];
    let reads = 0;
    let resolveReplacement;
    let expireFollowUp = false;
    const authorized = (context) => ({
      mode: "native",
      projectionVersion: 1,
      operationProtocolVersion: 2,
      index: {
        projectFingerprint: context.projectFingerprint,
        stateRootIdentity: context.stateRootIdentity,
        generation: "a".repeat(64),
        reviews: [{ proposalId, state: "pending", target: "review/SKILL.md", attention: "normal" }],
        allowedActions: [],
      },
      dashboard: dashboard(),
      details: [],
      effectiveIndexActions: [{ action: "set-automatic-recommendations" }],
      effectiveDetailActions: {
        [proposalId]: [{ action: "reject-proposal" }, { action: "snooze-proposal" }],
      },
    });
    const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, (context) => ({
      read() {
        reads += 1;
        if (reads === 2) return new Promise((resolve) => { resolveReplacement = resolve; });
        if (expireFollowUp) throw new Error("expired-projection");
        return authorized(context);
      },
      async readInbox() {
        return [{
          id: proposalId,
          skillTarget: { currentHash: "d".repeat(64) },
          proposedContentHash: "e".repeat(64),
          decisionVersion: 0,
        }];
      },
      async submitDecision(request) { writes.push(request); },
      async submitOperation(request) { writes.push(request); },
    }), { now: () => 1_100 }));
    await store.refresh();

    const replacement = store.refresh();
    await settle();
    const submission = kind === "decision"
      ? store.submitDecision({ proposalId, newState: "rejected" })
      : store.submitOperation("snooze-proposal", { snoozedUntil: 5_000 }, { proposalId });
    expireFollowUp = true;
    resolveReplacement(authorized({
      projectFingerprint: store.getSnapshot().projectFingerprint,
      stateRootIdentity: store.getSnapshot().stateRootIdentity,
    }));
    await replacement;
    await assert.rejects(submission, /native-operation-protocol-unavailable/u, kind);
    assert.equal(reads, 3, `${kind} preflight must await the queued replacement read`);
    assert.equal(writes.length, 0, `${kind} reached its submit boundary with stale authority`);
    assert.equal(store.getSnapshot().phase, "error");
    store.dispose();
  }
});

test("write bursts coalesce while an in-flight reread receives one bounded follow-up", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-burst-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-burst-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const resolvers = [];
  let reads = 0;
  const api = apiFor(root, worktree);
  const store = acquireProjectTuiStore(options(api, scheduler, () => ({
    read() {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => resolvers.push(resolve));
      return projection("b");
    },
  })));
  await settle();
  assert.equal(reads, 1);
  for (let index = 0; index < 25; index += 1) scheduler.watchers[0].callback("change");
  const completion = store.refresh();
  resolvers[0](projection("a"));
  await completion;
  await settle();
  assert.equal(reads, 2);
  assert.equal(store.getSnapshot().projection.index.generation, "b".repeat(64));
  store.dispose();
});

test("watch failure falls back to polling and watched-directory replacement rearms without a busy loop", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-watch-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-watch-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness({ watchError: new Error("synthetic-watch-unavailable") });
  let reads = 0;
  const api = apiFor(root, worktree);
  const store = acquireProjectTuiStore(options(api, scheduler, () => ({
    async read() { reads += 1; return projection(); },
  })));
  await store.refresh();
  assert.equal(store.getSnapshot().watcher, "polling");
  assert.equal(store.getSnapshot().watcherError, "synthetic-watch-unavailable");
  assert.equal(scheduler.watchers.length, 1, "the independent global watcher remains active");
  assert.equal(scheduler.intervals.size, 2);

  scheduler.tick();
  await settle();
  assert.equal(scheduler.watchers.length, 2);
  const replacement = scheduler.watchers[1];
  replacement.callback("rename");
  await settle();
  assert.equal(replacement.closed, true);
  scheduler.tick();
  await settle();
  assert.equal(scheduler.watchers.length, 3);
  assert.equal(reads, 4);
  assert.equal(scheduler.intervals.size, 2);
  store.dispose();
});

test("pending responses reconcile into the immutable project snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-pending-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-pending-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const api = apiFor(root, worktree);
  const store = acquireProjectTuiStore(options(api, scheduler, () => ({
    async read() { return projection(); },
    async reconcilePending(entries) {
      return {
        pending: [],
        responses: entries.map((entry) => ({ ...entry, response: { ok: true, status: "completed", processedAt: 200 } })),
      };
    },
  })));
  await store.trackPending({
    requestId: "request-1",
    kind: "operation",
    action: "export-data",
    subject: "scope:project",
    submittedAt: 123,
    expiresAt: 456,
  });
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.pending, []);
  assert.equal(snapshot.responses.length, 1);
  assert.equal(snapshot.responses[0].requestId, "request-1");
  assert.equal(Object.isFrozen(snapshot.responses), true);
  assert.equal(Object.isFrozen(snapshot.responses[0]), true);
  store.dispose();
});

test("missing responses expire by authoritative class deadline and late responses stay expired", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-expiry-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-expiry-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  let now = 100;
  let publishLateResponses = false;
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, () => ({
    async read() { return projection(); },
    async reconcilePending(entries) {
      return {
        pending: publishLateResponses ? entries.filter((entry) => entry.expiresAt > now) : entries,
        responses: publishLateResponses
          ? entries
            .filter((entry) => entry.expiresAt <= now)
            .map((entry) => ({ ...entry, response: { ok: true, status: "accepted" } }))
          : [],
      };
    },
  }), { now: () => now }));

  await store.trackPending({
    requestId: "decision-expiry",
    kind: "decision",
    action: "apply-proposal",
    subject: "proposal-a",
    submittedAt: 100,
    expiresAt: 110,
  });
  await store.trackPending({
    requestId: "permission-expiry",
    kind: "operation",
    action: "set-permission",
    subject: "permission:durableObservations",
    submittedAt: 100,
    expiresAt: 120,
  });
  await store.trackPending({
    requestId: "operation-expiry",
    kind: "operation",
    action: "export-data",
    subject: "scope:project",
    submittedAt: 100,
    expiresAt: 130,
  });

  now = 120;
  publishLateResponses = true;
  await store.refresh();
  const atPermissionExpiry = store.getSnapshot();
  assert.deepEqual(atPermissionExpiry.pending.map((entry) => entry.requestId), ["operation-expiry"]);
  assert.deepEqual(atPermissionExpiry.responses.map((entry) => [entry.requestId, entry.response.status]), [
    ["decision-expiry", "expired"],
    ["permission-expiry", "expired"],
  ]);
  assert.equal(atPermissionExpiry.responses.every((entry) => entry.response.ok === false), true);
  assert.equal(atPermissionExpiry.responses.every((entry) => entry.response.reason === "response-not-received-before-expiry"), true);

  now = 130;
  await store.refresh();
  const complete = store.getSnapshot();
  assert.deepEqual(complete.pending, []);
  assert.equal(complete.responses.at(-1).requestId, "operation-expiry");
  assert.equal(complete.responses.at(-1).response.status, "expired");

  await store.refresh();
  assert.equal(store.getSnapshot().responses.length, 3, "late polling cannot resurrect expired authority");
  store.dispose();
});

test("real decision and operation submissions track authoritative deadlines and retry with fresh authority", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-deadlines-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-deadlines-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  let now = 1_000;
  let decisionNonce = "decision-nonce-1";
  const proposalId = "proposal-deadlines";
  const submissions = [];
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, (context) => {
    const generation = "c".repeat(64);
    const grant = {
      action: "set-automatic-recommendations",
      capability: UI_ACTION_CAPABILITIES["set-automatic-recommendations"],
      nonce: "operation-nonce",
      expiresAt: 31_000,
    };
    const indexBody = {
      projectionVersion: UI_PROJECTION_VERSION,
      projectFingerprint: context.projectFingerprint,
      stateRootIdentity: context.stateRootIdentity,
      generation,
      issuedAt: 900,
      expiresAt: 61_000,
      capabilities: UI_CAPABILITIES,
      status: {
        state: "ready",
        reason: null,
        automaticRecommendationsEnabled: true,
        killSwitchActive: false,
        repoExcluded: false,
        circuitBreakerOpen: false,
      },
      budgets: {
        passiveCallsPerHour: 3,
        synthesisPerDay: 2,
        tokensPerSynthesis: 100,
        concurrentObservationsPerProject: 1,
        concurrentSynthesesGlobal: 1,
        idleDebounceMs: 1_500,
        storageQuotaMiB: 8,
      },
      reviews: [],
      operations: [],
      allowedActions: [grant],
      overflow: {
        reviews: { truncated: false, includedCount: 0, omittedCount: 0, omittedBytes: 0, reason: "none" },
        operations: { truncated: false, includedCount: 0, omittedCount: 0, omittedBytes: 0, reason: "none" },
        allowedActions: { truncated: false, includedCount: 1, omittedCount: 0, omittedBytes: 0, reason: "none" },
      },
    };
    const index = { ...indexBody, projectionHash: hashUiProtocol("projection-index", indexBody) };
    return {
      async read() {
        return {
          mode: "native",
          projectionVersion: UI_PROJECTION_VERSION,
          operationProtocolVersion: 2,
          index,
          dashboard: dashboard(),
          details: [],
          effectiveIndexActions: [grant],
          effectiveDetailActions: { [proposalId]: [{ action: "apply-proposal" }] },
        };
      },
      async readInbox() {
        return [{
          id: proposalId,
          projectFingerprint: context.projectFingerprint,
          skillTarget: { currentHash: "d".repeat(64) },
          proposedContentHash: "e".repeat(64),
          decisionVersion: 0,
          state: "pending",
          decisionNonce,
        }];
      },
      async submitDecision(request) { submissions.push(request); },
      async submitOperation(request) { submissions.push(request); },
      async reconcilePending(entries) { return { pending: entries, responses: [] }; },
    };
  }, { now: () => now }));
  await store.refresh();

  const firstDecision = await store.submitDecision({ proposalId, newState: "approved" });
  const operation = await store.submitOperation("set-automatic-recommendations", { enabled: false });
  const pending = new Map(store.getSnapshot().pending.map((entry) => [entry.requestId, entry]));
  assert.equal(pending.get(firstDecision.requestId).expiresAt, 1_000 + BRIDGE_TTL_MS);
  assert.equal(pending.get(operation.requestId).expiresAt, operation.expiresAt);
  assert.equal(operation.expiresAt, 31_000);

  now = 1_000 + BRIDGE_TTL_MS;
  await store.refresh();
  decisionNonce = "decision-nonce-2";
  const retried = await store.submitDecision({ proposalId, newState: "approved" });
  assert.notEqual(retried.requestId, firstDecision.requestId);
  assert.notEqual(retried.nonce, firstDecision.nonce);
  assert.equal(retried.nonce, decisionNonce);
  assert.equal(submissions.length, 3);
  store.dispose();
});

test("pending tracking rejects overflow instead of forgetting published requests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-capacity-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-capacity-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, () => ({
    async read() { return projection(); },
    async reconcilePending(entries) { return { pending: entries, responses: [] }; },
  }), { now: () => 200 }));
  for (let index = 0; index < 32; index += 1) {
    await store.trackPending({
      requestId: `capacity-${index}`,
      kind: "operation",
      action: "set-permission",
      subject: `permission:${index}`,
      submittedAt: 100,
      expiresAt: 1_000,
    });
  }
  await assert.rejects(store.trackPending({
    requestId: "capacity-overflow",
    kind: "operation",
    action: "set-permission",
    subject: "permission:overflow",
    submittedAt: 100,
    expiresAt: 1_000,
  }), /pending-request-capacity-exhausted/u);
  assert.equal(store.getSnapshot().pending.length, 32);
  assert.equal(store.getSnapshot().pending[0].requestId, "capacity-0");
  store.dispose();
});

test("concurrent matching submissions publish only one request", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-concurrent-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-concurrent-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const submissions = [];
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, (context) => ({
    async read() {
      const grant = {
        action: "set-automatic-recommendations",
        capability: "automatic-recommendations-control-v1",
        nonce: "concurrent-operation-nonce",
        expiresAt: 10_000,
      };
      return {
        ...projection(),
        index: {
          ...projection().index,
          projectFingerprint: context.projectFingerprint,
          stateRootIdentity: context.stateRootIdentity,
          projectionHash: "c".repeat(64),
          capabilities: UI_CAPABILITIES,
        },
        dashboard: dashboard(),
        effectiveIndexActions: [grant],
      };
    },
    async submitOperation(request) { submissions.push(request); },
    async reconcilePending(entries) { return { pending: entries, responses: [] }; },
  }), { now: () => 1_100 }));
  await store.refresh();
  const results = await Promise.allSettled([
    store.submitOperation("set-automatic-recommendations", { enabled: false }),
    store.submitOperation("set-automatic-recommendations", { enabled: false }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected"
    && /matching-request-already-pending/u.test(result.reason?.message)).length, 1);
  assert.equal(submissions.length, 1);
  assert.equal(store.getSnapshot().pending.length, 1);
  store.dispose();
});

test("recommendation pending state disables only the exact proposal action", () => {
  const reviews = [
    { proposalId: "proposal-a", state: "pending", target: "a/SKILL.md", attention: "normal", updatedAt: 1_000 },
    { proposalId: "proposal-b", state: "pending", target: "b/SKILL.md", attention: "normal", updatedAt: 1_000 },
  ];
  const value = modelSnapshot({ reviews });
  value.pending = [{
    requestId: "pending-a-apply",
    kind: "decision",
    action: "apply-proposal",
    subject: "proposal-a",
    submittedAt: 1_000,
    expiresAt: 2_000,
  }];
  value.projection.effectiveDetailActions = {
    "proposal-a": [{ action: "apply-proposal" }, { action: "reject-proposal" }],
    "proposal-b": [{ action: "apply-proposal" }],
  };

  const first = buildRecommendationsModel(value, { selectedIndex: 0 });
  assert.deepEqual(first.selected.actions.map((entry) => [entry.action, entry.pending]), [
    ["apply-proposal", true],
    ["reject-proposal", false],
  ]);
  const second = buildRecommendationsModel(value, { selectedIndex: 1 });
  assert.deepEqual(second.selected.actions.map((entry) => [entry.action, entry.pending]), [
    ["apply-proposal", false],
  ]);
});

test("abort during initialization cancels the final owner and prevents post-disposal subscriber updates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-abort-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-abort-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  let resolveRead;
  const api = apiFor(root, worktree);
  const store = acquireProjectTuiStore(options(api, scheduler, () => ({
    read() { return new Promise((resolve) => { resolveRead = resolve; }); },
  })));
  const snapshots = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  await settle();
  const countBeforeAbort = snapshots.length;
  api.lifecycle.abort();
  assert.equal(__testTuiStore.registrySize(), 0);
  assert.equal(scheduler.intervals.size, 0);
  assert.equal(scheduler.watchers[0].closed, true);
  resolveRead(projection());
  await settle();
  assert.equal(snapshots.length, countBeforeAbort);
  assert.equal(store.getSnapshot().phase, "initializing");
});

test("detail selection is bounded and stale asynchronous generations cannot update a replacement runtime", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-store-generation-"));
  const firstWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-generation-a-"));
  const secondWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-generation-b-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(firstWorktree, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondWorktree, { recursive: true, force: true }));
  const scheduler = harness();
  let resolveOld;
  const api = apiFor(root, firstWorktree);
  const store = acquireProjectTuiStore(options(api, scheduler, (context) => ({
    read({ detailProposalIds }) {
      if (context.worktreePath === firstWorktree) {
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return Object.freeze({ ...projection("b"), details: Object.freeze(detailProposalIds) });
    },
  })));
  await settle();
  assert.throws(
    () => store.selectDetails(["one", "two", "three"]),
    /resident-details-out-of-bounds/u,
  );
  api.state.path.worktree = secondWorktree;
  api.state.path.directory = secondWorktree;
  api.event.emit("project.updated");
  await store.selectDetails(["new-detail"]);
  const replacement = store.getSnapshot();
  assert.equal(replacement.worktreePath, secondWorktree);
  assert.deepEqual(replacement.projection.details, ["new-detail"]);
  resolveOld(projection("a"));
  await settle();
  assert.equal(store.getSnapshot(), replacement);
  store.dispose();
});
