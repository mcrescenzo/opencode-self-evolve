import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hashSessionLineage } from "../self-evolve-observation.js";
import { createScheduler } from "../self-evolve-scheduler.js";
import { openStore } from "../self-evolve-store.js";

const H = (character) => character.repeat(64);
const PROJECT = H("a");
const SCOPE = H("b");
const RESERVATION_CHILD = fileURLToPath(new URL("./fixtures/passive-provider-reservation.mjs", import.meta.url));

function runReservationChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RESERVATION_CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`reservation-child-failed:${code}:${stderr}`)));
  });
}

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await wait(2);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function idle(sessionID, overrides = {}) {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status: { type: "idle" },
      scopeFingerprint: SCOPE,
      ...overrides,
    },
  };
}

function status(sessionID, type, overrides = {}) {
  return { type: "session.status", properties: { sessionID, status: { type }, ...overrides } };
}

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-scheduler-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = options.clock ?? { value: 1_000_000 };
  const records = options.records ?? new Map();
  const leases = options.leases ?? new Map();
  const calls = { append: [], acquire: [], release: [], cleanup: [], logs: [] };
  const settings = options.settings ?? {
    global: {
      mode: options.mode ?? "auto",
      paused: false,
      killSwitchActive: false,
      consent: { passiveCalls: true, durableObservations: true },
      budgets: {},
    },
    repo: { projectFingerprint: PROJECT, mode: "inherit", excluded: false, budgets: {} },
  };
  const store = {
    getSettings: () => settings,
    readRecords: (kind) => records.get(kind) ?? [],
    appendRecord(envelope) {
      calls.append.push(envelope);
      const list = records.get(envelope.kind) ?? [];
      list.push(envelope);
      records.set(envelope.kind, list);
      return { ok: true, record: envelope };
    },
    acquireLease(key, request) {
      calls.acquire.push({ key, request });
      const current = leases.get(key);
      if (current && current.expiresAt > clock.value) return { ok: false, reason: "lease-busy", currentOwner: current.actor };
      if (current) leases.delete(key);
      const nonce = `nonce-${calls.acquire.length}-${options.process ?? "p"}`;
      leases.set(key, { nonce, actor: request.actor, expiresAt: clock.value + request.ttlMs });
      return { ok: true, nonce, expiresAt: clock.value + request.ttlMs };
    },
    releaseLease(key, nonce) {
      calls.release.push({ key, nonce });
      if (leases.get(key)?.nonce !== nonce) return { ok: false, reason: "nonce-mismatch" };
      leases.delete(key);
      return { ok: true };
    },
    cleanupExpiredLeases(request) {
      calls.cleanup.push(request);
      for (const [key, lease] of leases) if (lease.expiresAt <= request.now) leases.delete(key);
      return { ok: true };
    },
  };
  const work = [];
  const scheduler = createScheduler({
    store,
    privacy: {},
    budgets: { idleDebounceMs: 5, backoffBaseMs: 0, ...(options.budgets ?? {}) },
    now: () => clock.value,
    enqueueWork: options.enqueueWork ?? ((item) => { work.push(item); }),
    log: (entry) => calls.logs.push(entry),
  });
  return { root, clock, records, leases, calls, settings, store, work, scheduler };
}

function actions(records, action) {
  return (records.get("audit-event") ?? []).filter((record) => record.payload.details.action === action);
}

test("duplicate idle signals debounce to one work item", async (t) => {
  const { scheduler, work } = fixture(t);
  await scheduler.handleEvent(idle("duplicate"));
  await scheduler.handleEvent({ type: "session.idle", properties: { sessionID: "duplicate", scopeFingerprint: SCOPE } });
  await scheduler.handleEvent(idle("duplicate"));
  await waitFor(() => work.length === 1, "one debounced work item");
  await wait(15);
  assert.equal(work.length, 1);
  scheduler.dispose();
});

