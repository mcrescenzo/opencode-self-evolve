import { watch as watchDirectory } from "node:fs";
import path from "node:path";
import {
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
import {
  initialStateRootSelection,
  stateRootIdentity,
} from "./self-evolve-state-root.js";
import {
  UI_CAPABILITIES,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
} from "./self-evolve-ui-protocol.js";

const DEFAULT_POLL_MS = 250;
const MIN_POLL_MS = 25;
const MAX_POLL_MS = 5_000;
const MAX_PENDING_RESPONSES = 32;
const MAX_RESIDENT_DETAILS = 2;
const PATH_EVENTS = Object.freeze([
  "project.updated",
  "route.changed",
  "workspace.updated",
]);
const CLIENT_OFFER = Object.freeze({
  projectionVersions: Object.freeze([UI_PROJECTION_VERSION]),
  operationProtocolVersions: Object.freeze([UI_OPERATION_PROTOCOL_VERSION]),
  capabilities: UI_CAPABILITIES,
});
const runtimes = new Map();

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function errorReason(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedPollMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.trunc(value)));
}

function pathIdentityFor(api, context) {
  return JSON.stringify([
    "self-evolve-tui-path-v1",
    context.stateRootIdentity,
    context.projectFingerprint,
    context.worktreePath,
    api.state?.path?.directory ?? null,
  ]);
}

