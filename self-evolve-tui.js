import { DEFAULT_BUDGETS, makeDecision } from "./self-evolve-schemas.js";
import path from "node:path";
import {
  BRIDGE_ACTOR,
  createControlRequest,
  createDecisionRequest,
  pollDecisionResponse,
  pollControlResponse,
  publishTuiHostHealth,
  readControlState,
  readProjectInbox,
  revokeTuiHostHealth,
  submitControlRequest,
  submitDecisionRequest,
} from "./self-evolve-bridge.js";
import { resolveProjectIdentity } from "./self-evolve-store.js";
import {
  initialStateRootSelection,
  stateRootIdentity,
  validateProjectedStateRoot,
} from "./self-evolve-state-root.js";

/** @typedef {import("@opencode-ai/plugin/tui").TuiPlugin} TuiPlugin */
/** @typedef {import("@opencode-ai/plugin/tui").TuiPluginApi} TuiPluginApi */

const PREVIEW_LINE_LIMIT = 50;
const NOTIFICATION_KEY = "self-evolve:notification-history";
const FIRST_USE_KEY = "self-evolve:first-use-seen";
const DISMISSED_KEY = "self-evolve:dismissed-ids";
const LAST_SHOWN_KEY = "self-evolve:last-shown-at";
const PENDING_REQUESTS_KEY = "self-evolve:pending-request-ids";
const ACTOR = BRIDGE_ACTOR;
const MAX_SERVER_WAIT_MS = 5_000;
const HOST_HEALTH_REFRESH_MS = 15_000;
export const REVIEW_BOOKKEEPING_CAP = 256;
export const REVIEW_BOOKKEEPING_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const CONSENT_LABELS = Object.freeze({
  passiveCalls: "Passive provider calls",
  durableObservations: "Durable observations",
  sanitizedExcerpts: "Sanitized excerpts",
  crossRepoAggregation: "Cross-repository aggregation",
});

function nowFor(api) {
  return typeof api.now === "function" ? api.now() : Date.now();
}

function lines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
}

function boundedPreview(inputLines) {
  if (inputLines.length <= PREVIEW_LINE_LIMIT) return inputLines.join("\n");
  return [...inputLines.slice(0, PREVIEW_LINE_LIMIT), "[truncated - use /self-evolve review <id> for full content]"].join("\n");
}

function proposalContent(proposal) {
  return proposal.proposedContent ?? proposal.appliedContent ?? proposal.content ?? "";
}

export function formatProposalDigest(proposal, inventory = {}) {
  const target = proposal?.skillTarget?.relativePath ?? proposal?.target ?? "unknown skill";
  const risk = proposal?.injectionFlagged
    ? "critical"
    : proposal?.risk ?? (proposal?.criticPassed === false || proposal?.validDeterministic === false ? "high" : "low");
  const currentTokens = Number(inventory?.currentTokens ?? proposal?.currentTokens ?? 0);
  const proposedTokens = Number(inventory?.proposedTokens ?? proposal?.proposedTokens ?? 0);
  const tokenDelta = Number.isFinite(proposal?.tokenDelta)
    ? proposal.tokenDelta
    : Number.isFinite(currentTokens) && Number.isFinite(proposedTokens)
      ? proposedTokens - currentTokens
      : 0;
  const actionLabel = proposal?.state === "applied" ? "Review applied change" : proposal?.state === "pending" ? "Review proposal" : proposal?.state === "failed-closed" ? "Critical failed-closed record" : "Review record";
  return {
    title: `${actionLabel}: ${target}`,
    body: String(proposal?.rationaleText ?? proposal?.rationale ?? "No rationale supplied."),
    risk,
    tokenDelta,
    actionLabel,
  };
}

export function formatDiffOrNewSkillPreview(proposal, currentContent) {
  const proposedLines = lines(proposalContent(proposal));
  if (currentContent === undefined || currentContent === null || currentContent === "") {
    return { kind: "new", previewText: boundedPreview(proposedLines), linesChanged: proposedLines.length };
  }
  const currentLines = lines(currentContent);
  const changed = [];
  const length = Math.max(currentLines.length, proposedLines.length);
  let linesChanged = 0;
  for (let index = 0; index < length; index += 1) {
    if (currentLines[index] === proposedLines[index]) continue;
    linesChanged += 1;
    if (currentLines[index] !== undefined) changed.push(`- ${currentLines[index]}`);
    if (proposedLines[index] !== undefined) changed.push(`+ ${proposedLines[index]}`);
  }
  return { kind: "diff", previewText: boundedPreview(changed), linesChanged };
}

