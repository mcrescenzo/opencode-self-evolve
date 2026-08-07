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
    usage: null,
    rollout: null,
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
      approvedSkillFolderCount: 0,
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
  };
}

function snapshot(lastCycle = null, identity = "a") {
  const dashboardValue = dashboard(lastCycle);
  const value = {
    phase: "ready",
    updatedAt: 1_000,
    pending: [],
    responses: [],
    acknowledgedAuditIds: [],
    dashboard: dashboardValue,
    dashboardError: null,
    controlState: {
      mode: "auto",
      effectiveMode: "auto",
      allowedSkillRoots: ["/skills/project-a"],
      consent: dashboardValue.settings.consent,
      repoExcluded: false,
    },
    latestExport: null,
    inspection: null,
    watcher: "polling",
    error: null,
    runtime: {
      hostVersion: "1.18.3",
      hostVersionSource: "test",
      pluginVersion: "0.2.0",
      projectionVersion: 1,
      dashboardVersion: 1,
      projectionMode: "native",
    },
    projection: {
      mode: "native",
      projectionVersion: 1,
      operationProtocolVersion: 1,
      capabilities: ["legacy-control-v1", "legacy-decision-v1"],
      dashboard: dashboardValue,
      dashboardError: null,
      index: {
        generation: "a".repeat(64),
        projectionVersion: 1,
        capabilities: ["legacy-control-v1", "legacy-decision-v1"],
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
          storedMode: "auto",
          effectiveMode: "auto",
          paused: false,
          killSwitchActive: false,
          repoExcluded: false,
          circuitBreakerOpen: false,
        },
        reviews: [],
        operations: [],
      },
      details: [],
      effectiveIndexActions: [
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
  const detailSelections = [];
  return {
    decisions,
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
    submitControl() { return Promise.resolve({ ok: true }); },
    submitDecision(value) { decisions.push({ projectFingerprint: current.projectFingerprint, value }); return Promise.resolve({ ok: true }); },
    submitOperation() { return Promise.resolve({ ok: true }); },
    acknowledgeAudits() { return current; },
  };
}

function hostApi() {
  const controller = new AbortController();
  const disposers = [];
  const routes = [];
  const layers = [];
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
    slots: { register() {} },
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
  await clickLabel(setup, "Review consent for Sanitized evidence excerpts");
  await clickLabel(setup, "Remove");
  await typeInto(setup, "UPDATE ALLOWLIST", "UPDATE ALLOWLIST");
  await clickLabel(setup, "Set global default", -1);
  await typeInto(setup, "ENABLE YOLO", "ENABLE YOLO");
  await clickLabel(setup, "Everything");
  await clickLabel(setup, "Delete selected scope");
  await typeInto(setup, "PURGE ALL SELF-EVOLVE DATA", "PURGE ALL SELF-EVOLVE DATA");
  const armed = setup.captureCharFrame();
  for (const expected of [
    "Consent disclosure",
    "Exact replacement",
    "Submit Apply automatically",
    "Delete permanently",
  ]) assert.ok(armed.includes(expected), `armed Settings state omitted ${expected}\n${armed}`);

  await clickLabel(setup, "Recommendations");
  const recommendation = setup.captureCharFrame();
  assert.match(recommendation, /Confirm Apply Proposal/u);
  assert.match(recommendation, /A-only rejection reason/u);
}

async function assertProjectStateReset(setup, host, store) {
  await setup.flush();
  assert.deepEqual(host.api.route.current, {
    name: "mcrescenzo.self-evolve.control-center.route",
    params: { section: "home" },
  });
  const reset = setup.captureCharFrame();
  assert.match(reset, /Mode and scope/u);
  assert.match(reset, /Esc returns to home/u);
  assert.doesNotMatch(reset, /Confirm Apply Proposal|A-only rejection reason|Consent disclosure|Exact replacement|Submit Apply automatically|Delete permanently|set paused accepted/u);
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

  const sections = [
    [{ section: "home" }, "Mode and scope"],
    [{ section: "recommendations" }, "Nothing needs review"],
    [{ section: "activity", activityFilter: "all" }, "Diagnostics"],
    [{ section: "settings" }, "Effective result"],
  ];
  for (const [params, expected] of sections) {
    const setup = await renderRoute(route, host.api, params);
    try {
      const frame = setup.captureCharFrame();
      assert.match(frame, /Self-evolve/u);
      assert.ok(frame.includes(expected), `rendered ${params.section} without ${expected}\n${frame}`);
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
    assert.match(keyboard.captureCharFrame(), /› \[Info\] First keyboard activity row[\s\S]*Category: cycle/u);
    keyboard.mockInput.pressEnter();
    await keyboard.flush();
    assert.doesNotMatch(keyboard.captureCharFrame(), /Category: cycle/u, "Enter did not mirror pointer row activation");
    keyboard.mockInput.pressKey(" ");
    await keyboard.flush();
    assert.match(keyboard.captureCharFrame(), /Category: cycle/u, "Space did not mirror pointer row activation");
    keyboard.mockInput.pressArrow("down");
    await keyboard.flush();
    assert.match(keyboard.captureCharFrame(), /› \[Info\] Second keyboard activity row/u);
    keyboard.mockInput.pressArrow("up");
    await keyboard.flush();
    assert.match(keyboard.captureCharFrame(), /› \[Info\] First keyboard activity row/u);

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
    destination: "home",
  }];
  firstRunSnapshot.dashboard.settings.globalMode = "manual";
  firstRunSnapshot.dashboard.settings.effectiveMode = "manual";
  firstRunSnapshot.controlState.mode = "manual";
  firstRunSnapshot.controlState.effectiveMode = "manual";
  firstRunSnapshot.projection.index.status.storedMode = "manual";
  firstRunSnapshot.projection.index.status.effectiveMode = "manual";
  store.emit(firstRunSnapshot);
  const firstRunDeepLink = await renderRoute(route, host.api, { section: "home" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await firstRunDeepLink.flush();
    assert.match(firstRunDeepLink.captureCharFrame(), /› Turn on automatic recommendations/u);
  } finally {
    firstRunDeepLink.renderer.destroy();
  }

  const home = await renderRoute(route, host.api, { section: "home" });
  try {
    assert.doesNotMatch(home.captureCharFrame(), /Last cycle/u);
    store.emit(snapshot({
      outcome: "valid-no-change",
      triggerClass: "manual",
      mode: "manual",
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

  const projectA = recommendationSnapshot("a");
  projectA.responses = [{ action: "set-paused", response: { ok: true } }];
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
    assert.match(review.captureCharFrame(), /set paused accepted by the server/u);
    assert.match(review.captureCharFrame(), /Esc returns to session/u);
    assert.equal(store.decisions.length, 0);

    store.emit(recommendationSnapshot("b"));
    await assertProjectStateReset(review, host, store);

    await clickLabel(review, "Recommendations");
    await clickLabel(review, "Apply Proposal");
    assert.equal(store.decisions.length, 0, "project A confirmation must not publish in project B");
    assert.match(review.captureCharFrame(), /Confirm Apply Proposal/u);
    await clickLabel(review, "Confirm Apply Proposal");
    assert.equal(store.decisions.length, 1, "project B requires and accepts its own fresh review");
    assert.equal(store.decisions[0].projectFingerprint, "b".repeat(64));

    const transitions = [
      {
        name: "key",
        identity: { key: `alternate:${"1".repeat(64)}` },
      },
      {
        name: "projectFingerprint",
        identity: { projectFingerprint: "c".repeat(64) },
      },
      {
        name: "stateRootIdentity",
        identity: { stateRootIdentity: "d".repeat(64) },
      },
      {
        name: "identified-to-identity-less",
        identity: { key: null, projectFingerprint: null, stateRootIdentity: null },
      },
    ];
    let current = recommendationSnapshot("b");
    for (const transition of transitions) {
      await armAllProjectState(review);
      const decisionsBefore = store.decisions.length;
      current = withIdentity(current, transition.identity);
      store.emit(current);
      await assertProjectStateReset(review, host, store);
      assert.equal(store.decisions.length, decisionsBefore, `${transition.name} transition published armed project state`);
    }

    await armAllProjectState(review);
    const decisionsBeforeIdentification = store.decisions.length;
    current = recommendationSnapshot("e");
    store.emit(current);
    await assertProjectStateReset(review, host, store);
    assert.equal(store.decisions.length, decisionsBeforeIdentification, "identity-less to identified transition published armed state");

    await clickLabel(review, "Recommendations");
    await clickLabel(review, "Apply Proposal");
    assert.equal(store.decisions.length, decisionsBeforeIdentification, "identified project requires a fresh review");
    await clickLabel(review, "Confirm Apply Proposal");
    assert.equal(store.decisions.length, decisionsBeforeIdentification + 1);
    assert.equal(store.decisions.at(-1).projectFingerprint, "e".repeat(64));

    const expired = recommendationSnapshot("e");
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
    expired.projection.effectiveIndexActions = [{ action: "set-paused" }, { action: "set-kill-switch" }];
    store.emit(expired);
    await review.flush();
    const staleRecommendation = review.captureCharFrame();
    assert.match(staleRecommendation, /Read-only stale snapshot/u);
    assert.match(staleRecommendation, /Latest refresh failed: expired-projection/u);
    assert.match(staleRecommendation, /Request pending server validation/u);
    assert.match(staleRecommendation, /Retry/u);
    assert.doesNotMatch(staleRecommendation, /Apply Proposal|Reject Proposal|Confirm Apply Proposal|Emergency stop|Pause/u);

    await clickLabel(review, "Settings");
    const staleSettings = review.captureCharFrame();
    assert.match(staleSettings, /Effective result: Recommend automatically/u);
    assert.doesNotMatch(staleSettings, /Set global default|This project ✓|Export selected scope|Delete selected scope/u);

    const retried = recommendationSnapshot("e");
    retried.projection.effectiveDetailActions["shared-proposal"] = [{ action: "reject-proposal" }];
    retried.projection.effectiveIndexActions = [{ action: "set-kill-switch" }];
    store.setRetrySnapshot(retried);
    await clickLabel(review, "Retry");
    await clickLabel(review, "Recommendations");
    const freshActions = review.captureCharFrame();
    assert.match(freshActions, /Reject Proposal/u);
    assert.match(freshActions, /Emergency stop/u);
    assert.doesNotMatch(freshActions, /Apply Proposal|Read-only stale snapshot|Request pending server validation|Pause/u);

    const isolated = pendingIsolationSnapshot("e");
    store.emit(isolated);
    await review.flush();
    const exactPending = review.captureCharFrame();
    assert.match(exactPending, /Apply Proposal · Pending/u);
    assert.match(exactPending, /Reject Proposal/u);
    await clickLabel(review, "unrelated");
    const unrelated = review.captureCharFrame();
    assert.match(unrelated, /Apply Proposal/u);
    assert.doesNotMatch(unrelated, /Apply Proposal · Pending/u);

    const expiredOutcome = pendingIsolationSnapshot("e");
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
  deepLinkFocusCoverage: ["activity-errors", "settings-provider", "first-run-home"],
  reactiveLastCycle: true,
  identityResetCoverage: {
    stateClasses: ["confirmation", "consent", "folder-draft", "yolo", "maintenance", "recommendation", "pending-route", "prior-route"],
    transitions: ["key", "projectFingerprint", "stateRootIdentity", "identified-to-identity-less", "identity-less-to-identified"],
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
