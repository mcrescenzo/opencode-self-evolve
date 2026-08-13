import { DEFAULT_BUDGETS, makeDecision } from "./self-evolve-schemas.js";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  BRIDGE_ACTOR,
  createDecisionRequest,
  pollDecisionResponse,
  publishTuiHostHealth,
  readProjectInbox,
  revokeTuiHostHealth,
  submitDecisionRequest,
} from "./self-evolve-bridge.js";
import { resolveProjectIdentity } from "./self-evolve-store.js";
import {
  resolveStateRoot,
  stateRootIdentity,
  validateProjectedStateRoot,
} from "./self-evolve-state-root.js";
import { acquireProjectTuiStore } from "./self-evolve-tui-store.js";

/** @typedef {import("@opencode-ai/plugin/tui").TuiPlugin} TuiPlugin */
/** @typedef {import("@opencode-ai/plugin/tui").TuiPluginApi} TuiPluginApi */

const PREVIEW_LINE_LIMIT = 50;
const PROPOSAL_ACTION_LABELS = Object.freeze({
  applied: "Review applied change",
  pending: "Review proposal",
  "failed-closed": "Critical failed-closed record",
});
export const SELF_EVOLVE_MODULE_ID = "mcrescenzo.self-evolve";
export const SELF_EVOLVE_PLUGIN_VERSION = "0.4.0";
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
  acknowledgedOutcomes: `${SELF_EVOLVE_MODULE_ID}:acknowledged-outcomes-v2`,
});
export const TUI_LEGACY_KV_KEYS = Object.freeze({
  notificationHistory: "self-evolve:notification-history",
  firstUse: "self-evolve:first-use-seen",
  dismissed: "self-evolve:dismissed-ids",
  lastShown: "self-evolve:last-shown-at",
  pendingRequests: "self-evolve:pending-request-ids",
  acknowledgedAudits: "self-evolve:native-audit-acknowledged",
});
const NOTIFICATION_KEY = TUI_KV_KEYS.notificationHistory;
const FIRST_USE_KEY = TUI_KV_KEYS.firstUse;
const DISMISSED_KEY = TUI_KV_KEYS.dismissed;
const LAST_SHOWN_KEY = TUI_KV_KEYS.lastShown;
const PENDING_REQUESTS_KEY = TUI_KV_KEYS.pendingRequests;
const TUI_SURFACE_REGISTRY = Symbol.for("mcrescenzo.self-evolve.tui.surface-registry");
const TUI_SURFACE_FINGERPRINT = "mcrescenzo.self-evolve.control-center.v1";
const TUI_KV_MAX_BYTES = 32 * 1024;
const TUI_ACKNOWLEDGEMENT_MAX_BYTES = 64 * 1024;
const ownedKvCache = new WeakMap();
const acknowledgementStoreCache = new WeakMap();
const ACTOR = BRIDGE_ACTOR;
const MAX_SERVER_WAIT_MS = 5_000;
const HOST_HEALTH_REFRESH_MS = 15_000;
export const REVIEW_BOOKKEEPING_CAP = 256;
export const REVIEW_BOOKKEEPING_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

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

function validAcknowledgementBinding(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "auditIds,scope,subjectId,version"
    && ["project", "global"].includes(value.scope)
    && boundedString(value.subjectId)
    && boundedString(value.version)
    && Array.isArray(value.auditIds)
    && value.auditIds.length > 0
    && value.auditIds.length <= 64
    && value.auditIds.every((auditId) => boundedString(auditId))
    && new Set(value.auditIds).size === value.auditIds.length
    && value.auditIds.every((auditId, index) => index === 0 || value.auditIds[index - 1] < auditId);
}

