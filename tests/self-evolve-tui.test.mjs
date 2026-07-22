import assert from "node:assert/strict";
import test from "node:test";
import {
  SelfEvolveTuiPlugin,
  buildDecisionFromDialog,
  formatDiffOrNewSkillPreview,
  formatEligibilityExplanation,
  formatProposalDigest,
  notificationRateLimiter,
  safeIdlePredicate,
  shouldShowProposal,
} from "../self-evolve-tui.js";
import tuiModule from "../self-evolve-tui.js";

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

function harness({ kv, proposals = [], clock = 2_000, status = { type: "idle", since: 0 }, decide, execute } = {}) {
  const store = kv ?? new Map();
  const events = new Map();
  const confirms = [];
  const selects = [];
  const alerts = [];
  const toasts = [];
  const notifications = [];
  const decisions = [];
  const commands = [];
  const promptAsync = { calls: 0 };
  const appendPrompt = { calls: 0 };
  const controller = new AbortController();
  let sessionStatus = status;
  let inbox = proposals;
  let dispose;
  const bridge = {
    async getInbox() { return { proposals: inbox }; },
    async getProposal({ proposalId }) { return inbox.find((item) => item.id === proposalId) ?? null; },
    async decide(input) {
      decisions.push(input);
      if (decide) return decide(input, { inbox, setInbox: (value) => { inbox = value; } });
      return { ok: true };
    },
    async execute(input) {
      commands.push(input);
      return execute ? execute(input) : { ok: true };
    },
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
      DialogAlert(props) { alerts.push(props); return props; },
      toast(input) { toasts.push(input); },
    },
    attention: { async notify(input) { notifications.push(input); return { ok: true, notification: true, sound: false }; } },
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
      selfEvolve: bridge,
      session: { async promptAsync() { promptAsync.calls += 1; } },
      tui: { async appendPrompt() { appendPrompt.calls += 1; } },
    },
  };
  return {
    api,
    bridge,
    kv: store,
    confirms,
    selects,
    alerts,
    toasts,
    notifications,
    decisions,
    commands,
    promptAsync,
    appendPrompt,
    event(type, payload = {}) { for (const handler of events.get(type) ?? []) handler(payload); },
    setClock(value) { clock = value; },
    setStatus(value) { sessionStatus = value; },
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
  assert.deepEqual(Object.keys(tuiModule), ["tui"]);
  assert.equal(tuiModule.tui, SelfEvolveTuiPlugin);
});

test("first-use consent is shown once and persists across TUI restarts", async () => {
  const sharedKv = new Map();
  const first = harness({ kv: sharedKv });
  await SelfEvolveTuiPlugin(first.api);
  assert.equal(first.confirms.length, 1);
  first.confirms[0].onConfirm();
  assert.equal(sharedKv.get("self-evolve:first-use-seen"), true);
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
  assert.equal(h.kv.get("self-evolve:first-use-seen"), false);
  await h.dispose();
});

test("global manual and auto mode selection use native confirmation and command policy shapes", async () => {
  const h = harness({ kv: enabledKv() });
  await SelfEvolveTuiPlugin(h.api);
  h.event("self-evolve.settings", { action: "mode", mode: "manual" });
  h.confirms.at(-1).onConfirm();
  h.event("self-evolve.settings", { action: "mode", mode: "auto" });
  h.confirms.at(-1).onConfirm();
  await flush();
  assert.deepEqual(h.commands.map((item) => item.command), [{ verb: "mode", mode: "manual" }, { verb: "mode", mode: "auto" }]);
  await h.dispose();
});

test("yolo mode requires two confirmations and carries the reviewed allowlist", async () => {
  const h = harness({ kv: enabledKv() });
  await SelfEvolveTuiPlugin(h.api);
  h.event("self-evolve.settings", { action: "mode", mode: "yolo", allowlist: ["/skills"] });
  assert.match(h.confirms.at(-1).message, /without per-change approval/);
  h.confirms.at(-1).onConfirm();
  assert.match(h.confirms.at(-1).message, /\/skills/);
  assert.equal(h.commands.length, 0);
  h.confirms.at(-1).onConfirm();
  await flush();
  assert.deepEqual(h.commands[0].command, { verb: "mode", mode: "yolo", confirmed: true, allowlist: ["/skills"] });
  await h.dispose();
});

