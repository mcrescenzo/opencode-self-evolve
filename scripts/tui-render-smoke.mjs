import assert from "node:assert/strict";

assert.match(
  import.meta.resolve("solid-js"),
  /\/dist\/(?:dev|solid)\.js$/u,
  "render smoke requires Bun's browser condition so OpenTUI receives Solid's reactive client runtime",
);
await import("@opentui/solid/runtime-plugin-support");
const { testRender } = await import("@opentui/solid");

const moduleSpecifier = process.argv[2] ?? new URL("../self-evolve-tui.generated.js", import.meta.url).href;
const tuiModule = await import(moduleSpecifier);

function dashboard(lastCycle = null) {
  return {
    generatedAt: 1_000,
    automation: { state: "ready", reason: null },
    blockers: [],
    inFlight: { active: false, count: 0, stage: null, startedAt: null },
    lastCycle,
    nextEligibleAt: null,
    usage: {
      provider: { used: 1, limit: 3, remaining: 2, resetAt: 2_000 },
      synthesis: { used: 1, limit: 2, remaining: 1, resetAt: 3_000 },
      storage: { usedBytes: 100, limitBytes: 1_000, remainingBytes: 900 },
    },
    rollout: null,
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
      approvedSkillFolderCount: 0,
      collectionSuggestions: [],
      globalSettingsVersion: "b".repeat(64),
      globalRootPolicy: null,
      globalRootPolicyConfirmation: "REPLACE GLOBAL ROOT POLICY bbbbbbbbbbbb",
      globalRootPolicyAction: {
        action: "replace-global-root-policy",
        capability: "operation-global-root-policy-v1",
        nonce: "root-policy-operation-nonce",
        expiresAt: 10_000,
      },
    },
    retention: { observationsDays: 30, operationalDays: 90 },
    capabilities: ["decision-feedback-v1", "operation-global-root-policy-v1", "project-participation-v1"],
    supportedControls: ["replace-global-root-policy", "set-automatic-recommendations", "set-kill-switch", "set-permission", "set-repo-excluded"],
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
  };
}

function snapshot(lastCycle = null, identity = "a") {
  const dashboardValue = dashboard(lastCycle);
  const value = {
    phase: "ready",
    updatedAt: 1_000,
    pending: [],
    responses: [],
    acknowledgedOutcomes: [],
    dashboard: dashboardValue,
    dashboardError: null,
    controlState: null,
    tuiHealth: {
      projectFingerprint: identity?.repeat(64),
      stateRootIdentity: "f".repeat(64),
      expiresAt: 10_000,
    },
    latestExport: null,
    inspection: null,
    watcher: "polling",
    error: null,
    runtime: {
      hostVersion: "1.18.3",
      hostVersionSource: "test",
      pluginVersion: "0.4.0",
      projectionVersion: 1,
      dashboardVersion: 3,
      projectionMode: "native",
    },
    projection: {
      mode: "native",
      projectionVersion: 1,
      operationProtocolVersion: 2,
      capabilities: ["automatic-recommendations-control-v1", "legacy-decision-v1"],
      dashboard: dashboardValue,
      dashboardError: null,
      index: {
        generation: "a".repeat(64),
        projectionVersion: 1,
        projectFingerprint: identity?.repeat(64),
        stateRootIdentity: "f".repeat(64),
        capabilities: ["automatic-recommendations-control-v1", "legacy-decision-v1"],
        allowedActions: [],
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
          automaticRecommendationsEnabled: true,
          killSwitchActive: false,
          repoExcluded: false,
          circuitBreakerOpen: false,
        },
        reviews: [],
        operations: [],
      },
      details: [],
      effectiveIndexActions: [
        { action: "set-automatic-recommendations" },
        { action: "set-permission" },
        { action: "set-repo-excluded" },
        { action: "replace-global-root-policy" },
        { action: "export-data" },
        { action: "purge-scope" },
        { action: "purge-all" },
      ],
      effectiveDetailActions: {},
    },
  };
  if (identity !== null) {
    value.key = `root:${identity.repeat(64)}`;
    value.stateRootIdentity = "f".repeat(64);
    value.projectFingerprint = identity.repeat(64);
  }
  value.dashboard.rollout = {
    ready: true,
    synthesesObserved: 10,
    minSynthesesObserved: 10,
    successRateBasisPoints: 9_000,
    minSuccessRateBasisPoints: 8_000,
  };
  return value;
}

function recommendationSnapshot(identity) {
  const value = snapshot(null, identity);
  const proposalId = "shared-proposal";
  value.projection.index.reviews = [{
    proposalId,
    state: "pending",
    target: "review/SKILL.md",
    attention: "normal",
    updatedAt: 1_000,
  }];
  value.projection.effectiveDetailActions = {
    [proposalId]: [
      { action: "apply-proposal" },
      { action: "reject-proposal" },
    ],
  };
  return value;
}

function pendingIsolationSnapshot(identity) {
  const value = recommendationSnapshot(identity);
  value.projection.index.reviews.push({
    proposalId: "unrelated-proposal",
    state: "pending",
    target: "unrelated/SKILL.md",
    attention: "normal",
    updatedAt: 1_000,
  });
  value.projection.effectiveDetailActions["unrelated-proposal"] = [{ action: "apply-proposal" }];
  value.pending = [{
    requestId: "pending-shared-apply",
    kind: "decision",
    action: "apply-proposal",
    subject: "shared-proposal",
    submittedAt: 1_000,
    expiresAt: 2_000,
  }];
  return value;
}

function globalRecommendationSnapshot(identity, {
  state = "pending",
  contributed = true,
  pending = [],
  responses = [],
} = {}) {
  const value = snapshot(null, identity);
  const recommendationId = "1".repeat(64);
  const supportSetHash = "2".repeat(64);
  const detailHash = "3".repeat(64);
  const availableActions = state === "pending" ? ["apply", "reject"] : state === "applied" ? ["undo"] : [];
  const indexEntry = {
    recommendationId,
    recommendationVersion: 1,
    supportSetHash,
    state,
    target: { kind: "existing-global-skill", label: "shared-global-review" },
    support: { tier: "distributed", independentDomainCount: 2, independentIncidentCount: 3, occurrenceCount: 7 },
    dates: { firstSeenDay: "2026-08-01", lastSeenDay: "2026-08-11", synthesizedAt: 700, updatedAt: 900 },
    safety: { criticScoreBasisPoints: 9_750, criticPassed: true, validDeterministic: true },
    availableActions,
    detailHash,
  };
  value.participation = { [recommendationId]: contributed };
  value.pending = pending;
  value.responses = responses;
  value.global = {
    phase: "ready",
    stateRootIdentity: value.stateRootIdentity,
    selectedRecommendationIds: [recommendationId],
    pending,
    responses,
    projection: {
      mode: "native",
      label: "authoritative-global-v1",
      operationProtocolVersion: 1,
      capabilities: ["project-participation-v1"],
      indexBytes: "byte-identical-global-index",
      index: { recommendations: [indexEntry] },
      details: [{
        recommendationId,
        recommendationVersion: 1,
        detailHash,
        priorState: state,
        target: indexEntry.target,
        support: { ...indexEntry.support, firstSeenDay: "2026-08-01", lastSeenDay: "2026-08-11" },
        safety: indexEntry.safety,
        generality: { passed: true, basis: "deterministic-generality-gate-v1" },
        rationale: "Independent identity-free support warrants one bounded update to an existing global skill.",
        diff: { kind: "existing-file", lines: ["+# Shared global review", "+Bounded reusable guidance."], overflow: { truncated: false } },
        evidenceSummary: [
          { kind: "independent-domains", count: 2 },
          { kind: "independent-incidents", count: 3 },
          { kind: "occurrences", count: 7 },
        ],
        availableActions,
      }],
      grants: availableActions.map((action, index) => ({
        recommendationId,
        action,
        grantHash: String(index + 4).repeat(64),
      })),
    },
  };
  return value;
}

