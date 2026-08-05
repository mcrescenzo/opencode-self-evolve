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

function snapshot(lastCycle = null) {
  const dashboardValue = dashboard(lastCycle);
  return {
    phase: "ready",
    updatedAt: 1_000,
    pending: [],
    responses: [],
    acknowledgedAuditIds: [],
    dashboard: dashboardValue,
    dashboardError: null,
    controlState: null,
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
      effectiveIndexActions: [],
      effectiveDetailActions: {},
    },
  };
}

function projectStore(initial) {
  let current = initial;
  const listeners = new Set();
  return {
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
    refresh() { return Promise.resolve(current); },
    selectDetails() { return Promise.resolve(current); },
    submitControl() { return Promise.resolve({ ok: true }); },
    submitDecision() { return Promise.resolve({ ok: true }); },
    submitOperation() { return Promise.resolve({ ok: true }); },
    acknowledgeAudits() { return current; },
  };
}

function hostApi() {
  const controller = new AbortController();
  const disposers = [];
  const routes = [];
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
    keymap: { registerLayer() { return () => {}; } },
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
    routes,
    async dispose() {
      controller.abort();
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}

async function renderRoute(route, api, params) {
  api.route.current = { name: route.name, params };
  const setup = await testRender(() => route.render(), { width: 140, height: 50 });
  await setup.flush();
  return setup;
}

assert.deepEqual(Object.keys(tuiModule), ["default"]);
assert.equal(tuiModule.default?.id, "mcrescenzo.self-evolve");
assert.equal(typeof tuiModule.default?.tui, "function");

const store = projectStore(snapshot());
const host = hostApi();
const renderedSections = [];
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
} finally {
  await host.dispose();
}

process.stdout.write(`${JSON.stringify({ ok: true, renderedSections, reactiveLastCycle: true })}\n`);