export function formatEligibilityExplanation(eligibility = {}) {
  const output = [];
  for (const reason of eligibility.reasons ?? []) output.push(`- ${reason}`);
  for (const [name, value] of Object.entries(eligibility.thresholdsMet ?? {})) output.push(`- Met ${name}: ${value}`);
  for (const [name, value] of Object.entries(eligibility.thresholdsMissed ?? {})) output.push(`- Missing ${name}: ${value}`);
  if (!output.length) output.push(`- Eligibility: ${eligibility.eligible === false ? "not eligible" : "validated"}`);
  return output;
}

export function safeIdlePredicate(api, debounceMs) {
  let idleSince;
  let routedSessionID;
  let priorKind;
  return () => {
    const sessionID = api.route?.current?.params?.sessionID;
    const status = typeof api.state?.session?.status === "function" ? api.state.session.status(sessionID) : api.state?.session?.status;
    const kind = typeof status === "string" ? status : status?.type ?? status?.status;
    const routeChanged = routedSessionID !== undefined && sessionID !== routedSessionID;
    if (sessionID !== routedSessionID) {
      routedSessionID = sessionID;
      idleSince = undefined;
    }
    if (kind !== "idle") {
      idleSince = undefined;
      priorKind = kind;
      return false;
    }
    const now = nowFor(api);
    const reportedSince = status && typeof status === "object" ? status.since ?? status.updatedAt : undefined;
    if (idleSince === undefined) {
      idleSince = routeChanged || (priorKind !== undefined && priorKind !== "idle")
        ? now
        : Number.isFinite(reportedSince) ? reportedSince : now;
    }
    priorKind = kind;
    return now - idleSince >= debounceMs;
  };
}

export function pruneReviewBookkeeping({ proposals = [], dismissedIds = [], lastShownAt = {}, now = Date.now(), cap = REVIEW_BOOKKEEPING_CAP } = {}) {
  const boundedCap = Number.isSafeInteger(cap) && cap >= 0 ? cap : REVIEW_BOOKKEEPING_CAP;
  const visibleIds = new Set(proposals
    .filter((proposal) => proposal && ["pending", "applied", "failed-closed"].includes(proposal.state))
    .map((proposal) => proposal.id));
  const dismissed = [...new Set(Array.isArray(dismissedIds) ? dismissedIds.filter((id) => typeof id === "string" && visibleIds.has(id)) : [])]
    .slice(-boundedCap);
  const shown = Object.entries(lastShownAt && typeof lastShownAt === "object" && !Array.isArray(lastShownAt) ? lastShownAt : {})
    .filter(([id, timestamp]) => typeof id === "string"
      && Number.isFinite(timestamp)
      && visibleIds.has(id)
      && timestamp >= now - REVIEW_BOOKKEEPING_MAX_AGE_MS)
    .sort((left, right) => left[1] - right[1])
    .slice(-boundedCap);
  return { dismissedIds: dismissed, lastShownAt: Object.fromEntries(shown) };
}

export function notificationRateLimiter(api, budgetPerHour) {
  const budget = Math.max(0, Math.trunc(budgetPerHour));
  const recent = () => {
    const cutoff = nowFor(api) - 3_600_000;
    const stored = api.kv.get(NOTIFICATION_KEY, []);
    return Array.isArray(stored) ? stored.filter((entry) => Number.isFinite(entry?.at) && entry.at > cutoff) : [];
  };
  return {
    canNotify(reason) {
      const history = recent();
      return history.length < budget
        ? { ok: true, remaining: budget - history.length, reason }
        : { ok: false, reason: "notification-budget-exhausted" };
    },
    record(reason) {
      const history = recent();
      history.push({ at: nowFor(api), reason: String(reason ?? "proposal") });
      api.kv.set(NOTIFICATION_KEY, history);
      return { ok: true, remaining: Math.max(0, budget - history.length) };
    },
  };
}

