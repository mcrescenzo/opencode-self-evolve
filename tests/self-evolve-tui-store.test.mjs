import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BRIDGE_TTL_MS,
} from "../self-evolve-bridge.js";
import {
  UI_ACTION_CAPABILITIES,
  UI_CAPABILITIES,
  UI_DASHBOARD_BLOCKER_DESTINATIONS,
  UI_PROJECTION_VERSION,
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
  parseControlCenterDestination,
  validateApprovedSkillFolderInput,
} from "../self-evolve-tui-store.js";
import { SCHEMA_VERSION } from "../self-evolve-schemas.js";

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
    operationProtocolVersion: 1,
    index: Object.freeze({ generation: generation.repeat(64) }),
    details: Object.freeze([]),
    effectiveIndexActions: Object.freeze([]),
    effectiveDetailActions: Object.freeze({}),
  });
}

function dashboard(overrides = {}) {
  return {
    generatedAt: 1_000,
    automation: { state: "ready", reason: null },
    blockers: [],
    inFlight: { active: false, count: 0, stage: null, startedAt: null },
    lastCycle: null,
    nextEligibleAt: null,
    usage: {
      passive: { used: 1, limit: 3, remaining: 2, resetAt: 2_000 },
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
      globalMode: "auto",
      repositoryMode: "inherit",
      effectiveMode: "auto",
      paused: false,
      killSwitchActive: false,
      repositoryExcluded: false,
      consent: {
        passiveCalls: true,
        durableObservations: true,
        sanitizedExcerpts: false,
        crossRepoAggregation: false,
      },
      approvedSkillFolderCount: 1,
    },
    retention: { observationsDays: 30, operationalDays: 90 },
    capabilities: ["control-repo-mode-v1", "decision-feedback-v1"],
    supportedControls: ["set-kill-switch", "set-paused", "set-repo-mode"],
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
  acknowledgedAuditIds = [],
} = {}) {
  return {
    phase,
    updatedAt: 1_000,
    pending: [],
    acknowledgedAuditIds,
    dashboard: dashboardValue,
    dashboardError,
    projection: {
      mode: "native",
      projectionVersion: 1,
      operationProtocolVersion: 1,
      capabilities: ["legacy-control-v1", "legacy-decision-v1"],
      dashboard: dashboardValue,
      dashboardError,
      index: {
        capabilities: ["legacy-control-v1", "legacy-decision-v1"],
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
          storedMode: "auto",
          effectiveMode: "auto",
          paused: false,
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
    ["paused", modelSnapshot({ dashboard: dashboard({ automation: { state: "paused", reason: "paused" } }) }), "home"],
    ["excluded", modelSnapshot({ dashboard: dashboard({ automation: { state: "excluded", reason: "repository-excluded" } }) }), "settings"],
    ["on-demand", modelSnapshot({ dashboard: dashboard({
      automation: { state: "on-demand", reason: null },
      settings: { ...dashboard().settings, globalMode: "manual", effectiveMode: "manual" },
    }) }), "home"],
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
      expectedState === "on-demand" ? "settings" : sidebar.destination.section,
    );
    assert.equal(sidebar.summary, expectedState === "ready" ? "Watching this project" : operational.label);
    assert.doesNotMatch(JSON.stringify(sidebar), /private-proposal-id|[a-f0-9]{64}/u);
  }
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

test("setup semantics cover missing auto consent/provider and YOLO rollout without ambiguous readiness", () => {
  for (const blocker of [
    { code: "provider", summary: "Background analysis has no usable provider.", destination: "settings" },
    { code: "observation-consent", summary: "Saved structured patterns are not allowed.", destination: "settings" },
    { code: "yolo-rollout", summary: "Automatic apply rollout evidence is not ready.", destination: "settings" },
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

test("manual sidebar entry opens Home while the explicit mode-setting action remains in Settings", () => {
  const snapshot = modelSnapshot({ dashboard: dashboard({
    automation: { state: "on-demand", reason: null },
    settings: { ...dashboard().settings, globalMode: "manual", effectiveMode: "manual" },
  }) });
  const operational = deriveOperationalView(snapshot);
  const sidebar = deriveSidebarCard(snapshot);
  assert.deepEqual(operational.destination, { section: "settings", anchor: "modes" });
  assert.deepEqual(sidebar.destination, { section: "home" });
  assert.equal(sidebar.action, "Open Home");
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
  assert.deepEqual(firstRun, { dashboard: "home", section: "home" });
});

test("applied attention supports multiple local acknowledgements while Activity history remains", () => {
  const reviews = [
    { proposalId: "proposal-one", state: "applied", target: "one/SKILL.md", attention: "normal", updatedAt: 900 },
    { proposalId: "proposal-two", state: "applied", target: "two/SKILL.md", attention: "normal", updatedAt: 800 },
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
  const oneAcknowledged = modelSnapshot({ dashboard: value, reviews, acknowledgedAuditIds: [activity[0].id] });
  assert.equal(deriveOperationalView(oneAcknowledged).count, 1);
  const allAcknowledged = modelSnapshot({
    dashboard: value,
    reviews,
    acknowledgedAuditIds: activity.map((entry) => entry.id),
  });
  assert.equal(deriveOperationalView(allAcknowledged).state, "ready");
  assert.equal(buildActivityModel(allAcknowledged).activity.length, 2);

  const partiallyProjected = modelSnapshot({
    dashboard: dashboard({ activity: [activity[0]] }),
    reviews,
    acknowledgedAuditIds: [activity[0].id],
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
  assert.equal(healthy.sections.home.mode.effective.label, "Recommend automatically");
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
  snapshot.controlState = {
    mode: "auto",
    effectiveMode: "auto",
    repoExcluded: false,
    allowedSkillRoots: ["/stale/approved"],
    consent: dashboard().settings.consent,
  };
  snapshot.projection.effectiveIndexActions = [
    { action: "set-paused" },
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
    globalMode: false,
    repositoryMode: false,
    consent: false,
    projectInclusion: false,
    approvedSkillFolders: false,
    pause: false,
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
    "settings().controls.pause",
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
    "ENABLE YOLO",
    "Approved skill folders",
    "The global default applies to every current and future project",
    "confirmation() === confirmationKey",
    "automatic-recommendations",
    "Review consent for",
    "Confirm allow",
    "Cancel consent change",
    "UPDATE ALLOWLIST",
    "EXPORT SENSITIVE SELF-EVOLVE DATA",
    "PURGE ALL SELF-EVOLVE DATA",
    "Actual:",
    "Configured limit:",
    "set-repo-mode",
    "isActivationKey",
    "cmd: closeControlCenter",
    "openControlCenter(card.destination)",
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /const names = \["overview"|"Health \/ Budgets"|openReview\(\)\s*$/mu);
  assert.doesNotMatch(source, />Help<|>Safety<|>Maintenance<\/text>\s*<\/box>\s*<\/Show>/u);
  assert.doesNotMatch(source, /ReviewDialog|REVIEW_DIALOG_ID|api\.ui\.dialog\.replace/u);
  assert.doesNotMatch(source, /api\.ui\.toast|api\.attention\.notify/u);
  const automaticSetup = source.slice(source.indexOf("const enableAutomaticRecommendations"), source.indexOf("const openConsentDisclosure"));
  assert.equal(automaticSetup.match(/submitControl\("set-mode", \{ mode: "auto" \}\)/gu)?.length, 1);
  assert.doesNotMatch(automaticSetup, /set-consent/u);
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
        mode: "auto",
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
  snapshot.controlState = {
    mode: "auto",
    effectiveMode: "auto",
    repoExcluded: false,
    allowedSkillRoots: ["/private/canonical/root"],
    consent: dashboard().settings.consent,
  };
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
  assert.equal(settings.mode.effective.label, "Recommend automatically");
  assert.match(settings.modes.find((mode) => mode.value === "auto").prerequisites, /approved skill folders are not required/u);
  assert.equal(settings.consent[0].label, "Background AI analysis");
  assert.equal(settings.approvedSkillFolderCount, 1);
  for (const model of [home, recommendations, activity, errors]) {
    assert.equal(Object.isFrozen(model), true);
    assert.doesNotMatch(
      JSON.stringify(model),
      /private-proposal-id|private-request-id|private-evidence-id|\/private\/canonical\/root|f{64}|e{64}/u,
    );
  }
  assert.equal(Object.isFrozen(settings), true);
  assert.deepEqual(settings.approvedSkillFolders, ["/private/canonical/root"],
    "raw canonical paths are confined to the explicit high-risk folder editor");
  assert.doesNotMatch(
    JSON.stringify({ ...settings, approvedSkillFolders: [] }),
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
    passive: 2_000,
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

test("Settings explains scope, gates repository mode, validates folder lists, distinguishes limits, and consolidates maintenance", () => {
  const value = dashboard({
    dashboardVersion: 2,
    retention: { observationsDays: 10, operationalDays: 30 },
  });
  const snapshot = modelSnapshot({ dashboard: value });
  snapshot.controlState = {
    mode: "auto",
    effectiveMode: "auto",
    repoExcluded: false,
    allowedSkillRoots: ["/approved/skills"],
    consent: value.settings.consent,
  };
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
  ];

  const settings = buildSettingsModel(snapshot);
  assert.equal(settings.controls.repositoryMode, true);
  assert.equal(settings.modes.find((mode) => mode.value === "yolo").available, true);
  assert.equal(settings.approvedSkillFolderRequiresNonEmpty, false);
  assert.deepEqual(settings.mode.repository, { value: "inherit", label: "Inherit global default" });
  assert.deepEqual(settings.approvedSkillFolders, ["/approved/skills"]);
  assert.deepEqual(settings.consent.map((entry) => entry.label), [
    "Background AI analysis",
    "Saved structured patterns",
    "Sanitized evidence excerpts",
    "Cross-project learning (not active yet)",
  ]);
  assert.equal(settings.consent.find((entry) => entry.key === "crossRepoAggregation").canEnable, false);
  assert.match(settings.limits.find((limit) => limit.key === "passive").actual, /1 used; 2 remaining/u);
  assert.match(settings.limits.find((limit) => limit.key === "passive").configured, /3 per rolling hour/u);
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
      { value: "proposals", label: "Recommendations", explanation: "Recommendation and decision records for this project." },
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
  const oldTuiPeer = modelSnapshot();
  oldTuiPeer.dashboard.capabilities = oldTuiPeer.dashboard.capabilities
    .filter((capability) => capability !== "control-repo-mode-v1");
  assert.equal(buildSettingsModel(oldTuiPeer).controls.repositoryMode, false,
    "a peer without the dashboard capability ignores the new server control");

  const blockedSnapshot = modelSnapshot({
    dashboard: dashboard({
      rollout: { ...value.rollout, ready: false, synthesesObserved: 2 },
      settings: {
        ...value.settings,
        consent: { ...value.settings.consent, passiveCalls: false },
      },
    }),
  });
  blockedSnapshot.controlState = {
    ...snapshot.controlState,
    allowedSkillRoots: [],
    consent: blockedSnapshot.dashboard.settings.consent,
  };
  const blocked = buildSettingsModel(blockedSnapshot);
  const yolo = blocked.modes.find((mode) => mode.value === "yolo");
  assert.equal(yolo.available, false);
  assert.match(yolo.blockers.join("\n"), /Approve at least|Background AI analysis|rollout/u);
  const yoloStored = modelSnapshot({
    dashboard: dashboard({
      settings: { ...value.settings, repositoryMode: "yolo", effectiveMode: "yolo" },
    }),
  });
  yoloStored.controlState = snapshot.controlState;
  assert.equal(buildSettingsModel(yoloStored).approvedSkillFolderRequiresNonEmpty, true);

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

test("Home distinguishes valid no-change, still learning, background-off, and no-activity empty states", () => {
  const make = (lastCycle, settings = dashboard().settings) => buildHomeModel(modelSnapshot({
    dashboard: dashboard({ lastCycle, settings }),
  })).emptyState;
  assert.equal(make({
    outcome: "valid-no-change", triggerClass: "idle", mode: "auto",
    observationCount: 1, eligibilityCount: 1, proposalId: null, occurredAt: 900, reason: "no-change",
  }).heading, "No useful change found");
  assert.equal(make({
    outcome: "not-eligible", triggerClass: "idle", mode: "auto",
    observationCount: 1, eligibilityCount: 0, proposalId: null, occurredAt: 900, reason: "insufficient-evidence",
  }).heading, "Still learning");
  assert.equal(make(null, {
    ...dashboard().settings,
    consent: { ...dashboard().settings.consent, passiveCalls: false },
  }).heading, "Background analysis is off");
  assert.equal(make(null).heading, "No activity yet");
});

test("Home exposes fresh-install guidance and labels inactive cross-project learning honestly", () => {
  const value = dashboard();
  const freshDashboard = dashboard({
    automation: { state: "on-demand", reason: null },
    blockers: [{
      code: "first-run",
      summary: "Automatic recommendations have not been set up yet.",
      destination: "home",
    }],
    settings: {
      ...value.settings,
      globalMode: "manual",
      effectiveMode: "manual",
      consent: {
        passiveCalls: false,
        durableObservations: false,
        sanitizedExcerpts: false,
        crossRepoAggregation: false,
      },
    },
  });
  const snapshot = modelSnapshot({ dashboard: freshDashboard });
  const home = buildHomeModel(snapshot);
  assert.equal(home.operational.destination.section, "settings");
  assert.match(home.operational.explanation, /Auto mode.*Background analysis.*Saved observations/u);
  const settings = buildSettingsModel(snapshot);
  assert.equal(home.firstRun, true);
  assert.equal(home.blockers[0].destination.section, "home");
  const crossProject = settings.consent.find((entry) => entry.key === "crossRepoAggregation");
  assert.equal(crossProject.label, "Cross-project learning (not active yet)");
  assert.equal(crossProject.canEnable, false);
  assert.match(crossProject.description, /No production path currently consumes/u);
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

test("duplicate TUI owners share one project runtime, poller, watcher, and immutable initial load", async (t) => {
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
  assert.equal(scheduler.intervals.size, 1);
  assert.equal(scheduler.watchers.length, 1);
  assert.equal(first.getSnapshot(), second.getSnapshot());
  assert.equal(first.getSnapshot().phase, "ready");
  assert.equal(Object.isFrozen(first.getSnapshot()), true);
  assert.equal(Object.isFrozen(first.getSnapshot().projection), true);
  assert.equal(firstApi.lifecycle.count(), 1);
  assert.equal(secondApi.lifecycle.count(), 1);

  first.dispose();
  assert.equal(__testTuiStore.registrySize(), 1);
  assert.equal(scheduler.intervals.size, 1);
  assert.equal(firstApi.lifecycle.count(), 0);
  second.dispose();
  assert.equal(__testTuiStore.registrySize(), 0);
  assert.equal(scheduler.intervals.size, 0);
  assert.equal(scheduler.watchers[0].closed, true);
  assert.equal(firstApi.event.count(), 0);
  assert.equal(secondApi.event.count(), 0);
  assert.equal(secondApi.lifecycle.count(), 0);
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
    acknowledge(projectFingerprint, ids) {
      const next = [...new Set([...(values.get(projectFingerprint) ?? []), ...ids])];
      values.set(projectFingerprint, next);
      return next;
    },
  };
  const api = apiFor(root, firstWorktree);
  const clientFactory = () => ({
    async read() {
      return Object.freeze({
        ...projection(),
        dashboard: dashboard(),
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
    dashboardVersion: null,
    projectionMode: "native",
  });
  store.acknowledgeAudits(["audit-one", "audit-two"]);
  assert.deepEqual(store.getSnapshot().acknowledgedAuditIds, ["audit-one", "audit-two"]);
  assert.equal(Object.isFrozen(store.getSnapshot().acknowledgedAuditIds), true);

  api.state.path.worktree = secondWorktree;
  api.state.path.directory = secondWorktree;
  scheduler.tick();
  await store.refresh();
  const secondFingerprint = store.getSnapshot().projectFingerprint;
  assert.notEqual(secondFingerprint, firstFingerprint);
  assert.deepEqual(store.getSnapshot().acknowledgedAuditIds, []);
  store.acknowledgeAudits(["audit-other-project"]);

  api.state.path.worktree = firstWorktree;
  api.state.path.directory = firstWorktree;
  scheduler.tick();
  await store.refresh();
  assert.equal(store.getSnapshot().projectFingerprint, firstFingerprint);
  assert.deepEqual(store.getSnapshot().acknowledgedAuditIds, ["audit-one", "audit-two"]);
  assert.deepEqual(values.get(secondFingerprint), ["audit-other-project"]);
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
        operationProtocolVersion: 1,
        index: {
          generation: "a".repeat(64),
          capabilities: ["legacy-decision-v1"],
          reviews: [{ proposalId: "proposal-feedback", state: "pending", target: "review/SKILL.md", attention: "normal" }],
          allowedActions: [],
        },
        dashboard: dashboard({
          capabilities: feedbackSupported
            ? ["control-repo-mode-v1", "decision-feedback-v1"]
            : ["control-repo-mode-v1"],
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

test("TUI store emits repository mode controls only when the exact capability and dashboard control are current", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-repo-mode-root-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-repo-mode-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const scheduler = harness();
  const submissions = [];
  let supported = false;
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, (context) => ({
    async read() {
      return {
        mode: "native",
        projectionVersion: 1,
        operationProtocolVersion: 1,
        capabilities: ["legacy-control-v1"],
        index: {
          generation: "a".repeat(64),
          capabilities: ["legacy-control-v1"],
          reviews: [],
          allowedActions: [],
        },
        dashboard: dashboard({
          capabilities: supported
            ? ["control-repo-mode-v1", "decision-feedback-v1"]
            : ["decision-feedback-v1"],
          supportedControls: supported ? ["set-repo-mode"] : [],
        }),
        details: [],
        effectiveIndexActions: [],
        effectiveDetailActions: {},
      };
    },
    async readControlState() {
      return {
        schemaVersion: SCHEMA_VERSION,
        projectFingerprint: context.projectFingerprint,
        actor: "self-evolve-integration",
        issuedAt: 1_000,
        expiresAt: 10_000,
        settingsUpdatedAt: 900,
        settingsVersion: "b".repeat(64),
        stateRootIdentity: context.stateRootIdentity,
        nonce: "repository-mode-control-nonce",
        mode: "auto",
        effectiveMode: "auto",
        allowedSkillRoots: [worktree],
        consent: {
          passiveCalls: true,
          durableObservations: true,
          sanitizedExcerpts: false,
          crossRepoAggregation: false,
        },
        repoExcluded: false,
      };
    },
    async submitControl(request) {
      submissions.push(request);
    },
  }), { now: () => 1_100 }));
  await store.refresh();
  await assert.rejects(
    store.submitControl("set-repo-mode", { mode: "manual" }),
    /repository-mode-control-not-supported/u,
  );
  assert.equal(submissions.length, 0);

  supported = true;
  await store.refresh();
  const request = await store.submitControl("set-repo-mode", { mode: "manual" });
  assert.equal(request.action, "set-repo-mode");
  assert.deepEqual(request.payload, { mode: "manual" });
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
      action: "set-paused",
      capability: "operation-pause-v1",
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
      async readControlState() {
        return {
          schemaVersion: SCHEMA_VERSION,
          projectFingerprint: "a".repeat(64),
          actor: "self-evolve-integration",
          issuedAt: 1_000,
          expiresAt: 10_000,
          settingsUpdatedAt: 900,
          settingsVersion: "b".repeat(64),
          stateRootIdentity: "c".repeat(64),
          nonce: "raw-control-nonce",
          mode: "auto",
          effectiveMode: "auto",
          allowedSkillRoots: [worktree],
          consent: dashboard().settings.consent,
          repoExcluded: false,
        };
      },
      async readInbox() { return [{ id: proposalId }]; },
      async submitDecision(request) { writes.push(request); },
      async submitControl(request) { writes.push(request); },
      async submitOperation(request) { writes.push(request); },
    }), { now: () => 1_100 }));
    await store.refresh();
    const snapshot = store.getSnapshot();
    assert.deepEqual(buildRecommendationsModel(snapshot).selected?.actions ?? [], []);
    assert.deepEqual(buildSettingsModel(snapshot).controls, {
      globalMode: false,
      repositoryMode: false,
      consent: false,
      projectInclusion: false,
      approvedSkillFolders: false,
      pause: false,
      emergencyStop: false,
    });
    assert.deepEqual(buildSettingsModel(snapshot).maintenance, {
      scopes: buildSettingsModel(snapshot).maintenance.scopes,
      canExport: false,
      canDeleteScope: false,
      canDeleteAll: false,
    });
    await assert.rejects(store.submitDecision({ proposalId, newState: "rejected" }), /native.*protocol/u);
    await assert.rejects(store.submitControl("set-mode", { mode: "manual" }), /native.*protocol/u);
    await assert.rejects(store.submitOperation("set-paused", { paused: true }), /native.*protocol/u);
    assert.equal(writes.length, 0);
    if (mode === "read-only") {
      negotiatedMode = "native";
      negotiatedOperationProtocolVersion = 1;
      await store.refresh();
      await assert.rejects(store.submitOperation("set-paused", { paused: true }), /operation-not-authorized/u);
      assert.equal(writes.length, 0, "an empty effective list never falls back to the raw index grant");
      await store.submitControl("set-mode", { mode: "manual" });
      assert.equal(writes.length, 1, "a matching native peer still submits supported controls");
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
    effectiveIndexActions: state === "fresh" ? [{ action: "set-kill-switch" }] : [{ action: "set-paused" }],
    effectiveDetailActions: {
      [proposalId]: state === "fresh" ? [{ action: "reject-proposal" }] : [{ action: "apply-proposal" }],
    },
  });
  const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, () => ({
    async read() {
      if (state === "expired") throw new Error(`expired-projection:${"private".repeat(80)}`);
      return projectionFor();
    },
    async readControlState() {
      return {
        schemaVersion: SCHEMA_VERSION,
        projectFingerprint: "a".repeat(64),
        actor: "self-evolve-integration",
        issuedAt: 1_000,
        expiresAt: 10_000,
        settingsUpdatedAt: 900,
        settingsVersion: "b".repeat(64),
        stateRootIdentity: "c".repeat(64),
        nonce: "stale-retry-control-nonce",
        mode: "auto",
        effectiveMode: "auto",
        allowedSkillRoots: [worktree],
        consent: dashboard().settings.consent,
        repoExcluded: false,
      };
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
  assert.equal(expired.controlState, null);
  assert.deepEqual(expired.projection.effectiveIndexActions, []);
  assert.deepEqual(expired.projection.effectiveDetailActions[proposalId], []);
  assert.equal(expired.pending.length, 1);
  await assert.rejects(store.submitControl("set-mode", { mode: "manual" }), /native-operation-protocol-unavailable/u);

  state = "fresh";
  await store.refresh();
  const fresh = store.getSnapshot();
  assert.equal(fresh.phase, "ready");
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.projection.effectiveIndexActions.map((entry) => entry.action), ["set-kill-switch"]);
  assert.deepEqual(buildRecommendationsModel(fresh).selected.actions.map((entry) => entry.action), ["reject-proposal"]);
  assert.equal(buildSettingsModel(fresh).controls.pause, false);
  assert.equal(buildSettingsModel(fresh).controls.emergencyStop, true);
  store.dispose();
});

test("authority preflight waits for replacement reads and fails closed before every submit boundary", async (t) => {
  for (const kind of ["decision", "control", "operation"]) {
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
    const authorized = () => ({
      mode: "native",
      projectionVersion: 1,
      operationProtocolVersion: 1,
      index: {
        generation: "a".repeat(64),
        reviews: [{ proposalId, state: "pending", target: "review/SKILL.md", attention: "normal" }],
        allowedActions: [],
      },
      dashboard: dashboard(),
      details: [],
      effectiveIndexActions: [{ action: "set-paused" }],
      effectiveDetailActions: {
        [proposalId]: [{ action: "reject-proposal" }, { action: "snooze-proposal" }],
      },
    });
    const controlState = {
      schemaVersion: SCHEMA_VERSION,
      projectFingerprint: "a".repeat(64),
      actor: "self-evolve-integration",
      issuedAt: 1_000,
      expiresAt: 10_000,
      settingsUpdatedAt: 900,
      settingsVersion: "b".repeat(64),
      stateRootIdentity: "c".repeat(64),
      nonce: `preflight-${kind}-nonce`,
      mode: "auto",
      effectiveMode: "auto",
      allowedSkillRoots: [worktree],
      consent: dashboard().settings.consent,
      repoExcluded: false,
    };
    const store = acquireProjectTuiStore(options(apiFor(root, worktree), scheduler, () => ({
      read() {
        reads += 1;
        if (reads === 2) return new Promise((resolve) => { resolveReplacement = resolve; });
        if (expireFollowUp) throw new Error("expired-projection");
        return authorized();
      },
      async readControlState() { return controlState; },
      async readInbox() {
        return [{
          id: proposalId,
          skillTarget: { currentHash: "d".repeat(64) },
          proposedContentHash: "e".repeat(64),
          decisionVersion: 0,
        }];
      },
      async submitDecision(request) { writes.push(request); },
      async submitControl(request) { writes.push(request); },
      async submitOperation(request) { writes.push(request); },
    }), { now: () => 1_100 }));
    await store.refresh();

    const replacement = store.refresh();
    await settle();
    const submission = kind === "decision"
      ? store.submitDecision({ proposalId, newState: "rejected" })
      : kind === "control"
        ? store.submitControl("set-mode", { mode: "manual" })
        : store.submitOperation("snooze-proposal", { snoozedUntil: 5_000 }, { proposalId });
    expireFollowUp = true;
    resolveReplacement(authorized());
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
  assert.equal(scheduler.watchers.length, 0);
  assert.equal(scheduler.intervals.size, 1);

  scheduler.tick();
  await settle();
  assert.equal(scheduler.watchers.length, 1);
  const replacement = scheduler.watchers[0];
  replacement.callback("rename");
  await settle();
  assert.equal(replacement.closed, true);
  scheduler.tick();
  await settle();
  assert.equal(scheduler.watchers.length, 2);
  assert.equal(reads, 4);
  assert.equal(scheduler.intervals.size, 1);
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
    requestId: "control-expiry",
    kind: "control",
    action: "set-consent",
    subject: "consent:passiveCalls",
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
  const atControlExpiry = store.getSnapshot();
  assert.deepEqual(atControlExpiry.pending.map((entry) => entry.requestId), ["operation-expiry"]);
  assert.deepEqual(atControlExpiry.responses.map((entry) => [entry.requestId, entry.response.status]), [
    ["decision-expiry", "expired"],
    ["control-expiry", "expired"],
  ]);
  assert.equal(atControlExpiry.responses.every((entry) => entry.response.ok === false), true);
  assert.equal(atControlExpiry.responses.every((entry) => entry.response.reason === "response-not-received-before-expiry"), true);

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

test("real decision, control, and operation submissions track authoritative deadlines and retry with fresh authority", async (t) => {
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
      action: "set-paused",
      capability: UI_ACTION_CAPABILITIES["set-paused"],
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
        storedMode: "auto",
        effectiveMode: "auto",
        paused: false,
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
          operationProtocolVersion: 1,
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
      async readControlState() {
        return {
          schemaVersion: SCHEMA_VERSION,
          projectFingerprint: context.projectFingerprint,
          actor: "self-evolve-integration",
          issuedAt: 900,
          expiresAt: 6_000,
          settingsUpdatedAt: 900,
          settingsVersion: "f".repeat(64),
          stateRootIdentity: context.stateRootIdentity,
          nonce: "control-nonce",
          mode: "auto",
          effectiveMode: "auto",
          allowedSkillRoots: [worktree],
          consent: dashboard().settings.consent,
          repoExcluded: false,
        };
      },
      async submitDecision(request) { submissions.push(request); },
      async submitControl(request) { submissions.push(request); },
      async submitOperation(request) { submissions.push(request); },
      async reconcilePending(entries) { return { pending: entries, responses: [] }; },
    };
  }, { now: () => now }));
  await store.refresh();

  const firstDecision = await store.submitDecision({ proposalId, newState: "approved" });
  await store.submitControl("set-consent", { key: "passiveCalls", enabled: true });
  const operation = await store.submitOperation("set-paused", { paused: true });
  const pending = new Map(store.getSnapshot().pending.map((entry) => [entry.requestId, entry]));
  assert.equal(pending.get(firstDecision.requestId).expiresAt, 1_000 + BRIDGE_TTL_MS);
  assert.equal([...pending.values()].find((entry) => entry.kind === "control").expiresAt, 6_000);
  assert.equal(pending.get(operation.requestId).expiresAt, operation.expiresAt);
  assert.equal(operation.expiresAt, 31_000);

  now = 1_000 + BRIDGE_TTL_MS;
  await store.refresh();
  decisionNonce = "decision-nonce-2";
  const retried = await store.submitDecision({ proposalId, newState: "approved" });
  assert.notEqual(retried.requestId, firstDecision.requestId);
  assert.notEqual(retried.nonce, firstDecision.nonce);
  assert.equal(retried.nonce, decisionNonce);
  assert.equal(submissions.length, 4);
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
      kind: "control",
      action: "set-consent",
      subject: `consent:${index}`,
      submittedAt: 100,
      expiresAt: 1_000,
    });
  }
  await assert.rejects(store.trackPending({
    requestId: "capacity-overflow",
    kind: "control",
    action: "set-consent",
    subject: "consent:overflow",
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
      return {
        ...projection(),
        dashboard: dashboard(),
      };
    },
    async readControlState() {
      return {
        schemaVersion: SCHEMA_VERSION,
        projectFingerprint: context.projectFingerprint,
        actor: "self-evolve-integration",
        issuedAt: 1_000,
        expiresAt: 10_000,
        settingsUpdatedAt: 900,
        settingsVersion: "b".repeat(64),
        stateRootIdentity: context.stateRootIdentity,
        nonce: "concurrent-control-nonce",
        mode: "auto",
        effectiveMode: "auto",
        allowedSkillRoots: [worktree],
        consent: dashboard().settings.consent,
        repoExcluded: false,
      };
    },
    async submitControl(request) { submissions.push(request); },
    async reconcilePending(entries) { return { pending: entries, responses: [] }; },
  }), { now: () => 1_100 }));
  await store.refresh();
  const results = await Promise.allSettled([
    store.submitControl("set-mode", { mode: "manual" }),
    store.submitControl("set-mode", { mode: "manual" }),
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
