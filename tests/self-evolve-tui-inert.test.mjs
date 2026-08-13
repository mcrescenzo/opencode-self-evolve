import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SelfEvolveTuiPlugin, attemptTuiStartup } from "../self-evolve-tui.js";
import {
  buildControlCenterModel,
  createInertRecoveryStore,
  deriveSidebarCard,
  deriveSidebarModeControl,
} from "../self-evolve-tui-store.js";

function kvMap() {
  return new Map();
}

function inertHarness() {
  const controller = new AbortController();
  const store = kvMap();
  let dispose;
  const api = {
    now: () => 2_000,
    route: { current: { name: "session", params: { sessionID: "session-1" } } },
    kv: {
      get(key, fallback) { return store.has(key) ? store.get(key) : fallback; },
      set(key, value) { store.set(key, value); },
    },
    ui: {
      DialogConfirm(props) { return props; },
      DialogSelect(props) { return props; },
      DialogPrompt(props) { return props; },
      DialogAlert(props) { return props; },
      dialog: { replace(render) { return render(); }, clear() {}, setSize() {} },
    },
    keymap: { registerLayer() { return () => {}; } },
    event: { on() { return () => {}; } },
    lifecycle: {
      signal: controller.signal,
      onDispose(fn) { dispose = fn; return () => { dispose = undefined; }; },
    },
    state: { path: { state: "/state", worktree: "/worktree", directory: "/worktree" } },
  };
  return {
    api,
    kv: store,
    async dispose() { controller.abort(); await dispose?.(); },
  };
}

test("attemptTuiStartup reports a bounded state-root failure with a diagnostic", async () => {
  const api = { state: { path: {} } };
  const result = await attemptTuiStartup(api, { env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.phase, "state-root");
  assert.equal(typeof result.reason, "string");
  assert.match(result.diagnostic, /State root unavailable/u);
});

test("attemptTuiStartup reports a bounded identity failure with a diagnostic", async () => {
  const api = { state: { path: { state: "/state", worktree: "/worktree", directory: "/worktree" } } };
  const result = await attemptTuiStartup(api, {
    projectFingerprint: "f".repeat(64),
    remoteUrl: "https://github.com/example/repo",
    worktree: "/different/worktree",
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, "identity");
  assert.match(result.reason, /project-fingerprint-mismatch/u);
  assert.match(result.diagnostic, /Project identity unresolved/u);
});

test("attemptTuiStartup resolves on a healthy configuration", async () => {
  const api = { state: { path: { state: "/state", worktree: "/worktree", directory: "/worktree" } } };
  const result = await attemptTuiStartup(api, {});
  assert.equal(result.ok, true);
  assert.equal(result.stateRoot, "/state");
  assert.equal(typeof result.identity.projectFingerprint, "string");
});

test("inert recovery store holds zero authority", async () => {
  let calls = 0;
  const store = createInertRecoveryStore({
    diagnostic: "State root unavailable: state-root-unavailable",
    retry: async () => { calls += 1; return { ok: false, diagnostic: "still-failing" }; },
    now: () => 5_000,
  });
  assert.equal(store.inert, true);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.inert, true);
  assert.equal(snapshot.phase, "error");
  assert.deepEqual(snapshot.pending, []);
  assert.deepEqual(snapshot.responses, []);
  assert.equal(snapshot.projection, null);
  assert.equal(snapshot.dashboard, null);
  assert.equal(snapshot.global, null);
  assert.match(snapshot.error, /State root unavailable/u);

  for (const method of ["submitDecision", "submitControl", "submitOperation", "submitRecommendationAction", "prepareGlobalAction"]) {
    await assert.rejects(store[method](), /inert-store-no-authority/u, `${method} must reject`);
  }
  const unchanged = store.acknowledgeOutcome("anything");
  assert.equal(unchanged, snapshot);
  assert.equal(store.acknowledgeGlobalFailure("x"), snapshot);
  await assert.doesNotReject(store.selectDetails([]));
  assert.equal(calls, 0, "no retry until refresh is requested");
});

test("inert recovery store subscribe delivers the diagnostic snapshot once and unbinds cleanly", () => {
  const store = createInertRecoveryStore({ diagnostic: "fail", now: () => 1 });
  const seen = [];
  const unsubscribe = store.subscribe((next) => seen.push(next.error));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /fail/u);
  unsubscribe();
  store.subscribe((next) => seen.push(next.error));
  assert.equal(seen.length, 2);
});

