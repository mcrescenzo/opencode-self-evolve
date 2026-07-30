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
import { acquireProjectTuiStore } from "./self-evolve-tui-store.js";

/** @typedef {import("@opencode-ai/plugin/tui").TuiPlugin} TuiPlugin */
/** @typedef {import("@opencode-ai/plugin/tui").TuiPluginApi} TuiPluginApi */

const PREVIEW_LINE_LIMIT = 50;
export const SELF_EVOLVE_MODULE_ID = "mcrescenzo.self-evolve";
export const TUI_IDENTITIES = Object.freeze({
  command: `${SELF_EVOLVE_MODULE_ID}.control-center`,
  route: `${SELF_EVOLVE_MODULE_ID}.control-center.route`,
  mode: `${SELF_EVOLVE_MODULE_ID}.control-center`,
  view: `${SELF_EVOLVE_MODULE_ID}.control-center`,
  paletteLayer: `${SELF_EVOLVE_MODULE_ID}.control-center.palette`,
  modeLayer: `${SELF_EVOLVE_MODULE_ID}.control-center.mode`,
});
export const TUI_KV_KEYS = Object.freeze({
  notificationHistory: `${SELF_EVOLVE_MODULE_ID}:notification-history`,
  firstUse: `${SELF_EVOLVE_MODULE_ID}:first-use-seen`,
  dismissed: `${SELF_EVOLVE_MODULE_ID}:dismissed-ids`,
  lastShown: `${SELF_EVOLVE_MODULE_ID}:last-shown-at`,
  pendingRequests: `${SELF_EVOLVE_MODULE_ID}:pending-request-ids`,
});
export const TUI_LEGACY_KV_KEYS = Object.freeze({
  notificationHistory: "self-evolve:notification-history",
  firstUse: "self-evolve:first-use-seen",
  dismissed: "self-evolve:dismissed-ids",
  lastShown: "self-evolve:last-shown-at",
  pendingRequests: "self-evolve:pending-request-ids",
});
const NOTIFICATION_KEY = TUI_KV_KEYS.notificationHistory;
const FIRST_USE_KEY = TUI_KV_KEYS.firstUse;
const DISMISSED_KEY = TUI_KV_KEYS.dismissed;
const LAST_SHOWN_KEY = TUI_KV_KEYS.lastShown;
const PENDING_REQUESTS_KEY = TUI_KV_KEYS.pendingRequests;
const TUI_SURFACE_REGISTRY = Symbol.for("mcrescenzo.self-evolve.tui.surface-registry");
const TUI_SURFACE_FINGERPRINT = "mcrescenzo.self-evolve.control-center.v1";
const TUI_KV_MAX_BYTES = 32 * 1024;
const ownedKvCache = new WeakMap();
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

function boundedJsonValue(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= TUI_KV_MAX_BYTES;
  } catch {
    return false;
  }
}

function boundedString(value, max = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= max && Buffer.byteLength(value, "utf8") <= max * 2;
}

function validNotificationHistory(value) {
  return Array.isArray(value) && value.length <= REVIEW_BOOKKEEPING_CAP
    && value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && Number.isFinite(entry.at) && boundedString(entry.reason, 160));
}

function validDismissed(value) {
  return Array.isArray(value) && value.length <= REVIEW_BOOKKEEPING_CAP && value.every((id) => boundedString(id));
}

function validLastShown(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length <= REVIEW_BOOKKEEPING_CAP
    && Object.entries(value).every(([id, timestamp]) => boundedString(id) && Number.isFinite(timestamp));
}

function validPendingRequests(value) {
  return Array.isArray(value) && value.length <= 32 && value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !boundedString(entry.requestId)) return false;
    if (entry.kind !== undefined && !["control", "decision"].includes(entry.kind)) return false;
    if (entry.proposalId !== undefined && !boundedString(entry.proposalId)) return false;
    return Number.isFinite(entry.submittedAt);
  });
}

const TUI_KV_DEFINITIONS = new Map([
  [TUI_KV_KEYS.notificationHistory, { legacy: TUI_LEGACY_KV_KEYS.notificationHistory, valid: validNotificationHistory }],
  [TUI_KV_KEYS.firstUse, { legacy: TUI_LEGACY_KV_KEYS.firstUse, valid: (value) => typeof value === "boolean" }],
  [TUI_KV_KEYS.dismissed, { legacy: TUI_LEGACY_KV_KEYS.dismissed, valid: validDismissed }],
  [TUI_KV_KEYS.lastShown, { legacy: TUI_LEGACY_KV_KEYS.lastShown, valid: validLastShown }],
  [TUI_KV_KEYS.pendingRequests, { legacy: TUI_LEGACY_KV_KEYS.pendingRequests, valid: validPendingRequests }],
]);