export function buildDecisionFromDialog(proposal, choice, actor) {
  const states = {
    apply: "approved",
    snooze: "pending",
    dismiss: "rejected",
    exclude: "rejected",
    undo: "rolled-back",
  };
  const normalized = String(choice).toLowerCase();
  const newState = states[normalized];
  if (!newState) throw new TypeError(`unsupported-dialog-choice: ${choice}`);
  const timestamp = proposal.decisionTimestamp ?? proposal.synthesizedAt ?? 0;
  const decisionVersion = proposal.decisionVersion + 1;
  if (!proposal.decisionNonce) throw new TypeError("server-issued-nonce-unavailable");
  const nonce = proposal.decisionNonce;
  return makeDecision({
    proposalId: proposal.id,
    targetHash: proposal.skillTarget.currentHash,
    proposedContentHash: proposal.proposedContentHash,
    decisionVersion,
    actor,
    timestamp,
    nonce,
    priorState: proposal.state,
    newState,
  });
}

export function shouldShowProposal(proposal, { lastShownAt = {}, dismissedIds = [], now = Date.now() } = {}) {
  if (!proposal || !["pending", "applied", "failed-closed"].includes(proposal.state)) return false;
  if (new Set(dismissedIds).has(proposal.id)) return false;
  if (Number.isFinite(proposal.snoozedUntil) && proposal.snoozedUntil > now) return false;
  const shown = typeof lastShownAt === "number" ? lastShownAt : lastShownAt?.[proposal.id];
  const changedAt = proposal.updatedAt ?? proposal.appliedAt ?? proposal.synthesizedAt ?? 0;
  return !Number.isFinite(shown) || shown < changedAt;
}

function resultFailure(result) {
  if (result?.ok === false) return result.reason ?? "decision-failed";
  return null;
}

function dialogError(api, message) {
  api.ui.DialogAlert({
    title: "Self-evolve error",
    message: `${message}. See /self-evolve health for details.`,
  });
}

export function parseAllowlistInput(value) {
  const roots = String(value ?? "").split(/\r?\n|,/u).map((item) => item.trim()).filter(Boolean);
  if (roots.length > 32 || new Set(roots).size !== roots.length) throw new Error("invalid-allowlist");
  for (const root of roots) if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new Error("allowlist-roots-must-be-canonical-absolute-paths");
  return roots;
}

