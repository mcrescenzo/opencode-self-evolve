import assert from "node:assert/strict";

assert.match(
  import.meta.resolve("solid-js"),
  /\/dist\/(?:dev|solid)\.js$/u,
  "inert render smoke requires Bun's browser condition so OpenTUI receives Solid's reactive client runtime",
);
await import("@opentui/solid/runtime-plugin-support");
const { testRender } = await import("@opentui/solid");

const moduleSpecifier = process.argv[2] ?? new URL("../self-evolve-tui.generated.js", import.meta.url).href;
const tuiModule = await import(moduleSpecifier);

const CONTROL_CENTER_ROUTE = "mcrescenzo.self-evolve.control-center.route";

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
    state: { path: {}, session: { status: () => ({ type: "idle", since: 0 }) } },
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
        text: "#ffffff", textMuted: "#999999", borderActive: "#00ffff", borderSubtle: "#555555",
        info: "#00aaff", warning: "#ffaa00", error: "#ff0000", success: "#00ff00",
      },
    },
  };
  return {
    api, routes, layers, slots,
    async dispose() { controller.abort(); for (const dispose of disposers.reverse()) await dispose(); },
  };
}

async function clickLabel(setup, label) {
  const lines = setup.captureCharFrame().split("\n");
  const point = lines.flatMap((line, y) => {
    const points = [];
    let from = 0;
    while (from <= line.length) {
      const x = line.indexOf(label, from);
      if (x < 0) break;
      points.push({ x: x + Math.floor(label.length / 2), y });
      from = x + label.length;
    }
    return points;
  })[0];
  assert.ok(point, `rendered frame did not include ${label}\n${lines.join("\n")}`);
  await setup.mockMouse.click(point.x, point.y);
  await setup.flush();
}

assert.deepEqual(Object.keys(tuiModule), ["default"]);
assert.equal(tuiModule.default?.id, "mcrescenzo.self-evolve");

const host = hostApi();
const result = {
  ok: true,
  registered: { route: false, sidebar: false, paletteLayer: false, modeEscape: false },
  rendered: { recoveryDiagnostic: false, retry: false, failureCard: false },
  escapeRestoration: false,
  retrySuccess: false,
};

try {
  // Boot the native module with a state path and environment that cannot resolve
  // a trusted state root: the legacy plugin detects startup failure, the native
  // orchestrator mounts the inert recovery shell instead of disappearing.
  await tuiModule.default.tui(host.api, { env: {} });

  const route = host.routes.find((candidate) => candidate.name === CONTROL_CENTER_ROUTE);
  assert.ok(route, "control center route was not registered on startup failure");
  result.registered.route = true;

  const sidebarSlot = host.slots.map((entry) => entry.slots?.sidebar_content).find(Boolean);
  assert.equal(typeof sidebarSlot, "function", "sidebar slot was not registered on startup failure");
  result.registered.sidebar = true;

  const paletteLayer = host.layers.find((layer) => Array.isArray(layer.commands)
    && layer.commands.some((command) => command.name === "mcrescenzo.self-evolve.control-center"));
  assert.ok(paletteLayer, "palette keymap layer was not registered");
  assert.equal(paletteLayer.commands[0].namespace, "palette");
  result.registered.paletteLayer = true;

  const modeLayer = host.layers.find((layer) => layer.mode === "mcrescenzo.self-evolve.control-center"
    && Array.isArray(layer.bindings));
  assert.ok(modeLayer, "mode-scoped keymap layer was not registered");
  const escapeBinding = modeLayer.bindings.find((binding) => binding.key === "escape");
  assert.equal(typeof escapeBinding?.cmd, "function", "mode-scoped Escape binding was not registered");
  result.registered.modeEscape = true;

  // Render the control center route and prove the inert recovery state shows.
  const controlCenter = await testRender(() => route.render({ section: "home" }), { width: 96, height: 40 });
  try {
    await controlCenter.flush();
    const frame = controlCenter.captureCharFrame();
    assert.match(frame, /Projection unavailable/u, "inert recovery banner did not render");
    assert.match(frame, /State root unavailable/u, "startup diagnostic did not render");
    result.rendered.recoveryDiagnostic = true;
    assert.match(frame, /Retry/u, "Retry control did not render");
    result.rendered.retry = true;

    // Escape restoration: open the control center, then invoke the mode-scoped
    // Escape binding and prove it returns to the exact prior route.
    host.api.route.current = { name: "session", params: { sessionID: "prior-inert" } };
    paletteLayer.commands[0].run();
    assert.equal(host.api.route.current.name, CONTROL_CENTER_ROUTE, "palette command did not open the control center");
    escapeBinding.cmd();
    assert.deepEqual(host.api.route.current, { name: "session", params: { sessionID: "prior-inert" } },
      "mode-scoped Escape did not restore the exact prior route");
    result.escapeRestoration = true;

    // Retry keeps the shell mounted and refreshes the diagnostic; a failing
    // retry leaves the recovery banner mounted.
    await clickLabel(controlCenter, "Retry");
    await controlCenter.flush();
    assert.match(controlCenter.captureCharFrame(), /Projection unavailable/u,
      "failing retry unmounted the recovery banner");

    // A later retry succeeds once the host exposes a resolvable trusted state
    // root; the diagnostic then prompts a reload instead of granting authority.
    host.api.state.path = { state: "/state", worktree: "/worktree", directory: "/worktree" };
    await clickLabel(controlCenter, "Retry");
    await controlCenter.flush();
    assert.match(controlCenter.captureCharFrame(), /Restart OpenCode/u,
      "successful retry did not prompt a reload from the inert shell");
    assert.doesNotMatch(controlCenter.captureCharFrame(), /Apply Proposal|Reject|Confirm Apply/u,
      "successful retry granted authority from the inert shell");
    result.retrySuccess = true;
  } finally {
    host.api.route.current = { name: "session", params: { sessionID: "inert-finished" } };
    controlCenter.renderer.destroy();
  }

  // Render the sidebar slot and prove the failure card is reachable.
  const sidebar = await testRender(() => sidebarSlot(), { width: 48, height: 24 });
  try {
    await sidebar.flush();
    const sidebarFrame = sidebar.captureCharFrame();
    assert.match(sidebarFrame, /Self-evolve/u);
    result.rendered.failureCard = true;
    host.api.route.current = { name: "session", params: { sessionID: "sidebar-inert" } };
    sidebar.renderer.root.findDescendantById("self-evolve-sidebar-card")?.focus?.();
    sidebar.mockInput.pressEnter();
    await sidebar.flush();
    assert.equal(host.api.route.current.name, CONTROL_CENTER_ROUTE,
      "sidebar card activation did not open the control center from the inert shell");
  } finally {
    host.api.route.current = { name: "session", params: { sessionID: "sidebar-inert-done" } };
    sidebar.renderer.destroy();
  }

  await host.dispose();
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  try { await host.dispose(); } catch {}
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exitCode = 1;
