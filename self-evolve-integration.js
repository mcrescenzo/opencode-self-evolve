import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import {
  BRIDGE_ACTOR,
  BRIDGE_TTL_MS,
  cleanupBridge,
  consumeGlobalActionRequests,
  consumeDecisionRequests,
  pendingGlobalActionRequestCount,
  pendingRequestCounts,
  publishGlobalRecommendationProjection,
  publishProjectParticipationSidecars,
  publishUiProjection,
  readGlobalRecommendationProjection,
} from "./self-evolve-bridge.js";
import {
  HISTORICAL_SELF_EVOLVE_AGENTS,
  HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
  isDurableLifecycleEvent,
} from "./self-evolve-core.js";
import {
  buildGlobalRecommendationProjection,
  buildProjectParticipationSidecars,
  buildUiProjection,
} from "./self-evolve-projection.js";
import { createGlobalDecisionDomain } from "./self-evolve-applier.js";
import { stateRootIdentity, validateStateRootBoundary } from "./self-evolve-state-root.js";
import { errorReasonCode, latestByLogicalId } from "./self-evolve-schemas.js";
import { ROOT_EPOCH_REINITIALIZE_CONFIRMATION } from "./self-evolve-epoch.js";
import {
  UI_ACTION_CAPABILITIES,
  UI_CAPABILITIES,
  UI_DASHBOARD_CAPABILITIES,
  UI_DASHBOARD_OUTCOMES,
  UI_DASHBOARD_REASON_CODES,
  UI_OPERATION_ACTIONS,
  UI_PROTOCOL_LIMITS,
  makeUiOperationRequest,
} from "./self-evolve-ui-protocol.js";
import { boundedHostCall, cleanupSession, deleteSession, listSessions } from "./self-evolve-client.js";
import { createSensitiveExportManager, readLatestSensitiveExport } from "./self-evolve-export.js";

const RESTART_REMINDER = "OpenCode must be restarted for the new skill content to load in existing sessions; new sessions will pick it up automatically.";
const CYCLE_OUTCOMES = new Set(UI_DASHBOARD_OUTCOMES.slice(0, 9));
const CYCLE_REASONS = new Set(UI_DASHBOARD_REASON_CODES);
const DEFAULT_ROLLOUT_GATES = Object.freeze({
  offlineCorpus: false,
  passiveShadowObservation: false,
  automaticSynthesisApplicationDisabled: false,
  autoReviewRollout: true,
  yoloEnablementThreshold: Object.freeze({ minSynthesesObserved: 10, minSuccessRate: 0.8 }),
});
const KNOWN_HIDDEN_SESSION_AGENTS = new Set([
  HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  ...Object.values(HISTORICAL_SELF_EVOLVE_AGENTS),
]);
const SESSION_ANCESTRY_MAX_DEPTH = 16;
const SESSION_ANCESTRY_TIMEOUT_MS = 250;
const TERMINAL_SESSION_STATES = new Set(["aborted", "cancelled", "completed", "error", "failed", "idle"]);
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROUTING_SETTINGS_TTL_MS = 250;
const UI_PROJECTION_REFRESH_MS = 5_000;
const UI_PROJECTION_EXPIRY_MARGIN_MS = 5_000;
const AUTONOMOUS_SHUTDOWN_TIMEOUT_MS = 10_000;
const NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : null;
const fallbackHostCleanupClaims = new WeakMap();
let hostOwnerBootGeneration = 0;

export const ROLLOUT_GATES = DEFAULT_ROLLOUT_GATES;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function mailboxRequestDigest(type, request) {
  return sha256(`self-evolve-${type}-request-completion-v1\n${JSON.stringify(request)}`);
}

function completionReason(result, fallback) {
  return result?.ok === true ? "accepted" : String(result?.reason ?? fallback).slice(0, 256);
}

function hiddenSessionState(session) {
  return String(session?.state ?? session?.status?.type ?? session?.status ?? "").toLowerCase();
}

function latestById(records) {
  return latestByLogicalId(records, { withPayload: true });
}

export async function recoverOrphanedHiddenSessions(client, directory, {
  store,
  projectFingerprint,
  rootIdentity,
  now = Date.now(),
  timeoutMs = 2_000,
  signal,
  maxSessions = 32,
} = {}) {
  const ctx = { client, directory };
  const candidates = (await listSessions(ctx, { timeoutMs, signal, label: "session-list" })).filter((session) => {
    const agent = session?.agent ?? session?.mode ?? session?.info?.agent;
    return KNOWN_HIDDEN_SESSION_AGENTS.has(agent);
  }).slice(0, maxSessions);
  const outcomes = [];
  for (const session of candidates) {
    const id = session?.id ?? session?.sessionID;
    if (!id) continue;
    const status = store?.hostOwnerStatus?.(id, { projectFingerprint, rootIdentity, now })
      ?? { classification: "unknown", reason: "host-owner-store-unavailable" };
    if (status.classification !== "abortable") {
      const action = status.classification === "live-owner" ? "deferred"
        : status.classification === "foreign" ? "foreign"
          : status.classification === "unknown" ? "unknown" : "skipped";
      outcomes.push({ id, ok: true, action, reason: status.reason ?? status.classification });
      continue;
    }
    const claimKey = `host_cleanup_${sha256(`host-session-cleanup-v1\n${id}\n${status.nonce}`)}`;
    let fallbackClaims;
    let claimed;
    if (typeof store.acquireLease === "function") {
      claimed = store.acquireLease(claimKey, {
        ttlMs: Math.max(1_000, timeoutMs + 1_000),
        actor: "self-evolve-host-session-recovery",
      });
    } else {
      fallbackClaims = fallbackHostCleanupClaims.get(store) ?? new Set();
      fallbackHostCleanupClaims.set(store, fallbackClaims);
      claimed = fallbackClaims.has(claimKey)
        ? { ok: false, reason: "lease-busy" }
        : { ok: true, nonce: claimKey };
      if (claimed.ok) fallbackClaims.add(claimKey);
    }
    if (!claimed?.ok) {
      outcomes.push({ id, ok: true, action: "deferred", reason: claimed?.reason ?? "host-owner-claim-failed" });
      continue;
    }
    try {
      const state = hiddenSessionState(session);
      if (!TERMINAL_SESSION_STATES.has(state)) {
        try { await cleanupSession(ctx, id, { timeoutMs, signal, label: "session-abort", optional: true }); }
        catch {}
      }
      await deleteSession(ctx, id, { timeoutMs, signal, label: "session-delete" });
      const released = store.releaseHostOwner?.(id, status.nonce);
      if (!released?.ok) {
        outcomes.push({ id, ok: false, action: "delete-failed", reason: released?.reason ?? "host-owner-release-failed" });
        continue;
      }
      outcomes.push({ id, ok: true, action: "deleted", reason: status.reason });
    } catch (error) {
      outcomes.push({ id, ok: false, action: "delete-failed", reason: errorReasonCode(error, "unknown-error") });
    } finally {
      if (fallbackClaims) fallbackClaims.delete(claimKey);
      else store.releaseLease?.(claimKey, claimed.nonce);
    }
  }
  return outcomes;
}

function frozenRolloutGates(value = {}) {
  const threshold = value.yoloEnablementThreshold ?? {};
  const integer = Number.isSafeInteger(threshold.minSynthesesObserved) && threshold.minSynthesesObserved >= 0
    ? threshold.minSynthesesObserved
    : DEFAULT_ROLLOUT_GATES.yoloEnablementThreshold.minSynthesesObserved;
  const rate = Number.isFinite(threshold.minSuccessRate) && threshold.minSuccessRate >= 0 && threshold.minSuccessRate <= 1
    ? threshold.minSuccessRate
    : DEFAULT_ROLLOUT_GATES.yoloEnablementThreshold.minSuccessRate;
  return Object.freeze({
    offlineCorpus: value.offlineCorpus === true,
    passiveShadowObservation: value.passiveShadowObservation === true,
    automaticSynthesisApplicationDisabled: value.automaticSynthesisApplicationDisabled === true,
    autoReviewRollout: value.autoReviewRollout !== false,
    yoloEnablementThreshold: Object.freeze({ minSynthesesObserved: integer, minSuccessRate: rate }),
  });
}

function instantiate(dependency, factoryName, args) {
  return typeof dependency?.[factoryName] === "function" ? dependency[factoryName](args) : dependency;
}