export function resolveTuiStoreContext(api, config = {}) {
  const stateRoot = initialStateRootSelection({
    explicitStateRoot: config.stateRoot,
    hostStateRoot: api.state?.path?.state,
    environment: {},
  }).stateRoot;
  const identity = resolveProjectIdentity({
    projectFingerprint: config.projectFingerprint,
    remoteUrl: config.remoteUrl,
    worktreePath: config.worktree ?? api.state?.path?.worktree,
    directory: api.state?.path?.directory,
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
    pathIdentity: pathIdentityFor(api, context),
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
  return deepFreeze({
    requestId: value.requestId,
    kind: value.kind,
    action: typeof value.action === "string" ? value.action : null,
    submittedAt: Number.isSafeInteger(value.submittedAt) && value.submittedAt >= 0 ? value.submittedAt : 0,
    ...(value.kind === "operation" && value.request ? { request: value.request } : {}),
  });
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

export function deriveSidebarCard(snapshot) {
  const projection = snapshot?.projection;
  const index = projection?.index;
  if (!index) {
    if (snapshot?.phase !== "error") return null;
    return deepFreeze({
      kind: "setup",
      tone: "warning",
      title: "Self-evolve needs attention",
      summary: "Native project state is unavailable",
      count: 1,
    });
  }
  const reviews = Array.isArray(index.reviews) ? index.reviews : [];
  const operations = Array.isArray(index.operations) ? index.operations : [];
  const failures = reviews.filter((review) => review.state === "failed-closed");
  if (failures.length) {
    return deepFreeze({
      kind: "failure",
      tone: "error",
      title: "Self-evolve blocked",
      summary: `${plural(failures.length, "failed check")} needs review`,
      count: failures.length,
    });
  }
  const status = index.status;
  if (status && status.state !== "ready") {
    const labels = {
      corrupt: "Durable state needs recovery",
      "setup-required": "Setup is required",
      "startup-pending": "Startup checks are pending",
      terminal: "Self-evolve is stopped",
      unavailable: "Server state is unavailable",
    };
    return deepFreeze({
      kind: "setup",
      tone: status.state === "corrupt" || status.state === "terminal" ? "error" : "warning",
      title: "Self-evolve needs attention",
      summary: labels[status.state] ?? "Project state needs attention",
      count: 1,
    });
  }
  const activeOperations = operations.filter((operation) => ["queued", "running", "accepted-terminal"].includes(operation.status));
  if (activeOperations.length || (Array.isArray(snapshot?.pending) && snapshot.pending.length)) {
    const count = Math.max(activeOperations.length, snapshot?.pending?.length ?? 0);
    return deepFreeze({
      kind: "operation",
      tone: "info",
      title: "Self-evolve is working",
      summary: `${plural(count, "operation")} in progress`,
      count,
    });
  }
  const pending = reviews.filter((review) => ["critic-pending", "pending", "approved"].includes(review.state));
  if (pending.length) {
    return deepFreeze({
      kind: "review",
      tone: pending.some((review) => review.attention === "critical") ? "error" : "warning",
      title: "Self-evolve review",
      summary: `${plural(pending.length, "proposal")} ready`,
      count: pending.length,
    });
  }
  const audits = reviews.filter((review) => review.state === "applied");
  if (audits.length) {
    return deepFreeze({
      kind: "audit",
      tone: "success",
      title: "Self-evolve applied",
      summary: `${plural(audits.length, "change")} available to audit`,
      count: audits.length,
    });
  }
  return null;
}

function overflowText(label, marker) {
  if (!marker?.truncated) return null;
  return `${label} truncated: ${marker.omittedCount} item(s), ${marker.omittedBytes} byte(s) omitted`;
}

function actionLabel(value) {
  return String(value).split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function buildReviewDialogModel(snapshot, selectedProposalId) {
  const projection = snapshot?.projection;
  const index = projection?.index;
  const queue = Array.isArray(index?.reviews) ? index.reviews : [];
  if (!queue.length) return null;
  const selectedIndex = Math.max(0, queue.findIndex((review) => review.proposalId === selectedProposalId));
  const review = queue[selectedIndex];
  const detail = (projection.details ?? []).find((item) => item.proposalId === review.proposalId) ?? null;
  const actions = (projection.effectiveDetailActions?.[review.proposalId] ?? []).map((action) => ({
    action: action.action,
    label: actionLabel(action.action),
    capability: action.capability,
  }));
  if (!detail) {
    return deepFreeze({
      selectedProposalId: review.proposalId,
      selectedIndex,
      queueCount: queue.length,
      state: review.state,
      target: review.target,
      attention: review.attention,
      loading: true,
      summary: ["Loading authoritative review detail…"],
      diff: [],
      evidence: [],
      actions,
    });
  }
  const summary = detail.summary;
  const eligibility = summary.eligibility;
  const rollback = summary.rollback;
  const operation = summary.operation;
  const summaryLines = [
    `Target: ${summary.target.relativePath}`,
    `State: ${summary.state}`,
    `Effective mode: ${summary.effectiveMode}`,
    `Risk: ${summary.risk}`,
    `Rationale: ${summary.rationale}`,
    `Critic: ${summary.criticPassed ? "passed" : "not passed"} (${summary.criticScoreBasisPoints} bp)`,
    `Deterministic checks: ${summary.validDeterministic ? "passed" : "not passed"}`,
    `Injection scan: ${summary.injectionFlagged ? "flagged" : "clear"}`,
    `Token impact: ${summary.tokenImpact.estimatedTokens}/${summary.tokenImpact.budgetTokens}`,
    `Eligibility: ${eligibility.eligible ? "eligible" : "not eligible"}`,
    ...eligibility.reasons.map((reason) => `Eligibility reason: ${reason}`),
    ...eligibility.checks.map((check) => `${check.met ? "✓" : "✗"} ${check.name}: ${check.actual} / ${check.required}`),
    `Rollback: ${rollback.eligible ? "eligible" : `unavailable (${rollback.reason ?? "no reason supplied"})`}`,
    `Operation: ${operation.status}${operation.reason ? ` (${operation.reason})` : ""}`,
  ];
  const diff = [
    `Diff: ${detail.diff.kind}`,
    ...detail.diff.lines,
    overflowText("Diff", detail.diff.overflow),
  ].filter(Boolean);
  const evidence = [
    ...detail.evidence.map((item) => `${item.kind}: ${item.summary}${item.redacted ? " [redacted]" : ""}`),
    overflowText("Evidence", detail.overflow.evidence),
    ...detail.audit.map((item) => `${item.kind}: ${item.summary}`),
    overflowText("Audit", detail.overflow.audit),
    overflowText("Actions", detail.overflow.allowedActions),
  ].filter(Boolean);
  return deepFreeze({
    selectedProposalId: review.proposalId,
    selectedIndex,
    queueCount: queue.length,
    state: review.state,
    target: review.target,
    attention: review.attention,
    loading: false,
    summary: summaryLines,
    diff,
    evidence,
    actions,
  });
}

export function nextReviewProposalId(reviews, currentId, offset) {
  if (!Array.isArray(reviews) || !reviews.length || !Number.isSafeInteger(offset)) return null;
  const current = Math.max(0, reviews.findIndex((review) => review?.proposalId === currentId));
  const index = (current + offset % reviews.length + reviews.length) % reviews.length;
  return typeof reviews[index]?.proposalId === "string" ? reviews[index].proposalId : null;
}

export function createTuiDialogLease() {
  let generation = 0;
  let disposed = false;
  return Object.freeze({
    open() {
      if (disposed) throw new Error("tui-dialog-lease-disposed");
      generation += 1;
      return generation;
    },
    current(token) {
      return !disposed && token === generation;
    },
    invalidate(token) {
      if (!disposed && token === generation) generation += 1;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
    },
  });
}

export function buildControlCenterModel(snapshot) {
  const index = snapshot?.projection?.index;
  if (!index) {
    return deepFreeze({
      phase: snapshot?.phase ?? "unavailable",
      sections: {
        overview: ["Self-evolve server state is unavailable.", snapshot?.error ? `Reason: ${snapshot.error}` : "Retry after the server projection is ready."],
        reviews: ["No authoritative review queue is available."],
        settings: ["Settings are unavailable until the server publishes validated control state."],
        safety: ["Emergency controls are unavailable until the server projection is ready."],
        evidence: ["No bounded evidence projection is available."],
        health: [`Projection store: ${snapshot?.phase ?? "unavailable"}`],
        maintenance: ["Maintenance operations are unavailable until server authority is restored."],
        help: ["Use the sidebar card when attention is required.", "Headless recovery remains available through the documented server command surface."],
      },
    });
  }
  const status = index.status;
  const reviews = index.reviews ?? [];
  const operations = index.operations ?? [];
  const budgets = index.budgets ?? {};
  const control = snapshot.controlState;
  const details = snapshot.projection?.details ?? [];
  const inspection = snapshot.inspection;
  const evidenceCount = details.reduce((total, detail) => total + detail.evidence.length, 0);
  const missed = details.flatMap((detail) => detail.summary.eligibility.checks.filter((check) => !check.met));
  return deepFreeze({
    phase: snapshot.phase,
    sections: {
      overview: [
        `Status: ${status.state}${status.reason ? ` (${status.reason})` : ""}`,
        `Mode: ${status.storedMode} (effective: ${status.effectiveMode})`,
        `Paused: ${status.paused ? "yes" : "no"}`,
        `Kill switch: ${status.killSwitchActive ? "active" : "off"}`,
        `Repository: ${status.repoExcluded ? "excluded" : "included"}`,
        `Circuit breaker: ${status.circuitBreakerOpen ? "open" : "closed"}`,
      ],
      reviews: [
        `${plural(reviews.length, "review")} in the authoritative queue`,
        `${plural(reviews.filter((review) => review.state === "pending").length, "pending proposal")}`,
        `${plural(reviews.filter((review) => review.state === "applied").length, "applied audit")}`,
        `${plural(reviews.filter((review) => review.state === "failed-closed").length, "failed-closed record")}`,
        `${plural(operations.filter((operation) => ["queued", "running", "accepted-terminal"].includes(operation.status)).length, "active operation")}`,
      ],
      settings: control ? [
        `Global mode: ${control.mode}`,
        `Effective mode: ${control.effectiveMode}`,
        `Repository: ${control.repoExcluded ? "excluded" : "included"}`,
        `Allowed skill roots: ${control.allowedSkillRoots.length}`,
        ...control.allowedSkillRoots.map((root) => `Allowlisted root: ${root}`),
        ...Object.entries(control.consent).map(([key, enabled]) => `${key}: ${enabled ? "enabled" : "disabled"}`),
      ] : ["Validated settings control state is unavailable."],
      safety: [
        `Kill switch: ${status.killSwitchActive ? "active" : "off"}`,
        `Scheduling: ${status.paused ? "paused" : "running"}`,
        `Effective mode: ${status.effectiveMode}`,
        "Emergency changes are version-bound and revalidated by the server.",
      ],
      evidence: [
        `${plural(inspection?.observations?.length ?? 0, "recent sanitized observation")} loaded`,
        `${plural(inspection?.eligibility?.length ?? 0, "eligibility explanation")} loaded`,
        ...((inspection?.observations ?? []).map((item) =>
          `${new Date(item.occurredAt).toISOString()}: ${item.summary}${item.redacted ? " [redacted]" : ""}${item.injectionFlagged ? " [injection flagged]" : ""}`)),
        ...((inspection?.eligibility ?? []).flatMap((item) => [
          `${item.eligible ? "Eligible" : "Not eligible"}: ${item.reasons.join(", ") || "no reason supplied"}`,
          ...Object.entries(item.met).map(([key, value]) => `Met ${key}: ${String(value)}`),
          ...Object.entries(item.missed).map(([key, value]) => `Missed ${key}: ${String(value)}`),
        ])),
        ...(inspection?.overflow?.observations ? [`Observations truncated: ${inspection.overflow.observations} omitted`] : []),
        ...(inspection?.overflow?.eligibility ? [`Eligibility truncated: ${inspection.overflow.eligibility} omitted`] : []),
        `${plural(evidenceCount, "sanitized evidence item")} loaded for the resident review set`,
        `${plural(missed.length, "missed eligibility gate")} loaded`,
        ...missed.slice(0, 16).map((check) => `Missed ${check.name}: ${check.actual} / ${check.required}`),
        ...details.flatMap((detail) => detail.evidence.map((item) => `${item.kind}: ${item.summary}${item.redacted ? " [redacted]" : ""}`)).slice(0, 32),
        ...details.map((detail) => overflowText("Evidence", detail.overflow.evidence)).filter(Boolean),
      ],
      health: [
        `Passive calls/hour: ${budgets.passiveCallsPerHour ?? "unavailable"}`,
        `Syntheses/day: ${budgets.synthesisPerDay ?? "unavailable"}`,
        `Tokens/synthesis: ${budgets.tokensPerSynthesis ?? "unavailable"}`,
        `Storage quota MiB: ${budgets.storageQuotaMiB ?? "unavailable"}`,
        `Idle debounce ms: ${budgets.idleDebounceMs ?? "unavailable"}`,
      ],
      maintenance: [
        "Scoped purge supports observations, proposals, or this project.",
        "Sensitive export requires exact confirmation and never opens automatically.",
        "Active skill content and rollback snapshots may be sensitive.",
        "Purge all is accepted-terminal and requires an OpenCode restart.",
        ...(snapshot.latestExport ? [
          `Latest export: ${snapshot.latestExport.path}`,
          `Export scope: ${snapshot.latestExport.scope}`,
          `Export size: ${snapshot.latestExport.bytes} bytes`,
          `Export SHA-256: ${snapshot.latestExport.sha256}`,
          `Export expires: ${new Date(snapshot.latestExport.expiresAt).toISOString()}`,
        ] : ["No unexpired native export artifact is available."]),
      ],
      help: [
        "The sidebar card appears only when operator attention is required.",
        "Review actions are revalidated by the server before mutation.",
        "Background refresh never opens dialogs or emits notifications.",
        "Headless recovery remains available through the documented server command surface.",
      ],
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
    this.pollMs = dependencies.pollMs;
    this.pending = new Map();
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
    return deepFreeze({
      phase,
      key: this.context.key,
      stateRootIdentity: this.context.stateRootIdentity,
      projectFingerprint: this.context.projectFingerprint,
      worktreePath: this.context.worktreePath,
      projection,
      controlState,
      latestExport,
      inspection,
      pending: [...this.pending.values()],
      responses: this.responses,
      watcher: this.watcher ? "active" : "polling",
      watcherError: this.watcherError,
      revision: this.readCount,
      updatedAt: this.now(),
      error,
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

  trackPending(value) {
    const clean = cleanPending(value);
    this.pending.set(clean.requestId, clean);
    while (this.pending.size > MAX_PENDING_RESPONSES) this.pending.delete(this.pending.keys().next().value);
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

  async submitDecision({ proposalId, newState }) {
    await this.requestRefresh("decision-preflight");
    const uiAction = newState === "approved" ? "apply-proposal" : "reject-proposal";
    const advertised = this.snapshot.projection?.effectiveDetailActions?.[proposalId]
      ?.some((action) => action.action === uiAction);
    if (!advertised) throw new Error("decision-not-authorized-by-current-projection");
    const inbox = await this.client.readInbox();
    const proposal = inbox?.find?.((item) => item.id === proposalId);
    if (!proposal) throw new Error("proposal-not-found-or-not-authorized");
    const timestamp = this.now();
    const request = createDecisionRequest({
      projectFingerprint: this.context.projectFingerprint,
      proposal,
      newState,
      timestamp,
    });
    await this.client.submitDecision(request);
    await this.trackPending({
      requestId: request.requestId,
      kind: "decision",
      action: uiAction,
      submittedAt: timestamp,
    });
    return request;
  }

  async submitControl(action, payload) {
    await this.requestRefresh("control-preflight");
    const controlState = await this.client.readControlState();
    if (!controlState) throw new Error("control-state-unavailable");
    const timestamp = this.now();
    const request = createControlRequest({ controlState, action, payload, timestamp });
    await this.client.submitControl(request);
    await this.trackPending({
      requestId: request.requestId,
      kind: "control",
      action,
      submittedAt: timestamp,
    });
    return request;
  }

  async submitOperation(action, payload = {}, { proposalId } = {}) {
    await this.requestRefresh("operation-preflight");
    const projection = this.snapshot.projection;
    if (!projection?.index) throw new Error("operation-projection-unavailable");
    const detail = proposalId
      ? projection.details?.find((item) => item.proposalId === proposalId)
      : null;
    const grant = (detail?.allowedActions ?? projection.index.allowedActions ?? [])
      .find((item) => item.action === action);
    if (!grant) throw new Error("operation-not-authorized");
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
      submittedAt: timestamp,
      request,
    });
    return request;
  }

  requestRefresh() {
    if (this.disposed) return Promise.resolve(this.snapshot);
    this.refreshQueued = true;
    const completion = new Promise((resolve) => this.refreshWaiters.push(resolve));
    if (!this.refreshInFlight && !this.refreshScheduled) {
      this.refreshScheduled = true;
      this.queueMicrotask(() => void this.runRefresh());
    }
    return completion;
  }

  settleWaiters() {
    const waiters = this.refreshWaiters.splice(0);
    for (const resolve of waiters) resolve(this.snapshot);
  }

  async runRefresh() {
    this.refreshScheduled = false;
    if (this.disposed || this.refreshInFlight || !this.refreshQueued) return;
    this.refreshQueued = false;
    this.refreshInFlight = true;
    const lease = this.epoch;
    try {
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
      let pending = [...this.pending.values()];
      let responses = [];
      if (typeof this.client.reconcilePending === "function" && pending.length) {
        const reconciled = await this.client.reconcilePending(pending, { context: this.context });
        pending = Array.isArray(reconciled?.pending) ? reconciled.pending.map(cleanPending) : pending;
        responses = Array.isArray(reconciled?.responses) ? reconciled.responses : [];
      }
      if (this.disposed || lease !== this.epoch) return;
      this.pending = new Map(pending.map((entry) => [entry.requestId, entry]));
      this.responses = deepFreeze([...this.responses, ...responses].slice(-MAX_PENDING_RESPONSES));
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
      this.readCount += 1;
      this.snapshot = this.makeSnapshot({
        phase: "error",
        projection: this.snapshot.projection,
        controlState: this.snapshot.controlState,
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
    this.settleWaiters();
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
    this.localSnapshot = deepFreeze({
      phase: "initializing",
      projection: null,
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
    api.lifecycle?.onDispose?.(() => this.dispose());
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
    let context;
    try {
      context = resolveTuiStoreContext(this.api, this.config);
    } catch (error) {
      this.runtime?.detach(this);
      this.runtime = null;
      this.context = null;
      this.receive(deepFreeze({
        phase: "error",
        projection: null,
      controlState: null,
      latestExport: null,
      inspection: null,
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