test("an older explicit epoch cannot replace newer idle work", async (t) => {
  const { scheduler, work, records } = fixture(t);
  await scheduler.handleEvent(idle("epoch", { epoch: 8 }));
  await scheduler.handleEvent(idle("epoch", { epoch: 7 }));
  await waitFor(() => work.length === 1, "newer epoch work");
  assert.equal(work[0].epoch, 8);
  assert.equal(actions(records, "out-of-order-event").length, 1);
  scheduler.dispose();
});

test("busy and retry transitions never trigger scheduling", async (t) => {
  const { scheduler, work } = fixture(t);
  await scheduler.handleEvent(status("transitions", "busy"));
  await scheduler.handleEvent(status("transitions", "retry"));
  await wait(15);
  assert.equal(work.length, 0);
  await scheduler.handleEvent(idle("transitions"));
  await waitFor(() => work.length === 1, "idle transition work");
  scheduler.dispose();
});

test("continuation idle is deferred while prior work remains in flight", async (t) => {
  const { scheduler, work, records } = fixture(t);
  await scheduler.handleEvent(idle("continuation"));
  await waitFor(() => work.length === 1, "first continuation work");
  await scheduler.handleEvent(idle("continuation"));
  await wait(15);
  assert.equal(work.length, 1);
  assert.equal(actions(records, "continuation-deferred").length, 1);
  scheduler.dispose();
});

test("compaction is audited but does not schedule", async (t) => {
  const { scheduler, work, records } = fixture(t);
  await scheduler.handleEvent({ type: "session.compacted", properties: { sessionID: "compact", epoch: 2 } });
  await wait(15);
  assert.equal(work.length, 0);
  assert.equal(actions(records, "session-compacted").length, 1);
  scheduler.dispose();
});

test("scheduler cycles do not consume passive provider slots", async (t) => {
  const { scheduler, work, records } = fixture(t);
  await scheduler.handleEvent(idle("child", { parentID: "parent" }));
  await waitFor(() => work.length === 1, "child work");
  const passive = (records.get("audit-event") ?? []).filter((record) =>
    record.payload.details.action === "scheduler-budget" && record.payload.details.budgetType === "passive");
  assert.equal(passive.length, 0);
  assert.equal(scheduler.runBudgetCheck().passiveCallsRemainingThisHour, 6);
  scheduler.dispose();
});

test("scheduler reserves a cursor without durably advancing it", async (t) => {
  const { scheduler, work, records } = fixture(t);
  await scheduler.handleEvent(idle("cursor"));
  await waitFor(() => work.length === 1, "cursor work");
  assert.equal(work[0].cursor.sessionIDHash, hashSessionLineage("cursor"));
  assert.equal(JSON.stringify(work[0].cursor).includes("cursor"), false);
  assert.equal(work[0].cursor.leaseNonce, work[0].leaseNonce);
  assert.equal(records.get("episode-cursor")?.length ?? 0, 0);
  scheduler.dispose();
});

test("construction cleans expired leases from a previous process", (t) => {
  const clock = { value: 10_000 };
  const leases = new Map([["old", { actor: "other-process", nonce: "old", expiresAt: 9_999 }]]);
  const { scheduler, calls } = fixture(t, { clock, leases });
  assert.equal(leases.size, 0);
  assert.equal(calls.cleanup.length, 1);
  assert.equal(calls.cleanup[0].actor, "self-evolve-scheduler");
  scheduler.dispose();
});

test("dispose cancels timers, releases leases, and is idempotent", async (t) => {
  const { scheduler, work, calls } = fixture(t, { budgets: { idleDebounceMs: 30 } });
  await scheduler.handleEvent(idle("leased"));
  await waitFor(() => work.length === 1, "leased work");
  await scheduler.handleEvent(idle("pending"));
  scheduler.dispose();
  scheduler.dispose();
  await wait(40);
  assert.equal(work.length, 1);
  assert.equal(calls.release.length, 1);
});