// Raw values at package-qualified canonical keys with a one-release read-once
// legacy fallback. Canonical values are stored UNWRAPPED so old/new TUI+server
// combinations degrade gracefully (an older peer reading the canonical key sees
// the raw value, not an envelope). Foreign protection: a value at the canonical
// key that does not satisfy our validator is left untouched (never clobbered).
export function createOwnedKv(rawKv) {
  if (!rawKv || typeof rawKv.get !== "function" || typeof rawKv.set !== "function") throw new TypeError("tui-kv-unavailable");
  const cached = ownedKvCache.get(rawKv);
  if (cached) return cached;
  const migrated = new Set();

  function readOwned(key, fallback) {
    const definition = TUI_KV_DEFINITIONS.get(key);
    if (!definition) return { value: fallback, foreign: true };
    const canonical = rawKv.get(key);
    if (canonical !== undefined) {
      if (definition.valid(canonical) && boundedJsonValue(canonical)) return { value: canonical, foreign: false };
      return { value: fallback, foreign: true };
    }
    if (!migrated.has(key)) {
      migrated.add(key);
      const legacy = rawKv.get(definition.legacy);
      if (legacy !== undefined && definition.valid(legacy) && boundedJsonValue(legacy)) {
        rawKv.set(key, legacy);
        return { value: legacy, foreign: false };
      }
    }
    return { value: fallback, foreign: false };
  }

  const ownedKv = Object.freeze({
    get(key, fallback) { return readOwned(key, fallback).value; },
    set(key, value) {
      const definition = TUI_KV_DEFINITIONS.get(key);
      if (!definition || !definition.valid(value) || !boundedJsonValue(value)) return false;
      const canonical = rawKv.get(key);
      if (canonical !== undefined && !(definition.valid(canonical) && boundedJsonValue(canonical))) return false;
      rawKv.set(key, value);
      return true;
    },
  });
  ownedKvCache.set(rawKv, ownedKv);
  return ownedKv;
}