function projectionTargetReader(inventoryModule) {
  return (proposal) => {
    if (NOFOLLOW === null) throw new Error("projection-target-no-follow-unsupported");
    const root = String(proposal?.skillTarget?.canonicalRoot ?? "");
    const relativePath = String(proposal?.skillTarget?.relativePath ?? "");
    if (!root || !/^[^/\\\0]+\/SKILL\.md$/u.test(relativePath)) throw new Error("projection-target-path-rejected");
    const candidate = path.resolve(root, relativePath);
    if (path.resolve(root) !== root
        || realpathSync(root) !== root
        || inventoryModule?.isPathContained?.(candidate, root) !== true
        || inventoryModule?.rejectSymlinked?.(candidate) !== false) {
      throw new Error("projection-target-path-rejected");
    }
    let before;
    try {
      before = lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT" && inventoryModule?.rejectSymlinked?.(candidate) === false) {
        return { exists: false, content: null };
      }
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || realpathSync(candidate) !== candidate) {
      throw new Error("projection-target-path-rejected");
    }
    let descriptor;
    try {
      descriptor = openSync(candidate, constants.O_RDONLY | NOFOLLOW);
      const opened = fstatSync(descriptor);
      if (!opened.isFile()
          || opened.nlink !== 1
          || opened.dev !== before.dev
          || opened.ino !== before.ino) {
        throw new Error("projection-target-replaced");
      }
      const content = readFileSync(descriptor);
      const after = lstatSync(candidate);
      if (after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino) {
        throw new Error("projection-target-replaced");
      }
      return { exists: true, content, hash: createHash("sha256").update(content).digest("hex") };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
}

function globalProjectionTargetReader(inventoryModule, getCatalog) {
  const read = projectionTargetReader(inventoryModule);
  return (recommendation) => {
    const policy = getCatalog()?.policy;
    const root = policy?.roots?.find((value) => value.rootId === recommendation?.targetBinding?.rootId);
    if (!root) throw new Error("global-projection-root-unavailable");
    return read({
      skillTarget: {
        canonicalRoot: root.canonicalPath,
        relativePath: recommendation.targetBinding.relativePath,
      },
    });
  };
}

export function createIntegration({
  store,
  inventory,
  privacy,
  schemas,
  observation,
  synthesisModule,
  applier,
  commands,
  pipeline,
  scheduler,
  options = {},
  now = () => Date.now(),
} = {}) {
  if (!store || !schemas || !pipeline || !scheduler || !applier) throw new TypeError("integration-dependencies-required");
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (typeof store.rootPath === "string" && options.stateRoot) {
    const boundary = validateStateRootBoundary(options.stateRoot);
    if (boundary.path !== store.rootPath || boundary.identity !== store.rootIdentity) {
      throw new Error("state-root-store-mismatch");
    }
  }
  const hostOwnerGeneration = ++hostOwnerBootGeneration;
  const rolloutGates = frozenRolloutGates(options.rolloutGates ?? options.settings?.rolloutGates);
  const inFlight = new Map();
  let runtimeKillSwitch = process.env.SELF_EVOLVE_KILL === "1" || process.env.SELF_EVOLVE_KILL === "true";
  let bootValidated = options.bootValidated !== false;
  let corrupt = false;
  let lastError;
  let hostVersion = String(options.hostVersion ?? "unknown");
  let hostVersionSource = options.hostVersionSource === "tui-app-version" ? "tui-app-version" : "global-health";
  let ctx = options.ctx;
  let closed = false;
  let shutdownDegraded = false;
  let resourcesClosed = false;
  let schedulerDisposed = false;
  let workDrainTask;
  let resourceCloseTask;
  let terminalPurge = false;
  let terminalPurgeTask;
  let mailboxTimer;
  let mailboxPolling = false;
  let mailboxPending = false;
  let mailboxTask;
  let hostRecoveryTask;
  let hostRecoveryReport;
  let hostRecoveryController;
  let retentionTimer;
  let retentionTask;
  let uiProjection;
  let uiProjectionDirty = true;
  let uiProjectionRefreshAt = 0;
  let globalProjection;
  let globalProjectionDirty = true;
  let globalProjectionRefreshAt = 0;
  let activeHostGlobalCatalog = null;
  let sensitiveExportManager;
  let routingSettingsSnapshot;
  let routingSettingsRefreshAt = 0;
  const setRetentionInterval = options.__testSetInterval ?? setInterval;
  const clearRetentionInterval = options.__testClearInterval ?? clearInterval;
  const retentionIntervalMs = options.__testRetentionIntervalMs ?? RETENTION_INTERVAL_MS;
  const retainStore = options.__testRunStoreRetention ?? ((timestamp) => store.retain(timestamp));
  const setMailboxInterval = options.__testSetMailboxInterval ?? setInterval;
  const clearMailboxInterval = options.__testClearMailboxInterval ?? clearInterval;
  const setTerminalPurgeTimeout = options.__testSetTerminalPurgeTimeout ?? setTimeout;
  const terminalPurgeDelayMs = options.__testTerminalPurgeDelayMs ?? 1_000;
  const consumeMailbox = options.__testConsumeDecisionRequests ?? consumeDecisionRequests;
  const consumeGlobalMailbox = options.__testConsumeGlobalActionRequests ?? consumeGlobalActionRequests;
  const consumerInstanceId = options.__testConsumerInstanceId ?? randomUUID();
  const routingSettingsTtlMs = options.__testRoutingSettingsTtlMs ?? ROUTING_SETTINGS_TTL_MS;
  const ancestryTimeoutMs = Number.isSafeInteger(options.__testSessionAncestryTimeoutMs)
    ? Math.max(1, Math.min(2_000, options.__testSessionAncestryTimeoutMs))
    : SESSION_ANCESTRY_TIMEOUT_MS;

  function lifecycleSessionID(input) {
    const event = input?.event && typeof input.event === "object" ? input.event : input;
    return event?.properties?.sessionID
      ?? event?.properties?.session?.id
      ?? event?.sessionID
      ?? event?.session?.id;
  }

  function validHostSessionID(value) {
    return typeof value === "string"
      && value.length > 0
      && value.length <= 512
      && Buffer.byteLength(value, "utf8") <= 1024
      && !value.includes("\0");
  }

  function hostSessionRecord(result, expectedID, projectFingerprint) {
    const value = result?.data ?? result;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session-metadata-invalid");
    const sessionID = value.id;
    if (sessionID !== expectedID) throw new Error("session-metadata-identity-mismatch");
    if (value.parentID !== undefined && !validHostSessionID(value.parentID)) throw new Error("session-parent-invalid");
    const owned = typeof store.hostOwnerStatus === "function"
      ? store.hostOwnerStatus(sessionID, hostOwnershipContext(projectFingerprint))
      : { classification: "unknown", reason: "host-owner-not-found" };
    if (owned?.classification === "unknown" && owned?.reason !== "host-owner-not-found") throw new Error("session-owner-unavailable");
    if (!["unknown", "live-owner", "abortable"].includes(owned?.classification)) throw new Error("session-owner-invalid");
    const pluginOwned = owned.classification === "live-owner"
      || owned.classification === "abortable";
    return {
      sessionID,
      parentID: value.parentID ?? null,
      projectFingerprint,
      owned: pluginOwned,
      trustworthy: true,
    };
  }

  async function hydrateRootLineage(input, projectFingerprint) {
    const sessionID = lifecycleSessionID(input);
    const session = ctx?.client?.session;
    if (!validHostSessionID(sessionID) || typeof session?.get !== "function") return null;
    const ancestry = [];
    const visited = new Set();
    let currentID = sessionID;
    for (let depth = 0; depth <= SESSION_ANCESTRY_MAX_DEPTH; depth += 1) {
      if (visited.has(currentID)) break;
      visited.add(currentID);
      const result = await boundedHostCall(
        () => session.get.call(session, { path: { id: currentID }, query: { directory: ctx.directory } }),
        { timeoutMs: ancestryTimeoutMs, label: "session-ancestry" },
      );
      if (result?.error) throw new Error("session-ancestry-unavailable");
      const record = hostSessionRecord(result, currentID, projectFingerprint);
      ancestry.push(record);
      if (!record.parentID) break;
      currentID = record.parentID;
    }
    return observation?.resolveRootLineage?.({ sessionID, projectFingerprint, sessions: ancestry }) ?? null;
  }

  function invalidateRoutingSettings() {
    routingSettingsSnapshot = undefined;
    routingSettingsRefreshAt = 0;
  }

  function settings({ routing = false } = {}) {
    if (terminalPurge || store.isTerminal?.()) return null;
    const timestamp = routing ? now() : 0;
    if (routing && routingSettingsSnapshot && timestamp < routingSettingsRefreshAt) return routingSettingsSnapshot;
    try {
      const value = store.getSettings();
      if (!value?.global || !value?.repo) throw new Error("corrupt-settings");
      if (routing) {
        routingSettingsSnapshot = value;
        routingSettingsRefreshAt = timestamp + routingSettingsTtlMs;
      }
      return value;
    } catch (error) {
      invalidateRoutingSettings();
      corrupt = true;
      lastError = errorReasonCode(error, "unknown-error");
      return null;
    }
  }

  function automationState() {
    try {
      const value = store.getAutomationState?.();
      return value?.ok ? value : { ok: false, enabled: false, reason: value?.reason ?? "automation-state-unavailable" };
    } catch (error) {
      return { ok: false, enabled: false, reason: errorReasonCode(error, "automation-state-unavailable") };
    }
  }

  function hostOwnershipContext(projectFingerprint = settings()?.repo?.projectFingerprint) {
    return {
      projectFingerprint,
      rootIdentity: options.stateRoot ? stateRootIdentity(options.stateRoot) : store.rootIdentity,
      hostOwnerGeneration,
    };
  }

  // Refresh the durable root epoch truth and return a stable terminal reason if
  // the root is terminal (whether by this process or by any peer sharing the
  // state root). The epoch file lives outside the deletable subtree and is the
  // cross-process terminal signal. Called at every admission, mailbox, boot,
  // decision, and publication boundary so a peer's terminal write fails this
  // process closed promptly.
  function rootEpochTerminalReason() {
    if (!options.stateRoot) return null;
    if (typeof store.refreshRootEpoch !== "function") return null;
    try {
      const reason = store.refreshRootEpoch();
      return reason ?? null;
    } catch {
      return "root-epoch-terminal";
    }
  }

  // Combined terminal gate: the process-local flag (set when THIS process
  // accepted purge-all) OR the durable epoch (set when ANY process sharing the
  // state root accepted purge-all). Every authority boundary checks this.
  function terminalGateReason() {
    if (terminalPurge) return "restart-required-after-purge-all";
    return rootEpochTerminalReason() ? "restart-required-after-purge-all" : null;
  }

  function exportManager() {
    if (!options.stateRoot) throw new Error("state-root-unavailable");
    const projectFingerprint = settings()?.repo?.projectFingerprint;
    if (!projectFingerprint) throw new Error("corrupt-settings");
    const createManager = options.__testCreateSensitiveExportManager ?? createSensitiveExportManager;
    sensitiveExportManager ??= createManager({
      stateRoot: options.stateRoot,
      projectFingerprint,
      now,
    });
    return sensitiveExportManager;
  }

  function circuitBreakerOpen() {
    try {
      // H5-001: the durable root-global breaker epoch is the cross-process
      // open/closed truth. Every admission, provider, and effect boundary
      // routes through this function, so reading it here gives every boundary
      // a fresh authoritative view of peer trip/reset writes. A corrupt breaker
      // epoch fails closed (tripped).
      if (store.breakerEpochTripped?.() === true) return true;
      const applierOpen = applier.circuitBreakerOpen?.();
      const schedulerBreaker = schedulerInstance?.getCircuitBreaker?.();
      if (applierOpen === true || schedulerBreaker?.open === true) return true;
      if (typeof applierOpen === "boolean" && typeof schedulerBreaker?.open === "boolean") return false;
      return store.readRecords?.("circuit-breaker").at(-1)?.payload?.open === true;
    } catch {
      return true;
    }
  }

  // H5-001/H5-002: bounded projection-facing view of the durable breaker epoch.
  // Returns tripped/generation/reason/resetAvailable so the Activity/Errors UX
  // can show actionable state. Fails closed (tripped) on any read error.
  function safeBreakerEpochHealth() {
    try {
      const state = store.breakerEpochState?.();
      if (!state || state.ok !== true) {
        return { tripped: true, generation: null, trippedAt: null, reason: state?.reason ?? "breaker-epoch-unavailable", resetAvailable: false };
      }
      return {
        tripped: state.tripped === true,
        generation: state.generation ?? null,
        trippedAt: state.trippedAt ?? null,
        reason: state.trippedReason ?? null,
        resetAvailable: state.tripped === true,
      };
    } catch {
      return { tripped: true, generation: null, trippedAt: null, reason: "breaker-epoch-unavailable", resetAvailable: false };
    }
  }

  function automaticWorkSuppressors(current, projectFingerprint) {
    const processExcluded = options.processExcluded === true
      || options.processExcluded?.has?.(projectFingerprint) === true
      || (typeof options.processExcluded === "function" && options.processExcluded(projectFingerprint) === true)
      || (projectFingerprint !== undefined && current?.repo?.projectFingerprint !== projectFingerprint);
    return {
      killSwitchActive: runtimeKillSwitch || current?.global?.killSwitchActive === true,
      circuitBreakerOpen: circuitBreakerOpen(),
      processExcluded,
      repoOptOut: current?.repo?.excluded === true || options.repoOptOut === true,
      hostSupported: options.hostSupported !== false,
      corrupt: corrupt || !current,
    };
  }

  function getProjectOperationalState(projectFingerprint) {
    const automation = automationState();
    if (!automation.ok || !automation.enabled) {
      return {
        automaticRecommendationsEnabled: false,
        automaticWorkAllowed: false,
        reason: automation.reason ?? "automatic-recommendations-disabled",
      };
    }
    const targetFingerprint = projectFingerprint ?? automation.repo?.projectFingerprint;
    const suppressors = automaticWorkSuppressors({ global: automation.global, repo: automation.repo }, targetFingerprint);
    const reason = !bootValidated ? "boot-not-validated"
      : suppressors.killSwitchActive ? "emergency-stop"
        : suppressors.processExcluded || suppressors.repoOptOut ? "project-excluded"
          : suppressors.corrupt ? "corrupt-state"
            : suppressors.circuitBreakerOpen ? "circuit-breaker"
              : !suppressors.hostSupported ? "host-unsupported"
                : null;
    return {
      automaticRecommendationsEnabled: true,
      automaticWorkAllowed: reason === null,
      reason,
    };
  }

  function backgroundRestartRequired() {
    const automation = automationState();
    return options.passiveEventHookInstalled === false && automation.ok && automation.enabled;
  }

  function rolloutMetrics() {
    const records = store.readRecords?.("audit-event") ?? [];
    const projectFingerprint = settings()?.repo?.projectFingerprint;
    const outcomes = new Map();
    for (const record of records) {
      const outcome = schemas.parseSynthesisOutcomeAuditEvent?.(record.payload);
      if (!outcome || outcome.projectFingerprint !== projectFingerprint || outcomes.has(outcome.outcomeId)) continue;
      outcomes.set(outcome.outcomeId, outcome);
    }
    const values = [...outcomes.values()];
    const successes = values.filter((outcome) => outcome.success).length;
    return { synthesesObserved: values.length, successRate: values.length ? successes / values.length : 0 };
  }

  function yoloThresholdMet() {
    const metrics = rolloutMetrics() ?? {};
    const threshold = rolloutGates.yoloEnablementThreshold;
    return Number(metrics.synthesesObserved ?? 0) >= threshold.minSynthesesObserved
      && Number(metrics.successRate ?? 0) >= threshold.minSuccessRate;
  }

  function targetAllowlisted(proposal, current = settings()) {
    const root = proposal?.skillTarget?.canonicalRoot;
    return typeof root === "string" && (current?.global?.allowedSkillRoots ?? []).includes(root);
  }

  function validateCanonicalAllowlist(roots) {
    const validated = inventory?.loadAllowlist?.({ globalSkillRoots: roots });
    if (!validated
        || validated.errors?.length
        || validated.canonicalRoots?.length !== roots.length
        || validated.canonicalRoots.some((root, index) => root !== roots[index])) {
      return { ok: false, reason: "invalid-or-unsupported-skill-folder" };
    }
    return { ok: true, roots: validated.canonicalRoots };
  }

  function updateHeadlessAllowlist(command) {
    if (command.action === "list") {
      const roots = settings()?.global?.allowedSkillRoots ?? [];
      return {
        ok: true,
        responseText: roots.length
          ? `Approved skill folders (${roots.length}):\n${roots.map((root) => `- ${root}`).join("\n")}`
          : "Approved skill folders (0): none.",
      };
    }
    if (command.confirmation !== "UPDATE ALLOWLIST") {
      return { ok: false, reason: "allowlist-confirmation-required", responseText: "Allowlist update refused: allowlist-confirmation-required." };
    }
    let savedRoots;
    const saved = store.updateSettings((current) => {
      const existing = current.global.allowedSkillRoots;
      const candidate = command.action === "add"
        ? [...existing, ...(!existing.includes(command.path) ? [command.path] : [])]
        : existing.filter((root) => root !== command.path);
      if (command.action === "remove" && candidate.length === existing.length) throw new Error("skill-folder-not-approved");
      const validated = validateCanonicalAllowlist(candidate);
      if (!validated.ok) throw new Error(validated.reason);
      savedRoots = validated.roots;
      return { global: schemas.makeGlobalSettings({ ...current.global, allowedSkillRoots: savedRoots, updatedAt: now() }) };
    });
    if (!saved.ok) return { ok: false, reason: saved.reason, responseText: `Allowlist update refused: ${saved.reason}.` };
    appendAudit("decision", {
      action: "allowlist",
      operation: command.action,
      approvedSkillFolderCount: savedRoots.length,
    }, undefined, "self-evolve-command");
    invalidateRoutingSettings();
    syncSchedulerAdmission(settings()?.repo?.projectFingerprint, `command-allowlist-${command.action}`);
    return {
      ok: true,
      responseText: `Creation-policy suggestions updated (${savedRoots.length}). Automatic recommendations and data permissions are unchanged.`,
    };
  }

  function releaseGatesPassed(proposal) {
    return proposal?.criticPassed === true
      && proposal?.validDeterministic === true
      && proposal?.injectionFlagged !== true
      && !rolloutGates.automaticSynthesisApplicationDisabled
      && yoloThresholdMet();
  }

  function evaluateAuthority({ proposal, decision, headless = false }) {
    const current = settings();
    const exactApproval = decision?.proposalId === proposal?.id
      && decision?.targetHash === proposal?.skillTarget?.currentHash
      && decision?.proposedContentHash === proposal?.proposedContentHash
      && decision?.newState === "approved";
    return schemas.evaluateApplyAuthority({
      // The retained project-proposal compatibility path still calls the v0.3
      // predicate, whose `auto` input now means only "an explicit decision may
      // be applied". Automatic recommendations On/Off is never consulted.
      mode: "auto",
      decisionApproved: exactApproval,
      allowlisted: targetAllowlisted(proposal, current),
      releaseGatesPassed: releaseGatesPassed(proposal),
      headless,
      killSwitchActive: runtimeKillSwitch || current?.global?.killSwitchActive === true,
    });
  }

  const guardedApplier = Object.freeze({
    ...applier,
    async applyProposal(args = {}) {
      let proposal = args.proposal;
      let decision = args.decision;
      // v0.2 `yolo` self-approval is gone: every apply needs a decision that an
      // operator already committed, in every mode.
      const authority = evaluateAuthority({ ...args, proposal, decision });
      if (!authority.allowed) {
        return {
          ok: false,
          reason: authority.reason,
          disposition: proposal?.state === "pending" ? "pending-review" : "terminal-failure",
        };
      }
      let result;
      try {
        result = await applier.applyProposal({ ...args, proposal, decision });
      } catch (error) {
        return { ok: false, reason: errorReasonCode(error, "unknown-error"), disposition: "terminal-failure" };
      }
      if (result?.ok === true) return { ...result, disposition: "applied" };
      if (result?.deferred === true) return { ...result, disposition: "deferred" };
      return {
        ...(result && typeof result === "object" ? result : {}),
        ok: false,
        reason: result?.reason ?? "apply-failed",
        disposition: "terminal-failure",
      };
    },
  });

  const commandPolicy = instantiate(commands, "createCommandPolicy", {
    store,
    privacy,
    schemaVersion: schemas.SCHEMA_VERSION,
    hostVersion,
    hostVersionSource,
    now,
  });
  const integratedSynthesis = rolloutGates.passiveShadowObservation
    ? Object.freeze({
        ...synthesisModule,
        runSynthesis: async () => ({ ok: true, proposal: null, noChange: true, shadowObservation: true }),
      })
    : synthesisModule;
  let pipelineInstance = instantiate(pipeline, "createPipeline", {
    store,
    inventory,
    privacy,
    synthesis: integratedSynthesis,
    applier: guardedApplier,
    commands: commandPolicy,
    schemas,
    observation,
    now,
  });

  async function enqueueWork(workItem) {
    if (closed) return { ok: true, status: "cancelled", reason: "integration-closing" };
    const automation = automationState();
    if (!automation.ok || !automation.enabled) {
      return { ok: true, status: "cancelled", result: "suppressed", reason: automation.reason ?? "automatic-recommendations-disabled" };
    }
    const operational = getProjectOperationalState(workItem.projectFingerprint);
    if (!operational.automaticWorkAllowed) {
      return { ok: true, status: "cancelled", result: "suppressed", reason: operational.reason };
    }
    const key = `${workItem.sessionID}:${workItem.leaseNonce ?? workItem.epoch ?? now()}`;
    const item = { ...workItem, key, stage: "pipeline", startedAt: now() };
    const controller = new AbortController();
    const promise = runEvolutionCycle({
      ...workItem,
      ctx,
      trigger: workItem.trigger ?? "scheduler",
      options: {
        ...(workItem.options ?? {}),
        automationStamp: automation.stamp,
        signal: controller.signal,
        reservePassiveProviderCalls: (count, context) => schedulerInstance.reservePassiveProviderCalls(count, {
          ...context,
          rootSessionIDHash: workItem.rootSessionIDHash,
        }),
      },
    });
    inFlight.set(key, { item, controller, promise, kind: "passive" });
    try {
      const result = await promise;
      if (controller.signal.aborted) {
        const abortReason = typeof controller.signal.reason === "string" && controller.signal.reason
          ? controller.signal.reason
          : "integration-shutdown";
        return { ok: true, status: "cancelled", result: "cancelled", reason: abortReason };
      }
      return result;
    } finally {
      inFlight.delete(key);
    }
  }

  const schedulerInstance = instantiate(scheduler, "createScheduler", {
    store,
    privacy,
    budgets: options.budgets,
    now,
    enqueueWork,
    log: options.log,
  });
  const canRunGlobalBridge = Boolean(options.stateRoot
    && typeof store.readGlobalProjectionSnapshot === "function"
    && typeof store.readContributionLinks === "function"
    && typeof inventory?.resolveGlobalRecommendationTarget === "function"
    && typeof inventory?.validateProposalTarget === "function");
  const globalDecisionDomain = options.__testGlobalDecisionDomain
    ?? (canRunGlobalBridge ? createGlobalDecisionDomain({
      store,
      inventory,
      now,
      getCatalog: () => activeHostGlobalCatalog,
      getSuppressors: () => ({
        circuitBreakerOpen: circuitBreakerOpen(),
        emergencyStop: runtimeKillSwitch,
      }),
      projectSkillRoot: options.projectRoot ?? options.worktree ?? ctx?.worktree ?? ctx?.directory ?? null,
    }) : null);

  function makeAuditRecord(kind, details, proposalId, actor = "self-evolve-integration", timestampOverride) {
    const timestamp = timestampOverride ?? now();
    const clean = Object.fromEntries(Object.entries(details).filter(([, value]) => ["string", "boolean", "number"].includes(typeof value) || value === null));
    const payloadHash = sha256(JSON.stringify(clean));
    const event = schemas.makeAuditEvent({
      id: sha256(JSON.stringify({ kind, proposalId, actor, timestamp, payloadHash, nonce: randomBytes(8).toString("hex") })),
      kind,
      ...(proposalId ? { proposalId } : {}),
      actor,
      timestamp,
      payloadHash,
      details: clean,
    });
    return schemas.wrapRecord("audit-event", event, timestamp);
  }

  function appendAudit(kind, details, proposalId, actor = "self-evolve-integration", timestampOverride) {
    const record = makeAuditRecord(kind, details, proposalId, actor, timestampOverride);
    const saved = store.appendRecord(record);
    if (!saved?.ok) throw new Error(saved?.reason ?? "audit-write-failed");
    uiProjectionDirty = true;
    return record.payload;
  }

  function publish(type, properties = {}) {
    const method = ctx?.client?.tui?.publish;
    if (typeof method !== "function") return;
    try {
      Promise.resolve(method.call(ctx.client.tui, { type, properties })).catch((error) => { lastError = errorReasonCode(error, "unknown-error"); });
    } catch (error) {
      lastError = errorReasonCode(error, "unknown-error");
    }
  }

  function syncSchedulerAdmission(projectFingerprint, reason = "settings-refresh") {
    const operational = getProjectOperationalState(projectFingerprint);
    // Scheduler setMode is a retained internal adapter until that module's
    // admission flag is renamed; it is not settings or wire authority.
    schedulerInstance.setMode?.(operational.automaticWorkAllowed ? "auto" : "manual", reason);
    return operational.automaticWorkAllowed;
  }

  function currentProposal(proposalId) {
    return latestById(store.readRecords?.("proposal") ?? []).get(proposalId) ?? null;
  }

  function actionableProposals() {
    return [...latestById(store.readRecords?.("proposal") ?? []).values()]
      .filter((proposal) => proposal.projectFingerprint === settings()?.repo?.projectFingerprint && ["pending", "applied"].includes(proposal.state));
  }

  function operationGrantKey(subjectId, uiAction) {
    return `${subjectId ?? ""}\n${uiAction}`;
  }

  function operationGrantSubjects(snapshot) {
    const output = UI_OPERATION_ACTIONS
      .filter((uiAction) => !["rollback-proposal", "snooze-proposal"].includes(uiAction))
      .map((uiAction) => ({ subjectId: undefined, uiAction }));
    for (const proposal of [...latestById(
      (snapshot.records ?? []).filter((record) => record.kind === "proposal"),
    ).values()]) {
      if (proposal.projectFingerprint !== snapshot.projectFingerprint) continue;
      if (proposal.state === "pending") output.push({ subjectId: proposal.id, uiAction: "snooze-proposal" });
      if (proposal.state === "applied") output.push({ subjectId: proposal.id, uiAction: "rollback-proposal" });
    }
    return output;
  }

  function issueUiOperationGrants(snapshot, projectionGeneration) {
    if (!options.stateRoot || !snapshot) return 0;
    const timestamp = now();
    const rootIdentity = stateRootIdentity(options.stateRoot);
    const latest = new Map();
    for (const record of snapshot.records ?? []) {
      const event = record.payload;
      const value = event?.details;
      if (event?.kind !== "decision"
          || event.actor !== "self-evolve-integration"
          || value?.action !== "ui-operation-nonce") continue;
      latest.set(operationGrantKey(value.subjectId, value.uiAction), value);
    }
    let issued = 0;
    for (const { subjectId, uiAction } of operationGrantSubjects(snapshot)) {
      const capability = UI_ACTION_CAPABILITIES[uiAction];
      const current = latest.get(operationGrantKey(subjectId, uiAction));
      if (current
          && current.projectFingerprint === snapshot.projectFingerprint
          && current.stateRootIdentity === rootIdentity
          && current.generation === projectionGeneration
          && current.capability === capability
          && current.expiresAt > timestamp
          && !completedOperationNonce(current.nonce)) continue;
      appendAudit("decision", {
        action: "ui-operation-nonce",
        projectFingerprint: snapshot.projectFingerprint,
        stateRootIdentity: rootIdentity,
        generation: projectionGeneration,
        uiAction,
        capability,
        ...(subjectId ? { subjectId } : {}),
        nonce: randomBytes(24).toString("hex"),
        expiresAt: timestamp + UI_PROTOCOL_LIMITS.operationTtlMs,
      }, subjectId);
      issued += 1;
    }
    return issued;
  }

  function issueBridgeNonces() {
    if (!options.stateRoot) return [];
    const issued = [];
    const bridgeGrants = new Map();
    const headlessGrants = new Map();
    for (const record of store.readRecords?.("audit-event") ?? []) {
      const event = record.payload;
      if (!event?.proposalId) continue;
      if (event.details?.action === "bridge-nonce") bridgeGrants.set(event.proposalId, event);
      if (event.details?.action === "headless-approval-nonce") headlessGrants.set(event.proposalId, event);
    }
    for (const proposal of actionableProposals()) {
      const existing = bridgeGrants.get(proposal.id)?.details;
      const timestamp = now();
      if (!(existing
        && existing.expiresAt > timestamp
        && existing.targetHash === proposal.skillTarget.currentHash
        && existing.proposedContentHash === proposal.proposedContentHash
        && existing.decisionVersion === proposal.decisionVersion + 1
        && existing.priorState === proposal.state
        && existing.actor === BRIDGE_ACTOR)) {
        const event = appendAudit("decision", {
          action: "bridge-nonce",
          projectFingerprint: proposal.projectFingerprint,
          subjectId: proposal.id,
          targetHash: proposal.skillTarget.currentHash,
          proposedContentHash: proposal.proposedContentHash,
          decisionVersion: proposal.decisionVersion + 1,
          priorState: proposal.state,
          actor: BRIDGE_ACTOR,
          nonce: randomBytes(24).toString("hex"),
          expiresAt: timestamp + BRIDGE_TTL_MS,
        }, proposal.id);
        bridgeGrants.set(proposal.id, event);
      }
      const headless = headlessGrants.get(proposal.id)?.details;
      if (!headless
        || headless.expiresAt <= timestamp
        || headless.targetHash !== proposal.skillTarget.currentHash
        || headless.proposedContentHash !== proposal.proposedContentHash
        || headless.decisionVersion !== proposal.decisionVersion + 1
        || headless.priorState !== proposal.state) {
        const event = appendAudit("decision", {
          action: "headless-approval-nonce",
          projectFingerprint: proposal.projectFingerprint,
          subjectId: proposal.id,
          targetHash: proposal.skillTarget.currentHash,
          proposedContentHash: proposal.proposedContentHash,
          decisionVersion: proposal.decisionVersion + 1,
          priorState: proposal.state,
          actor: "self-evolve-command",
          nonce: randomBytes(24).toString("hex"),
          expiresAt: timestamp + BRIDGE_TTL_MS,
        }, proposal.id);
        headlessGrants.set(proposal.id, event);
      }
      issued.push(proposal.id);
    }
    return issued;
  }

  function latestBridgeGrant(proposalId) {
    return (store.readRecords?.("audit-event") ?? [])
      .map((record) => record.payload)
      .findLast((event) => event.proposalId === proposalId && event.details?.action === "bridge-nonce");
  }

  function latestHeadlessGrant(proposalId) {
    return (store.readRecords?.("audit-event") ?? [])
      .map((record) => record.payload)
      .findLast((event) => event.proposalId === proposalId && event.details?.action === "headless-approval-nonce");
  }

  function refreshUiProjection({ force = false } = {}) {
    if (!options.stateRoot || terminalPurge || closed) return null;
    if (typeof store.readProjectionSnapshot !== "function"
        || typeof inventory?.discoverSkills !== "function") {
      return null;
    }
    const timestamp = now();
    if (!force && !uiProjectionDirty && uiProjection && timestamp < uiProjectionRefreshAt) return uiProjection;
    let snapshot = store.readProjectionSnapshot();
    const records = inventory.discoverSkills(snapshot.settings.global.allowedSkillRoots);
    const build = (source) => buildUiProjection(source, {
      stateRootIdentity: stateRootIdentity(options.stateRoot),
      now: timestamp,
      targetReader: projectionTargetReader(inventory),
      inventory: records,
      health: {
        runtimeKillSwitch,
        hostSupported: options.hostSupported !== false,
        lifecycleEventHookInstalled: options.passiveEventHookInstalled !== false,
        corrupt,
        // H5-001/H5-002: expose the durable root-global breaker epoch state so
        // the projection/Activity-Errors UX is actionable across processes. The
        // projection combines this with the record-derived breaker state.
        breakerEpoch: safeBreakerEpochHealth(),
      },
    });
    let built = build(snapshot);
    if (issueUiOperationGrants(snapshot, built.index.generation) > 0) {
      snapshot = store.readProjectionSnapshot();
      built = build(snapshot);
    }
    uiProjection = publishUiProjection(options.stateRoot, {
      index: built.index,
      details: built.publicationDetails,
      dashboard: built.dashboard,
      now: timestamp,
    });
    uiProjectionDirty = false;
    uiProjectionRefreshAt = Math.max(timestamp, Math.min(
      built.index.expiresAt - UI_PROJECTION_EXPIRY_MARGIN_MS,
      timestamp + UI_PROJECTION_REFRESH_MS,
    ));
    return uiProjection;
  }

  function recoverGlobalRejectionsForAuthority() {
    const rejectionRecovery = store.recoverGlobalRejections?.() ?? { ok: true, recovered: [] };
    if (rejectionRecovery.ok === false) throw new Error(rejectionRecovery.reason ?? "global-rejection-recovery-failed");
    if (rejectionRecovery.recovered.some((item) => item.duplicate !== true)) {
      globalProjectionDirty = true;
      uiProjectionDirty = true;
    }
    return rejectionRecovery;
  }

  function refreshGlobalRecommendationProjection({ force = false } = {}) {
    if (!canRunGlobalBridge || terminalPurge || closed) return null;
    recoverGlobalRejectionsForAuthority();
    const timestamp = now();
    if (!force && !globalProjectionDirty && globalProjection && timestamp < globalProjectionRefreshAt) {
      return globalProjection;
    }
    let snapshot = store.readGlobalProjectionSnapshot();
    const automation = automationState();
    const baseReason = !bootValidated ? "boot-not-validated"
      : corrupt ? "corrupt-state"
        : options.hostSupported === false ? "host-unsupported"
          : null;
    const targetReason = baseReason ?? (!activeHostGlobalCatalog?.ok ? "host-global-skill-catalog-unavailable" : null);
    const applyReason = targetReason
      ?? (!automation.ok ? automation.reason ?? "automation-state-unavailable" : null)
      ?? (automation.global?.killSwitchActive === true ? "kill-switch" : null)
      ?? (runtimeKillSwitch ? "emergency-stop" : null)
      ?? (circuitBreakerOpen() ? "circuit-breaker" : null)
      ?? (!automation.global?.consent?.durableObservations
        || !automation.global?.consent?.sanitizedExcerpts
        || !automation.global?.consent?.crossRepoAggregation ? "global-apply-consent-required" : null);
    const actionAuthority = {
      apply: { allowed: applyReason === null, reason: applyReason },
      reject: { allowed: baseReason === null, reason: baseReason },
      // Undo is risk-reducing and therefore does not inherit automation,
      // privacy, breaker, or Emergency Stop suppression.
      undo: { allowed: targetReason === null, reason: targetReason },
    };
    const built = buildGlobalRecommendationProjection(snapshot, {
      stateRootIdentity: store.rootIdentity,
      now: timestamp,
      targetReader: globalProjectionTargetReader(inventory, () => activeHostGlobalCatalog),
      actionAuthority,
    });
    let existing = globalProjection;
    if (!existing) {
      try { existing = readGlobalRecommendationProjection(options.stateRoot, { now: timestamp }); }
      catch {}
    }
    try {
      globalProjection = publishGlobalRecommendationProjection(options.stateRoot, built, {
        store,
        expectedGeneration: existing?.index?.generation,
        now: timestamp,
      });
    } catch (error) {
      if (errorReasonCode(error, "global-projection-error") !== "stale-global-projection-cas") throw error;
      globalProjection = readGlobalRecommendationProjection(options.stateRoot, { now: timestamp });
    }
    if (globalProjection?.index) {
      snapshot = store.readGlobalProjectionSnapshot();
      const sidecars = buildProjectParticipationSidecars({
        index: globalProjection.index,
        recommendations: snapshot.recommendations,
        supportSets: snapshot.supportSets,
        contributionLinks: store.readContributionLinks(),
      }, {
        projectFingerprint: store.projectFingerprint,
        stateRootIdentity: store.rootIdentity,
        now: timestamp,
      });
      publishProjectParticipationSidecars(options.stateRoot, store.projectFingerprint, sidecars, { now: timestamp });
    }
    globalProjectionDirty = false;
    globalProjectionRefreshAt = Math.max(timestamp, Math.min(
      globalProjection?.index?.expiresAt - UI_PROJECTION_EXPIRY_MARGIN_MS || timestamp,
      timestamp + UI_PROJECTION_REFRESH_MS,
    ));
    return globalProjection;
  }

  function settingsVersion(current) {
    return sha256(JSON.stringify({ global: current.global, repo: current.repo }));
  }

  function automationSettingsVersion(current) {
    if (!current?.ok) return null;
    return sha256(JSON.stringify({
      global: current.global,
      repo: current.repo,
      automationStamp: current.stamp,
    }));
  }

  function completedOperationRequest(request) {
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.details?.action === "ui-operation-complete"
      && event.details?.requestId === request.requestId);
  }

  function completedOperationNonce(nonce) {
    const nonceHash = sha256(nonce);
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.details?.action === "ui-operation-complete"
      && event.details?.nonceHash === nonceHash);
  }

  function completedBridgeRequest(request) {
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.proposalId === request.proposalId
      && event.details?.action === "bridge-request-complete"
      && event.details?.requestId === request.requestId);
  }

  function completedBridgeNonce(request) {
    const nonceHash = sha256(request.nonce);
    return (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.proposalId === request.proposalId
      && event.details?.action === "bridge-request-complete"
      && event.details?.nonceHash === nonceHash);
  }

  function matchingStoredDecision(request) {
    return (store.readRecords?.("decision") ?? []).map((record) => record.payload).findLast((decision) =>
      decision.proposalId === request.proposalId
      && decision.targetHash === request.targetHash
      && decision.proposedContentHash === request.proposedContentHash
      && decision.decisionVersion === request.decisionVersion
      && decision.actor === request.actor
      && decision.timestamp === request.timestamp
      && decision.nonce === request.nonce
      && decision.priorState === request.priorState
      && decision.newState === request.newState);
  }

  function recordBridgeCompletion(request, result, recovered = false) {
    return appendAudit("decision", {
      action: "bridge-request-complete",
      requestId: request.requestId,
      nonceHash: sha256(request.nonce),
      requestDigest: mailboxRequestDigest("decision", request),
      accepted: result.ok === true,
      reason: completionReason(result, "decision-rejected"),
      recovered,
      ...(request.newState === "rejected" && request.feedback ? {
        rejectionFeedbackReason: request.feedback.reason,
        ...(request.feedback.text ? { rejectionFeedbackText: request.feedback.text } : {}),
      } : {}),
    }, request.proposalId, "self-evolve-integration");
  }

  function recordControlCompletion(request, result) {
    const details = {
      action: "control-request-complete",
      requestId: request.requestId,
      nonceHash: sha256(request.nonce),
      requestDigest: mailboxRequestDigest("control", request),
      controlAction: request.action,
      accepted: result.ok === true,
      reason: completionReason(result, "control-rejected"),
    };
    return appendAudit("decision", details, undefined, "self-evolve-integration");
  }

  function controlCompletionRecord(request, result) {
    return makeAuditRecord("decision", {
      action: "control-request-complete",
      requestId: request.requestId,
      nonceHash: sha256(request.nonce),
      requestDigest: mailboxRequestDigest("control", request),
      controlAction: request.action,
      accepted: result.ok === true,
      reason: completionReason(result, "control-rejected"),
    }, undefined, "self-evolve-integration");
  }

  function operationIntent(request) {
    const recorded = (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
      event.details?.action === "ui-operation-intent"
      && event.details?.requestId === request.requestId);
    if (recorded) return recorded;
    const transaction = store.readRequestTransaction?.();
    if (transaction?.requestId !== request.requestId) return null;
    return {
      timestamp: transaction.issuedAt,
      details: {
        action: "ui-operation-intent",
        requestId: transaction.requestId,
        nonceHash: transaction.nonceHash,
        requestDigest: transaction.requestDigest,
        uiAction: transaction.action,
        issuedAt: transaction.issuedAt,
      },
    };
  }

  function recordOperationIntent(request) {
    const transaction = store.beginRequestTransaction?.({
      requestId: request.requestId,
      projectFingerprint: request.projectFingerprint,
      requestDigest: mailboxRequestDigest("operation", request),
      nonceHash: sha256(request.nonce),
      action: request.action,
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
    });
    if (transaction?.ok === false) throw new Error(transaction.reason ?? "request-transaction-failed");
    return appendAudit("decision", {
      action: "ui-operation-intent",
      requestId: request.requestId,
      nonceHash: sha256(request.nonce),
      requestDigest: mailboxRequestDigest("operation", request),
      uiAction: request.action,
      issuedAt: request.issuedAt,
      ...(operationSubjectId(request) ? { subjectId: operationSubjectId(request) } : {}),
    }, operationSubjectId(request), "self-evolve-integration");
  }

  function recordOperationStatus(request, status, subjectId, reason) {
    return appendAudit("decision", {
      action: "ui-operation-status",
      requestId: request.requestId,
      uiAction: request.action,
      status,
      ...(subjectId ? { subjectId } : {}),
      ...(reason ? { reason: String(reason).slice(0, 256) } : {}),
    }, subjectId, "self-evolve-integration");
  }

  function recordOperationCompletion(request, result, subjectId) {
    const details = {
      action: "ui-operation-complete",
      requestId: request.requestId,
      nonceHash: sha256(request.nonce),
      requestDigest: mailboxRequestDigest("operation", request),
      uiAction: request.action,
      accepted: result.ok === true,
      terminal: result.terminal === true,
      reason: completionReason(result, "operation-rejected"),
      ...(result.exportPath ? { exportPath: result.exportPath } : {}),
      ...(Number.isSafeInteger(result.exportBytes) ? { exportBytes: result.exportBytes } : {}),
      ...(result.exportSha256 ? { exportSha256: result.exportSha256 } : {}),
      ...(Number.isSafeInteger(result.exportExpiresAt) ? { exportExpiresAt: result.exportExpiresAt } : {}),
      ...(subjectId ? { subjectId } : {}),
    };
    return appendAudit("decision", details, subjectId, "self-evolve-integration");
  }

  function operationCompletionRecord(request, result, subjectId = operationSubjectId(request)) {
    return makeAuditRecord("decision", {
      action: "ui-operation-complete",
      requestId: request.requestId,
      nonceHash: sha256(request.nonce),
      requestDigest: mailboxRequestDigest("operation", request),
      uiAction: request.action,
      accepted: result.ok === true,
      terminal: result.terminal === true,
      reason: completionReason(result, "operation-rejected"),
      ...(result.exportPath ? { exportPath: result.exportPath } : {}),
      ...(Number.isSafeInteger(result.exportBytes) ? { exportBytes: result.exportBytes } : {}),
      ...(result.exportSha256 ? { exportSha256: result.exportSha256 } : {}),
      ...(Number.isSafeInteger(result.exportExpiresAt) ? { exportExpiresAt: result.exportExpiresAt } : {}),
      ...(subjectId ? { subjectId } : {}),
    }, subjectId, "self-evolve-integration");
  }

  function recoverBridgeCompletion(request, completion) {
    const details = completion?.details;
    if (details?.nonceHash !== sha256(request.nonce)
      || details?.requestDigest !== mailboxRequestDigest("decision", request)) {
      return { ok: false, reason: "replayed-request" };
    }
    return details.accepted === true
      ? { ok: true, recovered: true }
      : { ok: false, reason: String(details.reason ?? "decision-rejected").slice(0, 256), recovered: true };
  }

  function recoverOperationCompletion(request, completion) {
    const details = completion?.details;
    if (details?.nonceHash !== sha256(request.nonce)
        || details?.requestDigest !== mailboxRequestDigest("operation", request)) {
      return { ok: false, reason: "replayed-request" };
    }
    return details.accepted === true
      ? {
        ok: true,
        ...(details.terminal === true ? { terminal: true } : {}),
        ...(details.terminal === true && request.action === "purge-all" ? { afterResponse: scheduleTerminalPurge } : {}),
        ...(details.exportPath ? { exportPath: details.exportPath } : {}),
        ...(Number.isSafeInteger(details.exportBytes) ? { exportBytes: details.exportBytes } : {}),
        ...(details.exportSha256 ? { exportSha256: details.exportSha256 } : {}),
        ...(Number.isSafeInteger(details.exportExpiresAt) ? { exportExpiresAt: details.exportExpiresAt } : {}),
      }
      : { ok: false, reason: String(details.reason ?? "operation-rejected").slice(0, 256) };
  }

  function validateOperationIntent(request, intent) {
    const details = intent?.details;
    return details?.nonceHash === sha256(request.nonce)
      && details?.requestDigest === mailboxRequestDigest("operation", request)
      && details?.uiAction === request.action;
  }

  function recoverOperationIntent(request, intent) {
    if (!validateOperationIntent(request, intent)) return { ok: false, reason: "replayed-request" };
    const freshAutomation = automationState();
    if (request.action === "set-automatic-recommendations"
        && freshAutomation?.global?.automaticRecommendationsEnabled === request.payload.enabled) return { ok: true };
    if (request.action === "set-permission"
        && freshAutomation?.global?.consent?.[request.payload.permission] === request.payload.enabled) return { ok: true };
    if (request.action === "set-kill-switch"
        && freshAutomation?.global?.killSwitchActive === request.payload.enabled) return { ok: true };
    if (request.action === "set-repo-excluded"
        && freshAutomation?.repo?.excluded === request.payload.excluded) return { ok: true };
    if (request.action === "snooze-proposal") {
      const decisionNonce = sha256(`native-snooze:${request.requestId}:${request.operationHash}`);
      const snoozed = (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
        event.proposalId === request.payload.proposalId
        && event.details?.action === "snooze"
        && event.details?.requestId === request.requestId
        && event.details?.snoozedUntil === request.payload.snoozedUntil);
      if (snoozed) return { ok: true };
      const decision = (store.readRecords?.("decision") ?? []).map((record) => record.payload).findLast((item) =>
        item.proposalId === request.payload.proposalId
        && item.nonce === decisionNonce
        && item.newState === "pending");
      if (decision) {
        appendAudit("decision", {
          action: "snooze",
          requestId: request.requestId,
          snoozedUntil: request.payload.snoozedUntil,
          state: "pending",
        }, request.payload.proposalId, BRIDGE_ACTOR);
        return { ok: true };
      }
    }
    if (request.action === "rollback-proposal") {
      const proposal = currentProposal(request.payload.proposalId);
      if (proposal?.state === "rolled-back") return { ok: true };
      const rollback = (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
        event.proposalId === request.payload.proposalId
        && event.kind === "rollback"
        && event.details?.["readback-verified"] === true);
      if (proposal?.state === "applied" && rollback) {
        const changed = casDecision(proposal, makeDecision(proposal, "rolled-back", "self-evolve-applier"));
        return changed.ok ? { ok: true } : { ok: false, reason: changed.reason ?? "rollback-recovery-failed" };
      }
    }
    if (request.action === "purge-scope") {
      const purged = (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
        event.kind === "purge"
        && event.timestamp >= intent.timestamp
        && event.details?.action === request.payload.scope);
      if (purged) return { ok: true };
    }
    if (request.action === "export-data") {
      const exported = readLatestSensitiveExport({
        stateRoot: options.stateRoot,
        projectFingerprint: request.projectFingerprint,
        now: now(),
      });
      const createdAt = Number(path.basename(exported?.path ?? "").split("-", 1)[0]);
      if (exported?.scope === request.payload.scope && createdAt >= intent.timestamp) {
        return {
          ok: true,
          exportPath: exported.path,
          exportBytes: exported.bytes,
          exportSha256: exported.sha256,
          exportExpiresAt: exported.expiresAt,
        };
      }
    }
    if (request.action === "retry-bootstrap" && uiProjection?.index?.status?.state === "ready") return { ok: true };
    return null;
  }

  function finishBridgeRequest(request, result, recovered = false) {
    recordBridgeCompletion(request, result, recovered);
    return recovered ? { ...result, recovered: true } : result;
  }

  function finishControlRequest(request, result) {
    recordControlCompletion(request, result);
    return result;
  }

  function operationSubjectId(request) {
    return request.action === "snooze-proposal" || request.action === "rollback-proposal"
      ? request.payload.proposalId
      : undefined;
  }

  function scheduleTerminalPurge() {
    // Write the terminal epoch durably FIRST so every peer process sharing this
    // state root fails closed at its next mutation-lock acquisition or admission
    // cycle. This runs via afterResponse AFTER the accepted-terminal response is
    // recorded and published, and BEFORE authority stop and deletion — preserving
    // the accepted-terminal ordering invariant (response first, then authority
    // stop, then mailbox/subtree deletion). Idempotent: boot recovery re-enters
    // here after a crash and a prior terminal epoch write is a no-op.
    try {
      store.markRootTerminal?.({ terminalOperationId: `terminal-purge:${now()}` });
    } catch (error) {
      lastError = errorReasonCode(error, "root-epoch-terminal-write-failed");
    }
    stopAfterPurgeAll();
    terminalPurgeTask ??= new Promise((resolve) => {
      const timer = setTerminalPurgeTimeout(() => {
        void (async () => {
          try {
            await startWorkDrain();
            sensitiveExportManager?.purge();
            privacy.purgeScope({ scope: "all" });
          } catch (error) {
            lastError = errorReasonCode(error, "unknown-error");
          } finally {
            sensitiveExportManager = undefined;
            resolve();
          }
        })();
      }, terminalPurgeDelayMs);
      timer.unref?.();
    });
  }

  function clearOperationTransaction(request) {
    const requestDigest = mailboxRequestDigest("operation", request);
    const transaction = store.readRequestTransaction?.();
    if (transaction?.requestDigest !== requestDigest) return;
    const cleared = store.clearRequestTransaction?.(requestDigest);
    if (cleared?.ok === false) throw new Error(cleared.reason ?? "request-transaction-failed");
  }

  function finishOperationRequest(request, result) {
    const subjectId = operationSubjectId(request);
    recordOperationStatus(
      request,
      result.ok === true ? result.terminal === true ? "accepted-terminal" : "completed" : "failed",
      subjectId,
      result.ok === true ? undefined : result.reason,
    );
    if (!completedOperationRequest(request)) recordOperationCompletion(request, result, subjectId);
    clearOperationTransaction(request);
    uiProjectionDirty = true;
    return result;
  }

  function currentOperationGrant(request) {
    const projection = uiProjection?.index?.generation === request.generation
        && uiProjection.index.projectionHash === request.projectionHash
      ? uiProjection
      : refreshUiProjection({ force: true });
    if (!projection?.index
        || projection.index.generation !== request.generation
        || projection.index.projectionHash !== request.projectionHash) return null;
    if (request.action === "replace-global-root-policy") {
      const grant = projection.dashboard?.settings?.globalRootPolicyAction;
      return grant?.action === request.action ? grant : null;
    }
    if (operationSubjectId(request)) {
      const detail = projection.details?.find((item) => item.proposalId === operationSubjectId(request));
      return detail?.allowedActions?.find((item) => item.action === request.action) ?? null;
    }
    return projection.index.allowedActions?.find((item) => item.action === request.action) ?? null;
  }

  async function executeUiOperation(request) {
    const fresh = settings();
    if (!fresh) return { ok: false, reason: "corrupt-settings" };
    const freshAutomation = automationState();
    if (!freshAutomation.ok) return { ok: false, reason: freshAutomation.reason ?? "automation-state-unavailable" };
    const freshAutomationVersion = automationSettingsVersion(freshAutomation);
    const automationControlActions = new Set([
      "set-automatic-recommendations",
      "set-kill-switch",
      "set-permission",
      "set-repo-excluded",
    ]);
    if (automationControlActions.has(request.action)
        && request.payload.settingsVersion !== freshAutomationVersion) {
      return { ok: false, reason: "stale-settings-version" };
    }
    if (request.action === "set-automatic-recommendations") {
      const result = store.transitionAutomation({
        transitionId: request.requestId,
        expectedGeneration: freshAutomation.epoch.generation,
        action: "set-automatic-recommendations",
        enabled: request.payload.enabled,
      });
      if (!result.ok) return { ok: false, reason: result.reason ?? "automatic-recommendations-update-failed" };
      invalidateRoutingSettings();
      if (!request.payload.enabled) downgradeInFlight("automatic-recommendations-off", { kinds: ["passive"] });
      else syncSchedulerAdmission(freshAutomation.repo.projectFingerprint, "automatic-recommendations-on");
      publish("self-evolve.settings", { action: request.action, enabled: request.payload.enabled });
      return { ok: true };
    }
    if (request.action === "set-permission") {
      const result = store.transitionAutomation({
        transitionId: request.requestId,
        expectedGeneration: freshAutomation.epoch.generation,
        action: "set-permission",
        permission: request.payload.permission,
        enabled: request.payload.enabled,
      });
      if (!result.ok) return { ok: false, reason: result.reason ?? "permission-update-failed" };
      invalidateRoutingSettings();
      if (!request.payload.enabled) downgradeInFlight("permission-revoked", { kinds: ["passive"] });
      publish("self-evolve.settings", {
        action: request.action,
        permission: request.payload.permission,
        enabled: request.payload.enabled,
      });
      return { ok: true };
    }
    if (request.action === "set-repo-excluded") {
      const result = store.setAutomationProjectExcluded?.(request.payload.excluded);
      if (!result?.ok) return { ok: false, reason: result?.reason ?? "project-exclusion-update-failed" };
      invalidateRoutingSettings();
      if (request.payload.excluded) {
        downgradeInFlight("project-excluded", {
          kinds: ["passive"],
          projectFingerprint: freshAutomation.repo.projectFingerprint,
        });
      } else syncSchedulerAdmission(freshAutomation.repo.projectFingerprint, "project-included");
      publish("self-evolve.settings", { action: request.action, excluded: request.payload.excluded });
      return { ok: true };
    }
    if (request.action === "replace-global-root-policy") {
      if (request.payload.settingsVersion !== freshAutomationVersion) return { ok: false, reason: "stale-settings-version" };
      if (typeof inventory?.buildGlobalSkillCatalog !== "function") {
        return { ok: false, reason: "global-root-validation-unavailable" };
      }
      const timestamp = now();
      const makePolicy = () => {
        const roots = request.payload.roots.map((root) => schemas.makeApprovedGlobalRoot(root));
        const creationRootId = request.payload.creationRootPath === null
          ? null
          : roots.find((root) => root.canonicalPath === request.payload.creationRootPath)?.rootId ?? null;
        return schemas.makeGlobalRootPolicy({
          roots,
          creationRootId,
          selectedBy: "operator",
          updatedAt: timestamp,
        });
      };
      let candidate;
      try {
        candidate = makePolicy();
      } catch (error) {
        return { ok: false, reason: schemas.errorReasonCode(error, "invalid-global-root-policy") };
      }
      const validatePolicy = (policy) => inventory.buildGlobalSkillCatalog(policy, {
        projectRoot: ctx?.directory ?? null,
      });
      const validated = validatePolicy(candidate);
      if (!validated?.ok) {
        return { ok: false, reason: validated?.blockers?.[0]?.code ?? "invalid-global-root-policy" };
      }
      await options.__testAfterRootPolicyPrevalidation?.({ request, candidate });
      const revalidatedAutomation = automationState();
      if (!revalidatedAutomation.ok
          || automationSettingsVersion(revalidatedAutomation) !== request.payload.settingsVersion) {
        return { ok: false, reason: "stale-settings-version" };
      }
      const transactionAudits = [];
      const saved = store.updateGlobalSettings((global, current) => {
        const revalidated = validatePolicy(candidate);
        if (!revalidated?.ok) throw new Error(revalidated?.blockers?.[0]?.code ?? "invalid-global-root-policy");
        const next = schemas.makeGlobalSettings({ ...global, globalRootPolicy: candidate, updatedAt: timestamp });
        transactionAudits.push(makeAuditRecord("decision", {
          action: "replace-global-root-policy",
          previousRootSetHash: global.globalRootPolicy?.rootSetHash ?? null,
          rootSetHash: candidate.rootSetHash,
          rootCount: candidate.roots.length,
          creationRootSelected: candidate.creationRootId !== null,
        }));
        transactionAudits.push(operationCompletionRecord(request, { ok: true }));
        return next;
      }, { additionalAudits: transactionAudits });
      if (!saved.ok) return { ok: false, reason: saved.reason ?? "global-root-policy-update-failed" };
      invalidateRoutingSettings();
      globalProjectionDirty = true;
      publish("self-evolve.settings", { action: request.action, rootCount: candidate.roots.length });
      return { ok: true };
    }
    if (request.action === "set-kill-switch") {
      return request.payload.enabled
        ? triggerKillSwitch("native-control", request)
        : clearKillSwitch("native-control", request);
    }
    if (request.action === "snooze-proposal") {
      const proposal = currentProposal(request.payload.proposalId);
      if (!proposal) return { ok: false, reason: "record-not-found" };
      if (proposal.projectFingerprint !== request.projectFingerprint) return { ok: false, reason: "cross-project-request" };
      if (proposal.state !== "pending"
          || proposal.skillTarget.currentHash !== request.payload.targetHash
          || proposal.proposedContentHash !== request.payload.proposedContentHash
          || proposal.decisionVersion + 1 !== request.payload.decisionVersion) {
        return { ok: false, reason: "stale-proposal-version" };
      }
      const timestamp = now();
      const decision = schemas.makeDecision({
        proposalId: proposal.id,
        targetHash: proposal.skillTarget.currentHash,
        proposedContentHash: proposal.proposedContentHash,
        decisionVersion: proposal.decisionVersion + 1,
        actor: BRIDGE_ACTOR,
        timestamp,
        nonce: sha256(`native-snooze:${request.requestId}:${request.operationHash}`),
        priorState: "pending",
        newState: "pending",
      });
      const committed = casDecision(proposal, decision);
      if (!committed.ok) return committed;
      appendAudit("decision", {
        action: "snooze",
        requestId: request.requestId,
        snoozedUntil: request.payload.snoozedUntil,
        state: "pending",
      }, proposal.id, BRIDGE_ACTOR);
      return { ok: true };
    }
    if (request.action === "rollback-proposal") {
      const proposal = currentProposal(request.payload.proposalId);
      if (!proposal) return { ok: false, reason: "record-not-found" };
      if (proposal.projectFingerprint !== request.projectFingerprint) return { ok: false, reason: "cross-project-request" };
      if (proposal.state !== "applied" || proposal.decisionVersion + 1 !== request.payload.decisionVersion) {
        return { ok: false, reason: "stale-proposal-version" };
      }
      const applyAudit = (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
        event.proposalId === proposal.id
        && event.kind === "apply"
        && event.details?.["readback-verified"] === true);
      if (applyAudit?.details?.appliedHash !== request.payload.appliedHash) {
        return { ok: false, reason: "applied-hash-mismatch" };
      }
      return decide({
        proposalId: proposal.id,
        decision: makeDecision(proposal, "rolled-back", BRIDGE_ACTOR),
        actor: BRIDGE_ACTOR,
      });
    }
    if (request.action === "purge-scope") {
      try {
        exportManager().purge();
      } catch (error) {
        return { ok: false, reason: errorReasonCode(error, "unknown-error") };
      } finally {
        sensitiveExportManager = undefined;
      }
      const result = privacy.purgeScope({
        scope: request.payload.scope,
        projectFingerprint: request.projectFingerprint,
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "purge-failed" };
    }
    if (request.action === "purge-all") {
      // The terminal epoch is written durably in scheduleTerminalPurge
      // (afterResponse) AFTER this response is recorded/published and BEFORE
      // authority stop and deletion. This preserves accepted-terminal ordering
      // (response first) while ensuring peers see the terminal epoch before the
      // subtree is deleted. See scheduleTerminalPurge.
      return {
        ok: true,
        terminal: true,
        afterResponse: scheduleTerminalPurge,
      };
    }
    if (request.action === "export-data") {
      const archive = request.payload.scope === "all"
        ? privacy.exportAll()
        : request.payload.scope === "global-recommendations"
          ? privacy.exportGlobalRecommendations()
          : privacy.exportScope(request.projectFingerprint);
      const records = request.payload.scope === "observations"
        ? archive.records.filter((record) => record.kind === "observation")
        : archive.records;
      const result = exportManager().run({
        scope: request.payload.scope,
        archive: { ...archive, exportScope: request.payload.scope, records },
      });
      return result.ok
        ? {
          ok: true,
          exportPath: result.path,
          exportBytes: result.bytes,
          exportSha256: result.sha256,
          exportExpiresAt: result.expiresAt,
        }
        : result;
    }
    if (request.action === "retry-bootstrap") {
      const status = uiProjection?.index?.status?.state;
      if (status === "ready") return { ok: false, reason: "bootstrap-not-needed" };
      if (options.hostSupported === false) return { ok: false, reason: "unsupported-host-version" };
      const result = await boot({
        ctx,
        hostVersion,
        hostVersionSource,
        recoverHostSessions: false,
        processMailbox: false,
      });
      const completion = result.ok ? { ok: true } : { ok: false, reason: result.reason ?? result.health?.lastError ?? "bootstrap-retry-failed" };
      const saved = store.appendRecord(operationCompletionRecord(request, completion));
      if (!saved?.ok) throw new Error(saved?.reason ?? "audit-write-failed");
      return completion;
    }
    return { ok: false, reason: "unsupported-operation" };
  }

  async function validateMailboxOperation(request) {
    const completed = completedOperationRequest(request);
    if (completed) {
      const recovered = recoverOperationCompletion(request, completed);
      clearOperationTransaction(request);
      return recovered;
    }
    if (completedOperationNonce(request.nonce)) return { ok: false, reason: "replayed-operation" };
    const fresh = settings();
    if (!fresh) return finishOperationRequest(request, { ok: false, reason: "corrupt-settings" });
    if (request.projectFingerprint !== fresh.repo.projectFingerprint
        || request.stateRootIdentity !== stateRootIdentity(options.stateRoot)) {
      return finishOperationRequest(request, { ok: false, reason: "cross-scope-request" });
    }
    const intent = operationIntent(request);
    let authorizedIntent = false;
    if (intent) {
      if (!validateOperationIntent(request, intent)) return { ok: false, reason: "replayed-request" };
      const recovered = recoverOperationIntent(request, intent);
      if (recovered) return finishOperationRequest(request, recovered);
      authorizedIntent = true;
    }
    if (!authorizedIntent) {
      const grant = currentOperationGrant(request);
      if (!grant) return finishOperationRequest(request, { ok: false, reason: "stale-or-unavailable-projection" });
      try {
        makeUiOperationRequest(request, {
          projectFingerprint: fresh.repo.projectFingerprint,
          stateRootIdentity: stateRootIdentity(options.stateRoot),
          generation: uiProjection.index.generation,
          projectionHash: uiProjection.index.projectionHash,
          now: now(),
          supportedCapabilities: [...UI_CAPABILITIES, ...UI_DASHBOARD_CAPABILITIES].sort(),
          grant,
        });
      } catch (error) {
        return finishOperationRequest(request, { ok: false, reason: errorReasonCode(error, "unknown-error") });
      }
    }
    const subjectId = operationSubjectId(request);
    if (!authorizedIntent) recordOperationStatus(request, "queued", subjectId);
    recordOperationStatus(request, "running", subjectId);
    if (!authorizedIntent) recordOperationIntent(request);
    let result;
    try {
      result = await executeUiOperation(request);
    } catch (error) {
      result = { ok: false, reason: errorReasonCode(error, "unknown-error") };
    }
    await options.__testAfterOperationEffect?.({ request, result });
    return finishOperationRequest(request, result);
  }

  function validateMailboxControl(request) {
    void request;
    // v0.3 control mailboxes remain parseable so a mixed-version pair can
    // explain the cutover, but v0.4 never grants or records their effects.
    return { ok: false, reason: "retired-v04-control" };
  }

  async function validateMailboxDecision(request) {
    const completed = completedBridgeRequest(request);
    if (completed) return recoverBridgeCompletion(request, completed);
    if (completedBridgeNonce(request)) return { ok: false, reason: "replayed-decision" };
    const stored = matchingStoredDecision(request);
    if (stored) {
      const proposal = currentProposal(request.proposalId);
      if (request.newState === "approved" && proposal?.state === "approved") {
        const applied = await runApprovalFlow({ proposalId: proposal.id, actor: request.actor, projectFingerprint: proposal.projectFingerprint });
        if (applied.result !== "applied") {
          const result = { ok: false, reason: applied.reason ?? "apply-recovery-failed" };
          return finishBridgeRequest(request, result, true);
        }
        markApplied(proposal.id);
      }
      const recoveredProposal = currentProposal(request.proposalId);
      const expectedState = request.newState === "approved" ? "applied" : request.newState;
      if (recoveredProposal?.state !== expectedState) {
        const result = { ok: false, reason: "incomplete-decision-recovery" };
        return finishBridgeRequest(request, result, true);
      }
      return finishBridgeRequest(request, { ok: true }, true);
    }
    const current = settings();
    const proposal = currentProposal(request.proposalId);
    if (!current || !proposal) return finishBridgeRequest(request, { ok: false, reason: "record-not-found" });
    if (request.projectFingerprint !== current.repo.projectFingerprint || proposal.projectFingerprint !== current.repo.projectFingerprint) {
      return finishBridgeRequest(request, { ok: false, reason: "cross-project-request" });
    }
    const grant = latestBridgeGrant(proposal.id)?.details;
    if (!grant
      || grant.action !== "bridge-nonce"
      || grant.projectFingerprint !== request.projectFingerprint
      || grant.subjectId !== request.proposalId
      || grant.targetHash !== request.targetHash
      || grant.proposedContentHash !== request.proposedContentHash
      || grant.decisionVersion !== request.decisionVersion
      || grant.priorState !== request.priorState
      || grant.actor !== request.actor
      || grant.nonce !== request.nonce
      || grant.expiresAt <= now()) return finishBridgeRequest(request, { ok: false, reason: "invalid-or-expired-nonce" });
    if (proposal.skillTarget.currentHash !== request.targetHash || proposal.proposedContentHash !== request.proposedContentHash) {
      return finishBridgeRequest(request, { ok: false, reason: "hash-binding-mismatch" });
    }
    if (proposal.decisionVersion + 1 !== request.decisionVersion) {
      return finishBridgeRequest(request, { ok: false, reason: "stale-decision-version" });
    }
    if (proposal.state !== request.priorState) return finishBridgeRequest(request, { ok: false, reason: "stale-prior-state" });
    const transitionAllowed = (request.priorState === "pending" && ["approved", "rejected", "pending"].includes(request.newState))
      || (request.priorState === "applied" && request.newState === "rolled-back");
    if (!transitionAllowed) return finishBridgeRequest(request, { ok: false, reason: "invalid-transition" });
    const result = await decide({
      proposalId: proposal.id,
      actor: request.actor,
      decision: schemas.makeDecision({
        proposalId: request.proposalId,
        targetHash: request.targetHash,
        proposedContentHash: request.proposedContentHash,
        decisionVersion: request.decisionVersion,
        actor: request.actor,
        timestamp: request.timestamp,
        nonce: request.nonce,
        priorState: request.priorState,
        newState: request.newState,
      }),
    });
    return finishBridgeRequest(request, result);
  }

  async function validateGlobalMailboxAction(requestValue, authority = {}) {
    if (!globalDecisionDomain || typeof store.readGlobalRecommendations !== "function") {
      return { ok: false, reason: "global-decision-domain-unavailable" };
    }
    let request;
    try { request = schemas.makeGlobalActionRequest(requestValue); }
    catch (error) { return { ok: false, reason: errorReasonCode(error, "invalid-global-action-request") }; }
    const recommendation = store.readGlobalRecommendations()
      .find((value) => value.recommendationId === request.recommendationId);
    if (!recommendation) return { ok: false, reason: "global-recommendation-not-found" };
    const expectedTargetHash = request.action === "undo"
      ? recommendation.proposedContentHash
      : recommendation.targetBinding.currentHash;
    if (recommendation.state !== request.priorState
        || recommendation.decisionVersion + 1 !== request.recommendationVersion
        || recommendation.supportSetHash !== request.supportSetHash
        || recommendation.targetBinding.bindingHash !== request.targetBindingHash
        || expectedTargetHash !== request.targetHash
        || recommendation.proposedContentHash !== request.proposedContentHash) {
      return { ok: false, reason: "stale-global-action-request" };
    }
    const newState = request.action === "apply" ? "approved"
      : request.action === "undo" ? "undo-approved" : "rejected";
    let decision;
    try {
      decision = schemas.makeGlobalDecision({
        recommendationId: request.recommendationId,
        supportSetHash: request.supportSetHash,
        targetBindingHash: request.targetBindingHash,
        targetHash: request.targetHash,
        proposedContentHash: request.proposedContentHash,
        decisionVersion: request.recommendationVersion,
        actorRole: "operator",
        timestamp: request.issuedAt,
        nonce: request.nonce,
        priorState: request.priorState,
        newState,
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "invalid-global-decision") };
    }
    const result = request.action === "reject"
      ? store.rejectGlobalRecommendation?.({ decision, nowMs: now() })
      : await (async () => {
          const projectRoot = options.projectRoot ?? options.worktree ?? ctx?.worktree ?? ctx?.directory;
          const catalog = await currentHostGlobalCatalog(projectRoot);
          if (!catalog?.ok) return { ok: false, reason: catalog?.blockers?.[0]?.code ?? "host-global-skill-catalog-unavailable" };
          return globalDecisionDomain.decide({
          action: request.action,
          decision,
          requestDeadline: authority.requestDeadline,
          consumerDeadline: authority.consumerDeadline,
          });
        })();
    globalProjectionDirty = true;
    uiProjectionDirty = true;
    return result?.ok === true
      ? { ok: true, duplicate: result.duplicate === true }
      : { ok: false, reason: result?.reason ?? "global-action-rejected" };
  }

  function recoverCompletedGlobalMailboxAction(requestValue) {
    let request;
    try { request = schemas.makeGlobalActionRequest(requestValue); }
    catch (error) { return { ok: false, reason: errorReasonCode(error, "invalid-global-action-request") }; }
    if (request.action !== "reject" || typeof store.recoverGlobalRejection !== "function") return null;
    let decision;
    try {
      decision = schemas.makeGlobalDecision({
        recommendationId: request.recommendationId,
        supportSetHash: request.supportSetHash,
        targetBindingHash: request.targetBindingHash,
        targetHash: request.targetHash,
        proposedContentHash: request.proposedContentHash,
        decisionVersion: request.recommendationVersion,
        actorRole: "operator",
        timestamp: request.issuedAt,
        nonce: request.nonce,
        priorState: request.priorState,
        newState: "rejected",
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "invalid-global-decision") };
    }
    const recovered = store.recoverGlobalRejection(decision);
    if (recovered?.reason === "global-rejection-decision-not-found") return null;
    globalProjectionDirty = true;
    uiProjectionDirty = true;
    return recovered?.ok === true
      ? { ok: true, duplicate: true }
      : { ok: false, reason: recovered?.reason ?? "global-rejection-recovery-failed" };
  }

  async function runMailboxPass() {
    try {
      const current = settings();
      const projectFingerprint = current?.repo?.projectFingerprint;
      if (!projectFingerprint) return { ok: false, reason: "corrupt-settings", processed: [] };
      let globalRejectionError;
      if (bootValidated && options.stateRoot && globalDecisionDomain) {
        try { recoverGlobalRejectionsForAuthority(); }
        catch (error) { globalRejectionError = errorReasonCode(error, "global-rejection-recovery-failed"); }
      }
      const globalPending = bootValidated && options.stateRoot && globalDecisionDomain
        ? pendingGlobalActionRequestCount(options.stateRoot)
        : 0;
      const globalActions = globalRejectionError
        ? { ok: false, reason: globalRejectionError, processed: [] }
        : globalPending > 0
        ? await consumeGlobalMailbox({
          stateRoot: options.stateRoot,
          consumerProjectFingerprint: projectFingerprint,
          consumerInstanceId,
          store,
          now,
          consumerBootValidated: bootValidated,
          validateAndDecide: validateGlobalMailboxAction,
          recoverCompletedRequest: recoverCompletedGlobalMailboxAction,
          maxRequests: options.mailboxMaxRequests,
        })
        : { ok: true, processed: [] };
      const pending = options.stateRoot
        ? pendingRequestCounts(options.stateRoot, projectFingerprint)
        : { decisions: 0, controls: 0, operations: 0 };
      // Existing recommendations remain reviewable and actionable while
      // Automatic recommendations is Off, so their one-use decision grants
      // are independent of scheduler admission.
      if (pending.decisions > 0 || actionableProposals().length > 0) issueBridgeNonces();
      const consumed = await consumeMailbox({
        stateRoot: options.stateRoot,
        projectFingerprint,
        now,
        validateAndDecide: validateMailboxDecision,
        validateAndControl: validateMailboxControl,
        validateAndOperate: validateMailboxOperation,
        maxRequests: options.mailboxMaxRequests,
        __testAfterRequestHandled: options.__testAfterRequestHandled,
      });
      let uiProjectionError;
      try { refreshUiProjection(); } catch (error) { uiProjectionError = errorReasonCode(error, "unknown-error"); lastError = uiProjectionError; }
      let globalProjectionError;
      try { refreshGlobalRecommendationProjection(); } catch (error) { globalProjectionError = errorReasonCode(error, "unknown-error"); lastError = globalProjectionError; }
      return {
        ...consumed,
        globalActions,
        ...(uiProjectionError ? { uiProjectionError } : {}),
        ...(globalProjectionError ? { globalProjectionError } : {}),
      };
    } catch (error) {
      lastError = errorReasonCode(error, "unknown-error");
      return { ok: false, reason: lastError, processed: [] };
    }
  }

  async function processMailbox() {
    const gateReason = terminalGateReason();
    if (!options.stateRoot || closed || gateReason) return { ok: false, reason: gateReason ?? (closed ? "integration-closed" : "mailbox-unavailable"), processed: [] };
    if (mailboxPolling) {
      mailboxPending = true;
      return mailboxTask;
    }
    mailboxPolling = true;
    mailboxTask = (async () => {
      let result;
      do {
        mailboxPending = false;
        result = await runMailboxPass();
      } while (mailboxPending && !closed && !terminalGateReason());
      return result;
    })();
    try {
      return await mailboxTask;
    } finally {
      mailboxPolling = false;
      mailboxPending = false;
      mailboxTask = undefined;
    }
  }

  function startMailboxPolling() {
    if (!options.stateRoot || mailboxTimer || closed || terminalPurge) return;
    const intervalMs = Math.min(60_000, Math.max(25, Number.isFinite(options.mailboxPollMs) ? options.mailboxPollMs : 500));
    mailboxTimer = setMailboxInterval(() => { void processMailbox(); }, intervalMs);
    mailboxTimer.unref?.();
  }

  function runRetentionSweep() {
    if (terminalPurge) return Promise.resolve({ ok: false, reason: "restart-required-after-purge-all" });
    if (closed) return Promise.resolve({ ok: false, reason: "integration-closed" });
    if (retentionTask) return retentionTask;
    retentionTask = Promise.resolve().then(async () => {
      const timestamp = now();
      const records = await retainStore(timestamp);
      let bridge = { ok: true, removed: 0 };
      const projectFingerprint = settings()?.repo?.projectFingerprint;
      if (options.stateRoot && projectFingerprint) bridge = cleanupBridge(options.stateRoot, projectFingerprint, { now: timestamp });
      return { ok: true, records, bridge, sweptAt: timestamp };
    }).catch((error) => {
      lastError = errorReasonCode(error, "unknown-error");
      return { ok: false, reason: lastError };
    }).finally(() => {
      retentionTask = undefined;
    });
    return retentionTask;
  }

  function startRetentionTimer() {
    if (retentionTimer || closed || terminalPurge) return;
    retentionTimer = setRetentionInterval(() => { void runRetentionSweep(); }, retentionIntervalMs);
    retentionTimer?.unref?.();
  }

  function proposalContent(proposal) {
    if (typeof proposal?.proposedContent === "string") return proposal.proposedContent;
    return pipelineInstance.readProposalContent?.(proposal) ?? "";
  }

  function eligibilityFor(proposal) {
    return (store.readRecords?.("eligibility-explanation") ?? []).map((record) => record.payload)
      .findLast((item) => item.clusterId === proposal.clusterId) ?? { clusterId: proposal.clusterId, eligible: false, reasons: ["eligibility-record-unavailable"], thresholdsMet: {}, thresholdsMissed: {} };
  }

  function makeDecision(proposal, newState, actor = "self-evolve-integration", priorState = proposal.state) {
    const timestamp = now();
    return schemas.makeDecision({
      proposalId: proposal.id,
      targetHash: proposal.skillTarget.currentHash,
      proposedContentHash: proposal.proposedContentHash,
      decisionVersion: proposal.decisionVersion + 1,
      actor,
      timestamp,
      nonce: sha256(`${proposal.id}:${proposal.decisionVersion + 1}:${timestamp}:${newState}:${randomBytes(8).toString("hex")}`),
      priorState,
      newState,
    });
  }

  function casDecision(proposal, decision) {
    const committed = store.commitDecision(decision);
    if (committed?.ok) uiProjectionDirty = true;
    return committed?.ok ? { ok: true, proposal: committed.proposal } : { ok: false, reason: committed?.reason ?? "decision-transaction-failed" };
  }

  function markApplied(proposalId) {
    const proposal = currentProposal(proposalId);
    if (!proposal || proposal.state !== "approved") return;
    const decision = makeDecision(proposal, "applied", "self-evolve-applier");
    return casDecision(proposal, decision);
  }

  function markFailedClosed(proposalId, reason, actor = "self-evolve-integration") {
    const proposal = currentProposal(proposalId);
    if (!proposal || proposal.state === "failed-closed") return { ok: proposal?.state === "failed-closed", proposal };
    if (!["pending", "approved", "applied"].includes(proposal.state)) return { ok: false, reason: "invalid-failed-closed-prior-state" };
    const boundedReason = String(reason ?? "apply-failed").slice(0, 400);
    const changed = casDecision(proposal, makeDecision(proposal, "failed-closed", actor));
    if (changed.ok) appendAudit("apply", { state: "critical", reason: boundedReason, "readback-verified": false, applyAuthority: false }, proposal.id, actor);
    return changed;
  }

  async function currentHostGlobalCatalog(projectRoot, cycleOptions = {}) {
    let hostCatalog = cycleOptions.hostGlobalSkillCatalog ?? options.hostGlobalSkillCatalog ?? null;
    const provider = cycleOptions.getHostGlobalSkillCatalog ?? options.getHostGlobalSkillCatalog;
    if (typeof provider === "function") hostCatalog = await provider({ projectRoot, ctx, hostVersion });
    if (!hostCatalog && typeof inventory?.discoverHostGlobalSkills === "function" && ctx?.serverUrl && projectRoot) {
      hostCatalog = await inventory.discoverHostGlobalSkills({
        origin: String(ctx.serverUrl),
        directory: projectRoot,
        hostVersion,
      });
    }
    const adapted = typeof inventory?.adaptHostGlobalSkillCatalog === "function"
      ? inventory.adaptHostGlobalSkillCatalog(hostCatalog, { updatedAt: now() })
      : null;
    activeHostGlobalCatalog = adapted?.ok ? adapted : null;
    return adapted;
  }

  async function runEvolutionCycle(args = {}) {
    const automation = automationState();
    if (!automation.ok || !automation.enabled) {
      return {
        result: "automatic-disabled",
        cycleOutcome: "automatic-disabled",
        cycleReason: automation.reason ?? "automatic-recommendations-disabled",
        responseText: "Self-evolve Automatic recommendations are Off. No session data was read and no autonomous work was performed.",
      };
    }
    const automaticWorkAllowed = syncSchedulerAdmission(args.projectFingerprint, "cycle-refresh");
    if (!automaticWorkAllowed) return { result: "suppressed", reason: getProjectOperationalState(args.projectFingerprint).reason };
    const ownership = hostOwnershipContext(args.projectFingerprint ?? settings()?.repo?.projectFingerprint);
    const projectRoot = args.options?.projectRoot ?? options.worktree ?? ctx?.worktree ?? ctx?.directory;
    const globalSkillCatalog = await currentHostGlobalCatalog(projectRoot, args.options);
    const cycleOptions = {
      ...(args.options ?? {}),
      automationStamp: args.options?.automationStamp ?? automation.stamp,
      projectRoot,
      globalSkillCatalog: globalSkillCatalog ?? {
        ok: false,
        policy: null,
        records: [],
        blockers: [{ code: "host-global-skill-catalog-unavailable" }],
      },
      ...(globalSkillCatalog?.ok ? {
        globalRootPolicy: globalSkillCatalog.policy,
      } : {}),
      remoteUrl: args.options?.remoteUrl ?? options.remoteUrl,
      rootSessionIDHash: args.rootSessionIDHash ?? args.options?.rootSessionIDHash,
      synthesis: { ...(args.options?.synthesis ?? {}), ...ownership },
      critic: { ...(args.options?.critic ?? {}), ...ownership },
      globalSynthesisSuppressors: {
        bootValidated,
        hostSupported: options.hostSupported !== false,
        circuitBreakerOpen: circuitBreakerOpen(),
        processExcluded: false,
      },
      getGlobalSynthesisSuppressors: () => ({
        bootValidated,
        hostSupported: options.hostSupported !== false,
        circuitBreakerOpen: circuitBreakerOpen(),
        processExcluded: false,
      }),
      rolloutGates,
      stopAfter: rolloutGates.passiveShadowObservation ? "correlate" : args.options?.stopAfter,
    };
    let result;
    let failure = null;
    try {
      // The legacy pipeline parameter is fixed to its explicit-review path;
      // current automation authority comes exclusively from the v0.4 gate.
      result = await pipelineInstance.runEvolutionCycle({ ...args, ctx: args.ctx ?? ctx, mode: "auto", options: cycleOptions });
      if (result?.result === "applied") {
        const finalized = currentProposal(result.proposal?.id) ? markApplied(result.proposal?.id) : { ok: true };
        result = !finalized?.ok
          ? { result: "failed-closed", cycleOutcome: "failed-closed", reason: finalized?.reason ?? "apply-failed", responseText: `Proposal ${result.proposal?.id} was applied but final state recovery is required.` }
          : { ...result, responseText: `${result.responseText}\n${RESTART_REMINDER}` };
      }
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      uiProjectionDirty = true;
      const trigger = args.trigger?.reason ?? args.trigger?.kind ?? args.trigger;
      const triggerClass = trigger === "scheduler" || trigger === "idle"
        ? "idle"
        : trigger === "recovery"
          ? "recovery"
          : typeof trigger === "string" && trigger.startsWith("manual")
            ? "manual"
            : "other";
      const inferredOutcome = {
        "proposal-ready": "recommendation-created",
        "proposal-pending": "recommendation-created",
        applied: "applied",
        deferred: "deferred",
        "failed-closed": "failed-closed",
        "no-change": "valid-no-change",
      }[result?.result];
      const rawOutcome = failure ? "failed" : result?.cycleOutcome ?? inferredOutcome;
      const outcome = CYCLE_OUTCOMES.has(rawOutcome) ? rawOutcome : failure ? "failed" : "failed-closed";
      const rawReason = failure ? "pipeline-failed" : result?.cycleReason ?? result?.reason ?? null;
      const reason = rawReason === null || CYCLE_REASONS.has(rawReason)
        ? rawReason
        : outcome === "failed" ? "pipeline-failed" : null;
      const occurredAt = now();
      try {
        appendAudit("decision", {
          action: "cycle-outcome",
          outcome,
          triggerClass,
          observationCount: Array.isArray(result?.observations) ? result.observations.length : 0,
          eligibilityCount: Array.isArray(result?.eligibility)
            ? result.eligibility.filter((item) => item?.eligible === true).length
            : 0,
          occurredAt,
          reason,
        }, result?.proposal?.id, "self-evolve-integration", occurredAt);
      } catch {
        // The root epoch may be terminal (purge-all accepted while this cycle
        // was in-flight). The cycle-outcome audit is diagnostic and the subtree
        // is being deleted, so swallowing is safe.
      }
    }
  }

  async function runApprovalFlow(args = {}) {
    let proposal = currentProposal(args.proposalId);
    if (!proposal) return { result: "failed-closed", responseText: `Proposal ${args.proposalId} was not found.` };
    let decision = (store.readRecords?.("decision") ?? []).map((record) => record.payload).findLast((item) => item.proposalId === proposal.id && item.newState === "approved");
    const authority = evaluateAuthority({ proposal, decision, headless: args.headless === true });
    if (!authority.allowed) return { result: "failed-closed", reason: authority.reason, responseText: `Proposal ${proposal.id} was not applied: ${authority.reason}.` };
    const result = await pipelineInstance.runApprovalFlow({ ...args, ctx: args.ctx ?? ctx, mode: "auto", projectFingerprint: args.projectFingerprint ?? proposal.projectFingerprint, headless: args.headless === true });
    if (result?.result === "applied") {
      const finalized = markApplied(proposal.id);
      if (!finalized?.ok) return { result: "failed-closed", reason: finalized?.reason ?? "applied-transition-failed", responseText: `Proposal ${proposal.id} was applied but final state recovery is required.` };
      return { ...result, responseText: `${result.responseText}\n${RESTART_REMINDER}` };
    }
    if (result?.deferred || result?.reason === "lease-busy") return { ...result, result: "deferred", deferred: true };
    if (currentProposal(proposal.id)?.state === "approved") markFailedClosed(proposal.id, result?.reason ?? "apply-failed");
    return result;
  }

  async function runRollbackFlow(args = {}) {
    return pipelineInstance.runRollbackFlow({ ...args, ctx: args.ctx ?? ctx });
  }

  async function handleEvent(event) {
    if (closed) return { scheduled: false, reason: "integration-closing" };
    if (terminalGateReason()) return { scheduled: false, reason: "restart-required-after-purge-all" };
    if (!isDurableLifecycleEvent(event)) return { scheduled: false, reason: "irrelevant-event" };
    const automation = automationState();
    if (!automation.ok || !automation.enabled) {
      return { scheduled: false, reason: automation.reason ?? "automatic-recommendations-disabled" };
    }
    const current = settings();
    const body = event?.event && typeof event.event === "object" ? event.event : event;
    const projectFingerprint = body?.properties?.projectFingerprint ?? current?.repo?.projectFingerprint;
    const operational = getProjectOperationalState(projectFingerprint, current);
    schedulerInstance.setMode?.(operational.automaticWorkAllowed ? "auto" : "manual", "event-refresh");
    if (!operational.automaticWorkAllowed) return {
      scheduled: false,
      reason: operational.reason,
    };
    let lineage;
    try {
      lineage = await hydrateRootLineage(event, projectFingerprint);
    } catch {
      return { scheduled: false, reason: "session-ancestry-unavailable" };
    }
    if (closed) return { scheduled: false, reason: "integration-closing" };
    if (!lineage?.resolved) return { scheduled: false, reason: "session-ancestry-unavailable" };
    if (lineage.originKind === "delegated") return { scheduled: false, reason: "delegated-root" };
    if (lineage.originKind !== "user") return { scheduled: false, reason: "non-user-root" };
    await schedulerInstance.handleEvent(event, lineage);
    return { scheduled: true, automaticRecommendationsEnabled: true };
  }

  async function decide({ proposalId, decision, actor } = {}) {
    const id = proposalId ?? decision?.proposalId;
    let proposal = currentProposal(id);
    if (!proposal) return { ok: false, reason: "record-not-found" };
    const requested = decision ?? makeDecision(proposal, "approved", actor);
    if (requested.proposalId !== proposal.id) return { ok: false, reason: "cross-scope" };

    if (requested.newState === "rolled-back") {
      if (proposal.state !== "applied") return { ok: false, reason: "stale-prior-state" };
      const rolledBack = await runRollbackFlow({ proposalId: proposal.id, actor: actor ?? requested.actor, reason: "tui-decision" });
      if (rolledBack.result !== "rolled-back") {
        markFailedClosed(proposal.id, rolledBack.reason ?? "rollback-failed");
        return { ok: false, reason: rolledBack.reason ?? "rollback-failed" };
      }
      proposal = currentProposal(id);
      const internal = makeDecision(proposal, "rolled-back", "self-evolve-applier");
      const changed = casDecision(proposal, internal);
      return changed.ok ? { ok: true, auditId: rolledBack.auditEvents?.at(-1)?.id } : changed;
    }

    if (requested.newState === "pending") {
      if (proposal.state !== requested.priorState || proposal.state !== "pending") return { ok: false, reason: "stale-prior-state" };
      const committed = casDecision(proposal, requested);
      if (!committed.ok) return committed;
      appendAudit("decision", { action: "snooze", snoozedUntil: requested.timestamp + 86_400_000, state: "pending" }, proposal.id, requested.actor);
      return { ok: true };
    }

    const changed = casDecision(proposal, requested);
    if (!changed.ok) return changed;
    if (requested.newState !== "approved") return { ok: true, auditId: changed.auditEvent?.id };
    const applied = await runApprovalFlow({ proposalId: proposal.id, actor: actor ?? requested.actor, projectFingerprint: proposal.projectFingerprint });
    const applyAudit = applied.auditEvents?.findLast?.((event) => event.kind === "apply" && event.details?.["readback-verified"] === true);
    if (applied.result !== "applied") markFailedClosed(proposal.id, applied.reason ?? "apply-failed");
    return applied.result === "applied"
      ? { ok: true, appliedHash: applyAudit?.details?.appliedHash ?? /appliedHash ([a-f0-9]{64})/u.exec(applied.responseText ?? "")?.[1], auditId: applyAudit?.id, responseText: applied.responseText }
      : { ok: false, reason: applied.reason ?? "apply-failed", responseText: applied.responseText };
  }

  async function approveHeadless(command) {
    const proposal = currentProposal(command.proposalId);
    const current = settings();
    const grant = latestHeadlessGrant(command.proposalId)?.details;
    if (!proposal || !current || !grant) return { ok: false, reason: "record-not-found", responseText: `Proposal ${command.proposalId} has no current headless approval grant.` };
    const exact = proposal.projectFingerprint === current.repo.projectFingerprint
      && proposal.state === "pending"
      && proposal.skillTarget.currentHash === command.targetHash
      && proposal.proposedContentHash === command.proposedContentHash
      && proposal.decisionVersion + 1 === command.decisionVersion
      && grant.action === "headless-approval-nonce"
      && grant.projectFingerprint === proposal.projectFingerprint
      && grant.subjectId === proposal.id
      && grant.targetHash === command.targetHash
      && grant.proposedContentHash === command.proposedContentHash
      && grant.decisionVersion === command.decisionVersion
      && grant.priorState === proposal.state
      && grant.actor === "self-evolve-command"
      && grant.nonce === command.nonce
      && grant.expiresAt > now();
    if (!exact) return { ok: false, reason: "approval-tuple-mismatch", responseText: `Proposal ${proposal.id} was not applied: approval-tuple-mismatch.` };
    const decision = schemas.makeDecision({
      proposalId: proposal.id,
      targetHash: command.targetHash,
      proposedContentHash: command.proposedContentHash,
      decisionVersion: command.decisionVersion,
      actor: "self-evolve-command",
      timestamp: now(),
      nonce: command.nonce,
      priorState: "pending",
      newState: "approved",
    });
    const changed = casDecision(proposal, decision);
    if (!changed.ok) return { ok: false, reason: changed.reason, responseText: `Proposal ${proposal.id} was not applied: ${changed.reason}.` };
    const applied = await runApprovalFlow({ proposalId: proposal.id, actor: decision.actor, projectFingerprint: proposal.projectFingerprint, headless: true });
    if (applied.result !== "applied") markFailedClosed(proposal.id, applied.reason ?? "apply-failed");
    return applied.result === "applied"
      ? { ok: true, responseText: applied.responseText, auditEvents: applied.auditEvents }
      : { ok: false, reason: applied.reason ?? "apply-failed", responseText: applied.responseText };
  }

  // H5-002: Authenticated, audited root-global circuit-breaker reset. The sole
  // recovery path from a tripped breaker epoch. Requires an exact operator-typed
  // confirmation and a full authenticated commitment bound to the validated root
  // identity, acting project, schema/protocol versions, and a one-use nonce.
  // The store advances the breaker epoch generation and clears tripped so every
  // peer process sharing the state root sees the healthy state at its next
  // admission/provider/effect boundary read. Replay-safe (nonce burned,
  // generation advanced; a replayed reset on a healthy breaker fails with a
  // stable reason) and cannot be model-selected (exact confirmation +
  // operator-typed command only). Also resets the scheduler-local breaker so
  // this process resumes immediately.
  function resetBreaker(command) {
    let record;
    try {
      const projectFingerprint = command.projectFingerprint ?? settings()?.repo?.projectFingerprint;
      const authentication = {
        rootIdentityHash: options.stateRoot ? stateRootIdentity(options.stateRoot) : store.rootIdentity,
        projectFingerprintHash: projectFingerprint ? sha256(projectFingerprint) : null,
        schemaVersion: schemas?.SCHEMA_VERSION ?? null,
        protocolVersion: "self-evolve-breaker-epoch-v1",
        nonce: sha256(`breaker-reset:${now()}:${randomBytes(16).toString("hex")}`),
        operatorAuthority: "operator",
      };
      record = store.resetBreakerEpoch?.({ confirmation: command.confirmation, authentication });
    } catch (error) {
      return {
        ok: false,
        reason: errorReasonCode(error, "breaker-reset-failed"),
        responseText: `Circuit breaker reset failed: ${errorReasonCode(error, "breaker-reset-failed")}.`,
      };
    }
    try {
      appendAudit("decision", {
        action: "breaker-epoch-reset",
        generation: record?.generation ?? null,
        tripped: false,
        operatorAuthority: "operator",
      }, undefined, "self-evolve-command");
    } catch {}
    // Clear the scheduler-local breaker so this process resumes immediately;
    // peer processes see the cleared durable epoch at their next boundary read.
    try { schedulerInstance?.resetCircuitBreaker?.("operator-root-reset"); } catch {}
    uiProjectionDirty = true;
    globalProjectionDirty = true;
    return {
      ok: true,
      reset: true,
      generation: record?.generation ?? null,
      responseText: `Self-evolve circuit breaker reset to generation ${record?.generation ?? "unknown"}. Automatic work resumes at the next eligible boundary for every process sharing this state root.`,
    };
  }

  function reinitializeFromTerminal(command) {
    // The sole recovery path from a terminal root epoch. Requires an exact
    // operator-typed confirmation and a full authenticated commitment bound to
    // the validated root identity, acting project, schema/protocol versions,
    // one-use nonce, and the default consent snapshot. The store writes the new
    // epoch durably (incrementing the generation, clearing terminal); the
    // operator then restarts to recreate the subtree and re-boot. Replay-safe
    // (nonce burned, generation advanced) and cannot be model-selected (exact
    // confirmation + operator-typed command only).
    let record;
    try {
      const projectFingerprint = command.projectFingerprint ?? settings()?.repo?.projectFingerprint;
      const authentication = {
        rootIdentityHash: options.stateRoot ? stateRootIdentity(options.stateRoot) : store.rootIdentity,
        projectFingerprintHash: projectFingerprint ? sha256(projectFingerprint) : null,
        schemaVersion: schemas?.SCHEMA_VERSION ?? null,
        protocolVersion: "self-evolve-root-epoch-v1",
        nonce: sha256(`reinitialize:${now()}:${randomBytes(16).toString("hex")}`),
        consentSnapshotHash: sha256(JSON.stringify(["reinitialize-default-consent", schemas?.SCHEMA_VERSION ?? null, "manual"])),
        operatorAuthority: "operator",
      };
      record = store.reinitializeRoot?.({ confirmation: command.confirmation, authentication });
    } catch (error) {
      return {
        ok: false,
        reason: errorReasonCode(error, "reinitialize-failed"),
        responseText: `Reinitialize failed: ${errorReasonCode(error, "reinitialize-failed")}.`,
      };
    }
    // The audit is diagnostic; after a purge-all the subtree was deleted so the
    // audit write may fail. The epoch was advanced successfully regardless.
    try {
      appendAudit("decision", {
        action: "root-epoch-reinitialize",
        generation: record?.generation ?? null,
        terminal: false,
        operatorAuthority: "operator",
        restartRequired: true,
      }, undefined, "self-evolve-command");
    } catch {}
    return {
      ok: true,
      reinitialized: true,
      generation: record?.generation ?? null,
      responseText: `Self-evolve root epoch reinitialized to generation ${record?.generation ?? "unknown"}. Restart OpenCode to complete reinitialization and recreate durable state.`,
    };
  }

  async function handleCommand(input, output) {
    if (closed) return { ok: false, reason: "integration-closed" };
    const raw = typeof input === "string" ? input : input?.command ?? input?.input ?? input;
    const parsed = typeof raw === "object" && raw?.verb ? { ok: true, command: raw } : commands?.parseSelfEvolveCommand?.(raw) ?? { ok: false, error: "command-parser-unavailable" };
    if (parsed.ok && parsed.command.verb === "removed") {
      const result = commandPolicy.execute(parsed.command);
      if (output && typeof output === "object") output.responseText = result.responseText;
      return result;
    }
    // Reinitialize is the sole recovery path from a terminal epoch and is the
    // only command permitted through the terminal gate. It cannot be
    // model-selected: it requires an exact operator-typed confirmation.
    if (parsed.ok && parsed.command.verb === "reinitialize") {
      const result = reinitializeFromTerminal(parsed.command);
      if (output && typeof output === "object") output.responseText = result.responseText;
      return result;
    }
    const gateReason = terminalGateReason();
    if (gateReason) {
      const result = { ok: false, terminal: true, reason: gateReason, responseText: "Self-evolve state was purged. Restart OpenCode and run /self-evolve reinitialize to reinitialize durable self-evolve state." };
      if (output && typeof output === "object") output.responseText = result.responseText;
      return result;
    }
    if (!parsed.ok) return { ok: false, responseText: parsed.error };
    await processMailbox();
    const command = parsed.command;
    let result;
    let afterResponse;
    if (command.verb === "approve") {
      result = await approveHeadless(command);
    } else if (command.verb === "allowlist") {
      result = updateHeadlessAllowlist(command);
    } else if (command.verb === "reject" || command.verb === "dismiss" || command.verb === "undo") {
      const proposal = currentProposal(command.proposalId);
      if (!proposal) result = { ok: false, reason: "record-not-found", responseText: `Proposal ${command.proposalId} was not found.` };
      else {
        const state = command.verb === "undo" ? "rolled-back" : "rejected";
        result = await decide({ proposalId: proposal.id, decision: makeDecision(proposal, state, "self-evolve-command"), actor: "self-evolve-command" });
      }
    } else if (command.verb === "purge" && command.scope === "all") {
      try {
        // The terminal epoch is written durably in scheduleTerminalPurge
        // (afterResponse) after this acceptance audit is recorded and before
        // authority stop and deletion. Acceptance audit first, then stop
        // authority, then schedule the destructive sequence.
        appendAudit("purge", {
          action: "headless-purge-all-accepted",
          status: "accepted-terminal",
          terminal: true,
          confirmationHash: sha256(command.confirmation),
          restartRequired: true,
        }, undefined, "self-evolve-command");
        stopAfterPurgeAll();
        result = {
          ok: true,
          terminal: true,
          status: "accepted-terminal",
          terminalPurge: true,
          responseText: "Purge all accepted-terminal. Self-evolve authority stopped; deletion is scheduled. Restart OpenCode before using self-evolve again.",
        };
        afterResponse = scheduleTerminalPurge;
      } catch (error) {
        result = {
          ok: false,
          reason: errorReasonCode(error, "purge-all-acceptance-failed"),
          responseText: `Purge all was not accepted: ${errorReasonCode(error, "purge-all-acceptance-failed")}.`,
        };
      }
    } else if (command.verb === "reinitialize") {
      result = reinitializeFromTerminal(command);
    } else if (command.verb === "reset-breaker") {
      result = resetBreaker(command);
    } else if (command.verb === "kill-switch") {
      const switchResult = command.enabled
        ? triggerKillSwitch("command")
        : clearKillSwitch("command");
      result = {
        ...switchResult,
        responseText: switchResult.ok
          ? command.enabled
            ? "Kill switch enabled. Automatic recommendations preference is unchanged; new automatic work and Apply are suppressed. No files were applied."
            : "Kill switch disabled. Automatic recommendations preference is unchanged. No files were applied."
          : `Kill switch failed: ${switchResult.reason ?? switchResult.error}.`,
      };
    } else {
      result = commandPolicy.execute(command, { projectFingerprint: input?.projectFingerprint ?? settings()?.repo?.projectFingerprint });
      if ((command.verb === "status" || command.verb === "health") && backgroundRestartRequired()) {
        result = {
          ...result,
          responseText: `${result.responseText} Background analysis is awaiting an OpenCode restart before it can activate.`,
        };
      }
      if (result.terminalPurge) stopAfterPurgeAll();
      else {
        invalidateRoutingSettings();
        uiProjectionDirty = true;
        globalProjectionDirty = true;
        const commandProjectFingerprint = input?.projectFingerprint ?? settings()?.repo?.projectFingerprint;
        syncSchedulerAdmission(commandProjectFingerprint, `command-${command.verb}`);
        if (command.verb === "automatic-recommendations" && !command.enabled) {
          downgradeInFlight("automatic-recommendations-off", { kinds: ["passive"] });
        } else if (command.verb === "consent" && !command.value) {
          downgradeInFlight("permission-revoked", { kinds: ["passive"] });
        } else if (command.verb === "repo-override" && command.excluded) {
          downgradeInFlight("project-excluded", { kinds: ["passive"], projectFingerprint: commandProjectFingerprint });
        }
      }
    }
    if (command.verb === "purge") sensitiveExportManager = undefined;
    if (command.verb === "reset-breaker" && result.ok) {
      invalidateRoutingSettings();
      syncSchedulerAdmission(input?.projectFingerprint ?? settings()?.repo?.projectFingerprint, "command-reset-breaker");
    }
    if (output && typeof output === "object") output.responseText = result.responseText;
    afterResponse?.();
    if (!terminalPurge) await processMailbox();
    return result;
  }

  function stopAfterPurgeAll() {
    terminalPurge = true;
    clearMailboxInterval(mailboxTimer);
    mailboxTimer = undefined;
    clearRetentionInterval(retentionTimer);
    retentionTimer = undefined;
    schedulerInstance.setMode?.("manual", "purge-all");
    schedulerInstance.stopAdmission?.("purge-all");
    for (const record of inFlight.values()) {
      record.controller.abort("purge-all");
      schedulerInstance.cancelPending?.(record.item.sessionID);
    }
  }

  function getHealth() {
    const current = settings();
    const automation = automationState();
    const hostSessionRecovery = hostRecoveryReport ? {
      ok: hostRecoveryReport.ok,
      cancelled: hostRecoveryReport.cancelled,
      attempts: hostRecoveryReport.attempts,
      aborted: hostRecoveryReport.aborted,
      failed: hostRecoveryReport.failed,
      ...(hostRecoveryReport.reason ? { reason: hostRecoveryReport.reason } : {}),
    } : null;
    return {
      automaticRecommendationsEnabled: automation.ok && automation.enabled,
      projectExcluded: automation.ok ? automation.repo.excluded : true,
      circuitBreakerOpen: circuitBreakerOpen(),
      killSwitchActive: runtimeKillSwitch || automation.global?.killSwitchActive === true,
      hostVersion,
      hostVersionSource,
      schemaVersion: schemas.V4_SCHEMA_VERSION,
      lifecycleEventHookInstalled: options.passiveEventHookInstalled !== false,
      backgroundRestartRequired: backgroundRestartRequired(current),
      ...(hostSessionRecovery ? { hostSessionRecovery } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  async function recoverHostSessions(args = {}) {
    if (hostRecoveryReport) return hostRecoveryReport;
    if (hostRecoveryTask) return hostRecoveryTask;
    if (closed) return { ok: false, cancelled: true, attempts: 0, outcomes: [], reason: "integration-closed" };
    const timeoutMs = Math.min(10_000, Math.max(10, args.timeoutMs ?? options.hostRecoveryTimeoutMs ?? 2_000));
    const retries = Math.min(3, Math.max(0, args.retries ?? options.hostRecoveryRetries ?? 2));
    const backoffMs = Math.min(2_000, Math.max(1, args.backoffMs ?? options.hostRecoveryBackoffMs ?? 50));
    hostRecoveryController = new AbortController();
    const { signal } = hostRecoveryController;
    hostRecoveryTask = (async () => {
      let attempts = 0;
      let outcomes = [];
      let reason;
      while (attempts <= retries && !signal.aborted) {
        attempts += 1;
        try {
          outcomes = await recoverOrphanedHiddenSessions(ctx?.client, ctx?.directory, {
            store,
            ...hostOwnershipContext(),
            now: now(),
            timeoutMs,
            signal,
          });
          reason = undefined;
          break;
        } catch (error) {
          reason = errorReasonCode(error, "unknown-error");
          if (attempts > retries || signal.aborted) break;
          await boundedHostCall(
            () => new Promise((resolve) => setTimeout(resolve, backoffMs * (2 ** (attempts - 1)))),
            { timeoutMs: backoffMs * (2 ** (attempts - 1)) + 10, signal, label: "host-recovery-backoff" },
          ).catch(() => {});
        }
      }
      const report = {
        ok: !signal.aborted && reason === undefined && outcomes.every((item) => item.ok),
        cancelled: signal.aborted,
        attempts,
        aborted: outcomes.filter((item) => item.action === "deleted").length,
        failed: outcomes.filter((item) => !item.ok).length,
        outcomes,
        ...(reason ? { reason } : {}),
      };
      hostRecoveryReport = report;
      try { appendAudit("decision", { action: "host-session-recovery", attempts, aborted: report.aborted, failed: report.failed, cancelled: report.cancelled, ...(reason ? { reason } : {}) }); } catch {}
      return report;
    })().finally(() => { hostRecoveryTask = undefined; hostRecoveryController = undefined; });
    return hostRecoveryTask;
  }

  function triggerKillSwitch(reason = "runtime", request) {
    if (terminalPurge) return { ok: false, reason: "restart-required-after-purge-all" };
    const current = automationState();
    if (!current.ok) return { ok: false, reason: current.reason ?? "automation-state-unavailable" };
    const saved = store.transitionAutomation({
      transitionId: request?.requestId ?? `emergency-stop:on:${current.epoch.generation}:${now()}:${randomUUID()}`,
      expectedGeneration: current.epoch.generation,
      action: "set-emergency-stop",
      enabled: true,
    });
    if (!saved.ok) return { ok: false, reason: saved.reason };
    runtimeKillSwitch = true;
    invalidateRoutingSettings();
    const auditEvent = appendAudit("kill-switch", {
      action: "on",
      reason: String(reason).slice(0, 512),
      automaticRecommendationsEnabled: saved.settings.automaticRecommendationsEnabled,
    });
    if (request) store.appendRecord(operationCompletionRecord(request, { ok: true }));
    setModeForDowngrade("kill-switch");
    publish("self-evolve.settings", { action: "kill-switch", enabled: true });
    return { ok: true, automaticRecommendationsEnabled: saved.settings.automaticRecommendationsEnabled, auditEvent };
  }

  function abortInFlight(reason, { kinds = ["passive", "manual"], projectFingerprint = null } = {}) {
    for (const record of inFlight.values()) {
      if (!kinds.includes(record.kind)) continue;
      if (projectFingerprint && record.item.projectFingerprint !== projectFingerprint) continue;
      record.controller.abort(reason);
    }
  }

  // Abort matching in-flight controllers BEFORE cancellation/result bookkeeping.
  // Scheduler bookkeeping (cancelPending/recordWorkResult) applies only to
  // scheduler-admitted passive work; explicit-manual scans are tracked in the
  // in-flight registry for global-safety aborts but are not scheduler-owned.
  function downgradeInFlight(reason, { kinds = ["passive", "manual"], projectFingerprint = null } = {}) {
    abortInFlight(reason, { kinds, projectFingerprint });
    if (!kinds.includes("passive")) return;
    for (const record of inFlight.values()) {
      if (record.kind !== "passive") continue;
      if (projectFingerprint && record.item.projectFingerprint !== projectFingerprint) continue;
      const { item } = record;
      schedulerInstance.cancelPending?.(item.sessionID);
      schedulerInstance.recordWorkResult?.(item, { result: "downgrade", downgrade: true });
    }
  }

  function setModeForDowngrade(reason, opts = {}) {
    schedulerInstance.setMode?.("manual", reason);
    downgradeInFlight(reason, opts);
  }

  function clearKillSwitch(reason = "runtime", request) {
    if (terminalPurge) return { ok: false, reason: "restart-required-after-purge-all" };
    const current = automationState();
    if (!current.ok) return { ok: false, reason: current.reason ?? "automation-state-unavailable" };
    const saved = store.transitionAutomation({
      transitionId: request?.requestId ?? `emergency-stop:off:${current.epoch.generation}:${now()}:${randomUUID()}`,
      expectedGeneration: current.epoch.generation,
      action: "set-emergency-stop",
      enabled: false,
    });
    if (!saved.ok) return { ok: false, reason: saved.reason };
    runtimeKillSwitch = false;
    invalidateRoutingSettings();
    syncSchedulerAdmission(settings()?.repo?.projectFingerprint, "kill-switch-cleared");
    const auditEvent = appendAudit("kill-switch", {
      action: "off",
      reason: String(reason),
      automaticRecommendationsEnabled: saved.settings.automaticRecommendationsEnabled,
    });
    if (request) store.appendRecord(operationCompletionRecord(request, { ok: true }));
    publish("self-evolve.settings", { action: "kill-switch", enabled: false });
    return { ok: true, automaticRecommendationsEnabled: saved.settings.automaticRecommendationsEnabled, auditEvent };
  }

  async function boot(args = {}) {
    if (terminalGateReason()) return { ok: false, automaticWorkAllowed: false, reason: "restart-required-after-purge-all", health: { automaticWorkAllowed: false, lastError: "restart-required-after-purge-all" } };
    ctx = args.ctx ?? ctx;
    hostVersion = String(args.hostVersion ?? hostVersion);
    hostVersionSource = args.hostVersionSource === "tui-app-version" ? "tui-app-version" : hostVersionSource;
    let recovery = [];
    let globalDecisionRecovery = [];
    let globalRejectionRecovery = { ok: true, recovered: [] };
    let synthesisRecovery = [];
    let hiddenSessionRecovery = [];
    try {
      const terminalIntent = (store.readRecords?.("audit-event") ?? []).map((record) => record.payload).findLast((event) =>
        (event.details?.action === "ui-operation-complete"
          && event.details?.uiAction === "purge-all"
          && event.details?.accepted === true
          && event.details?.terminal === true)
        || (event.details?.action === "headless-purge-all-accepted"
          && event.details?.status === "accepted-terminal"
          && event.details?.terminal === true));
      if (terminalIntent) {
        if (terminalIntent.details.action === "ui-operation-complete"
            && store.hasPendingOperationRequest?.(terminalIntent.details.requestId) === true) await processMailbox();
        if (terminalPurge) {
          return {
            ok: false,
            automaticWorkAllowed: false,
            reason: "restart-required-after-purge-all",
            health: { automaticWorkAllowed: false, lastError: "restart-required-after-purge-all" },
          };
        }
        stopAfterPurgeAll();
        // Ensure the terminal epoch is durable: if the crash happened before
        // scheduleTerminalPurge wrote it, write it now so peers fail closed.
        try { store.markRootTerminal?.({ terminalOperationId: `boot-recovery-terminal:${now()}` }); } catch {}
        await startWorkDrain();
        try { sensitiveExportManager?.purge(); } catch {}
        sensitiveExportManager = undefined;
        privacy.purgeScope({ scope: "all" });
        return {
          ok: false,
          automaticWorkAllowed: false,
          reason: "restart-required-after-purge-all",
          health: { automaticWorkAllowed: false, lastError: "restart-required-after-purge-all" },
        };
      }
      settings();
      const projectRoot = options.projectRoot ?? options.worktree ?? ctx?.worktree ?? ctx?.directory;
      await currentHostGlobalCatalog(projectRoot);
      store.recoverDecisionTransaction?.();
      globalRejectionRecovery = recoverGlobalRejectionsForAuthority();
      const contributionRecovery = pipelineInstance.recoverContributionTransactions?.();
      if (contributionRecovery?.ok === false) throw new Error("contribution-recovery-failed");
      synthesisRecovery = pipelineInstance.recoverSynthesisAttempts?.() ?? [];
      globalDecisionRecovery = await globalDecisionDomain?.recover?.() ?? [];
      const retention = await runRetentionSweep();
      if (!retention.ok) throw new Error(retention.reason ?? "retention-failed");
      recovery = await applier.recoverPending?.() ?? [];
      const applyRecovery = new Map(recovery.map((item) => [item.proposalId, item]));
      const recoveredFailedClosed = new Set();
      for (const proposal of [...latestById(store.readRecords?.("proposal") ?? []).values()].filter((item) => item.state === "approved")) {
        const verified = (store.readRecords?.("audit-event") ?? []).some((record) => record.payload.kind === "apply" && record.payload.proposalId === proposal.id && record.payload.details?.["readback-verified"] === true);
        if (verified) {
          const lease = applier.getApplyLeaseStatus?.(proposal.id);
          if (lease?.held) {
            recovery.push({ ok: true, deferred: true, proposalId: proposal.id, action: "deferred", reason: "lease-busy" });
            continue;
          }
          const finalized = markApplied(proposal.id);
          recovery.push({ ok: finalized?.ok === true, proposalId: proposal.id, action: "completed-applied-state", ...(finalized?.ok ? {} : { reason: finalized?.reason }) });
          continue;
        }
        const recoveredApply = applyRecovery.get(proposal.id);
        if (recoveredApply) {
          if (recoveredApply.deferred || recoveredApply.reason === "lease-busy") continue;
          const failed = markFailedClosed(proposal.id, recoveredApply.reason ?? "apply-not-verified");
          if (failed.ok) recoveredFailedClosed.add(recoveredApply);
          recovery.push({ ok: failed.ok, proposalId: proposal.id, action: "failed-closed" });
          continue;
        }
        const resumed = await runApprovalFlow({ proposalId: proposal.id, actor: "self-evolve-recovery", projectFingerprint: proposal.projectFingerprint });
        if (resumed.result === "applied") {
          const finalized = currentProposal(proposal.id)?.state === "applied" ? { ok: true } : markApplied(proposal.id);
          recovery.push({ ok: finalized?.ok === true, proposalId: proposal.id, action: "resumed-apply", ...(finalized?.ok ? {} : { reason: finalized?.reason }) });
        } else if (resumed.deferred || resumed.reason === "lease-busy") {
          recovery.push({ ok: true, deferred: true, proposalId: proposal.id, action: "deferred", reason: "lease-busy" });
        } else {
          const failed = markFailedClosed(proposal.id, resumed.reason ?? "apply-recovery-failed");
          recovery.push({ ok: failed.ok, proposalId: proposal.id, action: "failed-closed", reason: resumed.reason ?? "apply-recovery-failed" });
        }
      }
      if (args.recoverHostSessions !== false) hiddenSessionRecovery = await recoverOrphanedHiddenSessions(ctx?.client, ctx?.directory, {
        store,
        ...hostOwnershipContext(),
        now: now(),
      });
      recovery = recovery.map((item) => recoveredFailedClosed.has(item) ? { ...item, recoveredToFailedClosed: true } : item);
    } catch (error) {
      corrupt = true;
      lastError = errorReasonCode(error, "unknown-error");
    }
    // Calculate aggregate boot success ONCE across every mandatory recovery
    // family. Both failure modes are covered: thrown errors set `corrupt`
    // in the catch above, and non-throwing ok:false items fail the predicates.
    const bootSucceeded = !corrupt
      && recovery.every((item) => item.ok !== false || item.recoveredToFailedClosed === true)
      && synthesisRecovery.every((item) => item.ok)
      && globalDecisionRecovery.every((item) => item.ok !== false)
      && globalRejectionRecovery.ok !== false
      && hiddenSessionRecovery.every((item) => item.ok);
    bootValidated = bootSucceeded;
    // Activate runtime authority, timers, and the boot-success audit ONLY
    // after aggregate success. On failure: no grants issued, no mailbox
    // effects applied, no settings/decision changes, no target mutations,
    // no polling started, no provider dispatch, and bootValidated stays false.
    if (bootSucceeded) {
      if (options.stateRoot) {
        try {
          refreshGlobalRecommendationProjection({ force: true });
        } catch (error) {
          lastError = errorReasonCode(error, "global-bridge-boot-failed");
          globalProjection = undefined;
          globalProjectionDirty = true;
        }
        issueBridgeNonces();
        if (args.processMailbox !== false) {
          try { await processMailbox(); } catch (error) { lastError = errorReasonCode(error, "unknown-error"); }
        }
        startMailboxPolling();
      }
      startRetentionTimer();
      appendAudit("decision", { action: "boot", hostVersion, hostVersionSource, schemaVersion: schemas.SCHEMA_VERSION, recovered: recovery.length, recoveredSyntheses: synthesisRecovery.length, abortedHiddenSessions: hiddenSessionRecovery.filter((item) => item.action === "deleted").length, hiddenSessionRecoveryFailures: hiddenSessionRecovery.filter((item) => !item.ok).length });
    }
    const automaticWorkAllowed = syncSchedulerAdmission(settings()?.repo?.projectFingerprint, "boot");
    return { ok: bootSucceeded, automaticWorkAllowed, recovered: recovery, synthesisRecovery, globalDecisionRecovery, globalRejectionRecovery, hiddenSessionRecovery, health: getHealth() };
  }

  function startWorkDrain() {
    if (workDrainTask) return workDrainTask;
    schedulerInstance.stopAdmission?.("shutdown");
    hostRecoveryController?.abort();
    for (const record of inFlight.values()) record.controller.abort("integration-shutdown");
    clearMailboxInterval(mailboxTimer);
    mailboxTimer = undefined;
    clearRetentionInterval(retentionTimer);
    retentionTimer = undefined;
    workDrainTask = (async () => {
      await mailboxTask;
      await retentionTask;
      await hostRecoveryTask;
      while (inFlight.size) await Promise.allSettled([...inFlight.values()].map((record) => record.promise));
      await schedulerInstance.drain?.();
      return { ok: true };
    })();
    return workDrainTask;
  }

  async function closeResources() {
    await terminalPurgeTask;
    if (!schedulerDisposed) {
      schedulerInstance.dispose?.();
      schedulerDisposed = true;
    }
    const applierClose = await applier.close?.();
    if (applierClose?.ok === false) {
      shutdownDegraded = true;
      return { ok: false, reason: "applier-close-degraded", applier: applierClose };
    }
    if (!terminalPurge) await store.flushAudit?.();
    const storeClose = await store.close?.();
    if (storeClose?.ok === false) {
      shutdownDegraded = true;
      return { ok: false, reason: "store-close-degraded", store: storeClose };
    }
    shutdownDegraded = false;
    resourcesClosed = true;
    return { ok: true };
  }

  function closeAfterDrain() {
    if (!resourceCloseTask) {
      resourceCloseTask = startWorkDrain().then(closeResources);
      void resourceCloseTask.then((result) => {
        if (result?.ok === false) resourceCloseTask = undefined;
      }, () => { resourceCloseTask = undefined; });
    }
    return resourceCloseTask;
  }

  async function shutdown() {
    if (resourcesClosed && !shutdownDegraded) return { ok: true, alreadyClosed: true };
    closed = true;
    const completion = closeAfterDrain();
    const timeoutMs = Number.isSafeInteger(options.__testShutdownTimeoutMs) && options.__testShutdownTimeoutMs > 0
      ? options.__testShutdownTimeoutMs
      : AUTONOMOUS_SHUTDOWN_TIMEOUT_MS;
    let timer;
    const outcome = await Promise.race([
      completion.then((result) => ({ settled: true, result })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.settled) return outcome.result;
    shutdownDegraded = true;
    return { ok: false, reason: "autonomous-work-draining", timeoutMs, completion };
  }

  const testBridge = Object.freeze({
    getInbox({ projectFingerprint } = {}) {
      const expected = projectFingerprint ?? settings()?.repo?.projectFingerprint;
      return [...latestById(store.readRecords?.("proposal") ?? []).values()]
        .filter((proposal) => proposal.projectFingerprint === expected && ["pending", "failed-closed"].includes(proposal.state))
        .map((proposal) => ({ ...proposal, eligibility: eligibilityFor(proposal) }));
    },
    getProposal({ proposalId, projectFingerprint } = {}) {
      const proposal = currentProposal(proposalId);
      if (!proposal || (projectFingerprint && proposal.projectFingerprint !== projectFingerprint)) return null;
      const content = proposalContent(proposal);
      const scan = privacy?.scanForForbiddenContent?.(content);
      const preview = scan?.ok === false ? "[preview withheld: unsafe content]" : content.split(/\r?\n/u).slice(0, 50).join("\n");
      return { proposal, eligibility: eligibilityFor(proposal), diffPreview: preview };
    },
    decide,
    execute({ command, args, projectFingerprint } = {}) {
      const value = typeof command === "object" ? { ...command, ...(args ?? {}) } : [command, ...(Array.isArray(args) ? args : [])].filter(Boolean).join(" ");
      return handleCommand({ command: value, projectFingerprint });
    },
    getHealth,
    getAutomation: () => automationState(),
    setAutomaticRecommendations: (enabled) => commandPolicy.setAutomaticRecommendations?.(enabled)
      ?? { ok: false, reason: "automation-policy-unavailable" },
    getConsent: () => commandPolicy.getConsent?.() ?? automationState()?.global?.consent,
    setConsent: (key, value) => commandPolicy.setConsent?.(key, value) ?? { ok: false, reason: "consent-policy-unavailable" },
  });

  return Object.freeze({
    handleEvent,
    getProjectOperationalState,
    handleCommand,
    runEvolutionCycle,
    runApprovalFlow,
    runRollbackFlow,
    decide,
    processMailbox,
    issueBridgeNonces,
    refreshUiProjection,
    runRetentionSweep,
    __testBridge: testBridge,
    boot,
    recoverHostSessions,
    shutdown,
    triggerKillSwitch,
    clearKillSwitch,
    getRetentionState: () => ({ scheduled: retentionTimer !== undefined, inFlight: retentionTask !== undefined }),
    getInFlightWork: () => [...inFlight.values()].map((record) => ({ ...record.item, kind: record.kind })),
  });
}