test("two schedulers contend on one cross-process lease", async (t) => {
  const clock = { value: 20_000 };
  const leases = new Map();
  const records = new Map();
  const first = fixture(t, { clock, leases, records, process: "one" });
  const second = fixture(t, { clock, leases, records, process: "two" });
  await Promise.all([first.scheduler.handleEvent(idle("shared")), second.scheduler.handleEvent(idle("shared"))]);
  await waitFor(() => first.work.length + second.work.length === 1 && actions(records, "lease-busy").length === 1, "lease winner and contention audit");
  assert.equal(first.work.length + second.work.length, 1);
  assert.equal(actions(records, "lease-busy").length, 1);
  first.scheduler.dispose();
  second.scheduler.dispose();
});

test("manual mode returns without scheduling or durable writes", async (t) => {
  const { scheduler, work, calls } = fixture(t, { mode: "manual" });
  await scheduler.handleEvent(idle("manual"));
  await wait(15);
  assert.equal(work.length, 0);
  assert.equal(calls.append.length, 0);
  assert.equal(calls.acquire.length, 0);
  scheduler.dispose();
});

test("six passive provider slots are the hard hourly ceiling", (t) => {
  const { scheduler, records } = fixture(t);
  assert.equal(scheduler.reservePassiveProviderCalls(2, { rootSessionID: "parent" }).ok, true);
  assert.equal(scheduler.reservePassiveProviderCalls(2, { rootSessionID: "parent" }).ok, true);
  assert.equal(scheduler.reservePassiveProviderCalls(2, { rootSessionID: "parent" }).ok, true);
  assert.deepEqual(scheduler.reservePassiveProviderCalls(1, { rootSessionID: "parent" }), {
    ok: false,
    reason: "passive-provider-budget-exhausted",
    requested: 1,
    remaining: 0,
  });
  const passive = (records.get("audit-event") ?? []).filter((record) =>
    record.payload.details.action === "scheduler-budget" && record.payload.details.budgetType === "passive");
  assert.equal(passive.length, 6, "durable audit count equals reserved provider slots");
  assert.equal(passive.every((record) => record.payload.details.rootSessionIDHash === hashSessionLineage("parent")), true);
  assert.equal(scheduler.runBudgetCheck().passiveCallsRemainingThisHour, 0);
  scheduler.dispose();
});

test("one remaining passive slot cannot reserve a two-call operation", (t) => {
  const { scheduler, records } = fixture(t);
  assert.equal(scheduler.reservePassiveProviderCalls(5, { rootSessionID: "pair" }).ok, true);
  assert.deepEqual(scheduler.reservePassiveProviderCalls(2, { rootSessionID: "pair" }), {
    ok: false,
    reason: "passive-provider-budget-insufficient",
    requested: 2,
    remaining: 1,
  });
  assert.equal(actions(records, "scheduler-budget").filter((record) => record.payload.details.budgetType === "passive").length, 5);
  scheduler.dispose();
});

test("passive reservations re-read the configured budget under the reservation lease", (t) => {
  const { scheduler, settings } = fixture(t);
  assert.equal(scheduler.reservePassiveProviderCalls(2, { rootSessionID: "fresh-settings" }).ok, true);
  settings.global.budgets.passiveCallsPerHour = 2;
  assert.deepEqual(scheduler.reservePassiveProviderCalls(1, { rootSessionID: "fresh-settings" }), {
    ok: false,
    reason: "passive-provider-budget-exhausted",
    requested: 1,
    remaining: 0,
  });
  scheduler.dispose();
});

