import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_BUDGETS,
  Mode,
  UNKNOWN_ROOT_LINEAGE_HASH,
  UNKNOWN_SESSION_LINEAGE_HASH,
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
import { hashSessionLineage, resolveRootLineage } from "./self-evolve-observation.js";
import { BREAKER_EPOCH_RESET_CONFIRMATION } from "./self-evolve-epoch.js";

const ACTOR = "self-evolve-scheduler";
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WORK_ITEM_TTL_MS = 10 * 60 * 1000;
const PASSIVE_BUDGET_LEASE_TTL_MS = 30 * 1000;
const PASSIVE_BUDGET_LEASE_KEY = "passive_provider_budget";
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

function eventProjectFingerprint(event) {
  return event?.properties?.projectFingerprint
    ?? event?.properties?.session?.projectFingerprint
    ?? event?.projectFingerprint
    ?? event?.session?.projectFingerprint
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

function safeAutomation(store) {
  try {
    const state = store.getAutomationState?.();
    return state?.ok ? state : null;
  } catch {
    return null;
  }
}

function latestCursor(store, sessionIDHash) {
  // BH-1: store reads throw for ordinary reasons (lock-acquisition timeout, a
  // terminal epoch, an unsafe state file). Fail safe to a fresh cursor like the
  // other store readers in this module rather than propagating out of the
  // fire-and-forget reserveEpisode path as an unhandled rejection.
  try {
    const records = store.readRecords?.("episode-cursor") ?? [];
    return records.filter((record) => record?.payload?.sessionIDHash === sessionIDHash).at(-1)?.payload
      ?? makeEpisodeCursor({ sessionIDHash });
  } catch {
    return makeEpisodeCursor({ sessionIDHash });
  }
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

function changedField(nextValue, priorValue, absent) {
  return nextValue !== absent
    && priorValue !== undefined
    && priorValue !== absent
    && priorValue !== nextValue;
}

export function createScheduler({ store, privacy, budgets = {}, now = () => Date.now(), enqueueWork, log = () => {} } = {}) {
  if (!store || typeof enqueueWork !== "function") throw new TypeError("scheduler-dependencies-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (typeof log !== "function") throw new TypeError("log-must-be-function");

  const initialSettings = safeAutomation(store) ?? safeSettings(store);
  const budgetOverrides = Object.fromEntries(Object.entries(budgets).filter(([key]) => key in DEFAULT_BUDGETS));
  const configured = {
    ...DEFAULT_BUDGETS,
    ...(initialSettings?.global?.budgets ?? {}),
    ...(initialSettings?.repo?.budgets ?? {}),
    ...budgetOverrides,
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
  const workPromises = new Set();
  const backoffUntil = new Map();
  let disposed = false;
  let accepting = true;
  let breaker = latestBreaker();
  let cachedMode = effectiveMode(initialSettings);

  function effectiveMode(settings = safeSettings(store)) {
    if (!settings) return "manual";
    return resolveMode(settings.global.mode, settings.repo.mode, {
      killSwitchActive: settings.global.killSwitchActive,
      paused: settings.global.paused,
      circuitBreakerOpen: breaker?.open === true,
      processExcluded: settings.repo.excluded,
      corrupt: false,
    });
  }

  // BH-7: an open breaker is only well-formed with openedAt and reason, so the
  // fail-closed paths below must build one that actually validates — otherwise
  // "fail closed" throws out of latestBreaker instead of reporting an open breaker.
  function openBreaker(reason, tripCount) {
    return makeCircuitBreaker({
      open: true,
      openedAt: now(),
      reason,
      tripCount: Number.isSafeInteger(tripCount) && tripCount > 0 ? tripCount : 0,
    });
  }

  function latestBreaker() {
    try {
      const stored = store.readRecords?.("circuit-breaker").at(-1)?.payload;
      // H5-001: the durable root-global breaker epoch is the cross-process
      // open/closed truth. If it is tripped, the breaker is open regardless of
      // this process's stale view of the per-trip audit records. A corrupt
      // breaker epoch fails closed (tripped).
      if (store.breakerEpochTripped?.() === true) {
        return stored?.open === true ? stored : openBreaker("breaker-epoch-tripped", stored?.tripCount);
      }
      return stored ?? makeCircuitBreaker({ open: false, tripCount: 0 });
    } catch {
      return openBreaker("breaker-read-failed");
    }
  }

  // BH-7: the process-local `breaker` only moves when THIS process trips or
  // resets it, so a peer's trip was invisible to this process's admission
  // boundaries. The durable root-global breaker epoch is the cross-process truth
  // and must be read fresh at every admission boundary. Open means "locally open
  // OR durably tripped": a peer trip suppresses admission here immediately, a
  // peer reset lets it resume, and a local trip stays sticky until this process
  // resets it. An unreadable epoch fails closed. It deliberately does not write
  // back to `breaker`, which stays this process's own trip/reset record.
  function breakerOpenNow() {
    if (breaker.open) return true;
    try {
      return store.breakerEpochTripped?.() === true;
    } catch {
      return true;
    }
  }

  function append(kind, payload, timestamp, automationStamp = null) {
    const result = store.appendRecord?.(wrapRecord(kind, payload, timestamp), { automationStamp });
    if (!result?.ok) throw new Error(result?.reason ?? `${kind}-write-failed`);
  }

  function audit(action, details = {}, timestamp = now(), kind = "decision", automationStamp = null) {
    const clean = { action, ...details };
    try {
      const automation = safeAutomation(store);
      if (typeof store.getAutomationState === "function" && !automation?.enabled) return;
      const authoritativeStamp = automationStamp ?? automation?.stamp ?? null;
      const payloadHash = hash(JSON.stringify(clean));
      append("audit-event", makeAuditEvent({
        id: hash(`${timestamp}:${randomUUID()}:${payloadHash}`),
        kind,
        actor: ACTOR,
        timestamp,
        payloadHash,
        details: clean,
      }), timestamp, authoritativeStamp);
    } catch (error) {
      log({ level: "warn", action, error: String(error?.message ?? error) });
    }
  }

  function currentProject() {
    return safeSettings(store)?.repo?.projectFingerprint ?? null;
  }

  function currentBudgets(settings = safeSettings(store)) {
    return {
      ...DEFAULT_BUDGETS,
      ...(settings?.global?.budgets ?? {}),
      ...(settings?.repo?.budgets ?? {}),
      ...budgetOverrides,
    };
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
      audit("late-session-cleanup", { sessionIDHash: hashSessionLineage(sessionID) }, timestamp);
    }
    for (const [key, until] of backoffUntil) {
      if (until <= timestamp - FAILURE_WINDOW_MS) backoffUntil.delete(key);
    }
  }

  function scheduleDebounce(state, delay = configured.idleDebounceMs) {
    if (!accepting || disposed) return;
    clearTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      // BH-1: this is the only fire-and-forget entry into reserveEpisode. Nothing
      // downstream catches, and the host registers no unhandledRejection handler,
      // so any unguarded throw would take the host process down. Fail closed to a
      // recorded scheduler failure instead.
      void reserveEpisode(state).catch((error) => {
        try {
          audit("scheduler-failure", {
            sessionIDHash: hashSessionLineage(state.sessionID),
            reason: String(error?.message ?? error).slice(0, 400),
          }, now());
        } catch (auditError) {
          log({ level: "warn", action: "scheduler-failure-audit", error: String(auditError?.message ?? auditError) });
        }
      });
    }, Math.max(0, delay));
    state.timer.unref?.();
  }

  function runBudgetCheck(timestamp = now(), settings = safeSettings(store)) {
    const events = schedulerAudits(store);
    const fresh = currentBudgets(settings);
    return Object.freeze({
      passiveCallsRemainingThisHour: Math.max(0, fresh.passiveCallsPerHour - budgetCount(events, "passive", timestamp - HOUR_MS)),
      synthesesRemainingToday: Math.max(0, fresh.synthesisPerDay - budgetCount(events, "synthesis", timestamp - DAY_MS)),
      withinQuietPeriod: isQuiet(timestamp, quietHours),
    });
  }

  function reservePassiveProviderCalls(count, context = {}) {
    if (!Number.isSafeInteger(count) || count <= 0) return { ok: false, reason: "invalid-passive-provider-call-count" };
    const timestamp = now();
    let lease;
    let result;
    try {
      const automation = safeAutomation(store);
      if (!automation?.enabled) return { ok: false, reason: "automatic-recommendations-disabled" };
      if (context.automationStamp && !store.compareAutomationStamp?.(context.automationStamp)) {
        return { ok: false, reason: "stale-automation-generation" };
      }
      const automationStamp = context.automationStamp ?? automation.stamp;
      lease = store.acquireLease(PASSIVE_BUDGET_LEASE_KEY, {
        ttlMs: PASSIVE_BUDGET_LEASE_TTL_MS,
        actor: ACTOR,
        automationStamp,
      });
      if (!lease?.ok) return { ok: false, reason: lease?.reason === "lease-busy" ? "passive-provider-budget-reservation-busy" : String(lease?.reason ?? "passive-provider-budget-lease-failed") };

      const freshSettings = safeAutomation(store);
      if (!freshSettings) return { ok: false, reason: "passive-provider-budget-settings-unavailable" };
      const limit = currentBudgets(freshSettings).passiveCallsPerHour;
      const events = store.readRecords?.("audit-event")?.map((record) => record?.payload).filter((event) => event?.actor === ACTOR) ?? [];
      const used = budgetCount(events, "passive", timestamp - HOUR_MS);
      const remaining = Math.max(0, limit - used);
      if (remaining < count) {
        return {
          ok: false,
          reason: remaining === 0 ? "passive-provider-budget-exhausted" : "passive-provider-budget-insufficient",
          requested: count,
          remaining,
        };
      }

      const reservationId = hash(`passive-provider-reservation-v1:${timestamp}:${randomUUID()}`);
      const rootSessionIDHash = context.rootSessionIDHash
        ?? (context.rootSessionID ? hashSessionLineage(context.rootSessionID) : UNKNOWN_SESSION_LINEAGE_HASH);
      for (let slotIndex = 0; slotIndex < count; slotIndex += 1) {
        const clean = { action: "scheduler-budget", budgetType: "passive", reservationId, slotIndex, slotCount: count, rootSessionIDHash };
        const payloadHash = hash(JSON.stringify(clean));
        append("audit-event", makeAuditEvent({
          id: hash(`${timestamp}:${randomUUID()}:${payloadHash}`),
          kind: "decision",
          actor: ACTOR,
          timestamp,
          payloadHash,
          details: clean,
        }), timestamp, automationStamp);
      }
      const persisted = (store.readRecords?.("audit-event") ?? []).filter((record) =>
        record?.payload?.actor === ACTOR
        && record.payload.details?.action === "scheduler-budget"
        && record.payload.details?.budgetType === "passive"
        && record.payload.details?.reservationId === reservationId);
      if (persisted.length !== count) throw new Error("passive-provider-budget-reservation-readback-failed");
      result = { ok: true, reserved: count, remaining: remaining - count, reservationId };
    } catch (error) {
      result = { ok: false, reason: String(error?.message ?? error) };
    } finally {
      if (lease?.ok) {
        try {
          const released = store.releaseLease(PASSIVE_BUDGET_LEASE_KEY, lease.nonce);
          if (!released?.ok) log({ level: "warn", action: "release-passive-provider-budget-lease", error: released?.reason ?? "passive-provider-budget-lease-release-failed" });
        } catch (error) {
          log({ level: "warn", action: "release-passive-provider-budget-lease", error: String(error?.message ?? error) });
        }
      }
    }
    return result;
  }

  function releaseWorkLease(workItem) {
    const key = workItem?._leaseKey ?? leaseKey(workItem.projectFingerprint, workItem.sessionID);
    const nonce = workItem?.leaseNonce;
    if (!nonce || heldLeases.get(key) !== nonce) return;
    let result;
    try { result = store.releaseLease(key, nonce); } catch (error) { log({ level: "warn", action: "release-lease", error: String(error?.message ?? error) }); return; }
    if (result?.ok || ["lease-not-found", "nonce-mismatch", "lease-corrupt"].includes(result?.reason)) {
      heldLeases.delete(key);
    }
  }

  async function runWithEpisodeLease({ projectFingerprint, sessionID } = {}, operation) {
    if (typeof projectFingerprint !== "string" || !projectFingerprint
        || typeof sessionID !== "string" || !sessionID
        || typeof operation !== "function") {
      return { ok: false, reason: "invalid-episode-lease-request" };
    }
    const key = leaseKey(projectFingerprint, sessionID);
    const automation = safeAutomation(store);
    if (!automation?.enabled) return { ok: false, reason: "automatic-recommendations-disabled" };
    let lease;
    try {
      lease = store.acquireLease(key, { ttlMs: leaseTtlMs, actor: ACTOR, automationStamp: automation.stamp });
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
    if (!lease?.ok) {
      return {
        ok: false,
        reason: lease?.reason === "lease-busy" ? "episode-lease-busy" : String(lease?.reason ?? "episode-lease-failed"),
        deferred: lease?.reason === "lease-busy",
      };
    }
    heldLeases.set(key, lease.nonce);
    try {
      return { ok: true, value: await operation() };
    } finally {
      releaseWorkLease({ _leaseKey: key, leaseNonce: lease.nonce, projectFingerprint, sessionID });
    }
  }

  async function reserveEpisode(state) {
    if (!accepting || disposed) return;
    const timestamp = now();
    cleanupStaleSessions(timestamp);
    const automation = safeAutomation(store);
    if (!automation?.enabled || breakerOpenNow()
        || automation.global.killSwitchActive || automation.repo.excluded) return;
    const settings = automation;
    cachedMode = "auto";
    if (timestamp - state.touchedAt > STALE_SESSION_MS) {
      sessions.delete(state.sessionID);
      audit("late-session-cleanup", { sessionIDHash: hashSessionLineage(state.sessionID) }, timestamp);
      return;
    }
    if (inFlight.has(state.sessionID)) {
      state.pendingAfterFlight = true;
      audit("continuation-deferred", { sessionIDHash: hashSessionLineage(state.sessionID), epoch: state.epoch }, timestamp);
      return;
    }
    const budget = runBudgetCheck(timestamp, settings);
    if (budget.withinQuietPeriod || budget.passiveCallsRemainingThisHour === 0 || budget.synthesesRemainingToday === 0) {
      audit("schedule-suppressed", {
        sessionIDHash: hashSessionLineage(state.sessionID),
        reason: budget.withinQuietPeriod ? "quiet-period" : "budget-exhausted",
      }, timestamp);
      return;
    }
    const failureKey = schedulingFailureKey(state.rootSessionID);
    const until = backoffUntil.get(failureKey) ?? persistedBackoffUntil(failureKey, timestamp);
    if (until > 0) backoffUntil.set(failureKey, until);
    if (until > timestamp) {
      scheduleDebounce(state, until - timestamp);
      return;
    }

    const projectFingerprint = settings?.repo?.projectFingerprint;
    if (!projectFingerprint) return;
    const consent = settings.global.consent;
    if (!consent?.durableObservations || !consent?.sanitizedExcerpts || !consent?.crossRepoAggregation) {
      audit("schedule-suppressed", {
        sessionIDHash: hashSessionLineage(state.sessionID),
        reason: "consent-missing",
      }, timestamp);
      return;
    }
    const sessionIDHash = hashSessionLineage(state.sessionID);
    const cursor = latestCursor(store, sessionIDHash);
    if (!canStartEpisode(cursor, timestamp, configured.idleDebounceMs)) {
      audit("episode-not-ready", { sessionIDHash, epoch: state.epoch }, timestamp);
      return;
    }

    const key = leaseKey(projectFingerprint, state.sessionID);
    let lease;
    try {
      lease = store.acquireLease(key, { ttlMs: leaseTtlMs, actor: ACTOR, automationStamp: automation.stamp });
    } catch (error) {
      audit("scheduler-failure", { sessionIDHash, reason: String(error?.message ?? error).slice(0, 400) }, timestamp);
      return;
    }
    if (!lease?.ok) {
      audit(lease?.reason === "lease-busy" ? "lease-busy" : "lease-failed", {
        sessionIDHash,
        reason: String(lease?.reason ?? "unknown"),
      }, timestamp, "lease");
      return;
    }
    if (!accepting || disposed) {
      try { store.releaseLease(key, lease.nonce); } catch {}
      return;
    }

    let workItem;
    heldLeases.set(key, lease.nonce);
    try {
      const reservedCursor = beginEpisode(cursor, timestamp, lease.nonce);
      workItem = Object.freeze({
        sessionID: state.sessionID,
        projectFingerprint,
        scopeFingerprint: state.scopeFingerprint ?? projectFingerprint,
        cursor: reservedCursor,
        leaseNonce: lease.nonce,
        scheduledAt: timestamp,
        trigger: cachedMode,
        epoch: state.epoch,
        ...(state.canonicalRootSessionID ? { rootSessionID: state.canonicalRootSessionID } : {}),
        rootSessionIDHash: state.rootLineageHash ?? UNKNOWN_ROOT_LINEAGE_HASH,
        originKind: state.originKind ?? "unknown",
        automationStamp: automation.stamp,
      });
      inFlight.set(state.sessionID, workItem);
    } catch (error) {
      releaseWorkLease({ _leaseKey: key, leaseNonce: lease.nonce, projectFingerprint, sessionID: state.sessionID });
      if (inFlight.get(state.sessionID)?.leaseNonce === lease.nonce) inFlight.delete(state.sessionID);
      audit("scheduler-failure", {
        sessionIDHash,
        reason: String(error?.message ?? error).slice(0, 400),
      }, timestamp);
      return;
    }

    const workPromise = Promise.resolve()
      .then(() => enqueueWork(workItem))
      .then(
        (result) => recordWorkResult(workItem, result),
        (error) => recordWorkResult(workItem, { ok: false, error: String(error?.message ?? error) }),
      )
      .catch((error) => {
        log({ level: "warn", action: "settle-work", error: String(error?.message ?? error) });
      });
    workPromises.add(workPromise);
    void workPromise.finally(() => workPromises.delete(workPromise));
  }

  async function handleEvent(input, trustedLineage) {
    if (!accepting || disposed) return;
    const event = eventBody(input);
    const status = statusType(event);
    if (!status && event?.type !== "session.compacted") return;
    const automation = safeAutomation(store);
    if (!automation?.enabled || automation.global.killSwitchActive || automation.repo.excluded) return;
    cachedMode = "auto";
    const sessionID = eventSessionID(event);
    if (!sessionID) return;
    const timestamp = now();
    cleanupStaleSessions(timestamp);
    const prior = sessions.get(sessionID);
    const suppliedEpoch = eventEpoch(event);
    const latestEpoch = Math.max(prior?.epoch ?? 0, prior?.nextEpoch ?? 0);
    if (prior && suppliedEpoch !== null && suppliedEpoch < latestEpoch) {
      audit("out-of-order-event", { sessionIDHash: hashSessionLineage(sessionID), epoch: suppliedEpoch }, timestamp);
      return;
    }
    const epoch = suppliedEpoch ?? latestEpoch + 1;
    const state = prior ?? { sessionID, timer: null, pendingAfterFlight: false };
    state.touchedAt = timestamp;
    const parentID = eventParentID(event);
    const projectFingerprint = eventProjectFingerprint(event) ?? currentProject();
    state.reused ||= changedField(parentID, prior?.parentID, null)
      || changedField(projectFingerprint, prior?.projectFingerprint, null);
    state.parentID = parentID !== null ? parentID : prior?.parentID ?? null;
    state.projectFingerprint = projectFingerprint ?? prior?.projectFingerprint;
    const root = trustedLineage?.resolved === true
      && trustedLineage.originKind === "user"
      && typeof trustedLineage.rootSessionID === "string"
      && typeof trustedLineage.rootLineageHash === "string"
      ? trustedLineage
      : resolveRootLineage({ sessionID, projectFingerprint: state.projectFingerprint, sessions: [...sessions.values(), state] });
    state.canonicalRootSessionID = root.resolved ? root.rootSessionID : null;
    state.rootLineageHash = root.rootLineageHash;
    state.originKind = root.originKind;
    state.rootSessionID = root.resolved ? root.rootSessionID : eventParentID(event) ?? prior?.rootSessionID ?? sessionID;
    state.scopeFingerprint = event?.properties?.scopeFingerprint ?? prior?.scopeFingerprint ?? currentProject();
    sessions.set(sessionID, state);

    if (status === "idle" && inFlight.has(sessionID)) {
      state.nextEpoch = epoch;
      scheduleDebounce(state);
      return;
    }
    state.epoch = epoch;

    if (event?.type === "session.compacted") {
      audit("session-compacted", { sessionIDHash: hashSessionLineage(sessionID), epoch }, timestamp);
      return;
    }
    if (status !== "idle") {
      clearTimer(state);
      if (status !== "busy") {
        audit("session-status", { sessionIDHash: hashSessionLineage(sessionID), status: String(status), epoch }, timestamp);
      }
      return;
    }
    const observedAt = eventTimestamp(event);
    if (observedAt !== null && timestamp - observedAt > STALE_SESSION_MS) {
      clearTimer(state);
      audit("late-session-cleanup", { sessionIDHash: hashSessionLineage(sessionID) }, timestamp);
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
    // H5-001: also write the durable root-global breaker epoch so peer processes
    // see the open state at their next boundary read. Idempotent within a
    // generation; best-effort on capability-unavailable hosts.
    try {
      store.tripBreakerEpoch?.({ reason: String(reason || "scheduler-failure"), operationId: `scheduler-trip:${now()}` });
    } catch (error) { log({ level: "warn", action: "persist-breaker-epoch-trip", error: String(error?.message ?? error) }); }
    for (const state of sessions.values()) clearTimer(state);
    cachedMode = "manual";
    return breaker;
  }

  function resetCircuitBreaker(reason = "manual-reset") {
    breaker = reset(breaker);
    try { append("circuit-breaker", breaker, now()); } catch (error) { log({ level: "warn", action: "persist-circuit-breaker-reset", error: String(error?.message ?? error) }); }
    audit("circuit-breaker-reset", { reason: String(reason) }, now());
    // H5-001: the durable root-global breaker epoch is the cross-process truth.
    // A scheduler-local reset only clears this process's in-memory breaker; the
    // durable epoch requires the authenticated root-global reset operation
    // (integration resetBreaker / /self-evolve reset-breaker). Attempt a durable
    // reset only when the epoch is currently tripped; otherwise this is a local
    // no-op for peers. Best-effort: capability-unavailable hosts keep the local
    // reset so this process resumes, and the operator can retry the durable
    // reset from a capable process.
    try {
      if (store.breakerEpochTripped?.() === true) {
        store.resetBreakerEpoch?.({
          confirmation: BREAKER_EPOCH_RESET_CONFIRMATION,
          authentication: { operatorAuthority: "operator" },
        });
      }
    } catch (error) { log({ level: "warn", action: "persist-breaker-epoch-reset", error: String(error?.message ?? error) }); }
    cachedMode = effectiveMode();
    return breaker;
  }

  function setMode(mode, reason = "mode-change") {
    if (!Mode.values.includes(mode)) throw new TypeError("invalid-mode");
    const prior = cachedMode;
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

  function schedulingFailureKey(rootSessionID) {
    return hashSessionLineage(rootSessionID);
  }

  function persistedBackoffUntil(key, timestamp) {
    const latest = schedulerAudits(store).findLast((event) =>
      event.timestamp >= timestamp - FAILURE_WINDOW_MS
      && event.details?.action === "work-failure"
      && event.details?.failureKey === key);
    return Number.isSafeInteger(latest?.details?.backoffUntil) ? latest.details.backoffUntil : 0;
  }

  function recordWorkResult(workItem, result = {}) {
    const sessionID = workItem?.sessionID;
    const owner = sessionID ? inFlight.get(sessionID) : undefined;
    if (!owner) return { accepted: false, stale: false, duplicate: true };
    if (owner.leaseNonce !== workItem.leaseNonce) return { accepted: false, stale: true, superseded: true };

    const timestamp = now();
    const state = sessions.get(sessionID);
    const stale = timestamp - workItem.scheduledAt > workItemTtlMs
      || (state && workItem.epoch !== state.epoch);
    releaseWorkLease(workItem);
    inFlight.delete(sessionID);
    if (stale) {
      audit("stale-work-result", { sessionIDHash: hashSessionLineage(sessionID) }, timestamp);
      return { accepted: false, stale: true };
    }

    if (normalizeResultFailure(result)) {
      const failureKey = schedulingFailureKey(state?.rootSessionID ?? workItem.sessionID);
      const priorFailures = persistedFailures(failureKey, timestamp);
      const failures = priorFailures + 1;
      const delayMs = Math.min(STALE_SESSION_MS, backoffBaseMs * (2 ** Math.max(0, failures - 1)));
      const nextBackoffUntil = timestamp + delayMs;
      audit("work-failure", {
        failureKey,
        sessionIDHash: hashSessionLineage(workItem.sessionID),
        backoffUntil: nextBackoffUntil,
        ...(result.clusterID ? { clusterID: String(result.clusterID).slice(0, 160) } : {}),
      }, timestamp);
      backoffUntil.set(failureKey, nextBackoffUntil);
      if (failures >= 3 && !breaker.open) tripCircuitBreaker("three-failures-in-24h");
    }
    if (state?.pendingAfterFlight && accepting && !disposed && cachedMode !== "manual" && !breaker.open) {
      state.pendingAfterFlight = false;
      state.epoch = state.nextEpoch ?? state.epoch + 1;
      state.nextEpoch = null;
      scheduleDebounce(state);
    }
    return { accepted: true, stale: false };
  }

  function stopAdmission() {
    if (!accepting) return { ok: true, alreadyStopped: true };
    accepting = false;
    for (const state of sessions.values()) clearTimer(state);
    return { ok: true };
  }

  async function drain() {
    while (workPromises.size) await Promise.allSettled([...workPromises]);
    return { ok: true };
  }

  // H7-001: Independent candidate-drain trigger. This is callable without a
  // session idle event or new source observation. It checks budgets, breaker,
  // and consent, acquires a cross-process drain lease, and enqueues a drain
  // work item that the integration layer processes through the normal
  // work-promise plumbing. The drain work item carries no sessionID cursor,
  // signaling that the pipeline should skip observation and proceed directly
  // to draining eligible candidates.
  function triggerCandidateDrain({ projectFingerprint, scopeFingerprint } = {}) {
    if (!accepting || disposed) return { ok: false, reason: "scheduler-not-accepting" };
    const timestamp = now();
    const automation = safeAutomation(store);
    if (!automation?.enabled) return { ok: false, reason: "automatic-recommendations-disabled" };
    const settings = automation;
    cachedMode = "auto";
    if (breakerOpenNow()) return { ok: false, reason: "circuit-breaker-open" };
    const resolvedProject = projectFingerprint ?? settings?.repo?.projectFingerprint;
    if (!resolvedProject) return { ok: false, reason: "project-fingerprint-required" };
    const budget = runBudgetCheck(timestamp, settings);
    if (budget.withinQuietPeriod || budget.passiveCallsRemainingThisHour === 0 || budget.synthesesRemainingToday === 0) {
      audit("drain-suppressed", {
        projectFingerprint: resolvedProject,
        reason: budget.withinQuietPeriod ? "quiet-period" : "budget-exhausted",
      }, timestamp);
      return { ok: false, reason: budget.withinQuietPeriod ? "quiet-period" : "budget-exhausted" };
    }
    const consent = settings.global.consent;
    if (!consent?.durableObservations || !consent?.sanitizedExcerpts || !consent?.crossRepoAggregation) {
      audit("drain-suppressed", { projectFingerprint: resolvedProject, reason: "consent-missing" }, timestamp);
      return { ok: false, reason: "consent-missing" };
    }
    const leaseKey = `drain_${hash(`${resolvedProject}`)}`;
    let lease;
    try {
      lease = store.acquireLease(leaseKey, { ttlMs: leaseTtlMs, actor: ACTOR, automationStamp: automation.stamp });
    } catch (error) {
      audit("drain-failure", { projectFingerprint: resolvedProject, reason: String(error?.message ?? error).slice(0, 400) }, timestamp);
      return { ok: false, reason: "drain-lease-failed" };
    }
    if (!lease?.ok) {
      audit(lease?.reason === "lease-busy" ? "drain-lease-busy" : "drain-lease-failed", {
        projectFingerprint: resolvedProject,
        reason: String(lease?.reason ?? "unknown"),
      }, timestamp, "lease");
      return { ok: false, reason: lease?.reason === "lease-busy" ? "drain-lease-busy" : "drain-lease-failed" };
    }
    heldLeases.set(leaseKey, lease.nonce);
    const drainId = hash(`drain-work-v1:${resolvedProject}:${timestamp}:${randomUUID()}`);
    const workItem = Object.freeze({
      drain: true,
      drainId,
      sessionID: `drain:${drainId.slice(0, 16)}`,
      projectFingerprint: resolvedProject,
      scopeFingerprint: scopeFingerprint ?? resolvedProject,
      leaseNonce: lease.nonce,
      _leaseKey: leaseKey,
      scheduledAt: timestamp,
      trigger: cachedMode,
      epoch: 0,
      cursor: makeEpisodeCursor({ sessionIDHash: hashSessionLineage(drainId) }),
      rootSessionIDHash: UNKNOWN_ROOT_LINEAGE_HASH,
      originKind: "unknown",
      automationStamp: automation.stamp,
    });
    const budgetSnapshot = Object.freeze({
      synthesesRemainingToday: budget.synthesesRemainingToday,
      passiveCallsRemainingThisHour: budget.passiveCallsRemainingThisHour,
    });
    const workPromise = Promise.resolve()
      .then(() => enqueueWork(workItem))
      .then(
        (result) => recordDrainWorkResult(workItem, budgetSnapshot, result),
        (error) => recordDrainWorkResult(workItem, budgetSnapshot, { ok: false, error: String(error?.message ?? error) }),
      )
      .catch((error) => {
        log({ level: "warn", action: "settle-drain-work", error: String(error?.message ?? error) });
      });
    workPromises.add(workPromise);
    void workPromise.finally(() => workPromises.delete(workPromise));
    audit("drain-admitted", {
      projectFingerprint: resolvedProject,
      drainId,
      synthesesRemainingToday: budgetSnapshot.synthesesRemainingToday,
      passiveCallsRemainingThisHour: budgetSnapshot.passiveCallsRemainingThisHour,
    }, timestamp);
    return { ok: true, drainId };
  }

  function recordDrainWorkResult(workItem, budgetSnapshot, result = {}) {
    const key = workItem?._leaseKey;
    const nonce = workItem?.leaseNonce;
    if (key && nonce && heldLeases.get(key) === nonce) {
      try { store.releaseLease(key, nonce); heldLeases.delete(key); }
      catch (error) { log({ level: "warn", action: "release-drain-lease", error: String(error?.message ?? error) }); }
    }
    const timestamp = now();
    if (normalizeResultFailure(result)) {
      audit("drain-failure", {
        projectFingerprint: workItem?.projectFingerprint,
        drainId: workItem?.drainId,
        reason: String(result?.reason ?? result?.error ?? "unknown").slice(0, 400),
        synthesesRemainingToday: budgetSnapshot.synthesesRemainingToday,
        passiveCallsRemainingThisHour: budgetSnapshot.passiveCallsRemainingThisHour,
      }, timestamp);
    } else {
      audit("drain-settled", {
        projectFingerprint: workItem?.projectFingerprint,
        drainId: workItem?.drainId,
        drained: Array.isArray(result?.drained) ? result.drained.length : 0,
        result: String(result?.result ?? "ok").slice(0, 128),
        synthesesRemainingToday: budgetSnapshot.synthesesRemainingToday,
        passiveCallsRemainingThisHour: budgetSnapshot.passiveCallsRemainingThisHour,
      }, timestamp);
    }
    return { accepted: true, stale: false };
  }

  function dispose() {
    if (disposed) return;
    stopAdmission();
    disposed = true;
    for (const state of sessions.values()) clearTimer(state);
    for (const [key, nonce] of heldLeases) {
      try { store.releaseLease(key, nonce); } catch (error) { log({ level: "warn", action: "dispose-release", error: String(error?.message ?? error) }); }
    }
    heldLeases.clear();
    sessions.clear();
    backoffUntil.clear();
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
    reservePassiveProviderCalls,
    runWithEpisodeLease,
    getCircuitBreaker: () => breaker,
    tripCircuitBreaker,
    resetCircuitBreaker,
    setMode,
    recordWorkResult,
    triggerCandidateDrain,
    stopAdmission,
    drain,
    dispose,
  });
}
