import { watch as watchDirectory } from "node:fs";
import path from "node:path";
import {
  BRIDGE_TTL_MS,
  createGlobalActionRequest,
  createDecisionRequest,
  createUiOperationRequest,
  pollGlobalActionResponse,
  pollDecisionResponse,
  pollUiOperationResponse,
  readBoundedInspection,
  readGlobalRecommendationProjection,
  readProjectInbox,
  readProjectParticipationSidecars,
  readTuiHostHealth,
  readUiProjection,
  submitGlobalActionRequest,
  submitDecisionRequest,
  submitUiOperationRequest,
} from "./self-evolve-bridge.js";
import { resolveProjectIdentity } from "./self-evolve-store.js";
import { readLatestSensitiveExport } from "./self-evolve-export.js";
import { deepFreeze } from "./self-evolve-schemas.js";
import {
  initialStateRootSelection,
  stateRootIdentity,
} from "./self-evolve-state-root.js";
import {
  UI_CAPABILITIES,
  UI_CONTROL_CENTER_SETTINGS_ANCHORS,
  UI_DASHBOARD_BLOCKER_DESTINATIONS,
  GLOBAL_BRIDGE_SCHEMA_VERSION,
  GLOBAL_CAPABILITIES,
  GLOBAL_OPERATION_PROTOCOL_VERSION,
  GLOBAL_PROJECTION_VERSION,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
} from "./self-evolve-ui-protocol.js";

const DEFAULT_POLL_MS = 250;
// Circuit breaker for the refresh loop: after this many consecutive refresh
// failures the poll cadence backs off exponentially (capped) instead of
// retrying a failing server call at full rate forever, and the snapshot
// carries a degraded-health record for the UI. One success restores cadence.
const BREAKER_OPEN_THRESHOLD = 3;
const BREAKER_MAX_INTERVAL_MS = 30_000;
const MIN_POLL_MS = 25;
const MAX_POLL_MS = 5_000;
const DEFAULT_SERVER_RESPONSE_MS = 5_000;
const MAX_SERVER_RESPONSE_MS = 30_000;
const MAX_PENDING_RESPONSES = 32;
const MAX_COMPLETED_RESPONSES = 4;
const MAX_RESIDENT_DETAILS = 2;
const PATH_EVENTS = Object.freeze([
  "project.updated",
]);
const CLIENT_OFFER = Object.freeze({
  projectionVersions: Object.freeze([UI_PROJECTION_VERSION]),
  operationProtocolVersions: Object.freeze([UI_OPERATION_PROTOCOL_VERSION]),
  capabilities: UI_CAPABILITIES,
});
const GLOBAL_CLIENT_OFFER = Object.freeze({
  bridgeSchemaVersions: Object.freeze([GLOBAL_BRIDGE_SCHEMA_VERSION]),
  projectionVersions: Object.freeze([GLOBAL_PROJECTION_VERSION]),
  operationProtocolVersions: Object.freeze([GLOBAL_OPERATION_PROTOCOL_VERSION]),
  capabilities: GLOBAL_CAPABILITIES,
});
const projectRuntimes = new Map();
const globalRuntimes = new Map();
const terminalStateRoots = new Set();
const WATCHER_STATUS = Object.freeze({
  active: "Filesystem watcher active",
  polling: "Polling fallback active",
});
const BREAKER_STATUS = Object.freeze({
  true: "Open after repeated failures",
  false: "Closed",
});

function errorReason(error) {
  return boundedDisplayText(error instanceof Error ? error.message : String(error), 240);
}

