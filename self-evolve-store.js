import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
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
import { BRIDGE_CONTROL_STATE_RESERVE_BYTES, BRIDGE_RESPONSE_RESERVE_BYTES, validateBridgeExportMetadata } from "./self-evolve-bridge.js";
import { stateMutationLockHeld, withStateMutationLock } from "./self-evolve-lock.js";
import {
  SCHEMA_VERSION,
  assertRecord,
  makeAggregateClaim,
  makeAuditEvent,
  makeDecision,
  makeGlobalSettings,
  makeProposal,
  makeProposalContent,
  makeRepoSettings,
  burnNonce,
  transitionProposalState,
  wrapRecord,
} from "./self-evolve-schemas.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DAY_MS = 86_400_000;
const MANDATORY_AUDIT_MAX_BYTES = 4 * 1024;
const DECISION_TRANSACTION_VERSION = 2;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const EXPORT_NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0 ? constants.O_NOFOLLOW : null;
const ACTIVE_PROPOSAL_STATES = new Set(["critic-pending", "pending", "approved", "applied"]);
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

function atomicWrite(filePath, contents) {
  ensureDir(path.dirname(filePath));
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    renameSync(temporary, filePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function json(value) {
  return `${JSON.stringify(value)}\n`;
}

function reasonCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":", 1)[0] || "corrupt-record";
}

export function quarantineRecord(record, reason, quarantineDir) {
  if (!quarantineDir) throw new TypeError("quarantine-directory-required");
  ensureDir(quarantineDir);
  const stamp = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  const recordPath = path.join(quarantineDir, `${stamp}.quarantined`);
  let serialized;
  try { serialized = typeof record === "string" ? record : JSON.stringify(record); } catch { serialized = String(record); }
  atomicWrite(recordPath, `${serialized}\n`);
  atomicWrite(`${recordPath}.reason.json`, json({ reason: String(reason) }));
  return recordPath;
}

function compareVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((part) => !Number.isInteger(part) || part < 0)) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function migrate(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const comparison = compareVersions(settings.schemaVersion, SCHEMA_VERSION);
  if (comparison === null || comparison > 0) return null;
  if (comparison === 0) return settings;
  return {
    ...settings,
    schemaVersion: SCHEMA_VERSION,
    ...(settings.global ? { global: { ...settings.global, schemaVersion: SCHEMA_VERSION } } : {}),
    ...(settings.repo ? { repo: { ...settings.repo, schemaVersion: SCHEMA_VERSION } } : {}),
  };
}

function fileForKind(kind) {
  if (STORE_FILES[kind]) return STORE_FILES[kind];
  if (["apply-claim", "rollback-record", "intervention-epoch", "circuit-breaker"].includes(kind)) return STORE_FILES["audit-event"];
  return STORE_FILES.observation;
}

function logicalId(envelope) {
  return envelope.payload?.id ?? envelope.payload?.proposalId ?? envelope.id;
}