test("allowlist changes independently require two confirmations", async () => {
  const h = harness({ kv: enabledKv() });
  await SelfEvolveTuiPlugin(h.api);
  h.event("self-evolve.settings", { action: "allowlist", allowlist: ["/skills/one", "/skills/two"] });
  h.confirms.at(-1).onConfirm();
  assert.equal(h.commands.length, 0);
  h.confirms.at(-1).onConfirm();
  await flush();
  assert.deepEqual(h.commands[0].command, { verb: "mode", mode: "yolo", allowlist: ["/skills/one", "/skills/two"], confirmed: true });
  await h.dispose();
});

test("excerpt and cross-repository consent use separate disclosure dialogs", async () => {
  const h = harness({ kv: enabledKv() });
  await SelfEvolveTuiPlugin(h.api);
  h.event("self-evolve.consent", { key: "sanitizedExcerpts", value: true });
  const excerpt = h.confirms.at(-1);
  h.event("self-evolve.consent", { key: "crossRepoAggregation", value: true });
  const crossRepo = h.confirms.at(-1);
  assert.notEqual(excerpt.title, crossRepo.title);
  excerpt.onConfirm();
  crossRepo.onConfirm();
  await flush();
  assert.deepEqual(h.commands.map((item) => item.command), [
    { verb: "consent", key: "sanitizedExcerpts", value: true },
    { verb: "consent", key: "crossRepoAggregation", value: true },
  ]);
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

test("Snooze, Dismiss, and Exclude dispatch the correct state and command intent", async () => {
  for (const [choice, state, verb] of [["snooze", "pending", "snooze"], ["dismiss", "rejected", "reject"], ["exclude", "rejected", "reject"]]) {
    const item = proposal({ id: `proposal-${choice}` });
    const h = harness({ kv: enabledKv(), proposals: [item] });
    await SelfEvolveTuiPlugin(h.api);
    await flush();
    actionDialog(h).options.find((option) => option.value === choice).onSelect();
    await flush();
    assert.equal(h.decisions[0].decision.newState, state);
    assert.equal(h.decisions[0].command.verb, verb);
    if (choice === "exclude") assert.deepEqual(h.commands[0].command, { verb: "repo-override", excluded: true });
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
  assert.equal((await h.bridge.getInbox()).proposals.length, 1);
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
    h.bridge.getProposal = async () => state;
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
  h.setClock(2_500);
  h.event("session.idle");
  await flush();
  assert.ok(actionDialog(h));
  await h.dispose();
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

test("proposal filtering honors state, dismissal, snooze, and last-shown time", () => {
  const item = proposal();
  assert.equal(shouldShowProposal(item, { now: 2_000 }), true);
  assert.equal(shouldShowProposal(item, { dismissedIds: [item.id], now: 2_000 }), false);
  assert.equal(shouldShowProposal({ ...item, snoozedUntil: 3_000 }, { now: 2_000 }), false);
  assert.equal(shouldShowProposal(item, { lastShownAt: { [item.id]: 1_000 }, now: 2_000 }), false);
  assert.equal(shouldShowProposal({ ...item, state: "rejected" }, { now: 2_000 }), false);
});

test("TUI never invokes promptAsync or appendPrompt", async () => {
  const h = harness({ kv: enabledKv(), proposals: [proposal()] });
  await SelfEvolveTuiPlugin(h.api);
  await flush();
  actionDialog(h).options.find((option) => option.value === "apply").onSelect();
  await flush();
  h.event("self-evolve.settings", { action: "mode", mode: "auto" });
  h.confirms.at(-1).onConfirm();
  await flush();
  assert.equal(h.promptAsync.calls, 0);
  assert.equal(h.appendPrompt.calls, 0);
  await h.dispose();
});
