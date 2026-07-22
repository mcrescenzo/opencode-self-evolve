import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_BUDGETS,
  Mode,
  beginEpisode,
  canStartEpisode,
  makeAuditEvent,
  makeCircuitBreaker,
  makeEpisodeCursor,
  reset,
  resolveMode,
  trip,
  wrapRecord,
} from "./self-evolve-schemas.js";

const ACTOR = "self-evolve-scheduler";
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WORK_ITEM_TTL_MS = 10 * 60 * 1000;
const STALE_SESSION_MS = 30 * 60 * 1000;
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function eventBody(input) {
  return input?.event && typeof input.event === "object" ? input.event : input;
}

function eventSessionID(event) {
  return event?.properties?.sessionID
    ?? event?.properties?.session?.id
    ?? event?.sessionID
    ?? event?.session?.id
    ?? null;
}

function eventParentID(event) {
  return event?.properties?.parentID
    ?? event?.properties?.session?.parentID
    ?? event?.parentID
    ?? event?.session?.parentID
    ?? null;
}

function eventEpoch(event) {
  const value = event?.properties?.epoch ?? event?.epoch;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function eventTimestamp(event) {
  const value = event?.properties?.timestamp ?? event?.timestamp;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function statusType(event) {
  if (event?.type === "session.idle") return "idle";
  if (event?.type !== "session.status") return null;
  return event?.properties?.status?.type ?? event?.status?.type ?? null;
}

function safeSettings(store) {
  try {
    const settings = store.getSettings();
    return settings?.global && settings?.repo ? settings : null;
  } catch {
    return null;
  }
}

function latestCursor(store, sessionID) {
  const records = store.readRecords?.("episode-cursor") ?? [];
  return records.filter((record) => record?.payload?.sessionID === sessionID).at(-1)?.payload
    ?? makeEpisodeCursor({ sessionID });
}

function parseClock(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2})$/u);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function isQuiet(timestamp, quietHours) {
  const date = new Date(timestamp);
  const minute = date.getHours() * 60 + date.getMinutes();
  return quietHours.some((period) => {
    const from = parseClock(period?.from);
    const to = parseClock(period?.to);
    if (from === null || to === null || from === to) return false;
    return from < to ? minute >= from && minute < to : minute >= from || minute < to;
  });
}

function schedulerAudits(store) {
  try {
    return (store.readRecords?.("audit-event") ?? [])
      .map((record) => record?.payload)
      .filter((event) => event?.actor === ACTOR);
  } catch {
    return [];
  }
}

function budgetCount(events, type, since) {
  return events.filter((event) => event.timestamp >= since
    && event.details?.action === "scheduler-budget"
    && event.details?.budgetType === type).length;
}

function normalizeResultFailure(result) {
  return result instanceof Error
    || result?.ok === false
    || result?.result === "failed-closed"
    || result?.status === "failed"
    || result?.error !== undefined;
}

