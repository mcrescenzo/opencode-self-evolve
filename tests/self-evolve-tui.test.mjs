import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SelfEvolveTuiPlugin,
  buildDecisionFromDialog,
  createTuiAcknowledgementStore,
  formatDiffOrNewSkillPreview,
  formatEligibilityExplanation,
  formatProposalDigest,
  notificationRateLimiter,
  pruneReviewBookkeeping,
  resolveTuiStateRoot,
  safeIdlePredicate,
  shouldShowProposal,
} from "../self-evolve-tui.js";
import tuiModule, { TUI_KV_KEYS, TUI_LEGACY_KV_KEYS } from "../self-evolve-tui.js";
import { BRIDGE_SCHEMA_VERSION, publishControlState, readTuiHostHealth } from "../self-evolve-bridge.js";
import { openStore, projectFingerprintFor } from "../self-evolve-store.js";
import * as schemas from "../self-evolve-schemas.js";
import { resolveStateRoot, stateRootIdentity } from "../self-evolve-state-root.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function proposal(overrides = {}) {
  return {
    id: "proposal-1",
    projectFingerprint: "c".repeat(64),
    clusterId: "d".repeat(64),
    skillTarget: { canonicalRoot: "/skills", relativePath: "review/SKILL.md", currentHash: HASH_A },
    proposedContentHash: HASH_B,
    rationaleText: "Repeated evidence supports a bounded review skill improvement.",
    synthesizedAt: 1_000,
    synthesizerModelId: "mock/model",
    criticScore: 0.95,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    injectionFlagged: false,
    decisionVersion: 0,
    burnedNonceHashes: [],
    decisionNonce: "nonce-proposal-1",
    proposedContent: "# Review\n\nUse a deterministic checklist.",
    currentContent: "# Review\n\nUse a checklist.",
    eligibility: { eligible: true, reasons: ["all-thresholds-met"], thresholdsMet: { minIncidents: 3 }, thresholdsMissed: {} },
    inventory: { currentTokens: 10, proposedTokens: 14 },
    ...overrides,
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness({ kv, proposals = [], clock = 2_000, status = { type: "idle", since: 0 }, decide, execute, controlState } = {}) {
  const store = kv ?? new Map();
  const events = new Map();
  const confirms = [];
  const selects = [];
  const alerts = [];
  const prompts = [];
  const toasts = [];
  const notifications = [];
  const decisions = [];
  const commands = [];
  const controls = [];
  const keymapLayers = [];
  const responses = new Map();
  const promptAsync = { calls: 0 };
  const appendPrompt = { calls: 0 };
  const controller = new AbortController();
  let sessionStatus = status;
  let inbox = proposals;
  let dispose;
  const bridge = {
    async getInbox() { return inbox; },
    async submit(request) {
      const input = { decision: {
        proposalId: request.proposalId,
        targetHash: request.targetHash,
        proposedContentHash: request.proposedContentHash,
        decisionVersion: request.decisionVersion,
        actor: request.actor,
        timestamp: request.timestamp,
        nonce: request.nonce,
        priorState: request.priorState,
        newState: request.newState,
      } };
      decisions.push(input);
      const result = decide ? await decide(input, { inbox, setInbox: (value) => { inbox = value; } }) : { ok: true };
      responses.set(request.requestId, { ...result, requestId: request.requestId });
      return { ok: true };
    },
    async poll(requestId) { return responses.get(requestId) ?? null; },
    async getControlState() { return controlState; },
    async submitControl(request) {
      controls.push(request);
      responses.set(request.requestId, { ok: true, requestId: request.requestId });
      return { ok: true };
    },
    async pollControl(requestId) { return responses.get(requestId) ?? null; },
  };
  const api = {
    now: () => clock,
    route: { current: { name: "session", params: { sessionID: "session-1" } } },
    kv: {
      get(key, fallback) { return store.has(key) ? store.get(key) : fallback; },
      set(key, value) { store.set(key, value); },
    },
    ui: {
      DialogConfirm(props) { confirms.push(props); return props; },
      DialogSelect(props) { selects.push(props); return props; },
      DialogPrompt(props) { prompts.push(props); return props; },
      DialogAlert(props) { alerts.push(props); return props; },
      toast(input) { toasts.push(input); },
      dialog: {
        replace(render) { return render(); },
        clear() {},
        setSize() {},
      },
    },
    attention: { async notify(input) { notifications.push(input); return { ok: true, notification: true, sound: false }; } },
    keymap: { registerLayer(layer) { keymapLayers.push(layer); return () => {}; } },
    event: {
      on(type, handler) {
        const handlers = events.get(type) ?? [];
        handlers.push(handler);
        events.set(type, handlers);
        return () => events.set(type, (events.get(type) ?? []).filter((item) => item !== handler));
      },
    },
    lifecycle: {
      signal: controller.signal,
      onDispose(fn) { dispose = fn; return () => { dispose = undefined; }; },
    },
    state: {
      path: { state: "/state", config: "/config", worktree: "/worktree", directory: "/repo" },
      session: {
        messages: () => [],
        status: () => sessionStatus,
        get: () => ({ id: "session-1" }),
      },
    },
    client: {
      session: { async promptAsync() { promptAsync.calls += 1; } },
      tui: { async appendPrompt() { appendPrompt.calls += 1; } },
    },
    __testMailboxClient: bridge,
    __testAutoReview: true,
  };
  return {
    api,
    bridge,
    kv: store,
    confirms,
    selects,
    alerts,
    prompts,
    toasts,
    notifications,
    decisions,
    commands,
    controls,
    keymapLayers,
    promptAsync,
    appendPrompt,
    event(type, payload = {}) { for (const handler of events.get(type) ?? []) handler(payload); },
    setClock(value) { clock = value; },
    setStatus(value) { sessionStatus = value; },
    setSession(value) { api.route.current.params.sessionID = value; },
    setInbox(value) { inbox = value; },
    async dispose() { controller.abort(); await dispose?.(); },
  };
}

function enabledKv() {
  return new Map([["self-evolve:first-use-seen", true]]);
}

function actionDialog(h) {
  return h.selects.find((dialog) => dialog.options.some((option) => option.value === "apply" || option.value === "undo"));
}

test("default export is a TUI-only plugin module", () => {
  assert.deepEqual(Object.keys(tuiModule), ["id", "tui"]);
  assert.equal(tuiModule.id, "mcrescenzo.self-evolve");
  assert.equal(tuiModule.tui, SelfEvolveTuiPlugin);
});

test("production TUI acquires and refreshes the project-scoped projection store", async () => {
  const h = harness({ kv: enabledKv() });
  h.api.app = { version: "1.18.3" };
  const calls = [];
  const projectStore = {
    refresh() {
      calls.push("refresh");
      return Promise.resolve({ phase: "legacy" });
    },
  };
  await SelfEvolveTuiPlugin(h.api, {
    __testTuiStoreFactory(input) {
      calls.push(input);
      return projectStore;
    },
  });
  assert.equal(calls[0].api, h.api);
  assert.equal(calls[0].config.startupStateRoot, "/state");
  assert.equal(calls[0].config.startupWorktree, "/worktree");
  assert.equal(Object.hasOwn(calls[0].config, "projectFingerprint"), false);
  assert.deepEqual(calls[0].runtimeMetadata, {
    hostVersion: "1.18.3",
    hostVersionSource: "tui-app-version",
    pluginVersion: JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  });
  assert.equal(calls[1], "refresh");
  await h.dispose();
});

test("TUI root selection matches server precedence and fails closed when the official SDK is unavailable", async () => {
  const calls = [];
  const api = {
    state: { path: { state: "/official/synchronous", worktree: "/workspace", directory: "/workspace" } },
    client: { path: { get: async (input) => {
      calls.push(input);
      return { data: { state: "/official/sdk" } };
    } } },
  };
  const environment = { XDG_STATE_HOME: "/environment/xdg", HOME: "/environment/home" };

  assert.equal(await resolveTuiStateRoot(api, { stateRoot: "/explicit", env: environment }), "/explicit");
  assert.equal(await resolveTuiStateRoot(api, { env: environment }), "/official/synchronous");
  assert.equal(calls.length, 0, "explicit and synchronous official roots must not call the SDK");

  delete api.state.path.state;
  assert.equal(await resolveTuiStateRoot(api, { env: environment }), "/official/sdk");
  assert.deepEqual(calls, [{ directory: "/workspace" }]);
  assert.equal(await resolveStateRoot({
    directory: "/workspace",
    client: api.client,
  }, { env: environment }), "/official/sdk");

  api.client.path.get = async () => { throw new Error("official-unavailable"); };
  assert.equal(await resolveTuiStateRoot(api, { env: environment, stateRootTimeoutMs: 10 }), null);
  delete api.client.path;
  assert.equal(await resolveTuiStateRoot(api, { env: environment }), "/environment/xdg/opencode");
  assert.equal(await resolveTuiStateRoot(api, { env: { HOME: "/environment/home" } }), "/environment/home/.local/state/opencode");
});

test("fresh TUI processes derive the same environment root identities without inherited environment merging", () => {
  const moduleUrl = new URL("../self-evolve-tui.js", import.meta.url).href;
  const stateRootModuleUrl = new URL("../self-evolve-state-root.js", import.meta.url).href;
  const run = (environment) => spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { resolveTuiStateRoot } from ${JSON.stringify(moduleUrl)};\n`
      + `import { stateRootIdentity } from ${JSON.stringify(stateRootModuleUrl)};\n`
      + "const root = await resolveTuiStateRoot({ state: { path: { worktree: '/workspace', directory: '/workspace' } }, client: {} });\n"
      + "process.stdout.write(stateRootIdentity(root));\n",
  ], { env: environment, encoding: "utf8" });

  const xdg = run({ XDG_STATE_HOME: "/isolated/xdg", HOME: "/ignored/home" });
  assert.equal(xdg.error, undefined);
  assert.equal(xdg.status, 0, xdg.stderr);
  assert.equal(xdg.stderr, "");
  assert.equal(xdg.stdout, stateRootIdentity("/isolated/xdg/opencode"));

  const home = run({ HOME: "/isolated/home" });
  assert.equal(home.error, undefined);
  assert.equal(home.status, 0, home.stderr);
  assert.equal(home.stderr, "");
  assert.equal(home.stdout, stateRootIdentity("/isolated/home/.local/state/opencode"));
});

test("production background refresh never emits toast, attention, or auto-dialog UI", async () => {
  const h = harness({ proposals: [proposal()] });
  h.api.__testAutoReview = false;
  await SelfEvolveTuiPlugin(h.api);
  h.event("self-evolve.proposal");
  h.event("session.idle");
  h.event("session.status");
  await flush();
  assert.equal(h.confirms.length, 0);
  assert.equal(h.selects.length, 0);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.notifications.length, 0);
  await h.dispose();
});

test("TUI publishes current api.app.version as a root-bound host-health runtime report", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-health-"));
  const stateRoot = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(worktree, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness({ kv: enabledKv(), clock: 2_000 });
  t.after(async () => h.dispose());
  h.api.app = { version: "1.18.3" };
  h.api.state.path = { state: stateRoot, config: path.join(root, "config"), worktree, directory: worktree };
  await SelfEvolveTuiPlugin(h.api);
  const projectFingerprint = projectFingerprintFor("", worktree);
  const health = readTuiHostHealth(stateRoot, projectFingerprint, { now: 2_000, stateRootIdentity: stateRootIdentity(stateRoot) });

  assert.equal(health.hostVersion, "1.18.3");
  assert.equal(health.projectFingerprint, projectFingerprint);
  await h.dispose();
  assert.equal(readTuiHostHealth(stateRoot, projectFingerprint, { now: 2_000, stateRootIdentity: stateRootIdentity(stateRoot) }), null);
});

test("accepted-terminal native state revokes host health and later callbacks cannot recreate it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-terminal-health-"));
  const stateRoot = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(worktree, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness({ kv: enabledKv(), clock: 2_000 });
  t.after(async () => h.dispose());
  h.api.app = { version: "1.18.3" };
  h.api.state.path = { state: stateRoot, config: path.join(root, "config"), worktree, directory: worktree };
  const projectFingerprint = projectFingerprintFor("", worktree);
  const ready = {
    phase: "ready",
    projectFingerprint,
    stateRootIdentity: stateRootIdentity(stateRoot),
  };
  let listener;
  let unsubscribed = false;
  const projectStore = {
    refresh() { return Promise.resolve(ready); },
    subscribe(callback) {
      listener = callback;
      callback(ready);
      return () => { unsubscribed = true; };
    },
  };
  await SelfEvolveTuiPlugin(h.api, { __testTuiStoreFactory: () => projectStore });
  assert.equal(readTuiHostHealth(stateRoot, projectFingerprint, {
    now: 2_000,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }).hostVersion, "1.18.3");

  listener({ ...ready, phase: "terminal" });
  assert.equal(unsubscribed, true);
  assert.equal(readTuiHostHealth(stateRoot, projectFingerprint, {
    now: 2_000,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }), null);
  listener(ready);
  assert.equal(readTuiHostHealth(stateRoot, projectFingerprint, {
    now: 2_000,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }), null);
});

test("TUI boot uses the v2 official path result before reactive path state is populated", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-path-bootstrap-"));
  const stateRoot = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(worktree, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness({ kv: enabledKv(), clock: 2_000 });
  t.after(async () => h.dispose());
  h.api.app = { version: "1.18.14" };
  h.api.state.path = { state: "", config: "", worktree: "", directory: "" };
  const calls = [];
  h.api.client.path = {
    async get(input) {
      calls.push(input);
      return { data: { state: stateRoot, config: path.join(root, "config"), worktree, directory: worktree } };
    },
  };

  await SelfEvolveTuiPlugin(h.api, {
    __testTuiStoreFactory() {
      return { refresh() { return Promise.resolve(); } };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], "query"), false, "the TUI exposes the v2 SDK parameter shape");
  const projectFingerprint = projectFingerprintFor("", worktree);
  assert.equal(readTuiHostHealth(stateRoot, projectFingerprint, {
    now: 2_000,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }).hostVersion, "1.18.14");
});

test("TUI boot resolves missing identity paths even when root precedence bypasses the SDK", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-identity-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const source of ["explicit", "synchronous"]) {
    const stateRoot = path.join(root, `${source}-state`);
    const worktree = path.join(root, `${source}-worktree`);
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(worktree, { recursive: true });
    const h = harness({ kv: enabledKv(), clock: 2_000 });
    h.api.app = { version: "1.18.14" };
    h.api.state.path = {
      state: source === "synchronous" ? stateRoot : "",
      config: "",
      worktree: "",
      directory: "",
    };
    const calls = [];
    h.api.client.path = {
      async get(input) {
        calls.push(input);
        return { data: { state: stateRoot, config: path.join(root, `${source}-config`), worktree, directory: worktree } };
      },
    };

    await SelfEvolveTuiPlugin(h.api, {
      ...(source === "explicit" ? { stateRoot } : {}),
      __testTuiStoreFactory() {
        return { refresh() { return Promise.resolve(); } };
      },
    });

    assert.deepEqual(calls, [{}], source);
    const projectFingerprint = projectFingerprintFor("", worktree);
    assert.equal(readTuiHostHealth(stateRoot, projectFingerprint, {
      now: 2_000,
      stateRootIdentity: stateRootIdentity(stateRoot),
    }).hostVersion, "1.18.14", source);
    await h.dispose();
  }
});

test("TUI host-health publication rebinds when the official project path changes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-health-rebind-"));
  const stateRoot = path.join(root, "state");
  const firstWorktree = path.join(root, "first-worktree");
  const secondWorktree = path.join(root, "second-worktree");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(firstWorktree, { recursive: true });
  fs.mkdirSync(secondWorktree, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness({ kv: enabledKv(), clock: 2_000 });
  t.after(async () => h.dispose());
  h.api.app = { version: "1.18.14" };
  h.api.state.path = {
    state: stateRoot,
    config: path.join(root, "config"),
    worktree: firstWorktree,
    directory: firstWorktree,
  };
  let storeListener;
  await SelfEvolveTuiPlugin(h.api, {
    __testTuiStoreFactory() {
      return {
        refresh() { return Promise.resolve(); },
        subscribe(listener) {
          storeListener = listener;
          return () => { storeListener = undefined; };
        },
      };
    },
  });
  const firstFingerprint = projectFingerprintFor("", firstWorktree);
  const secondFingerprint = projectFingerprintFor("", secondWorktree);
  assert.equal(readTuiHostHealth(stateRoot, firstFingerprint, {
    now: 2_000,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }).hostVersion, "1.18.14");
  h.setClock(2_500);
  storeListener({
    phase: "ready",
    projectFingerprint: firstFingerprint,
    stateRootIdentity: stateRootIdentity(stateRoot),
  });
  assert.equal(readTuiHostHealth(stateRoot, firstFingerprint, {
    now: 2_500,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }).issuedAt, 2_000, "unchanged store snapshots must not rewrite the health heartbeat");

  h.api.state.path.worktree = secondWorktree;
  h.api.state.path.directory = secondWorktree;
  assert.equal(typeof storeListener, "function");
  storeListener({
    phase: "initializing",
    projectFingerprint: secondFingerprint,
    stateRootIdentity: stateRootIdentity(stateRoot),
  });

  assert.equal(readTuiHostHealth(stateRoot, firstFingerprint, {
    now: 2_500,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }), null);
  assert.equal(readTuiHostHealth(stateRoot, secondFingerprint, {
    now: 2_500,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }).hostVersion, "1.18.14");

  storeListener({ phase: "error" });
  assert.equal(readTuiHostHealth(stateRoot, secondFingerprint, {
    now: 2_500,
    stateRootIdentity: stateRootIdentity(stateRoot),
  }), null);
});

test("TUI host-health rebind fails closed when the prior generation cannot be revoked", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-health-rebind-failure-"));
  const stateRoot = path.join(root, "state");
  const firstWorktree = path.join(root, "first-worktree");
  const secondWorktree = path.join(root, "second-worktree");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(firstWorktree, { recursive: true });
  fs.mkdirSync(secondWorktree, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness({ kv: enabledKv(), clock: 2_000 });
  t.after(async () => h.dispose());
  h.api.app = { version: "1.18.14" };
  h.api.state.path = {
    state: stateRoot,
    config: path.join(root, "config"),
    worktree: firstWorktree,
    directory: firstWorktree,
  };
  let storeListener;
  await SelfEvolveTuiPlugin(h.api, {
    __testTuiStoreFactory() {
      return {
        refresh() { return Promise.resolve(); },
        subscribe(listener) {
          storeListener = listener;
          return () => { storeListener = undefined; };
        },
      };
    },
  });
  const firstFingerprint = projectFingerprintFor("", firstWorktree);
  const secondFingerprint = projectFingerprintFor("", secondWorktree);
  const firstReport = path.join(stateRoot, "self-evolve", "bridge", firstFingerprint, "tui-host-health.json");
  fs.chmodSync(firstReport, 0o644);
  h.api.state.path.worktree = secondWorktree;
  h.api.state.path.directory = secondWorktree;
  const originalWarn = console.warn;
  let warning;
  console.warn = (value) => { warning = String(value); };
  try {
    storeListener({
      phase: "initializing",
      projectFingerprint: secondFingerprint,
      stateRootIdentity: stateRootIdentity(stateRoot),
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warning, /tui-host-health-mode-rejected/u);
  assert.equal(fs.existsSync(path.join(stateRoot, "self-evolve", "bridge", secondFingerprint, "tui-host-health.json")), false);
  assert.equal(fs.existsSync(firstReport), true);
  fs.chmodSync(firstReport, 0o600);
  await h.dispose();
});

test("first-use consent is shown once and persists across TUI restarts", async () => {
  const sharedKv = new Map();
  const first = harness({ kv: sharedKv });
  await SelfEvolveTuiPlugin(first.api);
  assert.equal(first.confirms.length, 1);
  first.confirms[0].onConfirm();
  assert.equal(sharedKv.get(TUI_KV_KEYS.firstUse), true);
  await first.dispose();

  const second = harness({ kv: sharedKv });
  await SelfEvolveTuiPlugin(second.api);
  assert.equal(second.confirms.length, 0);
  await second.dispose();
});

test("declining first-use consent leaves proposals in the inbox", async () => {
  const h = harness({ proposals: [proposal()] });
  await SelfEvolveTuiPlugin(h.api);
  h.confirms[0].onCancel();
  h.event("self-evolve.proposal");
  await flush();
  assert.equal(h.selects.length, 0);
  assert.equal(h.kv.get(TUI_KV_KEYS.firstUse), false);
  await h.dispose();
});

test("proposal digest exposes all render fields", () => {
  assert.deepEqual(formatProposalDigest(proposal(), { currentTokens: 10, proposedTokens: 14 }), {
    title: "Review proposal: review/SKILL.md",
    body: "Repeated evidence supports a bounded review skill improvement.",
    risk: "low",
    tokenDelta: 4,
    actionLabel: "Review proposal",
  });
});

test("critical failed-closed records are visible without an Apply action", async () => {
  const h = harness({ kv: enabledKv(), proposals: [proposal({ state: "failed-closed", decisionVersion: 2 })] });
  await SelfEvolveTuiPlugin(h.api);
  h.event("self-evolve.proposal");
  await flush();
  const dialog = h.selects.find((item) => item.title.includes("Critical failed-closed"));
  assert.ok(dialog);
  assert.equal(dialog.options.some((option) => option.value === "apply"), false);
  assert.deepEqual(dialog.options.map((option) => option.value), ["dismiss-audit"]);
  await h.dispose();
});

test("diff preview is bounded and marked as truncated", () => {
  const current = Array.from({ length: 80 }, (_, index) => `old ${index}`).join("\n");
  const proposedContent = Array.from({ length: 80 }, (_, index) => `new ${index}`).join("\n");
  const result = formatDiffOrNewSkillPreview(proposal({ proposedContent }), current);
  assert.equal(result.kind, "diff");
  assert.equal(result.linesChanged, 80);
  assert.equal(result.previewText.split("\n").length, 51);
  assert.match(result.previewText, /\[truncated/);
});

test("new-skill preview shows complete bounded content", () => {
  const result = formatDiffOrNewSkillPreview(proposal({ proposedContent: "one\ntwo\nthree" }), null);
  assert.deepEqual(result, { kind: "new", previewText: "one\ntwo\nthree", linesChanged: 3 });
});

test("very long new-skill content is bounded", () => {
  const proposedContent = Array.from({ length: 70 }, (_, index) => `line ${index}`).join("\n");
  const result = formatDiffOrNewSkillPreview(proposal({ proposedContent }), undefined);
  assert.equal(result.previewText.split("\n").length, 51);
  assert.match(result.previewText, /\[truncated/);
});

test("eligibility explanation renders bullet lines", () => {
  const output = formatEligibilityExplanation({ reasons: ["enough-incidents"], thresholdsMet: { count: 3 }, thresholdsMissed: { score: 1 } });
  assert.deepEqual(output, ["- enough-incidents", "- Met count: 3", "- Missing score: 1"]);
});

test("decision helper builds the hash-bound CAS tuple for every dialog choice", () => {
  const base = proposal({ decisionTimestamp: 2_000, decisionNonce: "nonce-1" });
  const expected = { apply: "approved", snooze: "pending", dismiss: "rejected", exclude: "rejected" };
  for (const [choice, newState] of Object.entries(expected)) {
    const decision = buildDecisionFromDialog(base, choice, "reviewer");
    assert.deepEqual(
      Object.fromEntries(["proposalId", "targetHash", "proposedContentHash", "decisionVersion", "actor", "timestamp", "nonce", "priorState", "newState"].map((key) => [key, decision[key]])),
      { proposalId: base.id, targetHash: HASH_A, proposedContentHash: HASH_B, decisionVersion: 1, actor: "reviewer", timestamp: 2_000, nonce: "nonce-1", priorState: "pending", newState },
    );
  }
});

test("Apply re-reads the proposal, writes a Decision, and disables duplicate clicks", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = harness({ kv: enabledKv(), proposals: [proposal()], decide: async () => { await blocked; return { ok: true }; } });
  await SelfEvolveTuiPlugin(h.api);
  await flush();
  const dialog = actionDialog(h);
  const apply = dialog.options.find((option) => option.value === "apply");
  apply.onSelect();
  apply.onSelect();
  await flush();
  assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0].decision.newState, "approved");
  assert.ok(h.selects.at(-1).options.every((option) => option.disabled));
  release();
  await flush();
  await h.dispose();
});

test("Snooze and Dismiss dispatch the correct requested state", async () => {
  for (const [choice, state] of [["snooze", "pending"], ["dismiss", "rejected"]]) {
    const item = proposal({ id: `proposal-${choice}` });
    const h = harness({ kv: enabledKv(), proposals: [item] });
    await SelfEvolveTuiPlugin(h.api);
    await flush();
    actionDialog(h).options.find((option) => option.value === choice).onSelect();
    await flush();
    assert.equal(h.decisions[0].decision.newState, state);
    await h.dispose();
  }
});

test("Undo is offered only for applied yolo audits and requests rolled-back state", async () => {
  const applied = proposal({ state: "applied", mode: "yolo", appliedAt: 2_000, priorContent: "old", appliedContent: "new", proposedContent: "new" });
  const h = harness({ kv: enabledKv(), proposals: [applied] });
  await SelfEvolveTuiPlugin(h.api);
  await flush();
  const dialog = actionDialog(h);
  assert.match(dialog.options[0].footer, /- old/);
  assert.match(dialog.options[0].footer, /\+ new/);
  dialog.options.find((option) => option.value === "undo").onSelect();
  await flush();
  assert.equal(h.decisions[0].decision.priorState, "applied");
  assert.equal(h.decisions[0].decision.newState, "rolled-back");
  await h.dispose();

  const pending = harness({ kv: enabledKv(), proposals: [proposal()] });
  await SelfEvolveTuiPlugin(pending.api);
  await flush();
  assert.equal(actionDialog(pending).options.some((option) => option.value === "undo"), false);
  await pending.dispose();
});

test("stale decisions show an alert and refresh the durable inbox", async () => {
  let reads = 0;
  const h = harness({ kv: enabledKv(), proposals: [proposal()], decide: () => ({ ok: false, reason: "stale-prior-state" }) });
  const original = h.bridge.getInbox;
  h.bridge.getInbox = async (...args) => { reads += 1; return original(...args); };
  await SelfEvolveTuiPlugin(h.api);
  await flush();
  actionDialog(h).options.find((option) => option.value === "apply").onSelect();
  await flush();
  await flush();
  assert.match(h.alerts[0].message, /stale-prior-state/);
  assert.ok(reads >= 2);
  await h.dispose();
});

test("notification limiter suppresses the fourth notification and persists over restart", () => {
  const sharedKv = new Map();
  const first = harness({ kv: sharedKv, clock: 10_000 });
  const limiter = notificationRateLimiter(first.api, 3);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(limiter.canNotify(`reason-${index}`).ok, true);
    limiter.record(`reason-${index}`);
  }
  assert.deepEqual(limiter.canNotify("fourth"), { ok: false, reason: "notification-budget-exhausted" });
  const restarted = harness({ kv: sharedKv, clock: 10_001 });
  assert.equal(notificationRateLimiter(restarted.api, 3).canNotify("after-restart").ok, false);
});

test("exhausted notification budget leaves a proposal in the durable inbox", async () => {
  const kv = enabledKv();
  kv.set("self-evolve:notification-history", [1, 2, 3].map((value) => ({ at: 2_000 - value, reason: "prior" })));
  const h = harness({ kv, proposals: [proposal()] });
  await SelfEvolveTuiPlugin(h.api);
  await flush();
  assert.equal(h.selects.length, 0);
  assert.equal((await h.bridge.getInbox()).length, 1);
  await h.dispose();
});

test("headless capability fallback exits without dialogs or errors", async () => {
  const h = harness({ proposals: [proposal()] });
  h.api.ui.DialogConfirm = undefined;
  const originalWarn = console.warn;
  let warning;
  console.warn = (value) => { warning = value; };
  try {
    await assert.doesNotReject(SelfEvolveTuiPlugin(h.api));
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warning, /durable inbox/);
  assert.equal(h.selects.length, 0);
});

test("two TUI processes racing Apply accept at most one CAS decision", async () => {
  let state = proposal();
  let accepted = 0;
  const serverDecide = ({ decision }) => {
    if (state.state !== decision.priorState) return { ok: false, reason: "stale-prior-state" };
    state = { ...state, state: decision.newState, decisionVersion: decision.decisionVersion };
    accepted += 1;
    return { ok: true };
  };
  const make = () => {
    const h = harness({ kv: enabledKv(), proposals: [state], decide: serverDecide });
  h.bridge.getInbox = async () => [state];
    return h;
  };
  const first = make();
  const second = make();
  await Promise.all([SelfEvolveTuiPlugin(first.api), SelfEvolveTuiPlugin(second.api)]);
  await flush();
  actionDialog(first).options.find((option) => option.value === "apply").onSelect();
  actionDialog(second).options.find((option) => option.value === "apply").onSelect();
  await flush();
  await flush();
  assert.equal(accepted, 1);
  assert.equal(first.alerts.length + second.alerts.length, 1);
  await Promise.all([first.dispose(), second.dispose()]);
});

test("safe-idle gating defers dialogs until idle has lasted 1500ms", async () => {
  const h = harness({ kv: enabledKv(), proposals: [proposal()], clock: 1_000, status: "busy" });
  await SelfEvolveTuiPlugin(h.api);
  await flush();
  assert.equal(h.selects.length, 0);
  h.setStatus({ type: "idle", since: 1_000 });
  h.setClock(2_499);
  h.event("session.idle");
  await flush();
  assert.equal(h.selects.length, 0);
  h.setClock(3_998);
  h.event("session.idle");
  await flush();
  assert.equal(h.selects.length, 0);
  h.setClock(3_999);
  h.event("session.idle");
  await flush();
  assert.ok(actionDialog(h));
  await h.dispose();
});

test("showing a proposal records last-shown so an unchanged proposal is not re-shown", async () => {
  const h = harness({ kv: enabledKv(), proposals: [proposal()], clock: 1_000, status: "busy" });
  const drain = () => new Promise((resolve) => setTimeout(resolve, 5));
  try {
    await SelfEvolveTuiPlugin(h.api, { idleDebounceMs: 0, mailboxPollMs: 5_000 });
    await drain();
    h.setStatus({ type: "idle", since: 1_000 });
    h.setClock(3_000);
    h.event("session.idle");
    await drain();
    assert.ok(actionDialog(h), "the pending proposal is shown once safely idle");
    const recorded = h.kv.get(TUI_KV_KEYS.lastShown);
    assert.equal(typeof recorded?.["proposal-1"], "number", "last-shown is recorded for the displayed proposal");
    const shown = h.selects.length;
    // A later refresh for the same unchanged proposal must not re-display it.
    h.setClock(9_000);
    h.event("session.idle");
    await drain();
    assert.equal(h.selects.length, shown, "an unchanged proposal is not re-shown on the next refresh");
  } finally {
    await h.dispose();
  }
});

test("safeIdlePredicate resets its debounce when a session becomes busy", () => {
  const h = harness({ clock: 2_000, status: { type: "idle", since: 0 } });
  const idle = safeIdlePredicate(h.api, 1_500);
  assert.equal(idle(), true);
  h.setStatus("busy");
  assert.equal(idle(), false);
  h.setStatus("idle");
  assert.equal(idle(), false);
});

test("safeIdlePredicate restarts the full debounce when the routed session changes", () => {
  const h = harness({ clock: 2_000, status: { type: "idle", since: 0 } });
  const idle = safeIdlePredicate(h.api, 1_500);
  assert.equal(idle(), true);
  h.setSession("session-2");
  assert.equal(idle(), false);
  h.setClock(3_499);
  assert.equal(idle(), false);
  h.setClock(3_500);
  assert.equal(idle(), true);
});

test("review bookkeeping prunes stale and absent entries to a fixed cap", () => {
  const now = 100 * 24 * 60 * 60 * 1000;
  const proposals = Array.from({ length: 300 }, (_, index) => proposal({ id: `proposal-${index}` }));
  const result = pruneReviewBookkeeping({
    proposals,
    dismissedIds: [...proposals.map((item) => item.id), "absent"],
    lastShownAt: Object.fromEntries([
      ...proposals.map((item, index) => [item.id, now - index]),
      ["stale", 0],
      ["absent", now],
    ]),
    now,
  });
  assert.equal(result.dismissedIds.length, 256);
  assert.equal(Object.keys(result.lastShownAt).length, 256);
  assert.equal(result.dismissedIds.includes("absent"), false);
  assert.equal(Object.hasOwn(result.lastShownAt, "absent"), false);
});

test("applied acknowledgement KV is project-local, version-bound, and audit-bound", () => {
  const kv = new Map([[TUI_LEGACY_KV_KEYS.acknowledgedAudits, "legacy-applied-proposal"]]);
  const acknowledgements = createTuiAcknowledgementStore(kv, { now: () => 1_000 });
  const binding = {
    scope: "project",
    subjectId: "proposal-one",
    version: "1".repeat(64),
    auditIds: ["audit-one"],
  };
  assert.deepEqual(acknowledgements.acknowledge(HASH_A, binding), [{ ...binding, acknowledgedAt: 1_000 }]);
  assert.deepEqual(acknowledgements.read(HASH_B), []);
  assert.deepEqual(kv.get(`${TUI_KV_KEYS.acknowledgedOutcomes}:${HASH_A}`), [{ ...binding, acknowledgedAt: 1_000 }]);
  assert.equal(kv.get(TUI_LEGACY_KV_KEYS.acknowledgedAudits), "legacy-applied-proposal");
});

test("applied acknowledgement KV deterministically caps each project at the newest 256 outcomes", () => {
  const kv = new Map();
  let clock = 0;
  const acknowledgements = createTuiAcknowledgementStore(kv, { now: () => ++clock });
  for (let index = 0; index < 300; index += 1) {
    acknowledgements.acknowledge(HASH_A, {
      scope: index % 2 === 0 ? "project" : "global",
      subjectId: `subject-${String(index).padStart(3, "0")}`,
      version: `version-${String(index).padStart(3, "0")}`,
      auditIds: [`audit-${String(index).padStart(3, "0")}`],
    });
  }
  const stored = kv.get(`${TUI_KV_KEYS.acknowledgedOutcomes}:${HASH_A}`);
  assert.equal(stored.length, 256);
  assert.deepEqual(stored[0].auditIds, ["audit-044"]);
  assert.deepEqual(stored.at(-1).auditIds, ["audit-299"]);
  assert.deepEqual(acknowledgements.read(HASH_B), []);
});

test("foreign or corrupt canonical acknowledgement KV is preserved with a conservative empty view", () => {
  const foreign = { owner: "another-plugin" };
  const key = `${TUI_KV_KEYS.acknowledgedOutcomes}:${HASH_A}`;
  const kv = new Map([[key, foreign]]);
  const acknowledgements = createTuiAcknowledgementStore(kv);
  assert.deepEqual(acknowledgements.read(HASH_A), []);
  assert.deepEqual(acknowledgements.acknowledge(HASH_A, {
    scope: "project", subjectId: "proposal", version: "version", auditIds: ["audit-one"],
  }), []);
  assert.equal(kv.get(key), foreign);
});

test("busy refresh bursts coalesce and late inbox completion is inert after dispose", async () => {
  const h = harness({ kv: enabledKv(), proposals: [proposal()], status: "busy" });
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.bridge.getInbox = async () => {
    reads += 1;
    await gate;
    return [proposal()];
  };
  await SelfEvolveTuiPlugin(h.api, { idleDebounceMs: 0, mailboxPollMs: 5_000 });
  for (let index = 0; index < 100; index += 1) {
    h.event(index % 2 ? "session.status" : "self-evolve.proposal");
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(reads, 0);

  h.setStatus("idle");
  h.setClock(2_001);
  h.event("session.idle");
  await new Promise((resolve) => setTimeout(resolve, 5));
  h.setClock(2_002);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(reads, 1);
  await h.dispose();
  release();
  await flush();
  assert.equal(h.selects.length, 0);
});

test("proposal filtering honors state, dismissal, snooze, and last-shown time", () => {
  const item = proposal();
  assert.equal(shouldShowProposal(item, { now: 2_000 }), true);
  assert.equal(shouldShowProposal(item, { dismissedIds: [item.id], now: 2_000 }), false);
  assert.equal(shouldShowProposal({ ...item, snoozedUntil: 3_000 }, { now: 2_000 }), false);
  assert.equal(shouldShowProposal(item, { lastShownAt: { [item.id]: 1_000 }, now: 2_000 }), false);
  assert.equal(shouldShowProposal({ ...item, state: "rejected" }, { now: 2_000 }), false);
  assert.equal(shouldShowProposal({ ...item, state: "critic-pending" }, { now: 2_000 }), false);
});

test("TUI never invokes promptAsync or appendPrompt", async () => {
  const h = harness({ kv: enabledKv(), proposals: [proposal()] });
  await SelfEvolveTuiPlugin(h.api);
  await flush();
  actionDialog(h).options.find((option) => option.value === "apply").onSelect();
  await flush();
  assert.equal(h.promptAsync.calls, 0);
  assert.equal(h.appendPrompt.calls, 0);
  await h.dispose();
});

test("production TUI registers the persistent control center and no legacy control mailbox", () => {
  const source = fs.readFileSync(new URL("../self-evolve-tui.tsx", import.meta.url), "utf8");
  assert.match(source, /Self-evolve control center/u);
  assert.match(source, /submitOperation\("set-automatic-recommendations"/u);
  assert.match(source, /submitOperation\("set-permission"/u);
  assert.doesNotMatch(source, /self-evolve\.settings|submitControl|control-requests/u);
});

test("production TUI keeps root and projection failures in its mounted read-only surface", () => {
  const source = fs.readFileSync(new URL("../self-evolve-tui.tsx", import.meta.url), "utf8");
  assert.match(source, /Read-only stale context remains available/u);
  assert.doesNotMatch(source, /DialogAlert|toast\(/u);
});

test("native permission changes use only the current strict operation envelope", () => {
  const source = fs.readFileSync(new URL("../self-evolve-tui.tsx", import.meta.url), "utf8");
  assert.match(source, /Consent disclosure/u);
  assert.match(source, /submitOperation\("set-permission", \{ permission: key, enabled: true \}\)/u);
  assert.doesNotMatch(source, /passiveCalls/u);
});

test("production TUI client resolves real state-root and worktree inputs without bridge injection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-production-"));
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  const projectFingerprint = projectFingerprintFor("", worktree);
  const store = openStore(root, { projectFingerprint, projectName: "tui-production" });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const item = schemas.makeProposal({
    id: "proposal-production",
    projectFingerprint,
    clusterId: "d".repeat(64),
    skillTarget: { canonicalRoot: path.join(root, "skills"), relativePath: "review/SKILL.md", currentHash: HASH_A },
    proposedContentHash: HASH_B,
    rationaleText: "Production filesystem inbox fixture.",
    synthesizedAt: 1_000,
    synthesizerModelId: "fixture/no-provider",
    criticScore: 1,
    criticPassed: true,
    validDeterministic: true,
    state: "pending",
    injectionFlagged: false,
  });
  store.appendRecord(schemas.wrapRecord("proposal", item, 1_000));
  const details = {
    action: "bridge-nonce",
    projectFingerprint,
    subjectId: item.id,
    targetHash: item.skillTarget.currentHash,
    proposedContentHash: item.proposedContentHash,
    decisionVersion: 1,
    priorState: "pending",
    actor: "self-evolve-tui",
    nonce: "f".repeat(48),
    expiresAt: 10_000,
  };
  store.appendRecord(schemas.wrapRecord("audit-event", schemas.makeAuditEvent({
    id: createHash("sha256").update(JSON.stringify(details)).digest("hex"),
    kind: "decision",
    proposalId: item.id,
    actor: "self-evolve-integration",
    timestamp: 1_000,
    payloadHash: createHash("sha256").update("grant").digest("hex"),
    details,
  }), 1_000));
  publishControlState(root, {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    projectFingerprint,
    actor: "self-evolve-integration",
    issuedAt: 1_000,
    expiresAt: 10_000,
    settingsUpdatedAt: 1_000,
    settingsVersion: "6".repeat(64),
    stateRootIdentity: stateRootIdentity(root),
    nonce: "production-control",
    mode: "auto",
    effectiveMode: "auto",
    allowedSkillRoots: [],
    consent: { passiveCalls: true, durableObservations: true, sanitizedExcerpts: false, crossRepoAggregation: false },
    repoExcluded: false,
  });

  const h = harness({ kv: enabledKv(), clock: 2_000 });
  delete h.api.__testMailboxClient;
  delete h.api.client.selfEvolve;
  h.api.state.path = { state: root, worktree, directory: worktree };
  await SelfEvolveTuiPlugin(h.api, { selfEvolve: { idleDebounceMs: 0, mailboxPollMs: 25 } });
  await flush();
  assert.equal(h.api.client.selfEvolve, undefined);
  assert.equal(actionDialog(h).options.some((option) => option.value === "apply"), true);
  await h.dispose();
});

test("TUI fails closed when an explicit fingerprint conflicts with remote and worktree inputs", async () => {
  const h = harness({ kv: enabledKv(), proposals: [proposal()] });
  delete h.api.__testMailboxClient;
  const originalWarn = console.warn;
  let warning = "";
  console.warn = (value) => { warning = String(value); };
  try {
    await SelfEvolveTuiPlugin(h.api, { selfEvolve: { projectFingerprint: "f".repeat(64), remoteUrl: "https://github.com/example/repo", worktree: "/different/worktree" } });
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warning, /project-fingerprint-mismatch/);
  assert.equal(h.selects.length, 0);
});