function withIdentity(value, identity) {
  const next = structuredClone(value);
  for (const key of ["key", "stateRootIdentity", "projectFingerprint"]) {
    if (Object.hasOwn(identity, key)) {
      if (identity[key] === null) delete next[key];
      else next[key] = identity[key];
    }
  }
  return next;
}

function projectStore(initial) {
  let current = initial;
  let retrySnapshot = null;
  const listeners = new Set();
  const decisions = [];
  const controls = [];
  const operations = [];
  const globalActions = [];
  const detailSelections = [];
  return {
    decisions,
    controls,
    operations,
    globalActions,
    detailSelections,
    getSnapshot() { return current; },
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    emit(next) {
      current = next;
      for (const listener of listeners) listener(current);
    },
    setRetrySnapshot(next) { retrySnapshot = next; },
    refresh() {
      if (retrySnapshot) {
        const next = retrySnapshot;
        retrySnapshot = null;
        this.emit(next);
      }
      return Promise.resolve(current);
    },
    selectDetails(ids) { detailSelections.push(ids); return Promise.resolve(current); },
    submitControl(action, payload) { controls.push({ action, payload, projectFingerprint: current.projectFingerprint }); return Promise.resolve({ ok: true }); },
    submitDecision(value) { decisions.push({ projectFingerprint: current.projectFingerprint, value }); return Promise.resolve({ ok: true }); },
    submitRecommendationAction(recommendationId, action) {
      globalActions.push({ recommendationId, action, projectFingerprint: current.projectFingerprint });
      return Promise.resolve({ ok: true });
    },
    submitOperation(action, payload) {
      operations.push({ action, payload, projectFingerprint: current.projectFingerprint });
      return Promise.resolve({ ok: true });
    },
    acknowledgeOutcome(subjectId) {
      current = structuredClone(current);
      const globalReview = current.global?.projection?.index?.recommendations?.find((entry) => entry.recommendationId === subjectId);
      const globalDetail = current.global?.projection?.details?.find((entry) => entry.recommendationId === subjectId);
      const projectReview = current.projection?.index?.reviews?.find((entry) => entry.proposalId === subjectId);
      const projectDetail = current.projection?.details?.find((entry) => entry.proposalId === subjectId);
      const binding = globalReview && globalDetail
        ? {
            scope: "global",
            subjectId,
            version: `${globalDetail.recommendationVersion ?? globalReview.recommendationVersion}:${globalDetail.detailHash ?? globalReview.detailHash}`,
            auditIds: [globalDetail.detailHash ?? globalReview.detailHash],
            acknowledgedAt: 1_000,
          }
        : projectReview && projectDetail
          ? {
              scope: "project",
              subjectId,
              version: projectDetail.detailHash ?? projectReview.detailHash,
              auditIds: projectDetail.audit.filter((entry) => entry.kind === "apply").map((entry) => entry.id).sort(),
              acknowledgedAt: 1_000,
            }
          : null;
      if (binding) current.acknowledgedOutcomes = [...current.acknowledgedOutcomes, binding];
      for (const listener of listeners) listener(current);
      return current;
    },
    acknowledgeGlobalFailure(requestId) {
      current = structuredClone(current);
      const entry = current.global?.responses?.find((response) => response.requestId === requestId);
      if (entry?.response?.ok === false) {
        current.acknowledgedOutcomes = [...current.acknowledgedOutcomes, {
          scope: "global",
          subjectId: requestId,
          version: `${entry.response.status ?? "failed"}:${entry.response.processedAt ?? entry.expiresAt}:${requestId}`,
          auditIds: [requestId],
          acknowledgedAt: 1_000,
        }];
      }
      for (const listener of listeners) listener(current);
      return current;
    },
  };
}

