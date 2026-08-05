import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
    onDispose(callback) { disposers.push(callback); },
    abort() { controller.abort(); },
    dispose() {
      for (const callback of disposers.splice(0)) callback();
    },
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
    state: { path: { state: root, worktree, directory: worktree } },
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
    index: Object.freeze({ generation: generation.repeat(64) }),
    details: Object.freeze([]),
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

test("one operational precedence drives truthful sidebar destinations and never renders raw identifiers", () => {
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
    }) }), "settings"],
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
    assert.equal(sidebar.destination.section, operational.destination.section);
    assert.equal(sidebar.summary, expectedState === "ready" ? "Watching this project" : operational.label);
    assert.doesNotMatch(JSON.stringify(sidebar), /private-proposal-id|[a-f0-9]{64}/u);
  }
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
    "projection?.index?.allowedActions",
    'granted().has("set-paused")',
    'granted().has("set-kill-switch")',
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
    "submitControlAndWait",
    "One confirmation enables background AI analysis",
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
  const automaticSetup = source.slice(source.indexOf("const enableAutomaticRecommendations"), source.indexOf("const automaticRecommendationsReady"));
  assert.ok(automaticSetup.indexOf('key: "passiveCalls"') < automaticSetup.indexOf('key: "durableObservations"'));
  assert.ok(automaticSetup.indexOf('key: "durableObservations"') < automaticSetup.indexOf('mode: "auto"'));
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
  const value = dashboard();
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

  first.dispose();
  assert.equal(__testTuiStore.registrySize(), 1);
  assert.equal(scheduler.intervals.size, 1);
  second.dispose();
  assert.equal(__testTuiStore.registrySize(), 0);
  assert.equal(scheduler.intervals.size, 0);
  assert.equal(scheduler.watchers[0].closed, true);
  assert.equal(firstApi.event.count(), 0);
  assert.equal(secondApi.event.count(), 0);
});

test("project and worktree changes isolate runtimes and rebind on official path events", async (t) => {
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
  api.event.emit("workspace.updated");
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
  api.event.emit("workspace.updated");
  await store.refresh();
  const secondFingerprint = store.getSnapshot().projectFingerprint;
  assert.notEqual(secondFingerprint, firstFingerprint);
  assert.deepEqual(store.getSnapshot().acknowledgedAuditIds, []);
  store.acknowledgeAudits(["audit-other-project"]);

  api.state.path.worktree = firstWorktree;
  api.state.path.directory = firstWorktree;
  api.event.emit("workspace.updated");
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
        responses: entries.map((entry) => ({ ...entry, response: { ok: true, status: "completed" } })),
      };
    },
  })));
  await store.trackPending({
    requestId: "request-1",
    kind: "operation",
    action: "export-data",
    submittedAt: 123,
  });
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.pending, []);
  assert.equal(snapshot.responses.length, 1);
  assert.equal(snapshot.responses[0].requestId, "request-1");
  assert.equal(Object.isFrozen(snapshot.responses), true);
  assert.equal(Object.isFrozen(snapshot.responses[0]), true);
  store.dispose();
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
