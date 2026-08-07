import { watch as watchDirectory } from "node:fs";
import path from "node:path";
import {
  BRIDGE_TTL_MS,
  createControlRequest,
  createDecisionRequest,
  createUiOperationRequest,
  pollControlResponse,
  pollDecisionResponse,
  pollUiOperationResponse,
  readBoundedInspection,
  readControlState,
  readProjectInbox,
  readUiProjection,
  submitControlRequest,
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
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
} from "./self-evolve-ui-protocol.js";

const DEFAULT_POLL_MS = 250;
const MIN_POLL_MS = 25;
const MAX_POLL_MS = 5_000;
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
const runtimes = new Map();
const WATCHER_STATUS = Object.freeze({
  active: "Filesystem watcher active",
  polling: "Polling fallback active",
});
const BREAKER_STATUS = Object.freeze({
  true: "Open after repeated failures",
  false: "Closed",
});

function errorReason(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

function hasNativeOperationProtocol(projection) {
  return projection?.mode === "native"
    && projection.operationProtocolVersion === UI_OPERATION_PROTOCOL_VERSION;
}

function hasCurrentNativeAuthority(snapshot) {
  return snapshot?.phase === "ready" && hasNativeOperationProtocol(snapshot.projection);
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
    pathIdentity: pathIdentityFor(context),
    watchPath: path.join(stateRoot, "self-evolve", "bridge", identity.projectFingerprint),
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
        const response = entry.kind === "control"
          ? pollControlResponse(context.stateRoot, context.projectFingerprint, entry.requestId)
          : pollDecisionResponse(context.stateRoot, context.projectFingerprint, entry.requestId);
        if (response) responses.push({ ...entry, response });
        else pending.push(entry);
      }
      return { pending, responses };
    },
    readInbox() {
      return readProjectInbox(context.stateRoot, context.projectFingerprint, { now: now() });
    },
    readControlState() {
      return readControlState(context.stateRoot, context.projectFingerprint, { now: now() });
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
    submitDecision(request) {
      return submitDecisionRequest(context.stateRoot, request);
    },
    submitControl(request) {
      return submitControlRequest(context.stateRoot, request);
    },
    submitOperation(request) {
      return submitUiOperationRequest(context.stateRoot, request);
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

function cleanPending(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("pending-request-malformed");
  if (typeof value.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.requestId)) {
    throw new TypeError("invalid-pending-request-id");
  }
  if (!["control", "decision", "operation"].includes(value.kind)) throw new TypeError("invalid-pending-request-kind");
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
    ...(value.kind === "operation" && value.request ? { request: value.request } : {}),
  });
}

function controlSubject(action, payload = {}) {
  if (action === "set-consent") return `consent:${String(payload.key ?? "unknown")}`;
  if (action === "set-mode") return "global-mode";
  if (action === "set-repo-mode") return "repository-mode";
  if (action === "set-repo-excluded") return "project-inclusion";
  if (action === "update-allowlist") return "approved-skill-folders";
  return "project";
}