test("uncertain reservation persistence fails closed and charges only confirmed slots", (t) => {
  const { scheduler, store, records } = fixture(t);
  const appendRecord = store.appendRecord.bind(store);
  let passiveWrites = 0;
  store.appendRecord = (envelope) => {
    if (envelope.payload?.details?.action === "scheduler-budget" && envelope.payload.details.budgetType === "passive") {
      passiveWrites += 1;
      if (passiveWrites === 2) return { ok: false, reason: "injected-reservation-write-failure" };
    }
    return appendRecord(envelope);
  };
  assert.deepEqual(scheduler.reservePassiveProviderCalls(2, { rootSessionID: "partial-write" }), {
    ok: false,
    reason: "injected-reservation-write-failure",
  });
  assert.equal(actions(records, "scheduler-budget").filter((record) => record.payload.details.budgetType === "passive").length, 1);
  scheduler.dispose();
});

test("concurrent process reservations cannot exceed the durable cap", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "self-evolve-passive-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = 2_200_000_000_000;
  const store = openStore(root, { projectName: "passive-process", projectFingerprint: PROJECT, now: () => clock });
  const scheduler = createScheduler({ store, budgets: { passiveCallsPerHour: 6 }, now: () => clock, enqueueWork() {} });
  assert.equal(scheduler.reservePassiveProviderCalls(4, { rootSessionID: "seed" }).ok, true);
  scheduler.dispose();
  store.close();

  const results = await Promise.all([
    runReservationChild([root, PROJECT, String(clock), "two"]),
    runReservationChild([root, PROJECT, String(clock), "two"]),
  ]);
  const readback = openStore(root, { projectName: "passive-process", projectFingerprint: PROJECT, now: () => clock });
  const passive = readback.readRecords("audit-event").filter((record) =>
    record.payload.details.action === "scheduler-budget" && record.payload.details.budgetType === "passive");
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(passive.length, 6);
  readback.close();
});

test("quiet hours suppress new work", async (t) => {
  const clock = { value: new Date(2026, 6, 22, 12, 0, 0).getTime() };
  const { scheduler, work } = fixture(t, { clock, budgets: { quietHours: [{ from: "11:00", to: "13:00" }] } });
  await scheduler.handleEvent(idle("quiet"));
  await wait(15);
  assert.equal(work.length, 0);
  assert.equal(scheduler.runBudgetCheck().withinQuietPeriod, true);
  scheduler.dispose();
});

test("circuit breaker blocks work until reset", async (t) => {
  const { scheduler, work } = fixture(t);
  scheduler.tripCircuitBreaker("test-trip");
  await scheduler.handleEvent(idle("breaker-blocked"));
  await wait(15);
  assert.equal(work.length, 0);
  assert.equal(scheduler.getCircuitBreaker().open, true);
  scheduler.resetCircuitBreaker("operator-reset");
  await scheduler.handleEvent(idle("breaker-reset"));
  await waitFor(() => work.length === 1, "post-reset work");
  scheduler.dispose();
});

test("three failures in 24 hours trip the circuit breaker with backoff", async (t) => {
  const { scheduler, work, clock } = fixture(t);
  for (let index = 0; index < 3; index += 1) {
    await scheduler.handleEvent(idle("failure"));
    await waitFor(() => work.length === index + 1, `failure work ${index + 1}`);
    scheduler.recordWorkResult(work[index], { ok: false, error: "mock failure" });
    clock.value += 10;
  }
  assert.equal(scheduler.getCircuitBreaker().open, true);
  assert.equal(scheduler.getCircuitBreaker().reason, "three-failures-in-24h");
  scheduler.dispose();
});