export function createScheduler({ store, privacy, budgets = {}, now = () => Date.now(), enqueueWork, log = () => {} } = {}) {
  if (!store || typeof enqueueWork !== "function") throw new TypeError("scheduler-dependencies-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (typeof log !== "function") throw new TypeError("log-must-be-function");

  const initialSettings = safeSettings(store);
  const configured = {
    ...DEFAULT_BUDGETS,
    ...(initialSettings?.global?.budgets ?? {}),
    ...(initialSettings?.repo?.budgets ?? {}),
    ...Object.fromEntries(Object.entries(budgets).filter(([key]) => key in DEFAULT_BUDGETS)),
  };
  const quietHours = Array.isArray(budgets.quietHours) ? budgets.quietHours : [];
  const leaseTtlMs = Number.isSafeInteger(budgets.leaseTtlMs) && budgets.leaseTtlMs > 0
    ? budgets.leaseTtlMs
    : DEFAULT_LEASE_TTL_MS;
  const workItemTtlMs = Number.isSafeInteger(budgets.workItemTtlMs) && budgets.workItemTtlMs > 0
    ? budgets.workItemTtlMs
    : DEFAULT_WORK_ITEM_TTL_MS;
  const backoffBaseMs = Number.isSafeInteger(budgets.backoffBaseMs) && budgets.backoffBaseMs >= 0
    ? budgets.backoffBaseMs
    : configured.idleDebounceMs;
  const sessions = new Map();
  const heldLeases = new Map();
  const inFlight = new Map();
  const backoffUntil = new Map();
  let disposed = false;
  let modeOverride = null;
  let breaker = latestBreaker();
  let cachedMode = effectiveMode(initialSettings);

  function effectiveMode(settings = safeSettings(store)) {
    if (modeOverride) return modeOverride;
    if (!settings) return "manual";
    return resolveMode(settings.global.mode, settings.repo.mode, {
      killSwitchActive: settings.global.killSwitchActive,
      paused: settings.global.paused,
      circuitBreakerOpen: breaker?.open === true,
      processExcluded: settings.repo.excluded,
      corrupt: false,
    });
  }

  function latestBreaker() {
    try {
      return store.readRecords?.("circuit-breaker").at(-1)?.payload
        ?? makeCircuitBreaker({ open: false, tripCount: 0 });
    } catch {
      return makeCircuitBreaker({ open: false, tripCount: 0 });
    }
  }

  function append(kind, payload, timestamp) {
    const result = store.appendRecord?.(wrapRecord(kind, payload, timestamp));
    if (!result?.ok) throw new Error(result?.reason ?? `${kind}-write-failed`);
  }

  function audit(action, details = {}, timestamp = now(), kind = "decision") {
    const clean = { action, ...details };
    try {
      const payloadHash = hash(JSON.stringify(clean));
      append("audit-event", makeAuditEvent({
        id: hash(`${timestamp}:${randomUUID()}:${payloadHash}`),
        kind,
        actor: ACTOR,
        timestamp,
        payloadHash,
        details: clean,
      }), timestamp);
    } catch (error) {
      log({ level: "warn", action, error: String(error?.message ?? error) });
    }
  }

  function currentProject() {
    return safeSettings(store)?.repo?.projectFingerprint ?? null;
  }

  function leaseKey(projectFingerprint, sessionID) {
    return `episode_${hash(`${projectFingerprint}\n${sessionID}`)}`;
  }

  function clearTimer(state) {
    if (state?.timer) clearTimeout(state.timer);
    if (state) state.timer = null;
  }

  function cleanupStaleSessions(timestamp) {
    for (const [sessionID, state] of sessions) {
      if (timestamp - state.touchedAt <= STALE_SESSION_MS || inFlight.has(sessionID)) continue;
      clearTimer(state);
      sessions.delete(sessionID);
      audit("late-session-cleanup", { sessionID }, timestamp);
    }
  }

  function scheduleDebounce(state, delay = configured.idleDebounceMs) {
    clearTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      void reserveEpisode(state);
    }, Math.max(0, delay));
    state.timer.unref?.();
  }

  function runBudgetCheck(timestamp = now()) {
    const events = schedulerAudits(store);
    return Object.freeze({
      passiveCallsRemainingToday: Math.max(0, configured.passiveCallsPerHour - budgetCount(events, "passive", timestamp - HOUR_MS)),
      synthesesRemainingToday: Math.max(0, configured.synthesisPerDay - budgetCount(events, "synthesis", timestamp - DAY_MS)),
      withinQuietPeriod: isQuiet(timestamp, quietHours),
      notificationsRemainingThisHour: Math.max(0, configured.notificationsPerHour - budgetCount(events, "notification", timestamp - HOUR_MS)),
    });
  }

  function releaseWorkLease(workItem) {
    const key = workItem?._leaseKey ?? leaseKey(workItem.projectFingerprint, workItem.sessionID);
    const nonce = workItem?.leaseNonce;
    if (!nonce || !heldLeases.has(key)) return;
    try { store.releaseLease(key, nonce); } catch (error) { log({ level: "warn", action: "release-lease", error: String(error?.message ?? error) }); }
    heldLeases.delete(key);
  }

  async function reserveEpisode(state) {
    if (disposed) return;
    const timestamp = now();
    cleanupStaleSessions(timestamp);
    cachedMode = effectiveMode();
    if (cachedMode === "manual" || breaker.open) return;
    if (timestamp - state.touchedAt > STALE_SESSION_MS) {
      sessions.delete(state.sessionID);
      audit("late-session-cleanup", { sessionID: state.sessionID }, timestamp);
      return;
    }
    if (inFlight.has(state.sessionID)) {
      state.pendingAfterFlight = true;
      audit("continuation-deferred", { sessionID: state.sessionID, epoch: state.epoch }, timestamp);
      return;
    }
    const budget = runBudgetCheck(timestamp);
    if (budget.withinQuietPeriod || budget.passiveCallsRemainingToday === 0 || budget.synthesesRemainingToday === 0) {
      audit("schedule-suppressed", {
        sessionID: state.sessionID,
        reason: budget.withinQuietPeriod ? "quiet-period" : "budget-exhausted",
      }, timestamp);
      return;
    }
    const until = backoffUntil.get(state.rootSessionID) ?? 0;
    if (until > timestamp) {
      scheduleDebounce(state, until - timestamp);
      return;
    }

    const settings = safeSettings(store);
    const projectFingerprint = settings?.repo?.projectFingerprint;
    if (!projectFingerprint) return;
    const consent = settings.global.consent;
    if (consent && (!consent.passiveCalls || !consent.durableObservations)) return;
    const cursor = latestCursor(store, state.sessionID);
    if (!canStartEpisode(cursor, timestamp, configured.idleDebounceMs)) {
      audit("episode-not-ready", { sessionID: state.sessionID, epoch: state.epoch }, timestamp);
      return;
    }

    const key = leaseKey(projectFingerprint, state.sessionID);
    let lease;
    try {
      lease = store.acquireLease(key, { ttlMs: leaseTtlMs, actor: ACTOR });
    } catch (error) {
      audit("scheduler-failure", { sessionID: state.sessionID, reason: String(error?.message ?? error).slice(0, 400) }, timestamp);
      return;
    }
    if (!lease?.ok) {
      audit(lease?.reason === "lease-busy" ? "lease-busy" : "lease-failed", {
        sessionID: state.sessionID,
        reason: String(lease?.reason ?? "unknown"),
      }, timestamp, "lease");
      return;
    }

    heldLeases.set(key, lease.nonce);
    const reservedCursor = beginEpisode(cursor, timestamp, lease.nonce);
    const workItem = Object.freeze({
      sessionID: state.sessionID,
      projectFingerprint,
      scopeFingerprint: state.scopeFingerprint ?? projectFingerprint,
      cursor: reservedCursor,
      leaseNonce: lease.nonce,
      scheduledAt: timestamp,
      trigger: cachedMode,
      epoch: state.epoch,
    });
    inFlight.set(state.sessionID, workItem);
    audit("scheduler-budget", { budgetType: "passive", rootSessionID: state.rootSessionID }, timestamp);
    audit("scheduler-budget", { budgetType: "synthesis", rootSessionID: state.rootSessionID }, timestamp);

    queueMicrotask(() => {
      try {
        Promise.resolve(enqueueWork(workItem)).catch((error) => {
          recordWorkResult(workItem, { ok: false, error: String(error?.message ?? error) });
        });
      } catch (error) {
        recordWorkResult(workItem, { ok: false, error: String(error?.message ?? error) });
      }
    });
  }

  async function handleEvent(input) {
    if (disposed) return;
    const event = eventBody(input);
    const status = statusType(event);
    if (!status && event?.type !== "session.compacted") return;
    if (cachedMode === "manual") return;
    const sessionID = eventSessionID(event);
    if (!sessionID) return;
    const timestamp = now();
    cleanupStaleSessions(timestamp);
    const prior = sessions.get(sessionID);
    const suppliedEpoch = eventEpoch(event);
    const latestEpoch = Math.max(prior?.epoch ?? 0, prior?.nextEpoch ?? 0);
    if (prior && suppliedEpoch !== null && suppliedEpoch < latestEpoch) {
      audit("out-of-order-event", { sessionID, epoch: suppliedEpoch }, timestamp);
      return;
    }
    const epoch = suppliedEpoch ?? latestEpoch + 1;
    const state = prior ?? { sessionID, timer: null, pendingAfterFlight: false };
    state.touchedAt = timestamp;
    state.rootSessionID = eventParentID(event) ?? prior?.rootSessionID ?? sessionID;
    state.scopeFingerprint = event?.properties?.scopeFingerprint ?? prior?.scopeFingerprint ?? currentProject();
    sessions.set(sessionID, state);

    if (status === "idle" && inFlight.has(sessionID)) {
      state.nextEpoch = epoch;
      scheduleDebounce(state);
      return;
    }
    state.epoch = epoch;

    if (event?.type === "session.compacted") {
      audit("session-compacted", { sessionID, epoch }, timestamp);
      return;
    }
    if (status !== "idle") {
      clearTimer(state);
      audit("session-status", { sessionID, status: String(status), epoch }, timestamp);
      return;
    }
    const observedAt = eventTimestamp(event);
    if (observedAt !== null && timestamp - observedAt > STALE_SESSION_MS) {
      clearTimer(state);
      audit("late-session-cleanup", { sessionID }, timestamp);
      return;
    }
    scheduleDebounce(state);
  }

  function cancelPending(sessionID) {
    const state = sessions.get(sessionID);
    if (!state) return false;
    clearTimer(state);
    state.pendingAfterFlight = false;
    return true;
  }

  function tripCircuitBreaker(reason) {
    breaker = trip(breaker, String(reason || "scheduler-failure"), now());
    try { append("circuit-breaker", breaker, now()); } catch (error) { log({ level: "warn", action: "persist-circuit-breaker", error: String(error?.message ?? error) }); }
    for (const state of sessions.values()) clearTimer(state);
    cachedMode = "manual";
    return breaker;
  }

  function resetCircuitBreaker(reason = "manual-reset") {
    breaker = reset(breaker);
    try { append("circuit-breaker", breaker, now()); } catch (error) { log({ level: "warn", action: "persist-circuit-breaker-reset", error: String(error?.message ?? error) }); }
    audit("circuit-breaker-reset", { reason: String(reason) }, now());
    cachedMode = effectiveMode();
    return breaker;
  }

  function setMode(mode, reason = "mode-change") {
    if (!Mode.values.includes(mode)) throw new TypeError("invalid-mode");
    const prior = cachedMode;
    modeOverride = mode;
    cachedMode = breaker.open ? "manual" : mode;
    if (cachedMode === "manual") for (const state of sessions.values()) clearTimer(state);
    if (prior !== cachedMode) audit("mode-downgrade", { priorMode: prior, mode: cachedMode, reason: String(reason) }, now());
    return cachedMode;
  }

  function persistedFailures(key, timestamp) {
    return schedulerAudits(store).filter((event) => event.timestamp >= timestamp - FAILURE_WINDOW_MS
      && event.details?.action === "work-failure"
      && event.details?.failureKey === key).length;
  }

  function recordWorkResult(workItem, result = {}) {
    const timestamp = now();
    const state = sessions.get(workItem?.sessionID);
    const stale = !workItem
      || timestamp - workItem.scheduledAt > workItemTtlMs
      || (state && workItem.epoch !== state.epoch);
    releaseWorkLease(workItem ?? {});
    if (workItem?.sessionID && inFlight.get(workItem.sessionID)?.leaseNonce === workItem.leaseNonce) {
      inFlight.delete(workItem.sessionID);
    }
    if (stale) {
      audit("stale-work-result", { sessionID: String(workItem?.sessionID ?? "unknown") }, timestamp);
      return { accepted: false, stale: true };
    }

    if (Number.isSafeInteger(result.notifications) && result.notifications > 0) {
      for (let index = 0; index < result.notifications; index += 1) {
        audit("scheduler-budget", { budgetType: "notification", rootSessionID: state?.rootSessionID ?? workItem.sessionID }, timestamp);
      }
    }
    if (normalizeResultFailure(result)) {
      const failureKey = String(result.clusterID ?? state?.rootSessionID ?? workItem.sessionID);
      audit("work-failure", { failureKey, sessionID: workItem.sessionID }, timestamp);
      const failures = persistedFailures(failureKey, timestamp);
      backoffUntil.set(failureKey, timestamp + Math.min(STALE_SESSION_MS, backoffBaseMs * (2 ** Math.max(0, failures - 1))));
      if (failures >= 3 && !breaker.open) tripCircuitBreaker("three-failures-in-24h");
    }
    if (state?.pendingAfterFlight && !disposed && cachedMode !== "manual" && !breaker.open) {
      state.pendingAfterFlight = false;
      state.epoch = state.nextEpoch ?? state.epoch + 1;
      state.nextEpoch = null;
      scheduleDebounce(state);
    }
    return { accepted: true, stale: false };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const state of sessions.values()) clearTimer(state);
    for (const [key, nonce] of heldLeases) {
      try { store.releaseLease(key, nonce); } catch (error) { log({ level: "warn", action: "dispose-release", error: String(error?.message ?? error) }); }
    }
    heldLeases.clear();
    sessions.clear();
  }

  try {
    const cleanup = store.cleanupExpiredLeases?.({ actor: ACTOR, now: now() });
    if (cleanup && typeof cleanup.catch === "function") cleanup.catch((error) => log({ level: "warn", action: "startup-lease-cleanup", error: String(error?.message ?? error) }));
  } catch (error) {
    log({ level: "warn", action: "startup-lease-cleanup", error: String(error?.message ?? error) });
  }

  return Object.freeze({
    handleEvent,
    cancelPending,
    runBudgetCheck,
    getCircuitBreaker: () => breaker,
    tripCircuitBreaker,
    resetCircuitBreaker,
    setMode,
    recordWorkResult,
    dispose,
  });
}