export function claimTuiSurfaceOwnership(api) {
  if (!api || (typeof api !== "object" && typeof api !== "function")) return { owned: false, duplicate: false, reason: "invalid-tui-api" };
  let registry = api[TUI_SURFACE_REGISTRY];
  if (!(registry instanceof Map)) {
    registry = new Map();
    try { Object.defineProperty(api, TUI_SURFACE_REGISTRY, { configurable: false, enumerable: false, value: registry }); }
    catch { return { owned: false, duplicate: false, reason: "surface-registry-unavailable" }; }
  }
  const ids = [...new Set(Object.values(TUI_IDENTITIES))];
  const claims = ids.map((id) => registry.get(id));
  if (claims.some((claim) => claim && (claim.owner !== SELF_EVOLVE_MODULE_ID || claim.fingerprint !== TUI_SURFACE_FINGERPRINT))) {
    return { owned: false, duplicate: false, reason: "foreign-tui-surface" };
  }
  const duplicate = claims.every((claim) => claim?.owner === SELF_EVOLVE_MODULE_ID && claim?.fingerprint === TUI_SURFACE_FINGERPRINT);
  const token = Object.freeze({ owner: SELF_EVOLVE_MODULE_ID, fingerprint: TUI_SURFACE_FINGERPRINT });
  if (!duplicate) for (const id of ids) registry.set(id, token);
  return {
    owned: true,
    duplicate,
    owns() {
      return ids.every((id) => registry.get(id) === token);
    },
    release() {
      if (duplicate) return;
      for (const id of ids) if (registry.get(id) === token) registry.delete(id);
    },
  };
}

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
  const kv = createOwnedKv(api.kv);
  const recent = () => {
    const cutoff = nowFor(api) - 3_600_000;
    const stored = kv.get(NOTIFICATION_KEY, []);
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
      kv.set(NOTIFICATION_KEY, history);
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

function replaceDialog(api, render) {
  if (typeof api.ui?.dialog?.replace !== "function") throw new Error("native-dialog-stack-unavailable");
  api.ui.dialog.replace(render);
}

function showAlert(api, props) {
  replaceDialog(api, () => api.ui.DialogAlert(props));
}

function showConfirm(api, props) {
  replaceDialog(api, () => api.ui.DialogConfirm(props));
}

function showPrompt(api, props) {
  replaceDialog(api, () => api.ui.DialogPrompt(props));
}

function showSelect(api, props) {
  replaceDialog(api, () => api.ui.DialogSelect(props));
}

function dialogError(api, message) {
  showAlert(api, {
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
  const kv = createOwnedKv(api.kv);
  const nativeSurface = config.__nativeSidebar === true;
  const debounceMs = Number.isFinite(config.idleDebounceMs) ? config.idleDebounceMs : DEFAULT_BUDGETS.idleDebounceMs;
  const testAutoReview = config.__testAutoReview === true || api.__testAutoReview === true;
  const testNotificationBudget = Number.isFinite(config.notificationsPerHour) ? config.notificationsPerHour : DEFAULT_BUDGETS.notificationsPerHour;
  const testEventType = config.eventType ?? "self-evolve.proposal";
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
  let projectStore;
  try {
    const storeFactory = options?.__testTuiStoreFactory ?? acquireProjectTuiStore;
    projectStore = storeFactory({
      api,
      config: {
        ...config,
        stateRoot,
        projectFingerprint,
        worktree: identity.worktreePath,
      },
      clientFactory: options?.__testTuiStoreClientFactory,
    });
  } catch (error) {
    console.warn(`self-evolve native projection store disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  void projectStore?.refresh();
  if (typeof api.ui?.dialog?.replace !== "function"
      || typeof api.ui?.DialogConfirm !== "function"
      || typeof api.ui?.DialogSelect !== "function") {
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
  const testLimiter = testAutoReview ? notificationRateLimiter(api, testNotificationBudget) : null;
  const inFlight = new Set();
  const unsubscribers = [];
  let disposed = false;
  let refreshPending = false;
  let refreshInFlight = false;
  let refreshMicrotaskQueued = false;
  let refreshTimer = null;
  let pollTimer;

  const dismissedIds = () => {
    const value = kv.get(DISMISSED_KEY, []);
    return Array.isArray(value) ? value : [];
  };
  const lastShownAt = () => {
    const value = kv.get(LAST_SHOWN_KEY, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  const dialogsEnabled = () => kv.get(FIRST_USE_KEY) === true;

  function saveReviewBookkeeping(proposals) {
    const pruned = pruneReviewBookkeeping({
      proposals,
      dismissedIds: dismissedIds(),
      lastShownAt: lastShownAt(),
      now: nowFor(api),
    });
    kv.set(DISMISSED_KEY, pruned.dismissedIds);
    kv.set(LAST_SHOWN_KEY, pruned.lastShownAt);
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
    const value = kv.get(PENDING_REQUESTS_KEY, []);
    return Array.isArray(value) ? value.filter((item) => item && typeof item.requestId === "string") : [];
  }

  function savePendingRequests(value) {
    kv.set(PENDING_REQUESTS_KEY, value.slice(-32));
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
          showAlert(api, { title: "Self-evolve decision rejected", message: `${response.reason}. The durable inbox will be refreshed.` });
        }
      } catch {
        remaining.push(pending);
      }
    }
    savePendingRequests(remaining);
  }

  function busyDialog(proposal, body) {
    showSelect(api, {
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
        showAlert(api, { title: "Self-evolve decision queued", message: "The server has not responded yet. The request remains queued and will be checked at the next safe idle refresh." });
        queueRefresh();
        return { ok: false, reason: "decision-response-pending" };
      }
      savePendingRequests(pendingRequests().filter((item) => item.requestId !== request.requestId));
      const failure = resultFailure(result);
      if (failure) {
        if (/stale|nonce|replay|hash|version/.test(failure)) {
          showAlert(api, { title: "Proposal changed", message: `${failure}. The durable inbox will be refreshed.` });
          queueRefresh();
          return { ok: false, reason: failure };
        }
        throw new Error(failure);
      }
      const shown = lastShownAt();
      kv.set(LAST_SHOWN_KEY, { ...shown, [fresh.id]: nowFor(api) });
      if (choice === "dismiss") kv.set(DISMISSED_KEY, [...new Set([...dismissedIds(), fresh.id])]);
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
        showAlert(api, { title: "Self-evolve control queued", message: "The server has not responded yet. The bounded request remains queued." });
        return { ok: false, reason: "control-response-pending" };
      }
      savePendingRequests(pendingRequests().filter((item) => item.requestId !== request.requestId));
      if (!response.ok) {
        showAlert(api, { title: "Self-evolve control rejected", message: `${response.reason}. Reopen settings to refresh server state.` });
        return { ok: false, reason: response.reason };
      }
      return { ok: true };
    } catch (error) {
      dialogError(api, error instanceof Error ? error.message : String(error));
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function confirmYolo(allowlist) {
    const visible = allowlist.map((root) => `- ${root}`).join("\n");
    showConfirm(api, {
      title: "Yolo risk confirmation 1 of 2",
      message: `Yolo may apply validated skill changes without per-change approval, only under this exact allowlist:\n${visible}`,
      onConfirm: () => showConfirm(api, {
        title: "Yolo risk confirmation 2 of 2",
        message: `Confirm unattended skill writes to exactly:\n${visible}`,
        onConfirm: () => { void submitControl("set-mode", { mode: "yolo", allowlist, confirmation: "ENABLE YOLO" }); },
      }),
    });
  }

  function promptYoloAllowlist(state) {
    showPrompt(api, {
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
      showConfirm(api, {
        title: `Set self-evolve mode to ${option.value}?`,
        message: option.value === "auto" ? "Auto may make passive provider calls only when the separate consent controls permit it." : "Manual disables passive work.",
        onConfirm: () => { void submitControl("set-mode", { mode: option.value }); },
      });
    };
    showSelect(api, { title: `Self-evolve mode (current: ${state.mode})`, options, onSelect, skipFilter: true });
  }

  function showAllowlistFlow(state) {
    showPrompt(api, {
      title: "Edit canonical skill-root allowlist",
      description: () => "This changes the only roots eligible for yolo writes. Review every path before confirming.",
      placeholder: "/canonical/skill/root (one per line)",
      value: state.allowedSkillRoots.join("\n"),
      onConfirm: (value) => {
        try {
          const allowlist = parseAllowlistInput(value);
          const visible = allowlist.length ? allowlist.map((root) => `- ${root}`).join("\n") : "(empty)";
          showConfirm(api, {
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
      showAlert(api, { title: "Excerpt consent required", message: "Enable sanitized excerpts before cross-repository aggregation. Redaction reduces exposure; it does not guarantee secrecy." });
      return;
    }
    const disclosure = key === "sanitizedExcerpts" || key === "crossRepoAggregation"
      ? "Redaction reduces exposure but is not a secrecy guarantee. Review exports and retention policy accordingly."
      : "This setting is independent and defaults to off.";
    showConfirm(api, {
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
        else if (option.value === "repo-excluded") showConfirm(api, {
          title: state.repoExcluded ? "Include this repository?" : "Exclude this repository?",
          message: state.repoExcluded ? "Self-evolve may operate here subject to mode and consent." : "This repository will be excluded from self-evolve observation and application.",
          onConfirm: () => { void submitControl("set-repo-excluded", { excluded: !state.repoExcluded }); },
        });
        else if (option.value.startsWith("consent:")) showConsentFlow(state, option.value.slice("consent:".length));
      };
      showSelect(api, { title: "Self-evolve durable settings", options, onSelect, skipFilter: true });
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
        kv.set(DISMISSED_KEY, [...new Set([...dismissedIds(), proposal.id])]);
        return;
      }
      void submitChoice(proposal, option.value, body);
    };
    for (const option of optionsForDialog) option.onSelect = () => onSelect(option);
    showSelect(api, { title: digest.title, options: optionsForDialog, onSelect, skipFilter: true });
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
      const allowance = testLimiter?.canNotify(`proposal:${proposal.id}`);
      if (allowance && !allowance.ok) return { ok: false, reason: allowance.reason };
      testLimiter?.record(`proposal:${proposal.id}`);
      if (disposed || api.lifecycle.signal.aborted) return { ok: false, reason: "disposed" };
      showProposal(proposal);
      kv.set(LAST_SHOWN_KEY, { ...lastShownAt(), [proposal.id]: nowFor(api) });
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

  if (testAutoReview && kv.get(FIRST_USE_KEY) === undefined) {
    showConfirm(api, {
      title: "Enable self-evolve proposal dialogs?",
      message: "Test-only compatibility review opt-in.",
      onConfirm: () => {
        kv.set(FIRST_USE_KEY, true);
        queueRefresh();
      },
      onCancel: () => kv.set(FIRST_USE_KEY, false),
    });
  }

  const missingLegacySettingsCapabilities = [
    ...(typeof api.keymap?.registerLayer === "function" ? [] : ["keymap.registerLayer"]),
    ...(typeof api.ui?.DialogPrompt === "function" ? [] : ["ui.DialogPrompt"]),
  ];
  if (!nativeSurface && missingLegacySettingsCapabilities.length === 0) {
    api.keymap.registerLayer({
      mode: "base",
      commands: [{
        name: "self-evolve.settings",
        title: "Self-evolve settings",
        category: "Self-evolve",
        namespace: "palette",
        run: () => { void openSettings(); },
      }],
    });
  } else if (!nativeSurface) {
    console.warn(`self-evolve legacy settings command disabled: missing ${missingLegacySettingsCapabilities.join(", ")}; update external tui.json to load self-evolve-tui.tsx (@mcrescenzo/opencode-self-evolve/tui).`.slice(0, 240));
  }

  if (testAutoReview) {
    unsubscribers.push(api.event.on(testEventType, queueRefresh));
    unsubscribers.push(api.event.on("session.idle", queueRefresh));
    unsubscribers.push(api.event.on("session.status", queueRefresh));
    pollTimer = setInterval(queueRefresh, Math.max(pollMs, debounceMs || pollMs));
  }

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

  if (testAutoReview && dialogsEnabled()) queueRefresh();
}

export default { id: "mcrescenzo.self-evolve", tui: SelfEvolveTuiPlugin };
