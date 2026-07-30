import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SelfEvolveTuiPlugin } from "../self-evolve-tui.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_TUI_TARGET = "@mcrescenzo/opencode-self-evolve/tui";
const LOCAL_NATIVE_TARGET = "./plugins/self-evolve/self-evolve-tui.tsx";
const LOCAL_LEGACY_TARGET = "./plugins/self-evolve/self-evolve-tui.js";

function loadingFixture(plugins) {
  const configured = Array.isArray(plugins) ? plugins : [];
  const nativeLoaded = configured.some((entry) => entry === PACKAGE_TUI_TARGET || entry === LOCAL_NATIVE_TARGET);
  const legacyLoaded = configured.includes(LOCAL_LEGACY_TARGET);
  return {
    nativeLoaded,
    legacyOnly: legacyLoaded && !nativeLoaded,
    migration: legacyLoaded && !nativeLoaded
      ? `External tui.json migration required: replace ${LOCAL_LEGACY_TARGET} with ${LOCAL_NATIVE_TARGET} (or ${PACKAGE_TUI_TARGET}) and restart OpenCode.`
      : null,
  };
}

function tuiHarness({ keymap = true } = {}) {
  const controller = new AbortController();
  const disposers = [];
  const layers = [];
  const kv = new Map();
  const api = {
    kv: {
      get(key, fallback) { return kv.has(key) ? kv.get(key) : fallback; },
      set(key, value) { kv.set(key, value); },
    },
    route: { current: { name: "session", params: { sessionID: "session-1" } } },
    state: {
      path: { state: "/state", worktree: "/worktree", directory: "/worktree" },
      session: { status: () => ({ type: "idle", since: 0 }) },
    },
    ui: {
      dialog: { replace(render) { return render(); } },
      DialogAlert(props) { return props; },
      DialogConfirm(props) { return props; },
      DialogPrompt(props) { return props; },
      DialogSelect(props) { return props; },
    },
    keymap: keymap ? { registerLayer(layer) { layers.push(layer); return () => {}; } } : {},
    lifecycle: {
      signal: controller.signal,
      onDispose(dispose) { disposers.push(dispose); return () => {}; },
    },
  };
  const projectStore = { refresh() { return Promise.resolve({ phase: "legacy" }); } };
  return {
    api,
    layers,
    options: { __testTuiStoreFactory: () => projectStore },
    async dispose() {
      controller.abort();
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}

async function captureWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (value) => warnings.push(String(value));
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

test("healthy native startup silently delegates legacy settings to the native sidebar", async () => {
  const harness = tuiHarness();
  const warnings = await captureWarnings(async () => {
    await SelfEvolveTuiPlugin(harness.api, { ...harness.options, __nativeSidebar: true });
    await harness.dispose();
  });

  assert.deepEqual(warnings, []);
  assert.equal(harness.layers.length, 0);
});

test("requested legacy settings surface warns once when a required capability is missing", async () => {
  const harness = tuiHarness({ keymap: false });
  const warnings = await captureWarnings(async () => {
    await SelfEvolveTuiPlugin(harness.api, harness.options);
    await harness.dispose();
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /legacy settings command/i);
  assert.match(warnings[0], /keymap\.registerLayer/u);
  assert.match(warnings[0], /self-evolve-tui\.tsx/u);
  assert.match(warnings[0], /tui\.json/u);
  assert.ok(warnings[0].length <= 240);
});

test("legacy-only registration fixture reports the external native-target migration", () => {
  const config = { plugin: [LOCAL_LEGACY_TARGET] };
  const result = loadingFixture(config.plugin);

  assert.deepEqual(result, {
    nativeLoaded: false,
    legacyOnly: true,
    migration: `External tui.json migration required: replace ${LOCAL_LEGACY_TARGET} with ${LOCAL_NATIVE_TARGET} (or ${PACKAGE_TUI_TARGET}) and restart OpenCode.`,
  });
  assert.deepEqual(config, { plugin: [LOCAL_LEGACY_TARGET] });
});

test("package exports and TUI loading docs select the native target and explain mixed-version fallback", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const configuration = fs.readFileSync(path.join(root, "docs/configuration.md"), "utf8");
  const internals = fs.readFileSync(path.join(root, "docs/internals.md"), "utf8");
  const helper = fs.readFileSync(path.join(root, "self-evolve-tui.js"), "utf8");

  assert.equal(manifest.exports["./tui"], "./self-evolve-tui.tsx");
  assert.match(configuration, /@mcrescenzo\/opencode-self-evolve\/tui/u);
  assert.match(configuration, /self-evolve-tui\.js[^\n]+compatibility fallback/iu);
  assert.match(configuration, /self-evolve-tui\.js[^\n]+replace[^\n]+self-evolve-tui\.tsx/iu);
  assert.match(configuration, /new TUI[^\n]+old server[^\n]+legacy\/read-only/iu);
  assert.match(configuration, /old TUI[^\n]+new server[^\n]+legacy\/read-only/iu);
  assert.match(internals, /self-evolve-tui\.tsx[^\n]+public native target/iu);
  assert.doesNotMatch(helper, /from\s+["'](?:\.\/tui|@opentui\/)/u);
});
