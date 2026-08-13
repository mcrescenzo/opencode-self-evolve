import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SelfEvolveTuiPlugin } from "../self-evolve-tui.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_TUI_TARGET = "@mcrescenzo/opencode-self-evolve";
const LOCAL_NATIVE_TARGET = "./plugins/self-evolve";
const LEGACY_PACKAGE_TARGET = "@mcrescenzo/opencode-self-evolve/tui";
const LOCAL_RAW_TARGET = "./plugins/self-evolve/self-evolve-tui.tsx";
const LOCAL_LEGACY_TARGET = "./plugins/self-evolve/self-evolve-tui.js";

function loadingFixture(plugins) {
  const configured = Array.isArray(plugins) ? plugins : [];
  const nativeLoaded = configured.some((entry) => entry === PACKAGE_TUI_TARGET || entry === LOCAL_NATIVE_TARGET);
  const legacyTarget = configured.find((entry) => [
    LEGACY_PACKAGE_TARGET,
    LOCAL_RAW_TARGET,
    LOCAL_LEGACY_TARGET,
  ].includes(entry));
  const legacyLoaded = legacyTarget !== undefined;
  return {
    nativeLoaded,
    legacyOnly: legacyLoaded && !nativeLoaded,
    migration: legacyLoaded && !nativeLoaded
      ? `External tui.json migration required: replace ${legacyTarget} with ${LOCAL_NATIVE_TARGET} (or ${PACKAGE_TUI_TARGET}) and restart OpenCode.`
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

test("retired legacy settings surface remains inert when a required capability is missing", async () => {
  const harness = tuiHarness({ keymap: false });
  const warnings = await captureWarnings(async () => {
    await SelfEvolveTuiPlugin(harness.api, harness.options);
    await harness.dispose();
  });

  assert.deepEqual(warnings, []);
});

test("legacy-only registration fixture reports the external native-target migration", () => {
  for (const legacy of [LEGACY_PACKAGE_TARGET, LOCAL_RAW_TARGET, LOCAL_LEGACY_TARGET]) {
    const config = { plugin: [legacy] };
    const result = loadingFixture(config.plugin);
    assert.equal(result.nativeLoaded, false);
    assert.equal(result.legacyOnly, true);
    assert.match(result.migration, /External tui\.json migration required/u);
    assert.deepEqual(config, { plugin: [legacy] });
  }
});

test("bare package and source package-root registrations select the built export", () => {
  for (const current of [PACKAGE_TUI_TARGET, LOCAL_NATIVE_TARGET]) {
    assert.deepEqual(loadingFixture([current]), {
      nativeLoaded: true,
      legacyOnly: false,
      migration: null,
    });
  }
});

test("package exports and TUI loading docs select the native target and explain mixed-version fallback", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const configuration = fs.readFileSync(path.join(root, "docs/configuration.md"), "utf8");
  const contract = fs.readFileSync(path.join(root, "docs/control-center-ux.md"), "utf8");
  const internals = fs.readFileSync(path.join(root, "docs/internals.md"), "utf8");
  const releaseB = fs.readFileSync(path.join(root, "docs/release-b-candidate.md"), "utf8");
  const releaseBEvidence = fs.readFileSync(
    path.join(root, "docs/release-b-operator-evidence.md"),
    "utf8",
  );
  const helper = fs.readFileSync(path.join(root, "self-evolve-tui.js"), "utf8");

  assert.equal(manifest.exports["./tui"], "./self-evolve-tui.generated.js");
  assert.equal(manifest.exports["./server"], "./self-evolve.js");
  assert.equal(manifest.exports["."], manifest.exports["./server"]);
  assert.match(readme, /opencode plugin @mcrescenzo\/opencode-self-evolve --global/u);
  assert.match(readme, /"plugin": \["@mcrescenzo\/opencode-self-evolve"\]/u);
  assert.match(readme, /exactly four sections: Home, Recommendations, Activity, and Settings/u);
  assert.match(configuration, /opencode plugin @mcrescenzo\/opencode-self-evolve/u);
  assert.match(configuration, /self-evolve-tui\.generated\.js/u);
  assert.match(configuration, /self-evolve-tui\.js[^\n]+target-only[\s\S]{0,80}not a standalone registration/iu);
  assert.match(configuration, /self-evolve-tui\.(?:js|tsx)[\s\S]{0,180}replace[\s\S]{0,80}package root/iu);
  assert.match(configuration, /new\s+TUI with an old server[\s\S]{0,160}valid core review/iu);
  assert.match(configuration, /old TUI with a new server[\s\S]{0,160}unchanged core projection/iu);
  assert.match(configuration, /exact Release A capability vocabulary/iu);
  assert.match(configuration, /exactly four sections: Home, Recommendations, Activity, and Settings/u);
  assert.match(configuration, /dashboard-v1/u);
  assert.match(configuration, /never a raw-log viewer/u);
  assert.match(contract, /Recommendations is the single normal review path/u);
  assert.match(internals, /self-evolve-tui\.generated\.js[^\n]+public native target/iu);
  assert.match(internals, /renders? exactly Home, Recommendations, Activity, and Settings/u);
  assert.match(releaseB, /automated implementer-authored evidence is\s+not independent human acceptance/iu);
  assert.match(releaseBEvidence, /it is not independent human\s+review/iu);
  assert.doesNotMatch(helper, /from\s+["'](?:\.\/tui|@opentui\/)/u);
});