/** @type {TuiPlugin} */
export async function SelfEvolveTuiPlugin(api, options = {}, meta) {
  const config = options?.selfEvolve ?? options ?? {};
  const debounceMs = Number.isFinite(config.idleDebounceMs) ? config.idleDebounceMs : DEFAULT_BUDGETS.idleDebounceMs;
  const budget = Number.isFinite(config.notificationsPerHour) ? config.notificationsPerHour : DEFAULT_BUDGETS.notificationsPerHour;
  const eventType = config.eventType ?? "self-evolve.proposal";
  const serverTimeoutMs = Math.min(MAX_SERVER_WAIT_MS, Math.max(1, Number.isFinite(config.serverTimeoutMs) ? config.serverTimeoutMs : MAX_SERVER_WAIT_MS));
  const pollMs = Math.min(5_000, Math.max(25, Number.isFinite(config.mailboxPollMs) ? config.mailboxPollMs : 250));
  let stateRoot;
  try {
    stateRoot = initialStateRootSelection({
      explicitStateRoot: config.stateRoot,
      hostStateRoot: api.state?.path?.state,
      environment: {},
    }).stateRoot;
  } catch (error) {
    console.warn(`self-evolve TUI disabled: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  let identity;
  try {
    identity = resolveProjectIdentity({
      projectFingerprint: config.projectFingerprint,
      remoteUrl: config.remoteUrl,
      worktreePath: config.worktree ?? api.state?.path?.worktree,
      directory: api.state?.path?.directory,
    });
  } catch (error) {
    console.warn(`self-evolve TUI disabled: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const projectFingerprint = identity.projectFingerprint;
  const tuiHostVersion = typeof api.app?.version === "string" ? api.app.version.trim() : "";
  let hostHealthTimer;
  let hostHealthNonce;
  let hostHealthStopped = false;
  let hostHealthWarningShown = false;
  const publishHostHealth = () => {
    if (!tuiHostVersion) return;
    try {
      const health = publishTuiHostHealth(stateRoot, {
        projectFingerprint,
        stateRootIdentity: stateRootIdentity(stateRoot),
        hostVersion: tuiHostVersion,
        nonce: hostHealthNonce,
        issuedAt: nowFor(api),
      });
      hostHealthNonce = health.nonce;
    } catch (error) {
      if (!hostHealthWarningShown) {
        hostHealthWarningShown = true;
        console.warn(`self-evolve TUI host-health publication failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  if (tuiHostVersion) {
    publishHostHealth();
    hostHealthTimer = setInterval(publishHostHealth, HOST_HEALTH_REFRESH_MS);
    hostHealthTimer.unref?.();
  }
  const stopHostHealth = () => {
    if (hostHealthStopped) return;
    hostHealthStopped = true;
    clearInterval(hostHealthTimer);
    if (!hostHealthNonce) return;
    try {
      revokeTuiHostHealth(stateRoot, projectFingerprint, {
        nonce: hostHealthNonce,
        stateRootIdentity: stateRootIdentity(stateRoot),
      });
    } catch {}
  };
  if (typeof api.ui?.DialogConfirm !== "function" || typeof api.ui?.DialogSelect !== "function") {
    console.warn("self-evolve TUI dialogs disabled: native dialog capabilities are unavailable; host health remains published and proposals remain in the durable inbox");
    api.lifecycle.signal.addEventListener("abort", stopHostHealth, { once: true });
    api.lifecycle.onDispose(() => {
      stopHostHealth();
      api.lifecycle.signal.removeEventListener("abort", stopHostHealth);
    });
    return;
  }
  const mailbox = options?.__testMailboxClient ?? api.__testMailboxClient ?? (stateRoot && projectFingerprint ? {
    getInbox: () => {
      const projection = readControlState(stateRoot, projectFingerprint, { now: nowFor(api) });
      if (!projection) return [];
      validateProjectedStateRoot(stateRoot, projection.stateRootIdentity);
      return readProjectInbox(stateRoot, projectFingerprint, { now: nowFor(api) });
    },
    submit: (request) => submitDecisionRequest(stateRoot, request),
    poll: (requestId) => pollDecisionResponse(stateRoot, projectFingerprint, requestId),
    getControlState: () => {
      const projection = readControlState(stateRoot, projectFingerprint, { now: nowFor(api) });
      if (projection) validateProjectedStateRoot(stateRoot, projection.stateRootIdentity);
      return projection;
    },
    submitControl: (request) => submitControlRequest(stateRoot, request),
    pollControl: (requestId) => pollControlResponse(stateRoot, projectFingerprint, requestId),
  } : null);
  const idle = safeIdlePredicate(api, debounceMs);
  const limiter = notificationRateLimiter(api, budget);
  const inFlight = new Set();
  const unsubscribers = [];
  let disposed = false;
  let refreshPending = false;
  let refreshInFlight = false;
  let refreshMicrotaskQueued = false;
  let refreshTimer = null;
  let pollTimer;

  const dismissedIds = () => {
    const value = api.kv.get(DISMISSED_KEY, []);
    return Array.isArray(value) ? value : [];
  };
  const lastShownAt = () => {
    const value = api.kv.get(LAST_SHOWN_KEY, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  const dialogsEnabled = () => api.kv.get(FIRST_USE_KEY) === true;

  function saveReviewBookkeeping(proposals) {
    const pruned = pruneReviewBookkeeping({
      proposals,
      dismissedIds: dismissedIds(),
      lastShownAt: lastShownAt(),
      now: nowFor(api),
    });
    api.kv.set(DISMISSED_KEY, pruned.dismissedIds);
    api.kv.set(LAST_SHOWN_KEY, pruned.lastShownAt);
    return pruned;
  }

  async function boundedMailboxCall(task) {
    let timeout;
    try {
      return await Promise.race([
        task(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("mailbox-read-timeout")), serverTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getInbox() {
    if (typeof mailbox?.getInbox !== "function") return [];
    const value = await boundedMailboxCall(() => mailbox.getInbox());
    return Array.isArray(value) ? value : [];
  }

  async function getFreshProposal(proposalId) {
    return (await getInbox()).find((proposal) => proposal.id === proposalId) ?? null;
  }

  function pendingRequests() {
    const value = api.kv.get(PENDING_REQUESTS_KEY, []);
    return Array.isArray(value) ? value.filter((item) => item && typeof item.requestId === "string") : [];
  }

  function savePendingRequests(value) {
    api.kv.set(PENDING_REQUESTS_KEY, value.slice(-32));
  }

  async function pollResponse(requestId, timeoutMs = serverTimeoutMs, kind = "decision") {
    const startedAt = Date.now();
    while (!disposed && !api.lifecycle.signal.aborted && Date.now() - startedAt <= timeoutMs) {
      const response = kind === "control" ? await mailbox.pollControl(requestId) : await mailbox.poll(requestId);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, pollMs)));
    }
    return null;
  }

  async function refreshResponses() {
    if (typeof mailbox?.poll !== "function") return;
    const remaining = [];
    for (const pending of pendingRequests()) {
      try {
        const response = pending.kind === "control" ? await mailbox.pollControl?.(pending.requestId) : await mailbox.poll(pending.requestId);
        if (!response) {
          remaining.push(pending);
        } else if (!response.ok) {
          api.ui.DialogAlert({ title: "Self-evolve decision rejected", message: `${response.reason}. The durable inbox will be refreshed.` });
        }
      } catch {
        remaining.push(pending);
      }
    }
    savePendingRequests(remaining);
  }

  function busyDialog(proposal, body) {
    api.ui.DialogSelect({
      title: `Applying decision: ${proposal.skillTarget?.relativePath ?? proposal.id}`,
      options: [{ title: "Working...", value: "busy", description: body, disabled: true }],
      skipFilter: true,
    });
  }

  async function submitChoice(proposal, choice, body) {
    if (inFlight.has(proposal.id)) return { ok: false, reason: "decision-in-flight" };
    inFlight.add(proposal.id);
    busyDialog(proposal, body);
    try {
      const fresh = await getFreshProposal(proposal.id);
      if (!fresh) throw new Error("proposal-not-found");
      if (choice === "undo" && fresh.state !== "applied") throw new Error("proposal-not-applied");
      const decision = buildDecisionFromDialog({ ...fresh, decisionTimestamp: nowFor(api) }, choice, ACTOR);
      if (typeof mailbox?.submit !== "function" || typeof mailbox?.poll !== "function") throw new Error("filesystem-mailbox-unavailable");
      const request = createDecisionRequest({ projectFingerprint: projectFingerprint ?? fresh.projectFingerprint, proposal: { ...fresh, decisionNonce: decision.nonce }, newState: decision.newState, actor: ACTOR, timestamp: decision.timestamp });
      await mailbox.submit(request);
      savePendingRequests([...pendingRequests(), { requestId: request.requestId, proposalId: fresh.id, submittedAt: nowFor(api) }]);
      const result = await pollResponse(request.requestId);
      if (!result) {
        api.ui.DialogAlert({ title: "Self-evolve decision queued", message: "The server has not responded yet. The request remains queued and will be checked at the next safe idle refresh." });
        queueRefresh();
        return { ok: false, reason: "decision-response-pending" };
      }
      savePendingRequests(pendingRequests().filter((item) => item.requestId !== request.requestId));
      const failure = resultFailure(result);
      if (failure) {
        if (/stale|nonce|replay|hash|version/.test(failure)) {
          api.ui.DialogAlert({ title: "Proposal changed", message: `${failure}. The durable inbox will be refreshed.` });
          queueRefresh();
          return { ok: false, reason: failure };
        }
        throw new Error(failure);
      }
      const shown = lastShownAt();
      api.kv.set(LAST_SHOWN_KEY, { ...shown, [fresh.id]: nowFor(api) });
      if (choice === "dismiss") api.kv.set(DISMISSED_KEY, [...new Set([...dismissedIds(), fresh.id])]);
      return { ok: true, decision };
    } catch (error) {
      dialogError(api, error instanceof Error ? error.message : String(error));
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      inFlight.delete(proposal.id);
    }
  }

  async function getControlState() {
    if (typeof mailbox?.getControlState !== "function") throw new Error("control-state-unavailable");
    const state = await boundedMailboxCall(() => mailbox.getControlState());
    if (!state) throw new Error("control-grant-unavailable");
    return state;
  }

  async function submitControl(action, payload) {
    try {
      if (typeof mailbox?.submitControl !== "function" || typeof mailbox?.pollControl !== "function") throw new Error("control-mailbox-unavailable");
      const controlState = await getControlState();
      const request = createControlRequest({ controlState, action, payload, timestamp: nowFor(api) });
      await mailbox.submitControl(request);
      savePendingRequests([...pendingRequests(), { kind: "control", requestId: request.requestId, submittedAt: nowFor(api) }]);
      const response = await pollResponse(request.requestId, serverTimeoutMs, "control");
      if (!response) {
        api.ui.DialogAlert({ title: "Self-evolve control queued", message: "The server has not responded yet. The bounded request remains queued." });
        return { ok: false, reason: "control-response-pending" };
      }
      savePendingRequests(pendingRequests().filter((item) => item.requestId !== request.requestId));
      if (!response.ok) {
        api.ui.DialogAlert({ title: "Self-evolve control rejected", message: `${response.reason}. Reopen settings to refresh server state.` });
        return { ok: false, reason: response.reason };
      }
      api.ui.toast({ variant: "success", message: "Self-evolve settings updated" });
      return { ok: true };
    } catch (error) {
      dialogError(api, error instanceof Error ? error.message : String(error));
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function confirmYolo(allowlist) {
    const visible = allowlist.map((root) => `- ${root}`).join("\n");
    api.ui.DialogConfirm({
      title: "Yolo risk confirmation 1 of 2",
      message: `Yolo may apply validated skill changes without per-change approval, only under this exact allowlist:\n${visible}`,
      onConfirm: () => api.ui.DialogConfirm({
        title: "Yolo risk confirmation 2 of 2",
        message: `Confirm unattended skill writes to exactly:\n${visible}`,
        onConfirm: () => { void submitControl("set-mode", { mode: "yolo", allowlist, confirmation: "ENABLE YOLO" }); },
      }),
    });
  }

  function promptYoloAllowlist(state) {
    api.ui.DialogPrompt({
      title: "Yolo allowlist",
      placeholder: "/canonical/skill/root (one per line)",
      value: state.allowedSkillRoots.join("\n"),
      onConfirm: (value) => {
        try {
          const allowlist = parseAllowlistInput(value);
          if (!allowlist.length) throw new Error("yolo-requires-a-non-empty-allowlist");
          confirmYolo(allowlist);
        } catch (error) { dialogError(api, error instanceof Error ? error.message : String(error)); }
      },
    });
  }

  function showModeFlow(state) {
    const options = ["manual", "auto", "yolo"].map((mode) => ({
      title: mode,
      value: mode,
      description: mode === "manual" ? "No passive work" : mode === "auto" ? "Draft automatically; approve each write" : "Allow unattended validated writes",
    }));
    const onSelect = (option) => {
      if (option.value === "yolo") return promptYoloAllowlist(state);
      api.ui.DialogConfirm({
        title: `Set self-evolve mode to ${option.value}?`,
        message: option.value === "auto" ? "Auto may make passive provider calls only when the separate consent controls permit it." : "Manual disables passive work.",
        onConfirm: () => { void submitControl("set-mode", { mode: option.value }); },
      });
    };
    api.ui.DialogSelect({ title: `Self-evolve mode (current: ${state.mode})`, options, onSelect, skipFilter: true });
  }

  function showAllowlistFlow(state) {
    api.ui.DialogPrompt({
      title: "Edit canonical skill-root allowlist",
      description: () => "This changes the only roots eligible for yolo writes. Review every path before confirming.",
      placeholder: "/canonical/skill/root (one per line)",
      value: state.allowedSkillRoots.join("\n"),
      onConfirm: (value) => {
        try {
          const allowlist = parseAllowlistInput(value);
          const visible = allowlist.length ? allowlist.map((root) => `- ${root}`).join("\n") : "(empty)";
          api.ui.DialogConfirm({
            title: "Elevated allowlist confirmation",
            message: `Replace the yolo allowlist with exactly:\n${visible}`,
            onConfirm: () => { void submitControl("update-allowlist", { allowlist, confirmation: "UPDATE ALLOWLIST" }); },
          });
        } catch (error) { dialogError(api, error instanceof Error ? error.message : String(error)); }
      },
    });
  }

  function showConsentFlow(state, key) {
    const enabled = !state.consent[key];
    if (key === "crossRepoAggregation" && enabled && !state.consent.sanitizedExcerpts) {
      api.ui.DialogAlert({ title: "Excerpt consent required", message: "Enable sanitized excerpts before cross-repository aggregation. Redaction reduces exposure; it does not guarantee secrecy." });
      return;
    }
    const disclosure = key === "sanitizedExcerpts" || key === "crossRepoAggregation"
      ? "Redaction reduces exposure but is not a secrecy guarantee. Review exports and retention policy accordingly."
      : "This setting is independent and defaults to off.";
    api.ui.DialogConfirm({
      title: `${enabled ? "Enable" : "Disable"} ${CONSENT_LABELS[key]}?`,
      message: disclosure,
      onConfirm: () => { void submitControl("set-consent", { key, enabled }); },
    });
  }

  async function openSettings() {
    try {
      const state = await getControlState();
      const options = [
        { title: "Mode", value: "mode", description: `${state.mode} (effective: ${state.effectiveMode})` },
        { title: "Skill-root allowlist", value: "allowlist", description: `${state.allowedSkillRoots.length} root(s)` },
        ...Object.entries(CONSENT_LABELS).map(([key, title]) => ({ title, value: `consent:${key}`, description: state.consent[key] ? "on" : "off" })),
        { title: "Repository exclusion", value: "repo-excluded", description: state.repoExcluded ? "excluded" : "included" },
      ];
      const onSelect = (option) => {
        if (option.value === "mode") showModeFlow(state);
        else if (option.value === "allowlist") showAllowlistFlow(state);
        else if (option.value === "repo-excluded") api.ui.DialogConfirm({
          title: state.repoExcluded ? "Include this repository?" : "Exclude this repository?",
          message: state.repoExcluded ? "Self-evolve may operate here subject to mode and consent." : "This repository will be excluded from self-evolve observation and application.",
          onConfirm: () => { void submitControl("set-repo-excluded", { excluded: !state.repoExcluded }); },
        });
        else if (option.value.startsWith("consent:")) showConsentFlow(state, option.value.slice("consent:".length));
      };
      api.ui.DialogSelect({ title: "Self-evolve durable settings", options, onSelect, skipFilter: true });
    } catch (error) { dialogError(api, error instanceof Error ? error.message : String(error)); }
  }

  function reviewBody(proposal) {
    const digest = formatProposalDigest(proposal, proposal.inventory);
    const preview = formatDiffOrNewSkillPreview(proposal, proposal.priorContent ?? proposal.currentContent);
    const eligibility = formatEligibilityExplanation(proposal.eligibility);
    return [
      digest.body,
      `Risk: ${digest.risk}`,
      `Token delta: ${digest.tokenDelta >= 0 ? "+" : ""}${digest.tokenDelta}`,
      ...eligibility,
      `${preview.kind === "new" ? "New skill" : "Diff"} (${preview.linesChanged} changed lines):`,
      preview.previewText,
    ].join("\n");
  }

  function showProposal(proposal) {
    const digest = formatProposalDigest(proposal, proposal.inventory);
    const body = reviewBody(proposal);
    const critical = proposal.state === "failed-closed";
    const audit = proposal.state === "applied" && proposal.mode === "yolo";
    const choices = critical
      ? [["Dismiss critical record", "dismiss-audit"]]
      : audit
      ? [["Undo", "undo"], ["Dismiss audit", "dismiss-audit"]]
      : [["Apply", "apply"], ["Snooze", "snooze"], ["Dismiss", "dismiss"]];
    const optionsForDialog = choices.map(([title, value]) => ({
      title,
      value,
      description: value === "undo" ? "Rollback only if the applied hash still matches." : digest.actionLabel,
      footer: body,
      disabled: value === "undo" && proposal.state !== "applied",
    }));
    const onSelect = (option) => {
      if (option.disabled || inFlight.has(proposal.id)) return;
      if (option.value === "dismiss-audit") {
        api.kv.set(DISMISSED_KEY, [...new Set([...dismissedIds(), proposal.id])]);
        return;
      }
      void submitChoice(proposal, option.value, body);
    };
    for (const option of optionsForDialog) option.onSelect = () => onSelect(option);
    api.ui.toast({ variant: "info", message: "New self-evolve proposal ready for review" });
    api.ui.DialogSelect({ title: digest.title, options: optionsForDialog, onSelect, skipFilter: true });
  }

  async function refreshInbox() {
    if (disposed || api.lifecycle.signal.aborted || !dialogsEnabled()) return { ok: false, reason: "dialogs-disabled" };
    if (!idle()) {
      return { ok: false, reason: "session-not-idle" };
    }
    try {
      await refreshResponses();
      const proposals = await getInbox();
      if (disposed || api.lifecycle.signal.aborted) return { ok: false, reason: "disposed" };
      const bookkeeping = saveReviewBookkeeping(proposals);
      const proposal = proposals.find((item) => shouldShowProposal(item, {
        lastShownAt: bookkeeping.lastShownAt,
        dismissedIds: bookkeeping.dismissedIds,
        now: nowFor(api),
      }));
      if (!proposal) return { ok: false, reason: "inbox-empty" };
      const allowance = limiter.canNotify(`proposal:${proposal.id}`);
      if (!allowance.ok) return { ok: false, reason: allowance.reason };
      limiter.record(`proposal:${proposal.id}`);
      if (typeof api.attention?.notify === "function") {
        await api.attention.notify({ title: "Self-evolve", message: "A proposal is ready for review", notification: true, sound: false });
      }
      showProposal(proposal);
      return { ok: true };
    } catch (error) {
      if (!api.lifecycle.signal.aborted) dialogError(api, error instanceof Error ? error.message : String(error));
      return { ok: false, reason: "inbox-read-failed" };
    }
  }

  async function runRefresh() {
    refreshMicrotaskQueued = false;
    if (disposed || api.lifecycle.signal.aborted || refreshInFlight || !refreshPending) return;
    refreshPending = false;
    refreshInFlight = true;
    let result;
    try {
      result = await refreshInbox();
    } finally {
      refreshInFlight = false;
      if (result?.reason === "session-not-idle") scheduleRefresh(Math.max(1, debounceMs));
      else if (refreshPending && !refreshTimer) scheduleRefresh(0);
    }
  }

  function scheduleRefresh(delay = 0) {
    if (disposed || api.lifecycle.signal.aborted) return;
    refreshPending = true;
    if (refreshInFlight || refreshTimer || refreshMicrotaskQueued) return;
    if (delay > 0) {
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (!disposed) void runRefresh();
      }, delay);
      return;
    }
    refreshMicrotaskQueued = true;
    queueMicrotask(() => void runRefresh());
  }

  function queueRefresh() {
    if (refreshTimer && idle()) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    scheduleRefresh(0);
  }

  if (api.kv.get(FIRST_USE_KEY) === undefined) {
    api.ui.DialogConfirm({
      title: "Enable self-evolve proposal dialogs?",
      message: "Self-evolve can analyze bounded structured evidence and show native proposal reviews. It never injects messages into your working session. Allow future proposal dialogs?",
      onConfirm: () => {
        api.kv.set(FIRST_USE_KEY, true);
        queueRefresh();
      },
      onCancel: () => api.kv.set(FIRST_USE_KEY, false),
    });
  }

  if (typeof api.keymap?.registerLayer === "function" && typeof api.ui?.DialogPrompt === "function") {
    api.keymap.registerLayer({
      mode: "base",
      commands: [{
        name: "self-evolve.settings",
        title: "Self-evolve settings",
        category: "Self-evolve",
        namespace: "palette",
        slashName: "self-evolve-settings",
        run: () => { void openSettings(); },
      }],
    });
  } else {
    console.warn("self-evolve settings command disabled: native keymap or prompt capabilities are unavailable");
  }

  unsubscribers.push(api.event.on(eventType, queueRefresh));
  unsubscribers.push(api.event.on("session.idle", queueRefresh));
  unsubscribers.push(api.event.on("session.status", queueRefresh));
  pollTimer = setInterval(queueRefresh, Math.max(pollMs, debounceMs || pollMs));

  const abort = () => {
    disposed = true;
    refreshPending = false;
    refreshMicrotaskQueued = false;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    clearInterval(pollTimer);
    stopHostHealth();
  };
  api.lifecycle.signal.addEventListener("abort", abort, { once: true });
  api.lifecycle.onDispose(() => {
    abort();
    api.lifecycle.signal.removeEventListener("abort", abort);
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  });

  if (dialogsEnabled()) queueRefresh();
}

export default { id: "mcrescenzo.self-evolve", tui: SelfEvolveTuiPlugin };