function hostApi() {
  const controller = new AbortController();
  const disposers = [];
  const routes = [];
  const layers = [];
  const slots = [];
  const kv = new Map();
  const api = {
    kv: {
      get(key, fallback) { return kv.has(key) ? kv.get(key) : fallback; },
      set(key, value) { kv.set(key, value); },
    },
    state: {
      path: { state: "/state", worktree: "/worktree", directory: "/worktree" },
      session: { status: () => ({ type: "idle", since: 0 }) },
    },
    event: { on() { return () => {}; } },
    lifecycle: {
      signal: controller.signal,
      onDispose(dispose) { disposers.push(dispose); return () => {}; },
    },
    ui: {
      dialog: { replace(render) { return render(); }, clear() {}, setSize() {} },
      DialogAlert(props) { return props; },
      DialogConfirm(props) { return props; },
      DialogPrompt(props) { return props; },
      DialogSelect(props) { return props; },
    },
    route: {
      current: { name: "session", params: {} },
      register(values) { routes.push(...values); return () => {}; },
      navigate(name, params) { api.route.current = { name, ...(params ? { params } : {}) }; },
    },
    mode: { push() { return () => {}; } },
    keymap: { registerLayer(layer) { layers.push(layer); return () => {}; } },
    slots: { register(value) { slots.push(value); } },
    theme: {
      current: {
        text: "#ffffff",
        textMuted: "#999999",
        borderActive: "#00ffff",
        borderSubtle: "#555555",
        info: "#00aaff",
        warning: "#ffaa00",
        error: "#ff0000",
        success: "#00ff00",
      },
    },
  };
  return {
    api,
    layers,
    routes,
    slots,
    async dispose() {
      controller.abort();
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}

async function renderRoute(route, api, params, dimensions = { width: 140, height: 300 }) {
  api.route.current = { name: route.name, params };
  const setup = await testRender(() => route.render(), dimensions);
  await setup.flush();
  return setup;
}

function framePoint(setup, label, occurrence = 0) {
  const lines = setup.captureCharFrame().split("\n");
  const matches = lines.flatMap((line, y) => {
    const points = [];
    let from = 0;
    while (from <= line.length) {
      const x = line.indexOf(label, from);
      if (x < 0) break;
      points.push({ x: x + Math.floor(label.length / 2), y });
      from = x + label.length;
    }
    return points;
  });
  const point = occurrence < 0 ? matches.at(occurrence) : matches[occurrence];
  const y = point?.y ?? -1;
  assert.notEqual(y, -1, `rendered frame did not include ${label}\n${lines.join("\n")}`);
  return point;
}

async function clickLabel(setup, label, occurrence = 0) {
  const point = framePoint(setup, label, occurrence);
  await setup.mockMouse.click(point.x, point.y);
  await setup.flush();
}

async function typeInto(setup, placeholder, text, occurrence = 0) {
  await clickLabel(setup, placeholder, occurrence);
  await setup.mockInput.typeText(text);
  await setup.flush();
}

async function armAllProjectState(setup) {
  await clickLabel(setup, "Recommendations");
  await clickLabel(setup, "Other");
  await typeInto(setup, "Optional bounded reason", "A-only rejection reason");
  await clickLabel(setup, "Apply Proposal");
  assert.match(setup.captureCharFrame(), /Confirm Apply Proposal/u);

  await clickLabel(setup, "Settings");
  await clickLabel(setup, "Everything");
  await clickLabel(setup, "Delete selected scope");
  await typeInto(setup, "PURGE ALL SELF-EVOLVE 0.4.0", "PURGE ALL SELF-EVOLVE 0.4.0");
  const armed = setup.captureCharFrame();
  assert.ok(armed.includes("Delete permanently"), `armed Settings state omitted Delete permanently\n${armed}`);

  await clickLabel(setup, "Recommendations");
  const recommendation = setup.captureCharFrame();
  assert.match(recommendation, /Confirm Apply Proposal/u);
  assert.match(recommendation, /A-only rejection reason/u);
}

async function assertProjectStatePreserved(setup, host) {
  await setup.flush();
  assert.deepEqual(host.api.route.current, {
    name: "mcrescenzo.self-evolve.control-center.route",
    params: { section: "recommendations", recommendation: "shared-proposal" },
  });
  const preserved = setup.captureCharFrame();
  assert.match(preserved, /Recommendations/u);
  assert.match(preserved, /Esc returns to session/u);
  assert.doesNotMatch(preserved, /Confirm Apply Proposal|A-only rejection reason|Consent disclosure|Delete permanently/u);
}

async function assertGlobalIdentityReset(setup, host, store) {
  await setup.flush();
  assert.deepEqual(host.api.route.current, {
    name: "mcrescenzo.self-evolve.control-center.route",
    params: { section: "home" },
  });
  const reset = setup.captureCharFrame();
  assert.match(reset, /Automation and scope/u);
  assert.match(reset, /Esc returns to home/u);
  assert.doesNotMatch(reset, /Confirm Apply Proposal|A-only rejection reason|Consent disclosure|Delete permanently/u);
  assert.deepEqual(store.detailSelections.at(-1), []);
}

assert.deepEqual(Object.keys(tuiModule), ["default"]);
assert.equal(tuiModule.default?.id, "mcrescenzo.self-evolve");
assert.equal(typeof tuiModule.default?.tui, "function");

const store = projectStore(snapshot());
const host = hostApi();
const renderedSections = [];
const narrowSections = [];
try {
  await tuiModule.default.tui(host.api, {
    stateRoot: "/state",
    worktree: "/worktree",
    __testTuiStoreFactory: () => store,
  });
  const route = host.routes.find((candidate) => candidate.name === "mcrescenzo.self-evolve.control-center.route");
  assert.ok(route, "control center route was not registered");
  const sidebarSlot = host.slots.map((entry) => entry.slots?.sidebar_content).find(Boolean);
  assert.equal(typeof sidebarSlot, "function", "sidebar slot was not registered");

  const sidebar = await testRender(() => sidebarSlot(), { width: 48, height: 24 });
  try {
    await sidebar.flush();
    const card = sidebar.renderer.root.findDescendantById("self-evolve-sidebar-card");
    const off = sidebar.renderer.root.findDescendantById("self-evolve-sidebar-mode-off");
    const on = sidebar.renderer.root.findDescendantById("self-evolve-sidebar-mode-on");
    assert.ok(card && off && on, "sidebar card and binary automation segments were not rendered");
    assert.equal(card.findDescendantById?.("self-evolve-sidebar-mode-off"), undefined,
      "binary automation control was nested inside the clickable card");
    assert.equal(off.focusable, true);
    assert.equal(on.focusable, true, "selected On segment must remain independently focusable");

    host.api.route.current = { name: "session", params: { sessionID: "sidebar-automation" } };
    await clickLabel(sidebar, "Off");
    assert.deepEqual(store.operations.at(-1), {
      action: "set-automatic-recommendations",
      payload: { enabled: false },
      projectFingerprint: "a".repeat(64),
    });
    assert.deepEqual(host.api.route.current, { name: "session", params: { sessionID: "sidebar-automation" } },
      "automation segment click bubbled into the sidebar card route action");

    const offSnapshot = snapshot();
    offSnapshot.dashboard.settings.automaticRecommendationsEnabled = false;
    offSnapshot.dashboard.automation = { state: "off", reason: "automatic-recommendations-off" };
    offSnapshot.projection.index.status.automaticRecommendationsEnabled = false;
    store.emit(offSnapshot);
    await sidebar.flush();
    const onNode = sidebar.renderer.root.findDescendantById("self-evolve-sidebar-mode-on");
    onNode.focus();
    assert.equal(onNode.focused, true, "On segment did not expose a distinct focus target");
    sidebar.mockInput.pressEnter();
    await sidebar.flush();
    assert.match(sidebar.captureCharFrame(), /Confirm On/u);
    const operationsBeforeConfirm = store.operations.length;
    sidebar.mockInput.pressEnter();
    await sidebar.flush();
    assert.equal(store.operations.length, operationsBeforeConfirm + 1);
    assert.deepEqual(store.operations.at(-1).payload, { enabled: true });

    store.emit(offSnapshot);
    await sidebar.flush();
    sidebar.renderer.root.findDescendantById("self-evolve-sidebar-card").focus();
    sidebar.mockInput.pressTab();
    await sidebar.flush();
    assert.equal(sidebar.renderer.root.findDescendantById("self-evolve-sidebar-mode-off").focused, true,
      "Tab did not include the selected sibling Off control");
    sidebar.mockInput.pressTab();
    await sidebar.flush();
    assert.equal(sidebar.renderer.root.findDescendantById("self-evolve-sidebar-mode-on").focused, true,
      "Tab did not move between independently focusable binary controls");
    sidebar.mockInput.pressKey(" ");
    await sidebar.flush();
    assert.match(sidebar.captureCharFrame(), /Confirm On/u, "Space did not mirror Enter confirmation");

    const unavailableAutomation = [
      ["stale", (value) => {
        value.phase = "error";
        value.stale = true;
        value.error = "expired-project-projection";
        value.projection.effectiveIndexActions = [];
      }],
      ["pending", (value) => {
        value.pending = [{ action: "set-automatic-recommendations", subject: "automatic-recommendations" }];
      }],
      ["unsupported", (value) => {
        value.projection.effectiveIndexActions = value.projection.effectiveIndexActions
          .filter((entry) => entry.action !== "set-automatic-recommendations");
      }],
      ["limited", (value) => {
        value.global = {
          phase: "limited",
          projection: { mode: "limited", label: "limited-incompatible-global-protocol" },
          pending: [],
          responses: [],
        };
      }],
    ];
    for (const [status, mutate] of unavailableAutomation) {
      const unavailable = structuredClone(offSnapshot);
      mutate(unavailable);
      store.emit(unavailable);
      await sidebar.flush();
      const writesBeforeUnavailable = store.operations.length;
      await clickLabel(sidebar, "On");
      assert.equal(store.operations.length, writesBeforeUnavailable, `${status} automation control submitted a request`);
      assert.match(sidebar.captureCharFrame(), new RegExp(`Automatic recommendations are read-only:\\s+${status}`, "u"));
    }
    store.emit(snapshot());
    await sidebar.flush();
  } finally {
    sidebar.renderer.destroy();
  }

  const sections = [
    [{ section: "home" }, "Automation and scope"],
    [{ section: "recommendations" }, "Nothing needs review"],
    [{ section: "activity", activityFilter: "all" }, "Diagnostics"],
    [{ section: "settings" }, "Automatic recommendations"],
  ];
  for (const [params, expected] of sections) {
    const setup = await renderRoute(route, host.api, params);
    try {
      const frame = setup.captureCharFrame();
      assert.match(frame, /Self-evolve/u);
      assert.ok(frame.includes(expected), `rendered ${params.section} without ${expected}\n${frame}`);
      if (params.section === "home") {
        assert.match(frame, /Provider calls reset: 1970-01-01T00:00:02.000Z/u);
        assert.match(frame, /Recommendation synthesis resets: 1970-01-01T00:00:03.000Z/u);
      }
      renderedSections.push(params.section);
    } finally {
      setup.renderer.destroy();
    }
  }

  for (const [params, expected] of sections) {
    const setup = await renderRoute(route, host.api, params, { width: 64, height: 20 });
    try {
      const label = params.section.charAt(0).toUpperCase() + params.section.slice(1);
      await clickLabel(setup, label);
      const lines = setup.captureCharFrame().split("\n");
      const headerRow = lines.findIndex((line) => line.includes("Self-evolve"));
      const navigationRow = lines.findIndex((line) => line.includes(`› ${label}`));
      const contentRow = lines.findIndex((line, index) => index > navigationRow && line.includes(expected));
      const footerRow = lines.findIndex((line) => line.includes("Esc returns to"));
      assert.ok(lines.every((line) => line.length <= 64), `64x20 ${params.section} frame exceeded its width\n${lines.join("\n")}`);
      assert.ok(headerRow >= 0 && navigationRow > headerRow && contentRow > navigationRow && footerRow > contentRow,
        `64x20 ${params.section} shell regions overlapped or reordered\n${lines.join("\n")}`);
      assert.ok(footerRow < 20, `64x20 ${params.section} footer escaped the viewport\n${lines.join("\n")}`);
      narrowSections.push(params.section);
    } finally {
      setup.renderer.destroy();
    }
  }

  store.emit(snapshot());
  const rootEditor = await renderRoute(route, host.api, { section: "settings", settingsAnchor: "approved-skill-folders" }, { width: 140, height: 40 });
  try {
    await typeInto(rootEditor, "/canonical/path/to/skills", "/global/skills");
    await clickLabel(rootEditor, "Add folder");
    const rootScrollbox = rootEditor.renderer.root.findDescendantById("self-evolve-content-scrollbox");
    rootScrollbox.scrollChildIntoView("self-evolve-focus-local-draft-update-0");
    rootEditor.renderer.root.findDescendantById("self-evolve-focus-local-draft-update-0").focus();
    await rootEditor.flush();
    assert.match(rootEditor.captureCharFrame(), /Complete authoritative replacement/u);
    await clickLabel(rootEditor, "Allow creation");
    await clickLabel(rootEditor, "Make primary creation root");
    rootScrollbox.scrollChildIntoView("self-evolve-focus-root-policy-confirmation");
    rootEditor.renderer.root.findDescendantById("self-evolve-focus-root-policy-confirmation").focus();
    await rootEditor.flush();
    await rootEditor.mockInput.typeText("REPLACE GLOBAL ROOT POLICY bbbbbbbbbbbb");
    await rootEditor.flush();
    rootScrollbox.scrollChildIntoView("self-evolve-focus-local-Replace-authoritative-roots");
    rootEditor.renderer.root.findDescendantById("self-evolve-focus-local-Replace-authoritative-roots").focus();
    await rootEditor.flush();
    await clickLabel(rootEditor, "Replace authoritative roots");
    assert.deepEqual(store.operations.at(-1), {
      action: "replace-global-root-policy",
      payload: {
        roots: [{ canonicalPath: "/global/skills", canUpdate: true, canCreate: true }],
        creationRootPath: "/global/skills",
        confirmation: "REPLACE GLOBAL ROOT POLICY bbbbbbbbbbbb",
      },
      projectFingerprint: "a".repeat(64),
    });

    const configured = snapshot();
    const longRoot = "/global/skills/a-very-long-authoritative-collection-root-that-must-wrap-without-hiding-capabilities";
    configured.dashboard.settings.globalRootPolicy = {
      roots: [{ canonicalPath: longRoot, canUpdate: true, canCreate: true }],
      creationRootPath: longRoot,
      rootSetHash: "c".repeat(64),
      updatedAt: 900,
    };
    configured.dashboard.settings.approvedSkillFolderCount = 1;
    store.emit(configured);
    await rootEditor.flush();
    rootScrollbox.scrollChildIntoView("self-evolve-focus-local-edit-root-0");
    rootEditor.renderer.root.findDescendantById("self-evolve-focus-local-edit-root-0").focus();
    await rootEditor.flush();
    const configuredFrame = rootEditor.captureCharFrame();
    assert.match(configuredFrame, /very-long-authoritative-collection-root/u);
    assert.match(configuredFrame, /Update · Create · Primary creation root/u);
    assert.match(configuredFrame, /Edit \/global\/skills/u);
    assert.match(configuredFrame, /Remove \/global\/skills/u);
    const operationsBeforeEmptyRemove = store.operations.length;
    await clickLabel(rootEditor, `Remove ${longRoot}`);
    assert.match(rootEditor.captureCharFrame(), /At least one authoritative global root is required/u);
    assert.equal(store.operations.length, operationsBeforeEmptyRemove);
    await clickLabel(rootEditor, `Edit ${longRoot}`);
    rootScrollbox.scrollChildIntoView("self-evolve-focus-local-draft-update-0");
    rootEditor.renderer.root.findDescendantById("self-evolve-focus-local-draft-update-0").focus();
    await rootEditor.flush();
    assert.match(rootEditor.captureCharFrame(), /Update allowed/u);
    assert.match(rootEditor.captureCharFrame(), /Create allowed/u);
    assert.match(rootEditor.captureCharFrame(), /Primary creation root/u);
  } finally {
    rootEditor.renderer.destroy();
  }
  const narrowRootEditor = await renderRoute(route, host.api, { section: "settings", settingsAnchor: "approved-skill-folders" }, { width: 64, height: 20 });
  try {
    const scrollbox = narrowRootEditor.renderer.root.findDescendantById("self-evolve-content-scrollbox");
    scrollbox.scrollChildIntoView("self-evolve-focus-root-capabilities-0");
    await narrowRootEditor.flush();
    const rootFrame = narrowRootEditor.captureCharFrame();
    assert.ok(rootFrame.split("\n").every((line) => line.length <= 64), `narrow root editor exceeded 64 columns\n${rootFrame}`);
    assert.match(rootFrame, /very-long-authoritative-[\s\S]*collection-root/u);
    scrollbox.scrollChildIntoView("self-evolve-focus-local-edit-root-0");
    narrowRootEditor.renderer.root.findDescendantById("self-evolve-focus-local-edit-root-0").focus();
    await narrowRootEditor.flush();
    assert.match(narrowRootEditor.captureCharFrame(), /Edit \/global\/skills/u);
  } finally {
    narrowRootEditor.renderer.destroy();
  }

  const narrowOutcomeSnapshot = snapshot();
  narrowOutcomeSnapshot.responses = [
    {
      requestId: "outcome-success", kind: "operation", action: "set-automatic-recommendations", subject: "automatic-recommendations",
      submittedAt: 700, expiresAt: 900,
      response: { ok: true, status: "completed", processedAt: 800, reason: null },
    },
    {
      requestId: "outcome-rejected", kind: "operation", action: "set-kill-switch", subject: "project",
      submittedAt: 700, expiresAt: 900,
      response: { ok: false, status: "rejected", processedAt: 800, reason: "bounded-long-rejection-".repeat(8) },
    },
    {
      requestId: "outcome-expired", kind: "operation", action: "export-data", subject: "scope:project",
      submittedAt: 700, expiresAt: 900,
      response: { ok: false, status: "expired", processedAt: 900, reason: "response-not-received-before-expiry" },
    },
    {
      requestId: "outcome-terminal", kind: "operation", action: "purge-all", subject: "project",
      submittedAt: 700, expiresAt: 900,
      response: { ok: true, status: "accepted-terminal", processedAt: 800, reason: null },
    },
  ];
  store.emit(narrowOutcomeSnapshot);
  const narrowOutcomes = await renderRoute(route, host.api, { section: "home" }, { width: 64, height: 20 });
  try {
    const primary = narrowOutcomes.captureCharFrame();
    assert.match(primary, /Ready/u);
    assert.match(primary, /No action required/u);
    assert.doesNotMatch(primary, /bounded-long-rejection/u,
      "retained outcomes displaced Home primary state at 64x20");
    const scrollbox = narrowOutcomes.renderer.root.findDescendantById("self-evolve-content-scrollbox");
    const summary = narrowOutcomes.renderer.root.findDescendantById("self-evolve-focus-outcomes-summary");
    assert.ok(scrollbox && summary, "compact outcomes summary did not mount");
    scrollbox.scrollChildIntoView(summary.id);
    summary.focus();
    narrowOutcomes.mockInput.pressEnter();
    await narrowOutcomes.flush();
    for (const [index, expected] of [
      [0, "set automatic recommendations accepted by the server"],
      [1, "bounded-long-rejection"],
      [2, "expired without a server response"],
      [3, "Purge all accepted"],
    ]) {
      const outcome = narrowOutcomes.renderer.root.findDescendantById(`self-evolve-focus-outcome-${index}`);
      assert.ok(outcome, `retained outcome ${index} was not keyboard reachable`);
      scrollbox.scrollChildIntoView(outcome.id);
      outcome.focus();
      await narrowOutcomes.flush();
      assert.match(narrowOutcomes.captureCharFrame(), new RegExp(expected, "iu"));
    }
  } finally {
    narrowOutcomes.renderer.destroy();
  }

  const keyboardSnapshot = snapshot();
  keyboardSnapshot.dashboard.activity = [
    {
      id: "a".repeat(64),
      category: "cycle",
      audience: "default",
      outcome: "valid-no-change",
      summary: "First keyboard activity row",
      occurredAt: 900,
      proposalId: null,
      reason: "no-change",
    },
    {
      id: "b".repeat(64),
      category: "cycle",
      audience: "default",
      outcome: "not-eligible",
      summary: "Second keyboard activity row",
      occurredAt: 800,
      proposalId: null,
      reason: "insufficient-evidence",
    },
  ];
  store.emit(keyboardSnapshot);
  const keyboard = await renderRoute(route, host.api, { section: "activity", activityFilter: "all" });
  try {
    await clickLabel(keyboard, "First keyboard activity row");
    assert.match(keyboard.captureCharFrame(), /› \[Info\] \[Current project\] First keyboard activity row[\s\S]*Category: cycle/u);
    keyboard.mockInput.pressEnter();
    await keyboard.flush();
    assert.doesNotMatch(keyboard.captureCharFrame(), /Category: cycle/u, "Enter did not mirror pointer row activation");
    keyboard.mockInput.pressKey(" ");
    await keyboard.flush();
    assert.match(keyboard.captureCharFrame(), /Category: cycle/u, "Space did not mirror pointer row activation");
    keyboard.mockInput.pressArrow("down");
    await keyboard.flush();
    assert.match(keyboard.captureCharFrame(), /› \[Info\] \[Current project\] Second keyboard activity row/u);
    keyboard.mockInput.pressArrow("up");
    await keyboard.flush();
    assert.match(keyboard.captureCharFrame(), /› \[Info\] \[Current project\] First keyboard activity row/u);

    await clickLabel(keyboard, "Activity", 0);
    keyboard.mockInput.pressTab();
    await keyboard.flush();
    assert.match(keyboard.captureCharFrame(), /› Settings/u);
    keyboard.mockInput.pressTab({ shift: true });
    await keyboard.flush();
    assert.match(keyboard.captureCharFrame(), /› Activity/u);
  } finally {
    keyboard.renderer.destroy();
  }

  store.emit(snapshot());
  const activityDeepLink = await renderRoute(route, host.api, { section: "activity", activityFilter: "errors" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await activityDeepLink.flush();
    assert.match(activityDeepLink.captureCharFrame(), /› Errors/u);
  } finally {
    activityDeepLink.renderer.destroy();
  }

  const invalidRouteSnapshot = recommendationSnapshot("a");
  invalidRouteSnapshot.projection.index.reviews[0].state = "applied";
  store.emit(invalidRouteSnapshot);
  const invalidRoute = await renderRoute(route, host.api, {
    section: "home",
    recommendation: "stale-cross-project-recommendation",
  });
  try {
    assert.match(invalidRoute.captureCharFrame(), /Automation and scope/u);
    await clickLabel(invalidRoute, "Recommendations");
    assert.match(invalidRoute.captureCharFrame(), /Nothing needs review/u,
      "invalid route leaked an applied recommendation filter into the Home fallback");
  } finally {
    invalidRoute.renderer.destroy();
  }

  const localRemovalSnapshot = recommendationSnapshot("a");
  store.emit(localRemovalSnapshot);
  const localRemoval = await renderRoute(route, host.api, {
    section: "recommendations",
    recommendation: "shared-proposal",
  });
  try {
    const selectedRow = localRemoval.renderer.root.findDescendantById("self-evolve-focus-recommendation-row-0");
    assert.ok(selectedRow, "local recommendation row did not mount");
    selectedRow.focus();
    const removed = structuredClone(localRemovalSnapshot);
    removed.projection.index.reviews = [];
    removed.projection.details = [];
    removed.projection.effectiveDetailActions = {};
    store.emit(removed);
    await localRemoval.flush();
    assert.deepEqual(host.api.route.current, {
      name: "mcrescenzo.self-evolve.control-center.route",
      params: { section: "home" },
    }, "local recommendation removal retained stale route params");
    assert.match(localRemoval.captureCharFrame(), /Automation and scope/u);
    assert.deepEqual(store.detailSelections.at(-1), [], "local recommendation removal retained detail selection");
    assert.equal(selectedRow.focused, false, "removed local recommendation retained focus");
  } finally {
    localRemoval.renderer.destroy();
  }

  const incompatibleSource = globalRecommendationSnapshot("a");
  store.emit(incompatibleSource);
  const incompatibleSwitch = await renderRoute(route, host.api, {
    section: "recommendations",
    recommendation: "1".repeat(64),
  });
  try {
    const selectedGlobalRow = incompatibleSwitch.renderer.root.findDescendantById("self-evolve-focus-recommendation-row-0");
    assert.ok(selectedGlobalRow, "global recommendation row did not mount before incompatible switch");
    selectedGlobalRow.focus();
    const incompatible = recommendationSnapshot("b");
    incompatible.global = {
      phase: "limited",
      stateRootIdentity: incompatible.stateRootIdentity,
      pending: [],
      responses: [],
      projection: {
        mode: "limited",
        label: "limited-new-tui-old-server",
        operationProtocolVersion: null,
        index: null,
        details: [],
        grants: [],
      },
    };
    store.emit(incompatible);
    await incompatibleSwitch.flush();
    assert.deepEqual(store.detailSelections.at(-1), [], "incompatible project switch retained global details");
    assert.deepEqual(host.api.route.current, {
      name: "mcrescenzo.self-evolve.control-center.route",
      params: { section: "home" },
    }, "incompatible project switch retained a stale global recommendation route");
    assert.match(incompatibleSwitch.captureCharFrame(), /Automation and scope/u);
    assert.equal(selectedGlobalRow.focused, false, "incompatible project switch retained stale global focus");
  } finally {
    incompatibleSwitch.renderer.destroy();
  }

  const settingsDeepLink = await renderRoute(route, host.api, { section: "settings", settingsAnchor: "provider" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settingsDeepLink.flush();
    assert.match(settingsDeepLink.captureCharFrame(), /› Opened at provider settings/u);
  } finally {
    settingsDeepLink.renderer.destroy();
  }

  const firstRunSnapshot = snapshot();
  firstRunSnapshot.dashboard.automation = { state: "setup-required", reason: "first-run" };
  firstRunSnapshot.dashboard.blockers = [{
    code: "first-run",
    summary: "Automatic recommendations have not been set up yet.",
    destination: "settings",
  }];
  firstRunSnapshot.dashboard.settings.automaticRecommendationsEnabled = false;
  firstRunSnapshot.projection.index.status.automaticRecommendationsEnabled = false;
  store.emit(firstRunSnapshot);
  const firstRunDestination = firstRunSnapshot.dashboard.blockers[0];
  assert.equal(firstRunDestination.destination, "settings");
  const firstRunDeepLink = await renderRoute(route, host.api, {
    section: "settings",
    settingsAnchor: "automatic-recommendations",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await firstRunDeepLink.flush();
    assert.match(firstRunDeepLink.captureCharFrame(), /› Opened at automatic recommendations settings/u);
  } finally {
    firstRunDeepLink.renderer.destroy();
  }

  const home = await renderRoute(route, host.api, { section: "home" });
  try {
    assert.doesNotMatch(home.captureCharFrame(), /Last cycle/u);
    store.emit(snapshot({
      outcome: "valid-no-change",
      triggerClass: "automatic",
      observationCount: 4,
      eligibilityCount: 2,
      occurredAt: 2_000,
      reason: null,
    }));
    await home.flush();
    const completed = home.captureCharFrame();
    assert.match(completed, /Last cycle/u);
    assert.match(completed, /valid no change.*4 observations.*2 eligible/u);

    store.emit(snapshot());
    await home.flush();
    assert.doesNotMatch(home.captureCharFrame(), /Last cycle/u);
  } finally {
    home.renderer.destroy();
  }

  const globalA = globalRecommendationSnapshot("a");
  store.emit(globalA);
  host.api.route.current = { name: "session", params: { sessionID: "global-project-a" } };
  const globalRecommendationId = "1".repeat(64);
  const globalReview = await renderRoute(route, host.api, {
    section: "recommendations",
    recommendation: globalRecommendationId,
  });
  try {
    const detail = globalReview.captureCharFrame();
    for (const expected of [
      "Existing global skill",
      "shared global review",
      "distributed",
      "2 independent domains",
      "3 incidents",
      "7 occurrences",
      "2026-08-01 through 2026-08-11",
      "Current project contributed: Yes",
      "Critic score: 97.50%",
      "Generality",
      "Passed: Passed the deterministic generality gate.",
      "Token impact",
      "does not expose a bounded token estimate",
      "+# Shared global review",
      "Apply",
      "Reject",
    ]) assert.ok(detail.includes(expected), `global recommendation detail omitted ${expected}\n${detail}`);
    assert.doesNotMatch(detail, /1111111111111111111111111111111111111111111111111111111111111111|projectFingerprint|supportSetHash|contributor|excerpt/u);
    await clickLabel(globalReview, "Reject");
    assert.doesNotMatch(globalReview.captureCharFrame(), /Confirm Reject/u);
    assert.deepEqual(store.globalActions.at(-1), {
      recommendationId: globalRecommendationId,
      action: "reject",
      projectFingerprint: "a".repeat(64),
    });
    await clickLabel(globalReview, "Apply");
    assert.match(globalReview.captureCharFrame(), /Confirm Apply/u);
    await clickLabel(globalReview, "Confirm Apply");
    assert.deepEqual(store.globalActions.at(-1), {
      recommendationId: globalRecommendationId,
      action: "apply",
      projectFingerprint: "a".repeat(64),
    });

    const globalB = globalRecommendationSnapshot("b", {
      contributed: false,
      pending: [{
        requestId: "pending-global-apply",
        kind: "global-action",
        action: "apply",
        subject: globalRecommendationId,
        submittedAt: 1_000,
        expiresAt: 2_000,
      }],
      responses: [
        {
          requestId: "accepted-global-apply",
          kind: "global-action",
          action: "apply",
          subject: globalRecommendationId,
          submittedAt: 800,
          expiresAt: 950,
          response: { ok: true, status: "accepted", processedAt: 900, reason: null },
        },
        {
          requestId: "rejected-global-reject",
          kind: "global-action",
          action: "reject",
          subject: globalRecommendationId,
          submittedAt: 700,
          expiresAt: 850,
          response: { ok: false, status: "rejected", processedAt: 800, reason: "stale-global-generation" },
        },
      ],
    });
    store.emit(globalB);
    await globalReview.flush();
    assert.deepEqual(host.api.route.current, {
      name: "mcrescenzo.self-evolve.control-center.route",
      params: { section: "recommendations", recommendation: globalRecommendationId },
    }, "project switch navigated away from the selected global recommendation");
    const globalOutcomes = globalReview.renderer.root.findDescendantById("self-evolve-focus-outcomes-summary");
    assert.ok(globalOutcomes, "global outcome summary did not mount");
    globalOutcomes.focus();
    globalReview.mockInput.pressEnter();
    await globalReview.flush();
    const switched = globalReview.captureCharFrame();
    assert.match(switched, /Current project contributed: No/u);
    assert.match(switched, /Apply · Pending/u);
    assert.match(switched, /apply accepted by the server/iu);
    assert.match(switched, /Server rejected reject: stale-global-generation/iu);
    assert.doesNotMatch(switched, /Confirm Apply/u, "prepared acting-project authority survived project switching");
    await clickLabel(globalReview, "Activity");
    await clickLabel(globalReview, "Errors");
    assert.match(globalReview.captureCharFrame(), /Reject did not complete: stale-global-generation/u);
    await clickLabel(globalReview, "Reject did not complete: stale-global-generation");
    await clickLabel(globalReview, "Acknowledge global failure");
    assert.doesNotMatch(globalReview.captureCharFrame(), /Acknowledge global failure/u);
  } finally {
    globalReview.renderer.destroy();
  }

  for (const [state, expectedAction] of [
    ["applied", "Undo"],
    ["rejected", null],
    ["failed-closed", null],
  ]) {
    store.emit(globalRecommendationSnapshot("b"));
    const lifecycle = await renderRoute(route, host.api, {
      section: "recommendations",
      recommendation: globalRecommendationId,
    });
    try {
      assert.match(lifecycle.captureCharFrame(), /pending/u);
      store.emit(globalRecommendationSnapshot("b", { state }));
      await lifecycle.flush();
      const frame = lifecycle.captureCharFrame();
      assert.match(frame, new RegExp(state.replaceAll("-", " "), "u"));
      if (expectedAction) {
        assert.match(frame, new RegExp(expectedAction, "u"));
        if (state === "applied") {
          assert.match(frame, /Acknowledge/u);
          await clickLabel(lifecycle, "Acknowledge");
          assert.doesNotMatch(lifecycle.captureCharFrame(), /Acknowledge/u);
          assert.match(lifecycle.captureCharFrame(), /Undo/u);
        }
        await clickLabel(lifecycle, expectedAction, -1);
        assert.doesNotMatch(lifecycle.captureCharFrame(), new RegExp(`Confirm ${expectedAction}`, "u"));
        assert.deepEqual(store.globalActions.at(-1), {
          recommendationId: globalRecommendationId,
          action: "undo",
          projectFingerprint: "b".repeat(64),
        });
      }
      else assert.doesNotMatch(frame, /\bApply\b|\bReject\b|\bUndo\b/u);
    } finally {
      lifecycle.renderer.destroy();
    }
  }

  const projectA = recommendationSnapshot("a");
  projectA.responses = [{ action: "set-automatic-recommendations", response: { ok: true } }];
  store.emit(projectA);
  host.api.route.current = { name: "session", params: { sessionID: "project-a" } };
  const openCommand = host.layers
    .flatMap((layer) => layer.commands ?? [])
    .find((command) => command.name === "mcrescenzo.self-evolve.control-center");
  assert.ok(openCommand);
  openCommand.run();
  const review = await renderRoute(route, host.api, { section: "recommendations", recommendation: "shared-proposal" });
  try {
    await clickLabel(review, "Apply Proposal");
    assert.match(review.captureCharFrame(), /Confirm Apply Proposal/u);
    const projectOutcomes = review.renderer.root.findDescendantById("self-evolve-focus-outcomes-summary");
    assert.ok(projectOutcomes, "project outcome summary did not mount");
    projectOutcomes.focus();
    review.mockInput.pressEnter();
    await review.flush();
    assert.match(review.captureCharFrame(), /set automatic recommendations accepted by the server/u);
    assert.match(review.captureCharFrame(), /Esc returns to session/u);
    assert.equal(store.decisions.length, 0);

    store.emit(recommendationSnapshot("b"));
    await assertProjectStatePreserved(review, host);

    await clickLabel(review, "Apply Proposal");
    assert.equal(store.decisions.length, 0, "project A confirmation must not publish in project B");
    assert.match(review.captureCharFrame(), /Confirm Apply Proposal/u);
    await clickLabel(review, "Confirm Apply Proposal");
    assert.equal(store.decisions.length, 1, "project B requires and accepts its own fresh review");
    assert.equal(store.decisions[0].projectFingerprint, "b".repeat(64));

    const projectTransitions = [
      {
        name: "key",
        identity: { key: `alternate:${"1".repeat(64)}` },
      },
      {
        name: "projectFingerprint",
        identity: { projectFingerprint: "c".repeat(64) },
      },
    ];
    let current = recommendationSnapshot("b");
    for (const transition of projectTransitions) {
      await armAllProjectState(review);
      const decisionsBefore = store.decisions.length;
      current = withIdentity(current, transition.identity);
      store.emit(current);
      await assertProjectStatePreserved(review, host);
      assert.equal(store.decisions.length, decisionsBefore, `${transition.name} transition published armed project state`);
    }

    await armAllProjectState(review);
    const decisionsBeforeRootChange = store.decisions.length;
    current = withIdentity(current, { stateRootIdentity: "d".repeat(64) });
    store.emit(current);
    await assertGlobalIdentityReset(review, host, store);
    assert.equal(store.decisions.length, decisionsBeforeRootChange, "state-root transition published armed state");

    await clickLabel(review, "Recommendations");
    await clickLabel(review, "Apply Proposal");
    assert.equal(store.decisions.length, decisionsBeforeRootChange, "new state root requires a fresh review");
    await clickLabel(review, "Confirm Apply Proposal");
    assert.equal(store.decisions.length, decisionsBeforeRootChange + 1);

    const expired = withIdentity(recommendationSnapshot("e"), { stateRootIdentity: "d".repeat(64) });
    expired.phase = "error";
    expired.stale = true;
    expired.error = "expired-projection";
    expired.pending = [{
      requestId: "pending-expired",
      kind: "decision",
      action: "apply-proposal",
      subject: "shared-proposal",
      submittedAt: 1_000,
      expiresAt: 2_000,
    }];
    expired.projection.effectiveIndexActions = [{ action: "set-automatic-recommendations" }, { action: "set-kill-switch" }];
    store.emit(expired);
    await review.flush();
    const staleRecommendation = review.captureCharFrame();
    assert.match(staleRecommendation, /Read-only stale snapshot/u);
    assert.match(staleRecommendation, /Latest refresh failed: expired-projection/u);
    assert.match(staleRecommendation, /Request pending server validation/u);
    assert.match(staleRecommendation, /Retry/u);
    assert.doesNotMatch(staleRecommendation, /Apply Proposal|Reject Proposal|Confirm Apply Proposal|Emergency stop|Turn Off/u);

    await clickLabel(review, "Settings");
    const staleSettings = review.captureCharFrame();
    assert.match(staleSettings, /Automatic recommendations[\s\S]*On/u);
    assert.doesNotMatch(staleSettings, /Set global default|This project ✓|Export selected scope|Delete selected scope/u);

    const retried = withIdentity(recommendationSnapshot("e"), { stateRootIdentity: "d".repeat(64) });
    retried.projection.effectiveDetailActions["shared-proposal"] = [{ action: "reject-proposal" }];
    retried.projection.effectiveIndexActions = [{ action: "set-kill-switch" }];
    store.setRetrySnapshot(retried);
    await clickLabel(review, "Retry");
    await clickLabel(review, "Recommendations");
    const freshActions = review.captureCharFrame();
    assert.match(freshActions, /Reject Proposal/u);
    assert.match(freshActions, /Emergency stop/u);
    assert.doesNotMatch(freshActions, /Apply Proposal|Read-only stale snapshot|Request pending server validation|Turn Off/u);

    const isolated = withIdentity(pendingIsolationSnapshot("e"), { stateRootIdentity: "d".repeat(64) });
    store.emit(isolated);
    await review.flush();
    const exactPending = review.captureCharFrame();
    assert.match(exactPending, /Apply Proposal · Pending/u);
    assert.match(exactPending, /Reject Proposal/u);
    await clickLabel(review, "unrelated");
    const unrelated = review.captureCharFrame();
    assert.match(unrelated, /Apply Proposal/u);
    assert.doesNotMatch(unrelated, /Apply Proposal · Pending/u);

    const expiredOutcome = withIdentity(pendingIsolationSnapshot("e"), { stateRootIdentity: "d".repeat(64) });
    expiredOutcome.pending = [];
    expiredOutcome.responses = [
      {
        requestId: "pending-shared-apply",
        kind: "decision",
        action: "apply-proposal",
        subject: "shared-proposal",
        submittedAt: 1_000,
        expiresAt: 2_000,
        response: {
          ok: false,
          status: "expired",
          processedAt: 2_000,
          reason: "response-not-received-before-expiry",
        },
      },
      {
        requestId: "pending-export",
        kind: "operation",
        action: "export-data",
        subject: "scope:project",
        submittedAt: 1_000,
        expiresAt: 2_000,
        response: {
          ok: false,
          status: "expired",
          processedAt: 2_000,
          reason: "response-not-received-before-expiry",
        },
      },
    ];
    store.emit(expiredOutcome);
    await review.flush();
    const expiredOutcomes = review.renderer.root.findDescendantById("self-evolve-focus-outcomes-summary");
    assert.ok(expiredOutcomes, "expired outcome summary did not mount");
    expiredOutcomes.focus();
    review.mockInput.pressEnter();
    await review.flush();
    const expiredFrame = review.captureCharFrame();
    assert.match(expiredFrame, /apply proposal expired without a server response.*new request ID.*current server nonce authority/u);
    assert.match(expiredFrame, /export data expired without a server response.*new request ID.*current server nonce authority/u);

    const escape = host.layers
      .flatMap((layer) => layer.bindings ?? [])
      .find((binding) => binding.key === "escape");
    assert.ok(escape);
    escape.cmd();
    assert.deepEqual(host.api.route.current, { name: "home" });
  } finally {
    review.renderer.destroy();
  }

  host.api.route.current = {
    name: "session",
    params: { sessionID: "escape-exact", tab: "details" },
  };
  openCommand.run();
  const escapeRoute = await renderRoute(route, host.api, { section: "home" }, { width: 92, height: 36 });
  try {
    await clickLabel(escapeRoute, "Settings");
    assert.ok(escapeRoute.renderer.currentFocusedRenderable,
      "Settings descendant did not retain focus before Escape");
    const escape = host.layers
      .flatMap((layer) => layer.bindings ?? [])
      .find((binding) => binding.key === "escape");
    assert.ok(escape);
    escape.cmd();
    assert.deepEqual(host.api.route.current, {
      name: "session",
      params: { sessionID: "escape-exact", tab: "details" },
    });
  } finally {
    escapeRoute.renderer.destroy();
  }
  const escapeBinding = host.layers
    .flatMap((layer) => layer.bindings ?? [])
    .find((binding) => binding.key === "escape");
  for (const [name, value, params, focusTarget] of [
    ["navigation", snapshot(), { section: "home" }, "self-evolve-focus-section-settings"],
    ["recommendation", recommendationSnapshot("a"), { section: "recommendations" }, "self-evolve-focus-recommendation-filter-needs-review"],
    ["activity", snapshot(), { section: "activity" }, "self-evolve-focus-activity-diagnostics"],
    ["input", snapshot(), { section: "settings", settingsAnchor: "approved-skill-folders" }, "self-evolve-focus-root-path-input"],
  ]) {
    store.emit(value);
    host.api.route.current = { name: "session", params: { sessionID: `escape-${name}`, tab: "details" } };
    openCommand.run();
    const setup = await renderRoute(route, host.api, params, { width: 92, height: 36 });
    try {
      const target = setup.renderer.root.findDescendantById(focusTarget);
      assert.ok(target, `${name} Escape target did not mount`);
      target.focus();
      escapeBinding.cmd();
      assert.deepEqual(host.api.route.current, {
        name: "session",
        params: { sessionID: `escape-${name}`, tab: "details" },
      }, `${name} descendant Escape lost the exact prior route`);
    } finally {
      setup.renderer.destroy();
    }
  }
} finally {
  await host.dispose();
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  renderedSections,
  narrowSections,
  keyboardFocusCoverage: {
    monochromeMarkers: true,
    activityArrowNavigation: true,
    activationParity: ["pointer", "enter", "space"],
    tabDirections: ["forward", "reverse"],
  },
  sidebarAutomationCoverage: {
    activationParity: ["pointer", "enter", "space"],
    cardAndControlFocus: "siblings",
    offToOn: "inline-confirmation",
    onToOff: "immediate",
    unavailableAuthority: ["stale", "pending", "unsupported", "limited"],
  },
  escapeRestoration: "exact-prior-route-from-focused-descendant",
  globalRecommendationCoverage: {
    actions: ["apply", "reject", "undo"],
    outcomes: ["pending", "accepted", "rejected", "failed-closed"],
    projectSwitch: ["queue-bytes-preserved", "selection-preserved", "participation-replaced", "prepared-authority-cleared"],
    privacy: "identity-free-counts-only",
  },
  deepLinkFocusCoverage: ["activity-errors", "settings-provider", "first-run-settings"],
  reactiveLastCycle: true,
  identityResetCoverage: {
    stateClasses: ["confirmation", "maintenance", "recommendation", "pending-route", "prior-route"],
    transitions: ["project-selection-preserved", "project-authority-cleared", "state-root-reset"],
    freshReview: true,
  },
  authorityRecoveryCoverage: {
    staleContexts: ["recommendation", "header", "settings", "pending", "expiry"],
    retryFreshActionsOnly: true,
    preparedAuthorityCleared: true,
  },
  requestExpiryCoverage: {
      exactActionIsolation: true,
      unrelatedRecommendationAvailable: true,
      everyRetainedOutcomeVisible: true,
      retryRenegotiatesNonceAuthority: true,
  },
})}\n`);