test("inert recovery store Retry re-runs resolution once per refresh and updates the diagnostic", async () => {
  let attempts = 0;
  const store = createInertRecoveryStore({
    diagnostic: "first-failure",
    retry: async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, diagnostic: "second-failure" }
        : { ok: true };
    },
    now: () => 9_000,
  });
  assert.match(store.getSnapshot().error, /first-failure/u);
  const first = await store.refresh();
  assert.equal(attempts, 1);
  assert.match(first.error, /second-failure/u);
  const second = await store.refresh();
  assert.equal(attempts, 2);
  assert.match(second.error, /Restart OpenCode/u);
  const third = await store.refresh();
  assert.equal(attempts, 3, "retry is user-initiated and never loops on its own");
  assert.match(third.error, /Restart OpenCode/u);
});

test("inert recovery store disposes cleanly and stops notifying", async () => {
  const store = createInertRecoveryStore({ diagnostic: "fail", now: () => 1 });
  const seen = [];
  store.subscribe((next) => seen.push(next.error));
  store.dispose();
  const snapshot = await store.refresh();
  assert.equal(seen.length, 1, "refresh after dispose does not notify");
  assert.doesNotReject(store.selectDetails([]));
  const after = store.subscribe((next) => seen.push(next.error));
  assert.equal(seen.length, 1, "subscribe after dispose is a no-op");
  after();
});

test("inert snapshot renders a failure sidebar card and recovery control-center model", () => {
  const store = createInertRecoveryStore({ diagnostic: "Project identity unresolved: mismatch", now: () => 1 });
  const snapshot = store.getSnapshot();
  const card = deriveSidebarCard(snapshot);
  assert.equal(card.kind, "failure");
  assert.equal(card.tone, "error");
  assert.match(card.summary, /Self-evolve needs recovery/u);
  assert.deepEqual(card.destination, { section: "activity", filter: "errors" });
  const model = buildControlCenterModel(snapshot);
  assert.equal(model.phase, "error");
  assert.equal(model.recovery.stale, false);
  assert.match(model.recovery.diagnostic, /Project identity unresolved/u);
  assert.equal(model.recovery.canRetry, true);
  const mode = deriveSidebarModeControl(snapshot);
  assert.equal(mode.available, false);
  assert.equal(mode.current, "off");
});

test("SelfEvolveTuiPlugin notifies the native startup-failure sink and still warns on identity failure", async () => {
  const h = inertHarness();
  let captured = null;
  const originalWarn = console.warn;
  let warning = "";
  console.warn = (value) => { warning = String(value); };
  try {
    await SelfEvolveTuiPlugin(h.api, {
      __nativeSidebar: true,
      __nativeStartupFailure(failure) { captured = failure; },
      selfEvolve: {
        projectFingerprint: "f".repeat(64),
        remoteUrl: "https://github.com/example/repo",
        worktree: "/different/worktree",
      },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(captured, "the native startup-failure sink was not invoked");
  assert.equal(captured.ok, false);
  assert.equal(captured.phase, "identity");
  assert.match(captured.diagnostic, /Project identity unresolved/u);
  assert.match(warning, /self-evolve TUI disabled/u);
  assert.match(warning, /project-fingerprint-mismatch/u);
  await h.dispose();
});

test("SelfEvolveTuiPlugin notifies the native startup-failure sink on state-root failure", async () => {
  let captured = null;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await SelfEvolveTuiPlugin(
      { state: { path: {} }, kv: { get: () => undefined, set: () => {} } },
      {
        __nativeSidebar: true,
        __nativeStartupFailure(failure) { captured = failure; },
        selfEvolve: { env: {} },
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(captured, "state-root failure did not reach the native sink");
  assert.equal(captured.phase, "state-root");
  assert.match(captured.diagnostic, /State root unavailable/u);
});

test("coexistence: healthy native startup never invokes the startup-failure sink", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-inert-coexist-"));
  const stateRoot = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(worktree, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = inertHarness();
  h.api.app = { version: "1.18.3" };
  h.api.state.path = { state: stateRoot, config: path.join(root, "config"), worktree, directory: worktree };
  t.after(async () => h.dispose());
  let sinkCalled = false;
  const projectStore = { refresh() { return Promise.resolve({ phase: "legacy" }); } };
  await SelfEvolveTuiPlugin(h.api, {
    __nativeSidebar: true,
    __nativeStartupFailure() { sinkCalled = true; },
    __testTuiStoreFactory() { return projectStore; },
  });
  assert.equal(sinkCalled, false, "healthy startup must not trigger the inert sink");
});
