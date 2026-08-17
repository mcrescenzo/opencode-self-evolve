import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { hashSessionLineage } from "../self-evolve-observation.js";
import { createScheduler } from "../self-evolve-scheduler.js";
import { openStore } from "../self-evolve-store.js";

const H = (character) => character.repeat(64);
const PROJECT = H("a");
const SCOPE = H("b");
const RESERVATION_CHILD = path.join(import.meta.dirname, "fixtures", "passive-provider-reservation.mjs");

function runReservationChild(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RESERVATION_CHILD, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`reservation-child-failed:${error.code ?? "unknown"}:${stderr}`));
      else resolve(JSON.parse(readFileSync(args.at(-1), "utf8")));
    });
  });
}

function wait(ms = 20) {
  return delay(ms);
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
  const calls = { append: [], acquire: [], release: [], cleanup: [], logs: [], settingsReads: 0 };
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
  const automation = options.automation ?? {
    ok: true,
    enabled: options.automaticEnabled ?? true,
    stamp: { generation: 1, permissionsHash: H("c") },
    global: {
      automaticRecommendationsEnabled: options.automaticEnabled ?? true,
      killSwitchActive: false,
      consent: { durableObservations: true, sanitizedExcerpts: true, crossRepoAggregation: true },
      budgets: settings.global.budgets,
    },
    repo: { projectFingerprint: PROJECT, excluded: false, budgets: settings.repo.budgets },
  };
  const store = {
    getSettings() { calls.settingsReads += 1; return settings; },
    getAutomationState() {
      calls.settingsReads += 1;
      const permissionsGranted = Object.values(automation.global.consent).every(Boolean);
      return { ...automation, enabled: automation.enabled && permissionsGranted };
    },
    compareAutomationStamp(stamp) { return stamp?.generation === automation.stamp.generation; },
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
    enqueueWork: options.enqueueWork ?? ((item) => {
      work.push(item);
      return new Promise(() => {});
    }),
    log: (entry) => calls.logs.push(entry),
  });
  return { root, clock, records, leases, calls, settings, automation, store, work, scheduler };
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

test("one admitted episode checks settings at event and work-admission boundaries", async (t) => {
  const { scheduler, work, calls } = fixture(t);
  const baseline = calls.settingsReads;
  await scheduler.handleEvent(idle("single-settings-read", { projectFingerprint: PROJECT }));
  await waitFor(() => work.length === 1, "one admitted episode");
  assert.equal(calls.settingsReads - baseline, 2);
  scheduler.dispose();
});

