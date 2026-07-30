import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __testTuiStore,
  acquireProjectTuiStore,
  buildControlCenterModel,
  buildReviewDialogModel,
  createTuiDialogLease,
  deriveSidebarCard,
  nextReviewProposalId,
} from "../self-evolve-tui-store.js";

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

test("sidebar card is absent for healthy empty state and summarizes every attention class without raw identifiers", () => {
  const snapshot = (overrides = {}) => ({
    phase: "ready",
    pending: [],
    projection: {
      index: {
        status: { state: "ready" },
        reviews: [],
        operations: [],
        ...overrides,
      },
    },
  });
  assert.equal(deriveSidebarCard(snapshot()), null);
  assert.deepEqual(deriveSidebarCard(snapshot({ status: { state: "setup-required" } })), {
    kind: "setup",
    tone: "warning",
    title: "Self-evolve needs attention",
    summary: "Setup is required",
    count: 1,
  });
  assert.equal(deriveSidebarCard(snapshot({
    reviews: [{ proposalId: "private-proposal-id", state: "pending", attention: "normal" }],
  })).kind, "review");
  assert.equal(deriveSidebarCard(snapshot({
    reviews: [{ proposalId: "private-proposal-id", state: "applied", attention: "normal" }],
  })).kind, "audit");
  assert.equal(deriveSidebarCard(snapshot({
    reviews: [{ proposalId: "private-proposal-id", state: "failed-closed", attention: "critical" }],
  })).kind, "failure");
  assert.equal(deriveSidebarCard(snapshot({
    operations: [{ requestId: "private-request-id", status: "queued" }],
  })).kind, "operation");
  const serialized = JSON.stringify(deriveSidebarCard(snapshot({
    reviews: [{ proposalId: "private-proposal-id", state: "pending", attention: "normal" }],
  })));
  assert.doesNotMatch(serialized, /private-proposal-id/u);
});

test("review dialog model exposes authoritative summary, diff, evidence, audit, actions, and honest truncation", () => {
  const marker = (truncated = false) => ({
    truncated,
    includedCount: truncated ? 1 : 0,
    omittedCount: truncated ? 2 : 0,
    omittedBytes: truncated ? 64 : 0,
    reason: truncated ? "item-limit" : "none",
  });
  const detail = {
    proposalId: "proposal-one",
    summary: {
      state: "pending",
      target: { relativePath: "review/SKILL.md" },
      effectiveMode: "auto",
      rationale: "Bounded rationale",
      risk: "low",
      criticScoreBasisPoints: 9500,
      criticPassed: true,
      validDeterministic: true,
      injectionFlagged: false,
      tokenImpact: { estimatedTokens: 12, budgetTokens: 100 },
      eligibility: {
        eligible: true,
        reasons: ["thresholds-met"],
        checks: [{ name: "incidents", met: true, actual: "3", required: "3" }],
      },
      rollback: { eligible: false, reason: "not-applied", appliedHash: null },
      operation: { status: "completed", requestId: null, reason: null, updatedAt: 10 },
    },
    diff: { kind: "unified", lines: ["-old", "+new"], overflow: marker(true) },
    evidence: [{ kind: "receipt", summary: "Three repeated commands", redacted: true }],
    audit: [{ kind: "decision", summary: "Proposal created" }],
    overflow: {
      evidence: marker(true),
      audit: marker(false),
      allowedActions: marker(false),
    },
  };
  const snapshot = {
    projection: {
      index: {
        reviews: [
          { proposalId: "proposal-one", state: "pending", target: "review/SKILL.md", attention: "normal" },
          { proposalId: "proposal-two", state: "failed-closed", target: "other/SKILL.md", attention: "critical" },
        ],
      },
      details: [detail],
      effectiveDetailActions: {
        "proposal-one": [{ action: "apply-proposal", capability: "legacy-decision-v1" }],
      },
    },
  };
  const model = buildReviewDialogModel(snapshot, "proposal-one");
  assert.equal(model.queueCount, 2);
  assert.equal(model.loading, false);
  assert.match(model.summary.join("\n"), /Target: review\/SKILL\.md[\s\S]*Critic: passed[\s\S]*Deterministic checks: passed/u);
  assert.match(model.diff.join("\n"), /Diff truncated: 2 item\(s\), 64 byte\(s\) omitted/u);
  assert.match(model.evidence.join("\n"), /\[redacted\][\s\S]*Evidence truncated/u);
  assert.deepEqual(model.actions, [{
    action: "apply-proposal",
    label: "Apply Proposal",
    capability: "legacy-decision-v1",
  }]);
  assert.equal(Object.isFrozen(model), true);
  const loading = buildReviewDialogModel(snapshot, "proposal-two");
  assert.equal(loading.loading, true);
  assert.deepEqual(loading.summary, ["Loading authoritative review detail…"]);
});

test("review queue navigation wraps and dialog leases reject replacement, delayed, and disposed callbacks", () => {
  const reviews = [{ proposalId: "one" }, { proposalId: "two" }, { proposalId: "three" }];
  assert.equal(nextReviewProposalId(reviews, "one", -1), "three");
  assert.equal(nextReviewProposalId(reviews, "three", 1), "one");
  assert.equal(nextReviewProposalId(reviews, "two", 1), "three");
  const lease = createTuiDialogLease();
  const first = lease.open();
  assert.equal(lease.current(first), true);
  const replacement = lease.open();
  assert.equal(lease.current(first), false);
  assert.equal(lease.current(replacement), true);
  lease.invalidate(first);
  assert.equal(lease.current(replacement), true);
  lease.invalidate(replacement);
  assert.equal(lease.current(replacement), false);
  const final = lease.open();
  lease.dispose();
  assert.equal(lease.current(final), false);
  assert.throws(() => lease.open(), /disposed/u);
});

test("control center model remains available for healthy, empty, and degraded projects", () => {
  const degraded = buildControlCenterModel({ phase: "error", error: "projection unavailable", projection: null });
  assert.match(degraded.sections.overview.join("\n"), /server state is unavailable[\s\S]*projection unavailable/u);
  const healthy = buildControlCenterModel({
    phase: "ready",
    projection: {
      index: {
        status: {
          state: "ready",
          reason: null,
          storedMode: "manual",
          effectiveMode: "manual",
          paused: false,
          killSwitchActive: false,
          repoExcluded: false,
          circuitBreakerOpen: false,
        },
        budgets: {
          passiveCallsPerHour: 3,
          synthesisPerDay: 2,
          tokensPerSynthesis: 1000,
          storageQuotaMiB: 8,
          idleDebounceMs: 1500,
        },
        reviews: [],
        operations: [],
      },
    },
  });
  assert.match(healthy.sections.overview.join("\n"), /Status: ready[\s\S]*Mode: manual/u);
  assert.match(healthy.sections.reviews.join("\n"), /0 reviews/u);
  assert.match(healthy.sections.health.join("\n"), /Storage quota MiB: 8/u);
  assert.equal(Object.isFrozen(healthy.sections), true);
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
