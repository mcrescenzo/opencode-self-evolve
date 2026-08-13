import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { BRIDGE_CONTROL_STATE_RESERVE_BYTES, BRIDGE_MAILBOX_DESCRIPTORS, validateBridgeExportMetadata } from "./self-evolve-bridge.js";
import { processIsAlive, stateMutationLockHeld, withStateMutationLock } from "./self-evolve-lock.js";
import {
  revalidateStateRootBoundary,
  validateStateRootBoundary,
  walkStateRootDirectories,
} from "./self-evolve-state-root.js";
import { createDurableFilesystem, syncDirectoryFsync } from "./self-evolve-durable.js";
import {
  AUTOMATION_EPOCH_INVALID_REASON,
  BREAKER_EPOCH_RESET_CONFIRMATION,
  BREAKER_EPOCH_TRIPPED_REASON,
  ROOT_EPOCH_TERMINAL_REASON,
  createAutomationEpochManager,
  createBreakerEpochManager,
  createRootEpochManager,
} from "./self-evolve-epoch.js";
import {
  HISTORICAL_SELF_EVOLVE_AGENTS,
  HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
} from "./self-evolve-core.js";
import { summarizeGlobalCandidateSupport } from "./self-evolve-observation.js";
import {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  UNKNOWN_ROOT_LINEAGE_HASH,
  assertRecord,
  assertContributionPublicationBinding,
  errorReasonCode,
  evaluateGlobalSupportEligibility,
  evaluateV4PermissionTransition,
  evaluateV3ConsentTransition,
  evaluateContributionConsentAuthority,
  evaluateContributionConsentVersion,
  globalApplyIntentId,
  globalDecisionId,
  globalDecisionOutcomeId,
  globalTargetLeaseKey,
  makeAggregateClaim,
  makeAuditEvent,
  makeDecision,
  makeEvidenceCapsule,
  makeContributionIntent,
  makeGlobalContribution,
  makeGlobalCandidate,
  makeGlobalApplyIntent,
  makeGlobalAuditEvent,
  makeGlobalDecision,
  makeGlobalDecisionOutcome,
  makeGlobalLease,
  makeGlobalRecommendation,
  makeGlobalRecommendationContent,
  makeGlobalRootPolicy,
  makeGlobalSettings,
  makeGlobalSynthesisAttempt,
  makeGlobalSupportSet,
  makeGlobalSkillSnapshot,
  makeV4GlobalSettings,
  makeV4RepoSettings,
  makeCandidateTargetBinding,
  migrateLegacySettingsToV4,
  migrateSettings,
  makeProposal,
  makeProposalContent,
  makeProjectContributionLink,
  makeRecommendationTargetBinding,
  makeRepoSettings,
  parseSynthesisOutcomeAuditEvent,
  stripUndefined,
  burnNonce,
  transitionProposalState,
  transitionContributionIntent,
  transitionGlobalCandidate as transitionGlobalCandidateState,
  transitionGlobalApplyIntent,
  transitionGlobalLease,
  transitionGlobalRecommendation,
  transitionGlobalSynthesisAttempt,
  v4AutomationPermissionsHash,
  V4_AUTOMATION_PERMISSION_FIELDS,
  V4_SCHEMA_VERSION,
  wrapRecord,
} from "./self-evolve-schemas.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
export const HOST_OWNER_TTL_MS = 15 * 60 * 1000;
const DAY_MS = 86_400_000;
const MANDATORY_AUDIT_MAX_BYTES = 4 * 1024;
const QUARANTINE_EVIDENCE_MAX_BYTES = 64 * 1024;
const GLOBAL_QUARANTINE_QUOTA_BYTES = 512 * 1024;
const GLOBAL_STORAGE_QUOTA_BYTES = 64 * 1024 * 1024;
const GLOBAL_STORAGE_QUOTA_FILES = 16 * 1024;
const PROJECT_STORAGE_QUOTA_FILES = 16 * 1024;
const MAX_CONTRIBUTION_RECORD_BYTES = 4 * 1024;
const MAX_CONTRIBUTION_TRANSACTION_BYTES = 16 * 1024;
const MAX_GLOBAL_CANDIDATE_RECORD_BYTES = 16 * 1024;
const MAX_GLOBAL_RECOMMENDATION_RECORD_BYTES = 16 * 1024;
const MAX_GLOBAL_RECOMMENDATION_CONTENT_BYTES = 4 * 1024;
const MAX_GLOBAL_DECISION_RECORD_BYTES = 16 * 1024;
const MAX_GLOBAL_SNAPSHOT_RECORD_BYTES = 192 * 1024;
const MAX_VERSION_MARKER_BYTES = 4 * 1024;
const DECISION_TRANSACTION_VERSION = 2;
const SETTINGS_TRANSACTION_VERSION = 2;
const AUTOMATION_TRANSACTION_VERSION = 1;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const EXPORT_NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0 ? constants.O_NOFOLLOW : null;
const ACTIVE_PROPOSAL_STATES = new Set(["critic-pending", "pending", "approved", "applied"]);
const ACTIVE_PROPOSAL_CHAIN_KINDS = new Set(["proposal", "proposal-content", "decision", "audit-event"]);
const SYNTHESIS_FINALIZATION_AUDIT_ACTIONS = new Set([
  "synthesis-outcome",
  "synthesis-lease-cleanup-warning",
  "synthesis-lease-cleanup-resolved",
]);
const CONTRIBUTION_INPUT_FIELDS = Object.freeze([
  "claimType", "receiptType", "signatureHash", "incidentId", "capsuleId", "clusterId",
  "evidenceDomainId", "occurrenceCount", "firstSeenAt", "lastSeenAt",
]);
// First-time v0.3 global-settings migration inspects every legacy partition's
// combined settings.json and migrates ONLY values every valid partition agrees
// on. Any divergence in a consent/authority-bearing field fails closed to the
// Manual+all-false-defaults and writes a durable reconciliation conflict record
// at <globalDir>/migration-conflict.json. The list below is the authority surface
// captured by GlobalSettings excluding metadata (schemaVersion/createdAt/updatedAt),
// budgets, and retentionDays, which default conservatively on conflict. The
// consent.* bits are compared individually so a single disagreeing bit triggers
// the conservative fallback for the whole settings document.
const GLOBAL_MIGRATION_CONFLICT_REASON = "legacy-global-consent-conflict";
const GLOBAL_MIGRATION_CONFLICT_PATH = "migration-conflict.json";
const GLOBAL_MIGRATION_RECONCILIATION_FIELDS = Object.freeze([
  "mode",
  "paused",
  "killSwitchActive",
  "allowedSkillRoots",
  "globalRootPolicy",
]);
const GLOBAL_MIGRATION_RECONCILIATION_CONSENT_BITS = Object.freeze([
  "passiveCalls",
  "durableObservations",
  "sanitizedExcerpts",
  "crossRepoAggregation",
]);
const KNOWN_HIDDEN_HOST_OWNER_AGENTS = new Set([
  HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  ...Object.values(HISTORICAL_SELF_EVOLVE_AGENTS),
]);
const STORE_FILES = Object.freeze({
  observation: "observations.jsonl",
  proposal: "proposals.jsonl",
  "proposal-content": "proposals.jsonl",
  "synthesis-attempt": "audit.jsonl",
  decision: "decisions.jsonl",
  "audit-event": "audit.jsonl",
});
const terminalRoots = new Set();

export function hashContent(str) {
  return createHash("sha256").update(String(str)).digest("hex");
}

export function isActiveProposalState(state) {
  return ACTIVE_PROPOSAL_STATES.has(state);
}

export function isActiveProposalChainRecord(record, activeProposalIds) {
  if (!(activeProposalIds instanceof Set) || !ACTIVE_PROPOSAL_CHAIN_KINDS.has(record?.kind)) return false;
  const proposalId = record.kind === "proposal" ? record.payload?.id : record.payload?.proposalId;
  return typeof proposalId === "string" && activeProposalIds.has(proposalId);
}

function canonicalRemote(remoteUrl) {
  let value = String(remoteUrl).trim().replace(/\\/g, "/");
  const scp = value.match(/^([^/@\s]+@)?([^/:\s]+):(.+)$/);
  if (scp && !value.includes("://")) value = `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}`;
  try {
    const url = new URL(value);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "ssh:" && url.port === "22")) url.port = "";
    url.search = "";
    url.hash = "";
    value = url.toString();
  } catch {
    // Host-specific Git syntax is normalized below.
  }
  return value.replace(/\/+$/, "").replace(/\.git$/i, "");
}

function canonicalFilesystemPath(value) {
  const resolved = path.resolve(String(value));
  let canonical;
  try { canonical = realpathSync.native(resolved); } catch { canonical = resolved; }
  canonical = canonical.replace(/\\/g, "/");
  if (/^[A-Z]:\//.test(canonical)) canonical = canonical[0].toLowerCase() + canonical.slice(1);
  return canonical.length > 1 ? canonical.replace(/\/+$/, "") : canonical;
}

export function projectFingerprintFor(remoteUrl, worktreePath) {
  const worktree = canonicalFilesystemPath(worktreePath);
  const remote = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  const sourceKind = remote ? "remote" : "root";
  const canonicalSource = remote ? canonicalRemote(remote) : worktree;
  return hashContent(JSON.stringify(["self-evolve-project-v1", sourceKind, canonicalSource, worktree]));
}

export function resolveProjectIdentity({ projectFingerprint, remoteUrl = "", worktreePath, directory } = {}) {
  const sourcePath = typeof worktreePath === "string" && worktreePath.trim()
    ? worktreePath
    : typeof directory === "string" && directory.trim()
      ? directory
      : null;
  const explicit = projectFingerprint === undefined || projectFingerprint === null || projectFingerprint === ""
    ? null
    : String(projectFingerprint);
  if (explicit !== null && !/^[a-f0-9]{64}$/.test(explicit)) throw new TypeError("invalid-project-fingerprint");
  if (!sourcePath) {
    if (!explicit) throw new TypeError("project-worktree-unavailable");
    return Object.freeze({ projectFingerprint: explicit, remoteUrl: String(remoteUrl ?? ""), worktreePath: null });
  }
  const canonicalWorktree = canonicalFilesystemPath(sourcePath);
  const derived = projectFingerprintFor(remoteUrl, canonicalWorktree);
  if (explicit && explicit !== derived) throw new TypeError("project-fingerprint-mismatch");
  return Object.freeze({
    projectFingerprint: explicit ?? derived,
    remoteUrl: String(remoteUrl ?? ""),
    worktreePath: canonicalWorktree,
  });
}

function ensureDir(directory) {
  mkdirSync(directory, { recursive: true, mode: DIR_MODE });
}

function atomicFilesystemWrite(filePath, contents, syncFile = fsyncSync) {
  ensureDir(path.dirname(filePath));
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
    writeFileSync(descriptor, contents, "utf8");
    syncFile(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
    // Authoritative namespace mutation: fsync the parent directory so the
    // renamed entry survives power loss, not only the file content.
    syncDirectoryFsync(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function json(value) {
  return `${JSON.stringify(value)}\n`;
}

export function quarantineRecord(record, reason, quarantineDir) {
  if (!quarantineDir) throw new TypeError("quarantine-directory-required");
  ensureDir(quarantineDir);
  const stamp = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  const recordPath = path.join(quarantineDir, `${stamp}.quarantined`);
  let serialized;
  try { serialized = typeof record === "string" ? record : JSON.stringify(record); } catch { serialized = String(record); }
  atomicFilesystemWrite(recordPath, `${serialized}\n`);
  atomicFilesystemWrite(`${recordPath}.reason.json`, json({ reason: String(reason) }));
  return recordPath;
}

export function migrate(settings) {
  return migrateSettings(settings);
}

function fileForKind(kind) {
  if (STORE_FILES[kind]) return STORE_FILES[kind];
  if (["apply-claim", "rollback-record", "intervention-epoch", "circuit-breaker"].includes(kind)) return STORE_FILES["audit-event"];
  return STORE_FILES.observation;
}

function logicalId(envelope) {
  return envelope.payload?.id ?? envelope.payload?.proposalId ?? envelope.payload?.sessionIDHash ?? envelope.id;
}

function eventState(event) {
  return event.payload?.details?.state ?? event.payload?.details?.status ?? event.payload?.details?.action;
}

export function openStore(rootDir, {
  projectName,
  projectFingerprint,
  now = () => Date.now(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  globalQuotaBytes = GLOBAL_STORAGE_QUOTA_BYTES,
  globalQuotaFiles = GLOBAL_STORAGE_QUOTA_FILES,
  projectQuotaFiles = PROJECT_STORAGE_QUOTA_FILES,
  faultInjection,
  processIsAlive: hostProcessIsAlive = processIsAlive,
  filesystemSync = fsyncSync,
  filesystemSyncDirectory = syncDirectoryFsync,
} = {}) {
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (!/^[a-f0-9]{64}$/.test(String(projectFingerprint))) throw new TypeError("invalid-project-fingerprint");
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError("invalid-lock-timeout");
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1) throw new TypeError("invalid-stale-lock-window");
  if (!Number.isSafeInteger(globalQuotaBytes) || globalQuotaBytes < 1) throw new TypeError("invalid-global-storage-quota");
  if (!Number.isSafeInteger(globalQuotaFiles) || globalQuotaFiles < 1) throw new TypeError("invalid-global-file-quota");
  if (!Number.isSafeInteger(projectQuotaFiles) || projectQuotaFiles < 1) throw new TypeError("invalid-project-file-quota");
  if (typeof hostProcessIsAlive !== "function") throw new TypeError("process-is-alive-must-be-function");
  if (typeof filesystemSync !== "function") throw new TypeError("filesystem-sync-must-be-function");
  if (typeof filesystemSyncDirectory !== "function") throw new TypeError("filesystem-sync-directory-must-be-function");
  const rootBoundary = validateStateRootBoundary(rootDir, {
    create: true,
    beforeCreate: (details) => injectFault("state-root-before-create", details),
  });
  injectFault("state-root-after-boundary-validation", { stateRoot: rootBoundary.path });
  const root = revalidateStateRootBoundary(rootBoundary);
  // Bound durable namespace mutation for the authoritative write path. Capability
  // is probed once against the validated state root: a host that cannot fsync a
  // directory descriptor disables authoritative writes with a stable reason while
  // read-only analysis paths (which never call these primitives) keep working.
  const durable = createDurableFilesystem({
    syncFile: filesystemSync,
    syncDirectory: filesystemSyncDirectory,
    probeDirectory: root,
    faultInjection: (point, details) => injectFault(point, details),
  });
  // Root-global epoch manager bound to the validated state root and the shared
  // durable namespace primitive. The epoch file lives at the root level (outside
  // the deletable `self-evolve/` subtree) so it survives purge-all and is
  // visible to every process sharing the state root. The store reads it at open
  // and re-reads it under every mutation-lock acquisition so a peer's terminal
  // write fails this process's next authoritative mutation closed.
  const rootEpoch = createRootEpochManager({
    stateRoot: root,
    durable,
    now,
  });
  // Root-global circuit-breaker epoch: a sibling durable authority truth that
  // composes with the terminal/reinitialize root epoch (same state-root
  // boundary, same durable namespace primitive) but tracks the cross-process
  // circuit-breaker open/closed state separately. Every admission, provider,
  // and effect boundary freshly reads this so a peer process's trip is visible
  // without restart. The terminal/reinitialize epoch owns purge terminality;
  // the breaker epoch owns breaker truth. A corrupt breaker epoch fails closed
  // (treated as tripped) so a tampered root cannot regain autonomy by erasing
  // the trip marker.
  const breakerEpoch = createBreakerEpochManager({
    stateRoot: root,
    durable,
    now,
  });
  const automationEpoch = createAutomationEpochManager({
    stateRoot: root,
    durable,
    now,
  });
  const baseDir = path.join(root, "self-evolve");
  const globalDir = path.join(baseDir, "global");
  const stateDir = path.join(baseDir, projectFingerprint);
  const leasesDir = path.join(stateDir, "leases");
  const hostOwnersDir = path.join(stateDir, "host-owners");
  const quarantineDir = path.join(stateDir, "quarantine");
  const globalQuarantineDir = path.join(globalDir, "quarantine");
  const snapshotsDir = path.join(stateDir, "snapshots");
  const repoSettingsPath = path.join(stateDir, "settings.json");
  const globalSettingsPath = path.join(globalDir, "settings.json");
  const automationGlobalSettingsPath = path.join(globalDir, "automation-settings.json");
  const automationRepoSettingsPath = path.join(stateDir, "automation-settings.json");
  const automationTransactionPath = path.join(baseDir, "automation-transition.json");
  const globalMigrationConflictPath = path.join(globalDir, GLOBAL_MIGRATION_CONFLICT_PATH);
  const aggregatesPath = path.join(globalDir, "aggregates.jsonl");
  const contributionsDir = path.join(globalDir, "contributions");
  const globalCandidatesDir = path.join(globalDir, "candidates");
  const globalSupportSetsDir = path.join(globalDir, "candidate-support");
  const globalSynthesisAttemptsDir = path.join(globalDir, "synthesis-attempts");
  const globalRecommendationsDir = path.join(globalDir, "recommendations");
  const globalRecommendationContentDir = path.join(globalDir, "recommendation-content");
  const globalDecisionsDir = path.join(globalDir, "decisions");
  const globalApplyIntentsDir = path.join(globalDir, "apply-intents");
  const globalSkillSnapshotsDir = path.join(globalDir, "skill-snapshots");
  const globalDecisionOutcomesDir = path.join(globalDir, "decision-outcomes");
  const globalAuditsDir = path.join(globalDir, "audits");
  const globalLeasesDir = path.join(globalDir, "leases");
  const bridgeGlobalDir = path.join(baseDir, "bridge", "global");
  const evidenceCapsulesPath = path.join(stateDir, "evidence-capsules.jsonl");
  const aggregateIndexPath = path.join(stateDir, "aggregate-contributions.json");
  const contributionIntentsDir = path.join(stateDir, "contribution-intents");
  const contributionLinksDir = path.join(stateDir, "contribution-links");
  const decisionTransactionPath = path.join(stateDir, "decision-transaction.json");
  const settingsTransactionPath = path.join(baseDir, "settings-transaction.json");
  const requestTransactionPath = path.join(baseDir, "request-transaction.json");
  const versionPath = path.join(baseDir, "version.json");
  const bridgeProjectDir = path.join(baseDir, "bridge", projectFingerprint);
  const exportProjectDir = path.join(baseDir, "exports", projectFingerprint);
  const ownedLeases = new Map();
  const ownedHostOwners = new Map();
  // Cache validity is the exact source bytes, never filesystem metadata. Every
  // read still reads and compares the source, so writers in other processes are
  // visible even when an inode, size, or millisecond mtime is reused.
  const parsedFileCache = new Map();
  let exportInventory = null;
  let legacyProposalContentAbsent = false;
  let lastKnownProjectQuotaBytes = null;
  let startupCorruptionScope = null;
  let partitionAdmissionError = null;
  let partitionVersion = null;
  let closed = false;
  let terminal = false;
  let terminalEpochReason = null;
  // Cached tripped reason for the breaker epoch. Refreshed under the mutation
  // lock (alongside the root epoch) and on demand via breakerEpochTripped(). A
  // null reason means healthy; a non-null reason means tripped (or corrupt,
  // which fails closed as breaker-epoch-tripped). Peers see each other's
  // trip/reset writes at the next boundary read because the source-byte cache
  // invalidates on any on-disk change.
  let breakerEpochReason = null;
  // Set when THIS process wrote the terminal epoch via markRootTerminal but has
  // not yet deleted the subtree. While pending, the local store skips the
  // durable-epoch refresh inside the mutation lock so cleanup reads/audits
  // (accepted-terminal response recording, in-flight cycle-outcome audits)
  // continue to function until store.purge({ scope:"all" }) performs the actual
  // deletion and sets the definitive local terminal flag. Peer processes do not
  // set this flag, so their very next mutation-lock acquisition refreshes the
  // durable epoch and fails closed.
  let localTerminalPending = false;

  function boundaryComponents(directory) {
    const resolved = path.resolve(directory);
    const relative = path.relative(root, resolved);
    if (relative === "") return [];
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("state-root-path-escape-rejected");
    }
    return relative.split(path.sep);
  }

  function ensureDir(directory) {
    const resolved = path.resolve(directory);
    const walked = walkStateRootDirectories(rootBoundary, boundaryComponents(resolved), {
      create: true,
      beforeCreate: (details) => injectFault("state-root-before-create", details),
    });
    if (walked !== resolved) throw new Error("state-root-ancestor-rejected");
  }

  function revalidateStoreAncestors() {
    for (const [components, expected] of [
      [["self-evolve"], baseDir],
      [["self-evolve", "global"], globalDir],
      [["self-evolve", projectFingerprint], stateDir],
    ]) {
      if (walkStateRootDirectories(rootBoundary, components) !== expected) {
        throw new Error("state-root-ancestor-rejected");
      }
    }
  }

  function preflightStoreAncestors() {
    for (const components of [
      ["self-evolve"],
      ["self-evolve", "global"],
      ["self-evolve", projectFingerprint],
    ]) {
      walkStateRootDirectories(rootBoundary, components);
    }
  }

  function atomicWrite(filePath, contents) {
    injectFault("state-root-before-atomic-write", { filePath });
    revalidateStateRootBoundary(rootBoundary);
    ensureDir(path.dirname(filePath));
    revalidateStateRootBoundary(rootBoundary);
    durable.durableReplaceFile(filePath, contents);
    revalidateStateRootBoundary(rootBoundary);
  }

  function ensureOpen({ allowIncompatible = false, allowTerminal = false } = {}) {
    if (closed) throw new Error("store-closed");
    if (!allowTerminal && (terminal || terminalRoots.has(root) || terminalEpochReason !== null)) {
      throw new Error(terminalEpochReason ?? "restart-required-after-purge-all");
    }
    if (partitionAdmissionError && !allowIncompatible) throw new Error(partitionAdmissionError);
  }

  function markStartupCorruption(scope) {
    startupCorruptionScope = startupCorruptionScope && startupCorruptionScope !== scope
      ? "all"
      : scope;
  }

  // Refresh the cached durable epoch truth from disk. Called at open and under
  // every mutation-lock acquisition so a peer process's terminal write fails
  // this process's next authoritative boundary closed even though the in-memory
  // `terminal` flag was set only by this process's own purge. A corrupt epoch
  // file fails closed (treated as terminal) so a tampered root cannot regain
  // authority by erasing the terminal marker.
  function refreshRootEpochUnlocked() {
    // Skip the durable-epoch disk read when THIS process has already written the
    // terminal epoch and is in the pre-deletion grace window. Peers never set
    // localTerminalPending and so always hit the disk read.
    if (localTerminalPending) return terminalEpochReason;
    try {
      const reason = rootEpoch.readTerminalReason();
      terminalEpochReason = reason;
    } catch (error) {
      terminalEpochReason = errorReasonCode(error, ROOT_EPOCH_TERMINAL_REASON);
    }
    if (terminalEpochReason !== null) terminal = true;
    return terminalEpochReason;
  }

  // Refresh the cached durable breaker epoch truth from disk. Called under the
  // mutation lock (alongside the root epoch) and on demand by every admission,
  // provider, and effect boundary. A corrupt breaker epoch fails closed
  // (treated as tripped) so a tampered root cannot regain autonomy.
  function refreshBreakerEpochUnlocked() {
    try {
      breakerEpochReason = breakerEpoch.readTrippedReason();
    } catch (error) {
      breakerEpochReason = errorReasonCode(error, BREAKER_EPOCH_TRIPPED_REASON);
    }
    return breakerEpochReason;
  }

  function withMutationLock(action, {
    requireStoreAncestors = true,
    allowIncompatible = false,
    recoverTransactions = true,
    skipEpochRefresh = false,
    allowTerminal = false,
  } = {}) {
    ensureOpen({ allowIncompatible, allowTerminal });
    revalidateStateRootBoundary(rootBoundary);
    return withStateMutationLock(root, () => {
      revalidateStateRootBoundary(rootBoundary);
      if (!skipEpochRefresh && !allowTerminal) refreshRootEpochUnlocked();
      // Refresh the breaker epoch under the lock so every boundary that reads
      // the cached state observes the latest peer trip/reset. The breaker does
      // NOT gate store mutations (it gates autonomy, and trip/reset audits must
      // remain writable); the actual suppression happens at admission/provider/
      // effect boundaries via breakerEpochTripped().
      if (!skipEpochRefresh) refreshBreakerEpochUnlocked();
      if (!allowTerminal && terminalEpochReason !== null) {
        throw new Error(terminalEpochReason ?? "restart-required-after-purge-all");
      }
      if (requireStoreAncestors) revalidateStoreAncestors();
      if (recoverTransactions) {
        recoverSettingsTransactionUnlocked();
        recoverAutomationTransactionUnlocked();
      }
      const result = action();
      revalidateStateRootBoundary(rootBoundary);
      return result;
    }, { lockTimeoutMs, staleLockMs });
  }

  function initializeDirs() {
    ensureDir(baseDir);
    ensureDir(globalDir);
    ensureDir(stateDir);
    ensureDir(leasesDir);
    ensureDir(hostOwnersDir);
    ensureDir(quarantineDir);
    ensureDir(globalQuarantineDir);
    ensureDir(snapshotsDir);
    if (partitionVersion === null || partitionVersion !== SCHEMA_VERSION) {
      atomicWrite(versionPath, json({ schemaVersion: SCHEMA_VERSION }));
      partitionVersion = SCHEMA_VERSION;
    }
  }

  function readStableRegularFile(filePath, maxBytes, faultPoint) {
    let descriptor;
    try {
      const before = lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
        throw new Error("unsafe-state-file");
      }
      if (faultPoint) injectFault(faultPoint, { filePath });
      descriptor = openSync(filePath, constants.O_RDONLY | (EXPORT_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes
          || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("unsafe-state-file");
      }
      const source = readFileSync(descriptor, "utf8");
      if (Buffer.byteLength(source, "utf8") > maxBytes) throw new Error("unsafe-state-file");
      const after = lstatSync(filePath);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
          || after.dev !== opened.dev || after.ino !== opened.ino) {
        throw new Error("unsafe-state-file");
      }
      return source;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  function inspectUnversionedPartition() {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      if (entry.name === "bridge" || entry.name === "exports") {
        if (walkStateRootDirectories(rootBoundary, ["self-evolve", entry.name]) !== path.join(baseDir, entry.name)) return false;
        continue;
      }
      if (!/^[a-f0-9]{64}$/u.test(entry.name)) return false;
      if (walkStateRootDirectories(rootBoundary, ["self-evolve", entry.name]) !== path.join(baseDir, entry.name)) return false;
      try {
        const source = readStableRegularFile(path.join(baseDir, entry.name, "settings.json"), QUARANTINE_EVIDENCE_MAX_BYTES);
        const raw = JSON.parse(source);
        if (!raw?.global || !raw?.repo || !SUPPORTED_SCHEMA_VERSIONS.includes(raw.schemaVersion)) return false;
        const migrated = migrate(raw);
        makeGlobalSettings(migrated?.global);
        const repo = makeRepoSettings(migrated?.repo);
        if (repo.projectFingerprint !== entry.name) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  function inspectPartitionVersion() {
    if (!existsSync(baseDir)) return Object.freeze({ ok: true, version: null });
    if (!existsSync(versionPath)) {
      return inspectUnversionedPartition()
        ? Object.freeze({ ok: true, version: null })
        : Object.freeze({ ok: false, reason: "malformed-state-version" });
    }
    let source;
    let marker;
    try {
      source = readStableRegularFile(versionPath, MAX_VERSION_MARKER_BYTES, "state-version-before-open");
      marker = JSON.parse(source);
    } catch {
      return Object.freeze({ ok: false, reason: "malformed-state-version" });
    }
    if (!marker || typeof marker !== "object" || Array.isArray(marker)
        || Object.keys(marker).length !== 1 || !Object.hasOwn(marker, "schemaVersion")
        || typeof marker.schemaVersion !== "string" || !marker.schemaVersion) {
      return Object.freeze({ ok: false, reason: "malformed-state-version" });
    }
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(marker.schemaVersion)) {
      return Object.freeze({ ok: false, reason: "unsupported-state-version" });
    }
    return Object.freeze({ ok: true, version: marker.schemaVersion });
  }

  function safeTreeFiles(directory, { optional = true } = {}) {
    if (!existsSync(directory)) {
      if (optional) return [];
      throw new Error("storage-path-missing");
    }
    const rootStat = lstatSync(directory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("storage-symlink-rejected");
    const files = [];
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const filePath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw new Error("storage-symlink-rejected");
        if (entry.isDirectory()) visit(filePath);
        else if (entry.isFile()) {
          const stat = lstatSync(filePath);
          if (stat.nlink !== 1) throw new Error("storage-hardlink-rejected");
          files.push(filePath);
        }
        else throw new Error("storage-path-rejected");
      }
    };
    visit(directory);
    return files;
  }

  function projectQuotaBytesUnlocked() {
    const global = loadGlobalSettingsUnlocked();
    if (!global) throw new Error("corrupt-settings");
    if (!existsSync(repoSettingsPath)) {
      lastKnownProjectQuotaBytes = global.budgets.storageQuotaMiB * 1024 * 1024;
      return lastKnownProjectQuotaBytes;
    }
    const repo = loadRepoSettingsUnlocked();
    if (!repo) throw new Error("corrupt-settings");
    lastKnownProjectQuotaBytes = (repo.budgets.storageQuotaMiB ?? global.budgets.storageQuotaMiB) * 1024 * 1024;
    return lastKnownProjectQuotaBytes;
  }

  function projectQuotaForStateDirUnlocked(targetStateDir) {
    if (targetStateDir === stateDir) return projectQuotaBytesUnlocked();
    const global = loadGlobalSettingsUnlocked();
    if (!global) throw new Error("corrupt-settings");
    const targetFingerprint = path.basename(targetStateDir);
    const targetSettingsPath = path.join(targetStateDir, "settings.json");
    if (!existsSync(targetSettingsPath)) return global.budgets.storageQuotaMiB * 1024 * 1024;
    try {
      const raw = JSON.parse(readFileSync(targetSettingsPath, "utf8"));
      const legacy = raw?.repo ? migrate(raw) : null;
      const candidate = legacy?.repo ?? migrate(raw);
      if (!candidate) throw new Error("unsupported-version");
      const clean = makeRepoSettings(candidate);
      if (clean.projectFingerprint !== targetFingerprint) throw new Error("project-fingerprint-mismatch");
      return (clean.budgets.storageQuotaMiB ?? global.budgets.storageQuotaMiB) * 1024 * 1024;
    } catch {
      throw new Error("corrupt-settings");
    }
  }

  function projectedProjectBytesUnlocked(changes = new Map(), {
    targetStateDir = stateDir,
    targetBridgeDir = bridgeProjectDir,
  } = {}) {
    const files = [...safeTreeFiles(targetStateDir), ...safeTreeFiles(targetBridgeDir)];
    const seen = new Set();
    let bytes = 0;
    for (const filePath of files) {
      const resolved = path.resolve(filePath);
      seen.add(resolved);
      const replacement = changes.get(resolved);
      bytes += replacement === null ? 0 : replacement === undefined ? lstatSync(filePath).size : Buffer.byteLength(replacement, "utf8");
    }
    for (const [filePath, contents] of changes) {
      if (contents !== null && !seen.has(filePath)) bytes += Buffer.byteLength(contents, "utf8");
    }
    const requestDescriptors = new Map(BRIDGE_MAILBOX_DESCRIPTORS
      .filter((descriptor) => descriptor.role === "request")
      .map((descriptor) => [descriptor.directoryName, descriptor]));
    let pendingBridgeRequests = 0;
    for (const filePath of files) {
      const parent = path.basename(path.dirname(filePath));
      const descriptor = requestDescriptors.get(parent);
      if (descriptor && filePath.endsWith(".json")) {
        pendingBridgeRequests += 1;
        bytes += descriptor.responseMaxBytes;
      }
    }
    if (pendingBridgeRequests > 0 && !files.includes(path.join(targetBridgeDir, "control-state.json"))) bytes += BRIDGE_CONTROL_STATE_RESERVE_BYTES;
    return bytes;
  }

  function projectedTreeUsageUnlocked(directory, changes = new Map()) {
    const boundary = path.resolve(directory);
    const withinBoundary = (filePath) => {
      const resolved = path.resolve(filePath);
      return resolved === boundary || resolved.startsWith(`${boundary}${path.sep}`);
    };
    const files = safeTreeFiles(directory);
    const seen = new Set();
    let bytes = 0;
    let fileCount = 0;
    for (const filePath of files) {
      const resolved = path.resolve(filePath);
      seen.add(resolved);
      const replacement = changes.get(resolved);
      if (replacement === null) continue;
      bytes += replacement === undefined ? lstatSync(filePath).size : Buffer.byteLength(replacement);
      fileCount += 1;
    }
    for (const [filePath, contents] of changes) {
      if (contents === null || seen.has(path.resolve(filePath)) || !withinBoundary(filePath)) continue;
      bytes += Buffer.byteLength(contents);
      fileCount += 1;
    }
    return { bytes, fileCount };
  }

  function assertProjectQuotaUnlocked(changes, {
    mandatoryAuditBytes = 0,
    quotaBytes = projectQuotaBytesUnlocked(),
    targetStateDir = stateDir,
    targetBridgeDir = bridgeProjectDir,
  } = {}) {
    const projectedBytes = projectedProjectBytesUnlocked(changes, { targetStateDir, targetBridgeDir });
    const projectedFiles = projectedTreeUsageUnlocked(targetStateDir, changes).fileCount
      + projectedTreeUsageUnlocked(targetBridgeDir, changes).fileCount;
    if (projectedBytes <= quotaBytes && projectedFiles <= projectQuotaFiles) {
      return { projectedBytes, projectedFiles, quotaBytes, quotaFiles: projectQuotaFiles };
    }
    if (mandatoryAuditBytes > 0 && mandatoryAuditBytes <= MANDATORY_AUDIT_MAX_BYTES) return { projectedBytes, quotaBytes, mandatoryAuditBypass: true };
    throw new Error(projectedFiles > projectQuotaFiles ? "storage-file-quota-exceeded" : "storage-quota-exceeded");
  }

  function assertGlobalQuotaUnlocked(changes = new Map()) {
    const projectedState = projectedTreeUsageUnlocked(globalDir, changes);
    const projectedBridge = projectedTreeUsageUnlocked(bridgeGlobalDir, changes);
    const reserved = globalDecisionReservationUnlocked(changes);
    const projectedBytes = projectedState.bytes + projectedBridge.bytes + reserved.bytes;
    const projectedFiles = projectedState.fileCount + projectedBridge.fileCount + reserved.files;
    if (projectedBytes > globalQuotaBytes) throw new Error("global-storage-quota-exceeded");
    if (projectedFiles > globalQuotaFiles) throw new Error("global-file-quota-exceeded");
    return { projectedBytes, projectedFiles, quotaBytes: globalQuotaBytes, quotaFiles: globalQuotaFiles };
  }

  function effectiveChangedFileSize(filePath, changes) {
    const resolved = path.resolve(filePath);
    if (changes.has(resolved)) {
      const source = changes.get(resolved);
      return source === null ? null : Buffer.byteLength(source);
    }
    return existsSync(resolved) ? lstatSync(resolved).size : null;
  }

  function changedRecordsInDirectory(changes, directory, validator) {
    const boundary = `${path.resolve(directory)}${path.sep}`;
    const records = [];
    for (const [filePath, source] of changes) {
      if (source === null || !path.resolve(filePath).startsWith(boundary)) continue;
      records.push({ filePath: path.resolve(filePath), record: validator(JSON.parse(Buffer.from(source).toString("utf8"))) });
    }
    return records;
  }

  function effectiveGlobalRecords(current, changed) {
    const records = new Map(current.map(({ filePath, record }) => [path.resolve(filePath), { filePath: path.resolve(filePath), record }]));
    for (const item of changed) records.set(item.filePath, item);
    return [...records.values()];
  }

  function globalDecisionReservationUnlocked(changes) {
    const identityOptions = { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() };
    const intents = effectiveGlobalRecords(
      readGlobalApplyIntentsUnlocked().map(({ filePath, intent }) => ({ filePath, record: intent })),
      changedRecordsInDirectory(changes, globalApplyIntentsDir, (value) => makeGlobalApplyIntent(value, identityOptions)),
    ).map(({ filePath, record: intent }) => ({ filePath, intent }));
    const persistedDecisions = readGlobalDecisionsUnlocked();
    const decisions = effectiveGlobalRecords(
      persistedDecisions.map(({ filePath, decision }) => ({ filePath, record: decision })),
      changedRecordsInDirectory(changes, globalDecisionsDir, (value) => makeGlobalDecision(value, identityOptions)),
    );
    const snapshots = effectiveGlobalRecords(
      readGlobalSkillSnapshotsUnlocked().map(({ filePath, snapshot }) => ({ filePath, record: snapshot })),
      changedRecordsInDirectory(changes, globalSkillSnapshotsDir, (value) => makeGlobalSkillSnapshot(value, identityOptions)),
    );
    const persistedAudits = readGlobalAuditsUnlocked();
    const audits = effectiveGlobalRecords(
      persistedAudits.map(({ filePath, audit }) => ({ filePath, record: audit })),
      changedRecordsInDirectory(changes, globalAuditsDir, (value) => makeGlobalAuditEvent(value, identityOptions)),
    );
    const recommendations = readGlobalRecommendationsUnlocked();
    let bytes = 0;
    let files = 0;
    const pathReservations = new Map();
    const reserve = (filePath, maximumBytes) => {
      const size = filePath === null ? null : effectiveChangedFileSize(filePath, changes);
      const amount = Math.max(0, maximumBytes - (size ?? 0));
      if (filePath === null) {
        bytes += amount;
        files += 1;
        return;
      }
      const resolved = path.resolve(filePath);
      const prior = pathReservations.get(resolved);
      if (!prior) {
        pathReservations.set(resolved, { amount });
        bytes += amount;
        if (size === null) files += 1;
        return;
      }
      if (amount > prior.amount) {
        bytes += amount - prior.amount;
        prior.amount = amount;
      }
    };
    for (const { filePath: intentPath, intent } of intents) {
      if (["completed", "failed-closed"].includes(intent.state)) continue;
      const recommendationPath = globalHashRecordPath(globalRecommendationsDir, intent.recommendationId);
      const operatorDecisionPath = globalHashRecordPath(globalDecisionsDir, globalDecisionId(intent.decision));
      const terminalDecision = decisions.find(({ record }) => record.recommendationId === intent.recommendationId
        && record.decisionVersion === intent.decision.decisionVersion + 1
        && ["applier", "policy"].includes(record.actorRole));
      const snapshot = snapshots.find(({ record }) => record.intentId === intent.intentId);
      const audit = audits.find(({ record }) => record.recommendationId === intent.recommendationId
        && record.decisionVersion === intent.decision.decisionVersion + 1
        && ["succeeded", "failed-closed"].includes(record.outcome));
      reserve(intentPath, MAX_GLOBAL_DECISION_RECORD_BYTES);
      reserve(recommendationPath, MAX_GLOBAL_RECOMMENDATION_RECORD_BYTES);
      reserve(operatorDecisionPath, MAX_GLOBAL_DECISION_RECORD_BYTES);
      if (intent.action === "apply" && intent.targetKind === "existing-global-skill") {
        reserve(snapshot?.filePath ?? null, MAX_GLOBAL_SNAPSHOT_RECORD_BYTES);
      }
      reserve(terminalDecision?.filePath ?? null, MAX_GLOBAL_DECISION_RECORD_BYTES);
      reserve(audit?.filePath ?? null, MAX_GLOBAL_DECISION_RECORD_BYTES);
      reserve(globalHashRecordPath(globalDecisionOutcomesDir, globalDecisionOutcomeId(intent.intentId)), MAX_GLOBAL_DECISION_RECORD_BYTES);
    }
    for (const { record: decision } of decisions) {
      if (decision.actorRole !== "operator" || decision.priorState !== "pending" || decision.newState !== "rejected") continue;
      const recommendation = recommendations.find(({ recommendation: value }) => value.recommendationId === decision.recommendationId)?.recommendation;
      const recommendationComplete = recommendation?.state === "rejected"
        && recommendation.decisionVersion === decision.decisionVersion
        && recommendation.burnedNonceHashes.includes(hashContent(decision.nonce));
      const audit = makeGlobalAuditEvent({
        kind: "reject",
        recommendationId: decision.recommendationId,
        actorRole: "operator",
        timestamp: decision.timestamp,
        supportSetHash: decision.supportSetHash,
        targetBindingHash: decision.targetBindingHash,
        proposedContentHash: decision.proposedContentHash,
        decisionVersion: decision.decisionVersion,
        outcome: "rejected",
      }, identityOptions);
      const auditComplete = persistedAudits.some(({ audit: value }) => sameCanonicalRecord(value, audit));
      if (!recommendationComplete) {
        reserve(globalHashRecordPath(globalRecommendationsDir, decision.recommendationId), MAX_GLOBAL_RECOMMENDATION_RECORD_BYTES);
      }
      if (!auditComplete) reserve(globalHashRecordPath(globalAuditsDir, audit.auditId), MAX_GLOBAL_DECISION_RECORD_BYTES);
    }
    return { bytes, files };
  }

  function assertGlobalQuarantineQuotaUnlocked(changes) {
    const files = safeTreeFiles(globalQuarantineDir);
    const seen = new Set();
    let projectedBytes = 0;
    for (const filePath of files) {
      const resolved = path.resolve(filePath);
      seen.add(resolved);
      const replacement = changes.get(resolved);
      projectedBytes += replacement === null
        ? 0
        : replacement === undefined
          ? lstatSync(filePath).size
          : Buffer.byteLength(replacement);
    }
    for (const [filePath, contents] of changes) {
      if (contents !== null && !seen.has(filePath)) projectedBytes += Buffer.byteLength(contents);
    }
    if (projectedBytes > GLOBAL_QUARANTINE_QUOTA_BYTES) throw new Error("storage-quota-exceeded");
    return { projectedBytes, quotaBytes: GLOBAL_QUARANTINE_QUOTA_BYTES };
  }

  function serializeQuarantineRecord(record) {
    try { return typeof record === "string" ? record : JSON.stringify(record); } catch { return String(record); }
  }

  function boundedQuarantineEvidence(serialized) {
    const source = Buffer.from(serialized, "utf8");
    return Buffer.concat([
      source.subarray(0, Math.max(0, QUARANTINE_EVIDENCE_MAX_BYTES - 1)),
      Buffer.from("\n"),
    ]);
  }

  function quarantineGlobal(record, reason, label = "global-record") {
    const serialized = serializeQuarantineRecord(record);
    const identity = hashContent(JSON.stringify([label, String(reason), hashContent(serialized)]));
    const recordPath = path.join(globalQuarantineDir, `${label}-${identity}.quarantined`);
    const reasonPath = `${recordPath}.reason.json`;
    ensureDir(globalQuarantineDir);
    const changes = new Map();
    if (!existsSync(recordPath)) changes.set(path.resolve(recordPath), boundedQuarantineEvidence(serialized));
    if (!existsSync(reasonPath)) changes.set(path.resolve(reasonPath), json({ reason: String(reason) }));
    if (changes.size === 0) return recordPath;
    assertGlobalQuarantineQuotaUnlocked(changes);
    if (changes.has(path.resolve(recordPath))) atomicWrite(recordPath, changes.get(path.resolve(recordPath)));
    if (changes.has(path.resolve(reasonPath))) atomicWrite(reasonPath, changes.get(path.resolve(reasonPath)));
    return recordPath;
  }

  function atomicProjectWrite(filePath, contents, { allowNonGrowing = true, ...options } = {}) {
    const resolved = path.resolve(filePath);
    if (resolved !== stateDir && !resolved.startsWith(`${stateDir}${path.sep}`)) throw new Error("project-storage-path-rejected");
    try {
      assertProjectQuotaUnlocked(new Map([[resolved, contents]]), options);
    } catch (error) {
      const currentBytes = existsSync(resolved) ? lstatSync(resolved).size : 0;
      if (!allowNonGrowing || Buffer.byteLength(contents, "utf8") > currentBytes) throw error;
    }
    atomicWrite(resolved, contents);
  }

  function quarantine(record, reason, directory = quarantineDir) {
    if (directory === globalQuarantineDir) return quarantineGlobal(record, reason);
    if (directory !== quarantineDir) return quarantineRecord(record, reason, directory);
    ensureDir(directory);
    const stamp = `${Date.now()}-${randomBytes(8).toString("hex")}`;
    const recordPath = path.join(directory, `${stamp}.quarantined`);
    const serialized = serializeQuarantineRecord(record);
    const evidence = boundedQuarantineEvidence(serialized);
    const changes = new Map([
      [path.resolve(recordPath), evidence],
      [path.resolve(`${recordPath}.reason.json`), json({ reason: String(reason) })],
    ]);
    assertProjectQuotaUnlocked(changes);
    atomicWrite(recordPath, changes.get(path.resolve(recordPath)));
    atomicWrite(`${recordPath}.reason.json`, changes.get(path.resolve(`${recordPath}.reason.json`)));
    return recordPath;
  }

  function quarantineProjectDeterministic(record, reason, label, targetStateDir = stateDir) {
    const serialized = serializeQuarantineRecord(record);
    const evidence = boundedQuarantineEvidence(serialized);
    const identity = hashContent(JSON.stringify([String(label), String(reason), hashContent(serialized)]));
    const targetQuarantineDir = path.join(targetStateDir, "quarantine");
    const targetBridgeDir = path.join(baseDir, "bridge", path.basename(targetStateDir));
    const recordPath = path.join(targetQuarantineDir, `${label}-${identity}.quarantined`);
    const reasonPath = `${recordPath}.reason.json`;
    ensureDir(targetQuarantineDir);
    if (existsSync(recordPath) && existsSync(reasonPath)) return recordPath;
    const changes = new Map([
      [path.resolve(recordPath), evidence],
      [path.resolve(reasonPath), json({ reason: String(reason) })],
    ]);
    assertProjectQuotaUnlocked(changes, {
      quotaBytes: projectQuotaForStateDirUnlocked(targetStateDir),
      targetStateDir,
      targetBridgeDir,
    });
    if (!existsSync(recordPath)) atomicWrite(recordPath, changes.get(path.resolve(recordPath)));
    if (!existsSync(reasonPath)) atomicWrite(reasonPath, changes.get(path.resolve(reasonPath)));
    return recordPath;
  }

  function quarantineDeterministic(record, reason, label) {
    return quarantineProjectDeterministic(record, reason, label, stateDir);
  }

  function quarantineSettings(source, reason, scope) {
    const serialized = typeof source === "string" ? source : String(source);
    const evidence = boundedQuarantineEvidence(serialized);
    const identity = hashContent(JSON.stringify([scope, String(reason), hashContent(serialized)]));
    const directory = scope === "global-settings" ? globalQuarantineDir : quarantineDir;
    const recordPath = path.join(directory, `${scope}-${identity}.quarantined`);
    const reasonPath = `${recordPath}.reason.json`;
    ensureDir(directory);
    const changes = new Map();
    if (!existsSync(recordPath)) changes.set(path.resolve(recordPath), evidence);
    if (!existsSync(reasonPath)) changes.set(path.resolve(reasonPath), json({ reason: String(reason) }));
    if (changes.size === 0) return recordPath;
    if (scope === "global-settings") {
      assertGlobalQuarantineQuotaUnlocked(changes);
    } else {
      if (!Number.isSafeInteger(lastKnownProjectQuotaBytes)) throw new Error("project-quota-unavailable");
      assertProjectQuotaUnlocked(changes, { quotaBytes: lastKnownProjectQuotaBytes });
    }
    if (changes.has(path.resolve(recordPath))) atomicWrite(recordPath, changes.get(path.resolve(recordPath)));
    if (changes.has(path.resolve(reasonPath))) atomicWrite(reasonPath, changes.get(path.resolve(reasonPath)));
    return recordPath;
  }

  function parseJsonlSource(source, validator) {
    const records = [];
    const damaged = [];
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try { records.push(validator(JSON.parse(line))); } catch (error) { damaged.push({ line, reason: errorReasonCode(error, "corrupt-record") }); }
    }
    return { records, damaged };
  }

  function parseJsonl(filePath, validator) {
    if (!existsSync(filePath)) return { records: [], damaged: [] };
    return parseJsonlSource(readFileSync(filePath, "utf8"), validator);
  }

  function cacheParsedRecords(filePath, source, records) {
    const cached = Object.freeze([...records]);
    parsedFileCache.delete(filePath);
    parsedFileCache.set(filePath, Object.freeze({ source, records: cached }));
    while (parsedFileCache.size > 4) parsedFileCache.delete(parsedFileCache.keys().next().value);
    return cached;
  }

  function readValidatedSource(filePath) {
    if (!existsSync(filePath)) {
      parsedFileCache.delete(filePath);
      return { source: null, records: [], damaged: [] };
    }
    const source = readFileSync(filePath, "utf8");
    const cached = parsedFileCache.get(filePath);
    if (cached?.source === source) return { source, records: cached.records, damaged: [] };
    const parsed = parseJsonlSource(source, assertRecord);
    if (parsed.damaged.length === 0) parsed.records = cacheParsedRecords(filePath, source, parsed.records);
    else parsedFileCache.delete(filePath);
    return { source, ...parsed };
  }

  function writeJsonl(filePath, records) {
    atomicWrite(filePath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
  }

  function readFileRecords(fileName, repair = true) {
    const filePath = path.join(stateDir, fileName);
    const parsed = readValidatedSource(filePath);
    if (!parsed.damaged.length || !repair) return parsed.records;
    if (!stateMutationLockHeld(root)) return withMutationLock(() => readFileRecords(fileName, true));
    const current = readValidatedSource(filePath);
    for (const item of current.damaged) quarantine(item.line, item.reason);
    writeJsonl(filePath, current.records);
    parsedFileCache.delete(filePath);
    return current.records;
  }

  function readFileRecordsWithSource(fileName) {
    const filePath = path.join(stateDir, fileName);
    const parsed = readValidatedSource(filePath);
    if (parsed.damaged.length) return { records: readFileRecords(fileName), source: null };
    return { records: parsed.records, source: parsed.source ?? "" };
  }

  function writeRecords(fileName, records) {
    const source = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
    const filePath = path.join(stateDir, fileName);
    atomicProjectWrite(filePath, source);
    cacheParsedRecords(filePath, source, records);
  }

  function compactProposalContentUnlocked(proposalIds) {
    if (!(proposalIds instanceof Set) || proposalIds.size === 0) return 0;
    const records = readFileRecords(STORE_FILES.proposal);
    const kept = records.filter((record) => record.kind !== "proposal-content" || !proposalIds.has(record.payload.proposalId));
    if (kept.length !== records.length) writeRecords(STORE_FILES.proposal, kept);
    return records.length - kept.length;
  }

  function migrateLegacyProposalContentUnlocked() {
    if (legacyProposalContentAbsent) return 0;
    const audit = readFileRecords(STORE_FILES["audit-event"]);
    const legacy = audit.filter((record) => record.kind === "audit-event" && record.payload?.details?.action === "proposal-content");
    if (!legacy.length) {
      legacyProposalContentAbsent = true;
      return 0;
    }
    const proposalRecords = readFileRecords(STORE_FILES.proposal);
    const latest = new Map();
    for (const record of proposalRecords) if (record.kind === "proposal") latest.set(record.payload.id, record.payload);
    const groups = new Map();
    for (const record of legacy) {
      const details = record.payload.details;
      const id = typeof details.subjectId === "string" ? details.subjectId : `orphan:${record.id}`;
      const group = groups.get(id) ?? [];
      group.push({ record, details });
      groups.set(id, group);
    }
    const additions = [];
    const outcomes = [];
    const existingIds = new Set(proposalRecords.map((record) => record.id));
    const existingMigrationAuditIds = new Set(audit
      .filter((record) => record.kind === "audit-event" && record.payload?.details?.action === "legacy-proposal-content-migration")
      .map((record) => record.payload.id));
    const expectedKeys = ["action", "chunkCount", "chunkIndex", "content", "contentEncoding", "contentHash", "subjectId"].sort().join(",");

    function validateActiveGroup(proposalId, proposal, entries) {
      if (entries.some(({ record, details }) => record.payload.proposalId !== undefined
        || Object.keys(details).sort().join(",") !== expectedKeys
        || details.subjectId !== proposalId
        || details.contentHash !== proposal.proposedContentHash
        || details.contentEncoding !== "base64"
        || !Number.isSafeInteger(details.chunkIndex)
        || !Number.isSafeInteger(details.chunkCount)
        || details.chunkIndex < 0
        || details.chunkCount < 1
        || typeof details.content !== "string")) return { ok: false, reason: "invalid-legacy-chunk-shape" };
      const sorted = [...entries].sort((left, right) => left.details.chunkIndex - right.details.chunkIndex);
      if (sorted.some(({ details }, index) => details.chunkIndex !== index || details.chunkCount !== sorted.length)) {
        return { ok: false, reason: "incomplete-or-duplicate-legacy-chunks" };
      }
      const encoded = sorted.map(({ details }) => details.content).join("");
      let decoded;
      try { decoded = Buffer.from(encoded, "base64"); } catch { return { ok: false, reason: "invalid-legacy-base64" }; }
      if (decoded.toString("base64") !== encoded || hashContent(decoded.toString("utf8")) !== proposal.proposedContentHash) {
        return { ok: false, reason: "legacy-content-hash-mismatch" };
      }
      return { ok: true, sorted };
    }

    function migrationAudit(proposalId, outcome, reason, entries) {
      const timestamp = Math.max(0, Math.min(...entries.map(({ record }) => record.createdAt)));
      const details = {
        action: "legacy-proposal-content-migration",
        outcome,
        reason,
        subjectId: proposalId,
        chunks: entries.length,
      };
      const id = hashContent(JSON.stringify(["legacy-proposal-content-migration-v1", proposalId, outcome, reason]));
      if (existingMigrationAuditIds.has(id)) return null;
      const event = makeAuditEvent({
        id,
        kind: "corruption",
        ...(proposalId.startsWith("orphan:") ? {} : { proposalId }),
        actor: "self-evolve-store",
        timestamp,
        payloadHash: hashContent(JSON.stringify(details)),
        details,
      });
      existingMigrationAuditIds.add(id);
      return wrapRecord("audit-event", event, timestamp);
    }

    for (const [proposalId, entries] of groups) {
      const proposal = latest.get(proposalId);
      let outcome;
      let reason;
      if (!proposal) {
        outcome = "orphan";
        reason = "proposal-not-found";
      } else if (!isActiveProposalState(proposal.state)) {
        const validation = validateActiveGroup(proposalId, proposal, entries);
        const quarantinePrefix = `legacy-proposal-${hashContent(proposalId).slice(0, 24)}-`;
        const priorInvalidMigration = proposal.state === "failed-closed"
          && readdirSync(quarantineDir).some((name) => name.startsWith(quarantinePrefix) && name.endsWith(".quarantined"));
        outcome = priorInvalidMigration ? "invalid-active" : "terminal";
        reason = priorInvalidMigration && !validation.ok ? validation.reason : `proposal-${proposal.state}`;
      } else {
        const validation = validateActiveGroup(proposalId, proposal, entries);
        if (validation.ok) {
          outcome = "converted";
          reason = "valid-active-content";
          for (const { record, details } of validation.sorted) {
            const converted = wrapRecord("proposal-content", makeProposalContent({
              proposalId,
              contentHash: details.contentHash,
              contentEncoding: details.contentEncoding,
              chunkIndex: details.chunkIndex,
              chunkCount: details.chunkCount,
              content: details.content,
            }), record.createdAt);
            if (!existingIds.has(converted.id)) {
              additions.push(converted);
              existingIds.add(converted.id);
            }
          }
        } else {
          outcome = "invalid-active";
          reason = validation.reason;
          quarantineDeterministic(entries.map(({ record }) => record), reason, `legacy-proposal-${hashContent(proposalId).slice(0, 24)}`);
          const failed = wrapRecord("proposal", makeProposal({
            ...proposal,
            state: "failed-closed",
            decisionVersion: proposal.decisionVersion + 1,
          }), now());
          if (!existingIds.has(failed.id)) {
            additions.push(failed);
            existingIds.add(failed.id);
          }
        }
      }
      const event = migrationAudit(proposalId, outcome, reason, entries);
      if (event) outcomes.push(event);
    }
    if (additions.length) writeRecords(STORE_FILES.proposal, [...proposalRecords, ...additions]);
    injectFault("legacy-migration-after-proposal-write");
    writeRecords(STORE_FILES["audit-event"], [...audit.filter((record) => !legacy.includes(record)), ...outcomes]);
    injectFault("legacy-migration-after-audit-write");
    legacyProposalContentAbsent = true;
    return legacy.length;
  }

  function recoverTerminalProposalContentUnlocked() {
    migrateLegacyProposalContentUnlocked();
    const records = readFileRecords(STORE_FILES.proposal);
    const latest = new Map();
    for (const record of records) if (record.kind === "proposal") latest.set(record.payload.id, record.payload);
    const terminalIds = new Set([...latest]
      .filter(([, proposal]) => ["rejected", "rolled-back", "superseded", "failed-closed"].includes(proposal.state))
      .map(([id]) => id));
    return compactProposalContentUnlocked(terminalIds);
  }

  function injectFault(point, details) {
    if (typeof faultInjection === "function") faultInjection(point, details);
  }

  function sameStateTransition(current, decision) {
    const clean = makeDecision(decision);
    if (clean.priorState !== "pending" || clean.newState !== "pending" || current.state !== "pending") throw new Error("invalid-transition");
    if (clean.proposalId !== current.id || clean.targetHash !== current.skillTarget.currentHash || clean.proposedContentHash !== current.proposedContentHash) throw new Error("cross-scope");
    if (clean.decisionVersion !== current.decisionVersion + 1) throw new Error("stale-decision-version");
    const nonceHash = burnNonce(clean);
    if (current.burnedNonceHashes.includes(nonceHash)) throw new Error("replayed-decision");
    return makeProposal({ ...current, decisionVersion: clean.decisionVersion, burnedNonceHashes: [...current.burnedNonceHashes, nonceHash] });
  }

  function buildDecisionTransactionUnlocked(decision) {
    const cleanDecision = makeDecision(decision);
    const priorRecord = getRecordUnlocked("proposal", cleanDecision.proposalId);
    if (!priorRecord) throw new Error("record-not-found");
    if (priorRecord.payload.state !== cleanDecision.priorState) throw new Error("stale-prior-state");
    const transitioned = cleanDecision.priorState === cleanDecision.newState
      ? { ok: true, state: sameStateTransition(priorRecord.payload, cleanDecision) }
      : transitionProposalState(priorRecord.payload, cleanDecision, Math.max(now(), cleanDecision.timestamp));
    if (!transitioned.ok) throw new Error(transitioned.error);
    const createdAt = now();
    const proposalRecord = wrapRecord("proposal", transitioned.state, createdAt);
    const decisionRecord = wrapRecord("decision", cleanDecision, cleanDecision.timestamp);
    const body = {
      protocolVersion: DECISION_TRANSACTION_VERSION,
      schemaVersion: SCHEMA_VERSION,
      projectFingerprint,
      createdAt,
      priorProposalRecordId: priorRecord.id,
      proposalId: cleanDecision.proposalId,
      proposalRecord,
      decisionRecord,
      compactProposalContent: ["rejected", "rolled-back", "superseded", "failed-closed"].includes(proposalRecord.payload.state),
    };
    return { ...body, intentHash: hashContent(JSON.stringify(body)) };
  }

  function validateDecisionTransaction(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed-decision-transaction");
    const expectedKeys = ["compactProposalContent", "createdAt", "decisionRecord", "intentHash", "priorProposalRecordId", "projectFingerprint", "proposalId", "proposalRecord", "protocolVersion", "schemaVersion"];
    if (Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",")) throw new Error("malformed-decision-transaction");
    if (value.protocolVersion !== DECISION_TRANSACTION_VERSION || value.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported-decision-transaction");
    if (value.projectFingerprint !== projectFingerprint || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error("malformed-decision-transaction");
    if (!/^[a-f0-9]{64}$/.test(value.priorProposalRecordId) || typeof value.proposalId !== "string") throw new Error("malformed-decision-transaction");
    const proposalRecord = assertRecord(value.proposalRecord);
    const decisionRecord = assertRecord(value.decisionRecord);
    if (proposalRecord.kind !== "proposal" || decisionRecord.kind !== "decision") throw new Error("malformed-decision-transaction");
    if (proposalRecord.payload.id !== value.proposalId || decisionRecord.payload.proposalId !== value.proposalId) throw new Error("cross-scope");
    if (typeof value.compactProposalContent !== "boolean") throw new Error("malformed-decision-transaction");
    if (value.compactProposalContent !== ["rejected", "rolled-back", "superseded", "failed-closed"].includes(proposalRecord.payload.state)) throw new Error("malformed-decision-transaction");
    if (proposalRecord.payload.decisionVersion !== decisionRecord.payload.decisionVersion || proposalRecord.payload.state !== decisionRecord.payload.newState) throw new Error("malformed-decision-transaction");
    const { intentHash, ...body } = value;
    if (intentHash !== hashContent(JSON.stringify(body))) throw new Error("corrupt-decision-transaction");
    return { ...body, intentHash, proposalRecord, decisionRecord };
  }

  function recoverDecisionTransactionUnlocked() {
    if (!existsSync(decisionTransactionPath)) return null;
    let raw;
    let intent;
    try {
      raw = readFileSync(decisionTransactionPath, "utf8");
      intent = validateDecisionTransaction(JSON.parse(raw));
    } catch (error) {
      try { quarantine(raw ?? "unreadable decision transaction", errorReasonCode(error, "corrupt-record")); } finally { rmSync(decisionTransactionPath, { force: true }); }
      throw new Error(errorReasonCode(error, "corrupt-record"));
    }
    const proposals = readFileRecords(STORE_FILES.proposal).filter((record) => record.kind === "proposal" && record.payload.id === intent.proposalId);
    const current = proposals.at(-1);
    if (!current || (current.id !== intent.priorProposalRecordId && current.id !== intent.proposalRecord.id)) {
      quarantine(intent, "decision-transaction-state-conflict");
      rmSync(decisionTransactionPath, { force: true });
      throw new Error("decision-transaction-state-conflict");
    }
    const decisions = readFileRecords(STORE_FILES.decision).filter((record) => record.kind === "decision" && record.payload.proposalId === intent.proposalId && record.payload.decisionVersion === intent.decisionRecord.payload.decisionVersion);
    if (decisions.some((record) => record.id !== intent.decisionRecord.id)) {
      quarantine(intent, "decision-transaction-decision-conflict");
      rmSync(decisionTransactionPath, { force: true });
      throw new Error("decision-transaction-decision-conflict");
    }
    if (current.id === intent.priorProposalRecordId) {
      const saved = appendValidUnlocked(intent.proposalRecord);
      if (!saved.ok) throw new Error(saved.reason);
      injectFault("decision-after-proposal-write");
    }
    if (!decisions.some((record) => record.id === intent.decisionRecord.id)) {
      const saved = appendValidUnlocked(intent.decisionRecord);
      if (!saved.ok) throw new Error(saved.reason);
      injectFault("decision-after-decision-write");
    }
    if (intent.compactProposalContent) {
      injectFault("decision-before-content-compaction");
      compactProposalContentUnlocked(new Set([intent.proposalId]));
      injectFault("decision-after-content-compaction");
    }
    rmSync(decisionTransactionPath, { force: true });
    return { ok: true, recovered: true, proposal: intent.proposalRecord.payload, decision: intent.decisionRecord.payload };
  }

  function commitDecision(decision) {
    try {
      return withMutationLock(() => {
        recoverDecisionTransactionUnlocked();
        const intent = buildDecisionTransactionUnlocked(decision);
        const proposalPath = path.join(stateDir, STORE_FILES.proposal);
        const decisionPath = path.join(stateDir, STORE_FILES.decision);
        const proposalRecords = readFileRecords(STORE_FILES.proposal);
        const decisionRecords = readFileRecords(STORE_FILES.decision);
        const intentSource = json(intent);
        const proposalSource = [...proposalRecords, intent.proposalRecord].map((record) => JSON.stringify(record)).join("\n") + "\n";
        const decisionSource = [...decisionRecords, intent.decisionRecord].map((record) => JSON.stringify(record)).join("\n") + "\n";
        assertProjectQuotaUnlocked(new Map([
          [path.resolve(decisionTransactionPath), intentSource],
          [path.resolve(proposalPath), proposalSource],
          [path.resolve(decisionPath), decisionSource],
        ]));
        atomicProjectWrite(decisionTransactionPath, intentSource);
        injectFault("decision-after-intent-write");
        const recovered = recoverDecisionTransactionUnlocked();
        return { ...recovered, recovered: false };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "corrupt-record") };
    }
  }

  function readAggregatesUnlocked() {
    const parsed = parseJsonl(aggregatesPath, makeAggregateClaim);
    if (parsed.damaged.length) {
      for (const item of parsed.damaged) quarantine(item.line, item.reason, globalQuarantineDir);
      writeJsonl(aggregatesPath, parsed.records);
    }
    return parsed.records;
  }

  function readLegacyCombined(filePath = repoSettingsPath) {
    if (!existsSync(filePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      return raw?.global && raw?.repo ? migrate(raw) : null;
    } catch { return null; }
  }

  function collectLegacyGlobalPartitionsUnlocked() {
    if (!existsSync(baseDir)) return [];
    const partitions = [];
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const candidatePath = path.join(baseDir, entry.name, "settings.json");
      const legacy = readLegacyCombined(candidatePath);
      if (!legacy?.global) continue;
      try {
        partitions.push({ fingerprint: entry.name, settings: makeGlobalSettings(legacy.global) });
      } catch {}
    }
    // Sort by fingerprint so the audit trail and any derived ordering are
    // reproducible across processes and independent of readdir() order. The
    // reconciliation result itself never depends on this order.
    partitions.sort((left, right) => (left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0));
    return partitions;
  }

  function globalSettingsFieldSignature(settings) {
    return {
      mode: settings.mode,
      paused: settings.paused,
      killSwitchActive: settings.killSwitchActive,
      allowedSkillRoots: [...settings.allowedSkillRoots].sort(),
      globalRootPolicy: settings.globalRootPolicy === null ? null : settings.globalRootPolicy.rootSetHash,
      consent: { ...settings.consent },
    };
  }

  function describeLegacyGlobalDivergences(partitions) {
    const reference = partitions[0].settings;
    const divergent = [];
    for (const field of GLOBAL_MIGRATION_RECONCILIATION_FIELDS) {
      const referenceValue = globalSettingsFieldSignature(reference)[field];
      const unanimous = partitions.every((entry) => {
        const signature = globalSettingsFieldSignature(entry.settings);
        return JSON.stringify(signature[field]) === JSON.stringify(referenceValue);
      });
      if (!unanimous) divergent.push(field);
    }
    for (const bit of GLOBAL_MIGRATION_RECONCILIATION_CONSENT_BITS) {
      const referenceValue = reference.consent[bit];
      const unanimous = partitions.every((entry) => entry.settings.consent[bit] === referenceValue);
      if (!unanimous) divergent.push(`consent.${bit}`);
    }
    return divergent.sort();
  }

  function buildLegacyGlobalReconciliation(partitions, timestamp) {
    if (partitions.length === 0) return null;
    const reference = partitions[0].settings;
    const consentUnanimous = partitions.every((entry) =>
      GLOBAL_MIGRATION_RECONCILIATION_CONSENT_BITS.every((bit) => entry.settings.consent[bit] === reference.consent[bit]));
    const authorityUnanimous = partitions.every((entry) => {
      const signature = globalSettingsFieldSignature(entry.settings);
      const referenceSignature = globalSettingsFieldSignature(reference);
      return GLOBAL_MIGRATION_RECONCILIATION_FIELDS.every((field) =>
        JSON.stringify(signature[field]) === JSON.stringify(referenceSignature[field]));
    });
    if (consentUnanimous && authorityUnanimous) {
      return { settings: reference, conflict: null };
    }
    const conflict = {
      schemaVersion: SCHEMA_VERSION,
      kind: "global-migration-conflict",
      reason: GLOBAL_MIGRATION_CONFLICT_REASON,
      createdAt: timestamp,
      partitionFingerprints: Object.freeze(partitions.map((entry) => entry.fingerprint)),
      divergentFields: Object.freeze(describeLegacyGlobalDivergences(partitions)),
      appliedDefaults: Object.freeze({
        mode: "manual",
        consent: Object.freeze({
          passiveCalls: false,
          durableObservations: false,
          sanitizedExcerpts: false,
          crossRepoAggregation: false,
        }),
      }),
      resolution: Object.freeze({
        path: "operator-settings-control",
        authorizesPublication: false,
        selectsModel: false,
      }),
    };
    return Object.freeze({ settings: null, conflict: Object.freeze(conflict) });
  }

  function reconcileLegacyGlobalUnlocked() {
    return buildLegacyGlobalReconciliation(collectLegacyGlobalPartitionsUnlocked(), now());
  }

  function loadGlobalSettingsUnlocked() {
    if (!existsSync(globalSettingsPath)) {
      const defaults = makeGlobalSettings({ createdAt: now(), updatedAt: now() });
      const reconciled = reconcileLegacyGlobalUnlocked();
      const initial = reconciled?.settings ?? defaults;
      const changes = new Map([[path.resolve(globalSettingsPath), json(initial)]]);
      if (reconciled?.conflict && !existsSync(globalMigrationConflictPath)) {
        changes.set(path.resolve(globalMigrationConflictPath), json(reconciled.conflict));
      }
      assertGlobalQuotaUnlocked(changes);
      for (const [resolved, source] of changes) atomicWrite(resolved, source);
      return initial;
    }
    let source;
    try {
      source = readFileSync(globalSettingsPath, "utf8");
      const raw = JSON.parse(source);
      const migrated = migrate(raw);
      if (!migrated) throw new Error("unsupported-version");
      const clean = makeGlobalSettings(migrated);
      if (raw.schemaVersion !== SCHEMA_VERSION) {
        const migratedSource = json(clean);
        assertGlobalQuotaUnlocked(new Map([[path.resolve(globalSettingsPath), migratedSource]]));
        atomicWrite(globalSettingsPath, migratedSource);
      }
      return clean;
    } catch (error) {
      if (["global-storage-quota-exceeded", "global-file-quota-exceeded"].includes(errorReasonCode(error))) throw error;
      try { quarantineSettings(source ?? "unreadable global settings", errorReasonCode(error, "corrupt-record"), "global-settings"); } catch {}
      return null;
    }
  }

  function loadRepoSettingsUnlocked() {
    if (!existsSync(repoSettingsPath)) {
      const defaults = makeRepoSettings({ projectFingerprint });
      try {
        atomicProjectWrite(repoSettingsPath, json(defaults));
        return defaults;
      } catch {
        return null;
      }
    }
    let source;
    try {
      source = readFileSync(repoSettingsPath, "utf8");
      const raw = JSON.parse(source);
      const legacy = raw?.repo ? migrate(raw) : null;
      const candidate = legacy?.repo ?? migrate(raw);
      if (!candidate) throw new Error("unsupported-version");
      const clean = makeRepoSettings(candidate);
      if (raw.repo || raw.schemaVersion !== SCHEMA_VERSION) {
        const global = loadGlobalSettingsUnlocked();
        atomicProjectWrite(repoSettingsPath, json(clean), { quotaBytes: (global?.budgets.storageQuotaMiB ?? 8) * 1024 * 1024 });
      }
      return clean;
    } catch (error) {
      try { quarantineSettings(source ?? "unreadable repository settings", errorReasonCode(error, "corrupt-record"), "repo-settings"); } catch {}
      return null;
    }
  }

  function getSettingsUnlocked() {
    if (startupCorruptionScope) throw new Error("corrupt-state");
    const global = loadGlobalSettingsUnlocked();
    const repo = loadRepoSettingsUnlocked();
    if (!global || !repo) throw new Error("corrupt-settings");
    lastKnownProjectQuotaBytes = (repo.budgets.storageQuotaMiB ?? global.budgets.storageQuotaMiB) * 1024 * 1024;
    return { global, repo };
  }

  function getSettings() {
    return withMutationLock(getSettingsUnlocked);
  }

  function loadAutomationGlobalSettingsUnlocked(legacy) {
    if (!existsSync(automationGlobalSettingsPath)) {
      const migrated = migrateLegacySettingsToV4(
        { schemaVersion: SCHEMA_VERSION, global: legacy.global, repo: legacy.repo },
        { projectFingerprint, now: now() },
      );
      if (!migrated) return null;
      const source = json(migrated.global);
      assertGlobalQuotaUnlocked(new Map([[path.resolve(automationGlobalSettingsPath), source]]));
      atomicWrite(automationGlobalSettingsPath, source);
      return migrated.global;
    }
    let source;
    try {
      source = readFileSync(automationGlobalSettingsPath, "utf8");
      const stored = makeV4GlobalSettings(JSON.parse(source));
      // v0.4 owns automation authority, while retained root, budget, and
      // retention management still use the established crash-safe settings
      // transaction. Mirror only those non-authority fields; retired mode,
      // pause, and passive-consent values can never flow back into v0.4.
      const synchronized = makeV4GlobalSettings({
        ...stored,
        allowedSkillRoots: legacy.global.allowedSkillRoots,
        globalRootPolicy: legacy.global.globalRootPolicy,
        budgets: legacy.global.budgets,
        retentionDays: legacy.global.retentionDays,
      });
      if (JSON.stringify(synchronized) !== JSON.stringify(stored)) {
        const nextSource = json(synchronized);
        assertGlobalQuotaUnlocked(new Map([[path.resolve(automationGlobalSettingsPath), nextSource]]));
        atomicWrite(automationGlobalSettingsPath, nextSource);
      }
      return synchronized;
    } catch (error) {
      try { quarantineGlobal(source ?? "unreadable automation settings", errorReasonCode(error, "corrupt-record"), "automation-global-settings"); } catch {}
      return null;
    }
  }

  function loadAutomationRepoSettingsUnlocked(legacy) {
    if (!existsSync(automationRepoSettingsPath)) {
      const migrated = migrateLegacySettingsToV4(
        { schemaVersion: SCHEMA_VERSION, global: legacy.global, repo: legacy.repo },
        { projectFingerprint, now: now() },
      );
      if (!migrated) return null;
      atomicProjectWrite(automationRepoSettingsPath, json(migrated.repo));
      return migrated.repo;
    }
    let source;
    try {
      source = readFileSync(automationRepoSettingsPath, "utf8");
      const stored = makeV4RepoSettings(JSON.parse(source));
      const synchronized = makeV4RepoSettings({ ...stored, budgets: legacy.repo.budgets });
      if (JSON.stringify(synchronized) !== JSON.stringify(stored)) {
        atomicProjectWrite(automationRepoSettingsPath, json(synchronized));
      }
      return synchronized;
    } catch (error) {
      try { quarantineSettings(source ?? "unreadable automation repository settings", errorReasonCode(error, "corrupt-record"), "automation-repo-settings"); } catch {}
      return null;
    }
  }

  function getAutomationStateUnlocked() {
    if (startupCorruptionScope) return { ok: false, enabled: false, reason: "corrupt-state" };
    const legacy = { global: loadGlobalSettingsUnlocked(), repo: loadRepoSettingsUnlocked() };
    if (!legacy.global || !legacy.repo) return { ok: false, enabled: false, reason: "corrupt-settings" };
    lastKnownProjectQuotaBytes = (legacy.repo.budgets.storageQuotaMiB ?? legacy.global.budgets.storageQuotaMiB) * 1024 * 1024;
    const global = loadAutomationGlobalSettingsUnlocked(legacy);
    const repo = loadAutomationRepoSettingsUnlocked(legacy);
    if (!global || !repo) return { ok: false, enabled: false, reason: "corrupt-automation-settings" };
    let epoch;
    let stamp;
    try {
      epoch = automationEpoch.read();
      stamp = automationEpoch.stamp();
    } catch {
      return { ok: false, enabled: false, reason: AUTOMATION_EPOCH_INVALID_REASON };
    }
    const permissionsHash = v4AutomationPermissionsHash(global.consent);
    if (permissionsHash !== epoch.permissionsHash
      || global.automaticRecommendationsEnabled !== epoch.enabled) {
      return { ok: false, enabled: false, reason: "automation-authority-mismatch" };
    }
    return { ok: true, enabled: epoch.enabled, global, repo, epoch, stamp };
  }

  function getAutomationState() {
    try { return withMutationLock(getAutomationStateUnlocked); }
    catch (error) { return { ok: false, enabled: false, reason: errorReasonCode(error, "automation-state-unavailable") }; }
  }

  function compareAutomationStamp(stamp) {
    try { return withMutationLock(() => automationEpoch.compare(stamp)); }
    catch { return false; }
  }

  function assertAutomationStampUnlocked(stamp, { requireEnabled = true } = {}) {
    if (!automationEpoch.compare(stamp)) throw new Error("stale-automation-generation");
    const current = getAutomationStateUnlocked();
    if (!current.ok) throw new Error(current.reason ?? "automation-state-unavailable");
    if (requireEnabled && !current.enabled) throw new Error("automatic-recommendations-disabled");
    return current;
  }

  function readProjectionSnapshot() {
    return withMutationLock(() => {
      if (existsSync(decisionTransactionPath)) throw new Error("projection-snapshot-recovery-pending");
      let automation;
      try {
        automation = getAutomationStateUnlocked();
        if (!automation.ok) throw new Error(automation.reason);
      } catch {
        throw new Error("projection-snapshot-corrupt-settings");
      }
      const settings = { global: automation.global, repo: automation.repo };
      const records = [];
      for (const fileName of [...new Set(Object.values(STORE_FILES))].sort()) {
        const read = readValidatedSource(path.join(stateDir, fileName));
        if (read.damaged.length) throw new Error("projection-snapshot-corrupt-records");
        records.push(...read.records);
      }
      if (records.some((record) => record.kind === "audit-event" && record.payload?.details?.action === "proposal-content")) {
        throw new Error("projection-snapshot-recovery-pending");
      }
      // Projection grants bind the generation they authorize. Excluding only
      // their issuance records from the generation avoids a circular hash;
      // every underlying authority record and every operation outcome remains
      // generation-bearing.
      const generationRecords = records.filter((record) => !(
        record.kind === "audit-event"
        && (
          record.payload?.details?.action === "ui-operation-nonce"
          || (
            record.payload?.actor === "self-evolve-scheduler"
            && record.payload?.details?.action === "scheduler-budget"
          )
        )
      ));
      const generation = hashContent(JSON.stringify([
        "self-evolve-projection-store-snapshot-v2",
        automation.stamp,
        settings.global,
        settings.repo,
        generationRecords,
      ]));
      const timestamp = now();
      const schedulerBudgets = records
        .map((record) => record.kind === "audit-event" ? record.payload : null)
        .filter((event) => event?.actor === "self-evolve-scheduler"
          && event.details?.action === "scheduler-budget");
      const budgetUsage = (budgetType, windowMs, limit) => {
        const relevant = schedulerBudgets
          .filter((event) => event.details?.budgetType === budgetType
            && event.timestamp >= timestamp - windowMs
            && event.timestamp <= timestamp)
          .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
        return Object.freeze({
          used: relevant.length,
          limit,
          remaining: Math.max(0, limit - relevant.length),
          resetAt: relevant.length ? relevant[0].timestamp + windowMs : null,
        });
      };
      const providerLimit = settings.repo.budgets.passiveCallsPerHour
        ?? settings.global.budgets.passiveCallsPerHour;
      const synthesisLimit = settings.repo.budgets.synthesisPerDay
        ?? settings.global.budgets.synthesisPerDay;
      const storageQuotaBytes = (settings.repo.budgets.storageQuotaMiB
        ?? settings.global.budgets.storageQuotaMiB) * 1024 * 1024;
      const storageBytesUsed = projectedProjectBytesUnlocked();
      const usage = Object.freeze({
        provider: budgetUsage("passive", 60 * 60 * 1000, providerLimit),
        synthesis: budgetUsage("synthesis", DAY_MS, synthesisLimit),
        storage: Object.freeze({
          usedBytes: storageBytesUsed,
          limitBytes: storageQuotaBytes,
          remainingBytes: Math.max(0, storageQuotaBytes - storageBytesUsed),
        }),
      });
      return Object.freeze({
        projectFingerprint,
        generation,
        settings: Object.freeze({ global: settings.global, repo: settings.repo, automationStamp: automation.stamp }),
        records: Object.freeze([...records]),
        usage,
      });
    });
  }

  function allRecords() {
    const records = [];
    for (const fileName of new Set(Object.values(STORE_FILES))) records.push(...readFileRecords(fileName));
    return records;
  }

  function makeAudit(kind, details, proposalId, actor = "self-evolve-store") {
    const timestamp = now();
    const cleanDetails = stripUndefined(details);
    const payloadHash = hashContent(JSON.stringify(cleanDetails));
    const event = makeAuditEvent({
      id: hashContent(JSON.stringify({ kind, details: cleanDetails, proposalId, actor, timestamp, nonce: randomBytes(8).toString("hex") })),
      kind,
      ...(proposalId === undefined ? {} : { proposalId }),
      actor,
      timestamp,
      payloadHash,
      details: cleanDetails,
    });
    return wrapRecord("audit-event", event, timestamp);
  }

  function appendValidUnlocked(envelope, { mandatoryAudit = false } = {}) {
    const clean = assertRecord(envelope);
    if (clean.kind === "audit-event" && clean.payload?.details?.action === "proposal-content") return { ok: false, reason: "legacy-proposal-content-rejected" };
    if (clean.kind === "proposal-content") {
      const proposal = getRecordUnlocked("proposal", clean.payload.proposalId)?.payload;
      if (!proposal || proposal.proposedContentHash !== clean.payload.contentHash) return { ok: false, reason: "proposal-content-binding-mismatch" };
      if (!["critic-pending", "pending", "approved", "applied"].includes(proposal.state)) return { ok: false, reason: "proposal-content-terminal" };
    }
    const fileName = fileForKind(clean.kind);
    const { records, source: currentSource } = readFileRecordsWithSource(fileName);
    if (records.some((record) => record.id === clean.id)) return { ok: true, duplicate: true, record: clean };
    if (clean.kind === "audit-event") {
      const existing = records.find((record) => record.kind === "audit-event" && record.payload.id === clean.payload.id);
      if (existing) return { ok: true, duplicate: true, record: existing };
    }
    const line = `${JSON.stringify(clean)}\n`;
    const base = currentSource === null
      ? records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "")
      : currentSource && !currentSource.endsWith("\n") ? `${currentSource}\n` : currentSource;
    const source = base + line;
    const addedBytes = Buffer.byteLength(source, "utf8") - Buffer.byteLength(currentSource ?? base, "utf8");
    const filePath = path.join(stateDir, fileName);
    try {
      assertProjectQuotaUnlocked(new Map([[path.resolve(filePath), source]]), { mandatoryAuditBytes: mandatoryAudit ? addedBytes : 0 });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "corrupt-record") };
    }
    atomicWrite(filePath, source);
    cacheParsedRecords(filePath, source, [...records, clean]);
    return { ok: true, duplicate: false, record: clean };
  }

  function appendAuditUnlocked(kind, details, proposalId, actor) {
    return appendValidUnlocked(makeAudit(kind, details, proposalId, actor), { mandatoryAudit: true });
  }

  function validateRequestTransaction(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed-request-transaction");
    const expected = ["action", "expiresAt", "intentHash", "issuedAt", "nonceHash", "projectFingerprint", "requestDigest", "requestId", "type"];
    if (Object.keys(value).sort().join(",") !== expected.sort().join(",")) throw new Error("malformed-request-transaction");
    if (value.type !== "operation"
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.requestId)
        || !/^[a-f0-9]{64}$/u.test(value.projectFingerprint)
        || !/^[a-f0-9]{64}$/u.test(value.requestDigest)
        || !/^[a-f0-9]{64}$/u.test(value.nonceHash)
        || typeof value.action !== "string" || value.action.length < 1 || value.action.length > 64
        || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt) throw new Error("malformed-request-transaction");
    const { intentHash, ...body } = value;
    if (intentHash !== hashContent(JSON.stringify(body))) throw new Error("corrupt-request-transaction");
    return Object.freeze({ ...body, intentHash });
  }

  function readRequestTransactionUnlocked({ expire = false } = {}) {
    if (!existsSync(requestTransactionPath)) return null;
    const transaction = validateRequestTransaction(JSON.parse(readFileSync(requestTransactionPath, "utf8")));
    if (expire && transaction.expiresAt <= now()) {
      rmSync(requestTransactionPath, { force: true });
      return null;
    }
    return transaction;
  }

  function beginRequestTransaction(value) {
    try {
      return withMutationLock(() => {
        const body = {
          type: "operation",
          requestId: value?.requestId,
          projectFingerprint: value?.projectFingerprint,
          requestDigest: value?.requestDigest,
          nonceHash: value?.nonceHash,
          action: value?.action,
          issuedAt: value?.issuedAt,
          expiresAt: value?.expiresAt,
        };
        const intent = validateRequestTransaction({ ...body, intentHash: hashContent(JSON.stringify(body)) });
        const existing = readRequestTransactionUnlocked({ expire: true });
        if (existing) return existing.intentHash === intent.intentHash
          ? { ok: true, duplicate: true, transaction: existing }
          : { ok: false, reason: "request-transaction-busy" };
        atomicWrite(requestTransactionPath, json(intent));
        return { ok: true, duplicate: false, transaction: intent };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "request-transaction-failed") };
    }
  }

  function readRequestTransaction() {
    return withMutationLock(() => readRequestTransactionUnlocked({ expire: true }));
  }

  function clearRequestTransaction(requestDigest) {
    try {
      return withMutationLock(() => {
        const existing = readRequestTransactionUnlocked();
        if (!existing) return { ok: true, absent: true };
        if (existing.requestDigest !== requestDigest) return { ok: false, reason: "request-transaction-mismatch" };
        rmSync(requestTransactionPath, { force: true });
        return { ok: true, absent: false };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "request-transaction-failed") };
    }
  }

  function hasPendingOperationRequest(requestId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(String(requestId))) return false;
    try {
      const stat = lstatSync(path.join(bridgeProjectDir, "operation-requests", `${requestId}.json`));
      return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  function purgeProjectBridgeUnlocked() {
    if (!existsSync(bridgeProjectDir)) return;
    const transaction = readRequestTransactionUnlocked();
    const keep = transaction?.projectFingerprint === projectFingerprint
      ? path.resolve(bridgeProjectDir, "operation-requests", `${transaction.requestId}.json`)
      : null;
    if (!keep) {
      rmSync(bridgeProjectDir, { recursive: true, force: true });
      return;
    }
    for (const filePath of safeTreeFiles(bridgeProjectDir)) {
      if (keep && (path.resolve(filePath) === keep || path.resolve(filePath) === path.resolve(bridgeProjectDir, "consumer.lock"))) continue;
      rmSync(filePath, { force: true });
    }
  }

  function buildSettingsTransaction(current, nextGlobal, nextRepo, globalChanged, repoChanged, audits) {
    const body = {
      protocolVersion: SETTINGS_TRANSACTION_VERSION,
      schemaVersion: SCHEMA_VERSION,
      projectFingerprint,
      global: { changed: globalChanged, prior: current.global, next: nextGlobal },
      repo: { changed: repoChanged, prior: current.repo, next: nextRepo },
      audits,
    };
    return { ...body, intentHash: hashContent(JSON.stringify(body)) };
  }

  function validateSettingsTransaction(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed-settings-transaction");
    const legacy = value.protocolVersion === 1;
    const expectedKeys = [legacy ? "audit" : "audits", "global", "intentHash", "projectFingerprint", "protocolVersion", "repo", "schemaVersion"];
    if (Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",")) throw new Error("malformed-settings-transaction");
    if (![1, SETTINGS_TRANSACTION_VERSION].includes(value.protocolVersion) || value.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported-settings-transaction");
    if (!/^[a-f0-9]{64}$/.test(value.projectFingerprint)) throw new Error("malformed-settings-transaction");
    const validateChange = (change, makeSettings) => {
      if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("malformed-settings-transaction");
      if (Object.keys(change).sort().join(",") !== "changed,next,prior") throw new Error("malformed-settings-transaction");
      if (typeof change.changed !== "boolean") throw new Error("malformed-settings-transaction");
      const prior = makeSettings(change.prior);
      const next = makeSettings(change.next);
      if (change.changed !== (JSON.stringify(prior) !== JSON.stringify(next))) throw new Error("malformed-settings-transaction");
      return { changed: change.changed, prior, next };
    };
    const global = validateChange(value.global, makeGlobalSettings);
    const repo = validateChange(value.repo, makeRepoSettings);
    if (!global.changed && !repo.changed) throw new Error("malformed-settings-transaction");
    if (repo.prior.projectFingerprint !== value.projectFingerprint || repo.next.projectFingerprint !== value.projectFingerprint) throw new Error("cross-scope");
    const audits = (legacy ? [value.audit] : value.audits).map(assertRecord);
    if (audits.length < 1 || audits.length > 8 || audits.some((audit) => audit.kind !== "audit-event")) throw new Error("malformed-settings-transaction");
    const expectedAction = global.changed && repo.changed ? "global-repo-settings" : global.changed ? "global-settings" : "repo-settings";
    if (audits[0].payload.kind !== "mode-change" || audits[0].payload.details?.action !== expectedAction) throw new Error("malformed-settings-transaction");
    const { intentHash, ...body } = value;
    if (intentHash !== hashContent(JSON.stringify(body))) throw new Error("corrupt-settings-transaction");
    return { ...body, intentHash, global, repo, audits };
  }

  function recoverSettingsTransactionUnlocked({ inject = false } = {}) {
    if (!existsSync(settingsTransactionPath)) return null;
    let raw;
    let intent;
    try {
      raw = readFileSync(settingsTransactionPath, "utf8");
      intent = validateSettingsTransaction(JSON.parse(raw));
    } catch (error) {
      try { quarantineGlobal(raw ?? "unreadable settings transaction", errorReasonCode(error, "corrupt-record"), "settings-transaction"); }
      finally { rmSync(settingsTransactionPath, { force: true }); }
      throw new Error(errorReasonCode(error, "corrupt-record"));
    }
    const targetStateDir = path.join(baseDir, intent.projectFingerprint);
    const targetRepoSettingsPath = path.join(targetStateDir, "settings.json");
    const targetAuditPath = path.join(targetStateDir, STORE_FILES["audit-event"]);
    ensureDir(targetStateDir);
    const recoverSetting = (filePath, change, makeSettings, faultPoint) => {
      if (!change.changed) return;
      let current;
      try { current = makeSettings(JSON.parse(readFileSync(filePath, "utf8"))); }
      catch { throw new Error("settings-transaction-state-conflict"); }
      const currentSource = JSON.stringify(current);
      const priorSource = JSON.stringify(change.prior);
      const nextSource = JSON.stringify(change.next);
      if (currentSource === priorSource) {
        const source = json(change.next);
        if (filePath === globalSettingsPath) assertGlobalQuotaUnlocked(new Map([[path.resolve(filePath), source]]));
        atomicWrite(filePath, source);
      }
      else if (currentSource !== nextSource) throw new Error("settings-transaction-state-conflict");
      if (inject) injectFault(faultPoint);
    };
    recoverSetting(globalSettingsPath, intent.global, makeGlobalSettings, "settings-after-global-write");
    recoverSetting(targetRepoSettingsPath, intent.repo, makeRepoSettings, "settings-after-repo-write");
    const parsedAudit = readValidatedSource(targetAuditPath);
    if (parsedAudit.damaged.length) throw new Error("settings-transaction-audit-conflict");
    let auditSource = parsedAudit.source ?? "";
    let auditRecords = parsedAudit.records;
    let auditChanged = false;
    for (const audit of intent.audits) {
      const matching = auditRecords.filter((record) => record.id === audit.id
        || (record.kind === "audit-event" && record.payload.id === audit.payload.id));
      if (matching.some((record) => JSON.stringify(record) !== JSON.stringify(audit)) || matching.length > 1) throw new Error("settings-transaction-audit-conflict");
      if (matching.length !== 0) continue;
      if (auditSource && !auditSource.endsWith("\n")) auditSource += "\n";
      auditSource += `${JSON.stringify(audit)}\n`;
      auditRecords = [...auditRecords, audit];
      auditChanged = true;
    }
    if (auditChanged) {
      atomicWrite(targetAuditPath, auditSource);
      cacheParsedRecords(targetAuditPath, auditSource, auditRecords);
    }
    if (inject) injectFault("settings-after-audit-write");
    const consentTransition = evaluateV3ConsentTransition(intent.global.prior.consent, intent.global.next.consent);
    const capsuleSupport = consentTransition.deleteProjectCapsules
      ? deleteEvidenceCapsulesUnlocked("sanitized-excerpts-consent-revoked")
      : null;
    let invalidatedGlobalRecommendations = 0;
    if (consentTransition.invalidateGlobalSupport) {
      recoverGlobalLifecycleInvalidationsUnlocked();
      invalidatedGlobalRecommendations = invalidateStaleGlobalRecommendationsUnlocked(
        intent.audits[0].payload.timestamp,
        { force: true },
      );
    }
    rmSync(settingsTransactionPath, { force: true });
    if (inject) injectFault("settings-after-transaction-remove");
    return {
      ok: true,
      recovered: true,
      changed: true,
      settings: { global: intent.global.next, repo: intent.repo.next },
      auditEvent: intent.audits[0].payload,
      auditEvents: intent.audits.map((audit) => audit.payload),
      consentEffects: consentTransition,
      invalidatedGlobalRecommendations,
      ...(capsuleSupport ? { capsuleSupport } : {}),
    };
  }

  function updateSettings(mutator, { expectedGlobalUpdatedAt, additionalAudits = [] } = {}) {
    if (typeof mutator !== "function") return { ok: false, reason: "settings-mutator-required" };
    try {
      return withMutationLock(() => {
        const current = getSettingsUnlocked();
        if (expectedGlobalUpdatedAt !== undefined && current.global.updatedAt !== expectedGlobalUpdatedAt) return { ok: false, reason: "stale-settings-version" };
        const proposed = mutator(current);
        if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) return { ok: false, reason: "invalid-settings-mutation" };
        const nextGlobal = proposed.global === undefined ? current.global : makeGlobalSettings(proposed.global);
        const nextRepo = proposed.repo === undefined ? current.repo : makeRepoSettings(proposed.repo);
        if (nextRepo.projectFingerprint !== projectFingerprint) return { ok: false, reason: "project-partition-mismatch" };
        if (nextGlobal.mode !== current.global.mode
          || nextGlobal.paused !== current.global.paused
          || JSON.stringify(nextGlobal.consent) !== JSON.stringify(current.global.consent)
          || nextRepo.mode !== current.repo.mode) {
          return { ok: false, reason: "retired-v04-control" };
        }
        const globalChanged = JSON.stringify(nextGlobal) !== JSON.stringify(current.global);
        const repoChanged = JSON.stringify(nextRepo) !== JSON.stringify(current.repo);
        if (!globalChanged && !repoChanged) return { ok: true, changed: false, settings: current };
        const audit = makeAudit("mode-change", {
          action: globalChanged && repoChanged ? "global-repo-settings" : globalChanged ? "global-settings" : "repo-settings",
          globalMode: nextGlobal.mode,
          repoMode: nextRepo.mode,
        });
        const extraAudits = additionalAudits.map(assertRecord);
        if (extraAudits.length > 7 || extraAudits.some((record) => record.kind !== "audit-event")) throw new Error("invalid-settings-audit");
        const transactionAudits = [audit, ...extraAudits];
        const auditRecords = readFileRecords(STORE_FILES["audit-event"]);
        const auditSource = [...auditRecords, ...transactionAudits].map((record) => JSON.stringify(record)).join("\n") + "\n";
        const auditBytes = transactionAudits.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8") + 1, 0);
        const changes = new Map([[path.resolve(path.join(stateDir, STORE_FILES["audit-event"])), auditSource]]);
        if (repoChanged) changes.set(path.resolve(repoSettingsPath), json(nextRepo));
        const quotaBytes = (nextRepo.budgets.storageQuotaMiB ?? nextGlobal.budgets.storageQuotaMiB) * 1024 * 1024;
        assertProjectQuotaUnlocked(changes, { mandatoryAuditBytes: auditBytes, quotaBytes });
        if (globalChanged) {
          assertGlobalQuotaUnlocked(new Map([[path.resolve(globalSettingsPath), json(nextGlobal)]]));
        }
        const intent = buildSettingsTransaction(current, nextGlobal, nextRepo, globalChanged, repoChanged, transactionAudits);
        injectFault("settings-before-intent-write");
        atomicWrite(settingsTransactionPath, json(intent));
        let committed;
        try {
          injectFault("settings-after-intent-write");
          committed = { ...recoverSettingsTransactionUnlocked({ inject: true }), recovered: false };
        } catch (error) {
          if (!existsSync(settingsTransactionPath)) {
            committed = { ok: true, recovered: false, changed: true, settings: { global: nextGlobal, repo: nextRepo }, auditEvent: audit.payload };
          } else {
            committed = { ...recoverSettingsTransactionUnlocked(), recovered: true };
          }
        }
        return committed;
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "corrupt-record") };
    }
  }

  function updateGlobalSettings(mutator, options) {
    if (typeof mutator !== "function") return { ok: false, reason: "settings-mutator-required" };
    return updateSettings((current) => ({ global: mutator(current.global, current) }), options);
  }

  function updateRepoSettings(mutator, options) {
    if (typeof mutator !== "function") return { ok: false, reason: "settings-mutator-required" };
    return updateSettings((current) => ({ repo: mutator(current.repo, current) }), options);
  }

  function setSettings(scope, value) {
    const result = scope === "global"
      ? updateGlobalSettings(() => value)
      : updateRepoSettings(() => value);
    return result.ok ? result.settings[scope] : result;
  }

  function automationRequest(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid-automation-transition");
    const allowed = ["action", "enabled", "expectedGeneration", "permission", "transitionId"];
    if (Object.keys(request).some((key) => !allowed.includes(key))) throw new Error("invalid-automation-transition");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(String(request.transitionId))) throw new Error("invalid-automation-transition-id");
    if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 1) throw new Error("invalid-automation-generation");
    if (typeof request.enabled !== "boolean") throw new Error("invalid-automation-enabled");
    if (!["set-automatic-recommendations", "set-permission", "set-emergency-stop"].includes(request.action)) {
      throw new Error("invalid-automation-action");
    }
    const permission = request.action === "set-permission"
      ? String(request.permission ?? "")
      : null;
    if (request.action === "set-permission" && !V4_AUTOMATION_PERMISSION_FIELDS.includes(permission)) {
      throw new Error("invalid-automation-permission");
    }
    if (request.action !== "set-permission" && request.permission !== undefined && request.permission !== null) {
      throw new Error("invalid-automation-permission");
    }
    const clean = {
      transitionId: request.transitionId,
      expectedGeneration: request.expectedGeneration,
      action: request.action,
      permission,
      enabled: request.enabled,
    };
    return { ...clean, transitionHash: hashContent(JSON.stringify(["self-evolve-automation-transition-v1", clean])) };
  }

  function buildAutomationTransaction(current, nextGlobal, request, audit) {
    const body = {
      protocolVersion: AUTOMATION_TRANSACTION_VERSION,
      schemaVersion: V4_SCHEMA_VERSION,
      projectFingerprint,
      transitionId: request.transitionId,
      transitionHash: request.transitionHash,
      expectedGeneration: request.expectedGeneration,
      enabled: nextGlobal.automaticRecommendationsEnabled,
      permissionsHash: v4AutomationPermissionsHash(nextGlobal.consent),
      prior: current.global,
      next: nextGlobal,
      audit,
    };
    return { ...body, intentHash: hashContent(JSON.stringify(body)) };
  }

  function validateAutomationTransaction(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed-automation-transaction");
    const keys = [
      "audit", "enabled", "expectedGeneration", "intentHash", "next", "permissionsHash",
      "prior", "projectFingerprint", "protocolVersion", "schemaVersion", "transitionHash", "transitionId",
    ];
    if (Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new Error("malformed-automation-transaction");
    if (value.protocolVersion !== AUTOMATION_TRANSACTION_VERSION || value.schemaVersion !== V4_SCHEMA_VERSION) {
      throw new Error("unsupported-automation-transaction");
    }
    if (!/^[a-f0-9]{64}$/u.test(String(value.projectFingerprint))) throw new Error("cross-scope");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(String(value.transitionId))) throw new Error("malformed-automation-transaction");
    if (!/^[a-f0-9]{64}$/u.test(String(value.transitionHash)) || !/^[a-f0-9]{64}$/u.test(String(value.permissionsHash))) {
      throw new Error("malformed-automation-transaction");
    }
    if (!Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1 || typeof value.enabled !== "boolean") {
      throw new Error("malformed-automation-transaction");
    }
    const prior = makeV4GlobalSettings(value.prior);
    const next = makeV4GlobalSettings(value.next);
    if (JSON.stringify(prior) === JSON.stringify(next)
      || next.automaticRecommendationsEnabled !== value.enabled
      || v4AutomationPermissionsHash(next.consent) !== value.permissionsHash) {
      throw new Error("malformed-automation-transaction");
    }
    const audit = assertRecord(value.audit);
    if (audit.kind !== "audit-event" || audit.payload.kind !== "mode-change"
      || audit.payload.details?.action !== "automation-control") {
      throw new Error("malformed-automation-transaction");
    }
    const { intentHash, ...body } = value;
    if (intentHash !== hashContent(JSON.stringify(body))) throw new Error("corrupt-automation-transaction");
    return { ...body, intentHash, prior, next, audit };
  }

  function recoverAutomationTransactionUnlocked({ inject = false } = {}) {
    if (!existsSync(automationTransactionPath)) return null;
    let source;
    let intent;
    try {
      source = readFileSync(automationTransactionPath, "utf8");
      intent = validateAutomationTransaction(JSON.parse(source));
    } catch (error) {
      try { quarantineGlobal(source ?? "unreadable automation transaction", errorReasonCode(error, "corrupt-record"), "automation-transaction"); }
      finally { rmSync(automationTransactionPath, { force: true }); }
      throw new Error(errorReasonCode(error, "corrupt-record"));
    }

    automationEpoch.transition({
      transitionId: intent.transitionId,
      transitionHash: intent.transitionHash,
      expectedGeneration: intent.expectedGeneration,
      enabled: intent.enabled,
      permissionsHash: intent.permissionsHash,
      rootIdentityHash: rootBoundary.identity,
    });
    if (inject) injectFault("automation-after-epoch-write");

    let current;
    try { current = makeV4GlobalSettings(JSON.parse(readFileSync(automationGlobalSettingsPath, "utf8"))); }
    catch { throw new Error("automation-transaction-state-conflict"); }
    if (JSON.stringify(current) === JSON.stringify(intent.prior)) {
      const nextSource = json(intent.next);
      assertGlobalQuotaUnlocked(new Map([[path.resolve(automationGlobalSettingsPath), nextSource]]));
      atomicWrite(automationGlobalSettingsPath, nextSource);
    } else if (JSON.stringify(current) !== JSON.stringify(intent.next)) {
      throw new Error("automation-transaction-state-conflict");
    }
    if (inject) injectFault("automation-after-settings-write");

    const targetStateDir = path.join(baseDir, intent.projectFingerprint);
    ensureDir(targetStateDir);
    const auditPath = path.join(targetStateDir, STORE_FILES["audit-event"]);
    const parsedAudit = readValidatedSource(auditPath);
    if (parsedAudit.damaged.length) throw new Error("automation-transaction-audit-conflict");
    const matches = parsedAudit.records.filter((record) => record.id === intent.audit.id
      || (record.kind === "audit-event" && record.payload.id === intent.audit.payload.id));
    if (matches.some((record) => JSON.stringify(record) !== JSON.stringify(intent.audit)) || matches.length > 1) {
      throw new Error("automation-transaction-audit-conflict");
    }
    if (matches.length === 0) {
      let auditSource = parsedAudit.source ?? "";
      if (auditSource && !auditSource.endsWith("\n")) auditSource += "\n";
      auditSource += `${JSON.stringify(intent.audit)}\n`;
      atomicWrite(auditPath, auditSource);
      cacheParsedRecords(auditPath, auditSource, [...parsedAudit.records, intent.audit]);
    }
    if (inject) injectFault("automation-after-audit-write");

    const consentEffects = evaluateV4PermissionTransition(intent.prior.consent, intent.next.consent);
    const capsuleSupport = consentEffects.deleteProjectCapsules
      ? deleteEvidenceCapsulesUnlocked("sanitized-excerpts-consent-revoked")
      : null;
    // A reversible Off/permission transition fences future autonomous work but
    // does not retract recommendations that were already published for
    // operator review. Their immutable support/content remains reviewable;
    // only unfinished work from the closed generation is settled below.
    const invalidatedGlobalRecommendations = 0;
    const automationSettlement = !intent.next.automaticRecommendationsEnabled
      ? settleAutomationGenerationUnlocked(intent.expectedGeneration, intent.audit.payload.timestamp)
      : { candidates: 0, attempts: 0 };
    if (inject) injectFault("automation-after-privacy-effects");
    rmSync(automationTransactionPath, { force: true });
    if (inject) injectFault("automation-after-transaction-remove");
    return {
      ok: true,
      recovered: true,
      changed: true,
      settings: intent.next,
      epoch: automationEpoch.read(),
      auditEvent: intent.audit.payload,
      consentEffects,
      invalidatedGlobalRecommendations,
      automationSettlement,
      ...(capsuleSupport ? { capsuleSupport } : {}),
    };
  }

  function transitionAutomation(request) {
    try {
      const cleanRequest = automationRequest(request);
      return withMutationLock(() => {
        const current = getAutomationStateUnlocked();
        if (!current.ok) return current;
        if (current.epoch.lastTransitionId === cleanRequest.transitionId) {
          if (current.epoch.lastTransitionHash !== cleanRequest.transitionHash) {
            return { ok: false, reason: "automation-transition-conflict" };
          }
          return { ok: true, changed: false, duplicate: true, settings: current.global, epoch: current.epoch };
        }
        if (current.epoch.generation !== cleanRequest.expectedGeneration) {
          return { ok: false, reason: "stale-automation-generation" };
        }
        let consent = current.global.consent;
        let enabled = current.global.automaticRecommendationsEnabled;
        let killSwitchActive = current.global.killSwitchActive;
        if (cleanRequest.action === "set-automatic-recommendations") {
          enabled = cleanRequest.enabled;
          if (enabled) consent = { durableObservations: true, sanitizedExcerpts: true, crossRepoAggregation: true };
        } else if (cleanRequest.action === "set-permission") {
          consent = { ...consent, [cleanRequest.permission]: cleanRequest.enabled };
          if (!cleanRequest.enabled) enabled = false;
        } else {
          killSwitchActive = cleanRequest.enabled;
        }
        if (enabled === current.global.automaticRecommendationsEnabled
          && killSwitchActive === current.global.killSwitchActive
          && JSON.stringify(consent) === JSON.stringify(current.global.consent)) {
          return { ok: true, changed: false, duplicate: false, settings: current.global, epoch: current.epoch };
        }
        const next = makeV4GlobalSettings({
          ...current.global,
          automaticRecommendationsEnabled: enabled,
          killSwitchActive,
          consent,
          updatedAt: Math.max(now(), current.global.updatedAt),
        });
        const audit = makeAudit("mode-change", {
          action: "automation-control",
          transitionIdHash: hashContent(cleanRequest.transitionId),
          control: cleanRequest.action,
          permission: cleanRequest.permission ?? undefined,
          enabled: next.automaticRecommendationsEnabled,
          ...(cleanRequest.action === "set-emergency-stop" ? { emergencyStopActive: next.killSwitchActive } : {}),
          nextGeneration: current.epoch.generation + 1,
        });
        const intent = buildAutomationTransaction(current, next, cleanRequest, audit);
        const auditPath = path.join(stateDir, STORE_FILES["audit-event"]);
        const currentAudit = readValidatedSource(auditPath);
        if (currentAudit.damaged.length) return { ok: false, reason: "automation-transaction-audit-conflict" };
        let auditSource = currentAudit.source ?? "";
        if (auditSource && !auditSource.endsWith("\n")) auditSource += "\n";
        auditSource += `${JSON.stringify(audit)}\n`;
        assertProjectQuotaUnlocked(new Map([[path.resolve(auditPath), auditSource]]), {
          mandatoryAuditBytes: Buffer.byteLength(JSON.stringify(audit), "utf8") + 1,
        });
        assertGlobalQuotaUnlocked(new Map([
          [path.resolve(automationGlobalSettingsPath), json(next)],
          [path.resolve(automationTransactionPath), json(intent)],
        ]));
        injectFault("automation-before-intent-write");
        atomicWrite(automationTransactionPath, json(intent));
        try {
          injectFault("automation-after-intent-write");
          return { ...recoverAutomationTransactionUnlocked({ inject: true }), recovered: false };
        } catch (error) {
          if (!existsSync(automationTransactionPath)) {
            return { ok: true, changed: true, recovered: false, settings: next, epoch: automationEpoch.read(), auditEvent: audit.payload };
          }
          return { ...recoverAutomationTransactionUnlocked(), recovered: true };
        }
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "automation-transition-failed") };
    }
  }

  function setAutomationProjectExcluded(excluded) {
    try {
      if (typeof excluded !== "boolean") throw new Error("invalid-project-exclusion");
      return withMutationLock(() => {
        const current = getAutomationStateUnlocked();
        if (!current.ok) return current;
        if (current.repo.excluded === excluded) {
          return { ok: true, changed: false, settings: current.repo };
        }
        const next = makeV4RepoSettings({ ...current.repo, excluded });
        const audit = makeAudit("mode-change", {
          action: excluded ? "exclude" : "include",
          scope: "project",
          excluded,
        });
        const auditPath = path.join(stateDir, STORE_FILES["audit-event"]);
        const parsedAudit = readValidatedSource(auditPath);
        if (parsedAudit.damaged.length) return { ok: false, reason: "project-exclusion-audit-conflict" };
        let auditSource = parsedAudit.source ?? "";
        if (auditSource && !auditSource.endsWith("\n")) auditSource += "\n";
        auditSource += `${JSON.stringify(audit)}\n`;
        assertProjectQuotaUnlocked(new Map([
          [path.resolve(automationRepoSettingsPath), json(next)],
          [path.resolve(auditPath), auditSource],
        ]), {
          mandatoryAuditBytes: Buffer.byteLength(JSON.stringify(audit), "utf8") + 1,
        });
        atomicProjectWrite(automationRepoSettingsPath, json(next));
        atomicWrite(auditPath, auditSource);
        cacheParsedRecords(auditPath, auditSource, [...parsedAudit.records, audit]);
        return { ok: true, changed: true, settings: next, auditEvent: audit.payload };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "project-exclusion-update-failed") };
    }
  }

  function appendRecord(envelope, { automationStamp = null } = {}) {
    try { return withMutationLock(() => {
      if (automationStamp != null) assertAutomationStampUnlocked(automationStamp);
      return appendValidUnlocked(envelope);
    }); }
    catch (error) {
      const reason = errorReasonCode(error, "corrupt-record");
      // A fenced automatic result is valid data from a generation that no
      // longer owns authority. Refusing it must be side-effect free: writing a
      // quarantine record after Off would itself be an autonomous durable
      // mutation under the revoked generation.
      if (!["stale-automation-generation", "automatic-recommendations-disabled"].includes(reason)) {
        try { withMutationLock(() => quarantine(envelope, reason)); } catch {}
      }
      return { ok: false, reason };
    }
  }

  function admitSynthesisAttempt(envelope, { rootSessionIDHash } = {}) {
    try {
      return withMutationLock(() => {
        const attempt = assertRecord(envelope);
        if (attempt.kind !== "synthesis-attempt") return { ok: false, reason: "invalid-synthesis-attempt-admission" };
        const fileName = fileForKind("synthesis-attempt");
        const { records, source: currentSource } = readFileRecordsWithSource(fileName);
        if (records.some((record) => record.id === attempt.id)) {
          return { ok: true, duplicate: true, record: attempt };
        }
        const timestamp = attempt.payload.admittedAt;
        const current = getSettingsUnlocked();
        const limit = current.repo.budgets.synthesisPerDay ?? current.global.budgets.synthesisPerDay;
        const used = records.filter((record) => record.kind === "audit-event"
          && record.payload?.actor === "self-evolve-scheduler"
          && record.payload.details?.action === "scheduler-budget"
          && record.payload.details?.budgetType === "synthesis"
          && record.payload.timestamp >= timestamp - DAY_MS).length;
        if (used >= limit) return { ok: false, reason: "synthesis-budget-exhausted", remaining: 0 };
        const lineageHash = /^[a-f0-9]{64}$/u.test(String(rootSessionIDHash))
          ? String(rootSessionIDHash)
          : hashContent("unknown-root-session");
        const details = {
          action: "scheduler-budget",
          budgetType: "synthesis",
          reservationId: hashContent(`synthesis-budget-admission-v1\n${attempt.payload.outcomeId}`),
          rootSessionIDHash: lineageHash,
        };
        const payloadHash = hashContent(JSON.stringify(details));
        const event = makeAuditEvent({
          id: hashContent(`synthesis-budget-admission-audit-v1\n${attempt.payload.outcomeId}`),
          kind: "decision",
          actor: "self-evolve-scheduler",
          timestamp,
          payloadHash,
          details,
        });
        const budget = assertRecord(wrapRecord("audit-event", event, timestamp));
        if (records.some((record) => record.kind === "audit-event" && record.payload.id === event.id)) {
          return { ok: false, reason: "synthesis-budget-admission-conflict" };
        }
        const base = currentSource === null
          ? records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "")
          : currentSource && !currentSource.endsWith("\n") ? `${currentSource}\n` : currentSource;
        const source = `${base}${JSON.stringify(attempt)}\n${JSON.stringify(budget)}\n`;
        const filePath = path.join(stateDir, fileName);
        assertProjectQuotaUnlocked(new Map([[path.resolve(filePath), source]]));
        atomicWrite(filePath, source);
        cacheParsedRecords(filePath, source, [...records, attempt, budget]);
        return { ok: true, duplicate: false, record: attempt, budget: event, remaining: Math.max(0, limit - used - 1) };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "synthesis-attempt-admission-failed") };
    }
  }

  function isSynthesisLeaseCleanupAudit(event) {
    const details = event.details;
    const warning = details?.action === "synthesis-lease-cleanup-warning";
    const expectedKeys = warning
      ? ["action", "cleanupOwner", "expectedLeaseActor", "expectedLeasePid", "leaseKey", "leaseNonceHash", "outcomeId", "reason", "retryable", "subjectId"]
      : ["action", "cleanupOwner", "leaseKey", "leaseNonceHash", "outcomeId", "reason", "retryable", "subjectId"];
    if (!warning && details?.action !== "synthesis-lease-cleanup-resolved") return false;
    if (Object.keys(details).sort().join(",") !== expectedKeys.sort().join(",")
        || event.kind !== "decision" || event.actor !== "self-evolve-pipeline" || event.proposalId !== undefined
        || details.subjectId !== details.outcomeId || !/^[a-f0-9]{64}$/u.test(details.outcomeId)
        || !/^synthesis_[a-f0-9]{64}$/u.test(details.leaseKey) || !/^[a-f0-9]{64}$/u.test(details.leaseNonceHash)
        || details.cleanupOwner !== "self-evolve-pipeline" || details.retryable !== warning
        || typeof details.reason !== "string" || details.reason.length < 1 || details.reason.length > 128) return false;
    if (warning && (typeof details.expectedLeaseActor !== "string" || details.expectedLeaseActor.length < 1
        || details.expectedLeaseActor.length > 128 || !Number.isSafeInteger(details.expectedLeasePid) || details.expectedLeasePid < 1)) return false;
    const clean = warning
      ? {
          action: details.action,
          subjectId: details.subjectId,
          outcomeId: details.outcomeId,
          leaseKey: details.leaseKey,
          leaseNonceHash: details.leaseNonceHash,
          cleanupOwner: details.cleanupOwner,
          expectedLeaseActor: details.expectedLeaseActor,
          expectedLeasePid: details.expectedLeasePid,
          retryable: details.retryable,
          reason: details.reason,
        }
      : {
          action: details.action,
          subjectId: details.subjectId,
          outcomeId: details.outcomeId,
          leaseKey: details.leaseKey,
          leaseNonceHash: details.leaseNonceHash,
          cleanupOwner: details.cleanupOwner,
          retryable: details.retryable,
          reason: details.reason,
        };
    const payloadHash = hashContent(JSON.stringify(clean));
    const id = hashContent(JSON.stringify({ timestamp: event.timestamp, payloadHash, clean }));
    return event.payloadHash === payloadHash && event.id === id;
  }

  function appendSynthesisFinalizationAudit(envelope) {
    try {
      return withMutationLock(() => {
        const clean = assertRecord(envelope);
        const action = clean.payload?.details?.action;
        if (clean.kind !== "audit-event" || !SYNTHESIS_FINALIZATION_AUDIT_ACTIONS.has(action)
            || (action === "synthesis-outcome"
              ? parseSynthesisOutcomeAuditEvent(clean.payload) === null
              : !isSynthesisLeaseCleanupAudit(clean.payload))) {
          return { ok: false, reason: "invalid-synthesis-finalization-audit" };
        }
        return appendValidUnlocked(clean, { mandatoryAudit: true });
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "corrupt-record") };
    }
  }

  function readRecords(kind, { since, limit } = {}) {
    return withMutationLock(() => {
      recoverDecisionTransactionUnlocked();
      recoverTerminalProposalContentUnlocked();
      const boundedLimit = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(limit));
      return readFileRecords(fileForKind(kind)).filter((record) => record.kind === kind && (since === undefined || record.createdAt >= since)).slice(0, boundedLimit);
    });
  }

  function getRecordUnlocked(kind, id) {
    const records = readFileRecords(fileForKind(kind)).filter((record) => record.kind === kind);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].id === id || logicalId(records[index]) === id) return records[index];
    }
    return null;
  }

  function getRecord(kind, id) {
    return withMutationLock(() => {
      recoverDecisionTransactionUnlocked();
      recoverTerminalProposalContentUnlocked();
      return getRecordUnlocked(kind, id);
    });
  }

  function leasePath(leaseKey) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(leaseKey))) throw new TypeError("invalid-lease-key");
    return path.join(leasesDir, `${leaseKey}.lock`);
  }

  function readLeaseState(leaseKey) {
    let source;
    try {
      source = readFileSync(leasePath(leaseKey), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "absent", lease: null };
      return { state: "error", lease: null, reason: "lease-read-error", code: String(error?.code ?? "UNKNOWN") };
    }
    let lease;
    try {
      lease = JSON.parse(source);
    } catch {
      return { state: "corrupt", lease: null, reason: "lease-invalid-json", source };
    }
    const valid = lease && typeof lease === "object" && !Array.isArray(lease)
      && typeof lease.actor === "string" && lease.actor.length > 0 && lease.actor.length <= 256
      && Number.isSafeInteger(lease.acquiredAt) && lease.acquiredAt >= 0
      && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt >= lease.acquiredAt
      && typeof lease.nonce === "string" && lease.nonce.length > 0 && lease.nonce.length <= 256
      && (lease.pid === undefined || (Number.isSafeInteger(lease.pid) && lease.pid > 0));
    if (!valid) return { state: "corrupt", lease: null, reason: "lease-invalid-shape", source };
    return { state: "valid", lease };
  }

  function leaseStatusUnlocked(leaseKey, nowMs = now()) {
    const read = readLeaseState(leaseKey);
    if (read.state !== "valid") return { ...read, held: false, reclaimable: false };
    const current = read.lease;
    const processAware = Number.isSafeInteger(current.pid) && current.pid > 0;
    const ownerAlive = processAware ? processIsAlive(current.pid) : null;
    const unexpired = Number.isSafeInteger(current.expiresAt) && current.expiresAt > nowMs;
    const held = processAware ? ownerAlive : unexpired;
    return {
      state: held ? "held" : "reclaimable",
      held,
      reclaimable: !held,
      processAware,
      ownerAlive,
      lease: current,
    };
  }

  function removeLeaseUnlocked(leaseKey, current) {
    try { unlinkSync(leasePath(leaseKey)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (current?.nonce) {
      const owned = ownedLeases.get(leaseKey);
      if (owned === current.nonce) ownedLeases.delete(leaseKey);
    }
  }

  function acquireLease(leaseKey, { ttlMs, actor, automationStamp = null }) {
    try {
      return withMutationLock(() => {
      if (automationStamp != null) assertAutomationStampUnlocked(automationStamp);
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return { ok: false, reason: "invalid-ttl" };
      const cleanActor = String(actor ?? "");
      if (!cleanActor || cleanActor.length > 256) return { ok: false, reason: "invalid-actor" };
      const filePath = leasePath(leaseKey);
      const acquiredAt = now();
      const nonce = randomBytes(24).toString("hex");
      const status = leaseStatusUnlocked(leaseKey, acquiredAt);
      if (status.state === "error") return { ok: false, reason: status.reason, code: status.code };
      if (status.held) return { ok: false, reason: "lease-busy", currentOwner: status.lease?.actor ?? null };
      let repairedCorruptLease = false;
      if (status.state === "corrupt") {
        quarantineDeterministic(status.source, status.reason, `lease-${leaseKey}`);
        removeLeaseUnlocked(leaseKey);
        repairedCorruptLease = true;
      }
      if (status.lease) removeLeaseUnlocked(leaseKey, status.lease);
      const source = json({ pid: process.pid, actor: cleanActor, acquiredAt, expiresAt: acquiredAt + ttlMs, nonce });
      assertProjectQuotaUnlocked(new Map([[path.resolve(filePath), source]]));
      let descriptor;
      let createdLeaseFile = false;
      try {
        descriptor = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
        createdLeaseFile = true;
        injectFault("lease-after-create", { filePath, descriptor, source });
        writeFileSync(descriptor, source, "utf8");
        closeSync(descriptor);
        descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
        if (createdLeaseFile) try { unlinkSync(filePath); } catch {}
        throw error;
      }
      ownedLeases.set(leaseKey, nonce);
      return { ok: true, nonce, expiresAt: acquiredAt + ttlMs, ...(repairedCorruptLease ? { repairedCorruptLease: true } : {}) };
      });
    } catch (error) {
      return { ok: false, reason: "lease-acquire-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) };
    }
  }

  function releaseLease(leaseKey, nonce) {
    try {
      return withMutationLock(() => {
      const read = readLeaseState(leaseKey);
      if (read.state === "absent") return { ok: false, reason: "lease-not-found" };
      if (read.state === "error") return { ok: false, reason: read.reason, code: read.code };
      if (read.state === "corrupt") return { ok: false, reason: "lease-corrupt" };
      const current = read.lease;
      if (current.nonce !== nonce) return { ok: false, reason: "nonce-mismatch" };
      try { unlinkSync(leasePath(leaseKey)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      ownedLeases.delete(leaseKey);
      return { ok: true };
      });
    } catch (error) {
      return { ok: false, reason: "lease-release-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) };
    }
  }

  function isLeaseHeld(leaseKey, nowMs = now()) {
    return withMutationLock(() => {
      const status = leaseStatusUnlocked(leaseKey, nowMs);
      if (status.held) return true;
      if (status.reclaimable) {
        removeLeaseUnlocked(leaseKey, status.lease);
        return false;
      }
      return false;
    });
  }

  function getLeaseStatus(leaseKey, { now: nowMs = now() } = {}) {
    return withMutationLock(() => leaseStatusUnlocked(leaseKey, nowMs));
  }

  function cleanupExpiredLeases({ now: nowMs = now() } = {}) {
    return withMutationLock(() => {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("invalid-retention-time");
      let removed = 0;
      let corruptLeases = 0;
      const errors = [];
      for (const entry of readdirSync(leasesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
        const filePath = path.join(leasesDir, entry.name);
        const key = entry.name.slice(0, -".lock".length);
        const status = leaseStatusUnlocked(key, nowMs);
        if (status.state === "error") {
          errors.push({ leaseKey: key, reason: status.reason, code: status.code });
          continue;
        }
        if (status.state === "corrupt") {
          quarantineDeterministic(status.source, status.reason, `lease-${key}`);
          removeLeaseUnlocked(key);
          corruptLeases += 1;
          continue;
        }
        if (!status.reclaimable) continue;
        try { unlinkSync(filePath); removed += 1; } catch (error) { if (error?.code !== "ENOENT") throw error; }
        for (const [ownedKey, nonce] of ownedLeases) {
          if (status.lease.nonce === nonce) ownedLeases.delete(ownedKey);
        }
      }
      return { leases: removed, corruptLeases, errors };
    });
  }

  function hostOwnerKey(sessionId) {
    const value = String(sessionId ?? "");
    if (!value || value.length > 512 || Buffer.byteLength(value, "utf8") > 1024 || value.includes("\0")) throw new TypeError("invalid-host-session-id");
    return hashContent(`self-evolve-host-owner-v1\n${value}`);
  }

  function hostOwnerPath(sessionId) {
    return path.join(hostOwnersDir, `${hostOwnerKey(sessionId)}.json`);
  }

  function validHostOwner(value, sessionId) {
    const keys = ["schema", "sessionId", "agent", "pid", "generation", "projectFingerprint", "rootIdentity", "nonce", "acquiredAt", "expiresAt"];
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).sort().join(",") === [...keys].sort().join(",")
      && value.schema === "self-evolve.host-owner.v1"
      && value.sessionId === sessionId
      && typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 512
      && Buffer.byteLength(value.sessionId, "utf8") <= 1024 && !value.sessionId.includes("\0")
      && KNOWN_HIDDEN_HOST_OWNER_AGENTS.has(value.agent)
      && Number.isSafeInteger(value.pid) && value.pid > 0
      && Number.isSafeInteger(value.generation) && value.generation >= 0
      && /^[a-f0-9]{64}$/.test(value.projectFingerprint)
      && /^[a-f0-9]{64}$/.test(value.rootIdentity)
      && /^(?:[a-f0-9]{2}){24,64}$/.test(value.nonce)
      && Number.isSafeInteger(value.acquiredAt) && value.acquiredAt >= 0
      && Number.isSafeInteger(value.expiresAt) && value.expiresAt > value.acquiredAt;
  }

  function readHostOwnerState(sessionId) {
    let source;
    try {
      source = readFileSync(hostOwnerPath(sessionId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "absent" };
      return { state: "error", reason: "host-owner-read-error", code: String(error?.code ?? "UNKNOWN") };
    }
    let owner;
    try {
      owner = JSON.parse(source);
    } catch {
      return { state: "corrupt", reason: "host-owner-invalid-json", source };
    }
    if (!validHostOwner(owner, sessionId)) return { state: "malformed", reason: "host-owner-invalid-shape", source };
    return { state: "valid", owner, source };
  }

  function removeHostOwnerUnlocked(sessionId, owner) {
    try { unlinkSync(hostOwnerPath(sessionId)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const key = hostOwnerKey(sessionId);
    if (!owner?.nonce || ownedHostOwners.get(key)?.nonce === owner.nonce) ownedHostOwners.delete(key);
  }

  function quarantineHostOwnerUnlocked(sessionId, read) {
    const key = hostOwnerKey(sessionId);
    quarantineDeterministic(read.source, read.reason, `host-owner-${key}`);
    removeHostOwnerUnlocked(sessionId);
  }

  function hostOwnerStatusUnlocked(sessionId, { projectFingerprint: expectedProject, rootIdentity: expectedRoot, now: nowMs = now() } = {}) {
    if (!/^[a-f0-9]{64}$/.test(String(expectedProject)) || !/^[a-f0-9]{64}$/.test(String(expectedRoot)) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      return { classification: "malformed", reason: "invalid-host-owner-status-context" };
    }
    const read = readHostOwnerState(sessionId);
    if (read.state === "absent") return { classification: "unknown", reason: "host-owner-not-found" };
    if (read.state === "error") return { classification: "unknown", reason: read.reason, code: read.code };
    if (read.state === "corrupt" || read.state === "malformed") {
      quarantineHostOwnerUnlocked(sessionId, read);
      return { classification: read.state, reason: read.reason };
    }
    const owner = read.owner;
    if (owner.projectFingerprint !== expectedProject || owner.rootIdentity !== expectedRoot) {
      return { classification: "foreign", reason: "host-owner-scope-mismatch", owner };
    }
    if (hostProcessIsAlive(owner.pid)) return { classification: "live-owner", reason: "host-owner-process-live", owner };
    return { classification: "abortable", reason: "host-owner-process-dead", owner, nonce: owner.nonce };
  }

  function acquireHostOwner(sessionId, { agent, projectFingerprint: ownerProject, rootIdentity, generation, ttlMs = HOST_OWNER_TTL_MS, pid = process.pid, automationStamp = null } = {}) {
    try {
      return withMutationLock(() => {
        if (automationStamp != null) assertAutomationStampUnlocked(automationStamp);
        hostOwnerKey(sessionId);
        if (!KNOWN_HIDDEN_HOST_OWNER_AGENTS.has(agent)) return { ok: false, reason: "invalid-host-owner-agent" };
        if (ownerProject !== projectFingerprint) return { ok: false, reason: "invalid-host-owner-project" };
        if (rootIdentity !== hashContent(JSON.stringify(["self-evolve-state-root-v1", root]))) return { ok: false, reason: "invalid-host-owner-root" };
        if (!Number.isSafeInteger(generation) || generation < 0) return { ok: false, reason: "invalid-host-owner-generation" };
        if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, reason: "invalid-host-owner-pid" };
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return { ok: false, reason: "invalid-host-owner-ttl" };
        const acquiredAt = now();
        const expiresAt = acquiredAt + ttlMs;
        if (!Number.isSafeInteger(acquiredAt) || acquiredAt < 0 || !Number.isSafeInteger(expiresAt)) return { ok: false, reason: "invalid-host-owner-time" };
        const existing = readHostOwnerState(sessionId);
        if (existing.state === "error") return { ok: false, reason: existing.reason, code: existing.code };
        if (existing.state === "valid") return { ok: false, reason: "host-owner-busy" };
        if (existing.state === "corrupt" || existing.state === "malformed") quarantineHostOwnerUnlocked(sessionId, existing);
        const nonce = randomBytes(24).toString("hex");
        const owner = { schema: "self-evolve.host-owner.v1", sessionId: String(sessionId), agent, pid, generation, projectFingerprint: ownerProject, rootIdentity, nonce, acquiredAt, expiresAt };
        const source = json(owner);
        const filePath = hostOwnerPath(sessionId);
        assertProjectQuotaUnlocked(new Map([[path.resolve(filePath), source]]));
        let descriptor;
        try {
          descriptor = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
          writeFileSync(descriptor, source, { encoding: "utf8" });
          fsyncSync(descriptor);
        } catch (error) {
          if (descriptor !== undefined) try { unlinkSync(filePath); } catch {}
          throw error;
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
        }
        ownedHostOwners.set(hostOwnerKey(sessionId), { sessionId: String(sessionId), nonce, pid: process.pid, generation });
        return { ok: true, nonce, expiresAt };
      });
    } catch (error) {
      return { ok: false, reason: "host-owner-acquire-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) };
    }
  }

  function releaseHostOwner(sessionId, nonce) {
    try {
      return withMutationLock(() => {
        const read = readHostOwnerState(sessionId);
        if (read.state === "absent") return { ok: true, absent: true };
        if (read.state === "error") return { ok: false, reason: read.reason, code: read.code };
        if (read.state !== "valid") {
          quarantineHostOwnerUnlocked(sessionId, read);
          return { ok: false, reason: read.state === "corrupt" ? "host-owner-corrupt" : "host-owner-malformed" };
        }
        if (read.owner.nonce !== nonce) return { ok: false, reason: "nonce-mismatch" };
        removeHostOwnerUnlocked(sessionId, read.owner);
        return { ok: true };
      });
    } catch (error) {
      return { ok: false, reason: "host-owner-release-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) };
    }
  }

  function retainHostOwner(sessionId, nonce) {
    const owned = ownedHostOwners.get(hostOwnerKey(sessionId));
    if (!owned || owned.nonce !== nonce) return { ok: false, reason: "nonce-mismatch" };
    owned.retainOnClose = true;
    return { ok: true };
  }

  function hostOwnerStatus(sessionId, options) {
    try { return withMutationLock(() => hostOwnerStatusUnlocked(sessionId, options)); }
    catch (error) { return { classification: "unknown", reason: "host-owner-status-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) }; }
  }

  function releaseOwnedHostOwners({ pid, generation } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(generation) || generation < 0) return { ok: false, released: 0, reason: "invalid-host-owner-release-context" };
    try {
      return withMutationLock(() => {
        let released = 0;
        const failures = [];
        for (const owned of [...ownedHostOwners.values()]) {
          if (owned.pid !== pid || owned.generation !== generation) continue;
          const read = readHostOwnerState(owned.sessionId);
          if (read.state === "absent") { ownedHostOwners.delete(hostOwnerKey(owned.sessionId)); continue; }
          if (read.state !== "valid") { failures.push({ sessionKey: hostOwnerKey(owned.sessionId), reason: `host-owner-${read.state}` }); continue; }
          if (read.owner.pid !== pid || read.owner.generation !== generation || read.owner.nonce !== owned.nonce) continue;
          removeHostOwnerUnlocked(owned.sessionId, read.owner);
          released += 1;
        }
        return failures.length ? { ok: false, released, failures } : { ok: true, released };
      });
    } catch (error) {
      return { ok: false, released: 0, reason: "host-owner-release-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) };
    }
  }

  function cleanupExpiredHostOwners({ now: nowMs = now() } = {}) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("invalid-retention-time");
    return withMutationLock(() => {
      let removed = 0;
      let quarantined = 0;
      for (const entry of readdirSync(hostOwnersDir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        let source;
        try { source = readFileSync(path.join(hostOwnersDir, entry.name), "utf8"); } catch { continue; }
        let owner;
        try { owner = JSON.parse(source); } catch {
          quarantineDeterministic(source, "host-owner-invalid-json", `host-owner-${entry.name.slice(0, 64)}`);
          unlinkSync(path.join(hostOwnersDir, entry.name));
          quarantined += 1;
          continue;
        }
        if (!validHostOwner(owner, owner?.sessionId) || hostOwnerKey(owner.sessionId) !== entry.name.slice(0, 64)) {
          quarantineDeterministic(source, "host-owner-invalid-shape", `host-owner-${entry.name.slice(0, 64)}`);
          unlinkSync(path.join(hostOwnersDir, entry.name));
          quarantined += 1;
          continue;
        }
        if (owner.expiresAt > nowMs || hostProcessIsAlive(owner.pid)) continue;
        removeHostOwnerUnlocked(owner.sessionId, owner);
        removed += 1;
      }
      return { hostOwners: removed, quarantinedHostOwners: quarantined };
    });
  }

  function runCas(kind, id, expectedPriorState, mutateFn, selectPriorState = (payload) => payload?.state, { automationStamp = null } = {}) {
    try {
      return withMutationLock(() => {
        if (automationStamp != null) assertAutomationStampUnlocked(automationStamp);
        const current = getRecordUnlocked(kind, id);
        if (!current) return { ok: false, reason: "record-not-found" };
        if (selectPriorState(current.payload) !== expectedPriorState) return { ok: false, reason: "stale-prior-state" };
        const mutation = mutateFn(current.payload);
        const next = mutation?.schemaVersion && mutation?.kind ? assertRecord(mutation) : wrapRecord(kind, mutation, now());
        const result = appendValidUnlocked(next);
        if (!result.ok) return result;
        appendAuditUnlocked("decision", { action: "cas", priorState: String(expectedPriorState), newState: String(next.payload?.state ?? "") }, logicalId(current));
        if (kind === "proposal" && ["rejected", "rolled-back", "superseded", "failed-closed"].includes(next.payload.state)) compactProposalContentUnlocked(new Set([next.payload.id]));
        return { ok: true, newRecord: next };
      });
    } catch (error) { return { ok: false, reason: errorReasonCode(error, "corrupt-record") }; }
  }

  function canonicalRecordTimestamp(record) {
    const timestamp = {
      "episode-cursor": record.payload?.lastIdleAt,
      receipt: record.payload?.lastSeenAt,
      observation: record.payload?.createdAt,
      "evidence-cluster": record.payload?.lastSeenAt,
      "eligibility-explanation": record.createdAt,
      proposal: record.payload?.synthesizedAt,
      "proposal-content": record.createdAt,
      "synthesis-attempt": record.payload?.admittedAt,
      decision: record.payload?.timestamp,
      "audit-event": record.payload?.timestamp,
      "rollback-record": record.payload?.rolledBackAt,
      "intervention-epoch": record.payload?.startedAt,
      "circuit-breaker": record.payload?.openedAt ?? record.createdAt,
    }[record.kind];
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(`malformed-retention-timestamp-${record.kind}`);
    return timestamp;
  }

  function snapshotRetentionUnlocked(records, activeProposalIds, cutoff) {
    const linked = new Map();
    const protectedPaths = new Set();
    for (const record of records) {
      if (record.kind !== "audit-event") continue;
      const details = record.payload?.details;
      if (record.payload?.kind !== "apply" || typeof details?.snapshot !== "string" || details.snapshot === "none") continue;
      const candidate = path.resolve(details.snapshot);
      if (path.dirname(candidate) !== snapshotsDir) continue;
      const timestamp = canonicalRecordTimestamp(record);
      linked.set(candidate, Math.max(timestamp, linked.get(candidate) ?? 0));
      if (activeProposalIds.has(record.payload.proposalId) && details["readback-verified"] === true) protectedPaths.add(candidate);
    }
    let removed = 0;
    for (const entry of readdirSync(snapshotsDir, { withFileTypes: true })) {
      const filePath = path.join(snapshotsDir, entry.name);
      if (entry.isSymbolicLink()) {
        try { unlinkSync(filePath); removed += 1; } catch (error) { if (error?.code !== "ENOENT") throw error; }
        continue;
      }
      if (!entry.isFile()) continue;
      if (protectedPaths.has(filePath)) continue;
      let timestamp = linked.get(filePath);
      if (timestamp === undefined) {
        try { timestamp = Math.trunc(lstatSync(filePath).mtimeMs); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      }
      if (timestamp >= cutoff) continue;
      try { unlinkSync(filePath); removed += 1; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return removed;
  }

  function retain(nowMs = now()) {
    return withMutationLock(() => {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("invalid-retention-time");
      const retentionDays = getSettingsUnlocked().global.retentionDays;
      const observationCutoff = nowMs - retentionDays * DAY_MS;
      const durableCutoff = nowMs - retentionDays * 3 * DAY_MS;
      const files = new Map();
      for (const fileName of new Set(Object.values(STORE_FILES))) files.set(fileName, readFileRecords(fileName));
      const all = [...files.values()].flat();
      const latestProposals = new Map();
      for (const record of files.get(STORE_FILES.proposal)) {
        if (record.kind === "proposal") latestProposals.set(record.payload.id, record.payload);
      }
      const activeProposalIds = new Set([...latestProposals].filter(([, proposal]) => isActiveProposalState(proposal.state)).map(([id]) => id));
      function retainedNonceKey(record) {
        const event = record.payload;
        const details = event?.details;
        if (record.kind !== "audit-event"
            || event?.kind !== "decision"
            || event.actor !== "self-evolve-integration") return null;
        if (details?.action === "ui-operation-nonce") {
          return `ui-operation-nonce\n${details.subjectId ?? ""}\n${details.uiAction}`;
        }
        if (details?.action === "control-nonce") return "control-nonce";
        if (["bridge-nonce", "headless-approval-nonce"].includes(details?.action)) {
          return `${details.action}\n${event.proposalId ?? ""}`;
        }
        return null;
      }
      const latestRetainedNonceIds = new Map();
      for (const record of files.get(STORE_FILES["audit-event"])) {
        const key = retainedNonceKey(record);
        if (key !== null) latestRetainedNonceIds.set(key, record.id);
      }
      const retainedNonceIds = new Set(latestRetainedNonceIds.values());

      const aggregateRecords = readAggregatesUnlocked();
      const keptAggregates = aggregateRecords.filter((record) => record.expiresAt > nowMs);
      const keptAggregateIds = new Set(keptAggregates.map((record) => record.aggregateId));
      const contributionRetention = retainContributionsUnlocked(nowMs);
      const candidateRetention = recomputePendingGlobalCandidatesUnlocked(nowMs);
      const globalLifecycleRetention = retainGlobalLifecycleUnlocked(nowMs);
      const retainedGlobalLeases = retainGlobalLeasesUnlocked(nowMs);
      const capsuleRecords = readEvidenceCapsulesUnlocked();
      const keptCapsules = capsuleRecords.filter((capsule) => capsule.expiresAt > nowMs);
      const aggregateIndexes = [];
      for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const indexPath = path.join(baseDir, entry.name, "aggregate-contributions.json");
        if (!existsSync(indexPath)) continue;
        aggregateIndexes.push([indexPath, readAggregateIndexUnlocked(indexPath).filter((id) => keptAggregateIds.has(id))]);
      }

      const removed = {
        observations: 0,
        evidence: 0,
        proposals: 0,
        decisions: 0,
        audit: 0,
        rollback: 0,
        interventions: 0,
        circuits: 0,
        applyClaims: 0,
        snapshots: snapshotRetentionUnlocked(all, activeProposalIds, durableCutoff),
        leases: 0,
        aggregates: aggregateRecords.length - keptAggregates.length,
        ...contributionRetention,
        ...candidateRetention,
        ...globalLifecycleRetention,
        globalLeases: retainedGlobalLeases,
        capsules: capsuleRecords.length - keptCapsules.length,
        indexes: 0,
      };
      const observationKinds = new Set(["episode-cursor", "receipt", "observation", "evidence-cluster", "eligibility-explanation"]);
      const counterFor = {
        observation: "observations",
        proposal: "proposals",
        decision: "decisions",
        "audit-event": "audit",
        "rollback-record": "rollback",
        "intervention-epoch": "interventions",
        "circuit-breaker": "circuits",
        "apply-claim": "applyClaims",
      };
      for (const [fileName, records] of files) {
        const kept = records.filter((record) => {
          if (record.kind === "apply-claim") {
            const keep = record.payload.expiresAt > nowMs;
            if (!keep) removed.applyClaims += 1;
            return keep;
          }
          if (isActiveProposalChainRecord(record, activeProposalIds)) return true;
          // Content-free busy diagnostics do not participate in authority or
          // decision history and are drained independent of record age.
          if (record.kind === "audit-event"
              && record.payload.kind === "decision"
              && record.payload.details?.action === "session-status"
              && record.payload.details?.status === "busy") {
            removed.audit += 1;
            return false;
          }
          if (retainedNonceKey(record) !== null && !retainedNonceIds.has(record.id)) {
            removed.audit += 1;
            return false;
          }
          const cutoff = observationKinds.has(record.kind) ? observationCutoff : durableCutoff;
          const keep = canonicalRecordTimestamp(record) >= cutoff;
          if (!keep) {
            const key = counterFor[record.kind] ?? "evidence";
            removed[key] += 1;
          }
          return keep;
        });
        if (kept.length !== records.length) writeRecords(fileName, kept);
      }
      writeJsonl(aggregatesPath, keptAggregates);
      if (keptCapsules.length !== capsuleRecords.length) {
        if (keptCapsules.length) writeEvidenceCapsulesUnlocked(keptCapsules);
        else rmSync(evidenceCapsulesPath, { force: true });
      }
      for (const [indexPath, ids] of aggregateIndexes) {
        if (ids.length) writeAggregateIndexUnlocked(indexPath, ids);
        else {
          unlinkSync(indexPath);
          removed.indexes += 1;
        }
      }
      for (const entry of readdirSync(leasesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
        const filePath = path.join(leasesDir, entry.name);
        const key = entry.name.slice(0, -".lock".length);
        const status = leaseStatusUnlocked(key, nowMs);
        if (status.state === "corrupt") {
          quarantineDeterministic(status.source, status.reason, `lease-${key}`);
          removeLeaseUnlocked(key);
          removed.leases += 1;
          continue;
        }
        if (status.state === "error") continue;
        if (!status.reclaimable) continue;
        unlinkSync(filePath);
        removed.leases += 1;
      }
      return removed;
    });
  }

  function readAggregateIndexUnlocked(filePath = aggregateIndexPath) {
    if (!existsSync(filePath)) return [];
    try {
      const value = JSON.parse(readFileSync(filePath, "utf8"));
      if (value?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.aggregateIds) || Object.keys(value).sort().join(",") !== "aggregateIds,schemaVersion") throw new Error("corrupt-aggregate-index");
      const ids = [...new Set(value.aggregateIds)];
      if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error("corrupt-aggregate-index");
      return ids;
    } catch (error) {
      quarantineProjectDeterministic(
        readFileSync(filePath, "utf8"),
        errorReasonCode(error, "corrupt-record"),
        "aggregate-index",
        path.dirname(filePath),
      );
      throw new Error("corrupt-aggregate-index");
    }
  }

  function writeAggregateIndexUnlocked(filePath, ids) {
    const source = json({ schemaVersion: SCHEMA_VERSION, aggregateIds: [...new Set(ids)].sort() });
    if (path.resolve(filePath).startsWith(`${stateDir}${path.sep}`)) atomicProjectWrite(filePath, source);
    else atomicWrite(filePath, source);
  }

  function repairAggregateIndexesUnlocked(keptIds) {
    if (!existsSync(baseDir)) return;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const indexPath = path.join(baseDir, entry.name, "aggregate-contributions.json");
      if (!existsSync(indexPath)) continue;
      const ids = readAggregateIndexUnlocked(indexPath).filter((id) => keptIds.has(id));
      writeAggregateIndexUnlocked(indexPath, ids);
    }
  }

  function compactAggregatesUnlocked(keep) {
    const records = readAggregatesUnlocked();
    const kept = records.filter(keep);
    writeJsonl(aggregatesPath, kept);
    repairAggregateIndexesUnlocked(new Set(kept.map((record) => record.aggregateId)));
    return { removed: records.length - kept.length, records: kept };
  }

  function removeAggregateContributionsUnlocked(aggregateIds) {
    const records = readAggregatesUnlocked();
    const kept = records.filter((record) => !aggregateIds.has(record.aggregateId));
    if (kept.length !== records.length) writeJsonl(aggregatesPath, kept);
    return records.length - kept.length;
  }

  function readAggregates({ scope = "global", includeExpired = false, nowMs = now() } = {}) {
    return withMutationLock(() => {
      if (!new Set(["global", "project"]).has(scope)) throw new TypeError("invalid-aggregate-scope");
      const projectIds = scope === "project" ? new Set(readAggregateIndexUnlocked()) : null;
      return readAggregatesUnlocked().filter((record) => (includeExpired || record.expiresAt > nowMs) && (!projectIds || projectIds.has(record.aggregateId)));
    });
  }

  function retainAggregates(nowMs = now()) {
    return withMutationLock(() => ({ aggregates: compactAggregatesUnlocked((record) => record.expiresAt > nowMs).removed }));
  }

  function contributionRecordPath(directory, id) {
    const value = String(id).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
      throw new Error("invalid-opaque-id");
    }
    return path.join(directory, value.slice(0, 2), `${value}.json`);
  }

  function contributionFiles(directory) {
    return safeTreeFiles(directory).map((filePath) => {
      const relative = path.relative(directory, filePath);
      const parts = relative.split(path.sep);
      const id = parts[1]?.slice(0, -".json".length);
      if (parts.length !== 2
          || !/^[0-9a-f]{2}$/u.test(parts[0])
          || !parts[1].endsWith(".json")
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)
          || parts[0] !== id.slice(0, 2)) {
        throw new Error("contribution-storage-path-rejected");
      }
      return { filePath, id };
    }).sort((left, right) => left.id.localeCompare(right.id));
  }

  function readCanonicalJson(filePath, maxBytes, validator, reason) {
    let source;
    let clean;
    try {
      source = readStableRegularFile(filePath, maxBytes);
      clean = validator(JSON.parse(source));
    } catch {
      throw new Error(reason);
    }
    if (source !== json(clean)) throw new Error(reason);
    return clean;
  }

  // H3-001: reload-time identity firewall patterns. A durable global record is
  // content-addressed over kind+payload and re-derived on every read, so a
  // schema-valid tampered record is the threat model. These patterns detect raw
  // private material (provider tokens, private keys, absolute paths, remote
  // URLs, private-name canaries) that must never appear in any identity-free
  // global record. The "content" key is skipped because recommendation-content
  // and snapshot payloads are canonical base64, not free text.
  const RELOAD_PROVIDER_TOKEN_PATTERNS = Object.freeze([
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bsk-(?:ant-api03-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/gi,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gi,
    /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/gi,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/gi,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/gi,
    /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi,
    /\bnpm_[A-Za-z0-9]{20,}\b/g,
    /\bAIza[A-Za-z0-9_-]{20,}\b/gi,
  ]);
  const RELOAD_PRIVATE_KEY_MARKER = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u;
  const RELOAD_ABSOLUTE_PATH = /(?:^|[\s"'(=])(?:\/(?![\/*])[^\s"'()<>]+|[A-Za-z]:\\[^\s"'()<>]+)/u;
  const RELOAD_REMOTE_URL = /\b(?:git|ssh|https?|ftp):\/\/[^\s"'<>]+|\bgit@[^\s@"':]+:[^\s"'<>]+/u;
  const RELOAD_PRIVATE_NAME_RE = /\b(?:customer|client|tenant|repository|repo|project|private)[-_:\s]+[a-z0-9][a-z0-9._-]{2,}\b/iu;

  function scanGlobalRecordForPrivateMaterial(record) {
    const issues = new Set();
    const visit = (value, key) => {
      if (typeof value === "string") {
        if (key === "content") return;
        for (const pattern of RELOAD_PROVIDER_TOKEN_PATTERNS) {
          pattern.lastIndex = 0;
          if (pattern.test(value)) { issues.add("provider-token"); break; }
        }
        if (RELOAD_PRIVATE_KEY_MARKER.test(value)) issues.add("private-key");
        if (RELOAD_ABSOLUTE_PATH.test(value)) issues.add("absolute-path");
        if (RELOAD_REMOTE_URL.test(value)) issues.add("remote-url");
        if (RELOAD_PRIVATE_NAME_RE.test(value)) issues.add("private-name");
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item, key);
      } else if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      }
    };
    visit(record, "");
    return [...issues];
  }

  // Reads, schema-validates with bounded identity-firewall context, canonically
  // round-trips, and content-scans a durable global record. Returns the cleaned
  // record, or signals identity-unsafety so the caller can quarantine the file
  // under the mutation lock before it reaches projection/recovery/export. The
  // firewall context is reconstructed from partition-safe material only: the
  // project fingerprint and its deterministic hashes.
  function readReloadSafeGlobalRecord(filePath, maxBytes, makeFn, label) {
    const source = readStableRegularFile(filePath, maxBytes);
    let record;
    try {
      record = makeFn(JSON.parse(source), { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() });
    } catch {
      return { unsafe: true, source, label };
    }
    if (source !== json(record)) return { unsafe: true, source, label };
    if (scanGlobalRecordForPrivateMaterial(record).length) return { unsafe: true, source, label };
    return { record };
  }

  function quarantineReloadedGlobalRecord(filePath, result) {
    if (!result?.unsafe) return;
    try { quarantineGlobal(result.source ?? "unreadable", "global-record-identity-unsafe", result.label); } catch {}
    try { rmSync(filePath, { force: true }); } catch {}
  }

  function localContributionIdentityValues(targetFingerprint, intent, additional = []) {
    const direct = [
      targetFingerprint,
      intent.incidentId,
      intent.capsuleId,
      intent.clusterId,
      intent.evidenceDomainId,
      ...additional,
    ];
    return [...new Set(direct.flatMap((value) => [value, hashContent(value), hashContent(JSON.stringify(value))]))];
  }

  function contributionIdentityFirewallValues(value) {
    if (!Array.isArray(value) || value.length > 32) throw new Error("malformed-contribution-transaction");
    const values = [...new Set(value.map((item) => {
      if (typeof item !== "string" || !item || item.length > 1024 || item.includes("\0")) {
        throw new Error("malformed-contribution-transaction");
      }
      return item;
    }))].sort();
    if (values.length !== value.length || values.some((item, index) => item !== value[index])) {
      throw new Error("malformed-contribution-transaction");
    }
    return Object.freeze(values);
  }

  function validateContributionTransaction(value, targetFingerprint) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "contribution,identityFirewallValues,intent,schemaVersion") {
      throw new Error("malformed-contribution-transaction");
    }
    const intent = makeContributionIntent(value.intent);
    if (value.schemaVersion !== intent.schemaVersion) throw new Error("malformed-contribution-transaction");
    const identityFirewallValues = contributionIdentityFirewallValues(value.identityFirewallValues);
    const contribution = makeGlobalContribution(value.contribution, {
      forbiddenIdentityValues: localContributionIdentityValues(targetFingerprint, intent, identityFirewallValues),
    });
    assertContributionPublicationBinding(intent, contribution, {
      forbiddenIdentityValues: localContributionIdentityValues(targetFingerprint, intent, identityFirewallValues),
    });
    return Object.freeze({ schemaVersion: intent.schemaVersion, intent, contribution, identityFirewallValues });
  }

  function readContributionTransactionsUnlocked(targetStateDir = stateDir) {
    const directory = path.join(targetStateDir, "contribution-intents");
    const targetFingerprint = path.basename(targetStateDir);
    return contributionFiles(directory).map(({ filePath, id }) => {
      const transaction = readCanonicalJson(
        filePath,
        MAX_CONTRIBUTION_TRANSACTION_BYTES,
        (value) => validateContributionTransaction(value, targetFingerprint),
        "corrupt-contribution-transaction",
      );
      if (transaction.intent.intentId !== id) throw new Error("contribution-intent-path-mismatch");
      return { filePath, transaction };
    });
  }

  function readContributionLinksUnlocked(targetStateDir = stateDir) {
    const directory = path.join(targetStateDir, "contribution-links");
    return contributionFiles(directory).map(({ filePath, id }) => {
      const link = readCanonicalJson(filePath, MAX_CONTRIBUTION_RECORD_BYTES, makeProjectContributionLink, "corrupt-contribution-link");
      if (link.contributionId !== id) throw new Error("contribution-link-path-mismatch");
      return { filePath, link };
    });
  }

  function readGlobalContributionsUnlocked() {
    return contributionFiles(contributionsDir).flatMap(({ filePath, id }) => {
      const result = readReloadSafeGlobalRecord(filePath, MAX_CONTRIBUTION_RECORD_BYTES, makeGlobalContribution, "global-contribution");
      if (result.unsafe) { quarantineReloadedGlobalRecord(filePath, result); return []; }
      const contribution = result.record;
      if (contribution.contributionId !== id) throw new Error("global-contribution-path-mismatch");
      return [{ filePath, contribution }];
    });
  }

  // Authoritative create-exclusive journal write. The namespace mutation
  // (open/O_EXCL/write/fsync/close followed by parent-directory fsync) is routed
  // through the shared `durable.durableCreateExclusive` primitive so every
  // journal stage fails closed with the stable capability reason on hosts that
  // cannot fsync a directory descriptor, and so a power loss after the create
  // can never leave a surviving-but-not-namespace-durable journal entry. The
  // label-specific before/after-create seams and the post-commit readback are
  // preserved; `${label}-after-create` now fires AFTER the durable namespace
  // commit so a test injecting there models "loss after this journal stage is
  // fully durable".
  function exclusiveJsonWrite(filePath, value, validator, label, maxBytes = MAX_CONTRIBUTION_RECORD_BYTES) {
    const source = json(value);
    if (existsSync(filePath)) {
      const current = readCanonicalJson(filePath, maxBytes, validator, `${label}-conflict`);
      if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error(`${label}-conflict`);
      return { duplicate: true, record: current };
    }
    ensureDir(path.dirname(filePath));
    let committed = false;
    try {
      injectFault(`${label}-before-create`, { filePath });
      durable.durableCreateExclusive(filePath, source);
      committed = true;
      injectFault(`${label}-after-create`, { filePath });
      const readback = readCanonicalJson(filePath, maxBytes, validator, `${label}-readback-failed`);
      return { duplicate: false, record: readback };
    } catch (error) {
      // After a successful durable create the file is content- AND namespace-
      // durable; remove it through the same durable primitive so a failed
      // readback can never leave a surviving partial-exclusive artifact that
      // claims authority it does not have. durableCreateExclusive cleans up its
      // own partial state on internal failure, so we only durable-unlink when it
      // returned successfully.
      if (committed) {
        try { durable.durableUnlink(filePath); } catch {}
      }
      throw error;
    }
  }

  function writeContributionTransactionUnlocked(filePath, transaction, targetStateDir = stateDir) {
    const targetFingerprint = path.basename(targetStateDir);
    const clean = validateContributionTransaction(transaction, targetFingerprint);
    const source = json(clean);
    const changes = new Map([[path.resolve(filePath), source]]);
    try {
      assertProjectQuotaUnlocked(changes, {
        quotaBytes: projectQuotaForStateDirUnlocked(targetStateDir),
        targetStateDir,
        targetBridgeDir: path.join(baseDir, "bridge", targetFingerprint),
      });
    } catch (error) {
      const currentBytes = existsSync(filePath) ? lstatSync(filePath).size : 0;
      if (Buffer.byteLength(source) > currentBytes) throw error;
    }
    atomicWrite(filePath, source);
    return clean;
  }

  function transitionContributionTransactionUnlocked(filePath, transaction, nextState, targetStateDir) {
    const nextIntent = transitionContributionIntent(transaction.intent, nextState, now());
    return writeContributionTransactionUnlocked(filePath, { ...transaction, intent: nextIntent }, targetStateDir);
  }

  function removeOwnedContributionArtifact(filePath, expected, validator) {
    if (!existsSync(filePath)) return false;
    try {
      const current = readCanonicalJson(filePath, MAX_CONTRIBUTION_RECORD_BYTES, validator, "contribution-artifact-conflict");
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
    } catch {
      // A partial create-exclusive file is owned by the intent that allocated its UUID.
    }
    rmSync(filePath, { force: true });
    return true;
  }

  function contributionLinkFor(intent, linkedAt = now()) {
    return makeProjectContributionLink({
      contributionId: intent.contributionId,
      intentId: intent.intentId,
      incidentId: intent.incidentId,
      capsuleId: intent.capsuleId,
      clusterId: intent.clusterId,
      evidenceDomainId: intent.evidenceDomainId,
      linkedAt,
      state: "active",
      ...(intent.automationGeneration === undefined ? {} : { automationGeneration: intent.automationGeneration }),
    });
  }

  function settleContributionTransactionUnlocked(filePath, transaction, nextState, targetStateDir) {
    const globalPath = contributionRecordPath(contributionsDir, transaction.intent.contributionId);
    const linkPath = contributionRecordPath(path.join(targetStateDir, "contribution-links"), transaction.intent.contributionId);
    const link = contributionLinkFor(transaction.intent, transaction.intent.createdAt);
    removeOwnedContributionArtifact(globalPath, transaction.contribution, makeGlobalContribution);
    removeOwnedContributionArtifact(linkPath, link, makeProjectContributionLink);
    if (transaction.intent.state === nextState) return transaction;
    if (["committed", "revoked", "failed-closed"].includes(transaction.intent.state) && nextState === "failed-closed") return transaction;
    return transitionContributionTransactionUnlocked(filePath, transaction, nextState, targetStateDir);
  }

  function recoverContributionTransactionUnlocked(filePath, transaction, targetStateDir) {
    if (["committed", "revoked", "failed-closed"].includes(transaction.intent.state)) {
      return { ok: true, state: transaction.intent.state, transaction };
    }
    const global = loadGlobalSettingsUnlocked();
    if (!global) throw new Error("corrupt-settings");
    const automation = transaction.intent.automationGeneration === undefined
      ? null
      : getAutomationStateUnlocked();
    const governingConsent = automation?.ok ? automation.global.consent : global.consent;
    // H6-001: contribution recovery reuses the unified three-bit contribution
    // authority predicate together with the intent's allocation-time consent
    // stamp. A pending transaction is terminalized to "revoked" only when a
    // governing consent bit was REVOKED after allocation (current authority is
    // insufficient AND the consent version changed). Stable-but-partial consent
    // that has not changed since allocation is left intact, while a crash inside
    // a revocation window leaves no surviving contribution, link, or support.
    const authority = evaluateContributionConsentAuthority(governingConsent);
    const currentVersion = evaluateContributionConsentVersion(governingConsent);
    const generationClosed = transaction.intent.automationGeneration !== undefined
      && (!automation?.ok || !automation.enabled
        || automation.epoch.generation !== transaction.intent.automationGeneration);
    if (generationClosed || (!authority.ok && transaction.intent.consentVersionHash !== currentVersion)) {
      const revoked = settleContributionTransactionUnlocked(filePath, transaction, "revoked", targetStateDir);
      return { ok: true, state: revoked.intent.state, transaction: revoked };
    }
    if (transaction.intent.state !== "committed" && transaction.contribution.expiresAt <= now()) {
      const failed = settleContributionTransactionUnlocked(filePath, transaction, "failed-closed", targetStateDir);
      return { ok: true, state: failed.intent.state, transaction: failed };
    }

    let current = transaction;
    const globalPath = contributionRecordPath(contributionsDir, current.intent.contributionId);
    const targetFingerprint = path.basename(targetStateDir);
    const linkPath = contributionRecordPath(path.join(targetStateDir, "contribution-links"), current.intent.contributionId);
    const link = contributionLinkFor(current.intent, current.intent.createdAt);
    try {
      if (current.intent.state === "allocated") {
        injectFault("contribution-before-global-write", { contributionId: current.intent.contributionId });
        if (existsSync(globalPath)) {
          try {
            const existing = readCanonicalJson(globalPath, MAX_CONTRIBUTION_RECORD_BYTES, makeGlobalContribution, "corrupt-global-contribution");
            if (JSON.stringify(existing) !== JSON.stringify(current.contribution)) throw new Error("global-contribution-conflict");
          } catch (error) {
            if (error.message === "global-contribution-conflict") throw error;
            rmSync(globalPath, { force: true });
          }
        }
        if (!existsSync(globalPath)) {
          assertGlobalQuotaUnlocked(new Map([[path.resolve(globalPath), json(current.contribution)]]));
          exclusiveJsonWrite(globalPath, current.contribution, makeGlobalContribution, "contribution-global");
        }
        injectFault("contribution-after-global-write", { contributionId: current.intent.contributionId });
        current = transitionContributionTransactionUnlocked(filePath, current, "published", targetStateDir);
      }
      if (current.intent.state === "published") {
        injectFault("contribution-before-link-write", { contributionId: current.intent.contributionId });
        if (existsSync(linkPath)) {
          try {
            const existing = readCanonicalJson(linkPath, MAX_CONTRIBUTION_RECORD_BYTES, makeProjectContributionLink, "corrupt-contribution-link");
            if (JSON.stringify(existing) !== JSON.stringify(link)) throw new Error("contribution-link-conflict");
          } catch (error) {
            if (error.message === "contribution-link-conflict") throw error;
            rmSync(linkPath, { force: true });
          }
        }
        if (!existsSync(linkPath)) {
          const linkSource = json(link);
          assertProjectQuotaUnlocked(new Map([[path.resolve(linkPath), linkSource]]), {
            quotaBytes: projectQuotaForStateDirUnlocked(targetStateDir),
            targetStateDir,
            targetBridgeDir: path.join(baseDir, "bridge", targetFingerprint),
          });
          exclusiveJsonWrite(linkPath, link, makeProjectContributionLink, "contribution-link");
        }
        injectFault("contribution-after-link-write", { contributionId: current.intent.contributionId });
        current = transitionContributionTransactionUnlocked(filePath, current, "linked", targetStateDir);
      }
      if (current.intent.state === "linked") {
        injectFault("contribution-before-commit-write", { contributionId: current.intent.contributionId });
        current = transitionContributionTransactionUnlocked(filePath, current, "committed", targetStateDir);
        injectFault("contribution-after-commit-write", { contributionId: current.intent.contributionId });
      }
      return { ok: true, state: current.intent.state, transaction: current, contribution: current.contribution, intent: current.intent, link };
    } catch (error) {
      if (["global-storage-quota-exceeded", "global-file-quota-exceeded", "storage-quota-exceeded", "storage-file-quota-exceeded", "global-contribution-conflict", "contribution-link-conflict"].includes(errorReasonCode(error))) {
        try { current = settleContributionTransactionUnlocked(filePath, current, "failed-closed", targetStateDir); } catch {}
      }
      return { ok: false, reason: errorReasonCode(error, "contribution-recovery-failed"), transaction: current };
    }
  }

  function projectStateDirectoriesUnlocked() {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{64}$/u.test(entry.name))
      .map((entry) => path.join(baseDir, entry.name))
      .sort();
  }

  function recoverContributionTransactionsUnlocked() {
    const outcomes = [];
    for (const targetStateDir of projectStateDirectoriesUnlocked()) {
      for (const { filePath, transaction } of readContributionTransactionsUnlocked(targetStateDir)) {
        if (["committed", "revoked", "failed-closed"].includes(transaction.intent.state)) continue;
        outcomes.push(recoverContributionTransactionUnlocked(filePath, transaction, targetStateDir));
      }
    }
    return {
      ok: outcomes.every((item) => item.ok),
      recovered: outcomes.filter((item) => item.ok && item.state === "committed").length,
      failed: outcomes.filter((item) => !item.ok).length,
      outcomes,
    };
  }

  function contributionInputMatches(transaction, input) {
    const intent = transaction.intent;
    const contribution = transaction.contribution;
    let firstSeenDay;
    let lastSeenDay;
    try {
      firstSeenDay = new Date(input.firstSeenAt).toISOString().slice(0, 10);
      lastSeenDay = new Date(input.lastSeenAt).toISOString().slice(0, 10);
    } catch {
      return false;
    }
    return intent.incidentId === input.incidentId
      && intent.capsuleId === input.capsuleId
      && intent.clusterId === input.clusterId
      && intent.evidenceDomainId === input.evidenceDomainId
      && contribution.claimType === input.claimType
      && contribution.receiptType === input.receiptType
      && contribution.signatureHash === String(input.signatureHash).toLowerCase()
      && contribution.occurrenceCount === input.occurrenceCount
      && contribution.firstSeenDay === firstSeenDay
      && contribution.lastSeenDay === lastSeenDay;
  }

  function publishContribution(input, { automationStamp = null } = {}) {
    try {
      return withMutationLock(() => {
        if (!input || typeof input !== "object" || Array.isArray(input)
            || Object.keys(input).some((key) => !CONTRIBUTION_INPUT_FIELDS.includes(key))
            || CONTRIBUTION_INPUT_FIELDS.some((key) => !(key in input))) {
          return { ok: false, reason: "invalid-contribution-input" };
        }
        const automation = automationStamp === null
          ? null
          : assertAutomationStampUnlocked(automationStamp);
        const recovered = recoverContributionTransactionsUnlocked();
        if (!recovered.ok) return { ok: false, reason: "contribution-recovery-failed" };
        const settings = getSettingsUnlocked();
        const consent = automation?.global.consent ?? settings.global.consent;
        // The privacy guard enforces the full three-bit contribution authority
        // (durableObservations + sanitizedExcerpts + crossRepoAggregation) at the
        // public creation boundary. This primitive rechecks the two
        // publication-specific bits as defense-in-depth; durableObservations is
        // captured in the intent's consent-version stamp and enforced on recovery.
        if (!consent.sanitizedExcerpts) return { ok: false, reason: "sanitized-excerpts-consent-required" };
        if (!consent.crossRepoAggregation) return { ok: false, reason: "cross-repo-consent-required" };

        const existing = readContributionTransactionsUnlocked().filter(({ transaction }) => transaction.intent.incidentId === input.incidentId);
        if (existing.length > 1) throw new Error("contribution-incident-conflict");
        if (existing.length === 1) {
          const item = existing[0];
          if (!contributionInputMatches(item.transaction, input)) return { ok: false, reason: "contribution-incident-conflict" };
          if (item.transaction.intent.state !== "committed") {
            const resumed = recoverContributionTransactionUnlocked(item.filePath, item.transaction, stateDir);
            if (!resumed.ok) return resumed;
            if (resumed.intent.state !== "committed") return { ok: false, reason: `contribution-intent-${resumed.intent.state}` };
            return { ...resumed, duplicate: true };
          }
          const link = contributionLinkFor(item.transaction.intent, item.transaction.intent.createdAt);
          return { ok: true, duplicate: true, contribution: item.transaction.contribution, intent: item.transaction.intent, link };
        }

        const capsules = readEvidenceCapsulesUnlocked();
        const capsule = capsules.find((item) => item.capsuleId === input.capsuleId && item.incidentId === input.incidentId);
        if (!capsule || capsule.expiresAt <= now()) return { ok: false, reason: "evidence-capsule-unavailable" };
        const cluster = readFileRecords(STORE_FILES.observation)
          .filter((record) => record.kind === "evidence-cluster" && record.payload.id === input.clusterId)
          .at(-1)?.payload;
        if (!cluster || cluster.projectFingerprint !== projectFingerprint
            || cluster.receiptType !== input.receiptType || !cluster.incidentIds.includes(input.incidentId)) {
          return { ok: false, reason: "contribution-cluster-binding-mismatch" };
        }
        const linkedObservations = readFileRecords(STORE_FILES.observation)
          .filter((record) => record.kind === "observation" && record.payload.incidentId === input.incidentId)
          .map((record) => record.payload);
        const identityFirewallValues = [...new Set([
          capsule.summaryHash,
          cluster.scopeFingerprint,
          ...linkedObservations.flatMap((item) => [
            item.id,
            item.sessionLineageHash,
            item.rootLineageHash,
            item.structuredFields?.scopeFingerprint,
          ].filter(Boolean)),
        ])].sort();

        const createdAt = now();
        const contributionId = randomUUID();
        const intentId = randomUUID();
        const contribution = makeGlobalContribution({
          contributionId,
          claimType: input.claimType,
          receiptType: input.receiptType,
          signatureHash: input.signatureHash,
          occurrenceCount: input.occurrenceCount,
          firstSeenDay: new Date(input.firstSeenAt).toISOString().slice(0, 10),
          lastSeenDay: new Date(input.lastSeenAt).toISOString().slice(0, 10),
          createdAt,
          expiresAt: createdAt + (automation?.global.retentionDays ?? settings.global.retentionDays) * DAY_MS,
          ...(automation ? { automationGeneration: automation.epoch.generation } : {}),
        }, {
          forbiddenIdentityValues: [...new Set([
            projectFingerprint,
            input.incidentId,
            input.capsuleId,
            input.clusterId,
            input.evidenceDomainId,
          ].flatMap((value) => [value, hashContent(value), hashContent(JSON.stringify(value))]))],
        });
        const intent = makeContributionIntent({
          intentId,
          contributionId,
          incidentId: input.incidentId,
          capsuleId: input.capsuleId,
          clusterId: input.clusterId,
          evidenceDomainId: input.evidenceDomainId,
          consentVersionHash: evaluateContributionConsentVersion(consent),
          state: "allocated",
          createdAt,
          updatedAt: createdAt,
          ...(automation ? { automationGeneration: automation.epoch.generation } : {}),
        });
        const transaction = validateContributionTransaction({
          schemaVersion: intent.schemaVersion,
          intent,
          contribution,
          identityFirewallValues,
        }, projectFingerprint);
        const intentPath = contributionRecordPath(contributionIntentsDir, intent.intentId);
        const globalPath = contributionRecordPath(contributionsDir, contribution.contributionId);
        const link = contributionLinkFor(intent, createdAt);
        const linkPath = contributionRecordPath(contributionLinksDir, contribution.contributionId);
        let finalIntent = transitionContributionIntent(intent, "published", createdAt);
        finalIntent = transitionContributionIntent(finalIntent, "linked", createdAt);
        finalIntent = transitionContributionIntent(finalIntent, "committed", createdAt);
        const finalTransaction = { ...transaction, intent: finalIntent };
        assertGlobalQuotaUnlocked(new Map([[path.resolve(globalPath), json(contribution)]]));
        assertProjectQuotaUnlocked(new Map([
          [path.resolve(intentPath), json(finalTransaction)],
          [path.resolve(linkPath), json(link)],
        ]));
        injectFault("contribution-before-intent-write", { contributionId });
        atomicProjectWrite(intentPath, json(transaction));
        injectFault("contribution-after-intent-write", { contributionId });
        const published = recoverContributionTransactionUnlocked(intentPath, transaction, stateDir);
        if (!published.ok) return published;
        return { ...published, duplicate: false };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "contribution-publication-failed") };
    }
  }

  function readContributions({ scope = "global", includeExpired = false, nowMs = now() } = {}) {
    return withMutationLock(() => {
      if (!new Set(["global", "project"]).has(scope)) throw new TypeError("invalid-contribution-scope");
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("invalid-retention-time");
      const recovered = recoverContributionTransactionsUnlocked();
      if (!recovered.ok) throw new Error("contribution-recovery-failed");
      const projectIds = scope === "project"
        ? new Set(readContributionLinksUnlocked().filter(({ link }) => link.state === "active").map(({ link }) => link.contributionId))
        : null;
      return readGlobalContributionsUnlocked()
        .map(({ contribution }) => contribution)
        .filter((contribution) => (includeExpired || contribution.expiresAt > nowMs)
          && (!projectIds || projectIds.has(contribution.contributionId)));
    });
  }

  function readContributionIntents() {
    return withMutationLock(() => {
      const recovered = recoverContributionTransactionsUnlocked();
      if (!recovered.ok) throw new Error("contribution-recovery-failed");
      return readContributionTransactionsUnlocked().map(({ transaction }) => transaction.intent);
    });
  }

  function readContributionLinks() {
    return withMutationLock(() => {
      const recovered = recoverContributionTransactionsUnlocked();
      if (!recovered.ok) throw new Error("contribution-recovery-failed");
      return readContributionLinksUnlocked().map(({ link }) => link);
    });
  }

  function retainContributionsUnlocked(nowMs) {
    const recovery = recoverContributionTransactionsUnlocked();
    if (!recovery.ok) throw new Error("contribution-recovery-failed");
    const globalRecords = readGlobalContributionsUnlocked();
    const keptIds = new Set(globalRecords
      .filter(({ contribution }) => contribution.expiresAt > nowMs)
      .map(({ contribution }) => contribution.contributionId));
    let contributions = 0;
    for (const { filePath, contribution } of globalRecords) {
      if (keptIds.has(contribution.contributionId)) continue;
      rmSync(filePath, { force: true });
      contributions += 1;
    }
    let contributionIntents = 0;
    let contributionLinks = 0;
    for (const targetStateDir of projectStateDirectoriesUnlocked()) {
      for (const { filePath, transaction } of readContributionTransactionsUnlocked(targetStateDir)) {
        if (keptIds.has(transaction.intent.contributionId) || transaction.contribution.expiresAt > nowMs) continue;
        rmSync(filePath, { force: true });
        contributionIntents += 1;
      }
      for (const { filePath, link } of readContributionLinksUnlocked(targetStateDir)) {
        if (keptIds.has(link.contributionId)) continue;
        rmSync(filePath, { force: true });
        contributionLinks += 1;
      }
    }
    return { contributions, contributionIntents, contributionLinks };
  }

  function purgeProjectContributionsUnlocked(targetStateDir = stateDir) {
    const contributionIds = new Set(
      readContributionTransactionsUnlocked(targetStateDir).map(({ transaction }) => transaction.intent.contributionId),
    );
    for (const { id } of contributionFiles(path.join(targetStateDir, "contribution-links"))) contributionIds.add(id);
    let contributions = 0;
    for (const contributionId of contributionIds) {
      const filePath = contributionRecordPath(contributionsDir, contributionId);
      if (!existsSync(filePath)) continue;
      rmSync(filePath, { force: true });
      contributions += 1;
    }
    rmSync(path.join(targetStateDir, "contribution-intents"), { recursive: true, force: true });
    rmSync(path.join(targetStateDir, "contribution-links"), { recursive: true, force: true });
    return contributions;
  }

  function globalHashRecordPath(directory, id) {
    const value = String(id).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("invalid-global-record-id");
    return path.join(directory, value.slice(0, 2), `${value}.json`);
  }

  function globalHashRecordFiles(directory, label) {
    return safeTreeFiles(directory).map((filePath) => {
      const parts = path.relative(directory, filePath).split(path.sep);
      const id = parts[1]?.slice(0, -".json".length);
      if (parts.length !== 2 || !/^[a-f0-9]{2}$/u.test(parts[0])
          || !/^[a-f0-9]{64}\.json$/u.test(parts[1]) || parts[0] !== id.slice(0, 2)) {
        throw new Error(`${label}-storage-path-rejected`);
      }
      return { filePath, id };
    }).sort((left, right) => left.id.localeCompare(right.id));
  }

  function readGlobalCandidatesUnlocked() {
    return globalHashRecordFiles(globalCandidatesDir, "global-candidate").flatMap(({ filePath, id }) => {
      const result = readReloadSafeGlobalRecord(filePath, MAX_GLOBAL_CANDIDATE_RECORD_BYTES, makeGlobalCandidate, "global-candidate");
      if (result.unsafe) { quarantineReloadedGlobalRecord(filePath, result); return []; }
      const candidate = result.record;
      if (candidate.candidateId !== id) throw new Error("global-candidate-path-mismatch");
      return [{ filePath, candidate }];
    });
  }

  function readGlobalSupportSetsUnlocked() {
    return globalHashRecordFiles(globalSupportSetsDir, "global-support-set").flatMap(({ filePath, id }) => {
      const result = readReloadSafeGlobalRecord(filePath, MAX_GLOBAL_CANDIDATE_RECORD_BYTES, makeGlobalSupportSet, "global-support-set");
      if (result.unsafe) { quarantineReloadedGlobalRecord(filePath, result); return []; }
      const supportSet = result.record;
      if (supportSet.supportSetHash !== id) throw new Error("global-support-set-path-mismatch");
      return [{ filePath, supportSet }];
    });
  }

  function projectObservationRecordsUnlocked(targetStateDir) {
    const filePath = path.join(targetStateDir, STORE_FILES.observation);
    if (!existsSync(filePath)) return [];
    const parsed = parseJsonlSource(readFileSync(filePath, "utf8"), assertRecord);
    if (parsed.damaged.length) throw new Error("corrupt-project-candidate-evidence");
    return parsed.records;
  }

  function candidateSupportFactsUnlocked(nowMs) {
    const contributions = new Map(readGlobalContributionsUnlocked()
      .filter(({ contribution }) => contribution.expiresAt > nowMs)
      .map(({ contribution }) => [contribution.contributionId, contribution]));
    const facts = [];
    for (const targetStateDir of projectStateDirectoriesUnlocked()) {
      const targetFingerprint = path.basename(targetStateDir);
      const transactions = new Map(readContributionTransactionsUnlocked(targetStateDir)
        .filter(({ transaction }) => transaction.intent.state === "committed")
        .map(({ transaction }) => [transaction.intent.contributionId, transaction]));
      const records = projectObservationRecordsUnlocked(targetStateDir);
      const observations = records.filter((record) => record.kind === "observation").map((record, sequence) => ({ value: record.payload, sequence }));
      const clusters = new Map();
      for (const record of records) {
        if (record.kind === "evidence-cluster") clusters.set(record.payload.id, record.payload);
      }
      const clusterIntegrity = new Map();
      const integrityFor = (cluster) => {
        if (!cluster) return { contradictionFree: false, injectionFree: false, chronologyValid: false, correlationValid: false };
        let current = clusterIntegrity.get(cluster.id);
        if (current) return current;
        const linked = observations.filter(({ value }) => cluster.incidentIds.includes(value.incidentId));
        const outcomes = new Set(linked.map(({ value }) => value.structuredFields?.deterministicOutcome).filter((value) => typeof value === "boolean"));
        let lastCreatedAt = null;
        let chronologyValid = true;
        for (const { value } of linked) {
          if (lastCreatedAt !== null && value.createdAt < lastCreatedAt) chronologyValid = false;
          lastCreatedAt = value.createdAt;
        }
        current = {
          contradictionFree: outcomes.size <= 1,
          injectionFree: linked.every(({ value }) => value.injectionFlagged === false),
          chronologyValid,
          correlationValid: linked.length === cluster.incidentIds.length
            && new Set(linked.map(({ value }) => value.incidentId)).size === cluster.incidentIds.length,
        };
        clusterIntegrity.set(cluster.id, current);
        return current;
      };
      for (const { link } of readContributionLinksUnlocked(targetStateDir)) {
        if (link.state !== "active") continue;
        const transaction = transactions.get(link.contributionId);
        const contribution = contributions.get(link.contributionId);
        if (!transaction || !contribution) continue;
        const intent = transaction.intent;
        const localBindingValid = intent.intentId === link.intentId
          && intent.incidentId === link.incidentId
          && intent.capsuleId === link.capsuleId
          && intent.clusterId === link.clusterId
          && intent.evidenceDomainId === link.evidenceDomainId
          && intent.automationGeneration === link.automationGeneration
          && intent.automationGeneration === contribution.automationGeneration;
        const cluster = clusters.get(link.clusterId) ?? null;
        const matching = observations.filter(({ value }) => value.incidentId === link.incidentId);
        const selected = matching[0]?.value ?? null;
        const exactObservation = matching.length === 1
          && selected.projectFingerprint === targetFingerprint
          && selected.receiptIds.includes(contribution.signatureHash)
          && selected.structuredFields?.receiptType === contribution.receiptType
          && selected.structuredFields?.scopeFingerprint === cluster?.scopeFingerprint
          && (selected.structuredFields?.targetLogicalName ?? null) === (cluster?.targetLogicalName ?? null)
          && selected.automationGeneration === contribution.automationGeneration;
        const integrity = integrityFor(cluster);
        facts.push({
          claimType: contribution.claimType,
          receiptType: contribution.receiptType,
          signatureHash: contribution.signatureHash,
          targetLogicalName: cluster?.targetLogicalName ?? null,
          contributionId: contribution.contributionId,
          evidenceDomainId: link.evidenceDomainId,
          incidentId: link.incidentId,
          occurrenceCount: contribution.occurrenceCount,
          observedAt: selected?.createdAt ?? contribution.createdAt,
          firstSeenDay: contribution.firstSeenDay,
          lastSeenDay: contribution.lastSeenDay,
          expiresAt: contribution.expiresAt,
          automationGeneration: contribution.automationGeneration,
          rootLineageHash: selected?.rootLineageHash ?? UNKNOWN_ROOT_LINEAGE_HASH,
          originKind: selected?.originKind ?? "unknown",
          contradictionFree: localBindingValid && integrity.contradictionFree,
          injectionFree: localBindingValid && exactObservation && integrity.injectionFree,
          chronologyValid: localBindingValid && integrity.chronologyValid,
          correlationValid: localBindingValid && exactObservation && integrity.correlationValid
            && cluster?.projectFingerprint === targetFingerprint
            && cluster?.receiptType === contribution.receiptType
            && cluster?.incidentIds.includes(link.incidentId),
          privateIdentityValues: [
            targetFingerprint,
            link.incidentId,
            link.capsuleId,
            link.clusterId,
            link.evidenceDomainId,
            selected?.id,
            selected?.sessionLineageHash,
            selected?.rootLineageHash,
          ].filter(Boolean),
        });
      }
    }
    return facts;
  }

  function candidateIdentityFirewallValues(facts) {
    return [...new Set(facts.flatMap((fact) => fact.privateIdentityValues)
      .flatMap((value) => [value, hashContent(value), hashContent(JSON.stringify(value))]))];
  }

  function sameCanonicalRecord(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function materializeGlobalCandidatesUnlocked({ targetBindings, rootPolicy, nowMs, automationStamp = null }) {
    if (!Array.isArray(targetBindings) || targetBindings.length === 0) throw new Error("candidate-target-bindings-required");
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid-candidate-materialization-time");
    const policy = makeGlobalRootPolicy(rootPolicy);
    const bindings = [...new Map(targetBindings.map((value) => {
      const binding = makeCandidateTargetBinding(value, policy);
      return [binding.bindingHash, binding];
    })).values()];
    const byTarget = new Map();
    for (const binding of bindings) {
      const key = binding.targetKind === "new-global-skill" ? null : binding.logicalName;
      if (byTarget.has(key) && byTarget.get(key).bindingHash !== binding.bindingHash) throw new Error("candidate-target-binding-conflict");
      byTarget.set(key, binding);
    }
    const automation = automationStamp === null
      ? null
      : assertAutomationStampUnlocked(automationStamp);
    const facts = candidateSupportFactsUnlocked(nowMs).filter((fact) =>
      byTarget.has(fact.targetLogicalName)
      && (!automation || fact.automationGeneration === automation.epoch.generation));
    const groups = new Map();
    for (const fact of facts) {
      const targetBinding = byTarget.get(fact.targetLogicalName);
      const key = [fact.claimType, fact.receiptType, fact.signatureHash, targetBinding.bindingHash].join("\n");
      const group = groups.get(key) ?? { targetBinding, facts: [] };
      group.facts.push(fact);
      groups.set(key, group);
    }
    const existingCandidates = new Map(readGlobalCandidatesUnlocked().map((item) => [item.candidate.candidateId, item]));
    const existingSupportSets = new Map(readGlobalSupportSetsUnlocked().map((item) => [item.supportSet.supportSetHash, item]));
    const produced = new Set();
    const output = [];
    const supportOutput = [];
    const changes = new Map();
    for (const group of groups.values()) {
      const summary = summarizeGlobalCandidateSupport(group.facts, {
        nowMs,
        retentionMs: getSettingsUnlocked().global.retentionDays * DAY_MS,
      });
      const identityOptions = { forbiddenIdentityValues: candidateIdentityFirewallValues(group.facts) };
      const skeleton = makeGlobalCandidate({
        claimType: group.facts[0].claimType,
        receiptType: group.facts[0].receiptType,
        signatureHash: group.facts[0].signatureHash,
        targetBindingHash: group.targetBinding.bindingHash,
        supportSetHash: "0".repeat(64),
        state: "collecting",
        eligibilityRoute: null,
        independentDomainCount: summary.independentDomainCount,
        independentIncidentCount: summary.independentIncidentCount,
        occurrenceCount: summary.occurrenceCount,
        firstSeenDay: summary.firstSeenDay,
        lastSeenDay: summary.lastSeenDay,
        createdAt: nowMs,
        updatedAt: nowMs,
        ...(automation ? { automationGeneration: automation.epoch.generation } : {}),
      }, identityOptions);
      let supportSet = makeGlobalSupportSet({
        candidateId: skeleton.candidateId,
        targetBinding: group.targetBinding,
        contributionIds: summary.contributionIds,
        strongestSingleDomain: summary.strongestSingleDomain,
        distributed: summary.distributed,
        integrity: summary.integrity,
        firstSeenDay: summary.firstSeenDay,
        lastSeenDay: summary.lastSeenDay,
        evaluatedAt: nowMs,
        expiresAt: summary.expiresAt,
        ...(automation ? { automationGeneration: automation.epoch.generation } : {}),
      }, identityOptions);
      const persistedSupport = existingSupportSets.get(supportSet.supportSetHash)?.supportSet;
      if (persistedSupport) supportSet = persistedSupport;
      const eligibility = evaluateGlobalSupportEligibility(supportSet, policy);
      const existing = existingCandidates.get(skeleton.candidateId)?.candidate ?? null;
      let candidate;
      if (existing && (["recommended", "superseded"].includes(existing.state)
          || (["no-change", "rejected", "failed-closed"].includes(existing.state) && existing.supportSetHash === supportSet.supportSetHash))) {
        candidate = existing;
      } else {
        const state = eligibility.eligible ? "eligible" : "collecting";
        const proposed = makeGlobalCandidate({
          ...skeleton,
          supportSetHash: supportSet.supportSetHash,
          state,
          eligibilityRoute: eligibility.route,
          createdAt: existing?.createdAt ?? nowMs,
          updatedAt: nowMs,
        }, identityOptions);
        candidate = existing && sameCanonicalRecord({ ...proposed, updatedAt: existing.updatedAt }, existing)
          ? existing
          : proposed;
      }
      produced.add(candidate.candidateId);
      output.push(candidate);
      supportOutput.push(supportSet);
      const supportPath = globalHashRecordPath(globalSupportSetsDir, supportSet.supportSetHash);
      if (!existsSync(supportPath)) changes.set(path.resolve(supportPath), json(supportSet));
      const candidatePath = globalHashRecordPath(globalCandidatesDir, candidate.candidateId);
      if (!existing || !sameCanonicalRecord(existing, candidate)) changes.set(path.resolve(candidatePath), json(candidate));
    }
    const bindingHashes = new Set(bindings.map((binding) => binding.bindingHash));
    for (const { filePath, candidate } of existingCandidates.values()) {
      if (produced.has(candidate.candidateId) || !bindingHashes.has(candidate.targetBindingHash)
          || !["collecting", "eligible", "synthesis-pending"].includes(candidate.state)) continue;
      changes.set(path.resolve(filePath), null);
    }
    assertGlobalQuotaUnlocked(changes);
    let appliedChanges = 0;
    for (const [filePath, source] of changes) {
      if (source === null) rmSync(filePath, { force: true });
      else atomicWrite(filePath, source);
      appliedChanges += 1;
      // Materialization is a recomputable projection of the current facts, so a
      // crash between two change writes must converge on the next pass instead
      // of leaving a half-written support/candidate pair behind.
      injectFault("global-candidate-after-change", { applied: appliedChanges, total: changes.size });
    }
    return {
      ok: true,
      candidates: output.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
      supportSets: supportOutput.sort((left, right) => left.supportSetHash.localeCompare(right.supportSetHash)),
      changed: changes.size,
    };
  }

  function materializeGlobalCandidates({ targetBindings, rootPolicy, nowMs = now(), automationStamp = null } = {}) {
    try {
      return withMutationLock(() => materializeGlobalCandidatesUnlocked({ targetBindings, rootPolicy, nowMs, automationStamp }));
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-candidate-materialization-failed"), candidates: [], supportSets: [], changed: 0 };
    }
  }

  function readGlobalCandidates() {
    return withMutationLock(() => readGlobalCandidatesUnlocked().map(({ candidate }) => candidate));
  }

  function readGlobalSupportSets() {
    return withMutationLock(() => readGlobalSupportSetsUnlocked().map(({ supportSet }) => supportSet));
  }

  function transitionGlobalCandidate(candidateId, change, nowMs = now()) {
    try {
      return withMutationLock(() => {
        const current = readGlobalCandidatesUnlocked().find(({ candidate }) => candidate.candidateId === candidateId);
        if (!current) return { ok: false, reason: "global-candidate-not-found" };
        const candidate = transitionGlobalCandidateState(current.candidate, change, nowMs);
        const source = json(candidate);
        assertGlobalQuotaUnlocked(new Map([[path.resolve(current.filePath), source]]));
        atomicWrite(current.filePath, source);
        return { ok: true, candidate };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-candidate-transition-failed") };
    }
  }

  function recomputePendingGlobalCandidatesUnlocked(nowMs) {
    recoverGlobalLifecycleInvalidationsUnlocked();
    const policy = getSettingsUnlocked().global.globalRootPolicy;
    let supportRecords = readGlobalSupportSetsUnlocked();
    let candidates = readGlobalCandidatesUnlocked();
    const invalidBindingHashes = new Set();
    for (const { supportSet } of supportRecords) {
      try {
        if (!policy) throw new Error("global-root-policy-required");
        makeCandidateTargetBinding(supportSet.targetBinding, policy);
      } catch {
        invalidBindingHashes.add(supportSet.targetBinding.bindingHash);
      }
    }
    for (const { filePath, candidate } of candidates) {
      if (invalidBindingHashes.has(candidate.targetBindingHash)
          && ["collecting", "eligible", "synthesis-pending"].includes(candidate.state)) {
        rmSync(filePath, { force: true });
      }
    }
    // Maintenance and purge may remove the contributions underlying an
    // unfinished candidate. Delete that now-inert projection; never recompute
    // it from remaining historical evidence here, because doing so would
    // backfill automatic work outside a freshly stamped live pipeline cycle.
    const storedContributionIds = new Set(readGlobalContributionsUnlocked().map(({ contribution }) => contribution.contributionId));
    const supportByHash = new Map(supportRecords.map(({ supportSet }) => [supportSet.supportSetHash, supportSet]));
    for (const { filePath, candidate } of readGlobalCandidatesUnlocked()) {
      if (!["collecting", "eligible", "synthesis-pending"].includes(candidate.state)) continue;
      const supportSet = supportByHash.get(candidate.supportSetHash);
      if (!supportSet || supportSet.contributionIds.some((contributionId) => !storedContributionIds.has(contributionId))) {
        rmSync(filePath, { force: true });
      }
    }
    candidates = readGlobalCandidatesUnlocked();
    supportRecords = readGlobalSupportSetsUnlocked();
    // Retention and purge maintenance may delete or invalidate support, but it
    // must never create work. Candidate creation is admitted only by the live
    // automatic pipeline with a freshly checked generation stamp; otherwise a
    // later maintenance pass could backfill evidence collected before Off.
    const retainedCandidateSupport = new Set(readGlobalCandidatesUnlocked().map(({ candidate }) => candidate.supportSetHash));
    const retainedRecommendationSupport = new Set(readGlobalRecommendationsUnlocked()
      .map(({ recommendation }) => recommendation.supportSetHash));
    // A recompute follows a purge or a retention pass that can remove the
    // contributions a support set was built from. Superseded support sets that
    // nothing references are reclaimed here so purged evidence leaves no
    // dangling global reference and no unbounded storage.
    let expiredSupportSets = 0;
    for (const { filePath, supportSet } of readGlobalSupportSetsUnlocked()) {
      if (retainedCandidateSupport.has(supportSet.supportSetHash)
          || retainedRecommendationSupport.has(supportSet.supportSetHash)) continue;
      const missingContribution = supportSet.contributionIds.some((contributionId) => !storedContributionIds.has(contributionId));
      if (supportSet.expiresAt > nowMs && !missingContribution) continue;
      rmSync(filePath, { force: true });
      expiredSupportSets += 1;
    }
    const invalidatedRecommendations = invalidateStaleGlobalRecommendationsUnlocked(nowMs);
    return { expiredSupportSets, invalidatedRecommendations };
  }

  function globalLeasePath(leaseKeyHash) {
    const value = String(leaseKeyHash).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("invalid-global-lease-key");
    return path.join(globalLeasesDir, value.slice(0, 2), `${value}.json`);
  }

  function globalLeaseFilesUnlocked() {
    return safeTreeFiles(globalLeasesDir).map((filePath) => {
      const parts = path.relative(globalLeasesDir, filePath).split(path.sep);
      const leaseKeyHash = parts[1]?.slice(0, -".json".length);
      if (parts.length !== 2 || !/^[a-f0-9]{2}$/u.test(parts[0])
          || !/^[a-f0-9]{64}\.json$/u.test(parts[1]) || parts[0] !== leaseKeyHash.slice(0, 2)) {
        throw new Error("global-lease-storage-path-rejected");
      }
      return { filePath, leaseKeyHash };
    }).sort((left, right) => left.leaseKeyHash.localeCompare(right.leaseKeyHash));
  }

  function readGlobalLeaseUnlocked(leaseKeyHash) {
    const filePath = globalLeasePath(leaseKeyHash);
    if (!existsSync(filePath)) return null;
    const result = readReloadSafeGlobalRecord(filePath, MAX_CONTRIBUTION_RECORD_BYTES, makeGlobalLease, "global-lease");
    if (result.unsafe) { quarantineReloadedGlobalRecord(filePath, result); return null; }
    const lease = result.record;
    if (lease.leaseKeyHash !== String(leaseKeyHash).toLowerCase()) throw new Error("global-lease-path-mismatch");
    return { filePath, lease };
  }

  function acquireGlobalLeaseUnlocked(request, acquiredAt) {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).sort().join(",") !== "leaseKeyHash,leaseKind,ttlMs") {
      return { ok: false, reason: "invalid-global-lease-request" };
    }
    if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > 3_600_000) {
      return { ok: false, reason: "invalid-global-lease-ttl" };
    }
    const lease = makeGlobalLease({
      leaseId: randomUUID(),
      leaseKind: request.leaseKind,
      leaseKeyHash: request.leaseKeyHash,
      ownerToken: randomUUID(),
      state: "active",
      acquiredAt,
      expiresAt: acquiredAt + request.ttlMs,
      releasedAt: null,
    });
    const existing = readGlobalLeaseUnlocked(lease.leaseKeyHash);
    if (existing?.lease.state === "active" && existing.lease.expiresAt > acquiredAt) {
      return { ok: false, reason: "global-lease-busy" };
    }
    if (lease.leaseKind === "candidate-synthesis") {
      const settings = getSettingsUnlocked();
      const limit = Math.min(
        settings.global.budgets.concurrentSynthesesGlobal,
        settings.repo.budgets.concurrentSynthesesGlobal ?? settings.global.budgets.concurrentSynthesesGlobal,
      );
      const active = globalLeaseFilesUnlocked().filter(({ leaseKeyHash }) => {
        if (leaseKeyHash === lease.leaseKeyHash) return false;
        const current = readGlobalLeaseUnlocked(leaseKeyHash)?.lease;
        return current?.leaseKind === "candidate-synthesis"
          && current.state === "active" && current.expiresAt > acquiredAt;
      }).length;
      if (active >= limit) return { ok: false, reason: "global-synthesis-concurrency-exhausted" };
    }
    if (existing?.lease.state === "active") {
      atomicWrite(existing.filePath, json(transitionGlobalLease(existing.lease, "expired", acquiredAt)));
    }
    if (existing) rmSync(existing.filePath, { force: true });
    const filePath = globalLeasePath(lease.leaseKeyHash);
    assertGlobalQuotaUnlocked(new Map([[path.resolve(filePath), json(lease)]]));
    exclusiveJsonWrite(filePath, lease, makeGlobalLease, "global-lease");
    return { ok: true, lease };
  }

  function acquireGlobalLease(request, { automationStamp = null } = {}) {
    try {
      return withMutationLock(() => {
        if (automationStamp != null) assertAutomationStampUnlocked(automationStamp);
        return acquireGlobalLeaseUnlocked(request, now());
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-lease-acquire-failed") };
    }
  }

  function releaseGlobalLease(request) {
    try {
      return withMutationLock(() => {
        const keys = Object.keys(request ?? {}).sort().join(",");
        if (!request || typeof request !== "object" || Array.isArray(request)
            || !["leaseKeyHash,ownerToken", "leaseKeyHash,nowMs,ownerToken"].includes(keys)) {
          return { ok: false, reason: "invalid-global-lease-release" };
        }
        const releasedAt = request.nowMs ?? now();
        if (!Number.isSafeInteger(releasedAt) || releasedAt < 0) return { ok: false, reason: "invalid-global-lease-release-time" };
        const existing = readGlobalLeaseUnlocked(request.leaseKeyHash);
        if (!existing) return { ok: false, reason: "global-lease-not-found" };
        if (existing.lease.state !== "active") return { ok: false, reason: "global-lease-not-active" };
        if (existing.lease.ownerToken !== request.ownerToken) return { ok: false, reason: "global-lease-owner-mismatch" };
        const lease = transitionGlobalLease(existing.lease, "released", releasedAt);
        atomicWrite(existing.filePath, json(lease));
        return { ok: true, lease };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-lease-release-failed") };
    }
  }

  function getGlobalLease(leaseKeyHash) {
    return withMutationLock(() => readGlobalLeaseUnlocked(leaseKeyHash)?.lease ?? null);
  }

  // Renewable generation-fenced target lease (H9-002). A target-write lease is
  // authoritative immediately adjacent to every filesystem effect only if it is
  // still owned by the renewing owner and has not expired at the renewal
  // instant. Renewal rotates the opaque ownerToken (the lease "generation") and
  // extends the expiry under the mutation lock, so a peer that acquired the
  // lease after this owner expired is observed here: the on-disk ownerToken no
  // longer matches and renewal fails closed BEFORE any skill effect. The lease
  // identity (leaseId/leaseKeyHash) is preserved across renewals of the same
  // logical lease; only the authorizing generation (ownerToken) rotates.
  function renewGlobalLease(request) {
    try {
      return withMutationLock(() => {
        if (!request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).sort().join(",") !== "leaseKeyHash,nowMs,ownerToken,ttlMs"
            || !Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
          return { ok: false, reason: "invalid-global-lease-renew" };
        }
        if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > 3_600_000) {
          return { ok: false, reason: "invalid-global-lease-ttl" };
        }
        const existing = readGlobalLeaseUnlocked(request.leaseKeyHash);
        if (!existing) return { ok: false, reason: "global-lease-not-found" };
        const current = existing.lease;
        // Reject a stale owner BEFORE any effect: the renewing caller must still
        // be the live active owner and the lease must not have expired. A peer
        // that force-acquired after expiry has a different ownerToken; an
        // unexpired-by-time owner that no longer holds the lease is rejected by
        // the ownerToken comparison. Either way this returns closed.
        if (current.state !== "active" || current.ownerToken !== request.ownerToken
            || current.expiresAt <= request.nowMs) {
          return { ok: false, reason: "global-target-lease-invalid" };
        }
        const renewed = makeGlobalLease({
          leaseId: current.leaseId,
          leaseKind: current.leaseKind,
          leaseKeyHash: current.leaseKeyHash,
          ownerToken: randomUUID(),
          state: "active",
          acquiredAt: request.nowMs,
          expiresAt: request.nowMs + request.ttlMs,
          releasedAt: null,
        });
        // Namespace-durable in-place replacement of the lease file: renewal
        // rotates the authorizing generation (ownerToken) and extends the
        // expiry over the existing lease record via a durable rename.
        atomicWrite(existing.filePath, json(renewed));
        return { ok: true, lease: renewed };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-lease-renew-failed") };
    }
  }

  // Request/consumer deadline admission (H10-001). Immutable request and
  // consumer deadlines are carried into durable decision admission and compared
  // against the real admission timestamp without clamping. A request that
  // expired after consumption but before admission fails closed here, before any
  // intent, recommendation, or decision write.
  function assertDecisionDeadlinesUnlocked(nowMs, requestDeadline, consumerDeadline) {
    if (Number.isSafeInteger(requestDeadline) && nowMs >= requestDeadline) throw new Error("global-request-expired");
    if (Number.isSafeInteger(consumerDeadline) && nowMs >= consumerDeadline) throw new Error("global-consumer-claim-expired");
  }

  function extractDecisionDeadlines(request) {
    const requestDeadline = request?.requestDeadline;
    const consumerDeadline = request?.consumerDeadline;
    if (requestDeadline !== undefined && (!Number.isSafeInteger(requestDeadline) || requestDeadline < 0)) {
      throw new Error("invalid-global-decision-deadline");
    }
    if (consumerDeadline !== undefined && (!Number.isSafeInteger(consumerDeadline) || consumerDeadline < 0)) {
      throw new Error("invalid-global-decision-deadline");
    }
    return { requestDeadline, consumerDeadline };
  }

  function globalOpaqueRecordPath(directory, id) {
    const value = String(id).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
      throw new Error("invalid-global-opaque-record-id");
    }
    return path.join(directory, value.slice(0, 2), `${value}.json`);
  }

  function globalOpaqueRecordFiles(directory, label) {
    return safeTreeFiles(directory).map((filePath) => {
      const parts = path.relative(directory, filePath).split(path.sep);
      const id = parts[1]?.slice(0, -".json".length);
      if (parts.length !== 2 || !/^[a-f0-9]{2}$/u.test(parts[0])
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u.test(parts[1])
          || parts[0] !== id.slice(0, 2)) {
        throw new Error(`${label}-storage-path-rejected`);
      }
      return { filePath, id };
    }).sort((left, right) => left.id.localeCompare(right.id));
  }

  function readGlobalSynthesisAttemptsUnlocked() {
    return globalOpaqueRecordFiles(globalSynthesisAttemptsDir, "global-synthesis-attempt").flatMap(({ filePath, id }) => {
      const result = readReloadSafeGlobalRecord(filePath, MAX_GLOBAL_CANDIDATE_RECORD_BYTES, makeGlobalSynthesisAttempt, "global-synthesis-attempt");
      if (result.unsafe) { quarantineReloadedGlobalRecord(filePath, result); return []; }
      const attempt = result.record;
      if (attempt.attemptId !== id) throw new Error("global-synthesis-attempt-path-mismatch");
      return [{ filePath, attempt }];
    });
  }

  function readGlobalRecommendationsUnlocked() {
    return globalHashRecordFiles(globalRecommendationsDir, "global-recommendation").flatMap(({ filePath, id }) => {
      const result = readReloadSafeGlobalRecord(filePath, MAX_GLOBAL_RECOMMENDATION_RECORD_BYTES, makeGlobalRecommendation, "global-recommendation");
      if (result.unsafe) { quarantineReloadedGlobalRecord(filePath, result); return []; }
      const recommendation = result.record;
      if (recommendation.recommendationId !== id) throw new Error("global-recommendation-path-mismatch");
      return [{ filePath, recommendation }];
    });
  }

  function globalRecommendationSupportCurrentUnlocked(recommendation, nowMs, rootPolicy = null) {
    const supportSet = readGlobalSupportSetsUnlocked()
      .find(({ supportSet: item }) => item.supportSetHash === recommendation.supportSetHash)?.supportSet;
    const candidate = readGlobalCandidatesUnlocked()
      .find(({ candidate: item }) => item.candidateId === recommendation.candidateId)?.candidate;
    if (!supportSet || !candidate || supportSet.expiresAt <= nowMs
        || supportSet.candidateId !== recommendation.candidateId
        || supportSet.targetBinding.bindingHash !== recommendation.candidateTargetBindingHash
        || candidate.state !== "recommended"
        || candidate.supportSetHash !== recommendation.supportSetHash
        || candidate.targetBindingHash !== recommendation.candidateTargetBindingHash) return false;
    const activeContributionIds = new Set(candidateSupportFactsUnlocked(nowMs).map((fact) => fact.contributionId));
    if (supportSet.contributionIds.some((contributionId) => !activeContributionIds.has(contributionId))) return false;
    const policy = rootPolicy ?? getSettingsUnlocked().global.globalRootPolicy;
    if (!policy) return false;
    try { return evaluateGlobalSupportEligibility(supportSet, policy).eligible; }
    catch { return false; }
  }

  function globalLifecycleInvalidationPlanUnlocked(recommendationRecord, nowMs, persistedDecision = null) {
    const current = recommendationRecord.recommendation;
    const decision = persistedDecision ?? makeGlobalDecision({
      recommendationId: current.recommendationId,
      supportSetHash: current.supportSetHash,
      targetBindingHash: current.targetBinding.bindingHash,
      targetHash: current.targetBinding.currentHash,
      proposedContentHash: current.proposedContentHash,
      decisionVersion: current.decisionVersion + 1,
      actorRole: "policy",
      timestamp: Math.max(nowMs, current.synthesizedAt),
      nonce: `support-invalidated:${current.recommendationId}`,
      priorState: current.state,
      newState: "superseded",
    }, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() });
    if (decision.recommendationId !== current.recommendationId || decision.actorRole !== "policy"
        || decision.newState !== "superseded" || !["pending", "approved"].includes(decision.priorState)) {
      throw new Error("global-lifecycle-decision-invalid");
    }
    let recommendation = current;
    if (current.state === decision.priorState && current.decisionVersion + 1 === decision.decisionVersion) {
      const transitioned = transitionGlobalRecommendation(current, decision, Math.max(nowMs, decision.timestamp));
      if (!transitioned.ok) throw new Error(transitioned.error);
      recommendation = transitioned.state;
    } else if (current.state !== "superseded" || current.decisionVersion !== decision.decisionVersion
        || !current.burnedNonceHashes.includes(hashContent(decision.nonce))) {
      throw new Error("global-lifecycle-recommendation-conflict");
    }
    const candidateRecord = readGlobalCandidatesUnlocked()
      .find(({ candidate }) => candidate.candidateId === recommendation.candidateId);
    let candidate = candidateRecord?.candidate ?? null;
    if (candidate?.state === "recommended") {
      candidate = transitionGlobalCandidateState(candidate, {
        state: "superseded",
        supportSetHash: candidate.supportSetHash,
        eligibilityRoute: candidate.eligibilityRoute,
      }, Math.max(nowMs, decision.timestamp));
    } else if (candidate && candidate.state !== "superseded") {
      throw new Error("global-lifecycle-candidate-conflict");
    }
    const audit = makeGlobalAuditEvent({
      kind: "support-invalidated",
      recommendationId: recommendation.recommendationId,
      actorRole: "policy",
      timestamp: decision.timestamp,
      supportSetHash: recommendation.supportSetHash,
      targetBindingHash: recommendation.targetBinding.bindingHash,
      proposedContentHash: recommendation.proposedContentHash,
      decisionVersion: decision.decisionVersion,
      outcome: "succeeded",
    }, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() });
    const decisionPath = globalHashRecordPath(globalDecisionsDir, globalDecisionId(decision));
    const auditPath = globalHashRecordPath(globalAuditsDir, audit.auditId);
    const persistedAudit = readGlobalAuditsUnlocked().find(({ audit: item }) => item.auditId === audit.auditId)?.audit;
    if (persistedAudit && !sameCanonicalRecord(persistedAudit, audit)) throw new Error("global-lifecycle-audit-conflict");
    const changes = new Map();
    if (!persistedDecision) changes.set(path.resolve(decisionPath), json(decision));
    if (!sameCanonicalRecord(current, recommendation)) changes.set(path.resolve(recommendationRecord.filePath), json(recommendation));
    if (candidateRecord && !sameCanonicalRecord(candidateRecord.candidate, candidate)) changes.set(path.resolve(candidateRecord.filePath), json(candidate));
    if (!persistedAudit) changes.set(path.resolve(auditPath), json(audit));
    for (const { filePath } of readGlobalRecommendationChunksUnlocked(recommendation.recommendationId)) {
      changes.set(path.resolve(filePath), null);
    }
    return {
      recommendationRecord,
      recommendation,
      candidateRecord,
      candidate,
      decision,
      decisionPath,
      audit,
      auditPath,
      persistedDecision,
      persistedAudit,
      changes,
    };
  }

  function writeGlobalLifecycleInvalidationPlanUnlocked(plan) {
    if (!plan.persistedDecision) {
      exclusiveJsonWrite(
        plan.decisionPath,
        plan.decision,
        (value) => makeGlobalDecision(value, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() }),
        "global-lifecycle-decision",
        MAX_GLOBAL_DECISION_RECORD_BYTES,
      );
      injectFault("global-lifecycle-after-decision", { recommendationId: plan.recommendation.recommendationId });
    }
    if (!sameCanonicalRecord(plan.recommendationRecord.recommendation, plan.recommendation)) {
      atomicWrite(plan.recommendationRecord.filePath, json(plan.recommendation));
      injectFault("global-lifecycle-after-recommendation", { recommendationId: plan.recommendation.recommendationId });
    }
    if (plan.candidateRecord && !sameCanonicalRecord(plan.candidateRecord.candidate, plan.candidate)) {
      atomicWrite(plan.candidateRecord.filePath, json(plan.candidate));
      injectFault("global-lifecycle-after-candidate", { recommendationId: plan.recommendation.recommendationId });
    }
    if (!plan.persistedAudit) {
      exclusiveJsonWrite(
        plan.auditPath,
        plan.audit,
        (value) => makeGlobalAuditEvent(value, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() }),
        "global-lifecycle-audit",
        MAX_GLOBAL_DECISION_RECORD_BYTES,
      );
      injectFault("global-lifecycle-after-audit", { recommendationId: plan.recommendation.recommendationId });
    }
    for (const [filePath, source] of plan.changes) if (source === null) rmSync(filePath, { force: true });
    return plan.recommendation;
  }

  function recoverGlobalLifecycleInvalidationsUnlocked() {
    const policyDecisions = readGlobalDecisionsUnlocked()
      .map(({ decision }) => decision)
      .filter((decision) => decision.actorRole === "policy" && decision.newState === "superseded")
      .sort((left, right) => globalDecisionId(left).localeCompare(globalDecisionId(right)));
    let recovered = 0;
    for (const decision of policyDecisions) {
      const recommendationRecord = readGlobalRecommendationsUnlocked()
        .find(({ recommendation }) => recommendation.recommendationId === decision.recommendationId);
      if (!recommendationRecord) continue;
      const plan = globalLifecycleInvalidationPlanUnlocked(recommendationRecord, decision.timestamp, decision);
      assertGlobalQuotaUnlocked(plan.changes);
      if (plan.changes.size) {
        writeGlobalLifecycleInvalidationPlanUnlocked(plan);
        recovered += 1;
      }
    }
    return recovered;
  }

  function invalidateStaleGlobalRecommendationsUnlocked(nowMs, { force = false } = {}) {
    let invalidated = 0;
    for (const recommendationRecord of readGlobalRecommendationsUnlocked()) {
      if (!["pending", "approved"].includes(recommendationRecord.recommendation.state)
          || (!force && globalRecommendationSupportCurrentUnlocked(recommendationRecord.recommendation, nowMs))) continue;
      const plan = globalLifecycleInvalidationPlanUnlocked(recommendationRecord, nowMs);
      assertGlobalQuotaUnlocked(plan.changes);
      writeGlobalLifecycleInvalidationPlanUnlocked(plan);
      invalidated += 1;
    }
    return invalidated;
  }

  function recoverGlobalLifecycle() {
    try {
      return withMutationLock(() => ({
        ok: true,
        recovered: recoverGlobalLifecycleInvalidationsUnlocked(),
        orphanRecommendationContent: cleanupOrphanGlobalRecommendationContentUnlocked(),
      }));
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-lifecycle-recovery-failed"), recovered: 0, orphanRecommendationContent: 0 };
    }
  }

  function recommendationContentPath(recommendationId, chunkIndex) {
    const id = String(recommendationId).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(id) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 999_999) {
      throw new Error("invalid-global-recommendation-content-key");
    }
    return path.join(globalRecommendationContentDir, id.slice(0, 2), id, `${String(chunkIndex).padStart(6, "0")}.json`);
  }

  function readGlobalRecommendationChunksUnlocked(recommendationId) {
    const id = String(recommendationId).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("invalid-global-recommendation-id");
    const directory = path.join(globalRecommendationContentDir, id.slice(0, 2), id);
    return safeTreeFiles(directory).flatMap((filePath) => {
      const relative = path.relative(directory, filePath);
      if (!/^\d{6}\.json$/u.test(relative) || relative.includes(path.sep)) {
        throw new Error("global-recommendation-content-storage-path-rejected");
      }
      const result = readReloadSafeGlobalRecord(filePath, MAX_GLOBAL_RECOMMENDATION_CONTENT_BYTES, makeGlobalRecommendationContent, "global-recommendation-content");
      if (result.unsafe) { quarantineReloadedGlobalRecord(filePath, result); return []; }
      const chunk = result.record;
      if (chunk.recommendationId !== id || filePath !== recommendationContentPath(id, chunk.chunkIndex)) {
        throw new Error("global-recommendation-content-path-mismatch");
      }
      return [{ filePath, chunk }];
    }).sort((left, right) => left.chunk.chunkIndex - right.chunk.chunkIndex);
  }

  function decodeGlobalRecommendationContentUnlocked(recommendationId) {
    const records = readGlobalRecommendationChunksUnlocked(recommendationId);
    if (!records.length) return null;
    const chunks = records.map(({ chunk }) => chunk);
    if (chunks.length !== chunks[0].chunkCount
        || chunks.some((chunk, index) => chunk.chunkIndex !== index || chunk.chunkCount !== chunks.length)) return null;
    const encoded = chunks.map((chunk) => chunk.content).join("");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || chunks.some((chunk) => chunk.contentHash !== chunks[0].contentHash)) return null;
    const content = bytes.toString("utf8");
    return hashContent(content) === chunks[0].contentHash ? content : null;
  }

  function readGlobalDecisionsUnlocked() {
    return globalHashRecordFiles(globalDecisionsDir, "global-decision").map(({ filePath, id }) => {
      const decision = readCanonicalJson(
        filePath,
        MAX_GLOBAL_DECISION_RECORD_BYTES,
        (value) => makeGlobalDecision(value, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() }),
        "corrupt-global-decision",
      );
      if (globalDecisionId(decision) !== id) throw new Error("global-decision-path-mismatch");
      return { filePath, decision };
    });
  }

  function readGlobalApplyIntentsUnlocked() {
    return globalHashRecordFiles(globalApplyIntentsDir, "global-apply-intent").map(({ filePath, id }) => {
      let source;
      let raw;
      let intent;
      try {
        source = readStableRegularFile(filePath, MAX_GLOBAL_DECISION_RECORD_BYTES);
        raw = JSON.parse(source);
        const legacy = !Object.hasOwn(raw, "directoryDevice") && !Object.hasOwn(raw, "directoryInode");
        intent = makeGlobalApplyIntent(
          legacy ? { ...raw, directoryDevice: null, directoryInode: null } : raw,
          { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() },
        );
      } catch {
        throw new Error("corrupt-global-apply-intent");
      }
      if (source !== json(intent)) {
        const legacy = { ...intent };
        delete legacy.directoryDevice;
        delete legacy.directoryInode;
        if (Object.hasOwn(raw, "directoryDevice") || Object.hasOwn(raw, "directoryInode") || source !== json(legacy)) {
          throw new Error("corrupt-global-apply-intent");
        }
      }
      if (intent.intentId !== id) throw new Error("global-apply-intent-path-mismatch");
      return { filePath, intent };
    });
  }

  function readGlobalSkillSnapshotsUnlocked() {
    return globalHashRecordFiles(globalSkillSnapshotsDir, "global-skill-snapshot").map(({ filePath, id }) => {
      const snapshot = readCanonicalJson(
        filePath,
        MAX_GLOBAL_SNAPSHOT_RECORD_BYTES,
        (value) => makeGlobalSkillSnapshot(value, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() }),
        "corrupt-global-skill-snapshot",
      );
      if (snapshot.snapshotId !== id) throw new Error("global-skill-snapshot-path-mismatch");
      return { filePath, snapshot };
    });
  }

  function readGlobalDecisionOutcomesUnlocked() {
    return globalHashRecordFiles(globalDecisionOutcomesDir, "global-decision-outcome").map(({ filePath, id }) => {
      const outcome = readCanonicalJson(
        filePath,
        MAX_GLOBAL_DECISION_RECORD_BYTES,
        (value) => makeGlobalDecisionOutcome(value, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() }),
        "corrupt-global-decision-outcome",
      );
      if (outcome.outcomeId !== id) throw new Error("global-decision-outcome-path-mismatch");
      return { filePath, outcome };
    });
  }

  function readGlobalAuditsUnlocked() {
    return globalHashRecordFiles(globalAuditsDir, "global-audit").map(({ filePath, id }) => {
      const audit = readCanonicalJson(
        filePath,
        MAX_GLOBAL_DECISION_RECORD_BYTES,
        (value) => makeGlobalAuditEvent(value, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() }),
        "corrupt-global-audit",
      );
      if (audit.auditId !== id) throw new Error("global-audit-path-mismatch");
      return { filePath, audit };
    });
  }

  function globalDecisionLeaseUnlocked(targetBinding, leaseKeyHash, ownerToken, nowMs) {
    if (globalTargetLeaseKey(targetBinding) !== leaseKeyHash) throw new Error("global-target-lease-key-mismatch");
    const current = readGlobalLeaseUnlocked(leaseKeyHash)?.lease;
    if (!current || current.state !== "active" || current.leaseKind !== "target-write"
        || current.ownerToken !== ownerToken || current.expiresAt <= nowMs) {
      throw new Error("global-target-lease-invalid");
    }
    return current;
  }

  function globalDecisionSuppressorReason(action, settings, suppressors) {
    if (!suppressors || typeof suppressors !== "object" || Array.isArray(suppressors)
        || Object.keys(suppressors).sort().join(",") !== "circuitBreakerOpen,emergencyStop"
        || Object.values(suppressors).some((value) => typeof value !== "boolean")) {
      return "global-decision-suppressors-required";
    }
    if (action === "apply") {
      const automation = getAutomationStateUnlocked();
      if (!automation.ok) return automation.reason ?? "automation-state-unavailable";
      if (automation.global.killSwitchActive) return "kill-switch";
      if (suppressors.circuitBreakerOpen) return "circuit-breaker";
      if (suppressors.emergencyStop) return "emergency-stop";
    }
    return null;
  }

  function globalDecisionIdentityFirewallValues(values = []) {
    if (!Array.isArray(values) || values.length > 61
        || values.some((value) => typeof value !== "string" || !value || value.length > 4096 || value.includes("\0"))) {
      throw new Error("invalid-global-identity-firewall-context");
    }
    return [...new Set([
      projectFingerprint,
      hashContent(projectFingerprint),
      hashContent(JSON.stringify(projectFingerprint)),
      ...values,
    ])].sort();
  }

  function persistedGlobalOutcomeResult(outcome, extra = {}) {
    return outcome.state === "succeeded"
      ? { ok: true, duplicate: true, outcome, ...extra }
      : { ok: false, duplicate: true, reason: outcome.reason, outcome, ...extra };
  }

  function globalDecisionOutcomeReason(reason) {
    const code = errorReasonCode(reason, "global-decision-failed");
    if (/quota|storage|file-count|capacity/u.test(code)) return "global-storage-capacity";
    if (/consent|support|candidate|root|lease|paused|kill-switch|circuit-breaker|emergency-stop|release-gates|stale-global-decision/u.test(code)) {
      return "global-authority-revoked";
    }
    if (/target|path|hash|symlink|collision|ownership/u.test(code)) return "global-target-changed";
    if (/temporary|publication|readback|rollback|cleanup/u.test(code)) return "global-publication-failed";
    return "global-decision-failed";
  }

  // Apply authority depends on current global consent, so the consent gate is
  // evaluated before support, drift, or state checks. Revoking consent also
  // supersedes affected recommendations, and without this ordering the operator
  // would see a downstream support/drift code instead of the real cause.
  function assertGlobalApplyConsentUnlocked(action) {
    if (action !== "apply") return;
    const automation = getAutomationStateUnlocked();
    if (!automation.ok) throw new Error(automation.reason ?? "automation-state-unavailable");
    const consent = automation.global.consent;
    if (!consent.durableObservations || !consent.sanitizedExcerpts || !consent.crossRepoAggregation) {
      throw new Error("global-apply-consent-required");
    }
  }

  function canonicalOperatorDecisionUnlocked(decision) {
    const decisions = readGlobalDecisionsUnlocked();
    const persistedOperatorDecision = decisions.find(({ decision: item }) => globalDecisionId(item) === globalDecisionId(decision))?.decision;
    const conflictingOperatorDecision = decisions.find(({ decision: item }) => item.actorRole === "operator"
      && item.recommendationId === decision.recommendationId
      && item.decisionVersion === decision.decisionVersion
      && !sameCanonicalRecord(item, decision));
    if (conflictingOperatorDecision) throw new Error("global-operator-decision-conflict");
    return persistedOperatorDecision;
  }

  function validateGlobalDecisionLeaseEdgeUnlocked(action, decision, nowMs, rootPolicy = null) {
    const expectedPrior = action === "apply" ? "pending" : "applied";
    const expectedNext = action === "apply" ? "approved" : "undo-approved";
    if (!["apply", "undo"].includes(action) || decision.actorRole !== "operator"
        || decision.priorState !== expectedPrior || decision.newState !== expectedNext) {
      throw new Error("invalid-global-operator-decision");
    }
    assertGlobalApplyConsentUnlocked(action);
    const persistedOperatorDecision = canonicalOperatorDecisionUnlocked(decision);
    const recommendationRecord = readGlobalRecommendationsUnlocked()
      .find(({ recommendation }) => recommendation.recommendationId === decision.recommendationId);
    if (!recommendationRecord) throw new Error("global-recommendation-not-found");
    const recommendation = recommendationRecord.recommendation;
    const expectedTargetHash = action === "apply"
      ? recommendation.targetBinding.currentHash
      : recommendation.proposedContentHash;
    if (decision.timestamp > nowMs
        || recommendation.supportSetHash !== decision.supportSetHash
        || recommendation.targetBinding.bindingHash !== decision.targetBindingHash
        || expectedTargetHash !== decision.targetHash
        || recommendation.proposedContentHash !== decision.proposedContentHash) {
      throw new Error("stale-global-decision");
    }
    if (action === "apply" && !globalRecommendationSupportCurrentUnlocked(recommendation, nowMs, rootPolicy)) {
      throw new Error("global-support-invalid");
    }
    const canTransition = recommendation.state === decision.priorState
      && recommendation.decisionVersion + 1 === decision.decisionVersion;
    const alreadyTransitioned = recommendation.state === decision.newState
      && recommendation.decisionVersion === decision.decisionVersion
      && recommendation.burnedNonceHashes.includes(hashContent(decision.nonce));
    const priorIntent = readGlobalApplyIntentsUnlocked()
      .find(({ intent }) => intent.intentId === globalApplyIntentId(decision))?.intent;
    if (priorIntent && !sameCanonicalRecord(priorIntent.decision, decision)) {
      throw new Error("global-apply-intent-conflict");
    }
    if (canTransition) {
      const preview = transitionGlobalRecommendation(recommendation, decision, nowMs);
      if (!preview.ok) throw new Error(preview.error);
    } else if (!alreadyTransitioned && !persistedOperatorDecision && !priorIntent) {
      throw new Error("stale-global-decision");
    }
    return recommendation;
  }

  function acquireGlobalDecisionLease(request) {
    let deadlines = { requestDeadline: undefined, consumerDeadline: undefined };
    try { deadlines = extractDecisionDeadlines(request); }
    catch (error) { return { ok: false, reason: errorReasonCode(error, "invalid-global-decision-lease-request") }; }
    const { requestDeadline, consumerDeadline } = deadlines;
    const keys = Object.keys(request ?? {}).filter((key) => key !== "requestDeadline" && key !== "consumerDeadline").sort().join(",");
    if (!request || typeof request !== "object" || Array.isArray(request)
        || ![
          "action,decision,nowMs,ttlMs",
          "action,decision,forbiddenIdentityValues,nowMs,ttlMs",
          "action,decision,nowMs,rootPolicy,ttlMs",
          "action,decision,forbiddenIdentityValues,nowMs,rootPolicy,ttlMs",
        ].includes(keys)
        || !Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
      return { ok: false, reason: "invalid-global-decision-lease-request" };
    }
    try {
      return withMutationLock(() => {
        assertDecisionDeadlinesUnlocked(request.nowMs, requestDeadline, consumerDeadline);
        const identityOptions = { forbiddenIdentityValues: globalDecisionIdentityFirewallValues(request.forbiddenIdentityValues) };
        const decision = makeGlobalDecision(request.decision, identityOptions);
        const recommendation = validateGlobalDecisionLeaseEdgeUnlocked(request.action, decision, request.nowMs, request.rootPolicy);
        const acquired = acquireGlobalLeaseUnlocked({
          leaseKind: "target-write",
          leaseKeyHash: globalTargetLeaseKey(recommendation.targetBinding),
          ttlMs: request.ttlMs,
        }, request.nowMs);
        return acquired.ok ? { ...acquired, recommendation } : acquired;
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-decision-lease-acquire-failed") };
    }
  }

  function beginGlobalDecision(request) {
    let deadlines = { requestDeadline: undefined, consumerDeadline: undefined };
    try { deadlines = extractDecisionDeadlines(request); }
    catch (error) { return { ok: false, reason: errorReasonCode(error, "invalid-global-decision-request") }; }
    const { requestDeadline, consumerDeadline } = deadlines;
    const requestKeys = Object.keys(request ?? {}).filter((key) => key !== "requestDeadline" && key !== "consumerDeadline").sort().join(",");
    if (!request || typeof request !== "object" || Array.isArray(request)
        || ![
          "action,decision,leaseKeyHash,nowMs,ownerToken,suppressors",
          "action,decision,forbiddenIdentityValues,leaseKeyHash,nowMs,ownerToken,suppressors",
          "action,decision,leaseKeyHash,nowMs,ownerToken,rootPolicy,suppressors",
          "action,decision,forbiddenIdentityValues,leaseKeyHash,nowMs,ownerToken,rootPolicy,suppressors",
        ].includes(requestKeys)) {
      return { ok: false, reason: "invalid-global-decision-request" };
    }
    try {
      return withMutationLock(() => {
        if (!["apply", "undo"].includes(request.action) || !Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
          throw new Error("invalid-global-decision-request");
        }
        const identityOptions = { forbiddenIdentityValues: globalDecisionIdentityFirewallValues(request.forbiddenIdentityValues) };
        const decision = makeGlobalDecision(request.decision, identityOptions);
        const expectedPrior = request.action === "apply" ? "pending" : "applied";
        const expectedNext = request.action === "apply" ? "approved" : "undo-approved";
        if (decision.actorRole !== "operator" || decision.priorState !== expectedPrior || decision.newState !== expectedNext) {
          throw new Error("invalid-global-operator-decision");
        }
        const intentId = globalApplyIntentId(decision);
        const existingOutcome = readGlobalDecisionOutcomesUnlocked().find(({ outcome }) => outcome.intentId === intentId)?.outcome;
        if (existingOutcome) return persistedGlobalOutcomeResult(existingOutcome);
        // Durable admission fence (H10-001): a request or consumer claim that
        // expired after consumption but before this admission boundary cannot
        // drive a durable decision. The real deadline is compared without
        // clamping; a duplicate completed outcome above still returns normally.
        assertDecisionDeadlinesUnlocked(request.nowMs, requestDeadline, consumerDeadline);
        assertGlobalApplyConsentUnlocked(request.action);
        const recommendationRecord = readGlobalRecommendationsUnlocked().find(({ recommendation }) => recommendation.recommendationId === decision.recommendationId);
        if (!recommendationRecord) throw new Error("global-recommendation-not-found");
        const recommendation = recommendationRecord.recommendation;
        if (request.action === "apply" && !globalRecommendationSupportCurrentUnlocked(recommendation, request.nowMs, request.rootPolicy)) {
          throw new Error("global-support-invalid");
        }
        const persistedOperatorDecision = canonicalOperatorDecisionUnlocked(decision);
        const settings = getSettingsUnlocked();
        const suppressed = globalDecisionSuppressorReason(request.action, settings, request.suppressors);
        if (suppressed) throw new Error(suppressed);
        assertGlobalApplyConsentUnlocked(request.action, settings);
        if (!request.rootPolicy && !settings.global.globalRootPolicy) throw new Error("global-root-policy-required");
        const policy = makeGlobalRootPolicy(request.rootPolicy ?? settings.global.globalRootPolicy);
        if (recommendation.targetBinding.rootSetHash !== policy.rootSetHash) throw new Error("stale-root-set");
        const root = policy.roots.find((item) => item.rootId === recommendation.targetBinding.rootId);
        if (!root || (request.action === "apply" && recommendation.targetBinding.targetKind === "existing-global-skill" && !root.canUpdate)
            || (request.action === "apply" && recommendation.targetBinding.targetKind === "new-global-skill"
              && (!root.canCreate || policy.creationRootId !== root.rootId))) {
          throw new Error("root-not-validated");
        }
        if (request.action === "apply") {
          if (!recommendation.criticPassed || !recommendation.validDeterministic) throw new Error("release-gates-failed");
          const supportRecord = readGlobalSupportSetsUnlocked().find(({ supportSet }) => supportSet.supportSetHash === recommendation.supportSetHash);
          if (!supportRecord || supportRecord.supportSet.candidateId !== recommendation.candidateId
              || supportRecord.supportSet.targetBinding.bindingHash !== recommendation.candidateTargetBindingHash
              || supportRecord.supportSet.expiresAt <= request.nowMs) throw new Error("global-support-invalid");
          const eligibility = evaluateGlobalSupportEligibility(supportRecord.supportSet, policy);
          if (!eligibility.eligible) throw new Error("global-support-ineligible");
          const candidate = readGlobalCandidatesUnlocked().find(({ candidate: item }) => item.candidateId === recommendation.candidateId)?.candidate;
          if (!candidate || candidate.state !== "recommended" || candidate.supportSetHash !== recommendation.supportSetHash
              || candidate.targetBindingHash !== recommendation.candidateTargetBindingHash
              || candidate.eligibilityRoute !== eligibility.route) throw new Error("global-candidate-drift");
        }
        globalDecisionLeaseUnlocked(recommendation.targetBinding, request.leaseKeyHash, request.ownerToken, request.nowMs);
        const content = decodeGlobalRecommendationContentUnlocked(recommendation.recommendationId);
        if (content === null || hashContent(content) !== recommendation.proposedContentHash) throw new Error("global-recommendation-content-unavailable");
        const intent = makeGlobalApplyIntent({
          action: request.action,
          recommendationId: recommendation.recommendationId,
          supportSetHash: recommendation.supportSetHash,
          targetBindingHash: recommendation.targetBinding.bindingHash,
          rootId: recommendation.targetBinding.rootId,
          relativePath: recommendation.targetBinding.relativePath,
          targetKind: recommendation.targetBinding.targetKind,
          priorHash: recommendation.targetBinding.currentHash,
          appliedHash: recommendation.proposedContentHash,
          decision,
          state: "decision-pending",
          temporaryName: null,
          snapshotId: null,
          directoryDevice: null,
          directoryInode: null,
          createdAt: request.nowMs,
          updatedAt: request.nowMs,
        }, identityOptions);
        const priorIntent = readGlobalApplyIntentsUnlocked().find(({ intent: item }) => item.intentId === intent.intentId);
        let currentIntent = priorIntent?.intent ?? intent;
        if (priorIntent) {
          const bindingFields = [
            "intentId", "action", "recommendationId", "supportSetHash", "targetBindingHash", "rootId",
            "relativePath", "targetKind", "priorHash", "appliedHash",
          ];
          if (bindingFields.some((field) => priorIntent.intent[field] !== intent[field])
              || !sameCanonicalRecord(priorIntent.intent.decision, intent.decision)) {
            throw new Error("global-apply-intent-conflict");
          }
        }
        const canTransition = recommendation.state === decision.priorState
          && recommendation.decisionVersion + 1 === decision.decisionVersion;
        const alreadyTransitioned = recommendation.state === decision.newState
          && recommendation.decisionVersion === decision.decisionVersion
          && recommendation.burnedNonceHashes.includes(hashContent(decision.nonce));
        if (!canTransition && !alreadyTransitioned && !persistedOperatorDecision && !priorIntent) {
          throw new Error("stale-global-decision");
        }
        if (canTransition) {
          const preview = transitionGlobalRecommendation(recommendation, decision, request.nowMs);
          if (!preview.ok) throw new Error(preview.error);
        }
        const intentPath = globalHashRecordPath(globalApplyIntentsDir, intent.intentId);
        const decisionPath = globalHashRecordPath(globalDecisionsDir, globalDecisionId(decision));
        let nextRecommendation = recommendation;
        if (canTransition) {
          const transitioned = transitionGlobalRecommendation(recommendation, decision, request.nowMs);
          if (!transitioned.ok) throw new Error(transitioned.error);
          nextRecommendation = transitioned.state;
        }
        const committedIntent = currentIntent.state === "decision-pending"
          ? transitionGlobalApplyIntent(currentIntent, { state: "decision-committed" }, request.nowMs)
          : currentIntent;
        const admissionChanges = new Map();
        if (!priorIntent || committedIntent !== currentIntent) admissionChanges.set(path.resolve(intentPath), json(committedIntent));
        if (nextRecommendation !== recommendation) admissionChanges.set(path.resolve(recommendationRecord.filePath), json(nextRecommendation));
        if (!persistedOperatorDecision) admissionChanges.set(path.resolve(decisionPath), json(decision));
        assertGlobalQuotaUnlocked(admissionChanges);
        if (!priorIntent) {
          injectFault("global-decision-before-intent", { intentId: intent.intentId });
          assertGlobalQuotaUnlocked(new Map([[path.resolve(intentPath), json(intent)]]));
          exclusiveJsonWrite(intentPath, intent, makeGlobalApplyIntent, "global-apply-intent", MAX_GLOBAL_DECISION_RECORD_BYTES);
          injectFault("global-decision-after-intent", { intentId: intent.intentId });
          injectFault("journal-after-intent", { intentId: intent.intentId });
        }
        if (nextRecommendation !== recommendation) {
          const source = json(nextRecommendation);
          assertGlobalQuotaUnlocked(new Map([[path.resolve(recommendationRecord.filePath), source]]));
          injectFault("global-decision-before-cas", { intentId: intent.intentId });
          atomicWrite(recommendationRecord.filePath, source);
          injectFault("global-decision-after-cas", { intentId: intent.intentId });
          injectFault("journal-after-recommendation-cas", { intentId: intent.intentId });
        } else if (recommendation.state !== decision.newState || recommendation.decisionVersion !== decision.decisionVersion
            || !recommendation.burnedNonceHashes.includes(hashContent(decision.nonce))) {
          if (!persistedOperatorDecision && !priorIntent) throw new Error("stale-global-decision");
        }
        if (!persistedOperatorDecision) {
          assertGlobalQuotaUnlocked(new Map([[path.resolve(decisionPath), json(decision)]]));
          exclusiveJsonWrite(decisionPath, decision, makeGlobalDecision, "global-decision", MAX_GLOBAL_DECISION_RECORD_BYTES);
          injectFault("global-decision-after-record", { intentId: intent.intentId });
          injectFault("journal-after-decision-record", { intentId: intent.intentId });
        }
        if (currentIntent.state === "decision-pending") {
          currentIntent = committedIntent;
          assertGlobalQuotaUnlocked(new Map([[path.resolve(intentPath), json(currentIntent)]]));
          atomicWrite(intentPath, json(currentIntent));
          injectFault("global-decision-after-commit", { intentId: intent.intentId });
          injectFault("journal-after-intent-commit", { intentId: intent.intentId });
        }
        return { ok: true, duplicate: Boolean(priorIntent), intent: currentIntent, recommendation: nextRecommendation, content };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-decision-admission-failed") };
    }
  }

  function revalidateGlobalDecisionIntent(request) {
    const requestKeys = Object.keys(request ?? {}).sort().join(",");
    if (!request || typeof request !== "object" || Array.isArray(request)
        || ![
          "intentId,leaseKeyHash,nowMs,ownerToken,suppressors",
          "forbiddenIdentityValues,intentId,leaseKeyHash,nowMs,ownerToken,suppressors",
          "intentId,leaseKeyHash,nowMs,ownerToken,rootPolicy,suppressors",
          "forbiddenIdentityValues,intentId,leaseKeyHash,nowMs,ownerToken,rootPolicy,suppressors",
        ].includes(requestKeys)
        || !Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
      return { ok: false, reason: "invalid-global-decision-revalidation" };
    }
    try {
      return withMutationLock(() => {
        const intentRecord = readGlobalApplyIntentsUnlocked().find(({ intent }) => intent.intentId === request.intentId);
        if (!intentRecord || intentRecord.intent.state !== "temp-written") throw new Error("global-apply-intent-stage-mismatch");
        const intent = intentRecord.intent;
        if (readGlobalDecisionOutcomesUnlocked().some(({ outcome }) => outcome.intentId === intent.intentId)) {
          throw new Error("global-decision-outcome-exists");
        }
        const identityOptions = { forbiddenIdentityValues: globalDecisionIdentityFirewallValues(request.forbiddenIdentityValues) };
        makeGlobalApplyIntent(intent, identityOptions);
        const decision = makeGlobalDecision(intent.decision, identityOptions);
        if (globalApplyIntentId(decision) !== intent.intentId
            || !readGlobalDecisionsUnlocked().some(({ decision: item }) => sameCanonicalRecord(item, decision))) {
          throw new Error("global-operator-decision-drift");
        }
        assertGlobalApplyConsentUnlocked(intent.action);
        const recommendation = readGlobalRecommendationsUnlocked()
          .find(({ recommendation: item }) => item.recommendationId === intent.recommendationId)?.recommendation;
        const expectedState = intent.action === "apply" ? "approved" : "undo-approved";
        if (!recommendation || recommendation.state !== expectedState
            || recommendation.decisionVersion !== decision.decisionVersion
            || !recommendation.burnedNonceHashes.includes(hashContent(decision.nonce))
            || recommendation.supportSetHash !== intent.supportSetHash
            || recommendation.targetBinding.bindingHash !== intent.targetBindingHash
            || recommendation.targetBinding.rootId !== intent.rootId
            || recommendation.targetBinding.relativePath !== intent.relativePath
            || recommendation.targetBinding.targetKind !== intent.targetKind
            || recommendation.targetBinding.currentHash !== intent.priorHash
            || recommendation.proposedContentHash !== intent.appliedHash) {
          throw new Error("global-recommendation-drift");
        }
        if (intent.action === "apply" && !globalRecommendationSupportCurrentUnlocked(recommendation, request.nowMs, request.rootPolicy)) {
          throw new Error("global-support-invalid");
        }
        const settings = getSettingsUnlocked();
        const suppressed = globalDecisionSuppressorReason(intent.action, settings, request.suppressors);
        if (suppressed) throw new Error(suppressed);
        assertGlobalApplyConsentUnlocked(intent.action, settings);
        if (!request.rootPolicy && !settings.global.globalRootPolicy) throw new Error("global-root-policy-required");
        const policy = makeGlobalRootPolicy(request.rootPolicy ?? settings.global.globalRootPolicy);
        if (recommendation.targetBinding.rootSetHash !== policy.rootSetHash) throw new Error("stale-root-set");
        const root = policy.roots.find((item) => item.rootId === intent.rootId);
        if (!root || (intent.action === "apply" && intent.targetKind === "existing-global-skill" && !root.canUpdate)
            || (intent.action === "apply" && intent.targetKind === "new-global-skill"
              && (!root.canCreate || policy.creationRootId !== root.rootId))) {
          throw new Error("root-not-validated");
        }
        if (intent.action === "apply") {
          if (!recommendation.criticPassed || !recommendation.validDeterministic) throw new Error("release-gates-failed");
          const supportSet = readGlobalSupportSetsUnlocked()
            .find(({ supportSet: item }) => item.supportSetHash === intent.supportSetHash)?.supportSet;
          if (!supportSet || supportSet.candidateId !== recommendation.candidateId
              || supportSet.targetBinding.bindingHash !== recommendation.candidateTargetBindingHash
              || supportSet.expiresAt <= request.nowMs) throw new Error("global-support-invalid");
          const eligibility = evaluateGlobalSupportEligibility(supportSet, policy);
          if (!eligibility.eligible) throw new Error("global-support-ineligible");
          const candidate = readGlobalCandidatesUnlocked()
            .find(({ candidate: item }) => item.candidateId === recommendation.candidateId)?.candidate;
          if (!candidate || candidate.state !== "recommended" || candidate.supportSetHash !== intent.supportSetHash
              || candidate.targetBindingHash !== recommendation.candidateTargetBindingHash
              || candidate.eligibilityRoute !== eligibility.route) throw new Error("global-candidate-drift");
        }
        globalDecisionLeaseUnlocked(intent, request.leaseKeyHash, request.ownerToken, request.nowMs);
        const content = decodeGlobalRecommendationContentUnlocked(intent.recommendationId);
        if (content === null || hashContent(content) !== intent.appliedHash) throw new Error("global-recommendation-content-unavailable");
        return { ok: true, intent, recommendation, policy, content };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-decision-revalidation-failed") };
    }
  }

  function commitGlobalDecisionPublication(request) {
    try {
      return withMutationLock(() => {
        const { publishedTemporaryName, ...revalidationRequest } = request ?? {};
        if (!(publishedTemporaryName === null || (typeof publishedTemporaryName === "string" && publishedTemporaryName.startsWith(".")))) {
          throw new Error("invalid-global-publication-commit");
        }
        const revalidated = revalidateGlobalDecisionIntent(revalidationRequest);
        if (!revalidated?.ok) throw new Error(revalidated?.reason ?? "global-decision-revalidation-failed");
        const record = readGlobalApplyIntentsUnlocked().find(({ intent }) => intent.intentId === request.intentId);
        if (!record || record.intent.state !== "temp-written") throw new Error("global-apply-intent-stage-mismatch");
        const intent = transitionGlobalApplyIntent(record.intent, { state: "published", temporaryName: publishedTemporaryName }, request.nowMs);
        assertGlobalQuotaUnlocked(new Map([[path.resolve(record.filePath), json(intent)]]));
        atomicWrite(record.filePath, json(intent));
        injectFault("global-apply-after-published", { intentId: intent.intentId });
        injectFault("journal-after-publication-commit", { intentId: intent.intentId });
        return { ...revalidated, intent };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-publication-commit-failed") };
    }
  }

  function writeGlobalSkillSnapshot(request) {
    try {
      return withMutationLock(() => {
        const keys = Object.keys(request ?? {}).sort().join(",");
        if (!request || typeof request !== "object" || Array.isArray(request)
            || ![
              "content,forbiddenIdentityValues,intentId,leaseKeyHash,nowMs,ownerToken",
              "forbiddenIdentityValues,intentId,leaseKeyHash,nowMs,ownerToken",
            ].includes(keys)
            || !Number.isSafeInteger(request.nowMs) || request.nowMs < 0) throw new Error("invalid-global-snapshot-request");
        const identityOptions = { forbiddenIdentityValues: globalDecisionIdentityFirewallValues(request.forbiddenIdentityValues) };
        const record = readGlobalApplyIntentsUnlocked().find(({ intent }) => intent.intentId === request.intentId);
        if (!record) throw new Error("global-apply-intent-not-found");
        let intent = record.intent;
        globalDecisionLeaseUnlocked(intent, request.leaseKeyHash, request.ownerToken, request.nowMs);
        if (intent.state === "snapshot-ready") {
          const snapshot = intent.snapshotId === null ? null : readGlobalSkillSnapshotsUnlocked().find(({ snapshot: item }) => item.snapshotId === intent.snapshotId)?.snapshot;
          return { ok: true, duplicate: true, intent, snapshot };
        }
        if (intent.state !== "decision-committed") throw new Error("global-apply-intent-stage-mismatch");
        let snapshot = null;
        let snapshotPath = null;
        if (intent.action === "undo") {
          const applied = readGlobalApplyIntentsUnlocked().map(({ intent: item }) => item)
            .find((item) => item.action === "apply" && item.recommendationId === intent.recommendationId
              && item.state === "completed" && item.priorHash === intent.priorHash && item.appliedHash === intent.appliedHash);
          if (!applied) throw new Error("global-applied-intent-not-found");
          if (intent.targetKind === "existing-global-skill") {
            snapshot = readGlobalSkillSnapshotsUnlocked().find(({ snapshot: item }) => item.snapshotId === applied.snapshotId)?.snapshot ?? null;
            if (!snapshot || snapshot.intentId !== applied.intentId || snapshot.priorHash !== intent.priorHash
                || snapshot.appliedHash !== intent.appliedHash) throw new Error("global-snapshot-missing");
          }
          if (Object.hasOwn(request, "content")) throw new Error("global-undo-snapshot-content-forbidden");
        } else if (intent.targetKind === "existing-global-skill") {
          if (!(typeof request.content === "string" || Buffer.isBuffer(request.content))) throw new Error("global-snapshot-content-required");
          snapshot = makeGlobalSkillSnapshot({
            intentId: intent.intentId,
            recommendationId: intent.recommendationId,
            targetBindingHash: intent.targetBindingHash,
            rootId: intent.rootId,
            relativePath: intent.relativePath,
            priorHash: intent.priorHash,
            appliedHash: intent.appliedHash,
            contentEncoding: "base64",
            content: Buffer.from(request.content).toString("base64"),
            createdAt: intent.updatedAt,
          }, identityOptions);
          snapshotPath = globalHashRecordPath(globalSkillSnapshotsDir, snapshot.snapshotId);
        } else if (Object.hasOwn(request, "content")) {
          throw new Error("global-snapshot-new-target-content-forbidden");
        }
        const nextIntent = transitionGlobalApplyIntent(intent, { state: "snapshot-ready", snapshotId: snapshot?.snapshotId ?? null }, request.nowMs);
        const changes = new Map([[path.resolve(record.filePath), json(nextIntent)]]);
        if (snapshotPath !== null) changes.set(path.resolve(snapshotPath), json(snapshot));
        assertGlobalQuotaUnlocked(changes);
        if (snapshotPath !== null) {
          injectFault("global-apply-before-snapshot", { intentId: intent.intentId });
          exclusiveJsonWrite(
            snapshotPath,
            snapshot,
            (value) => makeGlobalSkillSnapshot(value, identityOptions),
            "global-skill-snapshot",
            MAX_GLOBAL_SNAPSHOT_RECORD_BYTES,
          );
          injectFault("global-apply-after-snapshot", { intentId: intent.intentId });
          injectFault("journal-after-snapshot", { intentId: intent.intentId });
        }
        intent = nextIntent;
        assertGlobalQuotaUnlocked(new Map([[path.resolve(record.filePath), json(intent)]]));
        atomicWrite(record.filePath, json(intent));
        injectFault("journal-after-snapshot-intent", { intentId: intent.intentId });
        return { ok: true, duplicate: false, intent, snapshot };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-snapshot-write-failed") };
    }
  }

  function advanceGlobalApplyIntent(request) {
    try {
      return withMutationLock(() => {
        const allowed = ["intentId", "leaseKeyHash", "nowMs", "ownerToken", "snapshotId", "state", "temporaryName", "directoryDevice", "directoryInode"];
        if (!request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).some((key) => !allowed.includes(key))
            || !["intentId", "leaseKeyHash", "nowMs", "ownerToken", "state"].every((key) => Object.hasOwn(request, key))
            || !Number.isSafeInteger(request.nowMs) || request.nowMs < 0) throw new Error("invalid-global-intent-transition-request");
        const record = readGlobalApplyIntentsUnlocked().find(({ intent }) => intent.intentId === request.intentId);
        if (!record) throw new Error("global-apply-intent-not-found");
        globalDecisionLeaseUnlocked(record.intent, request.leaseKeyHash, request.ownerToken, request.nowMs);
        const ownershipChanged = Object.hasOwn(request, "directoryDevice") || Object.hasOwn(request, "directoryInode");
        if (ownershipChanged && (!Object.hasOwn(request, "directoryDevice") || !Object.hasOwn(request, "directoryInode"))) {
          throw new Error("invalid-global-directory-identity");
        }
        if (record.intent.state === request.state && request.nowMs < record.intent.updatedAt) throw new Error("out-of-order");
        if (record.intent.state === request.state && !ownershipChanged) return { ok: true, duplicate: true, intent: record.intent };
        if (record.intent.state === request.state && ownershipChanged
            && record.intent.directoryDevice === request.directoryDevice
            && record.intent.directoryInode === request.directoryInode) {
          return { ok: true, duplicate: true, intent: record.intent };
        }
        const change = {
          state: request.state,
          ...(Object.hasOwn(request, "temporaryName") ? { temporaryName: request.temporaryName } : {}),
          ...(Object.hasOwn(request, "snapshotId") ? { snapshotId: request.snapshotId } : {}),
          ...(ownershipChanged ? { directoryDevice: request.directoryDevice, directoryInode: request.directoryInode } : {}),
        };
        const intent = record.intent.state === request.state
          ? makeGlobalApplyIntent({ ...record.intent, ...change, updatedAt: request.nowMs })
          : transitionGlobalApplyIntent(record.intent, change, request.nowMs);
        assertGlobalQuotaUnlocked(new Map([[path.resolve(record.filePath), json(intent)]]));
        atomicWrite(record.filePath, json(intent));
        injectFault(`global-apply-after-${request.state}`, { intentId: intent.intentId });
        injectFault("journal-after-intent-transition", { intentId: intent.intentId, state: request.state });
        return { ok: true, duplicate: false, intent };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-intent-transition-failed") };
    }
  }

  function settleGlobalDecisionUnlocked(intentRecord, request, { succeeded, reason }) {
    let intent = intentRecord.intent;
    const existingOutcomeRecord = readGlobalDecisionOutcomesUnlocked().find(({ outcome }) => outcome.intentId === intent.intentId);
    if (existingOutcomeRecord) {
      const outcomeSucceeded = existingOutcomeRecord.outcome.state === "succeeded";
      if (outcomeSucceeded !== succeeded) return persistedGlobalOutcomeResult(existingOutcomeRecord.outcome, { intent });
      const terminalState = outcomeSucceeded ? "completed" : "failed-closed";
      if (intent.state !== terminalState) {
        intent = makeGlobalApplyIntent(
          { ...intent, state: terminalState, temporaryName: null, updatedAt: Math.max(intent.updatedAt, existingOutcomeRecord.outcome.completedAt) },
          { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() },
        );
        assertGlobalQuotaUnlocked(new Map([[path.resolve(intentRecord.filePath), json(intent)]]));
        atomicWrite(intentRecord.filePath, json(intent));
      }
      return persistedGlobalOutcomeResult(existingOutcomeRecord.outcome, { intent });
    }
    if (succeeded && intent.state !== "readback-verified") throw new Error("global-apply-intent-stage-mismatch");
    if (!succeeded && ["completed", "failed-closed"].includes(intent.state)) throw new Error("global-apply-intent-terminal");
    const recommendationRecord = readGlobalRecommendationsUnlocked().find(({ recommendation }) => recommendation.recommendationId === intent.recommendationId);
    if (!recommendationRecord) throw new Error("global-recommendation-not-found");
    let recommendation = recommendationRecord.recommendation;
    const expectedPrior = intent.action === "apply" ? "approved" : "undo-approved";
    const nextState = succeeded ? (intent.action === "apply" ? "applied" : "rolled-back") : "failed-closed";
    const actorRole = succeeded ? "applier" : "policy";
    const timestamp = intent.updatedAt;
    const identityOptions = { forbiddenIdentityValues: globalDecisionIdentityFirewallValues(request.forbiddenIdentityValues) };
    const decision = makeGlobalDecision({
      recommendationId: recommendation.recommendationId,
      supportSetHash: recommendation.supportSetHash,
      targetBindingHash: recommendation.targetBinding.bindingHash,
      targetHash: intent.action === "apply" ? intent.priorHash : intent.appliedHash,
      proposedContentHash: recommendation.proposedContentHash,
      decisionVersion: intent.decision.decisionVersion + 1,
      actorRole,
      timestamp,
      nonce: `global-${actorRole}-${intent.intentId}`,
      priorState: expectedPrior,
      newState: nextState,
    }, identityOptions);
    let recommendationChanged = false;
    if (recommendation.state === expectedPrior && recommendation.decisionVersion + 1 === decision.decisionVersion) {
      const transitioned = transitionGlobalRecommendation(recommendation, decision, Math.max(request.nowMs, timestamp));
      if (!transitioned.ok) throw new Error(transitioned.error);
      recommendation = transitioned.state;
      recommendationChanged = true;
    } else if (recommendation.state !== nextState || recommendation.decisionVersion !== decision.decisionVersion
        || !recommendation.burnedNonceHashes.includes(hashContent(decision.nonce))) {
      throw new Error("global-outcome-recommendation-drift");
    }
    const audit = makeGlobalAuditEvent({
      kind: succeeded ? intent.action : "failure",
      recommendationId: intent.recommendationId,
      actorRole,
      timestamp,
      supportSetHash: intent.supportSetHash,
      targetBindingHash: intent.targetBindingHash,
      proposedContentHash: intent.appliedHash,
      decisionVersion: decision.decisionVersion,
      outcome: succeeded ? "succeeded" : "failed-closed",
    }, identityOptions);
    const outcome = makeGlobalDecisionOutcome({
      intentId: intent.intentId,
      action: intent.action,
      recommendationId: intent.recommendationId,
      decisionVersion: decision.decisionVersion,
      state: succeeded ? "succeeded" : "failed-closed",
      priorHash: intent.priorHash,
      appliedHash: intent.appliedHash,
      auditId: audit.auditId,
      completedAt: timestamp,
      reason,
    }, identityOptions);
    const decisionPath = globalHashRecordPath(globalDecisionsDir, globalDecisionId(decision));
    const auditPath = globalHashRecordPath(globalAuditsDir, audit.auditId);
    const outcomePath = globalHashRecordPath(globalDecisionOutcomesDir, outcome.outcomeId);
    const terminalIntent = transitionGlobalApplyIntent(intent, { state: succeeded ? "completed" : "failed-closed", temporaryName: null }, Math.max(request.nowMs, timestamp));
    const changes = new Map([
      [path.resolve(decisionPath), json(decision)],
      [path.resolve(auditPath), json(audit)],
      [path.resolve(outcomePath), json(outcome)],
      [path.resolve(intentRecord.filePath), json(terminalIntent)],
    ]);
    if (recommendationChanged) changes.set(path.resolve(recommendationRecord.filePath), json(recommendation));
    assertGlobalQuotaUnlocked(changes);
    if (recommendationChanged) {
      injectFault("global-outcome-before-recommendation-cas", { intentId: intent.intentId });
      atomicWrite(recommendationRecord.filePath, json(recommendation));
      injectFault("global-outcome-after-recommendation-cas", { intentId: intent.intentId });
      injectFault("journal-after-outcome-recommendation-cas", { intentId: intent.intentId });
    }
    exclusiveJsonWrite(decisionPath, decision, (value) => makeGlobalDecision(value, identityOptions), "global-decision", MAX_GLOBAL_DECISION_RECORD_BYTES);
    injectFault("global-outcome-after-decision", { intentId: intent.intentId });
    injectFault("journal-after-outcome-decision", { intentId: intent.intentId });
    exclusiveJsonWrite(auditPath, audit, (value) => makeGlobalAuditEvent(value, identityOptions), "global-audit", MAX_GLOBAL_DECISION_RECORD_BYTES);
    injectFault("global-outcome-after-audit", { intentId: intent.intentId });
    injectFault("journal-after-outcome-audit", { intentId: intent.intentId });
    exclusiveJsonWrite(outcomePath, outcome, (value) => makeGlobalDecisionOutcome(value, identityOptions), "global-decision-outcome", MAX_GLOBAL_DECISION_RECORD_BYTES);
    injectFault("global-outcome-after-record", { intentId: intent.intentId });
    injectFault("journal-after-outcome-record", { intentId: intent.intentId });
    intent = terminalIntent;
    assertGlobalQuotaUnlocked(new Map([[path.resolve(intentRecord.filePath), json(intent)]]));
    atomicWrite(intentRecord.filePath, json(intent));
    injectFault("global-outcome-after-intent", { intentId: intent.intentId });
    injectFault("journal-after-outcome-intent", { intentId: intent.intentId });
    return { ok: true, duplicate: false, intent, recommendation, decision, audit, outcome };
  }

  function settleGlobalDecision(request, succeeded) {
    try {
      return withMutationLock(() => {
        const expected = succeeded
          ? [["intentId", "leaseKeyHash", "nowMs", "ownerToken"]]
          : [
            ["intentId", "leaseKeyHash", "nowMs", "ownerToken", "reason"],
            ["forbiddenIdentityValues", "intentId", "leaseKeyHash", "nowMs", "ownerToken", "reason"],
          ];
        if (!request || typeof request !== "object" || Array.isArray(request)
            || !expected.some((keys) => Object.keys(request).sort().join(",") === keys.sort().join(","))
            || !Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
          throw new Error(succeeded ? "invalid-global-completion-request" : "invalid-global-failure-request");
        }
        const intentRecord = readGlobalApplyIntentsUnlocked().find(({ intent }) => intent.intentId === request.intentId);
        if (!intentRecord) throw new Error("global-apply-intent-not-found");
        globalDecisionLeaseUnlocked(intentRecord.intent, request.leaseKeyHash, request.ownerToken, request.nowMs);
        const reason = succeeded
          ? (intentRecord.intent.action === "apply" ? "applied" : "undone")
          : globalDecisionOutcomeReason(request.reason);
        return settleGlobalDecisionUnlocked(intentRecord, request, { succeeded, reason });
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, succeeded ? "global-decision-completion-failed" : "global-decision-failure-write-failed") };
    }
  }

  function readGlobalDecisions() {
    return withMutationLock(() => readGlobalDecisionsUnlocked().map(({ decision }) => decision));
  }

  function readGlobalApplyIntents() {
    return withMutationLock(() => readGlobalApplyIntentsUnlocked().map(({ intent }) => intent));
  }

  function readGlobalSkillSnapshots() {
    return withMutationLock(() => readGlobalSkillSnapshotsUnlocked().map(({ snapshot }) => snapshot));
  }

  function readGlobalDecisionOutcomes() {
    return withMutationLock(() => readGlobalDecisionOutcomesUnlocked().map(({ outcome }) => outcome));
  }

  function readGlobalAudits() {
    return withMutationLock(() => readGlobalAuditsUnlocked().map(({ audit }) => audit));
  }

  function globalSynthesisSuppressorReason(settings, suppressors) {
    if (!suppressors || typeof suppressors !== "object" || Array.isArray(suppressors)
        || Object.keys(suppressors).sort().join(",") !== "bootValidated,circuitBreakerOpen,hostSupported,processExcluded") {
      return "global-synthesis-suppressors-required";
    }
    if (Object.values(suppressors).some((value) => typeof value !== "boolean")) return "global-synthesis-suppressors-invalid";
    if (!suppressors.hostSupported) return "host-unsupported";
    if (!suppressors.bootValidated) return "boot-not-validated";
    if (settings.global.killSwitchActive) return "kill-switch";
    if (settings.global.paused) return "paused";
    if (settings.repo.excluded || suppressors.processExcluded) return "excluded";
    if (suppressors.circuitBreakerOpen) return "circuit-breaker";
    return null;
  }

  function globalSynthesisStateUnlocked({ candidateId, supportSetHash, targetBindingHash, leaseKeyHash, ownerToken, suppressors, nowMs, expectedCandidateState, automationStamp, rootPolicy }) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid-global-synthesis-time");
    const candidateRecord = readGlobalCandidatesUnlocked().find(({ candidate }) => candidate.candidateId === candidateId);
    const automation = automationStamp === undefined && candidateRecord?.candidate.automationGeneration === undefined
      ? getAutomationStateUnlocked()
      : assertAutomationStampUnlocked(automationStamp);
    if (!automation.ok || !automation.enabled) throw new Error(automation.reason ?? "automatic-recommendations-disabled");
    const settings = { global: automation.global, repo: automation.repo };
    if (!settings.global.consent.sanitizedExcerpts || !settings.global.consent.crossRepoAggregation) {
      throw new Error("global-synthesis-consent-required");
    }
    const suppressed = globalSynthesisSuppressorReason(settings, suppressors);
    if (suppressed) throw new Error(suppressed);
    if (!rootPolicy && !settings.global.globalRootPolicy) throw new Error("global-root-policy-required");
    const policy = makeGlobalRootPolicy(rootPolicy ?? settings.global.globalRootPolicy);
    if (!candidateRecord || candidateRecord.candidate.supportSetHash !== supportSetHash
        || candidateRecord.candidate.targetBindingHash !== targetBindingHash
        || (candidateRecord.candidate.automationGeneration !== undefined
          && candidateRecord.candidate.automationGeneration !== automation.epoch.generation)
        || candidateRecord.candidate.state !== expectedCandidateState) {
      throw new Error("global-candidate-drift");
    }
    const supportRecord = readGlobalSupportSetsUnlocked().find(({ supportSet }) => supportSet.supportSetHash === supportSetHash);
    if (!supportRecord || supportRecord.supportSet.candidateId !== candidateId
        || supportRecord.supportSet.targetBinding.bindingHash !== targetBindingHash
        || supportRecord.supportSet.automationGeneration !== candidateRecord.candidate.automationGeneration
        || supportRecord.supportSet.expiresAt <= nowMs) {
      throw new Error("global-support-drift");
    }
    const binding = makeCandidateTargetBinding(supportRecord.supportSet.targetBinding, policy);
    if (binding.bindingHash !== targetBindingHash) throw new Error("global-target-binding-drift");
    const eligibility = evaluateGlobalSupportEligibility(supportRecord.supportSet, policy);
    if (!eligibility.eligible || eligibility.route !== candidateRecord.candidate.eligibilityRoute) {
      throw new Error("global-support-ineligible");
    }
    const leaseRecord = readGlobalLeaseUnlocked(leaseKeyHash);
    if (!leaseRecord || leaseRecord.lease.state !== "active" || leaseRecord.lease.expiresAt <= nowMs
        || leaseRecord.lease.leaseKind !== "candidate-synthesis" || leaseRecord.lease.ownerToken !== ownerToken) {
      throw new Error("global-candidate-synthesis-lease-invalid");
    }
    return { automation, settings, policy, candidateRecord, supportRecord, binding, eligibility, leaseRecord };
  }

  function globalSynthesisPacketUnlocked(supportSet, nowMs) {
    const supportIds = new Set(supportSet.contributionIds);
    const bindings = new Map();
    const privateIdentityValues = candidateSupportFactsUnlocked(nowMs)
      .filter((fact) => supportIds.has(fact.contributionId)
        && fact.automationGeneration === supportSet.automationGeneration)
      .flatMap((fact) => fact.privateIdentityValues);
    for (const targetStateDir of projectStateDirectoriesUnlocked()) {
      const transactions = new Map(readContributionTransactionsUnlocked(targetStateDir)
        .filter(({ transaction }) => transaction.intent.state === "committed")
        .map(({ transaction }) => [transaction.intent.contributionId, transaction]));
      const capsules = new Map(readEvidenceCapsulesUnlocked(path.join(targetStateDir, "evidence-capsules.jsonl"))
        .map((capsule) => [capsule.capsuleId, capsule]));
      for (const { link } of readContributionLinksUnlocked(targetStateDir)) {
        if (link.state !== "active" || !supportIds.has(link.contributionId)) continue;
        const transaction = transactions.get(link.contributionId);
        const capsule = capsules.get(link.capsuleId);
        if (!transaction || transaction.intent.intentId !== link.intentId
            || transaction.intent.incidentId !== link.incidentId
            || transaction.intent.capsuleId !== link.capsuleId
            || transaction.intent.evidenceDomainId !== link.evidenceDomainId
            || transaction.intent.automationGeneration !== supportSet.automationGeneration
            || link.automationGeneration !== supportSet.automationGeneration
            || transaction.contribution.automationGeneration !== supportSet.automationGeneration
            || !capsule || capsule.incidentId !== link.incidentId
            || capsule.automationGeneration !== supportSet.automationGeneration
            || capsule.expiresAt <= nowMs) {
          throw new Error("global-evidence-packet-support-unavailable");
        }
        if (bindings.has(link.contributionId)) throw new Error("global-evidence-packet-support-ambiguous");
        bindings.set(link.contributionId, { link, capsule });
        privateIdentityValues.push(
          path.basename(targetStateDir),
          link.incidentId,
          link.capsuleId,
          link.clusterId,
          link.evidenceDomainId,
        );
      }
    }
    if (bindings.size !== supportIds.size) throw new Error("global-evidence-packet-support-unavailable");
    const domains = new Map();
    for (const contributionId of [...supportIds].sort()) {
      const item = bindings.get(contributionId);
      const current = domains.get(item.link.evidenceDomainId);
      if (!current || contributionId < current.contributionId) domains.set(item.link.evidenceDomainId, { contributionId, capsule: item.capsule });
    }
    const packet = [];
    for (const domainId of [...domains.keys()].sort()) {
      if (packet.length >= 8) break;
      const capsule = domains.get(domainId).capsule;
      const entry = Object.freeze({ receiptType: capsule.receiptType, summary: capsule.summary });
      const proposed = [...packet, entry];
      if (Buffer.byteLength(JSON.stringify(proposed), "utf8") > 4 * 1024) break;
      packet.push(entry);
    }
    if (!packet.length) throw new Error("global-evidence-packet-empty");
    return {
      packet: Object.freeze(packet),
      privateIdentityValues: [...new Set(privateIdentityValues)],
      excerptValues: [...new Set([...bindings.values()].map(({ capsule }) => capsule.summary))],
    };
  }

  function assertGlobalSynthesisBudgetUnlocked(settings, nowMs, { admitted }) {
    const used = readGlobalSynthesisAttemptsUnlocked()
      .filter(({ attempt }) => attempt.admittedAt >= nowMs - DAY_MS).length;
    const limit = Math.min(
      settings.global.budgets.synthesisPerDay,
      settings.repo.budgets.synthesisPerDay ?? settings.global.budgets.synthesisPerDay,
    );
    if (admitted ? used > limit : used >= limit) throw new Error("synthesis-budget-exhausted");
    return { used, limit };
  }

  function validGlobalSynthesisRequest(request, expected) {
    if (!request || typeof request !== "object" || Array.isArray(request)) return false;
    const allowed = new Set(expected);
    const required = expected.filter((key) => !["automationStamp", "rootPolicy"].includes(key));
    return Object.keys(request).every((key) => allowed.has(key))
      && required.every((key) => Object.hasOwn(request, key));
  }

  function admitGlobalSynthesisAttempt(request) {
    try {
      return withMutationLock(() => {
        const expected = ["attemptId", "automationStamp", "candidateId", "leaseKeyHash", "nowMs", "ownerToken", "rootPolicy", "supportSetHash", "suppressors", "targetBindingHash"];
        if (!validGlobalSynthesisRequest(request, expected)) {
          return { ok: false, reason: "invalid-global-synthesis-admission" };
        }
        const state = globalSynthesisStateUnlocked({ ...request, expectedCandidateState: "eligible" });
        const prior = readGlobalSynthesisAttemptsUnlocked().find(({ attempt }) =>
          attempt.candidateId === request.candidateId && attempt.supportSetHash === request.supportSetHash);
        if (prior) return { ok: false, reason: "global-synthesis-already-admitted", attempt: prior.attempt };
        assertGlobalSynthesisBudgetUnlocked(state.settings, request.nowMs, { admitted: false });
        const evidence = globalSynthesisPacketUnlocked(state.supportRecord.supportSet, request.nowMs);
        const attempt = makeGlobalSynthesisAttempt({
          attemptId: request.attemptId,
          candidateId: request.candidateId,
          supportSetHash: request.supportSetHash,
          targetBindingHash: request.targetBindingHash,
          state: "admitted",
          admittedAt: request.nowMs,
          updatedAt: request.nowMs,
          ...(state.candidateRecord.candidate.automationGeneration === undefined
            ? {}
            : { automationGeneration: state.automation.epoch.generation }),
        }, { forbiddenIdentityValues: evidence.privateIdentityValues });
        const candidate = transitionGlobalCandidateState(state.candidateRecord.candidate, {
          state: "synthesis-pending",
          supportSetHash: request.supportSetHash,
          eligibilityRoute: state.eligibility.route,
        }, request.nowMs);
        const attemptPath = globalOpaqueRecordPath(globalSynthesisAttemptsDir, attempt.attemptId);
        const changes = new Map([
          [path.resolve(attemptPath), json(attempt)],
          [path.resolve(state.candidateRecord.filePath), json(candidate)],
        ]);
        assertGlobalQuotaUnlocked(changes);
        exclusiveJsonWrite(attemptPath, attempt, makeGlobalSynthesisAttempt, "global-synthesis-attempt");
        injectFault("global-synthesis-after-attempt-admission", { attemptId: attempt.attemptId });
        atomicWrite(state.candidateRecord.filePath, json(candidate));
        injectFault("global-synthesis-after-candidate-pending", { attemptId: attempt.attemptId });
        return { ok: true, attempt, candidate, packet: evidence.packet };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-synthesis-admission-failed") };
    }
  }

  function dispatchGlobalSynthesisAttempt(request) {
    try {
      return withMutationLock(() => {
        const expected = ["attemptId", "automationStamp", "candidateId", "leaseKeyHash", "nowMs", "ownerToken", "rootPolicy", "supportSetHash", "suppressors", "targetBindingHash"];
        if (!validGlobalSynthesisRequest(request, expected)) {
          return { ok: false, reason: "invalid-global-synthesis-dispatch" };
        }
        const state = globalSynthesisStateUnlocked({ ...request, expectedCandidateState: "synthesis-pending" });
        const current = readGlobalSynthesisAttemptsUnlocked().find(({ attempt }) => attempt.attemptId === request.attemptId);
        if (!current || current.attempt.candidateId !== request.candidateId
            || current.attempt.supportSetHash !== request.supportSetHash
            || current.attempt.targetBindingHash !== request.targetBindingHash
            || current.attempt.automationGeneration !== state.candidateRecord.candidate.automationGeneration
            || current.attempt.state !== "admitted") throw new Error("global-synthesis-attempt-drift");
        assertGlobalSynthesisBudgetUnlocked(state.settings, request.nowMs, { admitted: true });
        const evidence = globalSynthesisPacketUnlocked(state.supportRecord.supportSet, request.nowMs);
        const attempt = transitionGlobalSynthesisAttempt(current.attempt, "dispatched", request.nowMs);
        const source = json(attempt);
        assertGlobalQuotaUnlocked(new Map([[path.resolve(current.filePath), source]]));
        atomicWrite(current.filePath, source);
        injectFault("global-synthesis-after-dispatch-marker", { attemptId: attempt.attemptId });
        return { ok: true, attempt, packet: evidence.packet };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-synthesis-dispatch-failed") };
    }
  }

  function revalidateGlobalSynthesisAttempt(request) {
    try {
      return withMutationLock(() => {
        const expected = ["attemptId", "automationStamp", "candidateId", "leaseKeyHash", "nowMs", "ownerToken", "rootPolicy", "supportSetHash", "suppressors", "targetBindingHash"];
        if (!validGlobalSynthesisRequest(request, expected)) {
          return { ok: false, reason: "invalid-global-synthesis-revalidation" };
        }
        const state = globalSynthesisStateUnlocked({ ...request, expectedCandidateState: "synthesis-pending" });
        const current = readGlobalSynthesisAttemptsUnlocked().find(({ attempt }) => attempt.attemptId === request.attemptId);
        if (!current || current.attempt.state !== "dispatched" || current.attempt.candidateId !== request.candidateId
            || current.attempt.supportSetHash !== request.supportSetHash
            || current.attempt.targetBindingHash !== request.targetBindingHash
            || current.attempt.automationGeneration !== state.candidateRecord.candidate.automationGeneration) throw new Error("global-synthesis-attempt-drift");
        assertGlobalSynthesisBudgetUnlocked(state.settings, request.nowMs, { admitted: true });
        const evidence = globalSynthesisPacketUnlocked(state.supportRecord.supportSet, request.nowMs);
        return { ok: true, attempt: current.attempt, packet: evidence.packet };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-synthesis-revalidation-failed") };
    }
  }

  function failGlobalSynthesisAttempt(attemptId, nowMs = now()) {
    try {
      return withMutationLock(() => {
        const current = readGlobalSynthesisAttemptsUnlocked().find(({ attempt }) => attempt.attemptId === attemptId);
        if (!current) return { ok: false, reason: "global-synthesis-attempt-not-found" };
        if (current.attempt.state === "failed-closed") return { ok: true, duplicate: true, attempt: current.attempt };
        if (current.attempt.state === "completed") return { ok: false, reason: "global-synthesis-attempt-completed" };
        return { ok: true, ...failGlobalSynthesisAttemptUnlocked(attemptId, nowMs) };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-synthesis-failure-write-failed") };
    }
  }

  function completeGlobalSynthesisAttempt(request) {
    try {
      return withMutationLock(() => {
        const expected = ["attemptId", "automationStamp", "candidateId", "leaseKeyHash", "nowMs", "ownerToken", "proposedContent", "recommendation", "rootPolicy", "supportSetHash", "suppressors", "targetBindingHash"];
        if (!validGlobalSynthesisRequest(request, expected)) {
          return { ok: false, reason: "invalid-global-synthesis-completion" };
        }
        const state = globalSynthesisStateUnlocked({ ...request, expectedCandidateState: "synthesis-pending" });
        const current = readGlobalSynthesisAttemptsUnlocked().find(({ attempt }) => attempt.attemptId === request.attemptId);
        if (!current || current.attempt.state !== "dispatched" || current.attempt.candidateId !== request.candidateId
            || current.attempt.supportSetHash !== request.supportSetHash
            || current.attempt.targetBindingHash !== request.targetBindingHash
            || current.attempt.automationGeneration !== state.candidateRecord.candidate.automationGeneration) throw new Error("global-synthesis-attempt-drift");
        assertGlobalSynthesisBudgetUnlocked(state.settings, request.nowMs, { admitted: true });
        const evidence = globalSynthesisPacketUnlocked(state.supportRecord.supportSet, request.nowMs);
        if (typeof request.proposedContent !== "string" || hashContent(request.proposedContent) !== request.recommendation?.proposedContentHash) {
          throw new Error("global-recommendation-content-hash-mismatch");
        }
        const forbidden = [...new Set(evidence.privateIdentityValues.flatMap((value) => [value, hashContent(value)]))];
        if ([...forbidden, ...evidence.excerptValues].some((value) => value && request.proposedContent.includes(value))) {
          throw new Error("global-recommendation-content-privacy-rejected");
        }
        const targetBinding = makeRecommendationTargetBinding(request.recommendation?.targetBinding, state.binding, state.policy);
        if (targetBinding.bindingHash !== request.recommendation.targetBinding.bindingHash) throw new Error("global-target-binding-drift");
        const recommendation = makeGlobalRecommendation(request.recommendation, {
          forbiddenIdentityValues: evidence.privateIdentityValues,
        });
        if (recommendation.candidateId !== request.candidateId
            || recommendation.supportSetHash !== request.supportSetHash
            || recommendation.candidateTargetBindingHash !== request.targetBindingHash
            || recommendation.state !== "pending" || !recommendation.criticPassed || !recommendation.validDeterministic) {
          throw new Error("global-recommendation-binding-mismatch");
        }
        const existing = readGlobalRecommendationsUnlocked().find(({ recommendation: item }) =>
          item.candidateId === request.candidateId && item.supportSetHash === request.supportSetHash);
        if (existing && !sameCanonicalRecord(existing.recommendation, recommendation)) throw new Error("global-recommendation-conflict");
        const encoded = Buffer.from(request.proposedContent, "utf8").toString("base64");
        const parts = encoded.match(/.{1,400}/gu) ?? [""];
        const chunks = parts.map((content, chunkIndex) => makeGlobalRecommendationContent({
          recommendationId: recommendation.recommendationId,
          contentHash: recommendation.proposedContentHash,
          contentEncoding: "base64",
          chunkIndex,
          chunkCount: parts.length,
          content,
        }, { forbiddenIdentityValues: evidence.privateIdentityValues }));
        const candidate = transitionGlobalCandidateState(state.candidateRecord.candidate, {
          state: "recommended",
          supportSetHash: request.supportSetHash,
          eligibilityRoute: state.eligibility.route,
        }, request.nowMs);
        const attempt = transitionGlobalSynthesisAttempt(current.attempt, "completed", request.nowMs);
        const recommendationPath = globalHashRecordPath(globalRecommendationsDir, recommendation.recommendationId);
        const changes = new Map([
          [path.resolve(recommendationPath), json(recommendation)],
          [path.resolve(state.candidateRecord.filePath), json(candidate)],
          [path.resolve(current.filePath), json(attempt)],
        ]);
        chunks.forEach((chunk) => changes.set(path.resolve(recommendationContentPath(recommendation.recommendationId, chunk.chunkIndex)), json(chunk)));
        assertGlobalQuotaUnlocked(changes);
        for (const chunk of chunks) {
          const filePath = recommendationContentPath(recommendation.recommendationId, chunk.chunkIndex);
          if (!existsSync(filePath)) exclusiveJsonWrite(filePath, chunk, makeGlobalRecommendationContent, "global-recommendation-content");
          injectFault("global-synthesis-after-content-chunk", { attemptId: attempt.attemptId, chunkIndex: chunk.chunkIndex });
        }
        if (!existing) exclusiveJsonWrite(recommendationPath, recommendation, makeGlobalRecommendation, "global-recommendation");
        injectFault("global-synthesis-after-recommendation", { attemptId: attempt.attemptId });
        atomicWrite(state.candidateRecord.filePath, json(candidate));
        injectFault("global-synthesis-after-candidate-recommended", { attemptId: attempt.attemptId });
        atomicWrite(current.filePath, json(attempt));
        injectFault("global-synthesis-after-completion", { attemptId: attempt.attemptId });
        return { ok: true, attempt, candidate, recommendation };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-synthesis-completion-failed") };
    }
  }

  function completeGlobalSynthesisNoChange(request) {
    try {
      return withMutationLock(() => {
        const expected = ["attemptId", "automationStamp", "candidateId", "leaseKeyHash", "nowMs", "ownerToken", "rootPolicy", "supportSetHash", "suppressors", "targetBindingHash"];
        if (!validGlobalSynthesisRequest(request, expected)) {
          return { ok: false, reason: "invalid-global-synthesis-no-change-completion" };
        }
        const state = globalSynthesisStateUnlocked({ ...request, expectedCandidateState: "synthesis-pending" });
        const current = readGlobalSynthesisAttemptsUnlocked().find(({ attempt }) => attempt.attemptId === request.attemptId);
        if (!current || current.attempt.state !== "dispatched" || current.attempt.candidateId !== request.candidateId
            || current.attempt.supportSetHash !== request.supportSetHash
            || current.attempt.targetBindingHash !== request.targetBindingHash
            || current.attempt.automationGeneration !== state.candidateRecord.candidate.automationGeneration) throw new Error("global-synthesis-attempt-drift");
        assertGlobalSynthesisBudgetUnlocked(state.settings, request.nowMs, { admitted: true });
        globalSynthesisPacketUnlocked(state.supportRecord.supportSet, request.nowMs);
        const candidate = transitionGlobalCandidateState(state.candidateRecord.candidate, {
          state: "no-change",
          supportSetHash: request.supportSetHash,
          eligibilityRoute: state.eligibility.route,
        }, request.nowMs);
        const attempt = transitionGlobalSynthesisAttempt(current.attempt, "completed", request.nowMs);
        const changes = new Map([
          [path.resolve(state.candidateRecord.filePath), json(candidate)],
          [path.resolve(current.filePath), json(attempt)],
        ]);
        assertGlobalQuotaUnlocked(changes);
        atomicWrite(state.candidateRecord.filePath, json(candidate));
        injectFault("global-synthesis-after-candidate-no-change", { attemptId: attempt.attemptId });
        atomicWrite(current.filePath, json(attempt));
        injectFault("global-synthesis-after-no-change-completion", { attemptId: attempt.attemptId });
        return { ok: true, attempt, candidate };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-synthesis-no-change-completion-failed") };
    }
  }

  function removeGlobalRecommendationUnlocked(recommendation) {
    let removed = 0;
    for (const { filePath } of readGlobalRecommendationChunksUnlocked(recommendation.recommendationId)) {
      rmSync(filePath, { force: true });
      removed += 1;
    }
    const filePath = globalHashRecordPath(globalRecommendationsDir, recommendation.recommendationId);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
      removed += 1;
    }
    return removed;
  }

  function cleanupOrphanGlobalRecommendationContentUnlocked() {
    const recommendations = new Map(readGlobalRecommendationsUnlocked()
      .map(({ recommendation }) => [recommendation.recommendationId, recommendation]));
    let removed = 0;
    for (const filePath of safeTreeFiles(globalRecommendationContentDir)) {
      const parts = path.relative(globalRecommendationContentDir, filePath).split(path.sep);
      const recommendationId = parts[1];
      if (parts.length === 3 && /^[a-f0-9]{2}$/u.test(parts[0])
          && /^[a-f0-9]{64}$/u.test(recommendationId)
          && parts[0] === recommendationId.slice(0, 2)
          && /^\d{6}\.json$/u.test(parts[2])
          && recommendations.has(recommendationId)) continue;
      rmSync(filePath, { force: true });
      removed += 1;
    }
    return removed;
  }

  function recoverGlobalSynthesisAttempts() {
    try {
      return withMutationLock(() => {
        const recovered = [];
        let cleaned = cleanupOrphanGlobalRecommendationContentUnlocked();
        for (const { attempt } of readGlobalSynthesisAttemptsUnlocked()) {
          const matchingRecommendations = readGlobalRecommendationsUnlocked().filter(({ recommendation: item }) =>
            item.candidateId === attempt.candidateId && item.supportSetHash === attempt.supportSetHash);
          if (attempt.state === "failed-closed") {
            for (const { recommendation } of matchingRecommendations) cleaned += removeGlobalRecommendationUnlocked(recommendation);
            continue;
          }
          if (attempt.state === "completed") {
            const candidate = readGlobalCandidatesUnlocked().find(({ candidate: item }) => item.candidateId === attempt.candidateId)?.candidate;
            const validNoChange = candidate?.state === "no-change"
              && candidate.supportSetHash === attempt.supportSetHash
              && matchingRecommendations.length === 0;
            if (!validNoChange && (matchingRecommendations.length !== 1
                || decodeGlobalRecommendationContentUnlocked(matchingRecommendations[0].recommendation.recommendationId) === null)) {
              throw new Error("completed-global-synthesis-state-incomplete");
            }
            continue;
          }
          const leaseKeyHash = hashContent(`self-evolve-global-candidate-synthesis-lease-v1\n${attempt.candidateId}\n${attempt.supportSetHash}`);
          const lease = readGlobalLeaseUnlocked(leaseKeyHash)?.lease;
          if (lease?.state === "active" && lease.expiresAt > now()) {
            recovered.push({ attemptId: attempt.attemptId, state: attempt.state, deferred: true });
            continue;
          }
          const candidateRecord = readGlobalCandidatesUnlocked().find(({ candidate }) => candidate.candidateId === attempt.candidateId);
          if (matchingRecommendations.length === 0 && candidateRecord?.candidate.state === "no-change"
              && candidateRecord.candidate.supportSetHash === attempt.supportSetHash) {
            const currentAttempt = readGlobalSynthesisAttemptsUnlocked().find(({ attempt: item }) => item.attemptId === attempt.attemptId);
            if (currentAttempt?.attempt.state === "dispatched") {
              const completed = transitionGlobalSynthesisAttempt(currentAttempt.attempt, "completed", now());
              atomicWrite(currentAttempt.filePath, json(completed));
              recovered.push({ attemptId: attempt.attemptId, state: "completed", noChange: true });
              continue;
            }
          }
          const recommendation = matchingRecommendations[0]?.recommendation ?? null;
          if (recommendation && decodeGlobalRecommendationContentUnlocked(recommendation.recommendationId) !== null) {
            const currentAttempt = readGlobalSynthesisAttemptsUnlocked().find(({ attempt: item }) => item.attemptId === attempt.attemptId);
            if (currentAttempt?.attempt.state === "dispatched"
                && ["synthesis-pending", "recommended"].includes(candidateRecord?.candidate.state)) {
              const completed = transitionGlobalSynthesisAttempt(currentAttempt.attempt, "completed", now());
              if (candidateRecord.candidate.state === "synthesis-pending") {
                const recommended = transitionGlobalCandidateState(candidateRecord.candidate, {
                  state: "recommended",
                  supportSetHash: attempt.supportSetHash,
                  eligibilityRoute: candidateRecord.candidate.eligibilityRoute,
                }, now());
                atomicWrite(candidateRecord.filePath, json(recommended));
              }
              atomicWrite(currentAttempt.filePath, json(completed));
              recovered.push({ attemptId: attempt.attemptId, state: "completed" });
              continue;
            }
          }
          for (const { recommendation: item } of matchingRecommendations) cleaned += removeGlobalRecommendationUnlocked(item);
          const failed = failGlobalSynthesisAttemptUnlocked(attempt.attemptId, now());
          recovered.push({ attemptId: attempt.attemptId, state: failed.attempt.state });
        }
        cleaned += cleanupOrphanGlobalRecommendationContentUnlocked();
        return { ok: true, recovered, cleaned };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-synthesis-recovery-failed"), recovered: [], cleaned: 0 };
    }
  }

  function failGlobalSynthesisAttemptUnlocked(attemptId, nowMs) {
    const current = readGlobalSynthesisAttemptsUnlocked().find(({ attempt }) => attempt.attemptId === attemptId);
    if (!current || ["completed", "failed-closed"].includes(current.attempt.state)) return { attempt: current?.attempt ?? null };
    const candidateRecord = readGlobalCandidatesUnlocked().find(({ candidate }) => candidate.candidateId === current.attempt.candidateId);
    if (candidateRecord?.candidate.state === "no-change"
        && candidateRecord.candidate.supportSetHash === current.attempt.supportSetHash
        && current.attempt.state === "dispatched") {
      const attempt = transitionGlobalSynthesisAttempt(current.attempt, "completed", nowMs);
      atomicWrite(current.filePath, json(attempt));
      return { attempt, candidate: candidateRecord.candidate };
    }
    const attempt = transitionGlobalSynthesisAttempt(current.attempt, "failed-closed", nowMs);
    let candidate = candidateRecord?.candidate ?? null;
    if (candidate?.state === "eligible") candidate = transitionGlobalCandidateState(candidate, {
      state: "synthesis-pending", supportSetHash: candidate.supportSetHash, eligibilityRoute: candidate.eligibilityRoute,
    }, nowMs);
    if (candidate?.state === "synthesis-pending") candidate = transitionGlobalCandidateState(candidate, {
      state: "failed-closed", supportSetHash: candidate.supportSetHash, eligibilityRoute: candidate.eligibilityRoute,
    }, nowMs);
    if (candidate?.state === "recommended") candidate = transitionGlobalCandidateState(candidate, {
      state: "failed-closed", supportSetHash: candidate.supportSetHash, eligibilityRoute: candidate.eligibilityRoute,
    }, nowMs);
    atomicWrite(current.filePath, json(attempt));
    if (candidate && candidateRecord) atomicWrite(candidateRecord.filePath, json(candidate));
    return { attempt, candidate };
  }

  function settleAutomationGenerationUnlocked(closedGeneration, nowMs) {
    const belongsToClosedGeneration = (record) => record.automationGeneration === closedGeneration
      || (closedGeneration === 1 && record.automationGeneration === undefined);
    let attempts = 0;
    for (const current of readGlobalSynthesisAttemptsUnlocked()) {
      if (!belongsToClosedGeneration(current.attempt)
          || !["admitted", "dispatched"].includes(current.attempt.state)) continue;
      const attempt = transitionGlobalSynthesisAttempt(
        current.attempt,
        "failed-closed",
        Math.max(nowMs, current.attempt.updatedAt),
      );
      injectFault("automation-before-attempt-settlement", { attemptId: attempt.attemptId, closedGeneration });
      atomicWrite(current.filePath, json(attempt));
      injectFault("automation-after-attempt-settlement", { attemptId: attempt.attemptId, closedGeneration });
      attempts += 1;
    }
    let candidates = 0;
    for (const current of readGlobalCandidatesUnlocked()) {
      if (!belongsToClosedGeneration(current.candidate)
          || !["collecting", "eligible", "synthesis-pending"].includes(current.candidate.state)) continue;
      const candidate = transitionGlobalCandidateState(current.candidate, {
        state: "superseded",
        supportSetHash: current.candidate.supportSetHash,
        eligibilityRoute: current.candidate.eligibilityRoute,
      }, Math.max(nowMs, current.candidate.updatedAt));
      injectFault("automation-before-candidate-settlement", { candidateId: candidate.candidateId, closedGeneration });
      atomicWrite(current.filePath, json(candidate));
      injectFault("automation-after-candidate-settlement", { candidateId: candidate.candidateId, closedGeneration });
      candidates += 1;
    }
    return { candidates, attempts };
  }

  function readGlobalSynthesisAttempts() {
    return withMutationLock(() => readGlobalSynthesisAttemptsUnlocked().map(({ attempt }) => attempt));
  }

  function readGlobalRecommendations() {
    return withMutationLock(() => readGlobalRecommendationsUnlocked().map(({ recommendation }) => recommendation));
  }

  function readGlobalRecommendationContent(recommendationId) {
    return withMutationLock(() => decodeGlobalRecommendationContentUnlocked(recommendationId));
  }

  function readGlobalProjectionSnapshot() {
    return withMutationLock(() => {
      const recommendations = readGlobalRecommendationsUnlocked().map(({ recommendation }) => recommendation);
      const supportSets = readGlobalSupportSetsUnlocked().map(({ supportSet }) => supportSet);
      const candidates = readGlobalCandidatesUnlocked().map(({ candidate }) => candidate);
      const audits = readGlobalAuditsUnlocked().map(({ audit }) => audit);
      const contentByRecommendation = Object.fromEntries(recommendations.map((recommendation) => [
        recommendation.recommendationId,
        decodeGlobalRecommendationContentUnlocked(recommendation.recommendationId),
      ]));
      return Object.freeze({
        recommendations: Object.freeze(recommendations),
        supportSets: Object.freeze(supportSets),
        candidates: Object.freeze(candidates),
        audits: Object.freeze(audits),
        contentByRecommendation: Object.freeze(contentByRecommendation),
      });
    });
  }

  function globalRejectionPlanUnlocked(decisionValue, { identityOptions, nowMs, requirePersisted = false } = {}) {
    const decision = makeGlobalDecision(decisionValue, identityOptions);
    if (decision.actorRole !== "operator" || !["pending", "superseded"].includes(decision.priorState)
        || decision.newState !== "rejected") {
      throw new Error("invalid-global-rejection-decision");
    }
    const decisionId = globalDecisionId(decision);
    const decisions = readGlobalDecisionsUnlocked();
    const persistedDecision = decisions.find(({ decision: value }) => globalDecisionId(value) === decisionId)?.decision ?? null;
    const edgeDecisions = decisions.filter(({ decision: value }) => value.actorRole === "operator"
      && value.recommendationId === decision.recommendationId
      && value.decisionVersion === decision.decisionVersion);
    if (edgeDecisions.some(({ decision: value }) => !sameCanonicalRecord(value, decision))) {
      throw new Error("global-rejection-decision-conflict");
    }
    if (persistedDecision && !sameCanonicalRecord(persistedDecision, decision)) {
      throw new Error("global-rejection-decision-conflict");
    }
    if (requirePersisted && !persistedDecision) throw new Error("global-rejection-decision-not-found");

    const record = readGlobalRecommendationsUnlocked()
      .find(({ recommendation }) => recommendation.recommendationId === decision.recommendationId);
    if (!record) throw new Error("global-recommendation-not-found");
    let recommendation = record.recommendation;
    let recommendationChanged = false;
    if (recommendation.state === decision.priorState
        && recommendation.decisionVersion + 1 === decision.decisionVersion) {
      const transitioned = transitionGlobalRecommendation(recommendation, decision, nowMs ?? decision.timestamp);
      if (!transitioned.ok) throw new Error(transitioned.error);
      recommendation = transitioned.state;
      recommendationChanged = true;
    } else {
      const expectedTargetHash = recommendation.targetBinding.currentHash;
      if (recommendation.state !== "rejected"
          || recommendation.decisionVersion !== decision.decisionVersion
          || !recommendation.burnedNonceHashes.includes(hashContent(decision.nonce))
          || recommendation.supportSetHash !== decision.supportSetHash
          || recommendation.targetBinding.bindingHash !== decision.targetBindingHash
          || expectedTargetHash !== decision.targetHash
          || recommendation.proposedContentHash !== decision.proposedContentHash) {
        throw new Error("stale-global-decision");
      }
    }

    const audit = makeGlobalAuditEvent({
      kind: "reject",
      recommendationId: decision.recommendationId,
      actorRole: "operator",
      timestamp: decision.timestamp,
      supportSetHash: decision.supportSetHash,
      targetBindingHash: decision.targetBindingHash,
      proposedContentHash: decision.proposedContentHash,
      decisionVersion: decision.decisionVersion,
      outcome: "rejected",
    }, identityOptions);
    const audits = readGlobalAuditsUnlocked();
    const persistedAudit = audits.find(({ audit: value }) => value.auditId === audit.auditId)?.audit ?? null;
    const edgeAudits = audits.filter(({ audit: value }) => value.recommendationId === decision.recommendationId
      && value.decisionVersion === decision.decisionVersion);
    if (edgeAudits.some(({ audit: value }) => !sameCanonicalRecord(value, audit))) {
      throw new Error("global-rejection-audit-conflict");
    }
    if (persistedAudit && !sameCanonicalRecord(persistedAudit, audit)) {
      throw new Error("global-rejection-audit-conflict");
    }
    return {
      decision,
      decisionId,
      persistedDecision,
      recommendation,
      recommendationChanged,
      recommendationPath: record.filePath,
      audit,
      persistedAudit,
      decisionPath: globalHashRecordPath(globalDecisionsDir, decisionId),
      auditPath: globalHashRecordPath(globalAuditsDir, audit.auditId),
      contentPaths: readGlobalRecommendationChunksUnlocked(recommendation.recommendationId).map(({ filePath }) => filePath),
    };
  }

  function globalRejectionChanges(plan) {
    const changes = new Map();
    if (!plan.persistedDecision) changes.set(path.resolve(plan.decisionPath), json(plan.decision));
    if (plan.recommendationChanged) changes.set(path.resolve(plan.recommendationPath), json(plan.recommendation));
    if (!plan.persistedAudit) changes.set(path.resolve(plan.auditPath), json(plan.audit));
    for (const filePath of plan.contentPaths) changes.set(path.resolve(filePath), null);
    return changes;
  }

  function writeGlobalRejectionPlanUnlocked(plan) {
    if (!plan.persistedDecision) {
      exclusiveJsonWrite(
        plan.decisionPath,
        plan.decision,
        (value) => makeGlobalDecision(value, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() }),
        "global-decision",
        MAX_GLOBAL_DECISION_RECORD_BYTES,
      );
      injectFault("global-reject-after-decision", { recommendationId: plan.recommendation.recommendationId });
    }
    if (plan.recommendationChanged) {
      atomicWrite(plan.recommendationPath, json(plan.recommendation));
      injectFault("global-reject-after-recommendation", { recommendationId: plan.recommendation.recommendationId });
    }
    if (!plan.persistedAudit) {
      exclusiveJsonWrite(
        plan.auditPath,
        plan.audit,
        (value) => makeGlobalAuditEvent(value, { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() }),
        "global-audit",
        MAX_GLOBAL_DECISION_RECORD_BYTES,
      );
      injectFault("global-reject-after-audit", { recommendationId: plan.recommendation.recommendationId });
    }
    for (const filePath of plan.contentPaths) rmSync(filePath, { force: true });
    return {
      recommendationId: plan.recommendation.recommendationId,
      duplicate: Boolean(plan.persistedDecision) && !plan.recommendationChanged && Boolean(plan.persistedAudit),
      recommendation: plan.recommendation,
      decision: plan.persistedDecision ?? plan.decision,
      audit: plan.persistedAudit ?? plan.audit,
    };
  }

  function recoverGlobalRejection(decisionValue) {
    try {
      return withMutationLock(() => {
        const identityOptions = { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() };
        const plan = globalRejectionPlanUnlocked(decisionValue, { identityOptions, requirePersisted: true });
        assertGlobalQuotaUnlocked(globalRejectionChanges(plan));
        return { ok: true, ...writeGlobalRejectionPlanUnlocked(plan) };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-rejection-recovery-failed") };
    }
  }

  function recoverGlobalRejections() {
    try {
      return withMutationLock(() => {
        const identityOptions = { forbiddenIdentityValues: globalDecisionIdentityFirewallValues() };
        const decisions = readGlobalDecisionsUnlocked()
          .map(({ decision }) => decision)
          .filter((decision) => decision.actorRole === "operator"
            && ["pending", "superseded"].includes(decision.priorState)
            && decision.newState === "rejected")
          .sort((left, right) => globalDecisionId(left).localeCompare(globalDecisionId(right)));
        const plans = decisions.map((decision) => globalRejectionPlanUnlocked(decision, {
          identityOptions,
          requirePersisted: true,
        }));
        const changes = new Map();
        for (const plan of plans) {
          for (const [filePath, source] of globalRejectionChanges(plan)) changes.set(filePath, source);
        }
        assertGlobalQuotaUnlocked(changes);
        return { ok: true, recovered: plans.map(writeGlobalRejectionPlanUnlocked) };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-rejection-recovery-failed"), recovered: [] };
    }
  }

  function rejectGlobalRecommendation(request) {
    const keys = Object.keys(request ?? {}).sort().join(",");
    if (!request || typeof request !== "object" || Array.isArray(request)
        || !["decision,nowMs", "decision,forbiddenIdentityValues,nowMs"].includes(keys)
        || !Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
      return { ok: false, reason: "invalid-global-rejection-request" };
    }
    try {
      return withMutationLock(() => {
        const identityOptions = {
          forbiddenIdentityValues: globalDecisionIdentityFirewallValues(request.forbiddenIdentityValues),
        };
        const plan = globalRejectionPlanUnlocked(request.decision, { identityOptions, nowMs: request.nowMs });
        assertGlobalQuotaUnlocked(globalRejectionChanges(plan));
        return { ok: true, ...writeGlobalRejectionPlanUnlocked(plan) };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "global-rejection-failed") };
    }
  }

  function retainGlobalLeasesUnlocked(nowMs) {
    let removed = 0;
    for (const { filePath, leaseKeyHash } of globalLeaseFilesUnlocked()) {
      const current = readGlobalLeaseUnlocked(leaseKeyHash);
      if (!current || (current.lease.state === "active" && current.lease.expiresAt > nowMs)) continue;
      rmSync(filePath, { force: true });
      removed += 1;
    }
    return removed;
  }

  function readEvidenceCapsulesUnlocked(filePath = evidenceCapsulesPath) {
    if (!existsSync(filePath)) return [];
    const parsed = parseJsonlSource(readFileSync(filePath, "utf8"), makeEvidenceCapsule);
    if (parsed.damaged.length) throw new Error("corrupt-evidence-capsule");
    return parsed.records;
  }

  function deleteEvidenceCapsulesUnlocked(reason = "evidence-capsule-unavailable") {
    let deleted = 0;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      const filePath = path.join(baseDir, entry.name, "evidence-capsules.jsonl");
      if (!existsSync(filePath)) continue;
      try { deleted += readEvidenceCapsulesUnlocked(filePath).length; } catch {}
      rmSync(filePath, { force: true });
    }
    return Object.freeze({ available: false, reason, capsulesDeleted: deleted });
  }

  function writeEvidenceCapsulesUnlocked(records, filePath = evidenceCapsulesPath) {
    const source = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
    if (path.resolve(filePath).startsWith(`${stateDir}${path.sep}`)) atomicProjectWrite(filePath, source);
    else atomicWrite(filePath, source);
  }

  function appendEvidenceCapsule(capsule, { automationStamp = null } = {}) {
    try {
      return withMutationLock(() => {
        const automation = automationStamp === null
          ? null
          : assertAutomationStampUnlocked(automationStamp);
        if (!(automation?.global.consent ?? getSettingsUnlocked().global.consent).sanitizedExcerpts) {
          return { ok: false, reason: "sanitized-excerpts-consent-required" };
        }
        const clean = makeEvidenceCapsule({
          ...capsule,
          ...(automation ? { automationGeneration: automation.epoch.generation } : {}),
        });
        const records = readEvidenceCapsulesUnlocked();
        const existing = records.find((record) => record.incidentId === clean.incidentId);
        if (existing) {
          const same = ["receiptType", "targetLogicalName", "summaryHash"]
            .every((key) => existing[key] === clean[key]);
          return same
            ? { ok: true, duplicate: true, capsule: existing }
            : { ok: false, reason: "capsule-incident-conflict" };
        }
        writeEvidenceCapsulesUnlocked([...records, clean]);
        return { ok: true, duplicate: false, capsule: clean };
      });
    } catch (error) {
      return { ok: false, reason: errorReasonCode(error, "capsule-write-failed") };
    }
  }

  function readEvidenceCapsules({ includeExpired = false, nowMs = now() } = {}) {
    return withMutationLock(() => {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("invalid-retention-time");
      return readEvidenceCapsulesUnlocked().filter((capsule) => includeExpired || capsule.expiresAt > nowMs);
    });
  }

  function getEvidenceCapsuleSupport(incidentId, { nowMs = now(), automationStamp = null } = {}) {
    return withMutationLock(() => {
      if (typeof incidentId !== "string" || !incidentId || incidentId.length > 128 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
        return Object.freeze({ available: false, reason: "invalid-capsule-support-query" });
      }
      const automation = automationStamp === null
        ? null
        : assertAutomationStampUnlocked(automationStamp);
      if (!(automation?.global.consent ?? getSettingsUnlocked().global.consent).sanitizedExcerpts) {
        return Object.freeze({ available: false, reason: "sanitized-excerpts-consent-required" });
      }
      const capsule = readEvidenceCapsulesUnlocked().find((item) => item.incidentId === incidentId);
      if (!capsule) return Object.freeze({ available: false, reason: "evidence-capsule-unavailable" });
      if (capsule.expiresAt <= nowMs) return Object.freeze({ available: false, reason: "evidence-capsule-expired" });
      return Object.freeze({ available: true, capsuleId: capsule.capsuleId });
    });
  }

  function deleteEvidenceCapsules(reason) {
    try { return { ok: true, capsuleSupport: withMutationLock(() => deleteEvidenceCapsulesUnlocked(reason)) }; }
    catch (error) { return { ok: false, reason: errorReasonCode(error, "capsule-delete-failed") }; }
  }

  function exportProject() {
    return withMutationLock(() => {
      recoverDecisionTransactionUnlocked();
      recoverTerminalProposalContentUnlocked();
      return withExportInventory(() => ({
        schemaVersion: SCHEMA_VERSION,
        exportScope: "project",
        projectName: String(projectName ?? ""),
        projectFingerprint,
        settings: {
          global: exportGlobalSettingsUnlocked(),
          repo: exportRepoSettingsUnlocked(stateDir),
        },
        records: exportRecordsUnlocked(stateDir),
        capsules: exportCapsulesUnlocked(stateDir),
        aggregateContributions: exportAggregateIndexUnlocked(aggregateIndexPath),
        snapshots: exportSnapshotsUnlocked(snapshotsDir),
        bridge: exportBridgeUnlocked(bridgeProjectDir),
      }));
    });
  }

  function sameInode(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
  }

  function sameExportStamp(left, right) {
    return sameInode(left, right)
      && left.nlink === right.nlink
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs;
  }

  function captureExportInventory() {
    return new Map(safeTreeFiles(baseDir, { optional: false })
      .filter((filePath) => {
        const parts = path.relative(baseDir, filePath).split(path.sep);
        return !(parts.length === 3 && parts[0] === "bridge" && /^[a-f0-9]{64}$/u.test(parts[1]) && parts[2] === "tui-host-health.json");
      })
      .map((filePath) => [path.resolve(filePath), lstatSync(filePath)]));
  }

  function withExportInventory(action) {
    if (exportInventory) return action();
    const captured = captureExportInventory();
    exportInventory = captured;
    try {
      if (typeof faultInjection === "function") faultInjection("export-after-inventory", { files: [...captured.keys()] });
      const result = action();
      const after = captureExportInventory();
      if (after.size !== captured.size || [...captured].some(([filePath, stat]) => !after.has(filePath) || !sameExportStamp(stat, after.get(filePath)))) {
        throw new Error("export-tree-replaced");
      }
      return result;
    } finally {
      exportInventory = null;
    }
  }

  function assertExportParent(boundary, filePath) {
    const resolvedBoundary = path.resolve(boundary);
    const resolvedParent = path.resolve(path.dirname(filePath));
    const relative = path.relative(resolvedBoundary, resolvedParent);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("export-path-escape-rejected");
    if (realpathSync(resolvedBoundary) !== resolvedBoundary || realpathSync(resolvedParent) !== resolvedParent) throw new Error("export-symlink-rejected");
  }

  function secureExportRead(boundary, filePath, maxBytes = MAX_EXPORT_BYTES) {
    if (EXPORT_NOFOLLOW === null) throw new Error("export-no-follow-unsupported");
    assertExportParent(boundary, filePath);
    const before = lstatSync(filePath);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("export-symlink-rejected");
    if (before.nlink !== 1) throw new Error("export-hardlink-rejected");
    const expected = exportInventory?.get(path.resolve(filePath));
    if (!expected || !sameExportStamp(expected, before)) throw new Error("export-file-replaced");
    let descriptor;
    try {
      descriptor = openSync(filePath, constants.O_RDONLY | EXPORT_NOFOLLOW);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || !sameExportStamp(before, opened)) throw new Error("export-file-replaced");
      if (opened.size > maxBytes) throw new Error("export-size-exceeded");
      const content = readFileSync(descriptor);
      if (content.length > maxBytes) throw new Error("export-size-exceeded");
      const readback = fstatSync(descriptor);
      const after = lstatSync(filePath);
      if (after.nlink !== 1 || !sameExportStamp(opened, readback) || !sameExportStamp(readback, after)) throw new Error("export-file-replaced");
      assertExportParent(boundary, filePath);
      return { content, stat: opened };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  function readBoundedJsonFile(filePath, maxBytes = MAX_EXPORT_BYTES, boundary = baseDir) {
    return JSON.parse(secureExportRead(boundary, filePath, maxBytes).content.toString("utf8"));
  }

  function exportJsonlUnlocked(filePath, validator) {
    if (!existsSync(filePath)) return [];
    const parsed = parseJsonlSource(secureExportRead(baseDir, filePath).content.toString("utf8"), validator);
    if (parsed.damaged.length) throw new Error("export-corrupt-record");
    return parsed.records;
  }

  function exportRecordsUnlocked(directory) {
    const records = [];
    for (const fileName of new Set(Object.values(STORE_FILES))) records.push(...exportJsonlUnlocked(path.join(directory, fileName), assertRecord));
    return records;
  }

  function exportGlobalSettingsUnlocked() {
    if (!existsSync(globalSettingsPath)) throw new Error("export-settings-missing");
    return makeGlobalSettings(readBoundedJsonFile(globalSettingsPath, 64 * 1024));
  }

  function exportRepoSettingsUnlocked(directory) {
    const settingsPath = path.join(directory, "settings.json");
    return existsSync(settingsPath) ? makeRepoSettings(readBoundedJsonFile(settingsPath, 64 * 1024)) : null;
  }

  function exportAggregateIndexUnlocked(filePath) {
    if (!existsSync(filePath)) return [];
    const value = readBoundedJsonFile(filePath, 8 * 1024 * 1024);
    if (value?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.aggregateIds) || Object.keys(value).sort().join(",") !== "aggregateIds,schemaVersion") throw new Error("export-corrupt-aggregate-index");
    const ids = [...new Set(value.aggregateIds)];
    if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error("export-corrupt-aggregate-index");
    return ids;
  }

  function exportAggregatesUnlocked() {
    return exportJsonlUnlocked(aggregatesPath, makeAggregateClaim);
  }

  function exportCapsulesUnlocked(directory) {
    const filePath = path.join(directory, "evidence-capsules.jsonl");
    return exportJsonlUnlocked(filePath, makeEvidenceCapsule).map((capsule) => ({
      classification: "sensitive-evidence-capsule",
      capsule,
    }));
  }

  function exportSnapshotsUnlocked(directory) {
    if (!existsSync(directory)) return [];
    return safeTreeFiles(directory).map((filePath) => {
      const read = secureExportRead(baseDir, filePath);
      return {
        classification: "sensitive-skill-snapshot",
        relativePath: path.relative(directory, filePath).split(path.sep).join("/"),
        bytes: read.stat.size,
        contentBase64: read.content.toString("base64"),
      };
    });
  }

  function exportBridgeUnlocked(directory) {
    const result = Object.fromEntries([
      ...BRIDGE_MAILBOX_DESCRIPTORS.map((descriptor) => [descriptor.exportField, []]),
      ["controlState", null],
    ]);
    if (!existsSync(directory)) return result;
    safeTreeFiles(directory);
    const fingerprint = path.basename(directory);
    const requestMetadata = new Map();
    for (const descriptor of BRIDGE_MAILBOX_DESCRIPTORS) {
      const child = path.join(directory, descriptor.directoryName);
      if (!existsSync(child)) continue;
      for (const filePath of safeTreeFiles(child)) {
        if (!filePath.endsWith(".json")) continue;
        const relativePath = path.relative(child, filePath).split(path.sep).join("/");
        if (relativePath.includes("/")) throw new Error("export-bridge-path-rejected");
        const requestId = relativePath.slice(0, -".json".length);
        const read = secureExportRead(baseDir, filePath, descriptor.maxBytes);
        const metadata = validateBridgeExportMetadata(
          descriptor.type,
          JSON.parse(read.content.toString("utf8")),
          {
            projectFingerprint: fingerprint,
            requestId,
            request: descriptor.requestType
              ? requestMetadata.get(`${descriptor.requestType}:${requestId}`)
              : undefined,
          },
        );
        if (descriptor.role === "request") requestMetadata.set(`${descriptor.type}:${requestId}`, metadata);
        result[descriptor.exportField].push({
          classification: descriptor.classification,
          file: relativePath,
          bytes: read.stat.size,
          metadata,
        });
      }
    }
    const controlStatePath = path.join(directory, "control-state.json");
    if (existsSync(controlStatePath)) {
      const read = secureExportRead(baseDir, controlStatePath, 8 * 1024);
      result.controlState = {
        classification: "sensitive-control-state-metadata",
        file: "control-state.json",
        bytes: read.stat.size,
        metadata: validateBridgeExportMetadata("control-state", JSON.parse(read.content.toString("utf8")), { projectFingerprint: fingerprint }),
      };
    }
    return result;
  }

  function globalRecommendationExportStateUnlocked() {
    return {
      candidates: readGlobalCandidatesUnlocked().map(({ candidate }) => candidate),
      supportSets: readGlobalSupportSetsUnlocked().map(({ supportSet }) => supportSet),
      synthesisAttempts: readGlobalSynthesisAttemptsUnlocked().map(({ attempt }) => attempt),
      recommendations: readGlobalRecommendationsUnlocked().map(({ recommendation }) => recommendation),
      recommendationContent: readGlobalRecommendationsUnlocked().map(({ recommendation }) => ({
        classification: "sensitive-skill-content",
        recommendationId: recommendation.recommendationId,
        content: decodeGlobalRecommendationContentUnlocked(recommendation.recommendationId),
      })),
      decisions: readGlobalDecisionsUnlocked().map(({ decision }) => decision),
      applyIntents: readGlobalApplyIntentsUnlocked().map(({ intent }) => intent),
      skillSnapshots: readGlobalSkillSnapshotsUnlocked().map(({ snapshot }) => ({
        classification: "sensitive-skill-snapshot",
        snapshot,
      })),
      decisionOutcomes: readGlobalDecisionOutcomesUnlocked().map(({ outcome }) => outcome),
      audits: readGlobalAuditsUnlocked().map(({ audit }) => audit),
    };
  }

  function exportGlobalRecommendations() {
    return withMutationLock(() => {
      recoverGlobalLifecycleInvalidationsUnlocked();
      return withExportInventory(() => {
        const archive = {
          schemaVersion: SCHEMA_VERSION,
          exportScope: "global-recommendations",
          classification: "sensitive-self-evolve-archive",
          projectName: String(projectName ?? ""),
          projectFingerprint,
          records: [],
          projects: [],
          bridge: [],
          global: globalRecommendationExportStateUnlocked(),
          exclusions: ["project-state", "global-settings", "global-aggregates", "global-contributions", "locks", "temporary-files", "raw-quarantine", "unrelated-opencode-state"],
        };
        if (Buffer.byteLength(JSON.stringify(archive), "utf8") > MAX_EXPORT_BYTES) throw new Error("export-size-exceeded");
        return archive;
      });
    });
  }

  function exportAll() {
    return withMutationLock(() => {
      recoverDecisionTransactionUnlocked();
      recoverTerminalProposalContentUnlocked();
      return withExportInventory(() => {
        const projects = [];
        let totalBytes = 0;
        for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error("export-symlink-rejected");
          if (!entry.isDirectory() || entry.name !== projectFingerprint) continue;
          const directory = path.join(baseDir, entry.name);
          const settingsPath = path.join(directory, "settings.json");
          const records = [];
          for (const fileName of new Set(Object.values(STORE_FILES))) {
            const filePath = path.join(directory, fileName);
            if (!existsSync(filePath)) continue;
            records.push(...exportJsonlUnlocked(filePath, assertRecord));
          }
          const snapshots = exportSnapshotsUnlocked(path.join(directory, "snapshots"));
          const capsules = exportCapsulesUnlocked(directory);
          const serializedBytes = Buffer.byteLength(JSON.stringify({ records, capsules, snapshots }), "utf8");
          totalBytes += serializedBytes;
          if (totalBytes > MAX_EXPORT_BYTES) throw new Error("export-size-exceeded");
          projects.push({
            projectFingerprint: entry.name,
            settings: existsSync(settingsPath) ? exportRepoSettingsUnlocked(directory) : null,
            records,
            capsules,
            indexes: {
              aggregateContributions: existsSync(path.join(directory, "aggregate-contributions.json"))
                ? exportAggregateIndexUnlocked(path.join(directory, "aggregate-contributions.json"))
                : [],
            },
            snapshots,
          });
        }
        const bridge = [];
        const bridgeRoot = path.join(baseDir, "bridge");
        if (existsSync(bridgeRoot)) {
          for (const entry of readdirSync(bridgeRoot, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error("export-symlink-rejected");
            if (entry.isDirectory() && entry.name === projectFingerprint) bridge.push({ projectFingerprint: entry.name, ...exportBridgeUnlocked(path.join(bridgeRoot, entry.name)) });
          }
        }
        const currentProject = projects.find((project) => project.projectFingerprint === projectFingerprint);
        const globalDecisionState = {
          contributions: readGlobalContributionsUnlocked().map(({ contribution }) => contribution),
          ...globalRecommendationExportStateUnlocked(),
        };
        const archive = {
          schemaVersion: SCHEMA_VERSION,
          exportScope: "all",
          classification: "sensitive-self-evolve-archive",
          projectName: String(projectName ?? ""),
          projectFingerprint,
          settings: {
            global: exportGlobalSettingsUnlocked(),
            repo: exportRepoSettingsUnlocked(stateDir),
          },
          records: currentProject?.records ?? [],
          capsules: currentProject?.capsules ?? [],
          global: { settings: exportGlobalSettingsUnlocked(), aggregates: exportAggregatesUnlocked(), ...globalDecisionState },
          projects,
          bridge,
          exclusions: ["locks", "temporary-files", "raw-quarantine", "unrelated-opencode-state"],
        };
        if (Buffer.byteLength(JSON.stringify(archive), "utf8") > MAX_EXPORT_BYTES) throw new Error("export-size-exceeded");
        return archive;
      });
    });
  }

  function countKinds(records, capsules = 0) {
    const counts = {
      observations: 0,
      proposals: 0,
      decisions: 0,
      audit: 0,
      capsules,
      globalCandidates: 0,
      globalSupportSets: 0,
      globalSynthesisAttempts: 0,
      globalRecommendations: 0,
      globalRecommendationContent: 0,
      globalDecisions: 0,
      globalApplyIntents: 0,
      globalSkillSnapshots: 0,
      globalDecisionOutcomes: 0,
      globalAudits: 0,
      protectedGlobalRecommendations: 0,
    };
    for (const record of records) {
      if (record.kind === "observation") counts.observations += 1;
      else if (record.kind === "proposal") counts.proposals += 1;
      else if (record.kind === "decision") counts.decisions += 1;
      else counts.audit += 1;
    }
    return counts;
  }

  function purgeGlobalRecommendationChainsUnlocked({ recommendationId = null, all = false } = {}) {
    const counts = countKinds([]);
    const recommendationRecords = readGlobalRecommendationsUnlocked();
    if (!all && !/^[a-f0-9]{64}$/u.test(String(recommendationId ?? ""))) {
      throw new Error("invalid-global-recommendation-id");
    }
    const intents = readGlobalApplyIntentsUnlocked();
    const protectedIds = new Set(recommendationRecords.flatMap(({ recommendation }) => {
      const recoveryRequired = ["applied", "undo-approved"].includes(recommendation.state)
        || intents.some(({ intent }) => intent.recommendationId === recommendation.recommendationId
          && !["completed", "failed-closed"].includes(intent.state));
      return recoveryRequired ? [recommendation.recommendationId] : [];
    }));
    const selectedIds = new Set(recommendationRecords.flatMap(({ recommendation }) =>
      (all || recommendation.recommendationId === recommendationId) ? [recommendation.recommendationId] : []));
    if (!all && selectedIds.size === 0) return counts;
    const removableIds = new Set([...selectedIds].filter((id) => !protectedIds.has(id)));
    counts.protectedGlobalRecommendations = selectedIds.size - removableIds.size;

    const selectedCandidateIds = new Set(recommendationRecords.flatMap(({ recommendation }) =>
      removableIds.has(recommendation.recommendationId) ? [recommendation.candidateId] : []));
    const selectedSupportHashes = new Set(recommendationRecords.flatMap(({ recommendation }) =>
      removableIds.has(recommendation.recommendationId) ? [recommendation.supportSetHash] : []));
    const retainedRecommendations = recommendationRecords.filter(({ recommendation }) =>
      !removableIds.has(recommendation.recommendationId));
    const retainedCandidateIds = new Set(retainedRecommendations.map(({ recommendation }) => recommendation.candidateId));
    const retainedSupportHashes = new Set(retainedRecommendations.map(({ recommendation }) => recommendation.supportSetHash));

    for (const { filePath, attempt } of readGlobalSynthesisAttemptsUnlocked()) {
      if ((all && !retainedCandidateIds.has(attempt.candidateId))
          || (selectedCandidateIds.has(attempt.candidateId) && !retainedCandidateIds.has(attempt.candidateId))) {
        rmSync(filePath, { force: true });
        counts.globalSynthesisAttempts += 1;
      }
    }
    for (const { filePath, candidate } of readGlobalCandidatesUnlocked()) {
      if ((all && !retainedCandidateIds.has(candidate.candidateId))
          || (selectedCandidateIds.has(candidate.candidateId) && !retainedCandidateIds.has(candidate.candidateId))) {
        rmSync(filePath, { force: true });
        counts.globalCandidates += 1;
      }
    }
    const retainedCandidateSupport = new Set(readGlobalCandidatesUnlocked().map(({ candidate }) => candidate.supportSetHash));
    for (const { filePath, supportSet } of readGlobalSupportSetsUnlocked()) {
      if ((all && !retainedSupportHashes.has(supportSet.supportSetHash) && !retainedCandidateSupport.has(supportSet.supportSetHash))
          || (selectedSupportHashes.has(supportSet.supportSetHash)
            && !retainedSupportHashes.has(supportSet.supportSetHash)
            && !retainedCandidateSupport.has(supportSet.supportSetHash))) {
        rmSync(filePath, { force: true });
        counts.globalSupportSets += 1;
      }
    }
    injectFault("global-purge-after-candidate-domains", { recommendationId, all });
    for (const { filePath, decision } of readGlobalDecisionsUnlocked()) {
      if (removableIds.has(decision.recommendationId)) {
        rmSync(filePath, { force: true });
        counts.globalDecisions += 1;
      }
    }
    for (const { filePath, intent } of intents) {
      if (removableIds.has(intent.recommendationId)) {
        rmSync(filePath, { force: true });
        counts.globalApplyIntents += 1;
      }
    }
    for (const { filePath, snapshot } of readGlobalSkillSnapshotsUnlocked()) {
      if (removableIds.has(snapshot.recommendationId)) {
        rmSync(filePath, { force: true });
        counts.globalSkillSnapshots += 1;
      }
    }
    for (const { filePath, outcome } of readGlobalDecisionOutcomesUnlocked()) {
      if (removableIds.has(outcome.recommendationId)) {
        rmSync(filePath, { force: true });
        counts.globalDecisionOutcomes += 1;
      }
    }
    for (const { filePath, audit } of readGlobalAuditsUnlocked()) {
      if (audit.recommendationId !== null && removableIds.has(audit.recommendationId)) {
        rmSync(filePath, { force: true });
        counts.globalAudits += 1;
      }
    }
    injectFault("global-purge-after-history", { recommendationId, all });
    for (const { recommendation } of recommendationRecords) {
      if (!removableIds.has(recommendation.recommendationId)) continue;
      for (const { filePath: contentPath } of readGlobalRecommendationChunksUnlocked(recommendation.recommendationId)) {
        rmSync(contentPath, { force: true });
        counts.globalRecommendationContent += 1;
      }
    }
    injectFault("global-purge-after-content", { recommendationId, all });
    for (const { filePath, recommendation } of recommendationRecords) {
      if (!removableIds.has(recommendation.recommendationId)) continue;
      rmSync(filePath, { force: true });
      counts.globalRecommendations += 1;
    }
    injectFault("global-purge-after-recommendation", { recommendationId, all });
    cleanupOrphanGlobalRecommendationContentUnlocked();
    return counts;
  }

  function retainGlobalLifecycleUnlocked(nowMs) {
    recoverGlobalLifecycleInvalidationsUnlocked();
    const counts = countKinds([]);
    const retentionDays = getSettingsUnlocked().global.retentionDays;
    const candidateCutoff = nowMs - retentionDays * DAY_MS;
    const durableCutoff = nowMs - retentionDays * 3 * DAY_MS;
    const addCounts = (removed) => {
      for (const key of Object.keys(counts)) counts[key] += removed[key] ?? 0;
    };
    for (const { recommendation } of readGlobalRecommendationsUnlocked()) {
      if (!["rejected", "rolled-back", "superseded", "failed-closed"].includes(recommendation.state)
          || recommendation.synthesizedAt > durableCutoff) continue;
      addCounts(purgeGlobalRecommendationChainsUnlocked({ recommendationId: recommendation.recommendationId }));
    }

    const recommendations = readGlobalRecommendationsUnlocked().map(({ recommendation }) => recommendation);
    const protectedRecommendationIds = new Set(recommendations
      .filter((recommendation) => ["critic-pending", "pending", "approved", "applied", "undo-approved"].includes(recommendation.state))
      .map((recommendation) => recommendation.recommendationId));
    const referencedCandidateIds = new Set(recommendations.map((recommendation) => recommendation.candidateId));
    const referencedSupportHashes = new Set(recommendations.map((recommendation) => recommendation.supportSetHash));
    for (const { filePath, attempt } of readGlobalSynthesisAttemptsUnlocked()) {
      if (attempt.updatedAt > durableCutoff || referencedCandidateIds.has(attempt.candidateId)) continue;
      rmSync(filePath, { force: true });
      counts.globalSynthesisAttempts += 1;
    }
    for (const { filePath, candidate } of readGlobalCandidatesUnlocked()) {
      if (candidate.updatedAt > candidateCutoff || referencedCandidateIds.has(candidate.candidateId)) continue;
      rmSync(filePath, { force: true });
      counts.globalCandidates += 1;
    }
    const candidateSupportHashes = new Set(readGlobalCandidatesUnlocked().map(({ candidate }) => candidate.supportSetHash));
    for (const { filePath, supportSet } of readGlobalSupportSetsUnlocked()) {
      if (supportSet.expiresAt > nowMs || referencedSupportHashes.has(supportSet.supportSetHash)
          || candidateSupportHashes.has(supportSet.supportSetHash)) continue;
      rmSync(filePath, { force: true });
      counts.globalSupportSets += 1;
    }
    for (const { filePath, decision } of readGlobalDecisionsUnlocked()) {
      if (decision.timestamp > durableCutoff || protectedRecommendationIds.has(decision.recommendationId)) continue;
      rmSync(filePath, { force: true });
      counts.globalDecisions += 1;
    }
    const intents = readGlobalApplyIntentsUnlocked();
    const protectedIntentIds = new Set(intents.flatMap(({ intent }) =>
      (!["completed", "failed-closed"].includes(intent.state) || protectedRecommendationIds.has(intent.recommendationId))
        ? [intent.intentId]
        : []));
    for (const { filePath, intent } of intents) {
      if (intent.updatedAt > durableCutoff || protectedIntentIds.has(intent.intentId)) continue;
      rmSync(filePath, { force: true });
      counts.globalApplyIntents += 1;
    }
    for (const { filePath, snapshot } of readGlobalSkillSnapshotsUnlocked()) {
      if (snapshot.createdAt > durableCutoff || protectedIntentIds.has(snapshot.intentId)
          || protectedRecommendationIds.has(snapshot.recommendationId)) continue;
      rmSync(filePath, { force: true });
      counts.globalSkillSnapshots += 1;
    }
    for (const { filePath, outcome } of readGlobalDecisionOutcomesUnlocked()) {
      if (outcome.completedAt > durableCutoff || protectedRecommendationIds.has(outcome.recommendationId)) continue;
      rmSync(filePath, { force: true });
      counts.globalDecisionOutcomes += 1;
    }
    for (const { filePath, audit } of readGlobalAuditsUnlocked()) {
      if (audit.timestamp > durableCutoff
          || (audit.recommendationId !== null && protectedRecommendationIds.has(audit.recommendationId))) continue;
      rmSync(filePath, { force: true });
      counts.globalAudits += 1;
    }
    counts.globalRecommendationContent += cleanupOrphanGlobalRecommendationContentUnlocked();
    return counts;
  }

  function purge({ scope, recommendationId } = {}) {
    const validScopes = new Set(["observations", "project-evidence", "proposals", "project", "global-recommendation", "global-recommendations", "all"]);
    if (!validScopes.has(scope)) return { ok: false, reason: "invalid-scope", counts: countKinds([]) };
    if ((scope === "global-recommendation") !== (recommendationId !== undefined)) {
      return { ok: false, reason: "purge-scope-mismatch", counts: countKinds([]) };
    }
    if (partitionAdmissionError && scope !== "all") {
      return { ok: false, reason: partitionAdmissionError, counts: countKinds([]) };
    }
    try {
      return withMutationLock(() => {
        if (partitionAdmissionError) {
          rmSync(baseDir, { recursive: true, force: true });
          ownedLeases.clear();
          ownedHostOwners.clear();
          parsedFileCache.clear();
          terminal = true;
          terminalRoots.add(root);
          return { ok: true, counts: countKinds([]) };
        }
        if (startupCorruptionScope && scope === "all") {
          rmSync(baseDir, { recursive: true, force: true });
          ownedLeases.clear();
          ownedHostOwners.clear();
          parsedFileCache.clear();
          terminal = true;
          terminalRoots.add(root);
          return { ok: true, counts: countKinds([]) };
        }
        if (startupCorruptionScope === "project" && scope === "project") {
          rmSync(exportProjectDir, { recursive: true, force: true });
          const contributed = new Set(readAggregateIndexUnlocked());
          if (contributed.size) removeAggregateContributionsUnlocked(contributed);
          purgeProjectContributionsUnlocked();
          rmSync(stateDir, { recursive: true, force: true });
          purgeProjectBridgeUnlocked();
          parsedFileCache.clear();
          startupCorruptionScope = null;
          initializeDirs();
          getSettingsUnlocked();
          recomputePendingGlobalCandidatesUnlocked(now());
          appendAuditUnlocked("purge", { action: scope, removed: 0 });
          return { ok: true, counts: countKinds([]) };
        }
        recoverDecisionTransactionUnlocked();
        recoverTerminalProposalContentUnlocked();
        recoverGlobalLifecycleInvalidationsUnlocked();
        rmSync(exportProjectDir, { recursive: true, force: true });
        if (scope === "global-recommendation" || scope === "global-recommendations") {
          const counts = purgeGlobalRecommendationChainsUnlocked({
            recommendationId: recommendationId ?? null,
            all: scope === "global-recommendations",
          });
          appendAuditUnlocked("purge", { action: scope, removed: Object.values(counts).reduce((total, value) => total + value, 0) });
          return { ok: true, counts };
        }
        const before = allRecords();
        const capsulesBefore = readEvidenceCapsulesUnlocked().length;
        let removed = [];
        let removedCapsules = 0;
        if (scope === "observations") {
          const records = readFileRecords(STORE_FILES.observation);
          removed = records.filter((record) => record.kind === "observation");
          writeRecords(STORE_FILES.observation, records.filter((record) => record.kind !== "observation"));
          recomputePendingGlobalCandidatesUnlocked(now());
        } else if (scope === "project-evidence") {
          const evidenceKinds = new Set(["episode-cursor", "receipt", "observation", "evidence-cluster", "eligibility-explanation"]);
          const records = readFileRecords(STORE_FILES.observation);
          removed = records.filter((record) => evidenceKinds.has(record.kind));
          writeRecords(STORE_FILES.observation, records.filter((record) => !evidenceKinds.has(record.kind)));
          rmSync(evidenceCapsulesPath, { force: true });
          removedCapsules = capsulesBefore;
          const contributed = new Set(readAggregateIndexUnlocked());
          if (contributed.size) removeAggregateContributionsUnlocked(contributed);
          rmSync(aggregateIndexPath, { force: true });
          purgeProjectContributionsUnlocked();
          recomputePendingGlobalCandidatesUnlocked(now());
        } else if (scope === "proposals") {
          const records = readFileRecords(STORE_FILES.proposal);
          removed = records.filter((record) => record.kind === "proposal" && ["critic-pending", "pending"].includes(record.payload.state));
          const removedIds = new Set(removed.map((record) => record.payload.id));
          writeRecords(STORE_FILES.proposal, records.filter((record) => !removed.includes(record) && !(record.kind === "proposal-content" && removedIds.has(record.payload.proposalId))));
        } else if (scope === "project") {
          removed = before;
          removedCapsules = capsulesBefore;
          const contributed = new Set(readAggregateIndexUnlocked());
          if (contributed.size) removeAggregateContributionsUnlocked(contributed);
          purgeProjectContributionsUnlocked();
          rmSync(stateDir, { recursive: true, force: true });
          purgeProjectBridgeUnlocked();
          parsedFileCache.clear();
          initializeDirs();
          getSettingsUnlocked();
          recomputePendingGlobalCandidatesUnlocked(now());
        } else {
          removed = before;
          removedCapsules = capsulesBefore;
          // The integration writes the terminal epoch durably at acceptance time
          // (via markRootTerminal); this in-lock write is an idempotent safety net
          // so a direct store purge-all also publishes the cross-process terminal
          // truth for peer processes. Clear the pre-deletion grace window and set
          // the definitive local terminal flag.
          try { rootEpoch.writeTerminalEpoch({ terminalOperationId: `store-purge-${now()}` }); } catch {}
          localTerminalPending = false;
          refreshRootEpochUnlocked();
          rmSync(baseDir, { recursive: true, force: true });
          ownedLeases.clear();
          ownedHostOwners.clear();
          parsedFileCache.clear();
          terminal = true;
          terminalRoots.add(root);
          return { ok: true, counts: countKinds(removed, removedCapsules) };
        }
        const counts = countKinds(removed, removedCapsules);
        appendAuditUnlocked("purge", { action: scope, removed: removed.length });
        return { ok: true, counts };
      }, (scope === "all" || partitionAdmissionError) ? {
        requireStoreAncestors: false,
        allowIncompatible: true,
        recoverTransactions: false,
        allowTerminal: scope === "all",
        skipEpochRefresh: scope === "all",
      } : undefined);
    } catch (error) { return { ok: false, reason: errorReasonCode(error, "corrupt-record"), counts: countKinds([]) }; }
  }

  function getRecoveryPending() {
    const audit = readRecords("audit-event").sort((a, b) => a.createdAt - b.createdAt);
    return audit.filter((event, index) => {
      if (event.payload.kind !== "apply" || eventState(event) !== "applied") return false;
      return !audit.slice(index + 1).some((candidate) => candidate.payload.proposalId === event.payload.proposalId
        && candidate.createdAt >= event.createdAt
        && ["readback-verified", "rolled-back"].includes(eventState(candidate))
        && (eventState(candidate) === "readback-verified" || candidate.payload.details?.["readback-verified"] === true));
    });
  }

  function close() {
    parsedFileCache.clear();
    if (closed) return { ok: true, released: 0 };
    if (partitionAdmissionError) {
      ownedLeases.clear();
      ownedHostOwners.clear();
      closed = true;
      return { ok: true, released: 0 };
    }
    if (terminal || terminalRoots.has(root)) {
      ownedLeases.clear();
      ownedHostOwners.clear();
      closed = true;
      return { ok: true, released: 0 };
    }
    const failures = [];
    let released = 0;
    try {
      withMutationLock(() => {
        for (const [leaseKey, nonce] of ownedLeases) {
          const read = readLeaseState(leaseKey);
          if (read.state === "absent") {
            ownedLeases.delete(leaseKey);
            continue;
          }
          if (read.state !== "valid") {
            failures.push({ leaseKey, reason: read.state === "error" ? read.reason : "lease-corrupt", ...(read.code ? { code: read.code } : {}) });
            continue;
          }
          if (read.lease.nonce !== nonce) {
            failures.push({ leaseKey, reason: "nonce-mismatch" });
            continue;
          }
          try {
            unlinkSync(leasePath(leaseKey));
            ownedLeases.delete(leaseKey);
            released += 1;
          } catch (error) {
            if (error?.code === "ENOENT") ownedLeases.delete(leaseKey);
            else failures.push({ leaseKey, reason: "lease-release-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) });
          }
        }
        for (const [sessionKey, owned] of ownedHostOwners) {
          if (owned.retainOnClose) continue;
          const read = readHostOwnerState(owned.sessionId);
          if (read.state === "absent") {
            ownedHostOwners.delete(sessionKey);
            continue;
          }
          if (read.state !== "valid") {
            failures.push({ sessionKey, reason: read.state === "error" ? read.reason : `host-owner-${read.state}`, ...(read.code ? { code: read.code } : {}) });
            continue;
          }
          if (read.owner.nonce !== owned.nonce) {
            failures.push({ sessionKey, reason: "nonce-mismatch" });
            continue;
          }
          try {
            removeHostOwnerUnlocked(owned.sessionId, read.owner);
            released += 1;
          } catch (error) {
            failures.push({ sessionKey, reason: "host-owner-release-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) });
          }
        }
      });
    } catch (error) {
      failures.push({ leaseKey: null, reason: "lease-release-error", code: String(error?.code ?? errorReasonCode(error, "corrupt-record")) });
    }
    if (failures.length) return { ok: false, released, failures };
    closed = true;
    return { ok: true, released };
  }

  preflightStoreAncestors();
  // Read the durable root epoch before any subtree recreation. A terminal epoch
  // (written by any process sharing this state root) means this store opens
  // inert: no directory recreation, no partition admission, no authority. The
  // epoch file lives outside the deletable `self-evolve/` subtree so it survives
  // purge-all and is the cross-process terminal truth; restart alone cannot
  // clear it.
  refreshRootEpochUnlocked();
  refreshBreakerEpochUnlocked();
  const partitionAdmission = inspectPartitionVersion();
  if (!partitionAdmission.ok) {
    partitionAdmissionError = partitionAdmission.reason;
  } else {
    partitionVersion = partitionAdmission.version;
  }
  // The first inspection is advisory only: another process may be between
  // creating the admitted preboot/base directories and publishing version.json.
  // Serialize the authoritative inspection before either rejecting or writing.
  // Skip entirely when the root epoch is terminal: a purged root must not be
  // reconstructed by a mere restart (restart-alone-inert invariant).
  if (terminalEpochReason === null) {
    withMutationLock(() => {
    const lockedAdmission = inspectPartitionVersion();
    if (!lockedAdmission.ok) {
      partitionAdmissionError = lockedAdmission.reason;
      if (partitionAdmission.ok) throw new Error(lockedAdmission.reason);
      return;
    }
    partitionAdmissionError = null;
    partitionVersion = lockedAdmission.version;
    initializeDirs();
    recoverSettingsTransactionUnlocked();
    const global = loadGlobalSettingsUnlocked();
    const repo = loadRepoSettingsUnlocked();
    if (global && repo) {
      lastKnownProjectQuotaBytes = (repo.budgets.storageQuotaMiB ?? global.budgets.storageQuotaMiB) * 1024 * 1024;
      getAutomationStateUnlocked();
      const contributionRecovery = recoverContributionTransactionsUnlocked();
      if (!contributionRecovery.ok) markStartupCorruption("global");
      else recoverGlobalLifecycleInvalidationsUnlocked();
    }
    for (const fileName of new Set(Object.values(STORE_FILES))) {
      try { readFileRecords(fileName); }
      catch (error) {
        if (!["storage-quota-exceeded", "corrupt-settings", "project-quota-unavailable"].includes(errorReasonCode(error))) throw error;
        markStartupCorruption(global ? "project" : "all");
      }
    }
    if (startupCorruptionScope !== "project") {
      recoverDecisionTransactionUnlocked();
      recoverTerminalProposalContentUnlocked();
    }
    try { readAggregatesUnlocked(); }
    catch (error) {
      if (!["storage-quota-exceeded", "corrupt-settings", "project-quota-unavailable"].includes(errorReasonCode(error))) throw error;
      markStartupCorruption(repo ? "global" : "all");
    }
  }, { requireStoreAncestors: false, allowIncompatible: true, recoverTransactions: false });
  }

  return Object.freeze({
    getSettings,
    getAutomationState,
    compareAutomationStamp,
    transitionAutomation,
    setAutomationProjectExcluded,
    updateSettings,
    updateGlobalSettings,
    updateRepoSettings,
    beginRequestTransaction,
    readRequestTransaction,
    clearRequestTransaction,
    hasPendingOperationRequest,
    setGlobalSettings: (settings) => setSettings("global", settings),
    setRepoSettings: (settings) => setSettings("repo", settings),
    readProjectionSnapshot,
    appendRecord,
    admitSynthesisAttempt,
    appendSynthesisFinalizationAudit,
    readRecords,
    getRecord,
    acquireLease,
    releaseLease,
    isLeaseHeld,
    getLeaseStatus,
    cleanupExpiredLeases,
    acquireHostOwner,
    releaseHostOwner,
    retainHostOwner,
    hostOwnerStatus,
    releaseOwnedHostOwners,
    cleanupExpiredHostOwners,
    runCas,
    commitDecision,
    recoverDecisionTransaction: () => withMutationLock(recoverDecisionTransactionUnlocked),
    retain,
    readAggregates,
    retainAggregates,
    publishContribution,
    readContributions,
    readContributionIntents,
    readContributionLinks,
    recoverContributionTransactions: () => withMutationLock(recoverContributionTransactionsUnlocked),
    materializeGlobalCandidates,
    readGlobalCandidates,
    readGlobalSupportSets,
    transitionGlobalCandidate,
    acquireGlobalLease,
    acquireGlobalDecisionLease,
    releaseGlobalLease,
    renewGlobalLease,
    getGlobalLease,
    admitGlobalSynthesisAttempt,
    dispatchGlobalSynthesisAttempt,
    revalidateGlobalSynthesisAttempt,
    completeGlobalSynthesisAttempt,
    completeGlobalSynthesisNoChange,
    failGlobalSynthesisAttempt,
    recoverGlobalSynthesisAttempts,
    recoverGlobalLifecycle,
    readGlobalSynthesisAttempts,
    readGlobalRecommendations,
    readGlobalRecommendationContent,
    readGlobalProjectionSnapshot,
    rejectGlobalRecommendation,
    recoverGlobalRejection,
    recoverGlobalRejections,
    beginGlobalDecision,
    revalidateGlobalDecisionIntent,
    commitGlobalDecisionPublication,
    writeGlobalSkillSnapshot,
    advanceGlobalApplyIntent,
    completeGlobalDecision: (request) => settleGlobalDecision(request, true),
    failGlobalDecision: (request) => settleGlobalDecision(request, false),
    readGlobalDecisions,
    readGlobalApplyIntents,
    readGlobalSkillSnapshots,
    readGlobalDecisionOutcomes,
    readGlobalAudits,
    appendEvidenceCapsule,
    readEvidenceCapsules,
    getEvidenceCapsuleSupport,
    deleteEvidenceCapsules,
    exportProject,
    exportGlobalRecommendations,
    exportAll,
    purge,
    getRecoveryPending,
    close,
    isTerminal: () => terminal || terminalRoots.has(root) || terminalEpochReason !== null,
    rootEpochTerminalReason: () => terminalEpochReason,
    // Stable power-loss durability capability bound at open time. Read-only
    // consumers (health/projection) read the stable reason to report disabled
    // authoritative writes; the applier checks `available` before any skill
    // filesystem effect so a host that cannot fsync a directory descriptor can
    // never publish a surviving target mutation whose journal evidence could not
    // be made namespace-durable. Reads never touch the durable primitive and so
    // remain available regardless of this capability.
    durableCapability: durable.capability,
    refreshRootEpoch: () => {
      refreshRootEpochUnlocked();
      return terminalEpochReason;
    },
    // Durably mark the root epoch terminal. Called by the integration at purge-all
    // acceptance (via scheduleTerminalPurge, after the accepted-terminal response
    // is recorded) so every peer process sharing the state root fails closed at
    // its next mutation-lock acquisition or admission cycle. Sets
    // localTerminalPending so THIS process's pre-deletion cleanup reads/audits
    // keep functioning until store.purge({ scope:"all" }) performs the deletion.
    // Idempotent within a generation. Does NOT delete the subtree.
    markRootTerminal: ({ terminalOperationId } = {}) => {
      const record = rootEpoch.writeTerminalEpoch({ terminalOperationId });
      localTerminalPending = true;
      return record;
    },
    // Authenticated explicit reinitialize: the sole recovery path from a terminal
    // epoch. Requires the epoch to be terminal, an exact operator-typed
    // confirmation, and a full authenticated commitment (fresh root/project
    // identity, schema/protocol versions, one-use nonce, consent snapshot,
    // operator authority). Increments the generation and clears terminal. The
    // subtree is recreated on the next open (restart); reinitialize itself only
    // advances the epoch truth. Replay-safe and cannot be model-selected.
    reinitializeRoot: ({ confirmation, authentication } = {}) => {
      return withStateMutationLock(root, () => {
        const record = rootEpoch.reinitialize({ confirmation, authentication, rootIdentityHash: rootBoundary.identity });
        const transitionId = `root-reinitialize-${record.generation}`;
        const transitionHash = hashContent(JSON.stringify([
          "self-evolve-automation-reinitialize-v1",
          record.generation,
          record.reinitializeCommitment?.nonceHash,
        ]));
        const automation = automationEpoch.reinitializeBaseline({
          rootEpochRecord: record,
          transitionId,
          transitionHash,
          rootIdentityHash: rootBoundary.identity,
        });
        terminalEpochReason = null;
        terminal = false;
        localTerminalPending = false;
        terminalRoots.delete(root);
        initializeDirs();
        const timestamp = now();
        const global = makeV4GlobalSettings({ createdAt: timestamp, updatedAt: timestamp });
        const repo = makeV4RepoSettings({ projectFingerprint });
        atomicWrite(automationGlobalSettingsPath, json(global));
        atomicProjectWrite(automationRepoSettingsPath, json(repo));
        return { ...record, automation: automation.record };
      }, { lockTimeoutMs, staleLockMs });
    },
    // ----- Root-global circuit-breaker epoch -----
    // The breaker epoch is the cross-process open/closed truth for the
    // autonomous-work circuit breaker. It composes with the terminal epoch
    // (same module, same durable primitive, sibling file) but tracks a separate
    // concern. breakerEpochTripped() is the FRESH read every admission, provider,
    // and effect boundary must call; refreshBreakerEpoch() re-reads under the
    // mutation lock. tripBreakerEpoch/resetBreakerEpoch are the sole durable
    // write paths. A corrupt breaker epoch fails closed (tripped).
    breakerEpochTripped: () => {
      refreshBreakerEpochUnlocked();
      return breakerEpochReason !== null;
    },
    breakerEpochReason: () => breakerEpochReason,
    breakerEpochState: () => {
      try {
        const epoch = breakerEpoch.read();
        return {
          ok: true,
          generation: epoch.generation,
          tripped: epoch.tripped,
          trippedAt: epoch.trippedAt,
          trippedReason: epoch.trippedReason,
          tripOperationId: epoch.tripOperationId,
          updatedAt: epoch.updatedAt,
          corrupt: false,
        };
      } catch (error) {
        return { ok: false, corrupt: true, reason: errorReasonCode(error, BREAKER_EPOCH_TRIPPED_REASON) };
      }
    },
    refreshBreakerEpoch: () => {
      refreshBreakerEpochUnlocked();
      return breakerEpochReason;
    },
    // Durably trip the breaker epoch so every peer process sharing the state
    // root sees the open state at its next boundary read. Idempotent within a
    // generation. Called by the applier/scheduler trip paths alongside the
    // existing per-trip circuit-breaker audit record. Does NOT throw when
    // already tripped.
    tripBreakerEpoch: ({ reason, operationId } = {}) => {
      const record = breakerEpoch.trip({ reason, operationId, rootIdentityHash: rootBoundary.identity });
      breakerEpochReason = BREAKER_EPOCH_TRIPPED_REASON;
      return record;
    },
    // Authenticated explicit reset: the sole recovery path from a tripped
    // breaker epoch. Requires the breaker to be tripped, an exact operator-typed
    // confirmation, and a full authenticated commitment. Advances the
    // generation and clears tripped. Replay-safe (a replayed reset on a healthy
    // breaker fails) and cannot be model-selected. After reset, every process
    // sees the healthy state at its next boundary read.
    resetBreakerEpoch: ({ confirmation, authentication } = {}) => {
      const record = breakerEpoch.reset({ confirmation, authentication, rootIdentityHash: rootBoundary.identity });
      breakerEpochReason = null;
      return record;
    },
    getProjectUsage: () => withMutationLock(() => {
      const bytesUsed = projectedProjectBytesUnlocked();
      const quotaBytes = projectQuotaBytesUnlocked();
      return { bytesUsed, quotaBytes, availableBytes: Math.max(0, quotaBytes - bytesUsed) };
    }),
    getGlobalUsage: () => withMutationLock(() => {
      const stateUsage = projectedTreeUsageUnlocked(globalDir);
      const bridgeUsage = projectedTreeUsageUnlocked(bridgeGlobalDir);
      const bytesUsed = stateUsage.bytes + bridgeUsage.bytes;
      const filesUsed = stateUsage.fileCount + bridgeUsage.fileCount;
      return {
        bytesUsed,
        filesUsed,
        quotaBytes: globalQuotaBytes,
        quotaFiles: globalQuotaFiles,
        availableBytes: Math.max(0, globalQuotaBytes - bytesUsed),
        availableFiles: Math.max(0, globalQuotaFiles - filesUsed),
      };
    }),
    writeSnapshot: (fileName, contents) => withMutationLock(() => {
      if (!/^[A-Za-z0-9_.%-]{1,512}$/.test(String(fileName))) throw new Error("invalid-snapshot-name");
      const filePath = path.join(snapshotsDir, String(fileName));
      const source = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
      const resolved = path.resolve(filePath);
      assertProjectQuotaUnlocked(new Map([[resolved, source]]));
      atomicWrite(filePath, source);
      return filePath;
    }),
    get snapshotRoot() { return snapshotsDir; },
    get stateDir() { return stateDir; },
    get projectFingerprint() { return projectFingerprint; },
    get rootPath() { return rootBoundary.path; },
    get rootIdentity() { return rootBoundary.identity; },
  });
}