function eventState(event) {
  return event.payload?.details?.state ?? event.payload?.details?.status ?? event.payload?.details?.action;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export function openStore(rootDir, {
  projectName,
  projectFingerprint,
  now = () => Date.now(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  faultInjection,
} = {}) {
  if (typeof now !== "function") throw new TypeError("now-must-be-function");
  if (!/^[a-f0-9]{64}$/.test(String(projectFingerprint))) throw new TypeError("invalid-project-fingerprint");
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError("invalid-lock-timeout");
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1) throw new TypeError("invalid-stale-lock-window");
  const root = path.resolve(String(rootDir));
  const baseDir = path.join(root, "self-evolve");
  const globalDir = path.join(baseDir, "global");
  const stateDir = path.join(baseDir, projectFingerprint);
  const leasesDir = path.join(stateDir, "leases");
  const quarantineDir = path.join(stateDir, "quarantine");
  const globalQuarantineDir = path.join(globalDir, "quarantine");
  const snapshotsDir = path.join(stateDir, "snapshots");
  const repoSettingsPath = path.join(stateDir, "settings.json");
  const globalSettingsPath = path.join(globalDir, "settings.json");
  const aggregatesPath = path.join(globalDir, "aggregates.jsonl");
  const aggregateIndexPath = path.join(stateDir, "aggregate-contributions.json");
  const decisionTransactionPath = path.join(stateDir, "decision-transaction.json");
  const bridgeProjectDir = path.join(baseDir, "bridge", projectFingerprint);
  const ownedLeases = new Map();
  // Cache validity is the exact source bytes, never filesystem metadata. Every
  // read still reads and compares the source, so writers in other processes are
  // visible even when an inode, size, or millisecond mtime is reused.
  const parsedFileCache = new Map();
  let exportInventory = null;
  let legacyProposalContentAbsent = false;
  let closed = false;
  let terminal = false;

  function ensureOpen() {
    if (closed) throw new Error("store-closed");
    if (terminal || terminalRoots.has(root)) throw new Error("restart-required-after-purge-all");
  }

  function withMutationLock(action) {
    ensureOpen();
    return withStateMutationLock(root, action, { lockTimeoutMs, staleLockMs });
  }

  function initializeDirs() {
    ensureDir(baseDir);
    ensureDir(globalDir);
    ensureDir(stateDir);
    ensureDir(leasesDir);
    ensureDir(quarantineDir);
    ensureDir(globalQuarantineDir);
    ensureDir(snapshotsDir);
    const versionPath = path.join(baseDir, "version.json");
    if (!existsSync(versionPath)) atomicWrite(versionPath, json({ schemaVersion: SCHEMA_VERSION }));
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
    if (!existsSync(repoSettingsPath)) return global.budgets.storageQuotaMiB * 1024 * 1024;
    const repo = loadRepoSettingsUnlocked();
    if (!repo) throw new Error("corrupt-settings");
    return (repo.budgets.storageQuotaMiB ?? global.budgets.storageQuotaMiB) * 1024 * 1024;
  }

  function projectedProjectBytesUnlocked(changes = new Map()) {
    const files = [...safeTreeFiles(stateDir), ...safeTreeFiles(bridgeProjectDir)];
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
    let pendingBridgeRequests = 0;
    for (const filePath of files) {
      const parent = path.basename(path.dirname(filePath));
      if ((parent === "requests" || parent === "control-requests") && filePath.endsWith(".json")) {
        pendingBridgeRequests += 1;
        bytes += BRIDGE_RESPONSE_RESERVE_BYTES;
      }
    }
    if (pendingBridgeRequests > 0 && !files.includes(path.join(bridgeProjectDir, "control-state.json"))) bytes += BRIDGE_CONTROL_STATE_RESERVE_BYTES;
    return bytes;
  }

  function assertProjectQuotaUnlocked(changes, { mandatoryAuditBytes = 0, quotaBytes = projectQuotaBytesUnlocked() } = {}) {
    const projectedBytes = projectedProjectBytesUnlocked(changes);
    if (projectedBytes <= quotaBytes) return { projectedBytes, quotaBytes };
    if (mandatoryAuditBytes > 0 && mandatoryAuditBytes <= MANDATORY_AUDIT_MAX_BYTES) return { projectedBytes, quotaBytes, mandatoryAuditBypass: true };
    throw new Error("storage-quota-exceeded");
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
    if (directory !== quarantineDir) return quarantineRecord(record, reason, directory);
    ensureDir(directory);
    const stamp = `${Date.now()}-${randomBytes(8).toString("hex")}`;
    const recordPath = path.join(directory, `${stamp}.quarantined`);
    let serialized;
    try { serialized = typeof record === "string" ? record : JSON.stringify(record); } catch { serialized = String(record); }
    const changes = new Map([
      [path.resolve(recordPath), `${serialized}\n`],
      [path.resolve(`${recordPath}.reason.json`), json({ reason: String(reason) })],
    ]);
    const global = loadGlobalSettingsUnlocked();
    const quotaBytes = (global?.budgets.storageQuotaMiB ?? 8) * 1024 * 1024;
    assertProjectQuotaUnlocked(changes, { quotaBytes });
    atomicWrite(recordPath, changes.get(path.resolve(recordPath)));
    atomicWrite(`${recordPath}.reason.json`, changes.get(path.resolve(`${recordPath}.reason.json`)));
    return recordPath;
  }

  function quarantineDeterministic(record, reason, label) {
    let serialized;
    try { serialized = typeof record === "string" ? record : JSON.stringify(record); } catch { serialized = String(record); }
    const bounded = serialized.slice(0, 64 * 1024);
    const identity = hashContent(JSON.stringify([String(label), String(reason), bounded]));
    const recordPath = path.join(quarantineDir, `${label}-${identity}.quarantined`);
    const reasonPath = `${recordPath}.reason.json`;
    if (existsSync(recordPath) && existsSync(reasonPath)) return recordPath;
    const changes = new Map([
      [path.resolve(recordPath), `${bounded}\n`],
      [path.resolve(reasonPath), json({ reason: String(reason) })],
    ]);
    assertProjectQuotaUnlocked(changes);
    if (!existsSync(recordPath)) atomicWrite(recordPath, changes.get(path.resolve(recordPath)));
    if (!existsSync(reasonPath)) atomicWrite(reasonPath, changes.get(path.resolve(reasonPath)));
    return recordPath;
  }

  function parseJsonlSource(source, validator) {
    const records = [];
    const damaged = [];
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try { records.push(validator(JSON.parse(line))); } catch (error) { damaged.push({ line, reason: reasonCode(error) }); }
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
      } else if (!ACTIVE_PROPOSAL_STATES.has(proposal.state)) {
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

  function injectFault(point) {
    if (typeof faultInjection === "function") faultInjection(point);
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
      try { quarantine(raw ?? "unreadable decision transaction", reasonCode(error)); } finally { rmSync(decisionTransactionPath, { force: true }); }
      throw new Error(reasonCode(error));
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
      return { ok: false, reason: reasonCode(error) };
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
    try {
      const raw = JSON.parse(readFileSync(globalSettingsPath, "utf8"));
      const migrated = migrate(raw);
      if (!migrated) return null;
      const clean = makeGlobalSettings(migrated);
      if (raw.schemaVersion !== SCHEMA_VERSION) atomicWrite(globalSettingsPath, json(clean));
      return clean;
    } catch (error) {
      quarantine(readFileSync(globalSettingsPath, "utf8"), reasonCode(error), globalQuarantineDir);
      return null;
    }
  }

  function loadRepoSettingsUnlocked() {
    if (!existsSync(repoSettingsPath)) {
      const defaults = makeRepoSettings({ projectFingerprint });
      atomicProjectWrite(repoSettingsPath, json(defaults));
      return defaults;
    }
    try {
      const raw = JSON.parse(readFileSync(repoSettingsPath, "utf8"));
      const legacy = raw?.repo ? migrate(raw) : null;
      const candidate = legacy?.repo ?? migrate(raw);
      if (!candidate) return null;
      const clean = makeRepoSettings(candidate);
      if (raw.repo || raw.schemaVersion !== SCHEMA_VERSION) {
        const global = loadGlobalSettingsUnlocked();
        atomicProjectWrite(repoSettingsPath, json(clean), { quotaBytes: (global?.budgets.storageQuotaMiB ?? 8) * 1024 * 1024 });
      }
      return clean;
    } catch (error) {
      quarantine(readFileSync(repoSettingsPath, "utf8"), reasonCode(error));
      return null;
    }
  }

  function getSettingsUnlocked() {
    const global = loadGlobalSettingsUnlocked();
    const repo = loadRepoSettingsUnlocked();
    if (!global || !repo) throw new Error("corrupt-settings");
    return { global, repo };
  }

  function getSettings() {
    return withMutationLock(getSettingsUnlocked);
  }

  function allRecords() {
    const records = [];
    for (const fileName of new Set(Object.values(STORE_FILES))) records.push(...readFileRecords(fileName));
    return records;
  }

  function makeAudit(kind, details, proposalId, actor = "self-evolve-store") {
    const timestamp = now();
    const cleanDetails = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
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
      return { ok: false, reason: reasonCode(error) };
    }
    atomicWrite(filePath, source);
    cacheParsedRecords(filePath, source, [...records, clean]);
    return { ok: true, duplicate: false, record: clean };
  }

  function appendAuditUnlocked(kind, details, proposalId, actor) {
    return appendValidUnlocked(makeAudit(kind, details, proposalId, actor), { mandatoryAudit: true });
  }

  function updateSettings(mutator, { expectedGlobalUpdatedAt } = {}) {
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
        const auditRecords = readFileRecords(STORE_FILES["audit-event"]);
        const auditSource = [...auditRecords, audit].map((record) => JSON.stringify(record)).join("\n") + "\n";
        const auditBytes = Buffer.byteLength(JSON.stringify(audit), "utf8") + 1;
        const changes = new Map([[path.resolve(path.join(stateDir, STORE_FILES["audit-event"])), auditSource]]);
        if (repoChanged) changes.set(path.resolve(repoSettingsPath), json(nextRepo));
        const quotaBytes = (nextRepo.budgets.storageQuotaMiB ?? nextGlobal.budgets.storageQuotaMiB) * 1024 * 1024;
        assertProjectQuotaUnlocked(changes, { mandatoryAuditBytes: auditBytes, quotaBytes });
        if (globalChanged) atomicWrite(globalSettingsPath, json(nextGlobal));
        if (repoChanged) atomicWrite(repoSettingsPath, json(nextRepo));
        const auditPath = path.join(stateDir, STORE_FILES["audit-event"]);
        atomicWrite(auditPath, auditSource);
        cacheParsedRecords(auditPath, auditSource, [...auditRecords, audit]);
        return { ok: true, changed: true, settings: { global: nextGlobal, repo: nextRepo }, auditEvent: audit.payload };
      });
    } catch (error) {
      return { ok: false, reason: reasonCode(error) };
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
      try { withMutationLock(() => quarantine(envelope, reasonCode(error))); } catch {}
      return { ok: false, reason: reasonCode(error) };
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
      writeFileSync(filePath, source, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      ownedLeases.set(leaseKey, nonce);
      return { ok: true, nonce, expiresAt: acquiredAt + ttlMs, ...(repairedCorruptLease ? { repairedCorruptLease: true } : {}) };
      });
    } catch (error) {
      return { ok: false, reason: "lease-acquire-error", code: String(error?.code ?? reasonCode(error)) };
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
      return { ok: false, reason: "lease-release-error", code: String(error?.code ?? reasonCode(error)) };
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

  function runCas(kind, id, expectedPriorState, mutateFn) {
    try {
      return withMutationLock(() => {
        const current = getRecordUnlocked(kind, id);
        if (!current) return { ok: false, reason: "record-not-found" };
        if (current.payload?.state !== expectedPriorState) return { ok: false, reason: "stale-prior-state" };
        const mutation = mutateFn(current.payload);
        const next = mutation?.schemaVersion && mutation?.kind ? assertRecord(mutation) : wrapRecord(kind, mutation, now());
        const result = appendValidUnlocked(next);
        if (!result.ok) return result;
        appendAuditUnlocked("decision", { action: "cas", priorState: String(expectedPriorState), newState: String(next.payload?.state ?? "") }, logicalId(current));
        if (kind === "proposal" && ["rejected", "rolled-back", "superseded", "failed-closed"].includes(next.payload.state)) compactProposalContentUnlocked(new Set([next.payload.id]));
        return { ok: true, newRecord: next };
      });
    } catch (error) { return { ok: false, reason: reasonCode(error) }; }
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
      const activeProposalIds = new Set([...latestProposals].filter(([, proposal]) => ACTIVE_PROPOSAL_STATES.has(proposal.state)).map(([id]) => id));

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
          const proposalId = record.kind === "proposal" ? record.payload.id : record.payload?.proposalId;
          if (proposalId && activeProposalIds.has(proposalId) && ["proposal", "proposal-content", "decision", "audit-event"].includes(record.kind)) return true;
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
      quarantine(readFileSync(filePath, "utf8"), reasonCode(error), path.join(path.dirname(filePath), "quarantine"));
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
    } catch (error) { return { ok: false, reason: reasonCode(error) }; }
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
    const result = { requests: [], responses: [], controlRequests: [], controlResponses: [], controlState: null };
    if (!existsSync(directory)) return result;
    safeTreeFiles(directory);
    const classes = [
      ["requests", "requests", "decision-request", "sensitive-decision-request-metadata", 8 * 1024],
      ["responses", "responses", "decision-response", "sensitive-decision-response-metadata", 4 * 1024],
      ["control-requests", "controlRequests", "control-request", "sensitive-control-request-metadata", 8 * 1024],
      ["control-responses", "controlResponses", "control-response", "sensitive-control-response-metadata", 4 * 1024],
    ];
    const fingerprint = path.basename(directory);
    for (const [directoryName, field, type, classification, maxBytes] of classes) {
      const child = path.join(directory, directoryName);
      if (!existsSync(child)) continue;
      for (const filePath of safeTreeFiles(child)) {
        if (!filePath.endsWith(".json")) continue;
        const relativePath = path.relative(child, filePath).split(path.sep).join("/");
        if (relativePath.includes("/")) throw new Error("export-bridge-path-rejected");
        const requestId = relativePath.slice(0, -".json".length);
        const read = secureExportRead(baseDir, filePath, maxBytes);
        const metadata = validateBridgeExportMetadata(type, JSON.parse(read.content.toString("utf8")), { projectFingerprint: fingerprint, requestId });
        result[field].push({
          classification,
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
    try {
      return withMutationLock(() => {
        recoverDecisionTransactionUnlocked();
        recoverTerminalProposalContentUnlocked();
        if (!new Set(["observations", "proposals", "project", "all"]).has(scope)) return { ok: false, reason: "invalid-scope" };
        const before = allRecords();
        let removed = [];
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
          if (contributed.size) compactAggregatesUnlocked((record) => !contributed.has(record.aggregateId));
          rmSync(stateDir, { recursive: true, force: true });
          rmSync(bridgeProjectDir, { recursive: true, force: true });
          parsedFileCache.clear();
          initializeDirs();
          getSettingsUnlocked();
        } else {
          removed = before;
          rmSync(baseDir, { recursive: true, force: true });
          ownedLeases.clear();
          parsedFileCache.clear();
          terminal = true;
          terminalRoots.add(root);
          return { ok: true, counts: countKinds(removed) };
        }
        const counts = countKinds(removed);
        appendAuditUnlocked("purge", { action: scope, removed: removed.length });
        return { ok: true, counts };
      });
    } catch (error) { return { ok: false, reason: reasonCode(error), counts: countKinds([]) }; }
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
    if (terminal || terminalRoots.has(root)) {
      ownedLeases.clear();
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
            else failures.push({ leaseKey, reason: "lease-release-error", code: String(error?.code ?? reasonCode(error)) });
          }
        }
      });
    } catch (error) {
      failures.push({ leaseKey: null, reason: "lease-release-error", code: String(error?.code ?? reasonCode(error)) });
    }
    if (failures.length) return { ok: false, released, failures };
    closed = true;
    return { ok: true, released };
  }

  withMutationLock(() => {
    initializeDirs();
    loadGlobalSettingsUnlocked();
    loadRepoSettingsUnlocked();
    for (const fileName of new Set(Object.values(STORE_FILES))) readFileRecords(fileName);
    recoverDecisionTransactionUnlocked();
    recoverTerminalProposalContentUnlocked();
    readAggregatesUnlocked();
  });

  return Object.freeze({
    getSettings,
    updateSettings,
    updateGlobalSettings,
    updateRepoSettings,
    setGlobalSettings: (settings) => setSettings("global", settings),
    setRepoSettings: (settings) => setSettings("repo", settings),
    appendRecord,
    readRecords,
    getRecord,
    acquireLease,
    releaseLease,
    isLeaseHeld,
    getLeaseStatus,
    cleanupExpiredLeases,
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
  });
}