function operationSubject(action, payload = {}, proposalId) {
  if (proposalId) return proposalId;
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

const MODE_LABELS = Object.freeze({
  manual: "On demand",
  auto: "Recommend automatically",
  yolo: "Apply automatically (YOLO)",
});
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

function appliedAttention(snapshot, reviews, dashboard) {
  const acknowledged = new Set(snapshot?.acknowledgedAuditIds ?? []);
  const activityByProposal = new Map();
  for (const entry of dashboard?.activity ?? []) {
    if (entry.outcome !== "applied" || !entry.proposalId) continue;
    const entries = activityByProposal.get(entry.proposalId) ?? [];
    entries.push(entry);
    activityByProposal.set(entry.proposalId, entries);
  }
  const applied = reviews
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => {
      if (review.state !== "applied" || acknowledged.has(review.proposalId)) return false;
      const activities = activityByProposal.get(review.proposalId);
      return !(activities?.length > 0 && activities.every((entry) => acknowledged.has(entry.id)));
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
    paused: {
      tone: "warning",
      label: "Self-evolve is paused",
      explanation: "Existing records remain available while scheduling is paused.",
      destination: destination("home"),
      nextAction: "Resume when automatic work should continue.",
    },
    excluded: {
      tone: "warning",
      label: "Disabled for this project",
      explanation: "Global settings remain intact, but this project is excluded.",
      destination: destination("settings", { anchor: "project-scope" }),
      nextAction: "Include this project to allow automatic work.",
    },
    "on-demand": {
      tone: "neutral",
      label: "Runs on demand",
      explanation: "Manual mode runs only explicit scans. Auto mode also needs Background analysis and Saved observations consent.",
      destination: destination("settings", { anchor: "modes" }),
      nextAction: "Choose Auto and enable both required consents, or run /self-evolve scan on demand.",
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
      nextAction: "Wait, or use the on-demand path.",
    },
  };
  const failures = reviews.filter((review) => review.state === "failed-closed");
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
    explanation: "Self-evolve is ready within the displayed mode and safeguards.",
    destination: destination("home"),
    nextAction: "No action required.",
  });
}