function boundedDisplayText(value, max) {
  const source = String(value);
  if (source.length <= max) return source;
  const marker = " [truncated]";
  return `${source.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

function hasNativeOperationProtocol(projection) {
  return projection?.mode === "native"
    && projection.operationProtocolVersion === UI_OPERATION_PROTOCOL_VERSION;
}

function hasCurrentNativeAuthority(snapshot) {
  return snapshot?.phase === "ready" && hasNativeOperationProtocol(snapshot.projection);
}

function hasCurrentActingProjectAuthority(snapshot) {
  return hasCurrentNativeAuthority(snapshot)
    && snapshot.projection?.index?.projectFingerprint === snapshot.projectFingerprint
    && snapshot.projection?.index?.stateRootIdentity === snapshot.stateRootIdentity
    && snapshot.tuiHealth?.projectFingerprint === snapshot.projectFingerprint
    && snapshot.tuiHealth?.stateRootIdentity === snapshot.stateRootIdentity
    && snapshot.tuiHealth.expiresAt > snapshot.updatedAt;
}

function hasCurrentGlobalAuthority(globalSnapshot) {
  return globalSnapshot?.phase === "ready"
    && globalSnapshot.projection?.mode === "native"
    && globalSnapshot.projection?.operationProtocolVersion === GLOBAL_OPERATION_PROTOCOL_VERSION;
}

function projectionWithoutAuthority(projection) {
  if (!projection) return null;
  return deepFreeze({
    ...projection,
    effectiveIndexActions: Object.freeze([]),
    effectiveDetailActions: deepFreeze(Object.fromEntries(
      Object.keys(projection.effectiveDetailActions ?? {}).map((proposalId) => [proposalId, Object.freeze([])]),
    )),
  });
}

function projectionWithoutFailedClosedAuthority(projection) {
  if (!projection) return null;
  const failedProposalIds = new Set((projection.index?.reviews ?? [])
    .filter((review) => review.state === "failed-closed")
    .map((review) => review.proposalId));
  if (!failedProposalIds.size) return projection;
  return deepFreeze({
    ...projection,
    effectiveDetailActions: deepFreeze(Object.fromEntries(
      Object.entries(projection.effectiveDetailActions ?? {}).map(([proposalId, actions]) => [
        proposalId,
        failedProposalIds.has(proposalId) ? Object.freeze([]) : actions,
      ]),
    )),
  });
}

function globalProjectionWithoutAuthority(projection) {
  if (!projection) return null;
  return deepFreeze({ ...projection, grants: Object.freeze([]) });
}

function activityEmptyState(dashboard, activity, filter, enhancedError) {
  if (!dashboard) {
    return enhancedError
      ? "Enhanced activity is temporarily unavailable"
      : "Limited view: activity requires an aligned server";
  }
  if (activity.length) return null;
  return filter === "all" ? "No activity yet" : "No activity matches this filter";
}

function boundedPollMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.trunc(value)));
}

function boundedServerResponseMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_SERVER_RESPONSE_MS;
  return Math.min(MAX_SERVER_RESPONSE_MS, Math.max(1, Math.trunc(value)));
}

function cleanRuntimeMetadata(value = {}) {
  const version = (input) => /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u.test(String(input ?? ""))
    ? String(input)
    : "unknown";
  return deepFreeze({
    hostVersion: version(value.hostVersion),
    hostVersionSource: value.hostVersionSource === "tui-app-version" ? "TUI application version" : "Unavailable",
    pluginVersion: version(value.pluginVersion),
  });
}

function pathIdentityFor(context) {
  return JSON.stringify([
    "self-evolve-tui-path-v1",
    context.stateRootIdentity,
    context.projectFingerprint,
    context.worktreePath,
  ]);
}

function nonEmptyPath(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function resolveTuiStoreContext(api, config = {}, {
  allowStartupStateRoot = true,
  allowStartupWorktree = true,
} = {}) {
  const stateRoot = initialStateRootSelection({
    explicitStateRoot: config.stateRoot,
    hostStateRoot: nonEmptyPath(api.state?.path?.state) ?? (allowStartupStateRoot ? config.startupStateRoot : undefined),
    environment: {},
  }).stateRoot;
  const identity = resolveProjectIdentity({
    projectFingerprint: config.projectFingerprint,
    remoteUrl: config.remoteUrl,
    worktreePath: nonEmptyPath(config.worktree)
      ?? nonEmptyPath(api.state?.path?.worktree)
      ?? (allowStartupWorktree ? config.startupWorktree : undefined),
    directory: nonEmptyPath(api.state?.path?.directory)
      ?? (allowStartupWorktree ? config.startupWorktree : undefined),
  });
  const context = {
    stateRoot,
    stateRootIdentity: stateRootIdentity(stateRoot),
    projectFingerprint: identity.projectFingerprint,
    worktreePath: identity.worktreePath,
  };
  return deepFreeze({
    ...context,
    key: `${context.stateRootIdentity}:${context.projectFingerprint}`,
    globalKey: context.stateRootIdentity,
    pathIdentity: pathIdentityFor(context),
    watchPath: path.join(stateRoot, "self-evolve", "bridge", identity.projectFingerprint),
    globalWatchPath: path.join(stateRoot, "self-evolve", "bridge", "global"),
  });
}

function defaultClient(context, now) {
  return {
    read({ detailProposalIds }) {
      return readUiProjection(context.stateRoot, context.projectFingerprint, {
        now: now(),
        stateRootIdentity: context.stateRootIdentity,
        clientOffer: CLIENT_OFFER,
        detailProposalIds,
      });
    },
    reconcilePending(entries) {
      const pending = [];
      const responses = [];
      for (const entry of entries) {
        if (entry.kind === "operation") {
          const response = pollUiOperationResponse(context.stateRoot, entry.request, { now: now() });
          if (response) responses.push({ ...entry, response });
          else pending.push(entry);
          continue;
        }
        const response = pollDecisionResponse(context.stateRoot, context.projectFingerprint, entry.requestId);
        if (response) responses.push({ ...entry, response });
        else pending.push(entry);
      }
      return { pending, responses };
    },
    readInbox() {
      return readProjectInbox(context.stateRoot, context.projectFingerprint, { now: now() });
    },
    readLatestExport() {
      return readLatestSensitiveExport({
        stateRoot: context.stateRoot,
        projectFingerprint: context.projectFingerprint,
        now: now(),
      });
    },
    readInspection() {
      return readBoundedInspection(context.stateRoot, context.projectFingerprint);
    },
    readParticipation() {
      return readProjectParticipationSidecars(context.stateRoot, context.projectFingerprint, { now: now() });
    },
    readTuiHealth() {
      return readTuiHostHealth(context.stateRoot, context.projectFingerprint, {
        now: now(),
        stateRootIdentity: context.stateRootIdentity,
      });
    },
    submitDecision(request) {
      return submitDecisionRequest(context.stateRoot, request);
    },
    submitOperation(request) {
      return submitUiOperationRequest(context.stateRoot, request);
    },
  };
}

function defaultGlobalClient(context, now) {
  return {
    read() {
      return readGlobalRecommendationProjection(context.stateRoot, {
        now: now(),
        clientOffer: GLOBAL_CLIENT_OFFER,
      });
    },
    reconcilePending(entries) {
      const pending = [];
      const responses = [];
      for (const entry of entries) {
        const response = pollGlobalActionResponse(context.stateRoot, entry.request, { now: now() });
        if (response) responses.push({ ...entry, response });
        else pending.push(entry);
      }
      return { pending, responses };
    },
    submitAction(request) {
      return submitGlobalActionRequest(context.stateRoot, request);
    },
  };
}

function cleanDetailIds(value) {
  if (!Array.isArray(value)) throw new TypeError("detail-proposal-ids-must-be-an-array");
  const ids = value.map((item) => String(item));
  if (ids.length > MAX_RESIDENT_DETAILS || new Set(ids).size !== ids.length) {
    throw new TypeError("resident-details-out-of-bounds");
  }
  return Object.freeze([...ids].sort());
}

// BH-3: a refresh pass snapshots the pending map, then awaits the server. Any
// request submitted during that window lands in the live map, so committing the
// snapshot wholesale would silently discard it and its outcome would never
// surface. Reconcile only the requests this pass took responsibility for and
// keep everything that arrived meanwhile.
function mergePending(live, reconciled, reconciling) {
  const merged = new Map(reconciled.map((entry) => [entry.requestId, entry]));
  for (const [requestId, entry] of live) {
    if (!reconciling.has(requestId)) merged.set(requestId, entry);
  }
  return merged;
}

function cleanPending(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("pending-request-malformed");
  if (typeof value.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.requestId)) {
    throw new TypeError("invalid-pending-request-id");
  }
  if (!["decision", "operation", "global-action"].includes(value.kind)) throw new TypeError("invalid-pending-request-kind");
  if (typeof value.subject !== "string" || value.subject.length < 1 || value.subject.length > 256) {
    throw new TypeError("invalid-pending-request-subject");
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.submittedAt) {
    throw new TypeError("invalid-pending-request-expiry");
  }
  return deepFreeze({
    requestId: value.requestId,
    kind: value.kind,
    action: typeof value.action === "string" ? value.action : null,
    subject: value.subject,
    submittedAt: Number.isSafeInteger(value.submittedAt) && value.submittedAt >= 0 ? value.submittedAt : 0,
    expiresAt: value.expiresAt,
    ...(["operation", "global-action"].includes(value.kind) && value.request ? { request: value.request } : {}),
  });
}

function controlSubject(action, payload = {}) {
  if (action === "set-permission") return `permission:${String(payload.permission ?? "unknown")}`;
  if (action === "set-automatic-recommendations") return "automatic-recommendations";
  if (action === "set-repo-excluded") return "project-inclusion";
  if (action === "update-allowlist") return "approved-skill-folders";
  return "project";
}

function operationSubject(action, payload = {}, proposalId) {
  if (proposalId) return proposalId;
  if (action === "set-automatic-recommendations") return "automatic-recommendations";
  if (action === "set-permission") return `permission:${String(payload.permission ?? "unknown")}`;
  if (action === "set-repo-excluded") return "project-inclusion";
  if (["export-data", "purge-scope"].includes(action)) return `scope:${String(payload.scope ?? "project")}`;
  return "project";
}

function pendingMatches(entry, action, subject) {
  return entry.action === action && entry.subject === subject;
}

function expiredPendingResponse(entry) {
  return deepFreeze({
    ...entry,
    response: {
      ok: false,
      status: "expired",
      processedAt: entry.expiresAt,
      reason: "response-not-received-before-expiry",
    },
  });
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

const ACTIVE_OPERATION_STATES = new Set(["queued", "running", "accepted-terminal"]);
const REVIEW_ATTENTION_STATES = new Set(["pending", "approved"]);
const ERROR_OUTCOMES = new Set(["failed", "failed-closed", "breaker-open"]);
const APPLIED_OUTCOMES = new Set(["applied", "recommendation-approved"]);
export const REJECTION_FEEDBACK_OPTIONS = Object.freeze([
  { value: "incorrect-evidence", label: "Incorrect evidence" },
  { value: "already-covered", label: "Already covered" },
  { value: "wrong-scope", label: "Wrong scope" },
  { value: "too-specific", label: "Too specific" },
  { value: "not-worth-token-cost", label: "Not worth the token cost" },
  { value: "other", label: "Other" },
]);

function dashboardFor(snapshot) {
  return snapshot?.dashboard ?? snapshot?.projection?.dashboard ?? null;
}

function dashboardErrorFor(snapshot) {
  return snapshot?.dashboardError ?? snapshot?.projection?.dashboardError ?? null;
}

function globalProjectionFor(snapshot) {
  return snapshot?.global?.projection ?? null;
}

function usesGlobalRecommendations(snapshot) {
  return Boolean(globalProjectionFor(snapshot)?.index);
}

function reviewsFor(snapshot) {
  const global = globalProjectionFor(snapshot)?.index?.recommendations;
  if (Array.isArray(global)) {
    return global.map((entry) => ({
      proposalId: entry.recommendationId,
      recommendationId: entry.recommendationId,
      recommendationVersion: entry.recommendationVersion,
      detailHash: entry.detailHash,
      state: entry.state,
      target: `${entry.target.label}/SKILL.md`,
      attention: entry.state === "failed-closed" ? "critical" : entry.state === "pending" ? "warning" : "normal",
      updatedAt: entry.dates.updatedAt,
    }));
  }
  return snapshot?.projection?.index?.reviews ?? [];
}

function destination(section, extra = {}) {
  return { section, ...extra };
}

function blockerDestination(blocker) {
  const defined = UI_DASHBOARD_BLOCKER_DESTINATIONS[blocker?.code];
  if (!defined || defined.dashboard !== blocker?.destination) return destination("home");
  return destination(defined.section, {
    ...(defined.filter ? { filter: defined.filter } : {}),
    ...(defined.anchor ? { anchor: defined.anchor } : {}),
  });
}

function operationalResult(value) {
  return deepFreeze({
    state: value.state,
    tone: value.tone,
    label: value.label,
    explanation: value.explanation,
    destination: value.destination,
    nextAction: value.nextAction,
    count: value.count ?? 0,
    limited: value.limited === true,
  });
}

function acknowledgementMatches(snapshot, binding) {
  if (!binding) return false;
  return (snapshot?.acknowledgedOutcomes ?? []).some((entry) =>
    entry.scope === binding.scope
      && entry.subjectId === binding.subjectId
      && entry.version === binding.version
      && entry.auditIds.length === binding.auditIds.length
      && entry.auditIds.every((auditId, index) => auditId === binding.auditIds[index]));
}

function projectAcknowledgementBinding(review, detail, dashboard) {
  const version = detail?.detailHash ?? review?.detailHash;
  if (review?.state !== "applied" || !version) return null;
  const auditIds = (detail?.audit ?? [])
    .filter((entry) => entry.kind === "apply")
    .map((entry) => entry.id)
    .sort();
  if (!auditIds.length) {
    auditIds.push(...(dashboard?.activity ?? [])
      .filter((entry) => entry.outcome === "applied" && entry.proposalId === review.proposalId)
      .map((entry) => entry.id)
      .sort());
  }
  if (!auditIds.length) return null;
  return {
    scope: "project",
    subjectId: review.proposalId,
    version,
    auditIds,
  };
}

function globalAcknowledgementBinding(review, detail) {
  const recommendationVersion = detail?.recommendationVersion ?? review?.recommendationVersion;
  const detailHash = detail?.detailHash ?? review?.detailHash;
  if (review?.state !== "applied" || !recommendationVersion || !detailHash) return null;
  return {
    scope: "global",
    subjectId: review.recommendationId,
    version: `${recommendationVersion}:${detailHash}`,
    auditIds: [detailHash],
  };
}

function currentAcknowledgementBinding(snapshot, subjectId) {
  if (usesGlobalRecommendations(snapshot)) {
    const projection = globalProjectionFor(snapshot);
    const review = projection?.index?.recommendations?.find((entry) => entry.recommendationId === subjectId);
    const detail = projection?.details?.find((entry) => entry.recommendationId === subjectId);
    return globalAcknowledgementBinding(review, detail);
  }
  const review = snapshot?.projection?.index?.reviews?.find((entry) => entry.proposalId === subjectId);
  const detail = snapshot?.projection?.details?.find((entry) => entry.proposalId === subjectId);
  return projectAcknowledgementBinding(review, detail, dashboardFor(snapshot));
}

function globalFailureAcknowledgementBinding(entry) {
  if (!entry?.requestId || entry.response?.ok !== false) return null;
  return {
    scope: "global",
    subjectId: entry.requestId,
    version: entry.response.responseHash
      ?? `${entry.response.status ?? "failed"}:${entry.response.processedAt ?? entry.expiresAt}:${entry.requestId}`,
    auditIds: [entry.requestId],
  };
}

function appliedAttention(snapshot, reviews, dashboard) {
  if (usesGlobalRecommendations(snapshot)) {
    const details = new Map(globalProjectionFor(snapshot)?.details?.map((detail) => [detail.recommendationId, detail]) ?? []);
    const applied = reviews
      .map((review, index) => ({ review, index }))
      .filter(({ review }) => {
        if (review.state !== "applied") return false;
        const binding = globalAcknowledgementBinding(review, details.get(review.recommendationId));
        return !acknowledgementMatches(snapshot, binding);
      });
    return { count: applied.length, selectedIndex: applied[0]?.index ?? 0 };
  }
  const details = new Map((snapshot?.projection?.details ?? []).map((detail) => [detail.proposalId, detail]));
  const applied = reviews
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => {
      if (review.state !== "applied") return false;
      const binding = projectAcknowledgementBinding(review, details.get(review.proposalId), dashboard);
      return !acknowledgementMatches(snapshot, binding);
    });
  return { count: applied.length, selectedIndex: applied[0]?.index ?? 0 };
}

function resultForAutomation(state, snapshot, dashboard, reviews) {
  const blocker = dashboard?.blockers?.[0] ?? null;
  const mappings = {
    terminal: {
      tone: "error",
      label: "Restart required",
      explanation: "Self-evolve stopped its authority after a terminal operation.",
      destination: destination("home"),
      nextAction: "Restart OpenCode.",
    },
    corrupt: {
      tone: "error",
      label: "Self-evolve needs recovery",
      explanation: "Stored state or native compatibility could not be trusted.",
      destination: destination("activity", { filter: "errors" }),
      nextAction: "Review the bounded error and recovery options.",
    },
    "emergency-stop": {
      tone: "error",
      label: "Emergency stop is on",
      explanation: "Automatic provider calls and writes are disabled.",
      destination: destination("settings", { anchor: "emergency-stop" }),
      nextAction: "Review the reason before turning it off.",
    },
    "circuit-breaker": {
      tone: "error",
      label: "Paused after repeated failures",
      explanation: "Repeated failures stopped automatic work.",
      destination: destination("activity", { filter: "errors" }),
      nextAction: "Review failures, then reset when safe.",
    },
    off: {
      tone: "neutral",
      label: "Automatic recommendations are off",
      explanation: "Existing recommendations remain reviewable, but no new automatic work will start.",
      destination: destination("settings", { anchor: "automatic-recommendations" }),
      nextAction: "Turn automatic recommendations on when you want new suggestions.",
    },
    excluded: {
      tone: "warning",
      label: "Disabled for this project",
      explanation: "Global settings remain intact, but this project is excluded.",
      destination: destination("settings", { anchor: "project-scope" }),
      nextAction: "Include this project to allow automatic work.",
    },
    "setup-required": {
      tone: "warning",
      label: "Setup needed",
      explanation: blocker?.summary ?? "One or more automatic-work prerequisites are missing.",
      destination: blocker ? blockerDestination(blocker) : destination("settings", { anchor: "setup" }),
      nextAction: "Complete the first missing prerequisite.",
    },
    running: {
      tone: "info",
      label: dashboard?.inFlight?.stage === "apply" ? "Applying safely" : "Analysis in progress",
      explanation: `${plural(dashboard?.inFlight?.count ?? snapshot?.pending?.length ?? 1, "operation")} in progress.`,
      destination: destination("home"),
      nextAction: "Wait; this view updates in place.",
      count: dashboard?.inFlight?.count ?? snapshot?.pending?.length ?? 1,
    },
    backoff: {
      tone: "warning",
      label: "Waiting after a failure",
      explanation: dashboard?.nextEligibleAt
        ? `Automatic work can retry after ${new Date(dashboard.nextEligibleAt).toISOString()}.`
        : "Automatic work is in a bounded retry delay.",
      destination: destination("activity", { filter: "errors" }),
      nextAction: "Review the last failure or wait for retry.",
    },
    budget: {
      tone: "info",
      label: "Budget used for now",
      explanation: dashboard?.nextEligibleAt
        ? `Capacity resets after ${new Date(dashboard.nextEligibleAt).toISOString()}.`
        : "A rolling or daily budget has no remaining capacity.",
      destination: destination("home"),
      nextAction: "Wait for the displayed reset.",
    },
    "quiet-period": {
      tone: "neutral",
      label: "Quiet period",
      explanation: dashboard?.nextEligibleAt
        ? `Automatic work is deferred until ${new Date(dashboard.nextEligibleAt).toISOString()}.`
        : "Automatic work is intentionally deferred.",
      destination: destination("home"),
      nextAction: "Wait for the quiet period to end.",
    },
  };
  const failures = reviews.filter((review) => review.state === "failed-closed");
  const failedGlobalOperations = (snapshot?.global?.responses ?? []).filter((entry) => {
    const binding = globalFailureAcknowledgementBinding(entry);
    return binding && !acknowledgementMatches(snapshot, binding);
  });
  if (failedGlobalOperations.length && !["terminal", "corrupt", "emergency-stop", "circuit-breaker"].includes(state)) {
    return operationalResult({
      state: "failure",
      tone: "error",
      label: "Global operation failed",
      explanation: `${plural(failedGlobalOperations.length, "failed global operation")} needs acknowledgement.`,
      destination: destination("activity", { filter: "errors" }),
      nextAction: "Review and acknowledge the bounded failure.",
      count: failedGlobalOperations.length,
    });
  }
  if (failures.length && !["terminal", "corrupt", "emergency-stop", "circuit-breaker"].includes(state)) {
    return operationalResult({
      state: "failure",
      tone: "error",
      label: "Stopped after errors",
      explanation: `${plural(failures.length, "failed check")} needs review.`,
      destination: destination("activity", { filter: "errors" }),
      nextAction: "Review the bounded errors.",
      count: failures.length,
    });
  }

  const mapped = mappings[state];
  if (mapped) return operationalResult({ state, ...mapped });

  const recommendations = reviews
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => REVIEW_ATTENTION_STATES.has(review.state));
  if (recommendations.length) {
    return operationalResult({
      state: "recommendation",
      tone: recommendations.some(({ review }) => review.attention === "critical") ? "error" : "warning",
      label: "Recommendation ready",
      explanation: `${plural(recommendations.length, "recommendation")} waiting for a decision.`,
      destination: destination("recommendations", { selectedIndex: recommendations[0].index }),
      nextAction: "Review the selected recommendation.",
      count: recommendations.length,
    });
  }
  const applied = appliedAttention(snapshot, reviews, dashboard);
  if (applied.count) {
    return operationalResult({
      state: "applied",
      tone: "success",
      label: "Change applied",
      explanation: `${plural(applied.count, "verified change")} awaiting local acknowledgement.`,
      destination: destination("recommendations", { selectedIndex: applied.selectedIndex }),
      nextAction: "Review and acknowledge the selected change.",
      count: applied.count,
    });
  }
  if (snapshot?.projection?.index?.status?.state === "startup-pending") {
    return operationalResult({
      state: "startup",
      tone: "neutral",
      label: "Starting Self-evolve",
      explanation: "Compatibility and state checks are still running.",
      destination: destination("home"),
      nextAction: "Wait for startup checks.",
    });
  }
  return operationalResult({
    state: "ready",
    tone: "neutral",
    label: "Ready",
    explanation: "Automatic recommendations are ready within the displayed safeguards.",
    destination: destination("home"),
    nextAction: "No action required.",
  });
}

export function deriveOperationalView(snapshot) {
  if (snapshot?.phase === "terminal") {
    return resultForAutomation("terminal", snapshot, dashboardFor(snapshot), reviewsFor(snapshot));
  }
  const projection = snapshot?.projection;
  const index = projection?.index;
  const dashboard = dashboardFor(snapshot);
  const reviews = reviewsFor(snapshot);
  if (!index) {
    if (snapshot?.phase !== "error") {
      return operationalResult({
        state: "startup",
        tone: "neutral",
        label: "Starting Self-evolve",
        explanation: "Waiting for the first validated project projection.",
        destination: destination("home"),
        nextAction: "Wait for startup checks.",
        limited: true,
      });
    }
    return operationalResult({
      state: "corrupt",
      tone: "error",
      label: "Self-evolve needs recovery",
      explanation: "Native project state is unavailable.",
      destination: destination("activity", { filter: "errors" }),
      nextAction: "Review the bounded error and recovery options.",
      count: 1,
      limited: true,
    });
  }

  const status = index.status ?? {};
  if (status.state === "terminal") return resultForAutomation("terminal", snapshot, dashboard, reviews);
  if (["corrupt", "unavailable"].includes(status.state) || snapshot?.phase === "error") {
    return resultForAutomation("corrupt", snapshot, dashboard, reviews);
  }
  if (dashboard) {
    const result = resultForAutomation(dashboard.automation.state, snapshot, dashboard, reviews);
    if (["initializing", "limited", "error"].includes(snapshot?.global?.phase)
        && ["recommendation", "applied"].includes(result.state)) {
      return operationalResult({
        ...result,
        explanation: `${result.explanation} Global actions are limited and read-only until protocols align.`,
        limited: true,
      });
    }
    if (result.state === "ready" && snapshot?.global?.phase === "limited") {
      return operationalResult({
        state: "limited",
        tone: "warning",
        label: "Limited global view",
        explanation: "Current-project analysis is available, but global recommendations require an aligned server and TUI.",
        destination: destination("home"),
        nextAction: "Use current-project status read-only until global protocols align.",
        limited: true,
      });
    }
    return result;
  }

  // An older aligned server still supplies the bounded v1 projection. Preserve
  // high-confidence safety and attention states, but never invent enhanced
  // readiness, budget, quiet-period, backoff, or actual-usage claims.
  let fallbackState = null;
  if (status.killSwitchActive) fallbackState = "emergency-stop";
  else if (status.circuitBreakerOpen) fallbackState = "circuit-breaker";
  else if (status.repoExcluded) fallbackState = "excluded";
  else if (status.automaticRecommendationsEnabled === false) fallbackState = "off";
  else if (status.state === "setup-required") fallbackState = "setup-required";
  else if ((index.operations ?? []).some((operation) => ACTIVE_OPERATION_STATES.has(operation.status))
      || (snapshot?.pending?.length ?? 0) > 0) fallbackState = "running";
  if (fallbackState) {
    const result = resultForAutomation(fallbackState, snapshot, null, reviews);
    return operationalResult({ ...result, limited: true });
  }
  const attention = resultForAutomation("ready", snapshot, null, reviews);
  if (attention.state !== "ready") return operationalResult({ ...attention, limited: true });
  if (status.state === "startup-pending") {
    const startup = resultForAutomation("ready", snapshot, null, []);
    return operationalResult({ ...startup, state: "startup", label: "Starting Self-evolve",
      explanation: "Compatibility and state checks are still running.",
      nextAction: "Wait for startup checks.", limited: true });
  }
  return operationalResult({
    state: "limited",
    tone: dashboardErrorFor(snapshot) ? "warning" : "neutral",
    label: "Limited view",
    explanation: dashboardErrorFor(snapshot)
      ? "Enhanced readiness and activity could not be validated."
      : "Review data is available; enhanced readiness and actual usage require an aligned server.",
    destination: destination("home"),
    nextAction: "Use the available bounded review data.",
    limited: true,
  });
}

function lastChecked(snapshot) {
  const generatedAt = dashboardFor(snapshot)?.generatedAt;
  const updatedAt = Number.isSafeInteger(snapshot?.updatedAt) ? snapshot.updatedAt : generatedAt;
  if (!Number.isSafeInteger(generatedAt) || !Number.isSafeInteger(updatedAt)) return "Open details";
  const elapsed = Math.max(0, updatedAt - generatedAt);
  if (elapsed < 60_000) return "Checked just now";
  if (elapsed < 3_600_000) return `Checked ${Math.floor(elapsed / 60_000)}m ago`;
  return `Checked ${Math.floor(elapsed / 3_600_000)}h ago`;
}

export function deriveSidebarCard(snapshot) {
  const operational = deriveOperationalView(snapshot);
  const cardDestination = operational.destination;
  const kinds = {
    recommendation: "review",
    applied: "audit",
    running: "operation",
    terminal: "failure",
    corrupt: "failure",
    "circuit-breaker": "failure",
    backoff: "failure",
    failure: "failure",
    "setup-required": "setup",
  };
  return deepFreeze({
    kind: kinds[operational.state] ?? "status",
    tone: operational.tone,
    title: "Self-evolve",
    summary: operational.state === "ready" ? "Watching this project" : operational.label,
    detail: operational.state === "ready" ? lastChecked(snapshot) : operational.explanation,
    action: cardDestination.section === "recommendations"
      ? "Review recommendation"
      : `Open ${cardDestination.section === "activity" && cardDestination.filter === "errors"
        ? "Activity errors"
        : cardDestination.section[0].toUpperCase() + cardDestination.section.slice(1)}`,
    destination: cardDestination,
    count: operational.count,
    limited: operational.limited,
  });
}

function actionLabel(value) {
  return String(value).split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function safeTargetLabel(value) {
  const parts = String(value ?? "").split("/").filter(Boolean);
  const leaf = parts.at(-1) === "SKILL.md" ? parts.at(-2) : parts.at(-1);
  if (!leaf) return "New skill";
  return leaf.replaceAll("-", " ").replaceAll("_", " ");
}

export function validateApprovedSkillFolderInput(value, existing = []) {
  const candidate = typeof value === "string" ? value : "";
  if (!candidate || candidate !== candidate.trim() || /[\r\n\u0000]/u.test(candidate)) {
    return deepFreeze({ ok: false, value: null, error: "Enter one folder path without surrounding whitespace." });
  }
  if (candidate.length > 4096 || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) {
    return deepFreeze({ ok: false, value: null, error: "Use one canonical absolute folder path." });
  }
  if (!Array.isArray(existing) || existing.length > 32) {
    return deepFreeze({ ok: false, value: null, error: "The current folder list is invalid." });
  }
  if (existing.includes(candidate)) {
    return deepFreeze({ ok: false, value: null, error: "That approved skill folder is already listed." });
  }
  if (existing.length >= 32) {
    return deepFreeze({ ok: false, value: null, error: "At most 32 approved skill folders are supported." });
  }
  return deepFreeze({
    ok: true,
    value: candidate,
    error: null,
    warning: "The server will revalidate existence, canonical identity, symlinks, and supported-root policy before saving.",
  });
}

function safeActivityRow(entry, reviews) {
  const recommendationIndex = entry.proposalId === null
    ? -1
    : reviews.findIndex((review) => review.state !== "critic-pending"
      && review.proposalId === entry.proposalId);
  const target = recommendationIndex >= 0 ? safeTargetLabel(reviews[recommendationIndex].target) : null;
  const marker = ERROR_OUTCOMES.has(entry.outcome)
    ? "Error"
    : APPLIED_OUTCOMES.has(entry.outcome) || entry.outcome === "rolled-back"
      ? "Done"
      : ["deferred", "recommendation-snoozed", "paused"].includes(entry.outcome)
        ? "Waiting"
        : "Info";
  return {
    scope: "Current project",
    category: entry.category,
    audience: entry.audience,
    outcome: entry.outcome,
    marker,
    summary: entry.summary,
    target,
    occurredAt: entry.occurredAt,
    technical: {
      category: entry.category,
      outcome: entry.outcome,
      reason: entry.reason,
    },
    destination: recommendationIndex >= 0
      ? destination("recommendations", { selectedIndex: recommendationIndex })
      : ERROR_OUTCOMES.has(entry.outcome)
        ? destination("activity", { filter: "errors" })
        : null,
  };
}

function globalActivityRows(snapshot) {
  const projection = globalProjectionFor(snapshot);
  if (!projection?.index) return [];
  const reviews = projection.index.recommendations;
  const reviewById = new Map(reviews.map((review, index) => [review.recommendationId, { review, index }]));
  const rows = [];
  for (const entry of snapshot?.global?.pending ?? []) {
    const matched = reviewById.get(entry.subject);
    rows.push({
      scope: "Global",
      category: "recommendation",
      audience: "default",
      outcome: "pending",
      marker: "Waiting",
      summary: `${actionLabel(entry.action)} is pending fresh global validation.`,
      target: matched?.review.target.label.replaceAll("-", " ") ?? null,
      occurredAt: entry.submittedAt,
      technical: { category: "global-operation", outcome: "pending", reason: null },
      destination: matched ? destination("recommendations", { selectedIndex: matched.index }) : null,
    });
  }
  for (const entry of snapshot?.global?.responses ?? []) {
    const matched = reviewById.get(entry.subject);
    const ok = entry.response?.ok === true;
    const failureBinding = globalFailureAcknowledgementBinding(entry);
    rows.push({
      scope: "Global",
      category: ok ? "recommendation" : "error",
      audience: "default",
      outcome: ok ? `${entry.action}-accepted` : entry.response?.status ?? "failed",
      marker: ok ? "Done" : "Error",
      summary: ok
        ? `${actionLabel(entry.action)} was accepted for the global recommendation.`
        : `${actionLabel(entry.action)} did not complete: ${boundedDisplayText(entry.response?.reason ?? "unknown", 160)}.`,
      target: matched?.review.target.label.replaceAll("-", " ") ?? null,
      occurredAt: entry.response?.processedAt ?? entry.expiresAt,
      technical: {
        category: "global-operation",
        outcome: ok ? "accepted" : entry.response?.status ?? "failed",
        reason: entry.response?.reason ?? null,
      },
      destination: matched ? destination("recommendations", { selectedIndex: matched.index }) : null,
      acknowledgementRequestId: failureBinding && !acknowledgementMatches(snapshot, failureBinding)
        ? entry.requestId
        : null,
    });
  }
  for (const [index, review] of reviews.entries()) {
    if (!["applied", "rejected", "rolled-back", "failed-closed"].includes(review.state)) continue;
    rows.push({
      scope: "Global",
      category: review.state === "failed-closed" ? "error" : "recommendation",
      audience: "default",
      outcome: review.state,
      marker: review.state === "failed-closed" ? "Error" : "Done",
      summary: `Global recommendation is ${review.state.replaceAll("-", " ")}.`,
      target: review.target.label.replaceAll("-", " "),
      occurredAt: review.dates.updatedAt,
      technical: { category: "global-recommendation", outcome: review.state, reason: null },
      destination: destination("recommendations", { selectedIndex: index }),
    });
  }
  return rows.sort((left, right) => right.occurredAt - left.occurredAt);
}

function emptyHomeState(snapshot, operational, dashboard) {
  if (operational.state === "limited") {
    return { heading: "Limited view", explanation: operational.explanation };
  }
  if (operational.state === "off") {
    return { heading: "Automatic recommendations are off", explanation: "Existing recommendations remain available; no new automatic cycle will start." };
  }
  if (operational.state === "excluded") {
    return { heading: "Disabled for this project", explanation: "Global settings are unchanged; this project is excluded." };
  }
  if (dashboard?.lastCycle?.outcome === "valid-no-change") {
    return { heading: "No useful change found", explanation: "The last analysis completed successfully and found no safe improvement worth proposing." };
  }
  if (dashboard?.lastCycle?.outcome === "not-eligible") {
    return { heading: "Still learning", explanation: "Saved structured patterns are not yet strong or independent enough for a recommendation." };
  }
  if (!dashboard?.activity?.length) {
    return { heading: "No activity yet", explanation: "Self-evolve has not completed a retained cycle for this project." };
  }
  return null;
}

export function buildHomeModel(snapshot) {
  const dashboard = dashboardFor(snapshot);
  const index = snapshot?.projection?.index;
  const operational = deriveOperationalView(snapshot);
  const reviews = reviewsFor(snapshot);
  const settings = dashboard?.settings;
  const recentActivity = (dashboard?.activity ?? [])
    .filter((entry) => entry.audience !== "diagnostic")
    .slice(0, 3)
    .map((entry) => safeActivityRow(entry, reviews));
  return deepFreeze({
    phase: snapshot?.phase ?? "unavailable",
    operational,
    automaticRecommendationsEnabled: settings?.automaticRecommendationsEnabled
      ?? index?.status?.automaticRecommendationsEnabled
      ?? null,
    blockers: (dashboard?.blockers ?? []).map((blocker) => ({
      code: blocker.code,
      summary: blocker.summary,
      destination: blockerDestination(blocker),
    })),
    inFlight: dashboard?.inFlight ?? null,
    lastCycle: dashboard?.lastCycle ? {
      outcome: dashboard.lastCycle.outcome,
      triggerClass: dashboard.lastCycle.triggerClass,
      observationCount: dashboard.lastCycle.observationCount,
      eligibilityCount: dashboard.lastCycle.eligibilityCount,
      occurredAt: dashboard.lastCycle.occurredAt,
      reason: dashboard.lastCycle.reason,
    } : null,
    attention: ["recommendation", "applied"].includes(operational.state)
      ? { kind: operational.state, count: operational.count, destination: operational.destination }
      : null,
    usage: dashboard?.usage ?? null,
    recentActivity,
    emptyState: emptyHomeState(snapshot, operational, dashboard),
    limited: !dashboard,
    enhancedError: dashboardErrorFor(snapshot),
    globalReadiness: snapshot?.global ? {
      state: snapshot.global.phase,
      label: snapshot.global.projection?.label ?? "global-server-offer-unavailable",
      reason: snapshot.global.error ?? snapshot.global.projection?.reason ?? null,
      recommendationCount: snapshot.global.projection?.index?.recommendations?.length ?? null,
      stale: snapshot.global.stale === true,
    } : null,
  });
}

function recommendationFilterMatch(review, filter) {
  if (review.state === "critic-pending") return false;
  if (filter === "all") return true;
  if (filter === "applied") return review.state === "applied" || review.state === "rolled-back";
  if (filter === "dismissed") return ["rejected", "superseded"].includes(review.state);
  return REVIEW_ATTENTION_STATES.has(review.state);
}

export function buildRecommendationsModel(snapshot, {
  filter = "needs-review",
  selectedIndex = 0,
} = {}) {
  if (!["needs-review", "applied", "dismissed", "all"].includes(filter)) filter = "needs-review";
  if (usesGlobalRecommendations(snapshot)) {
    const projection = globalProjectionFor(snapshot);
    const reviews = projection.index.recommendations;
    const details = new Map(projection.details.map((detail) => [detail.recommendationId, detail]));
    const pending = snapshot?.global?.pending ?? [];
    const responses = snapshot?.global?.responses ?? [];
    const projectAuthority = hasCurrentActingProjectAuthority(snapshot);
    const globalAuthority = hasCurrentGlobalAuthority(snapshot?.global);
    const queue = reviews
      .map((review, sourceIndex) => ({ review, sourceIndex }))
      .filter(({ review }) => recommendationFilterMatch(review, filter))
      .map(({ review, sourceIndex }) => {
        const detail = details.get(review.recommendationId);
        const acknowledgement = globalAcknowledgementBinding(review, detail);
        return {
          sourceIndex,
          state: review.state,
          target: review.target.label.replaceAll("-", " "),
          targetKind: review.target.kind,
          attention: review.state === "failed-closed" ? "critical" : review.state === "pending" ? "warning" : "normal",
          updatedAt: review.dates.updatedAt,
          rationale: detail?.rationale ?? "Authoritative global detail is not resident yet.",
          risk: review.safety.criticPassed && review.safety.validDeterministic ? "Low" : "Review required",
          evidenceCount: review.support.occurrenceCount,
          supportTier: review.support.tier,
          currentProjectContributed: snapshot.participation?.[review.recommendationId] ?? null,
          acknowledged: acknowledgementMatches(snapshot, acknowledgement),
          loading: !detail,
        };
      });
    const normalizedSelected = queue.length
      ? Math.max(0, queue.findIndex((item) => item.sourceIndex === selectedIndex))
      : -1;
    const selected = normalizedSelected >= 0 ? queue[normalizedSelected] : null;
    const sourceReview = selected ? reviews[selected.sourceIndex] : null;
    const detail = sourceReview ? details.get(sourceReview.recommendationId) ?? null : null;
    const grants = sourceReview && detail && projectAuthority && globalAuthority
      ? projection.grants.filter((grant) => grant.recommendationId === sourceReview.recommendationId
        && detail.availableActions.includes(grant.action))
      : [];
    const acknowledgement = globalAcknowledgementBinding(sourceReview, detail);
    const actions = [...grants.map((grant) => ({
      action: grant.action,
      label: actionLabel(grant.action),
      pending: pending.some((entry) => pendingMatches(entry, grant.action, grant.recommendationId)),
      feedbackSupported: false,
    })), ...(acknowledgement && !acknowledgementMatches(snapshot, acknowledgement) ? [{
      action: "acknowledge-audit",
      label: "Acknowledge",
      pending: false,
      feedbackSupported: false,
    }] : [])];
    const recommendationResponses = sourceReview
      ? responses.filter((entry) => entry.subject === sourceReview.recommendationId)
      : [];
    return deepFreeze({
      phase: snapshot?.global?.phase ?? "unavailable",
      protocolLabel: projection.label,
      filter,
      filters: ["needs-review", "applied", "dismissed", "all"],
      rejectionFeedbackOptions: REJECTION_FEEDBACK_OPTIONS,
      queue,
      selectedIndex: normalizedSelected,
      selected: selected ? {
        ...selected,
        summary: detail ? {
          rationale: detail.rationale,
          state: detail.priorState,
          target: detail.target.label.replaceAll("-", " "),
          targetKind: detail.target.kind,
          support: detail.support,
          dates: {
            synthesizedAt: sourceReview.dates.synthesizedAt,
            updatedAt: sourceReview.dates.updatedAt,
            firstSeenDay: detail.support.firstSeenDay,
            lastSeenDay: detail.support.lastSeenDay,
          },
          currentProjectContributed: snapshot.participation?.[sourceReview.recommendationId] ?? null,
          criticScoreBasisPoints: detail.safety.criticScoreBasisPoints,
          criticPassed: detail.safety.criticPassed,
          validDeterministic: detail.safety.validDeterministic,
          generality: {
            available: true,
            passed: detail.generality.passed,
            basis: detail.generality.basis,
            status: detail.generality.passed ? "Passed" : "Not passed",
            explanation: "Passed the deterministic generality gate.",
          },
          tokenImpact: {
            available: false,
            explanation: "The current global projection does not expose a bounded token estimate.",
          },
          rollback: {
            eligible: detail.availableActions.includes("undo"),
            reason: detail.availableActions.includes("undo") ? null : "not-currently-granted",
          },
        } : null,
        diff: detail?.diff ?? null,
        evidence: detail?.evidenceSummary.map((entry) => ({
          kind: entry.kind,
          summary: `${entry.count} ${entry.kind.replaceAll("-", " ")}`,
          occurredAt: sourceReview.dates.updatedAt,
          redacted: false,
        })) ?? [],
        audit: recommendationResponses.map((entry) => ({
          kind: entry.action,
          summary: entry.response?.ok === true
            ? `${actionLabel(entry.action)} accepted by the server.`
            : `${actionLabel(entry.action)} did not complete: ${boundedDisplayText(entry.response?.reason ?? "unknown", 160)}`,
          timestamp: entry.response?.processedAt ?? entry.expiresAt,
        })),
        actions,
      } : null,
      emptyState: queue.length
        ? null
        : filter === "needs-review" ? "Nothing needs review"
          : filter === "applied" ? "Nothing applied"
            : filter === "dismissed" ? "Nothing dismissed" : "No recommendations yet",
      limited: snapshot?.global?.phase !== "ready",
      enhancedError: snapshot?.global?.error ?? null,
    });
  }
  const projection = snapshot?.projection;
  const native = hasCurrentNativeAuthority(snapshot)
    && (!snapshot?.global || hasCurrentGlobalAuthority(snapshot.global));
  const reviews = projection?.index?.reviews ?? [];
  const dashboard = dashboardFor(snapshot);
  const queue = reviews
    .map((review, sourceIndex) => ({ review, sourceIndex }))
    .filter(({ review }) => recommendationFilterMatch(review, filter))
    .map(({ review, sourceIndex }) => {
      const detail = (projection?.details ?? []).find((item) => item.proposalId === review.proposalId);
      const acknowledgement = projectAcknowledgementBinding(review, detail, dashboard);
      return {
        sourceIndex,
        state: review.state,
        target: safeTargetLabel(review.target),
        attention: review.attention,
        updatedAt: review.updatedAt,
        rationale: detail?.summary?.rationale ?? "Enhanced recommendation detail is not loaded.",
        risk: detail?.summary?.risk ?? null,
        evidenceCount: detail?.evidence?.length ?? null,
        acknowledged: acknowledgementMatches(snapshot, acknowledgement),
        loading: !detail,
      };
    });
  const normalizedSelected = queue.length
    ? Math.max(0, queue.findIndex((item) => item.sourceIndex === selectedIndex))
    : -1;
  const selected = normalizedSelected >= 0 ? queue[normalizedSelected] : null;
  const sourceReview = selected ? reviews[selected.sourceIndex] : null;
  const detail = sourceReview
    ? (projection?.details ?? []).find((item) => item.proposalId === sourceReview.proposalId) ?? null
    : null;
  const actions = sourceReview && sourceReview.state !== "failed-closed" && native
    ? (projection?.effectiveDetailActions?.[sourceReview.proposalId] ?? []).map((action) => ({
      action: action.action,
      label: actionLabel(action.action),
      pending: (snapshot?.pending ?? []).some((entry) => pendingMatches(entry, action.action, sourceReview.proposalId)),
      ...(action.action === "reject-proposal" ? {
        feedbackSupported: dashboard?.capabilities?.includes("decision-feedback-v1") === true,
      } : {}),
    }))
    : [];
  return deepFreeze({
    phase: snapshot?.phase ?? "unavailable",
    filter,
    filters: ["needs-review", "applied", "dismissed", "all"],
    rejectionFeedbackOptions: REJECTION_FEEDBACK_OPTIONS,
    queue,
    selectedIndex: normalizedSelected,
    selected: selected ? {
      ...selected,
      summary: detail ? {
        rationale: detail.summary.rationale,
        state: detail.summary.state,
        target: safeTargetLabel(detail.summary.target.relativePath),
        risk: detail.summary.risk,
        criticPassed: detail.summary.criticPassed,
        validDeterministic: detail.summary.validDeterministic,
        injectionFlagged: detail.summary.injectionFlagged,
        tokenImpact: {
          available: true,
          ...detail.summary.tokenImpact,
        },
        generality: {
          available: false,
          status: "Unavailable",
          explanation: "The current project projection does not expose a separate generality result. Deterministic validation is reported separately.",
        },
        eligibility: detail.summary.eligibility,
        rollback: {
          eligible: detail.summary.rollback.eligible,
          reason: detail.summary.rollback.reason,
        },
        operation: {
          status: detail.summary.operation.status,
          reason: detail.summary.operation.reason,
          updatedAt: detail.summary.operation.updatedAt,
        },
      } : null,
      diff: detail?.diff ?? null,
      evidence: detail?.evidence?.map((entry) => ({
        kind: entry.kind,
        summary: entry.summary,
        occurredAt: entry.occurredAt,
        redacted: entry.redacted,
      })) ?? [],
      audit: detail?.audit?.map((entry) => ({
        kind: entry.kind,
        summary: entry.summary,
        timestamp: entry.timestamp,
      })) ?? [],
      actions,
    } : null,
    emptyState: queue.length
      ? null
      : filter === "needs-review"
        ? "Nothing needs review"
        : filter === "applied"
          ? "Nothing applied"
          : filter === "dismissed"
            ? "Nothing dismissed"
            : "No recommendations yet",
    limited: !dashboard,
    enhancedError: dashboardErrorFor(snapshot),
  });
}

function activityFilterMatch(entry, filter) {
  if (filter === "errors") return entry.category === "error" || ERROR_OUTCOMES.has(entry.outcome);
  if (filter === "recommendations") {
    return entry.category === "recommendation"
      || ["recommendation-created", "applied", "rolled-back"].includes(entry.outcome);
  }
  if (filter === "system") return entry.category === "system" || entry.category === "cycle";
  return entry.audience !== "diagnostic";
}

export function buildActivityModel(snapshot, { filter = "all" } = {}) {
  if (!ACTIVITY_FILTERS.includes(filter)) filter = "all";
  const dashboard = dashboardFor(snapshot);
  const reviews = reviewsFor(snapshot);
  const status = snapshot?.projection?.index?.status;
  const lastProjectedError = (dashboard?.activity ?? [])
    .find((entry) => entry.category === "error" || ERROR_OUTCOMES.has(entry.outcome));
  const projectActivity = (dashboard?.activity ?? [])
    .filter((entry) => activityFilterMatch(entry, filter))
    .map((entry) => safeActivityRow(entry, reviews));
  const activity = [...globalActivityRows(snapshot).filter((entry) => activityFilterMatch(entry, filter)), ...projectActivity]
    .sort((left, right) => right.occurredAt - left.occurredAt);
  const providerUsage = dashboard?.usage?.provider ?? dashboard?.usage?.passive ?? null;
  return deepFreeze({
    phase: snapshot?.phase ?? "unavailable",
    filter,
    filters: ["all", "recommendations", "system", "errors"],
    activity,
    overflow: dashboard?.overflow?.activity ?? null,
    diagnostics: {
      refreshedAt: snapshot?.updatedAt ?? null,
      coreProjection: snapshot?.projection?.index ? "available" : "unavailable",
      enhancedProjection: dashboard ? "available" : dashboardErrorFor(snapshot) ? "invalid" : "unavailable",
      globalProjection: snapshot?.global?.phase ?? "unavailable",
      globalProtocolLabel: snapshot?.global?.projection?.label ?? null,
      runtime: snapshot?.runtime ?? {
        hostVersion: "unknown",
        hostVersionSource: "Unavailable",
        pluginVersion: "unknown",
        projectionVersion: snapshot?.projection?.index?.projectionVersion ?? null,
        dashboardVersion: dashboard?.dashboardVersion ?? null,
        projectionMode: snapshot?.projection?.mode ?? null,
      },
      watcher: snapshot?.watcher ?? "unavailable",
      watcherStatus: WATCHER_STATUS[snapshot?.watcher] ?? "Unavailable",
      automation: dashboard?.automation ?? null,
      breakerStatus: BREAKER_STATUS[String(status?.circuitBreakerOpen)] ?? "Unavailable",
      inFlight: dashboard?.inFlight ?? null,
      nextEligibleAt: dashboard?.nextEligibleAt ?? null,
      backoffUntil: dashboard?.automation?.state === "backoff"
        ? dashboard.nextEligibleAt
        : null,
      usage: dashboard?.usage ?? null,
      budgetResetAt: dashboard?.usage ? {
        provider: providerUsage?.resetAt ?? null,
        synthesis: dashboard.usage.synthesis?.resetAt ?? null,
      } : null,
      lastError: lastProjectedError ? safeActivityRow(lastProjectedError, reviews) : null,
    },
    overflowMessage: dashboard?.overflow?.activity?.truncated
      ? `${dashboard.overflow.activity.omittedCount} older entr${dashboard.overflow.activity.omittedCount === 1 ? "y was" : "ies were"} omitted by the bounded projection. Use Sensitive export in Settings for complete classified records.`
      : null,
    emptyState: activityEmptyState(dashboard, activity, filter, dashboardErrorFor(snapshot)),
    limited: !dashboard,
    enhancedError: dashboardErrorFor(snapshot) ? "Enhanced activity could not be validated." : null,
  });
}

export function buildSettingsModel(snapshot) {
  const dashboard = dashboardFor(snapshot);
  const index = snapshot?.projection?.index;
  const status = index?.status;
  const settings = dashboard?.settings;
  const consent = settings?.consent ?? null;
  const supportedControls = dashboard?.supportedControls ?? [];
  const globalRootPolicy = settings?.globalRootPolicy ?? null;
  const approvedSkillFolders = globalRootPolicy?.roots?.map((root) => root.canonicalPath) ?? [];
  const collectionSuggestions = globalRootPolicy ? [] : settings?.collectionSuggestions ?? [];
  const usage = dashboard?.usage ?? null;
  const providerUsage = usage?.provider ?? usage?.passive ?? null;
  const budgets = index?.budgets ?? null;
  const inspection = snapshot?.inspection;
  const observationCount = Array.isArray(inspection?.observations)
    ? inspection.observations.length + (inspection?.overflow?.observations ?? 0)
    : null;
  const globalAligned = !snapshot?.global || hasCurrentGlobalAuthority(snapshot.global);
  const native = hasCurrentNativeAuthority(snapshot) && globalAligned;
  const effectiveActions = native ? (snapshot?.projection?.effectiveIndexActions ?? []) : [];
  const granted = new Set(effectiveActions.map((action) => action.action));
  return deepFreeze({
    phase: snapshot?.phase ?? "unavailable",
    automaticRecommendations: {
      enabled: settings?.automaticRecommendationsEnabled
        ?? status?.automaticRecommendationsEnabled
        ?? null,
      generation: settings?.automationGeneration ?? null,
      description: settings?.automaticRecommendationsEnabled
        ? "On enables Saved structured patterns, Sanitized evidence excerpts, and Cross-project learning together so Self-evolve can prepare recommendations automatically. Applying or undoing always requires an operator decision."
        : "Off stops all future automatic analysis. Unfinished work is superseded and is not backfilled after re-enable; existing recommendations and explicit Apply, Reject, and Undo actions remain available; retained data is not purged.",
    },
    controls: {
      automaticRecommendations: native && granted.has("set-automatic-recommendations"),
      consent: native && granted.has("set-permission"),
      projectInclusion: native && granted.has("set-repo-excluded"),
      approvedSkillFolders: native
        && dashboard?.capabilities?.includes("operation-global-root-policy-v1") === true
        && granted.has("replace-global-root-policy"),
      emergencyStop: granted.has("set-kill-switch"),
    },
    projectExcluded: settings?.repositoryExcluded ?? status?.repoExcluded ?? null,
    emergencyStop: settings?.killSwitchActive ?? status?.killSwitchActive ?? null,
    consent: consent ? [
      {
        key: "durableObservations",
        label: "Saved structured patterns",
        scope: "Global",
        enabled: consent.durableObservations,
        description: "Persists bounded structured patterns across sessions; transcripts are never stored.",
        dependency: "Required while automatic recommendations are On.",
        canEnable: true,
      },
      {
        key: "sanitizedExcerpts",
        label: "Sanitized evidence excerpts",
        scope: "Global",
        enabled: consent.sanitizedExcerpts,
        description: "Allows bounded redacted evidence text. Redaction reduces exposure but is not a secrecy guarantee.",
        dependency: "Required while automatic recommendations are On.",
        canEnable: true,
      },
      {
        key: "crossRepoAggregation",
        label: globalProjectionFor(snapshot)?.capabilities?.includes("project-participation-v1")
          ? "Cross-project learning"
          : "Cross-project learning (limited)",
        scope: "Global",
        enabled: consent.crossRepoAggregation,
        description: "Publishes identity-free bounded support so recurring patterns can qualify across independent projects.",
        dependency: "Required while automatic recommendations are On; the server still revalidates project participation and global authority.",
        canEnable: globalProjectionFor(snapshot)?.capabilities?.includes("project-participation-v1") === true,
      },
    ] : [],
    approvedSkillFolderCount: globalRootPolicy?.roots?.length ?? null,
    approvedSkillFolders,
    globalRoots: globalRootPolicy?.roots?.map((root) => ({
      canonicalPath: root.canonicalPath,
      canUpdate: root.canUpdate,
      canCreate: root.canCreate,
      primaryCreationRoot: globalRootPolicy.creationRootPath !== undefined
        ? root.canonicalPath === globalRootPolicy.creationRootPath
        : root.rootId === globalRootPolicy.creationRootId,
    })) ?? [],
    creationRootConfigured: globalRootPolicy !== null
      && (globalRootPolicy.creationRootPath !== undefined
        ? globalRootPolicy.creationRootPath !== null
        : globalRootPolicy.creationRootId !== null),
    globalRootPolicyConfirmation: settings?.globalRootPolicyConfirmation ?? null,
    collectionSuggestions,
    approvedSkillFolderRequiresNonEmpty: false,
    approvedSkillFolderWarning: globalRootPolicy
      ? "Changes replace the complete authoritative root policy after fresh canonical-path, symlink, project-root, and catalog validation."
      : "No authoritative global roots are configured. Add at least one exact canonical collection root; legacy suggestions below grant no write authority.",
    usage,
    retention: dashboard?.retention ?? null,
    rollout: dashboard?.rollout ?? null,
    blockers: dashboard?.blockers ?? [],
    supportedControls,
    limits: [
      {
        key: "provider",
        label: "Provider calls",
        actual: providerUsage ? `${providerUsage.used} used; ${providerUsage.remaining} remaining` : "Actual usage unavailable",
        configured: budgets ? `${budgets.passiveCallsPerHour} per rolling hour` : "Configured limit unavailable",
        resetAt: providerUsage?.resetAt ?? null,
        explanation: "Bounds automatic provider calls.",
      },
      {
        key: "synthesis",
        label: "Recommendation synthesis",
        actual: usage ? `${usage.synthesis.used} used; ${usage.synthesis.remaining} remaining` : "Actual usage unavailable",
        configured: budgets ? `${budgets.synthesisPerDay} per UTC day; ${budgets.tokensPerSynthesis} tokens each` : "Configured limit unavailable",
        resetAt: usage?.synthesis?.resetAt ?? null,
        explanation: "Bounds recommendation-generation attempts and input tokens.",
      },
      {
        key: "storage",
        label: "Durable storage",
        actual: usage ? `${usage.storage.usedBytes} bytes used; ${usage.storage.remainingBytes} bytes remaining` : "Actual usage unavailable",
        configured: budgets ? `${budgets.storageQuotaMiB} MiB quota` : "Configured limit unavailable",
        resetAt: null,
        explanation: "Covers project-partitioned Self-evolve records; sensitive exports use a separate private temporary quota.",
      },
      {
        key: "retention",
        label: "Retention",
        actual: observationCount === null
          ? "Retained observation count unavailable"
          : `${observationCount} retained observation${observationCount === 1 ? "" : "s"} in the bounded inspection`,
        configured: dashboard?.retention
          ? `${dashboard.retention.observationsDays} days for observations; ${dashboard.retention.operationalDays} days for operational records`
          : "Configured retention unavailable",
        resetAt: null,
        explanation: "Retention removes expired bounded records while preserving active proposal chains and required audit state.",
      },
      {
        key: "concurrency",
        label: "Concurrent work",
        actual: dashboard?.inFlight
          ? `${dashboard.inFlight.count} projected active job${dashboard.inFlight.count === 1 ? "" : "s"}`
          : "Actual concurrency unavailable",
        configured: budgets
          ? `${budgets.concurrentObservationsPerProject} observation job(s) per project; ${budgets.concurrentSynthesesGlobal} synthesis job(s) globally`
          : "Configured concurrency unavailable",
        resetAt: null,
        explanation: "Prevents overlapping work from bypassing project and global mutation safeguards.",
      },
      {
        key: "idle",
        label: "Safe-idle delay",
        actual: dashboard?.automation ? `Scheduler is ${dashboard.automation.state.replaceAll("-", " ")}` : "Scheduler status unavailable",
        configured: budgets ? `${budgets.idleDebounceMs} ms quiet period` : "Configured delay unavailable",
        resetAt: null,
        explanation: "Requires a stable idle window before automatic work is eligible.",
      },
    ],
    rolloutProgress: dashboard?.rollout ? {
      actual: `${dashboard.rollout.synthesesObserved} observed; ${(dashboard.rollout.successRateBasisPoints / 100).toFixed(2)}% successful`,
      configured: `${dashboard.rollout.minSynthesesObserved} required; ${(dashboard.rollout.minSuccessRateBasisPoints / 100).toFixed(2)}% minimum success`,
      ready: dashboard.rollout.ready,
    } : null,
    globalProtocol: snapshot?.global ? {
      state: snapshot.global.phase,
      label: snapshot.global.projection?.label ?? "global-server-offer-unavailable",
      reason: snapshot.global.error ?? snapshot.global.projection?.reason ?? null,
      authoritative: hasCurrentGlobalAuthority(snapshot.global),
    } : null,
    globalRootPolicy,
    maintenance: {
      scopes: [
        { value: "observations", label: "Observations", explanation: "Bounded structured patterns for this project." },
        { value: "global-recommendations", label: "Recommendations", explanation: "Global recommendation, support, decision, and rollback records." },
        { value: "project", label: "This project", explanation: "All Self-evolve state in this project partition." },
        { value: "all", label: "Everything", explanation: "All Self-evolve project partitions and authority. Restart is required." },
      ],
      canExport: granted.has("export-data"),
      canDeleteScope: granted.has("purge-scope"),
      canDeleteAll: granted.has("purge-all"),
    },
    latestExport: snapshot?.latestExport ? {
      scope: snapshot.latestExport.scope,
      path: snapshot.latestExport.path,
      bytes: snapshot.latestExport.bytes,
      sha256: snapshot.latestExport.sha256,
      expiresAt: snapshot.latestExport.expiresAt,
    } : null,
    footer: {
      hostVersion: snapshot?.runtime?.hostVersion ?? "unknown",
      pluginVersion: snapshot?.runtime?.pluginVersion ?? "unknown",
      projectionVersion: snapshot?.runtime?.projectionVersion ?? null,
      dashboardVersion: snapshot?.runtime?.dashboardVersion ?? null,
      help: "Use Home for current state, Recommendations for decisions, Activity for waiting or failures, and Settings for automation controls.",
    },
    limited: !dashboard,
    enhancedError: dashboardErrorFor(snapshot) ? "Enhanced settings could not be validated." : null,
  });
}

export function deriveSidebarModeControl(snapshot) {
  const settings = buildSettingsModel(snapshot);
  const pending = (snapshot?.pending ?? []).some((entry) =>
    entry.action === "set-automatic-recommendations" && entry.subject === "automatic-recommendations");
  const current = settings.automaticRecommendations.enabled === true ? "on" : "off";
  const available = snapshot?.phase === "ready"
    && settings.controls.automaticRecommendations
    && settings.globalProtocol?.authoritative !== false
    && !pending;
  return deepFreeze({
    current,
    pending,
    available,
    status: pending ? "pending"
      : snapshot?.phase === "initializing" ? "starting"
        : snapshot?.phase === "error" ? "stale"
          : settings.globalProtocol?.authoritative === false ? "limited"
            : settings.controls.automaticRecommendations ? "ready" : "unsupported",
    options: Object.freeze([
      Object.freeze({ value: "off", label: "Off", confirmationRequired: false }),
      Object.freeze({ value: "on", label: "On", confirmationRequired: true }),
    ]),
  });
}

export const CONTROL_CENTER_SECTIONS = Object.freeze([
  "home", "recommendations", "activity", "settings",
]);
export const ACTIVITY_FILTERS = Object.freeze([
  "all", "recommendations", "system", "errors",
]);
export const SETTINGS_ANCHORS = UI_CONTROL_CENTER_SETTINGS_ANCHORS;

export function parseControlCenterDestination(params, snapshot) {
  if (params === undefined || params === null) return deepFreeze({ section: "home" });
  if (!params || typeof params !== "object" || Array.isArray(params)) return deepFreeze({ section: "home" });
  const allowedKeys = new Set(["section", "recommendation", "activityFilter", "settingsAnchor"]);
  if (Object.keys(params).some((key) => !allowedKeys.has(key))) return deepFreeze({ section: "home" });
  if (!CONTROL_CENTER_SECTIONS.includes(params.section)) return deepFreeze({ section: "home" });
  const result = { section: params.section };
  if (params.section === "recommendations" && params.recommendation !== undefined) {
    if (typeof params.recommendation !== "string") return deepFreeze({ section: "home" });
    const reviews = reviewsFor(snapshot);
    const selectedIndex = reviews.findIndex((review) => review.state !== "critic-pending"
      && review.proposalId === params.recommendation);
    if (selectedIndex < 0) return deepFreeze({ section: "home" });
    result.selectedIndex = selectedIndex;
  } else if (params.recommendation !== undefined) return deepFreeze({ section: "home" });
  if (params.section === "activity" && params.activityFilter !== undefined) {
    if (!ACTIVITY_FILTERS.includes(params.activityFilter)) return deepFreeze({ section: "home" });
    result.filter = params.activityFilter;
  } else if (params.activityFilter !== undefined) return deepFreeze({ section: "home" });
  if (params.section === "settings" && params.settingsAnchor !== undefined) {
    if (!SETTINGS_ANCHORS.includes(params.settingsAnchor)) return deepFreeze({ section: "home" });
    result.anchor = params.settingsAnchor;
  } else if (params.settingsAnchor !== undefined) return deepFreeze({ section: "home" });
  return deepFreeze(result);
}

export function controlCenterRouteParams(value, snapshot) {
  const section = CONTROL_CENTER_SECTIONS.includes(value?.section) ? value.section : "home";
  if (section === "recommendations") {
    const reviews = reviewsFor(snapshot);
    const selectedIndex = Number.isSafeInteger(value?.selectedIndex) ? value.selectedIndex : 0;
    const review = reviews[selectedIndex];
    const recommendation = review?.state === "critic-pending" ? null : review?.proposalId;
    return deepFreeze(recommendation ? { section, recommendation } : { section });
  }
  if (section === "activity") {
    const activityFilter = ACTIVITY_FILTERS.includes(value?.filter) ? value.filter : "all";
    return deepFreeze({ section, activityFilter });
  }
  if (section === "settings") {
    const settingsAnchor = SETTINGS_ANCHORS.includes(value?.anchor) ? value.anchor : undefined;
    return deepFreeze(settingsAnchor ? { section, settingsAnchor } : { section });
  }
  return deepFreeze({ section: "home" });
}

export function buildControlCenterModel(snapshot, options = {}) {
  return deepFreeze({
    phase: snapshot?.phase ?? "unavailable",
    recovery: snapshot?.phase === "error" ? {
      stale: snapshot?.stale === true,
      diagnostic: boundedDisplayText(snapshot?.error ?? "projection-refresh-failed", 240),
      canRetry: true,
    } : null,
    health: degradedHealthView(snapshot),
    operational: deriveOperationalView(snapshot),
    sections: {
      home: buildHomeModel(snapshot),
      recommendations: buildRecommendationsModel(snapshot, {
        filter: options.recommendationFilter,
        selectedIndex: options.selectedIndex,
      }),
      activity: buildActivityModel(snapshot, { filter: options.activityFilter }),
      settings: buildSettingsModel(snapshot),
    },
  });
}

// Degraded-health banner input: the worse of the project and global runtimes'
// circuit-breaker states, or null when neither breaker is open.
function degradedHealthView(snapshot) {
  const candidates = [snapshot?.health, snapshot?.global?.health].filter((health) => health?.degraded);
  if (!candidates.length) return null;
  const worst = candidates.sort((left, right) => (right.consecutiveFailures ?? 0) - (left.consecutiveFailures ?? 0))[0];
  return {
    degraded: true,
    reason: boundedDisplayText(worst.reason ?? "refresh-degraded", 240),
    consecutiveFailures: worst.consecutiveFailures ?? 0,
    nextRetryAt: worst.nextRetryAt ?? null,
  };
}

class ProjectRuntime {
  constructor(context, dependencies) {
    this.context = context;
    this.registryKey = context.key;
    this.owners = new Set();
    this.client = dependencies.clientFactory?.(context) ?? defaultClient(context, dependencies.now);
    this.watch = dependencies.watch;
    this.setInterval = dependencies.setInterval;
    this.clearInterval = dependencies.clearInterval;
    this.queueMicrotask = dependencies.queueMicrotask;
    this.now = dependencies.now;
    this.acknowledgements = dependencies.acknowledgements;
    this.runtimeMetadata = dependencies.runtimeMetadata;
    this.acknowledgedOutcomes = Object.freeze(
      this.acknowledgements?.read?.(context.projectFingerprint) ?? [],
    );
    this.pollMs = dependencies.pollMs;
    this.serverResponseMs = dependencies.serverResponseMs;
    this.pending = new Map();
    this.pendingReservations = new Set();
    this.responses = [];
    this.detailProposalIds = Object.freeze([]);
    this.refreshQueued = false;
    this.refreshScheduled = false;
    this.refreshInFlight = false;
    this.refreshWaiters = [];
    this.disposed = false;
    this.terminal = false;
    this.epoch = 1;
    this.watcher = null;
    this.watcherError = null;
    this.readCount = 0;
    this.consecutiveFailures = 0;
    this.lastFailureReason = null;
    this.breakerNextRetryAt = 0;
    this.snapshot = this.makeSnapshot({
      phase: "initializing",
      projection: null,
      participation: null,
      latestExport: null,
      inspection: null,
      error: null,
    });
    this.pollTimer = null;
    if (terminalStateRoots.has(context.stateRootIdentity)) this.terminalize();
    else {
      this.armWatcher();
      this.pollTimer = this.setInterval(() => this.poll(), this.pollMs);
      this.pollTimer?.unref?.();
    }
  }

  makeSnapshot({
    phase,
    projection,
    participation = this.snapshot?.participation ?? null,
    latestExport = this.snapshot?.latestExport ?? null,
    inspection = this.snapshot?.inspection ?? null,
    tuiHealth = this.snapshot?.tuiHealth ?? null,
    error,
  }) {
    const safeProjection = projectionWithoutFailedClosedAuthority(projection);
    return deepFreeze({
      phase,
      key: this.context.key,
      stateRootIdentity: this.context.stateRootIdentity,
      projectFingerprint: this.context.projectFingerprint,
      worktreePath: this.context.worktreePath,
      projection: safeProjection,
      participation,
      dashboard: safeProjection?.dashboard ?? null,
      dashboardError: safeProjection?.dashboardError ?? null,
      latestExport,
      inspection,
      tuiHealth,
      runtime: {
        ...this.runtimeMetadata,
        projectionVersion: safeProjection?.index?.projectionVersion ?? null,
        dashboardVersion: safeProjection?.dashboard?.dashboardVersion ?? null,
        projectionMode: safeProjection?.mode ?? null,
      },
      acknowledgedOutcomes: this.acknowledgedOutcomes,
      pending: [...this.pending.values()],
      responses: this.responses,
      watcher: this.watcher ? "active" : "polling",
      watcherError: this.watcherError,
      health: {
        degraded: this.consecutiveFailures >= BREAKER_OPEN_THRESHOLD,
        reason: this.lastFailureReason,
        consecutiveFailures: this.consecutiveFailures,
        nextRetryAt: this.breakerNextRetryAt || null,
      },
      revision: this.readCount,
      updatedAt: this.now(),
      error,
      stale: phase === "error" && projection !== null,
    });
  }

  attach(owner) {
    if (this.disposed) throw new Error("tui-store-runtime-disposed");
    this.owners.add(owner);
    if (this.terminal) {
      owner.receiveProject(this.snapshot);
      return;
    }
    owner.receiveProject(this.makeSnapshot({
      phase: "initializing",
      projection: null,
      participation: null,
      latestExport: null,
      inspection: null,
      error: null,
    }));
    this.requestRefresh("owner-attached");
  }

  detach(owner) {
    this.owners.delete(owner);
    // BH-8: a terminal runtime stays live for the owners still showing its
    // terminal snapshot, but once the last one detaches nothing can observe it
    // again and it must leave the registry. Terminality for later owners comes
    // from terminalStateRoots, not from this entry, so a fresh runtime for the
    // same state root still terminalizes itself on construction.
    if (this.owners.size === 0) this.dispose();
  }

  notify() {
    for (const owner of [...this.owners]) owner.receiveProject(this.snapshot);
  }

  armWatcher() {
    if (this.disposed || this.watcher) return;
    try {
      const watcher = this.watch(this.context.watchPath, { persistent: false }, (eventType) => {
        if (this.disposed) return;
        if (eventType === "rename") this.closeWatcher("watched-directory-replaced");
        // An open breaker also gates watcher-driven refreshes: an fs event storm
        // must not bypass the backed-off cadence and re-enter a failing refresh.
        if (this.breakerOpen()) return;
        this.requestRefresh(`watch:${eventType ?? "change"}`);
      });
      this.watcher = watcher;
      this.watcherError = null;
      watcher?.on?.("error", (error) => {
        if (this.disposed || watcher !== this.watcher) return;
        this.closeWatcher(errorReason(error));
        if (this.breakerOpen()) return;
        this.requestRefresh("watch:error");
      });
    } catch (error) {
      this.watcher = null;
      this.watcherError = errorReason(error);
    }
  }

  closeWatcher(reason = null) {
    const watcher = this.watcher;
    this.watcher = null;
    if (reason) this.watcherError = reason;
    try { watcher?.close?.(); } catch {}
  }

  poll() {
    if (this.disposed || this.terminal) return;
    for (const owner of [...this.owners]) owner.reconcileContext();
    if (this.disposed) return;
    this.armWatcher();
    this.requestRefresh("poll");
  }

  breakerOpen() {
    return this.consecutiveFailures >= BREAKER_OPEN_THRESHOLD;
  }

  rearmPollTimer(intervalMs) {
    if (this.disposed || this.terminal || !this.pollTimer) return;
    this.clearInterval(this.pollTimer);
    this.pollTimer = this.setInterval(() => this.poll(), intervalMs);
    this.pollTimer?.unref?.();
  }

  noteRefreshFailure() {
    this.consecutiveFailures += 1;
    if (!this.breakerOpen()) return;
    const step = this.consecutiveFailures - BREAKER_OPEN_THRESHOLD;
    const backoff = Math.min(this.pollMs * 2 ** (step + 1), BREAKER_MAX_INTERVAL_MS);
    const interval = Math.round(backoff * (1 + Math.random() * 0.25));
    this.breakerNextRetryAt = this.now() + interval;
    this.rearmPollTimer(interval);
  }

  noteRefreshSuccess() {
    if (this.consecutiveFailures === 0) return;
    this.consecutiveFailures = 0;
    this.lastFailureReason = null;
    this.breakerNextRetryAt = 0;
    this.rearmPollTimer(this.pollMs);
  }

  selectDetails(ids) {
    if (this.terminal) return Promise.resolve(this.snapshot);
    const clean = cleanDetailIds(ids);
    if (clean.join("\n") === this.detailProposalIds.join("\n")) return Promise.resolve(this.snapshot);
    this.detailProposalIds = clean;
    return this.requestRefresh("detail-selection");
  }

  acknowledgeBinding(binding) {
    if (this.disposed || this.terminal) return this.snapshot;
    this.acknowledgedOutcomes = Object.freeze(
      this.acknowledgements?.acknowledge?.(this.context.projectFingerprint, binding)
        ?? this.acknowledgedOutcomes,
    );
    this.snapshot = this.makeSnapshot({
      phase: this.snapshot.phase,
      projection: this.snapshot.projection,
      participation: this.snapshot.participation,
      latestExport: this.snapshot.latestExport,
      inspection: this.snapshot.inspection,
      error: this.snapshot.error,
    });
    this.notify();
    return this.snapshot;
  }

  async trackPending(value) {
    if (this.terminal) throw new Error("restart-required-after-purge-all");
    const clean = cleanPending(value);
    if (!this.pending.has(clean.requestId) && this.pending.size >= MAX_PENDING_RESPONSES) {
      throw new Error("pending-request-capacity-exhausted");
    }
    this.pending.set(clean.requestId, clean);
    this.snapshot = this.makeSnapshot({
      phase: this.snapshot.phase,
      projection: this.snapshot.projection,
      participation: this.snapshot.participation,
      latestExport: this.snapshot.latestExport,
      inspection: this.snapshot.inspection,
      error: this.snapshot.error,
    });
    this.notify();
    return this.requestRefresh("pending-request");
  }

  assertNotPending(action, subject) {
    const key = JSON.stringify([action, subject]);
    if (this.pendingReservations.has(key)
        || [...this.pending.values()].some((entry) => pendingMatches(entry, action, subject))) {
      throw new Error("matching-request-already-pending");
    }
  }

  reservePending(action, subject) {
    this.assertNotPending(action, subject);
    if (this.pending.size + this.pendingReservations.size >= MAX_PENDING_RESPONSES) {
      throw new Error("pending-request-capacity-exhausted");
    }
    const key = JSON.stringify([action, subject]);
    this.pendingReservations.add(key);
    return key;
  }

  releasePendingReservation(key) {
    this.pendingReservations.delete(key);
  }

  async submitDecision({ proposalId, newState, feedback }) {
    if (this.terminal) throw new Error("restart-required-after-purge-all");
    await this.requestRefresh("decision-preflight");
    if (!hasCurrentNativeAuthority(this.snapshot)) {
      throw new Error("native-operation-protocol-unavailable");
    }
    const authoritySnapshot = this.snapshot;
    const uiAction = newState === "approved" ? "apply-proposal" : "reject-proposal";
    this.assertNotPending(uiAction, proposalId);
    if (feedback !== undefined
        && (newState !== "rejected"
          || !this.snapshot.dashboard?.capabilities?.includes("decision-feedback-v1"))) {
      throw new Error("decision-feedback-not-supported");
    }
    const advertised = this.snapshot.projection?.effectiveDetailActions?.[proposalId]
      ?.some((action) => action.action === uiAction);
    if (!advertised) throw new Error("decision-not-authorized-by-current-projection");
    const reservation = this.reservePending(uiAction, proposalId);
    try {
      const inbox = await this.client.readInbox();
      const proposal = inbox?.find?.((item) => item.id === proposalId);
      if (!proposal) throw new Error("proposal-not-found-or-not-authorized");
      this.assertAuthoritySnapshot(authoritySnapshot, uiAction, proposalId);
      const timestamp = this.now();
      const request = createDecisionRequest({
        projectFingerprint: this.context.projectFingerprint,
        proposal,
        newState,
        ...(feedback !== undefined ? { feedback } : {}),
        timestamp,
      });
      await this.client.submitDecision(request);
      await this.trackPending({
        requestId: request.requestId,
        kind: "decision",
        action: uiAction,
        subject: proposalId,
        submittedAt: timestamp,
        expiresAt: timestamp + BRIDGE_TTL_MS,
      });
      return request;
    } finally {
      this.releasePendingReservation(reservation);
    }
  }

  async submitControl() {
    if (this.terminal) throw new Error("restart-required-after-purge-all");
    throw new Error("retired-v04-control");
  }

  async submitOperation(action, payload = {}, { proposalId } = {}) {
    if (this.terminal) throw new Error("restart-required-after-purge-all");
    await this.requestRefresh("operation-preflight");
    const projection = this.snapshot.projection;
    if (!hasCurrentNativeAuthority(this.snapshot)) throw new Error("native-operation-protocol-unavailable");
    const authoritySnapshot = this.snapshot;
    const subject = operationSubject(action, payload, proposalId);
    this.assertNotPending(action, subject);
    if (!projection.index) throw new Error("operation-projection-unavailable");
    const detail = proposalId
      ? projection.details?.find((item) => item.proposalId === proposalId)
      : null;
    const effectiveActions = proposalId
      ? projection.effectiveDetailActions?.[proposalId] ?? []
      : projection.effectiveIndexActions ?? [];
    const grant = effectiveActions
      .find((item) => item.action === action);
    if (!grant) throw new Error("operation-not-authorized");
    const reservation = this.reservePending(action, subject);
    try {
      let wirePayload = payload;
      if (action === "snooze-proposal" || action === "rollback-proposal") {
        const inbox = await this.client.readInbox();
        const proposal = inbox?.find?.((item) => item.id === proposalId);
        if (!proposal) throw new Error("proposal-not-found-or-not-authorized");
        wirePayload = action === "snooze-proposal"
          ? {
            proposalId,
            targetHash: proposal.skillTarget.currentHash,
            proposedContentHash: proposal.proposedContentHash,
            decisionVersion: proposal.decisionVersion + 1,
            snoozedUntil: payload.snoozedUntil,
          }
          : {
            proposalId,
            appliedHash: detail?.summary?.rollback?.appliedHash,
            decisionVersion: proposal.decisionVersion + 1,
          };
      } else if ([
        "set-automatic-recommendations",
        "set-kill-switch",
        "set-permission",
        "set-repo-excluded",
      ].includes(action)) {
        const settingsVersion = this.snapshot.dashboard?.settings?.globalSettingsVersion;
        if (!settingsVersion) throw new Error("automation-settings-authority-unavailable");
        wirePayload = { ...payload, settingsVersion };
      } else if (action === "replace-global-root-policy") {
        const dashboardSettings = this.snapshot.dashboard?.settings;
        if (!dashboardSettings?.globalSettingsVersion || !dashboardSettings.globalRootPolicyConfirmation) {
          throw new Error("global-root-policy-authority-unavailable");
        }
        if (payload.confirmation !== dashboardSettings.globalRootPolicyConfirmation) {
          throw new Error("invalid-global-root-policy-confirmation");
        }
        wirePayload = {
          roots: payload.roots,
          creationRootPath: payload.creationRootPath,
          confirmation: payload.confirmation,
          settingsVersion: dashboardSettings.globalSettingsVersion,
        };
      }
      this.assertAuthoritySnapshot(authoritySnapshot, action, proposalId);
      const timestamp = this.now();
      const request = createUiOperationRequest({
        projection: projection.index,
        grant,
        action,
        payload: wirePayload,
        timestamp,
      });
      await this.client.submitOperation(request);
      await this.trackPending({
        requestId: request.requestId,
        kind: "operation",
        action,
        subject,
        submittedAt: timestamp,
        expiresAt: request.expiresAt,
        request,
      });
      return request;
    } finally {
      this.releasePendingReservation(reservation);
    }
  }

  assertAuthoritySnapshot(snapshot, action, proposalId) {
    if (this.disposed || this.snapshot !== snapshot || !hasCurrentNativeAuthority(this.snapshot)) {
      throw new Error("projection-authority-changed-before-submit");
    }
    if (!action) return;
    const effectiveActions = proposalId
      ? this.snapshot.projection.effectiveDetailActions?.[proposalId] ?? []
      : this.snapshot.projection.effectiveIndexActions ?? [];
    if (!effectiveActions.some((item) => item.action === action)) {
      throw new Error("projection-authority-changed-before-submit");
    }
  }

  requestRefresh() {
    if (this.disposed || this.terminal) return Promise.resolve(this.snapshot);
    const minimumReadCount = this.readCount + (this.refreshInFlight ? 2 : 1);
    this.refreshQueued = true;
    const completion = new Promise((resolve) => this.refreshWaiters.push({ minimumReadCount, resolve }));
    if (!this.refreshInFlight && !this.refreshScheduled) {
      this.refreshScheduled = true;
      this.queueMicrotask(() => void this.runRefresh());
    }
    return completion;
  }

  settleWaiters(force = false) {
    const settled = this.refreshWaiters.filter((waiter) => force || waiter.minimumReadCount <= this.readCount);
    this.refreshWaiters = this.refreshWaiters.filter((waiter) => !force && waiter.minimumReadCount > this.readCount);
    for (const waiter of settled) waiter.resolve(this.snapshot);
  }

  // CAUTION: this bound is inert for a synchronous `operation`. The timeout is
  // scheduled on the same event loop the operation runs on, so a client that
  // blocks synchronously (every default client method is sync) can never be
  // interrupted by it — the microtask drains before the timers phase. It only
  // protects against genuinely asynchronous clients that stall. Do not rely on
  // serverResponseMs to bound a synchronous call; keep sync client work short.
  async boundedServerCall(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("server-not-responding")), this.serverResponseMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async runRefresh() {
    this.refreshScheduled = false;
    if (this.disposed || this.refreshInFlight || !this.refreshQueued) return;
    this.refreshQueued = false;
    this.refreshInFlight = true;
    const lease = this.epoch;
    let pending = [...this.pending.values()];
    const reconciling = new Set(this.pending.keys());
    let responses = [];
    try {
      if (pending.length) {
        const reconciled = typeof this.client.reconcilePending === "function"
          ? await this.client.reconcilePending(pending, { context: this.context })
          : { pending, responses: [] };
        const reconciledPending = new Map(
          (Array.isArray(reconciled?.pending) ? reconciled.pending.map(cleanPending) : pending)
            .map((entry) => [entry.requestId, entry]),
        );
        const reconciledResponses = new Map(
          (Array.isArray(reconciled?.responses) ? reconciled.responses : [])
            .map((entry) => [entry.requestId, entry]),
        );
        const timestamp = this.now();
        const stillPending = [];
        for (const entry of pending) {
          const response = reconciledResponses.get(entry.requestId);
          const responseWasTimely = response && Number.isSafeInteger(response.response?.processedAt)
            && response.response.processedAt <= entry.expiresAt;
          if (response && (timestamp < entry.expiresAt || responseWasTimely)) {
            responses.push(response);
          } else if (timestamp >= entry.expiresAt) {
            responses.push(expiredPendingResponse(entry));
          } else {
            stillPending.push(reconciledPending.get(entry.requestId) ?? entry);
          }
        }
        pending = stillPending;
      }
      const terminalResponses = responses.filter((entry) => entry.kind === "operation"
        && entry.action === "purge-all"
        && entry.response?.ok === true
        && entry.response?.status === "accepted-terminal");
      if (terminalResponses.length) {
        terminalizeTuiStateRoot(this.context.stateRootIdentity, this, terminalResponses);
        return;
      }
      const [projection, latestExport, inspection, participation, tuiHealth] = await Promise.all([
        this.boundedServerCall(() => this.client.read({
          detailProposalIds: this.detailProposalIds,
          context: this.context,
        })),
        typeof this.client.readLatestExport === "function"
          ? this.boundedServerCall(() => this.client.readLatestExport()) : null,
        typeof this.client.readInspection === "function"
          ? this.boundedServerCall(() => this.client.readInspection()) : null,
        typeof this.client.readParticipation === "function"
          ? this.boundedServerCall(() => this.client.readParticipation()) : null,
        typeof this.client.readTuiHealth === "function"
          ? this.boundedServerCall(() => this.client.readTuiHealth()) : null,
      ]);
      if (this.disposed || lease !== this.epoch) return;
      this.acknowledgedOutcomes = Object.freeze(
        this.acknowledgements?.read?.(this.context.projectFingerprint) ?? [],
      );
      this.pending = mergePending(this.pending, pending, reconciling);
      this.responses = deepFreeze([...this.responses, ...responses].slice(-MAX_COMPLETED_RESPONSES));
      this.readCount += 1;
      this.noteRefreshSuccess();
      this.snapshot = this.makeSnapshot({
        phase: projection?.mode === "legacy" ? "legacy" : "ready",
        projection,
        participation,
        latestExport,
        inspection,
        tuiHealth,
        error: null,
      });
      this.notify();
    } catch (error) {
      if (this.disposed || lease !== this.epoch) return;
      this.pending = mergePending(this.pending, pending, reconciling);
      this.responses = deepFreeze([...this.responses, ...responses].slice(-MAX_COMPLETED_RESPONSES));
      this.readCount += 1;
      this.lastFailureReason = errorReason(error);
      this.noteRefreshFailure();
      this.snapshot = this.makeSnapshot({
        phase: "error",
        projection: projectionWithoutAuthority(this.snapshot.projection),
        participation: this.snapshot.participation,
        latestExport: this.snapshot.latestExport,
        inspection: this.snapshot.inspection,
        error: errorReason(error),
      });
      this.notify();
    } finally {
      if (!this.disposed && lease === this.epoch) {
        this.refreshInFlight = false;
        this.settleWaiters();
        if (this.refreshQueued && !this.refreshScheduled) {
          this.refreshScheduled = true;
          this.queueMicrotask(() => void this.runRefresh());
        }
      }
    }
  }

  terminalize(responses = []) {
    if (this.disposed || this.terminal) return;
    this.terminal = true;
    this.epoch += 1;
    this.refreshQueued = false;
    this.refreshScheduled = false;
    this.refreshInFlight = false;
    this.pending.clear();
    this.pendingReservations.clear();
    this.closeWatcher();
    this.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.responses = deepFreeze([...this.responses, ...responses].slice(-MAX_COMPLETED_RESPONSES));
    this.readCount += 1;
    this.snapshot = this.makeSnapshot({
      phase: "terminal",
      projection: projectionWithoutAuthority(this.snapshot.projection),
      participation: this.snapshot.participation,
      latestExport: this.snapshot.latestExport,
      inspection: this.snapshot.inspection,
      tuiHealth: null,
      error: "restart-required-after-purge-all",
    });
    this.notify();
    this.settleWaiters(true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.refreshQueued = false;
    this.refreshScheduled = false;
    this.pendingReservations.clear();
    this.closeWatcher();
    this.clearInterval(this.pollTimer);
    this.pollTimer = null;
    projectRuntimes.delete(this.registryKey);
    this.snapshot = this.makeSnapshot({
      phase: "disposed",
      projection: this.snapshot.projection,
      participation: this.snapshot.participation,
      latestExport: this.snapshot.latestExport,
      inspection: this.snapshot.inspection,
      error: null,
    });
    this.settleWaiters(true);
  }
}

class GlobalRuntime {
  constructor(context, dependencies) {
    this.context = context;
    this.registryKey = context.globalKey;
    this.owners = new Set();
    this.client = dependencies.globalClientFactory?.(context) ?? defaultGlobalClient(context, dependencies.now);
    this.watch = dependencies.watch;
    this.setInterval = dependencies.setInterval;
    this.clearInterval = dependencies.clearInterval;
    this.queueMicrotask = dependencies.queueMicrotask;
    this.now = dependencies.now;
    this.pollMs = dependencies.pollMs;
    this.serverResponseMs = dependencies.serverResponseMs;
    this.pending = new Map();
    this.pendingReservations = new Set();
    this.responses = [];
    this.selectedRecommendationIds = Object.freeze([]);
    this.refreshQueued = false;
    this.refreshScheduled = false;
    this.refreshInFlight = false;
    this.refreshWaiters = [];
    this.disposed = false;
    this.terminal = false;
    this.epoch = 1;
    this.watcher = null;
    this.watcherError = null;
    this.readCount = 0;
    this.consecutiveFailures = 0;
    this.lastFailureReason = null;
    this.breakerNextRetryAt = 0;
    this.snapshot = this.makeSnapshot({ phase: "initializing", projection: null, error: null });
    this.pollTimer = null;
    if (terminalStateRoots.has(context.stateRootIdentity)) this.terminalize();
    else {
      this.armWatcher();
      this.pollTimer = this.setInterval(() => this.poll(), this.pollMs);
      this.pollTimer?.unref?.();
    }
  }

  makeSnapshot({ phase, projection, error }) {
    return deepFreeze({
      phase,
      key: this.context.globalKey,
      stateRootIdentity: this.context.stateRootIdentity,
      projection,
      selectedRecommendationIds: this.selectedRecommendationIds,
      pending: [...this.pending.values()],
      responses: this.responses,
      watcher: this.watcher ? "active" : "polling",
      watcherError: this.watcherError,
      health: {
        degraded: this.consecutiveFailures >= BREAKER_OPEN_THRESHOLD,
        reason: this.lastFailureReason,
        consecutiveFailures: this.consecutiveFailures,
        nextRetryAt: this.breakerNextRetryAt || null,
      },
      revision: this.readCount,
      updatedAt: this.now(),
      error,
      stale: phase === "error" && projection !== null,
    });
  }

  attach(owner) {
    if (this.disposed) throw new Error("tui-global-store-runtime-disposed");
    this.owners.add(owner);
    owner.receiveGlobal(this.snapshot);
    this.requestRefresh("owner-attached");
  }

  detach(owner) {
    this.owners.delete(owner);
    // BH-8: a terminal runtime stays live for the owners still showing its
    // terminal snapshot, but once the last one detaches nothing can observe it
    // again and it must leave the registry. Terminality for later owners comes
    // from terminalStateRoots, not from this entry, so a fresh runtime for the
    // same state root still terminalizes itself on construction.
    if (this.owners.size === 0) this.dispose();
  }

  notify() {
    for (const owner of [...this.owners]) owner.receiveGlobal(this.snapshot);
  }

  armWatcher() {
    if (this.disposed || this.watcher) return;
    try {
      const watcher = this.watch(this.context.globalWatchPath, { persistent: false }, (eventType) => {
        if (this.disposed) return;
        if (eventType === "rename") this.closeWatcher("watched-global-directory-replaced");
        // An open breaker also gates watcher-driven refreshes: an fs event storm
        // must not bypass the backed-off cadence and re-enter a failing refresh.
        if (this.breakerOpen()) return;
        this.requestRefresh(`global-watch:${eventType ?? "change"}`);
      });
      this.watcher = watcher;
      this.watcherError = null;
      watcher?.on?.("error", (error) => {
        if (this.disposed || watcher !== this.watcher) return;
        this.closeWatcher(errorReason(error));
        if (this.breakerOpen()) return;
        this.requestRefresh("global-watch:error");
      });
    } catch (error) {
      this.watcher = null;
      this.watcherError = errorReason(error);
    }
  }

  closeWatcher(reason = null) {
    const watcher = this.watcher;
    this.watcher = null;
    if (reason) this.watcherError = reason;
    try { watcher?.close?.(); } catch {}
  }

  poll() {
    if (this.disposed || this.terminal) return;
    this.armWatcher();
    this.requestRefresh("global-poll");
  }

  breakerOpen() {
    return this.consecutiveFailures >= BREAKER_OPEN_THRESHOLD;
  }

  rearmPollTimer(intervalMs) {
    if (this.disposed || this.terminal || !this.pollTimer) return;
    this.clearInterval(this.pollTimer);
    this.pollTimer = this.setInterval(() => this.poll(), intervalMs);
    this.pollTimer?.unref?.();
  }

  noteRefreshFailure() {
    this.consecutiveFailures += 1;
    if (!this.breakerOpen()) return;
    const step = this.consecutiveFailures - BREAKER_OPEN_THRESHOLD;
    const backoff = Math.min(this.pollMs * 2 ** (step + 1), BREAKER_MAX_INTERVAL_MS);
    const interval = Math.round(backoff * (1 + Math.random() * 0.25));
    this.breakerNextRetryAt = this.now() + interval;
    this.rearmPollTimer(interval);
  }

  noteRefreshSuccess() {
    if (this.consecutiveFailures === 0) return;
    this.consecutiveFailures = 0;
    this.lastFailureReason = null;
    this.breakerNextRetryAt = 0;
    this.rearmPollTimer(this.pollMs);
  }

  selectDetails(ids) {
    if (this.terminal) return Promise.resolve(this.snapshot);
    const clean = cleanDetailIds(ids);
    if (clean.join("\n") === this.selectedRecommendationIds.join("\n")) return Promise.resolve(this.snapshot);
    this.selectedRecommendationIds = clean;
    this.snapshot = this.makeSnapshot({
      phase: this.snapshot.phase,
      projection: this.snapshot.projection,
      error: this.snapshot.error,
    });
    this.notify();
    return this.requestRefresh("global-detail-selection");
  }

  assertNotPending(action, subject) {
    const key = JSON.stringify([action, subject]);
    if (this.pendingReservations.has(key)
        || [...this.pending.values()].some((entry) => pendingMatches(entry, action, subject))) {
      throw new Error("matching-request-already-pending");
    }
  }

  reservePending(action, subject) {
    this.assertNotPending(action, subject);
    if (this.pending.size + this.pendingReservations.size >= MAX_PENDING_RESPONSES) {
      throw new Error("pending-request-capacity-exhausted");
    }
    const key = JSON.stringify([action, subject]);
    this.pendingReservations.add(key);
    return key;
  }

  async trackPending(value) {
    if (this.terminal) throw new Error("restart-required-after-purge-all");
    const clean = cleanPending(value);
    if (clean.kind !== "global-action") throw new TypeError("global-pending-request-kind-required");
    if (!this.pending.has(clean.requestId) && this.pending.size >= MAX_PENDING_RESPONSES) {
      throw new Error("pending-request-capacity-exhausted");
    }
    this.pending.set(clean.requestId, clean);
    this.snapshot = this.makeSnapshot({
      phase: this.snapshot.phase,
      projection: this.snapshot.projection,
      error: this.snapshot.error,
    });
    this.notify();
    return this.requestRefresh("global-pending-request");
  }

  async submitAction(action, recommendationId, owner) {
    if (this.terminal) throw new Error("restart-required-after-purge-all");
    if (!["apply", "reject", "undo"].includes(action)) throw new TypeError("unsupported-global-action");
    await this.requestRefresh("global-action-preflight");
    if (!hasCurrentGlobalAuthority(this.snapshot)) throw new Error("global-operation-protocol-unavailable");
    const authoritySnapshot = this.snapshot;
    this.assertNotPending(action, recommendationId);
    const grant = this.snapshot.projection.grants.find((value) =>
      value.action === action && value.recommendationId === recommendationId);
    if (!grant) throw new Error("global-action-not-authorized");
    const reservation = this.reservePending(action, recommendationId);
    try {
      const acting = await owner.prepareGlobalAction(this.context.stateRootIdentity);
      if (this.disposed || this.snapshot !== authoritySnapshot || !hasCurrentGlobalAuthority(this.snapshot)) {
        throw new Error("global-authority-changed-before-submit");
      }
      if (!this.snapshot.projection.grants.some((value) => value.grantHash === grant.grantHash)) {
        throw new Error("global-authority-changed-before-submit");
      }
      const timestamp = this.now();
      const request = createGlobalActionRequest({
        grant,
        actingProjectFingerprint: acting.projectFingerprint,
        actingHealth: acting.health,
        timestamp,
      });
      await this.client.submitAction(request);
      await this.trackPending({
        requestId: request.requestId,
        kind: "global-action",
        action,
        subject: recommendationId,
        submittedAt: timestamp,
        expiresAt: request.expiresAt,
        request,
      });
      return request;
    } finally {
      this.pendingReservations.delete(reservation);
    }
  }

  requestRefresh() {
    if (this.disposed || this.terminal) return Promise.resolve(this.snapshot);
    const minimumReadCount = this.readCount + (this.refreshInFlight ? 2 : 1);
    this.refreshQueued = true;
    const completion = new Promise((resolve) => this.refreshWaiters.push({ minimumReadCount, resolve }));
    if (!this.refreshInFlight && !this.refreshScheduled) {
      this.refreshScheduled = true;
      this.queueMicrotask(() => void this.runRefresh());
    }
    return completion;
  }

  settleWaiters(force = false) {
    const settled = this.refreshWaiters.filter((waiter) => force || waiter.minimumReadCount <= this.readCount);
    this.refreshWaiters = this.refreshWaiters.filter((waiter) => !force && waiter.minimumReadCount > this.readCount);
    for (const waiter of settled) waiter.resolve(this.snapshot);
  }

  // CAUTION: this bound is inert for a synchronous `operation`. The timeout is
  // scheduled on the same event loop the operation runs on, so a client that
  // blocks synchronously (every default client method is sync) can never be
  // interrupted by it — the microtask drains before the timers phase. It only
  // protects against genuinely asynchronous clients that stall. Do not rely on
  // serverResponseMs to bound a synchronous call; keep sync client work short.
  async boundedServerCall(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("global-server-not-responding")), this.serverResponseMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async runRefresh() {
    this.refreshScheduled = false;
    if (this.disposed || this.refreshInFlight || !this.refreshQueued) return;
    this.refreshQueued = false;
    this.refreshInFlight = true;
    const lease = this.epoch;
    let pending = [...this.pending.values()];
    const reconciling = new Set(this.pending.keys());
    let responses = [];
    try {
      if (pending.length) {
        const reconciled = typeof this.client.reconcilePending === "function"
          ? await this.client.reconcilePending(pending, { context: this.context })
          : { pending, responses: [] };
        const pendingById = new Map((reconciled?.pending ?? pending).map(cleanPending)
          .map((entry) => [entry.requestId, entry]));
        const responseById = new Map((reconciled?.responses ?? [])
          .map((entry) => [entry.requestId, entry]));
        const timestamp = this.now();
        const stillPending = [];
        for (const entry of pending) {
          const response = responseById.get(entry.requestId);
          const timely = response && Number.isSafeInteger(response.response?.processedAt)
            && response.response.processedAt < entry.expiresAt;
          if (response && (timestamp < entry.expiresAt || timely)) responses.push(response);
          else if (timestamp >= entry.expiresAt) responses.push(expiredPendingResponse(entry));
          else stillPending.push(pendingById.get(entry.requestId) ?? entry);
        }
        pending = stillPending;
      }
      const projection = await this.boundedServerCall(() => this.client.read({
        detailRecommendationIds: this.selectedRecommendationIds,
        context: this.context,
      }));
      if (this.disposed || lease !== this.epoch) return;
      this.pending = mergePending(this.pending, pending, reconciling);
      this.responses = deepFreeze([...this.responses, ...responses].slice(-MAX_COMPLETED_RESPONSES));
      this.readCount += 1;
      this.noteRefreshSuccess();
      this.snapshot = this.makeSnapshot({
        phase: projection?.mode === "native" ? "ready" : "limited",
        projection,
        error: null,
      });
      this.notify();
    } catch (error) {
      if (this.disposed || lease !== this.epoch) return;
      this.pending = mergePending(this.pending, pending, reconciling);
      this.responses = deepFreeze([...this.responses, ...responses].slice(-MAX_COMPLETED_RESPONSES));
      this.readCount += 1;
      this.lastFailureReason = errorReason(error);
      this.noteRefreshFailure();
      this.snapshot = this.makeSnapshot({
        phase: "error",
        projection: globalProjectionWithoutAuthority(this.snapshot.projection),
        error: errorReason(error),
      });
      this.notify();
    } finally {
      if (!this.disposed && lease === this.epoch) {
        this.refreshInFlight = false;
        this.settleWaiters();
        if (this.refreshQueued && !this.refreshScheduled) {
          this.refreshScheduled = true;
          this.queueMicrotask(() => void this.runRefresh());
        }
      }
    }
  }

  terminalize() {
    if (this.disposed || this.terminal) return;
    this.terminal = true;
    this.epoch += 1;
    this.refreshQueued = false;
    this.refreshScheduled = false;
    this.refreshInFlight = false;
    this.pending.clear();
    this.pendingReservations.clear();
    this.closeWatcher();
    this.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.readCount += 1;
    this.snapshot = this.makeSnapshot({
      phase: "terminal",
      projection: globalProjectionWithoutAuthority(this.snapshot.projection),
      error: "restart-required-after-purge-all",
    });
    this.notify();
    this.settleWaiters(true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.pendingReservations.clear();
    this.closeWatcher();
    this.clearInterval(this.pollTimer);
    this.pollTimer = null;
    globalRuntimes.delete(this.registryKey);
    this.snapshot = this.makeSnapshot({
      phase: "disposed",
      projection: this.snapshot.projection,
      error: null,
    });
    this.settleWaiters(true);
  }
}

function terminalizeTuiStateRoot(stateRootIdentity, sourceRuntime, responses) {
  terminalStateRoots.add(stateRootIdentity);
  for (const runtime of projectRuntimes.values()) {
    if (runtime.context.stateRootIdentity === stateRootIdentity) {
      runtime.terminalize(runtime === sourceRuntime ? responses : []);
    }
  }
  globalRuntimes.get(stateRootIdentity)?.terminalize();
}

function projectRuntimeFor(context, dependencies) {
  const current = projectRuntimes.get(context.key);
  if (current) return current;
  const runtime = new ProjectRuntime(context, dependencies);
  projectRuntimes.set(context.key, runtime);
  return runtime;
}

function globalRuntimeFor(context, dependencies) {
  const current = globalRuntimes.get(context.globalKey);
  if (current) return current;
  const runtime = new GlobalRuntime(context, dependencies);
  globalRuntimes.set(context.globalKey, runtime);
  return runtime;
}

function validatedParticipation(projectSnapshot, globalSnapshot) {
  const participation = projectSnapshot?.participation;
  const index = globalSnapshot?.projection?.index;
  if (!participation || !index
      || participation.stateRootIdentity !== index.stateRootIdentity
      || participation.generation !== index.generation
      || participation.indexHash !== index.indexHash
      || !Array.isArray(participation.entries)) return deepFreeze({});
  const indexed = new Map(index.recommendations.map((entry) => [entry.recommendationId, entry.supportSetHash]));
  const result = {};
  for (const entry of participation.entries) {
    if (!entry || indexed.get(entry.recommendationId) !== entry.supportSetHash
        || typeof entry.currentProjectContributed !== "boolean") continue;
    result[entry.recommendationId] = entry.currentProjectContributed;
  }
  return deepFreeze(result);
}

function composeStoreSnapshot(projectSnapshot, globalSnapshot, runtimeMetadata) {
  if (!projectSnapshot) {
    return deepFreeze({
      phase: "initializing",
      projection: null,
      dashboard: null,
      dashboardError: null,
      acknowledgedOutcomes: Object.freeze([]),
      runtime: runtimeMetadata,
      pending: globalSnapshot?.pending ?? Object.freeze([]),
      responses: globalSnapshot?.responses ?? Object.freeze([]),
      global: globalSnapshot ?? null,
      participation: deepFreeze({}),
      error: null,
    });
  }
  return deepFreeze({
    ...projectSnapshot,
    pending: [...(globalSnapshot?.pending ?? []), ...(projectSnapshot.pending ?? [])],
    responses: [...(globalSnapshot?.responses ?? []), ...(projectSnapshot.responses ?? [])],
    global: globalSnapshot ?? null,
    participation: validatedParticipation(projectSnapshot, globalSnapshot),
    updatedAt: Math.max(projectSnapshot.updatedAt ?? 0, globalSnapshot?.updatedAt ?? 0),
  });
}

class StoreOwner {
  constructor(api, config, dependencies) {
    this.api = api;
    this.config = config;
    this.dependencies = dependencies;
    this.listeners = new Set();
    this.unsubscribers = [];
    this.disposed = false;
    this.runtime = null;
    this.globalRuntime = null;
    this.context = null;
    this.startupStateRootEnabled = true;
    this.startupWorktreeEnabled = true;
    this.lifecycleUnsubscribe = null;
    this.projectSnapshot = null;
    this.globalSnapshot = null;
    this.localSnapshot = composeStoreSnapshot(null, null, dependencies.runtimeMetadata);
    this.reconcileContext();
    for (const eventType of PATH_EVENTS) {
      const unsubscribe = api.event?.on?.(eventType, () => {
        this.reconcileContext();
        void this.runtime?.requestRefresh(`event:${eventType}`);
      });
      if (typeof unsubscribe === "function") this.unsubscribers.push(unsubscribe);
    }
    this.abort = () => this.dispose();
    api.lifecycle?.signal?.addEventListener?.("abort", this.abort, { once: true });
    const lifecycleUnsubscribe = api.lifecycle?.onDispose?.(() => this.dispose());
    if (typeof lifecycleUnsubscribe === "function") this.lifecycleUnsubscribe = lifecycleUnsubscribe;
  }

  updateSnapshot() {
    this.localSnapshot = composeStoreSnapshot(
      this.projectSnapshot,
      this.globalSnapshot,
      this.dependencies.runtimeMetadata,
    );
    for (const listener of [...this.listeners]) {
      if (this.disposed) break;
      try { listener(this.localSnapshot); } catch {}
    }
  }

  receiveProject(snapshot) {
    if (this.disposed) return;
    this.projectSnapshot = snapshot;
    this.updateSnapshot();
  }

  receiveGlobal(snapshot) {
    if (this.disposed) return;
    this.globalSnapshot = snapshot;
    this.updateSnapshot();
  }

  reconcileContext() {
    if (this.disposed) return false;
    if (nonEmptyPath(this.api.state?.path?.state)) this.startupStateRootEnabled = false;
    if (nonEmptyPath(this.api.state?.path?.worktree)) this.startupWorktreeEnabled = false;
    let context;
    try {
      context = resolveTuiStoreContext(this.api, this.config, {
        allowStartupStateRoot: this.startupStateRootEnabled,
        allowStartupWorktree: this.startupWorktreeEnabled,
      });
    } catch (error) {
      this.runtime?.detach(this);
      this.globalRuntime?.detach(this);
      this.runtime = null;
      this.globalRuntime = null;
      this.context = null;
      this.projectSnapshot = deepFreeze({
        phase: "error",
        projection: null,
        dashboard: null,
        dashboardError: null,
        latestExport: null,
        inspection: null,
        acknowledgedOutcomes: Object.freeze([]),
        runtime: this.dependencies.runtimeMetadata,
        pending: Object.freeze([]),
        responses: Object.freeze([]),
        error: errorReason(error),
      });
      this.globalSnapshot = null;
      this.updateSnapshot();
      return true;
    }
    if (this.context?.key === context.key && this.context.pathIdentity === context.pathIdentity) return false;
    this.runtime?.detach(this);
    if (this.context?.globalKey !== context.globalKey) {
      this.globalRuntime?.detach(this);
      this.globalRuntime = null;
      this.globalSnapshot = null;
    }
    this.context = context;
    this.runtime = projectRuntimeFor(context, this.dependencies);
    this.globalRuntime ??= globalRuntimeFor(context, this.dependencies);
    this.runtime.attach(this);
    if (!this.globalRuntime.owners.has(this)) this.globalRuntime.attach(this);
    return true;
  }

  getSnapshot() {
    return this.localSnapshot;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("tui-store-listener-required");
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.localSnapshot);
    return () => this.listeners.delete(listener);
  }

  refresh() {
    this.reconcileContext();
    return Promise.all([
      this.runtime?.requestRefresh("owner-refresh"),
      this.globalRuntime?.requestRefresh("owner-refresh"),
    ]).then(() => this.localSnapshot);
  }

  selectDetails(ids) {
    this.reconcileContext();
    if (this.globalSnapshot?.projection?.index) {
      return this.globalRuntime?.selectDetails(ids).then(() => this.localSnapshot) ?? Promise.resolve(this.localSnapshot);
    }
    return this.runtime?.selectDetails(ids).then(() => this.localSnapshot) ?? Promise.resolve(this.localSnapshot);
  }

  trackPending(value) {
    this.reconcileContext();
    return this.runtime?.trackPending(value) ?? Promise.resolve(this.localSnapshot);
  }

  trackGlobalPending(value) {
    this.reconcileContext();
    return this.globalRuntime?.trackPending(value).then(() => this.localSnapshot) ?? Promise.resolve(this.localSnapshot);
  }

  acknowledgeOutcome(subjectId) {
    this.reconcileContext();
    const binding = currentAcknowledgementBinding(this.localSnapshot, subjectId);
    return binding && this.runtime
      ? this.runtime.acknowledgeBinding(binding)
      : this.localSnapshot;
  }

  acknowledgeGlobalFailure(requestId) {
    this.reconcileContext();
    const entry = this.localSnapshot?.global?.responses?.find((response) => response.requestId === requestId);
    const binding = globalFailureAcknowledgementBinding(entry);
    return binding && this.runtime
      ? this.runtime.acknowledgeBinding(binding)
      : this.localSnapshot;
  }

  submitDecision(value) {
    this.reconcileContext();
    if (!this.runtime) return Promise.reject(new Error("tui-store-unavailable"));
    if (this.globalSnapshot?.projection?.index?.recommendations
      ?.some((entry) => entry.recommendationId === value.proposalId)) {
      const action = value.newState === "approved" ? "apply" : value.newState === "rejected" ? "reject" : null;
      if (!action) return Promise.reject(new Error("unsupported-global-action"));
      return this.globalRuntime.submitAction(action, value.proposalId, this);
    }
    return this.runtime.submitDecision(value);
  }

  submitRecommendationAction(recommendationId, action) {
    this.reconcileContext();
    if (!this.globalRuntime) return Promise.reject(new Error("tui-global-store-unavailable"));
    return this.globalRuntime.submitAction(action, recommendationId, this);
  }

  submitControl(action, payload) {
    this.reconcileContext();
    if (!this.runtime) return Promise.reject(new Error("tui-store-unavailable"));
    return this.runtime.submitControl(action, payload);
  }

  submitOperation(action, payload, options) {
    this.reconcileContext();
    if (!this.runtime) return Promise.reject(new Error("tui-store-unavailable"));
    if (action === "rollback-proposal" && options?.proposalId
        && this.globalSnapshot?.projection?.index?.recommendations
          ?.some((entry) => entry.recommendationId === options.proposalId)) {
      return this.globalRuntime.submitAction("undo", options.proposalId, this);
    }
    return this.runtime.submitOperation(action, payload, options);
  }

  async prepareGlobalAction(expectedStateRootIdentity) {
    this.reconcileContext();
    const runtime = this.runtime;
    if (!runtime || !this.context || this.context.stateRootIdentity !== expectedStateRootIdentity) {
      throw new Error("acting-project-unavailable");
    }
    await runtime.requestRefresh("global-action-acting-project-preflight");
    if (this.runtime !== runtime || !hasCurrentActingProjectAuthority(runtime.snapshot)
        || this.globalSnapshot?.phase !== "ready") {
      throw new Error("acting-project-authority-unavailable");
    }
    return deepFreeze({
      projectFingerprint: this.context.projectFingerprint,
      health: runtime.snapshot.tuiHealth,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.api.lifecycle?.signal?.removeEventListener?.("abort", this.abort);
    const lifecycleUnsubscribe = this.lifecycleUnsubscribe;
    this.lifecycleUnsubscribe = null;
    try { lifecycleUnsubscribe?.(); } catch {}
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe(); } catch {}
    }
    this.listeners.clear();
    this.runtime?.detach(this);
    this.globalRuntime?.detach(this);
    this.runtime = null;
    this.globalRuntime = null;
    this.context = null;
  }
}

// Target-exclusive inert recovery store. Constructed when startup trust
// resolution (state root or project identity) fails so the native sidebar,
// route, and mode-scoped keymap still register a recovery shell. It holds zero
// authority: it cannot mint grants, publish envelopes, read private projections,
// or mutate server state. Its refresh() is the user-initiated Retry: it re-runs
// the injected resolution once per call and updates the diagnostic snapshot.
/**
 * @param {Object} input
 * @param {string} [input.diagnostic]
 * @param {() => (Promise<{ ok: boolean, diagnostic?: string }> | { ok: boolean, diagnostic?: string })} [input.retry]
 * @param {() => number} [input.now]
 */
export function createInertRecoveryStore({
  diagnostic,
  retry,
  now = Date.now,
} = {}) {
  if (typeof now !== "function") throw new TypeError("inert-store-clock-required");
  let listeners = new Set();
  let disposed = false;
  const buildSnapshot = (message) => deepFreeze({
    phase: "error",
    stale: false,
    inert: true,
    projection: null,
    dashboard: null,
    dashboardError: null,
    acknowledgedOutcomes: Object.freeze([]),
    runtime: cleanRuntimeMetadata(undefined),
    pending: Object.freeze([]),
    responses: Object.freeze([]),
    global: null,
    participation: deepFreeze({}),
    error: boundedDisplayText(message ?? diagnostic ?? "projection-refresh-failed", 240),
    updatedAt: Math.trunc(now()),
  });
  let snapshot = buildSnapshot(diagnostic);
  const notify = () => {
    for (const listener of listeners) {
      try { listener(snapshot); } catch {}
    }
  };
  return Object.freeze({
    inert: true,
    getSnapshot() { return snapshot; },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("tui-store-listener-required");
      if (disposed) return () => {};
      listeners.add(listener);
      try { listener(snapshot); } catch {}
      return () => listeners.delete(listener);
    },
    async refresh() {
      if (disposed) return snapshot;
      if (typeof retry !== "function") return snapshot;
      let result;
      try {
        result = await retry();
      } catch (error) {
        result = { ok: false, diagnostic: error instanceof Error ? error.message : String(error) };
      }
      if (result && result.ok) {
        snapshot = buildSnapshot("Recovery succeeded. Restart OpenCode to load the full control center.");
      } else {
        snapshot = buildSnapshot((result && result.diagnostic) || diagnostic);
      }
      notify();
      return snapshot;
    },
    selectDetails() { return Promise.resolve(snapshot); },
    trackPending() { return Promise.resolve(snapshot); },
    trackGlobalPending() { return Promise.resolve(snapshot); },
    submitDecision() { return Promise.reject(new Error("inert-store-no-authority")); },
    submitRecommendationAction() { return Promise.reject(new Error("inert-store-no-authority")); },
    submitControl() { return Promise.reject(new Error("inert-store-no-authority")); },
    submitOperation() { return Promise.reject(new Error("inert-store-no-authority")); },
    prepareGlobalAction() { return Promise.reject(new Error("inert-store-no-authority")); },
    acknowledgeOutcome() { return snapshot; },
    acknowledgeGlobalFailure() { return snapshot; },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      listeners = new Set();
    },
  });
}

export function acquireProjectTuiStore({
  api,
  config = {},
  clientFactory,
  globalClientFactory,
  watch = watchDirectory,
  now = Date.now,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  queueMicrotask: queueMicrotaskFn = queueMicrotask,
  acknowledgementStore,
  runtimeMetadata,
  pollMs = config.storePollMs,
  serverResponseMs = config.serverTimeoutMs,
} = {}) {
  if (!api || typeof api !== "object") throw new TypeError("tui-api-required");
  if (typeof watch !== "function" || typeof now !== "function"
      || typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function"
      || typeof queueMicrotaskFn !== "function") {
    throw new TypeError("invalid-tui-store-dependency");
  }
  return new StoreOwner(api, config, {
    clientFactory,
    globalClientFactory,
    watch,
    now,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    queueMicrotask: queueMicrotaskFn,
    acknowledgements: acknowledgementStore,
    runtimeMetadata: cleanRuntimeMetadata(runtimeMetadata),
    pollMs: boundedPollMs(pollMs),
    serverResponseMs: boundedServerResponseMs(serverResponseMs),
  });
}

export const __testTuiStore = Object.freeze({
  clientOffer: CLIENT_OFFER,
  globalClientOffer: GLOBAL_CLIENT_OFFER,
  registrySize: () => projectRuntimes.size,
  projectRegistrySize: () => projectRuntimes.size,
  globalRegistrySize: () => globalRuntimes.size,
  reset() {
    for (const runtime of [...projectRuntimes.values()]) runtime.dispose();
    for (const runtime of [...globalRuntimes.values()]) runtime.dispose();
    projectRuntimes.clear();
    globalRuntimes.clear();
    terminalStateRoots.clear();
  },
});
