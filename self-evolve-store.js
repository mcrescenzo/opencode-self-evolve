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
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { BRIDGE_CONTROL_STATE_RESERVE_BYTES, BRIDGE_MAILBOX_DESCRIPTORS, validateBridgeExportMetadata } from "./self-evolve-bridge.js";
import { processIsAlive, stateMutationLockHeld, withStateMutationLock } from "./self-evolve-lock.js";
import {
  revalidateStateRootBoundary,
  validateStateRootBoundary,
  walkStateRootDirectories,
} from "./self-evolve-state-root.js";
import {
  LEGACY_SELF_EVOLVE_AGENTS,
  SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
} from "./self-evolve-core.js";
import {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  assertRecord,
  errorReasonCode,
  makeAggregateClaim,
  makeAuditEvent,
  makeDecision,
  makeGlobalSettings,
  migrateSettings,
  makeProposal,
  makeProposalContent,
  makeRepoSettings,
  parseSynthesisOutcomeAuditEvent,
  stripUndefined,
  burnNonce,
  transitionProposalState,
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
const MAX_VERSION_MARKER_BYTES = 4 * 1024;
const DECISION_TRANSACTION_VERSION = 2;
const SETTINGS_TRANSACTION_VERSION = 2;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const EXPORT_NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0 ? constants.O_NOFOLLOW : null;
const ACTIVE_PROPOSAL_STATES = new Set(["critic-pending", "pending", "approved", "applied"]);
const ACTIVE_PROPOSAL_CHAIN_KINDS = new Set(["proposal", "proposal-content", "decision", "audit-event"]);
const SYNTHESIS_FINALIZATION_AUDIT_ACTIONS = new Set([
  "synthesis-outcome",
  "synthesis-lease-cleanup-warning",
  "synthesis-lease-cleanup-resolved",
]);
const HIDDEN_HOST_OWNER_AGENTS = new Set([
  SELF_EVOLVE_ANALYZER_AGENT,
  SELF_EVOLVE_SYNTHESIZER_AGENT,
  SELF_EVOLVE_CRITIC_AGENT,
  ...Object.values(LEGACY_SELF_EVOLVE_AGENTS),
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
  faultInjection,
  processIsAlive: hostProcessIsAlive = processIsAlive,
  filesystemSync = fsyncSync,
} = {}) {
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (!/^[a-f0-9]{64}$/.test(String(projectFingerprint))) throw new TypeError("invalid-project-fingerprint");
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError("invalid-lock-timeout");
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1) throw new TypeError("invalid-stale-lock-window");
  if (typeof hostProcessIsAlive !== "function") throw new TypeError("process-is-alive-must-be-function");
  if (typeof filesystemSync !== "function") throw new TypeError("filesystem-sync-must-be-function");
  const rootBoundary = validateStateRootBoundary(rootDir, {
    create: true,
    beforeCreate: (details) => injectFault("state-root-before-create", details),
  });
  injectFault("state-root-after-boundary-validation", { stateRoot: rootBoundary.path });
  const root = revalidateStateRootBoundary(rootBoundary);
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
  const aggregatesPath = path.join(globalDir, "aggregates.jsonl");
  const aggregateIndexPath = path.join(stateDir, "aggregate-contributions.json");
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
    atomicFilesystemWrite(filePath, contents, filesystemSync);
    revalidateStateRootBoundary(rootBoundary);
  }

  function ensureOpen({ allowIncompatible = false } = {}) {
    if (closed) throw new Error("store-closed");
    if (terminal || terminalRoots.has(root)) throw new Error("restart-required-after-purge-all");
    if (partitionAdmissionError && !allowIncompatible) throw new Error(partitionAdmissionError);
  }

  function markStartupCorruption(scope) {
    startupCorruptionScope = startupCorruptionScope && startupCorruptionScope !== scope
      ? "all"
      : scope;
  }

  function withMutationLock(action, {
    requireStoreAncestors = true,
    allowIncompatible = false,
    recoverTransactions = true,
  } = {}) {
    ensureOpen({ allowIncompatible });
    revalidateStateRootBoundary(rootBoundary);
    return withStateMutationLock(root, () => {
      revalidateStateRootBoundary(rootBoundary);
      if (requireStoreAncestors) revalidateStoreAncestors();
      if (recoverTransactions) recoverSettingsTransactionUnlocked();
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

  function assertProjectQuotaUnlocked(changes, {
    mandatoryAuditBytes = 0,
    quotaBytes = projectQuotaBytesUnlocked(),
    targetStateDir = stateDir,
    targetBridgeDir = bridgeProjectDir,
  } = {}) {
    const projectedBytes = projectedProjectBytesUnlocked(changes, { targetStateDir, targetBridgeDir });
    if (projectedBytes <= quotaBytes) return { projectedBytes, quotaBytes };
    if (mandatoryAuditBytes > 0 && mandatoryAuditBytes <= MANDATORY_AUDIT_MAX_BYTES) return { projectedBytes, quotaBytes, mandatoryAuditBypass: true };
    throw new Error("storage-quota-exceeded");
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

  function findLegacyGlobalUnlocked() {
    if (!existsSync(baseDir)) return null;
    const candidates = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => path.join(baseDir, entry.name, "settings.json"))
      .sort();
    for (const candidatePath of candidates) {
      const legacy = readLegacyCombined(candidatePath);
      if (!legacy?.global) continue;
      try { return makeGlobalSettings(legacy.global); } catch {}
    }
    return null;
  }

  function loadGlobalSettingsUnlocked() {
    if (!existsSync(globalSettingsPath)) {
      const defaults = makeGlobalSettings({ createdAt: now(), updatedAt: now() });
      const initial = findLegacyGlobalUnlocked() ?? defaults;
      atomicWrite(globalSettingsPath, json(initial));
      return initial;
    }
    let source;
    try {
      source = readFileSync(globalSettingsPath, "utf8");
      const raw = JSON.parse(source);
      const migrated = migrate(raw);
      if (!migrated) throw new Error("unsupported-version");
      const clean = makeGlobalSettings(migrated);
      if (raw.schemaVersion !== SCHEMA_VERSION) atomicWrite(globalSettingsPath, json(clean));
      return clean;
    } catch (error) {
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

  function readProjectionSnapshot() {
    return withMutationLock(() => {
      if (existsSync(decisionTransactionPath)) throw new Error("projection-snapshot-recovery-pending");
      let global;
      let repo;
      try {
        global = makeGlobalSettings(JSON.parse(readFileSync(globalSettingsPath, "utf8")));
        repo = makeRepoSettings(JSON.parse(readFileSync(repoSettingsPath, "utf8")));
      } catch {
        throw new Error("projection-snapshot-corrupt-settings");
      }
      const settings = { global, repo };
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
        "self-evolve-projection-store-snapshot-v1",
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
      const passiveLimit = settings.repo.budgets.passiveCallsPerHour
        ?? settings.global.budgets.passiveCallsPerHour;
      const synthesisLimit = settings.repo.budgets.synthesisPerDay
        ?? settings.global.budgets.synthesisPerDay;
      const storageQuotaBytes = (settings.repo.budgets.storageQuotaMiB
        ?? settings.global.budgets.storageQuotaMiB) * 1024 * 1024;
      const storageBytesUsed = projectedProjectBytesUnlocked();
      const usage = Object.freeze({
        passive: budgetUsage("passive", 60 * 60 * 1000, passiveLimit),
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
        settings: Object.freeze({ global: settings.global, repo: settings.repo }),
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
      if (currentSource === priorSource) atomicWrite(filePath, json(change.next));
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
    rmSync(settingsTransactionPath, { force: true });
    if (inject) injectFault("settings-after-transaction-remove");
    return {
      ok: true,
      recovered: true,
      changed: true,
      settings: { global: intent.global.next, repo: intent.repo.next },
      auditEvent: intent.audits[0].payload,
      auditEvents: intent.audits.map((audit) => audit.payload),
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
        const intent = buildSettingsTransaction(current, nextGlobal, nextRepo, globalChanged, repoChanged, transactionAudits);
        injectFault("settings-before-intent-write");
        atomicWrite(settingsTransactionPath, json(intent));
        try {
          injectFault("settings-after-intent-write");
          const committed = recoverSettingsTransactionUnlocked({ inject: true });
          return { ...committed, recovered: false };
        } catch (error) {
          if (!existsSync(settingsTransactionPath)) {
            return { ok: true, recovered: false, changed: true, settings: { global: nextGlobal, repo: nextRepo }, auditEvent: audit.payload };
          }
          const committed = recoverSettingsTransactionUnlocked();
          return { ...committed, recovered: true };
        }
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

  function appendRecord(envelope) {
    try { return withMutationLock(() => appendValidUnlocked(envelope)); }
    catch (error) {
      try { withMutationLock(() => quarantine(envelope, errorReasonCode(error, "corrupt-record"))); } catch {}
      return { ok: false, reason: errorReasonCode(error, "corrupt-record") };
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

  function acquireLease(leaseKey, { ttlMs, actor }) {
    try {
      return withMutationLock(() => {
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
      && HIDDEN_HOST_OWNER_AGENTS.has(value.agent)
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

  function acquireHostOwner(sessionId, { agent, projectFingerprint: ownerProject, rootIdentity, generation, ttlMs = HOST_OWNER_TTL_MS, pid = process.pid } = {}) {
    try {
      return withMutationLock(() => {
        hostOwnerKey(sessionId);
        if (!HIDDEN_HOST_OWNER_AGENTS.has(agent)) return { ok: false, reason: "invalid-host-owner-agent" };
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

  function runCas(kind, id, expectedPriorState, mutateFn, selectPriorState = (payload) => payload?.state) {
    try {
      return withMutationLock(() => {
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

      const aggregateRecords = readAggregatesUnlocked();
      const keptAggregates = aggregateRecords.filter((record) => record.expiresAt > nowMs);
      const keptAggregateIds = new Set(keptAggregates.map((record) => record.aggregateId));
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

  function appendAggregate(record) {
    try {
      return withMutationLock(() => {
        const clean = makeAggregateClaim(record);
        const records = readAggregatesUnlocked();
        const ids = readAggregateIndexUnlocked();
        if (records.some((item) => item.aggregateId === clean.aggregateId)) {
          if (!ids.includes(clean.aggregateId)) writeAggregateIndexUnlocked(aggregateIndexPath, [...ids, clean.aggregateId]);
          return { ok: true, duplicate: true, record: clean };
        }
        writeAggregateIndexUnlocked(aggregateIndexPath, [...ids, clean.aggregateId]);
        writeJsonl(aggregatesPath, [...records, clean]);
        return { ok: true, duplicate: false, record: clean };
      });
    } catch (error) { return { ok: false, reason: errorReasonCode(error, "corrupt-record") }; }
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

  function exportAll() {
    return withMutationLock(() => {
      recoverDecisionTransactionUnlocked();
      recoverTerminalProposalContentUnlocked();
      return withExportInventory(() => {
        const projects = [];
        let totalBytes = 0;
        for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error("export-symlink-rejected");
          if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
          const directory = path.join(baseDir, entry.name);
          const settingsPath = path.join(directory, "settings.json");
          const records = [];
          for (const fileName of new Set(Object.values(STORE_FILES))) {
            const filePath = path.join(directory, fileName);
            if (!existsSync(filePath)) continue;
            records.push(...exportJsonlUnlocked(filePath, assertRecord));
          }
          const snapshots = exportSnapshotsUnlocked(path.join(directory, "snapshots"));
          const serializedBytes = Buffer.byteLength(JSON.stringify({ records, snapshots }), "utf8");
          totalBytes += serializedBytes;
          if (totalBytes > MAX_EXPORT_BYTES) throw new Error("export-size-exceeded");
          projects.push({
            projectFingerprint: entry.name,
            settings: existsSync(settingsPath) ? exportRepoSettingsUnlocked(directory) : null,
            records,
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
            if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) bridge.push({ projectFingerprint: entry.name, ...exportBridgeUnlocked(path.join(bridgeRoot, entry.name)) });
          }
        }
        const currentProject = projects.find((project) => project.projectFingerprint === projectFingerprint);
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
          global: { settings: exportGlobalSettingsUnlocked(), aggregates: exportAggregatesUnlocked() },
          projects,
          bridge,
          exclusions: ["locks", "temporary-files", "raw-quarantine", "unrelated-opencode-state"],
        };
        if (Buffer.byteLength(JSON.stringify(archive), "utf8") > MAX_EXPORT_BYTES) throw new Error("export-size-exceeded");
        return archive;
      });
    });
  }

  function countKinds(records) {
    const counts = { observations: 0, proposals: 0, decisions: 0, audit: 0 };
    for (const record of records) {
      if (record.kind === "observation") counts.observations += 1;
      else if (record.kind === "proposal") counts.proposals += 1;
      else if (record.kind === "decision") counts.decisions += 1;
      else counts.audit += 1;
    }
    return counts;
  }

  function purge({ scope }) {
    const validScopes = new Set(["observations", "proposals", "project", "all"]);
    if (!validScopes.has(scope)) return { ok: false, reason: "invalid-scope", counts: countKinds([]) };
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
          rmSync(stateDir, { recursive: true, force: true });
          purgeProjectBridgeUnlocked();
          parsedFileCache.clear();
          startupCorruptionScope = null;
          initializeDirs();
          getSettingsUnlocked();
          appendAuditUnlocked("purge", { action: scope, removed: 0 });
          return { ok: true, counts: countKinds([]) };
        }
        recoverDecisionTransactionUnlocked();
        recoverTerminalProposalContentUnlocked();
        const before = allRecords();
        let removed = [];
        rmSync(exportProjectDir, { recursive: true, force: true });
        if (scope === "observations") {
          const records = readFileRecords(STORE_FILES.observation);
          removed = records.filter((record) => record.kind === "observation");
          writeRecords(STORE_FILES.observation, records.filter((record) => record.kind !== "observation"));
        } else if (scope === "proposals") {
          const records = readFileRecords(STORE_FILES.proposal);
          removed = records.filter((record) => record.kind === "proposal" && ["critic-pending", "pending"].includes(record.payload.state));
          const removedIds = new Set(removed.map((record) => record.payload.id));
          writeRecords(STORE_FILES.proposal, records.filter((record) => !removed.includes(record) && !(record.kind === "proposal-content" && removedIds.has(record.payload.proposalId))));
        } else if (scope === "project") {
          removed = before;
          const contributed = new Set(readAggregateIndexUnlocked());
          if (contributed.size) removeAggregateContributionsUnlocked(contributed);
          rmSync(stateDir, { recursive: true, force: true });
          purgeProjectBridgeUnlocked();
          parsedFileCache.clear();
          initializeDirs();
          getSettingsUnlocked();
        } else {
          removed = before;
          rmSync(baseDir, { recursive: true, force: true });
          ownedLeases.clear();
          ownedHostOwners.clear();
          parsedFileCache.clear();
          terminal = true;
          terminalRoots.add(root);
          return { ok: true, counts: countKinds(removed) };
        }
        const counts = countKinds(removed);
        appendAuditUnlocked("purge", { action: scope, removed: removed.length });
        return { ok: true, counts };
      }, partitionAdmissionError ? {
        requireStoreAncestors: false,
        allowIncompatible: true,
        recoverTransactions: false,
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
  const partitionAdmission = inspectPartitionVersion();
  if (!partitionAdmission.ok) {
    partitionAdmissionError = partitionAdmission.reason;
  } else {
    partitionVersion = partitionAdmission.version;
  }
  // The first inspection is advisory only: another process may be between
  // creating the admitted preboot/base directories and publishing version.json.
  // Serialize the authoritative inspection before either rejecting or writing.
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

  return Object.freeze({
    getSettings,
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
    appendAggregate,
    readAggregates,
    retainAggregates,
    exportProject,
    exportAll,
    purge,
    getRecoveryPending,
    close,
    isTerminal: () => terminal || terminalRoots.has(root),
    getProjectUsage: () => withMutationLock(() => {
      const bytesUsed = projectedProjectBytesUnlocked();
      const quotaBytes = projectQuotaBytesUnlocked();
      return { bytesUsed, quotaBytes, availableBytes: Math.max(0, quotaBytes - bytesUsed) };
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