function validAcknowledgedOutcomes(value) {
  return Array.isArray(value) && value.length <= REVIEW_BOOKKEEPING_CAP && value.every((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      && Object.keys(entry).sort().join(",") === "acknowledgedAt,auditIds,scope,subjectId,version"
      && validAcknowledgementBinding({
        scope: entry.scope,
        subjectId: entry.subjectId,
        version: entry.version,
        auditIds: entry.auditIds,
      })
      && Number.isSafeInteger(entry.acknowledgedAt)
      && entry.acknowledgedAt >= 0);
}

function boundedAcknowledgedOutcomes(value) {
  if (!validAcknowledgedOutcomes(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= TUI_ACKNOWLEDGEMENT_MAX_BYTES;
  } catch {
    return false;
  }
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

// Applied-result acknowledgement is presentation-only. Each project has one
// bounded host-KV key, and every entry binds an exact outcome version plus the
// authoritative audit/detail hashes that justified the acknowledgement.
export function createTuiAcknowledgementStore(rawKv, { now = Date.now } = {}) {
  if (!rawKv || typeof rawKv.get !== "function" || typeof rawKv.set !== "function") {
    throw new TypeError("tui-kv-unavailable");
  }
  if (typeof now !== "function") throw new TypeError("tui-acknowledgement-clock-required");
  const cached = acknowledgementStoreCache.get(rawKv);
  if (cached) return cached;
  function projectKey(projectFingerprint) {
    return `${TUI_KV_KEYS.acknowledgedOutcomes}:${projectFingerprint}`;
  }

  function readCanonical(projectFingerprint) {
    const stored = rawKv.get(projectKey(projectFingerprint));
    return boundedAcknowledgedOutcomes(stored) ? stored : [];
  }

  const store = Object.freeze({
    read(projectFingerprint) {
      if (!/^[a-f0-9]{64}$/u.test(String(projectFingerprint ?? ""))) return Object.freeze([]);
      return Object.freeze(readCanonical(projectFingerprint).map((entry) => Object.freeze({
        ...entry,
        auditIds: Object.freeze([...entry.auditIds]),
      })));
    },
    acknowledge(projectFingerprint, binding) {
      if (!/^[a-f0-9]{64}$/u.test(String(projectFingerprint ?? ""))) return Object.freeze([]);
      const clean = binding && typeof binding === "object" ? {
        scope: binding.scope,
        subjectId: binding.subjectId,
        version: binding.version,
        auditIds: [...new Set(Array.isArray(binding.auditIds) ? binding.auditIds : [])].sort(),
      } : null;
      if (!validAcknowledgementBinding(clean)) return this.read(projectFingerprint);
      const current = readCanonical(projectFingerprint);
      const key = projectKey(projectFingerprint);
      const canonical = rawKv.get(key);
      if (canonical !== undefined && !boundedAcknowledgedOutcomes(canonical)) {
        return Object.freeze([]);
      }
      const acknowledgedAt = Math.max(0, Math.trunc(now()));
      const merged = new Map(current.map((entry) => [
        `${entry.scope}\n${entry.subjectId}\n${entry.version}\n${entry.auditIds.join("\n")}`,
        entry,
      ]));
      const entry = { ...clean, acknowledgedAt };
      merged.set(`${clean.scope}\n${clean.subjectId}\n${clean.version}\n${clean.auditIds.join("\n")}`, entry);
      const next = [...merged.values()]
        .sort((left, right) => left.acknowledgedAt - right.acknowledgedAt
          || left.scope.localeCompare(right.scope)
          || left.subjectId.localeCompare(right.subjectId)
          || left.version.localeCompare(right.version))
        .slice(-REVIEW_BOOKKEEPING_CAP);
      if (!boundedAcknowledgedOutcomes(next)) return Object.freeze([]);
      rawKv.set(key, next);
      return this.read(projectFingerprint);
    },
  });
  acknowledgementStoreCache.set(rawKv, store);
  return store;
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
  const actionLabel = PROPOSAL_ACTION_LABELS[proposal?.state] ?? "Review record";
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

function nonEmptyPath(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function boundedTuiPath(task, timeoutMs) {
  const boundedTimeout = Math.min(10_000, Math.max(10, Number.isFinite(timeoutMs) ? timeoutMs : 2_000));
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("official-state-path-timeout")), boundedTimeout); }),
  ]).finally(() => clearTimeout(timer));
}

async function resolveTuiStartupPath(api, config = {}) {
  const statePath = api?.state?.path;
  const sourcePathApi = api?.client?.path;
  let officialPath;
  let officialPathPromise;
  const requestOfficialPath = typeof sourcePathApi?.get === "function"
    ? (directory) => {
        officialPathPromise ??= sourcePathApi.get.call(sourcePathApi, directory ? { directory } : {})
          .then((result) => {
            if (result?.data && typeof result.data === "object" && !Array.isArray(result.data)) officialPath = result.data;
            return result;
          });
        return officialPathPromise;
      }
    : null;
  const client = typeof sourcePathApi?.get === "function"
    ? {
        path: {
          async get(input = {}) {
            const directory = nonEmptyPath(input?.query?.directory);
            return requestOfficialPath(directory);
          },
        },
      }
    : api?.client;
  const stateRoot = await resolveStateRoot({
    directory: nonEmptyPath(statePath?.directory) ?? nonEmptyPath(config.worktree) ?? nonEmptyPath(statePath?.worktree),
    path: statePath,
    client,
  }, {
    stateRoot: config.stateRoot,
    env: config.env,
    stateRootTimeoutMs: config.stateRootTimeoutMs,
  });
  const hasIdentityPath = nonEmptyPath(config.worktree)
    ?? nonEmptyPath(officialPath?.worktree)
    ?? nonEmptyPath(statePath?.worktree)
    ?? nonEmptyPath(officialPath?.directory)
    ?? nonEmptyPath(statePath?.directory);
  if (!hasIdentityPath && requestOfficialPath && !officialPath) {
    try { await boundedTuiPath(() => requestOfficialPath(), config.stateRootTimeoutMs); } catch {}
  }
  return { stateRoot, officialPath };
}