export function deriveOperationalView(snapshot) {
  const projection = snapshot?.projection;
  const index = projection?.index;
  const dashboard = dashboardFor(snapshot);
  const reviews = Array.isArray(index?.reviews) ? index.reviews : [];
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
  if (dashboard) return resultForAutomation(dashboard.automation.state, snapshot, dashboard, reviews);

  // An older aligned server still supplies the bounded v1 projection. Preserve
  // high-confidence safety and attention states, but never invent enhanced
  // readiness, budget, quiet-period, backoff, or actual-usage claims.
  let fallbackState = null;
  if (status.killSwitchActive) fallbackState = "emergency-stop";
  else if (status.circuitBreakerOpen) fallbackState = "circuit-breaker";
  else if (status.paused) fallbackState = "paused";
  else if (status.repoExcluded) fallbackState = "excluded";
  else if (status.effectiveMode === "manual") fallbackState = "on-demand";
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
  const cardDestination = operational.state === "on-demand"
    ? destination("home")
    : operational.destination;
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

function modeModel(globalMode, repositoryMode, effectiveMode) {
  return {
    global: { value: globalMode ?? null, label: MODE_LABELS[globalMode] ?? "Unavailable" },
    repository: {
      value: repositoryMode ?? null,
      label: repositoryMode === "inherit"
        ? "Inherit global default"
        : MODE_LABELS[repositoryMode] ?? "Unavailable",
    },
    effective: { value: effectiveMode ?? null, label: MODE_LABELS[effectiveMode] ?? "Unavailable" },
  };
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

function emptyHomeState(snapshot, operational, dashboard) {
  if (operational.state === "limited") {
    return { heading: "Limited view", explanation: operational.explanation };
  }
  if (operational.state === "paused") {
    return { heading: "Self-evolve is paused", explanation: "Existing records remain available; no automatic cycle will start." };
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
  if (dashboard?.settings?.effectiveMode !== "manual"
      && dashboard?.settings?.consent?.passiveCalls === false) {
    return { heading: "Background analysis is off", explanation: "Current consent prevents background AI analysis." };
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
  const reviews = index?.reviews ?? [];
  const settings = dashboard?.settings;
  const firstRun = dashboard?.blockers?.some((blocker) => blocker.code === "first-run") === true;
  const recentActivity = (dashboard?.activity ?? [])
    .filter((entry) => entry.audience !== "diagnostic")
    .slice(0, 3)
    .map((entry) => safeActivityRow(entry, reviews));
  return deepFreeze({
    phase: snapshot?.phase ?? "unavailable",
    operational,
    mode: modeModel(
      settings?.globalMode ?? index?.status?.storedMode,
      settings?.repositoryMode,
      settings?.effectiveMode ?? index?.status?.effectiveMode,
    ),
    firstRun,
    blockers: (dashboard?.blockers ?? []).map((blocker) => ({
      code: blocker.code,
      summary: blocker.summary,
      destination: blockerDestination(blocker),
    })),
    inFlight: dashboard?.inFlight ?? null,
    lastCycle: dashboard?.lastCycle ? {
      outcome: dashboard.lastCycle.outcome,
      triggerClass: dashboard.lastCycle.triggerClass,
      mode: dashboard.lastCycle.mode,
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
    manualFallback: "Run /self-evolve scan in the source session. This OpenCode host cannot safely bind a native scan to the selected session.",
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
  const projection = snapshot?.projection;
  const native = hasCurrentNativeAuthority(snapshot);
  const reviews = projection?.index?.reviews ?? [];
  const acknowledged = new Set(snapshot?.acknowledgedAuditIds ?? []);
  const dashboard = dashboardFor(snapshot);
  const queue = reviews
    .map((review, sourceIndex) => ({ review, sourceIndex }))
    .filter(({ review }) => recommendationFilterMatch(review, filter))
    .map(({ review, sourceIndex }) => {
      const detail = (projection?.details ?? []).find((item) => item.proposalId === review.proposalId);
      const matchingAudits = (dashboard?.activity ?? []).filter((entry) =>
        entry.outcome === "applied" && entry.proposalId === review.proposalId);
      return {
        sourceIndex,
        state: review.state,
        target: safeTargetLabel(review.target),
        attention: review.attention,
        updatedAt: review.updatedAt,
        rationale: detail?.summary?.rationale ?? "Enhanced recommendation detail is not loaded.",
        risk: detail?.summary?.risk ?? null,
        evidenceCount: detail?.evidence?.length ?? null,
        acknowledged: review.state === "applied" && (
          acknowledged.has(review.proposalId)
          || (matchingAudits.length > 0 && matchingAudits.every((entry) => acknowledged.has(entry.id)))
        ),
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
        effectiveMode: detail.summary.effectiveMode,
        risk: detail.summary.risk,
        criticPassed: detail.summary.criticPassed,
        validDeterministic: detail.summary.validDeterministic,
        injectionFlagged: detail.summary.injectionFlagged,
        tokenImpact: detail.summary.tokenImpact,
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
  const reviews = snapshot?.projection?.index?.reviews ?? [];
  const status = snapshot?.projection?.index?.status;
  const lastProjectedError = (dashboard?.activity ?? [])
    .find((entry) => entry.category === "error" || ERROR_OUTCOMES.has(entry.outcome));
  const activity = (dashboard?.activity ?? [])
    .filter((entry) => activityFilterMatch(entry, filter))
    .map((entry) => safeActivityRow(entry, reviews));
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
        passive: dashboard.usage.passive.resetAt,
        synthesis: dashboard.usage.synthesis.resetAt,
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
  const control = snapshot?.controlState;
  const index = snapshot?.projection?.index;
  const status = index?.status;
  const settings = dashboard?.settings;
  const consent = settings?.consent ?? control?.consent ?? null;
  const supportedControls = dashboard?.supportedControls ?? [];
  const approvedSkillFolders = control?.allowedSkillRoots ?? [];
  const hasControl = control !== undefined && control !== null;
  const yoloBlockers = [];
  const addYoloBlocker = (value) => {
    if (!yoloBlockers.includes(value)) yoloBlockers.push(value);
  };
  if (!dashboard) addYoloBlocker("An aligned server is required to verify automatic-apply prerequisites.");
  if (approvedSkillFolders.length === 0) addYoloBlocker("Approve at least one canonical skill folder.");
  if (consent?.passiveCalls !== true) addYoloBlocker("Allow Background AI analysis.");
  if (consent?.durableObservations !== true) addYoloBlocker("Allow Saved structured patterns.");
  if (dashboard?.rollout?.ready !== true) addYoloBlocker("Complete the configured automatic-apply rollout evidence.");
  if (settings?.paused) addYoloBlocker("Resume automatic work.");
  if (settings?.killSwitchActive) addYoloBlocker("Turn off Emergency stop after review.");
  if (settings?.repositoryExcluded) addYoloBlocker("Include this project.");
  if (status?.circuitBreakerOpen) addYoloBlocker("Reset the open circuit breaker.");
  for (const blocker of dashboard?.blockers ?? []) {
    if (["unsupported-host", "state-root", "provider", "corrupt-state"].includes(blocker.code)) {
      addYoloBlocker(blocker.summary);
    }
  }
  const usage = dashboard?.usage ?? null;
  const budgets = index?.budgets ?? null;
  const inspection = snapshot?.inspection;
  const observationCount = Array.isArray(inspection?.observations)
    ? inspection.observations.length + (inspection?.overflow?.observations ?? 0)
    : null;
  const native = hasCurrentNativeAuthority(snapshot);
  const effectiveActions = native ? (snapshot?.projection?.effectiveIndexActions ?? []) : [];
  const granted = new Set(effectiveActions.map((action) => action.action));
  return deepFreeze({
    phase: snapshot?.phase ?? "unavailable",
    mode: modeModel(
      settings?.globalMode ?? control?.mode ?? status?.storedMode,
      settings?.repositoryMode,
      settings?.effectiveMode ?? control?.effectiveMode ?? status?.effectiveMode,
    ),
    modes: [
      {
        value: "manual",
        label: MODE_LABELS.manual,
        description: "Runs only from a source-session scan command.",
        providerUse: "No passive provider calls. An invoked scan may use the configured provider.",
        savedData: "An invoked scan may save bounded structured observations when separately allowed.",
        writeAuthority: "Each apply requires an explicit decision.",
        prerequisites: "No passive setup is required.",
        available: true,
        blockers: [],
      },
      {
        value: "auto",
        label: MODE_LABELS.auto,
        description: "Analyzes at safe idle points and prepares recommendations.",
        providerUse: "Background provider calls require Background AI analysis consent.",
        savedData: "Saved structured patterns remain controlled by their separate consent.",
        writeAuthority: "Cannot apply without explicit approval.",
        prerequisites: "Provider, consent, budget, and host gates must pass; approved skill folders are not required to prepare recommendations.",
        available: true,
        blockers: [],
      },
      {
        value: "yolo",
        label: MODE_LABELS.yolo,
        description: "May analyze, recommend, and apply only after every prerequisite passes.",
        providerUse: "Uses the same consent-gated background provider path as automatic recommendations.",
        savedData: "Uses only the separately consented bounded evidence and operational records.",
        writeAuthority: "Restricted to approved skill folders, deterministic validation, critic approval, budgets, rollout history, and fresh server authority.",
        prerequisites: yoloBlockers.length ? "Unavailable until the listed blockers are resolved." : "All currently projected prerequisites pass.",
        available: yoloBlockers.length === 0,
        blockers: yoloBlockers,
      },
    ],
    controls: {
      globalMode: native && hasControl,
      repositoryMode: native && supportedControls.includes("set-repo-mode")
        && dashboard?.capabilities?.includes("control-repo-mode-v1") === true,
      consent: native && hasControl,
      projectInclusion: native && hasControl,
      approvedSkillFolders: native && hasControl,
      pause: granted.has("set-paused"),
      emergencyStop: granted.has("set-kill-switch"),
    },
    projectExcluded: settings?.repositoryExcluded ?? control?.repoExcluded ?? status?.repoExcluded ?? null,
    paused: settings?.paused ?? status?.paused ?? null,
    emergencyStop: settings?.killSwitchActive ?? status?.killSwitchActive ?? null,
    consent: consent ? [
      {
        key: "passiveCalls",
        label: "Background AI analysis",
        scope: "Global",
        enabled: consent.passiveCalls,
        description: "Allows safe-idle hidden provider calls. It does not itself allow saved evidence or writes.",
        dependency: "Required by both automatic modes.",
        canEnable: true,
      },
      {
        key: "durableObservations",
        label: "Saved structured patterns",
        scope: "Global",
        enabled: consent.durableObservations,
        description: "Persists bounded structured patterns across sessions; transcripts are never stored.",
        dependency: "Required for passive learning and automatic recommendations.",
        canEnable: true,
      },
      {
        key: "sanitizedExcerpts",
        label: "Sanitized evidence excerpts",
        scope: "Global",
        enabled: consent.sanitizedExcerpts,
        description: "Allows bounded redacted evidence text. Redaction reduces exposure but is not a secrecy guarantee.",
        dependency: "Required before Cross-project learning can be enabled.",
        canEnable: true,
      },
      {
        key: "crossRepoAggregation",
        label: "Cross-project learning (not active yet)",
        scope: "Global",
        enabled: consent.crossRepoAggregation,
        description: "No production path currently consumes cross-project claims; keep this disabled until that capability is active.",
        dependency: "Not active in this release. An enabled stored value can still be turned off.",
        canEnable: false,
      },
    ] : [],
    approvedSkillFolderCount: settings?.approvedSkillFolderCount ?? control?.allowedSkillRoots?.length ?? null,
    approvedSkillFolders,
    approvedSkillFolderRequiresNonEmpty:
      settings?.globalMode === "yolo" || settings?.repositoryMode === "yolo",
    approvedSkillFolderWarning: "Raw paths are shown only in this high-risk editor. Every replacement is revalidated by the server and requires the exact phrase UPDATE ALLOWLIST.",
    usage,
    retention: dashboard?.retention ?? null,
    rollout: dashboard?.rollout ?? null,
    blockers: dashboard?.blockers ?? [],
    supportedControls,
    limits: [
      {
        key: "passive",
        label: "Background analysis calls",
        actual: usage ? `${usage.passive.used} used; ${usage.passive.remaining} remaining` : "Actual usage unavailable",
        configured: budgets ? `${budgets.passiveCallsPerHour} per rolling hour` : "Configured limit unavailable",
        resetAt: usage?.passive?.resetAt ?? null,
        explanation: "Bounds hidden background provider calls; manual scans use their explicit command path.",
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
        explanation: "Requires a stable idle window before passive work is eligible.",
      },
    ],
    rolloutProgress: dashboard?.rollout ? {
      actual: `${dashboard.rollout.synthesesObserved} observed; ${(dashboard.rollout.successRateBasisPoints / 100).toFixed(2)}% successful`,
      configured: `${dashboard.rollout.minSynthesesObserved} required; ${(dashboard.rollout.minSuccessRateBasisPoints / 100).toFixed(2)}% minimum success`,
      ready: dashboard.rollout.ready,
    } : null,
    maintenance: {
      scopes: [
        { value: "observations", label: "Observations", explanation: "Bounded structured patterns for this project." },
        { value: "proposals", label: "Recommendations", explanation: "Recommendation and decision records for this project." },
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
      help: "Use Home for current state, Activity for waiting or failures, and /self-evolve scan in the source session for an on-demand analysis.",
    },
    limited: !dashboard,
    enhancedError: dashboardErrorFor(snapshot) ? "Enhanced settings could not be validated." : null,
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
    const reviews = snapshot?.projection?.index?.reviews ?? [];
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
    const reviews = snapshot?.projection?.index?.reviews ?? [];
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
      diagnostic: String(snapshot?.error ?? "projection-refresh-failed").slice(0, 240),
      canRetry: true,
    } : null,
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
    this.acknowledgedAuditIds = Object.freeze(
      this.acknowledgements?.read?.(context.projectFingerprint) ?? [],
    );
    this.pollMs = dependencies.pollMs;
    this.pending = new Map();
    this.pendingReservations = new Set();
    this.responses = [];
    this.detailProposalIds = Object.freeze([]);
    this.refreshQueued = false;
    this.refreshScheduled = false;
    this.refreshInFlight = false;
    this.refreshWaiters = [];
    this.disposed = false;
    this.epoch = 1;
    this.watcher = null;
    this.watcherError = null;
    this.readCount = 0;
    this.snapshot = this.makeSnapshot({
      phase: "initializing",
      projection: null,
      controlState: null,
      latestExport: null,
      inspection: null,
      error: null,
    });
    this.armWatcher();
    this.pollTimer = this.setInterval(() => this.poll(), this.pollMs);
    this.pollTimer?.unref?.();
  }

  makeSnapshot({
    phase,
    projection,
    controlState = this.snapshot?.controlState ?? null,
    latestExport = this.snapshot?.latestExport ?? null,
    inspection = this.snapshot?.inspection ?? null,
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
      dashboard: safeProjection?.dashboard ?? null,
      dashboardError: safeProjection?.dashboardError ?? null,
      controlState,
      latestExport,
      inspection,
      runtime: {
        ...this.runtimeMetadata,
        projectionVersion: safeProjection?.index?.projectionVersion ?? null,
        dashboardVersion: safeProjection?.dashboard?.dashboardVersion ?? null,
        projectionMode: safeProjection?.mode ?? null,
      },
      acknowledgedAuditIds: this.acknowledgedAuditIds,
      pending: [...this.pending.values()],
      responses: this.responses,
      watcher: this.watcher ? "active" : "polling",
      watcherError: this.watcherError,
      revision: this.readCount,
      updatedAt: this.now(),
      error,
      stale: phase === "error" && projection !== null,
    });
  }

  attach(owner) {
    if (this.disposed) throw new Error("tui-store-runtime-disposed");
    this.owners.add(owner);
    owner.receive(this.snapshot);
    this.requestRefresh("owner-attached");
  }

  detach(owner) {
    this.owners.delete(owner);
    if (this.owners.size === 0) this.dispose();
  }

  notify() {
    for (const owner of [...this.owners]) owner.receive(this.snapshot);
  }

  armWatcher() {
    if (this.disposed || this.watcher) return;
    try {
      const watcher = this.watch(this.context.watchPath, { persistent: false }, (eventType) => {
        if (this.disposed) return;
        if (eventType === "rename") this.closeWatcher("watched-directory-replaced");
        this.requestRefresh(`watch:${eventType ?? "change"}`);
      });
      this.watcher = watcher;
      this.watcherError = null;
      watcher?.on?.("error", (error) => {
        if (this.disposed || watcher !== this.watcher) return;
        this.closeWatcher(errorReason(error));
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
    if (this.disposed) return;
    for (const owner of [...this.owners]) owner.reconcileContext();
    if (this.disposed) return;
    this.armWatcher();
    this.requestRefresh("poll");
  }

  selectDetails(ids) {
    const clean = cleanDetailIds(ids);
    if (clean.join("\n") === this.detailProposalIds.join("\n")) return Promise.resolve(this.snapshot);
    this.detailProposalIds = clean;
    return this.requestRefresh("detail-selection");
  }

  acknowledgeAudits(ids) {
    if (this.disposed) return this.snapshot;
    this.acknowledgedAuditIds = Object.freeze(
      this.acknowledgements?.acknowledge?.(this.context.projectFingerprint, ids)
        ?? this.acknowledgedAuditIds,
    );
    this.snapshot = this.makeSnapshot({
      phase: this.snapshot.phase,
      projection: this.snapshot.projection,
      controlState: this.snapshot.controlState,
      latestExport: this.snapshot.latestExport,
      inspection: this.snapshot.inspection,
      error: this.snapshot.error,
    });
    this.notify();
    return this.snapshot;
  }

  async trackPending(value) {
    const clean = cleanPending(value);
    if (!this.pending.has(clean.requestId) && this.pending.size >= MAX_PENDING_RESPONSES) {
      throw new Error("pending-request-capacity-exhausted");
    }
    this.pending.set(clean.requestId, clean);
    this.snapshot = this.makeSnapshot({
      phase: this.snapshot.phase,
      projection: this.snapshot.projection,
      controlState: this.snapshot.controlState,
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

  async submitControl(action, payload) {
    await this.requestRefresh("control-preflight");
    if (!hasCurrentNativeAuthority(this.snapshot)) {
      throw new Error("native-operation-protocol-unavailable");
    }
    const authoritySnapshot = this.snapshot;
    const subject = controlSubject(action, payload);
    this.assertNotPending(action, subject);
    if (action === "set-repo-mode"
        && (this.snapshot.dashboard?.capabilities?.includes("control-repo-mode-v1") !== true
          || this.snapshot.dashboard?.supportedControls?.includes("set-repo-mode") !== true)) {
      throw new Error("repository-mode-control-not-supported");
    }
    const reservation = this.reservePending(action, subject);
    try {
      const controlState = await this.client.readControlState();
      if (!controlState) throw new Error("control-state-unavailable");
      this.assertAuthoritySnapshot(authoritySnapshot);
      const timestamp = this.now();
      const request = createControlRequest({ controlState, action, payload, timestamp });
      await this.client.submitControl(request);
      await this.trackPending({
        requestId: request.requestId,
        kind: "control",
        action,
        subject,
        submittedAt: timestamp,
        expiresAt: Math.min(timestamp + BRIDGE_TTL_MS, controlState.expiresAt),
      });
      return request;
    } finally {
      this.releasePendingReservation(reservation);
    }
  }

  async submitOperation(action, payload = {}, { proposalId } = {}) {
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
      } else if (action === "set-kill-switch" || action === "set-paused") {
        const controlState = await this.client.readControlState();
        if (!controlState) throw new Error("control-state-unavailable");
        wirePayload = { ...payload, settingsVersion: controlState.settingsVersion };
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
    if (this.disposed) return Promise.resolve(this.snapshot);
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

  async runRefresh() {
    this.refreshScheduled = false;
    if (this.disposed || this.refreshInFlight || !this.refreshQueued) return;
    this.refreshQueued = false;
    this.refreshInFlight = true;
    const lease = this.epoch;
    let pending = [...this.pending.values()];
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
      const projection = await this.client.read({
        detailProposalIds: this.detailProposalIds,
        context: this.context,
      });
      const controlState = typeof this.client.readControlState === "function"
        ? await this.client.readControlState()
        : null;
      const latestExport = typeof this.client.readLatestExport === "function"
        ? await this.client.readLatestExport()
        : null;
      const inspection = typeof this.client.readInspection === "function"
        ? await this.client.readInspection()
        : null;
      if (this.disposed || lease !== this.epoch) return;
      this.acknowledgedAuditIds = Object.freeze(
        this.acknowledgements?.read?.(this.context.projectFingerprint) ?? [],
      );
      this.pending = new Map(pending.map((entry) => [entry.requestId, entry]));
      this.responses = deepFreeze([...this.responses, ...responses].slice(-MAX_COMPLETED_RESPONSES));
      this.readCount += 1;
      this.snapshot = this.makeSnapshot({
        phase: projection?.mode === "legacy" ? "legacy" : "ready",
        projection,
        controlState,
        latestExport,
        inspection,
        error: null,
      });
      this.notify();
    } catch (error) {
      if (this.disposed || lease !== this.epoch) return;
      this.pending = new Map(pending.map((entry) => [entry.requestId, entry]));
      this.responses = deepFreeze([...this.responses, ...responses].slice(-MAX_COMPLETED_RESPONSES));
      this.readCount += 1;
      this.snapshot = this.makeSnapshot({
        phase: "error",
        projection: projectionWithoutAuthority(this.snapshot.projection),
        controlState: null,
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
    runtimes.delete(this.registryKey);
    this.snapshot = this.makeSnapshot({
      phase: "disposed",
      projection: this.snapshot.projection,
      controlState: this.snapshot.controlState,
      latestExport: this.snapshot.latestExport,
      inspection: this.snapshot.inspection,
      error: null,
    });
    this.settleWaiters(true);
  }
}

function runtimeFor(context, dependencies) {
  const current = runtimes.get(context.key);
  if (current) return current;
  const runtime = new ProjectRuntime(context, dependencies);
  runtimes.set(context.key, runtime);
  return runtime;
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
    this.context = null;
    this.startupStateRootEnabled = true;
    this.startupWorktreeEnabled = true;
    this.lifecycleUnsubscribe = null;
    this.localSnapshot = deepFreeze({
      phase: "initializing",
      projection: null,
      dashboard: null,
      dashboardError: null,
      acknowledgedAuditIds: Object.freeze([]),
      runtime: dependencies.runtimeMetadata,
      pending: Object.freeze([]),
      responses: Object.freeze([]),
      error: null,
    });
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

  receive(snapshot) {
    if (this.disposed) return;
    this.localSnapshot = snapshot;
    for (const listener of [...this.listeners]) {
      if (this.disposed) break;
      try { listener(snapshot); } catch {}
    }
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
      this.runtime = null;
      this.context = null;
      this.receive(deepFreeze({
        phase: "error",
        projection: null,
        dashboard: null,
        dashboardError: null,
        controlState: null,
        latestExport: null,
        inspection: null,
        acknowledgedAuditIds: Object.freeze([]),
        runtime: this.dependencies.runtimeMetadata,
        pending: Object.freeze([]),
        responses: Object.freeze([]),
        error: errorReason(error),
      }));
      return true;
    }
    if (this.context?.key === context.key && this.context.pathIdentity === context.pathIdentity) return false;
    this.runtime?.detach(this);
    this.context = context;
    this.runtime = runtimeFor(context, this.dependencies);
    this.runtime.attach(this);
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
    return this.runtime?.requestRefresh("owner-refresh") ?? Promise.resolve(this.localSnapshot);
  }

  selectDetails(ids) {
    this.reconcileContext();
    return this.runtime?.selectDetails(ids) ?? Promise.resolve(this.localSnapshot);
  }

  trackPending(value) {
    this.reconcileContext();
    return this.runtime?.trackPending(value) ?? Promise.resolve(this.localSnapshot);
  }

  acknowledgeAudits(ids) {
    this.reconcileContext();
    return this.runtime?.acknowledgeAudits(ids) ?? this.localSnapshot;
  }

  submitDecision(value) {
    this.reconcileContext();
    if (!this.runtime) return Promise.reject(new Error("tui-store-unavailable"));
    return this.runtime.submitDecision(value);
  }

  submitControl(action, payload) {
    this.reconcileContext();
    if (!this.runtime) return Promise.reject(new Error("tui-store-unavailable"));
    return this.runtime.submitControl(action, payload);
  }

  submitOperation(action, payload, options) {
    this.reconcileContext();
    if (!this.runtime) return Promise.reject(new Error("tui-store-unavailable"));
    return this.runtime.submitOperation(action, payload, options);
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
    this.runtime = null;
    this.context = null;
  }
}

export function acquireProjectTuiStore({
  api,
  config = {},
  clientFactory,
  watch = watchDirectory,
  now = Date.now,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  queueMicrotask: queueMicrotaskFn = queueMicrotask,
  acknowledgementStore,
  runtimeMetadata,
  pollMs = config.storePollMs,
} = {}) {
  if (!api || typeof api !== "object") throw new TypeError("tui-api-required");
  if (typeof watch !== "function" || typeof now !== "function"
      || typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function"
      || typeof queueMicrotaskFn !== "function") {
    throw new TypeError("invalid-tui-store-dependency");
  }
  return new StoreOwner(api, config, {
    clientFactory,
    watch,
    now,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    queueMicrotask: queueMicrotaskFn,
    acknowledgements: acknowledgementStore,
    runtimeMetadata: cleanRuntimeMetadata(runtimeMetadata),
    pollMs: boundedPollMs(pollMs),
  });
}

export const __testTuiStore = Object.freeze({
  clientOffer: CLIENT_OFFER,
  registrySize: () => runtimes.size,
  reset() {
    for (const runtime of [...runtimes.values()]) runtime.dispose();
    runtimes.clear();
  },
});