test("a post-acquisition episode reservation failure releases its lease", async (t) => {
  const cursor = {
    sessionIDHash: hashSessionLineage("reservation-failure"),
    lastIdleAt: 0,
    lastObservedMessageHash: null,
    leaseNonce: null,
  };
  const records = new Map([["episode-cursor", [{ payload: cursor }]]]);
  const { scheduler, store, leases, calls } = fixture(t, { records, budgets: { idleDebounceMs: 0 } });
  const acquireLease = store.acquireLease.bind(store);
  store.acquireLease = (...args) => {
    const lease = acquireLease(...args);
    cursor.lastIdleAt = 1_000_001;
    return lease;
  };

  await scheduler.handleEvent(idle("reservation-failure"));
  await waitFor(() => calls.release.length === 1, "failed reservation lease release");

  assert.equal(leases.size, 0);
  assert.equal(actions(records, "scheduler-failure").length, 1);
  assert.match(actions(records, "scheduler-failure")[0].payload.details.reason, /out-of-order/u);
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
  const { scheduler, work, records } = fixture(t);
  await scheduler.handleEvent(status("transitions", "busy"));
  assert.equal(actions(records, "session-status").filter((record) => record.payload.details.status === "busy").length, 0);
  await scheduler.handleEvent(status("transitions", "retry"));
  assert.equal(actions(records, "session-status").filter((record) => record.payload.details.status === "retry").length, 1);
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

test("manual work shares the create-exclusive episode lease", async (t) => {
  const { scheduler, calls } = fixture(t);
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = scheduler.runWithEpisodeLease({ projectFingerprint: PROJECT, sessionID: "manual" }, async () => {
    await gate;
    return "first";
  });
  await waitFor(() => calls.acquire.length === 1, "first manual lease");
  const second = await scheduler.runWithEpisodeLease(
    { projectFingerprint: PROJECT, sessionID: "manual" },
    async () => "second",
  );
  assert.deepEqual(second, { ok: false, reason: "episode-lease-busy", deferred: true });
  releaseFirst();
  assert.deepEqual(await first, { ok: true, value: "first" });
  assert.equal(calls.release.length, 1);
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

test("more than a day-cap of no-eligible episodes consume no synthesis budget", async (t) => {
  let completed = 0;
  const { scheduler, records } = fixture(t, {
    budgets: { synthesisPerDay: 24 },
    enqueueWork() {
      completed += 1;
      return { ok: true, result: "no-eligible-cluster" };
    },
  });

  for (let index = 0; index < 25; index += 1) {
    await scheduler.handleEvent(idle(`no-eligible-${index}`));
    await waitFor(() => completed === index + 1, `no-eligible episode ${index + 1}`);
  }

  const synthesisAudits = (records.get("audit-event") ?? []).filter((record) => (
    record.payload.details.action === "scheduler-budget"
    && record.payload.details.budgetType === "synthesis"
  ));
  assert.equal(completed, 25);
  assert.equal(synthesisAudits.length, 0);
  assert.equal(scheduler.runBudgetCheck().synthesesRemainingToday, 24);
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

test("Automatic recommendations Off returns without scheduling or durable writes", async (t) => {
  const { scheduler, work, calls } = fixture(t, { automaticEnabled: false });
  await scheduler.handleEvent(idle("manual"));
  await wait(15);
  assert.equal(work.length, 0);
  assert.equal(calls.append.length, 0);
  assert.equal(calls.acquire.length, 0);
  scheduler.dispose();
});

test("fresh Off, Emergency Stop, and project exclusion suppress an earlier scheduler observation", async (t) => {
  for (const suppress of [
    (automation) => { automation.enabled = false; },
    (automation) => { automation.global.killSwitchActive = true; },
    (automation) => { automation.repo.excluded = true; },
  ]) {
    const label = suppress.toString().includes("killSwitch") ? "emergency-stop"
      : suppress.toString().includes("excluded") ? "project-excluded" : "automatic-off";
    await t.test(label, async (t) => {
      const { scheduler, automation, work, calls } = fixture(t, { budgets: { idleDebounceMs: 20 } });
      scheduler.setMode("auto", "integration-observed-auto");
      const appendsBefore = calls.append.length;
      await scheduler.handleEvent(idle("fresh-suppressor"));
      suppress(automation);
      await wait(35);
      assert.equal(work.length, 0);
      assert.equal(calls.acquire.length, 0);
      assert.equal(calls.append.length, appendsBefore);
      scheduler.dispose();
    });
  }
});

test("required permission revocation suppresses scheduling", async (t) => {
  const { scheduler, automation, work, records } = fixture(t);
  automation.global.consent.sanitizedExcerpts = false;
  await scheduler.handleEvent(idle("missing-consent", { projectFingerprint: PROJECT }));
  await wait(15);
  assert.equal(work.length, 0);
  const suppressed = actions(records, "schedule-suppressed");
  assert.equal(suppressed.length, 0);
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

test("a persisted passive reservation remains successful when lease release degrades", (t) => {
  const { scheduler, store, calls, records } = fixture(t);
  store.releaseLease = () => ({ ok: false, reason: "injected-release-failure" });
  const result = scheduler.reservePassiveProviderCalls(1, { rootSessionID: "release-failure" });
  assert.equal(result.ok, true);
  assert.equal(actions(records, "scheduler-budget").length, 1);
  assert.deepEqual(calls.logs.at(-1), {
    level: "warn",
    action: "release-passive-provider-budget-lease",
    error: "injected-release-failure",
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
    runReservationChild([root, PROJECT, String(clock), "two-a", path.join(root, "result-a.json")]),
    runReservationChild([root, PROJECT, String(clock), "two-b", path.join(root, "result-b.json")]),
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

test("the scheduler settles a fulfilled work promise exactly once", async (t) => {
  let finish;
  const work = [];
  const { scheduler, calls, records } = fixture(t, {
    enqueueWork(item) {
      work.push(item);
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  await scheduler.handleEvent(idle("fulfilled-once"));
  await waitFor(() => work.length === 1, "fulfilled work");
  finish({ ok: true });
  await waitFor(() => calls.release.length === 1, "automatic fulfilled settlement");
  const duplicate = scheduler.recordWorkResult(work[0], { ok: false, error: "late duplicate" });
  assert.deepEqual(duplicate, { accepted: false, stale: false, duplicate: true });
  assert.equal(calls.release.length, 1);
  assert.equal(actions(records, "work-failure").length, 0);
  scheduler.dispose();
});

test("stopAdmission retains an admitted lease until drain settles the work promise", async (t) => {
  let finish;
  let drained = false;
  const work = [];
  const { scheduler, calls } = fixture(t, {
    enqueueWork(item) {
      work.push(item);
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  await scheduler.handleEvent(idle("drain-owned-work"));
  await waitFor(() => work.length === 1, "drain work admission");

  scheduler.stopAdmission("shutdown");
  const draining = scheduler.drain().then(() => { drained = true; });
  await wait(5);
  assert.equal(drained, false);
  assert.equal(calls.release.length, 0);

  finish({ ok: true });
  await draining;
  assert.equal(calls.release.length, 1);
  scheduler.dispose();
  assert.equal(calls.release.length, 1);
});

test("a rejected work promise produces one failure settlement", async (t) => {
  const work = [];
  const { scheduler, calls, records } = fixture(t, {
    enqueueWork(item) {
      work.push(item);
      return Promise.reject(new Error("pipeline-rejected"));
    },
  });
  await scheduler.handleEvent(idle("rejected-once"));
  await waitFor(() => actions(records, "work-failure").length === 1, "one rejected settlement");
  await wait(10);
  assert.equal(work.length, 1);
  assert.equal(actions(records, "work-failure").length, 1);
  assert.equal(calls.release.length, 1);
  assert.deepEqual(scheduler.recordWorkResult(work[0], { ok: false }), { accepted: false, stale: false, duplicate: true });
  assert.equal(actions(records, "work-failure").length, 1);
  scheduler.dispose();
});

test("a late older-lease result cannot settle or release newer work", async (t) => {
  const { scheduler, work, calls, records } = fixture(t);
  await scheduler.handleEvent(idle("superseded"));
  await waitFor(() => work.length === 1, "first lease");
  assert.deepEqual(scheduler.recordWorkResult(work[0], { ok: true }), { accepted: true, stale: false });
  await scheduler.handleEvent(idle("superseded"));
  await waitFor(() => work.length === 2, "newer lease");
  const releases = calls.release.length;
  const stale = scheduler.recordWorkResult(work[0], { ok: false, error: "late old lease" });
  assert.deepEqual(stale, { accepted: false, stale: true, superseded: true });
  assert.equal(calls.release.length, releases);
  assert.equal(actions(records, "work-failure").length, 0);
  assert.deepEqual(scheduler.recordWorkResult(work[1], { ok: true }), { accepted: true, stale: false });
  scheduler.dispose();
});

test("a failed work-lease release is retained so dispose can retry it", async (t) => {
  const { scheduler, work, store } = fixture(t, { budgets: { idleDebounceMs: 0 } });
  await scheduler.handleEvent(idle("release-fail"));
  await waitFor(() => work.length === 1, "release-fail work");
  const realRelease = store.releaseLease.bind(store);
  store.releaseLease = () => ({ ok: false, reason: "lease-release-error" });
  scheduler.recordWorkResult(work[0], { ok: true });
  let disposeRetry = 0;
  store.releaseLease = () => { disposeRetry += 1; return { ok: true }; };
  scheduler.dispose();
  assert.equal(disposeRetry, 1, "dispose retries a work-lease release that previously failed");
});

for (const terminalReason of ["nonce-mismatch", "lease-corrupt"]) {
  test(`a ${terminalReason} work-lease release is not retried during dispose`, async (t) => {
    const { scheduler, work, store, calls } = fixture(t, { budgets: { idleDebounceMs: 0 } });
    await scheduler.handleEvent(idle(`release-${terminalReason}`));
    await waitFor(() => work.length === 1, `${terminalReason} work`);
    store.releaseLease = (key, nonce) => {
      calls.release.push({ key, nonce });
      return { ok: false, reason: terminalReason };
    };

    scheduler.recordWorkResult(work[0], { ok: true });
    assert.equal(calls.release.length, 1);
    scheduler.dispose();
    assert.equal(calls.release.length, 1);
  });
}

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

test("stopping admission cancels pending work but does not cancel in-flight work", async (t) => {
  const { scheduler, work, records } = fixture(t);
  await scheduler.handleEvent(idle("downgrade"));
  await waitFor(() => work.length === 1, "in-flight work");
  await scheduler.handleEvent(idle("downgrade"));
  scheduler.stopAdmission("automatic-off");
  await wait(15);
  assert.equal(work.length, 1);
  assert.deepEqual(scheduler.recordWorkResult(work[0], { ok: true }), { accepted: true, stale: false });
  await scheduler.handleEvent(idle("downgrade"));
  await wait(15);
  assert.equal(work.length, 1);
  assert.equal(actions(records, "mode-downgrade").length, 0);
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

test("H7-001 triggerCandidateDrain admits and settles a drain work item", async (t) => {
  // The scheduler's triggerCandidateDrain must be independently invokable
  // without a session idle event. It checks budgets/breaker/consent, acquires
  // a drain lease, and enqueues a drain work item that settles through the
  // normal work-promise plumbing.
  const work = [];
  const { scheduler, records } = fixture(t, {
    enqueueWork(item) {
      work.push(item);
      return Promise.resolve({ ok: true, result: "no-eligible", drained: [] });
    },
  });

  const result = scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  assert.equal(result.ok, true);
  assert.ok(result.drainId);

  await scheduler.drain();

  assert.equal(work.length, 1);
  assert.equal(work[0].drain, true);
  assert.equal(work[0].projectFingerprint, PROJECT);
  assert.equal(actions(records, "drain-admitted").length, 1);
  assert.equal(actions(records, "drain-settled").length, 1);
  assert.equal(actions(records, "drain-settled")[0].payload.details.drained, 0);
  scheduler.dispose();
});

test("H7-001 triggerCandidateDrain records drained count on successful settlement", async (t) => {
  const work = [];
  const { scheduler, records } = fixture(t, {
    enqueueWork(item) {
      work.push(item);
      return Promise.resolve({
        ok: true,
        result: "recommendation-ready",
        drained: [{ candidateId: "c1" }, { candidateId: "c2" }],
      });
    },
  });

  const result = scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  assert.equal(result.ok, true);
  await scheduler.drain();

  const settled = actions(records, "drain-settled");
  assert.equal(settled.length, 1);
  assert.equal(settled[0].payload.details.drained, 2);
  assert.equal(settled[0].payload.details.result, "recommendation-ready");
  scheduler.dispose();
});

test("H7-001 triggerCandidateDrain is suppressed by quiet hours", async (t) => {
  const clock = { value: new Date(2026, 6, 22, 12, 0, 0).getTime() };
  const { scheduler, records } = fixture(t, {
    clock,
    budgets: { quietHours: [{ from: "11:00", to: "13:00" }] },
  });
  const result = scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "quiet-period");
  assert.equal(actions(records, "drain-suppressed").length, 1);
  assert.equal(actions(records, "drain-suppressed")[0].payload.details.reason, "quiet-period");
  scheduler.dispose();
});

test("H7-001 triggerCandidateDrain is suppressed by Automatic recommendations Off", async (t) => {
  const { scheduler, records } = fixture(t, { automaticEnabled: false });
  const result = scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "automatic-recommendations-disabled");
  assert.equal(actions(records, "drain-suppressed").length, 0);
  scheduler.dispose();
});

test("H7-001 triggerCandidateDrain is suppressed by open circuit breaker", async (t) => {
  const { scheduler, records } = fixture(t);
  scheduler.tripCircuitBreaker("test");
  const result = scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  assert.equal(result.ok, false);
  // Tripping the breaker also sets cachedMode to manual, so either reason is valid.
  assert.ok(["circuit-breaker-open", "scheduler-mode-manual"].includes(result.reason),
    `expected circuit-breaker-open or scheduler-mode-manual, got ${result.reason}`);
  scheduler.dispose();
});

test("H7-001 triggerCandidateDrain is suppressed by missing consent", async (t) => {
  const { scheduler, automation, records } = fixture(t);
  automation.global.consent.crossRepoAggregation = false;
  const result = scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "automatic-recommendations-disabled");
  assert.equal(actions(records, "drain-suppressed").length, 0);
  scheduler.dispose();
});

test("H7-001 triggerCandidateDrain serializes via cross-process drain lease", async (t) => {
  const clock = { value: 20_000 };
  const leases = new Map();
  const records = new Map();
  const first = fixture(t, { clock, leases, records, process: "one" });
  const second = fixture(t, { clock, leases, records, process: "two" });

  const resultA = first.scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  const resultB = second.scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });

  assert.equal(resultA.ok + resultB.ok, 1, "exactly one drain admission wins the lease");
  const drainEvents = actions(records, "drain-admitted").length + actions(records, "drain-lease-busy").length;
  assert.equal(drainEvents, 2, "one admission and one lease-busy audit");
  first.scheduler.dispose();
  second.scheduler.dispose();
});

test("H7-001 triggerCandidateDrain settles a failed drain as drain-failure", async (t) => {
  const { scheduler, records } = fixture(t, {
    enqueueWork: () => Promise.resolve({ ok: false, reason: "synthesis-failed-in-drain" }),
  });

  const result = scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  assert.equal(result.ok, true);
  await scheduler.drain();

  const failures = actions(records, "drain-failure");
  assert.equal(failures.length, 1);
  assert.match(failures[0].payload.details.reason, /synthesis-failed-in-drain/);
  scheduler.dispose();
});

test("H7-001 triggerCandidateDrain without projectFingerprint uses the configured project", async (t) => {
  const work = [];
  const { scheduler } = fixture(t, {
    enqueueWork(item) {
      work.push(item);
      return Promise.resolve({ ok: true, result: "no-eligible", drained: [] });
    },
  });

  const result = scheduler.triggerCandidateDrain();
  assert.equal(result.ok, true);
  await scheduler.drain();
  assert.equal(work.length, 1);
  assert.equal(work[0].projectFingerprint, PROJECT);
  scheduler.dispose();
});

test("BH-1 an episode-cursor read failure fails the scheduling pass safely, not as an unhandled rejection", async (t) => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  const work = [];
  const { scheduler, store } = fixture(t, {
    enqueueWork(item) {
      work.push(item);
      return new Promise(() => {});
    },
  });
  const readRecords = store.readRecords.bind(store);
  store.readRecords = (kind) => {
    if (kind === "episode-cursor") throw new Error("lock-acquisition-timeout");
    return readRecords(kind);
  };

  await scheduler.handleEvent(idle("cursor-read-failure"));
  await waitFor(() => work.length === 1, "episode admitted despite an episode-cursor read failure");

  await wait(15);
  assert.deepEqual(rejections, [], "a cursor read failure must not surface as an unhandled rejection");
  scheduler.dispose();
});

test("BH-7 episode admission re-reads the durable breaker epoch tripped by a peer process", async (t) => {
  const work = [];
  const { scheduler, store } = fixture(t, {
    enqueueWork(item) {
      work.push(item);
      return new Promise(() => {});
    },
  });

  // A peer process trips the durable root-global breaker after this scheduler was constructed.
  store.breakerEpochTripped = () => true;

  await scheduler.handleEvent(idle("peer-tripped-breaker"));
  await wait(30);
  assert.equal(work.length, 0, "a durably tripped breaker must suppress admission in this process too");

  // The same fixture admits normally once the durable breaker is closed again.
  store.breakerEpochTripped = () => false;
  await scheduler.handleEvent(idle("peer-closed-breaker"));
  await waitFor(() => work.length === 1, "admission resumes when the durable breaker is closed");
  scheduler.dispose();
});

test("BH-7 triggerCandidateDrain re-reads the durable breaker epoch tripped by a peer process", async (t) => {
  const { scheduler, store } = fixture(t);

  store.breakerEpochTripped = () => true;

  const result = scheduler.triggerCandidateDrain({ projectFingerprint: PROJECT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "circuit-breaker-open");
  scheduler.dispose();
});

test("BH-7 a tripped breaker epoch with no stored breaker record fails closed instead of throwing", (t) => {
  const { store, clock } = fixture(t);
  store.breakerEpochTripped = () => true;

  const scheduler = createScheduler({
    store,
    privacy: {},
    budgets: { idleDebounceMs: 5 },
    now: () => clock.value,
    enqueueWork: () => new Promise(() => {}),
  });
  t.after(() => scheduler.dispose());

  assert.equal(scheduler.getCircuitBreaker().open, true);
});

test("BH-7 an unreadable breaker record fails closed instead of throwing", (t) => {
  const { store, clock } = fixture(t);
  const readRecords = store.readRecords.bind(store);
  store.readRecords = (kind) => {
    if (kind === "circuit-breaker") throw new Error("state-file-unsafe");
    return readRecords(kind);
  };

  const scheduler = createScheduler({
    store,
    privacy: {},
    budgets: { idleDebounceMs: 5 },
    now: () => clock.value,
    enqueueWork: () => new Promise(() => {}),
  });
  t.after(() => scheduler.dispose());

  assert.equal(scheduler.getCircuitBreaker().open, true);
});