export async function resolveTuiStateRoot(api, config = {}) {
  return (await resolveTuiStartupPath(api, config)).stateRoot;
}

// Fallible startup trust resolution shared by the legacy plugin and the native
// orchestrator's inert Retry. Returns the resolved root/path/identity on
// success, or a bounded failure descriptor (with phase, reason, and a
// diagnostic string) so the native shell can render what failed without ever
// holding projection, mailbox, or publication authority.
export async function attemptTuiStartup(api, config = {}) {
  let stateRoot;
  let officialPath;
  try {
    ({ stateRoot, officialPath } = await resolveTuiStartupPath(api, config));
    if (!stateRoot) throw new Error("state-root-unavailable");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, phase: "state-root", reason, diagnostic: `State root unavailable: ${reason}` };
  }
  let identity;
  try {
    identity = resolveProjectIdentity({
      projectFingerprint: config.projectFingerprint,
      remoteUrl: config.remoteUrl,
      worktreePath: nonEmptyPath(config.worktree) ?? nonEmptyPath(officialPath?.worktree) ?? nonEmptyPath(api.state?.path?.worktree),
      directory: nonEmptyPath(officialPath?.directory) ?? nonEmptyPath(api.state?.path?.directory),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, phase: "identity", reason, diagnostic: `Project identity unresolved: ${reason}` };
  }
  return { ok: true, stateRoot, officialPath, identity };
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
  let officialPath;
  let identity;
  const startup = await attemptTuiStartup(api, config);
  if (!startup.ok) {
    // Notify the native orchestrator so it can mount a zero-authority inert
    // recovery shell (sidebar/route/keymap) instead of disappearing. The legacy
    // plugin itself still returns: it holds no projection, mailbox, or host
    // health authority on a trust failure.
    if (typeof options?.__nativeStartupFailure === "function") {
      try { options.__nativeStartupFailure(startup); } catch {}
    }
    console.warn(`self-evolve TUI disabled: ${startup.reason}`);
    return;
  }
  ({ stateRoot, officialPath, identity } = startup);
  const projectFingerprint = identity.projectFingerprint;
  let projectStore;
  try {
    const storeFactory = options?.__testTuiStoreFactory ?? acquireProjectTuiStore;
    projectStore = storeFactory({
      api,
      config: {
        ...config,
        startupStateRoot: stateRoot,
        startupWorktree: identity.worktreePath,
      },
      clientFactory: options?.__testTuiStoreClientFactory,
      globalClientFactory: options?.__testTuiGlobalStoreClientFactory,
      acknowledgementStore: createTuiAcknowledgementStore(api.kv, {
        now: () => nowFor(api),
      }),
      runtimeMetadata: {
        hostVersion: typeof api.app?.version === "string" ? api.app.version : "unknown",
        hostVersionSource: "tui-app-version",
        pluginVersion: SELF_EVOLVE_PLUGIN_VERSION,
      },
    });
  } catch (error) {
    console.warn(`self-evolve native projection store disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tuiHostVersion = typeof api.app?.version === "string" ? api.app.version.trim() : "";
  const inFlight = new Set();
  const unsubscribers = [];
  let disposed = false;
  let terminalStopped = false;
  let refreshPending = false;
  let refreshInFlight = false;
  let refreshMicrotaskQueued = false;
  let refreshTimer = null;
  let pollTimer;
  let hostHealthTimer;
  let hostHealthContext = { stateRoot, projectFingerprint, nonce: undefined };
  let hostHealthStopped = false;
  let hostHealthSuspended = false;
  let hostHealthWarningShown = false;
  let hostHealthStoreUnsubscribe;
  const currentHostHealthContext = () => {
    const currentStateRoot = nonEmptyPath(config.stateRoot) ?? nonEmptyPath(api.state?.path?.state) ?? stateRoot;
    const currentIdentity = resolveProjectIdentity({
      projectFingerprint: config.projectFingerprint,
      remoteUrl: config.remoteUrl,
      worktreePath: nonEmptyPath(config.worktree) ?? nonEmptyPath(api.state?.path?.worktree) ?? identity.worktreePath,
      directory: nonEmptyPath(api.state?.path?.directory) ?? identity.worktreePath,
    });
    return { stateRoot: currentStateRoot, projectFingerprint: currentIdentity.projectFingerprint };
  };
  const revokeCurrentHostHealth = () => {
    if (!hostHealthContext.nonce) return;
    revokeTuiHostHealth(hostHealthContext.stateRoot, hostHealthContext.projectFingerprint, {
      nonce: hostHealthContext.nonce,
      stateRootIdentity: stateRootIdentity(hostHealthContext.stateRoot),
    });
    hostHealthContext.nonce = undefined;
  };
  const warnHostHealth = (error) => {
    if (!hostHealthWarningShown) {
      hostHealthWarningShown = true;
      console.warn(`self-evolve TUI host-health publication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const publishHostHealth = (targetContext) => {
    if (!tuiHostVersion || hostHealthStopped || (hostHealthSuspended && !targetContext)) return;
    try {
      const current = targetContext ?? currentHostHealthContext();
      if (targetContext && !hostHealthSuspended && hostHealthContext.nonce
          && current.stateRoot === hostHealthContext.stateRoot
          && current.projectFingerprint === hostHealthContext.projectFingerprint) return;
      if (current.stateRoot !== hostHealthContext.stateRoot
          || current.projectFingerprint !== hostHealthContext.projectFingerprint) {
        revokeCurrentHostHealth();
        hostHealthContext = { ...current, nonce: undefined };
      }
      hostHealthSuspended = false;
      const health = publishTuiHostHealth(hostHealthContext.stateRoot, {
        projectFingerprint: hostHealthContext.projectFingerprint,
        stateRootIdentity: stateRootIdentity(hostHealthContext.stateRoot),
        hostVersion: tuiHostVersion,
        nonce: hostHealthContext.nonce,
        issuedAt: nowFor(api),
      });
      hostHealthContext.nonce = health.nonce;
    } catch (error) {
      warnHostHealth(error);
    }
  };
  const suspendHostHealth = () => {
    if (hostHealthStopped || hostHealthSuspended) return;
    hostHealthSuspended = true;
    try { revokeCurrentHostHealth(); } catch (error) { warnHostHealth(error); }
  };
  const stopHostHealth = () => {
    if (hostHealthStopped) return;
    hostHealthStopped = true;
    clearInterval(hostHealthTimer);
    try { hostHealthStoreUnsubscribe?.(); } catch {}
    hostHealthStoreUnsubscribe = undefined;
    try { revokeCurrentHostHealth(); } catch {}
  };
  const stopStateRootActivity = (terminal = false) => {
    if (terminal) terminalStopped = true;
    disposed = true;
    refreshPending = false;
    refreshMicrotaskQueued = false;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    clearInterval(pollTimer);
    pollTimer = undefined;
    for (const unsubscribe of unsubscribers.splice(0)) {
      try { unsubscribe(); } catch {}
    }
    stopHostHealth();
  };
  if (tuiHostVersion) {
    if (typeof projectStore?.subscribe === "function") {
      hostHealthStoreUnsubscribe = projectStore.subscribe((snapshot) => {
        if (snapshot?.phase === "terminal") {
          stopStateRootActivity(true);
          return;
        }
        if (!snapshot?.projectFingerprint || !snapshot?.stateRootIdentity) {
          if (snapshot?.phase === "error") suspendHostHealth();
          return;
        }
        const currentStateRoot = nonEmptyPath(config.stateRoot) ?? nonEmptyPath(api.state?.path?.state) ?? stateRoot;
        if (stateRootIdentity(currentStateRoot) !== snapshot.stateRootIdentity) {
          suspendHostHealth();
          return;
        }
        publishHostHealth({ stateRoot: currentStateRoot, projectFingerprint: snapshot.projectFingerprint });
      });
    }
    if (!terminalStopped) {
      if (!hostHealthContext.nonce) publishHostHealth();
      hostHealthTimer = setInterval(publishHostHealth, HOST_HEALTH_REFRESH_MS);
      hostHealthTimer.unref?.();
    }
  }
  if (!terminalStopped) void projectStore?.refresh();
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
    getInbox: () => readProjectInbox(stateRoot, projectFingerprint, { now: nowFor(api) }),
    submit: (request) => submitDecisionRequest(stateRoot, request),
    poll: (requestId) => pollDecisionResponse(stateRoot, projectFingerprint, requestId),
  } : null);
  const idle = safeIdlePredicate(api, debounceMs);
  const testLimiter = testAutoReview ? notificationRateLimiter(api, testNotificationBudget) : null;
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
    if (terminalStopped) throw new Error("restart-required-after-purge-all");
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
      await delay(Math.min(100, pollMs));
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

  if (!terminalStopped && testAutoReview && kv.get(FIRST_USE_KEY) === undefined) {
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

  if (!terminalStopped && testAutoReview) {
    unsubscribers.push(api.event.on(testEventType, queueRefresh));
    unsubscribers.push(api.event.on("session.idle", queueRefresh));
    unsubscribers.push(api.event.on("session.status", queueRefresh));
    pollTimer = setInterval(queueRefresh, Math.max(pollMs, debounceMs || pollMs));
  }

  const abort = () => {
    stopStateRootActivity(false);
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