test("failure backoff uses stable root lineage, doubles, and survives restart", async (t) => {
  const clock = { value: 3_000_000 };
  const records = new Map();
  const first = fixture(t, {
    clock,
    records,
    budgets: { idleDebounceMs: 0, backoffBaseMs: 20 },
  });
  await first.scheduler.handleEvent(idle("child-a", { parentID: "root" }));
  await waitFor(() => first.work.length === 1, "first lineage work");
  first.scheduler.recordWorkResult(first.work[0], { ok: false, clusterID: "cluster-a" });
  const firstFailure = actions(records, "work-failure").at(-1);
  assert.equal(firstFailure.payload.details.failureKey, hashSessionLineage("root"));
  assert.equal(firstFailure.payload.details.clusterID, "cluster-a");
  assert.equal(firstFailure.payload.details.backoffUntil, 3_000_020);

  clock.value = 3_000_019;
  await first.scheduler.handleEvent(idle("child-b", { parentID: "root" }));
  await wait(8);
  assert.equal(first.work.length, 1, "sibling lineage must remain suppressed before expiry");
  clock.value = 3_000_020;
  await waitFor(() => first.work.length === 2, "work at first backoff expiry");
  first.scheduler.recordWorkResult(first.work[1], { ok: false });
  assert.equal(actions(records, "work-failure").at(-1).payload.details.backoffUntil, 3_000_060);
  first.scheduler.dispose();

  const restarted = fixture(t, {
    clock,
    records,
    budgets: { idleDebounceMs: 0, backoffBaseMs: 20 },
  });
  clock.value = 3_000_059;
  await restarted.scheduler.handleEvent(idle("child-c", { parentID: "root" }));
  await wait(8);
  assert.equal(restarted.work.length, 0, "persisted backoff must suppress restarted scheduler");
  clock.value = 3_000_060;
  await waitFor(() => restarted.work.length === 1, "restarted work at persisted expiry");
  restarted.scheduler.dispose();
});

test("idle state older than 30 minutes has its pending timer cleared", async (t) => {
  const clock = { value: 5_000 };
  const { scheduler, work } = fixture(t, { clock, budgets: { idleDebounceMs: 50 } });
  await scheduler.handleEvent(idle("late", { timestamp: clock.value }));
  clock.value += 31 * 60 * 1000;
  await scheduler.handleEvent(idle("late", { timestamp: 5_000 }));
  await wait(65);
  assert.equal(work.length, 0);
  scheduler.dispose();
});

test("handleEvent returns within 50ms even when debounce is immediate", async (t) => {
  const { scheduler } = fixture(t, { budgets: { idleDebounceMs: 0 } });
  const started = performance.now();
  await scheduler.handleEvent(idle("non-blocking"));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `handleEvent took ${elapsed.toFixed(2)}ms`);
  scheduler.dispose();
});

test("mode downgrade cancels pending work but does not cancel in-flight work", async (t) => {
  const { scheduler, work, records } = fixture(t);
  await scheduler.handleEvent(idle("downgrade"));
  await waitFor(() => work.length === 1, "in-flight work");
  await scheduler.handleEvent(idle("downgrade"));
  scheduler.setMode("manual", "operator-downgrade");
  await wait(15);
  assert.equal(work.length, 1);
  assert.deepEqual(scheduler.recordWorkResult(work[0], { ok: true }), { accepted: true, stale: false });
  await scheduler.handleEvent(idle("downgrade"));
  await wait(15);
  assert.equal(work.length, 1);
  assert.equal(actions(records, "mode-downgrade").length, 1);
  scheduler.dispose();
});

test("work result older than ten minutes is rejected as stale", async (t) => {
  const { scheduler, work, clock } = fixture(t);
  await scheduler.handleEvent(idle("stale"));
  await waitFor(() => work.length === 1, "stale candidate");
  clock.value += 10 * 60 * 1000 + 1;
  assert.deepEqual(scheduler.recordWorkResult(work[0], { ok: true }), { accepted: false, stale: true });
  scheduler.dispose();
});

test("autonomous scheduler failure leaves a mocked manual command path usable", async (t) => {
  const { scheduler, work } = fixture(t);
  scheduler.tripCircuitBreaker("autonomy-failed");
  await scheduler.handleEvent(idle("autonomy-disabled"));
  await wait(15);
  const manualCommand = async () => ({ ok: true, responseText: "manual scan completed" });
  const manual = await manualCommand();
  assert.equal(work.length, 0);
  assert.equal(manual.ok, true);
  assert.match(manual.responseText, /manual scan completed/);
  scheduler.dispose();
});
